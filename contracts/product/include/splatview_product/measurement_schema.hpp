#pragma once
#include <nlohmann/json.hpp>
#include <string>
#include <string_view>
#include <utility>

namespace splatview::product {
inline nlohmann::json measurementSchema() {
    using Json = nlohmann::json;
    const Json point{{"type", "array"}, {"minItems", 3}, {"maxItems", 3}, {"items", {{"type", "number"}}}};
    Json methods = Json::object();
    for (const auto &[name, count] : {std::pair{"distance", 2}, std::pair{"angle", 3}}) {
        const Json points{{"type", "array"}, {"minItems", count}, {"maxItems", count}, {"items", point}};
        const Json pixel{{"type", "array"},
                         {"minItems", 2},
                         {"maxItems", 2},
                         {"items", {{"type", "number"}, {"minimum", 0}, {"exclusiveMaximum", 1}}}};
        const Json reference{
            {"oneOf",
             Json::array({{{"type", "object"},
                           {"required", {"index"}},
                           {"additionalProperties", false},
                           {"properties",
                            {{"index", {{"type", "integer"}, {"minimum", 0}, {"maximum", 4294967295ull}}}}}},
                          {{"type", "object"},
                           {"required", {"point"}},
                           {"additionalProperties", false},
                           {"properties", {{"point", pixel}}}}})}};
        methods[name] = {
            {"method", "POST"},
            {"path", std::string("/api/v1/measure/") + name},
            {"read_only", true},
            {"result", name == std::string_view("distance") ? "distance_m" : "angle_deg"},
            {"request",
             {{"oneOf", Json::array({{{"type", "object"},
                                      {"required", {"points_m"}},
                                      {"additionalProperties", false},
                                      {"properties", {{"points_m", points}}}},
                                     {{"type", "object"},
                                      {"required",
                                       {"document_id", "expected_revision", "expected_view", "references"}},
                                      {"additionalProperties", false},
                                      {"properties",
                                       {{"document_id", {{"type", "integer"}, {"minimum", 0}}},
                                        {"expected_revision", {{"type", "integer"}, {"minimum", 0}}},
                                        {"expected_view", {{"type", "string"}, {"minLength", 1}}},
                                        {"references",
                                         {{"type", "array"},
                                          {"minItems", count},
                                          {"maxItems", count},
                                          {"items", reference}}}}}}})}}}};
    }
    return {
        {"methods", methods},
        {"axes", "RUB"},
        {"scale_convention", "one_coordinate_unit_assumed_one_meter"},
        {"physical_calibration", "not_verified"},
        {"point_semantics", "Scene references resolve displayed Gaussian centers, not surface intersections"},
        {"angle_vertex", "second point"},
        {"maximum_request_bytes", 16384},
        {"zero_distance_valid", true}};
}
} // namespace splatview::product
