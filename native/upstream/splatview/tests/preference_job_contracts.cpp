#include "preference_job_contracts.hpp"
#include "preference_job.hpp"
#include "background_jobs.hpp"
#include "source_snapshot.hpp"
#include "software_renderer.hpp"
#include "editing.hpp"
#include "image_io.hpp"
#include "resource_budget.hpp"
#include "preference_lock.hpp"
#include <array>
#include <chrono>
#include <fstream>
#include <iterator>
#include <latch>
#include <stdexcept>
#include <thread>

namespace {
void require(bool condition,const char *message) { if(!condition) throw std::runtime_error(message); }
template<class F> void rejects(F action,const char *message) {
    try { action(); } catch(const std::exception &) { return; }
    throw std::runtime_error(message);
}
std::string readRecord(const std::filesystem::path &path) {
    std::ifstream stream(path,std::ios::binary);
    if(!stream) throw std::runtime_error("Preference record fixture is missing");
    return {std::istreambuf_iterator<char>(stream),std::istreambuf_iterator<char>()};
}
}
void preferenceJobContracts(const std::filesystem::path &directory) {
    using namespace preview;
    const auto root=directory/"preference-jobs";
    std::filesystem::create_directories(root);
    const auto source=root/"source.ply", records=root/"records";
    Scene original;
    for(unsigned i=0;i<5;++i) {
        Attributes a; a.position={float(i)*.08f-.16f,0,0}; a.scale={.06f,.05f,.04f}; a.opacity=.8f;
        a.sh[0]=.4f; a.sh[1]=-.1f; a.sh[2]=-.2f;
        original.gaussians.push_back(packGaussian(a));
    }
    original.sourceCount=original.gaussians.size(); fitBounds(original);
    writeVisiblePly(original,{},source);
    auto loaded=std::make_shared<Scene>(loadScene(source));
    const auto provenance=loaded->sourceContentKey;
    Camera camera; camera.fit(*loaded); camera.roll=.2f;
    const auto capturedCamera=camera.savedView();
    FilePreferences prefs(records);
    PreferenceSaveSnapshot view(source,*loaded,capturedCamera,records);
    camera.yaw+=.7f;
    // Worker data is independent of mutable owner metadata and global storage.
    loaded->sourceContentKey="changed-owner-metadata";
    const auto completion=view.run();
    require(completion.source==source && completion.camera==capturedCamera && !completion.thumbnail,
            "Preference job returns the captured source and camera");
    require(prefs.view(source,provenance)==capturedCamera,"Camera job owns copied provenance and camera");
    loaded=std::make_shared<Scene>(loadScene(source));
    std::weak_ptr<const Scene> lifetime=loaded;
    PreferenceSaveSnapshot independent(source,*loaded,capturedCamera,records);
    loaded.reset();
    require(lifetime.expired(),"Camera-only job does not retain loaded scene arrays");
    BackgroundExecutor executor(1,4);
    std::latch entered(1),release(1);
    auto blocker=executor.submit([&](std::stop_token){ entered.count_down(); release.wait(); });
    entered.wait();
    auto queued=executor.submit([job=std::move(independent)](std::stop_token stop){ return job.run(stop); });
    release.count_down(); blocker.get();
    require(!queued.get().thumbnail,"Preference save runs from worker-owned state after owner release");
    loaded=std::make_shared<Scene>(loadScene(source));
    ViewSettings settings; settings.highlightSelection=true; settings.colorPreviewCoverage=true;
    settings.selection.shape=1; settings.selection.limits[0]=5;
    std::vector<uint8_t> states(loaded->gaussians.size(),1);
    FrameCaptureSnapshot frame(loaded,states,camera,settings,65,65,65*65);
    PreferenceSaveSnapshot thumb(source,*loaded,capturedCamera,records,frame);
    const auto bytesBefore=std::filesystem::file_size(source);
    const auto timeBefore=std::filesystem::last_write_time(source);
    require(thumb.run().thumbnail,"Thumbnail job renders and commits its captured frame");
    const auto saved=prefs.thumbnail(source,provenance);
    require(saved.has_value(),"Thumbnail manifest resolves a complete image");
    require(saved->bgra==squareThumbnail(frame.run()).bgra,"Saved thumbnail matches the clean immutable capture");
    require(std::filesystem::file_size(source)==bytesBefore && std::filesystem::last_write_time(source)==timeBefore,
            "Preference job preserves source bytes and modification time");
    const auto sourceBeforeAdmitted=sourceStamp(source);
    ResourceBudget captureBudget(16*1024*1024);
    {
        FrameCaptureSnapshot admittedFrame(loaded,states,camera,settings,65,65,65*65,captureBudget);
        const auto retained=captureBudget.usage().totalBytes;
        require(retained==scenePayloadBytes(*loaded)+states.size(),
                "Admitted preference capture retains its scene and copied edit mask");
        PreferenceSaveSnapshot admittedJob(source,*loaded,capturedCamera,records,admittedFrame,captureBudget);
        require(captureBudget.usage().totalBytes==retained,
                "Preference snapshot copies share the retained frame allocation grants");
        require(admittedJob.run().thumbnail,"Budgeted preference job executes the admitted thumbnail branch");
        const auto after=captureBudget.usage();
        require(after.totalBytes==retained &&
                    after.categoryBytes[std::size_t(ResourceCategory::Image)]==0 &&
                    after.categoryBytes[std::size_t(ResourceCategory::Render)]==0 &&
                    after.peakBytes>=retained+imagePayloadBytes(65,65,2),
                "Preference commit retains capture input but releases run scratch and returned image grants");
        const auto admittedSaved=prefs.thumbnail(source,provenance);
        require(admittedSaved && admittedSaved->bgra==saved->bgra,
                "Budgeted thumbnail matches the same clean capture pixels");
        std::stop_source cancelledAdmission; cancelledAdmission.request_stop();
        rejects([&]{admittedJob.run(cancelledAdmission.get_token());},
                "Precancelled budgeted preference work must reject before rendering");
        require(captureBudget.usage().totalBytes==retained,
                "Cancelled preference run must not leak temporary capture grants");
    }
    const auto released=captureBudget.usage();
    require(released.totalBytes==0,"Preference snapshot destruction releases all retained capture grants");
    for(const auto bytes:released.categoryBytes)
        require(bytes==0,"Preference snapshot destruction clears every resource category");
    {
        ResourceBudget insufficient(scenePayloadBytes(*loaded)+states.size());
        FrameCaptureSnapshot limited(loaded,states,camera,settings,65,65,65*65,insufficient);
        const auto retained=insufficient.usage().totalBytes;
        PreferenceSaveSnapshot rejected(source,*loaded,capturedCamera,records,limited);
        try { rejected.run(); throw std::logic_error("Unadmitted preference capture unexpectedly ran"); }
        catch(const ResourceBudgetExceeded &) {}
        require(insufficient.usage().totalBytes==retained && prefs.thumbnail(source,provenance)->bgra==saved->bgra,
                "Rejected render admission retains only snapshot storage and preserves the previous thumbnail");
    }
    require(sourceStamp(source)==sourceBeforeAdmitted && std::filesystem::last_write_time(source)==timeBefore,
            "Admitted, cancelled and rejected preference jobs preserve the source and modification time");
    // A source-category denial occurs before FileSnapshot allocates its byte
    // array. Both the authoritative record and existing thumbnail survive.
    const auto keyInput=loaded->sourceFileIdentity+"\n"+provenance;
    const auto stem=contentKey({reinterpret_cast<const uint8_t *>(keyInput.data()),keyInput.size()});
    const auto record=records/(stem+".json");
    const auto recordBefore=readRecord(record);
    const auto sourceBytes=std::size_t(sourceBeforeAdmitted.bytes);
    auto rejectedCamera=capturedCamera; rejectedCamera.yaw+=.4f;
    {
        ResourceLimits limits; limits.totalBytes=16*1024*1024;
        limits.categoryBytes[std::size_t(ResourceCategory::Source)]=sourceBytes-1;
        ResourceBudget limited(limits);
        PreferenceSaveSnapshot sourceLimited(source,*loaded,rejectedCamera,records,{},limited);
        try { sourceLimited.run(); throw std::logic_error("Unadmitted first fingerprint unexpectedly ran"); }
        catch(const ResourceBudgetExceeded &error) {
            require(error.requestedBytes()==sourceBytes && error.availableBytes()==sourceBytes-1,
                    "First preference fingerprint reports the exact source allocation denial");
        }
        require(limited.usage().totalBytes==0 && limited.usage().peakBytes==0 && readRecord(record)==recordBefore,
                "First source admission failure allocates no byte array and preserves the prior record");
        std::stop_source cancelledSource; cancelledSource.request_stop();
        rejects([&]{sourceLimited.run(cancelledSource.get_token());},
                "Precancelled budgeted preference save rejects before fingerprint admission");
        require(limited.usage().peakBytes==0,"Precancelled source save makes no admission attempt");
        // The direct compatibility API must forward the ledger as well.
        try { prefs.save(source,*loaded,rejectedCamera,nullptr,{},limited);
              throw std::logic_error("Direct save ignored its source budget"); }
        catch(const ResourceBudgetExceeded &) {}
        require(readRecord(record)==recordBefore,"Direct source denial preserves the prior manifest");
        try { saveDefaultView(source,rejectedCamera,{},provenance,limited);
              throw std::logic_error("Default-view convenience save ignored its source budget"); }
        catch(const ResourceBudgetExceeded &) {}
        require(limited.usage().peakBytes==0,"Convenience save rejects before its initial source allocation");
        {
            FrameCaptureSnapshot admittedFrame(loaded,states,camera,settings,65,65,65*65,limited);
            const auto retained=limited.usage().totalBytes;
            PreferenceSaveSnapshot sourceAfterRender(source,*loaded,rejectedCamera,records,admittedFrame,limited);
            try { sourceAfterRender.run(); throw std::logic_error("Rendered preference save ignored source admission"); }
            catch(const ResourceBudgetExceeded &error) {
                require(error.requestedBytes()==sourceBytes && error.availableBytes()==sourceBytes-1,
                        "Rendered preference save rejects its first source allocation at the category limit");
            }
            const auto usage=limited.usage();
            require(usage.totalBytes==retained &&
                        usage.categoryBytes[std::size_t(ResourceCategory::Image)]==0 &&
                        usage.categoryBytes[std::size_t(ResourceCategory::Source)]==0 && readRecord(record)==recordBefore,
                    "Source denial after render releases returned pixels and leaves the previous record intact");
        }
        require(limited.usage().totalBytes==0,"Rejected thumbnail save releases its final retained capture grants");
    }
    {
        ResourceBudget limited(sourceBytes);
        PreferenceSaveSnapshot secondLimited(source,*loaded,rejectedCamera,records,{},limited);
        // The real writer lock provides a deterministic boundary after the
        // first fingerprint has released its array, before the second starts.
        auto lock=std::make_unique<PreferenceLock>(records/(stem+".lock"));
        auto saving=executor.submit([job=secondLimited](std::stop_token token){return job.run(token);});
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
        for(;;) {
            const auto usage=limited.usage();
            if(usage.peakBytes==sourceBytes && usage.totalBytes==0) break;
            require(saving.wait_for(std::chrono::milliseconds(0))!=std::future_status::ready,
                    "Preference save must wait at the held writer lock");
            require(std::chrono::steady_clock::now()<deadline,
                    "Preference save did not reach the first-fingerprint boundary");
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        require(saving.wait_for(std::chrono::milliseconds(0))!=std::future_status::ready,
                "First fingerprint completed while the preference writer remains blocked");
        auto competing=limited.reserve(ResourceCategory::Source,sourceBytes);
        lock.reset();
        try { saving.get(); throw std::logic_error("Unadmitted second fingerprint unexpectedly committed"); }
        catch(const ResourceBudgetExceeded &error) {
            require(error.requestedBytes()==sourceBytes && error.availableBytes()==0,
                    "Second fingerprint observes the same source ledger after waiting for the lock");
        }
        require(limited.usage().totalBytes==sourceBytes && readRecord(record)==recordBefore,
                "Second fingerprint denial retains only the competing grant and preserves the manifest");
        competing.release();
        require(limited.usage().totalBytes==0,"Second fingerprint failure releases all job source grants");
    }
    // Camera-only snapshot copies own the ledger handle without retaining the
    // decoded payload or depending on the original budget object's lifetime.
    {
        std::optional<PreferenceSaveSnapshot> surviving;
        std::weak_ptr<const Scene> releasedScene;
        {
            ResourceBudget local(sourceBytes);
            auto temporary=std::make_shared<Scene>(loadScene(source));
            releasedScene=temporary;
            PreferenceSaveSnapshot originalJob(source,*temporary,capturedCamera,records,{},local);
            surviving=originalJob;
        }
        require(releasedScene.expired(),"Budgeted camera job copies retain no Gaussian payload");
        auto copied=*surviving;
        surviving.reset();
        require(!copied.run().thumbnail,"Copied preference snapshot owns the ledger after host handle destruction");
    }
    // A larger single-file fingerprint dominates the render peak. This proves
    // that the returned image grant stays live during BOTH source captures,
    // rather than merely proving separate render and source admissions.
    {
        const auto largeSource=root/"large-source.ply", largeRecords=root/"large-records";
        std::filesystem::copy_file(source,largeSource,std::filesystem::copy_options::overwrite_existing);
        {
            std::ofstream output(largeSource,std::ios::binary|std::ios::app);
            const std::array<char,4096> padding{};
            for(unsigned i=0;i<128;++i) output.write(padding.data(),padding.size());
            require(bool(output),"Large source fingerprint fixture writes completely");
        }
        const auto stamp=sourceStamp(largeSource);
        const auto largeTime=std::filesystem::last_write_time(largeSource);
        Scene metadata;
        metadata.sourceContentKey=stamp.contentKey; metadata.sourceFileIdentity=stamp.identity;
        metadata.sourceBytes=stamp.bytes;
        ResourceBudget overlap(16*1024*1024);
        {
            FrameCaptureSnapshot admittedFrame(loaded,states,camera,settings,65,65,65*65,overlap);
            const auto retained=overlap.usage().totalBytes;
            PreferenceSaveSnapshot job(largeSource,metadata,capturedCamera,largeRecords,admittedFrame,overlap);
            auto copied=job;
            require(copied.run().thumbnail,"Copied budgeted save renders and fingerprints its own immutable source");
            const auto usage=overlap.usage();
            require(usage.peakBytes==retained+imagePayloadBytes(65,65)+std::size_t(stamp.bytes),
                    "Source fingerprint admission overlaps the live returned-image grant");
            require(usage.totalBytes==retained &&
                        usage.categoryBytes[std::size_t(ResourceCategory::Source)]==0 &&
                        usage.categoryBytes[std::size_t(ResourceCategory::Image)]==0,
                    "Preference save releases source arrays and returned pixels after commit");
            require(FilePreferences(largeRecords).view(largeSource,stamp.contentKey)==capturedCamera,
                    "Budgeted source and image save commits the captured camera");
        }
        require(overlap.usage().totalBytes==0,"Last copied preference snapshot releases all retained grants");
        require(sourceStamp(largeSource)==stamp && std::filesystem::last_write_time(largeSource)==largeTime,
                "Overlapping source and image admission preserves source bytes and modification time");
    }
    require(sourceStamp(source)==sourceBeforeAdmitted && std::filesystem::last_write_time(source)==timeBefore &&
                readRecord(record)==recordBefore && prefs.thumbnail(source,provenance)->bgra==saved->bgra,
            "Source admission failures and camera-only lifetime saves preserve source and prior thumbnail");
    const auto previous=prefs.view(source,provenance);
    auto cancelledCamera=capturedCamera; cancelledCamera.yaw+=.3f;
    PreferenceSaveSnapshot cancelled(source,*loaded,cancelledCamera,records,frame);
    std::stop_source stop; stop.request_stop();
    rejects([&]{cancelled.run(stop.get_token());},"Precancelled preference job must reject");
    require(prefs.view(source,provenance)==previous && prefs.thumbnail(source,provenance)->bgra==saved->bgra,
            "Cancellation preserves the prior preference manifest and thumbnail");
    auto stamp=sourceStamp(source);
    { std::ofstream stream(source,std::ios::binary|std::ios::app); stream << "source changed"; }
    rejects([&]{cancelled.run();},"Changed source rejects captured preference save");
    require(prefs.view(source,provenance)==previous,"Source drift leaves the previous record intact");
    require(sourceStamp(source)!=stamp,"Source drift fixture actually changes the source fingerprint");
    auto invalid=capturedCamera; invalid.distance=0;
    rejects([&]{PreferenceSaveSnapshot bad(source,*loaded,invalid,records);},"Invalid camera rejects before worker admission");
    Scene unknown;
    rejects([&]{PreferenceSaveSnapshot bad(source,unknown,capturedCamera,records);},"Unverified provenance rejects before admission");
}
