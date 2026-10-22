#include "browser_color_session.hpp"
#include "allocation_census.hpp"
#include <array>
#include <cstdlib>
#include <iostream>
#include <new>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace { bool observed{}; size_t allocations{}, assertions{}, suites{}; }
#ifndef SV_ALLOCATION_CENSUS_CONTRACTS
void *operator new(size_t bytes) {
    if (observed) ++allocations;
    if (auto *p = std::malloc(bytes ? bytes : 1)) return p;
    throw std::bad_alloc();
}
void *operator new[](size_t bytes) { return ::operator new(bytes); }
void operator delete(void *p) noexcept { std::free(p); }
void operator delete[](void *p) noexcept { std::free(p); }
void operator delete(void *p, size_t) noexcept { std::free(p); }
void operator delete[](void *p, size_t) noexcept { std::free(p); }
#else
namespace {
void allocationObserved(const sv_allocation::Event &event) noexcept {
    if(observed && event.kind==sv_allocation::EventKind::NewAttempt) ++allocations;
}
}
#endif
namespace {
using namespace preview;
namespace cm = preview::browser_color_metadata;
void require(bool condition, const char *message) {
    ++assertions;
    if (!condition) throw std::runtime_error(message);
}
class Memory final : public SceneMemory {
  public:
    std::shared_ptr<void> admit(size_t bytes) override {
        live += bytes;
        return std::shared_ptr<void>(this, [this, bytes](void *) noexcept { live -= bytes; });
    }
    size_t live{};
};
cm::Context context(size_t n = 3) {
    auto memory = std::make_shared<Memory>();
    auto scene = std::make_shared<Scene>(memory); scene->gaussians.resize(n);
    std::vector<uint8_t> mask(n); if (n) mask[0] = 1;
    return {scene, MaskStorage::copy(mask, memory), 101, 11, 3, 2, true};
}
ColorValues warm() { auto values = neutralColor; values[0]=1.2f; values[5]=.15f; values[6]=-.2f; return values; }
cm::Context published(const cm::Context &before, std::shared_ptr<const Scene> scene) {
    auto after = before; after.scene = std::move(scene); ++after.revision; ++after.contentRevision; return after;
}
std::shared_ptr<const Scene> equivalent(const cm::Context &before) {
    // Same packed bytes but a distinct native scene identity; no grading kernel
    // or invented history implementation is involved in this contract.
    return std::make_shared<Scene>(*before.scene);
}
cm::Request captured(const cm::Capture &result) {
    require(result.disposition == cm::CaptureDisposition::Captured && bool(result.request), "Expected captured request");
    return *result.request;
}
void ownedBaselineAndAbsoluteValues() {
    ++suites;
    auto before = context(); cm::BrowserColorSession session; cm::IdSequence ids;
    const auto grade = warm(); const auto mask = before.states.data();
    const auto allocationStart = allocations;
    observed = true;
    const bool previewed = session.preview(before, grade, true, ids);
    const auto capture = session.captureManual(before, ids);
    const auto saved = session.snapshot();
    observed = false;
    require(previewed && allocations == allocationStart, "Metadata preview/capture/snapshot allocated");
    const auto request = captured(capture);
    require(session.base() == before.scene && request.base == before.scene, "Session failed to retain original base");
    require(request.states.data() == mask && session.selectedOnly(), "Session copied or lost source mask/scope");
    require(session.values() == grade && session.appliedValues() == neutralColor && session.manualPending(), "Absolute preview metadata differs");
    auto after = published(before, equivalent(before));
    const auto proposal = session.plan(request, before, grade);
    require(proposal && proposal->scenePolicy == cm::ScenePolicy::NewWritableScene && proposal->sceneReplacementRequired,
            "Nonneutral grade did not require native scene identity replacement");
    require(session.markApplied(request, before, after, grade, true), "Published grade metadata was refused");
    require(session.base() == before.scene && session.values() == grade && session.appliedValues() == grade && !session.manualPending(),
            "Successful bake replaced base or reset absolute slider values");
    require(session.captureManual(after, ids).disposition == cm::CaptureDisposition::ManualNoop, "Equal applied manual values did not skip");
    const auto automatic = captured(session.captureAuto(after, cm::Method::Enhance, true, ids));
    require(automatic.base == before.scene && automatic.expectedCurrentScene == after.scene,
            "Repeated Auto compounded current baked scene");
    require(automatic.key.baseContentRevision == before.contentRevision && automatic.key.contentRevision == after.contentRevision,
            "Original base and current document content identities were conflated");
    const auto autoPlan = session.plan(automatic, after, grade);
    require(autoPlan && autoPlan->sceneReplacementRequired && !autoPlan->preserveRedoIfSameOwners,
            "Equal-value explicit Auto was wrongly classified as manual no-op");
    const auto sameBytes = published(after, equivalent(after));
    require(session.markApplied(automatic, after, sameBytes, grade, true), "Same-byte nonneutral scene identity replacement refused");
    require(session.base() == before.scene, "Auto lost original absolute baseline after second bake");
    require(session.end(sameBytes, ids) == cm::EndDisposition::Ended, "Settled session did not end");
    require(!session.active() && session.values() == neutralColor && session.appliedValues() == neutralColor,
            "End did not release/neutralize metadata");
    require(session.preview(sameBytes, grade, false, ids) && session.base() == sameBytes.scene,
            "Next session did not capture latest document as new base");
    (void)saved;
}
void neutralRestorationAndTrueNoop() {
    ++suites;
    auto before = context(); cm::BrowserColorSession session; cm::IdSequence ids;
    require(session.preview(before, warm(), false, ids), "Preview failed");
    const auto first = captured(session.captureManual(before, ids));
    const auto baked = published(before, equivalent(before));
    require(session.markApplied(first,before,baked,warm(),true), "First bake acknowledgment failed");
    require(session.preview(baked, neutralColor, false, ids), "Reset preview failed");
    const auto reset = captured(session.captureManual(baked, ids));
    const auto resetPlan = session.plan(reset,baked,neutralColor);
    require(resetPlan && resetPlan->scenePolicy == cm::ScenePolicy::RetainBase && resetPlan->sceneReplacementRequired,
            "Neutral restoration incorrectly treated as universal no-op");
    auto restored = published(baked,before.scene);
    require(session.markApplied(reset,baked,restored,neutralColor,true), "Neutral base restoration acknowledgment failed");
    require(session.base() == before.scene && !session.manualPending(), "Neutral reset lost session state");
    const auto automatic = captured(session.captureAuto(restored, cm::Method::Exposure, false, ids));
    const auto neutralPlan = session.plan(automatic,restored,neutralColor);
    require(neutralPlan && !neutralPlan->sceneReplacementRequired && neutralPlan->preserveRedoIfSameOwners,
            "True same-owner neutral Auto result did not preserve no-op flag");
    require(session.markApplied(automatic,restored,restored,neutralColor,true), "True same-owner completion rejected");
    require(session.captureManual(restored,ids).disposition == cm::CaptureDisposition::ManualNoop,
            "Manual neutral equal-applied no-op not retained");
}
void manualNewerPreviewAndAutoFence() {
    ++suites;
    auto before = context(); cm::BrowserColorSession session; cm::IdSequence ids;
    require(session.preview(before,warm(),false,ids), "Preview failed");
    const auto older = captured(session.captureManual(before,ids));
    auto newer = warm(); newer[0]=1.4f;
    require(session.preview(before,newer,false,ids), "Manual worker should allow a newer absolute preview");
    const auto after = published(before,equivalent(before));
    require(session.markApplied(older,before,after,warm(),true), "Older manual bake should acknowledge its captured grade");
    require(session.values() == newer && session.appliedValues() == warm() && session.manualPending(),
            "Manual completion discarded newer preview or misstated baked values");
    require(session.end(after,ids) == cm::EndDisposition::NeedsBake, "End silently discarded newer unbaked preview");
    require(session.end(after,ids,true) == cm::EndDisposition::PreserveNewerPointerPreview,
            "Deferred pointer boundary did not retain newer preview");
    const auto next = captured(session.captureManual(after,ids));
    require(session.end(after,ids) == cm::EndDisposition::WaitForJob, "End ignored pending job");
    require(session.cancel(next,after,ids), "Manual cancellation refused");
    require(session.values() == session.appliedValues() && !session.jobPending(), "Cancellation failed to restore applied grade");
    const auto automatic = captured(session.captureAuto(after,cm::Method::WhiteBalance,false,ids));
    require(!session.preview(after,newer,false,ids) && session.failure() == cm::Failure::Busy,
            "Manual preview raced automatic merge/result ownership");
    require(session.cancel(automatic,after,ids), "Auto cancellation refused");
    require(!session.current(automatic,after) && !session.plan(automatic,after,warm()), "Cancelled Auto was publishable");
}
void staleAndInvalidPublication() {
    ++suites;
    for (size_t variation=0;variation<8;++variation) {
        auto before=context(); cm::BrowserColorSession session; cm::IdSequence ids;
        require(session.preview(before,warm(),false,ids), "Preview failed");
        const auto request=captured(session.captureManual(before,ids)); auto stale=before;
        switch(variation) {
        case 0: ++stale.documentId;break; case 1:++stale.sourceGeneration;break; case 2:++stale.revision;break;
        case 3:++stale.contentRevision;break; case 4:stale.scene=equivalent(before);break;
        case 5:stale.states=before.states.clone();break; case 6:stale.states.clear();break; case 7:stale.settled=false;break;
        }
        require(!session.current(request,stale), "Stale context accepted");
        require(!session.cancel(request,stale,ids), "Stale request cancellation changed current metadata");
        require(session.values()==warm() && session.jobPending(), "Stale refusal mutated current request/values");
        session.abandon();
    }
    auto before=context();cm::BrowserColorSession session;cm::IdSequence ids;
    require(session.preview(before,warm(),false,ids), "Preview failed");
    const auto request=captured(session.captureManual(before,ids));
    auto after=published(before,equivalent(before));
    require(!session.markApplied(request,before,after,warm(),false), "Uncertified mask publication accepted");
    require(!session.markApplied(request,before,before,warm(),true), "Nonneutral publication reused same scene identity");
    auto invalidGrade=warm();invalidGrade[0]=1.3f;
    require(!session.markApplied(request,before,after,invalidGrade,true), "Manual completion changed captured grade");
    auto wrongRevision=after;wrongRevision.revision=before.revision;
    require(!session.markApplied(request,before,wrongRevision,warm(),true), "Replacement with unchanged edit revision accepted");
    auto wrongContent=after;wrongContent.contentRevision=before.contentRevision;
    require(!session.markApplied(request,before,wrongContent,warm(),true), "Replacement with unchanged content identity accepted");
    require(session.markApplied(request,before,after,warm(),true), "Valid publication lost after invalid acknowledgments");
    const auto automatic=captured(session.captureAuto(after,cm::Method::Exposure,false,ids));
    auto unowned=warm();unowned[2]=1.2f;
    require(!session.plan(automatic,after,unowned) && session.failure()==cm::Failure::InvalidValues,
            "Auto acknowledgment overwrote a current unowned slider");
    auto owned=warm();owned[0]=.8f;
    require(bool(session.plan(automatic,after,owned)), "Auto owned-field result refused");
    require(session.cancel(automatic,after,ids), "Owned-field guard cleanup failed");
}
void transactionRollbackAndAba() {
    ++suites;
    auto original=context();cm::BrowserColorSession session;cm::IdSequence ids;
    require(session.preview(original,warm(),false,ids), "Preview failed");
    const auto originalSession=session.sessionId(), originalBase=session.baseId();
    require(session.beginTransaction() && !session.beginTransaction(), "Nested metadata transaction accepted");
    const auto automatic=captured(session.captureAuto(original,cm::Method::Contrast,false,ids));
    auto candidate=warm();candidate[1]=1.5f;
    auto after=published(original,equivalent(original));
    require(session.markApplied(automatic,original,after,candidate,true), "Transaction candidate metadata apply failed");
    require(session.rollbackTransaction(ids), "Metadata rollback failed");
    // The harness supplies the restored Context; it does not restore SceneEdits,
    // native history, GPU buffers or pretend rollback of those is solved.
    require(session.sessionId()==originalSession && session.baseId()==originalBase && session.base()==original.scene,
            "Rollback lost retained original session owners");
    require(session.values()==warm() && session.appliedValues()==neutralColor && session.manualPending(),
            "Rollback did not restore original pending preview/applied values");
    require(!session.current(automatic,original), "Pre-rollback request became current again");
    const auto retried=captured(session.captureAuto(original,cm::Method::Contrast,false,ids));
    require(retried.key.epochId!=automatic.key.epochId && retried.key.requestId>automatic.key.requestId,
            "Rollback rewound identity source or allowed ABA");
    require(!session.markApplied(automatic,original,after,candidate,true), "Old successful result replayed after rollback");
    require(session.cancel(retried,original,ids), "Retried request cancel failed");
    require(session.beginTransaction(), "Second transaction failed");
    require(session.preview(original,candidate,false,ids), "New transaction preview failed");
    const auto manual=captured(session.captureManual(original,ids));
    require(!session.commitTransaction(), "Transaction committed before pending color request settled");
    require(session.rollbackTransaction(ids), "Pending-job rollback failed");
    require(!session.current(manual,original) && !session.jobPending(), "Rollback retained an abandoned request");
    require(session.values()==neutralColor && session.appliedValues()==neutralColor, "Rollback changed original applied metadata");
    require(session.beginTransaction() && session.commitTransaction() && !session.transactionPending(), "Settled transaction commit failed");
    require(!session.rollbackTransaction(ids), "Rollback without checkpoint accepted");
    auto swapped=session.snapshot();
    require(session.preview(original,candidate,false,ids), "Swap setup failed");
    const auto epoch=session.epochId();
    require(session.swapMetadata(swapped,ids) && session.values()==neutralColor && session.epochId()!=epoch,
            "Explicit snapshot swap failed to restore metadata with fresh epoch");
}
void fieldOwnershipAndRanges() {
    ++suites;
    const ColorValues current{1.2f,1.3f,.8f,1.6f,1.4f,.2f,-.1f,.3f,-.4f,.1f,25,.2f,-55,.3f,80};
    const ColorValues suggestion{.7f,1.5f,1,1,1,-.2f,.3f};
    for(size_t action=0;action<4;++action) {
        const auto merged=cm::BrowserColorSession::merge(current,suggestion,static_cast<cm::Method>(action));
        for(size_t k=0;k<15;++k) {
            const bool adjusts=((action==0||action==1)&&k==0)||((action==0||action==2)&&k==1)||((action==0||action==3)&&(k==5||k==6));
            require(merged[k]==(adjusts?suggestion[k]:current[k]), "Merge changed an unowned current field");
        }
    }
    for(size_t k=0;k<15;++k) {
        auto values=neutralColor;values[k]=colorFields[k].low;
        require(cm::BrowserColorSession::validValues(values), "Low boundary rejected");
        values[k]=colorFields[k].high;require(cm::BrowserColorSession::validValues(values), "High boundary rejected");
        values[k]=colorFields[k].low-1;require(!cm::BrowserColorSession::validValues(values), "Out-of-range value accepted");
        values[k]=std::numeric_limits<float>::quiet_NaN();require(!cm::BrowserColorSession::validValues(values), "NaN accepted");
        values[k]=std::numeric_limits<float>::infinity();require(!cm::BrowserColorSession::validValues(values), "Inf accepted");
    }
    auto before=context();cm::BrowserColorSession session;cm::IdSequence ids;
    auto invalid=neutralColor;invalid[2]=0;
    require(!session.preview(before,invalid,false,ids) && !session.active(), "Invalid preview captured partial session");
    const auto badMethod=session.captureAuto(before,static_cast<cm::Method>(255),false,ids);
    require(badMethod.disposition==cm::CaptureDisposition::Refused && !session.active(), "Invalid method captured partial session");
    require(session.preview(before,current,false,ids), "Valid preview failed");
    require(!session.preview(before,current,true,ids) && session.failure()==cm::Failure::ScopeBoundaryRequired,
            "Scope switch implicitly discarded unbaked values");
    require(session.end(before,ids)==cm::EndDisposition::NeedsBake && session.values()==current,
            "End acted as an unqualified flush");
}
void identitiesAndRetainedLifetime() {
    ++suites;
    auto before=context();cm::BrowserColorSession session;
    cm::IdSequence exhausted(std::numeric_limits<uint64_t>::max()-4);
    require(!session.preview(before,warm(),false,exhausted) && !session.active(), "Exhaustion left partial preview/session");
    cm::IdSequence exhaustedAuto(std::numeric_limits<uint64_t>::max()-4);
    require(session.captureAuto(before,cm::Method::Enhance,false,exhaustedAuto).disposition==cm::CaptureDisposition::Refused && !session.active(),
            "Auto identity exhaustion left partial session");
    cm::IdSequence ids;
    require(session.preview(before,warm(),false,ids), "Valid lifetime preview failed");
    std::weak_ptr<const Scene> weakScene=before.scene;
    std::weak_ptr<SceneMemory> weakMemory=before.states.memory();
    auto snapshot=session.snapshot();before={};
    require(!weakScene.expired() && !weakMemory.expired(), "Metadata did not retain immutable scene/mask grants");
    session.abandon();
    require(!weakScene.expired() && !weakMemory.expired(), "Checkpoint released retained owners too soon");
    snapshot={};
    require(weakScene.expired() && weakMemory.expired(), "Metadata/checkpoint leaked scene or mask owners");
}
void jsonIdentityBoundaries() {
    ++suites;
    cm::IdSequence last(cm::maximumIdentity);
    const auto accepted=last.take();
    require(accepted&&*accepted==cm::maximumIdentity,"Maximum exact JavaScript ID was rejected");
    require(!last.take()&&last.next()==cm::maximumIdentity+1,"JSON identity overflow wrapped or published an unsafe ID");
    cm::IdSequence zero(0),unsafe(cm::maximumIdentity+1);
    require(!zero.take()&&!unsafe.take(),"Zero or unsafe initial JSON identity was accepted");
    auto before=context();cm::BrowserColorSession session;
    cm::IdSequence previewExhausted(cm::maximumIdentity-3);
    require(!session.preview(before,warm(),false,previewExhausted)&&!session.active()&&session.values()==neutralColor,
            "Safe-ID exhaustion published a partial preview/base session");
    cm::IdSequence autoExhausted(cm::maximumIdentity-3);
    require(session.captureAuto(before,cm::Method::Enhance,false,autoExhausted).disposition==cm::CaptureDisposition::Refused&&!session.active(),
            "Safe-ID exhaustion published a partial automatic capture");
    cm::IdSequence fits(cm::maximumIdentity-4);
    const auto automatic=captured(session.captureAuto(before,cm::Method::Enhance,false,fits));
    require(automatic.key.requestId==cm::maximumIdentity&&session.jobPending(),"Last fully admitted automatic request did not use exact safe IDs");
    const auto values=session.values(),applied=session.appliedValues();
    const auto epoch=session.epochId();
    require(!session.cancel(automatic,before,fits)&&session.jobPending()&&session.values()==values&&session.appliedValues()==applied&&session.epochId()==epoch,
            "Refused cancellation partially changed metadata at identity exhaustion");
    auto saved=session.snapshot();
    require(!session.swapMetadata(saved,fits)&&session.jobPending()&&session.epochId()==epoch,
            "Refused rollback partially changed metadata at identity exhaustion");
    session.abandon();require(!session.active()&&!session.jobPending(),"Explicit teardown failed after identity exhaustion");
}
void nonallocatingMetadataTransitions() {
    ++suites;
    auto before=context();const auto after=published(before,equivalent(before));
    cm::BrowserColorSession session;cm::IdSequence ids;const auto grade=warm();
    const auto count=allocations;
    observed=true;
    require(session.preview(before,grade,false,ids), "Observed preview failed");
    require(session.beginTransaction(), "Observed checkpoint capture failed");
    const auto request=captured(session.captureManual(before,ids));
    require(bool(session.plan(request,before,grade)), "Observed bake plan failed");
    require(session.markApplied(request,before,after,grade,true), "Observed acknowledgment failed");
    require(session.rollbackTransaction(ids), "Observed metadata rollback failed");
    const auto retry=captured(session.captureAuto(before,cm::Method::Enhance,false,ids));
    require(session.cancel(retry,before,ids), "Observed cancellation failed");
    auto saved=session.snapshot();
    require(session.swapMetadata(saved,ids), "Observed explicit metadata swap failed");
    require(session.end(before,ids)==cm::EndDisposition::Ended, "Observed end failed");
    session.abandon();
    observed=false;
    require(allocations==count, "Metadata capture/plan/acknowledgment/cancel/end/swap allocated hidden payload");
}
}
int autoColorMetadataContracts() {
    static_assert(std::is_nothrow_copy_constructible_v<cm::BrowserColorSession::Snapshot>);
    static_assert(std::is_nothrow_move_constructible_v<cm::Request>);
    try {
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
        sv_allocation::setObserverForContracts(allocationObserved);
#endif
        ownedBaselineAndAbsoluteValues();neutralRestorationAndTrueNoop();manualNewerPreviewAndAutoFence();
        staleAndInvalidPublication();transactionRollbackAndAba();fieldOwnershipAndRanges();identitiesAndRetainedLifetime();
        nonallocatingMetadataTransitions();jsonIdentityBoundaries();
        std::cout<<"PASS desktop-aligned native color metadata: "<<suites<<" contract suites; "<<assertions<<" assertions.\n"
            <<"target session="<<sizeof(cm::BrowserColorSession)<<" snapshot="<<sizeof(cm::BrowserColorSession::Snapshot)
            <<" context="<<sizeof(cm::Context)<<" key="<<sizeof(cm::Key)<<" request="<<sizeof(cm::Request)
            <<" bakePlan="<<sizeof(cm::BakePlan)<<" observed metadata-transition allocations="<<allocations<<'\n';
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
        sv_allocation::setObserverForContracts(nullptr);
#endif
        return 0;
    } catch(const std::exception &e) {
        observed=false;
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
        sv_allocation::setObserverForContracts(nullptr);
#endif
        std::cerr<<"FAIL: "<<e.what()<<'\n';return 1;
    }
}
