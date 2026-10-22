#pragma once
#include "model.hpp"
#include <load-spz.h>
#include <coordinate-system-adobe.h>
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace preview::detail {
constexpr uint64_t maxSourceSplats = 10'000'000;
[[noreturn]] inline void fail(const std::string &message) {
    throw std::runtime_error(message);
}
inline void canceled(const LoadOptions &o) {
    if (o.stop.stop_requested())
        fail("Loading canceled");
}
inline void countCheck(uint64_t count) {
    if (!count || count > maxSourceSplats)
        fail("Scene must contain between 1 and 10 million Gaussians");
}
inline float sigmoid(float x) {
    return x >= 0 ? 1 / (1 + std::exp(-x)) : std::exp(x) / (1 + std::exp(x));
}
inline float linearScale(float x) {
    if (!std::isfinite(x))
        fail("Invalid Gaussian log scale");
    const float value = std::exp(x);
    if (!std::isfinite(value) || value <= 0)
        fail("Gaussian log scale exceeds floating-point precision");
    return value; // packGaussian validates that the squared scale remains representable.
}
template <class T> T number(std::span<const uint8_t> data, size_t offset, bool big = false) {
    if (offset > data.size() || sizeof(T) > data.size() - offset)
        fail("Truncated file");
    std::array<uint8_t, sizeof(T)> bytes;
    std::memcpy(bytes.data(), data.data() + offset, sizeof(T));
    if (big)
        std::reverse(bytes.begin(), bytes.end());
    return std::bit_cast<T>(bytes);
}
inline bool selected(uint64_t i, uint64_t n, size_t limit) {
    return n <= limit || (i * limit / n != (i + 1) * limit / n);
}
// Inverse of selected(): visit only the records retained by the preview budget
// while preserving exactly the same uniform sample and source order.
inline size_t sampledIndex(size_t outputIndex, uint64_t sourceCount, size_t loadedCount) {
    return static_cast<size_t>(((outputIndex + 1) * sourceCount - 1) / loadedCount);
}
inline void plyToRub(Attributes &a) {
    static const auto c = spz::coordinateConverter(spz::CoordinateSystem::RDF, spz::CoordinateSystem::RUB, 3);
    a.position.y = -a.position.y;
    a.position.z = -a.position.z;
    for (int i = 0; i < 3; ++i)
        a.quaternion[i + 1] *= c.flipQ[i];
    for (int i = 1; i < 16; ++i)
        for (int channel = 0; channel < 3; ++channel)
            a.sh[i * 3 + channel] *= c.flipSh[i - 1];
}
Scene loadSplat(std::span<const uint8_t> bytes, const LoadOptions &options);
Scene loadKsplat(std::span<const uint8_t> bytes, const LoadOptions &options);
std::optional<Scene> loadBasicPly(std::span<const uint8_t> bytes, const LoadOptions &options);
} // namespace preview::detail
