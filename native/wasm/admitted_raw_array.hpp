#pragma once
#include "admitted_storage.hpp"
#include <new>
#include <span>
#include <stdexcept>
#include <type_traits>

namespace preview {
// Only POD work arrays use this owner. The exact physical payload is admitted
// through the normal allocator BEFORE allocation. The disposable browser
// allocator overlay consequently retains the exact existing census hooks.
template<class T> class AdmittedRawArray final {
    static_assert(std::is_trivially_default_constructible_v<T> && std::is_trivially_destructible_v<T>);
  public:
    AdmittedRawArray(std::shared_ptr<SceneMemory> memory,size_t count)
        : allocator_(std::move(memory)),count_(count) {
        if(!allocator_.memory()) throw std::invalid_argument("Morphology scratch requires an admission service");
        if(count_) {
            data_=allocator_.allocate(count_);
            // Nonallocating placement array new has no array cookie. Default
            // initialization of these trivial PODs performs no zero fill or
            // per-element work. The job writes each element before reading it.
            ::new (static_cast<void *>(data_)) T[count_];
        }
    }
    ~AdmittedRawArray() noexcept { if(data_) allocator_.deallocate(data_,count_); }
    AdmittedRawArray(const AdmittedRawArray &)=delete;
    AdmittedRawArray &operator=(const AdmittedRawArray &)=delete;
    std::span<T> span() noexcept { return {data_,count_}; }
    std::span<const T> span() const noexcept { return {data_,count_}; }
  private:
    AdmittedAllocator<T> allocator_;
    T *data_{};
    size_t count_{};
};
} // namespace preview
