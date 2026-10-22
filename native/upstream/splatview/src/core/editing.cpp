#include "editing.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace preview {
using namespace DirectX;
namespace {
struct Projector {
    XMFLOAT4X4 matrix;
    unsigned width, height;
    Projector(const Camera &camera, unsigned w, unsigned h) : width(w), height(h) {
        XMStoreFloat4x4(&matrix, camera.view() * camera.projection(float(w) / std::max(1u, h)));
    }
    std::optional<XMFLOAT3> operator()(const Gaussian &g) const {
        const auto &p = g.positionOpacity;
        const auto &m = matrix;
        float w = p[0] * m._14 + p[1] * m._24 + p[2] * m._34 + m._44;
        float z = p[0] * m._13 + p[1] * m._23 + p[2] * m._33 + m._43;
        if (w <= 0 || z < 0 || z > w)
            return {};
        float x = (p[0] * m._11 + p[1] * m._21 + p[2] * m._31 + m._41) / w;
        float y = (p[0] * m._12 + p[1] * m._22 + p[2] * m._32 + m._42) / w;
        return XMFLOAT3{(x + 1) * width * 0.5f, (1 - y) * height * 0.5f, w};
    }
};
void covarianceAxes(const Gaussian &g, float scale[3], float rotation[3][3]) {
    // Jacobi eigendecomposition of the symmetric covariance, directly in output RDF coordinates.
    double a[3][3] = {{g.covA[0], -g.covA[1], -g.covA[2]},
                      {-g.covA[1], g.covA[3], g.covB[0]},
                      {-g.covA[2], g.covB[0], g.covB[1]}};
    double v[3][3] = {{1, 0, 0}, {0, 1, 0}, {0, 0, 1}};
    for (int iteration = 0; iteration < 24; ++iteration) {
        int p = 0, q = 1;
        for (int i = 0; i < 3; ++i)
            for (int j = i + 1; j < 3; ++j)
                if (std::abs(a[i][j]) > std::abs(a[p][q])) {
                    p = i;
                    q = j;
                }
        if (std::abs(a[p][q]) <= 1e-14 * std::max({std::abs(a[0][0]), std::abs(a[1][1]), std::abs(a[2][2])}))
            break;
        double angle = 0.5 * std::atan2(2 * a[p][q], a[q][q] - a[p][p]);
        double c = std::cos(angle), s = std::sin(angle);
        double app = a[p][p], aqq = a[q][q], apq = a[p][q];
        for (int k = 0; k < 3; ++k) {
            if (k == p || k == q)
                continue;
            double x = a[k][p], y = a[k][q];
            a[k][p] = a[p][k] = c * x - s * y;
            a[k][q] = a[q][k] = s * x + c * y;
        }
        a[p][p] = c * c * app - 2 * s * c * apq + s * s * aqq;
        a[q][q] = s * s * app + 2 * s * c * apq + c * c * aqq;
        a[p][q] = a[q][p] = 0;
        for (int k = 0; k < 3; ++k) {
            double x = v[k][p], y = v[k][q];
            v[k][p] = c * x - s * y;
            v[k][q] = s * x + c * y;
        }
    }
    double determinant = v[0][0] * (v[1][1] * v[2][2] - v[1][2] * v[2][1]) -
                         v[0][1] * (v[1][0] * v[2][2] - v[1][2] * v[2][0]) +
                         v[0][2] * (v[1][0] * v[2][1] - v[1][1] * v[2][0]);
    for (int i = 0; i < 3; ++i) {
        // Positive tiny eigenvalues carry real geometry. Only clamp at the
        // float covariance's representable minimum, including rounded rank loss.
        scale[i] = static_cast<float>(
            .5 * std::log(std::max(a[i][i], double(std::numeric_limits<float>::denorm_min()))));
        for (int j = 0; j < 3; ++j)
            rotation[j][i] = static_cast<float>(v[j][i] * (i == 2 && determinant < 0 ? -1 : 1));
    }
}
} // namespace
ExportAxes exportAxesRdf(const Gaussian &g) {
    ExportAxes result;
    float rotation[3][3];
    covarianceAxes(g, result.logScales.data(), rotation);
    // DirectX uses row vectors; the eigensystem stores axes as columns.
    XMMATRIX matrix =
        XMMatrixSet(rotation[0][0], rotation[1][0], rotation[2][0], 0, rotation[0][1], rotation[1][1],
                    rotation[2][1], 0, rotation[0][2], rotation[1][2], rotation[2][2], 0, 0, 0, 0, 1);
    XMFLOAT4 q;
    XMStoreFloat4(&q, XMQuaternionNormalize(XMQuaternionRotationMatrix(matrix)));
    result.quaternion = {q.w, q.x, q.y, q.z};
    return result;
}
SceneEdits::SceneEdits(std::shared_ptr<const Scene> scene, std::shared_ptr<SceneMemory> history)
    : SceneEdits(std::move(scene),std::move(history),{}) {}
