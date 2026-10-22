#include "editing.hpp"
#include <algorithm>
#include <cmath>
#include <limits>

namespace preview {
namespace {
struct Bounds {
    Vec3 low, high;
    bool touches(const Bounds &other) const {
        return low.x <= other.high.x && high.x >= other.low.x && low.y <= other.high.y &&
               high.y >= other.low.y && low.z <= other.high.z && high.z >= other.low.z;
    }
};
Bounds bounds(const VolumeSample &sample) {
    const auto &p = sample.center;
    const float r = sample.radius;
    return {{p.x - r, p.y - r, p.z - r}, {p.x + r, p.y + r, p.z + r}};
}
class Volumes {
    struct Node {
        Bounds box;
        size_t begin{}, end{};
        int left{-1}, right{-1};
    };
    SceneVector<VolumeSample> samples_;
    SceneVector<Node> nodes_;
    int build(size_t begin, size_t end) {
        auto box = bounds(samples_[begin]);
        for (size_t i = begin + 1; i < end; ++i) {
            auto b = bounds(samples_[i]);
            box.low = {std::min(box.low.x, b.low.x), std::min(box.low.y, b.low.y),
                       std::min(box.low.z, b.low.z)};
            box.high = {std::max(box.high.x, b.high.x), std::max(box.high.y, b.high.y),
                        std::max(box.high.z, b.high.z)};
        }
        const int index = int(nodes_.size());
        nodes_.push_back({box, begin, end});
        if (end - begin > 4) {
            const float extents[] = {box.high.x - box.low.x, box.high.y - box.low.y, box.high.z - box.low.z};
            const int axis = int(std::max_element(extents, extents + 3) - extents);
            auto coordinate = [axis](const VolumeSample &s) {
                return axis == 0 ? s.center.x : axis == 1 ? s.center.y : s.center.z;
            };
            const size_t middle = (begin + end) / 2;
            std::nth_element(samples_.begin() + begin, samples_.begin() + middle, samples_.begin() + end,
                             [&](const auto &a, const auto &b) { return coordinate(a) < coordinate(b); });
            nodes_[index].left = build(begin, middle);
            nodes_[index].right = build(middle, end);
        }
        return index;
    }
    bool hit(int index, const Bounds &box, const std::function<bool(const VolumeSample &)> &test) const {
        const auto &node = nodes_[index];
        if (!node.box.touches(box))
            return false;
        if (node.left >= 0)
            return hit(node.left, box, test) || hit(node.right, box, test);
        for (size_t i = node.begin; i < node.end; ++i)
            if (bounds(samples_[i]).touches(box) && test(samples_[i]))
                return true;
        return false;
    }

