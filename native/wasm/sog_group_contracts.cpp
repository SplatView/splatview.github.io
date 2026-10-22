// Actual grouped bridge with independent literal WebP/analytic-record fixtures.
// Injection and observations exist only in this main, never shipping exports.
#include "browser_sog_group.hpp"
#include "sog_group_contract_data.hpp"
#include "sog_group_v2_contract_data.hpp"
#include "sog_sh_contract_data.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "response.hpp"
#include "json_preflight.hpp"
#include "color.hpp"
#include <webp/decode.h>
#include <emscripten/heap.h>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>
extern "C" {
unsigned sv_abi_version();
const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_open_group(double,double,double,double,double,double,double);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const uint8_t *sv_output_ptr();
unsigned sv_output_len();
unsigned sv_source_hash_create();
unsigned sv_source_hash_begin(unsigned,double);
unsigned sv_source_hash_update(unsigned,double,unsigned,unsigned);
unsigned sv_source_hash_finish(unsigned);
unsigned sv_source_hash_digest(unsigned,unsigned,unsigned);
unsigned sv_source_hash_delete(unsigned);
}
namespace {
using namespace preview;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
using View=std::array<float,11>;
constexpr unsigned nativeBudget=512*1024*1024,rawWork=64*1024*1024;
size_t cases{},checks{},numericRefusals{},descriptorRefusals{},metadataHeaderRefusals{},admissionRefusals{},
    publicationRefusals{},redoChecks{},independentRecords{},borrowedRetirements{};
size_t v2Cases{},v2Checks{},v2IndependentRecords{},v2BorrowedRetirements{},v2HeaderRefusals{},
    v2SampledRefusals{},v2UnsampledAcceptances{},v2HashChecks{},v2PublicationRefusals{};
size_t shSuites{},shPackets{},shPolicyCases{},shChecks{},shIndependentRecords{},shBorrowedRetirements{},
    shHeaderRefusals{},shSampledRefusals{},shPolicyAcceptances{},shUnsampledAcceptances{},shHashChecks{},
    shBlobChecks{},shPhysicalRolePlanes{},shAdmissionRefusals{},shPublicationRefusals{},shRedoChecks{};
double shMaximumPositionError{},shMaximumOpacityError{},shMaximumCovarianceScaledError{};
double maximumPositionError{},maximumOpacityError{},maximumCovarianceScaledError{};
bool watchingPlanes{};size_t planeAllocations{},planeBytes{};
bool awaitingRolePlane{},invalidRolePlane{};size_t rolePlanes{},rolePlaneBytes{},physicalRolePlanes{};
size_t expectedRolePlaneBytes{16};
bool watchingShPlanes{};size_t watchedShCentroidBytes{},shObservedPlanes{},shObservedPlaneBytes{};
void observe(const sv_allocation::Event &event) noexcept {
    if(watchingPlanes&&event.kind==sv_allocation::EventKind::BlockAllocated&&event.payload==16) {
        ++planeAllocations;planeBytes+=event.payload;
    }
    if(awaitingRolePlane&&event.kind==sv_allocation::EventKind::BlockAllocated&&event.payload) {
        invalidRolePlane|=event.payload!=expectedRolePlaneBytes;awaitingRolePlane=false;
        ++rolePlanes;rolePlaneBytes+=event.payload;
    }
    if(watchingShPlanes&&event.kind==sv_allocation::EventKind::BlockAllocated&&
       (event.payload==16||event.payload==watchedShCentroidBytes)) {
        ++shObservedPlanes;shObservedPlaneBytes+=event.payload;
    }
}
void require(bool value,const char *message) {++checks;if(!value)throw std::runtime_error(message);}
template<size_t N> Bytes bytes(const uint8_t (&value)[N]) {return {value,value+N};}
Json parsed(const char *text) {require(text!=nullptr,"Null grouped SOG response");const auto value=Json::parse(text);require(value.contains("ok"),"Malformed grouped SOG response");return value;}
Json command(const Json &input) {const auto text=input.dump();return parsed(admittedContractCommand(text.c_str()));}
Json named(const char *name) {return command({{"command",name}});}
Json current() {return named("summary");}
std::vector<Gaussian> scene() {const auto count=current().at("count").get<size_t>();return {sv_scene_ptr(),sv_scene_ptr()+count};}
Bytes masks() {const auto count=current().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+count};}
Bytes output() {const auto count=sv_output_len();return {sv_output_ptr(),sv_output_ptr()+count};}
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b) {return a.size()==b.size()&&!std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));}
void put(Bytes &descriptor,size_t offset,uint32_t value) {for(size_t i=0;i<4;++i)descriptor.at(offset+i)=uint8_t(value>>(i*8));}
struct Packet {
    Bytes block,descriptor;
    size_t originalBytes{},rewriteOffset{};
};
std::array<Bytes,5> resources() {return {bytes(sogAppearance),bytes(sogExtra),bytes(sogHigh),bytes(sogLow),bytes(sogRotation)};}
Json rewriteAliases(Json meta) {
    meta["means"]["files"]={"r0003.webp","r0002.webp","r0001.webp"};
    meta["scales"]["files"]={"r0000.webp"};meta["quats"]["files"]={"r0004.webp"};meta["sh0"]["files"]={"r0000.webp"};return meta;
}
Json rewritten() {return rewriteAliases(Json::parse(std::begin(sogOriginalMeta),std::end(sogOriginalMeta)));}
Packet encodedPacket(Bytes original,const Json &metadata,std::span<const Bytes> members) {
    Packet p;p.block=std::move(original);p.descriptor.resize(20+members.size()*4);put(p.descriptor,0,0x47535653);put(p.descriptor,4,1);put(p.descriptor,8,unsigned(members.size()));put(p.descriptor,12,unsigned(p.block.size()));
    for(size_t i=0;i<members.size();++i) {put(p.descriptor,20+i*4,unsigned(members[i].size()));p.block.insert(p.block.end(),members[i].begin(),members[i].end());}
    p.originalBytes=p.block.size();p.rewriteOffset=p.block.size();const auto text=metadata.dump();put(p.descriptor,16,unsigned(text.size()));p.block.insert(p.block.end(),text.begin(),text.end());return p;
}
Packet packet(const Json &metadata=rewritten(),const std::array<Bytes,5> &members=resources()) {return encodedPacket(bytes(sogOriginalMeta),metadata,members);}
Json openGroup(const Packet &p,unsigned cap=1'000'000,unsigned budget=nativeBudget,unsigned work=rawWork) {
    return parsed(sv_open_group(double(reinterpret_cast<uintptr_t>(p.block.data())),double(p.block.size()),
        double(reinterpret_cast<uintptr_t>(p.descriptor.data())),double(p.descriptor.size()),cap,budget,work));
}
Json openBundle(unsigned cap=1'000'000) {return parsed(sv_open(sogBundle,sizeof(sogBundle),unsigned(InputFormat::Sog),cap,nativeBudget));}
Scene observeDecoderPlanes(const Packet &p,unsigned cap) {
    const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);
    LoadOptions options;options.maxSplats=cap;options.maxBytes=nativeBudget;options.resources=ResourceBudget(nativeBudget);
    constexpr std::array<const char *,5> roles{"r0003.webp","r0002.webp","r0000.webp","r0004.webp","r0000.webp"};
    size_t resourceReads=0;rolePlanes=rolePlaneBytes=0;awaitingRolePlane=invalidRolePlane=false;
    sv_allocation::Scope allocationScope;
    auto decoded=browser_sog_group::load([&](const std::string &name) {
        if(name!="meta.json") {
            require(resourceReads<10&&name==roles[resourceReads%5],"Grouped decoder changed physical role read order");
            // The first five reads belong to the complete header preflight.
            // Arm only the next admitted allocation after each actual texture
            // read. fitBounds has separate admitted float scratch which can
            // also have payload16; it must not be labelled as a codec plane.
            if(resourceReads>=5) {
                require(!awaitingRolePlane,"Grouped texture read did not admit its preceding role plane");
                awaitingRolePlane=true;
            }
            ++resourceReads;
        }
        return group.read(name);
    },options,group.originalBytes());
    require(resourceReads==10&&!awaitingRolePlane&&!invalidRolePlane&&rolePlanes==5&&rolePlaneBytes==80,
        "Grouped SOG did not decode/admit five physical role planes");
    require(sceneMemorySharesLedger(decoded.gaussians.get_allocator().memory(),*options.resources)&&
        accountedSceneStorageBytes(decoded,*options.resources)==decoded.gaussians.capacity()*sizeof(Gaussian)&&
        options.resources->usage().categoryBytes[size_t(ResourceCategory::Decoded)]==decoded.gaussians.capacity()*sizeof(Gaussian),
        "Grouped Gaussian storage did not retain its actual memory admission");
    physicalRolePlanes+=rolePlanes;return decoded;
}
Json finish(Json value) {
    for(size_t step=0;value.value("pending",false);++step) {require(step<1000,"SOG old edit did not finish");value=parsed(sv_step(16));require(value["ok"]==true,"SOG old edit failed");}return value;
}
Json center(std::array<float,3> point) {
    const auto view=current().at("camera").get<View>();require(named("beginTransaction")["ok"]==true,"Old SOG checkpoint failed");
    const auto result=finish(command({{"command","alignCenter"},{"point",point},{"camera",view},{"defaultCamera",view}}));
    require(named("commitTransaction")["ok"]==true,"Old SOG checkpoint commit failed");return result;
}
std::vector<Gaussian> redoData;
void oldEditedDocument() {
    require(openBundle()["ok"]==true,"Old bundled SOG baseline refused");
    require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true&&named("delete")["ok"]==true&&
        command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true,"Old SOG masks failed");
    center({.25f,-.5f,.75f});center({-.1f,.2f,.3f});redoData=scene();
    require(named("undo")["ok"]==true&&current()["canRedo"]==true,"Old SOG executable Redo missing");
    require(command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true&&!output().empty(),"Old SOG export failed");
}
struct Retained {
    Json summary;std::vector<Gaussian> data;Bytes states,exported;const Gaussian *scenePointer;const uint8_t *maskPointer,*outputPointer;
};
Retained retain() {return {current(),scene(),masks(),output(),sv_scene_ptr(),sv_states_ptr(),sv_output_ptr()};}
void unchanged(const Retained &old,bool countLegacy=true) {
    const auto now=current();require(sv_scene_ptr()==old.scenePointer&&sv_states_ptr()==old.maskPointer&&sv_output_ptr()==old.outputPointer&&same(scene(),old.data)&&masks()==old.states&&output()==old.exported,"Refused SOG group changed old scene/masks/export storage");
    for(const auto *key:{"loaded","count","sourceCount","shDegree","format","kind","selected","visible","canUndo","canRedo","revision","contentRevision","camera","alignment","floor","transaction","pending"})
        require(now.at(key)==old.summary.at(key),"Refused SOG group changed old metadata/history/default");
    require(named("redo")["ok"]==true&&same(scene(),redoData)&&masks()==old.states,"Refused SOG group lost executable Redo");
    require(named("undo")["ok"]==true&&same(scene(),old.data)&&masks()==old.states,"Redo/Undo did not restore old SOG state");if(countLegacy)++redoChecks;else ++shRedoChecks;
}
void independent(const std::vector<Gaussian> &actual,unsigned cap,const char *oracle=sogExpectedRecords) {
    const auto expected=Json::parse(oracle);const auto ids=expected.at(cap==1?"cap1SourceIds":cap==2?"cap2SourceIds":"allSourceIds").get<std::vector<size_t>>();
    require(actual.size()==ids.size(),"SOG membership count differs from independent oracle");
    for(size_t i=0;i<ids.size();++i) {
        const auto &g=actual[i];const auto &e=expected.at("records")[ids[i]];const auto position=e.at("positionRub").get<std::array<double,3>>();
        for(size_t k=0;k<3;++k) {const double error=std::abs(double(g.positionOpacity[k])-position[k]);maximumPositionError=std::max(maximumPositionError,error);require(error<=2e-6,"SOG position/member order differs from literal analytic oracle");}
        const double opacity=std::abs(double(g.positionOpacity[3])-e.at("opacity").get<double>());maximumOpacityError=std::max(maximumOpacityError,opacity);require(opacity<=3e-7,"SOG opacity differs from literal oracle");
        const auto scales=e.at("linearScales").get<std::array<double,3>>();const double normalization=std::max({scales[0]*scales[0],scales[1]*scales[1],scales[2]*scales[2]});
        const auto covariance=e.at("covarianceRub").get<std::array<double,6>>();const std::array<float,6> values{g.covA[0],g.covA[1],g.covA[2],g.covA[3],g.covB[0],g.covB[1]};
        for(size_t k=0;k<6;++k) {const auto error=std::abs(double(values[k])-covariance[k])/normalization;maximumCovarianceScaledError=std::max(maximumCovarianceScaledError,error);require(error<=8e-6,"SOG covariance differs from analytic oracle");}
        const auto dc=e.at("packedDcHalf").get<std::array<float,3>>();for(size_t k=0;k<3;++k)require(shValue(g,0,unsigned(k))==dc[k],"SOG packed DC differs from independent half oracle");
        const auto absent=e.at("absentShHalfBits").get<std::vector<uint16_t>>();require(absent.size()==45,"Wrong absent-band oracle length");
        for(size_t k=0;k<absent.size();++k) {const auto slot=k+3;require(uint16_t(g.sh[slot/2]>>(16*(slot%2)))==absent[k],"SOG absent-band signed-zero bits differ");}
        require(g.covB[2]==0&&g.covB[3]==0,"SOG covariance padding changed");++independentRecords;
    }
}
void successBorrowAndBundle() {
    ++cases;require(sv_abi_version()==24,"Grouped SOG requires native ABI24");
    for(unsigned cap:{3u,2u,1u}) {
        auto p=packet();const auto original=p.block,descriptor=p.descriptor;
        const auto value=openGroup(p,cap);
        require(value["ok"]==true&&value["sourceCount"]==3&&value["count"]==cap&&value["shDegree"]==0&&value["format"]=="SOG v1"&&value["yUp"]==true,"Grouped SOG typed summary differs");
        const auto observed=observeDecoderPlanes(p,cap);
        require(same(scene(),{observed.gaussians.begin(),observed.gaussians.end()}),"Observed grouped decoder differs from actual bridge publication");
        require(p.block==original&&p.descriptor==descriptor,"Native decoder modified original or rewritten input");
        const auto decoded=scene();independent(decoded,cap);require(value["canUndo"]==false&&value["canRedo"]==false&&value["alignment"]["branchId"]==0&&value["floor"].is_null(),"Group open retained old edit/session authority");
        std::fill(p.block.begin(),p.block.end(),uint8_t(0x55));std::fill(p.descriptor.begin(),p.descriptor.end(),uint8_t(0xaa));p.block.clear();p.block.shrink_to_fit();p.descriptor.clear();p.descriptor.shrink_to_fit();
        require(same(scene(),decoded)&&command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true,"Group scene borrows retired input storage");++borrowedRetirements;
        require(openBundle(cap)["ok"]==true&&same(scene(),decoded),"Grouped records differ from unchanged bundled v1 path");
    }
    auto p=packet();const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);LoadOptions options;options.maxSplats=3;options.maxBytes=nativeBudget;options.resources=ResourceBudget(nativeBudget);
    size_t extraReads=0;auto decoded=browser_sog_group::load([&](const std::string &name){if(name=="r0001.webp")++extraReads;return group.read(name);},options,group.originalBytes());
    require(extraReads==0&&decoded.sourceBytes==p.originalBytes&&decoded.sourceContentKey.empty()&&decoded.sourceFileIdentity.empty()&&!decoded.defaultView,"Grouped source borrowed identity/preferences or decoded unused declared extra");
    independent({decoded.gaussians.begin(),decoded.gaussians.end()},3);
    for(const char *name:{"../r0000.webp","./r0000.webp","r0005.webp","R0000.webp","r00000.webp","positions-low.webp"}) {bool refused=false;try{group.read(name);}catch(const std::exception &){refused=true;}require(refused,"Grouped read callback accepted noncanonical alias");}
}
void badNumericAndSpans() {
    ++cases;oldEditedDocument();const auto p=packet();const std::array<double,7> good{double(reinterpret_cast<uintptr_t>(p.block.data())),double(p.block.size()),double(reinterpret_cast<uintptr_t>(p.descriptor.data())),double(p.descriptor.size()),3,nativeBudget,rawWork};
    for(size_t field=0;field<good.size();++field) for(double bad:{std::numeric_limits<double>::quiet_NaN(),std::numeric_limits<double>::infinity(),-1.,.5,4294967296.}) {
        const auto old=retain();auto args=good;args[field]=bad;
        require(parsed(sv_open_group(args[0],args[1],args[2],args[3],args[4],args[5],args[6]))["ok"]==false,"Bad numeric grouped argument was admitted");unchanged(old);++numericRefusals;
    }
    for(size_t field:{size_t(0),size_t(2),size_t(4),size_t(5),size_t(6)}) {const auto old=retain();auto args=good;args[field]=0;require(parsed(sv_open_group(args[0],args[1],args[2],args[3],args[4],args[5],args[6]))["ok"]==false,"Zero grouped pointer/budget was admitted");unchanged(old);++numericRefusals;}
    for(unsigned invalid=0;invalid<6;++invalid) {
        const auto old=retain();auto args=good;
        switch(invalid) {case 0:args[0]=double(emscripten_get_heap_size());break;case 1:args[2]=double(emscripten_get_heap_size());break;case 2:args[1]=double(emscripten_get_heap_size());break;case 3:args[3]=double(emscripten_get_heap_size());break;case 4:args[2]=args[0]+1;break;case 5:args[4]=1'000'001;break;}
        require(parsed(sv_open_group(args[0],args[1],args[2],args[3],args[4],args[5],args[6]))["ok"]==false,"Invalid grouped span/cap was admitted");unchanged(old);++numericRefusals;
    }
}
void badDescriptorsAndPredecode() {
    ++cases;oldEditedDocument();
    for(unsigned invalid=0;invalid<12;++invalid) {
        auto p=packet();const auto old=retain();
        switch(invalid) {case 0:put(p.descriptor,0,0);break;case 1:put(p.descriptor,4,2);break;case 2:put(p.descriptor,8,0);break;case 3:put(p.descriptor,8,41);break;case 4:put(p.descriptor,12,0);break;case 5:put(p.descriptor,16,0);break;case 6:put(p.descriptor,12,16*1024*1024+1);break;case 7:put(p.descriptor,16,16*1024*1024+1);break;case 8:p.descriptor.push_back(0);break;case 9:p.block.push_back(0);break;case 10:p.block.pop_back();break;case 11:put(p.descriptor,20,256*1024*1024);break;}
        require(openGroup(p)["ok"]==false,"Malformed grouped descriptor/block admitted");unchanged(old);++descriptorRefusals;
    }
    for(unsigned invalid=0;invalid<11;++invalid) {
        auto meta=rewritten();auto members=resources();
        switch(invalid) {case 0:meta["version"]=2;break;case 1:meta["shN"]={{"files",Json::array({"r0000.webp","r0004.webp"})}};break;case 2:meta["means"]["shape"]={5,3};break;case 3:meta["means"]["shape"]={3,4};break;case 4:meta["means"]["files"][1]="r0005.webp";break;case 5:members[0].resize(12);break;case 6:meta["sh0"]["mins"]={0};break;case 7:meta["quats"]["files"]=Json::array();break;case 8:meta["sh0"]["files"]={"r0001.webp"};break;case 9:meta["version"]=1.5;break;
        case 10:
            require(members[0].size()>25&&members[0][12]=='V'&&members[0][15]=='L'&&members[0][20]==0x2f,"Header mutation requires the literal VP8L fixture");
            members[0][21]=2; // width3 instead of2; all compressed role data remains unchanged.
            {int width=0,height=0;require(WebPGetInfo(members[0].data(),members[0].size(),&width,&height)&&width==3&&height==2,"Malformed layout fixture lacks independently readable header");}
            break;
        }
        const auto p=packet(meta,members),oldPacket=p;const auto old=retain();watchingPlanes=true;planeAllocations=planeBytes=0;const auto failed=openGroup(p);watchingPlanes=false;
        require(failed["ok"]==false&&planeAllocations==0&&planeBytes==0,"Bad grouped metadata/late-role header allocated an RGBA plane");require(p.block==oldPacket.block&&p.descriptor==oldPacket.descriptor,"Refused group mutated borrowed bytes");unchanged(old);++metadataHeaderRefusals;
    }
    auto p=packet();const auto old=retain();p.block.resize(p.rewriteOffset+3);p.block[p.rewriteOffset]='{';p.block[p.rewriteOffset+1]='"';p.block[p.rewriteOffset+2]='x';put(p.descriptor,16,3);
    require(openGroup(p)["ok"]==false,"Malformed grouped rewritten JSON admitted");unchanged(old);++metadataHeaderRefusals;
}
void admissionAndActualResponseGate() {
    ++cases;oldEditedDocument();const auto p=packet();
    {
        const auto old=retain();watchingPlanes=true;planeAllocations=0;const auto failed=openGroup(p,3,rawWork+unsigned(p.block.size()+p.descriptor.size()));watchingPlanes=false;
        require(failed["ok"]==false&&planeAllocations==0,"Grouped retained-old/source/headroom admission occurred after plane allocation");unchanged(old);++admissionRefusals;
    }
    {
        const auto old=retain();const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);ResourceLimits limits;limits.totalBytes=nativeBudget;limits.categoryBytes[size_t(ResourceCategory::Work)]=79;LoadOptions options;options.maxBytes=nativeBudget;options.resources=ResourceBudget(limits);
        bool refused=false;try{const sv_json::ParsedSogMetadata metadata(std::string_view(reinterpret_cast<const char *>(group.read("meta.json").data()),group.read("meta.json").size()));browser_sog_group::preflight(metadata.get(),[&](const std::string &name){return group.read(name);},options);}catch(const ResourceBudgetExceeded &){refused=true;}
        require(refused,"Complete physical RGBA plan ignored Work-category admission");unchanged(old);++admissionRefusals;
    }
    const auto old=retain();sv_response::refuseNextSummaryForContracts();const auto failed=openGroup(p);require(failed["ok"]==false&&failed["error"]=="Invalid native response","Actual grouped prepublication response gate did not refuse");unchanged(old);++publicationRefusals;
    // One-shot hook must be consumed; the same well-formed input now publishes.
    require(openGroup(p)["ok"]==true,"Grouped response failure latch poisoned later publication");
}
using ResourceMap=std::map<std::string,Bytes>;
ResourceMap v2Resources() {return {{"appearance.webp",bytes(sogV2Appearance)},{"declared-extra.bin",bytes(sogV2Extra)},
    {"positions-high.webp",bytes(sogV2High)},{"positions-low.webp",bytes(sogV2Low)},{"rotations.webp",bytes(sogV2Rotation)}};}
