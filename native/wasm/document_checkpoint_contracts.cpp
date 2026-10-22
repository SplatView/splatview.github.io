// Private direct checkpoint contracts. No C ABI, camera, or browser observer is
// involved in the expected fixed target and original Reset mask membership.
#include "browser_document_checkpoint.hpp"
#include "selection_checkpoint.hpp"
#include "picosha2.h"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>

namespace {
using namespace preview;
namespace cp=browser_checkpoint;
namespace cm=browser_color_metadata;
namespace bt=browser_transform;
namespace bo=browser_opacity;
namespace bd=browser_duplicate;
using Bytes=std::vector<uint8_t>;
enum class Family { Color,Transform,Opacity };
constexpr unsigned allowance=16*1024*1024;
constexpr std::array<uint8_t,4> original{1,1,2,0},clipped{0,1,2,0};
size_t cases{},checks{},legacyReads{},scopedResumes{},refusals{};
void require(bool condition,const char *message) { ++checks;if(!condition)throw std::runtime_error(message); }
template<class Action>void test(Action action) { action();++cases; }
bool same(const MaskStorage &actual,std::span<const uint8_t> expected) {
    return actual.size()==expected.size()&&std::equal(actual.begin(),actual.end(),expected.begin());
}
bool owner(const MaskStorage &a,const MaskStorage &b) {
    return BrowserSelectionAccess::recoveryMaskOwner(a)==BrowserSelectionAccess::recoveryMaskOwner(b);
}
struct Fixture {
    ResourceBudget budget{allowance};
    std::shared_ptr<SceneMemory> history=sceneMemoryForBudget(budget,ResourceCategory::History);
    std::shared_ptr<SceneMemory> work=sceneMemoryForBudget(budget,ResourceCategory::Work);
    std::shared_ptr<Scene> scene=std::make_shared<Scene>(sceneMemoryForBudget(budget,ResourceCategory::Decoded));
    MaskStorage states=MaskStorage::copy(original,history),effective;
    std::unique_ptr<SceneEdits> edits;
    cm::BrowserColorSession color;
    std::optional<bt::Owner> transform;
    std::optional<bo::Owner> opacity;
    cp::Identities identities;
    bd::Lineage duplicateLineage;
    uint64_t originalSourceCount{4};
    Family family;
    Fixture(Family kind,bool scoped=true,bool alias=false):family(kind) {
        scene->sourceCount=4;scene->format="checkpoint-contract";scene->sourceContentKey="literal-source";scene->radius=7;
        scene->gaussians.resize(4);
        for(size_t i=0;i<4;++i) {
            auto &g=scene->gaussians[i];g.positionOpacity={float(i)*2,0,0,.5f};
            g.covA={.01f,0,0,.02f};g.covB={0,.03f,7,8};
            for(size_t k=0;k<g.sh.size();++k)g.sh[k]=uint32_t(0x12340000+i*31+k);
        }
        edits=BrowserSelectionAccess::recoveryCreate(scene,states,history,work,4,0,0);
        identities.document=11;identities.next.fill(100);
        if(scoped)effective=alias?states:MaskStorage::copy(clipped,work);
        if(kind==Family::Color) {
            cm::IdSequence ids;
            require(color.begin({scene,states,11,11,4,0,true},true,effective,ids),"Scoped Color fixture did not begin");
        } else if(kind==Family::Transform) {
            bt::Owner value;value.id=1;value.baseId=2;value.epoch=3;value.selectedOnly=true;value.base=scene;
            value.states=states;value.effectiveStates=effective;value.acknowledged={scene,states,11,4,0,true};
            require(bt::plan(value.applied,value.appliedPlan),"Identity transform fixture plan failed");transform=std::move(value);
        } else {
            bo::Owner value;value.id=1;value.baseId=2;value.epoch=3;value.selectedOnly=true;value.base=scene;
            value.states=states;value.effectiveStates=effective;value.acknowledged={scene,states,11,4,0,true};opacity=std::move(value);
        }
    }
    cp::Source source() const { return {edits.get(),{},&color,nullptr,nullptr,&transform,&opacity,identities,0,&duplicateLineage}; }
};
struct Encoded { Bytes bytes;cp::Description description;cp::Restore::Expected expected; };
Encoded encode(const Fixture &fixture) {
    cp::Plan plan(fixture.source(),fixture.budget);Encoded result{{},plan.description()};result.bytes.reserve(result.description.byteLength);
    const auto &d=result.description;auto &e=result.expected;e.currentLoadedCount=d.currentLoadedCount;e.currentSourceCount=d.currentSourceCount;
    e.currentDuplicateRange=d.currentDuplicateRange;e.maximumGraphSplats=d.maximumGraphSplats;e.originalSourceCount=fixture.originalSourceCount;
    e.revision=d.revision;e.contentRevision=d.contentRevision;e.nextContentRevision=d.nextContentRevision;
    for(size_t at=0;at<result.description.byteLength;) {
        const auto count=std::min(size_t(17),result.description.byteLength-at);const auto part=plan.read(at,count);
        result.bytes.insert(result.bytes.end(),part.begin(),part.end());at+=count;
    }
    require(result.bytes[8]==3&&result.bytes[9]==0&&result.bytes[10]==0&&result.bytes[11]==0,"Writer did not emit internal checkpoint v3");
    return result;
}
cp::Candidate restore(const Encoded &encoded) {
    const auto &bytes=encoded.bytes;cp::Restore input(bytes.size(),encoded.expected,allowance,0);
    for(size_t at=0;at<bytes.size();) {
        const auto count=std::min(size_t(31),bytes.size()-at);input.write(at,std::span(bytes).subspan(at,count));at+=count;
    }
    require(input.written()==input.total(),"Chunked checkpoint input was not exact");return input.finish();
}
void put32(Bytes &bytes,size_t at,uint32_t value) { for(size_t i=0;i<4;++i)bytes[at+i]=uint8_t(value>>(i*8)); }
void put64(Bytes &bytes,size_t at,uint64_t value) { for(size_t i=0;i<8;++i)bytes[at+i]=uint8_t(value>>(i*8)); }
void refresh(Bytes &bytes) {
    for(size_t i=0;i<8;++i)bytes[16+i]=uint8_t(uint64_t(bytes.size())>>(i*8));
    picosha2::hash256_one_by_one hash;hash.process(bytes.begin()+64,bytes.end());hash.finish();hash.get_hash_bytes(bytes.begin()+24,bytes.begin()+56);
}
size_t effectiveOffset(Family family,const Bytes &bytes) {
    // A Color owner is followed by the three inactive owner flags; Transform
    // is followed only by inactive Opacity. Each v2-only ID is the final field.
    return bytes.size()-(family==Family::Color?7:family==Family::Transform?5:4);
}
struct SceneOffsets { size_t marker{},sourceCount{}; };
std::vector<SceneOffsets> sceneOffsets(const Bytes &bytes) {
    size_t at=64;const auto skip=[&](size_t n){require(at<=bytes.size()&&n<=bytes.size()-at,"Fixture parser overflow");at+=n;};
    const auto u8=[&](){skip(1);return bytes[at-1];};
    const auto u32=[&](){uint32_t n=0;for(size_t i=0;i<4;++i)n|=uint32_t(u8())<<(i*8);return n;};
    skip(4);const auto count=u32();skip(3*4+1+3*8+8+6*8+2*8+12*8);
    std::vector<SceneOffsets> result;
    for(size_t i=0;i<count;++i) {
        skip(1+8+1+16);if(u8())skip(12);if(u8())skip(33);skip(16*4);
        const auto sourceCount=at;skip(8+4+1+8+8);
        for(size_t n=0;n<3;++n){const auto length=u32();skip(length);}
        const auto ng=u32(),nv=u32(),nt=u32();const auto marker=at;
        if(u8())skip(8);result.push_back({marker,sourceCount});skip(size_t(ng)*144+size_t(nv)*16+size_t(nt)*12);
    }
    return result;
}
void legacy(Encoded &encoded,Family family,unsigned version) {
    require(version==1||version==2,"Fixture legacy version");
    if(version==1) {
        const auto at=effectiveOffset(family,encoded.bytes);
        require(std::all_of(encoded.bytes.begin()+at,encoded.bytes.begin()+at+4,[](uint8_t n){return n==0;}),"Legacy conversion removed a nonzero target ID");
        encoded.bytes.erase(encoded.bytes.begin()+at,encoded.bytes.begin()+at+4);
    }
    const auto offsets=sceneOffsets(encoded.bytes);
    for(auto it=offsets.rbegin();it!=offsets.rend();++it) {
        require(encoded.bytes[it->marker]==0,"Legacy fixture must not silently discard a marker");
        encoded.bytes.erase(encoded.bytes.begin()+it->marker);
    }
    put32(encoded.bytes,8,version);refresh(encoded.bytes);encoded.expected.codecVersion=version;
}
void duplicate(Fixture &fixture) {
    bd::Job job(*fixture.edits,fixture.duplicateLineage,fixture.work,fixture.history);
    for(size_t step=0;job.status()==bd::Status::Working;++step){require(step<10000,"Duplicate fixture stalled");job.step(2);}
    require(job.status()==bd::Status::Ready&&job.publish(*fixture.edits,fixture.duplicateLineage),"Duplicate fixture did not publish");
}
void verify(cp::Candidate &result,const Fixture &fixture,std::span<const uint8_t> target,bool effectivePresent,bool alias=false) {
    require(result.edits&&result.identities.document==11&&result.identities.next==fixture.identities.next,"Document/identity fences changed during recovery");
    const auto current=BrowserSelectionAccess::recoveryMask(*result.edits);
    require(same(current,original)&&result.edits->contentRevision()==0&&BrowserSelectionAccess::recoveryRevision(*result.edits)==4,"Canonical mask/revision changed during recovery");
    require(result.edits->scene()->gaussians.size()==4&&std::memcmp(result.edits->scene()->gaussians.data(),fixture.scene->gaussians.data(),4*sizeof(Gaussian))==0,"Recovery changed Gaussian record bits");
    MaskStorage effective,reset,acknowledged;
    if(fixture.family==Family::Color) {
        require(result.color.active(),"Color session was lost");const auto metadata=cp::Access::color(result.color);
        effective=metadata.effectiveStates;reset=acknowledged=metadata.acknowledged.states;
        require(metadata.base==result.edits->scene()&&metadata.selectedOnly,"Color base/scope changed");
        cm::IdSequence ids(result.identities.next[0]);auto values=neutralColor;values[0]=1.2f;
        require(result.color.preview(metadata.acknowledged,values,true,ids),"Restored Color preview was refused");
        const auto capture=result.color.captureManual(metadata.acknowledged,ids);
        require(capture.disposition==cm::CaptureDisposition::Captured&&capture.request.has_value(),"Restored Color capture was refused");
        require(owner(capture.request->states,current)&&same(capture.request->targetStates(),target),"Color request merged canonical and effective masks");
        require(result.color.cancel(*capture.request,metadata.acknowledged,ids),"Restored Color request could not cancel");
    } else if(fixture.family==Family::Transform) {
        require(result.transform.has_value(),"Transform session was lost");const auto &value=*result.transform;
        effective=value.effectiveStates;reset=value.states;acknowledged=value.acknowledged.states;
        require(value.base==result.edits->scene()&&value.id==1&&value.baseId==2&&value.epoch==3&&value.selectedOnly,"Transform owner metadata changed");
        bt::Parameters parameters;parameters.translation[0]=2;bt::Plan plan;require(bt::plan(parameters,plan),"Resume transform plan failed");
        auto job=bt::Job::create(value,parameters,plan,sceneMemoryForBudget(result.budget,ResourceCategory::Work));
        for(size_t step=0;job->status()==bt::Status::Working;++step) { require(step<10000,"Restored transform did not terminate");job->step(4); }
        require(job->status()==bt::Status::Ready&&bool(job->result()),"Restored transform did not produce a scene");
        for(size_t i=0;i<4;++i) { auto expected=fixture.scene->gaussians[i];if(target[i]==1)expected.positionOpacity[0]+=2;
            require(std::memcmp(&job->result()->gaussians[i],&expected,sizeof(Gaussian))==0,"Restored transform changed an excluded record or lost its fixed target"); }
    } else {
        require(result.opacity.has_value(),"Opacity session was lost");const auto &value=*result.opacity;
        effective=value.effectiveStates;reset=value.states;acknowledged=value.acknowledged.states;
        require(value.base==result.edits->scene()&&value.id==1&&value.baseId==2&&value.epoch==3&&value.selectedOnly,"Opacity owner metadata changed");
        auto job=bo::Job::create(value,2,sceneMemoryForBudget(result.budget,ResourceCategory::Work));
        for(size_t step=0;job->status()==bo::Status::Working;++step) { require(step<10000,"Restored opacity did not terminate");job->step(4); }
        require(job->status()==bo::Status::Ready&&bool(job->result()),"Restored opacity did not produce a scene");
        for(size_t i=0;i<4;++i) { auto expected=fixture.scene->gaussians[i];if(target[i]==1)expected.positionOpacity[3]=.75f;
            require(std::memcmp(&job->result()->gaussians[i],&expected,sizeof(Gaussian))==0,"Restored opacity changed an excluded record or lost its fixed target"); }
    }
    require(same(reset,original)&&owner(acknowledged,current),"Original Reset mask or canonical acknowledgement identity changed");
    require(effective.hasStorage()==effectivePresent,"Effective-mask absence/presence changed");
    if(effectivePresent)require(same(effective,target)&&owner(effective,current)==alias,"Effective target bytes or deduplicated owner identity changed");
    require(same(BrowserSelectionAccess::recoveryMask(*result.edits),original),"Resumed session changed the unpublished canonical document");
}
template<class Action>void refused(Fixture &fixture,Action action) {
    const auto scene=fixture.edits->scene();const auto mask=BrowserSelectionAccess::recoveryMask(*fixture.edits);
    const Bytes states(mask.begin(),mask.end());const auto revision=fixture.edits->revision(),content=fixture.edits->contentRevision();
    const auto next=BrowserSelectionAccess::recoveryNextContent(*fixture.edits);
    const auto undo=BrowserSelectionAccess::recoveryUndo(*fixture.edits).size(),redo=BrowserSelectionAccess::recoveryRedo(*fixture.edits).size();
    bool rejected=false;try { action(); } catch(const std::exception &) { rejected=true; }
    require(rejected,"Malformed/unadmitted checkpoint was accepted");++refusals;
    require(fixture.edits->scene()==scene&&owner(BrowserSelectionAccess::recoveryMask(*fixture.edits),mask)&&same(mask,states)&&
        fixture.edits->revision()==revision&&fixture.edits->contentRevision()==content&&BrowserSelectionAccess::recoveryNextContent(*fixture.edits)==next&&
        BrowserSelectionAccess::recoveryUndo(*fixture.edits).size()==undo&&BrowserSelectionAccess::recoveryRedo(*fixture.edits).size()==redo,"Refusal changed the original published document/history");
}
void contracts() {
    test([] {
        Fixture fixture(Family::Transform);fixture.transform->kind=bt::Kind::Gizmo;
        fixture.transform->cancelBase=bt::GizmoBaseline{fixture.scene,fixture.states,fixture.transform->baseId,0};
        const auto encoded=encode(fixture);auto result=restore(encoded);
        require(!result.transform&&same(result.edits->maskSnapshot(),original)&&result.edits->revision()==fixture.edits->revision()&&
            result.edits->contentRevision()==fixture.edits->contentRevision(),"Codec3 did not normalize transient gizmo without changing accepted state");
        require(encoded.bytes[encoded.bytes.size()-2]==0,"Writer serialized a partial gizmo Cancel owner");
    });
    test([] {
        Fixture fixture(Family::Transform);auto encoded=encode(fixture);
        // Independent fixed suffix of the old codec3 Transform record: kind,
        // selected/applied bits, 148 parameter bytes, 452 plan bytes, pivot,
        // effective-mask ID and the trailing inactive Opacity flag.
        const auto kind=encoded.bytes.size()-(3+148+452+12+4+1);
        require(encoded.bytes[kind]==0,"Legacy Transform kind suffix differs");encoded.bytes[kind]=1;refresh(encoded.bytes);
        auto result=restore(encoded);
        require(!result.transform&&same(result.edits->maskSnapshot(),original)&&result.edits->revision()==fixture.edits->revision(),
            "Reader resumed an old one-base gizmo as a multi-drag Cancel owner");
    });
    for(const auto family:{Family::Color,Family::Transform,Family::Opacity}) {
        test([&] { Fixture fixture(family);const auto encoded=encode(fixture);require(encoded.description.sceneCount==1&&encoded.description.maskCount==2,"Scoped owner duplicated shared scene/mask storage");
            auto result=restore(encoded);verify(result,fixture,clipped,true);++scopedResumes; });
        test([&] { Fixture fixture(family,true,true);const auto encoded=encode(fixture);require(encoded.description.maskCount==1,"Aliased effective/canonical mask was serialized twice");
            auto result=restore(encoded);verify(result,fixture,original,true,true); });
        for(const unsigned version:{1u,2u})test([&] { Fixture fixture(family,false);auto encoded=encode(fixture);require(encoded.description.maskCount==1,"Unrestricted fixture has an extra mask");
            legacy(encoded,family,version);auto result=restore(encoded);verify(result,fixture,original,false);++legacyReads;
            require(!result.duplicateLineage.find(result.edits->scene()),"Legacy reader fabricated a duplicate marker"); });
        test([&] { Fixture fixture(family);auto encoded=encode(fixture);legacy(encoded,family,2);
            auto result=restore(encoded);verify(result,fixture,clipped,true);++legacyReads;
            require(!result.duplicateLineage.find(result.edits->scene()),"Legacy scoped reader fabricated a duplicate marker"); });
    }
    for(const auto bad:{std::array<uint8_t,4>{1,1,0,0},std::array<uint8_t,4>{0,1,2,1},std::array<uint8_t,4>{0,1,3,0}})
        test([&] { Fixture fixture(Family::Opacity);fixture.opacity->effectiveStates=MaskStorage::copy(bad,fixture.work);const auto encoded=encode(fixture);
            refused(fixture,[&] { restore(encoded); }); });
    test([] { Fixture fixture(Family::Transform);fixture.transform->effectiveStates=MaskStorage::copy(std::array<uint8_t,3>{0,1,2},fixture.work);
        const auto encoded=encode(fixture);refused(fixture,[&] { restore(encoded); }); });
    test([] { Fixture fixture(Family::Color);auto encoded=encode(fixture);put32(encoded.bytes,effectiveOffset(Family::Color,encoded.bytes),3);refresh(encoded.bytes);
        refused(fixture,[&] { restore(encoded); }); });
    test([] { Fixture fixture(Family::Opacity);auto encoded=encode(fixture);put32(encoded.bytes,8,4);
        refused(fixture,[&] { restore(encoded); }); });
    test([] { Fixture fixture(Family::Transform);fixture.transform->id=fixture.identities.next[4];const auto encoded=encode(fixture);
        refused(fixture,[&] { restore(encoded); }); });
    test([] { Fixture fixture(Family::Color);refused(fixture,[&] { cp::Plan plan(fixture.source(),ResourceBudget(1)); });
        const auto encoded=encode(fixture);refused(fixture,[&] { cp::Restore input(encoded.bytes.size(),encoded.expected,1,0); }); });
    test([] { Fixture fixture(Family::Color);auto source=fixture.source();source.duplicateLineage=nullptr;
        refused(fixture,[&]{cp::Plan plan(source,fixture.budget);}); });
    test([] { Fixture fixture(Family::Opacity);auto encoded=encode(fixture);put32(encoded.bytes,8,2);encoded.expected.codecVersion=2;refresh(encoded.bytes);
        refused(fixture,[&]{restore(encoded);}); }); // A header word alone is not a real v2 conversion.
    test([] { Fixture fixture(Family::Color);fixture.originalSourceCount=fixture.scene->sourceCount=17;duplicate(fixture);
        const auto encoded=encode(fixture);const auto &d=encoded.description;
        require(d.currentLoadedCount==6&&d.currentSourceCount==19&&d.maximumGraphSplats==6&&d.currentDuplicateRange&&
            d.currentDuplicateRange->first==4&&d.currentDuplicateRange->count==2,"Grown descriptor lost authenticated topology");
        auto restored=restore(encoded);const auto grown=restored.edits->scene();
        require(grown->sourceCount==19&&same(restored.edits->maskSnapshot(),std::array<uint8_t,6>{0,0,2,0,1,1})&&
            std::memcmp(grown->gaussians.data(),fixture.edits->scene()->gaussians.data(),6*sizeof(Gaussian))==0,"Grown recovery changed records/masks");
        require(restored.duplicateLineage.find(grown).has_value()&&restored.edits->undo()&&restored.edits->scene()->gaussians.size()==4&&
            restored.edits->scene()->sourceCount==17&&!restored.duplicateLineage.find(restored.edits->scene()),"Undo lost smaller source/marker owner");
        require(restored.edits->redo()&&restored.edits->scene()==grown&&restored.duplicateLineage.find(grown).has_value(),"Redo lost grown marker owner");
        require(fixture.edits->undo(),"Fixture Undo failed");const auto smaller=encode(fixture);
        require(smaller.description.currentLoadedCount==4&&smaller.description.currentSourceCount==17&&!smaller.description.currentDuplicateRange&&
            smaller.description.maximumGraphSplats==6,"Larger Redo was omitted from exact graph maximum");
        auto smallRestored=restore(smaller);require(smallRestored.edits->redo()&&smallRestored.edits->scene()->gaussians.size()==6&&
            smallRestored.duplicateLineage.find(smallRestored.edits->scene()).has_value(),"Smaller-current recovery lost larger Redo");
        auto tooSmall=smaller;tooSmall.expected.maximumGraphSplats=4;refused(fixture,[&]{restore(tooSmall);});
        auto inflated=smaller;inflated.expected.maximumGraphSplats=7;refused(fixture,[&]{restore(inflated);});
    });
    test([] { Fixture fixture(Family::Transform);duplicate(fixture);const auto copied=fixture.edits->scene();
        auto changed=std::make_shared<Scene>(*copied);changed->gaussians[0].sh[0]^=1;fixture.edits->replaceScene(changed,fixture.edits->states());
        const auto encoded=encode(fixture);require(!encoded.description.currentDuplicateRange,"Attribute Scene inherited a duplicate marker");
        auto restored=restore(encoded);require(!restored.duplicateLineage.find(restored.edits->scene())&&restored.edits->undo()&&
            restored.duplicateLineage.find(restored.edits->scene()).has_value()&&restored.edits->redo()&&
            !restored.duplicateLineage.find(restored.edits->scene()),"Attribute Undo/Redo lost per-Scene marker lifetime");
    });
    test([] { Fixture fixture(Family::Opacity);fixture.originalSourceCount=fixture.scene->sourceCount=17;duplicate(fixture);const auto encoded=encode(fixture);
        for(unsigned field=0;field<8;++field) {
            auto wrong=encoded;auto &e=wrong.expected;
            if(field==0)e.currentLoadedCount=5;
            else if(field==1)++e.currentSourceCount;
            else if(field==2)e.currentDuplicateRange=bd::Range{3,3};
            else if(field==3)e.currentDuplicateRange.reset();
            else if(field==4)++e.maximumGraphSplats;
            else if(field==5)++e.revision;
            else if(field==6)e.contentRevision=0;
            else ++e.nextContentRevision;
            refused(fixture,[&]{restore(wrong);});
        }
        const auto offsets=sceneOffsets(encoded.bytes);
        require(offsets.size()==2&&encoded.bytes[offsets[0].marker]==1&&encoded.bytes[offsets[1].marker]==0,"Unexpected grown fixture graph");
        for(unsigned field=0;field<4;++field) {
            auto wrong=encoded;
            if(field==0)put32(wrong.bytes,offsets[0].marker+1,3);
            else if(field==1)put32(wrong.bytes,offsets[0].marker+5,0);
            else if(field==2)put32(wrong.bytes,offsets[0].marker+1,0xffff'ffff);
            else put64(wrong.bytes,offsets[1].sourceCount,16);
            refresh(wrong.bytes);refused(fixture,[&]{restore(wrong);});
        }
    });
}
}
int main() {
    try { contracts();std::printf("SPLATVIEW_DOCUMENT_CHECKPOINT_CONTRACTS_PASS cases=%zu checks=%zu scopedResumes=%zu legacyReads=%zu refusals=%zu\n",cases,checks,scopedResumes,legacyReads,refusals);return 0; }
    catch(const std::exception &error) { std::fprintf(stderr,"Document checkpoint contracts failed cases=%zu checks=%zu: %s\n",cases,checks,error.what());return 1; }
}
