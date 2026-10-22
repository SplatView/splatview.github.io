// Cooperative fixed-storage adaptation of desktop SceneEdits::focusBounds
// (captured SplatView 1.0.2, editing.cpp): selected Gaussian covariance-diagonal
// three-sigma AABB midpoint. Empty selection is explicitly absent for pivot
// cycling; it does not fall back to all visible splats as camera focus does.
#include "browser_focus_bounds.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview::browser_focus {
namespace {
uint64_t integer(const nlohmann::json &value,bool positive=false) {
    if(!value.is_number_integer()||(!value.is_number_unsigned()&&value.get<int64_t>()<0))
        throw std::invalid_argument("Invalid transform focus identity");
    const auto out=value.get<uint64_t>();
    if(out>maximumIdentity||(positive&&!out))throw std::invalid_argument("Invalid transform focus identity");
    return out;
}
bool finite(Vec3 point) noexcept {return std::isfinite(point.x)&&std::isfinite(point.y)&&std::isfinite(point.z);}
bool maskIdentity(const MaskStorage &a,const MaskStorage &b) noexcept {return a.data()==b.data()&&a.size()==b.size();}
float midpoint(float low,float high) noexcept {
    const float sum=low+high;
    // Preserve desktop float rounding, including subnormal centers, whenever
    // its intermediate is finite. Only overflow uses half-before-add so a
    // valid finite-float32 midpoint cannot become an infinite query result.
    return std::isfinite(sum)?sum*.5f:low*.5f+high*.5f;
}
}
Request parse(const nlohmann::json &value) {
    // Compare the borrowed native string. nlohmann's JSON/scalar-pointer
    // comparison constructs an allocating JSON string inside noexcept, which
    // would terminate instead of propagating an ordinary allocation refusal.
    if(!value.is_object()||value.size()!=5||!value.contains("command")||!value.at("command").is_string()||
       value.at("command").get_ref<const std::string &>()!="transformFocus"||
       !value.contains("scope")||!value.at("scope").is_string()||!value.contains("revision")||
       !value.contains("contentRevision")||!value.contains("transformBase"))
        throw std::invalid_argument("Invalid transform focus fields");
    Request out;const auto &scope=value.at("scope").get_ref<const std::string &>();
    if(scope=="scene")out.scope=Scope::Scene;
    else if(scope=="selection")out.scope=Scope::Selection;
    else throw std::invalid_argument("Invalid transform focus scope");
    out.revision=integer(value.at("revision"));out.contentRevision=integer(value.at("contentRevision"));
    const auto &base=value.at("transformBase");
    if(!base.is_null()) {
        if(!base.is_object()||base.size()!=3||!base.contains("id")||!base.contains("baseId")||!base.contains("epoch"))
            throw std::invalid_argument("Invalid transform focus base");
        out.transform=TransformBase{integer(base.at("id"),true),integer(base.at("baseId"),true),integer(base.at("epoch"))};
    }
    return out;
}
bool valid(const Snapshot &value) noexcept {
    return value.currentScene&&value.base&&value.currentScene->isGaussian()&&value.base->isGaussian()&&
        value.base->gaussians.size()<=1000000&&value.currentScene->gaussians.size()==value.base->gaussians.size()&&
        value.currentStates.size()==value.currentScene->gaussians.size()&&value.states.size()==value.base->gaussians.size()&&
        value.generation&&value.generation<=maximumIdentity&&value.revision<=maximumIdentity&&value.contentRevision<=maximumIdentity&&
        (!value.transform||(value.transform->id&&value.transform->id<=maximumIdentity&&value.transform->baseId&&
         value.transform->baseId<=maximumIdentity&&value.transform->epoch<=maximumIdentity));
}
bool current(const Snapshot &a,const Snapshot &b) noexcept {
    return valid(a)&&valid(b)&&a.currentScene==b.currentScene&&a.base==b.base&&
        maskIdentity(a.currentStates,b.currentStates)&&maskIdentity(a.states,b.states)&&
        a.generation==b.generation&&a.revision==b.revision&&a.contentRevision==b.contentRevision&&a.transform==b.transform;
}
Vec3 scenePoint(const Snapshot &value) {
    if(!valid(value)||!finite(value.base->center))throw std::invalid_argument("Invalid transform scene focus");
    return value.base->center;
}
Job::Pointer Job::create(Snapshot snapshot,std::shared_ptr<SceneMemory> memory) {
    if(!memory||!valid(snapshot))throw std::invalid_argument("Transform focus needs an admitted Gaussian baseline");
    AdmittedAllocator<Job> allocator{memory};auto *job=allocator.allocate(1);
    try {std::construct_at(job,std::move(snapshot));}
    catch(...) {allocator.deallocate(job,1);throw;}
    return Pointer(job,Deleter{std::move(memory)});
}
Job::Job(Snapshot snapshot):snapshot_(std::move(snapshot)) {
    if(!valid(snapshot_))throw std::invalid_argument("Invalid transform focus baseline");
    low_.fill(std::numeric_limits<float>::infinity());high_.fill(-std::numeric_limits<float>::infinity());
}
void Job::Deleter::operator()(Job *job) const noexcept {
    if(job){AdmittedAllocator<Job> allocator{memory};std::destroy_at(job);allocator.deallocate(job,1);}
}
void Job::retire(Pointer &job) noexcept {if(job)job->cancel();job.reset();job.get_deleter().memory.reset();}
size_t Job::step(size_t maximumWork,const Snapshot &now) {
    lastStepWork_=0;
    if(cancelled_||complete_)return 0;
    try {
        if(!current(snapshot_,now))throw std::runtime_error("Transform focus baseline is stale");
        while(lastStepWork_<maximumWork&&cursor_<snapshot_.states.size()) {visit(cursor_++);++lastStepWork_;}
        if(cursor_==snapshot_.states.size()) {
            if(selected_) {
                const Vec3 value{midpoint(low_[0],high_[0]),midpoint(low_[1],high_[1]),midpoint(low_[2],high_[2])};
                if(!finite(value))throw std::runtime_error("Invalid transform focus center");point_=value;
            }
            complete_=true;
        }
    } catch(...) {cancel();throw;}
    return lastStepWork_;
}
void Job::visit(size_t index) {
    const auto state=snapshot_.states[index];
    // SceneEdits and its checkpoint codec publish canonical 0/1/2 masks.
    // Readonly focus also tolerates the selected+deleted bit combination used
    // by export/render masks, while every deleted state is excluded.
    if(state>3)throw std::runtime_error("Invalid transform focus selection state");
    if(state!=1)return;
    const auto &g=snapshot_.base->gaussians[index];
    const std::array<float,3> covariance{g.covA[0],g.covA[3],g.covB[1]};
    for(size_t axis=0;axis<3;++axis) {
        if(!std::isfinite(g.positionOpacity[axis])||!std::isfinite(covariance[axis]))
            throw std::runtime_error("Invalid transform focus geometry");
        const float extent=3*std::sqrt(std::max(0.f,covariance[axis]));
        const float low=g.positionOpacity[axis]-extent,high=g.positionOpacity[axis]+extent;
        if(!std::isfinite(low)||!std::isfinite(high))throw std::runtime_error("Transform focus bounds exceed float32");
        low_[axis]=std::min(low_[axis],low);high_[axis]=std::max(high_[axis],high);
    }
    selected_=true;
}
double Job::progress() const noexcept {
    if(cancelled_)return 0;if(complete_)return 1;
    return snapshot_.states.empty()?0:double(cursor_)/snapshot_.states.size();
}
} // namespace preview::browser_focus
