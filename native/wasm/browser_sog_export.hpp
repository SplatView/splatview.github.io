#pragma once
#include "browser_export_sink.hpp"
#include "export_internal.hpp"
#include <nlohmann/json.hpp>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <map>
#include <memory>
#include <string>

namespace preview::browser_sog {
struct Bounds {
    std::size_t output{}, pixels{}, palette{}, labels{}, scratch{}, codec{};
};
Bounds bounds(std::size_t loadedCount,unsigned degree);
struct Statistics { std::size_t peakCodecBytes{},codecAllocations{},textures{},metadataAllocations{},codecRefusals{},metadataRefusals{}; };
Statistics lastStatistics() noexcept;
class Operation final {
  public:
    explicit Operation(std::size_t codecLimit);
    ~Operation() noexcept;
    Operation(const Operation &)=delete;
    Operation &operator=(const Operation &)=delete;
    std::size_t limit{};
    Statistics statistics;
};
class TextureMemory final {
  public:
    TextureMemory();
    TextureMemory(std::shared_ptr<SceneMemory>,std::size_t codecLimit);
    ~TextureMemory() noexcept;
    void rethrowFailure() const;
    std::size_t retainedBytes() const noexcept { return live_; }
  private:
    friend void *allocateWebp(std::uint64_t,std::size_t,bool) noexcept;
    friend void freeWebp(void *) noexcept;
    struct alignas(std::max_align_t) Header {
        TextureMemory *owner;
        std::size_t bytes;
        std::shared_ptr<void> grant;
    };
    std::shared_ptr<SceneMemory> memory_;
    std::size_t live_{},limit_{};
    std::exception_ptr failure_;
};
void *allocateWebp(std::uint64_t,std::size_t,bool) noexcept;
void freeWebp(void *) noexcept;

template<class T> class MetadataAllocator : public browser_export::ScratchAllocator<T> {
  public:
    using value_type=T;
    template<class U> struct rebind { using other=MetadataAllocator<U>; };
    MetadataAllocator() noexcept=default;
    template<class U> MetadataAllocator(const MetadataAllocator<U> &other) noexcept
        : browser_export::ScratchAllocator<T>(other) {}
    MetadataAllocator select_on_container_copy_construction() const noexcept { return *this; }
    T *allocate(std::size_t count);
};
void noteMetadataAllocation() noexcept;
void noteMetadataRefusal() noexcept;
template<class T> T *MetadataAllocator<T>::allocate(std::size_t count) {
    noteMetadataAllocation();
    try{return browser_export::ScratchAllocator<T>::allocate(count);}
    catch(...){noteMetadataRefusal();throw;}
}
using String=std::basic_string<char,std::char_traits<char>,MetadataAllocator<char>>;
using Json=nlohmann::basic_json<std::map,std::vector,String,bool,std::int64_t,std::uint64_t,double,MetadataAllocator>;

// The sole mutable builder is the reviewed literal-key desktop writeSog body.
// No parser or caller can acquire its cleanup authority or borrow its DOM.
// Every constructed subtree/temporary has depth <=4 and at most three arrays
// of 256 numeric values. Recursive destruction needs no flattening allocation.
class MetadataOwner final {
    friend void ::preview::detail::writeSog(const Scene &,std::span<const std::uint8_t>,
        const std::filesystem::path &,std::uint32_t,bool,std::stop_token);
    class Authority final {
      public: Authority() noexcept;~Authority() noexcept;
      private: bool previous_{};
    } authority_;
    Json dom_;
    MetadataOwner()=default;
    Json &value() noexcept { return dom_; }
    String dump() const;
};
} // namespace preview::browser_sog
// Read-only, specialization-checked generated-header hook. This cannot activate
// the authority and never authorizes ordinary or parsed nlohmann::json.
bool sv_sog_export_metadata_cleanup_active() noexcept;
