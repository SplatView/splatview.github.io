#include "spz_admission_contracts.hpp"
#include "file_io.hpp"
#include "math.hpp"
#include "model.hpp"
#include "spz_decode_test_access.hpp"
#include <load-spz.h>
#include <coordinate-system-adobe.h>
#include <safe-orbit-camera-adobe.h>
#include <zlib.h>
#include <zstd.h>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <fstream>
#include <limits>
#include <new>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

namespace preview {
struct SpzDecodeTestAccess {
    static void checkpoint(void (*function)(void *,const char *),void *context) {
        detail::SpzDecodeState::setCheckpoint(function,context);
    }
};
} // namespace preview

namespace {
using namespace preview;
using Bytes=std::vector<uint8_t>;
using WorkBytes=SceneVector<uint8_t>;
constexpr std::size_t allowance=64*1024*1024;
constexpr uint32_t pointCount=9;
constexpr uint32_t coordinateType=0xADBE0003u,safeOrbitType=0xADBE0002u;
void require(bool value,const char *message) {
    if(!value) throw std::runtime_error(message);
}
template<class Error=std::exception,class F> void rejects(F &&action,const char *message) {
    try { std::forward<F>(action)(); } catch(const Error &) { return; }
    throw std::runtime_error(message);
}
template<class T> void append(Bytes &bytes,T value) {
    const auto encoded=std::bit_cast<std::array<uint8_t,sizeof(T)>>(value);
    bytes.insert(bytes.end(),encoded.begin(),encoded.end());
}
template<class T> void put(Bytes &bytes,std::size_t offset,T value) {
    require(offset<=bytes.size() && sizeof(T)<=bytes.size()-offset,"SPZ test field is bounded");
    std::memcpy(bytes.data()+offset,&value,sizeof(T));
}
template<class T> T number(const Bytes &bytes,std::size_t offset) {
    require(offset<=bytes.size() && sizeof(T)<=bytes.size()-offset,"SPZ test field is present");
    T value; std::memcpy(&value,bytes.data()+offset,sizeof(T)); return value;
}
std::size_t category(const ResourceBudget &budget,ResourceCategory kind) {
    return budget.usage().categoryBytes[std::size_t(kind)];
}
void empty(const ResourceBudget &budget,const char *message) {
    require(budget.usage().totalBytes==0,message);
    for(const auto bytes:budget.usage().categoryBytes) require(bytes==0,message);
}
ResourceBudget capped(ResourceCategory kind,std::size_t bytes) {
    ResourceLimits limits{allowance}; limits.categoryBytes[std::size_t(kind)]=bytes;
    return ResourceBudget(limits);
}
LoadOptions options(const ResourceBudget &budget,std::size_t count=3) {
    LoadOptions value; value.resources=budget; value.maxSplats=count; return value;
}
void write(const std::filesystem::path &path,const Bytes &bytes) {
    std::ofstream stream(path,std::ios::binary|std::ios::trunc);
    stream.write(reinterpret_cast<const char *>(bytes.data()),std::streamsize(bytes.size()));
    require(bool(stream),"Independent SPZ fixture writes completely");
}
Bytes read(const std::filesystem::path &path) {
    const FileSnapshot snapshot(path,allowance); return {snapshot.bytes().begin(),snapshot.bytes().end()};
}
Bytes record(uint32_t type,const Bytes &payload) {
    Bytes bytes; append(bytes,type); append(bytes,uint32_t(payload.size()));
    bytes.insert(bytes.end(),payload.begin(),payload.end()); return bytes;
}
Bytes coordinates(uint32_t coordinate,unsigned tail=0) {
    Bytes payload; append(payload,coordinate); payload.insert(payload.end(),tail,0x73);
    return record(coordinateType,payload);
}
void join(Bytes &left,const Bytes &right) { left.insert(left.end(),right.begin(),right.end()); }
unsigned dimensions(unsigned degree) { return (degree+1)*(degree+1)-1; }

// Raw attributes and framing are constructed independently of spz::saveSpz.
// Existing PackedGaussian::unpack is the pinned math oracle, not a writer oracle.
struct Fixture {
    unsigned version{},degree{};
    std::array<Bytes,6> fields;
    std::size_t packedBytes() const {
        std::size_t bytes=0; for(const auto &field:fields) bytes+=field.size(); return bytes;
    }
    spz::PackedGaussian at(unsigned index) const {
        spz::PackedGaussian value;
        const auto positionBytes=version==1?6u:9u,rotationBytes=version<3?3u:4u;
        std::copy_n(fields[0].data()+index*positionBytes,positionBytes,value.position.begin());
        value.alpha=fields[1][index];
        std::copy_n(fields[2].data()+index*3,3,value.color.begin());
        std::copy_n(fields[3].data()+index*3,3,value.scale.begin());
        std::copy_n(fields[4].data()+index*rotationBytes,rotationBytes,value.rotation.begin());
        value.shR.fill(128); value.shG.fill(128); value.shB.fill(128);
        for(unsigned j=0;j<dimensions(degree);++j) {
            const auto offset=(index*dimensions(degree)+j)*3;
            value.shR[j]=fields[5][offset]; value.shG[j]=fields[5][offset+1]; value.shB[j]=fields[5][offset+2];
        }
        return value;
    }
};
Fixture attributes(unsigned version,unsigned degree) {
    Fixture fixture{version,degree,{}};
    for(unsigned i=0;i<pointCount;++i) {
        for(const float coordinate:{float(i+1)/8,.25f,-.5f}) {
            if(version==1) append(fixture.fields[0],DirectX::PackedVector::XMConvertFloatToHalf(coordinate));
            else {
                const auto fixed=static_cast<int32_t>(coordinate*4096);
                for(unsigned byte=0;byte<3;++byte) fixture.fields[0].push_back(uint8_t(uint32_t(fixed)>>(byte*8)));
            }
        }
        fixture.fields[1].push_back(uint8_t(160+i));
        for(unsigned channel=0;channel<3;++channel) {
            fixture.fields[2].push_back(uint8_t(110+i+channel*8));
            fixture.fields[3].push_back(uint8_t(96+channel*4));
        }
        if(version<3) fixture.fields[4].insert(fixture.fields[4].end(),3,128);
        else fixture.fields[4].insert(fixture.fields[4].end(),{0,0,0,0xc0}); // identity, largest w
        for(unsigned j=0;j<dimensions(degree);++j)
            for(unsigned channel=0;channel<3;++channel)
                fixture.fields[5].push_back(uint8_t(128+8*((i+j+channel)%5)));
    }
    return fixture;
}
Bytes zstd(const Bytes &raw) {
    Bytes bytes(ZSTD_compressBound(raw.size()));
    const auto size=ZSTD_compress(bytes.data(),bytes.size(),raw.data(),raw.size(),1);
    require(!ZSTD_isError(size),"Independent SPZ stream compresses"); bytes.resize(size); return bytes;
}
Bytes ngsp(const Fixture &fixture,const Bytes &extensions={}) {
    require(fixture.version==4,"NGSP fixture is version four");
    Bytes bytes(32); put(bytes,0,spz::NGSP_MAGIC); put(bytes,4,uint32_t(4)); put(bytes,8,pointCount);
    bytes[12]=uint8_t(fixture.degree); bytes[13]=12; bytes[14]=extensions.empty()?0:2;
    bytes[15]=fixture.fields[5].empty()?5:6; put(bytes,16,uint32_t(32+extensions.size())); join(bytes,extensions);
    std::array<Bytes,6> chunks;
    for(unsigned field=0;field<6;++field) if(!fixture.fields[field].empty()) {
        chunks[field]=zstd(fixture.fields[field]);
        append(bytes,uint64_t(chunks[field].size())); append(bytes,uint64_t(fixture.fields[field].size()));
    }
    for(const auto &chunk:chunks) join(bytes,chunk);
    return bytes;
}
Bytes gzip(const Bytes &raw) {
    z_stream stream{};
    require(deflateInit2(&stream,Z_BEST_SPEED,Z_DEFLATED,16+MAX_WBITS,8,Z_DEFAULT_STRATEGY)==Z_OK,
            "Independent legacy gzip starts");
    Bytes bytes(deflateBound(&stream,static_cast<uLong>(raw.size())));
    stream.next_in=const_cast<Bytef *>(raw.data()); stream.avail_in=static_cast<uInt>(raw.size());
    stream.next_out=bytes.data(); stream.avail_out=static_cast<uInt>(bytes.size());
    const auto code=deflate(&stream,Z_FINISH); const auto size=stream.total_out; deflateEnd(&stream);
    require(code==Z_STREAM_END,"Independent legacy gzip finishes"); bytes.resize(size); return bytes;
}
Bytes legacy(const Fixture &fixture,const Bytes &extensions={}) {
    Bytes raw; append(raw,spz::NGSP_MAGIC); append(raw,uint32_t(fixture.version)); append(raw,pointCount);
    raw.insert(raw.end(),{uint8_t(fixture.degree),12,uint8_t(extensions.empty()?0:2),0});
    for(const auto &field:fixture.fields) join(raw,field);
    join(raw,extensions); return gzip(raw);
}
Gaussian expected(const Fixture &fixture,unsigned index,spz::CoordinateSystem coordinates=spz::CoordinateSystem::RUB) {
    const auto converter=spz::coordinateConverter(coordinates,spz::CoordinateSystem::RUB,int(fixture.degree));
    const auto point=fixture.at(index).unpack(fixture.version==1,fixture.version>=3,12,converter);
    Attributes value;
    value.position={point.position[0],point.position[1],point.position[2]};
    value.scale={std::exp(point.scale[0]),std::exp(point.scale[1]),std::exp(point.scale[2])};
    value.quaternion={point.rotation[3],point.rotation[0],point.rotation[1],point.rotation[2]};
    value.opacity=1/(1+std::exp(-point.alpha));
    for(unsigned channel=0;channel<3;++channel) value.sh[channel]=point.color[channel];
    for(unsigned j=0;j<std::min(dimensions(fixture.degree),15u);++j) {
        value.sh[(j+1)*3]=point.shR[j]; value.sh[(j+1)*3+1]=point.shG[j]; value.sh[(j+1)*3+2]=point.shB[j];
    }
    return packGaussian(value);
}
void sample(const Scene &scene,const Fixture &fixture,std::size_t limit,
            spz::CoordinateSystem coordinates=spz::CoordinateSystem::RUB) {
    const auto loaded=std::min<std::size_t>(limit,pointCount);
    require(scene.sourceCount==pointCount && scene.gaussians.size()==loaded && scene.shDegree==std::min(fixture.degree,3u),
            "SPZ count and SH4-to-SH3 preview policy remain explicit");
    // Enumerate the original inclusion predicate rather than calling the decoder's inverse sampler.
    unsigned output=0;
    for(unsigned i=0;i<pointCount;++i) if(pointCount<=loaded || i*loaded/pointCount!=(i+1)*loaded/pointCount) {
        const auto oracle=expected(fixture,i,coordinates);
        const auto &actual=scene.gaussians.at(output++);
        require(std::abs(actual.positionOpacity[0]-oracle.positionOpacity[0])<1e-6f &&
                    std::abs(actual.positionOpacity[1]-oracle.positionOpacity[1])<1e-6f &&
                    std::abs(actual.positionOpacity[2]-oracle.positionOpacity[2])<1e-6f &&
                    std::abs(actual.positionOpacity[3]-oracle.positionOpacity[3])<1e-6f,
                "Independent packed SPZ fixture preserves sampled coordinates and opacity");
        for(unsigned coefficient=0;coefficient<16;++coefficient) for(unsigned channel=0;channel<3;++channel)
            require(shValue(actual,coefficient,channel)==shValue(oracle,coefficient,channel),
                    "Sampled SPZ retained SH matches pinned per-point unpack math");
        for(unsigned component=0;component<4;++component) {
            require(std::abs(actual.covA[component]-oracle.covA[component])<1e-6f &&
                        std::abs(actual.covB[component]-oracle.covB[component])<1e-6f,
                    "Sampled covariance matches pinned quaternion/scale unpack math");
        }
    }
    require(output==loaded,"Independent sampler visits exactly the requested records");
}

struct CallbackOwner {
    enum class Invalid { None, Null, Short, Long, Source, Previous };
    ResourceBudget budget{allowance};
    std::array<WorkBytes,6> fields;
    const Bytes *source{};
    std::vector<spz::SplatAttribute> order;
    std::vector<std::size_t> requested;
    const std::thread::id thread=std::this_thread::get_id();
    unsigned checkpoints{},allocations{},active{},throwAllocation{},throwCheckpoint{};
    Invalid invalid{};
    CallbackOwner() {
        const auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        for(auto &field:fields) field=WorkBytes{SceneAllocator<uint8_t>{memory}};
    }
    struct Active {
        CallbackOwner &owner;
        explicit Active(CallbackOwner &value):owner(value) {
            require(std::this_thread::get_id()==owner.thread,"SPZ callbacks execute synchronously on the caller thread");
            ++owner.active;
        }
        ~Active() { --owner.active; }
    };
    static spz::MutableBytes allocate(void *context,spz::SplatAttribute field,std::size_t bytes) {
        auto &owner=*static_cast<CallbackOwner *>(context); Active active(owner);
        ++owner.allocations; owner.order.push_back(field); owner.requested.push_back(bytes);
        if(owner.throwAllocation==owner.allocations) throw std::bad_alloc();
        auto &storage=owner.fields.at(std::size_t(field)); storage.resize(bytes);
        if(owner.invalid==Invalid::Null) return {nullptr,bytes};
        if(owner.invalid==Invalid::Short) return {storage.data(),bytes-1};
        if(owner.invalid==Invalid::Long) return {storage.data(),bytes+1};
        if(owner.invalid==Invalid::Source) return {const_cast<uint8_t *>(owner.source->data()),bytes};
        if(owner.invalid==Invalid::Previous && owner.allocations==2) return {owner.fields[0].data(),bytes};
        return {storage.data(),storage.size()};
    }
    static void checkpoint(void *context) {
        auto &owner=*static_cast<CallbackOwner *>(context); Active active(owner);
        if(++owner.checkpoints==owner.throwCheckpoint) throw std::runtime_error("SPZ fixture cancellation");
    }
    spz::PackedDecodeCallbacks callbacks() { return {this,&allocate,&checkpoint}; }
    void release() {
        for(auto &field:fields) { WorkBytes empty(field.get_allocator()); field.swap(empty); }
    }
};

void vendorContract() {
    for(unsigned degree:{0u,1u,2u,3u,4u}) {
        const auto fixture=attributes(4,degree); const auto bytes=ngsp(fixture),original=bytes;
        CallbackOwner owner; owner.source=&bytes; spz::PackedGaussiansView view;
        require(spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view),"Caller-owned NGSP decode accepts independent streams");
        const auto count=degree?6u:5u;
        require(owner.allocations==count && owner.checkpoints==2*count+1 && owner.active==0 &&
                    category(owner.budget,ResourceCategory::Work)==fixture.packedBytes(),
                "SPZ callbacks own each exact packed field, omit SH0 allocation, and finish before return");
        for(unsigned field=0;field<count;++field)
            require(owner.order[field]==spz::kAllSplatAttributes[field] && owner.requested[field]==fixture.fields[field].size(),
                    "SPZ allocation order and exact input lengths preserve the established attribute contract");
        require(view.numPoints==int(pointCount) && view.shDegree==int(degree) &&
                    view.positions.data==owner.fields[0].data() && view.positions.size==fixture.fields[0].size(),
                "Packed view borrows caller bytes instead of retaining vendor storage");
        const auto converter=spz::coordinateConverter(spz::CoordinateSystem::RUB,spz::CoordinateSystem::RUB,int(degree));
        const auto before=view.unpack(2,converter);
        const auto old=spz::loadSpzPacked(bytes.data(),bytes.size());
        const auto compatibility=old.unpack(2,converter); // exercises old PackedGaussians::at on SH0 under Debug/UBSan
        require(before.position==compatibility.position && before.shR==compatibility.shR && before.shG==compatibility.shG &&
                    before.shB==compatibility.shB && bytes==original,"Borrowed and compatible packed APIs retain pinned values including empty SH0");
        auto moved=std::move(owner.fields);
        require(view.positions.data==moved[0].data() && view.unpack(2,converter).position==before.position,
                "Moving caller storage preserves view addresses; the view owns no replacement allocation");
        for(auto &field:moved) { WorkBytes empty(field.get_allocator()); field.swap(empty); }
        empty(owner.budget,"Caller destruction releases all view storage grants");
    }
    const auto fixture=attributes(4,3); const auto bytes=ngsp(fixture),original=bytes;
    for(unsigned allocation=1;allocation<=6;++allocation) {
        CallbackOwner owner; owner.source=&bytes; owner.throwAllocation=allocation;
        spz::PackedGaussiansView view; view.numPoints=123;
        rejects<std::bad_alloc>([&] { spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view); },
                                "Each caller allocation may throw ordinary bad_alloc without fallback");
        require(owner.allocations==allocation && owner.checkpoints==allocation && owner.active==0 && view.numPoints==123,
                "Allocation failure stops synchronously before streams and leaves published output untouched");
        owner.release(); empty(owner.budget,"Partial caller-owned SPZ allocations unwind cleanly");
    }
    for(const auto invalid:{CallbackOwner::Invalid::Null,CallbackOwner::Invalid::Short,CallbackOwner::Invalid::Long,
                            CallbackOwner::Invalid::Source,CallbackOwner::Invalid::Previous}) {
        CallbackOwner owner; owner.source=&bytes; owner.invalid=invalid; spz::PackedGaussiansView view; view.numPoints=123;
        require(!spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view) && view.numPoints==123 && owner.active==0,
                "Null/inexact/overlapping caller byte ranges reject without output publication or source writes");
        owner.release(); empty(owner.budget,"Invalid destination ranges retain no grants after caller cleanup");
        require(bytes==original,"Rejected caller ranges cannot modify compressed source bytes");
    }
    for(unsigned checkpoint=1;checkpoint<=13;++checkpoint) {
        CallbackOwner owner; owner.source=&bytes; owner.throwCheckpoint=checkpoint;
        spz::PackedGaussiansView view; view.numPoints=123;
        rejects([&] { spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view); },
                "Preallocation, per-stream and final callback cancellation propagates");
        require(owner.active==0 && owner.checkpoints==checkpoint && view.numPoints==123,
                "Callback cancellation has no outstanding callback or partially published view");
        owner.release(); empty(owner.budget,"Cancelled packed decode releases caller storage");
    }
}

