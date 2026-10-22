#pragma once
// Included only after the guarded disposable selection.cpp overlay defines
// SelectionMask. Its native contains/ellipse/projection path remains shared.
#include "selection_checkpoint.hpp"

namespace preview {
bool BrowserSelectionAccess::flood(SceneEdits &edits,const Camera &camera,unsigned width,unsigned height,
    PointI seed,float tolerance,SelectOperation operation,SelectionOptions options,const SelectionMap &map,
    std::span<const float> colors,std::stop_token stop) {
    const auto pixels=size_t(map.width)*map.height;
    if(!width || !height || !map.width || !map.height || pixels>262144 || map.opacities.size()!=pixels ||
       (!colors.empty() && colors.size()!=3*pixels) || !std::isfinite(tolerance) || seed.x<0 || seed.y<0 ||
       unsigned(seed.x)>=width || unsigned(seed.y)>=height)
        return false;
    const unsigned sx=unsigned(uint64_t(seed.x)*map.width/width),sy=unsigned(uint64_t(seed.y)*map.height/height);
    const float opacity=map.opacities[size_t(sy)*map.width+sx];
    if(!std::isfinite(opacity) || opacity<1.f/255) return false;
    SelectionMask mask(map.width,map.height,edits.scratchMemory_);
    SceneVector<uint8_t> visited(pixels,uint8_t{},SceneAllocator<uint8_t>{edits.scratchMemory_});
    SceneVector<uint32_t> queue{SceneAllocator<uint32_t>{edits.scratchMemory_}};
    queue.reserve(pixels);
    tolerance=std::clamp(tolerance,0.f,1.f);
    // Windows compares rendered RGB to the fixed clicked surface pixel. The
    // SH contributor comparison remains separate and has no compositing noise.
    constexpr float noise=4*std::numeric_limits<float>::epsilon();
    const float squaredTolerance=3*(tolerance*tolerance+noise*noise);
    const size_t seedIndex=size_t(sy)*map.width+sx;
    const auto matches=[&](size_t index) {
        if(colors.empty()) return std::abs(map.opacities[index]-opacity)<=tolerance;
        float distance=0;
        for(unsigned channel=0;channel<3;++channel) {
            const float difference=colors[3*index+channel]-colors[3*seedIndex+channel];
            distance+=difference*difference;
        }
        return distance<=squaredTolerance;
    };
    const auto visit=[&](unsigned x,unsigned y) {
        const auto index=size_t(y)*map.width+x;
        if(visited[index]) return;
        visited[index]=1;
        const float value=map.opacities[index];
        if(std::isfinite(value) && value>=1.f/255 && matches(index))
            queue.push_back(uint32_t(index));
    };
    visit(sx,sy);
    for(size_t next=0;next<queue.size();++next) {
        if((next&1023)==0 && stop.stop_requested()) throw std::runtime_error("Connected selection cancelled");
        const unsigned x=queue[next]%map.width,y=queue[next]/map.width;
        mask.bits_[size_t(y)*mask.stride_+x/64]|=uint64_t(1)<<(x%64);
        if(x) visit(x-1,y);
        if(x+1<map.width) visit(x+1,y);
        if(y) visit(x,y-1);
        if(y+1<map.height) visit(x,y+1);
    }
    mask.scaleX_=float(width)/map.width; mask.scaleY_=float(height)/map.height;
    return edits.selectMask(camera,width,height,mask,operation,options,&map);
}
} // namespace preview
