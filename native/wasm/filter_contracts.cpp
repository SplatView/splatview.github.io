// Main-only independent boundary masks and actual shipping entry-point tests.
// Fault seams and allocation observations are absent from exported app assets.
#include "browser_filter.hpp"
#include "allocation_census.hpp"
#include "json_preflight.hpp"
#include "resource_budget.hpp"
#include "response.hpp"
#include "model.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

extern "C" {
unsigned sv_abi_version();
const char *sv_build_identity();
const char *sv_open(const uint8_t *,size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_live_preview(const char *);
const char *sv_map_write(double,unsigned,const uint8_t *,unsigned);
const char *sv_step(unsigned);
const preview::Gaussian *sv_scene_ptr();
const uint8_t *sv_states_ptr();
const uint32_t *sv_pack(unsigned,unsigned);
unsigned sv_pack_len();
const uint8_t *sv_output_ptr();
unsigned sv_output_len();
const char *sv_recovery_prepare();const uint8_t *sv_recovery_read(unsigned,unsigned);
unsigned sv_recovery_read_size();void sv_recovery_release();
const char *sv_recovery_restore_begin(unsigned,unsigned,unsigned,const char *);
const char *sv_recovery_restore_write(unsigned,const uint8_t *,unsigned);
const char *sv_recovery_restore_finish();void sv_recovery_restore_cancel();
}
namespace {
using namespace preview;
namespace bf=preview::browser_filter;
using Json=nlohmann::json;
using Bytes=std::vector<uint8_t>;
size_t checks{},cases{},abiCases{},refusals{},publicationRefusals{},backendRefusals{},cancelPhases{},changedGroups{};
void require(bool value,const char *message) { ++checks;if(!value) throw std::runtime_error(message); }
bool sameCensus(const sv_allocation::Snapshot &a,const sv_allocation::Snapshot &b) {
    return a.valid==b.valid&&a.scenePayloadBytes==b.scenePayloadBytes&&a.ownedRawBytes==b.ownedRawBytes&&
        a.overlapBytes==b.overlapBytes&&a.contextBytes==b.contextBytes&&a.unionBytes==b.unionBytes&&
        a.liveBlocks==b.liveBlocks&&a.liveContexts==b.liveContexts;
}
template<class F> void test(F &&action) { action();++cases; }
template<class F> void rejects(F &&action) {
    bool failed=false;try { action(); } catch(const std::exception &) { failed=true; }
    require(failed,"Expected filter refusal");++refusals;
}
std::shared_ptr<Scene> fixture(std::initializer_list<std::array<float,4>> points) {
    auto scene=std::make_shared<Scene>();
    for(const auto &p:points) {
        Gaussian g{};g.positionOpacity=p;g.covA={1,0,0,1};g.covB={0,1,0,0};scene->gaussians.push_back(g);
    }
    scene->sourceCount=scene->gaussians.size();return scene;
}
Bytes mask(const SceneEdits &edits) {return {edits.states().begin(),edits.states().end()};}
bf::Owner begin(SceneEdits &edits,bf::Kind kind,uint64_t id=1) {
    auto baseline=BrowserSelectionAccess::capture(edits);edits.beginSelectionDraft();
    return {id,1,1,edits.revision(),kind,{},std::move(baseline)};
}
void finish(bf::Job &job,size_t batch=1) {
    for(size_t steps=0;job.status()==bf::Status::Working;++steps) {
        job.step(batch);require(job.lastStepWork()<=batch,"Filter exceeded supplied work budget");
        require(steps<100000,"Filter job never completed");
        if(job.status()==bf::Status::Working) require(job.result().empty(),"Filter exposed a partial result mask");
    }
    require(job.status()==bf::Status::Ready,"Filter job did not produce a ready result");
}
Bytes result(const std::shared_ptr<Scene> &scene,bf::Kind kind,bf::Parameters parameters,const Bytes &baseline={},SelectOperation operation=SelectOperation::Set) {
    ResourceBudget budget(4*1024*1024);SceneEdits edits(scene,sceneMemoryForBudget(budget,ResourceCategory::History));
    if(!baseline.empty()) edits.replaceScene(scene,baseline);
    const auto before=mask(edits);const auto revision=edits.revision(),content=edits.contentRevision();
    auto owner=begin(edits,kind);auto work=sceneMemoryForBudget(budget,ResourceCategory::Work);
    auto job=bf::Job::create(owner,parameters,operation,work);
    require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==sizeof(bf::Job),"Filter construction allocated source-sized scratch");
    require(job->step(0)==bf::Status::Working && job->workDone()==0,"Zero work advanced filter");
    finish(*job,3);const auto value=job->result();Bytes output(value.begin(),value.end());
    require(job->changed()==(output!=before),"Cached filter change differs from independent original-baseline mask comparison");
    require(mask(edits)==before&&edits.revision()==revision&&edits.contentRevision()==content,"Predicate evaluation mutated current edits");
    require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==sizeof(bf::Job)+scene->gaussians.size(),"Filter Work admission differs from exact owner plus result mask");
    bf::Job::retire(job);require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Filter retirement retained Work grants");
    return output;
}
void predicateContracts() {
    test([] {
        const auto scene=fixture({{-1,0,0,1},{0,0,0,1},{1,0,0,1},{1.001f,0,0,1}});
        bf::Parameters p;p.radius=1;
        require(result(scene,bf::Kind::Sphere,p)==Bytes({1,1,1,0}),"Sphere inclusive boundary oracle differs");
        p.radius=0;require(result(scene,bf::Kind::Sphere,p)==Bytes({0,1,0,0}),"Zero-radius sphere must include its center");
    });
    test([] {
        const auto scene=fixture({{1,1,1,1},{-1,-1,-1,1},{1.001f,0,0,1},{0,0,0,1}});
        bf::Parameters p;p.size={2,2,2};
        require(result(scene,bf::Kind::Box,p)==Bytes({1,1,0,1}),"Box inclusive faces/corners oracle differs");
        p.size={0,0,0};require(result(scene,bf::Kind::Box,p)==Bytes({0,0,0,1}),"Zero-extent box center differs");
        const auto rotated=fixture({{0,1.5f,0,1},{1.5f,0,0,1},{0,0,.5f,1}});
        p.size={4,2,2};p.rotation={0,0,90};
        require(result(rotated,bf::Kind::Box,p)==Bytes({1,0,1}),"Box axis-angle rotation differs from independent axis exchange");
    });
    test([] {
        const auto scene=fixture({{2,0,0,1},{0,1,0,1},{0,0,-1,1},{2.001f,0,0,1}});
        bf::Parameters p;p.size={2,1,1};
        require(result(scene,bf::Kind::Ellipsoid,p)==Bytes({1,1,1,0}),"Ellipsoid inclusive radii oracle differs");
        p.rotation={0,0,90};
        require(result(fixture({{0,1.5f,0,1},{1.5f,0,0,1}}),bf::Kind::Ellipsoid,p)==Bytes({1,0}),"Ellipsoid axis-angle rotation differs");
    });
    test([] {
        const auto scene=fixture({{0,0,-1,1},{0,0,-3,1},{1,0,-1,1},{0,1,-1,1},{1.001f,0,-1,1},{0,0,-.999f,1},{0,0,-3.001f,1},{0,0,1,1}});
        bf::Parameters p;p.fov=90;p.aspect=1;p.nearPlane=1;p.farPlane=3;
        require(result(scene,bf::Kind::Frustum,p)==Bytes({1,1,1,1,0,0,0,0}),"Frustum inclusive side/near/far oracle differs");
        p.rotation={0,90,0};
        require(result(fixture({{-2,0,0,1},{2,0,0,1},{0,0,-2,1}}),bf::Kind::Frustum,p)==Bytes({1,0,0}),"Frustum forward axis-angle oracle differs");
    });
    test([] {
        const auto scene=fixture({{0,0,0,.25f},{1,0,0,.5f},{2,0,0,.75f},{3,0,0,.751f}});
        bf::Parameters p;p.minimum=.25f;p.maximum=.75f;
        require(result(scene,bf::Kind::Opacity,p)==Bytes({1,1,1,0}),"Opacity inclusive thresholds differ");
        require(result(scene,bf::Kind::Opacity,p,{0,2,1,0})==Bytes({1,2,1,0}),"Filter changed a deleted opacity member");
    });
    test([] {
        const auto scene=fixture({{0,0,0,1},{1,0,0,1},{2,0,0,1},{3,0,0,1}});
        scene->gaussians[0].covA={.25f,0,0,.25f};scene->gaussians[0].covB={0,.25f,0,0};
        scene->gaussians[1].covA={1,0,0,1};scene->gaussians[1].covB={0,1,0,0};
        scene->gaussians[2].covA={4,0,0,4};scene->gaussians[2].covB={0,4,0,0};
        scene->gaussians[3].covA={40000,0,0,40000};scene->gaussians[3].covB={0,40000,0,0};
        bf::Parameters p;p.minimum=1;p.maximum=2;
        require(result(scene,bf::Kind::Scale,p)==Bytes({0,1,1,0}),"Principal-axis scale inclusive oracle differs");
        p.minimum=2;p.maximum=100;
        require(result(scene,bf::Kind::Scale,p)==Bytes({0,0,1,1}),"Scale >=100 sentinel imposed an upper limit");
        p.minimum=0;p.maximum=100;
        require(result(scene,bf::Kind::Scale,p)==Bytes({1,1,1,1}),"Neutral scale sentinel did not include every visible member");
    });
    test([] {
        const auto scene=fixture({{0,0,0,1},{1,0,0,1},{2,0,0,1},{3,0,0,1},{4,0,0,1}});
        bf::Parameters p;p.center={1,0,0};p.radius=1;
        const Bytes baseline{0,1,0,1,2};
        const std::array<Bytes,4> expected{Bytes{1,1,1,0,2},Bytes{1,1,1,1,2},Bytes{0,0,0,1,2},Bytes{0,1,0,0,2}};
        for(unsigned op=0;op<4;++op) require(result(scene,bf::Kind::Sphere,p,baseline,SelectOperation(op))==expected[op],"Filter combination differs from independent Boolean oracle");
    });
    test([] {
        const auto scene=fixture({{0,0,0,1},{1,0,0,1},{2,0,0,1},{3,0,0,1}});
        ResourceBudget budget(4*1024*1024);SceneEdits edits(scene,sceneMemoryForBudget(budget,ResourceCategory::History));
        edits.selectSingle(3,SelectOperation::Set);edits.selectNone();edits.undo();
        const auto before=mask(edits);const auto *baselinePointer=edits.states().data();const auto content=edits.contentRevision();
        auto owner=begin(edits,bf::Kind::Sphere);auto work=sceneMemoryForBudget(budget,ResourceCategory::Work);
        bf::Parameters p;p.radius=2;
        for(float radius:{2.f,0.f,1.f,2.f}) {
            p.radius=radius;auto job=bf::Job::create(owner,p,SelectOperation::Add,work);finish(*job);
            auto candidate=SceneEdits(edits);BrowserSelectionAccess::replaceFilterPreview(candidate,owner.baseline,owner.revision,job->result());
            edits=std::move(candidate);owner.revision=edits.revision();owner.previewEpoch=owner.epoch++;
            require(edits.states()[3]==1&&edits.contentRevision()==content&&edits.canRedo(),"Preview used previous result or touched content/Redo");
            if(radius==0) require(mask(edits)==Bytes({1,0,0,1}),"Shrinking Add retained stale preview members");
            bf::Job::retire(job);
        }
        edits.cancelSelectionDraft();require(mask(edits)==before&&edits.states().data()==baselinePointer&&edits.canRedo(),"Cancel did not restore exact entry owner and Redo");
        require(edits.redo()&&edits.selectedCount()==0,"Cancel destroyed executable Redo");
        owner=begin(edits,bf::Kind::Sphere,2);p.radius=1;
        auto job=bf::Job::create(owner,p,SelectOperation::Set,work);finish(*job);
        BrowserSelectionAccess::replaceFilterPreview(edits,owner.baseline,owner.revision,job->result());bf::Job::retire(job);
        require(edits.confirmSelectionDraft()&&!edits.canRedo(),"Confirm did not create one selection revision");
        require(edits.undo()&&edits.selectedCount()==0,"One Undo did not restore confirmed filter entry");
        require(edits.redo()&&mask(edits)==Bytes({1,1,0,0}),"One Redo did not restore confirmed filter result");
    });
    test([] {
        const auto scene=fixture({{0,0,0,1},{1,0,0,1}});ResourceBudget budget(1024*1024);
        SceneEdits edits(scene,sceneMemoryForBudget(budget,ResourceCategory::History));edits.selectAll();edits.selectNone();edits.undo();
        const auto before=mask(edits);const auto revision=edits.revision();const auto *pointer=edits.states().data();
        auto owner=begin(edits,bf::Kind::Sphere);bf::Parameters p;p.radius=10;
        auto job=bf::Job::create(owner,p,SelectOperation::Set,sceneMemoryForBudget(budget,ResourceCategory::Work));finish(*job);
        require(!BrowserSelectionAccess::replaceFilterPreview(edits,owner.baseline,owner.revision,job->result()),"Noop filter manufactured a preview revision");
        require(!edits.confirmSelectionDraft()&&mask(edits)==before&&edits.revision()==revision&&edits.states().data()==pointer&&edits.canRedo(),"Noop confirmation changed history, revision, or owner");
    });
}
struct DenyMemory final : SceneMemory {
    std::shared_ptr<SceneMemory> delegate;size_t calls{},deny{};
    explicit DenyMemory(std::shared_ptr<SceneMemory> value):delegate(std::move(value)) {}
    std::shared_ptr<void> admit(size_t bytes) override {if(++calls==deny) throw std::bad_alloc();return delegate->admit(bytes);}
    void arm(size_t ordinal) {calls=0;deny=ordinal;}
};
void historyFailure(void *,std::string_view seam) {if(seam=="draft.append") throw std::bad_alloc();}
}
namespace preview {
struct HistoryAdmissionTestAccess {
    static void failDraftAppend(SceneEdits &edits,bool enabled) {edits.historyCheckpoint_=enabled?historyFailure:nullptr;}
};
}
namespace {
void admissionContracts() {
    test([] {
        ResourceBudget budget(1024*1024);SceneEdits edits(fixture({{0,0,0,1},{1,0,0,1}}),sceneMemoryForBudget(budget,ResourceCategory::History));
        auto owner=begin(edits,bf::Kind::Sphere);bf::Parameters p;
        auto memory=std::make_shared<DenyMemory>(sceneMemoryForBudget(budget,ResourceCategory::Work));
        for(size_t ordinal:{size_t(1),size_t(2)}) {
            memory->arm(ordinal);rejects([&] {auto job=bf::Job::create(owner,p,SelectOperation::Set,memory);job->step(1);});
            require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Filter admission refusal leaked Work");
            require(mask(edits)==Bytes({0,0})&&edits.selectionDraft(),"Filter admission refusal mutated current draft");
        }
        memory->arm(0);
        for(unsigned actions:{0u,1u,2u,3u,4u}) {
            auto job=bf::Job::create(owner,p,SelectOperation::Set,memory);job->step(actions);job->cancel();++cancelPhases;
            require(job->status()==bf::Status::Cancelled&&job->result().empty(),"Cancellation exposed partial or completed result");
            bf::Job::retire(job);require(budget.usage().categoryBytes[size_t(ResourceCategory::Work)]==0,"Cancelled filter retained Work");
        }
        auto job=bf::Job::create(owner,p,SelectOperation::Set,memory);std::stop_source stop;stop.request_stop();
        require(job->step(10,stop.get_token())==bf::Status::Cancelled,"Pre-cancelled filter allocated/evaluated");
        bf::Job::retire(job);
        require(bf::current(edits,owner,1)&&!bf::current(edits,owner,2),"Filter source-generation key was not exact");
        auto replacement=fixture({{0,0,0,1},{1,0,0,1}});edits.replaceScene(replacement,Bytes({0,0}));
        require(!bf::current(edits,owner,1),"Different scene with coincident counts accepted old filter owner");
    });
    test([] {
        ResourceBudget budget(1024*1024);auto history=std::make_shared<DenyMemory>(sceneMemoryForBudget(budget,ResourceCategory::History));
        SceneEdits edits(fixture({{0,0,0,1},{1,0,0,1},{2,0,0,1}}),history);
        auto owner=begin(edits,bf::Kind::Sphere);auto work=sceneMemoryForBudget(budget,ResourceCategory::Work);
        bf::Parameters p;p.radius=1;auto job=bf::Job::create(owner,p,SelectOperation::Set,work);finish(*job);
        const auto before=mask(edits);const auto revision=edits.revision();
        // Clone first, then refuse exact delta admission and COW in its private
        // mask preparation. The original draft/Undo/Redo/owner never changes.
        for(size_t ordinal:{size_t(1),size_t(2)}) {
            history->arm(0);SceneEdits candidate(edits);history->arm(ordinal);
            rejects([&]{BrowserSelectionAccess::replaceFilterPreview(candidate,owner.baseline,owner.revision,job->result());});
            history->arm(0);require(mask(edits)==before&&edits.revision()==revision&&bf::current(edits,owner,1),"Prepared mask refusal changed current filter owner");
        }
        SceneEdits candidate(edits);BrowserSelectionAccess::replaceFilterPreview(candidate,owner.baseline,owner.revision,job->result());
        HistoryAdmissionTestAccess::failDraftAppend(candidate,true);
        rejects([&]{candidate.confirmSelectionDraft();});
        require(candidate.selectionDraft()&&!candidate.canUndo()&&mask(edits)==before,"Confirm history append refusal consumed draft or touched current edits");
        HistoryAdmissionTestAccess::failDraftAppend(candidate,false);require(candidate.confirmSelectionDraft(),"Confirm could not retry after actual history refusal");
        bf::Job::retire(job);
    });
    test([] {
        const std::array<std::pair<bf::Kind,Json>,10> invalid{{
            {bf::Kind::Sphere,{{"center",{0,0,0}},{"radius",-1}}},
            {bf::Kind::Sphere,{{"center",{0,0}},{"radius",1}}},
            {bf::Kind::Box,{{"center",{0,0,0}},{"size",{1,-1,1}},{"rotation",{0,0,0}}}},
            {bf::Kind::Ellipsoid,{{"center",{0,0,0}},{"size",{1,0,1}},{"rotation",{0,0,0}}}},
            {bf::Kind::Frustum,{{"center",{0,0,0}},{"rotation",{0,0,0}},{"fov",0},{"aspect",1},{"near",1},{"far",3}}},
            {bf::Kind::Frustum,{{"center",{0,0,0}},{"rotation",{0,0,0}},{"fov",90},{"aspect",0},{"near",1},{"far",3}}},
            {bf::Kind::Frustum,{{"center",{0,0,0}},{"rotation",{0,0,0}},{"fov",90},{"aspect",1},{"near",3},{"far",3}}},
            {bf::Kind::Opacity,{{"minimum",.8},{"maximum",.2}}},
            {bf::Kind::Scale,{{"minimum",-1},{"maximum",100}}},
            {bf::Kind::Opacity,{{"minimum",0},{"maximum",1},{"radius",1}}}
        }};
        for(const auto &[kind,value]:invalid) rejects([&] {bf::parameters(kind,value);});
        auto input=Json{{"center",{0,0,0}},{"size",{1,1,1}},{"rotation",{0,std::numeric_limits<double>::infinity(),0}}};
        rejects([&]{bf::parameters(bf::Kind::Box,input);});
        sv_json::ParsedFilterCommand parsed(R"({"command":"previewFilter","id":1,"epoch":2,"kind":"sphere","parameters":{"center":[0,0,0],"radius":1},"operation":0})");
        require(parsed.qualified(),"Valid active-keys filter command did not qualify before parsing");
    });
}
Json parsed(const char *text) {return Json::parse(text);}
Json command(const Json &value) {const auto text=value.dump();return parsed(sv_command(text.c_str()));}
Json command(const char *text) {return parsed(sv_command(text));}
Json summary() {return command(R"({"command":"summary"})");}
std::string input() {
    return "ply\nformat ascii 1.0\nelement vertex 5\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\nproperty float f_dc_2\nend_header\n"
        "0 0 0 0 0 0 1 0 0 0 0 0 0 0\n1 0 0 0 0 0 1 0 0 0 0 0 0 0\n2 0 0 0 0 0 1 0 0 0 0 0 0 0\n"
        "3 0 0 0 0 0 1 0 0 0 0 0 0 0\n4 0 0 0 0 0 1 0 0 0 0 0 0 0\n";
}
Json open() {const auto text=input();return parsed(sv_open(reinterpret_cast<const uint8_t *>(text.data()),text.size(),unsigned(InputFormat::Auto),1000,64*1024*1024));}
Bytes nativeMask() {const auto *p=sv_states_ptr();require(p!=nullptr,"Native Gaussian mask missing");return {p,p+5};}
Bytes nativeScene() {const auto *p=reinterpret_cast<const uint8_t *>(sv_scene_ptr());require(p!=nullptr,"Native Gaussian scene missing");return {p,p+5*sizeof(Gaussian)};}
Json finishNative(Json value,unsigned batch=1) {
    require(value.value("ok",false),"Native filter admission failed");
    for(size_t steps=0;value.value("pending",false);++steps) {
        require(steps<1000,"Native filter did not finish");value=parsed(sv_step(batch));require(value.value("ok",false),"Native filter step failed");
    }
    return value;
}
uint64_t beginNative(const char *kind) {
    const auto value=command(Json{{"command","beginFilter"},{"kind",kind}});
    require(value.at("ok")==true&&!value.at("selectionDraft").get<bool>()&&value.at("filter").size()==5&&
        value.at("filter").at("kind")==kind&&value.at("filter").at("epoch")==0&&value.at("filter").at("previewEpoch").is_null()&&
        value.at("filter").at("changed")==false,"Begin filter returned a manual draft or wrong typed owner");
    return value.at("filter").at("id");
}
Json preview(uint64_t id,uint64_t epoch,const char *kind,const Json &parameters,unsigned operation=0) {
    return command(Json{{"command","previewFilter"},{"id",id},{"epoch",epoch},{"kind",kind},{"parameters",parameters},{"operation",operation}});
}
Json sphere(float radius=1,std::array<float,3> center={1,0,0}) {return {{"center",center},{"radius",radius}};}
void expectNativeRefusal(const Json &request) {require(command(request).at("ok")==false,"Competing or stale native filter command was accepted");++refusals;}
void nativeContracts() {
    require(sv_abi_version()==24,"Six-filter adapter ABI is not 24");
    test([] {
        const std::array<const char *,6> kinds{"sphere","box","ellipsoid","frustum","opacity","scale"};
        const std::array<Json,6> parameters{sphere(),Json{{"center",{1,0,0}},{"size",{2,2,2}},{"rotation",{0,0,0}}},
            Json{{"center",{1,0,0}},{"size",{1,1,1}},{"rotation",{0,0,0}}},
            Json{{"center",{1,0,2}},{"rotation",{0,0,0}},{"fov",90},{"aspect",1},{"near",2},{"far",2.001}},
            Json{{"minimum",.5},{"maximum",.5}},Json{{"minimum",1},{"maximum",1}}};
        const std::array<Bytes,6> masks{Bytes{1,1,1,0,0},Bytes{1,1,1,0,0},Bytes{1,1,1,0,0},Bytes{1,1,1,1,0},Bytes{1,1,1,1,1},Bytes{1,1,1,1,1}};
        uint64_t previousId=0;
        for(size_t k=0;k<kinds.size();++k) {
            require(open().at("ok")==true,"Native filter fixture failed to open");const auto before=nativeMask(),scene=nativeScene();
            const auto id=beginNative(kinds[k]);require(id>previousId,"Open recycled attempted filter identity");previousId=id;
            const auto initial=summary();auto value=preview(id,1,kinds[k],parameters[k]);
            require(value.at("ok")==true&&value.at("pending")==true&&nativeMask()==before,"Preview dispatch published a mask synchronously");
            value=parsed(sv_step(1));require(value.at("pending")==true&&nativeMask()==before,"Allocation phase published partial filter mask");
            value=finishNative(value);++abiCases;
            require(nativeMask()==masks[k]&&nativeScene()==scene&&value.at("contentRevision")==initial.at("contentRevision")&&
                !value.at("canUndo").get<bool>()&&value.at("filter").at("epoch")==1&&value.at("filter").at("previewEpoch")==1&&
                value.at("selectionDraft")==false,"Actual filter result/history/metadata differs from independent mask");
            require(command(Json{{"command","cancelFilter"},{"id",id}}).at("filter").is_null()&&nativeMask()==before,"Native cancel did not restore entry mask");
        }
    });
    test([] {
        require(open().at("ok")==true,"History fixture failed");command(R"({"command":"selectAll"})");command(R"({"command":"selectNone"})");command(R"({"command":"undo"})");
        const auto entry=nativeMask();const auto *entryPointer=sv_states_ptr();const auto entrySummary=summary();
        const auto id=beginNative("sphere");
        finishNative(preview(id,1,"sphere",sphere(0)));require(nativeMask()==Bytes({0,1,0,0,0}),"First shrink preview differs");
        finishNative(preview(id,2,"sphere",sphere(1)));require(nativeMask()==Bytes({1,1,1,0,0})&&summary().at("canRedo")==true,"Expanded preview accumulated old selection or destroyed Redo");
        expectNativeRefusal({{"command","confirmFilter"},{"id",id},{"epoch",1}});
        command(Json{{"command","cancelFilter"},{"id",id}});
        require(nativeMask()==entry&&sv_states_ptr()==entryPointer&&summary().at("canRedo")==true,"Cancellation lost exact entry mask/Redo owner");
        require(command(R"({"command":"redo"})").at("selected")==0,"Cancelled filter destroyed executable Redo");
        const auto id2=beginNative("sphere");finishNative(preview(id2,1,"sphere",sphere(1)));
        const auto value=command(Json{{"command","confirmFilter"},{"id",id2},{"epoch",1}});
        require(value.at("filter").is_null()&&value.at("selectionDraft")==false&&value.at("canRedo")==false,"Native confirm retained draft or Redo");
        require(command(R"({"command":"undo"})").at("selected")==0,"One Undo did not restore native filter entry");
        require(command(R"({"command":"redo"})").at("selected")==3,"One Redo did not restore confirmed native filter");
        command(R"({"command":"selectAll"})");command(R"({"command":"selectNone"})");command(R"({"command":"undo"})");
        const auto noChange=summary();const auto noId=beginNative("sphere");finishNative(preview(noId,1,"sphere",sphere(100)));
        const auto noResult=command(Json{{"command","confirmFilter"},{"id",noId},{"epoch",1}});
        require(noResult.at("revision")==noChange.at("revision")&&noResult.at("canRedo")==true,"Noop confirmation changed revision or Redo");
        require(entrySummary.at("contentRevision")==noResult.at("contentRevision"),"Selection filters changed exported content identity");
    });
    test([] {
        require(open().at("ok")==true,"Guard fixture failed");command(R"({"command":"single","index":4,"operation":0})");command(R"({"command":"delete"})");
        const auto baseline=nativeMask(),scene=nativeScene();const auto id=beginNative("sphere");auto pending=preview(id,1,"sphere",sphere(100));
        require(pending.at("pending")==true,"Guard fixture has no pending preview");
        for(const auto *name:{"selectAll","selectNone","invert","delete","crop","restore","undo","redo","beginSelection","confirmSelection","cancelSelection","point","detectFloor","endColor","endTolerance","selectionMapRelease"})
            expectNativeRefusal(Json{{"command",name}});
        for(unsigned format=0;format<=8;++format) expectNativeRefusal({{"command","export"},{"format",format},{"scope",0}});
        require(parsed(sv_live_preview(R"({"command":"rectangle"})")).at("ok")==false,"Manual live preview entered filter draft");
        alignas(4) const std::array<uint8_t,4> block{};
        require(parsed(sv_map_write(1,0,block.data(),4)).at("ok")==false,"Map write entered filter draft");
        require(summary().at("pending")==true&&nativeMask()==baseline&&nativeScene()==scene,"Competing command cancelled preview or changed document");
        const auto packet=sv_pack(0,5);require(packet&&sv_pack_len(),"Readonly pack became unavailable during filter");
        auto value=finishNative(summary());require(nativeMask()==Bytes({1,1,1,1,2})&&value.at("visible")==4,"Filter selected/restored deleted member");
        const auto reset=command(R"({"command":"resetCleanup"})");require(reset.at("filter").is_null()&&reset.at("selected")==0&&reset.at("visible")==5&&nativeMask()==Bytes({0,0,0,0,0}),"Reset did not cancel filter and clear exact cleanup baseline");
        require(command(R"({"command":"undo"})").at("visible")==4,"Reset Undo did not restore original deletion");
    });
    test([] {
        require(open().at("ok")==true,"Rollback fixture failed");const auto id=beginNative("sphere");finishNative(preview(id,1,"sphere",sphere(0)));
        const auto before=nativeMask();const auto metadata=summary().at("filter");
        require(command(R"({"command":"beginTransaction"})").at("transaction")==true,"Filter checkpoint failed");
        finishNative(preview(id,2,"sphere",sphere(2)));
        const auto value=command(R"({"command":"rollbackTransaction"})");
        require(value.at("filter")==metadata&&nativeMask()==before&&!value.at("transaction").get<bool>(),"Rollback did not restore published filter metadata and mask");
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",1},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",2},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        expectNativeRefusal({{"command","cancelFilter"},{"id",id+1}});
        expectNativeRefusal({{"command","beginFilter"},{"kind","box"}});
        preview(id,3,"sphere",sphere(100));parsed(sv_step(1));
        const auto cancelled=command(R"({"command":"cancel"})");
        require(cancelled.at("pending")==false&&cancelled.at("filter").at("id")==id&&cancelled.at("filter").at("epoch")==3&&
            cancelled.at("filter").at("previewEpoch")==1&&nativeMask()==before,"Generic cancel discarded filter owner or last published result");
        expectNativeRefusal({{"command","confirmFilter"},{"id",id},{"epoch",3}});
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",3},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        finishNative(preview(id,4,"sphere",sphere(1)));
        require(command(Json{{"command","confirmFilter"},{"id",id},{"epoch",4}}).at("filter").is_null(),"Retry after generic cancellation failed");
        const auto oldId=beginNative("sphere");preview(oldId,1,"sphere",sphere());
        require(open().at("ok")==true&&summary().at("filter").is_null()&&!summary().at("pending").get<bool>(),"Source replacement retained old filter/job");
        expectNativeRefusal({{"command","cancelFilter"},{"id",oldId}});
        const auto newId=beginNative("box");require(newId>oldId,"Source replacement recycled owner identity");command(Json{{"command","cancelFilter"},{"id",newId}});
    });
    test([] {
        require(open().at("ok")==true,"Attempt-fence fixture failed");const auto id=beginNative("sphere");finishNative(preview(id,1,"sphere",sphere()));
        const auto prior=nativeMask();const auto metadata=summary().at("filter");
        require(preview(id,2,"sphere",sphere(-1)).at("ok")==false,"Invalid filter bounds were accepted");
        require(nativeMask()==prior&&summary().at("filter")==metadata,"Invalid bounds changed published mask/metadata");
        expectNativeRefusal({{"command","confirmFilter"},{"id",id},{"epoch",1}});
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",2},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        finishNative(preview(id,3,"sphere",sphere(0)));
        require(command(R"({"command":"beginTransaction"})").at("transaction")==true,"Two-ID attempt fence checkpoint failed");
        command(Json{{"command","cancelFilter"},{"id",id}});const auto next=beginNative("box");
        finishNative(preview(next,1,"box",{{"center",{1,0,0}},{"size",{2,2,2}},{"rotation",{0,0,0}}}));
        const auto restored=command(R"({"command":"rollbackTransaction"})");
        require(restored.at("filter").at("id")==id&&restored.at("filter").at("epoch")==3,"Switch rollback did not restore old owner");
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",3},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        finishNative(preview(id,4,"sphere",sphere()));command(Json{{"command","cancelFilter"},{"id",id}});
    });
}
template<class F>void changedTest(const char *name,F action) {
    test(action);++changedGroups;std::printf("FILTER_CHANGED_GROUP_PASS %s\n",name);
}
void changedContracts() {
    require(parsed(sv_build_identity()).at("capabilities").at("selectionFilter")==2&&
        parsed(sv_build_identity()).at("capabilities").at("selectionActions")==2,"Floating selection capabilities differ");
    changedTest("original-baseline-equal-count-pending-noop",[] {
        require(open().at("ok")==true,"Changed fixture failed");command(R"({"command":"single","index":0,"operation":0})");
        const auto entry=nativeMask();const auto id=beginNative("sphere");
        auto value=preview(id,1,"sphere",sphere(0));
        require(value.at("pending")==true&&value.at("filter").at("changed")==false&&nativeMask()==entry,
            "Pending first preview published changed or mask ahead of acceptance");
        value=finishNative(value);require(value.at("selected")==1&&value.at("filter").at("changed")==true&&nativeMask()==Bytes({0,1,0,0,0}),
            "Equal-count identity replacement was reported unchanged");
        const auto revision=value.at("revision");value=finishNative(preview(id,2,"sphere",sphere(0)));
        require(value.at("filter").at("changed")==true&&value.at("revision")==revision,
            "Unchanged repeat compared against previous preview instead of original baseline");
        value=preview(id,3,"sphere",sphere(0,{0,0,0}));
        require(value.at("filter").at("changed")==true&&value.at("filter").at("previewEpoch")==2,
            "Pending baseline restoration cleared the last accepted changed bit");
        value=finishNative(value);require(value.at("filter").at("changed")==false&&nativeMask()==entry,
            "Returning to original baseline retained changed metadata");
        preview(id,4,"sphere",sphere(0,{2,0,0}));parsed(sv_step(1));value=command(R"({"command":"cancel"})");
        require(value.at("filter").at("changed")==false&&value.at("filter").at("previewEpoch")==3&&nativeMask()==entry,
            "Cancelling pending work changed the last accepted signal");
        command(Json{{"command","cancelFilter"},{"id",id}});
        const auto before=summary();const auto noId=beginNative("sphere");value=finishNative(preview(noId,1,"sphere",sphere(0,{0,0,0})));
        require(value.at("filter").at("changed")==false,"No-op filter was reported changed");
        value=command(Json{{"command","confirmFilter"},{"id",noId},{"epoch",1}});
        require(value.at("filter").is_null()&&value.at("revision")==before.at("revision")&&nativeMask()==entry,
            "No-op confirm added history or retained the changed signal");
    });
    changedTest("explicit-visible-preview-confirm-cancelled-newer-work",[] {
        require(open().at("ok")==true,"Visible confirmation fixture failed");const auto id=beginNative("sphere");
        finishNative(preview(id,1,"sphere",sphere(0)));const auto visible=nativeMask();
        preview(id,2,"sphere",sphere(2));parsed(sv_step(1));const auto pending=summary().at("filter");
        expectNativeRefusal({{"command","confirmFilter"},{"id",id},{"epoch",1},{"visiblePreview",true}});
        require(summary().at("pending")==true&&summary().at("filter")==pending&&nativeMask()==visible,"Visible confirmation cancelled active preview work");
        const auto cancelled=command(R"({"command":"cancel"})");
        require(cancelled.at("filter").at("epoch")==2&&cancelled.at("filter").at("previewEpoch")==1&&
            cancelled.at("filter").at("changed")==true&&nativeMask()==visible,"Cancelled later work changed the acknowledged visible mask");
        const auto metadata=summary().at("filter");
        auto refuse=[&](const Json &request){expectNativeRefusal(request);require(summary().at("filter")==metadata&&nativeMask()==visible,
            "Refused visible confirmation changed accepted metadata/mask");};
        refuse({{"command","confirmFilter"},{"id",id},{"epoch",1}});
        for(const auto &flag:std::vector<Json>{false,nullptr,1,"true",Json::object()})
            refuse({{"command","confirmFilter"},{"id",id},{"epoch",1},{"visiblePreview",flag}});
        for(uint64_t epoch:{uint64_t(0),uint64_t(2),uint64_t(3)})
            refuse({{"command","confirmFilter"},{"id",id},{"epoch",epoch},{"visiblePreview",true}});
        refuse({{"command","confirmFilter"},{"id",id+1},{"epoch",1},{"visiblePreview",true}});
        refuse({{"command","confirmFilter"},{"id",id},{"visiblePreview",true}});
        const auto settled=summary().at("filter");
        sv_response::refuseNextSummaryForContracts();require(command(Json{{"command","confirmFilter"},{"id",id},{"epoch",1},{"visiblePreview",true}}).at("ok")==false,
            "Visible confirmation ignored reply publication refusal");++publicationRefusals;
        require(summary().at("filter")==settled&&nativeMask()==visible,"Reply refusal committed visible mask or retired its owner");
        const auto accepted=command(Json{{"command","confirmFilter"},{"id",id},{"epoch",1},{"visiblePreview",true}});
        require(accepted.at("ok")==true&&accepted.at("filter").is_null()&&nativeMask()==visible,"Explicit visible confirmation did not commit accepted epoch1 after cancelled epoch2");
        require(command(R"({"command":"undo"})").at("selected")==0,"Visible confirmation added extra or wrong Undo");
        require(command(R"({"command":"redo"})").at("selected")==1&&nativeMask()==visible,"Visible confirmation Redo did not restore the acknowledged mask");
        const auto empty=beginNative("sphere");expectNativeRefusal({{"command","confirmFilter"},{"id",empty},{"epoch",1},{"visiblePreview",true}});
        command(Json{{"command","cancelFilter"},{"id",empty}});
    });
    changedTest("deleted-current-view-readonly",[] {
        require(open().at("ok")==true,"Deleted changed fixture failed");command(R"({"command":"single","index":4,"operation":0})");command(R"({"command":"delete"})");
        const auto id=beginNative("sphere");auto value=finishNative(preview(id,1,"sphere",sphere(100)));
        require(value.at("filter").at("changed")==true&&nativeMask()==Bytes({1,1,1,1,2}),"Changed filter selected/restored a deleted member");
        value=finishNative(preview(id,2,"sphere",sphere(0,{4,0,0})));
        require(value.at("filter").at("changed")==false&&nativeMask()==Bytes({0,0,0,0,2}),"Deleted-only hits manufactured a change");
        command(Json{{"command","cancelFilter"},{"id",id}});command(R"({"command":"selectAll"})");const auto scoped=beginNative("sphere");
        Json request{{"command","previewFilter"},{"id",scoped},{"epoch",1},{"kind","sphere"},{"parameters",sphere(100)},{"operation",1},
            {"selectionView",{10,0,0,0,0,5,1,60,1,0,1}}};
        value=finishNative(command(request));require(value.at("filter").at("changed")==true&&nativeMask()==Bytes({0,0,0,0,2}),
            "Changed signal ignored final current-view clipping");
        const auto metadata=value.at("filter");const auto bytes=nativeScene(),states=nativeMask();const auto *pointer=sv_states_ptr();
        for(unsigned i=0;i<20;++i)require(summary().at("filter")==metadata&&nativeMask()==states&&sv_states_ptr()==pointer,
            "Readonly summary changed filter metadata or mask owner");
        require(sv_pack(0,5)&&sv_pack_len()&&nativeScene()==bytes&&summary().at("filter")==metadata,
            "Readonly pack changed the authoritative filter signal");command(Json{{"command","cancelFilter"},{"id",scoped}});
    });
    changedTest("transaction-copy-commit-rollback",[] {
        require(open().at("ok")==true,"Changed rollback fixture failed");const auto id=beginNative("sphere");
        finishNative(preview(id,1,"sphere",sphere(0,{0,0,0})));const auto metadata=summary().at("filter");const auto before=nativeMask();
        require(metadata.at("changed")==true,"Rollback fixture did not change selection");command(R"({"command":"beginTransaction"})");
        auto value=finishNative(preview(id,2,"sphere",sphere(100),2));require(value.at("filter").at("changed")==false,"Empty original Remove reported changed");
        value=command(R"({"command":"rollbackTransaction"})");require(value.at("filter")==metadata&&nativeMask()==before,"Rollback did not restore copied changed signal");
        command(R"({"command":"beginTransaction"})");finishNative(preview(id,3,"sphere",sphere(100),2));value=command(R"({"command":"commitTransaction"})");
        require(value.at("filter").at("changed")==false&&nativeMask()==Bytes({0,0,0,0,0}),"Commit altered last accepted unchanged signal");command(Json{{"command","cancelFilter"},{"id",id}});
        const auto initial=beginNative("sphere");command(R"({"command":"beginTransaction"})");finishNative(preview(initial,1,"sphere",sphere()));
        value=command(R"({"command":"rollbackTransaction"})");require(value.at("filter").at("changed")==false&&value.at("filter").at("previewEpoch").is_null(),
            "Rollback to unpreviewed owner retained changed signal");command(Json{{"command","cancelFilter"},{"id",initial}});
    });
    changedTest("reply-and-allocation-publication-refusals",[] {
        require(open().at("ok")==true,"Changed publication fixture failed");command(R"({"command":"single","index":0,"operation":0})");
        const auto entry=nativeMask();const auto *pointer=sv_states_ptr();const auto id=beginNative("sphere");
        finishNative(preview(id,1,"sphere",sphere(0,{0,0,0})));bool succeeded=false;size_t failures=0;uint64_t epoch=1;
        for(size_t ordinal=1;ordinal<200;++ordinal) {
            auto value=preview(id,++epoch,"sphere",sphere(0));for(unsigned i=0;i<6;++i){value=parsed(sv_step(1));require(value.at("ok")==true&&value.at("pending")==true,"Changed allocation fixture completed early");}
            const auto metadata=summary().at("filter");sv_allocation::failBackendAtForContracts(ordinal);const auto *reply=sv_step(1);sv_allocation::failBackendAtForContracts(0);value=parsed(reply);
            if(value.at("ok")==true){require(value.at("filter").at("changed")==true&&nativeMask()==Bytes({0,1,0,0,0}),"Accepted allocation retry lost equal-count change");succeeded=true;break;}
            ++failures;++backendRefusals;require(summary().at("filter")==metadata&&nativeMask()==entry&&sv_states_ptr()==pointer,
                "Allocation refusal published changed before the candidate mask");
        }
        require(succeeded&&failures>0,"Changed publication sweep did not prove refusal and success");
        auto value=preview(id,++epoch,"sphere",sphere(0,{0,0,0}));for(unsigned i=0;i<6;++i){value=parsed(sv_step(1));require(value.at("ok")==true&&value.at("pending")==true,"Changed response fixture completed early");}
        const auto metadata=summary().at("filter");const auto before=nativeMask();sv_response::refuseNextSummaryForContracts();value=parsed(sv_step(1));++publicationRefusals;
        require(value.at("ok")==false&&summary().at("filter")==metadata&&summary().at("filter").at("changed")==true&&nativeMask()==before,
            "Reply refusal published unchanged metadata ahead of mask");command(Json{{"command","cancelFilter"},{"id",id}});
    });
    changedTest("transient-recovery-and-source-replacement",[] {
        require(open().at("ok")==true,"Changed recovery fixture failed");command(R"({"command":"single","index":4,"operation":0})");const auto baseline=nativeMask();
        const auto id=beginNative("sphere");finishNative(preview(id,1,"sphere",sphere(0,{0,0,0})));
        require(summary().at("filter").at("changed")==true,"Recovery fixture did not change filter");const auto plan=parsed(sv_recovery_prepare());
        require(plan.at("ok")==true&&(plan.at("normalizationFlags").get<unsigned>()&3)==3&&!plan.contains("filter"),"Filter changed leaked into durable recovery plan");
        Bytes bytes;for(unsigned at=0,total=plan.at("byteLength").get<unsigned>();at<total;){const auto n=std::min(257u,total-at);const auto *p=sv_recovery_read(at,n);require(p&&sv_recovery_read_size()==n,"Filter recovery read failed");bytes.insert(bytes.end(),p,p+n);at+=n;}sv_recovery_release();
        const Json expected{{"codecVersion",3},{"currentLoadedCount",plan.at("currentLoadedCount")},{"currentSourceCount",plan.at("currentSourceCount")},
            {"currentDuplicateRange",plan.at("currentDuplicateRange")},{"maximumGraphSplats",plan.at("maximumGraphSplats")},{"originalSourceCount",5},
            {"revision",plan.at("revision")},{"contentRevision",plan.at("contentRevision")},{"nextContentRevision",plan.at("nextContentRevision")}};
        const auto text=expected.dump();require(parsed(sv_recovery_restore_begin(unsigned(bytes.size()),expected.at("maximumGraphSplats").get<unsigned>(),64*1024*1024,text.c_str())).at("ok")==true,"Filter recovery begin failed");
        require(parsed(sv_recovery_restore_write(0,bytes.data(),unsigned(bytes.size()))).at("ok")==true,"Filter recovery write failed");
        const auto restored=parsed(sv_recovery_restore_finish());require(restored.at("ok")==true&&restored.at("filter").is_null()&&nativeMask()==baseline,
            "Recovery retained transient filter changed or failed baseline normalization");
        const auto fresh=beginNative("sphere");finishNative(preview(fresh,1,"sphere",sphere()));require(open().at("ok")==true&&summary().at("filter").is_null(),
            "Source replacement retained changed filter metadata");
    });
}
void publicationContracts() {
    test([] {
        require(open().at("ok")==true,"Publication fixture failed");const auto entry=nativeMask();const auto initial=summary();
        sv_response::refuseNextSummaryForContracts();const auto failed=command(R"({"command":"beginFilter","kind":"sphere"})");++publicationRefusals;
        require(failed.at("ok")==false&&summary().at("filter").is_null()&&nativeMask()==entry&&summary().at("revision")==initial.at("revision"),"Begin response refusal published draft/owner");
        const auto id=beginNative("sphere");const auto owner=summary().at("filter");
        sv_response::refuseNextSummaryForContracts();require(preview(id,1,"sphere",sphere()).at("ok")==false,"Preview-start gate did not refuse");++publicationRefusals;
        require(summary().at("filter")==owner&&nativeMask()==entry&&!summary().at("pending").get<bool>(),"Preview-start refusal published epoch/job");
        expectNativeRefusal({{"command","previewFilter"},{"id",id},{"epoch",1},{"kind","sphere"},{"parameters",sphere()},{"operation",0}});
        auto value=preview(id,2,"sphere",sphere());
        // Allocation +5 source evaluations leave final Ready publication for
        // the next single-action step; inject the real bounded response gate.
        for(unsigned i=0;i<6;++i) {value=parsed(sv_step(1));require(value.at("ok")==true&&value.at("pending")==true,"Filter completed before publication gate fixture");}
        sv_response::refuseNextSummaryForContracts();value=parsed(sv_step(1));++publicationRefusals;
        require(value.at("ok")==false&&nativeMask()==entry&&summary().at("filter").at("previewEpoch").is_null()&&
            summary().at("filter").at("epoch")==2&&!summary().at("pending").get<bool>(),"Preview publication refusal changed current mask/metadata");
        finishNative(preview(id,3,"sphere",sphere()));const auto lastMask=nativeMask();const auto lastMetadata=summary().at("filter");
        for(const auto *action:{"confirmFilter","cancelFilter","resetCleanup"}) {
            Json request{{"command",action}};if(std::string_view(action)!="resetCleanup") request["id"]=id;
            if(std::string_view(action)=="confirmFilter") request["epoch"]=3;
            sv_response::refuseNextSummaryForContracts();require(command(request).at("ok")==false,"Filter end/reset publication gate did not refuse");++publicationRefusals;
            require(nativeMask()==lastMask&&summary().at("filter")==lastMetadata,"End/reset response refusal altered current owner/mask");
        }
        command(Json{{"command","cancelFilter"},{"id",id}});
    });
    test([] {
        require(open().at("ok")==true,"Transaction publication fixture failed");const auto id=beginNative("sphere");finishNative(preview(id,1,"sphere",sphere(0)));
        const auto before=nativeMask();const auto metadata=summary().at("filter");
        sv_response::refuseNextSummaryForContracts();require(command(R"({"command":"beginTransaction"})").at("ok")==false,"Filter transaction begin gate did not refuse");++publicationRefusals;
        require(!summary().at("transaction").get<bool>()&&nativeMask()==before&&summary().at("filter")==metadata,"Refused begin checkpoint mutated transaction/filter");
        require(command(R"({"command":"beginTransaction"})").at("transaction")==true,"Retry filter transaction begin failed");
        finishNative(preview(id,2,"sphere",sphere(1)));const auto displayed=nativeMask();const auto latest=summary().at("filter");
        for(const auto *action:{"commitTransaction","rollbackTransaction"}) {
            sv_response::refuseNextSummaryForContracts();require(command(Json{{"command",action}}).at("ok")==false,"Filter transaction end gate did not refuse");++publicationRefusals;
            require(summary().at("transaction")==true&&nativeMask()==displayed&&summary().at("filter")==latest,"Refused transaction end altered filter/checkpoint/mask");
        }
        require(command(R"({"command":"rollbackTransaction"})").at("filter")==metadata&&nativeMask()==before,"Retry rollback did not restore complete filter snapshot");
        command(Json{{"command","cancelFilter"},{"id",id}});
        require(command(R"({"command":"beginTransaction"})").at("transaction")==true,"Outer filter begin fixture failed");
        const auto id2=beginNative("sphere");finishNative(preview(id2,1,"sphere",sphere()));command(Json{{"command","confirmFilter"},{"id",id2},{"epoch",1}});
        const auto result=nativeMask();sv_response::refuseNextSummaryForContracts();
        require(command(R"({"command":"commitTransaction"})").at("ok")==false&&summary().at("transaction")==true&&nativeMask()==result,"Ended filter lost transaction domain before commit refusal");++publicationRefusals;
        command(R"({"command":"rollbackTransaction"})");require(nativeMask()==Bytes({0,0,0,0,0})&&summary().at("filter").is_null(),"Outer transaction rollback did not restore pre-filter entry");
    });
    test([] {
        require(open().at("ok")==true,"Backend refusal fixture failed");const auto entry=nativeMask();
        size_t failures=0;bool succeeded=false;
        for(size_t ordinal=1;ordinal<200&&!succeeded;++ordinal) {
            // The independent test DOM does not exist during injected execution.
            const auto census=sv_allocation::snapshot();sv_allocation::failBackendAtForContracts(ordinal);
            const auto *text=sv_command(R"({"command":"beginFilter","kind":"sphere"})");
            sv_allocation::failBackendAtForContracts(0);const auto value=parsed(text);
            if(value.at("ok")==false) {++failures;++backendRefusals;require(summary().at("filter").is_null()&&nativeMask()==entry,"Backend admission refusal published partial begin");
                require(sameCensus(census,sv_allocation::snapshot()),"Failed begin leaked native admitted/raw/context storage");}
            else {succeeded=true;command(Json{{"command","cancelFilter"},{"id",value.at("filter").at("id")}});}
            require(!sv_json_bounded_recursive_destroy_active(),"Filter request destruction authority leaked");
        }
        require(succeeded&&failures>=5,"Begin backend sweep did not reach actual request/history candidate allocations");
        const auto id=beginNative("sphere");
        for(size_t ordinal=1;ordinal<200;++ordinal) {
            const auto request=Json{{"command","previewFilter"},{"id",id},{"epoch",ordinal},{"kind","sphere"},{"parameters",sphere()},{"operation",0}}.dump();
            const auto census=sv_allocation::snapshot();sv_allocation::failBackendAtForContracts(ordinal);const auto *text=sv_command(request.c_str());sv_allocation::failBackendAtForContracts(0);
            const auto value=parsed(text);
            if(value.at("ok")==true) {command(R"({"command":"cancel"})");break;}
            ++backendRefusals;require(summary().at("filter").at("epoch")==0&&nativeMask()==entry,"Preview admission refusal changed last epoch/mask");
            require(sameCensus(census,sv_allocation::snapshot()),"Failed preview admission leaked native admitted/raw/context storage");
            require(ordinal<199,"Preview backend sweep never reached success");
        }
        command(Json{{"command","cancelFilter"},{"id",id}});
    });
}
}
int main() {
    try {
        predicateContracts();admissionContracts();nativeContracts();publicationContracts();changedContracts();
        std::printf("SPLATVIEW_FILTER_CHANGED_CONTRACTS_PASS groups=%zu checks=%zu\n",changedGroups,checks);
        std::printf("Filter contracts passed: %zu cases, %zu checks, %zu ABI predicates, %zu refusals, %zu publication refusals, %zu backend refusals, %zu cancellation phases; ownerBytes=%zu.\n",
            cases,checks,abiCases,refusals,publicationRefusals,backendRefusals,cancelPhases,sizeof(preview::browser_filter::Job));return 0;
    } catch(const std::exception &error) {
        sv_allocation::failBackendAtForContracts(0);sv_recovery_release();sv_recovery_restore_cancel();
        std::fprintf(stderr,"Filter contracts failed after %zu cases/%zu checks: %s\n",cases,checks,error.what());return 1;
    }
}
