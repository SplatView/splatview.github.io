#include "editing.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview {
// One bit per screen pixel, capped by downsampling very large viewports. A
// complete stroke projects each Gaussian once, rather than once per brush dab.
class SelectionMask {
  public:
    SelectionMask(unsigned width, unsigned height, const std::shared_ptr<SceneMemory> &scratch)
        : scale_(unsigned(std::max(1., std::ceil(std::sqrt(double(width) * height / (8 * 1024 * 1024)))))),
          width_(width / scale_ + unsigned(width % scale_ != 0)),
          height_(height / scale_ + unsigned(height % scale_ != 0)),
          stride_(width_ / 64 + unsigned(width_ % 64 != 0)), bits_(SceneAllocator<uint64_t>{scratch}) {
        if (width_ > unsigned(std::numeric_limits<int>::max()) ||
            height_ > unsigned(std::numeric_limits<int>::max()) ||
            (stride_ && size_t(height_) > std::numeric_limits<size_t>::max() / stride_))
            throw std::overflow_error("Selection mask dimensions overflow");
        bits_.resize(size_t(stride_) * height_);
    }

    void segment(PointI start, PointI end, float radius) {
        const float ax = float(start.x) / scale_, ay = float(start.y) / scale_;
        const float bx = float(end.x) / scale_, by = float(end.y) / scale_, r = radius / scale_;
        const float length = std::hypot(bx - ax, by - ay);
        const float nx = length > 0 ? -(by - ay) * r / length : 0;
        const float ny = length > 0 ? (bx - ax) * r / length : 0;
        const float qx[] = {ax + nx, bx + nx, bx - nx, ax - nx};
        const float qy[] = {ay + ny, by + ny, by - ny, ay - ny};
        const int first = firstPixel(std::min(ay, by) - r, height_);
        const int last = lastPixel(std::max(ay, by) + r, height_);
        for (int y = first; y <= last; ++y) {
            const float row = y + .5f;
            float lo = std::numeric_limits<float>::infinity(), hi = -lo;
            auto include = [&](float x) {
                lo = std::min(lo, x);
                hi = std::max(hi, x);
            };
            auto cap = [&](float x, float centerY) {
                const float d = row - centerY;
                if (std::abs(d) <= r) {
                    const float extent = std::sqrt(std::max(0.f, r * r - d * d));
                    include(x - extent);
                    include(x + extent);
                }
            };
            cap(ax, ay);
            cap(bx, by);
            if (length > 0)
                for (unsigned i = 0, j = 3; i < 4; j = i++)
                    if ((qy[i] > row) != (qy[j] > row))
                        include(qx[i] + (row - qy[i]) * (qx[j] - qx[i]) / (qy[j] - qy[i]));
            if (lo <= hi)
                span(unsigned(y), lo, hi);
        }
    }
    bool contains(float x, float y) const {
        if (!std::isfinite(x) || !std::isfinite(y) || x < 0 || y < 0)
            return false;
        const float columnValue = x / scale_, rowValue = y / scale_;
        if (double(columnValue) >= width_ || double(rowValue) >= height_)
            return false;
        const unsigned column = unsigned(columnValue), row = unsigned(rowValue);
        return (bits_[size_t(row) * stride_ + column / 64] >> (column % 64)) & 1;
    }
    void rectangle(RectI rect) {
        for (int y = firstPixel(float(rect.top) / scale_, height_);
             y <= lastPixel(float(rect.bottom) / scale_, height_); ++y)
            span(unsigned(y), float(rect.left) / scale_, float(rect.right) / scale_);
    }
    void polygon(std::span<const PointI> points) {
        SceneVector<float> crossings{SceneAllocator<float>{bits_.get_allocator().memory()}};
        crossings.reserve(points.size());
        for (unsigned y = 0; y < height_; ++y) {
            const float row = (y + .5f) * scale_;
            crossings.clear();
            for (size_t i = 0, j = points.size() - 1; i < points.size(); j = i++) {
                const float ax = float(points[j].x), ay = float(points[j].y), bx = float(points[i].x),
                            by = float(points[i].y);
                if ((ay > row) != (by > row))
                    crossings.push_back((ax + (row - ay) * (bx - ax) / (by - ay)) / scale_);
            }
            std::sort(crossings.begin(), crossings.end());
            for (size_t i = 1; i < crossings.size(); i += 2)
                span(y, crossings[i - 1], crossings[i]);
        }
    }
    bool ellipse(float x, float y, float a, float b, float c) const {
        x /= scale_;
        y /= scale_;
        const float squared = float(scale_) * scale_;
        a /= squared;
        b /= squared;
        c /= squared;
        const float det = a * c - b * b;
        if (!(det > 0) || !(c > 0))
            return false;
        const float extent = 3 * std::sqrt(c);
        const int first = firstPixel(y - extent, height_);
        const int last = lastPixel(y + extent, height_);
        for (int row = first; row <= last; ++row) {
            const float dy = row + .5f - y, remaining = 9 - dy * dy / c;
            if (remaining < 0)
                continue;
            const float center = x + b / c * dy, radius = std::sqrt(det / c * remaining);
            if (intersects(unsigned(row), center - radius, center + radius))
                return true;
        }
        return false;
    }

