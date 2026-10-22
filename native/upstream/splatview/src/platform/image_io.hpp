#pragma once
#include "render_types.hpp"
#include "resource_budget.hpp"
#include <filesystem>
#include <optional>
#include <stop_token>

namespace preview {
struct ImageReadOptions {
    unsigned maxEdge{};
    std::stop_token stop{};
    std::optional<ResourceBudget> resources{};
};
// Keep this owner alive while borrowing its pixels. Each pixel allocation owns
// its grant; deep Image copies inherit that policy and admit their own capacity.
class DecodedImage {
  public:
    DecodedImage(DecodedImage &&) noexcept = default;
    DecodedImage &operator=(DecodedImage &&) noexcept;
    DecodedImage(const DecodedImage &) = delete;
    DecodedImage &operator=(const DecodedImage &) = delete;
    const Image &image() const { return image_; }
    std::size_t admittedImageBytes() const {
        return image_.bgra.get_allocator().memory() ? image_.bgra.capacity() : 0;
    }
  private:
    // Per-thread deterministic stage injection is private test access. Normal
    // callers cannot install callbacks; native/portable decoders share it.
    friend struct ImageDecodeTestAccess;
    friend DecodedImage readImage(const std::filesystem::path &, const ImageReadOptions &);
    friend Image readImage(const std::filesystem::path &, unsigned);
    explicit DecodedImage(Image);
    static thread_local void (*checkpoint_)(void *, const char *);
    static thread_local void *checkpointContext_;
    static void setCheckpoint(void (*)(void *, const char *), void *) noexcept;
    static void checkpoint(const char *);
    Image image_;
};
// The admitted route retains Source through decode/resize, accounts controlled
// decoder Work, and returns an owner retaining Image admission. Native codec
// internals remain estimates/uninstrumented; this is not an RSS limit.
DecodedImage readImage(const std::filesystem::path &, const ImageReadOptions &);
// Compatibility route deliberately has no ledger; use the overload above to
// admit encoded source, decoder Work and owned output pixels under a policy.
Image readImage(const std::filesystem::path &, unsigned maxEdge = 0);
void writePng(const Image &, const std::filesystem::path &);
// Encoding may finish after cancellation, but an observed stop before commit
// preserves the existing destination and removes the temporary output.
void writeJpeg95(const Image &, const std::filesystem::path &, std::stop_token = {});
std::vector<uint8_t> jpeg95(const Image &);
// The compatibility entry inherits the source pixel policy.
Image squareThumbnail(const Image &, unsigned size = 1024);
// Supply an explicit service to allocate the thumbnail under a chosen policy;
// the service never retroactively admits the source's existing allocation.
Image squareThumbnail(const Image &, unsigned size, std::shared_ptr<SceneMemory> imageService);
} // namespace preview
