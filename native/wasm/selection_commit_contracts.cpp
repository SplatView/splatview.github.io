// Private direct-core and actual browser ABI proof. Counter fault access exists
// only in this executable; no hook, mask copy or durable field is shipped.
#include "selection_checkpoint.hpp"
#include "browser_duplicate.hpp"
#include "browser_document_checkpoint.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "model.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace preview {
struct HistoryAdmissionTestAccess {
    static void counter(SceneEdits &edits,uint64_t value) { edits.selectionCommitRevision_=value; }
    static void revision(SceneEdits &edits,uint64_t value) { edits.revision_=value; }
    static void failAppend(SceneEdits &edits,bool fail) {
        edits.historyCheckpoint_=fail ? +[](void *,std::string_view seam) {
            if(seam=="history.append" || seam=="draft.append" || seam=="undo.append" || seam=="redo.append")
                throw std::bad_alloc();
        } : nullptr;
    }
};
}
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const char *sv_recovery_prepare();const uint8_t *sv_recovery_read(unsigned,unsigned);
unsigned sv_recovery_read_size();void sv_recovery_release();
const char *sv_recovery_restore_begin(unsigned,unsigned,unsigned,const char *);
const char *sv_recovery_restore_write(unsigned,const uint8_t *,unsigned);
const char *sv_recovery_restore_finish();void sv_recovery_restore_cancel();
}
namespace {
using namespace preview;using Json=nlohmann::json;using Bytes=std::vector<uint8_t>;
constexpr uint64_t maximum=9007199254740991ULL;
constexpr unsigned allowance=64*1024*1024;
size_t groups{},checks{},refusals{},historyRefusals{},backendRefusals{},stampGroups{};
uint64_t toleranceId{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void test(const char *name,F action){action();++groups;std::printf("SELECTION_COMMIT_GROUP_PASS %s\n",name);}
template<class F>void rejects(F action,const char *message){bool failed=false;try{action();}catch(const std::exception &){failed=true;}require(failed,message);++refusals;}
std::shared_ptr<Scene> scene(size_t count=4){
    auto out=std::make_shared<Scene>();out->sourceCount=count;out->radius=1;out->format="selection-commit-contract";out->gaussians.resize(count);
    for(size_t i=0;i<count;++i){auto &g=out->gaussians[i];g.positionOpacity={float(i),0,0,.5f};g.covA={.01f,0,0,.01f};g.covB={0,.01f,0,0};}
    return out;
}
struct Memory final:SceneMemory {
    std::shared_ptr<void> admit(size_t bytes) override { return std::make_shared<size_t>(bytes); }
};
struct Snapshot {
    std::shared_ptr<const Scene> source;MaskStorage mask;Bytes bytes;uint64_t revision{},content{},next{},selection{},stamp{};
    size_t undo{},redo{},selected{},visible{};bool draft{};
    explicit Snapshot(const SceneEdits &edits):source(edits.scene()),mask(edits.maskSnapshot()),bytes(edits.states().begin(),edits.states().end()),
        revision(edits.revision()),content(edits.contentRevision()),next(BrowserSelectionAccess::recoveryNextContent(edits)),selection(edits.selectionCommitRevision()),stamp(edits.undoSelectionRevision()),
        undo(BrowserSelectionAccess::recoveryUndo(edits).size()),redo(BrowserSelectionAccess::recoveryRedo(edits).size()),selected(edits.selectedCount()),visible(edits.visibleCount()),draft(edits.selectionDraft()){}
    void unchanged(const SceneEdits &edits) const {
        require(edits.scene()==source&&edits.states().data()==mask.data()&&Bytes(edits.states().begin(),edits.states().end())==bytes&&
            edits.revision()==revision&&edits.contentRevision()==content&&BrowserSelectionAccess::recoveryNextContent(edits)==next&&
            edits.selectionCommitRevision()==selection&&edits.undoSelectionRevision()==stamp&&BrowserSelectionAccess::recoveryUndo(edits).size()==undo&&
            BrowserSelectionAccess::recoveryRedo(edits).size()==redo&&edits.selectedCount()==selected&&edits.visibleCount()==visible&&edits.selectionDraft()==draft,
            "Refusal changed scene/mask/history/revision or committed-selection notification");
    }
};
void sparseDraftAndCleanup(){
    SceneEdits edits(scene());require(edits.selectionCommitRevision()==0,"New edits counter was not zero");
    edits.selectSingle(0,SelectOperation::Set);require(edits.selectionCommitRevision()==1,"First selection did not notify");
    edits.selectSingle(1,SelectOperation::Set);require(edits.selectedCount()==1&&edits.selectionCommitRevision()==2,"Equal-count replacement did not notify");
    require(!edits.selectSingle(1,SelectOperation::Set)&&edits.selectionCommitRevision()==2,"Selection no-op notified");
    edits.beginSelectionDraft();edits.selectSingle(2,SelectOperation::Set);edits.selectSingle(3,SelectOperation::Add);
    require(edits.selectionCommitRevision()==2,"Draft preview notified a committed change");
    edits.cancelSelectionDraft();require(edits.selectionCommitRevision()==2&&edits.states()[1]==1,"Draft cancellation notified or lost baseline");
    edits.beginSelectionDraft();edits.selectSingle(2,SelectOperation::Set);edits.confirmSelectionDraft();
    require(edits.selectionCommitRevision()==3,"Draft confirmation did not notify exactly once");
    edits.beginSelectionDraft();edits.selectSingle(0,SelectOperation::Set);edits.deleteSelected();
    require(edits.selectionCommitRevision()==5&&edits.states()[0]==2,"Implicit confirmation and deletion did not notify twice");
    edits.restoreDeleted();require(edits.selectionCommitRevision()==5,"Deleted-to-unselected restore notified selection");
    edits.selectSingle(1,SelectOperation::Set);edits.keepSelected();require(edits.selectionCommitRevision()==6,"Content-only crop notified selection");
    edits.restoreDeleted();require(edits.selectionCommitRevision()==6,"Restore with identical selected bits notified");
    edits.beginSelectionDraft();edits.selectSingle(3,SelectOperation::Set);edits.resetCleanup();
    require(edits.selectionCommitRevision()==7&&edits.selectedCount()==0,"Reset committed a cancelled preview or failed to notify baseline clear");
    require(edits.undo()&&edits.selectionCommitRevision()==8&&edits.selectedCount()==1,"Sparse Undo did not notify");
    require(edits.redo()&&edits.selectionCommitRevision()==9&&edits.selectedCount()==0,"Sparse Redo did not notify");
    edits.beginSelectionDraft();edits.selectSingle(2,SelectOperation::Set);const auto before=edits.selectionCommitRevision();
    require(edits.undo()&&edits.selectionCommitRevision()==before,"Undo of draft notified a commit");
    edits.beginSelectionDraft();require(!edits.confirmSelectionDraft()&&edits.selectionCommitRevision()==before,"Empty draft confirmation notified");
}
void denseAndCandidates(){
    SceneEdits edits(scene());edits.selectSingle(0,SelectOperation::Set);const auto first=edits.selectionCommitRevision();
    auto changed=std::make_shared<Scene>(*edits.scene());changed->gaussians[0].positionOpacity[0]+=2;
    edits.replaceScene(changed,edits.states());require(edits.selectionCommitRevision()==first,"Content-only replacement notified");
    require(edits.undo()&&edits.selectionCommitRevision()==first&&edits.redo()&&edits.selectionCommitRevision()==first,"Content-only dense Undo/Redo notified");
    auto larger=scene(5);const std::array<uint8_t,5> largerMask{1,0,0,0,0};edits.replaceScene(larger,largerMask);
    require(edits.selectionCommitRevision()==first+1,"Unselected tail cardinality change did not notify desktop domain change");
    require(edits.undo()&&edits.selectionCommitRevision()==first+2&&edits.redo()&&edits.selectionCommitRevision()==first+3,"Dense cardinality Undo/Redo did not notify");
    const auto sameCount=std::make_shared<Scene>(*larger);const std::array<uint8_t,5> replaced{0,1,0,0,0};edits.replaceScene(sameCount,replaced);
    require(edits.selectionCommitRevision()==first+4&&edits.selectedCount()==1,"Equal-count dense membership change did not notify");
    require(edits.undo()&&edits.selectionCommitRevision()==first+5&&edits.redo()&&edits.selectionCommitRevision()==first+6,"Dense membership Undo/Redo did not notify");
    const auto expected=edits.selectionCommitRevision();auto candidate=BrowserSelectionAccess::selectionCandidate(edits,false);
    candidate.selectSingle(2,SelectOperation::Set);require(candidate.selectionCommitRevision()==expected,"Private draft candidate lost scalar or preview notified");
    auto checkpoint=BrowserSelectionAccess::capture(edits);auto amended=BrowserSelectionAccess::checkpointCandidate(edits,checkpoint);
    require(amended.selectionCommitRevision()==expected,"Tolerance candidate reset the notification");
    SceneEdits copied=edits;require(copied.selectionCommitRevision()==expected,"Transactional copy reset the notification");
    edits.beginSelectionDraft();edits.selectSingle(3,SelectOperation::Set);auto newScene=std::make_shared<Scene>(*edits.scene());
    const std::array<uint8_t,5> next{0,0,1,0,0};edits.replaceScene(newScene,next);
    require(edits.selectionCommitRevision()==expected+2,"Dense replacement failed combined implicit-draft two-event notification");
}
void adjustmentAndDuplicate(){
    SceneEdits edits(scene());auto checkpoint=BrowserSelectionAccess::capture(edits);const auto history=BrowserSelectionAccess::recoveryUndo(edits).size();
    const std::array<uint8_t,4> first{1,0,0,0},second{0,1,0,0},empty{};
    require(BrowserSelectionAccess::adjust(edits,checkpoint,first)&&edits.selectionCommitRevision()==1,"First tolerance adjustment did not notify once");
    require(BrowserSelectionAccess::adjust(edits,checkpoint,second)&&edits.selectionCommitRevision()==2,"Equal-count tolerance amendment did not notify once");
    require(!BrowserSelectionAccess::adjust(edits,checkpoint,second)&&edits.selectionCommitRevision()==2,"Unchanged tolerance amendment notified");
    require(BrowserSelectionAccess::recoveryUndo(edits).size()==history+1,"Tolerance amendments made multiple Undo entries");
    require(BrowserSelectionAccess::adjust(edits,checkpoint,empty)&&edits.selectionCommitRevision()==3&&
        BrowserSelectionAccess::recoveryUndo(edits).size()==history,"Tolerance baseline restore did not remove empty Undo or notify");
    edits.selectSingle(0,SelectOperation::Set);const auto before=edits.selectionCommitRevision();browser_duplicate::Lineage lineage;
    auto memory=std::make_shared<Memory>();browser_duplicate::Job job(edits,lineage,memory,memory);for(size_t i=0;job.status()==browser_duplicate::Status::Working;++i){require(i<1000,"Duplicate job stalled");job.step(2);}
    require(job.publish(edits,lineage)&&edits.selectionCommitRevision()==before+1,"Duplicate bypass publication did not notify once");
    require(edits.undo()&&edits.selectionCommitRevision()==before+2&&edits.redo()&&edits.selectionCommitRevision()==before+3,"Duplicate topology Undo/Redo did not notify");
}
void overflowAndHistoryRefusal(){
    SceneEdits edits(scene());edits.selectSingle(0,SelectOperation::Set);HistoryAdmissionTestAccess::counter(edits,maximum);
    {const Snapshot before(edits);rejects([&]{edits.selectSingle(1,SelectOperation::Set);},"Sparse overflow accepted");before.unchanged(edits);}
    edits.beginSelectionDraft();edits.selectSingle(1,SelectOperation::Set);
    {const Snapshot before(edits);rejects([&]{edits.confirmSelectionDraft();},"Draft overflow accepted");before.unchanged(edits);}
    edits.cancelSelectionDraft();HistoryAdmissionTestAccess::counter(edits,maximum-1);edits.beginSelectionDraft();edits.selectSingle(1,SelectOperation::Set);
    {const Snapshot before(edits);rejects([&]{edits.deleteSelected();},"Two-event overflow accepted");before.unchanged(edits);}
    edits.cancelSelectionDraft();HistoryAdmissionTestAccess::counter(edits,maximum);
    auto same=std::make_shared<Scene>(*edits.scene());same->gaussians[0].positionOpacity[0]+=1;
    edits.replaceScene(same,edits.states());require(edits.selectionCommitRevision()==maximum,"Counter maximum refused content-only edit");
    {const Snapshot before(edits);const std::array<uint8_t,4> different{0,1,0,0};rejects([&]{edits.replaceScene(scene(),different);},"Dense overflow accepted");before.unchanged(edits);}
    {const Snapshot before(edits);auto checkpoint=BrowserSelectionAccess::capture(edits);const std::array<uint8_t,4> different{0,1,0,0};
        rejects([&]{BrowserSelectionAccess::adjust(edits,checkpoint,different);},"Tolerance overflow accepted");before.unchanged(edits);require(!checkpoint.recorded,"Refused amendment changed checkpoint");}
    {const Snapshot before(edits);browser_duplicate::Lineage lineage;auto memory=std::make_shared<Memory>();rejects([&]{browser_duplicate::Job job(edits,lineage,memory,memory);while(job.status()==browser_duplicate::Status::Working)job.step(64);job.publish(edits,lineage);},"Duplicate overflow accepted");before.unchanged(edits);}
    HistoryAdmissionTestAccess::counter(edits,10);edits.selectSingle(1,SelectOperation::Set);HistoryAdmissionTestAccess::counter(edits,maximum);
    {const Snapshot before(edits);rejects([&]{edits.undo();},"Undo selection overflow accepted");before.unchanged(edits);}
    HistoryAdmissionTestAccess::counter(edits,10);edits.undo();HistoryAdmissionTestAccess::counter(edits,maximum);
    {const Snapshot before(edits);rejects([&]{edits.redo();},"Redo selection overflow accepted");before.unchanged(edits);}
    for(unsigned kind=0;kind<4;++kind){SceneEdits value(scene());value.selectSingle(0,SelectOperation::Set);value.selectSingle(1,SelectOperation::Add);value.undo();
        if(kind==1){value.beginSelectionDraft();value.selectSingle(2,SelectOperation::Set);}
        HistoryAdmissionTestAccess::failAppend(value,true);const Snapshot before(value);
        rejects([&]{if(kind==0)value.selectAll();else if(kind==1)value.confirmSelectionDraft();else if(kind==2)value.undo();else value.redo();},"History allocation seam did not refuse");
        before.unchanged(value);HistoryAdmissionTestAccess::failAppend(value,false);++historyRefusals;
    }
    sv_response::Summary invalid;invalid.selectionCommitRevision=1;require(!sv_response::validSummary(invalid),"Unloaded summary accepted nonzero counter");
    invalid.loaded=true;invalid.kind=1;require(!sv_response::validSummary(invalid),"Geometry summary accepted nonzero counter");
    invalid.kind=0;invalid.selectionCommitRevision=maximum+1;require(!sv_response::validSummary(invalid),"Unsafe JS counter serialized");
}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &request){const auto text=request.dump();return parsed(sv_command(text.c_str()));}
Json good(const Json &request){auto out=command(request);require(out.at("ok")==true,"Actual ABI fixture command refused");return out;}
Json summary(){return good({{"command","summary"}});}
uint64_t counter(){return summary().at("selectionCommitRevision").get<uint64_t>();}
Json finish(Json value){for(size_t i=0;value.value("pending",false);++i){require(i<10000,"Actual ABI job did not terminate");value=parsed(sv_step(3));if(value.at("ok")==false)break;}require(value.at("ok")==true,"Actual ABI job refused");return value;}
void open(){Bytes bytes(4*32);const std::array<float,4> x{0,100,.5f,200};for(size_t i=0;i<4;++i){const std::array<float,6> values{x[i],0,0,.1f,.1f,.1f};std::memcpy(bytes.data()+32*i,values.data(),24);
        const std::array<uint8_t,8> rest{uint8_t(30+i*60),uint8_t(40+i*50),uint8_t(60+i*40),128,255,128,128,128};std::memcpy(bytes.data()+32*i+24,rest.data(),8);}
    require(parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),1000,allowance)).at("ok")==true&&counter()==0,"New source did not reset scalar");}
