#include "admitted_storage_contracts.hpp"
#include "admitted_storage.hpp"
#include "resource_budget.hpp"
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <limits>
#include <memory>
#include <new>
#include <optional>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <utility>
#include <vector>

using namespace preview;
namespace {
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error, class F> void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const Error &) { return; }
    throw std::runtime_error(message);
}
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto bytes : usage.categoryBytes) require(bytes == 0, message);
}

// Observe the allocator's actual requests, including implementation-specific
// rebound types, without reproducing STL node/block/bucket size formulas.
struct Request {
    std::size_t bytes{}, liveBefore{};
    bool accepted{};
};
struct Observations {
    std::vector<Request> requests;
    std::size_t live{}, peak{}, released{}, activeGrants{};
    std::size_t failAt{}, limit{std::numeric_limits<std::size_t>::max()};
};
struct ObservedGrant {
    std::shared_ptr<Observations> observations;
    std::size_t bytes;
    ObservedGrant(std::shared_ptr<Observations> value, std::size_t size) noexcept
        : observations(std::move(value)), bytes(size) {
        observations->live += bytes;
        observations->peak = std::max(observations->peak, observations->live);
        ++observations->activeGrants;
    }
    ~ObservedGrant() {
        observations->live -= bytes;
        --observations->activeGrants;
        ++observations->released;
    }
};
class ObservedMemory final : public SceneMemory {
  public:
    explicit ObservedMemory(std::shared_ptr<Observations> value) : observations(std::move(value)) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        const auto ordinal = observations->requests.size() + 1;
        observations->requests.push_back({bytes, observations->live, false});
        if (ordinal == observations->failAt || observations->live > observations->limit ||
            bytes > observations->limit - observations->live)
            throw std::bad_alloc();
        auto result = std::make_shared<ObservedGrant>(observations, bytes);
        observations->requests.back().accepted = true;
        return result;
    }
    const std::shared_ptr<Observations> observations;
};
void released(const Observations &observations, const char *message) {
    require(observations.live == 0 && observations.activeGrants == 0, message);
    const auto accepted = std::count_if(observations.requests.begin(), observations.requests.end(),
                                      [](const Request &request) { return request.accepted; });
    require(observations.released == static_cast<std::size_t>(accepted), message);
}
template<class T> std::size_t payloadBytes(const AdmittedVector<T> &values) {
    return values.capacity() * sizeof(T);
}

struct alignas(64) NodeProbe {
    inline static unsigned constructions{};
    std::array<std::uint64_t, 8> values{};
    NodeProbe() { ++constructions; }
};
void rebindAlignmentAndOverflow() {
    using Base = AdmittedAllocator<std::uint8_t>;
    using Rebound = std::allocator_traits<Base>::rebind_alloc<NodeProbe>;
    using Restored = std::allocator_traits<Rebound>::rebind_alloc<std::uint8_t>;
    static_assert(std::is_same_v<Restored, Base>);
    static_assert(std::is_nothrow_move_constructible_v<Base> && std::is_nothrow_move_assignable_v<Base>);
    auto observations = std::make_shared<Observations>();
    auto memory = std::make_shared<ObservedMemory>(observations);
    Base base(memory);
    Rebound rebound(base);
    observations->limit = 0;
    NodeProbe::constructions = 0;
    rejects<std::bad_alloc>([&] { (void)rebound.allocate(1); },
                           "A real nonpayload rebind must not bypass admission");
    require(NodeProbe::constructions == 0 && observations->requests.size() == 1 &&
                observations->requests.back().bytes == sizeof(NodeProbe) && observations->live == 0,
            "Rebound rejection must precede physical payload construction and report its actual type size");
    observations->limit = std::numeric_limits<std::size_t>::max();
    auto *block = rebound.allocate(3);
    require(reinterpret_cast<std::uintptr_t>(block) % alignof(NodeProbe) == 0 &&
                observations->live == 3 * sizeof(NodeProbe),
            "Overaligned rebound payload must be aligned and charge the actual allocation request");
    for (unsigned i = 0; i < 3; ++i) {
        std::construct_at(block + i);
        block[i].values[0] = 31 + i;
    }
    Rebound moved(std::move(rebound));
    require(rebound.memory() == memory && moved.memory() == memory && Restored(moved) == base,
            "Move and round-trip rebind must preserve policy in both reusable allocator handles");
    require(block[2].values[0] == 33, "The allocation envelope must not overlap payload contents");
    for (unsigned i = 0; i < 3; ++i) std::destroy_at(block + i);
    rebound.deallocate(block, 3);
    const auto requestsBeforeOverflow = observations->requests.size();
    rejects<std::bad_array_new_length>([&] { (void)base.allocate(std::numeric_limits<std::size_t>::max()); },
                                      "Count plus allocation envelope must reject overflow before admission");
    rejects<std::bad_array_new_length>([&] {
        (void)moved.allocate(std::numeric_limits<std::size_t>::max() / sizeof(NodeProbe) + 1);
    }, "Rebound count multiplication must reject overflow before admission");
    require(observations->requests.size() == requestsBeforeOverflow,
            "Overflow rejection must not call the service or acquire a grant");
    released(*observations, "Rebound payload grants must release exactly once");
}

