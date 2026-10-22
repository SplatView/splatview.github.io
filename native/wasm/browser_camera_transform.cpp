#include "browser_camera_transform.hpp"
#include <algorithm>
#include <cmath>
#include <iterator>
#include <stdexcept>

namespace preview::browser_camera_transform {
void validate(const Camera &camera,float aspect) {
    using namespace DirectX;
    const auto reject=[] { throw std::runtime_error("Scene bounds or default view cannot produce a valid camera."); };
    const auto p=camera.eye();const auto [nearPlane,farPlane]=camera.clipPlanes();
    const float values[]{camera.target.x,camera.target.y,camera.target.z,camera.radius,camera.distance,
        camera.yaw,camera.pitch,camera.roll,camera.fieldOfView,aspect,p.x,p.y,p.z,
        p.x-camera.target.x,p.y-camera.target.y,p.z-camera.target.z,nearPlane,farPlane};
    if(std::any_of(std::begin(values),std::end(values),[](float v){return !std::isfinite(v);}) ||
       camera.radius<=0 || camera.distance<=0 || aspect<=0 || nearPlane<=0 || farPlane<=nearPlane ||
       (p==camera.target)) reject();
    const auto view=camera.view();const float determinant=XMVectorGetX(XMMatrixDeterminant(view));
    if(!std::isfinite(determinant) || std::abs(determinant)<=.5f) reject();
    XMFLOAT4X4 result;XMStoreFloat4x4(&result,view*camera.projection(aspect));
    for(const auto &row:result.m) for(float value:row) if(!std::isfinite(value)) reject();
}
Camera transformed(const Camera &camera,const Matrix4 &matrix,float aspect,Policy policy) {
    if(policy!=Policy::PreserveView && policy!=Policy::WorldUpright)
        throw std::runtime_error("Invalid alignment camera policy.");
    validate(camera);validate(camera,aspect);
    auto result=camera.transformed(matrix);
    validate(result);validate(result,aspect);
    if(policy==Policy::WorldUpright) result.roll=0;
    validate(result);validate(result,aspect);return result;
}
} // namespace preview::browser_camera_transform
