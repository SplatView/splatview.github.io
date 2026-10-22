#pragma once
#include "render_types.hpp"
#include "resource_budget.hpp"
#include <cstddef>
#include <optional>
#include <span>
#include <stop_token>
#include <vector>

namespace preview {
// Keep this move-only result alive while consumers use its pixels. Its pixel
// allocator frees physical storage before releasing the grant. Image copies
// inherit the service and admit their own independent physical capacity.
class CapturedFrame {
  public:
    CapturedFrame(CapturedFrame &&) noexcept = default;
    CapturedFrame &operator=(CapturedFrame &&) noexcept;
    CapturedFrame(const CapturedFrame &)=delete;
    CapturedFrame &operator=(const CapturedFrame &)=delete;
    const Image &image() const { return image_; }
    std::size_t admittedImageBytes() const {
        return image_.bgra.get_allocator().memory() ? image_.bgra.capacity() : 0;
    }
  private:
    friend class FrameCaptureSnapshot;
    explicit CapturedFrame(Image);
    Image image_;
};
// Capture on the owning thread, run on a worker. The scene is retained as shared
// immutable storage; mask, camera and settings are copied. Callers must pass the
// fixed render source for an absolute color session, not already-graded data.
// A separate mutable alias must never modify the retained Scene payload.
class FrameCaptureSnapshot {
  public:
    FrameCaptureSnapshot(std::shared_ptr<const Scene>, std::span<const uint8_t>,
                         Camera, ViewSettings, unsigned width, unsigned height,
                         std::size_t maxPixels, std::optional<ResourceBudget> = {},
                         AllocationIdentity sceneIdentity = {});
    // The unbudgeted compatibility route. Budgeted snapshots require the result
    // wrapper. The image's allocator retains admission after worker completion.
    Image run(std::stop_token = {}) const;
    CapturedFrame runAdmitted(std::stop_token = {}) const;
    bool budgeted() const;
    unsigned width() const;
    unsigned height() const;
  private:
    CapturedFrame execute(std::stop_token) const;
    // Snapshot copies share the actual immutable mask and its reservations;
    // independent/concurrent runs acquire separate scratch and output grants.
    struct Data;
    std::shared_ptr<const Data> data_;
};
} // namespace preview
