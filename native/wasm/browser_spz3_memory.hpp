#pragma once
#include "admitted_storage.hpp"
#include <zlib.h>
#include <cstddef>
#include <exception>
#include <memory>

namespace preview::browser_spz3 {
inline constexpr std::size_t blockBytes = 1024 * 1024;
// Pinned zlib's state plus window/prev/head/pending arrays, in-band allocation
// headers and alignment. The callbacks enforce the aggregate cap at runtime.
inline constexpr std::size_t codecBytes = 384 * 1024;
std::size_t compressedBound(std::size_t rawBytes);

class CodecMemory final {
  public:
    explicit CodecMemory(std::shared_ptr<SceneMemory>, std::size_t limit = codecBytes);
    void configure(z_stream &) noexcept;
    void rethrowFailure() const;
    std::size_t retainedBytes() const noexcept { return live_; }
  private:
    struct Header { std::size_t units; };
    static constexpr std::size_t headerUnits =
        (sizeof(Header) + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t);
    static voidpf allocate(voidpf, uInt, uInt) noexcept;
    static void release(voidpf, voidpf) noexcept;
    AdmittedAllocator<std::max_align_t> allocator_;
    std::size_t limit_{}, live_{};
    std::exception_ptr failure_;
};
} // namespace preview::browser_spz3
