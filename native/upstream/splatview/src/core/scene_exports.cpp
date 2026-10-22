#include "scene_exports.hpp"
#include "atomic_file.hpp"
#include "binary_output.hpp"
#include "export_internal.hpp"
#include <load-spz.h>
#include <zlib.h>
#include <libdeflate.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <deque>
#include <future>
#include <thread>

namespace preview {
namespace {
uint8_t byte(float value) {
    return uint8_t(std::clamp(std::round(value), 0.f, 255.f));
}

// Streaming adaptation of OpsiClear/gsply's parallel single-member gzip.
// Independent raw-deflate blocks end with byte-aligned Z_SYNC_FLUSH, and the
// final block ends with Z_FINISH. A bounded queue overlaps compression with
// attribute packing without allocating a second whole-scene payload.
class GzipOutput {
    struct Block {
        std::vector<uint8_t> compressed;
        uint32_t crc{}, size{};
    };
    static constexpr size_t blockSize = 1024 * 1024;

  public:
    GzipOutput(const std::filesystem::path &path, std::stop_token stop)
        : file_(path, std::ios::binary), input_(blockSize), stop_(stop) {
        if (!file_)
            throw std::runtime_error("Cannot create the SPZ encoder");
        const uint8_t header[] = {0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff};
        write(header);
        // At most three compression workers plus the packing caller; a single
        // CPU and small files use serial compression without worker overhead.
        maxPending_ = std::clamp(std::thread::hardware_concurrency(), 1u, 4u) - 1;
    }
    void put(uint8_t value) {
        input_[used_++] = value;
        if (used_ == input_.size())
            submit(false);
    }
    void integer(uint32_t value, unsigned bytes = 4) {
        for (unsigned i = 0; i < bytes; ++i)
            put(uint8_t(value >> (8 * i)));
    }
    void finish() {
        submit(true);
        while (!pending_.empty())
            drain();
        std::array<uint8_t, 8> trailer;
        for (unsigned i = 0; i < 4; ++i) {
            trailer[i] = uint8_t(crc_ >> (8 * i));
            trailer[i + 4] = uint8_t(size_ >> (8 * i));
        }
        write(trailer);
        file_.close();
        if (!file_)
            throw std::runtime_error("The SPZ output could not be written completely");
    }

