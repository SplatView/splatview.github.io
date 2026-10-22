#pragma once
#include "mask_storage.hpp"
#include "scene.hpp"
#include <cstddef>
#include <cstdint>
#include <memory>

namespace preview::browser_spz_export {
// Browser adaptation of the frozen Windows 0.12.116 SPZ v4 contract:
// reference/targets/windows-r0-20261012-02/source/src/scene_exports.cpp
// (SpzV4Output and packSpzAttributes). The locked source is never modified.
// These are physical admitted payload bounds, excluding allocator/grant
// envelopes and exception storage. Existing scene/mask references add no copy.
struct Plan {
    std::size_t outputCapacity{}, inputBytes{}, codecBytes{}, ownerBytes{}, workBytes{};
    friend bool operator==(const Plan &, const Plan &) = default;
};
// Checked O(1) planning for one-million loaded records and retained SH0..3.
// Throws for unsupported count/degree, overflow or an invalid Zstd estimate.
Plan plan(std::size_t loadedCount, unsigned degree);

enum class Status { Working, Ready, Cancelled };
enum class Phase { Count, Allocate, Header, BeginStream, Pack, Compress, Toc, Ready, Cancelled };
struct Progress {
    std::uint64_t actions{}, sourcesScanned{}, packedBytes{}, compressedBytes{};
    std::size_t lastStepWork{}, lastStepCodecInputBytes{}, lastStepCodecOutputBytes{};
};

class OutputOwner final {
  public:
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(OutputOwner *) noexcept;
    };
    using Pointer = std::unique_ptr<OutputOwner, Deleter>;
    static void retire(Pointer &) noexcept;
    ~OutputOwner() noexcept;
    OutputOwner(const OutputOwner &) = delete;
    OutputOwner &operator=(const OutputOwner &) = delete;
    const std::uint8_t *data() const noexcept { return data_; }
    std::size_t size() const noexcept { return size_; }
    std::size_t capacity() const noexcept { return capacity_; }
    std::size_t retainedBytes() const noexcept;
  private:
    friend class Job;
    OutputOwner(std::shared_ptr<SceneMemory>, std::size_t);
    static Pointer create(std::shared_ptr<SceneMemory>, std::size_t);
    std::shared_ptr<SceneMemory> memory_;
    std::uint8_t *data_{};
    std::size_t capacity_{}, size_{};
};

class Job final {
  public:
    static constexpr std::size_t maximumSources = 1'000'000;
    static constexpr std::size_t maximumInputBytes = 1024 * 1024;
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(Job *) noexcept;
    };
    using Pointer = std::unique_ptr<Job, Deleter>;
    // O(1) capture and admitted control objects only. No source scan, mask
    // clone, codec initialization, payload allocation or output zero-fill.
    static Pointer create(std::shared_ptr<const Scene>, MaskStorage, unsigned scope,
                          std::shared_ptr<SceneMemory>);
    static Pointer create(std::shared_ptr<const Scene>, MaskStorage, unsigned scope,
                          std::shared_ptr<SceneMemory>, const Plan &);
    static void retire(Pointer &) noexcept;
    ~Job() noexcept;
    Job(const Job &) = delete;
    Job &operator=(const Job &) = delete;
    // Work counts source visits, fixed-size geometry/quantization kernels and
    // emitted bytes. At most one codec invocation runs per step, with offered
    // input/output bounded by min(maxWork, 65536). Zstd's fixed-size internal
    // block kernel is indivisible; there is no loop draining a whole frame.
    // Allocation admits uninitialized storage; it performs no payload scan.
    Status step(std::size_t maxWork);
    void cancel() noexcept;
    Status status() const noexcept;
    bool complete() const noexcept { return status() == Status::Ready; }
    Phase phase() const noexcept;
    const Progress &progress() const noexcept;
    double fraction() const noexcept;
    const Plan &bounds() const noexcept;
    std::size_t retainedBytes() const noexcept;
    std::size_t visibleCount() const noexcept;
    const std::shared_ptr<const Scene> &sceneOwner() const noexcept;
    const MaskStorage &maskOwner() const noexcept;
    unsigned scope() const noexcept;
    // Transfers the complete private output after Ready. Scratch/context are
    // already retired, and this call never publishes or mutates a document.
    OutputOwner::Pointer takeOutput();
  private:
    friend Plan plan(std::size_t, unsigned);
    struct State;
    Job(std::shared_ptr<const Scene>, MaskStorage, unsigned, std::shared_ptr<SceneMemory>, const Plan &);
    std::shared_ptr<SceneMemory> memory_;
    State *state_{};
};
} // namespace preview::browser_spz_export
