#pragma once
// Nonshipping adapter for older contract fixtures. Every actual shipping direct
// export still receives native-derived bounds; explicit supplied fields remain
// untouched so malformed/stale-admission tests retain their original request.
#include <nlohmann/json.hpp>
#include <cstring>

extern "C" {
const char *sv_command(const char *);
unsigned sv_export_output_bound(unsigned,unsigned,unsigned);
unsigned sv_export_work_bound(unsigned,unsigned,unsigned);
}
inline const char *admittedContractCommand(const char *text) {
    if (!text || !std::strstr(text, "\"export\"")) return sv_command(text);
    auto request = nlohmann::json::parse(text);
    if (request.value("command", "") != "export" || !request.contains("format") ||
        !request.at("format").is_number_integer() || request.contains("outputCapacity") || request.contains("nativeWorkBytes"))
        return sv_command(text);
    const auto format = request.at("format").get<int>();
    if (format < 0 || format > 7) return sv_command(text);
    const auto summary = nlohmann::json::parse(sv_command("{\"command\":\"summary\"}"));
    const auto count = summary.value("count", 0u), degree = summary.value("shDegree", 0u);
    request["outputCapacity"] = sv_export_output_bound(unsigned(format), count, degree);
    request["nativeWorkBytes"] = sv_export_work_bound(unsigned(format), count, degree);
    const auto encoded = request.dump(); return sv_command(encoded.c_str());
}
