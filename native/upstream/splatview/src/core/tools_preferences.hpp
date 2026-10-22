#pragma once
#include "tools_mode.hpp"
#include <filesystem>

namespace preview {
// Each window reads its own initial mode. Writes merge with other windows'
// tutorial choices under a per-user lock; they never touch scene preferences.
class ToolsPreferences {
  public:
    explicit ToolsPreferences(std::filesystem::path path = {}) noexcept;
    ToolsMode mode() const noexcept;
    bool tutorialSeen() const noexcept;
    bool saveMode(ToolsMode) noexcept;
    bool finishTutorial() noexcept;

  private:
    bool write(const char *key, const char *value) noexcept;
    std::filesystem::path path_;
};
} // namespace preview
