// Main-only contracts. These allocation observers and fixtures are linked only
// into the contract executable; no fault/observation API is exported or shipped.
#include "response.hpp"
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "model.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace new_observation {
bool active{};
std::size_t attempts{};
void observe(const sv_allocation::Event &event) noexcept {
    if(active && event.kind==sv_allocation::EventKind::NewAttempt) ++attempts;
}
}

extern "C" {
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_live_preview(const char *);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const std::uint8_t *sv_states_ptr();
const std::uint8_t *sv_output_ptr();
unsigned sv_output_len();
}

namespace {
using Json=nlohmann::json;
using sv_response::Responses;
using sv_response::Summary;
using Bytes=std::vector<std::uint8_t>;
std::size_t cases{},assertions{},noNewObservations{},observedNewCalls{},repeatedRefusals{};
constexpr unsigned sceneBudget=32*1024*1024;

void require(bool condition,const char *message) {
    ++assertions;
    if(!condition) throw std::runtime_error(message);
}
template<class Action> void test(Action action) { action(); ++cases; }
struct Observation {
    bool previous=new_observation::active;
    std::size_t before=new_observation::attempts;
    bool stopped{};
    Observation() noexcept { new_observation::active=true; }
    void stop() noexcept { if(!stopped) { new_observation::active=previous; stopped=true; } }
    ~Observation() { stop(); }
};
template<class Action> auto noNew(Action action) {
    Observation observation;
    auto result=action();
    observation.stop();
    const auto attempts=new_observation::attempts-observation.before;
    ++noNewObservations; observedNewCalls+=attempts;
    require(!attempts,"An allocation-free response boundary called operator new");
    return result;
}
Json parse(std::string_view text) { return Json::parse(text.begin(),text.end()); }
Json parse(const char *text) { return Json::parse(text); }

constexpr auto gaussianLiteral=R"({"ok":true,"loaded":true,"count":3,"sourceCount":7,"sourceFaces":2,"duplicateRange":null,"sampledGeometry":false,"geometry":null,"shDegree":2,"format":"SOG v1","kind":0,"selected":2,"visible":3,"canUndo":true,"canRedo":true,"transaction":false,"selectionDraft":true,"toleranceSessionId":null,"filter":null,"transformSession":null,"opacitySession":null,"toleranceTool":null,"toleranceConnected":null,"toleranceRange":null,"toleranceRecorded":null,"toleranceMapId":null,"selectionMapId":null,"pendingSelectionMapId":null,"selectionMapBytes":0,"selectionMapRetainedIds":[],"sceneChanged":false,"revision":17,"contentRevision":9,"selectionCommitRevision":0,"undoSelectionRevision":0,"pending":false,"progress":1.0,"center":[1.25,-2.5,3.75],"radius":4.5,"yUp":true,"camera":[1,2,3,0.25,-0.5,7,4,60,1,0.125,1],"memoryBytes":12345,"exportBytes":0,"exportOutputBytes":0,"colorSession":null,"alignment":null,"floor":null,"morphologyRange":null})";
constexpr auto unloadedLiteral=R"({"ok":true,"loaded":false,"kind":0,"count":0,"sourceCount":0,"selectionCommitRevision":0,"undoSelectionRevision":0,"duplicateRange":null,"memoryBytes":0,"toleranceSessionId":null,"toleranceTool":null,"toleranceConnected":null,"toleranceRange":null,"toleranceRecorded":null,"toleranceMapId":null,"selectionMapId":null,"selectionMapBytes":0,"pendingSelectionMapId":null,"selectionMapRetainedIds":[],"exportBytes":0,"exportOutputBytes":0,"floor":null,"filter":null,"transformSession":null,"opacitySession":null,"morphologyRange":null})";
Summary gaussian() {
    Summary s; s.loaded=true; s.count=3; s.sourceCount=7; s.sourceFaces=2;
    s.shDegree=2; s.format="SOG v1"; s.selected=2; s.visible=3;
    s.canUndo=true; s.canRedo=true; s.selectionDraft=true; s.revision=17; s.contentRevision=9;
    s.center={1.25,-2.5,3.75}; s.radius=4.5; s.yUp=true;
    s.camera={1,2,3,0.25,-0.5,7,4,60,1,0.125,1}; s.memoryBytes=12345;
    return s;
}
template<class Build> Json publish(Responses &responses,Build build) {
    const std::string before=responses.current();
    auto preparation=noNew([&]{return responses.begin();});
    require(noNew([&]{return build(preparation);}),"A representable typed response was refused");
    const std::string candidate(preparation.view());
    require(!candidate.empty() && responses.current()==before,"Preparation changed the published response");
    const auto pointer=noNew([&]{return responses.publish(preparation);});
    require(pointer==responses.current() && std::string_view(pointer)==candidate,
            "Publication did not install the complete prepared bytes");
    return parse(pointer); // Independent parser runs after observation ends.
}
Json summary(Responses &responses,const Summary &value) {
    return publish(responses,[&](auto &preparation){return responses.summary(preparation,value);});
}
template<class Build> void refuses(Responses &responses,Build build) {
    const auto pointer=responses.current(); const std::string before(pointer);
    auto preparation=noNew([&]{return responses.begin();});
    require(!noNew([&]{return build(preparation);}),"Invalid bounded response was accepted");
    require(responses.current()==pointer && std::string_view(pointer)==before,
            "A refused builder changed previously published bytes");
    const auto failure=noNew([&]{return responses.publish(preparation);});
    require(parse(failure).at("ok")==false && responses.current()==pointer && std::string_view(pointer)==before,
            "A refused preparation published partial or stale bytes");
}

void typedSchemas() {
    test([] {
        Responses responses;
        for(uint64_t stamp:{uint64_t(0),uint64_t(7),uint64_t(17),uint64_t(9007199254740991ULL)}) {
            auto value=gaussian();if(stamp>value.revision)value.revision=stamp;value.undoSelectionRevision=stamp;
            auto expected=parse(gaussianLiteral);expected["revision"]=value.revision;expected["undoSelectionRevision"]=stamp;
            require(summary(responses,value)==expected,"Undo selection creation stamp differs from independent exact schema");
            auto point=expected;point["point"]=nullptr;
            require(publish(responses,[&](auto &p){return responses.point(p,value,std::nullopt);})==point,"Readonly point wrapper lost Undo selection stamp");
        }
        for(unsigned invalid=0;invalid<5;++invalid) {
            auto value=gaussian();value.undoSelectionRevision=1;
            if(invalid==0)value.undoSelectionRevision=9007199254740992ULL;
            else if(invalid==1)value.revision=0;
            else if(invalid==2)value.canUndo=false;
            else if(invalid==3)value.kind=1;
            else value.loaded=false;
            refuses(responses,[&](auto &p){return responses.summary(p,value);});
            refuses(responses,[&](auto &p){return responses.point(p,value,std::nullopt);});
            refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
        }
        auto restored=gaussian();restored.undoSelectionRevision=0;
        require(summary(responses,restored).at("canUndo")==true,"Neutral recovered stamp incorrectly removed existing Undo history");
    });
    test([] {
        Responses responses;auto value=gaussian();value.selectionDraft=false;
        value.filter=sv_response::Filter{23,0,"sphere",{},false};
        auto expected=parse(gaussianLiteral);expected["selectionDraft"]=false;
        expected["filter"]={{"id",23},{"epoch",0},{"kind","sphere"},{"previewEpoch",nullptr},{"changed",false}};
        require(summary(responses,value)==expected,"Begin filter omitted authoritative false changed metadata");
        value.filter->epoch=1;value.filter->previewEpoch=1;value.filter->changed=true;
        expected["filter"]["epoch"]=1;expected["filter"]["previewEpoch"]=1;expected["filter"]["changed"]=true;
        require(summary(responses,value)==expected,"Changed filter response differs from independent exact schema");
        auto point=expected;point["point"]=nullptr;
        require(publish(responses,[&](auto &p){return responses.point(p,value,std::nullopt);})==point,
            "Readonly point wrapper lost filter changed metadata");
        require(publish(responses,[&](auto &p){return responses.livePublished(p,value);})==
            Json{{"ok",true},{"kind","published"},{"version",1},{"summary",expected}},"Live wrapper lost filter changed metadata");
        value.filter->previewEpoch.reset();
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        refuses(responses,[&](auto &p){return responses.point(p,value,std::nullopt);});
        refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
        value.filter->changed=false;expected["filter"]["changed"]=false;expected["filter"]["previewEpoch"]=nullptr;
        require(summary(responses,value)==expected,"Unpublished pending filter could not retain false changed metadata");
    });
    test([] {
        Responses responses;auto value=gaussian();value.selectionDraft=false;
        value.toleranceSessionId=23;value.toleranceTool=sv_response::ToleranceTool::Color;value.toleranceConnected=false;
        value.toleranceRecorded=false;value.toleranceRange=sv_response::ToleranceRange{false,{},std::array<double,3>{1,2,3}};
        auto expected=parse(gaussianLiteral);expected["selectionDraft"]=false;expected["toleranceSessionId"]=23;
        expected["toleranceTool"]="color";expected["toleranceConnected"]=false;
        expected["toleranceRange"]={{"enabled",false},{"radius",nullptr},{"center",{1,2,3}}};
        expected["toleranceRecorded"]=false;
        require(summary(responses,value)==expected,"Legacy Color Range metadata differs from independent schema");
        value.toleranceRange->enabled=true;value.toleranceRange->radius=double(.4f);
        expected["toleranceRange"]["enabled"]=true;expected["toleranceRange"]["radius"]=double(.4f);
        require(summary(responses,value)==expected,"Configured Color Range metadata differs from independent schema");
        value.toleranceTool=sv_response::ToleranceTool::Fill;value.toleranceConnected.reset();value.toleranceRange->center.reset();
        expected["toleranceTool"]="fill";expected["toleranceConnected"]=nullptr;expected["toleranceRange"]["center"]=nullptr;
        require(summary(responses,value)==expected,"Centerless enabled Fill empty-amendment metadata was refused");
        value.toleranceRange->radius=double(std::numeric_limits<float>::max());expected["toleranceRange"]["radius"]=double(std::numeric_limits<float>::max());
        require(summary(responses,value)==expected,"Finite float32 Range radius received an extra domain cap");
        value.toleranceRecorded=true;expected["toleranceRecorded"]=true;
        require(summary(responses,value)==expected,"Recorded tolerance scalar was not preserved alongside Range metadata");
        auto noOwner=gaussian();noOwner.toleranceRecorded=false;
        refuses(responses,[&](auto &p){return responses.summary(p,noOwner);});
        auto absentRecorded=value;absentRecorded.toleranceRecorded.reset();
        refuses(responses,[&](auto &p){return responses.summary(p,absentRecorded);});
        refuses(responses,[&](auto &p){return responses.point(p,absentRecorded,std::nullopt);});
        refuses(responses,[&](auto &p){return responses.livePublished(p,absentRecorded);});
        for(unsigned invalid=0;invalid<13;++invalid) {
            auto bad=value;
            if(invalid==0)bad.toleranceSessionId.reset();
            else if(invalid==1)bad.toleranceRange.reset();
            else if(invalid==2)bad.toleranceRange->radius.reset();
            else if(invalid==3)bad.toleranceRange->radius=0;
            else if(invalid==4)bad.toleranceRange->radius=-1;
            else if(invalid==5)bad.toleranceRange->radius=std::numeric_limits<double>::infinity();
            else if(invalid==6)bad.toleranceRange->radius=.1;
            else if(invalid==7)bad.toleranceRange->center=std::array<double,3>{0,std::numeric_limits<double>::quiet_NaN(),0};
            else if(invalid==8){bad.toleranceTool=sv_response::ToleranceTool::Color;bad.toleranceConnected=false;}
            else if(invalid==9)bad.toleranceConnected=false;
            else if(invalid==10)bad.loaded=false;
            else if(invalid==11)bad.kind=1;
            else bad.selectionDraft=true;
            refuses(responses,[&](auto &p){return responses.summary(p,bad);});
            refuses(responses,[&](auto &p){return responses.point(p,bad,std::nullopt);});
            refuses(responses,[&](auto &p){return responses.livePublished(p,bad);});
        }
    });
    test([] {
        Responses responses;
        for(const auto counter:std::array<uint64_t,3>{0,7,9007199254740991ULL}) {
            auto value=gaussian();value.selectionCommitRevision=counter;
            auto expected=parse(gaussianLiteral);expected["selectionCommitRevision"]=counter;
            require(summary(responses,value)==expected,"Committed-selection scalar differs from independent literal");
            auto pointExpected=expected;pointExpected["point"]={1,2,3};
            require(publish(responses,[&](auto &p){return responses.point(p,value,sv_response::Point{1,2,3});})==pointExpected,
                "Point wrapper lost committed-selection scalar");
            require(publish(responses,[&](auto &p){return responses.livePublished(p,value);})==
                Json{{"ok",true},{"kind","published"},{"version",1},{"summary",expected}},
                "Live wrapper lost committed-selection scalar");
        }
        for(unsigned invalid=0;invalid<3;++invalid) {
            auto value=gaussian();value.selectionCommitRevision=9007199254740992ULL;
            if(invalid==1) {value=Summary{};value.selectionCommitRevision=1;}
            else if(invalid==2) {value=gaussian();value.kind=1;value.selectionCommitRevision=1;}
            refuses(responses,[&](auto &p){return responses.summary(p,value);});
            refuses(responses,[&](auto &p){return responses.point(p,value,std::nullopt);});
            refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
        }
    });
    test([] {
        Responses responses;auto value=gaussian();value.duplicateRange=sv_response::DuplicateRange{1,2};
        auto expected=parse(gaussianLiteral);expected["duplicateRange"]={{"first",1},{"count",2}};
        require(summary(responses,value)==expected,"Duplicate suffix differs from independent schema");
        for(const auto range:std::array<sv_response::DuplicateRange,4>{{{0,0},{0,1},{4,1},{3,1}}}) {
            value.duplicateRange=range;refuses(responses,[&](auto &p){return responses.summary(p,value);});
        }
        value.duplicateRange=sv_response::DuplicateRange{1,2};value.kind=1;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});value.kind=0;value.loaded=false;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
    });
    test([] {
        Responses responses;auto value=gaussian();
        value.morphologyRange=sv_response::MorphologyRange{1,18,double(float(std::sqrt(18.)))};
        auto expected=parse(gaussianLiteral);expected["morphologyRange"]={{"version",1},{"minimum",1},{"maximum",18},{"default",double(float(std::sqrt(18.)))}};
        require(summary(responses,value)==expected,"Morphology range metadata differs from independent schema");
        for(const auto invalid:{sv_response::MorphologyRange{0,1,1},sv_response::MorphologyRange{1,1,1},
            sv_response::MorphologyRange{1,18,4},sv_response::MorphologyRange{1,std::numeric_limits<double>::infinity(),1}}) {
            value.morphologyRange=invalid;refuses(responses,[&](auto &p){return responses.summary(p,value);});
        }
        value.morphologyRange=sv_response::MorphologyRange{1,2,double(float(std::sqrt(2.)))};value.kind=1;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.loaded=false;refuses(responses,[&](auto &p){return responses.summary(p,value);});
    });
    test([] {
        Responses responses;auto value=gaussian();
        sv_response::Alignment alignment;
        alignment.frame={1,0,0,0,0,1,0,0,0,0,1,0,-2,3,-4,1};
        alignment.branchId=9007199254740991ULL;alignment.canReset=true;
        alignment.retainedBranchIds[0]=alignment.branchId;alignment.retainedBranchCount=1;value.alignment=alignment;
        auto expected=parse(gaussianLiteral);
        expected["alignment"]={{"version",2},{"frame",alignment.frame},{"branchId",alignment.branchId},{"canReset",true},{"retainedBranchIds",std::array<uint64_t,1>{alignment.branchId}}};
        require(summary(responses,value)==expected,"Alignment metadata differs from independent schema");
        value.alignment->branchId=9007199254740992ULL;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.alignment=alignment;value.alignment->frame[3]=std::numeric_limits<double>::infinity();
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.alignment=alignment;value.kind=1;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value=gaussian();value.alignment=alignment;
        value.alignment->retainedBranchCount=64;
        for(size_t i=0;i<64;++i) value.alignment->retainedBranchIds[i]=alignment.branchId-63+i;
        const std::string maximumFormat(sv_response::formatByteLimit,char(1));value.format=maximumFormat;
        value.alignment->frame.fill(std::numeric_limits<double>::lowest());
        sv_response::ColorSession color; color.sessionId=color.baseId=color.epochId=9007199254740991ULL;
        color.values.fill(std::numeric_limits<double>::max());color.applied=color.values;value.colorSession=color;
        value.camera.fill(std::numeric_limits<double>::lowest());value.center.fill(std::numeric_limits<double>::lowest());
        value.selectionMapRetainedCount=5;value.selectionMapRetainedIds.fill(UINT64_MAX);
        value.selectionCommitRevision=9007199254740991ULL;
        value.count=50000;
        sv_response::Floor floor;floor.id=9007199254740991ULL;floor.status=sv_response::FloorStatus::Ready;
        floor.stage=sv_response::FloorStage::Complete;floor.selectedOnly=true;
        floor.plane=sv_response::FloorPlane{{1,double(std::numeric_limits<float>::denorm_min()),0},
            {double(std::numeric_limits<float>::lowest()),double(std::numeric_limits<float>::max()),-0.0},
            double(std::numeric_limits<float>::max()),double(std::numeric_limits<float>::max()),50000,50000};
        value.floor=floor;
        value.morphologyRange=sv_response::MorphologyRange{double(1e12f),double(2*1e12f),double(float(std::sqrt(double(1e12f)*double(2*1e12f))))};
        value.selectionDraft=false;
        value.filter=sv_response::Filter{9007199254740991ULL,9007199254740991ULL,"ellipsoid",9007199254740991ULL,true};
        const auto actual=summary(responses,value);
        require(actual["alignment"]["frame"]==value.alignment->frame && actual["format"]==maximumFormat,
            "Maximum finite alignment/color/format response did not fit fixed storage");
        require(actual["alignment"]["retainedBranchIds"].size()==64,"Maximum retained branch response was truncated");
        require(actual.at("selectionCommitRevision")==9007199254740991ULL,"Maximum committed-selection scalar was truncated");
        require(actual["filter"]==Json{{"id",9007199254740991ULL},{"kind","ellipsoid"},{"epoch",9007199254740991ULL},{"previewEpoch",9007199254740991ULL},{"changed",true}},
            "Maximum filter identity/epoch response was truncated");
        require(actual["floor"]["plane"]["tested"]==50000 && actual["floor"]["id"]==floor.id,
            "Maximum finite Floor/alignment/color/format response was truncated");
        require(publish(responses,[&](auto &p){return responses.point(p,value,sv_response::Point{
            std::numeric_limits<double>::lowest(),std::numeric_limits<double>::max(),std::numeric_limits<double>::lowest()});})["floor"]==actual["floor"],
            "Maximum finite Floor point wrapper did not fit fixed storage");
        value.alignment->retainedBranchIds[1]=value.alignment->retainedBranchIds[0];
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.alignment=alignment;value.alignment->retainedBranchCount=0;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.alignment=alignment;value.alignment->retainedBranchIds[0]=0;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
    });
    test([] {
        Responses responses;auto value=gaussian();value.pending=true;
        sv_response::Floor floor;floor.id=17;floor.selectedOnly=true;floor.stage=sv_response::FloorStage::Threshold;value.floor=floor;
        require(summary(responses,value)["floor"]==Json{{"version",1},{"id",17},{"status","pending"},
            {"stage","threshold"},{"selectedOnly",true},{"plane",nullptr}},"Pending Floor schema differs");
        value.pending=false;refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.floor->status=sv_response::FloorStatus::None;value.floor->stage=sv_response::FloorStage::Complete;
        require(summary(responses,value)["floor"]["status"]=="none","Completed none Floor schema differs");
        value.floor->status=sv_response::FloorStatus::Ready;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value.floor->plane=sv_response::FloorPlane{{0,1,0},{0,0,0},1,0,3,3};
        require(summary(responses,value)["floor"]["plane"]["normal"]==Json::array({0,1,0}),"Ready Floor schema differs");
        for(unsigned invalid=0;invalid<6;++invalid) {
            auto broken=value;
            switch(invalid) {
            case 0:broken.floor->id=0;break;
            case 1:broken.floor->id=9007199254740992ULL;break;
            case 2:broken.floor->plane->normal={0,2,0};break;
            case 3:broken.floor->plane->center[0]=std::numeric_limits<double>::max();break;
            case 4:broken.floor->plane->tested=4;break;
            case 5:broken.kind=1;break;
            }
            refuses(responses,[&](auto &p){return responses.summary(p,broken);});
        }
        value.floor.reset();value.geometry=sv_response::GeometryDescriptor{};
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
    });
    test([] {
        Responses responses;
        require(summary(responses,gaussian())==parse(gaussianLiteral),"Full Gaussian schema differs from independent literal");
        Summary empty;
        require(summary(responses,empty)==parse(unloadedLiteral),"Full unloaded schema differs from independent literal");
    });
    test([] {
        Responses responses;auto value=gaussian();value.exportBytes=4096;value.exportOutputBytes=1024;
        auto expected=parse(gaussianLiteral);expected["exportBytes"]=4096;expected["exportOutputBytes"]=1024;
        require(summary(responses,value)==expected,"Export work/output accounting scalars differ from independent values");
        require(publish(responses,[&](auto &p){return responses.livePublished(p,value);})==
                Json{{"ok",true},{"kind","published"},{"version",1},{"summary",expected}},
                "Live wrapper lost retained export accounting");
    });
    for(unsigned invalid=0;invalid<4;++invalid) test([=] {
        Responses responses;summary(responses,gaussian());auto value=gaussian();value.memoryBytes=4096;
        if(invalid==0) value.exportBytes=4097;
        else if(invalid==1) {value.exportBytes=1024;value.exportOutputBytes=1025;}
        else if(invalid==2) value.exportOutputBytes=1;
        else {value=Summary{};value.memoryBytes=4096;value.exportBytes=1;}
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        refuses(responses,[&](auto &p){return responses.point(p,value,std::nullopt);});
        refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
    });
    test([] {
        Responses responses; auto value=gaussian(); value.kind=2; value.shDegree=0; value.format="PLY mesh";
        value.selected=0; value.canUndo=false; value.canRedo=false; value.selectionDraft=false;
        value.geometry=sv_response::GeometryDescriptor{1,2,16,4,3,2,48,24,0,0};
        auto expected=parse(gaussianLiteral);
        expected["kind"]=2; expected["shDegree"]=0; expected["format"]="PLY mesh"; expected["selected"]=0;
        expected["canUndo"]=false; expected["canRedo"]=false; expected["selectionDraft"]=false;
        expected["geometry"]=parse(R"({"layoutVersion":1,"kind":2,"vertexStride":16,"indexStride":4,"vertexCount":3,"triangleCount":2,"vertexBytes":48,"indexBytes":24,"revision":0,"contentRevision":0})");
        require(summary(responses,value)==expected,"Full geometry descriptor/schema differs from independent literal");
    });
    test([] {
        Responses responses; auto value=gaussian();
        value.selectionMapRetainedIds={11,23,37,41,59}; value.selectionMapRetainedCount=5;
        value.selectionMapBytes=640; value.selectionMapId=11; value.pendingSelectionMapId=23;
        value.toleranceSessionId=101; value.toleranceMapId=59; value.toleranceTool=sv_response::ToleranceTool::Color;
        value.toleranceConnected=false; value.transaction=true; value.sceneChanged=true; value.pending=true; value.progress=0.25;
        value.toleranceRecorded=false;value.toleranceRange=sv_response::ToleranceRange{false,{},std::array<double,3>{1,2,3}};
        value.selectionDraft=false;
        auto expected=parse(gaussianLiteral);
        expected["selectionDraft"]=false;
        expected["selectionMapRetainedIds"]={11,23,37,41,59}; expected["selectionMapBytes"]=640;
        expected["selectionMapId"]=11; expected["pendingSelectionMapId"]=23; expected["toleranceSessionId"]=101;
        expected["toleranceMapId"]=59; expected["toleranceTool"]="color"; expected["toleranceConnected"]=false;
        expected["toleranceRange"]={{"enabled",false},{"radius",nullptr},{"center",{1,2,3}}};
        expected["toleranceRecorded"]=false;
        expected["transaction"]=true; expected["sceneChanged"]=true; expected["pending"]=true; expected["progress"]=0.25;
        require(summary(responses,value)==expected,"All retained map/tolerance fields differ from independent expected values");
        require(publish(responses,[&](auto &p){return responses.livePublished(p,value);})==
                Json{{"ok",true},{"kind","published"},{"version",1},{"summary",expected}},"Published live wrapper changed");
        value.toleranceTool=sv_response::ToleranceTool::Fill; value.toleranceConnected.reset();
        expected["toleranceTool"]="fill"; expected["toleranceConnected"]=nullptr;
        require(summary(responses,value)==expected,"Fill/null connected fields changed");
    });
    test([] {
        Responses responses; const auto value=gaussian(); auto expected=parse(gaussianLiteral);
        expected["point"]={0.5,-1.25,2};
        require(publish(responses,[&](auto &p){return responses.point(p,value,sv_response::Point{0.5,-1.25,2});})==expected,
                "Point response differs from independent coordinates/schema");
        expected["point"]=nullptr;
        require(publish(responses,[&](auto &p){return responses.point(p,value,std::nullopt);})==expected,"Missing point is not null");
        require(publish(responses,[&](auto &p){return responses.computationFailed(p);})==
                parse(R"({"ok":true,"kind":"computation-failed","version":1})"),"Computation failure wrapper changed");
    });
}

