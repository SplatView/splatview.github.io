// Actual generated nlohmann header, frozen SOG decoder and browser bindings.
// This main and allocation observations/faults stay outside shipping assets.
#include "allocation_census.hpp"
#include "native_export_contracts.hpp"
#include "json_preflight.hpp"
#include "json_cleanup_fixtures.hpp"
#include "model.hpp"
#include "file_io.hpp"
#include <emscripten/stack.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <memory>
#include <new>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

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
using Owner=sv_json::ParsedSogMetadata;
using Status=sv_json::PreflightStatus;
using Bytes=std::vector<std::uint8_t>;
using Snapshot=sv_allocation::Snapshot;
using EventKind=sv_allocation::EventKind;
constexpr unsigned sceneBudget=96*1024*1024;
std::size_t cases{},assertions{},scans{},grammarRefusals{},qualifiedDestructions{};
std::size_t parseAllocationRefusals{},candidateAllocationRefusals{},ordinaryRefusals{},fallbackSuccesses{},largeCommandPoints{};
std::size_t independentArchiveHashes{};
bool watchDestroyStack{};
std::uintptr_t destroyStackStart{},destroyStackLow{};
std::size_t destroyStackMaximum{};
bool watchRefusalCleanup{},sawRefusal{};
std::size_t afterRefusalAttempts{},afterRefusalBackendEvents{};
std::size_t refusalRequested{},refusalRaw{},firstPostRefusalRequested{};
bool refusalAuthority{};
struct Events {
    std::size_t attempts{},allocated{},released{},contexts{},retired{},failures{};
} events;
void observe(const sv_allocation::Event &event) noexcept {
    if(watchDestroyStack && event.kind==EventKind::BlockReleased)
        destroyStackLow=std::min(destroyStackLow,std::uintptr_t(emscripten_stack_get_current()));
    if(watchRefusalCleanup) {
        if(sawRefusal) {
            if(event.kind==EventKind::NewAttempt) {
                ++afterRefusalAttempts;
                if(!firstPostRefusalRequested) firstPostRefusalRequested=event.requested;
            }
            if(event.kind==EventKind::BlockAllocated || event.kind==EventKind::ContextAllocated ||
               event.kind==EventKind::BackendFailure) ++afterRefusalBackendEvents;
        }
        if(event.kind==EventKind::BackendFailure && !sawRefusal) {
            refusalRequested=event.requested;refusalRaw=event.raw;
            refusalAuthority=sv_json_bounded_recursive_destroy_active();sawRefusal=true;
        }
    }
    switch(event.kind) {
    case EventKind::NewAttempt: ++events.attempts;break;
    case EventKind::BlockAllocated: ++events.allocated;break;
    case EventKind::BlockReleased: ++events.released;break;
    case EventKind::ContextAllocated: ++events.contexts;break;
    case EventKind::ContextReleased: ++events.retired;break;
    case EventKind::BackendFailure: ++events.failures;break;
    }
}
void require(bool value,const char *message) {
    ++assertions;
    if(!value) throw std::runtime_error(message);
}
template<class Action> void test(Action action) { action();++cases; }
bool same(const Snapshot &a,const Snapshot &b) noexcept {
    return a.valid==b.valid && a.scenePayloadBytes==b.scenePayloadBytes && a.ownedRawBytes==b.ownedRawBytes &&
        a.overlapBytes==b.overlapBytes && a.contextBytes==b.contextBytes && a.unionBytes==b.unionBytes &&
        a.liveBlocks==b.liveBlocks && a.liveContexts==b.liveContexts;
}
void inactive() { require(!sv_json_bounded_recursive_destroy_active(),"Parsed SOG destruction authority escaped its owner"); }
sv_json::MetadataPreflight scan(std::string_view text,sv_json::MetadataLimits limits={}) {
    const auto before=events;
    const auto result=sv_json::preflightSogJson(text,limits);++scans;
    require(events.attempts==before.attempts && events.allocated==before.allocated &&
            events.contexts==before.contexts && events.failures==before.failures,
            "Metadata preflight attempted C++ allocation, backend storage or a census context");
    require(result.errorOffset<=text.size(),"Metadata qualification offset escaped its exact borrowed bytes");
    if(!result) {
        require(!result.census.tokens && !result.census.stringUnits && !result.census.maxDepth,
                "Unqualified metadata published an incomplete census");++grammarRefusals;
    }
    return result;
}

