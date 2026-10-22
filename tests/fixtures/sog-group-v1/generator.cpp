// Construction only: fixed original RGBA pixels, never a SplatView decoder.
// Build independently with the pinned Emscripten contrib.libwebp 1.6.0 port.
#include <webp/encode.h>
#include <webp/decode.h>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <stdexcept>
#include <string>

using Pixels = std::array<uint8_t, 16>;
struct Plane { const char* name; Pixels rgba; };
constexpr Plane planes[] = {
    {"positions-low.webp", {0,0,255,255, 0,255,0,255, 255,0,0,255, 42,43,44,255}},
    {"positions-high.webp", {0,128,255,255, 64,191,0,255, 255,0,128,255, 45,46,47,255}},
    {"appearance.webp", {0,128,255,32, 255,64,192,128, 80,160,240,224, 1,2,3,0}},
    {"rotations.webp", {128,128,128,252, 200,32,128,253, 64,191,224,255, 0,0,0,254}},
};

void encode(const std::string& directory, const Plane& plane) {
    WebPConfig config;
    if (!WebPConfigInit(&config)) throw std::runtime_error("WebPConfigInit failed");
    config.lossless = 1;
    config.quality = 100;
    config.method = 6;
    config.exact = 1;
    config.near_lossless = 100;
    config.thread_level = 0;
    if (!WebPValidateConfig(&config)) throw std::runtime_error("Invalid fixed WebP config");
    WebPPicture picture;
    if (!WebPPictureInit(&picture)) throw std::runtime_error("WebPPictureInit failed");
    picture.use_argb = 1;
    picture.width = 2;
    picture.height = 2;
    WebPMemoryWriter writer;
    WebPMemoryWriterInit(&writer);
    picture.writer = WebPMemoryWrite;
    picture.custom_ptr = &writer;
    if (!WebPPictureImportRGBA(&picture, plane.rgba.data(), 8)) {
        WebPPictureFree(&picture);
        WebPMemoryWriterClear(&writer);
        throw std::runtime_error("WebPPictureImportRGBA failed");
    }
    const int success = WebPEncode(&config, &picture);
    WebPPictureFree(&picture);
    if (!success) {
        WebPMemoryWriterClear(&writer);
        throw std::runtime_error("WebPEncode failed");
    }
    int width = 0, height = 0;
    uint8_t* decoded = WebPDecodeRGBA(writer.mem, writer.size, &width, &height);
    const bool exact = decoded && width == 2 && height == 2 &&
                       std::memcmp(decoded, plane.rgba.data(), plane.rgba.size()) == 0;
    WebPFree(decoded);
    if (!exact) {
        WebPMemoryWriterClear(&writer);
        throw std::runtime_error("Encoded plane did not preserve all16 literal RGBA bytes");
    }
    const std::string path = directory + "/" + plane.name;
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(reinterpret_cast<const char*>(writer.mem), static_cast<std::streamsize>(writer.size));
    const size_t bytes = writer.size;
    WebPMemoryWriterClear(&writer);
    if (!output) throw std::runtime_error("Could not write encoded plane");
    std::printf("%s: %zu bytes; 2x2 exact RGBA verified\n", plane.name, bytes);
}

int main(int argc, char** argv) {
    try {
        if (argc != 2) throw std::runtime_error("Usage: encoder.cjs EXISTING_OUTPUT_DIRECTORY");
        if (WebPGetEncoderVersion() != 0x010600 || WebPGetDecoderVersion() != 0x010600)
            throw std::runtime_error("This fixture requires pinned libwebp1.6.0");
        for (const auto& plane : planes) encode(argv[1], plane);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "%s\n", error.what());
        return 1;
    }
}
