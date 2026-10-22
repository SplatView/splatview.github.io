#pragma once
#include "model.hpp"

void fusedDecodeContracts(std::span<const uint8_t> fixture, size_t fixtureCount);
void streamingGzipContracts(std::span<const uint8_t> fixture, size_t fixtureCount,
                            const std::filesystem::path &directory);
