#include "editor_ui.hpp"
#include "file_io.hpp"
#include "atomic_file.hpp"
#include "language.hpp"
#include "tutorial.hpp"
#include <imgui.h>
#include <ImGuizmo.h>
#include <algorithm>
#include <cstring>
#include <fstream>

namespace preview {
namespace {
bool button(const char *text) { return ImGui::Button(uiLabel(text).c_str()); }
bool section(const char *text) { return ImGui::CollapsingHeader(uiLabel(text).c_str(),ImGuiTreeNodeFlags_DefaultOpen); }
bool checkbox(const char *text,bool *value) { return ImGui::Checkbox(uiLabel(text).c_str(),value); }
} // namespace
EditorUI::EditorUI() { mode_=preferences_.mode(); if(!preferences_.tutorialSeen()) tutorial_=0; }
void EditorUI::queue(UiActionKind kind) {
    if(std::none_of(actions_.begin(),actions_.end(),[&](const UiAction &action) { return action.kind==kind; }))
        actions_.push_back({kind,{},false});
}
void EditorUI::button(const char *text,UiActionKind action) { if(preview::button(text)) queue(action); }
void EditorUI::process(const Recipe &recipe,bool selectedOnly) { actions_.push_back({UiActionKind::Process,recipe,selectedOnly}); }
void EditorUI::setRecipe(const Recipe &recipe) {
    const auto text=recipe.dump(2); if(text.size()>=recipeText_.size()) throw std::runtime_error("Recipe exceeds editor capacity");
    std::fill(recipeText_.begin(),recipeText_.end(),0); std::copy(text.begin(),text.end(),recipeText_.begin());
}
Recipe EditorUI::recipe() const { return Recipe::parse(recipeText_.data()); }
void EditorUI::picked(Vec3 point) {
    points_.push_back(point);
    if(tool!=SelectionTool::Measure) return;
    const unsigned needed=measurementType_==1?3:2;
    if(points_.size()>=needed) {
        const float value=needed==3?pointAngle(points_[0],points_[1],points_[2]):pointDistance(points_[0],points_[1]);
        measurements.push_back({points_,value,needed==3}); points_.clear();
    }
}
void EditorUI::transformTools(Document &document,bool selectedOnly) {
    bool changed=ImGui::InputFloat3("Translation",translation_.data());
    bool finished=ImGui::IsItemDeactivatedAfterEdit();
    changed=ImGui::InputFloat3("Rotation (degrees)",rotation_.data()) || changed;
    finished=ImGui::IsItemDeactivatedAfterEdit() || finished;
    changed=ImGui::InputFloat3("Scale",scale_.data()) || changed;
    finished=ImGui::IsItemDeactivatedAfterEdit() || finished;
    (void)changed;
    if(preview::button("Apply transform") || finished)
        actions_.push_back({UiActionKind::Operation,{{"type","transform"},{"values",{{"translation",translation_},{"euler",rotation_},{"scale",scale_}}}},selectedOnly,"transform"});
    ImGui::SameLine(); if(preview::button("Reset transform")) {
        cancelInteraction(document);
        actions_.push_back({UiActionKind::ResetOperation,{},false,document.activeOperation()=="alignment"?"alignment":"transform"});
    }
    if(preview::button("Center")) {
        const auto bounds=selectedOnly?document.edits()->focusBounds():std::optional<Scene>{};
        actions_.push_back({UiActionKind::Align,matrixRecipe(centerAtPoint(bounds?bounds->center:document.scene()->center)),selectedOnly});
    }
    ImGui::SameLine(); if(preview::button("Normalize")) process({{"type","normalize"}},selectedOnly);
    if(preview::button("Detect floor")) {
        actions_.push_back({UiActionKind::DetectFloor,{},selectedOnly});
    }
    ImGui::TextWrapped("Pick centers using Measure, then calibrate from two or three points.");
    if(preview::button("Use picked center") && !points_.empty()) actions_.push_back({UiActionKind::Align,matrixRecipe(centerAtPoint(points_.back())),selectedOnly});
    ImGui::InputFloat("Target distance",&distance_);
    if(preview::button("Scale from two points") && measurements.size()) {
        const auto &p=measurements.back().points; if(p.size()>=2) actions_.push_back({UiActionKind::Align,matrixRecipe(scaleFromPoints(p[0],p[1],distance_)),selectedOnly});
    }
    if(preview::button("Align from three points") && measurements.size()) {
        const auto &p=measurements.back().points; if(p.size()==3) actions_.push_back({UiActionKind::Align,matrixRecipe(alignFromPoints(p[0],p[1],p[2])),selectedOnly});
    }
}
void EditorUI::commitIdleColor(Document &document,bool readOnly,bool busy) {
    if(std::any_of(actions_.begin(),actions_.end(),[](const UiAction &action) { return action.kind==UiActionKind::AutoColor; })) return;
    if(!readOnly && !busy && document.edits() && document.colorPending() && !ImGui::IsAnyItemActive() &&
       queuedColorRevision_!=document.draftRevision()) {
        queue(UiActionKind::CommitColor); queuedColorRevision_=document.draftRevision();
    }
}
void EditorUI::synchronizeOperations(Document &document,bool busy) {
    if(busy) return;
    const auto operation=std::string(document.activeOperation());
    if(!controlsInitialized_ || controlsScene_.lock()!=document.scene() || controlsRevision_!=document.revision() || controlsOperation_!=operation) {
        translation_={}; rotation_={}; scale_={1,1,1}; opacity_=1;
        const auto &recipe=document.operationRecipe();
        if(!recipe.empty() && (operation=="transform" || operation=="opacity")) {
            const auto steps=resolveRecipe(recipe);
            if(steps.size()==1) {
                const auto values=steps[0].value("values",Recipe::object());
                if(operation=="transform") {
                    translation_=values.value("translation",translation_); rotation_=values.value("euler",rotation_); scale_=values.value("scale",scale_);
                } else opacity_=values.value("scale",1.f);
            }
        }
        controlsScene_=document.scene(); controlsRevision_=document.revision(); controlsOperation_=operation; controlsInitialized_=true;
    }
}
void EditorUI::cancelInteraction(Document &document) {
    document.cancelTransformDraft(); gizmoUsing_=false;
    std::erase_if(actions_,[](const UiAction &action) { return action.kind==UiActionKind::CommitTransform; });
    // Numeric fields represent accepted/failed absolute sessions, not a gizmo
    // delta. Restore them from the controller if focus was lost mid-input.
    controlsInitialized_=false; synchronizeOperations(document,false);
}
void EditorUI::draw(Document &document,ViewSettings &settings,bool readOnly,bool busy) {
    if(draftOwner_!=&document || draftGeneration_!=document.generation()) {
        draftOwner_=&document; draftGeneration_=document.generation(); queuedColorRevision_=0;
        gizmoUsing_=autoColorQueued_=false; automaticChoice_=0; controlsInitialized_=false;
    }
    if(autoColorQueued_) { queuedColorRevision_=document.draftRevision(); autoColorQueued_=false; }
    synchronizeOperations(document,busy);
    settings=document.previewSettings(settings);
    const auto &io=ImGui::GetIO();
    ImGui::SetNextWindowPos({0,0}); ImGui::SetNextWindowSize({io.DisplaySize.x,44});
    ImGui::Begin("Toolbar",nullptr,ImGuiWindowFlags_NoDecoration|ImGuiWindowFlags_NoMove|ImGuiWindowFlags_NoSavedSettings);
    if(!readOnly) { button("Open",UiActionKind::Open); ImGui::SameLine(); button("Previous",UiActionKind::Previous); ImGui::SameLine(); button("Next",UiActionKind::Next); ImGui::SameLine(); button("Save",UiActionKind::ExportAll); ImGui::SameLine(); }
    button("Capture",UiActionKind::Capture); ImGui::SameLine(); button("Copy",UiActionKind::CopyImage); ImGui::SameLine();
    button("Save default view",UiActionKind::SaveView); ImGui::SameLine(); button("Update Thumbnail",UiActionKind::Thumbnail); ImGui::SameLine();
    checkbox("Look",&fly); ImGui::SameLine(); checkbox("Auto rotate",&autoRotate); ImGui::SameLine();
    if(preview::button("Reset view") && document.ready()) document.camera.fit(*document.scene());
    ImGui::SameLine(); button("Fullscreen",UiActionKind::Fullscreen);
    if(!readOnly) { ImGui::SameLine(); checkbox("Tools",&panelVisible); }
    ImGui::End();
    if(readOnly || !panelVisible) { commitIdleColor(document,readOnly,busy); return; }
    ImGui::SetNextWindowPos({0,44}); ImGui::SetNextWindowSize({panelWidth,std::max(1.f,io.DisplaySize.y-44)});
    ImGui::Begin("Tools",nullptr,ImGuiWindowFlags_NoMove|ImGuiWindowFlags_NoResize|ImGuiWindowFlags_NoCollapse|ImGuiWindowFlags_NoSavedSettings);
    if(!status.empty()) ImGui::TextWrapped("%s",status.c_str());
    if(document.ready()) {
        ImGui::TextWrapped("%s",pathUtf8(document.path().filename()).c_str());
        ImGui::Text("%zu / %llu",document.scene()->loadedCount(),static_cast<unsigned long long>(document.scene()->sourceCount));
        ImGui::TextUnformatted(document.dirty()?"Unsaved changes":"Saved");
    }
    int mode=int(mode_); ImGui::RadioButton(uiLabel("Basic").c_str(),&mode,0); ImGui::SameLine(); ImGui::RadioButton(uiLabel("Pro").c_str(),&mode,1);
    if(mode!=int(mode_) && preferences_.saveMode(ToolsMode(mode))) {
        mode_=ToolsMode(mode);
        if(mode_==ToolsMode::Basic) { document.cancelTransformDraft(); gizmo_=gizmoUsing_=false; }
    }
    ImGui::SliderFloat(uiLabel("Field of view").c_str(),&document.camera.fieldOfView,10,120,"%.0f"); checkbox("Flip up",&document.camera.yUp);
    checkbox("Software rendering",&software);
    auto edits=document.edits();
    if(!edits && document.ready()) ImGui::TextWrapped("PLY points and meshes are view only.");
    ImGui::BeginDisabled(!edits || busy);
    const bool selectedOnly=edits && edits->selectedCount()>0;
    if(edits) ImGui::Text("%zu selected, %zu visible",edits->selectedCount(),edits->visibleCount());
    button("Undo",UiActionKind::Undo); ImGui::SameLine(); button("Redo",UiActionKind::Redo);
    if(section("Color")) {
        auto values=document.colorValues(); bool changed=false;
        for(size_t i=0;i<values.size();++i) if(mode_==ToolsMode::Pro || basicColorField(i))
            changed=ImGui::SliderFloat(uiLabel(colorFields[i].label).c_str(),&values[i],colorFields[i].low,colorFields[i].high,"%.2f") || changed;
        if(changed) {
            try { document.previewColor(values,selectedOnly); }
            catch(const std::exception &error) { status=error.what(); }
        }
        if(preview::button("Apply color")) {
            queue(UiActionKind::CommitColor); queuedColorRevision_=document.draftRevision();
        }
        ImGui::SameLine(); if(preview::button("Reset color")) {
            if(document.activeOperation()=="opacity") actions_.push_back({UiActionKind::ResetOperation,{},false,"opacity"});
            document.resetColor();
        }
        ImGui::SameLine(); if(preview::button("Cancel color")) document.cancelColorDraft();
        const char *automaticNames[]{"Enhance","Exposure","Contrast","White balance"};
        const char *automaticMethods[]{"enhance","exposure","contrast","white_balance"};
        ImGui::Combo("Automatic adjustment",&automaticChoice_,automaticNames,4);
        if(preview::button("Auto color")) {
            actions_.push_back({UiActionKind::AutoColor,{{"type","auto"},{"values",{{"method",automaticMethods[automaticChoice_]}}}},selectedOnly});
            autoColorQueued_=true; queuedColorRevision_=document.draftRevision();
        }
        if(mode_==ToolsMode::Pro) {
            ImGui::SliderFloat("Fade / boost",&opacity_,0,5,"%.2f");
            const bool finished=ImGui::IsItemDeactivatedAfterEdit();
            if(preview::button("Apply opacity") || finished)
                actions_.push_back({UiActionKind::Operation,{{"type","opacity"},{"values",{{"scale",opacity_}}}},selectedOnly,"opacity"});
            ImGui::SameLine(); if(preview::button("Reset opacity")) actions_.push_back({UiActionKind::ResetOperation,{},false,"opacity"});
        }
        const auto &presets=editingPresets();
        if(presets.contains("color") && ImGui::BeginCombo("Preset","Choose")) {
            for(const auto &[name,value]:presets.at("color").items()) if(ImGui::Selectable(name.c_str())) {
                auto preset=neutralColor;
                for(size_t i=0;i<preset.size();++i) if(value.contains(colorFields[i].name)) preset[i]=value.at(colorFields[i].name).get<float>();
                try { document.previewColor(preset,selectedOnly); }
                catch(const std::exception &error) { status=error.what(); }
            }
            ImGui::EndCombo();
        }
        if(mode_==ToolsMode::Pro) {
            button("Choose reference",UiActionKind::Reference);
            if(!reference_.empty()) ImGui::TextWrapped("%s",pathUtf8(reference_.filename()).c_str());
            if(preview::button("Match reference")) process({{"type","match"},{"values",{{"path",pathUtf8(reference_)}}}},selectedOnly);
            ImGui::SameLine(); if(preview::button("Learn reference")) process({{"type","learn"},{"values",{{"path",pathUtf8(reference_)}}}},selectedOnly);
        }
    }
    if(section("Cleanup")) {
        int toolValue=int(tool); const char *names[]{"Navigate","Single","Box","Brush","Polygon","Volume brush","Measure"};
        if(ImGui::Combo("Tool",&toolValue,names,mode_==ToolsMode::Pro?7:4)) tool=SelectionTool(toolValue);
        int op=int(operation); ImGui::Combo("Operation",&op,"Set\0Add\0Remove\0Intersect\0"); operation=SelectOperation(op);
        checkbox("Visible only",&selectionOptions.visibleOnly); checkbox("Include edges",&selectionOptions.overlap);
        ImGui::SliderFloat("Brush radius",&brushRadius,1,200,"%.0f px");
        if(tool==SelectionTool::Volume) ImGui::TextWrapped("Volume radius follows brush size at the visible surface depth.");
        button("Select all",UiActionKind::SelectAll); ImGui::SameLine(); button("Clear",UiActionKind::ClearSelection);
        button("Invert",UiActionKind::InvertSelection);
        button("Delete selected",UiActionKind::DeleteSelected); ImGui::SameLine(); button("Keep selected",UiActionKind::KeepSelected);
        button("Restore deleted",UiActionKind::RestoreDeleted);
        if(mode_==ToolsMode::Pro) {
            ImGui::InputFloat3("Sphere center",filterCenter_.data()); ImGui::InputFloat("Sphere radius",&filterRadius_);
            if(preview::button("Preview sphere") && edits) {
                actions_.push_back({UiActionKind::PreviewSelection,{{"type","filter"},{"action","select"},{"values",{{"sphere_center",filterCenter_},{"sphere_radius",filterRadius_}}}},false});
            }
            if(!filterText_[0]) std::strcpy(filterText_.data(),"{\"and\":[{\"min_opacity\":0.1},{\"sphere_center\":[0,0,0],\"sphere_radius\":1}]}");
            ImGui::InputTextMultiline("Combined filter",filterText_.data(),filterText_.size(),{-1,100});
            if(preview::button("Preview combined filter") && edits) {
                try { auto values=Recipe::parse(filterText_.data()); actions_.push_back({UiActionKind::PreviewSelection,{{"type","filter"},{"action","select"},{"values",values}},false}); }
                catch(const std::exception &e) { status=e.what(); }
            }
            if(edits && edits->selectionDraft()) {
                button("Confirm selection",UiActionKind::ConfirmSelection);
                ImGui::SameLine(); button("Cancel selection",UiActionKind::CancelSelection);
            }
            if(preview::button("Deduplicate")) process({{"type","deduplicate"}},selectedOnly);
        }
    }
    if(mode_==ToolsMode::Pro && section("Transform")) {
        transformTools(document,selectedOnly);
        checkbox("Show transform handles",&gizmo_);
        ImGui::Combo("Handles",&gizmoOperation_,"Move\0Rotate\0Scale\0");
        if(preview::button("Apply handles")) queue(UiActionKind::CommitTransform);
        ImGui::SameLine(); if(preview::button("Cancel handles")) { document.cancelTransformDraft(); gizmoUsing_=false; }
    }
    if(mode_==ToolsMode::Pro && section("Compose and export")) {
        button("Merge scene",UiActionKind::Merge); button("Export selected",UiActionKind::ExportSelected); button("Export remainder",UiActionKind::ExportRemainder);
    }
    if(mode_==ToolsMode::Pro && section("Recipes")) {
        if(!recipeText_[0]) setRecipe({{"steps",Recipe::array({{{"type","color"},{"values",{{"brightness",1}}}}})}});
        ImGui::InputTextMultiline("##recipe",recipeText_.data(),recipeText_.size(),{-1,180});
        if(preview::button("Apply recipe")) { try { process(recipe(),selectedOnly); } catch(const std::exception &e) { status=e.what(); } }
        button("Open recipe",UiActionKind::OpenRecipe); ImGui::SameLine(); button("Save recipe",UiActionKind::SaveRecipe);
    }
    ImGui::EndDisabled();
    if(mode_==ToolsMode::Pro && section("Measurements")) {
        ImGui::Combo("Measure",&measurementType_,"Distance\0Angle\0");
        if(preview::button("Pick points")) { tool=SelectionTool::Measure; points_.clear(); }
        for(const auto &m:measurements) ImGui::Text("%.5g %s",m.value,m.angle?"degrees":"scene units");
        button("Export measurements",UiActionKind::SaveMeasurements); if(preview::button("Clear measurements")) clearMeasurements();
    }
    if(section("Preferences")) {
        const auto languages=availableLanguages(); int selected=int(languagePreferences().selected());
        if(ImGui::BeginCombo("Language",languages[selected].name)) {
            for(size_t i=0;i<languages.size();++i) if(ImGui::Selectable(languages[i].name,int(i)==selected)) languagePreferences().set(languages[i].language);
            ImGui::EndCombo();
        }
        if(preview::button("Tutorial")) tutorial_=0;
        ImGui::TextWrapped("Usage statistics and crash reports: off.");
    }
    if(tutorial_>=0) {
        const auto &step=tutorialSteps[size_t(tutorial_)]; ImGui::Separator(); ImGui::TextWrapped("%s",tr(step.title)); ImGui::TextWrapped("%s",tr(step.text));
        if(preview::button("Next")) { ++tutorial_; if(tutorial_>=int(tutorialSteps.size())) { tutorial_=-1; preferences_.finishTutorial(); } }
        ImGui::SameLine(); if(preview::button("Close tutorial")) { tutorial_=-1; preferences_.finishTutorial(); }
    }
    ImGui::End();
    if(gizmo_ && document.ready() && edits && !busy && !document.colorPending()) {
        ImGuizmo::BeginFrame(); ImGuizmo::SetDrawlist(ImGui::GetForegroundDrawList());
        const float width=std::max(1.f,io.DisplaySize.x-panelWidth),height=std::max(1.f,io.DisplaySize.y-44);
        ImGuizmo::SetRect(panelWidth,44,width,height);
        DirectX::XMFLOAT4X4 view,projection;
        DirectX::XMStoreFloat4x4(&view,document.camera.view()); DirectX::XMStoreFloat4x4(&projection,document.camera.projection(width/height));
        const ImGuizmo::OPERATION operations[]{ImGuizmo::TRANSLATE,ImGuizmo::ROTATE,ImGuizmo::SCALE};
        auto matrix=document.transformValues();
        if(ImGuizmo::Manipulate(&view._11,&projection._11,operations[gizmoOperation_],ImGuizmo::WORLD,matrix.data()))
            document.previewTransform(matrix,selectedOnly);
        const bool usingGizmo=ImGuizmo::IsUsing();
        if(gizmoUsing_ && !usingGizmo && document.transformPending()) queue(UiActionKind::CommitTransform);
        gizmoUsing_=usingGizmo;
    } else if(!gizmo_ && gizmoUsing_) {
        document.cancelTransformDraft(); gizmoUsing_=false;
    }
    settings=document.previewSettings(settings);
    commitIdleColor(document,readOnly,busy);
}
void writeMeasurements(const std::vector<Measurement> &measurements,const std::filesystem::path &path) {
    Recipe items=Recipe::array();
    for(const auto &m:measurements) {
        Recipe points=Recipe::array(); for(auto p:m.points) points.push_back({p.x,p.y,p.z});
        items.push_back({{"type",m.angle?"angle":"distance"},{"value",m.value},{"points",points}});
    }
    AtomicFile file(path); std::ofstream out(file.path(),std::ios::binary); out << Recipe{{"version",1},{"measurements",items}}.dump(2); out.close();
    if(!out) throw std::runtime_error("Cannot export measurements");
    file.commit();
}
} // namespace preview
