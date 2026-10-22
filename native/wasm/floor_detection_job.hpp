#pragma once
#include "geometry_tools.hpp"
#include "mask_storage.hpp"
#include <random>

namespace preview::browser_floor {
// MSVC 14.44 bounded-size_t mapping for the admitted <=1m source domain.
// One attempt consumes exactly one full 32-bit engine draw; rejection yields.
class MsvcBounded32 {
  public:
    void begin(uint32_t maximum) noexcept {
        maximum_=maximum; width_=uint64_t(maximum)+1;
        threshold_=(uint64_t(1)<<32)-width_; threshold_%=width_;
    }
    template<class Engine> bool attempt(Engine &engine) {
        const auto raw=static_cast<uint32_t>(engine());
        const uint64_t product=uint64_t(raw)*width_;
        if(uint32_t(product)<threshold_) return false;
        value_=uint32_t(product>>32);
        return true;
    }
    uint32_t value() const noexcept { return value_; }
  private:
    uint32_t maximum_{},value_{};
    uint64_t width_{1},threshold_{};
};
enum class Status { Working, Candidate, None, Cancelled, Refused };
enum class Phase { AllocatePoints, Scan, ReservoirDraw, AllocateAxis, AllocateMerge,
    AxisFill, MergeSetup, MergeWrite, AxisExtent, Threshold, RansacStart, DrawA, DrawB, DrawC,
    Hypothesis, Score, Winner, Center, Covariance, Jacobi, RefinedNormal, FinalSupport, Finish, Terminal };
struct Progress {
    uint64_t actions{}, rawDraws{}, mappedDraws{};
    size_t lastStepActions{}, sourcesScanned{}, eligible{}, sampleCount{}, peakScratchBytes{};
};
class Job final {
  public:
    static constexpr size_t maximumSources=1'000'000, maximumRetained=50'000;
    // O(1) in input size: shared owners and fixed metadata only, no reserve/scan/copy.
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(Job *) noexcept;
    };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(std::shared_ptr<const Scene>,MaskStorage,bool,FloorOptions,std::shared_ptr<SceneMemory>);
    static void retire(Pointer &) noexcept;
    Job(std::shared_ptr<const Scene>,MaskStorage,bool selectedOnly,FloorOptions,std::shared_ptr<SceneMemory>);
    Status step(size_t maxWork, std::stop_token={});
    void cancel() noexcept;
    Status status() const noexcept { return status_; }
    Phase phase() const noexcept { return phase_; }
    const Progress &progress() const noexcept { return progress_; }
    const std::optional<FloorPlane> &result() const noexcept { return result_; }
    size_t scratchBytes() const noexcept;
    const std::shared_ptr<const Scene> &sceneOwner() const noexcept { return scene_; }
    const MaskStorage &maskOwner() const noexcept { return states_; }
  private:
    using D3=std::array<double,3>;
    void advance();
    void finish(Status) noexcept;
    bool draw();
    void updateScratch() noexcept;
    std::shared_ptr<const Scene> scene_;
    MaskStorage states_;
    bool selectedOnly_{};
    FloorOptions options_;
    SceneVector<D3> points_;
    SceneVector<double> axis_,merge_;
    std::mt19937 random_{0x53504c54};
    MsvcBounded32 mapper_;
    Status status_{Status::Working};
    Phase phase_{Phase::AllocatePoints};
    Progress progress_{};
    std::optional<FloorPlane> result_;
    size_t retainedCapacity_{},source_{},eligible_{},cursor_{},width_{1},run_{},left_{},middle_{},right_{},end_{},write_{};
    unsigned axisNumber_{},iteration_{},jacobiIteration_{};
    std::array<size_t,3> triple_{};
    D3 pending_{},extent_{},normal_{},best_{},center_{};
    double magnitude_{},threshold_{},d_{},bestD_{},error_{},bestError_{},radius_{};
    size_t inliers_{},support_{},positive_{},negative_{};
    double covariance_[3][3]{},axes_[3][3]{{1,0,0},{0,1,0},{0,0,1}};
};
// Ready results retain scalar metadata only. Context owners are weak after the
// sampling job retires; the binding validates them before use or publication.
struct Key {
    std::weak_ptr<const Scene> scene;
    const uint8_t *mask{};
    size_t count{};
    uint64_t document{},revision{},contentRevision{};
};
struct Candidate {
    uint64_t id{};
    Key key;
    bool selectedOnly{};
    std::optional<FloorPlane> plane;
};
using CandidatePointer=std::shared_ptr<const Candidate>;
CandidatePointer retain(Candidate,std::shared_ptr<SceneMemory>);
bool validPlane(const FloorPlane &,size_t loadedCount) noexcept;
} // namespace preview::browser_floor
