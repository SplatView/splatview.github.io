#include "renderer_cache_contracts.hpp"
#include "resource_budget.hpp"
#include "software_renderer.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <memory>
#include <mutex>
#include <new>
#include <stdexcept>
#include <stop_token>
#include <utility>
#include <vector>

namespace {
using namespace preview;
constexpr std::size_t allowance=64*1024*1024;
constexpr unsigned width=40,height=24; // One row band; denial order is deterministic.
void require(bool value,const char *message) { if(!value) throw std::runtime_error(message); }
std::size_t categoryBytes(const ResourceBudget &budget,ResourceCategory category) {
    return budget.usage().categoryBytes[std::size_t(category)];
}
bool sameUsage(const ResourceUsage &a,const ResourceUsage &b) {
    return a.totalBytes==b.totalBytes && a.categoryBytes==b.categoryBytes;
}
template<class T,class A,class B> bool sameBytes(const std::vector<T,A> &a,const std::vector<T,B> &b) {
    return a.size()==b.size() && (a.empty() || std::memcmp(a.data(),b.data(),a.size()*sizeof(T))==0);
}
bool sameStats(const RenderStats &a,const RenderStats &b) {
    return a.rasterizations==b.rasterizations && a.depthSorts==b.depthSorts &&
           a.orderUploads==b.orderUploads && a.cacheHits==b.cacheHits;
}
struct Observation {
    struct Request { std::size_t bytes{},liveBefore{}; };
    mutable std::mutex mutex;
    std::vector<Request> requests;
    std::size_t live{},peak{},failAt{},stopAt{};
    std::stop_source *stop{};
    std::vector<Request> recorded() const { std::lock_guard lock(mutex); return requests; }
    void fault(std::size_t fail,std::size_t cancel=0,std::stop_source *source=nullptr) {
        std::lock_guard lock(mutex); failAt=fail; stopAt=cancel; stop=source;
    }
};
struct Grant {
    ResourceReservation reservation;
    std::shared_ptr<Observation> observation;
    std::size_t bytes;
    Grant(ResourceReservation value,std::shared_ptr<Observation> state,std::size_t count)
        :reservation(std::move(value)),observation(std::move(state)),bytes(count) {
        std::lock_guard lock(observation->mutex);
        observation->live+=bytes; observation->peak=std::max(observation->peak,observation->live);
    }
    ~Grant() { std::lock_guard lock(observation->mutex); observation->live-=bytes; }
};
class ObservedMemory final : public SceneMemory {
  public:
    ObservedMemory(ResourceBudget value,ResourceCategory purpose)
        :budget(std::move(value)),category(purpose),observed(std::make_shared<Observation>()) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        std::stop_source *stop=nullptr;
        {
            std::lock_guard lock(observed->mutex);
            observed->requests.push_back({bytes,observed->live});
            const auto ordinal=observed->requests.size();
            if(ordinal==observed->failAt) throw std::bad_alloc();
            if(ordinal==observed->stopAt) stop=observed->stop;
        }
        auto grant=std::make_shared<Grant>(budget.reserve(category,bytes),observed,bytes);
        if(stop) stop->request_stop();
        return grant;
    }
    ResourceBudget budget;
    ResourceCategory category;
    std::shared_ptr<Observation> observed;
};
struct Services {
    ResourceBudget budget{allowance};
    std::shared_ptr<ObservedMemory> packets=std::make_shared<ObservedMemory>(budget,ResourceCategory::Render);
    std::shared_ptr<ObservedMemory> work=std::make_shared<ObservedMemory>(budget,ResourceCategory::Work);
    std::shared_ptr<ObservedMemory> image=std::make_shared<ObservedMemory>(budget,ResourceCategory::Image);
    RenderStorage storage() const { return {packets,work,image}; }
};
Camera camera() {
    Camera result; result.target={}; result.yUp=true; result.yaw=result.pitch=0;
    result.distance=3; result.radius=1; return result;
}
std::shared_ptr<Scene> fixture(bool mesh=false) {
    auto scene=std::make_shared<Scene>();
    if(mesh) {
        scene->type=SceneType::Mesh;
        // The left vertex lies beyond the frustum, forcing polygon clipping.
        scene->vertices={{{-6,-.5f,0},0xff1122dd},{{.6f,-.5f,0},0xff22dd11},{{0,.6f,0},0xffdd1122}};
        scene->triangles={{0,1,2}};
    } else {
        for(unsigned i=0;i<4;++i) {
            Attributes a; a.position={float(int(i)-2)*.16f,float(i%2)*.12f, i==3 ? .2f : 0};
            a.scale={.2f,.12f,.15f}; a.opacity=.45f+float(i)*.1f;
            a.sh[0]=float(i)*.2f-.2f; a.sh[1]=-.2f; a.sh[2]=.3f;
            scene->gaussians.push_back(packGaussian(a));
        }
    }
    return scene;
}
std::vector<uint8_t> maskFor(const Scene &scene) {
    return std::vector<uint8_t>(scene.isGaussian() ? scene.loadedCount() : 0);
}
void initialize(SoftwareRenderer &renderer,const std::shared_ptr<Scene> &scene) {
    renderer.resize(width,height); renderer.setScene(scene); renderer.setStates(maskFor(*scene)); renderer.draw(camera());
}
struct Accepted {
    unsigned imageWidth{},imageHeight{},frameWidth{},frameHeight{};
    SceneType type; std::size_t sourceCount;
    std::vector<uint8_t> pixels;
    std::vector<GaussianPacket> splats;
    std::vector<GeometryPacket> vertices;
    std::vector<std::array<uint32_t,3>> triangles;
    const uint8_t *pixelData; const GaussianPacket *splatData;
    const GeometryPacket *vertexData; const std::array<uint32_t,3> *triangleData;
    RenderStats stats;
    explicit Accepted(const SoftwareRenderer &renderer)
        :imageWidth(renderer.readback().width),imageHeight(renderer.readback().height),
         frameWidth(renderer.frame().width),frameHeight(renderer.frame().height),type(renderer.frame().type),
         sourceCount(renderer.frame().sourceCount),pixels(renderer.readback().bgra.begin(),renderer.readback().bgra.end()),
         splats(renderer.frame().splats.begin(),renderer.frame().splats.end()),
         vertices(renderer.frame().vertices.begin(),renderer.frame().vertices.end()),
         triangles(renderer.frame().triangles.begin(),renderer.frame().triangles.end()),
         pixelData(renderer.readback().bgra.data()),splatData(renderer.frame().splats.data()),
         vertexData(renderer.frame().vertices.data()),triangleData(renderer.frame().triangles.data()),stats(renderer.stats()) {}
    bool values(const SoftwareRenderer &renderer) const {
        const auto &image=renderer.readback(); const auto &frame=renderer.frame();
        return image.width==imageWidth && image.height==imageHeight && frame.width==frameWidth && frame.height==frameHeight &&
            frame.type==type && frame.sourceCount==sourceCount && sameBytes(pixels,image.bgra) &&
            sameBytes(splats,frame.splats) && sameBytes(vertices,frame.vertices) && sameBytes(triangles,frame.triangles);
    }
    bool unchanged(const SoftwareRenderer &renderer) const {
        return values(renderer) && pixelData==renderer.readback().bgra.data() && splatData==renderer.frame().splats.data() &&
            vertexData==renderer.frame().vertices.data() && triangleData==renderer.frame().triangles.data() && sameStats(stats,renderer.stats());
    }
};
void stagedMask() {
    Services services;
    {
        SoftwareRenderer renderer(services.storage()); const auto scene=fixture(); initialize(renderer,scene);
        const Accepted accepted(renderer); const auto before=services.budget.usage();
        auto changed=maskFor(*scene); changed[0]=2; changed[1]=1;
        services.work->observed->fault(services.work->observed->recorded().size()+1);
        bool denied=false;
        try { renderer.setStates(changed); } catch(const std::bad_alloc &) { denied=true; }
        require(denied && accepted.unchanged(renderer) && sameUsage(before,services.budget.usage()),
                "Failed mask staging must preserve accepted buffers, stats and existing grants");
        services.work->observed->fault(0);
        const auto admissions=services.work->observed->recorded().size();
        renderer.draw(camera());
        require(accepted.values(renderer) && renderer.stats().cacheHits==accepted.stats.cacheHits+1 &&
                    services.work->observed->recorded().size()==admissions,
                "A rejected state update must leave the accepted cache reusable");
        renderer.setStates(changed); renderer.draw(camera());
        SoftwareRenderer reference; initialize(reference,scene); reference.setStates(changed); reference.draw(camera());
        require(Accepted(reference).values(renderer),"Retrying the staged mask must preserve deletion and highlighting semantics");
        const auto held=categoryBytes(services.budget,ResourceCategory::Work);
        const Accepted latest(renderer); renderer.setScene(fixture());
        require(latest.unchanged(renderer) && held==categoryBytes(services.budget,ResourceCategory::Work),
                "Scene replacement must keep the accepted cache and retain the cleared mask capacity grant");
    }
    require(services.budget.usage().totalBytes==0,"Destroying a renderer must release masks, pixels and packets");
}
void drawBoundaries(bool mesh) {
    const auto scene=fixture(mesh); auto changed=camera(); changed.roll=.2f;
    SoftwareRenderer reference; initialize(reference,scene); reference.draw(changed); const Accepted expected(reference);
    std::array<std::vector<Observation::Request>,2> requests;
    {
        Services services; SoftwareRenderer renderer(services.storage()); initialize(renderer,scene);
        const std::array<std::shared_ptr<ObservedMemory>,2> owners{services.work,services.image};
        std::array<std::size_t,2> starts{owners[0]->observed->recorded().size(),owners[1]->observed->recorded().size()};
        renderer.draw(changed);
        require(expected.values(renderer),"Admitted rasterization must match the compatibility renderer exactly");
        for(std::size_t family=0;family<owners.size();++family) {
            auto all=owners[family]->observed->recorded(); requests[family].assign(all.begin()+starts[family],all.end());
            require(!requests[family].empty(),"Raster census must observe both Work and Image ownership");
        }
        require(requests[1].size()==1 && requests[1][0].bytes==width*height*4,
                "Each raster must admit the actual BGRA output once");
        if(mesh) {
            require(requests[0].size()>2 && requests[0][0].bytes==width*height*sizeof(float) &&
                        std::any_of(requests[0].begin(),requests[0].end(),[](const auto &r) {
                            return r.bytes==3*sizeof(GeometryPacket) && r.liveBefore>=width*height*sizeof(float);
                        }),"Clipped mesh census must include overlapping depth, triangle and polygon storage");
        } else require(requests[0].size()==1 && requests[0][0].bytes==width*height*3*sizeof(float),
                       "Single-band Gaussian raster must admit its actual RGB workspace");
    }
    for(std::size_t family=0;family<requests.size();++family) for(std::size_t stage=0;stage<requests[family].size();++stage) {
        for(bool cancel:{false,true}) {
            Services services; SoftwareRenderer renderer(services.storage()); initialize(renderer,scene);
            const Accepted accepted(renderer); const auto before=services.budget.usage();
            const auto owner=family==0 ? services.work : services.image;
            const auto start=owner->observed->recorded().size(); std::stop_source stop;
            owner->observed->fault(cancel ? 0 : start+stage+1,cancel ? start+stage+1 : 0,cancel ? &stop : nullptr);
            bool rejected=false;
            try { renderer.draw(changed,{},stop.get_token()); }
            catch(const std::bad_alloc &) { require(!cancel,"Cancellation must not become allocation failure"); rejected=true; }
            catch(const std::runtime_error &) { require(cancel,"Allocation failure must remain distinguishable from cancellation"); rejected=true; }
            const auto recorded=owner->observed->recorded();
            require(rejected && accepted.unchanged(renderer) && sameUsage(before,services.budget.usage()) &&
                        recorded.size()>=start+stage+1 && recorded[start+stage].bytes==requests[family][stage].bytes,
                    "Every raster admission failure or stop must unwind candidate storage and preserve the complete accepted cache");
            owner->observed->fault(0); renderer.draw(changed);
            require(expected.values(renderer),"Retry after raster failure must preserve pixels, packet order and mesh depth");
        }
    }
    Services services; SoftwareRenderer renderer(services.storage()); initialize(renderer,scene);
    const Accepted accepted(renderer); const auto before=services.budget.usage();
    const auto workCount=services.work->observed->recorded().size(),imageCount=services.image->observed->recorded().size();
    const auto packetCount=services.packets->observed->recorded().size();
    std::stop_source stop; stop.request_stop(); bool cancelled=false;
    try { renderer.draw(changed,{},stop.get_token()); } catch(const std::runtime_error &) { cancelled=true; }
    require(cancelled && accepted.unchanged(renderer) && sameUsage(before,services.budget.usage()) &&
                workCount==services.work->observed->recorded().size() && imageCount==services.image->observed->recorded().size() &&
                packetCount==services.packets->observed->recorded().size(),
            "Pre-cancelled draw must preserve cache and reject before raster allocations");
}
void ownershipAndOverrides() {
    Services services; Image retained;
    std::weak_ptr<SceneMemory> imageService=services.image;
    {
        SoftwareRenderer renderer(services.storage()); const auto scene=fixture(); initialize(renderer,scene);
        require(renderer.readback().bgra.get_allocator().memory()==services.image &&
                    categoryBytes(services.budget,ResourceCategory::Image)==renderer.readback().bgra.capacity() &&
                    categoryBytes(services.budget,ResourceCategory::Work)==scene->loadedCount(),
                "Only retained mask and actual Image capacity may remain after raster scratch releases");
        const auto original=categoryBytes(services.budget,ResourceCategory::Image);
        auto copy=renderer.readback();
        require(copy.bgra.data()!=renderer.readback().bgra.data() && sameBytes(copy.bgra,renderer.readback().bgra) &&
                    categoryBytes(services.budget,ResourceCategory::Image)==original+copy.bgra.capacity(),
                "Copying accepted pixels must admit separate physical Image storage");
        const auto *data=copy.bgra.data(); const auto held=services.budget.usage();
        const auto count=services.image->observed->recorded().size(); retained=std::move(copy);
        require(retained.bgra.data()==data && sameUsage(held,services.budget.usage()) &&
                    count==services.image->observed->recorded().size() && copy.bgra.get_allocator().memory()==services.image,
                "Moving an Image must transfer its grant and retain the moved-from allocation policy");
        retained.bgra.clear();
        require(retained.bgra.data()==data && sameUsage(held,services.budget.usage()),
                "Clearing retained pixels must keep their capacity charged");
        ResourceBudget temporaryBudget(allowance);
        auto temporary=std::make_shared<ObservedMemory>(temporaryBudget,ResourceCategory::Work);
        auto changed=camera(); changed.roll=.3f;
        const auto constructorWork=services.work->observed->recorded().size();
        renderer.draw(changed,{}, {},temporary);
        require(!temporary->observed->recorded().empty() && temporaryBudget.usage().totalBytes==0 &&
                    constructorWork==services.work->observed->recorded().size() &&
                    renderer.frame().splats.get_allocator().memory()==services.packets &&
                    renderer.readback().bgra.get_allocator().memory()==services.image,
                "A Work override must affect only temporary Work and never packet or Image ownership");
        auto next=camera(); next.roll=.4f; const Accepted accepted(renderer); const auto before=services.budget.usage();
        temporary->observed->fault(temporary->observed->recorded().size()+1); bool denied=false;
        try { renderer.draw(next,{}, {},temporary); } catch(const std::bad_alloc &) { denied=true; }
        require(denied && accepted.unchanged(renderer) && sameUsage(before,services.budget.usage()) &&
                    temporaryBudget.usage().totalBytes==0,"Work override denial must unwind candidate Image and packet storage");
        auto mask=maskFor(*scene); mask[0]=2; renderer.setStates(mask);
        require(services.work->observed->recorded().size()==constructorWork+1,
                "An earlier Work override must not change persistent mask ownership");
        const auto beforeMove=services.budget.usage(); const Accepted beforeMoveValues(renderer);
        auto moved=std::move(renderer);
        require(beforeMoveValues.unchanged(moved) && sameUsage(beforeMove,services.budget.usage()),
                "Moving a renderer must transfer accepted cache and grants without admission");
    }
    require(categoryBytes(services.budget,ResourceCategory::Work)==0 && categoryBytes(services.budget,ResourceCategory::Render)==0 &&
                categoryBytes(services.budget,ResourceCategory::Image)==retained.bgra.capacity(),
            "An escaped Image must own only its own pixels after the renderer is destroyed");
    services.image.reset(); require(!imageService.expired(),"Retained pixels must keep their Image service alive");
    retained={}; require(imageService.expired() && services.budget.usage().totalBytes==0,
                         "Destroying final retained pixels must release their grant and service");
    ResourceBudget budget(allowance); auto work=std::make_shared<ObservedMemory>(budget,ResourceCategory::Work);
    SoftwareRenderer workOnly(RenderStorage{{},work,{}}); initialize(workOnly,fixture());
    require(!workOnly.frame().splats.get_allocator().memory() && !workOnly.readback().bgra.get_allocator().memory() &&
                categoryBytes(budget,ResourceCategory::Work)==4 && categoryBytes(budget,ResourceCategory::Image)==0 &&
                categoryBytes(budget,ResourceCategory::Render)==0,
            "A Work-only service must not silently become an Image or Render policy");
}
void categoryDenial() {
    for(const auto category:{ResourceCategory::Work,ResourceCategory::Image}) {
        ResourceLimits limits{allowance}; limits.categoryBytes[std::size_t(category)]=0;
        ResourceBudget budget(limits);
        SoftwareRenderer renderer(RenderStorage{sceneMemoryForBudget(budget,ResourceCategory::Render),
                                                sceneMemoryForBudget(budget,ResourceCategory::Work),
                                                sceneMemoryForBudget(budget,ResourceCategory::Image)});
        renderer.resize(width,height); renderer.setScene(fixture()); bool denied=false;
        try { if(category==ResourceCategory::Work) renderer.setStates(std::array<uint8_t,4>{}); else renderer.draw(camera()); }
        catch(const ResourceBudgetExceeded &error) { denied=true; require(error.availableBytes()==0,"Empty category must report zero admission"); }
        require(denied && renderer.readback().bgra.empty() && renderer.frame().splats.empty() &&
                    renderer.stats().rasterizations==0 && budget.usage().totalBytes==0,
                "Actual Work/Image policy denial must release all provisional storage");
    }
}
void thumbnailCopies() {
    Services services; Image returned; const auto scene=fixture();
    {
        ThumbnailRenderer renderer(services.storage());
        returned=renderer.render(scene,24);
        const auto requests=services.image->observed->recorded();
        require(requests.size()==2 && requests[0].bytes==24*24*4 && requests[1].bytes==returned.bgra.capacity() &&
                    categoryBytes(services.budget,ResourceCategory::Image)==requests[0].bytes+returned.bgra.capacity() &&
                    categoryBytes(services.budget,ResourceCategory::Work)==0,
                "Thumbnail return must separately admit its copy while the renderer retains cached pixels");
        const std::vector<uint8_t> expected(returned.bgra.begin(),returned.bgra.end()); returned={};
        const auto packetCount=services.packets->observed->recorded().size(),workCount=services.work->observed->recorded().size();
        returned=renderer.render(scene,24);
        require(sameBytes(expected,returned.bgra) && services.image->observed->recorded().size()==3 &&
                    packetCount==services.packets->observed->recorded().size() && workCount==services.work->observed->recorded().size(),
                "A thumbnail cache hit must allocate only the independently returned Image copy");
    }
    require(services.budget.usage().totalBytes==returned.bgra.capacity(),
            "Returned thumbnail pixels must outlive the renderer without retaining its packets or workspace");
    returned={}; require(services.budget.usage().totalBytes==0,"Thumbnail ownership must fully release");
    Services failure;
    {
        ThumbnailRenderer renderer(failure.storage()); failure.image->observed->fault(2); bool denied=false;
        try { const auto image=renderer.render(scene,24); } catch(const std::bad_alloc &) { denied=true; }
        require(denied && categoryBytes(failure.budget,ResourceCategory::Image)==24*24*4 &&
                    categoryBytes(failure.budget,ResourceCategory::Work)==0,
                "A returned-copy failure must retain only the completed thumbnail cache");
        const auto packetCount=failure.packets->observed->recorded().size(),workCount=failure.work->observed->recorded().size();
        failure.image->observed->fault(0); const auto image=renderer.render(scene,24);
        require(!image.bgra.empty() && packetCount==failure.packets->observed->recorded().size() &&
                    workCount==failure.work->observed->recorded().size(),
                "Retry after thumbnail-copy denial must reuse the completed cache");
    }
    require(failure.budget.usage().totalBytes==0,"Thumbnail copy failure and retry must release all grants");
}
} // namespace

void rendererCacheContracts() {
    stagedMask(); drawBoundaries(false); drawBoundaries(true); ownershipAndOverrides(); categoryDenial(); thumbnailCopies();
}
