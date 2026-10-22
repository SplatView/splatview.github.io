#include "response.hpp"
#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstring>
#include <limits>
#include <type_traits>
#include <utility>

namespace {
constexpr char allocationFailure[]="{\"ok\":false,\"error\":\"Native resource budget exceeded\"}";
constexpr char invalidResponse[]="{\"ok\":false,\"error\":\"Invalid native response\"}";
constexpr char internalFailure[]="{\"ok\":false,\"error\":\"Native operation failed\"}";
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
bool contractSummaryRefusal{};
unsigned contractOperationPublicationRefusal{};
#endif

bool validUtf8(std::string_view text) noexcept {
    for(std::size_t i=0;i<text.size();) {
        const auto lead=static_cast<unsigned char>(text[i++]);
        if(lead<0x80) continue;
        unsigned count{};
        std::uint32_t value{},minimum{};
        if(lead>=0xc2 && lead<=0xdf) { count=1;value=lead&0x1f;minimum=0x80; }
        else if(lead>=0xe0 && lead<=0xef) { count=2;value=lead&0x0f;minimum=0x800; }
        else if(lead>=0xf0 && lead<=0xf4) { count=3;value=lead&7;minimum=0x10000; }
        else return false;
        if(count>text.size()-i) return false;
        for(unsigned j=0;j<count;++j) {
            const auto next=static_cast<unsigned char>(text[i++]);
            if((next&0xc0)!=0x80) return false;
            value=(value<<6)|(next&0x3f);
        }
        if(value<minimum || value>0x10ffff || (value>=0xd800 && value<=0xdfff)) return false;
    }
    return true;
}

class Writer final {
  public:
    Writer(char *data,std::size_t capacity) noexcept : data_(data),capacity_(capacity) {}
    void raw(std::string_view text) noexcept {
        if(!ok_ || text.size()>=capacity_-size_) { ok_=false;return; }
        std::memcpy(data_+size_,text.data(),text.size());size_+=text.size();
    }
    void character(char value) noexcept { raw(std::string_view(&value,1)); }
    void string(std::string_view text) noexcept {
        character('"');
        constexpr char hex[]="0123456789abcdef";
        for(const auto value:text) {
            const auto c=static_cast<unsigned char>(value);
            switch(c) {
            case '"':raw("\\\"");break;
            case '\\':raw("\\\\");break;
            case '\b':raw("\\b");break;
            case '\f':raw("\\f");break;
            case '\n':raw("\\n");break;
            case '\r':raw("\\r");break;
            case '\t':raw("\\t");break;
            default:
                if(c<0x20) {
                    const char escaped[]{'\\','u','0','0',hex[c>>4],hex[c&15]};
                    raw(std::string_view(escaped,sizeof(escaped)));
                } else character(value);
            }
        }
        character('"');
    }
    void value(bool value) noexcept { raw(value ? "true" : "false"); }
    void value(double value) noexcept {
        if(!std::isfinite(value)) { raw("null");return; }
        char text[64];
        const auto result=std::to_chars(text,text+sizeof(text),value,std::chars_format::general);
        if(result.ec!=std::errc{}) { ok_=false;return; }
        const std::string_view serialized(text,std::size_t(result.ptr-text));
        raw(serialized);
        // JSON integer -0 loses its sign on parse. Preserve the previous
        // floating response representation, including negative zero.
        if(serialized.find_first_of(".eE")==std::string_view::npos) raw(".0");
    }
    template<class Integer> requires std::is_integral_v<Integer>
    void value(Integer value) noexcept {
        char text[32];
        const auto result=std::to_chars(text,text+sizeof(text),value);
        if(result.ec!=std::errc{}) { ok_=false;return; }
        raw(std::string_view(text,std::size_t(result.ptr-text)));
    }
    template<class T> void value(const std::optional<T> &value) noexcept {
        if(value) this->value(*value);else raw("null");
    }
    template<class T,std::size_t N> void value(const std::array<T,N> &values) noexcept {
        character('[');
        for(std::size_t i=0;i<N;++i) { if(i) character(',');value(values[i]); }
        character(']');
    }
    template<class T> void field(std::string_view name,const T &value) noexcept {
        character(',');string(name);character(':');this->value(value);
    }
    bool finish(std::size_t &length) noexcept {
        if(!ok_) return false;
        data_[size_]='\0';length=size_;return true;
    }
  private:
    char *data_;
    std::size_t capacity_,size_{};
    bool ok_{true};
};

void summaryObject(Writer &w,const sv_response::Summary &s) noexcept {
    w.raw("{\"ok\":true");
    w.field("loaded",s.loaded);
    if(!s.loaded) {
        w.raw(",\"kind\":0,\"count\":0,\"sourceCount\":0,\"selectionCommitRevision\":0,\"undoSelectionRevision\":0,\"duplicateRange\":null,\"memoryBytes\":0,\"toleranceSessionId\":null,"
              "\"toleranceTool\":null,\"toleranceConnected\":null,\"toleranceRange\":null,\"toleranceRecorded\":null,\"toleranceMapId\":null,"
              "\"selectionMapId\":null,\"selectionMapBytes\":0,\"pendingSelectionMapId\":null,"
              "\"selectionMapRetainedIds\":[],\"exportBytes\":0,\"exportOutputBytes\":0,\"floor\":null,\"filter\":null,\"transformSession\":null,\"opacitySession\":null,\"morphologyRange\":null}");
        return;
    }
    w.field("count",s.count);w.field("sourceCount",s.sourceCount);w.field("sourceFaces",s.sourceFaces);
    w.raw(",\"duplicateRange\":");
    if(s.duplicateRange){w.raw("{\"first\":");w.value(s.duplicateRange->first);w.field("count",s.duplicateRange->count);w.character('}');}
    else w.raw("null");
    w.field("sampledGeometry",s.sampledGeometry);w.raw(",\"geometry\":");
    if(s.geometry) {
        const auto &g=*s.geometry;
        w.raw("{\"layoutVersion\":");w.value(g.layoutVersion);w.field("kind",g.kind);
        w.field("vertexCount",g.vertexCount);w.field("triangleCount",g.triangleCount);
        w.field("vertexStride",g.vertexStride);w.field("indexStride",g.indexStride);
        w.field("vertexBytes",g.vertexBytes);w.field("indexBytes",g.indexBytes);
        w.field("revision",g.revision);w.field("contentRevision",g.contentRevision);w.character('}');
    } else w.raw("null");
    w.field("shDegree",s.shDegree);w.raw(",\"format\":");w.string(s.format);w.field("kind",s.kind);
    w.field("selected",s.selected);w.field("visible",s.visible);
    w.field("canUndo",s.canUndo);w.field("canRedo",s.canRedo);w.field("transaction",s.transaction);
    w.field("selectionDraft",s.selectionDraft);w.field("toleranceSessionId",s.toleranceSessionId);
    w.raw(",\"filter\":");
    if(s.filter) {
        const auto &f=*s.filter;w.raw("{\"id\":");w.value(f.id);w.raw(",\"kind\":");w.string(f.kind);
        w.field("epoch",f.epoch);w.field("previewEpoch",f.previewEpoch);w.field("changed",f.changed);w.character('}');
    } else w.raw("null");
    w.raw(",\"transformSession\":");
    if(s.transformSession) {
        const auto &t=*s.transformSession;w.raw("{\"id\":");w.value(t.id);w.field("baseId",t.baseId);w.field("epoch",t.epoch);
        w.field("appliedEpoch",t.appliedEpoch);w.raw(",\"kind\":");w.string(t.kind);w.field("selectedOnly",t.selectedOnly);
        w.field("appliedMatrix",t.appliedMatrix);w.field("pivot",t.pivot);w.raw(",\"gizmo\":");
        if(t.gizmo) {
            const auto &g=*t.gizmo;w.raw("{\"cancelBaseId\":");w.value(g.cancelBaseId);
            w.field("cancelContentRevision",g.cancelContentRevision);w.field("canUndo",g.canUndo);w.field("canRedo",g.canRedo);w.character('}');
        } else w.raw("null");
        w.character('}');
    } else w.raw("null");
    w.raw(",\"opacitySession\":");
    if(s.opacitySession) {
        const auto &o=*s.opacitySession;w.raw("{\"id\":");w.value(o.id);w.field("baseId",o.baseId);w.field("epoch",o.epoch);
        w.field("appliedEpoch",o.appliedEpoch);w.field("selectedOnly",o.selectedOnly);w.field("appliedScale",o.appliedScale);w.character('}');
    } else w.raw("null");
    w.raw(",\"toleranceTool\":");
    switch(s.toleranceTool) {
    case sv_response::ToleranceTool::Color:w.string("color");break;
    case sv_response::ToleranceTool::Fill:w.string("fill");break;
    default:w.raw("null");break;
    }
    w.field("toleranceConnected",s.toleranceConnected);w.field("toleranceMapId",s.toleranceMapId);
    w.raw(",\"toleranceRange\":");
    if(s.toleranceRange) {
        const auto &r=*s.toleranceRange;w.raw("{\"enabled\":");w.value(r.enabled);
        w.field("radius",r.radius);w.raw(",\"center\":");if(r.center)w.value(*r.center);else w.raw("null");w.character('}');
    } else w.raw("null");
    w.field("toleranceRecorded",s.toleranceRecorded);
    w.field("selectionMapId",s.selectionMapId);w.field("pendingSelectionMapId",s.pendingSelectionMapId);
    w.field("selectionMapBytes",s.selectionMapBytes);w.raw(",\"selectionMapRetainedIds\":[");
    for(std::size_t i=0;i<s.selectionMapRetainedCount;++i) {
        if(i) w.character(',');w.value(s.selectionMapRetainedIds[i]);
    }
    w.character(']');w.field("sceneChanged",s.sceneChanged);w.field("revision",s.revision);
    w.field("contentRevision",s.contentRevision);w.field("selectionCommitRevision",s.selectionCommitRevision);
    w.field("undoSelectionRevision",s.undoSelectionRevision);
    w.field("pending",s.pending);w.field("progress",s.progress);
    w.field("center",s.center);w.field("radius",s.radius);w.field("yUp",s.yUp);
    w.field("camera",s.camera);w.field("memoryBytes",s.memoryBytes);
    w.field("exportBytes",s.exportBytes);w.field("exportOutputBytes",s.exportOutputBytes);
    w.raw(",\"colorSession\":");
    if(s.colorSession) {
        const auto &c=*s.colorSession;
        w.raw("{\"version\":1,\"active\":true");
        w.field("sessionId",c.sessionId);w.field("baseId",c.baseId);w.field("epochId",c.epochId);
        w.field("selectedOnly",c.selectedOnly);w.field("pending",c.pending);
        w.field("values",c.values);w.field("applied",c.applied);w.character('}');
    } else w.raw("null");
    w.raw(",\"alignment\":");
    if(s.alignment) {
        const auto &a=*s.alignment;
        w.raw("{\"version\":2");w.field("frame",a.frame);
        w.field("branchId",a.branchId);w.field("canReset",a.canReset);w.raw(",\"retainedBranchIds\":[");
        for(std::size_t i=0;i<a.retainedBranchCount;++i) { if(i) w.character(',');w.value(a.retainedBranchIds[i]); }
        w.raw("]}");
    } else w.raw("null");
    w.raw(",\"floor\":");
    if(s.floor) {
        const auto &f=*s.floor;
        w.raw("{\"version\":1");w.field("id",f.id);w.raw(",\"status\":");
        switch(f.status) {
        case sv_response::FloorStatus::Pending:w.string("pending");break;
        case sv_response::FloorStatus::Ready:w.string("ready");break;
        case sv_response::FloorStatus::None:w.string("none");break;
        }
        w.raw(",\"stage\":");
        switch(f.stage) {
        case sv_response::FloorStage::Sampling:w.string("sampling");break;
        case sv_response::FloorStage::Threshold:w.string("threshold");break;
        case sv_response::FloorStage::Ransac:w.string("ransac");break;
        case sv_response::FloorStage::Refine:w.string("refine");break;
        case sv_response::FloorStage::Complete:w.string("complete");break;
        }
        w.field("selectedOnly",f.selectedOnly);w.raw(",\"plane\":");
        if(f.plane) {
            const auto &p=*f.plane;w.raw("{\"normal\":");w.value(p.normal);w.field("center",p.center);
            w.field("radius",p.radius);w.field("rms",p.rms);w.field("inliers",p.inliers);w.field("tested",p.tested);
            w.character('}');
        } else w.raw("null");
        w.character('}');
    } else w.raw("null");
    w.raw(",\"morphologyRange\":");
    if(s.morphologyRange) {
        const auto &range=*s.morphologyRange;w.raw("{\"version\":1");w.field("minimum",range.minimum);
        w.field("maximum",range.maximum);w.field("default",range.initial);w.character('}');
    } else w.raw("null");
    w.character('}');
}

// Keys, delimiters and fixed boolean/null/string topology fit below2832 bytes.
// At most148 non-retention numeric positions fit32 bytes each. The64 safe IDs
// each need16 digits plus one separator. Format escaping and wrappers/point
// topology are charged separately; receipt wrappers use the extra fixed reserve
// in both 16384-byte reply slots.
constexpr std::size_t maximumReplyBytes=2832+148*32+64*17+sv_response::formatByteLimit*6+128;
static_assert(maximumReplyBytes<sv_response::Responses::bufferBytes);
// Two fixed receipt snapshots, UUIDs and delimiters fit within 4096 bytes.
static_assert(maximumReplyBytes+4096<sv_response::Responses::bufferBytes);
void operationScope(Writer &w,const sv_operation::Scope &s) noexcept {
    w.raw("{\"version\":1,\"documentId\":");w.string(s.documentId.view());
    w.field("sourceGeneration",s.sourceGeneration);w.raw(",\"clientGeneration\":");w.string(s.clientGeneration.view());w.character('}');
}
void operationOwner(Writer &w,const sv_operation::Owner &o) noexcept {
    w.raw("{\"version\":1,\"documentId\":");w.string(o.scope.documentId.view());
    w.field("sourceGeneration",o.scope.sourceGeneration);w.raw(",\"clientGeneration\":");w.string(o.scope.clientGeneration.view());
    w.field("operationId",o.operationId);w.character('}');
}
void operationState(Writer &w,const sv_operation::State &s) noexcept {
    w.raw("{\"revision\":");w.value(s.revision);w.field("contentRevision",s.contentRevision);
    w.field("count",s.count);w.field("sourceCount",s.sourceCount);w.raw(",\"duplicateRange\":");
    if(s.hasDuplicateRange){w.raw("{\"first\":");w.value(s.duplicateFirst);w.field("count",s.duplicateCount);w.character('}');}
    else w.raw("null");
    w.field("selected",s.selected);w.field("visible",s.visible);w.field("canUndo",s.canUndo);w.field("canRedo",s.canRedo);
    w.field("transaction",s.transaction);w.field("selectionDraft",s.selectionDraft);w.field("pending",s.pending);
    w.field("toleranceSessionId",s.toleranceSessionId);w.field("toleranceMapId",s.toleranceMapId);
    w.field("selectionMapId",s.selectionMapId);w.field("pendingSelectionMapId",s.pendingSelectionMapId);
    w.raw(",\"selectionMapRetainedIds\":[");
    for(std::size_t i=0;i<s.selectionMapRetainedCount;++i) { if(i)w.character(',');w.value(s.selectionMapRetainedIds[i]); }
    w.raw("]}");
}
void operationReceipt(Writer &w,const sv_operation::Receipt &r) noexcept {
    w.raw("{\"version\":2,\"owner\":");operationOwner(w,r.owner);w.raw(",\"outcome\":");w.string(sv_operation::name(r.outcome));
    w.raw(",\"before\":");if(r.before)operationState(w,*r.before);else w.raw("null");
    w.raw(",\"terminal\":");if(r.terminal)operationState(w,*r.terminal);else w.raw("null");w.character('}');
}
} // namespace

