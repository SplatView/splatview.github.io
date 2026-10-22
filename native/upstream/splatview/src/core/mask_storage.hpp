#pragma once
#include "scene_storage.hpp"
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <memory>
#include <span>

namespace preview {
// Immutable sharing of one physical mask. Mutable owners stage a detached
// candidate before their throwing work, then swap and write only at commit.
// Bytes are deliberately not validated here: export masks may combine both
// selected and deleted bits. The consuming scene/edit boundary validates them.
class MaskStorage {
    struct Data {
        explicit Data(std::shared_ptr<SceneMemory> memory)
            : bytes(SceneAllocator<uint8_t>{std::move(memory)}) {}
        SceneVector<uint8_t> bytes;
    };
  public:
    MaskStorage() = default;
    static MaskStorage zero(std::size_t count, std::shared_ptr<SceneMemory> memory = {}) {
        MaskStorage mask;
        mask.data_ = std::make_shared<Data>(std::move(memory));
        mask.data_->bytes.resize(count);
        return mask;
    }
    static MaskStorage copy(std::span<const uint8_t> source, std::shared_ptr<SceneMemory> memory = {}) {
        MaskStorage mask;
        mask.data_ = std::make_shared<Data>(std::move(memory));
        mask.data_->bytes.assign(source.begin(), source.end());
        return mask;
    }
    MaskStorage clone() const { return copy(span(), memory()); }
    // Empty is a sentinel: a unique current allocation needs no copy. Do not
    // install the candidate until all potentially throwing preparation passes.
    MaskStorage copyForWriteIfShared() const { return unique() ? MaskStorage{} : clone(); }
    bool hasStorage() const noexcept { return bool(data_); }
    bool unique() const noexcept { return !data_ || data_.use_count() == 1; }
    std::size_t size() const noexcept { return data_ ? data_->bytes.size() : 0; }
    std::size_t capacity() const noexcept { return data_ ? data_->bytes.capacity() : 0; }
    bool empty() const noexcept { return size() == 0; }
    const uint8_t *data() const noexcept { return data_ ? data_->bytes.data() : nullptr; }
    std::span<const uint8_t> span() const noexcept { return {data(), size()}; }
    operator std::span<const uint8_t>() const noexcept { return span(); }
    auto begin() const noexcept { return span().begin(); }
    auto end() const noexcept { return span().end(); }
    const uint8_t &operator[](std::size_t index) const noexcept { return span()[index]; }
    std::shared_ptr<SceneMemory> memory() const noexcept {
        return data_ ? data_->bytes.get_allocator().memory() : nullptr;
    }
    void clear() noexcept { data_.reset(); }
    void swap(MaskStorage &other) noexcept { data_.swap(other.data_); }
    friend bool operator==(const MaskStorage &left, const MaskStorage &right) noexcept {
        return left.data_ == right.data_ ||
            (left.size() == right.size() && std::equal(left.begin(), left.end(), right.begin()));
    }
  private:
    friend class SceneEdits;
    friend class Document;
    // Only the edit/controller owner may mutate. It has proved uniqueness
    // during staging and retains exclusive owner-thread access through this
    // noexcept commit. Public snapshot consumers receive const bytes only.
    std::span<uint8_t> writableSpan() noexcept {
        assert(unique());
        return data_ ? std::span<uint8_t>(data_->bytes) : std::span<uint8_t>{};
    }
    std::shared_ptr<Data> data_;
};
} // namespace preview
