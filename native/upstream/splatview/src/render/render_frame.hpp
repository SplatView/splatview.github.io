#pragma once
#include "render_types.hpp"
#include "render_storage.hpp"
#include "admitted_storage.hpp"
#include <span>
#include <stop_token>
#include <type_traits>

namespace preview {
// Plain 16-byte fields shared with Metal. Positions/axes are in top-left pixel
// coordinates; packets are stable sorted back to front. No platform GPU types.
struct alignas(16) GaussianPacket {
    std::array<float, 4> centerDepth; // x, y, positive view depth, covariance support
    std::array<float, 4> axes;        // two 3-sigma screen-space axes
    std::array<float, 4> color;       // unassociated RGB and opacity
    std::array<uint32_t, 4> identity; // original index + 1, edit state, reserved
};
static_assert(sizeof(GaussianPacket) == 64);
static_assert(offsetof(GaussianPacket, color) == 32);
static_assert(std::is_trivially_copyable_v<GaussianPacket>);
struct GeometryPacket {
    std::array<float, 4> clip;
    std::array<float, 4> color;
    std::array<float, 4> world;
};
static_assert(sizeof(GeometryPacket) == 48);
struct RenderFrame {
    unsigned width{}, height{};
    SceneType type{SceneType::GaussianSplats};
    size_t sourceCount{};
    // Actual vector allocations retain their packet-service grants. These
    // public member types change the RenderFrame C++ ABI; consumers must rebuild
    // against this header rather than reuse an earlier shared-core archive.
    AdmittedVector<GaussianPacket> splats;
    AdmittedVector<GeometryPacket> vertices;
    AdmittedVector<std::array<uint32_t, 3>> triangles;
};
static_assert(std::is_nothrow_move_constructible_v<RenderFrame>);
static_assert(std::is_nothrow_move_assignable_v<RenderFrame>);
RenderFrame prepareFrame(std::shared_ptr<const Scene>, std::span<const uint8_t>, const Camera &,
                         unsigned width, unsigned height, const ViewSettings & = {}, std::stop_token = {});
RenderFrame prepareFrame(std::shared_ptr<const Scene>, std::span<const uint8_t>, const Camera &,
                         unsigned width, unsigned height, const ViewSettings &, std::stop_token,
                         std::shared_ptr<SceneMemory> scratch);
// The compatibility wrappers leave packet storage unbudgeted; their existing
// scratch argument binds only transformed-scene/bounds Work. This entry point
// also binds returned packets and temporary sort storage to storage.packets.
RenderFrame prepareFrameWithStorage(std::shared_ptr<const Scene>, std::span<const uint8_t>, const Camera &,
                                    unsigned width, unsigned height, const ViewSettings &, std::stop_token,
                                    RenderStorage);
float sampleAlpha(const GaussianPacket &, float x, float y);
} // namespace preview
