#pragma once
#include "file_preferences.hpp"
#include "frame_capture.hpp"
#include <optional>

namespace preview {
struct PreferenceSaveCompletion {
    std::filesystem::path source;
    SavedView camera;
    bool thumbnail{};
};
// Capture on the owner thread. Only source provenance is copied from the loaded
// Scene; camera-only saves do not retain its Gaussian arrays. Thumbnail work owns
// an immutable render snapshot. The selected preference directory is a value,
// rather than a worker read of mutable global configuration.
class PreferenceSaveSnapshot {
  public:
    PreferenceSaveSnapshot(std::filesystem::path source, const Scene &loaded,
                           SavedView camera, std::filesystem::path directory,
                           std::optional<FrameCaptureSnapshot> thumbnail = {},
                           std::optional<ResourceBudget> resources = {});
    PreferenceSaveCompletion run(std::stop_token = {}) const;
  private:
    std::filesystem::path source_, directory_;
    Scene provenance_;
    SavedView camera_;
    std::optional<FrameCaptureSnapshot> thumbnail_;
    // Explicit host ledger for source fingerprint captures. A render snapshot
    // may use the same ledger, but its policy is never inferred here.
    std::optional<ResourceBudget> resources_;
};
} // namespace preview
