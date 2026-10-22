#include "browser_export_sink.hpp"
#include "browser_spz3_memory.hpp"
#include "browser_sog_export.hpp"
#include "resource_budget.hpp"
#include <algorithm>
#include <cstring>
#include <limits>
#include <optional>
#include <stdexcept>

namespace preview::browser_export {
namespace {
constexpr std::size_t maximumSources = 1'000'000;
constexpr std::size_t headerCapacity = 4096;
constexpr std::size_t maximumOutput = 0x7fffffff;
constexpr std::size_t maximumWork = 0xffffffff;
struct Context {
    OutputOwner &output;
    std::shared_ptr<SceneMemory> memory;
    bool streamOpened{}, streamClosed{};
};
thread_local Context *active{};
class ContextScope final {
  public:
    explicit ContextScope(Context &value) : previous_(active) {
        if (active) throw std::runtime_error("Nested direct export is unsupported");
        active = &value;
    }
    ~ContextScope() { active = previous_; }
  private:
    Context *previous_;
};
// Each real payload still owns the parent admission until it is destroyed.
// This additional cap enforces the declared operation bound, rather than
// trusting a conservative estimate after an allocation has happened.
class CappedMemory final : public SceneMemory {
    struct State { std::size_t live{}, limit{}; };
    struct Grant {
        std::shared_ptr<State> state;
        std::shared_ptr<void> parent;
        std::size_t bytes;
        Grant(std::shared_ptr<State> state, std::shared_ptr<void> parent, std::size_t bytes)
            : state(std::move(state)), parent(std::move(parent)), bytes(bytes) {}
        ~Grant() { parent.reset(); state->live -= bytes; }
    };
  public:
    CappedMemory(std::shared_ptr<SceneMemory> memory, std::size_t limit)
        : parent_(std::move(memory)), state_(std::make_shared<State>(State{0, limit})) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        if (bytes > state_->limit - state_->live)
            throw std::runtime_error("Attribute export exceeds its admitted workspace bound");
        state_->live += bytes;
        try {
            auto parent = parent_->admit(bytes);
            return std::make_shared<Grant>(state_, std::move(parent), bytes);
        } catch (...) { state_->live -= bytes; throw; }
    }
    std::size_t live() const noexcept { return state_->live; }
  private:
    std::shared_ptr<SceneMemory> parent_;
    std::shared_ptr<State> state_;
};
} // namespace

bool supported(unsigned format) noexcept {
    return format <= 7;
}
Plan plan(unsigned format, std::size_t count, unsigned degree) {
    if (!supported(format) || !count || count > maximumSources || degree > 3)
        throw std::invalid_argument("Unsupported bounded attribute export plan");
    const std::size_t rest = (degree + 1) * (degree + 1) - 1;
    Plan result;
    switch (format) {
    case 0: result.outputCapacity = checkedByteSum({headerCapacity, checkedByteProduct(count, 68 + 12 * rest)}); break;
    case 1: {
        const auto raw = checkedByteSum({16, checkedByteProduct(count, 20 + 3 * rest)});
        const auto full = raw / browser_spz3::blockBytes, tail = raw % browser_spz3::blockBytes;
        result.outputCapacity = checkedByteSum({18,
            checkedByteProduct(full, browser_spz3::compressedBound(browser_spz3::blockBytes)),
            browser_spz3::compressedBound(tail)});
        result.inputBytes = browser_spz3::blockBytes;
        result.compressedBytes = browser_spz3::compressedBound(browser_spz3::blockBytes);
        result.codecBytes = browser_spz3::codecBytes;
        break;
    }
    case 2: result.outputCapacity = checkedByteProduct(count, 32); break;
    case 3:
        result.outputCapacity = checkedByteSum({headerCapacity, checkedByteProduct((count + 255) / 256, 72),
                                               checkedByteProduct(count, 16 + 3 * rest)});
        result.sortBytes = checkedByteProduct(count, sizeof(std::uint64_t)); break;
    case 4: result.outputCapacity = checkedByteSum({5132, checkedByteProduct(count, 44 + 12 * rest)}); break;
    case 5: result.outputCapacity = checkedByteSum({headerCapacity, checkedByteProduct(count, 2048)}); break;
    case 6: case 7: {
        const auto sog=browser_sog::bounds(count,degree);
        result.outputCapacity=sog.output;result.sortBytes=checkedByteProduct(count,8);
        result.paletteBytes=sog.palette;result.labelBytes=sog.labels;result.pixelBytes=sog.pixels;
        result.scratchBytes=sog.scratch;result.codecBytes=sog.codec;break;
    }
    default: throw std::invalid_argument("Unsupported bounded attribute export format");
    }
    result.maskBytes = count;
    result.ownerBytes = sizeof(OutputOwner);
    result.workBytes = checkedByteSum({result.outputCapacity, result.maskBytes, result.sortBytes, result.ownerBytes,
                                      result.inputBytes, result.compressedBytes, result.codecBytes,
                                      result.paletteBytes,result.labelBytes,result.pixelBytes,result.scratchBytes});
    if (result.outputCapacity > maximumOutput || result.workBytes > maximumWork)
        throw std::invalid_argument("Attribute export exceeds the native byte range");
    return result;
}

