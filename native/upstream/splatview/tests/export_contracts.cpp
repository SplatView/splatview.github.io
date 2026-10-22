#include "export_contracts.hpp"
#include "scene_exports.hpp"
#include "format_fixtures.hpp"
#include <load-spz.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iterator>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <thread>

using namespace preview;
namespace {
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
void close(float a, float b, float tolerance, const char *message) {
    if (!std::isfinite(b) || std::abs(a - b) > tolerance)
        throw std::runtime_error(std::string(message) + ": " + std::to_string(a) + " vs " +
                                 std::to_string(b));
}
std::vector<uint8_t> read(const std::filesystem::path &path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), {}};
}
void sentinel(const std::filesystem::path &path) {
    std::ofstream file(path, std::ios::binary);
    file << "keep previous output";
}
constexpr std::array formats{SceneExportFormat::Ply,    SceneExportFormat::Spz,
                             SceneExportFormat::Splat,  SceneExportFormat::CompressedPly,
                             SceneExportFormat::Ksplat, SceneExportFormat::Csv,
                             SceneExportFormat::Sog,    SceneExportFormat::Sogs};
constexpr const wchar_t *extensions[] = {L".ply",    L".spz", L".splat", L".compressed.ply",
                                         L".ksplat", L".csv", L".sog",   L".sogs"};
