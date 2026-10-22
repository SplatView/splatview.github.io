#pragma once
#include <filesystem>

namespace preview {
class AtomicFile {
  public:
    explicit AtomicFile(const std::filesystem::path &);
    ~AtomicFile();
    AtomicFile(const AtomicFile &) = delete;
    AtomicFile &operator=(const AtomicFile &) = delete;
    const std::filesystem::path &path() const { return temporary_; }
    void commit();
  private:
    std::filesystem::path destination_, temporary_;
};
} // namespace preview
