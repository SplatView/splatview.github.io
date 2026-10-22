#pragma once
#include "model.hpp"
#include <charconv>
#include <cctype>
#include <cstring>
#include <limits>
#include <string_view>

namespace preview {
// The frozen decoder owns PLY semantics. This allocation-free header pass only
// bounds its otherwise untracked STL scratch before entering that decoder.
// Its classifier deliberately matches loadBasicPly: ANY Gaussian attribute
// prefix (or a chunk element) routes back to the Gaussian decoder.
struct BrowserPlyAdmission {
    bool ply{}, gaussian{}, mesh{};
    size_t headerBytes{}, elementCount{}, propertyCount{}, vertexProperties{};
    uint64_t sourceVertices{}, sourceFaces{};
    size_t workBytes{};
};
inline std::string_view browserPlyToken(std::string_view &line) noexcept {
    while(!line.empty() && std::isspace(static_cast<unsigned char>(line.front()))) line.remove_prefix(1);
    size_t size=0;
    while(size<line.size() && !std::isspace(static_cast<unsigned char>(line[size]))) ++size;
    const auto token=line.substr(0,size); line.remove_prefix(size); return token;
}
inline BrowserPlyAdmission browserPlyAdmission(std::span<const uint8_t> bytes,InputFormat format) {
    BrowserPlyAdmission out;
    if(format!=InputFormat::Auto || bytes.size()<4 || std::memcmp(bytes.data(),"ply",3)!=0) return out;
    out.ply=true;
    const std::string_view text(reinterpret_cast<const char *>(bytes.data()),
        std::min(bytes.size(),size_t(1024*1024)));
    size_t at=0,properties=0;
    bool vertex=false;
    while(at<text.size()) {
        const auto end=text.find('\n',at);
        if(end==std::string_view::npos) break;
        auto line=text.substr(at,end-at);
        if(line.ends_with('\r')) line.remove_suffix(1);
        if(at==0 && line!="ply") throw std::runtime_error("Invalid PLY header");
        at=end+1;
        const auto command=browserPlyToken(line);
        if(command=="element") {
            const auto name=browserPlyToken(line),countText=browserPlyToken(line);
            uint64_t count{};
            const auto parsed=std::from_chars(countText.data(),countText.data()+countText.size(),count);
            if(name.empty() || countText.empty() || parsed.ec!=std::errc{} ||
               parsed.ptr!=countText.data()+countText.size() || count>10'000'000 || ++out.elementCount>64)
                throw std::runtime_error("Invalid or excessive PLY element declaration");
            vertex=name=="vertex"; properties=0;
            if(vertex) out.sourceVertices=count;
            if(name=="face") out.sourceFaces=count;
            if(name=="chunk") out.gaussian=true;
        } else if(command=="property") {
            if(!out.elementCount || ++properties>256)
                throw std::runtime_error("Invalid or excessive PLY property declaration");
            ++out.propertyCount;
            auto type=browserPlyToken(line);
            if(type=="list") { browserPlyToken(line); type=browserPlyToken(line); }
            const auto name=browserPlyToken(line);
            if(type.empty() || name.empty()) throw std::runtime_error("Invalid PLY property declaration");
            if(vertex) {
                out.vertexProperties=std::max(out.vertexProperties,properties);
                out.gaussian|=name.starts_with("scale_") || name.starts_with("rot_") ||
                    name.starts_with("f_dc_") || name.starts_with("f_rest_");
            }
        } else if(command=="end_header") {
            out.headerBytes=at;
            out.mesh=!out.gaussian && out.sourceFaces!=0;
            // Eight header copies conservatively cover temporary string/stream
            // buffers and retained names. 256 bytes per declaration cover STL
            // vector growth plus property/element objects; scalar values retain
            // their own double array. Fixed slack includes stream/locale state.
            // Mesh remap is uint32 per SOURCE vertex, before compaction. The
            // two polygons are bounded by the decoder's 1024-corner policy.
            out.workBytes=checkedByteSum({checkedByteProduct(out.headerBytes,8),
                checkedByteProduct(out.propertyCount,256),checkedByteProduct(out.elementCount,256),
                checkedByteProduct(out.vertexProperties,sizeof(double)),size_t(64*1024),
                out.mesh ? checkedByteProduct(size_t(out.sourceVertices),sizeof(uint32_t)) : 0,
                out.mesh ? size_t(2*1024*sizeof(uint32_t)) : 0});
            return out;
        }
    }
    throw std::runtime_error("PLY header is missing or too large");
}

inline size_t browserGeometryRangeBytes(const Scene &scene,unsigned channel,unsigned first,unsigned count) {
    if(scene.isGaussian() || channel>1 || !count) return 0;
    const auto units=channel==0 ? scene.vertices.size() : checkedByteProduct(scene.triangles.size(),3);
    if(size_t(first)>units || size_t(count)>units-size_t(first)) return 0;
    const auto bytes=checkedByteProduct(size_t(count),channel==0 ? sizeof(PreviewVertex) : sizeof(uint32_t));
    return bytes<=1024*1024 ? bytes : 0;
}
} // namespace preview
