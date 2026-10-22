#include "image_io.hpp"
#include "file_io.hpp"
#include "atomic_file.hpp"
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <limits>
#include <new>
#include <utility>

namespace {
struct ImageAllocation;
void imageFree(void *) noexcept;
// stb's allocation callbacks cannot throw: its explicit failure paths must
// release all earlier C-owned buffers. Remember the original exception and
// propagate only after stb has returned and its result is under RAII.
struct ImageDecodeContext {
    const preview::ImageReadOptions &options;
    std::exception_ptr failure;
    ImageAllocation *allocations{};
};
thread_local ImageDecodeContext *imageDecodeContext{};
struct ImageDecodeScope {
    ImageDecodeContext *previous;
    ImageDecodeContext &context;
    explicit ImageDecodeScope(ImageDecodeContext &context) noexcept
        : previous(std::exchange(imageDecodeContext, &context)), context(context) {}
    ~ImageDecodeScope();
};
struct alignas(std::max_align_t) ImageAllocation {
    preview::ResourceReservation charge;
    std::size_t bytes;
    ImageDecodeContext *owner{};
    ImageAllocation *previous{}, *next{};
};
ImageDecodeScope::~ImageDecodeScope() {
    // Some pinned stb conversion-error paths abandon an earlier buffer (for
    // example 16-to-8-bit conversion denial). The request owns all callbacks,
    // so drain any residual storage after stb and result RAII have finished.
    while (context.allocations) imageFree(context.allocations + 1);
    imageDecodeContext = previous;
}
void *imageAllocate(std::size_t count) noexcept {
    auto *context = imageDecodeContext;
    if (context && context->failure) return nullptr;
    try {
        if (context && context->options.stop.stop_requested())
            throw std::runtime_error("Image decode cancelled");
        const auto bytes = std::max(std::size_t(1), count);
        const auto total = preview::checkedByteSum({sizeof(ImageAllocation), bytes});
        preview::ResourceReservation charge;
        if (context && context->options.resources)
            charge = context->options.resources->reserve(preview::ResourceCategory::Work, bytes);
        void *storage = std::malloc(total);
        if (!storage) throw std::bad_alloc();
        auto *allocation = new (storage) ImageAllocation{std::move(charge), bytes};
        if (context) {
            allocation->owner = context;
            allocation->next = context->allocations;
            if (context->allocations) context->allocations->previous = allocation;
            context->allocations = allocation;
        }
        return allocation + 1;
    } catch (...) {
        if (context && !context->failure) context->failure = std::current_exception();
        return nullptr;
    }
}
void imageFree(void *pixels) noexcept {
    if (!pixels) return;
    auto *allocation = static_cast<ImageAllocation *>(pixels) - 1;
    if (allocation->owner) {
        if (allocation->previous) allocation->previous->next = allocation->next;
        else allocation->owner->allocations = allocation->next;
        if (allocation->next) allocation->next->previous = allocation->previous;
    }
    // Preserve the grant until the actual backing allocation is freed.
    auto charge = std::move(allocation->charge);
    allocation->~ImageAllocation();
    std::free(allocation);
}
void *imageReallocate(void *pixels, std::size_t count) noexcept {
    if (!pixels) return imageAllocate(count);
    if (!count) { imageFree(pixels); return nullptr; }
    // Allocate-copy-free deliberately charges both capacities simultaneously.
    // On rejection the caller still owns the intact old allocation.
    void *replacement = imageAllocate(count);
    if (!replacement) return nullptr;
    const auto *allocation = static_cast<ImageAllocation *>(pixels) - 1;
    std::memcpy(replacement, pixels, std::min(count, allocation->bytes));
    imageFree(pixels);
    return replacement;
}
} // namespace
#define STBI_MALLOC(size) imageAllocate(size)
#define STBI_FREE(pixels) imageFree(pixels)
#define STBI_REALLOC_SIZED(pixels, oldSize, size) imageReallocate(pixels, size)
#define STB_IMAGE_IMPLEMENTATION
#define STBI_NO_STDIO
#include <stb_image.h>
#define STB_IMAGE_WRITE_IMPLEMENTATION
#define STBI_WRITE_NO_STDIO
#include <stb_image_write.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <memory>
#include <stdexcept>

