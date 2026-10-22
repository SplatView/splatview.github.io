#include "document_capture_contracts.hpp"
#include "document.hpp"
#include <algorithm>
#include <cmath>
#include <initializer_list>
#include <new>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace preview {
// Only this test owns the private, per-Document hook. The production copies
// still use their ordinary allocators; no global allocation behavior changes.
struct DocumentCaptureTestAccess {
    static void checkpoint(Document &document,void (*function)(void *,std::string_view),void *context) {
        document.captureCheckpoint_=function;
        document.captureCheckpointContext_=context;
    }
};
struct SceneEditsCaptureTestAccess {
    static void checkpoint(SceneEdits &edits,void (*function)(void *,std::string_view),void *context) {
        edits.historyCheckpoint_=function;
        edits.historyCheckpointContext_=context;
    }
    static std::vector<uint64_t> history(const SceneEdits &edits) {
        std::vector<uint64_t> result{edits.nextContentRevision_};
        const auto append=[&](const auto &stack) {
            result.push_back(stack.size());
            for(const auto &entry:stack) {
                result.insert(result.end(),{uint64_t(reinterpret_cast<uintptr_t>(entry.before.get())),
                    uint64_t(reinterpret_cast<uintptr_t>(entry.after.get())),entry.beforeContent,entry.afterContent,
                    entry.changes.size(),entry.beforeStates.size(),entry.afterStates.size()});
                for(const auto &change:entry.changes)
                    result.insert(result.end(),{change.index,change.before,change.after});
                result.insert(result.end(),entry.beforeStates.begin(),entry.beforeStates.end());
                result.insert(result.end(),entry.afterStates.begin(),entry.afterStates.end());
            }
        };
        append(edits.undo_); append(edits.redo_); return result;
    }
    static std::size_t undoCount(const SceneEdits &edits) { return edits.undo_.size(); }
};
} // namespace preview

