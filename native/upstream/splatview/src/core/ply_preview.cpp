#include "format_utils.hpp"
#include <charconv>
#include <cctype>
#include <limits>
#include <locale>
#include <numeric>
#include <sstream>
#include <unordered_set>

namespace preview::detail {
namespace {
enum class Type { I8, U8, I16, U16, I32, U32, F32, F64 };
Type type(const std::string &name) {
    if (name == "char" || name == "int8")
        return Type::I8;
    if (name == "uchar" || name == "uint8")
        return Type::U8;
    if (name == "short" || name == "int16")
        return Type::I16;
    if (name == "ushort" || name == "uint16")
        return Type::U16;
    if (name == "int" || name == "int32")
        return Type::I32;
    if (name == "uint" || name == "uint32")
        return Type::U32;
    if (name == "float" || name == "float32")
        return Type::F32;
    if (name == "double" || name == "float64")
        return Type::F64;
    fail("Unsupported PLY property type: " + name);
}
bool integer(Type t) {
    return t < Type::F32;
}
size_t width(Type t) {
    constexpr size_t sizes[]{1, 1, 2, 2, 4, 4, 4, 8};
    return sizes[size_t(t)];
}
struct Property {
    std::string name;
    Type value{}, count{};
    bool list{};
};
struct Element {
    std::string name;
    uint64_t count{};
    std::vector<Property> properties;
};
struct Header {
    std::vector<Element> elements;
    size_t body{};
    bool ascii{}, big{}, gaussian{};
};
Header header(std::span<const uint8_t> bytes) {
    Header out;
    const std::string_view text(reinterpret_cast<const char *>(bytes.data()),
                                std::min(bytes.size(), size_t(1024 * 1024)));
    size_t at = 0;
    bool format = false;
    while (at < text.size()) {
        auto end = text.find('\n', at);
        if (end == std::string_view::npos)
            break;
        auto line = text.substr(at, end - at);
        if (line.ends_with('\r'))
            line.remove_suffix(1);
        if (at == 0 && line != "ply")
            fail("Invalid PLY header");
        at = end + 1;
        std::istringstream in{std::string(line)};
        in.imbue(std::locale::classic());
        std::string token;
        in >> token;
        if (token == "format") {
            std::string encoding, version;
            if (format || !(in >> encoding >> version) || version != "1.0")
                fail("Invalid PLY format declaration");
            out.ascii = encoding == "ascii";
            out.big = encoding == "binary_big_endian";
            if (!out.ascii && !out.big && encoding != "binary_little_endian")
                fail("Unsupported PLY encoding");
            format = true;
        } else if (token == "element") {
            Element element;
            std::string count;
            if (!(in >> element.name >> count) || out.elements.size() >= 64)
                fail("Invalid PLY element declaration");
            const auto parsed = std::from_chars(count.data(), count.data() + count.size(), element.count);
            if (parsed.ec != std::errc{} || parsed.ptr != count.data() + count.size() ||
                element.count > maxSourceSplats)
                fail("PLY elements are limited to 10 million records");
            if (std::any_of(out.elements.begin(), out.elements.end(),
                            [&](const auto &e) { return e.name == element.name; }))
                fail("Duplicate PLY element");
            out.gaussian |= element.name == "chunk";
            out.elements.push_back(std::move(element));
        } else if (token == "property") {
            if (out.elements.empty() || out.elements.back().properties.size() >= 256)
                fail("Invalid PLY property declaration");
            Property p;
            std::string value, count;
            if (!(in >> value))
                fail("Invalid PLY property declaration");
            p.list = value == "list";
            if (p.list) {
                if (!(in >> count >> value >> p.name))
                    fail("Invalid PLY list declaration");
                p.count = type(count);
                if (!integer(p.count))
                    fail("PLY list counts must use an integer type");
            } else if (!(in >> p.name))
                fail("Invalid PLY property declaration");
            p.value = type(value);
            auto &element = out.elements.back();
            if (std::any_of(element.properties.begin(), element.properties.end(),
                            [&](const auto &v) { return v.name == p.name; }))
                fail("Duplicate PLY property");
            if (element.name == "vertex")
                out.gaussian |= p.name.starts_with("scale_") || p.name.starts_with("rot_") ||
                                p.name.starts_with("f_dc_") || p.name.starts_with("f_rest_");
            element.properties.push_back(std::move(p));
        } else if (token == "end_header") {
            if (!format)
                fail("PLY format declaration is missing");
            out.body = at;
            return out;
        } else if (!token.empty() && token != "ply" && token != "comment" && token != "obj_info")
            fail("Unsupported PLY header declaration: " + token);
    }
    fail("PLY header is missing or too large");
}
class Reader {
    std::span<const uint8_t> bytes_;
    bool ascii_, big_;
    const LoadOptions &options_;

