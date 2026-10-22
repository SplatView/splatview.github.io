// Private actual ABI proof: independent literal masks, immutable click inputs,
// metadata acknowledgements, one-Undo amendments and publication refusal.
#include "model.hpp"
#include "response.hpp"
#include "allocation_census.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>
extern "C" {
unsigned sv_abi_version();const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();const uint8_t *sv_states_ptr();
const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const char *sv_recovery_prepare();const uint8_t *sv_recovery_read(unsigned,unsigned);
unsigned sv_recovery_read_size();void sv_recovery_release();
const char *sv_recovery_restore_begin(unsigned,unsigned,unsigned,const char *);
const char *sv_recovery_restore_write(unsigned,const uint8_t *,unsigned);
const char *sv_recovery_restore_finish();void sv_recovery_restore_cancel();
}
namespace {
using namespace preview;using Json=nlohmann::json;using Bytes=std::vector<uint8_t>;
constexpr unsigned allowance=64*1024*1024;
size_t groups{},checks{},refusals{},backendRefusals{},recordedProofTools{};uint64_t sessionId{},mapId{};
void require(bool value,const char *message){++checks;if(!value)throw std::runtime_error(message);}
template<class F>void test(const char *name,F action){action();++groups;std::printf("SELECTION_RANGE_GROUP_PASS %s\n",name);}
Json parsed(const char *text){return Json::parse(text);}
Json command(const Json &request){const auto text=request.dump();return parsed(sv_command(text.c_str()));}
Json good(const Json &request){auto out=command(request);require(out.at("ok")==true,out.value("error",std::string("Range command refused")).c_str());return out;}
Json summary(){return good({{"command","summary"}});}
Json finish(Json value){for(size_t i=0;value.value("pending",false);++i){require(i<10000,"Range query did not terminate");value=parsed(sv_step(3));require(value.at("ok")==true,value.value("error",std::string("Range query step refused")).c_str());}return value;}
Json camera(){return Json::array({0,0,0,0,0,3,1,90,1,0});}
Json view(float x=0){auto value=camera();value[0]=x;value.push_back(1);return value;}
void open(){Bytes bytes(4*32);const std::array<float,4> positions{0,.5f,1.5f,2.5f};
    for(size_t i=0;i<4;++i){const std::array<float,6> fields{positions[i],0,0,.01f,.01f,.01f};std::memcpy(bytes.data()+32*i,fields.data(),24);
        const std::array<uint8_t,8> tail{80,120,160,128,255,128,128,128};std::memcpy(bytes.data()+32*i+24,tail.data(),8);}
    require(parsed(sv_open(bytes.data(),bytes.size(),unsigned(InputFormat::Splat),1000,allowance)).at("ok")==true,"Range fixture failed to open");
    require(summary().at("toleranceRange").is_null()&&summary().at("toleranceRecorded").is_null(),"New source retained an old Range or recorded owner");
}
Bytes mask(){const auto n=summary().at("count").get<size_t>();return {sv_states_ptr(),sv_states_ptr()+n};}
std::vector<Gaussian> records(){const auto n=summary().at("count").get<size_t>();return {sv_scene_ptr(),sv_scene_ptr()+n};}
struct Snapshot {
    Json value=summary();Bytes states=mask();std::vector<Gaussian> bytes=records();const void *scene=sv_scene_ptr(),*maskOwner=sv_states_ptr();
    void unchanged(bool work=false,bool statistics=false) const {
        auto now=summary(),before=value;
        if(work)for(const char *key:{"pending","progress","memoryBytes"}){now.erase(key);before.erase(key);}
        if(statistics){now.erase("morphologyRange");before.erase("morphologyRange");}
        require(now==before&&mask()==states&&sv_scene_ptr()==scene&&sv_states_ptr()==maskOwner,"Readonly/refused Range action changed summary, owner or mask");
        const auto current=records();require(current.size()==bytes.size()&&!std::memcmp(current.data(),bytes.data(),bytes.size()*sizeof(Gaussian)),"Range action changed Gaussian bytes");
    }
};
Json color(unsigned operation=0,bool enabled=true,Json radius=1){
    return {{"command","colorPick"},{"sessionId",++sessionId},{"camera",camera()},{"index",0},{"operation",operation},{"tolerance",1},{"rangeEnabled",enabled},{"rangeRadius",radius}};
}
Json amendColor(uint64_t id,bool enabled,Json radius){return {{"command","colorTolerance"},{"sessionId",id},{"tolerance",1},{"rangeEnabled",enabled},{"rangeRadius",radius}};}
Json adoptMap(float depth=3,bool rgb=false){
    const auto id=++mapId;constexpr unsigned width=5,height=5,pixels=width*height;
    good({{"command","selectionMapBegin"},{"mapId",id},{"layoutVersion",1},{"fullWidth",width},{"fullHeight",height},{"mapWidth",width},{"mapHeight",height},{"sourceCount",4},{"channels",rgb?15:3}});
    std::vector<float> values(pixels*(rgb?5:2),.5f);std::fill(values.begin(),values.begin()+pixels,depth);
    Bytes bytes(values.size()*4+(rgb?4:0));std::memcpy(bytes.data(),values.data(),values.size()*4);
    if(rgb){const uint32_t visible=15;std::memcpy(bytes.data()+values.size()*4,&visible,4);}
    require(parsed(sv_map_write(double(id),0,bytes.data(),unsigned(bytes.size()))).at("ok")==true,"Range map write failed");
    good({{"command","selectionMapCommit"},{"mapId",id}});return {{"id",id},{"width",width},{"height",height}};
}
Json fill(const Json &map,unsigned operation=0,bool enabled=true,Json radius=1,bool sample=true){
    Json request{{"command","fillPick"},{"sessionId",++sessionId},{"mapId",map.at("id")},{"camera",camera()},{"width",map.at("width")},{"height",map.at("height")},
        {"seed",{2,2}},{"operation",operation},{"tolerance",.1},{"visibleOnly",false},{"overlap",false},{"rangeEnabled",enabled},{"rangeRadius",radius}};
    if(sample)request["sampleRadiusPixels"]=1;return request;
}
Json amendFill(uint64_t id,bool enabled,Json radius){return {{"command","fillTolerance"},{"sessionId",id},{"tolerance",.1},{"rangeEnabled",enabled},{"rangeRadius",radius}};}
void expect(Bytes expected,const char *message){require(mask()==expected,message);}
void literalColorOperations(){
    require(sv_abi_version()==24&&parsed(sv_build_identity()).at("capabilities").at("colorFillRange")==1&&
        parsed(sv_build_identity()).at("capabilities").at("transformPivot")==2,"Range capability/ABI mismatch");
    const std::array<Bytes,4> expected{Bytes{1,1,0,0},Bytes{1,1,1,0},Bytes{0,0,1,0},Bytes{0,0,0,0}};
    for(unsigned operation=0;operation<4;++operation){open();good({{"command","single"},{"index",2},{"operation",0}});const auto before=records();
        const auto value=good(color(operation));expect(expected[operation],"Color Range-before-Combine differs from literal mask");
        require(value.at("toleranceRange")==Json{{"enabled",true},{"radius",1},{"center",{0,0,0}}},"Color did not freeze its original raw native center");
        require(!std::memcmp(before.data(),sv_scene_ptr(),before.size()*sizeof(Gaussian)),"Color Range changed attributes");
    }
    open();auto request=color();request["selectionView"]=view(10);good(request);expect({0,0,0,0},"Captured current-view clipping was replaced by sphere preservation");
    open();good({{"command","single"},{"index",3},{"operation",0}});good({{"command","delete"}});good(color(1));expect({1,1,0,2},"Deleted Gaussian did not retain state2");
}
void absoluteColorHistoryAndNoop(){
    open();const auto request=color();const auto id=request.at("sessionId").get<uint64_t>();const auto first=good(request);
    const auto narrow=good(amendColor(id,true,double(.4f)));expect({1,0,0,0},"Color Radius amendment was not absolute from original checkpoint");
    require(narrow.at("toleranceRange").at("center")==first.at("toleranceRange").at("center"),"Color amendment recollected its center");
    const auto wide=good(amendColor(id,true,2));expect({1,1,1,0},"Color Radius widening lost original region");
    const auto same=good(amendColor(id,true,2));require(same.at("revision")==wide.at("revision")&&same.at("selectionCommitRevision")==wide.at("selectionCommitRevision"),"Unchanged Range amendment synthesized a selection event");
    const auto off=good(amendColor(id,false,2));expect({1,1,1,1},"Disabling Range retained its old sphere");
    const auto metadata=good(amendColor(id,false,3));require(metadata.at("revision")==off.at("revision")&&metadata.at("toleranceRange").at("radius")==3,"Disabled-radius metadata-only amendment was not acknowledged");
    const auto legacy=good({{"command","colorTolerance"},{"sessionId",id},{"tolerance",1}});
    require(legacy.at("toleranceRange")==Json{{"enabled",false},{"radius",nullptr},{"center",{0,0,0}}},"Legacy omitted pair did not reset Range absolutely");
    good({{"command","endTolerance"},{"sessionId",id}});good({{"command","undo"}});expect({0,0,0,0},"Range amendments did not retain one Undo");
    require(!summary().at("canUndo").get<bool>(),"Range amendments appended extra Undo entries");
    open();good({{"command","single"},{"index",2},{"operation",0}});good({{"command","undo"}});const auto before=summary();
    auto noop=color(2);const auto noopId=noop.at("sessionId").get<uint64_t>();good(noop);
    const auto accepted=good(amendColor(noopId,true,2));expect({0,0,0,0},"Remove from empty baseline selected anything");
    require(accepted.at("canRedo")==true&&accepted.at("revision")==before.at("revision")&&accepted.at("selectionCommitRevision")==before.at("selectionCommitRevision"),"Metadata-only Range owner damaged Redo/history");
    good({{"command","endTolerance"},{"sessionId",noopId}});good({{"command","redo"}});expect({0,0,1,0},"Range no-op made advertised Redo inoperable");
}
void fillOperationsAndFrozenSurface(){
    const std::array<Bytes,4> expected{Bytes{1,1,0,0},Bytes{1,1,1,0},Bytes{0,0,1,0},Bytes{0,0,0,0}};
    for(unsigned operation=0;operation<4;++operation){open();good({{"command","single"},{"index",2},{"operation",0}});const auto map=adoptMap();const auto request=fill(map,operation);const auto value=good(request);
        expect(expected[operation],"Fill applied Range after Combine instead of before it");require(value.at("toleranceRange").at("center")==Json::array({0,0,0}),"Fill did not freeze the captured pixel-center surface point");
        const auto amended=good(amendFill(request.at("sessionId").get<uint64_t>(),false,1));require(amended.at("toleranceRange").at("center")==value.at("toleranceRange").at("center"),"Fill disabled its frozen center");
    }
    open();const auto map=adoptMap();const auto request=fill(map);const auto id=request.at("sessionId").get<uint64_t>();good(request);
    good(amendFill(id,true,2));expect({1,1,1,0},"Fill amendment was not based on original region/checkpoint");
    good(amendFill(id,true,double(.4f)));expect({1,0,0,0},"Fill Radius shrink retained earlier combined hits");
    good({{"command","endTolerance"},{"sessionId",id}});good({{"command","undo"}});expect({0,0,0,0},"Fill Range amendments made multiple Undo items");require(!summary().at("canUndo").get<bool>(),"Fill retained an extra click Undo");
}
void centerlessFillAndConnectedColor(){
    open();good({{"command","single"},{"index",3},{"operation",0}});const auto map=adoptMap(0);const Snapshot old;
    auto invalid=fill(map);require(command(invalid).at("ok")==false,"Enabled initial centerless Fill was accepted");old.unchanged();++refusals;
    auto disabled=fill(map,0,false,1);const auto id=disabled.at("sessionId").get<uint64_t>();const auto selected=good(disabled);
    require(selected.at("toleranceRange").at("center").is_null(),"Missing depth manufactured a Fill center");
    expect({1,1,1,1},"Disabled centerless Fill changed ordinary flood behavior");
    const auto enabled=good(amendFill(id,true,1));expect({0,0,0,1},"Enabling centerless completed Fill did not restore its exact original baseline");
    require(enabled.at("toleranceRange")==Json{{"enabled",true},{"radius",1},{"center",nullptr}},"Centerless empty-amendment metadata was not retained");
    good({{"command","endTolerance"},{"sessionId",id}});good({{"command","undo"}});expect({0,0,0,0},"Centerless empty amendment retained its removed click Undo");
    open();const auto surface=adoptMap(3,true);auto connected=color();connected["connected"]=true;connected["mapId"]=surface.at("id");connected["width"]=5;connected["height"]=5;connected["seed"]={2,2};
    const auto value=good(connected);expect({1,1,0,0},"Connected Color did not intersect raw contributor color hits with Range before Combine");
    require(value.at("toleranceMapId")==surface.at("id")&&value.at("toleranceConnected")==true,"Connected Range lost captured map/owner");
}
void fillCapturedInputRefusalsAndLegacy(){
    open();const auto map=adoptMap();const auto initial=fill(map);const auto id=initial.at("sessionId").get<uint64_t>();good(initial);const Snapshot owner;
    auto missing=fill(map,0,true,1,false);require(command(missing).at("ok")==false,"Enabled initial Fill accepted an omitted physical sample radius");owner.unchanged();++refusals;
    for(const auto &physical:std::vector<Json>{0,-1,true,"1",nullptr}) {
        auto request=fill(map,0,false,1);request["sampleRadiusPixels"]=physical;
        require(command(request).at("ok")==false,"Malformed disabled Fill physical sample was accepted");owner.unchanged();++refusals;
    }
    for(const char *key:{"camera","seed","sampleRadiusPixels","mapId","rangeCenter"}) {
        auto request=amendFill(id,true,1);request[key]=key==std::string("mapId")?Json(map.at("id")):Json::array({0,0,0});
        require(command(request).at("ok")==false,"Fill amendment replaced captured click input");owner.unchanged();++refusals;
    }
    good({{"command","endTolerance"},{"sessionId",id}});
    auto legacy=fill(map,0,false,nullptr,false);legacy.erase("rangeEnabled");legacy.erase("rangeRadius");
    const auto accepted=good(legacy);require(accepted.at("toleranceRange")==Json{{"enabled",false},{"radius",nullptr},{"center",nullptr}},"Legacy disabled Fill did not install a centerless completed owner");
    expect({1,1,1,1},"Legacy disabled Fill changed ordinary flood selection");
    const auto legacyId=legacy.at("sessionId").get<uint64_t>();
    const auto range=good(amendFill(legacyId,true,1));expect({1,1,0,0},"Centerless legacy Fill did not restore its pre-click baseline");
    require(range.at("toleranceRange").at("center").is_null(),"Centerless legacy amendment manufactured a frozen center");
    auto omit=amendFill(legacyId,false,nullptr);omit.erase("rangeEnabled");omit.erase("rangeRadius");const auto reset=good(omit);
    require(reset.at("toleranceRange")==Json{{"enabled",false},{"radius",nullptr},{"center",nullptr}},"Legacy Fill amendment did not reset Range absolutely");expect({1,1,1,1},"Disabling legacy centerless Range did not restore its ordinary region");
    open();const auto scopedMap=adoptMap();good({{"command","single"},{"index",2},{"operation",0}});auto clipped=fill(scopedMap,1);clipped["selectionView"]=view(10);good(clipped);expect({0,0,0,0},"Fill Add preserved baseline outside its final captured view");
}
void transactionAndRefusals(){
    open();const auto initial=color();const auto id=initial.at("sessionId").get<uint64_t>();good(initial);const Snapshot before;
    good({{"command","beginTransaction"}});good(amendColor(id,true,2));good({{"command","rollbackTransaction"}});before.unchanged();
    good({{"command","beginTransaction"}});const auto changed=good(amendColor(id,true,2));const auto committed=good({{"command","commitTransaction"}});
    require(committed.at("toleranceRange")==changed.at("toleranceRange"),"Commit normalized or discarded Range metadata");expect({1,1,1,0},"Commit lost Range membership");
    const Snapshot accepted;std::vector<Json> malformed;
    for(const auto *key:{"rangeEnabled","rangeRadius"}){auto request=amendColor(id,true,1);request.erase(key);malformed.push_back(request);}
    for(const auto &radius:std::vector<Json>{0,-1,.1,true,"1",nullptr}){auto request=amendColor(id,true,radius);malformed.push_back(request);}
    auto request=amendColor(id,true,1);request["rangeEnabled"]=1;malformed.push_back(request);
    for(const char *key:{"center","rangeCenter","seed","camera","sampleRadiusPixels"}){auto entry=amendColor(id,true,1);entry[key]=Json::array({0,0,0});malformed.push_back(entry);}
    for(const auto &entry:malformed){require(command(entry).at("ok")==false,"Malformed Range amendment was accepted");accepted.unchanged();++refusals;}
    sv_response::refuseNextSummaryForContracts();require(command(amendColor(id,true,1)).at("ok")==false,"Range reply preparation refusal ignored");accepted.unchanged();++refusals;
    auto replacement=color();sv_response::refuseNextSummaryForContracts();require(command(replacement).at("ok")==false,"New Range owner replaced old owner before reply validation");accepted.unchanged();++refusals;
}
void legacyImmutableInputsAndExplicitRefusals(){
    for(bool isFill:{false,true}) {
        open();const auto map=isFill?adoptMap():Json();const auto initial=isFill?fill(map):color();
        const auto id=initial.at("sessionId").get<uint64_t>();const auto first=good(initial);
        auto legacy=isFill?amendFill(id,false,nullptr):amendColor(id,false,nullptr);legacy.erase("rangeEnabled");legacy.erase("rangeRadius");
        auto replacementCamera=camera();replacementCamera[0]=10;
        legacy["camera"]=replacementCamera;legacy["seed"]={-1,-1};legacy["width"]=0;legacy["height"]=0;
        legacy["index"]=3;legacy["operation"]=2;legacy["selectionView"]=view(10);
        if(isFill){legacy["mapId"]=999999;legacy["visibleOnly"]=true;legacy["overlap"]=true;}
        const auto accepted=good(legacy);expect({1,1,1,1},"Legacy amendment replaced immutable click inputs instead of ignoring them");
        require(accepted.at("toleranceRange")==Json{{"enabled",false},{"radius",nullptr},{"center",first.at("toleranceRange").at("center")}},"Legacy immutable-input amendment changed frozen center or failed its absolute disabled reset");
        const auto ranged=good(isFill?amendFill(id,true,1):amendColor(id,true,1));expect({1,1,0,0},"Legacy ignored replacement inputs corrupted the later Range predicate");
        require(ranged.at("toleranceRange").at("center")==first.at("toleranceRange").at("center"),"Range reenabling recaptured an injected legacy center");
        const Snapshot owner;
        for(const char *key:{"camera","seed","width","height","index","operation","selectionView","sampleRadiusPixels"}) {
            auto request=isFill?amendFill(id,true,1):amendColor(id,true,1);request[key]=legacy.contains(key)?legacy.at(key):Json(1);
            require(command(request).at("ok")==false,"Explicit Range amendment accepted immutable input injection");owner.unchanged();++refusals;
        }
        auto physical=isFill?amendFill(id,false,nullptr):amendColor(id,false,nullptr);physical.erase("rangeEnabled");physical.erase("rangeRadius");physical["sampleRadiusPixels"]=1;
        require(command(physical).at("ok")==false,"Legacy amendment accepted a new physical sample radius");owner.unchanged();++refusals;
    }
}
void allocationAtomicity(){
    open();const auto initial=color();const auto id=initial.at("sessionId").get<uint64_t>();good(initial);const Snapshot before;bool reached=false;
    for(size_t ordinal=1;ordinal<1000;++ordinal){const auto request=amendColor(id,true,2).dump();sv_allocation::failBackendAtForContracts(ordinal);
        const auto *reply=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);const auto value=parsed(reply);
        if(value.at("ok")==true){expect({1,1,1,0},"Allocation sweep successful retry published wrong Range mask");reached=true;break;}
        before.unchanged();++backendRefusals;
    }
    require(reached&&backendRefusals>0,"Range amendment allocation sweep did not reach both refusal and success");
}
void toleranceRecordedActions(){
    require(parsed(sv_build_identity()).at("capabilities").at("selectionActions")==2,"Selection action metadata capability is missing");
    for(bool isFill:{false,true}) {
        open();auto map=isFill?adoptMap():Json();auto initial=isFill?fill(map,2):color(2);auto id=initial.at("sessionId").get<uint64_t>();
        const auto empty=good(initial);require(empty.at("toleranceRecorded")==false,"No-op originating click was recorded");
        const auto metadata=good(isFill?amendFill(id,false,2):amendColor(id,false,2));
        require(metadata.at("toleranceRecorded")==false&&metadata.at("revision")==empty.at("revision")&&!metadata.at("canUndo").get<bool>(),
            "Metadata-only no-op manufactured a recorded click");good({{"command","endTolerance"},{"sessionId",id}});
        require(summary().at("toleranceRecorded").is_null(),"Retired no-op tolerance owner retained recorded scalar");
        open();good({{"command","single"},{"index",3},{"operation",0}});map=isFill?adoptMap():Json();initial=isFill?fill(map,2):color(2);id=initial.at("sessionId").get<uint64_t>();
        require(good(initial).at("toleranceRecorded")==false,"Click that preserved outside-sphere baseline was recorded");
        const Snapshot unrecorded;sv_response::refuseNextSummaryForContracts();
        require(command(isFill?amendFill(id,true,3):amendColor(id,true,3)).at("ok")==false,"Recorded transition ignored response refusal");unrecorded.unchanged();++refusals;
        auto changed=good(isFill?amendFill(id,true,3):amendColor(id,true,3));
        require(changed.at("toleranceRecorded")==true&&mask()==Bytes({0,0,0,0}),"Accepted amendment failed to record its first click history");
        const Snapshot recorded;sv_response::refuseNextSummaryForContracts();
        require(command(isFill?amendFill(id,true,1):amendColor(id,true,1)).at("ok")==false,"Unrecorded transition ignored response refusal");recorded.unchanged();++refusals;
        changed=good(isFill?amendFill(id,true,1):amendColor(id,true,1));
        require(changed.at("toleranceRecorded")==false&&mask()==Bytes({0,0,0,1})&&changed.at("canUndo")==true,
            "Amendment to original baseline failed to remove only its click history");
        good({{"command","beginTransaction"}});require(good(isFill?amendFill(id,true,3):amendColor(id,true,3)).at("toleranceRecorded")==true,"Transaction candidate lost recorded click");
        auto rollback=good({{"command","rollbackTransaction"}});require(rollback.at("toleranceRecorded")==false&&mask()==Bytes({0,0,0,1}),"Rollback failed to restore unrecorded checkpoint metadata");
        good({{"command","beginTransaction"}});good(isFill?amendFill(id,true,3):amendColor(id,true,3));
        require(good({{"command","commitTransaction"}}).at("toleranceRecorded")==true,"Commit normalized recorded checkpoint metadata");
        const auto retained=summary();good({{"command","beginTransaction"}});good({{"command","endTolerance"},{"sessionId",id}});
        good({{"command","beginFilter"},{"kind","sphere"}});const auto restored=good({{"command","rollbackTransaction"}});
        require(restored.at("filter").is_null()&&restored.at("toleranceSessionId")==id&&restored.at("toleranceRecorded")==true&&
            restored.at("toleranceRange")==retained.at("toleranceRange")&&mask()==Bytes({0,0,0,0}),
            "Tool-switch rollback response failed to restore tolerance recorded/Range owner");
        good({{"command","endTolerance"},{"sessionId",id}});require(summary().at("toleranceRecorded").is_null(),"Retired recorded owner retained scalar");
        good({{"command","undo"}});expect({0,0,0,1},"Recorded amendment did not remain one Undo");good({{"command","undo"}});expect({0,0,0,0},"Returning to baseline retained an empty click Undo");
        require(!summary().at("canUndo").get<bool>(),"Tolerance recorded bookkeeping retained extra history");++recordedProofTools;
    }
}
Json focus(){const auto now=summary();return {{"command","transformFocus"},{"scope","selection"},{"revision",now.at("revision")},{"contentRevision",now.at("contentRevision")},{"transformBase",nullptr}};}
void readonlyQueriesAndRecovery(){
    open();good(color());const Snapshot before;auto pending=good({{"command","morphologyRange"}});require(pending.at("pending")==true,"Range statistics did not admit cooperatively");
    require(command(focus()).at("ok")==false&&summary().at("pending")==true,"Competing focus refusal cancelled Range statistics");++refusals;before.unchanged(true,true);
    finish(pending);before.unchanged(false,true);const Snapshot statistics;
    const auto point=finish(good(focus()));require(point.contains("point")&&!point.at("point").is_null(),"Readonly focus lost settled Range owner");statistics.unchanged();
    require(summary().at("toleranceRecorded")==true,"Recovery fixture has no recorded tolerance click");
    const auto oldMask=mask();const auto plan=parsed(sv_recovery_prepare());require(plan.at("ok")==true&&!plan.contains("toleranceRange")&&!plan.contains("toleranceRecorded")&&(plan.at("normalizationFlags").get<unsigned>()&4),"Transient Range/recorded leaked into durable recovery plan");
    Bytes bytes;for(unsigned at=0,total=plan.at("byteLength").get<unsigned>();at<total;){const auto n=std::min(257u,total-at);const auto *p=sv_recovery_read(at,n);require(p&&sv_recovery_read_size()==n,"Range checkpoint read failed");bytes.insert(bytes.end(),p,p+n);at+=n;}sv_recovery_release();
    const Json expected{{"codecVersion",3},{"currentLoadedCount",plan.at("currentLoadedCount")},{"currentSourceCount",plan.at("currentSourceCount")},{"currentDuplicateRange",plan.at("currentDuplicateRange")},
        {"maximumGraphSplats",plan.at("maximumGraphSplats")},{"originalSourceCount",4},{"revision",plan.at("revision")},{"contentRevision",plan.at("contentRevision")},{"nextContentRevision",plan.at("nextContentRevision")}};
    const auto text=expected.dump();require(parsed(sv_recovery_restore_begin(unsigned(bytes.size()),expected.at("maximumGraphSplats").get<unsigned>(),allowance,text.c_str())).at("ok")==true,"Range recovery begin failed");
    require(parsed(sv_recovery_restore_write(0,bytes.data(),unsigned(bytes.size()))).at("ok")==true,"Range recovery write failed");const auto result=parsed(sv_recovery_restore_finish());
    require(result.at("ok")==true&&result.at("toleranceRange").is_null()&&result.at("toleranceRecorded").is_null()&&result.at("toleranceSessionId").is_null()&&mask()==oldMask,"Fresh recovery retained transient Range/recorded or lost selection");
}
}
int main(){try{
    test("literal-color-combine-deleted-view",literalColorOperations);
    test("absolute-color-metadata-one-undo-redo",absoluteColorHistoryAndNoop);
    test("fill-hit-range-combine-frozen-surface",fillOperationsAndFrozenSurface);
    test("centerless-fill-connected-color",centerlessFillAndConnectedColor);
    test("fill-frozen-input-refusals-legacy-view",fillCapturedInputRefusalsAndLegacy);
    test("transaction-shapes-publication-atomicity",transactionAndRefusals);
    test("legacy-ignored-inputs-explicit-range-refusals",legacyImmutableInputsAndExplicitRefusals);
    test("allocation-refusal-retry",allocationAtomicity);
    test("tolerance-recorded-actions-history-refusal",toleranceRecordedActions);
    test("readonly-statistics-focus-transient-recovery",readonlyQueriesAndRecovery);
    std::printf("SPLATVIEW_TOLERANCE_RECORDED_CONTRACTS_PASS tools=%zu checks=%zu\n",recordedProofTools,checks);
    std::printf("SPLATVIEW_SELECTION_RANGE_CONTRACTS_PASS groups=%zu checks=%zu refusals=%zu backendRefusals=%zu\n",groups,checks,refusals,backendRefusals);return 0;
}catch(const std::exception &error){sv_allocation::failBackendAtForContracts(0);sv_recovery_release();sv_recovery_restore_cancel();std::fprintf(stderr,"Selection Range contracts failed groups=%zu checks=%zu: %s\n",groups,checks,error.what());return 1;}}
