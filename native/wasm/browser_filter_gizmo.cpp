// Selected arithmetic and interaction semantics adapted from captured
// ImGuizmo revision 18cef5e031d8c6973d80284c67f60549fafd78c1:
// reference/targets/windows-r0-20261012-02/source/third_party/ImGuizmo/ImGuizmo.cpp
// ComputeCameraRay, ComputeSnap, HandleTranslation/Rotation/Scale. Desktop
// volume conversion/constraints: captured src/viewport_tools.cpp:472-557,812-891.
// This is a fixed-storage mathematical adapter; it does not include ImGui.
//
// The MIT License (MIT)
// Copyright (c) 2016 Cedric Guillemet
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
#include "browser_filter_gizmo.hpp"
#include "browser_transform_gizmo.hpp"
#include <algorithm>
#include <cmath>
#include <limits>

namespace preview::browser_filter_gizmo {
namespace {
constexpr double pi=3.14159265358979323846,limit=1e12,epsilon=1e-10;
struct V { double x{},y{},z{}; };
struct H { double x{},y{},z{},w{}; };
struct P { double x{},y{}; };
using M=std::array<double,16>;
struct Q { double x{},y{},z{},w{1}; };
V operator+(V a,V b) { return {a.x+b.x,a.y+b.y,a.z+b.z}; }
V operator-(V a,V b) { return {a.x-b.x,a.y-b.y,a.z-b.z}; }
V operator*(V a,double s) { return {a.x*s,a.y*s,a.z*s}; }
double dot(V a,V b) { return a.x*b.x+a.y*b.y+a.z*b.z; }
V cross(V a,V b) { return {a.y*b.z-a.z*b.y,a.z*b.x-a.x*b.z,a.x*b.y-a.y*b.x}; }
double length(V a) { return std::sqrt(dot(a,a)); }
bool unit(V a,V &out) { const auto n=length(a);if(!std::isfinite(n)||n<epsilon)return false;out=a*(1/n);return true; }
bool finite(V a) { return std::isfinite(a.x)&&std::isfinite(a.y)&&std::isfinite(a.z); }
V vector(const float *a) { return {a[0],a[1],a[2]}; }
H transform(H p,const M &m) {
    return {p.x*m[0]+p.y*m[4]+p.z*m[8]+p.w*m[12],p.x*m[1]+p.y*m[5]+p.z*m[9]+p.w*m[13],
        p.x*m[2]+p.y*m[6]+p.z*m[10]+p.w*m[14],p.x*m[3]+p.y*m[7]+p.z*m[11]+p.w*m[15]};
}
M multiply(const M &a,const M &b) {
    M out{};for(int r=0;r<4;++r)for(int c=0;c<4;++c)for(int k=0;k<4;++k)out[r*4+c]+=a[r*4+k]*b[k*4+c];return out;
}
bool inverse(const M &a,M &out) {
    double rows[4][8]{};
    for(int r=0;r<4;++r) { for(int c=0;c<4;++c)rows[r][c]=a[r*4+c];rows[r][r+4]=1; }
    for(int c=0;c<4;++c) {
        int pivot=c;for(int r=c+1;r<4;++r)if(std::abs(rows[r][c])>std::abs(rows[pivot][c]))pivot=r;
        if(!std::isfinite(rows[pivot][c])||std::abs(rows[pivot][c])<1e-20)return false;
        if(pivot!=c)for(int k=0;k<8;++k)std::swap(rows[pivot][k],rows[c][k]);
        const auto divisor=rows[c][c];for(int k=0;k<8;++k)rows[c][k]/=divisor;
        for(int r=0;r<4;++r)if(r!=c) { const auto factor=rows[r][c];for(int k=0;k<8;++k)rows[r][k]-=rows[c][k]*factor; }
    }
    for(int r=0;r<4;++r)for(int c=0;c<4;++c) { const auto value=rows[r][c+4];if(!std::isfinite(value)||std::abs(value)>1e24)return false;out[r*4+c]=value; }
    return true;
}
Q quaternion(V rotation) {
    const auto angle=length(rotation)*pi/180;
    if(angle<epsilon)return {};
    const auto scale=std::sin(angle*.5)/length(rotation);return {rotation.x*scale,rotation.y*scale,rotation.z*scale,std::cos(angle*.5)};
}
Q product(Q a,Q b) {
    return {a.w*b.x+a.x*b.w+a.y*b.z-a.z*b.y,a.w*b.y-a.x*b.z+a.y*b.w+a.z*b.x,
        a.w*b.z+a.x*b.y-a.y*b.x+a.z*b.w,a.w*b.w-a.x*b.x-a.y*b.y-a.z*b.z};
}
V rotate(V v,Q q) { const V axis{q.x,q.y,q.z};return v+cross(axis,v)*(2*q.w)+cross(axis,cross(axis,v))*2; }
bool rotationVector(Q q,V &out) {
    const auto n=std::sqrt(q.x*q.x+q.y*q.y+q.z*q.z+q.w*q.w);if(!std::isfinite(n)||n<epsilon)return false;
    q={q.x/n,q.y/n,q.z/n,q.w/n};const auto sine=std::hypot(q.x,q.y,q.z);
    if(sine<epsilon) { out={};return true; }
    auto angle=2*std::atan2(sine,q.w);if(angle>pi)angle-=2*pi;
    out=V{q.x,q.y,q.z}*(angle*180/pi/sine);return finite(out);
}
// Signed fmod and strict tension comparisons retain the captured half-step
// ties: exactly +/-half a step is left unchanged, rather than rounded away.
double snap(double value,double step) {
    const float scalar=float(value),increment=float(step);
    const float modulo=std::fmod(scalar,increment),ratio=std::abs(modulo)/increment;
    if(ratio<.5f)return scalar-modulo;
    if(ratio>.5f)return scalar-modulo+increment*(scalar<0?-1.f:1.f);
    return scalar;
}
struct Context {
    Input input;
    M view{},projection{},vp{},ivp{},iview{};
    Pose pose;
    V center{},eye{},right{},up{},forward{},axes[3]{},localAxes[3]{};
    Q rotation;
    P centerPixel{};
    double worldLength{},pixelLength{},scale{};
    int shape{},operation{};
    bool local{},snapping{},outline{},visible{};
};
bool integer(float value,int low,int high) { return std::isfinite(value)&&value>=low&&value<=high&&value==std::floor(value); }
bool validPose(const Pose &p,int shape) {
    if(std::any_of(p.begin(),p.end(),[](float v){return !std::isfinite(v)||std::abs(double(v))>limit;}))return false;
    if(shape==1&&p[9]<0)return false;
    if(shape==2||shape==3)for(int i=3;i<6;++i) {
        if(shape==2?p[i]<0:p[i]<=0)return false;
        if(shape==2&&(std::abs(double(p[i-3]-p[i]*.5f))>limit||std::abs(double(p[i-3]+p[i]*.5f))>limit))return false;
    }
    if(shape==4) { const auto fov=p[10]*pi/180;if(fov<.001||fov>pi-.001||p[11]<.001||p[11]>1000||p[12]<0||p[13]<.0001||p[13]<=p[12])return false; }
    return true;
}
H clip(V p,const Context &c) { return transform({p.x,p.y,p.z,1},c.vp); }
P pixel(H h,const Context &c) { return {c.input[32]+(h.x/h.w+1)*.5*c.input[34],c.input[33]+(1-h.y/h.w)*.5*c.input[35]}; }
bool projected(V p,const Context &c,P &out) {
    const auto h=clip(p,c);if(h.w<=epsilon||h.z<0||h.z>h.w)return false;out=pixel(h,c);return std::isfinite(out.x)&&std::isfinite(out.y)&&std::abs(out.x)<=1e9&&std::abs(out.y)<=1e9;
}
bool context(const Input &in,Context &c) {
    if(std::any_of(in.begin(),in.end(),[](float v){return !std::isfinite(v)||std::abs(double(v))>limit;}))return false;
    if(in[34]<1||in[35]<1||in[34]>1e6||in[35]>1e6||in[36]<.1||in[36]>10||
       !integer(in[37],1,4)||!integer(in[38],0,2)||!integer(in[39],0,1)||!integer(in[40],0,1)||!integer(in[41],0,1)||
       (in[37]==4&&in[38]==2))return false;
    c.input=in;c.shape=int(in[37]);c.operation=int(in[38]);c.scale=in[36];c.local=in[39]!=0;c.snapping=in[40]!=0;c.outline=in[41]!=0;
    std::copy_n(in.begin()+44,poseFloats,c.pose.begin());if(!validPose(c.pose,c.shape))return false;
    for(int i=0;i<16;++i) { c.view[i]=in[i];c.projection[i]=in[16+i]; }
    if(std::abs(c.view[3])>1e-6||std::abs(c.view[7])>1e-6||std::abs(c.view[11])>1e-6||std::abs(c.view[15]-1)>1e-6)return false;
    c.vp=multiply(c.view,c.projection);if(!inverse(c.vp,c.ivp)||!inverse(c.view,c.iview))return false;
    c.eye={c.iview[12],c.iview[13],c.iview[14]};
    if(!unit({c.iview[0],c.iview[1],c.iview[2]},c.right)||!unit({c.iview[4],c.iview[5],c.iview[6]},c.up)||
       !unit({c.iview[8],c.iview[9],c.iview[10]},c.forward))return false;
    if(std::abs(dot(c.right,c.up))>1e-3||std::abs(dot(c.right,c.forward))>1e-3||std::abs(dot(c.up,c.forward))>1e-3||dot(cross(c.right,c.up),c.forward)<.999)return false;
    c.center=vector(c.pose.data());c.rotation=quaternion(vector(c.pose.data()+6));
    for(int i=0;i<3;++i) { const V axis{i==0?1.:0.,i==1?1.:0.,i==2?1.:0.};c.localAxes[i]=rotate(axis,c.rotation);c.axes[i]=(c.local||c.operation==2)?c.localAxes[i]:axis; }
    c.visible=projected(c.center,c,c.centerPixel);
    if(c.visible) {
        // Desktop .13 clip-space gizmo size, scaled once in CSS space. Camera
        // right gives a stable world extent independent of object dimensions.
        const auto a=clip(c.center,c),b=clip(c.center+c.right,c);
        if(b.w<=epsilon)return false;
        const auto clipLength=std::hypot(b.x/b.w-a.x/a.w,b.y/b.w-a.y/a.w);
        if(!std::isfinite(clipLength)||clipLength<1e-15)return false;
        c.worldLength=.13*c.scale/clipLength;c.pixelLength=.065*c.input[34]*c.scale;
        if(!std::isfinite(c.worldLength)||c.worldLength<=0||c.worldLength>limit)return false;
    }
    return true;
}
struct Ray { V origin{},direction{}; };
bool ray(const Context &c,P p,Ray &out) {
    const auto x=(p.x-c.input[32])/c.input[34]*2-1,y=1-(p.y-c.input[33])/c.input[35]*2;
    const auto a=transform({x,y,0,1},c.ivp),b=transform({x,y,1-double(std::numeric_limits<float>::epsilon()),1},c.ivp);
    const bool ai=std::abs(a.w)<double(std::numeric_limits<float>::epsilon()),bi=std::abs(b.w)<double(std::numeric_limits<float>::epsilon());
    if(ai&&bi)return false;
    const V av{a.x,a.y,a.z},bv{b.x,b.y,b.z};
    const auto ap=ai?av:av*(1/a.w),bp=bi?bv:bv*(1/b.w);
    const bool aNear=!ai&&(bi||dot(ap-c.eye,ap-c.eye)<=dot(bp-c.eye,bp-c.eye));
    out.origin=aNear?ap:bp;const auto far=aNear?bp:ap;
    return finite(out.origin)&&unit((aNear?bi:ai)?out.origin-c.eye:far-out.origin,out.direction);
}
bool intersection(Ray ray,V center,V normal,V &point) {
    const auto divisor=dot(ray.direction,normal);if(std::abs(divisor)<1e-7)return false;
    const auto t=dot(center-ray.origin,normal)/divisor;if(!std::isfinite(t)||t<0||t>1e24)return false;
    point=ray.origin+ray.direction*t;return finite(point);
}
struct Constraint { V normal{},axis{},initial{},rotationStart{};double scaleBase{}; };
bool allowed(const Context &c,int handle) {
    return c.operation==0?(handle>=1&&handle<=7):c.operation==1?(handle>=8&&handle<=11):c.shape!=4&&(handle>=12&&handle<=15);
}
bool constraint(const Context &c,int handle,Constraint &out) {
    if(!c.visible||!allowed(c,handle))return false;
    Ray r;if(!ray(c,{c.input[42],c.input[43]},r))return false;
    if(handle<=3||(handle>=12&&handle<=14)) {
        out.axis=c.axes[(handle<=3?handle-1:handle-12)];V toward;
        if(!unit(c.center-c.eye,toward)||!unit(toward-out.axis*dot(toward,out.axis),out.normal))return false;
    } else if(handle>=4&&handle<=6)out.normal=c.axes[handle-4];
    else if(handle>=8&&handle<=10)out.normal=c.axes[handle-8];
    else out.normal=c.forward*-1;
    if(!intersection(r,c.center,out.normal,out.initial))return false;
    if(handle>=8&&handle<=11) { if(!unit(out.initial-c.center,out.rotationStart))return false;out.axis=out.normal; }
    if(handle>=12&&handle<=14) { out.scaleBase=dot(out.axis,out.initial-c.center);if(std::abs(out.scaleBase)<c.worldLength*.05)return false; }
    return true;
}
double distance(P a,P b) { return std::hypot(a.x-b.x,a.y-b.y); }
double segmentDistance(P p,P a,P b) {
    const auto dx=b.x-a.x,dy=b.y-a.y,denom=dx*dx+dy*dy;
    if(denom<epsilon)return distance(p,a);
    const auto t=std::clamp(((p.x-a.x)*dx+(p.y-a.y)*dy)/denom,0.,1.);return distance(p,{a.x+t*dx,a.y+t*dy});
}
bool quadContains(P p,const std::array<P,4> &a) {
    double sign=0,area=0;for(int i=0;i<4;++i) {
        const auto b=a[(i+1)%4];const auto v=(b.x-a[i].x)*(p.y-a[i].y)-(b.y-a[i].y)*(p.x-a[i].x);
        if(std::abs(v)>epsilon) { if(sign&&sign*v<0)return false;sign=v; }
        area+=a[i].x*b.y-a[i].y*b.x;
    }
    return std::abs(area)>16;
}
struct Drawing {
    Frame frame{};const Context &c;size_t count{};int hit{};double best{1e30};P pointer;
    explicit Drawing(const Context &context):c(context),pointer{c.input[42],c.input[43]} {}
    bool row(int handle,int role,Primitive type,const std::array<P,4> &p,double weight,double size=0) {
        if(count==maxPrimitives)return false;
        auto *out=frame.data()+4+count++*primitiveFloats;out[0]=float(handle);out[1]=float(role);out[2]=float(type);
        for(int i=0;i<4;++i) { out[3+i*2]=float(p[i].x);out[4+i*2]=float(p[i].y); }
        if(type==Primitive::Disc||type==Primitive::Square)out[5]=float(size);
        out[11]=float(weight);return true;
    }
    void hitCandidate(int handle,double score) {
        if(handle&&score<best) { Constraint test;if(constraint(c,handle,test)) { best=score;hit=handle; } }
    }
    bool line(V a,V b,int handle,int role,double width,bool hittable=true) {
        auto h0=clip(a,c),h1=clip(b,c);double lo=0,hi=1;
        // Homogeneous near/far/viewport clipping avoids giant coordinates or
        // mirrored behind-camera segments, including reversed infinite depth.
        const double av[]{h0.w-epsilon,h0.z,h0.w-h0.z,h0.x+h0.w,h0.w-h0.x,h0.y+h0.w,h0.w-h0.y};
        const double bv[]{h1.w-epsilon,h1.z,h1.w-h1.z,h1.x+h1.w,h1.w-h1.x,h1.y+h1.w,h1.w-h1.y};
        for(int i=0;i<7;++i) {
            if(av[i]<0&&bv[i]<0)return true;
            if((av[i]<0)!=(bv[i]<0)) { const auto t=av[i]/(av[i]-bv[i]);if(av[i]<0)lo=std::max(lo,t);else hi=std::min(hi,t); }
        }
        if(lo>hi)return true;
        const auto blend=[](H a,H b,double t){return H{a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t,a.w+(b.w-a.w)*t};};
        const auto p0=pixel(blend(h0,h1,lo),c),p1=pixel(blend(h0,h1,hi),c);
        if(!row(handle,role,Primitive::Line,{p0,p1,{},{}},width))return false;
        if(hittable&&handle) { const auto d=segmentDistance(pointer,p0,p1);if(d<=7*c.scale)hitCandidate(handle,d+10*c.scale); }
        return true;
    }
    bool marker(P center,int handle,int role,Primitive type,double radius) {
        if(!row(handle,role,type,{center,{},{},{}},1.5*c.scale,radius))return false;
        const auto dx=std::abs(pointer.x-center.x),dy=std::abs(pointer.y-center.y);
        if(type==Primitive::Disc?std::hypot(dx,dy)<=radius+3*c.scale:std::max(dx,dy)<=radius+3*c.scale)hitCandidate(handle,0);
        return true;
    }
};
bool drawVolume(Drawing &d) {
    const auto &c=d.c;if(!c.outline)return true;
    auto localToWorld=[&](V v) { return c.center+rotate(v,c.rotation); };
    if(c.shape==2||c.shape==4) {
        std::array<V,8> corners{};
        for(int i=0;i<8;++i) {
            V v{(i&1)?.5:-.5,(i&2)?.5:-.5,(i&4)?.5:-.5};
            if(c.shape==2)v={v.x*std::max(1e-6f,c.pose[3]),v.y*std::max(1e-6f,c.pose[4]),v.z*std::max(1e-6f,c.pose[5])};
            else { const auto depth=c.pose[(i&4)?13:12];const auto height=depth*std::tan(c.pose[10]*pi/360);v={v.x*2*height*c.pose[11],v.y*2*height,-depth}; }
            corners[i]=localToWorld(v);
        }
        for(int i=0;i<8;++i)for(int axis:{1,2,4})if(!(i&axis)&&!d.line(corners[i],corners[i|axis],0,4,1.5*c.scale,false))return false;
    } else for(int axis=0;axis<3;++axis)for(int i=0;i<64;++i) {
        auto at=[&](int step) { const auto a=step*2*pi/64;V v=axis==0?V{0,std::cos(a),std::sin(a)}:axis==1?V{std::cos(a),0,std::sin(a)}:V{std::cos(a),std::sin(a),0};
            if(c.shape==1)v=v*std::max(1e-6f,c.pose[9]);else v={v.x*c.pose[3],v.y*c.pose[4],v.z*c.pose[5]};return localToWorld(v); };
        if(!d.line(at(i),at(i+1),0,4,1.2*c.scale,false))return false;
    }
    return true;
}
bool drawHandles(Drawing &d) {
    const auto &c=d.c;if(!c.visible)return true;
    if(c.operation==0||c.operation==2) {
        for(int i=0;i<3;++i) {
            const auto handle=(c.operation==0?1:12)+i;P start,end;
            if(!projected(c.center+c.axes[i]*(c.worldLength*.1),c,start)||!projected(c.center+c.axes[i]*c.worldLength,c,end)||distance(start,end)<10*c.scale)continue;
            if(!d.line(c.center+c.axes[i]*(c.worldLength*.1),c.center+c.axes[i]*c.worldLength,handle,i,3*c.scale))return false;
            if(c.operation==2) { if(!d.marker(end,handle,i,Primitive::Square,5*c.scale))return false; }
            else {
                // Two arrow wings are drawn and hit as the axis's same handle.
                const auto dx=end.x-start.x,dy=end.y-start.y,n=distance(start,end),wing=6*c.scale;
                const P back{end.x-dx/n*wing*1.6,end.y-dy/n*wing*1.6};
                for(int sign:{-1,1})if(!d.row(handle,i,Primitive::Line,{end,{back.x-sign*dy/n*wing,back.y+sign*dx/n*wing},{},{}},3*c.scale))return false;
            }
        }
        if(c.operation==0)for(int normal=0;normal<3;++normal) {
            const auto a=c.axes[(normal+1)%3],b=c.axes[(normal+2)%3];std::array<P,4> points;
            // Captured ImGuizmo quadMin=.5 / quadMax=.8 keeps plane handles
            // outside the screen handle's hotspot instead of burying them.
            const double xy[4][2]{{.5,.5},{.8,.5},{.8,.8},{.5,.8}};bool visible=true;
            for(int i=0;i<4;++i)visible&=projected(c.center+(a*xy[i][0]+b*xy[i][1])*c.worldLength,c,points[i]);
            if(!visible||!quadContains({(points[0].x+points[2].x)*.5,(points[0].y+points[2].y)*.5},points))continue;
            if(!d.row(4+normal,normal,Primitive::Quad,points,1*c.scale))return false;
            if(quadContains(d.pointer,points))d.hitCandidate(4+normal,5*c.scale);
        }
        return d.marker(c.centerPixel,c.operation==0?7:15,3,c.operation==0?Primitive::Disc:Primitive::Square,6*c.scale);
    }
    for(int axis=0;axis<4;++axis) {
        V u{},v{};const auto handle=8+axis;
        if(axis<3) { u=c.axes[(axis+1)%3];v=c.axes[(axis+2)%3]; }
        else { u=c.right;v=c.up; }
        const auto radius=c.worldLength*(axis==3?1.18:1);
        // Rings edge-on to the camera cannot define a stable rotation plane.
        const auto normal=axis<3?c.axes[axis]:c.forward;V toward;
        if(!unit(c.center-c.eye,toward)||std::abs(dot(normal,toward))<.035)continue;
        for(int i=0;i<64;++i) {
            auto at=[&](int step) { const auto angle=step*2*pi/64;return c.center+(u*std::cos(angle)+v*std::sin(angle))*radius; };
            if(!d.line(at(i),at(i+1),handle,axis,axis==3?3*c.scale:2*c.scale))return false;
        }
    }
    return true;
}
bool render(const Context &c,Frame &out) {
    Drawing drawing(c);if(!drawVolume(drawing)||!drawHandles(drawing))return false;
    drawing.frame[0]=float(drawing.count);drawing.frame[1]=float(drawing.hit);
    if(c.visible) { drawing.frame[2]=float(c.centerPixel.x);drawing.frame[3]=float(c.centerPixel.y); }
    if(std::any_of(drawing.frame.begin(),drawing.frame.end(),[](float v){return !std::isfinite(v);}))return false;
    out=drawing.frame;return true;
}
bool start(const Input &in,int handle,Context &c,Constraint &s) {
    if(!context(in,c)||!allowed(c,handle)||!constraint(c,handle,s))return false;
    Frame drawn;if(!render(c,drawn)||int(drawn[1])!=handle)return false;return true;
}
bool poseResult(const Context &c,const Constraint &s,int handle,const Pointer &pointer,Pose &out,M *matrixDelta=nullptr) {
    if(std::any_of(pointer.begin(),pointer.end(),[](float v){return !std::isfinite(v)||std::abs(double(v))>limit;})||!integer(pointer[2],0,1))return false;
    Ray r;V current;if(!ray(c,{pointer[0],pointer[1]},r)||!intersection(r,c.center,s.normal,current))return false;
    Pose result=c.pose;const bool snapping=c.snapping||pointer[2]!=0;bool changed=false;Q composed=c.rotation;
    M deltaMatrix{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    if(handle<=7) {
        auto delta=current-s.initial;if(handle<=3)delta=s.axis*dot(s.axis,delta);
        if(snapping) {
            if(c.local||handle==7) { V local{dot(delta,c.localAxes[0]),dot(delta,c.localAxes[1]),dot(delta,c.localAxes[2])};
                local={snap(local.x,.1),snap(local.y,.1),snap(local.z,.1)};delta=c.localAxes[0]*local.x+c.localAxes[1]*local.y+c.localAxes[2]*local.z;
            } else delta={snap(delta.x,.1),snap(delta.y,.1),snap(delta.z,.1)};
        }
        const auto center=c.center+delta;result[0]=float(center.x);result[1]=float(center.y);result[2]=float(center.z);
        changed=result[0]!=c.pose[0]||result[1]!=c.pose[1]||result[2]!=c.pose[2];
        if(matrixDelta&&changed) {deltaMatrix[12]=result[0]-c.pose[0];deltaMatrix[13]=result[1]-c.pose[1];deltaMatrix[14]=result[2]-c.pose[2];}
    } else if(handle<=11) {
        V target;if(!unit(current-c.center,target))return false;
        auto angle=std::atan2(dot(s.axis,cross(s.rotationStart,target)),dot(s.rotationStart,target));
        if(snapping)angle=snap(angle,15*pi/180);
        if(std::abs(angle)>epsilon) {
            const auto half=angle*.5;const Q change{s.axis.x*std::sin(half),s.axis.y*std::sin(half),s.axis.z*std::sin(half),std::cos(half)};
            composed=product(change,c.rotation);changed=true;
            if(matrixDelta)for(int axis=0;axis<3;++axis) {
                const auto basis=rotate({axis==0?1.:0.,axis==1?1.:0.,axis==2?1.:0.},change);
                deltaMatrix[axis*4]=basis.x;deltaMatrix[axis*4+1]=basis.y;deltaMatrix[axis*4+2]=basis.z;
            }
        }
    } else {
        std::array<double,3> factors{1,1,1};
        if(handle==15)factors.fill(std::max(.001,1+(pointer[0]-c.input[42])*.01));
        else factors[handle-12]=std::max(.001,dot(s.axis,current-c.center)/s.scaleBase);
        if(snapping)for(auto &factor:factors)factor=std::max(.001,snap(factor,.1));
        changed=std::any_of(factors.begin(),factors.end(),[](double factor){return std::abs(factor-1)>epsilon;});
        if(!changed) { out=c.pose;if(matrixDelta)*matrixDelta=deltaMatrix;return true; }
        if(matrixDelta)for(int r=0;r<3;++r)for(int col=0;col<3;++col) {
            const double rows[3][3]{{c.localAxes[0].x,c.localAxes[0].y,c.localAxes[0].z},
                {c.localAxes[1].x,c.localAxes[1].y,c.localAxes[1].z},{c.localAxes[2].x,c.localAxes[2].y,c.localAxes[2].z}};
            deltaMatrix[r*4+col]=(r==col?1.:0.);for(int axis=0;axis<3;++axis)deltaMatrix[r*4+col]+=rows[axis][r]*rows[axis][col]*(factors[axis]-1);
        }
        std::array<double,3> sizes{};for(int i=0;i<3;++i)sizes[i]=std::max(1e-6f,c.shape==1?c.pose[9]:c.pose[3+i])*factors[i];
        if(c.shape==1) {
            int chosen=0;for(int i=1;i<3;++i)if(std::abs(sizes[i]-c.pose[9])>std::abs(sizes[chosen]-c.pose[9]))chosen=i;
            result[9]=float(std::max(1e-6,sizes[chosen]));
        } else for(int i=0;i<3;++i)result[3+i]=float(std::max(1e-6,sizes[i]));
    }
    // Captured updateVolume decomposes the complete manipulated matrix for
    // every actual change. The matrix always clamps active dimensions, even
    // when the changed handle was Move or Rotate. Inactive parameter fields
    // retain their original values. A stationary pointer leaves exact input.
    if(!changed) { out=c.pose;if(matrixDelta)*matrixDelta=deltaMatrix;return true; }
    if(c.shape==1)result[9]=std::max(1e-6f,result[9]);
    else if(c.shape!=4)for(int i=3;i<6;++i)result[i]=std::max(1e-6f,result[i]);
    V rotation;if(!rotationVector(composed,rotation))return false;
    result[6]=float(rotation.x);result[7]=float(rotation.y);result[8]=float(rotation.z);
    if(!validPose(result,c.shape))return false;
    if(matrixDelta&&handle>=8) {
        const double center[3]{c.center.x,c.center.y,c.center.z};
        for(int col=0;col<3;++col) {deltaMatrix[12+col]=center[col];for(int r=0;r<3;++r)deltaMatrix[12+col]-=center[r]*deltaMatrix[r*4+col];}
    }
    out=result;if(matrixDelta)*matrixDelta=deltaMatrix;return true;
}

// General transform widgets use the same rays, clipping, hit tests, constraints
// and snapping. Their frame is independent of the scene's possibly singular
// numeric transform. No inversion/decomposition of scene data occurs here.
bool transformContext(const browser_transform_gizmo::Input &input,Input &converted,Context &contextOut) {
    if(std::any_of(input.begin(),input.end(),[](float v){return !std::isfinite(v)||std::abs(double(v))>limit;}))return false;
    const float *matrix=input.data()+45;
    if(matrix[3]!=0||matrix[7]!=0||matrix[11]!=0||matrix[15]!=1)return false;
    V axes[3];double scales[3];
    for(int axis=0;axis<3;++axis) {
        const V raw=vector(matrix+axis*4);scales[axis]=length(raw);
        if(scales[axis]<1e-6||!unit(raw,axes[axis])||matrix[12+axis]!=input[42+axis])return false;
    }
    if(std::abs(dot(axes[0],axes[1]))>1e-5||std::abs(dot(axes[0],axes[2]))>1e-5||std::abs(dot(axes[1],axes[2]))>1e-5||dot(cross(axes[0],axes[1]),axes[2])<.99999)return false;
    const double a[3][3]{{axes[0].x,axes[1].x,axes[2].x},{axes[0].y,axes[1].y,axes[2].y},{axes[0].z,axes[1].z,axes[2].z}};
    Q q;const auto trace=a[0][0]+a[1][1]+a[2][2];
    if(trace>0) {const auto s=std::sqrt(trace+1)*2;q={(a[2][1]-a[1][2])/s,(a[0][2]-a[2][0])/s,(a[1][0]-a[0][1])/s,s*.25};}
    else {
        int axis=0;for(int i=1;i<3;++i)if(a[i][i]>a[axis][axis])axis=i;
        const int j=(axis+1)%3,k=(axis+2)%3;const auto s=std::sqrt(1+a[axis][axis]-a[j][j]-a[k][k])*2;
        double values[4]{};values[axis]=s*.25;values[j]=(a[j][axis]+a[axis][j])/s;values[k]=(a[k][axis]+a[axis][k])/s;values[3]=(a[k][j]-a[j][k])/s;q={values[0],values[1],values[2],values[3]};
    }
    V rotation;if(!rotationVector(q,rotation))return false;
    converted={};std::copy_n(input.begin(),37,converted.begin());converted[37]=2;converted[38]=input[37];converted[39]=input[38];
    converted[40]=input[39];converted[41]=0;converted[42]=input[40];converted[43]=input[41];
    for(int i=0;i<3;++i) {converted[44+i]=input[42+i];converted[47+i]=float(scales[i]);}
    converted[50]=float(rotation.x);converted[51]=float(rotation.y);converted[52]=float(rotation.z);
    converted[53]=1;converted[54]=60;converted[55]=1;converted[56]=.1f;converted[57]=100;
    return context(converted,contextOut);
}
} // namespace
bool frame(const Input &input,Frame &output) noexcept { Context c;if(!context(input,c))return false;return render(c,output); }
bool begin(const Input &input,int handle,State &output) noexcept {
    Context c;Constraint constraint;if(!start(input,handle,c,constraint))return false;
    State staged{};staged[0]=104729;staged[1]=1;staged[2]=float(handle);std::copy(input.begin(),input.end(),staged.begin()+3);output=staged;return true;
}
bool update(const State &state,const Pointer &pointer,Pose &output) noexcept {
    if(state[0]!=104729||state[1]!=1||!integer(state[2],1,15)||std::any_of(state.begin()+61,state.end(),[](float v){return v!=0;}))return false;
    Input input;std::copy_n(state.begin()+3,inputFloats,input.begin());Context c;Constraint constraint;
    if(!start(input,int(state[2]),c,constraint))return false;Pose staged;if(!poseResult(c,constraint,int(state[2]),pointer,staged))return false;output=staged;return true;
}
} // namespace preview::browser_filter_gizmo

namespace preview::browser_transform_gizmo {
bool frame(const Input &input,Frame &output) noexcept {
    browser_filter_gizmo::Input converted;browser_filter_gizmo::Context context;
    if(!browser_filter_gizmo::transformContext(input,converted,context))return false;
    return browser_filter_gizmo::render(context,output);
}
bool begin(const Input &input,int handle,State &output) noexcept {
    browser_filter_gizmo::Input converted;browser_filter_gizmo::Context context;
    browser_filter_gizmo::Constraint constraint;
    if(!browser_filter_gizmo::transformContext(input,converted,context)||!browser_filter_gizmo::start(converted,handle,context,constraint))return false;
    State staged{};staged[0]=104731;staged[1]=1;staged[2]=float(handle);std::copy(input.begin(),input.end(),staged.begin()+3);output=staged;return true;
}
bool update(const State &state,const Pointer &pointer,Result &output) noexcept {
    if(state[0]!=104731||state[1]!=1||!browser_filter_gizmo::integer(state[2],1,15)||
       std::any_of(state.begin()+64,state.end(),[](float value){return value!=0;}))return false;
    Input input;std::copy_n(state.begin()+3,inputFloats,input.begin());
    browser_filter_gizmo::Input converted;browser_filter_gizmo::Context context;browser_filter_gizmo::Constraint constraint;
    if(!browser_filter_gizmo::transformContext(input,converted,context)||!browser_filter_gizmo::start(converted,int(state[2]),context,constraint))return false;
    browser_filter_gizmo::Pose pose;browser_filter_gizmo::M delta;
    if(!browser_filter_gizmo::poseResult(context,constraint,int(state[2]),pointer,pose,&delta))return false;
    browser_filter_gizmo::M widget;for(unsigned i=0;i<16;++i)widget[i]=input[45+i];
    auto updated=browser_filter_gizmo::multiply(widget,delta);
    bool neutral=true;for(unsigned i=0;i<16;++i)neutral=neutral&&(delta[i]==(i%5==0?1.:0.));
    if(neutral)updated=widget;
    if(state[2]>=8)for(unsigned i=0;i<3;++i)updated[12+i]=input[42+i];
    Result staged;
    for(unsigned r=0;r<4;++r)for(unsigned c=0;c<4;++c) {
        staged[r*4+c]=float(updated[r*4+c]);staged[16+r*4+c]=float(delta[r*4+c]);staged[32+r*4+c]=float(delta[c*4+r]);
    }
    if(std::any_of(staged.begin(),staged.end(),[](float value){return !std::isfinite(value);}))return false;
    output=staged;return true;
}
} // namespace preview::browser_transform_gizmo
