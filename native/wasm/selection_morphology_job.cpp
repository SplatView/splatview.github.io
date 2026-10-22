#include "selection_morphology_job.hpp"
#include <algorithm>
#include <bit>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview::browser_morphology {
namespace {
// Contact math below is copied from the captured desktop selection_morphology.cpp.
// Only the surrounding traversal is changed to make work cooperative.
constexpr double contactTolerance = 2e-6;
constexpr double covarianceRepair = 4 * double(std::numeric_limits<float>::epsilon());
using Vector = std::array<double, 3>;
using Shape = std::array<double, 6>; // xx, xy, xz, yy, yz, zz
double dot(const Vector &a, const Vector &b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
Vector multiply(const Shape &a, const Vector &v) {
    return {a[0] * v[0] + a[1] * v[1] + a[2] * v[2], a[1] * v[0] + a[3] * v[1] + a[4] * v[2],
            a[2] * v[0] + a[4] * v[1] + a[5] * v[2]};
}
bool solve(const Shape &a, const Vector &d, Vector &v) {
    if (!(a[0] > 0)) return false;
    const double l00 = std::sqrt(a[0]), l10 = a[1] / l00, l20 = a[2] / l00;
    const double pivot1 = a[3] - l10 * l10;
    if (!(pivot1 > 0)) return false;
    const double l11 = std::sqrt(pivot1), l21 = (a[4] - l20 * l10) / l11;
    const double pivot2 = a[5] - l20 * l20 - l21 * l21;
    if (!(pivot2 > 0)) return false;
    const double l22 = std::sqrt(pivot2);
    const double y0 = d[0] / l00, y1 = (d[1] - l10 * y0) / l11, y2 = (d[2] - l20 * y0 - l21 * y1) / l22;
    v[2] = y2 / l22;
    v[1] = (y1 - l21 * v[2]) / l11;
    v[0] = (y0 - l10 * v[1] - l20 * v[2]) / l00;
    return std::isfinite(v[0]) && std::isfinite(v[1]) && std::isfinite(v[2]);
}
Shape shape(const Gaussian &g, double sigma) {
    const double varianceScale = sigma * sigma;
    return {varianceScale * double(g.covA[0]), varianceScale * double(g.covA[1]),
            varianceScale * double(g.covA[2]), varianceScale * double(g.covA[3]),
            varianceScale * double(g.covB[0]), varianceScale * double(g.covB[1])};
}
bool prepare(Shape &a, double scale) {
    for (auto &value : a) {
        value /= scale;
        if (!std::isfinite(value)) return false;
    }
    Vector unused;
    if (solve(a, {}, unused)) return true;
    for (size_t i : {0u, 3u, 5u}) a[i] *= 1 + covarianceRepair;
    return solve(a, {}, unused);
}
bool touches(const Gaussian &first, const Gaussian &second, double sigma) {
    Shape a = shape(first, sigma), b = shape(second, sigma);
    const double scale = std::max({a[0], a[3], a[5], b[0], b[3], b[5]});
    if (!(scale > 0) || !std::isfinite(scale) || !prepare(a, scale) || !prepare(b, scale)) return false;
    const double inverseRadius = 1 / std::sqrt(scale);
    Vector d;
    for (size_t i = 0; i < 3; ++i)
        d[i] = (double(second.positionOpacity[i]) - first.positionOpacity[i]) * inverseRadius;
    if (dot(d, d) > std::sqrt(std::max(0., dot(d, multiply(a, d)))) +
                        std::sqrt(std::max(0., dot(d, multiply(b, d)))) + contactTolerance * dot(d, d))
        return false;
    Shape difference;
    for (size_t i = 0; i < a.size(); ++i) difference[i] = b[i] - a[i];
    // Perram-Wertheim: max t(1-t) d^T ((1-t)A+tB)^-1 d <= 1.
    // https://doi.org/10.1016/0021-9991(85)90171-8
    double low = 0, high = 1;
    for (unsigned iteration = 0; iteration < 64; ++iteration) {
        const double t = (low + high) * .5, weight = t * (1 - t);
        Shape blended;
        for (size_t i = 0; i < a.size(); ++i) blended[i] = (1 - t) * a[i] + t * b[i];
        Vector v;
        if (!solve(blended, d, v)) return false;
        const double distance = dot(d, v), value = weight * distance;
        if (value > 1 + contactTolerance) return false;
        const double derivative = (1 - 2 * t) * distance - weight * dot(v, multiply(difference, v));
        const double upper = value + derivative * (derivative > 0 ? high - t : low - t);
        if (upper <= 1 + contactTolerance) return true;
        if (derivative > 0) low = t;
        else high = t;
    }
    return true;
}
Bounds bounds(const Gaussian &g, double sigma) {
    const double variance[] = {g.covA[0], g.covA[3], g.covB[1]};
    Bounds box;
    for (size_t i = 0; i < 3; ++i) {
        if (!std::isfinite(g.positionOpacity[i]) || !std::isfinite(variance[i]) || variance[i] <= 0)
            throw std::runtime_error("Selection needs finite Gaussian positions and positive covariances.");
        const double extent = sigma * std::sqrt(variance[i] * (1 + covarianceRepair)) * (1 + contactTolerance);
        box.low[i] = std::nextafter(float(double(g.positionOpacity[i]) - extent), -std::numeric_limits<float>::infinity());
        box.high[i] = std::nextafter(float(double(g.positionOpacity[i]) + extent), std::numeric_limits<float>::infinity());
    }
    return box;
}
Bounds centerBounds(const Gaussian &g) {
    Bounds box;
    for(size_t i=0;i<3;++i) {
        if(!std::isfinite(g.positionOpacity[i])) throw std::runtime_error("Selection needs finite Gaussian positions.");
        box.low[i]=box.high[i]=g.positionOpacity[i];
    }
    return box;
}
bool within(const Bounds &box,const Gaussian &query,double squaredDistance) {
    double distance=0;
    for(size_t i=0;i<3;++i) {
        const double point=query.positionOpacity[i];
        const double offset=std::max({double(box.low[i])-point,point-double(box.high[i]),0.});
        distance+=offset*offset;
    }
    return distance<=squaredDistance;
}
bool within(const Gaussian &a,const Gaussian &b,double squaredDistance) {
    double distance=0;
    for(size_t i=0;i<3;++i) {
        const double offset=double(a.positionOpacity[i])-b.positionOpacity[i];
        distance+=offset*offset;
    }
    return distance<=squaredDistance;
}
size_t addBytes(size_t sum, size_t count, size_t width) {
    if (count > (std::numeric_limits<size_t>::max() - sum) / width) throw std::length_error("Morphology scratch is too large.");
    return sum + count * width;
}
float median(float a, float b, float c) noexcept {
    if (a < b) return b < c ? b : std::max(a, c);
    return a < c ? a : std::max(b, c);
}
uint32_t scramble(uint32_t value) noexcept {
    value ^= value >> 16; value *= 0x7feb352d; value ^= value >> 15;
    value *= 0x846ca68b; return value ^ (value >> 16);
}
uint32_t orderedKey(float value) noexcept {
    const auto bits = std::bit_cast<uint32_t>(value);
    return bits & 0x80000000u ? ~bits : bits ^ 0x80000000u;
}
} // namespace
bool Bounds::touches(const Bounds &b) const noexcept {
    for (size_t i = 0; i < 3; ++i) if (low[i] > b.high[i] || high[i] < b.low[i]) return false;
    return true;
}
void Bounds::include(const Bounds &b) noexcept {
    for (size_t i = 0; i < 3; ++i) { low[i] = std::min(low[i], b.low[i]); high[i] = std::max(high[i], b.high[i]); }
}
ScratchRequirements scratchRequirements(size_t n) {
    if (n > UINT32_MAX) throw std::length_error("Too many Gaussians for selection.");
    // At the last complete level P is a power of two <= N/16. Its ranges
    // have floor(N/P) or ceil(N/P) entries. If that floor exceeds 16 every
    // range splits once; otherwise only the N-16P oversized ranges split.
    const auto p = n <= 16 ? size_t(0) : std::bit_floor(n / 16);
    const auto leaves = !p ? size_t(0) : n / p > 16 ? 2 * p : p + (n - 16 * p);
    const size_t nodes = !n ? 0 : n <= 16 ? 1 : 2 * leaves - 1;
    size_t bytes = 0;
    bytes = addBytes(bytes, n, sizeof(Bounds));
    bytes = addBytes(bytes, n, sizeof(uint32_t));
    bytes = addBytes(bytes, nodes, sizeof(Node));
    bytes = addBytes(bytes, nodes, sizeof(uint32_t));
    bytes = addBytes(bytes, n, sizeof(uint8_t));
    bytes = addBytes(bytes, n, sizeof(Override));
    return {n, nodes, bytes};
}
Job::Job(std::span<const Gaussian> gaussians, std::span<const uint8_t> baseline, bool grow, Scratch scratch, float sigma, Method method)
    : gaussians_(gaussians), baseline_(baseline), scratch_(scratch), sigma_(sigma), grow_(grow),volume_(method==Method::Volume) {
    if (gaussians.size() != baseline.size()) throw std::invalid_argument("Selection does not match the Gaussian scene.");
    if(method!=Method::Sigma&&method!=Method::Volume) throw std::invalid_argument("Invalid morphology method.");
    if (!std::isfinite(sigma) || (volume_ ? sigma<=0 : sigma < minimumSigma || sigma > maximumSigma))
        throw std::invalid_argument("Invalid selection reach.");
    const auto required = scratchRequirements(gaussians.size());
    if (scratch.boxes.size() < required.gaussians || scratch.order.size() < required.gaussians ||
        scratch.matched.size() < required.gaussians || scratch.result.size() < required.gaussians ||
        scratch.nodes.size() < required.nodes || scratch.remaining.size() < required.nodes)
        throw std::invalid_argument("Morphology scratch is incomplete.");
}
std::span<const Override> Job::result() const noexcept {
    return complete() ? std::span<const Override>(scratch_.result.data(), resultCount_) : std::span<const Override>{};
}
void Job::retire(Phase phase) noexcept {
    phase_ = phase; resultCount_ = 0; buildDepth_ = queryDepth_ = 0;
    gaussians_ = {}; baseline_ = {}; scratch_ = {};
}
void Job::cancel() noexcept { retire(Phase::Cancelled); }
size_t Job::step(size_t maxWork) {
    size_t used = 0;
    try {
        while (used < maxWork && phase_ != Phase::Complete && phase_ != Phase::Cancelled && phase_ != Phase::Failed) {
            tick(); ++used; ++workDone_;
        }
    } catch (...) { retire(Phase::Failed); throw; }
    return used;
}
void Job::pushBuild(uint32_t begin, uint32_t end, uint32_t parent, bool right) {
    if (nodeCount_ == scratch_.nodes.size() || buildDepth_ == build_.size()) throw std::logic_error("Morphology BVH capacity exceeded.");
    const auto node = uint32_t(nodeCount_++);
    if (parent != leaf) (right ? scratch_.nodes[parent].right : scratch_.nodes[parent].left) = node;
    auto &frame = build_[buildDepth_++];
    frame.begin = begin; frame.end = end; frame.node = node; frame.cursor = begin;
    frame.stage = 0;
    scratch_.nodes[node] = {{}, begin, end, leaf, leaf};
}
void Job::buildTick() {
    auto &f = build_[buildDepth_ - 1];
    if (f.stage == 0) {
        if (f.cursor == f.begin) f.box = scratch_.boxes[scratch_.order[f.cursor]];
        else f.box.include(scratch_.boxes[scratch_.order[f.cursor]]);
        if (++f.cursor == f.end) {
            scratch_.nodes[f.node].box = f.box;
            if (f.end - f.begin <= 16) { --buildDepth_; return; }
            f.axis = 0;
            for (uint8_t i = 1; i < 3; ++i)
                if (double(f.box.high[i]) - f.box.low[i] > double(f.box.high[f.axis]) - f.box.low[f.axis]) f.axis = i;
            f.middle = f.begin + (f.end - f.begin) / 2; f.low = f.begin; f.high = f.end;
            f.partitionWork = 0; f.stage = 1;
        }
    } else if (f.stage == 1) {
        // A fixed scrambled sample avoids the severe periodic-grid bias of
        // first/middle/last. A work-count fallback below bounds pathological
        // inputs instead of relying on expected quickselect complexity.
        if (f.partitionWork > 8 * uint64_t(f.end - f.begin)) { f.radixBit = 31; f.stage = 6; return; }
        const auto sample = f.low + uint32_t(uint64_t(f.high - f.low) * scramble(f.low ^ f.high) >> 32);
        f.pivot = median(gaussians_[scratch_.order[f.low]].positionOpacity[f.axis],
                         gaussians_[scratch_.order[sample]].positionOpacity[f.axis],
                         gaussians_[scratch_.order[f.high - 1]].positionOpacity[f.axis]);
        f.lt = f.next = f.low; f.gt = f.high; f.stage = 2;
    } else if (f.stage == 2) {
        if (f.next != f.gt) {
            ++f.partitionWork;
            const auto value = gaussians_[scratch_.order[f.next]].positionOpacity[f.axis];
            if (value < f.pivot) std::swap(scratch_.order[f.lt++], scratch_.order[f.next++]);
            else if (value > f.pivot) std::swap(scratch_.order[f.next], scratch_.order[--f.gt]);
            else ++f.next;
        } else if (f.middle < f.lt) { f.high = f.lt; f.stage = 1; }
        else if (f.middle >= f.gt) { f.low = f.gt; f.stage = 1; }
        else f.stage = 3;
    } else if (f.stage == 3) {
        f.stage = 4; pushBuild(f.begin, f.middle, f.node, false);
    } else if (f.stage == 4) {
        f.stage = 5; pushBuild(f.middle, f.end, f.node, true);
    } else if (f.stage == 5) --buildDepth_;
    else if (f.stage == 6) { f.next = f.low; f.gt = f.high; f.stage = 7; }
    else if (f.next != f.gt) {
        if (orderedKey(gaussians_[scratch_.order[f.next]].positionOpacity[f.axis]) & (uint32_t(1) << f.radixBit))
            std::swap(scratch_.order[f.next], scratch_.order[--f.gt]);
        else ++f.next;
    } else {
        // Earlier bits are equal within the retained rank interval. Once its
        // last differing bit is partitioned, any equal-key order is valid.
        if (f.middle == f.next || f.radixBit == 0) f.stage = 3;
        else {
            if (f.middle < f.next) f.high = f.next;
            else f.low = f.next;
            --f.radixBit; f.stage = 6;
        }
    }
}
void Job::pushQuery(uint32_t node) {
    if (queryDepth_ == queryStack_.size()) throw std::logic_error("Morphology query capacity exceeded.");
    queryStack_[queryDepth_++] = {node, 0, 0, false}; hitReturned_ = false;
}
void Job::returnHit(bool value) noexcept { --queryDepth_; hitReturned_ = true; hitValue_ = value; }
void Job::queryTick() {
    if (!queryDepth_) {
        if (hitReturned_) {
            if (hitValue_ && changesOnQuery_) scratch_.result[resultCount_++] = {query_, uint8_t(grow_)};
            hitReturned_ = false; ++cursor_; return;
        }
        if (cursor_ == gaussians_.size() || !scratch_.remaining[0]) {
            cursor_ = 0; phase_ = changesOnQuery_ ? Phase::Complete : Phase::Publish; return;
        }
        const auto state = baseline_[cursor_];
        if (!(state & 2) && bool(state & 1) == querySelected_) { query_ = uint32_t(cursor_); pushQuery(0); }
        else ++cursor_;
        return;
    }
    auto &f = queryStack_[queryDepth_ - 1];
    const auto &node = scratch_.nodes[f.node];
    if (f.stage == 0) {
        if (!scratch_.remaining[f.node] || !(volume_ ? within(node.box,gaussians_[query_],double(sigma_)*sigma_) :
            node.box.touches(scratch_.boxes[query_]))) returnHit(false);
        else if (node.left == leaf) { f.stage = 1; f.cursor = node.begin; }
        else { f.stage = 2; pushQuery(node.left); }
    } else if (f.stage == 1) {
        if (f.cursor == node.end || !scratch_.remaining[f.node]) { returnHit(f.found); return; }
        const auto neighbor = scratch_.order[f.cursor++];
        const auto state = baseline_[neighbor];
        if (!(state & 2) && bool(state & 1) != querySelected_ &&
            (changesOnQuery_ || !scratch_.matched[neighbor]) &&
            (volume_ ? within(gaussians_[query_],gaussians_[neighbor],double(sigma_)*sigma_) :
                scratch_.boxes[query_].touches(scratch_.boxes[neighbor]) &&
                touches(gaussians_[query_], gaussians_[neighbor], sigma_))) {
            if (changesOnQuery_) returnHit(true);
            else { scratch_.matched[neighbor] = 1; f.found = true; --scratch_.remaining[f.node]; }
        }
    } else if (f.stage == 2) {
        f.found = hitValue_;
        if (f.found && changesOnQuery_) returnHit(true);
        else { f.stage = 3; pushQuery(node.right); }
    } else {
        scratch_.remaining[f.node] = scratch_.remaining[node.left] + scratch_.remaining[node.right];
        returnHit(f.found || hitValue_);
    }
}
void Job::tick() {
    if (phase_ == Phase::Count) {
        if (cursor_ != baseline_.size()) {
            const auto state = baseline_[cursor_++];
            if (!(state & 2)) (state & 1 ? selected_ : unselected_)++;
        } else if (!selected_ || !unselected_) phase_ = Phase::Complete;
        else {
            querySelected_ = selected_ <= unselected_; changesOnQuery_ = querySelected_ != grow_;
            cursor_ = 0; phase_ = Phase::Bounds;
        }
    } else if (phase_ == Phase::Bounds) {
        if (cursor_ != gaussians_.size()) {
            scratch_.boxes[cursor_] = volume_ ? centerBounds(gaussians_[cursor_]) : bounds(gaussians_[cursor_], sigma_);
            scratch_.order[cursor_] = uint32_t(cursor_); scratch_.matched[cursor_] = 0; ++cursor_;
        } else { phase_ = Phase::Build; pushBuild(0, uint32_t(gaussians_.size()), leaf, false); }
    } else if (phase_ == Phase::Build) {
        if (buildDepth_) buildTick();
        else { phase_ = Phase::Remaining; remainingCursor_ = uint32_t(nodeCount_); leafCursor_ = leaf; }
    } else if (phase_ == Phase::Remaining) {
        if (!remainingCursor_) { phase_ = Phase::Query; cursor_ = 0; return; }
        const auto index = remainingCursor_ - 1;
        const auto &node = scratch_.nodes[index];
        if (node.left != leaf) {
            scratch_.remaining[index] = scratch_.remaining[node.left] + scratch_.remaining[node.right]; --remainingCursor_;
        } else if (leafCursor_ == leaf) { leafCursor_ = node.begin; leafRemaining_ = 0; }
        else if (leafCursor_ != node.end) {
            const auto state = baseline_[scratch_.order[leafCursor_++]];
            leafRemaining_ += !(state & 2) && bool(state & 1) != querySelected_;
        } else { scratch_.remaining[index] = leafRemaining_; leafCursor_ = leaf; --remainingCursor_; }
    } else if (phase_ == Phase::Query) queryTick();
    else if (phase_ == Phase::Publish) {
        if (cursor_ == gaussians_.size()) phase_ = Phase::Complete;
        else { if (scratch_.matched[cursor_]) scratch_.result[resultCount_++] = {uint32_t(cursor_), uint8_t(grow_)}; ++cursor_; }
    }
}
} // namespace preview::browser_morphology
