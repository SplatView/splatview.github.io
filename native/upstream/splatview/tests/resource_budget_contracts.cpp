#include "resource_budget_contracts.hpp"
#include "resource_budget.hpp"
#include "background_jobs.hpp"
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <exception>
#include <latch>
#include <mutex>
#include <optional>
#include <semaphore>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

using namespace preview;
using namespace std::chrono_literals;
static_assert(!std::is_copy_constructible_v<ResourceReservation> &&
              std::is_nothrow_move_constructible_v<ResourceReservation> &&
              std::is_nothrow_move_assignable_v<ResourceReservation>);
namespace {
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class Error, class F> void rejects(F &&function, const char *message) {
    try { std::forward<F>(function)(); }
    catch (const Error &) { return; }
    throw std::runtime_error(message);
}
struct Gate {
    std::latch latch{1};
    std::atomic<bool> opened{};
    void wait() { latch.wait(); }
    void open() { if (!opened.exchange(true)) latch.count_down(); }
};
struct OpenOnExit { Gate &gate; ~OpenOnExit() { gate.open(); } };
void empty(const ResourceBudget &budget, const char *message) {
    const auto usage = budget.usage();
    require(usage.totalBytes == 0, message);
    for (const auto value : usage.categoryBytes) require(value == 0, message);
}
void simultaneous(bool shared) {
    ResourceBudget budget(512);
    const auto identity = shared ? AllocationIdentity::create() : AllocationIdentity{};
    Gate finish;
    std::counting_semaphore<8> started{0};
    std::mutex errorMutex;
    std::exception_ptr error;
    std::vector<std::jthread> workers;
    OpenOnExit release{finish};
    for (unsigned i = 0; i < 8; ++i)
        workers.emplace_back([&] {
            try {
                auto grant = budget.reserve(ResourceCategory::Work, 64, identity);
                started.release();
                finish.wait();
            } catch (...) {
                { std::lock_guard lock(errorMutex); error = std::current_exception(); }
                started.release();
            }
        });
    for (unsigned i = 0; i < 8; ++i)
        require(started.try_acquire_for(5s), "All simultaneous admission attempts must complete");
    if (error) std::rethrow_exception(error);
    const auto usage = budget.usage();
    const std::size_t expected = shared ? 64 : 512;
    require(usage.totalBytes == expected && usage.peakBytes == expected &&
                usage.categoryBytes[std::size_t(ResourceCategory::Work)] == expected,
            "Concurrent grants must count each physical allocation exactly once");
    if (!shared)
        rejects<ResourceBudgetExceeded>([&] { budget.reserve(ResourceCategory::Work, 1); },
                                        "Concurrent grants must not oversubscribe their byte limit");
    finish.open();
    workers.clear();
    empty(budget, "Concurrent grant destruction must release every charge");
}
void movesAndLimits() {
    ResourceLimits limits{100};
    limits.categoryBytes[std::size_t(ResourceCategory::Source)] = 40;
    ResourceBudget budget(limits);
    const auto alias = budget;
    auto source = budget.reserve(ResourceCategory::Source, 30);
    auto work = alias.reserve(ResourceCategory::Work, 40);
    require(budget.usage().totalBytes == 70 && alias.usage().totalBytes == 70,
            "Copied budget handles must share one ledger");
    try {
        budget.reserve(ResourceCategory::Source, 11);
        throw std::logic_error("Category admission unexpectedly succeeded");
    } catch (const ResourceBudgetExceeded &error) {
        require(error.requestedBytes() == 11 && error.availableBytes() == 10,
                "Rejection must expose the applicable remaining byte allowance");
    }
    auto moved = std::move(source);
    require(!source && source.bytes() == 0 && moved.bytes() == 30,
            "Moving a reservation must transfer its single release responsibility");
    work = std::move(moved);
    require(!moved && budget.usage().totalBytes == 30,
            "Move assignment releases the destination's old allocation exactly once");
    work.shrink(12);
    require(work.bytes() == 12 && budget.usage().totalBytes == 12 && budget.usage().peakBytes == 70,
            "Shrink releases only unused capacity and preserves the recorded peak");
    rejects<std::invalid_argument>([&] { work.shrink(13); },
                                   "A shrink cannot grant unadmitted additional storage");
    work.release(); work.release();
    empty(budget, "Release must be idempotent");
    rejects<std::invalid_argument>([&] { budget.reserve(ResourceCategory::Count, 1); },
                                   "Invalid categories must not alter the ledger");
    ResourceBudget zero(0);
    auto noBytes = zero.reserve(ResourceCategory::Image, 0);
    require(bool(noBytes) && zero.usage().totalBytes == 0, "Zero-byte grants can carry an allocation lifetime");
    rejects<ResourceBudgetExceeded>([&] { zero.reserve(ResourceCategory::Image, 1); },
                                    "A zero policy must reject positive storage");
    std::optional<ResourceReservation> survivor;
    {
        ResourceBudget temporaryOwner(64);
        survivor.emplace(temporaryOwner.reserve(ResourceCategory::Decoded, 64));
    }
    survivor->shrink(32);
    require(survivor->bytes() == 32, "A grant must safely outlive its budget handle");
    survivor.reset();
}
void sharedIdentity() {
    ResourceBudget budget(200);
    const auto identity = AllocationIdentity::create();
    auto first = budget.reserve(ResourceCategory::Decoded, 100, identity);
    auto second = budget.reserve(ResourceCategory::Decoded, 100, identity);
    require(first.bytes() == 100 && second.bytes() == 100 && budget.usage().totalBytes == 100,
            "Shared holders retain a full estimate but charge its physical storage once");
    rejects<ResourceIdentityConflict>([&] { budget.reserve(ResourceCategory::Decoded, 101, identity); },
                                      "One allocation identity cannot silently change its byte estimate");
    rejects<ResourceIdentityConflict>([&] { budget.reserve(ResourceCategory::History, 100, identity); },
                                      "History references must not reclassify or double-charge a decoded allocation");
    rejects<ResourceIdentityConflict>([&] { first.shrink(60); },
                                      "Shared shrink must not invalidate another holder's estimate");
    require(budget.usage().totalBytes == 100, "Conflicting shared requests must leave accounting unchanged");
    first.release();
    second.shrink(60);
    require(budget.usage().totalBytes == 60, "Sole shared holder may release unused capacity");
    auto third = budget.reserve(ResourceCategory::Decoded, 60, identity);
    auto distinct = budget.reserve(ResourceCategory::Decoded, 60, AllocationIdentity::create());
    require(budget.usage().totalBytes == 120, "Different allocation identities must count separately");
    second.release(); third.release(); distinct.release();
    empty(budget, "The last shared holder must release the physical allocation charge");
    auto again = budget.reserve(ResourceCategory::Decoded, 100, identity);
    require(budget.usage().totalBytes == 100, "A fully released identity can describe a fresh allocation lifetime");
}
void estimatesAndOverflow() {
    constexpr auto maximum = std::numeric_limits<std::size_t>::max();
    require(checkedByteProduct(maximum, 0) == 0 && checkedByteSum({}) == 0,
            "Empty storage estimates must remain zero without overflow");
    rejects<std::overflow_error>([&] { checkedByteProduct(maximum, 2); }, "Byte products must detect overflow");
    rejects<std::overflow_error>([&] { checkedByteSum({maximum, 1}); }, "Byte sums must detect overflow");
    require(imagePayloadBytes(96, 80, 2) == 96 * 80 * 8, "Image estimates must include every admitted BGRA buffer");
    rejects<std::invalid_argument>([] { imagePayloadBytes(0, 10); }, "Image estimates reject zero dimensions");
    rejects<std::invalid_argument>([] { imagePayloadBytes(10, 10, 0); }, "Image estimates reject zero buffer counts");
    rejects<std::overflow_error>([] {
        imagePayloadBytes(std::numeric_limits<unsigned>::max(), std::numeric_limits<unsigned>::max());
    }, "Image estimates must detect BGRA byte overflow");
    Scene scene;
    scene.gaussians.reserve(10); scene.vertices.reserve(7); scene.triangles.reserve(4);
    const auto expected = checkedByteSum({sizeof(Scene), scene.gaussians.capacity() * sizeof(Gaussian),
        scene.vertices.capacity() * sizeof(PreviewVertex), scene.triangles.capacity() * sizeof(std::array<uint32_t, 3>),
        scene.format.capacity() + 1, scene.sourceContentKey.capacity() + 1, scene.sourceFileIdentity.capacity() + 1});
    require(scenePayloadBytes(scene) == expected, "Scene estimates must include allocated capacity, not only used element count");
    ResourceBudget huge(maximum);
    auto first = huge.reserve(ResourceCategory::Work, maximum - 5);
    auto last = huge.reserve(ResourceCategory::Image, 5);
    require(huge.usage().totalBytes == maximum, "Ledger addition must safely reach its maximum representable limit");
    rejects<ResourceBudgetExceeded>([&] { huge.reserve(ResourceCategory::Work, 1); },
                                    "Admission must reject before an overflowing ledger addition");
    last.release(); first.release();
    empty(huge, "Huge accounting-only reservations must release without underflow");
    ResourceBudget small(8);
    auto full = small.reserve(ResourceCategory::Source, 8);
    unsigned allocations = 0;
    rejects<ResourceBudgetExceeded>([&] {
        auto grant = small.reserve(ResourceCategory::Decoded, 1);
        ++allocations;
        std::vector<uint8_t> storage(grant.bytes());
    }, "Budget rejection must occur before the caller creates its payload");
    require(allocations == 0 && small.usage().totalBytes == 8, "Rejected admission must neither allocate payload nor leak a charge");
}
struct Payload {
    explicit Payload(ResourceReservation reservation) : grant(std::move(reservation)), bytes(grant.bytes()) {}
    ResourceReservation grant;
    std::vector<uint8_t> bytes;
};
void submittedLifetimes() {
    ResourceBudget budget(256);
    Gate finish;
    std::binary_semaphore started{0};
    BackgroundExecutor executor(1, 1);
    OpenOnExit release{finish};
    auto activePayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Work, 32));
    const std::weak_ptr<Payload> activeLifetime = activePayload;
    auto active = executor.submit([payload = std::move(activePayload), &started, &finish](std::stop_token) {
        started.release(); finish.wait(); return payload->bytes.size();
    });
    require(started.try_acquire_for(5s), "Reservation lifetime fixture must occupy its worker");
    std::stop_source owner;
    auto queuedPayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Image, 48));
    const std::weak_ptr<Payload> queuedLifetime = queuedPayload;
    auto queued = executor.submit([payload = std::move(queuedPayload)](std::stop_token) {
        return payload->bytes.size();
    }, owner.get_token());
    auto rejectedPayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Render, 16));
    const std::weak_ptr<Payload> rejectedLifetime = rejectedPayload;
    rejects<BackgroundQueueFull>([&] {
        executor.submit([payload = std::move(rejectedPayload)](std::stop_token) { return payload->bytes.size(); });
    }, "Rejected queue submission must destroy its unaccepted captures");
    require(rejectedLifetime.expired() && budget.usage().totalBytes == 80,
            "Rejected submission must release its reservation with its payload");
    owner.request_stop();
    rejects<BackgroundJobCancelled>([&] { queued.get(); }, "Queued cancellation must deliver its terminal outcome");
    const auto retainedCharge = queuedLifetime.expired() ? std::size_t(0) : std::size_t(48);
    require(budget.usage().totalBytes == 32 + retainedCharge,
            "Cancelled captures stay charged for exactly their actual retained lifetime");
    auto replacementPayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Image, 16));
    auto replacement = executor.submit([payload = std::move(replacementPayload)](std::stop_token) {
        return payload->bytes.size();
    });
    require(queuedLifetime.expired() && budget.usage().totalBytes == 48,
            "Purging a canceled queue entry must destroy its payload and release its grant");
    finish.open();
    require(active.get() == 32 && replacement.get() == 16, "Admitted payloads must remain alive through execution");
    auto failedPayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Work, 24));
    auto failed = executor.submit([payload = std::move(failedPayload)](std::stop_token) -> int {
        (void)payload; // The retained payload lifetime is the behavior under test.
        throw std::runtime_error("Expected admitted-job failure");
    });
    rejects<std::runtime_error>([&] { failed.get(); }, "A failed admitted callable must deliver its exception");
    executor.shutdown();
    require(activeLifetime.expired(), "Worker shutdown must release completed payload captures");
    empty(budget, "Success/failure/cancel/rejection must release all payload reservations");

    BackgroundExecutor stoppedOwnerExecutor(1, 1);
    auto stoppedPayload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Work, 12));
    const std::weak_ptr<Payload> stoppedLifetime = stoppedPayload;
    auto stopped = stoppedOwnerExecutor.submit([payload = std::move(stoppedPayload)](std::stop_token) {
        return payload->bytes.size();
    }, owner.get_token());
    rejects<BackgroundJobCancelled>([&] { stopped.get(); }, "Pre-canceled admission must not execute its payload");
    require(stoppedLifetime.expired(), "An already-canceled submission must not retain an unqueued reservation");
    empty(budget, "Pre-canceled submission must release its grant exactly once");
}
void activeCancellationLifetime() {
    ResourceBudget budget(32);
    std::binary_semaphore started{0};
    std::condition_variable_any changed;
    std::mutex mutex;
    std::stop_source owner;
    BackgroundExecutor executor(1, 1);
    auto payload = std::make_shared<Payload>(budget.reserve(ResourceCategory::Work, 32));
    const std::weak_ptr<Payload> lifetime = payload;
    auto future = executor.submit([payload = std::move(payload), &mutex, &started, &changed](std::stop_token stop) {
        (void)payload;
        std::unique_lock lock(mutex);
        started.release(); changed.wait(lock, stop, [] { return false; });
        throw BackgroundJobCancelled();
    }, owner.get_token());
    require(started.try_acquire_for(5s), "Active cancellation lifetime fixture must start");
    require(budget.usage().totalBytes == 32 && !lifetime.expired(), "Running job storage must remain charged");
    owner.request_stop();
    rejects<BackgroundJobCancelled>([&] { future.get(); }, "Cooperative cancellation must reach the admitted job's future");
    executor.shutdown();
    require(lifetime.expired(), "Canceled worker must release its physical payload");
    empty(budget, "Canceled worker must release its reservation after payload destruction");
}
} // namespace
void resourceBudgetContracts() {
    simultaneous(false);
    simultaneous(true);
    movesAndLimits();
    sharedIdentity();
    estimatesAndOverflow();
    submittedLifetimes();
    activeCancellationLifetime();
}
