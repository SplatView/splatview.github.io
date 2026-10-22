// Nonshipping actual CABI, complete original-writer byte oracle and real
// admission/backend teardown. No fault seam enters the shipping encoder.
#include "browser_export_sink.hpp"
#include "browser_spz3_memory.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <span>
#include <stdexcept>
#include <vector>

extern "C" {
unsigned sv_abi_version();
const char *sv_build_identity();
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const preview::Gaussian *sv_scene_ptr();
const std::uint8_t *sv_states_ptr();
const std::uint8_t *sv_output_ptr();
unsigned sv_output_len();
}
namespace {
using namespace preview;
namespace direct = preview::browser_export;
namespace codec = preview::browser_spz3;
using Json = nlohmann::json;
using Bytes = std::vector<std::uint8_t>;
std::size_t cases{},assertions{},byteOracles{},boundaryOracles{},admissionRefusals{},backendRefusals{},codecBackendRefusals{},bindingRefusals{};
bool backendFailed{},codecBackendFailed{};
void observe(const sv_allocation::Event &event) noexcept {
    if(event.kind==sv_allocation::EventKind::BackendFailure) {
        backendFailed=true;
        // Pinned zlib's four arrays each request 64KiB plus our aligned header.
        if(event.payload>=65536&&event.payload<65600)codecBackendFailed=true;
    }
}
void require(bool value,const char *message) { ++assertions;if(!value)throw std::runtime_error(message); }
template<class Action> void test(Action action) { action();++cases; }
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid&&a.scenePayloadBytes==b.scenePayloadBytes&&a.ownedRawBytes==b.ownedRawBytes&&
        a.overlapBytes==b.overlapBytes&&a.contextBytes==b.contextBytes&&a.unionBytes==b.unionBytes&&
        a.liveBlocks==b.liveBlocks&&a.liveContexts==b.liveContexts;
}
std::uint32_t little(const std::uint8_t *p) {
    return std::uint32_t(p[0])|(std::uint32_t(p[1])<<8)|(std::uint32_t(p[2])<<16)|(std::uint32_t(p[3])<<24);
}
Scene fixture(unsigned degree,std::size_t count=257) {
    Scene scene;scene.gaussians.resize(count);scene.shDegree=degree;scene.sourceCount=count;
    for(std::size_t i=0;i<count;++i) {
        Attributes a;a.position={float(int(i%31)-15)*.125f,float(int(i%17)-8)*.25f,float(i%7)*.5f};
        a.scale={.125f,.25f,.5f};a.opacity=float((i%7)+1)/8;
        for(unsigned j=0;j<48;++j)a.sh[j]=float(int((i+j)%9)-4)*.125f;
        scene.gaussians[i]=packGaussian(a);
    }
    return scene;
}
Bytes mask(std::size_t count) {
    Bytes result(count);for(std::size_t i=0;i<count;++i)result[i]=std::uint8_t((i%3==1?1:0)|(i%11==2?2:0));return result;
}
Bytes scoped(Bytes states,unsigned scope) {
    for(auto &state:states)if((scope==1&&!(state&1))||(scope==2&&(state&1)))state|=2;return states;
}
Bytes legacy(const Scene &scene,const Bytes &states,unsigned format,unsigned scope) {
    const auto copy=scoped(states,scope);const std::filesystem::path path="/splatview-spz3-original-oracle.bin";
    writeVisibleScene(scene,copy,path,static_cast<SceneExportFormat>(format));
    std::ifstream input(path,std::ios::binary|std::ios::ate);require(bool(input),"Original serializer oracle did not open");
    const auto length=input.tellg();require(length>0,"Original serializer oracle is empty");
    Bytes result(static_cast<std::size_t>(length));input.seekg(0);input.read(reinterpret_cast<char *>(result.data()),std::streamsize(result.size()));
    require(bool(input),"Original serializer byte oracle read was incomplete");input.close();std::filesystem::remove(path);return result;
}
Bytes decode(std::span<const std::uint8_t> bytes,std::size_t rawSize) {
    constexpr std::array<std::uint8_t,10> header{0x1f,0x8b,8,0,0,0,0,0,0,0xff};
    require(bytes.size()>=20&&std::equal(header.begin(),header.end(),bytes.begin()),"SPZ3 fixed gzip header differs from desktop");
    Bytes raw(rawSize);z_stream stream{};
    require(inflateInit2(&stream,MAX_WBITS+16)==Z_OK,"Independent gzip decoder initialization failed");
    struct Cleanup { z_stream *stream;~Cleanup(){inflateEnd(stream);} } cleanup{&stream};
    stream.next_in=const_cast<Bytef *>(bytes.data());stream.avail_in=static_cast<uInt>(bytes.size());
    stream.next_out=raw.data();stream.avail_out=static_cast<uInt>(raw.size());
    const auto result=inflate(&stream,Z_FINISH);
    require(result==Z_STREAM_END&&stream.total_out==rawSize&&!stream.avail_in,"SPZ3 gzip CRC/ISIZE or complete single-member framing differs");
    require(little(bytes.data()+bytes.size()-4)==rawSize,"SPZ3 gzip ISIZE differs");return raw;
}
void verifyRaw(const Scene &scene,const Bytes &states,unsigned scope,std::span<const std::uint8_t> bytes) {
    const auto copy=scoped(states,scope);const auto count=std::count_if(copy.begin(),copy.end(),[](auto s){return !(s&2);});
    const auto stride=20+3*((scene.shDegree+1)*(scene.shDegree+1)-1);
    const auto raw=decode(bytes,16+std::size_t(count)*stride);
    require(little(raw.data())==0x5053474e&&little(raw.data()+4)==3&&little(raw.data()+8)==count,
            "SPZ3 NGSP/version/count differs from independent raw header");
    require(raw[12]==scene.shDegree&&raw[13]==12&&raw[14]==0&&raw[15]==0,"SPZ3 degree/fraction/flags/extensions differ");
    std::size_t record{};
    for(std::size_t i=0;i<copy.size();++i)if(!(copy[i]&2)) {
        for(unsigned axis=0;axis<3;++axis) {
            const auto quantized=static_cast<std::int32_t>(std::round(double(scene.gaussians[i].positionOpacity[axis])*4096));
            for(unsigned b=0;b<3;++b)require(raw[16+record*9+axis*3+b]==std::uint8_t(std::uint32_t(quantized)>>(8*b)),"SPZ3 signed 24-bit position differs");
        }
        const auto alpha=std::uint8_t(std::clamp(std::round(scene.gaussians[i].positionOpacity[3]*255),0.f,255.f));
        require(raw[16+std::size_t(count)*9+record]==alpha,"SPZ3 alpha stream ordering differs");++record;
    }
}
class RecordingMemory final : public SceneMemory {
  public:
    explicit RecordingMemory(ResourceBudget budget):parent_(sceneMemoryForBudget(std::move(budget),ResourceCategory::Work)){}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        if(calls<requests.size())requests[calls]=bytes;++calls;
        if(refuseAt&&calls==refuseAt){refused=true;throw std::runtime_error("Actual SPZ3 admission refused");}
        return parent_->admit(bytes);
    }
    std::array<std::size_t,128> requests{};std::size_t calls{},refuseAt{};bool refused{};
  private:std::shared_ptr<SceneMemory> parent_;
};
void planning() {
    for(unsigned degree=0;degree<=3;++degree)test([&] {
        for(unsigned count:{1u,52427u,52428u,52429u,1'000'000u}) {
            const auto p=direct::plan(1,count,degree);const std::size_t raw=16+std::size_t(count)*(20+3*((degree+1)*(degree+1)-1));
            require(p.outputCapacity==18+(raw/codec::blockBytes)*codec::compressedBound(codec::blockBytes)+codec::compressedBound(raw%codec::blockBytes),"SPZ3 output bound omits full blocks or final empty tail");
            require(p.inputBytes==codec::blockBytes&&p.compressedBytes==codec::compressedBound(codec::blockBytes)&&p.codecBytes==codec::codecBytes,"SPZ3 work plan omitted fixed gzip buffers/codec");
            require(p.workBytes==p.outputCapacity+p.maskBytes+p.ownerBytes+p.inputBytes+p.compressedBytes+p.codecBytes&&!p.sortBytes,"SPZ3 work plan omits physical retained storage");
            require(sv_export_output_bound(1,count,degree)==p.outputCapacity&&sv_export_work_bound(1,count,degree)==p.workBytes,"SPZ3 native CABI bound differs from writer");
            require(p.outputCapacity<=0x7fffffff&&p.workBytes<=0xffffffff,"SPZ3 native bound overflowed");
        }
    });
    test([] {
        require(sv_abi_version()==24&&Json::parse(sv_build_identity()).at("capabilities").at("boundedSpz3Export")==1,"SPZ3 capability/ABI handshake differs");
        for(unsigned count:{0u,1'000'001u,std::numeric_limits<unsigned>::max()})
            require(!sv_export_output_bound(1,count,0)&&!sv_export_work_bound(1,count,0),"Invalid SPZ3 loaded count was admitted");
        require(!sv_export_output_bound(1,1,4)&&!sv_export_work_bound(1,1,4),"Invalid SPZ3 SH degree was admitted");
    });
}
void byteOraclesAndBoundaries() {
    const auto cell=[&](unsigned degree,unsigned scope,std::size_t count,bool boundary) {
        const auto scene=fixture(degree,count);const auto states=boundary?Bytes(count,0):mask(count);
        const auto expected=legacy(scene,states,1,scope);const auto p=direct::plan(1,count,degree);
        ResourceBudget budget(p.workBytes);auto memory=std::make_shared<RecordingMemory>(budget);
        const auto before=sv_allocation::snapshot();
        {
            sv_allocation::Scope census;auto output=direct::encode(scene,states,1,scope,memory,p);
            require(output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"Admitted SPZ3 changed complete original desktop gzip bytes");
            require(output->capacity()==p.outputCapacity&&budget.usage().totalBytes==output->retainedBytes(),"SPZ3 output lost its actual retained capacity grant");
            require(memory->calls>=11&&memory->requests[0]==p.workBytes&&memory->requests[1]==sizeof(direct::OutputOwner)&&memory->requests[2]==p.outputCapacity&&memory->requests[3]==count&&memory->requests[4]==codec::blockBytes,"SPZ3 payload was allocated before complete admission or used an unadmitted raw buffer");
            verifyRaw(scene,states,scope,{output->data(),output->size()});
            if(boundary&&count==52428)require(output->data()[output->size()-10]==3&&output->data()[output->size()-9]==0,"Exact 1MiB SPZ3 raw payload omitted the always-final empty deflate block");
            direct::OutputOwner::retire(output);
        }
        require(!budget.usage().totalBytes&&!direct::directActive()&&sameCensus(before,sv_allocation::snapshot()),"SPZ3 byte oracle retained work or a census context");
        ++byteOracles;if(boundary)++boundaryOracles;
    };
    for(unsigned degree=0;degree<=3;++degree)for(unsigned scope=0;scope<3;++scope)test([&]{cell(degree,scope,257,false);});
    for(std::size_t count:{52427u,52428u,52429u})test([&]{cell(0,0,count,true);});
}
void admissionAndCodecTeardown() {
    const auto scene=fixture(3,17);const auto states=mask(17);const auto p=direct::plan(1,17,3);
    test([&] {
        ResourceBudget budget(p.workBytes-1);auto memory=std::make_shared<RecordingMemory>(budget);bool refused=false;
        try{auto output=direct::encode(scene,states,1,0,memory,p);}catch(const ResourceBudgetExceeded&){refused=true;}
        require(refused&&memory->calls==1&&memory->requests[0]==p.workBytes&&!budget.usage().totalBytes,"SPZ3 insufficient whole-plan quota reached payload allocation");++admissionRefusals;
    });
    test([&] {
        ResourceBudget budget(p.workBytes);auto memory=std::make_shared<RecordingMemory>(budget);
        auto output=direct::encode(scene,states,1,0,memory,p);const auto calls=memory->calls;direct::OutputOwner::retire(output);
        require(calls>=11&&calls<memory->requests.size(),"SPZ3 real admission sweep has an unexpected bounded shape");
        for(std::size_t ordinal=1;ordinal<=calls;++ordinal) {
            memory->calls=0;memory->refuseAt=ordinal;memory->refused=false;bool refused=false;
            const auto before=sv_allocation::snapshot();
            {sv_allocation::Scope census;try{auto value=direct::encode(scene,states,1,0,memory,p);}catch(const std::exception&){refused=true;}}
            require(refused&&memory->refused&&!budget.usage().totalBytes&&!direct::directActive()&&sameCensus(before,sv_allocation::snapshot()),"SPZ3 actual admission/zalloc refusal leaked storage or escaped through C");++admissionRefusals;
        }
    });
    test([&] {
        ResourceBudget budget(codec::codecBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        for(std::size_t limit:{std::size_t{1},std::size_t{64*1024}}) {
            codec::CodecMemory allocations(memory,limit);z_stream stream{};allocations.configure(stream);
            const auto initialized=deflateInit2(&stream,3,Z_DEFLATED,-MAX_WBITS,8,Z_DEFAULT_STRATEGY);
            if(initialized==Z_OK)deflateEnd(&stream);
            bool refused=false;try{allocations.rethrowFailure();}catch(const std::exception&){refused=true;}
            require(initialized==Z_MEM_ERROR&&refused&&!allocations.retainedBytes()&&!budget.usage().totalBytes,"SPZ3 hard aggregate codec cap did not release partially initialized zlib state");++admissionRefusals;
        }
    });
    test([&] {
        auto invalid=scene;invalid.gaussians[0].positionOpacity[0]=2048;
        ResourceBudget budget(p.workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);bool refused=false;
        try{auto output=direct::encode(invalid,states,1,0,memory,p);}catch(const std::exception&){refused=true;}
        require(refused&&!budget.usage().totalBytes&&!direct::directActive(),"SPZ3 range error retained its begun gzip stream/input/output");
        Bytes empty(states.size(),2);refused=false;
        try{auto output=direct::encode(scene,empty,1,0,memory,p);}catch(const std::exception&){refused=true;}
        require(refused&&!budget.usage().totalBytes&&!direct::directActive(),"SPZ3 empty scope leaked its admitted candidate");
    });
}
void backendTeardown() {
    test([] {
        const auto scene=fixture(0,17);const auto states=mask(17);const auto expected=legacy(scene,states,1,0);const auto p=direct::plan(1,17,0);
        ResourceBudget budget(p.workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);bool succeeded=false;
        for(std::size_t ordinal=1;ordinal<=256;++ordinal) {
            const auto before=sv_allocation::snapshot();backendFailed=false;codecBackendFailed=false;
            {
                sv_allocation::Scope census;sv_allocation::setObserverForContracts(observe);sv_allocation::failBackendAtForContracts(ordinal);
                direct::OutputOwner::Pointer output;
                try{output=direct::encode(scene,states,1,0,memory,p);}catch(const std::exception&){if(!backendFailed)throw;++backendRefusals;if(codecBackendFailed)++codecBackendRefusals;}
                sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
                if(output){require(!backendFailed&&output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"SPZ3 backend retry hid refusal or changed bytes");direct::OutputOwner::retire(output);succeeded=true;}
            }
            require(!budget.usage().totalBytes&&!direct::directActive()&&sameCensus(before,sv_allocation::snapshot()),"SPZ3 backend/zalloc refusal retained payload or context");if(succeeded)break;
        }
        require(succeeded&&codecBackendRefusals>=4,"SPZ3 backend sweep missed real codec array allocation failures");
    });
}
Json command(const char *text){return Json::parse(admittedContractCommand(text));}
Bytes outputBytes(){return {sv_output_ptr(),sv_output_ptr()+sv_output_len()};}
Json summary(){return command("{\"command\":\"summary\"}");}
std::string exportRequest(unsigned count,unsigned degree,unsigned scope=0) {
    return Json{{"command","export"},{"format",1},{"scope",scope},{"outputCapacity",sv_export_output_bound(1,count,degree)},{"nativeWorkBytes",sv_export_work_bound(1,count,degree)}}.dump();
}
void openFixture(unsigned degree,unsigned count) {
    const auto scene=fixture(degree,count);const auto input=legacy(scene,Bytes(count,0),0,0);
    require(Json::parse(sv_open(input.data(),input.size(),0,1'000'000,64*1024*1024)).at("ok")==true,"Actual SPZ3 CABI fixture failed to open");
}
void bindingByteOracles() {
    for(unsigned degree=0;degree<=3;++degree) {
        openFixture(degree,257);command(R"({"command":"single","index":2,"operation":0})");command(R"({"command":"delete"})");command(R"({"command":"single","index":1,"operation":0})");
        const auto baseline=summary();Scene scene;scene.gaussians.assign(sv_scene_ptr(),sv_scene_ptr()+257);scene.shDegree=degree;
        const Bytes states(sv_states_ptr(),sv_states_ptr()+257);
        for(unsigned scope=0;scope<3;++scope)test([&] {
            const auto expected=legacy(scene,states,1,scope);const auto result=command(exportRequest(257,degree,scope).c_str());
            require(result.at("ok")==true&&outputBytes()==expected,"Actual SPZ3 CABI output differs from complete original gzip bytes");
            for(const char *key:{"revision","contentRevision","canUndo","canRedo","selected","visible","count","shDegree","alignment"})require(result.at(key)==baseline.at(key),"SPZ3 CABI export changed captured scene/history/frame");
            require(!std::memcmp(sv_scene_ptr(),scene.gaussians.data(),257*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),257),"SPZ3 CABI export changed complete scene or masks");
            require(result.at("exportBytes")==direct::plan(1,257,degree).outputCapacity+sizeof(direct::OutputOwner)&&result.at("exportOutputBytes")==result.at("exportBytes"),"SPZ3 CABI summary omitted retained output capacity");++byteOracles;
        });
    }
}
void bindingRefusalsAndHistory() {
    test([] {
        openFixture(0,17);command(R"({"command":"single","index":1,"operation":0})");command(R"({"command":"delete"})");require(command(R"({"command":"undo"})").at("canRedo")==true,"SPZ3 refusal fixture lacks executable Redo");
        const auto request=exportRequest(17,0);require(command(request.c_str()).at("ok")==true,"SPZ3 prior output fixture failed");
        const auto baseline=summary();const auto bytes=outputBytes();const auto *owner=sv_output_ptr();const auto *sceneOwner=sv_scene_ptr();const auto *maskOwner=sv_states_ptr();
        const std::vector<Gaussian> records(sceneOwner,sceneOwner+17);const Bytes states(maskOwner,maskOwner+17);const auto census=sv_allocation::snapshot();
        const auto keep=[&] {
            require(summary()==baseline&&sv_output_ptr()==owner&&outputBytes()==bytes&&sv_scene_ptr()==sceneOwner&&sv_states_ptr()==maskOwner,"Refused SPZ3 CABI command changed prior output/owners/history");
            require(!std::memcmp(sv_scene_ptr(),records.data(),17*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),17)&&sameCensus(census,sv_allocation::snapshot()),"Refused SPZ3 CABI command changed bytes or retained native work");
        };
        for(auto invalid:{Json{{"command","export"},{"format",1},{"scope",0}},Json{{"command","export"},{"format",1},{"scope",0},{"outputCapacity",sv_export_output_bound(1,17,0)+1},{"nativeWorkBytes",sv_export_work_bound(1,17,0)}}}) {
            const auto text=invalid.dump();require(Json::parse(sv_command(text.c_str())).at("ok")==false,"SPZ3 missing/mismatched whole plan was accepted");++bindingRefusals;keep();
        }
        sv_response::refuseNextSummaryForContracts();require(command(request.c_str()).at("ok")==false,"SPZ3 response refusal published its private candidate");++bindingRefusals;keep();
        bool succeeded=false;const auto codecBefore=codecBackendRefusals;
        for(std::size_t ordinal=1;ordinal<=512;++ordinal) {
            backendFailed=false;codecBackendFailed=false;sv_allocation::setObserverForContracts(observe);sv_allocation::failBackendAtForContracts(ordinal);
            const char *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
            const auto result=Json::parse(reply);
            if(backendFailed){require(result.at("ok")==false,"SPZ3 CABI hid a genuine backend/zalloc failure");++backendRefusals;++bindingRefusals;if(codecBackendFailed)++codecBackendRefusals;keep();}
            else{require(result.at("ok")==true&&outputBytes()==bytes,"SPZ3 CABI retry did not publish exact previous bytes");succeeded=true;break;}
        }
        require(succeeded&&codecBackendRefusals-codecBefore>=4,"SPZ3 CABI backend sweep missed codec teardown/publication");
        require(command(R"({"command":"redo"})").at("visible")==16,"SPZ3 export refusals lost executable Redo");
        require(command(R"({"command":"undo"})").at("visible")==17&&!std::memcmp(sv_scene_ptr(),records.data(),17*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),17),"SPZ3 export/Redo/Undo lost exact scene or mask");
    });
}
} // namespace
int main() {
    try {
        planning();byteOraclesAndBoundaries();admissionAndCodecTeardown();backendTeardown();bindingByteOracles();bindingRefusalsAndHistory();
        std::printf("SPLATVIEW_SPZ3_EXPORT_CONTRACTS_PASS cases=%zu assertions=%zu byteOracles=%zu boundaryOracles=%zu admissionRefusals=%zu backendRefusals=%zu codecBackendRefusals=%zu bindingRefusals=%zu\n",cases,assertions,byteOracles,boundaryOracles,admissionRefusals,backendRefusals,codecBackendRefusals,bindingRefusals);return 0;
    }catch(const std::exception &error){sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"SPZ3 export contracts failed after %zu cases/%zu assertions: %s\n",cases,assertions,error.what());return 1;}
}
