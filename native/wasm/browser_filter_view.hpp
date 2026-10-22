#pragma once
#include "camera.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>

namespace preview::browser_filter_view {
// Capture02 ProcessingUi::frustumFromView, processing_ui.cpp:488-509.
// A constant-size value operation; it never mutates navigation or filter state.
inline std::array<float,10> fromCamera(const Camera &camera,float aspect) {
    using namespace DirectX;
    if(!std::isfinite(aspect) || aspect<=0) throw std::invalid_argument("Invalid filter view aspect");
    const auto position=camera.eye();
    const auto rotation=XMQuaternionNormalize(XMQuaternionRotationMatrix(XMMatrixInverse(nullptr,camera.view())));
    XMVECTOR axis;
    float angle;
    XMQuaternionToAxisAngle(&axis,&angle,rotation);
    axis=XMVector3Normalize(axis);
    if(angle>XM_PI) angle-=XM_2PI;
    const auto degrees=XMConvertToDegrees(angle);
    const auto planes=camera.clipPlanes();
    std::array<float,10> result{position.x,position.y,position.z,
        XMVectorGetX(axis)*degrees,XMVectorGetY(axis)*degrees,XMVectorGetZ(axis)*degrees,
        std::clamp(camera.fieldOfView,10.f,120.f),std::max(.01f,aspect),planes[0],planes[1]};
    if(std::any_of(result.begin(),result.end(),[](float value){return !std::isfinite(value);}))
        throw std::invalid_argument("Invalid filter camera pose");
    return result;
}
} // namespace preview::browser_filter_view