// Independent native SAX events count decoded UTF-16 units and every syntactic
// occurrence. It does not read preflight state or the overwritten final DOM.
struct CensusSax final : nlohmann::json_sax<Json> {
    sv_json::MetadataCensus count{};std::size_t depth{};
    bool scalar() { ++count.tokens;return true; }
    static std::size_t units(const string_t &text) {
        std::size_t result{};
        for(unsigned char value:text) if((value&0xc0)!=0x80) result+=value>=0xf0?2:1;
        return result;
    }
    bool null() override { return scalar(); }
    bool boolean(bool) override { return scalar(); }
    bool number_integer(number_integer_t) override { return scalar(); }
    bool number_unsigned(number_unsigned_t) override { return scalar(); }
    bool number_float(number_float_t,const string_t &) override { return scalar(); }
    bool string(string_t &text) override { count.stringUnits+=units(text);return scalar(); }
    bool binary(binary_t &) override { return false; }
    bool open() { scalar();++depth;count.maxDepth=std::max(count.maxDepth,depth);return true; }
    bool start_object(std::size_t) override { return open(); }
    bool key(string_t &text) override { count.stringUnits+=units(text);return scalar(); }
    bool end_object() override { --depth;return true; }
    bool start_array(std::size_t) override { return open(); }
    bool end_array() override { --depth;return true; }
    bool parse_error(std::size_t,const string_t &,const Json::exception &) override { return false; }
};
void censusAgainstNative(std::string_view text) {
    const auto actual=scan(text);CensusSax oracle;
    require(bool(actual) && Json::sax_parse(text.begin(),text.end(),&oracle),"Qualified input disagreed with native JSON grammar");
    require(actual.census.tokens==oracle.count.tokens && actual.census.stringUnits==oracle.count.stringUnits &&
            actual.census.maxDepth==oracle.count.maxDepth && !oracle.depth,
            "Qualification census disagreed with independent decoded native SAX occurrences");
}
std::string nested(unsigned depth) { return std::string(depth,'[')+"0"+std::string(depth,']'); }
std::string array(unsigned count) {
    std::string result="[";result.reserve(std::size_t(count)*2+1);
    for(unsigned i=0;i<count;++i) { if(i) result+=',';result+='0'; }
    result+=']';return result;
}
std::string wide(unsigned count) {
    std::string result="{";
    for(unsigned i=0;i<count;++i) {
        if(i) result+=',';
        result+="\"key"+std::to_string(i)+"\":{\"text\":\"an independently owned string value\",\"array\":[1,2,3]}";
    }
    return result+"}";
}
std::string scalarObject(unsigned count) {
    std::string result="{";
    for(unsigned i=0;i<count;++i) {
        if(i) result+=',';
        result+="\"s"+std::to_string(i)+"\":"+std::to_string(i);
    }
    return result+"}";
}
std::string deepWide() {
    auto result=wide(64); // Object/value-object/array: three container levels.
    for(unsigned level=0;level<29;++level) {
        std::string outer="{\"branch\":"+result+",\"siblings\":{";
        for(unsigned member=0;member<1000;++member) {
            if(member) outer+=',';
            outer+="\"s"+std::to_string(member)+"\":"+std::to_string(member);
        }
        result=outer+"}}";
    }
    return result;
}
std::string extra(std::string_view name,std::string_view value) {
    std::string result(json_cleanup_fixtures::metadata);
    result.pop_back();result+=",\"";result+=name;result+="\":";result+=value;result+='}';return result;
}

template<class Action> void qualifiedLifetime(std::string_view input,Action action) {
    const auto before=sv_allocation::snapshot();
    {
        sv_allocation::Scope scope;
        alignas(Owner) std::array<std::byte,sizeof(Owner)> storage;
        auto *owner=std::construct_at(reinterpret_cast<Owner *>(storage.data()),input);
        require(bool(owner->qualification()) && sv_json_bounded_recursive_destroy_active(),
                "Actual qualified parse did not retain its destruction authority");
        action(owner->get());
        const auto beforeDestroy=events;
        destroyStackStart=destroyStackLow=emscripten_stack_get_current();watchDestroyStack=true;
        std::destroy_at(owner);++qualifiedDestructions;
        watchDestroyStack=false;
        // Samples are taken at actual deallocation callbacks; they are not an
        // exhaustive high-water instrument for every intervening instruction.
        require(destroyStackLow<=destroyStackStart && destroyStackLow>emscripten_stack_get_end() &&
                destroyStackStart-destroyStackLow<1024*1024,
                "Qualified destruction exceeded the generous 1 MiB sampled stack regression threshold");
        destroyStackMaximum=std::max(destroyStackMaximum,std::size_t(destroyStackStart-destroyStackLow));
        require(events.attempts==beforeDestroy.attempts && events.allocated==beforeDestroy.allocated &&
                events.contexts==beforeDestroy.contexts && events.failures==beforeDestroy.failures,
                "Qualified nlohmann DOM destruction attempted an allocation");
        inactive();
    }
    require(same(sv_allocation::snapshot(),before),"Qualified DOM destruction retained C++ storage or setup ownership");
}

