// Linked shipping C ABI contracts with independent coordinate/byte oracles.
// Camera scalar results use the qualified pinned Camera::transformed kernel.
// Backend observations/injection are confined to this nonshipping main.
#include "browser_alignment_session.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "model.hpp"
#include "color.hpp"
#include "geometry_tools.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
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
const uint8_t *sv_output_ptr();
unsigned sv_output_len();
}
namespace {
using namespace preview;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
using View=std::array<float,11>;
using Point=std::array<float,3>;
size_t cases{},checks{},refusals{},publicationRefusals{},cancelCases{},rollbackCases{};
size_t scaleCases{},scaleRefusals{},scalePublicationRefusals{},scaleCancelCases{},scaleRollbackCases{};
size_t planeCases{},planeRefusals{},planePublicationRefusals{},planeCancelCases{},planeRollbackCases{};
void require(bool condition,const char *message) { ++checks;if(!condition) throw std::runtime_error(message); }
Json parsed(const char *text) {
    require(text!=nullptr,"Null alignment ABI response");const auto value=Json::parse(text);
    require(value.contains("ok") && value["ok"].is_boolean(),"Malformed alignment ABI response");
    if(value["ok"]==true && value.value("loaded",false)) {
        require(value.contains("alignment") && value["alignment"].is_object(),"Gaussian summary lacks alignment metadata");
        const auto &a=value["alignment"];
        const auto &ids=a.at("retainedBranchIds");bool retained=ids.is_array() && !ids.empty() && ids.size()<=64,contains=false;uint64_t previous{};
        for(size_t i=0;retained && i<ids.size();++i) {
            retained=ids[i].is_number_unsigned();if(!retained) break;
            const auto id=ids[i].get<uint64_t>();retained=id<=browser_alignment::maximumIdentity && (!i || id>previous);
            contains|=ids[i]==a.at("branchId");previous=id;
        }
        require(a.at("version")==2 && retained && contains && a.at("branchId").is_number_unsigned() &&
            a.at("branchId").get<uint64_t>()<=browser_alignment::maximumIdentity && a.at("canReset").is_boolean(),
            "Invalid alignment branch/schema");
        const auto frame=a.at("frame").get<Matrix4>();
        for(float entry:frame) require(std::isfinite(entry),"Nonfinite alignment frame response");
        const auto camera=value.at("camera").get<View>();
        for(float entry:camera) require(std::isfinite(entry),"Nonfinite default camera response");
    }
    return value;
}
Json command(const Json &request) { const auto text=request.dump();return parsed(admittedContractCommand(text.c_str())); }
Json named(const char *commandName) { return command({{"command",commandName}}); }
Json current() { return named("summary"); }
uint64_t branch(const Json &value) { return value.at("alignment").at("branchId").get<uint64_t>(); }
Matrix4 frame(const Json &value) { return value.at("alignment").at("frame").get<Matrix4>(); }
bool canReset(const Json &value) { return value.at("alignment").at("canReset").get<bool>(); }
Json finish(Json value,unsigned work=2) {
    for(size_t step=0;value.value("pending",false);++step) {
        require(step<1'000'000,"Center did not complete");value=parsed(sv_step(work));
        require(value["ok"]==true,"Center step refused");
    }
    return value;
}
std::vector<Gaussian> scene() {
    const auto n=current().at("count").get<size_t>();const auto *source=sv_scene_ptr();
    require(source!=nullptr,"Missing native Gaussian stream");return {source,source+n};
}
Bytes masks() { const auto n=current().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n}; }
bool same(const std::vector<Gaussian> &a,const std::vector<Gaussian> &b) {
    return a.size()==b.size() && !std::memcmp(a.data(),b.data(),a.size()*sizeof(Gaussian));
}
Bytes input(size_t count=9,bool binary=false,bool rotated=false,unsigned degree=3) {
    std::string header=std::string("ply\nformat ")+(binary?"binary_little_endian":"ascii")+" 1.0\nelement vertex "+std::to_string(count)+
        "\nproperty float x\nproperty float y\nproperty float z\nproperty float scale_0\nproperty float scale_1\nproperty float scale_2\n"
        "property float rot_0\nproperty float rot_1\nproperty float rot_2\nproperty float rot_3\nproperty float opacity\n"
        "property float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\n";
    const unsigned rest=3*((degree+1)*(degree+1)-1);
    for(unsigned k=0;k<rest;++k) header+="property float f_rest_"+std::to_string(k)+"\n";
    header+="end_header\n";Bytes bytes(header.begin(),header.end());
    for(size_t i=0;i<count;++i) {
        const std::array<float,14> base{float(i)*.25f+1,float(i%3)*.5f-2,float(i%5)*.75f+3,
            -2,-2.5f,-3,rotated?.9f:1.f,rotated?.1f:0.f,rotated?.2f:0.f,rotated?.3f:0.f,1,.1f,.2f,-.3f};
        std::vector<float> row(base.begin(),base.end());
        for(unsigned k=0;k<rest;++k) row.push_back(float(int(k%7)-3)*.03125f);
        if(binary) { const auto *p=reinterpret_cast<const uint8_t *>(row.data());bytes.insert(bytes.end(),p,p+row.size()*sizeof(float)); }
        else { std::ostringstream text;text.precision(9);for(float value:row) text<<value<<' ';text<<'\n';
            const auto data=text.str();bytes.insert(bytes.end(),data.begin(),data.end()); }
    }
    return bytes;
}
Json open(const Bytes &bytes,unsigned budget=64*1024*1024) {
    return parsed(sv_open(bytes.data(),bytes.size(),0,1'000'000,budget));
}
Json centerRequest(Point point,View camera,View defaultCamera) {
    return {{"command","alignCenter"},{"point",point},{"camera",camera},{"defaultCamera",defaultCamera}};
}
Json scaleRequest(Point a,Point b,float target,View camera,View defaultCamera) {
    return {{"command","alignScale"},{"points",std::array<Point,2>{a,b}},{"target",target},{"camera",camera},{"defaultCamera",defaultCamera}};
}
Json planeRequest(const std::array<Point,3> &points,bool flip,View camera,View defaultCamera) {
    return {{"command","alignPlane"},{"points",points},{"flip",flip},{"camera",camera},{"defaultCamera",defaultCamera}};
}
Json plane(const std::array<Point,3> &points,bool flip=false,View camera={},View defaultCamera={}) {
    const auto before=current();if(camera[5]==0) camera=before.at("camera").get<View>();if(defaultCamera[5]==0) defaultCamera=before.at("camera").get<View>();
    require(named("beginTransaction")["ok"]==true,"Plane checkpoint refused");
    const auto value=finish(command(planeRequest(points,flip,camera,defaultCamera)));
    require(value["transaction"]==true && value["sceneChanged"]==true,"Plane did not stage in native checkpoint");
    const auto committed=named("commitTransaction");require(committed["ok"]==true && committed["transaction"]==false,"Plane checkpoint commit refused");return committed;
}
Json resetRequest(const Json &value) {
    const auto view=value.at("camera").get<View>();
    return {{"command","resetAlignment"},{"camera",view},{"defaultCamera",view}};
}
Json center(Point point,View camera={},View defaultCamera={}) {
    const auto before=current();if(camera[5]==0) camera=before.at("camera").get<View>();
    if(defaultCamera[5]==0) defaultCamera=before.at("camera").get<View>();
    require(named("beginTransaction")["ok"]==true,"Alignment checkpoint did not begin");
    auto value=finish(command(centerRequest(point,camera,defaultCamera)));
    require(value["transaction"]==true && value["sceneChanged"]==true,"Center did not publish in admitted checkpoint");
    value=named("commitTransaction");require(value["ok"]==true && value["transaction"]==false,"Alignment checkpoint did not commit");return value;
}
Json scale(Point a,Point b,float target,View camera={},View defaultCamera={}) {
    const auto before=current();if(camera[5]==0) camera=before.at("camera").get<View>();
    if(defaultCamera[5]==0) defaultCamera=before.at("camera").get<View>();
    require(named("beginTransaction")["ok"]==true,"Scale checkpoint did not begin");
    auto value=finish(command(scaleRequest(a,b,target,camera,defaultCamera)));
    require(value["transaction"]==true && value["sceneChanged"]==true,"Scale did not publish in admitted checkpoint");
    value=named("commitTransaction");require(value["ok"]==true && value["transaction"]==false,"Scale checkpoint did not commit");return value;
}
Point at(const Gaussian &g) { return {g.positionOpacity[0],g.positionOpacity[1],g.positionOpacity[2]}; }
std::vector<Gaussian> shifted(std::vector<Gaussian> values,Point point) {
    for(auto &g:values) for(size_t k=0;k<3;++k) g.positionOpacity[k]-=point[k];return values;
}
Matrix4 uniformMatrix(Point a,Point b,float target) {
    const double x=double(a[0])-b[0],y=double(a[1])-b[1],z=double(a[2])-b[2];
    const float factor=float(target/std::sqrt(x*x+y*y+z*z));auto result=identityMatrix;
    result[0]=result[5]=result[10]=factor;
    for(size_t axis=0;axis<3;++axis) { const float mid=a[axis]*.5f+b[axis]*.5f;result[12+axis]=float(float(-mid*factor)+mid); }
    return result;
}
std::vector<Gaussian> scaled(std::vector<Gaussian> values,const Matrix4 &matrix) {
    // Independent diagonal oracle: double translation-plus-product, and two
    // double covariance products followed by one float cast. No Affine call.
    const double factor=matrix[0];
    for(auto &g:values) {
        for(size_t axis=0;axis<3;++axis) g.positionOpacity[axis]=float(double(matrix[12+axis])+factor*g.positionOpacity[axis]);
        for(float &value:g.covA) value=float(0.+factor*double(value)*factor);
        for(size_t index=0;index<2;++index) g.covB[index]=float(0.+factor*double(g.covB[index])*factor);
    }
    return values;
}
Matrix4 composed(const Matrix4 &before,const Matrix4 &after) {
    Matrix4 result;DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(result.data()),
        DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(before.data()))*
        DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(after.data())));return result;
}
View expectedCamera(const View &input,const Matrix4 &before,const Matrix4 &after,float sceneRadius,bool upright=false) {
    // Use the pinned kernel directly rather than the adapter being tested.
    Camera source;source.target={input[0],input[1],input[2]};source.yaw=input[3];source.pitch=input[4];
    source.distance=input[5];source.radius=input[6];source.fieldOfView=input[7];source.yUp=input[8]!=0;source.roll=input[9];
    Matrix4 delta;
    const auto inverse=DirectX::XMMatrixInverse(nullptr,DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(before.data())));
    DirectX::XMStoreFloat4x4(reinterpret_cast<DirectX::XMFLOAT4X4 *>(delta.data()),inverse*
        DirectX::XMLoadFloat4x4(reinterpret_cast<const DirectX::XMFLOAT4X4 *>(after.data())));
    auto result=source.transformed(delta);if(upright) result.roll=0;
    // Native summary fits Scene.defaultView against current bounds at aspect1.
    return {result.target.x,result.target.y,result.target.z,result.yaw,result.pitch,result.distance,
        sceneRadius,result.fieldOfView,result.yUp?1.f:0.f,result.roll,1.f};
}
void unchanged(const Json &before,const std::vector<Gaussian> &geometry,const Bytes &states,const char *message) {
    const auto after=current();
    require(same(scene(),geometry) && masks()==states && frame(after)==frame(before) && branch(after)==branch(before) &&
        after["revision"]==before["revision"] && after["contentRevision"]==before["contentRevision"] &&
        after["camera"]==before["camera"] && after["canUndo"]==before["canUndo"] && after["canRedo"]==before["canRedo"] &&
        canReset(after)==canReset(before) && after["alignment"]["retainedBranchIds"]==before["alignment"]["retainedBranchIds"],message);
}
void translationDeletedSHCameraAndExport() {
    ++cases;require(open(input())["ok"]==true && sv_abi_version()==24,"SH3 source opening/ABI24 failed");
    require(named("single")["ok"]==true,"Empty Single selection refused");
    require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true,"Deletion seed selection refused");
    require(named("delete")["ok"]==true,"Delete seed refused");
    require(command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true,"Selected fixture refused");
    const auto before=current();const auto original=scene();const auto states=masks();const auto point=at(original[4]);
    auto active=before.at("camera").get<View>();active[0]+=.2f;active[3]=-.6f;active[4]=.4f;active[5]*=.7f;active[7]=60;active[9]=.35f;active[10]=1.6f;
    auto defaultView=before.at("camera").get<View>();defaultView[0]+=1;defaultView[3]=.8f;defaultView[4]=-.2f;defaultView[7]=55;defaultView[9]=-.25f;
    require(named("beginTransaction")["ok"]==true,"Center checkpoint refused");
    auto started=command(centerRequest(point,active,defaultView));
    require(started["ok"]==true && started["pending"]==true && branch(started)==0,"Center mutated before cooperative completion");
    const auto partial=parsed(sv_step(1));require(partial["pending"]==true && same(scene(),original) && masks()==states,
        "Partial Center published geometry or masks");
    auto terminal=finish(partial);
    require(same(scene(),shifted(original,point)) && masks()==states && terminal["shDegree"]==3,
        "Center did not independently translate selected, unselected and deleted records with exact covariance/opacity/SH bytes");
    require(branch(terminal)>0 && canReset(terminal),"Center failed to publish branch/Reset ownership");
    auto expectedFrame=identityMatrix;for(size_t k=0;k<3;++k) expectedFrame[12+k]=-point[k];
    require(frame(terminal)==expectedFrame,"Center cumulative frame is not independent translation");
    const auto view=terminal.at("camera").get<View>();
    require(view==expectedCamera(defaultView,frame(before),expectedFrame,terminal.at("radius").get<float>()),
        "Scene defaultView differs from qualified pinned camera transform");
    require(named("commitTransaction")["ok"]==true,"Center commit refused");
    const auto alignedBranch=branch(current());require(named("restore")["ok"]==true,"Restore deleted refused");
    require(same(scene(),shifted(original,point)) && masks()[0]==0 && branch(current())==alignedBranch && !canReset(current()),
        "Restored deleted splat lost aligned coordinates or selection boundary retained stale Reset");
    const auto aligned=scene();
    require(command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true,"Aligned PLY export refused");
    const Bytes exported(sv_output_ptr(),sv_output_ptr()+sv_output_len());
    require(open(exported)["ok"]==true && branch(current())==0 && frame(current())==identityMatrix,
        "Export/reopen did not establish new source coordinate identity");
    const auto reopened=scene();require(reopened.size()==aligned.size(),"Aligned restored export changed count");
    for(size_t i=0;i<aligned.size();++i) {
        for(size_t k=0;k<3;++k) require(reopened[i].positionOpacity[k]==aligned[i].positionOpacity[k],"Aligned PLY world coordinates did not round-trip");
        require(reopened[i].sh==aligned[i].sh,"Translation SH did not round-trip through PLY");
    }
}
void cumulativeResetHistoryAndIdentity() {
    ++cases;require(open(input())["ok"]==true,"Cumulative fixture refused");
    const auto base=current();const auto original=scene();const auto states=masks();
    const auto first=center({1,-2,3});const auto firstScene=scene();
    const auto second=center({-.5f,.25f,1});
    require(same(scene(),shifted(firstScene,{-.5f,.25f,1})) && branch(second)>branch(first) && canReset(second),
        "Repeated Center compounded wrong scene or lost original baseline");
    const auto secondScene=scene();const auto reset=command(resetRequest(second));
    require(reset["ok"]==true && same(scene(),original) && masks()==states && branch(reset)==0 && frame(reset)==frame(base) && !canReset(reset),
        "Cumulative Reset did not restore exact original scene/mask/frame/branch");
    const auto noop=command(resetRequest(reset));require(noop["revision"]==reset["revision"] && noop["canUndo"]==reset["canUndo"],
        "Baseline Reset manufactured native history");
    const auto undone=named("undo");require(undone["ok"]==true && same(scene(),secondScene) && branch(undone)==branch(second),
        "Reset Undo did not restore aligned geometry/branch");
    const auto redone=named("redo");require(redone["ok"]==true && same(scene(),original) && branch(redone)==0,"Reset Redo did not restore source owners");
    const auto identity=center({0,0,0});require(same(scene(),original) && frame(identity)==identityMatrix && branch(identity)>branch(second) && canReset(identity),
        "Accepted identity Center failed to create distinct equal-frame branch");
    require(named("undo")["ok"]==true && branch(current())==0,"Identity branch Undo failed");
    const auto divergent=center({0,0,0});require(branch(divergent)>branch(identity) && frame(divergent)==frame(identity) && divergent["canRedo"]==false,
        "Divergent equal-frame alignment reused identity or retained abandoned Redo");
    require(named("undo")["ok"]==true && named("redo")["ok"]==true && branch(current())==branch(divergent),"Divergent branch executable history failed");
}
void decimalCenterDefaultViewCarry() {
    ++cases;
    // IEEE754 decimal coordinates independently expose cumulative-frame
    // rounding: the third exact geometry shift differs from newFrame-oldFrame.
    const std::string text="ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
        "property float f_dc_2\nend_header\n0.1 0 0 -2 -2 -2 1 0 0 0 1 0 0 0\n"
        "0.2 0 0 -2 -2 -2 1 0 0 0 1 0 0 0\n0.3 0 0 -2 -2 -2 1 0 0 0 1 0 0 0\n";
    require(open(Bytes(text.begin(),text.end()))["ok"]==true,"Decimal Center fixture refused");
    const std::array<float,3> expectedFrames{-.1f,-.2f,-.3f};
    const std::array<float,3> expectedTargets{.1f,0.f,-.10000000894069672f};
    uint64_t previousBranch{};
    for(size_t index=0;index<3;++index) {
        const auto before=current();const auto beforeScene=scene();const auto point=at(beforeScene[index]);
        auto view=before.at("camera").get<View>();if(index==0) view[0]=.2f;
        const auto result=center(point,view,view);
        require(frame(result)[12]==expectedFrames[index] && result.at("camera")[0].get<double>()==double(expectedTargets[index]),
            "Decimal Center defaultView did not use independently expected cumulative-frame carry");
        require(result.at("camera").get<View>()==expectedCamera(view,frame(before),frame(result),result.at("radius").get<float>()),
            "Decimal Center scalar camera state differs from qualified pinned kernel");
        require(same(scene(),shifted(beforeScene,point)),"Decimal Center geometry stopped using its exact picked-point shift");
        require(branch(result)>previousBranch,"Decimal Center reused its branch identity");previousBranch=branch(result);
        if(index==2) {
            require(point[0]==.10000001639127731f && frame(before)[12]==-.20000000298023224f && view[0]==0,
                "Decimal fixture did not expose the intended third-Center rounding split");
            require(float(view[0]-point[0])!=expectedTargets[index],
                "Decimal camera oracle collapsed to the exact geometry request delta");
        }
    }
}
void transactionsCancelAndGroupBoundaries() {
    ++cases;require(open(input())["ok"]==true,"Rollback fixture refused");
    const auto first=center({.5f,1,-1});const auto original=scene();const auto states=masks();const auto view=first.at("camera").get<View>();
    require(named("beginTransaction")["ok"]==true,"Cancel checkpoint refused");
    require(command(centerRequest({2,0,0},view,view))["pending"]==true,"Cancelable Center did not start");
    require(parsed(sv_step(1))["pending"]==true && named("cancel")["ok"]==true,"Partial Center cancellation failed");
    unchanged(first,original,states,"Cancelled Center changed committed geometry, camera, history or baseline");++cancelCases;
    require(named("rollbackTransaction")["ok"]==true,"Cancelled checkpoint rollback failed");
    unchanged(first,original,states,"Cancelled checkpoint rollback failed to restore alignment metadata");++rollbackCases;
    require(named("beginTransaction")["ok"]==true,"Publication rollback checkpoint refused");
    const auto second=finish(command(centerRequest({2,0,0},view,view)));
    require(branch(second)>=branch(first)+2 && canReset(second),"Cancelled attempt recycled branch identity");
    require(named("rollbackTransaction")["ok"]==true,"Completed Center rollback refused");
    unchanged(first,original,states,"Completed Center rollback changed exact scene/mask/frame/branch/default/history/baseline");++rollbackCases;
    require(named("beginTransaction")["ok"]==true,"Reset rollback checkpoint refused");
    const auto reset=command(resetRequest(current()));require(reset["ok"]==true && branch(reset)==0,"Reset inside transaction refused");
    require(named("rollbackTransaction")["ok"]==true,"Reset checkpoint rollback refused");
    unchanged(first,original,states,"Reset rollback lost original operation baseline");++rollbackCases;
    require(named("selectAll")["ok"]==true && !canReset(current()),"Selection revision did not retire stale Reset baseline");
    const auto selected=current();const auto selectedScene=scene();const auto selectedStates=masks();
    require(command(resetRequest(selected))["ok"]==true,"Stale Reset did not use desktop no-op outcome");
    unchanged(selected,selectedScene,selectedStates,"Stale Reset mutated selection/content/history");
    const auto aligned=center({.25f,0,0});const auto alignedBranch=branch(aligned);
    Matrix4 transform=identityMatrix;transform[12]=.5f;
    require(finish(command({{"command","transform"},{"matrix",transform},{"selectedOnly",false}}))["ok"]==true &&
        branch(current())==alignedBranch && !canReset(current()),"Ordinary transform lost alignment lineage or retained alignment group Reset");
    auto values=neutralColor;values[0]=1.2f;
    require(finish(command({{"command","grade"},{"values",values},{"selectedOnly",false}}))["ok"]==true && branch(current())==alignedBranch,
        "Ordinary color copy lost alignment branch");
    require(named("endColor")["ok"]==true && named("undo")["ok"]==true && branch(current())==alignedBranch,
        "Color history lost alignment lineage");
}
void inputAndVisibleSupportRefusal() {
    ++cases;require(open(input())["ok"]==true,"Input refusal fixture refused");
    const auto before=current();const auto original=scene();const auto states=masks();const auto view=before.at("camera").get<View>();
    std::vector<Json> invalid;
    auto request=centerRequest({1,2,3},view,view);request["point"]={1,2};invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["point"][1]=nullptr;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["camera"].erase(request["camera"].begin()+10);invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["camera"][5]=0;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["defaultCamera"][6]=-1;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["camera"][8]=2;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["camera"][10]=0;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["defaultCamera"][0]=1e20;invalid.push_back(request);
    request=centerRequest({1,2,3},view,view);request["point"][0]=1e40;invalid.push_back(request);
    invalid.push_back({{"command","resetAlignment"}});
    request=resetRequest(before);request["camera"][10]=0;invalid.push_back(request);
    for(const auto &bad:invalid) {
        require(command(bad)["ok"]==false,"Malformed alignment command accepted");
        unchanged(before,original,states,"Malformed alignment command changed native state");++refusals;
    }
    require(named("selectAll")["ok"]==true && named("delete")["ok"]==true,"No-visible fixture deletion failed");
    const auto hidden=current();const auto hiddenStates=masks();
    require(command(centerRequest({0,0,0},view,view))["ok"]==false,"Identity alignment accepted without visible support");
    unchanged(hidden,original,hiddenStates,"No-visible support refusal changed geometry/masks/history");++refusals;
    require(named("restore")["ok"]==true,"Refusal damaged executable Restore deleted");
    require(named("beginSelection")["ok"]==true,"Draft fixture refused");
    require(command(centerRequest({1,0,0},view,view))["ok"]==false,"Alignment accepted during live selection");++refusals;
    require(named("cancelSelection")["ok"]==true,"Draft refusal damaged cancellation");
}
void terminalPublicationRefusal() {
    ++cases;
    for(size_t ordinal=2;ordinal<=12;++ordinal) {
        require(open(input(3))["ok"]==true,"Publication refusal source refused");
        const auto first=center({.5f,0,0});const auto before=current();const auto original=scene();const auto states=masks();
        const auto view=before.at("camera").get<View>();
        require(named("beginTransaction")["ok"]==true,"Publication refusal checkpoint refused");
        require(command(centerRequest({1,0,0},view,view))["pending"]==true && parsed(sv_step(2))["pending"]==true,
            "Publication failure fixture did not stop before terminal staging");
        sv_allocation::failBackendAtForContracts(ordinal);
        const char *reply=sv_step(1);sv_allocation::failBackendAtForContracts(0);
        const auto result=parsed(reply);
        if(result["ok"]==false) {
            require(current()["pending"]==false,"Refused Center retained partial job");
            unchanged(before,original,states,"Terminal admission refusal changed geometry/masks/frame/default/history/reset baseline");
            ++publicationRefusals;
        } else require(result["pending"]==false && branch(result)>branch(first),"Nonfailing terminal alignment failed publication");
        require(named("rollbackTransaction")["ok"]==true,"Publication checkpoint rollback refused");
        unchanged(before,original,states,"Publication refusal/success rollback damaged native checkpoint");++rollbackCases;
        require(named("undo")["ok"]==true && branch(current())==0,"Publication refusal damaged executable prior Undo");
    }
    require(publicationRefusals>=3,"Terminal Center admission did not exercise meaningful failure depths");
}
void boundedLineageAndSessionAdmission() {
    ++cases;
    browser_alignment::Lineage lineage;std::vector<std::shared_ptr<const Scene>> retained;
    for(size_t k=0;k<browser_alignment::Lineage::capacity;++k) {
        retained.push_back(std::make_shared<Scene>());require(lineage.associate(retained.back(),k+1),"Lineage refused a free bounded slot");
    }
    const auto extra=std::make_shared<Scene>();require(!lineage.associate(extra,1000),"Full lineage evicted retained history");
    require(lineage.branch(retained[0])==1 && lineage.branch(retained.back())==64,"Retained lineage changed after admission refusal");
    retained[3].reset();require(lineage.associate(extra,1000) && lineage.branch(extra)==1000,"Expired lineage did not release a slot");
    browser_alignment::IdSequence ids(browser_alignment::maximumIdentity);
    require(ids.take()==browser_alignment::maximumIdentity && !ids.take() && !ids.take(),"Alignment sequence overflow recycled IDs");
    auto sceneOwner=std::make_shared<Scene>();sceneOwner->gaussians.resize(1);const auto mask=MaskStorage::zero(1);
    browser_alignment::Context context{sceneOwner,mask,1,0,0,true};browser_alignment::Session session;
    require(session.begin(context) && !session.canReset(context),"Initial operation baseline was not a no-op Reset");
    auto afterScene=std::make_shared<Scene>(*sceneOwner);auto after=context;after.scene=afterScene;after.revision=1;after.contentRevision=1;
    require(session.acknowledge(context,after) && session.canReset(after),"Alignment session publication acknowledgement failed");
    auto stale=after;stale.revision=2;
    require(!session.current(stale) && !session.canReset(stale),"Stale revision retained Reset authorization");
    session.retireStale(stale);require(!session.baseline(),"Stale session retained scene/mask payload");
    require(session.begin(stale) && session.baseline()==afterScene,"New operation did not recapture current scene baseline");
    session.clear();require(!session.baseline(),"Operation group end retained alignment baseline");
}
void scaleAllMembersAndExport() {
    ++scaleCases;require(open(input(9,false,true))["ok"]==true,"Anisotropic Scale source refused");
    require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true && named("delete")["ok"]==true,
        "Scale deleted-member fixture refused");
    require(command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true,"Scale selected-member fixture refused");
    const auto before=current();const auto original=scene();const auto states=masks();
    const Point a{0,0,0},b{2,0,0};const auto matrix=uniformMatrix(a,b,4);auto view=before.at("camera").get<View>();
    view[3]=.5f;view[4]=.2f;view[7]=55;view[9]=.3f;
    require(original[0].covA[1]!=0 && original[0].covB[0]!=0,"Scale fixture lacks off-diagonal covariance");
    require(named("beginTransaction")["ok"]==true,"Scale staging checkpoint refused");
    require(command(scaleRequest(a,b,4,view,view))["pending"]==true && parsed(sv_step(1))["pending"]==true,
        "Scale did not yield its cooperative all-record job");
    unchanged(before,original,states,"Partial Scale published geometry/masks/frame/default/history");
    const auto terminal=finish(current());
    require(same(scene(),scaled(original,matrix)) && masks()==states,"Scale did not independently transform selected/unselected/deleted XYZ/covariance with unchanged opacity/SH/padding");
    require(frame(terminal)==matrix && branch(terminal)>branch(before) && canReset(terminal),"Scale failed to publish cumulative frame/branch/Reset");
    require(terminal.at("camera").get<View>()==expectedCamera(view,frame(before),matrix,terminal.at("radius").get<float>()),
        "Scale default camera differs from pinned frame carry");
    require(float(double(matrix[12])+double(matrix[0]))==1,"Scale failed midpoint invariance");
    require(named("commitTransaction")["ok"]==true,"Scale commit refused");
    const auto scaledScene=scene();const auto scaledBranch=branch(current());
    require(named("restore")["ok"]==true && same(scene(),scaledScene) && masks()[0]==0 && branch(current())==scaledBranch,
        "Restore deleted lost Scale geometry/lineage");
    require(command({{"command","export"},{"format",0},{"scope",0}})["ok"]==true,"Scale PLY export refused");
    const Bytes bytes(sv_output_ptr(),sv_output_ptr()+sv_output_len());require(open(bytes)["ok"]==true,"Scale PLY reopen refused");
    require(frame(current())==identityMatrix && branch(current())==0 && current()["canUndo"]==false,"Scale reopen did not establish fresh source coordinates");
    const auto reopened=scene();require(reopened.size()==scaledScene.size(),"Scale export changed count");
    for(size_t index=0;index<reopened.size();++index) {
        for(size_t axis=0;axis<3;++axis) require(reopened[index].positionOpacity[axis]==scaledScene[index].positionOpacity[axis],"Scale exported XYZ changed");
        require(reopened[index].sh==scaledScene[index].sh,"Scale directional SH changed during export/reopen");
        for(size_t entry=0;entry<4;++entry) require(std::abs(reopened[index].covA[entry]-scaledScene[index].covA[entry])<=
            2e-5f*std::max(std::abs(scaledScene[index].covA[entry]),1e-6f),"Scale covariance exceeded PLY decomposition roundtrip tolerance");
    }
}
void mixedAlignmentSessionReset() {
    ++scaleCases;require(open(input(9,false,true))["ok"]==true,"Mixed alignment source refused");
    const auto initial=current();const auto original=scene();const auto states=masks();
    const auto centered=center({.25f,-.5f,.75f});const auto centeredScene=scene();
    const Point a{-.5f,0,0},b{.5f,0,0};const auto matrix=uniformMatrix(a,b,.7f);
    const auto resized=scale(a,b,.7f);const auto resizedScene=scene();
    require(same(resizedScene,scaled(centeredScene,matrix)) && frame(resized)==composed(frame(centered),matrix) &&
        branch(resized)>branch(centered) && canReset(resized),"Center then Scale lost current geometry/cumulative frame/original session");
    const auto recentered=center({.125f,.25f,-.5f});auto expectedFrame=frame(resized);
    expectedFrame[12]-=.125f;expectedFrame[13]-=.25f;expectedFrame[14]+=.5f;
    require(same(scene(),shifted(resizedScene,{.125f,.25f,-.5f})) && frame(recentered)==expectedFrame,
        "Center after Scale changed covariance/SH or cumulative S/T frame");
    const auto lastScene=scene();const auto reset=command(resetRequest(recentered));
    require(reset["ok"]==true && same(scene(),original) && masks()==states && frame(reset)==frame(initial) && branch(reset)==0 && !canReset(reset),
        "Mixed Center/Scale Reset did not restore exact uninterrupted baseline");
    require(named("undo")["ok"]==true && same(scene(),lastScene) && branch(current())==branch(recentered),"Mixed Reset Undo lost Scale/Center branch");
    require(named("undo")["ok"]==true && same(scene(),resizedScene) && branch(current())==branch(resized),"Mixed Center Undo lost prior Scale branch");
    require(named("redo")["ok"]==true && named("redo")["ok"]==true && same(scene(),original),"Mixed executable Redo did not restore baseline Reset");
}
void roundedScaleBoundariesAndRefusals() {
    ++scaleCases;require(open(input(3,false,true))["ok"]==true,"Rounded Scale source refused");
    const Point a{0,0,0},b{1,1,4};const float initialTarget=float(std::sqrt(18.));const auto matrix=uniformMatrix(a,b,initialTarget);
    require(matrix[0]==.9999999403953552f && matrix!=identityMatrix,"Rounded initial Scale factor incorrectly snapped to identity");
    const auto original=scene();const auto accepted=scale(a,b,initialTarget);
    const auto expected=scaled(original,matrix);
    require(float(float(matrix[0]*original[1].positionOpacity[0])+matrix[12])!=expected[1].positionOpacity[0],
        "Rounded Scale fixture does not distinguish double affine sums from float-per-term arithmetic");
    require(same(scene(),expected) && frame(accepted)==matrix && branch(accepted)>0,"Rounded initial target did not apply real Scale arithmetic");
    for(float factor:{1e-6f,1e6f}) {
        require(open(input(3,false,true))["ok"]==true,"Scale factor boundary source refused");
        const auto beforeScene=scene();const auto result=scale({0,0,0},{1,0,0},factor);
        require(same(scene(),scaled(beforeScene,uniformMatrix({0,0,0},{1,0,0},factor))) && frame(result)[0]==factor,
            "Inclusive Scale factor boundary refused or rounded with incorrect affine arithmetic");
    }
    require(open(input(3,false,true))["ok"]==true,"Scale refusal source refused");
    const auto before=current();const auto beforeScene=scene();const auto states=masks();const auto view=before.at("camera").get<View>();
    std::vector<Json> invalid;
    auto request=scaleRequest(a,b,2,view,view);request["points"]={a};invalid.push_back(request);
    request=scaleRequest(a,a,2,view,view);invalid.push_back(request);
    request=scaleRequest(a,b,0,view,view);invalid.push_back(request);
    request=scaleRequest(a,b,-1,view,view);invalid.push_back(request);
    request=scaleRequest({0,0,0},{1,0,0},std::nextafter(1e-6f,0.f),view,view);invalid.push_back(request);
    request=scaleRequest({0,0,0},{1,0,0},std::nextafter(1e6f,std::numeric_limits<float>::infinity()),view,view);invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request["target"]=nullptr;invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request["target"]=1e40;invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request["points"][1][2]=true;invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request["points"][1][0]=1e40;invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request["camera"][5]=0;invalid.push_back(request);
    request=scaleRequest(a,b,2,view,view);request.erase("defaultCamera");invalid.push_back(request);
    for(const auto &bad:invalid) {
        require(command(bad)["ok"]==false,"Invalid Scale command accepted");
        unchanged(before,beforeScene,states,"Scale refusal changed current scene/mask/default/frame/history");++scaleRefusals;
    }
    require(named("selectAll")["ok"]==true && named("delete")["ok"]==true,"No-visible Scale fixture refused");
    const auto hidden=current();const auto hiddenStates=masks();
    require(command(scaleRequest(a,b,2,view,view))["ok"]==false,"Scale accepted without visible support");
    unchanged(hidden,beforeScene,hiddenStates,"No-visible Scale changed native state");++scaleRefusals;
}
void scaleCancellationAndPublicationRefusals() {
    ++scaleCases;require(open(input(9,false,true))["ok"]==true,"Scale cancellation source refused");
    center({.5f,0,0});center({.25f,0,0});require(named("undo")["ok"]==true,"Scale Redo fixture refused");
    const auto before=current();const auto original=scene();const auto states=masks();const auto view=before.at("camera").get<View>();
    require(named("beginTransaction")["ok"]==true && command(scaleRequest({0,0,0},{1,0,0},2,view,view))["pending"]==true && parsed(sv_step(1))["pending"]==true,
        "Scale cancellation fixture did not yield");
    require(named("cancel")["ok"]==true && named("rollbackTransaction")["ok"]==true,"Scale cancellation rollback refused");
    unchanged(before,original,states,"Cancelled Scale lost geometry/default/baseline/Redo");++scaleCancelCases;++scaleRollbackCases;
    require(named("redo")["ok"]==true,"Cancelled Scale damaged executable Redo");
    for(size_t ordinal=2;ordinal<=12;++ordinal) {
        require(open(input(3,false,true))["ok"]==true,"Scale publication source refused");center({.5f,0,0});
        const auto captured=current();const auto capturedScene=scene();const auto capturedStates=masks();const auto camera=captured.at("camera").get<View>();
        require(named("beginTransaction")["ok"]==true && command(scaleRequest({0,0,0},{1,0,0},2,camera,camera))["pending"]==true && parsed(sv_step(2))["pending"]==true,
            "Scale publication fixture did not stop before terminal staging");
        sv_allocation::failBackendAtForContracts(ordinal);const char *reply=sv_step(1);sv_allocation::failBackendAtForContracts(0);
        const auto result=parsed(reply);
        if(result["ok"]==false) { unchanged(captured,capturedScene,capturedStates,"Refused terminal Scale published partial scene/default/frame/history");++scalePublicationRefusals; }
        else require(result["pending"]==false && branch(result)>branch(captured),"Nonrefused terminal Scale failed publication");
        require(named("rollbackTransaction")["ok"]==true,"Scale publication checkpoint rollback refused");
        unchanged(captured,capturedScene,capturedStates,"Scale publication rollback lost original mixed baseline/history");++scaleRollbackCases;
        const auto reset=command(resetRequest(current()));require(reset["ok"]==true && branch(reset)==0,"Refused Scale damaged retained Center Reset baseline");
    }
    require(scalePublicationRefusals>=3,"Scale terminal refusal did not exercise meaningful publication depths");
}
void scaleGeometryRangeRefusal() {
    ++scaleCases;auto bytes=input(3,false,true);std::string text(bytes.begin(),bytes.end());
    const auto row=text.find("end_header\n");require(row!=std::string::npos,"Scale range fixture header missing");
    text.replace(row+11,1,"10000000");require(open(Bytes(text.begin(),text.end()))["ok"]==true,"Scale range fixture refused to open");
    const auto before=current();const auto original=scene();const auto states=masks();
    // Explicit valid C ABI camera inputs isolate geometry's double-range
    // failure from the separate camera-range preflight refusal contract.
    const View view{0,0,0,.5f,.2f,3,1,55,1,.3f,1};
    require(named("beginTransaction")["ok"]==true && command(scaleRequest({0,0,0},{1,0,0},1e6f,view,view))["pending"]==true,
        "Scale range job did not begin with valid camera inputs");
    require(parsed(sv_step(1))["ok"]==false,"Unrepresentable scaled position was published");
    unchanged(before,original,states,"Scale geometry-range refusal lost current native owners/history");++scaleRefusals;
    require(named("rollbackTransaction")["ok"]==true,"Scale range checkpoint rollback refused");
    unchanged(before,original,states,"Scale range rollback failed exact baseline");++scaleRollbackCases;
}
Matrix4 planeMatrix(const std::array<Point,3> &p,bool flip,bool yUp) {
    return alignFromPoints({p[0][0],p[0][1],p[0][2]},{p[1][0],p[1][1],p[1][2]},{p[2][0],p[2][1],p[2][2]},flip!=!yUp);
}
std::vector<Gaussian> affineGeometry(std::vector<Gaussian> values,const Matrix4 &matrix) {
    for(auto &g:values) {
        const auto original=g;double covariance[3][3]{{original.covA[0],original.covA[1],original.covA[2]},
            {original.covA[1],original.covA[3],original.covB[0]},{original.covA[2],original.covB[0],original.covB[1]}},out[3][3]{};
        for(size_t r=0;r<3;++r) {
            double value=matrix[12+r];for(size_t c=0;c<3;++c) value+=double(matrix[c*4+r])*original.positionOpacity[c];g.positionOpacity[r]=float(value);
            for(size_t c=0;c<3;++c) for(size_t k=0;k<3;++k) for(size_t l=0;l<3;++l)
                out[r][c]+=double(matrix[k*4+r])*covariance[k][l]*double(matrix[l*4+c]);
        }
        g.covA={float(out[0][0]),float(out[0][1]),float(out[0][2]),float(out[1][1])};g.covB[0]=float(out[1][2]);g.covB[1]=float(out[2][2]);
    }
    return values;
}
std::array<double,16> harmonicBasis(std::array<double,3> p) {
    const double x=p[0],y=p[1],z=p[2],xx=x*x,yy=y*y,zz=z*z;
    return {.28209479177387814,-.4886025119029199*y,.4886025119029199*z,-.4886025119029199*x,
        1.0925484305920792*x*y,-1.0925484305920792*y*z,.31539156525252005*(2*zz-xx-yy),
        -1.0925484305920792*x*z,.5462742152960396*(xx-yy),-.5900435899266435*y*(3*xx-yy),
        2.890611442640554*x*y*z,-.4570457994644658*y*(4*zz-xx-yy),.3731763325901154*z*(2*zz-3*xx-3*yy),
        -.4570457994644658*x*(4*zz-xx-yy),1.445305721320277*z*(xx-yy),-.5900435899266435*x*(xx-3*yy)};
}
double directional(const Gaussian &g,unsigned degree,unsigned color,std::array<double,3> point) {
    const auto basis=harmonicBasis(point);double value{};
    for(unsigned coefficient=0;coefficient<(degree+1)*(degree+1);++coefficient) value+=basis[coefficient]*shValue(g,coefficient,color);return value;
}
void planeAllMembersAndDirectionalSH() {
    ++planeCases;const std::array<Point,3> points{Point{0,0,0},Point{0,1,0},Point{0,0,1}};
    for(unsigned degree=0;degree<=3;++degree) {
        require(open(input(9,false,true,degree))["ok"]==true && current()["shDegree"]==degree,"Plane degree fixture failed");
        require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true && named("delete")["ok"]==true &&
            command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true,"Plane all-mask fixture failed");
        const auto before=current();const auto original=scene();const auto states=masks();auto active=before.at("camera").get<View>(),saved=active;
        active[3]=.5f;active[9]=.4f;saved[3]=-.3f;saved[9]=-.35f;
        const auto matrix=planeMatrix(points,false,true);const auto expected=affineGeometry(original,matrix);
        require(named("beginTransaction")["ok"]==true && command(planeRequest(points,false,active,saved))["pending"]==true && parsed(sv_step(1))["pending"]==true,"Plane did not yield all-record job");
        unchanged(before,original,states,"Partial plane published geometry/SH/mask/history/default");
        const auto result=finish(current());const auto transformed=scene();
        require(frame(result)==matrix && branch(result)>branch(before) && canReset(result) && masks()==states,"Plane frame/branch/masks/Reset failed");
        require(result["camera"].get<View>()==expectedCamera(saved,frame(before),matrix,result["radius"].get<float>(),true),"Plane default did not use WorldUpright frame carry");
        bool changed=false;
        for(size_t index=0;index<transformed.size();++index) {
            require(transformed[index].positionOpacity==expected[index].positionOpacity && transformed[index].covA==expected[index].covA && transformed[index].covB==expected[index].covB,"Plane all-member XYZ/covariance/padding/opacity differs from independent double oracle");
            for(unsigned color=0;color<3;++color) require(shValue(transformed[index],0,color)==shValue(original[index],0,color),"Plane changed DC coefficient");
            changed|=transformed[index].sh!=original[index].sh;
            for(auto direction: {std::array<double,3>{1,0,0},std::array<double,3>{0,1,0},std::array<double,3>{0,0,1},std::array<double,3>{1,2,3},std::array<double,3>{-2,1,1}}) {
                const double length=std::sqrt(direction[0]*direction[0]+direction[1]*direction[1]+direction[2]*direction[2]);for(auto &entry:direction) entry/=length;
                const double scale=std::sqrt(double(matrix[0])*matrix[0]+double(matrix[1])*matrix[1]+double(matrix[2])*matrix[2]);std::array<double,3> inverseDirection{};
                for(size_t c=0;c<3;++c) for(size_t r=0;r<3;++r) inverseDirection[c]+=double(matrix[c*4+r])*direction[r]/scale;
                for(unsigned color=0;color<3;++color) require(std::abs(directional(transformed[index],degree,color,direction)-directional(original[index],degree,color,inverseDirection))<3e-4,"Rotated directional SH appearance exceeds independent polynomial/half tolerance");
            }
        }
        require(changed==(degree>0),"Plane did not rotate directional degrees or rewrote SH0");
        require(named("commitTransaction")["ok"]==true && named("restore")["ok"]==true && same(scene(),transformed) && masks()[0]==0,"Restored deleted plane member lost rotated geometry/SH");
    }
}
void planeFlipNormalAndReadonlyRefusals() {
    ++planeCases;const std::array<Point,3> points{Point{0,0,0},Point{0,0,1},Point{1,0,0}};
    for(bool yUp:{false,true}) for(bool flip:{false,true}) {
        require(open(input(3,false,true))["ok"]==true,"Plane flip source refused");auto view=current()["camera"].get<View>();view[8]=yUp?1:0;view[9]=.3f;
        const auto result=plane(points,flip,view,view);require(frame(result)==planeMatrix(points,flip,yUp) && result["camera"][8]==view[8] && result["camera"][9]==0,"Plane flip/yUp mapping or upright policy differs");
    }
    require(open(input(3))["ok"]==true,"Plane normal source refused");center({.25f,0,0});const auto before=current();const auto original=scene();const auto states=masks();
    const auto normal=command({{"command","planeNormal"},{"points",points}});require(normal["point"].get<Point>()==Point{0,1,0},"Read-only plane normal differs from ordered cross product");
    unchanged(before,original,states,"Plane normal query changed native owners/history/Reset");
    const auto view=before["camera"].get<View>();std::vector<Json> invalid;
    auto request=planeRequest(points,false,view,view);request["points"]={points[0],points[1]};invalid.push_back(request);
    request=planeRequest(points,false,view,view);request["flip"]=0;invalid.push_back(request);
    request=planeRequest(points,false,view,view);request["points"][2][0]=1e40;invalid.push_back(request);
    request=planeRequest(points,false,view,view);request["points"][2][1]=true;invalid.push_back(request);
    request=planeRequest(points,false,view,view);request["points"][2]=points[1];invalid.push_back(request);
    request=planeRequest(points,false,view,view);request.erase("defaultCamera");invalid.push_back(request);
    request=planeRequest(points,false,view,view);request["camera"][5]=0;invalid.push_back(request);
    for(const auto &bad:invalid) {require(command(bad)["ok"]==false,"Malformed/degenerate plane accepted");unchanged(before,original,states,"Plane refusal changed geometry/mask/frame/Reset");++planeRefusals;}
    const std::array<Point,3> nearLine{Point{0,0,0},Point{1,0,0},Point{1,1e-6f,0}};
    require(command({{"command","planeNormal"},{"points",nearLine}})["ok"]==false,"Inclusive relative-collinearity normal was accepted");++planeRefusals;
    auto outside=nearLine;outside[2][1]=1.01e-6f;require(command({{"command","planeNormal"},{"points",outside}})["point"].get<Point>()==Point{0,0,1},"Valid near-collinear normal was refused");
    unchanged(before,original,states,"Normal refusal/acceptance changed editing state");
}
void planeMixedResetHistoryRetention() {
    ++planeCases;require(open(input(3,false,true))["ok"]==true,"Plane history source refused");const auto initial=current();const auto original=scene();const auto states=masks();
    center({.25f,-.5f,.75f});scale({0,0,0},{1,0,0},.7f);
    const std::array<Point,3> points{Point{0,0,0},Point{0,1,0},Point{0,0,1}};const auto aligned=plane(points);const auto alignedScene=scene();
    const auto recentered=center({.1f,.2f,-.3f});require(frame(recentered)==composed(frame(aligned),centerAtPoint({.1f,.2f,-.3f})),"Center after rotation bypassed native frame composition");
    const auto reset=command(resetRequest(current()));require(reset["ok"]==true && same(scene(),original) && masks()==states && branch(reset)==branch(initial),"Mixed Center/Scale/Plane Reset lost baseline bytes/mask/branch");
    require(named("undo")["ok"]==true && named("undo")["ok"]==true && same(scene(),alignedScene) && branch(current())==branch(aligned),"Mixed plane Undo lost geometry/SH lineage");
    require(named("redo")["ok"]==true && named("redo")["ok"]==true && same(scene(),original),"Mixed plane Redo lost executable Reset");
    require(open(input(3))["ok"]==true,"Retention source refused");
    const std::array<Point,3> identity{Point{0,0,0},Point{0,0,1},Point{1,0,0}};
    for(size_t i=0;i<15;++i) plane(identity);
    const auto retained=current()["alignment"]["retainedBranchIds"].get<std::vector<uint64_t>>();require(retained.size()<=12 && retained.front()==0,"Retention includes abandoned weak scenes or omitted Reset baseline");
    require(named("undo")["ok"]==true,"Retention Undo refused");const auto before=current();const auto captured=before["alignment"]["retainedBranchIds"].get<std::vector<uint64_t>>();const auto abandoned=retained.back();const auto view=before["camera"].get<View>();
    require(named("beginTransaction")["ok"]==true,"Retention checkpoint refused");const auto next=finish(command(planeRequest(identity,false,view,view)));
    const auto nextIds=next["alignment"]["retainedBranchIds"].get<std::vector<uint64_t>>();require(std::find(nextIds.begin(),nextIds.end(),abandoned)==nextIds.end(),"Checkpoint-only abandoned Redo branch leaked into retained IDs");
    require(named("rollbackTransaction")["ok"]==true && current()["alignment"]["retainedBranchIds"].get<std::vector<uint64_t>>()==captured && named("redo")["ok"]==true,"Retention rollback lost Redo branch roots");++planeRollbackCases;
}
void planeCancellationAndPublicationRollback() {
    ++planeCases;const std::array<Point,3> points{Point{0,0,0},Point{0,1,0},Point{0,0,1}};
    require(open(input(9,false,true))["ok"]==true,"Plane cancellation source refused");center({.25f,0,0});const auto before=current();const auto original=scene();const auto states=masks();const auto view=before["camera"].get<View>();
    require(named("beginTransaction")["ok"]==true && command(planeRequest(points,false,view,view))["pending"]==true && parsed(sv_step(1))["pending"]==true,"Plane cancellation did not yield");
    require(named("cancel")["ok"]==true && named("rollbackTransaction")["ok"]==true,"Plane cancellation rollback refused");unchanged(before,original,states,"Plane cancel lost geometry/SH/default/Reset/history");++planeCancelCases;++planeRollbackCases;
    for(size_t ordinal=2;ordinal<=12;++ordinal) {
        require(open(input(3,false,true))["ok"]==true,"Plane publication source refused");center({.25f,0,0});const auto captured=current();const auto geometry=scene();const auto mask=masks();const auto camera=captured["camera"].get<View>();
        require(named("beginTransaction")["ok"]==true && command(planeRequest(points,false,camera,camera))["pending"]==true && parsed(sv_step(2))["pending"]==true,"Plane publication did not stop before terminal");
        sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_step(1);sv_allocation::failBackendAtForContracts(0);const auto result=parsed(reply);
        if(result["ok"]==false) {unchanged(captured,geometry,mask,"Plane terminal refusal published partial SH/frame/history/default");++planePublicationRefusals;}
        require(named("rollbackTransaction")["ok"]==true,"Plane publication rollback refused");unchanged(captured,geometry,mask,"Plane checkpoint rollback lost original state");++planeRollbackCases;
    }
    require(planePublicationRefusals>=3,"Plane publication failures did not cover meaningful staging depths");
}
void retainedExportAccountingAcrossAlignment() {
    // Exercise returned staged terminals, rather than replacing them with a
    // later canonical query. The browser accounts its terminal's history while
    // the independent retained-output lease still covers these same bytes.
    for(unsigned format:{0u,2u,3u,4u,5u}) {
        ++cases;require(open(input())["ok"]==true,"Retained export alignment source refused");
        require(command({{"command","single"},{"index",0},{"operation",0}})["ok"]==true &&
                named("delete")["ok"]==true && command({{"command","single"},{"index",1},{"operation",0}})["ok"]==true,
                "Retained export alignment masks refused");
        const auto original=scene();const auto states=masks();const auto baseline=current();
        const auto exported=command({{"command","export"},{"format",format},{"scope",0}});
        require(exported["ok"]==true && exported.at("exportOutputBytes").get<size_t>()>0,
                "Retained export fixture has no admitted output owner");
        const auto *outputOwner=sv_output_ptr();const Bytes output(outputOwner,outputOwner+sv_output_len());
        const auto retained=exported.at("exportOutputBytes");
        const auto accounting=[&](const Json &value) {
            const auto canonical=current();
            require(value.at("exportOutputBytes")==retained && value.at("exportBytes")==retained &&
                    value.at("exportOutputBytes")==canonical.at("exportOutputBytes") && value.at("exportBytes")==canonical.at("exportBytes"),
                    "Alignment terminal omitted retained export metadata or disagrees with canonical telemetry");
            require(sv_output_ptr()==outputOwner && sv_output_len()==output.size() &&
                    !std::memcmp(outputOwner,output.data(),output.size()) && masks()==states,
                    "Alignment/history changed retained output ownership/bytes or selection/deletion masks");
        };
        accounting(exported);
        const Point point{.25f,-.5f,.75f};auto view=current().at("camera").get<View>();
        require(named("beginTransaction")["ok"]==true,"Retained export Center checkpoint refused");
        const auto centered=finish(command(centerRequest(point,view,view)));accounting(centered);
        auto centerFrame=identityMatrix;for(size_t axis=0;axis<3;++axis)centerFrame[12+axis]=-point[axis];
        const auto centeredScene=scene();
        require(same(centeredScene,shifted(original,point)) && frame(centered)==centerFrame && canReset(centered),
                "Retained export Center changed the independent geometry/frame oracle");
        accounting(named("commitTransaction"));

        view=current().at("camera").get<View>();const auto matrix=uniformMatrix({0,0,0},{1,0,0},2);
        require(named("beginTransaction")["ok"]==true,"Retained export Scale checkpoint refused");
        const auto resized=finish(command(scaleRequest({0,0,0},{1,0,0},2,view,view)));accounting(resized);
        const auto resizedScene=scene();
        require(same(resizedScene,scaled(centeredScene,matrix)) && frame(resized)==composed(centerFrame,matrix),
                "Retained export Scale changed the independent geometry/frame oracle");
        accounting(named("commitTransaction"));

        view=current().at("camera").get<View>();
        const std::array<Point,3> points{Point{0,0,0},Point{0,1,0},Point{0,0,1}};
        require(named("beginTransaction")["ok"]==true,"Retained export Plane checkpoint refused");
        const auto aligned=finish(command(planeRequest(points,false,view,view)));accounting(aligned);
        const auto alignedScene=scene();
        require(frame(aligned)==composed(frame(resized),planeMatrix(points,false,view[8]!=0)),
                "Retained export Plane lost its cumulative frame oracle");
        accounting(named("commitTransaction"));

        const auto reset=command(resetRequest(current()));accounting(reset);
        require(reset["ok"]==true && same(scene(),original) && frame(reset)==frame(baseline) && branch(reset)==branch(baseline),
                "Retained export alignment Reset lost the exact source records/frame/branch");
        accounting(named("undo"));require(same(scene(),alignedScene) && frame(current())==frame(aligned),"Retained export Reset Undo lost exact rotated SH/geometry/frame");
        accounting(named("undo"));require(same(scene(),resizedScene) && frame(current())==frame(resized),"Retained export Plane Undo lost exact scaled records/frame");
        accounting(named("undo"));require(same(scene(),centeredScene) && frame(current())==frame(centered),"Retained export Scale Undo lost exact centered records/frame");
        accounting(named("undo"));require(same(scene(),original) && frame(current())==frame(baseline),"Retained export Center Undo lost exact source records/frame");
        accounting(named("redo"));require(same(scene(),centeredScene),"Retained export Center Redo lost exact centered records");
        accounting(named("redo"));require(same(scene(),resizedScene),"Retained export Scale Redo lost exact scaled records");
        accounting(named("redo"));require(same(scene(),alignedScene),"Retained export Plane Redo lost exact rotated SH/geometry");
        accounting(named("redo"));require(same(scene(),original) && frame(current())==frame(baseline),"Retained export Reset Redo lost exact source records/frame");
    }
}
}
int main() {
    try {
        translationDeletedSHCameraAndExport();cumulativeResetHistoryAndIdentity();decimalCenterDefaultViewCarry();transactionsCancelAndGroupBoundaries();
        inputAndVisibleSupportRefusal();terminalPublicationRefusal();boundedLineageAndSessionAdmission();retainedExportAccountingAcrossAlignment();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final alignment allocation census invalid");
        const auto centerChecks=checks;
        scaleAllMembersAndExport();mixedAlignmentSessionReset();roundedScaleBoundariesAndRefusals();scaleCancellationAndPublicationRefusals();scaleGeometryRangeRefusal();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final Scale allocation census invalid");
        const auto scaleChecks=checks-centerChecks;planeAllMembersAndDirectionalSH();planeFlipNormalAndReadonlyRefusals();planeMixedResetHistoryRetention();planeCancellationAndPublicationRollback();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final Plane allocation census invalid");
        std::printf("SPLATVIEW_ALIGNMENT_CONTRACTS_PASS cases=%zu checks=%zu refusals=%zu publicationRefusals=%zu cancellationCases=%zu rollbackCases=%zu scaleCases=%zu scaleChecks=%zu scaleRefusals=%zu scalePublicationRefusals=%zu scaleCancellationCases=%zu scaleRollbackCases=%zu planeCases=%zu planeChecks=%zu planeRefusals=%zu planePublicationRefusals=%zu planeCancellationCases=%zu planeRollbackCases=%zu\n",
            cases,centerChecks,refusals,publicationRefusals,cancelCases,rollbackCases,scaleCases,scaleChecks,
            scaleRefusals,scalePublicationRefusals,scaleCancelCases,scaleRollbackCases,planeCases,checks-centerChecks-scaleChecks,planeRefusals,planePublicationRefusals,planeCancelCases,planeRollbackCases);return 0;
    } catch(const std::exception &error) {
        sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"SPLATVIEW_ALIGNMENT_CONTRACTS_FAIL %s\n",error.what());return 1;
    }
}
