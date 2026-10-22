// Main-only independent SPZ v4 framing, literal attribute and ownership contracts.
// Expected packed bytes below never call the writer, packGaussian, shValue or
// covariance reconstruction. Only the decoder uses the locked Zstd library.
#include "browser_spz_export.hpp"
#include "native_export_contracts.hpp"
#include "allocation_census.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#define ZSTD_STATIC_LINKING_ONLY
#include <zstd.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <memory>
#include <new>
#include <span>
#include <stdexcept>
#include <string_view>
#include <vector>

extern "C" {
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const std::uint8_t *sv_states_ptr();
const std::uint8_t *sv_output_ptr();
unsigned sv_output_len();
unsigned sv_spz4_output_bound(unsigned,unsigned);
unsigned sv_spz4_work_bound(unsigned,unsigned);
}

namespace {
using namespace preview;
namespace codec = preview::browser_spz_export;
using Bytes = std::vector<std::uint8_t>;
using Streams = std::array<Bytes,6>;
using Json = nlohmann::json;
std::size_t cases{},assertions{},literalExports{},cancelledPhases{},admissionRefusals{},backendRefusals{},bindingRefusals{},streamBoundaryRecords{};
void require(bool value,const char *message) { ++assertions;if(!value) throw std::runtime_error(message); }
template<class Action> void test(Action action) { action();++cases; }
template<class Action> void refuses(Action action) {
    bool refused=false;try { action(); } catch(const std::exception &) { refused=true; }
    require(refused,"Expected native SPZ refusal did not occur");
}
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid && a.scenePayloadBytes==b.scenePayloadBytes && a.ownedRawBytes==b.ownedRawBytes &&
        a.overlapBytes==b.overlapBytes && a.contextBytes==b.contextBytes && a.unionBytes==b.unionBytes &&
        a.liveBlocks==b.liveBlocks && a.liveContexts==b.liveContexts;
}
std::uint64_t little(const std::uint8_t *bytes,unsigned width) {
    std::uint64_t value{};for(unsigned i=0;i<width;++i) value|=std::uint64_t(bytes[i])<<(8*i);return value;
}

// Half literals are exact binary fractions. The first three are DC RGB; the
// following triples exercise signed RUB SH, band-specific 8/16 buckets, ties
// and saturation. The other visible records use uniform -1/4 and zero SH.
constexpr std::array<std::uint16_t,48> half0{
    0xbc00,0x0000,0x3c00,
    0x2800,0xa800,0x2e00, 0xae00,0x3400,0xb800, 0x3000,0xb000,0x0000,
    0x2800,0xae00,0x2e00, 0x3400,0xb400,0x3800, 0xb800,0x3c00,0xbc00,
    0x4000,0xc000,0x0000, 0xa800,0x2800,0xae00, 0x2e00,0xb000,0x3000,
    0x3800,0xb800,0x3400, 0xb400,0x0000,0x3c00, 0x3000,0x2800,0xa800,
    0xbc00,0x4000,0xc000, 0x0000,0x2e00,0xae00, 0x3400,0x3800,0xb800};
constexpr std::array<std::uint8_t,45> sh0{
    136,128,144, 120,160,64, 144,112,128,
    128,112,144, 160,96,192, 64,255,0,
    255,0,128, 128,128,112, 144,112,144,
    192,64,160, 96,128,255, 144,128,128,
    0,255,0, 128,144,112, 160,192,64};
constexpr std::array<std::array<std::uint8_t,9>,4> positions{{
    {0x00,0x02,0x00,0x00,0xfc,0xff,0x00,0x08,0x00},
    {0x00,0xf8,0xff,0x00,0x04,0x00,0x00,0xfe,0xff},
    {}, {0x00,0x10,0x00,0x00,0xf0,0xff,0x00,0x00,0x00}}};
