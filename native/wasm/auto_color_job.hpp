#pragma once
#include "color.hpp"
#include "scene.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>

// Browser adaptation of SplatView source-DC automatic color statistics.
// Desktop formulas: captured processing.cpp:500-587,649-772 and the portable
// processing.cpp. This bounded analyzer never reads rendered histogram pixels.
namespace preview::browser_auto_color {
static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559);
inline constexpr size_t sampleLimit = 65536, sceneLimit = 1'000'000, maximumStepWork = 4096;
enum class Method : uint8_t { Enhance, Exposure, Contrast, WhiteBalance };
enum class Phase : uint8_t {
    ZeroBins, Count, Sample, ZeroRadix, CountRadix, PrefixRadix, ScatterRadix,
    Quantiles, Trim, NormalizeBins, Finish, Complete, Cancelled, Failed
};
enum class Failure : uint8_t { None, InvalidInput, InsufficientScratch, AliasedScratch,
    SelectFirst, NoVisibleSplats, NonfiniteSource };
struct Requirements { size_t samples{}, payloadBytes{}; };
constexpr Requirements scratchRequirements(size_t sceneCount) noexcept {
    const auto n = sceneCount < sampleLimit ? sceneCount : sampleLimit;
    return {n, 2 * n * sizeof(float) + 3 * 256 * sizeof(float)};
}
struct Scratch {
    std::span<float> luminance, temporary;
    // Source DC histogram: three channel-major 256-bin float arrays.
    // Its normalization and truncating bin selection match desktop processing.
    std::span<float> bins;
};
struct Result {
    std::array<ColorValues, 4> suggestions{}; // UI order: Auto, Exposure, Contrast, White balance.
    size_t eligible{}, samples{}, trimmed{};
    float p001{}, p01{}, p99{}, p999{};
};
// Caller admits every payload and this stable job owner BEFORE allocation, then
// holds the scene/mask immutable until completion or cancellation. No path,
// framebuffer, JSON, hidden heap payload, or scene mutation occurs in this job.
class Job {
  public:
    Job(std::span<const Gaussian>, std::span<const uint8_t>, bool selectedOnly, Scratch) noexcept;
    size_t step(size_t maximumWork = maximumStepWork) noexcept;
    void cancel() noexcept;
    bool pending() const noexcept;
    Phase phase() const noexcept { return phase_; }
    Failure failure() const noexcept { return failure_; }
    const Result *result() const noexcept { return phase_ == Phase::Complete ? &result_ : nullptr; }
    size_t workDone() const noexcept { return workDone_; }
  private:
    void fail(Failure) noexcept;
    bool eligible(size_t) const noexcept;
    bool sourceColor(size_t, std::array<float, 3> &) noexcept;
    float percentile(float) const noexcept;
    void finish() noexcept;
    std::span<const Gaussian> scene_;
    std::span<const uint8_t> states_;
    Scratch scratch_;
    std::span<float> sortInput_, sortOutput_;
    std::array<uint32_t, 256> radix_{};
    Result result_{};
    Phase phase_{Phase::ZeroBins};
    Failure failure_{Failure::None};
    bool selected_{};
    size_t cursor_{}, eligibleCount_{}, desired_{}, ordinal_{}, next_{}, trimmed_{};
    size_t workDone_{};
    unsigned pass_{};
    uint32_t prefix_{};
    float sum_{};
    std::array<float, 3> average_{};
};
// Exact desktop field ownership; every other current slider value is retained.
ColorValues mergeSuggestion(const ColorValues &current, const ColorValues &suggested, Method) noexcept;
#if defined(__wasm32__)
// Measured by the promoted-source standalone WASM contracts; admission must
// not silently retain a stale owner-layout estimate after a future edit.
static_assert(sizeof(Job) == 1404);
#endif
} // namespace preview::browser_auto_color
