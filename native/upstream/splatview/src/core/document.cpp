#include "document.hpp"
#include "background_jobs.hpp"
#include "file_io.hpp"
#include "source_snapshot.hpp"
#include "processing_kernels.hpp"
#include "geometry_tools.hpp"
#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <stdexcept>
#include <type_traits>

namespace preview {
static_assert(std::is_nothrow_move_constructible_v<ProcessingSnapshot>);
static_assert(std::is_nothrow_move_constructible_v<ExportSnapshot>);
static_assert(std::is_nothrow_default_constructible_v<Recipe>);
static_assert(noexcept(std::declval<Recipe &>().swap(std::declval<Recipe &>())));
namespace {
uint64_t nextDocumentIdentity() {
    static std::atomic<uint64_t> sequence{};
    return sequence.fetch_add(1,std::memory_order_relaxed)+1;
}
std::string lowercase(std::string text) { for(auto &c:text) c=char(std::tolower(static_cast<unsigned char>(c))); return text; }
bool naturalLess(std::string_view a,std::string_view b) {
    size_t i=0,j=0;
    while(i<a.size() && j<b.size()) {
        if(std::isdigit(static_cast<unsigned char>(a[i])) && std::isdigit(static_cast<unsigned char>(b[j]))) {
            const auto ai=i,bj=j;
            while(i<a.size() && a[i]=='0') ++i;
            while(j<b.size() && b[j]=='0') ++j;
            const auto an=i,bn=j;
            while(i<a.size() && std::isdigit(static_cast<unsigned char>(a[i]))) ++i;
            while(j<b.size() && std::isdigit(static_cast<unsigned char>(b[j]))) ++j;
            if(i-an!=j-bn) return i-an<j-bn;
            const auto order=a.substr(an,i-an).compare(b.substr(bn,j-bn));
            if(order) return order<0;
            if(i-ai!=j-bj) return i-ai<j-bj;
        } else { if(a[i]!=b[j]) return a[i]<b[j]; ++i; ++j; }
    }
    return a.size()<b.size();
}
Camera carryCamera(const Camera &camera,const Scene &before,const Scene &after) {
    if(before.alignmentFrame==after.alignmentFrame) return camera;
    using namespace DirectX;
    Matrix4 transform;
    XMStoreFloat4x4(reinterpret_cast<XMFLOAT4X4 *>(transform.data()),
        XMMatrixInverse(nullptr,XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(before.alignmentFrame.data()))) *
        XMLoadFloat4x4(reinterpret_cast<const XMFLOAT4X4 *>(after.alignmentFrame.data())));
    return camera.transformed(transform);
}
void requireSceneBudget(const Scene &scene,const std::optional<ResourceBudget> &resources,const char *message) {
    if(!resources) return;
    const auto payload=checkedByteSum({checkedByteProduct(scene.gaussians.capacity(),sizeof(Gaussian)),
        checkedByteProduct(scene.vertices.capacity(),sizeof(PreviewVertex)),
        checkedByteProduct(scene.triangles.capacity(),sizeof(std::array<uint32_t,3>))});
    if(accountedSceneStorageBytes(scene,*resources)!=payload) throw std::runtime_error(message);
}
} // namespace
SceneExportFormat exportFormatForPath(const std::filesystem::path &path) {
    const auto name=lowercase(pathUtf8(path.filename()));
    if(name.ends_with(".compressed.ply")) return SceneExportFormat::CompressedPly;
    if(name.ends_with(".ply")) return SceneExportFormat::Ply;
    if(name.ends_with(".spz")) return SceneExportFormat::Spz;
    if(name.ends_with(".splat")) return SceneExportFormat::Splat;
    if(name.ends_with(".ksplat")) return SceneExportFormat::Ksplat;
    if(name.ends_with(".sog")) return SceneExportFormat::Sog;
    if(name.ends_with(".sogs")) return SceneExportFormat::Sogs;
    if(name.ends_with(".csv")) return SceneExportFormat::Csv;
    throw std::runtime_error("Use a supported scene export extension");
}
void rejectOutputAliases(const std::filesystem::path &output,std::span<const std::filesystem::path> inputs,
                         std::stop_token stop,std::optional<ResourceBudget> resources) {
    const auto check=[&] { if(stop.stop_requested()) throw std::runtime_error("Output cancelled"); };
    check();
    auto destination=std::filesystem::weakly_canonical(output);
    for(const auto &input:inputs) {
        check();
        std::error_code ec;
        if(destination==std::filesystem::weakly_canonical(input) || std::filesystem::equivalent(output,input,ec))
            throw std::runtime_error("Output must be a different file from all inputs");
        if(std::filesystem::is_directory(input) || input.filename()=="meta.json") {
            for(const auto &member:sourceMemberPaths(input,stop,resources)) {
                check();
                if(destination==std::filesystem::weakly_canonical(member) || std::filesystem::equivalent(output,member,ec))
                    throw std::runtime_error("Output must not replace an unpacked SOG input member");
            }
        }
    }
}
Document::Document():identity_(nextDocumentIdentity()) {}
void Document::captureCheckpoint(std::string_view seam) const {
    if(captureCheckpoint_) captureCheckpoint_(captureCheckpointContext_,seam);
}
void Document::open(const std::filesystem::path &path,LoadOptions options) {
    auto loaded=loadSceneWithSources(path,options);
    replace(path,std::make_shared<Scene>(std::move(loaded.scene)),options.resources,std::move(loaded.sourceMembers));
}
void Document::replace(const std::filesystem::path &path,std::shared_ptr<const Scene> scene,
                       std::optional<ResourceBudget> resources,std::vector<std::filesystem::path> sourceMembers) {
    if(!scene) throw std::runtime_error("Cannot open an empty document");
    requireSceneBudget(*scene,resources,"Replacement scene storage does not belong to the document budget");
    captureCheckpoint("replace.path");
    auto nextPath=path;
    captureCheckpoint("replace.inputs");
    std::vector<std::filesystem::path> nextInputs{nextPath};
    for(auto &member:sourceMembers)
        if(std::find(nextInputs.begin(),nextInputs.end(),member)==nextInputs.end()) nextInputs.push_back(std::move(member));
    captureCheckpoint("replace.edits");
    auto edits=scene->isGaussian()?std::make_unique<SceneEdits>(scene,
        resources ? sceneMemoryForBudget(*resources,ResourceCategory::History) : nullptr,
        resources ? sceneMemoryForBudget(*resources,ResourceCategory::Work) : nullptr):nullptr;
    auto nextCamera=camera; nextCamera.fit(*scene);
    captureCheckpoint("replace.ready");
    // Finish allocating the replacement before changing any owner state.
    path_.swap(nextPath); inputPaths_.swap(nextInputs); original_.swap(scene); edits_.swap(edits);
    resources_.swap(resources);
    camera=nextCamera; savedRevision_=0; ++generation_;
    clearDrafts();
}
bool Document::markSaved(SavePoint point) {
    if(point.documentIdentity!=identity_ || point.sourceGeneration!=generation_ || !edits_) return false;
    savedRevision_=point.contentRevision;
    return true;
}
ProcessingResult ProcessingSnapshot::run(std::stop_token stop) const {
    if(!scene_ || !documentIdentity_)
        throw std::runtime_error("Cannot run an uninitialized processing snapshot");
    if(floorOptions_) {
        if(stop.stop_requested()) throw std::runtime_error("Processing cancelled");
        const auto plane=detectFloor(*scene_,states_,selectedOnly_,*floorOptions_,stop,
            resources_ ? sceneMemoryForBudget(*resources_,ResourceCategory::Work) : nullptr);
        if(stop.stop_requested()) throw std::runtime_error("Processing cancelled");
        if(!plane) throw std::runtime_error("No floor plane found");
        const auto transform=alignFloor(*plane);
        const AlignmentView alignment{transform,floorDefaultCamera_->transformed(transform).savedView()};
        return processScene(scene_,states_,matrixRecipe(transform),selectedOnly_,stop,alignment,resources_);
    }
    if(draft_==Draft::OperationReset) {
        if(stop.stop_requested()) throw std::runtime_error("Processing cancelled");
        ProcessingResult result; result.scene=scene_;
        result.states=SceneVector<uint8_t>(states_.begin(),states_.end(),SceneAllocator<uint8_t>{
            resources_ ? sceneMemoryForBudget(*resources_,ResourceCategory::Work) : nullptr});
        result.message="Operation reset.";
        return result;
    }
    auto result=processScene(scene_,states_,recipe_,selectedOnly_,stop,alignmentView_,resources_);
    if(automaticColor_) {
        // Match Viewer .74: analyze the ungraded session base, replace only the
        // requested automatic fields, then bake the entire absolute grade once.
        const auto method=recipe_.at("values").at("method").get<std::string>();
        const auto &suggested=result.report.at("suggested_color");
        Recipe values=Recipe::object();
        for(size_t k=0;k<automaticColor_->size();++k) {
            const bool adjust=((method=="enhance" || method=="exposure") && k==0) ||
                ((method=="enhance" || method=="contrast") && k==1) ||
                ((method=="enhance" || method=="white_balance") && (k==5 || k==6));
            values[colorFields[k].name]=adjust ? suggested.at(colorFields[k].name).get<float>() : (*automaticColor_)[k];
        }
        auto report=std::move(result.report);
        result=processScene(scene_,states_,{{"type","color"},{"values",values}},selectedOnly_,stop,{},resources_);
        result.report=std::move(report); result.report["suggested_color"]=std::move(values);
    }
    return result;
}
void Document::clearColorSession() noexcept {
    colorBase_.reset(); color_=appliedColor_=neutralColor; colorSelectedOnly_=false;
    colorEditRevision_=0; ++draftRevision_;
}
void Document::clearDrafts() noexcept {
    clearColorSession(); geometry_=identityMatrix; geometrySelectedOnly_=false; geometryEditRevision_=0;
    endOperationSession();
}
void Document::previewColor(const ColorValues &values,bool selectedOnly) {
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    (void)processing_detail::Grade(values);
    if(transformPending()) throw std::runtime_error("Apply or cancel the transform preview before editing colors");
    if(colorBase_ && (colorSelectedOnly_!=selectedOnly || colorEditRevision_!=revision())) {
        if(colorPending()) throw std::runtime_error("Flush or cancel colors before changing their selection scope");
        clearColorSession();
    }
    if(!colorBase_) {
        endOperationSession();
        if(values==neutralColor) return;
        colorBase_=scene(); colorEditRevision_=revision(); colorSelectedOnly_=selectedOnly;
    }
    if(color_!=values) { color_=values; ++draftRevision_; }
}
void Document::resetColor() {
    if(colorBase_) previewColor(neutralColor,colorSelectedOnly_);
}
void Document::cancelColorDraft() {
    if(!colorBase_) return;
    if(colorEditRevision_!=revision()) { clearColorSession(); return; }
    if(color_!=appliedColor_) { color_=appliedColor_; ++draftRevision_; }
}
void Document::endColorSession() {
    if(colorPending()) throw std::runtime_error("Flush or cancel pending colors before ending the session");
    if(colorBase_) clearColorSession();
}
void Document::previewTransform(const Matrix4 &matrix,bool selectedOnly) {
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    processing_detail::transform(matrix); // Validate without allocating a scene.
    if(colorPending()) throw std::runtime_error("Flush or cancel colors before editing geometry");
    if(transformPending() && geometryEditRevision_!=revision())
        throw std::runtime_error("Selection or content changed; cancel the old transform draft before continuing");
    endColorSession();
    if(!transformPending()) geometryEditRevision_=matrix!=identityMatrix ? revision() : 0;
    const bool scope=matrix!=identityMatrix && selectedOnly;
    if(geometry_!=matrix || geometrySelectedOnly_!=scope) {
        geometry_=matrix; geometrySelectedOnly_=scope; ++draftRevision_;
    }
    if(matrix==identityMatrix) geometryEditRevision_=0;
}
void Document::cancelTransformDraft() {
    if(geometry_!=identityMatrix || geometrySelectedOnly_) {
        geometry_=identityMatrix; geometrySelectedOnly_=false; geometryEditRevision_=0; ++draftRevision_;
    }
}
ViewSettings Document::previewSettings(ViewSettings settings) const {
    settings.color=colorBase_ ? color_ : neutralColor;
    settings.colorSelectedOnly=colorBase_ && colorSelectedOnly_;
    settings.geometry=geometry_; settings.geometrySelectedOnly=geometrySelectedOnly_;
    return settings;
}
ProcessingSnapshot Document::snapshot(const Recipe &recipe,bool selectedOnly) const {
    return snapshot(recipe,selectedOnly,scene(),maskSnapshot());
}
ProcessingSnapshot Document::snapshot(const Recipe &recipe,bool selectedOnly,std::shared_ptr<const Scene> source,
                                      const MaskStorage &sourceStates) const {
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    ProcessingSnapshot snapshot;
    snapshot.scene_=std::move(source);
    captureCheckpoint("snapshot.mask");
    snapshot.states_=sourceStates;
    captureCheckpoint("snapshot.recipe");
    snapshot.recipe_=recipe;
    snapshot.selectedOnly_=selectedOnly; snapshot.generation_=generation_; snapshot.revision_=revision();
    snapshot.documentIdentity_=identity_; snapshot.draftRevision_=draftRevision_;
    snapshot.resources_=resources_;
    return snapshot;
}
std::optional<ProcessingSnapshot> Document::captureColor() const {
    if(!colorPending()) return {};
    if(colorEditRevision_!=revision())
        throw std::runtime_error("Selection or content changed; cancel the old color draft before continuing");
    captureCheckpoint("color.recipe");
    Recipe values=Recipe::object();
    for(size_t i=0;i<color_.size();++i) values[colorFields[i].name]=color_[i];
    auto job=snapshot({{"type","color"},{"values",std::move(values)}},colorSelectedOnly_,colorBase_,maskSnapshot());
    job.draft_=ProcessingSnapshot::Draft::Color;
    captureCheckpoint("capture.ready");
    return job;
}
ProcessingSnapshot Document::captureAutoColor(const std::string &method,bool selectedOnly) {
    if(method!="enhance" && method!="exposure" && method!="contrast" && method!="white_balance")
        throw std::runtime_error("Unknown automatic color adjustment");
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    if(transformPending()) throw std::runtime_error("Apply or cancel the transform preview before editing colors");
    const bool newSession=!colorBase_ || colorSelectedOnly_!=selectedOnly || colorEditRevision_!=revision();
    if(newSession && colorPending()) throw std::runtime_error("Flush or cancel colors before changing their selection scope");
    const auto base=newSession ? scene() : colorBase_;
    const auto values=newSession ? neutralColor : color_;
    captureCheckpoint("auto.recipe");
    auto job=snapshot({{"type","auto"},{"values",{{"method",method}}},{"analyze_only",true}},selectedOnly,base,maskSnapshot());
    job.draft_=ProcessingSnapshot::Draft::AutoColor; job.automaticColor_=values;
    captureCheckpoint("capture.ready");
    // No allocating operation follows this commit, including the return move.
    if(newSession && colorBase_) clearColorSession();
    endOperationSession();
    if(newSession) { colorBase_=base; colorEditRevision_=revision(); colorSelectedOnly_=selectedOnly; }
    ++draftRevision_; // A successfully captured Auto supersedes the previous one.
    job.draftRevision_=draftRevision_;
    return job;
}
std::optional<ProcessingSnapshot> Document::captureTransform() const {
    if(!transformPending()) return {};
    if(colorPending()) throw std::runtime_error("Flush or cancel colors before applying geometry");
    if(geometryEditRevision_!=revision())
        throw std::runtime_error("Selection or content changed; cancel the old transform draft before continuing");
    captureCheckpoint("transform.recipe");
    auto job=snapshot(matrixRecipe(geometry_),geometrySelectedOnly_);
    job.draft_=ProcessingSnapshot::Draft::Transform;
    captureCheckpoint("capture.ready");
    return job;
}
std::string_view Document::activeOperation() const {
    return edits_ && scene()==operationResult_ && revision()==operationRevision_ ? std::string_view(operationGroup_) : std::string_view{};
}
void Document::endOperationSession() noexcept {
    if(!operationBase_) return;
    operationBase_.reset(); operationResult_.reset(); operationStates_.clear(); operationGroup_.clear();
    operationRecipe_=Recipe{}; operationRevision_=0; operationSelectedOnly_=false; ++draftRevision_;
}
Document::StagedOperation Document::stageOperationSession(std::string_view group,bool selectedOnly) const {
    StagedOperation next;
    next.startsSession=activeOperation()!=group;
    next.base=next.startsSession ? scene() : operationBase_;
    next.selectedOnly=next.startsSession ? selectedOnly : operationSelectedOnly_;
    if(next.startsSession) {
        captureCheckpoint("session.mask");
        next.states=maskSnapshot();
        captureCheckpoint("session.group");
        next.group=group;
    }
    return next;
}
void Document::commitOperationSession(StagedOperation &next) noexcept {
    // Callers have rejected pending drafts and staged every allocating copy.
    if(colorBase_) clearColorSession();
    if(!next.startsSession) return;
    endOperationSession();
    operationBase_=operationResult_=next.base;
    operationStates_.swap(next.states); operationGroup_.swap(next.group);
    operationSelectedOnly_=next.selectedOnly; operationRevision_=revision();
}
ProcessingSnapshot Document::captureOperation(const Recipe &recipe,std::string_view group,bool selectedOnly) {
    if(group!="transform" && group!="opacity") throw std::runtime_error("Unknown numeric operation group");
    const auto steps=resolveRecipe(recipe);
    if(steps.empty()) throw std::runtime_error("Numeric operation needs a recipe");
    for(const auto &step:steps) {
        if(std::string_view(step.at("type").get_ref<const std::string &>())!=group)
            throw std::runtime_error("Numeric operation recipe does not match its group");
        const auto values=step.value("values",Recipe::object());
        if(group=="transform") (void)transformMatrix(values);
        else { processing_detail::keys(values,{"scale"}); (void)processing_detail::number(values,"scale",1,0,5); }
    }
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    if(hasPendingDrafts()) throw std::runtime_error("Apply or cancel pending drafts before numeric processing");
    auto next=stageOperationSession(group,selectedOnly);
    captureCheckpoint("session.recipe");
    auto nextRecipe=recipe;
    const auto &mask=next.startsSession ? next.states : operationStates_;
    auto job=snapshot(recipe,next.selectedOnly,next.base,mask);
    job.draft_=ProcessingSnapshot::Draft::Operation;
    captureCheckpoint("snapshot.group");
    job.operationGroup_=group;
    captureCheckpoint("capture.ready");
    commitOperationSession(next);
    operationRecipe_.swap(nextRecipe); ++draftRevision_;
    job.draftRevision_=draftRevision_;
    return job;
}
std::optional<ProcessingSnapshot> Document::captureOperationReset(std::string_view group) const {
    if(hasPendingDrafts()) throw std::runtime_error("Apply or cancel pending drafts before resetting an operation");
    if(activeOperation()!=group || !operationBase_) return {};
    if(scene()==operationBase_ && std::equal(states().begin(),states().end(),operationStates_.begin(),operationStates_.end())) return {};
    auto job=snapshot(Recipe{},operationSelectedOnly_,operationBase_,operationStates_);
    job.draft_=ProcessingSnapshot::Draft::OperationReset;
    captureCheckpoint("snapshot.group");
    job.operationGroup_=operationGroup_;
    captureCheckpoint("capture.ready");
    return job;
}
void Document::flushColor(std::stop_token stop) {
    while(auto job=captureColor()) {
        if(!apply(job->run(stop),*job)) throw std::runtime_error("Color draft was superseded");
    }
}
void Document::flushDrafts(std::stop_token stop) {
    flushColor(stop);
    if(auto job=captureTransform())
        if(!apply(job->run(stop),*job)) throw std::runtime_error("Transform draft was superseded");
}
ProcessingSnapshot Document::captureProcessing(const Recipe &recipe,bool selectedOnly) const {
    if(hasPendingDrafts()) throw std::runtime_error("Apply or cancel pending drafts before processing");
    auto job=snapshot(recipe,selectedOnly);
    captureCheckpoint("capture.ready");
    return job;
}
ProcessingSnapshot Document::captureAlignment(const Recipe &recipe,bool selectedOnly) {
    auto job=captureProcessing(recipe,selectedOnly);
    const auto steps=resolveRecipe(recipe);
    if(steps.size()!=1 || steps[0].at("type")!="transform")
        throw std::runtime_error("Alignment needs one coordinate transform.");
    const auto transform=transformMatrix(steps[0].value("values",Recipe::object()));
    camera.transformed(transform); // Validate before a worker can edit the scene.
    Camera defaultCamera;
    defaultCamera.fit(*scene());
    job.alignmentView_=AlignmentView{transform,defaultCamera.transformed(transform).savedView()};
    auto next=stageOperationSession("alignment",selectedOnly);
    captureCheckpoint("session.recipe");
    auto nextRecipe=recipe;
    captureCheckpoint("snapshot.group");
    job.operationGroup_="alignment";
    captureCheckpoint("alignment.ready");
    commitOperationSession(next);
    operationRecipe_.swap(nextRecipe); ++draftRevision_;
    // Unlike numeric controls, each alignment consumes current geometry. Keep
    // operationBase_/operationStates_ unchanged for an exact sequence Reset.
    job.selectedOnly_=operationSelectedOnly_; job.draftRevision_=draftRevision_;
    job.draft_=ProcessingSnapshot::Draft::Alignment;
    return job;
}
ProcessingSnapshot Document::captureFloorAlignment(FloorOptions options,bool selectedOnly) {
    auto job=captureProcessing(Recipe{},selectedOnly);
    if(!options.viewpoint) options.viewpoint=camera.eye();
    Camera defaultCamera; defaultCamera.fit(*scene());
    job.floorOptions_=options; job.floorDefaultCamera_=defaultCamera;
    auto next=stageOperationSession("alignment",selectedOnly);
    Recipe nextRecipe;
    captureCheckpoint("snapshot.group");
    job.operationGroup_="alignment";
    captureCheckpoint("alignment.ready");
    commitOperationSession(next);
    operationRecipe_.swap(nextRecipe); ++draftRevision_;
    job.selectedOnly_=operationSelectedOnly_; job.draftRevision_=draftRevision_;
    job.draft_=ProcessingSnapshot::Draft::Alignment;
    return job;
}
ProcessingResult Document::process(const Recipe &recipe,bool selectedOnly,std::stop_token stop) {
    return captureProcessing(recipe,selectedOnly).run(stop);
}
Camera Document::cameraForScene(const Scene &next) const {
    const auto current=scene();
    return current ? carryCamera(camera,*current,next) : camera;
}
bool Document::applyResult(ProcessingResult result,uint64_t generation,uint64_t revision) {
    if(generation!=generation_ || revision!=this->revision() || !edits_) return false;
    if(!result.scene) throw std::runtime_error("Cannot apply an empty processing result");
    requireSceneBudget(*result.scene,resources_,"Processing result storage does not belong to the document budget");
    if(resources_ && result.states.capacity() &&
       !sceneMemorySharesLedger(result.states.get_allocator().memory(),*resources_))
        throw std::runtime_error("Processing result mask does not belong to the document budget");
    const auto nextCamera=cameraForScene(*result.scene);
    captureCheckpoint("publication.inputs");
    auto inputs=inputPaths_;
    captureCheckpoint("publication.append_inputs");
    inputs.insert(inputs.end(),result.inputs.begin(),result.inputs.end());
    captureCheckpoint("publication.ready");
    const bool accepted=edits_->replaceScene(std::move(result.scene),std::span<const uint8_t>(result.states));
    if(accepted) {
        camera=nextCamera;
        inputPaths_.swap(inputs);
    }
    return accepted;
}
bool Document::apply(ProcessingResult result,uint64_t generation,uint64_t revision) {
    if(hasPendingDrafts()) return false;
    const bool accepted=applyResult(std::move(result),generation,revision);
    if(accepted) { endColorSession(); endOperationSession(); }
    return accepted;
}
bool Document::current(const ProcessingSnapshot &snapshot) const {
    if(!snapshot.scene_ || snapshot.documentIdentity_!=identity_ ||
       snapshot.generation_!=generation_ || snapshot.revision_!=revision() ||
       snapshot.draftRevision_!=draftRevision_ || !edits_) return false;
    switch(snapshot.draft_) {
    case ProcessingSnapshot::Draft::Color: return colorPending() && snapshot.scene_==colorBase_;
    case ProcessingSnapshot::Draft::AutoColor: return snapshot.scene_==colorBase_ && colorEditRevision_==revision();
    case ProcessingSnapshot::Draft::Transform: return transformPending() && !colorPending();
    case ProcessingSnapshot::Draft::Operation: case ProcessingSnapshot::Draft::OperationReset:
        return !hasPendingDrafts() && activeOperation()==snapshot.operationGroup_ && snapshot.scene_==operationBase_;
    case ProcessingSnapshot::Draft::Alignment:
        return !hasPendingDrafts() && activeOperation()=="alignment" && snapshot.scene_==operationResult_;
    case ProcessingSnapshot::Draft::None: return !hasPendingDrafts();
    }
    return false;
}
bool Document::apply(ProcessingResult result,const ProcessingSnapshot &snapshot) {
    if(!current(snapshot)) return false;
    ColorValues completedColor=color_;
    Recipe completedOperation;
    if(snapshot.draft_==ProcessingSnapshot::Draft::Operation || snapshot.draft_==ProcessingSnapshot::Draft::Alignment) {
        captureCheckpoint("publication.recipe");
        completedOperation=snapshot.recipe_;
    }
    if(snapshot.draft_==ProcessingSnapshot::Draft::AutoColor) {
        for(size_t k=0;k<completedColor.size();++k)
            completedColor[k]=result.report.at("suggested_color").at(colorFields[k].name).get<float>();
        (void)processing_detail::Grade(completedColor);
    }
    if(!applyResult(std::move(result),snapshot.generation(),snapshot.revision())) return false;
    switch(snapshot.draft_) {
    case ProcessingSnapshot::Draft::Color:
        appliedColor_=color_; colorEditRevision_=revision(); break;
    case ProcessingSnapshot::Draft::AutoColor:
        color_=appliedColor_=completedColor; colorEditRevision_=revision(); ++draftRevision_; break;
    case ProcessingSnapshot::Draft::Transform:
        cancelTransformDraft(); endColorSession(); endOperationSession(); break;
    case ProcessingSnapshot::Draft::None:
        endColorSession(); endOperationSession(); break;
    case ProcessingSnapshot::Draft::Operation: case ProcessingSnapshot::Draft::Alignment: case ProcessingSnapshot::Draft::OperationReset:
        operationResult_=scene(); operationRevision_=revision();
        operationRecipe_.swap(completedOperation);
        ++draftRevision_; break;
    }
    return true;
}
ExportSnapshot Document::captureExport(const std::filesystem::path &output,ExportScope scope) const {
    if(!edits_) throw std::runtime_error("Regular PLY geometry is read only");
    if(colorPending()) throw std::runtime_error("Flush pending colors before capturing an export");
    ExportSnapshot snapshot;
    snapshot.scene_=scene();
    captureCheckpoint("export.mask");
    snapshot.states_=scope==ExportScope::All ? maskSnapshot() : MaskStorage::copy(states(),
        resources_ ? sceneMemoryForBudget(*resources_,ResourceCategory::Work) : nullptr);
    captureCheckpoint("export.inputs");
    snapshot.inputs_=inputPaths_;
    captureCheckpoint("export.output");
    snapshot.output_=output; snapshot.format_=exportFormatForPath(output); snapshot.scope_=scope;
    snapshot.savePoint_=savePoint();
    snapshot.resources_=resources_;
    if(scope!=ExportScope::All) {
        if(!edits_->selectedCount()) throw std::runtime_error("Select splats first");
        for(auto &state:snapshot.states_.writableSpan()) if(((state&1)!=0)!=(scope==ExportScope::Selected)) state|=2;
    }
    captureCheckpoint("capture.ready");
    return snapshot;
}
ExportCompletion ExportSnapshot::run(std::stop_token stop) const {
    if(!scene_) throw std::runtime_error("Cannot export an empty scene snapshot");
    // Capture has no filesystem I/O; identity/member checks belong to the worker.
    rejectOutputAliases(output_,inputs_,stop,resources_);
    writeVisibleScene(*scene_,states_,output_,format_,stop);
    return {savePoint_,scope_,output_};
}
bool Document::finishExport(const ExportCompletion &completion) {
    return completion.scope==ExportScope::All && markSaved(completion.savePoint);
}
void Document::exportScene(const std::filesystem::path &output,ExportScope scope,std::stop_token stop) {
    flushColor(stop);
    finishExport(captureExport(output,scope).run(stop));
}
bool Document::undo() {
    if(!edits_) return false;
    flushColor();
    const auto nextCamera=cameraForScene(*edits_->historyScene(false));
    const bool changed=edits_->undo();
    if(changed) camera=nextCamera;
    endColorSession(); cancelTransformDraft(); endOperationSession();
    return changed;
}
bool Document::redo() {
    if(!edits_) return false;
    flushColor();
    const auto nextCamera=cameraForScene(*edits_->historyScene(true));
    const bool changed=edits_->redo();
    if(changed) camera=nextCamera;
    endColorSession(); cancelTransformDraft(); endOperationSession();
    return changed;
}
void Document::reset() {
    if(edits_) {
        captureCheckpoint("reset.mask");
        ProcessingResult result; result.scene=original_;
        result.states=SceneVector<uint8_t>(original_->gaussians.size(),uint8_t{},SceneAllocator<uint8_t>{
            resources_ ? sceneMemoryForBudget(*resources_,ResourceCategory::Work) : nullptr});
        if(applyResult(std::move(result),generation_,revision())) clearDrafts();
    }
}
struct DocumentLoader::State {
    struct Request {
        uint64_t generation{};
        std::filesystem::path path;
        LoadOptions options;
        std::stop_source stop;
    };
    explicit State(SourceLoadFunction function):load(std::move(function)) {}
    // Called with mutex held. Executor shutdown can cancel a queued task before
    // its callable starts; that terminal future must not leave admission stuck.
    void refresh() {
        if(scheduled && !active && completion.valid() &&
           completion.wait_for(std::chrono::seconds::zero())==std::future_status::ready) {
            scheduled=false; pending.reset();
        }
    }
    const SourceLoadFunction load;
    std::mutex mutex;
    std::optional<Request> pending;
    std::optional<LoadResult> result;
    std::stop_source activeStop,lifetimeStop;
    std::shared_future<void> completion;
    uint64_t generation{};
    bool scheduled{},active{},closed{};
};
DocumentLoader::DocumentLoader():DocumentLoader(backgroundExecutor()) {}
DocumentLoader::DocumentLoader(BackgroundExecutor &executor,LoadFunction load)
    :DocumentLoader(executor,load ? SourceLoadFunction{
        [load=std::move(load)](const std::filesystem::path &path,LoadOptions options) {
            if(std::filesystem::is_directory(path) || path.filename()=="meta.json")
                throw std::runtime_error("Unpacked SOG requires a loader with decode-snapshot member provenance");
            return LoadedScene{load(path,options),{path}};
        }} : SourceLoadFunction{loadSceneWithSources}) {}
