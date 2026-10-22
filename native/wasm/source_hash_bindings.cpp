#include "source_hash.hpp"
#include <emscripten/heap.h>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>

// One fixed browser hash slot, separate from all scene and edit owners.
// The verified worker binds its request/resource family and owns input/output
// allocations. These opaque numeric handles never dereference caller pointers.
namespace {
using preview::SourceHash;
using preview::SourceHashStatus;
enum BindingStatus : std::uint32_t {
    InvalidHandle=9, InvalidByteCount=10, HeapRange=11,
    InvalidOutputSize=12, ProtectedOwnerMemory=13,
};
struct Slot final {
    SourceHash hash;
    std::uint32_t activeHandle{};
    std::uint32_t lastIssued{};
};
Slot slot;
static_assert(sizeof(std::uintptr_t)==4 && sizeof(std::size_t)==4,
              "Source hash bindings require the wasm32 ABI");
static_assert(sizeof(picosha2::word_t)==4, "Measure and require the actual wasm32 hash word ABI");

bool validHandle(std::uint32_t handle) noexcept {
    return handle!=0 && handle==slot.activeHandle;
}
bool safeByteCount(double count) noexcept {
    return std::isfinite(count) && count>=0 && count<=double(SourceHash::maxExpectedBytes)
        && std::floor(count)==count;
}
std::uint32_t nextHandle(std::uint32_t previous) noexcept {
    return previous==std::numeric_limits<std::uint32_t>::max() ? 0 : previous+1;
}
std::uint32_t spanStatus(std::uint32_t pointer,std::uint32_t length) noexcept {
    const auto heap=std::uint64_t(emscripten_get_heap_size());
    const auto start=std::uint64_t(pointer), size=std::uint64_t(length);
    if(start>heap || size>heap-start) return HeapRange;
    if(size && !pointer) return std::uint32_t(SourceHashStatus::NullInput);
    const auto owner=std::uint64_t(reinterpret_cast<std::uintptr_t>(&slot));
    if(size && start<owner+sizeof(slot) && owner<start+size) return ProtectedOwnerMemory;
    return 0;
}
std::uint32_t status(SourceHashStatus value) noexcept { return std::uint32_t(value); }
}

extern "C" {
std::uint32_t sv_source_hash_create() noexcept {
    if(slot.activeHandle) return 0;
    const auto handle=nextHandle(slot.lastIssued);
    if(!handle) return 0; // Exhaustion is permanent; stale handles never wrap.
    slot.hash.reset();
    slot.lastIssued=handle;
    slot.activeHandle=handle;
    return handle;
}
std::uint32_t sv_source_hash_delete(std::uint32_t handle) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    slot.hash.reset();
    slot.activeHandle=0;
    return 0;
}
std::uint32_t sv_source_hash_begin(std::uint32_t handle,double expected) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    if(!safeByteCount(expected)) return InvalidByteCount;
    return status(slot.hash.begin(std::uint64_t(expected)));
}
std::uint32_t sv_source_hash_update(std::uint32_t handle,double offset,
        std::uint32_t pointer,std::uint32_t length) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    if(!safeByteCount(offset)) return InvalidByteCount;
    if(length>SourceHash::maxChunkBytes) return status(SourceHashStatus::ChunkTooLarge);
    if(const auto failure=spanStatus(pointer,length)) return failure;
    return status(slot.hash.update(std::uint64_t(offset),
        reinterpret_cast<const std::uint8_t *>(std::uintptr_t(pointer)),std::size_t(length)));
}
std::uint32_t sv_source_hash_finish(std::uint32_t handle) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    return status(slot.hash.finish());
}
std::uint32_t sv_source_hash_digest(std::uint32_t handle,
        std::uint32_t output,std::uint32_t length) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    if(length!=SourceHash::digestBytes) return InvalidOutputSize;
    if(const auto failure=spanStatus(output,length)) return failure;
    const auto *digest=slot.hash.digest();
    if(!digest) return status(SourceHashStatus::InvalidState);
    std::memcpy(reinterpret_cast<void *>(std::uintptr_t(output)),digest->data(),digest->size());
    return 0;
}
std::uint32_t sv_source_hash_reset(std::uint32_t handle) noexcept {
    if(!validHandle(handle)) return InvalidHandle;
    slot.hash.reset();
    return 0;
}
std::int32_t sv_source_hash_state(std::uint32_t handle) noexcept {
    return validHandle(handle) ? std::int32_t(slot.hash.state()) : -std::int32_t(InvalidHandle);
}
double sv_source_hash_expected_bytes(std::uint32_t handle) noexcept {
    return validHandle(handle) ? double(slot.hash.expectedBytes()) : -double(InvalidHandle);
}
double sv_source_hash_consumed_bytes(std::uint32_t handle) noexcept {
    return validHandle(handle) ? double(slot.hash.consumedBytes()) : -double(InvalidHandle);
}
}