void stringsAndNumbers() {
    test([] {
        Responses responses; auto value=gaussian();
        std::string text; for(unsigned i=0;i<32;++i) text.push_back(char(i));
        text+="\"\\/ "; text+="\xc2\xa2\xe2\x82\xac\xf0\x9f\x9a\x80\xf4\x8f\xbf\xbf";
        value.format={text.data(),text.size()};
        auto expected=parse(gaussianLiteral); expected["format"]=text;
        require(summary(responses,value)==expected,"Controls/NUL/quotes/backslash or valid UTF-8 did not round-trip");
        const std::string escapedError="quote\" slash\\ newline\n \xc2\xa2\xe2\x82\xac\xf0\x9f\x9a\x80";
        require(publish(responses,[&](auto &p){return responses.error(p,escapedError.c_str());})==
                Json{{"ok",false},{"error",escapedError}},"Escaped UTF-8 error schema changed");
    });
    test([] {
        Responses responses; auto value=gaussian();
        const std::string maximumFormat(sv_response::formatByteLimit,char(1)); value.format=maximumFormat;
        require(summary(responses,value).at("format")==maximumFormat,"Exact maximum expanded format was refused/truncated");
        const std::string maximumError(sv_response::errorByteLimit,char(1));
        require(publish(responses,[&](auto &p){return responses.error(p,maximumError.c_str());}).at("error")==maximumError,
                "Exact maximum expanded error was refused/truncated");
        const std::string tooLongFormat(sv_response::formatByteLimit+1,'x'); value.format=tooLongFormat;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        const std::string tooLongError(sv_response::errorByteLimit+1,'x');
        refuses(responses,[&](auto &p){return responses.error(p,tooLongError.c_str());});
        value=gaussian(); value.selectionMapRetainedCount=6;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        value=gaussian(); value.toleranceTool=static_cast<sv_response::ToleranceTool>(3);
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
    });
    test([] {
        Responses responses; require(summary(responses,gaussian())==parse(gaussianLiteral),"UTF-8 refusal baseline failed");
        for(const auto invalid:{"\x80","\xc0\xaf","\xe0\x80\xaf","\xed\xa0\x80","\xf4\x90\x80\x80","\xe2\x82","\xf0\x9f\x9a"}) {
            auto value=gaussian(); value.format=invalid;
            refuses(responses,[&](auto &p){return responses.summary(p,value);});
            refuses(responses,[&](auto &p){return responses.error(p,invalid);});
        }
    });
    test([] {
        Responses responses; auto value=gaussian();
        value.count=std::numeric_limits<std::size_t>::max(); value.sourceCount=UINT64_MAX; value.sourceFaces=UINT64_MAX;
        value.memoryBytes=value.exportBytes=value.exportOutputBytes=std::numeric_limits<std::size_t>::max();
        value.revision=UINT64_MAX; value.contentRevision=UINT64_MAX; value.toleranceSessionId=UINT64_MAX;
        value.toleranceTool=sv_response::ToleranceTool::Color;value.toleranceConnected=false;
        value.toleranceRecorded=false;value.toleranceRange=sv_response::ToleranceRange{false,{},std::array<double,3>{1,2,3}};
        value.selectionDraft=false;
        value.selectionCommitRevision=9007199254740991ULL;
        value.progress=std::numeric_limits<double>::max(); value.radius=std::numeric_limits<double>::lowest();
        value.center={std::numeric_limits<double>::denorm_min(),std::numeric_limits<double>::min(),-0.0};
        value.camera={std::nextafter(1.,2.),-std::numeric_limits<double>::min(),0.125,-0.0,
            std::numeric_limits<double>::infinity(),std::numeric_limits<double>::quiet_NaN(),
            -std::numeric_limits<double>::infinity(),42.5,1,0,1};
        const auto actual=summary(responses,value);
        require(actual.at("count")==Json::parse("4294967295") && actual.at("sourceCount")==Json::parse("18446744073709551615") &&
                actual.at("sourceFaces")==Json::parse("18446744073709551615") && actual.at("revision")==Json::parse("18446744073709551615") &&
                actual.at("contentRevision")==Json::parse("18446744073709551615") && actual.at("toleranceSessionId")==Json::parse("18446744073709551615") &&
                actual.at("selectionCommitRevision")==Json::parse("9007199254740991"),
                "Maximum unsigned scalar output lost precision");
        require(actual.at("memoryBytes")==Json::parse("4294967295") && actual.at("exportBytes")==Json::parse("4294967295") &&
                actual.at("exportOutputBytes")==Json::parse("4294967295"),"Maximum export accounting scalars lost unsigned precision");
        require(actual.at("progress").get<double>()==std::numeric_limits<double>::max() &&
                actual.at("radius").get<double>()==std::numeric_limits<double>::lowest() &&
                actual.at("center")[0].get<double>()==std::numeric_limits<double>::denorm_min() &&
                actual.at("center")[1].get<double>()==std::numeric_limits<double>::min() &&
                actual.at("camera")[0].get<double>()==std::nextafter(1.,2.),"Finite extreme numbers did not round-trip exactly");
        require(std::signbit(actual.at("center")[2].get<double>()) && std::signbit(actual.at("camera")[3].get<double>()),
                "Negative floating zero lost its sign");
        require(actual.at("camera")[4].is_null() && actual.at("camera")[5].is_null() && actual.at("camera")[6].is_null(),
                "Nonfinite summary values must retain JSON null behavior");
        require(publish(responses,[&](auto &p){return responses.point(p,gaussian(),sv_response::Point{
                    std::numeric_limits<double>::infinity(),0,std::numeric_limits<double>::quiet_NaN()});}).at("point")==
                parse("[null,0,null]"),"Nonfinite point values changed JSON null behavior");
    });
}

