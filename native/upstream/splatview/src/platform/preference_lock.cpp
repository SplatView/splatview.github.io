#include "preference_lock.hpp"
#include "file_io.hpp"
#include <chrono>
#include <thread>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <sys/file.h>
#include <fcntl.h>
#include <unistd.h>
#endif
namespace preview {
struct PreferenceLock::Impl {
#ifdef _WIN32
    HANDLE file_{INVALID_HANDLE_VALUE};
    OVERLAPPED overlapped_{};
#else
    int file_{-1};
#endif
  public:
    explicit Impl(const std::filesystem::path &path, std::stop_token stop) {
        if(!path.parent_path().empty()) std::filesystem::create_directories(path.parent_path());
#ifdef _WIN32
        file_ = CreateFileW(platformFilePath(path).c_str(), GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file_ == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot lock file preferences");
#else
        file_ = open(path.c_str(), O_RDWR | O_CREAT | O_CLOEXEC, 0600);
        if (file_ < 0) throw std::runtime_error("Cannot lock file preferences");
#endif
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        for (;;) {
#ifdef _WIN32
            if (LockFileEx(file_, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &overlapped_)) return;
#else
            if (!flock(file_, LOCK_EX | LOCK_NB)) return;
#endif
            if (stop.stop_requested() || std::chrono::steady_clock::now() >= deadline) {
#ifdef _WIN32
                CloseHandle(file_); file_ = INVALID_HANDLE_VALUE;
#else
                close(file_); file_ = -1;
#endif
                throw std::runtime_error("File preference update cancelled or busy");
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        }
    }
    ~Impl() {
#ifdef _WIN32
        if (file_ != INVALID_HANDLE_VALUE) { UnlockFileEx(file_, 0, 1, 0, &overlapped_); CloseHandle(file_); }
#else
        if (file_ >= 0) { flock(file_, LOCK_UN); close(file_); }
#endif
    }
};
PreferenceLock::PreferenceLock(const std::filesystem::path &path,std::stop_token stop):impl_(std::make_unique<Impl>(path,stop)) {}
PreferenceLock::~PreferenceLock()=default;
} // namespace preview
