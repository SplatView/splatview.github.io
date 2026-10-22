#include "selection_work_contracts.hpp"
#include "editing.hpp"
#include "resource_budget.hpp"
#include "surface_selection.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <span>
#include <stdexcept>
#include <stop_token>
#include <utility>
#include <vector>

namespace {
using namespace preview;
constexpr std::size_t allowance = 32 * 1024 * 1024;
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error, class F> void rejects(F &&action, const char *message) {
    try { std::forward<F>(action)(); }
    catch (const Error &) { return; }
    throw std::runtime_error(message);
}
std::size_t category(const ResourceBudget &budget, ResourceCategory value) {
    return budget.usage().categoryBytes[std::size_t(value)];
}
struct Request {
    std::size_t bytes{}, liveBefore{};
    bool accepted{};
};
struct Observations {
    std::vector<Request> requests;
    std::size_t failAt{}, live{}, peak{}, active{};
};
struct Grant {
    ResourceReservation reservation;
    std::shared_ptr<Observations> observations;
    std::size_t bytes;
    Grant(ResourceReservation value, std::shared_ptr<Observations> observed, std::size_t count) noexcept
        : reservation(std::move(value)), observations(std::move(observed)), bytes(count) {
        observations->live += bytes;
        observations->peak = std::max(observations->peak, observations->live);
        ++observations->active;
    }
    ~Grant() { observations->live -= bytes; --observations->active; }
};
class ObservedMemory final : public SceneMemory {
  public:
    ObservedMemory(ResourceBudget value, ResourceCategory purpose)
        : budget(std::move(value)), purpose(purpose), observations(std::make_shared<Observations>()) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        auto &observed = *observations;
        observed.requests.push_back({bytes, observed.live, false});
        if (observed.failAt == observed.requests.size()) throw std::bad_alloc();
        auto result = std::make_shared<Grant>(budget.reserve(purpose, bytes), observations, bytes);
        observed.requests.back().accepted = true;
        if (stopOnGrant) stopOnGrant->request_stop();
        return result;
    }
    ResourceBudget budget;
    ResourceCategory purpose;
    std::shared_ptr<Observations> observations;
    std::stop_source *stopOnGrant{};
};
std::shared_ptr<Scene> sceneFixture() {
    auto scene = std::make_shared<Scene>();
    scene->yUp = true;
    for (unsigned i = 0; i < 17; ++i) {
        Attributes value;
        value.position = {float(i % 9) * .2f - .8f, i < 9 ? -.25f : .25f, 0};
        value.scale = {.03f, .04f, .02f};
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount = scene->gaussians.size();
    return scene;
}
Camera cameraFixture() {
    Camera camera;
    camera.yUp = true; camera.yaw = camera.pitch = camera.roll = 0;
    camera.target = {}; camera.distance = 4; camera.radius = 1;
    return camera;
}
SelectionMap idMap() { return {1, 1, {4}, {}, {}}; }
SelectionMap surfaceMap() { return {1, 1, {}, {}, {uint32_t(1) << 3}}; }
enum class Action { Rectangle, Brush, Polygon, VolumeIds, VolumeBits };
bool perform(SceneEdits &edits, Action action) {
    const auto camera = cameraFixture();
    auto ids = idMap();
    switch (action) {
    case Action::Rectangle:
        return edits.selectRectangle(camera, 65, 49, {16, 8, 50, 41}, SelectOperation::Set,
                                     {true, true}, &ids);
    case Action::Brush: {
        const std::array<PointI, 2> stroke{{{18, 24}, {48, 24}}};
        return edits.selectBrush(camera, 65, 49, stroke, 7, SelectOperation::Set);
    }
    case Action::Polygon: {
        const std::array<PointI, 4> polygon{{{16, 8}, {50, 8}, {50, 41}, {16, 41}}};
        return edits.selectPolygon(camera, 65, 49, polygon, SelectOperation::Set, {true, true}, &ids);
    }
    case Action::VolumeIds:
    case Action::VolumeBits: {
        std::array<VolumeSample, 9> samples;
        for (unsigned i = 0; i < samples.size(); ++i) {
            const auto &position = edits.scene()->gaussians[i + 1].positionOpacity;
            samples[i] = {{position[0], position[1], position[2]}, .12f};
        }
        auto visible = action == Action::VolumeIds ? idMap() : surfaceMap();
        return edits.selectVolumeBrush(samples, SelectOperation::Set, {true, true}, &visible);
    }
    }
    throw std::runtime_error("Unknown selection work fixture action");
}
void prepare(SceneEdits &edits) {
    require(edits.selectSingle(0, SelectOperation::Set) && edits.selectSingle(1, SelectOperation::Add) && edits.undo(),
            "Selection admission fixture must have a real redo entry");
    edits.beginSelectionDraft();
    require(edits.canRedo() && edits.selectionDraft() && edits.selectedCount() == 1,
            "Selection admission fixture must retain a draft cancel baseline");
}
struct State {
    const uint8_t *pointer{}, *baselinePointer{};
    std::vector<uint8_t> bytes, baseline;
    std::shared_ptr<const Scene> scene;
    std::size_t selected{}, visible{};
    uint64_t revision{}, content{};
    bool undo{}, redo{}, draft{};
    explicit State(const SceneEdits &edits)
        : pointer(edits.states().data()), baselinePointer(edits.selectionBaseline().data()),
          bytes(edits.states().begin(), edits.states().end()),
          baseline(edits.selectionBaseline().begin(), edits.selectionBaseline().end()), scene(edits.scene()),
          selected(edits.selectedCount()), visible(edits.visibleCount()), revision(edits.revision()),
          content(edits.contentRevision()), undo(edits.canUndo()), redo(edits.canRedo()), draft(edits.selectionDraft()) {}
    void unchanged(const SceneEdits &edits) const {
        require(edits.states().data() == pointer && edits.selectionBaseline().data() == baselinePointer &&
                    std::equal(bytes.begin(), bytes.end(), edits.states().begin(), edits.states().end()) &&
                    std::equal(baseline.begin(), baseline.end(), edits.selectionBaseline().begin(), edits.selectionBaseline().end()) &&
                    edits.scene() == scene && edits.selectedCount() == selected && edits.visibleCount() == visible &&
                    edits.revision() == revision && edits.contentRevision() == content &&
                    edits.canUndo() == undo && edits.canRedo() == redo && edits.selectionDraft() == draft,
                "Selection Work rejection must preserve owner/mask pointers, bytes, baseline, redo and revision identities");
    }
};
void selectionAllocationRollback() {
    const auto scene = sceneFixture();
    for (const auto action : {Action::Rectangle, Action::Brush, Action::Polygon, Action::VolumeIds, Action::VolumeBits}) {
        SceneEdits compatibility(scene);
        prepare(compatibility);
        require(perform(compatibility, action), "The compatibility selection action must change the selection");
        if (action != Action::Brush)
            require(compatibility.selectedCount() == 1 && compatibility.states()[3] == 1,
                    "Independent visibility fixture must select only its explicitly visible Gaussian");
        else
            require(compatibility.selectedCount() > 1, "The analytic central brush must include multiple scene centers");
        const auto expected = State(compatibility);
        std::size_t allocationCount{};
        {
            ResourceBudget budget(allowance);
            auto history = std::make_shared<ObservedMemory>(budget, ResourceCategory::History);
            auto work = std::make_shared<ObservedMemory>(budget, ResourceCategory::Work);
            {
                SceneEdits edits(scene, history, work);
                prepare(edits);
                auto issued = edits.maskSnapshot();
                const auto before = State(edits);
                require(perform(edits, action), "Admitted selection must change the selection");
                allocationCount = work->observations->requests.size();
                require(allocationCount != 0 && work->observations->peak != 0 && category(budget, ResourceCategory::Work) == 0,
                        "Selection scratch must obtain real Work grants and release them before return");
                require(std::equal(expected.bytes.begin(), expected.bytes.end(), edits.states().begin(), edits.states().end()) &&
                            edits.revision() == expected.revision && edits.contentRevision() == expected.content &&
                            edits.canRedo() == expected.redo && issued.data() == before.pointer && issued[0] == 1,
                        "Admitted selection must match compatibility behavior while issued bytes remain immutable");
            }
            require(budget.usage().totalBytes == 0 && history->observations->active == 0 && work->observations->active == 0,
                    "Selection owner destruction must release mask/history/scratch allocations");
        }
        for (std::size_t failAt = 1; failAt <= allocationCount; ++failAt) {
            ResourceBudget budget(allowance);
            auto history = std::make_shared<ObservedMemory>(budget, ResourceCategory::History);
            auto work = std::make_shared<ObservedMemory>(budget, ResourceCategory::Work);
            {
                SceneEdits edits(scene, history, work);
                prepare(edits);
                auto issued = edits.maskSnapshot();
                const auto before = State(edits);
                const auto retainedHistory = category(budget, ResourceCategory::History);
                work->observations->failAt = failAt;
                rejects<std::bad_alloc>([&] { perform(edits, action); },
                                       "Every observed screen/visibility/volume allocation must propagate denial");
                before.unchanged(edits);
                require(issued.data() == before.pointer && issued[0] == 1 &&
                            work->observations->requests.size() == failAt && !work->observations->requests.back().accepted &&
                            work->observations->active == 0 && category(budget, ResourceCategory::Work) == 0 &&
                            category(budget, ResourceCategory::History) == retainedHistory,
                        "Rejected selection preparation must release partial Work without consuming or changing History");
                work->observations->failAt = 0;
                require(perform(edits, action) &&
                            std::equal(expected.bytes.begin(), expected.bytes.end(), edits.states().begin(), edits.states().end()) &&
                            edits.revision() == expected.revision && edits.contentRevision() == expected.content &&
                            edits.canRedo() == expected.redo,
                        "Selection retries must preserve compatibility masks and history identities");
                require(edits.cancelSelectionDraft() && edits.states().data() == before.baselinePointer && edits.states()[0] == 1,
                        "Retry must retain the original cancellation baseline and owner");
                require(edits.redo() && edits.selectedCount() == 2 && edits.states()[0] == 1 && edits.states()[1] == 1 &&
                            edits.contentRevision() == before.content,
                        "The original redo entry must remain executable after rejected preparation, retry and draft cancellation");
            }
            require(budget.usage().totalBytes == 0, "Failed/retried selection must eventually release every grant");
        }
    }
}
void independentCategoryAndExtremeViewport() {
    ResourceLimits limits; limits.totalBytes = allowance;
    limits.categoryBytes[std::size_t(ResourceCategory::Work)] = 0;
    ResourceBudget budget(limits);
    auto history = std::make_shared<ObservedMemory>(budget, ResourceCategory::History);
    auto work = std::make_shared<ObservedMemory>(budget, ResourceCategory::Work);
    {
        SceneEdits edits(sceneFixture(), history, work);
        prepare(edits);
        auto issued = edits.maskSnapshot();
        const auto before = State(edits);
        require(category(budget, ResourceCategory::History) > 0, "History must remain independently admitted with Work disabled");
        rejects<ResourceBudgetExceeded>([&] { perform(edits, Action::Polygon); },
                                        "Screen scratch must not borrow unused History allowance");
        before.unchanged(edits);
        require(category(budget, ResourceCategory::Work) == 0 && category(budget, ResourceCategory::History) > 0,
                "Category-specific denial must preserve retained History grants");
        work->observations->requests.clear();
        const std::vector<PointI> excessive(4097, {1, 1});
        require(!edits.selectPolygon(cameraFixture(), 65, 49, excessive, SelectOperation::Set, {true, true}) &&
                    work->observations->requests.empty(),
                "Polygon count guards reject invalid work without substituting for valid scratch admission");
        before.unchanged(edits);
    }
    require(budget.usage().totalBytes == 0, "Category-denied selection retains no grant after destruction");

    ResourceLimits bounded; bounded.totalBytes = allowance;
    bounded.categoryBytes[std::size_t(ResourceCategory::Work)] = 2 * 1024 * 1024;
    ResourceBudget large(bounded);
    auto largeHistory = std::make_shared<ObservedMemory>(large, ResourceCategory::History);
    auto largeWork = std::make_shared<ObservedMemory>(large, ResourceCategory::Work);
    {
        SceneEdits edits(sceneFixture(), largeHistory, largeWork);
        prepare(edits);
        const auto before = State(edits);
        const auto maximum = std::numeric_limits<unsigned>::max();
        require(!edits.selectRectangle(cameraFixture(), maximum, maximum, {0, 0, 8, 8}, SelectOperation::Add, {false, true}),
                "An extreme viewport with a remote corner rectangle must not select scene centers");
        before.unchanged(edits);
        const auto crossed = std::array<PointI, 3>{{{0, 0}, {8, 0}, {0, 8}}};
        require(!edits.selectPolygon(cameraFixture(), maximum, maximum, crossed, SelectOperation::Add, {false, true}),
                "Extreme viewport polygon arithmetic must remain bounded and leave a remote selection unchanged");
        before.unchanged(edits);
        require(largeWork->observations->peak <= bounded.categoryBytes[std::size_t(ResourceCategory::Work)] &&
                    category(large, ResourceCategory::Work) == 0,
                "UINT_MAX viewport masks must obey a concrete small scratch policy without unsigned wraparound");
    }
    require(large.usage().totalBytes == 0, "Extreme viewport preparation releases every admitted allocation");
}
bool sameSample(const VolumeSample &left, const VolumeSample &right) {
    return left.center == right.center && left.radius == right.radius;
}
void strokeAllocationAndLifetime() {
    const auto camera = cameraFixture();
    const SelectionMap map{1, 1, {}, {4}, {}};
    const std::array<PointI, 3> stroke{{{5, 24}, {32, 24}, {59, 24}}};
    const auto expected = volumeStrokeSamples(camera, map, 65, 49, stroke, 2);
    require(expected.size() > 8, "The stroke fixture must exercise repeated output growth");
    ResourceBudget censusBudget(allowance);
    auto memory = std::make_shared<ObservedMemory>(censusBudget, ResourceCategory::Work);
    std::optional<SceneVector<VolumeSample>> escaped;
    std::weak_ptr<SceneMemory> weakMemory = memory;
    escaped.emplace(volumeStrokeSamples(camera, map, 65, 49, stroke, 2, {}, memory));
    require(escaped->size() == expected.size() && std::equal(expected.begin(), expected.end(), escaped->begin(), sameSample) &&
                category(censusBudget, ResourceCategory::Work) == escaped->capacity() * sizeof(VolumeSample),
            "Returned stroke samples must retain exact physical capacity admission and compatibility coordinates");
    const auto observed = memory->observations;
    require(observed->requests.size() > 1 && std::any_of(observed->requests.begin(), observed->requests.end(), [](const Request &request) {
                return request.accepted && request.liveBefore != 0;
            }), "Returned stroke growth must admit new storage while the previous allocation remains live");
    const auto allocationCount = observed->requests.size();
    memory.reset();
    // The returned vector retains its allocator service as well as its grant.
    require(!weakMemory.expired() && (*escaped)[0].center == expected[0].center,
            "Returned samples must remain readable after the caller drops the scratch service handle");
    escaped.reset();
    require(weakMemory.expired() && censusBudget.usage().totalBytes == 0 && observed->active == 0,
            "Final returned-vector destruction releases both its service handle and all Work grants");
    for (std::size_t failAt = 1; failAt <= allocationCount; ++failAt) {
        ResourceBudget budget(allowance);
        auto denied = std::make_shared<ObservedMemory>(budget, ResourceCategory::Work);
        denied->observations->failAt = failAt;
        rejects<std::bad_alloc>([&] { (void)volumeStrokeSamples(camera, map, 65, 49, stroke, 2, {}, denied); },
                               "Every actual returned-stroke allocation must obey admission");
        require(budget.usage().totalBytes == 0 && denied->observations->active == 0 &&
                    denied->observations->requests.size() == failAt,
                "Partial returned-stroke growth must release all accepted capacity grants");
        denied->observations->failAt = 0;
        const auto retry = volumeStrokeSamples(camera, map, 65, 49, stroke, 2, {}, denied);
        require(std::equal(expected.begin(), expected.end(), retry.begin(), retry.end(), sameSample),
                "Admitted stroke retries preserve deterministic unprojection and interpolation");
    }
    ResourceBudget cancelledBudget(allowance);
    auto cancelled = std::make_shared<ObservedMemory>(cancelledBudget, ResourceCategory::Work);
    std::stop_source during;
    cancelled->stopOnGrant = &during;
    rejects<std::runtime_error>([&] { (void)volumeStrokeSamples(camera, map, 65, 49, stroke, 2, during.get_token(), cancelled); },
                                "Cancellation after admitting stroke storage must unwind before a result is returned");
    cancelled->stopOnGrant = nullptr;
    require(cancelled->observations->requests.size() == 1 && cancelled->observations->peak != 0 &&
                cancelled->observations->active == 0 && cancelledBudget.usage().totalBytes == 0,
            "Mid-stroke cancellation must release the first live capacity grant without publishing output");
    ResourceBudget deniedBudget(0);
    auto denied = std::make_shared<ObservedMemory>(deniedBudget, ResourceCategory::Work);
    std::stop_source stop; stop.request_stop();
    rejects<std::runtime_error>([&] { (void)volumeStrokeSamples(camera, map, 65, 49, stroke, 2, stop.get_token(), denied); },
                                "Pre-cancelled stroke work must stop before allocating its output");
    require(denied->observations->requests.empty() && deniedBudget.usage().totalBytes == 0,
            "Pre-cancelled stroke must obtain no allocation grant");
    rejects<ResourceBudgetExceeded>([&] { (void)volumeStrokeSamples(camera, map, 65, 49, stroke, 2, {}, denied); },
                                    "The 65536-sample guard does not authorize otherwise valid output allocation");
    require(deniedBudget.usage().totalBytes == 0 && map.depths.size() == 1 && map.depths[0] == 4 && stroke[0].x == 5,
            "Stroke admission rejection must leave source depth maps and pointer samples unchanged");
}
} // namespace

void selectionWorkContracts() {
    selectionAllocationRollback();
    independentCategoryAndExtremeViewport();
    strokeAllocationAndLifetime();
}
