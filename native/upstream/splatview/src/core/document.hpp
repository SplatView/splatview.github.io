#pragma once
#include "editing.hpp"
#include "processing.hpp"
#include "scene_exports.hpp"
#include "geometry_tools.hpp"
#include <condition_variable>
#include <functional>
#include <mutex>
#include <thread>
#include <string_view>

namespace preview {
enum class ExportScope { All, Selected, Remainder };
struct DocumentSavePoint {
    uint64_t sourceGeneration{}, contentRevision{};
    uint64_t documentIdentity{}; // Process-local owner; never serialized as file metadata.
    bool operator==(const DocumentSavePoint &) const = default;
};
class Document;
// Capture these on the UI thread, then pass a copy to a worker. Jobs own their
// recipe/mask/input list and retain immutable scene data; run never touches a Document.
class ProcessingSnapshot {
  public:
    ProcessingResult run(std::stop_token = {}) const;
    uint64_t generation() const { return generation_; }
    uint64_t revision() const { return revision_; }
    bool colorJob() const { return draft_==Draft::Color || draft_==Draft::AutoColor; }
  private:
    friend class Document;
    enum class Draft { None, Color, AutoColor, Transform, Operation, Alignment, OperationReset };
    std::shared_ptr<const Scene> scene_;
    MaskStorage states_;
    Recipe recipe_;
    bool selectedOnly_{};
    std::optional<AlignmentView> alignmentView_;
    uint64_t generation_{}, revision_{}, documentIdentity_{};
    uint64_t draftRevision_{};
    Draft draft_{Draft::None};
    std::optional<ColorValues> automaticColor_;
    std::string operationGroup_;
    std::optional<FloorOptions> floorOptions_;
    std::optional<Camera> floorDefaultCamera_;
    std::optional<ResourceBudget> resources_;
};
struct ExportCompletion {
    DocumentSavePoint savePoint;
    ExportScope scope{ExportScope::All};
    std::filesystem::path output;
};
class ExportSnapshot {
  public:
    ExportCompletion run(std::stop_token = {}) const;
    DocumentSavePoint savePoint() const { return savePoint_; }
  private:
    friend class Document;
    std::shared_ptr<const Scene> scene_;
    MaskStorage states_;
    std::vector<std::filesystem::path> inputs_;
    std::filesystem::path output_;
    SceneExportFormat format_{};
    ExportScope scope_{ExportScope::All};
    DocumentSavePoint savePoint_;
    std::optional<ResourceBudget> resources_;
};
SceneExportFormat exportFormatForPath(const std::filesystem::path &);
void rejectOutputAliases(const std::filesystem::path &output,std::span<const std::filesystem::path> inputs,
                         std::stop_token = {},std::optional<ResourceBudget> = {});
// Accessed by the UI thread. Expensive jobs receive immutable scene snapshots;
// their result is accepted only if the document's revision still matches.
class Document {
  public:
    using SavePoint = DocumentSavePoint;
    Document();
    Document(const Document &)=delete;
    Document &operator=(const Document &)=delete;
    Document(Document &&)=delete;
    Document &operator=(Document &&)=delete;
    void open(const std::filesystem::path &,LoadOptions = {});
    // Already decoded payloads must belong to resources when one is supplied.
    // A loader supplies its worker-captured member paths; replacement does no I/O.
    void replace(const std::filesystem::path &,std::shared_ptr<const Scene>,
                 std::optional<ResourceBudget> = {},std::vector<std::filesystem::path> sourceMembers = {});
    bool ready() const { return bool(scene()); }
    std::shared_ptr<const Scene> scene() const { return edits_ ? edits_->scene() : original_; }
    SceneEdits *edits() { return edits_.get(); }
    const SceneEdits *edits() const { return edits_.get(); }
    std::span<const uint8_t> states() const { return edits_ ? edits_->states() : std::span<const uint8_t>{}; }
    MaskStorage maskSnapshot() const { return edits_ ? edits_->maskSnapshot() : MaskStorage{}; }
    const std::filesystem::path &path() const { return path_; }
    // Copy these on the owner thread when capturing image/output jobs; workers
    // recheck all original and merged inputs before publishing a destination.
    std::span<const std::filesystem::path> inputPaths() const { return inputPaths_; }
    uint64_t generation() const { return generation_; }
    uint64_t revision() const { return edits_ ? edits_->revision() : 0; }
    bool dirty() const { return edits_ && (edits_->contentRevision()!=savedRevision_ || colorPending()); }
    SavePoint savePoint() const { return {generation_, edits_ ? edits_->contentRevision() : 0, identity_}; }
    bool markSaved(SavePoint);
    // Color values are absolute relative to a fixed session base, including
    // after a successful bake. Geometry is a transient incremental preview.
    void previewColor(const ColorValues &,bool selectedOnly=false);
    const ColorValues &colorValues() const { return color_; }
    bool colorPending() const { return colorBase_ && color_!=appliedColor_; }
    void resetColor();
    void cancelColorDraft();
    void endColorSession(); // Requires a settled color draft; never runs a worker.
    void previewTransform(const Matrix4 &,bool selectedOnly=false);
    const Matrix4 &transformValues() const { return geometry_; }
    bool transformPending() const { return geometry_!=identityMatrix; }
    bool hasPendingDrafts() const { return colorPending() || transformPending(); }
    void cancelTransformDraft();
    std::shared_ptr<const Scene> renderScene() const { return colorBase_ ? colorBase_ : scene(); }
    std::span<const uint8_t> renderStates() const { return states(); }
    ViewSettings previewSettings(ViewSettings = {}) const;
    uint64_t draftRevision() const { return draftRevision_; }
    std::optional<ProcessingSnapshot> captureColor() const;
    ProcessingSnapshot captureAutoColor(const std::string &method,bool selectedOnly=false);
    std::optional<ProcessingSnapshot> captureTransform() const;
    // Numeric controls repeat an absolute operation from their first scene and
    // mask. Gizmo previews above remain incremental against committed geometry.
    ProcessingSnapshot captureOperation(const Recipe &,std::string_view group,bool selectedOnly=false);
    std::optional<ProcessingSnapshot> captureOperationReset(std::string_view group) const;
    std::string_view activeOperation() const;
    const Recipe &operationRecipe() const { return operationRecipe_; }
    void endOperationSession() noexcept;
    // Hosts may run captured jobs asynchronously. These synchronous helpers
    // are for noninteractive callers; failure/cancellation leaves drafts retryable.
    void flushColor(std::stop_token = {});
    void flushDrafts(std::stop_token = {});
    ProcessingSnapshot captureProcessing(const Recipe &,bool selectedOnly=false) const;
    // Alignment steps are cumulative against current geometry, retaining the
    // sequence's original scene/mask/default view for Reset("alignment").
    ProcessingSnapshot captureAlignment(const Recipe &,bool selectedOnly=false);
    ProcessingSnapshot captureFloorAlignment(FloorOptions = {},bool selectedOnly=false);
    ProcessingResult process(const Recipe &,bool selectedOnly=false,std::stop_token = {});
    // True means a current result was accepted, including an unchanged scene/mask.
    bool apply(ProcessingResult,uint64_t expectedGeneration,uint64_t expectedRevision);
    bool apply(ProcessingResult,const ProcessingSnapshot &);
    bool current(const ProcessingSnapshot &) const;
    ExportSnapshot captureExport(const std::filesystem::path &,ExportScope=ExportScope::All) const;
    bool finishExport(const ExportCompletion &);
    void exportScene(const std::filesystem::path &,ExportScope=ExportScope::All,std::stop_token = {});
    bool undo();
    bool redo();
    void reset();
    Camera camera;
  private:
    // Tests inject bad_alloc immediately before ordinary allocating copies.
    // Per-owner and unset in production; it cannot affect a different document
    // or replace the real allocation/exception behavior of those copies.
    friend struct DocumentCaptureTestAccess;
    void (*captureCheckpoint_)(void *,std::string_view){};
    void *captureCheckpointContext_{};
    void captureCheckpoint(std::string_view) const;
    struct StagedOperation {
        bool startsSession{};
        std::shared_ptr<const Scene> base;
        MaskStorage states;
        std::string group;
        bool selectedOnly{};
    };
    Camera cameraForScene(const Scene &) const;
    ProcessingSnapshot snapshot(const Recipe &,bool selectedOnly) const;
    ProcessingSnapshot snapshot(const Recipe &,bool,std::shared_ptr<const Scene>,const MaskStorage &) const;
    bool applyResult(ProcessingResult,uint64_t expectedGeneration,uint64_t expectedRevision);
    StagedOperation stageOperationSession(std::string_view,bool selectedOnly) const;
    void commitOperationSession(StagedOperation &) noexcept;
    void clearColorSession() noexcept;
    void clearDrafts() noexcept;
    const uint64_t identity_;
    std::filesystem::path path_;
    std::shared_ptr<const Scene> original_;
    std::vector<std::filesystem::path> inputPaths_;
    std::optional<ResourceBudget> resources_;
    std::unique_ptr<SceneEdits> edits_;
    uint64_t generation_{},savedRevision_{};
    std::shared_ptr<const Scene> colorBase_;
    ColorValues color_{neutralColor},appliedColor_{neutralColor};
    Matrix4 geometry_{identityMatrix};
    bool colorSelectedOnly_{},geometrySelectedOnly_{};
    uint64_t draftRevision_{},colorEditRevision_{},geometryEditRevision_{};
    std::shared_ptr<const Scene> operationBase_,operationResult_;
    MaskStorage operationStates_;
    std::string operationGroup_;
    Recipe operationRecipe_;
    uint64_t operationRevision_{};
    bool operationSelectedOnly_{};
};
struct LoadResult {
    uint64_t generation{};
    std::filesystem::path path;
    std::shared_ptr<const Scene> scene;
    std::string error;
    std::vector<std::filesystem::path> sourceMembers;
};
class BackgroundExecutor;
// One submitted draining job per loader; idle loaders occupy no pool worker.
// Navigation cancels active work and coalesces pending paths. Destruction cancels
// without joining; workers retain their own state, never this loader or a Document.
class DocumentLoader {
  public:
    using LoadFunction = std::function<Scene(const std::filesystem::path &,LoadOptions)>;
    using SourceLoadFunction = std::function<LoadedScene(const std::filesystem::path &,LoadOptions)>;
    DocumentLoader();
    // The executor must outlive admitted work. Injected functions must own their
    // worker inputs and must not capture Document, UI or loader pointers.
    // With options.resources, they must admit output vectors through that
    // ledger before allocation, as loadScene does. Delivery checks the returned
    // storage's ledger; it cannot certify earlier temporary allocations.
    explicit DocumentLoader(BackgroundExecutor &,LoadFunction = {});
    // Real unpacked-SOG acquisition must return paths from its actual decode
    // snapshot. The legacy Scene-only callback cannot supply that provenance.
    DocumentLoader(BackgroundExecutor &,SourceLoadFunction);
    ~DocumentLoader();
    DocumentLoader(const DocumentLoader &)=delete;
    DocumentLoader &operator=(const DocumentLoader &)=delete;
    DocumentLoader(DocumentLoader &&)=delete;
    DocumentLoader &operator=(DocumentLoader &&)=delete;
    // Executor admission failure throws synchronously and leaves this loader
    // idle and reusable. A rejected request still consumes its generation.
    uint64_t request(std::filesystem::path,LoadOptions = {});
    void cancel();
    std::optional<LoadResult> take();
    bool busy() const;
  private:
    struct State;
    static void work(const std::shared_ptr<State> &,std::stop_token);
    std::shared_ptr<State> state_;
    BackgroundExecutor &executor_;
};
std::vector<std::filesystem::path> adjacentScenes(const std::filesystem::path &);
} // namespace preview
