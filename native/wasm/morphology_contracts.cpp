#include "morphology_job.hpp"
#include "morphology_range_job.hpp"
#include "response.hpp"
#include "resource_budget.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

using namespace preview;
namespace {
size_t checks{},cases{},volumeCases{},rangeCases{},rangeRefusals{};
void require(bool condition,const char *message) {
    ++checks;
    if(!condition) throw std::runtime_error(message);
}
template<class F> void rejects(F &&f) {
    bool failed=false;
    try { f(); } catch(const std::exception &) { failed=true; }
    require(failed,"Expected operation refusal");
}
struct DenyMemory final : SceneMemory {
    explicit DenyMemory(std::shared_ptr<SceneMemory> delegate):delegate(std::move(delegate)) {}
    std::shared_ptr<void> admit(size_t bytes) override {
        if(++calls==deny) throw std::bad_alloc();
        return delegate->admit(bytes);
    }
    void arm(size_t ordinal) { calls=0; deny=ordinal; }
    std::shared_ptr<SceneMemory> delegate;
    size_t calls{},deny{};
};
std::shared_ptr<Scene> fixture(size_t n=5) {
    auto scene=std::make_shared<Scene>();
    scene->gaussians.resize(n);
    for(size_t i=0;i<n;++i) {
        auto &g=scene->gaussians[i];
        g.positionOpacity={float(i)*1.9f,0,0,1};
        g.covA={1,0,0,1}; g.covB={0,1,0,0};
    }
    scene->sourceCount=n;
    return scene;
}
void finish(BrowserMorphologyJob &job) {
    size_t guard=0;
    while(!job.complete()) {
        require(job.step(17)<=17,"Morphology exceeded its supplied work budget");
        require(++guard<100000,"Morphology failed to finish");
    }
}
std::vector<uint8_t> states(const SceneEdits &edits) {
    return {edits.states().begin(),edits.states().end()};
}
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid && a.scenePayloadBytes==b.scenePayloadBytes && a.ownedRawBytes==b.ownedRawBytes &&
        a.overlapBytes==b.overlapBytes && a.contextBytes==b.contextBytes && a.unionBytes==b.unionBytes &&
        a.liveBlocks==b.liveBlocks && a.liveContexts==b.liveContexts;
}
void historyRefusal(void *,std::string_view seam) {
    if(seam=="history.append") throw std::bad_alloc();
}
} // namespace
namespace preview {
struct HistoryAdmissionTestAccess {
    static void failAppend(SceneEdits &edits,bool value) {
        edits.historyCheckpoint_=value ? historyRefusal : nullptr;
    }
};
}
int ownershipContracts() {
    try {
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            const auto before=states(edits);
            const auto revision=edits.revision(),content=edits.contentRevision();
            const auto *oldOwner=edits.states().data();
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            const auto expected=sizeof(BrowserMorphologyJob)+browser_morphology::scratchRequirements(before.size()).bytes;
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==expected,"Work admission is not exact scratch plus owner");
            finish(*job);
            require(job->result().size()==1 && job->result()[0].index==1,"Growth must use only the original baseline seeds");
            require(BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()),"Nonempty morphology did not publish");
            require(edits.revision()==revision+1 && edits.contentRevision()==content,"Selection publication changed content or multiple revisions");
            require(edits.states().data()!=oldOwner,"Shared baseline did not force admitted COW");
            require(std::equal(before.begin(),before.end(),job->baseline().states.begin()),"Publication modified the immutable baseline");
            const auto grown=states(edits);
            job.reset();
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Completed morphology retained Work payload");
            require(edits.undo() && states(edits)==before,"One Undo did not restore the exact pre-morphology mask");
            require(edits.redo() && states(edits)==grown,"Redo did not restore the exact grown mask");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectAll(); edits.selectNone(); edits.undo();
            require(edits.canRedo(),"Empty-result fixture has no Redo");
            const auto before=states(edits);
            const auto revision=edits.revision(),content=edits.contentRevision();
            const auto *owner=edits.states().data();
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            require(job->result().empty(),"All-selected Grow changed selection");
            require(!BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()),"Empty result manufactured a revision");
            job.reset();
            require(states(edits)==before && edits.revision()==revision && edits.contentRevision()==content &&
                edits.states().data()==owner && edits.canRedo(),"Empty result changed owner, history or revisions");
            require(edits.redo() && edits.selectedCount()==0,"Empty result destroyed executable Redo");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(1,SelectOperation::Set); edits.deleteSelected(); edits.selectSingle(0,SelectOperation::Set);
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            require(job->result().empty(),"Deleted Gaussian became a Grow target or transitive seed");
            require(edits.states()[1]==2,"Deleted fixture lost its deletion bit");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set); edits.selectSingle(1,SelectOperation::Add);
            const auto before=states(edits);
            auto job=BrowserMorphologyJob::create(edits,false,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            require(job->result().size()==1 && job->result()[0].index==1 && job->result()[0].value==0,
                    "Shrink must remove exactly one original boundary layer");
            require(BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()),"Shrink did not publish");
            require(edits.states()[0]==1 && edits.states()[1]==0,"Shrink crossed beyond its original boundary");
            require(edits.undo() && states(edits)==before,"Shrink Undo did not restore exact selection");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            edits.selectSingle(3,SelectOperation::Set);
            const auto before=states(edits);
            const auto revision=edits.revision();
            rejects([&] { BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()); });
            require(states(edits)==before && edits.revision()==revision,"Stale publication modified selection");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            const auto baseline=BrowserSelectionAccess::capture(edits);
            const auto before=states(edits);
            const std::array<browser_morphology::Override,2> duplicates{{{1,1},{1,1}}};
            const std::array<browser_morphology::Override,2> unsorted{{{2,1},{1,1}}};
            const std::array<browser_morphology::Override,1> invalid{{{1,2}}},unchanged{{{0,1}}},outside{{{5,1}}};
            const std::array<std::span<const browser_morphology::Override>,5> invalidResults{duplicates,unsorted,invalid,unchanged,outside};
            for(auto changes:invalidResults)
                rejects([&] { BrowserSelectionAccess::publishMorphology(edits,baseline,changes); });
            require(states(edits)==before,"Invalid sparse results modified the mask");
        }
        for(size_t ordinal=1;ordinal<=7;++ordinal) {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            const auto before=states(edits);
            const auto revision=edits.revision();
            auto memory=std::make_shared<DenyMemory>(sceneMemoryForBudget(budget,ResourceCategory::Work));
            memory->arm(ordinal);
            rejects([&] { auto job=BrowserMorphologyJob::create(edits,true,1,memory); });
            require(memory->calls==ordinal,"Scratch refusal did not reach the expected allocation");
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Partial scratch refusal leaked a grant");
            require(states(edits)==before && edits.revision()==revision,"Scratch refusal modified the live edit");
        }
        for(size_t ordinal=1;ordinal<=2;++ordinal) {
            ++cases;
            ResourceBudget budget(1000000);
            auto history=std::make_shared<DenyMemory>(sceneMemoryForBudget(budget,ResourceCategory::History));
            SceneEdits edits(fixture(),history);
            edits.selectSingle(0,SelectOperation::Set);
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            const auto before=states(edits);
            const auto revision=edits.revision(),content=edits.contentRevision();
            const auto *owner=edits.states().data();
            const auto historyBytes=budget.usage().categoryBytes[size_t(ResourceCategory::History)];
            history->arm(ordinal);
            rejects([&] { BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()); });
            require(history->calls==ordinal,"Sparse conversion/COW refusal did not reach its expected grant");
            require(states(edits)==before && edits.revision()==revision && edits.contentRevision()==content && edits.states().data()==owner,
                    "Sparse conversion/COW refusal partially published");
            require(budget.usage().categoryBytes[size_t(ResourceCategory::History)]==historyBytes,"Publication refusal retained history payload");
            job.reset();
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Publication refusal did not retire Work");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set); edits.selectSingle(4,SelectOperation::Set); edits.undo();
            auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
            finish(*job);
            const auto before=states(edits);
            const auto revision=edits.revision();
            const auto *owner=edits.states().data();
            HistoryAdmissionTestAccess::failAppend(edits,true);
            rejects([&] { BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result()); });
            HistoryAdmissionTestAccess::failAppend(edits,false);
            require(states(edits)==before && edits.revision()==revision && edits.states().data()==owner && edits.canRedo(),
                    "History append refusal destroyed the original live/history state");
            require(edits.redo() && edits.states()[4]==1,"Refused append destroyed executable Redo");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(1000),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            const auto before=states(edits);
            const auto revision=edits.revision();
            const auto initial=sv_allocation::snapshot();
            {
                sv_allocation::Scope scope;
                auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(budget,ResourceCategory::Work));
                const auto measured=sv_allocation::snapshot();
                const auto payload=sizeof(BrowserMorphologyJob)+browser_morphology::scratchRequirements(1000).bytes;
                require(measured.valid && measured.scenePayloadBytes==initial.scenePayloadBytes+payload,
                    "Raw scratch/owner did not retain existing allocator census payload tags");
                job->step(4096); job->cancel();
                require(job->result().empty(),"Cancelled job exposed unpublished overrides");
                job.reset();
                require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Cancellation retained admitted Work");
            }
            require(sameCensus(initial,sv_allocation::snapshot()),"Cancellation leaked raw storage or census context");
            require(states(edits)==before && edits.revision()==revision,"Cancellation modified live edits");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            auto work=sceneMemoryForBudget(budget,ResourceCategory::Work);
            rejects([&] { auto job=BrowserMorphologyJob::create(edits,true,1,nullptr); });
            rejects([&] { auto job=BrowserMorphologyJob::create(edits,true,.49f,work); });
            rejects([&] { auto job=BrowserMorphologyJob::create(edits,true,std::numeric_limits<float>::infinity(),work); });
            edits.beginSelectionDraft();
            rejects([&] { auto job=BrowserMorphologyJob::create(edits,true,1,work); });
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Invalid dispatch retained Work");
        }
        {
            ++cases;
            ResourceBudget budget(1000000);
            SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
            edits.selectSingle(0,SelectOperation::Set);
            auto work=sceneMemoryForBudget(budget,ResourceCategory::Work);
            const auto before=states(edits);
            const auto revision=edits.revision();
            const auto initial=sv_allocation::snapshot();
            size_t failures=0;
            bool success=false;
            for(size_t ordinal=1;ordinal<100 && !success;++ordinal) {
                sv_allocation::failBackendAtForContracts(ordinal);
                try {
                    sv_allocation::Scope scope;
                    auto job=BrowserMorphologyJob::create(edits,true,1,work);
                    success=true;
                } catch(const std::bad_alloc &) { ++failures; }
                sv_allocation::failBackendAtForContracts(0);
                require(sameCensus(initial,sv_allocation::snapshot()),"Owner-construction backend refusal leaked tracked raw/context storage");
                require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Owner-construction backend refusal leaked Work grants");
                require(states(edits)==before && edits.revision()==revision,"Owner-construction backend refusal changed live state");
            }
            require(success && failures>=7,"Backend sweep did not cover every scratch/owner physical allocation");
        }
        return 0;
    } catch(const std::exception &error) {
        std::fprintf(stderr,"morphology bridge CPU contract failed after %zu checks: %s\n",checks,error.what());
        return 1;
    }
}

