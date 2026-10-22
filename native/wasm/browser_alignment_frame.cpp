#include "browser_alignment_frame.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview::browser_alignment_frame {
namespace {
void finite(const Matrix4 &matrix) {
    if(std::any_of(matrix.begin(),matrix.end(),[](float value){return !std::isfinite(value);}))
        throw std::runtime_error("Alignment exceeds the supported coordinate range.");
}
Matrix4 multiply(const Matrix4 &before,const Matrix4 &after) {
    using namespace DirectX;finite(before);finite(after);Matrix4 result;
    XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()),
        XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(before.data()))*
        XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(after.data())));
    finite(result);return result;
}
}
Matrix4 inverse(const Matrix4 &frame) {
    using namespace DirectX;finite(frame);XMVECTOR determinant;Matrix4 result;
    XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()),
        XMMatrixInverse(&determinant,XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(frame.data()))));
    const float value=XMVectorGetX(determinant);
    if(!std::isfinite(value) || value==0) throw std::runtime_error("Alignment exceeds the supported coordinate range.");
    finite(result);return result; // Retain raw DirectX rounding, including m15.
}
Matrix4 compose(const Matrix4 &before,const Matrix4 &transform) {
    inverse(before);inverse(transform);const auto result=multiply(before,transform);inverse(result);return result;
}
Matrix4 change(const Matrix4 &before,const Matrix4 &after) {
    const auto previous=inverse(before);inverse(after);return multiply(previous,after);
}
Matrix4 orientationChange(const Matrix4 &before,const Matrix4 &after) {
    using namespace DirectX;
    const auto rotation=[](const Matrix4 &frame) {
        finite(frame);auto matrix=XMMatrixIdentity();
        for(unsigned row=0;row<3;++row) {
            const double x=frame[row*4],y=frame[row*4+1],z=frame[row*4+2];
            const double length=std::hypot(x,y,z);
            if(!std::isfinite(length) || length<=0) throw std::runtime_error("Alignment camera frame has no valid rotation.");
            matrix.r[row]=XMVectorSet(float(x/length),float(y/length),float(z/length),0);
        }
        // Same admission as the camera's proper uniform linear transform, but
        // ignore translation/scale magnitude: retained defaults transport only
        // orientation and must not overflow through abandoned coordinate frames.
        if(XMVectorGetX(XMMatrixDeterminant(matrix))<=0) throw std::runtime_error("Invalid alignment camera orientation.");
        for(unsigned r=0;r<3;++r) for(unsigned c=r+1;c<3;++c)
            if(std::abs(XMVectorGetX(XMVector3Dot(matrix.r[r],matrix.r[c])))>1e-4f)
                throw std::runtime_error("Alignment cannot shear the scene.");
        if(std::abs(frame[3])>1e-6f || std::abs(frame[7])>1e-6f || std::abs(frame[11])>1e-6f || std::abs(frame[15]-1)>1e-6f)
            throw std::runtime_error("Invalid alignment camera orientation.");
        return XMMatrixRotationQuaternion(XMQuaternionNormalize(XMQuaternionRotationMatrix(matrix)));
    };
    Matrix4 result;XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()),XMMatrixTranspose(rotation(before))*rotation(after));
    finite(result);return result;
}
Matrix4 centered(const Matrix4 &frame,Vec3 point) {
    inverse(frame);auto linear=frame;linear[12]=linear[13]=linear[14]=0;
    if(linear==identityMatrix) {
        // Preserve the qualified Center translation arithmetic exactly.
        auto result=frame;result[12]-=point.x;result[13]-=point.y;result[14]-=point.z;
        inverse(result);return result;
    }
    auto transform=identityMatrix;transform[12]=-point.x;transform[13]=-point.y;transform[14]=-point.z;
    return compose(frame,transform);
}
} // namespace preview::browser_alignment_frame
