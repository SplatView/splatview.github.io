// Actual linked adapter contracts. Literal geometry and the pinned Recipe
// kernel are independent oracles; all fault seams are main-only, never exported.
#include "browser_transform_session.hpp"
#include "processing.hpp"
#include "editing.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "model.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <vector>
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const char *sv_live_preview(const char *);const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const uint32_t *sv_pack_transform_base(double,double,double,unsigned,unsigned);
const uint8_t *sv_transform_base_states_ptr(double,double,double);unsigned sv_pack_len();
}
namespace {
using namespace preview;namespace bt=preview::browser_transform;using Json=nlohmann::json;
size_t cases{},checks{},refusals{},publications{},backendRefusals{},cancelPhases{},bakes{};
void require(bool condition,const char *message){++checks;if(!condition)throw std::runtime_error(message);}
void close(double a,double b,const char *message,double tolerance=2e-5){require(std::abs(a-b)<=tolerance*std::max({1.,std::abs(a),std::abs(b)}),message);}
template<class F>void test(F action){action();++cases;}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &input){const auto text=input.dump();return parsed(sv_command(text.c_str()));}
Json command(const char *text){return parsed(sv_command(text));}
Json summary(){return command(R"({"command":"summary"})");}
Json wire(const bt::Parameters &p){
    Json value={{"pivot",p.pivot},{"flips",p.flips}};
    if(p.mode==bt::Mode::Matrix){value["mode"]="matrix";value["matrix"]=p.matrix;return value;}
    value["translation"]=p.translation;value["scale"]=p.scale;
    if(p.mode==bt::Mode::Euler){value["mode"]="euler";value["euler"]=p.euler;}
    else if(p.mode==bt::Mode::Quaternion){value["mode"]="quaternion";value["quaternion"]=p.quaternion;}
    else {value["mode"]="axis-angle";value["axis"]=p.axis;value["angle"]=p.angle;}return value;
}
Recipe recipe(const bt::Parameters &p){
    if(p.mode==bt::Mode::Matrix)return {{"matrix",p.matrix}};
    Recipe value={{"translation",p.translation},{"scale",p.scale},{"center",p.pivot}};
    if(p.mode==bt::Mode::Euler)value["euler"]=p.euler;
    else if(p.mode==bt::Mode::Quaternion)value["rotation"]=p.quaternion;
    else {std::array<float,3> vector{};const auto n=std::hypot(p.axis[0],p.axis[1],p.axis[2]);
        if(n>1e-8f)for(size_t i=0;i<3;++i)vector[i]=p.axis[i]/n*p.angle*3.14159265358979323846f/180;value["axis_angle"]=vector;}
    return value;
}
std::array<processing_detail::Affine,4> oracle(const bt::Parameters &p,size_t &count){
    std::array<processing_detail::Affine,4> steps;steps[0]=processing_detail::transform(recipe(p));count=1;
    const std::array<std::array<float,3>,3> rotations{{{0,180,0},{180,0,0},{0,0,180}}};
    for(size_t axis=0;axis<3;++axis)if(p.flips[axis])steps[count++]=processing_detail::transform(Recipe{{"euler",rotations[axis]},{"center",p.pivot}});
    return steps;
}
std::shared_ptr<Scene> scene(size_t count=7){
    auto value=std::make_shared<Scene>();value->shDegree=3;value->sourceCount=count+13;value->format="contract";
    value->sourceContentKey="fixed-content";value->sourceFileIdentity="fixed-file";value->sourceBytes=123;
    value->alignmentFrame[12]=7;value->defaultView=SavedView{{1,2,3},.1f,.2f,4,60,true,.3f};
    for(size_t i=0;i<count;++i){Gaussian g;g.positionOpacity={float(i%19)*.13f-1,float(i%13)*.19f-1,float(i%11)*.23f-1,i%4?1.f:0.f};
        if(i%31==30)g.positionOpacity[0]=1000;
        g.covA={.01f,.002f,.003f,.02f};g.covB={.004f,.03f,7,8};for(size_t k=0;k<24;++k)g.sh[k]=uint32_t(i*31+k+123);
        value->gaussians.push_back(g);}
    fitBounds(*value);return value;
}
bt::Owner owner(const std::shared_ptr<Scene> &base,const std::shared_ptr<SceneMemory> &memory,bool selected=false){
    std::vector<uint8_t> states(base->gaussians.size());for(size_t i=0;i<states.size();++i)states[i]=i%3==0?0:i%3==1?1:2;
    auto mask=MaskStorage::copy(states,memory);bt::Owner o;o.id=1;o.baseId=2;o.epoch=1;o.base=base;o.states=mask;o.selectedOnly=selected;
    o.acknowledged={base,mask,1,0,0,true};return o;
}
void finish(bt::Job &job,size_t batch=17){
    for(size_t steps=0;job.status()==bt::Status::Working;++steps){require(!job.result(),"Partial transform scene escaped");job.step(batch);
        require(job.lastStepWork()<=batch,"Transform exceeded supplied work budget");require(steps<2'000'000,"Transform job did not terminate");}
    require(job.status()==bt::Status::Ready&&bool(job.result()),"Transform job did not publish a ready result");++bakes;
}
void compare(const Scene &a,const Scene &b){
    require(a.gaussians.size()==b.gaussians.size(),"Transform changed record count");
    for(size_t i=0;i<a.gaussians.size();++i)require(std::memcmp(&a.gaussians[i],&b.gaussians[i],sizeof(Gaussian))==0,"Gaussian bytes differ from sequential portable recipe oracle");
    require(a.center==b.center&&a.radius==b.radius&&a.previewEye==b.previewEye,"Cooperative bounds differ from portable fitBounds");
    require(a.alignmentFrame==b.alignmentFrame&&a.defaultView==b.defaultView&&a.sourceContentKey==b.sourceContentKey&&a.sourceFileIdentity==b.sourceFileIdentity&&a.sourceBytes==b.sourceBytes,
        "Transform changed preserved/default-view source metadata");
}
void mathContracts(){
    test([]{for(unsigned mode=0;mode<4;++mode)for(unsigned flags=0;flags<8;++flags){
        bt::Parameters p;p.mode=static_cast<bt::Mode>(mode);p.translation={2,-3,4};p.scale={1.5f,.7f,2};p.pivot={1,-2,.5f};p.euler={17,-23,31};
        p.quaternion={2,.3f,-.5f,.7f};p.axis={2,3,4};p.angle=37;p.matrix={1,.2f,.3f,4,.4f,2,.5f,-3,.6f,.7f,3,2,0,0,0,1};
        for(unsigned axis=0;axis<3;++axis)p.flips[axis]=(flags>>axis)&1;
        bt::Plan plan;require(bt::plan(p,plan),"Valid composition refused");size_t count;const auto expected=oracle(p,count);require(plan.count==count,"Flip step count differs");
        for(size_t step=0;step<count;++step)for(size_t r=0;r<3;++r){require(plan.steps[step].t[r]==expected[step].t[r],"Pivot/translation arithmetic differs from portable recipe");
            for(size_t c=0;c<3;++c)require(plan.steps[step].a[r][c]==expected[step].a[r][c],"Rotation/scale arithmetic differs from portable recipe");}
        for(const std::array<double,3> point:std::array<std::array<double,3>,3>{{{1,2,3},{-3,1,2},{0,0,0}}}){
            auto transformed=point;for(size_t step=0;step<count;++step)transformed=expected[step].point(transformed);
            for(size_t r=0;r<3;++r){double actual=plan.matrix[12+r];for(size_t c=0;c<3;++c)actual+=plan.matrix[c*4+r]*point[c];close(actual,transformed[r],"Composed matrix differs from sequential reference");}}
        require(wire(bt::parameters(wire(p)))==wire(p),"Active DTO parser changed active parameters");
    }});
    test([]{bt::Parameters p;p.euler={0,0,90};p.scale={2,3,4};p.pivot={1,2,3};p.translation={5,6,7};bt::Plan plan;require(bt::plan(p,plan),"Literal Euler refused");
        const auto transformed=plan.steps[0].point({2,2,3});close(transformed[0],6,"Literal pivot X failed");close(transformed[1],10,"Literal Rz/scale Y failed");close(transformed[2],10,"Literal pivot Z failed");
        p={};p.mode=bt::Mode::Matrix;p.matrix={0,0,0,2,0,-1,.2f,3,0,0,0,4,0,0,0,1};require(bt::plan(p,plan),"Singular/reflected/sheared affine refused");
        require(plan.matrix[12]==2&&plan.matrix[13]==3&&plan.matrix[14]==4&&plan.matrix[6]==0&&plan.matrix[9]==.2f,"Nonsymmetric row-major affine conversion failed");
        for(float scale:{0.f,-1.f,1000001.f}){p={};p.scale[0]=scale;require(!bt::plan(p,plan),"Invalid portable Scale accepted");++refusals;}
        p={};p.mode=bt::Mode::Quaternion;p.quaternion={0,0,0,0};require(!bt::plan(p,plan),"Zero quaternion accepted");++refusals;
        p={};p.mode=bt::Mode::AxisAngle;p.axis={0,0,0};p.angle=300;require(bt::plan(p,plan)&&bt::identity(plan),"Captured zero-axis fallback changed");
        for(auto input:std::array<Json,3>{{{{"mode","matrix"},{"matrix",identityMatrix},{"pivot",{0,0,0}},{"flips",{0,0,0}}},
            {{"mode","euler"},{"translation",{0,0,0}},{"scale",{1,1,1}},{"pivot",{0,0,0}},{"flips",{false,false,false}}},
            {{"mode","matrix"},{"matrix",identityMatrix},{"pivot",{0,0,0}},{"flips",{false,false,false}},{"extra",1}}}}){bool rejected=false;try{bt::parameters(input);}catch(...){rejected=true;}require(rejected,"Invalid active-key DTO accepted");++refusals;}
    });
}
void jobContracts(){
    test([]{for(unsigned mode=0;mode<4;++mode)for(bool selected:{false,true}){
        ResourceBudget budget(16*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene();auto captured=owner(base,memory,selected);
        bt::Parameters p;p.mode=static_cast<bt::Mode>(mode);p.euler={17,23,31};p.quaternion={1,.2f,.3f,.4f};p.axis={1,2,3};p.angle=47;
        p.translation={3,-2,1};p.scale={1.2f,.8f,2};p.pivot={1,2,3};p.flips={true,true,true};p.matrix={1,.2f,0,4,0,2,.3f,5,.4f,0,3,6,0,0,0,1};
        bt::Plan plan;require(bt::plan(p,plan),"Job plan refused");const auto before=base->gaussians;auto expected=*base;size_t count;const auto steps=oracle(p,count);
        for(size_t i=0;i<expected.gaussians.size();++i)if(!(captured.states[i]&2)&&(!selected||(captured.states[i]&1)))for(size_t s=0;s<count;++s)steps[s].apply(expected.gaussians[i]);
        expected.defaultView.reset();fitBounds(expected);
        auto job=bt::Job::create(captured,p,plan,memory);require(budget.usage().totalBytes==captured.states.size()+sizeof(bt::Job),"Capture allocated source-sized work");
        require(job->step(0)==bt::Status::Working&&job->workDone()==0,"Zero work advanced transform");finish(*job,3);compare(*job->result(),expected);
        require(std::memcmp(base->gaussians.data(),before.data(),before.size()*sizeof(Gaussian))==0,"Transform bake mutated immutable baseline");bt::Job::retire(job);require(budget.usage().totalBytes==captured.states.size(),"Transform retirement leaked work grants");
    }});
    test([]{ResourceBudget budget(64*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene(20017);auto captured=owner(base,memory);
        bt::Parameters p;p.translation={.5f,-1,.75f};bt::Plan plan;require(bt::plan(p,plan),"Large bounds plan refused");auto expected=*base;
        for(size_t i=0;i<expected.gaussians.size();++i)if(!(captured.states[i]&2))processing_detail::transform(recipe(p)).apply(expected.gaussians[i]);expected.defaultView.reset();fitBounds(expected);
        auto job=bt::Job::create(captured,p,plan,memory);finish(*job,101);compare(*job->result(),expected);bt::Job::retire(job);
    });
    test([]{ResourceBudget budget(4*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene(31);auto captured=owner(base,memory);bt::Parameters p;p.translation[0]=2;bt::Plan plan;require(bt::plan(p,plan),"Cancellation plan failed");
        const auto usage=budget.usage().totalBytes;for(unsigned target=0;target<=unsigned(bt::Phase::Finish);++target){auto job=bt::Job::create(captured,p,plan,memory);
            for(size_t step=0;unsigned(job->phase())!=target&&job->status()==bt::Status::Working;++step){job->step(1);require(step<10000,"Cancellation target unreachable");}
            require(unsigned(job->phase())==target,"Cancellation phase not visited");job->cancel();require(job->status()==bt::Status::Cancelled&&!job->result(),"Cancellation exposed partial scene");bt::Job::retire(job);
            require(budget.usage().totalBytes==usage,"Phase cancellation leaked admission");++cancelPhases;}
        ResourceBudget tiny(sizeof(bt::Job)-1);bool refused=false;try{bt::Job::create(captured,p,plan,sceneMemoryForBudget(tiny,ResourceCategory::Work));}catch(...){refused=true;}
        require(refused&&tiny.usage().totalBytes==0,"Owner admission failure leaked or was ignored");++refusals;
    });
}
std::string input(){return "ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n-1 1 2 -3 -3 -3 1 0 0 0 1 0 0 0\n0 2 3 -3 -3 -3 1 0 0 0 1 0 0 0\n1 3 4 -3 -3 -3 1 0 0 0 1 0 0 0\n";}
Json open(){const auto text=input();return parsed(sv_open(reinterpret_cast<const uint8_t *>(text.data()),text.size(),unsigned(InputFormat::Auto),1000,64*1024*1024));}
std::vector<Gaussian> nativeScene(){const auto *data=sv_scene_ptr();require(data,"Native scene missing");return {data,data+3};}
std::vector<uint8_t> nativeMask(){const auto *data=sv_states_ptr();require(data,"Native mask missing");return {data,data+3};}
bool equal(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b){return a.size()==b.size()&&std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian))==0;}
Json finishNative(Json value){for(size_t step=0;value.value("pending",false);++step){require(step<10000,"Native bake did not finish");value=parsed(sv_step(7));require(value.at("ok")==true,"Native bake refused");}return value;}
uint64_t begin(bool selected=false,const char *kind="numeric"){const auto value=command(Json{{"command","beginTransform"},{"kind",kind},{"selectedOnly",selected}});require(value.at("ok")==true,"Native begin refused");
    const auto owner=value.at("transformSession");require(owner.size()==9&&owner.at("epoch")==0&&owner.at("appliedEpoch").is_null()&&owner.at("appliedMatrix")==Json(identityMatrix),"Initial summary contract changed");return owner.at("id");}
Json apply(uint64_t id,uint64_t epoch,const bt::Parameters &p){return command(Json{{"command","applyTransform"},{"id",id},{"epoch",epoch},{"parameters",wire(p)}});}
void end(uint64_t id){require(command(Json{{"command","endTransform"},{"id",id}}).at("transformSession").is_null(),"End did not retire metadata");}
void rejected(const Json &request){const auto scene=nativeScene();const auto mask=nativeMask();const auto old=summary();require(command(request).at("ok")==false,"Competing/stale command accepted");++refusals;
    require(equal(scene,nativeScene())&&mask==nativeMask()&&summary().at("transformSession")==old.at("transformSession")&&summary().at("revision")==old.at("revision"),"Refusal changed published document/metadata");}
void nativeContracts(){
    test([]{require(open().at("ok")==true&&sv_abi_version()==24,"Actual source/ABI24 failed");require(parsed(sv_build_identity()).at("capabilities").at("proTransformSession")==2,"Required native session capability missing");
        const auto baseline=nativeScene();const auto mask=nativeMask();const auto id=begin();bt::Parameters p;p.translation[0]=2;
        auto value=finishNative(apply(id,1,p));close(sv_scene_ptr()[0].positionOpacity[0],1,"First absolute apply failed");p.translation[0]=3;
        value=finishNative(apply(id,2,p));close(sv_scene_ptr()[0].positionOpacity[0],2,"Repeated apply accumulated previous bake");const auto revision=value.at("revision");
        value=finishNative(apply(id,3,p));require(value.at("revision")==revision&&value.at("transformSession").at("appliedEpoch")==3,"Identical accepted apply destroyed no-op history");
        const auto metadata=value.at("transformSession");const auto baseId=metadata.at("baseId").get<uint64_t>();
        require(sv_pack_transform_base(double(id),double(baseId),3,0,3)!=nullptr&&sv_pack_len()>0,"Fixed entry base stream failed");
        const auto *packed=sv_pack_transform_base(double(id),double(baseId),3,0,1);float position;std::memcpy(&position,packed,4);require(position==baseline[0].positionOpacity[0],"Base pack read baked scene");
        require(std::equal(mask.begin(),mask.end(),sv_transform_base_states_ptr(double(id),double(baseId),3)),"Base mask stream changed values");
        require(!sv_pack_transform_base(double(id),double(baseId),2,0,1)&&!sv_transform_base_states_ptr(double(id+1),double(baseId),3),"Stale base tuple was accepted");
        value=command(Json{{"command","resetTransform"},{"id",id},{"epoch",4}});require(equal(nativeScene(),baseline)&&nativeMask()==mask&&value.at("transformSession").at("appliedEpoch")==4,"Reset did not restore exact entry scene/mask");
        end(id);require(command(R"({"command":"undo"})").at("ok")==true&&sv_scene_ptr()[0].positionOpacity[0]==2,"Reset was not an undoable transaction");
        command(R"({"command":"redo"})");require(equal(nativeScene(),baseline),"Reset Redo did not restore entry bytes");
    });
    test([]{open();command(Json{{"command","single"},{"index",0},{"operation",0}});command(R"({"command":"delete"})");command(Json{{"command","single"},{"index",1},{"operation",0}});
        const auto baseline=nativeScene();const auto id=begin(true,"gizmo");const auto pivot=summary().at("transformSession").at("pivot");
        for(size_t i=0;i<3;++i)close(pivot[i],baseline[1].positionOpacity[i],"Native selected focus pivot differs from symmetric bounds");
        bt::Parameters p;p.translation={3,4,5};finishNative(apply(id,1,p));require(std::memcmp(&sv_scene_ptr()[0],&baseline[0],sizeof(Gaussian))==0&&std::memcmp(&sv_scene_ptr()[2],&baseline[2],sizeof(Gaussian))==0,"Selected transform changed deleted/unselected Gaussian");
        close(sv_scene_ptr()[1].positionOpacity[0],3,"Selected transform omitted selected Gaussian");end(id);
    });
    test([]{open();const auto id=begin();const auto baseline=nativeScene();bt::Parameters p;p.translation[0]=2;finishNative(apply(id,1,p));const auto accepted=nativeScene();
        command(R"({"command":"beginTransaction"})");p.translation[0]=5;finishNative(apply(id,2,p));end(id);const auto restored=command(R"({"command":"rollbackTransaction"})");
        require(equal(nativeScene(),accepted)&&restored.at("transformSession").at("id")==id&&restored.at("transformSession").at("epoch")==1,"Rollback lost accepted scene/retired owner metadata");
        rejected(Json{{"command","applyTransform"},{"id",id},{"epoch",2},{"parameters",wire(p)}});finishNative(apply(id,3,p));end(id);
        command(R"({"command":"undo"})");const auto redo=summary();const auto current=nativeScene();const auto next=begin();p.translation[0]=9;require(apply(next,1,p).at("pending")==true,"Cancellation job did not start");
        command(R"({"command":"cancel"})");require(equal(nativeScene(),current)&&summary().at("canRedo")==redo.at("canRedo"),"Cancel changed accepted scene/Redo");
        rejected(Json{{"command","applyTransform"},{"id",next},{"epoch",1},{"parameters",wire(p)}});end(next);command(R"({"command":"redo"})");close(sv_scene_ptr()[0].positionOpacity[0],4,"Cancelled job destroyed executable Redo");
        const auto stale=begin();open();rejected(Json{{"command","endTransform"},{"id",stale}});const auto newer=begin();require(newer>stale,"Source replacement recycled session identity");end(newer);
        require(!equal(baseline,accepted),"Absolute fixture did not actually change geometry");
    });
    test([]{open();const auto id=begin();bt::Parameters p;p.translation[0]=2;require(apply(id,1,p).at("pending")==true,"Guard fixture did not start");
        for(const char *name:{"selectAll","undo","redo","beginSelection","detectFloor","beginFilter","grade","transform","resetCleanup","point","selectionMapBegin","selectionMapCommit","selectionMapRelease"})rejected(Json{{"command",name}});
        for(unsigned format=0;format<9;++format)rejected(Json{{"command","export"},{"format",format}});
        require(parsed(sv_live_preview("{}")).at("ok")==false&&parsed(sv_map_write(1,0,nullptr,0)).at("ok")==false,"Live/map ABI escaped transform owner guard");
        require(!sv_pack_transform_base(double(id),summary().at("transformSession").at("baseId").get<double>(),1,0,1),"Base stream admitted a pending job");
        finishNative(summary());end(id);
    });
}
void publicationContracts(){
    test([]{open();const auto baseline=nativeScene();sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","beginTransform"},{"kind","numeric"},{"selectedOnly",false}}).at("ok")==false,"Begin publication gate ignored");++publications;
        require(summary().at("transformSession").is_null()&&equal(nativeScene(),baseline),"Refused begin published owner");const auto id=begin();bt::Parameters p;p.translation[0]=2;
        const auto initial=summary().at("transformSession");sv_response::refuseNextSummaryForContracts();require(apply(id,1,p).at("ok")==false,"Apply-start publication gate ignored");++publications;
        require(summary().at("transformSession")==initial&&!summary().at("pending").get<bool>(),"Refused apply published epoch/job");rejected(Json{{"command","applyTransform"},{"id",id},{"epoch",1},{"parameters",wire(p)}});
        require(apply(id,2,p).at("pending")==true,"Post-refusal retry did not start");sv_response::refuseNextSummaryForContracts();require(parsed(sv_step(65536)).at("ok")==false,"Bake publication gate ignored");++publications;
        require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>()&&summary().at("transformSession").at("appliedEpoch").is_null(),"Refused bake published history/geometry");
        finishNative(apply(id,3,p));const auto accepted=nativeScene();sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","resetTransform"},{"id",id},{"epoch",4}}).at("ok")==false,"Reset gate ignored");++publications;require(equal(nativeScene(),accepted),"Refused reset published entry scene");
        sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","endTransform"},{"id",id}}).at("ok")==false,"End gate ignored");++publications;require(!summary().at("transformSession").is_null(),"Refused end retired metadata");
        sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"beginTransaction"})").at("ok")==false&&!summary().at("transaction").get<bool>(),"Refused checkpoint published transaction");++publications;
        command(R"({"command":"beginTransaction"})");end(id);sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"rollbackTransaction"})").at("ok")==false&&summary().at("transformSession").is_null()&&summary().at("transaction").get<bool>(),"Refused rollback restored retired metadata");++publications;
        command(R"({"command":"rollbackTransaction"})");end(id);
    });
    test([]{open();const auto id=begin();const auto baseline=nativeScene();bt::Parameters p;p.translation[0]=2;bool reached=false;
        for(size_t ordinal=1;ordinal<100;++ordinal){const auto request=Json{{"command","applyTransform"},{"id",id},{"epoch",ordinal},{"parameters",wire(p)}}.dump();
            sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
            if(value.at("ok")==true){command(R"({"command":"cancel"})");reached=true;break;}++backendRefusals;require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>(),"Apply admission failure changed baseline/job");}
        require(reached&&backendRefusals>0,"Actual backend refusal sweep never reached success/failures");
        for(size_t ordinal=1;ordinal<100;++ordinal){require(apply(id,100+ordinal,p).at("pending")==true,"Pump fault fixture did not start");
            sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_step(65536);sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
            if(value.at("ok")==true){finishNative(value);break;}++backendRefusals;require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>(),"Pump admission/history failure published geometry/job");require(ordinal<99,"Pump allocation sweep never reached success");}
        end(id);
    });
}
}
void runGizmoSessionContracts();
int main(){try{mathContracts();jobContracts();nativeContracts();publicationContracts();runGizmoSessionContracts();std::printf("SPLATVIEW_TRANSFORM_SESSION_CONTRACTS_PASS cases=%zu checks=%zu bakes=%zu refusals=%zu publication=%zu backend=%zu cancelPhases=%zu ownerBytes=%zu jobBytes=%zu\n",cases,checks,bakes,refusals,publications,backendRefusals,cancelPhases,sizeof(bt::Owner),sizeof(bt::Job));return 0;}
    catch(const std::exception &error){sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"Transform session contracts failed cases=%zu checks=%zu: %s\n",cases,checks,error.what());return 1;}}