Bytes mask(){const auto n=summary().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n};}
Json view(){return Json::array({0,0,0,0,0,5,1,60,1,0,1});}
Json camera(){auto out=view();out.erase(out.end()-1);return out;}
void actualSelectionAndRollback(){
    open();require(sv_abi_version()==24&&parsed(sv_build_identity()).at("capabilities").at("transformPivot")==2,"Capability/ABI mismatch");
    good({{"command","single"},{"index",0},{"operation",0}});good({{"command","single"},{"index",1},{"operation",0}});require(counter()==2&&summary().at("selected")==1,"ABI equal-count membership notification lost");
    good({{"command","beginSelection"}});good({{"command","single"},{"index",2},{"operation",0}});require(counter()==2,"ABI draft advanced counter");good({{"command","cancelSelection"}});require(counter()==2,"ABI cancellation advanced counter");
    good({{"command","beginSelection"}});good({{"command","single"},{"index",2},{"operation",0}});good({{"command","confirmSelection"}});require(counter()==3,"ABI confirm did not notify");
    good({{"command","beginTransaction"}});good({{"command","selectAll"}});require(counter()==4,"Transactional candidate did not preserve notification");
    good({{"command","rollbackTransaction"}});require(counter()==3&&mask()==Bytes({0,0,1,0}),"Rollback did not restore exact counter/mask");
    good({{"command","beginTransaction"}});good({{"command","selectAll"}});good({{"command","commitTransaction"}});require(counter()==4,"Commit altered or reset staged notification");
    good({{"command","clipSelection"},{"selectionView",view()}});require(counter()==5&&mask()==Bytes({1,0,1,0}),"Current-view clip did not notify");
    const auto before=counter();const auto owner=good({{"command","beginOpacity"},{"selectedOnly",true},{"selectionView",view()}}).at("opacitySession");
    require(counter()==before,"Effective target capture notified canonical selection");
    finish(good({{"command","applyOpacity"},{"id",owner.at("id")},{"epoch",1},{"scale",.5}}));require(counter()==before,"Content-only opacity notified selection");
    good({{"command","endOpacity"},{"id",owner.at("id")}});
    const auto duplicate=finish(good({{"command","duplicate"}}));require(duplicate.at("selectionCommitRevision")==before+1&&duplicate.at("undoSelectionRevision")==0,"Actual Duplicate did not notify or was stamped as selection-only history");
    good({{"command","undo"}});require(counter()==before+2,"Actual Duplicate Undo did not notify");good({{"command","redo"}});require(counter()==before+3,"Actual Duplicate Redo did not notify");
}
void actualToleranceAndRecovery(){
    open();const auto id=++toleranceId;good({{"command","colorPick"},{"camera",camera()},{"index",0},{"operation",0},{"tolerance",0},{"sessionId",id}});
    const auto first=counter();require(first==1&&summary().at("selected")==1,"Actual Color first amendment did not notify");
    good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1}});require(counter()==first+1&&summary().at("selected")==4,"Actual Color amendment did not notify once");
    good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1}});require(counter()==first+1,"Unchanged actual Color amendment notified");
    good({{"command","endTolerance"},{"sessionId",id}});good({{"command","undo"}});require(counter()==first+2&&summary().at("selected")==0&&!summary().at("canUndo").get<bool>(),"Color amendments did not remain one Undo");
    good({{"command","redo"}});const auto before=summary();require(before.at("undoSelectionRevision").get<uint64_t>()>0,"Recovery fixture has no stamped history");const auto oldMask=mask();const auto plan=parsed(sv_recovery_prepare());require(plan.at("ok")==true&&!plan.contains("selectionCommitRevision")&&!plan.contains("undoSelectionRevision"),"Runtime selection metadata leaked into durable plan");
    Bytes bytes;for(unsigned at=0,total=plan.at("byteLength").get<unsigned>();at<total;){const auto n=std::min(257u,total-at);const auto *p=sv_recovery_read(at,n);require(p&&sv_recovery_read_size()==n,"Recovery read failed");bytes.insert(bytes.end(),p,p+n);at+=n;}sv_recovery_release();
    const Json expected{{"codecVersion",3},{"currentLoadedCount",plan.at("currentLoadedCount")},{"currentSourceCount",plan.at("currentSourceCount")},
        {"currentDuplicateRange",plan.at("currentDuplicateRange")},{"maximumGraphSplats",plan.at("maximumGraphSplats")},{"originalSourceCount",4},
        {"revision",plan.at("revision")},{"contentRevision",plan.at("contentRevision")},{"nextContentRevision",plan.at("nextContentRevision")}};
    const auto text=expected.dump();require(parsed(sv_recovery_restore_begin(unsigned(bytes.size()),expected.at("maximumGraphSplats").get<unsigned>(),allowance,text.c_str())).at("ok")==true,"Recovery begin failed");
    require(parsed(sv_recovery_restore_write(0,bytes.data(),unsigned(bytes.size()))).at("ok")==true,"Recovery write failed");
    const auto result=parsed(sv_recovery_restore_finish());require(result.at("ok")==true&&result.at("selectionCommitRevision")==0&&result.at("undoSelectionRevision")==0&&result.at("canUndo")==true&&mask()==oldMask&&result.at("revision")==before.at("revision")&&result.at("contentRevision")==before.at("contentRevision"),"Fresh worker recovery did not reset runtime stamps while preserving history");
    good({{"command","undo"}});require(counter()==1&&summary().at("selected")==0,"Restored Undo did not start new notification lifetime");
    require(good({{"command","redo"}}).at("undoSelectionRevision")==0,"Redo restamped recovered history into the current tool session");
    const auto sessionStart=summary().at("revision").get<uint64_t>();const auto created=good({{"command","single"},{"index",0},{"operation",0}});
    require(created.at("undoSelectionRevision")==created.at("revision")&&created.at("undoSelectionRevision").get<uint64_t>()>sessionStart,"Fresh post-recovery selection did not enter the new session");
}
void actualEffectiveScope(){
    open();good({{"command","selectAll"}});require(counter()==1,"Scoped fixture did not start selected");
    const auto owner=good({{"command","beginOpacity"},{"selectedOnly",true},{"selectionView",view()}}).at("opacitySession");
    require(counter()==1&&summary().at("selected")==4&&mask()==Bytes({1,1,1,1}),"Effective target capture changed committed selection");
    finish(good({{"command","applyOpacity"},{"id",owner.at("id")},{"epoch",1},{"scale",.5}}));
    require(counter()==2&&mask()==Bytes({1,0,1,0}),"Atomic content-and-clip publication did not notify exactly once");
    finish(good({{"command","applyOpacity"},{"id",owner.at("id")},{"epoch",2},{"scale",.75}}));
    require(counter()==2&&mask()==Bytes({1,0,1,0}),"Further content-only retained bake notified selection");
    finish(good({{"command","resetOpacity"},{"id",owner.at("id")},{"epoch",3}}));
    require(counter()==3&&mask()==Bytes({1,1,1,1}),"Retained reset restoring canonical mask did not notify");
    good({{"command","endOpacity"},{"id",owner.at("id")}});
}
void actualRefusals(){
    open();good({{"command","selectAll"}});const auto before=summary();const auto oldMask=mask();
    const auto unchanged=[&]{const auto now=summary();for(const char *key:{"count","selected","visible","revision","contentRevision","selectionCommitRevision","undoSelectionRevision","canUndo","canRedo","transaction","selectionDraft"})require(now.at(key)==before.at(key),"Actual refusal changed authoritative scalar/history");require(mask()==oldMask,"Actual refusal changed mask");};
    for(const auto &request:std::vector<Json>{{{"command","clipSelection"},{"selectionView",Json::array({1,2})}},{{"command","transformFocus"},{"scope","selection"},{"revision",before.at("revision")},{"contentRevision",before.at("contentRevision")},{"transformBase",nullptr},{"selectionCommitRevision",0}}}) {
        require(command(request).at("ok")==false,"Malformed actual request accepted");unchanged();++refusals;
    }
    sv_response::refuseNextSummaryForContracts();require(command({{"command","clipSelection"},{"selectionView",view()}}).at("ok")==false,"Response refusal ignored");unchanged();++refusals;
    bool reached=false;for(size_t ordinal=1;ordinal<100;++ordinal){const auto request=Json{{"command","clipSelection"},{"selectionView",view()}}.dump();sv_allocation::failBackendAtForContracts(ordinal);
        const auto *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
        if(value.at("ok")==true){require(counter()==before.at("selectionCommitRevision").get<uint64_t>()+1,"Successful admission advanced wrong counter");reached=true;break;}
        unchanged();++backendRefusals;
    }
    require(reached&&backendRefusals>0,"Actual allocation sweep did not cover both refusal and success");
}
struct UnstampedRevisionLayout {
    AdmittedVector<BrowserSelectionAccess::RecoveryChange> changes;
    std::shared_ptr<const Scene> before,after;MaskStorage beforeStates,afterStates;
    uint64_t beforeContent{},afterContent{};
};
static_assert(sizeof(BrowserSelectionAccess::RecoveryRevision)==sizeof(UnstampedRevisionLayout)+sizeof(uint64_t));
static_assert(std::is_nothrow_move_constructible_v<BrowserSelectionAccess::RecoveryRevision>);
template<class F>void stampTest(const char *name,F action){test(name,action);++stampGroups;}
void historyStampCore(){
    SceneEdits edits(scene());require(edits.undoSelectionRevision()==0,"Empty history stamp was not neutral");
    const auto start=edits.revision();edits.selectSingle(0,SelectOperation::Set);const auto first=edits.undoSelectionRevision();
    require(first==edits.revision()&&first>start,"Selection history was not stamped at creation");
    edits.selectSingle(1,SelectOperation::Set);const auto second=edits.undoSelectionRevision();
    require(second==edits.revision()&&second>first,"Equal-count selection entry was not stamped");
    require(!edits.selectSingle(1,SelectOperation::Set)&&edits.undoSelectionRevision()==second,"No-op restamped history");
    edits.undo();require(edits.undoSelectionRevision()==first,"Undo did not expose the preceding original stamp");
    const auto rearmed=edits.revision();edits.redo();require(edits.undoSelectionRevision()==second&&second<=rearmed,"Redo recreated an old selection in the newly armed session");
    auto content=std::make_shared<Scene>(*edits.scene());content->gaussians[0].positionOpacity[0]+=7;edits.replaceScene(content,edits.states());
    require(edits.undoSelectionRevision()==0,"Scene/content entry was stamped as a manual selection");edits.undo();require(edits.undoSelectionRevision()==second,"Undo content did not reveal selection stamp");
    edits.deleteSelected();require(edits.undoSelectionRevision()==0,"Delete was stamped as selection-only history");edits.restoreDeleted();require(edits.undoSelectionRevision()==0,"Restore was stamped as selection-only history");
    edits.selectSingle(2,SelectOperation::Set);edits.resetCleanup();require(edits.undoSelectionRevision()==edits.revision(),"Selection-only clear/reset missed final revision stamp");
    edits.selectSingle(3,SelectOperation::Set);edits.deleteSelected();edits.selectSingle(0,SelectOperation::Set);edits.resetCleanup();
    require(edits.undoSelectionRevision()==0,"Mixed selected/deleted reset was stamped as selection-only history");
}
void historyStampDraftsAndCopies(){
    SceneEdits edits(scene());edits.selectSingle(0,SelectOperation::Set);const auto first=edits.undoSelectionRevision();
    edits.beginSelectionDraft();edits.selectSingle(1,SelectOperation::Set);require(edits.undoSelectionRevision()==first,"Preview created a history stamp");
    edits.cancelSelectionDraft();require(edits.undoSelectionRevision()==first,"Draft cancellation changed history stamp");
    edits.beginSelectionDraft();edits.selectSingle(2,SelectOperation::Set);edits.confirmSelectionDraft();const auto confirmed=edits.undoSelectionRevision();
    require(confirmed==edits.revision(),"Confirmed draft did not stamp its final revision");
    edits.beginSelectionDraft();require(!edits.confirmSelectionDraft()&&edits.undoSelectionRevision()==confirmed,"Empty confirmation restamped history");
    edits.beginSelectionDraft();edits.selectSingle(3,SelectOperation::Set);const auto implicit=edits.revision()+1;edits.deleteSelected();
    const auto &entries=BrowserSelectionAccess::recoveryUndo(edits);require(edits.undoSelectionRevision()==0&&entries[entries.size()-2].selectionRevision==implicit,"Implicit draft commit lost its separate creation revision");
    edits.undo();require(edits.undoSelectionRevision()==implicit,"Undo content did not expose implicit selection history");
    edits.beginSelectionDraft();edits.selectSingle(1,SelectOperation::Set);const auto final=edits.revision()+2;edits.resetCleanup();
    require(edits.revision()==final&&edits.undoSelectionRevision()==final,"Reset did not account for its cancelled-draft revision step");
    auto checkpoint=edits;edits.selectSingle(0,SelectOperation::Set);edits=checkpoint;
    require(edits.undoSelectionRevision()==final&&edits.revision()==final,"Transaction-style rollback copy lost history stamp");
    ResourceBudget budget(1024*1024);SceneEdits admitted(scene(),sceneMemoryForBudget(budget,ResourceCategory::History));
    for(unsigned i=0;i<14;++i)admitted.selectSingle(i%4,SelectOperation::Set);
    const auto &history=BrowserSelectionAccess::recoveryUndo(admitted);std::vector<uint64_t> stamps;for(const auto &entry:history)stamps.push_back(entry.selectionRevision);
    require(stamps.size()==10&&budget.usage().categoryBytes[size_t(ResourceCategory::History)]>=stamps.size()*sizeof(BrowserSelectionAccess::RecoveryRevision),"Stamped deque payload was not admitted or trimmed");
    for(size_t i=stamps.size();i>0;--i){require(admitted.undoSelectionRevision()==stamps[i-1],"History trim/Undo rewrote a retained stamp");admitted.undo();}
    require(admitted.undoSelectionRevision()==0,"Empty Undo retained a stale stamp");
    for(const auto stamp:stamps){admitted.redo();require(admitted.undoSelectionRevision()==stamp,"Redo move changed original entry stamp");}
}
void historyStampAdjustAndRefusals(){
    SceneEdits edits(scene());edits.selectSingle(0,SelectOperation::Set);const auto first=edits.undoSelectionRevision();auto checkpoint=BrowserSelectionAccess::capture(edits);
    const Bytes changed{0,1,0,0},baseline{1,0,0,0};
    BrowserSelectionAccess::adjust(edits,checkpoint,changed,[&](const auto &candidate){require(candidate.undoSelectionRevision==edits.revision()+1,"Amendment preflight predicted a stale stamp");});
    const auto amended=edits.undoSelectionRevision();require(amended==edits.revision()&&amended>first,"Accepted amendment did not refresh its click stamp");
    BrowserSelectionAccess::adjust(edits,checkpoint,changed,[&](const auto &candidate){require(candidate.undoSelectionRevision==amended,"Metadata-only amendment restamped history");});
    BrowserSelectionAccess::adjust(edits,checkpoint,baseline,[&](const auto &candidate){require(candidate.undoSelectionRevision==first,"Returning to baseline predicted the wrong exposed history");});
    require(edits.undoSelectionRevision()==first&&!checkpoint.recorded,"Empty click removal failed to reveal original top stamp");
    {const Snapshot before(edits);rejects([&]{BrowserSelectionAccess::adjust(edits,checkpoint,changed,[](const auto &){throw std::bad_alloc();});},"Reply preflight did not refuse");before.unchanged(edits);++historyRefusals;}
    HistoryAdmissionTestAccess::failAppend(edits,true);{const Snapshot before(edits);rejects([&]{edits.selectSingle(1,SelectOperation::Set);},"History stamp append refusal ignored");before.unchanged(edits);++historyRefusals;}HistoryAdmissionTestAccess::failAppend(edits,false);
    HistoryAdmissionTestAccess::revision(edits,maximum);{const Snapshot before(edits);rejects([&]{edits.selectSingle(1,SelectOperation::Set);},"Unsafe selection history stamp was published");before.unchanged(edits);}
    checkpoint=BrowserSelectionAccess::capture(edits);{const Snapshot before(edits);rejects([&]{BrowserSelectionAccess::adjust(edits,checkpoint,changed);},"Unsafe amendment history stamp was published");before.unchanged(edits);}
    SceneEdits draft(scene());draft.selectSingle(0,SelectOperation::Set);draft.beginSelectionDraft();draft.selectSingle(1,SelectOperation::Set);HistoryAdmissionTestAccess::revision(draft,maximum);
    {const Snapshot before(draft);rejects([&]{draft.confirmSelectionDraft();},"Unsafe confirmed draft stamp was published");before.unchanged(draft);}
}
void actualHistoryStamps(){
    open();require(summary().at("undoSelectionRevision")==0&&parsed(sv_build_identity()).at("capabilities").at("selectionActions")==2,"Native history capability/neutral scalar differs");
    good({{"command","single"},{"index",0},{"operation",0}});auto value=good({{"command","single"},{"index",1},{"operation",0}});const auto old=value.at("undoSelectionRevision");
    require(old==value.at("revision"),"Actual selection entry creation stamp differs");
    good({{"command","beginSelection"}});value=good({{"command","single"},{"index",2},{"operation",0}});require(value.at("undoSelectionRevision")==old,"Pending manual preview replaced Undo history stamp");
    require(good({{"command","cancelSelection"}}).at("undoSelectionRevision")==old,"Actual cancellation restamped Undo entry");
    good({{"command","beginTransaction"}});good({{"command","selectNone"}});require(good({{"command","rollbackTransaction"}}).at("undoSelectionRevision")==old,"Actual rollback failed to restore captured history stamp");
    const auto current=summary();const auto focus=good({{"command","transformFocus"},{"scope","scene"},{"revision",current.at("revision")},{"contentRevision",current.at("contentRevision")},{"transformBase",nullptr}});
    require(focus.at("undoSelectionRevision")==old,"Readonly focus changed history stamp");
    good({{"command","beginTransaction"}});const auto staged=good({{"command","selectNone"}}).at("undoSelectionRevision");
    require(good({{"command","commitTransaction"}}).at("undoSelectionRevision")==staged,"Actual commit changed the candidate history stamp");
    require(good({{"command","undo"}}).at("undoSelectionRevision")==old,"Undo after commit did not expose the original stamp");
    const auto filter=good({{"command","beginFilter"},{"kind","sphere"}}).at("filter");
    value=good({{"command","previewFilter"},{"id",filter.at("id")},{"epoch",1},{"kind","sphere"},{"parameters",{{"center",{0,0,0}},{"radius",1}}},{"operation",0}});
    require(value.at("pending")==true&&value.at("undoSelectionRevision")==old,"Pending filter changed prior history stamp");
    require(good({{"command","cancel"}}).at("undoSelectionRevision")==old,"Cancelled pending filter changed the accepted history stamp");
    value=good({{"command","previewFilter"},{"id",filter.at("id")},{"epoch",2},{"kind","sphere"},{"parameters",{{"center",{0,0,0}},{"radius",1}}},{"operation",0}});
    require(finish(value).at("undoSelectionRevision")==old,"Accepted transient filter preview changed history stamp");
    value=good({{"command","confirmFilter"},{"id",filter.at("id")},{"epoch",2}});const auto committed=value.at("undoSelectionRevision");require(committed==value.at("revision"),"Actual filter confirmation did not stamp history");
    good({{"command","undo"}});require(summary().at("undoSelectionRevision")==old,"Actual Undo did not reveal previous selection stamp");require(good({{"command","redo"}}).at("undoSelectionRevision")==committed,"Actual Redo restamped the entry");
    require(good({{"command","delete"}}).at("undoSelectionRevision")==0,"Actual content deletion stamped selection-only history");
    open();good({{"command","single"},{"index",3},{"operation",0}});const auto baselineStamp=summary().at("undoSelectionRevision"),id=Json(++toleranceId);
    value=good({{"command","colorPick"},{"camera",camera()},{"index",0},{"operation",2},{"tolerance",1},{"sessionId",id},{"rangeEnabled",true},{"rangeRadius",1}});
    require(value.at("undoSelectionRevision")==baselineStamp&&!value.at("toleranceRecorded").get<bool>(),"No-op tolerance pick changed top history stamp");
    value=good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1},{"rangeEnabled",true},{"rangeRadius",1000}});const auto toleranceStamp=value.at("undoSelectionRevision");require(toleranceStamp==value.at("revision"),"Actual tolerance amendment missed creation stamp");
    require(good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1},{"rangeEnabled",true},{"rangeRadius",1001}}).at("undoSelectionRevision")==toleranceStamp,"Metadata-only Range amendment restamped history");
    require(good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1},{"rangeEnabled",true},{"rangeRadius",1}}).at("undoSelectionRevision")==baselineStamp,"Actual empty click removal did not restore previous history stamp");
    good({{"command","endTolerance"},{"sessionId",id}});
}
}
int main(){try{
    test("sparse-draft-implicit-cleanup",sparseDraftAndCleanup);
    test("dense-domain-history-candidates",denseAndCandidates);
    test("tolerance-single-undo-duplicate",adjustmentAndDuplicate);
    test("overflow-history-atomicity",overflowAndHistoryRefusal);
    test("actual-selection-clip-content-rollback",actualSelectionAndRollback);
    test("actual-effective-target-canonical-publication",actualEffectiveScope);
    test("actual-tolerance-recovery-lifetime",actualToleranceAndRecovery);
    test("actual-malformed-publication-allocation",actualRefusals);
    stampTest("history-stamp-creation-content-redo",historyStampCore);
    stampTest("history-stamp-draft-implicit-reset-copy-trim",historyStampDraftsAndCopies);
    stampTest("history-stamp-amendment-overflow-refusal",historyStampAdjustAndRefusals);
    stampTest("history-stamp-actual-summary-filter-tolerance-rollback",actualHistoryStamps);
    std::printf("SPLATVIEW_SELECTION_HISTORY_STAMPS_CONTRACTS_PASS groups=%zu checks=%zu stampBytes=%zu revisionBytes=%zu\n",stampGroups,checks,sizeof(uint64_t),sizeof(BrowserSelectionAccess::RecoveryRevision));
    std::printf("SPLATVIEW_SELECTION_COMMIT_CONTRACTS_PASS groups=%zu checks=%zu refusals=%zu historyRefusals=%zu backendRefusals=%zu counterBytes=%zu\n",groups,checks,refusals,historyRefusals,backendRefusals,sizeof(uint64_t));return 0;
}catch(const std::exception &error){sv_allocation::failBackendAtForContracts(0);sv_recovery_restore_cancel();std::fprintf(stderr,"Selection commit contracts failed groups=%zu checks=%zu: %s\n",groups,checks,error.what());return 1;}}
