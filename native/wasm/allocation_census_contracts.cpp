// Main-only observer and fixtures. This executable links the actual browser
// bindings and generated allocator hooks; none of these controls is exported.
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "response.hpp"
#include "admitted_storage.hpp"
#include "model.hpp"
#include "resource_budget.hpp"
#include <nlohmann/json.hpp>
#include <algorithm>
#include <array>
#include <bit>
#include <cstdio>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

extern "C" {
const char *sv_allocation_snapshot() noexcept;
const char *sv_open(const std::uint8_t *,std::size_t,unsigned,unsigned,unsigned);
const char *sv_command(const char *);
const char *sv_step(unsigned);
const char *sv_map_write(double,unsigned,const std::uint8_t *,unsigned);
const preview::Gaussian *sv_scene_ptr();
const std::uint8_t *sv_states_ptr();
const std::uint32_t *sv_pack(unsigned,unsigned);
unsigned sv_pack_len();
const std::uint8_t *sv_output_ptr();
unsigned sv_output_len();
}

namespace {
using Json=nlohmann::json;
using Snapshot=sv_allocation::Snapshot;
using Event=sv_allocation::Event;
using EventKind=sv_allocation::EventKind;
using Bytes=std::vector<std::uint8_t>;
constexpr unsigned sceneBudget=32*1024*1024;
std::size_t cases{},assertions{},noAllocationObservations{},bindingQueries{},repeatedRefusals{};

void require(bool value,const char *message) {
    ++assertions;
    if(!value) throw std::runtime_error(message);
}
template<class Action> void test(Action action) { action();++cases; }

// The oracle retains individual successful backend events, never production
// aggregate counters. Fixed storage also keeps observer recursion impossible.
struct Block {
    const void *pointer{},*owner{};
    std::size_t requested{},raw{},alignment{},payload{};
};
struct Context { const void *pointer{};std::size_t raw{}; };
std::array<Block,8192> blocks;
std::array<Context,2048> contexts;
const char *observerError{};
std::size_t attempts{},allocated{},released{},contextAllocated{},contextReleased{},backendFailures{},unknownUnownedFrees{};
std::size_t observedPeakBlocks{},observedPeakContexts{};
const void *lastContextCreated{};

void observerFailure(const char *message) noexcept { if(!observerError) observerError=message; }
const Block *findBlock(const void *pointer) noexcept {
    for(const auto &block:blocks) if(block.pointer==pointer) return &block;
    return nullptr;
}
bool hasContext(const void *pointer) noexcept {
    for(const auto &context:contexts) if(context.pointer==pointer) return true;
    return false;
}
void observe(const Event &event) noexcept {
    switch(event.kind) {
    case EventKind::NewAttempt: ++attempts;return;
    case EventKind::BackendFailure: ++backendFailures;return;
    case EventKind::ContextAllocated: {
        ++contextAllocated;
        lastContextCreated=event.pointer;
        if(!event.pointer || event.owner!=event.pointer || event.raw!=24 || hasContext(event.pointer))
            observerFailure("Malformed or duplicate context allocation event");
        for(auto &context:contexts) if(!context.pointer) {
            context={event.pointer,event.raw};
            observedPeakContexts=std::max(observedPeakContexts,contextAllocated-contextReleased);return;
        }
        observerFailure("Independent context table exhausted");return;
    }
    case EventKind::ContextReleased:
        ++contextReleased;
        for(auto &context:contexts) if(context.pointer==event.pointer) {
            if(context.raw!=event.raw || event.owner!=context.pointer)
                observerFailure("Context release did not retain its original allocation identity");
            for(const auto &block:blocks) if(block.pointer && block.owner==event.pointer)
                observerFailure("Context released before its escaped blocks");
            context={};return;
        }
        observerFailure("Released context was absent from independent table");return;
    case EventKind::BlockAllocated: {
        ++allocated;
        if(!event.pointer || !event.alignment || (event.alignment&(event.alignment-1)) ||
           reinterpret_cast<std::uintptr_t>(event.pointer)%event.alignment ||
           std::uint64_t(event.raw)!=std::max(std::uint64_t{1},std::uint64_t(event.requested))+24+
               std::max(std::uint64_t{4},std::uint64_t(event.alignment))-1 || event.payload>event.requested ||
           (event.owner && !hasContext(event.owner)) || (!event.owner && event.payload) || findBlock(event.pointer))
            observerFailure("Malformed, unowned-tagged or duplicate block allocation event");
        for(auto &block:blocks) if(!block.pointer) {
            block={event.pointer,event.owner,event.requested,event.raw,event.alignment,event.payload};
            observedPeakBlocks=std::max(observedPeakBlocks,allocated-released);return;
        }
        observerFailure("Independent block table exhausted");return;
    }
    case EventKind::BlockReleased:
        ++released;
        for(auto &block:blocks) if(block.pointer==event.pointer) {
            if(block.owner!=event.owner || block.requested!=event.requested || block.raw!=event.raw ||
               block.alignment!=event.alignment || block.payload!=event.payload)
                observerFailure("Block release changed original ownership or raw accounting");
            block={};return;
        }
        // Runtime setup before main is unowned and predates this observer.
        if(event.owner) observerFailure("Released owned block was absent from independent table");
        else ++unknownUnownedFrees;
        return;
    }
}

struct Totals {
    std::uint64_t owned{},payload{},context{},blockCount{},contextCount{};
};
Totals independentTotals() noexcept {
    Totals result;
    for(const auto &block:blocks) if(block.pointer && block.owner) {
        result.owned+=block.raw;result.payload+=block.payload;++result.blockCount;
    }
    for(const auto &context:contexts) if(context.pointer) {
        result.owned+=context.raw;result.context+=context.raw;++result.contextCount;
    }
    return result;
}
bool same(const Snapshot &a,const Snapshot &b) noexcept {
    return a.valid==b.valid && a.scenePayloadBytes==b.scenePayloadBytes && a.ownedRawBytes==b.ownedRawBytes &&
        a.overlapBytes==b.overlapBytes && a.contextBytes==b.contextBytes && a.unionBytes==b.unionBytes &&
        a.liveBlocks==b.liveBlocks && a.liveContexts==b.liveContexts;
}
void matches(const Snapshot &actual) {
    require(!observerError,observerError ? observerError : "Observer error");
    const auto expected=independentTotals();
    require(actual.valid && sv_allocation::validSnapshot(actual),"Live census is not a valid checked snapshot");
    require(actual.scenePayloadBytes==expected.payload && actual.overlapBytes==expected.payload,
            "Captured payload/overlap differs from independent live tagged blocks");
    require(actual.ownedRawBytes==expected.owned && actual.contextBytes==expected.context &&
            actual.liveBlocks==expected.blockCount && actual.liveContexts==expected.contextCount,
            "Raw/context census differs from independent live allocation identities");
    // This captured subset has S=O. Setup is already within U, so adding it a
    // second time would fail this independently computed checked union.
    require(actual.overlapBytes<=actual.scenePayloadBytes && actual.overlapBytes<=actual.ownedRawBytes &&
            actual.contextBytes<=actual.ownedRawBytes &&
            std::uint64_t(actual.scenePayloadBytes)+(std::uint64_t(actual.ownedRawBytes)-actual.overlapBytes)==actual.unionBytes &&
            actual.unionBytes==expected.owned,"Union double counted payload or setup, or lost raw overhead");
}
template<class Action> auto noAllocation(Action action) {
    const auto newBefore=attempts,blocksBefore=allocated,contextsBefore=contextAllocated,failuresBefore=backendFailures;
    auto result=action();
    ++noAllocationObservations;
    require(attempts==newBefore && allocated==blocksBefore && contextAllocated==contextsBefore && backendFailures==failuresBefore,
            "Allocation-free boundary attempted new, raw storage or context setup");
    return result;
}
Snapshot census() {
    const auto value=noAllocation([]{return sv_allocation::snapshot();});matches(value);return value;
}
Json parse(const char *text) { return Json::parse(text); }
std::uint64_t previousSequence{};
Snapshot bindingCensus() {
    const auto pointer=noAllocation([]{return sv_allocation_snapshot();});
    const auto expected=census();
    const auto actual=parse(pointer); // Independent parser is outside observation.
    require(actual.is_object() && actual.size()==11 && actual.at("ok")==true && actual.at("version")==1 &&
            actual.at("scope")=="scoped-cxx-v1","Allocation C ABI schema differs from independent literal fields");
    const auto sequence=actual.at("sequence").get<std::uint64_t>();
    require(sequence>previousSequence && sequence<=9007199254740991ULL,"Allocation query sequence is not fresh and safely representable");
    previousSequence=sequence;
    const Json fields={{"scenePayloadBytes",expected.scenePayloadBytes},{"ownedRawBytes",expected.ownedRawBytes},
        {"overlapBytes",expected.overlapBytes},{"contextBytes",expected.contextBytes},{"unionBytes",expected.unionBytes},
        {"liveBlocks",expected.liveBlocks},{"liveContexts",expected.liveContexts}};
    for(auto it=fields.begin();it!=fields.end();++it)
        require(actual.at(it.key()).is_number_unsigned() && actual.at(it.key())==it.value(),
                "Allocation C ABI scalar differs from independently observed postcleanup storage");
    ++bindingQueries;return expected;
}
Json command(const char *text) { const auto value=parse(admittedContractCommand(text));bindingCensus();return value; }
Json currentSummary() { return parse(noAllocation([]{return sv_command("{\"command\":\"summary\"}");})); }
Bytes bytes(std::string_view text) { return {text.begin(),text.end()}; }
Json open(const Bytes &input,unsigned budget=sceneBudget) {
    const auto value=parse(sv_open(input.data(),input.size(),0,100,budget));bindingCensus();return value;
}
Bytes gaussianInput() {
    return bytes("ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n"
        "property float scale_0\nproperty float scale_1\nproperty float scale_2\nproperty float rot_0\nproperty float rot_1\n"
        "property float rot_2\nproperty float rot_3\nproperty float opacity\nproperty float f_dc_0\nproperty float f_dc_1\n"
        "property float f_dc_2\nend_header\n-1 1 2 -3 -3 -3 1 0 0 0 1 0 0 0\n"
        "0 2 3 -3 -3 -3 1 0 0 0 1 0 0 0\n1 3 4 -3 -3 -3 1 0 0 0 1 0 0 0\n");
}
std::array<preview::Gaussian,3> sceneBytes() {
    std::array<preview::Gaussian,3> result;
    require(sv_scene_ptr()!=nullptr,"Native Gaussian owner is absent");
    std::memcpy(result.data(),sv_scene_ptr(),sizeof(result));return result;
}
bool sameScene(const std::array<preview::Gaussian,3> &expected) noexcept {
    return sv_scene_ptr() && !std::memcmp(sv_scene_ptr(),expected.data(),sizeof(expected));
}
Json finish(const char *request) {
    auto value=command(request);
    for(unsigned steps=0;value.value("pending",false);++steps) {
        require(steps<8,"Tiny native operation did not finish");value=parse(sv_step(65536));bindingCensus();
    }
    require(value.at("ok")==true,"Native operation failed");return value;
}

void scopeAndOverloads() {
    test([] {
        const auto initial=census();
        require(sv_allocation::headerBytes()==24 && sv_allocation::contextBytes()==24,
                "Wasm32 allocation envelope/setup differs from independent six-word layouts");
        require(initial.scenePayloadBytes==0 && initial.ownedRawBytes==0 && initial.overlapBytes==0 &&
                initial.contextBytes==0 && initial.unionBytes==0 && initial.liveBlocks==0 && initial.liveContexts==0,
                "Pristine census manufactured a scoped owner");
        Snapshot output;std::uint64_t sequence=17;
        require(noAllocation([&]{return sv_allocation::query(output,sequence);}) && same(output,initial) && sequence>0,
                "Direct allocation query did not publish the complete snapshot/sequence");
        bindingCensus();
    });
    test([] {
        const auto baseline=census();void *unowned=::operator new(47);
        require(findBlock(unowned) && !findBlock(unowned)->owner && same(census(),baseline),
                "Unscoped setup allocation acquired application ownership");
        void *outer{},*inner{};const void *outerOwner{},*innerOwner{};
        {
            sv_allocation::Scope scope;
            const auto setup=census();
            require(setup.ownedRawBytes==baseline.ownedRawBytes+sv_allocation::contextBytes() &&
                    setup.contextBytes==baseline.contextBytes+sv_allocation::contextBytes() &&
                    setup.liveContexts==baseline.liveContexts+1 && setup.liveBlocks==baseline.liveBlocks,
                    "Scope setup was uncharged, double counted or treated as payload");
            outer=::operator new(19);outerOwner=findBlock(outer)->owner;
            require(outerOwner && findBlock(outer)->payload==0,"Ordinary owned new became admitted payload");
            ::operator delete(unowned); // Freeing an unowned block inside a scope stays unowned.
            {
                sv_allocation::Scope nested;inner=::operator new(23);innerOwner=findBlock(inner)->owner;
                require(innerOwner && innerOwner!=outerOwner,"Nested entry reused another setup context");
                census();
            }
            require(hasContext(innerOwner),"Escaped inner allocation lost its setup owner");
            census();
        }
        require(hasContext(outerOwner) && hasContext(innerOwner),"Scope exit lost escaped allocation ownership");
        ::operator delete(outer);require(!hasContext(outerOwner) && hasContext(innerOwner),"First escaped free retired the wrong context");
        ::operator delete(inner);require(same(census(),baseline),"Final escaped free retained raw bytes or setup context");
    });
    test([] {
        const auto baseline=census();
        {
            sv_allocation::Scope scope;
            auto check=[](void *pointer,std::size_t requested,std::size_t alignment) {
                const auto block=findBlock(pointer);
                require(pointer && block && block->owner && block->requested==requested &&
                        reinterpret_cast<std::uintptr_t>(pointer)%alignment==0,
                        "Global new overload lost requested bytes, alignment or context ownership");
                census();
            };
            void *p=::operator new(7);check(p,7,alignof(std::max_align_t));::operator delete(p);
            p=::operator new[](9);check(p,9,alignof(std::max_align_t));::operator delete[](p);
            p=::operator new(11);check(p,11,alignof(std::max_align_t));::operator delete(p,std::size_t{11});
            p=::operator new[](13);check(p,13,alignof(std::max_align_t));::operator delete[](p,std::size_t{13});
            p=::operator new(17,std::align_val_t{64});check(p,17,64);::operator delete(p,std::align_val_t{64});
            p=::operator new[](19,std::align_val_t{128});check(p,19,128);::operator delete[](p,std::align_val_t{128});
            p=::operator new(23,std::align_val_t{256});check(p,23,256);::operator delete(p,std::size_t{23},std::align_val_t{256});
            p=::operator new[](29,std::align_val_t{64});check(p,29,64);::operator delete[](p,std::size_t{29},std::align_val_t{64});
            p=::operator new(31,std::nothrow);check(p,31,alignof(std::max_align_t));::operator delete(p,std::nothrow);
            p=::operator new[](37,std::nothrow);check(p,37,alignof(std::max_align_t));::operator delete[](p,std::nothrow);
            p=::operator new(41,std::align_val_t{64},std::nothrow);check(p,41,64);::operator delete(p,std::align_val_t{64},std::nothrow);
            p=::operator new[](43,std::align_val_t{128},std::nothrow);check(p,43,128);::operator delete[](p,std::align_val_t{128},std::nothrow);
            p=::operator new(0);check(p,0,alignof(std::max_align_t));::operator delete(p);
            census();
        }
        require(same(census(),baseline),"An aligned, sized, array, zero-size or nothrow delete leaked its owner");
    });
    test([] {
        const auto baseline=census();
        {
            sv_allocation::Scope scope;const auto setup=census();
            void *a{},*b{},*c{},*d{};
            {
                sv_allocation::PayloadTag outer(7);
                {
                    sv_allocation::PayloadTag inner(11);
                    a=::operator new(29);b=::operator new(31);
                }
                c=::operator new(37);d=::operator new(41);
            }
            require(findBlock(a)->payload==11 && findBlock(b)->payload==0 && findBlock(c)->payload==7 && findBlock(d)->payload==0,
                    "One-shot nested tags leaked into later new calls or lost their parent");
            require(census().overlapBytes==setup.overlapBytes+18,"Tagged overlap differs from the two independent payload literals");
            ::operator delete(b);::operator delete(d);::operator delete(a);::operator delete(c);
            require(same(census(),setup),"Deleting tagged blocks did not retire their captured physical payload");
        }
        require(same(census(),baseline),"Payload tag lifetime retained an empty context");
    });
    test([] {
        const auto baseline=census();bool refused{};
        sv_allocation::failBackendAtForContracts(1);
        try { sv_allocation::Scope scope; } catch(const std::bad_alloc &) { refused=true; }
        sv_allocation::failBackendAtForContracts(0);
        require(refused && same(census(),baseline),"Refused setup created authority or retained census storage");
        {
            sv_allocation::failBackendAtForContracts(2);sv_allocation::Scope scope;
            const auto setup=census();const auto failuresBefore=backendFailures;
            void *failed=::operator new(53,std::nothrow);
            require(!failed && backendFailures==failuresBefore+1 && same(census(),setup),
                    "Injected block failure was not an ordinary no-storage nothrow refusal");
            void *recovered=::operator new(59,std::nothrow);
            require(recovered && findBlock(recovered)->owner,"One-shot backend refusal latched or lost current ownership");
            ::operator delete(recovered);sv_allocation::failBackendAtForContracts(0);
        }
        require(same(census(),baseline),"Setup/block failure left a context after recovery");
    });
    test([] {
        const auto baseline=census();
        {
            sv_allocation::Scope scope;void *anchor=::operator new(61);const auto owner=findBlock(anchor)->owner;
            bool refused{};sv_allocation::failBackendAtForContracts(1);
            try { sv_allocation::Scope nested; } catch(const std::bad_alloc &) { refused=true; }
            sv_allocation::failBackendAtForContracts(0);
            void *recovered=::operator new(67);
            require(refused && findBlock(recovered)->owner==owner,"Failed nested setup changed its outer allocation authority");
            const auto before=census();
            void *huge=::operator new(std::numeric_limits<std::size_t>::max(),std::nothrow);
            require(!huge && same(census(),before),"Checked size overflow wrapped into an owned allocation");
            ::operator delete(recovered);::operator delete(anchor);
        }
        require(same(census(),baseline),"Nested setup or overflow refusal retained context storage");
    });
}

void generatedTagsAndValidation() {
    test([] {
        const auto baseline=census();
        {
            sv_allocation::Scope scope;preview::ResourceBudget budget(sceneBudget);
            const auto beforeSource=census();auto source=budget.reserve(preview::ResourceCategory::Source,16384);
            require(budget.usage().categoryBytes[std::size_t(preview::ResourceCategory::Source)]==16384 &&
                    census().scenePayloadBytes==beforeSource.scenePayloadBytes && census().overlapBytes==beforeSource.overlapBytes,
                    "Source reservation was falsely captured as a physical tagged allocation");
            auto memory=preview::sceneMemoryForBudget(budget,preview::ResourceCategory::Decoded);
            preview::SceneAllocator<std::uint32_t> scene(memory);const auto beforeScene=census();
            auto *a=scene.allocate(7);const auto afterScene=census();
            require(afterScene.scenePayloadBytes==beforeScene.scenePayloadBytes+28,
                    "Generated SceneAllocator hook missed or overcaptured its 28-byte payload");
            preview::AdmittedAllocator<std::uint64_t> admitted(memory);const auto beforeAdmitted=census();
            auto *b=admitted.allocate(5);const auto afterAdmitted=census();
            require(afterAdmitted.scenePayloadBytes==beforeAdmitted.scenePayloadBytes+40,
                    "Generated AdmittedAllocator hook missed or overcaptured its 40-byte payload");
            auto history=preview::sceneMemoryForBudget(budget,preview::ResourceCategory::History);
            using Pair=std::pair<const unsigned,unsigned>;
            const auto beforeMap=census();
            {
                std::unordered_map<unsigned,unsigned,std::hash<unsigned>,std::equal_to<unsigned>,preview::AdmittedAllocator<Pair>>
                    values(0,std::hash<unsigned>{},std::equal_to<unsigned>{},preview::AdmittedAllocator<Pair>{history});
                values.reserve(17);values.emplace(3,7);values.emplace(11,13);values.emplace(17,19);
                const auto duringMap=census();
                require(duringMap.scenePayloadBytes>beforeMap.scenePayloadBytes &&
                        duringMap.scenePayloadBytes-beforeMap.scenePayloadBytes==
                            budget.usage().categoryBytes[std::size_t(preview::ResourceCategory::History)],
                        "Rebound admitted nodes/buckets were omitted or grant bookkeeping was tagged");
            }
            require(same(census(),beforeMap),"Rebound admitted map destruction retained physical payload or contexts");
            admitted.deallocate(b,5);scene.deallocate(a,7);source.release();
        }
        require(same(census(),baseline),"Generated allocator grants outlived their final physical blocks");
    });
    test([] {
        const auto live=census();require(sv_allocation::validSnapshot(live),"Authentic live snapshot was refused");
        auto invalid=live;invalid.valid=false;
        require(!sv_allocation::validSnapshot(invalid),"Unauthenticated snapshot was accepted");
        invalid=live;invalid.overlapBytes=invalid.ownedRawBytes+1;
        require(!sv_allocation::validSnapshot(invalid),"Overlap beyond raw ownership was accepted");
        invalid=live;invalid.scenePayloadBytes=1;
        require(!sv_allocation::validSnapshot(invalid),"Captured physical payload and overlap disagreement was accepted");
        invalid=live;invalid.contextBytes=invalid.ownedRawBytes+1;
        require(!sv_allocation::validSnapshot(invalid),"Setup beyond raw ownership was accepted");
        invalid=live;++invalid.unionBytes;
        require(!sv_allocation::validSnapshot(invalid),"An independently incorrect union was accepted");
        invalid=live;invalid.ownedRawBytes=std::numeric_limits<std::size_t>::max();invalid.scenePayloadBytes=1;
        invalid.overlapBytes=0;invalid.unionBytes=0;
        require(!sv_allocation::validSnapshot(invalid),"Overflowing or inconsistent checked union was accepted");
        invalid=live;invalid.liveContexts=1;
        require(!sv_allocation::validSnapshot(invalid),"Live context count without setup storage was accepted");
        require(same(census(),live),"Synthetic validation changed authoritative live allocation storage");
    });
    test([] {
        sv_response::Responses responses;Snapshot empty;empty.valid=true;
        auto preparation=noAllocation([&]{return responses.begin();});
        require(noAllocation([&]{return responses.census(preparation,empty,42);}),"Typed census refused a representable literal");
        const auto pointer=noAllocation([&]{return responses.publish(preparation);});
        require(parse(pointer)==parse(R"({"ok":true,"version":1,"sequence":42,"scope":"scoped-cxx-v1","scenePayloadBytes":0,"ownedRawBytes":0,"overlapBytes":0,"contextBytes":0,"unionBytes":0,"liveBlocks":0,"liveContexts":0})"),
                "Typed census differs from complete independent JSON literal");
        const std::string before(pointer);
        for(const std::uint64_t sequence:{std::uint64_t{0},std::uint64_t{9007199254740992ULL}}) {
            auto refused=noAllocation([&]{return responses.begin();});
            require(!noAllocation([&]{return responses.census(refused,empty,sequence);}) && responses.current()==before,
                    "Invalid census sequence changed existing published bytes");
            require(parse(noAllocation([&]{return responses.publish(refused);})).at("ok")==false && responses.current()==before,
                    "Refused census preparation published incomplete candidate bytes");
        }
        auto refused=noAllocation([&]{return responses.begin();});empty.valid=false;
        require(!noAllocation([&]{return responses.census(refused,empty,43);}) && responses.current()==before,
                "Unauthenticated typed census changed existing published bytes");
    });
}

void actualLifetimes() {
    test([] {
        require(currentSummary().at("loaded")==false,"Expected unloaded native boundary before first source");
        for(unsigned i=0;i<8;++i) {
            require(parse(noAllocation([]{return sv_step(1);})).at("loaded")==false,"Unloaded idle step changed state");
            currentSummary();bindingCensus();
        }
        const std::string comment(32768,'x');
        const auto input=bytes("ply\nformat ascii 1.0\ncomment "+comment+
            "\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n-1 0 0\n1 0 0\n");
        const auto value=open(input);const auto observed=bindingCensus();
        require(value.at("kind")==1 && value.at("count")==2 && observed.scenePayloadBytes==32 && observed.overlapBytes==32,
                "Ordinary PLY source/header reservations inflated its independent two-vertex physical payload");
        require(value==currentSummary(),"Postcleanup canonical summary changed admitted document metadata");
    });
    test([] {
        require(open(gaussianInput()).at("count")==3,"Gaussian census fixture failed to open");
        const auto scene=sceneBytes();const auto before=bindingCensus();
        const auto pointer=sv_pack(0,3);const auto after=bindingCensus();
        require(pointer && sv_pack_len()==144 && after.scenePayloadBytes==before.scenePayloadBytes &&
                after.ownedRawBytes>before.ownedRawBytes && findBlock(pointer) && findBlock(pointer)->owner && !findBlock(pointer)->payload,
                "Native pack storage was omitted, treated as admitted overlap, or has the wrong independent length");
        std::array<std::uint8_t,144> expected{};
        for(unsigned i=0;i<3;++i) {
            std::memcpy(expected.data()+48*i,&scene[i],40);std::memcpy(expected.data()+48*i+40,scene[i].sh.data(),8);
        }
        require(!std::memcmp(pointer,expected.data(),expected.size()),"Native pack changed independent Gaussian wire bytes");
        require(sv_pack(0,1)==pointer && sv_pack_len()==48 && same(bindingCensus(),after),
                "Pack capacity reuse changed captured physical ownership");
        require(!sv_pack(4,1) && sv_pack_len()==48 && same(bindingCensus(),after),"Invalid pack range lost its retained storage");
    });
    test([] {
        const auto before=currentSummary();const auto original=sceneBytes();const auto baseline=bindingCensus();
        const auto pending=command(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");
        const auto during=bindingCensus();
        require(pending.at("pending")==true && during.scenePayloadBytes==baseline.scenePayloadBytes+sizeof(original) &&
                during.ownedRawBytes>baseline.ownedRawBytes && sameScene(original),
                "Pending native job lost its captured clone, state scratch or immutable old document");
        require(parse(sv_step(1)).at("pending")==true && sameScene(original),"Partial job published its working scene");
        require(same(bindingCensus(),during),"Partial native job unexpectedly changed retained raw allocation lifetimes");
        require(command(R"({"command":"cancel"})").at("pending")==false && sameScene(original) &&
                currentSummary()==before && same(bindingCensus(),baseline),"Canceled native job retained scratch/context or altered old state");
        command(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");
        require(command(R"({"command":"export","format":99})").at("ok")==false && sameScene(original) &&
                currentSummary()==before && same(bindingCensus(),baseline),
                "Post-refusal telemetry included the canceled job or changed its original document");
    });
    test([] {
        command(R"({"command":"single","index":1,"operation":0})");command(R"({"command":"delete"})");
        command(R"({"command":"single","index":2,"operation":0})");
        const auto baseline=bindingCensus();
        const auto begin=command(R"({"command":"selectionMapBegin","mapId":101,"layoutVersion":1,"fullWidth":2,"fullHeight":2,"mapWidth":2,"mapHeight":2,"sourceCount":3,"channels":15})");
        const auto mapOwner=lastContextCreated;
        const auto during=bindingCensus();
        require(begin.at("pendingSelectionMapId")==101 && begin.at("selectionMapBytes")==88 &&
                during.scenePayloadBytes==baseline.scenePayloadBytes+88,
                "Pending map did not capture all five independent physical channel payloads");
        std::array<std::uint32_t,21> words{};
        for(unsigned i=0;i<4;++i) words[i]=std::bit_cast<std::uint32_t>(1.f);
        for(unsigned i=4;i<20;++i) words[i]=std::bit_cast<std::uint32_t>(.5f);
        words[20]=5; // Source1 is deleted; visible sources0 and2 are legal.
        require(parse(sv_map_write(101,0,reinterpret_cast<const std::uint8_t *>(words.data()),sizeof(words))).at("ok")==true &&
                same(bindingCensus(),during),"Map upload changed retained channel ownership");
        require(command(R"({"command":"selectionMapCommit","mapId":101})").at("selectionMapId")==101 &&
                same(bindingCensus(),during),"Map adoption allocated or lost the prepared channel owner");
        command(R"({"command":"beginTransaction"})");const auto transaction=bindingCensus();
        const auto releasedMap=command(R"({"command":"selectionMapRelease","mapId":101})");
        require(releasedMap.at("selectionMapId").is_null() && releasedMap.at("selectionMapRetainedIds")==Json::array({101}) &&
                releasedMap.at("selectionMapBytes")==88 && same(bindingCensus(),transaction),
                "Transaction-held map was double counted or released with its active reference");
        const auto rolledBack=command(R"({"command":"rollbackTransaction"})");const auto restored=bindingCensus();
        require(rolledBack.at("selectionMapId")==101 && !rolledBack.at("transaction").get<bool>() && hasContext(mapOwner) &&
                restored.scenePayloadBytes>=88 && restored.ownedRawBytes<transaction.ownedRawBytes,
                "Rollback lost the retained map or failed to retire the replaced history copy");
        command(R"({"command":"beginTransaction"})");const auto checkpointOwner=lastContextCreated;
        command(R"({"command":"selectionMapRelease","mapId":101})");
        const auto committed=command(R"({"command":"commitTransaction"})");
        require(committed.at("selectionMapRetainedIds").empty() && committed.at("selectionMapBytes")==0 &&
                bindingCensus().scenePayloadBytes==restored.scenePayloadBytes-88 && !hasContext(mapOwner) && !hasContext(checkpointOwner),
                "Final map/checkpoint release retained payload, history copy or setup context");
        const auto withoutMap=bindingCensus();
        command(R"({"command":"selectionMapBegin","mapId":102,"layoutVersion":1,"fullWidth":2,"fullHeight":2,"mapWidth":2,"mapHeight":2,"sourceCount":3,"channels":15})");
        const auto pending=bindingCensus();
        require(parse(sv_map_write(102,4,reinterpret_cast<const std::uint8_t *>(words.data()),4)).at("ok")==false &&
                same(bindingCensus(),pending),"Refused map chunk lost or changed its independently retained owner");
        command(R"({"command":"cancel"})");
        require(same(bindingCensus(),withoutMap),"Canceled pending map retained physical channels or its escaped context");
    });
}

void refusalAndCleanup() {
    test([] {
        const auto data=gaussianInput();require(open(data).at("count")==3,"Refusal fixture failed to replace old maps/pack");
        const auto original=sceneBytes();
        command(R"({"command":"single","index":1,"operation":0})");command(R"({"command":"delete"})");
        command(R"({"command":"single","index":2,"operation":0})");
        auto first=original,second=original;
        for(const unsigned index:{0u,2u}) { first[index].positionOpacity[0]+=2;second[index].positionOpacity[0]+=5; }
        finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");
        require(sameScene(first),"First edited native fixture differs from independent full-byte translation");
        finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]})");
        require(sameScene(second),"Second edited native fixture differs from independent full-byte translation");
        require(command(R"({"command":"undo"})").at("canRedo")==true && sameScene(first),"Native Undo failed to retain executable Redo");
        const std::array<std::uint8_t,3> mask{0,2,1};
        require(!std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Refusal fixture selected/deleted bytes differ");
        require(command(R"({"command":"export","format":5,"scope":1})").at("ok")==true,"Selected export failed before refusals");
        const auto output=Bytes(sv_output_ptr(),sv_output_ptr()+sv_output_len());
        const std::string expected="x,y,z,f_dc_0,f_dc_1,f_dc_2,opacity,scale_0,scale_1,scale_2,rot_0,rot_1,rot_2,rot_3\n";
        require(output.size()>expected.size() && !std::memcmp(output.data(),expected.data(),expected.size()),
                "Native selected CSV export omitted its independent header");
        const auto before=currentSummary();const auto baseline=bindingCensus();
        const auto sceneOwner=sv_scene_ptr();const auto stateOwner=sv_states_ptr();
        const auto malformed=bytes("ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n");
        for(unsigned iteration=0;iteration<20;++iteration) {
            Json refused;
            switch(iteration%5) {
            case 0:refused=parse(sv_open(nullptr,17,0,100,sceneBudget));break;
            case 1:refused=parse(sv_open(data.data(),data.size(),0,100,1024));break;
            case 2:refused=parse(sv_open(malformed.data(),malformed.size(),0,100,sceneBudget));break;
            case 3:refused=parse(sv_command(R"({"command":"export","format":99})"));break;
            default:refused=parse(sv_command(nullptr));break;
            }
            ++repeatedRefusals;
            require(refused.at("ok")==false && refused.at("error").is_string(),"Ordinary refusal lost its typed error schema");
            require(currentSummary()==before && sv_scene_ptr()==sceneOwner && sv_states_ptr()==stateOwner && sameScene(first) &&
                    !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),
                    "Ordinary refusal changed edited content, deleted/selected mask, history or camera");
            require(sv_output_len()==output.size() && !std::memcmp(sv_output_ptr(),output.data(),output.size()),
                    "Ordinary refusal replaced existing exact export bytes");
            require(same(bindingCensus(),baseline),"Repeated ordinary refusal leaked raw blocks, payload or escaped contexts");
            require(parse(noAllocation([]{return sv_step(1);}))==before,"Post-refusal idle summary allocated or changed old state");
        }
        for(const std::size_t ordinal:{1u,2u}) {
            sv_allocation::failBackendAtForContracts(ordinal);
            const auto refused=parse(sv_command(R"({"command":"selectAll"})"));
            sv_allocation::failBackendAtForContracts(0);
            require(refused.at("ok")==false && currentSummary()==before && sameScene(first) &&
                    !std::memcmp(sv_states_ptr(),mask.data(),mask.size()) && same(bindingCensus(),baseline),
                    "Pre-mutation setup/request backend refusal lost old bytes, Redo or cleanup telemetry");
        }
        require(command(R"({"command":"redo"})").at("canRedo")==false && sameScene(second) &&
                !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Exact retained Redo was not executable after ordinary/setup refusals");
        require(command(R"({"command":"undo"})").at("canRedo")==true && sameScene(first),"Executed Redo could not restore its exact predecessor");
    });
    test([] {
        require(sv_pack(0,3) && sv_pack_len()==144,"Final cleanup fixture could not retain pack storage");bindingCensus();
        const auto before=bindingCensus();
        const auto input=bytes("ply\nformat ascii 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nend_header\n-1 0 0\n1 0 0\n");
        const auto value=open(input);const auto after=bindingCensus();
        require(value.at("kind")==1 && !value.at("canUndo").get<bool>() && !value.at("canRedo").get<bool>() &&
                value.at("selectionMapRetainedIds").empty() && !sv_scene_ptr() && !sv_states_ptr() && !sv_pack_len() && !sv_output_len(),
                "Read-only replacement retained an edited document, map, job, export or packed packet");
        require(after.scenePayloadBytes==32 && after.overlapBytes==32 && after.ownedRawBytes<before.ownedRawBytes,
                "Post-replacement telemetry retained old history/scene payload or measured before cleanup");
        for(unsigned i=0;i<16;++i) {
            require(currentSummary()==value && parse(noAllocation([]{return sv_step(1);}))==value,
                    "Final canonical/idle telemetry changed the replacement scene");
            require(same(bindingCensus(),after),"Repeated postcleanup census retained query/setup allocations");
        }
    });
}
static_assert(sizeof(std::size_t)==4 && sizeof(std::uintptr_t)==4);
static_assert(noexcept(sv_allocation::snapshot()) && noexcept(sv_allocation::query(std::declval<Snapshot &>(),std::declval<std::uint64_t &>())));
}

int main() {
    try {
        sv_allocation::setObserverForContracts(observe);
        scopeAndOverloads();generatedTagsAndValidation();actualLifetimes();refusalAndCleanup();
        require(!observerError,observerError ? observerError : "Observer error");
        const auto final=bindingCensus();
        std::printf("SPLATVIEW_ALLOCATION_CENSUS_CONTRACTS_PASS cases=%zu assertions=%zu noAllocationObservations=%zu bindingQueries=%zu repeatedRefusals=%zu observedNewAttempts=%zu observedBlocks=%zu observedContexts=%zu observedBackendFailures=%zu finalUnionBytes=%zu\n",
            cases,assertions,noAllocationObservations,bindingQueries,repeatedRefusals,attempts,allocated,contextAllocated,backendFailures,final.unionBytes);
        return 0;
    } catch(const std::exception &error) {
        sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"SPLATVIEW_ALLOCATION_CENSUS_CONTRACTS_FAIL %s\n",error.what());return 1;
    } catch(...) {
        sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"SPLATVIEW_ALLOCATION_CENSUS_CONTRACTS_FAIL nonstandard exception\n");return 1;
    }
}
