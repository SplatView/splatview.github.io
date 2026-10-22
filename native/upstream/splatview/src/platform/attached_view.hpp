#pragma once
#include "model.hpp"
#include <string_view>
namespace preview {
std::optional<SavedView> readAttachedView(const std::filesystem::path &,std::string_view fingerprint);
void writeAttachedView(const std::filesystem::path &,const SavedView &,std::string_view fingerprint) noexcept;
} // namespace preview
