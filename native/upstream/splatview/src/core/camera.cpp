#include "camera.hpp"
#include <algorithm>
#include <cmath>
#include <iterator>
#include <stdexcept>

namespace preview {
using namespace DirectX;
void Camera::fit(const Scene &scene, float aspect, bool useDefaultView) {
    target = scene.center;
    radius = scene.radius;
    float halfVertical = XMConvertToRadians(std::clamp(fieldOfView, 10.0f, 120.0f)) * 0.5f;
    float halfHorizontal = std::atan(std::tan(halfVertical) * std::max(0.01f, aspect));
    distance = radius * 1.2f / std::sin(std::min(halfVertical, halfHorizontal));
    yaw = 0.35f;
    pitch = 0.18f;
    roll = 0;
    yUp = scene.yUp;
    if (scene.previewEye) {
        auto p = *scene.previewEye;
        const float sign = yUp ? 1.0f : -1.0f;
        float dx = p.x - target.x, dy = (p.y - target.y) * sign, dz = (p.z - target.z) * sign;
        float eyeDistance = std::hypot(dx, dy, dz);
        if (eyeDistance > 0) {
            yaw = std::atan2(dx, dz);
            pitch = std::clamp(std::asin(std::clamp(dy / eyeDistance, -1.0f, 1.0f)), -1.52f, 1.52f);
            // Keep the local view usable in narrow Explorer panes and when
            // refitting with a different lens. Square, 45-degree views use the eye.
            distance =
                eyeDistance * std::sin(XM_PIDIV4 * .5f) / std::sin(std::min(halfVertical, halfHorizontal));
        }
    }
    if (useDefaultView && scene.defaultView)
        restoreView(*scene.defaultView);
}
SavedView Camera::savedView() const {
    return {target, yaw, pitch, distance, fieldOfView, yUp, roll};
}
void Camera::restoreView(const SavedView &view) {
    target = view.target;
    yaw = view.yaw;
    pitch = view.pitch;
    distance = view.distance;
    fieldOfView = view.fieldOfView;
    yUp = view.yUp;
    roll = view.roll;
}
Camera Camera::transformed(const Matrix4 &matrix) const {
    if (std::any_of(matrix.begin(), matrix.end(), [](float value) { return !std::isfinite(value); }))
        throw std::runtime_error("Alignment needs finite transform coordinates.");
    const auto transform = XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(matrix.data()));
    const float scale = XMVectorGetX(XMVector3Length(transform.r[0]));
    if (!std::isfinite(scale) || scale <= 0 || XMVectorGetX(XMMatrixDeterminant(transform)) <= 0 ||
        std::abs(matrix[3]) > 1e-6f || std::abs(matrix[7]) > 1e-6f || std::abs(matrix[11]) > 1e-6f ||
        std::abs(matrix[15] - 1) > 1e-6f)
        throw std::runtime_error("Alignment needs a rotation, translation, or uniform positive scale.");
    for (unsigned r = 0; r < 3; ++r) {
        if (std::abs(XMVectorGetX(XMVector3Length(transform.r[r])) - scale) > scale * 1e-4f)
            throw std::runtime_error("Alignment needs a uniform scale.");
        for (unsigned c = r + 1; c < 3; ++c)
            if (std::abs(XMVectorGetX(XMVector3Dot(transform.r[r], transform.r[c]))) > scale * scale * 1e-4f)
                throw std::runtime_error("Alignment cannot shear the scene.");
    }
    const auto p = eye();
    const auto position = XMVector3TransformCoord(XMVectorSet(p.x, p.y, p.z, 1), transform);
    const auto focus = XMVector3TransformCoord(XMVectorSet(target.x, target.y, target.z, 1), transform);
    const auto offset = XMVectorSubtract(position, focus);
    const float sign = yUp ? 1.f : -1.f;
    Camera result = *this;
    XMFLOAT3 transformedTarget;
    XMStoreFloat3(&transformedTarget, focus);
    result.target = {transformedTarget.x, transformedTarget.y, transformedTarget.z};
    result.distance = XMVectorGetX(XMVector3Length(offset));
    result.radius *= scale;
    result.yaw = std::atan2(XMVectorGetX(offset), sign * XMVectorGetZ(offset));
    result.pitch =
        std::atan2(sign * XMVectorGetY(offset), std::hypot(XMVectorGetX(offset), XMVectorGetZ(offset)));
    const auto up =
        XMVector3Normalize(XMVector3TransformNormal(XMMatrixInverse(nullptr, view()).r[1], transform));
    const auto right = XMVectorSet(std::cos(result.yaw), 0, -sign * std::sin(result.yaw), 0);
    const auto upright =
        XMVectorSet(-std::sin(result.yaw) * std::sin(result.pitch), sign * std::cos(result.pitch),
                    -sign * std::cos(result.yaw) * std::sin(result.pitch), 0);
    result.roll = std::atan2(XMVectorGetX(XMVector3Dot(up, right)), XMVectorGetX(XMVector3Dot(up, upright)));
    const float values[]{result.target.x, result.target.y, result.target.z, result.distance,
                         result.radius,   result.yaw,      result.pitch,    result.roll};
    if (std::any_of(std::begin(values), std::end(values),
                    [](float value) { return !std::isfinite(value) || std::abs(value) > 1e12f; }) ||
        result.distance <= 0 || result.radius <= 0)
        throw std::runtime_error("The aligned camera exceeds the supported range.");
    return result;
}
Vec3 Camera::eye() const {
    float sign = yUp ? 1.0f : -1.0f;
    return {target.x + distance * std::sin(yaw) * std::cos(pitch),
            target.y + sign * distance * std::sin(pitch),
            target.z + sign * distance * std::cos(yaw) * std::cos(pitch)};
}
XMMATRIX Camera::view() const {
    auto p = eye();
    const float sign = yUp ? 1.f : -1.f;
    const auto right = XMVectorSet(std::cos(yaw), 0, -sign * std::sin(yaw), 0);
    const auto upright = XMVectorSet(-std::sin(yaw) * std::sin(pitch), sign * std::cos(pitch),
                                     -sign * std::cos(yaw) * std::sin(pitch), 0);
    const auto up = XMVectorAdd(XMVectorScale(upright, std::cos(roll)), XMVectorScale(right, std::sin(roll)));
    return XMMatrixLookAtRH(XMVectorSet(p.x, p.y, p.z, 1), XMVectorSet(target.x, target.y, target.z, 1), up);
}
std::array<float, 2> Camera::clipPlanes() const {
    return {std::max(0.0001f, radius * 0.0001f), std::max(distance + radius * 10, radius * 1000)};
}
XMMATRIX Camera::projection(float aspect) const {
    const auto [nearPlane, farPlane] = clipPlanes();
    return XMMatrixPerspectiveFovRH(XMConvertToRadians(std::clamp(fieldOfView, 10.0f, 120.0f)),
                                    std::max(0.01f, aspect), nearPlane, farPlane);
}
void Camera::look(float x, float y) {
    auto before = eye();
    orbit(x, y);
    auto after = eye();
    target.x += before.x - after.x;
    target.y += before.y - after.y;
    target.z += before.z - after.z;
}
void Camera::move(float right, float up, float forward) {
    auto inverse = XMMatrixInverse(nullptr, view());
    auto shift = XMVector3TransformNormal(XMVectorSet(right, up, -forward, 0), inverse);
    XMFLOAT3 p;
    XMStoreFloat3(&p, shift);
    target.x += p.x;
    target.y += p.y;
    target.z += p.z;
}
void Camera::focus(Vec3 point) {
    auto position = eye();
    float sign = yUp ? 1.0f : -1.0f;
    float dx = position.x - point.x, dy = (position.y - point.y) * sign, dz = (position.z - point.z) * sign;
    distance = std::max(radius * 0.001f, std::sqrt(dx * dx + dy * dy + dz * dz));
    yaw = std::atan2(dx, dz);
    pitch = std::asin(std::clamp(dy / distance, -1.0f, 1.0f));
    target = point;
}
void Camera::orbit(float x, float y) {
    yaw -= x * 0.007f;
    pitch = std::clamp(pitch + y * 0.007f, -XM_PIDIV2, XM_PIDIV2);
}
void Camera::zoom(float ticks) {
    distance = std::clamp(distance * std::exp(-ticks * 0.13f), radius * 0.015f, radius * 300);
}
void Camera::pan(float x, float y) {
    XMMATRIX inverse = XMMatrixInverse(nullptr, view());
    auto shift =
        XMVector3TransformNormal(XMVectorSet(-x * distance * 0.0013f, y * distance * 0.0013f, 0, 0), inverse);
    XMFLOAT3 p;
    XMStoreFloat3(&p, shift);
    target.x += p.x;
    target.y += p.y;
    target.z += p.z;
}
} // namespace preview
