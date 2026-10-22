#include "live_selection.hpp"
#include <algorithm>
#include <array>
#include <iostream>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace preview;
using Json=nlohmann::json;
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
template<class Error,class Action> void rejects(Action action,const char *message) {
    try { action(); }
    catch(const Error &) { return; }
    throw std::runtime_error(message);
}
struct State {
    const uint8_t *pointer{},*baselinePointer{};
    std::vector<uint8_t> bytes,baseline;
    std::shared_ptr<const Scene> scene;
    size_t selected{},visible{};
    uint64_t revision{},content{};
    bool undo{},redo{},draft{};
    explicit State(const SceneEdits &edits)
        : pointer(edits.states().data()),baselinePointer(edits.selectionBaseline().data()),
          bytes(edits.states().begin(),edits.states().end()),
          baseline(edits.selectionBaseline().begin(),edits.selectionBaseline().end()),scene(edits.scene()),
          selected(edits.selectedCount()),visible(edits.visibleCount()),revision(edits.revision()),
          content(edits.contentRevision()),undo(edits.canUndo()),redo(edits.canRedo()),draft(edits.selectionDraft()) {}
    void unchanged(const SceneEdits &edits) const {
        require(pointer==edits.states().data() && baselinePointer==edits.selectionBaseline().data() &&
            bytes==std::vector<uint8_t>(edits.states().begin(),edits.states().end()) &&
            baseline==std::vector<uint8_t>(edits.selectionBaseline().begin(),edits.selectionBaseline().end()) &&
            scene==edits.scene() && selected==edits.selectedCount() && visible==edits.visibleCount() &&
            revision==edits.revision() && content==edits.contentRevision() && undo==edits.canUndo() &&
            redo==edits.canRedo() && draft==edits.selectionDraft(),
            "A rejected live candidate changed native owner, mask, baseline, history or revision");
    }
};
enum class Fault { None, Computation, Generic, Allocation, Budget, Identity };
void fail(Fault fault) {
    switch(fault) {
    case Fault::None: return;
    case Fault::Computation: throw BrowserSelectionComputationFailure();
    case Fault::Generic: throw std::runtime_error("Contract generic failure");
    case Fault::Allocation: throw std::bad_alloc();
    case Fault::Budget: throw ResourceBudgetExceeded(2,1);
    case Fault::Identity: throw ResourceIdentityConflict("Contract resource identity failure");
    }
}
struct Observations { size_t calls{},failAt{},live{},grants{}; Fault fault{}; };
struct Grant {
    ResourceReservation reservation;
    std::shared_ptr<Observations> observed;
    size_t bytes;
    Grant(ResourceReservation value,std::shared_ptr<Observations> state,size_t count)
        : reservation(std::move(value)),observed(std::move(state)),bytes(count) {
        observed->live+=bytes; ++observed->grants;
    }
    ~Grant() { observed->live-=bytes; --observed->grants; }
};
struct ObservedMemory final : SceneMemory {
    ResourceBudget budget;
    ResourceCategory category;
    std::shared_ptr<Observations> observed=std::make_shared<Observations>();
    ObservedMemory(ResourceBudget value,ResourceCategory purpose) : budget(std::move(value)),category(purpose) {}
    std::shared_ptr<void> admit(size_t bytes) override {
        ++observed->calls;
        if(observed->calls==observed->failAt) fail(observed->fault);
        return std::make_shared<Grant>(budget.reserve(category,bytes),observed,bytes);
    }
    void next(Fault fault) { observed->fault=fault; observed->failAt=observed->calls+1; }
};
std::shared_ptr<Scene> sceneFixture() {
    auto scene=std::make_shared<Scene>(); scene->yUp=true;
    for(float x:{-.5f,0.f,.5f}) {
        Attributes value; value.position={x,0,0}; value.scale={.03f,.03f,.03f};
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount=3; return scene;
}
void prepare(SceneEdits &edits) {
    require(edits.selectSingle(0,SelectOperation::Set) && edits.selectSingle(1,SelectOperation::Add) && edits.undo(),
        "Fixture requires an existing native Redo revision");
    edits.beginSelectionDraft();
    require(edits.canRedo() && edits.selectedCount()==1 && edits.selectionDraft(),"Fixture draft was not admitted");
}
struct Fixture {
    ResourceBudget budget{32*1024*1024};
    std::shared_ptr<ObservedMemory> history=std::make_shared<ObservedMemory>(budget,ResourceCategory::History);
    std::shared_ptr<ObservedMemory> work=std::make_shared<ObservedMemory>(budget,ResourceCategory::Work);
    SceneEdits edits{sceneFixture(),history,work};
    BrowserSelectionMap map{{1,1,64,64,64,64,3,11},edits,work};
    Fixture() {
        prepare(edits);
        std::fill(map.depths.begin(),map.depths.end(),4.f);
        std::fill(map.opacities.begin(),map.opacities.end(),1.f);
        map.visible[0]=uint32_t(1)<<2;
        map.receivedBytes=map.payloadBytes(); map.validateComplete();
    }
    BrowserLiveSelectionRequest admit(const Json &input) {
        return admitBrowserLiveSelection(input,edits,work,&map);
    }
};
Json input(const char *command,bool mapped=false) {
    Json value={{"command",command},{"fromBaseline",true},{"width",64},{"height",64},
        {"camera",{0,0,0,0,0,4,1,45,1,0}},{"operation",0},{"visibleOnly",mapped},{"overlap",false}};
    if(std::string(command)=="rectangle") value["rectangle"]={16,16,48,48};
    else if(std::string(command)=="polygon") value["points"]={{16,16},{48,16},{48,48},{16,48}};
    else { value["points"]={{32,32}}; value["radius"]=mapped ? 30 : 8; }
    if(mapped || std::string(command)=="volume") value["mapId"]=1;
    return value;
}
const std::array<Json,5> requests{
    input("rectangle"),input("polygon"),input("brush"),input("brush",true),input("volume",true)};

void actualSelectorsAndHistory() {
    const std::array<std::array<uint8_t,3>,5> expected{{{1,1,1},{1,1,1},{0,1,0},{0,0,1},{0,0,1}}};
    for(size_t i=0;i<requests.size();++i) {
        Fixture fixture; auto request=fixture.admit(requests[i]);
        const auto content=fixture.edits.contentRevision();
        require(browserLiveSelection(fixture.edits,request)==BrowserLiveSelectionOutcome::Published,
            "A real selector failed its typed publication");
        require(std::equal(expected[i].begin(),expected[i].end(),fixture.edits.states().begin()),
            "Live selection mask differs from the independent scene hit expectation");
        require(fixture.edits.selectionDraft() && fixture.edits.canRedo() &&
            fixture.edits.contentRevision()==content && fixture.edits.selectionBaseline()[0]==1 &&
            fixture.edits.selectionBaseline()[1]==0 && fixture.edits.selectionBaseline()[2]==0,
            "A live publication committed history or changed its original baseline");
        require(fixture.edits.confirmSelectionDraft() && !fixture.edits.canRedo(),
            "Confirm must record one real selection change and retire old Redo");
        require(fixture.edits.undo() && fixture.edits.selectedCount()==1 && fixture.edits.states()[0]==1,
            "One Undo must restore the original gesture baseline");
        require(fixture.edits.redo() && std::equal(expected[i].begin(),expected[i].end(),fixture.edits.states().begin()),
            "Redo must restore the confirmed live mask");
    }
}
void typedFailuresDiscardRealCandidates() {
    for(const bool afterAcceptedPreview:{false,true}) for(const auto &value:requests) {
        Fixture fixture; auto request=fixture.admit(value);
        if(afterAcceptedPreview) {
            auto previous=fixture.admit(input("brush"));
            require(browserLiveSelection(fixture.edits,previous)==BrowserLiveSelectionOutcome::Published &&
                fixture.edits.states()[0]==0 && fixture.edits.states()[1]==1 && fixture.edits.states()[2]==0 &&
                fixture.edits.selectionBaseline()[0]==1 && fixture.edits.selectionBaseline()[1]==0 &&
                fixture.edits.selectionBaseline()[2]==0 && fixture.edits.canRedo(),
                "Failure-after-preview fixture requires a published mask with its original baseline and Redo");
        }
        const State before(fixture.edits);
        const auto memory=fixture.budget.usage().totalBytes;
        const auto historyLive=fixture.history->observed->live,workLive=fixture.work->observed->live;
        const auto historyGrants=fixture.history->observed->grants,workGrants=fixture.work->observed->grants;
        bool evaluated=false,published=false;
        const auto outcome=browserLiveSelection(fixture.edits,request,
            [&](SceneEdits &candidate,const BrowserLiveSelectionRequest &admitted) {
                require(BrowserLiveSelectionEvaluator{}(candidate,admitted),"Fault seam must forward a real changing selector");
                evaluated=true;
                throw BrowserSelectionComputationFailure();
                return false;
            },[&](SceneEdits &,const SceneEdits &) { published=true; });
        require(outcome==BrowserLiveSelectionOutcome::ComputationFailed && evaluated && !published,
            "Only the typed evaluator failure may suppress native publication");
        before.unchanged(fixture.edits);
        require(fixture.budget.usage().totalBytes==memory && fixture.history->observed->live==historyLive &&
            fixture.work->observed->live==workLive && fixture.history->observed->grants==historyGrants &&
            fixture.work->observed->grants==workGrants,"A rejected disposable candidate leaked admitted storage");
        require(fixture.edits.cancelSelectionDraft()==afterAcceptedPreview && fixture.edits.redo() &&
            fixture.edits.states()[0]==1 && fixture.edits.states()[1]==1 && fixture.edits.states()[2]==0,
            "Typed failure must preserve the preexisting real Redo contents");
    }
}
void falseAndDegenerateRemainPublished() {
    for(const auto &value:std::array<Json,4>{
        []{auto v=input("polygon");v["points"]={{1,1},{2,2}};return v;}(),
        []{auto v=input("polygon");v["points"]={{1,1},{2,2},{3,3}};return v;}(),
        []{auto v=input("brush");v["points"]=Json::array();return v;}(),
        []{auto v=input("volume",true);v["points"]=Json::array();return v;}()}) {
        Fixture fixture;
        // A prior completed live preview differs from the gesture baseline.
        auto rectangle=fixture.admit(input("rectangle"));
        require(browserLiveSelection(fixture.edits,rectangle)==BrowserLiveSelectionOutcome::Published &&
            fixture.edits.selectedCount()==3,"Fixture requires a prior published live region");
        auto request=fixture.admit(value); bool returnedFalse=false;
        const auto outcome=browserLiveSelection(fixture.edits,request,
            [&](SceneEdits &candidate,const BrowserLiveSelectionRequest &admitted) {
                const bool result=BrowserLiveSelectionEvaluator{}(candidate,admitted);
                returnedFalse=!result; return result;
            });
        require(returnedFalse && outcome==BrowserLiveSelectionOutcome::Published && fixture.edits.selectedCount()==1 &&
            fixture.edits.states()[0]==1 && fixture.edits.canRedo() && fixture.edits.selectionDraft(),
            "A completed false/degenerate selector must publish its baseline result");
        require(!fixture.edits.confirmSelectionDraft() && fixture.edits.canRedo(),
            "Baseline-equivalent confirmation must retain old Redo without a new history item");
    }
    Fixture fixture;
    auto value=input("rectangle"); value["rectangle"]={20,20,24,44}; value["operation"]=1;
    auto request=fixture.admit(value); const State before(fixture.edits); bool returnedFalse=false;
    require(browserLiveSelection(fixture.edits,request,
        [&](SceneEdits &candidate,const BrowserLiveSelectionRequest &admitted) {
            const bool result=BrowserLiveSelectionEvaluator{}(candidate,admitted); returnedFalse=!result; return result;
        })==BrowserLiveSelectionOutcome::Published && returnedFalse,"An unchanged real selector must remain published");
    before.unchanged(fixture.edits);
}
template<class Error> void evaluatorFailure(Fault fault) {
    for(const auto &value:requests) {
        Fixture fixture; auto request=fixture.admit(value);
        const State before(fixture.edits); const auto memory=fixture.budget.usage().totalBytes;
        bool published=false;
        rejects<Error>([&] {
            browserLiveSelection(fixture.edits,request,
                [&](SceneEdits &candidate,const BrowserLiveSelectionRequest &admitted) {
                    BrowserLiveSelectionEvaluator{}(candidate,admitted); fail(fault); return false;
                },[&](SceneEdits &,const SceneEdits &) { published=true; });
        },"An ordinary evaluator exception was relabeled as computation failure");
        require(!published,"An ordinary evaluator failure reached publication"); before.unchanged(fixture.edits);
        require(fixture.budget.usage().totalBytes==memory,"An evaluator exception leaked admitted candidate storage");
    }
}
void nonComputationErrorsStayFatal() {
    evaluatorFailure<std::runtime_error>(Fault::Generic);
    evaluatorFailure<std::bad_alloc>(Fault::Allocation);
    evaluatorFailure<ResourceBudgetExceeded>(Fault::Budget);
    evaluatorFailure<ResourceIdentityConflict>(Fault::Identity);
}
template<class Error> void candidateAdmissionFailure(Fault fault) {
    Fixture fixture; auto request=fixture.admit(input("polygon"));
    const State before(fixture.edits); const auto memory=fixture.budget.usage().totalBytes;
    fixture.history->next(fault); bool evaluated=false;
    rejects<Error>([&] {
        browserLiveSelection(fixture.edits,request,
            [&](SceneEdits &,const BrowserLiveSelectionRequest &) { evaluated=true; return false; });
    },"Candidate admission was incorrectly inside the computation catch");
    require(!evaluated,"Failed candidate admission reached the evaluator"); before.unchanged(fixture.edits);
    require(fixture.budget.usage().totalBytes==memory,"Candidate admission failure leaked admitted storage");
}
template<class Error> void publicationFailure(Fault fault) {
    Fixture fixture; auto request=fixture.admit(input("polygon"));
    const State before(fixture.edits); const auto memory=fixture.budget.usage().totalBytes;
    bool evaluated=false;
    rejects<Error>([&] {
        browserLiveSelection(fixture.edits,request,
            [&](SceneEdits &candidate,const BrowserLiveSelectionRequest &admitted) {
                evaluated=true; return BrowserLiveSelectionEvaluator{}(candidate,admitted);
            },[&](SceneEdits &edits,const SceneEdits &candidate) {
                fixture.history->next(fault); BrowserLiveSelectionPublisher{}(edits,candidate);
            });
    },"Publication admission was incorrectly inside the computation catch");
    require(evaluated,"Publication fault must follow the real selector"); before.unchanged(fixture.edits);
    require(fixture.budget.usage().totalBytes==memory,"Publication admission failure leaked candidate storage");
}
void catchHasExactScope() {
    candidateAdmissionFailure<BrowserSelectionComputationFailure>(Fault::Computation);
    candidateAdmissionFailure<std::bad_alloc>(Fault::Allocation);
    candidateAdmissionFailure<ResourceBudgetExceeded>(Fault::Budget);
    publicationFailure<BrowserSelectionComputationFailure>(Fault::Computation);
    publicationFailure<std::bad_alloc>(Fault::Allocation);
    publicationFailure<ResourceBudgetExceeded>(Fault::Budget);
    publicationFailure<ResourceIdentityConflict>(Fault::Identity);
}
void admissionValidationAndSamplingStayFatal() {
    Fixture fixture; const State before(fixture.edits);
    std::vector<Json> invalid;
    auto change=[&](const char *key,Json value) { auto v=input("polygon");v[key]=std::move(value);invalid.push_back(std::move(v)); };
    change("command","delete"); change("fromBaseline",false); change("width",0); change("height",-1);
    change("width",1.5); change("camera",{0,0,0,0,0,0,1,45,1,0});
    change("camera",{0,0,0,0,0,4,1,121,1,0}); change("camera",{0,0});
    change("operation",-1); change("operation",4); change("operation",.5);
    change("points",{{1,2,3}}); change("points",{{1.5,2}}); change("points",{{2147483648ULL,2}});
    change("visibleOnly",true);
    auto v=input("rectangle");v["rectangle"]={1,2,3};invalid.push_back(v);
    v=input("brush");v["radius"]=4097;invalid.push_back(v);
    v=input("volume",true);v["radius"]=0;invalid.push_back(v);
    v=input("brush",true);v["mapId"]=2;invalid.push_back(v);
    v=input("volume",true);v["width"]=63;invalid.push_back(v);
    v=input("polygon");v["points"]=Json::array();for(unsigned i=0;i<4097;++i)v["points"].push_back({0,0});invalid.push_back(v);
    for(const auto &value:invalid) {
        rejects<std::exception>([&]{fixture.admit(value);},"Invalid live request was admitted"); before.unchanged(fixture.edits);
    }
    // Real portable volume sampling rejects excessive work before candidate
    // evaluation. This error must remain the native sample-budget error.
    v=input("volume",true);v["points"]={{0,0},{2147483647,2147483647}};
    rejects<std::runtime_error>([&]{fixture.admit(v);},"Volume sampling admission must reject excessive work");
    before.unchanged(fixture.edits);
    fixture.work->next(Fault::Computation);
    rejects<BrowserSelectionComputationFailure>([&]{fixture.admit(input("polygon"));},
        "Path admission must not classify even a dedicated-type exception as computation failure");
    before.unchanged(fixture.edits);
    fixture.edits.cancelSelectionDraft();
    rejects<std::runtime_error>([&]{fixture.admit(input("polygon"));},"A live request requires an active native draft");
}
} // namespace
int main() {
    try {
        actualSelectorsAndHistory();
        typedFailuresDiscardRealCandidates();
        falseAndDegenerateRemainPublished();
        nonComputationErrorsStayFatal();
        catchHasExactScope();
        admissionValidationAndSamplingStayFatal();
        std::cout << "Live selection contracts passed: real Rectangle/Polygon/analytic Brush/map Brush/Volume, "
            "typed candidate discard, unchanged/degenerate publication, exact catch scope, "
            "admission/publication errors, baseline/Redo/revisions and admitted-storage release.\n";
        return 0;
    } catch(const std::exception &error) {
        std::cerr << "Live selection contracts failed: " << error.what() << '\n'; return 1;
    }
}
