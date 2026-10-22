#include "morphology_range_job.hpp"
#include "editing.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace preview::browser_morphology_range {
namespace {
size_t stride(size_t n) {
    if(!n||n>1000000) throw std::invalid_argument("Morphology range needs a bounded Gaussian scene.");
    return (n+maximumSamples-1)/maximumSamples;
}
size_t samples(size_t n) { const auto step=stride(n);return (n+step-1)/step; }
size_t rank(size_t count,unsigned percent) noexcept { return (count*percent+99)/100-1; }
}
size_t Job::scratchBytes(size_t count) { return 36*samples(count); }
Job::Pointer Job::create(std::shared_ptr<const Scene> scene,std::shared_ptr<SceneMemory> memory) {
    if(!memory||!scene||!scene->isGaussian()) throw std::invalid_argument("Morphology range requires an admitted Gaussian scene.");
    stride(scene->gaussians.size());
    AdmittedAllocator<Job> allocator{memory};auto *job=allocator.allocate(1);
    try { std::construct_at(job,std::move(scene),std::move(memory)); }
    catch(...) { allocator.deallocate(job,1);throw; }
    return Pointer(job,Deleter{allocator.memory()});
}
Job::Job(std::shared_ptr<const Scene> scene,std::shared_ptr<SceneMemory> memory)
    : scene_(std::move(scene)),stride_(stride(scene_->gaussians.size())),samples_(samples(scene_->gaussians.size())),
      values_(memory,6*samples_),points_(std::move(memory),samples_) {}
void Job::Deleter::operator()(Job *job) const noexcept {
    if(job) { AdmittedAllocator<Job> allocator{memory};std::destroy_at(job);allocator.deallocate(job,1); }
}
size_t Job::step(size_t maxWork) {
    size_t done=0;
    try { while(done<maxWork&&!complete()&&!cancelled_) { tick();++done; } }
    catch(...) { cancel();throw; }
    return done;
}
void Job::tick() {
    auto values=values_.span();
    if(phase_==Phase::Sample) {
        if(cursor_==samples_) { cursor_=0;phase_=Phase::Sort;return; }
        const auto &g=scene_->gaussians[cursor_*stride_];
        const auto axes=exportAxesRdf(g);
        const float radius=std::exp(*std::max_element(axes.logScales.begin(),axes.logScales.end()));
        if(!std::isfinite(radius)) throw std::runtime_error("Invalid Gaussian morphology radius.");
        for(size_t axis=0;axis<3;++axis) {
            const float point=g.positionOpacity[axis];
            if(!std::isfinite(point)) throw std::runtime_error("Invalid Gaussian morphology center.");
            values[axis*samples_+cursor_]=points_.span()[cursor_][axis]=point;
        }
        values[3*samples_+cursor_]=radius;++cursor_;
    } else if(phase_==Phase::Sort) sortTick();
    else if(phase_==Phase::Distances) {
        if(cursor_==samples_) { array_=4;width_=1;begin_=sortStage_=0;phase_=Phase::Sort;return; }
        const auto point=points_.span()[cursor_];const size_t median=rank(samples_,50);
        values[4*samples_+cursor_]=float(std::hypot(double(point[0])-values[median],
            double(point[1])-values[samples_+median],double(point[2])-values[2*samples_+median]));
        ++cursor_;
    }
}
void Job::sortTick() {
    auto all=values_.span();auto values=all.subspan(array_*samples_,samples_),merge=all.subspan(5*samples_,samples_);
    if(width_>=samples_) { finishSort();return; }
    if(sortStage_==0) {
        if(begin_>=samples_) { width_*=2;begin_=0;return; }
        middle_=std::min(begin_+width_,samples_);end_=std::min(begin_+2*width_,samples_);
        left_=out_=begin_;right_=middle_;sortStage_=1;
    } else if(sortStage_==1) {
        if(out_==end_) { copy_=begin_;sortStage_=2;return; }
        merge[out_++]=right_==end_||(left_!=middle_&&values[left_]<=values[right_])?values[left_++]:values[right_++];
    } else if(copy_!=end_) { values[copy_]=merge[copy_];++copy_; }
    else { begin_=end_;sortStage_=0; }
}
void Job::finishSort() {
    if(array_<3) { ++array_;width_=1;begin_=sortStage_=0; }
    else if(array_==3) { phase_=Phase::Distances;cursor_=0; }
    else {
        const auto values=values_.span();
        const float minimum=std::clamp(values[3*samples_+rank(samples_,5)],.000001f,1e12f);
        const float center=std::clamp(values[4*samples_+rank(samples_,95)],minimum,1e12f);
        const float maximum=2*center;
        result_=Range{minimum,maximum,float(std::sqrt(double(minimum)*maximum))};phase_=Phase::Complete;
    }
}
double Job::progress() const noexcept {
    if(cancelled_) return 0;
    if(phase_==Phase::Complete)return 1;
    if(phase_==Phase::Sample)return .15*double(cursor_)/samples_;
    if(phase_==Phase::Distances)return .7+.1*double(cursor_)/samples_;
    return array_==4?.8:.2+.12*array_;
}
} // namespace preview::browser_morphology_range
