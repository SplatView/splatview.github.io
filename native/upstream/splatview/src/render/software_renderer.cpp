#include "software_renderer.hpp"
#include "parallel_for.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace preview {
namespace {
constexpr float background=10.f/255;
struct Bounds { int left,top,right,bottom; };
Bounds bounds(const GaussianPacket &p,unsigned width,unsigned height) {
    const float ex=std::abs(p.axes[0])+std::abs(p.axes[2])+1,ey=std::abs(p.axes[1])+std::abs(p.axes[3])+1;
    return {int(std::clamp(std::floor(p.centerDepth[0]-ex),0.f,float(width))),int(std::clamp(std::floor(p.centerDepth[1]-ey),0.f,float(height))),
            int(std::clamp(std::ceil(p.centerDepth[0]+ex),0.f,float(width))),int(std::clamp(std::ceil(p.centerDepth[1]+ey),0.f,float(height)))};
}
uint8_t byte(float f) { return uint8_t(std::lround(std::clamp(f,0.f,1.f)*255)); }
Image rasterSplats(const RenderFrame &frame,std::stop_token stop,const RenderStorage &storage) {
    Image image{frame.width,frame.height,AdmittedVector<uint8_t>{AdmittedAllocator<uint8_t>{storage.image}}};
    image.bgra.resize(size_t(frame.width)*frame.height*4);
    const unsigned bands=(frame.height+31)/32;
    // Workers own disjoint row bands, so compositing is deterministic and the
    // float scratch buffer stays small even for large captures.
    detail::parallelFor(bands,stop,[&](size_t band) {
        const unsigned first=unsigned(band)*32,last=std::min(frame.height,first+32);
        AdmittedVector<std::array<float,3>> rgb(size_t(last-first)*frame.width,{background,background,background},
                                               AdmittedAllocator<std::array<float,3>>{storage.work});
        for(size_t i=0;i<frame.splats.size();++i) {
            if((i&1023)==0 && stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
            const auto &p=frame.splats[i]; auto b=bounds(p,frame.width,frame.height);
            b.top=std::max(b.top,int(first)); b.bottom=std::min(b.bottom,int(last));
            for(int y=b.top;y<b.bottom;++y) for(int x=b.left;x<b.right;++x) {
                const float alpha=sampleAlpha(p,x+.5f,y+.5f);
                if(!alpha) continue;
                auto &pixel=rgb[size_t(y-first)*frame.width+x];
                for(unsigned c=0;c<3;++c) pixel[c]=p.color[c]*alpha+pixel[c]*(1-alpha);
            }
        }
        for(unsigned y=first;y<last;++y) for(unsigned x=0;x<frame.width;++x) {
            const auto &pixel=rgb[size_t(y-first)*frame.width+x]; const size_t at=(size_t(y)*frame.width+x)*4;
            for(unsigned c=0;c<3;++c) image.bgra[at+c]=byte(pixel[2-c]);
            image.bgra[at+3]=255;
        }
    },1);
    return image;
}
float plane(const GeometryPacket &p,unsigned n) {
    const auto &c=p.clip;
    switch(n) { case 0:return c[0]+c[3]; case 1:return c[3]-c[0]; case 2:return c[1]+c[3];
        case 3:return c[3]-c[1]; case 4:return c[2]; default:return c[3]-c[2]; }
}
AdmittedVector<GeometryPacket> clipped(AdmittedVector<GeometryPacket> polygon,const std::shared_ptr<SceneMemory> &work) {
    for(unsigned n=0;n<6 && !polygon.empty();++n) {
        AdmittedVector<GeometryPacket> out{AdmittedAllocator<GeometryPacket>{work}};
        auto a=polygon.back(); float da=plane(a,n);
        for(const auto &b:polygon) {
            const float db=plane(b,n);
            if((da>=0)!=(db>=0)) {
                const float t=da/(da-db); GeometryPacket q;
                for(unsigned c=0;c<4;++c) {
                    q.clip[c]=a.clip[c]+t*(b.clip[c]-a.clip[c]);
                    q.color[c]=a.color[c]+t*(b.color[c]-a.color[c]);
                    q.world[c]=a.world[c]+t*(b.world[c]-a.world[c]);
                }
                out.push_back(q);
            }
            if(db>=0) out.push_back(b);
            a=b; da=db;
        }
        polygon=std::move(out);
    }
    return polygon;
}
Image rasterGeometry(const RenderFrame &frame,std::stop_token stop,const RenderStorage &storage) {
    Image image{frame.width,frame.height,AdmittedVector<uint8_t>{AdmittedAllocator<uint8_t>{storage.image}}};
    image.bgra.resize(size_t(frame.width)*frame.height*4);
    for(size_t i=0;i<image.bgra.size();i+=4) { image.bgra[i]=image.bgra[i+1]=image.bgra[i+2]=10; image.bgra[i+3]=255; }
    AdmittedVector<float> depths(size_t(frame.width)*frame.height,std::numeric_limits<float>::infinity(),
                                 AdmittedAllocator<float>{storage.work});
    auto screen=[&](const GeometryPacket &p) { return std::array<float,3>{(p.clip[0]/p.clip[3]+1)*frame.width*.5f,(1-p.clip[1]/p.clip[3])*frame.height*.5f,p.clip[2]/p.clip[3]}; };
    auto store=[&](int x,int y,float z,const std::array<float,4> &rgb,float light) {
        const size_t at=size_t(y)*frame.width+x;
        if(z<0 || z>1 || z>=depths[at]) return;
        depths[at]=z;
        for(unsigned c=0;c<3;++c) image.bgra[at*4+c]=byte(rgb[2-c]*light);
    };
    if(frame.type==SceneType::PointCloud) {
        for(size_t i=0;i<frame.vertices.size();++i) {
            if((i&1023)==0 && stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
            const auto &p=frame.vertices[i];
            if(p.clip[3]<=0 || p.clip[2]<0 || p.clip[2]>p.clip[3]) continue;
            auto s=screen(p); if(!std::isfinite(s[0]+s[1]) || s[0]<-2 || s[1]<-2 || s[0]>frame.width+2 || s[1]>frame.height+2) continue;
            for(int y=std::max(0,int(s[1])-2);y<std::min(int(frame.height),int(s[1])+3);++y)
                for(int x=std::max(0,int(s[0])-2);x<std::min(int(frame.width),int(s[0])+3);++x)
                    if(std::hypot(x+.5f-s[0],y+.5f-s[1])<=1.5f) store(x,y,s[2],p.color,1);
        }
    } else {
        for(size_t ti=0;ti<frame.triangles.size();++ti) {
            if((ti&255)==0 && stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
            const auto &t=frame.triangles[ti];
            if(t[0]>=frame.vertices.size() || t[1]>=frame.vertices.size() || t[2]>=frame.vertices.size()) throw std::runtime_error("Invalid mesh index");
            AdmittedVector<GeometryPacket> triangle({frame.vertices[t[0]],frame.vertices[t[1]],frame.vertices[t[2]]},
                                                      AdmittedAllocator<GeometryPacket>{storage.work});
            auto poly=clipped(std::move(triangle),storage.work);
            for(size_t i=2;i<poly.size();++i) {
                const GeometryPacket p[]{poly[0],poly[i-1],poly[i]};
                if(p[0].clip[3]<=0 || p[1].clip[3]<=0 || p[2].clip[3]<=0) continue;
                const std::array<float,3> s[]{screen(p[0]),screen(p[1]),screen(p[2])};
                auto edge=[](const auto &a,const auto &b,float x,float y) { return (b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]); };
                const float area=edge(s[0],s[1],s[2][0],s[2][1]); if(!std::isfinite(area) || std::abs(area)<1e-8f) continue;
                std::array<float,3> u{},v{},normal{};
                for(unsigned c=0;c<3;++c) { u[c]=p[1].world[c]-p[0].world[c]; v[c]=p[2].world[c]-p[0].world[c]; }
                normal={u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]};
                const float length=std::hypot(normal[0],normal[1],normal[2]);
                const float light=length>0 ? .35f+.65f*std::abs((normal[0]*.4f+normal[1]*.7f+normal[2]*.5f)/(length*std::sqrt(.9f))) : 1;
                const int left=int(std::clamp(std::floor(std::min({s[0][0],s[1][0],s[2][0]})),0.f,float(frame.width)));
                const int right=int(std::clamp(std::ceil(std::max({s[0][0],s[1][0],s[2][0]})),0.f,float(frame.width)));
                const int top=int(std::clamp(std::floor(std::min({s[0][1],s[1][1],s[2][1]})),0.f,float(frame.height)));
                const int bottom=int(std::clamp(std::ceil(std::max({s[0][1],s[1][1],s[2][1]})),0.f,float(frame.height)));
                for(int y=top;y<bottom;++y) for(int x=left;x<right;++x) {
                    const float w[]{edge(s[1],s[2],x+.5f,y+.5f)/area,edge(s[2],s[0],x+.5f,y+.5f)/area,edge(s[0],s[1],x+.5f,y+.5f)/area};
                    if(w[0]<-1e-6f || w[1]<-1e-6f || w[2]<-1e-6f) continue;
                    std::array<float,4> rgb{}; float total=0;
                    for(unsigned j=0;j<3;++j) { float weight=w[j]/p[j].clip[3]; total+=weight; for(unsigned c=0;c<3;++c) rgb[c]+=weight*p[j].color[c]; }
                    if(total<=0) continue;
                    for(unsigned c=0;c<3;++c) rgb[c]/=total;
                    store(x,y,w[0]*s[0][2]+w[1]*s[1][2]+w[2]*s[2][2],rgb,light);
                }
            }
        }
    }
    if(stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
    return image;
}
} // namespace
SoftwareRenderer::SoftwareRenderer():SoftwareRenderer(RenderStorage{}) {}
SoftwareRenderer::SoftwareRenderer(RenderStorage storage)
    :storage_(std::move(storage)),states_(AdmittedAllocator<uint8_t>{storage_.work}) {}
void SoftwareRenderer::resize(unsigned w,unsigned h) { if(w!=width_ || h!=height_) { width_=w; height_=h; dirty_=true; } }
void SoftwareRenderer::setScene(std::shared_ptr<const Scene> scene) { if(scene!=scene_) { scene_=std::move(scene); states_.clear(); dirty_=true; } }
void SoftwareRenderer::setStates(std::span<const uint8_t> states) {
    if(std::equal(states.begin(),states.end(),states_.begin(),states_.end())) return;
    // The previous mask/cache remains usable if admission or allocation fails.
    // The old and prospective capacities overlap until this noexcept swap.
    AdmittedVector<uint8_t> next{AdmittedAllocator<uint8_t>{storage_.work}};
    next.assign(states.begin(),states.end());
    states_.swap(next); dirty_=true;
}
void SoftwareRenderer::draw(const Camera &camera,const ViewSettings &settings,std::stop_token stop) {
    draw(camera,settings,stop,storage_.work);
}
void SoftwareRenderer::draw(const Camera &camera,const ViewSettings &settings,std::stop_token stop,
                            std::shared_ptr<SceneMemory> scratch) {
    if(stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
    if(!dirty_ && lastCamera_==camera.savedView() && lastRadius_==camera.radius && lastSettings_==settings) { ++stats_.cacheHits; return; }
    auto storage=storage_; if(scratch) storage.work=std::move(scratch);
    auto frame=prepareFrameWithStorage(scene_,states_,camera,width_,height_,settings,stop,storage);
    auto image=frame.type==SceneType::GaussianSplats ? rasterSplats(frame,stop,storage) : rasterGeometry(frame,stop,storage);
    const auto saved=camera.savedView(); const bool gaussian=scene_->isGaussian();
    if(stop.stop_requested()) throw std::runtime_error("Rendering cancelled");
    // Retain the last completed outputs through all throwing work, including
    // admitted old/new capacity overlap. Publication transfers their allocators.
    static_assert(std::is_nothrow_move_assignable_v<RenderFrame>);
    static_assert(std::is_nothrow_move_assignable_v<Image>);
    frame_=std::move(frame); image_=std::move(image); lastCamera_=saved; lastRadius_=camera.radius; lastSettings_=settings;
    dirty_=false; ++stats_.rasterizations; if(gaussian) ++stats_.depthSorts;
}
std::optional<uint32_t> SoftwareRenderer::pick(const Camera &camera,PointI pixel,std::stop_token stop) {
    if(pixel.x<0 || pixel.y<0 || pixel.x>=int(width_) || pixel.y>=int(height_)) return {};
    const auto frame=prepareFrameWithStorage(scene_,states_,camera,width_,height_,{},stop,storage_);
    float transmission=1, strongest=0; std::optional<uint32_t> id;
    for(auto i=frame.splats.rbegin();i!=frame.splats.rend();++i) {
        if(stop.stop_requested()) throw std::runtime_error("Picking cancelled");
        const float alpha=sampleAlpha(*i,pixel.x+.5f,pixel.y+.5f), contribution=transmission*alpha;
        if(contribution>strongest) { strongest=contribution; id=i->identity[0]-1; }
        transmission*=1-alpha;
        if(transmission<=strongest) break;
    }
    return id;
}
SelectionMap SoftwareRenderer::selectionMap(const Camera &camera,bool surfaceDepth,bool markVisible,std::stop_token stop) {
    return selectionMap(camera,surfaceDepth,markVisible,stop,storage_.work);
}
SelectionMap SoftwareRenderer::selectionMap(const Camera &camera,bool surfaceDepth,bool markVisible,std::stop_token stop,
                                            std::shared_ptr<SceneMemory> scratch) {
    if(stop.stop_requested()) throw std::runtime_error("Selection rendering cancelled");
    if(!width_ || !height_ || width_>8192 || height_>8192) throw std::runtime_error("Invalid selection viewport dimensions");
    const double budget=(surfaceDepth || markVisible)?262144.:1048576.;
    const double scale=std::min(1.,std::sqrt(budget/(double(width_)*height_)));
    const unsigned width=std::max(1u,unsigned(width_*scale)),height=std::max(1u,unsigned(height_*scale));
    auto storage=storage_; if(scratch) storage.work=std::move(scratch);
    const auto &work=storage.work;
    auto frame=prepareFrameWithStorage(scene_,states_,camera,width,height,{},stop,storage);
    if(frame.type!=SceneType::GaussianSplats) throw std::runtime_error("Regular PLY geometry is read only");
    const size_t pixels=size_t(width)*height;
    SelectionMap map{width,height,
                     SceneVector<uint32_t>(pixels,0,SceneAllocator<uint32_t>{work}),
                     SceneVector<float>{SceneAllocator<float>{work}},
                     SceneVector<uint32_t>{SceneAllocator<uint32_t>{work}}};
    SceneVector<float> alpha(pixels,0,SceneAllocator<float>{work}),
                       depth(pixels,0,SceneAllocator<float>{work}),
                       strongest(pixels,0,SceneAllocator<float>{work}),
                       transmission(pixels,1,SceneAllocator<float>{work});
    for(auto p=frame.splats.rbegin();p!=frame.splats.rend();++p) {
        if(stop.stop_requested()) throw std::runtime_error("Selection rendering cancelled");
        const auto b=bounds(*p,width,height);
        for(int y=b.top;y<b.bottom;++y) for(int x=b.left;x<b.right;++x) {
            const auto at=size_t(y)*width+x; const float a=sampleAlpha(*p,x+.5f,y+.5f), contribution=transmission[at]*a;
            if(contribution>strongest[at]) { strongest[at]=contribution; map.ids[at]=p->identity[0]; }
            depth[at]+=p->centerDepth[2]*contribution; alpha[at]+=contribution; transmission[at]*=1-a;
        }
    }
    if(surfaceDepth || markVisible) {
        map.depths.resize(pixels);
        for(size_t i=0;i<pixels;++i) map.depths[i]=alpha[i]>=1.f/255 ? depth[i]/alpha[i] : 0;
    }
    if(markVisible) {
        map.visible.resize((frame.sourceCount+31)/32);
        for(const auto &p:frame.splats) {
            if(stop.stop_requested()) throw std::runtime_error("Visibility rendering cancelled");
            const auto b=bounds(p,width,height); bool visible=false;
            for(int y=b.top;y<b.bottom && !visible;++y) for(int x=b.left;x<b.right;++x) {
                const auto at=size_t(y)*width+x;
                if(sampleAlpha(p,x+.5f,y+.5f)>0 && (map.depths[at]==0 || p.centerDepth[2]<=map.depths[at]+p.centerDepth[3]+p.centerDepth[2]*.005f)) { visible=true; break; }
            }
            if(visible) { const auto id=p.identity[0]-1; map.visible[id/32]|=1u<<(id%32); }
        }
        if(!surfaceDepth) map.depths.clear();
    }
    if(stop.stop_requested()) throw std::runtime_error("Selection rendering cancelled");
    return map;
}
RgbHistogram SoftwareRenderer::histogram() const {
    RgbHistogram result{};
    for(size_t i=0;i<image_.bgra.size();i+=4) for(unsigned c=0;c<3;++c) ++result[c][image_.bgra[i+2-c]];
    return result;
}
ThumbnailRenderer::ThumbnailRenderer(RenderStorage storage):renderer_(std::move(storage)) {}
Image ThumbnailRenderer::render(std::shared_ptr<const Scene> scene,unsigned size,std::stop_token stop) {
    renderer_.setScene(scene); renderer_.resize(size,size); Camera camera; camera.fit(*scene);
    ViewSettings settings; settings.highlightSelection=false; renderer_.draw(camera,settings,stop); return renderer_.readback();
}
} // namespace preview
