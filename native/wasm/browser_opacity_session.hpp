#pragma once
#include "scene.hpp"
#include "mask_storage.hpp"
#include <memory>
#include <optional>
#include <stop_token>

namespace preview::browser_opacity {
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
bool validScale(float) noexcept;
float opacity(float alpha,float scale) noexcept;
struct Context {
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    uint64_t generation{},revision{},contentRevision{};
    bool settled{};
};
bool valid(const Context &) noexcept;
bool same(const Context &,const Context &) noexcept;
struct Owner {
    uint64_t id{},baseId{},epoch{};
    std::optional<uint64_t> appliedEpoch;
    bool selectedOnly{};
    float appliedScale{1};
    std::shared_ptr<const Scene> base;
    MaskStorage states;
    MaskStorage effectiveStates;
    Context acknowledged;
    const MaskStorage &targetStates() const noexcept { return effectiveStates.hasStorage()?effectiveStates:states; }
};
bool current(const Owner &,const Context &) noexcept;
enum class Status:uint8_t { Working,Ready,Cancelled };
enum class Phase:uint8_t { AllocateScene,Copy,Finish,Ready,Cancelled };
// Capture owns only fixed metadata/shared entry owners. Every Gaussian copy and
// alpha operation runs inside the admitted cooperative pump, with no bounds fit.
class Job final {
  public:
    struct Deleter { std::shared_ptr<SceneMemory> memory;void operator()(Job *) noexcept; };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(const Owner &,float,std::shared_ptr<SceneMemory>,bool reset=false);
    static void retire(Pointer &) noexcept;
    Job(Owner,float,std::shared_ptr<SceneMemory>,bool reset=false);
    Status step(size_t maxWork,std::stop_token={});
    void cancel() noexcept;
    const Owner &owner() const noexcept { return owner_; }
    float scale() const noexcept { return scale_; }
    bool resetting() const noexcept { return reset_; }
    std::shared_ptr<const Scene> result() const noexcept { return status_==Status::Ready?result_:nullptr; }
    Status status() const noexcept { return status_; }
    Phase phase() const noexcept { return phase_; }
    size_t lastStepWork() const noexcept { return lastStepWork_; }
    size_t workDone() const noexcept { return workDone_; }
    double progress() const noexcept;
  private:
    void action();
    Owner owner_;
    float scale_{1};
    std::shared_ptr<SceneMemory> memory_;
    std::shared_ptr<Scene> candidate_;
    std::shared_ptr<const Scene> result_;
    size_t cursor_{},lastStepWork_{},workDone_{};
    bool changed_{},reset_{};
    Status status_{Status::Working};
    Phase phase_{Phase::AllocateScene};
};
} // namespace preview::browser_opacity
