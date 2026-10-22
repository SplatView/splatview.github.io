#pragma once
#include "mask_storage.hpp"
#include "render_frame.hpp"
#include "resource_budget.hpp"
#include <cstdint>
#include <memory>
#include <optional>
#include <stop_token>

namespace preview {
enum class PreviewBackend { Metal, Software };
// Identity includes every camera field, including radius, and all live settings.
// A displayed frame's query data is usable only while this complete key matches.
struct PreviewKey {
    uint64_t owner{}, sourceGeneration{}, editRevision{}, draftRevision{};
    Camera camera;
    ViewSettings settings;
    unsigned width{}, height{};
    PreviewBackend backend{PreviewBackend::Metal};
    bool operator==(const PreviewKey &) const noexcept;
};

class LivePreviewSnapshot;
// Move-only ownership of the prepared packets and, for Software, rendered pixels.
// Metal results have an empty image(). Software results expose both outputs.
// References returned by the accessors require this result to remain alive.
// Packet/Image copies inherit their allocator service and admit independent
// capacity; moves retain physical ownership. Native upload/GPU/presentation,
// opaque codec contexts and encoding remain outside these allocation owners.
class LivePreviewResult {
  public:
    ~LivePreviewResult();
    LivePreviewResult(LivePreviewResult &&) noexcept;
    LivePreviewResult &operator=(LivePreviewResult &&) noexcept;
    LivePreviewResult(const LivePreviewResult &) = delete;
    LivePreviewResult &operator=(const LivePreviewResult &) = delete;
    const PreviewKey &key() const noexcept;
    const RenderFrame &frame() const noexcept;
    const Image &image() const noexcept;
  private:
    friend class LivePreviewSnapshot;
    struct Data;
    explicit LivePreviewResult(std::unique_ptr<Data>) noexcept;
    std::unique_ptr<Data> data_;
};

// Capture on the owner thread and run on a worker. Scene and immutable mask are
// shared without a per-camera mask copy. A mutable Scene alias must not modify
// the retained payload. Absolute color sessions supply their fixed render base.
// Budgeted nonempty masks must already belong to that ledger (History is valid);
// untracked/foreign aliases are rejected, never retroactively certified/copied.
// Staging checks mask size/ledger in O(1); run validates its bytes with stop checks.
// Edited Scene copies retain their source allocator/category; their untracked
// remainder is estimated as Work, while bounds scratch receives actual Work.
class LivePreviewSnapshot {
  public:
    LivePreviewSnapshot(PreviewKey, std::shared_ptr<const Scene>, MaskStorage,
                        std::optional<ResourceBudget> = {}, AllocationIdentity = {});
    const PreviewKey &key() const noexcept;
    LivePreviewResult run(std::stop_token = {}) const;
  private:
    friend class LivePreviewResult;
    struct Data;
    std::shared_ptr<const Data> data_;
};
} // namespace preview