Bytes textBytes(const std::string &text) {return {text.begin(),text.end()};}
Packet v2Packet(Bytes original=bytes(sogV2OriginalMeta),const ResourceMap &resources=v2Resources()) {
    auto meta=Json::parse(original);std::map<std::string,std::string> aliases;std::vector<Bytes> members;
    for(const auto &[name,data]:resources) {char alias[11];std::snprintf(alias,sizeof(alias),"r%04zu.webp",members.size());aliases.emplace(name,alias);members.push_back(data);}
    for(const char *role:{"means","scales","quats","sh0"}) for(auto &file:meta.at(role).at("files")) {
        const auto found=aliases.find(file.get<std::string>());file=found==aliases.end()?"r0039.webp":found->second;
    }
    return encodedPacket(std::move(original),meta,members);
}
std::array<uint8_t,32> nativeDigest(std::span<const uint8_t> data,bool countV2=true) {
    const auto handle=sv_source_hash_create();require(handle!=0,"Native fixture hash owner unavailable");
    std::array<uint8_t,32> result{};
    require(sv_source_hash_begin(handle,double(data.size()))==0&&
        sv_source_hash_update(handle,0,unsigned(reinterpret_cast<uintptr_t>(data.data())),unsigned(data.size()))==0&&
        sv_source_hash_finish(handle)==0&&sv_source_hash_digest(handle,unsigned(reinterpret_cast<uintptr_t>(result.data())),unsigned(result.size()))==0,
        "Native fixture original-byte hash failed");
    require(sv_source_hash_delete(handle)==0,"Native fixture hash owner did not retire");if(countV2)++v2HashChecks;return result;
}
std::string hex(std::span<const uint8_t> data) {
    constexpr char digits[]="0123456789abcdef";std::string result;result.reserve(data.size()*2);
    for(const auto byte:data) {result.push_back(digits[byte>>4]);result.push_back(digits[byte&15]);}return result;
}
void big(Bytes &output,uint64_t value,unsigned count) {for(unsigned i=count;i>0;--i)output.push_back(uint8_t(value>>((i-1)*8)));}
void v2SourceKey(const Bytes &original,ResourceMap resources,const char *name) {
    const auto vectors=Json::parse(sogV2SourceKeyVectors);const Json *expected=nullptr;
    for(const auto &value:vectors.at("vectors")) if(value.at("name")==name)expected=&value;
    require(expected!=nullptr,"Independent v2 source key vector missing");resources.emplace("meta.json",original);
    Bytes frame;constexpr char domain[]="SplatViewSource\0v1\0";frame.insert(frame.end(),domain,domain+sizeof(domain)-1);frame.push_back(1);big(frame,resources.size(),4);
    size_t total=0,ordinal=0;
    for(const auto &[path,data]:resources) {
        const auto digest=nativeDigest(data);const auto &record=expected->at("resources").at(ordinal++);
        require(record.at("path")==path&&record.at("byteLength")==data.size()&&record.at("sha256")==hex(digest),"Independent v2 original resource bytes/hash changed");
        frame.push_back(path=="meta.json");big(frame,path.size(),4);frame.insert(frame.end(),path.begin(),path.end());big(frame,data.size(),8);frame.insert(frame.end(),digest.begin(),digest.end());total+=data.size();
    }
    require(expected->at("resourceCount")==resources.size()&&expected->at("totalBytes")==total&&expected->at("canonicalByteLength")==frame.size()&&
        expected->at("canonicalHex")==hex(frame)&&expected->at("assetDigest")==hex(nativeDigest(frame)),"Independent v2 canonical source frame/key differs");
}
uint16_t exactHalf(float value) {
    const auto bits=std::bit_cast<uint32_t>(value);const auto sign=uint16_t((bits>>16)&0x8000);const unsigned fraction=bits&0x7fffff,encoded=(bits>>23)&255;
    if(encoded==0&&fraction==0)return sign;
    const int exponent=int(encoded)-127;
    require(encoded!=255&&exponent>=-24&&exponent<=15,"Independent DC is not a finite exact half");
    if(exponent>=-14) {require((fraction&0x1fff)==0,"Independent DC needs unqualified half rounding");return uint16_t(sign|unsigned(exponent+15)<<10|fraction>>13);}
    const unsigned significand=fraction|0x800000,shift=unsigned(-exponent-1);
    require((significand&((1u<<shift)-1))==0,"Independent subnormal DC needs rounding");return uint16_t(sign|significand>>shift);
}
void independentV2(const std::vector<Gaussian> &actual,unsigned cap) {
    independent(actual,cap,sogV2ExpectedRecords);const auto oracle=Json::parse(sogV2ExpectedRecords);
    const auto ids=oracle.at(cap==1?"cap1SourceIds":cap==2?"cap2SourceIds":"allSourceIds").get<std::vector<size_t>>();
    for(size_t row=0;row<ids.size();++row) for(size_t channel=0;channel<3;++channel) {
        const auto expected=exactHalf(oracle.at("records")[ids[row]].at("packedDcHalf")[channel].get<float>());
        require(uint16_t(actual[row].sh[channel/2]>>(16*(channel%2)))==expected,"V2 exact DC half/sign bits differ from independent oracle");
    }
    v2IndependentRecords+=actual.size();
}
void v2SuccessAndIdentity() {
    ++cases;++v2Cases;const auto original=bytes(sogV2OriginalMeta);auto resources=v2Resources();v2SourceKey(original,resources,"original-complete-group");
    for(unsigned cap:{3u,2u,1u}) {
        auto p=v2Packet();const auto block=p.block,descriptor=p.descriptor;const auto value=openGroup(p,cap);
        require(value["ok"]==true&&value["format"]=="SOG v2"&&value["sourceCount"]==3&&value["count"]==cap&&value["shDegree"]==0&&value["yUp"]==true,"V2 grouped typed summary differs");
        const auto observed=observeDecoderPlanes(p,cap);const auto decoded=scene();require(same(decoded,{observed.gaussians.begin(),observed.gaussians.end()}),"Observed v2 decoder differs from actual publication");independentV2(decoded,cap);
        require(p.block==block&&p.descriptor==descriptor&&value["canUndo"]==false&&value["canRedo"]==false&&value["alignment"]["branchId"]==0&&value["floor"].is_null(),"V2 publication mutated source or retained edit authority");
        std::fill(p.block.begin(),p.block.end(),uint8_t(0x55));std::fill(p.descriptor.begin(),p.descriptor.end(),uint8_t(0xaa));p.block.clear();p.block.shrink_to_fit();p.descriptor.clear();p.descriptor.shrink_to_fit();
        require(same(scene(),decoded)&&command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true&&!output().empty(),"V2 published scene borrows retired inputs");++v2BorrowedRetirements;
        require(parsed(sv_open(sogV2Bundle,sizeof(sogV2Bundle),unsigned(InputFormat::Sog),cap,nativeBudget))["ok"]==true&&same(scene(),decoded),"V2 grouped records differ from unchanged bundled decoder");
    }
    const auto p=v2Packet();const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);LoadOptions options;options.maxSplats=3;options.maxBytes=nativeBudget;options.resources=ResourceBudget(nativeBudget);
    size_t extraReads=0;const auto decoded=browser_sog_group::load([&](const std::string &name){if(name=="r0001.webp")++extraReads;return group.read(name);},options,group.originalBytes());
    require(extraReads==0&&decoded.sourceBytes==p.originalBytes&&decoded.sourceContentKey.empty()&&decoded.sourceFileIdentity.empty()&&!decoded.defaultView,"V2 source bytes acquired decoder/identity/preferences or used undeclared plane");independentV2({decoded.gaussians.begin(),decoded.gaussians.end()},3);
    resources["declared-extra.bin"].back()='!';v2SourceKey(original,resources,"declared-extra-last-byte-changed");const auto changed=v2Packet(original,resources);require(openGroup(changed,3)["ok"]==true,"Changed declared extra refused valid v2 decode");independentV2(scene(),3);
}
ResourceMap v2CaseResources(const Json &test) {
    auto resources=v2Resources();const auto name=test.at("name").get<std::string>();
    for(const auto &change:test.at("resourceChanges")) {
        const auto path=change.at("path").get<std::string>();
        if(change.at("omitted")==true) {resources.erase(path);continue;}
        Bytes data;
        if(name=="referenced-scale-codebook-index")data=bytes(sogV2BadScaleIndexAppearance);
        else if(name=="referenced-dc-codebook-index")data=bytes(sogV2BadDcIndexAppearance);
        else if(name=="referenced-overflow-codebook-index")data=bytes(sogV2UsedOverflowAppearance);
        else if(name=="referenced-quaternion-mode")data=bytes(sogV2BadModeRotation);
        else if(name=="property-layout-mismatch")data=bytes(sogV2BadLayoutAppearance);
        else if(name=="truncated-required-webp") {data=bytes(sogV2Low);data.resize(12);}
        else require(false,"Unknown independent v2 resource override");
        require(change.at("bytes")==data.size()&&change.at("sha256")==hex(nativeDigest(data)),"V2 resource override differs from independent literal bytes");resources[path]=std::move(data);
    }
    return resources;
}
void v2MetadataAndSampledRefusals() {
    ++cases;++v2Cases;const auto tests=Json::parse(sogV2Cases);
    for(const auto &test:tests.at("cases")) {
        const auto name=test.at("name").get<std::string>(),original=test.at("originalMetadata").get<std::string>();const auto resources=v2CaseResources(test);const auto p=v2Packet(textBytes(original),resources),copy=p;
        if(test.at("accepted")==true) {
            require(openGroup(p,3)["ok"]==true&&current()["sourceCount"]==3&&current()["format"]=="SOG v2","V2 native fractional/unused-overflow acceptance differs");independentV2(scene(),3);
            if(name=="version-count-fractional")v2SourceKey(textBytes(original),resources,"fractional-version-and-count-truncate-to-v2-three");
        } else {
            oldEditedDocument();const auto old=retain();watchingPlanes=true;planeAllocations=planeBytes=0;const auto value=openGroup(p,3);watchingPlanes=false;
            require(value["ok"]==false,"Independent invalid v2 input published a document");
            const bool sampled=name=="scales-referenced-f32-overflow"||name=="sh0-referenced-f32-overflow"||name=="scales-exp-overflow"||name=="scales-exp-underflow"||
                name=="scales-covariance-overflow"||name=="scales-covariance-underflow"||name=="sh0-half-overflow"||name=="referenced-scale-codebook-index"||
                name=="referenced-dc-codebook-index"||name=="referenced-overflow-codebook-index"||name=="referenced-quaternion-mode";
            require(planeAllocations==(sampled?5u:0u)&&planeBytes==(sampled?80u:0u),"V2 header/static refusal allocated a plane or sampled refusal bypassed actual decoder");
            if(sampled)++v2SampledRefusals;else ++v2HeaderRefusals;unchanged(old);
            if(name=="referenced-scale-codebook-index"||name=="referenced-dc-codebook-index"||name=="referenced-overflow-codebook-index"||name=="referenced-quaternion-mode") {
                require(openGroup(p,1)["ok"]==true,"Unsampled invalid source0 was eagerly validated");independentV2(scene(),1);++v2UnsampledAcceptances;
            }
        }
        require(p.block==copy.block&&p.descriptor==copy.descriptor,"V2 accepted/refused input mutated original or rewritten bytes");
    }
}
void v2NumericBoolAndPublication() {
    ++cases;++v2Cases;auto original=Json::parse(std::begin(sogV2OriginalMeta),std::end(sogV2OriginalMeta));
    original["means"]["mins"][0]=false;original["means"]["maxs"][0]=true;original["scales"]["codebook"][0]=false;original["sh0"]["codebook"][0]=true;
    const auto p=v2Packet(textBytes(original.dump()));require(openGroup(p,3)["ok"]==true,"Captured v2 float bool conversion was refused");const auto actual=scene();
    original["means"]["mins"][0]=0;original["means"]["maxs"][0]=1;original["scales"]["codebook"][0]=0;original["sh0"]["codebook"][0]=1;
    require(openGroup(v2Packet(textBytes(original.dump())),3)["ok"]==true&&same(scene(),actual),"V2 numeric/bool float conversions differ");
    oldEditedDocument();const auto valid=v2Packet();const auto old=retain();sv_response::refuseNextSummaryForContracts();const auto refused=openGroup(valid,3);
    require(refused["ok"]==false&&refused["error"]=="Invalid native response","V2 actual completed-candidate response gate did not refuse");unchanged(old);++v2PublicationRefusals;
    require(openGroup(valid,3)["ok"]==true,"V2 publication refusal poisoned later valid replacement");independentV2(scene(),3);
}
const Json &shExpected() {static const auto value=Json::parse(sogShDraftExpected);return value;}
const Json &shKeys() {static const auto value=Json::parse(sogShDraftKeys);return value;}
const Json &shBindings() {static const auto value=Json::parse(sogShDraftBindings);return value;}
constexpr std::array<const char *,6> shNames{"v1-sh1","v1-sh2","v1-sh3","v2-sh1","v2-sh2","v2-sh3"};
std::span<const uint8_t> shBlob(const std::string &path) {
    for(const auto &binding:shBindings().at("blobs")) if(binding.at("path")==path) {
        const auto name=binding.at("name").get<std::string>();constexpr std::string_view prefix="sogShDraftBlob";
        require(name.starts_with(prefix),"Higher-SH fixture symbol prefix changed");const auto digits=name.substr(prefix.size());
        require(!digits.empty()&&std::all_of(digits.begin(),digits.end(),[](char digit){return digit>='0'&&digit<='9';}),"Higher-SH fixture symbol index malformed");
        const auto index=std::stoul(digits);require(index<std::size(sogShDraftBlobs),"Higher-SH fixture symbol out of range");return sogShDraftBlobs[index];
    }
    throw std::runtime_error("Missing independently bound higher-SH fixture blob: "+path);
}
Bytes shBytes(const std::string &path) {const auto value=shBlob(path);return {value.begin(),value.end()};}
std::array<uint8_t,32> shDigest(std::span<const uint8_t> data) {++shHashChecks;return nativeDigest(data,false);}
ResourceMap shResources(const std::string &name) {
    ResourceMap result;
    for(const auto *file:{"appearance.webp","centroids.webp","declared-extra.bin","labels.webp","positions-high.webp","positions-low.webp","rotations.webp"})
        result.emplace(file,shBytes(name+"/"+file));
    return result;
}
Packet shPacket(Bytes original,const ResourceMap &resources) {
    auto meta=Json::parse(original);std::map<std::string,std::string> aliases;std::vector<Bytes> members;
    for(const auto &[name,data]:resources) {char alias[11];std::snprintf(alias,sizeof(alias),"r%04zu.webp",members.size());aliases.emplace(name,alias);members.push_back(data);}
    for(const char *role:{"means","scales","quats","sh0","shN"}) {
        if(!meta.contains(role)||meta.at(role).is_null())continue;
        for(auto &file:meta.at(role).at("files")) {
            const auto found=aliases.find(file.get<std::string>());file=found==aliases.end()?"r0039.webp":found->second;
        }
    }
    return encodedPacket(std::move(original),meta,members);
}
void shSourceKey(const Bytes &original,ResourceMap resources,const Json &expected) {
    resources.emplace("meta.json",original);Bytes frame;constexpr char domain[]="SplatViewSource\0v1\0";
    frame.insert(frame.end(),domain,domain+sizeof(domain)-1);frame.push_back(1);big(frame,resources.size(),4);
    size_t total=0,ordinal=0;
    require(expected.at("resources").size()==resources.size(),"Higher-SH source key resource count changed");
    for(const auto &[path,data]:resources) {
        const auto digest=shDigest(data);const auto &record=expected.at("resources").at(ordinal++);
        require(record.at("path")==path&&record.at("byteLength")==data.size()&&record.at("sha256")==hex(digest),"Higher-SH original resource bytes/hash changed");
        frame.push_back(path=="meta.json");big(frame,path.size(),4);frame.insert(frame.end(),path.begin(),path.end());big(frame,data.size(),8);
        frame.insert(frame.end(),digest.begin(),digest.end());total+=data.size();
    }
    require(expected.at("resourceCount")==resources.size()&&expected.at("totalBytes")==total&&expected.at("canonicalByteLength")==frame.size()&&
        expected.at("canonicalHex")==hex(frame)&&expected.at("assetDigest")==hex(shDigest(frame)),"Higher-SH independent complete source key differs");
}
void independentSh(const std::vector<Gaussian> &actual,unsigned cap,const Json &expected) {
    const auto ids=expected.at(cap==1?"cap1SourceIds":cap==2?"cap2SourceIds":"allSourceIds").get<std::vector<size_t>>();
    require(actual.size()==ids.size(),"Higher-SH membership/order differs from independent fixture");
    const auto &policy=expected.at("numericPolicy");
    for(size_t row=0;row<ids.size();++row) {
        const auto &g=actual[row];const auto &e=expected.at("records").at(ids[row]);const auto position=e.at("positionRub").get<std::array<double,3>>();
        for(size_t axis=0;axis<3;++axis) {
            const auto error=std::abs(double(g.positionOpacity[axis])-position[axis]);shMaximumPositionError=std::max(shMaximumPositionError,error);
            require(error<=policy.at("positionsAbsolute").get<double>(),"Higher-SH position differs from independent analytic fixture");
        }
        const auto opacityError=std::abs(double(g.positionOpacity[3])-e.at("opacity").get<double>());shMaximumOpacityError=std::max(shMaximumOpacityError,opacityError);
        require(opacityError<=policy.at("opacityAbsolute").get<double>(),"Higher-SH opacity differs from independent analytic fixture");
        const auto scales=e.at("linearScales").get<std::array<double,3>>();const auto normalization=std::max({scales[0]*scales[0],scales[1]*scales[1],scales[2]*scales[2]});
        const auto covariance=e.at("covarianceRub").get<std::array<double,6>>();const std::array<float,6> values{g.covA[0],g.covA[1],g.covA[2],g.covA[3],g.covB[0],g.covB[1]};
        for(size_t slot=0;slot<6;++slot) {
            const auto error=std::abs(double(values[slot])-covariance[slot])/normalization;shMaximumCovarianceScaledError=std::max(shMaximumCovarianceScaledError,error);
            require(error<=policy.at("covarianceRelativeToMaxAxisVariance").get<double>(),"Higher-SH covariance differs from independent analytic fixture");
        }
        const auto halves=e.at("packedShHalfBits").get<std::array<uint16_t,48>>();
        for(size_t slot=0;slot<halves.size();++slot)
            require(uint16_t(g.sh[slot/2]>>(16*(slot%2)))==halves[slot],"Higher-SH active/inactive packed half bits or signed zeros differ");
        require(std::bit_cast<uint32_t>(g.covB[2])==0&&std::bit_cast<uint32_t>(g.covB[3])==0,"Higher-SH covariance padding changed");++shIndependentRecords;
    }
}
std::array<std::string,7> shRoles(const Json &meta) {
    return {meta.at("means").at("files").at(0).get<std::string>(),meta.at("means").at("files").at(1).get<std::string>(),
        meta.at("scales").at("files").at(0).get<std::string>(),meta.at("quats").at("files").at(0).get<std::string>(),
        meta.at("sh0").at("files").at(0).get<std::string>(),meta.at("shN").at("files").at(0).get<std::string>(),meta.at("shN").at("files").at(1).get<std::string>()};
}
std::array<size_t,7> shRoleBytes(const browser_sog_group::Group &group,const std::array<std::string,7> &roles) {
    std::array<size_t,7> payloads{};
    for(size_t role=0;role<roles.size();++role) {
        const auto data=group.read(roles[role]);int width=0,height=0;
        require(WebPGetInfo(data.data(),data.size(),&width,&height)&&width>0&&height>0,"Expected higher-SH role header malformed");
        payloads[role]=imagePayloadBytes(unsigned(width),unsigned(height));
    }
    return payloads;
}
Scene observeShDecoderPlanes(const Packet &p,unsigned cap) {
    const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);const auto metadata=group.read("meta.json");
    const auto meta=Json::parse(metadata.begin(),metadata.end());const auto roles=shRoles(meta);const auto payloads=shRoleBytes(group,roles);
    LoadOptions options;options.maxSplats=cap;options.maxBytes=nativeBudget;options.resources=ResourceBudget(nativeBudget);
    size_t reads=0;rolePlanes=rolePlaneBytes=0;awaitingRolePlane=invalidRolePlane=false;
    sv_allocation::Scope allocationScope;
    auto decoded=browser_sog_group::load([&](const std::string &name) {
        if(name!="meta.json") {
            require(reads<14&&name==roles[reads%7],"Higher-SH physical role read order changed");
            if(reads<7)require(rolePlanes==0&&!awaitingRolePlane,"Higher-SH decoder allocated RGBA before all seven header checks");
            else {
                require(!awaitingRolePlane,"Higher-SH texture read did not admit its preceding plane");
                expectedRolePlaneBytes=payloads[reads-7];awaitingRolePlane=true;
            }
            ++reads;
        }
        return group.read(name);
    },options,group.originalBytes());
    size_t total=0;for(const auto value:payloads)total+=value;
    require(reads==14&&!awaitingRolePlane&&!invalidRolePlane&&rolePlanes==7&&rolePlaneBytes==total,"Higher-SH decoder did not admit all seven full physical planes");
    require(roles[2]==roles[4],"Higher-SH fixture lost the shared-original physical-role admission control");
    require(sceneMemorySharesLedger(decoded.gaussians.get_allocator().memory(),*options.resources)&&
        accountedSceneStorageBytes(decoded,*options.resources)==decoded.gaussians.capacity()*sizeof(Gaussian)&&
        options.resources->usage().categoryBytes[size_t(ResourceCategory::Decoded)]==decoded.gaussians.capacity()*sizeof(Gaussian)&&
        options.resources->usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Higher-SH planes failed retirement or decoded payload admission");
    shPhysicalRolePlanes+=rolePlanes;expectedRolePlaneBytes=16;return decoded;
}
void shSuccessAndIdentity() {
    ++shSuites;const auto identity=Json::parse(sv_build_identity());require(identity.at("abi")==23&&identity.at("capabilities").at("groupedSog")==3,"Higher-SH core capability is not coherent");
    require(shBindings().at("blobs").size()==std::size(sogShDraftBlobs),"Higher-SH blob table/count changed");
    for(const auto &binding:shBindings().at("blobs")) {
        const auto data=shBlob(binding.at("path").get<std::string>());
        require(binding.at("bytes")==data.size()&&binding.at("sha256")==hex(shDigest(data)),"Higher-SH embedded source blob differs from independent binding");++shBlobChecks;
    }
    for(const auto *name:shNames) {
        ++shPackets;const auto original=shBytes(std::string(name)+"/meta.json");const auto resources=shResources(name);
        const auto &expected=shExpected().at("packets").at(name);const auto &keys=shKeys().at("packets").at(name);
        shSourceKey(original,resources,keys.at("vectors").at(0));
        const auto bundle=shBlob(std::string(name)+"/bundled.sog");const auto &bundleKey=keys.at("bundledSingleFileVector");
        require(bundleKey.at("totalBytes")==bundle.size()&&bundleKey.at("resources").size()==1&&
            bundleKey.at("resources").at(0).at("byteLength")==bundle.size()&&bundleKey.at("resources").at(0).at("sha256")==hex(shDigest(bundle)),"Higher-SH bundle fixture bytes/hash changed");
        for(unsigned cap:{3u,2u,1u}) {
            auto p=shPacket(original,resources);const auto before=p;const auto value=openGroup(p,cap);
            require(value["ok"]==true&&value["count"]==cap&&value["sourceCount"]==3&&value["shDegree"]==expected.at("shDegree")&&
                value["format"]==expected.at("format")&&value["yUp"]==true,"Higher-SH actual grouped summary differs");
            const auto observed=observeShDecoderPlanes(p,cap);const auto decoded=scene();
            require(same(decoded,{observed.gaussians.begin(),observed.gaussians.end()}),"Observed higher-SH decoder differs from actual C ABI publication");independentSh(decoded,cap,expected);
            require(p.block==before.block&&p.descriptor==before.descriptor&&observed.sourceBytes==p.originalBytes&&observed.sourceContentKey.empty()&&
                observed.sourceFileIdentity.empty()&&!observed.defaultView,"Higher-SH borrowed source mutated or acquired native provenance/preferences");
            require(value["canUndo"]==false&&value["canRedo"]==false&&value["alignment"]["branchId"]==0&&value["floor"].is_null(),"Higher-SH publication retained prior edit/session authority");
            std::fill(p.block.begin(),p.block.end(),0x55);std::fill(p.descriptor.begin(),p.descriptor.end(),0xaa);p.block.clear();p.block.shrink_to_fit();p.descriptor.clear();p.descriptor.shrink_to_fit();
            require(same(scene(),decoded)&&command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true&&!output().empty(),"Higher-SH publication borrows retired source input");++shBorrowedRetirements;
            require(parsed(sv_open(bundle.data(),bundle.size(),unsigned(InputFormat::Sog),cap,nativeBudget))["ok"]==true&&same(scene(),decoded),"Higher-SH grouped output differs from retained bundled codec path");
        }
    }
}
void shPolicyBoundaries() {
    ++shSuites;const auto tests=Json::parse(sogShDraftCases);require(tests.at("cases").size()==33,"Independent higher-SH policy case set incomplete");
    for(const auto &test:tests.at("cases")) {
        ++shPolicyCases;const auto name=test.at("name").get<std::string>(),base=test.at("packet").get<std::string>();
        const auto original=shBytes("case/"+name+"/meta.json");auto resources=shResources(base);
        for(const auto &change:test.at("resourceChanges")) {
            const auto path=change.at("path").get<std::string>();auto data=shBytes("case/"+name+"/"+path);
            require(change.at("bytes")==data.size()&&change.at("sha256")==hex(shDigest(data)),"Higher-SH case override source bytes changed");resources[path]=std::move(data);
        }
        shSourceKey(original,resources,test.at("sourceKey"));const auto p=shPacket(original,resources),before=p;
        const auto &expected=test.contains("expectedRecordsOverride")?shExpected().at("caseOverrides").at(name):shExpected().at("packets").at(base);
        const bool sampled=!test.at("acceptanceByCap").at("3").get<bool>()&&test.at("acceptanceByCap").at("1").get<bool>();
        for(unsigned cap:{3u,2u,1u}) {
            const auto key=std::to_string(cap);const bool accepted=test.at("acceptanceByCap").at(key).get<bool>();
            if(accepted) {
                const auto value=openGroup(p,cap);require(value["ok"]==true&&value["sourceCount"]==3&&value["count"]==cap&&value["shDegree"]==expected.at("shDegree"),"Higher-SH native accepted policy case differs");
                independentSh(scene(),cap,expected);++shPolicyAcceptances;if(sampled)++shUnsampledAcceptances;
            } else {
                oldEditedDocument();const auto old=retain();watchedShCentroidBytes=4*64*((expected.at("shDegree").get<unsigned>()+1)*(expected.at("shDegree").get<unsigned>()+1)-1)*expected.at("centroidHeight").get<size_t>();
                shObservedPlanes=shObservedPlaneBytes=0;watchingShPlanes=true;const auto value=openGroup(p,cap);watchingShPlanes=false;
                require(value["ok"]==false,"Independent invalid higher-SH policy input published");
                require(shObservedPlanes==(sampled?7u:0u)&&shObservedPlaneBytes==(sampled?96+watchedShCentroidBytes:0),"Higher-SH static refusal allocated a plane or sampled refusal bypassed all seven decoded roles");
                unchanged(old,false);if(sampled)++shSampledRefusals;else ++shHeaderRefusals;
            }
            require(p.block==before.block&&p.descriptor==before.descriptor,"Higher-SH accepted/refused input mutated original/rewritten borrowed bytes");
        }
    }
}
void shAdmissionAndCompletedPublication() {
    ++shSuites;
    for(const auto *name:shNames) {
        const auto p=shPacket(shBytes(std::string(name)+"/meta.json"),shResources(name));oldEditedDocument();
        const auto group=browser_sog_group::Group::parse(p.block,p.descriptor);const auto metadata=group.read("meta.json");
        const auto meta=Json::parse(metadata.begin(),metadata.end());const auto roles=shRoles(meta);const auto payloads=shRoleBytes(group,roles);size_t total=0;for(const auto value:payloads)total+=value;
        {
            const auto old=retain();ResourceLimits limits;limits.totalBytes=nativeBudget;limits.categoryBytes[size_t(ResourceCategory::Work)]=total-1;
            LoadOptions options;options.maxSplats=3;options.maxBytes=nativeBudget;options.resources=ResourceBudget(limits);
            size_t headerReads=0;bool refused=false;watchedShCentroidBytes=payloads[5];shObservedPlanes=shObservedPlaneBytes=0;watchingShPlanes=true;
            try {
                sv_allocation::Scope scope;const sv_json::ParsedSogMetadata parsed(std::string_view(reinterpret_cast<const char *>(metadata.data()),metadata.size()));
                browser_sog_group::preflight(parsed.get(),[&](const std::string &alias){require(headerReads<7&&alias==roles[headerReads],"Higher-SH admission refused before complete ordered header plan");++headerReads;return group.read(alias);},options);
            }catch(const ResourceBudgetExceeded &){refused=true;}
            watchingShPlanes=false;require(refused&&headerReads==7&&shObservedPlanes==0&&shObservedPlaneBytes==0,"Higher-SH full seven-plane plan ignored Work admission or allocated RGBA");unchanged(old,false);++shAdmissionRefusals;
        }
        {
            const auto old=retain();watchedShCentroidBytes=payloads[5];shObservedPlanes=shObservedPlaneBytes=0;watchingShPlanes=true;
            const auto value=openGroup(p,3,rawWork+unsigned(p.block.size()+p.descriptor.size()));watchingShPlanes=false;
            require(value["ok"]==false&&shObservedPlanes==0,"Higher-SH old-owner/source/raw-headroom refusal occurred after RGBA allocation");unchanged(old,false);++shAdmissionRefusals;
        }
        const auto old=retain();sv_response::refuseNextSummaryForContracts();const auto refused=openGroup(p,3);
        require(refused["ok"]==false&&refused["error"]=="Invalid native response","Higher-SH actual completed-candidate summary gate did not refuse");unchanged(old,false);++shPublicationRefusals;
        require(openGroup(p,3)["ok"]==true,"Higher-SH summary refusal poisoned subsequent publication");independentSh(scene(),3,shExpected().at("packets").at(name));
    }
}
}
int main() {
    try {
        sv_allocation::setObserverForContracts(observe);
        successBorrowAndBundle();badNumericAndSpans();badDescriptorsAndPredecode();admissionAndActualResponseGate();
        const auto v2Start=checks;v2SuccessAndIdentity();v2MetadataAndSampledRefusals();v2NumericBoolAndPublication();v2Checks=checks-v2Start;
        const auto shStart=checks;shSuccessAndIdentity();shPolicyBoundaries();shAdmissionAndCompletedPublication();shChecks=checks-shStart;
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final grouped SOG census invalid");sv_allocation::setObserverForContracts(nullptr);
        std::printf("SPLATVIEW_SOG_GROUP_CONTRACTS_PASS cases=%zu checks=%zu independentRecords=%zu borrowedRetirements=%zu physicalRolePlanes=%zu numericRefusals=%zu descriptorRefusals=%zu metadataHeaderRefusals=%zu admissionRefusals=%zu publicationRefusals=%zu executableRedoChecks=%zu v2Cases=%zu v2Checks=%zu v2IndependentRecords=%zu v2BorrowedRetirements=%zu v2HeaderRefusals=%zu v2SampledRefusals=%zu v2UnsampledAcceptances=%zu v2HashChecks=%zu v2PublicationRefusals=%zu maximumPositionError=%.9g maximumOpacityError=%.9g maximumCovarianceScaledError=%.9g "
            "shSuites=%zu shPackets=%zu shPolicyCases=%zu shChecks=%zu shIndependentRecords=%zu shBorrowedRetirements=%zu shPhysicalRolePlanes=%zu shHeaderRefusals=%zu shSampledRefusals=%zu shPolicyAcceptances=%zu shUnsampledAcceptances=%zu shHashChecks=%zu shBlobChecks=%zu shAdmissionRefusals=%zu shPublicationRefusals=%zu shExecutableRedoChecks=%zu shMaximumPositionError=%.9g shMaximumOpacityError=%.9g shMaximumCovarianceScaledError=%.9g\n",
            cases,checks,independentRecords,borrowedRetirements,physicalRolePlanes,numericRefusals,descriptorRefusals,metadataHeaderRefusals,admissionRefusals,publicationRefusals,redoChecks,v2Cases,v2Checks,v2IndependentRecords,v2BorrowedRetirements,v2HeaderRefusals,v2SampledRefusals,v2UnsampledAcceptances,v2HashChecks,v2PublicationRefusals,maximumPositionError,maximumOpacityError,maximumCovarianceScaledError,
            shSuites,shPackets,shPolicyCases,shChecks,shIndependentRecords,shBorrowedRetirements,shPhysicalRolePlanes,shHeaderRefusals,shSampledRefusals,shPolicyAcceptances,shUnsampledAcceptances,shHashChecks,shBlobChecks,shAdmissionRefusals,shPublicationRefusals,shRedoChecks,shMaximumPositionError,shMaximumOpacityError,shMaximumCovarianceScaledError);return 0;
    }catch(const std::exception &e){watchingPlanes=watchingShPlanes=awaitingRolePlane=false;sv_allocation::setObserverForContracts(nullptr);std::fprintf(stderr,"SPLATVIEW_SOG_GROUP_CONTRACTS_FAIL %s (observed role planes=%zu bytes=%zu all payload16 blocks=%zu higher-SH planes=%zu bytes=%zu)\n",e.what(),rolePlanes,rolePlaneBytes,planeAllocations,shObservedPlanes,shObservedPlaneBytes);return 1;}
}
