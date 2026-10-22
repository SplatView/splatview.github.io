#include "camera_contracts.hpp"
#include "camera.hpp"
#include "file_preferences.hpp"
#include "software_renderer.hpp"
#include <nlohmann/json.hpp>
#include <cmath>
#include <limits>
#include <stdexcept>

using namespace preview;
using namespace DirectX;
namespace {
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
bool close(float a, float b, float tolerance = 2e-5f) {
    return std::isfinite(a) && std::isfinite(b) && std::abs(a - b) <= tolerance;
}
bool close(Vec3 a, Vec3 b, float tolerance = 2e-5f) {
    return close(a.x, b.x, tolerance) && close(a.y, b.y, tolerance) && close(a.z, b.z, tolerance);
}
Vec3 point(FXMVECTOR p) {
    XMFLOAT3 stored;
    XMStoreFloat3(&stored, p);
    return {stored.x, stored.y, stored.z};
}
Vec3 apply(Vec3 p, FXMMATRIX matrix) {
    return point(XMVector3TransformCoord(XMVectorSet(p.x, p.y, p.z, 1), matrix));
}
Matrix4 stored(FXMMATRIX matrix) {
    Matrix4 result;
    XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()), matrix);
    return result;
}
template <class F> void rejects(F action, const char *message) {
    bool rejected = false;
    try {
        action();
    } catch (const std::exception &) {
        rejected = true;
    }
    require(rejected, message);
}
void requireBasis(const Camera &actual, const Camera &before, FXMMATRIX transform) {
    const auto expectedBasis = XMMatrixInverse(nullptr, before.view());
    const auto actualBasis = XMMatrixInverse(nullptr, actual.view());
    for (unsigned axis = 0; axis < 3; ++axis) {
        const auto expected = XMVector3Normalize(XMVector3TransformNormal(expectedBasis.r[axis], transform));
        require(close(point(actualBasis.r[axis]), point(expected)),
                "Camera alignment must preserve all transformed camera basis axes, including roll");
    }
}
} // namespace