using namespace preview;
namespace {
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
std::shared_ptr<Scene> fixture() {
    auto scene=std::make_shared<Scene>(); scene->shDegree=1;
    for(unsigned i=0;i<8;++i) {
        Attributes value;
        value.position={float(i%4)*.15f-.2f,0,float(i/4)*.2f};
        value.scale={.04f,.03f,.02f}; value.opacity=.8f;
        value.sh[0]=.15f+float(i)*.03f; value.sh[1]=-.1f; value.sh[2]=.2f; value.sh[6]=.05f;
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount=8; fitBounds(*scene);
    Camera saved; saved.fit(*scene); saved.orbit(9,-4); saved.roll=.17f;
    scene->defaultView=saved.savedView();
    return scene;
}
void open(Document &document,const std::shared_ptr<Scene> &source) {
    document.replace("capture-contracts/original-source.ply",source,{},
        {"capture-contracts/retained-original-texture-member-with-a-long-name.webp"});
    document.edits()->selectSingle(0,SelectOperation::Set);
    document.camera.orbit(-3,7); document.camera.roll=-.23f;
}
Recipe opacity(float scale) { return {{"type","opacity"},{"values",{{"scale",scale}}}}; }
Recipe move(float amount) { return {{"type","transform"},{"values",{{"translation",{amount,0,0}}}}}; }
ColorValues colors(float amount) {
    auto values=neutralColor; values[0]=amount; values[2]=1.2f; values[3]=.85f; return values;
}
void bakeOpacity(Document &document,float scale=.4f) {
    const auto job=document.captureOperation(opacity(scale),"opacity",true);
    require(document.apply(job.run(),job),"Capture fixture numeric processing commits");
}
void bakeColor(Document &document) {
    document.previewColor(colors(.85f),true);
    const auto job=*document.captureColor();
    require(document.apply(job.run(),job),"Capture fixture color processing commits");
}
bool sameCamera(const Camera &left,const Camera &right) {
    return pointDistance(left.eye(),right.eye())<5e-5f && pointDistance(left.target,right.target)<5e-5f &&
        std::abs(left.distance-right.distance)<5e-5f && std::abs(left.radius-right.radius)<5e-5f &&
        std::abs(left.roll-right.roll)<5e-5f && std::abs(left.fieldOfView-right.fieldOfView)<1e-5f && left.yUp==right.yUp;
}
struct Observed {
    std::shared_ptr<const Scene> scene,renderScene;
    std::vector<uint8_t> states;
    std::vector<std::filesystem::path> inputs;
    std::vector<uint8_t> selectionBaseline;
    std::vector<uint64_t> history;
    Document::SavePoint saved;
    uint64_t revision,draft;
    SavedView camera;
    float cameraRadius;
    ColorValues color;
    Matrix4 geometry;
    std::string operation;
    Recipe recipe;
    bool dirty,colorPending,transformPending,undo,redo,selectionDraft;
    explicit Observed(const Document &document)
        :scene(document.scene()),renderScene(document.renderScene()),
         states(document.states().begin(),document.states().end()),
         inputs(document.inputPaths().begin(),document.inputPaths().end()),
         selectionBaseline(document.edits()->selectionBaseline().begin(),document.edits()->selectionBaseline().end()),
         history(SceneEditsCaptureTestAccess::history(*document.edits())),saved(document.savePoint()),
         revision(document.revision()),draft(document.draftRevision()),camera(document.camera.savedView()),
         cameraRadius(document.camera.radius),color(document.colorValues()),geometry(document.transformValues()),
         operation(document.activeOperation()),recipe(document.operationRecipe()),dirty(document.dirty()),
         colorPending(document.colorPending()),transformPending(document.transformPending()),
         undo(document.edits()->canUndo()),redo(document.edits()->canRedo()),selectionDraft(document.edits()->selectionDraft()) {}
    void unchanged(const Document &document) const {
        require(document.scene()==scene && document.renderScene()==renderScene &&
                    std::ranges::equal(document.states(),states) && std::ranges::equal(document.inputPaths(),inputs) &&
                    document.savePoint()==saved && document.revision()==revision && document.draftRevision()==draft &&
                    document.camera.savedView()==camera && document.camera.radius==cameraRadius &&
                    document.colorValues()==color && document.transformValues()==geometry &&
                    document.activeOperation()==operation && document.operationRecipe()==recipe &&
                    document.dirty()==dirty && document.colorPending()==colorPending &&
                    document.transformPending()==transformPending && document.edits()->canUndo()==undo &&
                    document.edits()->canRedo()==redo && document.edits()->selectionDraft()==selectionDraft &&
                    std::ranges::equal(document.edits()->selectionBaseline(),selectionBaseline) &&
                    SceneEditsCaptureTestAccess::history(*document.edits())==history,
                "Allocating capture/publication failure preserves all observable owner state");
    }
};
struct Fault {
    std::string_view seam;
    unsigned hits{};
    static void inject(void *context,std::string_view seam) {
        auto &fault=*static_cast<Fault *>(context);
        if(seam==fault.seam) { ++fault.hits; throw std::bad_alloc(); }
    }
};
struct Armed {
    Document &document;
    Armed(Document &owner,Fault &fault):document(owner) {
        DocumentCaptureTestAccess::checkpoint(document,&Fault::inject,&fault);
    }
    ~Armed() { DocumentCaptureTestAccess::checkpoint(document,nullptr,nullptr); }
};
struct ArmedHistory {
    SceneEdits &edits;
    ArmedHistory(SceneEdits &owner,Fault &fault):edits(owner) {
        SceneEditsCaptureTestAccess::checkpoint(edits,&Fault::inject,&fault);
    }
    ~ArmedHistory() { SceneEditsCaptureTestAccess::checkpoint(edits,nullptr,nullptr); }
};
template<class F>
void failedCopies(Document &document,const ProcessingSnapshot &issued,
                  std::initializer_list<std::string_view> seams,F action) {
    const Observed before(document);
    require(document.current(issued),"Fault fixture must have a valid already-issued submission");
    for(const auto seam:seams) {
        Fault fault{seam}; bool rejected=false;
        try { Armed armed(document,fault); action(); }
        catch(const std::bad_alloc &) { rejected=true; }
        require(rejected && fault.hits==1,"Each requested ordinary copy seam must be reached and fail once");
        before.unchanged(document);
        require(document.current(issued),"Failed capture cannot supersede a previously issued submission");
    }
}
template<class F>
void failedHistory(Document &document,const ProcessingSnapshot &issued,
                   std::initializer_list<std::string_view> seams,F action) {
    const Observed before(document);
    require(document.current(issued),"History fault fixture needs a current issued submission");
    for(const auto seam:seams) {
        Fault fault{seam}; bool rejected=false;
        try { ArmedHistory armed(*document.edits(),fault); action(); }
        catch(const std::bad_alloc &) { rejected=true; }
        if(!rejected || fault.hits!=1)
            throw std::runtime_error("History allocation seam was not reached: "+std::string(seam));
        before.unchanged(document);
        require(document.current(issued),"Failed history transaction preserves the issued processing snapshot");
    }
}
template<class F> void cancelled(F action) {
    try { action(); } catch(const std::exception &) { return; }
    throw std::runtime_error("Pre-cancelled captured work must fail without owner mutation");
}
void autoCapture(const std::shared_ptr<Scene> &source) {
    Document numeric; open(numeric,source); bakeOpacity(numeric); numeric.markSaved(numeric.savePoint());
    const auto faded=numeric.scene(); const auto oldReset=*numeric.captureOperationReset("opacity");
    failedCopies(numeric,oldReset,{"auto.recipe","snapshot.mask","snapshot.recipe","capture.ready"},
        [&] { (void)numeric.captureAutoColor("exposure"); });
    require(oldReset.run().scene==source,"Failed Auto preserves the preceding numeric Reset baseline");
    const auto automatic=numeric.captureAutoColor("exposure");
    require(numeric.current(automatic) && !numeric.current(oldReset) && numeric.activeOperation().empty() &&
                numeric.renderScene()==faded,
            "Only successful Auto capture ends the old operation and selects its new ungraded base");
    require(numeric.apply(automatic.run(),automatic) && numeric.undo() && numeric.scene()==faded,
            "Retrying Auto after capture failures produces one ordinary undoable grade");

    Document manual; open(manual,source); manual.previewColor(colors(.8f),true);
    const auto oldColor=*manual.captureColor();
    failedCopies(manual,oldColor,{"auto.recipe","snapshot.mask","snapshot.recipe","capture.ready"},
        [&] { (void)manual.captureAutoColor("contrast",true); });
    require(manual.apply(oldColor.run(),oldColor),"An older color submission remains usable after failed Auto capture");
    const auto committed=manual.scene(); const auto boundary=manual.captureProcessing(opacity(.9f));
    failedCopies(manual,boundary,{"auto.recipe","snapshot.mask","snapshot.recipe","capture.ready"},
        [&] { (void)manual.captureAutoColor("white_balance",false); });
    require(manual.renderScene()==source && manual.colorValues()==colors(.8f),
            "Failed scope-changing Auto retains the settled absolute color session");
    const auto retry=manual.captureAutoColor("white_balance",false);
    require(manual.renderScene()==committed && manual.colorValues()==neutralColor,
            "Successful scope-changing Auto begins a neutral session on committed content");
    std::stop_source stop; stop.request_stop(); const Observed beforeCancel(manual);
    cancelled([&] { retry.run(stop.get_token()); }); beforeCancel.unchanged(manual);
    require(manual.current(retry) && manual.apply(retry.run(),retry),"Captured Auto remains retryable after cancellation");
}
void numericCapture(const std::shared_ptr<Scene> &source) {
    Document document; open(document,source); bakeColor(document);
    const auto graded=document.scene(); const auto old=document.captureProcessing(opacity(.9f));
    failedCopies(document,old,{"session.mask","session.group","session.recipe","snapshot.mask",
        "snapshot.recipe","snapshot.group","capture.ready"},
        [&] { (void)document.captureOperation(move(.2f),"transform",true); });
    require(document.renderScene()==source,"Failed numeric capture cannot end a settled color session");
    const auto moved=document.captureOperation(move(.2f),"transform",true);
    require(!document.current(old) && document.colorValues()==neutralColor && document.apply(moved.run(),moved),
            "Successful numeric retry atomically starts its session and consumes committed colors");
    const auto restore=*document.captureOperationReset("transform");
    failedCopies(document,restore,{"snapshot.mask","snapshot.recipe","snapshot.group","capture.ready"},
        [&] { (void)document.captureOperationReset("transform"); });
    require(restore.run().scene==graded && document.apply(restore.run(),restore),
            "Failed Reset captures preserve the exact pre-transform graded baseline");
    require(document.undo() && document.undo() && document.scene()==graded,
            "Numeric retry and Reset create exactly their expected undoable revisions");

    Document absolute; open(absolute,source); bakeOpacity(absolute);
    const auto older=absolute.captureOperation(opacity(.6f),"opacity",true);
    failedCopies(absolute,older,{"session.recipe","snapshot.mask","snapshot.recipe","snapshot.group","capture.ready"},
        [&] { (void)absolute.captureOperation(opacity(.7f),"opacity",false); });
    require(absolute.operationRecipe()==opacity(.6f),"Failed repeated numeric capture preserves the retry recipe");
    const auto newer=absolute.captureOperation(opacity(.7f),"opacity",false);
    require(!absolute.current(older) && absolute.apply(newer.run(),newer) &&
                std::abs(absolute.scene()->gaussians[0].positionOpacity[3]-.8f*.7f)<1e-6f &&
                absolute.scene()->gaussians[1].positionOpacity[3]==source->gaussians[1].positionOpacity[3],
            "Numeric retry keeps the first selected scope and does not compound a prior bake");
    const auto reset=*absolute.captureOperationReset("opacity");
    require(reset.run().scene==source,"Repeated capture failures cannot replace the original numeric Reset baseline");
}
void alignmentCapture(const std::shared_ptr<Scene> &source) {
    Document document; open(document,source); bakeOpacity(document);
    const auto baseline=document.scene(); const auto old=*document.captureOperationReset("opacity");
    const auto shift=move(.25f);
    failedCopies(document,old,{"snapshot.mask","snapshot.recipe","session.mask","session.group",
        "session.recipe","snapshot.group","alignment.ready"},
        [&] { (void)document.captureAlignment(shift,true); });
    const auto first=document.captureAlignment(shift,true);
    require(document.apply(first.run(),first),"Alignment retry commits after all staged-copy failures");
    document.camera.orbit(6,-2); document.camera.roll=.3f;
    const auto pending=document.captureAlignment(move(.1f),true);
    const Recipe enlarge={{"type","transform"},{"values",{{"scale",1.3f}}}};
    failedCopies(document,pending,{"snapshot.mask","snapshot.recipe","session.recipe","snapshot.group","alignment.ready"},
        [&] { (void)document.captureAlignment(enlarge,false); });
    require(document.apply(pending.run(),pending),"Failed newer alignment leaves the older coordinate submission usable");
    const auto reset=*document.captureOperationReset("alignment");
    failedCopies(document,reset,{"snapshot.mask","snapshot.recipe","snapshot.group","capture.ready"},
        [&] { (void)document.captureOperationReset("alignment"); });
    require(reset.run().scene==baseline,"Cumulative alignment Reset retains its first scene through failed captures");
    const auto beforeReset=document.scene(); const auto resetView=document.camera;
    failedCopies(document,reset,{"publication.inputs","publication.append_inputs","publication.ready"},
        [&] { (void)document.apply(reset.run(),reset); });
    require(document.apply(reset.run(),reset) && document.scene()==baseline && document.undo() &&
                document.scene()==beforeReset && sameCamera(document.camera,resetView),
            "Reset retry is undoable and restores the latest aligned camera through its coordinate frames");

    Document floor; open(floor,source); bakeOpacity(floor);
    const auto beforeFloor=*floor.captureOperationReset("opacity");
    failedCopies(floor,beforeFloor,{"snapshot.mask","snapshot.recipe","session.mask","session.group",
        "snapshot.group","alignment.ready"},[&] { (void)floor.captureFloorAlignment({},true); });
    const auto job=floor.captureFloorAlignment({},true);
    const Observed captured(floor); std::stop_source stop; stop.request_stop();
    cancelled([&] { job.run(stop.get_token()); }); captured.unchanged(floor);
    require(floor.current(job),"Floor cancellation preserves its completely captured retry and baseline");
}
void constAndPublication(const std::shared_ptr<Scene> &source) {
    Document document; open(document,source); bakeOpacity(document);
    const auto job=document.captureOperation(opacity(.65f),"opacity",true);
    auto result=job.run();
    const std::filesystem::path additional="capture-contracts/merged-source-member-with-a-long-file-name.webp";
    result.inputs.push_back(additional);
    failedCopies(document,job,{"publication.recipe","publication.inputs","publication.append_inputs","publication.ready"},
        [&] { (void)document.apply(result,job); });
    const auto inputCount=document.inputPaths().size();
    require(document.apply(result,job) && document.inputPaths().size()==inputCount+1 && document.inputPaths().back()==additional,
            "Successful publication installs scene/session and staged member paths together");
    const Recipe allPass={{"type","filter"},{"action","keep"},{"values",{{"min_opacity",0},{"max_opacity",1}}}};
    const auto unchanged=document.captureProcessing(allPass);
    const auto revision=document.revision(); const auto scene=document.scene();
    failedCopies(document,unchanged,{"publication.inputs","publication.append_inputs","publication.ready"},
        [&] { (void)document.apply(unchanged.run(),unchanged); });
    require(document.apply(unchanged.run(),unchanged) && document.scene()==scene && document.revision()==revision &&
                document.activeOperation().empty(),
            "A valid same-identity no-op still accepts and ends the settled session without empty history");

    Document color; open(color,source); color.previewColor(colors(.7f),true);
    const auto issued=*color.captureColor();
    failedCopies(color,issued,{"color.recipe","snapshot.mask","snapshot.recipe","capture.ready"},
        [&] { (void)color.captureColor(); });
    failedCopies(color,issued,{"reset.mask","publication.inputs","publication.append_inputs","publication.ready"},
        [&] { color.reset(); });
    require(color.apply(issued.run(),issued),"Failed Reset cannot clear the already-issued pending color bake");

    Document geometry; open(geometry,source);
    Matrix4 delta=identityMatrix; delta[12]=.3f; geometry.previewTransform(delta,true);
    const auto transform=*geometry.captureTransform();
    failedCopies(geometry,transform,{"transform.recipe","snapshot.mask","snapshot.recipe","capture.ready"},
        [&] { (void)geometry.captureTransform(); });
    failedCopies(geometry,transform,{"export.mask","export.inputs","export.output","capture.ready"},
        [&] { (void)geometry.captureExport("capture-contracts/new-output-with-a-long-file-name.ply"); });
    require(!geometry.dirty() && geometry.captureExport("capture-contracts/new-output.ply").savePoint()==geometry.savePoint(),
            "Export capture keeps transient geometry separate from dirty and committed content");
    const auto replacement=fixture();
    failedCopies(geometry,transform,{"replace.path","replace.inputs","replace.edits","replace.ready"},
        [&] { geometry.replace("capture-contracts/replacement-with-a-long-file-name.ply",replacement); });
    require(geometry.apply(transform.run(),transform),"Failed replacement preserves a valid geometry submission");
}
void draftWithRedo(Document &document,const std::shared_ptr<Scene> &source) {
    open(document,source); bakeOpacity(document);
    require(document.undo() && document.edits()->canRedo(),"Draft fixture retains a real redo scene");
    document.edits()->beginSelectionDraft();
    require(document.edits()->selectSingle(1,SelectOperation::Set) && document.edits()->selectionDraft(),
            "Draft fixture previews a different selection without confirming history");
}
void historyPublication(const std::shared_ptr<Scene> &source) {
    Document document; draftWithRedo(document,source);
    const auto job=document.captureProcessing(opacity(.6f),true);
    const auto result=job.run(); const auto before=document.revision();
    failedHistory(document,job,{"draft.changes","replace.before_mask","replace.after_mask","draft.append","history.append"},
        [&] { (void)document.apply(result,job); });
    require(document.apply(result,job) && !document.edits()->selectionDraft() && !document.edits()->canRedo() &&
                document.revision()==before+2 && document.states()[1]==1 && document.states()[0]==0,
            "Replacement commits the selection confirmation and scene revision together only after both appends");
    const auto replaced=document.scene();
    require(document.undo() && document.scene()==source && document.states()[1]==1 &&
                document.undo() && document.scene()==source && document.states()[0]==1 && document.states()[1]==0 &&
                document.redo() && document.states()[1]==1 && document.redo() && document.scene()==replaced,
            "Atomic replacement retains the original two-entry draft/replacement undo and redo behavior");

    Document full; open(full,source);
    for(unsigned index=0;index<9;++index) bakeOpacity(full,.2f+float(index)*.05f);
    require(SceneEditsCaptureTestAccess::undoCount(*full.edits())==10,"History rollback fixture starts at the ten-entry cap");
    full.edits()->beginSelectionDraft(); full.edits()->selectSingle(1,SelectOperation::Set);
    const auto atCap=full.captureProcessing(opacity(.75f),true); const auto capResult=atCap.run();
    failedHistory(full,atCap,{"history.append"},[&] { (void)full.apply(capResult,atCap); });
    require(full.apply(capResult,atCap) && SceneEditsCaptureTestAccess::undoCount(*full.edits())==10,
            "Rollback preserves the oldest capped entry; successful double append trims only after commit");
}
void draftTransactions(const std::shared_ptr<Scene> &source) {
    Document confirm; draftWithRedo(confirm,source);
    const auto issued=confirm.captureProcessing(opacity(.9f));
    failedHistory(confirm,issued,{"draft.changes","draft.append"},[&] { confirm.edits()->confirmSelectionDraft(); });
    const std::vector<uint8_t> baseline(confirm.edits()->selectionBaseline().begin(),confirm.edits()->selectionBaseline().end());
    const auto history=SceneEditsCaptureTestAccess::history(*confirm.edits());
    require(confirm.edits()->cancelSelectionDraft() && std::ranges::equal(confirm.states(),baseline) &&
                SceneEditsCaptureTestAccess::history(*confirm.edits())==history && confirm.edits()->canRedo() &&
                !confirm.current(issued),
            "Cancellation after failed confirmation restores its retained baseline and leaves both history stacks intact");
    confirm.edits()->beginSelectionDraft(); confirm.edits()->selectSingle(1,SelectOperation::Set);
    require(confirm.edits()->confirmSelectionDraft() && !confirm.edits()->selectionDraft() &&
                !confirm.edits()->canRedo() && confirm.undo() && confirm.states()[0]==1 && confirm.redo() && confirm.states()[1]==1,
            "Retried draft confirmation creates exactly one selection history entry");

    Document deletion; draftWithRedo(deletion,source);
    const auto beforeDelete=deletion.captureProcessing(opacity(.8f));
    failedHistory(deletion,beforeDelete,{"draft.changes","draft.append","history.append"},
        [&] { deletion.edits()->deleteSelected(); });
    require(deletion.edits()->deleteSelected() && deletion.states()[1]==2 && !deletion.edits()->selectionDraft() &&
                deletion.undo() && deletion.states()[1]==1 && deletion.undo() && deletion.states()[0]==1,
            "Cleanup commit stages draft confirmation and deletion before mutating either revision");

    Document cleanup; open(cleanup,source); cleanup.edits()->deleteSelected();
    cleanup.edits()->selectSingle(1,SelectOperation::Set); cleanup.edits()->selectSingle(2,SelectOperation::Set);
    require(cleanup.undo(),"Cleanup fixture has a redo selection");
    cleanup.edits()->beginSelectionDraft(); cleanup.edits()->selectSingle(3,SelectOperation::Set);
    const auto cleanupIssued=cleanup.captureProcessing(opacity(.9f));
    const std::vector<uint8_t> cleanupBase(cleanup.edits()->selectionBaseline().begin(),cleanup.edits()->selectionBaseline().end());
    failedHistory(cleanup,cleanupIssued,{"cleanup.changes","history.append"},[&] { cleanup.edits()->resetCleanup(); });
    require(cleanup.edits()->resetCleanup() && !cleanup.edits()->selectionDraft() &&
                std::ranges::all_of(cleanup.states(),[](uint8_t state) { return state==0; }) &&
                cleanup.undo() && std::ranges::equal(cleanup.states(),cleanupBase),
            "Reset Cleanup cancels the preview and records its baseline cleanup only after allocation succeeds");

    Document beginning; open(beginning,source);
    const auto beforeBegin=beginning.captureProcessing(opacity(.9f));
    failedHistory(beginning,beforeBegin,{"draft.baseline"},[&] { beginning.edits()->beginSelectionDraft(); });
    beginning.edits()->beginSelectionDraft();
    require(!beginning.edits()->cancelSelectionDraft() && !beginning.edits()->selectionDraft() && beginning.current(beforeBegin),
            "Unchanged draft cancellation performs no allocating history mutation or revision increment");
}
void historyNavigation(const std::shared_ptr<Scene> &source) {
    Document numeric; open(numeric,source); bakeOpacity(numeric);
    const auto beforeUndo=*numeric.captureOperationReset("opacity");
    failedHistory(numeric,beforeUndo,{"undo.mask","undo.append"},[&] { numeric.undo(); });
    require(beforeUndo.run().scene==source && numeric.activeOperation()=="opacity" && numeric.undo() && numeric.scene()==source,
            "Failed Undo retains the numeric Reset session until history navigation actually succeeds");
    const auto redoRecipe=numeric.captureOperation(move(.2f),"transform",true);
    failedHistory(numeric,redoRecipe,{"redo.mask","redo.append"},[&] { numeric.redo(); });
    require(numeric.redo() && numeric.activeOperation().empty() && !numeric.current(redoRecipe),
            "Failed Redo preserves its issued numeric job; successful Redo ends it at the command boundary");

    Document color; open(color,source); bakeColor(color);
    const auto oldAuto=color.captureAutoColor("contrast",true);
    failedHistory(color,oldAuto,{"undo.mask","undo.append"},[&] { color.undo(); });
    require(color.current(oldAuto) && color.undo() && color.renderScene()==source && color.colorValues()==neutralColor,
            "Undo allocation failure preserves settled color render inputs and current Auto submission");
    Matrix4 delta=identityMatrix; delta[12]=.2f; color.previewTransform(delta,true);
    const auto geometry=*color.captureTransform();
    failedHistory(color,geometry,{"redo.mask","redo.append"},[&] { color.redo(); });
    require(color.redo() && !color.transformPending() && !color.current(geometry),
            "Transient geometry is cancelled only after a successful Redo, never by its failed allocation");
}
} // namespace
void documentCaptureContracts() {
    const auto source=fixture();
    autoCapture(source);
    numericCapture(source);
    alignmentCapture(source);
    constAndPublication(source);
    historyPublication(source);
    draftTransactions(source);
    historyNavigation(source);
}
