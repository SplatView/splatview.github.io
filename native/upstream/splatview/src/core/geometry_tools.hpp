#pragma once
#include "scene.hpp"
#include "recipe.hpp"
#include <memory>
#include <span>
#include <stop_token>

namespace preview {
struct FloorPlane {
    Vec3 normal{}, center{};
    float radius{}, rms{};
    size_t inliers{}, tested{};
};
struct FloorOptions {
    float threshold{}; // Zero chooses a tolerance from the sampled geometry, independently of scene units.
    unsigned iterations{1000}, samples{50000};
    std::optional<Vec3> viewpoint; // Orient the detected up side toward the viewing camera when available.
};
float pointDistance(Vec3, Vec3);
float pointAngle(Vec3 a, Vec3 vertex, Vec3 b); // Degrees; rejects coincident points.
Matrix4 centerAtPoint(Vec3);
Matrix4 scaleFromPoints(Vec3, Vec3, float targetDistance);
Matrix4 alignFromPoints(Vec3, Vec3, Vec3, bool flip = false);
Matrix4 alignFloor(const FloorPlane &, bool flip = false);
Recipe matrixRecipe(const Matrix4 &);
std::optional<FloorPlane> detectFloor(const Scene &, std::span<const uint8_t>, bool selectedOnly,
                                      FloorOptions = {}, std::stop_token = {},
                                      std::shared_ptr<SceneMemory> scratch = {});
} // namespace preview
