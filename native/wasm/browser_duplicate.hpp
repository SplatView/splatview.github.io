#pragma once
#include "selection_checkpoint.hpp"
#include <array>
#include <stop_token>

// Adapted from SplatView v1.0.2 commit
// 4e1be155511fb49f08fd8c863d785ac008a4c43a, processScene Duplicate
// (src/processing.cpp:1140-1165) and Viewer::duplicateSelected
// (src/viewer.cpp:293-308). This browser job changes traversal/admission only.
namespace preview::browser_duplicate {
inline constexpr size_t sceneLimit=1'000'000, maximumStepWork=4096;
struct Range { size_t first{},count{}; };
// Immutable Scene identity gives edits and Undo/Redo the desktop marker lifetime.
// Stage a copy of this table in the existing publication transaction. Never
// evict retained history; all 64 occupied entries means refusal before commit.
class Lineage {
    struct Entry { std::weak_ptr<const Scene> scene;Range range; };
    std::array<Entry,64> entries_{};
  public:
    std::optional<Range> find(const std::shared_ptr<const Scene> &) const noexcept;
    bool associate(const std::shared_ptr<const Scene> &,Range) noexcept;
    void clear() noexcept { entries_={}; }
};
enum class Status { Working, Ready, Published, Cancelled, Failed };
enum class Phase { Count, Allocate, CopyOriginals, AppendCopies, Ready, Terminal };
// The caller creates this stable owner under its Work admission. No variable
// allocation or O(N) traversal occurs in construction. Source/mask are shared
// immutable owners. Even refusal scans are cooperative and allocate no payload.
class Job final {
  public:
    Job(const SceneEdits &,const Lineage &,std::shared_ptr<SceneMemory> work,
        std::shared_ptr<SceneMemory> history);
    Job(const Job &)=delete;
    Job &operator=(const Job &)=delete;
    Job(Job &&)=default;
    Job &operator=(Job &&)=default;
    Status step(size_t maximumWork=maximumStepWork,std::stop_token={});
    void cancel() noexcept;
    Status status() const noexcept { return status_; }
    size_t lastStepWork() const noexcept { return lastStepWork_; }
    size_t copiedCount() const noexcept { return copies_; }
    // Only a terminal native publication transaction may call this. Association
    // must be made on its staged Lineage; response/GPU failure rolls back both.
    bool publish(SceneEdits &,Lineage &stagedLineage);
  private:
    void action();
    BrowserSelectionCheckpoint baseline_;
    std::optional<Range> previous_;
    browser_view_scope::Scope scope_;
    std::shared_ptr<SceneMemory> work_,history_;
    std::shared_ptr<Scene> result_;
    MaskStorage states_;
    Status status_{Status::Working};
    Phase phase_{Phase::Count};
    size_t cursor_{},copies_{},deleted_{},selected_{},selectedInPrevious_{},lastStepWork_{};
};
} // namespace preview::browser_duplicate