void transformSchemas() {
    test([] {
        Responses responses;auto value=gaussian();value.selectionDraft=false;
        sv_response::TransformSession transform;transform.id=11;transform.baseId=12;transform.kind="numeric";
        transform.appliedMatrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};transform.pivot={1,2,3};value.transformSession=transform;
        const auto expected=parse(R"({"id":11,"baseId":12,"epoch":0,"appliedEpoch":null,"kind":"numeric","selectedOnly":false,"appliedMatrix":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"pivot":[1,2,3],"gizmo":null})");
        require(summary(responses,value).at("transformSession")==expected,"Transform record differs from exact nine-field literal");
        value.transformSession->epoch=9007199254740991ULL;value.transformSession->appliedEpoch=9007199254740991ULL;
        value.transformSession->kind="gizmo";value.transformSession->selectedOnly=true;
        value.transformSession->gizmo=sv_response::GizmoSession{9007199254740991ULL,9007199254740991ULL,true,true};
        for(size_t i=0;i<15;++i)if(i!=3&&i!=7&&i!=11)value.transformSession->appliedMatrix[i]=std::numeric_limits<float>::max();
        const std::string expanded(sv_response::formatByteLimit,char(1));value.format=expanded;
        const auto result=summary(responses,value);require(result.at("format")==expanded&&result.at("transformSession").at("appliedEpoch")==9007199254740991ULL,
            "Worst bounded transform response was truncated/refused");
    });
    test([] {
        Responses responses;auto value=gaussian();value.selectionDraft=false;
        sv_response::TransformSession transform;transform.id=11;transform.baseId=12;transform.kind="gizmo";
        transform.appliedMatrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};transform.gizmo.emplace();value.transformSession=transform;
        const auto initial=summary(responses,value).at("transformSession");
        require(initial.at("gizmo")==Json{{"cancelBaseId",nullptr},{"cancelContentRevision",nullptr},{"canUndo",false},{"canRedo",false}},
            "Initial gizmo Cancel/eligibility metadata differs from independent schema");
        value.transformSession->gizmo=sv_response::GizmoSession{12,0,true,true};
        require(summary(responses,value).at("transformSession").at("gizmo")==Json{{"cancelBaseId",12},{"cancelContentRevision",0},{"canUndo",true},{"canRedo",true}},
            "Captured gizmo baseline/zero content identity differs from exact schema");
        for(unsigned invalid=0;invalid<10;++invalid) {
            auto bad=value;auto &g=*bad.transformSession->gizmo;
            if(invalid==0)bad.transformSession->gizmo.reset();
            else if(invalid==1)bad.transformSession->kind="numeric";
            else if(invalid==2)g.cancelBaseId.reset();
            else if(invalid==3)g.cancelContentRevision.reset();
            else if(invalid==4)g.cancelBaseId=0;
            else if(invalid==5)g.cancelBaseId=9007199254740992ULL;
            else if(invalid==6)g.cancelContentRevision=9007199254740992ULL;
            else if(invalid==7){g.cancelBaseId.reset();g.cancelContentRevision.reset();}
            else if(invalid==8)bad.canUndo=false;
            else bad.canRedo=false;
            refuses(responses,[&](auto &p){return responses.summary(p,bad);});
            refuses(responses,[&](auto &p){return responses.point(p,bad,std::nullopt);});
        }
        value.pending=true;
        require(summary(responses,value).at("transformSession").at("gizmo").at("canUndo")==true,
            "Readonly-query pending summary cannot preserve settled gizmo eligibility");
        value.transformSession->gizmo->canUndo=value.transformSession->gizmo->canRedo=false;
        require(summary(responses,value).at("transformSession").at("gizmo").at("cancelContentRevision")==0,
            "Pending work lost retained original Cancel identity");
    });
    for(unsigned invalid=0;invalid<10;++invalid)test([=] {
        Responses responses;summary(responses,gaussian());auto value=gaussian();value.selectionDraft=false;
        sv_response::TransformSession transform;transform.id=11;transform.baseId=12;transform.kind="numeric";
        transform.appliedMatrix={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};value.transformSession=transform;
        if(invalid==0)value.transformSession->id=0;
        else if(invalid==1)value.transformSession->baseId=0;
        else if(invalid==2)value.transformSession->epoch=9007199254740992ULL;
        else if(invalid==3)value.transformSession->appliedEpoch=0;
        else if(invalid==4)value.transformSession->kind="other";
        else if(invalid==5)value.transformSession->appliedMatrix[3]=1;
        else if(invalid==6)value.transformSession->appliedMatrix[12]=1;
        else if(invalid==7)value.selectionDraft=true;
        else if(invalid==8)value.kind=1;
        else value.transformSession->pivot[0]=std::numeric_limits<double>::infinity();
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
    });
}
void opacitySchemas() {
    test([] {
        Responses responses;auto value=gaussian();value.selectionDraft=false;
        value.opacitySession=sv_response::OpacitySession{11,12,0,{},false,1};
        const auto expected=parse(R"({"id":11,"baseId":12,"epoch":0,"appliedEpoch":null,"selectedOnly":false,"appliedScale":1})");
        require(summary(responses,value).at("opacitySession")==expected,"Opacity record differs from exact six-field literal");
        value.opacitySession=sv_response::OpacitySession{9007199254740991ULL,9007199254740991ULL,9007199254740991ULL,9007199254740991ULL,true,5};
        const std::string expanded(sv_response::formatByteLimit,char(1));value.format=expanded;
        const auto result=summary(responses,value);require(result.at("format")==expanded&&result.at("opacitySession").at("appliedEpoch")==9007199254740991ULL,
            "Worst bounded opacity response was truncated/refused");
        value.opacitySession->appliedScale=0;require(summary(responses,value).at("opacitySession").at("appliedScale")==0,"Zero accepted opacity was refused");
    });
    for(unsigned invalid=0;invalid<16;++invalid)test([=] {
        Responses responses;summary(responses,gaussian());auto value=gaussian();value.selectionDraft=false;
        value.opacitySession=sv_response::OpacitySession{11,12,1,1,false,1};
        if(invalid==0)value.opacitySession->id=0;
        else if(invalid==1)value.opacitySession->baseId=0;
        else if(invalid==2)value.opacitySession->epoch=9007199254740992ULL;
        else if(invalid==3)value.opacitySession->appliedEpoch=0;
        else if(invalid==4)value.opacitySession->appliedEpoch=2;
        else if(invalid==5)value.opacitySession->appliedScale=std::numeric_limits<double>::quiet_NaN();
        else if(invalid==6)value.opacitySession->appliedScale=-1;
        else if(invalid==7)value.opacitySession->appliedScale=6;
        else if(invalid==8)value.opacitySession->appliedScale=.1;
        else if(invalid==9){value.opacitySession->appliedEpoch.reset();value.opacitySession->appliedScale=0;}
        else if(invalid==10)value.selectionDraft=true;
        else if(invalid==11)value.kind=1;
        else if(invalid==12)value.transformSession.emplace();
        else if(invalid==13)value.colorSession.emplace();
        else if(invalid==14)value.filter.emplace();
        else value.loaded=false;
        refuses(responses,[&](auto &p){return responses.summary(p,value);});
        refuses(responses,[&](auto &p){return responses.livePublished(p,value);});
    });
}
void preparationOwnership() {
    test([] {
        Responses responses,other; summary(responses,gaussian()); const std::string before=responses.current();
        auto first=responses.begin(); require(responses.computationFailed(first),"Stale fixture preparation failed");
        auto second=responses.begin();
        require(!responses.error(first,"stale") && parse(noNew([&]{return responses.publish(first);})).at("ok")==false &&
                responses.current()==before,"A superseded preparation published");
        require(!other.error(second,"foreign") && parse(noNew([&]{return other.publish(second);})).at("ok")==false &&
                std::string_view(other.current()).empty(),"A foreign preparation published in another owner");
        require(responses.error(second,"owned"),"Original owner lost its preparation");
        auto moved=std::move(second);
        require(!second && !responses.error(second,"moved-from"),"Moved-from preparation retained authority");
        require(parse(noNew([&]{return responses.publish(moved);}))==parse(R"({"ok":false,"error":"owned"})"),
                "Moved preparation lost complete candidate bytes");
        const std::string committed=responses.current();
        require(parse(noNew([&]{return responses.publish(moved);})).at("ok")==false && responses.current()==committed,
                "A consumed preparation published twice");
        auto reusable=responses.begin(); require(responses.computationFailed(reusable),"Reuse fixture failed");
        auto invalid=gaussian(); invalid.selectionMapRetainedCount=6;
        require(!responses.summary(reusable,invalid) && parse(noNew([&]{return responses.publish(reusable);})).at("ok")==false &&
                responses.current()==committed,"Failed rebuild published an earlier candidate");
    });
    test([] {
        for(const auto kind:{sv_response::FailureKind::Allocation,sv_response::FailureKind::InvalidResponse,sv_response::FailureKind::Internal}) {
            const auto text=noNew([&]{return sv_response::failureReply(kind);});
            const auto value=parse(text);
            require(value.size()==2 && value.at("ok")==false && value.at("error").is_string() && !value.at("error").get<std::string>().empty(),
                    "Static failure reply is not the complete error schema");
        }
        require(Responses::runtimeReserveBytes()>=sizeof(Responses) && sizeof(Responses)>=2*10240,
                "Fixed response runtime reserve does not include both buffers and bookkeeping");
    });
}

