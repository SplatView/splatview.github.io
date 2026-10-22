#include "model.hpp"
#include "editing.hpp"
#include "processing_kernels.hpp"
#include "scene_exports.hpp"
#include "geometry_tools.hpp"
#include "selection_checkpoint.hpp"
#include "morphology_job.hpp"
#include "morphology_range_job.hpp"
#include "auto_color_analysis_job.hpp"
#include "floor_detection_job.hpp"
#include "browser_color_session.hpp"
#include "browser_alignment_session.hpp"
#include "browser_alignment_frame.hpp"
#include "browser_camera_transform.hpp"
#include "selection_map.hpp"
#include "selection_consumer.hpp"
#include "live_selection.hpp"
#include "browser_geometry.hpp"
#include "browser_sog_group.hpp"
#include "browser_spz_export.hpp"
#include "browser_export_sink.hpp"
#include "browser_filter.hpp"
#include "browser_transform_session.hpp"
#include "browser_opacity_session.hpp"
#include "browser_document_checkpoint.hpp"
#include "browser_duplicate.hpp"
#include "browser_focus_bounds.hpp"
#include "browser_selection_range.hpp"
#include "json_preflight.hpp"
#include "response.hpp"
#include "runtime_build_identity.hpp"
#include <emscripten/heap.h>
#include <algorithm>
#include <cstring>
#include <cstdio>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <vector>

