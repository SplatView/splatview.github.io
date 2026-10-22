// Source-bound detector fixtures plus actual shipping C ABI lifecycle contracts.
// This main and its fixture data are never shipped as browser exports.
#include "floor_detection_job.hpp"
#include "floor_reference_contract_data.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>
#ifndef SV_FLOOR_HOST_ONLY
#include "allocation_census.hpp"
#include "browser_alignment_frame.hpp"
#include "camera.hpp"
#include "model.hpp"
#include "color.hpp"
extern "C" {
unsigned sv_abi_version();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
}
#endif
namespace {
using namespace preview;
using namespace preview::browser_floor;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
using View=std::array<float,11>;
size_t checks{},referenceRuns{},referenceCandidates{},referenceNone{},rngRanges{},matrixCases{},cancelCases{},
    abiCases{},refusals{},publicationRefusals{},rollbackCases{};
void require(bool value,const char *message) { ++checks;if(!value) throw std::runtime_error(message); }
struct Scratch : SceneMemory,std::enable_shared_from_this<Scratch> {
    size_t current{},peak{},allocations{},failAt{};
    std::stop_source *stopDuringAdmission{};
    struct Grant { std::shared_ptr<Scratch> owner;size_t bytes;
        Grant(std::shared_ptr<Scratch> o,size_t n):owner(std::move(o)),bytes(n){}
        ~Grant(){owner->current-=bytes;}
    };
    std::shared_ptr<void> admit(size_t bytes) override {
        if(++allocations==failAt) throw std::bad_alloc();
        if(stopDuringAdmission) stopDuringAdmission->request_stop();
        current+=bytes;peak=std::max(peak,current);
        try{return std::make_shared<Grant>(shared_from_this(),bytes);}catch(...){current-=bytes;throw;}
    }
};
FloorOptions options(const Json &input) {
    const auto &v=input.at("options");FloorOptions result;
    result.threshold=std::bit_cast<float>(v.at("thresholdBits").get<uint32_t>());
    result.iterations=v.at("iterations");result.samples=v.at("samples");
    if(!v.at("viewpointBits").is_null()) {
        const auto bits=v.at("viewpointBits").get<std::array<uint32_t,3>>();
        result.viewpoint=Vec3{std::bit_cast<float>(bits[0]),std::bit_cast<float>(bits[1]),std::bit_cast<float>(bits[2])};
    }
    return result;
}
std::shared_ptr<Scene> sourceScene(const Json &input) {
    auto value=std::make_shared<Scene>();
    for(const auto &member:input.at("members")) {
        Gaussian g{};const auto bits=member.at("positionOpacityBits").get<std::array<uint32_t,4>>();
        for(size_t k=0;k<4;++k) g.positionOpacity[k]=std::bit_cast<float>(bits[k]);value->gaussians.push_back(g);
    }
    return value;
}
MaskStorage sourceMask(const Json &input) {
    const auto bytes=input.at("states").get<Bytes>();return bytes.empty()?MaskStorage{}:MaskStorage::copy(bytes);
}
std::array<float,8> scalars(const FloorPlane &p) {
    return {p.normal.x,p.normal.y,p.normal.z,p.center.x,p.center.y,p.center.z,p.radius,p.rms};
}
bool near(float actual,float expected) {
#ifdef SV_FLOOR_HOST_ONLY
    return std::bit_cast<uint32_t>(actual)==std::bit_cast<uint32_t>(expected);
#else
    return std::isfinite(actual)&&std::isfinite(expected)&&std::abs(double(actual)-expected)<=2e-5*std::max(1.0,std::abs(double(expected)));
#endif
}
void sourceContracts(const Json &source) {
    require(source.at("capturedDetectorSeed")==0x53504c54,"Captured Floor seed changed");
    for(const auto &test:source.at("floorCases")) {
        const auto owner=sourceScene(test.at("input"));const auto states=sourceMask(test.at("input"));
        const auto *sceneData=owner->gaussians.data();const auto *maskData=states.data();
        for(size_t chunk:{size_t(1),size_t(3),size_t(17),size_t(4096)}) {
            auto memory=std::make_shared<Scratch>();auto job=Job::create(owner,states,test.at("input").at("selectedOnly"),options(test.at("input")),memory);
            require(memory->current==sizeof(Job)&&memory->allocations==1&&job->scratchBytes()==0&&job->progress().actions==0,"Floor constructor scanned/allocated sample storage");
            require(job->step(0)==Status::Working&&job->progress().actions==0,"Zero Floor work advanced");
            std::stop_source stop;if(test.at("input").at("preCancelled")) stop.request_stop();
            while(job->status()==Status::Working) {
                job->step(chunk,stop.get_token());require(job->progress().lastStepActions<=chunk,"Floor exceeded action budget");
                require(job->progress().actions<10'000'000,"Floor fixture did not terminate");
                if(job->status()==Status::Working) require(!job->result(),"Floor exposed partial result");
            }
            const bool expected=test.at("outcome")=="candidate";
            require(bool(job->result())==expected,"Floor candidate/none differs from actual source");
            if(expected) {
                const auto actual=scalars(*job->result());const auto bits=test.at("plane").at("floatBits").get<std::array<uint32_t,8>>();
                for(size_t k=0;k<8;++k) require(near(actual[k],std::bit_cast<float>(bits[k])),"Floor scalar differs from actual R0 detector");
                require(job->result()->inliers==test.at("plane").at("inliers")&&job->result()->tested==test.at("plane").at("tested"),"Floor source support counts differ");
                require(validPlane(*job->result(),owner->gaussians.size()),"Source Floor candidate fails browser grammar");++referenceCandidates;
            } else ++referenceNone;
            require(job->scratchBytes()==0&&memory->current==sizeof(Job),"Terminal Floor retains sample storage");
            require(job->sceneOwner()==owner&&job->maskOwner().data()==maskData&&owner->gaussians.data()==sceneData,"Readonly Floor changed scene/mask owners");
            require(memory->peak<=sizeof(Job)+40*std::min<size_t>(options(test.at("input")).samples,owner->gaussians.size()),"Floor scratch exceeds admitted 40*S payload");
            Job::retire(job);require(memory->current==0&&!job.get_deleter().memory,"Floor retirement retains admission owner");++referenceRuns;
        }
#ifndef SV_FLOOR_HOST_ONLY
        if(!test.at("plane").is_null()) {
            const auto bits=test.at("plane").at("floatBits").get<std::array<uint32_t,8>>();
            const FloorPlane p{{std::bit_cast<float>(bits[0]),std::bit_cast<float>(bits[1]),std::bit_cast<float>(bits[2])},
                {std::bit_cast<float>(bits[3]),std::bit_cast<float>(bits[4]),std::bit_cast<float>(bits[5])},std::bit_cast<float>(bits[6]),std::bit_cast<float>(bits[7]),
                test.at("plane").at("inliers"),test.at("plane").at("tested")};
            for(const auto &a:test.at("alignments")) {
                const auto matrix=alignFloor(p,a.at("uiFlip").get<bool>()!=!a.at("yUp").get<bool>());
                const auto expected=a.at("matrix").get<Matrix4>();for(size_t k=0;k<16;++k) require(near(matrix[k],expected[k]),"alignFloor differs from actual source matrix");
                const auto input=a.at("inputCamera").at("state").get<View>();Camera c;c.target={input[0],input[1],input[2]};c.yaw=input[3];c.pitch=input[4];c.distance=input[5];c.radius=input[6];c.fieldOfView=input[7];c.yUp=input[8]!=0;c.roll=input[9];
                const auto carried=c.transformed(matrix);const auto actual=View{carried.target.x,carried.target.y,carried.target.z,carried.yaw,carried.pitch,carried.distance,carried.radius,carried.fieldOfView,carried.yUp?1.f:0.f,0,input[10]};
                const auto expectedCamera=a.at("worldUprightCamera").at("state").get<View>();for(size_t k=0;k<11;++k) require(near(actual[k],expectedCamera[k]),"Floor camera differs from actual source WorldUpright kernel");++matrixCases;
            }
        }
#endif
    }
    for(const auto &test:source.at("settingsRefusals")) {
        auto memory=std::make_shared<Scratch>();bool refused=false;
        try{auto job=Job::create(sourceScene(test.at("input")),sourceMask(test.at("input")),test.at("input").at("selectedOnly"),options(test.at("input")),memory);}
        catch(const std::runtime_error &e){refused=true;require(std::string(e.what())==test.at("message").get<std::string>(),"Source Floor setting refusal differs");}
        require(refused&&memory->current==0,"Invalid Floor settings leaked admitted owner");++refusals;
    }
    for(const auto &test:source.at("rngCases")) {
        struct RecordedEngine {std::mt19937 engine;std::vector<uint32_t> raw;uint32_t operator()(){const auto v=uint32_t(engine());raw.push_back(v);return v;}} engine{std::mt19937(test.at("seed").get<uint32_t>()),{}};
        MsvcBounded32 mapper;mapper.begin(test.at("maximum"));
        for(const auto &draw:test.at("draws")) {engine.raw.clear();while(!mapper.attempt(engine)){}require(mapper.value()==draw.at("result")&&engine.raw==draw.at("rawEngineDraws").get<std::vector<uint32_t>>(),"MSVC bounded32 raw draws/mapping differ");}++rngRanges;
    }
    struct Rejection {size_t draws{};uint32_t operator()(){return draws++?UINT32_MAX:0;}} engine;
    MsvcBounded32 mapper;mapper.begin(9);require(!mapper.attempt(engine)&&engine.draws==1,"Rejected bounded draw did not yield");
    require(mapper.attempt(engine)&&mapper.value()==9&&engine.draws==2,"MSVC rejection result/schedule differs");
    const auto &input=source.at("floorCases")[1].at("input");const auto owner=sourceScene(input);const auto mask=sourceMask(input);auto settings=options(input);settings.samples=7;
    for(const auto phase:{Phase::AllocatePoints,Phase::Scan,Phase::ReservoirDraw,Phase::AllocateAxis,Phase::AllocateMerge,Phase::AxisFill,Phase::MergeWrite,Phase::DrawA,Phase::Score,Phase::Center,Phase::Covariance,Phase::Jacobi,Phase::FinalSupport,Phase::Finish}) {
        auto memory=std::make_shared<Scratch>();auto job=Job::create(owner,mask,false,settings,memory);
        while(job->phase()!=phase&&job->status()==Status::Working) job->step(1);
        require(job->phase()==phase,"Floor cancellation phase not reached");std::stop_source stop;stop.request_stop();job->step(1,stop.get_token());
        require(job->status()==Status::Cancelled&&!job->result()&&job->scratchBytes()==0,"Cancelled Floor retained output/scratch");Job::retire(job);require(memory->current==0,"Cancelled Floor retained payload");++cancelCases;
    }
    {
        auto memory=std::make_shared<Scratch>();auto job=Job::create(owner,mask,false,settings,memory);std::stop_source stop;
        memory->stopDuringAdmission=&stop;job->step(4096,stop.get_token());
        require(job->status()==Status::Cancelled&&job->progress().lastStepActions==1&&!job->result()&&job->scratchBytes()==0,
            "During-step Floor cancellation did not stop after current action");Job::retire(job);require(memory->current==0,"During-step Floor cancellation retained payload");++cancelCases;
    }
    {
        auto memory=std::make_shared<Scratch>();memory->failAt=3;auto job=Job::create(owner,mask,false,options(input),memory);bool refused=false;
        try{while(job->status()==Status::Working)job->step(17);}catch(const std::bad_alloc &){refused=true;}
        require(refused&&job->status()==Status::Refused&&!job->result()&&job->scratchBytes()==0,"Floor scratch refusal left partial result");Job::retire(job);require(memory->current==0,"Floor scratch refusal retained owner");++refusals;
        bool nonadmitted=false;try{auto rejected=Job::create(owner,mask,false,{},{});}catch(const std::invalid_argument &){nonadmitted=true;}require(nonadmitted,"Floor admitted null scratch service");++refusals;
    }
}
#ifndef SV_FLOOR_HOST_ONLY
Json parsed(const char *text) {require(text!=nullptr,"Null Floor response");const auto value=Json::parse(text);require(value.contains("ok"),"Malformed Floor response");return value;}
Json command(const Json &value) {const auto text=value.dump();return parsed(sv_command(text.c_str()));}
Json named(const char *name) {return command({{"command",name}});}
Json current() {return named("summary");}
Json finish(Json value,unsigned work=17) {
    for(size_t step=0;value.value("pending",false);++step) {require(step<1'000'000,"Floor ABI did not terminate");value=parsed(sv_step(work));require(value["ok"]==true,"Floor ABI step refused");}return value;
}
Bytes ply(unsigned degree=3,bool line=false,size_t count=9) {
    std::ostringstream out;out.precision(9);out<<"ply\nformat ascii 1.0\nelement vertex "<<count<<"\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n";
    const unsigned rest=3*((degree+1)*(degree+1)-1);for(unsigned k=0;k<rest;++k)out<<"property float f_rest_"<<k<<'\n';out<<"end_header\n";
    for(size_t i=0;i<count;++i) {const float x=float(i%3),z=line?0:float(i/3);out<<x<<' '<<2+.25f*x+.5f*z<<' '<<z<<" -2 -2.5 -3 .9 .1 .2 .3 1 .1 .2 -.3 ";for(unsigned k=0;k<rest;++k)out<<float(int(k%7)-3)*.03125f<<' ';out<<'\n';}
    const auto text=out.str();return {text.begin(),text.end()};
}
Json open(const Bytes &bytes,unsigned budget=64*1024*1024) {return parsed(sv_open(bytes.data(),bytes.size(),0,1'000'000,budget));}
std::vector<Gaussian> scene() {const auto n=current().at("count").get<size_t>();return {sv_scene_ptr(),sv_scene_ptr()+n};}
Bytes masks() {const auto n=current().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n};}
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b) {return a.size()==b.size()&&!std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));}
void unchanged(const Json &before,const std::vector<Gaussian> &data,const Bytes &states) {
    const auto after=current();require(same(scene(),data)&&masks()==states,"Readonly/refused Floor changed Gaussian/mask bytes");
    for(const char *key:{"revision","contentRevision","canUndo","canRedo","alignment","camera"}) require(after[key]==before[key],"Readonly/refused Floor changed native history/alignment/default");
}
Json detect(View view={}) {if(view[5]==0)view=current()["camera"].get<View>();return command({{"command","detectFloor"},{"camera",view}});}
Json floorRequest(uint64_t id,View view,bool flip=false) {return {{"command","alignFloor"},{"id",id},{"flip",flip},{"camera",view},{"defaultCamera",view}};}
uint64_t id(const Json &v) {return v.at("floor").at("id");}
FloorPlane plane(const Json &v) {const auto &p=v.at("floor").at("plane");const auto n=p.at("normal").get<std::array<float,3>>(),c=p.at("center").get<std::array<float,3>>();return {{n[0],n[1],n[2]},{c[0],c[1],c[2]},p.at("radius"),p.at("rms"),p.at("inliers"),p.at("tested")};}
void readonlyLifecycle() {
    ++abiCases;require(open(ply())["ok"]==true&&sv_abi_version()==24&&current()["floor"].is_null(),"Floor ABI24 source failed");
    const auto before=current();const auto original=scene();const auto states=masks();const auto *pointer=sv_scene_ptr();const auto *maskPointer=sv_states_ptr();
    auto pending=detect();require(pending["pending"]==true&&pending["floor"]["status"]=="pending"&&pending["floor"]["plane"].is_null(),"Floor did not begin pending readonly analysis");
    const auto old=id(pending);require(command({{"command","point"},{"index",0}})["point"].is_array(),"Pending Floor blocks readonly point query");
    require(command({{"command","planeNormal"},{"points",Json::array({Json::array({0,0,0}),Json::array({1,0,0}),Json::array({2,0,0})})}})["ok"]==false&&current()["floor"]["id"]==old,
        "Refused readonly normal query cancelled Floor analysis");++refusals;
    require(command({{"command","cancelFloor"},{"id",old+1}})["floor"]["id"]==old,"Stale cancel retired live Floor");
    pending=parsed(sv_step(1));require(pending["pending"]==true&&sv_scene_ptr()==pointer&&sv_states_ptr()==maskPointer,"Partial Floor cloned/published document");unchanged(before,original,states);
    const auto ready=finish(pending);require(ready["floor"]["status"]=="ready"&&ready["floor"]["stage"]=="complete"&&!ready["floor"]["plane"].is_null(),"Floor did not retain native result");unchanged(before,original,states);
    require(sv_scene_ptr()==pointer&&sv_states_ptr()==maskPointer,"Terminal Floor replaced scene/mask owner");
    require(ready["memoryBytes"].get<size_t>()<before["memoryBytes"].get<size_t>()+sizeof(Job),"Terminal Floor retains analysis/sampling payload");
    require(command({{"command","cancelFloor"},{"id",old+1}})["floor"]==ready["floor"],"Stale cancel retired ready Floor");
    auto malformed=Json{{"command","detectFloor"},{"camera",Json::array({0,0,0})}};require(command(malformed)["ok"]==false&&current()["floor"]==ready["floor"],"Refused detect retired prior candidate");++refusals;
    require(command({{"command","cancelFloor"},{"id",0}})["ok"]==false&&current()["floor"]==ready["floor"],"Malformed cancel retired candidate");++refusals;
    const auto fresh=detect();require(id(fresh)>old&&fresh["floor"]["status"]=="pending","New detection recycled owner ID");
    require(command({{"command","cancelFloor"},{"id",old}})["floor"]["id"]==id(fresh),"Old cancel retired fresh analysis");
    require(named("cancel")["floor"].is_null()&&!current()["pending"].get<bool>(),"Generic cancellation retained active Floor");++cancelCases;
    require(open(ply(0,true))["ok"]==true,"None Floor source failed");const auto noneBefore=current();const auto line=scene();const auto lineMask=masks();const auto none=finish(detect());
    require(none["floor"]["status"]=="none"&&none["floor"]["stage"]=="complete"&&none["floor"]["plane"].is_null(),"Collinear Floor did not finish none");unchanged(noneBefore,line,lineMask);
    require(command(floorRequest(id(none),none["camera"].get<View>()))["ok"]==false,"None Floor confirmed");++refusals;
    require(open(ply())["floor"].is_null(),"Source replacement retained Floor candidate");
    const auto captured=finish(detect());require(named("selectNone")["floor"].is_null(),"Accepted no-op ordinary edit retained Floor candidate");
    require(command(floorRequest(id(captured),current()["camera"].get<View>()))["ok"]==false,"Retired Floor ID acquired new authority");++refusals;
    const auto active=detect();require(named("selectAll")["ok"]==true&&current()["floor"].is_null(),"Mask edit failed to cancel pending analysis");
    require(command({{"command","cancelFloor"},{"id",id(active)}})["floor"].is_null(),"Delayed analysis cancel reintroduced owner");
}
std::vector<Gaussian> affineGeometry(std::vector<Gaussian> values,const Matrix4 &matrix) {
    for(auto &g:values) {const auto original=g;double cov[3][3]{{original.covA[0],original.covA[1],original.covA[2]},{original.covA[1],original.covA[3],original.covB[0]},{original.covA[2],original.covB[0],original.covB[1]}},out[3][3]{};
        for(size_t r=0;r<3;++r) {double v=matrix[12+r];for(size_t c=0;c<3;++c)v+=double(matrix[c*4+r])*original.positionOpacity[c];g.positionOpacity[r]=float(v);
            for(size_t c=0;c<3;++c)for(size_t k=0;k<3;++k)for(size_t l=0;l<3;++l)out[r][c]+=double(matrix[k*4+r])*cov[k][l]*double(matrix[l*4+c]);}
        g.covA={float(out[0][0]),float(out[0][1]),float(out[0][2]),float(out[1][1])};g.covB[0]=float(out[1][2]);g.covB[1]=float(out[2][2]);}
    return values;
}
std::array<double,16> basis(std::array<double,3> p) {const auto x=p[0],y=p[1],z=p[2],xx=x*x,yy=y*y,zz=z*z;
    return {.28209479177387814,-.4886025119029199*y,.4886025119029199*z,-.4886025119029199*x,1.0925484305920792*x*y,-1.0925484305920792*y*z,.31539156525252005*(2*zz-xx-yy),-1.0925484305920792*x*z,.5462742152960396*(xx-yy),-.5900435899266435*y*(3*xx-yy),2.890611442640554*x*y*z,-.4570457994644658*y*(4*zz-xx-yy),.3731763325901154*z*(2*zz-3*xx-3*yy),-.4570457994644658*x*(4*zz-xx-yy),1.445305721320277*z*(xx-yy),-.5900435899266435*x*(xx-3*yy)};}
