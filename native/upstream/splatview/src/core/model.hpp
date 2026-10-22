#pragma once
#include "scene.hpp"
#include "resource_budget.hpp"
#include <filesystem>
#include <span>
#include <stop_token>

namespace preview {
// Compatibility entry point for existing format/host callers. Pure scene,
// camera and geometry users include scene.hpp without loading/path services.
enum class InputFormat { Auto, Splat, Ksplat, Sog, Unsupported };
InputFormat inputFormatForPath(const std::filesystem::path &path);
struct LoadOptions {
    size_t maxSplats{3'000'000};
    size_t maxBytes{1024ull * 1024 * 1024};
    std::stop_token stop{};
    InputFormat format{InputFormat::Auto};
    // Optional shared host ledger for source/output vectors and owned legacy
    // SPZ/ZIP/RGBA scratch. Vendor internals and JSON/native storage are separate.
    std::optional<ResourceBudget> resources{};
    // Decoder context: public entry points bind this from resources. Scene
    // vectors retain the service through return, copies, moves and history.
    std::shared_ptr<SceneMemory> memory{};
};
// Keep filesystem provenance beside the pure Scene. For unpacked SOG the
// member list comes from the exact immutable snapshots consumed by decode;
// rereading metadata afterward could describe a different generation.
struct LoadedScene {
    Scene scene;
    std::vector<std::filesystem::path> sourceMembers;
};
LoadedScene loadSceneWithSources(const std::filesystem::path &, LoadOptions options = {});
Scene loadScene(const std::filesystem::path &file, LoadOptions options = {});
Scene loadScene(std::span<const uint8_t> data, LoadOptions options = {});
std::wstring widen(const std::string &text);
std::string narrow(const std::wstring &text);
} // namespace preview
