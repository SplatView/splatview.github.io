#include "browser_spz3_memory.hpp"
#include "resource_budget.hpp"
#include <limits>
#include <new>
#include <stdexcept>

namespace preview::browser_spz3 {
std::size_t compressedBound(std::size_t rawBytes) {
    if (rawBytes > blockBytes || rawBytes > std::numeric_limits<uLong>::max())
        throw std::invalid_argument("SPZ3 raw block exceeds its fixed workspace");
    // compressBound is allocation-free and exceeds this exact raw-deflate
    // configuration's deflateBound. Preserve the desktop's extra 16 bytes.
    return checkedByteSum({static_cast<std::size_t>(compressBound(static_cast<uLong>(rawBytes))), 16});
}
CodecMemory::CodecMemory(std::shared_ptr<SceneMemory> memory, std::size_t limit)
    : allocator_(std::move(memory)), limit_(limit) {
    if (!allocator_.memory()) throw std::invalid_argument("SPZ3 codec requires admitted memory");
}
void CodecMemory::configure(z_stream &stream) noexcept {
    stream.zalloc = &allocate; stream.zfree = &release; stream.opaque = this;
}
void CodecMemory::rethrowFailure() const {
    if (failure_) std::rethrow_exception(failure_);
}
voidpf CodecMemory::allocate(voidpf opaque, uInt count, uInt size) noexcept {
    auto &self = *static_cast<CodecMemory *>(opaque);
    if (self.failure_) return nullptr;
    try {
        const auto bytes = checkedByteProduct(count, size);
        const auto rounded = checkedByteSum({bytes, sizeof(std::max_align_t) - 1}) / sizeof(std::max_align_t);
        const auto units = checkedByteSum({headerUnits, rounded});
        const auto payload = checkedByteProduct(units, sizeof(std::max_align_t));
        if (payload > self.limit_ - self.live_)
            throw std::runtime_error("SPZ3 codec exceeds its admitted workspace bound");
        auto *block = self.allocator_.allocate(units);
        ::new (static_cast<void *>(block)) Header{units};
        self.live_ += payload;
        return block + headerUnits;
    } catch (...) { self.failure_ = std::current_exception(); return nullptr; }
}
void CodecMemory::release(voidpf opaque, voidpf address) noexcept {
    if (!address) return;
    auto &self = *static_cast<CodecMemory *>(opaque);
    auto *block = static_cast<std::max_align_t *>(address) - headerUnits;
    const auto units = reinterpret_cast<const Header *>(block)->units;
    const auto payload = units * sizeof(std::max_align_t);
    self.allocator_.deallocate(block, units); self.live_ -= payload;
}
} // namespace preview::browser_spz3