double directional(const Gaussian &g,unsigned degree,unsigned channel,std::array<double,3> direction) {const auto b=basis(direction);double value{};for(unsigned k=0;k<(degree+1)*(degree+1);++k)value+=b[k]*shValue(g,k,channel);return value;}
void allMemberAlignmentAndRollback() {
    ++abiCases;
    for(unsigned degree=0;degree<=3;++degree) {
        require(open(ply(degree))["ok"]==true,"Floor SH degree source failed");
        require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true&&named("delete")["ok"]==true,"Floor deleted fixture failed");
        require(command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true&&command({{"command","single"},{"index",3},{"operation",1}})["ok"]==true&&command({{"command","single"},{"index",4},{"operation",1}})["ok"]==true,"Floor selected fixture failed");
        const auto baseline=current();const auto original=scene();const auto states=masks();const auto ready=finish(detect());require(ready["floor"]["selectedOnly"]==true&&ready["floor"]["plane"]["tested"]==3,"Floor selectedCount scope/eligibility differs");
        auto view=ready["camera"].get<View>();view[9]=.4f;view[8]=(degree%2)?0.f:1.f;
        const bool flip=degree>=2;const auto matrix=alignFloor(plane(ready),flip!=!bool(view[8]));const auto expected=affineGeometry(original,matrix);
        require(named("beginTransaction")["floor"]==ready["floor"],"Checkpoint changed retained Floor candidate");
        auto started=command(floorRequest(id(ready),view,flip));require(started["pending"]==true&&started["floor"]==ready["floor"],"Floor confirmation lost candidate before publication");
        started=parsed(sv_step(1));require(started["pending"]==true,"Floor transform did not yield");unchanged(baseline,original,states);
        const auto aligned=finish(started);const auto transformed=scene();require(aligned["floor"].is_null()&&aligned["alignment"]["canReset"]==true&&masks()==states,"Floor published wrong candidate/Reset/masks");
        require(aligned["alignment"]["frame"].get<Matrix4>()==matrix&&aligned["camera"][9]==0,"Floor effective flip/frame/WorldUpright differs");
        for(size_t i=0;i<original.size();++i) {
            require(transformed[i].positionOpacity==expected[i].positionOpacity&&transformed[i].covA==expected[i].covA&&transformed[i].covB==expected[i].covB,"Floor all-member affine/covariance/padding/opacity differs");
            for(auto direction:{std::array<double,3>{1,0,0},std::array<double,3>{0,1,0},std::array<double,3>{1,2,3}}) {
                const auto length=std::sqrt(direction[0]*direction[0]+direction[1]*direction[1]+direction[2]*direction[2]);for(auto &v:direction)v/=length;std::array<double,3> inverse{};
                for(size_t c=0;c<3;++c)for(size_t r=0;r<3;++r)inverse[c]+=double(matrix[c*4+r])*direction[r];
                for(unsigned channel=0;channel<3;++channel)require(std::abs(directional(transformed[i],degree,channel,direction)-directional(original[i],degree,channel,inverse))<3e-4,"Floor directional SH rotation differs from independent polynomial");
            }
        }
        require(named("rollbackTransaction")["floor"]==ready["floor"],"Floor rollback did not restore candidate/id");unchanged(baseline,original,states);++rollbackCases;
        require(named("beginTransaction")["ok"]==true,"Floor retry checkpoint failed");const auto repeated=finish(command(floorRequest(id(ready),view,flip)));
        require(same(scene(),transformed)&&named("commitTransaction")["floor"].is_null(),"Floor retry/commit differs or retained consumed candidate");
        const auto resetView=repeated["camera"].get<View>();require(command({{"command","resetAlignment"},{"camera",resetView},{"defaultCamera",resetView}})["ok"]==true&&same(scene(),original)&&masks()==states,"Floor Reset lost exact original scene/mask");
        require(named("undo")["ok"]==true&&same(scene(),transformed)&&named("undo")["ok"]==true&&same(scene(),original),"Floor Undo/UndoReset lost history");
        require(named("redo")["ok"]==true&&same(scene(),transformed)&&named("redo")["ok"]==true&&same(scene(),original),"Floor Redo/RedoReset lost history");
    }
}
void admissionAndCancellation() {
    ++abiCases;
    require(open(ply())["ok"]==true,"Floor refusal source failed");const auto ready=finish(detect());const auto original=scene();const auto states=masks();const auto view=ready["camera"].get<View>();
    std::vector<Json> invalid{floorRequest(id(ready)+1,view),floorRequest(id(ready),view)};
    invalid[1]["defaultCamera"]=Json::array({0,0,0});auto flip=floorRequest(id(ready),view);flip["flip"]=1;invalid.push_back(flip);
    for(const auto &bad:invalid) {require(command(bad)["ok"]==false&&current()["floor"]==ready["floor"],"Refused Floor confirm damaged candidate");unchanged(ready,original,states);++refusals;}
    require(named("beginTransaction")["ok"]==true&&command(floorRequest(id(ready),view))["pending"]==true&&parsed(sv_step(1))["pending"]==true,"Floor cancel fixture did not yield");
    require(named("cancel")["ok"]==true&&named("rollbackTransaction")["floor"]==ready["floor"],"Cancelled Floor rollback lost candidate");unchanged(ready,original,states);++cancelCases;++rollbackCases;
    require(named("beginTransaction")["ok"]==true&&command(floorRequest(id(ready),view))["pending"]==true&&parsed(sv_step(1))["pending"]==true,"Targeted Floor transform fixture did not yield");
    require(command({{"command","cancelFloor"},{"id",id(ready)+1}})["pending"]==true,"Unrelated targeted cancel stopped Floor transform");
    const auto cancelled=command({{"command","cancelFloor"},{"id",id(ready)}});
    require(cancelled["ok"]==true&&!cancelled["pending"].get<bool>()&&cancelled["floor"].is_null(),"Targeted cancel allowed matching Floor transform to finish");
    unchanged(ready,original,states);require(named("rollbackTransaction")["floor"]==ready["floor"],"Targeted cancellation rollback lost candidate");++cancelCases;++rollbackCases;
    require(command({{"command","cancelFloor"},{"id",id(ready)}})["floor"].is_null(),"Ready Floor cancellation failed");
    const auto beforeDetection=current();require(detect()["pending"]==true,"Floor scratch refusal did not begin");
    sv_allocation::failBackendAtForContracts(1);const auto *failedStep=sv_step(1);sv_allocation::failBackendAtForContracts(0);
    require(parsed(failedStep)["ok"]==false&&!current()["pending"].get<bool>()&&current()["floor"].is_null(),"Floor scratch refusal retained live analysis");
    unchanged(beforeDetection,original,states);++refusals;
    for(size_t ordinal=2;ordinal<=12;++ordinal) {
        require(open(ply())["ok"]==true,"Floor publication grid failed");const auto captured=finish(detect());const auto data=scene();const auto mask=masks();const auto camera=captured["camera"].get<View>();
        require(named("beginTransaction")["ok"]==true&&command(floorRequest(id(captured),camera))["pending"]==true&&parsed(sv_step(8))["pending"]==true,"Floor publication fixture did not yield before terminal");
        sv_allocation::failBackendAtForContracts(ordinal);const auto *text=sv_step(1);sv_allocation::failBackendAtForContracts(0);const auto result=parsed(text);
        if(result["ok"]==false) {require(current()["floor"]==captured["floor"],"Refused Floor publication retired candidate");unchanged(captured,data,mask);++publicationRefusals;}
        require(named("rollbackTransaction")["floor"]==captured["floor"],"Floor terminal rollback lost candidate ID");unchanged(captured,data,mask);++rollbackCases;
    }
    require(publicationRefusals>=3,"Floor publication injection did not cover staging depths");
    require(open(ply())["ok"]==true,"Floor detect admission source failed");const auto captured=finish(detect());
    sv_allocation::failBackendAtForContracts(1);const auto *text=sv_command("{\"command\":\"detectFloor\",\"camera\":[0,0,0,0,0,3,1,45,1,0,1]}");sv_allocation::failBackendAtForContracts(0);
    require(parsed(text)["ok"]==false&&current()["floor"]==captured["floor"],"Detect admission refusal lost ready candidate");++refusals;
}
void mixedSessionReset() {
    ++abiCases;require(open(ply())["ok"]==true,"Mixed Floor source failed");const auto original=scene();const auto states=masks();
    const auto initial=current();const auto view=initial["camera"].get<View>();
    require(named("beginTransaction")["ok"]==true,"Mixed Center checkpoint failed");
    const auto centered=finish(command({{"command","alignCenter"},{"point",std::array<float,3>{.25f,.5f,.75f}},{"camera",view},{"defaultCamera",view}}));
    require(named("commitTransaction")["ok"]==true&&centered["alignment"]["canReset"]==true,"Mixed Center did not establish baseline");
    const auto centerData=scene();const auto ready=finish(detect());require(ready["alignment"]==centered["alignment"],"Readonly Floor detection retired existing alignment baseline");
    const auto carried=ready["camera"].get<View>();require(named("beginTransaction")["ok"]==true,"Mixed Floor checkpoint failed");
    const auto aligned=finish(command(floorRequest(id(ready),carried)));const auto alignedData=scene();require(named("commitTransaction")["ok"]==true,"Mixed Floor commit failed");
    const auto reset=aligned["camera"].get<View>();require(command({{"command","resetAlignment"},{"camera",reset},{"defaultCamera",reset}})["ok"]==true&&same(scene(),original)&&masks()==states,"Mixed Center/Floor Reset lost uninterrupted original baseline");
    require(named("undo")["ok"]==true&&same(scene(),alignedData)&&named("undo")["ok"]==true&&same(scene(),centerData)&&named("undo")["ok"]==true&&same(scene(),original),"Mixed Center/Floor Undo history differs");
    require(named("redo")["ok"]==true&&same(scene(),centerData)&&named("redo")["ok"]==true&&same(scene(),alignedData)&&named("redo")["ok"]==true&&same(scene(),original),"Mixed Center/Floor Redo history differs");
}
#endif
}
int main() {
    try {
        std::string reference;for(const auto chunk:floorReferenceChunks)reference+=chunk;sourceContracts(Json::parse(reference));
#ifndef SV_FLOOR_HOST_ONLY
        readonlyLifecycle();allMemberAlignmentAndRollback();admissionAndCancellation();mixedSessionReset();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final Floor census invalid");
#endif
        std::printf("SPLATVIEW_FLOOR_CONTRACTS_PASS checks=%zu referenceRuns=%zu referenceCandidates=%zu referenceNone=%zu rngRanges=%zu matrixCameraCases=%zu cancellationCases=%zu abiCases=%zu refusals=%zu publicationRefusals=%zu rollbackCases=%zu\n",checks,referenceRuns,referenceCandidates,referenceNone,rngRanges,matrixCases,cancelCases,abiCases,refusals,publicationRefusals,rollbackCases);return 0;
    } catch(const std::exception &e) {
#ifndef SV_FLOOR_HOST_ONLY
        sv_allocation::failBackendAtForContracts(0);
#endif
        std::fprintf(stderr,"SPLATVIEW_FLOOR_CONTRACTS_FAIL %s\n",e.what());return 1;
    }
}
