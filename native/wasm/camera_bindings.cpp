#include "camera.hpp"
#include "browser_camera_transform.hpp"
#include "browser_alignment_frame.hpp"
#include "browser_filter_view.hpp"
#include "browser_filter_gizmo.hpp"
#include "browser_transform_gizmo.hpp"
#include "browser_transform_math.hpp"
#include "navigation.hpp"
#include "runtime_build_identity.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <emscripten/heap.h>
using namespace preview;
// Layout: state[0..11), view[11..27), projection[27..43), eye[43..46).
// State is target xyz, yaw, pitch, distance, radius, fov, yUp, roll, aspect.
namespace {
struct Input {
    SmoothScroll scroll;
    KeyNavigation navigation;
};
Camera readCamera(const float *data) {
    Camera camera;
    camera.target = {data[0], data[1], data[2]};
    camera.yaw=data[3]; camera.pitch=data[4]; camera.distance=data[5];
    camera.radius=data[6]; camera.fieldOfView=data[7]; camera.yUp=data[8]!=0; camera.roll=data[9];
    return camera;
}
void writeCamera(float *data, const Camera &camera) {
    data[0]=camera.target.x; data[1]=camera.target.y; data[2]=camera.target.z;
    data[3]=camera.yaw; data[4]=camera.pitch; data[5]=camera.distance;
    data[6]=camera.radius; data[7]=camera.fieldOfView; data[8]=camera.yUp?1.f:0.f; data[9]=camera.roll;
    DirectX::XMFLOAT4X4 view, projection;
    DirectX::XMStoreFloat4x4(&view,camera.view());
    DirectX::XMStoreFloat4x4(&projection,camera.projection(data[10]));
    std::memcpy(data+11,&view,64); std::memcpy(data+27,&projection,64);
    const auto eye=camera.eye(); data[43]=eye.x; data[44]=eye.y; data[45]=eye.z;
}
bool admittedRange(const void *pointer,size_t bytes) noexcept {
    const auto start=reinterpret_cast<uintptr_t>(pointer);
    const auto heap=emscripten_get_heap_size();
    return start && start%alignof(float)==0 && start<=heap && bytes<=heap-start;
}
}
extern "C" {
int sv_camera_abi_version() { return 4; }
const char *sv_camera_build_identity() { return splatview_runtime_identity::camera; }
int sv_camera_transform_compose(const float *input,float *output) noexcept {
    if(!admittedRange(input,browser_transform::composeInputFloats*sizeof(float))||!admittedRange(output,16*sizeof(float)))return 0;
    browser_transform::ComposeInput copied;Matrix4 staged;std::memcpy(copied.data(),input,sizeof(copied));
    if(!browser_transform::compose(copied,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_transform_gizmo_frame(const float *input,float *output) noexcept {
    if(!admittedRange(input,browser_transform_gizmo::inputFloats*sizeof(float))||!admittedRange(output,sizeof(browser_transform_gizmo::Frame)))return 0;
    browser_transform_gizmo::Input copied;browser_transform_gizmo::Frame staged;std::memcpy(copied.data(),input,sizeof(copied));
    if(!browser_transform_gizmo::frame(copied,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_transform_gizmo_begin(const float *input,int handle,float *output) noexcept {
    if(!admittedRange(input,browser_transform_gizmo::inputFloats*sizeof(float))||!admittedRange(output,sizeof(browser_transform_gizmo::State)))return 0;
    browser_transform_gizmo::Input copied;browser_transform_gizmo::State staged;std::memcpy(copied.data(),input,sizeof(copied));
    if(!browser_transform_gizmo::begin(copied,handle,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_transform_gizmo_update(const float *state,const float *pointer,float *output) noexcept {
    if(!admittedRange(state,sizeof(browser_transform_gizmo::State))||!admittedRange(pointer,3*sizeof(float))||!admittedRange(output,sizeof(browser_transform_gizmo::Result)))return 0;
    browser_transform_gizmo::State copied;browser_transform_gizmo::Pointer event;browser_transform_gizmo::Result staged;
    std::memcpy(copied.data(),state,sizeof(copied));std::memcpy(event.data(),pointer,sizeof(event));
    if(!browser_transform_gizmo::update(copied,event,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
// Constant-size value exports. Read all admitted inputs before staged output
// publication; aliases are valid, and every refusal preserves the destination.
int sv_camera_filter_gizmo_frame(const float *input,float *output) noexcept {
    using namespace browser_filter_gizmo;
    if(!admittedRange(input,inputFloats*sizeof(float))||!admittedRange(output,frameFloats*sizeof(float)))return 0;
    browser_filter_gizmo::Input copied;Frame staged;std::memcpy(copied.data(),input,sizeof(copied));
    if(!frame(copied,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_filter_gizmo_begin(const float *input,int handle,float *output) noexcept {
    using namespace browser_filter_gizmo;
    if(!admittedRange(input,inputFloats*sizeof(float))||!admittedRange(output,stateFloats*sizeof(float)))return 0;
    browser_filter_gizmo::Input copied;State staged;std::memcpy(copied.data(),input,sizeof(copied));
    if(!begin(copied,handle,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_filter_gizmo_update(const float *state,const float *pointer,float *output) noexcept {
    using namespace browser_filter_gizmo;
    if(!admittedRange(state,stateFloats*sizeof(float))||!admittedRange(pointer,3*sizeof(float))||!admittedRange(output,poseFloats*sizeof(float)))return 0;
    State copied;Pointer event;Pose staged;std::memcpy(copied.data(),state,sizeof(copied));std::memcpy(event.data(),pointer,sizeof(event));
    if(!update(copied,event,staged))return 0;std::memcpy(output,staged.data(),sizeof(staged));return 1;
}
int sv_camera_filter_view(const float *state,float *output) noexcept {
    if(!admittedRange(state,11*sizeof(float)) || !admittedRange(output,10*sizeof(float))) return 0;
    try {
        std::array<float,11> input;
        std::memcpy(input.data(),state,sizeof(input));
        if(std::any_of(input.begin(),input.end(),[](float value){return !std::isfinite(value);}) ||
           input[5]<=0 || input[6]<=0 || (input[8]!=0 && input[8]!=1)) return 0;
        const auto result=browser_filter_view::fromCamera(readCamera(input.data()),input[10]);
        std::memcpy(output,result.data(),sizeof(result));return 1;
    } catch(...) { return 0; }
}
int sv_camera_frame_change(const float *before,const float *after,float *output) noexcept {
    if(!admittedRange(before,16*sizeof(float)) || !admittedRange(after,16*sizeof(float)) ||
       !admittedRange(output,16*sizeof(float))) return 0;
    try {
        Matrix4 previous,next;std::memcpy(previous.data(),before,sizeof(previous));std::memcpy(next.data(),after,sizeof(next));
        const auto result=browser_alignment_frame::change(previous,next);
        std::memcpy(output,result.data(),sizeof(result));return 1;
    } catch(...) { return 0; }
}
int sv_camera_orientation_change(const float *before,const float *after,float *output) noexcept {
    if(!admittedRange(before,16*sizeof(float)) || !admittedRange(after,16*sizeof(float)) || !admittedRange(output,16*sizeof(float))) return 0;
    try {
        Matrix4 previous,next;std::memcpy(previous.data(),before,sizeof(previous));std::memcpy(next.data(),after,sizeof(next));
        const auto result=browser_alignment_frame::orientationChange(previous,next);
        std::memcpy(output,result.data(),sizeof(result));return 1;
    } catch(...) { return 0; }
}
// A constant-size value operation: no navigation/session state is touched.
// Inputs may alias output. All reads precede the staged result's publication.
int sv_camera_transform(const float *state,const float *frame,float *output,int policy) noexcept {
    if((policy!=0 && policy!=1) || !admittedRange(state,11*sizeof(float)) ||
       !admittedRange(frame,16*sizeof(float)) || !admittedRange(output,46*sizeof(float))) return 0;
    try {
        std::array<float,11> input;Matrix4 matrix;std::array<float,46> staged{};
        std::memcpy(input.data(),state,sizeof(input));std::memcpy(matrix.data(),frame,sizeof(matrix));
        if(std::any_of(input.begin(),input.end(),[](float v){return !std::isfinite(v);}) ||
           (input[8]!=0 && input[8]!=1)) return 0;
        const auto camera=browser_camera_transform::transformed(readCamera(input.data()),matrix,input[10],
            static_cast<browser_camera_transform::Policy>(policy));
        staged[10]=input[10];writeCamera(staged.data(),camera);
        if(std::any_of(staged.begin(),staged.end(),[](float v){return !std::isfinite(v);})) return 0;
        std::memcpy(output,staged.data(),sizeof(staged));return 1;
    } catch(...) { return 0; }
}
void sv_camera(float *data, int action, float a, float b, float c) {
    Camera camera = readCamera(data);
    if(action==1) camera.orbit(a,b);
    else if(action==2) camera.pan(a,b);
    else if(action==3) camera.zoom(a);
    else if(action==4) camera.look(a,b);
    else if(action==5) camera.move(a,b,c);
    else if(action==6) camera.focus({a,b,c});
    writeCamera(data, camera);
}
Input *sv_camera_input_create() { return new Input; }
void sv_camera_input_delete(Input *input) { delete input; }
// Events: queue wheel, key transition, speed modifiers, cancel all input.
void sv_camera_input(Input *input, const float *data, int action, float a, float b, float c) {
    if (action == 1) {
        input->navigation.cancel();
        input->scroll.queue(readCamera(data), b != 0, a);
    } else if (action == 2 && a >= 0 && a <= 10) {
        input->navigation.key(static_cast<NavigationKey>(int(a)), b != 0);
        if (b != 0) input->scroll.cancel();
    } else if (action == 3) {
        input->navigation.speed(a != 0, b != 0);
    } else if (action == 4) {
        input->scroll.cancel();
        input->navigation.cancel();
    }
}
int sv_camera_input_active(const Input *input) {
    return input->scroll.active() || input->navigation.active();
}
int sv_camera_tick(Input *input, float *data, int fly, float elapsed) {
    Camera camera = readCamera(data);
    bool moving = input->scroll.advance(camera, elapsed);
    moving = input->navigation.advance(camera, fly != 0, std::clamp(elapsed, 0.f, .1f)) || moving;
    if (moving) writeCamera(data, camera);
    return moving;
}
}
