#include "io_contracts.hpp"
#include "scene_exports.hpp"
#include <load-spz.h>
#include <zlib.h>
#include <algorithm>
#include <bit>
#include <cstring>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <thread>

using namespace preview;
namespace {
using Bytes = std::vector<uint8_t>;
void require(bool ok, const char *message) {
    if (!ok)
        throw std::runtime_error(message);
}
template <class Function> void rejects(Function action) {
    bool failed = false;
    try {
        action();
    } catch (const std::exception &) {
        failed = true;
    }
    require(failed, "Invalid or cancelled I/O was accepted");
}
struct Fixture {
    Bytes bytes;
    size_t body{}, stride{};
};
Fixture largePly(std::span<const uint8_t> source, size_t sourceCount, size_t count = 67'003) {
    std::string header(reinterpret_cast<const char *>(source.data()), source.size());
    const size_t body = header.find("end_header\n") + std::strlen("end_header\n");
    require(body > std::strlen("end_header\n") && body < source.size(), "PLY test fixture header");
    header.resize(body);
    const size_t stride = (source.size() - body) / sourceCount;
    require(stride == 59 * sizeof(float), "PLY test fixture layout");
    const auto vertex = header.find("element vertex ");
    header.replace(vertex, header.find('\n', vertex) - vertex, "element vertex " + std::to_string(count));
    if (header.size() % 4 == 0)
        header.insert(header.find("end_header"), "comment x\n");
    Fixture result{{header.begin(), header.end()}, header.size(), stride};
    result.bytes.reserve(result.body + count * stride);
    for (size_t i = 0; i < count; ++i) {
        const auto row = source.subspan(body + (i % sourceCount) * stride, stride);
        result.bytes.insert(result.bytes.end(), row.begin(), row.end());
        // The fixture order is opacity,z,x,y,...; give every row a unique x.
        const float x = float(i) * .001f;
        std::memcpy(result.bytes.data() + result.body + i * stride + 8, &x, sizeof(x));
    }
    return result;
}
Fixture alternatePly(const Fixture &source, bool big) {
    std::string header(source.bytes.begin(), source.bytes.begin() + source.body);
    if (big) {
        const std::string encoding = "binary_little_endian";
        header.replace(header.find(encoding), encoding.size(), "binary_big_endian");
    } else {
        const std::string property = "property float x\n";
        header.replace(header.find(property), property.size(), "property double x\n");
        header.insert(header.find("end_header"), "property uchar unused\n");
    }
    Fixture result{{header.begin(), header.end()}, header.size(), source.stride + (big ? 0 : 5)};
    for (size_t start = source.body; start < source.bytes.size(); start += source.stride) {
        if (big) {
            for (size_t j = 0; j < source.stride; j += 4)
                for (int byte = 3; byte >= 0; --byte)
                    result.bytes.push_back(source.bytes[start + j + byte]);
        } else {
            result.bytes.insert(result.bytes.end(), source.bytes.begin() + start,
                                source.bytes.begin() + start + 8);
            float x;
            std::memcpy(&x, source.bytes.data() + start + 8, sizeof(x));
            const auto bytes = std::bit_cast<std::array<uint8_t, 8>>(double(x));
            result.bytes.insert(result.bytes.end(), bytes.begin(), bytes.end());
            result.bytes.insert(result.bytes.end(), source.bytes.begin() + start + 12,
                                source.bytes.begin() + start + source.stride);
            result.bytes.push_back(37);
        }
    }
    return result;
}
Bytes read(const std::filesystem::path &path) {
    std::ifstream file(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(file), {}};
}
Bytes inflateSingle(std::span<const uint8_t> bytes, size_t expected) {
    Bytes raw(expected + 1);
    z_stream stream{};
    require(inflateInit2(&stream, MAX_WBITS + 16) == Z_OK, "Initialize independent gzip decoder");
    stream.next_in = const_cast<Bytef *>(bytes.data());
    stream.avail_in = static_cast<uInt>(bytes.size());
    stream.next_out = raw.data();
    stream.avail_out = static_cast<uInt>(raw.size());
    const int code = inflate(&stream, Z_FINISH);
    const auto consumed = stream.total_in, produced = stream.total_out;
    inflateEnd(&stream);
    require(code == Z_STREAM_END && consumed == bytes.size() && produced == expected,
            "Parallel compression produces one complete gzip member with valid CRC and size");
    raw.resize(expected);
    return raw;
}
} // namespace
void fusedDecodeContracts(std::span<const uint8_t> fixture, size_t fixtureCount) {
    const auto floats = largePly(fixture, fixtureCount);
    const auto full = loadScene(floats.bytes);
    for (bool big : {false, true}) {
        const auto alternate = alternatePly(floats, big);
        const auto decoded = loadScene(alternate.bytes);
        require(decoded.sourceCount == full.sourceCount && decoded.shDegree == full.shDegree &&
                    std::memcmp(decoded.gaussians.data(), full.gaussians.data(),
                                full.gaussians.size() * sizeof(Gaussian)) == 0 &&
                    decoded.radius == full.radius,
                "Fused float views match mixed types, unaligned rows and endian decoding exactly");
    }
    for (size_t budget : {size_t(1), size_t(17), size_t(32'777), size_t(55'001)}) {
        const auto sampled = loadScene(floats.bytes, {.maxSplats = budget});
        size_t output = 0;
        for (size_t i = 0; i < full.sourceCount; ++i)
            if (i * budget / full.sourceCount != (i + 1) * budget / full.sourceCount) {
                require(std::memcmp(&sampled.gaussians[output++], &full.gaussians[i], sizeof(Gaussian)) == 0,
                        "Serial and parallel budgets retain the same sample in source order");
            }
        require(output == budget && sampled.sourceCount == full.sourceCount, "Uniform sample counts");
    }
    auto invalid = floats.bytes;
    const float infinity = std::numeric_limits<float>::infinity();
    std::memcpy(invalid.data() + floats.body + 50'000 * floats.stride + 8, &infinity, sizeof(infinity));
    rejects([&] { loadScene(invalid); }); // Fault in a worker, not the calling range.
    invalid.pop_back();
    rejects([&] { loadScene(invalid, {.maxSplats = 1}); }); // Validate even unsampled tail bytes.
    std::stop_source stop;
    stop.request_stop();
    rejects([&] { loadScene(floats.bytes, {.stop = stop.get_token()}); });
}
void streamingGzipContracts(std::span<const uint8_t> fixture, size_t fixtureCount,
                            const std::filesystem::path &directory) {
    const auto source = largePly(fixture, fixtureCount);
    Scene scene = loadScene(source.bytes);
    const auto folder = directory / L"io-contracts";
    std::filesystem::create_directories(folder);
    const auto path = folder / L"parallel.spz";
    writeVisibleScene(scene, {}, path, SceneExportFormat::Spz);
    const auto bytes = read(path);
    const auto raw = inflateSingle(bytes, 16 + scene.gaussians.size() * 65);
    const auto cloud = spz::loadSpzPacked(bytes);
    require(cloud.numPoints == static_cast<int>(scene.gaussians.size()) && cloud.shDegree == 3 &&
                cloud.sh.size() == scene.gaussians.size() * 45,
            "Niantic reads every attribute after multiple parallel gzip blocks");
    const auto decoded = loadScene(bytes);
    for (size_t budget : {size_t(1), size_t(32'777)}) {
        const auto sampled = loadScene(bytes, {.maxSplats = budget});
        size_t output = 0;
        for (size_t i = 0; i < decoded.sourceCount; ++i)
            if (i * budget / decoded.sourceCount != (i + 1) * budget / decoded.sourceCount)
                require(std::memcmp(&sampled.gaussians[output++], &decoded.gaussians[i], sizeof(Gaussian)) ==
                            0,
                        "SPZ packed views preserve uniform sampling and source order");
    }
    auto corrupt = bytes;
    corrupt[corrupt.size() - 8] ^= 1;
    rejects([&] { loadScene(corrupt); });
    corrupt = bytes;
    const uint32_t huge = UINT32_MAX;
    std::memcpy(corrupt.data() + corrupt.size() - 4, &huge, sizeof(huge));
    rejects([&] { loadScene(corrupt); });
    corrupt = bytes;
    corrupt.pop_back();
    rejects([&] { loadScene(corrupt); });
    corrupt = bytes;
    corrupt.insert(corrupt.end(), bytes.begin(), bytes.end());
    rejects([&] { loadScene(corrupt); });
    rejects([&] { loadScene(bytes, {.maxBytes = bytes.size()}); });
    // Keep extension-aware legacy decoding even when there are no extensions.
    auto extended = raw;
    extended[14] |= 2;
    extended.insert(extended.end(), 4, 0); // Empty extension list.
    Bytes gzip;
    require(spz::compressGzipped(extended.data(), extended.size(), &gzip), "Extension fixture gzip");
    const auto fallback = loadScene(gzip);
    require(fallback.gaussians.size() == decoded.gaussians.size() &&
                std::memcmp(fallback.gaussians.data(), decoded.gaussians.data(),
                            decoded.gaussians.size() * sizeof(Gaussian)) == 0,
            "Fast packed views match Niantic's extension-aware decoder exactly");

    // 16 + 52428*20 == 1 MiB: exercise a full non-final block followed by an
    // empty final block, as well as the small-file serial compressor.
    scene.shDegree = 0;
    for (size_t count : {size_t(52'428), size_t(1)}) {
        scene.gaussians.resize(count);
        writeVisibleScene(scene, {}, path, SceneExportFormat::Spz);
        const auto encoded = read(path);
        inflateSingle(encoded, 16 + count * 20);
        require(loadScene(encoded).gaussians.size() == count, "Exact-block and small gzip tails decode");
    }
    // Cancel while compressed data is being written, preserving an existing
    // destination and cleaning temporary files even with in-flight workers.
    scene = loadScene(source.bytes);
    const size_t originalCount = scene.gaussians.size();
    scene.gaussians.resize(originalCount * 4);
    for (size_t i = originalCount; i < scene.gaussians.size(); ++i)
        scene.gaussians[i] = scene.gaussians[i % originalCount];
    scene.sourceCount = scene.gaussians.size();
    const Bytes previous = read(path);
    std::stop_source stop;
    std::jthread interrupt([&](std::stop_token done) {
        while (!done.stop_requested()) {
            for (const auto &entry : std::filesystem::directory_iterator(folder)) {
                std::error_code error;
                if (entry.path().extension() == L".tmp" &&
                    std::filesystem::file_size(entry.path(), error) > 10 && !error) {
                    stop.request_stop();
                    return;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    });
    rejects([&] { writeVisibleScene(scene, {}, path, SceneExportFormat::Spz, stop.get_token()); });
    interrupt.request_stop();
    interrupt.join();
    require(stop.stop_requested() && read(path) == previous, "Cancelled gzip preserves prior output");
    for (const auto &entry : std::filesystem::directory_iterator(folder))
        require(entry.path().extension() != L".tmp", "Cancelled gzip releases workers and temporary files");
}