Scene csvScene(const std::filesystem::path &path, unsigned degree) {
    const auto bytes = read(path);
    std::istringstream csv{std::string(bytes.begin(), bytes.end())};
    std::string header, line, body;
    std::getline(csv, header);
    std::vector<std::string> names;
    std::istringstream columns(header);
    while (std::getline(columns, line, ','))
        names.push_back(line);
    std::vector<std::string> expected = {"x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2"};
    for (unsigned j = 0; j < ((degree + 1) * (degree + 1) - 1) * 3; ++j)
        expected.push_back("f_rest_" + std::to_string(j));
    for (auto name : {"opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"})
        expected.push_back(name);
    require(names == expected, "CSV uses complete Gaussian PLY column names and order");
    size_t count = 0;
    while (std::getline(csv, line)) {
        require(std::count(line.begin(), line.end(), ',') == ptrdiff_t(names.size() - 1),
                "CSV rows have exactly one value per attribute");
        std::replace(line.begin(), line.end(), ',', ' ');
        body += line + '\n';
        ++count;
    }
    // Interpret the independently parsed CSV as standard ASCII Gaussian PLY;
    // this checks log scales, opacity logits, SH ordering and the geometry basis.
    std::string ply = "ply\nformat ascii 1.0\nelement vertex " + std::to_string(count) + '\n';
    for (const auto &name : names)
        ply += "property float " + name + '\n';
    ply += "end_header\n" + body;
    return loadScene(std::span(reinterpret_cast<const uint8_t *>(ply.data()), ply.size()));
}
template <class Function> void rejects(Function action) {
    bool rejected = false;
    try {
        action();
    } catch (const std::exception &) {
        rejected = true;
    }
    require(rejected, "Invalid export must fail");
}
} // namespace
void sceneExportContracts(const std::filesystem::path &directory) {
    auto folder = directory / L"scene-export-contracts";
    std::filesystem::create_directories(folder);
    Scene scene;
    scene.sourceCount = 100000; // saves the loaded preview, not the claimed original count
    for (int i = 0; i < 2400; ++i) {
        Attributes a;
        a.position = {-.83f + i * .0008f, .31f - i * .0004f, -.67f - i * .0003f};
        a.scale = {.013f + i * .00002f, .071f, .023f};
        a.quaternion = {.31f + i * .0001f, -.44f, .53f, -.23f};
        a.opacity = i % 3 == 0 ? 0.f : i % 3 == 1 ? .37f : 1.f;
        for (unsigned j = 0; j < 16; ++j)
            for (unsigned c = 0; c < 3; ++c)
                a.sh[j * 3 + c] = .7f * std::sin(float(i + j * 3 + c));
        scene.gaussians.push_back(packGaussian(a));
    }
    std::reverse(scene.gaussians.begin(), scene.gaussians.end());
    std::vector<uint8_t> states(scene.gaussians.size());
    for (size_t i = 0; i < states.size(); ++i)
        states[i] = i % 7 == 0 ? 2 : i % 3 == 0 ? 1 : 0;
    size_t count = std::count_if(states.begin(), states.end(), [](auto s) { return !(s & 2); });
    const auto original = scene.gaussians;
    for (unsigned degree = 0; degree <= 3; ++degree) {
        scene.shDegree = degree;
        for (auto format : formats) {
            const auto extension = extensions[size_t(format)];
            auto path = folder / (L"\u6d4b\u8bd5-" + std::to_wstring(degree) + extension);
            writeVisibleScene(scene, states, path, format);
            auto restored = format == SceneExportFormat::Csv ? csvScene(path, degree) : loadScene(path);
            unsigned restoredDegree = format == SceneExportFormat::Splat ? 0 : degree;
            require(restored.sourceCount == count && restored.gaussians.size() == count &&
                        restored.shDegree == restoredDegree,
                    "Scene export count, deleted filtering and SH degree");
            if (format == SceneExportFormat::Splat)
                require(std::filesystem::file_size(path) == count * 32, "SPLAT record size");
            if (format == SceneExportFormat::Ksplat)
                require(std::filesystem::file_size(path) ==
                            5132 + count * (44 + ((degree + 1) * (degree + 1) - 1) * 12),
                        "KSPLAT v0.1 float record layout and section metadata");
            if (format == SceneExportFormat::Sog || format == SceneExportFormat::Sogs) {
                require(restored.format == (format == SceneExportFormat::Sog ? "SOG v2" : "SOG v1"),
                        "Modern SOG and legacy SOGS use their respective metadata layouts");
                const auto bytes = read(path);
                require(bytes[0] == 'P' && bytes[1] == 'K', "SOG/SOGS exports are bundled ZIP scenes");
            }
            if (format == SceneExportFormat::Spz) {
                auto bytes = read(path);
                require(bytes[0] == 0x1f && bytes[1] == 0x8b, "SPZ uses gzip");
                spz::UnpackOptions options;
                options.to = spz::CoordinateSystem::RUB;
                auto reference = spz::loadSpz(bytes, options);
                require(reference.numPoints == int(count) && reference.shDegree == int(degree),
                        "Pinned SPZ reference decoder accepts streamed export");
                close(reference.positions[0], scene.gaussians[1].positionOpacity[0], .00013f,
                      "SPZ reference coordinates");
            }
            std::vector<bool> seen(states.size());
            for (const auto &b : restored.gaussians) {
                // Packed PLY/SOG are spatially reordered. Unique X coordinates
                // identify the original independently of the writer's sort.
                const auto i =
                    states.size() - 1 - size_t(std::lround((b.positionOpacity[0] + .83f) / .0008f));
                require(i < states.size() && !(states[i] & 2) && !seen[i],
                        "Spatial ordering preserves every visible Gaussian exactly once");
                seen[i] = true;
                const auto &a = scene.gaussians[i];
                const bool packedPly = format == SceneExportFormat::CompressedPly;
                const bool sog = format == SceneExportFormat::Sog || format == SceneExportFormat::Sogs;
                for (unsigned c = 0; c < 3; ++c)
                    close(a.positionOpacity[c], b.positionOpacity[c],
                          format == SceneExportFormat::Spz || packedPly ? .00013f
                          : sog                                         ? .00005f
                                                                        : .000001f,
                          "Export preserves position and coordinate convention");
                close(a.positionOpacity[3], b.positionOpacity[3],
                      format == SceneExportFormat::Sogs ? .016f : .002f, "Export opacity");
                float covarianceTolerance = format == SceneExportFormat::Ply ||
                                                    format == SceneExportFormat::Csv ||
                                                    format == SceneExportFormat::Ksplat
                                                ? .000001f
                                                : std::max({a.covA[0], a.covA[3], a.covB[1]}) *
                                                          (format == SceneExportFormat::Spz ? .08f
                                                           : packedPly                      ? .008f
                                                                                            : .035f) +
                                                      .0000001f;
                for (unsigned c = 0; c < 4; ++c) {
                    close(a.covA[c], b.covA[c], covarianceTolerance,
                          "Export rotated anisotropic covariance A");
                    close(a.covB[c], b.covB[c], covarianceTolerance,
                          "Export rotated anisotropic covariance B");
                }
                for (unsigned j = 0; j < (restoredDegree + 1) * (restoredDegree + 1); ++j)
                    for (unsigned c = 0; c < 3; ++c) {
                        float tolerance = format == SceneExportFormat::Ply || format == SceneExportFormat::Csv
                                              ? .00001f
                                          : format == SceneExportFormat::Ksplat       ? (j ? .00001f : .0075f)
                                          : format == SceneExportFormat::Splat || sog ? .0075f
                                          : packedPly                                 ? (j ? .0165f : .004f)
                                          : j == 0                                    ? .014f
                                          // SPZ rounds to a byte, then to the nearest bucket.
                                          : j < 4 ? 4.5f / 128 + .00001f
                                                  : 8.5f / 128 + .00001f;
                        close(shValue(a, j, c), shValue(b, j, c), tolerance, "Export SH color convention");
                    }
            }
        }
    }
    require(std::memcmp(original.data(), scene.gaussians.data(), original.size() * sizeof(Gaussian)) == 0,
            "Exports never mutate scene data");
    for (auto format : formats) {
        auto path = folder / L"existing-output";
        sentinel(path);
        auto previous = read(path);
        std::stop_source cancelled;
        cancelled.request_stop();
        rejects([&] { writeVisibleScene(scene, states, path, format, cancelled.get_token()); });
        auto hidden = std::vector<uint8_t>(states.size(), 2);
        rejects([&] { writeVisibleScene(scene, hidden, path, format); });
        rejects([&] { writeVisibleScene(scene, std::span(states).first(2), path, format); });
        require(read(path) == previous, "Cancelled, empty and mismatched exports preserve prior file");
    }
    auto path = folder / L"out-of-range.spz";
    sentinel(path);
    auto previous = read(path);
    scene.gaussians[1].positionOpacity[0] = 10000;
    rejects([&] { writeVisibleScene(scene, states, path, SceneExportFormat::Spz); });
    require(read(path) == previous, "SPZ overflow preserves existing destination after encoder failure");
    auto fallback = folder / L"large-position.ply";
    writeVisibleScene(scene, {}, fallback, SceneExportFormat::Ply);
    require(loadScene(fallback).gaussians.size() == scene.gaussians.size(),
            "PLY remains available for scenes outside the SPZ position range");
    // Partial packed chunks, a one-splat SH palette and constant attribute
    // ranges must remain finite and retain the exact record count.
    for (auto format : {SceneExportFormat::CompressedPly, SceneExportFormat::Sog, SceneExportFormat::Sogs}) {
        for (unsigned length : {1u, 63u, 64u, 255u, 256u, 257u, 512u}) {
            Scene constant;
            constant.shDegree = 1;
            Attributes a;
            a.position = {2.5f, -1.5f, 3.f};
            a.scale = {.1f, .1f, .1f};
            a.opacity = 0; // lossless WebP must retain hidden RGB data
            a.sh[0] = .3f;
            a.sh[1] = -.2f;
            a.sh[3] = .6f;
            constant.gaussians.assign(length, packGaussian(a));
            auto boundary = folder / (L"boundary-" + std::to_wstring(length) + extensions[size_t(format)]);
            writeVisibleScene(constant, {}, boundary, format);
            auto decoded = loadScene(boundary);
            require(decoded.sourceCount == length && decoded.shDegree == 1,
                    "Partial packed chunks, palette rows and zero ranges");
            for (const auto &g : decoded.gaussians) {
                for (unsigned c = 0; c < 3; ++c)
                    close(g.positionOpacity[c], constant.gaussians[0].positionOpacity[c], .000001f,
                          "Zero-extent position remains finite");
                close(shValue(g, 0, 0), .3f, .001f, "Transparent splats retain DC color");
                close(shValue(g, 1, 0), .6f, .02f, "Constant higher SH palette");
            }
        }
    }
    Scene large;
    large.shDegree = 3;
    constexpr unsigned largeCount = 131072;
    large.gaussians.reserve(largeCount);
    for (unsigned i = 0; i < largeCount; ++i) {
        Attributes a;
        a.position = {float(i % 512) * .01f, float(i / 512) * .01f, 1.f};
        const float size = .002f * std::exp(float(i % 211) / 300);
        a.scale = {size, size, size};
        if (i % 8192 == 1) {
            // None of these rare, large splats falls in the old uniform
            // scale sample (stride 8). Endpoints alone cannot preserve them.
            const float background = std::exp(.4f + float(i / 8192) * .18f);
            a.scale = {background, background, background};
        }
        for (unsigned c = 0; c < 48; ++c)
            a.sh[c] = .4f * std::sin(float(i % 211) * .03f + c);
        large.gaussians.push_back(packGaussian(a));
    }
    const auto largePath = folder / L"full-palette.sog";
    writeVisibleScene(large, {}, largePath, SceneExportFormat::Sog);
    auto largeDecoded = loadScene(largePath);
    require(largeDecoded.gaussians.size() == largeCount && largeDecoded.shDegree == 3,
            "SH vector compression supports more than 65536 splats and full 16-bit palette labels");
    double squaredError = 0;
    for (const auto &g : largeDecoded.gaussians) {
        const auto x = unsigned(std::lround(g.positionOpacity[0] * 100));
        const auto y = unsigned(std::lround(g.positionOpacity[1] * 100));
        require(x < 512 && y < 256, "SOG palette test spatial correspondence");
        const auto &expected = large.gaussians[y * 512 + x];
        const float variance = expected.covA[0];
        close(g.covA[0], variance, variance * .16f + 1e-9f,
              "SOG preserves rare background scales beyond the uniform sample");
        close(g.covA[3], variance, variance * .16f + 1e-9f, "SOG background Y covariance");
        close(g.covB[1], variance, variance * .16f + 1e-9f, "SOG background Z covariance");
        for (unsigned j = 1; j < 16; ++j)
            for (unsigned c = 0; c < 3; ++c) {
                const auto difference = shValue(g, j, c) - shValue(expected, j, c);
                squaredError += difference * difference;
            }
    }
    require(std::sqrt(squaredError / (largeCount * 45)) < .006,
            "CPU SH palette keeps angular color error bounded on the reference scene");
    // Interrupt after the encoder opens its temporary archive: cancellation
    // during WebP output preserves a previous file and cleans incomplete data.
    const auto cancelledPath = folder / L"cancelled-encoding.sog";
    sentinel(cancelledPath);
    const auto cancelledPrevious = read(cancelledPath);
    std::stop_source encoderStop;
    std::jthread interrupt([&](std::stop_token stop) {
        while (!stop.stop_requested()) {
            for (const auto &entry : std::filesystem::directory_iterator(folder)) {
                std::error_code error;
                if (entry.path().extension() == L".tmp" &&
                    std::filesystem::file_size(entry.path(), error) > 0 && !error) {
                    encoderStop.request_stop();
                    return;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });
    rejects([&] {
        writeVisibleScene(large, {}, cancelledPath, SceneExportFormat::Sog, encoderStop.get_token());
    });
    interrupt.request_stop();
    interrupt.join();
    require(encoderStop.stop_requested() && read(cancelledPath) == cancelledPrevious,
            "Cancellation during texture encoding preserves existing SOG output");
    for (auto &entry : std::filesystem::directory_iterator(folder))
        require(entry.path().extension() != L".tmp", "Failed writes clean their temporary files");
}
void formatQuantizationContracts(const std::filesystem::path &directory) {
    const auto folder = directory / L"format-edge-contracts";
    std::filesystem::create_directories(folder);
    constexpr unsigned count = 32768;
    Scene source;
    source.shDegree = 3;
    source.gaussians.reserve(count);
    for (unsigned i = 0; i < count; ++i) {
        Attributes a;
        a.position = {float(i % 256) * .02f, float(i / 256) * .02f, -1.f};
        a.opacity = .5f;
        for (unsigned c = 0; c < 3; ++c)
            a.sh[c] = .2f * std::sin(float(i) * .03f + c);
        for (unsigned j = 0; j < 45; ++j)
            a.sh[j + 3] = .02f * std::sin(float(i) * .02f + j);
        // Rare signed values deliberately fall between the old uniform DC
        // sample records and between the scalar SH palette's sampled offsets.
        if (i % 1024 == 1) {
            const auto k = i / 1024;
            for (unsigned c = 0; c < 3; ++c)
                a.sh[c] = (k % 2 ? -1.f : 1.f) * (3.f + k * .2f + c * .015625f);
        }
        if (i % 1024 == 3) {
            const auto k = i / 1024;
            a.sh[3 + (i % 23 + 1) % 45] = (k % 2 ? -1.f : 1.f) * (.5f + k * .1f);
        }
        if (i == 7)
            a.scale = {1e-12f, 1e-12f, 1e-12f};
        if (i >= 9 && i <= 13)
            a.opacity = std::array{0.f, 1.f / 255, 2.f / 255, 254.f / 255, 1.f}[i - 9];
        source.gaussians.push_back(packGaussian(a));
    }
    for (auto format : formats) {
        const auto path = folder / (L"edge" + std::wstring(extensions[size_t(format)]));
        writeVisibleScene(source, {}, path, format);
        auto decoded = format == SceneExportFormat::Csv ? csvScene(path, 3) : loadScene(path);
        require(decoded.gaussians.size() == count &&
                    decoded.shDegree == (format == SceneExportFormat::Splat ? 0u : 3u),
                "Edge-value export preserves count and supported SH degree");
        spz::GaussianCloud spzReference;
        if (format == SceneExportFormat::Spz) {
            spz::UnpackOptions options;
            options.to = spz::CoordinateSystem::RUB;
            spzReference = spz::loadSpz(read(path), options);
            require(spzReference.numPoints == count, "SPZ reference accepts edge-value export");
        }
        std::vector<bool> seen(count);
        double dcError = 0, shError = 0;
        for (const auto &g : decoded.gaussians) {
            const auto x = std::lround(g.positionOpacity[0] / .02f);
            const auto y = std::lround(g.positionOpacity[1] / .02f);
            require(x >= 0 && x < 256 && y >= 0 && y < 128, "Edge-value export retains grid positions");
            const auto index = size_t(y * 256 + x);
            require(!seen[index], "Edge-value export retains every Gaussian exactly once");
            seen[index] = true;
            const auto &a = source.gaussians[index];
            if (index >= 9 && index <= 13)
                close(a.positionOpacity[3], g.positionOpacity[3],
                      format == SceneExportFormat::Sogs ? .0005f : .000002f,
                      "Opacity endpoints and byte levels 1/255 and 2/255 survive decoding");
            if (index == 7) {
                // Compare relative variance: an absolute 1e-7 tolerance hides
                // millions-fold enlargement of tiny but valid Gaussians.
                const bool spz = format == SceneExportFormat::Spz;
                const float expected = spz ? std::exp(-20.f) : a.covA[0];
                const float tolerance = format == SceneExportFormat::Sogs                   ? .1f
                                        : format == SceneExportFormat::CompressedPly || spz ? .05f
                                                                                            : .00001f;
                for (float variance : {g.covA[0], g.covA[3], g.covB[1]})
                    close(1.f, variance / expected, tolerance,
                          "Tiny scales retain their size within the format's precision");
            }
            for (unsigned j = 0; j < (decoded.shDegree + 1) * (decoded.shDegree + 1); ++j)
                for (unsigned c = 0; c < 3; ++c) {
                    float expected = shValue(a, j, c);
                    const float actual = shValue(g, j, c);
                    const float difference = actual - expected;
                    (j ? shError : dcError) += double(difference) * difference;
                    float tolerance = .00001f;
                    if (format == SceneExportFormat::Spz) {
                        // Fixed byte ranges are part of SPZ, not a scene-wide
                        // codebook. Verify their documented clipping separately.
                        expected = std::clamp(expected, j ? -1.f : -1.f / .3f, j ? 127.f / 128 : 1.f / .3f);
                        tolerance = j ? .067f : .016f;
                        close(actual,
                              j ? spzReference.sh[index * 45 + (j - 1) * 3 + c]
                                : spzReference.colors[index * 3 + c],
                              .002f, "SPZ edge coefficients match Niantic's independent decoder");
                    } else if (!j &&
                               (format == SceneExportFormat::Splat || format == SceneExportFormat::Ksplat)) {
                        expected = std::clamp(expected, -1.77245385f, 1.77245385f);
                        tolerance = .008f;
                    } else if (format == SceneExportFormat::CompressedPly)
                        tolerance = j ? .0165f : .04f;
                    else if (format == SceneExportFormat::Sog || format == SceneExportFormat::Sogs)
                        tolerance = j ? .02f : .04f;
                    close(expected, actual, tolerance, "Rare color and SH values retain format precision");
                }
        }
        if (format == SceneExportFormat::Sog) {
            require(std::sqrt(dcError / (count * 3)) < .0015 && std::sqrt(shError / (count * 45)) < .0007,
                    "Retaining rare SOG coefficients also keeps common colors accurate");
        }
        if (format == SceneExportFormat::CompressedPly || format == SceneExportFormat::Ksplat ||
            format == SceneExportFormat::Sog || format == SceneExportFormat::Sogs ||
            format == SceneExportFormat::Splat)
            writeVisiblePly(decoded, {}, folder / (path.filename().wstring() + L".decoded.ply"));
    }
}
void formatExtremesContracts(const std::filesystem::path &directory) {
    const auto folder = directory / L"format-extreme-contracts";
    std::filesystem::create_directories(folder);
    auto covarianceClose = [](const Gaussian &expected, const Gaussian &actual, float tolerance) {
        const float magnitude = std::max({expected.covA[0], expected.covA[3], expected.covB[1]});
        require(magnitude > 0, "Covariance comparison has a positive scale");
        for (unsigned c = 0; c < 4; ++c) {
            close(expected.covA[c] / magnitude, actual.covA[c] / magnitude, tolerance,
                  "Relative covariance A survives export");
            close(expected.covB[c] / magnitude, actual.covB[c] / magnitude, tolerance,
                  "Relative covariance B survives export");
        }
    };
    Attributes base;
    base.scale = {.013f, .071f, .023f};
    base.quaternion = {.3f, -.5f, .7f, .4f};
    const auto expected = packGaussian(base);
    std::vector<Attributes> rotations;
    for (float factor : {1e-30f, 1e-12f, 1.f, 1e12f, 1e30f}) {
        auto a = base;
        a.position.x = float(rotations.size());
        for (auto &q : a.quaternion)
            q *= factor;
        covarianceClose(expected, packGaussian(a), .000001f);
        rotations.push_back(a);
    }
    const auto ksplat = format_tests::ksplat(rotations, 0, 0);
    auto loadedRotations = loadScene(ksplat);
    for (const auto &g : loadedRotations.gaussians)
        covarianceClose(expected, g, .000001f);
    // Raw on-disk quaternions, before the native exporter can normalize them.
    const auto rawPly = folder / L"raw-quaternions.ply";
    {
        std::ofstream out(rawPly);
        out.imbue(std::locale::classic());
        out << std::setprecision(std::numeric_limits<float>::max_digits10)
            << "ply\nformat ascii 1.0\nelement vertex " << rotations.size() << '\n';
        for (auto name : {"x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1",
                          "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"})
            out << "property float " << name << '\n';
        out << "end_header\n";
        for (const auto &a : rotations)
            out << a.position.x << " 0 0 0 0 0 0 " << std::log(a.scale.x) << ' ' << std::log(a.scale.y) << ' '
                << std::log(a.scale.z) << ' ' << a.quaternion[0] << ' ' << a.quaternion[1] << ' '
                << -a.quaternion[2] << ' ' << -a.quaternion[3] << '\n';
    }
    loadedRotations = loadScene(rawPly);
    for (const auto &g : loadedRotations.gaussians)
        covarianceClose(expected, g, .000001f);
    for (auto invalid :
         {std::array{0.f, 0.f, 0.f, 0.f}, std::array{std::numeric_limits<float>::infinity(), 0.f, 0.f, 0.f},
          std::array{std::numeric_limits<float>::quiet_NaN(), 0.f, 0.f, 0.f}}) {
        auto a = base;
        a.quaternion = invalid;
        rejects([&] { packGaussian(a); });
    }
    for (float invalid : {1e-30f, 1e20f}) {
        auto a = base;
        a.scale.x = invalid;
        rejects([&] { packGaussian(a); });
    }
    // Rotated anisotropic shapes over 38 orders of linear scale. No absolute
    // covariance tolerance can mask an enlargement at the small end.
    Scene geometry;
    geometry.shDegree = 3;
    constexpr std::array logs{-46.f, -42.f, -39.f, -30.f, -20.f, -10.f, -5.f,
                              0.f,   10.f,  20.f,  23.f,  27.f,  30.f,  40.f};
    for (float logScale : logs)
        for (unsigned angle = 0; angle < 8; ++angle) {
            Attributes a;
            a.position = {float(geometry.gaussians.size()) * .1f, 0, -1};
            a.scale = {std::exp(logScale), std::exp(logScale + .3f), std::exp(logScale - .7f)};
            a.quaternion = {std::cos(angle * .27f), std::sin(angle * .37f), -.5f, .3f};
            a.opacity = .5f;
            for (unsigned c = 0; c < 48; ++c)
                a.sh[c] = .02f * std::sin(float(c));
            geometry.gaussians.push_back(packGaussian(a));
        }
    for (auto format : formats) {
        const auto path = folder / (L"geometry" + std::wstring(extensions[size_t(format)]));
        writeVisibleScene(geometry, {}, path, format);
        auto decoded = format == SceneExportFormat::Csv ? csvScene(path, 3) : loadScene(path);
        require(decoded.gaussians.size() == geometry.gaussians.size(), "Extreme geometry reloads completely");
        std::vector<bool> seen(geometry.gaussians.size());
        for (const auto &g : decoded.gaussians) {
            const auto index = size_t(std::lround(g.positionOpacity[0] * 10));
            require(index < seen.size() && !seen[index], "Extreme geometry preserves each record once");
            seen[index] = true;
            const auto &original = geometry.gaussians[index];
            if (format == SceneExportFormat::Spz) {
                const auto axes = exportAxesRdf(original);
                if (*std::min_element(axes.logScales.begin(), axes.logScales.end()) < -10 ||
                    *std::max_element(axes.logScales.begin(), axes.logScales.end()) > 5.9375f)
                    continue; // SPZ's fixed scale range intentionally clips these fixtures.
            }
            const float tolerance = format == SceneExportFormat::Sogs            ? .44f
                                    : format == SceneExportFormat::CompressedPly ? .11f
                                    : format == SceneExportFormat::Spz           ? .08f
                                    : format == SceneExportFormat::Sog || format == SceneExportFormat::Splat
                                        ? .035f
                                        : .0003f;
            covarianceClose(original, g, tolerance);
        }
        if (format != SceneExportFormat::Csv && format != SceneExportFormat::Spz)
            writeVisiblePly(decoded, {}, folder / (path.filename().wstring() + L".decoded.ply"));
    }
    Scene colors;
    colors.shDegree = 3;
    for (float coefficient : {-maxShCoefficient, 0.f, maxShCoefficient}) {
        Attributes a;
        a.position.x = float(colors.gaussians.size());
        a.sh.fill(coefficient);
        colors.gaussians.push_back(packGaussian(a));
    }
    for (float invalid :
         {65536.f, std::numeric_limits<float>::infinity(), std::numeric_limits<float>::quiet_NaN()}) {
        Attributes a;
        a.sh[0] = invalid;
        rejects([&] { packGaussian(a); });
    }
    for (auto format : formats) {
        const auto path = folder / (L"colors" + std::wstring(extensions[size_t(format)]));
        writeVisibleScene(colors, {}, path, format);
        auto decoded = format == SceneExportFormat::Csv ? csvScene(path, 3) : loadScene(path);
        require(decoded.gaussians.size() == colors.gaussians.size(), "Full-range SH export can reopen");
        for (const auto &g : decoded.gaussians) {
            const auto index = size_t(std::lround(g.positionOpacity[0]));
            require(index < colors.gaussians.size(), "Full-range SH spatial correspondence");
            for (unsigned j = 0; j < (decoded.shDegree + 1) * (decoded.shDegree + 1); ++j)
                for (unsigned c = 0; c < 3; ++c) {
                    float coefficient = shValue(colors.gaussians[index], j, c);
                    float tolerance = .00001f;
                    if (format == SceneExportFormat::Spz) {
                        coefficient =
                            std::clamp(coefficient, j ? -1.f : -1.f / .3f, j ? 127.f / 128 : 1.f / .3f);
                        tolerance = j ? .067f : .016f;
                    } else if (!j &&
                               (format == SceneExportFormat::Splat || format == SceneExportFormat::Ksplat)) {
                        coefficient = std::clamp(coefficient, -1.77245385f, 1.77245385f);
                        tolerance = .008f;
                    } else if (j && format == SceneExportFormat::CompressedPly) {
                        coefficient = std::clamp(coefficient, -4.f, 3.984375f);
                        tolerance = .0165f;
                    } else if (format == SceneExportFormat::Sogs ||
                               format == SceneExportFormat::CompressedPly)
                        tolerance = index == 1 ? 258.f : .00001f;
                    close(coefficient, shValue(g, j, c), tolerance,
                          "Full finite half SH and format clipping");
                }
        }
        if (format != SceneExportFormat::Csv && format != SceneExportFormat::Spz)
            writeVisiblePly(decoded, {}, folder / (path.filename().wstring() + L".decoded.ply"));
    }
}