SceneEdits::SceneEdits(std::shared_ptr<const Scene> scene, std::shared_ptr<SceneMemory> history,
                       std::shared_ptr<SceneMemory> scratch)
    : historyMemory_(std::move(history)), scratchMemory_(std::move(scratch)), scene_(std::move(scene)),
      undo_(AdmittedAllocator<Revision>{historyMemory_}), redo_(AdmittedAllocator<Revision>{historyMemory_}) {
    if (!scene_ || !scene_->isGaussian() || scene_->gaussians.size() > 10'000'000)
        throw std::runtime_error("Invalid scene for cleanup");
    states_ = MaskStorage::zero(scene_->gaussians.size(), historyMemory_);
}
void SceneEdits::historyCheckpoint(std::string_view seam) const {
    if(historyCheckpoint_) historyCheckpoint_(historyCheckpointContext_,seam);
}
void SceneEdits::apply(const Changes &changes, bool forward) noexcept {
    auto writable = states_.writableSpan();
    for (const auto &change : changes) {
        auto before = writable[change.index], after = forward ? change.after : change.before;
        selected_ -= (before & 1) != 0;
        deleted_ -= (before & 2) != 0;
        selected_ += (after & 1) != 0;
        deleted_ += (after & 2) != 0;
        writable[change.index] = after;
    }
}
void SceneEdits::trimHistory() noexcept {
    while (undo_.size() > 10) {
        undo_.pop_front();
    }
}
bool SceneEdits::commit(Changes changes) {
    if (changes.empty())
        return false;
    // Detachment is only a candidate until every history allocation succeeds.
    // A failed append must not replace the live owner or retain another mask.
    auto writable = states_.copyForWriteIfShared();
    if (draftStates_) {
        const bool selectionOnly = std::all_of(changes.begin(), changes.end(), [](const Change &change) {
            return ((change.before ^ change.after) & 2) == 0;
        });
        if (selectionOnly) {
            if (writable.hasStorage()) states_.swap(writable);
            apply(changes, true);
            ++revision_;
            return true;
        }
    }
    auto nextContent=nextContentRevision_;
    auto draft=stageSelectionDraft(nextContent);
    const auto beforeContent=draft ? draft->afterContent : contentRevision_;
    const bool modifiesContent = std::any_of(changes.begin(), changes.end(), [](const Change &change) {
        return ((change.before ^ change.after) & 2) != 0;
    });
    const auto next=modifiesContent ? ++nextContent : beforeContent;
    Revision revision{std::move(changes),{},{},{},{},beforeContent,next};
    const bool confirmed=bool(draft);
    appendHistory(revision,draft);
    // All potentially allocating work is complete. Keep the live selection
    // draft, old redo stack and content identities untouched until this point.
    draftStates_.reset();
    redo_.clear();
    if (writable.hasStorage()) states_.swap(writable);
    apply(undo_.back().changes, true);
    nextContentRevision_=nextContent;
    contentRevision_ = next;
    trimHistory();
    revision_+=1+unsigned(confirmed);
    return true;
}
void SceneEdits::beginSelectionDraft() {
    if (!draftStates_) {
        historyCheckpoint("draft.baseline");
        draftStates_ = states_;
    }
}
std::optional<SceneEdits::Revision> SceneEdits::stageSelectionDraft(uint64_t &nextContent) const {
    if(!draftStates_) return {};
    historyCheckpoint("draft.changes");
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if ((*draftStates_)[i] != states_[i])
            changes.push_back({uint32_t(i), (*draftStates_)[i], states_[i]});
    if(changes.empty()) return {};
    const bool content=std::any_of(changes.begin(),changes.end(),[](const Change &change) {
        return ((change.before^change.after)&2)!=0;
    });
    return Revision{std::move(changes),{},{},{},{},contentRevision_,content ? ++nextContent : contentRevision_};
}
void SceneEdits::appendHistory(Revision &revision,std::optional<Revision> &draft) {
    static_assert(std::is_nothrow_move_constructible_v<Revision> && std::is_nothrow_move_assignable_v<Revision>);
    if(draft) {
        historyCheckpoint("draft.append");
        undo_.push_back(std::move(*draft));
    }
    try {
        historyCheckpoint("history.append");
        undo_.push_back(std::move(revision));
    } catch(...) {
        // The original deque entries are never copied. Only the prospective
        // draft append is rolled back if allocating the second slot fails.
        if(draft) undo_.pop_back();
        throw;
    }
}
bool SceneEdits::confirmSelectionDraft() {
    if(!draftStates_) return false;
    auto nextContent=nextContentRevision_;
    auto revision=stageSelectionDraft(nextContent);
    if(revision) {
        historyCheckpoint("draft.append");
        undo_.push_back(std::move(*revision));
    }
    // Live states already display the delta. Confirmation only records it.
    draftStates_.reset();
    if(!revision) return false;
    redo_.clear();
    nextContentRevision_=nextContent; contentRevision_=undo_.back().afterContent;
    trimHistory(); ++revision_;
    return true;
}
bool SceneEdits::cancelSelectionDraft() noexcept {
    static_assert(std::is_nothrow_move_assignable_v<decltype(states_)>);
    if (!draftStates_)
        return false;
    const bool changed = states_ != *draftStates_;
    states_ = std::move(*draftStates_);
    draftStates_.reset();
    recount();
    if (changed)
        ++revision_;
    return changed;
}
void SceneEdits::recount() noexcept {
    selected_ = deleted_ = 0;
    for (auto state : states_) {
        selected_ += (state & 1) != 0;
        deleted_ += (state & 2) != 0;
    }
}
void SceneEdits::applyHistory(const Revision &revision,bool forward,MaskStorage &states) noexcept {
    if (!revision.before) {
        if (states.hasStorage()) states_.swap(states);
        apply(revision.changes, forward);
        contentRevision_ = forward ? revision.afterContent : revision.beforeContent;
        return;
    }
    scene_ = forward ? revision.after : revision.before;
    states_.swap(states);
    recount();
    contentRevision_ = forward ? revision.afterContent : revision.beforeContent;
}
bool SceneEdits::replaceScene(std::shared_ptr<const Scene> scene, std::span<const uint8_t> states) {
    if (!scene || scene->gaussians.size() != states.size() ||
        std::any_of(states.begin(), states.end(), [](uint8_t state) { return state > 2; }))
        throw std::runtime_error("Invalid processed scene state");
    if (scene == scene_) {
        Changes changes{AdmittedAllocator<Change>{historyMemory_}};
        for (size_t i = 0; i < states.size(); ++i)
            if (states[i] != states_[i])
                changes.push_back({uint32_t(i), states_[i], states[i]});
        commit(std::move(changes));
        return true;
    }
    auto nextContent=nextContentRevision_;
    auto draft=stageSelectionDraft(nextContent);
    Revision revision{Changes{AdmittedAllocator<Change>{historyMemory_}},{},{},{},{},0,0};
    revision.before=scene_; revision.after=scene;
    historyCheckpoint("replace.before_mask");
    revision.beforeStates=states_;
    historyCheckpoint("replace.after_mask");
    auto nextStates=MaskStorage::copy(states,historyMemory_);
    revision.afterStates=nextStates;
    revision.beforeContent=draft ? draft->afterContent : contentRevision_;
    const auto next=++nextContent;
    revision.afterContent=next;
    const bool confirmed=bool(draft);
    appendHistory(revision,draft);
    draftStates_.reset();
    redo_.clear();
    trimHistory();
    scene_ = std::move(scene);
    states_ = std::move(nextStates);
    recount();
    nextContentRevision_=nextContent;
    contentRevision_ = next;
    revision_+=1+unsigned(confirmed);
    return true;
}
bool SceneEdits::selectRegion(const Camera &camera, unsigned width, unsigned height,
                              SelectOperation operation, const std::function<bool(float, float)> &contains) {
    if (!width || !height)
        return false;
    Projector project(camera, width, height);
    return selectMatches(operation, [&](size_t i) {
        auto p = project(scene_->gaussians[i]);
        return p && p->x >= 0 && p->x < width && p->y >= 0 && p->y < height && contains(p->x, p->y);
    });
}
bool SceneEdits::selectMatches(SelectOperation operation, const std::function<bool(size_t)> &contains) {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i) {
        if (states_[i] & 2)
            continue;
        bool inside = contains(i);
        bool selected = (states_[i] & 1) != 0, next = selected;
        if (operation == SelectOperation::Set)
            next = inside;
        else if (operation == SelectOperation::Add)
            next = selected || inside;
        else if (operation == SelectOperation::Remove)
            next = selected && !inside;
        else
            next = selected && inside;
        if (next != selected)
            changes.push_back({static_cast<uint32_t>(i), states_[i], uint8_t(next)});
    }
    return commit(std::move(changes));
}
bool SceneEdits::selectAll() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!states_[i])
            changes.push_back({static_cast<uint32_t>(i), 0, 1});
    return commit(std::move(changes));
}
bool SceneEdits::selectNone() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (states_[i] & 1)
            changes.push_back({static_cast<uint32_t>(i), states_[i], 0});
    return commit(std::move(changes));
}
bool SceneEdits::invertSelection() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!(states_[i] & 2))
            changes.push_back({static_cast<uint32_t>(i), states_[i], uint8_t(states_[i] ^ 1)});
    return commit(std::move(changes));
}
bool SceneEdits::deleteSelected() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (states_[i] & 1)
            changes.push_back({static_cast<uint32_t>(i), states_[i], 2});
    return commit(std::move(changes));
}
bool SceneEdits::keepSelected() {
    if (!selected_)
        return false;
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (!states_[i])
            changes.push_back({static_cast<uint32_t>(i), 0, 2});
    return commit(std::move(changes));
}
bool SceneEdits::restoreDeleted() {
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for (size_t i = 0; i < states_.size(); ++i)
        if (states_[i] & 2)
            changes.push_back({static_cast<uint32_t>(i), states_[i], 0});
    return commit(std::move(changes));
}
bool SceneEdits::resetCleanup() {
    // Reset first cancels a transient selection. Stage against that baseline
    // so a later changes/history allocation cannot discard the live draft.
    const auto &baseline=draftStates_ ? *draftStates_ : states_;
    historyCheckpoint("cleanup.changes");
    Changes changes{AdmittedAllocator<Change>{historyMemory_}};
    for(size_t i=0;i<baseline.size();++i)
        if(baseline[i]) changes.push_back({static_cast<uint32_t>(i),baseline[i],0});
    if(changes.empty()) { cancelSelectionDraft(); return false; }
    const bool content=std::any_of(changes.begin(),changes.end(),[](const Change &change) {
        return (change.before&2)!=0;
    });
    auto writable=baseline.copyForWriteIfShared();
    const auto next=content ? nextContentRevision_+1 : contentRevision_;
    Revision revision{std::move(changes),{},{},{},{},contentRevision_,next};
    std::optional<Revision> noDraft;
    appendHistory(revision,noDraft);
    cancelSelectionDraft();
    if(writable.hasStorage()) states_.swap(writable);
    redo_.clear(); apply(undo_.back().changes,true);
    if(content) nextContentRevision_=next;
    contentRevision_=next; trimHistory(); ++revision_;
    return true;
}
std::shared_ptr<const Scene> SceneEdits::historyScene(bool forward) const noexcept {
    const auto &history=forward ? redo_ : undo_;
    if(draftStates_ || history.empty() || !history.back().before) return scene_;
    return forward ? history.back().after : history.back().before;
}
bool SceneEdits::undo() {
    if (draftStates_)
        return cancelSelectionDraft();
    if (undo_.empty())
        return false;
    MaskStorage states;
    if(undo_.back().before) {
        historyCheckpoint("undo.mask");
        states=undo_.back().beforeStates;
    } else states=states_.copyForWriteIfShared();
    historyCheckpoint("undo.append");
    redo_.push_back(Revision{Changes{AdmittedAllocator<Change>{historyMemory_}},{},{},{},{},0,0});
    applyHistory(undo_.back(),false,states);
    redo_.back() = std::move(undo_.back());
    undo_.pop_back();
    ++revision_;
    return true;
}
bool SceneEdits::redo() {
    if (draftStates_)
        return cancelSelectionDraft();
    if (redo_.empty())
        return false;
    MaskStorage states;
    if(redo_.back().before) {
        historyCheckpoint("redo.mask");
        states=redo_.back().afterStates;
    } else states=states_.copyForWriteIfShared();
    historyCheckpoint("redo.append");
    undo_.push_back(Revision{Changes{AdmittedAllocator<Change>{historyMemory_}},{},{},{},{},0,0});
    applyHistory(redo_.back(),true,states);
    undo_.back() = std::move(redo_.back());
    redo_.pop_back();
    ++revision_;
    return true;
}
std::optional<Scene> SceneEdits::focusBounds() const {
    if (!visibleCount())
        return {};
    float inf = std::numeric_limits<float>::infinity();
    Vec3 low{inf, inf, inf}, high{-inf, -inf, -inf};
    for (size_t i = 0; i < states_.size(); ++i) {
        if ((states_[i] & 2) || (selected_ && !(states_[i] & 1)))
            continue;
        const auto &p = scene_->gaussians[i].positionOpacity;
        const auto &g = scene_->gaussians[i];
        Vec3 extent{3 * std::sqrt(std::max(0.0f, g.covA[0])), 3 * std::sqrt(std::max(0.0f, g.covA[3])),
                    3 * std::sqrt(std::max(0.0f, g.covB[1]))};
        low = {std::min(low.x, p[0] - extent.x), std::min(low.y, p[1] - extent.y),
               std::min(low.z, p[2] - extent.z)};
        high = {std::max(high.x, p[0] + extent.x), std::max(high.y, p[1] + extent.y),
                std::max(high.z, p[2] + extent.z)};
    }
    Scene bounds;
    bounds.center = {(low.x + high.x) / 2, (low.y + high.y) / 2, (low.z + high.z) / 2};
    bounds.radius = std::max(scene_->radius * 0.005f, 0.5f * std::sqrt((high.x - low.x) * (high.x - low.x) +
                                                                       (high.y - low.y) * (high.y - low.y) +
                                                                       (high.z - low.z) * (high.z - low.z)));
    bounds.yUp = scene_->yUp;
    return bounds;
}
std::optional<Vec3> SceneEdits::pickCenter(const Camera &camera, unsigned width, unsigned height,
                                           PointI point) const {
    if (!width || !height)
        return {};
    Projector project(camera, width, height);
    std::optional<Vec3> result;
    float nearest = std::numeric_limits<float>::infinity();
    for (size_t i = 0; i < states_.size(); ++i) {
        if (states_[i] & 2)
            continue;
        auto p = project(scene_->gaussians[i]);
        if (!p)
            continue;
        float dx = p->x - point.x, dy = p->y - point.y;
        if (dx * dx + dy * dy > 144 || p->z >= nearest)
            continue;
        nearest = p->z;
        const auto &g = scene_->gaussians[i].positionOpacity;
        result = Vec3{g[0], g[1], g[2]};
    }
    return result;
}
} // namespace preview