constexpr std::array<std::uint8_t,4> alphas{128,255,0,0};
constexpr std::array<std::array<std::uint8_t,3>,4> colors{{{89,128,166},{147,108,128},{},{118,137,51}}};
constexpr std::array<std::array<std::uint8_t,3>,4> scales{{{160,171,149},{149,160,171},{},{182,138,160}}};
constexpr std::array<std::uint8_t,4> identityRotation{0,0,0,0xc0};
void half(Gaussian &value,unsigned index,std::uint16_t bits) {
    const auto shift=16*(index%2);value.sh[index/2]=(value.sh[index/2]&~(0xffffu<<shift))|(std::uint32_t(bits)<<shift);
}
std::shared_ptr<Scene> fixture(unsigned degree) {
    auto scene=std::make_shared<Scene>();scene->gaussians.resize(4);scene->shDegree=degree;scene->sourceCount=2'000'000;
    auto &a=scene->gaussians[0];a.positionOpacity={.125f,-.25f,.5f,.5f};a.covA={1,0,0,4};a.covB={0,.25f,0,0};
    for(unsigned i=0;i<48;++i) half(a,i,half0[i]);
    auto &b=scene->gaussians[1];b.positionOpacity={-.5f,.25f,-.125f,1};b.covA={.25f,0,0,1};b.covB={0,4,0,0};
    half(b,0,0x3800);half(b,1,0xb800);for(unsigned i=3;i<48;++i) half(b,i,0xb400);
    auto &deleted=scene->gaussians[2];deleted.positionOpacity.fill(std::numeric_limits<float>::quiet_NaN());
    deleted.covA.fill(std::numeric_limits<float>::quiet_NaN());deleted.covB=deleted.covA;deleted.sh.fill(0x7e007e00);
    auto &c=scene->gaussians[3];c.positionOpacity={1,-1,0,0};c.covA={16,0,0,.0625f};c.covB={0,1,0,0};
    half(c,0,0xb400);half(c,1,0x3400);half(c,2,0xc000);
    return scene;
}
MaskStorage fixtureMask() { const std::array<std::uint8_t,4> mask{0,1,3,0};return MaskStorage::copy(mask); }
Streams expected(unsigned degree,std::span<const unsigned> indices) {
    Streams raw;constexpr std::array<unsigned,4> shBytes{0,9,24,45};
    for(auto index:indices) {
        raw[0].insert(raw[0].end(),positions[index].begin(),positions[index].end());raw[1].push_back(alphas[index]);
        raw[2].insert(raw[2].end(),colors[index].begin(),colors[index].end());
        raw[3].insert(raw[3].end(),scales[index].begin(),scales[index].end());
        raw[4].insert(raw[4].end(),identityRotation.begin(),identityRotation.end());
        if(index==0) raw[5].insert(raw[5].end(),sh0.begin(),sh0.begin()+shBytes[degree]);
        else raw[5].insert(raw[5].end(),shBytes[degree],index==1?96:128);
    }
    return raw;
}
void oracle(std::span<const std::uint8_t> bytes,unsigned degree,std::size_t count,const Streams &raw,bool checkDamage=true) {
    const unsigned streams=degree?6:5;
    require(bytes.size()>=32+16*streams,"SPZ header/TOC truncated");
    require(little(bytes.data(),4)==0x5053474eu && little(bytes.data()+4,4)==4,"SPZ v4 magic/version differs from literal header");
    require(little(bytes.data()+8,4)==count && bytes[12]==degree && bytes[13]==12 && bytes[14]==0 && bytes[15]==streams,
            "SPZ count/degree/fraction/flags/stream count differs");
    require(little(bytes.data()+16,4)==32,"SPZ TOC offset differs");
    for(unsigned i=20;i<32;++i) require(bytes[i]==0,"SPZ reserved header byte is nonzero");
    std::size_t offset=32+16*streams;
    for(unsigned i=0;i<streams;++i) {
        const auto compressed=little(bytes.data()+32+16*i,8),size=little(bytes.data()+40+16*i,8);
        require(size==raw[i].size() && compressed>4 && compressed<=bytes.size()-offset,"SPZ TOC length/range differs");
        const auto *frame=bytes.data()+offset;ZSTD_frameHeader header{};
        require(ZSTD_getFrameHeader(&header,frame,std::size_t(compressed))==0 && header.frameType==ZSTD_frame &&
                header.frameContentSize==size && header.checksumFlag==1,"SPZ Zstd frame lacks exact pledged size/checksum");
        require(ZSTD_findFrameCompressedSize(frame,std::size_t(compressed))==compressed,"TOC does not bound exactly one Zstd frame");
        Bytes decoded(static_cast<std::size_t>(size));
        const auto result=ZSTD_decompress(decoded.data(),decoded.size(),frame,std::size_t(compressed));
        require(!ZSTD_isError(result) && result==size && decoded==raw[i],"SPZ decompressed bytes differ from independent literal attributes");
        if(checkDamage) {
            Bytes damaged(frame,frame+compressed);damaged.back()^=1;
            require(ZSTD_isError(ZSTD_decompress(decoded.data(),decoded.size(),damaged.data(),damaged.size())),
                    "Independent decoder accepted a damaged actual frame checksum");
        }
        offset+=std::size_t(compressed);
    }
    require(offset==bytes.size(),"SPZ TOC leaves trailing or missing output bytes");
}
void finish(codec::Job &job,std::size_t quota,const ResourceBudget &budget) {
    double fraction=job.fraction();std::size_t steps{};
    while(!job.complete()) {
        require(++steps<5'000'000,"Bounded SPZ job did not terminate");
        require(job.step(quota)!=codec::Status::Cancelled,"Uncancelled SPZ job cancelled itself");
        const auto &p=job.progress();const auto limit=std::min(quota,std::size_t(65536));
        require(p.lastStepWork<=limit && p.lastStepCodecInputBytes<=limit && p.lastStepCodecOutputBytes<=limit,"SPZ step exceeds its offered work/codec ranges");
        require(std::isfinite(job.fraction()) && job.fraction()>=fraction && job.fraction()<=1,"SPZ progress is not finite/monotone");
        fraction=job.fraction();require(budget.usage().totalBytes==job.retainedBytes(),"SPZ retained payload does not equal actual admitted grants");
    }
    require(job.fraction()==1,"Ready SPZ job has incomplete progress");
}
Bytes encode(const std::shared_ptr<const Scene> &scene,const MaskStorage &mask,unsigned scope,std::size_t quota) {
    const auto bounds=codec::plan(scene->gaussians.size(),scene->shDegree);ResourceBudget budget(bounds.workBytes);
    auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);Bytes bytes;codec::OutputOwner::Pointer output;
    const auto baseline=sv_allocation::snapshot();
    {
        sv_allocation::Scope allocation;
        auto job=codec::Job::create(scene,mask,scope,memory,bounds);
        require(job->sceneOwner()==scene && job->maskOwner().data()==mask.data() && job->scope()==scope,"SPZ capture cloned or changed source/mask/scope");
        require(job->progress().sourcesScanned==0 && job->progress().packedBytes==0 && job->progress().compressedBytes==0,"SPZ creation scans or packs input");
        refuses([&]{job->takeOutput();});finish(*job,quota,budget);
        output=job->takeOutput();require(output->size() && output->size()<=output->capacity() && output->capacity()==bounds.outputCapacity,"SPZ output exceeds exact admitted capacity");
        codec::Job::retire(job);require(budget.usage().totalBytes==output->retainedBytes(),"Completed SPZ job retains scratch/control grants");
    }
    // The independent comparison copy is deliberately outside the producer's
    // allocation scope; only actual native producer storage belongs to C.
    bytes.assign(output->data(),output->data()+output->size());codec::OutputOwner::retire(output);
    require(budget.usage().totalBytes==0,"SPZ output retirement retains a payload grant");
    require(sameCensus(baseline,sv_allocation::snapshot()),"SPZ encode retirement leaks actual C++ blocks/context");return bytes;
}
void literals() {
    constexpr std::array<unsigned,3> all{0,1,3};constexpr std::array<unsigned,1> selected{1};constexpr std::array<unsigned,2> remainder{0,3};
    for(unsigned degree=0;degree<4;++degree) for(unsigned scope=0;scope<3;++scope) test([&] {
        auto scene=fixture(degree);const auto mask=fixtureMask();
        const auto indices=scope==0?std::span<const unsigned>(all):scope==1?std::span<const unsigned>(selected):std::span<const unsigned>(remainder);
        const auto one=encode(scene,mask,scope,1),batch=encode(scene,mask,scope,4096);
        require(one==batch,"SPZ output changes with step partitioning");oracle(one,degree,indices.size(),expected(degree,indices));++literalExports;
    });
}
void planning() {
    for(unsigned degree=0;degree<4;++degree) test([&] {
        const auto small=codec::plan(4,degree),large=codec::plan(1'000'000,degree);
        require(large.inputBytes<=1024*1024 && large.outputCapacity<128u*1024*1024 && small.ownerBytes==large.ownerBytes,"SPZ O(1) planning/control or fixed input bounds differ");
        require(sv_spz4_output_bound(4,degree)==small.outputCapacity && sv_spz4_work_bound(4,degree)==small.workBytes,"C ABI planning differs from codec admission");
    });
    test([] {
        refuses([]{codec::plan(0,0);});refuses([]{codec::plan(1'000'001,0);});refuses([]{codec::plan(1,4);});refuses([]{codec::plan(std::numeric_limits<std::size_t>::max(),3);});
        auto scene=fixture(3);const auto mask=fixtureMask();ResourceBudget budget(64*1024*1024);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        auto bounds=codec::plan(4,3);++bounds.workBytes;refuses([&]{codec::Job::create(scene,mask,0,memory,bounds);});
        refuses([&]{codec::Job::create(scene,mask,3,memory);});refuses([&]{codec::Job::create(scene,mask,0,nullptr);});
        refuses([&]{codec::Job::create(nullptr,mask,0,memory);});refuses([&]{codec::Job::create(scene,MaskStorage::zero(3),0,memory);});
        auto empty=std::make_shared<Scene>();refuses([&]{codec::Job::create(empty,MaskStorage{},0,memory);});
        require(budget.usage().totalBytes==0,"Invalid SPZ planning captures payload grants");
    });
    for(unsigned scope=0;scope<3;++scope) test([&] {
        auto scene=fixture(0);const std::array<std::uint8_t,4> bits{3,2,3,2};const auto mask=MaskStorage::copy(bits);
        ResourceBudget budget(codec::plan(4,0).workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        const auto before=sv_allocation::snapshot();{sv_allocation::Scope allocation;auto job=codec::Job::create(scene,mask,scope,memory);refuses([&]{finish(*job,4096,budget);});codec::Job::retire(job);}
        require(budget.usage().totalBytes==0 && sameCensus(before,sv_allocation::snapshot()),"Empty scope refusal leaks native payload/blocks");
    });
}
void cancellation() {
    const std::array phases{codec::Phase::Count,codec::Phase::Allocate,codec::Phase::Header,codec::Phase::BeginStream,codec::Phase::Pack,codec::Phase::Compress,codec::Phase::Toc,codec::Phase::Ready};
    for(auto phase:phases) test([&] {
        auto scene=fixture(3);const auto mask=fixtureMask();const auto beforeScene=scene->gaussians;ResourceBudget budget(codec::plan(4,3).workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        const auto baseline=sv_allocation::snapshot();{sv_allocation::Scope allocation;auto job=codec::Job::create(scene,mask,0,memory);
            std::size_t steps{};while(job->phase()!=phase) {require(++steps<100000 && !job->complete(),"Cancellation phase is unreachable");job->step(1);}
            job->cancel();require(job->phase()==codec::Phase::Cancelled && job->status()==codec::Status::Cancelled,"Native SPZ cancel did not retire its phase");
            const auto actions=job->progress().actions;require(job->step(4096)==codec::Status::Cancelled && job->progress().actions==actions,"Cancelled SPZ resumed work");
            refuses([&]{job->takeOutput();});job->cancel();codec::Job::retire(job);
        }
        require(budget.usage().totalBytes==0 && sameCensus(baseline,sv_allocation::snapshot()),"Cancelled SPZ retains payload/actual C++ storage");
        require(!std::memcmp(scene->gaussians.data(),beforeScene.data(),4*sizeof(Gaussian)) && mask==fixtureMask(),"Cancel changed the immutable source/deleted mask");++cancelledPhases;
    });
}
class Deny final : public SceneMemory {
  public:
    Deny(std::shared_ptr<SceneMemory> delegate,std::size_t ordinal):delegate_(std::move(delegate)),ordinal_(ordinal) {}
    std::shared_ptr<void> admit(std::size_t bytes) override {if(++calls==ordinal_) throw ResourceBudgetExceeded(bytes,0);return delegate_->admit(bytes);}
    std::size_t calls{};
  private: std::shared_ptr<SceneMemory> delegate_;std::size_t ordinal_;
};
void admissions() {
    auto scene=fixture(3);const auto mask=fixtureMask();bool succeeded=false;
    for(std::size_t ordinal=1;ordinal<128 && !succeeded;++ordinal) test([&] {
        ResourceBudget budget(codec::plan(4,3).workBytes);auto memory=std::make_shared<Deny>(sceneMemoryForBudget(budget,ResourceCategory::Work),ordinal);
        const auto baseline=sv_allocation::snapshot();bool refused=false;
        try {sv_allocation::Scope allocation;auto job=codec::Job::create(scene,mask,0,memory);finish(*job,4096,budget);auto output=job->takeOutput();codec::Job::retire(job);codec::OutputOwner::retire(output);succeeded=true;}
        catch(const ResourceBudgetExceeded &) {refused=true;++admissionRefusals;}
        require(refused||succeeded,"Admission sweep did not exercise its target");require(budget.usage().totalBytes==0 && sameCensus(baseline,sv_allocation::snapshot()),"Admission failure leaks exact native grants/blocks");
    });
    require(succeeded && admissionRefusals>=6,"Admission sweep misses owner/input/output/codec boundaries");
}
std::size_t observedFailures{};
void observe(const sv_allocation::Event &event) noexcept {if(event.kind==sv_allocation::EventKind::BackendFailure) ++observedFailures;}
void backends() {
    auto scene=fixture(3);const auto mask=fixtureMask();bool succeeded=false;
    for(std::size_t ordinal=1;ordinal<256 && !succeeded;++ordinal) test([&] {
        ResourceBudget budget(codec::plan(4,3).workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        const auto baseline=sv_allocation::snapshot();bool refused=false;observedFailures=0;sv_allocation::failBackendAtForContracts(ordinal);
        try {sv_allocation::Scope allocation;auto job=codec::Job::create(scene,mask,0,memory);finish(*job,4096,budget);auto output=job->takeOutput();codec::Job::retire(job);codec::OutputOwner::retire(output);succeeded=true;}
        catch(const std::bad_alloc &) {refused=true;++backendRefusals;}
        sv_allocation::failBackendAtForContracts(0);require(refused?observedFailures==1:observedFailures==0,"Actual C++ fault sweep does not match its single backend refusal");
        require(budget.usage().totalBytes==0 && sameCensus(baseline,sv_allocation::snapshot()),"Actual C++/Zstd backend refusal leaks grants/raw blocks/context");
    });
    require(succeeded && backendRefusals>=10,"Actual C++ fault sweep misses codec/control physical allocations");
}
void boundary() {test([] {
    constexpr std::size_t count=120000;auto source=fixture(0);auto scene=std::make_shared<Scene>();scene->gaussians.assign(count,source->gaussians[0]);scene->sourceCount=4'000'000;
    const auto bytes=encode(scene,MaskStorage::zero(count),0,4096);Streams raw;
    raw[0].reserve(count*9);raw[1].assign(count,128);raw[2].reserve(count*3);raw[3].reserve(count*3);raw[4].reserve(count*4);
    for(std::size_t i=0;i<count;++i) {raw[0].insert(raw[0].end(),positions[0].begin(),positions[0].end());raw[2].insert(raw[2].end(),colors[0].begin(),colors[0].end());raw[3].insert(raw[3].end(),scales[0].begin(),scales[0].end());raw[4].insert(raw[4].end(),identityRotation.begin(),identityRotation.end());}
    require(raw[0].size()>1024*1024,"Generated source misses the real fixed-input boundary");oracle(bytes,0,count,raw,false);streamBoundaryRecords=count;
});}

Json parse(const char *text) {require(text!=nullptr,"Native response is null");return Json::parse(text);}
Json command(const char *text) {return parse(admittedContractCommand(text));}
Json summary() {return command(R"({"command":"summary"})");}
Json completed(const char *request) {auto value=command(request);for(unsigned i=0;value.value("pending",false);++i) {require(i<10000,"Actual binding job did not settle");value=parse(sv_step(4096));}require(value.at("ok")==true,"Binding fixture operation failed");return value;}
Bytes output() {require(sv_output_ptr()!=nullptr && sv_output_len()>0,"Native output is absent");return {sv_output_ptr(),sv_output_ptr()+sv_output_len()};}
void bindings() {
    constexpr std::string_view ply="ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n-1 1 2 -3 -3 -3 1 0 0 0 1 0 0 0\n0 2 3 -3 -3 -3 1 0 0 0 1 0 0 0\n1 3 4 -3 -3 -3 1 0 0 0 1 0 0 0\n";
    require(parse(sv_open(reinterpret_cast<const std::uint8_t *>(ply.data()),ply.size(),0,100,64*1024*1024)).at("count")==3,"Actual binding fixture failed to open");
    std::array<Gaussian,3> original{};std::memcpy(original.data(),sv_scene_ptr(),sizeof(original));auto first=original,second=original;
    for(unsigned i:{0u,2u}) {first[i].positionOpacity[0]+=2;second[i].positionOpacity[0]+=5;}
    require(command(R"({"command":"single","index":1,"operation":0})").at("selected")==1,"Native delete selection failed");
    require(command(R"({"command":"delete"})").at("visible")==2,"Native deleted fixture failed");command(R"({"command":"single","index":2,"operation":0})");
    completed(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");completed(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]})");
    require(command(R"({"command":"undo"})").at("canRedo")==true && !std::memcmp(sv_scene_ptr(),first.data(),sizeof(first)),"Actual binding lacks independent edited/Redo baseline");
    require(command(R"({"command":"export","format":2,"scope":0})").at("ok")==true,"Legacy output baseline failed");
    const auto old=output();const auto baseline=summary();const auto *sceneOwner=sv_scene_ptr();const auto *outputOwner=sv_output_ptr();const auto *maskOwner=sv_states_ptr();
    constexpr std::array<std::uint8_t,3> mask{0,2,1};const auto census=sv_allocation::snapshot();
    const auto kept=[&] {require(summary()==baseline,"SPZ refusal/cancel changed exact native summary/history/budget");require(sv_scene_ptr()==sceneOwner && !std::memcmp(sv_scene_ptr(),first.data(),sizeof(first)),"SPZ refusal/cancel changed edited scene owner/bytes");require(sv_states_ptr()==maskOwner && !std::memcmp(maskOwner,mask.data(),mask.size()),"SPZ refusal/cancel changed selected/deleted mask owner");require(sv_output_ptr()==outputOwner && output()==old,"SPZ refusal/cancel replaced old output");require(sameCensus(census,sv_allocation::snapshot()),"Binding refusal/cancel leaked native storage");};
    for(const char *request:{R"({"command":"export","format":9,"scope":0})",R"({"command":"export","format":8,"scope":3})"}) test([&]{require(command(request).at("ok")==false,"Invalid binding format/scope accepted");kept();++bindingRefusals;});
    test([&]{require(parse(sv_open(reinterpret_cast<const std::uint8_t *>(ply.data()),ply.size(),0,0,64*1024*1024)).at("ok")==false,"Zero loaded-preview cap accepted");kept();++bindingRefusals;});
    for(unsigned steps:{0u,1u,3u,5u}) test([&] {require(command(R"({"command":"export","format":8,"scope":0})").value("pending",false),"Actual v4 binding did not create bounded work");for(unsigned i=0;i<steps;++i) require(parse(sv_step(65536)).value("pending",false),"Tiny export published before cancelled terminal");require(command(R"({"command":"cancel"})").at("ok")==true,"Actual export cancellation failed");kept();++bindingRefusals;});
    test([&]{sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"export","format":8,"scope":0})").at("ok")==false,"Start response gate published an export owner");kept();++bindingRefusals;});
    test([&]{require(command(R"({"command":"export","format":8,"scope":0})").value("pending",false),"Terminal gate fixture did not start");for(unsigned i=0;i<5;++i) require(parse(sv_step(65536)).value("pending",false),"Terminal gate fixture misses five real frames");sv_response::refuseNextSummaryForContracts();require(parse(sv_step(65536)).at("ok")==false,"Terminal response gate published private candidate");kept();++bindingRefusals;});
    test([&]{const auto value=completed(R"({"command":"export","format":8,"scope":0})");const auto bytes=output();require(sv_output_ptr()!=outputOwner && bytes!=old,"Successful v4 did not atomically replace prior output");require(!std::memcmp(sv_scene_ptr(),first.data(),sizeof(first)) && !std::memcmp(sv_states_ptr(),mask.data(),mask.size()) && value.at("canRedo")==true && value.at("contentRevision")==baseline.at("contentRevision"),"Successful export changed edited scene/history");
        Streams raw;raw[0]={0,0x10,0,0,0xf0,0xff,0,0xe0,0xff,0,0x30,0,0,0xd0,0xff,0,0xc0,0xff};raw[1]={186,186};raw[2]=Bytes(6,128);raw[3]=Bytes(6,112);raw[4]={0,0,0,0xc0,0,0,0,0xc0};oracle(bytes,0,2,raw);
        require(command(R"({"command":"redo"})").at("canRedo")==false && !std::memcmp(sv_scene_ptr(),second.data(),sizeof(second)),"Export lost executable exact content Redo");require(command(R"({"command":"undo"})").at("canRedo")==true && !std::memcmp(sv_scene_ptr(),first.data(),sizeof(first)),"Post-export Redo cannot restore exact predecessor");
    });
}
}
int main() {
    try {
        sv_allocation::setObserverForContracts(observe);literals();planning();cancellation();admissions();backends();boundary();bindings();
        sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);
        std::printf("SPLATVIEW_SPZ4_EXPORT_CONTRACTS_PASS {\"status\":\"passed\",\"suites\":7,\"cases\":%zu,\"assertions\":%zu,\"literalExports\":%zu,\"cancelledPhases\":%zu,\"admissionRefusals\":%zu,\"backendRefusals\":%zu,\"bindingRefusals\":%zu,\"streamBoundaryRecords\":%zu}\n",cases,assertions,literalExports,cancelledPhases,admissionRefusals,backendRefusals,bindingRefusals,streamBoundaryRecords);
        return 0;
    } catch(const std::exception &error) {
        sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"SPZ4 export contract failed after %zu cases/%zu assertions: %s\n",cases,assertions,error.what());return 1;
    }
}
