// Main-only tests compile the exact binding in this translation unit. Private
// registry inspection/exhaustion below adds no exported observation/fault API.
#include "source_hash_bindings.cpp"
#include <array>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {
using Bytes=std::vector<std::uint8_t>;
using SlotBytes=std::array<std::uint8_t,sizeof(Slot)>;
std::size_t assertions{},hashCases{};
std::array<std::uint8_t,66> output;

void require(bool condition,const char *message) {
    ++assertions;
    if(!condition) throw std::runtime_error(message);
}
std::uint32_t pointer(const void *value) {
    return std::uint32_t(reinterpret_cast<std::uintptr_t>(value));
}
SlotBytes slotBytes() {
    SlotBytes bytes{};
    std::memcpy(bytes.data(),&slot,bytes.size());
    return bytes;
}
template<class Action>
void refuses(Action action,std::uint32_t expected,const char *message) {
    output.fill(0xa7);
    const auto before=slotBytes();
    const auto beforeOutput=output;
    require(action()==expected,message);
    require(slotBytes()==before,"A refused operation changed hash or registry bytes");
    require(output==beforeOutput,"A refused operation changed output sentinels");
}
std::string hex(const std::uint8_t *data,std::size_t size) {
    constexpr char digits[]="0123456789abcdef";
    std::string value(size*2,'0');
    for(std::size_t i=0;i<size;++i) {
        value[i*2]=digits[data[i]>>4]; value[i*2+1]=digits[data[i]&15];
    }
    return value;
}
std::string digest(std::uint32_t handle) {
    output.fill(0x5d);
    require(sv_source_hash_digest(handle,pointer(output.data()+1),32)==0,
            "Finished hash did not copy its digest");
    require(output.front()==0x5d && std::all_of(output.begin()+33,output.end(),
            [](std::uint8_t value){return value==0x5d;}),
            "Digest wrote outside its exact unaligned 32-byte output span");
    return hex(output.data()+1,32);
}
std::string hash(std::uint32_t handle,const Bytes &data,std::size_t chunk) {
    require(sv_source_hash_reset(handle)==0,"Hash reset failed");
    require(sv_source_hash_begin(handle,double(data.size()))==0,"Hash begin failed");
    Bytes borrowed(std::min(chunk,data.size())+1);
    for(std::size_t offset=0;offset<data.size();) {
        const auto count=std::min(chunk,data.size()-offset);
        std::copy_n(data.data()+offset,count,borrowed.data()+1);
        require(sv_source_hash_update(handle,double(offset),pointer(borrowed.data()+1),
                std::uint32_t(count))==0,"Sequential borrowed input failed");
        offset+=count;
    }
    require(sv_source_hash_finish(handle)==0,"Complete hash did not finish");
    ++hashCases;
    return digest(handle);
}
Bytes bytes(std::string_view text) { return Bytes(text.begin(),text.end()); }
std::string reference(const Bytes &data) {
    // Independent frozen streaming wrapper, used only by this contract main.
    picosha2::hash256_one_by_one hash;
    hash.process(data.begin(),data.end()); hash.finish();
    std::array<std::uint8_t,32> out{};
    hash.get_hash_bytes(out.begin(),out.end());
    return hex(out.data(),out.size());
}
}

