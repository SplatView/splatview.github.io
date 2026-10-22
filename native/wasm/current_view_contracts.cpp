// Independent clip-cube literals plus actual CABI selection, session and
// history/refusal cases. No observation/fault entry point is shipped.
#include "browser_view_scope.hpp"
#include "selection_checkpoint.hpp"
#include "morphology_job.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "model.hpp"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const char *sv_live_preview(const char *);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
unsigned sv_export_output_bound(unsigned,unsigned,unsigned);unsigned sv_export_work_bound(unsigned,unsigned,unsigned);unsigned sv_output_len();
const uint8_t *sv_color_base_states_ptr(double,double,double);
const uint8_t *sv_transform_base_states_ptr(double,double,double);
const uint8_t *sv_opacity_base_states_ptr(double,double,double);
}
namespace {
using namespace preview;using Json=nlohmann::json;using Bytes=std::vector<uint8_t>;
size_t cases{},checks{},boundaries{},refusals{},sessions{},historyChecks{},backendRefusals{},backendControlAttempts{};
struct BackendObservation {size_t newAttempts{},blocks{},contexts{},failures{};} backendObservation;
void observeBackend(const sv_allocation::Event &event) noexcept {
    using K=sv_allocation::EventKind;
    if(event.kind==K::NewAttempt)++backendObservation.newAttempts;
    else if(event.kind==K::BlockAllocated)++backendObservation.blocks;
    else if(event.kind==K::ContextAllocated)++backendObservation.contexts;
    else if(event.kind==K::BackendFailure)++backendObservation.failures;
}
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void test(F f){f();++cases;}
Json command(const Json &request){const auto text=request.dump();return Json::parse(sv_command(text.c_str()));}
Json good(const Json &request){auto value=command(request);require(value.at("ok")==true,"Current view native command refused");return value;}
Json summary(){return good(Json{{"command","summary"}});}
Json finish(Json value){require(value.at("ok")==true,"Current view request refused");for(size_t i=0;value.value("pending",false);++i){require(i<100000,"Current view job did not complete");value=Json::parse(sv_step(3));require(value.at("ok")==true,"Current view pump refused");}return value;}
Json view(float x=0){return Json::array({x,0,0,0,0,5,1,60,1,0,1});}
Bytes mask(){const auto *p=sv_states_ptr();require(p,"Current view native mask absent");return {p,p+4};}
std::vector<Gaussian> gaussians(){const auto *p=sv_scene_ptr();require(p,"Current view native scene absent");return {p,p+4};}
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b){return a.size()==b.size()&&!std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));}
void open(){Bytes bytes(4*32);const std::array<float,4> x{0,100,.5f,200};
    for(size_t i=0;i<4;++i){const std::array<float,6> values{x[i],0,0,.1f,.1f,.1f};std::memcpy(bytes.data()+32*i,values.data(),24);
        const std::array<uint8_t,8> rest{80,120,160,128,255,128,128,128};std::memcpy(bytes.data()+32*i+24,rest.data(),8);}
    require(Json::parse(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),1000,64*1024*1024)).at("ok")==true,"Current view source refused");}
