#include "document_loader_contracts.hpp"
#include "document.hpp"
#include "background_jobs.hpp"
#include <atomic>
#include <chrono>
#include <future>
#include <latch>
#include <memory>
#include <mutex>
#include <semaphore>
#include <stdexcept>
#include <thread>
#include <type_traits>
#include <utility>
#include <vector>

using namespace preview;
using namespace std::chrono_literals;
static_assert(!std::is_copy_constructible_v<DocumentLoader> && !std::is_move_constructible_v<DocumentLoader>);
namespace {
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
template<class Error,class F> void rejects(F &&function,const char *message) {
    try { std::forward<F>(function)(); }
    catch(const Error &) { return; }
    throw std::runtime_error(message);
}
struct Gate {
    std::latch latch{1};
    std::atomic<bool> opened{};
    void wait() { latch.wait(); }
    void open() { if(!opened.exchange(true)) latch.count_down(); }
};
struct OpenOnExit {
    Gate &gate;
    ~OpenOnExit() { gate.open(); }
};
template<class T> void ready(std::future<T> &future,const char *message) {
    require(future.wait_for(5s)==std::future_status::ready,message);
}
Scene scene(size_t marker) { Scene result; result.sourceCount=marker; return result; }
LoadResult resultFrom(DocumentLoader &loader) {
    const auto deadline=std::chrono::steady_clock::now()+5s;
    do {
        if(auto result=loader.take()) return std::move(*result);
        std::this_thread::yield();
    } while(std::chrono::steady_clock::now()<deadline);
    throw std::runtime_error("Document loader must deliver its current terminal result");
}
void idleLoaders() {
    BackgroundExecutor executor(1,1);
    std::atomic<int> calls{};
    std::vector<std::unique_ptr<DocumentLoader>> loaders;
    for(int i=0;i<8;++i)
        loaders.push_back(std::make_unique<DocumentLoader>(executor,[&](const auto &,LoadOptions) {
            ++calls; return scene(1);
        }));
    auto probe=executor.submit([](std::stop_token) { return 41; });
    ready(probe,"Idle loaders must not retain a pool worker or waiting queue slot");
    require(probe.get()==41 && calls==0,"Constructing a loader must not submit idle work");
    for(const auto &loader:loaders) require(!loader->busy() && !loader->take(),"New loaders are idle");
}
void coalesced(bool supersededError) {
    Gate firstFinish,lastFinish;
    std::binary_semaphore firstStarted{0},lastStarted{0};
    std::stop_token firstStop;
    std::atomic<bool> firstObservedStop{},optionsPreserved{};
    std::mutex callsMutex;
    std::vector<std::filesystem::path> calls;
    BackgroundExecutor executor(1,1);
    OpenOnExit releaseFirst{firstFinish},releaseLast{lastFinish};
    DocumentLoader loader(executor,[&](const auto &path,LoadOptions options) {
        { std::lock_guard lock(callsMutex); calls.push_back(path); }
        if(path=="first.ply") {
            firstStop=options.stop; firstStarted.release(); firstFinish.wait();
            firstObservedStop=options.stop.stop_requested();
            if(supersededError) throw std::runtime_error("superseded failure");
            return scene(111);
        }
        optionsPreserved=options.maxSplats==13 && options.maxBytes==97 &&
            options.format==InputFormat::Splat && options.stop.stop_possible();
        lastStarted.release(); lastFinish.wait();
        return scene(222);
    });
    const auto first=loader.request("first.ply");
    require(firstStarted.try_acquire_for(5s),"First load must enter its held callable");
    const auto middle=loader.request("middle.ply");
    const auto skipped=loader.request("skipped.ply");
    LoadOptions options; options.maxSplats=13; options.maxBytes=97; options.format=InputFormat::Splat;
    const auto last=loader.request("last.ply",options);
    require(first<middle && middle<skipped && skipped<last && firstStop.stop_requested() && loader.busy(),
            "Rapid requests increment generations and cancel active work");
    // This fills the sole waiting slot. Loader requests must share the existing
    // drain rather than enqueue a job per path, even when the pool is now full.
    auto probe=executor.submit([](std::stop_token) { return 73; });
    loader.request("last.ply",options);
    const auto latest=loader.request("last.ply",options);
    firstFinish.open();
    require(lastStarted.try_acquire_for(5s),"The latest coalesced load must start after active work exits");
    require(firstObservedStop && !loader.take() && loader.busy(),
            "A superseded success or error must not publish while the latest request is held");
    lastFinish.open();
    ready(probe,"A completed loader must release its pool worker");
    require(probe.get()==73,"Other pool work must run after the loader drain");
    const auto result=loader.take();
    require(result && result->generation==latest && result->path=="last.ply" &&
                result->scene && result->scene->sourceCount==222 && result->error.empty() &&
                optionsPreserved && !loader.busy() && !loader.take(),
            "Only the latest generation publishes once with preserved options");
    std::lock_guard lock(callsMutex);
    require(calls==std::vector<std::filesystem::path>{"first.ply","last.ply"},
            "Pending navigation paths coalesce without invoking intermediate loaders");
}
void queuedCancelAndReuse() {
    Gate finish;
    std::binary_semaphore started{0};
    std::vector<std::filesystem::path> calls;
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token) { started.release(); finish.wait(); });
    require(started.try_acquire_for(5s),"Queued loader fixture must occupy the pool worker");
    DocumentLoader loader(executor,[&](const auto &path,LoadOptions) { calls.push_back(path); return scene(9); });
    loader.request("cancelled.ply"); loader.cancel();
    require(!loader.busy() && !loader.take(),"Cancel clears a queued request and any result");
    const auto generation=loader.request("replacement.ply");
    finish.open(); blocker.get();
    const auto result=resultFrom(loader);
    require(result.generation==generation && result.path=="replacement.ply" && result.scene &&
                result.scene->sourceCount==9 && calls==std::vector<std::filesystem::path>{"replacement.ply"},
            "A canceled queued loader reuses its admission for the replacement only");
    loader.cancel();
    require(!loader.take(),"Cancel after completion cannot expose an old result");
    auto probe=executor.submit([](std::stop_token) {});
    ready(probe,"A loader with no pending path must not wait inside a pool worker"); probe.get();
}
void admissionRejection() {
    Gate finish;
    std::binary_semaphore started{0};
    std::atomic<int> calls{};
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token) { started.release(); finish.wait(); });
    require(started.try_acquire_for(5s),"Admission fixture must occupy its worker");
    auto queued=executor.submit([](std::stop_token) { return 5; });
    DocumentLoader loader(executor,[&](const auto &,LoadOptions) { ++calls; return scene(17); });
    rejects<BackgroundQueueFull>([&] { loader.request("rejected.ply"); },
                                "A full pool must reject a new loader admission synchronously");
    require(!loader.busy() && !loader.take() && calls==0,"Rejection leaves no phantom pending load");
    finish.open(); blocker.get(); require(queued.get()==5,"Existing admitted work survives rejection");
    const auto generation=loader.request("accepted.ply");
    const auto result=resultFrom(loader);
    require(generation>=2 && result.generation==generation && result.scene &&
                result.scene->sourceCount==17 && result.error.empty() && calls==1,
            "A rejected loader remains reusable once admission capacity is available");
}
void currentErrors() {
    BackgroundExecutor executor(1,2);
    DocumentLoader loader(executor,[](const auto &path,LoadOptions) -> Scene {
        if(path=="error.ply") throw std::runtime_error("current load failed");
        if(path=="unknown.ply") throw 17;
        return scene(31);
    });
    const auto errorGeneration=loader.request("error.ply");
    const auto error=resultFrom(loader);
    require(error.generation==errorGeneration && !error.scene && error.error=="current load failed",
            "A current standard load error is delivered with its path and generation");
    loader.request("unknown.ply");
    const auto unknown=resultFrom(loader);
    require(!unknown.scene && unknown.error=="Unknown scene loading error",
            "Nonstandard callable failures become a bounded loader error");
    const auto generation=loader.request("recovered.ply");
    const auto recovered=resultFrom(loader);
    require(recovered.generation==generation && recovered.scene && recovered.error.empty(),
            "Load errors do not poison a later request");
}
void destructionDoesNotJoin() {
    struct Signals { Gate finish; std::binary_semaphore started{0}; std::stop_token stop; };
    auto signals=std::make_shared<Signals>();
    auto ownedInput=std::make_shared<int>(1);
    std::weak_ptr<int> retainedInput=ownedInput;
    BackgroundExecutor executor(1,1);
    OpenOnExit release{signals->finish};
    auto loader=std::make_unique<DocumentLoader>(executor,[signals,ownedInput](const auto &,LoadOptions options) {
        signals->stop=options.stop; signals->started.release(); signals->finish.wait();
        return scene(size_t(*ownedInput));
    });
    ownedInput.reset(); loader->request("held.ply");
    require(signals->started.try_acquire_for(5s),"Destruction fixture must hold its active callable");
    std::promise<void> destroyed;
    auto destruction=destroyed.get_future();
    std::thread destroyer([loader=std::move(loader),done=std::move(destroyed)]() mutable {
        loader.reset(); done.set_value();
    });
    const bool returned=destruction.wait_for(5s)==std::future_status::ready;
    const bool retained=!retainedInput.expired();
    const bool cancelled=signals->stop.stop_requested();
    const bool stillHeld=!signals->finish.opened.load();
    signals->finish.open(); destroyer.join();
    require(returned && retained && cancelled && stillHeld,
            "Destroying a loader cancels and returns while its worker-owned callable remains held");
    auto probe=executor.submit([](std::stop_token) {});
    ready(probe,"Detached loader work must finish safely after its owner is gone"); probe.get();
    require(retainedInput.expired(),"Finished work releases the destroyed loader's owned inputs");
}
void queuedDestructionReleasesAdmission() {
    Gate finish;
    std::binary_semaphore started{0};
    std::atomic<int> calls{};
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token) { started.release(); finish.wait(); });
    require(started.try_acquire_for(5s),"Queued destruction fixture must occupy its worker");
    auto loader=std::make_unique<DocumentLoader>(executor,[&](const auto &,LoadOptions) { ++calls; return scene(1); });
    loader->request("never-run.ply"); loader.reset();
    auto replacement=executor.submit([](std::stop_token) { return 29; });
    finish.open(); blocker.get(); ready(replacement,"Destroyed queued loaders must release queue capacity");
    require(replacement.get()==29 && calls==0,"Destroyed queued loader callables never start");
}
void executorShutdownClearsQueuedState() {
    Gate finish;
    std::binary_semaphore started{0},stopping{0};
    std::atomic<int> calls{};
    BackgroundExecutor executor(1,1);
    OpenOnExit release{finish};
    auto blocker=executor.submit([&](std::stop_token stop) {
        std::stop_callback cancelled(stop,[&] { stopping.release(); });
        started.release(); finish.wait();
    });
    require(started.try_acquire_for(5s),"Shutdown fixture must occupy its worker");
    DocumentLoader loader(executor,[&](const auto &,LoadOptions) { ++calls; return scene(1); });
    loader.request("queued.ply");
    std::thread shutdown([&] { executor.shutdown(); });
    const bool observed=stopping.try_acquire_for(5s);
    // Pool shutdown requests its token before joining the held active callable.
    // Polling can therefore clear a canceled queued admission without a worker.
    const auto deadline=std::chrono::steady_clock::now()+5s;
    while(observed && loader.busy() && std::chrono::steady_clock::now()<deadline)
        std::this_thread::yield();
    const bool idle=observed && !loader.busy() && !loader.take();
    bool rejected=false;
    try { loader.request("stopped.ply"); }
    catch(const BackgroundExecutorStopped &) { rejected=true; }
    catch(...) {} // Release/join the held fixture before reporting a mismatch.
    finish.open(); shutdown.join(); blocker.get();
    require(observed && idle && rejected && !loader.busy() && calls==0,
            "A queued task canceled by executor shutdown cannot leave a loader permanently busy");
}
} // namespace
void documentLoaderContracts() {
    idleLoaders();
    coalesced(false);
    coalesced(true);
    queuedCancelAndReuse();
    admissionRejection();
    currentErrors();
    destructionDoesNotJoin();
    queuedDestructionReleasesAdmission();
    executorShutdownClearsQueuedState();
}
