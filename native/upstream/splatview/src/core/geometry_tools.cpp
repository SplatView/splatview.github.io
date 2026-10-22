#include "geometry_tools.hpp"
#include "math.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <random>
#include <stdexcept>

namespace preview {
namespace {
using D3 = std::array<double, 3>;
D3 point(Vec3 p) {
    return {p.x, p.y, p.z};
}
D3 minus(D3 a, D3 b) {
    return {a[0] - b[0], a[1] - b[1], a[2] - b[2]};
}
double dot(D3 a, D3 b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
D3 cross(D3 a, D3 b) {
    return {a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]};
}
double length(D3 a) {
    return std::sqrt(dot(a, a));
}
D3 unit(D3 a) {
    const double n = length(a);
    if (!std::isfinite(n) || n <= 0)
        throw std::runtime_error("Choose distinct points on the scene.");
    for (auto &v : a)
        v /= n;
    return a;
}
Vec3 vec(D3 a) {
    return {float(a[0]), float(a[1]), float(a[2])};
}
Matrix4 matrix(DirectX::FXMMATRIX m) {
    Matrix4 result;
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(result.data()), m);
    return result;
}
DirectX::XMMATRIX level(D3 n) {
    n = unit(n);
    // Shortest-arc rotation from n to +Y, including the antiparallel case.
    using namespace DirectX;
    if (n[1] < -1 + 1e-10)
        return XMMatrixRotationX(XM_PI);
    auto q = XMQuaternionNormalize(XMVectorSet(float(-n[2]), 0, float(n[0]), float(1 + n[1])));
    return XMMatrixRotationQuaternion(q);
}
} // namespace
float pointDistance(Vec3 a, Vec3 b) {
    const double d = length(minus(point(a), point(b)));
    if (!std::isfinite(d))
        throw std::runtime_error("Invalid measurement points.");
    return float(d);
}
float pointAngle(Vec3 a, Vec3 vertex, Vec3 b) {
    const auto u = unit(minus(point(a), point(vertex))), v = unit(minus(point(b), point(vertex)));
    return float(std::acos(std::clamp(dot(u, v), -1., 1.)) * 180 / 3.14159265358979323846);
}
Matrix4 centerAtPoint(Vec3 p) {
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || !std::isfinite(p.z))
        throw std::runtime_error("Invalid center point.");
    return matrix(DirectX::XMMatrixTranslation(-p.x, -p.y, -p.z));
}
Matrix4 scaleFromPoints(Vec3 a, Vec3 b, float target) {
    using namespace DirectX;
    const double distance = length(minus(point(a), point(b)));
    if (!std::isfinite(target) || target <= 0 || distance <= 0 || !std::isfinite(distance))
        throw std::runtime_error("Choose two distinct points and a positive target distance.");
    const float scale = float(target / distance);
    if (!std::isfinite(scale) || scale < 1e-6f || scale > 1e6f)
        throw std::runtime_error("The scale factor must be between 0.000001 and 1000000.");
    const Vec3 mid{a.x * .5f + b.x * .5f, a.y * .5f + b.y * .5f, a.z * .5f + b.z * .5f};
    return matrix(XMMatrixTranslation(-mid.x, -mid.y, -mid.z) * XMMatrixScaling(scale, scale, scale) *
                  XMMatrixTranslation(mid.x, mid.y, mid.z));
}
Matrix4 alignFromPoints(Vec3 a, Vec3 b, Vec3 c, bool flip) {
    using namespace DirectX;
    auto ab = minus(point(b), point(a)), ac = minus(point(c), point(a));
    auto n = cross(ab, ac);
    if (length(n) <= length(ab) * length(ac) * 1e-6)
        throw std::runtime_error("Choose three points that are not on one line.");
    if (flip)
        for (auto &v : n)
            v = -v;
    const Vec3 center{a.x / 3 + b.x / 3 + c.x / 3, a.y / 3 + b.y / 3 + c.y / 3, a.z / 3 + b.z / 3 + c.z / 3};
    return matrix(XMMatrixTranslation(-center.x, -center.y, -center.z) * level(n) *
                  XMMatrixTranslation(center.x, center.y, center.z));
}
Matrix4 alignFloor(const FloorPlane &plane, bool flip) {
    using namespace DirectX;
    auto n = point(plane.normal);
    if (flip)
        for (auto &v : n)
            v = -v;
    auto rotation = level(n);
    const auto p =
        XMVector3TransformCoord(XMVectorSet(plane.center.x, plane.center.y, plane.center.z, 1), rotation);
    return matrix(rotation * XMMatrixTranslation(0, -XMVectorGetY(p), 0));
}
Recipe matrixRecipe(const Matrix4 &m) {
    std::array<float, 16> rowMajor;
    for (unsigned r = 0; r < 4; ++r)
        for (unsigned c = 0; c < 4; ++c)
            rowMajor[r * 4 + c] = m[c * 4 + r];
    return {{"type", "transform"}, {"values", {{"matrix", rowMajor}}}};
}
std::optional<FloorPlane> detectFloor(const Scene &scene, std::span<const uint8_t> states, bool selectedOnly,
                                      FloorOptions options, std::stop_token stop,
                                      std::shared_ptr<SceneMemory> scratch) {
    if (!states.empty() && states.size() != scene.gaussians.size())
        throw std::runtime_error("Floor selection does not match the scene.");
    if (!std::isfinite(options.threshold) || options.threshold < 0 || !options.iterations ||
        options.iterations > 10000 || options.samples < 3 || options.samples > 100000)
        throw std::runtime_error("Invalid floor detection settings.");
    if (stop.stop_requested())
        return {};
    // Bounded reservoir sampling keeps memory independent of the asset size.
    SceneVector<D3> points{SceneAllocator<D3>{scratch}};
    points.reserve(std::min<size_t>(options.samples, scene.gaussians.size()));
    std::mt19937 random(0x53504c54);
    size_t count = 0;
    for (size_t i = 0; i < scene.gaussians.size(); ++i) {
        if ((i & 4095) == 0 && stop.stop_requested())
            return {};
        const auto state = states.empty() ? 0 : states[i];
        const auto &p = scene.gaussians[i].positionOpacity;
        if ((state & 2) || (selectedOnly && !(state & 1)) || p[3] < 1.f / 255 || !std::isfinite(p[0]) ||
            !std::isfinite(p[1]) || !std::isfinite(p[2]))
            continue;
        ++count;
        D3 value{p[0], p[1], p[2]};
        if (points.size() < options.samples)
            points.push_back(value);
        else {
            const auto slot = std::uniform_int_distribution<size_t>(0, count - 1)(random);
            if (slot < points.size())
                points[slot] = value;
        }
    }
    if (points.size() < 3)
        return {};
    if (stop.stop_requested())
        return {};
    double threshold = options.threshold;
    if (!threshold) {
        D3 extent{};
        double magnitude = 0;
        SceneVector<double> axis(points.size(), SceneAllocator<double>{scratch});
        for (int k = 0; k < 3; ++k) {
            for (size_t i = 0; i < points.size(); ++i)
                axis[i] = points[i][k];
            std::sort(axis.begin(), axis.end());
            const size_t trim = (axis.size() - 1) / 20;
            extent[k] = axis[axis.size() - 1 - trim] - axis[trim];
            magnitude = std::max({magnitude, std::abs(axis[trim]), std::abs(axis[axis.size() - 1 - trim])});
        }
        // Use robust position bounds, not the framing radius, which includes
        // Gaussian footprints and can be dominated by distant background splats.
        threshold = std::max(length(extent) * .0025, magnitude * std::numeric_limits<float>::epsilon() * 2);
        if (!(threshold > 0))
            return {};
    }
    std::uniform_int_distribution<size_t> index(0, points.size() - 1);
    D3 best{};
    double bestD = 0, bestError = 0;
    size_t support = 0;
    for (unsigned iteration = 0; iteration < options.iterations; ++iteration) {
        if (stop.stop_requested())
            return {};
        const auto a = index(random), b = index(random), c = index(random);
        if (a == b || b == c || a == c)
            continue;
        auto ab = minus(points[b], points[a]), ac = minus(points[c], points[a]);
        auto normal = cross(ab, ac);
        const double norm = length(normal);
        if (norm <= length(ab) * length(ac) * 1e-6)
            continue;
        for (auto &v : normal)
            v /= norm;
        const double d = -dot(normal, points[a]);
        size_t inliers = 0;
        double error = 0;
        for (const auto &p : points) {
            const double distance = std::abs(dot(normal, p) + d);
            if (distance <= threshold) {
                ++inliers;
                error += distance * distance;
            }
        }
        if (inliers > support || (inliers == support && error < bestError)) {
            support = inliers;
            best = normal;
            bestD = d;
            bestError = error;
        }
        if (support >= size_t(points.size() * .8))
            break;
    }
    if (support < std::max<size_t>(3, points.size() / 20))
        return {};
    // Refine the winning plane using the least-variance eigenvector of its inliers.
    D3 center{};
    for (const auto &p : points)
        if (std::abs(dot(best, p) + bestD) <= threshold)
            for (int k = 0; k < 3; ++k)
                center[k] += p[k] / support;
    double covariance[3][3]{}, axes[3][3]{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (const auto &p : points)
        if (std::abs(dot(best, p) + bestD) <= threshold) {
            auto v = minus(p, center);
            for (int r = 0; r < 3; ++r)
                for (int c = 0; c < 3; ++c)
                    covariance[r][c] += v[r] * v[c];
        }
    for (unsigned iteration = 0; iteration < 32; ++iteration) {
        int a = 0, b = 1;
        for (int r = 0; r < 3; ++r)
            for (int c = r + 1; c < 3; ++c)
                if (std::abs(covariance[r][c]) > std::abs(covariance[a][b])) {
                    a = r;
                    b = c;
                }
        if (std::abs(covariance[a][b]) <=
            1e-14 * std::max({covariance[0][0], covariance[1][1], covariance[2][2]}))
            break;
        const double angle = .5 * std::atan2(2 * covariance[a][b], covariance[b][b] - covariance[a][a]);
        const double cs = std::cos(angle), sn = std::sin(angle);
        for (int k = 0; k < 3; ++k) {
            const double u = covariance[k][a], v = covariance[k][b];
            covariance[k][a] = cs * u - sn * v;
            covariance[k][b] = sn * u + cs * v;
            const double x = axes[k][a], y = axes[k][b];
            axes[k][a] = cs * x - sn * y;
            axes[k][b] = sn * x + cs * y;
        }
        for (int k = 0; k < 3; ++k) {
            const double u = covariance[a][k], v = covariance[b][k];
            covariance[a][k] = cs * u - sn * v;
            covariance[b][k] = sn * u + cs * v;
        }
    }
    int smallest = 0;
    for (int i = 1; i < 3; ++i)
        if (covariance[i][i] < covariance[smallest][smallest])
            smallest = i;
    std::array<double, 3> variance{covariance[0][0], covariance[1][1], covariance[2][2]};
    std::sort(variance.begin(), variance.end());
    if (!(variance[1] > variance[2] * 1e-10))
        return {}; // Coincident or collinear support does not define a floor.
    best = unit({axes[0][smallest], axes[1][smallest], axes[2][smallest]});
    bestD = -dot(best, center);
    size_t positive = 0, negative = 0, inliers = 0;
    double error = 0, radius = 0;
    for (const auto &p : points) {
        const double d = dot(best, p) + bestD;
        if (d > threshold)
            ++positive;
        else if (d < -threshold)
            ++negative;
        else {
            ++inliers;
            error += d * d;
            radius = std::max(radius, length(minus(p, center)));
        }
    }
    if (inliers < std::max<size_t>(3, points.size() / 20) || !(radius > threshold * 2))
        return {};
    const double cameraSide = options.viewpoint ? dot(best, minus(point(*options.viewpoint), center)) : 0;
    // The actual viewing camera resolves the normal's sign. With no camera,
    // use the majority of off-plane content, then +Y as a deterministic tie-break.
    if (cameraSide < -threshold ||
        (std::abs(cameraSide) <= threshold && (negative > positive || (negative == positive && best[1] < 0))))
        for (auto &v : best)
            v = -v;
    if (stop.stop_requested())
        return {};
    return FloorPlane{vec(best),     vec(center),
                      float(radius), float(std::sqrt(error / std::max<size_t>(1, inliers))),
                      inliers,       points.size()};
}
} // namespace preview
