#pragma once
#include <array>

namespace preview {
struct ColorField {
    const char *name, *label;
    float low, high, neutral;
};
inline constexpr ColorField colorFields[] = {{"brightness", "Brightness", 0, 5, 1},
                                             {"contrast", "Contrast", 0, 5, 1},
                                             {"gamma", "Gamma", .1f, 5, 1},
                                             {"saturation", "Saturation", 0, 5, 1},
                                             {"vibrance", "Vibrance", 0, 5, 1},
                                             {"temperature", "Temperature", -1, 1, 0},
                                             {"tint", "Tint", -1, 1, 0},
                                             {"shadows", "Shadows", -1, 1, 0},
                                             {"highlights", "Highlights", -1, 1, 0},
                                             {"fade", "Fade", 0, 1, 0},
                                             {"shadow_tint_hue", "Shadow hue", -180, 180, 0},
                                             {"shadow_tint_sat", "Shadow tint", 0, 1, 0},
                                             {"highlight_tint_hue", "Highlight hue", -180, 180, 0},
                                             {"highlight_tint_sat", "Highlight tint", 0, 1, 0},
                                             {"hue_shift", "Hue shift", -180, 180, 0}};
using ColorValues = std::array<float, 15>;
inline constexpr ColorValues neutralColor{1, 1, 1, 1, 1};
} // namespace preview