void grammarAndBounds() {
    test([] {
        for(const auto text:{std::string_view{"null"},std::string_view{R"({"same":{"x":[0]},"s\u0061me":7})"},
                             std::string_view{R"(["\ud83d\ude00","e\u0301",true,-0.5e2])"},
                             std::string_view{"\xef\xbb\xbf{}"},json_cleanup_fixtures::metadata})
            censusAgainstNative(text);
        const auto literal=scan(R"({"a":"\ud83d\ude00","a":0})");
        require(literal.census.tokens==5 && literal.census.stringUnits==4 && literal.census.maxDepth==1,
                "Literal duplicate/surrogate census changed");
    });
    test([] {
        constexpr std::array<std::string_view,23> invalid{
            ""," ","{","[","{]","{}x","{} {}","[1,]","[,1]","[1 2]","{\"x\":}","{\"x\":1,}",
            "{\"x\" 1}","01","+1",".1","1.","1e+","NaN","\"\\x20\"","\"\\ud800\"","/*x*/{}","[1\v,2]"};
        for(auto text:invalid) {
            require(scan(text).status==Status::Structural,"Invalid native grammar unexpectedly qualified");
            require(!Json::accept(text.begin(),text.end()),"Independent native parser accepted malformed literal input");
        }
        for(const auto text:{std::string{"\"\xc0\xaf\""},std::string{"\"\xed\xa0\x80\""},std::string{"\"\xf4\x90\x80\x80\""}}) {
            require(scan(text).status==Status::Utf8 && !Json::accept(text),"Invalid UTF-8 unexpectedly qualified or parsed");
        }
    });
    test([] {
        const auto depth=nested(32);censusAgainstNative(depth);
        require(scan(depth).census.maxDepth==32 && scan(nested(33)).status==Status::Depth,
                "Qualification depth boundary changed");
        qualifiedLifetime(depth,[](const Json &value) { require(value.is_array(),"Maximum-depth native array was lost"); });
        const auto tokens=array(65535);const auto result=scan(tokens);
        require(result && result.census.tokens==65536 && scan(array(65536)).status==Status::TokenLimit,
                "Qualification token boundary changed");
        qualifiedLifetime(tokens,[](const Json &value) { require(value.size()==65535,"Maximum-token native array lost elements"); });
        const auto object=wide(1024);censusAgainstNative(object);
        qualifiedLifetime(object,[](const Json &value) {
            require(value.size()==1024 && value.at("key1023").at("array").at(2)==3,
                    "Wide-object native parse lost a final independently named member");
        });
        const auto widest=scalarObject(32767);const auto widestCensus=scan(widest);
        require(widestCensus && widestCensus.census.tokens==65535,"Maximum-width object literal token construction changed");
        qualifiedLifetime(widest,[](const Json &value) {
            require(value.size()==32767 && value.at("s32766")==32766,"Maximum-width native object lost a distinct scalar member");
        });
        const auto combined=deepWide();censusAgainstNative(combined);
        const auto combinedCensus=scan(combined);
        require(combinedCensus.census.maxDepth==32 && combinedCensus.census.tokens>58000,
                "Combined deep/wide metadata did not approach qualification depth/token bounds");
        qualifiedLifetime(combined,[](const Json &value) {
            require(value.at("siblings").size()==1000 && value.at("branch").is_object(),
                    "Combined deep/wide native parse lost independently named sibling/branch members");
        });
    });
    test([] {
        const std::string unit="\""+std::string(1048576,'x')+"\"";
        require(scan(unit).census.stringUnits==1048576 && scan(unit.substr(0,unit.size()-1)+"x\"").status==Status::StringLimit,
                "Qualification decoded string boundary changed");
        const std::string total="["+unit+","+unit+","+unit+","+unit+"]";
        require(scan(total).census.stringUnits==4194304 && scan(total.substr(0,total.size()-1)+",\"x\"]").status==Status::StringLimit,
                "Qualification total decoded string boundary changed");
        const std::string number="0."+std::string(125,'0')+"1";
        require(number.size()==128 && scan(number) && scan(number+"0").status==Status::NumberLimit,
                "Qualification numeric lexeme boundary changed");
        require(scan("1.7976931348623158e308") && scan("1.7976931348623159e308").status==Status::Nonfinite,
                "Qualification finite binary64 boundary disagrees with native conversion");
        std::string padded(16*1024*1024+1,' ');padded[0]='{';padded[1]='}';
        require(scan(std::string_view(padded).substr(0,padded.size()-1)) && scan(padded).status==Status::ByteLimit,
                "Qualification original-byte boundary changed");
        for(unsigned field=0;field<6;++field) {
            sv_json::MetadataLimits limits;
            std::array<std::size_t *,6> fields{&limits.maxBytes,&limits.maxDepth,&limits.maxTokens,
                &limits.maxStringUnits,&limits.maxTotalStringUnits,&limits.maxNumberCharacters};
            *fields[field]=0;require(scan("null",limits).status==Status::InvalidLimits,"Zero qualification bound accepted");
        }
        sv_json::MetadataLimits tight;tight.maxTokens=4;
        require(scan(R"({"a":0,"a":1})",tight).status==Status::TokenLimit && scan(R"({"a":0,"a":1})"),
                "Caller tightened scan bounds changed default owner qualification");
    });
}

