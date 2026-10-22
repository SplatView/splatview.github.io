#pragma once
#include "background_jobs.hpp"
#include "live_preview.hpp"
#include <cstdint>
#include <functional>
#include <future>
#include <memory>
#include <optional>
#include <string>

namespace preview {
enum class PreviewTerminal { Presented, Superseded, Cancelled, Rejected, Failed };
struct PreviewCompletion {
    uint64_t request{};
    PreviewKey key;
    PreviewTerminal terminal{};
    std::string error;
};
struct PreviewReceipt {
    uint64_t request{};
    std::shared_future<PreviewCompletion> completion;
};
struct PresentedPreview {
    uint64_t request{};
    LivePreviewResult result;
};
// Owner-thread controller. Only immutable inputs and a small, synchronized
// input slot cross to the executor. No callback is stored or invoked on workers.
// Destruction cancels without joining the borrowed process executor.
class PreviewCoordinator {
  public:
    using Capture = std::function<LivePreviewSnapshot(const PreviewKey &)>;
    using Run = std::function<LivePreviewResult(LivePreviewSnapshot, std::stop_token)>;
    explicit PreviewCoordinator(BackgroundExecutor & = backgroundExecutor(), Run = {});
    ~PreviewCoordinator();
    PreviewCoordinator(const PreviewCoordinator &) = delete;
    PreviewCoordinator &operator=(const PreviewCoordinator &) = delete;
    // Identical requests reuse their receipt, including failure. Explicit retry
    // uses force=true. Pending descriptions never retain a Scene or mask.
    PreviewReceipt request(const PreviewKey &, bool force = false);
    // Call on the Document's owner thread; capture is called only when a latest
    // request can launch. Completion bookkeeping is settled before returning.
    void pump(const Capture &);
    void cancel();
    bool busy() const;
    bool accepts(uint64_t request, const PreviewKey &) const;
    std::optional<PresentedPreview> takeFrame();
  private:
    struct Ticket;
    struct InputSlot;
    struct Active;
    BackgroundExecutor &executor_;
    Run run_;
    uint64_t next_{};
    std::shared_ptr<Ticket> desired_, pending_;
    std::unique_ptr<Active> active_;
    std::optional<PresentedPreview> ready_;
    static PreviewReceipt receipt(const std::shared_ptr<Ticket> &);
    static void finish(const std::shared_ptr<Ticket> &, PreviewTerminal, std::string = {});
    void stopActive();
};
} // namespace preview
