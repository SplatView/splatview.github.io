#include "scene.hpp"
#include "math.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview {
namespace {
[[noreturn]] void fail(const std::string &message) { throw std::runtime_error(message); }
}
Gaussian packGaussian(const Attributes &a) {
    for (float x : {a.position.x, a.position.y, a.position.z, a.scale.x, a.scale.y, a.scale.z, a.opacity})
        if (!std::isfinite(x))
            fail("Gaussian attributes contain a non-finite value");
    if (a.scale.x <= 0 || a.scale.y <= 0 || a.scale.z <= 0)
        fail("Gaussian scales must be positive");
    // File quaternions need not have unit magnitude. Double intermediates
    // normalize all finite float inputs without overflow or tiny-norm cutoffs.
    double length = 0;
    for (float x : a.quaternion)
        length += double(x) * x;
    if (!std::isfinite(length) || length == 0)
        fail("Invalid Gaussian quaternion");
    const double inverse = 1 / std::sqrt(length);
    float w = float(a.quaternion[0] * inverse), x = float(a.quaternion[1] * inverse),
          y = float(a.quaternion[2] * inverse), z = float(a.quaternion[3] * inverse);
    const float r[3][3] = {{1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)},
                           {2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)},
                           {2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)}};
    float scales[3] = {a.scale.x * a.scale.x, a.scale.y * a.scale.y, a.scale.z * a.scale.z};
    for (float variance : scales)
        if (!std::isfinite(variance) || variance <= 0)
            fail("Gaussian scale exceeds floating-point covariance precision");
    float c[3][3]{};
    for (int i = 0; i < 3; ++i)
        for (int j = 0; j < 3; ++j)
            for (int k = 0; k < 3; ++k)
                c[i][j] += r[i][k] * r[j][k] * scales[k];
    for (auto &row : c)
        for (float value : row)
            if (!std::isfinite(value))
                fail("Gaussian covariance exceeds the supported range");
    Gaussian result;
    result.positionOpacity = {a.position.x, a.position.y, a.position.z, std::clamp(a.opacity, 0.0f, 1.0f)};
    result.covA = {c[0][0], c[0][1], c[0][2], c[1][1]};
    result.covB = {c[1][2], c[2][2], 0, 0};
    for (size_t i = 0; i < 48; i += 2) {
        if (!std::isfinite(a.sh[i]) || !std::isfinite(a.sh[i + 1]) || std::abs(a.sh[i]) > maxShCoefficient ||
            std::abs(a.sh[i + 1]) > maxShCoefficient)
            fail("Invalid SH coefficient");
        result.sh[i / 2] = DirectX::PackedVector::XMConvertFloatToHalf(a.sh[i]) |
                           (uint32_t(DirectX::PackedVector::XMConvertFloatToHalf(a.sh[i + 1])) << 16);
    }
    return result;
}
float shValue(const Gaussian &g, unsigned coefficient, unsigned channel) {
    const auto i = coefficient * 3 + channel;
    return DirectX::PackedVector::XMConvertHalfToFloat(
        static_cast<uint16_t>(g.sh.at(i / 2) >> ((i & 1) * 16)));
}
void fitBounds(Scene &scene) { fitBounds(scene, {}); }
void fitBounds(Scene &scene, std::shared_ptr<SceneMemory> scratch) {
    if (!scene.isGaussian()) {
        if (scene.vertices.empty())
            fail("The PLY contains no vertices");
        std::array<double, 3> low{INFINITY, INFINITY, INFINITY}, high{-INFINITY, -INFINITY, -INFINITY};
        for (const auto &vertex : scene.vertices) {
            const std::array<float, 3> p{vertex.position.x, vertex.position.y, vertex.position.z};
            for (unsigned axis = 0; axis < 3; ++axis) {
                if (!std::isfinite(p[axis]))
                    fail("PLY coordinates must be finite");
                low[axis] = std::min(low[axis], double(p[axis]));
                high[axis] = std::max(high[axis], double(p[axis]));
            }
        }
        const Vec3 center{float((low[0] + high[0]) * .5), float((low[1] + high[1]) * .5),
                          float((low[2] + high[2]) * .5)};
        const float radius = std::max(.05f, float(std::hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) * .5));
        if (!std::isfinite(radius))
            fail("Scene bounds are too large to preview");
        scene.center = center;
        scene.radius = radius;
        scene.previewEye.reset();
        return;
    }
    if (scene.gaussians.empty())
        fail("The scene contains no Gaussians");
    std::array<SceneVector<float>, 3> positions{
        SceneVector<float>{SceneAllocator<float>{scratch}},
        SceneVector<float>{SceneAllocator<float>{scratch}},
        SceneVector<float>{SceneAllocator<float>{scratch}}};
    SceneVector<Vec3> points{SceneAllocator<Vec3>{scratch}};
    SceneVector<float> footprints{SceneAllocator<float>{scratch}};
    const size_t stride = (scene.gaussians.size() + 16383) / 16384;
    auto sample = [&](bool includeTransparent) {
        for (size_t i = 0; i < scene.gaussians.size(); i += stride) {
            const auto &g = scene.gaussians[i];
            if (!includeTransparent && g.positionOpacity[3] < 1.0f / 255)
                continue;
            points.push_back({g.positionOpacity[0], g.positionOpacity[1], g.positionOpacity[2]});
            for (int j = 0; j < 3; ++j)
                positions[j].push_back(g.positionOpacity[j]);
            footprints.push_back(3 * std::sqrt(std::max({g.covA[0], g.covA[3], g.covB[1], 0.0f})));
        }
    };
    sample(false);
    if (points.empty())
        sample(true);
    float center[3], extent[3], median[3];
    for (int j = 0; j < 3; ++j) {
        auto &p = positions[j];
        std::sort(p.begin(), p.end());
        float lo = p[p.size() / 100], hi = p[p.size() - 1 - p.size() / 100];
        center[j] = (lo + hi) * 0.5f;
        extent[j] = (hi - lo) * 0.5f;
        median[j] = p[p.size() / 2];
    }
    SceneVector<float> distances{SceneAllocator<float>{scratch}};
    distances.reserve(points.size());
    for (auto p : points)
        distances.push_back(std::hypot(p.x - median[0], p.y - median[1], p.z - median[2]));
    std::sort(distances.begin(), distances.end());
    auto quantile = [](const auto &values, float fraction) {
        return values[size_t((values.size() - 1) * fraction)];
    };
    const float core = quantile(distances, .65f);
    const bool backgroundHeavy = quantile(distances, .95f) > 3 * std::max(core, .05f);
    if (backgroundHeavy) {
        size_t kept = 0;
        for (size_t i = 0; i < points.size(); ++i) {
            auto p = points[i];
            if (std::hypot(p.x - median[0], p.y - median[1], p.z - median[2]) <= core)
                footprints[kept++] = footprints[i];
        }
        footprints.resize(kept);
    }
    std::sort(footprints.begin(), footprints.end());
    const float padding = quantile(footprints, .9f);
    Vec3 nextCenter{center[0], center[1], center[2]};
    float rawRadius = std::hypot(extent[0], extent[1], extent[2]) + padding;
    float nextRadius = std::max(0.05f, rawRadius);
    std::optional<Vec3> nextPreviewEye;
    // Outdoor backgrounds and sky shells can dwarf the captured subject. Frame
    // the dense core in those scenes instead of orbiting outside the background.
    if (backgroundHeavy) {
        nextCenter = {median[0], median[1], median[2]};
        rawRadius = core + padding;
        nextRadius = std::max(.05f, rawRadius);
        const float originDistance = std::hypot(median[0], median[1], median[2]);
        // Some captures place the world origin in the local camera space. Use
        // that viewpoint only when it lies near the content, away from its center.
        // Otherwise keep the normal outside view, including translated scenes.
        if (originDistance > nextRadius * .25f && originDistance < core)
            nextPreviewEye = Vec3{};
    }
    // A minimum clamp can conceal NaN. Validate the chosen ordinary/core
    // result, including its center, before publishing any scene metadata.
    if (!std::isfinite(rawRadius) || !std::isfinite(nextRadius) ||
        !std::isfinite(nextCenter.x) || !std::isfinite(nextCenter.y) || !std::isfinite(nextCenter.z))
        fail("Scene bounds are too large to preview");
    scene.center = nextCenter;
    scene.radius = nextRadius;
    scene.previewEye = nextPreviewEye;
}
size_t previewSplatBudget(unsigned width, unsigned height) {
    // Clamp each dimension before multiplication to keep even malformed host
    // dimensions bounded, including UINT_MAX.
    uint64_t pixels = uint64_t(std::min(width, 8192u)) * std::min(height, 8192u);
    return static_cast<size_t>(std::clamp<uint64_t>(pixels * 2, 100'000, 500'000));
}
size_t thumbnailSplatBudget(unsigned size) {
    uint64_t edge = std::min(size, 2048u);
    return static_cast<size_t>(std::clamp<uint64_t>(edge * edge * 4, 32'000, 250'000));
}
} // namespace preview
