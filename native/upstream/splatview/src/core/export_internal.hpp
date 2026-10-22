#pragma once
#include "scene_exports.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview::detail {
inline void checkSaveStop(std::stop_token stop) {
    if (stop.stop_requested())
        throw std::runtime_error("Scene save cancelled");
}
template <class Function>
void forVisible(const Scene &scene, std::span<const uint8_t> states, std::stop_token stop, Function action) {
    for (size_t i = 0; i < scene.gaussians.size(); ++i) {
        if ((i & 4095) == 0)
            checkSaveStop(stop);
        if (states.empty() || !(states[i] & 2))
            action(scene.gaussians[i], uint32_t(i));
    }
}
inline uint32_t unorm(double value, unsigned bits) {
    const auto limit = (1u << bits) - 1;
    return uint32_t(std::clamp(std::floor(value * limit + .5), 0., double(limit)));
}
inline double normalized(float value, float low, float high) {
    return high == low ? 0 : (double(value) - low) / (double(high) - low);
}
// A single 8-byte key/index per visible splat; no expanded attribute matrix.
std::vector<uint64_t> spatialOrder(const Scene &, std::span<const uint8_t>, std::stop_token);
void sortSpatialOrder(std::vector<uint64_t> &, std::stop_token);
void writeCompressedPly(const Scene &, std::span<const uint8_t>, const std::filesystem::path &, uint32_t,
                        std::stop_token);
void writeKsplat(const Scene &, std::span<const uint8_t>, const std::filesystem::path &, uint32_t,
                 std::stop_token);
void writeCsv(const Scene &, std::span<const uint8_t>, const std::filesystem::path &, std::stop_token);
void writeSog(const Scene &, std::span<const uint8_t>, const std::filesystem::path &, uint32_t, bool legacy,
              std::stop_token);
} // namespace preview::detail
