// Private nonshipping proof for the admitted browser Range helper. The oracle
// uses literal boundaries and operation truth tables independently of bindings.
#include "browser_selection_range.hpp"
#include "editing.hpp"
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <stdexcept>
#include <type_traits>
#include <utility>

namespace {
using namespace preview;namespace sr=browser_selection_range;
size_t groups{},checks{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void test(const char *name,F action){action();++groups;std::printf("SELECTION_RANGE_PREDICATE_GROUP_PASS %s\n",name);}
Gaussian gaussian(Vec3 point,float opacity=1){Gaussian out;out.positionOpacity={point.x,point.y,point.z,opacity};return out;}
void configurations(){
    sr::Config disabled;require(sr::valid(disabled)&&!disabled.radius,"Disabled legacy null config is invalid");
    auto enabled=disabled;enabled.enabled=true;require(!sr::valid(enabled),"Enabled centerless config was admitted");
    require(!sr::contains(enabled,gaussian({0,0,0})),"Enabled centerless predicate did not fail closed");
    enabled.center=Vec3{1,-2,3};require(!sr::valid(enabled),"Enabled null radius was admitted");enabled.radius=1;require(sr::valid(enabled),"Finite frozen center was refused");
    for(float radius:{0.f,-1.f,std::numeric_limits<float>::infinity(),-std::numeric_limits<float>::infinity(),std::numeric_limits<float>::quiet_NaN()})
        for(bool active:{false,true}){auto bad=enabled;bad.radius=radius;bad.enabled=active;require(!sr::valid(bad),"Nonpositive/nonfinite configured radius was admitted");}
    for(unsigned axis=0;axis<3;++axis)for(bool active:{false,true}) {
        auto bad=enabled;bad.enabled=active;auto p=*bad.center;
        if(axis==0)p.x=std::numeric_limits<float>::quiet_NaN();else if(axis==1)p.y=std::numeric_limits<float>::infinity();else p.z=-std::numeric_limits<float>::infinity();
        bad.center=p;require(!sr::valid(bad),"Nonfinite frozen center was admitted");
    }
    for(float radius:{std::numeric_limits<float>::denorm_min(),.4f,1e12f,std::numeric_limits<float>::max()}) {
        auto value=enabled;value.radius=radius;require(sr::valid(value),"Positive finite float32 radius was refused");
    }
    auto copy=enabled;auto moved=std::move(copy);require(moved==enabled,"Fixed config copy/move changed its frozen values");
    static_assert(noexcept(sr::valid(std::declval<const sr::Config &>())));
    static_assert(noexcept(sr::contains(std::declval<const sr::Config &>(),std::declval<const Gaussian &>())));
    static_assert(noexcept(sr::combineState(0,false,std::declval<const Gaussian &>(),std::declval<const sr::Config &>(),SelectOperation::Set)));
}
void boundariesAndCenterOnly(){
    sr::Config config{true,.4f,Vec3{0,0,0}};
    require(sr::contains(config,gaussian({.4f,0,0})),"Rounded nonbinary radius boundary was excluded");
    require(!sr::contains(config,gaussian({std::nextafter(.4f,1.f),0,0})),"First outside float32 radius point was included");
    config.radius=5;require(sr::contains(config,gaussian({3,4,0})),"Exact 3-4-5 squared boundary was excluded");
    require(!sr::contains(config,gaussian({3,std::nextafter(4.f,5.f),0})),"Outside 3-4-5 point was included");
    config={true,1,Vec3{-3,2,-1}};
    require(sr::contains(config,gaussian({-3,2,-1}))&&sr::contains(config,gaussian({-4,2,-1})),"Frozen asymmetric center was ignored");
    require(!sr::contains(config,gaussian({-1,2,-1})),"Outside asymmetric center was included");
    auto large=gaussian({-1,2,-1});large.covA={1e30f,0,0,1e30f};large.covB={0,1e30f,0,0};
    require(!sr::contains(config,large),"Covariance enlarged a center-only Range sphere");
    auto transparent=gaussian({-3,2,-1},0);transparent.sh.fill(0xffffffffu);
    require(sr::contains(config,transparent),"Opacity or SH changed the geometric center predicate");
    config.radius=std::numeric_limits<float>::denorm_min();config.center=Vec3{};
    require(sr::contains(config,gaussian({0,0,0}))&&sr::contains(config,gaussian({*config.radius,0,0})),"Rounded subnormal boundary changed desktop behavior");
    config.radius=std::numeric_limits<float>::max();
    require(!sr::contains(config,gaussian({1e20f,0,0})),"Nonfinite rounded distance was included against infinite rounded threshold");
    config.center=Vec3{-std::numeric_limits<float>::max(),0,0};
    require(!sr::contains(config,gaussian({std::numeric_limits<float>::max(),0,0})),"Huge finite delta overflowed the safe distance policy");
    config.center=Vec3{};const auto nan=std::numeric_limits<float>::quiet_NaN(),inf=std::numeric_limits<float>::infinity();
    require(!sr::contains(config,gaussian({nan,0,0}))&&!sr::contains(config,gaussian({0,inf,0})),"Enabled Range included a nonfinite position");
    config.enabled=false;require(sr::contains(config,gaussian({nan,inf,0})),"Disabled Range changed ordinary hit semantics");
}
void rangeBeforeCombine(){
    // Independent boolean truth tables indexed by before*2+inside.
    constexpr std::array<std::array<uint8_t,4>,4> table{{{{0,1,0,1}},{{0,1,1,1}},{{0,0,1,0}},{{0,0,0,1}}}};
    for(unsigned operation=0;operation<4;++operation)for(uint8_t before:{uint8_t(0),uint8_t(1)})
        for(bool region:{false,true})for(bool geometricInside:{false,true})for(bool enabled:{false,true}) {
            const sr::Config config{enabled,1,Vec3{0,0,0}};const auto g=gaussian({geometricInside?.5f:2.f,0,0});
            const bool inside=region&&(!enabled||geometricInside);const auto expected=table[operation][size_t(before)*2+unsigned(inside)];
            require(sr::combineState(before,region,g,config,static_cast<SelectOperation>(operation))==expected,"Range-before-Combine differs from independent truth table");
        }
    const sr::Config config{true,1,Vec3{0,0,0}};const auto outside=gaussian({2,0,0});
    require(sr::combineState(1,true,outside,config,SelectOperation::Add)==1,"Add cleared baseline selection outside Range");
    require(sr::combineState(1,true,outside,config,SelectOperation::Remove)==1,"Remove cleared baseline selection outside Range");
    require(sr::combineState(1,true,outside,config,SelectOperation::Set)==0,"Set retained selection outside Range");
    require(sr::combineState(1,true,outside,config,SelectOperation::Intersect)==0,"Intersect retained selection outside Range");
    for(unsigned operation=0;operation<4;++operation)for(bool hit:{false,true}) {
        require(sr::combineState(2,hit,outside,config,static_cast<SelectOperation>(operation))==2,"Deleted baseline byte changed");
        require(sr::combineState(3,hit,outside,config,static_cast<SelectOperation>(operation))==3,"Combined deleted byte was normalized or selected");
    }
    // Current-view scope remains the caller's final responsibility: Add outside
    // Range retains before; that selected result is cleared outside the view.
    const bool eligible=false;const auto result=sr::combineState(1,true,outside,config,SelectOperation::Add);
    require((eligible?result:uint8_t(result&2))==0,"Caller final current-view clipping example retained selection");
}
void frozenAndBounded(){
    const sr::Config first{true,1,Vec3{0,0,0}};auto amended=first;amended.radius=2;
    const auto hit=gaussian({1.5f,0,0});require(!sr::contains(first,hit)&&sr::contains(amended,hit),"Radius amendment changed the original config or ignored its captured center");
    require(first.center==amended.center&&first.radius==1,"Config amendment changed its frozen center or original radius");
    require(sizeof(sr::Config)<=32,"Range config retained variable-size metadata");
    const auto before=first;
    require(sr::combineState(1,true,hit,first,SelectOperation::Add)==1&&first==before,"Predicate mutated frozen config");
}
}
int main(){try{
    test("configured-positive-radius-frozen-center",configurations);
    test("rounded-boundaries-finite-center-only",boundariesAndCenterOnly);
    test("region-range-combine-deleted-view",rangeBeforeCombine);
    test("frozen-amendment-fixed-owner",frozenAndBounded);
    std::printf("SPLATVIEW_SELECTION_RANGE_PREDICATE_CONTRACTS_PASS groups=%zu checks=%zu configBytes=%zu\n",groups,checks,sizeof(sr::Config));return 0;
}catch(const std::exception &error){std::fprintf(stderr,"Selection Range predicate contracts failed groups=%zu checks=%zu: %s\n",groups,checks,error.what());return 1;}}
