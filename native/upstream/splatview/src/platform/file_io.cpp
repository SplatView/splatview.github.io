#include "file_io.hpp"
#include <picosha2.h>
#include <algorithm>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <utility>
#ifdef _WIN32
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace preview {
namespace {
void cancelled(std::stop_token stop) {
    if (stop.stop_requested()) throw std::runtime_error("Loading canceled");
}
void appendUtf8(std::string &out, uint32_t cp) {
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw std::runtime_error("Invalid Unicode text");
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xc0 | (cp >> 6)); out += char(0x80 | (cp & 63)); }
    else if (cp < 0x10000) {
        out += char(0xe0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 63)); out += char(0x80 | (cp & 63));
    } else {
        out += char(0xf0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 63));
        out += char(0x80 | ((cp >> 6) & 63)); out += char(0x80 | (cp & 63));
    }
}
#ifdef _WIN32
struct FileHandle {
    HANDLE value{INVALID_HANDLE_VALUE};
    ~FileHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
std::string platformIdentity(HANDLE file) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(file, &info)) throw std::runtime_error("Cannot identify source file");
    return std::to_string(info.dwVolumeSerialNumber) + ":" + std::to_string(info.nFileIndexHigh) + ":" +
        std::to_string(info.nFileIndexLow) + ":" + std::to_string(info.ftCreationTime.dwHighDateTime) + ":" +
        std::to_string(info.ftCreationTime.dwLowDateTime);
}
#else
struct FileHandle { int value{-1}; ~FileHandle() { if (value >= 0) close(value); } };
std::string platformIdentity(const struct stat &info) {
    std::string result = std::to_string(info.st_dev) + ":" + std::to_string(info.st_ino);
#ifdef __APPLE__
    result += ":" + std::to_string(info.st_birthtimespec.tv_sec) + ":" + std::to_string(info.st_birthtimespec.tv_nsec);
#endif
    return result;
}
#endif
} // namespace

