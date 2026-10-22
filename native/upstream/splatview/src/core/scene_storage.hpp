#pragma once
#include <cstddef>
#include <limits>
#include <memory>
#include <new>
#include <type_traits>
#include <utility>
#include <vector>

namespace preview {
// Dependency-neutral storage admission. The scene target has no knowledge of
// budgets, categories, host services or threads. A service admits the requested
// physical payload BEFORE allocation and returns its lifetime-owning grant.
class SceneMemory {
  public:
    virtual ~SceneMemory() = default;
    virtual std::shared_ptr<void> admit(std::size_t bytes) = 0;
};

template<class T, class Payload = T> class SceneAllocator {
    template<class, class> friend class SceneAllocator;
    struct Header { std::shared_ptr<void> grant; };
    static constexpr std::size_t offset = ((sizeof(Header) + alignof(T) - 1) / alignof(T)) * alignof(T);
    static constexpr std::size_t alignment = alignof(T) > alignof(Header) ? alignof(T) : alignof(Header);
  public:
    using value_type = T;
    using propagate_on_container_copy_assignment = std::true_type;
    using propagate_on_container_move_assignment = std::true_type;
    using propagate_on_container_swap = std::true_type;
    using is_always_equal = std::false_type;
    // Keep the original payload type when a container rebinds its allocator
    // for internal bookkeeping. In particular, MSVC debug-vector proxies are
    // swapped into a moved-from vector whose allocator no longer has a service.
    // Their allocation/deallocation must therefore use the same untracked path.
    template<class U> struct rebind { using other = SceneAllocator<U, Payload>; };
    SceneAllocator() = default;
    explicit SceneAllocator(std::shared_ptr<SceneMemory> memory) noexcept : memory_(std::move(memory)) {}
    template<class U> SceneAllocator(const SceneAllocator<U, Payload> &other) noexcept : memory_(other.memory()) {}
    const std::shared_ptr<SceneMemory> &memory() const noexcept { return memory_; }
    SceneAllocator select_on_container_copy_construction() const noexcept { return *this; }
    T *allocate(std::size_t count) {
        if constexpr (!std::is_same_v<T, Payload>) {
            return std::allocator<T>{}.allocate(count);
        } else {
            if(count > (std::numeric_limits<std::size_t>::max() - offset) / sizeof(T))
                throw std::bad_array_new_length();
            if(!memory_) return std::allocator<T>{}.allocate(count);
            const auto bytes=count*sizeof(T);
            auto grant=memory_->admit(bytes);
            // Envelope/control-block overhead is not payload and is not included
            // in the admission amount. Over-aligned types retain matching delete.
            void *block;
            if constexpr(alignment > __STDCPP_DEFAULT_NEW_ALIGNMENT__)
                block=::operator new(offset+bytes,std::align_val_t{alignment});
            else block=::operator new(offset+bytes);
            std::construct_at(static_cast<Header *>(block),Header{std::move(grant)});
            return reinterpret_cast<T *>(static_cast<std::byte *>(block)+offset);
        }
    }
    void deallocate(T *data,std::size_t count) noexcept {
        if constexpr (!std::is_same_v<T, Payload>) {
            std::allocator<T>{}.deallocate(data,count);
        } else {
            if(!memory_) { std::allocator<T>{}.deallocate(data,count); return; }
            auto block=reinterpret_cast<std::byte *>(data)-offset;
            auto header=reinterpret_cast<Header *>(block);
            auto retained=std::move(header->grant);
            std::destroy_at(header);
            if constexpr(alignment > __STDCPP_DEFAULT_NEW_ALIGNMENT__)
                ::operator delete(block,std::align_val_t{alignment});
            else ::operator delete(block);
            // retained releases only after the physical block is freed.
        }
    }
    template<class U> bool operator==(const SceneAllocator<U, Payload> &other) const noexcept { return memory_==other.memory(); }
  private:
    std::shared_ptr<SceneMemory> memory_;
};
template<class T> using SceneVector = std::vector<T,SceneAllocator<T>>;
} // namespace preview
