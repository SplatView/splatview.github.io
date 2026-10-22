#include "format_fixtures.hpp"
#include "math.hpp"
#include <load-spz.h>
#include <coordinate-system-adobe.h>
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <sstream>

namespace format_tests {
using namespace preview;
namespace {
template <class T> void put(Bytes &out, size_t offset, T value, bool big = false) {
    auto bytes = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
    if (big)
        std::reverse(bytes.begin(), bytes.end());
    std::copy(bytes.begin(), bytes.end(), out.begin() + offset);
}
template <class T> void add(Bytes &out, T value, bool big = false) {
    const auto offset = out.size();
    out.resize(offset + sizeof(T));
    put(out, offset, value, big);
}
uint8_t byte(float value) {
    return static_cast<uint8_t>(std::clamp(std::lround(value * 255), 0l, 255l));
}
Attributes rdf(Attributes a) {
    const auto c = spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, 3);
    a.position.y = -a.position.y;
    a.position.z = -a.position.z;
    for (unsigned i = 0; i < 3; ++i)
        a.quaternion[i + 1] *= c.flipQ[i];
    for (unsigned i = 1; i < 16; ++i)
        for (unsigned channel = 0; channel < 3; ++channel)
            a.sh[i * 3 + channel] *= c.flipSh[i - 1];
    return a;
}
void rgba(Bytes &out, const Attributes &a) {
    for (unsigned c = 0; c < 3; ++c)
        out.push_back(byte(0.5f + 0.28209479177387814f * a.sh[c]));
    out.push_back(byte(a.opacity));
}
} // namespace
Bytes splat(std::span<const Attributes> source) {
    Bytes out;
    for (auto a : source) {
        a = rdf(a);
        for (float value : {a.position.x, a.position.y, a.position.z, a.scale.x, a.scale.y, a.scale.z})
            add(out, value);
        rgba(out, a);
        for (float value : a.quaternion)
            out.push_back(static_cast<uint8_t>(std::clamp(std::lround(value * 128) + 128, 0l, 255l)));
    }
    return out;
}

Bytes ksplat(std::span<const Attributes> source, unsigned compression, unsigned degree) {
    // Two populated sections of different SH degree and an empty reserved section
    // between them. Compressed sections contain both full and short buckets.
    Bytes out(4096 + 3 * 1024);
    out[1] = 1;
    put<uint32_t>(out, 4, 3);
    put<uint32_t>(out, 16, static_cast<uint32_t>(source.size()));
    put<uint16_t>(out, 20, static_cast<uint16_t>(compression));
    put<float>(out, 36, -1.5f);
    put<float>(out, 40, 1.5f);
    size_t first = 0;
    for (unsigned section : {0u, 2u}) {
        const size_t count = section == 0 ? source.size() / 2 : source.size() - first;
        const unsigned shDegree = section == 0 ? degree : std::min(degree, 1u);
        const unsigned shCount = 3 * ((shDegree + 1) * (shDegree + 1) - 1);
        const unsigned shBytes = compression == 0 ? 4 : compression == 1 ? 2 : 1;
        const unsigned stride = (compression == 0 ? 44 : 24) + shCount * shBytes;
        const size_t h = 4096 + section * 1024;
        put<uint32_t>(out, h, static_cast<uint32_t>(count));
        put<uint32_t>(out, h + 4, static_cast<uint32_t>(count + 2));
        put<uint32_t>(out, h + 8, 7);
        const size_t full = count / 7, partial = count % 7 ? 2 : 0;
        // Use two short buckets (including a one-splat bucket) to exercise skips.
        const size_t fullCount = partial && count % 7 == 1 ? full - 1 : full;
        const size_t remaining = count - fullCount * 7;
        const size_t buckets = compression ? fullCount + partial : 0;
        put<uint32_t>(out, h + 12, static_cast<uint32_t>(buckets));
        put<float>(out, h + 16, 8.0f);
        put<uint16_t>(out, h + 20, compression ? 12 : 0);
        put<uint32_t>(out, h + 24, 32767);
        put<uint32_t>(out, h + 32, compression ? static_cast<uint32_t>(fullCount) : 0);
        put<uint32_t>(out, h + 36, compression ? static_cast<uint32_t>(partial) : 0);
        put<uint16_t>(out, h + 40, static_cast<uint16_t>(shDegree));
        if (compression) {
            if (partial) {
                add<uint32_t>(out, 1);
                add<uint32_t>(out, static_cast<uint32_t>(remaining - 1));
            }
            for (size_t i = 0; i < buckets; ++i)
                for (float value : {0.2f, -0.3f, 0.4f})
                    add(out, value);
        }
        for (size_t i = 0; i < count; ++i) {
            const auto a = rdf(source[first + i]);
            float p[] = {a.position.x, a.position.y, a.position.z};
            float center[] = {0.2f, -0.3f, 0.4f};
            for (unsigned c = 0; c < 3; ++c)
                if (compression)
                    add<uint16_t>(out,
                                  static_cast<uint16_t>(std::lround((p[c] - center[c]) / 4 * 32767) + 32767));
                else
                    add(out, p[c]);
            for (float value : {a.scale.x, a.scale.y, a.scale.z})
                if (compression)
                    add<uint16_t>(out, DirectX::PackedVector::XMConvertFloatToHalf(value));
                else
                    add(out, value);
            for (float value : a.quaternion)
                if (compression)
                    add<uint16_t>(out, DirectX::PackedVector::XMConvertFloatToHalf(value));
                else
                    add(out, value);
            rgba(out, a);
            for (unsigned band = 1; band <= shDegree; ++band)
                for (unsigned c = 0; c < 3; ++c)
                    for (unsigned j = 0; j < band * 2 + 1; ++j) {
                        const auto value = a.sh[(band * band + j) * 3 + c];
                        if (compression == 0)
                            add(out, value);
                        else if (compression == 1)
                            add<uint16_t>(out, DirectX::PackedVector::XMConvertFloatToHalf(value));
                        else
                            out.push_back(byte((value + 1.5f) / 3));
                    }
        }
        out.resize(out.size() + stride * 2); // Unused capacity must not become visible splats.
        first += count;
        if (section == 0) {
            put<uint32_t>(out, 4096 + 1024 + 4, 1);
            out.resize(out.size() + (compression == 0 ? 44 : 24));
        }
    }
    return out;
}