void expect(Bytes expected,const char *message){require(mask()==expected,message);}
Json parameters(){return {{"mode","euler"},{"translation",{1,0,0}},{"scale",{1,1,1}},{"pivot",{0,0,0}},{"flips",{false,false,false}},{"euler",{0,0,0}}};}
void literalPredicate(){
    test([]{browser_view_scope::Scope cube;cube.enabled=true;cube.matrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
        struct Literal {float x,y,z;bool expected;};const float outward=std::nextafter(1.f,2.f),below=std::nextafter(0.f,-1.f);
        const std::array<Literal,15> literals{{{0,0,.5f,true},{-1,0,.5f,true},{1,0,.5f,true},{0,-1,.5f,true},{0,1,.5f,true},{0,0,0,true},{0,0,1,true},
            {-outward,0,.5f,false},{outward,0,.5f,false},{0,-outward,.5f,false},{0,outward,.5f,false},{0,0,below,false},{0,0,outward,false},
            {std::numeric_limits<float>::infinity(),0,.5f,false},{std::numeric_limits<float>::quiet_NaN(),0,.5f,false}}};
        for(const auto &v:literals){Gaussian g;g.positionOpacity={v.x,v.y,v.z,1};require(cube.contains(g)==v.expected,"Homogeneous boundary differs from literal oracle");++boundaries;}
        Gaussian origin;origin.positionOpacity={0,0,0,1};cube.matrix[15]=0;require(!cube.contains(origin),"w=0 was included");cube.matrix[15]=-1;require(!cube.contains(origin),"Negative w was included");boundaries+=2;
    });
    test([]{require(!browser_view_scope::parse(Json::object()).enabled&&!browser_view_scope::parse(Json{{"selectionView",nullptr}}).enabled,"Absent scope is restricted");
        for(const auto &bad:std::array<Json,8>{Json::array(),Json::array({1,2}),Json(2),Json("view"),Json::object(),Json::array({0,0,0,0,0,0,1,60,1,0,1}),Json::array({0,0,0,0,0,5,1,60,1.0000000001,0,1}),Json::array({0,0,0,0,0,5,1,60,1,0,0})}){
            bool rejected=false;try{browser_view_scope::parse(Json{{"selectionView",bad}});}catch(...){rejected=true;}require(rejected,"Malformed current view accepted");++refusals;}
    });
}
void selectionContracts(){
    for(unsigned operation=0;operation<4;++operation)test([&]{open();good(Json{{"command","selectAll"}});good(Json{{"command","single"},{"index",0},{"operation",operation},{"selectionView",view()}});
        const std::array<Bytes,4> expected{Bytes{1,0,0,0},Bytes{1,0,1,0},Bytes{0,0,1,0},Bytes{1,0,0,0}};expect(expected[operation],"Scoped selection combination retained outside selection");});
    test([]{open();good(Json{{"command","selectAll"},{"selectionView",view()}});expect({1,0,1,0},"Select All ignored view");good(Json{{"command","invert"},{"selectionView",view()}});expect({0,0,0,0},"Scoped invert failed");
        good(Json{{"command","selectAll"}});const auto before=summary();good(Json{{"command","clipSelection"},{"selectionView",view()}});expect({1,0,1,0},"Enable did not clip");good(Json{{"command","undo"}});expect({1,1,1,1},"Clip Undo did not restore selection");good(Json{{"command","redo"}});expect({1,0,1,0},"Clip Redo failed");
        require(summary().at("contentRevision")==before.at("contentRevision"),"Selection clip dirtied content");historyChecks+=3;});
    test([]{open();good(Json{{"command","selectAll"}});good(Json{{"command","delete"},{"selectionView",view()}});expect({2,0,2,0},"Delete affected outside geometry");good(Json{{"command","restore"},{"selectionView",view()}});expect({0,0,0,0},"Restore was scoped");
        good(Json{{"command","single"},{"index",0},{"operation",0}});good(Json{{"command","crop"},{"selectionView",view()}});expect({1,0,2,0},"Crop removed outside geometry");good(Json{{"command","resetCleanup"},{"selectionView",view()}});expect({0,0,0,0},"Reset cleanup was scoped");});
    test([]{open();good(Json{{"command","single"},{"index",1},{"operation",0}});good(Json{{"command","crop"},{"selectionView",view()}});expect({0,0,0,0},"Empty eligible crop deleted geometry");});
    test([]{open();good(Json{{"command","selectAll"}});const auto old=summary();const auto original=mask();sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","clipSelection"},{"selectionView",view()}}).at("ok")==false,"Clip response refusal ignored");
        require(mask()==original&&summary().at("revision")==old.at("revision"),"Refused clip published states/history");++refusals;});
    test([]{open();good(Json{{"command","selectAll"}});auto camera=view();camera.erase(camera.end()-1);good(Json{{"command","beginSelection"}});
        Json request{{"command","rectangle"},{"camera",camera},{"width",1000},{"height",1000},{"rectangle",{0,0,999,999}},{"operation",0},{"fromBaseline",true},{"selectionView",view()}};
        const auto text=request.dump();require(Json::parse(sv_live_preview(text.c_str())).at("ok")==true,"Scoped live rectangle refused");expect({1,0,1,0},"Scoped live selector ignored fixed request view");good(Json{{"command","cancelSelection"}});expect({1,1,1,1},"Scoped live cancel lost baseline");});
    test([]{open();good(Json{{"command","selectAll"}});auto camera=view();camera.erase(camera.end()-1);
        good(Json{{"command","colorPick"},{"camera",camera},{"index",0},{"operation",0},{"tolerance",1},{"sessionId",1},{"selectionView",view()}});expect({1,0,1,0},"Scoped Color pick omitted view");
        good(Json{{"command","colorTolerance"},{"sessionId",1},{"tolerance",.5},{"selectionView",view(100)}});expect({1,0,1,0},"Color tolerance changed its captured view");good(Json{{"command","endTolerance"},{"sessionId",1}});
        good(Json{{"command","selectAll"}});good(Json{{"command","color"},{"camera",camera},{"index",1},{"operation",0},{"tolerance",1},{"selectionView",view()}});expect({0,0,0,0},"Outside Color seed produced hits");});
    test([]{open();good(Json{{"command","selectAll"}});const auto id=good(Json{{"command","beginFilter"},{"kind","sphere"}}).at("filter").at("id");
        finish(command(Json{{"command","previewFilter"},{"id",id},{"epoch",1},{"kind","sphere"},{"parameters",{{"center",{0,0,0}},{"radius",1000}}},{"operation",1},{"selectionView",view()}}));expect({1,0,1,0},"Filter ignored current view");
        finish(command(Json{{"command","previewFilter"},{"id",id},{"epoch",2},{"kind","sphere"},{"parameters",{{"center",{0,0,0}},{"radius",1000}}},{"operation",1},{"selectionView",view(100)}}));expect({0,1,0,0},"Filter did not refresh camera");good(Json{{"command","cancelFilter"},{"id",id}});expect({1,1,1,1},"Filter cancel lost original selection");});
}
void sessionContracts(){
    test([]{open();good(Json{{"command","selectAll"}});const auto original=gaussians();auto value=good(Json{{"command","beginOpacity"},{"selectedOnly",true},{"selectionView",view()}});const auto owner=value.at("opacitySession");const auto id=owner.at("id").get<uint64_t>(),base=owner.at("baseId").get<uint64_t>();
        expect({1,1,1,1},"Beginning opacity clipped canonical mask");const auto *target=sv_opacity_base_states_ptr(id,base,0);require(target&&Bytes(target,target+4)==Bytes({1,0,1,0}),"Opacity target mask omitted scope");require(!sv_opacity_base_states_ptr(id,base+1,0),"Opacity stale target identity accepted");
        value=finish(command(Json{{"command","applyOpacity"},{"id",id},{"epoch",1},{"scale",.5}}));expect({1,0,1,0},"Opacity edit and clip were not atomic");const auto baked=gaussians();for(size_t i=0;i<4;++i)require(baked[i].positionOpacity[3]==original[i].positionOpacity[3]*(i==0||i==2?.5f:1.f),"Opacity targeted an outside splat");
        finish(command(Json{{"command","resetOpacity"},{"id",id},{"epoch",2}}));expect({1,1,1,1},"Opacity Reset lost original mask");require(same(gaussians(),original),"Opacity Reset lost original bytes");good(Json{{"command","endOpacity"},{"id",id}});
        good(Json{{"command","undo"}});expect({1,0,1,0},"Reset Undo mask wrong");good(Json{{"command","undo"}});expect({1,1,1,1},"One edit Undo did not restore clip and attributes together");require(same(gaussians(),original),"Atomic edit Undo bytes wrong");sessions++;historyChecks+=2;});
    test([]{open();good(Json{{"command","selectAll"}});const auto original=gaussians();auto value=good(Json{{"command","beginTransform"},{"kind","numeric"},{"selectedOnly",true},{"selectionView",view()}});const auto owner=value.at("transformSession");const auto id=owner.at("id").get<uint64_t>(),base=owner.at("baseId").get<uint64_t>();
        const auto *target=sv_transform_base_states_ptr(id,base,0);require(target&&Bytes(target,target+4)==Bytes({1,0,1,0}),"Transform target mask omitted scope");expect({1,1,1,1},"Transform begin mutated canonical mask");
        finish(command(Json{{"command","applyTransform"},{"id",id},{"epoch",1},{"parameters",parameters()}}));expect({1,0,1,0},"Transform did not publish clip");const auto baked=gaussians();for(size_t i=0;i<4;++i)require(baked[i].positionOpacity[0]==original[i].positionOpacity[0]+(i==0||i==2?1:0),"Transform moved outside source");
        good(Json{{"command","resetTransform"},{"id",id},{"epoch",2}});expect({1,1,1,1},"Transform Reset lost original mask");require(same(gaussians(),original),"Transform Reset lost bytes");good(Json{{"command","endTransform"},{"id",id}});++sessions;});
    test([]{open();good(Json{{"command","selectAll"}});const auto original=gaussians();const auto value=good(Json{{"command","beginColor"},{"selectedOnly",true},{"selectionView",view()}});const auto owner=value.at("colorSession");const auto id=owner.at("sessionId").get<uint64_t>(),base=owner.at("baseId").get<uint64_t>(),epoch=owner.at("epochId").get<uint64_t>();
        const auto *target=sv_color_base_states_ptr(id,base,epoch);require(target&&Bytes(target,target+4)==Bytes({1,0,1,0}),"Color target mask omitted scope");require(!sv_color_base_states_ptr(id,base,epoch+1),"Color stale target identity accepted");expect({1,1,1,1},"Color begin clipped canonical mask");
        auto values=neutralColor;values[0]=1.5f;finish(command(Json{{"command","grade"},{"values",values},{"selectedOnly",true},{"selectionView",view(100)}}));expect({1,0,1,0},"Color target followed later camera");const auto baked=gaussians();require(std::memcmp(&original[1],&baked[1],sizeof(Gaussian))==0&&std::memcmp(&original[3],&baked[3],sizeof(Gaussian))==0,"Color changed outside splat");
        require(std::memcmp(&original[0],&baked[0],sizeof(Gaussian))!=0,"Color failed to change eligible target");good(Json{{"command","endColor"}});good(Json{{"command","undo"}});expect({1,1,1,1},"Color Undo did not restore complete selection");require(same(gaussians(),original),"Color Undo bytes wrong");++sessions;++historyChecks;});
    test([]{for(const char *begin:{"beginColor","beginOpacity","beginTransform"}){open();good(Json{{"command","single"},{"index",1},{"operation",0}});Json request{{"command",begin},{"selectedOnly",true},{"selectionView",view()}};if(std::strcmp(begin,"beginTransform")==0)request["kind"]="numeric";
        const auto before=summary();require(command(request).at("ok")==false,"Empty current-view selected edit accepted");require(mask()==Bytes({0,1,0,0})&&summary().at("revision")==before.at("revision"),"Empty scoped edit changed canonical mask/history");++refusals;}});
    test([]{open();good(Json{{"command","selectAll"}});const auto original=gaussians();const auto value=good(Json{{"command","beginOpacity"},{"selectedOnly",false},{"selectionView",view()}});const auto id=value.at("opacitySession").at("id");
        finish(command(Json{{"command","applyOpacity"},{"id",id},{"epoch",1},{"scale",0}}));expect({1,1,1,1},"Whole-scene opacity clipped selection");for(const auto &g:gaussians())require(g.positionOpacity[3]==0,"Whole-scene opacity obeyed current-view scope");good(Json{{"command","endOpacity"},{"id",id}});
        good(Json{{"command","undo"}});require(same(original,gaussians()),"Global opacity Undo failed");});
    test([]{open();good(Json{{"command","selectAll"}});const auto original=gaussians();finish(command(Json{{"command","alignCenter"},{"point",{1,0,0}},{"camera",view()},{"defaultCamera",view()},{"selectionView",view()}}));
        expect({1,1,1,1},"Alignment clipped selection");const auto aligned=gaussians();for(size_t i=0;i<4;++i)require(aligned[i].positionOpacity[0]==original[i].positionOpacity[0]-1,"Alignment obeyed current-view scope");
        good(Json{{"command","export"},{"format",2},{"scope",0},{"outputCapacity",sv_export_output_bound(2,4,0)},{"nativeWorkBytes",sv_export_work_bound(2,4,0)},{"selectionView",view()}});require(sv_output_len()==4*32,"Whole-scene export obeyed current-view scope");});
}
void morphologyContracts(){
    test([]{ResourceBudget resources(1024*1024);auto work=sceneMemoryForBudget(resources,ResourceCategory::Work),history=sceneMemoryForBudget(resources,ResourceCategory::History);auto scene=std::make_shared<Scene>();scene->gaussians.resize(2);scene->radius=1;
        scene->gaussians[0].positionOpacity={.9f,0,.5f,1};scene->gaussians[1].positionOpacity={1.1f,0,.5f,1};for(auto &g:scene->gaussians){g.covA={1,0,0,1};g.covB={0,1,0,0};}
        SceneEdits edits(scene,history,work);edits.selectSingle(1,SelectOperation::Set);browser_view_scope::Scope cube;cube.enabled=true;cube.matrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
        for(const auto method:{browser_morphology::Method::Sigma,browser_morphology::Method::Volume}) {
            edits.selectSingle(1,SelectOperation::Set);
            auto job=BrowserMorphologyJob::create(edits,true,1,work,cube,method);for(size_t i=0;!job->complete();++i){require(i<10000,"Scoped morphology failed to complete");require(job->step(1)<=1,"Scoped morphology exceeded step budget");}
            BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result());require(edits.states()[0]==0&&edits.states()[1]==0,"Outside selection seeded morphology or survived clipping");
            job.reset();
            edits.selectSingle(0,SelectOperation::Set);
            job=BrowserMorphologyJob::create(edits,false,1,work,cube,method);for(size_t i=0;!job->complete();++i){require(i<10000,"Scoped Shrink failed to complete");require(job->step(1)<=1,"Scoped Shrink exceeded step budget");}
            BrowserSelectionAccess::publishMorphology(edits,job->baseline(),job->result());require(edits.states()[0]==1&&edits.states()[1]==0,"Outside neighbor affected scoped Shrink");
        }
        require(resources.usage().totalBytes>0,"Morphology history unexpectedly absent");});
}
void backendContracts(){
    for(const char *begin:{"beginColor","beginOpacity","beginTransform"})test([&]{
        open();good(Json{{"command","selectAll"}});
        Json request{{"command",begin},{"selectedOnly",true},{"selectionView",view()}};if(std::strcmp(begin,"beginTransform")==0)request["kind"]="numeric";
        const auto text=request.dump();
        backendObservation={};sv_allocation::setObserverForContracts(observeBackend);
        const auto *controlReply=sv_command(text.c_str());sv_allocation::setObserverForContracts(nullptr);
        const auto observed=backendObservation;const auto control=Json::parse(controlReply);
        require(control.at("ok")==true,"Unfaulted scope-allocation control refused its valid request");
        // In the successful control every ordinary new attempt reaches one
        // successful backend block, regardless of census owner; Scope's setup
        // backend emits ContextAllocated instead. Their sum therefore matches
        // failBackendAt's ALL-backend ordinal numbering, without wrapper work.
        require(!observed.failures&&observed.newAttempts==observed.blocks&&observed.contexts>0,
            "Scope control could not account for every backend attempt");
        const size_t attempts=observed.blocks+observed.contexts;backendControlAttempts+=attempts;
        require(attempts>0,"Scope allocation control observed no backend attempts");
        bool reached=false;Json lastReply;
        for(size_t ordinal=1;ordinal<=attempts+1;++ordinal){open();good(Json{{"command","selectAll"}});const auto baseline=gaussians();const auto oldMask=mask();const auto old=summary();
            backendObservation={};sv_allocation::setObserverForContracts(observeBackend);sv_allocation::failBackendAtForContracts(ordinal);
            const auto *reply=sv_command(text.c_str());sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
            const auto failed=backendObservation.failures;const auto value=Json::parse(reply);
            if(value.at("ok")==true){require(!failed,"Scoped session published after a backend allocation refusal");reached=true;break;}
            ++backendRefusals;lastReply=value;require(failed>0,"Scope sweep refused a valid request without its injected backend failure");
            require(mask()==oldMask&&same(gaussians(),baseline)&&summary().at("revision")==old.at("revision"),"Scope allocation refusal changed document/history");
        }
        if(!reached)throw std::runtime_error(std::string("Scope allocation failure sweep never reached success: ")+begin+
            " measured="+std::to_string(attempts)+" last="+lastReply.dump());
        require(reached,"Scope allocation failure sweep never reached success");});
    test([]{Scene scene;scene.gaussians.resize(4);const auto original=MaskStorage::copy(Bytes{1,1,1,1});
        browser_view_scope::Scope cube;cube.enabled=true;cube.matrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
        ResourceBudget tiny(3);bool refused=false;try{browser_view_scope::effective(scene,original,cube,sceneMemoryForBudget(tiny,ResourceCategory::Work));}catch(...){refused=true;}
        require(refused&&tiny.usage().totalBytes==0&&original==MaskStorage::copy(Bytes{1,1,1,1}),"Target-mask quota refusal retained work or changed original bytes");++refusals;});
}
}
int main(){try{literalPredicate();require(sv_abi_version()==24&&Json::parse(sv_build_identity()).at("capabilities").at("currentViewScope")==1,"Current view ABI/capability mismatch");selectionContracts();sessionContracts();morphologyContracts();backendContracts();
    std::printf("SPLATVIEW_CURRENT_VIEW_CONTRACTS_PASS cases=%zu checks=%zu boundaries=%zu refusals=%zu sessions=%zu history=%zu backend=%zu backendControlAttempts=%zu morphologyOwnerBytes=%zu\n",cases,checks,boundaries,refusals,sessions,historyChecks,backendRefusals,backendControlAttempts,sizeof(BrowserMorphologyJob));return 0;
}catch(const std::exception &e){sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);std::fprintf(stderr,"SPLATVIEW_CURRENT_VIEW_CONTRACTS_FAIL %s\n",e.what());return 1;}}