void malformedContract() {
    const auto bytes=ngsp(attributes(4,3));
    std::vector<Bytes> malformed;
    auto add=[&](auto mutation) { auto broken=bytes; mutation(broken); malformed.push_back(std::move(broken)); };
    add([](Bytes &b) { put(b,16,uint32_t(31)); });
    add([](Bytes &b) { put(b,16,std::numeric_limits<uint32_t>::max()); });
    add([](Bytes &b) { b[15]=5; });
    add([](Bytes &b) { b[15]=255; });
    add([](Bytes &b) { b[12]=5; });
    add([](Bytes &b) { b[13]=25; });
    add([](Bytes &b) { put(b,8,uint32_t(0)); });
    add([](Bytes &b) { put(b,8,std::numeric_limits<uint32_t>::max()); });
    add([](Bytes &b) { put(b,32,std::numeric_limits<uint64_t>::max()); });
    add([](Bytes &b) { put(b,40,uint64_t(1)); });
    add([](Bytes &b) { b.pop_back(); });
    add([](Bytes &b) { b.push_back(0); });
    for(const auto &broken:malformed) {
        CallbackOwner owner; owner.source=&broken; spz::PackedGaussiansView view; view.numPoints=123;
        require(!spz::loadSpzPackedInto(broken.data(),broken.size(),owner.callbacks(),&view) && owner.allocations==0 &&
                    view.numPoints==123 && owner.active==0,
                "Malformed NGSP metadata/TOC/exact end rejects before any caller attribute allocation");
        empty(owner.budget,"Malformed preflight cannot acquire packed grants");
    }
    auto corrupt=bytes;
    const auto toc=number<uint32_t>(corrupt,16); std::size_t offset=toc+6*16;
    for(unsigned stream=0;stream<5;++stream) offset+=std::size_t(number<uint64_t>(corrupt,toc+stream*16));
    corrupt.at(offset)=0; // invalid ZSTD magic only in the final SH stream
    CallbackOwner owner; owner.source=&corrupt; spz::PackedGaussiansView view; view.numPoints=123;
    require(!spz::loadSpzPackedInto(corrupt.data(),corrupt.size(),owner.callbacks(),&view) && owner.allocations==6 &&
                owner.checkpoints==12 && owner.active==0 && view.numPoints==123,
            "Late stream corruption rejects after prior stream work without publishing a partial view");
    owner.release(); empty(owner.budget,"Late codec failure releases all six caller-owned packed grants");
}

