#include "navigation.hpp"
#include <cmath>

namespace preview {
void SmoothScroll::queue(const Camera &camera, bool fly, float ticks) {
    if (!std::isfinite(ticks) || ticks == 0)
        return;
    Camera desired = camera;
    if (active_ && fly_ == fly) {
        desired.distance = destination_.distance;
        desired.target = destination_.target;
    }
    if (fly)
        desired.move(0, 0, ticks * camera.radius * .15f);
    else
        desired.zoom(ticks);
    destination_ = desired;
    fly_ = fly;
    active_ = true;
}
bool SmoothScroll::advance(Camera &camera, float seconds) {
    if (!active_ || !std::isfinite(seconds) || seconds <= 0)
        return false;
    // Exponential easing composes across frames, so wheel input feels the same
    // at different frame rates. Log-distance keeps orbit zoom proportional.
    float remaining = std::exp(-seconds / .08f);
    if (fly_) {
        auto &position = camera.target;
        auto target = destination_.target;
        position.x = std::lerp(target.x, position.x, remaining);
        position.y = std::lerp(target.y, position.y, remaining);
        position.z = std::lerp(target.z, position.z, remaining);
        float error = std::max({std::abs(position.x - target.x), std::abs(position.y - target.y),
                                std::abs(position.z - target.z)});
        if (error < camera.radius * .00001f) {
            position = target;
            active_ = false;
        }
    } else {
        float difference = std::log(camera.distance / destination_.distance) * remaining;
        camera.distance = destination_.distance * std::exp(difference);
        if (std::abs(difference) < .00001f) {
            camera.distance = destination_.distance;
            active_ = false;
        }
    }
    return true;
}
namespace {
constexpr NavigationKey navigationKeys[] = {NavigationKey::Forward, NavigationKey::Backward, NavigationKey::Left,
    NavigationKey::Right, NavigationKey::Down, NavigationKey::Up, NavigationKey::Space,
    NavigationKey::TurnLeft, NavigationKey::TurnRight, NavigationKey::TurnUp, NavigationKey::TurnDown};
}
bool KeyNavigation::key(NavigationKey key, bool down) {
    auto found = std::find(std::begin(navigationKeys), std::end(navigationKeys), key);
    if (found == std::end(navigationKeys))
        return false;
    keys_[found - std::begin(navigationKeys)] = down;
    return true;
}
bool KeyNavigation::translationKey(NavigationKey key) {
    return std::find(std::begin(navigationKeys), std::begin(navigationKeys) + 7, key) !=
           std::begin(navigationKeys) + 7;
}
bool KeyNavigation::active() const {
    return std::any_of(keys_.begin(), keys_.end(), [](bool value) { return value; }) ||
           std::any_of(velocity_.begin(), velocity_.end(), [](float value) { return value != 0; });
}
void KeyNavigation::cancel() {
    keys_.fill(false);
    velocity_.fill(0);
    multiplier_ = 1;
}
bool KeyNavigation::advance(Camera &camera, bool fly, float seconds) {
    if (!active() || !std::isfinite(seconds) || seconds <= 0)
        return false;
    std::array<float, 5> desired{float(keys_[3]) - float(keys_[2]),
                                 float(keys_[5] || keys_[6]) - float(keys_[4]),
                                 float(keys_[0]) - float(keys_[1]), float(keys_[8]) - float(keys_[7]),
                                 float(keys_[10]) - float(keys_[9])};
    const float length =
        std::sqrt(desired[0] * desired[0] + desired[1] * desired[1] + desired[2] * desired[2]);
    for (unsigned i = 0; i < 3; ++i)
        desired[i] *= multiplier_ / std::max(1.f, length);
    const float rotationLength = std::hypot(desired[3], desired[4]);
    for (unsigned i = 3; i < 5; ++i)
        desired[i] /= std::max(1.f, rotationLength);
    // Integrate the exponential velocity exactly: distance and easing remain
    // consistent at low frame rates and on keyboards with different repeat rates.
    constexpr float response = .065f;
    const float remaining = std::exp(-seconds / response);
    std::array<float, 5> movement;
    for (unsigned i = 0; i < movement.size(); ++i) {
        movement[i] = desired[i] * seconds + (velocity_[i] - desired[i]) * response * (1 - remaining);
        velocity_[i] = desired[i] + (velocity_[i] - desired[i]) * remaining;
        if (desired[i] == 0 && std::abs(velocity_[i]) < .0001f)
            velocity_[i] = 0;
    }
    const float angle = DirectX::XM_PIDIV2 / .007f; // 90 degrees/second, matching mouse direction
    if (fly)
        camera.look(movement[3] * angle, movement[4] * angle);
    else
        camera.orbit(movement[3] * angle, movement[4] * angle);
    const float speed = std::max(.05f, camera.radius) * .75f;
    camera.move(movement[0] * speed, movement[1] * speed, movement[2] * speed);
    return std::any_of(movement.begin(), movement.end(), [](float value) { return value != 0; });
}
} // namespace preview
