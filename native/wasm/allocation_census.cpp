#include "allocation_census.hpp"
#include <algorithm>
#include <cstdlib>
#include <initializer_list>
#include <limits>
#include <memory>
#include <new>

namespace sv_allocation {
struct State {
    State *previous{},*next{};
    std::size_t references{1},raw{},payload{},blocks{};
};
namespace {
struct Header {
    State *owner{};
    void *base{};
    std::size_t requested{},raw{},alignment{},payload{};
};
State *registry{};
thread_local State *active{};
thread_local PayloadTag *tag{};
std::uint64_t issuedSequence{};
constexpr auto maximum=std::numeric_limits<std::size_t>::max();

#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
Observer observer{};
bool observing{};
std::size_t backendAttempts{},failBackendOrdinal{};
void observe(const Event &event) noexcept {
    if(!observer || observing) return;
    observing=true;observer(event);observing=false;
}
#define SV_CENSUS_EVENT(kind, ...) observe(Event{EventKind::kind,__VA_ARGS__})
#else
#define SV_CENSUS_EVENT(kind, ...) ((void)0)
#endif

bool add(std::size_t &total,std::size_t bytes) noexcept {
    if(bytes>maximum-total) return false;
    total+=bytes;return true;
}
bool rawRequest(std::size_t bytes,std::size_t alignment,std::size_t &raw,std::size_t &normalized) noexcept {
    if(!alignment || (alignment&(alignment-1))) return false;
    normalized=std::max(alignment,alignof(Header));
    if(normalized-1>maximum-sizeof(Header)) return false;
    const auto overhead=sizeof(Header)+normalized-1,payload=std::max(bytes,std::size_t{1});
    if(payload>maximum-overhead) return false;
    raw=payload+overhead;return true;
}
void *backend(std::size_t raw,State *owner,std::size_t requested,std::size_t alignment,std::size_t payload) noexcept {
#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
    if(backendAttempts!=maximum) ++backendAttempts;
    if(failBackendOrdinal && backendAttempts==failBackendOrdinal) {
        failBackendOrdinal=0;
        SV_CENSUS_EVENT(BackendFailure,nullptr,owner,requested,raw,alignment,payload);
        return nullptr;
    }
#endif
    void *pointer=std::malloc(raw);
    if(!pointer) SV_CENSUS_EVENT(BackendFailure,nullptr,owner,requested,raw,alignment,payload);
    return pointer;
}
void releaseState(State *state) noexcept {
    if(!state || --state->references) return;
    // A context is retained once by every surviving block. This cannot become
    // the final reference while any accounted physical block still exists.
    if(state->raw || state->payload || state->blocks) std::abort();
    if(state->previous) state->previous->next=state->next;
    else registry=state->next;
    if(state->next) state->next->previous=state->previous;
    std::destroy_at(state);std::free(state);
    SV_CENSUS_EVENT(ContextReleased,state,state,sizeof(State),sizeof(State),alignof(State),0);
}
Header *header(void *pointer) noexcept {
    return reinterpret_cast<Header *>(static_cast<std::byte *>(pointer)-sizeof(Header));
}
} // namespace

struct AllocationAccess {
    static std::size_t consumePayload() noexcept {
        if(!tag || !tag->pending_) return 0;
        tag->pending_=false;
        // Outside-context allocations retain a consistent header/free route,
        // but belong to runtime storage outside this reported subset.
        return active ? tag->bytes_ : 0;
    }
};

// Shared by every replacement form. Backend allocation never calls C++ new.
void *allocate(std::size_t bytes,std::size_t alignment) noexcept {
    const auto payload=AllocationAccess::consumePayload();
    std::size_t raw{},normalized{};
    const bool representable=rawRequest(bytes,alignment,raw,normalized);
    State *const owner=active;
    SV_CENSUS_EVENT(NewAttempt,nullptr,owner,bytes,representable ? raw : 0,alignment,payload);
    if(!representable || payload>bytes) return nullptr;
    if(owner && (raw>maximum-owner->raw || payload>maximum-owner->payload ||
                 owner->references==maximum || owner->blocks==maximum)) return nullptr;
    void *base=backend(raw,owner,bytes,alignment,payload);
    if(!base) return nullptr;
    const auto start=reinterpret_cast<std::uintptr_t>(base)+sizeof(Header);
    const auto address=(start+normalized-1)&~(std::uintptr_t(normalized)-1);
    void *const pointer=reinterpret_cast<void *>(address);
    std::construct_at(header(pointer),Header{owner,base,bytes,raw,alignment,payload});
    if(owner) {
        ++owner->references;owner->raw+=raw;owner->payload+=payload;++owner->blocks;
    }
    SV_CENSUS_EVENT(BlockAllocated,pointer,owner,bytes,raw,alignment,payload);
    return pointer;
}
void release(void *pointer) noexcept {
    if(!pointer) return;
    const Header value=*header(pointer);
    std::destroy_at(header(pointer));std::free(value.base);
    if(value.owner) {
        value.owner->raw-=value.raw;value.owner->payload-=value.payload;--value.owner->blocks;
    }
    SV_CENSUS_EVENT(BlockReleased,pointer,value.owner,value.requested,value.raw,value.alignment,value.payload);
    releaseState(value.owner);
}

Scope::Scope() : previous_(active) {
    void *block=backend(sizeof(State),nullptr,sizeof(State),alignof(State),0);
    if(!block) throw std::bad_alloc{};
    owner_=std::construct_at(static_cast<State *>(block));
    owner_->next=registry;
    if(registry) registry->previous=owner_;
    registry=owner_;active=owner_;
    SV_CENSUS_EVENT(ContextAllocated,owner_,owner_,sizeof(State),sizeof(State),alignof(State),0);
}
Scope::~Scope() noexcept { active=previous_;releaseState(owner_); }
PayloadTag::PayloadTag(std::size_t bytes) noexcept : previous_(tag),bytes_(bytes) { tag=this; }
PayloadTag::~PayloadTag() noexcept { tag=previous_; }

bool validSnapshot(const Snapshot &value) noexcept {
    if(!value.valid || value.overlapBytes>value.scenePayloadBytes || value.overlapBytes>value.ownedRawBytes ||
       value.contextBytes>value.ownedRawBytes || value.scenePayloadBytes!=value.overlapBytes ||
       value.liveContexts>maximum/sizeof(State) || value.contextBytes!=value.liveContexts*sizeof(State)) return false;
    const auto remainder=value.ownedRawBytes-value.overlapBytes;
    if(value.scenePayloadBytes>maximum-remainder || value.unionBytes!=value.scenePayloadBytes+remainder) return false;
    if(!value.liveContexts && (value.liveBlocks || value.ownedRawBytes || value.scenePayloadBytes)) return false;
    if(!value.liveBlocks && (value.scenePayloadBytes || value.ownedRawBytes!=value.contextBytes)) return false;
    for(const auto field:{value.scenePayloadBytes,value.ownedRawBytes,value.overlapBytes,value.contextBytes,
                          value.unionBytes,value.liveBlocks,value.liveContexts})
        if(field>maxQuerySequence) return false;
    return true;
}
Snapshot snapshot() noexcept {
    Snapshot value;value.valid=true;
    for(auto *state=registry;state;state=state->next) {
        if(!add(value.scenePayloadBytes,state->payload) || !add(value.overlapBytes,state->payload) ||
           !add(value.ownedRawBytes,state->raw) || !add(value.ownedRawBytes,sizeof(State)) ||
           !add(value.contextBytes,sizeof(State)) || !add(value.liveBlocks,state->blocks) ||
           !add(value.liveContexts,1)) { value.valid=false;return value; }
    }
    if(value.overlapBytes>value.ownedRawBytes) { value.valid=false;return value; }
    value.unionBytes=value.ownedRawBytes-value.overlapBytes;
    if(!add(value.unionBytes,value.scenePayloadBytes) || !validSnapshot(value)) value.valid=false;
    return value;
}
bool query(Snapshot &output,std::uint64_t &sequence) noexcept {
    if(issuedSequence>=maxQuerySequence) return false;
    const auto value=snapshot();
    if(!value.valid) return false;
    output=value;sequence=++issuedSequence;return true;
}
std::size_t headerBytes() noexcept { return sizeof(Header); }
std::size_t contextBytes() noexcept { return sizeof(State); }

#ifdef SV_ALLOCATION_CENSUS_CONTRACTS
void setObserverForContracts(Observer value) noexcept { observer=value; }
void failBackendAtForContracts(std::size_t ordinal) noexcept { backendAttempts=0;failBackendOrdinal=ordinal; }
#endif
#undef SV_CENSUS_EVENT
} // namespace sv_allocation

