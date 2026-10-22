#pragma once
#include "scene.hpp"
#include "math.hpp"

namespace preview::browser_alignment_frame {
Matrix4 inverse(const Matrix4 &);
Matrix4 compose(const Matrix4 &,const Matrix4 &);
Matrix4 change(const Matrix4 &before,const Matrix4 &after);
Matrix4 orientationChange(const Matrix4 &before,const Matrix4 &after);
Matrix4 centered(const Matrix4 &,Vec3 point);
} // namespace preview::browser_alignment_frame
