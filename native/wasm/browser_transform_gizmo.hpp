#pragma once
#include "browser_filter_gizmo.hpp"
#include <array>
namespace preview::browser_transform_gizmo {
inline constexpr size_t inputFloats=61,stateFloats=128,resultFloats=48;
using Input=std::array<float,inputFloats>;
using State=std::array<float,stateFloats>;
using Result=std::array<float,resultFloats>;
using Frame=browser_filter_gizmo::Frame;
using Pointer=browser_filter_gizmo::Pointer;
// Input view/projection0..31,viewportxywh32..35,panelScale36,op37,
// local38,snap39,pointerxy40..41,pivot42..44,widgetMatrix45..60.
// Widget is an orthogonal positive-TRS affine frame, independent of scene data.
// Result: widgetMatrix0..15,GPU/internal delta16..31,row-major delta32..47.
// State128: magic104731,version1,handle,input61,64 reserved zero slots.
// No scene matrix inversion, heap ownership or partial writes on refusal.
bool frame(const Input &,Frame &) noexcept;
bool begin(const Input &,int handle,State &) noexcept;
bool update(const State &,const Pointer &,Result &) noexcept;
} // namespace preview::browser_transform_gizmo
