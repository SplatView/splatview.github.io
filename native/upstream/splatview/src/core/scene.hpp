#pragma once
#include "scene_storage.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace preview {
using Matrix4 = std::array<float, 16>; // DirectX row-vector layout / ImGuizmo column-vector storage.
inline constexpr Matrix4 identityMatrix{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
constexpr float maxShCoefficient = 65504.f; // Largest finite half float, shared by loading and editing.
struct Vec3 {
    float x{}, y{}, z{};
    bool operator==(const Vec3 &) const = default;
};
struct SavedView {
    Vec3 target{};
    float yaw{}, pitch{}, distance{3}, fieldOfView{45};
    bool yUp{};
    float roll{};
    bool operator==(const SavedView &) const = default;
};
// CPU/editing representation. SH0..SH3 use 48 half floats; GPU uploads omit
// covariance padding and SH bands absent from the scene without requantizing.
struct Gaussian {
    std::array<float, 4> positionOpacity{};
    std::array<float, 4> covA{}; // xx, xy, xz, yy
    std::array<float, 4> covB{}; // yz, zz, reserved, reserved
    std::array<uint32_t, 24> sh{};
};
static_assert(sizeof(Gaussian) == 144);
struct Attributes {
    Vec3 position{};
    Vec3 scale{0.01f, 0.01f, 0.01f};
    std::array<float, 4> quaternion{1, 0, 0, 0}; // w,x,y,z
    float opacity{1};
    std::array<float, 48> sh{}; // coefficient-major RGB
};
enum class SceneType { GaussianSplats, PointCloud, Mesh };
struct PreviewVertex {
    Vec3 position;
    uint32_t color{0xffc8c8c8}; // RGBA8, opaque when the PLY has no vertex colors.
};
static_assert(sizeof(PreviewVertex) == 16);
struct Scene {
    Scene() = default;
    explicit Scene(const std::shared_ptr<SceneMemory> &memory)
        : gaussians(SceneAllocator<Gaussian>{memory}),vertices(SceneAllocator<PreviewVertex>{memory}),
          triangles(SceneAllocator<std::array<uint32_t,3>>{memory}) {}
    SceneVector<Gaussian> gaussians;
    SceneType type{SceneType::GaussianSplats};
    SceneVector<PreviewVertex> vertices;
    SceneVector<std::array<uint32_t, 3>> triangles;
    uint64_t sourceFaces{};
    bool sampledGeometry{};
    bool isGaussian() const { return type == SceneType::GaussianSplats; }
    std::size_t loadedCount() const { return isGaussian() ? gaussians.size() : vertices.size(); }
    Vec3 center{};
    float radius{1};
    std::optional<Vec3> previewEye;
    std::optional<SavedView> defaultView;
    // Alignment coordinates let cameras follow scene revisions through Undo/Redo.
    Matrix4 alignmentFrame{identityMatrix};
    uint64_t sourceCount{};
    unsigned shDegree{};
    bool yUp{false};
    std::string format;
    // Opaque identity values supplied by a host/codec for safe preference saves.
    // The scene target performs no path access or fingerprint I/O.
    std::string sourceContentKey, sourceFileIdentity;
    uint64_t sourceBytes{};
};
std::size_t previewSplatBudget(unsigned width, unsigned height);
std::size_t thumbnailSplatBudget(unsigned size);
Gaussian packGaussian(const Attributes &attributes);
float shValue(const Gaussian &gaussian, unsigned coefficient, unsigned channel);
// Scratch admission is supplied by the caller; the scene target does not know
// resource categories. Bounds publish together after all scratch work succeeds.
void fitBounds(Scene &scene);
void fitBounds(Scene &scene, std::shared_ptr<SceneMemory> scratch);
} // namespace preview