void ownershipAndUnwind() {
    test([] {
        inactive();const auto before=sv_allocation::snapshot();
        {
            sv_allocation::Scope scope;Owner outer("{}");
            require(sv_json_bounded_recursive_destroy_active(),"Outer parsed owner did not retain authority");
            {
                Owner fallback(nested(33));
                require(fallback.qualification().status==Status::Depth && fallback.get().is_array() &&
                        !sv_json_bounded_recursive_destroy_active(),"Unqualified nested owner inherited unrelated parsed authority");
                { Owner inner("[1]");require(sv_json_bounded_recursive_destroy_active(),"Qualified nested owner failed to establish its own authority"); }
                require(!sv_json_bounded_recursive_destroy_active(),"Qualified nested destruction failed to restore fallback masking");
            }
            require(sv_json_bounded_recursive_destroy_active(),"Fallback destruction failed to restore outer authority");
            bool refused=false;
            try { Owner invalid(R"({"same":[1],"same":truX})"); }
            catch(const Json::parse_error &) { refused=true; }
            require(refused && sv_json_bounded_recursive_destroy_active(),"Failed nested parse failed to restore outer authority");
        }
        inactive();require(same(sv_allocation::snapshot(),before),"Nested authority/parse failure leaked a DOM or context");
    });
    test([] {
        const std::string duplicate=R"({"same":{"overwritten":[{"long":"a string larger than the short string optimization"},1,2]},"same":[4,5],"s\u0061me":{"last":7},"deep":)"+nested(31)+"}";
        censusAgainstNative(duplicate);
        qualifiedLifetime(duplicate,[](const Json &value) {
            require(value.at("same").at("last")==7 && value.size()==2,"Duplicate decoded key last-write semantics changed");
        });
        const auto before=sv_allocation::snapshot();bool unwound=false;std::size_t attemptsBeforeUnwind{};
        struct SchemaFailure {};
        try {
            sv_allocation::Scope scope;Owner owner(duplicate);
            attemptsBeforeUnwind=events.attempts;throw SchemaFailure{};
        } catch(const SchemaFailure &) { unwound=true; }
        require(unwound && events.attempts==attemptsBeforeUnwind && same(sv_allocation::snapshot(),before),
                "Schema unwind allocated while retiring qualified duplicate/deep DOM storage");inactive();
    });
    test([] {
        const std::string input=R"({"same":{"overwritten":[{"text":"long enough to have its own allocation"},1,2,3]},"same":[4,5],"s\u0061me":{"last":7},"deep":)"+nested(31)+"}";
        require(bool(scan(input)),"Allocation sweep input is outside qualified metadata domain");
        bool completed=false;
        for(std::size_t ordinal=1;ordinal<4096;++ordinal) {
            const auto before=sv_allocation::snapshot();const auto counts=events;bool failed=false;
            sawRefusal=false;watchRefusalCleanup=true;firstPostRefusalRequested=0;
            const auto cleanupAttempts=afterRefusalAttempts,cleanupBackend=afterRefusalBackendEvents;
            sv_allocation::failBackendAtForContracts(ordinal);
            try { sv_allocation::Scope scope;Owner owner(input);require(owner.get().at("same").at("last")==7,"Successful sweep parse changed duplicates"); }
            catch(const std::bad_alloc &) { failed=true; }
            watchRefusalCleanup=false;
            sv_allocation::failBackendAtForContracts(0);
            inactive();require(same(sv_allocation::snapshot(),before),"Qualified parse allocation refusal leaked owner/storage/context");
            require(afterRefusalAttempts==cleanupAttempts && afterRefusalBackendEvents==cleanupBackend,
                    "Qualified parse failure attempted new/backend storage during cleanup after the injected refusal");
            require(events.allocated-counts.allocated==events.released-counts.released &&
                    events.contexts-counts.contexts==events.retired-counts.retired,
                    "Qualified parse sweep lost a successful actual allocation/context release");
            if(events.failures==counts.failures) { require(!failed,"Successful parse sweep unexpectedly threw");completed=true;break; }
            require(events.failures==counts.failures+1 && failed,"Qualified allocation refusal did not reach ordinary bad_alloc cleanup");
            ++parseAllocationRefusals;
        }
        require(completed && parseAllocationRefusals>32,"Qualified duplicate/depth parse sweep never reached a complete success");
    });
    test([] {
        for(const auto text:{std::string_view{R"({"same":{"x":[1,2]},"same":)"},
                             std::string_view{R"({"number":1e309})"},std::string_view{"{\"bad\":\"\xc0\xaf\"}"}}) {
            const auto before=sv_allocation::snapshot();bool refused=false;
            try { sv_allocation::Scope scope;Owner owner(text); }
            catch(const Json::exception &) { refused=true; }
            require(refused && same(sv_allocation::snapshot(),before),"Ordinary compatibility parse error retained DOM storage");inactive();
        }
    });
}

