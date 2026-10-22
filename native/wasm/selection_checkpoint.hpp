#pragma once
#include "editing.hpp"
#include "selection_morphology_job.hpp"
#include "operation_receipt.hpp"
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace preview {
// The immutable baseline is shared/admitted by the portable mask owner. This
// checkpoint belongs to the browser adapter, not the frozen desktop package.
struct BrowserSelectionCheckpoint {
    MaskStorage states;
    std::shared_ptr<const Scene> scene;
    uint64_t revision{}, contentRevision{};
    bool recorded{};
};

// A single explicit friend is injected into the disposable editing.hpp overlay.
// This ports Windows adjustSelection while keeping the portable allocator,
// copy-on-write mask, native history and exception-safe publication discipline.
struct BrowserSelectionAccess {
    static void selectionView(SceneEdits &e,browser_view_scope::Scope scope) noexcept { e.selectionView_=scope; }
    static const browser_view_scope::Scope &selectionView(const SceneEdits &e) noexcept { return e.selectionView_; }
    static bool eligible(const SceneEdits &e,size_t i) noexcept { return i<e.states_.size()&&e.scopeContains(i); }
    static bool clipSelection(SceneEdits &e) {
        SceneEdits::Changes changes{AdmittedAllocator<SceneEdits::Change>{e.historyMemory_}};
        for(size_t i=0;i<e.states_.size();++i)if(e.states_[i]==1&&!e.scopeContains(i))changes.push_back({uint32_t(i),1,0});
        return e.commit(std::move(changes));
    }
    // Exact browser recovery access. These aliases expose fields deliberately;
    // the wire codec never serializes the C++ objects or their padding.
    using RecoveryChange=SceneEdits::Change;
    using RecoveryRevision=SceneEdits::Revision;
    static const auto &recoveryUndo(const SceneEdits &e) noexcept { return e.undo_; }
    static const auto &recoveryRedo(const SceneEdits &e) noexcept { return e.redo_; }
    static uint64_t recoveryNextContent(const SceneEdits &e) noexcept { return e.nextContentRevision_; }
    static std::shared_ptr<const Scene> historyScene(const SceneEdits &e,bool forward) noexcept {
        return e.historyScene(forward);
    }
    // Prepare this only on an unpublished SceneEdits candidate. Reuse the
    // portable replacement's complete allocation/counter/history discipline,
    // then assign the desktop restored-content identity to that new entry.
    // All post-replacement writes are nonthrowing and no intermediate state
    // escapes. Restoring an older identity does not consume a content ID.
    static bool restoreContentScene(SceneEdits &e,std::shared_ptr<const Scene> scene,
                                    const MaskStorage &states,uint64_t content) {
        if(content>e.nextContentRevision_)throw std::runtime_error("Invalid restored content identity");
        const bool different=scene!=e.scene_;const auto nextContent=e.nextContentRevision_;
        const bool result=e.replaceScene(std::move(scene),states.span());
        if(different) {
            e.undo_.back().afterContent=content;e.contentRevision_=content;e.nextContentRevision_=nextContent;
        }
        return result;
    }
    static const void *recoveryMaskOwner(const MaskStorage &mask) noexcept { return mask.data_.get(); }
    static MaskStorage recoveryMask(const SceneEdits &e) noexcept { return e.draftStates_?*e.draftStates_:e.states_; }
    static uint64_t recoveryRevision(const SceneEdits &e) noexcept {
        return e.revision_+uint64_t(e.draftStates_&&e.states_!=*e.draftStates_);
    }
    static std::unique_ptr<SceneEdits> recoveryCreate(std::shared_ptr<const Scene> scene,MaskStorage states,
        std::shared_ptr<SceneMemory> history,std::shared_ptr<SceneMemory> scratch,
        uint64_t revision,uint64_t content,uint64_t next) {
        auto out=std::make_unique<SceneEdits>(std::move(scene),std::move(history),std::move(scratch));
        out->states_=std::move(states);out->revision_=revision;out->contentRevision_=content;
        // The committed-selection notification belongs to this worker lifetime;
        // restoring durable content/history deliberately starts it at zero.
        out->nextContentRevision_=next;out->recount();return out;
    }
    static void recoveryAppend(SceneEdits &e,bool redo,std::span<const RecoveryChange> changes,
        std::shared_ptr<const Scene> before,std::shared_ptr<const Scene> after,
        MaskStorage beforeStates,MaskStorage afterStates,uint64_t beforeContent,uint64_t afterContent) {
        SceneEdits::Changes owned{AdmittedAllocator<RecoveryChange>{e.historyMemory_}};
        owned.reserve(changes.size());owned.assign(changes.begin(),changes.end());
        auto &stack=redo?e.redo_:e.undo_;
        stack.push_back({std::move(owned),std::move(before),std::move(after),std::move(beforeStates),
            std::move(afterStates),beforeContent,afterContent});
        // Creation/amendment stamps are worker-lifetime UI state. Restored
        // history remains usable, but starts outside a newly armed tool session.
    }
    template<class Visit> static void retainedScenes(const SceneEdits &edits,Visit visit) noexcept {
        visit(edits.scene_);
        for(const auto &revision:edits.undo_) { if(revision.before) visit(revision.before);if(revision.after) visit(revision.after); }
        for(const auto &revision:edits.redo_) { if(revision.before) visit(revision.before);if(revision.after) visit(revision.after); }
    }
    static bool flood(SceneEdits &,const Camera &,unsigned width,unsigned height,PointI seed,float tolerance,
                      SelectOperation,SelectionOptions,const SelectionMap &,
                      std::span<const float> colors = {},std::stop_token = {});
    // Evaluate absolute gesture updates in an admitted temporary draft. This
    // avoids mutating a previous live preview before sampling/intersection and
    // every throwing allocation finish. Only replaceScene publishes the mask.
    static SceneEdits selectionCandidate(const SceneEdits &edits,bool fromBaseline) {
        if(fromBaseline && !edits.draftStates_) throw std::runtime_error("No selection gesture is active");
        SceneEdits candidate(edits.scene_,edits.historyMemory_,edits.scratchMemory_);
        candidate.states_=fromBaseline ? *edits.draftStates_ : edits.states_;
        candidate.selectionCommitRevision_=edits.selectionCommitRevision_;
        candidate.selectionView_=edits.selectionView_;
        candidate.recount(); candidate.beginSelectionDraft();
        return candidate;
    }
    static SceneEdits checkpointCandidate(const SceneEdits &edits,const BrowserSelectionCheckpoint &checkpoint) {
        SceneEdits candidate(edits.scene_,edits.historyMemory_,edits.scratchMemory_);
        candidate.states_=checkpoint.states;
        candidate.selectionCommitRevision_=edits.selectionCommitRevision_;
        candidate.selectionView_=edits.selectionView_;
        candidate.recount(); candidate.beginSelectionDraft();
        return candidate;
    }
    static BrowserSelectionCheckpoint capture(const SceneEdits &edits) noexcept {
        return {edits.states_,edits.scene_,edits.revision_,edits.contentRevision_,false};
    }
    static bool current(const SceneEdits &edits,const BrowserSelectionCheckpoint &checkpoint) noexcept {
        return !edits.draftStates_ && checkpoint.scene==edits.scene_ && checkpoint.revision==edits.revision_ &&
            checkpoint.contentRevision==edits.contentRevision_ && checkpoint.states.size()==edits.states_.size() &&
            (!checkpoint.recorded || !edits.undo_.empty());
    }
    // The exclusive worker rejects all ordinary edits while the job runs. These
    // identities also reject delayed publication after rollback/replacement or
    // a draft, including a different mask owner with coincident scalar counts.
    static bool morphologyCurrent(const SceneEdits &edits,const BrowserSelectionCheckpoint &baseline) noexcept {
        return current(edits,baseline) && !baseline.recorded && baseline.states.data()==edits.states_.data();
    }
    static bool duplicateIdentitiesAvailable(const SceneEdits &edits) noexcept {
        // Both counters advance once. Refuse before allocating candidates, and
        // recheck before history so the successor remains exactly representable
        // by the existing browser receipt/checkpoint identity policy.
        return edits.revision_<sv_operation::maximumIdentity &&
            edits.selectionCommitRevision_<sv_operation::maximumIdentity &&
            edits.nextContentRevision_<sv_operation::maximumIdentity &&
            edits.contentRevision_<=edits.nextContentRevision_;
    }
    // Duplicate owns a growing private mask. Reserve admits physical capacity
    // without an O(N) zero fill; the cooperative job appends one byte per tick.
    static MaskStorage duplicateMask(size_t count,std::shared_ptr<SceneMemory> history) {
        MaskStorage out;
        out.data_=std::make_shared<MaskStorage::Data>(std::move(history));
        out.data_->bytes.reserve(count);return out;
    }
    static void duplicateMaskAppend(MaskStorage &mask,uint8_t state) {
        assert(mask.unique()&&mask.size()<mask.capacity()&&state<=2);
        mask.data_->bytes.push_back(state);
    }
    // Trusted completed job has already validated every record/mask and counted
    // selected/deleted bytes cooperatively. Full history supports different
    // before/after cardinalities; no synchronous N-byte copy/recount is needed.
    static void publishDuplicate(SceneEdits &edits,const BrowserSelectionCheckpoint &baseline,
        std::shared_ptr<const Scene> scene,MaskStorage states,size_t copies,size_t deleted) {
        constexpr auto maximumSourceCount=std::numeric_limits<uint32_t>::max();
        if(!morphologyCurrent(edits,baseline)||!duplicateIdentitiesAvailable(edits)||!scene||!scene->isGaussian()||!copies||
           baseline.states.size()>1'000'000||copies>1'000'000-baseline.states.size()||
           scene->gaussians.size()!=baseline.states.size()+copies||states.size()!=scene->gaussians.size()||
           deleted>baseline.states.size()||baseline.scene->sourceCount>maximumSourceCount||
           copies>maximumSourceCount-baseline.scene->sourceCount||
           scene->sourceCount!=baseline.scene->sourceCount+copies)
            throw std::runtime_error("Invalid Duplicate publication");
        const auto next=edits.nextContentRevision_+1;
        SceneEdits::Revision revision{SceneEdits::Changes{AdmittedAllocator<SceneEdits::Change>{edits.historyMemory_}},
            edits.scene_,scene,edits.states_,states,edits.contentRevision_,next};
        std::optional<SceneEdits::Revision> noDraft;
        edits.appendHistory(revision,noDraft);
        // appendHistory is the final throwing operation; the following owner
        // swaps preserve all old owners/revisions until this point.
        edits.scene_=std::move(scene);edits.states_=std::move(states);
        edits.selected_=copies;edits.deleted_=deleted;
        edits.redo_.clear();edits.trimHistory();
        edits.nextContentRevision_=edits.contentRevision_=next;++edits.revision_;
        ++edits.selectionCommitRevision_;
    }
    // Filter drafts and geometric gestures share portable storage, but their
    // browser owners are distinct. Never infer filter ownership from draftStates.
    static bool filterCurrent(const SceneEdits &edits,const BrowserSelectionCheckpoint &baseline,
                              uint64_t acknowledgedRevision) noexcept {
        return edits.draftStates_ && edits.scene_==baseline.scene &&
            edits.contentRevision_==baseline.contentRevision && edits.revision_==acknowledgedRevision &&
            edits.states_.size()==baseline.states.size() && edits.draftStates_->data()==baseline.states.data();
    }
    // Called on a private SceneEdits candidate. This is the portable same-scene
    // selection-only draft replacement with exact delta admission rather than
    // geometric vector growth. The current owner/history are never mutated here.
    static bool replaceFilterPreview(SceneEdits &candidate,const BrowserSelectionCheckpoint &baseline,
                                     uint64_t acknowledgedRevision,std::span<const uint8_t> states) {
        if(!filterCurrent(candidate,baseline,acknowledgedRevision) || states.size()!=baseline.states.size())
            throw std::runtime_error("Selection filter is stale");
        size_t changed=0;
        for(size_t i=0;i<states.size();++i) {
            if(states[i]>2 || ((states[i]^baseline.states[i])&2))
                throw std::runtime_error("Selection filter changed a deleted splat");
            changed+=states[i]!=candidate.states_[i];
        }
        if(!changed) return false;
        SceneEdits::Changes changes{AdmittedAllocator<SceneEdits::Change>{candidate.historyMemory_}};
        changes.reserve(changed);
        for(size_t i=0;i<states.size();++i) if(states[i]!=candidate.states_[i])
            changes.push_back({uint32_t(i),candidate.states_[i],states[i]});
        return candidate.commit(std::move(changes));
    }
    static bool publishMorphology(SceneEdits &edits,const BrowserSelectionCheckpoint &baseline,
                                  std::span<const browser_morphology::Override> result) {
        if(!morphologyCurrent(edits,baseline)) throw std::runtime_error("Selection morphology is stale");
        uint32_t previous=0;
        bool first=true;
        for(const auto &change:result) {
            if(change.index>=baseline.states.size() || (!first && change.index<=previous) || change.value>1)
                throw std::runtime_error("Invalid selection morphology result");
            const auto before=baseline.states[change.index];
            if((before&2) || before>2 || edits.states_[change.index]!=before || before==change.value ||
               ((before^change.value)&2))
                throw std::runtime_error("Selection morphology changed a deleted or stale splat");
            previous=change.index; first=false;
        }
        // Empty diffs preserve exact Undo/Redo, owner identity and revisions.
        if(result.empty()) return false;
        static_assert(sizeof(SceneEdits::Change)==8);
        SceneEdits::Changes changes{AdmittedAllocator<SceneEdits::Change>{edits.historyMemory_}};
        changes.reserve(result.size());
        for(const auto &change:result)
            changes.push_back({change.index,baseline.states[change.index],change.value});
        // The existing native commit stages COW/history before its no-throw
        // publication and changes only selection revision, not content revision.
        return edits.commit(std::move(changes));
    }
    struct Adjustment {
        bool changed{},canUndo{},canRedo{};
        size_t selected{};
        uint64_t revision{},selectionCommitRevision{};
        bool recorded{};
        uint64_t undoSelectionRevision{};
    };
    static bool adjust(SceneEdits &edits,BrowserSelectionCheckpoint &checkpoint,std::span<const uint8_t> states) {
        return adjust(edits,checkpoint,states,[](const Adjustment &) noexcept {});
    }
    // The caller can preflight its bounded reply after all mask/delta staging,
    // before changing history, the checkpoint, or live mask. A thrown callback
    // preserves every old owner; a no-op still acknowledges copied metadata.
    template<class Prepare> static bool adjust(SceneEdits &edits,BrowserSelectionCheckpoint &checkpoint,
                                              std::span<const uint8_t> states,Prepare prepare) {
        if(!current(edits,checkpoint) || states.size()!=edits.states_.size()) return false;
        size_t currentCount=0,originalCount=0,selected=0;
        for(size_t i=0;i<states.size();++i) {
            if(states[i]>2 || ((states[i]^checkpoint.states[i])&2)) return false;
            currentCount+=edits.states_[i]!=states[i];
            originalCount+=checkpoint.states[i]!=states[i];
            selected+=(states[i]&1)!=0;
        }
        Adjustment result{bool(currentCount),edits.canUndo(),edits.canRedo(),selected,
            edits.revision(),edits.selectionCommitRevision(),checkpoint.recorded,edits.undoSelectionRevision()};
        if(!currentCount) {prepare(result);return false;}
        // apply() performs the single no-throw notification. Prove its capacity
        // before changing the amended history entry, deque, or live mask owner.
        edits.requireSelectionCommits(1);
        using Changes=SceneEdits::Changes;
        static_assert(std::is_nothrow_move_assignable_v<Changes>);
        Changes current{AdmittedAllocator<SceneEdits::Change>{edits.historyMemory_}};
        Changes original{AdmittedAllocator<SceneEdits::Change>{edits.historyMemory_}};
        // Exact reservations avoid doubling delta capacity during large updates.
        // Every throwing allocation completes before touching history or states.
        current.reserve(currentCount); original.reserve(originalCount);
        for(size_t i=0;i<states.size();++i) {
            if(edits.states_[i]!=states[i]) current.push_back({uint32_t(i),edits.states_[i],states[i]});
            if(checkpoint.states[i]!=states[i]) original.push_back({uint32_t(i),checkpoint.states[i],states[i]});
        }
        auto writable=edits.states_.copyForWriteIfShared();
        result.canUndo=checkpoint.recorded ? originalCount!=0||edits.undo_.size()>1 : originalCount!=0||edits.canUndo();
        result.recorded=originalCount!=0;
        const auto nextStamp=originalCount?edits.nextSelectionHistoryRevision():0;
        result.undoSelectionRevision=originalCount?nextStamp:checkpoint.recorded?
            (edits.undo_.size()>1?edits.undo_[edits.undo_.size()-2].selectionRevision:0):edits.undoSelectionRevision();
        if(!checkpoint.recorded&&originalCount)result.canRedo=false;
        ++result.revision;++result.selectionCommitRevision;
        prepare(result);
        if(checkpoint.recorded) {
            if(original.empty()) {
                edits.undo_.pop_back();
                checkpoint.recorded=false;
            } else {edits.undo_.back().changes=std::move(original);edits.undo_.back().selectionRevision=nextStamp;}
        } else if(!original.empty()) {
            // The deque append is the final potentially throwing operation.
            edits.undo_.push_back(SceneEdits::Revision{std::move(original),{},{},{},{},
                edits.contentRevision_,edits.contentRevision_,nextStamp});
            edits.redo_.clear(); edits.trimHistory(); checkpoint.recorded=true;
        }
        if(writable.hasStorage()) edits.states_.swap(writable);
        edits.apply(current,true);
        checkpoint.revision=++edits.revision_;
        return true;
    }
};
} // namespace preview