std::wstring widen(const std::string &text) {
    std::wstring out;
    for (size_t i = 0; i < text.size();) {
        const auto first = uint8_t(text[i++]);
        uint32_t cp = first;
        unsigned extra = 0;
        uint32_t minimum = 0;
        if (first >= 0xc2 && first <= 0xdf) { cp = first & 31; extra = 1; minimum = 0x80; }
        else if (first >= 0xe0 && first <= 0xef) { cp = first & 15; extra = 2; minimum = 0x800; }
        else if (first >= 0xf0 && first <= 0xf4) { cp = first & 7; extra = 3; minimum = 0x10000; }
        else if (first >= 0x80) throw std::runtime_error("Invalid UTF-8 text");
        if (extra > text.size() - i) throw std::runtime_error("Truncated UTF-8 text");
        for (unsigned j = 0; j < extra; ++j) {
            const auto byte = uint8_t(text[i++]);
            if ((byte & 0xc0) != 0x80) throw std::runtime_error("Invalid UTF-8 text");
            cp = (cp << 6) | (byte & 63);
        }
        if (cp < minimum || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw std::runtime_error("Invalid UTF-8 text");
        if constexpr (sizeof(wchar_t) == 2) {
            if (cp > 0xffff) { cp -= 0x10000; out += wchar_t(0xd800 | (cp >> 10)); out += wchar_t(0xdc00 | (cp & 1023)); }
            else out += wchar_t(cp);
        } else out += wchar_t(cp);
    }
    return out;
}
std::string narrow(const std::wstring &text) {
    std::string out;
    for (size_t i = 0; i < text.size(); ++i) {
        uint32_t cp = uint32_t(text[i]);
        if constexpr (sizeof(wchar_t) == 2) {
            if (cp >= 0xd800 && cp <= 0xdbff) {
                if (++i == text.size() || uint32_t(text[i]) < 0xdc00 || uint32_t(text[i]) > 0xdfff) throw std::runtime_error("Invalid UTF-16 text");
                cp = 0x10000 + ((cp - 0xd800) << 10) + (uint32_t(text[i]) - 0xdc00);
            }
        }
        appendUtf8(out, cp);
    }
    return out;
}
std::filesystem::path pathFromUtf8(std::string_view text) {
    if (text.find('\0') != std::string_view::npos) throw std::runtime_error("A path contains a null character");
#ifdef _WIN32
    return std::filesystem::path(widen(std::string(text)));
#else
    (void)widen(std::string(text));
    return std::filesystem::path(text);
#endif
}
std::string pathUtf8(const std::filesystem::path &path) {
    const auto bytes = path.u8string();
    return {reinterpret_cast<const char *>(bytes.data()), bytes.size()};
}
std::string contentKey(std::span<const uint8_t> data, std::stop_token stop) {
    picosha2::hash256_one_by_one hash;
    while (!data.empty()) {
        cancelled(stop);
        const auto count = std::min<size_t>(65536, data.size());
        hash.process(data.begin(), data.begin() + count);
        data = data.subspan(count);
    }
    cancelled(stop);
    hash.finish();
    return picosha2::get_hash_hex_string(hash);
}
std::filesystem::path platformFilePath(const std::filesystem::path &path) {
#ifdef _WIN32
    const auto absolute=std::filesystem::absolute(path).lexically_normal().wstring();
    if(absolute.starts_with(L"\\\\?\\")) return absolute;
    if(absolute.starts_with(L"\\\\")) return L"\\\\?\\UNC\\"+absolute.substr(2);
    return L"\\\\?\\"+absolute;
#else
    return path;
#endif
}
std::string fileIdentity(const std::filesystem::path &path) {
#ifdef _WIN32
    FileHandle file{CreateFileW(platformFilePath(path).c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                               nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr)};
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot identify source file");
    return platformIdentity(file.value);
#else
    struct stat info{};
    if (stat(path.c_str(), &info) != 0 || !S_ISREG(info.st_mode)) throw std::runtime_error("Cannot identify source file");
    return platformIdentity(info);
#endif
}
FileSnapshot::FileSnapshot(const std::filesystem::path &path, size_t limit, std::stop_token stop,
                           std::optional<ResourceBudget> budget) {
    cancelled(stop);
#ifdef _WIN32
    FileHandle file{CreateFileW(platformFilePath(path).c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_SEQUENTIAL_SCAN, nullptr)};
    if (file.value == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open the selected file");
    LARGE_INTEGER size{};
    if (!GetFileSizeEx(file.value, &size) || size.QuadPart < 0) throw std::runtime_error("Cannot read file size");
    const auto count = uint64_t(size.QuadPart);
    identity_ = platformIdentity(file.value);
#else
    FileHandle file{open(path.c_str(), O_RDONLY | O_CLOEXEC)};
    struct stat before{};
    if (file.value < 0 || fstat(file.value, &before) || !S_ISREG(before.st_mode) || before.st_size < 0) throw std::runtime_error("Cannot open the selected file");
    const auto count = uint64_t(before.st_size);
    identity_ = platformIdentity(before);
#endif
    if (count > limit || count > std::numeric_limits<size_t>::max()) throw std::runtime_error("File exceeds the previewer's memory budget");
    cancelled(stop);
    if (budget) sourceBytes_ = budget->reserve(ResourceCategory::Source, size_t(count));
    size_=size_t(count);
    if(size_) bytes_=std::make_unique_for_overwrite<uint8_t[]>(size_);
    size_t offset = 0;
    while (offset < size_) {
        cancelled(stop);
        const auto block = std::min<size_t>(65536, size_ - offset);
#ifdef _WIN32
        DWORD received{};
        if (!ReadFile(file.value, bytes_.get() + offset, DWORD(block), &received, nullptr) || !received) throw std::runtime_error("Source changed or could not be read");
#else
        const auto received = read(file.value, bytes_.get() + offset, block);
        if (received < 0 && errno == EINTR) continue;
        if (received <= 0) throw std::runtime_error("Source changed or could not be read");
#endif
        offset += size_t(received);
    }
#ifndef _WIN32
    struct stat after{};
    if (fstat(file.value, &after)) throw std::runtime_error("Cannot verify source snapshot");
#ifdef __APPLE__
    const bool changed = before.st_mtimespec.tv_sec != after.st_mtimespec.tv_sec || before.st_mtimespec.tv_nsec != after.st_mtimespec.tv_nsec ||
        before.st_ctimespec.tv_sec != after.st_ctimespec.tv_sec || before.st_ctimespec.tv_nsec != after.st_ctimespec.tv_nsec;
#else
    const bool changed = before.st_mtim.tv_sec != after.st_mtim.tv_sec || before.st_mtim.tv_nsec != after.st_mtim.tv_nsec ||
        before.st_ctim.tv_sec != after.st_ctim.tv_sec || before.st_ctim.tv_nsec != after.st_ctim.tv_nsec;
#endif
    if (before.st_size != after.st_size || changed) throw std::runtime_error("Source changed while loading; reopen it");
#endif
    cancelled(stop);
}
FileSnapshot::FileSnapshot(FileSnapshot &&other) noexcept
    : sourceBytes_(std::move(other.sourceBytes_)),bytes_(std::move(other.bytes_)),
      size_(std::exchange(other.size_,0)),identity_(std::move(other.identity_)) {}
FileSnapshot &FileSnapshot::operator=(FileSnapshot &&other) noexcept {
    if (this != &other) {
        // The temporary keeps the old grant until its old byte array is freed.
        FileSnapshot replacement(std::move(other));
        std::swap(sourceBytes_, replacement.sourceBytes_);
        bytes_.swap(replacement.bytes_);
        std::swap(size_,replacement.size_);
        identity_.swap(replacement.identity_);
    }
    return *this;
}
} // namespace preview
