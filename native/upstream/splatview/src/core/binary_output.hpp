#pragma once
#include <algorithm>
#include <array>
#include <cstring>
#include <ostream>
#include <span>
#include <stdexcept>
#include <type_traits>

namespace preview::detail {
// Batch binary attributes into bounded blocks. Call flush explicitly before
// seeking/closing; a cancelled export discards its unwritten tail.
class BinaryOutput {
  public:
    explicit BinaryOutput(std::ostream &stream) : stream_(stream) {}
    template <class T> void put(const T &value) {
        static_assert(std::is_trivially_copyable_v<T>);
        if (sizeof(T) > buffer_.size() - used_)
            flush();
        static_assert(sizeof(T) <= 65536);
        std::memcpy(buffer_.data() + used_, &value, sizeof(value));
        used_ += sizeof(value);
    }
    void write(std::span<const uint8_t> bytes) {
        while (!bytes.empty()) {
            const auto size = std::min(bytes.size(), buffer_.size() - used_);
            std::memcpy(buffer_.data() + used_, bytes.data(), size);
            used_ += size;
            bytes = bytes.subspan(size);
            if (used_ == buffer_.size())
                flush();
        }
    }
    void flush() {
        stream_.write(reinterpret_cast<const char *>(buffer_.data()), std::streamsize(used_));
        if (!stream_)
            throw std::runtime_error("The scene output could not be written completely");
        used_ = 0;
    }

  private:
    std::ostream &stream_;
    std::array<uint8_t, 65536> buffer_{};
    size_t used_{};
};
} // namespace preview::detail
