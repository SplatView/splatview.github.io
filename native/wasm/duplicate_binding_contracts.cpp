// Actual ABI routes only. No shipping observation or fault export is added.
#include "response.hpp"
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <vector>
extern "C" {
unsigned sv_abi_version();
const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const char *sv_recovery_prepare();
const uint8_t *sv_recovery_read(unsigned,unsigned);
unsigned sv_recovery_read_size();
void sv_recovery_release();
const char *sv_recovery_restore_begin(unsigned,unsigned,unsigned,const char *);
const char *sv_recovery_restore_write(unsigned,const uint8_t *,unsigned);
const char *sv_recovery_restore_finish();
void sv_recovery_restore_cancel();
}
namespace {
using Json=nlohmann::json;using Bytes=std::vector<uint8_t>;using preview::Gaussian;
constexpr unsigned budget=64*1024*1024;
size_t cases{},checks{},allocationRefusals{};uint64_t sourceGeneration{},operationId{};
void require(bool v,const char *message){++checks;if(!v)throw std::runtime_error(message);}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &value){const auto text=value.dump();return parsed(sv_command(text.c_str()));}
Json named(const char *name){return command({{"command",name}});}
Json summary(){return named("summary");}
Json good(const Json &value){auto result=command(value);require(result.at("ok")==true,"Fixture command refused");return result;}
Json finish(Json value,unsigned batch=1){
    for(size_t steps=0;value.value("pending",false);++steps){require(steps<1000,"Duplicate pump unbounded");value=parsed(sv_step(batch));if(value.at("ok")==false)return value;}
    return value;
}
std::vector<Gaussian> records(){const auto n=summary().at("count").get<size_t>();return {sv_scene_ptr(),sv_scene_ptr()+n};}
Bytes masks(){const auto n=summary().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n};}
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b){return a.size()==b.size()&&!std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));}
struct Baseline {
    Json value=summary();const Gaussian *scene=sv_scene_ptr();const uint8_t *mask=sv_states_ptr();
    std::vector<Gaussian> bytes=records();Bytes states=masks();
    void unchanged() const {
        const auto now=summary();
        for(const auto *key:{"count","sourceCount","duplicateRange","selected","visible","canUndo","canRedo","revision","contentRevision",
                            "transaction","selectionDraft","pending","alignment","colorSession","filter","transformSession","opacitySession"})
            require(now.at(key)==value.at(key),"Refusal changed native topology/identity/history/session");
        require(sv_scene_ptr()==scene&&sv_states_ptr()==mask&&same(records(),bytes)&&masks()==states,"Refusal changed exact scene/mask owners or bytes");
    }
};
Bytes input(){
    std::ostringstream text;text<<"ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n";
    for(unsigned i=0;i<45;++i)text<<"property float f_rest_"<<i<<'\n';text<<"end_header\n";
    const std::array<float,5> x{0,100,.5f,200,1};
    for(size_t i=0;i<5;++i){text<<x[i]<<" 0 0 -3 -2 -1 1 0 0 0 1 .1 .2 -.3 ";
        for(size_t j=0;j<45;++j)text<<float(int((i+j)%9)-4)*.03125f<<' ';text<<'\n';}
    const auto s=text.str();return {s.begin(),s.end()};
}
Json scope(){return {{"version",1},{"documentId","11111111-1111-4111-8111-111111111111"},{"sourceGeneration",sourceGeneration},{"clientGeneration","22222222-2222-4222-8222-222222222222"}};}
Json owner(){auto value=scope();value["operationId"]=++operationId;return value;}
Json owned(const char *name,const Json &identity){return {{"command",name},{"operationOwner",identity}};}
Json receipt(const char *name,const Json &identity,const char *outcome){
    auto result=good(owned(name,identity));require(result.at("kind")=="operation-receipt"&&result.at("version")==2&&result.at("receipt").at("version")==2&&
        result.at("receipt").at("owner")==identity&&result.at("receipt").at("outcome")==outcome,"Topology receipt differs");return result;
}
void retire(const Json &identity){good(owned("operationRetire",identity));}
void fixture(){
    const auto bytes=input();require(parsed(sv_open(bytes.data(),bytes.size(),0,100,budget)).at("ok")==true,"SH3 open failed");++sourceGeneration;
    require(summary().at("duplicateRange").is_null(),"New source inherited duplicate marker");
    good({{"command","single"},{"index",4},{"operation",0}});good({{"command","delete"}});
    good({{"command","single"},{"index",0},{"operation",0}});
    good({{"command","single"},{"index",1},{"operation",1}});
    good({{"command","single"},{"index",2},{"operation",1}});
    good({{"command","single"},{"index",3},{"operation",1}});good({{"command","undo"}});
    require(masks()==Bytes({1,1,1,0,2})&&summary().at("canRedo")==true,"Independent fixture mask/Redo wrong");
    good({{"command","operationBind"},{"operationScope",scope()}});
}
Json duplicate(const Json &identity={},bool view=false){
    Json request{{"command","duplicate"}};if(!identity.is_null()&&!identity.empty())request["operationOwner"]=identity;
    if(view)request["selectionView"]={0,0,0,0,0,5,1,60,1,0,1};return command(request);
}
void bytesViewHistoryReceipts(){
    fixture();require(sv_abi_version()==24&&parsed(sv_build_identity()).at("capabilities").at("duplicate")==1,"Duplicate ABI capability absent");
    const auto before=records();const auto beforeMask=masks();const auto beforeOwner=sv_scene_ptr();const auto beforeStates=sv_states_ptr();const auto baseline=summary();
    const auto identity=owner();const auto active=receipt("beginTransaction",identity,"active");
    require(active.at("receipt").at("before").at("count")==5&&active.at("receipt").at("before").at("duplicateRange").is_null(),"Receipt omitted baseline topology");
    auto pending=duplicate(identity,true);require(pending.at("pending")==true&&sv_scene_ptr()==beforeOwner&&sv_states_ptr()==beforeStates,"Admission published partial data");
    const auto grown=finish(pending);require(grown.at("ok")==true&&grown.at("count")==7&&grown.at("sourceCount")==7&&grown.at("selected")==2&&grown.at("visible")==6,"Scoped Duplicate cardinality wrong");
    const auto after=records();require(std::memcmp(before.data(),after.data(),before.size()*sizeof(Gaussian))==0&&
        !std::memcmp(&before[0],&after[5],sizeof(Gaussian))&&!std::memcmp(&before[2],&after[6],sizeof(Gaussian)),"SH3/original order copy bytes differ");
    require(masks()==Bytes({0,0,0,0,2,1,1})&&grown.at("duplicateRange")==Json({{"first",5},{"count",2}}),"Canonical mask/suffix differs");
    const auto terminal=receipt("commitTransaction",identity,"committed");
    require(terminal.at("receipt").at("before").at("count")==5&&terminal.at("receipt").at("terminal").at("count")==7&&
        terminal.at("receipt").at("terminal").at("sourceCount")==7&&terminal.at("receipt").at("terminal").at("duplicateRange")==grown.at("duplicateRange"),"Terminal receipt lost topology transition");
    retire(identity);good({{"command","undo"}});
    require(sv_scene_ptr()==beforeOwner&&sv_states_ptr()==beforeStates&&masks()==beforeMask&&summary().at("contentRevision")==baseline.at("contentRevision")&&summary().at("duplicateRange").is_null(),"Undo failed across count boundary");
    good({{"command","redo"}});require(same(records(),after)&&summary().at("duplicateRange")==grown.at("duplicateRange"),"Redo lost records/range");
    const Baseline guarded;require(finish(duplicate()).at("ok")==false,"Untouched copied selection was duplicated");guarded.unchanged();
    good({{"command","single"},{"index",0},{"operation",1}});require(finish(duplicate()).at("ok")==true&&summary().at("count")==10,"Changed selection stayed guarded");
}
void rollbackCancellationAndResponse(){
    fixture();const auto identity=owner();const Baseline original;receipt("beginTransaction",identity,"active");
    require(finish(duplicate(identity)).at("ok")==true,"Rollback fixture duplicate failed");
    const auto rolled=receipt("rollbackTransaction",identity,"rolled-back");retire(identity);original.unchanged();
    require(rolled.at("receipt").at("terminal").at("duplicateRange").is_null(),"Rollback receipt retained marker");
    require(summary().at("canRedo")==true,"Rollback erased prior Redo");good({{"command","redo"}});require(masks()==Bytes({1,1,1,1,2}),"Rollback corrupted executable Redo");good({{"command","undo"}});
    const Baseline cancelled;auto pending=duplicate();require(pending.at("pending")==true,"Cancel fixture not pending");parsed(sv_step(8));good({{"command","cancel"}});cancelled.unchanged();
    const Baseline refused;sv_response::refuseNextSummaryForContracts();require(duplicate().at("ok")==false,"Admission response refusal ignored");refused.unchanged();
    require(duplicate().at("pending")==true,"Publication refusal fixture not pending");sv_response::refuseNextSummaryForContracts();
    require(parsed(sv_step(4096)).at("ok")==false,"Publication response refusal ignored");refused.unchanged();
    good({{"command","selectNone"}});const Baseline empty;require(finish(duplicate()).at("ok")==false,"Empty Duplicate accepted");empty.unchanged();
}
Json center(float x){
    const auto camera=summary().at("camera");return finish(good({{"command","alignCenter"},{"point",{x,0,0}},{"camera",camera},{"defaultCamera",camera}}));
}
Json reset(){const auto camera=summary().at("camera");return good({{"command","resetAlignment"},{"camera",camera},{"defaultCamera",camera}});}
void alignmentResetBoundary(){
    fixture();require(center(1).at("alignment").at("canReset")==true,"Old alignment baseline missing");
    const auto branch=summary().at("alignment").at("branchId"),frame=summary().at("alignment").at("frame");const Baseline aligned;
    const auto identity=owner();receipt("beginTransaction",identity,"active");require(finish(duplicate(identity)).at("ok")==true,"Aligned Duplicate failed");
    require(summary().at("alignment").at("branchId")==branch&&summary().at("alignment").at("frame")==frame&&summary().at("alignment").at("canReset")==false,"Duplicate changed coordinates or retained prior Reset");
    receipt("rollbackTransaction",identity,"rolled-back");retire(identity);aligned.unchanged();
    require(finish(duplicate()).at("ok")==true,"Aligned Duplicate retry failed");const auto grown=records();const auto grownMask=masks();const auto range=summary().at("duplicateRange");
    reset();require(same(records(),grown)&&masks()==grownMask,"Old alignment Reset resurrected smaller scene");
    require(center(.25f).at("alignment").at("canReset")==true&&summary().at("duplicateRange").is_null(),"Next alignment did not start fresh");
    reset();require(same(records(),grown)&&masks()==grownMask&&summary().at("duplicateRange")==range,"Fresh Reset did not restore grown baseline/range");
    good({{"command","undo"}});require(summary().at("count")==8&&summary().at("duplicateRange").is_null(),"Reset Undo topology wrong");
    good({{"command","redo"}});require(summary().at("count")==8&&summary().at("duplicateRange")==range,"Reset Redo marker wrong");
}
void toolRefusals(){
    fixture();good({{"command","beginSelection"}});const Baseline draft;require(duplicate().at("ok")==false,"Draft Duplicate admitted");draft.unchanged();good({{"command","cancelSelection"}});
    for(const char *name:{"beginColor","beginTransform","beginOpacity"}){
        Json request{{"command",name},{"selectedOnly",true}};if(std::string_view(name)=="beginTransform")request["kind"]="numeric";
        const auto result=good(request);const Baseline before;require(duplicate().at("ok")==false,"Retained tool Duplicate admitted");before.unchanged();
        if(std::string_view(name)=="beginColor")good({{"command","endColor"}});
        else if(std::string_view(name)=="beginTransform")good({{"command","endTransform"},{"id",result.at("transformSession").at("id")}});
        else good({{"command","endOpacity"},{"id",result.at("opacitySession").at("id")}});
    }
    const auto filter=good({{"command","beginFilter"},{"kind","sphere"}}).at("filter");const Baseline before;
    require(duplicate().at("ok")==false,"Filter Duplicate admitted");before.unchanged();good({{"command","cancelFilter"},{"id",filter.at("id")}});
    const auto camera=summary().at("camera");const auto floor=good({{"command","detectFloor"},{"camera",camera}});
    require(duplicate().at("ok")==false&&summary().at("pending")==true,"Duplicate cancelled/admitted active shape work");
    good({{"command","cancelFloor"},{"id",floor.at("floor").at("id")}});
}
size_t attempts{};bool backendFailed{};
void observe(const sv_allocation::Event &event) noexcept {
    if(event.kind==sv_allocation::EventKind::NewAttempt||event.kind==sv_allocation::EventKind::ContextAllocated)++attempts;
    if(event.kind==sv_allocation::EventKind::BackendFailure)backendFailed=true;
}
size_t publicationAllocation(size_t ordinal){
    fixture();const Baseline before;require(duplicate().at("pending")==true,"Allocation fixture not pending");
    attempts=0;backendFailed=false;sv_allocation::setObserverForContracts(observe);sv_allocation::failBackendAtForContracts(ordinal);
    const char *text=sv_step(4096);sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
    const auto count=attempts;const auto value=parsed(text);
    if(ordinal){require(backendFailed&&value.at("ok")==false,"Publication backend refusal not propagated");before.unchanged();
        good({{"command","redo"}});require(masks()==Bytes({1,1,1,1,2}),"Publication refusal damaged Redo");++allocationRefusals;}
    else require(value.at("ok")==true&&value.at("count")==8,"Allocation reference publication failed");return count;
}
void allocationSweep(){const auto count=publicationAllocation(0);require(count>0,"Publication allocation sweep empty");for(size_t i=1;i<=count;++i)publicationAllocation(i);}
struct Checkpoint {Json plan;Bytes bytes;};
Checkpoint capture(){
    Checkpoint out;out.plan=parsed(sv_recovery_prepare());require(out.plan.at("ok")==true&&out.plan.at("version")==2,"Plan2 missing");
    const auto total=out.plan.at("byteLength").get<unsigned>(),chunk=out.plan.at("maximumChunkBytes").get<unsigned>();
    for(unsigned offset=0;offset<total;){const auto n=std::min(chunk,total-offset);const auto *p=sv_recovery_read(offset,n);require(p&&sv_recovery_read_size()==n,"Checkpoint read failed");out.bytes.insert(out.bytes.end(),p,p+n);offset+=n;}
    sv_recovery_release();return out;
}
Json expected(const Json &p){return {{"codecVersion",3},{"currentLoadedCount",p.at("currentLoadedCount")},{"currentSourceCount",p.at("currentSourceCount")},
    {"currentDuplicateRange",p.at("currentDuplicateRange")},{"maximumGraphSplats",p.at("maximumGraphSplats")},{"originalSourceCount",5},
    {"revision",p.at("revision")},{"contentRevision",p.at("contentRevision")},{"nextContentRevision",p.at("nextContentRevision")}};}
