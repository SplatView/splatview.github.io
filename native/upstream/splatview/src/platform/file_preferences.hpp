#pragma once
#include "render_types.hpp"
#include "resource_budget.hpp"
#include <filesystem>
#include <optional>
#include <stop_token>
#include <string_view>

namespace preview {
std::filesystem::path preferencesRoot();
void setPreferencesRoot(std::filesystem::path);
std::string encodeSavedView(const SavedView &);
SavedView decodeSavedView(std::string_view);
std::optional<SavedView> readDefaultView(const std::filesystem::path &, std::string_view verifiedContentKey = {});
void saveDefaultView(const std::filesystem::path &, const SavedView &, std::stop_token = {},
                     std::string_view expectedContentKey = {}, std::optional<ResourceBudget> = {});
class FilePreferences {
  public:
    explicit FilePreferences(std::filesystem::path directory);
    void save(const std::filesystem::path &source, const Scene &loaded, const SavedView &,
              const Image * = nullptr, std::stop_token = {}, std::optional<ResourceBudget> = {});
    std::optional<SavedView> view(const std::filesystem::path &source, std::string_view contentKey) const;
    std::optional<Image> thumbnail(const std::filesystem::path &source, std::string_view contentKey) const;
    std::optional<Image> thumbnail(const std::filesystem::path &source, std::string_view contentKey,
                                   std::stop_token, std::optional<ResourceBudget>) const;
  private:
    std::filesystem::path directory_;
};
} // namespace preview
