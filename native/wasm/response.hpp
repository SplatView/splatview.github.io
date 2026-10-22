#pragma once
#include "allocation_census.hpp"
#include "operation_receipt.hpp"
#include <array>
#include <cstddef>
#include <cstdint>
#include <optional>
#include <string_view>

namespace sv_response {
struct GeometryDescriptor {
    unsigned layoutVersion{1},kind{},vertexStride{32},indexStride{4};
    std::size_t vertexCount{},triangleCount{},vertexBytes{},indexBytes{};
    std::uint64_t revision{},contentRevision{};
};
enum class ToleranceTool { None, Color, Fill };
struct ToleranceRange {
    bool enabled{};
    std::optional<double> radius;
    std::optional<std::array<double,3>> center;
};
struct ColorSession {
    std::uint64_t sessionId{},baseId{},epochId{};
    bool selectedOnly{},pending{};
    std::array<double,15> values{},applied{};
};
struct Alignment {
    std::array<double,16> frame{};
    std::uint64_t branchId{};
    bool canReset{};
    std::array<std::uint64_t,64> retainedBranchIds{};
    std::size_t retainedBranchCount{};
};
enum class FloorStatus { Pending, Ready, None };
enum class FloorStage { Sampling, Threshold, Ransac, Refine, Complete };
struct FloorPlane {
    std::array<double,3> normal{},center{};
    double radius{},rms{};
    std::size_t inliers{},tested{};
};
struct Floor {
    std::uint64_t id{};
    FloorStatus status{FloorStatus::Pending};
    FloorStage stage{FloorStage::Sampling};
    bool selectedOnly{};
    std::optional<FloorPlane> plane;
};
struct Filter {
    std::uint64_t id{},epoch{};
    std::string_view kind;
    std::optional<std::uint64_t> previewEpoch;
    bool changed{};
};
struct GizmoSession {
    std::optional<std::uint64_t> cancelBaseId,cancelContentRevision;
    bool canUndo{},canRedo{};
};
struct TransformSession {
    std::uint64_t id{},baseId{},epoch{};
    std::optional<std::uint64_t> appliedEpoch;
    std::string_view kind;
    bool selectedOnly{};
    std::array<double,16> appliedMatrix{};
    std::array<double,3> pivot{};
    std::optional<GizmoSession> gizmo;
};
struct OpacitySession {
    std::uint64_t id{},baseId{},epoch{};
    std::optional<std::uint64_t> appliedEpoch;
    bool selectedOnly{};
    double appliedScale{1};
};
struct MorphologyRange { double minimum{},maximum{},initial{}; };
struct DuplicateRange { std::size_t first{},count{}; };
struct Summary {
    bool loaded{};
    std::size_t count{};
    std::uint64_t sourceCount{},sourceFaces{};
    std::optional<DuplicateRange> duplicateRange;
    bool sampledGeometry{};
    std::optional<GeometryDescriptor> geometry;
    unsigned shDegree{},kind{};
    std::string_view format;
    std::size_t selected{},visible{};
    bool canUndo{},canRedo{},transaction{},selectionDraft{};
    std::optional<Filter> filter;
    std::optional<TransformSession> transformSession;
    std::optional<OpacitySession> opacitySession;
    std::optional<std::uint64_t> toleranceSessionId,toleranceMapId,selectionMapId,pendingSelectionMapId;
    ToleranceTool toleranceTool{ToleranceTool::None};
    std::optional<bool> toleranceConnected;
    std::optional<ToleranceRange> toleranceRange;
    std::optional<bool> toleranceRecorded;
    std::size_t selectionMapBytes{};
    std::array<std::uint64_t,5> selectionMapRetainedIds{};
    std::size_t selectionMapRetainedCount{};
    bool sceneChanged{};
    std::uint64_t revision{},contentRevision{};
    std::uint64_t selectionCommitRevision{};
    std::uint64_t undoSelectionRevision{};
    bool pending{};
    double progress{1};
    std::array<double,3> center{};
    double radius{};
    bool yUp{};
    std::array<double,11> camera{};
    // Existing domain payload accounting only. Fixed response storage belongs
    // to the measured runtime reserve, not actual owned scene allocations C.
    std::size_t memoryBytes{};
    std::size_t exportBytes{},exportOutputBytes{};
    std::optional<ColorSession> colorSession;
    std::optional<Alignment> alignment;
    std::optional<Floor> floor;
    std::optional<MorphologyRange> morphologyRange;
};
using Point=std::array<double,3>;
enum class FailureKind { Allocation, InvalidResponse, Internal };
const char *failureReply(FailureKind=FailureKind::Allocation) noexcept;

// The one variable summary field is admitted at candidate-open time. Other
// fields have fixed topology and bounded scalar representations. Nonfinite
// floats serialize as null, matching the previous nlohmann::json response.
inline constexpr std::size_t formatByteLimit=256,errorByteLimit=512;
bool validSummary(const Summary &) noexcept;
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
// Main-only one-shot publication-gate failure. No shipping hook/export exists.
void refuseNextSummaryForContracts() noexcept;
// Refuse the second terminal receipt serialization: preparation succeeds and
// native proof/checkpoint retirement happens before the shipping reply fails.
void refuseNextOperationPublicationForContracts() noexcept;
#endif

class Responses final {
  public:
    static constexpr std::size_t bufferBytes=16384,bufferCount=2;
    class Preparation final {
      public:
        Preparation() noexcept = default;
        Preparation(Preparation &&) noexcept;
        Preparation &operator=(Preparation &&) noexcept;
        Preparation(const Preparation &)=delete;
        Preparation &operator=(const Preparation &)=delete;
        explicit operator bool() const noexcept { return owner_!=nullptr; }
        std::string_view view() const noexcept;
      private:
        friend class Responses;
        Preparation(Responses *,unsigned,std::uint64_t) noexcept;
        Responses *owner_{};
        unsigned slot_{};
        std::uint64_t epoch_{};
        std::size_t length_{};
        bool ready_{};
    };
    Responses() noexcept = default;
    Responses(const Responses &)=delete;
    Responses &operator=(const Responses &)=delete;
    // Acquire before any authoritative mutation. No allocation or callback is
    // performed; the active reply remains intact while the other slot is built.
    Preparation begin() noexcept;
    bool summary(Preparation &,const Summary &) noexcept;
    bool point(Preparation &,const Summary &,std::optional<Point>) noexcept;
    bool livePublished(Preparation &,const Summary &) noexcept;
    bool computationFailed(Preparation &) noexcept;
    bool operation(Preparation &,const sv_operation::Receipt &,const Summary &) noexcept;
    bool operationBound(Preparation &,const sv_operation::Scope &) noexcept;
    bool operationRetired(Preparation &,const sv_operation::Owner &) noexcept;
    bool census(Preparation &,const sv_allocation::Snapshot &,std::uint64_t sequence) noexcept;
    bool error(Preparation &,const char *message) noexcept;
    const char *publish(Preparation &) noexcept;
    const char *current() const noexcept { return buffers_[active_].data(); }
    // Static storage, including both slots and their bookkeeping. The host
    // already measures it in H; it must never be added to scene coverage C.
    static std::size_t runtimeReserveBytes() noexcept;
  private:
    bool owns(const Preparation &) const noexcept;
    std::array<std::array<char,bufferBytes>,bufferCount> buffers_{};
    unsigned active_{};
    std::uint64_t epoch_{};
};
} // namespace sv_response