struct PackedStage {
    ResourceBudget budget;
    std::stop_source stop;
    std::size_t source{},work{},seen{};
    static void checkpoint(void *context,const char *stage) {
        auto &self=*static_cast<PackedStage *>(context);
        if(std::string_view(stage)!="packed.ready") return;
        ++self.seen;
        require(category(self.budget,ResourceCategory::Source)==self.source &&
                    category(self.budget,ResourceCategory::Work)==self.work &&
                    category(self.budget,ResourceCategory::Decoded)==0,
                "The exact postdecode seam retains Source/full Work before any Decoded allocation");
        self.stop.request_stop();
    }
    explicit PackedStage(ResourceBudget policy,std::size_t sourceBytes,std::size_t workBytes)
        :budget(std::move(policy)),source(sourceBytes),work(workBytes) {
        SpzDecodeTestAccess::checkpoint(&checkpoint,this);
    }
    ~PackedStage() { SpzDecodeTestAccess::checkpoint(nullptr,nullptr); }
};

void productionAdmission(const std::filesystem::path &folder) {
    for(unsigned degree:{0u,1u,2u,3u,4u}) {
        const auto fixture=attributes(4,degree); const auto bytes=ngsp(fixture),original=bytes;
        const auto path=folder/("admitted-v4-sh"+std::to_string(degree)+".spz"); write(path,bytes);
        const auto mtime=std::filesystem::last_write_time(path); const auto packed=fixture.packedBytes();
        require(packed==pointCount*(20+3*dimensions(degree)),"Independent v4 packed byte formula includes all SH4 coefficients");
        auto budget=capped(ResourceCategory::Work,packed);
        {
            const auto scene=loadScene(path,options(budget)); sample(scene,fixture,3);
            require(category(budget,ResourceCategory::Source)==0 && category(budget,ResourceCategory::Work)==0 &&
                        budget.usage().totalBytes==accountedSceneStorageBytes(scene,budget) &&
                        budget.usage().peakBytes==bytes.size()+packed+accountedSceneStorageBytes(scene,budget),
                    "Production SPZ holds Source/full packed Work/sampled Decoded simultaneously, retaining only returned Scene");
        }
        empty(budget,"Returned SPZ Scene destruction releases its output allocation");
        std::size_t admitted=0;
        for(const auto &field:fixture.fields) if(!field.empty()) {
            auto denied=capped(ResourceCategory::Work,admitted+field.size()-1);
            rejects<ResourceBudgetExceeded>([&] { loadScene(path,options(denied,1)); },
                                            "Each production packed allocation must admit before storage, even with one sampled output");
            require(denied.usage().peakBytes==bytes.size()+admitted,"Packed Work denial occurs before the denied field or Decoded output");
            empty(denied,"Partial production packed admission releases Source and all earlier fields");
            admitted+=field.size();
        }
        auto decodedDenied=capped(ResourceCategory::Decoded,3*sizeof(Gaussian)-1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path,options(decodedDenied)); },"Decoded output denial cannot bypass held packed Work");
        require(decodedDenied.usage().peakBytes==bytes.size()+packed,"Output denial preserves the exact preoutput peak");
        empty(decodedDenied,"Output denial destroys all packed owners");
        ResourceBudget total(bytes.size()+packed+3*sizeof(Gaussian)-1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path,options(total)); },"Total admission includes Source plus packed plus sampled output");
        empty(total,"Total overlap denial unwinds all storage");
        auto sourceDenied=capped(ResourceCategory::Source,bytes.size()-1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path,options(sourceDenied)); },"Source denial precedes vendor decode");
        require(sourceDenied.usage().peakBytes==0,"Denied Source cannot allocate packed data"); empty(sourceDenied,"Source denial leaves no grant");
        auto stopBudget=capped(ResourceCategory::Work,packed); PackedStage stopped(stopBudget,bytes.size(),packed);
        auto stoppedOptions=options(stopBudget); stoppedOptions.stop=stopped.stop.get_token();
        rejects([&] { loadScene(path,stoppedOptions); },"Observed postvendor cancellation precedes Decoded allocation");
        require(stopped.seen==1 && stopBudget.usage().peakBytes==bytes.size()+packed,"Postvendor cancellation reaches the exact owned packed boundary once");
        empty(stopBudget,"Postvendor cancellation unwinds Source and packed storage");
        auto prestopped=options(budget); std::stop_source stop; stop.request_stop(); prestopped.stop=stop.get_token();
        const auto priorPeak=budget.usage().peakBytes;
        rejects([&] { loadScene(path,prestopped); },"Precancelled production SPZ cannot enter decode");
        require(budget.usage().peakBytes==priorPeak,"Precancelled load obtains no additional storage"); empty(budget,"Precancelled load leaves no grant");
        require(read(path)==original && std::filesystem::last_write_time(path)==mtime,"SPZ budget/cancel failures preserve source bytes and mtime");
    }
    auto corrupt=ngsp(attributes(4,4)); const auto toc=number<uint32_t>(corrupt,16); std::size_t offset=toc+6*16;
    for(unsigned stream=0;stream<5;++stream) offset+=std::size_t(number<uint64_t>(corrupt,toc+stream*16));
    corrupt[offset]=0; auto budget=capped(ResourceCategory::Work,pointCount*(20+3*24));
    rejects([&] { loadScene(corrupt,options(budget)); },"Production rejects late SH-stream corruption without fallback");
    empty(budget,"Late production corruption releases every packed allocation");
}

