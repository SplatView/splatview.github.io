#include "decode_admission_contracts.hpp"
#include "background_jobs.hpp"
#include "document.hpp"
#include "file_io.hpp"
#include "frame_capture.hpp"
#include "model.hpp"
#include "processing_kernels.hpp"
#include "resource_budget.hpp"
#include <array>
#include <chrono>
#include <fstream>
#include <memory>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

using namespace preview;
using namespace std::chrono_literals;
namespace {
constexpr std::size_t allowance = 64 * 1024 * 1024;
constexpr std::array fixtureNames{"demo.ply", "demo.spz", "demo.splat", "demo.ksplat",
                                  "demo-compressed.ply", "demo.sog", "demo-legacy.sogs"};
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error = std::exception, class F>
void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const Error &) { return; }
    throw std::runtime_error(message);
}
std::size_t category(const ResourceBudget &budget, ResourceCategory kind) {
    return budget.usage().categoryBytes[std::size_t(kind)];
}
std::size_t vectorBytes(const Scene &scene) {
    return checkedByteSum({checkedByteProduct(scene.gaussians.capacity(), sizeof(Gaussian)),
                           checkedByteProduct(scene.vertices.capacity(), sizeof(PreviewVertex)),
                           checkedByteProduct(scene.triangles.capacity(), sizeof(std::array<uint32_t, 3>))});
}
LoadOptions optionsFor(const ResourceBudget &budget) {
    LoadOptions options;
    options.resources = budget;
    return options;
}
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto bytes : usage.categoryBytes) require(bytes == 0, message);
}
void decodedOnly(const ResourceBudget &budget, const Scene &scene, const char *message) {
    const auto bytes = vectorBytes(scene);
    require(bytes > 0 && accountedSceneStorageBytes(scene, budget) == bytes &&
                category(budget, ResourceCategory::Decoded) == bytes && budget.usage().totalBytes == bytes,
            message);
}
void formatsAndBorrowedSources(const std::filesystem::path &directory) {
    for (const auto *name : fixtureNames) {
        const auto path = directory / name;
        ResourceBudget budget(allowance);
        {
            auto scene = loadScene(path, optionsFor(budget));
            require(scene.loadedCount() == 8 && scene.sourceCount == 8 &&
                        scene.sourceBytes == std::filesystem::file_size(path),
                    "Budgeted format decode must retain the complete generated fixture and provenance");
            decodedOnly(budget, scene, "Path decode must retain only actual decoded vector capacities");
            require(budget.usage().peakBytes >= scene.sourceBytes + vectorBytes(scene),
                    "Path decoding must admit source and decoded output while both physical buffers are live");
        }
        empty(budget, "Destroying a decoded format must release all source and output reservations");

        // A span owns no source bytes. The caller may have captured them using
        // an entirely different service, without charging them to this ledger.
        FileSnapshot external(path, allowance);
        {
            auto scene = loadScene(external.bytes(), optionsFor(budget));
            require(scene.loadedCount() == 8 && category(budget, ResourceCategory::Source) == 0,
                    "Borrowed span decoding must not claim ownership of caller source storage");
            decodedOnly(budget, scene, "Span decoding must charge its newly allocated output capacities");
        }
        empty(budget, "Borrowed bytes must not keep a destroyed decoder output charged");

        auto sampled = optionsFor(budget);
        sampled.maxSplats = 3;
        {
            auto scene = loadScene(path, sampled);
            require(scene.loadedCount() == 3 && scene.sourceCount == 8,
                    "Sampled decode must charge loaded storage while preserving original source count");
            decodedOnly(budget, scene, "Sampling must use actual output capacity rather than source vertex count");
        }
        empty(budget, "Sampled output destruction must release its allocation grants");
    }

    ResourceBudget zipBudget(allowance);
    rejects([&] { loadScene(directory / "demo.zip", optionsFor(zipBudget)); },
            "A ZIP extension must retain the deliberate path-level rejection policy");
    require(zipBudget.usage().peakBytes == 0,
            "Unsupported ZIP paths must reject before source or decoded allocation admission");
    FileSnapshot archive(directory / "demo.zip", allowance);
    {
        auto scene = loadScene(archive.bytes(), optionsFor(zipBudget));
        require(scene.loadedCount() == 8, "A borrowed SOG archive must retain span autodetection");
        decodedOnly(zipBudget, scene, "Autodetected SOG archive spans must admit decoded output only");
    }
    empty(zipBudget, "Archive span output must release its decoded allocation");
}
void callerOwnedSource(const std::filesystem::path &directory) {
    ResourceBudget budget(allowance);
    std::optional<Scene> output;
    {
        FileSnapshot source(directory / "demo.ply", allowance, {}, budget);
        const auto sourceBytes = source.bytes().size();
        require(category(budget, ResourceCategory::Source) == sourceBytes,
                "The caller's immutable file snapshot must own its exact source-byte reservation");
        output.emplace(loadScene(source.bytes(), optionsFor(budget)));
        require(category(budget, ResourceCategory::Source) == sourceBytes &&
                    category(budget, ResourceCategory::Decoded) == vectorBytes(*output) &&
                    budget.usage().totalBytes == sourceBytes + vectorBytes(*output),
                "Span decode must neither duplicate nor release the caller's live source reservation");
    }
    decodedOnly(budget, *output, "Decoded output must remain valid after the caller destroys its source snapshot");
    require(output->gaussians.front().positionOpacity[3] > 0,
            "Decoded splats must not borrow storage from a destroyed source buffer");
    output.reset();
    empty(budget, "Independent source and decoded owners must each release their own grant exactly once");
}
void copyMoveAndHistory(const std::filesystem::path &directory) {
    ResourceBudget budget(allowance);
    {
        auto original = std::make_shared<Scene>(loadScene(directory / "demo.ply", optionsFor(budget)));
        const auto initialBytes = vectorBytes(*original);
        Scene copy(*original);
        const auto copiedBytes = vectorBytes(copy);
        require(copy.gaussians.data() != original->gaussians.data() &&
                    budget.usage().totalBytes == initialBytes + copiedBytes,
                "Copying a decoded scene must admit distinct physical vector storage");
        copy.gaussians.front().positionOpacity[0] += .5f;
        fitBounds(copy);
        const auto *copiedPointer = copy.gaussians.data();
        auto changed = std::make_shared<Scene>(std::move(copy));
        require(changed->gaussians.data() == copiedPointer &&
                    budget.usage().totalBytes == initialBytes + copiedBytes,
                "Moving decoded storage into shared ownership must transfer the existing grants");
        std::weak_ptr<const Scene> initialLifetime = original, changedLifetime = changed;
        SceneEdits history(original);
        require(history.replaceScene(changed, std::vector<uint8_t>(changed->gaussians.size())),
                "Distinct decoded geometry must create a real undoable scene revision");
        original.reset(); changed.reset();
        require(!initialLifetime.expired() && !changedLifetime.expired() &&
                    budget.usage().totalBytes == initialBytes + copiedBytes,
                "Immutable scene history must retain each physical output without charging extra aliases");
        require(history.undo() && history.scene() == initialLifetime.lock() &&
                    history.redo() && history.scene() == changedLifetime.lock() &&
                    budget.usage().totalBytes == initialBytes + copiedBytes,
                "Undo and redo must retain decoded allocation ownership without cloning scene vectors");
    }
    empty(budget, "Destroying history and its last scene references must release both decoded outputs");
}
std::string truncatedAscii() {
    std::ostringstream out;
    out << "ply\nformat ascii 1.0\nelement vertex 2\n";
    for (const auto *name : {"x", "y", "z", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1",
                             "rot_2", "rot_3", "opacity", "f_dc_0", "f_dc_1", "f_dc_2"})
        out << "property float " << name << '\n';
    out << "end_header\n0 0 0 -3 -3 -3 1 0 0 0 0 0 0 0\n1 0\n";
    return out.str();
}
void rejectionAndRollback(const std::filesystem::path &directory) {
    for (const auto *name : fixtureNames) {
        const auto path = directory / name;
        const auto expected = loadScene(path);
        ResourceLimits limits;
        limits.totalBytes = allowance;
        limits.categoryBytes[std::size_t(ResourceCategory::Decoded)] = vectorBytes(expected) - 1;
        ResourceBudget denied(limits);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path, optionsFor(denied)); },
                                        "Every decoder must enforce the Decoded category before allocating output");
        empty(denied, "Decoded rejection must release the already captured source and provisional grants");
        require(denied.usage().peakBytes >= std::filesystem::file_size(path),
                "Decoded rejection must exercise a path with previously admitted live source bytes");
    }

    const auto malformed = truncatedAscii();
    const auto path = directory / "admission-truncated-ascii.ply";
    {
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(malformed.data(), std::streamsize(malformed.size()));
        require(bool(output), "Malformed admission fixture must be written completely");
    }
    ResourceBudget rollback(allowance);
    auto unrelated = rollback.reserve(ResourceCategory::History, 37);
    rejects([&] { loadScene(path, optionsFor(rollback)); },
            "Truncated ASCII rows must fail after reserving decoded output capacity");
    require(rollback.usage().totalBytes == 37 && category(rollback, ResourceCategory::History) == 37 &&
                category(rollback, ResourceCategory::Source) == 0 && category(rollback, ResourceCategory::Decoded) == 0 &&
                rollback.usage().peakBytes >= 37 + malformed.size() + 2 * sizeof(Gaussian),
            "A malformed post-allocation decode must roll back its source/output while preserving unrelated grants");
    const auto bytes = std::span(reinterpret_cast<const uint8_t *>(malformed.data()), malformed.size());
    rejects([&] { loadScene(bytes, optionsFor(rollback)); },
            "Malformed borrowed spans must also release partially decoded output");
    require(rollback.usage().totalBytes == 37, "Borrowed-span failure must not disturb another category's owner");
    unrelated.release();
    empty(rollback, "Releasing the unrelated owner must leave no failed-decoder reservations");

    std::stop_source stop;
    stop.request_stop();
    ResourceBudget cancelled(allowance);
    auto options = optionsFor(cancelled);
    options.stop = stop.get_token();
    for (const auto *name : fixtureNames) {
        rejects([&] { loadScene(directory / name, options); }, "Pre-cancelled path decode must not load a source");
        FileSnapshot external(directory / name, allowance);
        rejects([&] { loadScene(external.bytes(), options); }, "Pre-cancelled span decode must not allocate output");
    }
    empty(cancelled, "Pre-cancelled decoding must acquire no grants");
    require(cancelled.usage().peakBytes == 0, "Cancellation must precede source/output admission");
}
LoadResult waitFor(DocumentLoader &loader) {
    const auto deadline = std::chrono::steady_clock::now() + 5s;
    do {
        if (auto result = loader.take()) return std::move(*result);
        std::this_thread::yield();
    } while (std::chrono::steady_clock::now() < deadline);
    throw std::runtime_error("Budgeted document load must deliver its terminal result within the bounded poll");
}
void loaderEnforcement(const std::filesystem::path &directory) {
    ResourceBudget budget(allowance);
    std::shared_ptr<const Scene> retained;
    {
        DocumentLoader loader;
        const auto generation = loader.request(directory / "demo.ply", optionsFor(budget));
        auto result = waitFor(loader);
        require(result.generation == generation && result.scene && result.error.empty() && !loader.busy(),
                "The default document loader must accept correctly admitted decoded storage");
        decodedOnly(budget, *result.scene, "A delivered loader result must retain decoded capacity and release source bytes");
        retained = std::move(result.scene);
    }
    decodedOnly(budget, *retained, "A loaded scene's grants must outlive its document loader");
    retained.reset();
    empty(budget, "The last loaded-scene owner must release its decoded grants");

    BackgroundExecutor executor(1, 2);
    DocumentLoader injected(executor, [](const auto &path, LoadOptions) { return loadScene(path); });
    injected.request(directory / "demo.ply", optionsFor(budget));
    const auto rejected = waitFor(injected);
    require(!rejected.scene && rejected.error.find("did not admit scene storage") != std::string::npos && !injected.busy(),
            "An injected loader that ignores the requested budget must report failure instead of publishing uncharged storage");
    empty(budget, "An unbudgeted injected callback must not fabricate or leak requested-ledger grants");
}
void trackedCapture(const std::filesystem::path &directory) {
    constexpr unsigned width = 48, height = 40;
    constexpr std::size_t pixels = std::size_t(width) * height;
    const auto imageBytes = imagePayloadBytes(width, height);
    const auto untracked = loadScene(directory / "demo.ply");
    const auto storage = vectorBytes(untracked), complete = scenePayloadBytes(untracked);
    ResourceLimits limits;
    limits.totalBytes = allowance;
    // Enough for one retained input and its metadata estimate, but less than a
    // second full vector allocation. A plain render fits; a preview clone cannot.
    limits.categoryBytes[std::size_t(ResourceCategory::Decoded)] = complete + storage - 1;
    ResourceBudget constrained(limits);
    {
        auto source = std::make_shared<Scene>(loadScene(directory / "demo.ply", optionsFor(constrained)));
        Camera camera; camera.fit(*source, float(width) / height);
        const std::vector<uint8_t> states(source->gaussians.size());
        const auto identity = AllocationIdentity::create();
        FrameCaptureSnapshot plain(source, states, camera, {}, width, height, pixels, constrained, identity);
        const auto inputs = scenePayloadBytes(*source) + states.size();
        require(constrained.usage().totalBytes == inputs &&
                    category(constrained, ResourceCategory::Decoded) == scenePayloadBytes(*source),
                "Capture must deduct allocator-admitted input vectors instead of charging them a second time");
        { const auto output = plain.runAdmitted(); require(output.admittedImageBytes() == imageBytes,
                "A plain capture must fit without allocating another decoded scene"); }
        require(constrained.usage().totalBytes == inputs, "Plain rendering must release every temporary/output grant");
        ViewSettings settings; settings.color[0] = .4f;
        // The independent mask gets its own grant; immutable input storage and
        // its remaining metadata estimate share the same allocation identity.
        FrameCaptureSnapshot preview(source, states, camera, settings, width, height, pixels, constrained, identity);
        const auto baseline = constrained.usage().totalBytes;
        require(baseline == inputs + states.size(),
                "Independent captures must share the input estimate while admitting each copied mask");
        rejects<ResourceBudgetExceeded>([&] { preview.runAdmitted(); },
                                        "A color preview must obtain an independent decoded clone grant");
        require(constrained.usage().totalBytes == baseline,
                "Rejected preview clones must roll back render, work, image and provisional decoded grants");
    }
    empty(constrained, "Capture rejection and retained input destruction must release all grants");

    ResourceBudget budget(allowance);
    std::optional<CapturedFrame> output;
    {
        auto source = std::make_shared<Scene>(loadScene(directory / "demo.ply", optionsFor(budget)));
        Camera camera; camera.fit(*source, float(width) / height);
        const std::vector<uint8_t> states(source->gaussians.size());
        ViewSettings settings; settings.color[0] = .4f; settings.geometry[12] = .03f;
        FrameCaptureSnapshot capture(source, states, camera, settings, width, height, pixels, budget);
        const auto baseline = budget.usage().totalBytes;
        {
            const auto clone = previewScene(source, states, settings.color, false, settings.geometry, false);
            require(clone.get() != source.get() &&
                        category(budget, ResourceCategory::Decoded) == scenePayloadBytes(*source) + vectorBytes(*clone),
                    "Combined color/geometry previews must allocate one independently charged scene clone");
        }
        require(budget.usage().totalBytes == baseline, "Destroying a preview clone must release its decoded capacity");
        auto copy = capture;
        require(budget.usage().totalBytes == baseline, "Capture copies must share tracked inputs and mask grants");
        source.reset();
        output.emplace(copy.runAdmitted());
        require(output->image().bgra.size() == imageBytes && budget.usage().totalBytes == baseline + imageBytes,
                "Completed preview capture must release its clone/workspace while returned pixels remain admitted");
    }
    require(budget.usage().totalBytes == imageBytes && category(budget, ResourceCategory::Decoded) == 0,
            "Returned pixels must outlive inputs without retaining decoded scene or preview clone grants");
    output.reset();
    empty(budget, "Destroying the final capture output must release its image reservation");
}
} // namespace
void decodeAdmissionContracts(const std::filesystem::path &directory) {
    formatsAndBorrowedSources(directory);
    callerOwnedSource(directory);
    copyMoveAndHistory(directory);
    rejectionAndRollback(directory);
    loaderEnforcement(directory);
    trackedCapture(directory);
}