  private:
    // Clamp the rounded pixel boundary before integer conversion. This retains
    // normal raster rounding while making offscreen/extreme inputs well-defined.
    static int firstPixel(float edge, unsigned extent) {
        if (std::isnan(edge)) return int(extent);
        return int(std::clamp(double(std::ceil(edge - .5f)), 0., double(extent)));
    }
    static int lastPixel(float edge, unsigned extent) {
        if (std::isnan(edge)) return -1;
        return int(std::clamp(double(std::floor(edge - .5f)), -1., double(extent) - 1));
    }
    bool intersects(unsigned row, float lo, float hi) const {
        const int first = firstPixel(lo, width_);
        const int last = lastPixel(hi, width_);
        if (first > last)
            return false;
        const auto *words = bits_.data() + size_t(row) * stride_;
        const uint64_t left = ~uint64_t(0) << (first % 64), right = ~uint64_t(0) >> (63 - last % 64);
        if (first / 64 == last / 64)
            return (words[first / 64] & left & right) != 0;
        if ((words[first / 64] & left) || (words[last / 64] & right))
            return true;
        for (int word = first / 64 + 1; word < last / 64; ++word)
            if (words[word])
                return true;
        return false;
    }
    void span(unsigned row, float lo, float hi) {
        const int first = firstPixel(lo, width_);
        const int last = lastPixel(hi, width_);
        if (first > last)
            return;
        const uint64_t left = ~uint64_t(0) << (first % 64);
        const uint64_t right = ~uint64_t(0) >> (63 - last % 64);
        auto *words = bits_.data() + size_t(row) * stride_;
        if (first / 64 == last / 64)
            words[first / 64] |= left & right;
        else {
            words[first / 64] |= left;
            std::fill(words + first / 64 + 1, words + last / 64, ~uint64_t(0));
            words[last / 64] |= right;
        }
    }
    unsigned scale_, width_, height_, stride_;
    SceneVector<uint64_t> bits_;
};

