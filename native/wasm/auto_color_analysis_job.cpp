#include "auto_color_analysis_job.hpp"
#include <new>
#include <stdexcept>
#include <utility>

namespace preview::browser_auto_color {
namespace {
bool valid(const AnalysisSnapshot &snapshot) noexcept {
    const auto &key = snapshot.key;
    return snapshot.settled && snapshot.base && snapshot.base->isGaussian() &&
        snapshot.base->gaussians.size() <= sceneLimit &&
        snapshot.base->gaussians.size() == snapshot.states.size() &&
        key.documentId && key.sourceGeneration && key.colorSessionId && key.colorBaseId && key.requestGeneration;
}
}
AnalysisOwner::Pointer AnalysisOwner::create(AnalysisSnapshot baseline, std::shared_ptr<SceneMemory> memory) {
    if (!memory) throw std::invalid_argument("Auto color analysis requires an admission service");
    if (!valid(baseline)) throw std::invalid_argument("Auto color analysis requires a settled Gaussian baseline");
    AdmittedAllocator<AnalysisOwner> allocator{memory};
    auto *owner = allocator.allocate(1);
    try { ::new (static_cast<void *>(owner)) AnalysisOwner(std::move(baseline), std::move(memory)); }
    catch (...) { allocator.deallocate(owner, 1); throw; }
    return Pointer(owner, Deleter{allocator.memory()});
}
AnalysisOwner::AnalysisOwner(AnalysisSnapshot baseline, std::shared_ptr<SceneMemory> memory)
    : baseline_(std::move(baseline)), scratch_(std::move(memory), scratchRequirements(baseline_.states.size())) {
    algorithm_.emplace(std::span<const Gaussian>{baseline_.base->gaussians}, baseline_.states.span(),
                       baseline_.key.selectedOnly, scratch_.spans());
    if (!algorithm_->pending()) status_ = AnalysisStatus::Failed;
}
size_t AnalysisOwner::payloadBytes(size_t sceneCount) noexcept {
    return sizeof(AnalysisOwner) + scratchRequirements(sceneCount).payloadBytes;
}
void AnalysisOwner::Deleter::operator()(AnalysisOwner *owner) noexcept {
    if (owner) {
        AdmittedAllocator<AnalysisOwner> allocator{memory};
        std::destroy_at(owner);
        allocator.deallocate(owner, 1);
    }
}
void AnalysisOwner::retire(Pointer &owner) noexcept {
    if (owner) owner->cancel();
    owner.reset(); owner.get_deleter().memory.reset();
}
bool AnalysisOwner::current(const AnalysisSnapshot &now) const noexcept {
    return now.settled && now.key == baseline_.key && now.base == baseline_.base &&
        now.states.data() == baseline_.states.data() && now.states.size() == baseline_.states.size();
}
size_t AnalysisOwner::step(size_t maximumWork, const AnalysisSnapshot &now) noexcept {
    if (!pending()) return 0;
    if (!current(now)) {
        algorithm_->cancel(); status_ = AnalysisStatus::Stale; return 0;
    }
    const auto consumed = algorithm_->step(maximumWork);
    if (algorithm_->phase() == Phase::Failed) status_ = AnalysisStatus::Failed;
    else if (const auto *computed = algorithm_->result()) {
        // Constant-size result packing. No scene/mask/history writes occur.
        completed_.emplace(AnalysisResult{baseline_.key, computed->suggestions,
            static_cast<uint32_t>(computed->eligible), static_cast<uint32_t>(computed->samples),
            static_cast<uint32_t>(computed->trimmed),
            {computed->p001, computed->p01, computed->p99, computed->p999}});
        status_ = AnalysisStatus::Complete;
    }
    return consumed;
}
void AnalysisOwner::cancel() noexcept {
    algorithm_->cancel(); completed_.reset(); status_ = AnalysisStatus::Cancelled;
}
const AnalysisResult *AnalysisOwner::result(const AnalysisSnapshot &now) const noexcept {
    return status_ == AnalysisStatus::Complete && completed_ && current(now) ? &*completed_ : nullptr;
}
std::optional<std::array<float, 3>> AnalysisOwner::sourceDc(size_t index) const noexcept {
    if (index >= baseline_.base->gaussians.size()) return {};
    const auto &g = baseline_.base->gaussians[index];
    return std::array<float, 3>{shValue(g, 0, 0), shValue(g, 0, 1), shValue(g, 0, 2)};
}
double AnalysisOwner::progress() const noexcept {
    if (status_ == AnalysisStatus::Complete) return 1;
    const auto n = baseline_.states.size(), s = scratchRequirements(n).samples;
    return double(algorithm_->workDone()) / double(3 * n + 8 * s + 3607);
}
} // namespace preview::browser_auto_color
