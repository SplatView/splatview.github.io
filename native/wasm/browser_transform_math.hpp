#pragma once
#include "processing_kernels.hpp"
#include <array>
#include <cstddef>
#include <cstdint>

namespace preview::browser_transform {
enum class Mode:uint8_t { Euler,Quaternion,AxisAngle,Matrix };
struct Parameters {
    Mode mode{Mode::Euler};
    std::array<float,3> translation{},scale{1,1,1},pivot{},euler{},axis{0,0,1};
    std::array<float,4> quaternion{1,0,0,0};
    float angle{};
    Matrix4 matrix{identityMatrix}; // User-facing row-major; translation3/7/11.
    std::array<bool,3> flips{};
    bool operator==(const Parameters &) const noexcept=default;
};
struct Plan {
    std::array<processing_detail::Affine,4> steps;
    size_t count{1};
    Matrix4 matrix{identityMatrix}; // GPU/internal; translation12/13/14.
};
inline constexpr size_t composeInputFloats=40;
using ComposeInput=std::array<float,composeInputFloats>;
// Fixed input: mode0,translation1..3,scale4..6,pivot7..9,euler10..12,
// quaternion-wxyz13..16,axis17..19,angleDegrees20,row-major-matrix21..36,
// flips37..39. No allocation; refused calls leave their output intact.
bool plan(const Parameters &,Plan &) noexcept;
bool compose(const ComposeInput &,Matrix4 &) noexcept;
bool identity(const Plan &) noexcept;
bool same(const Plan &,const Plan &) noexcept;
} // namespace preview::browser_transform
