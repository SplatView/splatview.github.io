#include "export_internal.hpp"
#include "binary_output.hpp"
#include <load-spz.h>
#include <charconv>
#include <cstring>
#include <fstream>
#include <limits>
#include <locale>

namespace preview::detail {
namespace {
constexpr float shC0 = .28209479177387814f;
constexpr const char *boundNames[] = {
    "min_x",       "min_y",       "min_z",       "max_x",       "max_y",       "max_z",
    "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z",
    "min_r",       "min_g",       "min_b",       "max_r",       "max_g",       "max_b"};
uint32_t spread(uint32_t value) {
    value = (value | (value << 16)) & 0x030000ff;
    value = (value | (value << 8)) & 0x0300f00f;
    value = (value | (value << 4)) & 0x030c30c3;
    return (value | (value << 2)) & 0x09249249;
}
std::array<float, 3> positionRdf(const Gaussian &g) {
    return {g.positionOpacity[0], -g.positionOpacity[1], -g.positionOpacity[2]};
}
uint32_t pack111011(const std::array<float, 3> &v, const float *low, const float *high) {
    return (unorm(normalized(v[0], low[0], high[0]), 11) << 21) |
           (unorm(normalized(v[1], low[1], high[1]), 10) << 11) |
           unorm(normalized(v[2], low[2], high[2]), 11);
}
uint32_t packQuaternion(const std::array<float, 4> &q) {
    unsigned largest = 0;
    for (unsigned i = 1; i < 4; ++i)
        if (std::abs(q[i]) > std::abs(q[largest]))
            largest = i;
    const double sign = q[largest] < 0 ? -1 : 1;
    uint32_t packed = largest;
    for (unsigned i = 0; i < 4; ++i)
        if (i != largest)
            packed = (packed << 10) | unorm(q[i] * sign * .7071067811865475 + .5, 10);
    return packed;
}
void finish(std::ofstream &out) {
    out.close();
    if (!out)
        throw std::runtime_error("The scene output could not be written completely");
}
} // namespace
std::vector<uint64_t> spatialOrder(const Scene &scene, std::span<const uint8_t> states,
                                   std::stop_token stop) {
    std::array<float, 3> low, high;
    low.fill(std::numeric_limits<float>::infinity());
    high.fill(-std::numeric_limits<float>::infinity());
    size_t count = 0;
    forVisible(scene, states, stop, [&](const Gaussian &g, uint32_t) {
        const auto p = positionRdf(g);
        for (unsigned c = 0; c < 3; ++c) {
            low[c] = std::min(low[c], p[c]);
            high[c] = std::max(high[c], p[c]);
        }
        ++count;
    });
    std::vector<uint64_t> order;
    order.reserve(count);
    forVisible(scene, states, stop, [&](const Gaussian &g, uint32_t i) {
        const auto p = positionRdf(g);
        uint32_t key = 0;
        for (unsigned c = 0; c < 3; ++c)
            key |= spread(unorm(normalized(p[c], low[c], high[c]), 10)) << c;
        order.push_back((uint64_t(key) << 32) | i);
    });
    return order;
}
void sortSpatialOrder(std::vector<uint64_t> &order, std::stop_token stop) {
    size_t comparisons = 0;
    std::sort(order.begin(), order.end(), [&](uint64_t a, uint64_t b) {
        if ((++comparisons & 65535) == 0)
            checkSaveStop(stop);
        return a < b;
    });
    checkSaveStop(stop);
}
// PlayCanvas splat-transform's 18-bound, 256-splat chunk layout. Seek between
// its attribute tables so only one chunk, rather than all packed vertices/SH,
// is staged in memory. Morton ordering keeps quantization local to the scene.
void writeCompressedPly(const Scene &scene, std::span<const uint8_t> states,
                        const std::filesystem::path &path, uint32_t count, std::stop_token stop) {
    const unsigned degree = std::min(scene.shDegree, 3u), rest = (degree + 1) * (degree + 1) - 1;
    const uint32_t chunks = (count + 255) / 256;
    auto order = spatialOrder(scene, states, stop);
    sortSpatialOrder(order, stop);
    std::ofstream out(path, std::ios::binary);
    out.imbue(std::locale::classic());
    if (!out)
        throw std::runtime_error("Cannot open the compressed PLY output");
    out << "ply\nformat binary_little_endian 1.0\ncomment SplatView compressed visible preview; RDF\n"
        << "element chunk " << chunks << '\n';
    for (auto name : boundNames)
        out << "property float " << name << '\n';
    out << "element vertex " << count << '\n';
    for (auto name : {"packed_position", "packed_rotation", "packed_scale", "packed_color"})
        out << "property uint " << name << '\n';
    if (rest) {
        out << "element sh " << count << '\n';
        for (unsigned i = 0; i < rest * 3; ++i)
            out << "property uchar f_rest_" << i << '\n';
    }
    out << "end_header\n";
    const std::streamoff boundsOffset = out.tellp();
    const auto vertexOffset = boundsOffset + std::streamoff(chunks) * 72;
    const auto shOffset = vertexOffset + std::streamoff(count) * 16;
    const auto converter =
        spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, degree);
    struct Sample {
        std::array<float, 3> position, color;
        ExportAxes axes;
        float opacity;
    };
    std::array<Sample, 256> samples;
    std::array<std::array<uint32_t, 4>, 256> vertices;
    std::array<uint8_t, 256 * 45> harmonics;
    for (uint32_t start = 0; start < count; start += 256) {
        checkSaveStop(stop);
        const auto length = std::min(256u, count - start);
        std::array<float, 18> bounds;
        for (unsigned group : {0u, 6u, 12u})
            for (unsigned c = 0; c < 3; ++c) {
                bounds[group + c] = std::numeric_limits<float>::infinity();
                bounds[group + c + 3] = -std::numeric_limits<float>::infinity();
            }
        for (unsigned i = 0; i < length; ++i) {
            const auto &g = scene.gaussians[uint32_t(order[start + i])];
            auto &s = samples[i];
            s.position = positionRdf(g);
            s.axes = exportAxesRdf(g);
            s.opacity = g.positionOpacity[3];
            for (unsigned c = 0; c < 3; ++c) {
                // Chunk bounds are floats; finite log scales need no fixed
                // range clamp, which would enlarge valid very small splats.
                s.color[c] = shValue(g, 0, c) * shC0 + .5f;
                for (auto group : {0u, 6u, 12u}) {
                    const float value = group == 0   ? s.position[c]
                                        : group == 6 ? s.axes.logScales[c]
                                                     : s.color[c];
                    bounds[group + c] = std::min(bounds[group + c], value);
                    bounds[group + c + 3] = std::max(bounds[group + c + 3], value);
                }
                for (unsigned j = 1; j <= rest; ++j) {
                    const float value = shValue(g, j, c) * converter.flipSh[j - 1];
                    harmonics[i * rest * 3 + c * rest + j - 1] =
                        uint8_t(std::clamp(std::floor((value / 8 + .5f) * 256), 0.f, 255.f));
                }
            }
        }
        for (unsigned i = 0; i < length; ++i) {
            const auto &s = samples[i];
            uint32_t color = unorm(s.opacity, 8);
            for (unsigned c = 0; c < 3; ++c)
                color |= unorm(normalized(s.color[c], bounds[12 + c], bounds[15 + c]), 8) << (24 - c * 8);
            vertices[i] = {pack111011(s.position, bounds.data(), bounds.data() + 3),
                           packQuaternion(s.axes.quaternion),
                           pack111011(s.axes.logScales, bounds.data() + 6, bounds.data() + 9), color};
        }
        out.seekp(boundsOffset + std::streamoff(start / 256) * 72);
        out.write(reinterpret_cast<const char *>(bounds.data()), 72);
        out.seekp(vertexOffset + std::streamoff(start) * 16);
        out.write(reinterpret_cast<const char *>(vertices.data()), std::streamsize(length) * 16);
        if (rest) {
            out.seekp(shOffset + std::streamoff(start) * rest * 3);
            out.write(reinterpret_cast<const char *>(harmonics.data()), std::streamsize(length) * rest * 3);
        }
        if (!out)
            throw std::runtime_error("The compressed PLY output could not be written completely");
    }
    finish(out);
}
void writeKsplat(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
                 uint32_t count, std::stop_token stop) {
    const unsigned degree = std::min(scene.shDegree, 3u);
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("Cannot open the KSPLAT output");
    std::array<uint8_t, 5120> header{};
    auto field = [&](size_t offset, auto value) {
        std::memcpy(header.data() + offset, &value, sizeof(value));
    };
    header[1] = 1; // v0.1, uncompressed mode 0
    field(4, uint32_t(1));
    field(8, uint32_t(1));
    field(12, count);
    field(16, count);
    field(36, -1.5f);
    field(40, 1.5f);
    field(4096, count);
    field(4100, count);
    field(4104, count);
    field(4108, uint32_t(1));
    field(4112, 10.f);
    field(4116, uint16_t(12));
    field(4120, uint32_t(32767));
    field(4128, uint32_t(1));
    field(4136, uint16_t(degree));
    out.write(reinterpret_cast<const char *>(header.data()), header.size());
    BinaryOutput binary(out);
    for (int c = 0; c < 3; ++c)
        binary.put(0.f); // Single bucket center, unused by mode-0 positions.
    const auto converter =
        spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, degree);
    forVisible(scene, states, stop, [&](const Gaussian &g, uint32_t) {
        for (float value : positionRdf(g))
            binary.put(value);
        const auto axes = exportAxesRdf(g);
        for (float value : axes.logScales)
            binary.put(std::exp(value));
        for (float value : axes.quaternion)
            binary.put(value);
        for (unsigned c = 0; c < 3; ++c)
            binary.put(uint8_t(unorm(shValue(g, 0, c) * shC0 + .5, 8)));
        binary.put(uint8_t(unorm(g.positionOpacity[3], 8)));
        // Channel-major *within each band*, unlike PLY's whole-rest layout.
        for (unsigned band = 1; band <= degree; ++band)
            for (unsigned c = 0; c < 3; ++c)
                for (unsigned j = band * band; j < (band + 1) * (band + 1); ++j)
                    binary.put(shValue(g, j, c) * converter.flipSh[j - 1]);
    });
    binary.flush();
    finish(out);
}
void writeCsv(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
              std::stop_token stop) {
    const unsigned degree = std::min(scene.shDegree, 3u), rest = (degree + 1) * (degree + 1) - 1;
    std::ofstream out(path, std::ios::binary);
    out.imbue(std::locale::classic());
    if (!out)
        throw std::runtime_error("Cannot open the CSV output");
    out << "x,y,z,f_dc_0,f_dc_1,f_dc_2";
    for (unsigned j = 0; j < rest * 3; ++j)
        out << ",f_rest_" << j;
    out << ",opacity,scale_0,scale_1,scale_2,rot_0,rot_1,rot_2,rot_3\n";
    const auto converter =
        spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, degree);
    forVisible(scene, states, stop, [&](const Gaussian &g, uint32_t) {
        std::array<char, 2048> row;
        auto cursor = row.data();
        auto value = [&](float v) {
            if (cursor != row.data())
                *cursor++ = ',';
            const auto result =
                std::to_chars(cursor, row.data() + row.size() - 1, v, std::chars_format::general,
                              std::numeric_limits<float>::max_digits10);
            if (result.ec != std::errc{})
                throw std::runtime_error("Cannot encode a CSV attribute");
            cursor = result.ptr;
        };
        for (float v : positionRdf(g))
            value(v);
        for (unsigned c = 0; c < 3; ++c)
            value(shValue(g, 0, c));
        for (unsigned c = 0; c < 3; ++c)
            for (unsigned j = 1; j <= rest; ++j)
                value(shValue(g, j, c) * converter.flipSh[j - 1]);
        const float opacity = std::clamp(g.positionOpacity[3], 1e-7f, 1 - 1e-7f);
        value(std::log(opacity / (1 - opacity)));
        const auto axes = exportAxesRdf(g);
        for (float v : axes.logScales)
            value(v);
        for (float v : axes.quaternion)
            value(v);
        *cursor++ = '\n';
        out.write(row.data(), cursor - row.data());
    });
    finish(out);
}
} // namespace preview::detail
