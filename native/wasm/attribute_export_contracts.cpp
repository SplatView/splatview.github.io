// Main-only direct-sink, complete-byte legacy-writer oracle and admission proof.
// This executable and its backend/refusal observations never enter web assets.
#include "browser_export_sink.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <vector>

extern "C" {
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const preview::Gaussian *sv_scene_ptr();
const std::uint8_t *sv_states_ptr();
const std::uint8_t *sv_output_ptr();
unsigned sv_output_len();
unsigned sv_spz4_output_bound(unsigned,unsigned);
unsigned sv_spz4_work_bound(unsigned,unsigned);
}
namespace {
using namespace preview;
namespace direct = preview::browser_export;
using Json = nlohmann::json;
using Bytes = std::vector<std::uint8_t>;
constexpr std::array<unsigned,5> formats{0,2,3,4,5};
std::size_t cases{}, assertions{}, byteOracles{}, admissionRefusals{}, backendRefusals{};
bool backendFailed{};
void observeBackend(const sv_allocation::Event &event) noexcept {
    if(event.kind==sv_allocation::EventKind::BackendFailure)backendFailed=true;
}
void require(bool condition,const char *message) { ++assertions;if(!condition)throw std::runtime_error(message); }
template<class Action> void test(Action action) { action();++cases; }
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid && a.scenePayloadBytes==b.scenePayloadBytes && a.ownedRawBytes==b.ownedRawBytes &&
        a.overlapBytes==b.overlapBytes && a.contextBytes==b.contextBytes && a.unionBytes==b.unionBytes &&
        a.liveBlocks==b.liveBlocks && a.liveContexts==b.liveContexts;
}
Scene fixture(unsigned degree,std::size_t count=513) {
    Scene scene;scene.gaussians.resize(count);scene.shDegree=degree;scene.sourceCount=9'876'543'210;
    for(std::size_t i=0;i<count;++i) {
        Attributes a;a.position={float(int(i%31)-15)*.125f,float(int(i%17)-8)*.25f,float(i%7)*.5f};
        a.scale={.125f,.25f,.5f};a.opacity=float((i%7)+1)/8;
        for(unsigned j=0;j<48;++j)a.sh[j]=float(int((i+j)%9)-4)*.125f;
        scene.gaussians[i]=packGaussian(a);
    }
    return scene;
}
Bytes mask(std::size_t count) {
    Bytes states(count);for(std::size_t i=0;i<count;++i)states[i]=std::uint8_t((i%3==1?1:0)|(i%11==2?2:0));return states;
}
Bytes oracle(const Scene &scene,const Bytes &source,unsigned format,unsigned scope) {
    auto states=source;for(auto &state:states)if((scope==1&&!(state&1))||(scope==2&&(state&1)))state|=2;
    const std::filesystem::path path="/splatview-attribute-oracle.bin";
    writeVisibleScene(scene,states,path,static_cast<SceneExportFormat>(format));
    std::ifstream input(path,std::ios::binary|std::ios::ate);require(bool(input),"Legacy byte oracle did not open");
    const auto length=input.tellg();require(length>0,"Legacy byte oracle has no complete output");
    Bytes bytes(static_cast<std::size_t>(length));input.seekg(0);input.read(reinterpret_cast<char *>(bytes.data()),std::streamsize(bytes.size()));
    require(bool(input),"Legacy byte oracle read was incomplete");input.close();std::filesystem::remove(path);return bytes;
}
class RecordingMemory final : public SceneMemory {
  public:
    explicit RecordingMemory(ResourceBudget budget):parent_(sceneMemoryForBudget(std::move(budget),ResourceCategory::Work)){}
    std::shared_ptr<void> admit(std::size_t bytes) override {
        if(calls<requests.size())requests[calls]=bytes;++calls;return parent_->admit(bytes);
    }
    std::array<std::size_t,16> requests{};std::size_t calls{};
  private: std::shared_ptr<SceneMemory> parent_;
};
void planning() {
    for(auto format:formats)for(unsigned degree=0;degree<=3;++degree)test([&] {
        const auto p=direct::plan(format,1'000'000,degree);
        require(p.outputCapacity==sv_export_output_bound(format,1'000'000,degree)&&p.workBytes==sv_export_work_bound(format,1'000'000,degree),"Planning ABI differs from admitted writer");
        require(p.outputCapacity<=0x7fffffff&&p.workBytes<=0xffffffff&&p.maskBytes==1'000'000,"Large plan overflowed native byte limits");
        require(p.workBytes==p.outputCapacity+p.maskBytes+p.sortBytes+sizeof(direct::OutputOwner),"Plan omits a physical payload owner");
        if(format==5)require(p.outputCapacity==2'048'004'096,"CSV large bound was silently limited to the SPZ policy");
    });
    test([] {
        for(unsigned format:{9u,std::numeric_limits<unsigned>::max()})
            require(!sv_export_output_bound(format,3,0)&&!sv_export_work_bound(format,3,0),"Unsupported codec/format advertised bounded admission");
        for(auto format:formats) {
            require(!sv_export_output_bound(format,0,0)&&!sv_export_output_bound(format,1'000'001,0)&&!sv_export_output_bound(format,3,4),"Invalid count/degree planning was accepted");
            require(!sv_export_work_bound(format,0,0)&&!sv_export_work_bound(format,1'000'001,0)&&!sv_export_work_bound(format,3,4),"Invalid work plan was accepted");
        }
        require(sv_export_output_bound(8,3,0)==sv_spz4_output_bound(3,0)&&sv_export_work_bound(8,3,0)==sv_spz4_work_bound(3,0),"Shared planning changed the explicit SPZ4 codec bounds");
    });
}
void bytesAndAdmissions() {
    for(auto format:formats)for(unsigned degree=0;degree<=3;++degree)for(unsigned scope=0;scope<3;++scope)test([&] {
        const auto scene=fixture(degree);const auto states=mask(scene.gaussians.size());
        const auto expected=oracle(scene,states,format,scope);
        const auto p=direct::plan(format,states.size(),degree);
        ResourceBudget budget(p.workBytes);auto memory=std::make_shared<RecordingMemory>(budget);
        const auto original=scene.gaussians;const auto originalMask=states;
        {
            sv_allocation::Scope allocations;
            auto output=direct::encode(scene,states,format,scope,memory,p);
            require(output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"Direct sink changed complete desktop serializer bytes");
            require(output->capacity()==p.outputCapacity&&budget.usage().totalBytes==output->retainedBytes(),"Output capacity is not retained by its physical grant");
            require(memory->calls>=4&&memory->requests[0]==p.workBytes&&memory->requests[1]==sizeof(direct::OutputOwner)&&memory->requests[2]==p.outputCapacity&&memory->requests[3]==p.maskBytes,"Admission did not precede the actual owner/output/scope-mask payloads");
            if(format==3)require(memory->calls==5&&memory->requests[4]<=p.sortBytes,"Compressed ordering escaped admitted scratch");
            require(!std::memcmp(scene.gaussians.data(),original.data(),original.size()*sizeof(Gaussian))&&states==originalMask,"Export mutated its source or scope mask");
            direct::OutputOwner::retire(output);
        }
        require(!budget.usage().totalBytes&&!direct::directActive(),"Completed direct export retained payload/context");++byteOracles;
    });
    for(auto format:formats)test([&] {
        const auto scene=fixture(3);const auto states=mask(scene.gaussians.size());const auto p=direct::plan(format,states.size(),3);
        ResourceBudget budget(p.workBytes-1);auto memory=std::make_shared<RecordingMemory>(budget);
        bool refused=false;
        try{auto output=direct::encode(scene,states,format,0,memory,p);}catch(const ResourceBudgetExceeded&){refused=true;}
        require(refused&&memory->calls==1&&memory->requests[0]==p.workBytes&&!budget.usage().totalBytes,"Insufficient whole-operation credit reached payload admission");++admissionRefusals;
    });
}
void backends() {
    for(auto format:formats)test([&] {
        const auto scene=fixture(0,17);const auto states=mask(scene.gaussians.size());const auto p=direct::plan(format,states.size(),0);
        const auto expected=oracle(scene,states,format,0);ResourceBudget budget(p.workBytes);
        auto memory=sceneMemoryForBudget(budget,ResourceCategory::Work);bool succeeded=false;
        for(std::size_t ordinal=1;ordinal<=128;++ordinal) {
            const auto before=sv_allocation::snapshot();bool refused=false;
            {
                sv_allocation::Scope allocations;backendFailed=false;
                sv_allocation::setObserverForContracts(observeBackend);sv_allocation::failBackendAtForContracts(ordinal);
                direct::OutputOwner::Pointer output;
                try {
                    output=direct::encode(scene,states,format,0,memory,p);
                }catch(const std::exception&){if(!backendFailed)throw;refused=true;++backendRefusals;}
                sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
                if(output) {
                    require(!backendFailed&&output->size()==expected.size()&&!std::memcmp(output->data(),expected.data(),expected.size()),"Backend retry changed complete bytes or hid a refusal");
                    direct::OutputOwner::retire(output);succeeded=true;
                }
            }
            require(!budget.usage().totalBytes&&!direct::directActive()&&sameCensus(before,sv_allocation::snapshot()),"Backend refusal leaked a grant, payload or allocation owner");
            require(refused||succeeded,"Backend attempt has no accepted or refused outcome");if(succeeded)break;
        }
        require(succeeded,"Backend refusal sweep never reached a complete retry");
    });
}
Json command(const char *text){return Json::parse(admittedContractCommand(text));}
Bytes outputBytes(){return {sv_output_ptr(),sv_output_ptr()+sv_output_len()};}
void bindingOracles() {
    for(unsigned degree=0;degree<=3;++degree) {
        const auto source=fixture(degree,257);const Bytes clear(source.gaussians.size(),0);
        const auto input=oracle(source,clear,0,0);
        require(Json::parse(sv_open(input.data(),input.size(),0,1'000'000,64*1024*1024)).at("ok")==true,"Actual binding byte-oracle fixture failed to open");
        require(command(R"({"command":"single","index":2,"operation":0})").at("selected")==1,"Binding oracle delete seed failed");
        require(command(R"({"command":"delete"})").at("visible")==256,"Binding oracle delete failed");
        require(command(R"({"command":"single","index":1,"operation":0})").at("selected")==1,"Binding oracle selected scope failed");
        const auto baseline=command("{\"command\":\"summary\"}");
        Scene scene;scene.gaussians.assign(sv_scene_ptr(),sv_scene_ptr()+257);scene.shDegree=degree;
        scene.sourceCount=baseline.at("sourceCount").get<std::uint64_t>();
        Bytes states(sv_states_ptr(),sv_states_ptr()+257);Bytes expectedMask(257,0);expectedMask[1]=1;expectedMask[2]=2;
        require(states==expectedMask,"Actual binding byte-oracle scope mask differs");
        for(auto format:formats)for(unsigned scope=0;scope<3;++scope)test([&] {
            const auto expected=oracle(scene,states,format,scope);
            const auto request=Json{{"command","export"},{"format",format},{"scope",scope}}.dump();
            const auto result=command(request.c_str());
            require(result.at("ok")==true&&outputBytes()==expected,"Actual binding output differs from complete legacy serializer bytes");
            for(const char *key:{"revision","contentRevision","canUndo","canRedo","selected","visible","count","shDegree"})
                require(result.at(key)==baseline.at(key),"Actual binding output changed its captured scene/history");
            require(!std::memcmp(sv_scene_ptr(),scene.gaussians.data(),257*sizeof(Gaussian))&&!std::memcmp(sv_states_ptr(),states.data(),257),"Actual binding output changed complete source records or scope mask");
            ++byteOracles;
        });
    }
}
void bindings() {
    constexpr std::string_view input="ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n0 1 2 -3 -3 -3 1 0 0 0 1 0 0 0\n1 2 3 -3 -3 -3 1 0 0 0 1 0 0 0\n2 3 4 -3 -3 -3 1 0 0 0 1 0 0 0\n";
    require(Json::parse(sv_open(reinterpret_cast<const std::uint8_t*>(input.data()),input.size(),0,100,32*1024*1024)).at("ok")==true,"Binding fixture open failed");
    command(R"({"command":"single","index":1,"operation":0})");command(R"({"command":"delete"})");
    require(command(R"({"command":"undo"})").at("canRedo")==true,"Binding fixture lacks executable Redo");
    for(auto format:formats)test([&] {
        const auto text=Json{{"command","export"},{"format",format},{"scope",0}}.dump();
        require(command(text.c_str()).at("ok")==true,"Admitted binding export failed");
        const auto baseline=command("{\"command\":\"summary\"}");const auto bytes=outputBytes();
        const auto *owner=sv_output_ptr();const auto *sceneOwner=sv_scene_ptr();const auto *maskOwner=sv_states_ptr();
        const auto keep=[&] {
            require(command("{\"command\":\"summary\"}")==baseline&&sv_output_ptr()==owner&&outputBytes()==bytes&&sv_scene_ptr()==sceneOwner&&sv_states_ptr()==maskOwner,"Refused binding export changed prior output/scene/history");
        };
        auto missing=Json::parse(sv_command(text.c_str()));require(missing.at("ok")==false,"Unadmitted direct export was accepted");keep();
        auto wrong=Json{{"command","export"},{"format",format},{"scope",0},{"outputCapacity",sv_export_output_bound(format,3,0)+1},{"nativeWorkBytes",sv_export_work_bound(format,3,0)}}.dump();
        require(command(wrong.c_str()).at("ok")==false,"Mismatched native admission was accepted");keep();
        const auto admitted=Json{{"command","export"},{"format",format},{"scope",0},{"outputCapacity",sv_export_output_bound(format,3,0)},{"nativeWorkBytes",sv_export_work_bound(format,3,0)}}.dump();
        sv_response::refuseNextSummaryForContracts();require(command(admitted.c_str()).at("ok")==false,"Refused response published a private direct output");keep();
        require(baseline.at("exportOutputBytes")==direct::plan(format,3,0).outputCapacity+sizeof(direct::OutputOwner)&&baseline.at("exportBytes")==baseline.at("exportOutputBytes"),"Binding summary omitted the retained direct owner");
    });
    require(command(R"({"command":"redo"})").at("visible")==2,"Export refusal lost executable content Redo");
    require(command(R"({"command":"undo"})").at("visible")==3,"Retained Redo could not restore the exact predecessor");
}
} // namespace
int main() {
    try {
        planning();bytesAndAdmissions();backends();bindingOracles();bindings();
        std::printf("SPLATVIEW_ATTRIBUTE_EXPORT_CONTRACTS_PASS cases=%zu assertions=%zu byteOracles=%zu admissionRefusals=%zu backendRefusals=%zu\n",cases,assertions,byteOracles,admissionRefusals,backendRefusals);return 0;
    }catch(const std::exception &error){sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);std::fprintf(stderr,"Attribute export contracts failed after %zu cases/%zu assertions: %s\n",cases,assertions,error.what());return 1;}
}
