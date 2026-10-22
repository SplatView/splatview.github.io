#pragma once
#include "camera.hpp"
#include "color.hpp"
#include "admitted_storage.hpp"
#include <memory>

namespace preview {
struct SelectionPreview {
    Matrix4 worldToLocal{identityMatrix};
    std::array<float, 4> limits{};
    unsigned shape{}, operation{};
    bool operator==(const SelectionPreview &) const = default;
};
struct ViewSettings {
    bool highlightSelection{true}, colorPreviewCoverage{};
    ColorValues color{neutralColor};
    bool colorSelectedOnly{};
    Matrix4 geometry{identityMatrix};
    bool geometrySelectedOnly{};
    SelectionPreview selection;
    bool operator==(const ViewSettings &) const = default;
};
struct Image {
    unsigned width{}, height{};
    // Copies inherit their allocation service and admit independent capacity;
    // moves preserve physical ownership. Default images remain unbudgeted.
    AdmittedVector<uint8_t> bgra;
};
struct SelectionMap {
    unsigned width{}, height{};
    SceneVector<uint32_t> ids;
    SceneVector<float> depths;
    SceneVector<uint32_t> visible;
};
using RgbHistogram = std::array<std::array<uint32_t, 256>, 3>;
} // namespace preview
