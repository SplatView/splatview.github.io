#include "browser_spz_export.hpp"
#include "admitted_storage.hpp"
#include "editing.hpp"
#include "resource_budget.hpp"
#include <load-spz.h>
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <exception>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>

namespace preview::browser_spz_export {
namespace {
constexpr unsigned level = 3;
constexpr std::size_t codecEnvelopeAllowance = 64 * 1024;
constexpr std::size_t codecQuantum = 65536;

std::array<std::size_t, 6> rawSizes(std::size_t count, unsigned degree) {
    return {checkedByteProduct(count, 9), count, checkedByteProduct(count, 3),
            checkedByteProduct(count, 3), checkedByteProduct(count, 4),
            checkedByteProduct(count, 3 * ((degree + 1) * (degree + 1) - 1))};
}
ZSTD_compressionParameters parameters(std::size_t count, unsigned degree) {
    const auto sizes = rawSizes(count, degree);
    return ZSTD_getCParams(level, *std::max_element(sizes.begin(), sizes.end()), 0);
}
void codecCheck(std::size_t result) {
    if (ZSTD_isError(result))
        throw std::runtime_error(std::string("SPZ v4 compression failed: ") + ZSTD_getErrorName(result));
}
std::uint8_t byte(float value) {
    if (std::isnan(value)) throw std::runtime_error("Invalid SPZ attribute");
    return std::uint8_t(std::clamp(std::round(value), 0.f, 255.f));
}
std::uint32_t packedRotation(const ExportAxes &axes, const spz::CoordinateConverter &converter) {
    const auto &r = axes.quaternion;
    const float q[]{r[1] * converter.flipQ[0], r[2] * converter.flipQ[1], r[3] * converter.flipQ[2], r[0]};
    unsigned largest{};
    for (unsigned i = 1; i < 4; ++i)
        if (std::abs(q[i]) > std::abs(q[largest])) largest = i;
    std::uint32_t result = largest;
    for (unsigned i = 0; i < 4; ++i) {
        if (i == largest) continue;
        const std::uint32_t sign = (q[i] < 0) ^ (q[largest] < 0);
        const auto magnitude = std::uint32_t(511.f * (std::abs(q[i]) / 0.7071067811865475f) + .5f);
        result = (result << 10) | (sign << 9) | std::min(magnitude, 511u);
    }
    return result;
}

// Zstd's allocator cannot propagate C++ exceptions through its C call stack.
// Every block uses the admitted allocator (and its existing census overlay),
// with a small in-band header for exact release. No allocation-index map exists.
class CodecMemory final {
    struct Header { std::size_t units; };
    static constexpr std::size_t headerUnits = (sizeof(Header) + sizeof(std::max_align_t) - 1) / sizeof(std::max_align_t);
  public:
    CodecMemory(std::shared_ptr<SceneMemory> memory, std::size_t limit)
        : allocator_(std::move(memory)), limit_(limit) {}
    ZSTD_customMem callbacks() noexcept { return {&allocate, &release, this}; }
    std::size_t retainedBytes() const noexcept { return live_; }
    void rethrowFailure() const { if (failure_) std::rethrow_exception(failure_); }
    void clearFailure() noexcept { failure_ = {}; }
  private:
    static void *allocate(void *opaque, std::size_t bytes) noexcept {
        auto &self = *static_cast<CodecMemory *>(opaque);
        if (self.failure_) return nullptr;
        try {
            const auto rounded = checkedByteSum({bytes, sizeof(std::max_align_t) - 1}) / sizeof(std::max_align_t);
            const auto units = checkedByteSum({headerUnits, rounded});
            const auto payload = checkedByteProduct(units, sizeof(std::max_align_t));
            if (payload > self.limit_ - self.live_)
                throw std::runtime_error("SPZ v4 codec exceeds its admitted workspace bound");
            auto *block = self.allocator_.allocate(units);
            ::new (static_cast<void *>(block)) Header{units};
            self.live_ += payload;
            return block + headerUnits;
        } catch (...) {
            self.failure_ = std::current_exception();
            return nullptr;
        }
    }
    static void release(void *opaque, void *address) noexcept {
        if (!address) return;
        auto &self = *static_cast<CodecMemory *>(opaque);
        auto *block = static_cast<std::max_align_t *>(address) - headerUnits;
        const auto units = reinterpret_cast<const Header *>(block)->units;
        const auto payload = units * sizeof(std::max_align_t);
        self.allocator_.deallocate(block, units);
        self.live_ -= payload;
    }
    AdmittedAllocator<std::max_align_t> allocator_;
    std::size_t limit_{}, live_{};
    std::exception_ptr failure_;
};
} // namespace

OutputOwner::OutputOwner(std::shared_ptr<SceneMemory> memory, std::size_t capacity)
    : memory_(std::move(memory)), capacity_(capacity) {
    // allocate() starts trivial byte storage without a scene-sized resize,
    // value-initialization, memset or copy. Only written bytes become output.
    data_ = AdmittedAllocator<std::uint8_t>{memory_}.allocate(capacity_);
    ::new (static_cast<void *>(data_)) std::uint8_t[capacity_];
}
OutputOwner::~OutputOwner() noexcept {
    if (data_) AdmittedAllocator<std::uint8_t>{memory_}.deallocate(data_, capacity_);
}
OutputOwner::Pointer OutputOwner::create(std::shared_ptr<SceneMemory> memory, std::size_t capacity) {
    AdmittedAllocator<OutputOwner> allocator(memory);
    auto *owner = allocator.allocate(1);
    try { ::new (static_cast<void *>(owner)) OutputOwner(memory, capacity); }
    catch (...) { allocator.deallocate(owner, 1); throw; }
    return Pointer{owner, Deleter{std::move(memory)}};
}
void OutputOwner::Deleter::operator()(OutputOwner *owner) noexcept {
    if (!owner) return;
    std::destroy_at(owner);
    AdmittedAllocator<OutputOwner>{memory}.deallocate(owner, 1);
}
void OutputOwner::retire(Pointer &owner) noexcept {
    owner.reset(); owner.get_deleter().memory.reset();
}
std::size_t OutputOwner::retainedBytes() const noexcept { return sizeof(OutputOwner) + capacity_; }

struct Job::State final {
    State(std::shared_ptr<const Scene> scene, MaskStorage mask, unsigned scope,
          std::shared_ptr<SceneMemory> memory, const Plan &bounds)
        : scene(std::move(scene)), mask(std::move(mask)), memory(std::move(memory)), bounds(bounds),
          scope(scope), degree(this->scene->shDegree), streamCount(degree ? 6u : 5u),
          converter(spz::coordinateConverter(spz::CoordinateSystem::RDF, spz::CoordinateSystem::RUB, degree)),
          codec(this->memory, bounds.codecBytes) {}
    ~State() noexcept { releaseScratch(); OutputOwner::retire(output); }
    bool eligible(std::size_t index) const noexcept {
        const auto state = mask[index];
        return !(state & 2) && (scope == 0 || ((scope == 1) == bool(state & 1)));
    }
    void releaseScratch() noexcept {
        if (context) { ZSTD_freeCCtx(context); context = nullptr; }
        if (input) { AdmittedAllocator<std::uint8_t>{memory}.deallocate(input, bounds.inputBytes); input = nullptr; }
        inputUsed = inputConsumed = 0;
        codec.clearFailure();
    }
    void check(std::size_t result) const { codec.rethrowFailure(); codecCheck(result); }
    void allocate() {
        output = OutputOwner::create(memory, bounds.outputCapacity);
        input = AdmittedAllocator<std::uint8_t>{memory}.allocate(bounds.inputBytes);
        ::new (static_cast<void *>(input)) std::uint8_t[bounds.inputBytes];
        context = ZSTD_createCCtx_advanced(codec.callbacks());
        codec.rethrowFailure();
        if (!context) throw std::runtime_error("Cannot create the SPZ v4 encoder");
        check(ZSTD_CCtx_setParameter(context, ZSTD_c_compressionLevel, level));
        // Fix the level-3 parameters for the largest admitted source stream.
        // Smaller scoped streams cannot grow the planned codec workspace.
        check(ZSTD_CCtx_setCParams(context, parameters(scene->gaussians.size(), degree)));
        check(ZSTD_CCtx_setParameter(context, ZSTD_c_checksumFlag, 1));
        check(ZSTD_CCtx_setParameter(context, ZSTD_c_contentSizeFlag, 1));
        phase = Phase::Header;
    }
    std::uint8_t headerByte(std::size_t position) const noexcept {
        if (position < 4) return std::uint8_t(std::uint32_t(spz::NGSP_MAGIC) >> (8 * position));
        if (position < 8) return position == 4 ? 4 : 0;
        if (position < 12) return std::uint8_t(std::uint32_t(visible) >> (8 * (position - 8)));
        if (position == 12) return std::uint8_t(degree);
        if (position == 13) return 12;
        if (position == 14) return 0;
        if (position == 15) return std::uint8_t(streamCount);
        if (position < 20) return position == 16 ? 32 : 0;
        if (position < 32) return 0;
        const auto field = (position - 32) / 16, offset = (position - 32) % 16;
        return offset < 8 ? 0 : std::uint8_t(std::uint64_t(raw[field]) >> (8 * (offset - 8)));
    }
    void beginStream() {
        check(ZSTD_CCtx_reset(context, ZSTD_reset_session_only));
        check(ZSTD_CCtx_setPledgedSrcSize(context, raw[stream]));
        source = component = 0; recordActive = axesReady = false;
        pendingSize = pendingCursor = 0; inputUsed = inputConsumed = 0;
        finalInput = false; streamPacked = streamCompressed = 0;
        phase = Phase::Pack;
    }
    unsigned components() const noexcept {
        if (stream == 0 || stream == 2 || stream == 3) return 3;
        if (stream == 5) return 3 * ((degree + 1) * (degree + 1) - 1);
        return 1;
    }
    void endUnit() noexcept {
        pendingSize = pendingCursor = 0;
        if (++component == components()) { recordActive = false; ++source; }
    }
    void emit(std::uint8_t value) {
        input[inputUsed++] = value;
        ++streamPacked; ++progress.packedBytes;
        if (inputUsed == bounds.inputBytes) {
            inputConsumed = 0; finalInput = false; phase = Phase::Compress;
        }
    }
    void integer(std::uint32_t value, unsigned bytes) {
        pendingSize = bytes; pendingCursor = 1;
        for (unsigned i = 0; i < bytes; ++i) pending[i] = std::uint8_t(value >> (8 * i));
        emit(pending[0]);
    }
    void pack() {
        if (!recordActive) {
            if (source == scene->gaussians.size()) {
                if (streamPacked != raw[stream]) throw std::runtime_error("SPZ v4 attribute size does not match the visible point count");
                finalInput = true; inputConsumed = 0; phase = Phase::Compress; return;
            }
            ++progress.sourcesScanned;
            if (!eligible(source)) { ++source; return; }
            recordActive = true; axesReady = false; component = 0; return;
        }
        if (pendingCursor < pendingSize) {
            emit(pending[pendingCursor++]);
            if (pendingCursor == pendingSize) endUnit();
            return;
        }
        const auto &g = scene->gaussians[source];
        if ((stream == 3 || stream == 4) && !axesReady) {
            axes = exportAxesRdf(g); axesReady = true; return;
        }
        if (stream == 0) {
            const double value = std::round(double(g.positionOpacity[component]) * 4096);
            if (!std::isfinite(value) || value < -8388608 || value > 8388607)
                throw std::runtime_error("SPZ positions exceed its 24-bit range. Save as PLY instead.");
            integer(std::uint32_t(std::int32_t(value)), 3); return;
        }
        if (stream == 4) { integer(packedRotation(axes, converter), 4); return; }
        std::uint8_t value;
        if (stream == 1) value = byte(g.positionOpacity[3] * 255);
        else if (stream == 2) value = byte(shValue(g, 0, component) * (0.15f * 255) + 127.5f);
        else if (stream == 3) value = byte((axes.logScales[component] + 10) * 16);
        else {
            // The native scene already retains canonical RUB higher SH.
            const unsigned coefficient = component / 3 + 1, channel = component % 3;
            const int bucket = coefficient < 4 ? 8 : 16;
            const float rounded = std::round(shValue(g, coefficient, channel) * 128) + 128;
            if (!std::isfinite(rounded) || rounded < float(std::numeric_limits<int>::min()) ||
                double(rounded) > std::numeric_limits<int>::max()) throw std::runtime_error("Invalid SPZ SH coefficient");
            int quantized = int(rounded);
            quantized = (quantized + bucket / 2) / bucket * bucket;
            value = std::uint8_t(std::clamp(quantized, 0, 255));
        }
        emit(value); endUnit();
    }
    void compress(std::size_t quota) {
        const auto offered = std::min(inputUsed - inputConsumed, quota);
        const auto available = std::min(bounds.outputCapacity - written, quota);
        if (!available) throw std::runtime_error("SPZ v4 exceeds its admitted output bound");
        const bool end = finalInput && offered == inputUsed - inputConsumed;
        ZSTD_inBuffer sourceBytes{input + inputConsumed, offered, 0};
        ZSTD_outBuffer outputBytes{output->data_ + written, available, 0};
        const auto remaining = ZSTD_compressStream2(context, &outputBytes, &sourceBytes, end ? ZSTD_e_end : ZSTD_e_continue);
        check(remaining);
        if (sourceBytes.pos > offered || outputBytes.pos > available) throw std::runtime_error("Invalid SPZ v4 codec range");
        inputConsumed += sourceBytes.pos; written += outputBytes.pos;
        streamCompressed += outputBytes.pos; progress.compressedBytes += outputBytes.pos;
        progress.lastStepCodecInputBytes = sourceBytes.pos; progress.lastStepCodecOutputBytes = outputBytes.pos;
        if (inputConsumed == inputUsed) {
            if (finalInput) {
                if (end && remaining == 0) {
                    compressed[stream++] = streamCompressed;
                    phase = stream < streamCount ? Phase::BeginStream : Phase::Toc;
                } else { inputUsed = inputConsumed = 0; }
            } else { inputUsed = inputConsumed = 0; phase = Phase::Pack; }
        }
    }
    void advance() {
        if (phase == Phase::Count) {
            if (source < scene->gaussians.size()) {
                ++progress.sourcesScanned;
                visible += eligible(source++); return;
            }
            if (!visible) throw std::runtime_error("There are no visible Gaussians to save. Undo or restore first.");
            raw = rawSizes(visible, degree); phase = Phase::Allocate;
        } else if (phase == Phase::Allocate) allocate();
        else if (phase == Phase::Header) {
            output->data_[written] = headerByte(written); ++written;
            if (written == 32 + streamCount * 16) phase = Phase::BeginStream;
        } else if (phase == Phase::BeginStream) beginStream();
        else if (phase == Phase::Pack) pack();
        else if (phase == Phase::Toc) {
            const auto field = tocCursor / 16, offset = tocCursor % 16;
            const auto value = offset < 8 ? compressed[field] : raw[field];
            output->data_[32 + tocCursor] = std::uint8_t(value >> (8 * (offset % 8)));
            if (++tocCursor == streamCount * 16) {
                releaseScratch(); phase = Phase::Ready; status = Status::Ready;
            }
        }
    }
    std::shared_ptr<const Scene> scene;
    MaskStorage mask;
    std::shared_ptr<SceneMemory> memory;
    Plan bounds;
    unsigned scope{}, degree{}, streamCount{}, stream{}, component{};
    spz::CoordinateConverter converter;
    CodecMemory codec;
    ZSTD_CCtx *context{};
    std::uint8_t *input{};
    OutputOwner::Pointer output;
    Progress progress;
    Status status{Status::Working};
    Phase phase{Phase::Count};
    std::array<std::size_t, 6> raw{};
    std::array<std::uint64_t, 6> compressed{};
    std::array<std::uint8_t, 4> pending{};
    ExportAxes axes{};
    std::size_t source{}, visible{}, written{}, tocCursor{}, inputUsed{}, inputConsumed{};
    std::uint64_t streamPacked{}, streamCompressed{};
    unsigned pendingSize{}, pendingCursor{};
    bool recordActive{}, axesReady{}, finalInput{};
};

Plan plan(std::size_t loadedCount, unsigned degree) {
    if (!loadedCount || loadedCount > Job::maximumSources || degree > 3)
        throw std::invalid_argument("SPZ v4 supports one million loaded splats and SH0-3");
    const auto sizes = rawSizes(loadedCount, degree);
    const unsigned streams = degree ? 6u : 5u;
    Plan result;
    result.outputCapacity = 32 + streams * 16;
    for (unsigned i = 0; i < streams; ++i) {
        const auto bytes = ZSTD_compressBound(sizes[i]); codecCheck(bytes);
        result.outputCapacity = checkedByteSum({result.outputCapacity, bytes});
    }
    if (result.outputCapacity > std::numeric_limits<unsigned>::max())
        throw std::invalid_argument("SPZ v4 exceeds the output byte range");
    result.inputBytes = std::min(Job::maximumInputBytes, *std::max_element(sizes.begin(), sizes.end()));
    const auto estimate = ZSTD_estimateCStreamSize_usingCParams(parameters(loadedCount, degree)); codecCheck(estimate);
    // A live workspace replacement can temporarily overlap its predecessor.
    // The doubled estimate plus fixed allocator-header allowance is an explicit
    // hard callback cap, not permission for an unobserved Zstd fallback.
    result.codecBytes = checkedByteSum({checkedByteProduct(estimate, 2), codecEnvelopeAllowance});
    result.ownerBytes = checkedByteSum({sizeof(Job), sizeof(Job::State), sizeof(OutputOwner)});
    result.workBytes = checkedByteSum({result.outputCapacity, result.inputBytes, result.codecBytes, result.ownerBytes});
    return result;
}

Job::Job(std::shared_ptr<const Scene> scene, MaskStorage mask, unsigned scope,
         std::shared_ptr<SceneMemory> memory, const Plan &bounds) : memory_(std::move(memory)) {
    AdmittedAllocator<State> allocator(memory_);
    state_ = allocator.allocate(1);
    try { ::new (static_cast<void *>(state_)) State(std::move(scene), std::move(mask), scope, memory_, bounds); }
    catch (...) { allocator.deallocate(state_, 1); state_ = nullptr; throw; }
}
Job::~Job() noexcept {
    if (state_) { std::destroy_at(state_); AdmittedAllocator<State>{memory_}.deallocate(state_, 1); }
}
Job::Pointer Job::create(std::shared_ptr<const Scene> scene, MaskStorage mask, unsigned scope,
                        std::shared_ptr<SceneMemory> memory) {
    if (!scene) throw std::invalid_argument("Invalid SPZ v4 scene");
    const auto bounds = plan(scene->gaussians.size(), scene->shDegree);
    return create(std::move(scene), std::move(mask), scope, std::move(memory), bounds);
}
Job::Pointer Job::create(std::shared_ptr<const Scene> scene, MaskStorage mask, unsigned scope,
                        std::shared_ptr<SceneMemory> memory, const Plan &bounds) {
    if (!scene || !scene->isGaussian() || mask.size() != scene->gaussians.size() || scope > 2 || !memory)
        throw std::invalid_argument("Invalid SPZ v4 export snapshot");
    if (bounds != plan(scene->gaussians.size(), scene->shDegree))
        throw std::invalid_argument("Invalid SPZ v4 export admission plan");
    AdmittedAllocator<Job> allocator(memory);
    auto *owner = allocator.allocate(1);
    try { ::new (static_cast<void *>(owner)) Job(std::move(scene), std::move(mask), scope, memory, bounds); }
    catch (...) { allocator.deallocate(owner, 1); throw; }
    return Pointer{owner, Deleter{std::move(memory)}};
}
void Job::Deleter::operator()(Job *owner) noexcept {
    if (!owner) return;
    std::destroy_at(owner); AdmittedAllocator<Job>{memory}.deallocate(owner, 1);
}
void Job::retire(Pointer &owner) noexcept { owner.reset(); owner.get_deleter().memory.reset(); }
Status Job::step(std::size_t maxWork) {
    auto &state = *state_;
    state.progress.lastStepWork = state.progress.lastStepCodecInputBytes = state.progress.lastStepCodecOutputBytes = 0;
    if (state.status != Status::Working) return state.status;
    const auto limit = std::clamp(maxWork, std::size_t(1), codecQuantum);
    while (state.progress.lastStepWork < limit && state.status == Status::Working) {
        const auto remaining = limit - state.progress.lastStepWork;
        ++state.progress.lastStepWork; ++state.progress.actions;
        if (state.phase == Phase::Compress) { state.compress(remaining); break; }
        state.advance();
    }
    return state.status;
}
void Job::cancel() noexcept {
    state_->releaseScratch(); OutputOwner::retire(state_->output);
    state_->phase = Phase::Cancelled; state_->status = Status::Cancelled;
}
Status Job::status() const noexcept { return state_->status; }
Phase Job::phase() const noexcept { return state_->phase; }
const Progress &Job::progress() const noexcept { return state_->progress; }
const Plan &Job::bounds() const noexcept { return state_->bounds; }
std::size_t Job::visibleCount() const noexcept { return state_->visible; }
const std::shared_ptr<const Scene> &Job::sceneOwner() const noexcept { return state_->scene; }
const MaskStorage &Job::maskOwner() const noexcept { return state_->mask; }
unsigned Job::scope() const noexcept { return state_->scope; }
std::size_t Job::retainedBytes() const noexcept {
    return sizeof(Job) + sizeof(State) + (state_->input ? state_->bounds.inputBytes : 0) +
        state_->codec.retainedBytes() + (state_->output ? state_->output->retainedBytes() : 0);
}
double Job::fraction() const noexcept {
    if (state_->status == Status::Ready) return 1;
    if (state_->phase == Phase::Count) return .1 * double(state_->source) / state_->scene->gaussians.size();
    const auto bytes = std::uint64_t(state_->visible) * (20 + 3 * ((state_->degree + 1) * (state_->degree + 1) - 1));
    return std::min(.99, .1 + .89 * double(state_->progress.packedBytes) / std::max(std::uint64_t(1), bytes));
}
OutputOwner::Pointer Job::takeOutput() {
    if (state_->status != Status::Ready || !state_->output)
        throw std::logic_error("SPZ v4 output is not complete");
    state_->output->size_ = state_->written;
    return std::move(state_->output);
}
} // namespace preview::browser_spz_export