  private:
    static Block compress(const std::vector<uint8_t> &input, bool final, std::stop_token stop) {
        if (stop.stop_requested())
            throw std::runtime_error("Scene save cancelled");
        z_stream stream{};
        if (deflateInit2(&stream, 3, Z_DEFLATED, -MAX_WBITS, 8, Z_DEFAULT_STRATEGY) != Z_OK)
            throw std::runtime_error("Cannot create the SPZ encoder");
        struct Cleanup {
            z_stream *stream;
            ~Cleanup() { deflateEnd(stream); }
        } cleanup{&stream};
        Block block;
        block.compressed.resize(deflateBound(&stream, static_cast<uLong>(input.size())) + 16);
        stream.next_in = const_cast<Bytef *>(input.data());
        stream.avail_in = static_cast<uInt>(input.size());
        stream.next_out = block.compressed.data();
        stream.avail_out = static_cast<uInt>(block.compressed.size());
        const int result = deflate(&stream, final ? Z_FINISH : Z_SYNC_FLUSH);
        if ((final ? result != Z_STREAM_END : result != Z_OK) || stream.avail_in || !stream.avail_out)
            throw std::runtime_error("SPZ compression failed");
        block.compressed.resize(block.compressed.size() - stream.avail_out);
        block.crc = libdeflate_crc32(0, input.data(), input.size());
        block.size = static_cast<uint32_t>(input.size());
        if (stop.stop_requested())
            throw std::runtime_error("Scene save cancelled");
        return block;
    }
    void write(std::span<const uint8_t> bytes) {
        file_.write(reinterpret_cast<const char *>(bytes.data()), bytes.size());
        if (!file_)
            throw std::runtime_error("The SPZ output could not be written completely");
    }
    void append(Block block) {
        write(block.compressed);
        crc_ = static_cast<uint32_t>(crc32_combine(crc_, block.crc, block.size));
        size_ += block.size;
    }
    void drain() {
        auto block = pending_.front().get();
        pending_.pop_front();
        append(std::move(block));
    }
    void submit(bool final) {
        if (stop_.stop_requested())
            throw std::runtime_error("Scene save cancelled");
        input_.resize(used_);
        if (!maxPending_ || (final && !size_ && pending_.empty())) {
            append(compress(input_, final, stop_));
        } else {
            if (pending_.size() >= maxPending_)
                drain();
            pending_.push_back(
                std::async(std::launch::async, [input = std::move(input_), final, stop = stop_] {
                    return compress(input, final, stop);
                }));
        }
        if (!final)
            input_.resize(blockSize);
        used_ = 0;
    }
    std::ofstream file_;
    std::vector<uint8_t> input_;
    std::deque<std::future<Block>> pending_;
    std::stop_token stop_;
    size_t used_{};
    size_t maxPending_{};
    uint32_t crc_{}, size_{};
};
template <class Function>
void visible(const Scene &scene, std::span<const uint8_t> states, std::stop_token stop, Function action) {
    for (size_t i = 0; i < scene.gaussians.size(); ++i) {
        if ((i & 4095) == 0 && stop.stop_requested())
            throw std::runtime_error("Scene save cancelled");
        if (states.empty() || !(states[i] & 2))
            action(scene.gaussians[i]);
    }
}
uint32_t packedRotation(const ExportAxes &axes, const spz::CoordinateConverter &converter) {
    const auto &r = axes.quaternion;
    const float q[] = {r[1] * converter.flipQ[0], r[2] * converter.flipQ[1], r[3] * converter.flipQ[2],
                       r[0]}; // SPZ xyzw, canonical RUB
    unsigned largest = 0;
    for (unsigned i = 1; i < 4; ++i)
        if (std::abs(q[i]) > std::abs(q[largest]))
            largest = i;
    uint32_t packed = largest;
    for (unsigned i = 0; i < 4; ++i) {
        if (i == largest)
            continue;
        uint32_t sign = (q[i] < 0) ^ (q[largest] < 0);
        uint32_t magnitude = uint32_t(511.f * (std::abs(q[i]) / 0.7071067811865475f) + .5f);
        packed = (packed << 10) | (sign << 9) | std::min(magnitude, 511u);
    }
    return packed;
}
void writeSpz(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
              uint32_t count, std::stop_token stop) {
    unsigned degree = std::min(scene.shDegree, 3u), coefficients = (degree + 1) * (degree + 1);
    GzipOutput out(path, stop);
    out.integer(0x5053474e); // NGSP
    out.integer(3);
    out.integer(count);
    out.put(uint8_t(degree));
    out.put(12); // 12 fractional position bits
    out.put(0);  // no antialias flag or extensions
    out.put(0);
    visible(scene, states, stop, [&](const Gaussian &g) {
        for (unsigned c = 0; c < 3; ++c) {
            double position = std::round(double(g.positionOpacity[c]) * 4096);
            if (!std::isfinite(position) || position < -8388608 || position > 8388607)
                throw std::runtime_error("SPZ positions exceed its 24-bit range. Save as PLY instead.");
            out.integer(uint32_t(int32_t(position)), 3);
        }
    });
    visible(scene, states, stop, [&](const Gaussian &g) { out.put(byte(g.positionOpacity[3] * 255)); });
    visible(scene, states, stop, [&](const Gaussian &g) {
        for (unsigned c = 0; c < 3; ++c)
            out.put(byte(shValue(g, 0, c) * (0.15f * 255) + 127.5f));
    });
    visible(scene, states, stop, [&](const Gaussian &g) {
        for (float scale : exportAxesRdf(g).logScales)
            out.put(byte((scale + 10) * 16));
    });
    auto converter = spz::coordinateConverter(spz::CoordinateSystem::RDF, spz::CoordinateSystem::RUB, degree);
    visible(scene, states, stop,
            [&](const Gaussian &g) { out.integer(packedRotation(exportAxesRdf(g), converter)); });
    visible(scene, states, stop, [&](const Gaussian &g) {
        // CPU SH coefficients already use SPZ's canonical RUB coordinates.
        for (unsigned j = 1; j < coefficients; ++j)
            for (unsigned c = 0; c < 3; ++c) {
                int bucket = j < 4 ? 8 : 16;
                int value = int(std::round(shValue(g, j, c) * 128) + 128);
                value = (value + bucket / 2) / bucket * bucket;
                out.put(uint8_t(std::clamp(value, 0, 255)));
            }
    });
    out.finish();
}
void writeSplat(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
                std::stop_token stop) {
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("Cannot open the SPLAT output");
    detail::BinaryOutput binary(out);
    auto put = [&](float value) { binary.put(value); };
    visible(scene, states, stop, [&](const Gaussian &g) {
        put(g.positionOpacity[0]);
        put(-g.positionOpacity[1]);
        put(-g.positionOpacity[2]);
        auto axes = exportAxesRdf(g);
        for (float scale : axes.logScales)
            put(std::exp(scale));
        uint8_t bytes[8];
        for (unsigned c = 0; c < 3; ++c)
            bytes[c] = byte((shValue(g, 0, c) * 0.28209479177387814f + .5f) * 255);
        bytes[3] = byte(g.positionOpacity[3] * 255);
        for (unsigned c = 0; c < 4; ++c)
            bytes[4 + c] = byte(axes.quaternion[c] * 128 + 128);
        binary.write(bytes);
    });
    binary.flush();
    out.close();
    if (!out)
        throw std::runtime_error("The SPLAT output could not be written completely");
}
} // namespace
void writeVisibleScene(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
                       SceneExportFormat format, std::stop_token stop) {
    if (!scene.isGaussian())
        throw std::runtime_error("PLY point clouds and meshes are view-only");
    if (!states.empty() && states.size() != scene.gaussians.size())
        throw std::runtime_error("The scene and cleanup state do not match");
    size_t count = scene.gaussians.size();
    for (auto state : states)
        count -= (state & 2) != 0;
    if (!count || count > size_t(std::numeric_limits<int32_t>::max()))
        throw std::runtime_error("There are no visible Gaussians to save. Undo or restore first.");
    if (stop.stop_requested())
        throw std::runtime_error("Scene save cancelled");
    AtomicFile output(path);
    switch (format) {
    case SceneExportFormat::Ply:
        writeVisiblePly(scene, states, output.path(), stop);
        break;
    case SceneExportFormat::Spz:
        writeSpz(scene, states, output.path(), uint32_t(count), stop);
        break;
    case SceneExportFormat::Splat:
        writeSplat(scene, states, output.path(), stop);
        break;
    case SceneExportFormat::CompressedPly:
        detail::writeCompressedPly(scene, states, output.path(), uint32_t(count), stop);
        break;
    case SceneExportFormat::Ksplat:
        detail::writeKsplat(scene, states, output.path(), uint32_t(count), stop);
        break;
    case SceneExportFormat::Csv:
        detail::writeCsv(scene, states, output.path(), stop);
        break;
    case SceneExportFormat::Sog:
    case SceneExportFormat::Sogs:
        detail::writeSog(scene, states, output.path(), uint32_t(count), format == SceneExportFormat::Sogs,
                         stop);
        break;
    default:
        throw std::runtime_error("Unsupported scene save format");
    }
    if (stop.stop_requested())
        throw std::runtime_error("Scene save cancelled");
    output.commit();
}
} // namespace preview
