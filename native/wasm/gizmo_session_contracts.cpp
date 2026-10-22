// Private actual-ABI contracts for desktop multi-drag gizmo history. The
// independent geometry oracle applies the pinned portable Recipe kernel to
// successive literal records. No controller state or JS Undo loop participates.
#include "browser_transform_session.hpp"
#include "browser_document_checkpoint.hpp"
#include "selection_checkpoint.hpp"
#include "allocation_census.hpp"
#include "response.hpp"
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <vector>

extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const uint32_t *sv_pack_transform_base(double,double,double,unsigned,unsigned);
const uint8_t *sv_transform_base_states_ptr(double,double,double);unsigned sv_pack_len();
const char *sv_recovery_prepare();const uint8_t *sv_recovery_read(unsigned,unsigned);
unsigned sv_recovery_read_size();void sv_recovery_release();
const char *sv_recovery_restore_begin(unsigned,unsigned,unsigned,const char *);
const char *sv_recovery_restore_write(unsigned,const uint8_t *,unsigned);
const char *sv_recovery_restore_finish();void sv_recovery_restore_cancel();
}
namespace {
using namespace preview;namespace bt=browser_transform;using Json=nlohmann::json;using Bytes=std::vector<uint8_t>;
constexpr unsigned allowance=64*1024*1024;
size_t groups{},checks{},refusals{},backendRefusals{},publications{},historyMoves{},recoveryChecks{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void group(const char *name,F action){action();++groups;std::printf("GIZMO_SESSION_ACTIONS_GROUP_PASS %s\n",name);}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &value){const auto text=value.dump();return parsed(sv_command(text.c_str()));}
Json good(const Json &value){auto result=command(value);require(result.at("ok")==true,result.value("error",std::string("Gizmo ABI request refused")).c_str());return result;}
Json named(const char *name){return good({{"command",name}});}
Json summary(){return named("summary");}
Json finish(Json value){require(value.at("ok")==true,"Gizmo job admission failed");for(size_t step=0;value.value("pending",false);++step){
    require(step<10000,"Gizmo job did not terminate");value=parsed(sv_step(5));require(value.at("ok")==true,"Gizmo job publication refused");}return value;}
void open(){Bytes bytes(5*32);const std::array<float,5> x{0,100,.5f,200,-.5f};for(size_t i=0;i<5;++i){
    const std::array<float,6> values{x[i],float(i%2)*.25f,0,.1f,.2f,.3f};std::memcpy(bytes.data()+32*i,values.data(),24);
    const std::array<uint8_t,8> rest{uint8_t(30+i*35),uint8_t(40+i*30),uint8_t(60+i*25),128,255,128,128,128};std::memcpy(bytes.data()+32*i+24,rest.data(),8);}
    require(parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),1000,allowance)).at("ok")==true,"Gizmo fixture failed to open");}