void cameraContracts() {
    Camera camera;
    camera.target = {1.25f, -2.5f, 3.75f};
    camera.yaw = .8f;
    camera.pitch = -.45f;
    camera.distance = 7;
    camera.radius = 2;
    camera.fieldOfView = 70;
    camera.yUp = true;
    camera.roll = .6f;
    const auto saved = camera.savedView();
    Camera restored;
    restored.restoreView(saved);
    require(restored.savedView() == saved, "Camera save and restore must preserve roll and all saved fields");

    Scene scene;
    require(scene.alignmentFrame == identityMatrix, "Fresh scenes must start with identity alignment coordinates");
    scene.defaultView = saved;
    restored.fit(scene);
    require(restored.savedView() == saved, "Fit must restore a default view's roll");
    restored.fit(scene, 1, false);
    require(restored.roll == 0, "Fit without the default view must reset roll");

    Camera upright;
    upright.yaw = upright.pitch = 0;
    upright.yUp = true;
    const auto unchangedEye = upright.eye();
    upright.roll = XM_PIDIV2;
    require(close(upright.eye(), unchangedEye), "Roll must rotate the image without moving the camera eye");
    require(close(point(XMMatrixInverse(nullptr, upright.view()).r[1]), {1, 0, 0}),
            "A positive quarter-turn roll must rotate screen up to camera right");

    const auto transform = XMMatrixMultiply(
        XMMatrixMultiply(XMMatrixScaling(2.25f, 2.25f, 2.25f), XMMatrixRotationRollPitchYaw(.4f, -.8f, .2f)),
        XMMatrixTranslation(7, -3, 2));
    for (bool yUp : {false, true}) {
        for (float roll : {0.f, .75f, -1.2f}) {
            camera.yUp = yUp;
            camera.roll = roll;
            const auto before = camera.savedView();
            const auto aligned = camera.transformed(stored(transform));
            require(close(aligned.eye(), apply(camera.eye(), transform)) &&
                        close(aligned.target, apply(camera.target, transform)),
                    "Alignment must transform the camera eye and target with the scene");
            require(close(aligned.radius, camera.radius * 2.25f) && close(aligned.distance, camera.distance * 2.25f),
                    "Uniform alignment scale must update camera radius and distance");
            require(aligned.fieldOfView == camera.fieldOfView && aligned.yUp == camera.yUp,
                    "Alignment must retain the camera lens and coordinate convention");
            requireBasis(aligned, camera, transform);
            const auto returned = aligned.transformed(stored(XMMatrixInverse(nullptr, transform)));
            require(close(returned.eye(), camera.eye()) && close(returned.target, camera.target),
                    "Applying inverse alignment must recover the camera eye and target");
            requireBasis(returned, camera, XMMatrixIdentity());
            require(camera.savedView() == before, "Camera transformation must not mutate its input");
        }
    }
    // Pole views are valid metadata and are required when floor alignment places
    // a previously horizontal viewing direction directly above the scene.
    for (bool yUp : {false, true}) {
        for (float pitch : {-XM_PIDIV2, XM_PIDIV2}) {
            Camera pole;
            pole.target = {};
            pole.yUp = yUp;
            pole.pitch = pitch;
            pole.roll = .7f;
            const auto view = stored(pole.view());
            for (float value : view)
                require(std::isfinite(value), "Camera basis must remain finite at either pitch pole");
            require(decodeSavedView(encodeSavedView(pole.savedView())) == pole.savedView(),
                    "Saved camera metadata must accept either pitch pole and retain roll");
        }
    }
    Camera orbit;
    orbit.orbit(0, 1e6f);
    require(orbit.pitch == XM_PIDIV2, "Orbit must permit the complete positive pitch pole");
    orbit.orbit(0, -1e6f);
    require(orbit.pitch == -XM_PIDIV2, "Orbit must permit the complete negative pitch pole");
    Camera focus;
    focus.yUp = true;
    focus.target = {};
    focus.pitch = focus.yaw = 0;
    const auto focusEye = focus.eye();
    focus.focus({focusEye.x, focusEye.y - 2, focusEye.z});
    require(close(focus.pitch, XM_PIDIV2), "Focusing directly below the eye must retain the pole view");

    for (const auto &invalid : {stored(XMMatrixScaling(0, 0, 0)), stored(XMMatrixScaling(1, 2, 1)),
                                stored(XMMatrixScaling(-1, 1, 1))})
        rejects([&] { camera.transformed(invalid); }, "Camera alignment must reject singular, nonuniform and reflected transforms");
    auto invalid = identityMatrix;
    invalid[1] = .25f;
    rejects([&] { camera.transformed(invalid); }, "Camera alignment must reject shear");
    invalid = identityMatrix;
    invalid[3] = .1f;
    rejects([&] { camera.transformed(invalid); }, "Camera alignment must reject perspective transforms");
    for (float value : {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity()}) {
        invalid = identityMatrix;
        invalid[12] = value;
        rejects([&] { camera.transformed(invalid); }, "Camera alignment must reject nonfinite transforms");
    }
    invalid = identityMatrix;
    invalid[12] = 1e20f;
    rejects([&] { camera.transformed(invalid); }, "Camera alignment must reject a camera outside the supported coordinate range");

    using Json = nlohmann::json;
    auto encoded = Json::parse(encodeSavedView(saved));
    require(encoded.at("version") == 1 && encoded.at("roll").get<float>() == saved.roll,
            "Roll must extend the existing metadata version without changing its field names");
    require(decodeSavedView(encoded.dump()) == saved, "Current camera metadata must round-trip all saved fields");
    encoded.erase("roll");
    auto legacy = saved;
    legacy.roll = 0;
    require(decodeSavedView(encoded.dump()) == legacy, "Existing port metadata without roll must restore upright");
    const Json windows{{"target", {saved.target.x, saved.target.y, saved.target.z}}, {"yaw", saved.yaw},
                       {"pitch", saved.pitch}, {"distance", saved.distance}, {"field_of_view", saved.fieldOfView},
                       {"y_up", saved.yUp}, {"roll", saved.roll}};
    require(decodeSavedView(windows.dump()) == saved, "Windows camera JSON must be readable for camera exchange");
    auto oldWindows = windows;
    oldWindows.erase("roll");
    require(decodeSavedView(oldWindows.dump()) == legacy, "Windows camera JSON predating roll must restore upright");
    for (const auto &badRoll : {Json(nullptr), Json("0"), Json(1e13f)}) {
        auto bad = encoded;
        bad["roll"] = badRoll;
        rejects([&] { decodeSavedView(bad.dump()); }, "Metadata must reject malformed or out-of-range roll");
    }
    for (const auto &[field, value] : {std::pair{"distance", Json(0)}, std::pair{"pitch", Json(1.58f)},
                                      std::pair{"fieldOfView", Json(121)}, std::pair{"yUp", Json(1)},
                                      std::pair{"version", Json(2)}, std::pair{"target", Json::object({{"0", 0}, {"1", 0}, {"2", 0}})}}) {
        auto bad = encoded;
        bad[field] = value;
        rejects([&] { decodeSavedView(bad.dump()); }, "Metadata must reject invalid camera fields and unsupported versions");
    }
    auto noVersion = encoded;
    noVersion.erase("version");
    rejects([&] { decodeSavedView(noVersion.dump()); }, "Port camera records must retain their required version member");
    rejects([&] { decodeSavedView(std::string(65537, ' ')); }, "Oversized camera metadata must be rejected before parsing");
    for (float value : {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity(), 1e13f}) {
        auto bad = saved;
        bad.roll = value;
        rejects([&] { encodeSavedView(bad); }, "Metadata encoding must reject nonfinite or out-of-range roll");
    }

    auto renderScene = std::make_shared<Scene>();
    Attributes attr;
    attr.position = {.5f, 0, 0};
    attr.scale = {.1f, .1f, .1f};
    renderScene->gaussians.push_back(packGaussian(attr));
    SoftwareRenderer renderer;
    renderer.resize(65, 65);
    renderer.setScene(renderScene);
    Camera renderCamera;
    renderCamera.yUp = true;
    renderCamera.yaw = renderCamera.pitch = 0;
    renderer.draw(renderCamera);
    require(renderer.frame().splats.size() == 1 && renderer.frame().splats.front().centerDepth[0] > 40 &&
                close(renderer.frame().splats.front().centerDepth[1], 32.5f),
            "The render camera must initially project the asymmetric fixture to screen right");
    const auto beforeRoll = renderer.stats();
    renderCamera.roll = XM_PIDIV2;
    renderer.draw(renderCamera);
    require(renderer.stats().rasterizations == beforeRoll.rasterizations + 1 &&
                close(renderer.frame().splats.front().centerDepth[0], 32.5f) &&
                renderer.frame().splats.front().centerDepth[1] < 25,
            "Changing only roll must invalidate cached rendering and rotate projected geometry");
    const auto rolledPixels = renderer.readback().bgra;
    for (float value : {std::numeric_limits<float>::quiet_NaN(), std::numeric_limits<float>::infinity()}) {
        renderCamera.roll = value;
        rejects([&] { renderer.draw(renderCamera); }, "Rendering must reject nonfinite roll before projection");
        require(renderer.readback().bgra == rolledPixels, "Invalid roll must preserve the previous completed image");
    }
}
