#include "live_preview.hpp"
#include "processing_kernels.hpp"
#include "software_renderer.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <utility>

namespace preview {
namespace {
void checkStopped(std::stop_token stop) {
    if (stop.stop_requested())
        throw std::runtime_error("Live preview cancelled");
}
void validateKey(const PreviewKey &key) {
    if (!key.width || !key.height || key.width > 8192 || key.height > 8192 ||
        uint64_t(key.width) * key.height > 16'000'000)
        throw std::invalid_argument("Live preview dimensions must be nonzero, at most 8192 per edge and 16 megapixels");
    if (key.backend != PreviewBackend::Metal && key.backend != PreviewBackend::Software)
        throw std::invalid_argument("Invalid live preview backend");
    const auto &camera = key.camera;
    // Match prepareFrame's finite camera contract before acquiring storage;
    // additionally require an angle inside the perspective projection domain.
    if (!std::isfinite(camera.distance) || camera.distance <= 0 || !std::isfinite(camera.yaw) ||
        !std::isfinite(camera.pitch) || !std::isfinite(camera.radius) || camera.radius <= 0 ||
        !std::isfinite(camera.fieldOfView) || camera.fieldOfView <= 0 || camera.fieldOfView >= 180 ||
        !std::isfinite(camera.roll) ||
        !std::isfinite(camera.target.x) || !std::isfinite(camera.target.y) || !std::isfinite(camera.target.z))
        throw std::invalid_argument("Invalid live preview camera");
    // Reuse the preview processing validators; these do not allocate scene data.
    (void)processing_detail::Grade(key.settings.color);
    (void)processing_detail::transform(key.settings.geometry);
    const auto &selection = key.settings.selection;
    if (selection.shape > 4 || selection.operation > 3 ||
        std::any_of(selection.worldToLocal.begin(), selection.worldToLocal.end(),
                    [](float value) { return !std::isfinite(value); }) ||
        std::any_of(selection.limits.begin(), selection.limits.end(),
                    [](float value) { return !std::isfinite(value); }))
        throw std::invalid_argument("Invalid live preview selection settings");
}
} // namespace

bool PreviewKey::operator==(const PreviewKey &other) const noexcept {
    return owner == other.owner && sourceGeneration == other.sourceGeneration &&
        editRevision == other.editRevision && draftRevision == other.draftRevision &&
        camera.target == other.camera.target && camera.yaw == other.camera.yaw &&
        camera.pitch == other.camera.pitch && camera.distance == other.camera.distance &&
        camera.radius == other.camera.radius && camera.fieldOfView == other.camera.fieldOfView &&
        camera.yUp == other.camera.yUp && camera.roll == other.camera.roll &&
        settings == other.settings && width == other.width && height == other.height && backend == other.backend;
}

struct LivePreviewSnapshot::Data {
    PreviewKey key;
    std::optional<ResourceBudget> budget;
    ResourceReservation sceneCharge;
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
};
struct LivePreviewResult::Data {
    PreviewKey key;
    // SoftwareRenderer retains its source; retain the corresponding scene grant
    // and immutable snapshot until that renderer is destroyed as well.
    std::shared_ptr<const LivePreviewSnapshot::Data> input;
    RenderFrame metalFrame;
    Image emptyImage;
    std::unique_ptr<SoftwareRenderer> software;
};

LivePreviewResult::LivePreviewResult(std::unique_ptr<Data> data) noexcept : data_(std::move(data)) {}
LivePreviewResult::~LivePreviewResult() = default;
LivePreviewResult::LivePreviewResult(LivePreviewResult &&) noexcept = default;
LivePreviewResult &LivePreviewResult::operator=(LivePreviewResult &&) noexcept = default;
const PreviewKey &LivePreviewResult::key() const noexcept { return data_->key; }
const RenderFrame &LivePreviewResult::frame() const noexcept {
    return data_->software ? data_->software->frame() : data_->metalFrame;
}
const Image &LivePreviewResult::image() const noexcept {
    return data_->software ? data_->software->readback() : data_->emptyImage;
}

LivePreviewSnapshot::LivePreviewSnapshot(PreviewKey key, std::shared_ptr<const Scene> scene, MaskStorage states,
                                       std::optional<ResourceBudget> budget, AllocationIdentity sceneIdentity) {
    validateKey(key);
    if (!scene)
        throw std::invalid_argument("Live preview needs a scene");
    if (!states.empty() && states.size() != scene->gaussians.size())
        throw std::invalid_argument("Invalid live preview edit states");
    if (budget && !states.empty() && !sceneMemorySharesLedger(states.memory(), *budget))
        throw std::invalid_argument("Live preview mask must use the captured resource ledger");
    auto data = std::make_shared<Data>();
    data->key = std::move(key);
    data->budget = std::move(budget);
    if (data->budget) {
        if (!sceneIdentity)
            sceneIdentity = AllocationIdentity::create();
        const auto remaining = scenePayloadBytes(*scene) - accountedSceneStorageBytes(*scene, *data->budget);
        data->sceneCharge = data->budget->reserve(ResourceCategory::Decoded, remaining, sceneIdentity);
    }
    data->scene = std::move(scene);
    data->states = std::move(states);
    data_ = std::move(data);
}
const PreviewKey &LivePreviewSnapshot::key() const noexcept { return data_->key; }

LivePreviewResult LivePreviewSnapshot::run(std::stop_token stop) const {
    checkStopped(stop);
    const auto &data = *data_;
    const auto &scene = *data.scene;
    for (std::size_t i = 0; i < data.states.size(); ++i) {
        if ((i & 1023) == 0)
            checkStopped(stop);
        if (data.states[i] > 2)
            throw std::invalid_argument("Invalid live preview edit states");
    }
    ResourceReservation previewCharge;
    auto result = std::make_unique<LivePreviewResult::Data>();
    result->key = data.key;
    RenderStorage storage;
    if (data.budget) {
        // previewScene copies inherit the source allocator/service/category.
        // That existing policy remains unchanged: same-ledger vector copies
        // acquire their own actual grants; only untracked remainder is estimated
        // as Work here. fitBounds scratch is admitted separately via scratch.
        const auto preview = scene.isGaussian() &&
            (data.key.settings.color != neutralColor || data.key.settings.geometry != identityMatrix)
            ? scenePayloadBytes(scene) - accountedSceneStorageBytes(scene, *data.budget) : 0;
        previewCharge = data.budget->reserve(ResourceCategory::Work, preview);
        storage={sceneMemoryForBudget(*data.budget,ResourceCategory::Render),
                 sceneMemoryForBudget(*data.budget,ResourceCategory::Work),
                 sceneMemoryForBudget(*data.budget,ResourceCategory::Image)};
    }
    checkStopped(stop);
    // Packet/sort/raster/state/Image physical capacities are allocator-owned.
    // Native upload/GPU/presentation, encoding and owner/control metadata remain
    // separate. No selection-map storage is allocated by this live draw.
    if (data.key.backend == PreviewBackend::Software) {
        result->input = data_;
        result->software = std::make_unique<SoftwareRenderer>(std::move(storage));
        result->software->resize(data.key.width, data.key.height);
        result->software->setScene(data.scene);
        result->software->setStates(data.states);
        result->software->draw(data.key.camera, data.key.settings, stop);
    } else {
        result->metalFrame = prepareFrameWithStorage(data.scene, data.states, data.key.camera, data.key.width, data.key.height,
                                                    data.key.settings, stop, std::move(storage));
    }
    checkStopped(stop);
    return LivePreviewResult(std::move(result));
}
} // namespace preview