namespace {
struct Projection {
    DirectX::XMFLOAT4X4 view, matrix;
    float width, height, focal;
    Projection(const Camera &camera, unsigned w, unsigned h) : width(float(w)), height(float(h)) {
        DirectX::XMStoreFloat4x4(&view, camera.view());
        DirectX::XMStoreFloat4x4(&matrix, camera.view() * camera.projection(float(w) / h));
        focal = h * .5f / std::tan(DirectX::XMConvertToRadians(camera.fieldOfView) * .5f);
    }
    bool center(const Gaussian &g, float &x, float &y, float &depth) const {
        const auto &p = g.positionOpacity;
        const auto &m = matrix;
        depth = p[0] * m._14 + p[1] * m._24 + p[2] * m._34 + m._44;
        const float z = p[0] * m._13 + p[1] * m._23 + p[2] * m._33 + m._43;
        if (depth <= 0 || z < 0 || z > depth)
            return false;
        x = ((p[0] * m._11 + p[1] * m._21 + p[2] * m._31 + m._41) / depth + 1) * width * .5f;
        y = (1 - (p[0] * m._12 + p[1] * m._22 + p[2] * m._32 + m._42) / depth) * height * .5f;
        return true;
    }
    void covariance(const Gaussian &g, float depth, float &a, float &b, float &c) const {
        const auto &p = g.positionOpacity;
        const float px = p[0] * view._11 + p[1] * view._21 + p[2] * view._31 + view._41;
        const float py = p[0] * view._12 + p[1] * view._22 + p[2] * view._32 + view._42;
        const float right[3] = {view._11, view._21, view._31}, up[3] = {view._12, view._22, view._32},
                    forward[3] = {view._13, view._23, view._33};
        float jx[3], jy[3];
        for (int k = 0; k < 3; ++k) {
            jx[k] = focal / depth * (right[k] + px / depth * forward[k]);
            jy[k] = -focal / depth * (up[k] + py / depth * forward[k]);
        }
        const float cov[3][3] = {{g.covA[0], g.covA[1], g.covA[2]},
                                 {g.covA[1], g.covA[3], g.covB[0]},
                                 {g.covA[2], g.covB[0], g.covB[1]}};
        a = c = .3f;
        b = 0;
        for (int i = 0; i < 3; ++i)
            for (int j = 0; j < 3; ++j) {
                a += jx[i] * cov[i][j] * jx[j];
                b += jx[i] * cov[i][j] * jy[j];
                c += jy[i] * cov[i][j] * jy[j];
            }
        const float mid = (a + c) * .5f, delta = std::hypot((a - c) * .5f, b);
        const float l1 = std::clamp(mid + delta, .01f, 262144.f),
                    l2 = std::clamp(mid - delta, .01f, 262144.f);
        const float angle = .5f * std::atan2(2 * b, a - c), cs = std::cos(angle), sn = std::sin(angle);
        a = l1 * cs * cs + l2 * sn * sn;
        b = (l1 - l2) * cs * sn;
        c = l1 * sn * sn + l2 * cs * cs;
    }
};
bool validIdMap(const SelectionMap *map) {
    return map && map->width && map->height &&
        size_t(map->height) <= std::numeric_limits<size_t>::max() / map->width &&
        map->ids.size() == size_t(map->width) * map->height;
}
SceneVector<uint8_t> visibleIds(size_t count, const SelectionMap *map, const SelectionMask *mask,
                              unsigned width, unsigned height, const std::shared_ptr<SceneMemory> &scratch) {
    SceneVector<uint8_t> visible(count, uint8_t{}, SceneAllocator<uint8_t>{scratch});
    if (!validIdMap(map))
        return visible;
    for (unsigned y = 0; y < map->height; ++y)
        for (unsigned x = 0; x < map->width; ++x) {
            const auto id = map->ids[size_t(y) * map->width + x];
            if (id && id <= count &&
                (!mask || mask->contains((x + .5f) * width / map->width, (y + .5f) * height / map->height)))
                visible[id - 1] = 1;
        }
    return visible;
}
} // namespace

