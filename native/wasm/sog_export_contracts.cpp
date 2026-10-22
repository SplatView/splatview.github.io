// Nonshipping original desktop ZIP/WebP bytes, actual admitted CABI and genuine
// grant/backend/response unwind. Original oracle changes namespace/order type
// only; obsolete MEMFS readback failure modes have no shipping call path.
#include "browser_sog_export.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include <webp/encode.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <span>
#include <stdexcept>
#include <vector>

extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const preview::Gaussian *sv_scene_ptr();const std::uint8_t *sv_states_ptr();
const std::uint8_t *sv_output_ptr();unsigned sv_output_len();
}
namespace preview::browser_sog_oracle {
void writeSog(const Scene &,std::span<const std::uint8_t>,const std::filesystem::path &,std::uint32_t,bool,std::stop_token);
}
namespace {
using namespace preview;
namespace direct=preview::browser_export;
namespace sog=preview::browser_sog;
using Json=nlohmann::json;using Bytes=std::vector<std::uint8_t>;
std::size_t cases{},assertions{},byteOracles{},admissionRefusals{},backendRefusals{},codecRefusals{},metadataRefusals{},bindingRefusals{},largeCodecPeak{},largeCodecAllocations{};
bool backendFailed{},watchPublication{},previousReleased{};
const std::uint8_t *previousOutput{};std::size_t previousCapacity{},tailAttempts{};
void observe(const sv_allocation::Event &event) noexcept {
    if(event.kind==sv_allocation::EventKind::BackendFailure)backendFailed=true;
    if(watchPublication&&sv_output_ptr()!=previousOutput) {
        if(event.kind==sv_allocation::EventKind::NewAttempt||event.kind==sv_allocation::EventKind::BackendFailure)++tailAttempts;
        if(event.kind==sv_allocation::EventKind::BlockReleased&&event.payload==previousCapacity)previousReleased=true;
    }
}
void require(bool value,const char *message){++assertions;if(!value)throw std::runtime_error(message);}
template<class Action>void test(Action action){action();++cases;}
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid&&a.scenePayloadBytes==b.scenePayloadBytes&&a.ownedRawBytes==b.ownedRawBytes&&a.overlapBytes==b.overlapBytes&&
        a.contextBytes==b.contextBytes&&a.unionBytes==b.unionBytes&&a.liveBlocks==b.liveBlocks&&a.liveContexts==b.liveContexts;
}
Scene fixture(unsigned degree,std::size_t count=67,bool noisy=false) {
    Scene scene;scene.gaussians.resize(count);scene.shDegree=degree;scene.sourceCount=count;
    std::uint32_t random=0x53564f47;
    for(std::size_t i=0;i<count;++i) {
        Attributes a;a.position={float(int(i%31)-15)*.125f,float(int(i%17)-8)*.25f,float(i%7)*.5f};
        a.scale={.125f,.25f,.5f};a.opacity=float(i%8)/7;
        for(unsigned j=0;j<48;++j){random=random*1664525+1013904223;a.sh[j]=noisy?float(int((random>>8)%4096)-2048)/1024:float(int((i+j)%9)-4)*.125f;}
        scene.gaussians[i]=packGaussian(a);
    }
    return scene;
}
Bytes mask(std::size_t count){Bytes states(count);for(std::size_t i=0;i<count;++i)states[i]=std::uint8_t((i%3==1?1:0)|(i%11==2?2:0));return states;}
Bytes scoped(Bytes states,unsigned scope){for(auto &state:states)if((scope==1&&!(state&1))||(scope==2&&(state&1)))state|=2;return states;}
Bytes readRemove(const std::filesystem::path &path) {
    std::ifstream input(path,std::ios::binary|std::ios::ate);require(bool(input),"Original SOG oracle did not open");
    const auto length=input.tellg();require(length>0,"Original SOG oracle is empty");Bytes bytes(static_cast<std::size_t>(length));input.seekg(0);
    input.read(reinterpret_cast<char *>(bytes.data()),std::streamsize(bytes.size()));require(bool(input),"Original SOG oracle read was incomplete");input.close();std::filesystem::remove(path);return bytes;
}
Bytes oracle(const Scene &scene,const Bytes &source,unsigned format,unsigned scope) {
    const auto states=scoped(source,scope);const auto count=std::count_if(states.begin(),states.end(),[](auto s){return !(s&2);});
    const std::filesystem::path path="/splatview-original-sog-oracle.bin";
    browser_sog_oracle::writeSog(scene,states,path,std::uint32_t(count),format==7,{});return readRemove(path);
}
Bytes ply(const Scene &scene) {
    const std::filesystem::path path="/splatview-sog-fixture.ply";writeVisibleScene(scene,{},path,SceneExportFormat::Ply);return readRemove(path);
}
class RecordingMemory final:public SceneMemory {
  public:
    explicit RecordingMemory(ResourceBudget budget):parent_(sceneMemoryForBudget(std::move(budget),ResourceCategory::Work)){}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        ++calls;if(calls==1)first=bytes;
        if(refuseAt&&calls==refuseAt){refused=true;throw std::runtime_error("Actual SOG allocation grant refused");}
        return parent_->admit(bytes);
    }
    std::size_t calls{},first{},refuseAt{};bool refused{};
  private:std::shared_ptr<SceneMemory> parent_;
};
void plansAndBytes() {
    test([] {
        require(sv_abi_version()==24&&Json::parse(sv_build_identity()).at("capabilities").at("boundedSogExport")==1,"SOG ABI24/capability handshake differs");
        for(unsigned format:{6u,7u})for(unsigned degree=0;degree<=3;++degree) {
            const auto p=direct::plan(format,1'000'000,degree);const auto b=sog::bounds(1'000'000,degree);
            require(p.outputCapacity==b.output&&p.codecBytes==b.codec&&p.sortBytes==8'000'000&&p.maskBytes==1'000'000,"SOG large checked plan differs from loaded-count bounds");
            require(p.workBytes==p.outputCapacity+p.ownerBytes+p.maskBytes+p.sortBytes+p.paletteBytes+p.labelBytes+p.pixelBytes+p.scratchBytes+p.codecBytes,"SOG work plan omitted a simultaneous owner/buffer");
            require(p.outputCapacity==sv_export_output_bound(format,1'000'000,degree)&&p.workBytes==sv_export_work_bound(format,1'000'000,degree),"SOG CABI/native planning differs");
            for(unsigned count:{0u,1'000'001u,std::numeric_limits<unsigned>::max()})require(!sv_export_output_bound(format,count,degree)&&!sv_export_work_bound(format,count,degree),"SOG invalid/overflowing count was admitted");
            require(!sv_export_output_bound(format,1,4)&&!sv_export_work_bound(format,1,4),"SOG invalid SH degree was admitted");
        }
        require(!sv_sog_export_metadata_cleanup_active(),"SOG metadata cleanup authority escaped its fixed builder");
    });
    for(unsigned format:{6u,7u})for(unsigned degree=0;degree<=3;++degree)for(unsigned scope=0;scope<3;++scope)test([&] {
        const auto scene=fixture(degree);const auto states=mask(scene.gaussians.size());const auto expected=oracle(scene,states,format,scope);
        const auto p=direct::plan(format,states.size(),degree);ResourceBudget budget(p.workBytes);auto memory=std::make_shared<RecordingMemory>(budget);
        const auto original=scene.gaussians;const auto originalMask=states;const auto before=sv_allocation::snapshot();
        {
            sv_allocation::Scope census;auto output=direct::encode(scene,states,format,scope,memory,p);
            require(output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"Admitted SOG/SOGS changed complete original desktop ZIP/WebP/metadata bytes");
            require(budget.usage().totalBytes==output->retainedBytes()&&output->capacity()==p.outputCapacity,"SOG retained capacity lost its lifetime grant");
            const auto stats=sog::lastStatistics();(void)stats;
            require(memory->first==p.workBytes&&memory->calls>20,"SOG whole-plan preflight did not precede actual buffer/codec grants");direct::OutputOwner::retire(output);
        }
        const auto stats=sog::lastStatistics();
        require(stats.textures==(degree?7:5)&&stats.codecAllocations>20&&stats.metadataAllocations>20&&stats.peakCodecBytes<=p.codecBytes,"SOG property/metadata/codec payload bypassed scoped admission");
        require(!budget.usage().totalBytes&&!direct::directActive()&&!sv_sog_export_metadata_cleanup_active()&&sameCensus(before,sv_allocation::snapshot()),"SOG successful export retained scratch, cleanup authority or census owner");
        require(!std::memcmp(original.data(),scene.gaussians.data(),original.size()*sizeof(Gaussian))&&states==originalMask,"SOG export mutated its immutable input/masks");++byteOracles;
    });
}
void realRefusals() {
    for(unsigned format:{6u,7u})test([&] {
        const auto scene=fixture(3,5);const auto states=mask(5);const auto p=direct::plan(format,5,3);
        ResourceBudget limited(p.workBytes-1);auto denied=std::make_shared<RecordingMemory>(limited);bool refused=false;
        try{auto output=direct::encode(scene,states,format,0,denied,p);}catch(const ResourceBudgetExceeded&){refused=true;}
        require(refused&&denied->calls==1&&denied->first==p.workBytes&&!limited.usage().totalBytes,"SOG whole-plan quota refusal reached payload work");++admissionRefusals;
        ResourceBudget budget(p.workBytes);auto memory=std::make_shared<RecordingMemory>(budget);
        auto complete=direct::encode(scene,states,format,0,memory,p);const auto calls=memory->calls;direct::OutputOwner::retire(complete);
        require(calls>100&&calls<8192,"SOG actual grant sweep topology is unexpectedly unbounded");
        for(std::size_t ordinal=1;ordinal<=calls;++ordinal) {
            memory->calls=0;memory->refuseAt=ordinal;memory->refused=false;refused=false;const auto before=sv_allocation::snapshot();
            {sv_allocation::Scope census;try{auto output=direct::encode(scene,states,format,0,memory,p);}catch(const std::exception&){refused=true;}}
            const auto stats=sog::lastStatistics();
            require(refused&&memory->refused&&!budget.usage().totalBytes&&!direct::directActive()&&!sv_sog_export_metadata_cleanup_active()&&sameCensus(before,sv_allocation::snapshot()),"SOG grant/codec/metadata construction/dump unwind leaked or terminated");
            ++admissionRefusals;codecRefusals+=stats.codecRefusals;metadataRefusals+=stats.metadataRefusals;
        }
        memory->refuseAt=0;
    });
    require(codecRefusals>0&&metadataRefusals>0,"SOG real grant sweeps missed codec and metadata construction/dump refusals");
    test([] {
        ResourceBudget budget(1024);auto memory=std::make_shared<RecordingMemory>(budget);
        sog::TextureMemory codec(memory,128);const auto *first=sog::allocateWebp(64,1,false);require(first!=nullptr,"Codec cap fixture allocation failed");
        require(sog::allocateWebp(64,1,true)==nullptr,"SOG aggregate codec cap admitted simultaneous excess");bool refused=false;
        try{codec.rethrowFailure();}catch(const std::exception&){refused=true;}
        sog::freeWebp(const_cast<void *>(first));require(refused&&!codec.retainedBytes()&&!budget.usage().totalBytes,"SOG codec cap lost its aligned header/grant on free");++codecRefusals;
    });
    test([] {
        ResourceBudget budget(1024);auto memory=std::make_shared<RecordingMemory>(budget);sog::TextureMemory codec(memory,1024);
        require(!sog::allocateWebp(std::numeric_limits<std::uint64_t>::max(),16,true),"SOG codec integer overflow allocated payload");bool refused=false;
        try{codec.rethrowFailure();}catch(const std::exception&){refused=true;}
        require(refused&&!memory->calls&&!budget.usage().totalBytes,"SOG codec overflow reached an allocation grant");++codecRefusals;
    });
}
void largeTopology() {
    // Full SH palette cardinality plus one averaged leaf. Noisy coefficients
    // make the palette property exceed WebP's small-color palette shortcut.
    for(unsigned format:{6u,7u})test([&] {
        const auto scene=fixture(3,65537,true);const Bytes states(scene.gaussians.size(),0);const auto expected=oracle(scene,states,format,0);
        const auto p=direct::plan(format,states.size(),3);ResourceBudget budget(p.workBytes);auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);
        auto output=direct::encode(scene,states,format,0,memory,p);const auto stats=sog::lastStatistics();
        require(output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"Large SOG palette/metadata/compressed bytes differ from original");
        require(stats.textures==7&&stats.peakCodecBytes>4*983040&&stats.peakCodecBytes<=p.codecBytes&&stats.codecAllocations>100,"Large SOG codec high-water evidence missed real ARGB/ref/histogram/bitwriter topology");
        largeCodecPeak=std::max(largeCodecPeak,stats.peakCodecBytes);largeCodecAllocations+=stats.codecAllocations;
        direct::OutputOwner::retire(output);require(!budget.usage().totalBytes,"Large SOG completion retained its codec/palette workspace");++byteOracles;
    });
}
Json command(const char *text){return Json::parse(admittedContractCommand(text));}
Json summary(){return command("{\"command\":\"summary\"}");}
Bytes outputBytes(){return {sv_output_ptr(),sv_output_ptr()+sv_output_len()};}
void open(unsigned degree,unsigned count) {
    const auto source=fixture(degree,count);const auto input=ply(source);
    require(Json::parse(sv_open(input.data(),input.size(),0,1'000'000,128*1024*1024)).at("ok")==true,"SOG actual binding fixture failed to open");
}
std::string request(unsigned format,unsigned count,unsigned degree,unsigned scope=0) {
    return Json{{"command","export"},{"format",format},{"scope",scope},{"outputCapacity",sv_export_output_bound(format,count,degree)},{"nativeWorkBytes",sv_export_work_bound(format,count,degree)}}.dump();
}
void bindingBytes() {
    for(unsigned degree=0;degree<=3;++degree) {
        open(degree,17);command(R"({"command":"single","index":2,"operation":0})");command(R"({"command":"delete"})");command(R"({"command":"single","index":1,"operation":0})");
        const auto base=summary();Scene scene;scene.gaussians.assign(sv_scene_ptr(),sv_scene_ptr()+17);scene.shDegree=degree;const Bytes states(sv_states_ptr(),sv_states_ptr()+17);
        for(unsigned format:{6u,7u})for(unsigned scope=0;scope<3;++scope)test([&] {
            const auto expected=oracle(scene,states,format,scope);const auto value=command(request(format,17,degree,scope).c_str());
            require(value.at("ok")==true&&outputBytes()==expected,"Actual SOG CABI output differs from original complete ZIP/WebP/JSON bytes");
            for(const char *key:{"revision","contentRevision","canUndo","canRedo","selected","visible","alignment","camera","count","shDegree"})require(value.at(key)==base.at(key),"SOG actual export changed scene/frame/masks/history");
            require(!std::memcmp(sv_scene_ptr(),scene.gaussians.data(),17*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),17),"SOG actual export changed full source or selected/deleted mask");
            require(value.at("exportBytes")==direct::plan(format,17,degree).outputCapacity+sizeof(direct::OutputOwner)&&value.at("exportOutputBytes")==value.at("exportBytes"),"SOG summary omitted retained output capacity/owner");++byteOracles;
        });
    }
}
void bindingFailures() {
    for(unsigned format:{6u,7u})test([&] {
        open(3,5);command(R"({"command":"single","index":1,"operation":0})");command(R"({"command":"delete"})");
        require(command(R"({"command":"undo"})").at("canRedo")==true,"SOG refusal fixture lacks executable Redo");
        const auto text=request(format,5,3);require(command(text.c_str()).at("ok")==true,"SOG previous output fixture failed");
        const auto base=summary();const auto bytes=outputBytes();const auto *owner=sv_output_ptr();const auto *sceneOwner=sv_scene_ptr();const auto *maskOwner=sv_states_ptr();
        const std::vector<Gaussian> records(sceneOwner,sceneOwner+5);const Bytes states(maskOwner,maskOwner+5);const auto census=sv_allocation::snapshot();
        const auto keep=[&] {
            require(summary()==base&&sv_output_ptr()==owner&&outputBytes()==bytes&&sv_scene_ptr()==sceneOwner&&sv_states_ptr()==maskOwner,"Refused SOG actual export replaced old output/scene/frame/history");
            require(!std::memcmp(sv_scene_ptr(),records.data(),5*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),5)&&sameCensus(census,sv_allocation::snapshot())&&!sv_sog_export_metadata_cleanup_active(),"Refused SOG actual export leaked codec/DOM or altered bytes");
        };
        const auto missing=Json{{"command","export"},{"format",format}}.dump();require(Json::parse(sv_command(missing.c_str())).at("ok")==false,"SOG unadmitted export accepted");++bindingRefusals;keep();
        auto wrong=Json::parse(text);wrong["outputCapacity"]=sv_export_output_bound(format,5,3)-1;require(command(wrong.dump().c_str()).at("ok")==false,"SOG mismatched native capacity accepted");++bindingRefusals;keep();
        sv_response::refuseNextSummaryForContracts();require(command(text.c_str()).at("ok")==false,"SOG response refusal published a private candidate");++bindingRefusals;keep();
        bool complete=false;
        for(std::size_t ordinal=1;ordinal<=16384;++ordinal) {
            backendFailed=false;sv_allocation::setObserverForContracts(observe);sv_allocation::failBackendAtForContracts(ordinal);
            const auto *reply=sv_command(text.c_str());sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);const auto value=Json::parse(reply);
            if(backendFailed){require(value.at("ok")==false,"SOG actual backend/codec/metadata refusal was silently accepted");++backendRefusals;++bindingRefusals;keep();}
            else{require(value.at("ok")==true&&outputBytes()==bytes,"SOG exact retry changed deterministic ZIP bytes");complete=true;break;}
        }
        require(complete,"SOG actual backend sweep did not reach exact retry");
        previousOutput=sv_output_ptr();previousCapacity=direct::plan(format,5,3).outputCapacity;previousReleased=false;tailAttempts=0;watchPublication=true;
        sv_allocation::setObserverForContracts(observe);const auto *reply=sv_command(text.c_str());watchPublication=false;sv_allocation::setObserverForContracts(nullptr);
        require(Json::parse(reply).at("ok")==true&&sv_output_ptr()!=previousOutput&&previousReleased&&!tailAttempts&&outputBytes()==bytes,"SOG publication retained old output or allocated after owner retirement");
        require(command(R"({"command":"redo"})").at("visible")==4,"SOG export failures lost executable Redo");
        require(command(R"({"command":"undo"})").at("visible")==5&&!std::memcmp(sv_scene_ptr(),records.data(),5*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),5),"SOG export/Redo/Undo lost exact full scene/masks");
    });
}
} // namespace
int main() {
    try {
        plansAndBytes();realRefusals();largeTopology();bindingBytes();bindingFailures();
        std::printf("SPLATVIEW_SOG_EXPORT_CONTRACTS_PASS cases=%zu assertions=%zu byteOracles=%zu admissionRefusals=%zu backendRefusals=%zu codecRefusals=%zu metadataRefusals=%zu bindingRefusals=%zu largeCodecPeak=%zu largeCodecAllocations=%zu oracleNamespaceAndOrderSignatureOnly=1\n",cases,assertions,byteOracles,admissionRefusals,backendRefusals,codecRefusals,metadataRefusals,bindingRefusals,largeCodecPeak,largeCodecAllocations);return 0;
    }catch(const std::exception &error){watchPublication=false;sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"SOG export contracts failed after %zu cases/%zu assertions: %s\n",cases,assertions,error.what());return 1;}
}
