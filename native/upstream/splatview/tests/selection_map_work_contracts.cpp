#include "selection_map_work_contracts.hpp"
#include "resource_budget.hpp"
#include "software_renderer.hpp"
#include <algorithm>
#include <array>
#include <limits>
#include <memory>
#include <stdexcept>
#include <stop_token>
#include <type_traits>
#include <utility>
#include <vector>

namespace {
using namespace preview;
constexpr std::size_t allowance = 64 * 1024 * 1024;
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
ResourceBudget workLimit(std::size_t bytes) {
    ResourceLimits limits{allowance};
    limits.categoryBytes[std::size_t(ResourceCategory::Work)] = bytes;
    return ResourceBudget(limits);
}
std::size_t work(const ResourceBudget &budget) {
    return budget.usage().categoryBytes[std::size_t(ResourceCategory::Work)];
}
std::size_t storageBytes(const SelectionMap &map) {
    return checkedByteSum({checkedByteProduct(map.ids.capacity(), sizeof(uint32_t)),
                           checkedByteProduct(map.depths.capacity(), sizeof(float)),
                           checkedByteProduct(map.visible.capacity(), sizeof(uint32_t))});
}
bool sameMap(const SelectionMap &a, const SelectionMap &b) {
    return a.width == b.width && a.height == b.height && a.ids == b.ids &&
           a.depths == b.depths && a.visible == b.visible;
}
class ObservedMemory final : public SceneMemory {
  public:
    explicit ObservedMemory(const ResourceBudget &budget)
        : delegate_(sceneMemoryForBudget(budget, ResourceCategory::Work)) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        requests.push_back(bytes);
        auto grant = delegate_->admit(bytes);
        if (stop && requests.size() == stopAt) stop->request_stop();
        return grant;
    }
    std::vector<std::size_t> requests;
    std::stop_source *stop{};
    std::size_t stopAt{};
  private:
    std::shared_ptr<SceneMemory> delegate_;
};
std::shared_ptr<Scene> fixture() {
    auto scene = std::make_shared<Scene>();
    scene->gaussians.reserve(36);
    Attributes a;
    a.scale = {.2f, .2f, .2f};
    a.opacity = .8f;
    scene->gaussians.push_back(packGaussian(a));
    a.position.z = .3f; a.opacity = .1f;
    scene->gaussians.push_back(packGaussian(a));
    a.position = {.3f, 0, 0}; a.opacity = .9f;
    scene->gaussians.push_back(packGaussian(a));
    a.opacity = 0;
    for (unsigned i = 3; i < 35; ++i) scene->gaussians.push_back(packGaussian(a));
    a.position = {-.45f, 0, .1f}; a.opacity = .8f;
    scene->gaussians.push_back(packGaussian(a));
    fitBounds(*scene);
    return scene;
}
Camera camera() {
    Camera result;
    result.target = {};
    result.yUp = true;
    result.yaw = result.pitch = 0;
    result.distance = 4;
    result.radius = 1;
    return result;
}
void returnedOwners(SoftwareRenderer &renderer, const Camera &view) {
    static_assert(std::is_aggregate_v<SelectionMap>);
    // Preserve initializer-list aggregate callers as well as the legacy entry.
    const SelectionMap aggregate{1, 1, {7}, {2.f}, {1}};
    require(aggregate.ids[0] == 7 && aggregate.depths[0] == 2,
            "Selection maps must preserve aggregate initialization");
    for (const bool surface : {false, true}) for (const bool visible : {false, true}) {
        const auto expected = renderer.selectionMap(view, surface, visible);
        ResourceBudget budget(allowance);
        {
            auto service = std::make_shared<ObservedMemory>(budget);
            std::weak_ptr<SceneMemory> weak = service;
            auto map = renderer.selectionMap(view, surface, visible, {}, service);
            require(sameMap(map, expected), "Budgeted selection maps must preserve IDs, depths and visibility");
            require(map.ids.get_allocator().memory() == service && map.depths.get_allocator().memory() == service &&
                        map.visible.get_allocator().memory() == service,
                    "Returned selection arrays must retain the explicit scratch service");
            require(service->requests.size() == 5 + std::size_t(surface || visible) + std::size_t(visible),
                    "Selection map census must include IDs, four scratch arrays and optional returned arrays");
            require(work(budget) == storageBytes(map) && budget.usage().totalBytes == storageBytes(map),
                    "Only actual returned selection capacities may remain charged after rasterization");
            if (visible && !surface)
                require(map.depths.empty() && map.depths.capacity() >= std::size_t(map.width) * map.height,
                        "Cleared visibility depths must retain their allocation and grant");
            const auto retained = storageBytes(map);
            {
                auto copied = map;
                require(sameMap(copied, map) && copied.ids.data() != map.ids.data() &&
                            work(budget) == retained + storageBytes(copied),
                        "A selection map copy must admit independent returned storage");
                const auto *ids = copied.ids.data();
                const auto *depths = copied.depths.data();
                const auto *bits = copied.visible.data();
                const auto held = work(budget);
                const auto requests = service->requests.size();
                auto moved = std::move(copied);
                require(sameMap(moved, map) && moved.ids.data() == ids && moved.depths.data() == depths &&
                            moved.visible.data() == bits && work(budget) == held && service->requests.size() == requests,
                        "Moving a selection map must transfer buffers and grants without another admission");
            }
            require(work(budget) == retained, "Destroying a map copy must release only its independent storage");
            service.reset();
            require(!weak.expired() && work(budget) == retained,
                    "Returned arrays must outlive the caller's scratch-service handle");
            map = {};
            require(weak.expired() && budget.usage().totalBytes == 0,
                    "Destroying the final map must release all storage grants and the service");
        }
        require(budget.usage().totalBytes == 0, "Selection map ownership must fully unwind");
    }
}
void deniedRequests(SoftwareRenderer &renderer, const Camera &view) {
    const auto expected = renderer.selectionMap(view, true, true);
    std::vector<std::size_t> requests;
    {
        ResourceBudget budget(allowance);
        const auto service = std::make_shared<ObservedMemory>(budget);
        { const auto census = renderer.selectionMap(view, true, true, {}, service); }
        requests = service->requests;
        require(requests.size() == 7 && budget.usage().totalBytes == 0,
                "Complete selection-map census must release every capacity");
    }
    std::size_t prefix = 0;
    for (std::size_t stage = 0; stage < requests.size(); ++stage) {
        auto budget = workLimit(prefix + requests[stage] - 1);
        const auto service = std::make_shared<ObservedMemory>(budget);
        auto published = expected;
        const auto *ids = published.ids.data();
        bool rejected = false;
        try { published = renderer.selectionMap(view, true, true, {}, service); }
        catch (const ResourceBudgetExceeded &error) {
            rejected = true;
            require(error.requestedBytes() == requests[stage] && error.availableBytes() == requests[stage] - 1 &&
                        service->requests.size() == stage + 1,
                    "Each actual selection-map allocation must independently enforce Work admission");
        }
        require(rejected && published.ids.data() == ids && sameMap(published, expected) &&
                    budget.usage().totalBytes == 0 && work(budget) == 0,
                "Selection-map denial must release scratch and preserve the previously published map");
        require(sameMap(renderer.selectionMap(view, true, true), expected),
                "Retry after selection-map denial must preserve source identities and compositing order");
        prefix += requests[stage];
    }
}
void cancellationAndInvalid(SoftwareRenderer &renderer, const Camera &view) {
    const auto expected = renderer.selectionMap(view, true, true);
    // Stop deterministically at every admitted allocation, including visible bits.
    for (std::size_t stage = 0; stage <= 7; ++stage) {
        ResourceBudget budget(allowance);
        const auto service = std::make_shared<ObservedMemory>(budget);
        std::stop_source stop;
        service->stop = &stop; service->stopAt = stage;
        if (!stage) stop.request_stop();
        auto published = expected;
        const auto *ids = published.ids.data();
        bool cancelled = false;
        try { published = renderer.selectionMap(view, true, true, stop.get_token(), service); }
        catch (const ResourceBudgetExceeded &) { throw; }
        catch (const std::runtime_error &) { cancelled = true; }
        require(cancelled && published.ids.data() == ids && sameMap(published, expected) &&
                    budget.usage().totalBytes == 0 && (!stage ? service->requests.empty() : service->requests.size() >= stage),
                "Cancellation at allocation boundaries must never publish or retain a partial selection map");
    }
    for (unsigned mode = 0; mode < 3; ++mode) {
        SoftwareRenderer invalid;
        invalid.resize(mode == 2 ? 0 : 65, 49);
        if (mode == 1) {
            auto geometry = std::make_shared<Scene>();
            geometry->type = SceneType::PointCloud;
            geometry->vertices.push_back({{0, 0, 0}, 0xffffffff});
            invalid.setScene(geometry);
        }
        auto budget = workLimit(0);
        const auto service = std::make_shared<ObservedMemory>(budget);
        bool rejected = false;
        try { invalid.selectionMap(view, true, true, {}, service); }
        catch (const ResourceBudgetExceeded &) { throw; }
        catch (const std::runtime_error &) { rejected = true; }
        require(rejected && service->requests.empty() && budget.usage().totalBytes == 0,
                "No scene, read-only geometry and invalid viewports must reject before map admission");
    }
    // No packets means neither raster loop can observe a stop during allocation.
    SoftwareRenderer empty;
    empty.resize(8, 8); empty.setScene(std::make_shared<Scene>());
    ResourceBudget budget(allowance);
    const auto service = std::make_shared<ObservedMemory>(budget);
    std::stop_source stop;
    service->stop = &stop; service->stopAt = 1;
    bool cancelled = false;
    try { empty.selectionMap(view, false, false, stop.get_token(), service); }
    catch (const std::runtime_error &) { cancelled = true; }
    require(cancelled && !service->requests.empty() && budget.usage().totalBytes == 0,
            "An empty scene must still reject publication when stopped during map allocation");
}
void equalDepthOrder(const Camera &view) {
    auto scene = std::make_shared<Scene>();
    Attributes a;
    a.scale = {.2f, .2f, .2f}; a.opacity = .5f;
    scene->gaussians.push_back(packGaussian(a));
    scene->gaussians.push_back(packGaussian(a));
    SoftwareRenderer renderer;
    renderer.resize(65, 49); renderer.setScene(scene);
    ResourceBudget budget(allowance);
    {
        const auto map = renderer.selectionMap(view, true, true, {}, sceneMemoryForBudget(budget, ResourceCategory::Work));
        require(map.ids[24 * 65 + 32] == 2 && map.depths[24 * 65 + 32] == 4 &&
                    sameMap(map, renderer.selectionMap(view, true, true)),
                "Equal-depth splats must preserve stable source order and the existing strongest-contribution tie behavior");
    }
    require(budget.usage().totalBytes == 0, "Equal-depth map owners must release normally");
}
void previewBoundsOwnership(const Camera &view) {
    const auto scene = fixture();
    SoftwareRenderer renderer;
    renderer.resize(65, 49); renderer.setScene(scene); renderer.draw(view);
    const auto previous = renderer.readback().bgra;
    const auto *packets = renderer.frame().splats.data();
    const auto before = renderer.stats();
    ViewSettings settings;
    settings.geometry[12] = .15f;
    auto denied = workLimit(0);
    bool rejected = false;
    try { renderer.draw(view, settings, {}, sceneMemoryForBudget(denied, ResourceCategory::Work)); }
    catch (const ResourceBudgetExceeded &) { rejected = true; }
    require(rejected && denied.usage().totalBytes == 0 && renderer.readback().bgra == previous &&
                renderer.frame().splats.data() == packets && renderer.stats().rasterizations == before.rasterizations,
            "Explicit draw must carry Work through frame/preview to bounds and preserve its prior frame on denial");
    SoftwareRenderer expected;
    expected.resize(65, 49); expected.setScene(scene); expected.draw(view, settings);
    ResourceBudget admitted(allowance);
    auto service = std::make_shared<ObservedMemory>(admitted);
    renderer.draw(view, settings, {}, service);
    require(!service->requests.empty() && admitted.usage().totalBytes == 0 &&
                renderer.readback().bgra == expected.readback().bgra,
            "Explicit preview bounds must admit real scratch, release it and match the compatibility draw");
    const auto accepted = renderer.readback().bgra;
    packets = renderer.frame().splats.data();
    const auto acceptedCount = renderer.stats().rasterizations;
    settings.geometry[13] = .1f;
    std::stop_source stop;
    auto cancelling = std::make_shared<ObservedMemory>(admitted);
    cancelling->stop = &stop; cancelling->stopAt = 1;
    bool cancelled = false;
    try { renderer.draw(view, settings, stop.get_token(), cancelling); }
    catch (const std::runtime_error &) { cancelled = true; }
    require(cancelled && stop.stop_requested() && !cancelling->requests.empty() &&
                admitted.usage().totalBytes == 0 && renderer.readback().bgra == accepted &&
                renderer.frame().splats.data() == packets && renderer.stats().rasterizations == acceptedCount,
            "Stop during admitted preview bounds must unwind scratch without replacing the completed frame");
}
} // namespace
void selectionMapWorkContracts() {
    using namespace preview;
    const auto scene = fixture();
    const auto view = camera();
    SoftwareRenderer renderer;
    renderer.resize(65, 49);
    renderer.setScene(scene);
    std::vector<uint8_t> states(scene->gaussians.size());
    states[2] = 2;
    renderer.setStates(states);
    renderer.draw(view);
    const auto image = renderer.readback().bgra;
    const auto *cache = renderer.frame().splats.data();
    const auto before = renderer.stats();
    const auto reference = renderer.selectionMap(view, true, true);
    require(reference.ids[24 * 65 + 32] == 1 && reference.depths[24 * 65 + 32] > 3.9f &&
                reference.depths[24 * 65 + 32] < 4 && reference.visible.size() == 2 &&
                (reference.visible[0] & 1) && !(reference.visible[0] & 4) && (reference.visible[1] & 8),
            "Selection maps must preserve alpha-weighted depth, original IDs, deleted splats and visibility word boundaries");
    returnedOwners(renderer, view);
    deniedRequests(renderer, view);
    cancellationAndInvalid(renderer, view);
    equalDepthOrder(view);
    previewBoundsOwnership(view);
    require(renderer.readback().bgra == image && renderer.frame().splats.data() == cache &&
                renderer.stats().rasterizations == before.rasterizations && renderer.stats().cacheHits == before.cacheHits,
            "Selection-map jobs must preserve the renderer's last completed image and cache");
    renderer.resize(8192, 8192);
    ResourceBudget budget(allowance);
    {
        const auto service = sceneMemoryForBudget(budget, ResourceCategory::Work);
        const auto map = renderer.selectionMap(view, true, true, {}, service);
        require(map.width == 512 && map.height == 512 && map.ids.size() == 262144 &&
                    map.depths.size() == 262144 && work(budget) == storageBytes(map),
                "Large display surface maps must retain the existing bounded viewport and admit their actual capacities");
    }
    require(budget.usage().totalBytes == 0, "Large selection-map destruction must release retained output capacity");
}
