#pragma once
#include "admitted_storage.hpp"
#include "scene_exports.hpp"
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <memory>
#include <ostream>
#include <span>
#include <streambuf>
#include <vector>

namespace preview::browser_export {
// All desktop export families. SPZ4 has a separate streaming implementation.
bool supported(unsigned format) noexcept;
struct Plan {
    std::size_t outputCapacity{}, maskBytes{}, sortBytes{}, ownerBytes{}, workBytes{};
    std::size_t inputBytes{}, compressedBytes{}, codecBytes{};
    std::size_t paletteBytes{},labelBytes{},pixelBytes{},scratchBytes{};
    friend bool operator==(const Plan &, const Plan &) = default;
};
Plan plan(unsigned format, std::size_t loadedCount, unsigned degree);

class OutputOwner final {
  public:
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(OutputOwner *) noexcept;
    };
    using Pointer = std::unique_ptr<OutputOwner, Deleter>;
    static Pointer create(std::shared_ptr<SceneMemory>, std::size_t capacity);
    static void retire(Pointer &) noexcept;
    ~OutputOwner() noexcept;
    OutputOwner(const OutputOwner &) = delete;
    OutputOwner &operator=(const OutputOwner &) = delete;
    const std::uint8_t *data() const noexcept { return data_; }
    std::uint8_t *data() noexcept { return data_; }
    std::size_t size() const noexcept { return size_; }
    std::size_t capacity() const noexcept { return capacity_; }
    std::size_t retainedBytes() const noexcept;
  private:
    friend class SinkBuffer;
    OutputOwner(std::shared_ptr<SceneMemory>, std::size_t);
    std::shared_ptr<SceneMemory> memory_;
    std::uint8_t *data_{};
    std::size_t capacity_{}, size_{};
};

// The disposable overlay uses this allocator for spatial-order and gzip buffers.
// The unchanged legacy SOG writer can use the same type outside an export scope.
std::shared_ptr<SceneMemory> scratchMemory() noexcept;
template<class T> class ScratchAllocator : public AdmittedAllocator<T> {
  public:
    using value_type = T;
    template<class U> struct rebind { using other = ScratchAllocator<U>; };
    ScratchAllocator() noexcept : AdmittedAllocator<T>(scratchMemory()) {}
    template<class U> ScratchAllocator(const ScratchAllocator<U> &other) noexcept
        : AdmittedAllocator<T>(other.memory()) {}
    ScratchAllocator select_on_container_copy_construction() const noexcept { return *this; }
    template<class U> bool operator==(const ScratchAllocator<U> &other) const noexcept {
        return this->memory() == other.memory();
    }
};
template<class T> using Vector = std::vector<T, ScratchAllocator<T>>;

class SinkBuffer final : public std::streambuf {
  public:
    explicit SinkBuffer(OutputOwner &owner) noexcept : owner_(owner) {}
  protected:
    std::streamsize xsputn(const char *, std::streamsize) override;
    int_type overflow(int_type = traits_type::eof()) override;
    pos_type seekoff(off_type, std::ios_base::seekdir, std::ios_base::openmode) override;
    pos_type seekpos(pos_type, std::ios_base::openmode) override;
  private:
    OutputOwner &owner_;
    std::size_t position_{};
};

// Retains ordinary ostream formatting and seeking, replacing only storage.
// Without an active direct owner it delegates to the old file writer, allowing
// the nonshipping complete-byte oracle and legacy codec dispatch to coexist.
class OutputStream final : public std::ostream {
  public:
    explicit OutputStream(const std::filesystem::path &, std::ios_base::openmode);
    ~OutputStream() override;
    void close();
  private:
    std::unique_ptr<SinkBuffer> sink_;
    std::unique_ptr<std::ofstream> file_;
    bool closed_{};
};
bool directActive() noexcept;
// Synchronous, memory-bounded serialization. This does not promise cooperative
// work quanta or interrupt a running native serializer from another JS task.
OutputOwner::Pointer encode(const Scene &, std::span<const std::uint8_t>, unsigned format,
                            unsigned scope, std::shared_ptr<SceneMemory>, const Plan &);
} // namespace preview::browser_export
