#include "browser_sog_group.hpp"
#include <webp/decode.h>
#include <algorithm>
#include <cmath>
#include <limits>
#include <stdexcept>

namespace preview::browser_sog_group {
namespace {
[[noreturn]] void fail(const char *message) { throw std::runtime_error(message); }
uint32_t little(std::span<const uint8_t> bytes,size_t offset) {
    if(offset>bytes.size() || 4>bytes.size()-offset) fail("Truncated grouped SOG descriptor");
    return uint32_t(bytes[offset])|uint32_t(bytes[offset+1])<<8|uint32_t(bytes[offset+2])<<16|uint32_t(bytes[offset+3])<<24;
}
double integral(const nlohmann::json &value,double maximum,const char *message) {
    if(!value.is_number()) fail(message);
    const auto number=value.get<double>();
    if(!std::isfinite(number)||number<0||number>maximum||std::floor(number)!=number) fail(message);
    return number;
}
void ranges(const nlohmann::json &meta,const char *key,size_t count,bool positions=false,bool numericBooleans=false) {
    const auto &role=meta.at(key),&low=role.at("mins"),&high=role.at("maxs");
    if(!low.is_array()||!high.is_array()||low.size()!=count||high.size()!=count)
        fail("Invalid grouped SOG attribute range");
    for(size_t i=0;i<count;++i) {
        if(!(low[i].is_number()||(numericBooleans&&low[i].is_boolean()))||
           !(high[i].is_number()||(numericBooleans&&high[i].is_boolean())))
            fail("Invalid grouped SOG attribute bounds");
        const float a=low[i].get<float>(),b=high[i].get<float>();
        if(!std::isfinite(a)||!std::isfinite(b)||a>b||(positions&&(std::abs(a)>40||std::abs(b)>40)))
            fail("Invalid grouped SOG attribute bounds");
    }
}
double sourceCountV2(const nlohmann::json &value) {
    // get<uint64_t>() rejects bool and truncates numeric fractions. Bound the
    // conversion before its unsigned cast, including the native source limit.
    if(!value.is_number()) fail("Invalid grouped SOG count");
    const auto number=value.get<double>();
    if(!std::isfinite(number)) fail("Invalid grouped SOG count");
    const auto count=std::trunc(number);
    if(count<1||count>10'000'000) fail("Invalid grouped SOG count");
    return count;
}
void codebookShape(const nlohmann::json &meta,const char *key) {
    const auto &values=meta.at(key).at("codebook");
    if(!values.is_array()||values.empty()||values.size()>256) fail("Invalid grouped SOG codebook size");
    for(const auto &value:values)
        if(!value.is_number()&&!value.is_boolean()) fail("Invalid grouped SOG codebook scalar");
    // Captured float conversion may overflow for an unused entry. Do not add a
    // global float-finiteness check: actual sampled lookup is its authority.
}
double convertedInteger(const nlohmann::json &value,double minimum,double maximum,
                        bool numericBooleans,const char *message) {
    if(!value.is_number()&&!(numericBooleans&&value.is_boolean())) fail(message);
    const auto number=value.is_boolean()?(value.get<bool>()?1.0:0.0):value.get<double>();
    if(!std::isfinite(number)) fail(message);
    const auto converted=std::trunc(number);
    if(converted<minimum||converted>maximum) fail(message);
    return converted;
}
void legacyShRange(const nlohmann::json &role) {
    const auto scalar=[](const nlohmann::json &value) {
        if(!value.is_number()&&!value.is_boolean()) fail("Invalid grouped SOG SH bounds");
        const auto number=value.get<float>();
        if(!std::isfinite(number)) fail("Invalid grouped SOG SH bounds");
        return number;
    };
    const auto low=scalar(role.at("mins")),high=scalar(role.at("maxs"));
    if(low>high) fail("Invalid grouped SOG SH bounds");
}
}
Group Group::parse(std::span<const uint8_t> block,std::span<const uint8_t> descriptor) {
    if(descriptor.size()<20||little(descriptor,0)!=0x47535653||little(descriptor,4)!=1)
        fail("Invalid grouped SOG descriptor");
    const auto n=little(descriptor,8),m=little(descriptor,12),r=little(descriptor,16);
    if(!n||n>maximumResources||descriptor.size()!=20+size_t(n)*4||!m||!r||
       m>maximumMetadataBytes||r>maximumMetadataBytes) fail("Invalid grouped SOG descriptor bounds");
    Group group;group.resourceCount_=n;size_t cursor=m;
    if(cursor>block.size()) fail("Truncated grouped SOG block");
    for(size_t i=0;i<n;++i) {
        const auto bytes=little(descriptor,20+i*4);
        if(cursor>maximumOriginalBytes||bytes>maximumOriginalBytes-cursor||bytes>block.size()-cursor)
            fail("Grouped SOG originals exceed their byte limit");
        group.resources_[i]=block.subspan(cursor,bytes);cursor+=bytes;
    }
    if(cursor>maximumOriginalBytes||cursor>block.size()||r!=block.size()-cursor)
        fail("Grouped SOG block has missing or trailing bytes");
    group.originalBytes_=cursor;group.rewritten_=block.subspan(cursor,r);return group;
}
std::span<const uint8_t> Group::read(const std::string &name) const {
    if(name=="meta.json") return rewritten_;
    if(name.size()!=10||name[0]!='r'||name.substr(5)!=".webp") fail("Unknown grouped SOG resource alias");
    size_t index=0;
    for(size_t i=1;i<5;++i) {
        if(name[i]<'0'||name[i]>'9') fail("Unknown grouped SOG resource alias");
        index=index*10+size_t(name[i]-'0');
    }
    if(index>=resourceCount_) fail("Unknown grouped SOG resource alias");
    return resources_[index];
}
void preflight(const nlohmann::json &meta,const Read &read,const LoadOptions &options) {
    if(!meta.is_object()) fail("Invalid grouped SOG metadata");
    bool legacy=true;
    if(meta.contains("version")) {
        const auto &value=meta.at("version");
        if(!value.is_number()) fail("Invalid grouped SOG version");
        const auto version=value.get<double>();
        if(!std::isfinite(version)) fail("Invalid grouped SOG version");
        // Preserve the qualified v1 subset. New v2 follows the captured int
        // conversion for numeric versions such as 2.9, without an unsafe cast.
        legacy=version==1;
        if(!legacy&&std::trunc(version)!=2) fail("Grouped SOG supports versions 1 and 2 only");
    }
    const bool higherSh=meta.contains("shN")&&!meta.at("shN").is_null();
    double count{};
    if(legacy) {
        const auto &shape=meta.at("means").at("shape");
        if(!shape.is_array()||shape.size()!=2||integral(shape[1],3,"Invalid grouped SOG shape")!=3)
            fail("Invalid grouped SOG shape");
        count=integral(shape[0],10'000'000,"Invalid grouped SOG count");
        if(count<1) fail("Invalid grouped SOG count");
        ranges(meta,"means",3,true);ranges(meta,"scales",3);ranges(meta,"sh0",4);
    } else {
        count=sourceCountV2(meta.at("count"));ranges(meta,"means",3,true,true);
        codebookShape(meta,"scales");codebookShape(meta,"sh0");
    }
    unsigned degree=0;size_t palette=0;
    if(higherSh) {
        const auto &sh=meta.at("shN");
        if(!sh.is_object()) fail("Invalid grouped SOG SH metadata");
        if(legacy) legacyShRange(sh);
        else {
            degree=unsigned(convertedInteger(sh.at("bands"),1,3,true,"Unsupported grouped SOG SH bands"));
            // Captured Windows size_t64 uses the JSON uint64 getter, which
            // rejects bool. Keep this explicit rather than the WASM size_t32
            // generic arithmetic conversion that would admit bool as 0/1.
            palette=size_t(convertedInteger(sh.at("count"),1,65536,false,"Invalid grouped SOG SH palette size"));
            codebookShape(meta,"shN");
        }
    }
    const std::array<const char *,7> roles{"means","means","scales","quats","sh0","shN","shN"};
    const size_t roleCount=higherSh?7:5;
    std::array<int,7> widths{},heights{};
    int width=0,height=0;size_t decoded=0;
    for(size_t role=0;role<roleCount;++role) {
        const auto &files=meta.at(roles[role]).at("files");const size_t index=role==1||role==6?1:0;
        if(!files.is_array()||files.size()<=index||!files[index].is_string()) fail("Invalid grouped SOG texture role");
        const auto name=files[index].get<std::string>();const auto data=read(name);int w=0,h=0;
        if(!WebPGetInfo(data.data(),data.size(),&w,&h)||w<1||h<1||w>std::numeric_limits<int>::max()/4)
            fail("Invalid grouped SOG WebP header");
        if(role && role!=5 && (w!=width||h!=height)) fail("Grouped SOG property dimensions disagree");
        if(!role) {width=w;height=h;}
        widths[role]=w;heights[role]=h;
        const auto bytes=imagePayloadBytes(unsigned(w),unsigned(h));
        if(bytes>options.maxBytes||decoded>options.maxBytes-bytes) fail("Decoded grouped SOG textures exceed memory budget");
        decoded+=bytes;
    }
    if(count>double(uint64_t(unsigned(width))*unsigned(height))) fail("Grouped SOG count exceeds image dimensions");
    if(higherSh) {
        if(legacy) {
            degree=widths[5]==192?1:widths[5]==512?2:widths[5]==960?3:0;
            palette=size_t(unsigned(heights[5]))*64;
        }
        if(degree<1||degree>3) fail("Unsupported grouped SOG SH bands");
        if(!palette||palette>65536) fail("Invalid grouped SOG SH palette size");
        const size_t coeffs=(degree+1)*(degree+1)-1;
        // V2 permits unused extra centroid rows. Labels/base already share
        // dimensions; do not impose exact ceil(palette/64) height.
        if(size_t(unsigned(widths[5]))!=64*coeffs||size_t(unsigned(heights[5]))*64<palette)
            fail("Invalid grouped SOG SH texture dimensions");
    }
    if(options.resources) {
        const auto usage=options.resources->usage();const auto limits=options.resources->limits();
        const auto totalAvailable=usage.totalBytes<=limits.totalBytes?limits.totalBytes-usage.totalBytes:0;
        const auto work=size_t(ResourceCategory::Work);
        const auto workAvailable=usage.categoryBytes[work]<=limits.categoryBytes[work]?
            limits.categoryBytes[work]-usage.categoryBytes[work]:0;
        const auto available=std::min(totalAvailable,workAvailable);
        // Check all physical role planes (five SH0/seven higher SH). Aliases
        // decode separately; their payloads must never be deduplicated. Their
        // existing SceneAllocator grants remain the sole plane charges.
        if(decoded>available) throw ResourceBudgetExceeded(decoded,available);
    }
}
} // namespace preview::browser_sog_group
