#include "processing.hpp"
#include "admitted_storage.hpp"
#include "processing_kernels.hpp"
#include "color.hpp"
#include "editing.hpp"
#include "parallel_for.hpp"
#include "gsmod_presets.hpp"
#include "atomic_file.hpp"
#include "math.hpp"
#include "image_io.hpp"
#include "file_io.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <fstream>
#include <numeric>
#include <unordered_map>

namespace preview {
namespace {
constexpr float c0 = .28209479177387814f, pi = 3.14159265358979323846f;
constexpr size_t maxSteps = 128, maxSamples = 65536, maxRecipeBytes = 1024 * 1024;
void check(std::stop_token stop) {
    if (stop.stop_requested())
        throw std::runtime_error("Editing cancelled; the scene was preserved.");
}
using namespace processing_detail;
struct Predicate {
    Recipe j;
    std::vector<Predicate> children;
    std::string mode;
    Affine boxRotation, ellipsoidRotation, frustumRotation;
    std::array<float, 3> sphere{}, boxLow{}, boxHigh{}, ellipsoid{}, radii{1, 1, 1};
    float minOpacity{}, maxOpacity{1}, minScale{}, maxScale{100}, radius{-1}, nearPlane{.1f}, farPlane{100},
        tanY{1}, aspect{1};
    bool box{}, ellipse{}, frustum{}, invert{};
    explicit Predicate(Recipe input, unsigned depth = 0) : j(std::move(input)) {
        if (!j.is_object() || depth > 16)
            throw std::runtime_error("Invalid or overly nested filter");
        keys(j, {"and",           "or",          "not",         "min_opacity",      "max_opacity",
                 "min_scale",     "max_scale",   "invert",      "sphere_center",    "sphere_radius",
                 "box_min",       "box_max",     "box_rot",     "ellipsoid_center", "ellipsoid_radii",
                 "ellipsoid_rot", "frustum_pos", "frustum_rot", "frustum_fov",      "frustum_aspect",
                 "frustum_near",  "frustum_far"});
        for (const char *name : {"and", "or", "not"})
            if (j.contains(name)) {
                if (!mode.empty())
                    throw std::runtime_error("A filter group has one Boolean operator");
                mode = name;
                if (mode == "not")
                    children.emplace_back(j[name], depth + 1);
                else {
                    if (!j[name].is_array() || j[name].empty() || j[name].size() > 128)
                        throw std::runtime_error("Invalid filter group");
                    for (auto &child : j[name])
                        children.emplace_back(child, depth + 1);
                }
            }
        minOpacity = number(j, "min_opacity", 0, 0, 1);
        maxOpacity = number(j, "max_opacity", 1, 0, 1);
        minScale = number(j, "min_scale", 0, 0, 1e12f);
        maxScale = number(j, "max_scale", 100, 0, 1e12f);
        if (minOpacity > maxOpacity || minScale > maxScale)
            throw std::runtime_error("Filter minimum exceeds maximum");
        invert = j.value("invert", false);
        if (j.contains("sphere_radius") && !j["sphere_radius"].is_null())
            radius = number(j, "sphere_radius", 1, 0);
        sphere = array<3>(j, "sphere_center", {});
        box = j.contains("box_min") && !j["box_min"].is_null();
        if (box) {
            if (!j.contains("box_max"))
                throw std::runtime_error("Box needs both corners");
            boxLow = array<3>(j, "box_min", {});
            boxHigh = array<3>(j, "box_max", {});
            for (int c = 0; c < 3; ++c)
                if (boxLow[c] > boxHigh[c])
                    throw std::runtime_error("Box corners are reversed");
            boxRotation = transform(Recipe{{"axis_angle", array<3>(j, "box_rot", {})}});
            for (int c = 0; c < 3; ++c)
                boxRotation.t[c] = (double(boxLow[c]) + boxHigh[c]) / 2;
        }
        ellipse = j.contains("ellipsoid_radii") && !j["ellipsoid_radii"].is_null();
        if (ellipse) {
            radii = array<3>(j, "ellipsoid_radii", {1, 1, 1});
            ellipsoid = array<3>(j, "ellipsoid_center", {});
            for (float r : radii)
                if (r <= 0)
                    throw std::runtime_error("Ellipsoid radii must be positive");
            ellipsoidRotation = transform(
                Recipe{{"axis_angle", array<3>(j, "ellipsoid_rot", {})}, {"translation", ellipsoid}});
        }
        frustum = j.contains("frustum_pos") && !j["frustum_pos"].is_null();
        if (frustum) {
            frustumRotation = transform(Recipe{{"axis_angle", array<3>(j, "frustum_rot", {})},
                                               {"translation", array<3>(j, "frustum_pos", {})}});
            tanY = std::tan(number(j, "frustum_fov", pi / 3, .001f, pi - .001f) / 2);
            aspect = number(j, "frustum_aspect", 1, .001f, 1000);
            nearPlane = number(j, "frustum_near", .1f, 0);
            farPlane = number(j, "frustum_far", 100, .0001f);
            if (farPlane <= nearPlane)
                throw std::runtime_error("Frustum far must exceed near");
        }
    }
    bool operator()(const Gaussian &g) const {
        bool ok = true;
        if (!mode.empty()) {
            if (mode == "and") {
                for (auto &p : children)
                    if (!p(g)) {
                        ok = false;
                        break;
                    }
            } else if (mode == "or") {
                ok = false;
                for (auto &p : children)
                    if (p(g)) {
                        ok = true;
                        break;
                    }
            } else
                ok = !children[0](g);
        }
        if (g.positionOpacity[3] < minOpacity || g.positionOpacity[3] > maxOpacity)
            ok = false;
        if (ok && (minScale > 0 || maxScale < 100)) {
            auto axes = exportAxesRdf(g);
            float s = std::exp(*std::max_element(axes.logScales.begin(), axes.logScales.end()));
            ok = s >= minScale && (maxScale >= 100 || s <= maxScale);
        }
        std::array<double, 3> p{g.positionOpacity[0], g.positionOpacity[1], g.positionOpacity[2]};
        if (ok && radius >= 0)
            ok = std::hypot(p[0] - sphere[0], p[1] - sphere[1], p[2] - sphere[2]) <= radius;
        if (ok && box) {
            auto q = boxRotation.point(p, true);
            for (int c = 0; c < 3; ++c)
                if (std::abs(q[c]) > (double(boxHigh[c]) - boxLow[c]) / 2)
                    ok = false;
        }
        if (ok && ellipse) {
            auto q = ellipsoidRotation.point(p, true);
            double d = 0;
            for (int c = 0; c < 3; ++c)
                d += (q[c] / radii[c]) * (q[c] / radii[c]);
            ok = d <= 1;
        }
        if (ok && frustum) {
            auto q = frustumRotation.point(p, true);
            double d = -q[2];
            ok = d >= nearPlane && d <= farPlane && std::abs(q[0]) <= d * tanY * aspect &&
                 std::abs(q[1]) <= d * tanY;
        }
        return invert ? !ok : ok;
    }
};
using Samples = SceneVector<std::array<float, 3>>;
Samples sample(const Scene &s, std::span<const uint8_t> states, bool selected, std::stop_token stop,
               const std::shared_ptr<SceneMemory> &scratch,
               size_t limit = maxSamples) {
    // An empty mask is the no-edits view used by freshly loaded references;
    // avoid materializing an otherwise unnecessary full zero mask.
    size_t count = states.empty() && !selected ? s.gaussians.size() : 0;
    if (!states.empty())
        for (auto state : states)
            if (!(state & 2) && (!selected || (state & 1)))
                ++count;
    if (!count)
        throw std::runtime_error(selected ? "Select splats first" : "No visible splats");
    check(stop);
    Samples colors{SceneAllocator<std::array<float, 3>>{scratch}};
    colors.reserve(std::min(count, limit));
    size_t ordinal = 0, next = 0, desired = std::min(count, limit);
    for (size_t i = 0; i < s.gaussians.size(); ++i) {
        if ((i & 1023) == 0)
            check(stop);
        const auto state = states.empty() ? 0 : states[i];
        if ((state & 2) || (selected && !(state & 1)))
            continue;
        if (ordinal++ != next * count / desired)
            continue;
        const auto &g = s.gaussians[i];
        colors.push_back({std::clamp(shValue(g, 0, 0) * c0 + .5f, 0.f, 1.f),
                          std::clamp(shValue(g, 0, 1) * c0 + .5f, 0.f, 1.f),
                          std::clamp(shValue(g, 0, 2) * c0 + .5f, 0.f, 1.f)});
        if (++next == desired)
            break;
    }
    return colors;
}
struct Histogram {
    std::array<std::array<float, 256>, 3> bins{};
    std::array<SceneVector<float>, 4> sorted;
    std::array<float, 3> mean{}, deviation{};
    explicit Histogram(const Samples &s)
        : sorted{SceneVector<float>{SceneAllocator<float>{s.get_allocator().memory()}},
                 SceneVector<float>{SceneAllocator<float>{s.get_allocator().memory()}},
                 SceneVector<float>{SceneAllocator<float>{s.get_allocator().memory()}},
                 SceneVector<float>{SceneAllocator<float>{s.get_allocator().memory()}}} {
        if (s.empty())
            throw std::runtime_error("Empty color reference");
        for (auto &a : sorted)
            a.reserve(s.size());
        for (auto c : s) {
            for (int k = 0; k < 3; ++k) {
                bins[k][std::clamp(int(c[k] * 255), 0, 255)]++;
                sorted[k].push_back(c[k]);
                mean[k] += c[k] / float(s.size());
            }
            sorted[3].push_back(lum(c));
        }
        for (auto &a : sorted)
            std::sort(a.begin(), a.end());
        for (int k = 0; k < 3; ++k) {
            for (float x : sorted[k])
                deviation[k] += (x - mean[k]) * (x - mean[k]) / float(s.size());
            deviation[k] = std::sqrt(deviation[k]);
            for (float &b : bins[k])
                b /= float(s.size());
        }
    }
    float percentile(float p, int channel = 3) const {
        auto &s = sorted[channel];
        double i = std::clamp(double(p), 0., 100.) * .01 * (s.size() - 1);
        size_t a = size_t(i), b = std::min(a + 1, s.size() - 1);
        return float(s[a] + (s[b] - s[a]) * (i - a));
    }
    Recipe json() const {
        std::array<float, 3> entropy{}, mode{};
        for (int k = 0; k < 3; ++k) {
            mode[k] = float(std::max_element(bins[k].begin(), bins[k].end()) - bins[k].begin()) / 255;
            for (float b : bins[k])
                if (b > 0)
                    entropy[k] -= b * std::log2(b);
        }
        return {{"samples", sorted[0].size()},
                {"mean", mean},
                {"standard_deviation", deviation},
                {"bins", bins},
                {"entropy", entropy},
                {"mode", mode},
                {"p01", percentile(1)},
                {"p50", percentile(50)},
                {"p99", percentile(99)},
                {"dynamic_range", percentile(99) - percentile(1)}};
    }
};
Samples imageSamples(const std::filesystem::path &path, std::stop_token stop,
                     const std::optional<ResourceBudget> &resources,
                     const std::shared_ptr<SceneMemory> &scratch) {
    const auto decoded = readImage(path, ImageReadOptions{256, stop, resources});
    const auto &image = decoded.image();
    check(stop);
    Samples samples{SceneAllocator<std::array<float, 3>>{scratch}};
    samples.reserve(size_t(image.width) * image.height);
    for (size_t i = 0; i < image.bgra.size(); i += 4) {
        if (!(i % 16384)) check(stop);
        samples.push_back({image.bgra[i + 2] / 255.f, image.bgra[i + 1] / 255.f, image.bgra[i] / 255.f});
    }
    return samples;
}
Samples referenceSamples(const Recipe &j, std::stop_token stop,
                         const std::optional<ResourceBudget> &resources,
                         const std::shared_ptr<SceneMemory> &scratch,
                         std::vector<std::filesystem::path> &inputs) {
    if (!j.contains("path") || !j["path"].is_string())
        throw std::runtime_error("Choose a reference scene or image first");
    const auto path = pathFromUtf8(j["path"].get<std::string>());
    auto ext = pathUtf8(path.extension());
    std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return char(std::tolower(c)); });
    if (ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".bmp" || ext == ".tif" ||
        ext == ".tiff") {
        return imageSamples(path, stop, resources, scratch);
    }
    LoadOptions o;
    o.maxSplats = maxSamples;
    o.stop = stop;
    o.resources = resources;
    auto loaded = loadSceneWithSources(path, o);
    auto &scene=loaded.scene;
    inputs.insert(inputs.end(),loaded.sourceMembers.begin(),loaded.sourceMembers.end());
    if (!scene.isGaussian())
        throw std::runtime_error("PLY point clouds and meshes are view-only");
    return sample(scene, {}, false, stop, scratch);
}
Grade autoGrade(const Samples &s, const Recipe &j) {
    Histogram h(s);
    Recipe v = Recipe::object();
    std::string method = j.value("method", std::string("enhance"));
    float clip = number(j, "clip_percent", .1f, 0, 20);
    if (method == "contrast" || method == "enhance") {
        float range = h.percentile(100 - clip) - h.percentile(clip);
        if (range > .01f)
            v["contrast"] = std::clamp(.95f / range, .5f, 3.f);
        if (method == "contrast" && j.value("per_channel", false)) {
            float gain = 0;
            for (int c = 0; c < 3; ++c) {
                float rangeC = h.percentile(100 - clip, c) - h.percentile(clip, c);
                gain += rangeC > .01f ? 1 / rangeC : 1;
            }
            v["contrast"] = std::clamp(gain / 3, 0.f, 5.f);
        }
    }
    if (method == "exposure" || method == "enhance") {
        float lo = h.percentile(1), hi = h.percentile(99), sum = 0;
        size_t n = 0;
        for (auto &c : s) {
            float l = lum(c);
            if (l >= lo && l <= hi) {
                sum += l;
                ++n;
            }
        }
        if (n && sum / n > .01f)
            v["brightness"] =
                std::clamp(number(j, "target_midtone", .45f, .01f, 1) / (sum / float(n)), .5f, 2.5f);
    }
    if (method == "white_balance" || method == "enhance") {
        auto wbMethod = j.value("white_balance", std::string("gray_world"));
        if (wbMethod != "white_patch" && wbMethod != "gray_world")
            throw std::runtime_error("Unknown white balance method");
        bool patch = wbMethod == "white_patch";
        float lo = h.percentile(patch ? 95.f : 1.f), hi = h.percentile(99);
        std::array<float, 3> avg{};
        size_t n = 0;
        for (auto &c : s)
            if (lum(c) >= lo && (patch || lum(c) <= hi)) {
                for (int k = 0; k < 3; ++k)
                    avg[k] += c[k];
                ++n;
            }
        if (n) {
            for (auto &x : avg)
                x /= float(n);
            float target = patch ? *std::max_element(avg.begin(), avg.end()) : (avg[0] + avg[1] + avg[2]) / 3;
            std::array<float, 3> gain{};
            for (int k = 0; k < 3; ++k)
                gain[k] = std::clamp(target / (avg[k] + 1e-8f), .5f, 2.f);
            v["temperature"] = std::clamp((gain[0] / gain[2] - 1) * .5f, -1.f, 1.f);
            v["tint"] = std::clamp((1 - gain[1] / ((gain[0] + gain[2]) / 2)) * .5f, -1.f, 1.f);
        }
    }
    if (method == "profile") {
        std::string profile = j.value("profile", std::string("neutral"));
        float mean = (h.mean[0] + h.mean[1] + h.mean[2]) / 3,
              deviation = (h.deviation[0] + h.deviation[1] + h.deviation[2]) / 3;
        float contrast = deviation / .289f, brightness = mean / .5f;
        if (profile == "neutral") {
            v["gamma"] =
                mean > .01f && mean < .999999f ? std::clamp(std::log(.5f) / std::log(mean), .5f, 2.f) : 1.f;
            v["contrast"] = contrast > .1f ? std::clamp(1 / contrast, .5f, 2.f) : 1.f;
        } else if (profile == "vibrant")
            v = {{"saturation", 1.3},
                 {"vibrance", 1.2},
                 {"contrast", 1.05},
                 {"gamma", mean > .5f ? .95 : 1.05}};
        else if (profile == "dramatic")
            v = {{"contrast", 1.3}, {"shadows", -.15}, {"highlights", .05}, {"saturation", 1.1}};
        else if (profile == "bright")
            v = {{"brightness", std::clamp(brightness > .1f ? 1.3f / brightness : 1.3f, 1.f, 2.f)},
                 {"gamma", .9}};
        else if (profile == "dark")
            v = {{"brightness", std::clamp(brightness > .1f ? .7f / brightness : .7f, .5f, 1.f)},
                 {"gamma", 1.1}};
        else if (profile == "warm")
            v = {{"temperature", .3}, {"tint", .05}, {"saturation", 1.05}};
        else if (profile == "cool")
            v = {{"temperature", -.3}, {"tint", -.05}, {"saturation", 1.05}};
        else if (profile == "cinematic")
            v = {{"contrast", 1.15},       {"saturation", .9},         {"fade", .08},
                 {"shadows", -.1},         {"highlights", -.05},       {"shadow_tint_hue", .6},
                 {"shadow_tint_sat", .15}, {"highlight_tint_hue", .1}, {"highlight_tint_sat", .1}};
        else if (profile == "muted")
            v = {{"saturation", .7}, {"vibrance", .8}, {"contrast", .9}, {"fade", .05}};
        else if (profile == "punchy")
            v = {{"contrast", 1.25},
                 {"saturation", 1.25},
                 {"vibrance", 1.15},
                 {"shadows", -.1},
                 {"highlights", .1}};
        else
            throw std::runtime_error("Unknown histogram profile");
    } else if (method == "optimal") {
        float mean = 0, variance = 0;
        for (auto &c : s)
            mean += lum(c) / float(s.size());
        for (auto &c : s)
            variance += (lum(c) - mean) * (lum(c) - mean) / float(s.size());
        float deviation = std::sqrt(variance);
        if (j.contains("target_mean") && mean > .01f)
            v["brightness"] = std::clamp(number(j, "target_mean", mean, 0, 1) / mean, .5f, 2.f);
        if (j.contains("target_std") && deviation > .01f) {
            float c = number(j, "target_std", deviation, 0, 1) / deviation;
            if (j.value("preserve_contrast", true))
                c = std::max(c, number(j, "min_contrast_ratio", .8f, 0, 2));
            v["contrast"] = std::clamp(c, .5f, 2.f);
        }
    } else if (method != "contrast" && method != "exposure" && method != "white_balance" &&
               method != "enhance")
        throw std::runtime_error("Unknown automatic correction method");
    if (method == "enhance") {
        float strength = number(j, "strength", 1, 0, 1),
              warmth = j.value("preserve_warmth", true) ? .5f : 1.f;
        v["brightness"] = std::clamp(1 + (v.value("brightness", 1.f) - 1) * strength, .5f, 2.f);
        v["contrast"] = std::clamp(1 + (v.value("contrast", 1.f) - 1) * strength * .7f, .7f, 1.5f);
        v["temperature"] = v.value("temperature", 0.f) * strength * warmth;
        v["tint"] = v.value("tint", 0.f) * strength * warmth;
    }
    return Grade(v);
}
Grade learnGrade(const Samples &source, const Samples &target, const Recipe &j, std::stop_token stop,
                 Recipe &report) {
    Grade g(Recipe::object());
    Histogram reference(target);
    unsigned iterations = unsigned(number(j, "iterations", 80, 1, 200));
    std::array<float, 15> first{}, second{};
    auto loss = [&](const Grade &grade) {
        Samples mapped{source.get_allocator()};
        mapped.reserve(source.size());
        for (auto &rgb : source) {
            std::array<float, 48> sh{};
            for (int c = 0; c < 3; ++c)
                sh[c] = (rgb[c] - .5f) / c0;
            grade.apply(sh, 1);
            mapped.push_back({std::clamp(sh[0] * c0 + .5f, 0.f, 1.f), std::clamp(sh[1] * c0 + .5f, 0.f, 1.f),
                              std::clamp(sh[2] * c0 + .5f, 0.f, 1.f)});
        }
        Histogram h(mapped);
        double error = 0;
        for (int c = 0; c < 3; ++c)
            for (int k = 0; k < 32; ++k) {
                double d =
                    h.percentile((k + .5f) * 100 / 32, c) - reference.percentile((k + .5f) * 100 / 32, c);
                error += d * d / 96;
            }
        return float(error);
    };
    float initial = loss(g), bestLoss = initial;
    Grade best = g;
    for (unsigned step = 1; step <= iterations; ++step) {
        check(stop);
        for (size_t k = 0; k < g.v.size(); ++k) {
            float delta = (colorFields[k].high - colorFields[k].low) * .002f;
            Grade plus = g, minus = g;
            plus.v[k] = std::min(colorFields[k].high, g.v[k] + delta);
            minus.v[k] = std::max(colorFields[k].low, g.v[k] - delta);
            float gradient = (loss(plus) - loss(minus)) / std::max(1e-6f, plus.v[k] - minus.v[k]);
            first[k] = .9f * first[k] + .1f * gradient;
            second[k] = .999f * second[k] + .001f * gradient * gradient;
            float rate = k == 10 || k == 12 || k == 14 ? .8f : .02f;
            g.v[k] =
                std::clamp(g.v[k] - rate * (first[k] / (1 - std::pow(.9f, float(step)))) /
                                        (std::sqrt(second[k] / (1 - std::pow(.999f, float(step)))) + 1e-8f),
                           colorFields[k].low, colorFields[k].high);
        }
        float value = loss(g);
        if (value < bestLoss) {
            bestLoss = value;
            best = g;
        }
    }
    report["learned_color"] = best.json();
    report["initial_loss"] = initial;
    report["final_loss"] = bestLoss;
    return best;
}
struct Cell {
    int64_t x, y, z;
    bool operator==(const Cell &) const = default;
};
struct CellHash {
    size_t operator()(const Cell &c) const {
        auto mix = [](uint64_t x) {
            x ^= x >> 30;
            x *= 0xbf58476d1ce4e5b9ull;
            x ^= x >> 27;
            x *= 0x94d049bb133111ebull;
            return x ^ (x >> 31);
        };
        return size_t(mix(uint64_t(c.x)) ^ std::rotl(mix(uint64_t(c.y)), 21) ^
                      std::rotl(mix(uint64_t(c.z)), 42));
    }
};
void deduplicate(const Scene &s, std::span<uint8_t> states, bool selected, const Recipe &j,
                 std::stop_token stop, const std::shared_ptr<SceneMemory> &scratch) {
    double distance = number(j, "position_threshold", .001f, 1e-12f, 1e6f);
    std::string method = j.value("method", std::string("first"));
    if (method != "first" && method != "last")
        throw std::runtime_error("Deduplication supports first or last");
    using Indices = AdmittedVector<uint32_t>;
    using Entry = std::pair<const Cell, Indices>;
    std::unordered_map<Cell, Indices, CellHash, std::equal_to<Cell>, AdmittedAllocator<Entry>> cells(
        0, CellHash{}, std::equal_to<Cell>{}, AdmittedAllocator<Entry>{scratch});
    cells.reserve(std::min(s.gaussians.size(), size_t(300000)));
    for (size_t i = 0; i < s.gaussians.size(); ++i) {
        if ((i & 1023) == 0)
            check(stop);
        if ((states[i] & 2) || (selected && !(states[i] & 1)))
            continue;
        const auto &p = s.gaussians[i].positionOpacity;
        Cell c{};
        int64_t *parts[] = {&c.x, &c.y, &c.z};
        for (int k = 0; k < 3; ++k) {
            double v = std::floor(p[k] / distance);
            if (!std::isfinite(v) || std::abs(v) > 9e18)
                throw std::runtime_error("Deduplication threshold is too small for these coordinates");
            *parts[k] = int64_t(v);
        }
        bool duplicate = false;
        for (int x = -1; x <= 1; ++x)
            for (int y = -1; y <= 1; ++y)
                for (int z = -1; z <= 1; ++z) {
                    auto found = cells.find({c.x + x, c.y + y, c.z + z});
                    if (found == cells.end())
                        continue;
                    // Last-occurrence mode removes stale neighbors as it goes,
                    // keeping dense duplicate clusters linear in size.
                    auto &indices = found->second;
                    indices.erase(std::remove_if(indices.begin(), indices.end(),
                                                 [&](auto index) { return (states[index] & 2) != 0; }),
                                  indices.end());
                    for (auto index : indices) {
                        if (states[index] & 2)
                            continue;
                        const auto &q = s.gaussians[index].positionOpacity;
                        double d0 = double(p[0]) - q[0], d1 = double(p[1]) - q[1], d2 = double(p[2]) - q[2];
                        if (d0 * d0 + d1 * d1 + d2 * d2 < distance * distance) {
                            if (method == "last")
                                states[index] = 2;
                            else
                                duplicate = true;
                        }
                    }
                }
        if (duplicate)
            states[i] = 2;
        else
            cells.try_emplace(c, AdmittedAllocator<uint32_t>{scratch}).first->second.push_back(uint32_t(i));
    }
}
Recipe substitute(const Recipe &j, const Recipe &params, unsigned depth = 0) {
    if (depth > 32)
        throw std::runtime_error("Recipe nesting exceeds 32");
    if (j.is_string()) {
        auto s = j.get<std::string>();
        if (s.size() > 1 && s[0] == '$') {
            auto name = s.substr(1);
            if (!params.contains(name) || !params[name].is_number())
                throw std::runtime_error("Missing numeric parameter: " + name);
            return params[name];
        }
        return j;
    }
    Recipe out = j;
    if (j.is_object() || j.is_array())
        for (auto it = out.begin(); it != out.end(); ++it)
            *it = substitute(*it, params, depth + 1);
    return out;
}
} // namespace

