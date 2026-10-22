#pragma once
#include "model.hpp"
#include "resource_budget.hpp"
#include <memory>
#include <optional>
#include <string_view>

namespace preview {
std::filesystem::path pathFromUtf8(std::string_view);
std::string pathUtf8(const std::filesystem::path &);
std::filesystem::path platformFilePath(const std::filesystem::path &);
std::string contentKey(std::span<const uint8_t>, std::stop_token = {});
std::string fileIdentity(const std::filesystem::path &);
// An owned, bounded snapshot avoids faults when a concurrently opened file is truncated.
class FileSnapshot {
  public:
    FileSnapshot(const std::filesystem::path &, size_t limit, std::stop_token = {},
                 std::optional<ResourceBudget> = {});
    FileSnapshot(const FileSnapshot &) = delete;
    FileSnapshot &operator=(const FileSnapshot &) = delete;
    FileSnapshot(FileSnapshot &&) noexcept;
    FileSnapshot &operator=(FileSnapshot &&) noexcept;
    std::span<const uint8_t> bytes() const { return {bytes_.get(),size_}; }
    const std::string &identity() const { return identity_; }
  private:
    // Declared before the storage so it remains charged through destruction.
    ResourceReservation sourceBytes_;
    std::unique_ptr<uint8_t[]> bytes_;
    size_t size_{};
    std::string identity_;
};
} // namespace preview