void legacyAdmission(const std::filesystem::path &folder) {
    for(unsigned version:{1u,2u,3u}) for(unsigned degree:{0u,1u,2u,3u,4u}) {
        const auto fixture=attributes(version,degree);
        // A valid RDF coordinate extension must remain ignored by the formerly nonseekable legacy route.
        auto extension=coordinates(uint32_t(spz::CoordinateSystem::RDF),37);
        join(extension,record(0x01020304u,Bytes{1,2,3,4}));
        const auto bytes=legacy(fixture,extension),original=bytes;
        const auto expanded=16+fixture.packedBytes()+extension.size();
        require(number<uint32_t>(bytes,bytes.size()-4)==expanded,"Independent gzip trailer agrees with legacy raw fields and extensions");
        const auto path=folder/("admitted-legacy-v"+std::to_string(version)+"-sh"+std::to_string(degree)+".spz"); write(path,bytes);
        auto budget=capped(ResourceCategory::Work,expanded);
        {
            const auto scene=loadScene(path,options(budget)); sample(scene,fixture,3);
            require(scene.gaussians[0].positionOpacity[1]==.25f && scene.gaussians[0].positionOpacity[2]==-.5f &&
                        budget.usage().peakBytes==bytes.size()+expanded+accountedSceneStorageBytes(scene,budget) &&
                        category(budget,ResourceCategory::Work)==0 && category(budget,ResourceCategory::Source)==0,
                    "Flag2 legacy decode uses one admitted raw buffer through conversion and keeps coordinate records ignored");
        }
        empty(budget,"Legacy extension Scene and raw/source owners release all grants");
        auto denied=capped(ResourceCategory::Work,expanded-1);
        rejects<ResourceBudgetExceeded>([&] { loadScene(path,options(denied,1)); },"Legacy extension sampling cannot bypass full raw admission");
        require(denied.usage().peakBytes==bytes.size(),"Legacy raw denial occurs before raw or sampled output"); empty(denied,"Legacy raw denial unwinds Source");
        auto stopBudget=capped(ResourceCategory::Work,expanded); PackedStage stopped(stopBudget,bytes.size(),expanded);
        auto stoppedOptions=options(stopBudget); stoppedOptions.stop=stopped.stop.get_token();
        rejects([&] { loadScene(path,stoppedOptions); },"Legacy postinflate cancellation precedes output allocation");
        require(stopped.seen==1,"Legacy cancellation uses the admitted raw boundary"); empty(stopBudget,"Legacy cancellation releases Source/raw");
        auto corrupt=bytes; corrupt[corrupt.size()-8]^=1;
        rejects([&] { loadScene(corrupt,options(budget)); },"Flag2 legacy CRC corruption preserves validation"); empty(budget,"Legacy CRC failure unwinds raw Work");
        auto trailing=bytes; trailing.push_back(0);
        rejects([&] { loadScene(trailing,options(budget)); },"Flag2 legacy trailing compressed input remains rejected"); empty(budget,"Legacy exact-consumption failure releases Work");
        require(bytes==original && read(path)==original,"Legacy extension failure derivatives do not alter source bytes");
    }
}

