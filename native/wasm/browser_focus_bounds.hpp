#pragma once
#include "admitted_storage.hpp"
#include "mask_storage.hpp"
#include "scene.hpp"
#include <nlohmann/json.hpp>
#include <optional>

namespace preview::browser_focus {
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
struct TransformBase {
    uint64_t id{},baseId{},epoch{};
    bool operator==(const TransformBase &) const = default;
};
enum class Scope { Scene,Selection };
struct Request {
    Scope scope{};
    uint64_t revision{},contentRevision{};
    std::optional<TransformBase> transform;
};
Request parse(const nlohmann::json &);
// currentScene/currentStates fence the acknowledged document. base/states are
// the immutable original transform coordinates and CANONICAL selection, even
// when a retained transform has a different current-view-only effective mask.
struct Snapshot {
    std::shared_ptr<const Scene> currentScene,base;
    MaskStorage currentStates,states;
    uint64_t generation{},revision{},contentRevision{};
    std::optional<TransformBase> transform;
};
bool valid(const Snapshot &) noexcept;
bool current(const Snapshot &,const Snapshot &) noexcept;
Vec3 scenePoint(const Snapshot &);
class Job final {
  public:
    struct Deleter { std::shared_ptr<SceneMemory> memory;void operator()(Job *) const noexcept; };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(Snapshot,std::shared_ptr<SceneMemory>);
    static void retire(Pointer &) noexcept;
    explicit Job(Snapshot);
    size_t step(size_t maximumWork,const Snapshot &);
    void cancel() noexcept {cancelled_=true;complete_=false;point_.reset();}
    bool complete() const noexcept {return complete_&&!cancelled_;}
    std::optional<Vec3> result() const noexcept {return complete()?point_:std::nullopt;}
    const Snapshot &snapshot() const noexcept {return snapshot_;}
    size_t lastStepWork() const noexcept {return lastStepWork_;}
    size_t workDone() const noexcept {return cursor_;}
    double progress() const noexcept;
  private:
    void visit(size_t);
    Snapshot snapshot_;
    std::array<float,3> low_{},high_{};
    size_t cursor_{},lastStepWork_{};
    bool selected_{},complete_{},cancelled_{};
    std::optional<Vec3> point_;
};
inline constexpr size_t maximumOwnerBytes=512;
static_assert(sizeof(Job)<=maximumOwnerBytes);
} // namespace preview::browser_focus
