// Actual camera exports with analytic projection/Rodrigues/scale oracles.
// No shipping fault hooks, scene data, JavaScript math or ImGui dependency.
#include "browser_transform_gizmo.hpp"
#include "browser_transform_math.hpp"
#include "processing.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <vector>
extern "C" {
int sv_camera_transform_compose(const float *,float *) noexcept;
int sv_camera_transform_gizmo_frame(const float *,float *) noexcept;
int sv_camera_transform_gizmo_begin(const float *,int,float *) noexcept;
int sv_camera_transform_gizmo_update(const float *,const float *,float *) noexcept;
}
namespace {
namespace tg=preview::browser_transform_gizmo;namespace tm=preview::browser_transform;
using tg::Input;using tg::State;using tg::Result;using tg::Frame;using tg::Pointer;
constexpr double pi=3.14159265358979323846;
struct V{double x{},y{},z{};};
V operator+(V a,V b){return {a.x+b.x,a.y+b.y,a.z+b.z};}V operator-(V a,V b){return {a.x-b.x,a.y-b.y,a.z-b.z};}V operator*(V a,double s){return {a.x*s,a.y*s,a.z*s};}
double dot(V a,V b){return a.x*b.x+a.y*b.y+a.z*b.z;}V cross(V a,V b){return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x};}
V unit(V a){return a*(1/std::sqrt(dot(a,a)));}V rotate(V p,V axis,double angle){return p*std::cos(angle)+cross(axis,p)*std::sin(angle)+axis*(dot(axis,p)*(1-std::cos(angle)));}
size_t cases{},checks{},handles{},frames{},updates{},refusals{},aliases{},compositions{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
void close(double a,double b,const char *message,double tolerance=5e-4){require(std::abs(a-b)<=tolerance*std::max({1.,std::abs(a),std::abs(b)}),message);}
void close(V a,V b,const char *message){close(a.x,b.x,message);close(a.y,b.y,message);close(a.z,b.z,message);}
V axis(int i){return {i==0?1.:0.,i==1?1.:0.,i==2?1.:0.};}
V pivot(const Input &in){return {in[42],in[43],in[44]};}
V basis(const Input &in,int i){return unit({in[45+i*4],in[46+i*4],in[47+i*4]});}
V cameraRight(const Input &in){return {in[0],in[4],in[8]};}V cameraUp(const Input &in){return {in[1],in[5],in[9]};}V cameraForward(const Input &in){return {in[2],in[6],in[10]};}
Input fixture(int operation=0,bool local=false,bool rotated=true,V center={}){
    Input in{};const V eye{4,3,6},z=unit(eye),x=unit(cross({0,1,0},z)),y=cross(z,x);
    in[0]=float(x.x);in[1]=float(y.x);in[2]=float(z.x);in[4]=float(x.y);in[5]=float(y.y);in[6]=float(z.y);
    in[8]=float(x.z);in[9]=float(y.z);in[10]=float(z.z);in[12]=float(-dot(x,eye));in[13]=float(-dot(y,eye));in[14]=float(-dot(z,eye));in[15]=1;
    in[16]=1;in[21]=1;in[27]=-1;in[30]=.1f;in[34]=400;in[35]=400;in[36]=1;in[37]=float(operation);in[38]=local?1.f:0.f;
    in[40]=200;in[41]=200;in[42]=float(center.x);in[43]=float(center.y);in[44]=float(center.z);
    const V rotation{17,-23,31};const auto length=std::sqrt(dot(rotation,rotation));
    for(int i=0;i<3;++i){auto direction=rotated?rotate(axis(i),rotation*(1/length),length*pi/180):axis(i);const double scale[3]{1.2,.8,1.6};direction=direction*scale[i];
        in[45+i*4]=float(direction.x);in[46+i*4]=float(direction.y);in[47+i*4]=float(direction.z);}
    in[57]=float(center.x);in[58]=float(center.y);in[59]=float(center.z);in[60]=1;return in;
}
Pointer projected(const Input &in,V p,float ctrl=0){const auto depth=-(dot(cameraForward(in),p)+in[14]);
    return {float(in[32]+(1+(dot(cameraRight(in),p)+in[12])*in[16]/depth)*in[34]*.5),
        float(in[33]+(1-(dot(cameraUp(in),p)+in[13])*in[21]/depth)*in[35]*.5),ctrl};}
double extent(const Input &in){return .13*in[36]*(-(dot(cameraForward(in),pivot(in))+in[14]))/in[16];}
V handleAxis(const Input &in,int i){return in[38]!=0||in[37]==2?basis(in,i):axis(i);}
V press(const Input &in,int handle){const auto c=pivot(in);const auto e=extent(in);
    if(handle<=3)return c+handleAxis(in,handle-1)*(e*.82);
    if(handle<=6){const int i=handle-4;return c+(handleAxis(in,(i+1)%3)+handleAxis(in,(i+2)%3))*(e*.65);}
    if(handle==7||handle==15)return c;
    if(handle<=10){const int i=handle-8;return c+(handleAxis(in,(i+1)%3)*std::cos(.37)+handleAxis(in,(i+2)%3)*std::sin(.37))*e;}
    if(handle==11)return c+(cameraRight(in)*std::cos(.27)+cameraUp(in)*std::sin(.27))*(e*1.18);
    return c+handleAxis(in,handle-12)*e;
}
State begin(Input &in,int handle){const auto pointer=projected(in,press(in,handle));in[40]=pointer[0];in[41]=pointer[1];Frame frame;
    require(sv_camera_transform_gizmo_frame(in.data(),frame.data())==1,"General frame refused");++frames;
    char diagnostic[192];std::snprintf(diagnostic,sizeof(diagnostic),"General analytic hit mismatch requested=%d hit=%.0f op=%.0f local=%.0f pointer=(%.7g,%.7g)",handle,frame[1],in[37],in[38],in[40],in[41]);require(frame[1]==handle,diagnostic);
    require(frame[0]>0&&frame[0]<=512,"Frame primitive capacity invalid");
    for(size_t i=0;i<size_t(frame[0]);++i){const auto *row=frame.data()+4+i*12;require(row[0]>=1&&row[0]<=15&&row[1]>=0&&row[1]<=3&&row[2]>=0&&row[2]<=3,"General widget exposed filter volume/invalid primitive");}
    State state;state.fill(-91);require(sv_camera_transform_gizmo_begin(in.data(),handle,state.data())==1,"Drawn general handle refused begin");++handles;
    require(state[0]==104731&&state[1]==1&&state[2]==handle&&std::equal(in.begin(),in.end(),state.begin()+3),"General opaque press state mismatch");
    require(std::all_of(state.begin()+64,state.end(),[](float v){return v==0;}),"General state reserved bytes changed");return state;
}
Result update(const State &state,const Pointer &pointer){std::array<float,52> guarded;guarded.fill(-17.25f);const auto before=state;
    require(sv_camera_transform_gizmo_update(state.data(),pointer.data(),guarded.data()+2)==1,"General update refused");++updates;
    require(guarded[0]==-17.25f&&guarded[1]==-17.25f&&guarded[50]==-17.25f&&guarded[51]==-17.25f&&state==before,"General update changed guards/immutable state");
    Result result;std::copy_n(guarded.begin()+2,48,result.begin());
    for(int r=0;r<4;++r)for(int c=0;c<4;++c)require(result[32+r*4+c]==result[16+c*4+r],"Native row-major delta differs from GPU delta transpose");
    return result;
}
V applied(const Result &r,V p){return {p.x*r[16]+p.y*r[20]+p.z*r[24]+r[28],p.x*r[17]+p.y*r[21]+p.z*r[25]+r[29],p.x*r[18]+p.y*r[22]+p.z*r[26]+r[30]};}
void stationary(const Input &in,const Result &r){require(std::equal(in.begin()+45,in.end(),r.begin()),"Stationary pointer changed widget matrix");require(std::equal(preview::identityMatrix.begin(),preview::identityMatrix.end(),r.begin()+16),"Stationary pointer changed scene delta");}
void moveContracts(){++cases;for(bool local:{false,true})for(int handle=1;handle<=7;++handle){auto in=fixture(0,local);const auto state=begin(in,handle);V delta;
    if(handle<=3)delta=handleAxis(in,handle-1)*.17;else if(handle<=6){const auto i=handle-4;delta=handleAxis(in,(i+1)%3)*.17+handleAxis(in,(i+2)%3)*-.12;}else delta=cameraRight(in)*.17+cameraUp(in)*-.12;
    const auto result=update(state,projected(in,press(in,handle)+delta));close(applied(result,{1,2,3}),V{1,2,3}+delta,"General Move differs from analytic constraint");
    close(V{result[12],result[13],result[14]},pivot(in)+delta,"Widget Move translation incorrect");stationary(in,update(state,{in[40],in[41],0}));}}
void rotateContracts(){++cases;for(bool local:{false,true})for(int handle=8;handle<=11;++handle){auto in=fixture(1,local);const auto state=begin(in,handle);
    const auto normal=handle==11?cameraForward(in)*-1:handleAxis(in,handle-8),start=press(in,handle)-pivot(in);
    const auto result=update(state,projected(in,pivot(in)+rotate(start,normal,pi/3)));
    for(V point:{V{1,2,3},V{-2,1,-1},pivot(in)})close(applied(result,point),pivot(in)+rotate(point-pivot(in),normal,pi/3),"General Rotate differs from Rodrigues/pivot oracle");
    for(int i=0;i<3;++i)require(result[12+i]==in[42+i],"Rotate changed widget pivot");stationary(in,update(state,{in[40],in[41],0}));}}
void scaleContracts(){++cases;for(bool local:{false,true})for(int handle=12;handle<=15;++handle){auto in=fixture(2,local);const auto state=begin(in,handle);
    const auto pointer=handle==15?Pointer{in[40]+30,in[41],0}:projected(in,pivot(in)+(press(in,handle)-pivot(in))*1.3);const auto result=update(state,pointer);
    for(V point:{V{1,2,3},V{-2,1,-1},pivot(in)}){V expected=point;for(int i=0;i<3;++i)if(handle==15||i==handle-12)expected=expected+basis(in,i)*(dot(point-pivot(in),basis(in,i))*.3);
        close(applied(result,point),expected,"General Scale differs from always-local axis oracle");}
    for(int i=0;i<3;++i)require(result[12+i]==in[42+i],"Scale changed widget pivot");stationary(in,update(state,{in[40],in[41],0}));}
    auto in=fixture(2);const auto state=begin(in,15);const auto result=update(state,{in[40]-200,in[41],0});close(applied(result,{1,2,3}),V{.001,.002,.003},"Uniform clamp differs from .001 policy");}
void pivotAndReplay(){++cases;const V center{.7,-.4,.2};for(int op=0;op<3;++op){auto in=fixture(op,false,false,center);const int handle=op==0?7:op==1?11:15;const auto state=begin(in,handle);Pointer pointer;
    if(op==0)pointer=projected(in,press(in,handle)+cameraRight(in)*.164);
    else if(op==1)pointer=projected(in,center+rotate(press(in,handle)-center,cameraForward(in)*-1,22*pi/180));
    else pointer={in[40]+16.4f,in[41],0};
    const auto ordinary=update(state,pointer);auto ctrl=pointer;ctrl[2]=1;const auto snapped=update(state,ctrl);
    require(ordinary!=snapped,"Ctrl did not enable temporary snap");require(update(state,pointer)==ordinary,"Snap toggle accumulated from prior update");
    if(op==0)close(applied(snapped,center),center+V{.1,0,-.1},"Snapped Move screen local-component oracle differs");
    else if(op==1)close(applied(snapped,center+V{1,2,3}),center+rotate({1,2,3},cameraForward(in)*-1,15*pi/180),"Snapped Rotate pivot oracle differs");
    else close(applied(snapped,center+V{1,2,3}),center+V{1.2,2.4,3.6},"Snapped Scale pivot oracle differs");}}
tm::ComposeInput composeInput(const tm::Parameters &p){tm::ComposeInput in{};in[0]=float(unsigned(p.mode));std::copy(p.translation.begin(),p.translation.end(),in.begin()+1);std::copy(p.scale.begin(),p.scale.end(),in.begin()+4);
    std::copy(p.pivot.begin(),p.pivot.end(),in.begin()+7);std::copy(p.euler.begin(),p.euler.end(),in.begin()+10);std::copy(p.quaternion.begin(),p.quaternion.end(),in.begin()+13);
    std::copy(p.axis.begin(),p.axis.end(),in.begin()+17);in[20]=p.angle;std::copy(p.matrix.begin(),p.matrix.end(),in.begin()+21);for(int i=0;i<3;++i)in[37+i]=p.flips[i]?1.f:0.f;return in;}
void composerContracts(){++cases;for(unsigned mode=0;mode<4;++mode){tm::Parameters p;p.mode=static_cast<tm::Mode>(mode);p.translation={2,3,4};p.scale={2,3,4};p.pivot={1,2,3};p.euler={0,0,90};p.quaternion={1,0,0,1};p.axis={0,0,2};p.angle=90;
    p.matrix={0,-3,0,9,2,0,0,6,0,0,4,7,0,0,0,1};auto in=composeInput(p);preview::Matrix4 result;
    require(sv_camera_transform_compose(in.data(),result.data())==1,"Camera composer refused mode");++compositions;
    if(mode<3){close(result[0],0,"Composer Rz literal X failed");close(result[1],2,"Composer Rz scale basis failed");close(result[4],-3,"Composer nonuniform Y failed");close(result[12],9,"Composer pivot translationX failed");close(result[13],3,"Composer pivot translationY failed");close(result[14],-5,"Composer pivot translationZ failed");}
    else require(result==preview::transformMatrix(preview::Recipe{{"matrix",p.matrix}}),"Actual camera affine conversion differs from portable matrix kernel");
    std::array<float,40> alias=in;require(sv_camera_transform_compose(alias.data(),alias.data())==1&&std::equal(result.begin(),result.end(),alias.begin()),"Composer input/output alias failed");++aliases;
    in[0]=4;result.fill(-17);require(sv_camera_transform_compose(in.data(),result.data())==0&&std::all_of(result.begin(),result.end(),[](float v){return v==-17;}),"Composer refusal partially wrote output");++refusals;
    }
    tm::Parameters p;p.mode=tm::Mode::Matrix;p.matrix={0,0,0,2,0,-1,.2f,3,0,0,0,4,0,0,0,1};auto in=composeInput(p);preview::Matrix4 result;require(sv_camera_transform_compose(in.data(),result.data())==1,"Singular affine camera composition refused");
}
void refusalContracts(){++cases;auto in=fixture();auto state=begin(in,7);Result output;output.fill(-19);Frame frame;frame.fill(-19);
    auto bad=in;bad[45]=0;bad[46]=0;bad[47]=0;require(sv_camera_transform_gizmo_frame(bad.data(),frame.data())==0&&std::all_of(frame.begin(),frame.end(),[](float v){return v==-19;}),"Singular widget frame refusal wrote output");++refusals;
    bad=in;bad[48]=.1f;require(sv_camera_transform_gizmo_frame(bad.data(),frame.data())==0,"Perspective widget frame accepted");++refusals;
    for(int slot:{0,1,2,64,127}){auto invalid=state;invalid[slot]=slot<2?-1:slot==2?15:1;
        require(sv_camera_transform_gizmo_update(invalid.data(),Pointer{in[40],in[41],0}.data(),output.data())==0&&std::all_of(output.begin(),output.end(),[](float v){return v==-19;}),"Corrupt state/operation refusal wrote output");++refusals;}
    require(sv_camera_transform_gizmo_update(state.data(),Pointer{std::numeric_limits<float>::quiet_NaN(),0,0}.data(),output.data())==0,"Nonfinite pointer accepted");++refusals;
    State unused;unused.fill(-19);require(sv_camera_transform_gizmo_begin(in.data(),1,unused.data())==0&&std::all_of(unused.begin(),unused.end(),[](float v){return v==-19;}),"Begin accepted a handle that current pointer did not hit");++refusals;
    require(sv_camera_transform_gizmo_frame(nullptr,frame.data())==0&&sv_camera_transform_gizmo_begin(nullptr,7,unused.data())==0&&sv_camera_transform_gizmo_update(nullptr,nullptr,output.data())==0,"Null input ABI guard failed");refusals+=3;
}
void aliasContracts(){++cases;auto in=fixture();const auto state=begin(in,7);Frame expected;require(sv_camera_transform_gizmo_frame(in.data(),expected.data())==1,"Alias frame oracle failed");
    std::vector<float> shared(expected.size());std::copy(in.begin(),in.end(),shared.begin());require(sv_camera_transform_gizmo_frame(shared.data(),shared.data())==1&&std::equal(expected.begin(),expected.end(),shared.begin()),"Frame alias failed");++aliases;
    std::array<float,128> beginAlias{};std::copy(in.begin(),in.end(),beginAlias.begin());require(sv_camera_transform_gizmo_begin(beginAlias.data(),7,beginAlias.data())==1&&beginAlias==state,"Begin alias failed");++aliases;
    const auto pointer=projected(in,press(in,7)+cameraRight(in)*.2);const auto result=update(state,pointer);auto updateAlias=state;
    require(sv_camera_transform_gizmo_update(updateAlias.data(),pointer.data(),updateAlias.data())==1&&std::equal(result.begin(),result.end(),updateAlias.begin()),"Update state/result alias failed");++aliases;
}
}
int main(){try{moveContracts();rotateContracts();scaleContracts();pivotAndReplay();composerContracts();refusalContracts();aliasContracts();
    std::printf("SPLATVIEW_TRANSFORM_GIZMO_CONTRACTS_PASS cases=%zu checks=%zu handles=%zu frames=%zu updates=%zu compositions=%zu refusals=%zu aliases=%zu inputBytes=%zu stateBytes=%zu frameBytes=%zu resultBytes=%zu\n",cases,checks,handles,frames,updates,compositions,refusals,aliases,sizeof(Input),sizeof(State),sizeof(Frame),sizeof(Result));return 0;}
    catch(const std::exception &error){std::fprintf(stderr,"Transform gizmo contracts failed checks=%zu handles=%zu: %s\n",checks,handles,error.what());return 1;}}
