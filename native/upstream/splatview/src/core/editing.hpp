#pragma once
#include "admitted_storage.hpp"
#include "mask_storage.hpp"
#include "render_types.hpp"
#include <filesystem>
#include <span>
#include <stop_token>
#include <deque>
#include <optional>
#include <functional>
#include <string_view>

namespace preview {
enum class SelectOperation { Set, Add, Remove, Intersect };
struct SelectionOptions {
    bool visibleOnly{}, overlap{};
};
struct VolumeSample {
    Vec3 center;
    float radius{};
};
class SelectionMask;
// Bit 1 is selected; bit 2 is deleted. Defaults select centers through all depths.
class SceneEdits {
  public:
    explicit SceneEdits(std::shared_ptr<const Scene> scene, std::shared_ptr<SceneMemory> history = {});
    SceneEdits(std::shared_ptr<const Scene>, std::shared_ptr<SceneMemory> history,
               std::shared_ptr<SceneMemory> scratch);
    std::span<const uint8_t> states() const { return states_; }
    MaskStorage maskSnapshot() const noexcept { return states_; }
    size_t selectedCount() const { return selected_; }
    size_t visibleCount() const { return states_.size() - deleted_; }
    bool canUndo() const { return !undo_.empty(); }
    bool canRedo() const { return !redo_.empty(); }
    uint64_t revision() const { return revision_; }
    // Selection changes do not modify an exported scene. Undo/Redo restore this
    // identity so returning to the last saved content becomes clean again.
    uint64_t contentRevision() const { return contentRevision_; }
    bool selectRectangle(const Camera &, unsigned width, unsigned height, RectI, SelectOperation,
                         SelectionOptions = {}, const SelectionMap * = nullptr);
    bool selectBrush(const Camera &, unsigned width, unsigned height, std::span<const PointI>, float radius,
                     SelectOperation, SelectionOptions = {}, const SelectionMap * = nullptr);
    bool selectPolygon(const Camera &, unsigned width, unsigned height, std::span<const PointI>,
                       SelectOperation, SelectionOptions = {}, const SelectionMap * = nullptr);
    bool selectVolumeBrush(std::span<const VolumeSample>, SelectOperation, SelectionOptions = {},
                           const SelectionMap * = nullptr);
    bool selectSingle(std::optional<uint32_t> index, SelectOperation);
    bool selectAll();
    bool selectNone();
    bool invertSelection();
    bool deleteSelected();
    bool keepSelected();
    bool restoreDeleted();
    bool resetCleanup();
    void beginSelectionDraft();
    bool confirmSelectionDraft();
    bool cancelSelectionDraft() noexcept;
    bool selectionDraft() const { return draftStates_.has_value(); }
    std::span<const uint8_t> selectionBaseline() const {
        return draftStates_ ? draftStates_->span() : states();
    }
    bool undo();
    bool redo();
    std::shared_ptr<const Scene> scene() const { return scene_; }
    // Retains the last ten snapshots; immutable scene data is shared between revisions.
    bool replaceScene(std::shared_ptr<const Scene>, std::span<const uint8_t> states);
    std::optional<Scene> focusBounds() const;
    std::optional<Vec3> pickCenter(const Camera &, unsigned width, unsigned height, PointI) const;

  private:
    friend class Document;
    friend struct SceneEditsCaptureTestAccess;
    friend struct HistoryAdmissionTestAccess;
    void (*historyCheckpoint_)(void *,std::string_view){};
    void *historyCheckpointContext_{};
    void historyCheckpoint(std::string_view) const;
    struct Change {
        uint32_t index;
        uint8_t before, after;
    };
    using Changes = AdmittedVector<Change>;
    struct Revision {
        Changes changes;
        std::shared_ptr<const Scene> before, after;
        MaskStorage beforeStates, afterStates;
        uint64_t beforeContent{}, afterContent{};
    };
    std::optional<Revision> stageSelectionDraft(uint64_t &nextContent) const;
    void appendHistory(Revision &,std::optional<Revision> &);
    std::shared_ptr<const Scene> historyScene(bool forward) const noexcept;
    bool commit(Changes changes);
    bool selectRegion(const Camera &, unsigned width, unsigned height, SelectOperation,
                      const std::function<bool(float, float)> &contains);
    bool selectMatches(SelectOperation, const std::function<bool(size_t)> &);
    bool selectMask(const Camera &, unsigned, unsigned, const SelectionMask &, SelectOperation,
                    SelectionOptions, const SelectionMap *);
    void apply(const Changes &, bool forward) noexcept;
    void applyHistory(const Revision &,bool,MaskStorage &) noexcept;
    void recount() noexcept;
    void trimHistory() noexcept;
    std::shared_ptr<SceneMemory> historyMemory_;
    std::shared_ptr<SceneMemory> scratchMemory_;
    std::shared_ptr<const Scene> scene_;
    MaskStorage states_;
    std::optional<MaskStorage> draftStates_;
    std::deque<Revision, AdmittedAllocator<Revision>> undo_, redo_;
    size_t selected_{}, deleted_{};
    uint64_t revision_{};
    uint64_t contentRevision_{}, nextContentRevision_{};
};
// Writes a new standard Gaussian PLY in RDF coordinates, reconstructing scales/rotation from covariance.
// Exports the loaded preview and SH0..SH3, with deleted Gaussians omitted.
struct ExportAxes {
    std::array<float, 3> logScales;
    std::array<float, 4> quaternion; // RDF coordinates, w,x,y,z
};
ExportAxes exportAxesRdf(const Gaussian &);
void writeVisiblePly(const Scene &, std::span<const uint8_t> states, const std::filesystem::path &,
                     std::stop_token stop = {});
} // namespace preview
