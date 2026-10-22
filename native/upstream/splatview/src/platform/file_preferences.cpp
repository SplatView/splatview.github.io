#include "file_preferences.hpp"
#include "file_io.hpp"
#include "image_io.hpp"
#include "atomic_file.hpp"
#include "source_snapshot.hpp"
#include "attached_view.hpp"
#include "preference_lock.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <mutex>
#include <stdexcept>
#include <thread>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#endif

namespace preview {
namespace {
std::mutex rootMutex;
std::filesystem::path configuredRoot;
using Json = nlohmann::json;
void check(const SavedView &view) {
    for (float v : {view.target.x, view.target.y, view.target.z, view.yaw, view.pitch, view.distance, view.fieldOfView, view.roll})
        if (!std::isfinite(v) || std::abs(v) > 1e12f) throw std::runtime_error("Invalid default camera");
    if (view.distance <= 0 || view.fieldOfView < 10 || view.fieldOfView > 120 || std::abs(view.pitch) > DirectX::XM_PIDIV2)
        throw std::runtime_error("Invalid default camera");
}
std::filesystem::path sourceFile(const std::filesystem::path &source) {
    return std::filesystem::is_directory(source) ? source / "meta.json" : source;
}
std::string key(const std::string &identity, std::string_view fingerprint) {
    const auto text = identity + "\n" + std::string(fingerprint);
    return contentKey({reinterpret_cast<const uint8_t *>(text.data()), text.size()});
}

} // namespace
std::filesystem::path preferencesRoot() {
    std::lock_guard lock(rootMutex);
    if (!configuredRoot.empty()) return configuredRoot;
    if (const char *overrideRoot = std::getenv("SPLATVIEW_DATA_DIR")) return pathFromUtf8(overrideRoot);
#ifdef _WIN32
    if (const wchar_t *local = _wgetenv(L"LOCALAPPDATA")) return std::filesystem::path(local) / "SplatViewMacPort";
#else
    if (const char *home = std::getenv("HOME")) {
#ifdef __APPLE__
        return pathFromUtf8(home) / "Library/Application Support/SplatView";
#else
        if (const char *xdg = std::getenv("XDG_DATA_HOME")) return pathFromUtf8(xdg) / "SplatView";
        return pathFromUtf8(home) / ".local/share/SplatView";
#endif
    }
#endif
    return std::filesystem::temp_directory_path() / "SplatView";
}
void setPreferencesRoot(std::filesystem::path path) { std::lock_guard lock(rootMutex); configuredRoot = std::move(path); }
std::string encodeSavedView(const SavedView &view) {
    check(view);
    return Json{{"version", 1}, {"target", {view.target.x, view.target.y, view.target.z}}, {"yaw", view.yaw}, {"pitch", view.pitch},
                {"distance", view.distance}, {"fieldOfView", view.fieldOfView}, {"yUp", view.yUp}, {"roll", view.roll}}.dump();
}
SavedView decodeSavedView(std::string_view text) {
    if (text.size() > 65536) throw std::runtime_error("Default camera metadata is too large");
    const auto json = Json::parse(text);
    // Keep existing version-1 port records readable. Windows camera records use
    // snake_case and no version member; accept their camera schema for exchange
    // without treating Windows ADS and macOS preference stores as interchangeable.
    const bool portable = json.contains("version") || json.contains("fieldOfView") || json.contains("yUp");
    const char *fieldOfView = portable ? "fieldOfView" : "field_of_view";
    const char *yUp = portable ? "yUp" : "y_up";
    const auto &target = json.at("target");
    if ((portable && json.at("version") != 1) || !target.is_array() || target.size() != 3 || !json.at(yUp).is_boolean())
        throw std::runtime_error("Unsupported default camera metadata");
    SavedView view{{target.at(0).get<float>(), target.at(1).get<float>(), target.at(2).get<float>()}, json.at("yaw").get<float>(),
                   json.at("pitch").get<float>(), json.at("distance").get<float>(), json.at(fieldOfView).get<float>(), json.at(yUp).get<bool>()};
    view.roll = json.value("roll", 0.f);
    check(view);
    return view;
}
FilePreferences::FilePreferences(std::filesystem::path directory) : directory_(std::move(directory)) {}
std::optional<SavedView> FilePreferences::view(const std::filesystem::path &source, std::string_view fingerprint) const {
    try {
        const auto record = directory_ / (key(fileIdentity(sourceFile(source)), fingerprint) + ".json");
        FileSnapshot snapshot(record, 65536);
        const auto bytes = snapshot.bytes();
        const auto json = Json::parse(bytes);
        if (json.at("contentKey").get<std::string>() != fingerprint) return {};
        return decodeSavedView(json.at("camera").dump());
    } catch (...) { return {}; }
}
std::optional<Image> FilePreferences::thumbnail(const std::filesystem::path &source, std::string_view fingerprint) const {
    return thumbnail(source,fingerprint,{},{});
}
std::optional<Image> FilePreferences::thumbnail(const std::filesystem::path &source, std::string_view fingerprint,
                                              std::stop_token stop, std::optional<ResourceBudget> resources) const {
    try {
        if(stop.stop_requested()) return {};
        const auto stem = key(fileIdentity(sourceFile(source)), fingerprint);
        FileSnapshot record(directory_ / (stem + ".json"), 65536,stop,resources);
        const auto json = Json::parse(record.bytes());
        if (json.at("contentKey").get<std::string>() != fingerprint || !json.contains("thumbnail")) return {};
        // Only locally generated generation names may address the shared container.
        const auto name = json.at("thumbnail").get<std::string>();
        if (!name.starts_with(stem + "-") || name.size() != stem.size() + 1 + 64 + 4 || !name.ends_with(".png") ||
            name.find_first_not_of("0123456789abcdef-.png") != std::string::npos) return {};
        if(!resources && !stop.stop_possible()) return readImage(directory_ / name,1024);
        auto decoded=readImage(directory_ / name,ImageReadOptions{1024,stop,std::move(resources)});
        if(stop.stop_requested()) return {};
        // The independent result inherits the decoder's Image service; both
        // actual allocations remain admitted until this borrowed owner dies.
        return decoded.image();
    } catch (...) { return {}; }
}
void FilePreferences::save(const std::filesystem::path &source, const Scene &loaded, const SavedView &camera,
                           const Image *image, std::stop_token stop, std::optional<ResourceBudget> resources) {
    check(camera);
    const auto snapshot=sourceStamp(source,stop,resources);
    const auto &fingerprint=snapshot.contentKey;
    if (loaded.sourceContentKey.empty() || loaded.sourceFileIdentity.empty() || loaded.sourceContentKey != fingerprint ||
        loaded.sourceFileIdentity != snapshot.identity || loaded.sourceBytes != snapshot.bytes)
        throw std::runtime_error("Source changed since loading; reopen it before updating preferences");
    std::filesystem::create_directories(directory_);
    const auto stem = key(snapshot.identity, fingerprint);
    PreferenceLock lock(directory_ / (stem + ".lock"), stop);
    Json record{{"version", 1}, {"contentKey", fingerprint}, {"camera", Json::parse(encodeSavedView(camera))}};
    if (image) {
        auto square = resources ? squareThumbnail(*image,1024,sceneMemoryForBudget(*resources,ResourceCategory::Image))
                                : squareThumbnail(*image);
        const auto generation = stem + "-" + contentKey(square.bgra, stop) + ".png";
        writePng(square, directory_ / generation);
        record["thumbnail"] = generation;
    } else {
        // A camera-only update retains an existing valid custom thumbnail.
        try {
            FileSnapshot old(directory_ / (stem + ".json"), 65536);
            auto previous = Json::parse(old.bytes());
            if (previous.at("contentKey") == fingerprint && previous.contains("thumbnail")) record["thumbnail"] = previous.at("thumbnail");
        } catch (...) {}
    }
    // Recheck after waiting for the writer lock and generating the image. A
    // same-inode edit must invalidate this save just like an atomic replacement.
    if (stop.stop_requested() || sourceStamp(source,stop,resources)!=snapshot) throw std::runtime_error("Preference update cancelled or source changed");
    AtomicFile output(directory_ / (stem + ".json"));
    std::ofstream stream(output.path(), std::ios::binary);
    stream << record.dump(); stream.close();
    if (!stream) throw std::runtime_error("Cannot write file preferences");
    output.commit();
    writeAttachedView(source,camera,fingerprint);
}
std::optional<SavedView> readDefaultView(const std::filesystem::path &source, std::string_view fingerprint) {
    try {
        std::string actual(fingerprint);
        if (actual.empty()) actual=sourceStamp(source).contentKey;
        auto cached=FilePreferences(preferencesRoot() / "files").view(source, actual);
        return cached ? cached : readAttachedView(source,actual);
    } catch (...) { return {}; }
}
void saveDefaultView(const std::filesystem::path &source, const SavedView &view, std::stop_token stop,
                     std::string_view expected, std::optional<ResourceBudget> resources) {
    const auto snapshot=sourceStamp(source,stop,resources);
    Scene loaded;
    loaded.sourceContentKey = snapshot.contentKey;
    loaded.sourceFileIdentity = snapshot.identity; loaded.sourceBytes = snapshot.bytes;
    if (!expected.empty() && loaded.sourceContentKey != expected) throw std::runtime_error("Source changed since loading");
    FilePreferences(preferencesRoot() / "files").save(source, loaded, view, nullptr, stop,std::move(resources));
}
} // namespace preview
