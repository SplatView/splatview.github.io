#include "browser_document_checkpoint.hpp"
#include "selection_checkpoint.hpp"
#include "picosha2.h"
#include <algorithm>
#include <bit>
#include <cmath>
#include <cstring>
#include <limits>
#include <string_view>

namespace preview::browser_checkpoint {
uint64_t Access::next(const browser_color_metadata::IdSequence &s) noexcept { return s.next_; }
uint64_t Access::next(const browser_alignment::IdSequence &s) noexcept { return s.next_; }
void Access::next(browser_color_metadata::IdSequence &s,uint64_t n) noexcept { s.next_=n; }
void Access::next(browser_alignment::IdSequence &s,uint64_t n) noexcept { s.next_=n; }
Access::Color Access::color(const browser_color_metadata::BrowserColorSession &s) noexcept {
    const auto &v=s.state_;
    return {v.base,v.acknowledged,v.applied,v.sessionId,v.baseId,v.baseContentRevision,v.epochId,v.valuesId,v.selectedOnly,v.effectiveStates};
}
void Access::color(browser_color_metadata::BrowserColorSession &s,Color v) noexcept {
    s.abandon();s.state_.base=std::move(v.base);s.state_.acknowledged=std::move(v.acknowledged);
    s.state_.values=s.state_.applied=v.applied;s.state_.sessionId=v.sessionId;s.state_.baseId=v.baseId;
    s.state_.baseContentRevision=v.baseContentRevision;s.state_.epochId=v.epochId;s.state_.valuesId=v.valuesId;
    s.state_.selectedOnly=v.selectedOnly;s.state_.effectiveStates=std::move(v.effectiveStates);
}
Access::Alignment Access::alignment(const browser_alignment::Session &s) noexcept { return {s.base_,s.states_,s.acknowledged_}; }
void Access::alignment(browser_alignment::Session &s,Alignment v) noexcept {
    s.base_=std::move(v.base);s.states_=std::move(v.states);s.acknowledged_=std::move(v.acknowledged);
}
namespace {
constexpr size_t headerBytes=64,maximumOwners=128,maximumMetadataBytes=4*1024*1024;
constexpr std::array<uint8_t,8> magic{'S','V','C','K','P','T','0','1'};
using Change=BrowserSelectionAccess::RecoveryChange;
using Revision=BrowserSelectionAccess::RecoveryRevision;
[[noreturn]] void invalid() { throw std::runtime_error("Invalid or unsupported exact document checkpoint"); }
void require(bool value) { if(!value)invalid(); }
uint32_t word(float f) noexcept { return std::bit_cast<uint32_t>(f); }
float scalar(uint32_t n) noexcept { return std::bit_cast<float>(n); }
uint64_t identity(uint64_t n,bool positive=false) { require(n<=maximumIdentity&&(!positive||n));return n; }
bool supportedCodec(unsigned n) noexcept { return n==1||n==2||n==3; }
bool sameRange(const std::optional<browser_duplicate::Range> &a,const std::optional<browser_duplicate::Range> &b) noexcept {
    return bool(a)==bool(b)&&(!a||(a->first==b->first&&a->count==b->count));
}
void validRange(const std::optional<browser_duplicate::Range> &range,bool gaussian,size_t loaded) {
    if(!range)return;
    // A latest-copy marker is the nonempty appended suffix, not an arbitrary
    // bounded interval. Subtraction avoids overflow in first+count.
    require(gaussian&&range->count&&range->first<=loaded&&range->count==loaded-range->first);
}
void validExpected(const Restore::Expected &e) {
    require(supportedCodec(e.codecVersion)&&e.maximumGraphSplats&&e.maximumGraphSplats<=browser_duplicate::sceneLimit&&
        e.currentLoadedCount<=e.maximumGraphSplats&&e.originalSourceCount&&
        e.originalSourceCount<=std::numeric_limits<uint32_t>::max()&&
        e.currentSourceCount>=e.originalSourceCount&&e.currentSourceCount>=e.currentLoadedCount&&
        e.currentSourceCount<=std::numeric_limits<uint32_t>::max()&&e.contentRevision<=e.nextContentRevision);
    identity(e.revision);identity(e.contentRevision);identity(e.nextContentRevision);
    validRange(e.currentDuplicateRange,true,e.currentLoadedCount);
    if(e.codecVersion<3)require(!e.currentDuplicateRange);
}
size_t product(size_t n,size_t stride) { return checkedByteProduct(n,stride); }
uint32_t le32(const uint8_t *p) noexcept { return uint32_t(p[0])|(uint32_t(p[1])<<8)|(uint32_t(p[2])<<16)|(uint32_t(p[3])<<24); }
uint64_t le64(const uint8_t *p) noexcept { return uint64_t(le32(p))|(uint64_t(le32(p+4))<<32); }
void put32(uint8_t *p,uint32_t v) noexcept { for(unsigned i=0;i<4;++i)p[i]=uint8_t(v>>(8*i)); }
void put64(uint8_t *p,uint64_t v) noexcept { for(unsigned i=0;i<8;++i)p[i]=uint8_t(v>>(8*i)); }
struct Reader {
    std::span<const uint8_t> bytes;size_t at{};
    std::span<const uint8_t> take(size_t n) { require(at<=bytes.size()&&n<=bytes.size()-at);auto out=bytes.subspan(at,n);at+=n;return out; }
    uint8_t u8() { return take(1)[0]; }
    bool boolean() { const auto n=u8();require(n<=1);return n!=0; }
    uint32_t u32() { return le32(take(4).data()); }
    uint64_t u64() { return le64(take(8).data()); }
    uint64_t id(bool positive=false) { return identity(u64(),positive); }
    float f32() { return scalar(u32()); }
    double f64() { return std::bit_cast<double>(u64()); }
    std::string_view text() {
        const auto n=u32();require(n<=1024*1024);const auto p=take(n);
        return {reinterpret_cast<const char *>(p.data()),p.size()};
    }
    Vec3 vec() { const auto x=f32(),y=f32(),z=f32();return {x,y,z}; }
    template<size_t N> std::array<float,N> floats() { std::array<float,N> out;for(auto &v:out)v=f32();return out; }
};
enum class SegmentKind:uint8_t { Metadata,Mask,Gaussians,Vertices,Triangles,Changes };
struct Segment { SegmentKind kind{};size_t start{},size{},offset{};const void *source{}; };
uint8_t segmentByte(const Segment &s,size_t at) noexcept {
    if(s.kind==SegmentKind::Mask)return static_cast<const uint8_t *>(s.source)[at];
    if(s.kind==SegmentKind::Gaussians) {
        const auto &g=static_cast<const Gaussian *>(s.source)[at/144];const auto w=at%144/4;
        const auto n=w<4?word(g.positionOpacity[w]):w<8?word(g.covA[w-4]):w<12?word(g.covB[w-8]):g.sh[w-12];
        return uint8_t(n>>(8*(at%4)));
    }
    if(s.kind==SegmentKind::Vertices) {
        const auto &v=static_cast<const PreviewVertex *>(s.source)[at/16];const auto w=at%16/4;
        const auto n=w==0?word(v.position.x):w==1?word(v.position.y):w==2?word(v.position.z):v.color;
        return uint8_t(n>>(8*(at%4)));
    }
    if(s.kind==SegmentKind::Triangles) {
        const auto n=static_cast<const std::array<uint32_t,3> *>(s.source)[at/12][at%12/4];
        return uint8_t(n>>(8*(at%4)));
    }
    const auto &v=static_cast<const Change *>(s.source)[at/6];const auto field=at%6;
    return field<4?uint8_t(v.index>>(8*field)):field==4?v.before:v.after;
}
void validVec(Vec3 v) { require(std::isfinite(v.x)&&std::isfinite(v.y)&&std::isfinite(v.z)); }
template<class A> void finite(const A &a) { for(const auto v:a)require(std::isfinite(v)); }
void validView(const SavedView &v) {
    validVec(v.target);require(std::isfinite(v.yaw)&&std::isfinite(v.pitch)&&std::isfinite(v.distance)&&v.distance>0&&
        std::isfinite(v.fieldOfView)&&v.fieldOfView>0&&v.fieldOfView<180&&std::isfinite(v.roll));
}
struct ContextWire { uint32_t scene{},mask{};uint64_t document{},source{},revision{},content{};bool settled{}; };
struct ColorWire { bool active{};uint32_t base{},effectiveMask{};ContextWire acknowledged;Access::Color metadata; };
struct AlignmentWire { bool active{};uint32_t base{},mask{};ContextWire acknowledged; };
struct TransformWire { bool active{};uint32_t base{},mask{},effectiveMask{};ContextWire acknowledged;browser_transform::Owner metadata; };
struct OpacityWire { bool active{};uint32_t base{},mask{},effectiveMask{};ContextWire acknowledged;browser_opacity::Owner metadata; };
struct SceneWire {
    Scene metadata;
    uint64_t branch{};
    std::optional<browser_duplicate::Range> duplicateRange;
    std::array<std::string_view,3> strings;
    std::span<const uint8_t> gaussians,vertices,triangles;
};
struct RevisionWire {
    uint32_t before{},after{},beforeMask{},afterMask{};
    uint64_t beforeContent{},afterContent{};
    std::span<const uint8_t> changes;
};
struct Wire {
    unsigned codecVersion{};
    uint32_t flags{},sceneCount{},maskCount{},currentScene{},currentMask{},undoCount{},redoCount{};
    bool editable{};
    uint64_t revision{},content{},nextContent{};
    Identities identities;
    std::array<SceneWire,maximumOwners> scenes;
    std::array<std::span<const uint8_t>,maximumOwners> masks;
    std::array<RevisionWire,10> undo,redo;
    ColorWire color;AlignmentWire alignment;TransformWire transform;OpacityWire opacity;
    size_t metadataBytes{};
};
ContextWire context(Reader &r,bool color=false) {
    ContextWire c;c.scene=r.u32();c.mask=r.u32();c.document=r.id();c.source=color?r.id():c.document;
    c.revision=r.id();c.content=r.id();c.settled=r.boolean();return c;
}
void parameters(Reader &r,browser_transform::Parameters &p) {
    const auto mode=r.u8();require(mode<=unsigned(browser_transform::Mode::Matrix));p.mode=browser_transform::Mode(mode);
    p.translation=r.floats<3>();p.scale=r.floats<3>();p.pivot=r.floats<3>();p.euler=r.floats<3>();
    p.axis=r.floats<3>();p.quaternion=r.floats<4>();p.angle=r.f32();p.matrix=r.floats<16>();for(auto &v:p.flips)v=r.boolean();
    finite(p.translation);finite(p.scale);finite(p.pivot);finite(p.euler);finite(p.axis);finite(p.quaternion);finite(p.matrix);require(std::isfinite(p.angle));
}
void transformPlan(Reader &r,browser_transform::Plan &p) {
    p.count=r.u32();require(p.count>=1&&p.count<=p.steps.size());p.matrix=r.floats<16>();finite(p.matrix);
    for(auto &s:p.steps) {for(auto &row:s.a)for(auto &v:row){v=r.f64();require(std::isfinite(v));}for(auto &v:s.t){v=r.f64();require(std::isfinite(v));}}
}
void parse(Wire &w,std::span<const uint8_t> bytes,unsigned maxSplats) {
    require(bytes.size()>=headerBytes&&std::equal(magic.begin(),magic.end(),bytes.begin()));
    Reader r{bytes};r.take(8);const auto wireVersion=r.u32();w.codecVersion=wireVersion;
    // Keep historical formats explicit: raising the writer version must not
    // silently remove v2's effective-mask layout from the reader.
    require(supportedCodec(wireVersion)&&r.u32()==headerBytes&&r.u64()==bytes.size());
    const auto expected=r.take(32);require(r.u32()==0);w.flags=r.u32();require(!(w.flags&~uint32_t(127)));
    picosha2::hash256_one_by_one hash;hash.process(bytes.begin()+headerBytes,bytes.end());hash.finish();
    std::array<uint8_t,32> actual;hash.get_hash_bytes(actual.begin(),actual.end());require(std::equal(actual.begin(),actual.end(),expected.begin()));
    require(r.u32()==w.flags); // Bind the header's policy flags into the digest.
    w.sceneCount=r.u32();w.maskCount=r.u32();require(w.sceneCount>=1&&w.sceneCount<=maximumOwners&&w.maskCount<=maximumOwners);
    w.currentScene=r.u32();w.currentMask=r.u32();w.editable=r.boolean();w.revision=r.id();w.content=r.id();w.nextContent=r.id();
    require(w.content<=w.nextContent);w.identities.document=r.id(true);
    for(auto &id:w.identities.next){id=r.u64();require(id>=1&&id<=maximumIdentity+1);}
    w.identities.tolerance=r.id();w.identities.selectionMap=r.id();
    for(auto *attempts:{&w.identities.filterAttempts,&w.identities.transformAttempts,&w.identities.opacityAttempts})
        for(auto &a:*attempts){a[0]=r.id();a[1]=r.id();require(a[0]||!a[1]);}
    for(size_t i=0;i<w.sceneCount;++i) {
        auto &s=w.scenes[i];auto &m=s.metadata;const auto type=r.u8();require(type<=unsigned(SceneType::Mesh));m.type=SceneType(type);
        m.sourceFaces=r.u64();m.sampledGeometry=r.boolean();m.center=r.vec();m.radius=r.f32();validVec(m.center);require(std::isfinite(m.radius)&&m.radius>0);
        if(r.boolean()){m.previewEye=r.vec();validVec(*m.previewEye);}
        if(r.boolean()) {SavedView v;v.target=r.vec();v.yaw=r.f32();v.pitch=r.f32();v.distance=r.f32();v.fieldOfView=r.f32();v.yUp=r.boolean();v.roll=r.f32();validView(v);m.defaultView=v;}
        m.alignmentFrame=r.floats<16>();finite(m.alignmentFrame);browser_alignment::inverseFrame(m.alignmentFrame);
        m.sourceCount=r.u64();m.shDegree=r.u32();require(m.shDegree<=3);m.yUp=r.boolean();m.sourceBytes=r.u64();s.branch=r.id();
        for(auto &str:s.strings){str=r.text();w.metadataBytes=checkedByteSum({w.metadataBytes,std::max(size_t(32),product(str.size()+1,2))});}
        const auto ng=r.u32(),nv=r.u32(),nt=r.u32();require(ng<=maxSplats&&nv<=maxSplats&&nt<=10'000'000);
        require(m.isGaussian()?(!nv&&!nt):!ng);require(m.type!=SceneType::PointCloud||!nt);
        const auto loaded=m.isGaussian()?ng:nv;require(m.sourceCount>=loaded);if(m.type==SceneType::Mesh)require(m.sourceFaces>=nt);
        if(wireVersion>=3&&r.boolean())s.duplicateRange=browser_duplicate::Range{r.u32(),r.u32()};
        validRange(s.duplicateRange,m.isGaussian(),loaded);
        s.gaussians=r.take(product(ng,144));s.vertices=r.take(product(nv,16));s.triangles=r.take(product(nt,12));
        // Preserve all reserved float and SH words as opaque bits. Only actual
        // position/opacity/covariance values are semantic scalar fields.
        for(size_t g=0;g<ng;++g)for(size_t k=0;k<10;++k)require(std::isfinite(scalar(le32(s.gaussians.data()+144*g+4*k))));
        for(size_t v=0;v<nv;++v)for(size_t k=0;k<3;++k)require(std::isfinite(scalar(le32(s.vertices.data()+16*v+4*k))));
        for(size_t k=0;k<s.triangles.size();k+=4)require(le32(s.triangles.data()+k)<nv);
    }
    require(w.metadataBytes<=2*maximumMetadataBytes+maximumOwners*3*32);
    for(size_t i=0;i<w.maskCount;++i) {const auto count=r.u32();require(count<=maxSplats);w.masks[i]=r.take(count);for(const auto v:w.masks[i])require(v<=2);}
    const auto revisions=[&](auto &stack,uint32_t &count) {
        count=r.u32();require(count<=stack.size());for(size_t i=0;i<count;++i) {
            auto &v=stack[i];v.before=r.u32();v.after=r.u32();v.beforeMask=r.u32();v.afterMask=r.u32();v.beforeContent=r.id();v.afterContent=r.id();
            require(v.beforeContent<=w.nextContent&&v.afterContent<=w.nextContent);const auto n=r.u32();require(n<=maxSplats);v.changes=r.take(product(n,6));
        }
    };
    revisions(w.undo,w.undoCount);revisions(w.redo,w.redoCount);require(w.undoCount+w.redoCount<=10);
    w.color.active=r.boolean();if(w.color.active) {
        auto &c=w.color;auto &m=c.metadata;c.base=r.u32();c.acknowledged=context(r,true);m.applied=r.floats<15>();
        require(browser_color_metadata::BrowserColorSession::validValues(m.applied));m.sessionId=r.id(true);m.baseId=r.id(true);m.baseContentRevision=r.id();
        m.epochId=r.id(true);m.valuesId=r.id(true);m.selectedOnly=r.boolean();if(wireVersion>=2)c.effectiveMask=r.u32();
    }
    w.alignment.active=r.boolean();if(w.alignment.active){w.alignment.base=r.u32();w.alignment.mask=r.u32();w.alignment.acknowledged=context(r);}
    w.transform.active=r.boolean();if(w.transform.active) {
        auto &v=w.transform;auto &m=v.metadata;v.base=r.u32();v.mask=r.u32();v.acknowledged=context(r);m.id=r.id(true);m.baseId=r.id(true);m.epoch=r.id();
        if(r.boolean())m.appliedEpoch=r.id(true);const auto kind=r.u8();require(kind<=unsigned(browser_transform::Kind::Gizmo));m.kind=browser_transform::Kind(kind);
        m.selectedOnly=r.boolean();m.appliedBake=r.boolean();parameters(r,m.applied);transformPlan(r,m.appliedPlan);m.pivot=r.vec();validVec(m.pivot);
        require(!m.appliedEpoch||*m.appliedEpoch<=m.epoch);if(wireVersion>=2)v.effectiveMask=r.u32();
    }
    w.opacity.active=r.boolean();if(w.opacity.active) {
        auto &v=w.opacity;auto &m=v.metadata;v.base=r.u32();v.mask=r.u32();v.acknowledged=context(r);m.id=r.id(true);m.baseId=r.id(true);m.epoch=r.id();
        if(r.boolean())m.appliedEpoch=r.id(true);m.selectedOnly=r.boolean();m.appliedScale=r.f32();require(browser_opacity::validScale(m.appliedScale)&&(!m.appliedEpoch||*m.appliedEpoch<=m.epoch));
        if(wireVersion>=2)v.effectiveMask=r.u32();
    }
    require(r.at==bytes.size());
}
std::span<const uint8_t> mask(const Wire &w,uint32_t id) { require(id&&id<=w.maskCount);return w.masks[id-1]; }
const SceneWire &scene(const Wire &w,uint32_t id) { require(id&&id<=w.sceneCount);return w.scenes[id-1]; }
size_t count(const SceneWire &s) { return s.metadata.isGaussian()?s.gaussians.size()/144:s.vertices.size()/16; }
void matchesExpected(const Wire &w,const Restore::Expected &e) {
    require(w.codecVersion==e.codecVersion&&w.revision==e.revision&&w.content==e.contentRevision&&w.nextContent==e.nextContentRevision);
    const auto &current=scene(w,w.currentScene);
    require(count(current)==e.currentLoadedCount&&current.metadata.sourceCount==e.currentSourceCount&&
        sameRange(current.duplicateRange,e.currentDuplicateRange));
    size_t maximum=1;
    for(size_t i=0;i<w.sceneCount;++i) {
        const auto &s=w.scenes[i];
        // The original import identity stays external and immutable. Its count
        // is a floor for every retained scene, not an edited-count ceiling.
        require(s.metadata.sourceCount>=e.originalSourceCount&&s.metadata.sourceCount<=std::numeric_limits<uint32_t>::max());
        maximum=std::max(maximum,count(s));
    }
    for(size_t i=0;i<w.maskCount;++i)maximum=std::max(maximum,w.masks[i].size());
    // Authenticate the exact maximum, including a larger Redo or tool base.
    // An inflated ceiling is not accepted as equivalent to the held plan.
    require(maximum==e.maximumGraphSplats);
}
void maskScene(const Wire &w,uint32_t s,uint32_t m) { require(scene(w,s).metadata.isGaussian()&&mask(w,m).size()==count(scene(w,s))); }
void effectiveMask(const Wire &w,uint32_t s,uint32_t original,uint32_t effective) {
    if(!effective)return;
    maskScene(w,s,effective);const auto before=mask(w,original),after=mask(w,effective);require(before.size()==after.size());
    for(size_t i=0;i<before.size();++i)require(after[i]==before[i]||(before[i]==1&&after[i]==0));
}
void acknowledged(const Wire &w,const ContextWire &c,bool color=false) {
    maskScene(w,c.scene,c.mask);require(c.settled&&c.document==w.identities.document&&(!color||c.source==w.identities.document)&&
        c.scene==w.currentScene&&c.mask==w.currentMask&&c.revision==w.revision&&c.content==w.content);
}
void validate(const Wire &w,std::shared_ptr<SceneMemory> memory) {
    require(w.currentScene&&w.currentScene<=w.sceneCount);
    require(w.editable==scene(w,w.currentScene).metadata.isGaussian());
    if(!w.editable) {
        require(!w.currentMask&&!w.maskCount&&!w.revision&&!w.content&&!w.nextContent&&!w.undoCount&&!w.redoCount&&
            !w.color.active&&!w.alignment.active&&!w.transform.active&&!w.opacity.active&&w.sceneCount==1);return;
    }
    maskScene(w,w.currentScene,w.currentMask);
    for(size_t i=0;i<w.sceneCount;++i)require(w.scenes[i].metadata.isGaussian()&&w.scenes[i].branch<w.identities.next[1]);
    for(const auto *stack:{&w.undo,&w.redo})for(const auto &v:*stack) {
        if(!v.before&&!v.after&&!v.beforeMask&&!v.afterMask&&v.changes.empty())continue;
        if(v.before||v.after) {
            require(v.before&&v.after&&v.before!=v.after&&v.changes.empty()&&v.afterContent>v.beforeContent);
            maskScene(w,v.before,v.beforeMask);maskScene(w,v.after,v.afterMask);
        } else require(!v.beforeMask&&!v.afterMask&&!v.changes.empty());
    }
    // Prove both ordered history paths against the exact current mask/content.
    // One admitted mask scratch is reused; Gaussian payloads are never copied.
    AdmittedVector<uint8_t> scratch{AdmittedAllocator<uint8_t>{memory}};
    const auto walk=[&](const auto &stack,size_t size,bool forward) {
        auto current=w.currentScene;auto content=w.content;const auto initial=mask(w,w.currentMask);
        scratch.assign(initial.begin(),initial.end());
        for(size_t i=size;i>0;--i) {
            const auto &v=stack[i-1];require(content==(forward?v.beforeContent:v.afterContent));
            if(v.before) {
                require(current==(forward?v.before:v.after));const auto expected=mask(w,forward?v.beforeMask:v.afterMask);
                require(scratch.size()==expected.size()&&std::equal(scratch.begin(),scratch.end(),expected.begin()));
                current=forward?v.after:v.before;const auto next=mask(w,forward?v.afterMask:v.beforeMask);scratch.assign(next.begin(),next.end());
            } else {
                require(!v.changes.empty());uint32_t previous=0;bool first=true,contentChange=false;
                for(size_t at=0;at<v.changes.size();at+=6) {
                    const auto p=v.changes.data()+at;const auto index=le32(p);const auto before=p[4],after=p[5];
                    require(index<scratch.size()&&(first||index>previous)&&before<=2&&after<=2&&before!=after&&scratch[index]==(forward?before:after));
                    contentChange|=((before^after)&2)!=0;scratch[index]=forward?after:before;first=false;previous=index;
                }
                require(contentChange?(v.afterContent>v.beforeContent):(v.beforeContent==v.afterContent));
            }
            content=forward?v.afterContent:v.beforeContent;
        }
    };
    walk(w.undo,w.undoCount,false);walk(w.redo,w.redoCount,true);
    if(w.color.active) {
        const auto &c=w.color;const auto &m=c.metadata;acknowledged(w,c.acknowledged,true);require(scene(w,c.base).metadata.isGaussian()&&count(scene(w,c.base))==count(scene(w,w.currentScene)));
        effectiveMask(w,c.base,c.acknowledged.mask,c.effectiveMask);
        for(const auto n:{m.sessionId,m.baseId,m.epochId,m.valuesId})require(n<w.identities.next[0]);require(m.baseContentRevision<=w.nextContent);
    }
    if(w.alignment.active) {acknowledged(w,w.alignment.acknowledged);maskScene(w,w.alignment.base,w.alignment.mask);require(mask(w,w.alignment.mask).size()==mask(w,w.currentMask).size());}
    if(w.transform.active) {
        const auto &v=w.transform;acknowledged(w,v.acknowledged);maskScene(w,v.base,v.mask);require(mask(w,v.mask).size()==mask(w,w.currentMask).size()&&v.metadata.id<w.identities.next[4]&&v.metadata.baseId<w.identities.next[4]);
        effectiveMask(w,v.base,v.mask,v.effectiveMask);
        browser_transform::Plan rebuilt;require(browser_transform::plan(v.metadata.applied,rebuilt));
        require(browser_transform::same(rebuilt,v.metadata.appliedPlan)&&rebuilt.matrix==v.metadata.appliedPlan.matrix);
        require(v.metadata.appliedBake?bool(v.metadata.appliedEpoch):browser_transform::identity(v.metadata.appliedPlan));
        if(!v.metadata.appliedEpoch)require(browser_transform::identity(v.metadata.appliedPlan));
    }
    if(w.opacity.active) {const auto &v=w.opacity;acknowledged(w,v.acknowledged);maskScene(w,v.base,v.mask);require(mask(w,v.mask).size()==mask(w,w.currentMask).size()&&v.metadata.id<w.identities.next[5]&&v.metadata.baseId<w.identities.next[5]&&(v.metadata.appliedEpoch||v.metadata.appliedScale==1));effectiveMask(w,v.base,v.mask,v.effectiveMask);}
    require(unsigned(w.color.active)+unsigned(w.transform.active)+unsigned(w.opacity.active)<=1);
    for(size_t kind=0;kind<3;++kind) {
        const auto &attempts=kind==0?w.identities.filterAttempts:kind==1?w.identities.transformAttempts:w.identities.opacityAttempts;
        for(const auto &a:attempts)require(!a[0]||a[0]<w.identities.next[3+kind]);
    }
}
} // namespace

struct Plan::Impl {
    ResourceBudget budget;ResourceReservation object;
    std::shared_ptr<SceneMemory> memory;
    Description description;
    AdmittedVector<uint8_t> metadata,scratch;
    AdmittedVector<Segment> segments;
    std::array<std::shared_ptr<const Scene>,maximumOwners> scenes;
    std::array<std::optional<browser_duplicate::Range>,maximumOwners> duplicateRanges;
    std::array<MaskStorage,maximumOwners> masks;
    size_t sceneCount{},maskCount{},literalStart{},length{headerBytes};
    std::array<uint8_t,headerBytes> header{};
    explicit Impl(ResourceBudget b):budget(std::move(b)),object(budget.reserve(ResourceCategory::Work,sizeof(Impl))),memory(sceneMemoryForBudget(budget,ResourceCategory::Work)),
        metadata(AdmittedAllocator<uint8_t>{memory}),scratch(AdmittedAllocator<uint8_t>{memory}),segments(AdmittedAllocator<Segment>{memory}) {}
    uint32_t addScene(const std::shared_ptr<const Scene> &s) {
        if(!s)return 0;for(size_t i=0;i<sceneCount;++i)if(scenes[i]==s)return uint32_t(i+1);
        require(sceneCount<scenes.size());scenes[sceneCount++]=s;return uint32_t(sceneCount);
    }
    uint32_t addMask(const MaskStorage &m) {
        if(!m.hasStorage())return 0;const auto owner=BrowserSelectionAccess::recoveryMaskOwner(m);
        for(size_t i=0;i<maskCount;++i)if(BrowserSelectionAccess::recoveryMaskOwner(masks[i])==owner)return uint32_t(i+1);
        require(maskCount<masks.size());masks[maskCount++]=m;return uint32_t(maskCount);
    }
    void u8(uint8_t n){require(metadata.size()<maximumMetadataBytes);metadata.push_back(n);}
    void boolean(bool n){u8(n?1:0);}
    void u32(uint32_t n){for(size_t i=0;i<4;++i)u8(uint8_t(n>>(8*i)));}
    void u64(uint64_t n){for(size_t i=0;i<8;++i)u8(uint8_t(n>>(8*i)));}
    void f32(float n){u32(word(n));}
    void f64(double n){u64(std::bit_cast<uint64_t>(n));}
    void vec(Vec3 v){f32(v.x);f32(v.y);f32(v.z);}
    template<class A>void floats(const A &a){for(const auto n:a)f32(n);}
    void text(const std::string &s){require(s.size()<=1024*1024);u32(uint32_t(s.size()));for(const auto ch:s)u8(uint8_t(ch));}
    void flush(){if(metadata.size()!=literalStart){const auto n=metadata.size()-literalStart;segments.push_back({SegmentKind::Metadata,length,n,literalStart,nullptr});length=checkedByteSum({length,n});literalStart=metadata.size();}}
    void data(SegmentKind kind,const void *pointer,size_t n){flush();if(n){require(pointer);segments.push_back({kind,length,n,0,pointer});length=checkedByteSum({length,n});}}
    void ctx(const browser_color_metadata::Context &c) {u32(addScene(c.scene));u32(addMask(c.states));u64(c.documentId);u64(c.sourceGeneration);u64(c.revision);u64(c.contentRevision);boolean(c.settled);}
    template<class C>void ctx(const C &c) {u32(addScene(c.scene));u32(addMask(c.states));if constexpr(requires{c.document;})u64(c.document);else u64(c.generation);u64(c.revision);u64(c.contentRevision);boolean(c.settled);}
    void parameter(const browser_transform::Parameters &p) {u8(uint8_t(p.mode));floats(p.translation);floats(p.scale);floats(p.pivot);floats(p.euler);floats(p.axis);floats(p.quaternion);f32(p.angle);floats(p.matrix);for(const auto v:p.flips)boolean(v);}
    void plan(const browser_transform::Plan &p) {u32(uint32_t(p.count));floats(p.matrix);for(const auto &s:p.steps){for(const auto &row:s.a)for(const auto v:row)f64(v);for(const auto v:s.t)f64(v);}}
    void encodeScene(const Scene &s,uint64_t branch,const std::optional<browser_duplicate::Range> &duplicateRange) {
        u8(uint8_t(s.type));u64(s.sourceFaces);boolean(s.sampledGeometry);vec(s.center);f32(s.radius);boolean(bool(s.previewEye));if(s.previewEye)vec(*s.previewEye);
        boolean(bool(s.defaultView));if(s.defaultView){const auto &v=*s.defaultView;vec(v.target);f32(v.yaw);f32(v.pitch);f32(v.distance);f32(v.fieldOfView);boolean(v.yUp);f32(v.roll);}
        floats(s.alignmentFrame);u64(s.sourceCount);u32(s.shDegree);boolean(s.yUp);u64(s.sourceBytes);u64(branch);text(s.format);text(s.sourceContentKey);text(s.sourceFileIdentity);
        require(s.gaussians.size()<=1'000'000&&s.vertices.size()<=1'000'000&&s.triangles.size()<=10'000'000);
        u32(uint32_t(s.gaussians.size()));u32(uint32_t(s.vertices.size()));u32(uint32_t(s.triangles.size()));
        validRange(duplicateRange,s.isGaussian(),s.loadedCount());
        boolean(bool(duplicateRange));if(duplicateRange){u32(uint32_t(duplicateRange->first));u32(uint32_t(duplicateRange->count));}
        data(SegmentKind::Gaussians,s.gaussians.data(),product(s.gaussians.size(),144));data(SegmentKind::Vertices,s.vertices.data(),product(s.vertices.size(),16));data(SegmentKind::Triangles,s.triangles.data(),product(s.triangles.size(),12));
    }
    template<class Stack>void collect(const Stack &stack){for(const auto &v:stack){addScene(v.before);addScene(v.after);addMask(v.beforeStates);addMask(v.afterStates);}}
    template<class Stack>void history(const Stack &stack){require(stack.size()<=10);u32(uint32_t(stack.size()));for(const auto &v:stack){u32(addScene(v.before));u32(addScene(v.after));u32(addMask(v.beforeStates));u32(addMask(v.afterStates));u64(v.beforeContent);u64(v.afterContent);require(v.changes.size()<=1'000'000);u32(uint32_t(v.changes.size()));data(SegmentKind::Changes,v.changes.data(),product(v.changes.size(),6));}}
    void copy(size_t offset,std::span<uint8_t> out) const {
        require(offset<=length&&out.size()<=length-offset);size_t done=0;
        if(offset<headerBytes){const auto n=std::min(out.size(),headerBytes-offset);std::copy_n(header.data()+offset,n,out.data());done=n;offset+=n;}
        auto it=std::upper_bound(segments.begin(),segments.end(),offset,[](size_t at,const Segment &s){return at<s.start;});if(it!=segments.begin())--it;
        while(done<out.size()){
            require(it!=segments.end()&&offset>=it->start&&offset<it->start+it->size);const auto local=offset-it->start,n=std::min(out.size()-done,it->size-local);
            if(it->kind==SegmentKind::Metadata)std::copy_n(metadata.data()+it->offset+local,n,out.data()+done);
            else for(size_t i=0;i<n;++i)out[done+i]=segmentByte(*it,local+i);
            done+=n;offset+=n;++it;
        }
    }
};
Plan::Plan(const Source &s,ResourceBudget budget):impl_(std::make_unique<Impl>(std::move(budget))) {
    auto &p=*impl_;require(s.identities.document&&((s.edits&&!s.geometry)||(!s.edits&&s.geometry)));
    // A marker-aware binding must provide even an empty live table. Omitting
    // the new owner must not silently erase markers from a Gaussian graph.
    require(!s.edits||s.duplicateLineage);
    const auto current=s.edits?s.edits->scene():s.geometry;require(bool(current));const auto currentMask=s.edits?BrowserSelectionAccess::recoveryMask(*s.edits):MaskStorage{};
    const auto sceneId=p.addScene(current),maskId=p.addMask(currentMask);
    if(s.edits){p.collect(BrowserSelectionAccess::recoveryUndo(*s.edits));p.collect(BrowserSelectionAccess::recoveryRedo(*s.edits));}
    auto color=s.color?Access::color(*s.color):Access::Color{};
    auto alignment=s.alignment?Access::alignment(*s.alignment):Access::Alignment{};
    auto transform=s.transform?*s.transform:std::optional<browser_transform::Owner>{};
    auto opacity=s.opacity?*s.opacity:std::optional<browser_opacity::Owner>{};
    // Multi-drag gizmo Cancel ownership is deliberately worker-local. Codec3
    // retains accepted geometry/history and numeric absolute bases; replacement
    // workers leave gizmo mode instead of inventing its first Cancel baseline.
    if(transform&&transform->kind==browser_transform::Kind::Gizmo)transform.reset();
    // Only immutable current/session owners survive. Stale metadata could not
    // safely reset even before a crash, and is deliberately retired here.
    const auto exact=[&](const auto &c){return s.edits&&c.scene==s.edits->scene()&&BrowserSelectionAccess::recoveryMaskOwner(c.states)==BrowserSelectionAccess::recoveryMaskOwner(currentMask)&&c.revision==BrowserSelectionAccess::recoveryRevision(*s.edits)&&c.contentRevision==s.edits->contentRevision();};
    if(color.base&&!exact(color.acknowledged))color={};if(alignment.base&&!exact(alignment.acknowledged))alignment={};
    if(transform&&!exact(transform->acknowledged))transform.reset();if(opacity&&!exact(opacity->acknowledged))opacity.reset();
    if(color.base){p.addScene(color.base);p.addScene(color.acknowledged.scene);p.addMask(color.acknowledged.states);p.addMask(color.effectiveStates);}
    if(alignment.base){p.addScene(alignment.base);p.addMask(alignment.states);p.addScene(alignment.acknowledged.scene);p.addMask(alignment.acknowledged.states);}
    if(transform){p.addScene(transform->base);p.addMask(transform->states);p.addMask(transform->effectiveStates);p.addScene(transform->acknowledged.scene);p.addMask(transform->acknowledged.states);}
    if(opacity){p.addScene(opacity->base);p.addMask(opacity->states);p.addMask(opacity->effectiveStates);p.addScene(opacity->acknowledged.scene);p.addMask(opacity->acknowledged.states);}
    auto &d=p.description;d.normalizationFlags=s.transientFlags|(s.edits&&s.edits->selectionDraft()?1u:0u);
    d.currentLoadedCount=current->loadedCount();d.currentSourceCount=current->sourceCount;
    for(size_t i=0;i<p.sceneCount;++i) {
        const auto &node=p.scenes[i];const auto loaded=node->loadedCount();
        require(loaded<=browser_duplicate::sceneLimit&&node->sourceCount>=loaded&&node->sourceCount&&
            node->sourceCount<=std::numeric_limits<uint32_t>::max());
        p.duplicateRanges[i]=s.duplicateLineage?s.duplicateLineage->find(node):std::optional<browser_duplicate::Range>{};
        validRange(p.duplicateRanges[i],node->isGaussian(),loaded);
        d.maximumGraphSplats=std::max(d.maximumGraphSplats,loaded);
    }
    for(size_t i=0;i<p.maskCount;++i){require(p.masks[i].size()<=browser_duplicate::sceneLimit);d.maximumGraphSplats=std::max(d.maximumGraphSplats,p.masks[i].size());}
    d.currentDuplicateRange=p.duplicateRanges[sceneId-1];
    d.revision=s.edits?BrowserSelectionAccess::recoveryRevision(*s.edits):0;d.contentRevision=s.edits?s.edits->contentRevision():0;d.nextContentRevision=s.edits?BrowserSelectionAccess::recoveryNextContent(*s.edits):0;
    identity(d.revision);identity(d.contentRevision);identity(d.nextContentRevision);identity(s.identities.document,true);
    p.u32(d.normalizationFlags);p.u32(uint32_t(p.sceneCount));p.u32(uint32_t(p.maskCount));p.u32(sceneId);p.u32(maskId);p.boolean(bool(s.edits));p.u64(d.revision);p.u64(d.contentRevision);p.u64(d.nextContentRevision);
    p.u64(s.identities.document);for(const auto n:s.identities.next)p.u64(n);p.u64(s.identities.tolerance);p.u64(s.identities.selectionMap);
    for(const auto *attempts:{&s.identities.filterAttempts,&s.identities.transformAttempts,&s.identities.opacityAttempts})for(const auto &a:*attempts){p.u64(a[0]);p.u64(a[1]);}
    const auto collectedScenes=p.sceneCount,collectedMasks=p.maskCount;
    for(size_t i=0;i<collectedScenes;++i)p.encodeScene(*p.scenes[i],s.lineage?s.lineage->branch(p.scenes[i]):0,p.duplicateRanges[i]);
    for(size_t i=0;i<collectedMasks;++i){p.u32(uint32_t(p.masks[i].size()));p.data(SegmentKind::Mask,p.masks[i].data(),p.masks[i].size());}
    if(s.edits){p.history(BrowserSelectionAccess::recoveryUndo(*s.edits));p.history(BrowserSelectionAccess::recoveryRedo(*s.edits));}else{p.u32(0);p.u32(0);}
    p.boolean(bool(color.base));if(color.base){p.u32(p.addScene(color.base));p.ctx(color.acknowledged);p.floats(color.applied);p.u64(color.sessionId);p.u64(color.baseId);p.u64(color.baseContentRevision);p.u64(color.epochId);p.u64(color.valuesId);p.boolean(color.selectedOnly);p.u32(p.addMask(color.effectiveStates));}
    p.boolean(bool(alignment.base));if(alignment.base){p.u32(p.addScene(alignment.base));p.u32(p.addMask(alignment.states));p.ctx(alignment.acknowledged);}
    p.boolean(bool(transform));if(transform){const auto &v=*transform;p.u32(p.addScene(v.base));p.u32(p.addMask(v.states));p.ctx(v.acknowledged);p.u64(v.id);p.u64(v.baseId);p.u64(v.epoch);p.boolean(bool(v.appliedEpoch));if(v.appliedEpoch)p.u64(*v.appliedEpoch);p.u8(uint8_t(v.kind));p.boolean(v.selectedOnly);p.boolean(v.appliedBake);p.parameter(v.applied);p.plan(v.appliedPlan);p.vec(v.pivot);p.u32(p.addMask(v.effectiveStates));}
    p.boolean(bool(opacity));if(opacity){const auto &v=*opacity;p.u32(p.addScene(v.base));p.u32(p.addMask(v.states));p.ctx(v.acknowledged);p.u64(v.id);p.u64(v.baseId);p.u64(v.epoch);p.boolean(bool(v.appliedEpoch));if(v.appliedEpoch)p.u64(*v.appliedEpoch);p.boolean(v.selectedOnly);p.f32(v.appliedScale);p.u32(p.addMask(v.effectiveStates));}
    require(p.sceneCount==collectedScenes&&p.maskCount==collectedMasks);p.flush();require(p.length<=2147483647);
    p.scratch.resize(std::min(maximumChunkBytes,p.length));picosha2::hash256_one_by_one hash;
    for(size_t offset=headerBytes;offset<p.length;){const auto n=std::min(p.scratch.size(),p.length-offset);p.copy(offset,std::span(p.scratch).first(n));hash.process(p.scratch.begin(),p.scratch.begin()+n);offset+=n;}
    hash.finish();hash.get_hash_bytes(d.sha256.begin(),d.sha256.end());std::copy(magic.begin(),magic.end(),p.header.begin());put32(p.header.data()+8,version);put32(p.header.data()+12,headerBytes);put64(p.header.data()+16,p.length);std::copy(d.sha256.begin(),d.sha256.end(),p.header.begin()+24);put32(p.header.data()+56,0);put32(p.header.data()+60,d.normalizationFlags);
    picosha2::hash256_one_by_one headerHash;headerHash.process(p.header.begin(),p.header.end());headerHash.finish();headerHash.get_hash_bytes(d.headerSha256.begin(),d.headerSha256.end());
    d.byteLength=p.length;d.sceneCount=p.sceneCount;d.maskCount=p.maskCount;d.workspaceBytes=checkedByteSum({sizeof(Impl),p.metadata.capacity(),product(p.segments.capacity(),sizeof(Segment)),p.scratch.capacity()});
}
Plan::~Plan()=default;
const Description &Plan::description() const noexcept{return impl_->description;}
std::span<const uint8_t> Plan::read(size_t offset,size_t count) {
    auto &p=*impl_;require(count&&count<=maximumChunkBytes&&offset<=p.length&&count<=p.length-offset);
    p.scratch.resize(count);p.copy(offset,p.scratch);return p.scratch;
}

struct Restore::Impl {
    ResourceBudget budget;ResourceReservation previous,object;
    std::shared_ptr<SceneMemory> work;
    AdmittedVector<uint8_t> input;
    Expected expected;size_t cursor{};
    Impl(size_t total,const Expected &admitted,unsigned bytes,size_t old):budget(bytes),previous(budget.reserve(ResourceCategory::Work,old)),object(budget.reserve(ResourceCategory::Work,sizeof(Impl))),work(sceneMemoryForBudget(budget,ResourceCategory::Work)),input(AdmittedAllocator<uint8_t>{work}),expected(admitted) {
        validExpected(expected);
        require(total>=headerBytes&&total<=2147483647&&bytes);input.resize(total);
    }
};
Restore::Restore(size_t total,const Expected &expected,unsigned bytes,size_t previous):impl_(std::make_unique<Impl>(total,expected,bytes,previous)) {}
Restore::~Restore()=default;
void Restore::write(size_t offset,std::span<const uint8_t> data) {
    auto &p=*impl_;require(offset==p.cursor&&!data.empty()&&data.size()<=maximumChunkBytes&&offset<=p.input.size()&&data.size()<=p.input.size()-offset);
    std::copy(data.begin(),data.end(),p.input.begin()+offset);p.cursor+=data.size();
}
size_t Restore::written() const noexcept{return impl_->cursor;}
size_t Restore::total() const noexcept{return impl_->input.size();}
size_t Restore::publicationRetiredBytes() const noexcept {
    return impl_->input.capacity()+impl_->previous.bytes()+impl_->object.bytes();
}
Candidate Restore::finish() {
    auto &p=*impl_;require(p.cursor==p.input.size());
    auto wireGrant=p.budget.reserve(ResourceCategory::Work,sizeof(Wire));auto wire=std::make_unique<Wire>();
    parse(*wire,p.input,unsigned(p.expected.maximumGraphSplats));matchesExpected(*wire,p.expected);validate(*wire,p.work);const auto &w=*wire;
    Candidate result(p.budget);result.identities=w.identities;result.normalizationFlags=w.flags;
    // Scene vectors, masks, history nodes/deltas all use their real allocator
    // services. Object/string payload is an explicit retained grant as strings
    // do not carry SceneAllocator. Allocator/control-block overhead is excluded.
    result.metadata=p.budget.reserve(ResourceCategory::Decoded,checkedByteSum({w.metadataBytes,product(w.sceneCount,sizeof(Scene)),w.editable?sizeof(SceneEdits):0}));
    auto decoded=sceneMemoryForBudget(p.budget,ResourceCategory::Decoded),history=sceneMemoryForBudget(p.budget,ResourceCategory::History),scratch=sceneMemoryForBudget(p.budget,ResourceCategory::Work);
    std::array<std::shared_ptr<const Scene>,maximumOwners> scenes;
    std::array<MaskStorage,maximumOwners> masks;
    for(size_t i=0;i<w.sceneCount;++i) {
        const auto &s=w.scenes[i];auto node=std::make_shared<Scene>(decoded);auto &m=*node;const auto &v=s.metadata;
        m.type=v.type;m.sourceFaces=v.sourceFaces;m.sampledGeometry=v.sampledGeometry;m.center=v.center;m.radius=v.radius;m.previewEye=v.previewEye;m.defaultView=v.defaultView;m.alignmentFrame=v.alignmentFrame;
        m.sourceCount=v.sourceCount;m.shDegree=v.shDegree;m.yUp=v.yUp;m.sourceBytes=v.sourceBytes;m.format=s.strings[0];m.sourceContentKey=s.strings[1];m.sourceFileIdentity=s.strings[2];
        m.gaussians.resize(s.gaussians.size()/144);Reader gauss{s.gaussians};for(auto &g:m.gaussians){for(auto &n:g.positionOpacity)n=gauss.f32();for(auto &n:g.covA)n=gauss.f32();for(auto &n:g.covB)n=gauss.f32();for(auto &n:g.sh)n=gauss.u32();}
        m.vertices.resize(s.vertices.size()/16);Reader vertex{s.vertices};for(auto &vtx:m.vertices){vtx.position=vertex.vec();vtx.color=vertex.u32();}
        m.triangles.resize(s.triangles.size()/12);Reader triangle{s.triangles};for(auto &t:m.triangles)for(auto &n:t)n=triangle.u32();
        scenes[i]=std::move(node);require(result.lineage.associate(scenes[i],s.branch));
        if(s.duplicateRange)require(result.duplicateLineage.associate(scenes[i],*s.duplicateRange));
    }
    for(size_t i=0;i<w.maskCount;++i) {
        const auto id=uint32_t(i+1);
        const bool effective=(w.color.active&&w.color.effectiveMask==id)||
            (w.transform.active&&w.transform.effectiveMask==id)||(w.opacity.active&&w.opacity.effectiveMask==id);
        masks[i]=MaskStorage::copy(w.masks[i],effective?scratch:history);
    }
    const auto sc=[&](uint32_t id){return id?scenes[id-1]:std::shared_ptr<const Scene>{};};
    const auto ma=[&](uint32_t id){return id?masks[id-1]:MaskStorage{};};
    if(w.editable) {
        result.edits=BrowserSelectionAccess::recoveryCreate(sc(w.currentScene),ma(w.currentMask),history,scratch,w.revision,w.content,w.nextContent);
        AdmittedVector<Change> changes{AdmittedAllocator<Change>{scratch}};
        const auto append=[&](const auto &stack,size_t n,bool redo){for(size_t i=0;i<n;++i){const auto &v=stack[i];changes.clear();changes.reserve(v.changes.size()/6);Reader delta{v.changes};while(delta.at<delta.bytes.size()){const auto index=delta.u32();const auto before=delta.u8(),after=delta.u8();changes.push_back({index,before,after});}BrowserSelectionAccess::recoveryAppend(*result.edits,redo,changes,sc(v.before),sc(v.after),ma(v.beforeMask),ma(v.afterMask),v.beforeContent,v.afterContent);}};
        append(w.undo,w.undoCount,false);append(w.redo,w.redoCount,true);
    } else result.geometry=sc(w.currentScene);
    if(w.color.active){auto c=w.color.metadata;const auto &v=w.color.acknowledged;c.base=sc(w.color.base);c.effectiveStates=ma(w.color.effectiveMask);c.acknowledged={sc(v.scene),ma(v.mask),v.document,v.source,v.revision,v.content,v.settled};Access::color(result.color,std::move(c));}
    if(w.alignment.active){const auto &a=w.alignment;const auto &v=a.acknowledged;Access::alignment(result.alignment,{sc(a.base),ma(a.mask),{sc(v.scene),ma(v.mask),v.document,v.revision,v.content,v.settled}});}
    // Old codec3 writers could retain a one-base gizmo owner. Its layout cannot
    // prove a multi-drag Cancel baseline, so cap2 normalizes it explicitly.
    if(w.transform.active&&w.transform.metadata.kind==browser_transform::Kind::Numeric){auto owner=w.transform.metadata;const auto &a=w.transform;const auto &v=a.acknowledged;owner.base=sc(a.base);owner.states=ma(a.mask);owner.effectiveStates=ma(a.effectiveMask);owner.acknowledged={sc(v.scene),ma(v.mask),v.document,v.revision,v.content,v.settled};result.transform=std::move(owner);}
    if(w.opacity.active){auto owner=w.opacity.metadata;const auto &a=w.opacity;const auto &v=a.acknowledged;owner.base=sc(a.base);owner.states=ma(a.mask);owner.effectiveStates=ma(a.effectiveMask);owner.acknowledged={sc(v.scene),ma(v.mask),v.document,v.revision,v.content,v.settled};result.opacity=std::move(owner);}
    return result;
}
} // namespace preview::browser_checkpoint