// Independent minimal ZIP_STORED construction. CRC is the bitwise ZIP IEEE
// polynomial, not the application's libdeflate function or SOG exporter.
std::uint32_t crc(std::span<const std::uint8_t> bytes) noexcept {
    std::uint32_t result=0xffffffffu;
    for(auto value:bytes) { result^=value;for(unsigned i=0;i<8;++i) result=(result>>1)^((result&1)?0xedb88320u:0); }
    return ~result;
}
void u16(Bytes &bytes,std::uint16_t value) { bytes.push_back(value);bytes.push_back(value>>8); }
void u32(Bytes &bytes,std::uint32_t value) { u16(bytes,value);u16(bytes,value>>16); }
std::span<const std::uint8_t> byteView(std::string_view text) {
    return {reinterpret_cast<const std::uint8_t *>(text.data()),text.size()};
}
Bytes archive(std::string_view metadata,bool missing=false,bool truncated=false) {
    struct Member { std::string_view name;std::span<const std::uint8_t> data;std::uint32_t offset{},checksum{}; };
    std::array<Member,5> members{{{"meta.json",byteView(metadata)},
        {"positions-low.webp",json_cleanup_fixtures::low},{"positions-high.webp",json_cleanup_fixtures::high},
        {"appearance.webp",json_cleanup_fixtures::appearance},{"rotations.webp",json_cleanup_fixtures::rotations}}};
    if(truncated) members[1].data=members[1].data.first(12);
    Bytes result;unsigned count{};
    for(auto &member:members) {
        if(missing && member.name=="appearance.webp") continue;
        ++count;member.offset=result.size();member.checksum=crc(member.data);
        u32(result,0x04034b50);u16(result,20);u16(result,0);u16(result,0);u16(result,0);u16(result,33);
        u32(result,member.checksum);u32(result,member.data.size());u32(result,member.data.size());u16(result,member.name.size());u16(result,0);
        result.insert(result.end(),member.name.begin(),member.name.end());result.insert(result.end(),member.data.begin(),member.data.end());
    }
    const auto directory=result.size();
    for(const auto &member:members) {
        if(missing && member.name=="appearance.webp") continue;
        u32(result,0x02014b50);u16(result,20);u16(result,20);u16(result,0);u16(result,0);u16(result,0);u16(result,33);
        u32(result,member.checksum);u32(result,member.data.size());u32(result,member.data.size());u16(result,member.name.size());
        u16(result,0);u16(result,0);u16(result,0);u16(result,0);u32(result,0);u32(result,member.offset);
        result.insert(result.end(),member.name.begin(),member.name.end());
    }
    const auto directoryBytes=result.size()-directory;
    u32(result,0x06054b50);u16(result,0);u16(result,0);u16(result,count);u16(result,count);
    u32(result,directoryBytes);u32(result,directory);u16(result,0);return result;
}
Json parse(const char *text) { return Json::parse(text); }
Json command(const char *text) { return parse(admittedContractCommand(text)); }
Json summary() { return command(R"({"command":"summary"})"); }
Json open(const Bytes &input,unsigned budget=sceneBudget) { return parse(sv_open(input.data(),input.size(),0,100,budget)); }
using SceneBytes=std::array<preview::Gaussian,3>;
SceneBytes sceneBytes() { SceneBytes result;require(sv_scene_ptr()!=nullptr,"Native scene owner is absent");std::memcpy(result.data(),sv_scene_ptr(),sizeof(result));return result; }
void checkSog(const Json &value) {
    require(value.at("ok")==true && value.at("count")==3 && value.at("format")=="SOG v1","Valid independent SOG metadata failed native publication");
    for(unsigned record=0;record<3;++record) for(unsigned field=0;field<4;++field)
        require(std::isfinite(sv_scene_ptr()[record].positionOpacity[field]) &&
                std::abs(double(sv_scene_ptr()[record].positionOpacity[field])-json_cleanup_fixtures::positionsOpacity[record][field])<=0.000004,
                "Metadata variant changed independently fixed Decimal80 positions/opacity");
    inactive();
}
void checkContentKey(const std::string &value,std::string_view expected) {
    require(value.size()==64 && std::all_of(value.begin(),value.end(),[](char character) {
        return (character>='0' && character<='9') || (character>='a' && character<='f');
    }),"Actual content key is not a complete lowercase SHA256 string");
    require(value==expected,"Actual source content key differs from the independent fixed ZIP SHA256 oracle");
    ++independentArchiveHashes;
}
Json finish(const char *request) {
    auto value=command(request);
    for(unsigned step=0;value.value("pending",false);++step) { require(step<8,"Tiny retained transform did not settle");value=parse(sv_step(65536)); }
    require(value.at("ok")==true,"Retained transform fixture failed");return value;
}
SceneBytes redoScene;
void prepareRetained() {
    checkSog(open(archive(json_cleanup_fixtures::metadata)));
    require(command(R"({"command":"single","index":1,"operation":0})").at("selected")==1,"Retained SOG fixture selection failed");
    finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,2,0,0,1]})");
    finish(R"({"command":"transform","matrix":[1,0,0,0,0,1,0,0,0,0,1,0,3,0,0,1]})");
    redoScene=sceneBytes();
    require(command(R"({"command":"undo"})").at("canRedo")==true,"Retained SOG fixture lacks executable Redo");
    require(command(R"({"command":"export","format":5})").at("ok")==true,"Retained SOG fixture output failed");
}
struct Retained {
    Json value=summary();SceneBytes scene=sceneBytes();
    const preview::Gaussian *sceneOwner=sv_scene_ptr();
    const std::uint8_t *statesOwner=sv_states_ptr(),*outputOwner=sv_output_ptr();
    std::array<std::uint8_t,3> mask{sv_states_ptr()[0],sv_states_ptr()[1],sv_states_ptr()[2]};
    Bytes output{sv_output_ptr(),sv_output_ptr()+sv_output_len()};Snapshot census=sv_allocation::snapshot();
    void check() const {
        require(summary()==value,"Rejected SOG candidate changed summary/history/revision/admission");
        require(sv_scene_ptr()==sceneOwner && !std::memcmp(sv_scene_ptr(),scene.data(),sizeof(scene)),"Rejected SOG candidate changed edited scene owner or Gaussian bytes");
        require(sv_states_ptr()==statesOwner && !std::memcmp(sv_states_ptr(),mask.data(),mask.size()),"Rejected SOG candidate changed selected mask owner/bytes");
        require(sv_output_ptr()==outputOwner && sv_output_len()==output.size() && !std::memcmp(sv_output_ptr(),output.data(),output.size()),
                "Rejected SOG candidate changed previous export owner/bytes");
        require(same(sv_allocation::snapshot(),census),"Rejected SOG candidate retained C++ scratch/DOM/context ownership");inactive();
    }
    void executableRedo() const {
        require(command(R"({"command":"redo"})").at("ok")==true && !std::memcmp(sv_scene_ptr(),redoScene.data(),sizeof(redoScene)),
                "Rejected SOG candidate damaged executable complete native Redo");
        require(command(R"({"command":"undo"})").at("canRedo")==true && !std::memcmp(sv_scene_ptr(),scene.data(),sizeof(scene)),
                "Native Redo/Undo after candidate refusal failed to restore complete edited bytes");
    }
};

