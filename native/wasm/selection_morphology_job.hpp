#pragma once
#include "scene.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <span>

namespace preview::browser_morphology {
inline constexpr float minimumSigma = .5f, maximumSigma = 10.f, sigmaStep = .5f;
enum class Method { Sigma, Volume };
struct Override { uint32_t index; uint8_t value; };
struct Bounds {
    std::array<float, 3> low, high;
    bool touches(const Bounds &) const noexcept;
    void include(const Bounds &) noexcept;
};
inline constexpr uint32_t leaf = UINT32_MAX;
struct Node {
    Bounds box;
    uint32_t begin, end, left, right;
};
// Counts describe fixed capacities, not a resource grant. The caller admits the physical
// payload before allocating these arrays and owns it until the job is retired.
struct ScratchRequirements {
    size_t gaussians{}, nodes{}, bytes{};
};
ScratchRequirements scratchRequirements(size_t gaussianCount);
struct Scratch {
    std::span<Bounds> boxes;
    std::span<uint32_t> order;
    std::span<Node> nodes;
    std::span<uint32_t> remaining;
    std::span<uint8_t> matched;
    std::span<Override> result;
};
enum class Phase { Count, Bounds, Build, Remaining, Query, Publish, Complete, Cancelled, Failed };
// Borrowed Gaussian geometry and baseline must remain immutable for the entire
// job. No allocation, linear initialization, or geometry traversal occurs in the
// constructor. Every per-splat/build/query/publication action is charged to step.
// Scratch objects may be default-initialized POD arrays; no value initialization
// is needed because every location is written before its first read.
class Job final {
  public:
    Job(std::span<const Gaussian>, std::span<const uint8_t> baseline, bool grow,
        Scratch, float reach = 1.f, Method = Method::Sigma);
    Job(const Job &) = delete;
    Job &operator=(const Job &) = delete;
    size_t step(size_t maxWork);
    void cancel() noexcept;
    Phase phase() const noexcept { return phase_; }
    bool complete() const noexcept { return phase_ == Phase::Complete; }
    uint64_t workDone() const noexcept { return workDone_; }
    size_t nodeCount() const noexcept { return nodeCount_; }
    // Partial/cancelled/failed results are never visible to the caller.
    std::span<const Override> result() const noexcept;
  private:
#ifdef SV_MORPHOLOGY_CONTRACTS
    friend struct ContractsAccess;
#endif
    struct BuildFrame {
        uint32_t begin, end, node, cursor, low, high, lt, next, gt, middle;
        uint8_t stage, axis, radixBit;
        float pivot;
        uint64_t partitionWork;
        Bounds box;
    };
    struct QueryFrame { uint32_t node, cursor; uint8_t stage; bool found; };
    std::span<const Gaussian> gaussians_;
    std::span<const uint8_t> baseline_;
    Scratch scratch_;
    float sigma_;
    bool grow_, querySelected_{}, changesOnQuery_{}, volume_{};
    Phase phase_{Phase::Count};
    size_t cursor_{}, selected_{}, unselected_{}, nodeCount_{}, resultCount_{};
    size_t buildDepth_{}, queryDepth_{};
    uint32_t query_{}, remainingCursor_{}, leafCursor_{};
    uint32_t leafRemaining_{};
    uint64_t workDone_{};
    bool hitReturned_{}, hitValue_{};
    std::array<BuildFrame, 64> build_;
    std::array<QueryFrame, 64> queryStack_;
    void tick();
    void buildTick();
    void queryTick();
    void pushBuild(uint32_t begin, uint32_t end, uint32_t parent, bool right);
    void pushQuery(uint32_t node);
    void returnHit(bool value) noexcept;
    void retire(Phase) noexcept;
};
} // namespace preview::browser_morphology
