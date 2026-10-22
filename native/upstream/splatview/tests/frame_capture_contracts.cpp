#include "frame_capture_contracts.hpp"
#include "frame_capture.hpp"
#include "software_renderer.hpp"
#include "processing_kernels.hpp"
#include <algorithm>
#include <cstring>
#include <exception>
#include <limits>
#include <stdexcept>
#include <thread>
#include <utility>

using namespace preview;
namespace {
void require(bool value, const char *message) {
    if (!value)
        throw std::runtime_error(message);
}
template<class F> void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const std::exception &) { return; }
    throw std::runtime_error(message);
}
std::shared_ptr<const Scene> fixture() {
    auto scene = std::make_shared<Scene>();
    scene->shDegree = 3;
    for (unsigned i = 0; i < 8; ++i) {
        Attributes value;
        value.position = {float(i % 4) * .18f - .27f, float(i / 4) * .2f - .1f, -.04f * float(i)};
        value.scale = {.06f, .04f, .05f};
        value.opacity = .75f;
        value.sh[0] = .2f + float(i) * .03f;
        value.sh[1] = -.2f;
        value.sh[2] = .4f;
        value.sh[6] = .08f;
        scene->gaussians.push_back(packGaussian(value));
    }
    scene->sourceCount = scene->gaussians.size();
    fitBounds(*scene);
    return scene;
}
ViewSettings clean(ViewSettings settings) {
    settings.highlightSelection = false;
    settings.colorPreviewCoverage = false;
    settings.selection = {};
    return settings;
}
Image render(std::shared_ptr<const Scene> scene, std::span<const uint8_t> states,
             const Camera &camera, const ViewSettings &settings, unsigned width, unsigned height) {
    SoftwareRenderer renderer;
    renderer.resize(width, height);
    renderer.setScene(std::move(scene));
    renderer.setStates(states);
    renderer.draw(camera, settings);
    return renderer.readback();
}
bool same(const Image &left, const Image &right) {
    return left.width == right.width && left.height == right.height && left.bgra == right.bgra;
}
} // namespace
void frameCaptureContracts() {
    constexpr unsigned width = 96, height = 80;
    constexpr std::size_t pixels = std::size_t(width) * height;
    auto source = fixture();
    const auto retained = source;
    const auto original = *source;
    std::vector<uint8_t> states(source->gaussians.size());
    states[0] = states[2] = states[5] = 1;
    states.back() = 2;
    const auto originalStates = states;
    Camera camera;
    camera.fit(*source, float(width) / height);
    camera.roll = .2f;
    const auto originalCamera = camera;
    ViewSettings settings;
    settings.color[0] = .7f;
    settings.color[2] = .85f;
    settings.colorSelectedOnly = true;
    settings.geometry[12] = .04f;
    settings.geometrySelectedOnly = true;
    settings.highlightSelection = true;
    settings.colorPreviewCoverage = true;
    settings.selection.shape = 2;
    settings.selection.limits = {100, 100, 100, 0};
    const auto originalSettings = settings;
    const auto expected = render(source, states, camera, clean(settings), width, height);
    require(std::any_of(expected.bgra.begin(), expected.bgra.end(), [](uint8_t value) {
                return value != 10 && value != 255;
            }), "Capture fixture must contain rendered scene pixels");
    FrameCaptureSnapshot snapshot(source, states, camera, settings, width, height, pixels);
    require(snapshot.width() == width && snapshot.height() == height,
            "Capture retains the exact validated extent");
    require(source == retained && states == originalStates && camera.savedView() == originalCamera.savedView() &&
                settings == originalSettings,
            "Constructing a capture must not modify its source arguments");
    // Replacing the owner's scene does not replace the retained immutable source.
    // Deliberate mutation through a mutable alias is outside shared<const Scene>'s contract.
    source = fixture();
    states.assign(states.size(), 2);
    camera.yaw += 1.5f;
    camera.target = {20, 30, 40};
    settings.color[0] = 2;
    settings.geometry[12] = 10;
    const auto captured = snapshot.run();
    require(same(captured, expected),
            "Later owner scene/mask/camera/settings changes cannot alter captured pixels");
    require(same(snapshot.run(), captured), "A capture can run repeatedly without mutable renderer state");
    Image workerImage;
    std::exception_ptr workerFailure;
    std::jthread worker([snapshot, &workerImage, &workerFailure] {
        try { workerImage = snapshot.run(); }
        catch (...) { workerFailure = std::current_exception(); }
    });
    worker.join();
    if (workerFailure) std::rethrow_exception(workerFailure);
    require(same(workerImage, expected), "A worker renders the immutable capture without a document or UI");

    const auto highlighted = render(retained, originalStates, originalCamera, originalSettings, width, height);
    require(!same(highlighted, captured), "Clean capture must remove coverage and selection decoration");
    auto selectionOnly = originalSettings;
    selectionOnly.colorPreviewCoverage = false;
    const auto selectedImage = render(retained, originalStates, originalCamera, selectionOnly, width, height);
    require(!same(selectedImage, captured), "Clean capture must disable ordinary selection highlighting too");
    const auto plain = render(retained, originalStates, originalCamera, clean(ViewSettings{}), width, height);
    require(!same(plain, captured), "Clean capture must retain the requested color and geometry preview");
    const auto baked = previewScene(retained, originalStates, originalSettings.color,
                                    originalSettings.colorSelectedOnly, originalSettings.geometry,
                                    originalSettings.geometrySelectedOnly);
    require(same(captured, render(baked, originalStates, originalCamera, clean(ViewSettings{}), width, height)),
            "Fixed-base absolute color/geometry preview must appear exactly once in captured pixels");
    require(std::memcmp(retained->gaussians.data(), original.gaussians.data(),
                        original.gaussians.size() * sizeof(Gaussian)) == 0 &&
                retained->defaultView == original.defaultView && retained->center == original.center,
            "Rendering captures must preserve immutable source splats and metadata");

    std::stop_source cancelled;
    cancelled.request_stop();
    rejects([&] { snapshot.run(cancelled.get_token()); }, "Pre-canceled capture must not publish an image");
    require(same(snapshot.run(), expected), "Cancellation must not poison a snapshot or its source");
    rejects([&] { FrameCaptureSnapshot({}, {}, originalCamera, {}, width, height, pixels); },
            "Capture rejects an empty source");
    rejects([&] { FrameCaptureSnapshot(retained, {}, originalCamera, {}, 0, height, pixels); },
            "Capture rejects zero width before rendering");
    rejects([&] { FrameCaptureSnapshot(retained, {}, originalCamera, {}, width, 0, pixels); },
            "Capture rejects zero height before rendering");
    rejects([&] { FrameCaptureSnapshot(retained, {}, originalCamera, {}, width, height, 0); },
            "Capture requires an explicit nonzero pixel budget");
    rejects([&] { FrameCaptureSnapshot(retained, originalStates, originalCamera, {}, width, height, pixels - 1); },
            "Capture enforces its caller's exact pixel budget");
    constexpr auto maximum = std::numeric_limits<std::size_t>::max();
    constexpr auto edge = std::numeric_limits<unsigned>::max();
    rejects([&] { FrameCaptureSnapshot(retained, originalStates, originalCamera, {}, edge, edge, maximum); },
            "Huge dimensions cannot overflow pixel or BGRA storage calculations");
    rejects([&] { FrameCaptureSnapshot(retained, originalStates, originalCamera, {}, 8193, 1, maximum); },
            "Capture validates the CPU renderer's edge bound before allocating output");
    rejects([&] { FrameCaptureSnapshot(retained, originalStates, originalCamera, {}, 4096, 4096, maximum); },
            "Capture validates the CPU renderer's total-pixel bound before allocating output");
    auto invalidStates = originalStates;
    invalidStates.pop_back();
    rejects([&] { FrameCaptureSnapshot(retained, invalidStates, originalCamera, {}, width, height, pixels); },
            "Capture rejects a partial edit mask");
    invalidStates = originalStates;
    invalidStates[0] = 3;
    rejects([&] { FrameCaptureSnapshot(retained, invalidStates, originalCamera, {}, width, height, pixels); },
            "Capture rejects invalid combined edit flags");
    FrameCaptureSnapshot maskless(retained, {}, originalCamera, {}, width, height, pixels);
    require(same(maskless.run(), render(retained, {}, originalCamera, clean(ViewSettings{}), width, height)),
            "Omitted masks retain the CPU renderer's all-visible behavior");
    auto geometry = std::make_shared<Scene>();
    geometry->type = SceneType::PointCloud;
    geometry->vertices = {{{-.1f, 0, 0}, 0xff2080d0}, {{.1f, 0, 0}, 0xff60c030}};
    fitBounds(*geometry);
    Camera geometryCamera;
    geometryCamera.fit(*geometry, float(width) / height);
    FrameCaptureSnapshot geometryCapture(geometry, {}, geometryCamera, {}, width, height, pixels);
    require(same(geometryCapture.run(), render(geometry, {}, geometryCamera, clean(ViewSettings{}), width, height)),
            "Read-only point-cloud scenes retain their CPU capture behavior");

    const auto sceneBytes=scenePayloadBytes(*retained), imageBytes=imagePayloadBytes(width,height);
    ResourceBudget tooSmall(sceneBytes-1);
    rejects([&]{FrameCaptureSnapshot denied(retained,originalStates,originalCamera,{},width,height,pixels,tooSmall);},
            "Capture refuses retained scene admission before copying its mask");
    require(tooSmall.usage().totalBytes==0,"Rejected capture releases every provisional charge");
    ResourceBudget inputsOnly(sceneBytes+originalStates.size());
    {
        FrameCaptureSnapshot admitted(retained,originalStates,originalCamera,{},width,height,pixels,inputsOnly);
        const auto baseline=inputsOnly.usage().totalBytes;
        rejects([&]{admitted.runAdmitted();},"Render scratch must be admitted before rasterization");
        require(inputsOnly.usage().totalBytes==baseline,"Failed workspace admission rolls back all worker charges");
        rejects([&]{admitted.run();},"Budgeted pixels cannot escape via the uncharged compatibility result");
    }
    require(inputsOnly.usage().totalBytes==0,"Destroying an unused snapshot releases retained inputs");
    ResourceLimits limits; limits.totalBytes=64*1024*1024;
    limits.categoryBytes[std::size_t(ResourceCategory::Image)]=2*imageBytes;
    ResourceBudget budget(limits);
    std::optional<CapturedFrame> output;
    {
        const auto identity=AllocationIdentity::create();
        FrameCaptureSnapshot admitted(retained,originalStates,originalCamera,originalSettings,width,height,pixels,budget,identity);
        const auto inputs=sceneBytes+originalStates.size();
        require(budget.usage().totalBytes==inputs,"Snapshot charges actual retained scene and copied mask");
        auto copy=admitted;
        require(budget.usage().totalBytes==inputs,"Snapshot copies share actual immutable storage and its grants");
        {
            FrameCaptureSnapshot separate(retained,originalStates,originalCamera,{},width,height,pixels,budget,identity);
            require(budget.usage().totalBytes==inputs+originalStates.size(),"Separate masks charge independently while shared scene counts once");
        }
        output.emplace(admitted.runAdmitted());
        require(same(output->image(),expected) && output->admittedImageBytes()==imageBytes,
                "Admitted capture retains exact clean output pixels and their byte grant");
        require(budget.usage().totalBytes==inputs+imageBytes,"Completed capture releases workspace while returned pixels remain charged");
        rejects([&]{copy.runAdmitted();},"Live returned pixels constrain another capture before allocation");
        require(budget.usage().totalBytes==inputs+imageBytes,"Rejected overlapping capture preserves existing output and input charges");
        output.reset();
        output.emplace(copy.runAdmitted());
        const auto beforeCancel=budget.usage().totalBytes;
        rejects([&]{copy.runAdmitted(cancelled.get_token());},"Cancelled capture never admits workspace or pixels");
        require(budget.usage().totalBytes==beforeCancel,"Cancellation leaves retained input/output accounting unchanged");
    }
    require(budget.usage().totalBytes==imageBytes,"Returned pixels remain charged after every input snapshot is destroyed");
    output.reset();
    require(budget.usage().totalBytes==0 && budget.usage().peakBytes<=limits.totalBytes,
            "Final output destruction releases its grant and never exceeds admitted totals");
}
