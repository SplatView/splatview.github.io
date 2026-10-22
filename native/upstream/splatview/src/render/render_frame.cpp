#include "render_frame.hpp"
#include "processing_kernels.hpp"
#include "parallel_for.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <utility>

namespace preview {
namespace {
using namespace DirectX;
void checkStopped(std::stop_token stop) {
    if(stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
}
void copyPackets(GaussianPacket *destination,const GaussianPacket *source,size_t count,std::stop_token stop) {
    // Bound cancellation latency even for a long remaining merge run. Copying
    // complete packet representations leaves all float/key bits unchanged.
    while(count) {
        checkStopped(stop);
        const auto chunk=std::min(count,size_t(1024));
        std::memcpy(destination,source,chunk*sizeof(GaussianPacket));
        destination+=chunk; source+=chunk; count-=chunk;
    }
}
void stableDepthSort(AdmittedVector<GaussianPacket> &packets,std::stop_token stop) {
    checkStopped(stop);
    const auto count=packets.size();
    if(count<2) return;
    // One explicit scratch vector using the packet (Render) service, admitting
    // its actual requested capacity. Unlike std::stable_sort this has no hidden
    // allocation or low-memory fallback.
    // The scratch owner never replaces the returned frame's packet allocator.
    AdmittedVector<GaussianPacket> scratch(count,packets.get_allocator());
    auto *input=packets.data(), *output=scratch.data();
    for(size_t width=1;width<count;) {
        checkStopped(stop);
        for(size_t first=0;first<count;) {
            const auto middle=first+std::min(width,count-first);
            const auto last=middle+std::min(width,count-middle);
            auto left=first,right=middle,at=first;
            while(left<middle && right<last) {
                if((at&1023)==0) checkStopped(stop);
                // Choose the left packet on equal depth: stable compaction and
                // this tie rule preserve original source order back to front.
                const auto index=input[right].centerDepth[2]>input[left].centerDepth[2] ? right++ : left++;
                std::memcpy(output+at,input+index,sizeof(GaussianPacket));
                ++at;
            }
            if(left<middle) copyPackets(output+at,input+left,middle-left,stop);
            else if(right<last) copyPackets(output+at,input+right,last-right,stop);
            first=last;
        }
        std::swap(input,output);
        // Saturating run growth avoids width*2 and first+2*width overflow.
        if(width>=count-width) break;
        width*=2;
    }
    if(input!=packets.data()) copyPackets(packets.data(),input,count,stop);
    checkStopped(stop);
}
Vec3 xyz(FXMVECTOR v) { XMFLOAT3 p; XMStoreFloat3(&p, v); return {p.x, p.y, p.z}; }
float dot(Vec3 a, Vec3 b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
Vec3 cov(const Gaussian &g, Vec3 v) {
    return {g.covA[0]*v.x + g.covA[1]*v.y + g.covA[2]*v.z,
            g.covA[1]*v.x + g.covA[3]*v.y + g.covB[0]*v.z,
            g.covA[2]*v.x + g.covB[0]*v.y + g.covB[1]*v.z};
}
Vec3 color(const Gaussian &g, unsigned degree, Vec3 eye) {
    Vec3 d{g.positionOpacity[0]-eye.x, g.positionOpacity[1]-eye.y, g.positionOpacity[2]-eye.z};
    const float length = std::sqrt(dot(d,d));
    if (length > 0) { d.x/=length; d.y/=length; d.z/=length; }
    const float x=d.x, y=d.y, z=d.z, xx=x*x, yy=y*y, zz=z*z;
    const float b[16]{.2820947918f, -.4886025119f*y, .4886025119f*z, -.4886025119f*x,
        1.0925484306f*x*y, -1.0925484306f*y*z, .3153915653f*(2*zz-xx-yy),
        -1.0925484306f*x*z, .5462742153f*(xx-yy), -.5900435899f*y*(3*xx-yy),
        2.8906114426f*x*y*z, -.4570457995f*y*(4*zz-xx-yy), .3731763326f*z*(2*zz-3*xx-3*yy),
        -.4570457995f*x*(4*zz-xx-yy), 1.4453057213f*z*(xx-yy), -.5900435899f*x*(xx-3*yy)};
    std::array<float,3> rgb{.5f,.5f,.5f};
    for (unsigned j=0; j<(degree+1)*(degree+1); ++j)
        for (unsigned c=0;c<3;++c) rgb[c] += b[j]*shValue(g,j,c);
    return {std::max(0.f,rgb[0]),std::max(0.f,rgb[1]),std::max(0.f,rgb[2])};
}
bool selected(Vec3 p, uint8_t state, const SelectionPreview &s) {
    bool result=(state&1)!=0;
    if (!s.shape) return result;
    auto m=XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(s.worldToLocal.data()));
    auto q=xyz(XMVector3TransformCoord(XMVectorSet(p.x,p.y,p.z,1),m));
    const auto &l=s.limits;
    bool inside=false;
    if(s.shape==1) inside=dot(q,q)<=l[0]*l[0];
    if(s.shape==2) inside=std::abs(q.x)<=l[0] && std::abs(q.y)<=l[1] && std::abs(q.z)<=l[2];
    if(s.shape==3 && l[0]>0 && l[1]>0 && l[2]>0)
        inside=(q.x*q.x/(l[0]*l[0])+q.y*q.y/(l[1]*l[1])+q.z*q.z/(l[2]*l[2]))<=1;
    if(s.shape==4) inside=-q.z>=l[2] && -q.z<=l[3] && std::abs(q.x)<=-q.z*l[0] && std::abs(q.y)<=-q.z*l[1];
    return s.operation==0 ? inside : s.operation==1 ? result||inside : s.operation==2 ? result&&!inside : result&&inside;
}
} // namespace
RenderFrame prepareFrame(std::shared_ptr<const Scene> source, std::span<const uint8_t> states, const Camera &camera,
                         unsigned width, unsigned height, const ViewSettings &settings, std::stop_token stop) {
    return prepareFrameWithStorage(std::move(source),states,camera,width,height,settings,stop,{});
}
RenderFrame prepareFrame(std::shared_ptr<const Scene> source, std::span<const uint8_t> states, const Camera &camera,
                         unsigned width, unsigned height, const ViewSettings &settings, std::stop_token stop,
                         std::shared_ptr<SceneMemory> scratch) {
    return prepareFrameWithStorage(std::move(source),states,camera,width,height,settings,stop,
                                   RenderStorage{nullptr,std::move(scratch),nullptr});
}
RenderFrame prepareFrameWithStorage(std::shared_ptr<const Scene> source, std::span<const uint8_t> states, const Camera &camera,
                                    unsigned width, unsigned height, const ViewSettings &settings, std::stop_token stop,
                                    RenderStorage storage) {
    if(!source || !width || !height || width>8192 || height>8192 || uint64_t(width)*height>16'000'000)
        throw std::runtime_error("Render dimensions must be nonzero, at most 8192 per edge and 16 megapixels");
    if(!states.empty() && states.size()!=source->gaussians.size()) throw std::runtime_error("Invalid render edit states");
    if(!std::isfinite(camera.distance) || camera.distance<=0 || !std::isfinite(camera.yaw) || !std::isfinite(camera.pitch) ||
       !std::isfinite(camera.radius) || camera.radius<=0 || !std::isfinite(camera.fieldOfView) || !std::isfinite(camera.roll) ||
       !std::isfinite(camera.target.x) || !std::isfinite(camera.target.y) || !std::isfinite(camera.target.z))
        throw std::runtime_error("Invalid render camera");
    checkStopped(stop);
    auto scene=source;
    if(scene->isGaussian() && (settings.color!=neutralColor || settings.geometry!=identityMatrix)) {
        scene=previewScene(source,states,settings.color,settings.colorSelectedOnly,
                           settings.geometry,settings.geometrySelectedOnly,stop,storage.work);
    }
    checkStopped(stop);
    RenderFrame frame{width,height,scene->type,scene->loadedCount(),
                      AdmittedVector<GaussianPacket>{AdmittedAllocator<GaussianPacket>{storage.packets}},
                      AdmittedVector<GeometryPacket>{AdmittedAllocator<GeometryPacket>{storage.packets}},
                      AdmittedVector<std::array<uint32_t,3>>{AdmittedAllocator<std::array<uint32_t,3>>{storage.packets}}};
    const auto view=camera.view(), projection=camera.projection(float(width)/height);
    XMFLOAT4X4 v, pr; XMStoreFloat4x4(&v,view); XMStoreFloat4x4(&pr,projection);
    if(!scene->isGaussian()) {
        frame.vertices.resize(scene->vertices.size());
        detail::parallelFor(frame.vertices.size(),stop,[&](size_t i) {
            const auto &p=scene->vertices[i]; auto &packet=frame.vertices[i];
            XMFLOAT4 clip; XMStoreFloat4(&clip,XMVector4Transform(XMVectorSet(p.position.x,p.position.y,p.position.z,1),view*projection));
            packet.clip={clip.x,clip.y,clip.z,clip.w};
            packet.color={float(p.color&255)/255,float((p.color>>8)&255)/255,float((p.color>>16)&255)/255,1};
            packet.world={p.position.x,p.position.y,p.position.z,1};
        });
        frame.triangles.assign(scene->triangles.begin(),scene->triangles.end());
        checkStopped(stop);
        return frame;
    }
    frame.splats.resize(scene->gaussians.size());
    const Vec3 right{v._11,v._21,v._31}, up{v._12,v._22,v._32}, forward{v._13,v._23,v._33};
    const float fx=pr._11*width*.5f, fy=pr._22*height*.5f;
    detail::parallelFor(frame.splats.size(),stop,[&](size_t i) {
        const auto &g=scene->gaussians[i]; auto &o=frame.splats[i];
        const auto state=states.empty()?uint8_t(0):states[i];
        if((state&2) || g.positionOpacity[3]<1.f/255) return;
        const Vec3 position{g.positionOpacity[0],g.positionOpacity[1],g.positionOpacity[2]};
        auto p=XMVector4Transform(XMVectorSet(position.x,position.y,position.z,1),view);
        XMFLOAT4 q,clip; XMStoreFloat4(&q,p); XMStoreFloat4(&clip,XMVector4Transform(p,projection));
        if(q.z>=-.001f || clip.z<0 || clip.z>clip.w) return;
        const float d=-q.z;
        const Vec3 jx{fx/d*(right.x+q.x/d*forward.x),fx/d*(right.y+q.x/d*forward.y),fx/d*(right.z+q.x/d*forward.z)};
        const Vec3 jy{fy/d*(up.x+q.y/d*forward.x),fy/d*(up.y+q.y/d*forward.y),fy/d*(up.z+q.y/d*forward.z)};
        const float a=dot(jx,cov(g,jx))+.3f, b=dot(jx,cov(g,jy)), c=dot(jy,cov(g,jy))+.3f;
        const float mid=(a+c)*.5f, delta=std::sqrt(std::max(0.f,(a-c)*(a-c)*.25f+b*b));
        const float l1=std::max(.01f,mid+delta), l2=std::max(.01f,mid-delta);
        float ax=a>=c?1.f:0.f, ay=a>=c?0.f:1.f;
        if(std::abs(b)>.00001f) { const float length=std::hypot(b,l1-a); ax=b/length; ay=(l1-a)/length; }
        const float r1=std::min(1536.f,3*std::sqrt(l1)), r2=std::min(1536.f,3*std::sqrt(l2));
        const float x=(clip.x/clip.w+1)*width*.5f, y=(1-clip.y/clip.w)*height*.5f;
        o.axes={ax*r1,-ay*r1,-ay*r2,-ax*r2};
        const float ex=std::abs(o.axes[0])+std::abs(o.axes[2])+1, ey=std::abs(o.axes[1])+std::abs(o.axes[3])+1;
        if(!std::isfinite(x+ y+ex+ey) || x+ex<0 || x-ex>width || y+ey<0 || y-ey>height) return;
        o.centerDepth={x,y,d,3*std::sqrt(std::max(0.f,dot(forward,cov(g,forward))))};
        auto rgb=color(g,std::min(3u,scene->shDegree),camera.eye());
        if(settings.colorPreviewCoverage) rgb={1,(state&1)?1.f:0.f,0};
        else if(settings.highlightSelection && selected(position,state,settings.selection))
            rgb={rgb.x*.28f+.72f,rgb.y*.28f+.72f*.72f,rgb.z*.28f+.12f*.72f};
        o.color={rgb.x,rgb.y,rgb.z,g.positionOpacity[3]};
        o.identity={uint32_t(i+1),state,0,0};
    });
    size_t kept=0;
    for(size_t i=0;i<frame.splats.size();++i) {
        if((i&1023)==0) checkStopped(stop);
        if(frame.splats[i].identity[0]) {
            if(kept!=i) std::memcpy(frame.splats.data()+kept,frame.splats.data()+i,sizeof(GaussianPacket));
            ++kept;
        }
    }
    frame.splats.resize(kept);
    stableDepthSort(frame.splats,stop);
    checkStopped(stop);
    return frame;
}
float sampleAlpha(const GaussianPacket &p,float x,float y) {
    x-=p.centerDepth[0]; y-=p.centerDepth[1];
    const auto &a=p.axes; const float det=a[0]*a[3]-a[1]*a[2];
    if(!std::isfinite(det) || std::abs(det)<1e-12f) return 0;
    const float u=3*(x*a[3]-y*a[2])/det, v=3*(y*a[0]-x*a[1])/det, r=u*u+v*v;
    if(r>9) return 0;
    const float alpha=std::min(.99f,p.color[3]*std::exp(-.5f*r));
    return alpha>=1.f/255 ? alpha : 0;
}
} // namespace preview