void envelopeOutlivesAllocatorAndService() {
    auto observations = std::make_shared<Observations>();
    std::weak_ptr<SceneMemory> weakMemory;
    NodeProbe *block;
    {
        auto memory = std::make_shared<ObservedMemory>(observations);
        weakMemory = memory;
        AdmittedAllocator<NodeProbe> allocator(memory);
        block = allocator.allocate(1);
        std::construct_at(block);
        block->values[0] = 97;
    }
    require(weakMemory.expired() && observations->live == sizeof(NodeProbe) && block->values[0] == 97,
            "Allocation grants must outlive all service and allocator handles without retaining a raw owner");
    std::destroy_at(block);
    AdmittedAllocator<NodeProbe>{}.deallocate(block, 1);
    released(*observations, "An empty allocator must free the same envelope after the original service dies");

    // The unbudgeted route must use the same envelope even when the freeing
    // allocator has a service that would reject every positive request.
    auto memory = std::make_shared<ObservedMemory>(observations);
    observations->limit = 0;
    AdmittedAllocator<NodeProbe> bound(memory);
    auto *unbudgeted = AdmittedAllocator<NodeProbe>{}.allocate(1);
    std::construct_at(unbudgeted);
    unbudgeted->values[1] = 109;
    const auto requests = observations->requests.size();
    std::destroy_at(unbudgeted);
    bound.deallocate(unbudgeted, 1);
    require(observations->requests.size() == requests,
            "Deallocation must not consult the current allocator's admission service");
    released(*observations, "Unbudgeted/bound deallocation paths must match without a grant");
}

void vectorGrowthAndAdmissionFailure() {
    auto observations = std::make_shared<Observations>();
    auto memory = std::make_shared<ObservedMemory>(observations);
    {
        AdmittedVector<std::uint64_t> values{AdmittedAllocator<std::uint64_t>{memory}};
        values.reserve(3);
        values.assign(3, 47);
        const auto oldBytes = observations->live;
        values.reserve(values.capacity() * 2 + 1);
        const auto &growth = observations->requests.back();
        require(growth.accepted && growth.liveBefore == oldBytes &&
                    growth.bytes == payloadBytes(values) && observations->peak >= oldBytes + growth.bytes &&
                    observations->live == growth.bytes,
                "Actual old and new vector capacities must coexist until the old allocation is freed");
        const auto *pointer = values.data();
        const auto capacity = values.capacity();
        observations->failAt = observations->requests.size() + 1;
        rejects<std::bad_alloc>([&] { values.reserve(capacity * 2 + 1); },
                               "A denied growth request must propagate without changing the live vector");
        require(values.data() == pointer && values.capacity() == capacity && values.size() == 3 &&
                    values[2] == 47 && observations->live == payloadBytes(values),
                "Failed vector growth must preserve storage, values and its original grant");
    }
    released(*observations, "Vector growth and rejected growth must release every accepted grant");
}
struct ThrowingElement {
    inline static unsigned attempts{}, live{};
    inline static unsigned throwAt{};
    ThrowingElement() {
        if (++attempts == throwAt) throw std::runtime_error("Expected admitted element construction failure");
        ++live;
    }
    ~ThrowingElement() { --live; }
};
void elementConstructionRollback() {
    auto observations = std::make_shared<Observations>();
    auto memory = std::make_shared<ObservedMemory>(observations);
    {
        AdmittedVector<ThrowingElement> values{AdmittedAllocator<ThrowingElement>{memory}};
        ThrowingElement::attempts = ThrowingElement::live = 0;
        ThrowingElement::throwAt = 2;
        struct ClearFailure { ~ClearFailure() { ThrowingElement::throwAt = 0; } } clear;
        rejects<std::runtime_error>([&] { values.resize(3); },
                                    "Failure after admission must destroy constructed elements and storage");
        require(values.empty() && ThrowingElement::live == 0 && observations->peak >= 3 * sizeof(ThrowingElement),
                "Partial element construction must own admission and leave no live element");
        released(*observations, "Element construction failure must roll back its accepted allocation");
        ThrowingElement::throwAt = 0;
        values.resize(2);
        require(ThrowingElement::live == 2 && observations->live == payloadBytes(values),
                "An admitted container must remain usable after construction failure");
    }
    require(ThrowingElement::live == 0, "Container destruction must destroy all surviving elements");
    released(*observations, "Retried container storage must release its grant");
}