using namespace preview;
using Json = nlohmann::json;
namespace {
std::unique_ptr<SceneEdits> edits;
// Ordinary PLYs share the frozen Scene representation without manufacturing an
// editable Gaussian owner, mask, history or selection-map identity.
std::shared_ptr<const Scene> geometry;
size_t geometryRangeBytes{};
// Browser publication spans the domain and GPU. This admitted checkpoint shares
// immutable scenes/masks and retains exact Undo/Redo for allocation-free rollback.
std::unique_ptr<SceneEdits> checkpoint;
browser_color_metadata::BrowserColorSession colorSession;
browser_color_metadata::IdSequence colorIds;
browser_alignment::Session alignmentSession;
std::optional<browser_alignment::Session> transactionAlignment;
browser_alignment::Lineage alignmentLineage;
std::optional<browser_alignment::Lineage> transactionAlignmentLineage;
browser_duplicate::Lineage duplicateLineage;
std::optional<browser_duplicate::Lineage> transactionDuplicateLineage;
ResourceReservation duplicateLineageMetadata,duplicateJobMetadata;
std::unique_ptr<browser_duplicate::Job> duplicateJob;
browser_alignment::IdSequence alignmentIds;
browser_alignment::IdSequence floorIds;
browser_alignment::IdSequence filterIds;
std::optional<browser_filter::Owner> filterOwner,transactionFilter;
bool transactionHasFilter{};
// Only current + one transaction snapshot can retain filter IDs. The lifetime
// fences are independent of rollback metadata; abandoned monotonic IDs never
// return. Preserve the transaction's fence when a new type begins inside it.
struct FilterAttempt { uint64_t id{},epoch{}; };
std::array<FilterAttempt,2> filterAttempts{};
FilterAttempt &filterAttempt(uint64_t id) {
    for(auto &attempt:filterAttempts) if(attempt.id==id) return attempt;
    for(auto &attempt:filterAttempts) if((!filterOwner || attempt.id!=filterOwner->id) &&
       (!transactionFilter || attempt.id!=transactionFilter->id)) {attempt={id,0};return attempt;}
    throw std::runtime_error("Filter attempt identity storage exhausted");
}
browser_filter::Job::Pointer filterJob;
browser_alignment::IdSequence transformIds;
std::optional<browser_transform::Owner> transformOwner,transactionTransform;
bool transactionHasTransform{};
std::array<FilterAttempt,2> transformAttempts{};
FilterAttempt &transformAttempt(uint64_t id) {
    for(auto &attempt:transformAttempts)if(attempt.id==id)return attempt;
    for(auto &attempt:transformAttempts)if((!transformOwner||attempt.id!=transformOwner->id)&&
       (!transactionTransform||attempt.id!=transactionTransform->id)){attempt={id,0};return attempt;}
    throw std::runtime_error("Transform attempt identity storage exhausted");
}
browser_transform::Job::Pointer transformJob;
browser_alignment::IdSequence opacityIds;
std::optional<browser_opacity::Owner> opacityOwner,transactionOpacity;
bool transactionHasOpacity{};
std::array<FilterAttempt,2> opacityAttempts{};
FilterAttempt &opacityAttempt(uint64_t id) {
    for(auto &attempt:opacityAttempts)if(attempt.id==id)return attempt;
    for(auto &attempt:opacityAttempts)if((!opacityOwner||attempt.id!=opacityOwner->id)&&
       (!transactionOpacity||attempt.id!=transactionOpacity->id)){attempt={id,0};return attempt;}
    throw std::runtime_error("Opacity attempt identity storage exhausted");
}
browser_opacity::Job::Pointer opacityJob;
struct FloorDetection {
    browser_floor::Job::Pointer job;
    browser_floor::Key key;
    uint64_t id{};
    bool selectedOnly{};
};
std::optional<FloorDetection> floorDetection;
browser_floor::CandidatePointer floorCandidate,transactionFloor;
std::uint64_t nativeDocumentGeneration{};
struct ColorToleranceSession {
    BrowserSelectionCheckpoint checkpoint;
    Camera camera;
    uint32_t index{};
    SelectOperation operation{};
    uint64_t sessionId{};
    bool fill{};
    std::shared_ptr<const BrowserSelectionMap> map;
    PointI seed{};
    unsigned width{},height{};
    SelectionOptions options{};
    bool connected{};
    browser_view_scope::Scope selectionView;
    browser_selection_range::Config range;
};
static_assert(std::is_nothrow_copy_constructible_v<ColorToleranceSession> &&
              std::is_nothrow_move_assignable_v<ColorToleranceSession>);
std::optional<ColorToleranceSession> toleranceSession,transactionTolerance;
// Attempted IDs stay consumed after rollback, failure and scene replacement.
// A delayed message can therefore never acquire a recycled checkpoint owner.
uint64_t lastToleranceSessionId{};
std::shared_ptr<BrowserSelectionMap> selectionMap,pendingSelectionMap,transactionSelectionMap;
uint64_t lastSelectionMapId{};
std::optional<ResourceBudget> budget;
sv_response::Responses responses;
sv_operation::Ledger operationLedger;
std::vector<uint32_t> packed;
std::unique_ptr<browser_checkpoint::Plan> recoveryPlan;
std::unique_ptr<browser_checkpoint::Restore> recoveryRestore;
ResourceReservation recoveryMetadata;
std::array<char,1536> recoveryReply{};
size_t recoveryReadSize{};
bool recoveryBusy() noexcept { return bool(recoveryPlan)||bool(recoveryRestore); }
browser_spz_export::Job::Pointer spzExport;
browser_spz_export::OutputOwner::Pointer spzOutput;
browser_export::OutputOwner::Pointer attributeOutput;
struct AlignmentRequest {
    browser_alignment::Context before;
    browser_alignment::Session session;
    Vec3 delta;
    Camera camera,defaultCamera;
    float aspect{1},defaultAspect{1};
    uint64_t floorId{};
};
struct EditJob {
    std::shared_ptr<Scene> working;
    std::vector<uint8_t> states;
    MaskStorage publicationStates;
    std::optional<processing_detail::Grade> grade;
    std::optional<processing_detail::Affine> affine;
    std::optional<processing_detail::ShRotation> shRotation;
    size_t cursor{};
    std::optional<browser_color_metadata::Request> colorRequest;
    ColorValues colorValues{neutralColor};
    std::optional<AlignmentRequest> alignment;
};
std::optional<EditJob> job;
BrowserMorphologyJob::Pointer morphologyJob;
browser_morphology_range::Job::Pointer morphologyRangeJob;
browser_morphology_range::Cache morphologyRangeCache;
browser_focus::Job::Pointer transformFocusJob;
browser_auto_color::AnalysisOwner::Pointer autoColorJob;
browser_color_metadata::Context colorContext() noexcept {
    if(!edits) return {};
    return {edits->scene(),edits->maskSnapshot(),nativeDocumentGeneration,nativeDocumentGeneration,
        edits->revision(),edits->contentRevision(),!edits->selectionDraft() && !pendingSelectionMap};
}
browser_alignment::Context alignmentContext(const SceneEdits &owner) noexcept {
    return {owner.scene(),owner.maskSnapshot(),nativeDocumentGeneration,owner.revision(),owner.contentRevision(),
        !owner.selectionDraft() && !pendingSelectionMap && !toleranceSession};
}
browser_transform::Context transformContext(const SceneEdits &owner) noexcept {
    return {owner.scene(),owner.maskSnapshot(),nativeDocumentGeneration,owner.revision(),owner.contentRevision(),
        !owner.selectionDraft()&&!pendingSelectionMap&&!toleranceSession};
}
browser_focus::Snapshot focusSnapshot() {
    if(!edits||edits->selectionDraft()||pendingSelectionMap)
        throw std::runtime_error("Finish current selection work before querying transform focus");
    browser_focus::Snapshot value;
    value.currentScene=edits->scene();value.currentStates=edits->maskSnapshot();
    value.generation=nativeDocumentGeneration;value.revision=edits->revision();value.contentRevision=edits->contentRevision();
    if(transformOwner) {
        if(!browser_transform::current(*transformOwner,transformContext(*edits)))
            throw std::runtime_error("Transform focus session is stale");
        value.base=transformOwner->base;value.states=transformOwner->states;
        value.transform=browser_focus::TransformBase{transformOwner->id,transformOwner->baseId,transformOwner->epoch};
    } else {value.base=value.currentScene;value.states=value.currentStates;}
    if(!browser_focus::valid(value))throw std::runtime_error("Invalid transform focus baseline");
    return value;
}
browser_opacity::Context opacityContext(const SceneEdits &owner) noexcept {
    return {owner.scene(),owner.maskSnapshot(),nativeDocumentGeneration,owner.revision(),owner.contentRevision(),
        !owner.selectionDraft()&&!pendingSelectionMap&&!toleranceSession};
}
void requireFocusPersistentOwnersCurrent() {
    // Admission and every cooperative step share the same readonly fence.
    // Settled owners remain intact; a scan cannot end their sessions or
    // replace captured maps, canonical masks, grades, or opacity metadata.
    if(!edits ||
       (toleranceSession && (!BrowserSelectionAccess::current(*edits,toleranceSession->checkpoint) ||
         (toleranceSession->map && !toleranceSession->map->current(*edits)))) ||
       (colorSession.active() && (colorSession.jobPending() || !colorSession.currentBase(colorContext()))) ||
       (transformOwner && !browser_transform::current(*transformOwner,transformContext(*edits))) ||
       (opacityOwner && !browser_opacity::current(*opacityOwner,opacityContext(*edits))))
        throw std::runtime_error("Transform focus persistent tool is stale or busy");
}
browser_auto_color::AnalysisSnapshot analysisContext(const browser_color_metadata::Request &request) noexcept {
    const auto &key=request.key;
    return {request.base,request.targetStates(),{key.documentId,key.sourceGeneration,key.contentRevision,key.revision,
        key.sessionId,key.baseId,key.baseContentRevision,key.requestId,key.selectedOnly},true};
}
browser_floor::Key floorKey(const browser_alignment::Context &context) noexcept {
    return {context.scene,context.states.data(),context.states.size(),context.document,context.revision,context.contentRevision};
}
bool currentFloor(const browser_floor::Key &key) noexcept {
    if(!edits) return false;
    const auto context=alignmentContext(*edits);
    return context.settled && key.scene.lock()==context.scene && key.mask==context.states.data() &&
        key.count==context.states.size() && key.document==context.document && key.revision==context.revision &&
        key.contentRevision==context.contentRevision;
}
void retireFloorDetection() noexcept {
    if(floorDetection) browser_floor::Job::retire(floorDetection->job);
    floorDetection.reset();
}
bool pendingJob() noexcept { return bool(transformFocusJob) || bool(duplicateJob) || bool(job) || bool(morphologyJob) || bool(morphologyRangeJob) || bool(autoColorJob) || bool(floorDetection) || bool(spzExport) || bool(filterJob) || bool(transformJob) || bool(opacityJob); }
void retireJobs() noexcept {
    browser_focus::Job::retire(transformFocusJob);
    if(duplicateJob)duplicateJob->cancel();duplicateJob.reset();duplicateJobMetadata.release();
    browser_opacity::Job::retire(opacityJob);
    browser_transform::Job::retire(transformJob);
    browser_filter::Job::retire(filterJob);
    browser_spz_export::Job::retire(spzExport);
    retireFloorDetection();
    browser_auto_color::AnalysisOwner::retire(autoColorJob);
    if(job && job->colorRequest && colorSession.jobPending())
        colorSession.cancel(*job->colorRequest,colorContext(),colorIds);
    if(morphologyJob) morphologyJob->cancel();
    morphologyJob.reset();
    if(morphologyRangeJob)morphologyRangeJob->cancel();
    morphologyRangeJob.reset();morphologyRangeJob.get_deleter().memory.reset();
    // unique_ptr::reset preserves its deleter. Retire the admission service as
    // well, so an empty global job cannot retain a replaced scene's ledger.
    morphologyJob.get_deleter().memory.reset(); job.reset();
    alignmentLineage.prune();
}
using ResponseSummary=sv_response::Summary;
using ResponsePreparation=sv_response::Responses::Preparation;
sv_response::ToleranceRange toleranceRange(const ColorToleranceSession &session) noexcept {
    sv_response::ToleranceRange value;value.enabled=session.range.enabled;
    if(session.range.radius)value.radius=double(*session.range.radius);
    if(session.range.center){const auto p=*session.range.center;value.center=std::array<double,3>{p.x,p.y,p.z};}
    return value;
}
sv_operation::Uuid operationUuid(const Json &value) {
    if(!value.is_string()) throw std::runtime_error("Invalid operation UUID");
    const auto &text=value.get_ref<const std::string &>();
    if(!sv_operation::validUuid(text)) throw std::runtime_error("Invalid operation UUID");
    sv_operation::Uuid result;std::copy(text.begin(),text.end(),result.bytes.begin());return result;
}
uint64_t operationInteger(const Json &value) {
    if(!value.is_number_integer()||(!value.is_number_unsigned()&&value.get<int64_t>()<=0))
        throw std::runtime_error("Invalid operation identity");
    const auto result=value.get<uint64_t>();
    if(!result||result>sv_operation::maximumIdentity)throw std::runtime_error("Invalid operation identity");return result;
}
sv_operation::Scope operationScope(const Json &value,bool owner=false) {
    if(!value.is_object()||value.size()!=(owner?5u:4u)||!value.contains("version")||value.at("version")!=1||
       !value.at("version").is_number_integer()) throw std::runtime_error("Invalid operation scope");
    return {operationUuid(value.at("documentId")),operationUuid(value.at("clientGeneration")),operationInteger(value.at("sourceGeneration"))};
}
sv_operation::Owner operationOwner(const Json &value) {
    return {operationScope(value,true),operationInteger(value.at("operationId"))};
}
sv_operation::State operationState(const ResponseSummary &s) noexcept {
    sv_operation::State value;
    value.revision=s.revision;value.contentRevision=s.contentRevision;value.selected=s.selected;value.visible=s.visible;
    value.count=s.count;value.sourceCount=s.sourceCount;value.hasDuplicateRange=bool(s.duplicateRange);
    if(s.duplicateRange){value.duplicateFirst=s.duplicateRange->first;value.duplicateCount=s.duplicateRange->count;}
    value.canUndo=s.canUndo;value.canRedo=s.canRedo;value.transaction=s.transaction;value.selectionDraft=s.selectionDraft;value.pending=s.pending;
    value.toleranceSessionId=s.toleranceSessionId;value.toleranceMapId=s.toleranceMapId;value.selectionMapId=s.selectionMapId;
    value.pendingSelectionMapId=s.pendingSelectionMapId;value.selectionMapRetainedIds=s.selectionMapRetainedIds;
    value.selectionMapRetainedCount=s.selectionMapRetainedCount;return value;
}
void validateOperationMutation(const Json &request) {
    if(request.contains("operationOwner")) {
        if(!operationLedger.owns(operationOwner(request.at("operationOwner")),nativeDocumentGeneration))
            throw std::runtime_error("The edit operation owner is stale or unresolved");
    } else if(operationLedger.blocks()) throw std::runtime_error("Resolve the identified edit operation first");
}
sv_response::FloorStage floorStage(browser_floor::Phase phase) noexcept {
    using P=browser_floor::Phase;using S=sv_response::FloorStage;
    if(phase<=P::ReservoirDraw) return S::Sampling;
    if(phase<=P::Threshold) return S::Threshold;
    if(phase<=P::Winner) return S::Ransac;
    return phase==P::Terminal ? S::Complete : S::Refine;
}
sv_response::Floor floorResult(const browser_floor::Candidate &candidate) noexcept {
    sv_response::Floor value;value.id=candidate.id;value.selectedOnly=candidate.selectedOnly;
    value.status=candidate.plane ? sv_response::FloorStatus::Ready : sv_response::FloorStatus::None;
    value.stage=sv_response::FloorStage::Complete;
    if(candidate.plane) {
        const auto &p=*candidate.plane;
        value.plane=sv_response::FloorPlane{{p.normal.x,p.normal.y,p.normal.z},{p.center.x,p.center.y,p.center.z},
            p.radius,p.rms,p.inliers,p.tested};
    }
    return value;
}
const char *reply(ResponsePreparation &prepared,const ResponseSummary &value) noexcept {
    return responses.summary(prepared,value) ? responses.publish(prepared) :
        sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
}
const char *replyError(ResponsePreparation &prepared,const char *message) noexcept {
    return responses.error(prepared,message) ? responses.publish(prepared) :
        sv_response::failureReply(sv_response::FailureKind::Internal);
}
constexpr char canonicalSummaryCommand[]="{\"command\":\"summary\"}";
bool canonicalSummary(const char *text) noexcept {
    const auto address=reinterpret_cast<uintptr_t>(text),heapBytes=emscripten_get_heap_size();
    if(!address || address>heapBytes || sizeof(canonicalSummaryCommand)>heapBytes-address) return false;
    for(size_t i=0;i<sizeof(canonicalSummaryCommand);++i) {
        if(text[i]!=canonicalSummaryCommand[i]) return false;
        if(!text[i]) return true;
    }
    return false;
}
std::shared_ptr<const Scene> currentScene() noexcept { return edits ? edits->scene() : geometry; }
ResponseSummary sceneSummary(const Scene &,const SceneEdits *,const ResourceBudget *);
// Every fallible decoder/history/summary step precedes this shared publication.
// Both ordinary and grouped open retire the same domain/session owners.
const char *publishOpen(ResponsePreparation &prepared,std::shared_ptr<const Scene> scene,
                        std::unique_ptr<SceneEdits> candidate,ResourceBudget candidateBudget,
                        ResourceReservation &previous) {
    if(nativeDocumentGeneration==9007199254740991ULL) throw std::runtime_error("Document identity exhausted");
    auto metadata=candidateBudget.reserve(ResourceCategory::History,scene->isGaussian()?
        checkedByteSum({2*sizeof(browser_duplicate::Lineage),sizeof(browser_alignment::Lineage)}):0);
    auto value=sceneSummary(*scene,candidate.get(),&candidateBudget);value.memoryBytes-=previous.bytes();
    if(!responses.summary(prepared,value))throw std::runtime_error("Invalid source publication response");
    retireJobs();morphologyRangeCache.clear();checkpoint.reset();transactionTolerance.reset();toleranceSession.reset();
    filterOwner.reset();transactionFilter.reset();transactionHasFilter=false;filterAttempts={};
    transformOwner.reset();transactionTransform.reset();transactionHasTransform=false;transformAttempts={};
    opacityOwner.reset();transactionOpacity.reset();transactionHasOpacity=false;opacityAttempts={};
    colorSession.abandon();++nativeDocumentGeneration;operationLedger.sourceChanged();
    alignmentSession.clear();transactionAlignment.reset();alignmentLineage.clear();
    transactionAlignmentLineage.reset();duplicateLineage.clear();transactionDuplicateLineage.reset();
    floorCandidate.reset();transactionFloor.reset();
    transactionSelectionMap.reset();pendingSelectionMap.reset();selectionMap.reset();
    browser_spz_export::OutputOwner::retire(spzOutput);
    browser_export::OutputOwner::retire(attributeOutput);
    std::vector<uint32_t>{}.swap(packed);
    edits=std::move(candidate);geometry=scene->isGaussian()?nullptr:std::move(scene);
    geometryRangeBytes=0;recoveryMetadata.release();duplicateLineageMetadata=std::move(metadata);budget=std::move(candidateBudget);previous.release();return responses.publish(prepared);
}
void transformMetadata(ResponseSummary &,const SceneEdits &,const std::optional<browser_transform::Owner> &,bool=false) noexcept;
ResponseSummary sceneSummary(const Scene &scene,const SceneEdits *owner,const ResourceBudget *resources) {
    Camera camera; camera.fit(scene);
    const auto view=camera.savedView();
    const auto vertexBytes=checkedByteProduct(scene.vertices.size(),sizeof(PreviewVertex)),
        indexBytes=checkedByteProduct(scene.triangles.size(),sizeof(std::array<uint32_t,3>));
    ResponseSummary value;
    value.loaded=true;value.count=scene.loadedCount();value.sourceCount=scene.sourceCount;
    value.sourceFaces=scene.sourceFaces;value.sampledGeometry=scene.sampledGeometry;
    if(!scene.isGaussian()) value.geometry=sv_response::GeometryDescriptor{
        1,unsigned(scene.type),unsigned(sizeof(PreviewVertex)),unsigned(sizeof(uint32_t)),
        scene.vertices.size(),scene.triangles.size(),vertexBytes,indexBytes,0,0};
    value.shDegree=scene.shDegree;value.format=scene.format;value.kind=unsigned(scene.type);
    value.selected=owner ? owner->selectedCount() : 0;
    value.visible=owner ? owner->visibleCount() : scene.loadedCount();
    value.canUndo=owner && owner->canUndo();value.canRedo=owner && owner->canRedo();
    value.selectionDraft=owner && owner->selectionDraft();
    value.revision=owner ? owner->revision() : 0;value.contentRevision=owner ? owner->contentRevision() : 0;
    value.selectionCommitRevision=owner ? owner->selectionCommitRevision() : 0;
    value.undoSelectionRevision=owner ? owner->undoSelectionRevision() : 0;
    value.center={scene.center.x,scene.center.y,scene.center.z};value.radius=scene.radius;value.yUp=scene.yUp;
    value.camera={view.target.x,view.target.y,view.target.z,view.yaw,view.pitch,
        view.distance,camera.radius,view.fieldOfView,view.yUp?1.f:0.f,view.roll,1.f};
    value.memoryBytes=resources ? resources->usage().totalBytes : 0;
    if(scene.isGaussian()) {
        if(owner)if(const auto range=duplicateLineage.find(owner->scene()))value.duplicateRange=sv_response::DuplicateRange{range->first,range->count};
        sv_response::Alignment alignment;
        for(size_t i=0;i<16;++i) alignment.frame[i]=scene.alignmentFrame[i];
        alignment.retainedBranchCount=1;
        value.alignment=alignment;
        if(owner)if(const auto range=morphologyRangeCache.get(owner->scene()))
            value.morphologyRange=sv_response::MorphologyRange{range->minimum,range->maximum,range->initial};
    }
    return value;
}
void pruneSelectionMaps() noexcept {
    if(selectionMap && (!edits || !selectionMap->current(*edits))) selectionMap.reset();
    if(pendingSelectionMap && (!edits || !pendingSelectionMap->current(*edits))) pendingSelectionMap.reset();
    if(transactionSelectionMap && (!checkpoint || !transactionSelectionMap->current(*checkpoint)))
        transactionSelectionMap.reset();
}
auto retainedSelectionMaps() noexcept {
    return std::array<std::shared_ptr<const BrowserSelectionMap>,5>{selectionMap,pendingSelectionMap,transactionSelectionMap,
        toleranceSession ? toleranceSession->map : nullptr,transactionTolerance ? transactionTolerance->map : nullptr};
}
size_t selectionMapBytes() noexcept {
    size_t bytes=0; const auto maps=retainedSelectionMaps();
    for(size_t i=0;i<maps.size();++i) if(maps[i]) {
        bool duplicate=false;
        for(size_t j=0;j<i;++j) if(maps[j]==maps[i]) duplicate=true;
        if(!duplicate) bytes+=maps[i]->retainedBytes();
    }
    return bytes;
}
void selectionMapRetainedIds(ResponseSummary &value) noexcept {
    const auto maps=retainedSelectionMaps();
    for(size_t i=0;i<maps.size();++i) if(maps[i]) {
        bool duplicate=false;
        for(size_t j=0;j<i;++j) if(maps[j]==maps[i]) duplicate=true;
        if(!duplicate) value.selectionMapRetainedIds[value.selectionMapRetainedCount++]=maps[i]->header.mapId;
    }
}
void alignmentMetadata(sv_response::Alignment &value,const SceneEdits &owner,const browser_alignment::Session &session,
                       const browser_alignment::Lineage &lineage=alignmentLineage) noexcept {
    value.branchId=lineage.branch(owner.scene());value.canReset=session.canReset(alignmentContext(owner));
    value.retainedBranchCount=0;
    const auto append=[&](const std::shared_ptr<const Scene> &scene) noexcept {
        if(!scene) return;const auto id=lineage.branch(scene);
        for(size_t i=0;i<std::min(value.retainedBranchCount,value.retainedBranchIds.size());++i) if(value.retainedBranchIds[i]==id) return;
        if(value.retainedBranchCount<value.retainedBranchIds.size()) value.retainedBranchIds[value.retainedBranchCount++]=id;
        else value.retainedBranchCount=value.retainedBranchIds.size()+1;
    };
    // Visit actual history/current owners. Weak work/external/checkpoint-only
    // associations cannot keep abandoned browser roll checkpoints alive.
    BrowserSelectionAccess::retainedScenes(owner,append);
    if(session.current(alignmentContext(owner))) append(session.baseline());
    std::sort(value.retainedBranchIds.begin(),value.retainedBranchIds.begin()+std::min(value.retainedBranchCount,value.retainedBranchIds.size()));
}
// Apply only to responses for the current document. A source/recovery candidate
// owns a separate budget and must not inherit these retained output owners.
void retainedExportMetadata(ResponseSummary &value) {
    value.exportOutputBytes=checkedByteSum({spzOutput ? spzOutput->retainedBytes() : 0,
                                          attributeOutput ? attributeOutput->retainedBytes() : 0});
    value.exportBytes=checkedByteSum({value.exportOutputBytes,spzExport ? spzExport->retainedBytes() : 0});
}
ResponseSummary summary() {
    // Invalid owners must release their admitted baseline promptly. Transaction
    // snapshots retain their own owner and restore it together with SceneEdits.
    if(toleranceSession && (!edits || !BrowserSelectionAccess::current(*edits,toleranceSession->checkpoint) ||
       (toleranceSession->map && !toleranceSession->map->current(*edits))))
        toleranceSession.reset();
    if(transactionTolerance && (!checkpoint || !BrowserSelectionAccess::current(*checkpoint,transactionTolerance->checkpoint) ||
       (transactionTolerance->map && !transactionTolerance->map->current(*checkpoint)))) transactionTolerance.reset();
    pruneSelectionMaps();
    if(floorDetection && !currentFloor(floorDetection->key)) retireFloorDetection();
    if(floorCandidate && !currentFloor(floorCandidate->key)) floorCandidate.reset();
    const auto scene=currentScene();
    if(!scene) return {};
    auto value=sceneSummary(*scene,edits.get(),budget ? &*budget : nullptr);
    value.pending=pendingJob();
    if(edits) {
        if(!filterOwner) alignmentSession.retireStale(alignmentContext(*edits));
        alignmentLineage.prune();
        alignmentMetadata(*value.alignment,*edits,alignmentSession);
    }
    value.transaction=bool(checkpoint);
    if(filterOwner) {
        value.filter=sv_response::Filter{filterOwner->id,filterOwner->epoch,browser_filter::name(filterOwner->kind),filterOwner->previewEpoch,filterOwner->changed};
        // selectionDraft remains the geometric gesture flag on the wire.
        value.selectionDraft=false;
    }
    if(edits)transformMetadata(value,*edits,transformOwner,bool(transformJob));
    if(opacityOwner) {
        const auto &o=*opacityOwner;value.opacitySession=sv_response::OpacitySession{o.id,o.baseId,o.epoch,o.appliedEpoch,o.selectedOnly,o.appliedScale};
    }
    if(toleranceSession) {
        value.toleranceRange=toleranceRange(*toleranceSession);
        value.toleranceRecorded=toleranceSession->checkpoint.recorded;
        value.toleranceSessionId=toleranceSession->sessionId;
        value.toleranceTool=toleranceSession->fill ? sv_response::ToleranceTool::Fill : sv_response::ToleranceTool::Color;
        if(!toleranceSession->fill) value.toleranceConnected=toleranceSession->connected;
        if(toleranceSession->map) value.toleranceMapId=toleranceSession->map->header.mapId;
    }
    if(selectionMap) value.selectionMapId=selectionMap->header.mapId;
    if(pendingSelectionMap) value.pendingSelectionMapId=pendingSelectionMap->header.mapId;
    value.selectionMapBytes=selectionMapBytes();selectionMapRetainedIds(value);
    value.sceneChanged=checkpoint && checkpoint->scene()!=scene;
    value.pending=pendingJob();
    retainedExportMetadata(value);
    if(floorDetection) {
        sv_response::Floor floor;floor.id=floorDetection->id;floor.selectedOnly=floorDetection->selectedOnly;
        floor.stage=floorStage(floorDetection->job->phase());value.floor=floor;
    } else if(floorCandidate) value.floor=floorResult(*floorCandidate);
    if(colorSession.active()) {
        sv_response::ColorSession color;
        color.sessionId=colorSession.sessionId();color.baseId=colorSession.baseId();color.epochId=colorSession.epochId();
        color.selectedOnly=colorSession.selectedOnly();color.pending=colorSession.jobPending();
        for(size_t i=0;i<15;++i) {color.values[i]=colorSession.values()[i];color.applied[i]=colorSession.appliedValues()[i];}
        value.colorSession=color;
    }
    // Exact total traversal work is data-dependent. This monotone phase
    // indicator is informational; pendingJob() is the completion authority.
    value.progress=transformFocusJob ? transformFocusJob->progress() : duplicateJob ? 0.0 : opacityJob ? opacityJob->progress() : transformJob ? transformJob->progress() : filterJob ? filterJob->progress() : spzExport ? spzExport->fraction() : morphologyJob ? morphologyJob->progress() : morphologyRangeJob ? morphologyRangeJob->progress() : autoColorJob ? autoColorJob->progress()*.5 :
        floorDetection ? double(unsigned(floorStage(floorDetection->job->phase())))/4 :
        job && job->working ? double(job->cursor)/std::max(size_t(1),job->working->gaussians.size()) : 1.0;
    return value;
}
uint64_t filterInteger(const Json &request,const char *key) {
    const auto &value=request.at(key);
    if(!value.is_number_integer() || (!value.is_number_unsigned() && value.get<int64_t>()<=0))
        throw std::runtime_error("Invalid filter identity or epoch");
    const auto result=value.get<uint64_t>();
    if(!result || result>browser_filter::maximumIdentity) throw std::runtime_error("Invalid filter identity or epoch");
    return result;
}
void filterKeys(const Json &request,std::initializer_list<const char *> keys,bool viewAllowed=false) {
    if(!request.is_object() || request.size()!=keys.size()+(request.contains("operationOwner")?1:0)+(viewAllowed&&request.contains("selectionView")?1:0)) throw std::runtime_error("Invalid filter command fields");
    for(const auto *key:keys) if(!request.contains(key)) throw std::runtime_error("Invalid filter command fields");
}
ResponseSummary filterSummary(const SceneEdits &next,const std::optional<browser_filter::Owner> &owner,bool pending=false) {
    auto value=summary();
    value.count=next.scene()->gaussians.size();value.sourceCount=next.scene()->sourceCount;value.duplicateRange.reset();
    if(const auto range=duplicateLineage.find(next.scene()))value.duplicateRange=sv_response::DuplicateRange{range->first,range->count};
    value.morphologyRange.reset();
    if(const auto range=morphologyRangeCache.get(next.scene()))
        value.morphologyRange=sv_response::MorphologyRange{range->minimum,range->maximum,range->initial};
    value.selected=next.selectedCount();value.visible=next.visibleCount();value.canUndo=next.canUndo();value.canRedo=next.canRedo();
    value.revision=next.revision();value.contentRevision=next.contentRevision();value.selectionDraft=next.selectionDraft() && !owner;
    value.selectionCommitRevision=next.selectionCommitRevision();
    value.undoSelectionRevision=next.undoSelectionRevision();
    value.filter=owner ? std::optional<sv_response::Filter>{sv_response::Filter{owner->id,owner->epoch,browser_filter::name(owner->kind),owner->previewEpoch,owner->changed}} : std::nullopt;
    value.pending=pending;value.progress=pending?0:1;value.floor.reset();
    if(selectionMap && !selectionMap->current(next)) value.selectionMapId.reset();
    if(pendingSelectionMap && !pendingSelectionMap->current(next)) value.pendingSelectionMapId.reset();
    value.selectionMapBytes=0;value.selectionMapRetainedCount=0;
    const auto maps=retainedSelectionMaps();
    for(size_t i=0;i<maps.size();++i) if(maps[i] && (i>1 || maps[i]->current(next))) {
        bool duplicate=false;
        for(size_t j=0;j<i;++j) if(maps[j]==maps[i] && (j>1 || maps[j]->current(next))) duplicate=true;
        if(!duplicate) { value.selectionMapBytes+=maps[i]->retainedBytes();value.selectionMapRetainedIds[value.selectionMapRetainedCount++]=maps[i]->header.mapId; }
    }
    value.memoryBytes=budget->usage().totalBytes;
    return value;
}
struct PreparedFilterChange {
    enum class Transaction { None,Begin,Commit,Rollback } transaction{Transaction::None};
    std::unique_ptr<SceneEdits> next;
    std::optional<browser_filter::Owner> owner;
    browser_filter::Job::Pointer preview;
    std::optional<browser_color_metadata::BrowserColorSession> color;
    std::optional<browser_transform::Owner> transform;
    std::optional<browser_opacity::Owner> opacity;
    ResponseSummary response;
    std::optional<sv_operation::Receipt> operation;
};
void operationTerminalMaps(ResponseSummary &value,const SceneEdits &next,
    const std::optional<ColorToleranceSession> &tolerance,const std::shared_ptr<BrowserSelectionMap> &map) noexcept {
    value.toleranceSessionId.reset();value.toleranceMapId.reset();value.toleranceTool=sv_response::ToleranceTool::None;value.toleranceConnected.reset();value.toleranceRange.reset();value.toleranceRecorded.reset();
    value.selectionMapId.reset();value.pendingSelectionMapId.reset();value.selectionMapBytes=0;value.selectionMapRetainedCount=0;
    std::array<std::shared_ptr<const BrowserSelectionMap>,2> maps{};
    if(map&&map->current(next)) {value.selectionMapId=map->header.mapId;maps[0]=map;}
    if(tolerance&&BrowserSelectionAccess::current(next,tolerance->checkpoint)&&(!tolerance->map||tolerance->map->current(next))) {
        value.toleranceSessionId=tolerance->sessionId;value.toleranceTool=tolerance->fill?sv_response::ToleranceTool::Fill:sv_response::ToleranceTool::Color;
        value.toleranceRange=toleranceRange(*tolerance);
        value.toleranceRecorded=tolerance->checkpoint.recorded;
        if(!tolerance->fill)value.toleranceConnected=tolerance->connected;
        if(tolerance->map) {value.toleranceMapId=tolerance->map->header.mapId;maps[1]=tolerance->map;}
    }
    for(size_t i=0;i<maps.size();++i) if(maps[i]&&(!i||maps[i]!=maps[0])) {
        value.selectionMapRetainedIds[value.selectionMapRetainedCount++]=maps[i]->header.mapId;value.selectionMapBytes+=maps[i]->retainedBytes();
    }
}
PreparedFilterChange prepareFilterTransaction(const Json &request,const std::string &command,ResponsePreparation &prepared) {
    if(filterOwner || transactionHasFilter || transformOwner || transactionHasTransform || opacityOwner || transactionHasOpacity) filterKeys(request,{"command"});
    PreparedFilterChange change;change.owner=filterOwner;change.color=colorSession;change.transform=transformOwner;change.opacity=opacityOwner;
    if(command=="beginTransaction") {
        if(checkpoint || pendingJob() || pendingSelectionMap) throw std::runtime_error("Finish the current operation before checkpointing the filter");
        change.next=std::make_unique<SceneEdits>(*edits);
        if(!change.color->beginTransaction()) throw std::runtime_error("A color transaction is already active");
        change.transaction=PreparedFilterChange::Transaction::Begin;
        change.response=filterSummary(*edits,filterOwner);change.response.transaction=true;
        if(floorCandidate && currentFloor(floorCandidate->key)) change.response.floor=floorResult(*floorCandidate);
    } else {
        if(!checkpoint || !transactionAlignment || !transactionAlignmentLineage || !transactionDuplicateLineage) throw std::runtime_error("No filter edit transaction is active");
        if(command=="commitTransaction") {
            if(pendingJob()) throw std::runtime_error("Finish the filter preview before committing");
            if(!change.color->commitTransaction()) throw std::runtime_error("Color transaction commit failed");
            change.transaction=PreparedFilterChange::Transaction::Commit;
            change.response=filterSummary(*edits,filterOwner);
        } else {
            if(!change.color->rollbackTransaction(colorIds)) throw std::runtime_error("Color transaction rollback failed");
            change.transaction=PreparedFilterChange::Transaction::Rollback;change.owner=transactionFilter;change.transform=transactionTransform;change.opacity=transactionOpacity;
            change.response=filterSummary(*checkpoint,transactionFilter);
            if(transactionFloor) change.response.floor=floorResult(*transactionFloor);
            alignmentMetadata(*change.response.alignment,*checkpoint,*transactionAlignment,*transactionAlignmentLineage);
        }
        change.response.transaction=false;change.response.sceneChanged=false;
    }
    change.response.memoryBytes=budget->usage().totalBytes;
    if(change.transaction==PreparedFilterChange::Transaction::Rollback) {
        const auto restored=sceneSummary(*checkpoint->scene(),checkpoint.get(),budget ? &*budget : nullptr);
        change.response.morphologyRange=restored.morphologyRange;
        change.response.center=restored.center;change.response.radius=restored.radius;change.response.camera=restored.camera;change.response.yUp=restored.yUp;
        change.response.alignment->frame=restored.alignment->frame;
        transformMetadata(change.response,*checkpoint,change.transform);
        change.response.opacitySession.reset();
        if(change.opacity) {
            const auto &o=*change.opacity;change.response.opacitySession=sv_response::OpacitySession{o.id,o.baseId,o.epoch,o.appliedEpoch,o.selectedOnly,o.appliedScale};
        }
        change.response.colorSession.reset();
        if(change.color->active()) {
            sv_response::ColorSession color;color.sessionId=change.color->sessionId();color.baseId=change.color->baseId();color.epochId=change.color->epochId();
            color.selectedOnly=change.color->selectedOnly();color.pending=change.color->jobPending();
            for(size_t i=0;i<15;++i){color.values[i]=change.color->values()[i];color.applied[i]=change.color->appliedValues()[i];}
            change.response.colorSession=color;
        }
    }
    if(change.transaction!=PreparedFilterChange::Transaction::Begin) {
        const bool rollback=change.transaction==PreparedFilterChange::Transaction::Rollback;
        operationTerminalMaps(change.response,rollback?*checkpoint:*edits,rollback?transactionTolerance:toleranceSession,
                              rollback?transactionSelectionMap:selectionMap);
    }
    if(request.contains("operationOwner")) {
        const auto owner=operationOwner(request.at("operationOwner"));auto receipt=operationLedger.receipt();
        if(command=="beginTransaction") {receipt.outcome=sv_operation::Outcome::Active;receipt.terminal.reset();}
        else {
            const bool rollback=command=="rollbackTransaction";
            receipt.outcome=rollback?sv_operation::Outcome::RolledBack:sv_operation::Outcome::Committed;
            receipt.terminal=operationState(change.response);
        }
        if(receipt.owner!=owner||!responses.operation(prepared,receipt,change.response))throw std::runtime_error("Invalid operation transaction response");
        change.operation=receipt;
    } else if(!responses.summary(prepared,change.response)) throw std::runtime_error("Invalid filter transaction response");
    return change;
}
PreparedFilterChange prepareFilterCommand(const Json &request,const std::string &command,ResponsePreparation &prepared) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    PreparedFilterChange change;
    if(command=="beginFilter") {
        filterKeys(request,{"command","kind"});
        if(filterOwner) throw std::runtime_error("Cancel the current filter before choosing another");
        if(pendingJob()||opacityOwner||edits->selectionDraft()||pendingSelectionMap||toleranceSession||colorSession.active())
            throw std::runtime_error("Finish the current operation before filtering");
        const auto kind=browser_filter::kind(request.at("kind").get<std::string>());
        const auto id=filterIds.take();if(!id) throw std::runtime_error("Filter identity exhausted");
        filterAttempt(*id);
        change.next=std::make_unique<SceneEdits>(*edits);
        auto baseline=BrowserSelectionAccess::capture(*edits);change.next->beginSelectionDraft();
        change.owner.emplace(browser_filter::Owner{*id,0,nativeDocumentGeneration,change.next->revision(),kind,{},std::move(baseline)});
    } else {
        if(!filterOwner || !browser_filter::current(*edits,*filterOwner,nativeDocumentGeneration))
            throw std::runtime_error("Selection filter is stale");
        if(command!="resetCleanup" && filterInteger(request,"id")!=filterOwner->id)
            throw std::runtime_error("Selection filter identity is stale");
        change.owner=filterOwner;
        if(command=="previewFilter") {
            filterKeys(request,{"command","id","epoch","kind","parameters","operation"},true);
            if(pendingJob()) throw std::runtime_error("An edit is already running");
            const auto epoch=filterInteger(request,"epoch");
            auto &attempt=filterAttempt(filterOwner->id);
            if(epoch<=filterOwner->epoch || epoch<=attempt.epoch || browser_filter::kind(request.at("kind").get<std::string>())!=filterOwner->kind)
                throw std::runtime_error("Selection filter request is stale");
            const auto &input=request.at("operation");
            if(!input.is_number_integer() || (!input.is_number_unsigned() && input.get<int64_t>()<0) || input.get<uint64_t>()>3)
                throw std::runtime_error("Invalid selection combination");
            attempt.epoch=epoch; // Consumed before parameter/admission/reply work; never rolled back.
            const auto parameters=browser_filter::parameters(filterOwner->kind,request.at("parameters"));
            change.owner->epoch=epoch;
            change.preview=browser_filter::Job::create(*change.owner,parameters,static_cast<SelectOperation>(input.get<unsigned>()),
                sceneMemoryForBudget(*budget,ResourceCategory::Work),browser_view_scope::parse(request));
        } else {
            change.next=std::make_unique<SceneEdits>(*edits);
            if(command=="confirmFilter") {
                const bool visible=request.contains("visiblePreview");
                if(visible) {
                    filterKeys(request,{"command","id","epoch","visiblePreview"});
                    if(!request.at("visiblePreview").is_boolean()||!request.at("visiblePreview").get<bool>())
                        throw std::runtime_error("Invalid visible filter confirmation");
                } else filterKeys(request,{"command","id","epoch"});
                const auto epoch=filterInteger(request,"epoch");
                // Clear highlights commits the acknowledged visible mask even
                // after newer preview work was cancelled. Ordinary Confirm
                // retains the exact latest-request and attempt fences.
                if(pendingJob() || filterOwner->previewEpoch!=epoch || (!visible &&
                   (epoch!=filterOwner->epoch||filterAttempt(filterOwner->id).epoch!=filterOwner->epoch)))
                    throw std::runtime_error("Preview the latest filter before confirming");
                change.next->confirmSelectionDraft();
            } else if(command=="cancelFilter") {
                filterKeys(request,{"command","id"});change.next->cancelSelectionDraft();
            } else if(command=="resetCleanup") {
                filterKeys(request,{"command"});change.next->resetCleanup();
            } else throw std::runtime_error("Invalid filter command");
            change.owner.reset();
        }
    }
    change.response=filterSummary(change.next ? *change.next : *edits,change.owner,bool(change.preview));
    if(!responses.summary(prepared,change.response)) throw std::runtime_error("Invalid filter response");
    return change;
}
const char *publishFilterChange(PreparedFilterChange &change,ResponsePreparation &prepared) noexcept {
    // The request DOM, all admitted/history preparation and response gate have
    // retired. Only noexcept swaps/metadata retirement precede publication.
    using T=PreparedFilterChange::Transaction;
    // This proof is durable before checkpoint retirement. Every remaining
    // transition is a fixed-size assignment, noexcept swap or owner release.
    if(change.operation) {
        if(change.transaction==T::Begin) operationLedger.activate(change.operation->owner);
        else operationLedger.complete(change.operation->owner,change.operation->outcome,*change.operation->terminal);
    }
    if(change.transaction==T::Begin) {
        transactionAlignmentLineage=alignmentLineage;transactionDuplicateLineage=duplicateLineage;
        transactionAlignment=alignmentSession;transactionFloor=floorCandidate;transactionFilter=filterOwner;transactionHasFilter=bool(filterOwner);
        transactionTransform=transformOwner;transactionHasTransform=bool(transformOwner);
        transactionOpacity=opacityOwner;transactionHasOpacity=bool(opacityOwner);
        transactionTolerance=toleranceSession;transactionSelectionMap=selectionMap;checkpoint=std::move(change.next);
        colorSession=std::move(*change.color);
    } else if(change.transaction==T::Commit) {
        transactionAlignmentLineage.reset();transactionDuplicateLineage.reset();
        colorSession=std::move(*change.color);checkpoint.reset();transactionAlignment.reset();transactionFloor.reset();transactionFilter.reset();
        transactionTolerance.reset();transactionSelectionMap.reset();transactionHasFilter=false;
        transactionTransform.reset();transactionHasTransform=false;
        transactionOpacity.reset();transactionHasOpacity=false;
    } else if(change.transaction==T::Rollback) {
        retireJobs();colorSession=std::move(*change.color);std::swap(alignmentSession,*transactionAlignment);transactionAlignment.reset();
        alignmentLineage=std::move(*transactionAlignmentLineage);transactionAlignmentLineage.reset();
        duplicateLineage=std::move(*transactionDuplicateLineage);transactionDuplicateLineage.reset();
        edits.swap(checkpoint);checkpoint.reset();floorCandidate=std::move(transactionFloor);
        filterOwner=std::move(transactionFilter);transactionFilter.reset();transactionHasFilter=false;
        transformOwner=std::move(transactionTransform);transactionTransform.reset();transactionHasTransform=false;
        opacityOwner=std::move(transactionOpacity);transactionOpacity.reset();transactionHasOpacity=false;
        toleranceSession.swap(transactionTolerance);transactionTolerance.reset();selectionMap.swap(transactionSelectionMap);transactionSelectionMap.reset();
    } else {
        browser_filter::Job::retire(filterJob);
        if(change.next) edits.swap(change.next);
        filterOwner=std::move(change.owner);filterJob=std::move(change.preview);
        if(checkpoint) transactionHasFilter=true;
        floorCandidate.reset();pruneSelectionMaps();change.next.reset();
    }
    change.color.reset(); // Retire its old inactive transaction snapshot before accounting.
    change.response.memoryBytes=budget->usage().totalBytes;
    if(change.operation)responses.operation(prepared,operationLedger.receipt(),change.response);
    else responses.summary(prepared,change.response); // Same proved fixed topology, only retained bytes changed.
    return responses.publish(prepared);
}
bool gizmoHistoryEligible(const SceneEdits &next,const browser_transform::Owner &owner,bool forward) noexcept {
    return owner.kind==browser_transform::Kind::Gizmo&&owner.cancelBase&&!next.selectionDraft()&&
        (forward?next.canRedo():(next.scene()!=owner.cancelBase->scene&&next.canUndo()))&&
        BrowserSelectionAccess::historyScene(next,forward)!=next.scene();
}
void transformMetadata(ResponseSummary &value,const SceneEdits &next,const std::optional<browser_transform::Owner> &owner,bool baking) noexcept {
    value.transformSession.reset();if(!owner)return;
    sv_response::TransformSession transform;transform.id=owner->id;transform.baseId=owner->baseId;transform.epoch=owner->epoch;
    transform.appliedEpoch=owner->appliedEpoch;transform.kind=browser_transform::name(owner->kind);transform.selectedOnly=owner->selectedOnly;
    for(size_t i=0;i<16;++i)transform.appliedMatrix[i]=owner->appliedPlan.matrix[i];
    transform.pivot={owner->pivot.x,owner->pivot.y,owner->pivot.z};
    if(owner->kind==browser_transform::Kind::Gizmo) {
        sv_response::GizmoSession gizmo;
        if(owner->cancelBase) {gizmo.cancelBaseId=owner->cancelBase->baseId;gizmo.cancelContentRevision=owner->cancelBase->contentRevision;}
        // Readonly focus/statistics jobs preserve the whole owner. Only this
        // session's pending bake suppresses its history eligibility metadata.
        gizmo.canUndo=!baking&&gizmoHistoryEligible(next,*owner,false);
        gizmo.canRedo=!baking&&gizmoHistoryEligible(next,*owner,true);transform.gizmo=gizmo;
    }
    value.transformSession=transform;
}
ResponseSummary transformSummary(const SceneEdits &next,const std::optional<browser_transform::Owner> &owner,bool pending=false) {
    auto value=filterSummary(next,filterOwner,pending);
    const auto scene=sceneSummary(*next.scene(),&next,budget ? &*budget : nullptr);
    value.center=scene.center;value.radius=scene.radius;value.camera=scene.camera;value.yUp=scene.yUp;
    value.sceneChanged=checkpoint&&checkpoint->scene()!=next.scene();
    alignmentMetadata(*value.alignment,next,alignmentSession);transformMetadata(value,next,owner,pending);return value;
}
void captureTransformBase(browser_transform::Owner &owner,const SceneEdits &next,bool selectedOnly,
                          const browser_view_scope::Scope &view) {
    const auto context=transformContext(next);if(!browser_transform::valid(context))throw std::runtime_error("Invalid transform baseline");
    const bool gizmo=owner.kind==browser_transform::Kind::Gizmo;
    if(selectedOnly&&!next.selectedCount()&&!gizmo)throw std::runtime_error("Select splats first");
    owner.base=context.scene;owner.states=context.states;owner.acknowledged=context;owner.selectedOnly=selectedOnly;owner.effectiveStates={};
    if(selectedOnly&&view.enabled)owner.effectiveStates=browser_view_scope::effective(*context.scene,context.states,view,
        sceneMemoryForBudget(*budget,ResourceCategory::Work),!gizmo);
    owner.emptyTarget=gizmo&&std::none_of(owner.targetStates().begin(),owner.targetStates().end(),[selectedOnly](uint8_t state){return !(state&2)&&(!selectedOnly||(state&1));});
    std::optional<Scene> focus;
    if(selectedOnly&&!owner.emptyTarget) {
        auto candidate=BrowserSelectionAccess::selectionCandidate(next,false);
        candidate.replaceScene(candidate.scene(),owner.targetStates().span());focus=candidate.focusBounds();
    }
    owner.pivot=focus?focus->center:context.scene->center;
    owner.applied={};owner.appliedPlan={};owner.appliedBake=false;owner.appliedEpoch.reset();
}
void rebaseTransformResult(browser_transform::Owner &owner,const SceneEdits &next) {
    const auto baseId=transformIds.take();if(!baseId)throw std::runtime_error("Transform identity exhausted");
    owner.baseId=*baseId;owner.base=next.scene();owner.states=next.maskSnapshot();owner.effectiveStates={};
    owner.acknowledged=transformContext(next);owner.applied={};owner.appliedPlan={};owner.appliedBake=false;owner.appliedEpoch.reset();
    owner.emptyTarget=owner.selectedOnly?!next.selectedCount():!next.visibleCount();
}
struct PreparedTransformChange {
    std::optional<browser_transform::Owner> owner;
    std::unique_ptr<SceneEdits> next;
    browser_transform::Job::Pointer bake;
    ResponseSummary response;
    bool applied{};
};
PreparedTransformChange prepareTransformCommand(const Json &request,const std::string &command,ResponsePreparation &prepared) {
    if(!budget)throw std::runtime_error("The scene has no resource budget");
    PreparedTransformChange change;change.owner=transformOwner;
    if(command=="beginTransform") {
        filterKeys(request,{"command","kind","selectedOnly"},true);
        if(transformOwner)throw std::runtime_error("End the current transform session first");
        if(pendingJob()||filterOwner||opacityOwner||edits->selectionDraft()||pendingSelectionMap||toleranceSession||colorSession.active())
            throw std::runtime_error("Finish the current operation before transforming");
        if(!request.at("selectedOnly").is_boolean())throw std::runtime_error("Invalid transform selection scope");
        const bool selectedOnly=request.at("selectedOnly").get<bool>();
        const auto kind=browser_transform::kind(request.at("kind").get<std::string>());
        const auto id=transformIds.take(),baseId=transformIds.take();if(!id||!baseId)throw std::runtime_error("Transform identity exhausted");
        transformAttempt(*id);browser_transform::Owner owner;
        owner.id=*id;owner.baseId=*baseId;owner.kind=kind;
        captureTransformBase(owner,*edits,selectedOnly,browser_view_scope::parse(request));change.owner=std::move(owner);
    } else {
        if(!transformOwner||!browser_transform::current(*transformOwner,transformContext(*edits))||filterInteger(request,"id")!=transformOwner->id)
            throw std::runtime_error("Transform session is stale");
        if(pendingJob())throw std::runtime_error("Finish the current transform before changing its session");
        if(command=="endTransform") {filterKeys(request,{"command","id"});change.owner.reset();}
        else {
            const auto epoch=filterInteger(request,"epoch");auto &attempt=transformAttempt(transformOwner->id);
            if(epoch<=transformOwner->epoch||epoch<=attempt.epoch)throw std::runtime_error("Transform request is stale");
            attempt.epoch=epoch;change.owner->epoch=epoch;
            const bool gizmo=transformOwner->kind==browser_transform::Kind::Gizmo;
            if(command=="rebaseTransform"||command=="undoTransform"||command=="redoTransform"||command=="cancelTransform") {
                if(!gizmo)throw std::runtime_error("A gizmo session is required");
                if(command=="rebaseTransform") {
                    filterKeys(request,{"command","id","epoch","selectedOnly"},true);
                    if(!request.at("selectedOnly").is_boolean())throw std::runtime_error("Invalid transform selection scope");
                    const auto baseId=transformIds.take();if(!baseId)throw std::runtime_error("Transform identity exhausted");
                    change.owner->baseId=*baseId;
                    captureTransformBase(*change.owner,*edits,request.at("selectedOnly").get<bool>(),browser_view_scope::parse(request));
                } else {
                    filterKeys(request,{"command","id","epoch"});
                    if(command=="cancelTransform") {
                        if(const auto &original=transformOwner->cancelBase;original&&
                           (edits->scene()!=original->scene||edits->maskSnapshot()!=original->states)) {
                            change.next=std::make_unique<SceneEdits>(*edits);
                            BrowserSelectionAccess::restoreContentScene(*change.next,original->scene,original->states,original->contentRevision);change.applied=true;
                        }
                        change.owner.reset();
                    } else {
                        const bool forward=command=="redoTransform";
                        if(!gizmoHistoryEligible(*edits,*transformOwner,forward))throw std::runtime_error("No gizmo transform history is available");
                        change.next=std::make_unique<SceneEdits>(*edits);
                        if(!(forward?change.next->redo():change.next->undo()))throw std::runtime_error("Gizmo transform history did not move");
                        rebaseTransformResult(*change.owner,*change.next);change.applied=true;
                    }
                }
            } else if(command=="resetTransform") {
                if(gizmo)throw std::runtime_error("Use Cancel to restore a gizmo session");
                filterKeys(request,{"command","id","epoch"});
                if(edits->scene()!=transformOwner->base||edits->maskSnapshot()!=transformOwner->states) {
                    change.next=std::make_unique<SceneEdits>(*edits);change.next->replaceScene(transformOwner->base,transformOwner->states.span());
                }
                change.owner->applied={};change.owner->appliedPlan={};change.owner->appliedBake=false;
                change.owner->pivot={};change.owner->appliedEpoch=epoch;change.applied=true;
            } else if(command=="applyTransform") {
                filterKeys(request,{"command","id","epoch","parameters"});
                auto parameters=browser_transform::parameters(request.at("parameters"));browser_transform::Plan plan;
                if(!browser_transform::plan(parameters,plan))throw std::runtime_error("Invalid transform parameters");
                const bool repeated=transformOwner->appliedBake&&browser_transform::same(plan,transformOwner->appliedPlan);
                const bool neutral=gizmo?(browser_transform::identity(plan)||transformOwner->emptyTarget):
                    (browser_transform::identity(plan)&&!transformOwner->base->defaultView);
                if(repeated||neutral) {
                    if(!gizmo&&!repeated&&(edits->scene()!=transformOwner->base||edits->maskSnapshot()!=transformOwner->targetStates())) {
                        change.next=std::make_unique<SceneEdits>(*edits);change.next->replaceScene(transformOwner->base,transformOwner->targetStates().span());
                    }
                    change.owner->applied=parameters;change.owner->appliedPlan=plan;change.owner->appliedBake=true;
                    change.owner->appliedEpoch=epoch;change.owner->pivot={parameters.pivot[0],parameters.pivot[1],parameters.pivot[2]};change.applied=true;
                } else change.bake=browser_transform::Job::create(*change.owner,std::move(parameters),std::move(plan),sceneMemoryForBudget(*budget,ResourceCategory::Work));
            } else throw std::runtime_error("Invalid transform command");
            if(change.applied&&change.owner) {
                const auto &next=change.next?*change.next:*edits;
                change.owner->acknowledged=transformContext(next);
                if(gizmo&&command=="applyTransform") {
                    rebaseTransformResult(*change.owner,next);
                    // A neutral/empty gizmo release only acknowledges/rebases
                    // metadata. It must not discharge an alignment Reset owner.
                    if(!change.next)change.applied=false;
                }
            }
        }
    }
    change.response=transformSummary(change.next?*change.next:*edits,change.owner,bool(change.bake));
    if(change.applied)change.response.alignment->canReset=false;
    if(!responses.summary(prepared,change.response))throw std::runtime_error("Invalid transform response");return change;
}
const char *publishTransformChange(PreparedTransformChange &change,ResponsePreparation &prepared) noexcept {
    browser_transform::Job::retire(transformJob);if(change.next)edits.swap(change.next);
    transformOwner=std::move(change.owner);transformJob=std::move(change.bake);if(checkpoint)transactionHasTransform=true;
    if(change.applied)alignmentSession.clear();floorCandidate.reset();pruneSelectionMaps();change.next.reset();
    change.response.memoryBytes=budget->usage().totalBytes;responses.summary(prepared,change.response);return responses.publish(prepared);
}
void opacityMetadata(ResponseSummary &value,const std::optional<browser_opacity::Owner> &owner) noexcept {
    value.opacitySession.reset();if(!owner)return;
    value.opacitySession=sv_response::OpacitySession{owner->id,owner->baseId,owner->epoch,owner->appliedEpoch,owner->selectedOnly,owner->appliedScale};
}
ResponseSummary opacitySummary(const SceneEdits &next,const std::optional<browser_opacity::Owner> &owner,bool pending=false) {
    auto value=filterSummary(next,filterOwner,pending);
    value.sceneChanged=checkpoint&&checkpoint->scene()!=next.scene();
    alignmentMetadata(*value.alignment,next,alignmentSession);opacityMetadata(value,owner);return value;
}
struct PreparedOpacityChange {
    std::optional<browser_opacity::Owner> owner;
    std::unique_ptr<SceneEdits> next;
    browser_opacity::Job::Pointer bake;
    ResponseSummary response;
    bool applied{};
};
PreparedOpacityChange prepareOpacityCommand(const Json &request,const std::string &command,ResponsePreparation &prepared) {
    if(!budget)throw std::runtime_error("The scene has no resource budget");
    PreparedOpacityChange change;change.owner=opacityOwner;
    if(command=="beginOpacity") {
        filterKeys(request,{"command","selectedOnly"},true);
        if(opacityOwner)throw std::runtime_error("End the current opacity session first");
        if(pendingJob()||filterOwner||transformOwner||edits->selectionDraft()||pendingSelectionMap||toleranceSession||colorSession.active())
            throw std::runtime_error("Finish the current operation before adjusting opacity");
        if(!request.at("selectedOnly").is_boolean())throw std::runtime_error("Invalid opacity selection scope");
        const bool selectedOnly=request.at("selectedOnly").get<bool>();if(selectedOnly&&!edits->selectedCount())throw std::runtime_error("Select splats first");
        const auto context=opacityContext(*edits);if(!browser_opacity::valid(context))throw std::runtime_error("Invalid opacity baseline");
        const auto id=opacityIds.take(),baseId=opacityIds.take();if(!id||!baseId)throw std::runtime_error("Opacity identity exhausted");
        opacityAttempt(*id);browser_opacity::Owner owner;owner.id=*id;owner.baseId=*baseId;owner.selectedOnly=selectedOnly;
        owner.base=context.scene;owner.states=context.states;owner.acknowledged=context;
        const auto view=browser_view_scope::parse(request);
        if(selectedOnly&&view.enabled)owner.effectiveStates=browser_view_scope::effective(*context.scene,context.states,view,sceneMemoryForBudget(*budget,ResourceCategory::Work),true);
        change.owner=std::move(owner);
    } else {
        if(!opacityOwner||!browser_opacity::current(*opacityOwner,opacityContext(*edits))||filterInteger(request,"id")!=opacityOwner->id)
            throw std::runtime_error("Opacity session is stale");
        if(pendingJob())throw std::runtime_error("Finish the current opacity bake before changing its session");
        if(command=="endOpacity") {filterKeys(request,{"command","id"});change.owner.reset();}
        else {
            const auto epoch=filterInteger(request,"epoch");auto &attempt=opacityAttempt(opacityOwner->id);
            if(epoch<=opacityOwner->epoch||epoch<=attempt.epoch)throw std::runtime_error("Opacity request is stale");
            attempt.epoch=epoch;change.owner->epoch=epoch;
            if(command=="resetOpacity") {
                filterKeys(request,{"command","id","epoch"});
                if(edits->scene()!=opacityOwner->base||edits->maskSnapshot()!=opacityOwner->states)change.bake=browser_opacity::Job::create(*change.owner,1,sceneMemoryForBudget(*budget,ResourceCategory::Work),true);
                else {change.owner->appliedScale=1;change.owner->appliedEpoch=epoch;change.applied=true;}
            } else if(command=="applyOpacity") {
                filterKeys(request,{"command","id","epoch","scale"});const auto &input=request.at("scale");
                if(!input.is_number())throw std::runtime_error("Invalid opacity scale");const auto number=input.get<double>();
                if(!std::isfinite(number)||number<0||number>5)throw std::runtime_error("Invalid opacity scale");const auto scale=float(number);
                if(scale==opacityOwner->appliedScale||scale==1) {
                    if(scale==1&&(edits->scene()!=opacityOwner->base||edits->maskSnapshot()!=opacityOwner->targetStates()))change.bake=browser_opacity::Job::create(*change.owner,scale,sceneMemoryForBudget(*budget,ResourceCategory::Work));
                    else {change.owner->appliedScale=scale;change.owner->appliedEpoch=epoch;change.applied=true;}
                } else change.bake=browser_opacity::Job::create(*change.owner,scale,sceneMemoryForBudget(*budget,ResourceCategory::Work));
            } else throw std::runtime_error("Invalid opacity command");
            if(change.applied)change.owner->acknowledged=opacityContext(change.next?*change.next:*edits);
        }
    }
    change.response=opacitySummary(change.next?*change.next:*edits,change.owner,bool(change.bake));
    if(change.applied)change.response.alignment->canReset=false;
    if(!responses.summary(prepared,change.response))throw std::runtime_error("Invalid opacity response");return change;
}
const char *publishOpacityChange(PreparedOpacityChange &change,ResponsePreparation &prepared) noexcept {
    browser_opacity::Job::retire(opacityJob);if(change.next)edits.swap(change.next);
    opacityOwner=std::move(change.owner);opacityJob=std::move(change.bake);if(checkpoint)transactionHasOpacity=true;
    if(change.applied)alignmentSession.clear();floorCandidate.reset();pruneSelectionMaps();change.next.reset();
    change.response.memoryBytes=budget->usage().totalBytes;responses.summary(prepared,change.response);return responses.publish(prepared);
}
Camera requestCamera(const Json &request) {
    Camera c;
    if(!request.contains("camera")) { c.fit(*edits->scene()); return c; }
    const auto v=request.at("camera").get<std::vector<float>>();
    if(v.size()<10 || std::any_of(v.begin(),v.end(),[](float x){return !std::isfinite(x);}))
        throw std::runtime_error("Invalid view");
    c.target={v[0],v[1],v[2]}; c.yaw=v[3]; c.pitch=v[4]; c.distance=v[5];
    c.radius=v[6]; c.fieldOfView=v[7]; c.yUp=v[8]!=0; c.roll=v[9]; return c;
}
std::pair<Camera,float> alignmentCamera(const Json &request,const char *key) {
    const auto &input=request.at(key);
    if(!input.is_array() || input.size()!=11) throw std::runtime_error("Invalid alignment view");
    std::array<float,11> values;
    for(size_t i=0;i<values.size();++i) {
        if(!input[i].is_number()) throw std::runtime_error("Invalid alignment view");
        values[i]=input[i].get<float>();
        if(!std::isfinite(values[i])) throw std::runtime_error("Invalid alignment view");
    }
    if(values[8]!=0 && values[8]!=1) throw std::runtime_error("Invalid alignment view direction");
    Camera camera;camera.target={values[0],values[1],values[2]};camera.yaw=values[3];camera.pitch=values[4];
    camera.distance=values[5];camera.radius=values[6];camera.fieldOfView=values[7];camera.yUp=values[8]!=0;camera.roll=values[9];
    browser_alignment::validateCamera(camera,values[10]);return {camera,values[10]};
}
uint64_t floorRequestId(const Json &request) {
    const auto &input=request.at("id");
    if(!input.is_number()) throw std::runtime_error("Invalid floor candidate ID");
    const auto id=input.get<double>();
    if(!std::isfinite(id)||id<1||id>9007199254740991.||std::floor(id)!=id)
        throw std::runtime_error("Invalid floor candidate ID");
    return uint64_t(id);
}
void beginFloorDetection(const Json &request,ResponsePreparation &prepared) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    if(job || morphologyJob || morphologyRangeJob || autoColorJob || checkpoint || colorSession.active())
        throw std::runtime_error("Finish the edit before detecting a floor");
    const auto context=alignmentContext(*edits);
    if(!browser_alignment::validContext(context)) throw std::runtime_error("Finish the selection before detecting a floor");
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    FloorOptions options;options.viewpoint=camera.eye();
    const bool selectedOnly=edits->selectedCount()!=0;
    const auto id=floorIds.take();if(!id) throw std::runtime_error("Floor identity exhausted");
    FloorDetection candidate{browser_floor::Job::create(context.scene,context.states,selectedOnly,options,
        sceneMemoryForBudget(*budget,ResourceCategory::Work)),floorKey(context),*id,selectedOnly};
    // Prove the fixed reply before replacing an existing candidate or job.
    auto value=summary();value.pending=true;value.progress=0;
    sv_response::Floor floor;floor.id=*id;floor.selectedOnly=selectedOnly;value.floor=floor;
    if(!responses.summary(prepared,value)) throw std::runtime_error("Invalid floor response");
    retireFloorDetection();floorCandidate.reset();floorDetection=std::move(candidate);
    value.memoryBytes=budget->usage().totalBytes;
    responses.summary(prepared,value);
}
void beginCenter(const Json &request) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    const auto context=alignmentContext(*edits);
    if(!browser_alignment::validContext(context)) throw std::runtime_error("Finish the selection before aligning");
    if(!edits->visibleCount()) throw std::runtime_error("No visible splats to align");
    const auto &point=request.at("point");
    if(!point.is_array() || point.size()!=3) throw std::runtime_error("Invalid alignment point");
    Vec3 delta;
    float *coordinates[]{&delta.x,&delta.y,&delta.z};
    for(size_t i=0;i<3;++i) {
        if(!point[i].is_number()) throw std::runtime_error("Invalid alignment point");
        *coordinates[i]=-point[i].get<float>();
        if(!std::isfinite(*coordinates[i])) throw std::runtime_error("Invalid alignment point");
    }
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    const auto [defaultCamera,defaultAspect]=alignmentCamera(request,"defaultCamera");
    const auto frame=browser_alignment::centeredFrame(context.scene->alignmentFrame,{-delta.x,-delta.y,-delta.z});
    // Desktop validates the exact requested transform before starting work.
    // Its final prepareAlignmentView carries navigation through old-to-new
    // cumulative frames and overwrites alignmentOutput.defaultView before
    // history publication. Float rounding can make that delta differ from
    // -point after successive Centers; geometry still uses the exact request.
    browser_alignment::translatedCamera(camera,delta,aspect);
    browser_alignment::translatedCamera(defaultCamera,delta,defaultAspect);
    const auto alignedCamera=browser_alignment::carriedCamera(camera,context.scene->alignmentFrame,frame,aspect);
    const auto alignedDefault=browser_alignment::carriedCamera(defaultCamera,context.scene->alignmentFrame,frame,defaultAspect);
    EditJob candidate;
    candidate.alignment.emplace(AlignmentRequest{context,alignmentSession,delta,alignedCamera,alignedDefault,aspect,defaultAspect});
    if(!candidate.alignment->session.begin(context)) throw std::runtime_error("The alignment session could not start");
    // Identity Center is an accepted alignment branch, even when its matrix
    // equals the previous frame. Reserve IDs outside rollback state before any
    // writable payload allocation; failure/cancel never recycles an attempt.
    const auto branch=alignmentIds.take();
    if(!branch) throw std::runtime_error("Alignment identity exhausted");
    candidate.working=std::make_shared<Scene>(*context.scene);
    candidate.working->alignmentFrame=frame;candidate.working->defaultView=alignedDefault.savedView();
    candidate.working->previewEye.reset();
    if(!alignmentLineage.associate(candidate.working,*branch)) throw std::runtime_error("Alignment history is full");
    job=std::move(candidate);
}
void beginScale(const Json &request) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    const auto context=alignmentContext(*edits);
    if(!browser_alignment::validContext(context)) throw std::runtime_error("Finish the selection before aligning");
    if(!edits->visibleCount()) throw std::runtime_error("No visible splats to align");
    const auto &points=request.at("points");
    if(!points.is_array() || points.size()!=2) throw std::runtime_error("Choose two distinct points and a positive target distance.");
    std::array<Vec3,2> picked;
    for(size_t point=0;point<2;++point) {
        if(!points[point].is_array() || points[point].size()!=3) throw std::runtime_error("Invalid alignment point");
        float *coordinates[]{&picked[point].x,&picked[point].y,&picked[point].z};
        for(size_t axis=0;axis<3;++axis) {
            if(!points[point][axis].is_number()) throw std::runtime_error("Invalid alignment point");
            *coordinates[axis]=points[point][axis].get<float>();
            if(!std::isfinite(*coordinates[axis])) throw std::runtime_error("Invalid alignment point");
        }
    }
    if(!request.at("target").is_number()) throw std::runtime_error("Choose two distinct points and a positive target distance.");
    const auto transform=scaleFromPoints(picked[0],picked[1],request.at("target").get<float>());
    const auto affine=processing_detail::transform(transform);
    const auto frame=browser_alignment_frame::compose(context.scene->alignmentFrame,transform);
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    const auto [defaultCamera,defaultAspect]=alignmentCamera(request,"defaultCamera");
    browser_camera_transform::transformed(camera,transform,aspect);
    browser_camera_transform::transformed(defaultCamera,transform,defaultAspect);
    const auto alignedCamera=browser_alignment::carriedCamera(camera,context.scene->alignmentFrame,frame,aspect);
    const auto alignedDefault=browser_alignment::carriedCamera(defaultCamera,context.scene->alignmentFrame,frame,defaultAspect);
    EditJob candidate;candidate.affine=affine;
    candidate.alignment.emplace(AlignmentRequest{context,alignmentSession,{},alignedCamera,alignedDefault,aspect,defaultAspect});
    if(!candidate.alignment->session.begin(context)) throw std::runtime_error("The alignment session could not start");
    const auto branch=alignmentIds.take();if(!branch) throw std::runtime_error("Alignment identity exhausted");
    candidate.working=std::make_shared<Scene>(*context.scene);
    candidate.working->alignmentFrame=frame;candidate.working->defaultView=alignedDefault.savedView();candidate.working->previewEye.reset();
    if(!alignmentLineage.associate(candidate.working,*branch)) throw std::runtime_error("Alignment history is full");
    job=std::move(candidate);
}
std::array<Vec3,3> planePoints(const Json &request) {
    const auto &input=request.at("points");
    if(!input.is_array() || input.size()!=3) throw std::runtime_error("Choose three points on the scene.");
    std::array<Vec3,3> points;
    for(size_t p=0;p<3;++p) {
        if(!input[p].is_array() || input[p].size()!=3) throw std::runtime_error("Invalid alignment point");
        float *axes[]{&points[p].x,&points[p].y,&points[p].z};
        for(size_t axis=0;axis<3;++axis) {
            if(!input[p][axis].is_number()) throw std::runtime_error("Invalid alignment point");
            *axes[axis]=input[p][axis].get<float>();if(!std::isfinite(*axes[axis])) throw std::runtime_error("Invalid alignment point");
        }
    }
    return points;
}
void beginPlane(const Json &request) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    const auto context=alignmentContext(*edits);
    if(!browser_alignment::validContext(context)) throw std::runtime_error("Finish the selection before aligning");
    if(!edits->visibleCount()) throw std::runtime_error("No visible splats to align");
    const auto points=planePoints(request);browser_alignment::planeNormal(points);
    if(!request.at("flip").is_boolean()) throw std::runtime_error("Invalid alignment normal direction");
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    const auto [defaultCamera,defaultAspect]=alignmentCamera(request,"defaultCamera");
    const auto transform=alignFromPoints(points[0],points[1],points[2],request.at("flip").get<bool>()!=!camera.yUp);
    const auto affine=processing_detail::transform(transform);
    const auto frame=browser_alignment_frame::compose(context.scene->alignmentFrame,transform);
    using browser_camera_transform::Policy;
    browser_camera_transform::transformed(camera,transform,aspect,Policy::WorldUpright);
    browser_camera_transform::transformed(defaultCamera,transform,defaultAspect,Policy::WorldUpright);
    const auto delta=browser_alignment_frame::change(context.scene->alignmentFrame,frame);
    const auto alignedCamera=browser_camera_transform::transformed(camera,delta,aspect,Policy::WorldUpright);
    const auto alignedDefault=browser_camera_transform::transformed(defaultCamera,delta,defaultAspect,Policy::WorldUpright);
    EditJob candidate;candidate.affine=affine;candidate.shRotation.emplace(affine,std::min(context.scene->shDegree,3u));
    candidate.alignment.emplace(AlignmentRequest{context,alignmentSession,{},alignedCamera,alignedDefault,aspect,defaultAspect});
    if(!candidate.alignment->session.begin(context)) throw std::runtime_error("The alignment session could not start");
    const auto branch=alignmentIds.take();if(!branch) throw std::runtime_error("Alignment identity exhausted");
    candidate.working=std::make_shared<Scene>(*context.scene);candidate.working->alignmentFrame=frame;
    candidate.working->defaultView=alignedDefault.savedView();candidate.working->previewEye.reset();
    if(!alignmentLineage.associate(candidate.working,*branch)) throw std::runtime_error("Alignment history is full");
    job=std::move(candidate);
}
void beginFloor(const Json &request) {
    if(!budget) throw std::runtime_error("The scene has no resource budget");
    const auto id=floorRequestId(request);
    if(!floorCandidate || floorCandidate->id!=id || !floorCandidate->plane || !currentFloor(floorCandidate->key))
        throw std::runtime_error("Floor candidate is stale");
    const auto context=alignmentContext(*edits);
    if(!browser_alignment::validContext(context)) throw std::runtime_error("Finish the selection before aligning");
    if(!edits->visibleCount()) throw std::runtime_error("No visible splats to align");
    if(!browser_floor::validPlane(*floorCandidate->plane,context.scene->gaussians.size()))
        throw std::runtime_error("Invalid floor candidate");
    if(!request.at("flip").is_boolean()) throw std::runtime_error("Invalid alignment normal direction");
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    const auto [defaultCamera,defaultAspect]=alignmentCamera(request,"defaultCamera");
    // The portable alignFloor/level body is byte-equal to the captured R0
    // geometry_tools kernel; no browser-supplied plane enters this path.
    const auto transform=alignFloor(*floorCandidate->plane,request.at("flip").get<bool>()!=!camera.yUp);
    const auto affine=processing_detail::transform(transform);
    const auto frame=browser_alignment_frame::compose(context.scene->alignmentFrame,transform);
    using browser_camera_transform::Policy;
    browser_camera_transform::transformed(camera,transform,aspect,Policy::WorldUpright);
    browser_camera_transform::transformed(defaultCamera,transform,defaultAspect,Policy::WorldUpright);
    const auto delta=browser_alignment_frame::change(context.scene->alignmentFrame,frame);
    const auto alignedCamera=browser_camera_transform::transformed(camera,delta,aspect,Policy::WorldUpright);
    const auto alignedDefault=browser_camera_transform::transformed(defaultCamera,delta,defaultAspect,Policy::WorldUpright);
    EditJob candidate;candidate.affine=affine;candidate.shRotation.emplace(affine,std::min(context.scene->shDegree,3u));
    candidate.alignment.emplace(AlignmentRequest{context,alignmentSession,{},alignedCamera,alignedDefault,aspect,defaultAspect});
    candidate.alignment->floorId=id;
    if(!candidate.alignment->session.begin(context)) throw std::runtime_error("The alignment session could not start");
    const auto branch=alignmentIds.take();if(!branch) throw std::runtime_error("Alignment identity exhausted");
    candidate.working=std::make_shared<Scene>(*context.scene);candidate.working->alignmentFrame=frame;
    candidate.working->defaultView=alignedDefault.savedView();candidate.working->previewEye.reset();
    if(!alignmentLineage.associate(candidate.working,*branch)) throw std::runtime_error("Alignment history is full");
    job=std::move(candidate);
}
ResponseSummary alignmentSummary(const SceneEdits &owner,const browser_alignment::Session &session) {
    auto value=sceneSummary(*owner.scene(),&owner,budget ? &*budget : nullptr);
    retainedExportMetadata(value);
    value.transaction=bool(checkpoint);value.sceneChanged=checkpoint && checkpoint->scene()!=owner.scene();
    alignmentMetadata(*value.alignment,owner,session);
    // A scene replacement invalidates current maps; transaction owners remain
    // available for exact GPU/native rollback and are still charged/reported.
    const std::array<std::shared_ptr<const BrowserSelectionMap>,2> maps{
        transactionSelectionMap,transactionTolerance ? transactionTolerance->map : nullptr};
    for(size_t i=0;i<maps.size();++i) if(maps[i] && (i==0 || maps[i]!=maps[0])) {
        value.selectionMapBytes+=maps[i]->retainedBytes();
        value.selectionMapRetainedIds[value.selectionMapRetainedCount++]=maps[i]->header.mapId;
    }
    return value;
}
void resetAlignment(const Json &request,ResponsePreparation &prepared) {
    const auto before=alignmentContext(*edits);
    if(!browser_alignment::validContext(before)) throw std::runtime_error("Finish the selection before resetting alignment");
    const auto [camera,aspect]=alignmentCamera(request,"camera");
    const auto [defaultCamera,defaultAspect]=alignmentCamera(request,"defaultCamera");
    if(!alignmentSession.canReset(before)) {
        auto value=summary();value.floor.reset();
        if(!responses.summary(prepared,value)) throw std::runtime_error("Invalid alignment response");
        floorCandidate.reset();value.memoryBytes=budget->usage().totalBytes;responses.summary(prepared,value);
        return;
    }
    const auto base=alignmentSession.baseline();
    browser_alignment::carriedCamera(camera,before.scene->alignmentFrame,base->alignmentFrame,aspect);
    browser_alignment::carriedCamera(defaultCamera,before.scene->alignmentFrame,base->alignmentFrame,defaultAspect);
    browser_alignment::validateSceneCamera(*base,defaultAspect);
    auto next=std::make_unique<SceneEdits>(*edits);
    next->replaceScene(base,alignmentSession.baselineStates());
    auto nextSession=alignmentSession;
    if(!nextSession.acknowledge(before,alignmentContext(*next))) throw std::runtime_error("The alignment reset is stale");
    auto value=alignmentSummary(*next,nextSession);
    if(!responses.summary(prepared,value)) throw std::runtime_error("Invalid alignment response");
    // All allocation, matrix/camera/state/history and bounded-response work is
    // complete. These swaps and owner retirement cannot throw.
    edits.swap(next);alignmentSession=std::move(nextSession);
    floorCandidate.reset();
    selectionMap.reset();pendingSelectionMap.reset();toleranceSession.reset();next.reset();
    value.memoryBytes=budget->usage().totalBytes;
    responses.summary(prepared,value); // Same proved topology; fixed storage, no allocation.
}
SelectOperation operation(const Json &request) {
    const auto value=request.value("operation",0);
    if(value<0 || value>3) throw std::runtime_error("Invalid selection combination");
    return static_cast<SelectOperation>(value);
}
void restoreSelectionBaseline(const Json &request) {
    if(!request.value("fromBaseline",false)) return;
    if(!edits->selectionDraft()) throw std::runtime_error("No selection gesture is active");
    // The portable extraction predates Windows' live-area controller. Reuse its
    // native draft and region algorithms from the original mask on every update,
    // including shrinking Replace/Add/Subtract/Intersect regions.
    edits->cancelSelectionDraft(); edits->beginSelectionDraft();
}
std::array<float,3> selectionColor(const Gaussian &g, unsigned degree, Vec3 eye) {
    // Float SH evaluation reconciles Windows' color picker with the portable
    // renderer/rotation coefficient order, including its zero-length fallback.
    std::array<float,16> basis{.2820947918f};
    if(degree) {
        const auto &p=g.positionOpacity;
        float x=p[0]-eye.x,y=p[1]-eye.y,z=p[2]-eye.z;
        const float length=std::sqrt(x*x+y*y+z*z);
        if(length>0) { x/=length; y/=length; z/=length; }
        else { x=0; y=0; z=1; }
        const float xx=x*x,yy=y*y,zz=z*z;
        basis={.28209479177387814f,
            -.4886025119029199f*y,.4886025119029199f*z,-.4886025119029199f*x,
            1.0925484305920792f*x*y,-1.0925484305920792f*y*z,
            .31539156525252005f*(2*zz-xx-yy),-1.0925484305920792f*x*z,.5462742152960396f*(xx-yy),
            -.5900435899266435f*y*(3*xx-yy),2.890611442640554f*x*y*z,
            -.4570457994644658f*y*(4*zz-xx-yy),.3731763325901154f*z*(2*zz-3*xx-3*yy),
            -.4570457994644658f*x*(4*zz-xx-yy),1.445305721320277f*z*(xx-yy),
            -.5900435899266435f*x*(xx-3*yy)};
    }
    std::array<float,3> color{.5f,.5f,.5f};
    for(unsigned j=0;j<(degree+1)*(degree+1);++j)
        for(unsigned c=0;c<3;++c) color[c]+=basis[j]*shValue(g,j,c);
    for(auto &channel:color) channel=std::clamp(channel,0.f,1.f);
    return color;
}
std::optional<uint32_t> requestIndex(const Json &request) {
    if(!request.contains("index") || request["index"].is_null()) return {};
    return request["index"].get<uint32_t>();
}
SceneVector<uint8_t> colorStates(std::span<const uint8_t> baseline,const Camera &camera,uint32_t index,
                                float tolerance,SelectOperation combine,std::span<const uint8_t> footprint = {},browser_view_scope::Scope view={},
                                browser_selection_range::Config range={}) {
    const auto scene=edits->scene();
    SceneVector<uint8_t> states{SceneAllocator<uint8_t>{sceneMemoryForBudget(*budget,ResourceCategory::Work)}};
    states.assign(baseline.begin(),baseline.end());
    {
        const unsigned degree=std::min(scene->shDegree,3u);
        const auto eye=camera.eye();
        const bool seedEligible=view.contains(scene->gaussians[index]);
        const auto target=seedEligible?selectionColor(scene->gaussians[index],degree,eye):std::array<float,3>{};
        const float limit=std::clamp(tolerance,0.f,1.f),squaredTolerance=3*limit*limit;
        for(size_t i=0;i<states.size();++i) {
            if(states[i]&2) continue;
            const bool eligible=view.contains(scene->gaussians[i]);
            if(!eligible){states[i]=0;continue;}
            const auto value=selectionColor(scene->gaussians[i],degree,eye);
            float distance=0;
            for(unsigned c=0;c<3;++c) distance+=(value[c]-target[c])*(value[c]-target[c]);
            const bool inside=seedEligible&&eligible&&distance<=squaredTolerance && (footprint.empty() || (footprint[i]&1));
            states[i]=browser_selection_range::combineState(states[i],inside,scene->gaussians[i],range,combine);
        }
    }
    return states;
}
void selectColor(const Json &request) {
    const auto camera=requestCamera(request);
    const auto index=requestIndex(request);
    const auto combine=operation(request);
    const auto tolerance=request.at("tolerance").get<float>();
    if(!std::isfinite(tolerance)) return;
    const bool fromBaseline=request.value("fromBaseline",false);
    if(fromBaseline && !edits->selectionDraft()) throw std::runtime_error("No selection gesture is active");
    const auto scene=edits->scene();
    const auto baseline=fromBaseline ? edits->selectionBaseline() : edits->states();
    if(!index || *index>=baseline.size() || (baseline[*index]&2)) {
        if(fromBaseline) edits->replaceScene(scene,baseline);
        return;
    }
    // The same-scene native replacement retains the portable live draft.
    auto states=colorStates(baseline,camera,*index,tolerance,combine,{},BrowserSelectionAccess::selectionView(*edits));
    edits->replaceScene(scene,states);
}
uint64_t requestSessionId(const Json &request) {
    const auto &value=request.at("sessionId");
    if(!value.is_number_integer() || (value.is_number_integer() && !value.is_number_unsigned() && value.get<int64_t>()<=0))
        throw std::runtime_error("Invalid Color tolerance session ID");
    const auto id=value.get<uint64_t>();
    if(id==0 || id>9007199254740991ULL) throw std::runtime_error("Invalid Color tolerance session ID");
    return id;
}
browser_selection_range::Config requestedRange(const Json &request,std::optional<Vec3> center={}) {
    browser_selection_range::Config config;config.center=center;
    if(request.contains("center")||request.contains("rangeCenter"))throw std::runtime_error("Range center is captured by the native click");
    const bool enabled=request.contains("rangeEnabled"),radius=request.contains("rangeRadius");
    if(enabled!=radius)throw std::runtime_error("Range enabled and radius must be supplied together");
    if(!enabled)return config; // Legacy omission is absolute disabled/null.
    if(!request.at("rangeEnabled").is_boolean())throw std::runtime_error("Invalid Range enabled flag");
    config.enabled=request.at("rangeEnabled").get<bool>();
    const auto &value=request.at("rangeRadius");
    if(!value.is_null()) {
        if(!value.is_number())throw std::runtime_error("Invalid Range radius");const auto r=value.get<double>();
        if(!std::isfinite(r)||r<=0||!std::isfinite(float(r))||double(float(r))!=r)throw std::runtime_error("Range radius must be positive finite float32");
        config.radius=float(r);
    }
    if(config.enabled&&!config.radius)throw std::runtime_error("Enabled Range requires a radius");
    return config;
}
void prepareToleranceResponse(const ColorToleranceSession &candidate,const BrowserSelectionAccess::Adjustment &change,
                              ResponsePreparation &prepared) {
    auto value=summary();value.selected=change.selected;value.revision=change.revision;
    value.selectionCommitRevision=change.selectionCommitRevision;value.canUndo=change.canUndo;value.canRedo=change.canRedo;
    value.undoSelectionRevision=change.undoSelectionRevision;
    value.toleranceSessionId=candidate.sessionId;value.toleranceTool=candidate.fill?sv_response::ToleranceTool::Fill:sv_response::ToleranceTool::Color;
    value.toleranceConnected=candidate.fill?std::nullopt:std::optional<bool>(candidate.connected);
    value.toleranceRange=toleranceRange(candidate);value.toleranceRecorded=change.recorded;value.toleranceMapId.reset();
    if(candidate.map)value.toleranceMapId=candidate.map->header.mapId;
    auto maps=retainedSelectionMaps();maps[3]=candidate.map;value.selectionMapBytes=0;value.selectionMapRetainedCount=0;
    for(size_t i=0;i<maps.size();++i)if(maps[i]) {
        bool duplicate=false;for(size_t j=0;j<i;++j)duplicate|=maps[j]==maps[i];
        if(!duplicate){value.selectionMapBytes+=maps[i]->retainedBytes();value.selectionMapRetainedIds[value.selectionMapRetainedCount++]=maps[i]->header.mapId;}
    }
    value.memoryBytes=budget->usage().totalBytes;
    if(!responses.summary(prepared,value))throw std::runtime_error("Invalid completed Range selection response");
}
void publishTolerance(ColorToleranceSession candidate,std::span<const uint8_t> states,ResponsePreparation &prepared) {
    bool preparedReply=false;
    BrowserSelectionAccess::adjust(*edits,candidate.checkpoint,states,[&](const auto &change){prepareToleranceResponse(candidate,change,prepared);preparedReply=true;});
    if(!preparedReply)throw std::runtime_error("Invalid completed Range selection candidate");
    toleranceSession=std::move(candidate);
}
uint64_t selectionMapId(const Json &request) {
    const auto &value=request.at("mapId");
    if(!value.is_number_integer() || (!value.is_number_unsigned() && value.get<int64_t>()<=0))
        throw std::runtime_error("Invalid selection map ID");
    const auto id=value.get<uint64_t>();
    if(!id || id>9007199254740991ULL) throw std::runtime_error("Invalid selection map ID");
    return id;
}
uint32_t mapDimension(const Json &request,const char *key) {
    const auto &value=request.at(key);
    if(!value.is_number_integer() || (!value.is_number_unsigned() && value.get<int64_t>()<0) ||
       value.get<uint64_t>()>std::numeric_limits<uint32_t>::max())
        throw std::runtime_error("Invalid selection map header integer");
    return value.get<uint32_t>();
}
void beginSelectionMap(const Json &request) {
    const auto id=selectionMapId(request);
    if(id<=lastSelectionMapId) throw std::runtime_error("Selection map ID was already attempted");
    lastSelectionMapId=id;
    if(checkpoint || pendingJob()) throw std::runtime_error("Finish the edit before uploading a selection map");
    BrowserSelectionMapHeader header{id,mapDimension(request,"layoutVersion"),mapDimension(request,"fullWidth"),
        mapDimension(request,"fullHeight"),mapDimension(request,"mapWidth"),mapDimension(request,"mapHeight"),
        mapDimension(request,"sourceCount"),mapDimension(request,"channels")};
    // A failed new allocation leaves both previous active and pending owners.
    auto candidate=std::make_shared<BrowserSelectionMap>(header,*edits,
        sceneMemoryForBudget(*budget,ResourceCategory::Work));
    pendingSelectionMap=std::move(candidate);
}
void commitSelectionMap(const Json &request) {
    const auto id=selectionMapId(request);
    if(checkpoint || pendingJob()) throw std::runtime_error("Finish the edit before adopting a selection map");
    pruneSelectionMaps();
    if(!pendingSelectionMap || pendingSelectionMap->header.mapId!=id)
        throw std::runtime_error("Selection map upload is stale");
    pendingSelectionMap->validateComplete();
    // Validation is complete; replacement and retirement allocate no storage.
    selectionMap=std::move(pendingSelectionMap);
}
const BrowserSelectionMap &consumerSelectionMap(const Json &request,unsigned width,unsigned height,bool visible) {
    const auto id=selectionMapId(request);
    if(!selectionMap || selectionMap->header.mapId!=id || !selectionMap->current(*edits))
        throw std::runtime_error("Selection map is stale");
    if(selectionMap->header.fullWidth!=width || selectionMap->header.fullHeight!=height)
        throw std::runtime_error("Selection viewport does not match the adopted map");
    if(visible && !(selectionMap->header.channels&BrowserSelectionMap::visibleChannel))
        throw std::runtime_error("A global visibility channel is required for this selection");
    return *selectionMap;
}
SceneVector<PointI> consumerPoints(const Json &request,size_t limit) {
    const auto &input=request.at("points");
    if(!input.is_array() || input.size()>limit) throw std::runtime_error("Selection path exceeds point budget");
    SceneVector<PointI> points{SceneAllocator<PointI>{sceneMemoryForBudget(*budget,ResourceCategory::Work)}};
    points.reserve(input.size());
    for(const auto &point:input) {
        if(!point.is_array() || point.size()!=2) throw std::runtime_error("Invalid selection path point");
        const auto coordinate=[](const Json &value) {
            if(!value.is_number_integer() || (value.is_number_unsigned() && value.get<uint64_t>()>uint64_t(INT32_MAX)) ||
               (!value.is_number_unsigned() && (value.get<int64_t>()<INT32_MIN || value.get<int64_t>()>INT32_MAX)))
                throw std::runtime_error("Selection path coordinates must be int32");
            return value.get<int32_t>();
        };
        points.push_back({coordinate(point[0]),coordinate(point[1])});
    }
    return points;
}
PointI fillSeed(const Json &request) {
    const auto &seed=request.at("seed");
    if(!seed.is_array() || seed.size()!=2) throw std::runtime_error("Invalid Fill seed");
    PointI result;
    for(unsigned i=0;i<2;++i) {
        const auto &value=seed[i];
        if(!value.is_number_integer() || (value.is_number_unsigned() && value.get<uint64_t>()>uint64_t(INT32_MAX)) ||
           (!value.is_number_unsigned() && (value.get<int64_t>()<INT32_MIN || value.get<int64_t>()>INT32_MAX)))
            throw std::runtime_error("Fill seed coordinates must be int32");
        (i ? result.y : result.x)=value.get<int32_t>();
    }
    return result;
}
void captureColorView(ColorToleranceSession &session,const Json &request) {
    const bool metadata=request.contains("width") || request.contains("height") || request.contains("seed");
    if(!metadata) return; // Older ordinary callers cannot enable Connected later.
    session.width=mapDimension(request,"width"); session.height=mapDimension(request,"height");
    session.seed=fillSeed(request);
    if(!session.width || !session.height || session.width>unsigned(INT32_MAX) || session.height>unsigned(INT32_MAX) ||
       !request.contains("camera") || session.camera.distance<=0 || session.camera.radius<=0 ||
       session.camera.fieldOfView<10 || session.camera.fieldOfView>120)
        throw std::runtime_error("Invalid captured Color view");
}
bool acquireConnectedMap(ColorToleranceSession &session,const Json &request) {
    if(!session.width || !session.height) throw std::runtime_error("Color pick has no captured viewport and seed");
    if(session.map) {
        if(request.contains("mapId") && selectionMapId(request)!=session.map->header.mapId)
            throw std::runtime_error("Connected Color cannot replace its captured map");
        if(!session.map->current(*edits)) throw std::runtime_error("Connected Color map is stale");
    } else {
        const auto &map=consumerSelectionMap(request,session.width,session.height,true);
        if(!(map.header.channels&BrowserSelectionMap::rgbChannel))
            throw std::runtime_error("A raw RGB channel is required for Connected Color");
        session.map=selectionMap;
    }
    const auto &h=session.map->header;
    if(h.fullWidth!=session.width || h.fullHeight!=session.height)
        throw std::runtime_error("Connected Color viewport does not match its captured map");
    if(session.seed.x<0 || session.seed.y<0 || unsigned(session.seed.x)>=session.width || unsigned(session.seed.y)>=session.height)
        return false;
    const size_t at=size_t(uint64_t(session.seed.y)*h.mapHeight/session.height)*h.mapWidth+
        size_t(uint64_t(session.seed.x)*h.mapWidth/session.width);
    return session.map->opacities[at]>=1.f/255;
}
SceneVector<uint8_t> colorSessionStates(const ColorToleranceSession &session,float tolerance) {
    if(!session.connected)
        return colorStates(session.checkpoint.states.span(),session.camera,session.index,tolerance,session.operation,{},session.selectionView,session.range);
    auto candidate=BrowserSelectionAccess::checkpointCandidate(*edits,session.checkpoint);
    BrowserSelectionAccess::selectionView(candidate,session.selectionView);
    const auto map=borrowedSelectionMap(*session.map);
    // Set derives the native visible/touched hit mask only. The final Combine
    // is applied once, after intersecting these hits with exact contributor SH.
    BrowserSelectionAccess::flood(candidate,session.camera,session.width,session.height,session.seed,tolerance,
        SelectOperation::Set,{true,true},map,session.map->colors);
    return colorStates(session.checkpoint.states.span(),session.camera,session.index,tolerance,session.operation,
        candidate.states(),session.selectionView,session.range);
}
void colorPick(const Json &request,ResponsePreparation &prepared) {
    const auto id=requestSessionId(request);
    if(id<=lastToleranceSessionId) throw std::runtime_error("Color tolerance session ID was already attempted");
    lastToleranceSessionId=id;
    auto range=requestedRange(request);
    const auto camera=requestCamera(request);
    const auto index=requestIndex(request);
    const auto combine=operation(request);
    const auto tolerance=request.at("tolerance").get<float>();
    const auto baseline=edits->states();
    // Missing contributors retain the last completed click and consume the ID.
    if(!std::isfinite(tolerance) || !index || *index>=baseline.size() || (baseline[*index]&2)) return;
    if(edits->selectionDraft()) throw std::runtime_error("Finish the selection gesture before picking a color");
    ColorToleranceSession candidate{BrowserSelectionAccess::capture(*edits),camera,*index,combine,id};
    const auto &position=edits->scene()->gaussians[*index].positionOpacity;
    range.center=Vec3{position[0],position[1],position[2]};candidate.range=range;
    if(!browser_selection_range::valid(candidate.range))throw std::runtime_error("Invalid captured Color Range");
    candidate.selectionView=browser_view_scope::parse(request);
    captureColorView(candidate,request);
    candidate.connected=request.value("connected",false);
    if(candidate.connected && !acquireConnectedMap(candidate,request)) {
        // The viewer replaces its Color owner as soon as a contributor exists.
        // A transparent downsampled map seed then leaves the freshly captured
        // pre-click baseline unchanged, but still owns this new checkpoint/map.
        // Explicit off-viewport direct calls cannot be browser contributor picks.
        if(candidate.seed.x<0 || candidate.seed.y<0 || unsigned(candidate.seed.x)>=candidate.width ||
           unsigned(candidate.seed.y)>=candidate.height) return;
        publishTolerance(std::move(candidate),baseline,prepared);
        return;
    }
    auto states=colorSessionStates(candidate,tolerance);
    publishTolerance(std::move(candidate),states,prepared);
}
void colorTolerance(const Json &request,ResponsePreparation &prepared) {
    const auto id=requestSessionId(request);
    if(!toleranceSession || toleranceSession->fill || toleranceSession->sessionId!=id ||
       !BrowserSelectionAccess::current(*edits,toleranceSession->checkpoint))
        throw std::runtime_error("Color tolerance checkpoint is stale");
    const auto tolerance=request.at("tolerance").get<float>();
    if(!std::isfinite(tolerance)) return;
    // Stage metadata and map ownership as well as all admitted mask/history
    // allocations. A refusal cannot toggle the previous authoritative owner.
    auto candidate=*toleranceSession;
    candidate.range=requestedRange(request,candidate.range.center);
    if(!browser_selection_range::valid(candidate.range))throw std::runtime_error("Invalid amended Color Range");
    // Legacy tolerance callers supplied ignored replacement pick inputs. Keep
    // that additive ABI behavior when Range is omitted; explicit Range callers
    // must send only amendments, and neither path can replace frozen inputs.
    const bool explicitRange=request.contains("rangeEnabled")||request.contains("rangeRadius");
    if(request.contains("sampleRadiusPixels") || (explicitRange &&
       (request.contains("camera")||request.contains("seed")||request.contains("width")||request.contains("height")||
        request.contains("index")||request.contains("operation")||request.contains("selectionView"))))
        throw std::runtime_error("Color amendment cannot replace captured input");
    candidate.connected=request.value("connected",candidate.connected);
    if(request.contains("mapId") && candidate.map && selectionMapId(request)!=candidate.map->header.mapId)
        throw std::runtime_error("Connected Color cannot replace its captured map");
    if(candidate.connected) {
        if(!acquireConnectedMap(candidate,request)) {
            // The Windows viewer evaluates amendments in a preview initialized
            // from the original checkpoint, then adjusts even when the direct
            // selector returns false for an empty seed. Preserve that baseline
            // result, requested mode and admitted map.
            const auto baseline=candidate.checkpoint.states;
            publishTolerance(std::move(candidate),baseline.span(),prepared);
            return;
        }
    } else if(request.contains("mapId") && !candidate.map) {
        throw std::runtime_error("A map can only be captured when enabling Connected Color");
    }
    auto states=colorSessionStates(candidate,tolerance);
    publishTolerance(std::move(candidate),states,prepared);
}
SceneVector<uint8_t> fillStates(const ColorToleranceSession &session,float tolerance) {
    SceneVector<uint8_t> states{SceneAllocator<uint8_t>{sceneMemoryForBudget(*budget,ResourceCategory::Work)}};
    if(session.range.enabled&&!session.range.center) {
        // A previously accepted centerless disabled Fill can enable Range. Its
        // empty amendment restores the original checkpoint and removes any
        // now-empty click Undo while retaining the requested completed owner.
        states.assign(session.checkpoint.states.begin(),session.checkpoint.states.end());return states;
    }
    auto candidate=BrowserSelectionAccess::checkpointCandidate(*edits,session.checkpoint);
    BrowserSelectionAccess::selectionView(candidate,session.selectionView);
    const auto map=borrowedSelectionMap(*session.map);
    BrowserSelectionAccess::flood(candidate,session.camera,session.width,session.height,session.seed,tolerance,
        session.range.enabled?SelectOperation::Set:session.operation,session.options,map);
    states.assign(candidate.states().begin(),candidate.states().end());
    if(session.range.enabled)for(size_t i=0;i<states.size();++i) {
        const auto before=session.checkpoint.states[i];
        if(before&2){states[i]=before;continue;}
        const auto &g=edits->scene()->gaussians[i];
        states[i]=session.selectionView.contains(g)?browser_selection_range::combineState(before,(states[i]&1)!=0,g,session.range,session.operation):0;
    }
    return states;
}
void fillPick(const Json &request,ResponsePreparation &prepared) {
    const auto id=requestSessionId(request);
    if(id<=lastToleranceSessionId) throw std::runtime_error("Tolerance session ID was already attempted");
    lastToleranceSessionId=id;
    auto range=requestedRange(request);
    std::optional<float> sampleRadius;
    if(request.contains("sampleRadiusPixels")) {
        const auto &input=request.at("sampleRadiusPixels");if(!input.is_number())throw std::runtime_error("Invalid Fill physical sample radius");
        const auto value=input.get<double>();
        if(!std::isfinite(value)||value<=0||!std::isfinite(float(value))||float(value)<=0)throw std::runtime_error("Invalid Fill physical sample radius");
        sampleRadius=float(value);
    }
    if(range.enabled&&!sampleRadius)throw std::runtime_error("Enabled Fill Range requires a captured physical sample radius");
    const auto width=mapDimension(request,"width"),height=mapDimension(request,"height");
    if(!width || !height || width>unsigned(INT32_MAX) || height>unsigned(INT32_MAX))
        throw std::runtime_error("Invalid Fill viewport");
    const SelectionOptions options{request.value("visibleOnly",false),request.value("overlap",false)};
    const auto &source=consumerSelectionMap(request,width,height,options.visibleOnly);
    if(!request.contains("camera")) throw std::runtime_error("A captured camera is required for Fill");
    const auto camera=requestCamera(request);
    if(camera.distance<=0 || camera.radius<=0 || camera.fieldOfView<10 || camera.fieldOfView>120)
        throw std::runtime_error("Invalid Fill camera");
    const auto seed=fillSeed(request);
    const auto tolerance=request.at("tolerance").get<float>();
    if(!std::isfinite(tolerance) || seed.x<0 || seed.y<0 || unsigned(seed.x)>=width || unsigned(seed.y)>=height) return;
    const auto index=size_t(uint64_t(seed.y)*source.header.mapHeight/height)*source.header.mapWidth+
        size_t(uint64_t(seed.x)*source.header.mapWidth/width);
    if(source.opacities[index]<1.f/255) return;
    if(edits->selectionDraft()) throw std::runtime_error("Finish the selection gesture before Fill");
    ColorToleranceSession candidate{BrowserSelectionAccess::capture(*edits),camera,0,operation(request),id,
        true,selectionMap,seed,width,height,options};
    candidate.selectionView=browser_view_scope::parse(request);
    if(sampleRadius)if(const auto sample=volumeSampleAt(camera,borrowedSelectionMap(source),width,height,seed,*sampleRadius))range.center=sample->center;
    candidate.range=range;
    if(!browser_selection_range::valid(candidate.range))throw std::runtime_error("Enabled Fill Range has no captured surface center");
    auto states=fillStates(candidate,tolerance);
    publishTolerance(std::move(candidate),states,prepared);
}
void fillTolerance(const Json &request,ResponsePreparation &prepared) {
    const auto id=requestSessionId(request);
    if(!toleranceSession || !toleranceSession->fill || toleranceSession->sessionId!=id ||
       !BrowserSelectionAccess::current(*edits,toleranceSession->checkpoint) || !toleranceSession->map->current(*edits))
        throw std::runtime_error("Fill tolerance checkpoint is stale");
    const auto tolerance=request.at("tolerance").get<float>();
    if(!std::isfinite(tolerance)) return;
    const bool explicitRange=request.contains("rangeEnabled")||request.contains("rangeRadius");
    if(request.contains("sampleRadiusPixels") || (explicitRange &&
       (request.contains("camera")||request.contains("seed")||request.contains("width")||request.contains("height")||
        request.contains("index")||request.contains("operation")||request.contains("mapId")||
        request.contains("visibleOnly")||request.contains("overlap")||request.contains("selectionView"))))
        throw std::runtime_error("Fill amendment cannot replace captured input");
    auto candidate=*toleranceSession;candidate.range=requestedRange(request,candidate.range.center);
    // The sole valid enabled/centerless state is the completed disabled Fill's
    // explicit empty-amendment branch in fillStates. Its radius is still valid.
    auto checked=candidate.range;if(checked.enabled&&!checked.center)checked.enabled=false;
    if(!browser_selection_range::valid(checked))throw std::runtime_error("Invalid amended Fill Range");
    auto states=fillStates(candidate,tolerance);
    publishTolerance(std::move(candidate),states,prepared);
}
void selectMapConsumer(const Json &request,bool volume) {
    const auto width=mapDimension(request,"width"),height=mapDimension(request,"height");
    if(!width || !height || width>unsigned(INT32_MAX) || height>unsigned(INT32_MAX))
        throw std::runtime_error("Invalid selection viewport");
    const auto options=SelectionOptions{request.value("visibleOnly",false),request.value("overlap",false)};
    const auto &source=consumerSelectionMap(request,width,height,options.visibleOnly);
    if(!request.contains("camera")) throw std::runtime_error("A captured camera is required for this selection");
    const auto camera=requestCamera(request);
    if(camera.distance<=0 || camera.radius<=0 || camera.fieldOfView<10 || camera.fieldOfView>120)
        throw std::runtime_error("Invalid selection camera");
    const auto radius=request.at("radius").get<float>();
    if(!std::isfinite(radius) || radius<=0 || (!volume && radius>4096))
        throw std::runtime_error("Invalid selection radius");
    const auto combine=operation(request);
    const auto fromBaseline=request.value("fromBaseline",false);
    if(fromBaseline && !edits->selectionDraft()) throw std::runtime_error("No selection gesture is active");
    auto points=consumerPoints(request,65536);
    const auto map=borrowedSelectionMap(source);
    auto samples=volume ? volumeStrokeSamples(camera,map,width,height,points,radius,{},
        sceneMemoryForBudget(*budget,ResourceCategory::Work)) : SceneVector<VolumeSample>{};
    for(const auto &sample:samples) if(sample.radius>1e12f)
        throw std::runtime_error("Volume sample radius exceeds the native limit");
    auto candidate=BrowserSelectionAccess::selectionCandidate(*edits,fromBaseline);
    if(volume) candidate.selectVolumeBrush(samples,combine,options,&map);
    else candidate.selectBrush(camera,width,height,points,radius,combine,options,&map);
    // Sampling, admitted scratch and candidate deltas have completed. Native
    // replacement stages its own exact history/COW before publishing this mask.
    edits->replaceScene(edits->scene(),candidate.states());
}
}
namespace {
browser_checkpoint::Identities recoveryIdentities() noexcept {
    using browser_checkpoint::Access;
    browser_checkpoint::Identities ids;
    ids.document=nativeDocumentGeneration;
    ids.next={Access::next(colorIds),Access::next(alignmentIds),Access::next(floorIds),Access::next(filterIds),Access::next(transformIds),Access::next(opacityIds)};
    ids.tolerance=lastToleranceSessionId;ids.selectionMap=lastSelectionMapId;
    for(size_t i=0;i<2;++i){ids.filterAttempts[i]={filterAttempts[i].id,filterAttempts[i].epoch};ids.transformAttempts[i]={transformAttempts[i].id,transformAttempts[i].epoch};ids.opacityAttempts[i]={opacityAttempts[i].id,opacityAttempts[i].epoch};}
    return ids;
}
void publishRecoveryIdentities(const browser_checkpoint::Identities &ids) noexcept {
    using browser_checkpoint::Access;
    nativeDocumentGeneration=ids.document;
    Access::next(colorIds,ids.next[0]);Access::next(alignmentIds,ids.next[1]);Access::next(floorIds,ids.next[2]);Access::next(filterIds,ids.next[3]);Access::next(transformIds,ids.next[4]);Access::next(opacityIds,ids.next[5]);
    lastToleranceSessionId=ids.tolerance;lastSelectionMapId=ids.selectionMap;
    for(size_t i=0;i<2;++i){filterAttempts[i]={ids.filterAttempts[i][0],ids.filterAttempts[i][1]};transformAttempts[i]={ids.transformAttempts[i][0],ids.transformAttempts[i][1]};opacityAttempts[i]={ids.opacityAttempts[i][0],ids.opacityAttempts[i][1]};}
}
ResponseSummary recoveryCandidateSummary(const browser_checkpoint::Candidate &c) {
    const auto scene=c.edits?c.edits->scene():c.geometry;
    auto value=sceneSummary(*scene,c.edits.get(),&c.budget);
    value.duplicateRange.reset();if(const auto range=c.duplicateLineage.find(scene))value.duplicateRange=sv_response::DuplicateRange{range->first,range->count};
    if(c.edits) {
        auto &a=*value.alignment;
        const browser_alignment::Context context{c.edits->scene(),c.edits->maskSnapshot(),c.identities.document,c.edits->revision(),c.edits->contentRevision(),true};
        a.branchId=c.lineage.branch(scene);a.canReset=c.alignment.canReset(context);a.retainedBranchCount=0;
        const auto append=[&](const std::shared_ptr<const Scene> &owner) noexcept {
            if(!owner)return;const auto id=c.lineage.branch(owner);
            for(size_t i=0;i<a.retainedBranchCount;++i)if(a.retainedBranchIds[i]==id)return;
            if(a.retainedBranchCount<a.retainedBranchIds.size())a.retainedBranchIds[a.retainedBranchCount++]=id;
        };
        BrowserSelectionAccess::retainedScenes(*c.edits,append);if(c.alignment.current(context))append(c.alignment.baseline());
        std::sort(a.retainedBranchIds.begin(),a.retainedBranchIds.begin()+a.retainedBranchCount);
    }
    if(c.edits)transformMetadata(value,*c.edits,c.transform);opacityMetadata(value,c.opacity);
    if(c.color.active()) {
        sv_response::ColorSession color;color.sessionId=c.color.sessionId();color.baseId=c.color.baseId();color.epochId=c.color.epochId();color.selectedOnly=c.color.selectedOnly();color.pending=false;
        for(size_t i=0;i<15;++i){color.values[i]=c.color.values()[i];color.applied[i]=c.color.appliedValues()[i];}value.colorSession=color;
    }
    return value;
}
browser_checkpoint::Restore::Expected recoveryExpectation(const char *text,unsigned maximumSplats) {
    const auto address=reinterpret_cast<uintptr_t>(text),heapBytes=emscripten_get_heap_size();
    if(!address||address>=heapBytes)throw std::runtime_error("Missing typed checkpoint expectation");
    size_t length=0;while(length<2048&&length<heapBytes-address&&text[length])++length;
    if(length==2048||length==heapBytes-address)throw std::runtime_error("Invalid checkpoint expectation memory");
    const sv_json::ParsedFilterCommand parsed(std::string_view(text,length));const auto &value=parsed.get();
    constexpr std::array<const char *,9> keys{"codecVersion","currentLoadedCount","currentSourceCount","currentDuplicateRange",
        "maximumGraphSplats","originalSourceCount","revision","contentRevision","nextContentRevision"};
    if(!parsed.qualified()||!value.is_object()||value.size()!=keys.size())throw std::runtime_error("Invalid checkpoint expectation fields");
    for(const auto *key:keys)if(!value.contains(key))throw std::runtime_error("Missing checkpoint expectation field");
    const auto integer=[](const Json &field,uint64_t maximum) {
        if(!field.is_number_integer()||(!field.is_number_unsigned()&&field.get<int64_t>()<0))throw std::runtime_error("Invalid checkpoint expectation integer");
        const auto n=field.get<uint64_t>();if(n>maximum)throw std::runtime_error("Checkpoint expectation integer exceeds limit");return n;
    };
    browser_checkpoint::Restore::Expected expected;
    expected.codecVersion=unsigned(integer(value.at("codecVersion"),3));
    expected.currentLoadedCount=size_t(integer(value.at("currentLoadedCount"),browser_duplicate::sceneLimit));
    expected.currentSourceCount=integer(value.at("currentSourceCount"),std::numeric_limits<uint32_t>::max());
    expected.originalSourceCount=integer(value.at("originalSourceCount"),std::numeric_limits<uint32_t>::max());
    expected.maximumGraphSplats=size_t(integer(value.at("maximumGraphSplats"),browser_duplicate::sceneLimit));
    expected.revision=integer(value.at("revision"),sv_operation::maximumIdentity);
    expected.contentRevision=integer(value.at("contentRevision"),sv_operation::maximumIdentity);
    expected.nextContentRevision=integer(value.at("nextContentRevision"),sv_operation::maximumIdentity);
    const auto &range=value.at("currentDuplicateRange");
    if(!range.is_null()) {
        if(!range.is_object()||range.size()!=2||!range.contains("first")||!range.contains("count"))throw std::runtime_error("Invalid checkpoint duplicate range");
        expected.currentDuplicateRange=browser_duplicate::Range{size_t(integer(range.at("first"),browser_duplicate::sceneLimit)),size_t(integer(range.at("count"),browser_duplicate::sceneLimit))};
        const auto &r=*expected.currentDuplicateRange;
        if(!r.count||r.first>expected.currentLoadedCount||r.count!=expected.currentLoadedCount-r.first)throw std::runtime_error("Invalid checkpoint duplicate suffix");
    }
    if(expected.codecVersion!=3||!expected.maximumGraphSplats||expected.maximumGraphSplats!=maximumSplats||
       expected.currentLoadedCount>expected.maximumGraphSplats||expected.currentSourceCount<expected.currentLoadedCount||
       expected.currentSourceCount<expected.originalSourceCount||expected.contentRevision>expected.nextContentRevision)
        throw std::runtime_error("Checkpoint expectation does not match admitted topology");
    return expected;
}
}
extern "C" {
unsigned sv_abi_version() { return 24; }
const char *sv_recovery_prepare() {
    auto prepared=responses.begin();if(!prepared)return sv_response::failureReply(sv_response::FailureKind::Internal);
    try {
        if(recoveryRestore)throw std::runtime_error("Cancel the checkpoint restore before preparing an export");
        if(!budget||!currentScene())throw std::runtime_error("Open a scene before preparing a checkpoint");
        if(!recoveryPlan) {
            sv_allocation::Scope allocationScope;
            const uint32_t flags=(filterOwner?2u:0u)|(toleranceSession?4u:0u)|((selectionMap||pendingSelectionMap)?8u:0u)|((floorDetection||floorCandidate)?16u:0u)|(pendingJob()?32u:0u)|(colorSession.manualPending()?64u:0u);
            browser_checkpoint::Source source{edits.get(),geometry,&colorSession,&alignmentSession,&alignmentLineage,&transformOwner,&opacityOwner,recoveryIdentities(),flags,&duplicateLineage};
            recoveryPlan=std::make_unique<browser_checkpoint::Plan>(source,*budget);
        }
        const auto &d=recoveryPlan->description();std::array<char,65> hash{},headerHash{};std::array<char,96> range{};constexpr char hex[]="0123456789abcdef";
        const auto rangeLength=d.currentDuplicateRange?std::snprintf(range.data(),range.size(),"{\"first\":%zu,\"count\":%zu}",d.currentDuplicateRange->first,d.currentDuplicateRange->count):std::snprintf(range.data(),range.size(),"null");
        if(rangeLength<0||size_t(rangeLength)>=range.size())throw std::runtime_error("Invalid checkpoint range description");
        for(size_t i=0;i<d.sha256.size();++i){hash[2*i]=hex[d.sha256[i]>>4];hash[2*i+1]=hex[d.sha256[i]&15];headerHash[2*i]=hex[d.headerSha256[i]>>4];headerHash[2*i+1]=hex[d.headerSha256[i]&15];}
        const auto n=std::snprintf(recoveryReply.data(),recoveryReply.size(),
            "{\"ok\":true,\"version\":2,\"byteLength\":%zu,\"workspaceBytes\":%zu,\"maximumChunkBytes\":%zu,\"sceneCount\":%zu,\"maskCount\":%zu,\"normalizationFlags\":%u,\"actualRevision\":%llu,\"revision\":%llu,\"contentRevision\":%llu,\"nextContentRevision\":%llu,\"sha256\":\"%s\",\"headerSha256\":\"%s\",\"memoryBytes\":%zu,\"currentLoadedCount\":%zu,\"currentSourceCount\":%llu,\"currentDuplicateRange\":%s,\"maximumGraphSplats\":%zu}",
            d.byteLength,d.workspaceBytes,browser_checkpoint::maximumChunkBytes,d.sceneCount,d.maskCount,d.normalizationFlags,
            static_cast<unsigned long long>(edits?edits->revision():0),static_cast<unsigned long long>(d.revision),static_cast<unsigned long long>(d.contentRevision),static_cast<unsigned long long>(d.nextContentRevision),hash.data(),headerHash.data(),budget->usage().totalBytes,
            d.currentLoadedCount,static_cast<unsigned long long>(d.currentSourceCount),range.data(),d.maximumGraphSplats);
        if(n<0||size_t(n)>=recoveryReply.size())throw std::runtime_error("Checkpoint description exceeded its fixed reply storage");
        return recoveryReply.data();
    }catch(const std::bad_alloc &){return sv_response::failureReply();}catch(const std::exception &e){return replyError(prepared,e.what());}catch(...){return sv_response::failureReply(sv_response::FailureKind::Internal);}
}
const uint8_t *sv_recovery_read(unsigned offset,unsigned count) {
    recoveryReadSize=0;
    try {if(!recoveryPlan)return nullptr;const auto bytes=recoveryPlan->read(offset,count);recoveryReadSize=bytes.size();return bytes.data();}catch(...){return nullptr;}
}
unsigned sv_recovery_read_size() noexcept { return unsigned(recoveryReadSize); }
void sv_recovery_release() noexcept { recoveryReadSize=0;recoveryPlan.reset(); }
const char *sv_recovery_restore_begin(unsigned totalBytes,unsigned maximumSplats,unsigned budgetBytes,const char *expectedJson) {
    auto prepared=responses.begin();if(!prepared)return sv_response::failureReply(sv_response::FailureKind::Internal);
    try {
        if(recoveryBusy())throw std::runtime_error("Release the active checkpoint owner first");
        if(operationLedger.blocks())throw std::runtime_error("Resolve the identified edit operation before restoring a scene");
        sv_allocation::Scope allocationScope;
        const auto previous=checkedByteSum({budget?budget->usage().totalBytes:0,checkedByteProduct(size_t(packed.capacity()),sizeof(uint32_t)),job?job->states.capacity():0});
        const auto expected=recoveryExpectation(expectedJson,maximumSplats);
        auto candidate=std::make_unique<browser_checkpoint::Restore>(totalBytes,expected,budgetBytes,previous);
        const auto n=std::snprintf(recoveryReply.data(),recoveryReply.size(),"{\"ok\":true,\"version\":1,\"byteLength\":%u,\"written\":0}",totalBytes);
        if(n<0||size_t(n)>=recoveryReply.size())throw std::runtime_error("Invalid checkpoint input description");recoveryRestore=std::move(candidate);return recoveryReply.data();
    }catch(const std::bad_alloc &){return sv_response::failureReply();}catch(const std::exception &e){return replyError(prepared,e.what());}catch(...){return sv_response::failureReply(sv_response::FailureKind::Internal);}
}
const char *sv_recovery_restore_write(unsigned offset,const uint8_t *bytes,unsigned length) {
    auto prepared=responses.begin();if(!prepared)return sv_response::failureReply(sv_response::FailureKind::Internal);
    try {
        if(!recoveryRestore)throw std::runtime_error("Begin a checkpoint restore first");const auto address=reinterpret_cast<uintptr_t>(bytes),heapBytes=emscripten_get_heap_size();
        if(!address||address>heapBytes||length>heapBytes-address)throw std::runtime_error("Invalid checkpoint input chunk memory");
        recoveryRestore->write(offset,std::span(bytes,length));const auto n=std::snprintf(recoveryReply.data(),recoveryReply.size(),"{\"ok\":true,\"written\":%zu,\"byteLength\":%zu}",recoveryRestore->written(),recoveryRestore->total());
        if(n<0||size_t(n)>=recoveryReply.size())throw std::runtime_error("Invalid checkpoint write acknowledgement");return recoveryReply.data();
    }catch(const std::bad_alloc &){return sv_response::failureReply();}catch(const std::exception &e){return replyError(prepared,e.what());}catch(...){return sv_response::failureReply(sv_response::FailureKind::Internal);}
}
const char *sv_recovery_restore_finish() {
    auto prepared=responses.begin();if(!prepared)return sv_response::failureReply(sv_response::FailureKind::Internal);
    try {
        if(!recoveryRestore)throw std::runtime_error("Begin a checkpoint restore first");sv_allocation::Scope allocationScope;
        auto candidate=recoveryRestore->finish();
        auto metadata=candidate.budget.reserve(ResourceCategory::History,candidate.edits?
            checkedByteSum({2*sizeof(browser_duplicate::Lineage),sizeof(browser_alignment::Lineage)}):0);
        auto value=recoveryCandidateSummary(candidate);
        value.memoryBytes-=recoveryRestore->publicationRetiredBytes();
        if(!responses.summary(prepared,value))return sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        // All parsing, hashing, graph/reference validation, admission and reply
        // construction completed before this allocation-free publication.
        retireJobs();morphologyRangeCache.clear();checkpoint.reset();transactionAlignment.reset();transactionTolerance.reset();toleranceSession.reset();
        transactionAlignmentLineage.reset();transactionDuplicateLineage.reset();
        filterOwner.reset();transactionFilter.reset();transactionHasFilter=false;
        transactionTransform.reset();transactionHasTransform=false;transactionOpacity.reset();transactionHasOpacity=false;
        floorCandidate.reset();transactionFloor.reset();transactionSelectionMap.reset();pendingSelectionMap.reset();selectionMap.reset();
        browser_spz_export::OutputOwner::retire(spzOutput);browser_export::OutputOwner::retire(attributeOutput);
        std::vector<uint32_t>{}.swap(packed);
        edits.swap(candidate.edits);geometry.swap(candidate.geometry);colorSession=std::move(candidate.color);alignmentSession=std::move(candidate.alignment);alignmentLineage=std::move(candidate.lineage);
        duplicateLineage=std::move(candidate.duplicateLineage);duplicateLineageMetadata=std::move(metadata);
        transformOwner=std::move(candidate.transform);opacityOwner=std::move(candidate.opacity);publishRecoveryIdentities(candidate.identities);operationLedger.sourceChanged();geometryRangeBytes=0;
        auto previousMetadata=std::move(recoveryMetadata);
        budget=std::move(candidate.budget);recoveryMetadata=std::move(candidate.metadata);
        // Retire old graph references while their old budget still lives, then
        // release input/previous-owner concurrent charges on the new ledger.
        candidate.edits.reset();candidate.geometry.reset();previousMetadata.release();recoveryRestore.reset();return responses.publish(prepared);
    }catch(const std::bad_alloc &){return sv_response::failureReply();}catch(const std::exception &e){return replyError(prepared,e.what());}catch(...){return sv_response::failureReply(sv_response::FailureKind::Internal);}
}
void sv_recovery_restore_cancel() noexcept { recoveryRestore.reset(); }
const char *sv_build_identity() { return splatview_runtime_identity::core; }
const char *sv_allocation_snapshot() noexcept {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    sv_allocation::Snapshot value;std::uint64_t sequence{};
    if(!sv_allocation::query(value,sequence) || !responses.census(prepared,value,sequence))
        return sv_response::failureReply(sv_response::FailureKind::Internal);
    return responses.publish(prepared);
}
const char *sv_open(const uint8_t *bytes, size_t length, unsigned format, unsigned maxSplats, unsigned budgetBytes) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    try {
        if(operationLedger.blocks())throw std::runtime_error("Resolve the identified edit operation before opening a scene");
        sv_allocation::Scope allocationScope;
        const auto address=reinterpret_cast<uintptr_t>(bytes),heapBytes=emscripten_get_heap_size();
        if(!address || address>heapBytes || length>heapBytes-address)
            throw std::runtime_error("Invalid input memory");
        if(format>unsigned(InputFormat::Unsupported)) throw std::runtime_error("Unsupported input type");
        ResourceLimits limits; limits.totalBytes=budgetBytes;
        ResourceBudget candidateBudget(limits);
        // A second open can coexist with the old owner until publication. Charge
        // that retained payload as well; rejecting the candidate must preserve
        // old edits, exact history, maps and read-only geometry.
        const auto previousBytes=checkedByteSum({budget ? budget->usage().totalBytes : 0,
            checkedByteProduct(packed.capacity(),sizeof(uint32_t)),
            job ? job->states.capacity() : 0});
        auto previous=candidateBudget.reserve(ResourceCategory::Work,previousBytes);
        LoadOptions options; options.maxSplats=maxSplats; options.maxBytes=budgetBytes;
        options.format=static_cast<InputFormat>(format); options.resources=candidateBudget;
        std::shared_ptr<const Scene> scene;
        {
            // Browser input staging was admitted before malloc; this grant also
            // includes it in the decoder ledger's concurrent peak. Scratch is
            // admitted before the frozen header parser allocates any strings.
            auto source=candidateBudget.reserve(ResourceCategory::Source,length);
            const auto plan=browserPlyAdmission(std::span(bytes,length),options.format);
            auto scratch=candidateBudget.reserve(ResourceCategory::Work,plan.workBytes);
            scene=std::make_shared<Scene>(loadScene(std::span(bytes,length),options));
        }
        std::unique_ptr<SceneEdits> candidate;
        if(scene->isGaussian()) candidate=std::make_unique<SceneEdits>(scene,
            sceneMemoryForBudget(candidateBudget,ResourceCategory::History),
            sceneMemoryForBudget(candidateBudget,ResourceCategory::Work));
        auto value=sceneSummary(*scene,candidate.get(),&candidateBudget);
        value.memoryBytes=candidateBudget.usage().totalBytes-previous.bytes();
        // Validate the candidate's borrowed format and finish the bounded reply
        // before the no-throw scene publication. No response DOM survives it.
        if(!responses.summary(prepared,value))
            return sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        return publishOpen(prepared,std::move(scene),std::move(candidate),std::move(candidateBudget),previous);
    } catch(const std::bad_alloc &) { return sv_response::failureReply(); }
      catch(const std::exception &e) { return replyError(prepared,e.what()); }
      catch(...) { return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const char *sv_open_group(double blockPointer,double blockBytes,double descriptorPointer,double descriptorBytes,
                          double maximumSplats,double budgetBytes,double nativeWorkBytes) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    try {
        if(operationLedger.blocks())throw std::runtime_error("Resolve the identified edit operation before opening a scene");
        sv_allocation::Scope allocationScope;
        const std::array<double,7> arguments{blockPointer,blockBytes,descriptorPointer,descriptorBytes,maximumSplats,budgetBytes,nativeWorkBytes};
        std::array<uint32_t,7> checked{};
        for(const auto value:arguments) {
            if(!std::isfinite(value)||value<0||value>UINT32_MAX||std::floor(value)!=value)
                throw std::runtime_error("Invalid grouped SOG ABI argument");
        }
        for(size_t i=0;i<arguments.size();++i) checked[i]=uint32_t(arguments[i]);
        if(!checked[0]||!checked[2]||!checked[4]||checked[4]>1'000'000||!checked[5]||!checked[6])
            throw std::runtime_error("Invalid grouped SOG ABI bounds");
        const auto heap=emscripten_get_heap_size();
        if(checked[0]>heap||checked[1]>heap-checked[0]||checked[2]>heap||checked[3]>heap-checked[2])
            throw std::runtime_error("Invalid grouped SOG input memory");
        if(checked[0]<checked[2]?checked[1]>checked[2]-checked[0]:checked[3]>checked[0]-checked[2])
            throw std::runtime_error("Grouped SOG input spans overlap");
        const auto block=std::span(reinterpret_cast<const uint8_t *>(uintptr_t(checked[0])),size_t(checked[1]));
        const auto descriptor=std::span(reinterpret_cast<const uint8_t *>(uintptr_t(checked[2])),size_t(checked[3]));
        const auto group=browser_sog_group::Group::parse(block,descriptor);
        ResourceLimits limits;limits.totalBytes=checked[5];ResourceBudget candidateBudget(limits);
        const auto previousBytes=checkedByteSum({budget?budget->usage().totalBytes:0,
            checkedByteProduct(packed.capacity(),sizeof(uint32_t)),job?job->states.capacity():0});
        auto previous=candidateBudget.reserve(ResourceCategory::Work,previousBytes);
        LoadOptions options;options.maxSplats=checked[4];options.maxBytes=checked[5];options.format=InputFormat::Sog;options.resources=candidateBudget;
        std::shared_ptr<const Scene> scene;
        {
            auto source=candidateBudget.reserve(ResourceCategory::Source,checkedByteSum({block.size(),descriptor.size()}));
            // Explicit NON-PLANE parser/codec headroom only. Existing per-role
            // SceneAllocator grants separately charge actual decoded RGBA.
            auto work=candidateBudget.reserve(ResourceCategory::Work,checked[6]);
            scene=std::make_shared<Scene>(browser_sog_group::load([&](const std::string &name){return group.read(name);},options,group.originalBytes()));
        }
        auto candidate=std::make_unique<SceneEdits>(scene,sceneMemoryForBudget(candidateBudget,ResourceCategory::History),
            sceneMemoryForBudget(candidateBudget,ResourceCategory::Work));
        auto value=sceneSummary(*scene,candidate.get(),&candidateBudget);value.memoryBytes=candidateBudget.usage().totalBytes-previous.bytes();
        if(!responses.summary(prepared,value)) return sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        return publishOpen(prepared,std::move(scene),std::move(candidate),std::move(candidateBudget),previous);
    } catch(const std::bad_alloc &) { return sv_response::failureReply(); }
      catch(const std::exception &e) { return replyError(prepared,e.what()); }
      catch(...) { return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const char *sv_command(const char *text) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    bool mapCommand=bool(filterOwner)||bool(transformOwner)||bool(opacityOwner),exportPrepared=false;
    std::optional<PreparedFilterChange> filterChange;
    std::optional<PreparedTransformChange> transformChange;
    std::optional<PreparedOpacityChange> opacityChange;
    browser_export::OutputOwner::Pointer attributeCandidate;
    try {
        // The worker owns this exact immutable request for its module lifetime.
        // Telemetry must remain available without a request DOM or reply heap
        // allocation after ordinary native refusal and cleanup.
        if(canonicalSummary(text)) return reply(prepared,summary());
        sv_allocation::Scope allocationScope;
        if(!text) throw std::runtime_error("Invalid scene command");
        {
        // Export publication waits for the parsed request and all dispatch
        // temporaries to retire. Json destruction may itself allocate; this
        // is cleanup ordering, not arbitrary-command or closed-quota safety.
        const sv_json::ParsedFilterCommand parsed(text);
        const auto &request=parsed.get();
        const auto command=request.at("command").get<std::string>();
        // Heap telemetry queries the real allocation state before the first
        // source is decoded. All other commands still require a scene owner.
        if(!currentScene()) {
            if(command=="summary") return reply(prepared,summary());
            throw std::runtime_error("Open a scene first");
        }
        if(command=="operationBind") {
            mapCommand=true;
            if(request.size()!=2||!request.contains("operationScope"))throw std::runtime_error("Invalid operation binding fields");
            const auto scope=operationScope(request.at("operationScope"));
            if(!operationLedger.bind(scope,nativeDocumentGeneration))throw std::runtime_error("The operation document scope is stale or conflicting");
            return responses.operationBound(prepared,scope)?responses.publish(prepared):sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        }
        if(command=="operationStatus"||command=="operationRetire") {
            mapCommand=true;
            if(request.size()!=2||!request.contains("operationOwner"))throw std::runtime_error("Invalid operation control fields");
            const auto owner=operationOwner(request.at("operationOwner"));
            if(command=="operationRetire") {
                if(!operationLedger.retire(owner,nativeDocumentGeneration))throw std::runtime_error("The operation receipt cannot be retired");
                return responses.operationRetired(prepared,owner)?responses.publish(prepared):sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
            }
            const auto value=summary();const auto receipt=operationLedger.status(owner,nativeDocumentGeneration,operationState(value));
            return responses.operation(prepared,receipt,value)?responses.publish(prepared):sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        }
        if(!edits) {
            if(command=="summary" || command=="cancel" || command=="cancelSelection") return reply(prepared,summary());
            throw std::runtime_error("Editing tools are available for Gaussian splats only.");
        }
        if(command=="transformFocus") {
            // Readonly dispatch precedes every mutation/session guard. A stale,
            // malformed or refused query must not retire someone else's work.
            mapCommand=true;
            if(!parsed.qualified())throw std::runtime_error("Transform focus exceeds its bounded grammar");
            const auto focus=browser_focus::parse(request);
            if(pendingJob()||checkpoint||operationLedger.blocks()||filterOwner||
               edits->selectionDraft()||pendingSelectionMap||!budget)
                throw std::runtime_error("Finish current work before querying transform focus");
            requireFocusPersistentOwnersCurrent();
            const auto snapshot=focusSnapshot();
            if(focus.revision!=snapshot.revision||focus.contentRevision!=snapshot.contentRevision||focus.transform!=snapshot.transform)
                throw std::runtime_error("Transform focus request is stale");
            if(focus.scope==browser_focus::Scope::Scene) {
                const auto point=browser_focus::scenePoint(snapshot);
                return responses.point(prepared,summary(),sv_response::Point{point.x,point.y,point.z})?
                    responses.publish(prepared):sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
            }
            auto candidate=browser_focus::Job::create(snapshot,sceneMemoryForBudget(*budget,ResourceCategory::Work));
            auto value=summary();value.pending=true;value.progress=0;value.memoryBytes=budget->usage().totalBytes;
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid transform focus admission response");
            transformFocusJob=std::move(candidate);return responses.publish(prepared);
        }
        if(command=="morphologyRange") {
            // A readonly query must not retire Reset, Floor, scope, color or
            // history owners. Its own refusal cannot cancel an unrelated job.
            mapCommand=true;
            if(!parsed.qualified()||request.size()!=1||pendingJob()||checkpoint||operationLedger.blocks()||
               edits->selectionDraft()||pendingSelectionMap||!budget)
                throw std::runtime_error("Finish current work before preparing the morphology range");
            if(filterOwner)throw std::runtime_error("Finish the selection filter before preparing the morphology range");
            requireFocusPersistentOwnersCurrent();
            if(morphologyRangeCache.get(edits->scene()))return reply(prepared,summary());
            auto candidate=browser_morphology_range::Job::create(edits->scene(),sceneMemoryForBudget(*budget,ResourceCategory::Work));
            auto value=summary();value.pending=true;value.progress=0;value.memoryBytes=budget->usage().totalBytes;
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid morphology range response");
            morphologyRangeJob=std::move(candidate);return responses.publish(prepared);
        }
        if(operationLedger.blocks()||request.contains("operationOwner"))mapCommand=true;
        const bool identifiedTransaction=request.contains("operationOwner")&&
            (command=="beginTransaction"||command=="commitTransaction"||command=="rollbackTransaction");
        if(command=="beginTransaction"&&request.contains("operationOwner")) {
            if(request.size()!=2||checkpoint)throw std::runtime_error("An edit transaction is already active or has invalid fields");
            const auto owner=operationOwner(request.at("operationOwner"));
            if(!operationLedger.admit(owner,nativeDocumentGeneration,operationState(summary())))
                throw std::runtime_error("The edit operation identity is stale, reused or unresolved");
        } else if(command!="summary")validateOperationMutation(request);
        const bool filterCommand=command=="beginFilter" || command=="previewFilter" || command=="confirmFilter" || command=="cancelFilter";
        const bool transformCommand=command=="beginTransform"||command=="applyTransform"||command=="resetTransform"||command=="endTransform"||
            command=="rebaseTransform"||command=="undoTransform"||command=="redoTransform"||command=="cancelTransform";
        const bool opacityCommand=command=="beginOpacity"||command=="applyOpacity"||command=="resetOpacity"||command=="endOpacity";
        if(opacityOwner&&!opacityCommand&&command!="summary"&&command!="cancel"&&command!="beginTransaction"&&
           command!="commitTransaction"&&command!="rollbackTransaction") {
            mapCommand=true;throw std::runtime_error("End the opacity session before changing the scene");
        }
        if(transformOwner&&!transformCommand&&command!="summary"&&command!="cancel"&&command!="beginTransaction"&&
           command!="commitTransaction"&&command!="rollbackTransaction") {
            mapCommand=true;throw std::runtime_error("End the transform session before changing the scene");
        }
        if(filterOwner && !filterCommand && command!="summary" && command!="cancel" && command!="beginTransaction" &&
           command!="commitTransaction" && command!="rollbackTransaction" && command!="resetCleanup") {
            mapCommand=true;throw std::runtime_error("Confirm or cancel the selection filter first");
        }
        const bool filterTransaction=(filterOwner || transactionHasFilter || transformOwner || transactionHasTransform || opacityOwner || transactionHasOpacity) &&
            (command=="beginTransaction" || command=="commitTransaction" || command=="rollbackTransaction");
        if(opacityCommand) {
            mapCommand=true;if(!parsed.qualified())throw std::runtime_error("Opacity command exceeds its bounded grammar");
            opacityChange=prepareOpacityCommand(request,command,prepared);
        } else if(transformCommand) {
            mapCommand=true;if(!parsed.qualified())throw std::runtime_error("Transform command exceeds its bounded grammar");
            transformChange=prepareTransformCommand(request,command,prepared);
        } else if(filterCommand || filterTransaction || identifiedTransaction || command=="beginTransaction" || (filterOwner && command=="resetCleanup")) {
            mapCommand=true;
            if((filterCommand || filterTransaction || filterOwner || transformOwner || opacityOwner) && !parsed.qualified()) throw std::runtime_error("Owned command exceeds its bounded grammar");
            if(command=="beginTransaction" && !filterOwner && !identifiedTransaction) retireFloorDetection();
            filterChange=(filterTransaction || identifiedTransaction || command=="beginTransaction") ? prepareFilterTransaction(request,command,prepared) : prepareFilterCommand(request,command,prepared);
        } else {
        mapCommand=bool(filterOwner)||bool(transformOwner)||bool(opacityOwner) || command=="selectionMapBegin" || command=="selectionMapCommit" || command=="selectionMapRelease" ||
            command=="detectFloor" || command=="cancelFloor" || command=="colorPick" || command=="colorTolerance" || command=="fillPick" || command=="fillTolerance";
        if(command=="rollbackTransaction") {
            if(!checkpoint) throw std::runtime_error("No edit transaction is active");
            retireJobs();
            if(!colorSession.rollbackTransaction(colorIds)) throw std::runtime_error("Color transaction rollback failed");
            if(!transactionAlignment) throw std::runtime_error("Alignment transaction rollback failed");
            std::swap(alignmentSession,*transactionAlignment);transactionAlignment.reset();
            alignmentLineage=std::move(*transactionAlignmentLineage);transactionAlignmentLineage.reset();
            duplicateLineage=std::move(*transactionDuplicateLineage);transactionDuplicateLineage.reset();
            edits.swap(checkpoint); checkpoint.reset();
            filterOwner=std::move(transactionFilter);transactionFilter.reset();
            transactionHasFilter=false;
            transformOwner=std::move(transactionTransform);transactionTransform.reset();transactionHasTransform=false;
            opacityOwner=std::move(transactionOpacity);transactionOpacity.reset();transactionHasOpacity=false;
            floorCandidate=std::move(transactionFloor);
            toleranceSession.swap(transactionTolerance); transactionTolerance.reset();
            selectionMap.swap(transactionSelectionMap); transactionSelectionMap.reset(); return reply(prepared,summary());
        }
        if(command=="selectionMapRelease") {
            const auto id=selectionMapId(request);
            if(selectionMap && selectionMap->header.mapId==id) selectionMap.reset();
            if(pendingSelectionMap && pendingSelectionMap->header.mapId==id) pendingSelectionMap.reset();
            return reply(prepared,summary());
        }
        if(command=="selectionMapBegin") {
            if(colorSession.active()) throw std::runtime_error("Finish the color session before uploading a selection map");
            beginSelectionMap(request); return reply(prepared,summary());
        }
        if(command=="selectionMapCommit") {
            if(colorSession.active()) throw std::runtime_error("Finish the color session before adopting a selection map");
            commitSelectionMap(request); return reply(prepared,summary());
        }
        if(command=="endTolerance") {
            const auto id=requestSessionId(request);
            if(toleranceSession && toleranceSession->sessionId==id) toleranceSession.reset();
            return reply(prepared,summary());
        }
        if(command=="cancel") { if(transformOwner)filterKeys(request,{"command"});retireJobs(); if(!filterOwner) edits->cancelSelectionDraft(); pendingSelectionMap.reset(); return reply(prepared,summary()); }
        if(command=="summary") return reply(prepared,summary());
        if(command=="cancelFloor") {
            const auto id=floorRequestId(request);
            if(job && job->alignment && job->alignment->floorId==id) retireJobs();
            if(floorDetection && floorDetection->id==id) retireFloorDetection();
            if(floorCandidate && floorCandidate->id==id) floorCandidate.reset();
            return reply(prepared,summary());
        }
        if(command=="detectFloor") {
            beginFloorDetection(request,prepared);return responses.publish(prepared);
        }
        if(command=="duplicate") {
            mapCommand=true;filterKeys(request,{"command"},true);
            if(!parsed.qualified()||pendingJob()||filterOwner||transformOwner||opacityOwner||colorSession.active()||
               toleranceSession||edits->selectionDraft()||pendingSelectionMap||floorCandidate)
                throw std::runtime_error("Finish the current tool before duplicating");
            BrowserSelectionAccess::selectionView(*edits,browser_view_scope::parse(request));
            auto metadata=budget->reserve(ResourceCategory::Work,sizeof(browser_duplicate::Job));
            auto candidate=std::make_unique<browser_duplicate::Job>(*edits,duplicateLineage,
                sceneMemoryForBudget(*budget,ResourceCategory::Decoded),sceneMemoryForBudget(*budget,ResourceCategory::History));
            auto value=summary();value.pending=true;value.progress=0;value.memoryBytes=budget->usage().totalBytes;
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid Duplicate admission response");
            duplicateJob=std::move(candidate);duplicateJobMetadata=std::move(metadata);return responses.publish(prepared);
        }
        const bool floorQuery=command=="point" || command=="planeNormal" || command=="export" ||
            command=="colorPick" || command=="colorTolerance" || command=="fillPick" || command=="fillTolerance";
        if(floorDetection && floorQuery) mapCommand=true; // A refused readonly query cannot cancel analysis.
        if(floorDetection && !floorQuery) retireFloorDetection();
        if(pendingJob()) throw std::runtime_error("An edit is already running");
        // This fixed predicate is request metadata, never an acknowledged mask.
        // Selection consumers copy it into their private/frozen request owners.
        BrowserSelectionAccess::selectionView(*edits,browser_view_scope::parse(request));
        // Selection/scope/content boundaries must first materialize the baked
        // document and end the retained preview base in the browser transaction.
        // Point queries and exports observe the already committed native scene;
        // they cannot alter the retained baseline or local browser preview.
        if(colorSession.active() && command!="grade" && command!="autoColor" && command!="beginColor" && command!="endColor" &&
           command!="point" && command!="planeNormal" && command!="export" && command!="beginTransaction" && command!="commitTransaction")
            throw std::runtime_error("Finish the color session before changing the scene");
        if(command=="point") {
            const auto index=request.at("index").get<uint32_t>();
            const auto value=summary();std::optional<sv_response::Point> point;
            if(index<edits->scene()->gaussians.size() && !(edits->states()[index]&2)) {
                const auto &position=edits->scene()->gaussians[index].positionOpacity;
                point=sv_response::Point{position[0],position[1],position[2]};
            }
            return responses.point(prepared,value,point) ? responses.publish(prepared) :
                sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        }
        if(command=="planeNormal") {
            if(!browser_alignment::validContext(alignmentContext(*edits))) throw std::runtime_error("Finish the selection before aligning");
            if(!edits->visibleCount()) throw std::runtime_error("No visible splats to align");
            const auto normal=browser_alignment::planeNormal(planePoints(request));const auto value=summary();
            return responses.point(prepared,value,sv_response::Point{normal.x,normal.y,normal.z}) ? responses.publish(prepared) :
                sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        }
        if(command=="beginTransaction") {
            if(checkpoint) throw std::runtime_error("An edit transaction is already active");
            if(pendingSelectionMap) throw std::runtime_error("Finish the selection map upload before editing");
            auto candidate=std::make_unique<SceneEdits>(*edits);
            if(!colorSession.beginTransaction()) throw std::runtime_error("A color transaction is already active");
            transactionAlignment=alignmentSession;
            transactionAlignmentLineage=alignmentLineage;transactionDuplicateLineage=duplicateLineage;
            transactionFloor=floorCandidate;
            transactionFilter=filterOwner;
            transactionHasFilter=bool(filterOwner);
            checkpoint=std::move(candidate);
            transactionTolerance=toleranceSession;
            transactionSelectionMap=selectionMap;
        }
        else if(command=="commitTransaction") {
            if(!checkpoint) throw std::runtime_error("No edit transaction is active");
            if(!colorSession.commitTransaction()) throw std::runtime_error("No color transaction is active");
            transactionAlignment.reset();
            transactionAlignmentLineage.reset();transactionDuplicateLineage.reset();
            transactionFloor.reset();
            transactionFilter.reset();
            transactionHasFilter=false;
            checkpoint.reset(); transactionTolerance.reset(); transactionSelectionMap.reset();
        }
        else if(command=="beginColor") {
            filterKeys(request,{"command","selectedOnly"},true);
            if(!request.at("selectedOnly").is_boolean()||edits->selectionDraft()||pendingSelectionMap||toleranceSession)
                throw std::runtime_error("Finish the selection before adjusting color");
            const bool selectedOnly=request.at("selectedOnly").get<bool>();
            auto nextColor=colorSession;MaskStorage target;
            const auto view=browser_view_scope::parse(request);
            if(!nextColor.active()&&selectedOnly&&view.enabled)
                target=browser_view_scope::effective(*edits->scene(),edits->maskSnapshot(),view,sceneMemoryForBudget(*budget,ResourceCategory::Work),true);
            if(!nextColor.begin(colorContext(),selectedOnly,std::move(target),colorIds))throw std::runtime_error("The color session is stale or busy");
            auto value=summary();sv_response::ColorSession metadata;
            metadata.sessionId=nextColor.sessionId();metadata.baseId=nextColor.baseId();metadata.epochId=nextColor.epochId();
            metadata.selectedOnly=nextColor.selectedOnly();metadata.pending=nextColor.jobPending();
            for(size_t i=0;i<15;++i){metadata.values[i]=nextColor.values()[i];metadata.applied[i]=nextColor.appliedValues()[i];}
            value.colorSession=metadata;
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid color session response");
            colorSession=std::move(nextColor);value.memoryBytes=budget->usage().totalBytes;responses.summary(prepared,value);
            return responses.publish(prepared);
        }
        else if(command=="endColor") {
            const auto outcome=colorSession.end(colorContext(),colorIds);
            if(outcome!=browser_color_metadata::EndDisposition::Ended &&
               outcome!=browser_color_metadata::EndDisposition::AlreadyEnded)
                throw std::runtime_error("Apply or cancel the color change before ending the session");
        }
        else if(command=="alignCenter") beginCenter(request);
        else if(command=="alignScale") beginScale(request);
        else if(command=="alignPlane") beginPlane(request);
        else if(command=="alignFloor") beginFloor(request);
        else if(command=="resetAlignment") {
            resetAlignment(request,prepared);return responses.publish(prepared);
        }
        else if(command=="morphology") {
            if(edits->selectionDraft()) throw std::runtime_error("Finish the selection gesture before Grow or Shrink");
            if(pendingSelectionMap) throw std::runtime_error("Finish the selection map upload before Grow or Shrink");
            const auto mode=request.at("mode").get<std::string>();
            if(mode!="grow" && mode!="shrink") throw std::runtime_error("Invalid selection morphology mode");
            const bool explicitMethod=request.contains("method");
            const auto method=explicitMethod?request.at("method").get<std::string>():std::string("sigma");
            if(method!="sigma"&&method!="volume")throw std::runtime_error("Invalid morphology method");
            const bool volume=method=="volume";
            if(explicitMethod)filterKeys(request,{"command","mode","method",volume?"distance":"sigma"},true);
            else if(request.contains("distance"))throw std::runtime_error("Volume reach requires an explicit method");
            const char *field=volume?"distance":"sigma";
            if(request.contains(field)&&!request.at(field).is_number())throw std::runtime_error("Morphology reach must be numeric");
            const auto sigma=request.value(field,1.f);
            if(!std::isfinite(sigma) || (volume?sigma<=0:sigma<browser_morphology::minimumSigma || sigma>browser_morphology::maximumSigma))
                throw std::runtime_error("Invalid selection reach");
            if(!budget) throw std::runtime_error("The scene has no resource budget");
            auto candidate=BrowserMorphologyJob::create(*edits,mode=="grow",sigma,
                sceneMemoryForBudget(*budget,ResourceCategory::Work),browser_view_scope::parse(request),
                volume?browser_morphology::Method::Volume:browser_morphology::Method::Sigma);
            morphologyJob=std::move(candidate);
        }
        else if(command=="clipSelection") {
            filterKeys(request,{"command","selectionView"});
            if(!BrowserSelectionAccess::selectionView(*edits).enabled)throw std::runtime_error("A current view is required for clipping");
            auto next=std::make_unique<SceneEdits>(*edits);BrowserSelectionAccess::clipSelection(*next);
            auto value=filterSummary(*next,filterOwner);
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid clipped selection response");
            edits.swap(next);next.reset();floorCandidate.reset();pruneSelectionMaps();value.memoryBytes=budget->usage().totalBytes;
            responses.summary(prepared,value);return responses.publish(prepared);
        }
        else if(command=="selectAll") edits->selectAll();
        else if(command=="selectNone") edits->selectNone();
        else if(command=="invert") edits->invertSelection();
        else if(command=="delete") edits->deleteSelected();
        else if(command=="crop") edits->keepSelected();
        else if(command=="restore") edits->restoreDeleted();
        else if(command=="resetCleanup") edits->resetCleanup();
        else if(command=="undo") edits->undo();
        else if(command=="redo") edits->redo();
        else if(command=="beginSelection") edits->beginSelectionDraft();
        else if(command=="confirmSelection") edits->confirmSelectionDraft();
        else if(command=="cancelSelection") edits->cancelSelectionDraft();
        else if(command=="color") selectColor(request);
        else if(command=="colorPick") colorPick(request,prepared);
        else if(command=="colorTolerance") colorTolerance(request,prepared);
        else if(command=="fillPick") fillPick(request,prepared);
        else if(command=="fillTolerance") fillTolerance(request,prepared);
        else if(command=="volume") selectMapConsumer(request,true);
        else if(command=="single") {
            std::optional<uint32_t> index;
            if(request.contains("index") && !request["index"].is_null()) index=request["index"].get<uint32_t>();
            restoreSelectionBaseline(request); edits->selectSingle(index,operation(request));
        } else if(command=="rectangle" || command=="brush" || command=="polygon") {
            if(command=="brush" && request.value("visibleOnly",false)) {
                selectMapConsumer(request,false);floorCandidate.reset();return reply(prepared,summary());
            }
            const auto camera=requestCamera(request);
            const auto width=request.at("width").get<unsigned>(),height=request.at("height").get<unsigned>();
            SelectionOptions options{request.value("visibleOnly",false),request.value("overlap",false)};
            if(options.visibleOnly) throw std::runtime_error("A visibility query is required for this selection");
            restoreSelectionBaseline(request);
            if(command=="rectangle") {
                const auto r=request.at("rectangle").get<std::array<int,4>>();
                edits->selectRectangle(camera,width,height,{r[0],r[1],r[2],r[3]},operation(request),options);
            } else {
                std::vector<PointI> points;
                for(const auto &point:request.at("points")) points.push_back({point.at(0).get<int>(),point.at(1).get<int>()});
                if(command=="polygon") edits->selectPolygon(camera,width,height,points,operation(request),options);
                else edits->selectBrush(camera,width,height,points,request.value("radius",16.f),operation(request),options);
            }
        } else if(command=="grade" || command=="autoColor") {
            if(edits->selectionDraft() || pendingSelectionMap || toleranceSession)
                throw std::runtime_error("Finish the selection before adjusting color");
            if(!budget) throw std::runtime_error("The scene has no resource budget");
            const auto &input=request.at("values");
            if(!input.is_array() || input.size()!=15) throw std::runtime_error("Invalid color values");
            ColorValues values;
            for(size_t i=0;i<15;++i) {
                if(!input[i].is_number()) throw std::runtime_error("Invalid color value type");
                const auto value=input[i].get<double>();
                const auto low=i==2 ? .1 : double(colorFields[i].low);
                if(!std::isfinite(value) || value<low || value>colorFields[i].high)
                    throw std::runtime_error("Color value exceeds its supported range");
                values[i]=float(value);
            }
            const bool selectedOnly=request.value("selectedOnly",edits->selectedCount()>0);
            auto choice=browser_color_metadata::Method::Enhance;
            if(command=="autoColor") {
                const auto method=request.at("method").get<std::string>();
                if(method=="enhance") choice=browser_color_metadata::Method::Enhance;
                else if(method=="exposure") choice=browser_color_metadata::Method::Exposure;
                else if(method=="contrast") choice=browser_color_metadata::Method::Contrast;
                else if(method=="white_balance") choice=browser_color_metadata::Method::WhiteBalance;
                else throw std::runtime_error("Invalid automatic color method");
            }
            const auto context=colorContext();
            auto nextColor=colorSession;
            if(!nextColor.active()) {
                MaskStorage target;const auto view=browser_view_scope::parse(request);
                if(selectedOnly&&view.enabled)target=browser_view_scope::effective(*context.scene,context.states,view,sceneMemoryForBudget(*budget,ResourceCategory::Work),true);
                if(!nextColor.begin(context,selectedOnly,std::move(target),colorIds))throw std::runtime_error("The color session is stale or busy");
            }
            // Desktop source-of-truth values are absolute from one immutable base.
            if(!nextColor.preview(context,values,selectedOnly,colorIds))
                throw std::runtime_error("The color session is stale or busy");
            browser_color_metadata::Capture captured;
            if(command=="autoColor") {
                captured=nextColor.captureAuto(context,choice,selectedOnly,colorIds);
            } else captured=nextColor.captureManual(context,colorIds);
            if(captured.disposition==browser_color_metadata::CaptureDisposition::ManualNoop) {
                colorSession=std::move(nextColor);
                alignmentSession.clear();
                floorCandidate.reset();
                return reply(prepared,summary());
            }
            if(!captured.request) throw std::runtime_error("The color request could not be captured");
            EditJob candidate;candidate.colorRequest=std::move(captured.request);candidate.colorValues=values;
            browser_auto_color::AnalysisOwner::Pointer analysis;
            if(command=="autoColor") {
                analysis=browser_auto_color::AnalysisOwner::create(analysisContext(*candidate.colorRequest),
                    sceneMemoryForBudget(*budget,ResourceCategory::Work));
            } else {
                const auto plan=nextColor.plan(*candidate.colorRequest,context,values);
                if(!plan) throw std::runtime_error("Invalid color bake plan");
                candidate.working=plan->scenePolicy==browser_color_metadata::ScenePolicy::NewWritableScene ?
                    std::make_shared<Scene>(*candidate.colorRequest->base) : nullptr;
                if(candidate.working) candidate.grade.emplace(values);
            }
            if(candidate.working && !alignmentLineage.inherit(candidate.working,candidate.colorRequest->base))
                throw std::runtime_error("Alignment history is full");
            static_assert(std::is_nothrow_move_assignable_v<EditJob>);
            colorSession=std::move(nextColor);job=std::move(candidate);autoColorJob=std::move(analysis);
            alignmentSession.clear();
        } else if(command=="transform") {
            EditJob candidate;
            candidate.working=std::make_shared<Scene>(*edits->scene());
            candidate.working->defaultView.reset();
            const bool selectedOnly=request.value("selectedOnly",false);const auto view=browser_view_scope::parse(request);
            candidate.publicationStates=selectedOnly&&view.enabled?
                browser_view_scope::effective(*edits->scene(),edits->maskSnapshot(),view,sceneMemoryForBudget(*budget,ResourceCategory::Work),true):edits->maskSnapshot();
            candidate.states.assign(candidate.publicationStates.begin(),candidate.publicationStates.end());
            candidate.affine.emplace(processing_detail::transform(request.at("matrix").get<Matrix4>()));
            if(!alignmentLineage.inherit(candidate.working,edits->scene())) throw std::runtime_error("Alignment history is full");
            if(selectedOnly) {
                for(auto &state:candidate.states) if(!(state&1)) state|=2;
            }
            job=std::move(candidate);
            alignmentSession.clear();
        } else if(command=="export") {
            if(!edits->scene()->isGaussian()) throw std::runtime_error("This PLY is view-only");
            const auto format=request.value("format",0);
            if(format<0 || format>8) throw std::runtime_error("Unsupported export format");
            const auto scope=request.value("scope",0);
            if(scope<0 || scope>2) throw std::runtime_error("Unsupported export scope");
            if(format==8) {
                if(checkpoint || edits->selectionDraft() || pendingSelectionMap || toleranceSession || floorDetection)
                    throw std::runtime_error("Finish the current operation before exporting");
                if(!budget) throw std::runtime_error("The scene has no resource budget");
                auto candidate=browser_spz_export::Job::create(edits->scene(),edits->maskSnapshot(),unsigned(scope),
                    sceneMemoryForBudget(*budget,ResourceCategory::Work));
                auto value=summary();value.pending=true;value.progress=0;
                value.exportBytes=checkedByteSum({value.exportOutputBytes,candidate->retainedBytes()});
                value.memoryBytes=budget->usage().totalBytes;
                if(!responses.summary(prepared,value)) return sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
                spzExport=std::move(candidate);return responses.publish(prepared);
            }
            if(browser_export::supported(unsigned(format))) {
                const auto bounds=browser_export::plan(unsigned(format),edits->scene()->gaussians.size(),edits->scene()->shDegree);
                if(!request.contains("outputCapacity") || !request.contains("nativeWorkBytes") ||
                   !request.at("outputCapacity").is_number_unsigned() || !request.at("nativeWorkBytes").is_number_unsigned() ||
                   request.at("outputCapacity").get<uint64_t>()!=bounds.outputCapacity ||
                   request.at("nativeWorkBytes").get<uint64_t>()!=bounds.workBytes)
                    throw std::runtime_error("Invalid attribute export admission plan");
                // A completed Color/Fill tolerance owner retains an adjustable
                // baseline, but its current masks are already committed. This
                // synchronous admitted copy preserves that owner and Redo.
                if(checkpoint || edits->selectionDraft() || pendingSelectionMap || floorDetection)
                    throw std::runtime_error("Finish the current operation before exporting");
                if(!budget) throw std::runtime_error("The scene has no resource budget");
                attributeCandidate=browser_export::encode(*edits->scene(),edits->states(),unsigned(format),unsigned(scope),
                    sceneMemoryForBudget(*budget,ResourceCategory::Work),bounds);
            } else throw std::runtime_error("Unsupported admitted export format");
            auto value=summary();
            value.memoryBytes-=value.exportOutputBytes;
            value.exportBytes=attributeCandidate ? attributeCandidate->retainedBytes() : 0;
            value.exportOutputBytes=value.exportBytes;
            if(!responses.summary(prepared,value))
                return sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
            exportPrepared=true;
        } else throw std::runtime_error("Unknown scene command");
        if(!exportPrepared) {
            if(command!="beginTransaction" && command!="commitTransaction" && command!="alignFloor") floorCandidate.reset();
            return reply(prepared,summary());
        }
        }
        }
        if(opacityChange)return publishOpacityChange(*opacityChange,prepared);
        if(transformChange)return publishTransformChange(*transformChange,prepared);
        if(filterChange) return publishFilterChange(*filterChange,prepared);
        // Only nonthrowing vector/context retirement and publication remain.
        browser_spz_export::OutputOwner::retire(spzOutput);
        browser_export::OutputOwner::retire(attributeOutput);
        attributeOutput=std::move(attributeCandidate);
        return responses.publish(prepared);
    } catch(const std::bad_alloc &) { browser_export::OutputOwner::retire(attributeCandidate);if(!mapCommand) retireJobs();return sv_response::failureReply(); }
      catch(const std::exception &e) { browser_export::OutputOwner::retire(attributeCandidate);if(!mapCommand) retireJobs();return replyError(prepared,e.what()); }
      catch(...) { browser_export::OutputOwner::retire(attributeCandidate);if(!mapCommand) retireJobs();return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const char *sv_live_preview(const char *text) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    try {
        sv_allocation::Scope allocationScope;
        if(!text)throw std::runtime_error("Invalid live selection command");
        const auto input=Json::parse(text);validateOperationMutation(input);
        if(colorSession.active()) throw std::runtime_error("Finish the color session before selection preview");
        if(geometry) throw std::runtime_error("Editing tools are available for Gaussian splats only.");
        if(!edits) throw std::runtime_error("Open a scene first");
        if(filterOwner) throw std::runtime_error("Confirm or cancel the selection filter first");
        if(transformOwner)throw std::runtime_error("End the transform session before selection preview");
        if(opacityOwner)throw std::runtime_error("End the opacity session before selection preview");
        retireFloorDetection();
        if(pendingJob()) throw std::runtime_error("An edit is already running");
        // Parsing, ownership/camera/path/map validation, admitted scratch,
        // volume sampling and candidate admission remain fatal on refusal.
        const auto outcome=[&] {
            const auto request=admitBrowserLiveSelection(input,*edits,
                sceneMemoryForBudget(*budget,ResourceCategory::Work),selectionMap.get());
            return browserLiveSelection(*edits,request);
        }();
        if(outcome==BrowserLiveSelectionOutcome::ComputationFailed)
            return responses.computationFailed(prepared) ? responses.publish(prepared) :
                sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        // Retire admitted request scratch before measuring retained payload.
        // The admitted current format and fixed scalar/topology domain make
        // this bounded response total; it allocates no DOM or output string.
        floorCandidate.reset();
        return responses.livePublished(prepared,summary()) ? responses.publish(prepared) :
            sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
    } catch(const std::bad_alloc &) { return sv_response::failureReply(); }
      catch(const std::exception &error) { return replyError(prepared,error.what()); }
      catch(...) { return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const char *sv_map_write(double id,unsigned offset,const uint8_t *bytes,unsigned length) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    try {
        sv_allocation::Scope allocationScope;
        if(operationLedger.blocks())throw std::runtime_error("Resolve the identified edit before uploading a selection map");
        if(geometry) throw std::runtime_error("Editing tools are available for Gaussian splats only.");
        if(!edits) throw std::runtime_error("Open a scene first");
        if(filterOwner) throw std::runtime_error("Confirm or cancel the selection filter first");
        if(transformOwner)throw std::runtime_error("End the transform session before uploading a selection map");
        if(opacityOwner)throw std::runtime_error("End the opacity session before uploading a selection map");
        if(!std::isfinite(id) || id<1 || id>9007199254740991. || std::floor(id)!=id)
            throw std::runtime_error("Invalid selection map ID");
        if(pendingJob() || checkpoint) throw std::runtime_error("Finish the edit before uploading a selection map");
        pruneSelectionMaps();
        if(!pendingSelectionMap || pendingSelectionMap->header.mapId!=uint64_t(id))
            throw std::runtime_error("Selection map upload is stale");
        const auto address=reinterpret_cast<uintptr_t>(bytes),heapBytes=emscripten_get_heap_size();
        if(!address || address%4 || address>heapBytes || length>heapBytes-address)
            throw std::runtime_error("Invalid selection map chunk memory");
        pendingSelectionMap->write(offset,std::span(bytes,length));
        return reply(prepared,summary());
    } catch(const std::bad_alloc &) { return sv_response::failureReply(); }
      catch(const std::exception &e) { return replyError(prepared,e.what()); }
      catch(...) { return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const char *sv_step(unsigned batch) {
    auto prepared=responses.begin();
    if(!prepared) return sv_response::failureReply(sv_response::FailureKind::Internal);
    if(recoveryBusy())return replyError(prepared,"Release the active checkpoint owner before changing the document");
    try {
        if(!pendingJob()) return reply(prepared,summary());
        sv_allocation::Scope allocationScope;
        if(transformFocusJob) {
            if(checkpoint||operationLedger.blocks()||filterOwner)
                throw std::runtime_error("Transform focus baseline is no longer settled");
            requireFocusPersistentOwnersCurrent();
            transformFocusJob->step(std::clamp(batch,1u,65536u),focusSnapshot());
            if(!transformFocusJob->complete())return reply(prepared,summary());
            const auto point=transformFocusJob->result();
            browser_focus::Job::retire(transformFocusJob);
            std::optional<sv_response::Point> result;
            if(point)result=sv_response::Point{point->x,point->y,point->z};
            return responses.point(prepared,summary(),result)?responses.publish(prepared):
                sv_response::failureReply(sv_response::FailureKind::InvalidResponse);
        }
        if(duplicateJob) {
            const auto status=duplicateJob->step(std::clamp(batch,1u,4096u));
            if(status==browser_duplicate::Status::Working)return reply(prepared,summary());
            if(status!=browser_duplicate::Status::Ready)throw std::runtime_error("Duplicate was cancelled");
            auto metadata=budget->reserve(ResourceCategory::Work,checkedByteSum({sizeof(SceneEdits),2*sizeof(browser_duplicate::Lineage),sizeof(browser_alignment::Lineage)}));
            auto next=std::make_unique<SceneEdits>(*edits);auto nextDuplicate=duplicateLineage;auto nextAlignment=alignmentLineage;
            duplicateJob->publish(*next,nextDuplicate);
            if(!nextAlignment.inherit(next->scene(),edits->scene()))throw std::runtime_error("Alignment history is full");
            browser_alignment::Session nextSession;
            auto value=alignmentSummary(*next,nextSession);
            const auto range=nextDuplicate.find(next->scene());
            if(!range)throw std::runtime_error("Duplicate candidate lost its suffix");
            value.duplicateRange=sv_response::DuplicateRange{range->first,range->count};
            alignmentMetadata(*value.alignment,*next,nextSession,nextAlignment);value.pending=false;value.progress=1;
            if(!responses.summary(prepared,value))throw std::runtime_error("Invalid Duplicate publication response");
            static_assert(std::is_nothrow_move_assignable_v<browser_duplicate::Lineage> &&
                          std::is_nothrow_move_assignable_v<browser_alignment::Lineage>);
            edits.swap(next);duplicateLineage=std::move(nextDuplicate);alignmentLineage=std::move(nextAlignment);alignmentSession.clear();
            floorCandidate.reset();selectionMap.reset();pendingSelectionMap.reset();toleranceSession.reset();morphologyRangeCache.clear();
            retireJobs();next.reset();metadata.release();value.memoryBytes=budget->usage().totalBytes;
            responses.summary(prepared,value);return responses.publish(prepared);
        }
        if(opacityJob) {
            if(!edits||!opacityOwner||!browser_opacity::current(*opacityOwner,opacityContext(*edits))||
               opacityJob->owner().id!=opacityOwner->id||opacityJob->owner().baseId!=opacityOwner->baseId||
               opacityJob->owner().epoch!=opacityOwner->epoch||opacityAttempt(opacityOwner->id).epoch!=opacityOwner->epoch||
               opacityJob->owner().base!=opacityOwner->base||opacityJob->owner().states.data()!=opacityOwner->states.data()||
               !browser_opacity::same(opacityJob->owner().acknowledged,opacityOwner->acknowledged))
                throw std::runtime_error("Opacity bake is stale");
            const auto status=opacityJob->step(std::clamp(batch,1u,65536u));
            if(status==browser_opacity::Status::Working)return reply(prepared,summary());
            if(status!=browser_opacity::Status::Ready)throw std::runtime_error("Opacity bake cancelled");
            const auto result=opacityJob->result();if(!alignmentLineage.inherit(result,opacityOwner->base))throw std::runtime_error("Alignment history is full");
            PreparedOpacityChange change;change.owner=opacityOwner;
            const auto &target=opacityJob->resetting()?opacityOwner->states:opacityOwner->targetStates();
            if(result!=edits->scene()||edits->maskSnapshot()!=target) {change.next=std::make_unique<SceneEdits>(*edits);change.next->replaceScene(result,target.span());}
            change.owner->appliedScale=opacityJob->scale();change.owner->appliedEpoch=change.owner->epoch;
            change.owner->acknowledged=opacityContext(change.next?*change.next:*edits);change.applied=true;
            change.response=opacitySummary(change.next?*change.next:*edits,change.owner);change.response.alignment->canReset=false;
            if(!responses.summary(prepared,change.response))throw std::runtime_error("Invalid opacity publication response");
            return publishOpacityChange(change,prepared);
        }
        if(transformJob) {
            if(!edits||!transformOwner||!browser_transform::current(*transformOwner,transformContext(*edits))||
               transformJob->owner().id!=transformOwner->id||transformJob->owner().baseId!=transformOwner->baseId||
               transformJob->owner().epoch!=transformOwner->epoch||transformAttempt(transformOwner->id).epoch!=transformOwner->epoch||
               transformJob->owner().base!=transformOwner->base||transformJob->owner().states.data()!=transformOwner->states.data()||
               !browser_transform::same(transformJob->owner().acknowledged,transformOwner->acknowledged))
                throw std::runtime_error("Transform bake is stale");
            const auto status=transformJob->step(std::clamp(batch,1u,65536u));
            if(status==browser_transform::Status::Working)return reply(prepared,summary());
            if(status!=browser_transform::Status::Ready)throw std::runtime_error("Transform bake cancelled");
            const auto result=transformJob->result();if(!alignmentLineage.inherit(result,transformOwner->base))throw std::runtime_error("Alignment history is full");
            PreparedTransformChange change;change.owner=transformOwner;change.next=std::make_unique<SceneEdits>(*edits);
            if(change.owner->kind==browser_transform::Kind::Gizmo&&!change.owner->cancelBase)
                change.owner->cancelBase=browser_transform::GizmoBaseline{transformOwner->base,transformOwner->states,transformOwner->baseId,transformOwner->acknowledged.contentRevision};
            change.next->replaceScene(result,transformOwner->targetStates().span());change.owner->applied=transformJob->parameters();
            change.owner->appliedPlan=transformJob->plan();change.owner->appliedBake=true;change.owner->appliedEpoch=change.owner->epoch;
            change.owner->pivot={change.owner->applied.pivot[0],change.owner->applied.pivot[1],change.owner->applied.pivot[2]};
            change.owner->acknowledged=transformContext(*change.next);change.applied=true;
            if(change.owner->kind==browser_transform::Kind::Gizmo)rebaseTransformResult(*change.owner,*change.next);
            change.response=transformSummary(*change.next,change.owner);change.response.alignment->canReset=false;
            if(!responses.summary(prepared,change.response))throw std::runtime_error("Invalid transform publication response");
            return publishTransformChange(change,prepared);
        }
        if(filterJob) {
            if(!edits || !filterOwner || !browser_filter::current(*edits,*filterOwner,nativeDocumentGeneration) ||
               filterJob->owner().id!=filterOwner->id || filterJob->owner().epoch!=filterOwner->epoch ||
               filterJob->owner().generation!=nativeDocumentGeneration || filterJob->owner().kind!=filterOwner->kind ||
               filterJob->owner().baseline.scene!=filterOwner->baseline.scene ||
               filterJob->owner().baseline.states.data()!=filterOwner->baseline.states.data())
                throw std::runtime_error("Selection filter preview is stale");
            const auto status=filterJob->step(std::clamp(batch,1u,65536u));
            if(status==browser_filter::Status::Working) return reply(prepared,summary());
            if(status!=browser_filter::Status::Ready) throw std::runtime_error("Filter preview cancelled");
            PreparedFilterChange change;change.owner=filterOwner;
            change.next=std::make_unique<SceneEdits>(*edits);
            BrowserSelectionAccess::replaceFilterPreview(*change.next,filterOwner->baseline,filterOwner->revision,filterJob->result());
            change.owner->revision=change.next->revision();change.owner->previewEpoch=change.owner->epoch;
            change.owner->changed=filterJob->changed();
            change.response=filterSummary(*change.next,change.owner);
            if(!responses.summary(prepared,change.response)) throw std::runtime_error("Invalid filter response");
            return publishFilterChange(change,prepared);
        }
        if(spzExport) {
            if(!edits || spzExport->sceneOwner()!=edits->scene() ||
               spzExport->maskOwner().data()!=edits->states().data() || spzExport->maskOwner().size()!=edits->states().size())
                throw std::runtime_error("The export scene changed");
            const auto status=spzExport->step(std::clamp(batch,1u,65536u));
            if(status==browser_spz_export::Status::Working) return reply(prepared,summary());
            if(status!=browser_spz_export::Status::Ready) throw std::runtime_error("Export cancelled");
            auto candidate=spzExport->takeOutput();
            auto value=summary();value.pending=false;value.progress=1;
            value.memoryBytes-=checkedByteSum({value.exportOutputBytes,spzExport->retainedBytes()});
            value.exportBytes=candidate->retainedBytes();value.exportOutputBytes=value.exportBytes;
            if(!responses.summary(prepared,value)) throw std::runtime_error("Invalid export response");
            browser_spz_export::OutputOwner::retire(spzOutput);
            browser_export::OutputOwner::retire(attributeOutput);
            browser_spz_export::Job::retire(spzExport);
            spzOutput=std::move(candidate);
            return responses.publish(prepared);
        }
        if(floorDetection) {
            if(!currentFloor(floorDetection->key)) throw std::runtime_error("Floor detection is stale");
            const auto status=floorDetection->job->step(std::clamp(batch,1u,65536u));
            if(!currentFloor(floorDetection->key)) throw std::runtime_error("Floor detection is stale");
            if(status==browser_floor::Status::Working) return reply(prepared,summary());
            if(status!=browser_floor::Status::Candidate && status!=browser_floor::Status::None)
                throw std::runtime_error("Floor detection was cancelled");
            browser_floor::Candidate candidate{floorDetection->id,floorDetection->key,floorDetection->selectedOnly,
                floorDetection->job->result()};
            if(candidate.plane && !browser_floor::validPlane(*candidate.plane,edits->scene()->gaussians.size()))
                throw std::runtime_error("Invalid detected floor");
            // Sampling storage and its strong scene/mask owners retire before
            // the tiny scalar result is admitted. Detection never clones edits.
            retireFloorDetection();
            auto retained=browser_floor::retain(std::move(candidate),sceneMemoryForBudget(*budget,ResourceCategory::Work));
            auto value=summary();value.floor=floorResult(*retained);value.memoryBytes=budget->usage().totalBytes;
            if(!responses.summary(prepared,value)) throw std::runtime_error("Invalid floor response");
            floorCandidate=std::move(retained);return responses.publish(prepared);
        }
        if(morphologyRangeJob) {
            if(!edits||edits->scene()!=morphologyRangeJob->scene()||checkpoint||operationLedger.blocks()||filterOwner||
               edits->selectionDraft()||pendingSelectionMap||!budget)throw std::runtime_error("Morphology range source changed or is unsettled");
            requireFocusPersistentOwnersCurrent();
            morphologyRangeJob->step(std::clamp(batch,1u,65536u));
            if(morphologyRangeJob->complete()) {
                const auto result=*morphologyRangeJob->result();const auto scene=morphologyRangeJob->scene();
                morphologyRangeJob.reset();morphologyRangeJob.get_deleter().memory.reset();
                auto value=summary();value.morphologyRange=sv_response::MorphologyRange{result.minimum,result.maximum,result.initial};
                if(!responses.summary(prepared,value))throw std::runtime_error("Invalid morphology range publication");
                morphologyRangeCache.publish(scene,result);return responses.publish(prepared);
            }
            return reply(prepared,summary());
        }
        if(morphologyJob) {
            if(!BrowserSelectionAccess::morphologyCurrent(*edits,morphologyJob->baseline()))
                throw std::runtime_error("Selection morphology is stale");
            morphologyJob->step(std::clamp(batch,1u,65536u));
            if(morphologyJob->complete()) {
                BrowserSelectionAccess::publishMorphology(*edits,morphologyJob->baseline(),morphologyJob->result());
                // Retire all physical work arrays and borrowed owners before the
                // terminal summary measures retained native payload.
                retireJobs();
            }
            return reply(prepared,summary());
        }
        if(autoColorJob) {
            if(!job || !job->colorRequest || !colorSession.current(*job->colorRequest,colorContext()))
                throw std::runtime_error("Automatic color analysis is stale");
            const auto captured=analysisContext(*job->colorRequest);
            autoColorJob->step(std::clamp(batch,1u,65536u),captured);
            if(autoColorJob->pending()) return reply(prepared,summary());
            const auto result=autoColorJob->result(captured);
            if(!result) throw std::runtime_error("Automatic color analysis failed");
            job->colorValues=browser_color_metadata::BrowserColorSession::merge(job->colorRequest->capturedValues,
                result->suggestions[static_cast<unsigned>(job->colorRequest->method)],job->colorRequest->method);
            // Scratch retires before allocating a writable bake of the base.
            browser_auto_color::AnalysisOwner::retire(autoColorJob);
            const auto plan=colorSession.plan(*job->colorRequest,colorContext(),job->colorValues);
            if(!plan) throw std::runtime_error("Invalid automatic color bake");
            if(plan->scenePolicy==browser_color_metadata::ScenePolicy::NewWritableScene) {
                job->working=std::make_shared<Scene>(*job->colorRequest->base);
                if(!alignmentLineage.inherit(job->working,job->colorRequest->base))
                    throw std::runtime_error("Alignment history is full");
                job->grade.emplace(job->colorValues);
            }
        }
        if(job->alignment) {
            const auto &request=*job->alignment;
            const auto before=alignmentContext(*edits);
            if(!browser_alignment::sameContext(request.before,before) || !browser_alignment::validContext(before))
                throw std::runtime_error("The alignment publication is stale");
            const auto end=std::min(job->cursor+std::clamp(batch,1u,65536u),job->working->gaussians.size());
            for(;job->cursor<end;++job->cursor) {
                // Every record changes coordinates, including unselected and
                // cleanup-hidden/deleted records. Both operations preserve
                // opacity and covariance padding. Plane alignment rotates SH;
                // Center also preserves covariance, while Scale preserves SH.
                auto &gaussian=job->working->gaussians[job->cursor];
                if(job->affine) {
                    // Positive uniform Scale uses the captured double affine
                    // position/covariance sums, then casts to float32. It has
                    // no SH orientation change and does not filter masks.
                    job->affine->apply(gaussian);
                    if(job->shRotation) job->shRotation->apply(gaussian);
                } else {
                    auto &position=gaussian.positionOpacity;
                    position[0]+=request.delta.x;position[1]+=request.delta.y;position[2]+=request.delta.z;
                    if(!std::isfinite(position[0]) || !std::isfinite(position[1]) || !std::isfinite(position[2]))
                        throw std::runtime_error("Alignment exceeds the supported coordinate range.");
                }
            }
            if(job->cursor<job->working->gaussians.size()) return reply(prepared,summary());
            fitBounds(*job->working,sceneMemoryForBudget(*budget,ResourceCategory::Work));
            browser_alignment::validateSceneCamera(*job->working,request.defaultAspect);
            browser_alignment::validateCamera(request.camera,request.aspect);
            browser_alignment::validateCamera(request.defaultCamera,request.defaultAspect);
            auto next=std::make_unique<SceneEdits>(*edits);
            next->replaceScene(job->working,before.states);
            auto nextSession=request.session;
            if(!nextSession.acknowledge(before,alignmentContext(*next)))
                throw std::runtime_error("The alignment publication could not be acknowledged");
            auto value=alignmentSummary(*next,nextSession);
            if(!responses.summary(prepared,value))
                throw std::runtime_error("Invalid alignment response");
            edits.swap(next);alignmentSession=std::move(nextSession);
            floorCandidate.reset();
            selectionMap.reset();pendingSelectionMap.reset();toleranceSession.reset();
            retireJobs();next.reset();
            value.memoryBytes=budget->usage().totalBytes;
            responses.summary(prepared,value); // Only retained-byte accounting changed after retirement.
            // Prevalidated fixed-storage reply was built before publication.
            return responses.publish(prepared);
        }
        if(job->colorRequest) {
            const auto before=colorContext();
            if(!colorSession.current(*job->colorRequest,before)) throw std::runtime_error("The color bake is stale");
            if(job->working) {
                const auto end=std::min(job->cursor+std::clamp(batch,1u,65536u),job->working->gaussians.size());
                const auto states=job->colorRequest->targetStates().span();
                for(;job->cursor<end;++job->cursor) {
                    if(states[job->cursor]==2 || (job->colorRequest->key.selectedOnly && states[job->cursor]!=1)) continue;
                    auto &g=job->working->gaussians[job->cursor];
                    auto coefficients=processing_detail::coefficients(g);
                    const auto bands=std::min(job->working->shDegree,3u)+1;
                    job->grade->apply(coefficients,bands*bands);processing_detail::store(g,coefficients);
                }
                if(job->cursor<job->working->gaussians.size()) return reply(prepared,summary());
            }
            const auto plan=colorSession.plan(*job->colorRequest,before,job->colorValues);
            if(!plan) throw std::runtime_error("The color publication is stale");
            // Stage native history and metadata together. Refusal leaves the
            // current document and session untouched, even for direct ABI calls.
            auto next=std::make_unique<SceneEdits>(*edits);
            if(plan->sceneReplacementRequired||edits->maskSnapshot()!=job->colorRequest->targetStates()) next->replaceScene(job->working ?
                std::shared_ptr<const Scene>{job->working} : job->colorRequest->base,job->colorRequest->targetStates().span());
            auto nextColor=colorSession;
            const browser_color_metadata::Context after{next->scene(),next->maskSnapshot(),nativeDocumentGeneration,
                nativeDocumentGeneration,next->revision(),next->contentRevision(),true};
            if(!nextColor.markApplied(*job->colorRequest,before,after,job->colorValues,
                after.states==job->colorRequest->targetStates()))
                throw std::runtime_error("The color publication could not be acknowledged");
            static_assert(std::is_nothrow_move_assignable_v<browser_color_metadata::BrowserColorSession>);
            edits.swap(next);colorSession=std::move(nextColor);
            retireJobs();next.reset();
            return reply(prepared,summary());
        }
        const auto end=std::min(job->cursor+std::clamp(batch,1u,65536u),job->working->gaussians.size());
        for(;job->cursor<end;++job->cursor) {
            if(job->states[job->cursor]&2) continue;
            auto &g=job->working->gaussians[job->cursor];
            if(job->grade) {
                auto coefficients=processing_detail::coefficients(g);
                const auto bands=std::min(job->working->shDegree,3u)+1;
                job->grade->apply(coefficients,bands*bands);
                processing_detail::store(g,coefficients);
            } else if(job->affine) job->affine->apply(g);
        }
        if(job->cursor==job->working->gaussians.size()) {
            if(job->affine) fitBounds(*job->working,sceneMemoryForBudget(*budget,ResourceCategory::Work));
            edits->replaceScene(job->working,job->publicationStates.hasStorage()?job->publicationStates.span():edits->states()); retireJobs();
        }
        return reply(prepared,summary());
    } catch(const std::bad_alloc &) { retireJobs();return sv_response::failureReply(); }
      catch(const std::exception &e) { retireJobs();return replyError(prepared,e.what()); }
      catch(...) { retireJobs();return sv_response::failureReply(sv_response::FailureKind::Internal); }
}
const Gaussian *sv_scene_ptr() { return edits ? edits->scene()->gaussians.data() : nullptr; }
const uint8_t *sv_states_ptr() { return edits ? edits->states().data() : nullptr; }
const uint32_t *sv_pack(unsigned first,unsigned count) {
    if(recoveryBusy())return nullptr;
    try {
        if(!edits) { packed.clear(); return nullptr; }
        sv_allocation::Scope allocationScope;
        const auto &scene=*edits->scene();
        if(first>scene.gaussians.size()) return nullptr;
        count=std::min<unsigned>(count,unsigned(scene.gaussians.size()-first));
        const auto degree=std::min(scene.shDegree,3u),shWords=(3*(degree+1)*(degree+1)+1)/2;
        const auto words=10+shWords;
        packed.resize(checkedByteProduct(size_t(count),size_t(words)));
        for(size_t i=0;i<count;++i) {
            std::memcpy(packed.data()+i*words,&scene.gaussians[first+i],40);
            std::memcpy(packed.data()+i*words+10,scene.gaussians[first+i].sh.data(),shWords*4);
        }
        return packed.data();
    } catch(...) { return nullptr; }
}
unsigned sv_pack_len() { return unsigned(packed.size()*4); }
const uint32_t *sv_pack_color_base(unsigned first,unsigned count) {
    if(recoveryBusy())return nullptr;
    try {
        if(!edits || !colorSession.active() || pendingJob()) {packed.clear();return nullptr;}
        const auto base=colorSession.base();
        if(!base || first>base->gaussians.size()) {packed.clear();return nullptr;}
        sv_allocation::Scope allocationScope;
        count=std::min<unsigned>(count,unsigned(base->gaussians.size()-first));
        const auto degree=std::min(base->shDegree,3u),shWords=(3*(degree+1)*(degree+1)+1)/2;
        const auto words=10+shWords;packed.resize(checkedByteProduct(size_t(count),size_t(words)));
        for(size_t i=0;i<count;++i) {
            std::memcpy(packed.data()+i*words,&base->gaussians[first+i],40);
            std::memcpy(packed.data()+i*words+10,base->gaussians[first+i].sh.data(),shWords*4);
        }
        return packed.data();
    } catch(...) {return nullptr;}
}
const uint8_t *sv_color_base_states_ptr(double sessionId,double baseId,double epochId) noexcept {
    const auto integer=[](double v){return std::isfinite(v)&&v>=1&&v<=9007199254740991.&&std::floor(v)==v;};
    if(recoveryBusy()||!edits||!colorSession.active()||!colorSession.currentBase(colorContext())||pendingJob()||!integer(sessionId)||!integer(baseId)||!integer(epochId)||
       colorSession.sessionId()!=uint64_t(sessionId)||colorSession.baseId()!=uint64_t(baseId)||colorSession.epochId()!=uint64_t(epochId))return nullptr;
    return colorSession.targetStates().data();
}
bool sv_transform_base_current(double id,double baseId,double epoch) noexcept {
    const auto integer=[](double value,bool zero) {return std::isfinite(value)&&value>=(zero?0.:1.)&&value<=9007199254740991.&&std::floor(value)==value;};
    return edits&&transformOwner&&!pendingJob()&&integer(id,false)&&integer(baseId,false)&&integer(epoch,true)&&
        transformOwner->id==uint64_t(id)&&transformOwner->baseId==uint64_t(baseId)&&transformOwner->epoch==uint64_t(epoch)&&
        browser_transform::current(*transformOwner,transformContext(*edits));
}
const uint32_t *sv_pack_transform_base(double id,double baseId,double epoch,unsigned first,unsigned count) {
    if(recoveryBusy())return nullptr;
    try {
        if(!sv_transform_base_current(id,baseId,epoch)){packed.clear();return nullptr;}
        const auto &base=*transformOwner->base;if(first>base.gaussians.size()){packed.clear();return nullptr;}
        sv_allocation::Scope allocationScope;count=std::min<unsigned>(count,unsigned(base.gaussians.size()-first));
        const auto degree=std::min(base.shDegree,3u),shWords=(3*(degree+1)*(degree+1)+1)/2,words=10+shWords;
        packed.resize(checkedByteProduct(size_t(count),size_t(words)));
        for(size_t i=0;i<count;++i){std::memcpy(packed.data()+i*words,&base.gaussians[first+i],40);std::memcpy(packed.data()+i*words+10,base.gaussians[first+i].sh.data(),shWords*4);}
        return packed.data();
    }catch(...){return nullptr;}
}
const uint8_t *sv_transform_base_states_ptr(double id,double baseId,double epoch) noexcept {
    return sv_transform_base_current(id,baseId,epoch)?transformOwner->targetStates().data():nullptr;
}
bool sv_opacity_base_current(double id,double baseId,double epoch) noexcept {
    const auto integer=[](double value,bool zero){return std::isfinite(value)&&value>=(zero?0:1)&&value<=9007199254740991.&&std::floor(value)==value;};
    return edits&&opacityOwner&&!pendingJob()&&integer(id,false)&&integer(baseId,false)&&integer(epoch,true)&&
        opacityOwner->id==uint64_t(id)&&opacityOwner->baseId==uint64_t(baseId)&&opacityOwner->epoch==uint64_t(epoch)&&
        (epoch!=0||!opacityOwner->appliedEpoch)&&browser_opacity::current(*opacityOwner,opacityContext(*edits));
}
const uint32_t *sv_pack_opacity_base(double id,double baseId,double epoch,unsigned first,unsigned count) {
    if(recoveryBusy())return nullptr;
    try {
        if(!sv_opacity_base_current(id,baseId,epoch)){packed.clear();return nullptr;}
        const auto &base=*opacityOwner->base;if(first>base.gaussians.size()){packed.clear();return nullptr;}
        sv_allocation::Scope allocationScope;count=std::min<unsigned>(count,unsigned(base.gaussians.size()-first));
        const auto degree=std::min(base.shDegree,3u),shWords=(3*(degree+1)*(degree+1)+1)/2,words=10+shWords;
        packed.resize(checkedByteProduct(size_t(count),size_t(words)));
        for(size_t i=0;i<count;++i){std::memcpy(packed.data()+i*words,&base.gaussians[first+i],40);std::memcpy(packed.data()+i*words+10,base.gaussians[first+i].sh.data(),shWords*4);}
        return packed.data();
    }catch(...){packed.clear();return nullptr;}
}
const uint8_t *sv_opacity_base_states_ptr(double id,double baseId,double epoch) noexcept {
    return sv_opacity_base_current(id,baseId,epoch)?opacityOwner->targetStates().data():nullptr;
}
const uint8_t *sv_geometry_range(unsigned channel,unsigned first,unsigned count) {
    if(recoveryBusy())return nullptr;
    geometryRangeBytes=0;
    if(!geometry) return nullptr;
    try {
        geometryRangeBytes=browserGeometryRangeBytes(*geometry,channel,first,count);
        if(!geometryRangeBytes) return nullptr;
        if(channel==0) return reinterpret_cast<const uint8_t *>(geometry->vertices.data()+first);
        return reinterpret_cast<const uint8_t *>(geometry->triangles.data())+size_t(first)*sizeof(uint32_t);
    } catch(...) { geometryRangeBytes=0; return nullptr; }
}
unsigned sv_geometry_range_len() { return unsigned(geometryRangeBytes); }
const uint8_t *sv_output_ptr() { return attributeOutput ? attributeOutput->data() : spzOutput ? spzOutput->data() : nullptr; }
unsigned sv_output_len() { return unsigned(attributeOutput ? attributeOutput->size() : spzOutput ? spzOutput->size() : 0); }
unsigned sv_spz4_output_bound(unsigned count,unsigned degree) {
    try { return unsigned(browser_spz_export::plan(count,degree).outputCapacity); } catch(...) { return 0; }
}
unsigned sv_spz4_work_bound(unsigned count,unsigned degree) {
    try { return unsigned(browser_spz_export::plan(count,degree).workBytes); } catch(...) { return 0; }
}
unsigned sv_export_output_bound(unsigned format,unsigned count,unsigned degree) {
    if(format==8) return sv_spz4_output_bound(count,degree);
    try { return unsigned(browser_export::plan(format,count,degree).outputCapacity); } catch(...) { return 0; }
}
unsigned sv_export_work_bound(unsigned format,unsigned count,unsigned degree) {
    if(format==8) return sv_spz4_work_bound(count,degree);
    try { return unsigned(browser_export::plan(format,count,degree).workBytes); } catch(...) { return 0; }
}
}
