#include "export_internal.hpp"
#include "math.hpp"
#include <load-spz.h>
#include <webp/encode.h>
#include <zlib.h>
#include <nlohmann/json.hpp>
#include <fstream>
#include <limits>

namespace preview::detail {
namespace {
using Json = nlohmann::json;
// WebP already compresses each property. Store ZIP members directly, stream
// their CRC/size in data descriptors, and retain only the tiny central directory.
class Archive {
    struct Entry {
        std::string name;
        uint32_t offset{}, crc{}, size{};
    };
    std::ofstream out_;
    std::vector<Entry> entries_;
    template <class T> void integer(T value) {
        out_.write(reinterpret_cast<const char *>(&value), sizeof(value));
    }
    uint32_t offset() {
        const std::streamoff value = out_.tellp();
        if (!out_ || value < 0 || uint64_t(value) > UINT32_MAX)
            throw std::runtime_error("SOG output exceeds the ZIP32 size limit or cannot be written");
        return uint32_t(value);
    }

  public:
    explicit Archive(const std::filesystem::path &path) : out_(path, std::ios::binary) {
        if (!out_)
            throw std::runtime_error("Cannot open the SOG output");
    }
    void begin(const char *name) {
        entries_.push_back({name, offset(), uint32_t(crc32(0, nullptr, 0)), 0});
        integer(uint32_t(0x04034b50));
        integer(uint16_t(20));
        integer(uint16_t(8)); // streamed data descriptor
        integer(uint16_t(0)); // stored WebP bytes
        integer(uint16_t(0));
        integer(uint16_t(0x21)); // 1980-01-01
        for (int i = 0; i < 3; ++i)
            integer(uint32_t(0));
        integer(uint16_t(entries_.back().name.size()));
        integer(uint16_t(0));
        out_ << name;
    }
    bool append(const uint8_t *data, size_t size) noexcept {
        try {
            auto &entry = entries_.back();
            if (size > UINT32_MAX - entry.size)
                return false;
            out_.write(reinterpret_cast<const char *>(data), std::streamsize(size));
            entry.crc = uint32_t(crc32(entry.crc, data, uInt(size)));
            entry.size += uint32_t(size);
            return bool(out_);
        } catch (...) {
            return false;
        }
    }
    void end() {
        const auto &entry = entries_.back();
        integer(uint32_t(0x08074b50));
        integer(entry.crc);
        integer(entry.size);
        integer(entry.size);
        offset(); // detect errors before starting another member
    }
    void text(const char *name, const std::string &value) {
        begin(name);
        if (!append(reinterpret_cast<const uint8_t *>(value.data()), value.size()))
            throw std::runtime_error("Cannot write SOG metadata");
        end();
    }
    void finish() {
        const auto directory = offset();
        for (const auto &entry : entries_) {
            integer(uint32_t(0x02014b50));
            integer(uint16_t(20));
            integer(uint16_t(20));
            integer(uint16_t(8));
            integer(uint16_t(0));
            integer(uint16_t(0));
            integer(uint16_t(0x21));
            integer(entry.crc);
            integer(entry.size);
            integer(entry.size);
            integer(uint16_t(entry.name.size()));
            for (int i = 0; i < 4; ++i)
                integer(uint16_t(0));
            integer(uint32_t(0));
            integer(entry.offset);
            out_ << entry.name;
        }
        const auto size = offset() - directory;
        integer(uint32_t(0x06054b50));
        integer(uint16_t(0));
        integer(uint16_t(0));
        integer(uint16_t(entries_.size()));
        integer(uint16_t(entries_.size()));
        integer(size);
        integer(directory);
        integer(uint16_t(0));
        out_.close();
        if (!out_)
            throw std::runtime_error("The SOG archive could not be written completely");
    }
};
void texture(Archive &archive, const char *name, std::span<const uint8_t> rgba, unsigned width,
             unsigned height, std::stop_token stop) {
    checkSaveStop(stop);
    struct Picture : WebPPicture {
        Picture() {
            if (!WebPPictureInit(this))
                throw std::runtime_error("Cannot initialize the SOG WebP encoder");
        }
        ~Picture() { WebPPictureFree(this); }
    } picture;
    struct Context {
        Archive &archive;
        std::stop_token stop;
    } context{archive, stop};
    WebPConfig config;
    if (!WebPConfigInit(&config) || !WebPConfigLosslessPreset(&config, 1))
        throw std::runtime_error("Cannot initialize SOG lossless compression");
    config.exact = 1; // Preserve RGB even when opacity is zero.
    picture.use_argb = 1;
    picture.width = int(width);
    picture.height = int(height);
    picture.custom_ptr = &context;
    picture.writer = [](const uint8_t *data, size_t size, const WebPPicture *p) {
        auto &c = *static_cast<Context *>(p->custom_ptr);
        return int(!c.stop.stop_requested() && c.archive.append(data, size));
    };
    picture.progress_hook = [](int, const WebPPicture *p) {
        return int(!static_cast<Context *>(p->custom_ptr)->stop.stop_requested());
    };
    if (!WebPPictureImportRGBA(&picture, rgba.data(), int(width * 4)))
        throw std::runtime_error("Cannot allocate the SOG property texture");
    archive.begin(name);
    if (!WebPEncode(&config, &picture)) {
        checkSaveStop(stop);
        throw std::runtime_error("SOG WebP compression or output failed");
    }
    checkSaveStop(stop);
    archive.end();
}
struct Range {
    float low{std::numeric_limits<float>::infinity()}, high{-std::numeric_limits<float>::infinity()};
    void add(float value) {
        low = std::min(low, value);
        high = std::max(high, value);
    }
    uint8_t encode(float value) const { return uint8_t(unorm(normalized(value, low, high), 8)); }
};
// Sample every occupied log-scale interval, including rare background splats.
// Uniform record sampling and quantile initialization can leave the upper tail
// represented only by its maximum, changing large splats' radii severalfold.
// Fixed 1/64-log-unit buckets and farthest-point centers bound the worst error
// without storing three scale columns or weighting rare scales out of existence.
constexpr size_t scaleBucketCount = 6400; // [-52, 48) covers every finite positive float variance.
using ScaleBuckets = std::array<Range, scaleBucketCount>;
void sampleScale(ScaleBuckets &buckets, float value) {
    const auto bucket =
        size_t(std::clamp(std::floor((double(value) + 52) * 64), 0., double(scaleBucketCount - 1)));
    buckets[bucket].add(value);
}
// Half-float exponent buckets cover every observed DC/SH value with finer
// intervals near zero. Record exact extrema so palette averages keep their
// float precision. The 64 KiB table is independent of the Gaussian count.
constexpr size_t coefficientBucketCount = 8192;
void sampleCoefficient(std::span<Range> buckets, float value) {
    buckets[DirectX::PackedVector::XMConvertFloatToHalf(value) >> 3].add(value);
}
std::array<float, 256> codebook(std::span<const Range> buckets, std::stop_token stop) {
    std::vector<float> samples;
    for (const auto &bucket : buckets)
        if (bucket.low <= bucket.high) {
            samples.push_back(bucket.low);
            samples.push_back(bucket.high);
        }
    std::sort(samples.begin(), samples.end());
    samples.erase(std::unique(samples.begin(), samples.end()), samples.end());
    std::array<float, 256> book;
    std::vector<float> distances(samples.size(), std::numeric_limits<float>::infinity());
    size_t next = 0;
    for (auto &center : book) {
        checkSaveStop(stop);
        center = samples[next];
        for (size_t i = 0; i < samples.size(); ++i)
            distances[i] = std::min(distances[i], std::abs(samples[i] - center));
        next = size_t(std::max_element(distances.begin(), distances.end()) - distances.begin());
    }
    std::sort(book.begin(), book.end());
    return book;
}
uint8_t nearest(const std::array<float, 256> &book, float value) {
    auto found = std::lower_bound(book.begin(), book.end(), value);
    if (found == book.end())
        return 255;
    if (found != book.begin() && value - *(found - 1) < *found - value)
        --found;
    return uint8_t(found - book.begin());
}
float logit(float opacity) {
    opacity = std::clamp(opacity, 1e-7f, 1 - 1e-7f);
    return std::log(opacity / (1 - opacity));
}
float logPosition(float value) {
    const float result = std::copysign(std::log1p(std::abs(value)), value);
    if (!std::isfinite(result) || std::abs(result) > 40)
        throw std::runtime_error("SOG position range is too large. Save as PLY instead.");
    return result;
}
struct Palette {
    std::vector<float> values;
    std::vector<uint16_t> labels;
    unsigned count{}, components{};
};
// Median-cut vector quantization in SH space. At most 64K palette entries;
// split axes use bounded variance samples. Reuse the spatial permutation as
// scratch, rather than expanding N * 45 SH floats or requiring a GPU.
Palette palette(const Scene &scene, std::vector<uint64_t> &order, unsigned components, std::stop_token stop) {
    Palette result;
    result.count = unsigned(std::min<size_t>(order.size(), 65536));
    result.components = components;
    result.values.resize(size_t(result.count) * components);
    result.labels.resize(scene.gaussians.size());
    size_t comparisons = 0;
    auto component = [&](uint64_t entry, unsigned c) {
        return shValue(scene.gaussians[uint32_t(entry)], c / 3 + 1, c % 3);
    };
    auto build = [&](auto &&self, size_t begin, size_t end, unsigned first, unsigned leaves) -> void {
        checkSaveStop(stop);
        if (end - begin == leaves) {
            for (size_t i = begin; i < end; ++i) {
                if ((i & 4095) == 0)
                    checkSaveStop(stop);
                const unsigned label = first + unsigned(i - begin);
                result.labels[uint32_t(order[i])] = uint16_t(label);
                for (unsigned c = 0; c < components; ++c)
                    result.values[size_t(label) * components + c] = component(order[i], c);
            }
            return;
        }
        if (leaves == 1) {
            std::array<double, 45> sums{};
            for (size_t i = begin; i < end; ++i) {
                if ((i & 4095) == 0)
                    checkSaveStop(stop);
                result.labels[uint32_t(order[i])] = uint16_t(first);
                for (unsigned c = 0; c < components; ++c)
                    sums[c] += component(order[i], c);
            }
            for (unsigned c = 0; c < components; ++c)
                result.values[size_t(first) * components + c] = float(sums[c] / (end - begin));
            return;
        }
        unsigned axis = 0;
        double largest = -1;
        const size_t sample = std::min<size_t>(32, end - begin);
        for (unsigned c = 0; c < components; ++c) {
            double sum = 0, squared = 0;
            for (size_t i = 0; i < sample; ++i) {
                const double value = component(order[begin + i * (end - begin) / sample], c);
                sum += value;
                squared += value * value;
            }
            const double variance = squared - sum * sum / sample;
            if (variance > largest) {
                largest = variance;
                axis = c;
            }
        }
        const unsigned left = leaves / 2;
        const size_t middle = begin + (end - begin) * left / leaves;
        std::nth_element(order.begin() + begin, order.begin() + middle, order.begin() + end,
                         [&](uint64_t a, uint64_t b) {
                             if ((++comparisons & 65535) == 0)
                                 checkSaveStop(stop);
                             const auto av = component(a, axis), bv = component(b, axis);
                             return av == bv ? a < b : av < bv;
                         });
        self(self, begin, middle, first, left);
        self(self, middle, end, first + left, leaves - left);
    };
    build(build, 0, order.size(), 0, result.count);
    return result;
}
} // namespace
void writeSog(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
              uint32_t count, bool legacy, std::stop_token stop) {
    const unsigned degree = std::min(scene.shDegree, 3u), rest = (degree + 1) * (degree + 1) - 1;
    auto order = spatialOrder(scene, states, stop);
    std::array<Range, 3> positions, scales;
    std::array<Range, 4> colors;
    ScaleBuckets scaleBuckets;
    std::vector<Range> colorBuckets(legacy ? 0 : coefficientBucketCount);
    for (size_t i = 0; i < order.size(); ++i) {
        if ((i & 4095) == 0)
            checkSaveStop(stop);
        const auto &g = scene.gaussians[uint32_t(order[i])];
        const auto axes = exportAxesRdf(g);
        for (unsigned c = 0; c < 3; ++c) {
            positions[c].add(logPosition(g.positionOpacity[c] * (c ? -1.f : 1.f)));
            scales[c].add(axes.logScales[c]);
            colors[c].add(shValue(g, 0, c));
            if (!legacy) {
                sampleScale(scaleBuckets, axes.logScales[c]);
                sampleCoefficient(colorBuckets, shValue(g, 0, c));
            }
        }
        colors[3].add(logit(g.positionOpacity[3]));
    }
    const auto scaleBook = legacy ? std::array<float, 256>{} : codebook(scaleBuckets, stop);
    const auto colorBook = legacy ? std::array<float, 256>{} : codebook(colorBuckets, stop);
    std::vector<Range>().swap(colorBuckets);
    Palette sh;
    if (rest) {
        sh = palette(scene, order, rest * 3, stop);
        const auto converter =
            spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, degree);
        for (size_t i = 0; i < sh.values.size(); ++i)
            sh.values[i] *= converter.flipSh[(i % sh.components) / 3];
    }
    sortSpatialOrder(order, stop);
    // Near-square, four-aligned textures stay well within WebP's 16383 limit
    // at the standalone viewer's three-million-splat budget.
    const unsigned width = (unsigned(std::ceil(std::sqrt(double(count)))) + 3) & ~3u;
    const unsigned height = ((count + width - 1) / width + 3) & ~3u;
    if (width > WEBP_MAX_DIMENSION || height > WEBP_MAX_DIMENSION)
        throw std::runtime_error("SOG texture dimensions exceed WebP limits");
    std::vector<uint8_t> pixels(size_t(width) * height * 4);
    for (size_t i = 3; i < pixels.size(); i += 4)
        pixels[i] = 255;
    Archive archive(path);
    Json meta;
    meta["asset"]["generator"] = "SplatView CPU encoder";
    if (!legacy) {
        meta["version"] = 2;
        meta["count"] = count;
    } else
        meta["means"]["shape"] = {count, 3};
    meta["means"]["files"] = {"means_l.webp", "means_u.webp"};
    for (unsigned c = 0; c < 3; ++c) {
        meta["means"]["mins"].push_back(positions[c].low);
        meta["means"]["maxs"].push_back(positions[c].high);
    }
    auto fill = [&](auto action) {
        for (size_t i = 0; i < order.size(); ++i) {
            if ((i & 4095) == 0)
                checkSaveStop(stop);
            const auto index = uint32_t(order[i]);
            action(scene.gaussians[index], pixels.data() + i * 4, index, order[i]);
        }
    };
    for (unsigned high = 0; high < 2; ++high) {
        fill([&](const Gaussian &g, uint8_t *p, uint32_t, uint64_t &) {
            for (unsigned c = 0; c < 3; ++c) {
                const auto value = logPosition(g.positionOpacity[c] * (c ? -1.f : 1.f));
                p[c] =
                    uint8_t(unorm(normalized(value, positions[c].low, positions[c].high), 16) >> (high * 8));
            }
            p[3] = 255;
        });
        texture(archive, high ? "means_u.webp" : "means_l.webp", pixels, width, height, stop);
    }
    fill([&](const Gaussian &g, uint8_t *p, uint32_t index, uint64_t &entry) {
        const auto axes = exportAxesRdf(g);
        const auto &q = axes.quaternion;
        unsigned largest = 0, channel = 0;
        for (unsigned i = 1; i < 4; ++i)
            if (std::abs(q[i]) > std::abs(q[largest]))
                largest = i;
        const double sign = q[largest] < 0 ? -1 : 1;
        for (unsigned i = 0; i < 4; ++i)
            if (i != largest)
                p[channel++] = uint8_t(unorm(q[i] * sign * .7071067811865475 + .5, 8));
        p[3] = uint8_t(252 + largest);
        // Morton sorting is finished. Reuse the key's upper 32 bits for scale
        // indices, saving another eigendecomposition without a new N-sized buffer.
        uint32_t packedScales = 0;
        for (unsigned c = 0; c < 3; ++c)
            packedScales |=
                uint32_t(legacy ? scales[c].encode(axes.logScales[c]) : nearest(scaleBook, axes.logScales[c]))
                << (8 * c);
        entry = (uint64_t(packedScales) << 32) | index;
    });
    texture(archive, "quats.webp", pixels, width, height, stop);
    meta["quats"]["files"] = {"quats.webp"};
    fill([&](const Gaussian &, uint8_t *p, uint32_t, uint64_t &entry) {
        for (unsigned c = 0; c < 3; ++c)
            p[c] = uint8_t(entry >> (32 + 8 * c));
        p[3] = 255;
    });
    texture(archive, "scales.webp", pixels, width, height, stop);
    meta["scales"]["files"] = {"scales.webp"};
    fill([&](const Gaussian &g, uint8_t *p, uint32_t, uint64_t &) {
        for (unsigned c = 0; c < 3; ++c)
            p[c] = legacy ? colors[c].encode(shValue(g, 0, c)) : nearest(colorBook, shValue(g, 0, c));
        p[3] =
            legacy ? colors[3].encode(logit(g.positionOpacity[3])) : uint8_t(unorm(g.positionOpacity[3], 8));
    });
    texture(archive, "sh0.webp", pixels, width, height, stop);
    meta["sh0"]["files"] = {"sh0.webp"};
    if (legacy) {
        for (unsigned c = 0; c < 3; ++c) {
            meta["scales"]["mins"].push_back(scales[c].low);
            meta["scales"]["maxs"].push_back(scales[c].high);
        }
        for (unsigned c = 0; c < 4; ++c) {
            meta["sh0"]["mins"].push_back(colors[c].low);
            meta["sh0"]["maxs"].push_back(colors[c].high);
        }
    } else {
        meta["scales"]["codebook"] = scaleBook;
        meta["sh0"]["codebook"] = colorBook;
    }
    if (rest) {
        fill([&](const Gaussian &, uint8_t *p, uint32_t index, uint64_t &) {
            const auto label = sh.labels[index];
            p[0] = uint8_t(label);
            p[1] = uint8_t(label >> 8);
            p[2] = 0;
            p[3] = 255;
        });
        texture(archive, "shN_labels.webp", pixels, width, height, stop);
        // Release per-Gaussian storage before encoding the small SH palette.
        std::vector<uint8_t>().swap(pixels);
        std::vector<uint64_t>().swap(order);
        std::vector<uint16_t>().swap(sh.labels);
        Range range;
        std::vector<Range> buckets(legacy ? 0 : coefficientBucketCount);
        for (size_t i = 0; i < sh.values.size(); ++i) {
            if ((i & 4095) == 0)
                checkSaveStop(stop);
            range.add(sh.values[i]);
            if (!legacy)
                sampleCoefficient(buckets, sh.values[i]);
        }
        const auto book = legacy ? std::array<float, 256>{} : codebook(buckets, stop);
        std::vector<Range>().swap(buckets);
        const unsigned paletteWidth = 64 * rest, paletteHeight = (sh.count + 63) / 64;
        pixels.assign(size_t(paletteWidth) * paletteHeight * 4, 255);
        for (size_t i = 0; i < sh.count; ++i)
            for (unsigned j = 0; j < rest; ++j)
                for (unsigned c = 0; c < 3; ++c) {
                    const auto value = sh.values[i * sh.components + j * 3 + c];
                    pixels[(i * rest + j) * 4 + c] = legacy ? range.encode(value) : nearest(book, value);
                }
        texture(archive, "shN_centroids.webp", pixels, paletteWidth, paletteHeight, stop);
        meta["shN"]["files"] = {"shN_centroids.webp", "shN_labels.webp"};
        if (legacy) {
            meta["shN"]["mins"] = range.low;
            meta["shN"]["maxs"] = range.high;
            meta["shN"]["shape"] = {sh.count, sh.components};
            meta["shN"]["quantization"] = 8;
        } else {
            meta["shN"]["count"] = sh.count;
            meta["shN"]["bands"] = degree;
            meta["shN"]["codebook"] = book;
        }
    }
    checkSaveStop(stop);
    archive.text("meta.json", meta.dump());
    archive.finish();
}
} // namespace preview::detail
