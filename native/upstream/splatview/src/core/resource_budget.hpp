#pragma once
#include "scene.hpp"
#include <array>
#include <cstddef>
#include <initializer_list>
#include <limits>
#include <memory>
#include <span>
#include <stdexcept>

namespace preview {
class SceneMemory;
// Charge physical payload storage by its purpose, not by every reference to it.
// A retained immutable Scene remains Decoded even when a job/history references
// it; History charges its additional masks/entry metadata. Work is scratch or
// transient copies, Image is image buffers, Render is packets/sort/GPU buffers.
enum class ResourceCategory : std::size_t { Source, Decoded, Work, History, Image, Render, Count };
inline constexpr auto resourceCategoryCount = std::size_t(ResourceCategory::Count);
struct ResourceLimits {
    std::size_t totalBytes{}; // Explicit host policy; zero admits no positive charge.
    std::array<std::size_t, resourceCategoryCount> categoryBytes = [] {
        std::array<std::size_t, resourceCategoryCount> limits{};
        limits.fill(std::numeric_limits<std::size_t>::max());
        return limits;
    }();
};
struct ResourceUsage {
    std::size_t totalBytes{}, peakBytes{};
    std::array<std::size_t, resourceCategoryCount> categoryBytes{};
};
class ResourceBudgetExceeded : public std::runtime_error {
  public:
    ResourceBudgetExceeded(std::size_t requested, std::size_t available);
    std::size_t requestedBytes() const { return requested_; }
    std::size_t availableBytes() const { return available_; }
  private:
    std::size_t requested_, available_;
};
class ResourceIdentityConflict : public std::invalid_argument {
  public:
    explicit ResourceIdentityConflict(const char *message) : std::invalid_argument(message) {}
};
// Create one token per physical shared allocation, then copy the token to its
// owners. The token deliberately does not retain the allocation itself, avoiding
// allocation -> reservation -> allocation cycles or recycled raw-pointer keys.
class AllocationIdentity {
  public:
    AllocationIdentity() = default;
    static AllocationIdentity create();
    explicit operator bool() const { return bool(token_); }
  private:
    friend class ResourceBudget;
    friend class ResourceReservation;
    std::shared_ptr<const unsigned char> token_;
};
namespace detail { struct ResourceBudgetState; }
class ResourceReservation {
  public:
    ResourceReservation() = default;
    ~ResourceReservation();
    ResourceReservation(const ResourceReservation &) = delete;
    ResourceReservation &operator=(const ResourceReservation &) = delete;
    ResourceReservation(ResourceReservation &&) noexcept;
    ResourceReservation &operator=(ResourceReservation &&) noexcept;
    explicit operator bool() const { return bool(state_); }
    // Full allocation estimate, including for a deduplicated shared holder.
    std::size_t bytes() const { return bytes_; }
    ResourceCategory category() const { return category_; }
    void shrink(std::size_t bytes); // Shared storage may shrink only with one holder.
    void release() noexcept;
  private:
    friend class ResourceBudget;
    ResourceReservation(std::shared_ptr<detail::ResourceBudgetState>, ResourceCategory,
                        std::size_t, AllocationIdentity) noexcept;
    std::shared_ptr<detail::ResourceBudgetState> state_;
    AllocationIdentity identity_;
    ResourceCategory category_{ResourceCategory::Count};
    std::size_t bytes_{};
};
// Copying a budget handle shares the same thread-safe ledger. Reservations own
// that ledger, so they safely outlive all budget handles. A reservation is an
// accounting grant: callers acquire it BEFORE allocating and retain it until the
// corresponding storage is destroyed. Rejection never allocates that storage.
// Small bookkeeping/allocator headers and uninstrumented allocations are not
// automatically tracked; this is not a claim of a measured process-memory cap.
class ResourceBudget {
  public:
    explicit ResourceBudget(std::size_t byteLimit);
    explicit ResourceBudget(ResourceLimits);
    ResourceReservation reserve(ResourceCategory, std::size_t bytes, AllocationIdentity = {}) const;
    ResourceUsage usage() const;
    ResourceLimits limits() const;
    // Ledger identity survives copied handles; moved-from handles have none.
    bool sharesLedger(const ResourceBudget &) const noexcept;
  private:
    std::shared_ptr<detail::ResourceBudgetState> state_;
};

std::size_t checkedByteProduct(std::size_t count, std::size_t stride);
std::size_t checkedByteSum(std::span<const std::size_t>);
std::size_t checkedByteSum(std::initializer_list<std::size_t>);
std::size_t imagePayloadBytes(unsigned width, unsigned height, std::size_t bufferCount = 1);
// Capacity-based payload estimate: Scene object, vector capacities and string
// capacities plus terminators. Inline string storage is conservatively counted
// again; allocator/control-block overhead is deliberately not invented here.
std::size_t scenePayloadBytes(const Scene &);
// Bind Scene payload allocations to this ledger without a Scene-layer
// dependency on ResourceBudget. Each actual allocation retains its own grant.
std::shared_ptr<SceneMemory> sceneMemoryForBudget(ResourceBudget,
                                                ResourceCategory = ResourceCategory::Decoded);
// Identify the originating ledger without exposing its concrete service type.
bool sceneMemorySharesLedger(const std::shared_ptr<SceneMemory> &, const ResourceBudget &) noexcept;
// Existing vector capacity already charged to this ledger by that adapter.
// Mixed allocator services are inspected separately; object/string estimates
// and allocations charged to another ledger are deliberately excluded.
std::size_t accountedSceneStorageBytes(const Scene &, const ResourceBudget &);
} // namespace preview
