#include "surface_selection.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview {
std::optional<VolumeSample> volumeSampleAt(const Camera &camera,const SelectionMap &map,
    unsigned width,unsigned height,PointI point,float radiusPixels) {
    if(!width || !height || width>unsigned(INT32_MAX) || height>unsigned(INT32_MAX) ||
       point.x<0 || point.y<0 || unsigned(point.x)>=width || unsigned(point.y)>=height ||
       !map.width || !map.height || map.width>8192 || map.height>8192 || uint64_t(map.width)*map.height>16'000'000 ||
       map.depths.size()!=uint64_t(map.width)*map.height || !std::isfinite(radiusPixels) || radiusPixels<=0 ||
       !std::isfinite(camera.distance) || camera.distance<=0 || !std::isfinite(camera.radius) || camera.radius<=0 ||
       !std::isfinite(camera.yaw) || !std::isfinite(camera.pitch) || !std::isfinite(camera.target.x) ||
       !std::isfinite(camera.target.y) || !std::isfinite(camera.target.z) ||
       !std::isfinite(camera.fieldOfView) || camera.fieldOfView<10 || camera.fieldOfView>120)
        return {};
    const int x=int(uint64_t(point.x)*map.width/width), y=int(uint64_t(point.y)*map.height/height);
    float depth=map.depths[size_t(y)*map.width+x];
    if(!std::isfinite(depth) || depth<=0) return {};
    // Retain the source viewer's 5% discontinuity guard. A nearby background
    // pixel must not pull a brush off its foreground surface.
    const float px=(point.x+.5f)*map.width/width-.5f, py=(point.y+.5f)*map.height/height-.5f;
    const int left=int(std::floor(px)), top=int(std::floor(py));
    const float fx=px-left, fy=py-top;
    float sum=0,weight=0;
    for(int dy=0;dy<2;++dy) for(int dx=0;dx<2;++dx) {
        const int column=std::clamp(left+dx,0,int(map.width)-1), row=std::clamp(top+dy,0,int(map.height)-1);
        const float candidate=map.depths[size_t(row)*map.width+column];
        if(std::isfinite(candidate) && candidate>0 && std::abs(candidate-depth)<=depth*.05f) {
            const float w=(dx?fx:1-fx)*(dy?fy:1-fy); sum+=w*candidate; weight+=w;
        }
    }
    if(weight>0) depth=sum/weight;
    DirectX::XMFLOAT4X4 projection;
    DirectX::XMStoreFloat4x4(&projection,camera.projection(float(width)/height));
    const float radius=radiusPixels*2*depth/projection._22/height;
    const auto viewPoint=DirectX::XMVectorSet(((point.x+.5f)*2/width-1)*depth/projection._11,
        (1-(point.y+.5f)*2/height)*depth/projection._22,-depth,1);
    DirectX::XMFLOAT3 center;
    DirectX::XMStoreFloat3(&center,DirectX::XMVector3TransformCoord(viewPoint,DirectX::XMMatrixInverse(nullptr,camera.view())));
    if(!std::isfinite(radius) || radius<=0 || !std::isfinite(center.x) || !std::isfinite(center.y) || !std::isfinite(center.z)) return {};
    return VolumeSample{{center.x,center.y,center.z},radius};
}
SceneVector<VolumeSample> volumeStrokeSamples(const Camera &camera,const SelectionMap &map,
    unsigned width,unsigned height,std::span<const PointI> stroke,float radiusPixels,std::stop_token stop,
    std::shared_ptr<SceneMemory> scratch) {
    SceneVector<VolumeSample> samples{SceneAllocator<VolumeSample>{std::move(scratch)}};
    if(!std::isfinite(radiusPixels) || radiusPixels<=0 || stroke.empty()) return samples;
    auto append=[&](PointI p) {
        if(stop.stop_requested()) throw std::runtime_error("Volume selection cancelled");
        if(auto sample=volumeSampleAt(camera,map,width,height,p,radiusPixels)) samples.push_back(*sample);
    };
    append(stroke.front());
    size_t attempts=1;
    for(size_t i=1;i<stroke.size();++i) {
        const auto a=stroke[i-1], b=stroke[i];
        const double length=std::hypot(double(b.x)-a.x,double(b.y)-a.y);
        const size_t steps=size_t(std::min(65536.,std::max(1.,std::ceil(length/std::max(2.,double(radiusPixels)*.25)))));
        // SceneEdits deliberately limits a committed volume stroke to 65536
        // samples. Reject excessive work rather than silently truncating it.
        if(steps>65536-attempts) throw std::runtime_error("Volume stroke exceeds sample budget");
        attempts+=steps;
        for(size_t j=1;j<=steps;++j) {
            const double t=double(j)/steps;
            append({int32_t(std::lround(a.x+(double(b.x)-a.x)*t)),int32_t(std::lround(a.y+(double(b.y)-a.y)*t))});
        }
    }
    return samples;
}
} // namespace preview