Bytes compressedPly(std::span<const Attributes> source, bool chunkColors, unsigned degree, bool big) {
    constexpr const char *names[] = {
        "min_x",       "min_y",       "min_z",       "max_x",       "max_y",       "max_z",
        "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z",
        "min_r",       "min_g",       "min_b",       "max_r",       "max_g",       "max_b"};
    const size_t chunks = (source.size() + 255) / 256;
    const unsigned shCoeffs = (degree + 1) * (degree + 1) - 1;
    std::ostringstream header;
    header << "ply\nformat " << (big ? "binary_big_endian" : "binary_little_endian") << " 1.0\nelement chunk "
           << chunks << '\n';
    for (size_t i = chunkColors ? 18 : 12; i-- > 0;)
        header << "property float " << names[i] << '\n';
    header << "element vertex " << source.size() << '\n';
    // Reverse the properties in all tables to catch assumptions about byte order.
    for (const char *name : {"packed_color", "packed_scale", "packed_rotation", "packed_position"})
        header << "property uint " << name << '\n';
    if (shCoeffs) {
        header << "element sh " << source.size() << '\n';
        for (unsigned i = shCoeffs * 3; i-- > 0;)
            header << "property uchar f_rest_" << i << '\n';
    }
    header << "end_header\n";
    auto text = header.str();
    Bytes out(text.begin(), text.end());
    std::vector<std::array<float, 18>> bounds(chunks);
    for (size_t chunk = 0; chunk < chunks; ++chunk) {
        auto &b = bounds[chunk];
        b.fill(0);
        for (unsigned group : {0u, 6u, 12u})
            for (unsigned c = 0; c < 3; ++c) {
                b[group + c] = 1e10f;
                b[group + c + 3] = -1e10f;
            }
        for (size_t i = chunk * 256; i < std::min(source.size(), (chunk + 1) * 256); ++i) {
            auto a = rdf(source[i]);
            float values[] = {a.position.x,
                              a.position.y,
                              a.position.z,
                              std::log(a.scale.x),
                              std::log(a.scale.y),
                              std::log(a.scale.z),
                              a.sh[0] * 0.2820947918f + .5f,
                              a.sh[1] * 0.2820947918f + .5f,
                              a.sh[2] * 0.2820947918f + .5f};
            for (unsigned group = 0; group < 3; ++group)
                for (unsigned c = 0; c < 3; ++c) {
                    b[group * 6 + c] = std::min(b[group * 6 + c], values[group * 3 + c]);
                    b[group * 6 + c + 3] = std::max(b[group * 6 + c + 3], values[group * 3 + c]);
                }
        }
        if (!chunkColors)
            for (unsigned c = 0; c < 3; ++c) {
                b[12 + c] = 0;
                b[15 + c] = 1;
            }
        for (size_t i = chunkColors ? 18 : 12; i-- > 0;)
            add(out, b[i], big);
    }
    auto quant = [](float value, float low, float high, unsigned bits) {
        return static_cast<uint32_t>(std::lround(
            std::clamp(high == low ? 0.f : (value - low) / (high - low), 0.f, 1.f) * ((1u << bits) - 1)));
    };
    for (size_t i = 0; i < source.size(); ++i) {
        auto a = rdf(source[i]);
        const auto &b = bounds[i / 256];
        const uint32_t position = (quant(a.position.x, b[0], b[3], 11) << 21) |
                                  (quant(a.position.y, b[1], b[4], 10) << 11) |
                                  quant(a.position.z, b[2], b[5], 11);
        const uint32_t scale = (quant(std::log(a.scale.x), b[6], b[9], 11) << 21) |
                               (quant(std::log(a.scale.y), b[7], b[10], 10) << 11) |
                               quant(std::log(a.scale.z), b[8], b[11], 11);
        unsigned largest = 0;
        for (unsigned q = 1; q < 4; ++q)
            if (std::abs(a.quaternion[q]) > std::abs(a.quaternion[largest]))
                largest = q;
        uint32_t rotation = largest;
        for (unsigned q = 0; q < 4; ++q)
            if (q != largest)
                rotation =
                    (rotation << 10) | quant(a.quaternion[q] * (a.quaternion[largest] < 0 ? -1.f : 1.f),
                                             -0.70710678118f, 0.70710678118f, 10);
        uint32_t color = 0;
        for (unsigned c = 0; c < 3; ++c)
            color = (color << 8) | quant(a.sh[c] * 0.2820947918f + .5f, b[12 + c], b[15 + c], 8);
        color = (color << 8) | byte(a.opacity);
        for (auto value : {color, scale, rotation, position})
            add(out, value, big);
    }
    for (auto a : source) {
        a = rdf(a);
        for (unsigned j = shCoeffs * 3; j-- > 0;)
            out.push_back(byte(a.sh[(j % shCoeffs + 1) * 3 + j / shCoeffs] / 8 + .5f));
    }
    return out;
}
} // namespace format_tests
