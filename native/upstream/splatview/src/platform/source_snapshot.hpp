#pragma once
#include "file_io.hpp"
#include <map>
#include <memory>

namespace preview {
struct SourceStamp {
    std::string contentKey,identity;
    uint64_t bytes{};
    bool operator==(const SourceStamp &) const = default;
};
// Unpacked SOG identity covers meta.json and every declared property texture.
// Keep all member snapshots alive while the decoder reads them.
class SourceSnapshot {
  public:
    SourceSnapshot(const std::filesystem::path &,size_t limit=LoadOptions{}.maxBytes,std::stop_token = {},
                   std::optional<ResourceBudget> = {});
    SourceSnapshot(const SourceSnapshot &) = delete;
    SourceSnapshot &operator=(const SourceSnapshot &) = delete;
    SourceSnapshot(SourceSnapshot &&) noexcept = default;
    SourceSnapshot &operator=(SourceSnapshot &&) noexcept;
    const SourceStamp &stamp() const { return stamp_; }
    std::span<const uint8_t> member(const std::string &) const;
    std::vector<std::filesystem::path> files() const;
  private:
    std::filesystem::path folder_;
    // Texture members share this aggregate grant; metadata owns its own grant.
    // Members are destroyed before this reservation is released.
    ResourceReservation memberBytes_;
    std::map<std::string,std::unique_ptr<FileSnapshot>> members_;
    SourceStamp stamp_;
};
SourceStamp sourceStamp(const std::filesystem::path &,std::stop_token = {},
                        std::optional<ResourceBudget> = {});
// Worker-side input manifest. Unpacked SOG reads only bounded metadata, never
// texture payloads. Keep these paths beside the document, outside pure Scene,
// and recheck physical aliases before writing. This is not a filesystem lease.
std::vector<std::filesystem::path> sourceMemberPaths(const std::filesystem::path &,
                                                   std::stop_token = {},
                                                   std::optional<ResourceBudget> = {});
} // namespace preview
