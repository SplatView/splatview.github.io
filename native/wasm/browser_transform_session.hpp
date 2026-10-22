#pragma once
#include "browser_transform_math.hpp"
#include "admitted_raw_array.hpp"
#include "mask_storage.hpp"
#include <optional>
#include <string_view>

namespace preview::browser_transform {
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
enum class Kind:uint8_t { Numeric,Gizmo };
std::string_view name(Kind) noexcept;
Kind kind(std::string_view);
Parameters parameters(const nlohmann::json &);
struct Context {
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    uint64_t generation{},revision{},contentRevision{};
    bool settled{};
};
bool valid(const Context &) noexcept;
bool same(const Context &,const Context &) noexcept;
// A gizmo's first accepted drag owns this immutable Cancel baseline. Each
// subsequent press captures its own incremental base in Owner::base/states.
// The payloads are shared/admitted; keeping the session adds no N-sized copy.
struct GizmoBaseline {
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    uint64_t baseId{},contentRevision{};
};
struct Owner {
    uint64_t id{},baseId{},epoch{};
    std::optional<uint64_t> appliedEpoch;
    Kind kind{Kind::Numeric};
    bool selectedOnly{},appliedBake{};
    std::shared_ptr<const Scene> base;
    MaskStorage states;
    // Numeric states retain its Reset baseline. Gizmo states are the frozen
    // per-press canonical base; cancelBase separately retains the first one.
    MaskStorage effectiveStates;
    Context acknowledged;
    Parameters applied;
    Plan appliedPlan;
    Vec3 pivot;
    std::optional<GizmoBaseline> cancelBase;
    bool emptyTarget{};
    const MaskStorage &targetStates() const noexcept { return effectiveStates.hasStorage()?effectiveStates:states; }
};
bool current(const Owner &,const Context &) noexcept;
enum class Status:uint8_t { Working,Ready,Cancelled };
enum class Phase:uint8_t { AllocateScene,Copy,AllocateBounds,Sample,Sort,CopySorted,AxisStats,Distances,Footprints,Finish,Ready,Cancelled };
// Work is bounded per step; no scene copy, Gaussian reserve or N-sized scan is
// performed at request capture. Only immutable owners/fixed metadata are held.
class Job final {
  public:
    struct Deleter { std::shared_ptr<SceneMemory> memory;void operator()(Job *) noexcept; };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(const Owner &,Parameters,Plan,std::shared_ptr<SceneMemory>);
    static void retire(Pointer &) noexcept;
    Job(Owner,Parameters,Plan,std::shared_ptr<SceneMemory>);
    Status step(size_t maxWork,std::stop_token={});
    void cancel() noexcept;
    const Owner &owner() const noexcept { return owner_; }
    const Parameters &parameters() const noexcept { return parameters_; }
    const Plan &plan() const noexcept { return plan_; }
    std::shared_ptr<const Scene> result() const noexcept { return status_==Status::Ready?result_:nullptr; }
    Status status() const noexcept { return status_; }
    Phase phase() const noexcept { return phase_; }
    size_t lastStepWork() const noexcept { return lastStepWork_; }
    size_t workDone() const noexcept { return workDone_; }
    size_t scratchBytes() const noexcept { return bounds_ ? capacity_*9*sizeof(float) : 0; }
    double progress() const noexcept;
  private:
    void action();
    void sort(size_t array,size_t count);
    void sorted();
    float *values(size_t array) noexcept { return bounds_->span().data()+array*capacity_; }
    Owner owner_;
    Parameters parameters_;
    Plan plan_;
    std::shared_ptr<SceneMemory> memory_;
    std::shared_ptr<Scene> result_;
    std::optional<AdmittedRawArray<float>> bounds_;
    size_t cursor_{},stride_{},capacity_{},samples_{},footprints_{},sortArray_{},sortCount_{},width_{1},run_{},left_{},middle_{},right_{},end_{},write_{};
    size_t lastStepWork_{},workDone_{};
    bool includeTransparent_{},background_{};
    std::array<float,3> center_{},extent_{},median_{};
    float core_{};
    Status status_{Status::Working};
    Phase phase_{Phase::AllocateScene};
};
} // namespace preview::browser_transform
