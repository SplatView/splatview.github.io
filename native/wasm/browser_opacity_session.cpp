// Alpha arithmetic is the captured Windows processing.cpp:984-995 and pinned
// portable core/processing.cpp:692-703 opacity recipe. Absolute entry ownership
// follows captured Viewer::beginOperationSession/autoProcess/resetOperation.
#include "browser_opacity_session.hpp"
#include "admitted_storage.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <stdexcept>

namespace preview::browser_opacity {
bool validScale(float value) noexcept { return std::isfinite(value)&&value>=0&&value<=5; }
float opacity(float alpha,float scale) noexcept {
    return std::clamp(scale<=1?alpha*scale:alpha+(1-alpha)*(scale-1)/2,0.f,1.f);
}
bool valid(const Context &c) noexcept {
    return c.settled&&c.scene&&c.scene->isGaussian()&&!c.scene->gaussians.empty()&&c.scene->gaussians.size()<=1'000'000&&
        c.states.size()==c.scene->gaussians.size()&&c.generation;
}
bool same(const Context &a,const Context &b) noexcept {
    return a.scene==b.scene&&a.states.data()==b.states.data()&&a.states.size()==b.states.size()&&
        a.generation==b.generation&&a.revision==b.revision&&a.contentRevision==b.contentRevision;
}
bool current(const Owner &o,const Context &c) noexcept {
    return valid(c)&&o.base&&o.base->isGaussian()&&o.states.size()==o.base->gaussians.size()&&
        o.states.size()==c.states.size()&&same(o.acknowledged,c);
}
Job::Job(Owner owner,float scale,std::shared_ptr<SceneMemory> memory,bool reset)
    :owner_(std::move(owner)),scale_(scale),memory_(std::move(memory)),reset_(reset) {
    if(!memory_||!validScale(scale_)||!current(owner_,owner_.acknowledged))throw std::runtime_error("Invalid opacity bake owners or scale");
    if(scale_==1)phase_=Phase::Finish; // Restore shares the exact entry; history preparation runs in the pump.
}
void Job::Deleter::operator()(Job *value) noexcept {if(value){value->~Job();AdmittedAllocator<Job>{memory}.deallocate(value,1);}}
Job::Pointer Job::create(const Owner &owner,float scale,std::shared_ptr<SceneMemory> memory,bool reset) {
    if(!memory)throw std::runtime_error("Opacity bake requires admission");AdmittedAllocator<Job> allocator{memory};auto *raw=allocator.allocate(1);
    try {::new(static_cast<void *>(raw)) Job(owner,scale,memory,reset);}catch(...){allocator.deallocate(raw,1);throw;}
    return Pointer(raw,Deleter{std::move(memory)});
}
void Job::retire(Pointer &owner) noexcept {if(owner)owner->cancel();owner.reset();owner.get_deleter().memory.reset();}
void Job::cancel() noexcept {candidate_.reset();result_.reset();status_=Status::Cancelled;phase_=Phase::Cancelled;}
double Job::progress() const noexcept {return status_==Status::Ready?1:double(cursor_)/std::max(size_t(1),owner_.states.size())*.95;}
void Job::action() {
    switch(phase_) {
    case Phase::AllocateScene: {
        const auto &base=*owner_.base;candidate_=std::allocate_shared<Scene>(AdmittedAllocator<Scene>{memory_},memory_);
        candidate_->type=base.type;candidate_->sourceFaces=base.sourceFaces;candidate_->sampledGeometry=base.sampledGeometry;
        candidate_->center=base.center;candidate_->radius=base.radius;candidate_->previewEye=base.previewEye;candidate_->defaultView=base.defaultView;
        candidate_->alignmentFrame=base.alignmentFrame;candidate_->sourceCount=base.sourceCount;candidate_->shDegree=base.shDegree;candidate_->yUp=base.yUp;
        candidate_->format=base.format;candidate_->sourceContentKey=base.sourceContentKey;candidate_->sourceFileIdentity=base.sourceFileIdentity;candidate_->sourceBytes=base.sourceBytes;
        candidate_->gaussians.reserve(owner_.states.size());phase_=Phase::Copy;break;
    }
    case Phase::Copy: {
        auto value=owner_.base->gaussians[cursor_];const auto state=owner_.targetStates()[cursor_];
        if(!(state&2)&&(!owner_.selectedOnly||(state&1)))value.positionOpacity[3]=opacity(value.positionOpacity[3],scale_);
        // Comparing exact accepted bytes makes saturation and empty/deleted
        // scope genuine no-ops, retaining the original scene/history/Redo.
        changed_|=std::memcmp(&value,&owner_.acknowledged.scene->gaussians[cursor_],sizeof(Gaussian))!=0;
        candidate_->gaussians.push_back(value);if(++cursor_==owner_.states.size())phase_=Phase::Finish;break;
    }
    case Phase::Finish:
        result_=scale_==1?owner_.base:changed_?std::shared_ptr<const Scene>{candidate_}:owner_.acknowledged.scene;
        candidate_.reset();status_=Status::Ready;phase_=Phase::Ready;break;
    default:break;
    }
}
Status Job::step(size_t maxWork,std::stop_token stop) {
    lastStepWork_=0;while(lastStepWork_<maxWork&&status_==Status::Working) {
        if(stop.stop_requested()){cancel();break;}action();++lastStepWork_;++workDone_;
    }
    return status_;
}
} // namespace preview::browser_opacity
