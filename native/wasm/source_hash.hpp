#pragma once
#include <picosha2.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <type_traits>

namespace preview {
// Browser-owned fixed storage. The frozen hash256_one_by_one implementation
// buffers process() ranges in std::vector, so it cannot meet a no-allocation
// contract. Reuse that implementation's exact frozen compression primitive
// and initial constants, with a fixed 64-byte pending block and guarded state.
// No upstream code, scene/edit owner, protocol identity or callback is changed.
enum class SourceHashStatus : std::uint32_t {
    Ok=0,
    InvalidState=1,
    ExpectedBytesOutOfRange=2,
    OffsetMismatch=3,
    ChunkTooLarge=4,
    NullInput=5,
    InputAddressOverflow=6,
    RangeExceeded=7,
    Incomplete=8,
};
enum class SourceHashState : std::uint8_t { Idle=0, Active=1, Finished=2 };

class SourceHash final {
public:
    using Digest=std::array<std::uint8_t,32>;
    static constexpr std::uint64_t maxExpectedBytes=9'007'199'254'740'991ULL;
    static constexpr std::size_t maxChunkBytes=1024*1024;
    static constexpr std::size_t digestBytes=32;
    static constexpr std::size_t pendingBlockBytes=64;
    static constexpr std::size_t compressionScheduleBytes=64*sizeof(picosha2::word_t);

    SourceHash() noexcept=default;
    SourceHash(const SourceHash &)=delete;
    SourceHash &operator=(const SourceHash &)=delete;
    SourceHash(SourceHash &&)=delete;
    SourceHash &operator=(SourceHash &&)=delete;

    // A valid begin may replace a finished result. Invalid calls preserve the
    // existing finished result or partially consumed candidate byte-for-byte.
    [[nodiscard]] SourceHashStatus begin(std::uint64_t expectedBytes) noexcept {
        if(state_==SourceHashState::Active) return SourceHashStatus::InvalidState;
        if(expectedBytes>maxExpectedBytes) return SourceHashStatus::ExpectedBytesOutOfRange;
        std::copy(picosha2::detail::initial_message_digest,
            picosha2::detail::initial_message_digest+words_.size(),words_.begin());
        pending_.fill(0); digest_.fill(0);
        expected_=expectedBytes; consumed_=0; pendingBytes_=0;
        state_=SourceHashState::Active;
        return SourceHashStatus::Ok;
    }

    // The caller supplies readable borrowed memory for this synchronous call.
    // Wasm heap/allocation and request/resource identity checks belong to the
    // binding/worker. No pointer is retained. Null is valid only for zero bytes.
    [[nodiscard]] SourceHashStatus update(std::uint64_t offset,const std::uint8_t *input,
                                          std::size_t length) noexcept {
        if(state_!=SourceHashState::Active) return SourceHashStatus::InvalidState;
        if(offset!=consumed_) return SourceHashStatus::OffsetMismatch;
        if(length>maxChunkBytes) return SourceHashStatus::ChunkTooLarge;
        // Subtraction prevents offset+length overflow before any input access.
        if(std::uint64_t(length)>expected_-consumed_) return SourceHashStatus::RangeExceeded;
        if(!length) return SourceHashStatus::Ok;
        if(!input) return SourceHashStatus::NullInput;
        const auto address=reinterpret_cast<std::uintptr_t>(input);
        if(std::uintptr_t(length)>std::numeric_limits<std::uintptr_t>::max()-address)
            return SourceHashStatus::InputAddressOverflow;

        const auto accepted=length;
        if(pendingBytes_) {
            const auto take=std::min(length,pendingBlockBytes-std::size_t(pendingBytes_));
            std::memcpy(pending_.data()+pendingBytes_,input,take);
            pendingBytes_=std::uint8_t(std::size_t(pendingBytes_)+take);
            input+=take; length-=take;
            if(pendingBytes_==pendingBlockBytes) {
                compress(pending_.data()); pendingBytes_=0;
            }
        }
        // Complete blocks are compressed directly from borrowed input.
        while(length>=pendingBlockBytes) {
            compress(input); input+=pendingBlockBytes; length-=pendingBlockBytes;
        }
        if(length) {
            std::memcpy(pending_.data(),input,length);
            pendingBytes_=std::uint8_t(length);
        }
        consumed_+=std::uint64_t(accepted);
        return SourceHashStatus::Ok;
    }

    // Publishes exactly one internal 32-byte digest only after complete input.
    // Double finish, finish before begin and truncation leave state unchanged.
    [[nodiscard]] SourceHashStatus finish() noexcept {
        if(state_!=SourceHashState::Active) return SourceHashStatus::InvalidState;
        if(consumed_!=expected_) return SourceHashStatus::Incomplete;
        const auto remaining=std::size_t(pendingBytes_);
        pending_[remaining]=0x80;
        std::fill(pending_.begin()+remaining+1,pending_.end(),std::uint8_t(0));
        if(remaining>55) {
            compress(pending_.data()); pending_.fill(0);
        }
        // JS-safe expected bytes imply <=2^56-8 bits, safely within SHA-256's
        // 64-bit message length field. This cannot overflow after begin guards.
        const auto bits=expected_*std::uint64_t(8);
        for(std::size_t i=0;i<8;++i) pending_[56+i]=std::uint8_t(bits>>(56-8*i));
        compress(pending_.data());
        for(std::size_t word=0;word<words_.size();++word)
            for(std::size_t byte=0;byte<4;++byte)
                digest_[word*4+byte]=std::uint8_t(words_[word]>>(24-8*byte));
        pendingBytes_=0; state_=SourceHashState::Finished;
        return SourceHashStatus::Ok;
    }

    void reset() noexcept {
        words_.fill(0); pending_.fill(0); digest_.fill(0);
        expected_=0; consumed_=0; pendingBytes_=0; state_=SourceHashState::Idle;
    }
    [[nodiscard]] const Digest *digest() const noexcept {
        return state_==SourceHashState::Finished ? &digest_ : nullptr;
    }
    [[nodiscard]] SourceHashState state() const noexcept { return state_; }
    [[nodiscard]] std::uint64_t expectedBytes() const noexcept { return expected_; }
    [[nodiscard]] std::uint64_t consumedBytes() const noexcept { return consumed_; }

private:
    void compress(const std::uint8_t *block) noexcept {
        picosha2::detail::hash256_block(words_.data(),block,block+pendingBlockBytes);
    }
    std::uint64_t expected_{};
    std::uint64_t consumed_{};
    std::array<picosha2::word_t,8> words_{};
    std::array<std::uint8_t,pendingBlockBytes> pending_{};
    Digest digest_{};
    std::uint8_t pendingBytes_{};
    SourceHashState state_{SourceHashState::Idle};
};

static_assert(sizeof(picosha2::word_t)==4 || sizeof(picosha2::word_t)==8);
static_assert(sizeof(SourceHash)<=192,"Source hash storage must remain fixed and small");
static_assert(std::is_trivially_destructible_v<SourceHash>,"Source hash must own no dynamic storage");
static_assert(SourceHash::maxExpectedBytes<=std::numeric_limits<std::uint64_t>::max()/8);
} // namespace preview
