#include "resource_budget.hpp"
#include "scene_storage.hpp"
#include <algorithm>
#include <map>
#include <mutex>
#include <string>
#include <utility>

namespace preview {
namespace detail {
struct ResourceBudgetState {
    struct SharedCharge { ResourceCategory category; std::size_t bytes, holders; };
    explicit ResourceBudgetState(ResourceLimits policy) : limits(policy) {}
    const ResourceLimits limits;
    std::mutex mutex;
    ResourceUsage usage;
    std::map<std::shared_ptr<const unsigned char>, SharedCharge,
             std::owner_less<std::shared_ptr<const unsigned char>>> shared;
};
} // namespace detail
namespace {
std::size_t index(ResourceCategory category) {
    const auto value = std::size_t(category);
    if (value >= resourceCategoryCount)
        throw std::invalid_argument("Invalid resource category");
    return value;
}
void admit(const detail::ResourceBudgetState &state, std::size_t category, std::size_t bytes) {
    const auto available = std::min(state.limits.totalBytes - state.usage.totalBytes,
                                    state.limits.categoryBytes[category] - state.usage.categoryBytes[category]);
    if (bytes > available)
        throw ResourceBudgetExceeded(bytes, available);
}
void charge(detail::ResourceBudgetState &state, std::size_t category, std::size_t bytes) {
    state.usage.totalBytes += bytes;
    state.usage.categoryBytes[category] += bytes;
    state.usage.peakBytes = std::max(state.usage.peakBytes, state.usage.totalBytes);
}
void uncharge(detail::ResourceBudgetState &state, ResourceCategory category, std::size_t bytes) noexcept {
    state.usage.totalBytes -= bytes;
    state.usage.categoryBytes[std::size_t(category)] -= bytes;
}
} // namespace
ResourceBudgetExceeded::ResourceBudgetExceeded(std::size_t requested, std::size_t available)
    : std::runtime_error("Resource byte limit exceeded: requested " + std::to_string(requested) +
                         ", available " + std::to_string(available)),
      requested_(requested), available_(available) {}
AllocationIdentity AllocationIdentity::create() {
    AllocationIdentity identity;
    identity.token_ = std::make_shared<const unsigned char>(static_cast<unsigned char>(0));
    return identity;
}
ResourceBudget::ResourceBudget(std::size_t byteLimit) : ResourceBudget(ResourceLimits{byteLimit}) {}
ResourceBudget::ResourceBudget(ResourceLimits limits)
    : state_(std::make_shared<detail::ResourceBudgetState>(limits)) {}
ResourceReservation ResourceBudget::reserve(ResourceCategory category, std::size_t bytes,
                                             AllocationIdentity identity) const {
    if (!state_)
        throw std::logic_error("Resource budget handle was moved");
    const auto slot = index(category);
    std::lock_guard lock(state_->mutex);
    if (identity) {
        const auto found = state_->shared.find(identity.token_);
        if (found != state_->shared.end()) {
            if (found->second.bytes != bytes || found->second.category != category)
                throw ResourceIdentityConflict("Shared allocation identity has a conflicting byte estimate or category");
            if (found->second.holders == std::numeric_limits<std::size_t>::max())
                throw std::overflow_error("Shared allocation reservation count overflows");
            ++found->second.holders;
            return ResourceReservation(state_, category, bytes, std::move(identity));
        }
    }
    admit(*state_, slot, bytes);
    // Bookkeeping insertion happens before updating counters, so allocation
    // failure cannot leave charged bytes without a returned reservation.
    if (identity)
        state_->shared.emplace(identity.token_, detail::ResourceBudgetState::SharedCharge{category, bytes, 1});
    charge(*state_, slot, bytes);
    return ResourceReservation(state_, category, bytes, std::move(identity));
}
ResourceUsage ResourceBudget::usage() const {
    if (!state_)
        throw std::logic_error("Resource budget handle was moved");
    std::lock_guard lock(state_->mutex);
    return state_->usage;
}
ResourceLimits ResourceBudget::limits() const {
    if (!state_)
        throw std::logic_error("Resource budget handle was moved");
    return state_->limits;
}
bool ResourceBudget::sharesLedger(const ResourceBudget &other) const noexcept {
    return state_ && state_ == other.state_;
}
ResourceReservation::ResourceReservation(std::shared_ptr<detail::ResourceBudgetState> state,
                                         ResourceCategory category, std::size_t bytes,
                                         AllocationIdentity identity) noexcept
    : state_(std::move(state)), identity_(std::move(identity)), category_(category), bytes_(bytes) {}
ResourceReservation::~ResourceReservation() { release(); }
ResourceReservation::ResourceReservation(ResourceReservation &&other) noexcept
    : state_(std::move(other.state_)), identity_(std::move(other.identity_)),
      category_(std::exchange(other.category_, ResourceCategory::Count)), bytes_(std::exchange(other.bytes_, 0)) {}
ResourceReservation &ResourceReservation::operator=(ResourceReservation &&other) noexcept {
    if (this != &other) {
        release();
        state_ = std::move(other.state_);
        identity_ = std::move(other.identity_);
        category_ = std::exchange(other.category_, ResourceCategory::Count);
        bytes_ = std::exchange(other.bytes_, 0);
    }
    return *this;
}
void ResourceReservation::shrink(std::size_t bytes) {
    if (bytes > bytes_)
        throw std::invalid_argument("Resource reservation shrink cannot grow storage");
    if (!state_ || bytes == bytes_)
        return;
    std::lock_guard lock(state_->mutex);
    if (identity_) {
        auto &entry = state_->shared.at(identity_.token_);
        if (entry.holders != 1)
            throw ResourceIdentityConflict("Shared allocation cannot shrink while another holder retains its estimate");
        entry.bytes = bytes;
    }
    uncharge(*state_, category_, bytes_ - bytes);
    bytes_ = bytes;
}
void ResourceReservation::release() noexcept {
    if (!state_)
        return;
    {
        std::lock_guard lock(state_->mutex);
        if (identity_) {
            const auto found = state_->shared.find(identity_.token_);
            if (--found->second.holders == 0) {
                uncharge(*state_, found->second.category, found->second.bytes);
                state_->shared.erase(found);
            }
        } else
            uncharge(*state_, category_, bytes_);
    }
    identity_ = {};
    state_.reset();
    category_ = ResourceCategory::Count;
    bytes_ = 0;
}
std::size_t checkedByteProduct(std::size_t count, std::size_t stride) {
    if (stride && count > std::numeric_limits<std::size_t>::max() / stride)
        throw std::overflow_error("Resource byte product overflows");
    return count * stride;
}
std::size_t checkedByteSum(std::span<const std::size_t> values) {
    std::size_t total = 0;
    for (const auto value : values) {
        if (value > std::numeric_limits<std::size_t>::max() - total)
            throw std::overflow_error("Resource byte sum overflows");
        total += value;
    }
    return total;
}
std::size_t checkedByteSum(std::initializer_list<std::size_t> values) {
    return checkedByteSum(std::span<const std::size_t>(values.begin(), values.size()));
}
std::size_t imagePayloadBytes(unsigned width, unsigned height, std::size_t bufferCount) {
    if (!width || !height || !bufferCount)
        throw std::invalid_argument("Image byte estimate needs nonzero dimensions and buffer count");
    return checkedByteProduct(checkedByteProduct(checkedByteProduct(width, height), 4), bufferCount);
}
std::size_t scenePayloadBytes(const Scene &scene) {
    return checkedByteSum({sizeof(Scene),
        checkedByteProduct(scene.gaussians.capacity(), sizeof(Gaussian)),
        checkedByteProduct(scene.vertices.capacity(), sizeof(PreviewVertex)),
        checkedByteProduct(scene.triangles.capacity(), sizeof(std::array<uint32_t, 3>)),
        checkedByteSum({scene.format.capacity(), 1}),
        checkedByteSum({scene.sourceContentKey.capacity(), 1}),
        checkedByteSum({scene.sourceFileIdentity.capacity(), 1})});
}
namespace {
class BudgetSceneMemory final : public SceneMemory {
  public:
    BudgetSceneMemory(ResourceBudget budget, ResourceCategory category)
        : budget_(std::move(budget)), category_(category) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        // If allocating the grant's control block fails, the temporary
        // reservation releases its charge before this call propagates.
        return std::make_shared<ResourceReservation>(budget_.reserve(category_, bytes));
    }
    bool sharesLedger(const ResourceBudget &budget) const noexcept {
        return budget_.sharesLedger(budget);
    }
  private:
    ResourceBudget budget_;
    ResourceCategory category_;
};
template<class Vector>
std::size_t accountedVectorBytes(const Vector &storage, const ResourceBudget &budget) {
    const auto *service = dynamic_cast<const BudgetSceneMemory *>(storage.get_allocator().memory().get());
    if (!service || !service->sharesLedger(budget))
        return 0;
    return checkedByteProduct(storage.capacity(), sizeof(typename Vector::value_type));
}
} // namespace
std::shared_ptr<SceneMemory> sceneMemoryForBudget(ResourceBudget budget, ResourceCategory category) {
    index(category); // Reject an invalid category before publishing a service.
    return std::make_shared<BudgetSceneMemory>(std::move(budget), category);
}
bool sceneMemorySharesLedger(const std::shared_ptr<SceneMemory> &memory, const ResourceBudget &budget) noexcept {
    const auto *service = dynamic_cast<const BudgetSceneMemory *>(memory.get());
    return service && service->sharesLedger(budget);
}
std::size_t accountedSceneStorageBytes(const Scene &scene, const ResourceBudget &budget) {
    return checkedByteSum({accountedVectorBytes(scene.gaussians, budget),
                           accountedVectorBytes(scene.vertices, budget),
                           accountedVectorBytes(scene.triangles, budget)});
}
} // namespace preview
