#include "language.hpp"
#include "atomic_file.hpp"
#include "file_io.hpp"
#include "file_preferences.hpp"
#include "preference_lock.hpp"
#include <cstdlib>
#ifdef _WIN32
#include <windows.h>
#endif
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif
#include <nlohmann/json.hpp>
#include <algorithm>
#include <fstream>
#include <unordered_map>
#include <vector>

namespace preview {
namespace {
constexpr LanguageInfo languages[] = {
    {Language::System, "system", "System default"},
    {Language::English, "en", "English"},
    {Language::Spanish, "es", "Español"},
    {Language::French, "fr", "Français"},
    {Language::German, "de", "Deutsch"},
    {Language::Portuguese, "pt", "Português"},
    {Language::ChineseSimplified, "zh-Hans", "简体中文"},
    {Language::Japanese, "ja", "日本語"},
    {Language::Korean, "ko", "한국어"},
};
const Translation catalog[] = {
#include "translations.inc"
};
thread_local Language activeLanguage = Language::System;

std::filesystem::path preferencePath() {
    return preferencesRoot() / "settings.json";
}
nlohmann::json readSettings(const std::filesystem::path &path) {
    std::error_code error;
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > 64 * 1024)
        return nlohmann::json::object();
    std::ifstream input(path, std::ios::binary);
    auto value = nlohmann::json::parse(input, nullptr, false);
    return value.is_object() ? value : nlohmann::json::object();
}
Language detectSafely(const std::function<Language()> &detect) noexcept {
    try {
        const auto language = detect ? detect() : Language::English;
        if (language > Language::System && language <= Language::Korean)
            return language;
    } catch (...) {
    }
    return Language::English;
}
} // namespace
std::span<const LanguageInfo> availableLanguages() {
    return languages;
}
std::span<const Translation> translationCatalog() {
    return catalog;
}
Language languageFromTag(std::string_view tag) noexcept {
    if (tag.size() < 2)
        return Language::System;
    const auto lower = [](char c) { return c >= 'A' && c <= 'Z' ? char(c + 'a' - 'A') : c; };
    if (tag.size() > 2 && tag[2] != '-' && tag[2] != '_')
        return Language::System;
    for (const auto &info : languages)
        if (info.language != Language::System && lower(tag[0]) == info.code[0] &&
            lower(tag[1]) == info.code[1])
            return info.language;
    return Language::System;
}
Language preferredLanguage(std::span<const std::string> tags) noexcept {
    for (const auto &tag : tags)
        if (const auto language = languageFromTag(tag); language != Language::System)
            return language;
    return Language::English;
}
Language systemLanguage() noexcept {
#ifdef _WIN32
    try {
        ULONG count{}, length{};
        if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &count, nullptr, &length) && length) {
            std::vector<wchar_t> buffer(length);
            if (GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &count, buffer.data(), &length)) {
                std::vector<std::string> tags;
                size_t at{};
                while (at < buffer.size() && buffer[at]) {
                    std::string tag;
                    while (at < buffer.size() && buffer[at])
                        tag.push_back(char(buffer[at++])); // BCP 47 language tags are ASCII.
                    tags.push_back(std::move(tag));
                    ++at;
                }
                if (!tags.empty())
                    return preferredLanguage(tags);
            }
        }
        wchar_t name[LOCALE_NAME_MAX_LENGTH]{};
        if (LCIDToLocaleName(MAKELCID(GetUserDefaultUILanguage(), SORT_DEFAULT), name, LOCALE_NAME_MAX_LENGTH,
                             0)) {
            std::string tag;
            for (const wchar_t *p = name; *p; ++p)
                tag.push_back(char(*p));
            const auto language = languageFromTag(tag);
            if (language != Language::System)
                return language;
        }
    } catch (...) {
    }
#elif defined(__APPLE__)
    auto preferred=CFLocaleCopyPreferredLanguages();
    if(preferred) {
        std::vector<std::string> tags;
        for(CFIndex i=0;i<CFArrayGetCount(preferred);++i) {
            char buffer[128]{};
            if(CFStringGetCString(static_cast<CFStringRef>(CFArrayGetValueAtIndex(preferred,i)),buffer,sizeof(buffer),kCFStringEncodingUTF8)) tags.emplace_back(buffer);
        }
        CFRelease(preferred);
        return preferredLanguage(tags);
    }
#else
    for(const char *name:{"LC_ALL","LC_MESSAGES","LANG"}) if(const char *value=std::getenv(name)) {
        const auto language=languageFromTag(value); if(language!=Language::System) return language;
    }
#endif
    return Language::English;
}

LanguagePreferences::LanguagePreferences(std::filesystem::path path,
                                         std::function<Language()> detect) noexcept
    : detect_(std::move(detect)) {
    try {
        path_ = path.empty() ? preferencePath() : std::move(path);
        const auto saved = readSettings(path_);
        if (auto it = saved.find("language"); it != saved.end() && it->is_string()) {
            const auto &code = it->get_ref<const std::string &>();
            for (const auto &info : languages)
                if (code == info.code) {
                    selected_ = info.language;
                    break;
                }
        }
    } catch (...) {
    }
    refreshSystemLanguage();
}
void LanguagePreferences::refreshSystemLanguage() noexcept {
    const auto selected = selected_.load();
    effective_ = selected == Language::System ? detectSafely(detect_) : selected;
}
bool LanguagePreferences::set(Language language) noexcept {
    if (language < Language::System || language > Language::Korean || path_.empty())
        return false;
    try {
        PreferenceLock lock(path_.parent_path()/"language.lock");
        auto value = readSettings(path_);
        value["language"] = languages[size_t(language)].code;
        std::filesystem::create_directories(path_.parent_path());
        AtomicFile destination(path_);
        std::ofstream output(destination.path(), std::ios::binary | std::ios::trunc);
        output.exceptions(std::ios::failbit | std::ios::badbit);
        output << value.dump(2) << '\n';
        output.close();
        destination.commit();
        selected_ = language;
        refreshSystemLanguage();
        return true;
    } catch (...) {
        return false;
    }
}
LanguagePreferences &languagePreferences() {
    static LanguagePreferences preference;
    return preference;
}
const char *translate(Language language, const char *english) noexcept {
    if (!english || language <= Language::English || language > Language::Korean)
        return english;
    // Lookup stores only views into the compiled, immutable catalog.
    try {
        static const auto lookup = [] {
            std::unordered_map<std::string_view, const Translation *> result;
            result.reserve(std::size(catalog));
            for (const auto &entry : catalog)
                result.emplace(entry.text[0], &entry);
            return result;
        }();
        if (const auto it = lookup.find(english); it != lookup.end())
            return it->second->text[size_t(language) - 1];
    } catch (...) {
    }
    return english;
}
const char *tr(const char *english) noexcept {
    const auto language =
        activeLanguage == Language::System ? languagePreferences().effective() : activeLanguage;
    return translate(language, english);
}
std::wstring trWide(const char *english) {
    return widen(tr(english));
}
std::string uiLabel(const char *english) {
    if (!english || std::string_view(english).starts_with("##"))
        return english ? english : "";
    const std::string_view source(english);
    const auto marker = source.find("##");
    const std::string visible(source.substr(0, marker));
    const char *translated = tr(visible.c_str());
    const auto identity = source.find("###");
    return std::string(translated) + "###" +
           std::string(identity == std::string_view::npos ? source : source.substr(identity + 3));
}
LanguageScope::LanguageScope(Language language) noexcept : previous_(activeLanguage) {
    activeLanguage = language;
}
LanguageScope::~LanguageScope() {
    activeLanguage = previous_;
}
} // namespace preview