std::vector<Gaussian> records(){require(sv_scene_ptr()!=nullptr,"Missing actual Gaussian owner");return {sv_scene_ptr(),sv_scene_ptr()+5};}
Bytes masks(){require(sv_states_ptr()!=nullptr,"Missing actual mask owner");return {sv_states_ptr(),sv_states_ptr()+5};}
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b){return a.size()==b.size()&&!std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));}
Json signature(Json value){for(const auto *key:{"memoryBytes","progress","pending"})value.erase(key);return value;}
struct Snapshot {
    Json value=summary();const Gaussian *scene=sv_scene_ptr();const uint8_t *mask=sv_states_ptr();
    std::vector<Gaussian> gaussians=records();Bytes states=masks();
    void unchanged(bool memory=true) const {
        const auto now=summary();require(signature(now)==signature(value),"Refusal changed scene/history/full session metadata");
        require(now.at("pending")==value.at("pending"),"Refusal changed another pending owner");
        if(memory)require(now.at("memoryBytes")==value.at("memoryBytes"),"Refusal retained native admission");
        require(sv_scene_ptr()==scene&&sv_states_ptr()==mask&&same(records(),gaussians)&&masks()==states,"Refusal changed actual scene/mask owners or bytes");
    }
    void restored() const {
        unchanged(false);
        // A successful rollback installs a SceneEdits copy. Sparse Changes
        // vectors copy size, not spare capacity: this five-change fixture can
        // compact capacity 8 to 5. Logical owners/history must be exact, while
        // retained admission may decrease. Rejected requests remain byte-exact.
        const auto first=summary().at("memoryBytes").get<uint64_t>();
        const auto previous=value.at("memoryBytes").get<uint64_t>();
        require(first<=previous,"Successful rollback increased retained native admission");
        require(summary().at("memoryBytes")==first,"Successful rollback admission did not settle");
    }
};
void refused(const Json &request){const Snapshot before;require(command(request).at("ok")==false,"Invalid gizmo request accepted");++refusals;before.unchanged();}
Json parameters(std::array<float,3> translation={1,0,0},std::array<float,3> scale={1,1,1},std::array<float,3> euler={0,0,0}){
    return {{"mode","euler"},{"translation",translation},{"scale",scale},{"euler",euler},{"pivot",{0,0,0}},{"flips",{false,false,false}}};}
Json view(float x=0){return Json::array({x,0,0,0,0,5,1,60,1,0,1});}
Json begin(bool selected=false){return good({{"command","beginTransform"},{"kind","gizmo"},{"selectedOnly",selected}});}
Json rebase(uint64_t id,uint64_t epoch,bool selected=false,const Json &camera=nullptr){
    Json request{{"command","rebaseTransform"},{"id",id},{"epoch",epoch},{"selectedOnly",selected}};
    if(!camera.is_null())request["selectionView"]=camera;return good(request);
}
Json apply(uint64_t id,uint64_t epoch,const Json &p=parameters()){return good({{"command","applyTransform"},{"id",id},{"epoch",epoch},{"parameters",p}});}
Json action(const char *name,uint64_t id,uint64_t epoch){return good({{"command",name},{"id",id},{"epoch",epoch}});}
void rebased(const Json &value,uint64_t id,uint64_t epoch,uint64_t oldBase){const auto &owner=value.at("transformSession");
    require(owner.at("id")==id&&owner.at("epoch")==epoch&&owner.at("baseId").get<uint64_t>()>oldBase&&
        owner.at("appliedEpoch").is_null()&&owner.at("appliedMatrix")==Json(identityMatrix),"Gizmo did not acknowledge a fresh identity result base");}