Bytes bytes(std::string_view text) { return {text.begin(),text.end()}; }
Json command(const char *text) { return parse(admittedContractCommand(text)); }
Json currentSummary() { return parse(noNew([]{return sv_command("{\"command\":\"summary\"}");})); }
Json open(const Bytes &input,unsigned budget=sceneBudget) { return parse(sv_open(input.data(),input.size(),0,100,budget)); }
Bytes gaussianInput() {
    return bytes("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
        "property float f_dc_2\nend_header\n-1 1 2 -3 -3 -3 1 0 0 0 1 0 0 0\n"
        "0 2 3 -3 -3 -3 1 0 0 0 1 0 0 0\n1 3 4 -3 -3 -3 1 0 0 0 1 0 0 0\n");
}
Json finish(const char *request) {
    auto value=command(request);
    for(unsigned steps=0;value.value("pending",false);++steps) {
        require(steps<8,"Tiny native operation never completed"); value=parse(sv_step(65536));
    }
    require(value.at("ok")==true,"Expected native operation failed"); return value;
}
std::array<preview::Gaussian,3> sceneBytes() {
    std::array<preview::Gaussian,3> result;
    require(sv_scene_ptr()!=nullptr,"Gaussian fixture has no scene pointer");
    std::memcpy(result.data(),sv_scene_ptr(),sizeof(result)); return result;
}
bool sameScene(const std::array<preview::Gaussian,3> &expected) {
    return sv_scene_ptr() && !std::memcmp(sv_scene_ptr(),expected.data(),sizeof(expected));
}
void exportPositions(unsigned scope,const std::vector<std::array<double,3>> &expected) {
    const auto request=Json{{"command","export"},{"format",5},{"scope",scope}}.dump();
    require(command(request.c_str()).at("ok")==true,"Native attributes CSV export failed after refusal");
    const std::string csv(reinterpret_cast<const char *>(sv_output_ptr()),sv_output_len());
    std::istringstream input(csv); std::string line;
    require(bool(std::getline(input,line)) && line=="x,y,z,f_dc_0,f_dc_1,f_dc_2,opacity,scale_0,scale_1,scale_2,rot_0,rot_1,rot_2,rot_3",
            "Attributes CSV schema changed");
    std::size_t rows{};
    while(std::getline(input,line)) {
        require(rows<expected.size(),"Export included an extra selected/deleted record");
        std::istringstream row(line); std::string field;
        for(unsigned axis=0;axis<3;++axis) {
            require(bool(std::getline(row,field,',')),"Export omitted a position field");
            char *end{}; const auto number=std::strtod(field.c_str(),&end);
            require(end==field.c_str()+field.size() && number==expected[rows][axis],"Export position differs from independent analytic oracle");
        }
        ++rows;
    }
    require(rows==expected.size(),"Export lost a selected/remainder record");
}

