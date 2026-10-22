// Main-only real C ABI contracts. Native allocation failure observation exists
// only under the existing nonshipping census-contract definition.
#include "model.hpp"
#include "processing_kernels.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

extern "C" {
unsigned sv_abi_version();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const uint32_t *sv_pack(unsigned,unsigned);
const uint32_t *sv_pack_color_base(unsigned,unsigned);
unsigned sv_pack_len();
const uint8_t *sv_output_ptr();
unsigned sv_output_len();
}
namespace {
using namespace preview;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
size_t checks{},cases{},automaticActions{},cancelCases{},rollbackCases{},inputRefusals{},budgetRefusals{},backendRefusals{};
size_t coloredWBCases{},activeExports{},publicationRefusals{},publicationFailureEvents{};
bool observePublication{};
void publicationObserver(const sv_allocation::Event &event) noexcept {
    if(observePublication&&event.kind==sv_allocation::EventKind::BackendFailure&&event.owner)
        ++publicationFailureEvents;
}
void require(bool condition,const char *message) {
    ++checks;if(!condition) throw std::runtime_error(message);
}
struct Color {
    uint64_t session{},base{},epoch{};
    bool active{},selectedOnly{},pending{};
    ColorValues values{neutralColor},applied{neutralColor};
};
struct Summary {
    bool ok{},pending{},undo{},redo{},transaction{},draft{},sceneChanged{};
    size_t count{},selected{},visible{},memory{};
    uint64_t revision{},content{};
    std::array<float,11> camera{};
    Color color;
};
Summary parsed(const char *text) {
    require(text!=nullptr,"Native C ABI returned a null response");
    const auto value=Json::parse(text);
    Summary result;result.ok=value.value("ok",false);
    if(!result.ok) {
        require(value.contains("error")&&value["error"].is_string(),"Native refusal was not a valid JSON error");
        return result;
    }
    result.pending=value.at("pending");result.undo=value.at("canUndo");result.redo=value.at("canRedo");
    result.transaction=value.at("transaction");result.draft=value.at("selectionDraft");result.sceneChanged=value.at("sceneChanged");
    result.count=value.at("count");result.selected=value.at("selected");result.visible=value.at("visible");result.memory=value.at("memoryBytes");
    result.revision=value.at("revision");result.content=value.at("contentRevision");result.camera=value.at("camera").get<std::array<float,11>>();
    require(std::isfinite(value.at("progress").get<double>()),"Native progress is nonfinite JSON metadata");
    const auto &color=value.at("colorSession");
    if(!color.is_null()) {
        require(color.at("version")==1&&color.at("active")==true,"Invalid active color-session response topology");
        result.color.active=true;result.color.session=color.at("sessionId");result.color.base=color.at("baseId");result.color.epoch=color.at("epochId");
        result.color.selectedOnly=color.at("selectedOnly");result.color.pending=color.at("pending");
        result.color.values=color.at("values").get<ColorValues>();result.color.applied=color.at("applied").get<ColorValues>();
        for(auto id:{result.color.session,result.color.base,result.color.epoch})
            require(id>0&&id<=9007199254740991ULL,"Color-session identity cannot be represented exactly in JSON/JavaScript");
        for(size_t k=0;k<15;++k) require(std::isfinite(result.color.values[k])&&std::isfinite(result.color.applied[k])&&
            result.color.values[k]>=colorFields[k].low&&result.color.values[k]<=colorFields[k].high&&
            result.color.applied[k]>=colorFields[k].low&&result.color.applied[k]<=colorFields[k].high,"Invalid color field in native summary");
    }
    return result;
}
Summary command(const Json &request) { const auto text=request.dump();return parsed(admittedContractCommand(text.c_str())); }
Summary named(const char *name) { return command({{"command",name}}); }
Summary current() { return named("summary"); }
Summary finish(Summary value,unsigned work=4096) {
    for(size_t step=0;value.pending;++step) {
        require(step<1'000'000,"Native color operation did not finish");value=parsed(sv_step(work));
        require(value.ok,"Native color step returned an error");
    }
    return value;
}
template<class T> void append(Bytes &bytes,const T &value) {
    const auto *source=reinterpret_cast<const uint8_t *>(&value);bytes.insert(bytes.end(),source,source+sizeof(T));
}
Bytes input(size_t n=33,bool ramp=false,bool binary=false,bool cast=false) {
    const auto header=std::string("ply\nformat ")+(binary?"binary_little_endian":"ascii")+
        " 1.0\nelement vertex "+std::to_string(n)+"\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
        "property float f_dc_2\nend_header\n";
    Bytes bytes(header.begin(),header.end());
    for(size_t i=0;i<n;++i) {
        const float gray=ramp ? .05f+.9f*float(i)/float(std::max(size_t(1),n-1)):.5f;
        const std::array<float,3> rgb=cast?std::array<float,3>{.8f,.45f,.2f}:std::array<float,3>{gray,gray,gray};
        std::array<float,3> dc{};for(size_t k=0;k<3;++k) dc[k]=(rgb[k]-.5f)/.28209479177387814f;
        const std::array<float,14> values{float(i)*.18f,0,0,-2.3025851f,-2.3025851f,-2.3025851f,1,0,0,0,1,dc[0],dc[1],dc[2]};
        if(binary) for(auto value:values) append(bytes,value);
        else {
            std::ostringstream row;row.precision(9);for(auto value:values) row<<value<<' ';row<<'\n';
            const auto text=row.str();bytes.insert(bytes.end(),text.begin(),text.end());
        }
    }
    return bytes;
}
Summary open(const Bytes &bytes,unsigned budget=32*1024*1024) {
    const auto value=parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Auto),1'000'000,budget));
    return value;
}
std::vector<Gaussian> scene() { const auto value=current();require(sv_scene_ptr(),"Expected Gaussian scene owner");return {sv_scene_ptr(),sv_scene_ptr()+value.count}; }
Bytes sceneBytes() {
    const auto values=scene();const auto *p=reinterpret_cast<const uint8_t *>(values.data());return {p,p+values.size()*sizeof(Gaussian)};
}
Bytes masks() { const auto value=current();require(sv_states_ptr(),"Expected Gaussian mask owner");return {sv_states_ptr(),sv_states_ptr()+value.count}; }
Bytes packed(bool base=false) {
    const auto value=current();const auto *p=base?sv_pack_color_base(0,unsigned(value.count)):sv_pack(0,unsigned(value.count));
    require(p&&sv_pack_len()>0,"Native packed document/base stream is missing");
    const auto *bytes=reinterpret_cast<const uint8_t *>(p);return {bytes,bytes+sv_pack_len()};
}
Bytes output() { require(sv_output_ptr()&&sv_output_len(),"Native export output missing");return {sv_output_ptr(),sv_output_ptr()+sv_output_len()}; }
bool sameScene(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b) {
    return a.size()==b.size()&&std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian))==0;
}
std::vector<Gaussian> baked(const std::vector<Gaussian> &base,const Bytes &states,const ColorValues &values,bool selected=false) {
    auto result=base;processing_detail::Grade grade(values);
    for(size_t i=0;i<result.size();++i) if(!(states[i]&2)&&(!selected||(states[i]&1))) {
        auto coefficients=processing_detail::coefficients(result[i]);grade.apply(coefficients,1);processing_detail::store(result[i],coefficients);
    }
    return result;
}
Summary color(const ColorValues &values,const char *method=nullptr,bool selected=false,unsigned step=4096) {
    require(named("beginTransaction").transaction,"Color edit checkpoint did not start");
    Json request{{"command",method?"autoColor":"grade"},{"values",values},{"selectedOnly",selected}};
    if(method) request["method"]=method;
    auto value=command(request);require(value.ok,"Color command was refused");value=finish(value,step);
    require(value.transaction&&value.color.active&&!value.color.pending,"Color operation did not settle retained metadata");
    const auto committed=named("commitTransaction");require(committed.ok&&!committed.transaction&&!committed.sceneChanged,"Color checkpoint commit invalid");
    return committed;
}
void ended() { const auto value=named("endColor");require(value.ok&&!value.color.active&&!value.pending,"Settled color session did not end"); }
bool sameMetadata(const Color &a,const Color &b,bool allowNewEpoch=false) {
    return a.active==b.active&&a.session==b.session&&a.base==b.base&&(allowNewEpoch||a.epoch==b.epoch)&&
        a.selectedOnly==b.selectedOnly&&a.pending==b.pending&&a.values==b.values&&a.applied==b.applied;
}
std::array<ColorValues,4> suggestions(const std::vector<Gaussian> &base,const Bytes &states,bool selected=false) {
    // Independent default SplatView source-DC fixture oracle, not display pixels.
    std::vector<std::array<float,3>> colors;std::vector<float> sorted;
    for(size_t i=0;i<base.size();++i) if(!(states[i]&2)&&(!selected||(states[i]&1))) {
        std::array<float,3> rgb{};for(unsigned k=0;k<3;++k) rgb[k]=std::clamp(shValue(base[i],0,k)*.28209479177387814f+.5f,0.f,1.f);
        colors.push_back(rgb);sorted.push_back(.299f*rgb[0]+.587f*rgb[1]+.114f*rgb[2]);
    }
    require(!colors.empty()&&colors.size()<=65536,"Binding fixture exceeds independent oracle's exact sample scope");
    std::sort(sorted.begin(),sorted.end());
    const auto percentile=[&](float p) { const double index=double(p)*.01*(sorted.size()-1);const size_t a=size_t(index),b=std::min(a+1,sorted.size()-1);
        return float(sorted[a]+(sorted[b]-sorted[a])*(index-a)); };
    std::array<ColorValues,4> result;for(auto &values:result) values=neutralColor;
    const float range=percentile(100-.1f)-percentile(.1f);if(range>.01f) result[2][1]=std::clamp(.95f/range,.5f,3.f);
    float sum=0;size_t count=0;std::array<float,3> average{};const float low=percentile(1),high=percentile(99);
    for(const auto &rgb:colors) { const float l=.299f*rgb[0]+.587f*rgb[1]+.114f*rgb[2];if(l>=low&&l<=high) {
        sum+=l;++count;for(size_t k=0;k<3;++k) average[k]+=rgb[k]; } }
    if(count&&sum/float(count)>.01f) result[1][0]=std::clamp(.45f/(sum/float(count)),.5f,2.5f);
    if(count) { for(auto &v:average) v/=float(count);const float target=(average[0]+average[1]+average[2])/3;
        std::array<float,3> gain{};for(size_t k=0;k<3;++k) gain[k]=std::clamp(target/(average[k]+1e-8f),.5f,2.f);
        result[3][5]=std::clamp((gain[0]/gain[2]-1)*.5f,-1.f,1.f);
        result[3][6]=std::clamp((1-gain[1]/((gain[0]+gain[2])/2))*.5f,-1.f,1.f); }
    result[0][0]=std::clamp(1+(result[1][0]-1),.5f,2.f);result[0][1]=std::clamp(1+(result[2][1]-1)*.7f,.7f,1.5f);
    result[0][5]=result[3][5]*.5f;result[0][6]=result[3][6]*.5f;return result;
}
ColorValues merged(const ColorValues &current,const ColorValues &suggested,size_t action) {
    auto result=current;for(size_t k=0;k<15;++k) if(((action==0||action==1)&&k==0)||((action==0||action==2)&&k==1)||((action==0||action==3)&&(k==5||k==6))) result[k]=suggested[k];return result;
}
void absoluteAndBasePacking() {
    ++cases;require(open(input()).ok&&sv_abi_version()==24,"Actual Gaussian opening or native ABI24 failed");
    const auto original=scene();const auto baseline=packed();const auto states=masks();const auto before=current();
    auto first=neutralColor;first[0]=1.5f;const auto initial=color(first);
    require(initial.color.values==first&&initial.color.applied==first&&packed(true)==baseline&&packed()!=baseline,
            "Color session base stream is not original while document stream is baked");
    require(sameScene(scene(),baked(original,states,first)),"First actual grade does not match native kernel");
    auto second=neutralColor;second[0]=1.2f;const auto updated=color(second);
    require(sameScene(scene(),baked(original,states,second)),"Repeated absolute grade compounded previous bake");
    require(updated.color.session==initial.color.session&&updated.color.base==initial.color.base&&updated.color.values==second&&
        updated.color.applied==second&&updated.camera==before.camera&&masks()==states,"Absolute bake changed baseline, view or masks");
    const auto equal=color(second);
    require(equal.revision==updated.revision&&equal.content==updated.content&&sameScene(scene(),baked(original,states,second)),
            "Manual equal-applied grade manufactured another revision");
    const auto reset=color(neutralColor);
    require(sameScene(scene(),original)&&packed()==baseline&&reset.revision>equal.revision&&reset.color.applied==neutralColor,
            "Neutral Reset did not restore original session base as a real replacement");ended();
}
void allAutomaticActions() {
    const char *methods[]{"enhance","exposure","contrast","white_balance"};
    const ColorValues custom{1.2f,1.3f,1.1f,1.2f,1.3f,.15f,-.2f,.1f,-.1f,.05f,25,.1f,-35,.15f,20};
    for(bool ramp:{false,true}) for(size_t action=0;action<4;++action) {
        ++cases;require(open(input(33,ramp)).ok,"Automatic fixture failed to open");
        const auto original=scene();const auto states=masks();const auto baseline=packed();const auto expected=suggestions(original,states);
        const auto previous=color(custom);const auto values=merged(custom,expected[action],action);
        const auto result=color(custom,methods[action]);
        require(result.color.values==values&&result.color.applied==values&&result.color.base==previous.color.base&&packed(true)==baseline,
            "Actual Auto suggestions/merge changed an unowned field or original source");
        require(sameScene(scene(),baked(original,states,values))&&masks()==states,"Actual automatic bake differs from source fixture oracle/kernel");
        const auto again=color(values,methods[action]);
        require(again.revision>result.revision&&again.content!=result.content&&sameScene(scene(),baked(original,states,values)),
            "Explicit repeated nonneutral Auto was incorrectly treated as manual equality no-op");ended();++automaticActions;
    }
}
void coloredWhiteBalance() {
    ++cases;require(open(input(33,false,false,true)).ok,"Colored White balance fixture failed to open");
    const auto original=scene();const auto states=masks();const auto baseline=packed();
    const auto expected=suggestions(original,states);
    require(std::abs(expected[3][5])>.01f&&std::abs(expected[3][6])>.01f,"Colored source oracle failed to produce nonzero WB corrections");
    const ColorValues custom{1.2f,1.3f,1.1f,1.2f,1.3f,.15f,-.2f,.1f,-.1f,.05f,25,.1f,-35,.15f,20};
    const auto manual=color(custom);const auto values=merged(custom,expected[3],3);
    const auto result=color(custom,"white_balance");
    require(result.color.values==values&&result.color.applied==values&&result.color.base==manual.color.base&&packed(true)==baseline,
            "Colored C ABI WB correction/merge did not preserve base and unowned values");
    require(sameScene(scene(),baked(original,states,values))&&masks()==states,"Colored WB bake differs from independent source oracle and native Grade");
    ended();++coloredWBCases;
}
void noopsAndQuantizedIdentity() {
    ++cases;require(open(input(3)).ok,"No-op Redo fixture failed to open");
    require(command({{"command","single"},{"index",0},{"operation",0}}).selected==1,"First selection failed");
    require(command({{"command","single"},{"index",1},{"operation",0}}).selected==1,"Second selection failed");
    const auto prior=named("undo");require(prior.redo,"No-op fixture lacks executable Redo");
    const auto before=sceneBytes(),states=masks();const auto noop=color(neutralColor,nullptr,true);
    require(noop.redo&&noop.revision==prior.revision&&noop.content==prior.content&&sceneBytes()==before&&masks()==states,
            "Manual true no-op cleared Redo or changed document/mask");ended();require(named("redo").selected==1&&masks()[1]==1,"No-op Redo no longer executes");
    ++cases;require(open(input(3)).ok,"Same-byte identity fixture failed to open");
    const auto packedBefore=packed();const auto *owner=sv_scene_ptr();const auto previous=current();
    auto values=neutralColor;values[1]=std::nextafter(1.f,2.f);const auto changed=color(values);
    require(packed()==packedBefore&&sv_scene_ptr()!=owner&&changed.revision>previous.revision&&changed.content!=previous.content&&changed.undo,
            "Nonneutral same-byte grade did not create desktop scene/history identity");ended();
    require(named("undo").content==previous.content&&packed()==packedBefore,"Same-byte scene history Undo failed");
}
void selectionDeletionAndBoundaries() {
    ++cases;require(open(input(3,true)).ok,"Selected/deleted fixture failed to open");
    require(command({{"command","single"},{"index",1},{"operation",0}}).selected==1,"Deletion selection failed");
    require(named("delete").visible==2,"Deleted scope fixture failed");
    require(command({{"command","single"},{"index",0},{"operation",0}}).selected==1,"Color selection failed");
    const auto base=scene();const auto states=masks();auto values=neutralColor;values[0]=1.4f;
    const auto selected=color(values,nullptr,true);
    require(selected.color.selectedOnly&&masks()==states&&sameScene(scene(),baked(base,states,values,true)),"Selected grade touched deleted/unselected data");
    const auto expected=suggestions(base,states,true);const auto selectedAuto=color(values,"exposure",true);
    require(selectedAuto.color.values==merged(values,expected[1],1)&&sameScene(scene(),baked(base,states,selectedAuto.color.values,true)),
            "Auto selected/deleted analysis or bake scope differs");
    const auto before=sceneBytes(),beforeMasks=masks();const auto metadata=current();
    const Matrix4 identity=identityMatrix;
    for(const auto &request:std::vector<Json>{{{"command","selectAll"}},{{"command","selectNone"}},{{"command","invert"}},
        {{"command","undo"}},{{"command","redo"}},{{"command","delete"}},{{"command","crop"}},{{"command","restore"}},
        {{"command","resetCleanup"}},{{"command","beginSelection"}},{{"command","morphology"},{"mode","grow"}},
        {{"command","transform"},{"matrix",identity}}}) {
        require(!command(request).ok,"Active color session allowed a native content/selection boundary");
        require(sceneBytes()==before&&masks()==beforeMasks&&sameMetadata(current().color,metadata.color),"Refused boundary changed color/document state");
    }
    require(command({{"command","point"},{"index",0}}).ok,"Read-only point query should remain available during a color session");
    require(named("point").ok==false&&sameMetadata(current().color,metadata.color),"Malformed point query should refuse without color corruption");
    const auto basePacket=packed(true),documentPacket=packed();
    const auto exported=command({{"command","export"},{"format",0},{"scope",0}});
    require(exported.ok&&!exported.pending&&exported.revision==metadata.revision&&exported.content==metadata.content&&
        exported.undo==metadata.undo&&exported.redo==metadata.redo&&sameMetadata(exported.color,metadata.color)&&
        sceneBytes()==before&&masks()==beforeMasks&&packed(true)==basePacket&&packed()==documentPacket,
            "Active settled export changed base, metadata, pending state, document or history");
    const auto activeOutput=output();++activeExports;
    ended();require(command({{"command","export"},{"format",0},{"scope",0}}).ok&&output()==activeOutput,
            "Active export used a display grade twice or differed from the ended baked document export");
    require(named("undo").ok&&sameScene(scene(),baked(base,states,values,true)),"Active export added history instead of preserving executable color Undo");
    require(named("redo").ok&&sameScene(scene(),baked(base,states,selectedAuto.color.values,true)),"Active export changed executable color Redo");
    require(named("selectNone").selected==0,"Boundary remained blocked after ending color");
}
void cancellationAndRollback() {
    ++cases;require(open(input(4096,true,true)).ok,"Pending cancel fixture failed to open");
    require(command({{"command","single"},{"index",0},{"operation",0}}).selected==1,"Cancel baseline selection failed");
    require(command({{"command","single"},{"index",1},{"operation",0}}).selected==1,"Cancel Redo selection failed");
    const auto prior=named("undo");require(prior.redo,"Cancel fixture lacks Redo");
    const auto bytes=sceneBytes(),states=masks(),packet=packed();const auto *owner=sv_scene_ptr();
    const auto census=sv_allocation::snapshot();
    require(named("beginTransaction").transaction,"Pending cancel transaction failed");
    auto pending=command({{"command","autoColor"},{"method","enhance"},{"values",neutralColor},{"selectedOnly",true}});
    require(pending.ok&&pending.pending&&pending.color.pending,"Auto did not enter pending source analysis");
    pending=parsed(sv_step(1));require(pending.ok&&pending.pending&&sceneBytes()==bytes&&masks()==states,"One analysis step mutated the document");
    const auto cancelled=named("cancel");require(cancelled.ok&&!cancelled.pending&&sceneBytes()==bytes&&masks()==states,"Analysis cancellation published partial work");
    const auto restored=named("rollbackTransaction");
    require(restored.ok&&!restored.pending&&!restored.transaction&&!restored.color.active&&restored.redo&&restored.revision==prior.revision&&
        restored.content==prior.content&&restored.memory==prior.memory&&sv_scene_ptr()==owner&&packed()==packet,"Pending rollback lost document/history/color metadata");
    const auto after=sv_allocation::snapshot();
    require(after.valid&&after.scenePayloadBytes==census.scenePayloadBytes&&after.liveBlocks==census.liveBlocks&&
        after.ownedRawBytes-after.contextBytes==census.ownedRawBytes-census.contextBytes,"Analysis rollback retained payload or raw non-context storage");
    require(named("redo").selected==1&&masks()[1]==1,"Cancelled analysis rollback destroyed executable Redo");++cancelCases;++rollbackCases;
    ++cases;require(open(input()).ok,"Completed rollback fixture failed to open");
    auto first=neutralColor;first[0]=1.2f;const auto applied=color(first);const auto originalBase=packed(true),document=packed();const auto original=sceneBytes();
    require(named("beginTransaction").transaction,"Completed color checkpoint failed");
    auto second=neutralColor;second[0]=1.5f;auto changed=finish(command({{"command","grade"},{"values",second},{"selectedOnly",false}}));
    require(changed.ok&&changed.sceneChanged&&changed.color.applied==second,"Completed candidate did not report changed scene inside transaction");
    const auto rollback=named("rollbackTransaction");
    require(rollback.ok&&!rollback.sceneChanged&&rollback.revision==applied.revision&&rollback.content==applied.content&&
        sameMetadata(rollback.color,applied.color,true)&&rollback.color.epoch!=applied.color.epoch&&sceneBytes()==original&&packed()==document&&packed(true)==originalBase,
            "Completed native+metadata rollback did not restore applied values/base/current scene with fresh epoch");ended();++rollbackCases;
}
void strictInputAndExport() {
    ++cases;require(open(input()).ok,"Strict request fixture failed to open");const auto baseline=sceneBytes(),states=masks();const auto prior=current();
    auto invalid=neutralColor;invalid[0]=6;
    const std::vector<Json> requests{
        {{"command","autoColor"},{"method","unknown"},{"values",neutralColor}},
        {{"command","autoColor"},{"method",4},{"values",neutralColor}},
        {{"command","autoColor"},{"values",neutralColor}},
        {{"command","autoColor"},{"method","enhance"},{"values",Json::object()}},
        {{"command","grade"},{"values",std::array<float,2>{1,1}}},
        {{"command","grade"},{"values",invalid}},
        {{"command","grade"},{"values",neutralColor},{"selectedOnly","true"}},
        {{"command","grade"},{"values",Json::array({"1",1,1,1,1,0,0,0,0,0,0,0,0,0,0})}},
        {{"command","grade"},{"values",Json::array({true,1,1,1,1,0,0,0,0,0,0,0,0,0,0})}},
        {{"command","grade"},{"values",Json::array({nullptr,1,1,1,1,0,0,0,0,0,0,0,0,0,0})}},
    };
    for(const auto &request:requests) {
        require(!command(request).ok,"Strict color dispatch accepted invalid method/type/value");const auto after=current();
        require(after.revision==prior.revision&&after.content==prior.content&&!after.pending&&!after.color.active&&sceneBytes()==baseline&&masks()==states,
            "Invalid color request mutated metadata or document before refusal");++inputRefusals;
    }
    auto values=neutralColor;values[0]=1.2f;const auto bakedResult=color(values);
    require(!command({{"command","grade"},{"values",values},{"selectedOnly",true}}).ok&&sameMetadata(current().color,bakedResult.color),
            "Mixed color scope was accepted or discarded prior session");++inputRefusals;
    const auto expected=scene();ended();
    require(command({{"command","export"},{"format",0},{"scope",0}}).ok,"Baked PLY export failed after endColor");const auto exported=output();
    require(open(exported).ok,"Baked PLY output failed to reopen");const auto reopened=scene();
    require(reopened.size()==expected.size(),"Baked export changed visible splat count");
    for(size_t i=0;i<expected.size();++i) {
        require(reopened[i].sh==expected[i].sh&&reopened[i].positionOpacity==expected[i].positionOpacity,
                "PLY export/reopen lost exact baked SH/color or position/opacity");
        // PLY reconstructs scales/rotation from covariance; the documented
        // decomposition roundtrip can change its final float rounding.
        for(size_t k=0;k<4;++k) require(std::abs(reopened[i].covA[k]-expected[i].covA[k])<1e-6f&&
            std::abs(reopened[i].covB[k]-expected[i].covB[k])<1e-6f,"Baked PLY covariance roundtrip exceeded float tolerance");
    }
}
void resourceAndBackendRefusal() {
    const auto bytes=input(4096,true,true);
    for(unsigned limit:{524288u,655360u,786432u,917504u,1048576u,1310720u,1572864u,2097152u}) {
        const auto opened=open(bytes,limit);if(!opened.ok) continue;++cases;
        const auto prior=current();const auto original=sceneBytes(),states=masks();
        if(!named("beginTransaction").ok) continue;
        auto values=neutralColor;values[0]=1.4f;auto value=command({{"command","autoColor"},{"method","enhance"},{"values",values}});
        if(value.ok) { for(size_t step=0;value.pending&&step<100000;++step) value=parsed(sv_step(4096)); }
        if(!value.ok) {
            const auto rolled=named("rollbackTransaction");require(rolled.ok&&rolled.revision==prior.revision&&rolled.content==prior.content&&
                rolled.memory==prior.memory&&!rolled.color.active&&!rolled.pending&&sceneBytes()==original&&masks()==states,
                "Actual ResourceBudget refusal did not restore candidate document/color transaction");++budgetRefusals;break;
        }
        require(named("rollbackTransaction").ok,"Budget trial rollback failed");
    }
    require(budgetRefusals>0,"No actual constrained native Work/candidate budget refusal was exercised");
    for(size_t ordinal:{size_t(1),size_t(2),size_t(4),size_t(8),size_t(16)}) {
        ++cases;require(open(input(33,true)).ok,"Backend refusal fixture failed");const auto before=current();const auto original=sceneBytes(),states=masks();
        require(named("beginTransaction").transaction,"Backend refusal checkpoint failed");
        const auto request=Json{{"command","autoColor"},{"method","enhance"},{"values",neutralColor}}.dump();
        sv_allocation::failBackendAtForContracts(ordinal);
        // Disable failure before parsing the response so this fixture targets
        // the actual native command/candidate rather than its own JSON reader.
        const char *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);
        auto value=parsed(reply);if(value.ok) value=finish(value);
        const auto rolled=named("rollbackTransaction");
        require(rolled.ok&&!rolled.pending&&!rolled.transaction&&!rolled.color.active&&rolled.revision==before.revision&&rolled.content==before.content&&
            sceneBytes()==original&&masks()==states,"Actual backend refusal rollback lost native document/color metadata");
        if(!value.ok) ++backendRefusals;
    }
    require(backendRefusals>0,"No existing native backend refusal was observed");
}
void terminalPublicationRefusal() {
    for(size_t ordinal:{size_t(2),size_t(3),size_t(4),size_t(8),size_t(16)}) {
        ++cases;require(open(input(3)).ok,"Terminal publication fixture failed to open");
        const auto originalSource=scene();auto first=neutralColor;first[0]=1.2f;
        const auto previous=color(first);const auto original=sceneBytes(),states=masks(),documentPacket=packed(),basePacket=packed(true);
        const auto *owner=sv_scene_ptr();
        require(named("beginTransaction").transaction,"Terminal publication checkpoint failed");const auto checkpointMemory=current().memory;
        auto second=neutralColor;second[0]=1.5f;
        auto pending=command({{"command","grade"},{"values",second},{"selectedOnly",false}});
        require(pending.ok&&pending.pending,"Terminal grade candidate did not start");
        pending=parsed(sv_step(2));
        require(pending.ok&&pending.pending&&pending.color.pending&&sceneBytes()==original&&masks()==states,
                "Pre-terminal bake work changed the public native document");
        const auto failures=publicationFailureEvents;
        sv_allocation::setObserverForContracts(publicationObserver);observePublication=true;
        // Scope setup is backend ordinal1. Ordinals2+ target allocations in
        // the terminal candidate SceneEdits/history staging, after bake work.
        sv_allocation::failBackendAtForContracts(ordinal);
        const char *reply=sv_step(1);
        sv_allocation::failBackendAtForContracts(0);observePublication=false;sv_allocation::setObserverForContracts(nullptr);
        const auto terminal=parsed(reply);
        if(!terminal.ok) {
            const auto retained=current();
            require(publicationFailureEvents>failures&&!retained.pending&&!retained.color.pending&&
                retained.revision==previous.revision&&retained.content==previous.content&&retained.memory==checkpointMemory&&
                sameMetadata(retained.color,previous.color)&&sv_scene_ptr()==owner&&sceneBytes()==original&&masks()==states&&
                packed()==documentPacket&&packed(true)==basePacket,
                    "Terminal native publication refusal changed document, applied metadata, history or retained Work");
            ++publicationRefusals;
        } else require(!terminal.pending&&terminal.sceneChanged&&terminal.color.applied==second,
                "Nonfailing terminal staging did not publish the intended candidate");
        const auto rollback=named("rollbackTransaction");
        require(rollback.ok&&!rollback.transaction&&!rollback.pending&&rollback.revision==previous.revision&&rollback.content==previous.content&&
            rollback.memory==previous.memory&&sameMetadata(rollback.color,previous.color,true)&&rollback.color.epoch!=previous.color.epoch&&
            sv_scene_ptr()==owner&&sceneBytes()==original&&masks()==states&&packed()==documentPacket&&packed(true)==basePacket,
                "Terminal candidate rollback did not atomically restore native/color metadata/base owners");
        ended();require(named("undo").ok&&sameScene(scene(),originalSource),"Terminal refusal/rollback damaged executable prior color Undo");
        ++rollbackCases;
    }
    require(publicationRefusals>=3,"Terminal publication staging did not exercise meaningful backend refusal depths");
}
}
int main() {
    try {
        require(sv_abi_version()==24,"Color session contracts require native ABI24");
        absoluteAndBasePacking();allAutomaticActions();coloredWhiteBalance();noopsAndQuantizedIdentity();selectionDeletionAndBoundaries();
        cancellationAndRollback();strictInputAndExport();resourceAndBackendRefusal();terminalPublicationRefusal();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final native allocation census is invalid");
        std::printf("SPLATVIEW_COLOR_SESSION_CONTRACTS_PASS cases=%zu checks=%zu automaticActions=%zu coloredWBCases=%zu activeExports=%zu cancellationCases=%zu rollbackCases=%zu inputRefusals=%zu budgetRefusals=%zu backendRefusals=%zu publicationRefusals=%zu\n",
            cases,checks,automaticActions,coloredWBCases,activeExports,cancelCases,rollbackCases,inputRefusals,budgetRefusals,backendRefusals,publicationRefusals);return 0;
    } catch(const std::exception &error) {
        observePublication=false;sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"SPLATVIEW_COLOR_SESSION_CONTRACTS_FAIL %s\n",error.what());return 1;
    }
}
