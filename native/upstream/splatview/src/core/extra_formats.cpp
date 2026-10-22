#include "format_utils.hpp"
#include "math.hpp"

// File layout references: Spark c57ebb9 (antisplat.rs / ksplat.rs) and
// SuperSplat's splat-transform 3.9.0 readers. See THIRD-PARTY-NOTICES.txt.
namespace preview::detail {
namespace {
constexpr float shC0 = 0.28209479177387814f;
float half(std::span<const uint8_t> bytes, size_t offset) {
    return DirectX::PackedVector::XMConvertHalfToFloat(number<uint16_t>(bytes, offset));
}
void byteColor(Attributes &a, std::span<const uint8_t> bytes, size_t offset) {
    for (unsigned c = 0; c < 3; ++c)
        a.sh[c] = (bytes[offset + c] / 255.0f - 0.5f) / shC0;
    a.opacity = bytes[offset + 3] / 255.0f;
}
struct Section {
    size_t base{}, data{}, stride{};
    uint32_t count{}, capacity{}, bucketSize{}, buckets{}, full{}, partial{}, range{};
    unsigned degree{};
    float positionScale{};
};
} // namespace

Scene loadSplat(std::span<const uint8_t> bytes, const LoadOptions &o) {
    if (bytes.size() % 32)
        fail("Invalid SPLAT file: records must be 32 bytes");
    const size_t count = bytes.size() / 32;
    countCheck(count);
    Scene scene(o.memory);
    scene.sourceCount = count;
    scene.format = "SPLAT";
    scene.yUp = true;
    scene.gaussians.reserve(std::min(count, o.maxSplats));
    for (size_t i = 0; i < count; ++i) {
        if ((i & 4095) == 0)
            canceled(o);
        if (!selected(i, count, o.maxSplats))
            continue;
        const size_t p = i * 32;
        Attributes a;
        a.position = {number<float>(bytes, p), number<float>(bytes, p + 4), number<float>(bytes, p + 8)};
        a.scale = {number<float>(bytes, p + 12), number<float>(bytes, p + 16), number<float>(bytes, p + 20)};
        byteColor(a, bytes, p + 24);
        // Antimatter/Spark encode w,x,y,z around 128, then normalize on decode.
        for (unsigned q = 0; q < 4; ++q)
            a.quaternion[q] = (float(bytes[p + 28 + q]) - 128.0f) / 128.0f;
        plyToRub(a);
        scene.gaussians.push_back(packGaussian(a));
    }
    return scene;
}

Scene loadKsplat(std::span<const uint8_t> bytes, const LoadOptions &o) {
    constexpr size_t headerBytes = 4096, sectionBytes = 1024;
    if (bytes.size() < headerBytes)
        fail("Truncated KSPLAT header");
    if (bytes[0] != 0 || bytes[1] != 1)
        fail("Only KSPLAT version 0.1 is supported");
    const auto sectionCount = number<uint32_t>(bytes, 4), count = number<uint32_t>(bytes, 16);
    const auto mode = number<uint16_t>(bytes, 20);
    countCheck(count);
    if (!sectionCount || sectionCount > 65536 || sectionCount > (bytes.size() - headerBytes) / sectionBytes)
        fail("Invalid KSPLAT section count");
    if (mode > 2)
        fail("Unsupported KSPLAT compression level");
    float minSh = number<float>(bytes, 36), maxSh = number<float>(bytes, 40);
    if (minSh == 0)
        minSh = -1.5f;
    if (maxSh == 0)
        maxSh = 1.5f;
    if (!std::isfinite(minSh) || !std::isfinite(maxSh) || minSh > maxSh)
        fail("Invalid KSPLAT SH range");
    constexpr unsigned shComponents[] = {0, 9, 24, 45};
    const unsigned shBytes = mode == 0 ? 4 : mode == 1 ? 2 : 1;
    std::vector<Section> sections;
    sections.reserve(sectionCount);
    uint64_t offset = headerBytes + uint64_t(sectionCount) * sectionBytes, total = 0;
    unsigned degree = 0;
    for (uint32_t i = 0; i < sectionCount; ++i) {
        canceled(o);
        const size_t h = headerBytes + size_t(i) * sectionBytes;
        Section s;
        s.base = static_cast<size_t>(offset);
        s.count = number<uint32_t>(bytes, h);
        s.capacity = number<uint32_t>(bytes, h + 4);
        s.bucketSize = number<uint32_t>(bytes, h + 8);
        s.buckets = number<uint32_t>(bytes, h + 12);
        const auto blockSize = number<float>(bytes, h + 16);
        const auto bucketBytes = number<uint16_t>(bytes, h + 20);
        s.range = number<uint32_t>(bytes, h + 24);
        if (!s.range)
            s.range = 32767;
        s.full = number<uint32_t>(bytes, h + 32);
        s.partial = number<uint32_t>(bytes, h + 36);
        s.degree = number<uint16_t>(bytes, h + 40);
        if (s.degree > 3 || s.count > s.capacity || s.count > count || total > count - s.count)
            fail("Invalid KSPLAT section layout or count");
        s.stride = (mode == 0 ? 44 : 24) + shComponents[s.degree] * shBytes;
        const uint64_t metaBytes = uint64_t(s.partial) * 4 + uint64_t(s.buckets) * bucketBytes;
        const uint64_t storage = metaBytes + uint64_t(s.capacity) * s.stride;
        if (offset > bytes.size() || storage > bytes.size() - offset)
            fail("Truncated KSPLAT section data");
        s.data = s.base + static_cast<size_t>(metaBytes);
        if (mode && s.count) {
            if (!s.bucketSize || bucketBytes != 12 || s.buckets > s.count ||
                uint64_t(s.full) * s.bucketSize > s.count || uint64_t(s.full) + s.partial != s.buckets ||
                !std::isfinite(blockSize) || blockSize <= 0 || s.range > 65535)
                fail("Invalid KSPLAT spatial buckets");
            s.positionScale = blockSize * 0.5f / s.range;
            uint64_t covered = uint64_t(s.full) * s.bucketSize;
            for (uint32_t p = 0; p < s.partial; ++p) {
                if ((p & 4095) == 0)
                    canceled(o);
                const auto length = number<uint32_t>(bytes, s.base + size_t(p) * 4);
                if (!length || length > s.bucketSize)
                    fail("Invalid KSPLAT partial bucket length");
                covered += length;
                if (covered > s.count)
                    fail("KSPLAT partial bucket counts exceed its section");
            }
            if (covered != s.count)
                fail("KSPLAT bucket counts disagree with its section");
        }
        total += s.count;
        if (s.count)
            degree = std::max(degree, s.degree);
        offset += storage; // Empty reserved sections can still have allocated storage.
        sections.push_back(s);
    }
    if (total != count)
        fail("KSPLAT header and section counts disagree");
    Scene scene(o.memory);
    scene.sourceCount = count;
    scene.shDegree = degree;
    scene.format = "KSPLAT";
    scene.yUp = true;
    scene.gaussians.reserve(std::min<size_t>(count, o.maxSplats));
    uint64_t index = 0;
    for (const auto &s : sections) {
        uint32_t partialIndex = 0;
        uint64_t partialBase = uint64_t(s.full) * s.bucketSize;
        for (uint32_t i = 0; i < s.count; ++i, ++index) {
            if ((index & 4095) == 0)
                canceled(o);
            if (!selected(index, count, o.maxSplats))
                continue;
            uint32_t bucket = 0;
            if (mode) {
                if (i < uint64_t(s.full) * s.bucketSize)
                    bucket = i / s.bucketSize;
                else {
                    while (partialIndex < s.partial &&
                           i >= partialBase + number<uint32_t>(bytes, s.base + size_t(partialIndex) * 4)) {
                        partialBase += number<uint32_t>(bytes, s.base + size_t(partialIndex) * 4);
                        ++partialIndex;
                    }
                    bucket = s.full + partialIndex;
                }
                if (bucket >= s.buckets)
                    fail("KSPLAT position references a missing bucket");
            }
            const size_t p = s.data + size_t(i) * s.stride;
            Attributes a;
            float position[3], scale[3];
            for (unsigned c = 0; c < 3; ++c) {
                position[c] = mode == 0
                                  ? number<float>(bytes, p + c * 4)
                                  : (float(number<uint16_t>(bytes, p + c * 2)) - s.range) * s.positionScale +
                                        number<float>(bytes, s.base + size_t(s.partial) * 4 +
                                                                 size_t(bucket) * 12 + c * 4);
                scale[c] = mode == 0 ? number<float>(bytes, p + 12 + c * 4) : half(bytes, p + 6 + c * 2);
            }
            a.position = {position[0], position[1], position[2]};
            a.scale = {scale[0], scale[1], scale[2]};
            for (unsigned q = 0; q < 4; ++q)
                a.quaternion[q] =
                    mode == 0 ? number<float>(bytes, p + 24 + q * 4) : half(bytes, p + 12 + q * 2);
            byteColor(a, bytes, p + (mode == 0 ? 40 : 20));
            const size_t sh = p + (mode == 0 ? 44 : 24);
            // KSPLAT is channel-major within each band, unlike PLY's whole-rest layout.
            unsigned sourceBand = 0;
            for (unsigned band = 1; band <= s.degree; ++band) {
                const unsigned bandCount = band * 2 + 1, first = band * band;
                for (unsigned c = 0; c < 3; ++c)
                    for (unsigned j = 0; j < bandCount; ++j) {
                        const size_t at = sh + (sourceBand + c * bandCount + j) * shBytes;
                        a.sh[(first + j) * 3 + c] = mode == 0 ? number<float>(bytes, at)
                                                    : mode == 1
                                                        ? half(bytes, at)
                                                        : minSh + bytes[at] / 255.0f * (maxSh - minSh);
                    }
                sourceBand += bandCount * 3;
            }
            plyToRub(a);
            scene.gaussians.push_back(packGaussian(a));
        }
    }
    return scene;
}
} // namespace preview::detail
