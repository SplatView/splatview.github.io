#pragma once
#include "scene.hpp"
#include "math.hpp"

namespace preview {
class Camera {
  public:
    Vec3 target{};
    float yaw{0.35f}, pitch{0.18f}, distance{3}, radius{1};
    float fieldOfView{45};
    bool yUp{};
    float roll{};
    void fit(const Scene &, float aspect = 1, bool useDefaultView = true);
    SavedView savedView() const;
    void restoreView(const SavedView &);
    Camera transformed(const Matrix4 &) const;
    Vec3 eye() const;
    DirectX::XMMATRIX view() const;
    std::array<float, 2> clipPlanes() const;
    DirectX::XMMATRIX projection(float aspect) const;
    void orbit(float x, float y);
    void pan(float x, float y);
    void zoom(float ticks);
    void look(float x, float y);
    void move(float right, float up, float forward);
    void focus(Vec3);
};
struct PointI { int32_t x{}, y{}; };
struct RectI { int32_t left{}, top{}, right{}, bottom{}; };
enum class NavigationKey { Forward, Backward, Left, Right, Down, Up, Space, TurnLeft, TurnRight, TurnUp, TurnDown };
} // namespace preview
