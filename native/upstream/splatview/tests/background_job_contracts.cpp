#include "background_job_contracts.hpp"
#include "background_jobs.hpp"
#include <chrono>
#include <condition_variable>
#include <latch>
#include <mutex>
#include <semaphore>
#include <string>
#include <thread>

using namespace preview;
using namespace std::chrono_literals;
namespace {
void require(bool value, const char *message) {
    if (!value)
        throw std::runtime_error(message);
}
template<class Error, class F> void rejects(F &&function, const char *message) {
    try {
        std::forward<F>(function)();
    } catch (const Error &) {
        return;
    }
    throw std::runtime_error(message);
}
struct Gate {
    std::latch latch{1};
    std::atomic<bool> opened{};
    void wait() { latch.wait(); }
    void open() {
        if (!opened.exchange(true))
            latch.count_down();
    }
};
struct OpenOnExit {
    Gate &gate;
    ~OpenOnExit() { gate.open(); }
};
struct StopOnExit {
    std::stop_source &stop;
    ~StopOnExit() { stop.request_stop(); }
};
template<class T> void ready(std::future<T> &future, const char *message) {
    require(future.wait_for(5s) == std::future_status::ready, message);
}
void bounded() {
    Gate finish;
    std::counting_semaphore<4> started{0};
    std::atomic<int> active{}, peak{}, ran{};
    BackgroundExecutor executor(2, 2);
    OpenOnExit release{finish};
    auto work = [&](std::stop_token) {
        const auto now = ++active;
        auto previous = peak.load();
        while (previous < now && !peak.compare_exchange_weak(previous, now)) {}
        started.release();
        finish.wait();
        --active;
        return ++ran;
    };
    auto first = executor.submit(work);
    auto second = executor.submit(work);
    require(started.try_acquire_for(5s) && started.try_acquire_for(5s),
            "Both configured workers must start");
    auto third = executor.submit(work);
    auto fourth = executor.submit(work);
    rejects<BackgroundQueueFull>([&] { executor.submit(work); },
                                "A full waiting queue must reject explicitly");
    finish.open();
    ready(first, "First admitted work must finish");
    ready(second, "Second admitted work must finish");
    ready(third, "Third admitted work must finish");
    ready(fourth, "Fourth admitted work must finish");
    first.get(); second.get(); third.get(); fourth.get();
    require(peak == 2 && ran == 4, "Worker and queue bounds must not spawn extra tasks");
}
void queuedCancellation() {
    Gate finish;
    std::binary_semaphore started{0};
    std::atomic<int> queuedRuns{};
    std::stop_source owner;
    BackgroundExecutor executor(1, 1);
    OpenOnExit release{finish};
    auto active = executor.submit([&](std::stop_token) {
        started.release();
        finish.wait();
    });
    require(started.try_acquire_for(5s), "Queued-cancellation fixture must occupy its worker");
    auto canceled = executor.submit([&](std::stop_token) { ++queuedRuns; }, owner.get_token());
    owner.request_stop();
    ready(canceled, "Queued owner cancellation must deliver without waiting for a worker");
    rejects<BackgroundJobCancelled>([&] { canceled.get(); },
                                    "Queued owner cancellation must have a typed terminal result");
    auto replacement = executor.submit([](std::stop_token) { return 42; });
    // An already-canceled owner needs no waiting queue slot, even while full.
    auto alreadyCanceled = executor.submit([&](std::stop_token) { ++queuedRuns; }, owner.get_token());
    ready(alreadyCanceled, "A stopped owner must cancel before queue admission");
    rejects<BackgroundJobCancelled>([&] { alreadyCanceled.get(); },
                                    "A stopped owner must never execute its callable");
    finish.open();
    active.get();
    require(replacement.get() == 42 && queuedRuns == 0,
            "Canceled waiting jobs release capacity and never execute");
}
void activeCancellation() {
    std::binary_semaphore started{0};
    std::condition_variable_any changed;
    std::mutex mutex;
    std::atomic<bool> observed{};
    std::stop_source owner;
    BackgroundExecutor executor(1, 1);
    StopOnExit release{owner};
    auto future = executor.submit([&](std::stop_token stop) -> int {
        std::unique_lock lock(mutex);
        started.release();
        changed.wait(lock, stop, [] { return false; });
        observed = stop.stop_requested();
        throw BackgroundJobCancelled();
    }, owner.get_token());
    require(started.try_acquire_for(5s), "Active cancellation fixture must start");
    owner.request_stop();
    ready(future, "Active owner cancellation must deliver after cooperative work stops");
    rejects<BackgroundJobCancelled>([&] { future.get(); },
                                    "The callable's cooperative cancellation must reach its future");
    require(observed, "The callable must observe the combined stop token");
    require(executor.submit([](std::stop_token) { return 23; }).get() == 23,
            "Owner cancellation must not stop unrelated jobs or the pool");
    std::stop_source committedOwner;
    StopOnExit committedRelease{committedOwner};
    auto committed = executor.submit([&](std::stop_token stop) {
        std::unique_lock lock(mutex);
        started.release();
        changed.wait(lock, stop, [] { return false; });
        // Represents an export that crossed its atomic commit boundary before
        // observing stop. The executor must preserve its successful receipt.
        return 17;
    }, committedOwner.get_token());
    require(started.try_acquire_for(5s), "Late-stop result fixture must start");
    committedOwner.request_stop();
    ready(committed, "A callable result remains terminal after a stop request");
    require(committed.get() == 17, "Stop must not overwrite an authoritative committed result");
}
void failureAndValues() {
    BackgroundExecutor executor(1, 2);
    auto failed = executor.submit([](std::stop_token) -> int { throw std::runtime_error("job detail"); });
    ready(failed, "A throwing callable must deliver an exception");
    try {
        failed.get();
        throw std::logic_error("A failed task returned success");
    } catch (const std::runtime_error &error) {
        require(std::string(error.what()) == "job detail", "The original callable exception must survive");
    }
    auto moved = executor.submit([value = std::make_unique<int>(31)](std::stop_token) mutable {
        return std::move(value);
    });
    require(*moved.get() == 31, "Move-only callables and results must work after failure");
    int value = 7;
    auto reference = executor.submit([&](std::stop_token) -> int & { return value; });
    reference.get() = 8;
    require(value == 8, "Reference results must retain their declared type");
    executor.submit([](std::stop_token) {}).get();
    auto selfShutdown = executor.submit([&](std::stop_token) { executor.shutdown(); });
    rejects<std::logic_error>([&] { selfShutdown.get(); },
                              "A task must not join its own executor");
    require(executor.submit([](std::stop_token) { return true; }).get(),
            "Rejected self-shutdown must leave the pool usable");
}
void discardedFuture() {
    Gate finish;
    std::binary_semaphore started{0}, discarded{0};
    BackgroundExecutor executor(1, 1);
    OpenOnExit release{finish};
    auto future = executor.submit([&](std::stop_token) {
        started.release();
        finish.wait();
    });
    require(started.try_acquire_for(5s), "Discard fixture must keep its callable active");
    std::jthread destroyer([future = std::move(future), &discarded]() mutable {
        future = {};
        discarded.release();
    });
    const bool nonblocking = discarded.try_acquire_for(1s);
    finish.open(); // Also releases a broken implementation before joining/reporting.
    destroyer.join();
    require(nonblocking, "Destroying a returned future must not wait for its active callable");
}
void shutdownDelivery() {
    std::binary_semaphore started{0};
    std::condition_variable_any changed;
    std::mutex mutex;
    std::atomic<int> queuedRuns{};
    std::atomic<bool> observed{};
    std::stop_source owner;
    BackgroundExecutor executor(1, 2);
    auto active = executor.submit([&](std::stop_token stop) {
        std::unique_lock lock(mutex);
        started.release();
        changed.wait(lock, stop, [] { return false; });
        observed = stop.stop_requested();
        throw BackgroundJobCancelled();
    }, owner.get_token());
    require(started.try_acquire_for(5s), "Shutdown fixture must start an active job");
    auto first = executor.submit([&](std::stop_token) { ++queuedRuns; });
    auto second = executor.submit([&](std::stop_token) { ++queuedRuns; });
    executor.shutdown();
    executor.shutdown();
    ready(active, "Shutdown must resolve active promises");
    ready(first, "Shutdown must resolve the first queued promise");
    ready(second, "Shutdown must resolve the second queued promise");
    rejects<BackgroundJobCancelled>([&] { active.get(); }, "Shutdown must cancel active work");
    rejects<BackgroundJobCancelled>([&] { first.get(); }, "Shutdown must cancel queued work");
    rejects<BackgroundJobCancelled>([&] { second.get(); }, "Every queued job needs terminal delivery");
    require(observed && queuedRuns == 0, "Shutdown signals running work and never starts queued work");
    require(!owner.stop_requested(), "Combined shutdown cancellation must not mutate the owner's source");
    rejects<BackgroundExecutorStopped>([&] { executor.submit([](std::stop_token) {}); },
                                       "A stopped executor must reject admission explicitly");
}
void destructorDelivery() {
    std::binary_semaphore started{0};
    std::condition_variable_any changed;
    std::mutex mutex;
    std::future<int> active, queued;
    std::atomic<int> queuedRuns{};
    {
        BackgroundExecutor executor(1, 1);
        active = executor.submit([&](std::stop_token stop) -> int {
            std::unique_lock lock(mutex);
            started.release();
            changed.wait(lock, stop, [] { return false; });
            throw BackgroundJobCancelled();
        });
        require(started.try_acquire_for(5s), "Destructor fixture must start");
        queued = executor.submit([&](std::stop_token) { return ++queuedRuns; });
    }
    rejects<BackgroundJobCancelled>([&] { active.get(); },
                                    "Executor destruction must resolve the surviving active future");
    rejects<BackgroundJobCancelled>([&] { queued.get(); },
                                    "Executor destruction must resolve the surviving queued future");
    require(queuedRuns == 0, "Executor destruction must not invoke queued callables");
}
void terminalRace() {
    BackgroundExecutor executor(2, 2);
    for (int i = 0; i < 128; ++i) {
        std::stop_source owner;
        auto future = executor.submit([](std::stop_token) { return 29; }, owner.get_token());
        std::jthread canceler([&] { owner.request_stop(); });
        ready(future, "Concurrent cancellation/completion must always deliver a terminal result");
        try {
            require(future.get() == 29, "Successful race outcomes must retain the callable result");
        } catch (const BackgroundJobCancelled &) {
            // Cancellation before invocation is also an authorized outcome.
        }
        canceler.join();
    }
    require(executor.submit([](std::stop_token) { return true; }).get(),
            "Cancellation races must not break promises or kill workers");
}
} // namespace
void backgroundJobContracts() {
    rejects<std::invalid_argument>([] { BackgroundExecutor executor(0, 1); },
                                   "Zero workers must be rejected");
    rejects<std::invalid_argument>([] { BackgroundExecutor executor(1, 0); },
                                   "Zero waiting capacity must be rejected");
    bounded();
    queuedCancellation();
    activeCancellation();
    failureAndValues();
    discardedFuture();
    shutdownDelivery();
    destructorDelivery();
    terminalRace();
    require(&backgroundExecutor() == &backgroundExecutor(), "Native callers must share one process pool");
    require(backgroundExecutor().submit([](std::stop_token) { return 19; }).get() == 19,
            "The process pool must accept stop-aware work");
}
