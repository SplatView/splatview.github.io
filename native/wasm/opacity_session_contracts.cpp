// Independent literal alpha cases and the pinned portable opacity Recipe are
// oracles. The linked public bindings exercise actual ownership/publication;
// all allocation and response-refusal hooks remain private to this main.
#include "browser_opacity_session.hpp"
#include "processing.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include "model.hpp"
#include "file_preferences.hpp"
#include "image_io.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>
namespace preview {
// This private main links the full portable recipe oracle, whose unrelated file
// branches need host seams. Browser fixtures have no persisted default view;
// an absent result performs no I/O and cannot replace their explicitly seeded
// Scene::defaultView. Images are unsupported here and must never be requested.
namespace opacity_contract_io {size_t imageCalls{};}
std::optional<SavedView> readDefaultView(const std::filesystem::path &,std::string_view) {return {};}
DecodedImage readImage(const std::filesystem::path &,const ImageReadOptions &) {
    ++opacity_contract_io::imageCalls;throw std::runtime_error("Opacity formula oracle cannot read image files");
}
}
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const char *sv_live_preview(const char *);const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const uint32_t *sv_pack_opacity_base(double,double,double,unsigned,unsigned);
const uint8_t *sv_opacity_base_states_ptr(double,double,double);unsigned sv_pack_len();
}
namespace {
using namespace preview;namespace bo=preview::browser_opacity;using Json=nlohmann::json;
size_t cases{},checks{},refusals{},publications{},backendRefusals{},cancelPhases{},bakes{},streamChecks{};
void require(bool condition,const char *message){++checks;if(!condition)throw std::runtime_error(message);}
template<class F>void test(F action){action();++cases;}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &request){const auto text=request.dump();return parsed(sv_command(text.c_str()));}
Json command(const char *request){return parsed(sv_command(request));}
Json summary(){return command(R"({"command":"summary"})");}
bool equal(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b){return a.size()==b.size()&&std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian))==0;}
std::shared_ptr<Scene> scene(size_t count=17){
    auto value=std::make_shared<Scene>();value->shDegree=3;value->sourceCount=count+13;value->sourceFaces=7;value->sampledGeometry=true;
    value->center={2,3,4};value->radius=19;value->previewEye=Vec3{7,8,9};value->format="opacity-contract";
    value->sourceContentKey="fixed-content";value->sourceFileIdentity="fixed-file";value->sourceBytes=123;value->yUp=true;
    value->alignmentFrame[12]=7;value->defaultView=SavedView{{1,2,3},.1f,.2f,4,60,true,.3f};
    const std::array<float,5> alpha{0,.1f,.5f,.9f,1};
    for(size_t i=0;i<count;++i){Gaussian g;g.positionOpacity={float(i)-8,float(i)*.5f,float(i)*-.25f,alpha[i%alpha.size()]};
        g.covA={.01f,.002f,.003f,.02f};g.covB={.004f,.03f,7,8};for(size_t k=0;k<24;++k)g.sh[k]=uint32_t(i*31+k+123);value->gaussians.push_back(g);}
    return value;
}
bo::Owner owner(const std::shared_ptr<Scene> &base,const std::shared_ptr<SceneMemory> &memory,bool selected=false){
    std::vector<uint8_t> states(base->gaussians.size());for(size_t i=0;i<states.size();++i)states[i]=uint8_t(i%3);
    auto mask=MaskStorage::copy(states,memory);bo::Owner o;o.id=1;o.baseId=2;o.epoch=1;o.base=base;o.states=mask;o.selectedOnly=selected;
    o.acknowledged={base,mask,1,0,0,true};return o;
}
void metadata(const Scene &actual,const Scene &base){
    require(actual.type==base.type&&actual.sourceFaces==base.sourceFaces&&actual.sampledGeometry==base.sampledGeometry,"Opacity changed source geometry metadata");
    require(actual.center==base.center&&actual.radius==base.radius&&actual.previewEye==base.previewEye&&actual.defaultView==base.defaultView,"Opacity changed bounds or saved/default view");
    require(actual.alignmentFrame==base.alignmentFrame&&actual.sourceCount==base.sourceCount&&actual.shDegree==base.shDegree&&actual.yUp==base.yUp,"Opacity changed alignment/SH/source policy");
    require(actual.format==base.format&&actual.sourceContentKey==base.sourceContentKey&&actual.sourceFileIdentity==base.sourceFileIdentity&&actual.sourceBytes==base.sourceBytes,"Opacity changed opaque source identity");
}
void finish(bo::Job &job,size_t batch=3){
    for(size_t step=0;job.status()==bo::Status::Working;++step){require(step<100000,"Opacity pump did not finish");job.step(batch);require(job.lastStepWork()<=batch,"Opacity pump exceeded requested work");}
    require(job.status()==bo::Status::Ready&&job.result(),"Opacity pump exposed no ready result");++bakes;
}
void arithmeticContracts(){
    test([]{
        struct Literal {float alpha,scale,expected;};
        const std::array<Literal,15> literals{{{0,0,0},{.5f,0,0},{1,0,0},{.5f,.5f,.25f},{.25f,1,.25f},{0,1,0},{1,1,1},
            {0,2,.5f},{.5f,2,.75f},{1,2,1},{0,3,1},{.5f,3,1},{0,5,1},{.5f,5,1},{1,5,1}}};
        for(const auto &l:literals)require(bo::opacity(l.alpha,l.scale)==l.expected,"Opacity differs from independent literal alpha/scale oracle");
        for(float invalid:{-1.f,5.01f,std::numeric_limits<float>::infinity(),-std::numeric_limits<float>::infinity(),std::numeric_limits<float>::quiet_NaN()}){require(!bo::validScale(invalid),"Invalid opacity scalar accepted");++refusals;}
    });
    test([]{for(bool selected:{false,true})for(float scale:{0.f,.1f,.5f,1.f,1.1f,2.f,3.f,5.f}){
        ResourceBudget budget(16*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene();auto captured=owner(base,memory,selected);const auto before=base->gaussians;
        const auto expected=processScene(base,captured.states.span(),Recipe{{"type","opacity"},{"values",{{"scale",scale}}}},selected);
        auto job=bo::Job::create(captured,scale,memory);require(budget.usage().totalBytes==captured.states.size()+sizeof(bo::Job),"Capture allocated a source-sized opacity candidate");
        require(job->step(0)==bo::Status::Working&&job->workDone()==0,"Zero work advanced opacity");finish(*job);metadata(*job->result(),*base);
        require(job->result()->gaussians.size()==before.size(),"Opacity changed Gaussian count");
        for(size_t i=0;i<before.size();++i){const auto &g=job->result()->gaussians[i];require(std::memcmp(&g,&expected.scene->gaussians[i],sizeof(Gaussian))==0,"Opacity bake differs from pinned portable recipe");
            auto preserved=g;preserved.positionOpacity[3]=before[i].positionOpacity[3];require(std::memcmp(&preserved,&before[i],sizeof(Gaussian))==0,"Opacity changed position/covariance padding or SH");}
        require(std::memcmp(base->gaussians.data(),before.data(),before.size()*sizeof(Gaussian))==0,"Opacity mutated fixed entry scene");
        bo::Job::retire(job);require(budget.usage().totalBytes==captured.states.size(),"Opacity retirement leaked admitted payload");
    }});
    test([]{ResourceBudget budget(32*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene(20017);auto captured=owner(base,memory);
        auto job=bo::Job::create(captured,2,memory);finish(*job,101);require(job->workDone()==base->gaussians.size()+2,"Opacity pump hid a scene-sized traversal outside work accounting");
        require(job->result()->gaussians[0].positionOpacity[3]==.5f,"Large zero-alpha bake did not revive source");metadata(*job->result(),*base);bo::Job::retire(job);
        auto changed=scene();auto small=owner(changed,memory);auto bake=bo::Job::create(small,2,memory);finish(*bake);small.acknowledged.scene=bake->result();
        auto restore=bo::Job::create(small,1,memory);require(restore->phase()==bo::Phase::Finish,"Neutral restore allocated/copied Gaussians");finish(*restore,1);
        require(restore->result()==small.base&&restore->workDone()==1,"Neutral restore did not share exact entry owner");bo::Job::retire(restore);bo::Job::retire(bake);
    });
    test([]{ResourceBudget budget(4*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);auto base=scene();auto captured=owner(base,memory);const auto usage=budget.usage().totalBytes;
        for(unsigned target=0;target<=unsigned(bo::Phase::Finish);++target){auto job=bo::Job::create(captured,.5f,memory);while(unsigned(job->phase())!=target&&job->status()==bo::Status::Working)job->step(1);
            require(unsigned(job->phase())==target,"Opacity cancellation phase unreachable");job->cancel();require(job->status()==bo::Status::Cancelled&&!job->result(),"Cancellation exposed a partial opacity scene");bo::Job::retire(job);
            require(budget.usage().totalBytes==usage,"Phase cancellation leaked opacity admission");++cancelPhases;}
        auto job=bo::Job::create(captured,2,memory);std::stop_source stopped;stopped.request_stop();job->step(5,stopped.get_token());require(job->status()==bo::Status::Cancelled&&job->workDone()==0,"Stopped pump performed opacity work");bo::Job::retire(job);
        ResourceBudget tiny(sizeof(bo::Job)-1);bool refused=false;try{bo::Job::create(captured,2,sceneMemoryForBudget(tiny,ResourceCategory::Work));}catch(...){refused=true;}
        require(refused&&tiny.usage().totalBytes==0,"Opacity owner admission failure leaked or was ignored");++refusals;
    });
}
std::vector<uint8_t> input(bool opaque=false){
    std::vector<uint8_t> bytes(3*32);const std::array<uint8_t,3> alpha{0,128,255};
    for(size_t i=0;i<3;++i){const std::array<float,6> values{float(i)-1,float(i)*.5f,float(i)*.25f,.01f,.02f,.03f};std::memcpy(bytes.data()+i*32,values.data(),24);
        const std::array<uint8_t,8> colors{uint8_t(40+i),uint8_t(90+i),uint8_t(140+i),opaque?uint8_t(255):alpha[i],255,128,128,128};std::memcpy(bytes.data()+i*32+24,colors.data(),8);}
    return bytes;
}
Json open(bool opaque=false){const auto bytes=input(opaque);return parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),1000,64*1024*1024));}
std::vector<Gaussian> nativeScene(){const auto *data=sv_scene_ptr();require(data,"Native opacity scene missing");return {data,data+3};}
std::vector<uint8_t> nativeMask(){const auto *data=sv_states_ptr();require(data,"Native opacity mask missing");return {data,data+3};}
Json finishNative(Json value){for(size_t step=0;value.value("pending",false);++step){require(step<10000,"Native opacity bake did not finish");value=parsed(sv_step(7));require(value.at("ok")==true,"Native opacity bake refused");}return value;}
uint64_t begin(bool selected=false){const auto value=command(Json{{"command","beginOpacity"},{"selectedOnly",selected}});require(value.at("ok")==true,"Native opacity begin refused");
    const auto o=value.at("opacitySession");require(o.size()==6&&o.at("epoch")==0&&o.at("appliedEpoch").is_null()&&o.at("appliedScale")==1&&o.at("selectedOnly")==selected,"Initial opacity metadata changed");return o.at("id");}