bool SceneEdits::selectSingle(std::optional<uint32_t> index, SelectOperation operation) {
    if (index && *index >= states_.size())
        return false;
    return selectMatches(operation, [&](size_t i) { return index && i == *index; });
}
bool SceneEdits::selectMask(const Camera &camera, unsigned width, unsigned height, const SelectionMask &mask,
                            SelectOperation operation, SelectionOptions options, const SelectionMap *map) {
    const bool surface = map && !map->visible.empty() && map->visible.size() == (states_.size() + 31) / 32;
    if (options.visibleOnly && !surface && !validIdMap(map))
        return false;
    auto visible = options.visibleOnly && !surface
        ? visibleIds(states_.size(), map, &mask, width, height, scratchMemory_)
        : SceneVector<uint8_t>{SceneAllocator<uint8_t>{scratchMemory_}};
    Projection project(camera, width, height);
    return selectMatches(operation, [&](size_t i) {
        if (options.visibleOnly && !(surface ? ((map->visible[i / 32] >> (i % 32)) & 1) : visible[i]))
            return false;
        if (options.visibleOnly && options.overlap && !surface)
            return true;
        float x, y, depth;
        const auto &g = scene_->gaussians[i];
        if (!project.center(g, x, y, depth))
            return false;
        if (!options.overlap)
            return x >= 0 && y >= 0 && x < width && y < height && mask.contains(x, y);
        float a, b, c;
        project.covariance(g, depth, a, b, c);
        return mask.ellipse(x, y, a, b, c);
    });
}
bool SceneEdits::selectRectangle(const Camera &camera, unsigned width, unsigned height, RectI rect,
                                 SelectOperation operation, SelectionOptions options,
                                 const SelectionMap *map) {
    if (!width || !height)
        return false;
    if (rect.left > rect.right)
        std::swap(rect.left, rect.right);
    if (rect.top > rect.bottom)
        std::swap(rect.top, rect.bottom);
    if (int64_t(rect.right) - rect.left < 4 && int64_t(rect.bottom) - rect.top < 4) {
        rect.left = int32_t(std::max(int64_t(std::numeric_limits<int32_t>::min()), int64_t(rect.left) - 5));
        rect.right = int32_t(std::min(int64_t(std::numeric_limits<int32_t>::max()), int64_t(rect.right) + 5));
        rect.top = int32_t(std::max(int64_t(std::numeric_limits<int32_t>::min()), int64_t(rect.top) - 5));
        rect.bottom = int32_t(std::min(int64_t(std::numeric_limits<int32_t>::max()), int64_t(rect.bottom) + 5));
    }
    if (!options.visibleOnly && !options.overlap)
        return selectRegion(camera, width, height, operation, [rect](float x, float y) {
            return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
        });
    SelectionMask mask(width, height, scratchMemory_);
    mask.rectangle(rect);
    return selectMask(camera, width, height, mask, operation, options, map);
}

bool SceneEdits::selectBrush(const Camera &camera, unsigned width, unsigned height,
                             std::span<const PointI> points, float radius, SelectOperation operation,
                             SelectionOptions options, const SelectionMap *map) {
    if (!width || !height || points.empty() || points.size() > 65536 || !std::isfinite(radius) ||
        radius <= 0 || radius > 4096)
        return false;
    SelectionMask mask(width, height, scratchMemory_);
    mask.segment(points.front(), points.front(), radius);
    for (size_t i = 1; i < points.size(); ++i)
        mask.segment(points[i - 1], points[i], radius);
    if (options.visibleOnly || options.overlap)
        return selectMask(camera, width, height, mask, operation, options, map);
    return selectRegion(camera, width, height, operation,
                        [&](float x, float y) { return mask.contains(x, y); });
}

bool SceneEdits::selectPolygon(const Camera &camera, unsigned width, unsigned height,
                               std::span<const PointI> points, SelectOperation operation,
                               SelectionOptions options, const SelectionMap *map) {
    if (!width || !height || points.size() < 3 || points.size() > 4096)
        return false;
    int32_t left = points[0].x, right = left, top = points[0].y, bottom = top;
    bool noncollinear = false;
    for (size_t i = 1; i < points.size(); ++i) {
        left = std::min(left, points[i].x);
        right = std::max(right, points[i].x);
        top = std::min(top, points[i].y);
        bottom = std::max(bottom, points[i].y);
        if (i >= 2)
            noncollinear |= (double(points[i - 1].x) - points[0].x) * (double(points[i].y) - points[0].y) !=
                            (double(points[i - 1].y) - points[0].y) * (double(points[i].x) - points[0].x);
    }
    if (!noncollinear)
        return false;
    if (options.visibleOnly || options.overlap) {
        SelectionMask mask(width, height, scratchMemory_);
        mask.polygon(points);
        return selectMask(camera, width, height, mask, operation, options, map);
    }
    return selectRegion(camera, width, height, operation, [&](float x, float y) {
        if (x < left || x > right || y < top || y > bottom)
            return false;
        bool inside = false;
        for (size_t i = 0, j = points.size() - 1; i < points.size(); j = i++) {
            const double ax = points[j].x, ay = points[j].y, bx = points[i].x, by = points[i].y;
            const double cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
            if (std::abs(cross) <= 1e-4 && x >= std::min(ax, bx) && x <= std::max(ax, bx) &&
                y >= std::min(ay, by) && y <= std::max(ay, by))
                return true;
            if ((ay > y) != (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay))
                inside = !inside;
        }
        return inside;
    });
}
} // namespace preview
