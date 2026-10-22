#pragma once
#include "camera.hpp"
#include <algorithm>

namespace preview {
class SmoothScroll {
  public:
    void queue(const Camera &, bool fly, float ticks);
    bool advance(Camera &, float seconds);
    void cancel() { active_ = false; }
    bool active() const { return active_; }

  private:
    Camera destination_;
    bool active_{}, fly_{};
};
class KeyNavigation {
  public:
    bool key(NavigationKey key, bool down);
    static bool translationKey(NavigationKey key);
    void speed(bool fast, bool slow) { multiplier_ = (fast ? 10.f : 1.f) * (slow ? .1f : 1.f); }
    bool advance(Camera &, bool fly, float seconds);
    bool active() const;
    void cancel();

  private:
    std::array<bool, 11> keys_{};
    std::array<float, 5> velocity_{};
    float multiplier_{1};
};
} // namespace preview
