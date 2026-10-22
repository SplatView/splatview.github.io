#pragma once
#include <cstddef>

namespace preview {
enum class ToolsMode { Basic, Pro };
constexpr bool basicColorField(size_t index) {
    return index == 0 || index == 1 || index == 3 || index == 5;
}
} // namespace preview
