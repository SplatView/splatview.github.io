// Portable subset of SplatView's format contracts, recorded in SOURCE_BASELINE.json.
#include "model.hpp"
#include "camera.hpp"
#include "format_fixtures.hpp"
#include "math.hpp"
#include "file_io.hpp"
#include <load-spz.h>
#include <coordinate-system-adobe.h>
#include <nlohmann/json.hpp>
#include <webp/encode.h>
#include <zlib.h>
#include <algorithm>
#include <bit>
#include <climits>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
using namespace preview;
using Bytes=std::vector<uint8_t>;
using Json=nlohmann::json;
namespace {
void require(bool condition, const char *message) {
    if (!condition)
        throw std::runtime_error(message);
}
void close(float a, float b, float tolerance, const char *message) {
    require(std::abs(a - b) < tolerance, message);
}
template <class T> void append(Bytes &bytes, T value, bool big = false) {
    auto data = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
    if (big)
        std::reverse(data.begin(), data.end());
    bytes.insert(bytes.end(), data.begin(), data.end());
}
void write(const std::filesystem::path &file, const Bytes &bytes) {
    std::ofstream out(file, std::ios::binary);
    out.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
}
Bytes read(const std::filesystem::path &file) {
    std::ifstream in(file, std::ios::binary);
    return Bytes(std::istreambuf_iterator<char>(in), {});
}
Bytes zip(const std::map<std::string, Bytes> &entries, bool compress = false) {
    Bytes bytes, directory;
    for (const auto &[name, data] : entries) {
        Bytes compressed = data;
        if (compress) {
            compressed.resize(compressBound(static_cast<uLong>(data.size())));
            z_stream z{};
            require(deflateInit2(&z, 6, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY) == Z_OK,
                    "deflate init");
            z.next_in = const_cast<Bytef *>(data.data());
            z.avail_in = static_cast<uInt>(data.size());
            z.next_out = compressed.data();
            z.avail_out = static_cast<uInt>(compressed.size());
            require(deflate(&z, Z_FINISH) == Z_STREAM_END, "deflate");
            compressed.resize(z.total_out);
            deflateEnd(&z);
        }
        const uint32_t offset = static_cast<uint32_t>(bytes.size()),
                       crc = crc32(0, data.data(), static_cast<uInt>(data.size()));
        append<uint32_t>(bytes, 0x04034b50);
        append<uint16_t>(bytes, 20);
        append<uint16_t>(bytes, 0);
        append<uint16_t>(bytes, compress ? 8 : 0);
        append<uint32_t>(bytes, 0);
        append<uint32_t>(bytes, crc);
        append<uint32_t>(bytes, static_cast<uint32_t>(compressed.size()));
        append<uint32_t>(bytes, static_cast<uint32_t>(data.size()));
        append<uint16_t>(bytes, static_cast<uint16_t>(name.size()));
        append<uint16_t>(bytes, 0);
        bytes.insert(bytes.end(), name.begin(), name.end());
        bytes.insert(bytes.end(), compressed.begin(), compressed.end());
        append<uint32_t>(directory, 0x02014b50);
        append<uint16_t>(directory, 20);
        append<uint16_t>(directory, 20);
        append<uint16_t>(directory, 0);
        append<uint16_t>(directory, compress ? 8 : 0);
        append<uint32_t>(directory, 0);
        append<uint32_t>(directory, crc);
        append<uint32_t>(directory, static_cast<uint32_t>(compressed.size()));
        append<uint32_t>(directory, static_cast<uint32_t>(data.size()));
        append<uint16_t>(directory, static_cast<uint16_t>(name.size()));
        append<uint16_t>(directory, 0);
        append<uint16_t>(directory, 0);
        append<uint16_t>(directory, 0);
        append<uint16_t>(directory, 0);
        append<uint32_t>(directory, 0);
        append<uint32_t>(directory, offset);
        directory.insert(directory.end(), name.begin(), name.end());
    }
    uint32_t offset = static_cast<uint32_t>(bytes.size());
    bytes.insert(bytes.end(), directory.begin(), directory.end());
    append<uint32_t>(bytes, 0x06054b50);
    append<uint32_t>(bytes, 0);
    append<uint16_t>(bytes, static_cast<uint16_t>(entries.size()));
    append<uint16_t>(bytes, static_cast<uint16_t>(entries.size()));
    append<uint32_t>(bytes, static_cast<uint32_t>(directory.size()));
    append<uint32_t>(bytes, offset);
    append<uint16_t>(bytes, 0);
    return bytes;
}
std::vector<Attributes> sample() {
    std::vector<Attributes> result;
    for (int ring = 0; ring < 72; ++ring)
        for (int tube = 0; tube < 24; ++tube) {
            float angle = ring * 6.2831853f / 72, around = tube * 6.2831853f / 24;
            Attributes a;
            float radius = 1.0f + 0.32f * std::cos(around);
            a.position = {radius * std::cos(angle), 0.32f * std::sin(around), radius * std::sin(angle)};
            a.scale = {0.055f, 0.025f, 0.035f};
            a.quaternion = {std::cos(angle / 2), 0, std::sin(angle / 2), 0};
            a.opacity = 0.85f;
            float rgb[3] = {0.5f + 0.42f * std::cos(angle), 0.5f + 0.42f * std::sin(angle),
                            0.63f + 0.27f * std::sin(around)};
            for (int c = 0; c < 3; ++c)
                a.sh[c] = (rgb[c] - 0.5f) / 0.2820947918f;
            for (int j = 1; j < 16; ++j)
                for (int c = 0; c < 3; ++c)
                    a.sh[j * 3 + c] = 0.045f * std::sin(float(j * 3 + c));
            result.push_back(a);
        }
    return result;
}
Bytes ply(const std::vector<Attributes> &source, bool ascii = false, bool big = false) {
    std::ostringstream header;
    header << "ply\nformat "
           << (ascii ? "ascii"
               : big ? "binary_big_endian"
                     : "binary_little_endian")
           << " 1.0\nelement vertex " << source.size() << "\n";
    // Deliberately use a noncanonical property order to test name-based decoding.
    for (const auto *name : {"opacity", "z", "x", "y", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1",
                             "rot_2", "rot_3", "f_dc_0", "f_dc_1", "f_dc_2"})
        header << "property float " << name << "\n";
    for (int j = 0; j < 45; ++j)
        header << "property float f_rest_" << j << "\n";
    header << "end_header\n";
    auto text = header.str();
    Bytes bytes(text.begin(), text.end());
    auto converter = spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, 3);
    for (const auto &original : source) {
        Attributes a = original;
        a.position.y = -a.position.y;
        a.position.z = -a.position.z;
        for (int j = 0; j < 3; ++j)
            a.quaternion[j + 1] *= converter.flipQ[j];
        for (int j = 1; j < 16; ++j)
            for (int c = 0; c < 3; ++c)
                a.sh[j * 3 + c] *= converter.flipSh[j - 1];
        std::vector<float> values = {std::log(a.opacity / (1 - a.opacity)),
                                     a.position.z,
                                     a.position.x,
                                     a.position.y,
                                     std::log(a.scale.x),
                                     std::log(a.scale.y),
                                     std::log(a.scale.z)};
        values.insert(values.end(), a.quaternion.begin(), a.quaternion.end());
        values.insert(values.end(), a.sh.begin(), a.sh.begin() + 3);
        for (int c = 0; c < 3; ++c)
            for (int j = 1; j < 16; ++j)
                values.push_back(a.sh[j * 3 + c]);
        if (ascii) {
            std::ostringstream line;
            line.precision(9);
            for (auto v : values)
                line << v << ' ';
            line << '\n';
            auto s = line.str();
            bytes.insert(bytes.end(), s.begin(), s.end());
        } else
            for (auto v : values)
                append(bytes, v, big);
    }
    return bytes;
}
Bytes spzFile(const std::vector<Attributes> &source, unsigned version) {
    spz::GaussianCloud cloud;
    cloud.numPoints = static_cast<int>(source.size());
    cloud.shDegree = 3;
    for (const auto &a : source) {
        for (auto v : {a.position.x, a.position.y, a.position.z})
            cloud.positions.push_back(v);
        for (auto v : {a.scale.x, a.scale.y, a.scale.z})
            cloud.scales.push_back(std::log(v));
        for (auto v : {a.quaternion[1], a.quaternion[2], a.quaternion[3], a.quaternion[0]})
            cloud.rotations.push_back(v);
        cloud.alphas.push_back(std::log(a.opacity / (1 - a.opacity)));
        cloud.colors.insert(cloud.colors.end(), a.sh.begin(), a.sh.begin() + 3);
        cloud.sh.insert(cloud.sh.end(), a.sh.begin() + 3, a.sh.end());
    }
    spz::PackOptions options;
    options.version = version;
    options.from = spz::CoordinateSystem::RUB;
    Bytes bytes;
    require(spz::saveSpz(cloud, options, &bytes), "SPZ fixture encoding failed");
    return bytes;
}
Bytes webp(const Bytes &rgba, int width, int height) {
    uint8_t *output = nullptr;
    size_t length = WebPEncodeLosslessRGBA(rgba.data(), width, height, width * 4, &output);
    require(length > 0, "WebP fixture encoding failed");
    Bytes bytes(output, output + length);
    WebPFree(output);
    return bytes;
}
std::map<std::string, Bytes> sog(const std::vector<Attributes> &original, bool legacy = false,
                                 unsigned degree = 3) {
    // Match splat-transform's PLY-space SOG payload, then verify the native
    // reader returns the original RUB geometry and SH basis.
    auto source = original;
    const auto converter =
        spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, 3);
    for (auto &a : source) {
        a.position.y = -a.position.y;
        a.position.z = -a.position.z;
        for (unsigned c = 0; c < 3; ++c)
            a.quaternion[c + 1] *= converter.flipQ[c];
        for (unsigned j = 1; j < 16; ++j)
            for (unsigned c = 0; c < 3; ++c)
                a.sh[j * 3 + c] *= converter.flipSh[j - 1];
    }
    int width = 72, height = 24;
    size_t n = source.size();
    require(n == size_t(width) * height, "Fixture size");
    std::map<std::string, Bytes> textures;
    for (const auto *name :
         {"means_l.webp", "means_u.webp", "quats.webp", "scales.webp", "sh0.webp", "shN_labels.webp"})
        textures[name] = Bytes(n * 4, 255);
    std::vector<float> scaleBook(256), colorBook(256), shBook(256);
    for (int i = 0; i < 256; ++i) {
        scaleBook[i] = -6 + i * 0.025f;
        colorBook[i] = -2 + i * 4.0f / 255;
        shBook[i] = -0.1f + i * 0.2f / 255;
    }
    float mins[3] = {100, 100, 100}, maxs[3] = {-100, -100, -100};
    for (const auto &a : source) {
        float p[3] = {a.position.x, a.position.y, a.position.z};
        for (int c = 0; c < 3; ++c) {
            float v = std::copysign(std::log1p(std::abs(p[c])), p[c]);
            mins[c] = std::min(mins[c], v);
            maxs[c] = std::max(maxs[c], v);
        }
    }
    auto nearest = [](const std::vector<float> &book, float v) {
        size_t result = 0;
        for (size_t i = 1; i < book.size(); ++i)
            if (std::abs(book[i] - v) < std::abs(book[result] - v))
                result = i;
        return static_cast<uint8_t>(result);
    };
    for (size_t i = 0; i < n; ++i) {
        const auto &a = source[i];
        float p[3] = {a.position.x, a.position.y, a.position.z}, s[3] = {a.scale.x, a.scale.y, a.scale.z};
        for (int c = 0; c < 3; ++c) {
            float v = std::copysign(std::log1p(std::abs(p[c])), p[c]);
            uint16_t q = static_cast<uint16_t>(std::lround((v - mins[c]) / (maxs[c] - mins[c]) * 65535));
            textures["means_l.webp"][i * 4 + c] = q & 255;
            textures["means_u.webp"][i * 4 + c] = q >> 8;
            textures["scales.webp"][i * 4 + c] = nearest(scaleBook, std::log(s[c]));
            textures["sh0.webp"][i * 4 + c] = nearest(colorBook, a.sh[c]);
        }
        unsigned largest = 0;
        for (unsigned j = 1; j < 4; ++j)
            if (std::abs(a.quaternion[j]) > std::abs(a.quaternion[largest]))
                largest = j;
        unsigned channel = 0;
        float sign = a.quaternion[largest] < 0 ? -1.0f : 1.0f;
        for (unsigned j = 0; j < 4; ++j)
            if (j != largest)
                textures["quats.webp"][i * 4 + channel++] = static_cast<uint8_t>(std::clamp(
                    std::lround((a.quaternion[j] * sign / 1.41421356237f + 0.5f) * 255), 0l, 255l));
        textures["quats.webp"][i * 4 + 3] = static_cast<uint8_t>(252 + largest);
        textures["sh0.webp"][i * 4 + 3] = static_cast<uint8_t>(
            std::lround((legacy ? (std::log(a.opacity / (1 - a.opacity)) + 8) / 16 : a.opacity) * 255));
        textures["shN_labels.webp"][i * 4] = 0;
        textures["shN_labels.webp"][i * 4 + 1] = 0;
    }
    const unsigned coeffs = (degree + 1) * (degree + 1) - 1;
    Bytes ac(64 * std::max(1u, coeffs) * 4, 255);
    for (unsigned j = 0; j < coeffs; ++j)
        for (int c = 0; c < 3; ++c)
            ac[j * 4 + c] = nearest(shBook, source[0].sh[(j + 1) * 3 + c]);
    std::map<std::string, Bytes> files;
    for (auto &[name, rgba] : textures)
        files[name] = webp(rgba, width, height);
    files["shN_centroids.webp"] = webp(ac, 64 * std::max(1u, coeffs), 1);
    Json meta = {{"version", 2},
                 {"count", n},
                 {"means", {{"mins", mins}, {"maxs", maxs}, {"files", {"means_l.webp", "means_u.webp"}}}},
                 {"scales", {{"codebook", scaleBook}, {"files", {"scales.webp"}}}},
                 {"quats", {{"files", {"quats.webp"}}}},
                 {"sh0", {{"codebook", colorBook}, {"files", {"sh0.webp"}}}},
                 {"shN",
                  {{"bands", degree},
                   {"count", 1},
                   {"codebook", shBook},
                   {"files", {"shN_centroids.webp", "shN_labels.webp"}}}}};
    if (legacy) {
        meta.erase("version"); // Original SOGS metadata has no explicit version or count.
        meta.erase("count");
        meta["means"]["shape"] = {n, 3};
        meta["scales"].erase("codebook");
        meta["scales"]["mins"] = {-6, -6, -6};
        meta["scales"]["maxs"] = {.375, .375, .375};
        meta["sh0"].erase("codebook");
        meta["sh0"]["mins"] = {-2, -2, -2, -8};
        meta["sh0"]["maxs"] = {2, 2, 2, 8};
        meta["shN"].erase("bands");
        meta["shN"].erase("count");
        meta["shN"].erase("codebook");
        meta["shN"]["mins"] = -.1;
        meta["shN"]["maxs"] = .1;
        meta["shN"]["shape"] = {1, coeffs * 3};
    }
    if (!degree)
        meta.erase("shN");
    auto text = meta.dump();
    files["meta.json"] = Bytes(text.begin(), text.end());
    return files;
}
} // namespace
void formatDecodeContracts(const std::filesystem::path &directory) {
    std::filesystem::create_directories(directory);
    auto test=[](const char *name,auto action) { action(); std::cout<<"PASS "<<name<<'\n'; };
    const auto source=sample(); const auto expected=packGaussian(source[0]); const auto base=ply(source);
    write(directory/"demo.ply",base);
        test("PLY endian, ASCII, arbitrary property order and SH layout", [&] {
            for (auto bytes : {base, ply(source, true), ply(source, false, true)}) {
                auto scene = loadScene(bytes);
                require(scene.sourceCount == source.size() && scene.shDegree == 3, "PLY scene metadata");
                for (int i = 0; i < 3; ++i)
                    close(scene.gaussians[0].positionOpacity[i], expected.positionOpacity[i], 0.0001f,
                          "PLY coordinate conversion");
                for (unsigned j = 0; j < 16; ++j)
                    for (unsigned c = 0; c < 3; ++c)
                        close(shValue(scene.gaussians[0], j, c), shValue(expected, j, c), 0.0005f,
                              "PLY SH conversion");
            }
        });
        const auto splatBytes = format_tests::splat(source);
        const auto ksplatBytes = format_tests::ksplat(source, 1, 3);
        const auto compressedBytes = format_tests::compressedPly(source);
        write(directory / L"demo.splat", splatBytes);
        write(directory / L"demo.ksplat", ksplatBytes);
        write(directory / L"demo-compressed.ply", compressedBytes);
        test("SPLAT byte colors, wxyz rotations, coordinates and filename hints", [&] {
            auto scene = loadScene(splatBytes);
            require(scene.sourceCount == source.size() && scene.shDegree == 0 && scene.format == "SPLAT",
                    "SPLAT metadata and DC-only color");
            for (size_t i = 0; i < source.size(); ++i) {
                auto expectedSplat = packGaussian(source[i]);
                for (unsigned c = 0; c < 4; ++c) {
                    close(scene.gaussians[i].positionOpacity[c], expectedSplat.positionOpacity[c], .002f,
                          "SPLAT position and opacity");
                    close(scene.gaussians[i].covA[c], expectedSplat.covA[c], .00004f,
                          "SPLAT anisotropic covariance and quaternion convention");
                }
                for (unsigned c = 0; c < 3; ++c)
                    close(shValue(scene.gaussians[i], 0, c), shValue(expectedSplat, 0, c), .008f,
                          "SPLAT colors become SH DC");
            }
            auto ambiguous = splatBytes;
            std::memcpy(ambiguous.data(), "ply", 3);
            auto file = directory / L"ambiguous.SPLAT";
            write(file, ambiguous);
            require(loadScene(file).format == "SPLAT",
                    "Filename hint takes priority over ambiguous raw bytes");
            require(inputFormatForPath(L"scene.KsPlAt") == InputFormat::Ksplat,
                    "Case-insensitive format hints");
        });
        test("KSPLAT compression 0-2, SH0-3, reserved sections and partial spatial buckets", [&] {
            for (unsigned mode = 0; mode <= 2; ++mode)
                for (unsigned degree = 0; degree <= 3; ++degree) {
                    auto scene = loadScene(format_tests::ksplat(source, mode, degree));
                    require(scene.sourceCount == source.size() && scene.gaussians.size() == source.size() &&
                                scene.shDegree == degree,
                            "KSPLAT counts ignore reserved capacity");
                    for (size_t i = 0; i < source.size(); ++i) {
                        auto expectedSplat = packGaussian(source[i]);
                        for (unsigned c = 0; c < 3; ++c) {
                            close(scene.gaussians[i].positionOpacity[c], expectedSplat.positionOpacity[c],
                                  .0002f, "KSPLAT spatial decompression and coordinate basis");
                            close(shValue(scene.gaussians[i], 0, c), shValue(expectedSplat, 0, c), .008f,
                                  "KSPLAT DC color");
                        }
                        for (unsigned c = 0; c < 4; ++c)
                            close(scene.gaussians[i].covA[c], expectedSplat.covA[c], .000003f,
                                  "KSPLAT half-float geometry");
                        const unsigned localDegree = i < source.size() / 2 ? degree : std::min(degree, 1u);
                        for (unsigned j = 1; j < 16; ++j)
                            for (unsigned c = 0; c < 3; ++c)
                                close(shValue(scene.gaussians[i], j, c),
                                      j < (localDegree + 1) * (localDegree + 1) ? shValue(expectedSplat, j, c)
                                                                                : 0,
                                      mode == 2 ? .0065f : .0001f,
                                      "KSPLAT per-band, per-channel SH ordering");
                    }
                }
        });
        test("SuperSplat compressed PLY chunk colors, property order, endian and SH0-3", [&] {
            for (bool colorBounds : {false, true})
                for (unsigned degree = 0; degree <= 3; ++degree)
                    for (bool big : {false, true}) {
                        auto scene = loadScene(format_tests::compressedPly(source, colorBounds, degree, big));
                        require(scene.sourceCount == source.size() && scene.shDegree == degree &&
                                    scene.format == "Compressed PLY",
                                "Compressed PLY metadata");
                        for (size_t i = 0; i < source.size(); ++i) {
                            const auto expectedSplat = packGaussian(source[i]);
                            for (unsigned c = 0; c < 3; ++c) {
                                close(scene.gaussians[i].positionOpacity[c], expectedSplat.positionOpacity[c],
                                      .0015f, "Compressed PLY chunk position quantization");
                                close(shValue(scene.gaussians[i], 0, c), shValue(expectedSplat, 0, c), .008f,
                                      "Compressed PLY chunk color dequantization");
                            }
                            for (unsigned c = 0; c < 4; ++c)
                                close(scene.gaussians[i].covA[c], expectedSplat.covA[c], .00001f,
                                      "Compressed PLY smallest-three covariance");
                            for (unsigned j = 1; j < (degree + 1) * (degree + 1); ++j)
                                for (unsigned c = 0; c < 3; ++c)
                                    close(shValue(scene.gaussians[i], j, c), shValue(expectedSplat, j, c),
                                          .03f, "Compressed PLY SH dequantization and channel ordering");
                        }
                    }
        });
        test("Pinned upstream SPLAT and KSPLAT fixtures", [&] {
            for (const auto *name : {L"minimal.splat", L"minimal.ksplat"}) {
                auto scene = loadScene(std::filesystem::path(FORMAT_FIXTURE_DIR) / name);
                require(scene.sourceCount == 4 && scene.shDegree == 0, "Upstream fixture metadata");
                const auto &g = scene.gaussians.front();
                close(g.positionOpacity[0], -1, .00001f, "Upstream X");
                close(g.positionOpacity[1], 0, .00001f, "Upstream Y");
                close(g.positionOpacity[2], 1, .00001f, "Upstream RDF-to-RUB Z");
                close(g.positionOpacity[3], 230.f / 255, .00001f, "Upstream opacity");
                close(g.covA[0], .01f, .00001f, "Upstream scale");
                close(shValue(g, 0, 0), (1.f / 3 - .5f) / .2820947918f, .0005f, "Upstream DC");
            }
        });
        test("SPZ v2/v3/v4 reference-codec compatibility", [&] {
            for (unsigned version : {2u, 3u, 4u}) {
                auto bytes = spzFile(source, version);
                if (version == 4)
                    write(directory / L"demo.spz", bytes);
                auto scene = loadScene(bytes);
                require(scene.sourceCount == source.size() && scene.shDegree == 3, "SPZ metadata");
                for (int i = 0; i < 3; ++i)
                    close(scene.gaussians[0].positionOpacity[i], expected.positionOpacity[i], 0.002f,
                          "SPZ positions");
                close(scene.gaussians[0].covA[0], expected.covA[0], 0.0005f, "SPZ covariance");
                for (unsigned c = 0; c < 3; ++c)
                    close(shValue(scene.gaussians[0], 0, c), shValue(expected, 0, c), 0.035f, "SPZ color");
            }
        });
        test("Legacy SPZ v1 float16 positions", [&] {
            Bytes payload;
            append<uint32_t>(payload, spz::NGSP_MAGIC);
            append<uint32_t>(payload, 1);
            append<uint32_t>(payload, 2);
            payload.insert(payload.end(), {0, 12, 0, 0});
            for (float v : {1.0f, 2.0f, 3.0f, -1.0f, -2.0f, -3.0f})
                append<uint16_t>(payload, DirectX::PackedVector::XMConvertFloatToHalf(v));
            payload.insert(payload.end(), {200, 200, 100, 110, 120, 100, 110, 120, 100, 100,
                                           100, 100, 100, 100, 128, 128, 128, 128, 128, 128});
            Bytes compressed;
            require(spz::compressGzipped(payload.data(), payload.size(), &compressed), "Encode v1 fixture");
            auto scene = loadScene(compressed);
            require(scene.gaussians.size() == 2, "SPZ v1 count");
            close(scene.gaussians[0].positionOpacity[0], 1, 0.001f, "SPZ v1 half float");
        });
        auto members = sog(source);
        auto sogBytes = zip(members);
        write(directory / L"demo.sog", sogBytes);
        write(directory / L"demo.sogs", sogBytes);
        std::filesystem::create_directories(directory / L"unpacked");
        for (const auto &[name, data] : members)
            write(directory / L"unpacked" / pathFromUtf8(name), data);
        test("SOG stored/deflated ZIP, unpacked metadata, codebooks and SH palettes", [&] {
            for (auto scene : {loadScene(sogBytes), loadScene(zip(members, true)),
                               loadScene(directory / L"unpacked" / L"meta.json")}) {
                require(scene.gaussians.size() == source.size() && scene.shDegree == 3, "SOG metadata");
                for (int i = 0; i < 3; ++i)
                    close(scene.gaussians[0].positionOpacity[i], expected.positionOpacity[i], 0.001f,
                          "SOG position dequantization");
                for (unsigned c = 0; c < 3; ++c)
                    close(shValue(scene.gaussians[0], 0, c), shValue(expected, 0, c), 0.009f,
                          "SOG color codebook");
                for (unsigned j = 1; j < 16; ++j)
                    for (unsigned c = 0; c < 3; ++c)
                        close(shValue(scene.gaussians[0], j, c), shValue(expected, j, c), 0.001f,
                              "SOG SH palette order");
            }
        });
        const auto legacyMembers = sog(source, true);
        const auto legacyBytes = zip(legacyMembers, true);
        write(directory / L"demo-legacy.sogs", legacyBytes);
        write(directory / L"demo.zip", zip(members, true));
        std::filesystem::create_directories(directory / L"legacy");
        for (const auto &[name, data] : legacyMembers)
            write(directory / L"legacy" / pathFromUtf8(name), data);
        test("Legacy SOG v1 ranges, opacity logits, SH0-3 and nested ZIP scenes", [&] {
            for (unsigned degree = 0; degree <= 3; ++degree) {
                auto scene = loadScene(zip(sog(source, true, degree), true));
                require(scene.sourceCount == source.size() && scene.shDegree == degree &&
                            scene.format == "SOG v1",
                        "Legacy metadata and inferred SH degree");
                for (size_t i = 0; i < source.size(); ++i) {
                    const auto expectedSplat = packGaussian(source[i]);
                    for (unsigned c = 0; c < 3; ++c) {
                        close(scene.gaussians[i].positionOpacity[c], expectedSplat.positionOpacity[c], .001f,
                              "Legacy SOG positions");
                        close(shValue(scene.gaussians[i], 0, c), shValue(expectedSplat, 0, c), .009f,
                              "Legacy SOG color bounds");
                    }
                    close(scene.gaussians[i].positionOpacity[3], source[i].opacity, .006f,
                          "Legacy alpha is a logit, not linear alpha");
                    for (unsigned j = 1; j < (degree + 1) * (degree + 1); ++j)
                        for (unsigned c = 0; c < 3; ++c)
                            close(shValue(scene.gaussians[i], j, c), shValue(expected, j, c), .001f,
                                  "Legacy SH palette lookup");
                }
            }
            require(loadScene(directory / L"legacy" / L"meta.json").format == "SOG v1",
                    "Unpacked legacy SOG");
            std::map<std::string, Bytes> nested;
            for (const auto &[name, data] : legacyMembers)
                nested["scene/" + name] = data;
            auto nestedBytes = zip(nested, true);
            write(directory / L"demo-nested.sogs", nestedBytes);
            require(loadScene(nestedBytes).gaussians.size() == source.size(),
                    "ZIP folder prefix resolves textures");
            auto nullSh = members;
            auto meta = Json::parse(nullSh.at("meta.json"));
            meta["shN"] = nullptr;
            auto text = meta.dump();
            nullSh["meta.json"] = Bytes(text.begin(), text.end());
            require(loadScene(zip(nullSh)).shDegree == 0, "Null SH metadata denotes DC-only SOG");
        });
        test("Sampling budget preserves coverage and source count", [&] {
            LoadOptions o;
            o.maxSplats = 100;
            for (auto bytes : {base, spzFile(source, 4), sogBytes, splatBytes, ksplatBytes, compressedBytes,
                               legacyBytes}) {
                auto scene = loadScene(bytes, o);
                require(scene.gaussians.size() == 100 && scene.sourceCount == source.size(),
                        "Uniform sampling count");
                require(scene.radius > 1, "Sampling retains scene extent");
            }
        });
        test("Explorer budgets scale with output size and remain bounded", [&] {
            require(previewSplatBudget(230, 300) >= 100'000 &&
                        previewSplatBudget(230, 300) < previewSplatBudget(510, 500),
                    "Small panes use less scene memory than larger panes");
            require(previewSplatBudget(0, 0) == 100'000 && previewSplatBudget(UINT_MAX, UINT_MAX) == 500'000,
                    "Empty and overflowing host dimensions stay within the preview budget");
            require(thumbnailSplatBudget(128) < thumbnailSplatBudget(256) &&
                        thumbnailSplatBudget(0) == 32'000 && thumbnailSplatBudget(UINT_MAX) == 250'000,
                    "Small thumbnail requests use less memory and large requests stay bounded");
            LoadOptions options;
            options.maxSplats = thumbnailSplatBudget(128);
            auto larger = source;
            while (larger.size() <= options.maxSplats)
                larger.insert(larger.end(), source.begin(), source.end());
            auto scene = loadScene(ply(larger), options);
            require(scene.gaussians.size() == options.maxSplats && scene.sourceCount == larger.size(),
                    "The output budget limits decoded splats and preserves the original source count");
            require(LoadOptions{}.maxSplats == 3'000'000, "Standalone cleanup retains its larger budget");
        });
        test("Initial framing isolates dense content without changing source Gaussians", [&] {
            Scene scene;
            scene.yUp = true;
            for (int i = 0; i < 1000; ++i) {
                float z = 1 - 2 * (i + .5f) / 1000;
                float angle = i * 2.39996323f;
                float radius = 4 * std::cbrt(((i * 37) % 1000 + 1) / 1000.0f);
                float ring = std::sqrt(1 - z * z);
                Attributes a;
                a.position = {3 + radius * ring * std::cos(angle), -.6f + radius * z,
                              -2 + radius * ring * std::sin(angle)};
                scene.gaussians.push_back(packGaussian(a));
            }
            // A substantial distant background must not dominate the initial camera.
            for (int i = 0; i < 350; ++i) {
                Attributes a;
                float backgroundDistance = float(40 + i);
                a.position = {3 + (i % 2 ? backgroundDistance : -backgroundDistance),
                              -.6f + (i % 3 ? backgroundDistance : -backgroundDistance),
                              -2 + backgroundDistance};
                a.scale = {20, 20, 20};
                scene.gaussians.push_back(packGaussian(a));
            }
            scene.sourceCount = scene.gaussians.size();
            auto original = scene.gaussians;
            fitBounds(scene);
            require(scene.radius > 3 && scene.radius < 6,
                    "Distant positions and giant background splats do not control framing");
            require(std::abs(scene.center.x - 3) < 1 && std::abs(scene.center.y + .6f) < 1 &&
                        std::abs(scene.center.z + 2) < 1,
                    "Initial target stays near the dense subject");
            require(scene.previewEye.has_value(), "Nearby capture origin provides an interior view");
            Camera camera;
            camera.fit(scene);
            auto eye = camera.eye();
            close(eye.x, 0, .00001f, "Square view starts near the capture origin X");
            close(eye.y, 0, .00001f, "Square view starts near the capture origin Y");
            close(eye.z, 0, .00001f, "Square view starts near the capture origin Z");
            auto squareDistance = camera.distance;
            camera.fit(scene, .5f);
            require(camera.distance > squareDistance, "Narrow preview panes pull back for the subject");
            require(scene.gaussians.size() == original.size() && scene.sourceCount == original.size() &&
                        std::memcmp(scene.gaussians.data(), original.data(),
                                    original.size() * sizeof(Gaussian)) == 0,
                    "Framing preserves all source positions, covariance, colors and opacity");
            auto center = scene.center;
            auto radius = scene.radius;
            for (int i = 0; i < 1000; ++i) {
                Attributes a;
                a.opacity = 0;
                a.position = {float(i * 1000), -10000, 20000};
                scene.gaussians.push_back(packGaussian(a));
            }
            fitBounds(scene);
            close(scene.radius, radius, .00001f, "Invisible splats do not affect the framing radius");
            close(scene.center.z, center.z, .00001f, "Invisible splats do not affect the target");
            for (auto &g : scene.gaussians) {
                g.positionOpacity[0] += 100;
                g.positionOpacity[1] += 100;
                g.positionOpacity[2] += 100;
            }
            fitBounds(scene);
            require(!scene.previewEye, "An unrelated world origin is never used as the initial eye");
            close(scene.radius, radius, .0001f, "Translated scenes retain the same content scale");
            close(scene.center.x, center.x + 100, .0001f, "Translated content retains its target");
            Scene single;
            Attributes a;
            a.position = {100, 8, -4};
            a.scale = {.4f, .1f, .2f};
            single.gaussians.push_back(packGaussian(a));
            fitBounds(single);
            require(single.radius >= 1.19f && !single.previewEye,
                    "Small scenes include Gaussian footprints and use outside framing");
        });
        test("Reject malformed files and invalid archive paths", [&] {
            std::vector<Bytes> invalid = {{'p', 'l', 'y', '\n'}, Bytes(16, 0)};
            auto replace = []<class T>(Bytes &data, size_t offset, T value) {
                std::memcpy(data.data() + offset, &value, sizeof(T));
            };
            auto shortSplat = splatBytes;
            shortSplat.pop_back();
            invalid.push_back(shortSplat);
            auto badSplat = splatBytes;
            replace(badSplat, 12, 0.f);
            invalid.push_back(badSplat);
            replace(badSplat, 12, std::numeric_limits<float>::max());
            invalid.push_back(badSplat);
            for (auto offset : {4u, 16u, 4096u, 4096u + 36u}) {
                auto badKsplat = ksplatBytes;
                replace(badKsplat, offset, UINT_MAX);
                invalid.push_back(badKsplat);
            }
            auto badVersion = ksplatBytes;
            badVersion[1] = 2;
            invalid.push_back(badVersion);
            auto shortKsplat = ksplatBytes;
            shortKsplat.resize(shortKsplat.size() - 100);
            invalid.push_back(shortKsplat);
            auto shortCompressed = compressedBytes;
            shortCompressed.pop_back();
            invalid.push_back(shortCompressed);
            auto invalidLegacy = legacyMembers;
            auto legacyMeta = Json::parse(invalidLegacy.at("meta.json"));
            legacyMeta["means"]["shape"] = {10'000'001, 3};
            auto legacyText = legacyMeta.dump();
            invalidLegacy["meta.json"] = Bytes(legacyText.begin(), legacyText.end());
            invalid.push_back(zip(invalidLegacy));
            auto ambiguousZip = members;
            ambiguousZip["another/meta.json"] = members.at("meta.json");
            invalid.push_back(zip(ambiguousZip));
            auto truncated = base;
            truncated.resize(truncated.size() - 200);
            invalid.push_back(truncated);
            auto bad = members;
            bad["../escape.webp"] = Bytes{1, 2, 3};
            invalid.push_back(zip(bad));
            auto meta = Json::parse(members.at("meta.json"));
            meta["count"] = 100'000'000;
            auto text = meta.dump();
            bad = members;
            bad["meta.json"] = Bytes(text.begin(), text.end());
            invalid.push_back(zip(bad));
            auto checksum = sogBytes;
            checksum[100] ^= 1;
            invalid.push_back(checksum);
            for (auto &bytes : invalid) {
                bool rejected = false;
                try {
                    loadScene(bytes);
                } catch (...) {
                    rejected = true;
                }
                require(rejected, "Invalid source was accepted");
            }
            std::stop_source stop;
            stop.request_stop();
            LoadOptions o;
            o.stop = stop.get_token();
            bool canceled = false;
            try {
                loadScene(base, o);
            } catch (...) {
                canceled = true;
            }
            require(canceled, "Canceled decode was accepted");
        });
}