OutputOwner::OutputOwner(std::shared_ptr<SceneMemory> memory, std::size_t capacity)
    : memory_(std::move(memory)), capacity_(capacity) {
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
    std::destroy_at(owner); AdmittedAllocator<OutputOwner>{memory}.deallocate(owner, 1);
}
void OutputOwner::retire(Pointer &owner) noexcept { owner.reset(); owner.get_deleter().memory.reset(); }
std::size_t OutputOwner::retainedBytes() const noexcept { return sizeof(OutputOwner) + capacity_; }

std::shared_ptr<SceneMemory> scratchMemory() noexcept { return active ? active->memory : nullptr; }
bool directActive() noexcept { return active != nullptr; }
std::streamsize SinkBuffer::xsputn(const char *data, std::streamsize length) {
    if (length < 0 || static_cast<std::uintmax_t>(length) > owner_.capacity_ - position_) return 0;
    const auto bytes = static_cast<std::size_t>(length);
    if (bytes && position_ > owner_.size_)
        std::memset(owner_.data_ + owner_.size_, 0, position_ - owner_.size_);
    if (bytes) std::memcpy(owner_.data_ + position_, data, bytes);
    position_ += bytes; owner_.size_ = std::max(owner_.size_, position_); return length;
}
SinkBuffer::int_type SinkBuffer::overflow(int_type value) {
    if (traits_type::eq_int_type(value, traits_type::eof())) return traits_type::not_eof(value);
    const char byte = traits_type::to_char_type(value);
    return xsputn(&byte, 1) == 1 ? value : traits_type::eof();
}
SinkBuffer::pos_type SinkBuffer::seekoff(off_type offset, std::ios_base::seekdir direction, std::ios_base::openmode mode) {
    if (!(mode & std::ios_base::out) || (mode & std::ios_base::in)) return pos_type(off_type(-1));
    const auto base = direction == std::ios_base::beg ? std::size_t{0} :
        direction == std::ios_base::cur ? position_ : direction == std::ios_base::end ? owner_.size_ : maximumWork;
    if (base > owner_.capacity_) return pos_type(off_type(-1));
    std::size_t target;
    if (offset >= 0) {
        if (static_cast<std::uintmax_t>(offset) > owner_.capacity_ - base) return pos_type(off_type(-1));
        target = base + static_cast<std::size_t>(offset);
    } else {
        const auto distance = static_cast<std::uintmax_t>(-(offset + 1)) + 1;
        if (distance > base) return pos_type(off_type(-1));
        target = base - static_cast<std::size_t>(distance);
    }
    position_ = target; return pos_type(static_cast<off_type>(target));
}
SinkBuffer::pos_type SinkBuffer::seekpos(pos_type position, std::ios_base::openmode mode) {
    return seekoff(static_cast<off_type>(position), std::ios_base::beg, mode);
}

OutputStream::OutputStream(const std::filesystem::path &path, std::ios_base::openmode mode) : std::ostream(nullptr) {
    if (active) {
        if (active->streamOpened) throw std::runtime_error("Attribute export opened overlapping output streams");
        sink_ = std::make_unique<SinkBuffer>(active->output); rdbuf(sink_.get());
        active->streamOpened = true;
    } else {
        file_ = std::make_unique<std::ofstream>(path, mode); rdbuf(file_->rdbuf());
        if (!*file_) setstate(std::ios_base::failbit);
    }
}
OutputStream::~OutputStream() { rdbuf(nullptr); }
void OutputStream::close() {
    if (closed_) { setstate(std::ios_base::failbit); return; }
    closed_ = true;
    if (file_) { file_->close(); if (!*file_) setstate(std::ios_base::failbit); }
    else {
        flush();
        if (!active) throw std::runtime_error("Attribute export stream lost its owner");
        active->streamClosed = true;
    }
}

OutputOwner::Pointer encode(const Scene &scene, std::span<const std::uint8_t> states, unsigned format,
                            unsigned scope, std::shared_ptr<SceneMemory> memory, const Plan &bounds) {
    if (!memory || !scene.isGaussian() || states.size() != scene.gaussians.size() || scope > 2 ||
        bounds != plan(format, scene.gaussians.size(), scene.shDegree))
        throw std::invalid_argument("Invalid bounded attribute export snapshot or plan");
    // This whole-operation preflight refuses before any output/mask/sort
    // payload. The unthreaded call cannot interleave another operation between
    // it and the lifetime-owning individual grants below.
    auto preflight = memory->admit(bounds.workBytes); preflight.reset();
    auto capped = std::make_shared<CappedMemory>(std::move(memory), bounds.workBytes);
    auto output = OutputOwner::create(capped, bounds.outputCapacity);
    Context context{*output, capped}; ContextScope scopeOwner(context);
    std::optional<browser_sog::Operation> sogOperation;
    if(format==6||format==7)sogOperation.emplace(bounds.codecBytes);
    {
        Vector<std::uint8_t> mask(states.begin(), states.end());
        for (auto &state : mask) if ((scope == 1 && !(state & 1)) || (scope == 2 && (state & 1))) state |= 2;
        writeVisibleScene(scene, mask, "/splatview-direct.bin", static_cast<SceneExportFormat>(format));
    }
    if (!context.streamOpened || !context.streamClosed || !output->size() || output->size() > bounds.outputCapacity ||
        capped->live() != output->retainedBytes())
        throw std::runtime_error("Attribute export did not retire its complete workspace");
    return output;
}
} // namespace preview::browser_export
