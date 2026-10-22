#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <exception>
#include <mutex>
#include <stdexcept>
#include <stop_token>
#include <thread>

namespace preview::detail {
// Bounded adaptation of gsply's parallel, fused per-Gaussian loops. Small
// previews stay serial; larger loads use at most four CPU threads, including
// the caller. No worker pool or scratch scene remains allocated while idle.
template <class Function>
void parallelFor(size_t count, std::stop_token stop, Function action, size_t grain = 16'384) {
    const size_t workers = std::min({size_t(4), size_t(std::max(1u, std::thread::hardware_concurrency())),
                                     std::max(size_t(1), count / grain)});
    std::exception_ptr error;
    std::mutex errorMutex;
    std::atomic<bool> failed{false};
    auto run = [&](size_t worker) {
        try {
            const size_t first = count * worker / workers, last = count * (worker + 1) / workers;
            for (size_t i = first; i < last; ++i) {
                if ((i & 1023) == 0) {
                    if (failed.load(std::memory_order_relaxed))
                        return;
                    if (stop.stop_requested())
                        throw std::runtime_error("Loading canceled");
                }
                action(i);
            }
        } catch (...) {
            std::lock_guard lock(errorMutex);
            if (!error)
                error = std::current_exception();
            failed.store(true, std::memory_order_relaxed);
        }
    };
    std::array<std::jthread, 3> threads;
    for (size_t worker = 1; worker < workers; ++worker)
        threads[worker - 1] = std::jthread(run, worker);
    run(0);
    for (auto &thread : threads)
        if (thread.joinable())
            thread.join();
    if (error)
        std::rethrow_exception(error);
    if (stop.stop_requested())
        throw std::runtime_error("Loading canceled");
}
} // namespace preview::detail
