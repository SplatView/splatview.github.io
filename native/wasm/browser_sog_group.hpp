#pragma once
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <array>
#include <functional>
#include <span>
#include <string>

namespace preview::browser_sog_group {
inline constexpr size_t maximumResources=40,maximumMetadataBytes=16*1024*1024,
    maximumOriginalBytes=256*1024*1024;
using Read=std::function<std::span<const uint8_t>(const std::string &)>;
// Fixed metadata and borrowed spans only; the synchronous decoder must finish
// before its caller retires the immutable contiguous block.
class Group final {
  public:
    static Group parse(std::span<const uint8_t> block,std::span<const uint8_t> descriptor);
    std::span<const uint8_t> read(const std::string &) const;
    size_t originalBytes() const noexcept { return originalBytes_; }
    size_t resourceCount() const noexcept { return resourceCount_; }
  private:
    std::span<const uint8_t> rewritten_;
    std::array<std::span<const uint8_t>,maximumResources> resources_{};
    size_t originalBytes_{},resourceCount_{};
};
// Called by the checked disposable model wrapper while its sole
// ParsedSogMetadata owner lends the already parsed immutable DOM.
void preflight(const nlohmann::json &,const Read &,const LoadOptions &);
// Defined only by the exact post-JSON-cleanup disposable model overlay.
Scene load(const Read &,LoadOptions,size_t originalBytes);
} // namespace preview::browser_sog_group
