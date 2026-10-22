#pragma once
#include "camera.hpp"
#include "mask_storage.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <cmath>
#include <stdexcept>

namespace preview {
// The disposable mask overlay grants only this private unique-mask mutation.
struct BrowserViewScopeMaskAccess {
    static std::span<uint8_t> writable(MaskStorage &mask) noexcept { return mask.writableSpan(); }
};
}
namespace preview::browser_view_scope {
// Desktop SelectionFrustum uses the float row-vector view*projection result
// directly. Do not normalize planes or reassociate the clip-coordinate sums:
// inclusive boundary rounding is part of the desktop center-only predicate.
struct Scope {
    std::array<float,16> matrix{};
    bool enabled{};
    bool contains(const Gaussian &g) const noexcept {
        if(!enabled) return true;
        const auto &p=g.positionOpacity;const auto &m=matrix;
        const float x=p[0]*m[0]+p[1]*m[4]+p[2]*m[8]+m[12];
        const float y=p[0]*m[1]+p[1]*m[5]+p[2]*m[9]+m[13];
        const float z=p[0]*m[2]+p[1]*m[6]+p[2]*m[10]+m[14];
        const float w=p[0]*m[3]+p[1]*m[7]+p[2]*m[11]+m[15];
        return std::isfinite(x)&&std::isfinite(y)&&std::isfinite(z)&&std::isfinite(w)&&
            w>0&&x>=-w&&x<=w&&y>=-w&&y<=w&&z>=0&&z<=w;
    }
};
inline Scope parse(const nlohmann::json &request) {
    if(!request.contains("selectionView")||request.at("selectionView").is_null())return {};
    const auto &input=request.at("selectionView");
    if(!input.is_array()||input.size()!=11)throw std::runtime_error("Invalid current view scope");
    std::array<float,11> v{};
    for(size_t i=0;i<v.size();++i) {
        if(!input[i].is_number())throw std::runtime_error("Invalid current view scope");
        const auto value=input[i].get<double>();v[i]=float(value);
        if(!std::isfinite(value)||!std::isfinite(v[i]))throw std::runtime_error("Invalid current view scope");
        if((i==8&&value!=0&&value!=1)||(i==7&&(value<10||value>120)))throw std::runtime_error("Invalid current view scope");
    }
    if(v[5]<=0||v[6]<=0||v[10]<=0||v[7]<10||v[7]>120||(v[8]!=0&&v[8]!=1))
        throw std::runtime_error("Invalid current view scope");
    Camera camera;camera.target={v[0],v[1],v[2]};camera.yaw=v[3];camera.pitch=v[4];
    camera.distance=v[5];camera.radius=v[6];camera.fieldOfView=v[7];camera.yUp=v[8]!=0;camera.roll=v[9];
    const auto eye=camera.eye();const auto [nearPlane,farPlane]=camera.clipPlanes();
    if(!std::isfinite(eye.x)||!std::isfinite(eye.y)||!std::isfinite(eye.z)||eye==camera.target||
       !std::isfinite(nearPlane)||!std::isfinite(farPlane)||nearPlane<=0||farPlane<=nearPlane)
        throw std::runtime_error("Invalid current view scope");
    const auto view=camera.view();const float determinant=DirectX::XMVectorGetX(DirectX::XMMatrixDeterminant(view));
    if(!std::isfinite(determinant)||std::abs(determinant)<=.5f)throw std::runtime_error("Invalid current view scope");
    DirectX::XMFLOAT4X4 matrix;DirectX::XMStoreFloat4x4(&matrix,view*camera.projection(v[10]));
    Scope scope;scope.enabled=true;
    for(size_t row=0;row<4;++row)for(size_t col=0;col<4;++col) {
        const float value=matrix.m[row][col];if(!std::isfinite(value))throw std::runtime_error("Invalid current view scope");
        scope.matrix[row*4+col]=value;
    }
    return scope;
}
inline MaskStorage effective(const Scene &scene,const MaskStorage &states,const Scope &scope,
                             std::shared_ptr<SceneMemory> memory,bool requireSelection=false,bool excludeOutside=false) {
    if(states.size()!=scene.gaussians.size())throw std::runtime_error("Invalid scope mask");
    if(!scope.enabled)return states;
    auto result=MaskStorage::copy(states.span(),std::move(memory));auto bytes=BrowserViewScopeMaskAccess::writable(result);size_t selected=0;
    for(size_t i=0;i<bytes.size();++i) {
        if(!scope.contains(scene.gaussians[i]))bytes[i]=excludeOutside?2:uint8_t(bytes[i]==1?0:bytes[i]);
        selected+=bytes[i]==1;
    }
    if(requireSelection&&!selected)throw std::runtime_error("No selected splats are in the current view");
    return result;
}
} // namespace preview::browser_view_scope
