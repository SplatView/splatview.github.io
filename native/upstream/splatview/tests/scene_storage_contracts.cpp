#include "scene_storage_contracts.hpp"
#include "resource_budget.hpp"
#include "scene_storage.hpp"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <exception>
#include <latch>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <optional>
#include <semaphore>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

using namespace preview;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error, class F> void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const Error &) { return; }
    throw std::runtime_error(message);
}
template<class T> std::size_t payloadBytes(const SceneVector<T> &values) {
    return checkedByteProduct(values.capacity(), sizeof(T));
}
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto count : usage.categoryBytes) require(count == 0, message);
}
void ledgerIdentity() {
    ResourceBudget first(4096), distinct(4096);
    auto alias = first;
    require(first.sharesLedger(alias) && alias.sharesLedger(first) && !first.sharesLedger(distinct),
            "Ledger identity follows handle ownership, not equal resource limits");
    auto moved = std::move(alias);
    require(moved.sharesLedger(first) && !alias.sharesLedger(first) && !alias.sharesLedger(alias),
            "A moved-from budget must not identify an accounting ledger");
    rejects<std::invalid_argument>([&] { sceneMemoryForBudget(first, ResourceCategory::Count); },
                                   "An allocation service must reject an invalid category");
    empty(first, "Service construction must not precharge future storage");
}
void bookkeepingAndDebugMoves() {
    struct Bookkeeping { std::array<std::byte, 33> state{}; };
    using PayloadAllocator = SceneAllocator<std::uint64_t>;
    using BookkeepingAllocator = std::allocator_traits<PayloadAllocator>::rebind_alloc<Bookkeeping>;
    using ReboundPayload = std::allocator_traits<BookkeepingAllocator>::rebind_alloc<std::uint64_t>;
    static_assert(std::is_same_v<PayloadAllocator, ReboundPayload>);
    ResourceBudget denied(0);
    PayloadAllocator payload(sceneMemoryForBudget(denied));
    BookkeepingAllocator bookkeeping(payload);
    auto *block = bookkeeping.allocate(1);
    std::construct_at(block);
    block->state[0] = std::byte{71};
    auto movedBookkeeping = std::move(bookkeeping);
    std::destroy_at(block);
    // A container can transfer a debug proxy to its moved-from owner. Internal
    // storage must be deallocatable even after that owner's service moved out.
    bookkeeping.deallocate(block, 1);
    empty(denied, "Rebound container bookkeeping must not consume payload allowance");
    ReboundPayload restored(movedBookkeeping);
    rejects<ResourceBudgetExceeded>([&] { (void)restored.allocate(1); },
                                    "Rebinding back must retain the real payload's admission service");

    ResourceBudget budget(4096);
    {
        std::optional<SceneVector<std::uint64_t>> source(std::in_place,
            PayloadAllocator{sceneMemoryForBudget(budget)});
        source->assign(3, 101);
        const auto bytes = payloadBytes(*source);
        auto iterator = source->begin();
        auto occupied = budget.reserve(ResourceCategory::Work, budget.limits().totalBytes - bytes);
        SceneVector<std::uint64_t> moved(std::move(*source));
        source.reset();
        require(*iterator == 101 && budget.usage().totalBytes == budget.limits().totalBytes,
                "Moving and destroying a moved-from debug vector must preserve payload iterators and charges");
        SceneVector<std::uint64_t> assigned;
        assigned = std::move(moved);
        require(*iterator == 101 && assigned.size() == 3 &&
                    budget.usage().totalBytes == budget.limits().totalBytes,
                "Noexcept vector moves must not request payload admission for internal proxy replacement");
        occupied.release();
        require(budget.usage().totalBytes == payloadBytes(assigned),
                "Debug bookkeeping must not appear in actual payload capacity accounting");
    }
    empty(budget, "Moved debug vector destruction must use the correct allocation/deallocation path");
}
void growthAndRejectedGrowth() {
    ResourceBudget budget(1 << 20);
    {
        SceneVector<std::uint64_t> values{SceneAllocator<std::uint64_t>{sceneMemoryForBudget(budget)}};
        values.reserve(3);
        values.resize(values.capacity(), 71);
        const auto oldBytes = payloadBytes(values);
        require(budget.usage().totalBytes == oldBytes,
                "Allocator charges must follow actual capacity, not the requested size");
        values.push_back(93);
        const auto newBytes = payloadBytes(values);
        require(newBytes > oldBytes && budget.usage().totalBytes == newBytes &&
                    budget.usage().peakBytes >= oldBytes + newBytes,
                "Vector growth must admit old and new physical allocations at the same time");
        require(values.front() == 71 && values.back() == 93,
                "Admitted growth must preserve the vector's values");
        values.resize(values.capacity(), 19);
        const auto *pointer = values.data();
        const auto capacity = values.capacity(), size = values.size();
        const auto bytes = payloadBytes(values);
        auto occupied = budget.reserve(ResourceCategory::Work, budget.limits().totalBytes - bytes);
        rejects<ResourceBudgetExceeded>([&] { values.push_back(107); },
                                        "Growth must reject while existing allocations consume the allowance");
        require(values.data() == pointer && values.capacity() == capacity && values.size() == size &&
                    values.front() == 71 && budget.usage().totalBytes == budget.limits().totalBytes,
                "Rejected growth must preserve old storage and release no unrelated charge");
        occupied.release();
        require(budget.usage().totalBytes == bytes,
                "Rejected growth must not leave an additional allocation charge");
    }
    empty(budget, "Destroying a vector must release all of its physical capacity");
}
struct ConstructionProbe {
    inline static unsigned constructions{};
    ConstructionProbe() { ++constructions; }
};
struct ThrowingElement {
    inline static bool fail{};
    ThrowingElement() { if (fail) throw std::runtime_error("Expected element failure"); }
};
void allocationAndConstructionFailures() {
    ResourceBudget denied(0);
    ConstructionProbe::constructions = 0;
    SceneVector<ConstructionProbe> rejected{SceneAllocator<ConstructionProbe>{sceneMemoryForBudget(denied)}};
    rejects<ResourceBudgetExceeded>([&] { rejected.resize(1); },
                                    "Admission rejection must precede constructing payload elements");
    require(ConstructionProbe::constructions == 0 && rejected.empty() && rejected.capacity() == 0,
            "A denied payload allocation must not begin constructing its contents");
    empty(denied, "Denied allocation must not leak a reservation");

    ResourceBudget budget(4096);
    SceneVector<ThrowingElement> values{SceneAllocator<ThrowingElement>{sceneMemoryForBudget(budget)}};
    ThrowingElement::fail = true;
    try {
        rejects<std::runtime_error>([&] { values.resize(4); },
                                    "The element-construction failure fixture must throw");
    } catch (...) { ThrowingElement::fail = false; throw; }
    ThrowingElement::fail = false;
    require(values.empty() && budget.usage().peakBytes >= 4 * sizeof(ThrowingElement),
            "Failed element construction must have owned an admitted allocation");
    empty(budget, "Failure after admission must roll back the physical allocation's grant");
    values.resize(4);
    require(budget.usage().totalBytes == payloadBytes(values),
            "An allocator must remain usable after a construction failure");
}
void sceneCopiesAndMoves() {
    ResourceBudget budget(1 << 20), otherBudget(1 << 20);
    {
        Scene original(sceneMemoryForBudget(budget));
        original.gaussians.resize(2);
        original.vertices.resize(3);
        original.triangles.push_back({0, 1, 2});
        original.gaussians[0].positionOpacity[0] = 23;
        original.sourceContentKey = "fixture-content";
        original.sourceFileIdentity = "fixture-file";
        original.sourceBytes = 987;
        original.defaultView = SavedView{};
        original.defaultView->roll = .25f;
        const auto originalBytes = accountedSceneStorageBytes(original, budget);
        require(originalBytes == budget.usage().totalBytes,
                "All three Scene payload containers must be admitted by the selected ledger");
        Scene copy = original;
        const auto copyBytes = accountedSceneStorageBytes(copy, budget);
        require(copy.gaussians.data() != original.gaussians.data() &&
                    copy.vertices.data() != original.vertices.data() &&
                    copy.triangles.data() != original.triangles.data() &&
                    budget.usage().totalBytes == originalBytes + copyBytes,
                "A deep Scene copy must acquire independent allocation grants");
        require(copy.sourceContentKey == original.sourceContentKey &&
                    copy.sourceFileIdentity == original.sourceFileIdentity && copy.sourceBytes == 987 &&
                    copy.defaultView == original.defaultView,
                "Allocation ownership must not replace source provenance or saved-view metadata");
        copy.gaussians[0].positionOpacity[0] = 41;
        require(original.gaussians[0].positionOpacity[0] == 23,
                "A copied Scene remains independent editable storage");
        Scene assigned(sceneMemoryForBudget(otherBudget));
        assigned.gaussians.resize(1);
        assigned = original;
        empty(otherBudget, "Copy assignment must release the destination's previous ledger charge");
        require(accountedSceneStorageBytes(assigned, budget) > 0 &&
                    accountedSceneStorageBytes(assigned, otherBudget) == 0,
                "Copy assignment must propagate the source allocation service");
        const auto beforeMove = budget.usage().totalBytes;
        const auto *copiedStorage = copy.gaussians.data();
        auto retained = std::make_shared<Scene>(std::move(copy));
        require(retained->gaussians.data() == copiedStorage && budget.usage().totalBytes == beforeMove,
                "Moving a returned Scene into shared ownership must transfer storage without another charge");
        std::shared_ptr<const Scene> history = retained;
        retained.reset();
        require(history->gaussians[0].positionOpacity[0] == 41 && budget.usage().totalBytes == beforeMove,
                "A retained immutable reference must keep the existing grant without charging a deep copy");
    }
    empty(budget, "The last Scene/reference owner must release its allocations");
    empty(otherBudget, "Replaced Scene storage must release its original ledger");
}
void rejectedCopyAndSwap() {
    ResourceBudget budget(1 << 20), secondBudget(1 << 20);
    {
        Scene original(sceneMemoryForBudget(budget));
        original.gaussians.resize(3);
        original.gaussians[0].positionOpacity[0] = 29;
        const auto originalBytes = budget.usage().totalBytes;
        auto occupied = budget.reserve(ResourceCategory::Work, budget.limits().totalBytes - originalBytes);
        rejects<ResourceBudgetExceeded>([&] { Scene copy(original); },
                                        "A deep copy must not reuse the source allocation's admission grant");
        require(original.gaussians.size() == 3 && original.gaussians[0].positionOpacity[0] == 29 &&
                    budget.usage().totalBytes == budget.limits().totalBytes,
                "A rejected copy must preserve its source and roll back partial admissions");
        occupied.release();
        Scene second(sceneMemoryForBudget(secondBudget));
        second.gaussians.resize(2);
        second.gaussians[0].positionOpacity[0] = 83;
        const auto secondBytes = secondBudget.usage().totalBytes;
        const auto *firstPointer = original.gaussians.data(), *secondPointer = second.gaussians.data();
        using std::swap;
        swap(original, second);
        require(original.gaussians.data() == secondPointer && second.gaussians.data() == firstPointer &&
                    budget.usage().totalBytes == originalBytes && secondBudget.usage().totalBytes == secondBytes &&
                    accountedSceneStorageBytes(original, secondBudget) == secondBytes &&
                    accountedSceneStorageBytes(second, budget) == originalBytes,
                "Swapping Scenes with different services must transfer their grants with the physical storage");
    }
    empty(budget, "Swapped allocations must release their original ledger grants");
    empty(secondBudget, "Both swapped allocation services must release exactly once");
}
void mixedStorageAccounting() {
    ResourceBudget first(1 << 20), second(1 << 20);
    {
        Scene scene(sceneMemoryForBudget(first));
        scene.gaussians.resize(2);
        scene.vertices = SceneVector<PreviewVertex>{SceneAllocator<PreviewVertex>{sceneMemoryForBudget(second)}};
        scene.vertices.resize(3);
        scene.triangles = SceneVector<std::array<std::uint32_t, 3>>{
            SceneAllocator<std::array<std::uint32_t, 3>>{sceneMemoryForBudget(first, ResourceCategory::Work)}};
        scene.triangles.resize(2);
        scene.format.assign(4096, 'm');
        require(accountedSceneStorageBytes(scene, first) == payloadBytes(scene.gaussians) + payloadBytes(scene.triangles) &&
                    accountedSceneStorageBytes(scene, second) == payloadBytes(scene.vertices),
                "Storage deductions must inspect each vector's ledger and exclude metadata capacity");
        require(first.usage().categoryBytes[std::size_t(ResourceCategory::Decoded)] == payloadBytes(scene.gaussians) &&
                    first.usage().categoryBytes[std::size_t(ResourceCategory::Work)] == payloadBytes(scene.triangles),
                "An adapter must preserve its caller's accounting category");
        Scene untracked;
        untracked.gaussians.resize(1);
        require(accountedSceneStorageBytes(untracked, first) == 0,
                "Compatibility storage must not be represented as admitted to an unrelated ledger");
    }
    empty(first, "Mixed-service Scene destruction must release each allocation");
    empty(second, "Mixed-service Scene destruction must reach every owning ledger");
}
struct alignas(256) AlignedElement {
    std::uint64_t value{};
    std::array<std::byte, 256 - sizeof(std::uint64_t)> padding{};
};
class RecordingMemory final : public SceneMemory {
  public:
    std::size_t calls{}, lastBytes{};
    std::shared_ptr<void> admit(std::size_t bytes) override {
        ++calls; lastBytes = bytes; return {};
    }
};
void alignmentAndOverflow() {
    ResourceBudget budget(16384);
    {
        SceneVector<AlignedElement> values{SceneAllocator<AlignedElement>{sceneMemoryForBudget(budget)}};
        values.resize(3);
        require(reinterpret_cast<std::uintptr_t>(values.data()) % alignof(AlignedElement) == 0 &&
                    budget.usage().totalBytes == payloadBytes(values),
                "Allocation envelopes must preserve over-aligned payload addresses and capacity accounting");
        values[2].value = 53;
        values.push_back({79});
        require(reinterpret_cast<std::uintptr_t>(values.data()) % alignof(AlignedElement) == 0 &&
                    values[2].value == 53 && values.back().value == 79,
                "Over-aligned storage must remain valid through growth");
    }
    empty(budget, "Over-aligned allocation destruction must release its grant");
    auto service = std::make_shared<RecordingMemory>();
    SceneAllocator<AlignedElement> allocator(service);
    const auto impossible = std::numeric_limits<std::size_t>::max() / sizeof(AlignedElement) + 1;
    rejects<std::bad_array_new_length>([&] { (void)allocator.allocate(impossible); },
                                      "A byte-product overflow must reject the allocation");
    require(service->calls == 0, "Overflow must reject before requesting an admission grant");
}
void detachedOwnerLifetime() {
    SceneVector<std::uint32_t> values;
    std::weak_ptr<SceneMemory> serviceLifetime;
    {
        ResourceBudget temporaryBudget(4096);
        auto service = sceneMemoryForBudget(temporaryBudget);
        serviceLifetime = service;
        values = SceneVector<std::uint32_t>{SceneAllocator<std::uint32_t>{service}};
        values.assign(9, 101);
    }
    require(!serviceLifetime.expired() && values.size() == 9 && values.back() == 101,
            "Payload allocators must own their service after the caller's options and budget handles disappear");
    values = SceneVector<std::uint32_t>{};
    require(serviceLifetime.expired(), "Dropping the final allocator/storage owner must release the service");
}
struct Gate {
    std::latch latch{1};
    std::atomic<bool> opened{};
    void wait() { latch.wait(); }
    void open() { if (!opened.exchange(true)) latch.count_down(); }
};
struct OpenOnExit { Gate &gate; ~OpenOnExit() { gate.open(); } };
void concurrentServices() {
    ResourceBudget budget(1 << 20);
    const auto service = sceneMemoryForBudget(budget);
    Gate finish;
    std::counting_semaphore<8> started{0};
    std::array<std::size_t, 8> capacities{};
    std::mutex errorMutex;
    std::exception_ptr error;
    std::vector<std::jthread> workers;
    OpenOnExit release{finish};
    for (std::size_t i = 0; i < capacities.size(); ++i)
        workers.emplace_back([&, i] {
            try {
                SceneVector<std::uint64_t> values{SceneAllocator<std::uint64_t>{service}};
                values.resize(i + 2, i);
                capacities[i] = payloadBytes(values);
                started.release();
                finish.wait();
            } catch (...) {
                { std::lock_guard lock(errorMutex); error = std::current_exception(); }
                started.release();
            }
        });
    for (std::size_t i = 0; i < capacities.size(); ++i)
        require(started.try_acquire_for(5s), "Shared allocation-service workers must reach their retention gate");
    if (error) std::rethrow_exception(error);
    require(budget.usage().totalBytes == checkedByteSum(capacities) &&
                budget.usage().categoryBytes[std::size_t(ResourceCategory::Decoded)] == checkedByteSum(capacities),
            "One shared allocation service must account for every concurrently retained physical vector");
    finish.open();
    workers.clear();
    empty(budget, "Concurrent vector destruction must release every shared-service reservation");
}
} // namespace
void sceneStorageContracts() {
    ledgerIdentity();
    bookkeepingAndDebugMoves();
    growthAndRejectedGrowth();
    allocationAndConstructionFailures();
    sceneCopiesAndMoves();
    rejectedCopyAndSwap();
    mixedStorageAccounting();
    alignmentAndOverflow();
    detachedOwnerLifetime();
    concurrentServices();
}
