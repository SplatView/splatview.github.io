#include "model.hpp"
#include "file_io.hpp"
#include "source_snapshot.hpp"
#include "file_preferences.hpp"
#include "format_utils.hpp"
#include "parallel_for.hpp"
#include "spz_decode_test_access.hpp"
#include "math.hpp"
#include <load-spz.h>
#include <coordinate-system-adobe.h>
#include <nlohmann/json.hpp>
#include <webp/decode.h>
#include <zlib.h>
#include <libdeflate.h>
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <cwctype>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <numeric>
#include <sstream>
#include <stdexcept>

namespace preview {
namespace detail {
thread_local void (*SpzDecodeState::checkpoint_)(void *, const char *){};
thread_local void *SpzDecodeState::checkpointContext_{};
void SpzDecodeState::setCheckpoint(void (*function)(void *, const char *), void *context) noexcept {
    checkpointContext_ = context;
    checkpoint_ = function;
}
void SpzDecodeState::checkpoint(const char *stage) {
    if (checkpoint_) checkpoint_(checkpointContext_, stage);
}
struct SpzDecodeAccess {
    static void checkpoint(const char *stage) { SpzDecodeState::checkpoint(stage); }
};
} // namespace detail
using namespace detail;
namespace {
using Bytes = SceneVector<uint8_t>;
using Json = nlohmann::json;
std::shared_ptr<SceneMemory> workMemory(const LoadOptions &options) {
    return options.resources ? sceneMemoryForBudget(*options.resources, ResourceCategory::Work) : nullptr;
}
const Json &boundedArray(const Json &value, size_t minimum, size_t maximum, const char *message) {
    // The JSON DOM is bounded by the metadata input limit, but converting an
    // arbitrary array must not allocate another unbounded attribute/codebook.
    if (!value.is_array() || value.size() < minimum || value.size() > maximum)
        fail(message);
    return value;
}
enum class ScalarKind { Float, Double, Int8, Uint8, Int16, Uint16, Int32, Uint32 };
struct Property {
    std::string name, type;
    size_t offset{}, size{};
    ScalarKind kind{ScalarKind::Float};
};
size_t scalarSize(const std::string &type) {
    if (type == "char" || type == "uchar" || type == "int8" || type == "uint8")
        return 1;
    if (type == "short" || type == "ushort" || type == "int16" || type == "uint16")
        return 2;
    if (type == "int" || type == "uint" || type == "int32" || type == "uint32" || type == "float" ||
        type == "float32")
        return 4;
    if (type == "double" || type == "float64")
        return 8;
    fail("Unsupported PLY property type: " + type);
}
ScalarKind scalarKind(const std::string &type) {
    if (type == "float" || type == "float32")
        return ScalarKind::Float;
    if (type == "double" || type == "float64")
        return ScalarKind::Double;
    if (type == "char" || type == "int8")
        return ScalarKind::Int8;
    if (type == "uchar" || type == "uint8")
        return ScalarKind::Uint8;
    if (type == "short" || type == "int16")
        return ScalarKind::Int16;
    if (type == "ushort" || type == "uint16")
        return ScalarKind::Uint16;
    if (type == "int" || type == "int32")
        return ScalarKind::Int32;
    if (type == "uint" || type == "uint32")
        return ScalarKind::Uint32;
    fail("Unsupported PLY property type: " + type);
}
double scalar(std::span<const uint8_t> bytes, const Property &p, size_t base, bool big) {
    auto offset = base + p.offset;
    switch (p.kind) {
    case ScalarKind::Float:
        return number<float>(bytes, offset, big);
    case ScalarKind::Double:
        return number<double>(bytes, offset, big);
    case ScalarKind::Int8:
        return number<int8_t>(bytes, offset);
    case ScalarKind::Uint8:
        return number<uint8_t>(bytes, offset);
    case ScalarKind::Int16:
        return number<int16_t>(bytes, offset, big);
    case ScalarKind::Uint16:
        return number<uint16_t>(bytes, offset, big);
    case ScalarKind::Int32:
        return number<int32_t>(bytes, offset, big);
    case ScalarKind::Uint32:
        return number<uint32_t>(bytes, offset, big);
    }
    fail("Invalid PLY scalar type");
}
// SuperSplat / PlayCanvas packed PLY: 256-splat chunks, 11/10/11-bit
// positions/scales, smallest-three rotations, RGBA8 and optional byte SH.
Scene loadCompressedPly(std::span<const uint8_t> bytes, const LoadOptions &o, std::string_view header,
                        size_t body) {
    struct Element {
        std::string name;
        uint64_t count{};
        size_t stride{}, offset{};
        std::map<std::string, Property> fields;
    };
    std::vector<Element> elements;
    std::string line, encoding;
    std::istringstream input{std::string(header)};
    while (std::getline(input, line)) {
        std::istringstream in(line);
        std::string token;
        in >> token;
        if (token == "format")
            in >> encoding;
        else if (token == "element") {
            Element element;
            if (!(in >> element.name >> element.count) || elements.size() >= 32)
                fail("Invalid compressed PLY element");
            if (element.name != "chunk" && element.name != "vertex" && element.name != "sh")
                fail("Unsupported compressed PLY element: " + element.name);
            elements.push_back(std::move(element));
        } else if (token == "property") {
            Property p;
            if (elements.empty() || !(in >> p.type >> p.name) || p.type == "list")
                fail("Invalid compressed PLY property");
            auto &element = elements.back();
            p.size = scalarSize(p.type);
            p.kind = scalarKind(p.type);
            p.offset = element.stride;
            if (element.fields.size() >= 256 || !element.fields.emplace(p.name, p).second)
                fail("Invalid or duplicate compressed PLY property");
            element.stride += p.size;
        }
    }
    const bool big = encoding == "binary_big_endian";
    if (!big && encoding != "binary_little_endian")
        fail("Compressed PLY requires binary encoding");
    std::map<std::string, const Element *> tables;
    size_t offset = body;
    for (auto &e : elements) {
        if (!e.stride || e.count > (bytes.size() - offset) / e.stride || !tables.emplace(e.name, &e).second)
            fail("Truncated or duplicate compressed PLY element");
        e.offset = offset;
        offset += static_cast<size_t>(e.count) * e.stride;
    }
    if (!tables.contains("chunk") || !tables.contains("vertex"))
        fail("Compressed PLY needs chunk bounds and packed vertices");
    const auto &chunk = *tables.at("chunk"), &vertex = *tables.at("vertex");
    countCheck(vertex.count);
    if (chunk.count != (vertex.count + 255) / 256 || (chunk.fields.size() != 12 && chunk.fields.size() != 18))
        fail("Compressed PLY chunk count or bounds layout is invalid");
    constexpr const char *boundNames[] = {
        "min_x",       "min_y",       "min_z",       "max_x",       "max_y",       "max_z",
        "min_scale_x", "min_scale_y", "min_scale_z", "max_scale_x", "max_scale_y", "max_scale_z",
        "min_r",       "min_g",       "min_b",       "max_r",       "max_g",       "max_b"};
    const size_t boundCount = chunk.fields.size();
    std::array<Property, 18> bounds;
    for (size_t i = 0; i < boundCount; ++i) {
        if (!chunk.fields.contains(boundNames[i]))
            fail("Compressed PLY is missing chunk bounds");
        bounds[i] = chunk.fields.at(boundNames[i]);
        if (bounds[i].type != "float" && bounds[i].type != "float32")
            fail("Compressed PLY bounds must be float32");
    }
    std::array<Property, 4> packed;
    constexpr const char *packedNames[] = {"packed_position", "packed_rotation", "packed_scale",
                                           "packed_color"};
    for (unsigned i = 0; i < 4; ++i) {
        if (!vertex.fields.contains(packedNames[i]))
            fail("Compressed PLY is missing a packed vertex attribute");
        packed[i] = vertex.fields.at(packedNames[i]);
        if (packed[i].type != "uint" && packed[i].type != "uint32")
            fail("Compressed PLY packed attributes must be uint32");
    }
    std::vector<Property> sh;
    const Element *shTable = tables.contains("sh") ? tables.at("sh") : nullptr;
    if (shTable) {
        const size_t n = shTable->fields.size();
        if (shTable->count != vertex.count || (n != 9 && n != 24 && n != 45))
            fail("Invalid compressed PLY SH layout");
        for (size_t i = 0; i < n; ++i) {
            const auto name = "f_rest_" + std::to_string(i);
            if (!shTable->fields.contains(name))
                fail("Compressed PLY SH coefficients are incomplete");
            auto p = shTable->fields.at(name);
            if (p.type != "uchar" && p.type != "uint8")
                fail("Compressed PLY SH attributes must be uint8");
            sh.push_back(p);
        }
    }
    // Only this small bounds table is expanded; sampled-out vertices stay packed.
    std::vector<std::array<float, 18>> chunks(static_cast<size_t>(chunk.count));
    for (size_t i = 0; i < chunks.size(); ++i) {
        if ((i & 4095) == 0)
            canceled(o);
        auto &b = chunks[i];
        b = {0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1};
        for (size_t j = 0; j < boundCount; ++j) {
            b[j] = static_cast<float>(scalar(bytes, bounds[j], chunk.offset + i * chunk.stride, big));
            if (!std::isfinite(b[j]))
                fail("Non-finite compressed PLY bounds");
        }
        for (unsigned group : {0u, 6u, 12u})
            for (unsigned c = 0; c < 3; ++c)
                if (b[group + c] > b[group + 3 + c])
                    fail("Reversed compressed PLY bounds");
    }
    Scene scene(o.memory);
    scene.sourceCount = vertex.count;
    scene.shDegree = sh.size() == 45 ? 3 : sh.size() == 24 ? 2 : sh.size() == 9 ? 1 : 0;
    scene.format = "Compressed PLY";
    scene.yUp = true;
    const size_t loadedCount = static_cast<size_t>(std::min<uint64_t>(vertex.count, o.maxSplats));
    scene.gaussians.resize(loadedCount);
    constexpr float shC0 = 0.28209479177387814f;
    auto unpack = [](uint32_t value) {
        return std::array<float, 3>{float(value >> 21) / 2047, float((value >> 11) & 1023) / 1023,
                                    float(value & 2047) / 2047};
    };
    parallelFor(loadedCount, o.stop, [&](size_t output) {
        const size_t i = sampledIndex(output, vertex.count, loadedCount);
        const auto &b = chunks[static_cast<size_t>(i / 256)];
        uint32_t values[4];
        for (unsigned j = 0; j < 4; ++j)
            values[j] = number<uint32_t>(
                bytes, vertex.offset + static_cast<size_t>(i) * vertex.stride + packed[j].offset, big);
        const auto p = unpack(values[0]), s = unpack(values[2]);
        Attributes a;
        float position[3], scale[3];
        for (unsigned c = 0; c < 3; ++c) {
            position[c] = std::lerp(b[c], b[c + 3], p[c]);
            scale[c] = linearScale(std::lerp(b[c + 6], b[c + 9], s[c]));
            const float color = float((values[3] >> (24 - c * 8)) & 255) / 255;
            a.sh[c] = (std::lerp(b[c + 12], b[c + 15], color) - 0.5f) / shC0;
        }
        a.position = {position[0], position[1], position[2]};
        a.scale = {scale[0], scale[1], scale[2]};
        a.opacity = float(values[3] & 255) / 255;
        const unsigned missing = values[1] >> 30;
        float squared = 0;
        unsigned shift = 20;
        for (unsigned q = 0; q < 4; ++q)
            if (q != missing) {
                const float v = (float((values[1] >> shift) & 1023) / 1023 - 0.5f) * 1.41421356237f;
                a.quaternion[q] = v;
                squared += v * v;
                if (shift)
                    shift -= 10;
            }
        a.quaternion[missing] = std::sqrt(std::max(0.0f, 1 - squared));
        for (size_t j = 0; j < sh.size(); ++j) {
            const uint8_t value =
                bytes[shTable->offset + static_cast<size_t>(i) * shTable->stride + sh[j].offset];
            // Match splat-transform's midpoint reconstruction for quantized SH bins.
            const float n = value == 0 ? 0 : value == 255 ? 1 : (value + 0.5f) / 256;
            a.sh[(j % (sh.size() / 3) + 1) * 3 + j / (sh.size() / 3)] = (n - 0.5f) * 8;
        }
        plyToRub(a);
        scene.gaussians[output] = packGaussian(a);
    });
    return scene;
}
Scene loadPly(std::span<const uint8_t> bytes, const LoadOptions &o) {
    if (auto basic = loadBasicPly(bytes, o))
        return std::move(*basic);
    const size_t headerLimit = std::min<size_t>(bytes.size(), 1024 * 1024);
    std::string_view prefix(reinterpret_cast<const char *>(bytes.data()), headerLimit);
    size_t end = prefix.find("end_header");
    if (end == std::string_view::npos)
        fail("PLY header is missing or too large");
    end = prefix.find('\n', end);
    if (end == std::string_view::npos)
        fail("Incomplete PLY header");
    ++end;
    std::istringstream header(std::string(prefix.substr(0, end)));
    std::string line, encoding;
    std::vector<Property> props;
    uint64_t count = 0;
    size_t stride = 0;
    bool vertices = false, haveVertex = false;
    while (std::getline(header, line)) {
        std::istringstream in(line);
        std::string token;
        in >> token;
        if (token == "format")
            in >> encoding;
        if (token == "element") {
            std::string name;
            uint64_t n{};
            in >> name >> n;
            if (name == "chunk")
                return loadCompressedPly(bytes, o, prefix.substr(0, end), end);
            if (!haveVertex && name != "vertex" && n)
                fail("PLY vertex element must come first");
            vertices = name == "vertex";
            if (vertices) {
                count = n;
                haveVertex = true;
            }
        }
        if (token == "property" && vertices) {
            Property p;
            in >> p.type >> p.name;
            if (p.type == "list")
                fail("List properties in PLY vertices are unsupported");
            p.size = scalarSize(p.type);
            p.kind = scalarKind(p.type);
            p.offset = stride;
            stride += p.size;
            if (props.size() >= 256)
                fail("Too many PLY vertex properties");
            props.push_back(std::move(p));
        }
    }
    countCheck(count);
    std::map<std::string, size_t> fields;
    for (size_t i = 0; i < props.size(); ++i) {
        if (!fields.emplace(props[i].name, i).second)
            fail("Duplicate PLY property");
    }
    for (const auto *name : {"x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2",
                             "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"})
        if (!fields.contains(name))
            fail("This PLY is not a Gaussian-splat PLY (missing " + std::string(name) + ")");
    unsigned rest = 0;
    while (fields.contains("f_rest_" + std::to_string(rest)))
        ++rest;
    if (rest != 0 && rest != 9 && rest != 24 && rest != 45 && rest != 72)
        fail("Unsupported or incomplete PLY SH coefficient layout");
    const unsigned perChannel = rest / 3;
    // Resolve names once; no string construction or tree lookups per Gaussian.
    std::array<size_t, 3> positionFields, scaleFields, dcFields;
    std::array<size_t, 4> rotationFields;
    std::array<size_t, 45> restFields{};
    for (unsigned c = 0; c < 3; ++c) {
        positionFields[c] = fields.at(c == 0 ? "x" : c == 1 ? "y" : "z");
        scaleFields[c] = fields.at("scale_" + std::to_string(c));
        dcFields[c] = fields.at("f_dc_" + std::to_string(c));
        for (unsigned j = 0; j < std::min(perChannel, 15u); ++j)
            restFields[c * 15 + j] = fields.at("f_rest_" + std::to_string(c * perChannel + j));
    }
    for (unsigned q = 0; q < 4; ++q)
        rotationFields[q] = fields.at("rot_" + std::to_string(q));
    const auto opacityField = fields.at("opacity");
    Scene scene(o.memory);
    scene.format = "PLY";
    scene.yUp = true;
    scene.sourceCount = count;
    scene.shDegree = rest >= 45 ? 3 : rest >= 24 ? 2 : rest >= 9 ? 1 : 0;
    bool ascii = encoding == "ascii", big = encoding == "binary_big_endian";
    if (!ascii && !big && encoding != "binary_little_endian")
        fail("Unsupported PLY encoding");
    if (!ascii && (stride == 0 || count > (bytes.size() - end) / stride))
        fail("Truncated PLY vertices");
    auto decode = [&](auto value) {
        Attributes a;
        a.position = {value(positionFields[0]), value(positionFields[1]), value(positionFields[2])};
        a.scale = {linearScale(value(scaleFields[0])), linearScale(value(scaleFields[1])),
                   linearScale(value(scaleFields[2]))};
        a.opacity = sigmoid(value(opacityField));
        for (unsigned q = 0; q < 4; ++q)
            a.quaternion[q] = value(rotationFields[q]);
        for (unsigned c = 0; c < 3; ++c) {
            a.sh[c] = value(dcFields[c]);
            for (unsigned j = 0; j < std::min(perChannel, 15u); ++j)
                a.sh[(j + 1) * 3 + c] = value(restFields[c * 15 + j]);
        }
        plyToRub(a);
        return packGaussian(a);
    };
    const size_t loadedCount = static_cast<size_t>(std::min<uint64_t>(count, o.maxSplats));
    if (ascii) {
        // Text must still be consumed and validated, including skipped records.
        scene.gaussians.reserve(loadedCount);
        std::istringstream text(
            std::string(reinterpret_cast<const char *>(bytes.data() + end), bytes.size() - end));
        std::vector<double> values(props.size());
        for (uint64_t i = 0; i < count; ++i) {
            if ((i & 4095) == 0)
                canceled(o);
            for (auto &value : values)
                if (!(text >> value))
                    fail("Truncated ASCII PLY vertices");
            if (selected(i, count, o.maxSplats))
                scene.gaussians.push_back(
                    decode([&](size_t field) { return static_cast<float>(values[field]); }));
        }
    } else {
        // gsply-style direct field views: fuse activation, coordinate conversion
        // and render packing without an intermediate row/attribute array. Use
        // memcpy for unaligned headers, with the typed/endian decoder retained
        // for non-float layouts. Validate the complete payload before workers.
        const bool floats = !big && std::all_of(props.begin(), props.end(), [](const Property &p) {
            return p.kind == ScalarKind::Float;
        });
        scene.gaussians.resize(loadedCount);
        if (floats) {
            parallelFor(loadedCount, o.stop, [&](size_t output) {
                const uint8_t *row = bytes.data() + end + sampledIndex(output, count, loadedCount) * stride;
                scene.gaussians[output] = decode([&](size_t field) {
                    float value;
                    std::memcpy(&value, row + props[field].offset, sizeof(value));
                    return value;
                });
            });
        } else {
            parallelFor(loadedCount, o.stop, [&](size_t output) {
                const size_t row = end + sampledIndex(output, count, loadedCount) * stride;
                scene.gaussians[output] = decode(
                    [&](size_t field) { return static_cast<float>(scalar(bytes, props[field], row, big)); });
            });
        }
    }
    return scene;
}
Gaussian packSpzGaussian(const spz::UnpackedGaussian &g, size_t coeffs) {
    Attributes a;
    a.position = {g.position[0], g.position[1], g.position[2]};
    a.scale = {linearScale(g.scale[0]), linearScale(g.scale[1]), linearScale(g.scale[2])};
    a.quaternion = {g.rotation[3], g.rotation[0], g.rotation[1], g.rotation[2]};
    a.opacity = sigmoid(g.alpha);
    for (unsigned c = 0; c < 3; ++c)
        a.sh[c] = g.color[c];
    for (unsigned j = 0; j < std::min<size_t>(coeffs, 15); ++j) {
        a.sh[(j + 1) * 3] = g.shR[j];
        a.sh[(j + 1) * 3 + 1] = g.shG[j];
        a.sh[(j + 1) * 3 + 2] = g.shB[j];
    }
    return packGaussian(a);
}
Scene loadLegacySpz(std::span<const uint8_t> bytes, std::span<const uint8_t> header, const LoadOptions &o) {
    // Adapted from OpsiClear/gsply's libdeflate + packed-section views. The
    // trailer is an allocation hint only: validate it against the header and
    // budget, then require libdeflate to verify CRC, size and full consumption.
    const auto version = number<uint32_t>(header, 4), count = number<uint32_t>(header, 8);
    const unsigned degree = header[12], coeffs = (degree + 1) * (degree + 1) - 1;
    const size_t positionStride = version == 1 ? 6 : 9, rotationStride = version < 3 ? 3 : 4;
    const uint64_t expected = 16 + uint64_t(count) * (positionStride + 7 + rotationStride + coeffs * 3);
    if (bytes.size() < 18)
        fail("Truncated compressed SPZ");
    const size_t expandedSize = number<uint32_t>(bytes, bytes.size() - 4);
    if (expandedSize < expected || expandedSize > expected + 16 * 1024 * 1024 || expandedSize > o.maxBytes)
        fail("SPZ expansion is invalid or exceeds memory budget");
    canceled(o);
    Bytes raw(expandedSize, SceneAllocator<uint8_t>{workMemory(o)});
    std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)> decoder(
        libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
    if (!decoder)
        fail("Cannot initialize the SPZ decoder");
    size_t consumed{}, produced{};
    if (libdeflate_gzip_decompress_ex(decoder.get(), bytes.data(), bytes.size(), raw.data(), raw.size(),
                                      &consumed, &produced) != LIBDEFLATE_SUCCESS ||
        consumed != bytes.size() || produced != expandedSize ||
        std::memcmp(raw.data(), header.data(), header.size()) != 0)
        fail("Invalid compressed SPZ payload");
    // Legacy byte-pointer loading ignored extensions because the vendor's
    // borrowed stream was not seekable. Keep that coordinate/tail behavior
    // while retaining one admitted expanded owner instead of six packed copies.
    SpzDecodeAccess::checkpoint("packed.ready");
    canceled(o);
    const uint8_t *positions = raw.data() + 16;
    const uint8_t *alphas = positions + count * positionStride;
    const uint8_t *colors = alphas + count;
    const uint8_t *scales = colors + count * 3ull;
    const uint8_t *rotations = scales + count * 3ull;
    const uint8_t *sh = rotations + count * rotationStride;
    const auto converter =
        spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RUB, degree);
    Scene scene(o.memory);
    scene.format = "SPZ v" + std::to_string(version);
    scene.yUp = true;
    scene.sourceCount = count;
    scene.shDegree = std::min(degree, 3u);
    const size_t loadedCount = std::min<size_t>(count, o.maxSplats);
    canceled(o);
    scene.gaussians.resize(loadedCount);
    parallelFor(loadedCount, o.stop, [&](size_t output) {
        const size_t i = sampledIndex(output, count, loadedCount);
        spz::PackedGaussian packed;
        std::copy_n(positions + i * positionStride, positionStride, packed.position.begin());
        packed.alpha = alphas[i];
        std::copy_n(colors + i * 3, 3, packed.color.begin());
        std::copy_n(scales + i * 3, 3, packed.scale.begin());
        std::copy_n(rotations + i * rotationStride, rotationStride, packed.rotation.begin());
        const uint8_t *row = sh + i * coeffs * 3;
        for (unsigned j = 0; j < spz::SH_MAX_COEFFS; ++j) {
            packed.shR[j] = j < coeffs ? row[j * 3] : 128;
            packed.shG[j] = j < coeffs ? row[j * 3 + 1] : 128;
            packed.shB[j] = j < coeffs ? row[j * 3 + 2] : 128;
        }
        scene.gaussians[output] =
            packSpzGaussian(packed.unpack(version == 1, version >= 3, header[13], converter), coeffs);
    });
    return scene;
}
struct PackedSpzStorage {
    PackedSpzStorage(const LoadOptions &options, const std::shared_ptr<SceneMemory> &memory)
        : options(options),
          fields{Bytes{SceneAllocator<uint8_t>{memory}}, Bytes{SceneAllocator<uint8_t>{memory}},
                 Bytes{SceneAllocator<uint8_t>{memory}}, Bytes{SceneAllocator<uint8_t>{memory}},
                 Bytes{SceneAllocator<uint8_t>{memory}}, Bytes{SceneAllocator<uint8_t>{memory}}} {}
    static spz::MutableBytes allocate(void *context, spz::SplatAttribute attribute, size_t bytes) {
        auto &storage = *static_cast<PackedSpzStorage *>(context);
        canceled(storage.options);
        const auto index = static_cast<size_t>(attribute);
        if (index >= storage.fields.size() || storage.allocated[index])
            fail("Invalid SPZ attribute allocation request");
        auto &field = storage.fields[index];
        // The vendor validates every stream's complete expected length before
        // invoking any callback. SceneAllocator admits actual requested vector
        // capacity before allocating; denial propagates without fallback.
        field.resize(bytes);
        storage.allocated[index] = true;
        return {field.data(), field.size()};
    }
    static void checkpoint(void *context) {
        canceled(static_cast<PackedSpzStorage *>(context)->options);
    }
    const LoadOptions &options;
    std::array<Bytes, 6> fields;
    std::array<bool, 6> allocated{};
};
Scene loadSpz(std::span<const uint8_t> bytes, const LoadOptions &o) {
    // Inspect the small header before entering the third-party decoder.
    std::array<uint8_t, 16> header{};
    if (bytes.size() >= 16 && number<uint32_t>(bytes, 0) == spz::NGSP_MAGIC)
        std::copy_n(bytes.begin(), 16, header.begin());
    else {
        z_stream z{};
        if (inflateInit2(&z, 16 + MAX_WBITS) != Z_OK)
            fail("Cannot initialize SPZ decoder");
        z.next_in = const_cast<Bytef *>(bytes.data());
        z.avail_in = static_cast<uInt>(bytes.size());
        z.next_out = header.data();
        z.avail_out = 16;
        const int result = inflate(&z, Z_NO_FLUSH);
        const auto produced = z.total_out;
        inflateEnd(&z);
        if ((result != Z_OK && result != Z_STREAM_END) || produced != 16)
            fail("Invalid compressed SPZ header");
    }
    if (number<uint32_t>(header, 0) != spz::NGSP_MAGIC)
        fail("Invalid SPZ magic");
    const auto count = number<uint32_t>(header, 8);
    countCheck(count);
    unsigned degree = header[12];
    if (degree > 4 || header[13] > 24)
        fail("Unsupported SPZ attribute layout");
    if (bytes[0] == 0x1f) {
        const auto version = number<uint32_t>(header, 4);
        if (version < 1 || version > 3)
            fail("Unsupported legacy SPZ version");
        // Flag-2 legacy records were ignored on the vendor byte-pointer path.
        // Use the same single admitted expansion for every v1-v3 file without
        // activating those records or inflating/copying the attributes again.
        return loadLegacySpz(bytes, header, o);
    } else {
        auto toc = number<uint32_t>(bytes, 16);
        if (toc < 32 || toc > 16 * 1024 * 1024 || toc > bytes.size())
            fail("Invalid SPZ extension area");
    }
    canceled(o);
    // All six caller-owned full packed arrays are allocated before stream
    // decode. The synchronous view never owns or retains these bytes; storage
    // remains alive through sampled Scene conversion and every failure path.
    PackedSpzStorage storage(o, workMemory(o));
    spz::PackedGaussiansView cloud;
    const spz::PackedDecodeCallbacks callbacks{&storage, &PackedSpzStorage::allocate,
                                              &PackedSpzStorage::checkpoint};
    if (!spz::loadSpzPackedInto(bytes.data(), bytes.size(), callbacks, &cloud))
        fail("SPZ decoding failed");
    SpzDecodeAccess::checkpoint("packed.ready");
    canceled(o);
    if (cloud.numPoints <= 0 || static_cast<uint32_t>(cloud.numPoints) != count ||
        cloud.shDegree != static_cast<int>(degree))
        fail("SPZ decoding failed");
    const auto converter = spz::coordinateConverter(cloud.coordinates, spz::CoordinateSystem::RUB, degree);
    const size_t coeffs = (degree + 1) * (degree + 1) - 1;
    const size_t positionStride = cloud.usesFloat16() ? 6 : 9;
    if (cloud.positions.size != count * positionStride || cloud.scales.size != count * 3ull ||
        cloud.rotations.size != count * (cloud.usesQuaternionSmallestThree ? 4ull : 3ull) ||
        cloud.alphas.size != count || cloud.colors.size != count * 3ull ||
        cloud.sh.size != count * coeffs * 3)
        fail("SPZ attribute sizes do not match the declared point count");
    Scene scene(o.memory);
    scene.format = "SPZ v" + std::to_string(cloud.version);
    scene.yUp = true;
    scene.sourceCount = count;
    scene.shDegree = std::min(degree, 3u);
    const size_t loadedCount = std::min<size_t>(count, o.maxSplats);
    canceled(o);
    scene.gaussians.resize(loadedCount);
    parallelFor(loadedCount, o.stop, [&](size_t output) {
        const size_t i = sampledIndex(output, count, loadedCount);
        scene.gaussians[output] = packSpzGaussian(cloud.unpack(static_cast<int32_t>(i), converter), coeffs);
    });
    return scene;
}
struct ArchiveMember {
    explicit ArchiveMember(const std::shared_ptr<SceneMemory> &memory)
        : inflated(SceneAllocator<uint8_t>{memory}) {}
    Bytes inflated;
    std::span<const uint8_t> stored;
    std::span<const uint8_t> bytes() const {
        return inflated.empty() ? stored : std::span<const uint8_t>(inflated);
    }
};
// Stored WebPs reference the input directly. Deflated members own only their
// expanded bytes; no archive paths are ever extracted to disk.
std::map<std::string, ArchiveMember> unzip(std::span<const uint8_t> data, const LoadOptions &o) {
    size_t eocd = std::string::npos;
    if (data.size() < 22)
        fail("Truncated SOG archive");
    for (size_t i = data.size() - 22;; --i) {
        if (number<uint32_t>(data, i) == 0x06054b50 &&
            i + 22 + number<uint16_t>(data, i + 20) == data.size()) {
            eocd = i;
            break;
        }
        if (!i || data.size() - i > 65557)
            break;
    }
    if (eocd == std::string::npos)
        fail("SOG ZIP directory is missing");
    if (number<uint16_t>(data, eocd + 4) || number<uint16_t>(data, eocd + 6))
        fail("Multi-volume ZIP is unsupported");
    size_t count = number<uint16_t>(data, eocd + 10), offset = number<uint32_t>(data, eocd + 16);
    if (count == 65535 || offset == 0xffffffffu)
        fail("ZIP64 SOG archives are not supported in this version");
    if (count > 128)
        fail("Too many SOG archive members");
    std::map<std::string, ArchiveMember> result;
    const auto memory = workMemory(o);
    size_t total = 0;
    for (size_t i = 0; i < count; ++i) {
        canceled(o);
        if (number<uint32_t>(data, offset) != 0x02014b50)
            fail("Invalid SOG ZIP entry");
        auto flags = number<uint16_t>(data, offset + 8), method = number<uint16_t>(data, offset + 10);
        auto crc = number<uint32_t>(data, offset + 16), compressed = number<uint32_t>(data, offset + 20),
             expanded = number<uint32_t>(data, offset + 24);
        size_t nameSize = number<uint16_t>(data, offset + 28), extra = number<uint16_t>(data, offset + 30),
               comment = number<uint16_t>(data, offset + 32);
        size_t local = number<uint32_t>(data, offset + 42);
        if (offset + 46 > data.size() || nameSize + extra + comment > data.size() - offset - 46)
            fail("Truncated SOG ZIP directory");
        std::string name(reinterpret_cast<const char *>(data.data() + offset + 46), nameSize);
        offset += 46 + nameSize + extra + comment;
        if (flags & 1)
            fail("Encrypted SOG archives are unsupported");
        if (name.empty() || name.front() == '/' || name.find_first_of("\\:") != std::string::npos ||
            name.find('\0') != std::string::npos)
            fail("Unsafe SOG archive member path");
        for (size_t begin = 0; begin < name.size();) {
            auto end = name.find('/', begin);
            if (end == std::string::npos)
                end = name.size();
            auto part = name.substr(begin, end - begin);
            if (part.empty() || part == "." || part == "..")
                fail("Unsafe SOG archive member path");
            begin = end + 1;
        }
        if (name.back() == '/') {
            if (expanded)
                fail("Invalid SOG archive directory");
            continue;
        }
        if (expanded > 512ull * 1024 * 1024 || total > o.maxBytes || expanded > o.maxBytes - total)
            fail("SOG archive exceeds memory budget");
        if (number<uint32_t>(data, local) != 0x04034b50)
            fail("Invalid local SOG ZIP header");
        size_t start = local + 30 + number<uint16_t>(data, local + 26) + number<uint16_t>(data, local + 28);
        if (start > data.size() || compressed > data.size() - start)
            fail("Truncated SOG ZIP member");
        ArchiveMember member(memory);
        if (method == 0) {
            if (compressed != expanded)
                fail("Invalid stored ZIP size");
            member.stored = data.subspan(start, expanded);
        } else if (method == 8) {
            member.inflated.resize(std::max(expanded, 1u));
            std::unique_ptr<libdeflate_decompressor, decltype(&libdeflate_free_decompressor)> decoder(
                libdeflate_alloc_decompressor(), libdeflate_free_decompressor);
            if (!decoder)
                fail("Cannot decode ZIP");
            size_t consumed{}, produced{};
            if (libdeflate_deflate_decompress_ex(decoder.get(), data.data() + start, compressed,
                                                 member.inflated.data(), member.inflated.size(), &consumed,
                                                 &produced) != LIBDEFLATE_SUCCESS ||
                consumed != compressed || produced != expanded)
                fail("Invalid compressed SOG member");
            member.inflated.resize(expanded);
            canceled(o); // Native inflate is not internally interruptible.
        } else
            fail("Unsupported SOG ZIP compression");
        const auto view = member.bytes();
        if (libdeflate_crc32(0, view.data(), view.size()) != crc)
            fail("SOG member checksum mismatch");
        canceled(o);
        total += expanded;
        if (!result.emplace(std::move(name), std::move(member)).second)
            fail("Duplicate SOG archive member");
    }
    return result;
}
struct Texture {
    Texture() = default;
    explicit Texture(const std::shared_ptr<SceneMemory> &memory)
        : rgba(SceneAllocator<uint8_t>{memory}) {}
    int width{}, height{};
    Bytes rgba;
    const uint8_t *pixel(size_t i) const {
        if (i >= static_cast<size_t>(width) * height)
            fail("SOG texture is too small");
        return rgba.data() + i * 4;
    }
};
Scene loadSog(const std::function<std::span<const uint8_t>(const std::string &)> &read,
              const LoadOptions &o) {
    auto metadata = read("meta.json");
    if (metadata.size() > 16 * 1024 * 1024)
        fail("SOG metadata is too large");
    const auto meta = Json::parse(metadata.begin(), metadata.end());
    const int version = meta.value("version", 1);
    if (version != 1 && version != 2)
        fail("Only SOG versions 1 and 2 are supported");
    const bool legacy = version == 1;
    uint64_t count{};
    if (legacy) {
        const auto shape = boundedArray(meta.at("means").at("shape"), 2, 2,
                                        "Invalid legacy SOG position shape").get<std::vector<uint64_t>>();
        if (shape[1] != 3)
            fail("Invalid legacy SOG position shape");
        count = shape[0];
    } else
        count = meta.at("count").get<uint64_t>();
    countCheck(count);
    // Reject oversized secondary arrays before decoding any image planes.
    for (const auto *bound : {"mins", "maxs"}) {
        boundedArray(meta.at("means").at(bound), 3, 3, "Invalid SOG position bounds");
        if (legacy) {
            boundedArray(meta.at("scales").at(bound), 3, 3, "Invalid legacy SOG attribute range");
            boundedArray(meta.at("sh0").at(bound), 4, 4, "Invalid legacy SOG attribute range");
        }
    }
    if (!legacy) {
        boundedArray(meta.at("scales").at("codebook"), 1, 256, "Invalid SOG scale codebook size");
        boundedArray(meta.at("sh0").at("codebook"), 1, 256, "Invalid SOG color codebook size");
        if (meta.contains("shN") && !meta.at("shN").is_null())
            boundedArray(meta.at("shN").at("codebook"), 1, 256, "Invalid SOG SH codebook size");
    }
    const auto memory = workMemory(o);
    size_t decoded = 0;
    auto texture = [&](const char *key, size_t fileIndex = 0) {
        canceled(o);
        const auto name = meta.at(key).at("files").at(fileIndex).get<std::string>();
        if (name.empty() || name.find("..") != std::string::npos ||
            name.find_first_of("/\\:") != std::string::npos)
            fail("Unsafe SOG texture filename");
        auto data = read(name);
        Texture image(memory);
        if (!WebPGetInfo(data.data(), data.size(), &image.width, &image.height) || image.width < 1 ||
            image.height < 1)
            fail("Invalid SOG WebP image: " + name);
        if (image.width > std::numeric_limits<int>::max() / 4)
            fail("SOG WebP row stride exceeds decoder limits");
        const size_t bytes = imagePayloadBytes(unsigned(image.width), unsigned(image.height));
        if (bytes > o.maxBytes || decoded > o.maxBytes - bytes)
            fail("Decoded SOG textures exceed memory budget");
        image.rgba.resize(bytes);
        decoded += bytes;
        if (!WebPDecodeRGBAInto(data.data(), data.size(), image.rgba.data(), bytes, image.width * 4))
            fail("SOG WebP decoding failed");
        canceled(o); // Preserve cancellation after the noninterruptible codec call.
        return image;
    };
    auto lo = texture("means"), hi = texture("means", 1), scale = texture("scales"),
         rotation = texture("quats"), color = texture("sh0");
    for (const auto *image : {&hi, &scale, &rotation, &color})
        if (image->width != lo.width || image->height != lo.height)
            fail("SOG property dimensions disagree");
    if (count > static_cast<uint64_t>(lo.width) * lo.height)
        fail("SOG count exceeds the image dimensions");
    auto mins = meta.at("means").at("mins").get<std::vector<float>>(),
         maxs = meta.at("means").at("maxs").get<std::vector<float>>();
    if (mins.size() != 3 || maxs.size() != 3)
        fail("Invalid SOG position bounds");
    for (int i = 0; i < 3; ++i)
        if (!std::isfinite(mins[i]) || !std::isfinite(maxs[i]) || mins[i] > maxs[i] ||
            std::abs(mins[i]) > 40 || std::abs(maxs[i]) > 40)
            fail("Invalid SOG coordinate range");
    auto range = [&](const char *key, size_t components) {
        auto low = meta.at(key).at("mins").get<std::vector<float>>();
        auto high = meta.at(key).at("maxs").get<std::vector<float>>();
        if (low.size() != components || high.size() != components)
            fail("Invalid legacy SOG attribute range");
        for (size_t i = 0; i < components; ++i)
            if (!std::isfinite(low[i]) || !std::isfinite(high[i]) || low[i] > high[i])
                fail("Invalid legacy SOG attribute bounds");
        return std::pair{std::move(low), std::move(high)};
    };
    std::vector<float> scales, colors, scaleMin, scaleMax, colorMin, colorMax;
    if (legacy) {
        auto s = range("scales", 3), c = range("sh0", 4);
        scaleMin = std::move(s.first);
        scaleMax = std::move(s.second);
        colorMin = std::move(c.first);
        colorMax = std::move(c.second);
    } else {
        scales = meta.at("scales").at("codebook").get<std::vector<float>>();
        colors = meta.at("sh0").at("codebook").get<std::vector<float>>();
    }
    auto lookup = [](const std::vector<float> &book, uint8_t index) {
        if (book.empty() || book.size() > 256 || index >= book.size() || !std::isfinite(book[index]))
            fail("Invalid SOG codebook index or value");
        return book[index];
    };
    Texture centroids, labels;
    std::vector<float> ac;
    unsigned degree = 0;
    size_t palette = 0, coeffs = 0;
    float shMin = 0, shMax = 0;
    if (meta.contains("shN") && !meta.at("shN").is_null()) {
        centroids = texture("shN");
        labels = texture("shN", 1);
        if (legacy) {
            degree = centroids.width == 192 ? 1 : centroids.width == 512 ? 2 : centroids.width == 960 ? 3 : 0;
            palette = static_cast<size_t>(centroids.height) * 64;
            shMin = meta.at("shN").at("mins").get<float>();
            shMax = meta.at("shN").at("maxs").get<float>();
            if (!std::isfinite(shMin) || !std::isfinite(shMax) || shMin > shMax)
                fail("Invalid legacy SOG SH range");
        } else {
            degree = meta.at("shN").at("bands").get<unsigned>();
            palette = meta.at("shN").at("count").get<size_t>();
            ac = meta.at("shN").at("codebook").get<std::vector<float>>();
        }
        if (degree < 1 || degree > 3)
            fail("Unsupported SOG SH bands");
        coeffs = (degree + 1) * (degree + 1) - 1;
        if (!palette || palette > 65536)
            fail("Invalid SOG SH palette size");
        if (labels.width != lo.width || labels.height != lo.height || static_cast<size_t>(centroids.width) != 64 * coeffs ||
            static_cast<size_t>(centroids.height) * 64 < palette)
            fail("Invalid SOG SH texture dimensions");
    }
    Scene scene(o.memory);
    scene.sourceCount = count;
    scene.shDegree = degree;
    scene.format = legacy ? "SOG v1" : "SOG v2";
    scene.yUp = true;
    const size_t loadedCount = static_cast<size_t>(std::min<uint64_t>(count, o.maxSplats));
    scene.gaussians.resize(loadedCount);
    parallelFor(loadedCount, o.stop, [&](size_t output) {
        const size_t i = sampledIndex(output, count, loadedCount);
        const auto l = lo.pixel(i), h = hi.pixel(i), s = scale.pixel(i), q = rotation.pixel(i),
                   c = color.pixel(i);
        Attributes a;
        float position[3], linear[3];
        for (unsigned j = 0; j < 3; ++j) {
            const float v = mins[j] + ((h[j] << 8) | l[j]) / 65535.0f * (maxs[j] - mins[j]);
            position[j] = std::copysign(std::expm1(std::abs(v)), v);
            linear[j] = linearScale(legacy ? std::lerp(scaleMin[j], scaleMax[j], s[j] / 255.0f)
                                           : lookup(scales, s[j]));
            a.sh[j] = legacy ? std::lerp(colorMin[j], colorMax[j], c[j] / 255.0f) : lookup(colors, c[j]);
        }
        a.position = {position[0], position[1], position[2]};
        a.scale = {linear[0], linear[1], linear[2]};
        if (q[3] < 252)
            fail("Invalid SOG quaternion mode");
        unsigned missing = q[3] - 252, channel = 0;
        float squared = 0;
        for (unsigned j = 0; j < 4; ++j)
            if (j != missing) {
                float v = (q[channel++] / 255.0f - 0.5f) * 1.41421356237f;
                a.quaternion[j] = v;
                squared += v * v;
            }
        a.quaternion[missing] = std::sqrt(std::max(0.0f, 1 - squared));
        a.opacity = legacy ? sigmoid(std::lerp(colorMin[3], colorMax[3], c[3] / 255.0f)) : c[3] / 255.0f;
        if (degree) {
            const auto label = labels.pixel(i);
            size_t index = label[0] | (label[1] << 8);
            if (index >= palette)
                fail("SOG SH label is outside its palette");
            for (size_t j = 0; j < coeffs; ++j) {
                const auto values = centroids.pixel(index * coeffs + j);
                for (unsigned channelIndex = 0; channelIndex < 3; ++channelIndex)
                    a.sh[(j + 1) * 3 + channelIndex] =
                        legacy ? std::lerp(shMin, shMax, values[channelIndex] / 255.0f)
                               : lookup(ac, values[channelIndex]);
            }
        }
        // splat-transform bakes SOG v1/v2 to the same on-disk space as PLY,
        // including the quaternion and SH basis. Normalize all three together.
        plyToRub(a);
        scene.gaussians[output] = packGaussian(a);
    });
    return scene;
}
} // namespace
Scene loadScene(std::span<const uint8_t> bytes, LoadOptions o) {
    if (!o.maxSplats || o.maxSplats > 10'000'000)
        fail("Invalid splat budget");
    if (bytes.size() < 4 || bytes.size() > o.maxBytes)
        fail("File is empty, truncated, or exceeds memory budget");
    canceled(o);
    if(o.resources) o.memory=sceneMemoryForBudget(*o.resources);
    if (o.format == InputFormat::Unsupported)
        fail("ZIP files are not supported. Open a .sog or .sogs scene instead.");
    if (o.format == InputFormat::Sog && !(bytes[0] == 'P' && bytes[1] == 'K'))
        fail("A bundled SOG / SOGS scene must contain a SOG archive");
    Scene scene(o.memory);
    if (o.format == InputFormat::Splat)
        scene = loadSplat(bytes, o);
    else if (o.format == InputFormat::Ksplat)
        scene = loadKsplat(bytes, o);
    else if (std::memcmp(bytes.data(), "ply", 3) == 0)
        scene = loadPly(bytes, o);
    else if (bytes[0] == 'P' && bytes[1] == 'K') {
        auto members = unzip(bytes, o);
        std::string prefix;
        size_t metadataCount = 0;
        for (const auto &[name, unused] : members)
            if (name == "meta.json" || name.ends_with("/meta.json")) {
                prefix = name.substr(0, name.size() - 9);
                ++metadataCount;
            }
        if (metadataCount != 1)
            fail("SOG archive must contain one meta.json scene");
        scene = loadSog(
            [&](const std::string &name) {
                auto it = members.find(prefix + name);
                if (it == members.end())
                    fail("SOG archive is missing " + name);
                return it->second.bytes();
            },
            o);
    } else if (number<uint32_t>(bytes, 0) == spz::NGSP_MAGIC || (bytes[0] == 0x1f && bytes[1] == 0x8b))
        scene = loadSpz(bytes, o);
    else if (bytes.size() >= 4096 && bytes[0] == 0 && bytes[1] != 0 && bytes[2] == 0 && bytes[3] == 0)
        scene = loadKsplat(bytes, o);
    else if (std::memcmp(bytes.data(), "RAD0", 4) == 0 || std::memcmp(bytes.data(), "RADC", 4) == 0)
        fail("Spark RAD streaming containers are not supported in this version");
    else if (bytes.size() % 32 == 0)
        scene = loadSplat(bytes, o);
    else
        fail("Not a supported PLY, SPZ, SPLAT, KSPLAT, or bundled SOG file");
    fitBounds(scene,o.resources ? sceneMemoryForBudget(*o.resources,ResourceCategory::Work) : nullptr);
    scene.sourceContentKey = contentKey(bytes, o.stop);
    scene.sourceBytes = bytes.size();
    return scene;
}
LoadedScene loadSceneWithSources(const std::filesystem::path &file, LoadOptions o) {
    canceled(o);
    if(o.resources) o.memory=sceneMemoryForBudget(*o.resources);
    if (!o.maxSplats || o.maxSplats > 10'000'000)
        fail("Invalid splat budget");
    if (std::filesystem::is_directory(file) || file.filename() == L"meta.json") {
        SourceSnapshot snapshot(file,o.maxBytes,o.stop,o.resources);
        auto scene = loadSog(
            [&](const std::string &name) {
                return snapshot.member(name);
            },
            o);
        fitBounds(scene,o.resources ? sceneMemoryForBudget(*o.resources,ResourceCategory::Work) : nullptr);
        scene.sourceContentKey=snapshot.stamp().contentKey;
        scene.sourceFileIdentity=snapshot.stamp().identity;
        scene.sourceBytes=snapshot.stamp().bytes;
        scene.defaultView = readDefaultView(file,scene.sourceContentKey);
        auto members = snapshot.files();
        return {std::move(scene), std::move(members)};
    }
    if (o.format == InputFormat::Auto)
        o.format = inputFormatForPath(file);
    if (o.format == InputFormat::Unsupported)
        fail("ZIP files are not supported. Open a .sog or .sogs scene instead.");
    FileSnapshot input(file, o.maxBytes, o.stop,o.resources);
    canceled(o);
    auto scene = loadScene(input.bytes(), o);
    scene.sourceFileIdentity = input.identity();
    try {
        if (fileIdentity(file) == scene.sourceFileIdentity)
            scene.defaultView = readDefaultView(file, scene.sourceContentKey);
    } catch (...) {
        // An atomic replacement/deletion must not invalidate the mapped input.
    }
    return {std::move(scene), {file}};
}
Scene loadScene(const std::filesystem::path &file, LoadOptions o) {
    return loadSceneWithSources(file, std::move(o)).scene;
}
InputFormat inputFormatForPath(const std::filesystem::path &path) {
    auto extension = pathUtf8(path.extension());
    std::transform(extension.begin(), extension.end(), extension.begin(),
                   [](unsigned char c) { return char(std::tolower(c)); });
    return extension == ".splat" ? InputFormat::Splat : extension == ".ksplat" ? InputFormat::Ksplat :
           extension == ".sog" || extension == ".sogs" ? InputFormat::Sog :
           extension == ".zip" ? InputFormat::Unsupported : InputFormat::Auto;
}

} // namespace preview
