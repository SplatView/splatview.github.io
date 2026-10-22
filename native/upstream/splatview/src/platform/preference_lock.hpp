#pragma once
#include <filesystem>
#include <memory>
#include <stop_token>
namespace preview {
class PreferenceLock {
  public:
    explicit PreferenceLock(const std::filesystem::path &,std::stop_token = {});
    ~PreferenceLock();
    PreferenceLock(const PreferenceLock &)=delete;
    PreferenceLock &operator=(const PreferenceLock &)=delete;
  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
} // namespace preview
