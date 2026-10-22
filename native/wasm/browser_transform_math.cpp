// Fixed-value adaptation of the pinned portable processing_kernels.cpp:200-300
// and captured ProcessingUi::transformValues/transformRecipe (processing_ui.cpp
// :43-82). Float quaternion factories, normalization and pivot arithmetic retain
// the portable kernel's order. Contracts compare against its actual Recipe path.
#include "browser_transform_math.hpp"
#include <algorithm>
#include <cmath>

namespace preview::browser_transform {
namespace {
constexpr float pi=3.14159265358979323846f;
bool bounded(float value) noexcept { return std::isfinite(value)&&std::abs(value)<=1e12f; }
template<size_t N> bool bounded(const std::array<float,N> &values) noexcept {
    return std::all_of(values.begin(),values.end(),[](float value){return bounded(value);});
}
bool affine(const Parameters &p,processing_detail::Affine &out) noexcept {
    if(unsigned(p.mode)>unsigned(Mode::Matrix)||!bounded(p.pivot))return false;
    if(p.mode==Mode::Matrix) {
        if(!bounded(p.matrix)||p.matrix[12]!=0||p.matrix[13]!=0||p.matrix[14]!=0||p.matrix[15]!=1)return false;
        for(unsigned r=0;r<3;++r) { out.t[r]=p.matrix[r*4+3];for(unsigned c=0;c<3;++c)out.a[r][c]=p.matrix[r*4+c]; }
        return true;
    }
    if(!bounded(p.translation)||!bounded(p.scale)||std::any_of(p.scale.begin(),p.scale.end(),[](float s){return s<=0||s>1e6f;}))return false;
    auto q=p.quaternion;
    if(p.mode==Mode::Euler) {
        if(!bounded(p.euler))return false;
        const double x=p.euler[0]*pi/360,y=p.euler[1]*pi/360,z=p.euler[2]*pi/360;
        q={float(cos(x)*cos(y)*cos(z)+sin(x)*sin(y)*sin(z)),float(sin(x)*cos(y)*cos(z)-cos(x)*sin(y)*sin(z)),
           float(cos(x)*sin(y)*cos(z)+sin(x)*cos(y)*sin(z)),float(cos(x)*cos(y)*sin(z)-sin(x)*sin(y)*cos(z))};
    } else if(p.mode==Mode::AxisAngle) {
        if(!bounded(p.axis)||!bounded(p.angle))return false;
        const float norm=std::hypot(p.axis[0],p.axis[1],p.axis[2]);std::array<float,3> aa{};
        if(norm>1e-8f)for(unsigned i=0;i<3;++i)aa[i]=p.axis[i]/norm*p.angle*pi/180;
        const double angle=std::hypot(aa[0],aa[1],aa[2]),s=angle>1e-12?sin(angle/2)/angle:.5;
        q={float(cos(angle/2)),float(aa[0]*s),float(aa[1]*s),float(aa[2]*s)};
    } else if(!bounded(q))return false;
    const double norm=std::sqrt(double(q[0])*q[0]+double(q[1])*q[1]+double(q[2])*q[2]+double(q[3])*q[3]);
    if(!std::isfinite(norm)||norm==0)return false;
    const double w=q[0]/norm,x=q[1]/norm,y=q[2]/norm,z=q[3]/norm;
    const double rotation[3][3]{{1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)},
        {2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)},{2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)}};
    for(unsigned r=0;r<3;++r) {
        out.t[r]=p.translation[r]+p.pivot[r];
        for(unsigned c=0;c<3;++c) { out.a[r][c]=rotation[r][c]*p.scale[c];out.t[r]-=out.a[r][c]*p.pivot[c]; }
    }
    return true;
}
processing_detail::Affine after(const processing_detail::Affine &a,const processing_detail::Affine &b) noexcept {
    processing_detail::Affine out;
    for(unsigned r=0;r<3;++r) {
        out.t[r]=b.t[r];for(unsigned k=0;k<3;++k)out.t[r]+=b.a[r][k]*a.t[k];
        for(unsigned c=0;c<3;++c) { out.a[r][c]=0;for(unsigned k=0;k<3;++k)out.a[r][c]+=b.a[r][k]*a.a[k][c]; }
    }
    return out;
}
}
bool plan(const Parameters &parameters,Plan &output) noexcept {
    Plan staged;if(!affine(parameters,staged.steps[0]))return false;
    auto combined=staged.steps[0];
    // The captured flip presets are rotations and are applied in X/Y/Z order.
    constexpr std::array<std::array<float,3>,3> angles{{{0,180,0},{180,0,0},{0,0,180}}};
    for(unsigned axis=0;axis<3;++axis)if(parameters.flips[axis]) {
        Parameters flip;flip.pivot=parameters.pivot;flip.euler=angles[axis];
        if(!affine(flip,staged.steps[staged.count]))return false;
        combined=after(combined,staged.steps[staged.count++]);
    }
    for(unsigned r=0;r<3;++r) {
        staged.matrix[12+r]=float(combined.t[r]);
        for(unsigned c=0;c<3;++c)staged.matrix[c*4+r]=float(combined.a[r][c]);
    }
    if(!std::all_of(staged.matrix.begin(),staged.matrix.end(),[](float value){return std::isfinite(value);}))return false;
    output=staged;return true;
}
bool compose(const ComposeInput &input,Matrix4 &output) noexcept {
    if(!bounded(input)||input[0]<0||input[0]>3||input[0]!=std::floor(input[0]))return false;
    Parameters p;p.mode=static_cast<Mode>(unsigned(input[0]));
    std::copy_n(input.begin()+1,3,p.translation.begin());std::copy_n(input.begin()+4,3,p.scale.begin());
    std::copy_n(input.begin()+7,3,p.pivot.begin());std::copy_n(input.begin()+10,3,p.euler.begin());
    std::copy_n(input.begin()+13,4,p.quaternion.begin());std::copy_n(input.begin()+17,3,p.axis.begin());
    p.angle=input[20];std::copy_n(input.begin()+21,16,p.matrix.begin());
    for(unsigned i=0;i<3;++i) { if(input[37+i]!=0&&input[37+i]!=1)return false;p.flips[i]=input[37+i]!=0; }
    Plan staged;if(!plan(p,staged))return false;output=staged.matrix;return true;
}
bool identity(const Plan &value) noexcept {
    if(value.count!=1)return false;const auto &a=value.steps[0];
    for(unsigned r=0;r<3;++r) { if(a.t[r]!=0)return false;for(unsigned c=0;c<3;++c)if(a.a[r][c]!=(r==c?1:0))return false; }
    return true;
}
bool same(const Plan &a,const Plan &b) noexcept {
    if(a.count!=b.count)return false;
    for(size_t i=0;i<a.count;++i)for(unsigned r=0;r<3;++r) { if(a.steps[i].t[r]!=b.steps[i].t[r])return false;
        for(unsigned c=0;c<3;++c)if(a.steps[i].a[r][c]!=b.steps[i].a[r][c])return false; }
    return true;
}
} // namespace preview::browser_transform