extern "C" {
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const uint32_t *sv_pack(unsigned,unsigned);
unsigned sv_pack_len();
const uint8_t *sv_output_ptr();
unsigned sv_output_len();
}
namespace {
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
struct NativeSummary {
    bool ok{},pending{},canUndo{},canRedo{},transaction{},draft{};
    uint64_t revision{},contentRevision{};
    size_t count{},selected{},visible{},memoryBytes{};
    unsigned kind{};
};
NativeSummary parsedSummary(const char *text) {
    // No JSON owner survives this helper or a census observation. It consumes
    // the actual bounded response before the next ABI call overwrites it.
    const auto value=Json::parse(text);
    NativeSummary result;
    result.ok=value.value("ok",false);
    result.pending=value.value("pending",false);
    result.canUndo=value.value("canUndo",false);result.canRedo=value.value("canRedo",false);
    result.transaction=value.value("transaction",false);result.draft=value.value("selectionDraft",false);
    result.revision=value.value("revision",uint64_t(0));result.contentRevision=value.value("contentRevision",uint64_t(0));
    result.count=value.value("count",size_t(0));result.selected=value.value("selected",size_t(0));
    result.visible=value.value("visible",size_t(0));result.memoryBytes=value.value("memoryBytes",size_t(0));
    result.kind=value.value("kind",0u);
    return result;
}
NativeSummary nativeCommand(const char *request) { return parsedSummary(admittedContractCommand(request)); }
bool nativeRefusal(const char *request,const char *error) {
    const auto value=Json::parse(sv_command(request));
    return value.at("ok")==false && value.at("error")==error;
}
NativeSummary nativeSummary() { return nativeCommand("{\"command\":\"summary\"}"); }
NativeSummary nativeOpen(const std::string &input) {
    return parsedSummary(sv_open(reinterpret_cast<const uint8_t *>(input.data()),input.size(),
        unsigned(InputFormat::Auto),1000,32*1024*1024));
}
std::string gaussianInput() {
    return "ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
        "property float f_dc_2\nend_header\n"
        "0 0 0 0 0 0 1 0 0 0 1 0 0 0\n1.9 0 0 0 0 0 1 0 0 0 1 0 0 0\n"
        "3.8 0 0 0 0 0 1 0 0 0 1 0 0 0\n5.7 0 0 0 0 0 1 0 0 0 1 0 0 0\n"
        "7.6 0 0 0 0 0 1 0 0 0 1 0 0 0\n";
}
std::string geometryInput() {
    return "ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\n"
        "end_header\n0 0 0\n1 0 0\n";
}
NativeSummary finishNative(NativeSummary value,unsigned batch=17) {
    for(size_t steps=0;value.pending;++steps) {
        require(steps<10000,"Actual native morphology never completed");
        value=parsedSummary(sv_step(batch));
        require(value.ok,"Actual native morphology step failed");
    }
    return value;
}
std::vector<uint8_t> nativeStates(size_t count=5) {
    const auto *pointer=sv_states_ptr();
    require(pointer!=nullptr,"Expected a native Gaussian mask owner");
    return {pointer,pointer+count};
}
Bytes nativeScene(size_t count=5) {
    const auto *pointer=reinterpret_cast<const uint8_t *>(sv_scene_ptr());
    require(pointer!=nullptr,"Expected a native Gaussian scene owner");
    return {pointer,pointer+count*sizeof(Gaussian)};
}
Bytes nativePacked(size_t count=5) {
    const auto *pointer=reinterpret_cast<const uint8_t *>(sv_pack(0,unsigned(count)));
    require(pointer && sv_pack_len(),"Expected an immutable packed Gaussian packet");
    return {pointer,pointer+sv_pack_len()};
}
Bytes nativeOutput() {
    const auto *pointer=sv_output_ptr();
    require(pointer && sv_output_len(),"Expected a previous export payload");
    return {pointer,pointer+sv_output_len()};
}
void nativeBoundaryContracts() {
    const auto gaussian=gaussianInput(),geometry=geometryInput();
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Native Gaussian fixture failed to open");
        require(nativeCommand(R"({"command":"single","index":0,"operation":0})").selected==1,"Native seed selection failed");
        require(nativeCommand(R"({"command":"export","format":5,"scope":0})").ok,"Native export fixture failed");
        const auto scene=nativeScene(),packed=nativePacked(),output=nativeOutput(),before=nativeStates();
        const auto *sceneOwner=sv_scene_ptr();
        const auto previous=nativeSummary();
        require(nativeCommand(R"({"command":"beginTransaction"})").transaction,"Grow checkpoint failed");
        auto value=nativeCommand(R"({"command":"morphology","mode":"grow"})");
        require(value.ok && value.pending && value.selected==1 && value.revision==previous.revision,
                "Grow dispatch published before cooperative stepping");
        value=parsedSummary(sv_step(1));
        require(value.ok && value.pending && nativeStates()==before,"Bounded Count step published a partial mask");
        value=finishNative(value);
        require(value.selected==2 && nativeStates()==std::vector<uint8_t>({1,1,0,0,0}) &&
                value.revision==previous.revision+1 && value.contentRevision==previous.contentRevision && value.transaction,
                "Actual Grow differed from the independent one-layer sphere oracle or revision contract");
        require(sv_scene_ptr()==sceneOwner && nativeScene()==scene && nativePacked()==packed && nativeOutput()==output,
                "Actual Grow changed scene, packed coefficients or previous export");
        require(!nativeCommand(R"({"command":"commitTransaction"})").transaction,"Grow checkpoint did not retire");
        require(nativeCommand(R"({"command":"undo"})").selected==1 && nativeStates()==before,"Actual Grow Undo lost the baseline");
        require(nativeCommand(R"({"command":"redo"})").selected==2,"Actual Grow Redo did not execute");
        const auto grown=nativeStates();
        require(nativeCommand(R"({"command":"beginTransaction"})").transaction,"Shrink checkpoint failed");
        value=finishNative(nativeCommand(R"({"command":"morphology","mode":"shrink","sigma":1})"));
        require(value.ok && value.selected==1 && nativeStates()==std::vector<uint8_t>({1,0,0,0,0}),
                "Actual Shrink crossed beyond its original boundary");
        value=nativeCommand(R"({"command":"rollbackTransaction"})");
        require(value.ok && !value.transaction && !value.pending && nativeStates()==grown && value.selected==2,
                "Completed Shrink rollback did not restore exact selection");
    }
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Redo fixture failed to open");
        require(nativeCommand(R"({"command":"selectAll"})").selected==5,"All-selected fixture failed");
        require(nativeCommand(R"({"command":"selectNone"})").selected==0,"Empty selection fixture failed");
        const auto previous=nativeCommand(R"({"command":"undo"})");
        require(previous.selected==5 && previous.canRedo,"Empty Grow fixture has no Redo");
        const auto *owner=sv_states_ptr();
        require(nativeCommand(R"({"command":"beginTransaction"})").transaction,"Empty Grow checkpoint failed");
        const auto value=finishNative(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":0.5})"),1);
        require(value.ok && value.selected==5 && value.canRedo && value.revision==previous.revision &&
                value.contentRevision==previous.contentRevision && sv_states_ptr()==owner,
                "Empty actual Grow modified owner, revision or Redo");
        require(nativeCommand(R"({"command":"commitTransaction"})").ok,"Empty Grow commit failed");
        require(nativeCommand(R"({"command":"redo"})").selected==0,"Empty actual Grow destroyed executable Redo");
    }
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Cancellation fixture failed to open");
        require(nativeCommand(R"({"command":"single","index":0,"operation":0})").selected==1,"Cancellation seed failed");
        const auto before=nativeStates();
        const auto summary=nativeSummary();
        const auto census=sv_allocation::snapshot();
        require(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").pending,"Cancellation job was not installed");
        require(parsedSummary(sv_step(1)).pending,"Cancellation job completed before its first bounded step");
        const auto value=nativeCommand(R"({"command":"cancel"})");
        require(value.ok && !value.pending && value.revision==summary.revision && nativeStates()==before,
                "Actual cancellation published partial morphology");
        require(sameCensus(census,sv_allocation::snapshot()),
                "Global reset retained morphology payload, deleter Work service or census context");
        require(parsedSummary(sv_step(4096)).ok && nativeStates()==before,"Idle step revived cancelled morphology");
    }
    {
        ++cases;
        ResourceBudget budget(1000000);
        SceneEdits edits(fixture(),sceneMemoryForBudget(budget,ResourceCategory::History));
        edits.selectSingle(0,SelectOperation::Set);
        auto service=sceneMemoryForBudget(budget,ResourceCategory::Work);
        std::weak_ptr<SceneMemory> weak=service;
        auto job=BrowserMorphologyJob::create(edits,true,1,service);
        service.reset();
        job->cancel(); job.reset();
        job.get_deleter().memory.reset();
        // Check while the empty Pointer itself remains alive. The browser
        // global retirement helper must perform this exact metadata retirement.
        require(weak.expired(),"Empty Pointer retained the Work service after explicit deleter retirement");
    }
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Pending rollback fixture failed to open");
        require(nativeCommand(R"({"command":"single","index":0,"operation":0})").selected==1,"Rollback seed failed");
        require(nativeCommand(R"({"command":"single","index":4,"operation":0})").selected==1,"Rollback Redo fixture failed");
        const auto previous=nativeCommand(R"({"command":"undo"})");
        const auto before=nativeStates();
        require(previous.canRedo && before==std::vector<uint8_t>({1,0,0,0,0}),"Rollback fixture has no executable Redo");
        const auto census=sv_allocation::snapshot();
        require(nativeCommand(R"({"command":"beginTransaction"})").transaction,"Pending rollback checkpoint failed");
        require(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").pending,"Pending rollback job failed");
        require(parsedSummary(sv_step(1)).pending,"Pending rollback job completed too early");
        const auto value=nativeCommand(R"({"command":"rollbackTransaction"})");
        require(value.ok && !value.pending && !value.transaction && value.canRedo && value.revision==previous.revision && nativeStates()==before,
                "Rollback failed to retire pending morphology and restore exact history");
        const auto restored=sv_allocation::snapshot();
        // Copying Undo/Redo into one checkpoint consolidates allocations that
        // were originally made in separate command scopes. The history payload
        // and physical blocks remain exact; fewer census contexts are valid.
        require(restored.valid && value.memoryBytes==previous.memoryBytes &&
                restored.scenePayloadBytes==census.scenePayloadBytes && restored.overlapBytes==census.overlapBytes &&
                restored.liveBlocks==census.liveBlocks && restored.liveContexts<=census.liveContexts &&
                restored.contextBytes<=census.contextBytes &&
                restored.ownedRawBytes-restored.contextBytes==census.ownedRawBytes-census.contextBytes &&
                restored.unionBytes-restored.contextBytes==census.unionBytes-census.contextBytes,
                "Pending rollback retained payload, physical blocks or non-context metadata");
        require(nativeCommand(R"({"command":"redo"})").selected==1 && nativeStates()[4]==1,
                "Pending morphology rollback destroyed executable Redo");
    }
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Deleted-target fixture failed to open");
        require(nativeCommand(R"({"command":"single","index":1,"operation":0})").selected==1,"Deleted-target setup failed");
        require(nativeCommand(R"({"command":"delete"})").visible==4,"Deleted-target cleanup failed");
        const auto previous=nativeCommand(R"({"command":"single","index":0,"operation":0})");
        const auto value=finishNative(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})"));
        require(value.ok && value.selected==1 && value.visible==4 && value.revision==previous.revision &&
                nativeStates()==std::vector<uint8_t>({1,2,0,0,0}),"Deleted target became a seed or target in the actual bridge");
    }
    {
        ++cases;
        require(nativeOpen(gaussian).ok,"Refusal fixture failed to open");
        const auto initial=nativeSummary();
        for(const char *request:{R"({"command":"morphology","mode":"other","sigma":1})",
            R"({"command":"morphology","mode":"grow","sigma":0.49})",
            R"({"command":"morphology","mode":"shrink","sigma":10.01})"}) {
            require(!nativeCommand(request).ok,"Invalid morphology request was accepted");
            const auto value=nativeSummary();
            require(!value.pending && value.revision==initial.revision && value.selected==0,
                    "Invalid morphology request changed the live owner");
        }
        require(nativeCommand(R"({"command":"beginSelection"})").draft,"Selection draft fixture failed");
        require(!nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").ok,
                "Morphology accepted an active selection gesture");
        require(nativeSummary().draft && !nativeSummary().pending,"Morphology refusal destroyed the selection draft");
        require(nativeCommand(R"({"command":"cancelSelection"})").ok,"Selection draft cleanup failed");
        require(nativeCommand(R"({"command":"single","index":0,"operation":0})").selected==1,"Busy fixture seed failed");
        const auto before=nativeStates();
        require(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").pending,"Busy job failed");
        require(nativeRefusal(R"({"command":"selectionMapBegin","mapId":1,"layoutVersion":1,"fullWidth":1,"fullHeight":1,"mapWidth":1,"mapHeight":1,"sourceCount":5,"channels":3})",
                "Finish the edit before uploading a selection map") && nativeSummary().pending,
                "A valid map header bypassed the morphology upload busy guard or cancelled its owner");
        require(nativeRefusal(R"({"command":"selectionMapCommit","mapId":1})",
                "Finish the edit before adopting a selection map") && nativeSummary().pending,
                "A valid map ID bypassed the morphology adoption busy guard or cancelled its owner");
        require(!nativeCommand(R"({"command":"selectAll"})").ok,"Conflicting ordinary edit bypassed morphology busy guard");
        require(!nativeSummary().pending && nativeStates()==before,
                "Conflicting-edit refusal published morphology or failed to follow native error retirement");
    }
    {
        ++cases;
        require(nativeOpen(geometry).ok,"Geometry replacement baseline failed");
        const auto baseline=nativeSummary();
        const auto census=sv_allocation::snapshot();
        require(nativeOpen(gaussian).ok,"Geometry replacement Gaussian fixture failed");
        require(nativeCommand(R"({"command":"single","index":0,"operation":0})").selected==1,"Replacement seed failed");
        require(nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").pending,"Replacement job failed");
        const auto value=nativeOpen(geometry);
        require(value.ok && !value.pending && value.kind==baseline.kind && value.count==baseline.count && !sv_scene_ptr() && !sv_states_ptr(),
                "Open replacement retained a pending Gaussian/morphology owner");
        require(sameCensus(census,sv_allocation::snapshot()),"Scene replacement retained old Work service, ledger or scratch");
        require(!nativeCommand(R"({"command":"morphology","mode":"grow","sigma":1})").ok,
                "View-only geometry accepted Grow");
        require(!nativeSummary().pending && parsedSummary(sv_step(4096)).ok,"Geometry refusal or idle step installed a Gaussian job");
    }
}
}
namespace {
void volumeContracts() {
    const auto volume=browser_morphology::Method::Volume;
    for(const auto batch:{size_t(1),size_t(17),size_t(65536)}) {
        ++cases;++volumeCases;
        ResourceBudget resources(1000000);auto scene=fixture(7);
        const std::array<float,7> x{0,1,2,-1,std::nextafter(1.f,2.f),0,.5f};
        for(size_t i=0;i<x.size();++i) {
            scene->gaussians[i].positionOpacity={x[i],0,0,0};
            scene->gaussians[i].covA={0,0,0,0};scene->gaussians[i].covB={0,0,0,0};
        }
        SceneEdits edits(scene,sceneMemoryForBudget(resources,ResourceCategory::History));
        edits.selectSingle(6,SelectOperation::Set);edits.deleteSelected();edits.selectSingle(0,SelectOperation::Set);
        const auto before=states(edits);const auto revision=edits.revision(),content=edits.contentRevision();
        auto job=BrowserMorphologyJob::create(edits,true,1,sceneMemoryForBudget(resources,ResourceCategory::Work),{},volume);
        size_t guard=0;while(!job->complete()) {require(job->step(batch)<=batch,"Volume exceeded its work budget");require(++guard<10000,"Volume failed to finish");}
        const auto result=job->result();
        require(result.size()==3&&result[0].index==1&&result[1].index==3&&result[2].index==5,
            "Volume inclusive radius, nextafter exclusion, duplicate centers, transparent or deleted membership differs");
        BrowserSelectionAccess::publishMorphology(edits,job->baseline(),result);
        require(states(edits)==std::vector<uint8_t>({1,1,0,1,0,1,2})&&edits.revision()==revision+1&&edits.contentRevision()==content,
            "Volume crossed another original boundary or changed content");
        job.reset();require(edits.undo()&&states(edits)==before,"Volume Undo lost original states");
        require(edits.redo()&&states(edits)==std::vector<uint8_t>({1,1,0,1,0,1,2}),"Volume Redo failed");
    }
    {
        ++cases;++volumeCases;ResourceBudget resources(1000000);auto scene=fixture(6);
        for(size_t i=0;i<6;++i)scene->gaussians[i].positionOpacity[0]=float(i)*.75f;
        SceneEdits edits(scene,sceneMemoryForBudget(resources,ResourceCategory::History));
        for(size_t i=0;i<3;++i)edits.selectSingle(uint32_t(i),SelectOperation::Add);
        auto job=BrowserMorphologyJob::create(edits,false,1,sceneMemoryForBudget(resources,ResourceCategory::Work),{},volume);finish(*job);
        require(job->result().size()==1&&job->result()[0].index==2&&job->result()[0].value==0,"Volume Shrink removed more than its original boundary");
    }
    {
        ++cases;++volumeCases;ResourceBudget resources(1000000);SceneEdits edits(fixture(),sceneMemoryForBudget(resources,ResourceCategory::History));
        edits.selectSingle(0,SelectOperation::Set);const auto before=states(edits);
        auto job=BrowserMorphologyJob::create(edits,true,2,sceneMemoryForBudget(resources,ResourceCategory::Work),{},volume);
        job->step(7);job->cancel();require(job->result().empty()&&states(edits)==before,"Cancelled Volume exposed partial results");
    }
    {
        ++cases;++volumeCases;const auto input=gaussianInput();require(nativeOpen(input).ok,"Actual Volume source failed");
        nativeCommand(R"({"command":"single","index":0,"operation":0})");
        const auto before=nativeStates(),scene=nativeScene(),packed=nativePacked();const auto revision=nativeSummary();
        nativeCommand(R"({"command":"beginTransaction"})");
        const auto grown=finishNative(nativeCommand(R"({"command":"morphology","mode":"grow","method":"volume","distance":1.9})"),1);
        require(grown.ok&&grown.selected==2&&nativeStates()==Bytes({1,1,0,0,0})&&grown.revision==revision.revision+1&&grown.contentRevision==revision.contentRevision,
            "Actual Volume dispatch differs from the independent sphere boundary");
        require(nativeScene()==scene&&nativePacked()==packed,"Volume mutated Gaussian/SH bytes");
        nativeCommand(R"({"command":"rollbackTransaction"})");require(nativeStates()==before,"Volume rollback lost original mask");
        require(nativeCommand(R"({"command":"single","index":4,"operation":0})").ok,"Redo fixture failed");nativeCommand(R"({"command":"undo"})");
        const auto redo=nativeSummary();
        const std::array<const char *,10> invalid{
            R"({"command":"morphology","mode":"grow","method":"volume","distance":0})",
            R"({"command":"morphology","mode":"grow","method":"volume","distance":-1})",
            R"({"command":"morphology","mode":"grow","method":"volume","distance":1e100})",
            R"({"command":"morphology","mode":"grow","method":"volume","distance":1e-100})",
            R"({"command":"morphology","mode":"grow","method":"volume","distance":true})",
            R"({"command":"morphology","mode":"grow","method":"volume","distance":1,"sigma":1})",
            R"({"command":"morphology","mode":"grow","method":"volume"})",
            R"({"command":"morphology","mode":"grow","method":"sigma","distance":1})",
            R"({"command":"morphology","mode":"grow","method":"other","sigma":1})",
            R"({"command":"morphology","mode":"grow","distance":1})"};
        for(const auto request:invalid) {require(!nativeCommand(request).ok,"Malformed Volume grammar accepted");require(nativeStates()==before&&nativeSummary().revision==redo.revision&&nativeSummary().canRedo,"Volume refusal changed baseline/Redo");}
        require(nativeCommand(R"({"command":"redo"})").selected==1&&nativeStates()==Bytes({0,0,0,0,1}),"Volume refusal destroyed executable Redo");
    }
}
void rangeContracts() {
    using RangeJob=browser_morphology_range::Job;
    const auto scene=fixture(20);
    for(size_t i=0;i<20;++i) {
        auto &g=scene->gaussians[i];g.positionOpacity={float(i),0,0,0};const float radius=float(i+1);
        g.covA={radius*radius,0,0,radius*radius};g.covB={0,radius*radius,0,0};
    }
    for(const auto batch:{size_t(1),size_t(17),size_t(65536)}) {
        ++cases;++rangeCases;ResourceBudget resources(1000000);const auto before=sv_allocation::snapshot();
        {
            sv_allocation::Scope scope;auto job=RangeJob::create(scene,sceneMemoryForBudget(resources,ResourceCategory::Work));
            require(resources.usage().totalBytes==sizeof(RangeJob)+36*20,"Range did not admit exactly its owner and POD scratch");
            size_t guard=0;while(!job->complete()) {require(job->step(batch)<=batch,"Range exceeded its work budget");require(++guard<10000,"Range never finished");}
            const auto result=job->result();
            require(result&&result->minimum==1&&result->maximum==18&&result->initial==float(std::sqrt(18.)),
                "Range differs from independent lower-nearest-rank median/5th/95th quantiles or omitted transparent members");
        }
        require(resources.usage().totalBytes==0&&sameCensus(before,sv_allocation::snapshot()),"Range retirement leaked admitted scratch/census");
    }
    require(RangeJob::scratchBytes(1000000)<=browser_morphology_range::maximumScratchBytes,"Range scratch exceeds its sample cap");
    for(const auto target:{0.,.2,.7,.8}) {
        ++cases;++rangeCases;ResourceBudget resources(1000000);auto job=RangeJob::create(scene,sceneMemoryForBudget(resources,ResourceCategory::Work));
        size_t guard=0;while(job->progress()<target) {job->step(1);require(++guard<10000,"Range cancellation stage unreachable");}
        job->cancel();require(!job->result()&&job->step(100)==0,"Cancelled range exposed a candidate or resumed");
        job.reset();require(resources.usage().totalBytes==0,"Cancelled range retained scratch");
    }
    for(size_t ordinal=1;ordinal<=3;++ordinal) {
        ++cases;++rangeCases;++rangeRefusals;ResourceBudget resources(1000000);
        auto memory=std::make_shared<DenyMemory>(sceneMemoryForBudget(resources,ResourceCategory::Work));memory->arm(ordinal);
        rejects([&]{auto job=RangeJob::create(scene,memory);});require(memory->calls==ordinal&&resources.usage().totalBytes==0,"Range admission refusal leaked scratch");
    }
    {
        ++cases;++rangeCases;ResourceBudget resources(1000000);browser_morphology_range::Cache cache;
        auto one=fixture();std::weak_ptr<const Scene> weak=one;cache.publish(one,{1,2,float(std::sqrt(2.))});one.reset();
        require(weak.expired()&&!cache.get(scene),"Range cache retained a Scene payload or reused another geometry");
    }
    {
        ++cases;++rangeCases;require(nativeOpen(gaussianInput()).ok,"Range actual source failed");
        nativeCommand(R"({"command":"single","index":0,"operation":0})");nativeCommand(R"({"command":"single","index":4,"operation":0})");nativeCommand(R"({"command":"undo"})");
        const auto original=nativeStates(),geometry=nativeScene();const auto before=nativeSummary();const auto census=sv_allocation::snapshot();
        const auto initial=Json::parse(sv_command(R"({"command":"summary"})"));require(initial.at("morphologyRange").is_null(),"Summary computed a range implicitly");
        require(nativeCommand(R"({"command":"morphologyRange"})").pending,"Range was not cooperative");
        require(nativeSummary().pending&&nativeStates()==original&&nativeSummary().revision==before.revision,"Pending range changed history/mask");
        finishNative(nativeSummary(),1);const auto completed=Json::parse(sv_command(R"({"command":"summary"})"));
        const auto result=completed.at("morphologyRange");
        require(result.at("version")==1&&result.at("minimum")==1&&result.at("maximum")==double(float(2*3.8f)),"Actual range metadata differs from source geometry");
        require(nativeScene()==geometry&&nativeStates()==original&&nativeSummary().revision==before.revision&&nativeSummary().contentRevision==before.contentRevision&&nativeSummary().canRedo,
            "Readonly range changed geometry/mask/history/Redo");
        require(sameCensus(census,sv_allocation::snapshot()),"Completed range retained scratch/scene owners");
        require(!nativeCommand(R"({"command":"morphologyRange"})").pending,"Cached current range launched work");
        nativeCommand(R"({"command":"selectAll"})");require(Json::parse(sv_command(R"({"command":"summary"})")).at("morphologyRange")==result,"Selection-only history invalidated geometry range");
        require(nativeOpen(gaussianInput()).ok&&Json::parse(sv_command(R"({"command":"summary"})")).at("morphologyRange").is_null(),"New source reused old range");
        require(nativeCommand(R"({"command":"morphologyRange"})").pending,"Range cancellation setup failed");sv_step(7);
        require(nativeCommand(R"({"command":"cancel"})").ok&&!nativeSummary().pending&&Json::parse(sv_command(R"({"command":"summary"})")).at("morphologyRange").is_null(),"Cancelled query cached incomplete range");
        require(nativeOpen(gaussianInput()).ok,"Range publication-refusal source failed");sv_response::refuseNextSummaryForContracts();
        require(!nativeCommand(R"({"command":"morphologyRange"})").ok&&!nativeSummary().pending,"Failed range dispatch installed a job");++rangeRefusals;
        const auto refusedStates=nativeStates(),refusedGeometry=nativeScene();const auto refusedSummary=nativeSummary();
        require(nativeCommand(R"({"command":"morphologyRange"})").pending,"Range terminal-refusal setup failed");
        sv_response::refuseNextSummaryForContracts();require(!parsedSummary(sv_step(65536)).ok,"Range terminal summary refusal was bypassed");++rangeRefusals;
        require(!nativeSummary().pending&&nativeStates()==refusedStates&&nativeScene()==refusedGeometry&&nativeSummary().revision==refusedSummary.revision&&
            Json::parse(sv_command(R"({"command":"summary"})")).at("morphologyRange").is_null(),"Refused terminal range published metadata or changed the scene");
        require(nativeCommand(R"({"command":"beginColor","selectedOnly":false})").ok,"Retained clean-color range fixture failed");
        const auto color=Json::parse(sv_command(R"({"command":"summary"})")).at("colorSession");
        finishNative(nativeCommand(R"({"command":"morphologyRange"})"));
        require(Json::parse(sv_command(R"({"command":"summary"})")).at("colorSession")==color,"Readonly range retired the clean color owner");
        require(nativeCommand(R"({"command":"endColor"})").ok,"Clean color retirement failed");
        require(nativeOpen(gaussianInput()).ok,"Alignment Reset range fixture failed");
        const auto initialView=Json::parse(sv_command(R"({"command":"summary"})")).at("camera");
        const auto center=Json{{"command","alignCenter"},{"point",{0,0,0}},{"camera",initialView},{"defaultCamera",initialView}}.dump();
        finishNative(nativeCommand(center.c_str()));
        require(Json::parse(sv_command(R"({"command":"summary"})")).at("alignment").at("canReset")==true,"Center Reset baseline fixture failed");
        finishNative(nativeCommand(R"({"command":"morphologyRange"})"));
        require(Json::parse(sv_command(R"({"command":"summary"})")).at("alignment").at("canReset")==true,"Readonly range retired the Alignment Reset baseline");
    }
}
}
int main() {
    if(ownershipContracts()) return 1;
    try {
        nativeBoundaryContracts();
        volumeContracts();rangeContracts();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final morphology census is invalid");
        std::printf("SPLATVIEW_MORPHOLOGY_CONTRACTS_PASS cases=%zu assertions=%zu ownerBytes=%zu volumeCases=%zu rangeCases=%zu rangeRefusals=%zu rangeOwnerBytes=%zu rangeScratchBound=%zu\n",cases,checks,sizeof(BrowserMorphologyJob),volumeCases,rangeCases,rangeRefusals,sizeof(browser_morphology_range::Job),browser_morphology_range::maximumScratchBytes);
        return 0;
    } catch(const std::exception &error) {
        std::fprintf(stderr,"morphology native contract failed after %zu assertions: %s\n",checks,error.what());
        return 1;
    }
}
