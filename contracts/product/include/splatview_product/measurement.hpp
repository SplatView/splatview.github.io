#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <span>
#include <stdexcept>

namespace splatview::product {
using MeasurementPoint = std::array<double, 3>;
enum class MeasurementKind { Distance, Angle };

// Geometry only: no document, selection, renderer, history or file ownership.
// One world coordinate unit is assumed to be one meter, not physical calibration.
inline double measure(MeasurementKind kind, std::span<const MeasurementPoint> points) {
    const size_t count = kind == MeasurementKind::Distance ? 2 : 3;
    if ((kind != MeasurementKind::Distance && kind != MeasurementKind::Angle) || points.size() != count)
        throw std::invalid_argument("Distance needs two points; angle needs three with the vertex second");
    for (const auto &point : points)
        for (double value : point)
            if (!std::isfinite(value))
                throw std::invalid_argument("Measurement points must be finite");
    const auto difference = [](const auto &a, const auto &b) {
        MeasurementPoint result{a[0] - b[0], a[1] - b[1], a[2] - b[2]};
        for (double value : result)
            if (!std::isfinite(value))
                throw std::invalid_argument("Measurement displacement is out of range");
        return result;
    };
    const auto a = difference(points[0], points[1]);
    const double lengthA = std::hypot(a[0], a[1], a[2]);
    double value = lengthA;
    if (kind == MeasurementKind::Angle) {
        const auto b = difference(points[2], points[1]);
        const double lengthB = std::hypot(b[0], b[1], b[2]);
        if (!(lengthA > 0) || !(lengthB > 0) || !std::isfinite(lengthA) || !std::isfinite(lengthB))
            throw std::invalid_argument("Angle arms must have finite, nonzero length");
        double cosine = 0;
        for (size_t i = 0; i < 3; ++i)
            cosine += (a[i] / lengthA) * (b[i] / lengthB);
        value = std::acos(std::clamp(cosine, -1.0, 1.0)) * (180.0 / std::acos(-1.0));
    }
    if (!std::isfinite(value))
        throw std::invalid_argument("Measurement result is out of range");
    return value;
}
} // namespace splatview::product
