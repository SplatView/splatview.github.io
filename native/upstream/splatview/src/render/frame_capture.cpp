#include "frame_capture.hpp"
#include "software_renderer.hpp"
#include "mask_storage.hpp"
#include <algorithm>
#include <limits>
#include <stdexcept>
#include <utility>

namespace preview {
namespace {
void validateExtent(unsigned width, unsigned height, std::size_t maxPixels) {
    if (!width || !height || !maxPixels)
        throw std::invalid_argument("Frame capture needs nonzero dimensions and a pixel limit");
    constexpr auto maximum = std::numeric_limits<std::size_t>::max();
    if (std::size_t(height) > maximum / width)
        throw std::invalid_argument("Frame capture pixel count overflows");
    const auto pixels = std::size_t(width) * height;
    if (pixels > maximum / 4)
        throw std::invalid_argument("Frame capture BGRA storage overflows");
    if (pixels > maxPixels)
        throw std::invalid_argument("Frame capture exceeds its caller's pixel limit");
    // Match prepareFrame's current CPU backend bounds, before copying any mask.
    // The pixel budget is not a universal estimate of scene/frame/scratch bytes.
    if (width > 8192 || height > 8192 || pixels > 16'000'000)
        throw std::invalid_argument("Frame capture exceeds CPU renderer dimensions");
}
} // namespace
struct FrameCaptureSnapshot::Data {
    std::optional<ResourceBudget> budget;
    ResourceReservation sceneCharge;
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    Camera camera;
    ViewSettings settings;
    unsigned width{},height{};
};
CapturedFrame::CapturedFrame(Image image) : image_(std::move(image)) {}
CapturedFrame &CapturedFrame::operator=(CapturedFrame &&) noexcept = default;
FrameCaptureSnapshot::FrameCaptureSnapshot(std::shared_ptr<const Scene> scene,
                                         std::span<const uint8_t> states,
                                         Camera camera, ViewSettings settings,
                                         unsigned width, unsigned height, std::size_t maxPixels,
                                         std::optional<ResourceBudget> budget,AllocationIdentity sceneIdentity) {
    validateExtent(width, height, maxPixels);
    if (!scene)
        throw std::invalid_argument("Frame capture needs a scene");
    if ((!states.empty() && states.size() != scene->gaussians.size()) ||
        std::any_of(states.begin(), states.end(), [](uint8_t state) { return state > 2; }))
        throw std::invalid_argument("Invalid frame capture edit states");
    auto data=std::make_shared<Data>();
    data->budget=std::move(budget);
    if(data->budget) {
        if(!sceneIdentity) sceneIdentity=AllocationIdentity::create();
        // Allocator-owned payloads already hold grants in this ledger. Retain
        // only the remaining object/metadata/untracked payload estimate here.
        const auto remaining=scenePayloadBytes(*scene)-accountedSceneStorageBytes(*scene,*data->budget);
        data->sceneCharge=data->budget->reserve(ResourceCategory::Decoded,remaining,sceneIdentity);
    }
    data->scene=std::move(scene);
    data->states=MaskStorage::copy(states,data->budget ?
        sceneMemoryForBudget(*data->budget,ResourceCategory::Work) : nullptr);
    data->camera=camera; data->settings=settings;
    data->settings.highlightSelection=false; data->settings.colorPreviewCoverage=false; data->settings.selection={};
    data->width=width; data->height=height; data_=std::move(data);
}
bool FrameCaptureSnapshot::budgeted() const { return data_->budget.has_value(); }
unsigned FrameCaptureSnapshot::width() const { return data_->width; }
unsigned FrameCaptureSnapshot::height() const { return data_->height; }
CapturedFrame FrameCaptureSnapshot::execute(std::stop_token stop) const {
    if (stop.stop_requested())
        throw std::runtime_error("Frame capture cancelled");
    const auto &data=*data_;
    ResourceReservation previewCharge;
    RenderStorage storage;
    if(data.budget) {
        const auto &scene=*data.scene;
        const auto preview=scene.isGaussian() && (data.settings.color!=neutralColor || data.settings.geometry!=identityMatrix)
            ? scenePayloadBytes(scene)-accountedSceneStorageBytes(scene,*data.budget) : 0;
        // Transformed Scene copies still inherit their source allocation policy;
        // retain only the untracked remainder estimate. Packet/sort/state/raster
        // and both physical Image allocations now admit their actual capacities.
        previewCharge=data.budget->reserve(ResourceCategory::Work,preview);
        storage={sceneMemoryForBudget(*data.budget,ResourceCategory::Render),
                 sceneMemoryForBudget(*data.budget,ResourceCategory::Work),
                 sceneMemoryForBudget(*data.budget,ResourceCategory::Image)};
    }
    SoftwareRenderer renderer(std::move(storage));
    renderer.resize(data.width,data.height);
    renderer.setScene(data.scene); renderer.setStates(data.states);
    renderer.draw(data.camera,data.settings,stop);
    // The independent copy retains the Image service and admits another real
    // allocation while the renderer's source image remains alive.
    return CapturedFrame(renderer.readback());
}
Image FrameCaptureSnapshot::run(std::stop_token stop) const {
    if(budgeted()) throw std::logic_error("Use runAdmitted to retain a budgeted capture's image reservation");
    auto result=execute(stop); return std::move(result.image_);
}
CapturedFrame FrameCaptureSnapshot::runAdmitted(std::stop_token stop) const {
    if(!budgeted()) throw std::logic_error("Admitted capture needs an explicit resource budget");
    return execute(stop);
}
} // namespace preview
