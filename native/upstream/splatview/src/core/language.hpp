#pragma once
#include <array>
#include <atomic>
#include <filesystem>
#include <functional>
#include <span>
#include <string>
#include <string_view>

namespace preview {
enum class Language {
    System,
    English,
    Spanish,
    French,
    German,
    Portuguese,
    ChineseSimplified,
    Japanese,
    Korean
};
struct LanguageInfo {
    Language language;
    const char *code;
    const char *name;
};
std::span<const LanguageInfo> availableLanguages();
Language languageFromTag(std::string_view tag) noexcept;
Language preferredLanguage(std::span<const std::string> tags) noexcept;
Language systemLanguage() noexcept;

// A missing preference follows the operating system. Explicit choices are saved atomically;
// a failed write leaves the previous choice in effect. Tests inject both inputs.
class LanguagePreferences {
  public:
    explicit LanguagePreferences(std::filesystem::path path = {},
                                 std::function<Language()> detect = systemLanguage) noexcept;
    Language selected() const noexcept { return selected_; }
    Language effective() const noexcept { return effective_; }
    bool set(Language language) noexcept;
    void refreshSystemLanguage() noexcept;

  private:
    std::filesystem::path path_;
    std::function<Language()> detect_;
    std::atomic<Language> selected_{Language::System}, effective_{Language::English};
};
LanguagePreferences &languagePreferences();

struct Translation {
    // English is the stable source key; remaining columns follow Language.
    std::array<const char *, 8> text;
};
std::span<const Translation> translationCatalog();
const char *translate(Language language, const char *english) noexcept;
const char *tr(const char *english) noexcept;
std::wstring trWide(const char *english);
// Preserve ImGui IDs when the visible label changes, including existing ## IDs.
std::string uiLabel(const char *english);
class LanguageScope {
  public:
    explicit LanguageScope(Language language) noexcept;
    ~LanguageScope();
    LanguageScope(const LanguageScope &) = delete;
    LanguageScope &operator=(const LanguageScope &) = delete;

  private:
    Language previous_;
};
} // namespace preview