  public:
    size_t at;
    Reader(std::span<const uint8_t> bytes, const Header &h, const LoadOptions &o, size_t offset)
        : bytes_(bytes), ascii_(h.ascii), big_(h.big), options_(o), at(offset) {}
    double value(Type t) {
        if (ascii_) {
            while (at < bytes_.size() && std::isspace(bytes_[at]))
                ++at;
            auto first = reinterpret_cast<const char *>(bytes_.data() + at);
            while (at < bytes_.size() && !std::isspace(bytes_[at]))
                ++at;
            const auto end = reinterpret_cast<const char *>(bytes_.data() + at);
            if (first != end && *first == '+')
                ++first;
            double result{};
            const auto parsed = std::from_chars(first, end, result);
            if (parsed.ec != std::errc{} || parsed.ptr != end || first == end)
                fail("Invalid or truncated ASCII PLY data");
            if (integer(t)) {
                constexpr double low[]{-128, 0, -32768, 0, -2147483648., 0};
                constexpr double high[]{127, 255, 32767, 65535, 2147483647., 4294967295.};
                if (!std::isfinite(result) || std::trunc(result) != result || result < low[size_t(t)] ||
                    result > high[size_t(t)])
                    fail("PLY integer is outside its declared range");
            }
            return t == Type::F32 ? double(float(result)) : result;
        }
        const auto offset = at;
        if (width(t) > bytes_.size() - at)
            fail("Truncated binary PLY data");
        at += width(t);
        switch (t) {
        case Type::I8:
            return number<int8_t>(bytes_, offset);
        case Type::U8:
            return number<uint8_t>(bytes_, offset);
        case Type::I16:
            return number<int16_t>(bytes_, offset, big_);
        case Type::U16:
            return number<uint16_t>(bytes_, offset, big_);
        case Type::I32:
            return number<int32_t>(bytes_, offset, big_);
        case Type::U32:
            return number<uint32_t>(bytes_, offset, big_);
        case Type::F32:
            return number<float>(bytes_, offset, big_);
        case Type::F64:
            return number<double>(bytes_, offset, big_);
        }
        fail("Invalid PLY scalar");
    }
    size_t count(Type t) {
        const auto n = value(t);
        if (n < 0 || n > 1'000'000)
            fail("Invalid or excessive PLY list length");
        return size_t(n);
    }
    void skip(Type t, size_t n = 1) {
        if (!ascii_) {
            if (n > (bytes_.size() - at) / width(t))
                fail("Truncated PLY list");
            at += n * width(t);
        } else
            for (size_t i = 0; i < n; ++i) {
                if (!(i & 4095))
                    canceled(options_);
                value(t);
            }
    }
    void skip(const Element &e) {
        for (const auto &p : e.properties)
            skip(p.value, p.list ? count(p.count) : 1);
    }
};
int field(const Element &e, std::string_view name) {
    for (size_t i = 0; i < e.properties.size(); ++i)
        if (e.properties[i].name == name && !e.properties[i].list)
            return int(i);
    return -1;
}
uint8_t color(double value, Type t) {
    if (!std::isfinite(value))
        fail("PLY vertex colors must be finite");
    const double maximum = t == Type::U16 ? 65535 : t == Type::U32 ? 4294967295. : integer(t) ? 255 : 1;
    return uint8_t(std::lround(std::clamp(value / maximum, 0., 1.) * 255));
}
// Ear clipping also handles concave polygons; a fan would fill their cutouts.
template <class Emit>
void triangulate(std::vector<uint32_t> polygon, std::span<const PreviewVertex> vertices, const LoadOptions &o,
                 Emit emit) {
    polygon.erase(std::unique(polygon.begin(), polygon.end()), polygon.end());
    if (polygon.size() > 1 && polygon.front() == polygon.back())
        polygon.pop_back();
    if (polygon.size() < 3)
        return;
    if (polygon.size() == 3) {
        emit(std::array{polygon[0], polygon[1], polygon[2]});
        return;
    }
    double normal[3]{};
    for (size_t i = 0; i < polygon.size(); ++i) {
        const auto a = vertices[polygon[i]].position,
                   b = vertices[polygon[(i + 1) % polygon.size()]].position;
        normal[0] += (double(a.y) - b.y) * (double(a.z) + b.z);
        normal[1] += (double(a.z) - b.z) * (double(a.x) + b.x);
        normal[2] += (double(a.x) - b.x) * (double(a.y) + b.y);
    }
    unsigned drop = 0;
    for (unsigned i = 1; i < 3; ++i)
        if (std::abs(normal[i]) > std::abs(normal[drop]))
            drop = i;
    if (normal[drop] == 0)
        return;
    struct Point {
        double x, y;
    };
    auto point = [&](uint32_t index) {
        const auto p = vertices[index].position;
        const double xyz[]{p.x, p.y, p.z};
        return Point{xyz[(drop + 1) % 3], xyz[(drop + 2) % 3]};
    };
    auto cross = [](Point a, Point b, Point c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    };
    const double sign = normal[drop] > 0 ? 1 : -1;
    while (polygon.size() > 3) {
        canceled(o);
        bool found = false;
        for (size_t i = 0; i < polygon.size(); ++i) {
            const size_t previous = (i + polygon.size() - 1) % polygon.size(),
                         next = (i + 1) % polygon.size();
            const auto a = point(polygon[previous]), b = point(polygon[i]), c = point(polygon[next]);
            const double turn = cross(a, b, c) * sign;
            if (turn < 0)
                continue;
            if (turn == 0) {
                polygon.erase(polygon.begin() + i);
                found = true;
                break;
            }
            bool contains = false;
            for (size_t j = 0; j < polygon.size(); ++j) {
                if (j == previous || j == i || j == next)
                    continue;
                const auto p = point(polygon[j]);
                if (cross(a, b, p) * sign >= 0 && cross(b, c, p) * sign >= 0 && cross(c, a, p) * sign >= 0) {
                    contains = true;
                    break;
                }
            }
            if (contains)
                continue;
            emit(std::array{polygon[previous], polygon[i], polygon[next]});
            polygon.erase(polygon.begin() + i);
            found = true;
            break;
        }
        if (!found)
            fail("PLY face is not a simple polygon");
    }
    if (polygon.size() == 3)
        emit(std::array{polygon[0], polygon[1], polygon[2]});
}
} // namespace
std::optional<Scene> loadBasicPly(std::span<const uint8_t> bytes, const LoadOptions &o) {
    const auto h = header(bytes);
    if (h.gaussian)
        return {};
    const Element *vertex = nullptr, *face = nullptr;
    int indices = -1;
    for (const auto &e : h.elements) {
        if (e.name == "vertex")
            vertex = &e;
        if (e.name == "face" && e.count) {
            face = &e;
            for (size_t i = 0; i < e.properties.size(); ++i)
                if (e.properties[i].name == "vertex_indices" || e.properties[i].name == "vertex_index") {
                    if (!e.properties[i].list || !integer(e.properties[i].value))
                        fail("PLY face indices must use an integer list");
                    indices = int(i);
                }
        }
    }
    if (!vertex || !vertex->count)
        fail("The PLY contains no vertices");
    const std::array<int, 3> xyz{field(*vertex, "x"), field(*vertex, "y"), field(*vertex, "z")};
    if (*std::min_element(xyz.begin(), xyz.end()) < 0)
        fail("PLY vertices need scalar x, y and z coordinates");
    if (face && indices < 0)
        fail("PLY faces need a vertex_indices list");
    std::array<int, 3> rgb{-1, -1, -1};
    for (const auto &names : {std::array{"red", "green", "blue"}, std::array{"r", "g", "b"},
                              std::array{"diffuse_red", "diffuse_green", "diffuse_blue"}}) {
        const std::array<int, 3> fields{field(*vertex, names[0]), field(*vertex, names[1]),
                                        field(*vertex, names[2])};
        if (*std::min_element(fields.begin(), fields.end()) >= 0) {
            rgb = fields;
            break;
        }
    }
    Scene scene(o.memory);
    scene.type = face ? SceneType::Mesh : SceneType::PointCloud;
    scene.format = face ? "PLY mesh" : "PLY point cloud";
    scene.yUp = true;
    scene.sourceCount = vertex->count;
    scene.sourceFaces = face ? face->count : 0;
    const size_t retained = size_t(face ? vertex->count : std::min<uint64_t>(vertex->count, o.maxSplats));
    if (retained > o.maxBytes / sizeof(PreviewVertex))
        fail("PLY vertices exceed the preview memory budget");
    scene.vertices.reserve(retained);
    scene.sampledGeometry = !face && retained < vertex->count;
    Reader reader(bytes, h, o, h.body);
    size_t faceStart = 0;
    std::vector<double> values(vertex->properties.size());
    for (const auto &e : h.elements) {
        if (&e == face)
            faceStart = reader.at;
        for (uint64_t record = 0; record < e.count; ++record) {
            if (!(record & 4095))
                canceled(o);
            if (&e != vertex) {
                reader.skip(e);
                continue;
            }
            for (size_t i = 0; i < e.properties.size(); ++i) {
                const auto &p = e.properties[i];
                if (p.list)
                    reader.skip(p.value, reader.count(p.count));
                else
                    values[i] = reader.value(p.value);
            }
            PreviewVertex v;
            v.position = {float(values[xyz[0]]), float(values[xyz[1]]), float(values[xyz[2]])};
            if (!std::isfinite(v.position.x) || !std::isfinite(v.position.y) || !std::isfinite(v.position.z))
                fail("PLY coordinates must be finite and fit in a float");
            if (rgb[0] >= 0) {
                v.color = 0xff000000;
                for (unsigned c = 0; c < 3; ++c)
                    v.color |= uint32_t(color(values[rgb[c]], e.properties[rgb[c]].value)) << (8 * c);
            }
            if (face || selected(record, vertex->count, retained))
                scene.vertices.push_back(v);
        }
    }
    if (!face)
        return scene;
    Reader faces(bytes, h, o, faceStart);
    const size_t triangleBudget = std::min(o.maxSplats, o.maxBytes / sizeof(std::array<uint32_t, 3>));
    if (!triangleBudget)
        fail("Invalid PLY triangle budget");
    scene.triangles.reserve(size_t(std::min<uint64_t>(face->count, triangleBudget)));
    uint64_t triangleCount = 0, corners = 0, random = 0x9e3779b97f4a7c15ull;
    auto emit = [&](std::array<uint32_t, 3> triangle) {
        ++triangleCount;
        if (scene.triangles.size() < triangleBudget)
            scene.triangles.push_back(triangle);
        else {
            // A deterministic reservoir spreads reduced previews over the whole mesh.
            random ^= random >> 12;
            random ^= random << 25;
            random ^= random >> 27;
            const auto at = (random * 0x2545f4914f6cdd1dull) % triangleCount;
            if (at < triangleBudget)
                scene.triangles[size_t(at)] = triangle;
        }
    };
    std::vector<uint32_t> polygon;
    for (uint64_t record = 0; record < face->count; ++record) {
        if (!(record & 4095))
            canceled(o);
        polygon.clear();
        for (size_t i = 0; i < face->properties.size(); ++i) {
            const auto &p = face->properties[i];
            if (int(i) != indices) {
                faces.skip(p.value, p.list ? faces.count(p.count) : 1);
                continue;
            }
            const auto n = faces.count(p.count);
            corners += n;
            if (n > 1024 || corners > 60'000'000)
                fail("PLY face topology exceeds the preview budget");
            polygon.reserve(n);
            for (size_t k = 0; k < n; ++k) {
                const double index = faces.value(p.value);
                if (index < 0 || index >= double(vertex->count))
                    fail("PLY face index is outside the vertex table");
                polygon.push_back(uint32_t(index));
            }
        }
        triangulate(polygon, scene.vertices, o, emit);
    }
    if (scene.triangles.empty())
        fail("The PLY mesh contains no drawable faces");
    scene.sampledGeometry = triangleCount > triangleBudget;
    // Upload only vertices referenced by retained triangles, preserving each face.
    std::vector<uint32_t> remap(scene.vertices.size(), UINT32_MAX);
    for (const auto &triangle : scene.triangles)
        for (const auto index : triangle)
            remap[index] = 0;
    size_t used = 0;
    for (size_t i = 0; i < remap.size(); ++i)
        if (remap[i] == 0) {
            remap[i] = uint32_t(used);
            scene.vertices[used++] = scene.vertices[i];
        }
    scene.vertices.resize(used);
    scene.vertices.shrink_to_fit();
    for (auto &triangle : scene.triangles)
        for (auto &index : triangle)
            index = remap[index];
    return scene;
}
} // namespace preview::detail
