#pragma once
#include "editing.hpp"

namespace preview {
// Map pixels may be lower resolution than viewport pixels. Depths contain
// positive, alpha-normalized view distance; interpolate only on one surface.
std::optional<VolumeSample> volumeSampleAt(const Camera &,const SelectionMap &,
    unsigned viewportWidth,unsigned viewportHeight,PointI,float radiusPixels);
SceneVector<VolumeSample> volumeStrokeSamples(const Camera &,const SelectionMap &,
    unsigned viewportWidth,unsigned viewportHeight,std::span<const PointI>,float radiusPixels,
    std::stop_token = {},std::shared_ptr<SceneMemory> scratch = {});
} // namespace preview
