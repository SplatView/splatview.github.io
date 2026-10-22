#include "document_job_contracts.hpp"
#include "document.hpp"
#include "geometry_tools.hpp"
#include "file_io.hpp"
#include <cmath>
#include <fstream>
#include <stdexcept>
#include <thread>
#include <type_traits>

using namespace preview;
static_assert(!std::is_copy_constructible_v<Document> && !std::is_move_constructible_v<Document>);
namespace {
void require(bool ok,const char *message) {
    if(!ok) throw std::runtime_error(message);
}
template<class F> void rejects(F action,const char *message) {
    try { action(); } catch(const std::exception &) { return; }
    throw std::runtime_error(message);
}
Recipe brightness(float amount) { return {{"type","color"},{"values",{{"brightness",amount}}}}; }
std::shared_ptr<Scene> fixture() {
    auto scene=std::make_shared<Scene>();
    scene->shDegree=3;
    for(int i=0;i<6;++i) {
        Attributes attr;
        attr.position={float(i)*.1f-.25f,float(i%2)*.2f,0};
        attr.scale={.05f,.025f,.04f}; attr.opacity=.8f;
        attr.sh[0]=.6f; attr.sh[1]=-.3f; attr.sh[2]=.2f;
        attr.sh[6]=.15f;
        scene->gaussians.push_back(packGaussian(attr));
    }
    scene->sourceCount=scene->gaussians.size();
    fitBounds(*scene);
    return scene;
}
void edit(Document &document,float amount) {
    const auto job=document.captureProcessing(brightness(amount));
    require(document.apply(job.run(),job),"Current captured processing job must commit");
}
void sameCamera(const Camera &actual,const Camera &expected,const char *message) {
    require(pointDistance(actual.eye(),expected.eye())<3e-5f &&
                pointDistance(actual.target,expected.target)<3e-5f &&
                std::abs(actual.roll-expected.roll)<3e-5f &&
                std::abs(actual.distance-expected.distance)<3e-5f && actual.yUp==expected.yUp,message);
}
std::string read(const std::filesystem::path &path) {
    std::ifstream stream(path,std::ios::binary);
    return {std::istreambuf_iterator<char>(stream),std::istreambuf_iterator<char>()};
}
} // namespace
void documentJobContracts(const std::filesystem::path &directory) {
    const auto folder=directory/"document-jobs";
    std::filesystem::create_directories(folder);
    const auto input=folder/"input.ply";
    const auto source=fixture();
    writeVisibleScene(*source,{},input,SceneExportFormat::Ply);
    Document firstOwner,secondOwner;
    firstOwner.open(input); secondOwner.open(input);
    edit(firstOwner,1.1f); edit(secondOwner,1.2f);
    require(firstOwner.generation()==secondOwner.generation() &&
                firstOwner.revision()==secondOwner.revision(),
            "Concurrent document fixture must exercise matching generation/revision values");
    const auto firstJob=firstOwner.captureProcessing(brightness(1.3f));
    const auto secondScene=secondOwner.scene();
    require(!secondOwner.apply(firstJob.run(),firstJob) && secondOwner.scene()==secondScene,
            "Matching generations and revisions cannot authorize a different document's processing job");
    const auto firstExport=firstOwner.captureExport(folder/"first-owner.ply").run();
    require(!secondOwner.finishExport(firstExport) && secondOwner.dirty(),
            "A different document's export completion cannot mark matching content revisions clean");
    require(firstOwner.finishExport(firstExport) && !firstOwner.dirty(),
            "Export completion remains valid for its actual owner");
    require(!secondOwner.finishExport({}) && !secondOwner.markSaved({}),
            "Default save points and export completions cannot mark a document clean");
    const ProcessingSnapshot uninitialized;
    rejects([&] { uninitialized.run(); },"Default processing snapshot must fail cleanly");
    require(!secondOwner.apply(ProcessingResult{source,SceneVector<uint8_t>(6)},uninitialized) &&
                secondOwner.scene()==secondScene,
            "An uninitialized snapshot cannot authorize an otherwise valid processing result");
    Document document;
    document.open(input);
    edit(document,1.1f);
    const auto capturedScene=document.scene();
    const auto exportJob=document.captureExport(folder/"captured.ply");
    require(exportJob.savePoint()==document.savePoint(),"Export captures the exact source/content save point");
    edit(document,1.2f);
    const auto newerScene=document.scene();
    ExportCompletion completion;
    std::exception_ptr failure;
    std::jthread writer([&] {
        try { completion=exportJob.run(); } catch(...) { failure=std::current_exception(); }
    });
    writer.join();
    if(failure) std::rethrow_exception(failure);
    require(document.scene()==newerScene && document.dirty(),"Worker export cannot mutate the document");
    const auto exported=loadScene(folder/"captured.ply");
    require(std::abs(shValue(exported.gaussians[0],0,0)-shValue(capturedScene->gaussians[0],0,0))<.002f,
            "Export writes captured content even after later edits");
    require(document.finishExport(completion) && document.dirty(),
            "Completing an older full export leaves newer content dirty");
    require(document.undo() && document.scene()==capturedScene && !document.dirty(),
            "Undo to the exported content becomes clean");
    require(document.redo() && document.scene()==newerScene && document.dirty(),
            "Redo away from exported content becomes dirty");
    document.edits()->selectSingle(0,SelectOperation::Set);
    auto partial=document.captureExport(folder/"selected.ply",ExportScope::Selected).run();
    require(!document.finishExport(partial) && document.dirty() &&
                loadScene(folder/"selected.ply").loadedCount()==1,
            "Selected export preserves the full-document save point");
    auto remainder=document.captureExport(folder/"remainder.ply",ExportScope::Remainder).run();
    require(!document.finishExport(remainder) && document.dirty() &&
                loadScene(folder/"remainder.ply").loadedCount()==5,
            "Remainder export preserves the full-document save point");
    const auto stale=document.captureProcessing(brightness(1.3f));
    document.edits()->selectNone();
    require(!document.apply(stale.run(),stale) && document.scene()==newerScene,
            "Selection revision invalidates a captured processing result");
    const auto obsolete=document.captureProcessing(brightness(1.4f));
    document.open(input); edit(document,1.05f);
    require(!document.apply(obsolete.run(),obsolete),"A previous document generation cannot commit processing");
    require(!document.finishExport(completion) && document.dirty(),
            "A previous document generation cannot mark the new document clean");
    const auto preserved=folder/"preserved.ply";
    { std::ofstream stream(preserved,std::ios::binary); stream<<"existing output"; }
    const auto cancelledExport=document.captureExport(preserved);
    std::stop_source cancelled; cancelled.request_stop();
    rejects([&] { cancelledExport.run(cancelled.get_token()); },"Cancelled export must fail");
    require(read(preserved)=="existing output" && document.dirty(),
            "Cancelled export preserves destination bytes and save point");
    const auto empty=fixture(); empty->gaussians.clear();
    Document emptyDocument; emptyDocument.replace(input,empty);
    rejects([&] { emptyDocument.captureExport(preserved).run(); },"Empty export must fail");
    require(read(preserved)=="existing output","Failed export preserves destination bytes");
    rejects([&] { document.captureExport(input).run(); },"Exports cannot replace the original source");
    const auto related=folder/"merge-input.ply";
    writeVisibleScene(*source,{},related,SceneExportFormat::Ply);
    const auto merge=document.captureProcessing({{"type","merge"},{"values",{{"path",pathUtf8(related)}}}});
    require(document.apply(merge.run(),merge),"Merge job commits its input dependencies");
    rejects([&] { document.captureExport(related).run(); },"Export cannot replace a related merge input");
    const auto hardlink=folder/"merge-alias.ply";
    std::error_code error; std::filesystem::remove(hardlink,error); error.clear();
    std::filesystem::create_hard_link(related,hardlink,error);
    require(!error,"Fixture filesystem must support hard-link alias checks");
    rejects([&] { document.captureExport(hardlink).run(); },"Export rejects physical aliases of related inputs");
    const auto lateAlias=folder/"late-alias.ply";
    std::filesystem::remove(lateAlias,error);
    const auto lateJob=document.captureExport(lateAlias);
    std::filesystem::create_hard_link(input,lateAlias);
    rejects([&] { lateJob.run(); },"Worker rechecks aliases introduced after capture");
    require(loadScene(input).loadedCount()==6,"Alias rejection preserves source content");
    // The independent saved default and current navigation camera both follow
    // alignment, while workers leave the live camera unchanged until apply.
    auto alignSource=fixture();
    Camera defaultCamera; defaultCamera.fit(*alignSource); defaultCamera.roll=.31f;
    alignSource->defaultView=defaultCamera.savedView();
    document.replace(input,alignSource);
    document.camera.orbit(17,-12); document.camera.roll=-.22f;
    const auto initialCamera=document.camera;
    const auto rotation=alignFromPoints({.1f,-.3f,0},{1,.4f,0},{0,.2f,1});
    const auto alignment=document.captureAlignment(matrixRecipe(rotation));
    const auto result=alignment.run();
    sameCamera(document.camera,initialCamera,"Alignment workers do not move the live camera");
    require(result.scene->defaultView==defaultCamera.transformed(rotation).savedView(),
            "Alignment transforms the independently saved default camera");
    document.camera.pan(4,-3); // Navigation is allowed while a job is running.
    const auto navigated=document.camera;
    require(document.apply(result,alignment),"Current alignment job commits");
    sameCamera(document.camera,navigated.transformed(rotation),
               "Alignment commit carries the latest navigation camera into aligned coordinates");
    require(document.undo() && document.scene()==alignSource,"Alignment undo restores original scene");
    sameCamera(document.camera,navigated,"Alignment undo carries the current camera back");
    require(document.redo(),"Alignment redo succeeds");
    sameCamera(document.camera,navigated.transformed(rotation),"Alignment redo restores aligned framing");
    document.reset();
    sameCamera(document.camera,navigated,"Document reset follows geometry back into the original frame");
    require(document.scene()==alignSource,"Document reset restores the original immutable scene");
    const auto beforeFailure=document.camera;
    rejects([&] { document.captureAlignment({{"type","transform"},{"values",{{"scale",{1,2,1}}}}}); },
            "Nonuniform alignment is rejected before work begins");
    rejects([&] { document.captureAlignment(brightness(1.2f)); },
            "Alignment must contain exactly one coordinate transform");
    sameCamera(document.camera,beforeFailure,"Rejected alignment preserves navigation camera");
    const auto cancelledAlignment=document.captureAlignment(matrixRecipe(rotation));
    rejects([&] { cancelledAlignment.run(cancelled.get_token()); },"Cancelled alignment has no completion");
    sameCamera(document.camera,beforeFailure,"Cancelled alignment leaves navigation camera unchanged");
}
