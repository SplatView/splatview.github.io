#include "browser_duplicate.hpp"
#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace preview::browser_duplicate {
std::optional<Range> Lineage::find(const std::shared_ptr<const Scene> &scene) const noexcept {
    if(!scene||!scene->isGaussian())return {};
    for(const auto &entry:entries_)if(entry.scene.lock()==scene)return entry.range;
    return {};
}
bool Lineage::associate(const std::shared_ptr<const Scene> &scene,Range range) noexcept {
    if(!scene||!scene->isGaussian()||!range.count||range.first>scene->gaussians.size()||
       range.count!=scene->gaussians.size()-range.first)return false;
    for(auto &entry:entries_)if(entry.scene.lock()==scene){entry.range=range;return true;}
    for(auto &entry:entries_)if(entry.scene.expired()){entry={scene,range};return true;}
    return false;
}
Job::Job(const SceneEdits &edits,const Lineage &lineage,std::shared_ptr<SceneMemory> work,
         std::shared_ptr<SceneMemory> history)
    :baseline_(BrowserSelectionAccess::capture(edits)),previous_(lineage.find(edits.scene())),
     scope_(BrowserSelectionAccess::selectionView(edits)),work_(std::move(work)),history_(std::move(history)) {
    if(!work_||!history_||!baseline_.scene||!baseline_.scene->isGaussian()||edits.selectionDraft()||
       baseline_.states.size()!=baseline_.scene->gaussians.size()||baseline_.states.size()>sceneLimit)
        throw std::runtime_error("Invalid Duplicate baseline");
    if(!BrowserSelectionAccess::duplicateIdentitiesAvailable(edits))
        throw std::runtime_error("Duplicate identity exhausted");
    if(baseline_.scene->sourceCount<baseline_.states.size()||
       baseline_.scene->sourceCount>std::numeric_limits<uint32_t>::max())
        throw std::runtime_error("Invalid Duplicate source count");
}
void Job::cancel() noexcept {
    if(status_==Status::Published)return;
    result_.reset();states_.clear();status_=Status::Cancelled;phase_=Phase::Terminal;
}
void Job::action() {
    const auto n=baseline_.states.size();
    switch(phase_) {
    case Phase::Count:
        if(cursor_<n) {
            const auto state=baseline_.states[cursor_];
            if(state>2)throw std::runtime_error("Invalid Duplicate mask");
            deleted_+=state==2;selected_+=state==1;
            if(state==1) {
                copies_+=scope_.contains(baseline_.scene->gaussians[cursor_]);
                selectedInPrevious_+=previous_&&cursor_>=previous_->first&&cursor_-previous_->first<previous_->count;
            }
            ++cursor_;break;
        }
        if(!copies_)throw std::runtime_error("No visible selected splats to duplicate");
        if(copies_>sceneLimit-n)throw std::runtime_error("Duplicated scene exceeds the 1 million splat editing limit");
        if(previous_&&selected_==previous_->count&&selectedInPrevious_==previous_->count)
            throw std::runtime_error("Move or edit this copy before duplicating again");
        if(copies_>std::numeric_limits<uint32_t>::max()-baseline_.scene->sourceCount)
            throw std::runtime_error("Duplicate source count overflow");
        phase_=Phase::Allocate;break;
    case Phase::Allocate: {
        const auto &base=*baseline_.scene;
        result_=std::allocate_shared<Scene>(AdmittedAllocator<Scene>{work_},work_);
        // Duplicate adds support already present; keep bounds and camera exact.
        result_->type=base.type;result_->sourceFaces=base.sourceFaces;result_->sampledGeometry=base.sampledGeometry;
        result_->center=base.center;result_->radius=base.radius;result_->previewEye=base.previewEye;result_->defaultView=base.defaultView;
        result_->alignmentFrame=base.alignmentFrame;result_->sourceCount=base.sourceCount+copies_;result_->shDegree=base.shDegree;result_->yUp=base.yUp;
        result_->format=base.format;result_->sourceContentKey=base.sourceContentKey;result_->sourceFileIdentity=base.sourceFileIdentity;result_->sourceBytes=base.sourceBytes;
        result_->gaussians.reserve(n+copies_);
        states_=BrowserSelectionAccess::duplicateMask(n+copies_,history_);
        cursor_=0;phase_=Phase::CopyOriginals;break;
    }
    case Phase::CopyOriginals:
        if(cursor_==n){cursor_=0;phase_=Phase::AppendCopies;break;}
        result_->gaussians.emplace_back();
        static_assert(sizeof(Gaussian)==144&&std::is_trivially_copyable_v<Gaussian>);
        std::memcpy(&result_->gaussians.back(),&baseline_.scene->gaussians[cursor_],sizeof(Gaussian));
        BrowserSelectionAccess::duplicateMaskAppend(states_,uint8_t(baseline_.states[cursor_]&~1u));
        ++cursor_;break;
    case Phase::AppendCopies:
        if(cursor_==n){status_=Status::Ready;phase_=Phase::Ready;break;}
        if(baseline_.states[cursor_]==1&&scope_.contains(baseline_.scene->gaussians[cursor_])) {
            result_->gaussians.emplace_back();
            std::memcpy(&result_->gaussians.back(),&baseline_.scene->gaussians[cursor_],sizeof(Gaussian));
            BrowserSelectionAccess::duplicateMaskAppend(states_,1);
        }
        ++cursor_;break;
    default:break;
    }
}
Status Job::step(size_t maximumWork,std::stop_token stop) {
    lastStepWork_=0;maximumWork=std::min(maximumWork,maximumStepWork);
    try {
        while(lastStepWork_<maximumWork&&status_==Status::Working) {
            if(stop.stop_requested()){cancel();break;}
            action();++lastStepWork_;
        }
    } catch(...) {result_.reset();states_.clear();status_=Status::Failed;phase_=Phase::Terminal;throw;}
    return status_;
}
bool Job::publish(SceneEdits &edits,Lineage &stagedLineage) {
    static_assert(std::is_nothrow_move_assignable_v<Lineage>);
    if(status_!=Status::Ready||!BrowserSelectionAccess::morphologyCurrent(edits,baseline_))
        throw std::runtime_error("Duplicate result is stale");
    auto nextLineage=stagedLineage;
    if(!nextLineage.associate(result_,{baseline_.states.size(),copies_}))
        throw std::runtime_error("Duplicate lineage is full");
    BrowserSelectionAccess::publishDuplicate(edits,baseline_,result_,states_,copies_,deleted_);
    stagedLineage=std::move(nextLineage);status_=Status::Published;phase_=Phase::Terminal;
    result_.reset();states_.clear();return true;
}
} // namespace preview::browser_duplicate
