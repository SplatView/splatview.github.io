#include "side_input_contracts.hpp"
#include "background_jobs.hpp"
#include "document.hpp"
#include "source_snapshot.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <fstream>
#include <thread>
#include <utility>

namespace {
using namespace preview;
constexpr size_t allowance=64*1024*1024;
void require(bool value,const char *message) { if(!value) throw std::runtime_error(message); }
template<class Error=std::exception,class F> void rejects(F &&action,const char *message) {
    try { std::forward<F>(action)(); } catch(const Error &) { return; }
    throw std::runtime_error(message);
}
size_t category(const ResourceBudget &budget,ResourceCategory kind) {
    return budget.usage().categoryBytes[size_t(kind)];
}
void write(const std::filesystem::path &path,std::string_view value) {
    std::ofstream stream(path,std::ios::binary|std::ios::trunc);
    stream.write(value.data(),std::streamsize(value.size()));
    require(bool(stream),"Side-input fixture write must succeed");
}
std::string read(const std::filesystem::path &path) {
    std::ifstream stream(path,std::ios::binary);
    return {std::istreambuf_iterator<char>(stream),std::istreambuf_iterator<char>()};
}
Recipe operation(const char *type,const std::filesystem::path &path) {
    return {{"type",type},{"values",{{"path",pathUtf8(path)}}}};
}
LoadOptions optionsFor(const ResourceBudget &budget) { LoadOptions options; options.resources=budget; return options; }
bool sameMembers(std::vector<std::filesystem::path> first,std::vector<std::filesystem::path> second) {
    std::sort(first.begin(),first.end()); std::sort(second.begin(),second.end());
    return first==second;
}
void deniedSideInputs(const std::filesystem::path &directory) {
    const auto path=directory/"demo.ply";
    FileSnapshot external(path,allowance);
    ResourceLimits limits{allowance}; limits.categoryBytes[size_t(ResourceCategory::Source)]=0;
    ResourceBudget budget(limits);
    {
        auto initial=std::make_shared<Scene>(loadScene(external.bytes(),optionsFor(budget)));
        Document document; document.replace(path,initial,budget);
        const auto bytes=budget.usage().totalBytes;
        const auto point=document.savePoint();
        for(const char *type:{"merge","concatenate","match","learn"}) {
            const auto job=document.captureProcessing(operation(type,path));
            rejects<ResourceBudgetExceeded>([&] { job.run(); },
                                            "Every scene side-input load must use the captured Source ledger");
            require(document.scene()==initial && document.savePoint()==point && !document.dirty() &&
                        budget.usage().totalBytes==bytes && category(budget,ResourceCategory::Source)==0 &&
                        category(budget,ResourceCategory::Work)==0,
                    "Rejected side inputs must release temporary owners and leave the document/history clean");
        }
        const std::vector<uint8_t> states(initial->gaussians.size());
        rejects<ResourceBudgetExceeded>([&] { processScene(initial,states,operation("merge",path),false,{}, {},budget); },
                                        "Direct processing callers must be able to pass the same explicit side-input policy");
        ResourceBudget foreign(limits);
        const auto generation=document.generation();
        rejects([&] { document.replace(path,initial,foreign); },
                "Document replacement cannot silently accept vector storage charged to another ledger");
        require(document.scene()==initial && document.generation()==generation && foreign.usage().totalBytes==0,
                "Ledger mismatch must fail before changing owner state");
        const Recipe harmless{{"type","color"},{"values",{{"exposure",.25f}}}};
        const auto beforeDirect=budget.usage();
        rejects([&] {processScene(initial,states,harmless,false,{}, {},foreign);},
                "Direct processing must reject an input charged to a different ledger before materializing a result");
        require(foreign.usage().totalBytes==0 && foreign.usage().peakBytes==0 &&
                    budget.usage().totalBytes==beforeDirect.totalBytes && budget.usage().peakBytes==beforeDirect.peakBytes &&
                    document.scene()==initial && document.savePoint()==point && document.generation()==generation,
                "Foreign-input rejection makes no tracked allocation and preserves its source owner and document");
        auto untracked=std::make_shared<Scene>(loadScene(external.bytes()));
        const auto untrackedData=untracked->gaussians.data();
        const auto untrackedCount=untracked->gaussians.size();
        rejects([&] {processScene(untracked,states,harmless,false,{}, {},foreign);},
                "Direct processing must reject an untracked input when an explicit ledger is required");
        require(foreign.usage().totalBytes==0 && foreign.usage().peakBytes==0 &&
                    budget.usage().totalBytes==beforeDirect.totalBytes && budget.usage().peakBytes==beforeDirect.peakBytes &&
                    untracked->gaussians.data()==untrackedData && untracked->gaussians.size()==untrackedCount &&
                    document.scene()==initial && document.savePoint()==point,
                "Untracked-input rejection cannot silently create uncharged result payload or change its owner");
        ProcessingResult invalid; invalid.scene=untracked; invalid.states.resize(untracked->gaussians.size());
        const auto plain=document.captureProcessing(Recipe{});
        rejects([&] { document.apply(std::move(invalid),plain); },
                "Accepted worker results cannot introduce vectors outside the document ledger");
        require(document.scene()==initial && document.savePoint()==point && budget.usage().totalBytes==bytes,
                "A foreign result rejection must preserve the current scene and history");
    }
    require(budget.usage().totalBytes==0,"All rejected-job and document scene owners must release their grants");
}
void capturedPolicyLifetime(const std::filesystem::path &directory) {
    const auto path=directory/"demo.ply";
    ResourceBudget first(allowance),second(allowance);
    std::optional<ProcessingSnapshot> captured;
    {
        Document document; document.open(path,optionsFor(first));
        captured=document.captureProcessing(operation("concatenate",path));
        document.open(path,optionsFor(second));
        const auto otherBytes=second.usage().totalBytes;
        const auto result=captured->run();
        require(result.scene->gaussians.size()==16 && accountedSceneStorageBytes(*result.scene,first)>0 &&
                    accountedSceneStorageBytes(*result.scene,second)==0 &&
                    category(first,ResourceCategory::Source)==0 && second.usage().totalBytes==otherBytes,
                "A captured job retains its original ledger after the owner opens another budgeted document");
        require(!document.apply(result,*captured),"A previous-generation job cannot publish into its replacement owner");
    }
    require(second.usage().totalBytes==0 && first.usage().totalBytes>0,
            "A worker snapshot retains its input and policy safely after Document destruction");
    { const auto result=captured->run(); require(result.scene->gaussians.size()==16,"An ownerless snapshot must still run safely"); }
    captured.reset();
    require(first.usage().totalBytes==0,"Destroying the final captured input releases its decoded allocation");
}
LoadResult resultFrom(DocumentLoader &loader) {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
    do {
        if(auto result=loader.take()) return std::move(*result);
        std::this_thread::yield();
    } while(std::chrono::steady_clock::now()<deadline);
    throw std::runtime_error("Default loader must deliver its source-member manifest");
}
void injectedLoaderProvenance(const std::filesystem::path &unpacked,
                              const std::vector<std::filesystem::path> &members) {
    ResourceBudget budget(allowance);
    std::atomic<bool> legacyCalled{};
    BackgroundExecutor executor(1,3);
    {
        DocumentLoader typed(executor,DocumentLoader::SourceLoadFunction{
            [](const std::filesystem::path &path,LoadOptions options) {return loadSceneWithSources(path,options);}});
        const auto generation=typed.request(unpacked,optionsFor(budget));
        auto result=resultFrom(typed);
        require(result.generation==generation && result.error.empty() && result.scene && sameMembers(result.sourceMembers,members) &&
                    accountedSceneStorageBytes(*result.scene,budget)>0 && category(budget,ResourceCategory::Source)==0,
                "Typed injected loader delivers real decoded SOG members and the requested decoded ledger");
    }
    require(budget.usage().totalBytes==0,"Typed loader delivery releases its last decoded owner and source grants");
    {
        DocumentLoader legacy(executor,DocumentLoader::LoadFunction{
            [&legacyCalled](const std::filesystem::path &path,LoadOptions options) {
                legacyCalled.store(true); return loadScene(path,options);
            }});
        const auto peak=budget.usage().peakBytes;
        for(const auto &path:{unpacked,unpacked/"meta.json"}) {
            legacy.request(path,optionsFor(budget));
            const auto result=resultFrom(legacy);
            require(!result.scene && result.sourceMembers.empty() && !result.error.empty() &&
                        result.error.find("decode-snapshot")!=std::string::npos && !legacyCalled.load() &&
                        budget.usage().totalBytes==0 && budget.usage().peakBytes==peak,
                    "Legacy Scene-only injection rejects unpacked SOG before invoking an uncertified decoder");
        }
    }
    {
        DocumentLoader missing(executor,DocumentLoader::SourceLoadFunction{
            [](const std::filesystem::path &path,LoadOptions options) {
                auto loaded=loadSceneWithSources(path,options); loaded.sourceMembers.clear(); return loaded;
            }});
        missing.request(unpacked,optionsFor(budget));
        const auto result=resultFrom(missing);
        require(!result.scene && result.sourceMembers.empty() &&
                    result.error.find("source-member provenance")!=std::string::npos && budget.usage().totalBytes==0,
                "Typed loader rejects empty provenance and releases the decoded scene before error delivery");
    }
    require(budget.usage().totalBytes==0,"Injected loader failures release every retained grant");
}
void memberManifestAndExport(const std::filesystem::path &directory) {
    const auto folder=directory/"side-inputs";
    const auto unpacked=folder/"unpacked";
    std::filesystem::create_directories(unpacked);
    const auto reference=sourceMemberPaths(directory/"decode"/"unpacked");
    require(reference.size()>1,"Real decoded SOG fixture must contain property textures");
    for(const auto &path:reference)
        std::filesystem::copy_file(path,unpacked/path.filename(),std::filesystem::copy_options::overwrite_existing);
    const auto metadata=unpacked/"meta.json";
    const auto count=size_t(std::filesystem::file_size(metadata));
    ResourceBudget manifestOnly(count);
    const auto members=sourceMemberPaths(unpacked,{},manifestOnly);
    require(members.size()==reference.size() && manifestOnly.usage().totalBytes==0 &&
                manifestOnly.usage().peakBytes==count,
            "Enumerating SOG input members admits metadata only and releases it before returning paths");
    ResourceBudget denied(count-1);
    rejects<ResourceBudgetExceeded>([&] { sourceMemberPaths(metadata,{},denied); },
                                    "Metadata manifests must reject before exceeding Source admission");
    require(denied.usage().totalBytes==0 && denied.usage().peakBytes==0,"Rejected manifests must retain no byte grant");
    std::stop_source stop; stop.request_stop();
    rejects([&] { sourceMemberPaths(metadata,stop.get_token(),manifestOnly); },"Precancelled manifests must reject");

    ResourceBudget budget(allowance);
    {
        const auto originalMetadata=read(metadata);
        const auto stamp=sourceStamp(unpacked);
        auto decoded=loadSceneWithSources(unpacked,optionsFor(budget));
        const auto observed=decoded.sourceMembers;
        require(decoded.scene.isGaussian() && !decoded.scene.gaussians.empty() && sameMembers(observed,members) &&
                    decoded.scene.sourceContentKey==stamp.contentKey && decoded.scene.sourceFileIdentity==stamp.identity &&
                    decoded.scene.sourceBytes==stamp.bytes,
                "LoadedScene must pair the decoded scene provenance with all members of its actual source snapshot");
        require(category(budget,ResourceCategory::Source)==0 && category(budget,ResourceCategory::Decoded)>0,
                "LoadedScene returns decoded grants without retaining source byte arrays");
        const auto old=*std::find_if(observed.begin(),observed.end(),[](const auto &path){return path.filename()!="meta.json";});
        const auto oldBytes=read(old);
        const auto fresh=unpacked/"delivery-new.webp";
        // This is the former decode/delivery race: metadata changes before the
        // owner receives the scene. A fresh helper read must not redefine which
        // files produced that scene.
        write(metadata,R"({"means":{"files":["delivery-new.webp"]}})");
        write(fresh,"new member declared after decoding");
        const auto now=sourceMemberPaths(unpacked);
        require(sourceStamp(unpacked)!=stamp && std::find(now.begin(),now.end(),old)==now.end() &&
                    std::find(now.begin(),now.end(),fresh)!=now.end() && decoded.sourceMembers==observed,
                "Postdecode metadata enumeration differs while the returned decoded-member manifest stays immutable");
        {
            Document delivered;
            delivered.replace(unpacked,std::make_shared<Scene>(std::move(decoded.scene)),budget,std::move(decoded.sourceMembers));
            for(const auto &member:observed)
                require(std::find(delivered.inputPaths().begin(),delivered.inputPaths().end(),member)!=delivered.inputPaths().end(),
                        "Owner delivery retains every actual decoded member even when current metadata omits it");
            require(std::find(delivered.inputPaths().begin(),delivered.inputPaths().end(),fresh)==delivered.inputPaths().end(),
                    "Fresh helper enumeration does not replace the observed decode manifest at owner delivery");
            const auto revision=delivered.revision();
            const auto scene=delivered.scene();
            const auto oldAlias=folder/"delivery-old-alias.ply", newAlias=folder/"delivery-new-alias.ply";
            std::error_code error;
            std::filesystem::remove(oldAlias,error); std::filesystem::create_hard_link(old,oldAlias);
            std::filesystem::remove(newAlias,error); std::filesystem::create_hard_link(fresh,newAlias);
            rejects([&] {delivered.captureExport(oldAlias).run();},
                    "Export must protect a decoded member removed from metadata before document delivery");
            rejects([&] {delivered.captureExport(newAlias).run();},
                    "Export worker must additionally protect members newly declared after decoding");
            require(read(old)==oldBytes && read(oldAlias)==oldBytes && read(fresh)=="new member declared after decoding" &&
                        read(newAlias)=="new member declared after decoding" && delivered.scene()==scene && delivered.revision()==revision &&
                        category(budget,ResourceCategory::Source)==0,
                    "Both alias rejections preserve source bytes, owner state and source-grant release");
        }
        write(metadata,originalMetadata);
    }
    require(budget.usage().totalBytes==0,"Decoded delivery and alias rejection release every retained scene grant");
    injectedLoaderProvenance(unpacked,members);
    {
        BackgroundExecutor executor(1,2); DocumentLoader loader(executor);
        loader.request(unpacked,optionsFor(budget));
        auto result=resultFrom(loader);
        require(result.error.empty() && result.scene && sameMembers(result.sourceMembers,members),
                "Default worker loading must deliver the bounded member manifest beside its Scene");
        Document document;
        document.replace(result.path,std::move(result.scene),budget,std::move(result.sourceMembers));
        for(const auto &member:members)
            require(std::find(document.inputPaths().begin(),document.inputPaths().end(),member)!=document.inputPaths().end(),
                    "Replacement must retain all worker-observed SOG inputs without filesystem reads");
        const auto output=folder/"preserved.ply";
        write(output,"previous output");
        const auto initialRevision=document.revision();
        const auto initialScene=document.scene();
        {
            auto occupied=budget.reserve(ResourceCategory::Source,allowance-budget.usage().totalBytes);
            const auto job=document.captureExport(output);
            rejects<ResourceBudgetExceeded>([&] { job.run(); },
                                            "Export capture must defer filesystem/member admission to its worker");
            require(read(output)=="previous output" && document.scene()==initialScene && document.revision()==initialRevision,
                    "Worker manifest rejection must preserve destination bytes and document state");
        }
        // Protect the observed input even when later metadata no longer lists it.
        const auto old=members[1]; const auto oldBytes=read(old);
        write(metadata,R"({"means":{"files":["new.webp"]}})");
        write(unpacked/"new.webp","new declared member");
        const auto alias=folder/"old-member-alias.ply";
        std::error_code error; std::filesystem::remove(alias,error);
        std::filesystem::create_hard_link(old,alias);
        const auto job=document.captureExport(alias);
        rejects([&] { job.run(); },"Export must reject aliases of originally observed members removed from new metadata");
        require(read(old)==oldBytes && read(alias)==oldBytes,"Alias rejection must preserve original texture bytes");
        const auto newAlias=folder/"new-member-alias.ply";
        std::filesystem::remove(newAlias,error); std::filesystem::create_hard_link(unpacked/"new.webp",newAlias);
        rejects([&] { document.captureExport(newAlias).run(); },"Worker must also protect newly declared members");
        std::stop_source cancelled; cancelled.request_stop();
        const auto peak=budget.usage().peakBytes;
        rejects([&] { document.captureExport(output).run(cancelled.get_token()); },"Precancelled exports must stop before alias I/O/admission");
        require(read(output)=="previous output" && budget.usage().peakBytes==peak,
                "Precancelled alias checks must preserve output without increasing admission peaks");
    }
    require(budget.usage().totalBytes==0,"Loader/document/job destruction must release all shared ledger owners");
    write(metadata,R"({"means":{"files":["../escape.webp"]}})");
    rejects([&] { sourceMemberPaths(metadata); },"Manifest enumeration must apply the same safe filename rules as decoding");
}
} // namespace
void sideInputContracts(const std::filesystem::path &directory) {
    deniedSideInputs(directory);
    capturedPolicyLifetime(directory);
    memberManifestAndExport(directory);
}