void actualSogBoundary() {
    test([] {
        const auto before=sv_allocation::snapshot();
        {
            sv_allocation::Scope scope;preview::LoadOptions options;options.maxSplats=100;options.maxBytes=sceneBudget;
            const auto input=archive(extra("unknown",nested(31)));
            const auto scene=preview::loadScene(input,options);
            require(scene.gaussians.size()==3 && scene.sourceCount==3 && scene.format=="SOG v1","Actual loadSog maximum-depth metadata failed");
            for(unsigned i=0;i<3;++i) for(unsigned field=0;field<4;++field)
                require(std::abs(double(scene.gaussians[i].positionOpacity[field])-json_cleanup_fixtures::positionsOpacity[i][field])<=0.000004,
                        "Actual loadSog maximum-depth result changed independent position/opacity oracle");
            const auto base=archive(json_cleanup_fixtures::metadata);
            auto duplicateMetadata=extra("same",nested(31));duplicateMetadata.pop_back();duplicateMetadata+=",\"same\":{\"last\":7}}";
            const auto duplicate=archive(duplicateMetadata);
            require(base.size()==json_cleanup_fixtures::baseArchiveBytes && duplicate.size()==json_cleanup_fixtures::duplicateArchiveBytes,
                    "Independent deterministic ZIP byte-length framing changed");
            checkContentKey(preview::contentKey(base),json_cleanup_fixtures::baseArchiveSha256);
            checkContentKey(preview::contentKey(duplicate),json_cleanup_fixtures::duplicateArchiveSha256);
            checkContentKey(preview::loadScene(base,options).sourceContentKey,json_cleanup_fixtures::baseArchiveSha256);
            checkContentKey(preview::loadScene(duplicate,options).sourceContentKey,json_cleanup_fixtures::duplicateArchiveSha256);
        }
        inactive();require(same(sv_allocation::snapshot(),before),"Actual loadSog retained metadata DOM or scene after owner retirement");
    });
    test([] {
        prepareRetained();
        std::vector<Bytes> invalid;
        invalid.push_back(archive(R"({"means":{"shape":[3,3]},"means":)"));
        invalid.push_back(archive(extra("version","99")));
        invalid.push_back(archive(extra("unknown","1e309")));
        invalid.push_back(archive(json_cleanup_fixtures::metadata,true));
        invalid.push_back(archive(json_cleanup_fixtures::metadata,false,true));
        std::string oversized(16*1024*1024+1,' ');oversized[0]='{';oversized[1]='}';invalid.push_back(archive(oversized));
        for(const auto &input:invalid) {
            const Retained before;
            const auto value=open(input);require(value.at("ok")==false,"Ordinary invalid SOG candidate was accepted");
            ++ordinaryRefusals;before.check();before.executableRedo();
        }
    });
    test([] {
        prepareRetained();
        const auto qualified=extra("same",nested(31));
        const auto metadata=qualified.substr(0,qualified.size()-1)+",\"same\":{\"last\":7}}";
        const auto input=archive(metadata);
        require(bool(scan(metadata)),"Actual binding allocation sweep input was not wholly qualified");
        bool completed=false;
        for(std::size_t ordinal=1;ordinal<4096;++ordinal) {
            const Retained before;const auto failures=events.failures;
            sawRefusal=false;watchRefusalCleanup=true;firstPostRefusalRequested=0;
            const auto cleanupAttempts=afterRefusalAttempts,cleanupBackend=afterRefusalBackendEvents;
            sv_allocation::failBackendAtForContracts(ordinal);
            const auto *raw=sv_open(input.data(),input.size(),0,100,sceneBudget);
            watchRefusalCleanup=false;
            sv_allocation::failBackendAtForContracts(0);
            const auto value=parse(raw);
            if(afterRefusalAttempts!=cleanupAttempts || afterRefusalBackendEvents!=cleanupBackend) {
                const char *error=value.contains("error") && value.at("error").is_string() ?
                    value.at("error").get_ref<const std::string &>().c_str() : "";
                std::fprintf(stderr,"JSON_CLEANUP_CANDIDATE_DIAGNOSTIC ordinal=%zu refusedRequested=%zu refusedRaw=%zu authority=%u firstPostRefusalRequested=%zu postNew=%zu postBackend=%zu ok=%u error=%s\n",
                    ordinal,refusalRequested,refusalRaw,unsigned(refusalAuthority),firstPostRefusalRequested,
                    afterRefusalAttempts-cleanupAttempts,afterRefusalBackendEvents-cleanupBackend,
                    unsigned(value.value("ok",false)),error);
            }
            require(afterRefusalAttempts==cleanupAttempts && afterRefusalBackendEvents==cleanupBackend,
                    "Qualified SOG candidate failure attempted C++ new/backend storage before binding unwind completed");
            if(events.failures==failures) {
                checkSog(value);completed=true;break;
            }
            require(events.failures==failures+1 && value.at("ok")==false,"Real qualified SOG backend refusal was swallowed");
            ++candidateAllocationRefusals;before.check();before.executableRedo();
        }
        require(completed && candidateAllocationRefusals>32,"Real qualified SOG candidate allocation sweep did not finish");
    });
    test([] {
        const auto base=archive(json_cleanup_fixtures::metadata);checkSog(open(base));const auto expected=sceneBytes();
        const std::string longString="\""+std::string(1048577,'x')+"\"";
        const std::string number="0."+std::string(126,'0')+"1";
        const std::string part="\""+std::string(1048576,'x')+"\"";
        const std::array<std::pair<std::string,Status>,5> fallback{{
            {extra("unknown",nested(32)),Status::Depth},{extra("unknown",array(65536)),Status::TokenLimit},
            {extra("unknown",longString),Status::StringLimit},{extra("unknown",number),Status::NumberLimit},
            {extra("unknown","["+part+","+part+","+part+","+part+","+part+"]"),Status::StringLimit}}};
        for(const auto &[metadata,status]:fallback) {
            require(scan(metadata).status==status,"Fallback metadata did not cross the intended independent qualification bound");
            checkSog(open(archive(metadata)));++fallbackSuccesses;
            require(!std::memcmp(sv_scene_ptr(),expected.data(),sizeof(expected)),"Accepted fallback metadata changed complete Gaussian records");
        }
        checkSog(open(archive(extra("unknown",wide(1024)))));
        checkSog(open(archive(extra("unknown",nested(31)))));
        // A duplicate decoded version key retains native last-write behavior.
        auto duplicate=std::string(json_cleanup_fixtures::metadata);duplicate.insert(1,"\"version\":99,");
        duplicate.pop_back();duplicate+=",\"v\\u0065rsion\":1}";
        checkSog(open(archive(duplicate)));
    });
    test([] {
        checkSog(open(archive(json_cleanup_fixtures::metadata)));
        require(command(R"({"command":"beginSelection"})").at("ok")==true,"Large-path fixture failed to begin a selection draft");
        std::string request=R"({"command":"brush","fromBaseline":true,"width":64,"height":64,"camera":[0,0,0,0,0,4,1,45,1,0],"operation":0,"visibleOnly":false,"overlap":false,"radius":1,"points":[)";
        for(unsigned point=0;point<65536;++point) { if(point) request+=',';request+="[-1000,-1000]"; }
        request+="]}";
        require(scan(request).status==Status::TokenLimit,"65536-point command did not exceed metadata-only qualification tokens");
        const auto value=parse(sv_live_preview(request.c_str()));
        require(value.at("ok")==true,"Metadata qualification incorrectly reduced existing 65536-point live path limit");
        largeCommandPoints=65536;inactive();
        require(command(R"({"command":"cancelSelection"})").at("ok")==true,"Large-path fixture failed to retire its draft");
    });
}
} // namespace

