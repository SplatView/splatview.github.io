// Private executable: real ABI requests plus literal covariance/identity tests.
// Fault hooks and fixture observations never become shipping exports.
#include "browser_focus_bounds.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "resource_budget.hpp"
#include "model.hpp"
#include "color.hpp"
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
}
namespace {
using namespace preview;namespace bf=preview::browser_focus;using Json=nlohmann::json;
size_t cases{},checks{},refusals{},backendRefusals{},publicationRefusals{};uint64_t generation{},operationId{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F> void rejects(F action,const char *message){bool failed=false;try{action();}catch(...){failed=true;}require(failed,message);++refusals;}
template<class F> void test(const char *name,F action){action();++cases;std::printf("FOCUS_BOUNDS_GROUP_PASS %s\n",name);}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &request){const auto text=request.dump();return parsed(sv_command(text.c_str()));}
Json named(const char *name){return command({{"command",name}});}
Json summary(){return named("summary");}
Json good(const Json &request){const auto value=command(request);require(value.at("ok")==true,"Fixture command refused");return value;}
Json finish(Json value,unsigned batch=1){
    for(size_t step=0;value.value("pending",false);++step){
        require(step<10000,"Focus pump did not terminate");value=parsed(sv_step(batch));
        require(value.at("ok")==true,value.value("error",std::string("Native cooperative pump refused")).c_str());
    }
    return value;
}
std::vector<Gaussian> records(){const auto n=summary().at("count").get<size_t>();return {sv_scene_ptr(),sv_scene_ptr()+n};}
std::vector<uint8_t> masks(){const auto n=summary().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n};}
struct Baseline {
    Json value=summary();const Gaussian *scene=sv_scene_ptr();const uint8_t *mask=sv_states_ptr();
    std::vector<Gaussian> bytes=records();std::vector<uint8_t> states=masks();
    void unchanged(bool pending=false) const {
        const auto now=summary();
        for(const char *key:{"count","sourceCount","duplicateRange","selected","visible","canUndo","canRedo","revision","contentRevision","selectionCommitRevision",
                            "transaction","selectionDraft","alignment","colorSession","filter","transformSession","opacitySession",
                            "toleranceSessionId","toleranceTool","toleranceConnected","toleranceRange","toleranceRecorded","undoSelectionRevision","toleranceMapId","selectionMapId","pendingSelectionMapId",
                            "selectionMapBytes","selectionMapRetainedIds","camera","center","radius"})
            require(now.at(key)==value.at(key),"Readonly query changed scene identity/history/session metadata");
        if(!pending)require(now.at("pending")==value.at("pending")&&now.at("memoryBytes")==value.at("memoryBytes"),"Retired focus query leaked pending work or admission");
        const auto current=records();require(sv_scene_ptr()==scene&&sv_states_ptr()==mask&&states==masks()&&current.size()==bytes.size()&&
            !std::memcmp(current.data(),bytes.data(),current.size()*sizeof(Gaussian)),"Readonly query changed scene/mask ownership or bytes");
    }
};
struct Memory final:SceneMemory {
    size_t calls{},live{},maximum{},refuseAt{};
    std::shared_ptr<void> admit(size_t bytes) override {
        ++calls;if(calls==refuseAt)throw std::bad_alloc();
        auto grant=std::shared_ptr<void>(new size_t(bytes),[this](void *p){live-=*static_cast<size_t *>(p);delete static_cast<size_t *>(p);});
        live+=bytes;maximum=std::max(maximum,live);return grant;
    }
};
std::shared_ptr<Scene> scene(size_t count=3){
    auto value=std::make_shared<Scene>();value->gaussians.resize(count);value->center={111,222,333};value->sourceCount=count;
    for(auto &g:value->gaussians){g.positionOpacity={0,0,0,1};g.covA={1,0,0,1};g.covB={0,1,0,0};}
    if(count>=3){
        value->gaussians[0].positionOpacity={0,2,-4,0};value->gaussians[0].covA={1,0,0,4};value->gaussians[0].covB={0,9,0,0};
        value->gaussians[1].positionOpacity={10,-4,2,1};value->gaussians[1].covA={16,0,0,1};value->gaussians[1].covB={0,4,0,0};
        value->gaussians[2].positionOpacity={9999,9999,9999,1};
    }
    return value;
}
bf::Snapshot snapshot(const std::shared_ptr<Scene> &value,std::span<const uint8_t> states){
    auto mask=MaskStorage::copy(states);return {value,value,mask,mask,1,7,4,{}};
}
void literalAndBounded(){
    auto value=scene();const std::array<uint8_t,3> states{1,1,2};auto base=snapshot(value,states);auto memory=std::make_shared<Memory>();
    const auto before=value->gaussians;auto job=bf::Job::create(base,memory);
    require(memory->calls==1&&memory->live==sizeof(bf::Job)&&job->workDone()==0,"Capture performed work or allocated variable-size scratch");
    require(bf::scenePoint(base)==Vec3{111,222,333},"Scene query recomputed a selection center");
    require(job->step(0,base)==0&&job->workDone()==0&&!job->complete(),"Zero budget scanned geometry");
    for(size_t i=0;i<3;++i){require(job->step(1,base)==1&&job->lastStepWork()==1&&job->workDone()==i+1,"One-step bound exceeded");}
    require(job->complete()&&job->result()==Vec3{9.5f,.5f,-2.5f},"Covariance AABB midpoint differs from literal asymmetric oracle");
    require(job->result()!=Vec3{5,-1,-1},"Focus accidentally used arithmetic mean");
    require(!std::memcmp(before.data(),value->gaussians.data(),before.size()*sizeof(Gaussian)),"Bounds modified Gaussian bytes");
    bf::Job::retire(job);require(memory->live==0,"Fixed owner admission leaked");
    const std::array<uint8_t,3> empty{0,0,2};base=snapshot(value,empty);job=bf::Job::create(base,memory);job->step(3,base);
    require(job->complete()&&!job->result(),"Empty selection fell back to visible scene bounds");bf::Job::retire(job);
    const std::array<uint8_t,3> combinedDeleted{1,1,3};base=snapshot(value,combinedDeleted);job=bf::Job::create(base,memory);job->step(3,base);
    require(job->complete()&&job->result()==Vec3{9.5f,.5f,-2.5f},"Selected+deleted state was rejected or included in bounds");bf::Job::retire(job);
    const std::array<uint8_t,3> allDeleted{0,2,3};base=snapshot(value,allDeleted);job=bf::Job::create(base,memory);job->step(3,base);
    require(job->complete()&&!job->result(),"Combined deleted bit produced a selected focus");bf::Job::retire(job);
    value=scene(1);const std::array<uint8_t,1> oneSelected{1};auto &point=value->gaussians[0];
    const float tiny=std::numeric_limits<float>::denorm_min();point.positionOpacity={tiny,tiny,tiny,1};point.covA={};point.covB={};
    base=snapshot(value,oneSelected);job=bf::Job::create(base,memory);job->step(1,base);
    require(job->complete()&&job->result()==Vec3{tiny,tiny,tiny},"Finite desktop midpoint rounding lost a subnormal center");bf::Job::retire(job);
    const float huge=std::numeric_limits<float>::max();point.positionOpacity={huge,huge,huge,1};
    base=snapshot(value,oneSelected);job=bf::Job::create(base,memory);job->step(1,base);
    require(job->complete()&&job->result()==Vec3{huge,huge,huge},"Overflow fallback did not preserve a finite float32 midpoint");bf::Job::retire(job);
    value=scene(100000);std::vector<uint8_t> large(100000);large.back()=1;base=snapshot(value,large);
    const auto calls=memory->calls;job=bf::Job::create(base,memory);
    require(memory->calls==calls+1&&memory->live==sizeof(bf::Job)&&job->workDone()==0,"Large-scene capture was not constant-space");
    job->step(17,base);require(job->lastStepWork()==17&&job->workDone()==17,"Large-scene step exceeded bounded work");
    job->cancel();require(!job->complete()&&!job->result()&&job->step(100000,base)==0,"Cancelled job exposed a result");bf::Job::retire(job);
    require(memory->live==0&&memory->maximum==sizeof(bf::Job),"Job retained variable-size scratch");
}
void identityLateAndAdmission(){
    auto value=scene();const std::array<uint8_t,3> states{1,1,2};auto base=snapshot(value,states);auto memory=std::make_shared<Memory>();
    for(unsigned field=0;field<8;++field){auto job=bf::Job::create(base,memory);job->step(1,base);auto stale=base;
        switch(field){case 0:++stale.revision;break;case 1:++stale.contentRevision;break;case 2:++stale.generation;break;
        case 3:stale.currentScene=scene();break;case 4:stale.base=scene();break;
        case 5:stale.states=MaskStorage::copy(states);break;case 6:stale.currentStates=MaskStorage::copy(states);break;
        default:stale.transform=bf::TransformBase{1,2,0};}
        rejects([&]{job->step(1,stale);},"Stale identity/mask accepted after partial progress");require(!job->complete()&&!job->result(),"Stale job exposed partial result");bf::Job::retire(job);
    }
    memory->refuseAt=memory->calls+1;rejects([&]{bf::Job::create(base,memory);},"Fixed owner admission refusal ignored");memory->refuseAt=0;
    require(memory->live==0,"Refused owner leaked admission");
    value->gaussians[1].covA[0]=std::numeric_limits<float>::infinity();auto job=bf::Job::create(base,memory);
    require(job->workDone()==0,"Invalid late geometry was eagerly traversed");job->step(1,base);
    rejects([&]{job->step(1,base);},"Late nonfinite covariance accepted");require(!job->complete()&&!job->result(),"Late refusal exposed partial center");bf::Job::retire(job);
    value->gaussians[1].covA[0]=16;value->gaussians[1].positionOpacity[0]=std::numeric_limits<float>::max();
    value->gaussians[1].covA[0]=std::numeric_limits<float>::max();job=bf::Job::create(base,memory);
    // A finite extreme coordinate stays valid if the rounded float bounds do.
    job->step(3,base);require(job->complete()&&job->result()&&std::isfinite(job->result()->x),"Finite float32 midpoint overflowed");bf::Job::retire(job);
}
std::vector<uint8_t> input(){
    const std::string text="ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\n"
        "property float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n"
        "0 2 -4 0 .69314718056 1.09861228867 1 0 0 0 1 0 0 0\n"
        "10 -4 2 1.38629436112 0 .69314718056 1 0 0 0 1 0 0 0\n"
        "9999 9999 9999 0 0 0 1 0 0 0 1 0 0 0\n"
        "3 0 0 0 0 0 1 0 0 0 1 0 0 0\n";
    return {text.begin(),text.end()};
}
void fixture(){
    const auto bytes=input();require(parsed(sv_open(bytes.data(),bytes.size(),0,100,64*1024*1024)).at("ok")==true,"Gaussian fixture failed to open");++generation;
    good({{"command","single"},{"index",2},{"operation",0}});good({{"command","delete"}});
    good({{"command","single"},{"index",0},{"operation",0}});good({{"command","single"},{"index",1},{"operation",1}});
    good({{"command","single"},{"index",3},{"operation",1}});good({{"command","undo"}});
    require(masks()==std::vector<uint8_t>({1,1,2,0})&&summary().at("canRedo")==true,"Fixture selection/Redo differs");
}
Json focus(const char *scope="selection"){
    const auto now=summary();Json base=nullptr;
    if(!now.at("transformSession").is_null()){const auto &owner=now.at("transformSession");base={{"id",owner.at("id")},{"baseId",owner.at("baseId")},{"epoch",owner.at("epoch")}};}
    return {{"command","transformFocus"},{"scope",scope},{"revision",now.at("revision")},{"contentRevision",now.at("contentRevision")},{"transformBase",base}};
}
Json oracle(const std::vector<Gaussian> &values){
    std::array<float,3> low{},high{};low.fill(std::numeric_limits<float>::infinity());high.fill(-std::numeric_limits<float>::infinity());
    for(size_t i=0;i<2;++i){const auto &g=values[i];const std::array<float,3> diagonal{g.covA[0],g.covA[3],g.covB[1]};
        for(size_t k=0;k<3;++k){const float extent=3*std::sqrt(std::max(0.f,diagonal[k]));low[k]=std::min(low[k],g.positionOpacity[k]-extent);high[k]=std::max(high[k],g.positionOpacity[k]+extent);}}
    return Json::array({(low[0]+high[0])*.5f,(low[1]+high[1])*.5f,(low[2]+high[2])*.5f});
}
void actualReadonlyAndStrict(){
    fixture();require(sv_abi_version()==24&&parsed(sv_build_identity()).at("capabilities").at("transformPivot")==2,"Additive pivot capability/ABI mismatch");
    const Baseline before;auto admission=good(focus());require(admission.at("pending")==true&&!admission.contains("point"),"Selection scan did not admit cooperatively");
    require(parsed(sv_step(1)).at("pending")==true,"Partial scan prematurely published a center");
    auto result=finish(parsed(sv_step(1)));require(result.at("ok")==true&&result.contains("point")&&result.at("point")==oracle(before.bytes),"Actual query center differs from independent bounds oracle");before.unchanged();
    const auto scene=good(focus("scene"));require(!scene.at("pending").get<bool>()&&scene.at("point")==before.value.at("center"),"Scene focus was not immediate immutable center");before.unchanged();
    const auto valid=focus();std::vector<Json> malformed;
    for(const auto *key:{"scope","revision","contentRevision","transformBase"}){auto value=valid;value.erase(key);malformed.push_back(value);}
    for(const auto *key:{"selectionView","operationOwner","unexpected"}){auto value=valid;value[key]=nullptr;malformed.push_back(value);}
    for(const auto &bad:std::vector<Json>{true,-1,1.5,9007199254740992ULL,"7",nullptr}){auto value=valid;value["revision"]=bad;malformed.push_back(value);}
    for(const auto &bad:std::vector<Json>{false,"all",nullptr,0}){auto value=valid;value["scope"]=bad;malformed.push_back(value);}
    auto stale=valid;stale["revision"]=stale["revision"].get<uint64_t>()+1;malformed.push_back(stale);
    stale=valid;stale["contentRevision"]=stale["contentRevision"].get<uint64_t>()+1;malformed.push_back(stale);
    stale=valid;stale["transformBase"]={{"id",1},{"baseId",2},{"epoch",0}};malformed.push_back(stale);
    for(const auto &request:malformed){require(command(request).at("ok")==false,"Malformed/stale query accepted");++refusals;before.unchanged();}
    good({{"command","selectNone"}});const Baseline empty;result=finish(good(focus()));require(result.contains("point")&&result.at("point").is_null(),"Actual empty selection omitted explicit null point");empty.unchanged();
}
Json parameters(){return {{"mode","euler"},{"translation",{7,8,9}},{"scale",{1,1,1}},{"euler",{0,0,0}},{"pivot",{0,0,0}},{"flips",{false,false,false}}};}
void retainedCanonicalAndCancellation(){
    fixture();const auto original=records();const auto canonical=oracle(original);
    const auto &inside=original[0].positionOpacity;
    auto value=good({{"command","beginTransform"},{"kind","numeric"},{"selectedOnly",true},
        {"selectionView",{inside[0],inside[1],inside[2],0,0,5,1,60,1,0,1}}});
    auto owner=value.at("transformSession");const auto request=focus();const Baseline retained;
    require(owner.at("pivot")!=canonical,"Scoped fixture did not restrict the effective transform target");
    require(finish(good(request)).at("point")==canonical,"Focus used current-view effective targets instead of canonical selection");retained.unchanged();
    value=finish(good({{"command","applyTransform"},{"id",owner.at("id")},{"epoch",1},{"parameters",parameters()}}),64);
    require(value.at("ok")==true&&std::memcmp(original.data(),sv_scene_ptr(),original.size()*sizeof(Gaussian))!=0,"Retained bake fixture did not change geometry");
    require(!std::memcmp(&original[1],sv_scene_ptr()+1,sizeof(Gaussian)),"Scoped bake unexpectedly transformed outside canonical member");
    const Baseline baked;require(finish(good(focus())).at("point")==canonical,"Retained Apply fed translated coordinates back into pivot");baked.unchanged();
    require(good(focus("scene")).at("point")==retained.value.at("center"),"Retained scene focus ignored immutable base center");
    auto old=request;require(command(old).at("ok")==false,"Prior epoch focus accepted after retained Apply");++refusals;baked.unchanged();
    for(const auto *key:{"id","baseId","epoch"}){auto bad=focus();bad["transformBase"][key]=bad["transformBase"][key].get<uint64_t>()+1;require(command(bad).at("ok")==false,"Stale transform tuple accepted");++refusals;baked.unchanged();}
    auto bad=focus();bad["transformBase"]=nullptr;require(command(bad).at("ok")==false,"Ownerless focus escaped retained transform fence");++refusals;baked.unchanged();
    good(focus());parsed(sv_step(1));require(command(focus()).at("ok")==false&&summary().at("pending")==true,"Competing readonly query retired current scan");++refusals;baked.unchanged(true);
    good({{"command","cancel"}});baked.unchanged();
    good({{"command","endTransform"},{"id",owner.at("id")}});
    require(command(focus()).at("pending")==true,"Standalone query after session end failed");good({{"command","cancel"}});
}
Json operationScope(){return {{"version",1},{"documentId","11111111-1111-4111-8111-111111111111"},{"sourceGeneration",generation},{"clientGeneration","22222222-2222-4222-8222-222222222222"}};}
Json canonicalOracle(){
    const auto values=records();const auto states=masks();std::array<float,3> low{},high{};
    low.fill(std::numeric_limits<float>::infinity());high.fill(-std::numeric_limits<float>::infinity());bool selected=false;
    for(size_t i=0;i<states.size();++i)if(states[i]==1){selected=true;const auto &g=values[i];const std::array<float,3> diagonal{g.covA[0],g.covA[3],g.covB[1]};
        for(size_t k=0;k<3;++k){const float extent=3*std::sqrt(std::max(0.f,diagonal[k]));low[k]=std::min(low[k],g.positionOpacity[k]-extent);high[k]=std::max(high[k],g.positionOpacity[k]+extent);}}
    return selected ? Json::array({(low[0]+high[0])*.5f,(low[1]+high[1])*.5f,(low[2]+high[2])*.5f}) : Json(nullptr);
}
void settledToolsReadonly(){
    fixture();auto values=neutralColor;values[0]=1.3f;
    good({{"command","beginColor"},{"selectedOnly",true}});
    auto pending=good({{"command","grade"},{"selectedOnly",true},{"values",values}});
    {const Baseline before;require(command(focus()).at("ok")==false&&summary().at("pending")==true,"Focus retired active color bake");before.unchanged(true);++refusals;}
    finish(pending,3);{const Baseline before;const auto expected=canonicalOracle();require(finish(good(focus())).at("point")==expected,"Settled graded Color focus lost canonical coordinates");before.unchanged();}
    good({{"command","endColor"}});
    auto owner=good({{"command","beginOpacity"},{"selectedOnly",true}}).at("opacitySession");
    pending=good({{"command","applyOpacity"},{"id",owner.at("id")},{"epoch",1},{"scale",.5}});
    {const Baseline before;require(command(focus()).at("ok")==false&&summary().at("pending")==true,"Focus retired active opacity bake");before.unchanged(true);++refusals;}
    finish(pending,3);{const Baseline before;const auto expected=canonicalOracle();require(finish(good(focus())).at("point")==expected,"Settled applied opacity focus lost canonical coordinates");before.unchanged();}
    good({{"command","endOpacity"},{"id",owner.at("id")}});
    const auto colorId=100u;
    good({{"command","colorPick"},{"sessionId",colorId},{"index",0},{"operation",0},{"tolerance",1},{"camera",summary().at("camera")}});
    {const Baseline before;const auto expected=canonicalOracle();require(finish(good(focus())).at("point")==expected,"Settled Color tolerance focus refused or changed canonical selection");before.unchanged();
        require(good(focus("scene")).at("point")==before.value.at("center"),"Settled Color scene focus changed center");before.unchanged();}
    good({{"command","colorTolerance"},{"sessionId",colorId},{"tolerance",.5}});good({{"command","endTolerance"},{"sessionId",colorId}});
    // A literal depth surface gives Fill a captured map and checkpoint. Focus
    // must preserve both so subsequent tolerance amendments still work.
    std::vector<uint8_t> bytes(3*32);
    for(size_t i=0;i<3;++i){const std::array<float,6> point{float(i)*.5f,0,0,.01f,.01f,.01f};std::memcpy(bytes.data()+32*i,point.data(),24);
        const std::array<uint8_t,8> rest{80,120,160,128,255,128,128,128};std::memcpy(bytes.data()+32*i+24,rest.data(),8);}
    require(parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),100,64*1024*1024)).at("ok")==true,"Fill readonly fixture failed");++generation;
    constexpr unsigned fillMap=100,fillId=101,width=7,height=5;const auto camera=Json::array({0,0,0,0,0,3,1,90,1,0});
    good({{"command","selectionMapBegin"},{"mapId",fillMap},{"layoutVersion",1},{"fullWidth",width},{"fullHeight",height},{"mapWidth",width},{"mapHeight",height},{"sourceCount",3},{"channels",3}});
    {const Baseline before;require(command(focus()).at("ok")==false,"Focus accepted an unfinished selection-map upload");before.unchanged();++refusals;}
    std::vector<float> payload(width*height*2,.5f);std::fill(payload.begin(),payload.begin()+width*height,3.f);
    require(parsed(sv_map_write(fillMap,0,reinterpret_cast<const uint8_t *>(payload.data()),unsigned(payload.size()*4))).at("ok")==true,"Fill map write failed");
    good({{"command","selectionMapCommit"},{"mapId",fillMap}});
    good({{"command","fillPick"},{"sessionId",fillId},{"mapId",fillMap},{"camera",camera},{"width",width},{"height",height},{"seed",{3,2}},{"operation",0},{"tolerance",.1},{"visibleOnly",false},{"overlap",false}});
    require(summary().at("selected").get<size_t>()>0&&summary().at("toleranceTool")=="fill","Fill fixture did not capture selected surface");
    {const Baseline before;const auto expected=canonicalOracle();require(finish(good(focus())).at("point")==expected,"Settled Fill focus refused or changed canonical selection");before.unchanged();}
    good({{"command","fillTolerance"},{"sessionId",fillId},{"tolerance",.2}});good({{"command","endTolerance"},{"sessionId",fillId}});
    good({{"command","selectionMapRelease"},{"mapId",fillMap}});
}
void activeOwnerRefusals(){
    fixture();good({{"command","beginSelection"}});{const Baseline before;require(command(focus()).at("ok")==false,"Draft focus accepted");before.unchanged();++refusals;}good({{"command","cancelSelection"}});
    good({{"command","beginTransaction"}});{const Baseline before;require(command(focus()).at("ok")==false,"Transaction focus accepted");before.unchanged();++refusals;}good({{"command","rollbackTransaction"}});
    for(const char *name:{"beginColor","beginOpacity","beginFilter"}){
        Json begin{{"command",name}};if(std::string_view(name)=="beginFilter")begin["kind"]="sphere";else begin["selectedOnly"]=true;
        const auto value=good(begin);const Baseline before;
        if(std::string_view(name)=="beginFilter") {
            require(command(focus()).at("ok")==false,"Competing filter focus accepted");++refusals;
        } else require(finish(good(focus())).at("point")==oracle(before.bytes),"Settled color/opacity canonical focus refused or changed coordinates");
        before.unchanged();
        if(std::string_view(name)=="beginColor")good({{"command","endColor"}});
        else if(std::string_view(name)=="beginOpacity")good({{"command","endOpacity"},{"id",value.at("opacitySession").at("id")}});
        else good({{"command","cancelFilter"},{"id",value.at("filter").at("id")}});
    }
    good({{"command","operationBind"},{"operationScope",operationScope()}});auto owner=operationScope();owner["operationId"]=++operationId;
    good({{"command","beginTransaction"},{"operationOwner",owner}});good({{"command","commitTransaction"},{"operationOwner",owner}});
    {const Baseline before;require(command(focus()).at("ok")==false,"Unresolved operation receipt focus accepted");before.unchanged();++refusals;}
    good({{"command","operationRetire"},{"operationOwner",owner}});
    const auto floor=good({{"command","detectFloor"},{"camera",summary().at("camera")}});{const Baseline before;
        require(command(focus()).at("ok")==false&&summary().at("pending")==true,"Readonly refusal cancelled active analysis");before.unchanged();++refusals;}
    good({{"command","cancelFloor"},{"id",floor.at("floor").at("id")}});
}
void responseAndBackendRefusals(){
    fixture();const Baseline before;const auto refusedRequest=focus();sv_response::refuseNextSummaryForContracts();
    require(command(refusedRequest).at("ok")==false,"Admission response refusal ignored");++publicationRefusals;before.unchanged();
    bool reached=false;
    for(size_t ordinal=1;ordinal<200;++ordinal){const auto request=focus().dump();
        sv_allocation::failBackendAtForContracts(ordinal);
        const char *text=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);
        const auto value=parsed(text);
        if(value.at("ok")==true){good({{"command","cancel"}});before.unchanged();reached=true;break;}
        ++backendRefusals;before.unchanged();
    }
    require(reached&&backendRefusals>0,"Focus admission allocation sweep did not exercise refusal and success");
    good(focus());const auto result=finish(parsed(sv_step(65536)));require(result.at("ok")==true&&result.at("point")==oracle(before.bytes),"Refusal retry lost exact result");before.unchanged();
    good(focus());const auto replaced=input();require(parsed(sv_open(replaced.data(),replaced.size(),0,100,64*1024*1024)).at("ok")==true,"Source replacement failed");++generation;
    const auto terminal=parsed(sv_step(1));require(terminal.at("ok")==true&&!terminal.contains("point")&&!terminal.at("pending").get<bool>(),"Retired source query published a late point");
}
}
int main(){try{
    test("literal-covariance-empty-bounded",literalAndBounded);
    test("identity-late-admission",identityLateAndAdmission);
    test("actual-readonly-strict-fields",actualReadonlyAndStrict);
    test("retained-canonical-base-cancel",retainedCanonicalAndCancellation);
    test("settled-color-opacity-tolerance-fill-readonly",settledToolsReadonly);
    test("active-owner-refusals",activeOwnerRefusals);
    test("response-backend-source-retirement",responseAndBackendRefusals);
    std::printf("SPLATVIEW_FOCUS_BOUNDS_CONTRACTS_PASS cases=%zu checks=%zu refusals=%zu publication=%zu backend=%zu jobBytes=%zu\n",cases,checks,refusals,publicationRefusals,backendRefusals,sizeof(bf::Job));return 0;
}catch(const std::exception &error){sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"Focus bounds contracts failed cases=%zu checks=%zu: %s\n",cases,checks,error.what());return 1;}}