void debugMovesAndZeroHeadroom() {
    ResourceBudget denied(0);
    auto deniedMemory = sceneMemoryForBudget(denied, ResourceCategory::History);
    {
        AdmittedVector<std::uint64_t> first{AdmittedAllocator<std::uint64_t>{deniedMemory}};
        AdmittedVector<std::uint64_t> moved(std::move(first));
        AdmittedVector<std::uint64_t> assigned;
        assigned = std::move(moved);
        require(first.get_allocator().memory() == deniedMemory && moved.get_allocator().memory() == deniedMemory &&
                    assigned.get_allocator().memory() == deniedMemory,
                "Empty construction/moves must preserve reusable policies without admitting debug proxies");
        for (auto *values : {&first, &moved, &assigned})
            rejects<ResourceBudgetExceeded>([&] { values->push_back(1); },
                                            "Real payload allocation after an empty move must still obey zero allowance");
        empty(denied, "Exempt debugger bookkeeping must not obtain a positive resource grant");
    }
    ResourceBudget budget(4096);
    auto memory = sceneMemoryForBudget(budget, ResourceCategory::History);
    {
        std::optional<AdmittedVector<std::uint64_t>> source(std::in_place, AdmittedAllocator<std::uint64_t>{memory});
        source->assign(3, 83);
        auto iterator = source->begin();
        const auto payload = payloadBytes(*source);
        auto occupied = budget.reserve(ResourceCategory::Work, budget.limits().totalBytes - payload);
        AdmittedVector<std::uint64_t> moved(std::move(*source));
        require(*iterator == 83 && source->get_allocator().memory() == memory,
                "A full-ledger Debug move must preserve iterators and the moved-from policy");
        rejects<ResourceBudgetExceeded>([&] { source->push_back(7); },
                                        "Reusing a moved-from vector must not create unbudgeted payload");
        source.reset();
        AdmittedVector<std::uint64_t> assigned;
        assigned = std::move(moved);
        require(*iterator == 83 && budget.usage().totalBytes == budget.limits().totalBytes,
                "Move assignment and moved-from destruction at zero headroom must not recharge payload or proxy");
        rejects<ResourceBudgetExceeded>([&] { moved.push_back(9); },
                                        "Move-assigned source reuse must retain its original admission policy");
        occupied.release();
        require(budget.usage().totalBytes == payloadBytes(assigned) &&
                    budget.usage().categoryBytes[std::size_t(ResourceCategory::History)] == payloadBytes(assigned),
                "Only actual retained payload may remain after pressure is released");
    }
    empty(budget, "Moved and destroyed Debug containers must release the original ledger exactly once");
}