const Recipe &editingPresets() {
    static const auto presets = Recipe::parse(gsmodPresetJson);
    return presets;
}
Recipe resolveRecipe(const Recipe &input) {
    if (input.dump().size() > maxRecipeBytes)
        throw std::runtime_error("Recipe exceeds 1 MiB");
    Recipe recipe = input;
    if (recipe.is_object() && recipe.contains("version") && recipe["version"] != 1)
        throw std::runtime_error("Unsupported editing recipe version");
    if (recipe.is_object() && !recipe.contains("steps") && !recipe.contains("type")) {
        Recipe steps = Recipe::array();
        for (const char *type : {"color", "opacity", "transform", "filter"})
            if (recipe.contains(type))
                steps.push_back({{"type", type}, {"values", recipe[type]}});
        if (steps.empty()) {
            std::string type;
            for (auto it = recipe.begin(); it != recipe.end(); ++it) {
                if (std::any_of(std::begin(colorFields), std::end(colorFields),
                                [&](auto field) { return it.key() == field.name; }))
                    type = "color";
                else if (it.key().starts_with("from_") || it.key() == "scale" || it.key() == "translation" ||
                         it.key() == "rotation" || it.key() == "center")
                    type = "transform";
                else if (it.key().starts_with("min_") || it.key().starts_with("max_") ||
                         it.key().starts_with("sphere_") || it.key().starts_with("box_") ||
                         it.key().starts_with("ellipsoid_") || it.key().starts_with("frustum_") ||
                         it.key() == "invert")
                    type = "filter";
                if (!type.empty())
                    break;
            }
            if (type.empty())
                throw std::runtime_error("Recipe needs steps or gsmod editing values");
            steps.push_back({{"type", type}, {"values", recipe}});
            recipe = Recipe::object();
        }
        recipe["steps"] = steps;
    }
    Recipe params = recipe.is_object() ? recipe.value("parameters", Recipe::object()) : Recipe::object();
    if (!params.is_object() || params.size() > 64)
        throw std::runtime_error("Invalid recipe parameters");
    recipe = substitute(recipe, params);
    Recipe steps = recipe.is_array()          ? recipe
                   : recipe.contains("steps") ? recipe["steps"]
                                              : Recipe::array({recipe});
    if (!steps.is_array() || steps.empty() || steps.size() > maxSteps)
        throw std::runtime_error("Use between 1 and 128 recipe steps");
    for (auto &step : steps) {
        if (!step.is_object() || !step.contains("type") || !step["type"].is_string())
            throw std::runtime_error("Each step needs a type");
        auto type = step["type"].get<std::string>();
        keys(step, {"type", "values", "preset", "action", "selected_only", "analyze_only"});
        if (step.contains("preset")) {
            if (!editingPresets().contains(type) ||
                !editingPresets()[type].contains(step["preset"].get<std::string>()))
                throw std::runtime_error("Unknown preset");
            auto values = editingPresets()[type][step["preset"].get<std::string>()];
            values.update(step.value("values", Recipe::object()));
            step["values"] = values;
        }
    }
    return steps;
}
Matrix4 transformMatrix(const Recipe &values) {
    const auto affine = transform(values);
    Matrix4 matrix = identityMatrix;
    for (unsigned r = 0; r < 3; ++r) {
        matrix[12 + r] = float(affine.t[r]);
        for (unsigned c = 0; c < 3; ++c)
            matrix[c * 4 + r] = float(affine.a[r][c]);
    }
    return matrix;
}
ProcessingResult processScene(std::shared_ptr<const Scene> input, std::span<const uint8_t> stateInput,
                              const Recipe &recipe, bool selectedOnly, std::stop_token stop,
                              const std::optional<AlignmentView> &alignmentView,
                              std::optional<ResourceBudget> resources) {
    if (!input || !input->isGaussian() || input->gaussians.size() != stateInput.size() ||
        input->gaussians.size() > processingSplatLimit ||
        std::any_of(stateInput.begin(), stateInput.end(), [](auto state) { return state > 2; }))
        throw std::runtime_error("Invalid scene for editing");
    check(stop);
    if(resources) {
        const auto bytes=checkedByteSum({checkedByteProduct(input->gaussians.capacity(),sizeof(Gaussian)),
            checkedByteProduct(input->vertices.capacity(),sizeof(PreviewVertex)),
            checkedByteProduct(input->triangles.capacity(),sizeof(std::array<uint32_t,3>))});
        if(accountedSceneStorageBytes(*input,*resources)!=bytes)
            throw std::runtime_error("Processing input storage does not belong to the requested budget");
    }
    const auto scratch = resources ? sceneMemoryForBudget(*resources, ResourceCategory::Work) : nullptr;
    auto steps = resolveRecipe(recipe);
    ProcessingResult result;
    result.scene = input;
    result.states = SceneVector<uint8_t>(stateInput.begin(), stateInput.end(), SceneAllocator<uint8_t>{scratch});
    result.report = Recipe::object();
    std::shared_ptr<Scene> output;
    auto writable = [&]() -> Scene & {
        if (!output) {
            check(stop);
            output = std::make_shared<Scene>(*result.scene);
            result.scene = output;
        }
        return *output;
    };
    bool moved = false;
    for (const auto &step : steps) {
        check(stop);
        auto type = step["type"].get<std::string>();
        auto values = step.value("values", Recipe::object());
        if ((type == "merge" || type == "concatenate" || type == "match" || type == "learn") &&
            values.contains("path"))
            result.inputs.emplace_back(pathFromUtf8(values["path"].get<std::string>()));
        bool selected = step.value("selected_only", selectedOnly);
        auto active = [&](size_t i) {
            return !(result.states[i] & 2) && (!selected || (result.states[i] & 1));
        };
        if (selected && std::none_of(result.states.begin(), result.states.end(),
                                     [](auto state) { return (state & 3) == 1; }))
            throw std::runtime_error("Select splats first");
        if (type == "color" || type == "auto" || type == "learn") {
            Grade grade = type == "color" ? Grade(values)
                          : type == "auto"
                              ? autoGrade(sample(*result.scene, result.states, selected, stop, scratch), values)
                              : learnGrade(sample(*result.scene, result.states, selected, stop, scratch, 1024),
                                           referenceSamples(values, stop, resources, scratch, result.inputs), values, stop, result.report);
            if (type == "auto")
                result.report["suggested_color"] = grade.json();
            if (step.value("analyze_only", false) || grade.neutral())
                continue;
            auto &scene = writable();
            applyColor(scene, result.states, grade, selected, stop);
        } else if (type == "opacity") {
            keys(values, {"scale"});
            float scale = number(values, "scale", 1, 0, 5);
            if (scale == 1)
                continue;
            auto &scene = writable();
            detail::parallelFor(scene.gaussians.size(), stop, [&](size_t i) {
                if (active(i)) {
                    auto &v = scene.gaussians[i].positionOpacity[3];
                    v = std::clamp(scale <= 1 ? v * scale : v + (1 - v) * (scale - 1) / 2, 0.f, 1.f);
                }
            });
        } else if (type == "transform" || type == "center" || type == "normalize") {
            if (type != "transform") {
                std::array<double, 3> low{1e30, 1e30, 1e30}, high{-1e30, -1e30, -1e30};
                bool any = false;
                for (size_t i = 0; i < result.states.size(); ++i)
                    if (active(i)) {
                        any = true;
                        for (int c = 0; c < 3; ++c) {
                            auto x = result.scene->gaussians[i].positionOpacity[c];
                            low[c] = std::min(low[c], double(x));
                            high[c] = std::max(high[c], double(x));
                        }
                    }
                if (!any)
                    throw std::runtime_error("No visible splats to transform");
                std::array<float, 3> translation{};
                double scale = 1;
                if (type == "normalize") {
                    double extent = std::max({high[0] - low[0], high[1] - low[1], high[2] - low[2]});
                    if (extent < 1e-12)
                        throw std::runtime_error("Scene has no spatial extent");
                    scale = number(values, "target_size", 2, .000001f, 1e6f) / extent;
                }
                for (int c = 0; c < 3; ++c)
                    translation[c] = float(-(low[c] + high[c]) * .5 * scale);
                values = {{"translation", translation}, {"scale", scale}};
            }
            auto affine = transform(values);
            if (alignmentView && std::none_of(result.states.begin(), result.states.end(), [&](uint8_t state) {
                    return !(state & 2) && (!selected || (state & 1));
                }))
                throw std::runtime_error("No visible splats to align");
            auto &scene = writable();
            applyTransform(scene, result.states, affine, selected, alignmentView.has_value(), stop);
            moved = true;
        } else if (type == "filter" || type == "split") {
            Predicate predicate(values);
            auto action = type == "split" ? std::string("select") : step.value("action", std::string("keep"));
            if (action != "select" && action != "add" && action != "remove" && action != "intersect" &&
                action != "keep" && action != "delete")
                throw std::runtime_error("Unknown filter action");
            detail::parallelFor(result.states.size(), stop, [&](size_t i) {
                if (active(i)) {
                    bool matches = predicate(result.scene->gaussians[i]);
                    auto &state = result.states[i];
                    if ((action == "keep" && !matches) || (action == "delete" && matches))
                        state = 2;
                    else if (action == "select")
                        state = matches ? 1 : 0;
                    else if (action == "add" && matches)
                        state = 1;
                    else if (action == "remove" && matches)
                        state = 0;
                    else if (action == "intersect" && !matches)
                        state = 0;
                }
            });
        } else if (type == "deduplicate")
            deduplicate(*result.scene, result.states, selected, values, stop, scratch);
        else if (type == "merge" || type == "concatenate") {
            if (!values.contains("path"))
                throw std::runtime_error("Choose a scene to merge");
            LoadOptions o;
            o.stop = stop;
            o.resources = resources;
            auto loaded = loadSceneWithSources(pathFromUtf8(values["path"].get<std::string>()), o);
            auto &added=loaded.scene;
            result.inputs.insert(result.inputs.end(),loaded.sourceMembers.begin(),loaded.sourceMembers.end());
            if (!added.isGaussian())
                throw std::runtime_error("PLY point clouds and meshes are view-only");
            if (added.gaussians.size() + result.scene->gaussians.size() > o.maxSplats)
                throw std::runtime_error("Merged scene exceeds the 3 million splat editing limit");
            if (values.contains("transform")) {
                auto affine = transform(values["transform"]);
                applyTransform(added, {}, affine, false, false, stop);
            }
            auto &scene = writable();
            scene.gaussians.insert(scene.gaussians.end(), added.gaussians.begin(), added.gaussians.end());
            result.states.resize(scene.gaussians.size());
            scene.sourceCount += added.sourceCount;
            scene.shDegree = std::max(scene.shDegree, added.shDegree);
            if (type == "merge" && values.value("deduplicate", false))
                deduplicate(scene, result.states, false, values, stop, scratch);
            result.report["merged_loaded"] = added.gaussians.size();
            result.report["merged_source"] = added.sourceCount;
            moved = true;
        } else if (type == "histogram") {
            auto colors = sample(*result.scene, result.states, selected, stop, scratch);
            Histogram h(colors);
            result.report["histogram"] = h.json();
            SceneVector<float> scales{SceneAllocator<float>{scratch}};
            scales.reserve(colors.size());
            size_t stride = std::max(size_t(1), result.scene->gaussians.size() / maxSamples);
            for (size_t i = 0; i < result.states.size(); i += stride)
                if (active(i)) {
                    check(stop);
                    auto a = exportAxesRdf(result.scene->gaussians[i]);
                    scales.push_back(std::exp(*std::max_element(a.logScales.begin(), a.logScales.end())));
                }
            if (!scales.empty()) {
                std::sort(scales.begin(), scales.end());
                result.report["recommended_max_scale"] = scales[size_t((scales.size() - 1) * .995)];
            }
        } else if (type == "match") {
            Histogram source(sample(*result.scene, result.states, selected, stop, scratch)),
                target(referenceSamples(values, stop, resources, scratch, result.inputs));
            float strength = number(values, "strength", 1, 0, 1);
            std::array<std::array<float, 256>, 3> lut{};
            if (strength == 0)
                continue;
            for (int c = 0; c < 3; ++c) {
                float cumulative = 0;
                for (int b = 0; b < 256; ++b) {
                    cumulative += source.bins[c][b];
                    lut[c][b] = target.percentile(cumulative * 100, c);
                }
            }
            auto &scene = writable();
            detail::parallelFor(scene.gaussians.size(), stop, [&](size_t i) {
                if (active(i)) {
                    auto a = coefficients(scene.gaussians[i]);
                    for (int c = 0; c < 3; ++c) {
                        float rgb = std::clamp(a[c] * c0 + .5f, 0.f, 1.f), x = rgb * 255;
                        int b = std::min(int(x), 254);
                        float matched = lut[c][b] + (lut[c][b + 1] - lut[c][b]) * (x - b);
                        a[c] = (rgb + (matched - rgb) * strength - .5f) / c0;
                    }
                    store(scene.gaussians[i], a);
                }
            });
        } else
            throw std::runtime_error("Unknown editing step: " + type);
    }
    check(stop);
    if (moved && output) {
        output->previewEye.reset();
        if (alignmentView) {
            using namespace DirectX;
            const auto frame =
                XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(input->alignmentFrame.data()));
            const auto transform =
                XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(alignmentView->transform.data()));
            XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(output->alignmentFrame.data()), frame * transform);
            output->defaultView = alignmentView->defaultView;
        } else
            output->defaultView.reset();
        fitBounds(*output,scratch);
    }
    size_t visible = 0, selected = 0;
    for (auto state : result.states) {
        visible += !(state & 2);
        selected += (state & 3) == 1;
    }
    result.message = "Finished " + std::to_string(steps.size()) + " step(s). " + std::to_string(visible) +
                     " visible, " + std::to_string(selected) + " selected.";
    return result;
}
Recipe readRecipe(const std::filesystem::path &path) {
    if (std::filesystem::file_size(path) > maxRecipeBytes)
        throw std::runtime_error("Recipe exceeds 1 MiB");
    std::ifstream file(path, std::ios::binary);
    if (!file)
        throw std::runtime_error("Cannot open recipe");
    Recipe j = Recipe::parse(file, [](int depth, Recipe::parse_event_t, const Recipe &) {
        if (depth > 32)
            throw std::runtime_error("Recipe nesting exceeds 32");
        return true;
    });
    resolveRecipe(j);
    return j;
}
void writeRecipe(const std::filesystem::path &path, const Recipe &j) {
    resolveRecipe(j);
    AtomicFile output(path);
    std::ofstream file(output.path(), std::ios::binary | std::ios::trunc);
    if (!file)
        throw std::runtime_error("Cannot save recipe");
    file << j.dump(2) << '\n';
    file.close();
    if (!file)
        throw std::runtime_error("Recipe save failed");
    output.commit();
}
} // namespace preview
