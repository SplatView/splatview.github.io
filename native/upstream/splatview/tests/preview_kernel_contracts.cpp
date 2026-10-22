#include "preview_kernel_contracts.hpp"
#include "processing_kernels.hpp"
#include "processing.hpp"
#include "geometry_tools.hpp"
#include "render_frame.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>

using namespace preview;
namespace {
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
template<class F> void rejects(F action, const char *message) {
    try { action(); } catch (const std::exception &) { return; }
    throw std::runtime_error(message);
}
std::shared_ptr<Scene> fixture(unsigned degree) {
    auto scene = std::make_shared<Scene>();
    scene->shDegree = degree;
    for (int i = 0; i < 12; ++i) {
        Attributes attr;
        attr.position = {float(i % 4) * .2f - .3f, float(i / 4) * .2f - .2f, -.1f * (i % 3)};
        attr.scale = {.06f, .025f, .04f};
        attr.quaternion = {.8f, .3f, .1f, .4f};
        attr.sh[0] = .7f; attr.sh[1] = -.3f;
        for (unsigned k = 3; k < attr.sh.size(); ++k)
            attr.sh[k] = .18f * std::sin(float(k + 3 * i));
        attr.opacity = .7f;
        scene->gaussians.push_back(packGaussian(attr));
    }
    fitBounds(*scene);
    Camera camera; camera.fit(*scene); camera.roll = .28f;
    scene->defaultView = camera.savedView();
    scene->previewEye = camera.eye();
    return scene;
}
Recipe previewRecipe(const ViewSettings &settings) {
    Recipe steps = Recipe::array();
    if (settings.color != neutralColor) {
        Recipe values = Recipe::object();
        for (size_t i = 0; i < settings.color.size(); ++i)
            values[colorFields[i].name] = settings.color[i];
        steps.push_back({{"type", "color"}, {"values", values},
                         {"selected_only", settings.colorSelectedOnly}});
    }
    if (settings.geometry != identityMatrix) {
        auto step = matrixRecipe(settings.geometry);
        step["selected_only"] = settings.geometrySelectedOnly;
        steps.push_back(step);
    }
    return steps;
}
void sameGaussians(const Scene &actual, const Scene &expected, const char *message) {
    require(actual.gaussians.size() == expected.gaussians.size() &&
                !std::memcmp(actual.gaussians.data(), expected.gaussians.data(),
                             actual.gaussians.size() * sizeof(Gaussian)), message);
}
} // namespace
void previewKernelContracts() {
    ColorValues grade = neutralColor;
    grade[0] = 1.12f; grade[2] = .7f; grade[3] = .6f; grade[4] = 1.2f;
    grade[5] = .13f; grade[6] = -.17f; grade[7] = .2f; grade[8] = -.15f;
    grade[9] = .09f; grade[10] = 35; grade[11] = .2f;
    grade[12] = -45; grade[13] = .3f; grade[14] = 23;
    const Matrix4 transforms[]{identityMatrix,
        transformMatrix({{"translation", {.1f, -.2f, .05f}}, {"euler", {14, -20, 31}}, {"scale", 1.2f}}),
        transformMatrix({{"scale", {1.2f, .7f, 1.1f}}, {"center", {.1f, -.1f, 0}}})};
    size_t visiblePackets = 0;
    for (unsigned degree = 0; degree <= 3; ++degree) {
        auto source = fixture(degree);
        const auto original = *source;
        std::vector<uint8_t> states(source->gaussians.size());
        for (size_t i = 0; i < states.size(); ++i)
            states[i] = i % 3 == 0 ? 1 : 0;
        states.back() = 2;
        const auto originalStates = states;
        for (bool colorSelected : {false, true})
            for (bool geometrySelected : {false, true})
                for (const auto &color : {neutralColor, grade})
                    for (const auto &geometry : transforms) {
                        ViewSettings settings;
                        settings.color = color; settings.geometry = geometry;
                        settings.colorSelectedOnly = colorSelected;
                        settings.geometrySelectedOnly = geometrySelected;
                        auto preview = previewScene(source, states, color, colorSelected,
                                                     geometry, geometrySelected);
                        if (color == neutralColor && geometry == identityMatrix) {
                            require(preview == source, "Neutral preview retains immutable scene storage");
                            continue;
                        }
                        const auto committed = processScene(source, states, previewRecipe(settings));
                        sameGaussians(*preview, *committed.scene,
                                      "Pure preview and committed processing must be bitwise identical");
                        require(preview->defaultView == committed.scene->defaultView &&
                                    preview->previewEye == committed.scene->previewEye &&
                                    preview->alignmentFrame == committed.scene->alignmentFrame &&
                                    preview->center == committed.scene->center &&
                                    preview->radius == committed.scene->radius,
                                "Preview geometry retains the established scene-metadata behavior");
                        for (bool yUp : {false, true})
                            for (float pitch : {-DirectX::XM_PIDIV2, 0.f, DirectX::XM_PIDIV2}) {
                                Camera camera; camera.fit(*source); camera.yUp = yUp;
                                camera.pitch = pitch; camera.roll = .27f;
                                const auto live = prepareFrame(source, states, camera, 128, 96, settings);
                                ViewSettings settled;
                                const auto baked = prepareFrame(committed.scene, committed.states, camera,
                                                                 128, 96, settled);
                                require(live.splats.size() == baked.splats.size(),
                                        "Preview and committed raster packets have matching coverage");
                                visiblePackets += live.splats.size();
                                for (size_t i = 0; i < live.splats.size(); ++i) {
                                    const auto &a = live.splats[i], &b = baked.splats[i];
                                    require(a.centerDepth == b.centerDepth && a.axes == b.axes &&
                                                a.color == b.color && a.identity == b.identity,
                                            "Color/geometry preview packets match commits at both camera poles");
                                }
                            }
                    }
        sameGaussians(*source, original, "Preview kernels preserve all immutable source Gaussian data");
        require(states == originalStates && source->defaultView == original.defaultView &&
                    source->previewEye == original.previewEye && source->alignmentFrame == original.alignmentFrame,
                "Preview kernels preserve input masks and metadata");
    }
    require(visiblePackets > 1000, "Projection equivalence must exercise visible splats, not empty frames");
    auto source = fixture(3);
    const auto original = *source;
    ViewSettings masklessSettings;
    masklessSettings.color = grade; masklessSettings.geometry = transforms[1];
    const auto maskless = previewScene(source, {}, grade, false, transforms[1], false);
    const auto zeroMask = processScene(source, std::vector<uint8_t>(source->gaussians.size()),
                                       previewRecipe(masklessSettings));
    sameGaussians(*maskless, *zeroMask.scene,
                  "An omitted render mask behaves exactly like an all-unselected processing mask");
    std::vector<uint8_t> states(source->gaussians.size(), 1);
    std::stop_source cancelled; cancelled.request_stop();
    rejects([&] { previewScene(source, states, grade, false, transforms[1], false, cancelled.get_token()); },
            "Cancelled preview must fail without publishing edited data");
    rejects([&] { previewScene(source, states, neutralColor, false, identityMatrix, false, cancelled.get_token()); },
            "Neutral preview also honors cancellation");
    auto invalidColor = grade; invalidColor[2] = std::numeric_limits<float>::quiet_NaN();
    rejects([&] { previewScene(source, states, invalidColor, false, identityMatrix, false); },
            "Preview rejects non-finite color values");
    invalidColor = grade; invalidColor[0] = 6;
    rejects([&] { previewScene(source, states, invalidColor, false, identityMatrix, false); },
            "Preview enforces the same color ranges as recipe processing");
    auto invalidMatrix = identityMatrix; invalidMatrix[3] = .1f;
    rejects([&] { previewScene(source, states, grade, false, invalidMatrix, false); },
            "Preview rejects projective transforms after discarding its private color result");
    invalidMatrix = identityMatrix; invalidMatrix[5] = std::numeric_limits<float>::infinity();
    rejects([&] { previewScene(source, states, neutralColor, false, invalidMatrix, false); },
            "Preview rejects non-finite transform values");
    states.assign(states.size(), 2);
    rejects([&] { previewScene(source, states, grade, true, identityMatrix, false); },
            "Deleted splats cannot satisfy a selected-only color preview");
    rejects([&] { previewScene(source, {}, neutralColor, false, transforms[1], true); },
            "Empty masks cannot satisfy a selected-only geometry preview");
    states[0] = 3;
    rejects([&] { previewScene(source, states, grade, false, identityMatrix, false); },
            "Preview rejects invalid combined edit-state flags");
    sameGaussians(*source, original, "Cancelled and failed preview kernels preserve the source");
}
