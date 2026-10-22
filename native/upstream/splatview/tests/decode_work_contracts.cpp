#include "decode_work_contracts.hpp"
#include "file_io.hpp"
#include "math.hpp"
#include "model.hpp"
#include "resource_budget.hpp"
#include <load-spz.h>
#include <nlohmann/json.hpp>
#include <webp/decode.h>
#include <zlib.h>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace preview;
namespace {
using Bytes = std::vector<uint8_t>;
using Json = nlohmann::json;
using Members = std::map<std::string, Bytes>;
constexpr std::size_t allowance = 64 * 1024 * 1024;
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error = std::exception, class F>
std::string rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const Error &error) { return error.what(); }
    throw std::runtime_error(message);
}
template<class T> T number(std::span<const uint8_t> bytes, std::size_t offset) {
    require(offset <= bytes.size() && sizeof(T) <= bytes.size() - offset, "Test archive field is truncated");
    T result;
    std::memcpy(&result, bytes.data() + offset, sizeof(T));
    return result;
}
template<class T> void append(Bytes &bytes, T value) {
    const auto encoded = std::bit_cast<std::array<uint8_t, sizeof(T)>>(value);
    bytes.insert(bytes.end(), encoded.begin(), encoded.end());
}
template<class T> void put(Bytes &bytes, std::size_t offset, T value) {
    require(offset <= bytes.size() && sizeof(T) <= bytes.size() - offset, "Test mutation must stay in its archive field");
    std::memcpy(bytes.data() + offset, &value, sizeof(T));
}
void write(const std::filesystem::path &path, const Bytes &bytes) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
    require(bool(stream), "Decoder work fixture must be written completely");
}
Bytes read(const std::filesystem::path &path) {
    FileSnapshot source(path, allowance);
    return {source.bytes().begin(), source.bytes().end()};
}
std::size_t category(const ResourceBudget &budget, ResourceCategory kind) {
    return budget.usage().categoryBytes[std::size_t(kind)];
}
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto bytes : usage.categoryBytes) require(bytes == 0, message);
}
LoadOptions optionsFor(const ResourceBudget &budget, std::size_t maxSplats = 3'000'000) {
    LoadOptions options; options.resources = budget; options.maxSplats = maxSplats;
    return options;
}
ResourceBudget workBudget(std::size_t bytes) {
    ResourceLimits limits; limits.totalBytes = allowance;
    limits.categoryBytes[std::size_t(ResourceCategory::Work)] = bytes;
    return ResourceBudget(limits);
}
bool samePayload(const Scene &left, const Scene &right) {
    return left.gaussians.size() == right.gaussians.size() &&
        std::memcmp(left.gaussians.data(), right.gaussians.data(), left.gaussians.size() * sizeof(Gaussian)) == 0 &&
        left.sourceCount == right.sourceCount && left.shDegree == right.shDegree && left.format == right.format &&
        left.center == right.center && left.radius == right.radius;
}
bool same(const Scene &left, const Scene &right) {
    return samePayload(left, right) && left.sourceContentKey == right.sourceContentKey;
}
// Observe the standalone Scene algorithm rather than reproducing its vector
// growth factors. Decoder raw storage is gone before this distinct phase runs.
std::size_t boundsScratchPeak(const Scene &source) {
    struct State { std::size_t live{}, peak{}, requests{}; };
    struct Grant {
        std::shared_ptr<State> state;
        std::size_t bytes;
        Grant(std::shared_ptr<State> value, std::size_t size) noexcept : state(std::move(value)), bytes(size) {
            state->live += bytes;
            state->peak = std::max(state->peak, state->live);
            ++state->requests;
        }
        ~Grant() { state->live -= bytes; }
    };
    class Memory final : public SceneMemory {
      public:
        explicit Memory(std::shared_ptr<State> value) : state(std::move(value)) {}
        std::shared_ptr<void> admit(std::size_t bytes) override { return std::make_shared<Grant>(state, bytes); }
        std::shared_ptr<State> state;
    };
    auto state = std::make_shared<State>();
    auto memory = std::make_shared<Memory>(state);
    auto scene = source;
    fitBounds(scene, memory);
    require(state->requests >= 6 && state->peak != 0 && state->live == 0 && samePayload(scene, source),
            "Independent bounds probe must observe and release real scratch without changing reference metadata");
    return state->peak;
}
// Independent test ZIP reader/writer: admission changes must preserve stored
// and raw-deflated archives with the same exact compressed member contents.
Members archiveMembers(std::span<const uint8_t> bytes) {
    require(bytes.size() >= 22, "Generated ZIP must contain an end-of-central-directory record");
    const auto firstEnd = bytes.size() > 22 + 65535 ? bytes.size() - 22 - 65535 : 0;
    auto end = bytes.size() - 22;
    bool foundEnd = false;
    for (;;) {
        if (number<uint32_t>(bytes, end) == 0x06054b50 &&
            number<uint16_t>(bytes, end + 20) == bytes.size() - end - 22) {
            foundEnd = true;
            break;
        }
        if (end == firstEnd) break;
        --end;
    }
    require(foundEnd, "Generated ZIP must have a bounded complete central directory");
    const auto count = number<uint16_t>(bytes, end + 10);
    require(number<uint16_t>(bytes, end + 4) == 0 && number<uint16_t>(bytes, end + 6) == 0 &&
                number<uint16_t>(bytes, end + 8) == count && count != 0xffff,
            "Test ZIP reader accepts only single-disk non-ZIP64 fixtures");
    const std::size_t directory = number<uint32_t>(bytes, end + 16);
    const std::size_t directorySize = number<uint32_t>(bytes, end + 12);
    require(directory <= end && directorySize == end - directory,
            "Generated ZIP central directory extent must agree with its end record");
    const auto contains = [](std::size_t offset, std::size_t size, std::size_t limit) {
        return offset <= limit && size <= limit - offset;
    };
    Members members;
    std::size_t offset = directory, totalExpanded = 0;
    for (unsigned index = 0; index < count; ++index) {
        require(contains(offset, 46, end) && number<uint32_t>(bytes, offset) == 0x02014b50,
                "Generated ZIP central member record is truncated or invalid");
        const auto flags = number<uint16_t>(bytes, offset + 8), method = number<uint16_t>(bytes, offset + 10);
        const auto checksum = number<uint32_t>(bytes, offset + 16);
        const auto compressed = number<uint32_t>(bytes, offset + 20), expanded = number<uint32_t>(bytes, offset + 24);
        const auto nameSize = number<uint16_t>(bytes, offset + 28), extra = number<uint16_t>(bytes, offset + 30);
        const auto comment = number<uint16_t>(bytes, offset + 32);
        const std::size_t local = number<uint32_t>(bytes, offset + 42);
        const std::size_t recordSize = 46 + std::size_t(nameSize) + extra + comment;
        require(contains(offset, recordSize, end) && number<uint16_t>(bytes, offset + 34) == 0 &&
                    local != 0xffffffff && compressed != 0xffffffff && expanded != 0xffffffff && !(flags & 1),
                "Generated ZIP central member must be complete, unencrypted and non-ZIP64");
        require(compressed <= allowance && expanded <= allowance - totalExpanded,
                "Independent test ZIP reader must bound fixture allocation sizes");
        totalExpanded += expanded;
        const std::string name(reinterpret_cast<const char *>(bytes.data() + offset + 46), nameSize);
        require(contains(local, 30, directory) && number<uint32_t>(bytes, local) == 0x04034b50 &&
                    number<uint16_t>(bytes, local + 6) == flags && number<uint16_t>(bytes, local + 8) == method,
                "Generated ZIP local record must match central flags and method");
        const auto localName = number<uint16_t>(bytes, local + 26), localExtra = number<uint16_t>(bytes, local + 28);
        const std::size_t localSize = 30 + std::size_t(localName) + localExtra;
        require(contains(local, localSize, directory) && localName == nameSize &&
                    std::memcmp(bytes.data() + local + 30, name.data(), nameSize) == 0,
                "Generated ZIP local name and extent must match the central record");
        const auto start = local + localSize;
        require(contains(start, compressed, directory), "Generated ZIP payload is truncated");
        if (flags & 8) {
            // Streamed writers may leave all local sizes/CRC zero. The central
            // record is authoritative; the descriptor may carry a signature.
            const auto descriptor = start + compressed;
            const auto matches = [&](std::size_t at) {
                return contains(at, 12, directory) && number<uint32_t>(bytes, at) == checksum &&
                    number<uint32_t>(bytes, at + 4) == compressed && number<uint32_t>(bytes, at + 8) == expanded;
            };
            require(matches(descriptor) ||
                        (contains(descriptor, 16, directory) && number<uint32_t>(bytes, descriptor) == 0x08074b50 &&
                         matches(descriptor + 4)),
                    "Generated ZIP streamed member descriptor must agree with central CRC and sizes");
            require((number<uint32_t>(bytes, local + 14) == 0 || number<uint32_t>(bytes, local + 14) == checksum) &&
                        (number<uint32_t>(bytes, local + 18) == 0 || number<uint32_t>(bytes, local + 18) == compressed) &&
                        (number<uint32_t>(bytes, local + 22) == 0 || number<uint32_t>(bytes, local + 22) == expanded),
                    "Generated ZIP streamed local metadata must be zero or match the central record");
        } else {
            require(number<uint32_t>(bytes, local + 14) == checksum &&
                        number<uint32_t>(bytes, local + 18) == compressed && number<uint32_t>(bytes, local + 22) == expanded,
                    "Generated ZIP local CRC and sizes must agree with the central record");
        }
        Bytes data(std::max(expanded, 1u));
        if (method == 0) {
            require(compressed == expanded, "Stored ZIP fixture sizes must agree");
            data.assign(bytes.begin() + start, bytes.begin() + start + expanded);
        } else {
            require(method == 8, "Test reader only accepts stored/raw-deflate ZIP members");
            z_stream stream{};
            require(inflateInit2(&stream, -MAX_WBITS) == Z_OK, "Test ZIP inflate must initialize");
            stream.next_in = const_cast<Bytef *>(bytes.data() + start); stream.avail_in = compressed;
            stream.next_out = data.data(); stream.avail_out = static_cast<uInt>(data.size());
            const auto result = inflate(&stream, Z_FINISH);
            const auto consumed = stream.total_in, produced = stream.total_out;
            inflateEnd(&stream);
            require(result == Z_STREAM_END && consumed == compressed && produced == expanded,
                    "Independent test ZIP reader must consume the complete member");
            data.resize(expanded);
        }
        require(crc32(0, data.data(), static_cast<uInt>(data.size())) == checksum,
                "Independent test ZIP reader must validate member CRC");
        require(members.emplace(name, std::move(data)).second, "Generated ZIP fixture must have distinct names");
        offset += recordSize;
    }
    require(offset == end, "Independent test ZIP reader must consume the complete central directory");
    return members;
}
Bytes zip(const Members &members, bool deflated) {
    Bytes bytes, directory;
    for (const auto &[name, data] : members) {
        Bytes payload = data;
        if (deflated) {
            payload.resize(compressBound(static_cast<uLong>(data.size())));
            z_stream stream{};
            require(deflateInit2(&stream, 6, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY) == Z_OK,
                    "Test raw-deflate encoder must initialize");
            stream.next_in = const_cast<Bytef *>(data.data()); stream.avail_in = static_cast<uInt>(data.size());
            stream.next_out = payload.data(); stream.avail_out = static_cast<uInt>(payload.size());
            const auto result = deflate(&stream, Z_FINISH);
            const auto produced = stream.total_out;
            deflateEnd(&stream);
            require(result == Z_STREAM_END, "Test raw-deflate encoder must complete");
            payload.resize(produced);
        }
        const auto local = static_cast<uint32_t>(bytes.size());
        const auto checksum = static_cast<uint32_t>(crc32(0, data.data(), static_cast<uInt>(data.size())));
        append<uint32_t>(bytes, 0x04034b50); append<uint16_t>(bytes, 20); append<uint16_t>(bytes, 0);
        append<uint16_t>(bytes, deflated ? 8 : 0); append<uint32_t>(bytes, 0); append(bytes, checksum);
        append<uint32_t>(bytes, static_cast<uint32_t>(payload.size())); append<uint32_t>(bytes, static_cast<uint32_t>(data.size()));
        append<uint16_t>(bytes, static_cast<uint16_t>(name.size())); append<uint16_t>(bytes, 0);
        bytes.insert(bytes.end(), name.begin(), name.end()); bytes.insert(bytes.end(), payload.begin(), payload.end());
        append<uint32_t>(directory, 0x02014b50); append<uint16_t>(directory, 20); append<uint16_t>(directory, 20);
        append<uint16_t>(directory, 0); append<uint16_t>(directory, deflated ? 8 : 0); append<uint32_t>(directory, 0);
        append(directory, checksum); append<uint32_t>(directory, static_cast<uint32_t>(payload.size()));
        append<uint32_t>(directory, static_cast<uint32_t>(data.size())); append<uint16_t>(directory, static_cast<uint16_t>(name.size()));
        for (unsigned i = 0; i < 4; ++i) append<uint16_t>(directory, 0);
        append<uint32_t>(directory, 0); append(directory, local); directory.insert(directory.end(), name.begin(), name.end());
    }
    const auto offset = static_cast<uint32_t>(bytes.size());
    bytes.insert(bytes.end(), directory.begin(), directory.end()); append<uint32_t>(bytes, 0x06054b50);
    append<uint32_t>(bytes, 0); append<uint16_t>(bytes, static_cast<uint16_t>(members.size()));
    append<uint16_t>(bytes, static_cast<uint16_t>(members.size())); append<uint32_t>(bytes, static_cast<uint32_t>(directory.size()));
    append(bytes, offset); append<uint16_t>(bytes, 0);
    return bytes;
}
Bytes legacySpz(unsigned version) {
    constexpr unsigned count = 8;
    if (version == 1) {
        Bytes raw;
        append<uint32_t>(raw, spz::NGSP_MAGIC); append<uint32_t>(raw, 1); append<uint32_t>(raw, count);
        raw.insert(raw.end(), {0, 12, 0, 0});
        for (unsigned i = 0; i < count; ++i)
            for (float value : {float(i) / 8, .25f, -.5f})
                append<uint16_t>(raw, DirectX::PackedVector::XMConvertFloatToHalf(value));
        raw.insert(raw.end(), count, 200); raw.insert(raw.end(), count * 3, 128);
        raw.insert(raw.end(), count * 3, 100); raw.insert(raw.end(), count * 3, 128);
        Bytes compressed;
        require(spz::compressGzipped(raw.data(), raw.size(), &compressed), "Independent SPZ v1 fixture must encode");
        return compressed;
    }
    spz::GaussianCloud cloud; cloud.numPoints = count; cloud.shDegree = 3;
    for (unsigned i = 0; i < count; ++i) {
        cloud.positions.insert(cloud.positions.end(), {float(i) / 8, .25f, -.5f});
        cloud.scales.insert(cloud.scales.end(), 3, std::log(.03f));
        cloud.rotations.insert(cloud.rotations.end(), {0, 0, 0, 1});
        cloud.alphas.push_back(std::log(4.f)); cloud.colors.insert(cloud.colors.end(), {.1f, -.2f, .3f});
        cloud.sh.insert(cloud.sh.end(), 45, .015f);
    }
    spz::PackOptions options; options.version = version; options.from = spz::CoordinateSystem::RUB;
    Bytes compressed;
    require(spz::saveSpz(cloud, options, &compressed), "Reference SPZ v2/v3 fixture must encode");
    return compressed;
}
void legacyAdmission(const std::filesystem::path &directory) {
    for (unsigned version : {1u, 2u, 3u}) {
        const auto bytes = legacySpz(version), original = bytes;
        const auto path = directory / ("work-legacy-v" + std::to_string(version) + ".spz");
        write(path, bytes);
        const auto expanded = number<uint32_t>(bytes, bytes.size() - 4);
        const auto expected = loadScene(bytes);
        const auto boundsPeak = boundsScratchPeak(expected);
        const auto workPeak = std::max<std::size_t>(expanded, boundsPeak);
        auto budget = workBudget(workPeak);
        {
            auto scene = loadScene(path, optionsFor(budget));
            require(same(scene, expected) && scene.sourceCount == 8 && std::abs(scene.gaussians[0].positionOpacity[1] - .25f) < .001f,
                    "Admitted legacy SPZ must preserve reference-codec output and independently known coordinates");
            require(category(budget, ResourceCategory::Work) == 0 && category(budget, ResourceCategory::Source) == 0 &&
                        budget.usage().totalBytes == accountedSceneStorageBytes(scene, budget) &&
                        budget.usage().peakBytes == bytes.size() + workPeak + accountedSceneStorageBytes(scene, budget),
                    "Legacy Source/Decoded overlap with the larger actual raw-or-bounds Work phase, then retain only output");
        }
        empty(budget, "Legacy raw output and returned scene must release their own lifetime grants");
        auto denied = workBudget(expanded - 1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path, optionsFor(denied, 1)); },
                                        "Sampling one splat must not bypass admission of the complete legacy inflate buffer");
        empty(denied, "Denied legacy inflate must release its already captured source");
        require(denied.usage().peakBytes == bytes.size(), "Rejected raw admission must precede payload/output allocation");
        auto corrupt = bytes; corrupt[corrupt.size() - 8] ^= 1;
        const auto error = rejects([&] { loadScene(corrupt, optionsFor(budget)); }, "Legacy gzip CRC corruption must still reject");
        require(error.find("Invalid compressed SPZ payload") != std::string::npos && budget.usage().peakBytes >= expanded,
                "Legacy corruption must fail through the existing complete-inflate validation after admission");
        empty(budget, "Legacy corruption must release the full raw allocation");
        auto trailing = bytes; trailing.insert(trailing.end() - 8, 0);
        rejects([&] { loadScene(trailing, optionsFor(budget)); }, "Legacy gzip must reject extra unconsumed data");
        empty(budget, "Legacy consumption failure must roll back every work grant");
        require(bytes == original && read(path) == original, "Admission and corrupt derivatives must preserve source bytes");
    }
}
std::size_t planeBytes(const Members &members) {
    std::size_t total = 0;
    for (const auto &[name, bytes] : members) if (name.ends_with(".webp")) {
        int width{}, height{};
        require(WebPGetInfo(bytes.data(), bytes.size(), &width, &height) && width > 0 && height > 0,
                "Generated SOG texture dimensions must be independently readable");
        total = checkedByteSum({total, imagePayloadBytes(unsigned(width), unsigned(height))});
    }
    return total;
}
void archiveAdmission(const std::filesystem::path &directory, Members members) {
    // An empty deflated member still needs a one-byte inflate destination. Its
    // retained capacity, rather than zero logical size, must be charged.
    members["unused.bin"] = {};
    const auto planes = planeBytes(members);
    const auto canonical = loadScene(zip(members, false));
    std::size_t inflated = 0;
    for (const auto &[name, bytes] : members) { (void)name; inflated += std::max<std::size_t>(bytes.size(), 1); }
    for (bool deflated : {false, true}) {
        const auto bytes = zip(members, deflated), original = bytes;
        const auto path = directory / (deflated ? "work-deflated.sog" : "work-stored.sog");
        write(path, bytes);
        const auto scratch = planes + (deflated ? inflated : 0);
        auto budget = workBudget(scratch);
        {
            auto scene = loadScene(path, optionsFor(budget));
            const auto expected = loadScene(bytes);
            require(same(scene, expected) && samePayload(scene, canonical),
                    "Tracked SOG work must preserve exact unbudgeted output and equivalent stored/deflated payloads");
            require(category(budget, ResourceCategory::Work) == 0 && category(budget, ResourceCategory::Source) == 0 &&
                        budget.usage().totalBytes == accountedSceneStorageBytes(scene, budget) &&
                        budget.usage().peakBytes == bytes.size() + scratch + accountedSceneStorageBytes(scene, budget),
                    "SOG must overlap source, every live inflated member/RGBA plane and final output without charging stored spans");
        }
        empty(budget, "Successful SOG decode must release all temporary work before its output's last owner dies");
        auto denied = workBudget(scratch - 1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path, optionsFor(denied, 1)); },
                                        "Sampled SOG output must still admit every complete input texture plane");
        empty(denied, "Partial SOG scratch construction must roll back earlier members, planes and source");
        ResourceLimits limits; limits.totalBytes = allowance;
        limits.categoryBytes[std::size_t(ResourceCategory::Decoded)] = sizeof(Gaussian) - 1;
        ResourceBudget noOutput(limits);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path, optionsFor(noOutput, 1)); },
                                        "SOG final-output rejection must occur while every scratch owner remains alive");
        require(noOutput.usage().peakBytes == bytes.size() + scratch,
                "Final-output rejection must observe full source/scratch overlap and no allocated Gaussian payload");
        empty(noOutput, "Decoded rejection must release every earlier SOG scratch owner");
        auto corrupt = bytes;
        const auto eocd = corrupt.size() - 22;
        std::size_t central = number<uint32_t>(corrupt, eocd + 16), last = central;
        for (std::size_t i = 0; i < members.size(); ++i) {
            last = central;
            central += 46 + number<uint16_t>(corrupt, central + 28) + number<uint16_t>(corrupt, central + 30) + number<uint16_t>(corrupt, central + 32);
        }
        put<uint32_t>(corrupt, last + 16, number<uint32_t>(corrupt, last + 16) ^ 1u);
        const auto error = rejects([&] { loadScene(corrupt, optionsFor(budget)); }, "A later ZIP CRC failure must reject the whole archive");
        require(error.find("checksum mismatch") != std::string::npos,
                "ZIP corruption must preserve existing checksum error semantics");
        empty(budget, "A later ZIP failure must release every previously inflated member");
        require(bytes == original && read(path) == original, "SOG admission failures must preserve original archive bytes");
    }
}
void malformedMetadataAndTexture(const Members &members) {
    auto invalid = members;
    auto metadata = Json::parse(invalid.at("meta.json"));
    const auto replaceMetadata = [&](const Json &value) {
        const auto text = value.dump(); invalid["meta.json"] = Bytes(text.begin(), text.end());
    };
    for (const auto *key : {"scales", "sh0", "shN"}) {
        auto changed = metadata; changed[key]["codebook"] = std::vector<float>(257);
        replaceMetadata(changed);
        auto budget = workBudget(0);
        const auto error = rejects([&] { loadScene(zip(invalid, false), optionsFor(budget)); },
                                   "Oversized codebook must reject before a secondary vector or texture allocation");
        require(error.find("codebook size") != std::string::npos && budget.usage().peakBytes == 0,
                "Codebook shape validation must precede Work allocation");
        empty(budget, "Malformed codebook must not acquire decoder work grants");
    }
    auto changed = metadata; changed["means"]["mins"] = std::vector<float>(4096);
    replaceMetadata(changed);
    auto budget = workBudget(allowance);
    rejects([&] { loadScene(zip(invalid, false), optionsFor(budget)); }, "Oversized position bounds must reject before conversion");
    require(budget.usage().peakBytes == 0, "Fixed-length SOG arrays must reject before decoding planes");
    empty(budget, "Malformed fixed-length arrays must release all work");

    invalid = members;
    const auto textureName = metadata.at("sh0").at("files").at(0).get<std::string>();
    auto &badTexture = invalid.at(textureName);
    bool found = false;
    for (std::size_t size = badTexture.size() - 1; size > 12; --size) {
        int width{}, height{};
        if (!WebPGetInfo(badTexture.data(), size, &width, &height)) continue;
        Bytes pixels(imagePayloadBytes(unsigned(width), unsigned(height)));
        if (!WebPDecodeRGBAInto(badTexture.data(), size, pixels.data(), pixels.size(), width * 4)) {
            badTexture.resize(size); found = true; break;
        }
    }
    require(found, "Truncated texture fixture must retain valid dimensions but fail after RGBA allocation");
    const auto error = rejects([&] { loadScene(zip(invalid, false), optionsFor(budget)); },
                               "WebP payload failure after admitted planes must reject without publishing output");
    require(error.find("WebP decoding failed") != std::string::npos && budget.usage().peakBytes > 0,
            "Texture fixture must exercise failure after RGBA allocation rather than header preflight");
    empty(budget, "Failed later texture must release its allocation and every previously decoded plane");

    auto legacy = metadata; legacy["version"] = 1; legacy["means"]["shape"] = {8, 3, 4};
    invalid = members; replaceMetadata(legacy);
    auto noWork = workBudget(0);
    const auto shapeError = rejects([&] { loadScene(zip(invalid, false), optionsFor(noWork)); },
                                    "Legacy position shape must be checked before vector conversion");
    require(shapeError.find("position shape") != std::string::npos && noWork.usage().peakBytes == 0,
            "Malformed legacy shape must reject without decoding textures");
}
void preCancelled(const std::filesystem::path &directory, const Members &members) {
    std::stop_source cancellation; cancellation.request_stop();
    ResourceBudget budget(allowance);
    auto options = optionsFor(budget); options.stop = cancellation.get_token();
    for (const auto &bytes : {legacySpz(1), legacySpz(2), legacySpz(3), zip(members, false), zip(members, true)}) {
        const auto before = bytes;
        rejects([&] { loadScene(bytes, options); }, "Pre-cancelled scratch decode must not allocate work or output");
        require(bytes == before, "Cancellation must preserve the caller's compressed source");
    }
    rejects([&] { loadScene(directory / "demo.sog", options); }, "Pre-cancelled path must not capture source storage");
    empty(budget, "Pre-cancelled format work must leave all resource categories empty");
    require(budget.usage().peakBytes == 0, "Stop admission must precede every source/work/output allocation");
}
} // namespace
void decodeWorkContracts(const std::filesystem::path &directory) {
    const auto fixtures = directory / "decode-work";
    std::filesystem::create_directories(fixtures);
    const auto members = archiveMembers(read(directory / "demo.sog"));
    legacyAdmission(fixtures);
    archiveAdmission(fixtures, members);
    malformedMetadataAndTexture(members);
    preCancelled(directory, members);
}