namespace sv_response {
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
void refuseNextSummaryForContracts() noexcept { contractSummaryRefusal=true; }
void refuseNextOperationPublicationForContracts() noexcept { contractOperationPublicationRefusal=2; }
#endif
const char *failureReply(FailureKind kind) noexcept {
    switch(kind) {
    case FailureKind::Allocation:return allocationFailure;
    case FailureKind::InvalidResponse:return invalidResponse;
    default:return internalFailure;
    }
}
bool validSummary(const Summary &s) noexcept {
    if(s.undoSelectionRevision>sv_operation::maximumIdentity||s.undoSelectionRevision>s.revision||
       ((!s.loaded||s.kind!=0||!s.canUndo)&&s.undoSelectionRevision))return false;
    if(bool(s.toleranceRange)!=bool(s.toleranceSessionId)||bool(s.toleranceRecorded)!=bool(s.toleranceSessionId))return false;
    if(s.toleranceRange) {
        const auto &r=*s.toleranceRange;const auto finite32=[](double v){return std::isfinite(v)&&double(float(v))==v;};
        if(!s.loaded||s.kind!=0||s.selectionDraft||s.filter||s.transformSession||s.opacitySession||s.colorSession||
           !*s.toleranceSessionId||s.toleranceTool==ToleranceTool::None||
           (r.radius&&(!finite32(*r.radius)||*r.radius<=0))||(r.enabled&&!r.radius)||
           (r.center&&!std::all_of(r.center->begin(),r.center->end(),finite32))||
           (s.toleranceTool==ToleranceTool::Color&&(!r.center||!s.toleranceConnected))||
           (s.toleranceTool==ToleranceTool::Fill&&s.toleranceConnected))return false;
    } else if(s.toleranceTool!=ToleranceTool::None||s.toleranceConnected||s.toleranceMapId)return false;
    if(s.selectionCommitRevision>sv_operation::maximumIdentity ||
       ((!s.loaded || s.kind!=0) && s.selectionCommitRevision!=0)) return false;
    if(s.duplicateRange&&(!s.loaded||s.kind!=0||s.count>1'000'000||s.sourceCount<s.count||
       s.sourceCount>std::numeric_limits<uint32_t>::max()||s.selected>s.visible||s.visible>s.count||
       s.revision>sv_operation::maximumIdentity||s.contentRevision>sv_operation::maximumIdentity||
       !s.duplicateRange->count||s.duplicateRange->first>s.count||
       s.duplicateRange->count!=s.count-s.duplicateRange->first))return false;
    if(s.exportBytes>s.memoryBytes || s.exportOutputBytes>s.exportBytes) return false;
    if(!s.loaded) return !s.floor && !s.filter && !s.transformSession && !s.opacitySession && !s.morphologyRange && !s.exportBytes && !s.exportOutputBytes;
    if(s.morphologyRange) {
        const auto &range=*s.morphologyRange;
        const auto finite32=[](double v){return std::isfinite(v)&&double(float(v))==v;};
        if(s.kind!=0||!s.count||!finite32(range.minimum)||!finite32(range.maximum)||!finite32(range.initial)||
           range.minimum<double(.000001f)||range.minimum>double(1e12f)||range.maximum<2*range.minimum||range.maximum>double(2*1e12f)||
           range.initial!=double(float(std::sqrt(range.minimum*range.maximum))))return false;
    }
    if(s.opacitySession) {
        const auto &o=*s.opacitySession;constexpr auto maximum=9007199254740991ULL;
        if(s.kind!=0||s.selectionDraft||s.filter||s.transformSession||s.colorSession||!o.id||!o.baseId||o.id>maximum||o.baseId>maximum||o.epoch>maximum||
           (o.appliedEpoch&&(!*o.appliedEpoch||*o.appliedEpoch>o.epoch))||!std::isfinite(o.appliedScale)||double(float(o.appliedScale))!=o.appliedScale||
           o.appliedScale<0||o.appliedScale>5||(!o.appliedEpoch&&o.appliedScale!=1))return false;
    }
    if(s.transformSession) {
        const auto &t=*s.transformSession;constexpr auto maximum=9007199254740991ULL;
        const auto finite32=[](double value){return std::isfinite(value)&&double(float(value))==value;};
        if(s.kind!=0||s.selectionDraft||s.filter||s.opacitySession||s.colorSession||!t.id||!t.baseId||t.id>maximum||t.baseId>maximum||t.epoch>maximum||
           (t.appliedEpoch&&(!*t.appliedEpoch||*t.appliedEpoch>t.epoch))||(t.kind!="numeric"&&t.kind!="gizmo")||
           !std::all_of(t.appliedMatrix.begin(),t.appliedMatrix.end(),finite32)||!std::all_of(t.pivot.begin(),t.pivot.end(),finite32)||
           t.appliedMatrix[3]!=0||t.appliedMatrix[7]!=0||t.appliedMatrix[11]!=0||t.appliedMatrix[15]!=1)return false;
        if(!t.appliedEpoch)for(size_t i=0;i<16;++i)if(t.appliedMatrix[i]!=(i%5==0?1:0))return false;
        if(bool(t.gizmo)!=(t.kind=="gizmo"))return false;
        if(t.gizmo) {
            const auto &g=*t.gizmo;
            if(bool(g.cancelBaseId)!=bool(g.cancelContentRevision)||
               (g.cancelBaseId&&(!*g.cancelBaseId||*g.cancelBaseId>maximum||*g.cancelContentRevision>maximum))||
               (!g.cancelBaseId&&(g.canUndo||g.canRedo))||
               (g.canUndo&&!s.canUndo)||(g.canRedo&&!s.canRedo))return false;
        }
    }
    if(s.filter) {
        const auto &f=*s.filter;
        const bool kind=f.kind=="sphere"||f.kind=="box"||f.kind=="ellipsoid"||f.kind=="frustum"||f.kind=="opacity"||f.kind=="scale";
        if(s.kind!=0||s.selectionDraft||!kind||!f.id||f.id>9007199254740991ULL||f.epoch>9007199254740991ULL||
           (f.previewEpoch && (!*f.previewEpoch||*f.previewEpoch>f.epoch))||(f.changed&&!f.previewEpoch)) return false;
    }
    if(s.geometry && s.kind==0) return false;
    if(s.floor) {
        const auto &f=*s.floor;
        if(s.kind!=0 || !f.id || f.id>9007199254740991ULL) return false;
        if((f.status!=FloorStatus::Pending && f.status!=FloorStatus::Ready && f.status!=FloorStatus::None) ||
           unsigned(f.stage)>unsigned(FloorStage::Complete)) return false;
        if(f.status==FloorStatus::Pending) {
            if(!s.pending || f.stage==FloorStage::Complete || f.plane) return false;
        } else if(f.stage!=FloorStage::Complete || (f.status==FloorStatus::Ready)!=bool(f.plane)) return false;
        if(f.plane) {
            const auto &p=*f.plane;
            const auto floatFinite=[](double v) { return std::isfinite(v)&&double(float(v))==v; };
            if(!std::all_of(p.normal.begin(),p.normal.end(),floatFinite)||
               !std::all_of(p.center.begin(),p.center.end(),floatFinite)||!floatFinite(p.radius)||
               !floatFinite(p.rms)||p.radius<=0||p.rms<0||p.inliers<3||p.inliers>p.tested||
               p.tested>std::min<std::size_t>(50000,s.count)) return false;
            const double length=std::sqrt(p.normal[0]*p.normal[0]+p.normal[1]*p.normal[1]+p.normal[2]*p.normal[2]);
            if(std::abs(length-1)>1e-4) return false;
        }
    }
    if(s.alignment && (s.kind!=0 || s.alignment->branchId>9007199254740991ULL ||
       std::any_of(s.alignment->frame.begin(),s.alignment->frame.end(),[](double v){return !std::isfinite(v);})))
        return false;
    if(s.alignment) {
        const auto &a=*s.alignment;bool current=false;
        if(!a.retainedBranchCount || a.retainedBranchCount>a.retainedBranchIds.size()) return false;
        for(std::size_t i=0;i<a.retainedBranchCount;++i) {
            if(a.retainedBranchIds[i]>9007199254740991ULL || (i && a.retainedBranchIds[i]<=a.retainedBranchIds[i-1])) return false;
            current|=a.retainedBranchIds[i]==a.branchId;
        }
        if(!current) return false;
    }
    if(s.colorSession) {
        const auto &c=*s.colorSession;
        constexpr auto maximumSafeId=9007199254740991ULL;
        if(s.kind!=0 || !c.sessionId || !c.baseId || !c.epochId ||
           c.sessionId>maximumSafeId || c.baseId>maximumSafeId || c.epochId>maximumSafeId ||
           std::any_of(c.values.begin(),c.values.end(),[](double v){return !std::isfinite(v);}) ||
           std::any_of(c.applied.begin(),c.applied.end(),[](double v){return !std::isfinite(v);})) return false;
    }
    return s.selectionMapRetainedCount<=s.selectionMapRetainedIds.size() &&
        s.format.size()<=formatByteLimit && validUtf8(s.format) &&
        (s.toleranceTool==ToleranceTool::None || s.toleranceTool==ToleranceTool::Color || s.toleranceTool==ToleranceTool::Fill);
}
Responses::Preparation::Preparation(Responses *owner,unsigned slot,std::uint64_t epoch) noexcept
    : owner_(owner),slot_(slot),epoch_(epoch) {}
Responses::Preparation::Preparation(Preparation &&other) noexcept { *this=std::move(other); }
Responses::Preparation &Responses::Preparation::operator=(Preparation &&other) noexcept {
    if(this!=&other) {
        owner_=std::exchange(other.owner_,nullptr);slot_=other.slot_;epoch_=other.epoch_;
        length_=other.length_;ready_=other.ready_;
    }
    return *this;
}
std::string_view Responses::Preparation::view() const noexcept {
    return owner_ && owner_->owns(*this) && ready_ ?
        std::string_view(owner_->buffers_[slot_].data(),length_) : std::string_view{};
}
Responses::Preparation Responses::begin() noexcept {
    if(epoch_==std::numeric_limits<std::uint64_t>::max()) return {};
    return Preparation(this,1-active_,++epoch_);
}
bool Responses::owns(const Preparation &p) const noexcept {
    return p.owner_==this && p.epoch_==epoch_ && p.slot_<bufferCount && p.slot_!=active_;
}
bool Responses::summary(Preparation &p,const Summary &s) noexcept {
    if(!owns(p)) return false;p.ready_=false;
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
    if(std::exchange(contractSummaryRefusal,false)) return false;
#endif
    if(!validSummary(s)) return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);summaryObject(w,s);
    return p.ready_=w.finish(p.length_);
}
bool Responses::point(Preparation &p,const Summary &s,std::optional<Point> point) noexcept {
    if(!owns(p)) return false;p.ready_=false;
    if(!validSummary(s)) return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);summaryObject(w,s);
    // Overwrite the root's final brace in the inactive slot, never its active
    // counterpart. The bounded summary is complete before this extension.
    std::size_t length{};
    if(!w.finish(length) || !length) return false;
    Writer suffix(buffers_[p.slot_].data()+length-1,bufferBytes-length+1);
    suffix.raw(",\"point\":");suffix.value(point);suffix.character('}');
    std::size_t suffixLength{};
    if(!suffix.finish(suffixLength)) return false;
    p.length_=length-1+suffixLength;return p.ready_=true;
}
bool Responses::livePublished(Preparation &p,const Summary &s) noexcept {
    if(!owns(p)) return false;p.ready_=false;
    if(!validSummary(s)) return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"kind\":\"published\",\"version\":1,\"summary\":");summaryObject(w,s);w.character('}');
    return p.ready_=w.finish(p.length_);
}
bool Responses::computationFailed(Preparation &p) noexcept {
    if(!owns(p)) return false;p.ready_=false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"kind\":\"computation-failed\",\"version\":1}");
    return p.ready_=w.finish(p.length_);
}
bool Responses::operation(Preparation &p,const sv_operation::Receipt &r,const Summary &s) noexcept {
    if(!owns(p)) return false;p.ready_=false;
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
    if(std::exchange(contractSummaryRefusal,false)) return false;
    if(r.outcome!=sv_operation::Outcome::Active&&r.outcome!=sv_operation::Outcome::ExpiredConflict&&
       contractOperationPublicationRefusal&&!--contractOperationPublicationRefusal)return false;
#endif
    if(!sv_operation::valid(r)||!validSummary(s)) return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"kind\":\"operation-receipt\",\"version\":2,\"receipt\":");operationReceipt(w,r);
    w.raw(",\"summary\":");summaryObject(w,s);w.character('}');return p.ready_=w.finish(p.length_);
}
bool Responses::operationBound(Preparation &p,const sv_operation::Scope &scope) noexcept {
    if(!owns(p)) return false;p.ready_=false;if(!sv_operation::valid(scope))return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"kind\":\"operation-bound\",\"version\":1,\"scope\":");operationScope(w,scope);w.character('}');
    return p.ready_=w.finish(p.length_);
}
bool Responses::operationRetired(Preparation &p,const sv_operation::Owner &owner) noexcept {
    if(!owns(p)) return false;p.ready_=false;if(!sv_operation::valid(owner))return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"kind\":\"operation-retired\",\"version\":1,\"owner\":");operationOwner(w,owner);w.character('}');
    return p.ready_=w.finish(p.length_);
}
bool Responses::census(Preparation &p,const sv_allocation::Snapshot &s,std::uint64_t sequence) noexcept {
    if(!owns(p)) return false;p.ready_=false;
    if(!sequence || sequence>sv_allocation::maxQuerySequence || !sv_allocation::validSnapshot(s)) return false;
    // Eleven fixed fields, seven native size_t counters and one safe uint64
    // sequence fit well below one summary slot; no variable text is admitted.
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":true,\"version\":1");w.field("sequence",sequence);
    w.raw(",\"scope\":\"scoped-cxx-v1\"");
    w.field("scenePayloadBytes",s.scenePayloadBytes);w.field("ownedRawBytes",s.ownedRawBytes);
    w.field("overlapBytes",s.overlapBytes);w.field("contextBytes",s.contextBytes);w.field("unionBytes",s.unionBytes);
    w.field("liveBlocks",s.liveBlocks);w.field("liveContexts",s.liveContexts);w.character('}');
    return p.ready_=w.finish(p.length_);
}
bool Responses::error(Preparation &p,const char *message) noexcept {
    if(!owns(p)) return false;p.ready_=false;
    if(!message) return false;
    std::size_t size{};
    while(size<=errorByteLimit && message[size]) ++size;
    if(size>errorByteLimit || !validUtf8(std::string_view(message,size))) return false;
    Writer w(buffers_[p.slot_].data(),bufferBytes);
    w.raw("{\"ok\":false,\"error\":");w.string(std::string_view(message,size));w.character('}');
    return p.ready_=w.finish(p.length_);
}
const char *Responses::publish(Preparation &p) noexcept {
    if(!owns(p) || !p.ready_) return failureReply(FailureKind::InvalidResponse);
    active_=p.slot_;p.owner_=nullptr;return current();
}
std::size_t Responses::runtimeReserveBytes() noexcept {
    return sizeof(Responses)+sizeof(allocationFailure)+sizeof(invalidResponse)+sizeof(internalFailure);
}
} // namespace sv_response
