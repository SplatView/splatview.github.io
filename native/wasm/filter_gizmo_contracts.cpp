// Actual camera C ABI plus independent analytic projection, Rodrigues and
// constraint oracles. No production fault, observation or test-only API.
#include "browser_filter_gizmo.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>
#include <emscripten/heap.h>
extern "C" {
int sv_camera_filter_gizmo_frame(const float *,float *) noexcept;
int sv_camera_filter_gizmo_begin(const float *,int,float *) noexcept;
int sv_camera_filter_gizmo_update(const float *,const float *,float *) noexcept;
}
namespace {
using namespace preview::browser_filter_gizmo;
constexpr double pi=3.14159265358979323846;
struct V { double x{},y{},z{}; };
V operator+(V a,V b) { return {a.x+b.x,a.y+b.y,a.z+b.z}; }
V operator-(V a,V b) { return {a.x-b.x,a.y-b.y,a.z-b.z}; }
V operator*(V a,double s) { return {a.x*s,a.y*s,a.z*s}; }
double dot(V a,V b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
V cross(V a,V b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
V normalize(V a) { return a*(1/std::sqrt(dot(a,a))); }
V rotate(V v,V axis,double angle) { return v*std::cos(angle)+cross(axis,v)*std::sin(angle)+axis*(dot(axis,v)*(1-std::cos(angle))); }
V rotated(V v,const Pose &pose) {
    const V r{pose[6],pose[7],pose[8]};const auto length=std::sqrt(dot(r,r));return length<1e-9?v:rotate(v,r*(1/length),length*pi/180);
}
size_t cases{},checks{},handles{},refusals{},aliases{},frames{},updates{};
void require(bool condition,const char *message) { ++checks;if(!condition)throw std::runtime_error(message); }
void close(double a,double b,const char *message,double tolerance=3e-4) { require(std::abs(a-b)<=tolerance,message); }
void close(V a,V b,const char *message,double tolerance=3e-4) { close(a.x,b.x,message,tolerance);close(a.y,b.y,message,tolerance);close(a.z,b.z,message,tolerance); }
Pose pose(const Input &in) { Pose out;std::copy_n(in.begin()+44,poseFloats,out.begin());return out; }
V center(const Input &in) { return {in[44],in[45],in[46]}; }
V axis(int index) { return {index==0?1.:0.,index==1?1.:0.,index==2?1.:0.}; }
Input fixture(int operation=0,int shape=2,bool frontal=false,bool local=false) {
    Input in{};const V eye=frontal?V{0,0,5}:V{4,3,6};const auto z=normalize(eye),x=normalize(cross({0,1,0},z)),y=cross(z,x);
    in[0]=float(x.x);in[1]=float(y.x);in[2]=float(z.x);in[4]=float(x.y);in[5]=float(y.y);in[6]=float(z.y);
    in[8]=float(x.z);in[9]=float(y.z);in[10]=float(z.z);in[12]=float(-dot(x,eye));in[13]=float(-dot(y,eye));in[14]=float(-dot(z,eye));in[15]=1;
    // Independent reversed infinite perspective matrix, fov90 and aspect1.
    in[16]=1;in[21]=1;in[27]=-1;in[30]=.1f;
    in[32]=0;in[33]=0;in[34]=400;in[35]=400;in[36]=1;in[37]=float(shape);in[38]=float(operation);in[39]=local?1.f:0.f;
    in[42]=200;in[43]=200;in[47]=2;in[48]=3;in[49]=4;in[53]=1;in[54]=60;in[55]=1;in[56]=.2f;in[57]=2;
    return in;
}
Pointer projected(const Input &in,V point,float control=0) {
    // Analytic camera coordinates (no inverse/multiply from the product).
    const V x{in[0],in[4],in[8]},y{in[1],in[5],in[9]},z{in[2],in[6],in[10]};
    const auto depth=-(dot(z,point)+in[14]);
    const auto nx=(dot(x,point)+in[12])*in[16]/depth,ny=(dot(y,point)+in[13])*in[21]/depth;
    return {float(in[32]+(1+nx)*in[34]*.5),float(in[33]+(1-ny)*in[35]*.5),control};
}
double worldLength(const Input &in) { return .13*in[36]*(-in[14])/in[16]; }
V cameraRight(const Input &in) { return {in[0],in[4],in[8]}; }
V cameraUp(const Input &in) { return {in[1],in[5],in[9]}; }
V cameraForward(const Input &in) { return {in[2],in[6],in[10]}; }
V handleAxis(const Input &in,int index) { return in[39]!=0||in[38]==2?rotated(axis(index),pose(in)):axis(index); }
V pressPoint(const Input &in,int handle) {
    const auto extent=worldLength(in);const auto c=center(in);
    if(handle<=3)return c+handleAxis(in,handle-1)*(extent*.82);
    if(handle<=6) { const auto normal=handle-4;return c+(handleAxis(in,(normal+1)%3)+handleAxis(in,(normal+2)%3))*(extent*.65); }
    if(handle==7||handle==15)return c;
    if(handle<=10) { const auto i=handle-8;return c+(handleAxis(in,(i+1)%3)*std::cos(.37)+handleAxis(in,(i+2)%3)*std::sin(.37))*extent; }
    if(handle==11)return c+(cameraRight(in)*std::cos(.27)+cameraUp(in)*std::sin(.27))*(extent*1.18);
    return c+handleAxis(in,handle-12)*extent;
}
State beginAt(Input &in,int handle) {
    const auto pointer=projected(in,pressPoint(in,handle));in[42]=pointer[0];in[43]=pointer[1];
    Frame drawn;drawn.fill(-91);
    require(sv_camera_filter_gizmo_frame(in.data(),drawn.data())==1,"Valid native CSS frame refused");++frames;
    char hitMessage[256];std::snprintf(hitMessage,sizeof(hitMessage),
        "Analytic handle press mismatch expected=%d hit=%.0f shape=%.0f op=%.0f local=%.0f pointer=(%.8g,%.8g) center=(%.8g,%.8g) rows=%.0f",
        handle,drawn[1],in[37],in[38],in[39],in[42],in[43],drawn[2],drawn[3],drawn[0]);
    require(drawn[1]==handle,hitMessage);
    State out;out.fill(-91);const auto before=in;
    require(sv_camera_filter_gizmo_begin(in.data(),handle,out.data())==1,"Drawn analytic handle refused begin");
    require(in==before,"Begin changed its camera/pose input");
    require(out[0]==104729&&out[1]==1&&out[2]==handle,"Opaque state header mismatch");
    require(std::equal(in.begin(),in.end(),out.begin()+3),"Opaque drag state failed to freeze exact entry input");
    require(std::all_of(out.begin()+61,out.end(),[](float v){return v==0;}),"Opaque drag state reserved slots are not zero");++handles;return out;
}
Pose moved(const State &state,const Pointer &pointer) {
    const auto originalState=state;const auto originalPointer=pointer;
    std::array<float,18> guarded;guarded.fill(-19.25f);
    require(sv_camera_filter_gizmo_update(state.data(),pointer.data(),guarded.data()+2)==1,"Analytic native drag refused update");++updates;
    require(guarded[0]==-19.25f&&guarded[1]==-19.25f&&guarded[16]==-19.25f&&guarded[17]==-19.25f,"Update wrote outside pose14");
    require(state==originalState&&pointer==originalPointer,"Update mutated immutable state or pointer");
    Pose out;std::copy_n(guarded.begin()+2,poseFloats,out.begin());
    require(std::all_of(out.begin(),out.end(),[](float v){return std::isfinite(v);}),"Update published nonfinite pose");
    for(int i=10;i<14;++i)require(out[i]==state[3+44+i],"Drag changed fov/aspect/near/far");return out;
}
void moveHandles() {
    ++cases;
    for(bool local:{false,true})for(int handle=1;handle<=7;++handle) {
        auto in=fixture(0,2,false,local);in[50]=17;in[51]=-23;in[52]=31;const auto start=beginAt(in,handle);const auto base=pose(in);V delta{};
        if(handle<=3)delta=handleAxis(in,handle-1)*.17;
        else if(handle<=6) { const auto normal=handle-4;delta=handleAxis(in,(normal+1)%3)*.17+handleAxis(in,(normal+2)%3)*-.12; }
        else delta=cameraRight(in)*.17+cameraUp(in)*-.12;
        const auto result=moved(start,projected(in,pressPoint(in,handle)+delta));
        close(V{result[0],result[1],result[2]},center(in)+delta,"Move axis/plane/screen differs from analytic constraint");
        for(int i=3;i<14;++i)if(i>=6&&i<=8)close(result[i],base[i],"Move changed orientation",1e-5);else require(result[i]==base[i],"Move changed non-position fields");
        const auto noChange=moved(start,{in[42],in[43],0});require(noChange==base,"Stationary Move changed entry pose");
    }
}
void rotateHandles() {
    ++cases;
    for(bool local:{false,true})for(int handle=8;handle<=11;++handle) {
        auto in=fixture(1,2,false,local);in[50]=17;in[51]=-23;in[52]=31;
        const auto start=beginAt(in,handle);const auto base=pose(in);
        const auto normal=handle==11?cameraForward(in)*-1:handleAxis(in,handle-8);
        const auto initial=pressPoint(in,handle)-center(in),target=rotate(initial,normal,pi/3);
        const auto result=moved(start,projected(in,center(in)+target));
        for(int i=0;i<3;++i)close(rotated(axis(i),result),rotate(rotated(axis(i),base),normal,pi/3),"Local/world rotation composition differs from analytic Rodrigues oracle",6e-4);
        for(int i:{0,1,2,3,4,5,9,10,11,12,13})require(result[i]==base[i],"Rotate changed non-rotation fields");
        const auto unchanged=moved(start,{in[42],in[43],0});
        for(int i=6;i<9;++i)close(unchanged[i],base[i],"Stationary Rotate changed rotation",1e-5);
    }
}
void scaleHandles() {
    ++cases;
    for(int shape:{1,2,3})for(bool local:{false,true})for(int handle=12;handle<=15;++handle) {
        auto in=fixture(2,shape,false,local);in[50]=17;in[51]=-23;in[52]=31;const auto start=beginAt(in,handle);const auto base=pose(in);
        Pointer pointer;if(handle==15)pointer={in[42]+30,in[43],0};else pointer=projected(in,center(in)+(pressPoint(in,handle)-center(in))*1.3);
        const auto result=moved(start,pointer);
        if(shape==1) { close(result[9],base[9]*1.3,"Sphere axis/uniform scaling failed largest-change radius rule");for(int i=3;i<6;++i)require(result[i]==base[i],"Sphere changed unrelated stored box dimensions"); }
        else for(int i=0;i<3;++i)close(result[3+i],base[3+i]*((handle==15||i==handle-12)?1.3:1),"Scale must use local axis regardless of local/world toggle");
        for(int i:{0,1,2,10,11,12,13})require(result[i]==base[i],"Scale changed position/lens fields");
        for(int i=6;i<9;++i)close(result[i],base[i],"Scale changed orientation",1e-5);
    }
    auto in=fixture(2,1);const auto start=beginAt(in,15);const auto tiny=moved(start,{in[42]-200,in[43],0});close(tiny[9],.001,"Uniform scale failed positive .001 factor clamp",1e-6);
    in=fixture(2,1);const auto sphereAxis=beginAt(in,12);const auto shrunk=moved(sphereAxis,projected(in,pressPoint(in,12)*.6));
    close(shrunk[9],.6,"Sphere shrinking axis incorrectly chose a larger unchanged axis");
    in=fixture(2,2);in[47]=0;const auto zero=beginAt(in,12);const auto expanded=moved(zero,projected(in,pressPoint(in,12)*2));close(expanded[3],2e-6,"Zero box axis failed desktop matrix minimum scale",1e-9);
}
void snappingReplay() {
    ++cases;auto in=fixture(0,2,true);auto state=beginAt(in,7);
    for(double delta:{.164,-.164,.05,-.05}) {
        const auto pointer=projected(in,{delta,0,0});auto ctrl=pointer;ctrl[2]=1;
        const auto snapped=moved(state,ctrl),unsnapped=moved(state,pointer),again=moved(state,ctrl);
        close(unsnapped[0],delta,"Ctrl release did not replay unsnapped entry baseline",1e-6);
        close(snapped[0],std::abs(delta)==.05?delta:(delta<0?-.2:.2),"Signed Move snapping or exact half-step tie differs",1e-6);
        require(snapped==again,"Ctrl snap replay accumulated prior drag results");
    }
    // Local and screen Move snap in source orientation; world-axis Move snaps
    // world coordinates. Screen uses local orientation even in World mode.
    for(int handle:{1,7})for(bool local:{false,true}) {
        auto v=fixture(0,2,false,local);v[52]=35;v[40]=1;const auto s=beginAt(v,handle);
        const V initial=pressPoint(v,handle);V delta;
        if(handle==1)delta=handleAxis(v,0)*.164;else delta=cameraRight(v)*.164;
        const auto p=moved(s,projected(v,initial+delta));V expected;
        if(local||handle==7) {
            const auto x=rotated(axis(0),pose(v)),y=rotated(axis(1),pose(v)),z=rotated(axis(2),pose(v));
            auto nearest=[](double n){return std::round(n/.1)*.1;};expected=x*nearest(dot(delta,x))+y*nearest(dot(delta,y))+z*nearest(dot(delta,z));
        } else expected={std::round(delta.x/.1)*.1,std::round(delta.y/.1)*.1,std::round(delta.z/.1)*.1};
        close(V{p[0],p[1],p[2]},expected,"Move snap coordinate-space semantics differ");
    }
    auto rotation=fixture(1,2);state=beginAt(rotation,8);const auto initial=pressPoint(rotation,8);const auto target=rotate(initial,{1,0,0},22*pi/180);
    auto pointer=projected(rotation,target);pointer[2]=1;const auto snapped=moved(state,pointer);
    close(rotated({0,1,0},snapped),rotate({0,1,0},{1,0,0},15*pi/180),"Rotation Ctrl snapping failed 15-degree increment");
    auto scale=fixture(2,2);state=beginAt(scale,15);const auto scaled=moved(state,{scale[42]+16.4f,scale[43],1});close(scaled[3],2.4,"Scale snapping must snap cumulative multiplier by .1");
}
void frameGeometry() {
    ++cases;
    for(int shape=1;shape<=4;++shape) {
        auto in=fixture(0,shape,true);in[41]=1;
        Frame frame;require(sv_camera_filter_gizmo_frame(in.data(),frame.data())==1,"Valid volume frame refused");++frames;
        require(frame[0]>=0&&frame[0]<=maxPrimitives&&frame[0]==std::floor(frame[0]),"Frame count exceeds constant capacity");
        size_t volume{};for(size_t i=0;i<size_t(frame[0]);++i) {
            const auto *row=frame.data()+4+i*primitiveFloats;
            require(row[0]>=0&&row[0]<=15&&row[1]>=0&&row[1]<=4&&row[2]>=0&&row[2]<=3,"Primitive type/role/handle out of range");
            if(row[1]==4) { ++volume;require(row[0]==0&&row[2]==0,"Volume outline became an interactive handle"); }
        }
        require(volume==size_t(shape==1||shape==3?192:12),"Independent volume edge/ring count differs");
        require(std::all_of(frame.begin()+4+size_t(frame[0])*primitiveFloats,frame.end(),[](float v){return v==0;}),"Frame trailing capacity retained old primitives");
        close(frame[2],200,"Projected center CSS X incorrect");close(frame[3],200,"Projected center CSS Y incorrect");
    }
    // Viewport offset and panel scaling are CSS values, independent of DPR.
    auto in=fixture(0,2,true);in[32]=37;in[33]=19;in[36]=2;Frame frame;
    require(sv_camera_filter_gizmo_frame(in.data(),frame.data())==1,"Offset/scaled frame refused");++frames;
    close(frame[2],237,"Viewport X offset not applied");close(frame[3],219,"Viewport Y offset not applied");
    const auto *disc=frame.data()+4+(size_t(frame[0])-1)*primitiveFloats;require(disc[0]==7&&disc[2]==1&&disc[5]==12,"Center marker panelScale compounded or omitted");
    in=fixture(0,2,true);in[41]=1;in[47]=in[48]=in[49]=100;require(sv_camera_filter_gizmo_frame(in.data(),frame.data())==1,"Clipped large box refused");++frames;
    for(size_t i=0;i<size_t(frame[0]);++i) { const auto *row=frame.data()+4+i*primitiveFloats;if(row[2]==0)for(int j=3;j<7;++j)require(row[j]>=-.001&&row[j]<=400.001,"Homogeneous clipping published off-viewport/behind-camera line"); }
    in=fixture(1,3);in[41]=1;require(sv_camera_filter_gizmo_frame(in.data(),frame.data())==1,"Combined rotate/ellipsoid frame refused");++frames;require(frame[0]<=448,"Rotate+volume exceeded proven 448-row maximum");
}
void projectionVariants() {
    ++cases;
    // Conventional and reversed finite projections use the same independent
    // near/far constraints. Near/far unprojection ordering must not jump.
    for(int variant=0;variant<3;++variant) {
        auto in=fixture(0,2,true);
        if(variant==1) { in[26]=float(100./(.1-100));in[30]=float(.1*100/(.1-100)); }
        if(variant==2) { in[26]=float(.1/(100-.1));in[30]=float(.1*100/(100-.1)); }
        const auto state=beginAt(in,7);const auto result=moved(state,projected(in,{.23,-.17,0}));
        close(result[0],.23,"Finite/reversed/infinite ray changed X translation",1e-5);close(result[1],-.17,"Finite/reversed/infinite ray changed Y translation",1e-5);
    }
    // Edge-on Z axis and X/Y rotation rings are suppressed in a frontal view.
    for(int operation:{0,1,2}) { auto in=fixture(operation,2,true);Frame drawn;require(sv_camera_filter_gizmo_frame(in.data(),drawn.data())==1,"Frontal degeneracy frame refused");
        for(size_t i=0;i<size_t(drawn[0]);++i) { const auto h=int(drawn[4+i*primitiveFloats]);require(operation==0?h!=3:operation==1?(h!=8&&h!=9):h!=14,"Degenerate axis/ring was still drawn as a handle"); }
    }
}
void desktopDecomposition() {
    ++cases;
    for(int shape:{1,2})for(int operation:{0,1}) {
        auto in=fixture(operation,shape);in[52]=270;if(shape==1)in[53]=0;else in[47]=0;
        // Inactive fields may carry an invalid draft for a different kind.
        if(shape==1) { in[47]=-3;in[48]=-4;in[49]=-5; } else in[53]=-7;
        const auto handle=operation==0?7:11;const auto state=beginAt(in,handle);const auto base=pose(in);
        const auto stationary=moved(state,{in[42],in[43],0});require(stationary==base,"Stationary pose was unnecessarily decomposed");
        Pointer pointer;
        if(operation==0)pointer=projected(in,pressPoint(in,handle)+cameraRight(in)*.2);
        else pointer=projected(in,rotate(pressPoint(in,handle),cameraForward(in)*-1,pi/6));
        const auto result=moved(state,pointer);
        require(shape==1?result[9]==1e-6f:result[3]==1e-6f,"Non-Scale manipulation omitted active minimum dimension");
        require(shape==1?(result[3]==-3&&result[4]==-4&&result[5]==-5):result[9]==-7,"Matrix decomposition changed inactive filter parameters");
        require(std::hypot(result[6],result[7],result[8])<=180.0001,"Rotation vector not canonical shortest axis-angle");
        if(operation==0)close(rotated({1,0,0},result),rotated({1,0,0},base),"Move decomposition changed original orientation");
    }
}
void noPartialWrites() {
    ++cases;auto in=fixture();Frame frame;frame.fill(71.25f);State state;state.fill(71.25f);Pose output;output.fill(71.25f);
    auto frameRefusal=[&](const Input &bad){const auto before=frame;require(sv_camera_filter_gizmo_frame(bad.data(),frame.data())==0,"Malformed frame accepted");require(frame==before,"Frame refusal changed output bytes");++refusals;};
    for(int index:{0,16,32,36,44,50}) { auto bad=in;bad[index]=std::numeric_limits<float>::quiet_NaN();frameRefusal(bad); }
    for(int index:{34,35,36}) { auto bad=in;bad[index]=0;frameRefusal(bad); }
    auto bad=in;bad[37]=0;frameRefusal(bad);bad=in;bad[38]=3;frameRefusal(bad);bad=in;bad[39]=.5f;frameRefusal(bad);
    bad=in;std::fill_n(bad.begin()+16,16,0);frameRefusal(bad);bad=in;bad[0]=2;frameRefusal(bad);
    bad=in;bad[37]=3;bad[47]=0;frameRefusal(bad);bad=in;bad[44]=1e12f;bad[47]=1e12f;frameRefusal(bad);
    bad=in;bad[37]=4;bad[38]=2;frameRefusal(bad);bad=in;bad[37]=4;bad[54]=0;frameRefusal(bad);bad=in;bad[37]=4;bad[56]=bad[57];frameRefusal(bad);
    for(int handle:{0,8,12,16}) { const auto before=state;require(sv_camera_filter_gizmo_begin(in.data(),handle,state.data())==0,"Wrong family/out-of-range handle accepted");require(state==before,"Begin refusal changed output");++refusals; }
    for(int handle=12;handle<=15;++handle) { auto frustum=fixture(2,4);const auto before=state;require(sv_camera_filter_gizmo_begin(frustum.data(),handle,state.data())==0,"Frustum Scale accepted begin");require(state==before,"Frustum Scale refusal changed state");++refusals; }
    bad=in;bad[42]=bad[43]=0;const auto before=state;require(sv_camera_filter_gizmo_begin(bad.data(),1,state.data())==0,"Unhit axis accepted begin");require(state==before,"Unhit begin changed output");++refusals;
    in=fixture(0,2,true);state=beginAt(in,7);
    auto updateRefusal=[&](const State &badState,Pointer pointer){const auto before=output;require(sv_camera_filter_gizmo_update(badState.data(),pointer.data(),output.data())==0,"Malformed drag accepted");require(output==before,"Update refusal changed pose bytes");++refusals;};
    for(int slot:{0,1,2,61,95}) { auto invalid=state;invalid[slot]+=.5f;updateRefusal(invalid,{210,200,0}); }
    auto invalid=state;invalid[10]=std::numeric_limits<float>::quiet_NaN();updateRefusal(invalid,{210,200,0});
    updateRefusal(state,{210,200,.5f});updateRefusal(state,{std::numeric_limits<float>::infinity(),200,0});
    const auto heap=emscripten_get_heap_size();
    const auto *unreadable=reinterpret_cast<const float *>(heap-4),*unaligned=reinterpret_cast<const float *>(uintptr_t(in.data())+1);
    const auto original=frame;require(sv_camera_filter_gizmo_frame(nullptr,frame.data())==0&&sv_camera_filter_gizmo_frame(unreadable,frame.data())==0&&sv_camera_filter_gizmo_frame(unaligned,frame.data())==0,"Frame range guards accepted invalid pointer");require(frame==original,"Range guard changed frame");refusals+=3;
    require(sv_camera_filter_gizmo_frame(in.data(),nullptr)==0&&sv_camera_filter_gizmo_begin(in.data(),7,nullptr)==0&&sv_camera_filter_gizmo_update(state.data(),nullptr,output.data())==0,"Null output/pointer admitted");refusals+=3;
    const auto originalPose=output;require(sv_camera_filter_gizmo_update(unreadable,in.data(),output.data())==0&&sv_camera_filter_gizmo_update(state.data(),unreadable,output.data())==0,"Update range guard admitted short state/pointer");require(output==originalPose,"Update range guard published partial pose");refusals+=2;
}
void aliasPublication() {
    ++cases;auto in=fixture(0,2,true);const auto state=beginAt(in,7);const auto event=projected(in,{.23,.17,0});const auto expected=moved(state,event);
    std::vector<float> storage(frameFloats+4,91.5f);std::copy(in.begin(),in.end(),storage.begin()+2);Frame frame;
    require(sv_camera_filter_gizmo_frame(in.data(),frame.data())==1,"Alias fixture frame refused");
    require(sv_camera_filter_gizmo_frame(storage.data()+2,storage.data()+2)==1,"Frame input/output alias refused");
    require(std::equal(frame.begin(),frame.end(),storage.begin()+2)&&storage[0]==91.5f&&storage[1]==91.5f&&storage.back()==91.5f,"Aliased frame differs or escaped its output");++aliases;
    std::array<float,stateFloats> overlap{};std::copy(in.begin(),in.end(),overlap.begin());require(sv_camera_filter_gizmo_begin(overlap.data(),7,overlap.data())==1,"Begin input/output alias refused");require(overlap==state,"Aliased begin changed canonical state");++aliases;
    auto reused=state;require(sv_camera_filter_gizmo_update(reused.data(),event.data(),reused.data())==1,"Update state/output alias refused");require(std::equal(expected.begin(),expected.end(),reused.begin()),"Aliased update differs from analytic published pose");++aliases;
    std::array<float,poseFloats> eventOutput{};std::copy(event.begin(),event.end(),eventOutput.begin());require(sv_camera_filter_gizmo_update(state.data(),eventOutput.data(),eventOutput.data())==1,"Update pointer/output alias refused");require(eventOutput==expected,"Pointer/output alias read after write");++aliases;
}
}
int main() {
    try { moveHandles();rotateHandles();scaleHandles();snappingReplay();frameGeometry();projectionVariants();desktopDecomposition();noPartialWrites();aliasPublication();
        std::printf("SPLATVIEW_FILTER_GIZMO_CONTRACTS_PASS cases=%zu checks=%zu handles=%zu frames=%zu updates=%zu refusals=%zu aliases=%zu inputBytes=%zu stateBytes=%zu frameBytes=%zu poseBytes=%zu\n",
            cases,checks,handles,frames,updates,refusals,aliases,sizeof(Input),sizeof(State),sizeof(Frame),sizeof(Pose));return 0;
    } catch(const std::exception &error) { std::fprintf(stderr,"Filter gizmo contract failure: %s (checks=%zu handles=%zu)\n",error.what(),checks,handles);return 1; }
}
