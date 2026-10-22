#include "processing_kernels.hpp"
#include "math.hpp"
#include "parallel_for.hpp"
#include <algorithm>
#include <optional>

namespace preview {
namespace processing_detail {
namespace {
constexpr float c0 = .28209479177387814f, pi = 3.14159265358979323846f;
}
void keys(const Recipe &j, std::initializer_list<const char *> allowed) {
    if (!j.is_object())
        throw std::runtime_error("Editing values must be an object");
    for (auto it = j.begin(); it != j.end(); ++it)
        if (std::none_of(allowed.begin(), allowed.end(), [&](auto key) { return it.key() == key; }))
            throw std::runtime_error("Unknown editing field: " + it.key());
}
float number(const Recipe &j, const char *key, float fallback, float low, float high) {
    float v = j.contains(key) ? j.at(key).get<float>() : fallback;
    if (!std::isfinite(v) || v < low || v > high)
        throw std::runtime_error(std::string("Invalid ") + key);
    return v;
}
float lum(const std::array<float, 3> &c) {
    return .299f * c[0] + .587f * c[1] + .114f * c[2];
}
float smooth(float a, float b, float x) {
    float t = std::clamp((x - a) / (b - a), 0.f, 1.f);
    return t * t * (3 - 2 * t);
}
Grade::Grade(const Recipe &j) {
    if (!j.is_object())
        throw std::runtime_error("Color values must be an object");
    for (auto it = j.begin(); it != j.end(); ++it)
        if (std::none_of(std::begin(colorFields), std::end(colorFields),
                         [&](auto f) { return it.key() == f.name; }))
            throw std::runtime_error("Unknown color field: " + it.key());
    for (size_t i = 0; i < v.size(); ++i)
        v[i] = number(j, colorFields[i].name, colorFields[i].neutral, colorFields[i].low,
                      colorFields[i].high);
}
Grade::Grade(const ColorValues &values) : v(values) {
    for (size_t i = 0; i < v.size(); ++i)
        if (!std::isfinite(v[i]) || v[i] < colorFields[i].low || v[i] > colorFields[i].high)
            throw std::runtime_error(std::string("Invalid ") + colorFields[i].name);
}
Recipe Grade::json() const {
    Recipe j = Recipe::object();
    for (size_t i = 0; i < v.size(); ++i)
        j[colorFields[i].name] = v[i];
    return j;
}
bool Grade::neutral() const {
    for (size_t k = 0; k < v.size(); ++k)
        if (v[k] != colorFields[k].neutral)
            return false;
    return true;
}
// SH-aware gsmod ColorValues order. Split toning is also applied in the native path.
void Grade::apply(std::array<float, 48> &sh, unsigned bands) const {
    for (unsigned k = 0; k < bands; ++k) {
        auto p = sh.data() + 3 * k;
        p[0] *= 1 + .3f * v[5];
        p[2] *= 1 - .3f * v[5];
        if (!k) {
            p[0] += .05f * v[6];
            p[1] -= .1f * v[6];
            p[2] += .05f * v[6];
        }
        for (int c = 0; c < 3; ++c)
            p[c] = (p[c] * v[0] + (!k ? (v[0] - 1) * .5f / c0 : 0)) * v[1];
    }
    if (v[2] != 1) {
        // Fit a monotone affine gamma curve over each channel's directional
        // range. SH's addition theorem bounds the residual by its coefficient
        // norm times sqrt((bands - 1) / (4*pi)). Extending the fit below black
        // preserves negative DC / higher-band cancellation and is continuous
        // at gamma=1, without dividing by a possibly zero/negative luminance.
        for (int c = 0; c < 3; ++c) {
            float energy = 0;
            for (unsigned k = 1; k < bands; ++k)
                energy += sh[3 * k + c] * sh[3 * k + c];
            float radius = std::sqrt(energy * (float(bands - 1) * .07957747154594767f));
            float before = sh[c] * c0 + .5f;
            float low = std::max(0.f, before - radius), high = std::max(0.f, before + radius);
            if (high <= 0)
                continue; // This channel is below black in every direction.
            float gain, after;
            if (high - low > high * .001f) {
                float lowPower = std::pow(low, v[2]), highPower = std::pow(high, v[2]);
                gain = (highPower - lowPower) / (high - low);
                after = lowPower + (before - low) * gain;
            } else {
                // A narrow interval uses the tangent to avoid cancellation.
                after = std::pow(before, v[2]);
                gain = v[2] * after / before;
            }
            sh[c] = (after - .5f) / c0;
            for (unsigned k = 1; k < bands; ++k)
                sh[3 * k + c] *= gain;
        }
    }
    if (v[3] != 1 || v[14] != 0) {
        float angle = v[14] * pi / 180, cs = std::cos(angle), sn = std::sin(angle);
        const float hue[3][3] = {{.299f + .701f * cs + .168f * sn, .587f - .587f * cs + .330f * sn,
                                  .114f - .114f * cs - .497f * sn},
                                 {.299f - .299f * cs - .328f * sn, .587f + .413f * cs + .035f * sn,
                                  .114f - .114f * cs + .292f * sn},
                                 {.299f - .300f * cs + 1.250f * sn, .587f - .588f * cs - 1.050f * sn,
                                  .114f + .886f * cs - .203f * sn}};
        for (unsigned k = 0; k < bands; ++k) {
            std::array<float, 3> p{sh[k * 3], sh[k * 3 + 1], sh[k * 3 + 2]};
            float l = lum(p);
            for (auto &x : p)
                x = l + (x - l) * v[3];
            for (int c = 0; c < 3; ++c) {
                // Use the same RGB matrix for every band, preserving view-dependent color.
                sh[k * 3 + c] =
                    v[14] == 0 ? p[c] : hue[c][0] * p[0] + hue[c][1] * p[1] + hue[c][2] * p[2];
            }
        }
    }
    std::array<float, 3> rgb{sh[0] * c0 + .5f, sh[1] * c0 + .5f, sh[2] * c0 + .5f};
    if (v[4] != 1) {
        float l = lum(rgb), saturation = *std::max_element(rgb.begin(), rgb.end()) -
                                         *std::min_element(rgb.begin(), rgb.end());
        float boost = 1 + (1 - saturation) * (v[4] - 1);
        for (int c = 0; c < 3; ++c) {
            rgb[c] = std::clamp(l + (rgb[c] - l) * boost, 0.f, 1.f);
            sh[c] = (rgb[c] - .5f) / c0;
        }
    }
    float l = lum(rgb), shadow = 1 - smooth(0, .5f, l), highlight = smooth(.5f, 1, l);
    for (int c = 0; c < 3; ++c) {
        sh[c] *= 1 + v[7] * shadow + v[8] * highlight;
        sh[c] += v[9] * (1 - v[9]) / c0; // gsmod SH black-point lift
        if (v[11] != 0)
            sh[c] += .5f * std::cos(v[10] * pi / 180 - c * 2 * pi / 3) * v[11] * shadow / c0;
        if (v[13] != 0)
            sh[c] += .5f * std::cos(v[12] * pi / 180 - c * 2 * pi / 3) * v[13] * highlight / c0;
    }
}
std::array<float, 48> coefficients(const Gaussian &g) {
    std::array<float, 48> a{};
    for (unsigned i = 0; i < a.size(); ++i)
        a[i] = shValue(g, i / 3, i % 3);
    return a;
}
void store(Gaussian &g, const std::array<float, 48> &a) {
    for (size_t i = 0; i < 24; ++i) {
        float lo = a[2 * i], hi = a[2 * i + 1];
        if (!std::isfinite(lo) || !std::isfinite(hi))
            throw std::runtime_error("Color edit produced non-finite coefficients");
        g.sh[i] =
            DirectX::PackedVector::XMConvertFloatToHalf(std::clamp(lo, -maxShCoefficient, maxShCoefficient)) |
            uint32_t(DirectX::PackedVector::XMConvertFloatToHalf(
                std::clamp(hi, -maxShCoefficient, maxShCoefficient)))
                << 16;
    }
}
std::array<double, 3> Affine::point(std::array<double, 3> p, bool inverseRotation) const {
    std::array<double, 3> q{};
    if (inverseRotation) {
        for (int r = 0; r < 3; ++r)
            for (int c = 0; c < 3; ++c)
                q[r] += a[c][r] * (p[c] - t[c]);
    } else {
        for (int r = 0; r < 3; ++r) {
            q[r] = t[r];
            for (int c = 0; c < 3; ++c)
                q[r] += a[r][c] * p[c];
        }
    }
    return q;
}
void Affine::apply(Gaussian &g) const {
    auto p = point({g.positionOpacity[0], g.positionOpacity[1], g.positionOpacity[2]});
    double cov[3][3]{{g.covA[0], g.covA[1], g.covA[2]},
                     {g.covA[1], g.covA[3], g.covB[0]},
                     {g.covA[2], g.covB[0], g.covB[1]}},
        out[3][3]{};
    for (int r = 0; r < 3; ++r)
        for (int c = 0; c < 3; ++c)
            for (int k = 0; k < 3; ++k)
                for (int l = 0; l < 3; ++l)
                    out[r][c] += a[r][k] * cov[k][l] * a[c][l];
    for (int r = 0; r < 3; ++r) {
        if (!std::isfinite(p[r]) || std::abs(p[r]) > 1e12)
            throw std::runtime_error("Transformed position exceeds the supported range");
        g.positionOpacity[r] = float(p[r]);
        for (int c = 0; c < 3; ++c)
            if (!std::isfinite(out[r][c]) || std::abs(out[r][c]) > 1e24)
                throw std::runtime_error("Transformed covariance exceeds the supported range");
    }
    g.covA = {float(out[0][0]), float(out[0][1]), float(out[0][2]), float(out[1][1])};
    g.covB[0] = float(out[1][2]);
    g.covB[1] = float(out[2][2]);
}
Affine transform(const Recipe &j) {
    for (const char *alias : {"from_scale", "from_translation", "from_rotation_euler", "from_euler_rad",
                              "from_rotation_axis_angle", "from_axis_angle_rad", "from_matrix"})
        if (j.contains(alias)) {
            if (j.size() != 1)
                throw std::runtime_error("Use one gsmod transform factory per step");
            Recipe converted;
            std::string name = alias;
            if (name == "from_scale")
                converted = {{"scale", j[alias]}};
            else if (name == "from_translation")
                converted = {{"translation", j[alias]}};
            else if (name == "from_matrix")
                converted = {{"matrix", j[alias]}};
            else if (name == "from_rotation_euler" || name == "from_euler_rad") {
                auto angles = array<3>(j, alias, {});
                if (name == "from_euler_rad")
                    for (auto &a : angles)
                        a *= 180 / pi;
                converted = {{"euler", angles}};
            } else {
                const auto &aa = j[alias];
                if (!aa.is_array() || aa.size() != 2)
                    throw std::runtime_error("Axis-angle factory needs [axis, angle]");
                Recipe axisValue = {{"axis", aa[0]}, {"angle", aa[1]}};
                auto axis = array<3>(axisValue, "axis", {});
                float angle = number(axisValue, "angle", 0);
                float norm = std::hypot(axis[0], axis[1], axis[2]);
                if (norm < 1e-6f) {
                    axis = {0, 0, 1};
                    norm = 1;
                }
                for (auto &a : axis)
                    a = a / norm * angle * (name == "from_rotation_axis_angle" ? pi / 180 : 1);
                converted = {{"axis_angle", axis}};
            }
            return transform(converted);
        }
    keys(j, {"translation", "scale", "center", "rotation", "euler", "axis_angle", "matrix"});
    Affine out;
    if (j.contains("matrix")) {
        auto m = array<16>(j, "matrix", {});
        Matrix4 matrix;
        for (unsigned r = 0; r < 4; ++r)
            for (unsigned c = 0; c < 4; ++c)
                matrix[c * 4 + r] = m[r * 4 + c];
        return transform(matrix);
    }
    auto scale =
        j.contains("scale") && j["scale"].is_number()
            ? std::array<float, 3>{number(j, "scale", 1), number(j, "scale", 1), number(j, "scale", 1)}
            : array<3>(j, "scale", {1, 1, 1});
    auto trans = array<3>(j, "translation", {}), pivot = array<3>(j, "center", {});
    auto q = array<4>(j, "rotation", {1, 0, 0, 0});
    if (j.contains("euler")) {
        auto e = array<3>(j, "euler", {});
        double x = e[0] * pi / 360, y = e[1] * pi / 360, z = e[2] * pi / 360;
        // gsmod roll/pitch/yaw convention: Rz * Ry * Rx.
        q = {float(cos(x) * cos(y) * cos(z) + sin(x) * sin(y) * sin(z)),
             float(sin(x) * cos(y) * cos(z) - cos(x) * sin(y) * sin(z)),
             float(cos(x) * sin(y) * cos(z) + sin(x) * cos(y) * sin(z)),
             float(cos(x) * cos(y) * sin(z) - sin(x) * sin(y) * cos(z))};
    } else if (j.contains("axis_angle")) {
        auto aa = array<3>(j, "axis_angle", {});
        double angle = std::hypot(aa[0], aa[1], aa[2]), s = angle > 1e-12 ? sin(angle / 2) / angle : .5;
        q = {float(cos(angle / 2)), float(aa[0] * s), float(aa[1] * s), float(aa[2] * s)};
    }
    double norm =
        std::sqrt(double(q[0]) * q[0] + double(q[1]) * q[1] + double(q[2]) * q[2] + double(q[3]) * q[3]);
    if (!std::isfinite(norm) || norm == 0)
        throw std::runtime_error("Rotation quaternion cannot be zero");
    double w = q[0] / norm, x = q[1] / norm, y = q[2] / norm, z = q[3] / norm;
    double rot[3][3]{{1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)},
                     {2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)},
                     {2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)}};
    for (int r = 0; r < 3; ++r) {
        if (scale[r] <= 0 || scale[r] > 1e6)
            throw std::runtime_error("Scale must be positive and at most 1,000,000");
        out.t[r] = trans[r] + pivot[r];
        for (int c = 0; c < 3; ++c) {
            out.a[r][c] = rot[r][c] * scale[c];
            out.t[r] -= out.a[r][c] * pivot[c];
        }
    }
    return out;
}
Affine transform(const Matrix4 &matrix) {
    for (float value : matrix)
        if (!std::isfinite(value) || std::abs(value) > 1e12f)
            throw std::runtime_error("Invalid matrix");
    if (matrix[3] != 0 || matrix[7] != 0 || matrix[11] != 0 || matrix[15] != 1)
        throw std::runtime_error("Only affine 4x4 row-major matrices are supported");
    Affine result;
    for (unsigned r = 0; r < 3; ++r) {
        result.t[r] = matrix[12 + r];
        for (unsigned c = 0; c < 3; ++c)
            result.a[r][c] = matrix[c * 4 + r];
    }
    return result;
}
std::array<double, 16> ShRotation::basis(const std::array<double, 3> &d) {
    const auto x = d[0], y = d[1], z = d[2], xx = x * x, yy = y * y, zz = z * z;
    return {.28209479177387814,
            -.4886025119029199 * y,
            .4886025119029199 * z,
            -.4886025119029199 * x,
            1.0925484305920792 * x * y,
            -1.0925484305920792 * y * z,
            .31539156525252005 * (2 * zz - xx - yy),
            -1.0925484305920792 * x * z,
            .5462742152960396 * (xx - yy),
            -.5900435899266435 * y * (3 * xx - yy),
            2.890611442640554 * x * y * z,
            -.4570457994644658 * y * (4 * zz - xx - yy),
            .3731763325901154 * z * (2 * zz - 3 * xx - 3 * yy),
            -.4570457994644658 * x * (4 * zz - xx - yy),
            1.445305721320277 * z * (xx - yy),
            -.5900435899266435 * x * (xx - 3 * yy)};
}
ShRotation::ShRotation(const Affine &affine, unsigned shDegree) : degree(std::min(shDegree, 3u)) {
    const double scale = std::hypot(affine.a[0][0], affine.a[1][0], affine.a[2][0]);
    for (unsigned r = 0; r < 3; ++r)
        for (unsigned c = 0; c < 3; ++c)
            needed |= std::abs(affine.a[r][c] / scale - (r == c ? 1. : 0.)) > 1e-8;
    if (!needed)
        return;
    // Four Gauss-Legendre heights and eight azimuths integrate products of
    // SH0..SH3 exactly. Build each band once, then rotate its RGB coefficients.
    constexpr double z[]{-.8611363115940526, -.3399810435848563, .3399810435848563, .8611363115940526};
    constexpr double weights[]{.3478548451374538, .6521451548625461, .6521451548625461,
                               .3478548451374538};
    constexpr double tau = 6.2831853071795864769;
    for (unsigned h = 0; h < 4; ++h)
        for (unsigned k = 0; k < 8; ++k) {
            const double radius = std::sqrt(1 - z[h] * z[h]);
            const std::array<double, 3> direction{radius * std::cos(tau * k / 8),
                                                  radius * std::sin(tau * k / 8), z[h]};
            std::array<double, 3> original{};
            for (unsigned c = 0; c < 3; ++c)
                for (unsigned r = 0; r < 3; ++r)
                    original[c] += affine.a[r][c] / scale * direction[r];
            const auto before = basis(original), after = basis(direction);
            for (unsigned band = 1; band <= degree; ++band)
                for (unsigned row = band * band; row < (band + 1) * (band + 1); ++row)
                    for (unsigned col = band * band; col < (band + 1) * (band + 1); ++col)
                        rotation[row][col] += after[row] * before[col] * weights[h] * tau / 8;
        }
}
void ShRotation::apply(Gaussian &gaussian) const {
    if (!needed)
        return;
    const auto before = coefficients(gaussian);
    auto after = before;
    for (unsigned band = 1; band <= degree; ++band)
        for (unsigned row = band * band; row < (band + 1) * (band + 1); ++row)
            for (unsigned channel = 0; channel < 3; ++channel) {
                double value = 0;
                for (unsigned col = band * band; col < (band + 1) * (band + 1); ++col)
                    value += rotation[row][col] * before[3 * col + channel];
                after[3 * row + channel] = float(value);
            }
    store(gaussian, after);
}

