#pragma once
#include "scene.hpp"
#include <cstdint>
#include <optional>
#include <type_traits>

namespace preview { enum class SelectOperation; }
namespace preview::browser_selection_range {
// Inert per-click/per-amendment values, copied with the existing tolerance
// owner. No Scene, mask, map, admission owner, or per-Gaussian cache is retained.
struct Config {
    bool enabled{};
    std::optional<float> radius;
    std::optional<Vec3> center;
    bool operator==(const Config &) const = default;
};
static_assert(std::is_trivially_copyable_v<Config>);
static_assert(std::is_nothrow_copy_constructible_v<Config> && std::is_nothrow_copy_assignable_v<Config>);
static_assert(std::is_nothrow_move_constructible_v<Config> && std::is_nothrow_move_assignable_v<Config>);
static_assert(sizeof(Config)<=32);

// Call before preparing/publishing an ordinary candidate. Any configured radius
// is positive finite float32; disabled legacy requests may retain null. A supplied center is always finite;
// enabled Range also requires that the frozen center exists.
bool valid(const Config &) noexcept;

// Exact desktop center-only predicate: accumulate squared coordinate deltas in
// double, then round both distance and squared radius to float32. Exclude
// nonfinite rounded distances; include the rounded boundary. Covariance, SH,
// opacity, camera and current-view scope do not enter this predicate.
// An invalid config fails closed. Disabled valid Range passes every point.
bool contains(const Config &,const Gaussian &) noexcept;

// Intersect the ordinary region hit with Range BEFORE applying one Combine to
// the immutable originating checkpoint state. Deleted bytes remain unchanged.
// Add/Remove preserve baseline selection outside Range. Caller independently
// applies its captured current-view clipping to visible results afterwards.
// Ordinary callers validate baseline states0/1/2 and operation0..3 first.
uint8_t combineState(uint8_t baseline,bool regionHit,const Gaussian &,const Config &,SelectOperation) noexcept;
} // namespace preview::browser_selection_range
