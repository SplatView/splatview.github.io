#include "bounds_work_contracts.hpp"
#include "resource_budget.hpp"
#include "scene.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <stdexcept>
#include <string>
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
struct Observations {
    struct Request { std::size_t bytes{}, liveBefore{}; bool accepted{}; };
    std::vector<Request> requests;
    std::size_t live{}, peak{}, active{}, failAt{};
};
struct Grant {
    ResourceReservation reservation;
    std::shared_ptr<Observations> observations;
    std::size_t bytes;
    Grant(ResourceReservation value, std::shared_ptr<Observations> observed, std::size_t size) noexcept
        : reservation(std::move(value)), observations(std::move(observed)), bytes(size) {
        observations->live += bytes;
        observations->peak = std::max(observations->peak, observations->live);
        ++observations->active;
    }
    ~Grant() { observations->live -= bytes; --observations->active; }
};
class ObservedMemory final : public SceneMemory {
  public:
    explicit ObservedMemory(ResourceBudget value)
        : budget(std::move(value)), observations(std::make_shared<Observations>()) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        auto &observed = *observations;
        observed.requests.push_back({bytes, observed.live, false});
        if (observed.failAt == observed.requests.size()) throw std::bad_alloc();
        auto result = std::make_shared<Grant>(budget.reserve(ResourceCategory::Work, bytes), observations, bytes);
        observed.requests.back().accepted = true;
        return result;
    }
    ResourceBudget budget;
    std::shared_ptr<Observations> observations;
};
Scene fixture(bool transparent = false, const std::shared_ptr<SceneMemory> &memory = {}) {
    Scene scene(memory);
    for (unsigned i = 0; i < 37; ++i) {
        Attributes value;
        value.position = {float(i % 7) * .2f + 2, float(i % 5) * .3f - .4f, float(i % 3) * .1f};
        value.scale = {.02f, .04f, .03f};
        value.opacity = transparent ? 0.f : .8f;
        scene.gaussians.push_back(packGaussian(value));
    }
    scene.center = {31, -17, 23}; scene.radius = 19;
    scene.previewEye = Vec3{7, 11, 13};
    scene.defaultView = SavedView{{1, 2, 3}, .4f, .2f, 5, 51, true, .3f};
    scene.alignmentFrame[12] = 9;
    scene.sourceCount = 901; scene.format = "bounds-work-fixture";
    return scene;
}
bool sameGaussian(const Gaussian &left, const Gaussian &right) {
    return left.positionOpacity == right.positionOpacity && left.covA == right.covA &&
        left.covB == right.covB && left.sh == right.sh;
}
struct State {
    Vec3 center;
    float radius;
    std::optional<Vec3> eye;
    std::optional<SavedView> view;
    Matrix4 alignment;
    const Gaussian *pointer;
    std::vector<Gaussian> gaussians;
    uint64_t sourceCount;
    std::string format;
    explicit State(const Scene &scene)
        : center(scene.center), radius(scene.radius), eye(scene.previewEye), view(scene.defaultView),
          alignment(scene.alignmentFrame), pointer(scene.gaussians.data()),
          gaussians(scene.gaussians.begin(), scene.gaussians.end()), sourceCount(scene.sourceCount), format(scene.format) {}
    void unchanged(const Scene &scene) const {
        require(scene.center == center && scene.radius == radius && scene.previewEye == eye && scene.defaultView == view &&
                    scene.alignmentFrame == alignment && scene.gaussians.data() == pointer && scene.sourceCount == sourceCount &&
                    scene.format == format && std::equal(gaussians.begin(), gaussians.end(), scene.gaussians.begin(), scene.gaussians.end(), sameGaussian),
                "Bounds preparation failure must preserve center/radius/previewEye and every source owner/value");
    }
};
void actualAllocationRollback() {
    for (const bool transparent : {false, true}) {
        auto expected = fixture(transparent);
        fitBounds(expected);
        require(expected.center != Vec3{31, -17, 23} && !expected.previewEye,
                "Compatibility bounds fixture must publish new metadata and clear the previous preview eye");
        ResourceBudget budget(allowance);
        auto scratch = std::make_shared<ObservedMemory>(budget);
        auto observedScene = fixture(transparent);
        const auto before = State(observedScene);
        fitBounds(observedScene, scratch);
        require(observedScene.center == expected.center && observedScene.radius == expected.radius &&
                    observedScene.previewEye == expected.previewEye && observedScene.defaultView == before.view &&
                    observedScene.gaussians.data() == before.pointer,
                "Admitted bounds must preserve compatibility math and source ownership for opaque and transparent sampling");
        const auto observed = scratch->observations;
        require(observed->requests.size() >= 6 && observed->peak != 0 && observed->live == 0 && observed->active == 0 &&
                    budget.usage().totalBytes == 0,
                "Positions, points, footprints and distances must own real temporary grants, released before return");
        const auto count = observed->requests.size();
        for (std::size_t failAt = 1; failAt <= count; ++failAt) {
            ResourceBudget deniedBudget(allowance);
            auto denied = std::make_shared<ObservedMemory>(deniedBudget);
            denied->observations->failAt = failAt;
            auto scene = fixture(transparent);
            const auto original = State(scene);
            rejects<std::bad_alloc>([&] { fitBounds(scene, denied); },
                                   "Every actual bounds scratch allocation must propagate admission rejection");
            original.unchanged(scene);
            require(denied->observations->requests.size() == failAt && !denied->observations->requests.back().accepted &&
                        denied->observations->active == 0 && deniedBudget.usage().totalBytes == 0,
                    "Partial bounds work must release every earlier grant without publishing metadata");
            denied->observations->failAt = 0;
            fitBounds(scene, denied);
            require(scene.center == expected.center && scene.radius == expected.radius && scene.previewEye == expected.previewEye &&
                        scene.defaultView == original.view && scene.alignmentFrame == original.alignment &&
                        deniedBudget.usage().totalBytes == 0,
                    "Bounds retry must use unchanged source values and publish compatibility metadata together");
        }
    }
}
void distinctPayloadAndScratchCategories() {
    ResourceLimits limits; limits.totalBytes = allowance;
    limits.categoryBytes[std::size_t(ResourceCategory::Work)] = 0;
    ResourceBudget budget(limits);
    auto scratch = std::make_shared<ObservedMemory>(budget);
    {
        auto scene = fixture(false, sceneMemoryForBudget(budget, ResourceCategory::Decoded));
        const auto source = State(scene);
        const auto decoded = budget.usage().categoryBytes[std::size_t(ResourceCategory::Decoded)];
        require(decoded == scene.gaussians.capacity() * sizeof(Gaussian), "Bounds source payload must have independent Decoded ownership");
        rejects<ResourceBudgetExceeded>([&] { fitBounds(scene, scratch); },
                                        "Available Decoded capacity cannot authorize denied Work scratch");
        source.unchanged(scene);
        require(budget.usage().totalBytes == decoded && budget.usage().categoryBytes[std::size_t(ResourceCategory::Work)] == 0,
                "Bounds Work rejection must retain exactly its original Decoded storage");
    }
    require(budget.usage().totalBytes == 0, "Source allocation must release independently from scratch admission");
    // The internal 16384-point sample cap limits count, not authorization.
    auto large = fixture();
    large.gaussians.resize(20001, large.gaussians.front());
    const auto before = State(large);
    rejects<ResourceBudgetExceeded>([&] { fitBounds(large, scratch); },
                                    "A bounded sample count still requires a positive scratch grant");
    before.unchanged(large);
    require(budget.usage().totalBytes == 0, "Sample count rejection must retain no scratch grants");
}
void failedFinalPublicationAndGeometryRoute() {
    ResourceBudget budget(allowance);
    auto scratch = std::make_shared<ObservedMemory>(budget);
    auto enormous = fixture();
    enormous.gaussians.resize(2);
    enormous.gaussians[0].positionOpacity[0] = -std::numeric_limits<float>::max();
    enormous.gaussians[1].positionOpacity[0] = std::numeric_limits<float>::max();
    const auto before = State(enormous);
    rejects<std::runtime_error>([&] { fitBounds(enormous, scratch); },
                                "Final nonfinite radius validation must reject before publishing any bounds metadata");
    before.unchanged(enormous);
    require(!scratch->observations->requests.empty() && budget.usage().totalBytes == 0 && scratch->observations->active == 0,
            "Late bounds failure must unwind already-admitted position/footprint/distance scratch");

    ResourceBudget zero(0);
    auto forbidden = std::make_shared<ObservedMemory>(zero);
    Scene points; points.type = SceneType::PointCloud;
    points.vertices = {{{-1, -2, -3}, 0xffabcdef}, {{1, 2, 3}, 0xff123456}};
    points.center = {17, 19, 23}; points.radius = 29; points.previewEye = Vec3{5, 7, 11};
    const auto *vertices = points.vertices.data();
    fitBounds(points, forbidden);
    require(points.center == Vec3{} && std::abs(points.radius - std::sqrt(14.f)) < 1e-5f && !points.previewEye &&
                points.vertices.data() == vertices && forbidden->observations->requests.empty(),
            "Geometry bounds use stack-only extrema and must not invent a scratch charge");
    const auto center = points.center; const auto radius = points.radius;
    points.previewEye = Vec3{2, 3, 5};
    points.vertices[1].position.x = std::numeric_limits<float>::infinity();
    rejects<std::runtime_error>([&] { fitBounds(points, forbidden); },
                                "Invalid geometry must reject before replacing earlier center/radius/previewEye");
    require(points.center == center && points.radius == radius && points.previewEye == std::optional<Vec3>{Vec3{2, 3, 5}} &&
                forbidden->observations->requests.empty() && zero.usage().totalBytes == 0,
            "Geometry validation failure must preserve all previous bounds metadata without any scratch allocation");

    const float maximum = std::numeric_limits<float>::max();
    const std::array<PreviewVertex, 2> oversizedVertices{{
        {{-maximum, -maximum, -maximum}, 0xffabcdef},
        {{maximum, maximum, maximum}, 0xff123456}}};
    Scene oversized; oversized.type = SceneType::PointCloud;
    oversized.vertices.assign(oversizedVertices.begin(), oversizedVertices.end());
    oversized.center = {17, 19, 23}; oversized.radius = 29; oversized.previewEye = Vec3{5, 7, 11};
    oversized.defaultView = SavedView{{1, 2, 3}, .4f, .2f, 5, 51, true, .3f};
    oversized.alignmentFrame[12] = 9;
    oversized.sourceCount = 2; oversized.format = "oversized-geometry-bounds";
    const auto oversizedBefore = State(oversized);
    const auto *oversizedPointer = oversized.vertices.data();
    rejects<std::runtime_error>([&] { fitBounds(oversized, forbidden); },
                                "Finite geometry with an unrepresentable half-diagonal must reject before bounds publication");
    oversizedBefore.unchanged(oversized);
    require(oversized.vertices.data() == oversizedPointer &&
                std::equal(oversizedVertices.begin(), oversizedVertices.end(), oversized.vertices.begin(), oversized.vertices.end(),
                           [](const PreviewVertex &left, const PreviewVertex &right) {
                               return left.position == right.position && left.color == right.color;
                           }) && forbidden->observations->requests.empty() && zero.usage().totalBytes == 0,
            "Late geometry radius rejection must preserve every vertex and metadata owner without requesting Work");
}
void centerOverflowRollback() {
    for (unsigned axis = 0; axis < 3; ++axis) {
        auto scene = fixture();
        scene.gaussians.resize(1);
        std::array<float, 3> position{};
        position[axis] = std::numeric_limits<float>::max();
        Attributes value;
        value.position = {position[0], position[1], position[2]};
        scene.gaussians[0] = packGaussian(value);
        const auto before = State(scene);
        ResourceBudget budget(allowance);
        auto scratch = std::make_shared<ObservedMemory>(budget);
        rejects<std::runtime_error>([&] { fitBounds(scene, scratch); },
                                    "Each nonfinite final center coordinate must reject even when the radius remains finite");
        before.unchanged(scene);
        require(scratch->observations->requests.size() >= 6 &&
                    std::all_of(scratch->observations->requests.begin(), scratch->observations->requests.end(),
                                [](const Observations::Request &request) { return request.accepted; }) &&
                    scratch->observations->live == 0 && scratch->observations->active == 0 && budget.usage().totalBytes == 0,
                "Late center validation must release all successfully admitted bounds scratch without publishing metadata");
    }
}
void validBackgroundFallback() {
    auto scene = fixture();
    scene.gaussians.clear();
    for (unsigned i = 0; i < 100; ++i) {
        Attributes value;
        value.position.x = i < 90 ? 0.f : (i < 95 ? -std::numeric_limits<float>::max() : std::numeric_limits<float>::max());
        scene.gaussians.push_back(packGaussian(value));
    }
    const auto before = State(scene);
    ResourceBudget budget(allowance);
    auto scratch = std::make_shared<ObservedMemory>(budget);
    fitBounds(scene, scratch);
    require(scene.center == Vec3{} && scene.radius == .05f && !scene.previewEye && scene.defaultView == before.view &&
                scene.alignmentFrame == before.alignment && scene.gaussians.data() == before.pointer &&
                scene.sourceCount == before.sourceCount && scene.format == before.format &&
                std::equal(before.gaussians.begin(), before.gaussians.end(), scene.gaussians.begin(), scene.gaussians.end(), sameGaussian),
            "A valid dense-core fallback must publish even when its unused provisional radius is nonfinite");
    require(scratch->observations->requests.size() >= 6 && scratch->observations->peak != 0 &&
                scratch->observations->live == 0 && scratch->observations->active == 0 && budget.usage().totalBytes == 0,
            "Successful background fallback must release all admitted bounds scratch while retaining the source");
}
} // namespace

void boundsWorkContracts() {
    actualAllocationRollback();
    distinctPayloadAndScratchCategories();
    failedFinalPublicationAndGeometryRoute();
    centerOverflowRollback();
    validBackgroundFallback();
}
