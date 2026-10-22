#pragma once
#include "model.hpp"

namespace format_tests {
using Bytes = std::vector<uint8_t>;
Bytes splat(std::span<const preview::Attributes> source);
Bytes ksplat(std::span<const preview::Attributes> source, unsigned compression, unsigned degree);
Bytes compressedPly(std::span<const preview::Attributes> source, bool chunkColors = true, unsigned degree = 3,
                    bool big = false);
} // namespace format_tests
