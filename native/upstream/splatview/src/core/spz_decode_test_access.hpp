#pragma once

namespace preview {
struct SpzDecodeTestAccess;
namespace detail {
struct SpzDecodeAccess;
// Private deterministic stage injection, separate from the public load API.
// The setter is out-of-line in the translation unit defining the TLS storage.
class SpzDecodeState {
    friend struct ::preview::SpzDecodeTestAccess;
    friend struct SpzDecodeAccess;
    static void setCheckpoint(void (*)(void *, const char *), void *) noexcept;
    static void checkpoint(const char *);
    static thread_local void (*checkpoint_)(void *, const char *);
    static thread_local void *checkpointContext_;
};
} // namespace detail
} // namespace preview
