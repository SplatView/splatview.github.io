#pragma once
#include <cstddef>
#include <cstdint>

// Observational ownership for the unthreaded browser core. Raw requests exclude
// malloc metadata/fragmentation, exception ABI storage and raw C codec memory.
// No allocation ceiling or closed-on-failure quota is installed here.
namespace sv_allocation {
struct Snapshot {
    bool valid{};
    std::size_t scenePayloadBytes{},ownedRawBytes{},overlapBytes{},contextBytes{},unionBytes{};
    std::size_t liveBlocks{},liveContexts{};
};
struct State;
class Scope final {
  public:
    Scope();
    ~Scope() noexcept;
    Scope(const Scope &)=delete;
    Scope &operator=(const Scope &)=delete;
  private:
    State *owner_{},*previous_{};
};
// Generated allocator hooks construct this only after the lifetime-owning grant
// exists and immediately before the direct new for its admitted payload.
class PayloadTag final {
  public:
    explicit PayloadTag(std::size_t bytes) noexcept;
    ~PayloadTag() noexcept;
    PayloadTag(const PayloadTag &)=delete;
    PayloadTag &operator=(const PayloadTag &)=delete;
  private:
    friend struct AllocationAccess;
    PayloadTag *previous_{};
    std::size_t bytes_{};
    bool pending_{true};
};
inline constexpr std::uint64_t maxQuerySequence=9007199254740991ULL;
Snapshot snapshot() noexcept;
// On success, publish one checked snapshot and its newly issued query sequence.
// Both outputs remain unchanged on failure. Neither function allocates.
bool query(Snapshot &,std::uint64_t &sequence) noexcept;
bool validSnapshot(const Snapshot &) noexcept;
std::size_t headerBytes() noexcept;
std::size_t contextBytes() noexcept;

#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
enum class EventKind { NewAttempt,BlockAllocated,BlockReleased,ContextAllocated,ContextReleased,BackendFailure };
struct Event {
    EventKind kind{};
    const void *pointer{},*owner{};
    std::size_t requested{},raw{},alignment{},payload{};
};
using Observer=void (*)(const Event &) noexcept;
// Nonshipping C++ observation/injection only. Callbacks must use fixed storage
// and must not allocate, reenter the application, or throw.
void setObserverForContracts(Observer) noexcept;
// Count setup and block backend attempts from one; zero disables. The selected
// failure fires once, with no latch, so normal cleanup remains available.
void failBackendAtForContracts(std::size_t ordinal) noexcept;
#endif
} // namespace sv_allocation
