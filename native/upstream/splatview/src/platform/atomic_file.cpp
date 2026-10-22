#include "atomic_file.hpp"
#include "file_io.hpp"
#include <atomic>
#include <random>
#include <stdexcept>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace preview {
AtomicFile::AtomicFile(const std::filesystem::path &destination) : destination_(platformFilePath(destination)) {
    if (destination.empty() || destination.filename().empty()) throw std::runtime_error("Choose an output filename");
    static std::atomic<uint64_t> sequence{};
    std::random_device random;
    for (unsigned attempt = 0; attempt < 32; ++attempt) {
        temporary_ = destination_;
        temporary_ += pathFromUtf8(".splatview-" + std::to_string(random()) + "-" + std::to_string(++sequence) + ".tmp");
#ifdef _WIN32
        HANDLE file = CreateFileW(temporary_.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); return; }
        if (GetLastError() != ERROR_FILE_EXISTS) break;
#else
        int file = open(temporary_.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
        if (file >= 0) { close(file); return; }
        if (errno != EEXIST) break;
#endif
    }
    // Only a successfully reserved temporary path may be removed by the destructor.
    temporary_.clear();
    throw std::runtime_error("Cannot create output file. Check the folder and permissions.");
}
AtomicFile::~AtomicFile() {
    if (!temporary_.empty()) { std::error_code error; std::filesystem::remove(temporary_, error); }
}
void AtomicFile::commit() {
    if (temporary_.empty()) throw std::logic_error("Output was already committed");
#ifdef _WIN32
    if (!MoveFileExW(temporary_.c_str(), destination_.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
        throw std::runtime_error("Cannot replace output file. It may be open in another app.");
#else
    int file = open(temporary_.c_str(), O_RDWR | O_CLOEXEC);
    if (file < 0) throw std::runtime_error("Cannot open output for synchronization");
    const int synced = fsync(file);
    close(file);
    if (synced || rename(temporary_.c_str(), destination_.c_str())) throw std::runtime_error("Cannot replace output file");
#endif
    temporary_.clear();
}
} // namespace preview