DocumentLoader::DocumentLoader(BackgroundExecutor &executor,SourceLoadFunction load)
    :state_(std::make_shared<State>(load ? std::move(load) : SourceLoadFunction{loadSceneWithSources})),
     executor_(executor) {}
DocumentLoader::~DocumentLoader() {
    const auto state=std::move(state_);
    std::stop_source active,lifetime;
    {
        std::lock_guard lock(state->mutex);
        state->closed=true; ++state->generation;
        state->pending.reset(); state->result.reset();
        active=state->activeStop; lifetime=state->lifetimeStop;
    }
    // Stop callbacks may query loader/executor state; never invoke them under
    // the state lock. Promise-backed completion destruction never joins work.
    active.request_stop(); lifetime.request_stop();
}
uint64_t DocumentLoader::request(std::filesystem::path path,LoadOptions options) {
    State::Request next{0,std::move(path),options,{}};
    std::stop_source active;
    std::exception_ptr rejection;
    uint64_t generation;
    {
        std::lock_guard lock(state_->mutex);
        state_->refresh();
        next.generation=generation=++state_->generation;
        state_->pending=std::move(next); state_->result.reset();
        active=state_->activeStop;
        if(!state_->scheduled) {
            state_->scheduled=true;
            try {
                state_->completion=executor_.submit([state=state_](std::stop_token stop) {
                    work(state,stop);
                },state_->lifetimeStop.get_token()).share();
            } catch(...) {
                state_->scheduled=false; state_->pending.reset();
                rejection=std::current_exception();
            }
        }
    }
    active.request_stop();
    if(rejection) std::rethrow_exception(rejection);
    return generation;
}
void DocumentLoader::cancel() {
    std::stop_source active;
    {
        std::lock_guard lock(state_->mutex);
        state_->refresh(); ++state_->generation;
        active=state_->activeStop; state_->pending.reset(); state_->result.reset();
    }
    active.request_stop();
}
bool DocumentLoader::busy() const {
    std::lock_guard lock(state_->mutex);
    state_->refresh();
    return state_->active || state_->pending.has_value();
}
std::optional<LoadResult> DocumentLoader::take() {
    std::lock_guard lock(state_->mutex);
    state_->refresh();
    auto result=std::move(state_->result); state_->result.reset();
    return result;
}
void DocumentLoader::work(const std::shared_ptr<State> &state,std::stop_token stop) {
    std::stop_callback cancelled(stop,[state] {
        std::stop_source active;
        { std::lock_guard lock(state->mutex); active=state->activeStop; }
        active.request_stop();
    });
    try {
        for(;;) {
            std::optional<State::Request> request;
            {
                std::lock_guard lock(state->mutex);
                if(state->closed || stop.stop_requested() || !state->pending) {
                    state->pending.reset(); state->scheduled=false; state->active=false;
                    return;
                }
                request=std::move(state->pending); state->pending.reset();
                state->activeStop=request->stop; state->active=true;
            }
            LoadResult result{request->generation,std::move(request->path),{}, {}, {}};
            try {
                request->options.stop=request->stop.get_token();
                auto loaded=state->load(result.path,request->options);
                requireSceneBudget(loaded.scene,request->options.resources,
                    "Injected loader did not admit scene storage with the requested budget");
                if(loaded.sourceMembers.empty()) throw std::runtime_error("Loader returned no source-member provenance");
                result.sourceMembers=std::move(loaded.sourceMembers);
                result.scene=std::make_shared<Scene>(std::move(loaded.scene));
            } catch(const std::exception &error) { result.error=error.what(); }
              catch(...) { result.error="Unknown scene loading error"; }
            {
                std::lock_guard lock(state->mutex);
                state->active=false;
                if(!state->closed && !stop.stop_requested() && !request->stop.stop_requested() &&
                   request->generation==state->generation)
                    state->result=std::move(result);
            }
        }
    } catch(...) {
        std::lock_guard lock(state->mutex);
        state->active=false; state->scheduled=false; state->pending.reset();
        throw;
    }
}
std::vector<std::filesystem::path> adjacentScenes(const std::filesystem::path &current) {
    std::vector<std::filesystem::path> files;
    std::error_code ec; auto folder=std::filesystem::absolute(current).parent_path();
    for(const auto &entry:std::filesystem::directory_iterator(folder,ec)) {
        const auto ext=lowercase(pathUtf8(entry.path().extension()));
        if((entry.is_regular_file(ec) && (ext==".ply" || ext==".spz" || ext==".splat" || ext==".ksplat" || ext==".sog" || ext==".sogs")) ||
           (entry.is_directory(ec) && std::filesystem::is_regular_file(entry.path()/"meta.json",ec))) files.push_back(entry.path());
    }
    std::sort(files.begin(),files.end(),[](const auto &a,const auto &b) {
        auto aa=lowercase(pathUtf8(a.filename())), bb=lowercase(pathUtf8(b.filename()));
        return aa==bb ? pathUtf8(a)<pathUtf8(b) : naturalLess(aa,bb);
    });
    return files;
}
} // namespace preview