void crossLedgerCopyMoveAndSwap() {
    ResourceBudget first(1 << 20), second(1 << 20);
    auto firstMemory = sceneMemoryForBudget(first, ResourceCategory::History);
    auto secondMemory = sceneMemoryForBudget(second, ResourceCategory::Work);
    {
        AdmittedVector<std::uint32_t> original{AdmittedAllocator<std::uint32_t>{firstMemory}};
        original.assign(4, 101);
        auto copy = original;
        require(copy.data() != original.data() && copy.get_allocator().memory() == firstMemory &&
                    first.usage().totalBytes == payloadBytes(original) + payloadBytes(copy),
                "Container copy must propagate policy and acquire independent physical storage");
        AdmittedVector<std::uint32_t> destination{AdmittedAllocator<std::uint32_t>{secondMemory}};
        destination.assign(2, 103);
        destination = copy;
        empty(second, "Copy assignment across ledgers must release the destination's previous allocation");
        require(destination.get_allocator().memory() == firstMemory && destination == copy &&
                    first.usage().totalBytes == payloadBytes(original) + payloadBytes(copy) + payloadBytes(destination),
                "Copy assignment must charge its new physical storage to the propagated source policy");
        auto *pointer = copy.data();
        auto iterator = copy.begin();
        const auto firstBytes = first.usage().totalBytes;
        AdmittedVector<std::uint32_t> moved(std::move(copy));
        require(moved.data() == pointer && *iterator == 101 && first.usage().totalBytes == firstBytes,
                "Move construction must transfer existing storage rather than copy its payload");
        AdmittedVector<std::uint32_t> foreign{AdmittedAllocator<std::uint32_t>{secondMemory}};
        foreign.assign(3, 107);
        foreign = std::move(moved);
        empty(second, "Move assignment across ledgers must free the previous foreign payload");
        require(foreign.data() == pointer && foreign.get_allocator().memory() == firstMemory &&
                    moved.get_allocator().memory() == firstMemory && *iterator == 101 && first.usage().totalBytes == firstBytes,
                "Move assignment must transfer storage and keep source policy without double charging");
        AdmittedVector<std::uint32_t> other{AdmittedAllocator<std::uint32_t>{secondMemory}};
        other.assign(5, 109);
        const auto secondBytes = second.usage().totalBytes;
        auto *otherPointer = other.data();
        foreign.swap(other);
        require(foreign.data() == otherPointer && other.data() == pointer && *iterator == 101 &&
                    foreign.get_allocator().memory() == secondMemory && other.get_allocator().memory() == firstMemory &&
                    first.usage().totalBytes == firstBytes && second.usage().totalBytes == secondBytes,
                "Cross-ledger swap must move policies and grants with their actual allocations");
    }
    empty(first, "All copied/moved/swapped first-ledger payloads must release");
    empty(second, "All copied/moved/swapped second-ledger payloads must release");
}

struct HistoryValue {
    std::array<std::uint64_t, 4> fields{};
    explicit HistoryValue(std::uint64_t value) { fields[0] = value; }
};
using History = std::deque<HistoryValue, AdmittedAllocator<HistoryValue>>;
void fillHistory(const std::shared_ptr<SceneMemory> &memory) {
    History history{AdmittedAllocator<HistoryValue>{memory}};
    for (std::uint64_t i = 0; i < 64; ++i) history.emplace_back(i);
    require(history.front().fields[0] == 0 && history.back().fields[0] == 63,
            "Real deque history storage must retain the appended values");
}
void dequeBlocksMapsAndRollback() {
    auto observed = std::make_shared<Observations>();
    auto memory = std::make_shared<ObservedMemory>(observed);
    fillHistory(memory);
    released(*observed, "Deque maps, blocks and retained entries must release all real rebound grants");
    require(observed->requests.size() >= 3 &&
                std::any_of(observed->requests.begin(), observed->requests.end(), [&](const Request &request) {
                    return request.bytes != observed->requests.front().bytes;
                }),
            "Actual deque admission must include its distinct map/block requests, not only value bytes");
    const auto requests = observed->requests.size();
    for (std::size_t failAt = 1; failAt <= requests; ++failAt) {
        auto rejected = std::make_shared<Observations>();
        rejected->failAt = failAt;
        rejects<std::bad_alloc>([&] { fillHistory(std::make_shared<ObservedMemory>(rejected)); },
                               "Each actual deque allocation boundary must propagate rejection");
        require(rejected->requests.size() == failAt && !rejected->requests.back().accepted,
                "Deque rejection must stop at the injected real allocation boundary");
        released(*rejected, "Partial deque construction/growth must release maps, blocks and earlier grants");
    }
}

