#include "editing.hpp"
#include "binary_output.hpp"
#include <load-spz.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <stdexcept>

namespace preview {
void writeVisiblePly(const Scene &scene, std::span<const uint8_t> states, const std::filesystem::path &path,
                     std::stop_token stop) {
    if (!states.empty() && states.size() != scene.gaussians.size())
        throw std::runtime_error("Cleanup state does not match the scene");
    size_t count = scene.gaussians.size();
    for (auto state : states)
        count -= (state & 2) != 0;
    if (!count)
        throw std::runtime_error("There are no visible Gaussians to export. Undo or restore first.");
    const unsigned degree = std::min(scene.shDegree, 3u), coefficients = (degree + 1) * (degree + 1);
    std::ofstream out(path, std::ios::binary);
    if (!out)
        throw std::runtime_error("Cannot open the PLY output");
    out << "ply\nformat binary_little_endian 1.0\ncomment SplatView visible preview; RDF coordinates\n"
        << "comment Loaded source count " << scene.sourceCount << "; preview count " << scene.gaussians.size()
        << "\nelement vertex " << count << '\n';
    for (auto name : {"x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"})
        out << "property float " << name << '\n';
    for (unsigned i = 0; i < (coefficients - 1) * 3; ++i)
        out << "property float f_rest_" << i << '\n';
    for (auto name : {"opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"})
        out << "property float " << name << '\n';
    out << "end_header\n";
    auto converter = spz::coordinateConverter(spz::CoordinateSystem::RUB, spz::CoordinateSystem::RDF, degree);
    detail::BinaryOutput binary(out);
    auto put = [&](float value) { binary.put(value); };
    for (size_t i = 0; i < scene.gaussians.size(); ++i) {
        if ((i & 4095) == 0 && stop.stop_requested())
            throw std::runtime_error("Scene save cancelled");
        if (!states.empty() && (states[i] & 2))
            continue;
        const auto &g = scene.gaussians[i];
        put(g.positionOpacity[0]);
        put(-g.positionOpacity[1]);
        put(-g.positionOpacity[2]);
        put(0);
        put(0);
        put(0);
        for (unsigned c = 0; c < 3; ++c)
            put(shValue(g, 0, c));
        for (unsigned c = 0; c < 3; ++c)
            for (unsigned j = 1; j < coefficients; ++j)
                put(shValue(g, j, c) * converter.flipSh[j - 1]);
        float opacity = std::clamp(g.positionOpacity[3], 1e-7f, 1 - 1e-7f);
        put(std::log(opacity / (1 - opacity)));
        auto axes = exportAxesRdf(g);
        for (float scale : axes.logScales)
            put(scale);
        for (float value : axes.quaternion)
            put(value);
    }
    binary.flush();
    out.close();
    if (!out)
        throw std::runtime_error("The PLY output could not be written completely");
}
} // namespace preview
