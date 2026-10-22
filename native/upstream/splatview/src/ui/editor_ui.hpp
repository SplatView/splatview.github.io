#pragma once
#include "document.hpp"
#include "tools_mode.hpp"
#include "geometry_tools.hpp"
#include "tools_preferences.hpp"
#include <array>

namespace preview {
enum class UiActionKind { Open, Previous, Next, ExportAll, ExportSelected, ExportRemainder, Capture, CopyImage, SaveView, Thumbnail,
    Fullscreen, Reference, Merge, SaveRecipe, OpenRecipe, SaveMeasurements, Process, Align, DetectFloor,
    CommitColor, AutoColor, CommitTransform, Operation, ResetOperation, Undo, Redo, DeleteSelected, KeepSelected, RestoreDeleted,
    SelectAll, InvertSelection, ClearSelection, PreviewSelection, ConfirmSelection, CancelSelection };
// Process/Align/PreviewSelection/AutoColor carry a recipe and scope. Operation
// also carries group (transform/opacity); ResetOperation carries only group
// (transform/opacity/alignment), with Reset transform choosing the active group.
// Draft commit and
// selection/history actions carry no edit data: the host captures controller
// state after settling its command boundary.
struct UiAction { UiActionKind kind; Recipe recipe; bool selectedOnly{}; std::string group{}; };
enum class SelectionTool { Navigate, Single, Rectangle, Brush, Polygon, Volume, Measure };
struct Measurement { std::vector<Vec3> points; float value{}; bool angle{}; };
// Shared ImGui presentation compiles on Windows/Linux. Native hosts supply file
// dialogs, clipboard and background jobs by consuming actions after each frame.
class EditorUI {
  public:
    EditorUI();
    void draw(Document &,ViewSettings &,bool readOnly=false,bool busy=false);
    std::vector<UiAction> takeActions() { auto out=std::move(actions_); actions_.clear(); return out; }
    void process(const Recipe &,bool selectedOnly=false);
    void setReference(std::filesystem::path path) { reference_=std::move(path); }
    void setRecipe(const Recipe &);
    Recipe recipe() const;
    void picked(Vec3);
    void clearMeasurements() { measurements.clear(); points_.clear(); }
    void cancelInteraction(Document &); // Focus/capture loss cancels a gizmo, never commits it.
    SelectionTool tool{SelectionTool::Navigate};
    SelectOperation operation{SelectOperation::Set};
    SelectionOptions selectionOptions;
    float brushRadius{20};
    bool fly{},autoRotate{},software{},panelVisible{true};
    float panelWidth{330};
    std::string status;
    std::vector<Measurement> measurements;
  private:
    void button(const char *,UiActionKind);
    void queue(UiActionKind);
    void transformTools(Document &,bool selectedOnly);
    void commitIdleColor(Document &,bool readOnly,bool busy);
    void synchronizeOperations(Document &,bool busy);
    std::vector<UiAction> actions_;
    std::filesystem::path reference_;
    std::array<char,32768> recipeText_{};
    ToolsMode mode_{ToolsMode::Basic};
    std::array<float,3> translation_{},rotation_{},scale_{1,1,1};
    std::array<float,3> filterCenter_{};
    float filterRadius_{1},distance_{1};
    std::vector<Vec3> points_;
    int measurementType_{},tutorial_{-1};
    bool gizmo_{};
    bool gizmoUsing_{},autoColorQueued_{};
    const Document *draftOwner_{};
    uint64_t draftGeneration_{},queuedColorRevision_{};
    std::weak_ptr<const Scene> controlsScene_;
    uint64_t controlsRevision_{};
    std::string controlsOperation_;
    bool controlsInitialized_{};
    float opacity_{1};
    int automaticChoice_{};
    int gizmoOperation_{};
    ToolsPreferences preferences_;
    std::array<char,4096> filterText_{};
};
void writeMeasurements(const std::vector<Measurement> &,const std::filesystem::path &);
} // namespace preview
