#include "browser_geometry.hpp"
#include "editing.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstring>
#include <iostream>
#include <limits>
#include <sstream>
#include <tuple>
#include <vector>

extern "C" {
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_live_preview(const char *);
const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const uint32_t *sv_pack(unsigned,unsigned);
unsigned sv_pack_len();
const uint8_t *sv_geometry_range(unsigned,unsigned,unsigned);
unsigned sv_geometry_range_len();
unsigned sv_output_len();
}
namespace {
using namespace preview;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
size_t assertions{};
void require(bool value,const char *message) {
    ++assertions;
    if(!value) throw std::runtime_error(message);
}
Bytes bytes(const std::string &value) { return {value.begin(),value.end()}; }
template<class T> void append(Bytes &out,T value,bool big) {
    auto data=std::bit_cast<std::array<uint8_t,sizeof(T)>>(value);
    if(big) std::reverse(data.begin(),data.end());
    out.insert(out.end(),data.begin(),data.end());
}
Json parse(const char *text) { return Json::parse(text); }
Json command(const char *name) {
    const auto text=Json{{"command",name}}.dump(); return parse(sv_command(text.c_str()));
}
Json open(const Bytes &data,unsigned maximum=100000,unsigned budget=32*1024*1024) {
    return parse(sv_open(data.data(),data.size(),unsigned(InputFormat::Auto),maximum,budget));
}
template<class T> std::vector<T> range(unsigned channel,unsigned first,unsigned count) {
    const auto pointer=sv_geometry_range(channel,first,count);
    const auto length=sv_geometry_range_len();
    require(pointer && reinterpret_cast<uintptr_t>(pointer)%4==0 && length==count*sizeof(T),
        "Geometry range must expose an aligned exact immutable payload");
    std::vector<T> values(count); std::memcpy(values.data(),pointer,length); return values;
}
void readonly(const Json &value,unsigned kind,size_t vertices,size_t triangles,uint64_t sources,uint64_t faces) {
    require(value.at("ok")==true && value.at("loaded")==true && value.at("kind")==kind &&
        value.at("count")==vertices && value.at("sourceCount")==sources && value.at("sourceFaces")==faces &&
        value.at("shDegree")==0 && value.at("selected")==0 && value.at("visible")==vertices &&
        value.at("canUndo")==false && value.at("canRedo")==false && value.at("transaction")==false &&
        value.at("selectionDraft")==false && value.at("pending")==false && value.at("sceneChanged")==false &&
        value.at("revision")==0 && value.at("contentRevision")==0 && value.at("selectionMapBytes")==0 &&
        value.at("selectionMapRetainedIds").empty() && value.at("selectionMapId").is_null() &&
        value.at("pendingSelectionMapId").is_null() && value.at("toleranceSessionId").is_null(),
        "Ordinary PLY summary must retain source metadata without fabricated Gaussian owners");
    require(value.at("geometry")==Json{{"layoutVersion",1},{"kind",kind},{"vertexCount",vertices},
        {"triangleCount",triangles},{"vertexStride",16},{"indexStride",4},{"vertexBytes",vertices*16},
        {"indexBytes",triangles*12},{"revision",0},{"contentRevision",0}},
        "Geometry descriptor must match the exact byte layout and read-only revision");
    require(!sv_scene_ptr() && !sv_states_ptr() && !sv_pack(0,1) && !sv_pack_len() && !sv_output_len(),
        "Ordinary geometry must not expose Gaussian packets, masks or stale exports");
}
Bytes points(unsigned encoding,std::string_view colorNames="diffuse_red diffuse_green diffuse_blue") {
    std::istringstream names{std::string(colorNames)};
    std::string red,green,blue; names>>red>>green>>blue;
    const auto encodingName=encoding==0 ? "ascii" : encoding==1 ? "binary_little_endian" : "binary_big_endian";
    auto out=bytes(std::string("ply\nformat ")+encodingName+" 1.0\nelement vertex 2\nproperty double x\n"
        "property float y\nproperty float z\nproperty float nx\nproperty ushort "+red+"\nproperty ushort "+
        green+"\nproperty ushort "+blue+"\nproperty uchar alpha\nproperty list uchar float uv\n"
        "element edge 1\nproperty int a\nproperty int b\nend_header\n");
    for(unsigned i=0;i<2;++i) {
        if(encoding==0) {
            const auto body=bytes(i ? "3 4 5 nan 0 65535 32768 0 2 .25 .75\n" :
                "+1 -2 +3e0 nan 65535 0 32768 1 2 .25 .75\n");
            out.insert(out.end(),body.begin(),body.end());
        } else {
            const bool big=encoding==2;
            append(out,i ? 3. : 1.,big); append(out,i ? 4.f : -2.f,big); append(out,i ? 5.f : 3.f,big);
            append(out,std::numeric_limits<float>::quiet_NaN(),big);
            append(out,uint16_t(i ? 0 : 65535),big); append(out,uint16_t(i ? 65535 : 0),big);
            append(out,uint16_t(32768),big); append(out,uint8_t(i ? 0 : 1),big); append(out,uint8_t(2),big);
            append(out,.25f,big); append(out,.75f,big);
        }
    }
    if(encoding==0) {
        const auto body=bytes("0 1\n");out.insert(out.end(),body.begin(),body.end());
    } else { append(out,int32_t(0),encoding==2); append(out,int32_t(1),encoding==2); }
    return out;
}
Bytes mesh(unsigned encoding,bool faceFirst=false,std::string_view faceBody="4 0 1 2 3") {
    const std::string vertices="element vertex 4\nproperty double x\nproperty float y\nproperty float z\n"
        "property uchar red\nproperty uchar green\nproperty uchar blue\n";
    const std::string faces="element face 1\nproperty list uchar int vertex_indices\nproperty float confidence\n";
    const auto encodingName=encoding==0 ? "ascii" : encoding==1 ? "binary_little_endian" : "binary_big_endian";
    auto out=bytes(std::string("ply\nformat ")+encodingName+" 1.0\n"+
        (faceFirst ? faces+vertices : vertices+faces)+"end_header\n");
    auto face=[&] {
        if(encoding==0) {
            const auto body=bytes(std::string(faceBody)+" .75\n");out.insert(out.end(),body.begin(),body.end());
        } else {
            append(out,uint8_t(4),encoding==2);
            for(int32_t i=0;i<4;++i) append(out,i,encoding==2);
            append(out,.75f,encoding==2);
        }
    };
    if(faceFirst) face();
    for(const auto p:std::array<Vec3,4>{{{-1,-1,0},{1,-1,0},{1,1,0},{-1,1,0}}}) {
        if(encoding==0) {
            const auto body=bytes(std::to_string(p.x)+" "+std::to_string(p.y)+" 0 230 90 50\n");
            out.insert(out.end(),body.begin(),body.end());
        } else {
            append(out,double(p.x),encoding==2);append(out,p.y,encoding==2);append(out,p.z,encoding==2);
            out.insert(out.end(),{230,90,50});
        }
    }
    if(!faceFirst) face(); return out;
}
double area(const std::vector<PreviewVertex> &vertices,const std::vector<uint32_t> &indices) {
    double total=0;
    for(size_t i=0;i<indices.size();i+=3) {
        const auto a=vertices[indices[i]].position,b=vertices[indices[i+1]].position,c=vertices[indices[i+2]].position;
        total+=.5*std::abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));
    }
    return total;
}
void pointEncodingsAndColors() {
    for(unsigned encoding=0;encoding<3;++encoding) for(const auto names:
        {"red green blue","r g b","diffuse_red diffuse_green diffuse_blue"}) {
        const auto result=open(points(encoding,names)); readonly(result,1,2,0,2,0);
        const auto vertices=range<PreviewVertex>(0,0,2);
        require(vertices[0].position==Vec3{1,-2,3} && vertices[1].position==Vec3{3,4,5} &&
            vertices[0].color==0xff8000ffu && vertices[1].color==0xff80ff00u && result.at("yUp")==true &&
            result.at("center")==Json{2,1,4} && std::abs(result.at("radius").get<double>()-std::sqrt(11.))<1e-6,
            "ASCII/LE/BE preserve geometry axes, ushort rounding, aliases and opaque color; normals/alpha are ignored");
        require(!sv_geometry_range(1,0,1) && !sv_geometry_range_len(),"A point cloud has no index payload");
        if(encoding) {
            auto truncated=points(encoding,names);truncated.pop_back();
            require(open(truncated).at("ok")==false && command("summary")==result,
                "Truncated LE/BE unknown-element data must refuse without replacing the admitted point owner");
        }
    }
    for(const auto &[properties,values,expected]:std::array<std::tuple<const char *,const char *,uint32_t>,4>{{
        {"property float red\nproperty float green\nproperty float blue\n",".5 1 -.5",0xff00ff80u},
        {"property uint red\nproperty uint green\nproperty uint blue\n","4294967295 2147483648 0",0xff0080ffu},
        {"property char r\nproperty char g\nproperty char b\n","127 -1 0",0xff00007fu},
        {"property uchar red\n","255",0xffc8c8c8u}}}) {
        const auto result=open(bytes(std::string("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n")+
            "property float y\nproperty float z\n"+properties+"end_header\n0 0 0 "+values+"\n"));
        readonly(result,1,1,0,1,0);
        require(range<PreviewVertex>(0,0,1)[0].color==expected && result.at("radius")==.05f,
            "Float/uint/signed colors clamp and round; incomplete colors use opaque desktop gray");
    }
}
void topologyAndSampling() {
    for(unsigned encoding=0;encoding<3;++encoding) for(bool first:{false,true}) {
        const auto data=mesh(encoding,first);
        const auto result=open(data); readonly(result,2,4,2,4,1);
        const auto vertices=range<PreviewVertex>(0,0,4);const auto indices=range<uint32_t>(1,0,6);
        require(indices==std::vector<uint32_t>{3,0,1,1,2,3} && area(vertices,indices)==4 &&
            vertices[0].color==0xff325ae6u && result.at("sampledGeometry")==false,
            "All encodings/element orders preserve actual ear-clipped topology and packed RGBA bytes");
        const auto reduced=open(data,1);readonly(reduced,2,3,1,4,1);
        const auto sampled=range<PreviewVertex>(0,0,3);
        require(reduced.at("sampledGeometry")==true && range<uint32_t>(1,0,3)==std::vector<uint32_t>{0,1,2} &&
            sampled[0].position==Vec3{1,-1,0} && sampled[1].position==Vec3{1,1,0} &&
            sampled[2].position==Vec3{-1,1,0} && reduced.at("center")==Json{0,0,0},
            "Deterministic mesh reservoir keeps the independently expected source triangle and compacted source order");
    }
    for(const auto body:{"4 3 2 1 0","6 0 0 1 2 3 0"}) {
        const auto result=open(mesh(0,false,body));readonly(result,2,4,2,4,1);
        require(area(range<PreviewVertex>(0,0,4),range<uint32_t>(1,0,6))==4,
            "Reverse winding and adjacent/closing duplicate vertices preserve polygon area");
    }
    const auto concave=open(bytes("ply\nformat ascii 1.0\nelement vertex 6\nproperty float x\nproperty float y\n"
        "property float z\nelement face 1\nproperty list uchar int vertex_index\nend_header\n"
        "0 0 0\n2 0 0\n2 1 0\n1 1 0\n1 2 0\n0 2 0\n6 0 1 2 3 4 5\n"));
    readonly(concave,2,6,4,6,1);
    require(area(range<PreviewVertex>(0,0,6),range<uint32_t>(1,0,12))==3,
        "Concave L polygon has four triangles and area three instead of filling its cutout");
    const auto degenerate=open(bytes("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\n"
        "property float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n"
        "0 0 0\n1 0 0\n2 0 0\n3 0 1 2\n"));
    readonly(degenerate,2,3,1,3,1);
    require(range<uint32_t>(1,0,3)==std::vector<uint32_t>{0,1,2} &&
        area(range<PreviewVertex>(0,0,3),range<uint32_t>(1,0,3))==0,
        "A three-corner degenerate face retains the frozen decoder's accepted triangle semantics");
    std::ostringstream data;
    data<<"ply\nformat ascii 1.0\nelement vertex 10\nproperty float x\nproperty float y\nproperty float z\nend_header\n";
    for(int i=0;i<10;++i) data<<i<<" 0 0\n";
    const auto sampled=open(bytes(data.str()),3);readonly(sampled,1,3,0,10,0);
    const auto vertices=range<PreviewVertex>(0,0,3);
    require(sampled.at("sampledGeometry")==true && vertices[0].position.x==3 && vertices[1].position.x==6 &&
        vertices[2].position.x==9 && sampled.at("center")==Json{6,0,0} && sampled.at("radius")==3,
        "Point sampling preserves independently expected source IDs and bounds of retained vertices");
}
void readonlyPolicyAndRefusal() {
    const auto before=open(mesh(0)); readonly(before,2,4,2,4,1);
    const auto vertexPointer=sv_geometry_range(0,0,4); const auto indexPointer=sv_geometry_range(1,0,6);
    for(const auto name:{"point","beginTransaction","commitTransaction","rollbackTransaction","selectAll","selectNone",
        "invert","delete","crop","restore","resetCleanup","undo","redo","beginSelection","confirmSelection",
        "single","rectangle","polygon","brush","volume","color","colorPick","colorTolerance","fillPick",
        "fillTolerance","endTolerance","selectionMapBegin","selectionMapCommit","selectionMapRelease","grade","transform","export"}) {
        const auto result=command(name);
        require(result.at("ok")==false && result.at("error")=="Editing tools are available for Gaussian splats only." &&
            command("summary")==before,"Every edit/export/map path must refuse read-only geometry before mutation or parameter parsing");
    }
    require(parse(sv_live_preview("{}" )).at("ok")==false && parse(sv_map_write(1,0,nullptr,0)).at("ok")==false &&
        parse(sv_step(1))==before && command("cancel")==before && command("cancelSelection")==before,
        "Live/map writes refuse; cancellation and idle step are safe read-only reconciliation");
    for(const auto request:std::array<std::array<unsigned,3>,8>{{{2,0,1},{0,4,1},{0,0,5},{0,UINT32_MAX,1},
        {0,1,UINT32_MAX},{1,6,1},{1,0,7},{0,0,0}}}) {
        require(!sv_geometry_range(request[0],request[1],request[2]) && !sv_geometry_range_len() &&
            command("summary")==before,"Malformed geometry ranges must clear byte length and preserve scene/history identity");
    }
    for(const auto body:{"3 0 1 4","3 -1 1 2","3 0 1","1025","2 0 1","4 0 2 1 3"}) {
        require(open(mesh(0,false,body)).at("ok")==false && command("summary")==before,
            "Invalid/short/self-intersecting topology must preserve the prior geometry owner");
    }
    require(open(points(0),100000,1024).at("ok")==false && command("summary")==before &&
        parse(sv_open(nullptr,100,0,100000,32*1024*1024)).at("ok")==false && command("summary")==before,
        "Scratch admission and invalid input pointer failures preserve the previous document");
    require(sv_geometry_range(0,0,4)==vertexPointer && sv_geometry_range(1,0,6)==indexPointer,
        "Rejected candidates must retain exact immutable geometry allocations");
    for(const auto property:{"property float scale_0\n","property float f_rest_99\n"}) {
        require(open(bytes(std::string("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\n")+
            "property float z\n"+property+"end_header\n0 0 0 0\n")).at("ok")==false && command("summary")==before,
            "Partial Gaussian property prefixes remain Gaussian failures, never an ordinary PLY downgrade");
    }
    for(const auto body:{"nan 0 0","1e100 0 0","0 0"})
        require(open(bytes(std::string("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\n")+
            "property float y\nproperty float z\nend_header\n"+body+"\n")).at("ok")==false && command("summary")==before,
            "Nonfinite/out-of-float/truncated vertex candidates preserve prior owner");
    require(open(bytes("ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\n"
        "property float z\nproperty float red\nproperty float green\nproperty float blue\nend_header\n"
        "0 0 0 nan 0 0\n")).at("ok")==false && command("summary")==before,
        "Nonfinite colors are refused even though nonfinite ignored normals are accepted");
}
void admissionAndLargeRange() {
    const auto data=mesh(0);
    const auto plan=browserPlyAdmission(data,InputFormat::Auto);
    require(plan.ply && !plan.gaussian && plan.mesh && plan.sourceVertices==4 && plan.sourceFaces==1 &&
        plan.workBytes==8*plan.headerBytes+256*plan.propertyCount+256*plan.elementCount+
            8*plan.vertexProperties+64*1024+4*4+8192,
        "Conservative parser/remap/polygon scratch is derived from SOURCE counts before decoder allocation");
    const auto before=command("summary");
    const auto scratchLimit=before.at("memoryBytes").get<unsigned>()+unsigned(data.size()+plan.workBytes-1);
    const auto refusedOpen=open(data,100000,scratchLimit);
    require(refusedOpen.at("ok")==false && refusedOpen.at("error")==
        "Resource byte limit exceeded: requested "+std::to_string(plan.workBytes)+", available "+
            std::to_string(plan.workBytes-1) && command("summary")==before,
        "Actual shipping open refuses its pre-parser Work grant one byte below admission and preserves the prior owner");
    auto nativeGeometry=std::make_shared<Scene>(loadScene(data));
    bool editRefused=false;
    try { SceneEdits invalid(nativeGeometry); } catch(const std::exception &) { editRefused=true; }
    require(editRefused,"The frozen SceneEdits Gaussian-only constructor invariant must remain intact");
    ResourceBudget budget(plan.workBytes-1);
    bool refused=false;
    try { auto reservation=budget.reserve(ResourceCategory::Work,plan.workBytes); }
    catch(const ResourceBudgetExceeded &) { refused=true; }
    require(refused && !budget.usage().totalBytes,"Rejected conservative scratch grant must leave no retained payload");
    ResourceBudget admitted(plan.workBytes);
    { auto reservation=admitted.reserve(ResourceCategory::Work,plan.workBytes);
        require(admitted.usage().totalBytes==plan.workBytes,"Scratch must be admitted before entering portable parser"); }
    require(!admitted.usage().totalBytes,"Parser scratch must release after decoder completion/refusal");
    auto large=bytes("ply\nformat binary_little_endian 1.0\nelement vertex 65537\nproperty float x\nproperty float y\n"
        "property float z\nend_header\n");
    for(unsigned i=0;i<65537;++i) {append(large,float(i),false);append(large,0.f,false);append(large,0.f,false);}
    readonly(open(large),1,65537,0,65537,0);
    require(sv_geometry_range(0,0,65536) && sv_geometry_range_len()==1024*1024 &&
        !sv_geometry_range(0,0,65537) && !sv_geometry_range_len(),
        "Native chunk exposure admits exactly one MiB and refuses a larger request without allocating a copy");
}
void gaussianTransitionsPreserveHistory() {
    std::string header="ply\nformat ascii 1.0\nelement vertex 3\n";
    for(const auto name:{"x","y","z","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3",
        "opacity","f_dc_0","f_dc_1","f_dc_2"}) header+="property float "+std::string(name)+"\n";
    const auto data=bytes(header+"end_header\n-1 0 0 -3 -3 -3 1 0 0 0 1 0 0 0\n"
        "0 0 0 -3 -3 -3 1 0 0 0 1 0 0 0\n1 0 0 -3 -3 -3 1 0 0 0 1 0 0 0\n");
    require(open(data).at("kind")==0 && command("selectAll").at("selected")==3 && command("undo").at("canRedo")==true,
        "Transition fixture requires an actual Gaussian owner with preserved Redo");
    const auto before=command("summary");const auto owner=sv_scene_ptr();const auto mask=sv_states_ptr();
    require(before.at("geometry").is_null() && !sv_geometry_range(0,0,1) && !sv_geometry_range_len(),
        "Gaussian summaries expose no geometry descriptor or vertex channel");
    require(open(mesh(0,false,"3 0 1 9")).at("ok")==false && command("summary")==before &&
        owner==sv_scene_ptr() && mask==sv_states_ptr() && command("redo").at("selected")==3,
        "Failed geometry replacement retains exact Gaussian owner/mask/history and usable Redo");
    readonly(open(points(1)),1,2,0,2,0);
    require(open(data).at("kind")==0 && sv_scene_ptr() && sv_states_ptr() && command("summary").at("canUndo")==false &&
        !sv_geometry_range(0,0,1) && !sv_geometry_range_len(),
        "Successful Gaussian/geometry/Gaussian transitions retire each owner family without stale channels/history");
}
}
int main() {
    try {
        pointEncodingsAndColors();topologyAndSampling();readonlyPolicyAndRefusal();
        admissionAndLargeRange();gaussianTransitionsPreserveHistory();
        std::cout<<"SPLATVIEW_GEOMETRY_CONTRACTS_PASS assertions="<<assertions<<'\n';return 0;
    } catch(const std::exception &error) {
        std::cerr<<"SPLATVIEW_GEOMETRY_CONTRACTS_FAIL "<<error.what()<<'\n';return 1;
    }
}
