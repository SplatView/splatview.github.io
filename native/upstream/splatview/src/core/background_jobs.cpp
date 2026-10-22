#include "background_jobs.hpp"
#include <algorithm>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

namespace preview {
namespace {
thread_local const void *executingPool{};
}
struct BackgroundExecutor::Impl {
    explicit Impl(std::size_t limit) : queueLimit(limit) {}
    void work() {
        executingPool = this;
        for (;;) {
            std::shared_ptr<detail::BackgroundWork> task;
            {
                std::unique_lock lock(mutex);
                changed.wait(lock, [&] { return stopping || !queue.empty(); });
                if (stopping)
                    return;
                task = std::move(queue.front());
                queue.pop_front();
            }
            task->run();
        }
    }
    const std::size_t queueLimit;
    std::mutex mutex;
    std::condition_variable changed;
    std::deque<std::shared_ptr<detail::BackgroundWork>> queue;
    std::vector<std::thread> workers;
    std::stop_source stop;
    std::once_flag shutdownOnce;
    bool stopping{};
};

BackgroundExecutor::BackgroundExecutor(std::size_t workerCount, std::size_t queueLimit)
    : impl_(std::make_unique<Impl>(queueLimit)) {
    if (!workerCount || !queueLimit)
        throw std::invalid_argument("Background executor needs positive worker and queue limits");
    impl_->workers.reserve(workerCount);
    try {
        for (std::size_t i = 0; i < workerCount; ++i)
            impl_->workers.emplace_back([impl = impl_.get()] { impl->work(); });
    } catch (...) {
        shutdown();
        throw;
    }
}
BackgroundExecutor::~BackgroundExecutor() { shutdown(); }
std::stop_token BackgroundExecutor::shutdownToken() const noexcept { return impl_->stop.get_token(); }
void BackgroundExecutor::enqueue(std::shared_ptr<detail::BackgroundWork> task) {
    std::deque<std::shared_ptr<detail::BackgroundWork>> discarded;
    {
        std::lock_guard lock(impl_->mutex);
        if (impl_->stopping)
            throw BackgroundExecutorStopped();
        // Owner-canceled queued jobs release capacity even when all workers are
        // occupied. Destroy captures/callbacks after releasing the queue lock.
        for (auto it = impl_->queue.begin(); it != impl_->queue.end();) {
            if (!(*it)->pending()) {
                discarded.push_back(std::move(*it));
                it = impl_->queue.erase(it);
            } else
                ++it;
        }
        if (!task->pending())
            return;
        if (impl_->queue.size() >= impl_->queueLimit)
            throw BackgroundQueueFull();
        impl_->queue.push_back(std::move(task));
    }
    impl_->changed.notify_one();
}
void BackgroundExecutor::shutdown() {
    if (executingPool == impl_.get())
        throw std::logic_error("A background job cannot shut down its own executor");
    std::call_once(impl_->shutdownOnce, [&] {
        std::deque<std::shared_ptr<detail::BackgroundWork>> discarded;
        {
            std::lock_guard lock(impl_->mutex);
            impl_->stopping = true;
            discarded.swap(impl_->queue);
        }
        // Request outside the lock: active jobs may register arbitrary stop
        // callbacks, including ones that query/submit to this executor.
        impl_->stop.request_stop();
        impl_->changed.notify_all();
        discarded.clear();
        for (auto &worker : impl_->workers)
            if (worker.joinable())
                worker.join();
    });
}
BackgroundExecutor &backgroundExecutor() {
    static BackgroundExecutor executor(std::clamp(std::thread::hardware_concurrency(), 1u, 4u), 32);
    return executor;
}
} // namespace preview
