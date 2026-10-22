#include "preview_coordinator_contracts.hpp"
#include "preview_coordinator.hpp"
#include "document.hpp"
#include "frame_capture.hpp"
#include "software_renderer.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <latch>
#include <limits>
#include <mutex>
#include <semaphore>
#include <stdexcept>
#include <thread>
#include <vector>

using namespace preview;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class F> void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const std::exception &) { return; }
    throw std::runtime_error(message);
}
struct Gate {
    std::latch latch{1};
    std::atomic<bool> opened{};
    void wait() { latch.wait(); }
    void open() { if (!opened.exchange(true)) latch.count_down(); }
};
struct OpenOnExit { Gate &gate; ~OpenOnExit() { gate.open(); } };
template<class Predicate> void eventually(Predicate &&predicate, const char *message) {
    const auto deadline=std::chrono::steady_clock::now()+5s;
    while (!predicate()) {
        require(std::chrono::steady_clock::now()<deadline,message);
        std::this_thread::yield();
    }
}
std::shared_ptr<const Scene> fixture(std::shared_ptr<SceneMemory> memory={}) {
    auto scene=std::make_shared<Scene>(memory);
    for (unsigned i=0;i<3;++i) {
        Attributes value;
        value.position={float(i)*.35f-.35f,0,-float(i)*.04f};
        value.scale={.12f,.09f,.08f}; value.opacity=.8f;
        value.sh[0]=.3f; value.sh[1]=-.4f; value.sh[2]=.5f;
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount=scene->gaussians.size(); fitBounds(*scene);
    return scene;
}
PreviewKey key(uint64_t edit=1) {
    PreviewKey value;
    value.owner=17; value.sourceGeneration=2; value.editRevision=edit;
    value.camera.target={0,0,0}; value.camera.yaw=0; value.camera.pitch=0;
    value.camera.distance=3; value.camera.radius=1; value.camera.yUp=true;
    value.width=48; value.height=40; value.backend=PreviewBackend::Software;
    return value;
}
LivePreviewSnapshot snapshot(const PreviewKey &value) {
    return LivePreviewSnapshot(value,fixture(),MaskStorage{});
}
PreviewCompletion completion(const PreviewReceipt &receipt, PreviewTerminal terminal, const PreviewKey &value) {
    require(receipt.completion.valid() && receipt.completion.wait_for(0s)==std::future_status::ready,
            "Preview receipt must have a terminal outcome at its documented boundary");
    const auto result=receipt.completion.get();
    require(result.request==receipt.request && result.key==value && result.terminal==terminal,
            "Preview completion must preserve exact request, key and terminal identity");
    // A shared receipt is stable and may be observed repeatedly.
    require(receipt.completion.get().request==result.request && receipt.completion.get().terminal==terminal,
            "Preview terminal delivery must remain exactly once and stable");
    return result;
}
void drain(PreviewCoordinator &coordinator,const PreviewCoordinator::Capture &capture) {
    eventually([&] { coordinator.pump(capture); return !coordinator.busy(); },
               "Preview coordinator must drain admitted work without another request");
}
bool same(const Image &a,const Image &b) {
    return a.width==b.width && a.height==b.height && a.bgra==b.bgra;
}
struct Reentry {
    std::atomic<bool> armed{true},fired{};
    std::function<void()> action;
    std::exception_ptr failure;
};
struct DisarmOnExit {
    std::shared_ptr<Reentry> state;
    ~DisarmOnExit() { state->armed=false; }
};
std::shared_ptr<const Scene> reentrantScene(const std::shared_ptr<Reentry> &state) {
    return std::shared_ptr<const Scene>(new Scene(*fixture()),[state](const Scene *scene) noexcept {
        delete scene;
        if (!state->armed || state->fired.exchange(true)) return;
        // Scene deleters are noexcept; expose a failed reentry through the
        // owner-thread test after destruction has completed, never by throwing.
        try { state->action(); }
        catch (...) { state->failure=std::current_exception(); }
    });
}
void latestOnly(bool oldThrows) {
    Gate finish;
    std::binary_semaphore entered{0};
    std::atomic<unsigned> runs{};
    std::atomic<bool> stopped{};
    BackgroundExecutor executor(1,2);
    OpenOnExit release{finish};
    PreviewCoordinator coordinator(executor,[&](LivePreviewSnapshot input,std::stop_token stop) {
        ++runs;
        if (input.key().editRevision==1) {
            entered.release(); finish.wait();
            stopped=stop.stop_requested();
            if (oldThrows) throw std::runtime_error("obsolete worker detail");
            // Deliberately ignore stop after the gate, representing a stage
            // that returned successfully after a cancellation request.
        }
        return input.run();
    });
    unsigned captures{};
    const auto owner=std::this_thread::get_id();
    const PreviewCoordinator::Capture capture=[&](const PreviewKey &value) {
        require(std::this_thread::get_id()==owner,"Preview capture must remain on the owner thread");
        ++captures; return snapshot(value);
    };
    const auto a=key(1),b=key(2),c=key(3);
    auto first=coordinator.request(a); coordinator.pump(capture);
    require(entered.try_acquire_for(5s),"First preview must enter its controlled worker stage");
    auto middle=coordinator.request(b);
    completion(first,PreviewTerminal::Superseded,a);
    coordinator.pump(capture);
    require(captures==1,"A busy coordinator must retain only a lightweight pending description");
    auto last=coordinator.request(c);
    completion(middle,PreviewTerminal::Superseded,b);
    auto duplicate=coordinator.request(c);
    require(duplicate.request==last.request,"An identical pending key must reuse its receipt");
    require(!coordinator.takeFrame() && !coordinator.accepts(first.request,a),
            "A superseded active preview cannot be presented before its worker exits");
    finish.open(); drain(coordinator,capture);
    completion(first,PreviewTerminal::Superseded,a);
    completion(last,PreviewTerminal::Presented,c);
    require(captures==2 && runs==2 && stopped,
            "A burst A/B/C must stop A, skip B and execute only the latest pending C");
    auto presented=coordinator.takeFrame();
    require(presented && presented->request==last.request && presented->result.key()==c &&
            coordinator.accepts(last.request,c) && !coordinator.accepts(last.request,b),
            "Only the latest request and complete matching key may reach presentation");
    require(!coordinator.takeFrame(),"A presented frame may be taken only once");
    require(coordinator.request(c).request==last.request,"A presented identical key must not restart rendering");
    coordinator.pump(capture);
    require(captures==2 && !coordinator.busy(),"An unchanged settled view must remain idle");
}
void failureAndRetry() {
    BackgroundExecutor executor(1,2);
    std::atomic<unsigned> runs{};
    PreviewCoordinator coordinator(executor,[&](LivePreviewSnapshot input,std::stop_token stop) {
        if (++runs==1) throw std::runtime_error("retained worker detail");
        return input.run(stop);
    });
    unsigned captures{};
    const PreviewCoordinator::Capture capture=[&](const PreviewKey &value) { ++captures; return snapshot(value); };
    const auto value=key(); auto failed=coordinator.request(value); drain(coordinator,capture);
    require(completion(failed,PreviewTerminal::Failed,value).error=="retained worker detail" && !coordinator.takeFrame(),
            "A current worker failure must deliver its detail without a frame");
    require(coordinator.request(value).request==failed.request,"An identical failed key must reuse its receipt");
    coordinator.pump(capture);
    require(captures==1 && runs==1,"Repeated draws must not automatically retry a failed key");
    auto retried=coordinator.request(value,true); drain(coordinator,capture);
    completion(retried,PreviewTerminal::Presented,value);
    require(retried.request>failed.request && captures==2 && runs==2 && coordinator.takeFrame(),
            "Explicit retry must allocate a new request and leave the coordinator reusable");

    auto rejected=coordinator.request(key(2));
    coordinator.pump([](const PreviewKey &) -> LivePreviewSnapshot { throw std::runtime_error("capture detail"); });
    require(completion(rejected,PreviewTerminal::Rejected,key(2)).error=="capture detail" && !coordinator.busy(),
            "Owner-thread capture failure must reject synchronously and retain a reusable controller");
    auto repaired=coordinator.request(key(2),true); drain(coordinator,capture);
    completion(repaired,PreviewTerminal::Presented,key(2));
}
void captureReentryAndIdentity() {
    BackgroundExecutor executor(1,2);
    std::atomic<unsigned> runs{};
    PreviewCoordinator coordinator(executor,[&](LivePreviewSnapshot input,std::stop_token stop) {
        ++runs; return input.run(stop);
    });
    const auto a=key(1),b=key(2);
    auto first=coordinator.request(a); PreviewReceipt replacement;
    coordinator.pump([&](const PreviewKey &value) {
        replacement=coordinator.request(b); return snapshot(value);
    });
    completion(first,PreviewTerminal::Superseded,a);
    require(runs==0 && coordinator.busy(),"Capture reentry must not submit the superseded input");
    drain(coordinator,snapshot); completion(replacement,PreviewTerminal::Presented,b);
    coordinator.takeFrame();
    auto cancelled=coordinator.request(a);
    coordinator.pump([&](const PreviewKey &value) { coordinator.cancel(); return snapshot(value); });
    completion(cancelled,PreviewTerminal::Cancelled,a);
    require(!coordinator.busy() && runs==1 && !coordinator.takeFrame(),
            "Cancellation during capture must release that input without submitting it");

    auto wrongCapture=coordinator.request(a);
    coordinator.pump([&](const PreviewKey &) { return snapshot(b); });
    require(!completion(wrongCapture,PreviewTerminal::Rejected,a).error.empty() && runs==1,
            "A capture carrying another key must be rejected before execution");
    PreviewCoordinator wrongWorker(executor,[&](LivePreviewSnapshot,std::stop_token) { return snapshot(b).run(); });
    auto wrongResult=wrongWorker.request(a); drain(wrongWorker,snapshot);
    require(!completion(wrongResult,PreviewTerminal::Failed,a).error.empty() && !wrongWorker.takeFrame(),
            "A worker result carrying another key must never reach presentation");
}
void queuedReleaseAndRejection() {
    Gate finish;
    std::binary_semaphore entered{0};
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token) { entered.release(); finish.wait(); });
    require(entered.try_acquire_for(5s),"Queued-input fixture must occupy its executor worker");
    std::weak_ptr<const Scene> retained;
    unsigned captures{};
    const PreviewCoordinator::Capture capture=[&](const PreviewKey &value) {
        ++captures; auto scene=fixture(); retained=scene;
        return LivePreviewSnapshot(value,std::move(scene),MaskStorage{});
    };
    PreviewReceipt queuedReceipt;
    {
        PreviewCoordinator coordinator(executor);
        queuedReceipt=coordinator.request(key(1)); coordinator.pump(capture);
        require(!retained.expired(),"An admitted queued preview must retain its immutable source");
        auto pending=coordinator.request(key(2));
        completion(queuedReceipt,PreviewTerminal::Superseded,key(1));
        require(retained.expired() && captures==1,
                "Superseding queued work must free its input while the executor still holds its closure");
        coordinator.cancel(); completion(pending,PreviewTerminal::Cancelled,key(2));
        drain(coordinator,capture);
    }
    completion(queuedReceipt,PreviewTerminal::Superseded,key(1));
    // Purge the cancelled closure, then deliberately occupy the one queue slot.
    auto occupying=executor.submit([](std::stop_token) { return 1; });
    PreviewCoordinator rejected(executor);
    auto denied=rejected.request(key(3)); rejected.pump(capture);
    require(!completion(denied,PreviewTerminal::Rejected,key(3)).error.empty() && retained.expired() && !rejected.busy(),
            "Queue rejection must immediately release captured inputs and settle admission");
    const auto before=captures;
    require(rejected.request(key(3)).request==denied.request,"A queue rejection must also reuse an identical failed key");
    rejected.pump(capture); require(captures==before,"Queue rejection needs an explicit retry");
    finish.open(); blocker.get(); require(occupying.get()==1,"Other admitted work survives preview rejection");
    auto retry=rejected.request(key(3),true); drain(rejected,capture);
    completion(retry,PreviewTerminal::Presented,key(3));
}
void queuedDestructorReentry() {
    Gate finish;
    std::binary_semaphore entered{0};
    auto reentry=std::make_shared<Reentry>();
    BackgroundExecutor executor(1,2);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token) { entered.release(); finish.wait(); });
    require(entered.try_acquire_for(5s),"Destructor-reentry fixture must hold its only worker");
    std::atomic<unsigned> runs{};
    PreviewCoordinator coordinator(executor,[&](LivePreviewSnapshot input,std::stop_token stop) {
        ++runs; return input.run(stop);
    });
    DisarmOnExit disarm{reentry};
    const auto a=key(1),b=key(2),c=key(3);
    const auto owner=std::this_thread::get_id();
    PreviewReceipt newest;
    unsigned captures{};
    std::weak_ptr<const Scene> oldScene;
    const PreviewCoordinator::Capture capture=[&](const PreviewKey &value) {
        ++captures;
        if (value==a) {
            auto scene=reentrantScene(reentry); oldScene=scene;
            return LivePreviewSnapshot(value,std::move(scene),MaskStorage{});
        }
        return snapshot(value);
    };
    reentry->action=[&] {
        require(std::this_thread::get_id()==owner,"Queued source destruction must release on its cancelling owner thread");
        newest=coordinator.request(c); coordinator.pump(capture);
    };
    auto first=coordinator.request(a); coordinator.pump(capture);
    require(!oldScene.expired() && runs==0,"Queued A must retain its source without entering the renderer");
    auto middle=coordinator.request(b); // A's deleter requests and launches C.
    if (reentry->failure) std::rethrow_exception(reentry->failure);
    require(reentry->fired && oldScene.expired() && captures==2 && runs==0,
            "Queued source release must permit one guarded reentry and capture C without executing A or B");
    completion(first,PreviewTerminal::Superseded,a);
    completion(middle,PreviewTerminal::Superseded,b);
    require(newest.completion.valid() && newest.completion.wait_for(0s)!=std::future_status::ready,
            "The outer cancellation must not stop C launched by the released source's deleter");
    finish.open(); blocker.get(); drain(coordinator,capture);
    completion(newest,PreviewTerminal::Presented,c);
    auto frame=coordinator.takeFrame();
    require(runs==1 && captures==2 && frame && frame->request==newest.request && frame->result.key()==c,
            "Only reentrant C may render and present after releasing the worker gate");
}
void readyDestructorReentry() {
    auto reentry=std::make_shared<Reentry>();
    BackgroundExecutor executor(1,2);
    std::atomic<unsigned> runs{};
    PreviewCoordinator coordinator(executor,[&](LivePreviewSnapshot input,std::stop_token stop) {
        ++runs; return input.run(stop);
    });
    DisarmOnExit disarm{reentry};
    const auto a=key(1),b=key(2),c=key(3);
    const auto owner=std::this_thread::get_id();
    PreviewReceipt newest;
    unsigned captures{};
    std::weak_ptr<const Scene> oldScene;
    const PreviewCoordinator::Capture capture=[&](const PreviewKey &value) {
        ++captures;
        if (value==a) {
            auto scene=reentrantScene(reentry); oldScene=scene;
            return LivePreviewSnapshot(value,std::move(scene),MaskStorage{});
        }
        return snapshot(value);
    };
    reentry->action=[&] {
        require(std::this_thread::get_id()==owner,"Ready result destruction must run on the replacing owner thread");
        newest=coordinator.request(c); coordinator.pump(capture);
    };
    auto first=coordinator.request(a); drain(coordinator,capture);
    completion(first,PreviewTerminal::Presented,a);
    require(!oldScene.expired() && !reentry->fired && coordinator.accepts(first.request,a),
            "An unconsumed ready software result must retain A's source until replacement");
    // Do not take A's frame: replacing ready_ must release the last source
    // owner only after B's transition is committed, allowing C to supersede B.
    auto middle=coordinator.request(b);
    if (reentry->failure) std::rethrow_exception(reentry->failure);
    require(reentry->fired && oldScene.expired() && captures==2,
            "Replacing unconsumed A must run its deleter once and capture the reentrant C");
    completion(middle,PreviewTerminal::Superseded,b);
    drain(coordinator,capture); completion(newest,PreviewTerminal::Presented,c);
    completion(first,PreviewTerminal::Presented,a);
    auto frame=coordinator.takeFrame();
    require(runs==2 && captures==2 && frame && frame->request==newest.request && frame->result.key()==c &&
            !coordinator.accepts(middle.request,b),
            "The outer ready-result replacement cannot overwrite reentrant C or leave B/C receipts unsettled");
}
void destructionDoesNotJoin() {
    Gate finish;
    std::binary_semaphore entered{0},destroyOwner{0},destroyed{0};
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    std::weak_ptr<const Scene> retained;
    PreviewReceipt receipt;
    std::exception_ptr ownerFailure;
    std::atomic<bool> stopped{};
    std::jthread owner([&] {
        try {
            auto coordinator=std::make_unique<PreviewCoordinator>(executor,
                [&](LivePreviewSnapshot input,std::stop_token stop) {
                    entered.release(); finish.wait();
                    stopped=stop.stop_requested();
                    return input.run();
                });
            receipt=coordinator->request(key());
            coordinator->pump([&](const PreviewKey &value) {
                auto scene=fixture(); retained=scene;
                return LivePreviewSnapshot(value,std::move(scene),MaskStorage{});
            });
            destroyOwner.acquire(); coordinator.reset(); destroyed.release();
        } catch (...) { ownerFailure=std::current_exception(); destroyed.release(); }
    });
    struct Cleanup {
        Gate &gate;
        std::binary_semaphore &owner;
        ~Cleanup() { gate.open(); owner.release(); }
    } cleanup{finish,destroyOwner};
    require(entered.try_acquire_for(5s),"Owner destruction fixture must start active rendering");
    destroyOwner.release();
    const bool nonblocking=destroyed.try_acquire_for(5s);
    // Release even a broken joining implementation before reporting its error.
    finish.open(); owner.join();
    if (ownerFailure) std::rethrow_exception(ownerFailure);
    require(nonblocking,"Destroying a preview owner must not join the active callable");
    completion(receipt,PreviewTerminal::Cancelled,key());
    executor.submit([](std::stop_token) {}).get();
    require(stopped && retained.expired(),
            "Owner destruction must stop the detached worker and release inputs when invocation actually ends");
}
void completeKey() {
    const auto base=key();
    const auto changes=std::vector<std::function<void(PreviewKey &)>>{
        [](auto &v){++v.owner;},[](auto &v){++v.sourceGeneration;},[](auto &v){++v.editRevision;},
        [](auto &v){++v.draftRevision;},[](auto &v){v.camera.target.x+=.1f;},
        [](auto &v){v.camera.target.y+=.1f;},[](auto &v){v.camera.target.z+=.1f;},
        [](auto &v){v.camera.yaw+=.1f;},[](auto &v){v.camera.pitch+=.1f;},
        [](auto &v){v.camera.distance+=.1f;},[](auto &v){v.camera.radius+=.1f;},
        [](auto &v){v.camera.fieldOfView+=1;},[](auto &v){v.camera.roll+=.1f;},
        [](auto &v){v.camera.yUp=!v.camera.yUp;},[](auto &v){++v.width;},[](auto &v){++v.height;},
        [](auto &v){v.backend=PreviewBackend::Metal;},
        [](auto &v){v.settings.highlightSelection=!v.settings.highlightSelection;},
        [](auto &v){v.settings.colorPreviewCoverage=!v.settings.colorPreviewCoverage;},
        [](auto &v){v.settings.colorSelectedOnly=!v.settings.colorSelectedOnly;},
        [](auto &v){v.settings.geometrySelectedOnly=!v.settings.geometrySelectedOnly;},
        [](auto &v){v.settings.geometry[12]=.2f;},[](auto &v){v.settings.selection.shape=1;},
        [](auto &v){v.settings.selection.operation=1;},[](auto &v){v.settings.selection.limits[0]=2;},
        [](auto &v){v.settings.selection.worldToLocal[13]=.1f;}
    };
    require(base==base,"A validated preview key must equal itself");
    for (const auto &change:changes) {
        auto changed=base; change(changed);
        require(!(base==changed) && !(changed==base),"Every render input identity field must invalidate a preview key");
    }
    for (size_t i=0;i<base.settings.color.size();++i) {
        auto changed=base; changed.settings.color[i]+=.1f;
        require(!(base==changed),"Every absolute color field must participate in preview identity");
    }
    for (size_t i=0;i<base.settings.geometry.size();++i) {
        auto changed=base; changed.settings.geometry[i]+=.1f;
        require(!(base==changed),"Every geometry preview component must participate in preview identity");
        changed=base; changed.settings.selection.worldToLocal[i]+=.1f;
        require(!(base==changed),"Every selection preview transform component must participate in preview identity");
    }
    for (size_t i=0;i<base.settings.selection.limits.size();++i) {
        auto changed=base; changed.settings.selection.limits[i]+=.1f;
        require(!(base==changed),"Every selection preview limit must participate in preview identity");
    }
}
void liveVersusClean() {
    Document document; document.replace("preview-fixture.ply",fixture());
    document.edits()->selectSingle(1,SelectOperation::Set);
    document.camera=key().camera;
    auto values=neutralColor; values[0]=.65f;
    document.previewColor(values,true);
    const auto fixed=document.renderScene();
    const auto capture=[&] {
        auto value=key(); value.owner=document.savePoint().documentIdentity;
        value.sourceGeneration=document.generation(); value.editRevision=document.revision();
        value.draftRevision=document.draftRevision(); value.camera=document.camera;
        value.settings=document.previewSettings();
        return LivePreviewSnapshot(value,document.renderScene(),document.maskSnapshot());
    };
    auto before=capture(); auto live=before.run();
    SoftwareRenderer renderer; renderer.setScene(fixed); renderer.setStates(document.renderStates());
    renderer.resize(before.key().width,before.key().height); renderer.draw(before.key().camera,before.key().settings);
    require(same(live.image(),renderer.readback()),"Live preview must preserve the exact renderer settings and selection highlight");
    FrameCaptureSnapshot clean(fixed,document.renderStates(),document.camera,before.key().settings,
                               before.key().width,before.key().height,48*40);
    require(!same(live.image(),clean.run()),"Live selection highlighting must remain distinct from a clean explicit capture");
    document.flushColor();
    require(document.renderScene()==fixed && document.scene()!=fixed,
            "An accepted absolute color session must retain its original render base");
    auto after=capture().run();
    require(same(live.image(),after.image()),"Absolute color preview must be applied once before and after its commit");
    document.endColorSession();
    require(same(live.image(),capture().run().image()),"Ending a color session must switch to equivalent baked pixels");
    document.edits()->selectSingle(0,SelectOperation::Set); document.camera.yaw+=.3f;
    require(same(before.run().image(),live.image()),"Later mask and camera edits cannot mutate an immutable live snapshot");

    auto overlayKey=before.key(); overlayKey.settings.highlightSelection=true;
    overlayKey.settings.colorSelectedOnly=false;
    overlayKey.settings.colorPreviewCoverage=true; overlayKey.settings.selection.shape=2;
    overlayKey.settings.selection.limits={100,100,100,0};
    auto overlay=LivePreviewSnapshot(overlayKey,fixed,MaskStorage{}).run();
    renderer.setStates({}); renderer.draw(overlayKey.camera,overlayKey.settings);
    require(same(overlay.image(),renderer.readback()),"Live coverage and selection-volume settings cannot be stripped as clean-capture overlays");
    auto metalKey=overlayKey; metalKey.backend=PreviewBackend::Metal;
    auto metal=LivePreviewSnapshot(metalKey,fixed,MaskStorage{}).run();
    require(metal.frame().width==metalKey.width && metal.frame().height==metalKey.height && metal.image().bgra.empty(),
            "Metal preview results expose projected packets without an unnecessary software image");
}
void snapshotAdmission() {
    ResourceBudget budget(4*1024*1024);
    {
    const auto scene=fixture(sceneMemoryForBudget(budget,ResourceCategory::Decoded));
    const std::vector<uint8_t> bytes(scene->gaussians.size(),1);
    auto mask=MaskStorage::copy(bytes,sceneMemoryForBudget(budget,ResourceCategory::History));
    const auto held=budget.usage().categoryBytes[size_t(ResourceCategory::History)];
    std::optional<LivePreviewSnapshot> input;
    input.emplace(key(),scene,mask,budget,AllocationIdentity::create());
    require(budget.usage().categoryBytes[size_t(ResourceCategory::History)]==held,
            "A live snapshot aliases the same physical History mask without a Work recopy");
    mask.clear();
    require(budget.usage().categoryBytes[size_t(ResourceCategory::History)]==held,
            "A retained live snapshot must keep its aliased mask allocation charged");
    auto copied=*input; input.reset();
    {
        auto output=copied.run();
        require(output.image().bgra.size()==48*40*4 && budget.usage().categoryBytes[size_t(ResourceCategory::Image)]>0,
                "Returned software pixels must remain charged throughout result ownership");
    }
    require(budget.usage().categoryBytes[size_t(ResourceCategory::Image)]==0,
            "Destroying a preview result must release its owned pixel charge");
    ResourceBudget foreign(4*1024*1024);
    auto foreignMask=MaskStorage::copy(bytes,sceneMemoryForBudget(foreign,ResourceCategory::History));
    rejects([&]{ LivePreviewSnapshot invalid(key(),scene,foreignMask,budget); },
            "Budgeted live inputs must reject a mask owned by another ledger");
    rejects([&]{ LivePreviewSnapshot invalid(key(),scene,MaskStorage::copy(bytes),budget); },
            "Budgeted live inputs must reject untracked nonempty masks");
    std::stop_source stopped; stopped.request_stop();
    const auto retained=budget.usage().totalBytes;
    rejects([&]{ copied.run(stopped.get_token()); },"Pre-cancelled previews must not render");
    require(budget.usage().totalBytes==retained,"Pre-cancelled rendering must release all transient reservations");
    for (unsigned invalid: {0u,std::numeric_limits<unsigned>::max()}) {
        auto bad=key(); bad.width=invalid;
        rejects([&]{ LivePreviewSnapshot rejected(bad,scene,MaskStorage{},budget); },
                "Invalid or overflowing preview extents must reject before rendering");
        require(budget.usage().totalBytes==retained,"Invalid preview extents must not retain new grants");
    }
    auto bad=key(); bad.camera.radius=std::numeric_limits<float>::quiet_NaN();
    rejects([&]{ LivePreviewSnapshot rejected(bad,scene,MaskStorage{},budget); },
            "A non-finite camera cannot define a reusable live-preview key");
    for (float fov: {0.f,180.f,-1.f,std::numeric_limits<float>::infinity()}) {
        bad=key(); bad.camera.fieldOfView=fov;
        rejects([&]{ LivePreviewSnapshot rejected(bad,scene,MaskStorage{},budget); },
                "An invalid field of view must reject during snapshot staging");
        require(budget.usage().totalBytes==retained,"Invalid camera staging must not acquire a retained scene grant");
    }
    rejects([&]{ LivePreviewSnapshot rejected(key(),{},MaskStorage{},budget); },
            "A live snapshot cannot retain a null source");
    auto invalidMask=MaskStorage::copy(std::vector<uint8_t>(bytes.size(),3),
                                     sceneMemoryForBudget(budget,ResourceCategory::History));
    LivePreviewSnapshot invalidStates(key(),scene,invalidMask,budget);
    const auto beforeInvalid=budget.usage().totalBytes;
    rejects([&]{ invalidStates.run(); },"Invalid mask bytes must reject on the worker before frame allocation");
    require(budget.usage().totalBytes==beforeInvalid,"Mask validation failure must not retain renderer grants");
    }
    require(budget.usage().totalBytes==0,"All live input aliases, outputs and reservations must release at final destruction");
}
void resultMovesAndDenial() {
    ResourceBudget first(4*1024*1024),second(4*1024*1024);
    {
        auto scene=fixture();
        LivePreviewSnapshot a(key(1),scene,MaskStorage{},first);
        LivePreviewSnapshot b(key(2),scene,MaskStorage{},second);
        auto firstOutput=a.run(),secondOutput=b.run();
        const auto *pixels=secondOutput.image().bgra.data();
        const auto secondCharge=second.usage().categoryBytes[size_t(ResourceCategory::Image)];
        firstOutput=std::move(secondOutput);
        require(first.usage().categoryBytes[size_t(ResourceCategory::Image)]==0 &&
                second.usage().categoryBytes[size_t(ResourceCategory::Image)]==secondCharge &&
                firstOutput.image().bgra.data()==pixels && firstOutput.key()==key(2),
                "Move assignment must destroy prior pixels, preserve the new owner grant and avoid an output copy");
    }
    require(first.usage().totalBytes==0 && second.usage().totalBytes==0,
            "Moved result owners must release both independent resource ledgers exactly once");
    for (auto category: {ResourceCategory::Image,ResourceCategory::Render}) {
        ResourceLimits limits; limits.totalBytes=4*1024*1024;
        limits.categoryBytes[size_t(category)]=0;
        ResourceBudget denied(limits);
        {
            auto scene=fixture(); const auto *payload=scene->gaussians.data();
            LivePreviewSnapshot input(key(),scene,MaskStorage{},denied);
            const auto retained=denied.usage().totalBytes;
            try {
                input.run();
                throw std::logic_error("A denied live renderer allocation returned success");
            } catch (const ResourceBudgetExceeded &error) {
                require(error.requestedBytes()>0 && error.availableBytes()==0,
                        "Preview output category denial must identify the rejected positive allocation");
            }
            require(denied.usage().totalBytes==retained && scene->gaussians.data()==payload,
                    "Preview output denial must roll back partial grants and preserve the immutable input");
        }
        require(denied.usage().totalBytes==0,"A denied live snapshot must not leak its retained scene charge");
    }
}
} // namespace
void previewCoordinatorContracts() {
    latestOnly(false); latestOnly(true); failureAndRetry(); captureReentryAndIdentity();
    queuedReleaseAndRejection(); queuedDestructorReentry(); readyDestructorReentry(); destructionDoesNotJoin();
}
void livePreviewContracts() { completeKey(); liveVersusClean(); snapshotAdmission(); resultMovesAndDenial(); }
