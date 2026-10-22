#pragma once
#include <array>
#include <cstddef>

namespace preview::browser_filter_gizmo {
// All coordinates are CSS pixels. Matrices retain the desktop row-vector
// layout. No scene, heap owner, navigation state or ImGui context is involved.
inline constexpr size_t inputFloats=58,poseFloats=14,stateFloats=96;
inline constexpr size_t primitiveFloats=12,maxPrimitives=512,frameFloats=4+primitiveFloats*maxPrimitives;
using Input=std::array<float,inputFloats>;
using Pose=std::array<float,poseFloats>;
using State=std::array<float,stateFloats>;
using Pointer=std::array<float,3>;
using Frame=std::array<float,frameFloats>;
enum class Handle:int { None=0,MoveX=1,MoveY,MoveZ,MoveYZ,MoveZX,MoveXY,MoveScreen,
    RotateX,RotateY,RotateZ,RotateScreen,ScaleX,ScaleY,ScaleZ,ScaleUniform };
enum class Primitive:int { Line=0,Disc=1,Square=2,Quad=3 };
// input[0..31]: view16/projection16; [32..43]: viewport xy/wh, panelScale,
// shape1..4, operation0..2, local01,snap01,outline01,pointer xy;
// [44..57]: center3,size3,axis-angle-degrees3,radius,fov,aspect,near,far.
// frame[0..3]: count,hitHandle,center xy. Row12: handle,role,type,
// x0,y0,x1,y1,x2,y2,x3,y3,weight. Roles X0/Y1/Z2/screen3/volume4.
// Disc/Square use x0,y0 center and x1 radius/halfSize. Quads are ordered.
// state96: magic104729,version1,handle,input58,35 reserved zeros. Immutable.
// Refusals leave every output byte intact, including trailing frame capacity.
bool frame(const Input &,Frame &) noexcept;
bool begin(const Input &,int handle,State &) noexcept;
bool update(const State &,const Pointer &,Pose &) noexcept;
} // namespace preview::browser_filter_gizmo