namespace preview {
thread_local void (*DecodedImage::checkpoint_)(void *, const char *){};
thread_local void *DecodedImage::checkpointContext_{};
void DecodedImage::setCheckpoint(void (*function)(void *, const char *), void *context) noexcept {
    // Keep TLS access in its defining translation unit, including private test
    // injection, so other units do not depend on external TLS-init wrappers.
    checkpoint_ = function;
    checkpointContext_ = context;
}
void DecodedImage::checkpoint(const char *stage) {
    if (checkpoint_) checkpoint_(checkpointContext_, stage);
}
DecodedImage::DecodedImage(Image image) : image_(std::move(image)) {}
DecodedImage &DecodedImage::operator=(DecodedImage &&other) noexcept {
    if (this != &other) {
        // Both allocations stay paired with their grants, including the old
        // destination retained in other until destruction or another move.
        std::swap(image_, other.image_);
    }
    return *this;
}
Image readImage(const std::filesystem::path &path, unsigned maxEdge) {
    ImageReadOptions options;
    options.maxEdge = maxEdge;
    auto decoded = readImage(path, options);
    return std::move(decoded.image_);
}
namespace {
void checkDecode(std::stop_token stop) {
    if (stop.stop_requested()) throw std::runtime_error("Image decode cancelled");
}
void validate(const Image &image) {
    if (!image.width || !image.height || uint64_t(image.width) * image.height > 64'000'000 ||
        image.bgra.size() != uint64_t(image.width) * image.height * 4) throw std::runtime_error("Invalid image dimensions or pixels");
}
std::vector<uint8_t> rgba(const Image &image, bool rgb = false) {
    validate(image);
    const size_t channels = rgb ? 3 : 4;
    std::vector<uint8_t> pixels(size_t(image.width) * image.height * channels);
    for (size_t i = 0; i < size_t(image.width) * image.height; ++i) {
        pixels[i * channels] = image.bgra[i * 4 + 2];
        pixels[i * channels + 1] = image.bgra[i * 4 + 1];
        pixels[i * channels + 2] = image.bgra[i * 4];
        if (!rgb) pixels[i * channels + 3] = image.bgra[i * 4 + 3];
    }
    return pixels;
}
struct Output {
    std::vector<uint8_t> bytes;
    bool failed{};
    static void append(void *context, void *data, int count) noexcept {
        auto &self = *static_cast<Output *>(context);
        if (self.failed) return;
        try { self.bytes.insert(self.bytes.end(), static_cast<uint8_t *>(data), static_cast<uint8_t *>(data) + count); }
        catch (...) { self.failed = true; }
    }
};
void checkOutput(std::stop_token stop) {
    if(stop.stop_requested()) throw std::runtime_error("Image output cancelled");
}
void write(const std::vector<uint8_t> &data, const std::filesystem::path &path,std::stop_token stop={}) {
    checkOutput(stop);
    AtomicFile output(path);
    std::ofstream stream(output.path(), std::ios::binary);
    if(!stream) throw std::runtime_error("Cannot write image");
    constexpr size_t chunkSize=64*1024;
    for(size_t offset=0;offset<data.size();) {
        checkOutput(stop);
        const auto count=std::min(chunkSize,data.size()-offset);
        stream.write(reinterpret_cast<const char *>(data.data()+offset),std::streamsize(count));
        if(!stream) throw std::runtime_error("Cannot write image");
        offset+=count;
    }
    checkOutput(stop);
    stream.close();
    if (!stream) throw std::runtime_error("Cannot write image");
    checkOutput(stop);
    output.commit();
}
} // namespace
#ifndef __APPLE__
DecodedImage readImage(const std::filesystem::path &path, const ImageReadOptions &options) {
    checkDecode(options.stop);
    FileSnapshot input(path, 1024ull * 1024 * 1024, options.stop, options.resources);
    int width{}, height{}, channels{};
    auto bytes = input.bytes();
    if (bytes.size() > std::size_t(std::numeric_limits<int>::max()))
        throw std::runtime_error("Reference image encoded length exceeds decoder bounds");
    ImageDecodeContext context{options, {}, nullptr};
    ImageDecodeScope scope(context);
    if (!stbi_info_from_memory(bytes.data(), int(bytes.size()), &width, &height, &channels) || width <= 0 || height <= 0 ||
        uint64_t(width) * height > 64'000'000) {
        if (context.failure) std::rethrow_exception(context.failure);
        throw std::runtime_error("Reference image is invalid or exceeds 64 megapixels");
    }
    checkDecode(options.stop);
    const auto expectedWidth = width, expectedHeight = height;
    std::unique_ptr<stbi_uc, decltype(&stbi_image_free)> pixels(stbi_load_from_memory(bytes.data(), int(bytes.size()), &width, &height, &channels, 4), stbi_image_free);
    if (context.failure) std::rethrow_exception(context.failure);
    DecodedImage::checkpoint("decode.ready");
    checkDecode(options.stop);
    if (!pixels) throw std::runtime_error("Cannot decode reference image");
    if (width != expectedWidth || height != expectedHeight)
        throw std::runtime_error("Reference image dimensions changed during decode");
    const double factor = options.maxEdge ? std::min(1., double(options.maxEdge) / std::max(width, height)) : 1.;
    auto imageMemory=options.resources ? sceneMemoryForBudget(*options.resources,ResourceCategory::Image) : nullptr;
    Image image{unsigned(std::max(1, int(width * factor))), unsigned(std::max(1, int(height * factor))),
                AdmittedVector<uint8_t>{AdmittedAllocator<uint8_t>{std::move(imageMemory)}}};
    const auto outputBytes = imagePayloadBytes(image.width, image.height);
    image.bgra.resize(outputBytes);
    DecodedImage::checkpoint("pixels.ready");
    for (unsigned y = 0; y < image.height; ++y) {
        checkDecode(options.stop);
        for (unsigned x = 0; x < image.width; ++x) {
            const size_t source = (size_t(std::min(height - 1, int(y / factor))) * width + std::min(width - 1, int(x / factor))) * 4;
            const size_t target = (size_t(y) * image.width + x) * 4;
            for (unsigned c = 0; c < 4; ++c) image.bgra[target + c] = pixels.get()[source + (c == 0 ? 2 : c == 2 ? 0 : c)];
        }
    }
    checkDecode(options.stop);
    return DecodedImage(std::move(image));
}
#endif
void writePng(const Image &image, const std::filesystem::path &path) {
    auto pixels = rgba(image);
    Output output;
    if (!stbi_write_png_to_func(Output::append, &output, int(image.width), int(image.height), 4, pixels.data(), int(image.width) * 4) || output.failed)
        throw std::runtime_error("Cannot encode PNG image");
    write(output.bytes, path);
}
std::vector<uint8_t> jpeg95(const Image &image) {
    auto pixels = rgba(image, true);
    Output output;
    if (!stbi_write_jpg_to_func(Output::append, &output, int(image.width), int(image.height), 3, pixels.data(), 95) || output.failed)
        throw std::runtime_error("Cannot encode JPEG image");
    return std::move(output.bytes);
}
void writeJpeg95(const Image &image, const std::filesystem::path &path,std::stop_token stop) {
    checkOutput(stop);
    const auto encoded=jpeg95(image);
    checkOutput(stop);
    write(encoded,path,stop);
}
Image squareThumbnail(const Image &source, unsigned limit) {
    return squareThumbnail(source,limit,source.bgra.get_allocator().memory());
}
Image squareThumbnail(const Image &source, unsigned limit, std::shared_ptr<SceneMemory> imageService) {
    validate(source);
    if (!limit || limit > 8192) throw std::runtime_error("Invalid thumbnail size");
    const unsigned crop = std::min(source.width, source.height), edge = std::min(crop, limit);
    Image result{edge, edge, AdmittedVector<uint8_t>{AdmittedAllocator<uint8_t>{std::move(imageService)}}};
    result.bgra.resize(imagePayloadBytes(edge,edge));
    const unsigned ox = (source.width - crop) / 2, oy = (source.height - crop) / 2;
    for (unsigned y = 0; y < edge; ++y) for (unsigned x = 0; x < edge; ++x) {
        const size_t from = (size_t(oy + uint64_t(y) * crop / edge) * source.width + ox + uint64_t(x) * crop / edge) * 4;
        std::copy_n(source.bgra.data() + from, 4, result.bgra.data() + (size_t(y) * edge + x) * 4);
    }
    return result;
}
} // namespace preview
