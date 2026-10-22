#include "processing_scratch_contracts.hpp"
#include "file_io.hpp"
#include "geometry_tools.hpp"
#include "processing.hpp"
#include "scene_exports.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <fstream>
#include <iterator>
#include <memory>
#include <span>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <utility>
#include <vector>

namespace {
using namespace preview;
constexpr std::size_t allowance = 64 * 1024 * 1024;
constexpr float c0 = .28209479177387814f;
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
std::size_t category(const ResourceBudget &budget, ResourceCategory kind) {
    return budget.usage().categoryBytes[std::size_t(kind)];
}
ResourceBudget workLimit(std::size_t bytes) {
    ResourceLimits limits{allowance};
    limits.categoryBytes[std::size_t(ResourceCategory::Work)] = bytes;
    return ResourceBudget(limits);
}
Recipe operation(const char *type, Recipe values = Recipe::object()) {
    return {{"type", type}, {"values", std::move(values)}};
}
std::shared_ptr<Scene> fixture(std::size_t count, std::shared_ptr<SceneMemory> memory = {}, float lift = 0) {
    auto scene = std::make_shared<Scene>(memory);
    scene->gaussians.reserve(count);
    scene->shDegree = 3;
    scene->sourceCount = count;
    scene->yUp = true;
    for (std::size_t i = 0; i < count; ++i) {
        Attributes a;
        a.position = {float(i % 9) * .1f, float((i / 9) % 7) * .1f, float(i % 5) * -.07f};
        a.scale = {.02f + float(i) * .0001f, .03f, .04f};
        a.opacity = .75f;
        for (unsigned c = 0; c < 3; ++c) {
            const float color = std::clamp(.1f + float((i * (c + 3) + c * 5) % 23) * .025f + lift, 0.f, 1.f);
            a.sh[c] = (color - .5f) / c0;
        }
        for (std::size_t k = 3; k < a.sh.size(); ++k)
            a.sh[k] = float(int((i + k) % 7) - 3) * .013f;
        scene->gaussians.push_back(packGaussian(a));
    }
    fitBounds(*scene);
    return scene;
}
std::shared_ptr<Scene> budgetedScene(const ResourceBudget &budget, std::size_t count) {
    return fixture(count, sceneMemoryForBudget(budget));
}
std::vector<uint8_t> selection(std::size_t count) {
    std::vector<uint8_t> states(count);
    for (std::size_t i = 0; i < count; ++i) states[i] = i % 11 == 0 ? 2 : i % 2 == 0 ? 1 : 0;
    return states;
}
std::size_t selectedCount(std::span<const uint8_t> states) {
    return std::size_t(std::count(states.begin(), states.end(), uint8_t(1)));
}
bool sameScene(const Scene &a, const Scene &b) {
    return a.gaussians.size() == b.gaussians.size() && a.shDegree == b.shDegree &&
           a.center == b.center && a.radius == b.radius &&
           !std::memcmp(a.gaussians.data(), b.gaussians.data(), a.gaussians.size() * sizeof(Gaussian));
}
bool sameResult(const ProcessingResult &a, const ProcessingResult &b) {
    return sameScene(*a.scene, *b.scene) && a.states.size() == b.states.size() &&
           std::equal(a.states.begin(), a.states.end(), b.states.begin()) && a.report == b.report;
}
void decodedOnly(const ResourceBudget &budget, const Scene &scene, const char *message) {
    const auto bytes = accountedSceneStorageBytes(scene, budget);
    require(bytes > 0 && category(budget, ResourceCategory::Decoded) == bytes &&
                budget.usage().totalBytes == bytes && category(budget, ResourceCategory::Work) == 0,
            message);
}
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto bytes : usage.categoryBytes) require(bytes == 0, message);
}
template<class F> ResourceBudgetExceeded denied(F &&action, const char *message) {
    try { std::forward<F>(action)(); }
    catch (const ResourceBudgetExceeded &error) { return error; }
    throw std::runtime_error(message);
}
std::size_t maskBytes(std::size_t count) {
    ResourceBudget budget(allowance);
    std::size_t bytes{};
    {
        auto source = budgetedScene(budget, count);
        const std::vector<uint8_t> states(count);
        auto result = processScene(source, states, operation("opacity", {{"scale", 1}}), false, {}, {}, budget);
        bytes = category(budget, ResourceCategory::Work);
        require(result.scene == source && bytes == result.states.capacity() * sizeof(uint8_t) && bytes >= count,
                "A neutral processing result must retain only its actual Work-backed mask capacity");
    }
    empty(budget, "Neutral-job mask and input destruction must release their physical storage grants");
    return bytes;
}
void excludedUnchanged(const Scene &before, const Scene &after, std::span<const uint8_t> states) {
    for (std::size_t i = 0; i < states.size(); ++i)
        if (states[i] != 1)
            require(!std::memcmp(&before.gaussians[i], &after.gaussians[i], sizeof(Gaussian)),
                    "Selected scratch-backed grading cannot alter unselected or deleted records");
}
void histogramAndAuto() {
    constexpr std::size_t count = 48;
    const auto mask = maskBytes(count);
    const auto plain = fixture(count);
    const std::vector<uint8_t> states(count);
    // Admit the result mask, then the RGB samples, then all four sorted
    // columns. The next rejected request identifies each distinct owner.
    for (const auto [limit, requested, retained] :
         {std::array{mask, count * 12, mask},
          std::array{mask + count * 12, count * 4, mask + count * 12},
          std::array{mask + count * 28, count * 4, mask + count * 28}}) {
        auto budget = workLimit(limit);
        {
            const auto source = budgetedScene(budget, count);
            const auto data = source->gaussians.data();
            const auto decoded = accountedSceneStorageBytes(*source, budget);
            const auto error = denied([&] {
                processScene(source, states, operation("histogram"), false, {}, {}, budget);
            }, "Histogram samples, sorted columns and scales must each require Work admission");
            require(error.requestedBytes() == requested && error.availableBytes() == 0 &&
                        budget.usage().peakBytes == decoded + retained && source->gaussians.data() == data &&
                        sameScene(*source, *plain),
                    "A histogram admission boundary must preserve the input and expose the live retained peak");
            decodedOnly(budget, *source, "Rejected histogram scratch must release every temporary owner");
        }
        empty(budget, "Rejected histogram input destruction must release its final decoded owner");
    }
    ResourceBudget budget(allowance);
    {
        const auto source = budgetedScene(budget, count);
        const auto expected = processScene(plain, states, operation("histogram"));
        {
            auto result = processScene(source, states, operation("histogram"), false, {}, {}, budget);
            require(result.scene == source && sameResult(result, expected) &&
                        category(budget, ResourceCategory::Work) == mask &&
                        budget.usage().peakBytes >= accountedSceneStorageBytes(*source, budget) + mask + count * 32,
                    "Admitted histogram RGB, four columns and scales must overlap without changing its report");
            auto moved = std::move(result);
            require(sameResult(moved, expected) && category(budget, ResourceCategory::Work) == mask,
                    "Moving a processing result must retain its sole mask grant without duplicating scratch");
        }
        decodedOnly(budget, *source, "Successful histogram destruction must release its result mask");
    }
    empty(budget, "Successful histogram input destruction must release all grants");

    const auto scoped = selection(count);
    const auto active = selectedCount(scoped);
    auto analysis = operation("auto", {{"method", "exposure"}, {"target_mean", .55f}});
    analysis["analyze_only"] = true;
    auto rejected = workLimit(mask + active * 12);
    {
        const auto source = budgetedScene(rejected, count);
        const auto error = denied([&] { processScene(source, scoped, analysis, true, {}, {}, rejected); },
                                  "Automatic analysis must admit its selected histogram columns");
        require(error.requestedBytes() == active * 4 && error.availableBytes() == 0 && sameScene(*source, *plain),
                "Auto analysis must size samples from its visible selection and preserve the fixed source");
        decodedOnly(rejected, *source, "Rejected automatic analysis must release selected RGB scratch and its mask");
    }
    empty(rejected, "Rejected automatic analysis must leave no owner after source destruction");
    ResourceBudget admitted(allowance);
    {
        const auto source = budgetedScene(admitted, count);
        for (bool analyze : {true, false}) {
            analysis["analyze_only"] = analyze;
            const auto expected = processScene(plain, scoped, analysis, true);
            {
                const auto result = processScene(source, scoped, analysis, true, {}, {}, admitted);
                require(sameResult(result, expected) && result.report.contains("suggested_color") &&
                            category(admitted, ResourceCategory::Work) == mask,
                        "Work admission cannot change automatic suggestions, selected grading or returned mask lifetime");
                excludedUnchanged(*source, *result.scene, scoped);
            }
            decodedOnly(admitted, *source, "Auto completion must release all analysis scratch and any writable output");
        }
    }
    empty(admitted, "Automatic grading owners must release the captured decoded input");
}
void scaleGrowth() {
    constexpr std::size_t sampled = 65536;
    SceneVector<float> capacityProbe;
    capacityProbe.reserve(sampled);
    capacityProbe.resize(sampled);
    const auto oldCapacity = capacityProbe.capacity();
    capacityProbe.resize(oldCapacity);
    capacityProbe.push_back(0);
    const auto newCapacity = capacityProbe.capacity(), count = oldCapacity + 1;
    const auto mask = maskBytes(count);
    // Scales examine every record here although color sampling is capped. A
    // growing scale vector must admit the replacement before freeing its old
    // capacity; a size-only charge would incorrectly fit this limit.
    auto budget = workLimit(mask + sampled * 28 + (oldCapacity + newCapacity) * sizeof(float) - 1);
    {
        const auto source = budgetedScene(budget, count);
        const auto data = source->gaussians.data();
        const auto first = source->gaussians.front(), last = source->gaussians.back();
        const std::vector<uint8_t> states(count);
        const auto error = denied([&] {
            processScene(source, states, operation("histogram"), false, {}, {}, budget);
        }, "Growing scale analysis must admit both live capacities before reallocation");
        require(error.requestedBytes() == newCapacity * sizeof(float) &&
                    error.availableBytes() == newCapacity * sizeof(float) - 1 &&
                    source->gaussians.data() == data &&
                    !std::memcmp(&first, &source->gaussians.front(), sizeof(Gaussian)) &&
                    !std::memcmp(&last, &source->gaussians.back(), sizeof(Gaussian)),
                "A rejected scale reallocation must retain its original capacity and immutable source until unwind");
        decodedOnly(budget, *source, "Rejected growing scale analysis must release old RGB, column and scale capacities");
    }
    empty(budget, "Growing scale analysis must release its final decoded input");
}
constexpr std::size_t dedupePrefix = 24, dedupeCount = dedupePrefix + 24;
std::shared_ptr<Scene> duplicateScene(std::shared_ptr<SceneMemory> memory = {}) {
    auto scene = fixture(dedupeCount, std::move(memory));
    // All four corners occupy one .01-wide cell, but their pairwise
    // distances exceed .01. Repetition exercises its growing index vector.
    constexpr std::array<Vec3, 4> corners{{{0, 0, 0}, {.009f, .009f, 0},
                                           {0, .009f, .009f}, {.009f, 0, .009f}}};
    for (std::size_t i = 0; i < scene->gaussians.size(); ++i) {
        const auto p = i < dedupePrefix ? Vec3{1 + float(i) * .1f, 1, 1}
                                        : corners[(i - dedupePrefix) % corners.size()];
        auto &position = scene->gaussians[i].positionOpacity;
        position[0] = p.x; position[1] = p.y; position[2] = p.z;
    }
    fitBounds(*scene);
    return scene;
}
std::vector<uint8_t> dedupeStates(bool selected) {
    std::vector<uint8_t> states(dedupeCount);
    if (selected) std::fill_n(states.begin() + dedupePrefix + 8, 8, uint8_t(1));
    states[dedupePrefix + 20] = 2;
    return states;
}
std::vector<uint8_t> dedupeExpected(bool selected, bool last) {
    auto states = dedupeStates(selected);
    for (std::size_t i = 0; i < states.size(); ++i) {
        if (states[i] == 2 || (selected && states[i] != 1)) continue;
        if (i < dedupePrefix) continue;
        const auto local = i - dedupePrefix;
        const bool survives = selected ? (last ? local >= 12 && local < 16 : local >= 8 && local < 12)
                                       : (last ? local == 16 || local >= 21 : local < 4);
        if (!survives) states[i] = 2;
    }
    return states;
}
void dedupeAdmission() {
    constexpr auto count = dedupeCount;
    const auto mask = maskBytes(count);
    const auto original = duplicateScene();
    const auto states = dedupeStates(false);
    const auto expected = dedupeExpected(false, true);
    const auto recipe = operation("deduplicate", {{"position_threshold", .01f}, {"method", "last"}});
    std::size_t limit = mask, clusterPeak{};
    bool complete = false, bucketDenied = false, indexDenied = false, indexGrowthDenied = false;
    // Actual STL bucket/node sizes differ across libraries and debug modes.
    // Advance exactly to the next admission boundary reported by the ledger;
    // each retry starts with a fresh scene and an unchanged incoming mask.
    for (unsigned attempt = 0; attempt < 128 && !complete; ++attempt) {
        auto budget = workLimit(limit);
        {
            const auto source = duplicateScene(sceneMemoryForBudget(budget));
            const auto data = source->gaussians.data();
            const auto decoded = accountedSceneStorageBytes(*source, budget);
            try {
                const auto result = processScene(source, states, recipe, false, {}, {}, budget);
                require(result.scene == source && std::equal(result.states.begin(), result.states.end(), expected.begin()) &&
                            category(budget, ResourceCategory::Work) == mask,
                        "Budgeted last-occurrence dedupe must retain only its result mask after hash storage is destroyed");
                clusterPeak = budget.usage().peakBytes - decoded;
                complete = true;
            } catch (const ResourceBudgetExceeded &error) {
                const auto requested = error.requestedBytes(), available = error.availableBytes();
                require(requested > available && available <= limit && budget.usage().peakBytes >= decoded + mask,
                        "Dedupe denial must report the next physical allocation within its retained Work limit");
                bucketDenied |= requested >= count * sizeof(void *);
                indexDenied |= requested == sizeof(uint32_t);
                // Only the cell's uint32_t index vector can request these
                // small growing payloads; hash nodes contain at least a Cell.
                indexGrowthDenied |= indexDenied && requested > sizeof(uint32_t) &&
                                     requested < sizeof(std::array<int64_t, 3>);
                limit += requested - available;
            }
            require(source->gaussians.data() == data && sameScene(*source, *original) && states == dedupeStates(false),
                    "Dedupe denial or completion cannot mutate input geometry or its caller-owned mask");
            decodedOnly(budget, *source, "Every dedupe retry must unwind bucket, node, index and mutable-mask owners");
        }
        empty(budget, "A dedupe retry must release its final decoded input");
    }
    require(complete && bucketDenied && indexDenied && indexGrowthDenied,
            "Real dedupe processing must exercise bucket, first-index and growing-index Work denial boundaries");

    ResourceBudget distinct(allowance);
    {
        const auto source = budgetedScene(distinct, count);
        const std::vector<uint8_t> noEdits(count);
        {
            const auto result = processScene(source, noEdits, recipe, false, {}, {}, distinct);
            require(std::equal(result.states.begin(), result.states.end(), noEdits.begin()) && result.scene == source &&
                        distinct.usage().peakBytes - accountedSceneStorageBytes(*source, distinct) >=
                            clusterPeak + (count - dedupePrefix - 1) * sizeof(std::array<int64_t, 3>),
                    "Distinct-cell dedupe must admit each additional entry node beyond the shared bucket table");
        }
        decodedOnly(distinct, *source, "Distinct-cell dedupe must release all separately admitted entry nodes");
    }
    empty(distinct, "Distinct-cell dedupe must release its final input owner");
    for (bool selected : {false, true})
        for (bool last : {false, true}) {
            ResourceBudget budget(allowance);
            {
                const auto source = duplicateScene(sceneMemoryForBudget(budget));
                const auto incoming = dedupeStates(selected);
                const auto survivors = dedupeExpected(selected, last);
                const auto step = operation("deduplicate", {{"position_threshold", .01f}, {"method", last ? "last" : "first"}});
                const auto unbudgeted = processScene(original, incoming, step, selected);
                {
                    const auto result = processScene(source, incoming, step, selected, {}, {}, budget);
                    require(result.scene == source && sameResult(result, unbudgeted) &&
                                std::equal(result.states.begin(), result.states.end(), survivors.begin()) &&
                                category(budget, ResourceCategory::Work) == mask,
                            "Admitted dedupe must preserve first/last survivors, deleted records and selected-only scope");
                }
                decodedOnly(budget, *source, "Completed dedupe must release every node, bucket, index and result-mask grant");
            }
            empty(budget, "Completed dedupe must release its final captured scene");
        }
}
std::filesystem::path sceneReference(const std::filesystem::path &folder) {
    const auto path = folder / "reference.ply";
    const auto target = fixture(80, {}, .12f);
    writeVisibleScene(*target, std::vector<uint8_t>(target->gaussians.size()), path, SceneExportFormat::Ply);
    return path;
}
void referenceJobs(const std::filesystem::path &path) {
    constexpr std::size_t count = 48, referenceCount = 80;
    const auto mask = maskBytes(count);
    const auto states = selection(count);
    const auto active = selectedCount(states);
    const auto plain = fixture(count);
    const auto pathValue = pathUtf8(path);
    for (const char *type : {"match", "learn"}) {
        const bool learn = std::strcmp(type, "learn") == 0;
        auto recipe = operation(type, {{"path", pathValue}});
        if (learn) recipe["values"]["iterations"] = 2;
        // Reference decode now admits fitBounds scratch before its returned
        // samples/histograms. That earlier peak can exceed a later histogram
        // peak, and learn's argument evaluation order differs by compiler.
        // Advance using real ledger boundaries instead of claiming a fixed
        // aggregate limit necessarily targets a particular histogram column.
        // histogramAndAuto separately isolates the column/scales contracts.
        std::size_t limit = mask, rejections{};
        bool complete = false;
        for (unsigned attempt = 0; attempt < 128 && !complete; ++attempt) {
            auto constrained = workLimit(limit);
            {
                const auto source = budgetedScene(constrained, count);
                const auto *data = source->gaussians.data();
                try {
                    const auto result = processScene(source, states, recipe, true, {}, {}, constrained);
                    const auto expected = processScene(plain, states, recipe, true);
                    require(sameResult(result, expected) && category(constrained, ResourceCategory::Work) == mask &&
                                category(constrained, ResourceCategory::Source) == 0 &&
                                category(constrained, ResourceCategory::Image) == 0,
                            "Reference admission retries must reach the complete numerical result and release intermediate owners");
                    excludedUnchanged(*source, *result.scene, states);
                    complete = true;
                } catch (const ResourceBudgetExceeded &error) {
                    require(error.requestedBytes() > error.availableBytes() && error.availableBytes() <= limit,
                            "Reference rejection must report the next actual retained Work boundary");
                    limit = checkedByteSum({limit, error.requestedBytes() - error.availableBytes()});
                    ++rejections;
                }
                require(source->gaussians.data() == data && sameScene(*source, *plain) && states == selection(count),
                        "Every reference boundary must preserve source geometry, owner and caller selection");
                decodedOnly(constrained, *source,
                            "Each reference retry must release loaded reference, bounds, samples, histograms, output and mask");
            }
            empty(constrained, "Each constrained reference job must release its last input grant");
        }
        require(complete && rejections != 0,
                "Actual reference bounds/sample/histogram ownership must require additional Work before successful completion");
        ResourceBudget admitted(allowance);
        {
            const auto source = budgetedScene(admitted, count);
            const auto expected = processScene(plain, states, recipe, true);
            {
                const auto result = processScene(source, states, recipe, true, {}, {}, admitted);
                require(sameResult(result, expected) && category(admitted, ResourceCategory::Work) == mask &&
                            category(admitted, ResourceCategory::Source) == 0 &&
                            category(admitted, ResourceCategory::Image) == 0,
                        "Scene-reference and learned jobs must preserve numerical results and release all scratch at return");
                excludedUnchanged(*source, *result.scene, states);
                if (learn)
                    require(result.report["learned_color"].size() == 15 &&
                                result.report["final_loss"].get<float>() <= result.report["initial_loss"].get<float>() &&
                                admitted.usage().peakBytes >= accountedSceneStorageBytes(*source, admitted) +
                                    mask + referenceCount * 28 + active * 40,
                            "Learn must retain source/target samples while its mapped RGB and four columns are admitted");
            }
            decodedOnly(admitted, *source, "Reference completion must release its writable output and result mask");
        }
        empty(admitted, "Reference completion must release the last captured scene owner");
    }
    // Isolate learning's mapped histogram after a genuinely admitted scene
    // reference. One reference point keeps its measured bounds peak below
    // the later mapped RGB/column phase regardless of argument order.
    const auto singlePath = path.parent_path() / "reference-single.ply";
    const auto single = fixture(1, {}, .12f);
    writeVisibleScene(*single, std::array<uint8_t, 1>{}, singlePath, SceneExportFormat::Ply);
    ResourceBudget boundsProbe(allowance);
    auto decodedReference = loadScene(singlePath);
    fitBounds(decodedReference, sceneMemoryForBudget(boundsProbe, ResourceCategory::Work));
    const auto boundsPeak = boundsProbe.usage().peakBytes;
    empty(boundsProbe, "Independent single-reference bounds probe must release all scratch");
    SceneVector<std::array<float, 3>> sourceRgb, targetRgb;
    SceneVector<float> targetColumn, mappedColumn;
    sourceRgb.reserve(active); targetRgb.reserve(1); targetColumn.reserve(1); mappedColumn.reserve(active);
    const auto sourceBytes = sourceRgb.capacity() * sizeof(sourceRgb[0]);
    const auto targetBytes = targetRgb.capacity() * sizeof(targetRgb[0]);
    const auto targetColumns = 4 * targetColumn.capacity() * sizeof(float);
    const auto cap = checkedByteSum({mask, sourceBytes, targetBytes, targetColumns, sourceBytes});
    require(boundsPeak != 0 && checkedByteSum({mask, sourceBytes, boundsPeak}) < cap,
            "Learning histogram fixture must admit its independent full reference-bounds phase first");
    auto step = operation("learn", {{"path", pathUtf8(singlePath)}, {"iterations", 2}});
    auto rejected = workLimit(cap);
    {
        const auto source = budgetedScene(rejected, count);
        const auto error = denied([&] { processScene(source, states, step, true, {}, {}, rejected); },
                                  "Learning must admit mapped histogram columns in addition to its live RGB and target owners");
        require(error.requestedBytes() == mappedColumn.capacity() * sizeof(float) && error.availableBytes() == 0 &&
                    sameScene(*source, *plain),
                "Small-reference learning denial must reach its first mapped histogram column rather than reference bounds");
        decodedOnly(rejected, *source, "Mapped histogram denial must release source/target/mapped RGB, target columns and result mask");
    }
    empty(rejected, "Mapped histogram denial must release its final source grant");
    ResourceBudget retried(allowance);
    {
        const auto source = budgetedScene(retried, count);
        const auto expected = processScene(plain, states, step, true);
        {
            const auto result = processScene(source, states, step, true, {}, {}, retried);
            require(sameResult(result, expected) && category(retried, ResourceCategory::Work) == mask,
                    "The isolated learning retry must preserve its numerical result and returned mask ownership");
            excludedUnchanged(*source, *result.scene, states);
        }
        decodedOnly(retried, *source, "Isolated learning retry must release every temporary/output owner");
    }
    empty(retried, "Isolated learning retry must release its final source owner");
}
void put(std::vector<uint8_t> &bytes, std::size_t offset, uint32_t value, unsigned count = 4) {
    for (unsigned i = 0; i < count; ++i) bytes.at(offset + i) = uint8_t(value >> (8 * i));
}
std::vector<uint8_t> bmp(unsigned edge) {
    const auto stride = (std::size_t(edge) * 3 + 3) & ~std::size_t(3);
    std::vector<uint8_t> bytes(54 + stride * edge);
    bytes[0] = 'B'; bytes[1] = 'M'; put(bytes, 2, uint32_t(bytes.size())); put(bytes, 10, 54);
    put(bytes, 14, 40); put(bytes, 18, edge); put(bytes, 22, edge); put(bytes, 26, 1, 2); put(bytes, 28, 24, 2);
    for (unsigned y = 0; y < edge; ++y)
        for (unsigned x = 0; x < edge; ++x) {
            const auto at = 54 + std::size_t(edge - y - 1) * stride + x * 3;
            bytes[at] = uint8_t(35 + x * 5); bytes[at + 1] = uint8_t(50 + y * 4);
            bytes[at + 2] = uint8_t(80 + x * 3 + y * 2);
        }
    return bytes;
}
std::vector<uint8_t> read(const std::filesystem::path &path) {
    std::ifstream stream(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
}
void imageOwnerOverlap(const std::filesystem::path &folder) {
    constexpr std::size_t count = 8, edge = 64, pixels = edge * edge;
    const auto encoded = bmp(unsigned(edge));
    const auto path = folder / "reference.bmp";
    {
        std::ofstream stream(path, std::ios::binary | std::ios::trunc);
        stream.write(reinterpret_cast<const char *>(encoded.data()), std::streamsize(encoded.size()));
        require(bool(stream), "Independent reference BMP fixture must be writable");
    }
    const auto stamp = std::filesystem::last_write_time(path);
    const auto mask = maskBytes(count);
    const auto plain = fixture(count);
    const std::vector<uint8_t> states(count);
    const auto recipe = operation("match", {{"path", pathUtf8(path)}});
    // Full BMP decode needs Source + 4P Work + 4P Image, which fits. Once
    // decode returns, Source/decoder Work are gone but 4P Image must still be
    // live when imageSamples asks for 12P RGB. Omitting that owner would fit.
    // Use enough pixels to admit the pinned stb JPEG format-probe workspace
    // before BMP decoding; a smaller fixture can fail at that earlier probe.
    ResourceBudget rejected(count * sizeof(Gaussian) + mask + count * 16 + pixels * 16 - 1);
    {
        const auto source = budgetedScene(rejected, count);
        const auto error = denied([&] { processScene(source, states, recipe, false, {}, {}, rejected); },
                                  "Image pixels must remain admitted throughout RGB sample allocation");
        if (error.requestedBytes() != pixels * 12 || error.availableBytes() != pixels * 12 - 1)
            throw std::runtime_error("Image/sample total denial must occur at RGB allocation: requested=" +
                                     std::to_string(error.requestedBytes()) + ", available=" +
                                     std::to_string(error.availableBytes()) + ", expected requested=" +
                                     std::to_string(pixels * 12) + ", expected available=" +
                                     std::to_string(pixels * 12 - 1) + "; " + error.what());
        require(sameScene(*source, *plain), "Image sample denial must preserve the source scene");
        require(read(path) == encoded, "Image sample denial must preserve the reference bytes");
        require(std::filesystem::last_write_time(path) == stamp,
                "Image sample denial must preserve the reference modification time");
        decodedOnly(rejected, *source, "Image sample denial must release decoded pixels, source bytes and result mask");
    }
    empty(rejected, "Image sample denial must release the final captured scene");
    ResourceBudget admitted(allowance);
    {
        const auto source = budgetedScene(admitted, count);
        const auto expected = processScene(plain, states, recipe);
        {
            const auto result = processScene(source, states, recipe, false, {}, {}, admitted);
            require(sameResult(result, expected) && category(admitted, ResourceCategory::Work) == mask &&
                        category(admitted, ResourceCategory::Image) == 0 && category(admitted, ResourceCategory::Source) == 0 &&
                        admitted.usage().peakBytes >= accountedSceneStorageBytes(*source, admitted) +
                            mask + count * 16 + pixels * 28,
                    "Admitted image RGB and target histogram must retain their capacities without changing reference matching");
        }
        decodedOnly(admitted, *source, "Image matching must release all temporary and output owners at completion");
    }
    empty(admitted, "Image matching must release its final immutable input");
}
std::shared_ptr<Scene> floorScene(const ResourceBudget &budget) {
    auto scene = std::make_shared<Scene>(sceneMemoryForBudget(budget));
    scene->gaussians.reserve(160);
    for (unsigned i = 0; i < 160; ++i) {
        Attributes a;
        if (i < 144) {
            const auto x = i % 12, z = i / 12;
            a.position = {float(x) * .1f, 2 + float(x) * .03f - float(z) * .02f + std::sin(float(i)) * .00001f,
                          float(z) * .1f};
        } else a.position = {0, 3 + float(i % 4) * .2f, float(i % 8) * .15f};
        scene->gaussians.push_back(packGaussian(a));
    }
    fitBounds(*scene);
    return scene;
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
bool samePlane(const std::optional<FloorPlane> &a, const std::optional<FloorPlane> &b) {
    return a && b && a->normal == b->normal && a->center == b->center && a->radius == b->radius &&
           a->rms == b->rms && a->inliers == b->inliers && a->tested == b->tested;
}
void floorAdmission() {
    constexpr std::size_t samples = 64, points = samples * sizeof(std::array<double, 3>), axis = samples * sizeof(double);
    FloorOptions options{0, 400, unsigned(samples), {}};
    options.viewpoint = Vec3{0, 10, 0};
    for (const auto limit : {std::size_t(0), points}) {
        auto budget = workLimit(limit);
        {
            const auto scene = floorScene(budget);
            const auto memory = std::make_shared<ObservedMemory>(budget);
            const auto error = denied([&] { detectFloor(*scene, {}, false, options, {}, memory); },
                                      "Floor reservoir and automatic-threshold axis must each require Work admission");
            require(error.requestedBytes() == (limit ? axis : points) && error.availableBytes() == 0 &&
                        memory->requests.size() == (limit ? 2u : 1u),
                    "Floor rejection must distinguish its reservoir from the extra automatic-threshold axis");
            decodedOnly(budget, *scene, "Rejected floor detection must release its entire sampled scratch");
        }
        empty(budget, "Rejected floor detection must release its final scene owner");
    }
    for (bool automatic : {false, true}) {
        auto budget = workLimit(points + (automatic ? axis : 0));
        {
            const auto scene = floorScene(budget);
            auto settings = options;
            if (!automatic) settings.threshold = .001f;
            const auto memory = std::make_shared<ObservedMemory>(budget);
            const auto expected = detectFloor(*scene, {}, false, settings);
            const auto plane = detectFloor(*scene, {}, false, settings, {}, memory);
            require(samePlane(plane, expected) && plane->tested == samples && plane->normal.y > .9f &&
                        memory->requests == (automatic ? std::vector<std::size_t>{points, axis}
                                                       : std::vector<std::size_t>{points}) &&
                        budget.usage().peakBytes == accountedSceneStorageBytes(*scene, budget) + points + (automatic ? axis : 0),
                    "Floor Work capacity must match its active algorithm without changing the deterministic fitted plane");
            std::vector<uint8_t> states(scene->gaussians.size(), 2);
            std::fill_n(states.begin(), 144, uint8_t(1));
            require(samePlane(detectFloor(*scene, states, true, settings),
                              detectFloor(*scene, states, true, settings, {}, memory)),
                    "Admitted floor scratch must preserve selected/deleted-mask sampling and its deterministic plane");
            decodedOnly(budget, *scene, "Successful floor detection must release reservoir and axis before returning its plane");
        }
        empty(budget, "Successful floor detection must release its captured scene");
    }
    for (std::size_t stage : {std::size_t(0), std::size_t(1), std::size_t(2)}) {
        auto budget = workLimit(stage ? points + axis : 0);
        {
            const auto scene = floorScene(budget);
            const auto memory = std::make_shared<ObservedMemory>(budget);
            std::stop_source stop;
            if (!stage) stop.request_stop();
            else { memory->stop = &stop; memory->stopAt = stage; }
            require(!detectFloor(*scene, {}, false, options, stop.get_token(), memory) &&
                        memory->requests.size() == stage &&
                        budget.usage().peakBytes == accountedSceneStorageBytes(*scene, budget) +
                            (stage ? points : 0) + (stage == 2 ? axis : 0),
                    "Precancel and deterministic stops at each floor allocation must prevent publication and release live grants");
            decodedOnly(budget, *scene, "Cancelled floor detection must release all scratch while preserving its scene");
        }
        empty(budget, "Cancelled floor detection must release its last scene reference");
    }
}
void precancel(const std::filesystem::path &reference) {
    auto budget = workLimit(0);
    {
        const auto scene = budgetedScene(budget, 48);
        const auto original = fixture(48);
        const auto states = selection(48);
        const auto bytes = budget.usage().totalBytes;
        std::stop_source stop;
        stop.request_stop();
        for (const char *type : {"auto", "histogram", "match", "learn"}) {
            bool stopped = false;
            try { processScene(scene, states, operation(type, {{"path", pathUtf8(reference)}}), true,
                               stop.get_token(), {}, budget); }
            catch (const ResourceBudgetExceeded &) {
                throw std::runtime_error("Precancelled processing must stop before allocating even its result mask");
            } catch (const std::runtime_error &) { stopped = true; }
            require(stopped && sameScene(*scene, *original) && budget.usage().totalBytes == bytes &&
                        budget.usage().peakBytes == bytes,
                    "Precancelled analysis/reference jobs must preserve input and never acquire Work or side-input grants");
        }
        decodedOnly(budget, *scene, "Precancelled processing must retain only its immutable input");
    }
    empty(budget, "Precancelled processing must release its last immutable input");
}
} // namespace

void processingScratchContracts(const std::filesystem::path &directory) {
    const auto folder = directory / "processing-scratch";
    std::filesystem::create_directories(folder);
    histogramAndAuto();
    scaleGrowth();
    dedupeAdmission();
    const auto reference = sceneReference(folder);
    referenceJobs(reference);
    imageOwnerOverlap(folder);
    floorAdmission();
    precancel(reference);
}
