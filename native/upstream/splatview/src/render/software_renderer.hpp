#pragma once
#include "render_frame.hpp"
#include "render_storage.hpp"
#include "admitted_storage.hpp"
#include <span>
#include <stop_token>

namespace preview {
struct RenderStats { uint64_t rasterizations{}, depthSorts{}, orderUploads{}, cacheHits{}; };
class SoftwareRenderer {
  public:
    SoftwareRenderer();
    explicit SoftwareRenderer(RenderStorage);
    void resize(unsigned width,unsigned height);
    void setScene(std::shared_ptr<const Scene>);
    void setStates(std::span<const uint8_t>);
    void draw(const Camera &,const ViewSettings & = {},std::stop_token = {});
    void draw(const Camera &,const ViewSettings &,std::stop_token,std::shared_ptr<SceneMemory> scratch);
    const Image &readback() const { return image_; }
    const RenderFrame &frame() const { return frame_; }
    RenderStats stats() const { return stats_; }
    std::optional<uint32_t> pick(const Camera &,PointI,std::stop_token = {});
    // At most 262144 pixels for surface/visibility maps, 1048576 for ID maps.
    SelectionMap selectionMap(const Camera &,bool surfaceDepth=false,bool markVisible=false,std::stop_token = {});
    SelectionMap selectionMap(const Camera &,bool surfaceDepth,bool markVisible,std::stop_token,
                              std::shared_ptr<SceneMemory> scratch);
    RgbHistogram histogram() const;
  private:
    RenderStorage storage_;
    unsigned width_{},height_{};
    bool dirty_{true};
    std::shared_ptr<const Scene> scene_;
    AdmittedVector<uint8_t> states_;
    SavedView lastCamera_;
    float lastRadius_{};
    ViewSettings lastSettings_;
    RenderFrame frame_;
    Image image_;
    RenderStats stats_;
};
class ThumbnailRenderer {
  public:
    ThumbnailRenderer() = default;
    explicit ThumbnailRenderer(RenderStorage);
    Image render(std::shared_ptr<const Scene>,unsigned size,std::stop_token = {});
  private:
    SoftwareRenderer renderer_;
};
} // namespace preview
