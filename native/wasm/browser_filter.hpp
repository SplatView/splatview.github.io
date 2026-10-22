#pragma once
#include "admitted_raw_array.hpp"
#include "selection_checkpoint.hpp"
#include "processing_kernels.hpp"
#include <optional>
#include <string_view>

namespace preview::browser_filter {
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
enum class Kind { Sphere, Box, Ellipsoid, Frustum, Opacity, Scale };
std::string_view name(Kind) noexcept;
Kind kind(std::string_view);
// The wire uses the captured panel's degrees-valued axis-angle components.
// Ellipsoid size is radii; Box size is full extent, as ProcessingUi::filterValues.
struct Parameters {
    std::array<float,3> center{},size{1,1,1},rotation{};
    float radius{1},minimum{},maximum{1},fov{60},aspect{1},nearPlane{.1f},farPlane{100};
};
Parameters parameters(Kind,const nlohmann::json &);
class Predicate final {
  public:
    Predicate(Kind,Parameters);
    bool operator()(const Gaussian &) const;
  private:
    Kind kind_;
    Parameters parameters_;
    processing_detail::Affine rotation_;
    std::array<double,3> halfExtent_{};
    float tanY_{};
};
struct Owner {
    uint64_t id{},epoch{},generation{},revision{};
    Kind kind{Kind::Sphere};
    std::optional<uint64_t> previewEpoch;
    BrowserSelectionCheckpoint baseline;
    // Last accepted preview's membership differs from the original baseline.
    // Pending candidates retain this authoritative value until publication.
    bool changed{};
};
bool current(const SceneEdits &,const Owner &,uint64_t generation) noexcept;
enum class Status { Working, Ready, Cancelled };
enum class Phase { Allocate, Evaluate, Ready, Cancelled };
// A request owns fixed metadata plus one admitted N-byte result. Allocation is
// a pump phase; every source predicate/mask action is bounded by step's budget.
class Job final {
  public:
    struct Deleter {
        std::shared_ptr<SceneMemory> memory;
        void operator()(Job *) noexcept;
    };
    using Pointer=std::unique_ptr<Job,Deleter>;
    static Pointer create(const Owner &,Parameters,SelectOperation,std::shared_ptr<SceneMemory>,browser_view_scope::Scope={});
    static void retire(Pointer &) noexcept;
    Job(Owner,Parameters,SelectOperation,std::shared_ptr<SceneMemory>,browser_view_scope::Scope={});
    Status step(size_t maxWork,std::stop_token={});
    void cancel() noexcept;
    Status status() const noexcept { return status_; }
    Phase phase() const noexcept { return phase_; }
    size_t lastStepWork() const noexcept { return lastStepWork_; }
    size_t workDone() const noexcept { return workDone_; }
    size_t retainedBytes() const noexcept { return sizeof(Job)+(result_ ? owner_.baseline.states.size() : 0); }
    double progress() const noexcept;
    const Owner &owner() const noexcept { return owner_; }
    bool changed() const noexcept { return status_==Status::Ready&&changed_; }
    std::span<const uint8_t> result() const noexcept;
  private:
    Owner owner_;
    Predicate predicate_;
    browser_view_scope::Scope selectionView_;
    SelectOperation operation_;
    std::shared_ptr<SceneMemory> memory_;
    std::optional<AdmittedRawArray<uint8_t>> result_;
    const uint8_t *resultPointer_{};
    size_t cursor_{},lastStepWork_{},workDone_{};
    Status status_{Status::Working};
    Phase phase_{Phase::Allocate};
    bool changed_{};
};
} // namespace preview::browser_filter
