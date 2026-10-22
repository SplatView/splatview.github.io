#pragma once
#include <algorithm>
#include <array>
#include <bit>
#include <cstdint>
#include <span>
#include <vector>

namespace preview::detail {
inline uint32_t depthKey(float depth) {
    const auto bits = std::bit_cast<uint32_t>(depth);
    return bits ^ (bits & 0x80000000 ? 0xffffffff : 0x80000000);
}

// Build these histograms during projection's linear CPU walk. All three
// passes preserve equal-depth input order and the full 32-bit float key.
struct DepthHistogram {
    static constexpr unsigned bits = 11, size = 1u << bits, mask = size - 1;
    std::array<std::array<uint32_t, size>, 3> counts{};

    void add(uint32_t key) {
        ++counts[0][key & mask];
        ++counts[1][(key >> bits) & mask];
        ++counts[2][key >> (bits * 2)];
    }

    void sort(std::span<const uint32_t> keys, std::vector<uint32_t> &order, std::vector<uint32_t> &scratch) {
        for (unsigned pass = 0; pass < counts.size(); ++pass) {
            auto &offsets = counts[pass];
            if (std::find(offsets.begin(), offsets.end(), order.size()) != offsets.end())
                continue; // All keys share this digit; retain the stable order.
            uint32_t prefix = 0;
            for (auto &v : offsets) {
                const auto n = v;
                v = prefix;
                prefix += n;
            }
            for (auto i : order)
                scratch[offsets[(keys[i] >> (pass * bits)) & mask]++] = i;
            order.swap(scratch);
        }
    }
};
} // namespace preview::detail
