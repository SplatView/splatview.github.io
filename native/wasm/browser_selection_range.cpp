// Derived from SplatView1.0.2, commit
// 4e1be155511fb49f08fd8c863d785ac008a4c43a:
// src/selection.cpp computeSpatialDistances and src/editing.cpp's ranged
// combineSelectionResult. This browser adaptation evaluates one current record
// inline rather than retaining the desktop's N-float distance cache.
#include "browser_selection_range.hpp"
#include "editing.hpp"
#include <cmath>

namespace preview::browser_selection_range {
namespace {
bool finite(Vec3 p) noexcept { return std::isfinite(p.x)&&std::isfinite(p.y)&&std::isfinite(p.z); }
}
bool valid(const Config &config) noexcept {
    return (!config.radius||(std::isfinite(*config.radius)&&*config.radius>0))&&
        (!config.center||finite(*config.center))&&(!config.enabled||(config.radius&&config.center));
}
bool contains(const Config &config,const Gaussian &g) noexcept {
    if(!valid(config))return false;
    if(!config.enabled)return true;
    const auto &p=g.positionOpacity;const auto center=*config.center;
    const double x=double(p[0])-center.x,y=double(p[1])-center.y,z=double(p[2])-center.z;
    const float distance=float(x*x+y*y+z*z),threshold=float(double(*config.radius)* *config.radius);
    return std::isfinite(distance)&&distance>=0&&distance<=threshold;
}
uint8_t combineState(uint8_t baseline,bool regionHit,const Gaussian &g,const Config &config,SelectOperation operation) noexcept {
    if(baseline&2)return baseline;
    const bool inside=regionHit&&contains(config,g),before=(baseline&1)!=0;
    switch(operation) {
    case SelectOperation::Set:return uint8_t(inside);
    case SelectOperation::Add:return uint8_t(before||inside);
    case SelectOperation::Remove:return uint8_t(before&&!inside);
    case SelectOperation::Intersect:return uint8_t(before&&inside);
    }
    return 0; // Malformed operations are refused by the caller, never published.
}
} // namespace preview::browser_selection_range
