#include "document_draft_contracts.hpp"
#include "document.hpp"
#include "processing_kernels.hpp"
#include "file_io.hpp"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <thread>

using namespace preview;
namespace {
void require(bool value,const char *message) { if(!value) throw std::runtime_error(message); }
template<class F> void rejects(F action,const char *message) {
    try { action(); } catch(const std::exception &) { return; }
    throw std::runtime_error(message);
}
ColorValues color(float brightness) { auto values=neutralColor; values[0]=brightness; return values; }
Recipe grade(const ColorValues &values) {
    Recipe fields=Recipe::object();
    for(size_t i=0;i<values.size();++i) fields[colorFields[i].name]=values[i];
    return {{"type","color"},{"values",fields}};
}
std::shared_ptr<Scene> fixture() {
    auto scene=std::make_shared<Scene>(); scene->shDegree=3;
    for(unsigned i=0;i<4;++i) {
        Attributes value; value.position={float(i)*.2f-.3f,float(i%2)*.1f,0};
        value.scale={.04f,.03f,.02f}; value.opacity=.8f;
        value.sh[0]=.3f+float(i)*.1f; value.sh[1]=-.2f; value.sh[2]=.15f;
        value.sh[6]=.12f; value.sh[17]=-.08f;
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount=4; fitBounds(*scene); return scene;
}
bool sameSplats(const Scene &a,const Scene &b) {
    return a.gaussians.size()==b.gaussians.size() &&
        std::memcmp(a.gaussians.data(),b.gaussians.data(),a.gaussians.size()*sizeof(Gaussian))==0;
}
void sameCamera(const Camera &actual,const Camera &expected,const char *message) {
    require(pointDistance(actual.eye(),expected.eye())<5e-5f && pointDistance(actual.target,expected.target)<5e-5f &&
                std::abs(actual.distance-expected.distance)<5e-5f && std::abs(actual.radius-expected.radius)<5e-5f &&
                std::abs(actual.roll-expected.roll)<5e-5f && std::abs(actual.fieldOfView-expected.fieldOfView)<1e-5f &&
                actual.yUp==expected.yUp,message);
}
bool sameExportValues(const Scene &a,const Scene &b) {
    if(a.gaussians.size()!=b.gaussians.size()) return false;
    for(size_t i=0;i<a.gaussians.size();++i) {
        for(unsigned axis=0;axis<3;++axis)
            if(std::abs(a.gaussians[i].positionOpacity[axis]-b.gaussians[i].positionOpacity[axis])>1e-6f) return false;
        for(unsigned channel=0;channel<3;++channel)
            if(std::abs(shValue(a.gaussians[i],0,channel)-shValue(b.gaussians[i],0,channel))>2e-4f) return false;
    }
    return true;
}
std::shared_ptr<const Scene> rendered(const Document &document) {
    const auto settings=document.previewSettings();
    return previewScene(document.renderScene(),document.renderStates(),settings.color,settings.colorSelectedOnly,
                        settings.geometry,settings.geometrySelectedOnly);
}
void commitColor(Document &document) {
    const auto job=document.captureColor(); require(bool(job),"Pending color has a submission");
    require(document.apply(job->run(),*job),"Matching color submission commits");
}
} // namespace

void documentDraftContracts(const std::filesystem::path &directory) {
    const auto folder=directory/"document-drafts"; std::filesystem::create_directories(folder);
    const auto input=folder/"input.ply"; const auto source=fixture();
    writeVisibleScene(*source,{},input,SceneExportFormat::Ply);
    const FileSnapshot sourceBytes(input,65536);
    Document document; document.replace(input,source);
    document.edits()->selectSingle(0,SelectOperation::Set);
    const auto revision=document.revision(); const auto point=document.savePoint();
    for(float brightness:{1.2f,1.4f,1.1f}) document.previewColor(color(brightness),true);
    require(document.scene()==source && document.revision()==revision && document.savePoint()==point &&
                document.dirty() && document.colorPending(),
            "Color gestures change preview/dirty state without scene copies or history entries");
    ViewSettings display; display.highlightSelection=false; display.colorPreviewCoverage=true;
    display.selection.shape=2;
    const auto preview=document.previewSettings(display);
    require(document.renderScene()==source && preview.color==color(1.1f) && preview.colorSelectedOnly &&
                !preview.highlightSelection && preview.colorPreviewCoverage && preview.selection.shape==2,
            "Controller render inputs expose the fixed base without overwriting unrelated view settings");
    require(sameSplats(*rendered(document),*processScene(source,document.states(),grade(color(1.1f)),true).scene),
            "Selected live color preview uses the same absolute grade as the original baseline");
    const auto older=*document.captureColor();
    const auto olderResult=older.run();
    document.previewColor(color(1.25f),true);
    require(!document.current(older) && !document.apply(olderResult,older) && document.scene()==source &&
                document.colorValues()==color(1.25f) && document.colorPending(),
            "An older draft completion cannot install content or clear a newer gesture");
    const auto current=*document.captureColor();
    ProcessingResult baked; std::exception_ptr failure;
    std::jthread worker([&] { try { baked=current.run(); } catch(...) { failure=std::current_exception(); } });
    worker.join(); if(failure) std::rethrow_exception(failure);
    require(document.scene()==source && document.colorPending(),"A color worker cannot mutate its owner");
    require(document.apply(baked,current) && !document.colorPending() && !document.captureColor() &&
                document.renderScene()==source && document.colorValues()==color(1.25f),
            "Color commit retains desired/applied values and the original render base");
    require(!document.current(current) && !document.apply(baked,current),"A color completion cannot commit twice");
    require(sameSplats(*rendered(document),*document.scene()),
            "A committed color preview grades the fixed base once rather than grading baked content twice");
    const auto first=document.scene();
    document.previewColor(color(1.35f),true); commitColor(document);
    require(sameSplats(*document.scene(),*processScene(source,document.states(),grade(color(1.35f)),true).scene),
            "Successive completed gestures remain absolute rather than accumulating nonlinear grades");
    const auto second=document.scene();
    require(document.undo() && document.scene()==first && document.colorValues()==neutralColor &&
                document.renderScene()==first,
            "Each completed color gesture is one undo entry and history rebases color controls");
    require(document.undo() && document.scene()==source,"Two gestures undo to their fixed session base");
    require(document.redo() && document.scene()==first && document.redo() && document.scene()==second,
            "Color history restores both committed gestures");

    document.replace(input,source); document.previewColor(color(1.3f)); commitColor(document);
    const auto beforeReset=document.scene(); document.resetColor();
    require(document.colorPending() && document.colorValues()==neutralColor,"Reset previews neutral relative to session base");
    commitColor(document);
    require(document.scene()==source && document.undo() && document.scene()==beforeReset,
            "Reset Color restores the base as one undoable edit");
    document.markSaved(document.savePoint()); document.previewColor(color(.7f));
    require(document.dirty(),"Pending colors dirty even saved committed content");
    document.cancelColorDraft();
    require(!document.colorPending() && !document.dirty() && document.renderScene()==beforeReset,
            "Cancelling an unsubmitted color gesture restores the last applied preview and saved state");

    document.replace(input,source); document.previewColor(color(.8f));
    const auto retry=*document.captureColor(); const auto beforeFailure=document.savePoint();
    std::stop_source cancelled; cancelled.request_stop();
    rejects([&] { retry.run(cancelled.get_token()); },"Cancelled color baking reports failure");
    require(document.current(retry) && document.scene()==source && document.colorValues()==color(.8f) &&
                document.savePoint()==beforeFailure && document.dirty(),
            "Cancellation preserves retryable desired colors without history or committed-content changes");
    auto invalid=retry.run(); invalid.states.clear();
    rejects([&] { document.apply(std::move(invalid),retry); },"Invalid completed data cannot commit");
    require(document.current(retry) && document.scene()==source && document.colorPending(),
            "Apply failure also leaves the immutable submission retryable");
    require(document.apply(retry.run(),retry),"The same captured color can retry after a failed application");
    const auto settled=document.scene();
    const auto generic=document.captureProcessing({{"type","opacity"},{"values",{{"scale",.9f}}}});
    document.previewColor(color(.9f));
    require(!document.current(generic) && !document.apply(generic.run(),generic) && document.scene()==settled,
            "A new color draft invalidates generic processing captured against a settled session");
    rejects([&] { document.captureProcessing({{"type","center"}}); },"Pending colors require an explicit processing boundary");
    rejects([&] { document.endColorSession(); },"Ending a session cannot silently discard pending colors");
    rejects([&] { document.previewColor(color(.9f),true); },"Changing color scope cannot discard pending work");
    document.cancelColorDraft(); document.endColorSession();
    const auto operation=document.captureProcessing({{"type","opacity"},{"values",{{"scale",.9f}}}});
    require(document.apply(operation.run(),operation) && document.colorValues()==neutralColor &&
                document.renderScene()==document.scene(),
            "A subsequent generic edit consumes baked colors and ends the settled session");

    Document other; other.replace(input,source);
    document.replace(input,source); document.previewColor(color(1.2f)); other.previewColor(color(1.2f));
    const auto foreign=*other.captureColor();
    require(!document.current(foreign) && !document.apply(foreign.run(),foreign) && document.colorPending(),
            "Matching draft values and revisions cannot authorize another document's completion");
    const auto previous=*document.captureColor(); document.replace(input,source);
    require(!document.current(previous) && !document.apply(previous.run(),previous) && !document.hasPendingDrafts() &&
                !document.dirty() && document.renderScene()==source,
            "Replacing a source clears drafts and invalidates previous-generation completion");
    document.edits()->selectSingle(0,SelectOperation::Set);
    document.previewColor(color(1.2f),true); const auto selected=*document.captureColor();
    document.edits()->selectSingle(1,SelectOperation::Set);
    const auto selectedResult=selected.run();
    require(selectedResult.states[0]==1 && selectedResult.states[1]==0 &&
                shValue(selectedResult.scene->gaussians[0],0,0)!=shValue(source->gaussians[0],0,0) &&
                std::memcmp(&selectedResult.scene->gaussians[1],&source->gaussians[1],sizeof(Gaussian))==0,
            "The worker grades its captured selection mask even after the live mask changes");
    require(!document.current(selected) && !document.apply(selectedResult,selected) && document.colorPending(),
            "Legacy SceneEdits selection changes invalidate a submitted draft rather than restoring an old mask");
    rejects([&] { document.captureColor(); },"Legacy mask mutation needs an explicit draft cancellation boundary");
    document.cancelColorDraft();
    require(!document.colorPending(),"Explicit cancellation releases a draft invalidated by legacy edits");

    document.replace(input,source); document.edits()->selectSingle(0,SelectOperation::Set);
    Matrix4 transform=identityMatrix; transform[12]=.75f;
    document.previewTransform(transform,true);
    require(document.transformPending() && !document.dirty() && document.scene()==source &&
                document.previewSettings().geometrySelectedOnly,
            "Gizmo geometry remains transient and does not dirty committed content");
    auto invalidTransform=transform; invalidTransform[0]=std::numeric_limits<float>::quiet_NaN();
    rejects([&] { document.previewTransform(invalidTransform,true); },"Invalid geometry is rejected before preview mutation");
    require(document.transformValues()==transform,"Invalid geometry preserves the prior transient preview");
    rejects([&] { document.captureProcessing({{"type","center"}}); },"Generic processing must resolve active geometry first");
    const auto geometryExport=document.captureExport(folder/"transient.ply").run();
    require(document.finishExport(geometryExport) && !document.dirty() && document.transformPending(),
            "Exporting committed content neither applies nor clears transient geometry");
    const auto untransformed=loadScene(folder/"transient.ply");
    require(std::abs(untransformed.gaussians[0].positionOpacity[0]-source->gaussians[0].positionOpacity[0])<1e-6f,
            "Export ignores an uncommitted geometry preview as the original host does");
    const auto oldTransform=*document.captureTransform(); transform[12]=1.25f;
    document.previewTransform(transform,true);
    require(!document.current(oldTransform) && !document.apply(oldTransform.run(),oldTransform) &&
                document.transformValues()==transform,
            "An old geometry completion cannot clear or double-apply a newer incremental transform");
    const auto geometryJob=*document.captureTransform();
    rejects([&] { geometryJob.run(cancelled.get_token()); },"Cancelled geometry baking reports failure");
    require(document.current(geometryJob) && document.transformValues()==transform && !document.dirty(),
            "Geometry cancellation retains the transient preview for retry");
    const auto transformed=rendered(document);
    require(document.apply(geometryJob.run(),geometryJob) && !document.transformPending() && document.dirty() &&
                sameSplats(*transformed,*document.scene()) && document.previewSettings().geometry==identityMatrix,
            "Matching geometry completion installs the preview exactly once and clears only its own draft");
    require(!document.apply(geometryJob.run(),geometryJob) && document.undo() && document.scene()==source,
            "A geometry submission is one undoable edit and cannot replay");
    document.previewTransform(transform); document.cancelTransformDraft();
    require(!document.transformPending() && !document.dirty(),"Cancelling geometry leaves committed/saved content intact");

    Document geometryMasks; geometryMasks.replace(input,source);
    geometryMasks.edits()->selectSingle(0,SelectOperation::Set);
    geometryMasks.previewTransform(transform,true);
    geometryMasks.edits()->selectSingle(1,SelectOperation::Set);
    rejects([&] { geometryMasks.captureTransform(); },
            "Selection changes before submission cannot silently retarget an existing geometry draft");
    auto adjusted=transform; adjusted[12]+=.2f;
    rejects([&] { geometryMasks.previewTransform(adjusted,true); },
            "Adjusting a draft after legacy selection mutation cannot silently rebase it");
    require(geometryMasks.transformValues()==transform && geometryMasks.scene()==source && !geometryMasks.dirty(),
            "Rejected geometry retargeting preserves the transient draft and committed source");
    geometryMasks.cancelTransformDraft(); geometryMasks.previewTransform(adjusted,true);
    const auto pinned=*geometryMasks.captureTransform(); const auto pinnedResult=pinned.run();
    require(pinnedResult.states[1]==1 && pinnedResult.states[0]==0 &&
                std::abs(pinnedResult.scene->gaussians[1].positionOpacity[0]-
                         source->gaussians[1].positionOpacity[0]-adjusted[12])<1e-6f &&
                std::memcmp(&pinnedResult.scene->gaussians[0],&source->gaussians[0],sizeof(Gaussian))==0,
            "Explicit cancellation lets a fresh geometry draft capture its intended selection mask");
    geometryMasks.edits()->selectSingle(2,SelectOperation::Set);
    require(!geometryMasks.current(pinned) && !geometryMasks.apply(pinnedResult,pinned) &&
                geometryMasks.transformValues()==adjusted && geometryMasks.scene()==source,
            "A mask change after geometry submission rejects completion without clearing or applying its draft");
    rejects([&] { geometryMasks.captureTransform(); },
            "A superseded geometry draft remains blocked until its explicit cancellation boundary");
    geometryMasks.cancelTransformDraft(); geometryMasks.previewTransform(adjusted,true);
    const auto refreshed=*geometryMasks.captureTransform();
    require(geometryMasks.apply(refreshed.run(),refreshed) && !geometryMasks.transformPending() &&
                std::abs(geometryMasks.scene()->gaussians[2].positionOpacity[0]-
                         source->gaussians[2].positionOpacity[0]-adjusted[12])<1e-6f &&
                std::memcmp(&geometryMasks.scene()->gaussians[1],&source->gaussians[1],sizeof(Gaussian))==0,
            "A new boundary resets geometry guards and commits only the new selected splat");

    document.replace(input,source); document.previewColor(color(1.2f));
    rejects([&] { document.captureExport(folder/"pending.ply"); },"Raw export capture requires colors flushed first");
    document.exportScene(folder/"flushed.ply");
    require(!document.colorPending() && !document.dirty() &&
                sameExportValues(loadScene(folder/"flushed.ply"),*document.scene()),
            "Synchronous full export flushes the visible grade and marks its captured content saved");
    const auto exportJob=document.captureExport(folder/"older.ply");
    document.previewColor(color(1.4f));
    require(document.finishExport(exportJob.run()) && document.dirty() && document.colorPending(),
            "Export completion cannot clear a newer pending color draft");
    document.cancelColorDraft();
    require(!document.dirty(),"Cancelling the newer gesture returns to the exported saved content");
    document.endColorSession(); document.edits()->selectSingle(0,SelectOperation::Set);
    document.previewColor(color(.8f),true); document.exportScene(folder/"subset.ply",ExportScope::Selected);
    require(document.dirty() && !document.colorPending() && loadScene(folder/"subset.ply").loadedCount()==1,
            "Partial export flushes colors but never marks full document content saved");
    document.previewColor(color(.7f),true);
    const auto pendingOutput=folder/"cancelled.ply";
    rejects([&] { document.exportScene(pendingOutput,ExportScope::All,cancelled.get_token()); },
            "Cancelled flush prevents export publication");
    require(document.colorPending() && !std::filesystem::exists(pendingOutput),
            "A cancelled export flush leaves retryable colors and creates no output");
    auto badColor=color(1); badColor[0]=std::numeric_limits<float>::infinity();
    const auto desired=document.colorValues();
    rejects([&] { document.previewColor(badColor,true); },"Nonfinite color values are rejected before state mutation");
    require(document.colorValues()==desired,"Invalid color input preserves the desired draft");

    // Original .74 processing_contracts:829-879: Auto analyzes the fixed base,
    // preserves unrelated manual fields, and each completed adjustment is undoable.
    Document automatic; automatic.replace(input,source); automatic.edits()->selectSingle(0,SelectOperation::Set);
    auto manual=neutralColor; manual[0]=1.15f; manual[1]=1.1f; manual[2]=.8f; manual[3]=1.3f;
    manual[4]=1.2f; manual[5]=.15f; manual[6]=-.1f; manual[7]=.1f; manual[9]=.05f; manual[14]=12;
    automatic.previewColor(manual,true); commitColor(automatic);
    for(const std::string method:{"exposure","contrast","white_balance","enhance"}) {
        const auto before=automatic.scene(); const auto previousValues=automatic.colorValues();
        const auto analysis=processScene(source,automatic.states(),{{"type","auto"},{"values",{{"method",method}}},{"analyze_only",true}},true);
        auto expected=previousValues;
        for(size_t k=0;k<expected.size();++k) {
            const bool adjust=((method=="enhance" || method=="exposure") && k==0) ||
                ((method=="enhance" || method=="contrast") && k==1) ||
                ((method=="enhance" || method=="white_balance") && (k==5 || k==6));
            if(adjust) expected[k]=analysis.report.at("suggested_color").at(colorFields[k].name).get<float>();
        }
        auto job=automatic.captureAutoColor(method,true); require(job.colorJob(),"Auto snapshots classify as color jobs");
        require(automatic.scene()==before && automatic.colorValues()==previousValues,"Auto capture preserves committed content and sliders until success");
        require(automatic.apply(job.run(),job) && automatic.colorValues()==expected && !automatic.colorPending() &&
                    automatic.renderScene()==source && sameSplats(*rendered(automatic),*automatic.scene()) &&
                    sameSplats(*automatic.scene(),*processScene(source,automatic.states(),grade(expected),true).scene),
                "Auto replaces only its fields and bakes all absolute values once from the session base");
        require(!automatic.current(job),"A completed Auto job cannot publish twice");
        const auto firstAuto=automatic.scene();
        auto repeated=automatic.captureAutoColor(method,true);
        require(automatic.apply(repeated.run(),repeated) && automatic.colorValues()==expected && sameSplats(*automatic.scene(),*firstAuto),
                "Repeated Auto reanalyzes the same ungraded base and does not compound");
    }
    const auto autoCommitted=automatic.scene();
    auto staleAuto=automatic.captureAutoColor("exposure",true); const auto staleAutoResult=staleAuto.run();
    auto newer=automatic.colorValues(); newer[2]=1.25f; automatic.previewColor(newer,true);
    require(!automatic.current(staleAuto) && !automatic.apply(staleAutoResult,staleAuto) && automatic.colorValues()==newer && automatic.scene()==autoCommitted,
            "A newer manual gesture rejects an old Auto completion without clearing the desired values");
    auto retryAuto=automatic.captureAutoColor("contrast",true); const auto beforeAutoCancel=automatic.savePoint();
    rejects([&] { retryAuto.run(cancelled.get_token()); },"Cancelled Auto does not bake");
    require(automatic.current(retryAuto) && automatic.colorValues()==newer && automatic.savePoint()==beforeAutoCancel,
            "Failed Auto retains its fixed base, manual values and retryable immutable submission");
    auto invalidAuto=retryAuto.run(); invalidAuto.report["suggested_color"]["gamma"]=std::numeric_limits<float>::infinity();
    rejects([&] { automatic.apply(invalidAuto,retryAuto); },"Invalid Auto report is rejected before installing its scene");
    require(automatic.scene()==autoCommitted && automatic.current(retryAuto),"Malformed completion preserves the prior scene and retry");
    Document autoOther; autoOther.replace(input,source); autoOther.edits()->selectSingle(0,SelectOperation::Set);
    const auto foreignAuto=autoOther.captureAutoColor("contrast",true);
    require(!automatic.current(foreignAuto) && !automatic.apply(foreignAuto.run(),foreignAuto),"Foreign Auto completion cannot authorize another controller");
    automatic.cancelColorDraft(); automatic.endColorSession();
    require(automatic.undo() && automatic.colorValues()==neutralColor,"Auto success participates in ordinary content history");
    rejects([&] { automatic.captureAutoColor("profile",true); },"UI Auto methods are limited to the original four adjustments");

    // Original .74:559-566 + Viewer::beginOperationSession/resetOperation:
    // opacity and numeric transforms use one baseline and one captured scope.
    Document numeric; numeric.replace(input,source); numeric.edits()->selectSingle(0,SelectOperation::Set);
    auto opacityRecipe=[](float scale) { return Recipe{{"type","opacity"},{"values",{{"scale",scale}}}}; };
    auto opacityFirst=numeric.captureOperation(opacityRecipe(.4f),"opacity",true);
    require(!opacityFirst.colorJob() && numeric.apply(opacityFirst.run(),opacityFirst),"Numeric opacity commits its own operation group");
    const auto opacityScene=numeric.scene();
    auto opacitySecond=numeric.captureOperation(opacityRecipe(.7f),"opacity",false);
    require(numeric.apply(opacitySecond.run(),opacitySecond) && numeric.activeOperation()=="opacity" &&
                sameSplats(*numeric.scene(),*processScene(source,opacityFirst.run().states,opacityRecipe(.7f),true).scene) &&
                std::memcmp(&numeric.scene()->gaussians[1],&source->gaussians[1],sizeof(Gaussian))==0,
            "Repeated opacity remains absolute and retains the initial selected-only scope");
    const auto beforeNumericReset=numeric.scene(); const auto resetOpacity=numeric.captureOperationReset("opacity");
    require(resetOpacity && numeric.apply(resetOpacity->run(),*resetOpacity) && numeric.scene()==source &&
                numeric.activeOperation()=="opacity" && !numeric.captureOperationReset("opacity"),
            "Reset opacity restores its exact base and mask without ending the operation group");
    require(numeric.undo() && numeric.scene()==beforeNumericReset && numeric.activeOperation().empty() &&
                numeric.undo() && numeric.scene()==opacityScene && numeric.undo() && numeric.scene()==source,
            "Each numeric edit and reset is one undoable revision; Undo ends the session");
    auto transformRecipe=[](float x) { return Recipe{{"type","transform"},{"values",{{"translation",{x,0,0}}}}}; };
    auto moveFirst=numeric.captureOperation(transformRecipe(.2f),"transform",true);
    require(numeric.apply(moveFirst.run(),moveFirst),"First numeric transform commits");
    auto moveSecond=numeric.captureOperation(transformRecipe(.5f),"transform",true);
    require(numeric.apply(moveSecond.run(),moveSecond) && !numeric.transformPending() &&
                std::abs(numeric.scene()->gaussians[0].positionOpacity[0]-source->gaussians[0].positionOpacity[0]-.5f)<1e-6f &&
                numeric.previewSettings().geometry==identityMatrix,
            "Numeric transforms repeat from their fixed base and never become transient gizmo deltas");
    numeric.previewTransform(transform,true); numeric.cancelTransformDraft();
    require(numeric.activeOperation()=="transform" && numeric.operationRecipe()==transformRecipe(.5f),
            "Cancelling a transient gizmo preserves accepted numeric controls and their reset baseline");
    const auto moveReset=numeric.captureOperationReset("transform");
    require(moveReset && numeric.apply(moveReset->run(),*moveReset) && numeric.scene()==source,"Numeric reset exactly restores the transform base");
    auto failedNumeric=numeric.captureOperation(transformRecipe(.3f),"transform",true);
    rejects([&] { failedNumeric.run(cancelled.get_token()); },"Cancelled numeric work preserves content");
    require(numeric.current(failedNumeric) && numeric.scene()==source && numeric.operationRecipe()==transformRecipe(.3f),
            "Numeric failure retains its recipe and baseline for explicit retry");
    auto newerNumeric=numeric.captureOperation(transformRecipe(.6f),"transform",true);
    require(!numeric.current(failedNumeric) && !numeric.apply(failedNumeric.run(),failedNumeric),"A newer numeric request invalidates an old completion");
    numeric.edits()->selectSingle(1,SelectOperation::Set);
    require(!numeric.current(newerNumeric) && !numeric.apply(newerNumeric.run(),newerNumeric) && numeric.activeOperation().empty(),
            "Legacy mask changes invalidate a numeric submission and its operation session");
    auto newMask=numeric.captureOperation(transformRecipe(.1f),"transform",true);
    require(numeric.apply(newMask.run(),newMask) &&
                std::memcmp(&numeric.scene()->gaussians[0],&source->gaussians[0],sizeof(Gaussian))==0 &&
                std::abs(numeric.scene()->gaussians[1].positionOpacity[0]-source->gaussians[1].positionOpacity[0]-.1f)<1e-6f,
            "A new numeric session after mask mutation pins the new selected splat");
    const auto unrelated=numeric.captureProcessing(opacityRecipe(.8f));
    require(numeric.apply(unrelated.run(),unrelated) && numeric.activeOperation().empty(),"An unrelated generic edit ends the numeric session");
    auto foreignNumeric=autoOther.captureOperation(opacityRecipe(.5f),"opacity");
    require(!numeric.current(foreignNumeric) && !numeric.apply(foreignNumeric.run(),foreignNumeric),"Numeric completions also reject foreign owners");
    rejects([&] { numeric.captureOperation(opacityRecipe(.5f),"transform"); },"Numeric group validation precedes session mutation");

    // Original .74 replaceScene accepts unchanged scene/state results without
    // an undo entry; a successful generic operation still ends fixed sessions.
    const Recipe allPass={{"type","filter"},{"action","keep"},{"values",{{"min_opacity",0},{"max_opacity",1}}}};
    Document noOpColor; noOpColor.replace(input,source); noOpColor.previewColor(color(1.2f)); commitColor(noOpColor);
    const auto graded=noOpColor.scene(); const auto gradedRevision=noOpColor.revision();
    const auto gradedPoint=noOpColor.savePoint(); noOpColor.markSaved(gradedPoint);
    const auto colorBoundary=noOpColor.captureProcessing(allPass); const auto unchangedColor=colorBoundary.run();
    require(unchangedColor.scene==graded && std::ranges::equal(unchangedColor.states,noOpColor.states()) &&
                noOpColor.current(colorBoundary) && noOpColor.apply(unchangedColor,colorBoundary),
            "A current all-pass filter completes successfully even when it returns the same scene and mask");
    require(noOpColor.scene()==graded && noOpColor.revision()==gradedRevision && noOpColor.savePoint()==gradedPoint &&
                !noOpColor.dirty() && noOpColor.colorValues()==neutralColor && noOpColor.renderScene()==graded &&
                !noOpColor.current(colorBoundary) && noOpColor.undo() && noOpColor.scene()==source,
            "Accepted no-op ends the settled color session without dirtying content or inserting an empty undo entry");

    Document noOpNumeric; noOpNumeric.replace(input,source);
    const auto fade=noOpNumeric.captureOperation(opacityRecipe(.4f),"opacity");
    require(noOpNumeric.apply(fade.run(),fade),"No-op numeric fixture has a committed fixed-base operation");
    const auto faded=noOpNumeric.scene(); const auto fadedRevision=noOpNumeric.revision();
    const auto abandonedReset=*noOpNumeric.captureOperationReset("opacity");
    const auto numericBoundary=noOpNumeric.captureProcessing(allPass);
    require(noOpNumeric.apply(numericBoundary.run(),numericBoundary) && noOpNumeric.scene()==faded &&
                noOpNumeric.revision()==fadedRevision && noOpNumeric.activeOperation().empty() &&
                !noOpNumeric.current(abandonedReset) && !noOpNumeric.apply(abandonedReset.run(),abandonedReset),
            "Successful no-op ends numeric sessions and invalidates a reset captured from the old baseline");
    const auto refade=noOpNumeric.captureOperation(opacityRecipe(.7f),"opacity");
    require(noOpNumeric.apply(refade.run(),refade) &&
                std::abs(noOpNumeric.scene()->gaussians[0].positionOpacity[3]-faded->gaussians[0].positionOpacity[3]*.7f)<1e-6f &&
                noOpNumeric.undo() && noOpNumeric.scene()==faded && noOpNumeric.undo() && noOpNumeric.scene()==source,
            "A numeric operation after the generic boundary uses committed content as its new base and preserves ordinary history");

    Document replacement; replacement.replace(input,source); replacement.previewColor(color(.8f));
    const auto beforeReplace=*replacement.captureColor(); const auto replacePoint=replacement.savePoint();
    const auto replaceCamera=replacement.camera.savedView();
    rejects([&] { replacement.replace(folder/"rejected.ply",{}); },"Invalid replacement fails before changing owner state");
    require(replacement.path()==input && replacement.inputPaths().size()==1 && replacement.inputPaths()[0]==input &&
                replacement.scene()==source && replacement.savePoint()==replacePoint && replacement.camera.savedView()==replaceCamera &&
                replacement.colorValues()==color(.8f) && replacement.current(beforeReplace),
            "Failed replacement preserves the old scene, path, inputs, camera and retryable draft together");
    const auto nextSource=fixture(); const auto nextPath=folder/"replacement.ply";
    replacement.replace(nextPath,nextSource);
    require(replacement.path()==nextPath && replacement.inputPaths().size()==1 && replacement.inputPaths()[0]==nextPath &&
                replacement.scene()==nextSource && !replacement.dirty() && !replacement.hasPendingDrafts() &&
                !replacement.current(beforeReplace) && replacement.generation()==replacePoint.sourceGeneration+1,
            "Successful replacement installs the new scene and input identity and invalidates prior jobs");

    // Frozen .74 processingViewerContracts:577-618: alignment is cumulative,
    // while Reset retains the first scene/mask and carries current view framing.
    const auto alignmentSource=fixture();
    Camera savedDefault; savedDefault.fit(*alignmentSource); savedDefault.orbit(12,-8); savedDefault.roll=.31f;
    alignmentSource->defaultView=savedDefault.savedView();
    Document alignment; alignment.replace(input,alignmentSource); alignment.edits()->selectSingle(0,SelectOperation::Set);
    const std::vector<uint8_t> alignmentMask(alignment.states().begin(),alignment.states().end());
    alignment.camera.orbit(-7,9); alignment.camera.roll=-.22f;
    const auto originalView=alignment.camera;
    const auto shift=transformMatrix({{"translation",{.7f,-.3f,.2f}}});
    const auto enlarge=transformMatrix({{"scale",1.6f}});
    const auto firstAlign=alignment.captureAlignment(matrixRecipe(shift),true);
    require(alignment.current(firstAlign) && alignment.activeOperation()=="alignment" && !alignment.captureOperationReset("alignment"),
            "Alignment capture retains its original baseline without changing geometry or creating a reset entry");
    sameCamera(alignment.camera,originalView,"Alignment capture does not move the current camera");
    const auto beforeInvalidAlignment=alignment.draftRevision();
    rejects([&] { alignment.captureAlignment({{"type","transform"},{"values",{{"scale",{1,2,1}}}}}); },
            "Nonuniform alignment is rejected before changing its pending sequence");
    require(alignment.current(firstAlign) && alignment.draftRevision()==beforeInvalidAlignment,
            "Invalid alignment cannot supersede a valid retryable submission or reset baseline");
    rejects([&] { firstAlign.run(cancelled.get_token()); },"Cancelled cumulative alignment cannot publish");
    auto firstAlignmentResult=firstAlign.run(); auto invalidAlignment=firstAlignmentResult; invalidAlignment.states.clear();
    rejects([&] { alignment.apply(invalidAlignment,firstAlign); },"Invalid alignment completion fails before history publication");
    require(alignment.current(firstAlign) && alignment.scene()==alignmentSource && !alignment.dirty(),
            "Alignment failure preserves scene, camera, saved state and retryable baseline");
    require(alignment.apply(firstAlignmentResult,firstAlign),"First coordinate alignment commits");
    const auto shifted=alignment.scene();
    sameCamera(alignment.camera,originalView.transformed(shift),"First alignment carries full current camera orientation");
    require(shifted->defaultView==savedDefault.transformed(shift).savedView() &&
                std::memcmp(&shifted->gaussians[1],&alignmentSource->gaussians[1],sizeof(Gaussian))==0,
            "Alignment transforms an independently saved default view and preserves unselected payload");
    const auto secondAlign=alignment.captureAlignment(matrixRecipe(enlarge),false);
    alignment.camera.pan(4,-3); const auto navigationDuringAlignment=alignment.camera;
    require(alignment.apply(secondAlign.run(),secondAlign),"Second coordinate alignment commits cumulatively");
    const auto aligned=alignment.scene();
    require(sameSplats(*aligned,*processScene(shifted,alignmentMask,matrixRecipe(enlarge),true).scene) &&
                aligned->defaultView==savedDefault.transformed(shift).transformed(enlarge).savedView() &&
                std::memcmp(&aligned->gaussians[1],&alignmentSource->gaussians[1],sizeof(Gaussian))==0,
            "Consecutive alignment acts on current geometry and retains the first selection scope");
    sameCamera(alignment.camera,navigationDuringAlignment.transformed(enlarge),
               "Alignment completion carries navigation performed after submission");
    alignment.previewTransform(transform,true); alignment.cancelTransformDraft();
    require(alignment.activeOperation()=="alignment" && alignment.captureOperationReset("alignment"),
            "Cancelling a transient gizmo preserves the cumulative alignment Reset baseline");
    const auto resetAlignment=*alignment.captureOperationReset("alignment");
    rejects([&] { resetAlignment.run(cancelled.get_token()); },"Cancelled alignment Reset preserves the entire sequence");
    require(alignment.current(resetAlignment) && alignment.scene()==aligned,"Cancelled Reset remains retryable without geometry changes");
    alignment.camera.orbit(3,-2); const auto viewBeforeReset=alignment.camera;
    const auto resetView=viewBeforeReset.transformed(transformMatrix({{"scale",1.f/1.6f}}))
        .transformed(transformMatrix({{"translation",{-.7f,.3f,-.2f}}}));
    require(alignment.apply(resetAlignment.run(),resetAlignment) && alignment.scene()==alignmentSource &&
                std::ranges::equal(alignment.states(),alignmentMask) && alignment.scene()->defaultView==savedDefault.savedView() &&
                alignment.activeOperation()=="alignment" && !alignment.captureOperationReset("alignment"),
            "One Reset restores the exact original scene/mask/default view and retains a settled alignment group");
    sameCamera(alignment.camera,resetView,"Reset carries latest navigation into the original coordinates rather than rewinding it");
    require(alignment.undo() && alignment.scene()==aligned && alignment.activeOperation().empty(),
            "One Undo of Reset restores the complete aligned sequence and ends its operation session");
    sameCamera(alignment.camera,viewBeforeReset,"Undo of Reset restores aligned camera framing");
    require(alignment.redo() && alignment.scene()==alignmentSource,"Alignment Reset supports Redo");
    sameCamera(alignment.camera,resetView,"Redo of Reset restores original-coordinate framing");
    require(alignment.undo() && alignment.undo() && alignment.scene()==shifted && alignment.undo() && alignment.scene()==alignmentSource,
            "Each alignment and exact Reset remains a separate content-history entry");

    Document staleAlignment; staleAlignment.replace(input,alignmentSource);
    staleAlignment.edits()->selectSingle(0,SelectOperation::Set);
    const auto oldAlign=staleAlignment.captureAlignment(matrixRecipe(shift),true);
    const auto newerAlign=staleAlignment.captureAlignment(matrixRecipe(enlarge),true);
    require(!staleAlignment.current(oldAlign) && !staleAlignment.apply(oldAlign.run(),oldAlign),
            "A newer alignment request rejects an older completion against the same geometry");
    staleAlignment.edits()->selectSingle(1,SelectOperation::Set);
    require(!staleAlignment.current(newerAlign) && !staleAlignment.apply(newerAlign.run(),newerAlign) &&
                !staleAlignment.captureOperationReset("alignment"),
            "Selection drift invalidates both cumulative alignment completion and its old Reset baseline");
    const auto newScope=staleAlignment.captureAlignment(matrixRecipe(shift),true);
    require(staleAlignment.apply(newScope.run(),newScope) &&
                std::memcmp(&staleAlignment.scene()->gaussians[0],&alignmentSource->gaussians[0],sizeof(Gaussian))==0,
            "A new sequence after selection drift pins the new mask instead of restoring an obsolete one");
    const auto staleReset=*staleAlignment.captureOperationReset("alignment");
    const auto genericBoundary=staleAlignment.captureProcessing(allPass);
    const auto beforeAlignmentBoundary=staleAlignment.revision();
    require(staleAlignment.apply(genericBoundary.run(),genericBoundary) && staleAlignment.revision()==beforeAlignmentBoundary &&
                staleAlignment.activeOperation().empty() && !staleAlignment.apply(staleReset.run(),staleReset),
            "An accepted generic no-op ends alignment and prevents a stale sequence Reset without extra history");
    Document foreignAlignment; foreignAlignment.replace(input,alignmentSource);
    const auto foreignAlign=foreignAlignment.captureAlignment(matrixRecipe(shift));
    require(!staleAlignment.current(foreignAlign) && !staleAlignment.apply(foreignAlign.run(),foreignAlign),
            "Cumulative alignment snapshots retain cross-document ownership guards");
    const auto discardedAlign=staleAlignment.captureAlignment(matrixRecipe(enlarge));
    staleAlignment.replace(input,alignmentSource);
    require(!staleAlignment.apply(discardedAlign.run(),discardedAlign) && staleAlignment.activeOperation().empty(),
            "Replacement clears the retained alignment sequence and rejects previous-generation work");

    Document floorDocument; floorDocument.replace(input,source); floorDocument.edits()->selectAll();
    FloorOptions floorOptions; floorOptions.viewpoint=floorDocument.camera.eye(); floorOptions.iterations=100;
    const auto plane=detectFloor(*source,floorDocument.states(),true,floorOptions);
    require(bool(plane),"Floor fixture has a reproducible plane");
    const auto expectedFloor=floorDocument.captureAlignment(matrixRecipe(alignFloor(*plane)),true).run();
    const auto floorJob=floorDocument.captureFloorAlignment(floorOptions,true);
    require(!floorJob.colorJob() && floorDocument.scene()==source,"Floor capture performs no UI-thread scene edit");
    const auto detected=floorJob.run();
    require(sameSplats(*detected.scene,*expectedFloor.scene) && detected.scene->alignmentFrame==expectedFloor.scene->alignmentFrame &&
                detected.scene->defaultView==expectedFloor.scene->defaultView,
            "Worker floor analysis uses the same SH/coordinate/default-view alignment path as an explicit detected transform");
    rejects([&] { floorJob.run(cancelled.get_token()); },"Cancelled floor analysis cannot publish a scene");
    require(floorDocument.current(floorJob) && floorDocument.scene()==source,"Cancelled floor work leaves its immutable submission reusable");
    floorDocument.edits()->selectSingle(0,SelectOperation::Set);
    require(!floorDocument.current(floorJob) && !floorDocument.apply(detected,floorJob),"Floor completion rejects a changed selection revision");
    const auto tooFew=floorDocument.captureFloorAlignment(floorOptions,true);
    rejects([&] { tooFew.run(); },"Floor failure with fewer than three selected splats preserves the scene");
    floorDocument.edits()->selectAll(); const auto finalFloor=floorDocument.captureFloorAlignment(floorOptions,true);
    require(floorDocument.apply(finalFloor.run(),finalFloor) && floorDocument.undo() && floorDocument.scene()==source,
            "Accepted floor alignment is one undoable edit");

    Document floorSequence; floorSequence.replace(input,source); floorSequence.edits()->selectAll();
    const auto beforeFloor=floorSequence.captureAlignment(matrixRecipe(shift),true);
    require(floorSequence.apply(beforeFloor.run(),beforeFloor),"Floor sequence starts with a coordinate alignment");
    const auto floorStep=floorSequence.captureFloorAlignment({},false);
    require(floorSequence.apply(floorStep.run(),floorStep) && floorSequence.activeOperation()=="alignment",
            "Detected floor joins the current cumulative alignment group");
    const auto fullFloorSequence=floorSequence.scene(); const auto floorReset=*floorSequence.captureOperationReset("alignment");
    require(floorSequence.apply(floorReset.run(),floorReset) && floorSequence.scene()==source &&
                floorSequence.undo() && floorSequence.scene()==fullFloorSequence,
            "Floor Reset restores the first sequence scene rather than only the pre-floor geometry and is undoable");

    const FileSnapshot finalBytes(input,65536);
    require(std::ranges::equal(sourceBytes.bytes(),finalBytes.bytes()),"Drafts, history and exports preserve source payload");
}
