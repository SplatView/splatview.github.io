#pragma once
#include "auto_color_job.hpp"
#include "admitted_raw_array.hpp"
#include "mask_storage.hpp"
#include <memory>
#include <optional>

namespace preview::browser_auto_color {
// Values are host-assigned opaque identities, never pointers serialized to JS.
// Content revision may return to an earlier value after Undo; session/base and
// request generation must therefore be monotonic rather than derived from it.
struct AnalysisKey {
    uint64_t documentId{}, sourceGeneration{}, contentRevision{}, selectionRevision{};
    uint64_t colorSessionId{}, colorBaseId{}, colorBaseContentRevision{}, requestGeneration{};
    bool selectedOnly{};
    bool operator==(const AnalysisKey &) const noexcept = default;
};
struct AnalysisSnapshot {
    std::shared_ptr<const Scene> base;
    MaskStorage states;
    AnalysisKey key;
    bool settled{}; // The native caller must have fenced drafts/gestures/picks.
};
// Fixed-size typed payload, not an unbounded JSON object. Serialization is a
// separate bridge task; this owner does not itself serialize a response.
struct AnalysisResult {
    AnalysisKey key;
    std::array<ColorValues, 4> suggestions;
    uint32_t eligible{}, samples{}, trimmed{};
    std::array<float, 4> percentiles{};
};
enum class AnalysisStatus : uint8_t { Pending, Complete, Cancelled, Stale, Failed };

class AnalysisOwner final {
    struct ScratchOwner {
        AdmittedRawArray<float> luminance, temporary, bins;
        ScratchOwner(std::shared_ptr<SceneMemory> memory, Requirements required)
            : luminance(memory, required.samples), temporary(memory, required.samples),
              bins(std::move(memory), 768) {}
        Scratch spans() noexcept { return {luminance.span(), temporary.span(), bins.span()}; }
    };
  public:
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(AnalysisOwner *) noexcept;
    };
    using Pointer = std::unique_ptr<AnalysisOwner, Deleter>;
    static Pointer create(AnalysisSnapshot, std::shared_ptr<SceneMemory> workMemory);
    static size_t payloadBytes(size_t sceneCount) noexcept;
    // reset() alone retains a unique_ptr's stateful deleter. Explicit retirement
    // also releases its admission-service reference after physical destruction.
    static void retire(Pointer &) noexcept;
    ~AnalysisOwner() noexcept = default;
    AnalysisOwner(const AnalysisOwner &) = delete;
    AnalysisOwner &operator=(const AnalysisOwner &) = delete;
    AnalysisOwner(AnalysisOwner &&) = delete;
    AnalysisOwner &operator=(AnalysisOwner &&) = delete;

    const AnalysisSnapshot &baseline() const noexcept { return baseline_; }
    bool current(const AnalysisSnapshot &) const noexcept;
    size_t step(size_t maximumWork, const AnalysisSnapshot &current) noexcept;
    void cancel() noexcept;
    bool pending() const noexcept { return status_ == AnalysisStatus::Pending; }
    AnalysisStatus status() const noexcept { return status_; }
    Failure failure() const noexcept { return algorithm_->failure(); }
    size_t workDone() const noexcept { return algorithm_->workDone(); }
    double progress() const noexcept;
    const AnalysisResult *result(const AnalysisSnapshot &current) const noexcept;
    std::optional<std::array<float, 3>> sourceDc(size_t index) const noexcept;
  private:
    AnalysisOwner(AnalysisSnapshot, std::shared_ptr<SceneMemory>);
    // Destruction order matters: the borrowed algorithm dies before its arrays
    // and the shared immutable baseline scene/mask.
    AnalysisSnapshot baseline_;
    ScratchOwner scratch_;
    std::optional<Job> algorithm_;
    std::optional<AnalysisResult> completed_;
    AnalysisStatus status_{AnalysisStatus::Pending};
};
#if defined(__wasm32__)
static_assert(sizeof(AnalysisOwner) == 1912);
static_assert(sizeof(AnalysisResult) == 344);
#endif
} // namespace preview::browser_auto_color