void hashNodesBucketsAndInnerArrays() {
    using Indices = AdmittedVector<std::uint32_t>;
    using Entry = std::pair<const std::uint32_t, Indices>;
    using Cells = std::unordered_map<std::uint32_t, Indices, std::hash<std::uint32_t>, std::equal_to<std::uint32_t>,
                                     AdmittedAllocator<Entry>>;
    auto outer = std::make_shared<Observations>(), inner = std::make_shared<Observations>();
    auto outerMemory = std::make_shared<ObservedMemory>(outer), innerMemory = std::make_shared<ObservedMemory>(inner);
    {
        Cells cells(0, std::hash<std::uint32_t>{}, std::equal_to<std::uint32_t>{}, AdmittedAllocator<Entry>{outerMemory});
        cells.reserve(8);
        const auto beforeNode = outer->requests.size();
        auto [position, inserted] = cells.try_emplace(7, AdmittedAllocator<std::uint32_t>{innerMemory});
        require(inserted && outer->requests.size() > beforeNode && inner->requests.empty(),
                "Hash nodes must be admitted separately; explicit empty mapped-array construction charges no payload");
        auto &indices = position->second;
        indices.reserve(5);
        indices.assign({3, 5, 8});
        require(indices.get_allocator().memory() == innerMemory && inner->live == payloadBytes(indices),
                "Mapped index arrays must receive an explicit service and retain their own capacity grant");
        const auto beforeRehash = outer->live, beforeRequests = outer->requests.size();
        const auto oldBuckets = cells.bucket_count();
        cells.rehash(oldBuckets * 4 + 1);
        require(cells.bucket_count() > oldBuckets && outer->requests.size() > beforeRequests &&
                    outer->requests[beforeRequests].accepted && outer->requests[beforeRequests].liveBefore == beforeRehash &&
                    outer->peak >= beforeRehash + outer->requests[beforeRequests].bytes && inner->live == payloadBytes(indices),
                "Actual hash bucket reallocation must admit new buckets while old buckets/nodes remain retained");

        const auto outerBytes = outer->live, innerBytes = inner->live;
        const auto bucketCount = cells.bucket_count();
        outer->failAt = outer->requests.size() + 1;
        rejects<std::bad_alloc>([&] { cells.try_emplace(11, AdmittedAllocator<std::uint32_t>{innerMemory}); },
                               "A rejected hash node must not create an unbudgeted mapped array");
        require(cells.size() == 1 && !cells.contains(11) && cells.bucket_count() == bucketCount &&
                    outer->live == outerBytes && inner->live == innerBytes && indices[2] == 8,
                "Node admission rejection must preserve existing nodes, bucket storage and mapped values");
        outer->failAt = outer->requests.size() + 1;
        rejects<std::bad_alloc>([&] { cells.rehash(bucketCount * 4 + 1); },
                               "A rejected bucket reallocation must leave the original table intact");
        require(cells.size() == 1 && cells.bucket_count() == bucketCount && outer->live == outerBytes &&
                    inner->live == innerBytes && indices[0] == 3,
                "Bucket rejection must not release the old buckets or alter mapped arrays");
        inner->failAt = inner->requests.size() + 1;
        const auto capacity = indices.capacity();
        const auto *pointer = indices.data();
        rejects<std::bad_alloc>([&] { indices.reserve(capacity * 2 + 1); },
                               "Each mapped index-array growth must independently obey admission");
        require(indices.data() == pointer && indices.capacity() == capacity && indices.size() == 3 &&
                    outer->live == outerBytes && inner->live == innerBytes,
                "Rejected inner growth must preserve the table and its original index allocation");
    }
    released(*outer, "Hash sentinels, nodes and bucket arrays must release all rebound grants");
    released(*inner, "Nested mapped index arrays must release their independent grants");
}
} // namespace

void runAdmittedStorageContracts() {
    rebindAlignmentAndOverflow();
    envelopeOutlivesAllocatorAndService();
    vectorGrowthAndAdmissionFailure();
    elementConstructionRollback();
    debugMovesAndZeroHeadroom();
    crossLedgerCopyMoveAndSwap();
    dequeBlocksMapsAndRollback();
    hashNodesBucketsAndInnerArrays();
}