int main() {
    try {
        static_assert(sizeof(std::uintptr_t)==4 && sizeof(std::size_t)==4);
        static_assert(sizeof(picosha2::word_t)==4);
        require(sizeof(SourceHash)<=192 && sizeof(Slot)==sizeof(SourceHash)+8,
                "Unexpected source hash/registry ABI size");
        require(SourceHash::compressionScheduleBytes==256,"Unexpected frozen compression schedule ABI");
        require(SourceHash::maxChunkBytes==1024*1024 &&
                SourceHash::maxExpectedBytes==9'007'199'254'740'991ULL,"Hash bounds changed");
        auto handle=sv_source_hash_create();
        require(handle==1 && sv_source_hash_create()==0,"One fixed owner must refuse concurrent creation");
        require(sv_source_hash_state(handle)==0 && sv_source_hash_expected_bytes(handle)==0 &&
                sv_source_hash_consumed_bytes(handle)==0,"New owner must be idle");
        refuses([&]{return sv_source_hash_finish(handle);},1,"Idle finish succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,0,0);},1,"Idle update succeeded");
        refuses([&]{return sv_source_hash_digest(handle,pointer(output.data()+1),32);},1,
                "Idle hash published a digest");
        for(double invalid:{-1.,.5,9'007'199'254'740'992.,
                std::numeric_limits<double>::quiet_NaN(),std::numeric_limits<double>::infinity(),
                -std::numeric_limits<double>::infinity()})
            refuses([&]{return sv_source_hash_begin(handle,invalid);},InvalidByteCount,
                    "Invalid double expected byte count succeeded");

        Bytes input(SourceHash::maxChunkBytes+3);
        const auto heap=std::uint32_t(emscripten_get_heap_size());
        const auto outputPointer=pointer(output.data()+1),inputPointer=pointer(input.data()+1);
        require(sv_source_hash_begin(handle,3)==0,"Valid begin failed");
        refuses([&]{return sv_source_hash_begin(handle,3);},1,"Active begin succeeded");
        for(double invalid:{-1.,.5,9'007'199'254'740'992.,
                std::numeric_limits<double>::quiet_NaN(),std::numeric_limits<double>::infinity()})
            refuses([&]{return sv_source_hash_update(handle,invalid,inputPointer,1);},InvalidByteCount,
                    "Invalid double input offset succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,0,1);},5,"Nonempty null input succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,heap-1,2);},HeapRange,"Input crossed heap end");
        refuses([&]{return sv_source_hash_update(handle,0,0xffffffffU,2);},HeapRange,
                "Overflowing uint32 input range succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,heap+1,0);},HeapRange,
                "Zero input beyond heap succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,pointer(&slot),1);},ProtectedOwnerMemory,
                "Input aliased owner storage");
        refuses([&]{return sv_source_hash_update(handle,0,pointer(&slot.activeHandle),1);},ProtectedOwnerMemory,
                "Input aliased registry storage");
        refuses([&]{return sv_source_hash_update(handle,1,inputPointer,1);},3,"Offset gap succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,inputPointer,SourceHash::maxChunkBytes+1);},4,
                "Oversized chunk succeeded");
        refuses([&]{return sv_source_hash_update(handle,0,inputPointer,4);},7,"Input exceeded expected bytes");
        require(sv_source_hash_update(handle,0,0,0)==0 && sv_source_hash_update(handle,0,heap,0)==0,
                "Valid zero-length input failed");
        std::copy_n(reinterpret_cast<const std::uint8_t *>("abc"),3,input.data()+1);
        require(sv_source_hash_update(handle,0,inputPointer,2)==0,"First borrowed bytes failed");
        refuses([&]{return sv_source_hash_finish(handle);},8,"Truncated hash finished");
        refuses([&]{return sv_source_hash_update(handle,0,inputPointer,1);},3,"Duplicate offset succeeded");
        require(sv_source_hash_update(handle,2,inputPointer+2,1)==0,"Last borrowed byte failed");
        std::fill_n(input.data()+1,3,0);
        require(sv_source_hash_finish(handle)==0,"Complete borrowed hash failed");
        constexpr auto abc="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        constexpr auto empty="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        require(digest(handle)==abc,"Binding retained or re-read borrowed input");
        refuses([&]{return sv_source_hash_finish(handle);},1,"Double finish succeeded");
        refuses([&]{return sv_source_hash_update(handle,3,0,0);},1,"Finished update succeeded");
        for(std::uint32_t length:{0U,31U,33U,0xffffffffU})
            refuses([&]{return sv_source_hash_digest(handle,outputPointer,length);},InvalidOutputSize,
                    "Digest accepted a non-32-byte output length");
        refuses([&]{return sv_source_hash_digest(handle,0,32);},5,"Digest accepted null output");
        refuses([&]{return sv_source_hash_digest(handle,heap-31,32);},HeapRange,"Digest crossed heap end");
        refuses([&]{return sv_source_hash_digest(handle,0xffffffffU,32);},HeapRange,
                "Digest accepted overflowing uint32 output range");
        for(auto protectedPointer:{pointer(&slot),pointer(&slot.activeHandle),pointer(&slot.lastIssued)})
            refuses([&]{return sv_source_hash_digest(handle,protectedPointer,32);},ProtectedOwnerMemory,
                    "Digest output aliased owner/registry storage");
        refuses([&]{return sv_source_hash_digest(0,outputPointer,32);},InvalidHandle,"Zero handle digest succeeded");
        refuses([&]{return sv_source_hash_digest(0xffffffffU,outputPointer,32);},InvalidHandle,
                "Forged handle digest succeeded");
        refuses([&]{return sv_source_hash_begin(handle,std::numeric_limits<double>::quiet_NaN());},InvalidByteCount,
                "Invalid begin replaced finished digest");
        require(digest(handle)==abc,"Refused operations changed the finished digest");
        require(sv_source_hash_begin(handle,0)==0,"Valid begin could not replace finished digest");
        refuses([&]{return sv_source_hash_digest(handle,outputPointer,32);},1,"New active hash published old digest");
        require(sv_source_hash_finish(handle)==0 && digest(handle)==empty,"Empty replacement hash failed");

        // Primary vectors: NIST SHA256.pdf, RFC8760 section2.6 and RFC6234 section8.5.
        const std::array<std::pair<Bytes,std::string_view>,4> vectors{{
            {Bytes{},empty},{bytes("abc"),abc},
            {bytes("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
             "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"},
            {Bytes(1000000,0x61),"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"}
        }};
        require(vectors[2].first.size()==56,"Long literal SHA256 vector is not 56 bytes");
        for(const auto &[data,expected]:vectors)
            for(std::size_t chunk:{1U,7U,55U,56U,63U,64U,65U,65536U,1024U*1024U})
                require(hash(handle,data,chunk)==expected,"Published SHA256 binding vector failed");
        for(std::size_t length:{1U,55U,56U,63U,64U,65U,119U,120U,127U,128U,129U,
                1024U*1024U-1,1024U*1024U,1024U*1024U+1}) {
            Bytes data(length);
            for(std::size_t i=0;i<length;++i)data[i]=std::uint8_t(i*131+(i>>8)*17+29);
            const auto expected=reference(data);
            for(std::size_t chunk:{63U,64U,65U,65536U,1024U*1024U})
                require(hash(handle,data,chunk)==expected,"Frozen independent streaming reference disagreed");
        }
        require(sv_source_hash_reset(handle)==0 && sv_source_hash_reset(handle)==0,"Idempotent reset failed");
        require(sv_source_hash_begin(handle,double(SourceHash::maxExpectedBytes))==0 &&
                sv_source_hash_expected_bytes(handle)==double(SourceHash::maxExpectedBytes) &&
                sv_source_hash_consumed_bytes(handle)==0,"Maximum safe byte count was truncated");
        refuses([&]{return sv_source_hash_finish(handle);},8,"Unconsumed maximum-sized hash finished");
        require(sv_source_hash_reset(handle)==0 && sv_source_hash_begin(handle,3)==0 &&
                sv_source_hash_update(handle,0,inputPointer,1)==0,"Partial cancellation setup failed");
        require(sv_source_hash_delete(handle)==0,"Deleting partial hash failed");
        const auto old=handle;
        refuses([&]{return sv_source_hash_delete(old);},InvalidHandle,"Double delete succeeded");
        refuses([&]{return sv_source_hash_reset(old);},InvalidHandle,"Stale reset succeeded");
        refuses([&]{return sv_source_hash_begin(old,0);},InvalidHandle,"Stale begin succeeded");
        refuses([&]{return sv_source_hash_update(old,0,inputPointer,1);},InvalidHandle,"Stale update succeeded");
        refuses([&]{return sv_source_hash_finish(old);},InvalidHandle,"Stale finish succeeded");
        require(sv_source_hash_state(old)==-9 && sv_source_hash_expected_bytes(old)==-9 &&
                sv_source_hash_consumed_bytes(old)==-9,"Stale scalar accessors succeeded");
        handle=sv_source_hash_create();
        require(handle==old+1,"New owner reused a stale handle");
        refuses([&]{return sv_source_hash_delete(old);},InvalidHandle,"Stale delete retired new owner");
        require(sv_source_hash_begin(handle,0)==0 && sv_source_hash_finish(handle)==0 &&
                digest(handle)==empty && sv_source_hash_delete(handle)==0,"New owner failed after stale refusal");

        // Main-local private setup, not a shipping fault/observation entry point.
        slot.lastIssued=std::numeric_limits<std::uint32_t>::max()-1;
        handle=sv_source_hash_create();
        require(handle==std::numeric_limits<std::uint32_t>::max(),"Last uint32 handle was truncated");
        require(sv_source_hash_begin(handle,0)==0 && sv_source_hash_finish(handle)==0 &&
                digest(handle)==empty && sv_source_hash_delete(handle)==0,"Last uint32 owner failed");
        const auto exhausted=slotBytes();
        require(sv_source_hash_create()==0 && sv_source_hash_create()==0 && slotBytes()==exhausted,
                "Exhausted handle counter wrapped or mutated the registry");

        std::cout<<"SPLATVIEW_SOURCE_HASH_CONTRACTS_PASS assertions="<<assertions
            <<" hashCases="<<hashCases<<" ownerBytes="<<sizeof(SourceHash)
            <<" slotBytes="<<sizeof(Slot)<<" wordBytes="<<sizeof(picosha2::word_t)
            <<" pointerBytes="<<sizeof(std::uintptr_t)<<" sizeBytes="<<sizeof(std::size_t)
            <<" compressionScheduleBytes="<<SourceHash::compressionScheduleBytes<<'\n';
        return 0;
    } catch(const std::exception &error) {
        std::cerr<<"SPLATVIEW_SOURCE_HASH_CONTRACTS_FAIL "<<error.what()<<'\n';
        return 1;
    }
}
