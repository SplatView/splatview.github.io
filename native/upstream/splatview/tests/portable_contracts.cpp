#include "portable_contracts.hpp"
#include "document.hpp"
#include "file_io.hpp"
#include "source_snapshot.hpp"
#include "file_preferences.hpp"
#include "atomic_file.hpp"
#include "image_io.hpp"
#include "software_renderer.hpp"
#include "language.hpp"
#include "tools_preferences.hpp"
#include <cmath>
#include <fstream>
#include <future>
#include <stdexcept>

namespace {
using namespace preview;
void require(bool test,const char *message) { if(!test) throw std::runtime_error(message); }
template<class F> void rejects(F action) { bool failed=false; try { action(); } catch(const std::exception &) { failed=true; } require(failed,"Invalid operation was accepted"); }
void write(const std::filesystem::path &p,const std::string &text) { std::ofstream out(p,std::ios::binary); out<<text; require(bool(out),"Write fixture"); }
std::string read(const std::filesystem::path &p) { FileSnapshot file(p,65536); return {file.bytes().begin(),file.bytes().end()}; }
std::shared_ptr<Scene> layers(float frontOpacity=.1f) {
    auto scene=std::make_shared<Scene>(); scene->yUp=true;
    Attributes a; a.scale={.2f,.2f,.2f}; a.opacity=.8f; a.sh[0]=a.sh[1]=-.5f/.2820947918f; a.sh[2]=.5f/.2820947918f;
    scene->gaussians.push_back(packGaussian(a));
    a.position.z=.3f; a.opacity=frontOpacity; a.sh[0]=.5f/.2820947918f; a.sh[1]=a.sh[2]=-.5f/.2820947918f;
    scene->gaussians.push_back(packGaussian(a)); fitBounds(*scene); return scene;
}
Camera camera() { Camera c; c.yUp=true; c.yaw=c.pitch=0; c.distance=4; return c; }
} // namespace
void platformContracts(const std::filesystem::path &directory) {
    using namespace preview;
    const std::string unicode="scene-\xc3\xa9-\xe6\x97\xa5-\xf0\x9f\x8c\x8d.ply";
    require(narrow(widen(unicode))==unicode,"UTF-8/wchar round trip on 16 and 32 bit wchar platforms");
    for(const std::string bad:{std::string("\xc0\xaf"),std::string("\xed\xa0\x80"),std::string("\xf4\x90\x80\x80"),std::string("\xe2\x82")}) rejects([&]{pathFromUtf8(bad);});
    rejects([&]{pathFromUtf8(std::string("a\0b",3));});
    const std::string abc="abc";
    require(contentKey({reinterpret_cast<const uint8_t *>(abc.data()),abc.size()})=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","SHA256 known vector");
    const auto file=directory/pathFromUtf8(unicode);
    std::filesystem::copy_file(directory/"demo.ply",file,std::filesystem::copy_options::overwrite_existing);
    auto scene=loadScene(file); auto c=camera();
    const auto prefsRoot=directory/"portable-preferences"; FilePreferences prefs(prefsRoot);
    Image image{8,4,AdmittedVector<uint8_t>(8*4*4,255)};
    for(size_t i=0;i<image.bgra.size();i+=4) { image.bgra[i]=30; image.bgra[i+1]=80; image.bgra[i+2]=210; }
    prefs.save(file,scene,c.savedView(),&image);
    require(prefs.view(file,scene.sourceContentKey)==c.savedView(),"Default camera persists");
    const auto thumb=prefs.thumbnail(file,scene.sourceContentKey);
    require(thumb && thumb->width==4 && thumb->height==4 && thumb->bgra[0]==30 && thumb->bgra[2]==210,"Square PNG preserves BGRA channels");
    {
        ResourceBudget cacheBudget(1024*1024);
        auto admitted=prefs.thumbnail(file,scene.sourceContentKey,{},cacheBudget);
        require(admitted && admitted->bgra==thumb->bgra &&
                cacheBudget.usage().categoryBytes[std::size_t(ResourceCategory::Image)]==admitted->bgra.capacity(),
                "Cached thumbnail retains its actual Image allocation after decoder release");
        const auto pixels=admitted->bgra.capacity();
        require(cacheBudget.usage().totalBytes==pixels && cacheBudget.usage().peakBytes>=2*pixels,
                "Cached result admits independent pixels while decoder owner overlaps");
        admitted.reset(); require(cacheBudget.usage().totalBytes==0,"Cached Image owner releases its final grant");
        ResourceLimits noImage; noImage.totalBytes=1024*1024;
        noImage.categoryBytes[std::size_t(ResourceCategory::Image)]=0;
        ResourceBudget deniedCache(noImage);
        require(!prefs.thumbnail(file,scene.sourceContentKey,{},deniedCache) && deniedCache.usage().totalBytes==0,
                "Denied cached image returns a miss without retaining Source or Work");
        std::stop_source stopped; stopped.request_stop();
        require(!prefs.thumbnail(file,scene.sourceContentKey,stopped.get_token(),cacheBudget) && cacheBudget.usage().totalBytes==0,
                "Precancelled cache lookup retains no payload and preserves its record");
    }
    const auto copy=file.parent_path()/"independent-copy.ply";
    std::filesystem::copy_file(file,copy,std::filesystem::copy_options::overwrite_existing);
    require(!prefs.view(copy,scene.sourceContentKey),"Copies have independent file preferences");
    // A fresh target avoids NTFS creation-time tunneling from a prior test run.
    const auto renamed=directory/("renamed-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".ply");
    std::filesystem::rename(file,renamed);
    require(prefs.view(renamed,scene.sourceContentKey).has_value(),"Rename preserves file preferences");
    auto update=[&](float yaw) { auto view=c.savedView(); view.yaw=yaw; prefs.save(renamed,scene,view); };
    auto writer=std::async(std::launch::async,[&]{update(.4f);}); update(.8f); writer.get();
    const auto view=prefs.view(renamed,scene.sourceContentKey);
    require(view && (view->yaw==.4f || view->yaw==.8f) && prefs.thumbnail(renamed,scene.sourceContentKey),"Concurrent camera updates remain atomic and retain thumbnail");
    write(renamed,"modified source"); rejects([&]{prefs.save(renamed,scene,c.savedView());});
    require(!prefs.view(renamed,sourceStamp(renamed).contentKey),"Changed source ignores stale camera");
    const auto destination=directory/"atomic.txt"; write(destination,"original");
    { AtomicFile abandoned(destination); write(abandoned.path(),"partial"); }
    require(read(destination)=="original","Abandoned output preserves destination");
    { AtomicFile committed(destination); write(committed.path(),"complete"); committed.commit(); }
    require(read(destination)=="complete","Atomic commit replaces destination");
    std::stop_source cancelled; cancelled.request_stop();
    rejects([&]{FileSnapshot snapshot(destination,65536,cancelled.get_token());}); rejects([&]{FileSnapshot snapshot(destination,2);});
    const auto folder=directory/"fingerprint-sog"; std::filesystem::create_directories(folder);
    write(folder/"meta.json",R"({"means":{"files":["lo.webp","hi.webp"]},"sh0":{"files":["color.webp"]}})");
    write(folder/"lo.webp","low"); write(folder/"hi.webp","high"); write(folder/"color.webp","color");
    const auto before=sourceStamp(folder); Scene loaded; loaded.sourceBytes=before.bytes; loaded.sourceContentKey=before.contentKey; loaded.sourceFileIdentity=before.identity;
    prefs.save(folder,loaded,c.savedView()); require(prefs.view(folder,before.contentKey).has_value(),"Unpacked SOG camera save");
    write(folder/"color.webp","other"); const auto after=sourceStamp(folder);
    require(after.contentKey!=before.contentKey && after.identity==before.identity,"Property texture changes invalidate unpacked SOG fingerprint");
    rejects([&]{prefs.save(folder,loaded,c.savedView());});
    write(folder/"meta.json",R"({"means":{"files":["../outside.webp"]}})"); rejects([&]{SourceSnapshot bad(folder);});
    const auto languagePath=directory/"test-language.json";
    LanguagePreferences language(languagePath,[]{return Language::Japanese;});
    require(language.set(Language::System) && language.effective()==Language::Japanese,"System language detection injection");
    require(language.set(Language::French) && LanguagePreferences(languagePath).selected()==Language::French,"Language preference persists");
    require(availableLanguages().size()==9 && std::string(translate(Language::Spanish,"Help"))=="Ayuda","Eight translated languages plus system");
    const auto toolsPath=directory/"test-tools.json"; ToolsPreferences tools(toolsPath);
    auto modeWriter=std::async(std::launch::async,[&]{return tools.saveMode(ToolsMode::Pro);});
    require(tools.finishTutorial() && modeWriter.get(),"Concurrent UI preference updates succeed");
    require(ToolsPreferences(toolsPath).mode()==ToolsMode::Pro && ToolsPreferences(toolsPath).tutorialSeen(),"Mode and tutorial preferences merge without lost updates");
    auto invalid=c.savedView(); invalid.distance=0; rejects([&]{encodeSavedView(invalid);});
    writeJpeg95(image,directory/"channels.jpg"); const auto jpeg=readImage(directory/"channels.jpg");
    require(jpeg.bgra[2]>190 && jpeg.bgra[0]<45,"JPEG95 output retains channels");
}
void renderContracts(const std::filesystem::path &directory) {
    using namespace preview;
    auto scene=layers(); auto c=camera(); SoftwareRenderer renderer; renderer.resize(65,65); renderer.setScene(scene);
    ViewSettings settings; settings.highlightSelection=false; renderer.draw(c,settings);
    const size_t center=(32*65+32)*4; const auto image=renderer.readback();
    require(std::abs(int(image.bgra[center+2])-27)<=2 && std::abs(int(image.bgra[center])-185)<=2,"Back-to-front premultiplied alpha matches analytic two-layer composite");
    require(renderer.pick(c,{32,32})==0,"Picking chooses greatest visible contribution through transparent foreground");
    auto map=renderer.selectionMap(c,true,true);
    require(map.ids[32*65+32]==1 && map.depths[32*65+32]>3.9f && map.depths[32*65+32]<4,"Surface depth is normalized alpha-weighted view depth");
    const auto stats=renderer.stats(); renderer.draw(c,settings);
    require(renderer.stats().rasterizations==stats.rasterizations && renderer.stats().cacheHits==1,"Idle software rendering reuses image");
    renderer.setStates(std::array<uint8_t,2>{2,0}); renderer.draw(c,settings);
    require(renderer.pick(c,{32,32})==1 && renderer.readback().bgra[center]<15,"Deleted splats are absent from pixels and picks");
    std::stop_source stop; stop.request_stop(); const auto last=renderer.readback().bgra;
    rejects([&]{renderer.draw(c,settings,stop.get_token());}); require(renderer.readback().bgra==last,"Cancellation preserves previous completed frame");
    renderer.resize(0,65); rejects([&]{renderer.draw(c);}); renderer.resize(65,65);
    renderer.setStates({}); renderer.setScene(layers(.99f));
    map=renderer.selectionMap(c,true,true); require(map.ids[32*65+32]==2,"Opaque foreground wins picking map");
    renderer.setScene(scene); renderer.draw(c,settings); writePng(renderer.readback(),directory/"software-layers.png");
    auto edit=std::make_shared<SceneEdits>(scene);
    require(edit->selectRectangle(c,65,65,{25,25,40,40},SelectOperation::Set) && edit->selectedCount()==2,"Portable rectangle selection projects scene centers");
    edit->beginSelectionDraft(); edit->selectNone(); require(edit->cancelSelectionDraft() && edit->selectedCount()==2,"Selection draft cancellation restores baseline");
    edit->selectNone(); const std::array<PointI,2> stroke{{{5,32},{60,32}}};
    require(edit->selectBrush(c,65,65,stroke,3,SelectOperation::Set) && edit->selectedCount()==2,"Continuous brush selects along stroke");
    edit->selectNone(); const std::array<PointI,3> polygon{{{20,20},{50,20},{32,50}}};
    require(edit->selectPolygon(c,65,65,polygon,SelectOperation::Set) && edit->selectedCount()==2,"Polygon selection");
    edit->selectNone(); const std::array<VolumeSample,1> volume{{{{0,0,.3f},.05f}}};
    require(edit->selectVolumeBrush(volume,SelectOperation::Set) && edit->selectedCount()==1,"World volume brush selection");
    settings.geometry[12]=.5f; const auto moved=prepareFrame(scene,{},c,65,65,settings);
    require(moved.splats.size()==2 && moved.splats.back().centerDepth[0]>42,"Row-vector geometry preview translation reaches projection");
}
void documentContracts(const std::filesystem::path &directory) {
    using namespace preview;
    Document document; document.open(directory/"demo.ply"); auto initial=document.scene();
    require(!document.dirty(),"Newly loaded document is clean"); document.edits()->selectSingle(0,SelectOperation::Set);
    require(!document.dirty(),"Selection alone does not dirty exportable content");
    auto generation=document.generation(),revision=document.revision();
    auto result=document.process({{"type","color"},{"values",{{"brightness",1.1}}}});
    document.edits()->selectNone(); require(!document.apply(result,generation,revision),"Stale processing result cannot overwrite newer selection");
    require(document.apply(result,generation,document.revision()) && document.dirty(),"Current processing result commits to history");
    document.exportScene(directory/"document-copy.ply"); require(!document.dirty(),"Successful full export records saved content revision");
    require(document.edits()->undo() && document.dirty(),"Undo away from save point marks content dirty");
    require(document.edits()->redo() && !document.dirty(),"Redo to save point becomes clean");
    rejects([&]{document.exportScene(document.path());});
    const auto current=document.scene(); rejects([&]{document.open(directory/"missing-file.ply");}); require(document.scene()==current,"Failed open retains current document");
    document.edits()->selectSingle(0,SelectOperation::Set); document.exportScene(directory/"document-selected.ply",ExportScope::Selected);
    require(loadScene(directory/"document-selected.ply").loadedCount()==1,"Selected-only export omits remainder");
    DocumentLoader loader; loader.request(directory/"missing-file.ply"); const auto latest=loader.request(directory/"demo.ply");
    std::optional<LoadResult> loaded; const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
    while(!loaded && std::chrono::steady_clock::now()<deadline) { loaded=loader.take(); if(!loaded) std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
    require(loaded && loaded->generation==latest && loaded->scene && loaded->error.empty(),"Coalesced async load publishes only latest request");
    loader.request(directory/"demo.ply"); loader.cancel(); std::this_thread::sleep_for(std::chrono::milliseconds(10)); require(!loader.take(),"Cancelled load publishes no result");
    const auto navigation=directory/"natural-order"; std::filesystem::create_directories(navigation);
    for(const char *name:{"scene10.ply","scene2.ply","scene1.ply","ignored.txt"}) write(navigation/name,"");
    const auto files=adjacentScenes(navigation/"scene2.ply");
    require(files.size()==3 && files[0].filename()=="scene1.ply" && files[1].filename()=="scene2.ply" && files[2].filename()=="scene10.ply","Adjacent files use natural numeric ordering and filter unsupported extensions");
}
