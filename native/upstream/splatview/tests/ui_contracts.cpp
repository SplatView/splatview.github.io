#include "editor_ui.hpp"
#include "file_preferences.hpp"
#include "file_io.hpp"
#include "language.hpp"
#include <imgui.h>
#include <imgui_internal.h>
#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {
using namespace preview;
void require(bool test,const char *message) { if(!test) throw std::runtime_error(message); }
struct Context {
    Context() {
        IMGUI_CHECKVERSION(); ImGui::CreateContext(); auto &io=ImGui::GetIO();
        io.IniFilename=nullptr; io.DisplaySize={1280,850}; io.DeltaTime=1.f/60;
        unsigned char *pixels; int width,height; io.Fonts->GetTexDataAsRGBA32(&pixels,&width,&height);
        require(pixels && width>0 && height>0,"Headless font atlas");
    }
    ~Context() { ImGui::DestroyContext(); }
};
void frame(EditorUI &ui,Document &document,ViewSettings &settings,bool readOnly,bool busy) {
    const auto scene=document.scene(); const auto revision=document.revision(); const auto generation=document.generation();
    ImGui::NewFrame(); ui.draw(document,settings,readOnly,busy); ImGui::Render();
    auto data=ImGui::GetDrawData(); require(data && data->Valid && data->TotalVtxCount>0,"Editor produces draw lists without a graphics backend");
    require(document.scene()==scene && document.revision()==revision && document.generation()==generation,
        "Rendering editor panels without input preserves document state");
    require(ui.takeActions().empty(),"Passive editor frame queues no file or processing action");
}
std::vector<UiAction> actionFrame(EditorUI &ui,Document &document,ViewSettings &settings,
                                 const char *activate=nullptr,bool busy=false) {
    const auto scene=document.scene(); const auto revision=document.revision();
    if(activate) {
        const auto window=ImGui::FindWindowByName("Tools"); require(window!=nullptr,"Tools window exists for action test");
        ImGui::ActivateItemByID(window->GetID(uiLabel(activate).c_str()));
    }
    ImGui::NewFrame(); ui.draw(document,settings,false,busy); ImGui::Render();
    require(document.scene()==scene && document.revision()==revision,
            "UI draft/semantic actions never mutate committed scene, selection or history");
    return ui.takeActions();
}
void singleAction(const std::vector<UiAction> &actions,UiActionKind kind,const char *message) {
    require(actions.size()==1 && actions[0].kind==kind && actions[0].recipe.empty(),message);
}
}
int main(int argc,char **argv) {
    try {
        using namespace preview;
        const auto directory=argc>1?pathFromUtf8(argv[1]):std::filesystem::temp_directory_path()/"splatview-ui-contracts";
        std::filesystem::create_directories(directory); setPreferencesRoot(directory/"preferences");
        Context context; Document empty; ViewSettings settings;
        require(ToolsPreferences().saveMode(ToolsMode::Basic),"Persist Basic mode");
        EditorUI basic; frame(basic,empty,settings,false,false); frame(basic,empty,settings,true,false);
        auto scene=std::make_shared<Scene>(); scene->yUp=true; scene->sourceCount=1;
        Attributes attributes; scene->gaussians.push_back(packGaussian(attributes)); fitBounds(*scene);
        Document document; document.replace(directory/"sample.ply",scene); document.edits()->selectAll();
        frame(basic,document,settings,false,false); frame(basic,document,settings,false,true);
        require(ToolsPreferences().saveMode(ToolsMode::Pro),"Persist Pro mode"); EditorUI pro;
        for(const auto &language:availableLanguages()) {
            LanguageScope scope(language.language); frame(pro,document,settings,false,false); frame(pro,document,settings,true,true);
        }
        auto points=std::make_shared<Scene>(); points->type=SceneType::PointCloud;
        points->vertices={{{0,0,0},0xffabcdef}}; points->sourceCount=1; fitBounds(*points);
        Document readOnly; readOnly.replace(directory/"points.ply",points); frame(pro,readOnly,settings,false,false);
        frame(pro,readOnly,settings,true,false);
        pro.panelVisible=false; frame(pro,document,settings,false,false); pro.panelVisible=true;
        std::cout << "PASS headless Basic/Pro, empty/selected/read-only/busy frames and language changes\n";

        const Recipe pipeline{{"steps",Recipe::array({{{"type","color"},{"values",{{"brightness",1.1}}}}})}};
        pro.setRecipe(pipeline); require(pro.recipe()==pipeline,"Recipe editor preserves structured pipeline");
        pro.process(pro.recipe(),true); auto actions=pro.takeActions();
        require(actions.size()==1 && actions[0].kind==UiActionKind::Process && actions[0].recipe==pipeline && actions[0].selectedOnly,
            "Native action queue preserves recipe and selection scope");
        require(pro.takeActions().empty(),"Actions are consumed exactly once");
        bool rejected=false; try { pro.setRecipe(Recipe{{"text",std::string(40000,'x')}}); } catch(const std::exception &) { rejected=true; }
        require(rejected && pro.recipe()==pipeline,"Oversized recipe leaves the previous draft intact");
        pro.tool=SelectionTool::Measure; pro.picked({0,0,0}); pro.picked({3,4,0});
        require(pro.measurements.size()==1 && std::abs(pro.measurements[0].value-5)<1e-6f,"Picked points produce a distance measurement");
        const auto output=directory/"measurements.json"; writeMeasurements(pro.measurements,output);
        FileSnapshot snapshot(output,65536); auto json=Recipe::parse(snapshot.bytes().begin(),snapshot.bytes().end());
        require(json.at("version")==1 && json.at("measurements").size()==1 && json["measurements"][0]["value"]==5,
            "Measurement export retains value and schema");
        pro.clearMeasurements(); require(pro.measurements.empty(),"Scene change can clear measurements");
        std::cout << "PASS recipe action handoff, bounded drafts and measurement export\n";

        LanguageScope english(Language::English);
        Document drafts; drafts.replace(directory/"drafts.ply",scene); drafts.edits()->selectAll();
        EditorUI draftUi; ViewSettings draftSettings;
        auto values=neutralColor; values[0]=1.3f; drafts.previewColor(values,true);
        frame(draftUi,drafts,draftSettings,false,true);
        require(draftSettings.color==values && draftSettings.colorSelectedOnly && drafts.renderScene()==scene,
                "Busy editor projects controller color previews without submitting or clearing values");
        draftSettings.color=neutralColor;
        frame(draftUi,drafts,draftSettings,true,false);
        require(draftSettings.color==values,"Read-only early return still projects controller preview settings");
        draftUi.panelVisible=false; draftSettings.color=neutralColor;
        frame(draftUi,drafts,draftSettings,false,true); draftUi.panelVisible=true;
        require(draftSettings.color==values,"Hidden-tools early return still projects controller preview settings");
        auto idle=actionFrame(draftUi,drafts,draftSettings);
        singleAction(idle,UiActionKind::CommitColor,"An inactive completed color gesture queues one semantic commit");
        require(drafts.colorPending() && drafts.colorValues()==values && draftSettings.color==values,
                "Queuing color Apply does not clear a retryable draft or its rendered preview");
        require(actionFrame(draftUi,drafts,draftSettings).empty(),
                "Unchanged pending values do not create an endless auto-retry loop after failure/cancel");
        singleAction(actionFrame(draftUi,drafts,draftSettings,"Apply color"),UiActionKind::CommitColor,
                     "Explicit Apply retries the same draft without manufacturing a new recipe");
        const auto colorJob=*drafts.captureColor();
        require(drafts.apply(colorJob.run(),colorJob),"Test host applies captured color job");
        frame(draftUi,drafts,draftSettings,false,false);
        require(draftSettings.color==values && drafts.renderScene()==scene && drafts.scene()!=scene,
                "Successful host Apply retains absolute color controls and their fixed render base");
        const auto committed=drafts.scene();
        auto pending=values; pending[0]=1.6f; drafts.previewColor(pending,true);
        require(actionFrame(draftUi,drafts,draftSettings,"Cancel color").empty() &&
                    drafts.colorValues()==values && drafts.scene()==committed,
                "Cancel Color restores the applied preview without queuing or mutating committed content");
        auto resetActions=actionFrame(draftUi,drafts,draftSettings,"Reset color");
        if(resetActions.empty()) resetActions=actionFrame(draftUi,drafts,draftSettings);
        singleAction(resetActions,UiActionKind::CommitColor,"Reset Color submits a neutral absolute grade once");
        require(drafts.colorValues()==neutralColor && drafts.colorPending() && drafts.scene()==committed,
                "Reset previews the session base until its semantic commit succeeds");
        drafts.cancelColorDraft();
        const auto tools=ImGui::FindWindowByName("Tools");
        tools->StateStorage.SetBool(tools->GetID(uiLabel("Color").c_str()),false);
        actionFrame(draftUi,drafts,draftSettings);
        for(const auto &[label,kind]:std::array<std::pair<const char *,UiActionKind>,8>{{
                {"Undo",UiActionKind::Undo},{"Redo",UiActionKind::Redo},
                {"Select all",UiActionKind::SelectAll},{"Clear",UiActionKind::ClearSelection},
                {"Invert",UiActionKind::InvertSelection},{"Delete selected",UiActionKind::DeleteSelected},
                {"Keep selected",UiActionKind::KeepSelected},{"Restore deleted",UiActionKind::RestoreDeleted}}})
            singleAction(actionFrame(draftUi,drafts,draftSettings,label),kind,
                         "History/selection/cleanup buttons hand semantic commands to the host");
        tools->StateStorage.SetBool(tools->GetID(uiLabel("Cleanup").c_str()),false);
        actionFrame(draftUi,drafts,draftSettings);
        Matrix4 delta=identityMatrix; delta[12]=.4f; drafts.previewTransform(delta,true);
        frame(draftUi,drafts,draftSettings,false,true);
        singleAction(actionFrame(draftUi,drafts,draftSettings,"Apply handles"),UiActionKind::CommitTransform,
                     "Geometry Apply submits the controller's exact transient transform");
        require(drafts.transformValues()==delta && draftSettings.geometry==delta,
                "Queuing geometry Apply retains its preview until successful host publication");
        require(actionFrame(draftUi,drafts,draftSettings,"Cancel handles").empty() &&
                    !drafts.transformPending() && draftSettings.geometry==identityMatrix,
                "Cancel handles clears only transient controller geometry and projects identity immediately");
        auto align=actionFrame(draftUi,drafts,draftSettings,"Center");
        require(align.size()==1 && align[0].kind==UiActionKind::Align && align[0].selectedOnly &&
                    align[0].recipe.at("type")=="transform" && align[0].recipe.at("values").contains("matrix"),
                "Alignment tools emit explicit coordinate-transform actions rather than generic processing");
        auto numeric=actionFrame(draftUi,drafts,draftSettings,"Apply transform");
        require(numeric.size()==1 && numeric[0].kind==UiActionKind::Operation && numeric[0].group=="transform" &&
                    numeric[0].recipe.at("type")=="transform" && !drafts.transformPending(),
                "Numeric transform controls submit a fixed-base operation separately from gizmo deltas");
        auto resetNumeric=actionFrame(draftUi,drafts,draftSettings,"Reset transform");
        require(resetNumeric.size()==1 && resetNumeric[0].kind==UiActionKind::ResetOperation && resetNumeric[0].group=="transform",
                "Reset transform delegates exact baseline restoration to the controller");
        auto floor=actionFrame(draftUi,drafts,draftSettings,"Detect floor");
        require(floor.size()==1 && floor[0].kind==UiActionKind::DetectFloor && floor[0].recipe.empty() && floor[0].selectedOnly,
                "Detect floor delegates expensive plane analysis to an immutable worker job");
        const auto coordinate=drafts.captureAlignment({{"type","transform"},{"values",{{"translation",{.3f,.2f,.1f}}}}},true);
        require(drafts.apply(coordinate.run(),coordinate),"Test host commits a cumulative alignment group");
        drafts.previewTransform(delta,true);
        auto resetAlignment=actionFrame(draftUi,drafts,draftSettings,"Reset transform");
        require(resetAlignment.size()==1 && resetAlignment[0].kind==UiActionKind::ResetOperation &&
                    resetAlignment[0].group=="alignment" && !drafts.transformPending(),
                "Reset transform cancels unfinished handles and delegates the active alignment sequence baseline");
        const auto alignmentReset=drafts.captureOperationReset(resetAlignment[0].group);
        require(alignmentReset && drafts.apply(alignmentReset->run(),*alignmentReset),
                "The unchanged native ResetOperation route accepts an alignment group");
        drafts.previewTransform(delta,true); draftUi.cancelInteraction(drafts);
        require(!drafts.transformPending() && actionFrame(draftUi,drafts,draftSettings).empty(),
                "Focus-loss cancellation clears transient geometry without queuing a release commit");
        drafts.previewTransform(delta,true);
        ImGui::ActivateItemByID(tools->GetID(uiLabel("Apply handles").c_str()));
        ImGui::NewFrame(); draftUi.draw(drafts,draftSettings,false,false); ImGui::Render();
        draftUi.cancelInteraction(drafts);
        require(!drafts.transformPending() && draftUi.takeActions().empty() && drafts.activeOperation()=="alignment",
                "Focus cancellation removes an already-queued gizmo commit while retaining alignment Reset ownership");

        require(ToolsPreferences().saveMode(ToolsMode::Basic),"Persist Basic mode for Auto action contract");
        EditorUI automaticUi; Document automaticDocument; automaticDocument.replace(directory/"automatic.ply",scene);
        automaticDocument.edits()->selectAll(); automaticDocument.previewColor(values,true);
        tools->StateStorage.SetBool(tools->GetID(uiLabel("Color").c_str()),true);
        tools->StateStorage.SetBool(tools->GetID(uiLabel("Transform").c_str()),false);
        ViewSettings automaticSettings; frame(automaticUi,automaticDocument,automaticSettings,false,true);
        auto automatic=actionFrame(automaticUi,automaticDocument,automaticSettings,"Auto color");
        require(automatic.size()==1 && automatic[0].kind==UiActionKind::AutoColor && automatic[0].selectedOnly &&
                    automatic[0].recipe.at("values").at("method")=="enhance" && automaticDocument.colorValues()==values,
                "Auto color queues a fixed-base analysis action without generic processing or clearing manual values");
        const auto autoSnapshot=automaticDocument.captureAutoColor("enhance",true);
        require(actionFrame(automaticUi,automaticDocument,automaticSettings).empty(),
                "Failed/cancelled Auto admission does not silently auto-bake the retained manual draft next frame");
        require(automaticDocument.apply(autoSnapshot.run(),autoSnapshot),"Test host applies Auto color");
        frame(automaticUi,automaticDocument,automaticSettings,false,false);
        require(automaticSettings.color==automaticDocument.colorValues() && automaticDocument.renderScene()==scene,
                "Auto success updates absolute sliders while preserving the original rendering base");
        std::cout << "PASS controller previews, one-shot color Apply/retry/reset, semantic edit commands and geometry handoff\n";
        return 0;
    } catch(const std::exception &error) { std::cerr << "FAIL " << error.what() << '\n'; return 1; }
}
