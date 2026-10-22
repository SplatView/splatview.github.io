#include "tools_preferences.hpp"
#include "atomic_file.hpp"
#include "preference_lock.hpp"
#include "tutorial.hpp"
#include "file_preferences.hpp"
#include <nlohmann/json.hpp>
#include <fstream>

namespace preview {
namespace {
std::filesystem::path toolsPath() {
    return preferencesRoot()/"tools-ui.json";
}
nlohmann::json read(const std::filesystem::path &path) {
    std::error_code error;
    if (const auto size = std::filesystem::file_size(path, error); error || size > 64 * 1024)
        return nlohmann::json::object();
    std::ifstream file(path, std::ios::binary);
    auto data = nlohmann::json::parse(file, nullptr, false);
    return data.is_object() ? data : nlohmann::json::object();
}
} // namespace
ToolsPreferences::ToolsPreferences(std::filesystem::path path) noexcept {
    try {
        path_ = path.empty() ? toolsPath() : std::move(path);
    } catch (...) {
    }
}
ToolsMode ToolsPreferences::mode() const noexcept {
    try {
        const auto data = read(path_);
        const auto it = data.find("mode");
        if (it != data.end() && it->is_string() && *it == "pro")
            return ToolsMode::Pro;
    } catch (...) {
    }
    return ToolsMode::Basic;
}
bool ToolsPreferences::tutorialSeen() const noexcept {
    try {
        const auto data = read(path_);
        const auto it = data.find("tutorial_version");
        return it != data.end() && it->is_number_integer() && it->get<int>() >= tutorialVersion;
    } catch (...) {
        return false;
    }
}
bool ToolsPreferences::write(const char *key, const char *value) noexcept {
    try {
        if (path_.empty())
            return false;
        PreferenceLock lock(path_.parent_path()/"tools-ui.lock");
        auto data = read(path_);
        if (value)
            data[key] = value;
        else
            data[key] = tutorialVersion;
        std::filesystem::create_directories(path_.parent_path());
        AtomicFile file(path_);
        std::ofstream output(file.path(), std::ios::binary | std::ios::trunc);
        output.exceptions(std::ios::badbit | std::ios::failbit);
        output << data.dump(2) << '\n';
        output.close();
        file.commit();
        return true;
    } catch (...) {
        return false;
    }
}
bool ToolsPreferences::saveMode(ToolsMode mode) noexcept {
    if (mode != ToolsMode::Basic && mode != ToolsMode::Pro)
        return false;
    return write("mode", mode == ToolsMode::Pro ? "pro" : "basic");
}
bool ToolsPreferences::finishTutorial() noexcept {
    return write("tutorial_version", nullptr);
}
} // namespace preview
