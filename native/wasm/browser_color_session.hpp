#pragma once
#include "color.hpp"
#include "mask_storage.hpp"
#include "scene.hpp"
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>

namespace preview::browser_checkpoint { struct Access; }

namespace preview::browser_color_metadata {
// IDs cross the JSON/JavaScript boundary as exact positive integers.
inline constexpr uint64_t maximumIdentity = 9007199254740991ULL;
// Owner-thread metadata only. This is neither a SceneEdits implementation nor a
// GPU owner. The host supplies acknowledged immutable document owners/revisions.
struct Context {
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    uint64_t documentId{}, sourceGeneration{}, revision{}, contentRevision{};
    bool settled{};
};
class IdSequence {
    friend struct preview::browser_checkpoint::Access;
  public:
    explicit IdSequence(uint64_t first = 1) noexcept : next_(first) {}
    std::optional<uint64_t> take() noexcept;
    uint64_t next() const noexcept { return next_; }
  private:
    uint64_t next_{}; // Kept outside every transactional snapshot; never rewound.
};
enum class Kind : uint8_t { Manual, Auto };
enum class Method : uint8_t { Enhance, Exposure, Contrast, WhiteBalance };
struct Key {
    uint64_t documentId{}, sourceGeneration{}, revision{}, contentRevision{};
    uint64_t sessionId{}, baseId{}, baseContentRevision{}, epochId{}, requestId{}, valuesId{};
    bool selectedOnly{};
    bool operator==(const Key &) const noexcept = default;
};
struct Request {
    std::shared_ptr<const Scene> base;
    std::shared_ptr<const Scene> expectedCurrentScene;
    MaskStorage states;
    ColorValues capturedValues{neutralColor};
    Key key;
    Kind kind{Kind::Manual};
    Method method{Method::Enhance};
    MaskStorage effectiveStates;
    const MaskStorage &targetStates() const noexcept { return effectiveStates.hasStorage()?effectiveStates:states; }
};
enum class Failure : uint8_t { None, InvalidContext, InvalidValues, ScopeBoundaryRequired,
    StaleContext, Busy, InvalidMethod, IdentityExhausted, InvalidPublication, NoTransaction };
enum class CaptureDisposition : uint8_t { Captured, ManualNoop, Refused };
struct Capture {
    CaptureDisposition disposition{CaptureDisposition::Refused};
    std::optional<Request> request;
    Failure failure{Failure::None};
};
enum class EndDisposition : uint8_t { Ended, AlreadyEnded, NeedsBake, WaitForJob,
    PreserveNewerPointerPreview, Refused };
enum class ScenePolicy : uint8_t { RetainBase, NewWritableScene };
struct BakePlan {
    ColorValues values{neutralColor};
    ScenePolicy scenePolicy{ScenePolicy::RetainBase};
    bool sceneReplacementRequired{};
    bool preserveRedoIfSameOwners{};
};

class BrowserColorSession final {
    friend struct preview::browser_checkpoint::Access;
    struct State {
        std::shared_ptr<const Scene> base;
        Context acknowledged;
        ColorValues values{neutralColor}, applied{neutralColor};
        uint64_t sessionId{}, baseId{}, baseContentRevision{}, epochId{}, valuesId{};
        bool selectedOnly{};
        MaskStorage effectiveStates;
    };
  public:
    bool begin(const Context &,bool selectedOnly,MaskStorage effectiveStates,IdSequence &) noexcept;
    class Snapshot {
        friend class BrowserColorSession;
        State state_;
        bool valid_{};
    };
    bool preview(const Context &, const ColorValues &, bool selectedOnly, IdSequence &) noexcept;
    Capture captureManual(const Context &, IdSequence &) noexcept;
    Capture captureAuto(const Context &, Method, bool selectedOnly, IdSequence &) noexcept;
    bool current(const Request &, const Context &) const noexcept;
    std::optional<BakePlan> plan(const Request &, const Context &, const ColorValues &bakedValues) noexcept;
    // Call only AFTER the host has atomically acknowledged scene/mask/history
    // publication, and before publishing UI metadata. The caller certifies that
    // only color and captured scope clipping changed, and mask VALUES equal the
    // captured target (unrestricted requests retain their canonical values).
    // This metadata method
    // cannot verify that claim without an N-sized scan/SceneEdits integration.
    bool markApplied(const Request &, const Context &before, const Context &after,
                     const ColorValues &bakedValues, bool maskValuesPreserved) noexcept;
    bool cancel(const Request &, const Context &, IdSequence &) noexcept;
    EndDisposition end(const Context &, IdSequence &, bool pointerActionBarrier = false) noexcept;
    void abandon() noexcept; // destruction / explicit closed-source teardown: no bake/flush

    bool active() const noexcept { return bool(state_.base); }
    bool currentBase(const Context &context) const noexcept { return matches(context); }
    bool jobPending() const noexcept { return bool(pending_); }
    bool manualPending() const noexcept { return active() && state_.values != state_.applied; }
    const ColorValues &values() const noexcept { return state_.values; }
    const ColorValues &appliedValues() const noexcept { return state_.applied; }
    bool selectedOnly() const noexcept { return active() && state_.selectedOnly; }
    std::shared_ptr<const Scene> base() const noexcept { return state_.base; }
    const MaskStorage &targetStates() const noexcept { return state_.effectiveStates.hasStorage()?state_.effectiveStates:state_.acknowledged.states; }
    uint64_t sessionId() const noexcept { return state_.sessionId; }
    uint64_t baseId() const noexcept { return state_.baseId; }
    uint64_t epochId() const noexcept { return state_.epochId; }
    Failure failure() const noexcept { return failure_; }

    Snapshot snapshot() const noexcept;
    // Rollback/swap metadata only; the caller restores the corresponding native
    // edit checkpoint separately. A new epoch invalidates all pre-swap requests.
    bool swapMetadata(Snapshot &, IdSequence &) noexcept;
    bool beginTransaction() noexcept;
    bool commitTransaction() noexcept;
    bool rollbackTransaction(IdSequence &) noexcept;
    bool transactionPending() const noexcept { return bool(transaction_); }
    static bool validValues(const ColorValues &) noexcept;
    static ColorValues merge(const ColorValues &, const ColorValues &, Method) noexcept;
  private:
    bool ensure(const Context &, bool selectedOnly, IdSequence &) noexcept;
    bool matches(const Context &) const noexcept;
    Capture capture(const Context &, Kind, Method, IdSequence &) noexcept;
    bool refuse(Failure value) noexcept { failure_ = value; return false; }
    State state_;
    std::optional<Request> pending_;
    std::optional<Snapshot> transaction_;
    Failure failure_{Failure::None};
};
#if defined(__wasm32__)
// Actual promoted-source WASM measurement; this is metadata payload only.
static_assert(sizeof(BrowserColorSession) == 704);
static_assert(sizeof(BrowserColorSession::Snapshot) == 248);
static_assert(sizeof(Request) == 192);
#endif
} // namespace preview::browser_color_metadata
