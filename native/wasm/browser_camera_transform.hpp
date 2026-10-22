#pragma once
#include "camera.hpp"

namespace preview::browser_camera_transform {
enum class Policy : int { PreserveView=0, WorldUpright=1 };
// The portable camera kernel has the pinned transform arithmetic. These
// checks retain the captured desktop pre/post camera validity contract.
void validate(const Camera &,float aspect=1);
Camera transformed(const Camera &,const Matrix4 &,float aspect,Policy=Policy::PreserveView);
} // namespace preview::browser_camera_transform
