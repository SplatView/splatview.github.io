#pragma once
#include "measurement.hpp"
#include <nlohmann/json.hpp>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <string>

namespace splatview::product {
struct MeasurementReference {
    std::optional<uint32_t> index;
    std::array<double, 2> pixel{}; // Normalized canvas coordinates, [0,1).
};
struct MeasurementRequest {
    MeasurementKind kind;
    size_t count;
    bool sceneDerived{};
    uint64_t document{}, revision{};
    std::string view;
    std::array<MeasurementPoint, 3> points{};
    std::array<MeasurementReference, 3> references{};
};
inline void measurementFields(const nlohmann::json &value, std::initializer_list<const char *> names) {
    if (!value.is_object())
        throw std::invalid_argument("Expected a measurement object");
    for (const auto &[key, item] : value.items()) {
        (void)item;
        if (std::none_of(names.begin(), names.end(), [&](const char *name) { return key == name; }))
            throw std::invalid_argument("Unknown measurement field: " + key);
    }
}
inline MeasurementRequest parseMeasurement(MeasurementKind kind, const nlohmann::json &body) {
    using Json = nlohmann::json;
    MeasurementRequest request{};
    request.kind = kind;
    request.count = kind == MeasurementKind::Distance ? size_t(2) : size_t(3);
    if (kind != MeasurementKind::Distance && kind != MeasurementKind::Angle)
        throw std::invalid_argument("Unknown measurement kind");
    if (body.contains("points_m")) {
        measurementFields(body, {"points_m"});
        const auto &points = body.at("points_m");
        if (!points.is_array() || points.size() != request.count)
            throw std::invalid_argument("Incorrect measurement point count");
        for (size_t i = 0; i < request.count; ++i) {
            const auto &point = points[i];
            if (!point.is_array() || point.size() != 3 ||
                !std::all_of(point.begin(), point.end(), [](const Json &v) { return v.is_number(); }))
                throw std::invalid_argument("Each measurement point needs three finite numbers");
            request.points[i] = point.get<MeasurementPoint>();
        }
        (void)measure(kind, std::span(request.points).first(request.count));
        return request;
    }
    measurementFields(body, {"document_id", "expected_revision", "expected_view", "references"});
    request.sceneDerived = true;
    if (!body.at("document_id").is_number_unsigned() || !body.at("expected_revision").is_number_unsigned() ||
        !body.at("expected_view").is_string() ||
        body.at("expected_view").get_ref<const std::string &>().empty())
        throw std::invalid_argument("Supply document_id, expected_revision and expected_view from state");
    request.document = body.at("document_id").get<uint64_t>();
    request.revision = body.at("expected_revision").get<uint64_t>();
    request.view = body.at("expected_view").get<std::string>();
    const auto &references = body.at("references");
    if (!references.is_array() || references.size() != request.count)
        throw std::invalid_argument("Incorrect measurement reference count");
    for (size_t i = 0; i < request.count; ++i) {
        const auto &reference = references[i];
        if (reference.contains("index")) {
            measurementFields(reference, {"index"});
            const auto &value = reference.at("index");
            if (!value.is_number_unsigned() || value.get<uint64_t>() > UINT32_MAX)
                throw std::invalid_argument("index must be an unsigned 32-bit integer");
            request.references[i].index = value.get<uint32_t>();
        } else {
            measurementFields(reference, {"point"});
            const auto &point = reference.at("point");
            if (!point.is_array() || point.size() != 2)
                throw std::invalid_argument("point must contain two normalized canvas coordinates");
            for (size_t axis = 0; axis < 2; ++axis) {
                if (!point[axis].is_number())
                    throw std::invalid_argument("point must be numeric");
                const double value = point[axis].get<double>();
                if (!std::isfinite(value) || value < 0 || value >= 1)
                    throw std::invalid_argument("point must be within [0,1)");
                request.references[i].pixel[axis] = value;
            }
        }
    }
    return request;
}
inline nlohmann::json measurementResult(const MeasurementRequest &request) {
    if ((request.kind != MeasurementKind::Distance && request.kind != MeasurementKind::Angle) ||
        request.count != (request.kind == MeasurementKind::Distance ? size_t(2) : size_t(3)))
        throw std::invalid_argument("Incorrect measurement result point count");
    const auto points = std::span(request.points).first(request.count);
    nlohmann::json result{{request.kind == MeasurementKind::Distance ? "distance_m" : "angle_deg",
                           measure(request.kind, points)},
                          {"points_m", nlohmann::json::array()},
                          {"axes", "RUB"},
                          {"coordinate_frame", request.sceneDerived ? "displayed_world" : "provided_world"},
                          {"scale_convention", "one_coordinate_unit_assumed_one_meter"},
                          {"physical_calibration", "not_verified"}};
    for (const auto &point : points)
        result["points_m"].push_back(point);
    if (request.sceneDerived) {
        result["document_id"] = request.document;
        result["edit_revision"] = request.revision;
        result["view_id"] = request.view;
    }
    return result;
}
} // namespace splatview::product
