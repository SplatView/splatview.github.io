#pragma once
#include "admitted_raw_array.hpp"
#include "scene.hpp"
#include <array>
#include <memory>
#include <optional>

namespace preview::browser_morphology_range {
// Stored reach units. The desktop Diameter control displays twice these values.
struct Range { float minimum{},maximum{},initial{}; };
inline constexpr size_t maximumSamples=16384,maximumScratchBytes=36*maximumSamples,maximumOwnerBytes=2048;
class Job final {
  public:
    struct Deleter { std::shared_ptr<SceneMemory> memory;void operator()(Job *) const noexcept; };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(std::shared_ptr<const Scene>,std::shared_ptr<SceneMemory>);
    Job(std::shared_ptr<const Scene>,std::shared_ptr<SceneMemory>);
    size_t step(size_t maxWork);
    void cancel() noexcept { cancelled_=true;result_.reset(); }
    bool complete() const noexcept { return result_.has_value()&&!cancelled_; }
    const std::shared_ptr<const Scene> &scene() const noexcept { return scene_; }
    std::optional<Range> result() const noexcept { return complete()?result_:std::nullopt; }
    double progress() const noexcept;
    static size_t scratchBytes(size_t gaussianCount);
  private:
    enum class Phase { Sample,Sort,Distances,Complete } phase_{Phase::Sample};
    std::shared_ptr<const Scene> scene_;
    size_t stride_,samples_,cursor_{};
    // x,y,z,radii,distances,merge plus original sample points: exactly36*S.
    AdmittedRawArray<float> values_;
    AdmittedRawArray<std::array<float,3>> points_;
    unsigned array_{},sortStage_{};
    size_t width_{1},begin_{},middle_{},end_{},left_{},right_{},out_{},copy_{};
    bool cancelled_{};
    std::optional<Range> result_;
    void tick();
    void sortTick();
    void finishSort();
};
// One current-geometry entry. It retains no Gaussian/mask/history payload and
// does not compute, allocate or traverse geometry from summary serialization.
class Cache final {
  public:
    std::optional<Range> get(const std::shared_ptr<const Scene> &scene) const noexcept {
        return scene&&scene_.lock()==scene?range_:std::nullopt;
    }
    void publish(const std::shared_ptr<const Scene> &scene,Range value) noexcept { scene_=scene;range_=value; }
    void clear() noexcept { scene_.reset();range_.reset(); }
  private:
    std::weak_ptr<const Scene> scene_;
    std::optional<Range> range_;
};
static_assert(sizeof(Job)<=maximumOwnerBytes);
} // namespace preview::browser_morphology_range