void extensionContract() {
    const auto fixture=attributes(4,3);
    auto verify=[&](const Bytes &extensions,spz::CoordinateSystem resolved) {
        const auto bytes=ngsp(fixture,extensions); CallbackOwner owner; owner.source=&bytes; spz::PackedGaussiansView view;
        require(spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view) && view.coordinates==resolved,
                "NGSP extension coordinate resolution preserves pinned valid/drop/first-match rules");
        const auto old=spz::loadSpzPacked(bytes.data(),bytes.size());
        auto oldCoordinates=spz::CoordinateSystem::RUB;
        if(auto coordinate=spz::findExtensionByType<spz::SpzExtensionCoordinateSystemAdobe>(old.extensions)) oldCoordinates=coordinate->resolve();
        require(oldCoordinates==resolved,"Independent extension records agree with the preserved compatible API");
        auto budget=capped(ResourceCategory::Work,fixture.packedBytes());
        { const auto scene=loadScene(bytes,options(budget)); sample(scene,fixture,3,resolved); }
        empty(budget,"Coordinate extension parse retains no unadmitted payload-sized temporary");
    };
    verify(coordinates(uint32_t(spz::CoordinateSystem::RDF)),spz::CoordinateSystem::RDF);
    verify(coordinates(0),spz::CoordinateSystem::RUB);
    verify(coordinates(17),spz::CoordinateSystem::RUB);
    verify(coordinates(uint32_t(spz::CoordinateSystem::RDF),65536),spz::CoordinateSystem::RDF);
    auto unknown=record(0x76543210u,Bytes(65536,0x5a)); join(unknown,coordinates(uint32_t(spz::CoordinateSystem::RDF)));
    verify(unknown,spz::CoordinateSystem::RDF);
    auto shortKnown=record(coordinateType,{1,2}); join(shortKnown,coordinates(uint32_t(spz::CoordinateSystem::RDF)));
    verify(shortKnown,spz::CoordinateSystem::RDF);
    auto duplicate=coordinates(uint32_t(spz::CoordinateSystem::RDF)); join(duplicate,coordinates(uint32_t(spz::CoordinateSystem::RUB)));
    verify(duplicate,spz::CoordinateSystem::RDF);
    auto unspecified=coordinates(0); join(unspecified,coordinates(uint32_t(spz::CoordinateSystem::RDF)));
    verify(unspecified,spz::CoordinateSystem::RUB);
    auto invalid=coordinates(17); join(invalid,coordinates(uint32_t(spz::CoordinateSystem::RDF)));
    verify(invalid,spz::CoordinateSystem::RDF);
    Bytes oversized; append(oversized,coordinateType); append(oversized,uint32_t(4096)); append(oversized,uint32_t(6));
    verify(oversized,spz::CoordinateSystem::RUB); // pinned parser logs/stops rather than failing the whole decode
    Bytes truncated{1,2,3}; verify(truncated,spz::CoordinateSystem::RUB);
    Bytes payload; append(payload,-1.f); append(payload,std::numeric_limits<float>::quiet_NaN()); append(payload,-2.f);
    const auto bytes=ngsp(fixture,record(safeOrbitType,payload)); CallbackOwner owner; owner.source=&bytes; spz::PackedGaussiansView view;
    require(spz::loadSpzPackedInto(bytes.data(),bytes.size(),owner.callbacks(),&view) && view.hasSafeOrbitCamera &&
                view.safeOrbitCamera[0]==-1 && std::isnan(view.safeOrbitCamera[1]) && view.safeOrbitCamera[2]==-2,
            "Safe-orbit fixed-prefix adapter preserves pinned negative/NaN tolerance");
    const auto compatible=spz::loadSpzPacked(bytes.data(),bytes.size());
    const auto camera=spz::findExtensionByType<spz::SpzExtensionSafeOrbitCameraAdobe>(compatible.extensions);
    require(camera && camera->safeOrbitElevationMin==-1 && std::isnan(camera->safeOrbitElevationMax) && camera->safeOrbitRadiusMin==-2,
            "Safe-orbit descriptor agrees with preserved existing record API");
}
} // namespace

void spzAdmissionContracts(const std::filesystem::path &directory) {
    const auto folder=directory/"spz-admission"; std::filesystem::create_directories(folder);
    vendorContract(); malformedContract(); productionAdmission(folder); legacyAdmission(folder); extensionContract();
}
