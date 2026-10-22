#pragma once
#include "scene_storage.hpp"
#include <cstddef>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>
#include <vector>

namespace preview {
// Unlike SceneAllocator's payload-only policy, this allocator admits actual
// rebound node, bucket, map and block payloads too. Every allocation has the
// same envelope, even without a service, so deallocation never depends on the
// current allocator/service state. The envelope and grant control block remain
// outside payload accounting.
template<class T> class AdmittedAllocator {
    template<class> friend class AdmittedAllocator;
    struct Header { std::shared_ptr<void> grant; };
    static constexpr std::size_t padding = (alignof(T) - sizeof(Header) % alignof(T)) % alignof(T);
    static constexpr std::size_t offset = sizeof(Header) + padding;
    static constexpr std::size_t alignment = alignof(T) > alignof(Header) ? alignof(T) : alignof(Header);
#if defined(_MSC_VER) && defined(_MSVC_STL_VERSION) && defined(_ITERATOR_DEBUG_LEVEL) && _ITERATOR_DEBUG_LEVEL != 0
    // MSVC creates/replaces this exact debugger object inside noexcept vector
    // constructors/moves and the hash bucket-vector constructor. Rejecting its
    // admission would terminate instead of reporting a resource limit. It is
    // debugger bookkeeping only; all real rebound node/bucket/block types are
    // still admitted. The proxy still uses our envelope and matching delete.
    static constexpr bool debugProxy = std::is_same_v<T, std::_Container_proxy>;
#else
    static constexpr bool debugProxy = false;
#endif
  public:
    using value_type = T;
    using propagate_on_container_copy_assignment = std::true_type;
    using propagate_on_container_move_assignment = std::true_type;
    using propagate_on_container_swap = std::true_type;
    using is_always_equal = std::false_type;
    template<class U> struct rebind { using other = AdmittedAllocator<U>; };

    AdmittedAllocator() noexcept = default;
    explicit AdmittedAllocator(std::shared_ptr<SceneMemory> memory) noexcept : memory_(std::move(memory)) {}
    AdmittedAllocator(const AdmittedAllocator &) noexcept = default;
    AdmittedAllocator &operator=(const AdmittedAllocator &) noexcept = default;
    // Copy the policy on move: a reused moved-from container must not silently
    // become unbudgeted. Shared-pointer copies allocate no storage or grants.
    AdmittedAllocator(AdmittedAllocator &&other) noexcept : memory_(other.memory_) {}
    AdmittedAllocator &operator=(AdmittedAllocator &&other) noexcept {
        memory_ = other.memory_;
        return *this;
    }
    template<class U>
    AdmittedAllocator(const AdmittedAllocator<U> &other) noexcept : memory_(other.memory_) {}
    const std::shared_ptr<SceneMemory> &memory() const noexcept { return memory_; }
    AdmittedAllocator select_on_container_copy_construction() const noexcept { return *this; }

    T *allocate(std::size_t count) {
        if (count > (std::numeric_limits<std::size_t>::max() - offset) / sizeof(T))
            throw std::bad_array_new_length();
        const auto bytes = count * sizeof(T);
        std::shared_ptr<void> grant;
        if constexpr (!debugProxy) {
            if (memory_) grant = memory_->admit(bytes);
        }
        // If allocation fails, the local grant rolls back before propagation.
        void *block;
        if constexpr (alignment > __STDCPP_DEFAULT_NEW_ALIGNMENT__)
            block = ::operator new(offset + bytes, std::align_val_t{alignment});
        else
            block = ::operator new(offset + bytes);
        std::construct_at(static_cast<Header *>(block), Header{std::move(grant)});
        return reinterpret_cast<T *>(static_cast<std::byte *>(block) + offset);
    }

    void deallocate(T *data, std::size_t) noexcept {
        if (!data) return;
        auto *block = reinterpret_cast<std::byte *>(data) - offset;
        auto *header = reinterpret_cast<Header *>(block);
        auto retained = std::move(header->grant);
        std::destroy_at(header);
        if constexpr (alignment > __STDCPP_DEFAULT_NEW_ALIGNMENT__)
            ::operator delete(block, std::align_val_t{alignment});
        else
            ::operator delete(block);
        // The physical allocation is gone before retained releases its grant.
    }

    template<class U> bool operator==(const AdmittedAllocator<U> &other) const noexcept {
        return memory_ == other.memory_;
    }
  private:
    std::shared_ptr<SceneMemory> memory_;
};

template<class T> using AdmittedVector = std::vector<T, AdmittedAllocator<T>>;
} // namespace preview
