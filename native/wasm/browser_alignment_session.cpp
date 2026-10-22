#include "browser_alignment_session.hpp"
#include "browser_camera_transform.hpp"
#include "browser_alignment_frame.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview::browser_alignment {
bool validContext(const Context &c) noexcept {
    return c.settled && c.document && c.scene && c.scene->isGaussian() &&
        c.scene->gaussians.size()<=1'000'000 && c.scene->gaussians.size()==c.states.size();
}
bool sameContext(const Context &a,const Context &b) noexcept {
    return a.document==b.document && a.revision==b.revision && a.contentRevision==b.contentRevision &&
        a.scene==b.scene && a.states.data()==b.states.data() && a.states.size()==b.states.size();
}
uint64_t Lineage::branch(const std::shared_ptr<const Scene> &scene) const noexcept {
    if(!scene) return 0;
    for(const auto &entry:entries_) if(entry.branch && entry.scene.lock()==scene) return entry.branch;
    return 0;
}
bool Lineage::associate(const std::shared_ptr<const Scene> &scene,uint64_t branch) noexcept {
    if(!scene || branch>maximumIdentity) return false;
    if(!branch) return true;
    Entry *available=nullptr;
    for(auto &entry:entries_) {
        const auto owner=entry.scene.lock();
        if(owner==scene) return entry.branch==branch;
        if(!owner && !available) available=&entry;
    }
    if(!available) return false;
    available->scene=scene;available->branch=branch;return true;
}
bool Lineage::inherit(const std::shared_ptr<const Scene> &copy,const std::shared_ptr<const Scene> &source) noexcept {
    return associate(copy,branch(source));
}
void Lineage::prune() noexcept { for(auto &entry:entries_) if(entry.scene.expired()) entry={}; }
void Lineage::clear() noexcept { for(auto &entry:entries_) entry={}; }
std::optional<uint64_t> IdSequence::take() noexcept {
    if(!next_ || next_>maximumIdentity) return {};
    return next_++;
}
bool Session::current(const Context &c) const noexcept {
    return base_ && validContext(c) && sameContext(acknowledged_,c);
}
bool Session::begin(const Context &c) noexcept {
    if(!validContext(c)) return false;
    if(!current(c)) { base_=c.scene;states_=c.states;acknowledged_=c; }
    return true;
}
bool Session::acknowledge(const Context &before,const Context &after) noexcept {
    if(!current(before) || !validContext(after) || before.document!=after.document ||
       before.states.size()!=after.states.size() || after.revision<=before.revision ||
       after.contentRevision==before.contentRevision) return false;
    acknowledged_=after;return true;
}
bool Session::canReset(const Context &c) const noexcept {
    // The session's own publications preserve mask values, so same-owner base
    // is the exact no-op Reset. Stale revisions/group changes always refuse.
    return current(c) && c.scene!=base_;
}
void Session::retireStale(const Context &c) noexcept { if(base_ && !current(c)) clear(); }
void Session::clear() noexcept { base_.reset();states_.clear();acknowledged_={}; }
Matrix4 inverseFrame(const Matrix4 &frame) {
    return browser_alignment_frame::inverse(frame);
}
Matrix4 centeredFrame(const Matrix4 &frame,Vec3 point) {
    return browser_alignment_frame::centered(frame,point);
}
void validateCamera(const Camera &camera,float aspect) {
    browser_camera_transform::validate(camera,aspect);
}
Camera translatedCamera(const Camera &camera,Vec3 delta,float aspect) {
    auto matrix=identityMatrix;matrix[12]=delta.x;matrix[13]=delta.y;matrix[14]=delta.z;
    return browser_camera_transform::transformed(camera,matrix,aspect);
}
Camera carriedCamera(const Camera &camera,const Matrix4 &before,const Matrix4 &after,float aspect) {
    return browser_camera_transform::transformed(camera,browser_alignment_frame::change(before,after),aspect);
}
Vec3 planeNormal(const std::array<Vec3,3> &points) {
    // Captured normalFromPoints: double pointNormal/unit, then float32 Vec3.
    const auto difference=[](Vec3 a,Vec3 b) { return std::array<double,3>{double(a.x)-b.x,double(a.y)-b.y,double(a.z)-b.z}; };
    const auto length=[](const auto &v) { return std::sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); };
    const auto ab=difference(points[1],points[0]),ac=difference(points[2],points[0]);
    const std::array<double,3> normal{ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]};
    const double n=length(normal);
    if(n<=length(ab)*length(ac)*1e-6) throw std::runtime_error("Choose three points that are not on one line.");
    if(!std::isfinite(n) || n<=0) throw std::runtime_error("Choose distinct points on the scene.");
    return {float(normal[0]/n),float(normal[1]/n),float(normal[2]/n)};
}
void validateSceneCamera(const Scene &scene,float aspect) {
    inverseFrame(scene.alignmentFrame);
    if(!std::isfinite(scene.center.x) || !std::isfinite(scene.center.y) || !std::isfinite(scene.center.z) ||
       !std::isfinite(scene.radius) || scene.radius<=0) throw std::runtime_error("Invalid aligned scene bounds.");
    Camera camera;camera.fit(scene,aspect);validateCamera(camera,aspect);
}
} // namespace preview::browser_alignment
