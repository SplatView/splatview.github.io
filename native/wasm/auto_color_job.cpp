#include "auto_color_job.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <utility>

namespace preview::browser_auto_color {
namespace {
constexpr float c0 = .28209479177387814f;
float lum(const std::array<float, 3> &c) noexcept {
    return .299f * c[0] + .587f * c[1] + .114f * c[2];
}
bool overlaps(const void *a, size_t na, const void *b, size_t nb) noexcept {
    if (!na || !nb) return false;
    const auto aa = reinterpret_cast<uintptr_t>(a), bb = reinterpret_cast<uintptr_t>(b);
    return aa <= bb ? bb - aa < na : aa - bb < nb;
}
unsigned digit(float value, unsigned pass) noexcept {
    // The decoded source luminance is finite and nonnegative, so IEEE-754
    // unsigned-key order is exactly the numeric order used by std::sort.
    return (std::bit_cast<uint32_t>(value) >> (pass * 8)) & 255u;
}
} // namespace
Job::Job(std::span<const Gaussian> scene, std::span<const uint8_t> states,
         bool selectedOnly, Scratch scratch) noexcept
    : scene_(scene), states_(states), scratch_(scratch), selected_(selectedOnly) {
    if (scene.size() > sceneLimit || scene.size() != states.size()) {
        fail(Failure::InvalidInput); return;
    }
    const auto required = scratchRequirements(scene.size());
    if (scratch.luminance.size() < required.samples || scratch.temporary.size() < required.samples ||
        scratch.bins.size() < 768) {
        fail(Failure::InsufficientScratch); return;
    }
    scratch_.luminance = scratch_.luminance.first(required.samples);
    scratch_.temporary = scratch_.temporary.first(required.samples);
    scratch_.bins = scratch_.bins.first(768);
    const std::array<const void *, 5> starts{scene.data(), states.data(), scratch_.luminance.data(),
                                           scratch_.temporary.data(), scratch_.bins.data()};
    const std::array<size_t, 5> bytes{scene.size_bytes(), states.size_bytes(), scratch_.luminance.size_bytes(),
                                     scratch_.temporary.size_bytes(), scratch_.bins.size_bytes()};
    for (size_t i = 2; i < starts.size(); ++i)
        for (size_t j = 0; j < i; ++j)
            if (overlaps(starts[i], bytes[i], starts[j], bytes[j])) {
                fail(Failure::AliasedScratch); return;
            }
}
void Job::fail(Failure value) noexcept { failure_ = value; phase_ = Phase::Failed; }
bool Job::pending() const noexcept {
    return phase_ != Phase::Complete && phase_ != Phase::Cancelled && phase_ != Phase::Failed;
}
void Job::cancel() noexcept { if (pending()) phase_ = Phase::Cancelled; }
bool Job::eligible(size_t i) const noexcept {
    return !(states_[i] & 2) && (!selected_ || (states_[i] & 1));
}
bool Job::sourceColor(size_t i, std::array<float, 3> &c) noexcept {
    for (unsigned k = 0; k < 3; ++k) {
        const auto dc = shValue(scene_[i], 0, k);
        if (!std::isfinite(dc)) { fail(Failure::NonfiniteSource); return false; }
        c[k] = std::clamp(dc * c0 + .5f, 0.f, 1.f);
    }
    return true;
}
float Job::percentile(float p) const noexcept {
    // Exact desktop interpolation and precision; quantizing a histogram would
    // change these thresholds and the subsequent inclusive trimmed statistics.
    const double i = std::clamp(double(p), 0., 100.) * .01 * (desired_ - 1);
    const size_t a = size_t(i), b = std::min(a + 1, desired_ - 1);
    return float(sortInput_[a] + (sortInput_[b] - sortInput_[a]) * (i - a));
}
void Job::finish() noexcept {
    result_.eligible = eligibleCount_; result_.samples = desired_; result_.trimmed = trimmed_;
    for (auto &grade : result_.suggestions) grade = neutralColor;
    auto &enhance = result_.suggestions[0];
    auto &exposure = result_.suggestions[1];
    auto &contrast = result_.suggestions[2];
    auto &wb = result_.suggestions[3];
    const float range = result_.p999 - result_.p001;
    if (range > .01f) contrast[1] = std::clamp(.95f / range, .5f, 3.f);
    if (trimmed_ && sum_ / float(trimmed_) > .01f)
        exposure[0] = std::clamp(.45f / (sum_ / float(trimmed_)), .5f, 2.5f);
    if (trimmed_) {
        for (auto &x : average_) x /= float(trimmed_);
        const float target = (average_[0] + average_[1] + average_[2]) / 3;
        std::array<float, 3> gain{};
        for (size_t k = 0; k < gain.size(); ++k)
            gain[k] = std::clamp(target / (average_[k] + 1e-8f), .5f, 2.f);
        wb[5] = std::clamp((gain[0] / gain[2] - 1) * .5f, -1.f, 1.f);
        wb[6] = std::clamp((1 - gain[1] / ((gain[0] + gain[2]) / 2)) * .5f, -1.f, 1.f);
    }
    // strength=1, preserve_warmth=true are the desktop UI defaults.
    const float strength = 1, warmth = .5f;
    enhance[0] = std::clamp(1 + (exposure[0] - 1) * strength, .5f, 2.f);
    enhance[1] = std::clamp(1 + (contrast[1] - 1) * strength * .7f, .7f, 1.5f);
    enhance[5] = wb[5] * strength * warmth;
    enhance[6] = wb[6] * strength * warmth;
    phase_ = Phase::Complete;
}
size_t Job::step(size_t maximumWork) noexcept {
    const auto limit = std::min(maximumWork, maximumStepWork);
    size_t consumed = 0;
    while (consumed < limit && pending()) {
        // Every loop consumes a single bounded item, including phase changes.
        // There is no whole-scene initialization, std::sort, or final scan.
        ++consumed; ++workDone_;
        switch (phase_) {
        case Phase::ZeroBins:
            if (cursor_ < 768) scratch_.bins[cursor_++] = 0;
            else { cursor_ = 0; phase_ = Phase::Count; }
            break;
        case Phase::Count:
            if (cursor_ < scene_.size()) {
                if (states_[cursor_] > 2) { fail(Failure::InvalidInput); break; }
                if (eligible(cursor_)) ++eligibleCount_;
                ++cursor_;
            } else if (!eligibleCount_) fail(selected_ ? Failure::SelectFirst : Failure::NoVisibleSplats);
            else {
                desired_ = std::min(eligibleCount_, sampleLimit);
                sortInput_ = scratch_.luminance.first(desired_);
                sortOutput_ = scratch_.temporary.first(desired_);
                cursor_ = 0; phase_ = Phase::Sample;
            }
            break;
        case Phase::Sample:
            if (next_ == desired_) { cursor_ = 0; phase_ = Phase::ZeroRadix; break; }
            // Desktop size_t is 64-bit. WASM32 must widen this product before
            // multiplication (65535 * 1M exceeds its 32-bit address type).
            if (eligible(cursor_) && ordinal_++ == uint64_t(next_) * eligibleCount_ / desired_) {
                std::array<float, 3> c{};
                if (!sourceColor(cursor_, c)) break;
                sortInput_[next_++] = lum(c);
                for (size_t k = 0; k < c.size(); ++k)
                    scratch_.bins[k * 256 + std::clamp(int(c[k] * 255), 0, 255)]++;
            }
            ++cursor_;
            break;
        case Phase::ZeroRadix:
            if (cursor_ < 256) radix_[cursor_++] = 0;
            else { cursor_ = 0; phase_ = Phase::CountRadix; }
            break;
        case Phase::CountRadix:
            if (cursor_ < desired_) ++radix_[digit(sortInput_[cursor_++], pass_)];
            else { cursor_ = 0; prefix_ = 0; phase_ = Phase::PrefixRadix; }
            break;
        case Phase::PrefixRadix:
            if (cursor_ < 256) {
                const auto count = radix_[cursor_];
                radix_[cursor_++] = prefix_; prefix_ += count;
            } else { cursor_ = 0; phase_ = Phase::ScatterRadix; }
            break;
        case Phase::ScatterRadix:
            if (cursor_ < desired_) {
                const auto x = sortInput_[cursor_++];
                sortOutput_[radix_[digit(x, pass_)]++] = x;
            } else {
                std::swap(sortInput_, sortOutput_); cursor_ = 0;
                phase_ = ++pass_ == 4 ? Phase::Quantiles : Phase::ZeroRadix;
            }
            break;
        case Phase::Quantiles:
            result_.p001 = percentile(.1f); result_.p01 = percentile(1);
            result_.p99 = percentile(99); result_.p999 = percentile(100 - .1f);
            cursor_ = ordinal_ = next_ = 0; phase_ = Phase::Trim;
            break;
        case Phase::Trim:
            if (next_ == desired_) { cursor_ = 0; phase_ = Phase::NormalizeBins; break; }
            if (eligible(cursor_) && ordinal_++ == uint64_t(next_) * eligibleCount_ / desired_) {
                std::array<float, 3> c{};
                if (!sourceColor(cursor_, c)) break;
                const float l = lum(c);
                if (l >= result_.p01 && l <= result_.p99) {
                    sum_ += l; ++trimmed_;
                    for (size_t k = 0; k < c.size(); ++k) average_[k] += c[k];
                }
                ++next_;
            }
            ++cursor_;
            break;
        case Phase::NormalizeBins:
            if (cursor_ < 768) scratch_.bins[cursor_++] /= float(desired_);
            else phase_ = Phase::Finish;
            break;
        case Phase::Finish: finish(); break;
        default: break;
        }
    }
    return consumed;
}
ColorValues mergeSuggestion(const ColorValues &current, const ColorValues &suggested, Method method) noexcept {
    auto values = current;
    for (size_t k = 0; k < values.size(); ++k) {
        const bool adjust = ((method == Method::Enhance || method == Method::Exposure) && k == 0) ||
                            ((method == Method::Enhance || method == Method::Contrast) && k == 1) ||
                            ((method == Method::Enhance || method == Method::WhiteBalance) && (k == 5 || k == 6));
        if (adjust) values[k] = suggested[k];
    }
    return values;
}
} // namespace preview::browser_auto_color
