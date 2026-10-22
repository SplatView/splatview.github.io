// Actual camera ABI4 wrapper contracts. Results are compared with the pinned
// portable Camera::transformed kernel, qualified by captured desktop validity.
// This is kernel parity, not an independent camera-math implementation.
#include "camera.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <limits>
#include <stdexcept>
#include <vector>
#include <emscripten/heap.h>

extern "C" {
int sv_camera_abi_version();
int sv_camera_transform(const float *,const float *,float *,int) noexcept;
int sv_camera_frame_change(const float *,const float *,float *) noexcept;
int sv_camera_orientation_change(const float *,const float *,float *) noexcept;
}
namespace {
using namespace preview;
using State=std::array<float,11>;
using Output=std::array<float,46>;
size_t cases{},checks{},successes{},refusals{},aliasCases{},frameCases{},frameSuccesses{},frameRefusals{},frameAliases{};
size_t orientationCases{},orientationSuccesses{},orientationRefusals{},orientationAliases{};
void require(bool condition,const char *message) { ++checks;if(!condition) throw std::runtime_error(message); }
Camera camera(const State &input) {
    Camera result;result.target={input[0],input[1],input[2]};result.yaw=input[3];result.pitch=input[4];
    result.distance=input[5];result.radius=input[6];result.fieldOfView=input[7];result.yUp=input[8]!=0;result.roll=input[9];return result;
}
Output pinnedOutput(const State &input,const Matrix4 &matrix,int policy) {
    auto result=camera(input).transformed(matrix);if(policy==1) result.roll=0;
    Output output{result.target.x,result.target.y,result.target.z,result.yaw,result.pitch,result.distance,
        result.radius,result.fieldOfView,result.yUp?1.f:0.f,result.roll,input[10]};
    DirectX::XMFLOAT4X4 view,projection;
    DirectX::XMStoreFloat4x4(&view,result.view());DirectX::XMStoreFloat4x4(&projection,result.projection(input[10]));
    std::memcpy(output.data()+11,&view,sizeof(view));std::memcpy(output.data()+27,&projection,sizeof(projection));
    const auto eye=result.eye();output[43]=eye.x;output[44]=eye.y;output[45]=eye.z;return output;
}
State state() { return {.2f,-.3f,.4f,.5f,.18f,3.f,1.f,55.f,1.f,.23f,1.6f}; }
Matrix4 translation(float x,float y=0,float z=0) {
    auto matrix=identityMatrix;matrix[12]=x;matrix[13]=y;matrix[14]=z;return matrix;
}
Output accepted(State input,Matrix4 matrix,int policy=0) {
    const auto originalInput=input;const auto originalMatrix=matrix;const auto expected=pinnedOutput(input,matrix,policy);
    std::array<float,50> guarded;guarded.fill(-123.25f);
    require(sv_camera_transform(input.data(),matrix.data(),guarded.data()+2,policy)==1,"Valid camera transform refused");
    require(guarded[0]==-123.25f && guarded[1]==-123.25f && guarded[48]==-123.25f && guarded[49]==-123.25f,
        "Camera transform wrote outside its 46-float output");
    Output actual;std::copy_n(guarded.data()+2,actual.size(),actual.begin());
    require(!std::memcmp(actual.data(),expected.data(),sizeof(actual)),"Complete camera state/view/projection/eye differs from pinned kernel");
    require(input==originalInput && matrix==originalMatrix,"Camera value transform mutated its inputs");
    require(std::all_of(actual.begin(),actual.end(),[](float value){return std::isfinite(value);}),"Camera success published nonfinite floats");
    ++successes;return actual;
}
void refused(const State &input,const Matrix4 &matrix,int policy=0) {
    Output output;output.fill(37.125f);const auto original=output;
    require(sv_camera_transform(input.data(),matrix.data(),output.data(),policy)==0,"Malformed camera transform accepted");
    require(!std::memcmp(output.data(),original.data(),sizeof(output)),"Camera refusal published a partial output");++refusals;
}
void completePinnedKernel() {
    ++cases;require(sv_camera_abi_version()==4,"Camera wrapper did not expose ABI4");
    Matrix4 rotateScale;
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(rotateScale.data()),
        DirectX::XMMatrixScaling(1.25f,1.25f,1.25f)*DirectX::XMMatrixRotationZ(.35f)*DirectX::XMMatrixTranslation(.4f,-.6f,.8f));
    const std::array<Matrix4,3> matrices{identityMatrix,translation(-.10000000894069672f,.2f,-.3f),rotateScale};
    for(float yUp:{0.f,1.f}) for(const auto &matrix:matrices) for(int policy:{0,1}) {
        auto input=state();input[8]=yUp;const auto result=accepted(input,matrix,policy);
        require(result[7]==input[7] && result[8]==input[8] && result[10]==input[10],"Transform changed lens/direction/aspect values");
        if(policy==1) require(result[9]==0,"WorldUpright policy retained roll");
    }
}
void decimalFrameCarry() {
    ++cases;auto input=state();input[1]=input[2]=0;
    auto before=identityMatrix;
    const std::array<float,3> translations{-.1f,-.2f,-.3f};
    const std::array<float,3> targets{.1f,0.f,-.10000000894069672f};
    for(size_t step=0;step<translations.size();++step) {
        const auto after=translation(translations[step]);Matrix4 delta;
        const auto inverse=DirectX::XMMatrixInverse(nullptr,DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(before.data())));
        DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(delta.data()),inverse*
            DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(after.data())));
        const auto result=accepted(input,delta);
        require(result[0]==targets[step],"Decimal transform target differs from independent frame-rounding oracle");
        std::copy_n(result.begin(),input.size(),input.begin());before=after;
    }
    require(translations[2]-translations[1]==-.10000000894069672f,
        "Decimal frame fixture failed to distinguish exact picked-point translation");
}
void materialTranslationQuantization() {
    ++cases;
    for(float yUp:{0.f,1.f}) {
        auto input=state();input[0]=input[1]=input[2]=input[4]=0;input[8]=yUp;
        const auto result=accepted(input,translation(16777216.f));
        require(std::abs(result[3]-input[3])>.05f && std::abs(result[5]-input[5])>.2f,
            "2^24 translation preserved stored yaw/distance instead of reconstructing transformed eye/focus");
        require(result[0]==16777216.f && result[43]-result[0]==2.f,
            "2^24 translation failed to exercise the intended float eye/focus quantization");
        const auto upright=accepted(input,translation(16777216.f),1);
        require(upright[3]==result[3] && upright[5]==result[5] && upright[9]==0,"WorldUpright policy changed reconstructed navigation");
        auto large=input;large[0]=16777216.f;
        accepted(large,translation(-16777216.f));
    }
}
void stagedRefusals() {
    ++cases;
    const auto input=state();const auto identity=identityMatrix;
    for(size_t index=0;index<input.size();++index) {
        auto invalid=input;invalid[index]=std::numeric_limits<float>::quiet_NaN();refused(invalid,identity);
        invalid[index]=std::numeric_limits<float>::infinity();refused(invalid,identity);
    }
    for(size_t index=0;index<identity.size();++index) {
        auto invalid=identity;invalid[index]=std::numeric_limits<float>::quiet_NaN();refused(input,invalid);
    }
    for(size_t index:{5u,6u,10u}) for(float value:{0.f,-1.f}) {
        auto invalid=input;invalid[index]=value;refused(invalid,identity);
    }
    auto invalid=input;invalid[8]=2;refused(invalid,identity);
    invalid=input;invalid[0]=16777216.f;invalid[1]=invalid[2]=16777216.f;invalid[5]=.001f;refused(invalid,identity);
    refused(input,translation(2e12f));
    auto matrix=identity;matrix[0]=2;refused(input,matrix); // nonuniform scale
    matrix=identity;matrix[4]=.6f;matrix[5]=.8f;refused(input,matrix); // equal row lengths, positive determinant, shear
    matrix=identity;matrix[0]=-1;refused(input,matrix); // reflection
    matrix=identity;matrix[0]=0;refused(input,matrix); // degenerate scale
    matrix=identity;matrix[3]=.1f;refused(input,matrix); // perspective
    matrix=identity;matrix[15]=0;refused(input,matrix); // invalid affine coordinate
    matrix=identity;matrix[0]=matrix[5]=matrix[10]=1e-20f;refused(input,matrix); // underflowed determinant
    refused(input,translation(1e10f,1e10f,1e10f)); // transformed eye/focus collapse
    matrix=identity;matrix[12]=std::numeric_limits<float>::infinity();refused(input,matrix);
    refused(input,identity,-1);refused(input,identity,2);
}
void aliasAndPointerAdmission() {
    ++cases;const auto input=state();const auto matrix=translation(.5f,-.75f,.25f);const auto expected=pinnedOutput(input,matrix,0);
    Output aliased;std::copy(input.begin(),input.end(),aliased.begin());
    require(sv_camera_transform(aliased.data(),matrix.data(),aliased.data(),0)==1 &&
        !std::memcmp(aliased.data(),expected.data(),sizeof(aliased)),"Camera input/output alias did not stage original inputs");++aliasCases;
    std::copy(matrix.begin(),matrix.end(),aliased.begin());
    require(sv_camera_transform(input.data(),aliased.data(),aliased.data(),0)==1 &&
        !std::memcmp(aliased.data(),expected.data(),sizeof(aliased)),"Camera frame/output alias did not stage original frame");++aliasCases;
    // A valid state and matrix cannot share all leading floats: state radius
    // would be zero for an identity matrix. Refuse the overlap unchanged.
    aliased.fill(17);std::copy(identityMatrix.begin(),identityMatrix.end(),aliased.begin());const auto originalAlias=aliased;
    require(sv_camera_transform(aliased.data(),aliased.data(),aliased.data(),0)==0 && aliased==originalAlias,
        "Invalid fully aliased camera/frame wrote output");++aliasCases;++refusals;
    Output output;output.fill(27);const auto original=output;
    const auto heap=emscripten_get_heap_size();
    const auto *misaligned=reinterpret_cast<const float *>(reinterpret_cast<const uint8_t *>(input.data())+1);
    const auto *truncatedState=reinterpret_cast<const float *>(heap-40);
    const auto *truncatedFrame=reinterpret_cast<const float *>(heap-60);
    for(const auto *invalid:{static_cast<const float *>(nullptr),misaligned,truncatedState}) {
        require(sv_camera_transform(invalid,matrix.data(),output.data(),0)==0 && output==original,
            "Invalid camera pointer wrote staged output");++refusals;
    }
    for(const auto *invalid:{static_cast<const float *>(nullptr),misaligned,truncatedFrame}) {
        require(sv_camera_transform(input.data(),invalid,output.data(),0)==0 && output==original,
            "Invalid frame pointer wrote staged output");++refusals;
    }
    for(auto *invalid:{static_cast<float *>(nullptr),reinterpret_cast<float *>(reinterpret_cast<uint8_t *>(output.data())+1),
        reinterpret_cast<float *>(heap-180)}) {
        require(sv_camera_transform(input.data(),matrix.data(),invalid,0)==0 && output==original,
            "Invalid output pointer was admitted");++refusals;
    }
}
Matrix4 pinnedFrameChange(const Matrix4 &before,const Matrix4 &after) {
    Matrix4 result;DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(result.data()),
        DirectX::XMMatrixInverse(nullptr,DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(before.data())))*
        DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(after.data())));return result;
}
Matrix4 acceptedFrame(Matrix4 before,Matrix4 after) {
    const auto originalBefore=before,originalAfter=after,expected=pinnedFrameChange(before,after);
    std::array<float,20> guarded;guarded.fill(19);
    require(sv_camera_frame_change(before.data(),after.data(),guarded.data()+2)==1,"Valid camera frame export refused");
    require(guarded[0]==19 && guarded[1]==19 && guarded[18]==19 && guarded[19]==19,"Frame export wrote outside16 floats");
    Matrix4 result;std::copy_n(guarded.data()+2,16,result.begin());
    require(!std::memcmp(result.data(),expected.data(),sizeof(result)),"Frame export differs from raw pinned DirectX inverse/multiply");
    require(before==originalBefore && after==originalAfter,"Frame export mutated input matrices");++frameSuccesses;return result;
}
void rawFrameCarryAndAliasing() {
    ++cases;++frameCases;
    const auto decimal=acceptedFrame(translation(-.2f),translation(-.3f));
    require(decimal[12]==-.10000000894069672f && decimal[15]==1,"Center frame delta changed qualified decimal arithmetic");
    for(float scale:{.7f,.9999999403953552f,1e-6f,1e6f}) {
        auto before=translation(.13f,-.21f,.37f);before[0]=before[5]=before[10]=scale;
        const auto after=translation(-.4f,.5f,-.6f);acceptedFrame(before,after);
        auto alias=before;const auto expected=pinnedFrameChange(before,after);
        require(sv_camera_frame_change(alias.data(),after.data(),alias.data())==1 &&
            !std::memcmp(alias.data(),expected.data(),sizeof(alias)),"Frame input/output alias lost original before matrix");++frameAliases;
        alias=after;require(sv_camera_frame_change(before.data(),alias.data(),alias.data())==1 &&
            !std::memcmp(alias.data(),expected.data(),sizeof(alias)),"Frame output alias lost original after matrix");++frameAliases;
        alias=before;const auto sameExpected=pinnedFrameChange(before,before);
        require(sv_camera_frame_change(alias.data(),alias.data(),alias.data())==1 &&
            !std::memcmp(alias.data(),sameExpected.data(),sizeof(alias)),"Fully aliased frame export lost raw inverse/composition rounding");++frameAliases;
    }
}
void frameRefusalPreservesOutput() {
    ++cases;++frameCases;const auto valid=identityMatrix;
    auto refuse=[&](const float *before,const float *after) {
        Matrix4 output;output.fill(41);const auto original=output;
        require(sv_camera_frame_change(before,after,output.data())==0 && output==original,"Frame refusal modified output");++frameRefusals;
    };
    for(size_t entry=0;entry<16;++entry) {
        auto invalid=valid;invalid[entry]=std::numeric_limits<float>::quiet_NaN();
        refuse(invalid.data(),valid.data());refuse(valid.data(),invalid.data());
    }
    auto invalid=valid;invalid[0]=0;refuse(invalid.data(),valid.data());refuse(valid.data(),invalid.data());
    invalid=valid;invalid[0]=invalid[5]=invalid[10]=1e-20f;refuse(invalid.data(),valid.data());
    invalid=valid;invalid[0]=invalid[5]=invalid[10]=1e20f;refuse(valid.data(),invalid.data());
    const auto heap=emscripten_get_heap_size();const auto *truncated=reinterpret_cast<const float *>(heap-60);
    const auto *misaligned=reinterpret_cast<const float *>(reinterpret_cast<const uint8_t *>(valid.data())+1);
    for(const auto *bad:{static_cast<const float *>(nullptr),truncated,misaligned}) { refuse(bad,valid.data());refuse(valid.data(),bad); }
    Matrix4 output;output.fill(31);const auto original=output;
    for(auto *bad:{static_cast<float *>(nullptr),reinterpret_cast<float *>(heap-60),
        reinterpret_cast<float *>(reinterpret_cast<uint8_t *>(output.data())+1)}) {
        require(sv_camera_frame_change(valid.data(),valid.data(),bad)==0 && output==original,"Invalid frame output pointer admitted");++frameRefusals;
    }
}
Matrix4 pinnedOrientationChange(const Matrix4 &before,const Matrix4 &after) {
    using namespace DirectX;
    const auto rotation=[](const Matrix4 &frame) {
        auto matrix=XMMatrixIdentity();
        for(unsigned row=0;row<3;++row) {
            const double x=frame[row*4],y=frame[row*4+1],z=frame[row*4+2],length=std::hypot(x,y,z);
            matrix.r[row]=XMVectorSet(float(x/length),float(y/length),float(z/length),0);
        }
        return XMMatrixRotationQuaternion(XMQuaternionNormalize(XMQuaternionRotationMatrix(matrix)));
    };
    Matrix4 result;XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(result.data()),XMMatrixTranspose(rotation(before))*rotation(after));return result;
}
void orientationOnlyDefaultTransport() {
    ++cases;++orientationCases;
    Matrix4 before,after;
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(before.data()),DirectX::XMMatrixRotationRollPitchYaw(.3f,-.2f,.7f));
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(after.data()),DirectX::XMMatrixRotationRollPitchYaw(-.6f,.25f,.4f));
    const auto ordinary=pinnedOrientationChange(before,after);
    // Source extraction independently normalizes rows. Nonuniform and extreme
    // magnitudes are meaningful here, without admitting them as scene frames.
    for(const std::array<float,3> scales: {std::array<float,3>{.7f,.7f,.7f},std::array<float,3>{1e-30f,1e30f,3.f}}) {
        auto input=before;
        for(size_t row=0;row<3;++row) for(size_t column=0;column<3;++column) input[row*4+column]*=scales[row];
        input[12]=1e30f;input[13]=-1e30f;input[14]=.123f;
        const auto original=input,expected=pinnedOrientationChange(input,after);std::array<float,20> output;output.fill(37);
        require(sv_camera_orientation_change(input.data(),after.data(),output.data()+2)==1,"Valid orientation-only transport refused");
        require(output[0]==37 && output[1]==37 && output[18]==37 && output[19]==37,"Orientation export wrote outside16 floats");
        require(!std::memcmp(output.data()+2,expected.data(),sizeof(expected)) && input==original,"Orientation export changed source normalization/arithmetic/input");++orientationSuccesses;
        require(expected[12]==0 && expected[13]==0 && expected[14]==0 && expected[15]==1,"Orientation delta retained translation/scale homogeneous artifacts");
        for(size_t index=0;index<12;++index) require(std::abs(expected[index]-ordinary[index])<2e-6f,"Orientation extraction depends on discarded row magnitudes");
        auto alias=input;require(sv_camera_orientation_change(alias.data(),after.data(),alias.data())==1 && !std::memcmp(alias.data(),expected.data(),sizeof(alias)),"Orientation before/output alias failed");++orientationAliases;
        alias=after;require(sv_camera_orientation_change(input.data(),alias.data(),alias.data())==1 && !std::memcmp(alias.data(),expected.data(),sizeof(alias)),"Orientation after/output alias failed");++orientationAliases;
        alias=input;const auto same=pinnedOrientationChange(input,input);
        require(sv_camera_orientation_change(alias.data(),alias.data(),alias.data())==1 && !std::memcmp(alias.data(),same.data(),sizeof(alias)),"Orientation complete alias changed quaternion rounding");++orientationAliases;
    }
}
void orientationRefusalKeepsOutput() {
    ++cases;++orientationCases;const auto valid=identityMatrix;
    const auto refuse=[&](const float *before,const float *after) {
        Matrix4 output;output.fill(47);const auto original=output;
        require(sv_camera_orientation_change(before,after,output.data())==0 && output==original,"Refused orientation modified output");++orientationRefusals;
    };
    for(size_t index=0;index<16;++index) {auto bad=valid;bad[index]=std::numeric_limits<float>::quiet_NaN();refuse(bad.data(),valid.data());refuse(valid.data(),bad.data());}
    for(size_t row=0;row<3;++row) {auto bad=valid;bad[row*4+row]=0;refuse(bad.data(),valid.data());}
    auto bad=valid;bad[0]=-1;refuse(bad.data(),valid.data());bad=valid;bad[1]=.1f;refuse(valid.data(),bad.data());
    bad=valid;bad[3]=.1f;refuse(bad.data(),valid.data());bad=valid;bad[15]=2;refuse(valid.data(),bad.data());
    const auto heap=emscripten_get_heap_size();const auto *shortInput=reinterpret_cast<const float *>(heap-60);
    const auto *misaligned=reinterpret_cast<const float *>(reinterpret_cast<const uint8_t *>(valid.data())+1);
    for(const auto *pointer:{static_cast<const float *>(nullptr),shortInput,misaligned}) {refuse(pointer,valid.data());refuse(valid.data(),pointer);}
    Matrix4 output;output.fill(43);const auto original=output;
    for(auto *pointer:{static_cast<float *>(nullptr),reinterpret_cast<float *>(heap-60),reinterpret_cast<float *>(reinterpret_cast<uint8_t *>(output.data())+1)}) {
        require(sv_camera_orientation_change(valid.data(),valid.data(),pointer)==0 && output==original,"Invalid orientation output pointer admitted");++orientationRefusals;
    }
}
}
int main() {
    try {
        completePinnedKernel();decimalFrameCarry();materialTranslationQuantization();stagedRefusals();aliasAndPointerAdmission();
        rawFrameCarryAndAliasing();frameRefusalPreservesOutput();
        orientationOnlyDefaultTransport();orientationRefusalKeepsOutput();
        std::printf("SPLATVIEW_CAMERA_TRANSFORM_CONTRACTS_PASS cases=%zu checks=%zu successes=%zu refusals=%zu aliasCases=%zu frameCases=%zu frameSuccesses=%zu frameRefusals=%zu frameAliases=%zu orientationCases=%zu orientationSuccesses=%zu orientationRefusals=%zu orientationAliases=%zu\n",
            cases,checks,successes,refusals,aliasCases,frameCases,frameSuccesses,frameRefusals,frameAliases,orientationCases,orientationSuccesses,orientationRefusals,orientationAliases);return 0;
    } catch(const std::exception &error) {
        std::fprintf(stderr,"SPLATVIEW_CAMERA_TRANSFORM_CONTRACTS_FAIL %s\n",error.what());return 1;
    }
}
