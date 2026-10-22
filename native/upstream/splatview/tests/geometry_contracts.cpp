#include "geometry_contracts.hpp"
#include "geometry_tools.hpp"
#include "processing.hpp"
#include "camera.hpp"
#include "software_renderer.hpp"
#include "math.hpp"
#include <cmath>
#include <limits>
#include <stdexcept>

using namespace preview;
namespace {
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
Vec3 applyPoint(Vec3 p, const Matrix4 &m) {
    DirectX::XMFLOAT3 out;
    DirectX::XMStoreFloat3(
        &out, DirectX::XMVector3TransformCoord(
                  DirectX::XMVectorSet(p.x, p.y, p.z, 1),
                  DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(m.data()))));
    return {out.x, out.y, out.z};
}
template <class F> void rejects(F f) {
    bool rejected = false;
    try {
        f();
    } catch (const std::exception &) {
        rejected = true;
    }
    require(rejected, "Degenerate calibration must be rejected without editing the asset");
}
} // namespace
void geometryToolsContracts() {
    require(std::abs(pointDistance({0, 0, 0}, {3, 4, 0}) - 5) < 1e-6f, "Distance must use world coordinates");
    require(std::abs(pointAngle({1, 0, 0}, {0, 0, 0}, {0, 1, 0}) - 90) < 1e-5f,
            "Angle vertex is the second point");
    require(pointDistance(applyPoint({3, 4, -2}, centerAtPoint({3, 4, -2})), {}) < 1e-6f,
            "One-point centering must reach the origin");
    const Vec3 a{1, 2, 3}, b{3, 2, 3}, mid{2, 2, 3};
    const auto scale = scaleFromPoints(a, b, 8);
    require(pointDistance(applyPoint(mid, scale), mid) < 1e-6f &&
                std::abs(pointDistance(applyPoint(a, scale), applyPoint(b, scale)) - 8) < 1e-6f,
            "Two-point scaling must preserve the midpoint and set the requested length");
    const Vec3 p{1, 2, 3}, q{2, 2.5f, 3}, r{1, 2.25f, 4}, center{4.f / 3, 6.75f / 3, 10.f / 3};
    for (bool flip : {false, true}) {
        const auto align = alignFromPoints(p, q, r, flip);
        const auto u = applyPoint(p, align), v = applyPoint(q, align), w = applyPoint(r, align);
        require(std::abs(u.y - v.y) < 1e-5f && std::abs(v.y - w.y) < 1e-5f,
                "Three-point alignment must level the picked plane");
        require(pointDistance(applyPoint(center, align), center) < 1e-5f,
                "Three-point alignment must rotate about the picked centroid");
    }
    rejects([] { scaleFromPoints({}, {}, 1); });
    rejects([] { scaleFromPoints({}, {1, 0, 0}, -1); });
    rejects([] { alignFromPoints({}, {1, 0, 0}, {2, 0, 0}); });
    rejects([] { pointAngle({}, {}, {1, 0, 0}); });
    rejects([] { centerAtPoint({std::numeric_limits<float>::infinity(), 0, 0}); });
    auto scene = std::make_shared<Scene>();
    for (int z = 0; z < 20; ++z)
        for (int x = 0; x < 20; ++x) {
            Attributes attr;
            attr.position = {x * .1f, 2 + x * .03f - z * .02f + std::sin(float(x + z)) * .0001f, z * .1f};
            scene->gaussians.push_back(packGaussian(attr));
        }
    for (int i = 0; i < 100; ++i) {
        Attributes attr;
        attr.position = {0, 3 + (i % 10) * .2f, (i / 10) * .2f};
        scene->gaussians.push_back(packGaussian(attr));
    }
    fitBounds(*scene);
    const FloorOptions options{.002f, 1000, 50000};
    const auto plane = detectFloor(*scene, {}, false, options);
    require(plane && plane->inliers >= 400 && plane->rms < .0002f && plane->normal.y > .9f,
            "RANSAC and least-squares refinement must recover the tilted floor among outliers");
    const auto second = detectFloor(*scene, {}, false, options);
    require(second && pointDistance(plane->normal, second->normal) == 0,
            "Floor detection must be deterministic");
    for (float sceneScale : {1e-4f, 1.f, 1e4f}) {
        auto scaled = *scene;
        scaled.radius = 1e10f; // Framing outliers must not set the detector's tolerance.
        for (auto &g : scaled.gaussians)
            for (unsigned axis = 0; axis < 3; ++axis)
                g.positionOpacity[axis] *= sceneScale;
        const auto automatic = detectFloor(scaled, {}, false);
        require(
            automatic && automatic->inliers >= 400 && automatic->normal.y > .9f &&
                automatic->rms / sceneScale < .0002f,
            "Automatic floor tolerance must follow sampled geometry across scene units and framing outliers");
    }
    FloorOptions fromBelow = options;
    fromBelow.viewpoint = Vec3{1, -5, 1};
    const auto below = detectFloor(*scene, {}, false, fromBelow);
    require(below && below->normal.y < -.9f,
            "The viewing camera should orient the detected plane's normal toward the visible side");
    Scene line;
    for (unsigned i = 0; i < 20; ++i) {
        Attributes attr;
        attr.position = {float(i), 0, 0};
        line.gaussians.push_back(packGaussian(attr));
    }
    require(!detectFloor(line, {}, false), "Collinear points cannot define a stable floor");
    const auto level = alignFloor(*plane);
    double error = 0;
    for (size_t i = 0; i < 400; ++i) {
        const auto &v = scene->gaussians[i].positionOpacity;
        error += std::abs(applyPoint({v[0], v[1], v[2]}, level).y);
    }
    require(error / 400 < .0002, "Floor leveling must put the fitted surface at Y=0");
    std::vector<uint8_t> states(scene->gaussians.size());
    for (size_t i = 400; i < states.size(); ++i)
        states[i] = 1;
    const auto wall = detectFloor(*scene, states, true, options);
    require(wall && wall->tested == 100 && std::abs(wall->normal.x) > .999f,
            "Floor detection must use only selected splats when a selection exists");
    for (size_t i = 0; i < 400; ++i)
        states[i] = 2;
    const auto remaining = detectFloor(*scene, states, false, options);
    require(remaining && remaining->tested == 100, "Deleted splats must not influence plane detection");
    std::stop_source stop;
    stop.request_stop();
    require(!detectFloor(*scene, {}, false, options, stop.get_token()),
            "Floor detection must honor cancellation");
    auto processed = processScene(scene, std::vector<uint8_t>(scene->gaussians.size()), matrixRecipe(scale));
    require(processed.scene->gaussians.front().covA[0] > scene->gaussians.front().covA[0] * 15.99f,
            "Calibration must transform covariance, not only positions");
}
void geometryAlignmentContracts() {
    // Adapted from the original renderer's alignment contracts. Using an image
    // comparison catches position-only transforms and missing directional SH rotation.
    auto visual = std::make_shared<Scene>();
    visual->shDegree = 3;
    for (int i = 0; i < 12; ++i) {
        Attributes attr;
        attr.position = {float(i % 4) * .2f - .3f, float(i / 4) * .2f - .2f, -.1f * (i % 3)};
        attr.scale = {.06f, .025f, .04f};
        attr.quaternion = {.8f, .3f, .1f, .4f};
        attr.sh[0] = .7f;
        attr.sh[1] = -.3f;
        for (unsigned k = 3; k < attr.sh.size(); ++k)
            attr.sh[k] = .18f * std::sin(float(k + 3 * i));
        attr.opacity = .7f;
        visual->gaussians.push_back(packGaussian(attr));
    }
    fitBounds(*visual);
    Camera camera;
    camera.fit(*visual);
    SoftwareRenderer renderer;
    renderer.resize(256, 256);
    const Matrix4 alignments[]{centerAtPoint({.3f, -.4f, .2f}),
                               scaleFromPoints({-.2f, 0, 0}, {.2f, 0, 0}, 1.6f),
                               scaleFromPoints({-.2f, 0, 0}, {.2f, 0, 0}, .1f),
                               alignFromPoints({.1f, -.3f, 0}, {1, .4f, 0}, {0, .2f, 1}),
                               alignFromPoints({.1f, -.3f, 0}, {1, .4f, 0}, {0, .2f, 1}, true)};
    ViewSettings unhighlighted;
    unhighlighted.highlightSelection = false;
    for (bool yUp : {false, true})
        for (unsigned degree = 0; degree <= 3; ++degree) {
            auto source = std::make_shared<Scene>(*visual);
            source->shDegree = degree;
            Camera before = camera;
            before.yUp = yUp;
            before.roll = .27f;
            renderer.setScene(source);
            renderer.draw(before, unhighlighted);
            const auto original = renderer.readback();
            for (const auto &matrix : alignments) {
                const auto after = before.transformed(matrix);
                Matrix4 oldProjection, newProjection;
                DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(oldProjection.data()),
                                         before.view() * before.projection(1));
                DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(newProjection.data()),
                                         after.view() * after.projection(1));
                for (const auto &gaussian : source->gaussians) {
                    const auto &position = gaussian.positionOpacity;
                    const Vec3 point{position[0], position[1], position[2]};
                    const auto oldScreen = applyPoint(point, oldProjection);
                    const auto newScreen = applyPoint(applyPoint(point, matrix), newProjection);
                    require(std::hypot(oldScreen.x - newScreen.x, oldScreen.y - newScreen.y) < 2e-5f,
                            "Alignment preserves every screen position for both up conventions and roll");
                }
                const auto aligned =
                    processScene(source, std::vector<uint8_t>(source->gaussians.size()), matrixRecipe(matrix),
                                 false, {}, AlignmentView{matrix, after.savedView()});
                renderer.setScene(aligned.scene);
                renderer.draw(after, unhighlighted);
                const auto adjusted = renderer.readback();
                double difference = 0;
                for (size_t i = 0; i < original.bgra.size(); ++i)
                    difference += std::abs(int(original.bgra[i]) - int(adjusted.bgra[i]));
                require(difference / original.bgra.size() < .06,
                        "Alignment preserves rendered framing, covariance and SH0..SH3 colors");
                Camera reset;
                reset.fit(*aligned.scene);
                require(pointDistance(reset.eye(), after.eye()) < 2e-5f &&
                            std::abs(reset.roll - after.roll) < 1e-6f,
                        "Aligned default views retain camera position and roll");
            }
        }
    Camera vertical;
    vertical.yaw = vertical.pitch = 0;
    Matrix4 tilt;
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(tilt.data()),
                             DirectX::XMMatrixRotationX(DirectX::XM_PIDIV2));
    const auto after = vertical.transformed(tilt);
    Matrix4 oldProjection, newProjection;
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(oldProjection.data()),
                             vertical.view() * vertical.projection(1));
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(newProjection.data()),
                             after.view() * after.projection(1));
    const auto beforeScreen = applyPoint({.2f, .1f, 0}, oldProjection);
    const auto afterScreen = applyPoint(applyPoint({.2f, .1f, 0}, tilt), newProjection);
    require(std::hypot(beforeScreen.x - afterScreen.x, beforeScreen.y - afterScreen.y) < 1e-5f,
            "Alignment through a vertical view keeps a finite, stable camera basis");
}