void nativeBoundary() {
    test([] {
        require(currentSummary()==parse(unloadedLiteral),"Actual unloaded C ABI summary differs from literal");
        require(parse(noNew([]{return sv_step(1);}))==parse(unloadedLiteral),"Idle C ABI step allocated or changed unloaded schema");
        const auto data=bytes("ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n-1 0 0\n1 0 0\n");
        const auto loaded=open(data),observed=currentSummary();
        require(loaded==observed && observed.at("kind")==1 && observed.at("count")==2 && observed.at("selected")==0 && observed.at("selectionCommitRevision")==0 &&
                observed.at("geometry")==parse(R"({"layoutVersion":1,"kind":1,"vertexCount":2,"triangleCount":0,"vertexStride":16,"indexStride":4,"vertexBytes":32,"indexBytes":0,"revision":0,"contentRevision":0})"),
                "Actual read-only C ABI summary descriptor changed");
        auto expectedKeys=parse(gaussianLiteral); expectedKeys["geometry"]=observed.at("geometry");
        require(observed.size()==expectedKeys.size(),"Actual loaded summary has unexpected field count");
        for(auto it=expectedKeys.begin();it!=expectedKeys.end();++it) require(observed.contains(it.key()),"Actual loaded summary omitted a field");
    });
    test([] {
        const auto data=gaussianInput(); require(open(data).at("count")==3,"Gaussian native fixture failed to open");
        const auto original=sceneBytes();
        require(command(R"({"command":"single","index":1,"operation":0})").at("selected")==1,"Native subset selection failed");
        require(command(R"({"command":"delete"})").at("visible")==2,"Native cleanup fixture failed");
        require(command(R"({"command":"single","index":2,"operation":0})").at("selected")==1,"Native remaining subset selection failed");
        auto first=original,second=original;
        // Deleted index1 is excluded from processing. Its complete original
        // bytes, as well as every visible record's covariance/SH, stay exact.
        for(const auto index:{0,2}) {
            first[index].positionOpacity[0]+=2;
            second[index].positionOpacity[0]+=5;
        }
        finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");
        require(sameScene(first),"First native translation changed non-position bytes or analytic positions");
        finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]})");
        require(sameScene(second),"Second native translation differs from independent full-byte oracle");
        require(command(R"({"command":"undo"})").at("canRedo")==true && sameScene(first),"Native Undo did not seed executable content Redo");
        const std::array<std::uint8_t,3> mask{0,2,1};
        require(!std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Native selected/deleted baseline differs");
        exportPositions(0,{{1,1,2},{3,3,4}}); exportPositions(1,{{3,3,4}}); exportPositions(2,{{1,1,2}});
        const auto before=currentSummary(); const auto owner=sv_scene_ptr(); const auto states=sv_states_ptr();
        const auto oldOutput=Bytes(sv_output_ptr(),sv_output_ptr()+sv_output_len());
        const auto malformed=bytes("ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n");
        for(unsigned iteration=0;iteration<16;++iteration) {
            Json refused;
            switch(iteration%4) {
            case 0: refused=parse(sv_open(nullptr,17,0,100,sceneBudget)); break;
            case 1: refused=open(data,1024); break;
            case 2: refused=open(malformed); break;
            default: refused=command(R"({"command":"export","format":99})"); break;
            }
            ++repeatedRefusals;
            require(refused.at("ok")==false && refused.at("error").is_string(),"Ordinary native refusal changed its error schema");
            require(currentSummary()==before && sv_scene_ptr()==owner && sv_states_ptr()==states && sameScene(first) &&
                    !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Repeated refusal changed edited scene, mask, bounds, history or camera summary");
            require(sv_output_len()==oldOutput.size() && !std::memcmp(sv_output_ptr(),oldOutput.data(),oldOutput.size()),
                    "Rejected operation changed the existing export bytes");
        }
        require(command(R"({"command":"redo"})").at("canRedo")==false && sameScene(second) &&
                !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Redo was advertised but not executable after repeated refusals");
        exportPositions(1,{{6,3,4}}); exportPositions(2,{{4,1,2}});
        require(command(R"({"command":"undo"})").at("canRedo")==true && sameScene(first),"Post-refusal Redo could not be undone exactly");
        const auto restored=currentSummary();
        const auto point=command(R"({"command":"point","index":2})");
        auto expected=restored; expected["point"]={3,-3,-4};
        require(point==expected,"Actual C ABI point reply differs from independent translated point/full schema");
    });
    test([] {
        const auto before=currentSummary(); const auto mask=std::array<std::uint8_t,3>{0,2,1};
        require(command(R"({"command":"beginSelection"})").at("selectionDraft")==true,"Live response fixture did not begin a draft");
        const auto request=Json{{"command","rectangle"},{"fromBaseline",true},{"camera",before.at("camera")},
            {"width",640},{"height",480},{"rectangle",{0,0,640,480}},{"operation",0},{"visibleOnly",false},{"overlap",false}}.dump();
        const auto live=parse(sv_live_preview(request.c_str()));
        require(live.size()==4 && live.at("ok")==true && live.at("kind")=="published" && live.at("version")==1 &&
                live.at("summary")==currentSummary(),"Actual live C ABI wrapper omitted or changed its completed summary");
        require(command(R"({"command":"cancelSelection"})").at("selectionDraft")==false &&
                !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Live response fixture could not restore its selected/deleted mask");
    });
}
static_assert(sizeof(std::size_t)==4 && sizeof(std::uintptr_t)==4);
static_assert(std::is_nothrow_move_constructible_v<Responses::Preparation> && std::is_nothrow_move_assignable_v<Responses::Preparation>);
static_assert(noexcept(sv_response::failureReply()) && noexcept(std::declval<Responses &>().begin()));
static_assert(noexcept(std::declval<Responses &>().summary(std::declval<Responses::Preparation &>(),std::declval<const Summary &>())));
}

int main() {
    try {
        sv_allocation::setObserverForContracts(new_observation::observe);
        typedSchemas(); stringsAndNumbers();transformSchemas();opacitySchemas(); preparationOwnership(); nativeBoundary();
        std::printf("SPLATVIEW_RESPONSE_CONTRACTS_PASS cases=%zu assertions=%zu noNewObservations=%zu observedNewCalls=%zu staticBytes=%zu repeatedRefusals=%zu\n",
                    cases,assertions,noNewObservations,observedNewCalls,Responses::runtimeReserveBytes(),repeatedRefusals);
        return 0;
    } catch(const std::exception &error) {
        std::fprintf(stderr,"SPLATVIEW_RESPONSE_CONTRACTS_FAIL %s\n",error.what()); return 1;
    } catch(...) {
        std::fprintf(stderr,"SPLATVIEW_RESPONSE_CONTRACTS_FAIL nonstandard exception\n"); return 1;
    }
}
