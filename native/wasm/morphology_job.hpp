#pragma once
#include "admitted_raw_array.hpp"
#include "selection_checkpoint.hpp"
#include "selection_morphology_job.hpp"
#include <cmath>
#include <memory>
#include <optional>

namespace preview {
class BrowserMorphologyJob final {
    struct ScratchOwner {
        AdmittedRawArray<browser_morphology::Bounds> boxes;
        AdmittedRawArray<uint32_t> order;
        AdmittedRawArray<browser_morphology::Node> nodes;
        AdmittedRawArray<uint32_t> remaining;
        AdmittedRawArray<uint8_t> matched;
        AdmittedRawArray<browser_morphology::Override> result;
        ScratchOwner(std::shared_ptr<SceneMemory> memory,browser_morphology::ScratchRequirements r)
            : boxes(memory,r.gaussians),order(memory,r.gaussians),nodes(memory,r.nodes),
              remaining(memory,r.nodes),matched(memory,r.gaussians),result(std::move(memory),r.gaussians) {}
        browser_morphology::Scratch spans() noexcept {
            return {boxes.span(),order.span(),nodes.span(),remaining.span(),matched.span(),result.span()};
        }
    };
  public:
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(BrowserMorphologyJob *owner) noexcept;
    };
    using Pointer=std::unique_ptr<BrowserMorphologyJob,Deleter>;
    static Pointer create(const SceneEdits &edits,bool grow,float sigma,std::shared_ptr<SceneMemory> memory,browser_view_scope::Scope scope={},browser_morphology::Method method=browser_morphology::Method::Sigma) {
        if(!memory) throw std::invalid_argument("Morphology requires an admission service");
        if(!edits.scene() || !edits.scene()->isGaussian() || edits.selectionDraft())
            throw std::runtime_error("Selection morphology requires a settled Gaussian scene");
        if(method!=browser_morphology::Method::Sigma&&method!=browser_morphology::Method::Volume)
            throw std::invalid_argument("Invalid morphology method.");
        if(!std::isfinite(sigma) || (method==browser_morphology::Method::Volume ? sigma<=0 :
            sigma<browser_morphology::minimumSigma || sigma>browser_morphology::maximumSigma))
            throw std::invalid_argument("Invalid selection reach.");
        AdmittedAllocator<BrowserMorphologyJob> allocator{memory};
        auto *owner=allocator.allocate(1);
        try { std::construct_at(owner,edits,grow,sigma,std::move(memory),scope,method); }
        catch(...) { allocator.deallocate(owner,1); throw; }
        return Pointer(owner,Deleter{allocator.memory()});
    }
    // Public only for standard construct_at; callers use create() so this owner
    // reaches its final stable admitted address before the borrowing Job exists.
    BrowserMorphologyJob(const SceneEdits &edits,bool grow,float sigma,std::shared_ptr<SceneMemory> memory,browser_view_scope::Scope scope={},browser_morphology::Method method=browser_morphology::Method::Sigma)
        : baseline_(BrowserSelectionAccess::capture(edits)),
          scopedStates_(scope.enabled?browser_view_scope::effective(*baseline_.scene,baseline_.states,scope,memory,false,true):MaskStorage{}),
          scope_(scope),
          scratch_(std::move(memory),browser_morphology::scratchRequirements(baseline_.states.size())) {
        algorithm_.emplace(std::span<const Gaussian>{baseline_.scene->gaussians},
            scopedStates_.hasStorage()?scopedStates_.span():baseline_.states.span(),grow,scratch_.spans(),sigma,method);
    }
    BrowserMorphologyJob(const BrowserMorphologyJob &)=delete;
    BrowserMorphologyJob &operator=(const BrowserMorphologyJob &)=delete;
    const BrowserSelectionCheckpoint &baseline() const noexcept { return baseline_; }
    size_t step(size_t work) {
        size_t done=0;
        if(!algorithm_->complete())done=algorithm_->step(work);
        if(!scope_.enabled||!algorithm_->complete())return done;
        // Reuse existing admitted arrays after the algorithm has finished.
        // First map its sorted sparse result, then rebuild against ORIGINAL
        // states so outside selections clear without becoming deleted geometry.
        while(done<work&&finishPhase_<3) {
            if(finishPhase_==0) {
                if(finishCursor_<baseline_.states.size())scratch_.matched.span()[finishCursor_++]=0;
                else {finishPhase_=1;finishCursor_=0;}
            } else if(finishPhase_==1) {
                const auto changes=algorithm_->result();
                if(finishCursor_<changes.size()) {const auto c=changes[finishCursor_++];scratch_.matched.span()[c.index]=uint8_t(c.value+1);}
                else {finishPhase_=2;finishCursor_=0;}
            } else if(finishCursor_<baseline_.states.size()) {
                const size_t i=finishCursor_++;const auto before=baseline_.states[i];auto after=before;
                if(before!=2)after=!scope_.contains(baseline_.scene->gaussians[i])?0:
                    scratch_.matched.span()[i]?uint8_t(scratch_.matched.span()[i]-1):before;
                if(after!=before)scratch_.result.span()[finalCount_++]={uint32_t(i),after};
            } else finishPhase_=3;
            ++done;
        }
        return done;
    }
    void cancel() noexcept { algorithm_->cancel(); }
    bool complete() const noexcept { return algorithm_->complete()&&(!scope_.enabled||finishPhase_==3); }
    std::span<const browser_morphology::Override> result() const noexcept {
        if(scope_.enabled)return complete()?std::span<const browser_morphology::Override>{scratch_.result.span().data(),finalCount_}:std::span<const browser_morphology::Override>{};
        return algorithm_->result();
    }
    double progress() const noexcept {
        using browser_morphology::Phase;
        switch(algorithm_->phase()) {
            case Phase::Count: return 0.;
            case Phase::Bounds: return .1;
            case Phase::Build: return .2;
            case Phase::Remaining: return .5;
            case Phase::Query: return .6;
            case Phase::Publish: return .9;
            case Phase::Complete: return 1.;
            case Phase::Cancelled: case Phase::Failed: return 0.;
        }
        return 0.;
    }
  private:
    BrowserSelectionCheckpoint baseline_;
    MaskStorage scopedStates_;
    browser_view_scope::Scope scope_;
    ScratchOwner scratch_;
    size_t finishCursor_{},finalCount_{};
    unsigned finishPhase_{};
    // Destroyed before scratch and the borrowed baseline/scene owner.
    std::optional<browser_morphology::Job> algorithm_;
};
inline void BrowserMorphologyJob::Deleter::operator()(BrowserMorphologyJob *owner) noexcept {
    if(owner) {
        AdmittedAllocator<BrowserMorphologyJob> allocator{memory};
        std::destroy_at(owner); allocator.deallocate(owner,1);
    }
}
#if defined(__wasm32__)
// Keep the browser admission estimate tied to the actual target owner layout.
static_assert(sizeof(BrowserMorphologyJob)<=6280);
static_assert(sizeof(browser_morphology::Job)==6024);
static_assert(sizeof(browser_morphology::Bounds)==24 && sizeof(browser_morphology::Node)==40 &&
              sizeof(browser_morphology::Override)==8);
#endif
} // namespace preview