int main() {
    static_assert(std::is_same_v<decltype(std::declval<const Owner &>().get()),const Json &>);
    static_assert(!std::is_copy_constructible_v<Owner> && !std::is_move_constructible_v<Owner>);
    sv_allocation::setObserverForContracts(observe);
    try {
        grammarAndBounds();ownershipAndUnwind();actualSogBoundary();inactive();
        require(sv_allocation::validSnapshot(sv_allocation::snapshot()),"Final actual binding census is invalid");
        sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);
        std::printf("SPLATVIEW_JSON_CLEANUP_CONTRACTS_PASS cases=%zu assertions=%zu scans=%zu qualificationRefusals=%zu qualifiedDestructions=%zu parseAllocationRefusals=%zu candidateAllocationRefusals=%zu ordinaryRefusals=%zu fallbackSuccesses=%zu largeCommandPoints=%zu observedDestroyStackBytes=%zu postRefusalNewAttempts=%zu postRefusalBackendEvents=%zu independentArchiveHashChecks=%zu\n",
            cases,assertions,scans,grammarRefusals,qualifiedDestructions,parseAllocationRefusals,candidateAllocationRefusals,
            ordinaryRefusals,fallbackSuccesses,largeCommandPoints,destroyStackMaximum,afterRefusalAttempts,afterRefusalBackendEvents,
            independentArchiveHashes);return 0;
    } catch(const std::exception &error) {
        sv_allocation::setObserverForContracts(nullptr);sv_allocation::failBackendAtForContracts(0);
        std::fprintf(stderr,"JSON_CLEANUP_CONTRACT_FAILURE case=%zu: %s\n",cases+1,error.what());return 1;
    }
}
