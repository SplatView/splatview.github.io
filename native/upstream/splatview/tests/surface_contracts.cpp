#include "surface_selection.hpp"
#include "software_renderer.hpp"
#include <cmath>
#include <limits>
#include <stdexcept>

namespace {
void require(bool test,const char *message) { if(!test) throw std::runtime_error(message); }
}
void surfaceContracts() {
    using namespace preview;
    Camera camera; camera.yUp=true; camera.yaw=camera.pitch=0; camera.distance=4;
    SelectionMap map{2,2,{}, {2,20,2,20}, {}};
    auto sample=volumeSampleAt(camera,map,8,8,{3,3},2);
    require(sample && std::abs(sample->center.z-2)<1e-5f,"Surface interpolation does not cross foreground/background discontinuities");
    const float tanHalf=std::tan(DirectX::XMConvertToRadians(45)*.5f);
    require(std::abs(sample->center.x+.25f*tanHalf)<1e-5f && std::abs(sample->center.y-.25f*tanHalf)<1e-5f,
        "Surface unprojection uses pixel centers and top-left coordinates");
    require(std::abs(sample->radius-tanHalf)<1e-5f,"Volume brush keeps a constant screen radius at surface depth");
    map.depths={2,2.04f,2,2.04f}; sample=volumeSampleAt(camera,map,8,8,{3,3},2);
    require(sample && std::abs(sample->center.z-1.985f)<1e-5f,"Low-resolution surface map interpolates smooth depth");
    map.depths[0]=0; require(!volumeSampleAt(camera,map,8,8,{0,0},2),"Background pixels do not borrow a nearby surface");
    map.depths[0]=std::numeric_limits<float>::quiet_NaN(); require(!volumeSampleAt(camera,map,8,8,{0,0},2),"Nonfinite depths are rejected");
    map.depths={5,5,5,5}; camera.yUp=false; camera.yaw=.8f; camera.pitch=-.3f; camera.distance=7; camera.target={3,-2,1};
    sample=volumeSampleAt(camera,map,81,41,{12,17},3);
    require(sample.has_value(),"Rotated camera surface sample");
    auto point=DirectX::XMVectorSet(sample->center.x,sample->center.y,sample->center.z,1);
    DirectX::XMFLOAT3 projected,view;
    DirectX::XMStoreFloat3(&view,DirectX::XMVector3TransformCoord(point,camera.view()));
    DirectX::XMStoreFloat3(&projected,DirectX::XMVector3TransformCoord(point,camera.view()*camera.projection(81.f/41)));
    require(std::abs(view.z+5)<1e-5f && std::abs((projected.x+1)*81*.5f-12.5f)<1e-4f &&
        std::abs((1-projected.y)*41*.5f-17.5f)<1e-4f,"Surface projection round trip supports non-square, flipped-up views");
    camera.yUp=true; camera.yaw=camera.pitch=0; camera.target={}; camera.distance=4;
    map={1,1,{}, {4}, {}};
    const std::array<PointI,2> stroke{{{10,32},{54,32}}};
    const auto samples=volumeStrokeSamples(camera,map,65,65,stroke,2);
    require(samples.size()==23 && samples.front().center.x<0 && samples.back().center.x>0,
        "Sparse pointer events produce a continuous bounded volume stroke");
    for(size_t i=1;i<samples.size();++i) require(samples[i].center.x-samples[i-1].center.x<=samples[i].radius*1.001f,
        "Volume brush samples overlap along the stroke");
    require(!volumeSampleAt(camera,map,0,65,{0,0},2) && !volumeSampleAt(camera,map,65,65,{-1,0},2) &&
        !volumeSampleAt(camera,map,65,65,{65,0},2) && !volumeSampleAt(camera,map,65,65,{0,0},0),"Invalid surface coordinates and radius are rejected");
    std::stop_source cancelled; cancelled.request_stop(); bool rejected=false;
    try { volumeStrokeSamples(camera,map,65,65,stroke,2,cancelled.get_token()); } catch(const std::exception &) { rejected=true; }
    require(rejected,"Volume stroke generation honors cancellation");
    const std::array<PointI,2> enormous{{{0,0},{INT32_MAX,0}}}; rejected=false;
    try { volumeStrokeSamples(camera,map,65,65,enormous,1); } catch(const std::exception &) { rejected=true; }
    require(rejected,"Excessive volume strokes fail rather than silently truncating selection");

    auto scene=std::make_shared<Scene>(); scene->yUp=true;
    Attributes attributes; attributes.scale={.2f,.2f,.2f}; attributes.opacity=.8f;
    scene->gaussians.push_back(packGaussian(attributes)); attributes.position.z=.3f; attributes.opacity=.1f;
    scene->gaussians.push_back(packGaussian(attributes)); fitBounds(*scene);
    SoftwareRenderer renderer; renderer.resize(65,65); renderer.setScene(scene);
    const auto composited=renderer.selectionMap(camera,true,false);
    sample=volumeSampleAt(camera,composited,65,65,{32,32},3);
    require(sample && std::abs(sample->center.x)<1e-6f && std::abs(sample->center.y)<1e-6f &&
        sample->center.z>.02f && sample->center.z<.08f,"Volume anchor uses alpha-weighted surface depth instead of a Gaussian center");
    renderer.resize(4096,4096);
    const auto bounded=renderer.selectionMap(camera,true,true);
    require(bounded.width==512 && bounded.height==512 && bounded.depths.size()==262144 && bounded.visible.size()==1,
        "Surface maps retain the source viewer's bounded memory budget on large displays");
    const auto ids=renderer.selectionMap(camera,false,false);
    require(ids.width==1024 && ids.height==1024 && ids.ids.size()==1048576 && ids.depths.empty(),
        "ID-only maps are bounded separately from surface maps");
}
