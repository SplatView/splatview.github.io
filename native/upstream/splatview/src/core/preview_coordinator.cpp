#include "preview_coordinator.hpp"
#include <chrono>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <utility>

namespace preview {
struct PreviewCoordinator::Ticket {
    Ticket(uint64_t id, const PreviewKey &value) : request(id), key(value), future(promise.get_future().share()) {}
    uint64_t request;
    PreviewKey key;
    std::promise<PreviewCompletion> promise;
    std::shared_future<PreviewCompletion> future;
    bool terminal{};
    PreviewTerminal tag{};
};
struct PreviewCoordinator::InputSlot {
    explicit InputSlot(LivePreviewSnapshot input) : snapshot(std::move(input)) {}
    std::mutex mutex;
    std::optional<LivePreviewSnapshot> snapshot;
    std::optional<LivePreviewSnapshot> take() {
        std::optional<LivePreviewSnapshot> result;
        { std::lock_guard lock(mutex); result.swap(snapshot); }
        return result;
    }
    void clear() { auto discarded = take(); }
};
struct PreviewCoordinator::Active {
    std::shared_ptr<Ticket> ticket;
    std::shared_ptr<InputSlot> input;
    std::stop_source stop;
    std::future<LivePreviewResult> future;
};
PreviewCoordinator::PreviewCoordinator(BackgroundExecutor &executor, Run run)
    : executor_(executor), run_(std::move(run)) {
    if (!run_) run_=[](LivePreviewSnapshot input, std::stop_token stop) { return input.run(stop); };
}
PreviewCoordinator::~PreviewCoordinator() { cancel(); }
PreviewReceipt PreviewCoordinator::receipt(const std::shared_ptr<Ticket> &ticket) {
    return {ticket->request, ticket->future};
}
void PreviewCoordinator::finish(const std::shared_ptr<Ticket> &ticket, PreviewTerminal tag, std::string error) {
    if (!ticket || ticket->terminal) return;
    ticket->promise.set_value({ticket->request,ticket->key,tag,std::move(error)});
    ticket->tag=tag; ticket->terminal=true;
}
void PreviewCoordinator::stopActive() {
    if (!active_) return;
    // Queued cancellation makes its future ready but does not erase the task
    // closure. The closure retains only this slot; clearing releases a queued
    // snapshot now. A running task has already taken ownership independently.
    // Payload destructors/stop callbacks may reenter the owner. Keep the exact
    // old task's handles stable rather than looking up active_ a second time.
    auto input=active_->input;
    auto stop=active_->stop;
    input->clear();
    stop.request_stop();
}
PreviewReceipt PreviewCoordinator::request(const PreviewKey &key, bool force) {
    if (!force && desired_ && desired_->key==key) return receipt(desired_);
    if (next_==std::numeric_limits<uint64_t>::max()) throw std::overflow_error("Preview request identity exhausted");
    auto ticket=std::make_shared<Ticket>(next_+1,key);
    // During an owner-thread capture, its ticket is no longer pending and is
    // not active yet. Reentrant replacement must still settle that receipt.
    finish(desired_,PreviewTerminal::Superseded);
    finish(pending_,PreviewTerminal::Superseded);
    if (active_) finish(active_->ticket,PreviewTerminal::Superseded);
    auto discarded=std::move(ready_); ready_.reset();
    desired_=ticket; pending_=ticket; ++next_;
    stopActive();
    return receipt(ticket);
}
void PreviewCoordinator::pump(const Capture &capture) {
    if (active_) {
        if (active_->future.wait_for(std::chrono::seconds(0))!=std::future_status::ready) return;
        auto done=std::move(active_); // Clear controller state before delivery/capture can reenter.
        done->input->clear();
        try {
            auto result=done->future.get();
            if (!done->ticket->terminal && desired_==done->ticket) {
                if (!(result.key()==done->ticket->key))
                    throw std::runtime_error("Preview worker returned a mismatched input identity");
                ready_.emplace(PresentedPreview{done->ticket->request,std::move(result)});
                finish(done->ticket,PreviewTerminal::Presented);
            }
        } catch (const std::exception &error) {
            if (desired_==done->ticket) finish(done->ticket,PreviewTerminal::Failed,error.what());
        } catch (...) {
            if (desired_==done->ticket) finish(done->ticket,PreviewTerminal::Failed,"Unknown preview worker failure");
        }
    }
    if (active_ || !pending_) return;
    auto ticket=std::move(pending_);
    try {
        // Capture may reenter request/cancel. Never submit an input whose
        // receipt was superseded while the owner-thread factory was running.
        auto snapshot=capture(ticket->key);
        if (ticket->terminal || desired_!=ticket) return;
        if (!(snapshot.key()==ticket->key)) throw std::invalid_argument("Preview capture returned a mismatched input identity");
        auto active=std::make_unique<Active>();
        active->ticket=ticket;
        active->input=std::make_shared<InputSlot>(std::move(snapshot));
        auto input=active->input;
        auto run=run_;
        active->future=executor_.submit([input=std::move(input),run=std::move(run)](std::stop_token stop) mutable {
            auto owned=input->take();
            if (!owned || stop.stop_requested()) throw BackgroundJobCancelled();
            // Move into a local invocation: heavy input dies before the pool
            // publishes future readiness, rather than in its retained closure.
            return run(std::move(*owned),stop);
        },active->stop.get_token());
        active_=std::move(active);
    } catch (const std::exception &error) {
        if (desired_==ticket) finish(ticket,PreviewTerminal::Rejected,error.what());
    } catch (...) {
        if (desired_==ticket) finish(ticket,PreviewTerminal::Rejected,"Unknown preview capture/submission failure");
    }
}
void PreviewCoordinator::cancel() {
    finish(desired_,PreviewTerminal::Cancelled);
    finish(pending_,PreviewTerminal::Cancelled);
    if (active_) finish(active_->ticket,PreviewTerminal::Cancelled);
    auto discarded=std::move(ready_); ready_.reset();
    desired_.reset(); pending_.reset();
    stopActive();
}
bool PreviewCoordinator::busy() const { return active_ || pending_; }
bool PreviewCoordinator::accepts(uint64_t request, const PreviewKey &key) const {
    return desired_ && desired_->request==request && desired_->key==key &&
        desired_->terminal && desired_->tag==PreviewTerminal::Presented;
}
std::optional<PresentedPreview> PreviewCoordinator::takeFrame() {
    auto result=std::move(ready_); ready_.reset(); return result;
}
} // namespace preview
