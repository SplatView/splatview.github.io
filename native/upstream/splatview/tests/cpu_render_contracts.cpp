#include "software_renderer.hpp"
#include <cmath>
#include <iostream>
#include <stdexcept>

namespace {
void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
}
int main() {
    using namespace preview;
    try {
        auto scene = std::make_shared<Scene>();
        Attributes a;
        a.scale = {.15f, .08f, .1f};
        a.opacity = .8f;
        a.sh[0] = 1;
        scene->gaussians.push_back(packGaussian(a));
        fitBounds(*scene);
        Camera camera;
        camera.target = {};
        camera.yaw = camera.pitch = 0;
        camera.distance = 3;
        camera.radius = 1;
        SoftwareRenderer renderer;
        renderer.resize(64, 64);
        renderer.setScene(scene);
        renderer.draw(camera);
        require(renderer.readback().bgra.size() == 64 * 64 * 4, "CPU image dimensions");
        const size_t center = (32 * 64 + 32) * 4;
        const auto image = renderer.readback().bgra;
        require(image[center + 2] > image[center] && image[center + 3] == 255,
                "Analytic red Gaussian produces an opaque BGRA output");
        require(renderer.pick(camera, {32, 32}) == 0 && !renderer.pick(camera, {-1, 32}),
                "Picking preserves original zero-based identity");
        const auto map = renderer.selectionMap(camera, true, true);
        require(map.ids[32 * 64 + 32] == 1 && std::abs(map.depths[32 * 64 + 32] - 3) < 1e-5f,
                "Surface map has one-based ID and positive view depth");
        require(map.visible.size() == 1 && (map.visible[0] & 1), "Original ID appears in visibility bits");
        renderer.draw(camera);
        require(renderer.stats().rasterizations == 1 && renderer.stats().cacheHits == 1,
                "An unchanged request reuses the reference image");
        std::stop_source cancelled;
        cancelled.request_stop();
        auto moved = camera;
        moved.roll = .5f;
        bool rejected = false;
        try { renderer.draw(moved, {}, cancelled.get_token()); }
        catch (const std::exception &) { rejected = true; }
        require(rejected && renderer.readback().bgra == image,
                "Cancelled rendering preserves the last complete image");
        std::cout << "PASS standalone CPU renderer: compositing, IDs/depth, visibility, cache and cancellation\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
