#include "ply_preview_contracts.hpp"
#include "model.hpp"
#include "software_renderer.hpp"
#include "image_io.hpp"
#include "editing.hpp"
#include "processing.hpp"
#include "scene_exports.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <sstream>
#include <stdexcept>

namespace {
using namespace preview;
using Bytes = std::vector<uint8_t>;
void require(bool value, const char *text) {
    if (!value)
        throw std::runtime_error(text);
}
template <class F> void rejects(F action) {
    bool rejected = false;
    try {
        action();
    } catch (const std::exception &) {
        rejected = true;
    }
    require(rejected, "Invalid or editable regular PLY must be rejected");
}
template <class T> void add(Bytes &out, T value, bool big) {
    auto bytes = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
    if (big)
        std::reverse(bytes.begin(), bytes.end());
    out.insert(out.end(), bytes.begin(), bytes.end());
}
Bytes bytes(std::string text) {
    return {text.begin(), text.end()};
}
Bytes mesh(int encoding, bool facesFirst = false) {
    const std::string vertex = "element vertex 4\nproperty double x\nproperty float y\nproperty float z\n"
                               "property uchar red\nproperty uchar green\nproperty uchar blue\n";
    const std::string face =
        "element face 1\nproperty list uchar int vertex_indices\nproperty float confidence\n";
    const auto name = encoding == 0 ? "ascii" : encoding == 1 ? "binary_little_endian" : "binary_big_endian";
    auto out = bytes(std::string("ply\nformat ") + name + " 1.0\ncomment regular mesh\n" +
                     (facesFirst ? face + vertex : vertex + face) + "end_header\n");
    const bool big = encoding == 2;
    auto faces = [&] {
        if (encoding == 0) {
            const auto data = bytes("4 0 1 2 3 0.75\n");
            out.insert(out.end(), data.begin(), data.end());
        } else {
            add(out, uint8_t(4), big);
            for (int index = 0; index < 4; ++index)
                add(out, index, big);
            add(out, .75f, big);
        }
    };
    if (facesFirst)
        faces();
    for (const Vec3 p : {Vec3{-1, -1, 0}, Vec3{1, -1, 0}, Vec3{1, 1, 0}, Vec3{-1, 1, 0}}) {
        if (encoding == 0) {
            const auto data = bytes(std::to_string(p.x) + " " + std::to_string(p.y) + " 0 230 90 50\n");
            out.insert(out.end(), data.begin(), data.end());
        } else {
            add(out, double(p.x), big);
            add(out, p.y, big);
            add(out, p.z, big);
            out.insert(out.end(), {230, 90, 50});
        }
    }
    if (!facesFirst)
        faces();
    return out;
}
size_t visible(const Image &image) {
    size_t n = 0;
    for (size_t i = 0; i < image.bgra.size(); i += 4)
        n += unsigned(image.bgra[i]) + image.bgra[i + 1] + image.bgra[i + 2] > 100;
    return n;
}
void write(const std::filesystem::path &path, const Bytes &data) {
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char *>(data.data()), std::streamsize(data.size()));
    require(bool(out), "Write PLY preview fixture");
}
} // namespace
void plyPreviewContracts(const std::filesystem::path &directory) {
    using namespace preview;
    std::ostringstream points;
    points << "ply\nformat ascii 1.0\nelement vertex 121\nproperty float x\nproperty float y\n"
              "property float z\nproperty float nx\nproperty ushort diffuse_red\n"
              "property ushort diffuse_green\nproperty ushort diffuse_blue\nproperty list uchar float uv\n"
              "element edge 1\nproperty int vertex1\nproperty int vertex2\nend_header\n";
    for (int y = -5; y <= 5; ++y)
        for (int x = -5; x <= 5; ++x)
            points << x * .15 << ' ' << y * .15 << " 0 nan 65535 0 32768 2 0.25 0.75\n";
    points << "0 120\n";
    const auto pointData = bytes(points.str());
    auto cloud = std::make_shared<Scene>(loadScene(pointData));
    require(cloud->type == SceneType::PointCloud && cloud->vertices.size() == 121 &&
                cloud->gaussians.empty() && cloud->vertices.front().color == 0xff8000ff &&
                !cloud->sampledGeometry,
            "Colored points, float normals, unknown elements and vertex lists load as view-only geometry");
    write(directory / L"regular-points.ply", pointData);
    const auto signedPoint = loadScene(bytes("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n"
                                             "property float y\nproperty float z\nend_header\n+1 -2 +3e0\n"));
    require(signedPoint.vertices.front().position.x == 1 && signedPoint.vertices.front().position.y == -2 &&
                signedPoint.vertices.front().position.z == 3,
            "ASCII coordinates accept signed values and scientific notation");
    const auto subset = loadScene(pointData, {.maxSplats = 11});
    require(subset.vertices.size() == 11 && subset.sourceCount == 121 && subset.sampledGeometry &&
                subset.radius > .5f,
            "Reduced point previews preserve source counts and spatial coverage");
    std::shared_ptr<Scene> surface;
    for (int encoding = 0; encoding < 3; ++encoding)
        for (bool first : {false, true}) {
            const auto data = mesh(encoding, first);
            auto decoded = std::make_shared<Scene>(loadScene(data));
            require(decoded->type == SceneType::Mesh && decoded->vertices.size() == 4 &&
                        decoded->triangles.size() == 2 && decoded->sourceFaces == 1 &&
                        decoded->vertices.front().color == 0xff325ae6,
                    "ASCII and both binary byte orders support polygons and either element order");
            require(decoded->vertices[0].position.y == -1 && decoded->radius > 1,
                    "Regular PLY coordinates retain their axes and fit the camera");
            auto sampled = loadScene(data, {.maxSplats = 1});
            require(sampled.triangles.size() == 1 && sampled.vertices.size() == 3 && sampled.sampledGeometry,
                    "Reduced meshes keep complete triangles and compact their referenced vertices");
            auto truncated = data;
            truncated.pop_back();
            if (encoding)
                rejects([&] { loadScene(truncated); });
            surface = std::move(decoded);
        }
    write(directory / L"regular-mesh.ply", mesh(1));
    auto concave =
        loadScene(bytes("ply\nformat ascii 1.0\nelement vertex 6\nproperty float x\nproperty float y\n"
                        "property float z\nelement face 1\nproperty list uchar int vertex_index\nend_header\n"
                        "0 0 0\n2 0 0\n2 1 0\n1 1 0\n1 2 0\n0 2 0\n6 0 1 2 3 4 5\n"));
    double area = 0;
    for (const auto &t : concave.triangles) {
        const auto a = concave.vertices[t[0]].position, b = concave.vertices[t[1]].position,
                   c = concave.vertices[t[2]].position;
        area += .5 * std::abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    }
    require(concave.triangles.size() == 4 && std::abs(area - 3) < 1e-6,
            "Concave polygon triangulation preserves the cutout");
    for (const auto *body : {"3 0 1 4", "-1", "3 -1 1 2", "3 0 1", "1025"})
        rejects([&] {
            loadScene(bytes(std::string("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty "
                                        "float y\nproperty float z\nelement face 1\nproperty list int int "
                                        "vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n") +
                            body));
        });
    rejects([&] {
        loadScene(bytes("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float "
                        "y\nproperty float z\nend_header\nnan 0 0\n"));
    });
    rejects([&] {
        loadScene(bytes("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float "
                        "y\nproperty float z\nproperty float scale_0\nend_header\n0 0 0 0\n"));
    });
    std::stop_source stop;
    stop.request_stop();
    rejects([&] { loadScene(pointData, {.stop = stop.get_token()}); });
    rejects([&] { SceneEdits edits(cloud); });
    rejects([&] { processScene(cloud, {}, {{"type", "color"}, {"values", {{"brightness", 2}}}}); });
    const auto output = directory / L"regular-no-export.ply";
    write(output, bytes("preserve"));
    rejects([&] { writeVisibleScene(*surface, {}, output, SceneExportFormat::Ply); });
    require(std::filesystem::file_size(output) == 8, "Disabled export preserves an existing output");
    ThumbnailRenderer thumbnails;
    const auto pointImage = thumbnails.render(cloud, 192), meshImage = thumbnails.render(surface, 192);
    require(visible(pointImage) > 80 && visible(meshImage) > 2500,
            "Software thumbnails show points and filled mesh faces");
    writePng(pointImage, directory / L"regular-points.png");
    writePng(meshImage, directory / L"regular-mesh.png");
    const auto gaussian = std::make_shared<Scene>(loadScene(directory / L"demo.ply"));
    const auto splatImage = thumbnails.render(gaussian, 192);
    require(visible(splatImage) > 1000 && thumbnails.render(cloud, 192).bgra == pointImage.bgra,
            "The cached thumbnail renderer switches between meshes, splats and points without stale state");
    auto layers = std::make_shared<Scene>();
    layers->type = SceneType::Mesh;
    for (const float z : {.3f, 0.f})
        for (const Vec3 p : {Vec3{-1, -1, z}, Vec3{1, -1, z}, Vec3{0, 1, z}})
            layers->vertices.push_back({p, z > 0 ? 0xff00ff00u : 0xff0000ffu});
    layers->triangles = {{0, 1, 2}, {3, 4, 5}};
    fitBounds(*layers);
    SoftwareRenderer renderer;
    renderer.resize(192, 192);
    renderer.setScene(layers);
    Camera camera;
    camera.yUp = true;
    camera.yaw = camera.pitch = 0;
    camera.distance = 4;
    renderer.draw(camera);
    const auto image = renderer.readback();
    const auto center = (96 * 192 + 96) * 4;
    require(image.bgra[center + 1] > 100 && image.bgra[center + 2] < 30,
            "Mesh depth testing keeps the nearer face regardless of draw order");
    const auto before = renderer.stats();
    renderer.draw(camera);
    require(renderer.stats().rasterizations == before.rasterizations && !before.depthSorts &&
                !before.orderUploads,
            "An idle regular PLY reuses its image without Gaussian sorting");
    require(inputFormatForPath(L"archive.ZIP") == InputFormat::Unsupported &&
                inputFormatForPath(L"scene.SOGS") == InputFormat::Sog,
            "ZIP is not a detected file type; dedicated SOG extensions retain their container hint");
    rejects([&] { loadScene(directory / L"demo.zip"); });
}