void compare(const std::vector<Gaussian> &expected){const auto actual=records();require(same(actual,expected),"Incremental native Gaussian/SH/covariance bytes differ from independent Recipe oracle");}
void oracle(std::vector<Gaussian> &value,const Json &p,const Bytes &target,bool selected){
    const Recipe recipe{{"translation",p.at("translation")},{"scale",p.at("scale")},{"euler",p.at("euler")},{"center",p.at("pivot")}};
    const auto affine=processing_detail::transform(recipe);
    for(size_t i=0;i<value.size();++i)if(!(target[i]&2)&&(!selected||(target[i]&1)))affine.apply(value[i]);
}
void initialAndNoops(){
    open();named("selectAll");const auto original=summary();const auto geometry=records();const auto mask=masks();auto value=begin(true);
    const auto id=value.at("transformSession").at("id").get<uint64_t>();
    require(value.at("transformSession").at("gizmo")==Json{{"cancelBaseId",nullptr},{"cancelContentRevision",nullptr},{"canUndo",false},{"canRedo",false}},"Arming inherited older history or captured an eager Cancel base");
    require(value.at("revision")==original.at("revision")&&same(records(),geometry)&&masks()==mask,"Arming created history or changed the source");
    refused({{"command","undoTransform"},{"id",id},{"epoch",1}});refused({{"command","redoTransform"},{"id",id},{"epoch",2}});
    value=rebase(id,3,true);auto base=value.at("transformSession").at("baseId").get<uint64_t>();
    value=apply(id,4,parameters({0,0,0}));require(!value.at("pending").get<bool>(),"Identity gizmo release ran a bake");rebased(value,id,4,base);
    require(value.at("revision")==original.at("revision")&&value.at("contentRevision")==original.at("contentRevision")&&same(records(),geometry)&&masks()==mask&&value.at("transformSession").at("gizmo").at("cancelBaseId").is_null(),"Identity gizmo release created geometry/history/Cancel ownership");
    value=action("cancelTransform",id,5);require(value.at("transformSession").is_null()&&value.at("revision")==original.at("revision"),"Cancel before a first edit added history");
    value=begin();const auto checked=value.at("transformSession").at("id").get<uint64_t>();
    value=good({{"command","endTransform"},{"id",checked}});require(value.at("transformSession").is_null()&&value.at("revision")==original.at("revision"),"Check before a first edit created history");
    open();named("selectAll");named("undo");const auto redoBefore=summary();value=begin();const auto redoId=value.at("transformSession").at("id").get<uint64_t>();
    rebase(redoId,1);value=apply(redoId,2,parameters({0,0,0}));require(value.at("canRedo")==true&&value.at("revision")==redoBefore.at("revision")&&value.at("transformSession").at("gizmo").at("canRedo")==false,
        "Identity gizmo release destroyed old Redo or adopted pre-session Redo eligibility");good({{"command","endTransform"},{"id",redoId}});named("redo");require(masks()==Bytes(5,1),"Identity release made preserved Redo unexecutable");
}
void incrementalHistoryAndCancel(){
    open();named("selectAll");const auto original=records();const auto originalMask=masks();const auto initial=summary();auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();
    value=rebase(id,1);const auto firstBase=value.at("transformSession").at("baseId").get<uint64_t>();
    auto expected=original;const auto first=parameters({1,2,0},{2,1,1});oracle(expected,first,originalMask,false);
    value=finish(apply(id,2,first));compare(expected);rebased(value,id,2,firstBase);const auto one=records();
    const auto cancel=value.at("transformSession").at("gizmo");require(cancel.at("cancelBaseId")==firstBase&&cancel.at("cancelContentRevision")==initial.at("contentRevision")&&cancel.at("canUndo")==true&&cancel.at("canRedo")==false,"First actual publication did not capture its original Cancel identity");
    require(value.at("undoSelectionRevision")==0,"Gizmo geometry was stamped as manual selection history");
    require(!sv_pack_transform_base(double(id),double(firstBase),2,0,1),"Stale pre-bake preview base remained readable");
    const auto currentBase=value.at("transformSession").at("baseId").get<uint64_t>();const auto *packed=sv_pack_transform_base(double(id),double(currentBase),2,0,5);
    require(packed&&sv_pack_len()>0,"Accepted current geometry could not be streamed as the idle base");float x{};std::memcpy(&x,packed,4);require(x==one[0].positionOpacity[0],"Idle gizmo stream retained first-drag geometry");
    value=rebase(id,3);const auto secondBase=value.at("transformSession").at("baseId").get<uint64_t>();
    const auto second=parameters({0,0,0},{1,1,1},{0,0,90});oracle(expected,second,originalMask,false);
    value=finish(apply(id,4,second));compare(expected);rebased(value,id,4,secondBase);const auto two=records();const auto afterTwo=value;
    require(value.at("transformSession").at("gizmo")==cancel,"Second drag replaced the first Cancel baseline");
    auto wrong=original;oracle(wrong,second,originalMask,false);require(!same(wrong,two),"Fixture cannot distinguish cumulative drag composition from absolute first-base replacement");
    value=action("undoTransform",id,5);compare(one);++historyMoves;require(value.at("transformSession").at("gizmo").at("canRedo")==true,"Undo lost native session Redo");
    value=action("redoTransform",id,6);compare(two);++historyMoves;
    value=action("undoTransform",id,7);compare(one);value=action("undoTransform",id,8);compare(original);historyMoves+=2;
    require(value.at("transformSession").at("gizmo").at("cancelBaseId")==firstBase&&value.at("transformSession").at("gizmo").at("canUndo")==false&&value.at("canUndo")==true,"Session Undo crossed into older selection history or dropped its Cancel baseline");
    refused({{"command","undoTransform"},{"id",id},{"epoch",9}});
    action("redoTransform",id,10);value=action("redoTransform",id,11);compare(two);historyMoves+=2;
    value=action("cancelTransform",id,12);compare(original);require(masks()==originalMask&&value.at("transformSession").is_null()&&value.at("contentRevision")==initial.at("contentRevision")&&value.at("undoSelectionRevision")==0,"Cancel did not restore exact first scene/mask/content identity");
    require(value.at("revision").get<uint64_t>()==afterTwo.at("revision").get<uint64_t>()+7,"History moves plus Cancel did not each publish exactly one edit");
    const auto undo=named("undo");compare(two);require(undo.at("contentRevision")==afterTwo.at("contentRevision"),"Undo Cancel lost final content identity");
    const auto redo=named("redo");compare(original);require(redo.at("contentRevision")==initial.at("contentRevision"),"Redo Cancel did not retain restored original content identity");
    value=begin();const auto nextId=value.at("transformSession").at("id").get<uint64_t>();rebase(nextId,1);finish(apply(nextId,2));const auto again=records();
    action("undoTransform",nextId,3);const auto atBase=summary();value=action("cancelTransform",nextId,4);
    require(value.at("revision")==atBase.at("revision")&&value.at("canRedo")==true&&value.at("transformSession").is_null(),"Cancel at the original scene added history or erased existing Redo");named("redo");compare(again);
}
void perPressScopeAndEmpty(){
    open();named("selectAll");const auto original=records();const auto initial=summary();const auto canonical=masks();auto value=begin(true);const auto id=value.at("transformSession").at("id").get<uint64_t>();
    value=rebase(id,1,true,view());const auto drag=value.at("transformSession");const auto base=drag.at("baseId").get<uint64_t>();
    const auto *target=sv_transform_base_states_ptr(double(id),double(base),1);const Bytes clipped{1,0,1,0,1};require(target&&Bytes(target,target+5)==clipped&&masks()==canonical,"Press capture clipped canonical mask or lost frozen effective target");
    const auto first=parameters({1,0,0});auto expected=original;oracle(expected,first,clipped,true);value=finish(apply(id,2,first));compare(expected);
    require(masks()==clipped&&value.at("transformSession").at("gizmo").at("cancelContentRevision")==initial.at("contentRevision"),"First scoped publication did not atomically clip while retaining pre-clip Cancel baseline");
    const auto beforeEmpty=value;value=rebase(id,3,true,view(100));const auto emptyBase=value.at("transformSession").at("baseId").get<uint64_t>();
    target=sv_transform_base_states_ptr(double(id),double(emptyBase),3);require(target&&Bytes(target,target+5)==Bytes(5,0),"A later press did not freeze its own empty current view");
    value=apply(id,4,parameters({99,0,0}));rebased(value,id,4,emptyBase);compare(expected);require(value.at("revision")==beforeEmpty.at("revision")&&masks()==clipped&&value.at("transformSession").at("gizmo")==beforeEmpty.at("transformSession").at("gizmo"),"Empty press fell back to old selected/whole-scene target or created history");
    value=rebase(id,5,false,view(100));const auto second=parameters({0,2,0});oracle(expected,second,clipped,false);finish(apply(id,6,second));compare(expected);require(masks()==clipped,"Whole-scene drag unexpectedly clipped highlights to the current view");
    action("cancelTransform",id,7);compare(original);require(masks()==canonical&&summary().at("contentRevision")==initial.at("contentRevision"),"Session Cancel captured an already clipped first baseline");
    // An empty first press must never invent a baseline; deleted records stay
    // outside every target, and explicit selectedOnly=false is the sole global scope.
    open();good({{"command","single"},{"index",1},{"operation",0}});const Snapshot before;
    value=begin(true);const auto emptyId=value.at("transformSession").at("id").get<uint64_t>();rebase(emptyId,1,true,view());value=apply(emptyId,2);
    require(value.at("transformSession").at("gizmo").at("cancelBaseId").is_null()&&value.at("revision")==before.value.at("revision")&&same(records(),before.gaussians)&&masks()==before.states,"Empty first drag changed history or captured a Cancel baseline");action("cancelTransform",emptyId,3);
    open();good({{"command","single"},{"index",0},{"operation",0}});named("delete");good({{"command","single"},{"index",2},{"operation",0}});
    const auto deletedOriginal=records();const auto deletedMask=masks();value=begin(true);const auto deletedId=value.at("transformSession").at("id").get<uint64_t>();
    rebase(deletedId,1,true);auto deletedExpected=deletedOriginal;oracle(deletedExpected,first,deletedMask,true);finish(apply(deletedId,2,first));compare(deletedExpected);
    require(masks()==deletedMask,"Selected gizmo drag changed deleted/unselected mask semantics");action("cancelTransform",deletedId,3);compare(deletedOriginal);require(masks()==deletedMask,"Cancel did not restore deleted-state baseline");
}
void pendingAndTransactions(){
    open();named("selectAll");const auto original=records();auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();rebase(id,1);finish(apply(id,2));const auto first=records();
    rebase(id,3);const auto settled=summary();const auto oldBase=settled.at("transformSession").at("baseId");value=apply(id,4,parameters({2,0,0}));
    require(value.at("pending")==true&&value.at("transformSession").at("baseId")==oldBase&&value.at("transformSession").at("gizmo").at("canUndo")==false&&value.at("transformSession").at("gizmo").at("cancelBaseId")==settled.at("transformSession").at("gizmo").at("cancelBaseId"),"Pending bake replaced frozen base/Cancel metadata or advertised history actions");
    refused({{"command","undoTransform"},{"id",id},{"epoch",5}});refused({{"command","cancelTransform"},{"id",id},{"epoch",6}});
    named("cancel");compare(first);value=summary();require(!value.at("pending").get<bool>()&&value.at("transformSession").at("baseId")==oldBase&&value.at("transformSession").at("gizmo")==settled.at("transformSession").at("gizmo"),"Cancelling unfinished drag lost earlier accepted session state");
    action("cancelTransform",id,7);compare(original);
    open();named("selectAll");value=begin();const auto txId=value.at("transformSession").at("id").get<uint64_t>();rebase(txId,1);const Snapshot baseline;
    named("beginTransaction");finish(apply(txId,2));require(!summary().at("transformSession").at("gizmo").at("cancelBaseId").is_null(),"Transactional first bake did not capture its candidate baseline");
    good({{"command","endTransform"},{"id",txId}});named("rollbackTransaction");baseline.restored();
    refused({{"command","applyTransform"},{"id",txId},{"epoch",2},{"parameters",parameters()}});rebase(txId,3);finish(apply(txId,4));const Snapshot accepted;
    named("beginTransaction");action("cancelTransform",txId,5);require(summary().at("transformSession").is_null(),"Transactional Cancel did not retire candidate owner");named("rollbackTransaction");accepted.restored();
    named("beginTransaction");action("cancelTransform",txId,6);named("commitTransaction");require(summary().at("transformSession").is_null(),"Committed Cancel reintroduced a session owner");
}
void trimAndContentHighwater(){
    open();named("selectAll");const auto original=records();const auto content=summary().at("contentRevision");auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();
    uint64_t epoch=0;for(unsigned drag=0;drag<14;++drag){rebase(id,++epoch);value=finish(apply(id,++epoch,parameters({.25f,0,0})));}
    const auto final=records();const auto high=value.at("contentRevision").get<uint64_t>();require(high>=14&&value.at("transformSession").at("gizmo").at("canUndo")==true,"Long session did not retain independent baseline/history eligibility");
    value=action("cancelTransform",id,++epoch);compare(original);require(value.at("contentRevision")==content,"Trimmed-history Cancel lost original content identity");
    named("undo");compare(final);named("redo");compare(original);
    value=begin();const auto next=value.at("transformSession").at("id").get<uint64_t>();rebase(next,1);value=finish(apply(next,2));
    require(value.at("contentRevision").get<uint64_t>()==high+1,"Restored-content Cancel consumed/reused a content highwater identity");good({{"command","endTransform"},{"id",next}});
}
void identifiedTransactionReceipts(){
    open();named("selectAll");auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();rebase(id,1);const Snapshot baseline;
    const Json scope{{"version",1},{"documentId","13579bdf-1357-4357-8357-13579bdf1357"},{"clientGeneration","2468ace0-2468-4468-8468-2468ace02468"},{"sourceGeneration",1}};
    require(command({{"command","operationBind"},{"operationScope",scope}}).at("ok")==true,"Owned gizmo scope did not bind");
    Json owner=scope;owner["operationId"]=1;
    const auto control=[&](const char *name){auto result=command({{"command",name},{"operationOwner",owner}});require(result.at("ok")==true,"Owned gizmo control refused");return result;};
    value=control("beginTransaction");require(value.at("receipt").at("outcome")=="active"&&value.at("summary").at("transformSession")==baseline.value.at("transformSession"),"Owned begin changed complete gizmo baseline metadata");
    finish(good({{"command","applyTransform"},{"id",id},{"epoch",2},{"parameters",parameters()},{"operationOwner",owner}}));
    good({{"command","endTransform"},{"id",id},{"operationOwner",owner}});value=control("rollbackTransaction");
    require(value.at("receipt").at("outcome")=="rolled-back"&&value.at("summary").at("transformSession")==baseline.value.at("transformSession"),"Receipt rollback lost first/prepared/current gizmo owner fields");baseline.restored();
    require(control("operationRetire").at("kind")=="operation-retired","Owned rollback receipt did not retire");
    owner["operationId"]=2;control("beginTransaction");
    good({{"command","rebaseTransform"},{"id",id},{"epoch",3},{"selectedOnly",false},{"operationOwner",owner}});
    finish(good({{"command","applyTransform"},{"id",id},{"epoch",4},{"parameters",parameters({2,0,0})},{"operationOwner",owner}}));const Snapshot accepted;
    value=control("commitTransaction");require(value.at("receipt").at("outcome")=="committed"&&value.at("summary").at("transformSession")==accepted.value.at("transformSession"),"Receipt commit lost accepted gizmo Cancel/history metadata");
    value=control("operationStatus");require(value.at("receipt").at("outcome")=="committed"&&value.at("summary").at("transformSession")==accepted.value.at("transformSession"),"Idempotent receipt status changed gizmo metadata");
    control("operationRetire");action("cancelTransform",id,5);compare(baseline.gaussians);
}
void refusalAndPublication(){
    open();const auto numeric=good({{"command","beginTransform"},{"kind","numeric"},{"selectedOnly",false}}).at("transformSession").at("id");
    for(const auto *name:{"rebaseTransform","undoTransform","redoTransform","cancelTransform"}){
        Json request{{"command",name},{"id",numeric},{"epoch",1}};if(std::strcmp(name,"rebaseTransform")==0)request["selectedOnly"]=false;refused(request);}
    good({{"command","endTransform"},{"id",numeric}});auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();
    refused({{"command","resetTransform"},{"id",id},{"epoch",1}});
    for(const auto &request:std::vector<Json>{
        {{"command","rebaseTransform"},{"id",id+1},{"epoch",2},{"selectedOnly",false}},
        {{"command","rebaseTransform"},{"id",id},{"epoch",3},{"selectedOnly",0}},
        {{"command","rebaseTransform"},{"id",id},{"epoch",4},{"selectedOnly",false},{"selectionView",{1,2}}},
        {{"command","cancelTransform"},{"id",id},{"epoch",9007199254740992ULL}},
        {{"command","undoTransform"},{"id",id},{"epoch",5},{"selectionView",view()}}})refused(request);
    rebase(id,10);const Snapshot before;
    sv_response::refuseNextSummaryForContracts();require(command({{"command","rebaseTransform"},{"id",id},{"epoch",11},{"selectedOnly",false}}).at("ok")==false,"Rebase publication refusal ignored");before.unchanged();++publications;
    value=apply(id,12);require(value.at("pending")==true,"Refusal fixture did not start");sv_response::refuseNextSummaryForContracts();require(parsed(sv_step(65536)).at("ok")==false,"Actual bake publication refusal ignored");
    compare(before.gaussians);require(summary().at("revision")==before.value.at("revision")&&summary().at("transformSession").at("gizmo").at("cancelBaseId").is_null(),"Refused first result captured a baseline or changed history");++publications;
    value=finish(apply(id,13));const Snapshot baked;
    for(const auto *name:{"undoTransform","cancelTransform"}){const auto epoch=std::strcmp(name,"undoTransform")==0?14:15;
        sv_response::refuseNextSummaryForContracts();require(command({{"command",name},{"id",id},{"epoch",epoch}}).at("ok")==false,"History/Cancel response gate ignored");baked.unchanged();++publications;}
    bool reached=false;for(size_t ordinal=1;ordinal<128;++ordinal){const auto request=Json{{"command","cancelTransform"},{"id",id},{"epoch",100+ordinal}}.dump();
        sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);const auto result=parsed(reply);
        if(result.at("ok")==true){reached=true;break;}++backendRefusals;baked.unchanged();}
    require(reached&&backendRefusals>0,"Cancel history/metadata allocation sweep did not reach both refusal and publication");compare(before.gaussians);
    // A rebase must stage its effective mask before replacing the old base.
    open();named("selectAll");value=begin(true);const auto scoped=value.at("transformSession").at("id").get<uint64_t>();const Snapshot scopedBefore;reached=false;
    for(size_t ordinal=1;ordinal<128;++ordinal){const auto request=Json{{"command","rebaseTransform"},{"id",scoped},{"epoch",ordinal},{"selectedOnly",true},{"selectionView",view()}}.dump();
        sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);const auto result=parsed(reply);
        if(result.at("ok")==true){reached=true;break;}++backendRefusals;scopedBefore.unchanged();}
    require(reached,"Scoped rebase allocation sweep never reached success");good({{"command","endTransform"},{"id",scoped}});
}
void readonlyAndRecovery(){
    open();named("selectAll");auto value=begin();const auto id=value.at("transformSession").at("id").get<uint64_t>();rebase(id,1);finish(apply(id,2,parameters({7,0,0})));const Snapshot before;
    const auto owner=before.value.at("transformSession");const Json focus{{"command","transformFocus"},{"scope","scene"},{"revision",before.value.at("revision")},{"contentRevision",before.value.at("contentRevision")},
        {"transformBase",{{"id",owner.at("id")},{"baseId",owner.at("baseId")},{"epoch",owner.at("epoch")}}}};
    value=finish(good(focus));require(value.at("point")==before.value.at("center"),"Idle gizmo focus observed first geometry instead of the accepted result base");before.unchanged();
    auto selectedFocus=focus;selectedFocus["scope"]="selection";value=good(selectedFocus);
    require(value.at("pending")==true&&value.at("transformSession")==before.value.at("transformSession"),"Readonly cooperative focus changed settled gizmo eligibility/Cancel metadata");
    value=finish(value);require(value.contains("point"),"Cooperative selection focus lost point response");before.unchanged();
    const auto plan=parsed(sv_recovery_prepare());require(plan.at("ok")==true&&plan.at("version")==2,"Gizmo recovery plan refused or changed plan version");Bytes bytes;
    for(unsigned at=0,total=plan.at("byteLength").get<unsigned>();at<total;){const auto count=std::min(251u,total-at);const auto *data=sv_recovery_read(at,count);require(data&&sv_recovery_read_size()==count,"Gizmo recovery read failed");bytes.insert(bytes.end(),data,data+count);at+=count;}sv_recovery_release();before.unchanged();
    require(bytes[8]==3,"Gizmo phase changed durable codec3");
    const Json expected{{"codecVersion",3},{"currentLoadedCount",plan.at("currentLoadedCount")},{"currentSourceCount",plan.at("currentSourceCount")},{"currentDuplicateRange",plan.at("currentDuplicateRange")},
        {"maximumGraphSplats",plan.at("maximumGraphSplats")},{"originalSourceCount",5},{"revision",plan.at("revision")},{"contentRevision",plan.at("contentRevision")},{"nextContentRevision",plan.at("nextContentRevision")}};
    const auto text=expected.dump();require(parsed(sv_recovery_restore_begin(unsigned(bytes.size()),expected.at("maximumGraphSplats").get<unsigned>(),allowance,text.c_str())).at("ok")==true,"Gizmo recovery admission failed");
    require(parsed(sv_recovery_restore_write(0,bytes.data(),unsigned(bytes.size()))).at("ok")==true,"Gizmo recovery input failed");value=parsed(sv_recovery_restore_finish());
    require(value.at("ok")==true&&value.at("transformSession").is_null()&&value.at("canUndo")==true&&value.at("revision")==before.value.at("revision")&&value.at("contentRevision")==before.value.at("contentRevision")&&masks()==before.states&&same(records(),before.gaussians),"Replacement worker resumed an unverifiable gizmo baseline or lost accepted geometry/history");++recoveryChecks;
    refused({{"command","cancelTransform"},{"id",id},{"epoch",3}});named("undo");named("redo");compare(before.gaussians);
    value=begin();const auto stale=value.at("transformSession").at("id").get<uint64_t>();open();refused({{"command","cancelTransform"},{"id",stale},{"epoch",1}});
}
}
void runGizmoSessionContracts(){
    static_assert(std::is_nothrow_copy_constructible_v<bt::GizmoBaseline>);
    static_assert(std::is_nothrow_move_assignable_v<bt::Owner>);
    group("armed-identity-noop-check-cancel",initialAndNoops);
    group("incremental-noncommuting-drags-native-history-cancel",incrementalHistoryAndCancel);
    group("physical-press-scope-empty-canonical-cancel",perPressScopeAndEmpty);
    group("pending-cancellation-transaction-restoration",pendingAndTransactions);
    group("identified-operation-receipt-owner-restoration",identifiedTransactionReceipts);
    group("history-trim-retained-base-content-highwater",trimAndContentHighwater);
    group("grammar-publication-allocation-atomicity",refusalAndPublication);
    group("readonly-current-base-and-recovery-normalization",readonlyAndRecovery);
    std::printf("SPLATVIEW_GIZMO_SESSION_ACTIONS_CONTRACTS_PASS groups=%zu checks=%zu refusals=%zu backend=%zu publications=%zu historyMoves=%zu recovery=%zu baselineBytes=%zu\n",
        groups,checks,refusals,backendRefusals,publications,historyMoves,recoveryChecks,sizeof(bt::GizmoBaseline));
}
