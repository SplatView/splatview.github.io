#pragma once
#include "selection_checkpoint.hpp"
#include "selection_map.hpp"
#include "surface_selection.hpp"

namespace preview {
inline SelectionMap borrowedSelectionMap(const BrowserSelectionMap &source) noexcept {
    return {source.header.mapWidth,source.header.mapHeight,{},source.depths,source.visible,source.opacities};
}
} // namespace preview
