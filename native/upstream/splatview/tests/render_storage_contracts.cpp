#include "render_storage_contracts.hpp"
#include "render_frame.hpp"
#include "resource_budget.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <stdexcept>
#include <stop_token>
#include <type_traits>
#include <utility>
#include <vector>

namespace {
using namespace preview;
constexpr std::size_t allowance=64*1024*1024;
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
std::size_t renderBytes(const ResourceBudget &budget) {
    return budget.usage().categoryBytes[std::size_t(ResourceCategory::Render)];
}
std::size_t packetBytes(const RenderFrame &frame) {
    return checkedByteSum({checkedByteProduct(frame.splats.capacity(),sizeof(GaussianPacket)),
                           checkedByteProduct(frame.vertices.capacity(),sizeof(GeometryPacket)),
                           checkedByteProduct(frame.triangles.capacity(),sizeof(std::array<uint32_t,3>))});
}
template<class T,class A,class B> bool sameBytes(const std::vector<T,A> &a,const std::vector<T,B> &b) {
    static_assert(std::is_trivially_copyable_v<T>);
    return a.size()==b.size() && (a.empty() || std::memcmp(a.data(),b.data(),a.size()*sizeof(T))==0);
}
bool sameFrame(const RenderFrame &a,const RenderFrame &b) {
    return a.width==b.width && a.height==b.height && a.type==b.type && a.sourceCount==b.sourceCount &&
        sameBytes(a.splats,b.splats) && sameBytes(a.vertices,b.vertices) && sameBytes(a.triangles,b.triangles);
}
struct Observations {
    struct Request { std::size_t bytes{},liveBefore{}; };
    std::vector<Request> requests;
    std::size_t live{},peak{},active{},failAt{},stopAt{};
    std::stop_source *stop{};
};
struct Grant {
    ResourceReservation reservation;
    std::shared_ptr<Observations> observed;
    std::size_t bytes;
    Grant(ResourceReservation value,std::shared_ptr<Observations> state,std::size_t count) noexcept
        : reservation(std::move(value)),observed(std::move(state)),bytes(count) {
        observed->live+=bytes; ++observed->active;
        observed->peak=std::max(observed->peak,observed->live);
    }
    ~Grant() { observed->live-=bytes; --observed->active; }
};
class ObservedMemory final : public SceneMemory {
  public:
    explicit ObservedMemory(ResourceBudget value,ResourceCategory purpose=ResourceCategory::Render)
        : budget(std::move(value)),category(purpose),observed(std::make_shared<Observations>()) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        observed->requests.push_back({bytes,observed->live});
        if(observed->failAt==observed->requests.size()) throw std::bad_alloc();
        auto grant=std::make_shared<Grant>(budget.reserve(category,bytes),observed,bytes);
        if(observed->stop && observed->stopAt==observed->requests.size()) observed->stop->request_stop();
        return grant;
    }
    ResourceBudget budget;
    ResourceCategory category;
    std::shared_ptr<Observations> observed;
};
Camera camera() {
    Camera result; result.yUp=true; result.yaw=result.pitch=0;
    result.distance=4; result.radius=1; result.roll=.17f;
    return result;
}
std::shared_ptr<Scene> gaussianScene(std::size_t count) {
    auto scene=std::make_shared<Scene>();
    scene->shDegree=3; scene->sourceCount=1009; scene->format="render-storage-fixture";
    scene->sourceContentKey="unchanged-render-source";
    for(std::size_t i=0;i<count;++i) {
        Attributes a;
        a.position={float(int(i%7)-3)*.09f,float(int(i%5)-2)*.07f,float((i*7)%9)*.12f-.48f};
        a.scale={.02f+float(i%3)*.01f,.04f,.03f};
        a.opacity=.2f+float(i%9)*.05f;
        a.sh[0]=float(int(i%5)-2)*.13f;
        a.sh[1]=-.17f; a.sh[2]=.23f; a.sh[12]=.08f;
        if(i && i%11==0) a.opacity=0; // Transparent compaction.
        if(i && i%13==0) a.position.x=100; // Off-screen compaction.
        if(i && i%17==0) a.position.z=5; // Behind-camera compaction.
        scene->gaussians.push_back(packGaussian(a));
    }
    return scene;
}
std::vector<uint8_t> statesFor(const Scene &scene) {
    std::vector<uint8_t> states(scene.gaussians.size());
    for(std::size_t i=0;i<states.size();++i) states[i]=i && i%7==0 ? 2 : uint8_t(i%3==0);
    return states;
}
std::shared_ptr<Scene> geometryScene(SceneType type) {
    auto scene=std::make_shared<Scene>(); scene->type=type;
    scene->vertices={{{-.4f,-.3f,0},0xff123456},{{.4f,-.3f,0},0xff654321},
                     {{.4f,.3f,.1f},0xffabcdef},{{-.4f,.3f,.1f},0xfffedcba}};
    if(type==SceneType::Mesh) scene->triangles={{0,1,2},{0,2,3}};
    return scene;
}
RenderFrame prepare(const std::shared_ptr<Scene> &scene,const std::shared_ptr<SceneMemory> &packets,
                    std::stop_token stop={}) {
    const auto states=statesFor(*scene);
    return prepareFrameWithStorage(scene,states,camera(),127,93,{},stop,RenderStorage{packets,{},{}});
}
std::vector<GaussianPacket> independentOrder(const std::shared_ptr<Scene> &scene,
                                           std::span<const uint8_t> states,const ViewSettings &settings) {
    std::vector<GaussianPacket> result;
    for(std::size_t i=0;i<scene->gaussians.size();++i) {
        auto one=std::make_shared<Scene>(); one->shDegree=scene->shDegree;
        one->gaussians.push_back(scene->gaussians[i]);
        // A zero/one-packet render never sorts. Build the source-order oracle
        // independently of the production merge/compaction implementation.
        const auto frame=prepareFrame(one,states.subspan(i,1),camera(),127,93,settings);
        require(frame.splats.size()<=1,"Single-Gaussian oracle must not generate multiple packets");
        if(!frame.splats.empty()) {
            auto packet=frame.splats.front(); packet.identity[0]=uint32_t(i+1);
            result.push_back(packet);
        }
    }
    std::stable_sort(result.begin(),result.end(),[](const auto &a,const auto &b) {
        return a.centerDepth[2]>b.centerDepth[2];
    });
    return result;
}
void stableOrderReference() {
    bool equalDepth=false;
    for(const std::size_t count:{0,1,2,3,5,17,65,257}) {
        const auto scene=gaussianScene(count),original=std::make_shared<Scene>(*scene);
        const auto states=statesFor(*scene);
        for(unsigned mode=0;mode<3;++mode) {
            ViewSettings settings;
            if(mode==1) settings.colorPreviewCoverage=true;
            if(mode==2) {
                settings.selection.shape=2; settings.selection.operation=1;
                settings.selection.limits={.2f,.2f,.6f,0};
            }
            const auto expected=independentOrder(scene,states,settings);
            ResourceBudget budget(allowance);
            auto service=std::make_shared<ObservedMemory>(budget);
            {
                const auto actual=prepareFrameWithStorage(scene,states,camera(),127,93,settings,{},
                                                          RenderStorage{service,{},{}});
                require(sameBytes(actual.splats,expected),
                        "Admitted stable merging must match the independent source-order/std::stable_sort oracle bit for bit");
                for(std::size_t i=1;i<actual.splats.size();++i) {
                    const auto &left=actual.splats[i-1],&right=actual.splats[i];
                    if(left.centerDepth[2]==right.centerDepth[2]) {
                        equalDepth=true;
                        require(left.identity[0]<right.identity[0],"Equal-depth packets must retain original source order");
                    }
                }
                require(renderBytes(budget)==packetBytes(actual) && budget.usage().totalBytes==packetBytes(actual),
                        "A prepared frame must retain exactly its actual packet capacities after temporary sort storage is freed");
                require(service->observed->requests.size()==std::size_t(count!=0)+std::size_t(expected.size()>1),
                        "Only the source packet vector and a nontrivial visible-packet sort buffer may request Render storage");
                if(expected.size()>1) {
                    const auto &requests=service->observed->requests;
                    require(requests[0].bytes==actual.splats.capacity()*sizeof(GaussianPacket) &&
                                requests[1].bytes>=expected.size()*sizeof(GaussianPacket) &&
                                requests[1].liveBefore==requests[0].bytes &&
                                service->observed->peak==requests[0].bytes+requests[1].bytes,
                            "Sort scratch admission must overlap actual retained source capacity, including compacted-away packets");
                }
            }
            require(budget.usage().totalBytes==0 && service->observed->active==0,
                    "Destroying a reference-comparison frame must release every packet/sort grant");
        }
        require(sameBytes(scene->gaussians,original->gaussians) && scene->sourceContentKey==original->sourceContentKey,
                "Packet projection, sorting and compaction must preserve source payload and provenance");
    }
    require(equalDepth,"Stable-sort reference fixtures must exercise actual equal-depth visible packets");
}
void retainedOwners() {
    static_assert(std::is_aggregate_v<RenderFrame>);
    static_assert(std::is_nothrow_move_constructible_v<RenderFrame> && std::is_nothrow_move_assignable_v<RenderFrame>);
    const RenderFrame aggregate{1,2,SceneType::GaussianSplats,0,{},{},{}};
    require(aggregate.width==1 && aggregate.height==2,"RenderFrame must preserve aggregate initialization");
    for(const auto &scene:{gaussianScene(73),geometryScene(SceneType::PointCloud),geometryScene(SceneType::Mesh)}) {
        ResourceBudget budget(allowance);
        auto service=std::make_shared<ObservedMemory>(budget);
        auto observed=service->observed;
        std::weak_ptr<SceneMemory> weak=service;
        auto frame=prepare(scene,service);
        const auto retained=packetBytes(frame);
        require(retained && renderBytes(budget)==retained && observed->live==retained &&
                    frame.splats.get_allocator().memory()==service && frame.vertices.get_allocator().memory()==service &&
                    frame.triangles.get_allocator().memory()==service,
                "All returned packet containers, including empty ones, must retain their explicit Render service");
        {
            auto copy=frame;
            require(sameFrame(copy,frame) && renderBytes(budget)==retained+packetBytes(copy),
                    "Copied frames must admit independent packet capacities with unchanged packet bits");
            if(!frame.splats.empty()) require(copy.splats.data()!=frame.splats.data(),"A splat-frame copy must own distinct storage");
            if(!frame.vertices.empty()) require(copy.vertices.data()!=frame.vertices.data(),"A geometry-frame copy must own distinct storage");
            const auto *splats=copy.splats.data(); const auto *vertices=copy.vertices.data();
            const auto *triangles=copy.triangles.data(); const auto held=renderBytes(budget),requests=observed->requests.size();
            auto moved=std::move(copy);
            RenderFrame assigned; assigned=std::move(moved);
            require(sameFrame(assigned,frame) && assigned.splats.data()==splats && assigned.vertices.data()==vertices &&
                        assigned.triangles.data()==triangles && renderBytes(budget)==held && observed->requests.size()==requests,
                    "Frame moves must transfer physical owners without any payload admission, including MSVC Debug proxy replacement");
            const auto capacityBytes=packetBytes(assigned);
            assigned.splats.clear(); assigned.vertices.clear(); assigned.triangles.clear();
            require(packetBytes(assigned)==capacityBytes && renderBytes(budget)==held,
                    "Clearing packet values must retain capacity and its admission grant");
            // The allocator policy is copied on move, so reusing an empty source
            // must not silently turn later packet allocations into untracked work.
            copy.splats.push_back(GaussianPacket{});
            require(copy.splats.get_allocator().memory()==service && renderBytes(budget)==held+packetBytes(copy),
                    "Reusing a moved-from frame must keep the originating packet admission policy");
        }
        require(renderBytes(budget)==retained,"Destroying copied/moved frames must release only their distinct capacities");
        service.reset();
        require(!weak.expired() && renderBytes(budget)==retained,"Returned frame storage must outlive the caller's service handle");
        frame={};
        require(weak.expired() && budget.usage().totalBytes==0 && observed->live==0 && observed->active==0,
                "Replacing the final frame must free packet capacities before releasing their grants and service");
    }
    ResourceBudget first(allowance),second(allowance);
    auto aMemory=std::make_shared<ObservedMemory>(first),bMemory=std::make_shared<ObservedMemory>(second);
    {
        auto a=prepare(gaussianScene(17),aMemory),b=prepare(geometryScene(SceneType::Mesh),bMemory);
        const auto aBytes=packetBytes(a),bBytes=packetBytes(b),aRequests=aMemory->observed->requests.size(),bRequests=bMemory->observed->requests.size();
        std::swap(a,b);
        require(packetBytes(a)==bBytes && packetBytes(b)==aBytes && renderBytes(first)==aBytes && renderBytes(second)==bBytes &&
                    aMemory->observed->requests.size()==aRequests && bMemory->observed->requests.size()==bRequests &&
                    a.vertices.get_allocator().memory()==bMemory && b.splats.get_allocator().memory()==aMemory,
                "Swapping frames across ledgers must transfer buffers and services without moving their existing charges");
    }
    require(first.usage().totalBytes==0 && second.usage().totalBytes==0,"Cross-ledger frame destruction must release both owners");
}
void compactedCapacity() {
    const auto scene=gaussianScene(73);
    for(const std::size_t visible:{0,1}) {
        std::vector<uint8_t> states(scene->gaussians.size(),2);
        if(visible) states.front()=0;
        ResourceBudget budget(allowance); auto service=std::make_shared<ObservedMemory>(budget);
        {
            const auto frame=prepareFrameWithStorage(scene,states,camera(),127,93,{}, {},RenderStorage{service,{},{}});
            require(frame.splats.size()==visible && frame.splats.capacity()>=scene->gaussians.size() &&
                        service->observed->requests.size()==1 && renderBytes(budget)==packetBytes(frame) &&
                        service->observed->requests.front().bytes==packetBytes(frame),
                    "Zero/one visible packets must skip sort scratch while retaining the full physically allocated source capacity");
        }
        require(budget.usage().totalBytes==0 && service->observed->active==0,
                "Even an empty compacted frame must release its retained packet allocation on destruction");
    }
}
void deniedAndCancelled() {
    for(const auto &scene:{gaussianScene(73),geometryScene(SceneType::Mesh)}) {
        const auto expected=prepare(scene,{});
        std::vector<Observations::Request> requests;
        {
            ResourceBudget budget(allowance); auto service=std::make_shared<ObservedMemory>(budget);
            { const auto frame=prepare(scene,service); require(sameFrame(frame,expected),"Allocation census must preserve packets"); }
            requests=service->observed->requests;
            require(requests.size()==2 && budget.usage().totalBytes==0,"Packet/sort and geometry/triangle census must expose both allocation seams");
        }
        for(std::size_t stage=0;stage<requests.size();++stage) {
            ResourceLimits limits{allowance};
            limits.categoryBytes[std::size_t(ResourceCategory::Render)]=requests[stage].liveBefore+requests[stage].bytes-1;
            ResourceBudget budget(limits); auto service=std::make_shared<ObservedMemory>(budget);
            auto published=expected; const auto *splats=published.splats.data(); const auto *vertices=published.vertices.data();
            bool rejected=false;
            try { published=prepare(scene,service); }
            catch(const ResourceBudgetExceeded &error) {
                rejected=true;
                require(error.requestedBytes()==requests[stage].bytes && error.availableBytes()==requests[stage].bytes-1,
                        "Each packet/sort/triangle allocation must enforce its own actual Render admission");
            }
            require(rejected && service->observed->requests.size()==stage+1 && sameFrame(published,expected) &&
                        published.splats.data()==splats && published.vertices.data()==vertices && budget.usage().totalBytes==0 &&
                        service->observed->live==0 && service->observed->active==0,
                    "Allocation denial must unwind every temporary packet owner without replacing previously published output");

            ResourceBudget faultBudget(allowance); auto fault=std::make_shared<ObservedMemory>(faultBudget);
            fault->observed->failAt=stage+1; bool badAllocation=false;
            try { (void)prepare(scene,fault); } catch(const std::bad_alloc &) { badAllocation=true; }
            require(badAllocation && fault->observed->requests.size()==stage+1 && faultBudget.usage().totalBytes==0 &&
                        fault->observed->active==0,
                    "Ordinary callback bad_alloc must propagate without a fallback or a leaked earlier allocation");
            fault->observed->failAt=0;
            { const auto retried=prepare(scene,fault); require(sameFrame(retried,expected),"A callback failure must permit an equivalent retry"); }
            require(faultBudget.usage().totalBytes==0,"A successful retry must release its own packet capacities");
        }
        for(std::size_t stage=0;stage<=requests.size();++stage) {
            ResourceBudget budget(allowance); auto service=std::make_shared<ObservedMemory>(budget);
            std::stop_source stop; service->observed->stop=&stop; service->observed->stopAt=stage;
            if(!stage) stop.request_stop();
            auto published=expected; bool cancelled=false;
            try { published=prepare(scene,service,stop.get_token()); }
            catch(const ResourceBudgetExceeded &) { throw; }
            catch(const std::runtime_error &) { cancelled=true; }
            require(cancelled && service->observed->requests.size()==stage && sameFrame(published,expected) &&
                        budget.usage().totalBytes==0 && service->observed->active==0 && service->observed->live==0,
                    "Pre-stop and stop-at-packet/sort/triangle admission must prevent publication and release every acquired grant");
        }
    }
}
void compatibilityWrappers() {
    const auto scene=gaussianScene(17); const auto states=statesFor(*scene);
    const auto normal=prepareFrame(scene,states,camera(),127,93);
    const auto explicitDefault=prepareFrameWithStorage(scene,states,camera(),127,93,{}, {}, {});
    require(sameFrame(normal,explicitDefault) && !normal.splats.get_allocator().memory(),
            "Default prepareFrame must preserve unbudgeted packet storage and output");
    ResourceBudget denied(0);
    const auto workOnly=prepareFrame(scene,states,camera(),127,93,{}, {},sceneMemoryForBudget(denied,ResourceCategory::Work));
    require(sameFrame(normal,workOnly) && denied.usage().totalBytes==0 && !workOnly.splats.get_allocator().memory(),
            "Legacy scratch arguments must not become implicit Render admission policies");
    ViewSettings transformed; transformed.geometry[12]=.13f;
    const auto expected=prepareFrame(scene,states,camera(),127,93,transformed);
    ResourceBudget budget(allowance);
    auto scratch=std::make_shared<ObservedMemory>(budget,ResourceCategory::Work);
    const auto legacy=prepareFrame(scene,states,camera(),127,93,transformed,{},scratch);
    const auto explicitWork=prepareFrameWithStorage(scene,states,camera(),127,93,transformed,{},RenderStorage{{},scratch,{}});
    require(sameFrame(legacy,expected) && sameFrame(explicitWork,expected) && !scratch->observed->requests.empty() &&
                budget.usage().totalBytes==0 && !legacy.splats.get_allocator().memory() && !explicitWork.splats.get_allocator().memory(),
            "Legacy transformed-scene scratch must still admit bounds Work and leave returned packet vectors unbudgeted");
}
} // namespace

void renderStorageContracts() {
    stableOrderReference();
    retainedOwners();
    compactedCapacity();
    deniedAndCancelled();
    compatibilityWrappers();
}