namespace {
void validateStates(const Scene &scene, std::span<const uint8_t> states, bool selectedOnly) {
    if ((!states.empty() && states.size() != scene.gaussians.size()) ||
        std::any_of(states.begin(), states.end(), [](uint8_t state) { return state > 2; }))
        throw std::runtime_error("Invalid scene for editing");
    if (selectedOnly && std::none_of(states.begin(), states.end(), [](uint8_t state) { return state == 1; }))
        throw std::runtime_error("Select splats first");
}
bool active(std::span<const uint8_t> states, size_t i, bool selectedOnly) {
    const auto state = states.empty() ? uint8_t(0) : states[i];
    return !(state & 2) && (!selectedOnly || (state & 1));
}
} // namespace
void applyColor(Scene &scene, std::span<const uint8_t> states, const Grade &grade, bool selectedOnly,
                std::stop_token stop) {
    validateStates(scene, states, selectedOnly);
    const unsigned bands = (std::min(scene.shDegree, 3u) + 1) * (std::min(scene.shDegree, 3u) + 1);
    detail::parallelFor(scene.gaussians.size(), stop, [&](size_t i) {
        if (active(states, i, selectedOnly)) {
            auto values = coefficients(scene.gaussians[i]);
            grade.apply(values, bands);
            store(scene.gaussians[i], values);
        }
    });
}
void applyTransform(Scene &scene, std::span<const uint8_t> states, const Affine &affine, bool selectedOnly,
                    bool rotateDirectionalColor, std::stop_token stop) {
    validateStates(scene, states, selectedOnly);
    std::optional<ShRotation> rotation;
    if (rotateDirectionalColor && scene.shDegree)
        rotation.emplace(affine, scene.shDegree);
    detail::parallelFor(scene.gaussians.size(), stop, [&](size_t i) {
        if (active(states, i, selectedOnly)) {
            affine.apply(scene.gaussians[i]);
            if (rotation)
                rotation->apply(scene.gaussians[i]);
        }
    });
}
} // namespace processing_detail
std::shared_ptr<const Scene> previewScene(std::shared_ptr<const Scene> source, std::span<const uint8_t> states,
                                         const ColorValues &color, bool colorSelectedOnly,
                                         const Matrix4 &geometry, bool geometrySelectedOnly,
                                         std::stop_token stop) {
    return previewScene(std::move(source),states,color,colorSelectedOnly,geometry,geometrySelectedOnly,stop,{});
}
std::shared_ptr<const Scene> previewScene(std::shared_ptr<const Scene> source, std::span<const uint8_t> states,
                                         const ColorValues &color, bool colorSelectedOnly,
                                         const Matrix4 &geometry, bool geometrySelectedOnly,
                                         std::stop_token stop,std::shared_ptr<SceneMemory> scratch) {
    using namespace processing_detail;
    if (!source || !source->isGaussian() || source->gaussians.size() > processingSplatLimit)
        throw std::runtime_error("Invalid scene for editing");
    validateStates(*source, states, false);
    if (stop.stop_requested())
        throw std::runtime_error("Editing cancelled; the scene was preserved.");
    std::shared_ptr<Scene> output;
    if (color != neutralColor) {
        validateStates(*source, states, colorSelectedOnly);
        const Grade grade(color);
        if (!grade.neutral()) {
            output = std::make_shared<Scene>(*source);
            applyColor(*output, states, grade, colorSelectedOnly, stop);
        }
    }
    if (geometry != identityMatrix) {
        validateStates(*source, states, geometrySelectedOnly);
        const auto affine = transform(geometry);
        if (!output)
            output = std::make_shared<Scene>(*source);
        applyTransform(*output, states, affine, geometrySelectedOnly, false, stop);
        output->previewEye.reset();
        output->defaultView.reset();
        fitBounds(*output,std::move(scratch));
    }
    if (stop.stop_requested())
        throw std::runtime_error("Editing cancelled; the scene was preserved.");
    return output ? output : source;
}
} // namespace preview
