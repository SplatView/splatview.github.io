#include "history_admission_contracts.hpp"
#include "document.hpp"
#include "background_jobs.hpp"
#include <algorithm>
#include <chrono>
#include <future>
#include <optional>
#include <string_view>

namespace preview {
struct HistoryAdmissionTestAccess {
    static void failAt(SceneEdits &edits, const std::string_view *seam) {
        edits.historyCheckpointContext_ = const_cast<std::string_view *>(seam);
        edits.historyCheckpoint_ = seam ? +[](void *context, std::string_view current) {
            if (current == *static_cast<std::string_view *>(context)) throw std::bad_alloc();
        } : nullptr;
    }
    static std::size_t undoCount(const SceneEdits &edits) { return edits.undo_.size(); }
};
}
namespace {
using namespace preview;
constexpr std::size_t count = 257, allowance = 64 * 1024 * 1024;
void require(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
template<class Error = std::exception, class F> void rejects(F &&action, const char *message) {
    try { action(); } catch (const Error &) { return; }
    throw std::runtime_error(message);
}
std::shared_ptr<Scene> fixture(std::shared_ptr<SceneMemory> memory = {}) {
    auto scene = std::make_shared<Scene>(memory);
    scene->gaussians.resize(count);
    for (std::size_t i = 0; i < count; ++i) {
        Attributes value; value.position = {float(i) * .01f, 0, 0};
        value.scale = {.01f,.02f,.03f}; value.opacity = .7f;
        scene->gaussians[i] = packGaussian(value);
    }
    scene->sourceCount = count; fitBounds(*scene); return scene;
}
struct SwitchMemory final : SceneMemory {
    ResourceBudget budget{allowance};
    std::optional<std::size_t> denyBytes;
    bool denyAll{};
    std::size_t maskRequests{};
    std::shared_ptr<void> admit(std::size_t bytes) override {
        if (bytes == count) ++maskRequests;
        if (denyAll || (denyBytes && bytes == *denyBytes)) throw std::bad_alloc();
        return std::make_shared<ResourceReservation>(budget.reserve(ResourceCategory::History, bytes));
    }
};
void detachAndFailureAtomicity() {
    auto memory = std::make_shared<SwitchMemory>();
    {
        SceneEdits edits(fixture(), memory);
        auto old = edits.maskSnapshot();
        auto baseline = memory->budget.usage().totalBytes;
        const auto *initial = edits.states().data();
        memory->denyBytes = count;
        rejects<std::bad_alloc>([&] { edits.selectSingle(3, SelectOperation::Set); },
            "A shared mask must admit its detached payload before mutation");
        require(edits.states().data() == initial && edits.selectedCount() == 0 && edits.revision() == 0 &&
            !edits.canUndo() && !edits.canRedo() && memory->budget.usage().totalBytes == baseline,
            "Denied detach preserves exact owner, state, history and retained charge");
        memory->denyBytes.reset();
        require(edits.selectSingle(3, SelectOperation::Set) && edits.states().data() != initial &&
            old[3] == 0 && edits.states()[3] == 1, "Successful detach keeps issued bytes immutable");
        auto issued = edits.maskSnapshot();
        baseline = memory->budget.usage().totalBytes;
        const auto *current = edits.states().data();
        std::string_view seam = "history.append";
        HistoryAdmissionTestAccess::failAt(edits, &seam);
        rejects<std::bad_alloc>([&] { edits.selectSingle(5, SelectOperation::Set); },
            "Late history failure must unwind a prepared detached mask");
        require(edits.states().data() == current && edits.states()[3] == 1 && edits.states()[5] == 0 &&
            edits.revision() == 1 && HistoryAdmissionTestAccess::undoCount(edits) == 1 &&
            memory->budget.usage().totalBytes == baseline,
            "Late failure cannot install its COW owner or leave its additional mask/delta charged");
        HistoryAdmissionTestAccess::failAt(edits, nullptr);
        memory->denyBytes = count;
        rejects<std::bad_alloc>([&] { edits.undo(); }, "Delta Undo must prepare writable storage before navigation");
        require(edits.states().data() == current && edits.states()[3] == 1 && !edits.canRedo() &&
            memory->budget.usage().totalBytes == baseline, "Denied Undo preserves both stacks and issued mask");
        memory->denyBytes.reset();
        require(edits.undo() && edits.states()[3] == 0 && issued[3] == 1 && edits.canRedo(),
            "Undo detaches while its previous state remains issued");
        auto undone = edits.maskSnapshot();
        baseline = memory->budget.usage().totalBytes;
        memory->denyBytes = count;
        rejects<std::bad_alloc>([&] { edits.redo(); }, "Delta Redo must also admit before navigation");
        require(edits.states()[3] == 0 && edits.canRedo() && memory->budget.usage().totalBytes == baseline,
            "Denied Redo retains the retry and unwinds the candidate");
        memory->denyBytes.reset();
        require(edits.redo() && undone[3] == 0 && edits.states()[3] == 1, "Redo retry preserves old snapshots");
        edits.beginSelectionDraft();
        const auto *cancelBase = edits.selectionBaseline().data();
        baseline = memory->budget.usage().totalBytes;
        memory->denyBytes = count;
        rejects<std::bad_alloc>([&] { edits.selectSingle(9, SelectOperation::Set); },
            "Selection preview must detach from its cancel baseline");
        require(edits.selectionDraft() && edits.selectionBaseline().data() == cancelBase &&
            edits.states()[3] == 1 && memory->budget.usage().totalBytes == baseline,
            "Denied draft edit preserves cancellation baseline and retained bytes");
        memory->denyBytes.reset();
        require(edits.selectSingle(9, SelectOperation::Set), "Draft retry succeeds");
        memory->denyAll = true;
        require(edits.cancelSelectionDraft() && edits.states().data() == cancelBase && edits.states()[3] == 1,
            "Cancel restores the shared baseline without allocation even under zero headroom");
    }
    require(memory->budget.usage().totalBytes == 0, "All mask, delta, deque and issued owners finally release");
}
void fullHistoryAliasesAndTrimming() {
    auto memory = std::make_shared<SwitchMemory>();
    MaskStorage escaped;
    {
        auto scene = fixture(); SceneEdits edits(scene, memory);
        auto first = edits.maskSnapshot();
        const auto requests = memory->maskRequests;
        auto changed = std::make_shared<Scene>(*scene); changed->gaussians[0].positionOpacity[0] += 1;
        require(edits.replaceScene(changed, std::vector<uint8_t>(count)), "Full replacement creates history");
        auto second = edits.maskSnapshot();
        require(memory->maskRequests == requests + 1, "Full history aliases the before/after masks instead of copying twice");
        require(edits.undo() && edits.states().data() == first.data() && edits.redo() &&
            edits.states().data() == second.data() && memory->maskRequests == requests + 1,
            "Full Undo/Redo exchange immutable owners without another mask allocation");
        for (unsigned i = 0; i < 12; ++i) {
            auto next = std::make_shared<Scene>(*edits.scene());
            next->gaussians[0].positionOpacity[0] += 1;
            require(edits.replaceScene(next, std::vector<uint8_t>(count)), "History trim fixture commits");
        }
        require(HistoryAdmissionTestAccess::undoCount(edits) == 10 && first[0] == 0 && second[0] == 0,
            "Ten-entry trimming cannot invalidate separately retained physical masks");
        escaped = edits.maskSnapshot();
    }
    require(memory->budget.usage().totalBytes == count, "An escaped immutable mask retains only its own payload");
    memory.reset();
    require(escaped.size() == count && escaped[0] == 0, "Mask ownership outlives edits and service handles");
    escaped.clear();
}
void documentJobsAndQueuedOwnership() {
    ResourceBudget budget(allowance);
    auto scene = fixture(sceneMemoryForBudget(budget));
    std::optional<ProcessingSnapshot> processing;
    std::optional<ExportSnapshot> all, subset;
    MaskStorage original;
    {
        Document document; document.replace("history-admission-source.ply", scene, budget);
        document.edits()->selectSingle(1, SelectOperation::Set);
        original = document.maskSnapshot();
        const auto before = budget.usage().totalBytes;
        processing = document.captureProcessing({{"type","opacity"},{"values",{{"scale",1.f}}}});
        all = document.captureExport("history-admission-all.ply");
        require(budget.usage().totalBytes == before,
            "Compatible processing/full export snapshots share the admitted mask without another charge");
        subset = document.captureExport("history-admission-selected.ply", ExportScope::Selected);
        require(budget.usage().totalBytes == before + count,
            "Partial export owns one independent Work mask");
        document.edits()->selectSingle(2, SelectOperation::Set);
        const auto result = processing->run();
        require(result.states[1] == 1 && result.states[2] == 0 && original[1] == 1 &&
            sceneMemorySharesLedger(result.states.get_allocator().memory(), budget),
            "Captured jobs retain old immutable bytes and return a separately admitted mutable mask");
        ProcessingResult foreign; foreign.scene = document.scene(); foreign.states.resize(count);
        const auto saved = document.savePoint(); const auto revision = document.revision();
        rejects([&] { document.apply(std::move(foreign), document.generation(), revision); },
            "A budgeted document rejects an unadmitted result mask");
        require(document.savePoint() == saved && document.revision() == revision,
            "Foreign-mask rejection preserves owner identity and state");
    }
    processing.reset(); all.reset(); subset.reset(); scene.reset();
    require(budget.usage().totalBytes == count, "Detached document/worker destruction leaves only the escaped mask");
    BackgroundExecutor executor(1, 2);
    std::promise<void> started, release; auto released = release.get_future().share();
    struct Unblock {
        std::promise<void> *signal;
        ~Unblock() { if (signal) { try { signal->set_value(); } catch (...) {} } }
    } unblock{&release};
    auto active = executor.submit([&](std::stop_token) { started.set_value(); released.wait(); });
    require(started.get_future().wait_for(std::chrono::seconds(5)) == std::future_status::ready,
        "Held executor worker starts within the contract timeout");
    std::stop_source stop;
    auto queued = executor.submit([owner = original](std::stop_token) { return owner.size(); }, stop.get_token());
    original.clear(); stop.request_stop();
    require(budget.usage().totalBytes == count,
        "Stopping a queued job does not release a mask still retained by its callable");
    // A new enqueue purges the stopped queued closure even while the worker is held.
    auto next = executor.submit([](std::stop_token) {});
    const auto afterPurge = budget.usage().totalBytes;
    release.set_value(); unblock.signal = nullptr; active.get(); next.get();
    rejects<BackgroundJobCancelled>([&] { queued.get(); }, "Purged queue reports one cancellation");
    require(afterPurge == 0 && budget.usage().totalBytes == 0,
        "Actual queue purge destroys the final retained mask and releases its grant");
}
}
void historyAdmissionContracts() {
    detachAndFailureAtomicity(); fullHistoryAliasesAndTrimming(); documentJobsAndQueuedOwnership();
}
