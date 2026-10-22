#pragma once
#include "camera.hpp"
#include "mask_storage.hpp"
#include <array>
#include <cstdint>
#include <memory>
#include <optional>

namespace preview::browser_checkpoint { struct Access; }

namespace preview::browser_alignment {
inline constexpr uint64_t maximumIdentity=9007199254740991ULL;
struct Context {
    std::shared_ptr<const Scene> scene;
    MaskStorage states;
    uint64_t document{},revision{},contentRevision{};
    bool settled{};
};
bool validContext(const Context &) noexcept;
bool sameContext(const Context &,const Context &) noexcept;
// The pinned Scene has no alignment revision field. Weak scene associations
// preserve it through immutable copies without extending the frozen layout.
// Expired work/abandoned history consumes no slot; retained owners are never
// evicted. A full table refuses before publication rather than losing lineage.
class Lineage final {
    friend struct preview::browser_checkpoint::Access;
    struct Entry { std::weak_ptr<const Scene> scene;uint64_t branch{}; };
  public:
    uint64_t branch(const std::shared_ptr<const Scene> &) const noexcept;
    bool associate(const std::shared_ptr<const Scene> &,uint64_t) noexcept;
    bool inherit(const std::shared_ptr<const Scene> &copy,const std::shared_ptr<const Scene> &source) noexcept;
    void prune() noexcept;
    void clear() noexcept;
    static constexpr size_t capacity=64;
  private:
    std::array<Entry,capacity> entries_{};
};
class IdSequence final {
    friend struct preview::browser_checkpoint::Access;
  public:
    explicit IdSequence(uint64_t first=1) noexcept:next_(first) {}
    std::optional<uint64_t> take() noexcept;
  private:
    uint64_t next_; // Lifetime global: transactions and opens never rewind it.
};
class Session final {
    friend struct preview::browser_checkpoint::Access;
  public:
    // Stage a copy of this metadata before admission/history work. Beginning a
    // new operation after stale owners/revisions starts a fresh exact baseline.
    bool begin(const Context &) noexcept;
    bool acknowledge(const Context &before,const Context &after) noexcept;
    bool current(const Context &) const noexcept;
    bool canReset(const Context &) const noexcept;
    std::shared_ptr<const Scene> baseline() const noexcept { return base_; }
    const MaskStorage &baselineStates() const noexcept { return states_; }
    void retireStale(const Context &) noexcept;
    void clear() noexcept;
  private:
    std::shared_ptr<const Scene> base_;
    MaskStorage states_;
    Context acknowledged_;
};
Matrix4 inverseFrame(const Matrix4 &);
Matrix4 centeredFrame(const Matrix4 &,Vec3 point);
void validateCamera(const Camera &,float aspect);
Camera translatedCamera(const Camera &,Vec3 delta,float aspect);
Camera carriedCamera(const Camera &,const Matrix4 &before,const Matrix4 &after,float aspect);
Vec3 planeNormal(const std::array<Vec3,3> &);
void validateSceneCamera(const Scene &,float aspect);
} // namespace preview::browser_alignment
