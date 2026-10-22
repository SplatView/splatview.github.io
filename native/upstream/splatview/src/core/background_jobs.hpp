#pragma once
#include <atomic>
#include <cstddef>
#include <functional>
#include <future>
#include <memory>
#include <stdexcept>
#include <stop_token>
#include <type_traits>
#include <utility>

namespace preview {
class BackgroundJobCancelled : public std::runtime_error {
  public:
    BackgroundJobCancelled() : std::runtime_error("Background job cancelled") {}
};
class BackgroundQueueFull : public std::runtime_error {
  public:
    BackgroundQueueFull() : std::runtime_error("Background job queue is full") {}
};
class BackgroundExecutorStopped : public std::runtime_error {
  public:
    BackgroundExecutorStopped() : std::runtime_error("Background executor has stopped") {}
};
namespace detail {
struct BackgroundWork {
    virtual ~BackgroundWork() = default;
    virtual void run() noexcept = 0;
    virtual bool pending() const noexcept = 0;
};
template<class F> class BackgroundTask final : public BackgroundWork {
  public:
    using Result = std::invoke_result_t<F &, std::stop_token>;
    BackgroundTask(F function, std::stop_token owner, std::stop_token shutdown)
        : function_(std::move(function)),
          ownerCallback_(owner, [this] { cancel(); }),
          shutdownCallback_(shutdown, [this] { cancel(); }) {}
    std::future<Result> future() { return promise_.get_future(); }
    bool pending() const noexcept override { return state_.load() == State::Queued; }
    void run() noexcept override {
        auto expected = State::Queued;
        if (!state_.compare_exchange_strong(expected, State::Running))
            return;
        try {
            checkCancelled();
            if constexpr (std::is_void_v<Result>) {
                std::invoke(function_, stop_.get_token());
                promise_.set_value();
            } else if constexpr (std::is_reference_v<Result>) {
                auto &result = std::invoke(function_, stop_.get_token());
                promise_.set_value(result);
            } else {
                auto result = std::invoke(function_, stop_.get_token());
                promise_.set_value(std::move(result));
            }
        } catch (...) {
            // Only this worker publishes a running task's terminal result.
            promise_.set_exception(std::current_exception());
        }
        state_.store(State::Terminal);
    }
  private:
    enum class State { Queued, Running, Terminal };
    void checkCancelled() const {
        if (stop_.stop_requested())
            throw BackgroundJobCancelled();
    }
    void cancel() noexcept {
        stop_.request_stop();
        auto expected = State::Queued;
        if (state_.compare_exchange_strong(expected, State::Terminal))
            promise_.set_exception(std::make_exception_ptr(BackgroundJobCancelled()));
    }
    F function_;
    std::promise<Result> promise_;
    std::atomic<State> state_{State::Queued};
    std::stop_source stop_;
    // Destroy callbacks before the state they access. stop_callback destruction
    // waits for a concurrent callback before any remaining task members vanish.
    using Callback = std::stop_callback<std::function<void()>>;
    Callback ownerCallback_, shutdownCallback_;
};
} // namespace detail

// Limits count active workers and waiting jobs, not memory bytes. Jobs own their
// inputs; they must not retain UI pointers. Owner cancellation and shutdown are
// cooperative for running work. A queued canceled job never calls its function.
// Once invoked, the callable's result/exception is authoritative: a stop request
// must not turn an already-committed export into a reported cancellation. A running
// callable that cancels throws BackgroundJobCancelled (or its domain exception).
// Shutdown/destruction joins workers; call it from the executor's owning thread,
// never from one of its jobs. Destroying a returned promise-backed future never
// joins a worker, even while its callable is still active.
class BackgroundExecutor {
  public:
    BackgroundExecutor(std::size_t workerCount, std::size_t queueLimit);
    ~BackgroundExecutor();
    BackgroundExecutor(const BackgroundExecutor &) = delete;
    BackgroundExecutor &operator=(const BackgroundExecutor &) = delete;
    BackgroundExecutor(BackgroundExecutor &&) = delete;
    BackgroundExecutor &operator=(BackgroundExecutor &&) = delete;
    template<class F>
    auto submit(F &&function, std::stop_token ownerStop = {})
        -> std::future<std::invoke_result_t<std::decay_t<F> &, std::stop_token>> {
        auto task = std::make_shared<detail::BackgroundTask<std::decay_t<F>>>(
            std::forward<F>(function), ownerStop, shutdownToken());
        auto future = task->future();
        enqueue(std::move(task)); // Explicit synchronous rejection on full/stopped.
        return future;
    }
    void shutdown();
  private:
    std::stop_token shutdownToken() const noexcept;
    void enqueue(std::shared_ptr<detail::BackgroundWork>);
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

// A process-wide pool for native scene/edit/export jobs. Per-document admission,
// latest-preview coalescing and memory accounting remain separate controller work.
BackgroundExecutor &backgroundExecutor();
} // namespace preview