Json apply(uint64_t id,uint64_t epoch,float scale){return command(Json{{"command","applyOpacity"},{"id",id},{"epoch",epoch},{"scale",scale}});}
void end(uint64_t id){const auto value=command(Json{{"command","endOpacity"},{"id",id}});require(value.at("ok")==true&&value.at("opacitySession").is_null(),"Opacity end did not retire metadata");}
void rejected(const Json &request){const auto before=nativeScene();const auto mask=nativeMask();const auto old=summary();require(command(request).at("ok")==false,"Competing/stale opacity command accepted");++refusals;
    const auto after=summary();require(equal(before,nativeScene())&&mask==nativeMask()&&after.at("opacitySession")==old.at("opacitySession")&&after.at("revision")==old.at("revision")&&after.at("pending")==old.at("pending"),"Refusal changed accepted opacity/history/job");}
void nativeContracts(){
    test([]{require(sv_abi_version()==24&&summary().at("opacitySession").is_null(),"ABI24/unloaded nullable opacity handshake failed");const auto identity=parsed(sv_build_identity());
        require(identity.at("capabilities").at("absoluteOpacitySession")==1&&identity.at("capabilities").at("opacityBaseStream")==1,"Opacity capabilities missing");
        require(open().at("ok")==true&&sv_scene_ptr()[0].positionOpacity[3]==0,"Literal splat zero-alpha fixture failed");const auto baseline=nativeScene();const auto mask=nativeMask();const auto id=begin();
        finishNative(apply(id,1,.5f));require(sv_scene_ptr()[1].positionOpacity[3]==baseline[1].positionOpacity[3]*.5f,"First opacity fade failed");
        auto value=finishNative(apply(id,2,2));require(sv_scene_ptr()[0].positionOpacity[3]==.5f&&sv_scene_ptr()[1].positionOpacity[3]==baseline[1].positionOpacity[3]+(1-baseline[1].positionOpacity[3])/2,"Repeated opacity Apply accumulated old bake");
        const auto accepted=nativeScene();const auto revision=value.at("revision"),content=value.at("contentRevision");value=finishNative(apply(id,3,2));
        require(value.at("revision")==revision&&value.at("contentRevision")==content&&value.at("opacitySession").at("appliedEpoch")==3,"Repeated accepted scalar destroyed no-op history");
        const auto baseId=value.at("opacitySession").at("baseId").get<uint64_t>();const auto *pack=sv_pack_opacity_base(double(id),double(baseId),3,0,3);require(pack&&sv_pack_len()>0,"Fixed opacity entry pack failed");
        float alpha;std::memcpy(&alpha,pack+3,4);require(alpha==baseline[0].positionOpacity[3],"Opacity base stream returned baked alpha");
        require(std::equal(mask.begin(),mask.end(),sv_opacity_base_states_ptr(double(id),double(baseId),3)),"Opacity entry mask stream changed values");++streamChecks;
        value=finishNative(command(Json{{"command","resetOpacity"},{"id",id},{"epoch",4}}));require(equal(nativeScene(),baseline)&&nativeMask()==mask&&value.at("opacitySession").at("appliedScale")==1,"Reset did not restore exact entry scene/mask");
        end(id);command(R"({"command":"undo"})");require(equal(nativeScene(),accepted),"Opacity reset was not undoable");command(R"({"command":"redo"})");require(equal(nativeScene(),baseline),"Opacity reset Redo did not restore entry bytes");
    });
    test([]{open();command(Json{{"command","single"},{"index",0},{"operation",0}});command(R"({"command":"delete"})");command(Json{{"command","single"},{"index",1},{"operation",0}});
        const auto before=nativeScene();const auto id=begin(true);finishNative(apply(id,1,0));const auto after=nativeScene();require(after[1].positionOpacity[3]==0,"Selected fade omitted selected source");
        require(std::memcmp(&before[0],&after[0],sizeof(Gaussian))==0&&std::memcmp(&before[2],&after[2],sizeof(Gaussian))==0,"Selected opacity changed deleted or unselected source");end(id);
    });
    test([]{open(true);auto id=begin();finishNative(apply(id,1,.5f));end(id);command(R"({"command":"undo"})");const auto baseline=nativeScene();const auto old=summary();require(old.at("canRedo")==true,"Saturation fixture has no Redo");id=begin();
        auto value=finishNative(apply(id,1,5));require(equal(nativeScene(),baseline)&&value.at("revision")==old.at("revision")&&value.at("canRedo")==true,"Saturated no-op changed history or Redo");
        value=finishNative(apply(id,2,1));require(value.at("revision")==old.at("revision")&&value.at("canRedo")==true,"Neutral opacity no-op changed history or Redo");end(id);
        command(R"({"command":"redo"})");require(sv_scene_ptr()[0].positionOpacity[3]==.5f,"Saturated/neutral no-op destroyed executable Redo");
        open();command(R"({"command":"selectAll"})");command(R"({"command":"delete"})");const auto hidden=summary();id=begin();value=finishNative(apply(id,1,2));require(value.at("revision")==hidden.at("revision")&&value.at("visible")==0,"All-deleted opacity created a content edit");end(id);
    });
    test([]{open();const auto id=begin();finishNative(apply(id,1,.5f));const auto accepted=nativeScene();command(R"({"command":"beginTransaction"})");finishNative(apply(id,2,2));end(id);
        const auto restored=command(R"({"command":"rollbackTransaction"})");require(equal(nativeScene(),accepted)&&restored.at("opacitySession").at("epoch")==1&&restored.at("opacitySession").at("appliedScale")==.5,"Rollback lost accepted scene/retired opacity metadata");
        rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",2},{"scale",2}});finishNative(apply(id,3,2));end(id);
        command(R"({"command":"beginTransaction"})");const auto inside=begin();finishNative(apply(inside,1,0));end(inside);command(R"({"command":"rollbackTransaction"})");require(summary().at("opacitySession").is_null(),"Entry transaction rollback retained a newly begun owner");
        const auto stale=begin();open();rejected(Json{{"command","endOpacity"},{"id",stale}});const auto newer=begin();require(newer>stale,"Source replacement recycled opacity identity");end(newer);
    });
    test([]{for(unsigned phase=0;phase<3;++phase){open();const auto baseline=nativeScene();const auto before=summary();const auto id=begin();require(apply(id,1,.5f).at("pending")==true,"Cancel fixture did not start");
        if(phase)require(parsed(sv_step(phase==1?1:4)).at("pending")==true,"Cancellation target passed publication");command(R"({"command":"cancel"})");const auto value=summary();
        require(equal(nativeScene(),baseline)&&value.at("canRedo")==before.at("canRedo")&&value.at("opacitySession").at("appliedEpoch").is_null(),"Job cancellation changed accepted opacity/Redo");
        rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",1},{"scale",.5}});finishNative(apply(id,2,.5f));end(id);++cancelPhases;
    }});
    test([]{open();const auto id=begin();require(apply(id,1,2).at("pending")==true,"Guard fixture did not start");
        for(const char *name:{"selectAll","undo","redo","beginSelection","beginOpacity","beginTransform","beginFilter","detectFloor","grade","autoColor","endColor","transform","alignCenter","alignScale","resetCleanup","point","planeNormal","selectionMapBegin","selectionMapCommit","selectionMapRelease"})rejected(Json{{"command",name}});
        for(unsigned format=0;format<9;++format)rejected(Json{{"command","export"},{"format",format}});
        require(parsed(sv_live_preview("{}")).at("ok")==false&&parsed(sv_map_write(1,0,nullptr,0)).at("ok")==false,"Live/map ABI escaped opacity guard");
        const auto base=summary().at("opacitySession").at("baseId").get<double>();require(!sv_pack_opacity_base(double(id),base,1,0,1)&&!sv_opacity_base_states_ptr(double(id),base,1),"Pending opacity admitted base stream");
        finishNative(summary());for(const auto args:std::array<std::array<double,3>,8>{{{double(id+1),base,1},{double(id),base+1,1},{double(id),base,0},{double(id),base,2},{0,base,1},{double(id),base,-1},{double(id),base,1.5},{double(id),base,std::numeric_limits<double>::infinity()}}}){
            require(!sv_pack_opacity_base(args[0],args[1],args[2],0,1)&&sv_pack_len()==0&&!sv_opacity_base_states_ptr(args[0],args[1],args[2]),"Stale/noninteger stream tuple accepted");++streamChecks;}
        require(!sv_pack_opacity_base(double(id),base,1,4,1)&&sv_pack_len()==0,"Out-of-range opacity chunk accepted");++streamChecks;end(id);
    });
    test([]{open();rejected(Json{{"command","beginOpacity"},{"selectedOnly",1}});const auto id=begin();
        rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",0},{"scale",1}});rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",1.5},{"scale",1}});
        uint64_t epoch=1;for(const Json scale:std::array<Json,5>{Json(-.01),Json(5.01),Json("2"),Json(nullptr),Json(true)}){rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",epoch},{"scale",scale}});
            rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",epoch},{"scale",1}});++epoch;}
        rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",epoch++},{"scale",1},{"extra",0}});finishNative(apply(id,epoch,.1f));end(id);
    });
}
void publicationContracts(){
    test([]{open();const auto baseline=nativeScene();sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","beginOpacity"},{"selectedOnly",false}}).at("ok")==false,"Begin publication gate ignored");++publications;
        require(summary().at("opacitySession").is_null()&&equal(nativeScene(),baseline),"Refused opacity begin published owner");
        sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"beginTransaction"})").at("ok")==false&&!summary().at("transaction").get<bool>(),"Refused entry checkpoint published transaction");++publications;
        const auto id=begin();const auto initial=summary().at("opacitySession");sv_response::refuseNextSummaryForContracts();require(apply(id,1,2).at("ok")==false,"Apply-start publication gate ignored");++publications;
        require(summary().at("opacitySession")==initial&&!summary().at("pending").get<bool>(),"Refused apply published epoch/job");rejected(Json{{"command","applyOpacity"},{"id",id},{"epoch",1},{"scale",2}});
        require(apply(id,2,2).at("pending")==true,"Post-refusal retry failed");sv_response::refuseNextSummaryForContracts();require(parsed(sv_step(65536)).at("ok")==false,"Bake publication gate ignored");++publications;
        require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>()&&summary().at("opacitySession").at("appliedEpoch").is_null(),"Refused bake published opacity/history");
        finishNative(apply(id,3,2));const auto accepted=nativeScene();require(command(Json{{"command","resetOpacity"},{"id",id},{"epoch",4}}).at("pending")==true,"Reset restore did not enter pump");
        sv_response::refuseNextSummaryForContracts();require(parsed(sv_step(65536)).at("ok")==false&&equal(nativeScene(),accepted),"Refused reset published entry scene");++publications;
        sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","endOpacity"},{"id",id}}).at("ok")==false&&!summary().at("opacitySession").is_null(),"Refused end retired owner");++publications;
        command(R"({"command":"beginTransaction"})");end(id);sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"rollbackTransaction"})").at("ok")==false&&summary().at("opacitySession").is_null()&&summary().at("transaction").get<bool>(),"Refused rollback restored retired metadata");++publications;
        command(R"({"command":"rollbackTransaction"})");end(id);
    });
    test([]{open();const auto id=begin();const auto baseline=nativeScene();bool reached=false;
        for(size_t ordinal=1;ordinal<100;++ordinal){const auto text=Json{{"command","applyOpacity"},{"id",id},{"epoch",ordinal},{"scale",2}}.dump();sv_allocation::failBackendAtForContracts(ordinal);
            const auto *reply=sv_command(text.c_str());sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
            if(value.at("ok")==true){command(R"({"command":"cancel"})");reached=true;break;}++backendRefusals;require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>(),"Request backend refusal changed scene/job");}
        require(reached&&backendRefusals>0,"Opacity request backend sweep did not reach both failure and success");reached=false;
        for(size_t ordinal=1;ordinal<100;++ordinal){require(apply(id,100+ordinal,2).at("pending")==true,"Pump fault fixture did not start");sv_allocation::failBackendAtForContracts(ordinal);
            const auto *reply=sv_step(65536);sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
            if(value.at("ok")==true){finishNative(value);reached=true;break;}++backendRefusals;require(equal(nativeScene(),baseline)&&!summary().at("pending").get<bool>(),"Pump backend/history failure published opacity/job");}
        require(reached,"Opacity pump backend sweep never reached success");end(id);
    });
}
}
int main(){try{arithmeticContracts();nativeContracts();publicationContracts();require(opacity_contract_io::imageCalls==0,"Opacity oracle visited an unrelated image branch");std::printf("SPLATVIEW_OPACITY_SESSION_CONTRACTS_PASS cases=%zu checks=%zu bakes=%zu refusals=%zu publication=%zu backend=%zu cancelPhases=%zu streamChecks=%zu ownerBytes=%zu jobBytes=%zu\n",cases,checks,bakes,refusals,publications,backendRefusals,cancelPhases,streamChecks,sizeof(bo::Owner),sizeof(bo::Job));return 0;}
    catch(const std::exception &error){sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"Opacity session contracts failed cases=%zu checks=%zu: %s\n",cases,checks,error.what());return 1;}}
