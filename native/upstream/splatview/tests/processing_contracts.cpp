#include "processing_contracts.hpp"
#include "processing.hpp"
#include "scene_exports.hpp"
#include "editing.hpp"
#include "geometry_tools.hpp"
#include "image_io.hpp"
#include "file_io.hpp"
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <thread>

using namespace preview;
namespace {
constexpr float c0 = .28209479177387814f;
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
void close(float actual, float expected, float tolerance, const char *message) {
    if (!std::isfinite(actual) || std::abs(actual - expected) > tolerance)
        throw std::runtime_error(std::string(message) + ": " + std::to_string(actual) + " vs " +
                                 std::to_string(expected));
}
template <class F> void rejects(F f, const char *message) {
    bool caught = false;
    try {
        f();
    } catch (const std::exception &) {
        caught = true;
    }
    require(caught, message);
}
std::shared_ptr<Scene> fixture(size_t count = 6) {
    auto scene = std::make_shared<Scene>();
    scene->shDegree = 3;
    scene->sourceCount = count;
    scene->format = "Editing fixture";
    scene->yUp = true;
    for (size_t i = 0; i < count; ++i) {
        Attributes a;
        a.position = {float(i) - 2, 0, -2};
        a.scale = {.1f, .2f, .3f};
        a.opacity = .2f + float(i % 6) * .1f;
        for (int c = 0; c < 3; ++c)
            a.sh[c] = (.15f + float(i % 6) * .1f + float(c) * .05f - .5f) / c0;
        for (size_t k = 3; k < a.sh.size(); ++k)
            a.sh[k] = float(int(k % 7) - 3) * .01f;
        scene->gaussians.push_back(packGaussian(a));
    }
    fitBounds(*scene);
    return scene;
}
std::shared_ptr<Scene> gammaFixture() {
    auto scene = fixture();
    // Trained splats can have negative DC channels and almost-zero base
    // luminance, while higher SH bands still reconstruct visible colors.
    constexpr float rgb[6][3] = {{-.4f, .2f, .02f}, {-.5f, -.25f, -.1f}, {-.001f, .1f, .3f},
                                 {0, 0, 0},         {1.5f, .5f, .2f},    {-.2f, .06f, .2f}};
    for (size_t i = 0; i < scene->gaussians.size(); ++i) {
        Attributes a;
        a.position = {float(i) - 2, 0, -2};
        a.scale = {.15f, .15f, .15f};
        a.opacity = .8f;
        for (int c = 0; c < 3; ++c) {
            a.sh[c] = (rgb[i][c] - .5f) / c0;
            if (i != 3) {
                a.sh[6 + c] = -1.5f + .25f * c;
                a.sh[9 + c] = .1f * c;
            }
        }
        scene->gaussians[i] = packGaussian(a);
    }
    fitBounds(*scene);
    return scene;
}
ProcessingResult run(std::shared_ptr<const Scene> scene, Recipe step, std::vector<uint8_t> states = {}) {
    if (states.empty())
        states.resize(scene->gaussians.size());
    return processScene(scene, states, step);
}
Recipe op(const char *type, Recipe values = Recipe::object()) {
    return {{"type", type}, {"values", values}};
}
bool identical(const Scene &a, const Scene &b) {
    return a.gaussians.size() == b.gaussians.size() &&
           !std::memcmp(a.gaussians.data(), b.gaussians.data(), a.gaussians.size() * sizeof(Gaussian));
}
} // namespace
void processingColorContracts(const std::filesystem::path &directory) {
    auto source = fixture();
    auto before = *source;
    const auto &presets = editingPresets();
    require(presets["color"].size() == 39 && presets["opacity"].size() == 12 &&
                presets["filter"].size() == 3 && presets["transform"].size() == 5,
            "All pinned gsmod presets are present");
    close(presets["color"]["warm"]["temperature"].get<float>(), 3300.f / 4500, 1e-6f,
          "Kelvin preset conversion");
    for (auto it = presets["color"].begin(); it != presets["color"].end(); ++it) {
        auto r = run(source, {{"type", "color"}, {"preset", it.key()}});
        for (auto &g : r.scene->gaussians)
            for (unsigned k = 0; k < 16; ++k)
                for (unsigned c = 0; c < 3; ++c)
                    require(std::isfinite(shValue(g, k, c)), "All preset coefficients finite");
    }
    auto r = run(source, op("color", {{"brightness", 1.5}}), {1, 0, 2, 0, 0, 0});
    // Explicit selected-only scope applies all SH bands, preserving geometry and excluded records.
    auto selected = op("color", {{"brightness", 1.5}});
    selected["selected_only"] = true;
    r = run(source, selected, {1, 0, 2, 0, 0, 0});
    close(shValue(r.scene->gaussians[0], 0, 0), shValue(source->gaussians[0], 0, 0) * 1.5f + .5f * .5f / c0,
          .001f, "Brightness DC offset");
    close(shValue(r.scene->gaussians[0], 7, 1), shValue(source->gaussians[0], 7, 1) * 1.5f, .0001f,
          "Brightness higher SH gain");
    require(!std::memcmp(&r.scene->gaussians[1], &source->gaussians[1], sizeof(Gaussian)) &&
                !std::memcmp(&r.scene->gaussians[2], &source->gaussians[2], sizeof(Gaussian)),
            "Unselected and deleted splats preserved");
    auto neutral = run(source, op("color"));
    require(identical(*source, *neutral.scene), "Neutral grade is numerically neutral");
    auto temperature = run(source, op("color", {{"temperature", .5}}));
    close(shValue(temperature.scene->gaussians[0], 4, 0), shValue(source->gaussians[0], 4, 0) * 1.15f, .0001f,
          "Temperature affects higher red SH");
    auto saturation = run(source, op("color", {{"saturation", 0}}));
    for (unsigned k = 0; k < 16; ++k)
        close(shValue(saturation.scene->gaussians[0], k, 0), shValue(saturation.scene->gaussians[0], k, 2),
              1e-6f, "Grayscale covers every SH band");
    auto split = run(source, op("color", {{"shadow_tint_hue", 90},
                                          {"shadow_tint_sat", .5},
                                          {"highlight_tint_hue", 30},
                                          {"highlight_tint_sat", .5}}));
    require(!identical(*source, *split.scene), "Split toning modifies actual scene color");
    for (float factor : {0.f, .8f, 1.f, 1.2f, 5.f}) {
        auto opacity = run(source, op("opacity", {{"scale", factor}}));
        float a = source->gaussians[0].positionOpacity[3];
        close(opacity.scene->gaussians[0].positionOpacity[3],
              std::clamp(factor <= 1 ? a * factor : a + (1 - a) * (factor - 1) / 2, 0.f, 1.f), 1e-6f,
              "gsmod linear opacity semantics");
    }
    require(identical(*source, before), "Processing never mutates the input scene");
    rejects([&] { run(source, op("color", {{"gamma", 0}})); }, "Invalid color rejected");
    rejects([&] { run(source, op("color", {{"brightnes", 1.2}})); }, "Mistyped color field rejected");
    rejects([&] { run(source, op("opacity", {{"scale", -1}})); }, "Negative opacity scale rejected");

    auto directional = gammaFixture();
    for (float gamma : {.1f, .7f, .999f, 1.001f, 1.3f, 5.f}) {
        auto adjusted = run(directional, op("color", {{"gamma", gamma}}));
        for (size_t i = 0; i < directional->gaussians.size(); ++i)
            for (unsigned k = 0; k < 16; ++k)
                for (unsigned c = 0; c < 3; ++c) {
                    float coefficient = shValue(directional->gaussians[i], k, c);
                    float after = shValue(adjusted.scene->gaussians[i], k, c);
                    require(std::isfinite(after), "Gamma stays finite across its full range");
                    if (std::abs(gamma - 1) < .002f)
                        close(after, coefficient, .02f, "Gamma is continuous near neutral for negative DC");
                }
        for (unsigned c = 0; c < 3; ++c)
            close(std::max(0.f, shValue(adjusted.scene->gaussians[3], 0, c) * c0 + .5f), 0, 1e-6f,
                  "Gamma does not lift a truly black splat");
    }
    auto differentGreen = std::make_shared<Scene>(*directional);
    Attributes changed;
    for (unsigned k = 0; k < 16; ++k)
        for (unsigned c = 0; c < 3; ++c)
            changed.sh[3 * k + c] = shValue(directional->gaussians[0], k, c);
    changed.sh[1] += .5f;
    differentGreen->gaussians[0].sh = packGaussian(changed).sh;
    auto gradeA = run(directional, op("color", {{"gamma", .7f}}));
    auto gradeB = run(differentGreen, op("color", {{"gamma", .7f}}));
    for (unsigned k = 0; k < 16; ++k)
        for (unsigned c : {0u, 2u})
            close(shValue(gradeA.scene->gaussians[0], k, c), shValue(gradeB.scene->gaussians[0], k, c), 0,
                  "Gamma in one channel cannot amplify a different channel's directional color");

    auto flat = fixture();
    flat->shDegree = 0;
    for (float gamma : {.1f, .7f, 1.3f, 5.f}) {
        auto adjusted = run(flat, op("color", {{"gamma", gamma}}));
        for (size_t i = 0; i < flat->gaussians.size(); ++i)
            for (unsigned c = 0; c < 3; ++c) {
                float baseColor = shValue(flat->gaussians[i], 0, c) * c0 + .5f;
                close(shValue(adjusted.scene->gaussians[i], 0, c) * c0 + .5f, std::pow(baseColor, gamma),
                      .0003f, "Constant color follows the gamma curve");
            }
    }
    auto brightSource = fixture(3);
    for (size_t i = 0; i < brightSource->gaussians.size(); ++i) {
        Attributes a;
        a.position.x = float(i);
        a.sh.fill(i == 0 ? 59968.f : i == 1 ? -59968.f : 0.f);
        brightSource->gaussians[i] = packGaussian(a);
    }
    auto bright = run(brightSource, op("color", {{"brightness", 2}}));
    close(shValue(bright.scene->gaussians[0], 0, 0), maxShCoefficient, 0,
          "Bright edits reach the finite half-float boundary");
    close(shValue(bright.scene->gaussians[1], 1, 0), -maxShCoefficient, 0,
          "Directional edits preserve the negative half-float boundary");
    const auto folder = directory / L"format-extreme-contracts";
    std::filesystem::create_directories(folder);
    for (const auto &[format, name] :
         {std::pair{SceneExportFormat::Ply, L"edited.ply"}, std::pair{SceneExportFormat::Sog, L"edited.sog"},
          std::pair{SceneExportFormat::Sogs, L"edited.sogs"},
          std::pair{SceneExportFormat::CompressedPly, L"edited.compressed.ply"},
          std::pair{SceneExportFormat::Ksplat, L"edited.ksplat"}}) {
        const auto path = folder / name;
        writeVisibleScene(*bright.scene, bright.states, path, format);
        const auto reopened = loadScene(path);
        require(reopened.gaussians.size() == 3 && reopened.shDegree == 3,
                "Strong color edits save and reopen through each higher-SH codec");
        if (format != SceneExportFormat::CompressedPly)
            for (const auto &g : reopened.gaussians) {
                const auto index = size_t(std::lround(g.positionOpacity[0]));
                if (index < 2)
                    close(shValue(g, 1, 0), index ? -maxShCoefficient : maxShCoefficient, 0,
                          "Edited maximum SH coefficients survive saving and reopening");
            }
    }
}
void processingGeometryContracts(const std::filesystem::path &) {
    auto source = fixture();
    auto affine = run(source, op("transform", {{"scale", {2, 3, 4}}, {"translation", {1, 2, 3}}}));
    auto &g = affine.scene->gaussians[0];
    close(g.positionOpacity[0], -3, 1e-6f, "Scaled translated position");
    close(g.positionOpacity[2], -5, 1e-6f, "Z position");
    close(g.covA[0], .04f, 1e-6f, "World scale covariance xx");
    close(g.covA[3], .36f, 1e-6f, "World scale covariance yy");
    close(g.covB[1], 1.44f, 1e-5f, "World scale covariance zz");
    auto rot = run(source, op("transform", {{"euler", {0, 0, 90}}, {"center", {-1, 0, 0}}}));
    close(rot.scene->gaussians[0].positionOpacity[0], -1, .000001f, "Pivot x");
    close(rot.scene->gaussians[0].positionOpacity[1], -1, .000001f, "Pivot y");
    close(rot.scene->gaussians[0].covA[0], .04f, 1e-6f, "Rotated covariance");
    auto quaternion = run(source, op("transform", {{"rotation", {.70710678, 0, 0, .70710678}}}));
    auto aa = run(source, op("transform", {{"axis_angle", {0, 0, 1.57079632679}}}));
    close(quaternion.scene->gaussians[0].positionOpacity[1], aa.scene->gaussians[0].positionOpacity[1],
          .000001f, "Quaternion and axis angle agree");
    for (float factor : {1e-30f, 1e-12f, 1e12f}) {
        auto scaled =
            run(source, op("transform", {{"rotation", {.70710678f * factor, 0, 0, .70710678f * factor}}}));
        for (size_t i = 0; i < source->gaussians.size(); ++i)
            for (unsigned c = 0; c < 4; ++c) {
                close(scaled.scene->gaussians[i].positionOpacity[c],
                      quaternion.scene->gaussians[i].positionOpacity[c], .000001f,
                      "Quaternion magnitude cannot change an affine rotation");
                close(scaled.scene->gaussians[i].covA[c], quaternion.scene->gaussians[i].covA[c], .000001f,
                      "Quaternion magnitude cannot change rotated covariance");
            }
    }
    auto matrix =
        run(source, op("transform", {{"matrix", {1, 1, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}}}));
    close(matrix.scene->gaussians[0].covA[0], .05f, 1e-6f, "Affine shear covariance");
    close(matrix.scene->gaussians[0].covA[1], .04f, 1e-6f, "Affine cross covariance");
    auto norm = run(source, op("normalize", {{"target_size", 2}}));
    auto xyz = run(source, op("transform", {{"euler", {90, 90, 90}}}));
    close(xyz.scene->gaussians[0].positionOpacity[0], -2, .000001f, "Combined Euler rotation x");
    close(xyz.scene->gaussians[0].positionOpacity[2], 2, .000001f, "Combined Euler rotation order");
    close(norm.scene->gaussians.back().positionOpacity[0] - norm.scene->gaussians.front().positionOpacity[0],
          2, 1e-6f, "Normalized longest dimension");
    auto center = run(source, op("center"));
    close(center.scene->gaussians.front().positionOpacity[0] +
              center.scene->gaussians.back().positionOpacity[0],
          0, 1e-6f, "Centered scene");
    auto select = [&](Recipe values) {
        auto step = op("filter", values);
        step["action"] = "select";
        return run(source, step);
    };
    auto sphere = select({{"sphere_center", {0, 0, -2}}, {"sphere_radius", 1}});
    require(std::ranges::equal(sphere.states, std::vector<uint8_t>({0, 1, 1, 1, 0, 0})), "Sphere includes boundary centers");
    auto box = select({{"box_min", {-1, -.1, -2.1}}, {"box_max", {1, .1, -1.9}}});
    require(box.states == sphere.states, "Box bounds");
    auto ellipsoid = select({{"ellipsoid_center", {0, 0, -2}}, {"ellipsoid_radii", {1, .5, .5}}});
    require(ellipsoid.states == sphere.states, "Ellipsoid bounds");
    auto rotatedBox = select(
        {{"box_min", {-.1, -1.01, -2.1}}, {"box_max", {.1, 1.01, -1.9}}, {"box_rot", {0, 0, 1.57079632679}}});
    require(rotatedBox.states == sphere.states, "Rotated box inverse coordinates");
    auto rotatedEllipsoid = select({{"ellipsoid_center", {0, 0, -2}},
                                    {"ellipsoid_radii", {.5, 1.01, .5}},
                                    {"ellipsoid_rot", {0, 0, 1.57079632679}}});
    require(rotatedEllipsoid.states == sphere.states, "Rotated ellipsoid inverse coordinates");
    auto frustum = select({{"frustum_pos", {0, 0, 0}},
                           {"frustum_fov", 1.57079632679},
                           {"frustum_near", 1},
                           {"frustum_far", 3}});
    require(frustum.states[2] == 1 && frustum.states[5] == 0, "Frustum looks along native -Z");
    auto boolean = select({{"and", Recipe::array({Recipe{{"sphere_center", {0, 0, -2}}, {"sphere_radius", 1}},
                                                  Recipe{{"min_opacity", .4}}})}});
    require(boolean.states[1] == 0 && boolean.states[2] == 1, "Boolean AND and opacity threshold");
    auto inverse = select({{"not", {{"sphere_center", {0, 0, -2}}, {"sphere_radius", 1}}}});
    require(inverse.states[0] == 1 && inverse.states[2] == 0, "Boolean NOT");
    auto either =
        select({{"or", Recipe::array({Recipe{{"max_opacity", .21}}, Recipe{{"min_opacity", .69}}})}});
    require(either.states[0] == 1 && either.states[5] == 1 && either.states[2] == 0, "Boolean OR");
    auto scales = select({{"max_scale", .29}});
    require(std::none_of(scales.states.begin(), scales.states.end(), [](auto v) { return v == 1; }),
            "Scale filter uses largest principal axis");
    auto crop = run(source, op("filter", {{"min_opacity", .4}}));
    require(crop.scene == source && crop.states[0] == 2 && crop.states[5] == 0,
            "Filter changes compact state only");
    rejects([&] { run(source, op("transform", {{"rotation", {0, 0, 0, 0}}})); }, "Zero quaternion rejected");
    rejects([&] { select({{"ellipsoid_radii", {0, 1, 1}}}); }, "Zero radius rejected");
    rejects([&] { select({{"frustum_pos", {0, 0, 0}}, {"frustum_near", 2}, {"frustum_far", 1}}); },
            "Invalid frustum rejected");
    rejects([&] { select({{"sphere_raduis", 1}}); }, "Mistyped filter rejected");
}
void processingCompositionContracts(const std::filesystem::path &directory) {
    auto source = fixture();
    source->gaussians.push_back(source->gaussians[0]);
    source->sourceCount++;
    auto first = run(source, op("deduplicate", {{"position_threshold", .01}, {"method", "first"}}));
    require(first.scene == source && first.states.back() == 2 && first.states[0] == 0,
            "First occurrence dedup, no geometry copy");
    auto last = run(source, op("deduplicate", {{"position_threshold", .01}, {"method", "last"}}));
    require(last.states[0] == 2 && last.states.back() == 0, "Last occurrence dedup");
    auto cluster = fixture(1);
    cluster->gaussians.resize(32000, cluster->gaussians[0]);
    cluster->sourceCount = 32000;
    auto dense = run(cluster, op("deduplicate", {{"position_threshold", .01}, {"method", "last"}}));
    require(std::count(dense.states.begin(), dense.states.end(), uint8_t(2)) == 31999 &&
                dense.states.back() == 0,
            "Dense last-occurrence dedup prunes stale neighbors");
    auto neighbors = fixture(2);
    neighbors->gaussians[0].positionOpacity[0] = .099f;
    neighbors->gaussians[1].positionOpacity[0] = .101f;
    auto adjacent = run(neighbors, op("deduplicate", {{"position_threshold", .01}}));
    require(adjacent.states[1] == 2, "Dedup searches neighboring grid cells");
    auto path = directory / L"editing-merge.ply";
    std::vector<uint8_t> states(source->gaussians.size());
    writeVisibleScene(*source, states, path, SceneExportFormat::Ply);
    auto merge =
        run(source,
            op("merge", {{"path", narrow(path.wstring())}, {"transform", {{"translation", {100, 0, 0}}}}}));
    require(merge.scene->gaussians.size() == 14 && merge.states.size() == 14 &&
                merge.scene->sourceCount == 14,
            "Merge topology and metadata");
    close(merge.scene->gaussians[7].positionOpacity[0], 98, .000001f,
          "Merge transform applies only to added scene");
    auto dedup = run(
        source,
        op("merge", {{"path", narrow(path.wstring())}, {"deduplicate", true}, {"position_threshold", .001}}));
    require(std::count(dedup.states.begin(), dedup.states.end(), uint8_t(2)) == 8,
            "Merge with deduplication");
    Recipe split = op("split", {{"sphere_center", {0, 0, -2}}, {"sphere_radius", 1}});
    auto region = run(source, split);
    std::vector<uint8_t> inside(region.states.begin(), region.states.end());
    std::vector<uint8_t> outside(region.states.begin(), region.states.end());
    for (size_t i = 0; i < inside.size(); ++i) {
        inside[i] = region.states[i] == 1 ? 0 : 2;
        outside[i] = region.states[i] == 1 ? 2 : 0;
    }
    writeVisibleScene(*source, inside, directory / L"editing-region.ply", SceneExportFormat::Ply);
    writeVisibleScene(*source, outside, directory / L"editing-remainder.spz", SceneExportFormat::Spz);
    require(loadScene(directory / L"editing-region.ply").gaussians.size() +
                    loadScene(directory / L"editing-remainder.spz").gaussians.size() ==
                source->gaussians.size(),
            "Split exports partition the scene");
    auto edited =
        run(source, Recipe::array({op("transform", {{"translation", {1, 2, 3}}}),
                                   op("color", {{"saturation", .4}}), op("opacity", {{"scale", .7}})}));
    for (auto pair : {std::pair{SceneExportFormat::Ply, L"editing-export.ply"},
                      {SceneExportFormat::Spz, L"editing-export.spz"},
                      {SceneExportFormat::Splat, L"editing-export.splat"}}) {
        auto dest = directory / pair.second;
        writeVisibleScene(*edited.scene, edited.states, dest, pair.first);
        auto reloaded = loadScene(dest);
        require(reloaded.gaussians.size() == 7, "Processed exports retain loaded topology");
        close(reloaded.gaussians[0].positionOpacity[0], edited.scene->gaussians[0].positionOpacity[0], .0001f,
              "Processed export position");
        close(reloaded.gaussians[0].positionOpacity[3], edited.scene->gaussians[0].positionOpacity[3], .004f,
              "Processed export opacity");
    }
    rejects([&] { run(source, op("deduplicate", {{"position_threshold", 0}})); },
            "Zero dedup distance rejected");
}
void processingAnalysisContracts(const std::filesystem::path &directory) {
    auto source = fixture();
    auto before = *source;
    auto analysis = run(source, op("histogram"));
    require(analysis.scene == source && analysis.report["histogram"]["samples"] == 6,
            "Histogram does not copy scene");
    for (auto method : {"enhance", "contrast", "exposure", "white_balance", "optimal"}) {
        auto values = Recipe{{"method", method}, {"target_mean", .5}, {"target_std", .2}};
        auto result = run(source, op("auto", values));
        require(result.report.contains("suggested_color"), "Automatic correction returns reusable values");
    }
    auto disabled = run(source, op("auto", {{"method", "enhance"}, {"strength", 0}}));
    require(identical(*disabled.scene, *source), "Zero enhancement strength is neutral");
    for (auto name :
         {"neutral", "vibrant", "dramatic", "bright", "dark", "warm", "cool", "cinematic", "muted", "punchy"})
        require(run(source, op("auto", {{"method", "profile"}, {"profile", name}}))
                    .report.contains("suggested_color"),
                "All histogram profiles work");
    auto target = run(source, op("color", {{"brightness", 1.3}}));
    auto path = directory / L"editing-reference.ply";
    writeVisibleScene(*target.scene, target.states, path, SceneExportFormat::Ply);
    auto matched = run(source, op("match", {{"path", narrow(path.wstring())}, {"strength", 1}}));
    require(!identical(*source, *matched.scene), "Reference histogram matching modifies colors");
    Image image{4, 4, AdmittedVector<uint8_t>(64)};
    for (size_t i = 0; i < image.bgra.size(); i += 4) {
        image.bgra[i] = 200;
        image.bgra[i + 1] = 100;
        image.bgra[i + 2] = 50;
        image.bgra[i + 3] = 255;
    }
    for (auto name : {L"editing-reference.png", L"editing-reference.jpg"}) {
        auto file = directory / name;
        if (file.extension() == L".png")
            writePng(image, file);
        else
            writeJpeg95(image, file);
        auto reference = run(source, op("match", {{"path", narrow(file.wstring())}}));
        close(shValue(reference.scene->gaussians[0], 0, 0) * c0 + .5f, 50.f / 255, .025f,
              "WIC reference RGB channel order");
        close(shValue(reference.scene->gaussians[0], 0, 2) * c0 + .5f, 200.f / 255, .025f,
              "PNG/JPEG reference matching");
    }
    auto noMatch = run(source, op("match", {{"path", narrow(path.wstring())}, {"strength", 0}}));
    require(noMatch.scene == source, "Zero match strength skips geometry copy");
    auto learned = run(source, op("learn", {{"path", narrow(path.wstring())}, {"iterations", 8}}));
    require(learned.report["learned_color"].size() == 15 &&
                learned.report["final_loss"].get<float>() < learned.report["initial_loss"].get<float>(),
            "CPU learned grading improves reference fit");
    require(identical(*source, before), "Analysis and matching preserve input");
    Recipe pipeline = {
        {"version", 1},
        {"parameters", {{"amount", 1.3}}},
        {"steps", Recipe::array({op("color", {{"brightness", "$amount"}}), op("opacity", {{"scale", .8}})})}};
    auto combined = run(source, pipeline);
    auto sequential =
        run(run(source, op("color", {{"brightness", 1.3}})).scene, op("opacity", {{"scale", .8}}));
    require(identical(*combined.scene, *sequential.scene),
            "Ordered parameterized pipeline agrees with separate edits");
    auto json = directory / L"editing-pipeline.json";
    writeRecipe(json, pipeline);
    require(readRecipe(json) == pipeline, "Pipeline JSON round trip preserves parameters");
    auto gsmod = run(source, {{"color", {{"brightness", 1.3}}}, {"opacity", {{"scale", .8}}}});
    require(identical(*gsmod.scene, *combined.scene), "gsmod value configuration import");
    auto bare = run(source, {{"brightness", 1.3}});
    require(identical(*bare.scene, *run(source, op("color", {{"brightness", 1.3}})).scene),
            "Bare gsmod color JSON import");
    auto factory = run(source, {{"from_rotation_euler", {0, 0, 90}}});
    close(factory.scene->gaussians[0].positionOpacity[1], -2, .000001f,
          "gsmod transform factory JSON import");
    auto axisFactory =
        run(source,
            op("transform", {{"from_rotation_axis_angle", Recipe::array({Recipe::array({0, 0, 1}), 90})}}));
    close(axisFactory.scene->gaussians[0].positionOpacity[1], -2, .000001f,
          "gsmod axis-angle factory import");
    rejects([&] { run(source, Recipe::array({op("color", {{"brightness", 1.3}}), op("missing")})); },
            "Invalid later step fails atomically");
    require(identical(*source, before), "Failed pipeline preserves source");
    rejects(
        [&] {
            auto j = pipeline;
            j["parameters"].erase("amount");
            run(source, j);
        },
        "Missing template parameter rejected");
    rejects(
        [&] {
            auto j = pipeline;
            j["steps"] = Recipe::array();
            for (int i = 0; i < 129; ++i)
                j["steps"].push_back(op("color"));
            run(source, j);
        },
        "Bounded pipeline step count");
    rejects([&] { writeRecipe(json, op("color", {{"brightness", "$missing"}})); },
            "Invalid recipe write rejected");
    require(readRecipe(json) == pipeline, "Failed recipe write preserves existing file");
    std::stop_source stop;
    stop.request_stop();
    std::vector<uint8_t> states(6);
    rejects([&] { processScene(source, states, pipeline, false, stop.get_token()); },
            "Cancelled edit produces no result");
    Recipe deep = op("color");
    for (int i = 0; i < 40; ++i)
        deep = {{"nested", deep}};
    {
        std::ofstream f(directory / L"editing-deep.json");
        f << deep.dump();
    }
    rejects([&] { readRecipe(directory / L"editing-deep.json"); }, "Deep recipe rejected before execution");
}
void processingHistoryContracts(const std::filesystem::path &) {
    auto source = fixture();
    SceneEdits edits(source);
    edits.selectAll();
    auto result = processScene(source, edits.states(), op("color", {{"brightness", 1.2}}));
    auto changed = result.scene;
    require(edits.replaceScene(changed, result.states), "Small revision is undoable");
    edits.deleteSelected();
    require(edits.visibleCount() == 0, "Flag edits still work after attributes");
    require(edits.undo() && edits.scene() == changed && edits.visibleCount() == 6,
            "Undo flags with modified geometry");
    require(edits.undo() && edits.scene() == source && edits.selectedCount() == 6,
            "Undo processed geometry with selection");
    require(edits.undo() && edits.selectedCount() == 0, "Undo selection before processing");
    require(edits.redo() && edits.redo() && edits.scene() == changed && edits.redo() &&
                edits.visibleCount() == 0,
            "Mixed history redo");
    edits.undo();
    auto merge = std::make_shared<Scene>(*changed);
    merge->gaussians.push_back(changed->gaussians[0]);
    std::vector<uint8_t> states(7);
    require(edits.replaceScene(merge, states), "Topology revision undoable");
    require(edits.undo() && edits.scene() == changed && edits.states().size() == 6 && edits.redo() &&
                edits.states().size() == 7,
            "Topology undo/redo restores matching masks");
    edits.undo();
    edits.selectNone();
    require(!edits.canRedo(), "New selection clears redo scene snapshots");
    auto large = fixture();
    large->gaussians.resize(470000, large->gaussians[0]);
    large->sourceCount = large->gaussians.size();
    std::vector<uint8_t> largeStates(large->gaussians.size());
    require(edits.replaceScene(large, largeStates), "Large scene revisions retain undo snapshots");
    require(edits.undo() && edits.scene() == changed && edits.redo() && edits.scene() == large,
            "Large snapshots restore scene data and matching masks");
    SceneEdits snapshots(source);
    for (int i = 1; i <= 12; ++i) {
        auto next = fixture();
        next->gaussians[0].positionOpacity[0] = float(i);
        std::vector<uint8_t> mask(next->gaussians.size(), uint8_t(i % 2));
        snapshots.replaceScene(next, std::move(mask));
    }
    for (int i = 11; i >= 2; --i) {
        require(snapshots.undo() && snapshots.scene()->gaussians[0].positionOpacity[0] == float(i) &&
                    snapshots.selectedCount() == (i % 2 ? 6 : 0),
                "The ten latest snapshots must restore both attributes and selection");
    }
    require(!snapshots.canUndo(), "Undo history retains exactly ten snapshots");
    for (int i = 3; i <= 12; ++i)
        require(snapshots.redo() && snapshots.scene()->gaussians[0].positionOpacity[0] == float(i),
                "All ten snapshots remain available for redo");
    require(!snapshots.canRedo(), "Redo ends at the latest snapshot");
}
void processingAlignmentContracts(const std::filesystem::path &) {
    auto source = fixture();
    Camera saved;
    saved.fit(*source);
    saved.roll = .31f;
    source->defaultView = saved.savedView();
    source->previewEye = Vec3{1, 2, 3};
    source->alignmentFrame = transformMatrix({{"translation", {-.4f, .2f, .1f}}});
    const auto original = *source;
    const auto translation = transformMatrix({{"translation", {1, 2, 3}}});
    const auto rotation = alignFromPoints({.1f, -.3f, 0}, {1, .4f, 0}, {0, .2f, 1});
    const auto scale = transformMatrix({{"scale", 2}});
    auto aligned = [&](std::shared_ptr<const Scene> scene, const Matrix4 &matrix, const Camera &camera) {
        return processScene(scene, std::vector<uint8_t>(scene->gaussians.size()), matrixRecipe(matrix),
                            false, {}, AlignmentView{matrix, camera.savedView()});
    };
    auto compareMatrix = [](const Matrix4 &actual, const Matrix4 &expected, const char *message) {
        for (size_t i = 0; i < actual.size(); ++i)
            close(actual[i], expected[i], 2e-5f, message);
    };
    auto multiply = [](const Matrix4 &a, const Matrix4 &b) {
        using namespace DirectX;
        Matrix4 result;
        XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()),
                       XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(a.data())) *
                           XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(b.data())));
        return result;
    };
    const auto translatedCamera = saved.transformed(translation);
    auto translated = aligned(source, translation, translatedCamera);
    require(translated.scene->defaultView == translatedCamera.savedView() && !translated.scene->previewEye,
            "Alignment replaces framing hints with the transformed default camera, including roll");
    compareMatrix(translated.scene->alignmentFrame, multiply(source->alignmentFrame, translation),
                  "Alignment composes after the previous scene frame");
    for (size_t i = 0; i < source->gaussians.size(); ++i)
        require(translated.scene->gaussians[i].sh == source->gaussians[i].sh,
                "Translation must preserve directional colors exactly");
    const auto rotatedCamera = translatedCamera.transformed(rotation);
    auto rotated = aligned(translated.scene, rotation, rotatedCamera);
    const auto scaledCamera = rotatedCamera.transformed(scale);
    auto scaled = aligned(rotated.scene, scale, scaledCamera);
    compareMatrix(scaled.scene->alignmentFrame,
                  multiply(multiply(multiply(source->alignmentFrame, translation), rotation), scale),
                  "Consecutive alignment actions compose the complete scene frame");
    for (size_t i = 0; i < source->gaussians.size(); ++i)
        require(scaled.scene->gaussians[i].sh == rotated.scene->gaussians[i].sh,
                "Uniform scaling must preserve directional colors exactly");
    auto regularTransform = processScene(source, std::vector<uint8_t>(source->gaussians.size()),
                                         matrixRecipe(rotation));
    require(!regularTransform.scene->defaultView && !regularTransform.scene->previewEye &&
                regularTransform.scene->alignmentFrame == source->alignmentFrame,
            "Ordinary geometry edits clear stale framing without becoming coordinate alignment");
    require(regularTransform.scene->gaussians[0].sh == source->gaussians[0].sh,
            "Ordinary transforms retain the established directional color behavior");
    const std::vector<uint8_t> selection{1, 0, 2, 0, 0, 0};
    const auto partial = processScene(source, selection, matrixRecipe(rotation), true, {},
                                      AlignmentView{rotation, saved.transformed(rotation).savedView()});
    require(std::ranges::equal(partial.states, selection) && partial.scene->gaussians[0].sh != source->gaussians[0].sh,
            "Selected alignment rotates directional colors only for active splats and retains the mask");
    for (size_t i = 1; i < selection.size(); ++i)
        require(!std::memcmp(&partial.scene->gaussians[i], &source->gaussians[i], sizeof(Gaussian)),
                "Selected alignment preserves all unselected and deleted Gaussian attributes exactly");
    for (unsigned channel = 0; channel < 3; ++channel)
        close(shValue(partial.scene->gaussians[0], 0, channel), shValue(source->gaussians[0], 0, channel), 0,
              "Directional alignment preserves the DC coefficient exactly");
    // Scene snapshots must carry alignment metadata through mixed selection/content history.
    SceneEdits edits(source);
    const auto sourceRevision = edits.contentRevision();
    edits.selectAll();
    require(edits.contentRevision() == sourceRevision, "Selection does not dirty aligned geometry");
    require(edits.replaceScene(translated.scene, translated.states), "Translated alignment is undoable");
    const auto translatedRevision = edits.contentRevision();
    require(edits.replaceScene(rotated.scene, rotated.states), "Rotated alignment is undoable");
    require(edits.undo() && edits.scene() == translated.scene &&
                edits.contentRevision() == translatedRevision &&
                edits.scene()->defaultView == translatedCamera.savedView(),
            "Undo restores the aligned scene, camera metadata and content revision together");
    require(edits.undo() && edits.scene() == source && edits.contentRevision() == sourceRevision &&
                edits.scene()->alignmentFrame == original.alignmentFrame && edits.selectedCount() == 6,
            "Undo of the first alignment restores the original frame and selection");
    require(edits.redo() && edits.redo() && edits.scene() == rotated.scene &&
                edits.scene()->defaultView == rotatedCamera.savedView(),
            "Redo restores the aligned default camera and complete metadata");
    const std::vector<uint8_t> deleted(source->gaussians.size(), 2);
    rejects([&] {
        processScene(source, deleted, matrixRecipe(translation), false, {},
                     AlignmentView{translation, translatedCamera.savedView()});
    }, "Alignment must reject scenes with no visible splats");
    std::stop_source cancelled;
    cancelled.request_stop();
    rejects([&] {
        processScene(source, std::vector<uint8_t>(source->gaussians.size()), matrixRecipe(rotation), false,
                     cancelled.get_token(), AlignmentView{rotation, saved.transformed(rotation).savedView()});
    }, "Cancelled alignment must produce no scene or metadata result");
    rejects([&] {
        processScene(source, std::vector<uint8_t>(source->gaussians.size()),
                     Recipe::array({matrixRecipe(rotation), op("missing")}), false, {},
                     AlignmentView{rotation, saved.transformed(rotation).savedView()});
    }, "A failed later recipe step must not publish a partially aligned scene");
    require(identical(*source, original) && source->defaultView == original.defaultView &&
                source->previewEye == original.previewEye && source->alignmentFrame == original.alignmentFrame,
            "Completed, cancelled and failed alignment jobs preserve all immutable source data");
}
