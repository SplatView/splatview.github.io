#pragma once
#include "editing.hpp"
#include "resource_budget.hpp"
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

namespace preview {
// Browser-only versioned channel owner. The frozen portable SelectionMap has
// no opacity/RGB channels; future domain adapters consume these named arrays.
struct BrowserSelectionMapHeader {
    uint64_t mapId{};
    uint32_t layoutVersion{},fullWidth{},fullHeight{},mapWidth{},mapHeight{},sourceCount{},channels{};
};
struct BrowserSelectionMap {
    static constexpr uint32_t depthChannel=1,opacityChannel=2,rgbChannel=4,visibleChannel=8;
    static constexpr uint32_t pixelLimit=262144,chunkLimit=1024*1024;
    BrowserSelectionMapHeader header;
    std::shared_ptr<const Scene> scene;
    uint64_t contentRevision{};
    mutable uint64_t checkedRevision{};
    SceneVector<float> depths,opacities,colors;
    SceneVector<uint32_t> visible,deleted;
    size_t receivedBytes{};

    static void validateHeader(const BrowserSelectionMapHeader &h,size_t count) {
        if(h.layoutVersion!=1 || (h.channels&~15u) || (h.channels&3u)!=3u || h.sourceCount!=count ||
           !h.fullWidth || !h.fullHeight || !h.mapWidth || !h.mapHeight)
            throw std::runtime_error("Invalid selection map header");
        const uint64_t fullPixels=uint64_t(h.fullWidth)*h.fullHeight;
        const uint64_t mapPixels=uint64_t(h.mapWidth)*h.mapHeight;
        if(fullPixels>std::numeric_limits<uint32_t>::max() || mapPixels>pixelLimit)
            throw std::runtime_error("Selection map dimensions exceed the admitted layout");
        const double scale=std::min(1.,std::sqrt(double(pixelLimit)/double(fullPixels)));
        const auto width=std::max(1u,uint32_t(std::floor(h.fullWidth*scale)));
        const auto height=std::max(1u,uint32_t(std::floor(h.fullHeight*scale)));
        if(h.mapWidth!=width || h.mapHeight!=height)
            throw std::runtime_error("Selection map dimensions do not match native floor sizing");
    }
    BrowserSelectionMap(BrowserSelectionMapHeader h,const SceneEdits &edits,std::shared_ptr<SceneMemory> memory)
        : header(h),scene(edits.scene()),contentRevision(edits.contentRevision()),checkedRevision(edits.revision()),
          depths(SceneAllocator<float>{memory}),opacities(SceneAllocator<float>{memory}),
          colors(SceneAllocator<float>{memory}),visible(SceneAllocator<uint32_t>{memory}),
          deleted(SceneAllocator<uint32_t>{std::move(memory)}) {
        validateHeader(h,edits.states().size());
        const size_t pixels=size_t(h.mapWidth)*h.mapHeight,words=(size_t(h.sourceCount)+31)/32;
        depths.resize(pixels); opacities.resize(pixels);
        if(h.channels&rgbChannel) colors.resize(3*pixels);
        if(h.channels&visibleChannel) visible.resize(words);
        deleted.resize(words);
        const auto states=edits.states();
        for(size_t i=0;i<states.size();++i) if(states[i]&2) deleted[i/32]|=uint32_t(1)<<(i%32);
    }
    size_t payloadBytes() const noexcept {
        return 4*(depths.size()+opacities.size()+colors.size()+visible.size());
    }
    size_t retainedBytes() const noexcept {
        return 4*(depths.capacity()+opacities.capacity()+colors.capacity()+visible.capacity()+deleted.capacity());
    }
    bool current(const SceneEdits &edits) const noexcept {
        if(scene!=edits.scene() || contentRevision!=edits.contentRevision() || header.sourceCount!=edits.states().size())
            return false;
        // Selection-only changes preserve a surface. Confirm membership after
        // native revisions without retaining an old selected-mask allocation.
        if(checkedRevision!=edits.revision()) {
            const auto states=edits.states();
            for(size_t i=0;i<states.size();++i)
                if(bool(states[i]&2)!=bool(deleted[i/32]&(uint32_t(1)<<(i%32)))) return false;
            checkedRevision=edits.revision();
        }
        return true;
    }
    void write(size_t offset,std::span<const uint8_t> bytes) {
        if(offset!=receivedBytes || offset%4 || bytes.empty() || bytes.size()%4 || bytes.size()>chunkLimit ||
           offset>payloadBytes() || bytes.size()>payloadBytes()-offset)
            throw std::runtime_error("Invalid selection map chunk offset or length");
        size_t skip=offset,cursor=0;
        const auto copy=[&](auto &channel) {
            const size_t length=channel.size()*sizeof(typename std::decay_t<decltype(channel)>::value_type);
            if(skip>=length) { skip-=length; return; }
            const auto count=std::min(length-skip,bytes.size()-cursor);
            if(count) std::memcpy(reinterpret_cast<uint8_t *>(channel.data())+skip,bytes.data()+cursor,count);
            cursor+=count; skip=0;
        };
        copy(depths); copy(opacities); copy(colors); copy(visible);
        receivedBytes+=bytes.size();
    }
    void validateComplete() const {
        if(receivedBytes!=payloadBytes()) throw std::runtime_error("Selection map upload is incomplete");
        for(const auto value:depths) if(!std::isfinite(value) || value<0)
            throw std::runtime_error("Invalid selection map depth");
        for(const auto value:opacities) if(!std::isfinite(value) || value<0 || value>1)
            throw std::runtime_error("Invalid selection map opacity");
        for(const auto value:colors) if(!std::isfinite(value) || value<0 || value>1)
            throw std::runtime_error("Invalid selection map RGB");
        if(!visible.empty()) {
            if(header.sourceCount%32 && (visible.back()>>(header.sourceCount%32)))
                throw std::runtime_error("Invalid selection map visibility tail");
            for(size_t i=0;i<visible.size();++i) if(visible[i]&deleted[i])
                throw std::runtime_error("Selection map visibility contains a deleted source");
        }
    }
};
} // namespace preview
