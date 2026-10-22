#pragma once
#include "scene.hpp"
#include "color.hpp"
#include "recipe.hpp"
#include <cmath>
#include <memory>
#include <span>
#include <stop_token>
#include <stdexcept>

namespace preview {
inline constexpr size_t processingSplatLimit = 3'000'000;
// Pure color/geometry preview. Retains the input for neutral values, otherwise
// returns a private edited scene. It performs no path, image or codec access.
std::shared_ptr<const Scene> previewScene(std::shared_ptr<const Scene>, std::span<const uint8_t>,
                                         const ColorValues &, bool colorSelectedOnly,
                                         const Matrix4 &, bool geometrySelectedOnly,
                                         std::stop_token = {});
std::shared_ptr<const Scene> previewScene(std::shared_ptr<const Scene>, std::span<const uint8_t>,
                                         const ColorValues &, bool colorSelectedOnly,
                                         const Matrix4 &, bool geometrySelectedOnly,
                                         std::stop_token, std::shared_ptr<SceneMemory> scratch);
namespace processing_detail {
void keys(const Recipe &, std::initializer_list<const char *>);
float number(const Recipe &, const char *, float fallback, float low = -1e12f, float high = 1e12f);
template <size_t N> std::array<float, N> array(const Recipe &j, const char *key, std::array<float, N> def) {
    if (!j.contains(key) || j.at(key).is_null())
        return def;
    const auto &a = j.at(key);
    if (!a.is_array() || a.size() != N)
        throw std::runtime_error(std::string(key) + " has the wrong dimensions");
    for (size_t i = 0; i < N; ++i) {
        def[i] = a[i].get<float>();
        if (!std::isfinite(def[i]) || std::abs(def[i]) > 1e12f)
            throw std::runtime_error(std::string("Invalid ") + key);
    }
    return def;
}
float lum(const std::array<float, 3> &);
struct Grade {
    ColorValues v{};
    explicit Grade(const Recipe &);
    explicit Grade(const ColorValues &);
    Recipe json() const;
    bool neutral() const;
    void apply(std::array<float, 48> &, unsigned bands) const;
};
std::array<float, 48> coefficients(const Gaussian &);
void store(Gaussian &, const std::array<float, 48> &);
struct Affine {
    double a[3][3]{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}, t[3]{};
    std::array<double, 3> point(std::array<double, 3>, bool inverseRotation = false) const;
    void apply(Gaussian &) const;
};
Affine transform(const Recipe &);
Affine transform(const Matrix4 &);
struct ShRotation {
    std::array<std::array<double, 16>, 16> rotation{};
    unsigned degree{};
    bool needed{};
    static std::array<double, 16> basis(const std::array<double, 3> &);
    ShRotation(const Affine &, unsigned shDegree);
    void apply(Gaussian &) const;
};
// The caller owns a writable working scene. Errors/cancellation must discard it.
void applyColor(Scene &, std::span<const uint8_t>, const Grade &, bool selectedOnly, std::stop_token = {});
void applyTransform(Scene &, std::span<const uint8_t>, const Affine &, bool selectedOnly,
                    bool rotateDirectionalColor = false, std::stop_token = {});
} // namespace processing_detail
} // namespace preview
