#pragma once
#include "scene_storage.hpp"
#include <memory>

namespace preview {
// Explicit allocation services, independent of graphics APIs and budget types.
// A worker's packet/sort storage, temporary analysis/raster storage and returned
// pixels have distinct owners/categories. Empty services preserve compatibility;
// a Work service never implicitly grants Render or Image storage.
struct RenderStorage {
    std::shared_ptr<SceneMemory> packets;
    std::shared_ptr<SceneMemory> work;
    std::shared_ptr<SceneMemory> image;
};
} // namespace preview