Json restore(const Checkpoint &checkpoint,const Json &expect){
    const auto text=expect.dump();auto result=parsed(sv_recovery_restore_begin(unsigned(checkpoint.bytes.size()),expect.at("maximumGraphSplats").get<unsigned>(),budget,text.c_str()));
    if(result.at("ok")==false)return result;
    result=parsed(sv_recovery_restore_write(0,checkpoint.bytes.data(),unsigned(checkpoint.bytes.size())));
    require(result.at("ok")==true,"Restore write failed");return parsed(sv_recovery_restore_finish());
}
void recoveryTopology(){
    fixture();require(finish(duplicate()).at("ok")==true,"Recovery Duplicate failed");
    const auto grown=records();const auto mask=masks();const auto grownRange=summary().at("duplicateRange");const auto checkpoint=capture();const auto expectation=expected(checkpoint.plan);
    require(checkpoint.plan.at("currentLoadedCount")==8&&checkpoint.plan.at("currentSourceCount")==8&&
        checkpoint.plan.at("currentDuplicateRange")==grownRange&&checkpoint.plan.at("maximumGraphSplats")==8,"Grown plan omitted exact graph topology");
    for(const auto *field:{"currentLoadedCount","currentSourceCount","maximumGraphSplats","revision","originalSourceCount"}){
        auto wrong=expectation;wrong[field]=wrong[field].get<uint64_t>()+1;
        if(std::string_view(field)=="currentLoadedCount")wrong["currentDuplicateRange"]={{"first",5},{"count",4}};
        const Baseline before;require(restore(checkpoint,wrong).at("ok")==false,"Mismatched authenticated graph restored");sv_recovery_restore_cancel();before.unchanged();
    }
    {
        auto wrong=expectation;wrong["currentDuplicateRange"]={{"first",4},{"count",4}};const Baseline before;
        require(restore(checkpoint,wrong).at("ok")==false,"Wrong valid suffix restored");sv_recovery_restore_cancel();before.unchanged();
        wrong=expectation;wrong["codecVersion"]=2;
        require(restore(checkpoint,wrong).at("ok")==false,"Production restore granted legacy codec fallback");sv_recovery_restore_cancel();before.unchanged();
    }
    auto extra=expectation;extra["untrustedOverride"]=true;const Baseline before;
    require(restore(checkpoint,extra).at("ok")==false,"Unknown restore expectation field accepted");sv_recovery_restore_cancel();before.unchanged();
    require(restore(checkpoint,expectation).at("ok")==true&&same(records(),grown)&&masks()==mask&&summary().at("duplicateRange")==grownRange,"Restored graph lost grown bytes/mask/range");
    const Baseline guarded;require(finish(duplicate()).at("ok")==false,"Recovery lost untouched-copy guard");guarded.unchanged();
    good({{"command","undo"}});require(summary().at("count")==5&&summary().at("duplicateRange").is_null(),"Restored Undo lost smaller owner");
    const auto smaller=capture();require(smaller.plan.at("currentLoadedCount")==5&&smaller.plan.at("maximumGraphSplats")==8,"Smaller current plan lost grown Redo bound");
    require(restore(smaller,expected(smaller.plan)).at("ok")==true,"Smaller current/grown Redo restore failed");
    good({{"command","redo"}});require(summary().at("count")==8&&summary().at("duplicateRange")==grownRange,"Restored Redo lost grown range");
    fixture();require(summary().at("duplicateRange").is_null(),"Replacement source retained marker");
}
template<class F>void test(const char *name,F &&action){action();++cases;std::printf("PASS %s\n",name);}
}
int main(){
    try {
        test("actual SH3 append/current-view/history and topology receipts",bytesViewHistoryReceipts);
        test("transaction rollback, cancellation and response refusal",rollbackCancellationAndResponse);
        test("alignment Reset boundary and grown baseline",alignmentResetBoundary);
        test("retained tool/draft/shape ownership refusals",toolRefusals);
        test("actual publication intercepted-allocation sweep",allocationSweep);
        test("typed grown-graph restore, UndoRedo and marker ownership",recoveryTopology);
        std::printf("SPLATVIEW_DUPLICATE_BINDING_CONTRACTS_PASS cases=%zu checks=%zu allocationRefusals=%zu\n",cases,checks,allocationRefusals);return 0;
    }catch(const std::exception &error){
        sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);sv_recovery_restore_cancel();
        std::fprintf(stderr,"SPLATVIEW_DUPLICATE_BINDING_CONTRACTS_FAIL %s\n",error.what());return 1;
    }
}