namespace {
void *ordinaryNew(std::size_t bytes,std::size_t alignment) {
    if(void *pointer=sv_allocation::allocate(bytes,alignment)) return pointer;
    throw std::bad_alloc{};
}
}
void *operator new(std::size_t bytes) { return ordinaryNew(bytes,alignof(std::max_align_t)); }
void *operator new[](std::size_t bytes) { return ordinaryNew(bytes,alignof(std::max_align_t)); }
void *operator new(std::size_t bytes,std::align_val_t alignment) { return ordinaryNew(bytes,std::size_t(alignment)); }
void *operator new[](std::size_t bytes,std::align_val_t alignment) { return ordinaryNew(bytes,std::size_t(alignment)); }
void *operator new(std::size_t bytes,const std::nothrow_t &) noexcept { return sv_allocation::allocate(bytes,alignof(std::max_align_t)); }
void *operator new[](std::size_t bytes,const std::nothrow_t &) noexcept { return sv_allocation::allocate(bytes,alignof(std::max_align_t)); }
void *operator new(std::size_t bytes,std::align_val_t alignment,const std::nothrow_t &) noexcept { return sv_allocation::allocate(bytes,std::size_t(alignment)); }
void *operator new[](std::size_t bytes,std::align_val_t alignment,const std::nothrow_t &) noexcept { return sv_allocation::allocate(bytes,std::size_t(alignment)); }
void operator delete(void *pointer) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer) noexcept { sv_allocation::release(pointer); }
void operator delete(void *pointer,std::size_t) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer,std::size_t) noexcept { sv_allocation::release(pointer); }
void operator delete(void *pointer,std::align_val_t) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer,std::align_val_t) noexcept { sv_allocation::release(pointer); }
void operator delete(void *pointer,std::size_t,std::align_val_t) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer,std::size_t,std::align_val_t) noexcept { sv_allocation::release(pointer); }
void operator delete(void *pointer,const std::nothrow_t &) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer,const std::nothrow_t &) noexcept { sv_allocation::release(pointer); }
void operator delete(void *pointer,std::align_val_t,const std::nothrow_t &) noexcept { sv_allocation::release(pointer); }
void operator delete[](void *pointer,std::align_val_t,const std::nothrow_t &) noexcept { sv_allocation::release(pointer); }