  public:
    Volumes(std::span<const VolumeSample> samples, const std::shared_ptr<SceneMemory> &scratch)
        : samples_(samples.begin(), samples.end(), SceneAllocator<VolumeSample>{scratch}),
          nodes_(SceneAllocator<Node>{scratch}) {
        nodes_.reserve(samples.size() * 2);
        build(0, samples.size());
    }
    bool hit(const Bounds &box, const std::function<bool(const VolumeSample &)> &test) const {
        return hit(0, box, test);
    }
};
// Exact distance from a sphere center to the anisotropic 3-sigma ellipsoid.
// Principal axes are reconstructed only after the inexpensive BVH bounds test.
struct Ellipsoid {
    double matrix[3][3], axes[3];
    explicit Ellipsoid(const Gaussian &g) {
        const auto basis = exportAxesRdf(g);
        const auto &q = basis.quaternion;
        const double w = q[0], x = q[1], y = q[2], z = q[3];
        const double rotation[3][3] = {{1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)},
                                       {2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)},
                                       {2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)}};
        for (int i = 0; i < 3; ++i) {
            axes[i] = 3 * std::exp(double(basis.logScales[i]));
            for (int j = 0; j < 3; ++j)
                matrix[i][j] = rotation[j][i] * (j == 0 ? 1 : -1);
        }
    }
    bool touches(Vec3 delta, float radius) const {
        const double input[] = {delta.x, delta.y, delta.z};
        double d[3]{}, a2[3], inside = 0, length = 0, maxAxis = 0;
        for (int i = 0; i < 3; ++i) {
            for (int j = 0; j < 3; ++j)
                d[i] += matrix[i][j] * input[j];
            a2[i] = axes[i] * axes[i];
            inside += d[i] * d[i] / a2[i];
            length += d[i] * d[i];
            maxAxis = std::max(maxAxis, axes[i]);
        }
        if (inside <= 1)
            return true;
        double low = 0, high = maxAxis * std::sqrt(length);
        for (int iteration = 0; iteration < 48; ++iteration) {
            const double lambda = (low + high) * .5;
            double sum = 0;
            for (int i = 0; i < 3; ++i) {
                const double denominator = a2[i] + lambda;
                sum += a2[i] * d[i] * d[i] / (denominator * denominator);
            }
            if (sum > 1)
                low = lambda;
            else
                high = lambda;
        }
        double distance = 0;
        for (int i = 0; i < 3; ++i) {
            const double offset = d[i] * high / (a2[i] + high);
            distance += offset * offset;
        }
        return distance <= double(radius) * radius * (1 + 1e-6);
    }
};
} // namespace
bool SceneEdits::selectVolumeBrush(std::span<const VolumeSample> samples, SelectOperation operation,
                                   SelectionOptions options, const SelectionMap *map) {
    if (samples.empty() || samples.size() > 65536)
        return false;
    for (const auto &s : samples)
        if (!std::isfinite(s.center.x) || !std::isfinite(s.center.y) || !std::isfinite(s.center.z) ||
            !std::isfinite(s.radius) || s.radius <= 0 || s.radius > 1e12f)
            return false;
    SceneVector<uint8_t> visible{SceneAllocator<uint8_t>{scratchMemory_}};
    if (options.visibleOnly) {
        const bool surface =
            map && !map->visible.empty() && map->visible.size() == (states_.size() + 31) / 32;
        if (!surface &&
            (!map || !map->width || !map->height ||
             size_t(map->height) > std::numeric_limits<size_t>::max() / map->width ||
             map->ids.size() != size_t(map->width) * map->height))
            return false;
        visible.resize(states_.size());
        if (surface) {
            for (size_t i = 0; i < states_.size(); ++i)
                visible[i] = uint8_t((map->visible[i / 32] >> (i % 32)) & 1);
        } else
            for (auto id : map->ids)
                if (id && id <= visible.size())
                    visible[id - 1] = 1;
    }
    Volumes volumes(samples, scratchMemory_);
    return selectMatches(operation, [&](size_t i) {
        if (options.visibleOnly && !visible[i])
            return false;
        const auto &g = scene_->gaussians[i];
        const auto &p = g.positionOpacity;
        const Vec3 extent = options.overlap ? Vec3{3 * std::sqrt(std::max(0.f, g.covA[0])),
                                                   3 * std::sqrt(std::max(0.f, g.covA[3])),
                                                   3 * std::sqrt(std::max(0.f, g.covB[1]))}
                                            : Vec3{};
        const Bounds box{{p[0] - extent.x, p[1] - extent.y, p[2] - extent.z},
                         {p[0] + extent.x, p[1] + extent.y, p[2] + extent.z}};
        std::optional<Ellipsoid> ellipsoid;
        return volumes.hit(box, [&](const VolumeSample &s) {
            const Vec3 delta{s.center.x - p[0], s.center.y - p[1], s.center.z - p[2]};
            if (!options.overlap)
                return double(delta.x) * delta.x + double(delta.y) * delta.y + double(delta.z) * delta.z <=
                       double(s.radius) * s.radius;
            if (!ellipsoid)
                ellipsoid.emplace(g);
            return ellipsoid->touches(delta, s.radius);
        });
    });
}
} // namespace preview
