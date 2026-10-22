#include "browser_duplicate.hpp"
#include "allocation_census.hpp"
#include <algorithm>
#include <cstring>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace preview {
struct HistoryAdmissionTestAccess {
    static void failAppend(SceneEdits &edits,bool fail) {
        edits.historyCheckpoint_=fail?+[](void *,std::string_view seam){if(seam=="history.append")throw std::bad_alloc();}:nullptr;
    }
    static void identities(SceneEdits &edits,uint64_t revision,uint64_t content,uint64_t next) {
        edits.revision_=revision;edits.contentRevision_=content;edits.nextContentRevision_=next;
    }
};
}
namespace {
using namespace preview;
using namespace preview::browser_duplicate;
size_t groups{},admissionFailures{},backendFailures{};
void require(bool value,const char *message){if(!value)throw std::runtime_error(message);}
template<class F>void refuses(F &&action){try{action();}catch(const std::exception &){return;}throw std::runtime_error("Expected refusal");}
struct Fault {size_t calls{},failAt{};};
struct Memory final:SceneMemory {
    struct Stats {size_t bytes{},grants{};};
    struct Grant {
        std::shared_ptr<Stats> stats;size_t bytes;
        Grant(std::shared_ptr<Stats> s,size_t n):stats(std::move(s)),bytes(n){stats->bytes+=n;++stats->grants;}
        ~Grant(){stats->bytes-=bytes;--stats->grants;}
    };
    std::shared_ptr<Fault> fault;std::shared_ptr<Stats> stats=std::make_shared<Stats>();
    size_t calls{};
    explicit Memory(std::shared_ptr<Fault> f=std::make_shared<Fault>()):fault(std::move(f)){}
    std::shared_ptr<void> admit(size_t bytes) override {
        ++calls;++fault->calls;if(fault->failAt==fault->calls)throw std::bad_alloc();
        return std::make_shared<Grant>(stats,bytes);
    }
};
std::shared_ptr<Scene> fixture(size_t n,unsigned degree=0) {
    auto scene=std::make_shared<Scene>();scene->gaussians.resize(n);scene->sourceCount=n;scene->shDegree=degree;
    for(size_t i=0;i<n;++i) {
        auto *bytes=reinterpret_cast<unsigned char *>(&scene->gaussians[i]);
        for(size_t j=0;j<sizeof(Gaussian);++j)bytes[j]=static_cast<unsigned char>((i*31+j*7)&255);
        // Finite centers; all other bytes exercise inactive SH and padding too.
        scene->gaussians[i].positionOpacity={float(i),0,0,.5f};
    }
    scene->sourceFaces=27;scene->sampledGeometry=true;scene->center={2,3,4};scene->radius=7;
    scene->previewEye=Vec3{9,8,7};scene->defaultView=SavedView{{1,2,3},.1f,.2f,5,60,true,.3f};
    scene->alignmentFrame[12]=13;scene->yUp=true;scene->format="fixture";
    scene->sourceContentKey="immutable-content";scene->sourceFileIdentity="immutable-file";scene->sourceBytes=12345;
    return scene;
}
bool sameBytes(const Gaussian &a,const Gaussian &b){return std::memcmp(&a,&b,sizeof(Gaussian))==0;}
void finish(Job &job,size_t work=maximumStepWork) {
    while(job.status()==Status::Working){job.step(work);require(job.lastStepWork()<=std::min(work,maximumStepWork),"Unbounded step");}
    require(job.status()==Status::Ready,"Job did not become ready");
}
void metadata(const Scene &a,const Scene &b) {
    require(a.type==b.type&&a.sourceFaces==b.sourceFaces&&a.sampledGeometry==b.sampledGeometry&&a.center==b.center&&
        a.radius==b.radius&&a.previewEye==b.previewEye&&a.defaultView==b.defaultView&&a.alignmentFrame==b.alignmentFrame&&
        a.shDegree==b.shDegree&&a.yUp==b.yUp&&a.format==b.format&&a.sourceContentKey==b.sourceContentKey&&
        a.sourceFileIdentity==b.sourceFileIdentity&&a.sourceBytes==b.sourceBytes,"Scene metadata changed");
}
struct HistoryEntry {
    const void *changes{},*before{},*after{},*beforeMask{},*afterMask{};
    size_t size{};uint64_t beforeContent{},afterContent{};
    bool operator==(const HistoryEntry &) const=default;
};
template<class Stack>std::vector<HistoryEntry> history(const Stack &stack) {
    std::vector<HistoryEntry> result;
    for(const auto &r:stack)result.push_back({r.changes.data(),r.before.get(),r.after.get(),r.beforeStates.data(),
        r.afterStates.data(),r.changes.size(),r.beforeContent,r.afterContent});
    return result;
}
struct Snapshot {
    std::shared_ptr<const Scene> scene;MaskStorage mask;std::vector<uint8_t> bytes;
    uint64_t revision{},content{},next{};size_t selected{},visible{};
    std::vector<HistoryEntry> undo,redo;
    explicit Snapshot(const SceneEdits &edits):scene(edits.scene()),mask(edits.maskSnapshot()),
        bytes(edits.states().begin(),edits.states().end()),revision(edits.revision()),content(edits.contentRevision()),
        next(BrowserSelectionAccess::recoveryNextContent(edits)),selected(edits.selectedCount()),visible(edits.visibleCount()),
        undo(history(BrowserSelectionAccess::recoveryUndo(edits))),redo(history(BrowserSelectionAccess::recoveryRedo(edits))){}
    void unchanged(const SceneEdits &edits) const {
        require(edits.scene()==scene&&edits.states().data()==mask.data()&&edits.states().size()==bytes.size()&&
            std::equal(bytes.begin(),bytes.end(),edits.states().begin())&&edits.revision()==revision&&
            edits.contentRevision()==content&&BrowserSelectionAccess::recoveryNextContent(edits)==next&&
            edits.selectedCount()==selected&&edits.visibleCount()==visible&&
            history(BrowserSelectionAccess::recoveryUndo(edits))==undo&&history(BrowserSelectionAccess::recoveryRedo(edits))==redo,
            "Refusal changed live owner, mask, identity or history");
    }
};
void setupRedo(SceneEdits &edits,size_t depth=0) {
    for(size_t i=0;i<depth;++i)edits.selectSingle(uint32_t(1+i%2),SelectOperation::Set);
    edits.selectSingle(0,SelectOperation::Set);edits.selectSingle(2,SelectOperation::Add);
    edits.selectSingle(3,SelectOperation::Add);require(edits.undo()&&edits.canRedo(),"Redo fixture missing");
}
void exactBytesHistoryAndGuard() {
    for(unsigned degree=0;degree<=3;++degree) {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();
        auto original=fixture(4,degree);original->sourceCount=17;SceneEdits edits(original,history);Lineage lineage;
        edits.selectSingle(1,SelectOperation::Set);edits.deleteSelected();
        edits.selectSingle(3,SelectOperation::Set);edits.selectSingle(0,SelectOperation::Add);
        const auto before=edits.maskSnapshot();const auto beforeContent=edits.contentRevision();
        const auto undoCount=BrowserSelectionAccess::recoveryUndo(edits).size();const auto revision=edits.revision();
        Job job(edits,lineage,work,history);job.step(1);
        require(edits.scene()==original&&edits.states().data()==before.data(),"Partial job published");
        finish(job,3);job.publish(edits,lineage);const auto grown=edits.scene();const auto after=edits.maskSnapshot();
        require(grown->gaussians.size()==6&&grown->sourceCount==19&&edits.selectedCount()==2&&edits.visibleCount()==5,
            "Wrong append cardinality/counts");
        require(std::memcmp(grown->gaussians.data(),original->gaussians.data(),4*sizeof(Gaussian))==0,"Original bytes/order changed");
        require(sameBytes(grown->gaussians[4],original->gaussians[0])&&sameBytes(grown->gaussians[5],original->gaussians[3]),
            "Full-byte ascending copies differ");
        require(std::equal(edits.states().begin(),edits.states().end(),std::array<uint8_t,6>{0,2,0,0,1,1}.begin()),"Mask semantics differ");
        metadata(*grown,*original);const auto range=lineage.find(grown);
        require(range&&range->first==4&&range->count==2&&!lineage.find(original),"Wrong scene-owned suffix");
        require(edits.contentRevision()==beforeContent+1&&edits.revision()==revision+1&&
            BrowserSelectionAccess::recoveryUndo(edits).size()==undoCount+1,"Append did not make exactly one history entry");
        require(edits.undo()&&edits.scene()==original&&edits.states().data()==before.data()&&edits.contentRevision()==beforeContent,
            "Undo lost exact small owners");
        require(!lineage.find(edits.scene()),"Undo kept grown marker on old scene");
        require(edits.redo()&&edits.scene()==grown&&edits.states().data()==after.data()&&lineage.find(edits.scene()),"Redo lost grown owners/marker");
        const Snapshot guardedBefore(edits);const auto calls=work->calls+history->calls;
        Job guarded(edits,lineage,work,history);refuses([&]{finish(guarded);});guardedBefore.unchanged(edits);
        require(work->calls+history->calls==calls,"Untouched guard allocated payload");
        // A proper subset and a selection including an original both release the guard.
        edits.selectSingle(4,SelectOperation::Set);Job subset(edits,lineage,work,history);finish(subset);subset.cancel();
        edits.selectSingle(5,SelectOperation::Add);edits.selectSingle(0,SelectOperation::Add);
        Job again(edits,lineage,work,history);finish(again);again.publish(edits,lineage);
        require(edits.scene()->gaussians.size()==9&&!edits.canRedo(),"Changed selection stayed guarded");
    }
}
void lineageOwnershipAndEdits() {
    Lineage lineage;require(!lineage.find({})&&!lineage.associate({}, {0,1}),"Null owner has marker");
    auto scene=fixture(4);
    for(const auto range:std::array<Range,4>{{{0,0},{0,1},{5,1},{4,1}}})require(!lineage.associate(scene,range),"Non-suffix marker accepted");
    scene->type=SceneType::PointCloud;require(!lineage.associate(scene,{3,1})&&!lineage.find(scene),"Geometry marker accepted");
    scene->type=SceneType::GaussianSplats;require(lineage.associate(scene,{3,1}),"Valid suffix refused");
    std::weak_ptr<const Scene> expired=scene;scene.reset();require(expired.expired()&&!lineage.find({}),"Expired owner remained live");
    auto replacement=fixture(4);require(!lineage.find(replacement)&&lineage.associate(replacement,{3,1}),"Expired slot not reusable");
    auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(2),history);lineage.clear();
    edits.selectSingle(0,SelectOperation::Set);Job duplicate(edits,lineage,work,history);finish(duplicate);duplicate.publish(edits,lineage);
    const auto copied=edits.scene();
    for(bool transform:{false,true}) {
        auto changed=std::make_shared<Scene>(*copied);
        if(transform)changed->gaussians[2].positionOpacity[0]+=1;else changed->gaussians[2].sh[0]^=1;
        edits.replaceScene(changed,edits.states());require(!lineage.find(edits.scene()),"Ordinary attribute edit inherited marker");
        Job permitted(edits,lineage,work,history);finish(permitted);permitted.cancel();
        require(edits.undo()&&edits.scene()==copied&&lineage.find(edits.scene()),"Attribute Undo lost duplicate marker");
        Job guarded(edits,lineage,work,history);refuses([&]{finish(guarded);});
        require(edits.redo()&&edits.scene()==changed&&!lineage.find(edits.scene()),"Attribute Redo inherited marker");
        require(edits.undo()&&edits.scene()==copied,"Attribute fixture reset failed");
    }
    std::vector<std::shared_ptr<Scene>> owners;Lineage full;
    for(size_t i=0;i<64;++i){owners.push_back(fixture(1));require(full.associate(owners.back(),{0,1}),"Lineage filled early");}
    SceneEdits blocked(fixture(4),history);setupRedo(blocked);const Snapshot before(blocked);
    Job job(blocked,full,work,history);finish(job);refuses([&]{job.publish(blocked,full);});before.unchanged(blocked);
    require(!full.find(blocked.scene())&&full.find(owners.back()),"Full lineage evicted owner");
    owners.front().reset();job.publish(blocked,full);require(full.find(blocked.scene()).has_value(),"Expired lineage slot retry failed");
}
void capturedView() {
    auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();auto scene=fixture(4);scene->sourceCount=11;
    const std::array<float,4> x{0,100,.5f,200};for(size_t i=0;i<4;++i)scene->gaussians[i].positionOpacity[0]=x[i];
    // Huge covariance on the outside center still must not intersect the scope.
    scene->gaussians[1].covA={1e10f,0,0,1e10f};scene->gaussians[1].covB={0,1e10f,0,0};
    SceneEdits edits(scene,history);Lineage lineage;edits.selectAll();
    const auto scope=browser_view_scope::parse(nlohmann::json{{"selectionView",{0,0,0,0,0,5,1,60,1,0,1}}});
    require(scope.contains(scene->gaussians[0])&&!scope.contains(scene->gaussians[1])&&
        scope.contains(scene->gaussians[2])&&!scope.contains(scene->gaussians[3]),"View fixture differs from literal center oracle");
    BrowserSelectionAccess::selectionView(edits,scope);Job job(edits,lineage,work,history);job.step(1);
    // Camera changes after admission must not retarget any later phase.
    BrowserSelectionAccess::selectionView(edits,{});finish(job,1);job.publish(edits,lineage);
    require(edits.scene()->gaussians.size()==6&&edits.scene()->sourceCount==13&&
        sameBytes(edits.scene()->gaussians[4],scene->gaussians[0])&&sameBytes(edits.scene()->gaussians[5],scene->gaussians[2]),
        "Duplicate did not retain admitted center-only view");
    require(std::equal(edits.states().begin(),edits.states().end(),std::array<uint8_t,6>{0,0,0,0,1,1}.begin()),"Outside selection not cleared");
    require(edits.undo()&&edits.selectedCount()==4&&edits.redo()&&edits.selectedCount()==2,"Scoped Undo/Redo mask changed");
    SceneEdits outside(scene,history);outside.selectSingle(1,SelectOperation::Set);BrowserSelectionAccess::selectionView(outside,scope);
    const Snapshot before(outside);const auto calls=work->calls+history->calls;Job empty(outside,lineage,work,history);
    refuses([&]{finish(empty);});before.unchanged(outside);require(work->calls+history->calls==calls,"Empty view admitted payload");
}
void limitsAndIdentity() {
    constexpr auto maximum=std::numeric_limits<uint32_t>::max();
    for(uint64_t source:{uint64_t(0),uint64_t(maximum),uint64_t(maximum)+1,std::numeric_limits<uint64_t>::max()}) {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();auto scene=fixture(1);scene->sourceCount=source;
        SceneEdits edits(scene,history);edits.selectAll();Lineage lineage;const Snapshot before(edits);const auto calls=work->calls+history->calls;
        refuses([&]{Job job(edits,lineage,work,history);finish(job);});before.unchanged(edits);
        require(work->calls+history->calls==calls,"Invalid source count allocated candidate");
    }
    {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();auto scene=fixture(1);scene->sourceCount=uint64_t(maximum)-1;
        SceneEdits edits(scene,history);edits.selectAll();Lineage lineage;Job job(edits,lineage,work,history);finish(job);job.publish(edits,lineage);
        require(edits.scene()->sourceCount==maximum,"Exact uint32 source limit refused");
    }
    constexpr auto maxId=sv_operation::maximumIdentity;
    const std::array<std::array<uint64_t,3>,6> exhausted{{{maxId,0,0},{0,maxId,maxId},{0,0,maxId},
        {std::numeric_limits<uint64_t>::max(),0,0},{0,0,std::numeric_limits<uint64_t>::max()},{0,2,1}}};
    for(const auto &ids:exhausted) {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(4),history);setupRedo(edits);
        HistoryAdmissionTestAccess::identities(edits,ids[0],ids[1],ids[2]);Lineage lineage;const Snapshot before(edits);const auto calls=work->calls+history->calls;
        refuses([&]{Job job(edits,lineage,work,history);});before.unchanged(edits);
        require(work->calls+history->calls==calls,"Exhausted identity allocated candidate");
    }
    {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(1),history);edits.selectAll();Lineage lineage;
        HistoryAdmissionTestAccess::identities(edits,maxId-1,maxId-1,maxId-1);Job edge(edits,lineage,work,history);finish(edge);edge.publish(edits,lineage);
        require(edits.revision()==maxId&&edits.contentRevision()==maxId,"Exact identity limit refused");
    }
    {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(4),history);setupRedo(edits);Lineage lineage;
        Job job(edits,lineage,work,history);finish(job);
        HistoryAdmissionTestAccess::identities(edits,edits.revision(),edits.contentRevision(),maxId);const Snapshot before(edits);
        refuses([&]{job.publish(edits,lineage);});before.unchanged(edits);require(!lineage.find(edits.scene()),"Late identity refusal published lineage");
    }
    {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();Lineage lineage;
        SceneEdits edits(fixture(sceneLimit-1),history);edits.selectSingle(uint32_t(sceneLimit-2),SelectOperation::Set);
        const auto original=edits.scene();Job job(edits,lineage,work,history);finish(job,std::numeric_limits<size_t>::max());job.publish(edits,lineage);
        require(edits.scene()->gaussians.size()==sceneLimit&&edits.scene()->sourceCount==sceneLimit&&
            std::memcmp(edits.scene()->gaussians.data(),original->gaussians.data(),(sceneLimit-1)*sizeof(Gaussian))==0&&
            sameBytes(edits.scene()->gaussians.back(),original->gaussians.back()),"Exact 1M append failed");
        require(edits.undo()&&edits.scene()==original&&edits.redo()&&edits.scene()->gaussians.size()==sceneLimit,"1M history cardinality failed");
        const Snapshot before(edits);const auto calls=work->calls+history->calls;Job cap(edits,lineage,work,history);
        refuses([&]{finish(cap);});before.unchanged(edits);require(work->calls+history->calls==calls,"Cap+1 allocated or published");
    }
}
void cancellationStaleAndHistory() {
    for(size_t steps:{size_t(0),size_t(5),size_t(6),size_t(9),size_t(100)}) {
        auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(4),history);setupRedo(edits);Lineage lineage;
        const Snapshot before(edits);const auto historyBytes=history->stats->bytes;Job job(edits,lineage,work,history);job.step(steps);job.cancel();
        before.unchanged(edits);require(job.status()==Status::Cancelled&&work->stats->bytes==0&&history->stats->bytes==historyBytes,"Cancel retained candidate payload");
        refuses([&]{job.publish(edits,lineage);});
    }
    auto work=std::make_shared<Memory>(),history=std::make_shared<Memory>();SceneEdits edits(fixture(4),history);setupRedo(edits);Lineage lineage;
    const Snapshot before(edits);Job stopped(edits,lineage,work,history);std::stop_source stop;stop.request_stop();stopped.step(4096,stop.get_token());
    before.unchanged(edits);require(stopped.status()==Status::Cancelled&&work->calls==0,"Stop request admitted candidate");
    Job late(edits,lineage,work,history);finish(late);HistoryAdmissionTestAccess::failAppend(edits,true);
    refuses([&]{late.publish(edits,lineage);});HistoryAdmissionTestAccess::failAppend(edits,false);before.unchanged(edits);
    require(!lineage.find(edits.scene())&&late.status()==Status::Ready,"History refusal published lineage or lost retry");
    late.publish(edits,lineage);require(edits.undo(),"History retry lost Undo");
    Job stale(edits,lineage,work,history);finish(stale);edits.selectAll();const Snapshot changed(edits);
    refuses([&]{stale.publish(edits,lineage);});changed.unchanged(edits);
    Job replaced(edits,lineage,work,history);finish(replaced);edits.replaceScene(fixture(4),edits.states());const Snapshot replacement(edits);
    refuses([&]{replaced.publish(edits,lineage);});replacement.unchanged(edits);
    edits.beginSelectionDraft();const Snapshot draft(edits);refuses([&]{Job invalid(edits,lineage,work,history);});draft.unchanged(edits);
}
size_t observedAttempts{};bool backendFailed{};
void observe(const sv_allocation::Event &event) noexcept {
    if(event.kind==sv_allocation::EventKind::NewAttempt)++observedAttempts;
    if(event.kind==sv_allocation::EventKind::BackendFailure)backendFailed=true;
}
// Sweep both admission grants and the existing intercepted-C++-new backend.
// Raw malloc, exception ABI storage and external host allocators are excluded.
size_t allocationRun(size_t depth,size_t ordinal,bool backend) {
    auto fault=std::make_shared<Fault>();auto work=std::make_shared<Memory>(fault),history=std::make_shared<Memory>(fault);
    SceneEdits edits(fixture(4),history);setupRedo(edits,depth);Lineage lineage;const Snapshot before(edits);
    const auto historyBytes=history->stats->bytes;fault->calls=0;fault->failAt=backend?0:ordinal;
    observedAttempts=0;backendFailed=false;if(backend){sv_allocation::setObserverForContracts(observe);sv_allocation::failBackendAtForContracts(ordinal);}
    bool failed=false;std::unique_ptr<Job> job;
    try {job=std::make_unique<Job>(edits,lineage,work,history);finish(*job,1);job->publish(edits,lineage);}
    catch(const std::bad_alloc &){failed=true;}
    if(backend){sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);}
    const auto count=backend?observedAttempts:fault->calls;fault->failAt=0;job.reset();
    if(ordinal) {
        require(failed&&(!backend||backendFailed),"Requested allocation refusal did not reach caller");before.unchanged(edits);
        require(!lineage.find(edits.scene())&&work->stats->bytes==0&&history->stats->bytes==historyBytes,"Allocation refusal retained candidate");
        require(edits.redo()&&edits.selectedCount()==3,"Allocation refusal corrupted Redo payload");
        if(backend)++backendFailures;else ++admissionFailures;
    } else require(!failed&&edits.scene()->gaussians.size()==6&&!edits.canRedo(),"Allocation reference run failed");
    return count;
}
void allocationOrdinals() {
    // Vary deque position so sweeps include history block/map growth rather
    // than relying on one implementation's fixed block size.
    for(size_t depth=0;depth<8;++depth)for(bool backend:{false,true}) {
        const auto count=allocationRun(depth,0,backend);require(count>0,"Allocation sweep empty");
        for(size_t ordinal=1;ordinal<=count;++ordinal)allocationRun(depth,ordinal,backend);
    }
}
template<class F>void group(const char *name,F &&run){run();++groups;std::cout<<"PASS "<<name<<'\n';}
}
int main() {
    try {
        group("SH0-SH3 exact bytes, masks, one history entry and repeated-copy guard",exactBytesHistoryAndGuard);
        group("suffix ownership, null/expired/full lineage and attribute edit lifetime",lineageOwnershipAndEdits);
        group("captured camera center-only scope and empty-view refusal",capturedView);
        group("uint32 source, shared identity and exact 1M boundaries",limitsAndIdentity);
        group("cancellation, stale publication, draft and history refusal atomicity",cancellationStaleAndHistory);
        group("admission and intercepted C++ new allocation ordinal sweeps",allocationOrdinals);
        std::cout<<"Duplicate contracts passed: groups="<<groups<<" admission-refusals="<<admissionFailures
            <<" backend-refusals="<<backendFailures<<" sizeof(Job)="<<sizeof(Job)<<" sizeof(Lineage)="<<sizeof(Lineage)<<'\n';return 0;
    } catch(const std::exception &e) {
        sv_allocation::failBackendAtForContracts(0);sv_allocation::setObserverForContracts(nullptr);
        std::cerr<<e.what()<<'\n';return 1;
    }
}