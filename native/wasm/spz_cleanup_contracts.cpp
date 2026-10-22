// Main-only contracts for the generated SPZ cleanup adapter. Four target-only
// linker wrappers delegate to real zlib and observe its actual raw C storage.
// No wrapper, allocator hook or failure entry point is exported or shipped.
#include "allocation_census.hpp"
#include <load-spz.h>
#include <zlib.h>
#include <algorithm>
#include <array>
#include <bit>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>
#include <vector>

extern "C" {
int __real_inflateInit2_(z_streamp,int,const char *,int);
int __real_deflateInit2_(z_streamp,int,int,int,int,int,const char *,int);
int __real_inflateEnd(z_streamp);
int __real_deflateEnd(z_streamp);
}

namespace {
using Bytes=std::vector<std::uint8_t>;
std::size_t cases{},assertions{},reserveRefusals{},insertRefusals{},beforeInitRefusals{},ordinaryCodecRefusals{},initRefusals{};
std::size_t totalInitializations{},totalEnds{},totalRawAllocations{},totalRawFrees{},totalRawFailures{},totalInitCleanupEnds{};
void require(bool condition,const char *message) {
    ++assertions;if(!condition) throw std::runtime_error(message);
}
template<class Action> void test(Action action) { action();++cases; }

struct Stream {
    z_streamp pointer{};
    bool inflating{},initializing{},initialized{},ended{};
    alloc_func previousAllocate{};
    free_func previousFree{};
    voidpf previousOpaque{};
};
struct RawBlock { void *pointer{};std::size_t bytes{};Stream *owner{}; };
struct Run {
    bool active{};
    const char *error{};
    std::array<Stream,8> streams{};
    std::array<RawBlock,64> blocks{};
    std::size_t initCalls{},initialized{},endCalls{},activeStreams{},initCleanupEnds{};
    std::size_t rawAttempts{},rawAllocations{},rawFrees{},rawFailures{},liveBytes{},liveBlocks{},peakBytes{},failRawAt{};
    bool cppFailure{};
    std::size_t refusedRequest{},failureActiveStreams{},failureLiveBytes{};
};
Run run;
void observeFailure(const char *message) noexcept { if(!run.error) run.error=message; }
void observeCpp(const sv_allocation::Event &event) noexcept {
    if(run.active && event.kind==sv_allocation::EventKind::BackendFailure) {
        if(run.cppFailure) observeFailure("More than one C++ backend refusal in a one-shot test");
        run.cppFailure=true;run.refusedRequest=event.requested;
        run.failureActiveStreams=run.activeStreams;run.failureLiveBytes=run.liveBytes;
    }
}
voidpf trackedAllocate(voidpf opaque,uInt count,uInt size) noexcept {
    auto *owner=static_cast<Stream *>(opaque);++run.rawAttempts;
    if(run.failRawAt && run.rawAttempts==run.failRawAt) { ++run.rawFailures;return nullptr; }
    const auto bytes=std::uint64_t(count)*size;
    if(!owner || !owner->pointer || bytes>std::numeric_limits<std::size_t>::max()) {
        observeFailure("Zlib requested an invalid observed raw block");return nullptr;
    }
    void *pointer=std::calloc(count,size);
    if(!pointer) { ++run.rawFailures;return nullptr; }
    for(auto &block:run.blocks) if(!block.pointer) {
        block={pointer,std::size_t(bytes),owner};++run.rawAllocations;++run.liveBlocks;run.liveBytes+=block.bytes;
        run.peakBytes=std::max(run.peakBytes,run.liveBytes);return pointer;
    }
    observeFailure("Fixed zlib block ledger exhausted");std::free(pointer);return nullptr;
}
void trackedFree(voidpf opaque,voidpf pointer) noexcept {
    if(!pointer) return;
    for(auto &block:run.blocks) if(block.pointer==pointer) {
        if(block.owner!=opaque) observeFailure("Zlib freed storage through a different stream owner");
        ++run.rawFrees;--run.liveBlocks;run.liveBytes-=block.bytes;
        block={};std::free(pointer);return;
    }
    observeFailure("Zlib freed a raw block absent from the independent ledger");std::free(pointer);
}
Stream *beginStream(z_streamp stream,bool inflating) noexcept {
    ++run.initCalls;
    for(auto &owner:run.streams) if(!owner.pointer) {
        owner.pointer=stream;owner.inflating=inflating;owner.initializing=true;
        owner.previousAllocate=stream->zalloc;owner.previousFree=stream->zfree;owner.previousOpaque=stream->opaque;
        if(stream->zalloc || stream->zfree || stream->opaque) observeFailure("Observed SPZ helper supplied an unexpected zlib allocator");
        stream->zalloc=trackedAllocate;stream->zfree=trackedFree;stream->opaque=&owner;return &owner;
    }
    observeFailure("Fixed zlib stream ledger exhausted");return nullptr;
}
void finishInit(Stream *owner,int result) noexcept {
    if(!owner) return;
    owner->initializing=false;
    if(result==Z_OK) { owner->initialized=true;++run.initialized;++run.activeStreams; }
    else {
        for(const auto &block:run.blocks) if(block.pointer && block.owner==owner)
            observeFailure("Failed zlib initialization retained a partial raw allocation");
        owner->pointer->zalloc=owner->previousAllocate;owner->pointer->zfree=owner->previousFree;
        owner->pointer->opaque=owner->previousOpaque;
    }
}
bool initializationCleanup(z_streamp stream,bool inflating) noexcept {
    for(const auto &owner:run.streams) if(owner.pointer==stream && owner.initializing) {
        if(owner.inflating!=inflating || owner.initialized) observeFailure("Invalid internal zlib initialization cleanup");
        ++run.initCleanupEnds;return true;
    }
    return false;
}
Stream *endStream(z_streamp stream,bool inflating) noexcept {
    for(auto &owner:run.streams) if(owner.pointer==stream) {
        if(owner.inflating!=inflating || !owner.initialized || owner.ended)
            observeFailure("Zlib End did not match one successful initialization");
        owner.ended=true;++run.endCalls;--run.activeStreams;return &owner;
    }
    observeFailure("Observed zlib End has no initialized stream");return nullptr;
}
void finishEnd(Stream *owner,int result) noexcept {
    if(!owner) return;
    // deflateEnd reports Z_DATA_ERROR for an unfinished stream, after freeing
    // its state. Cleanup must still occur; the pinned callers ignore that code.
    if(result!=Z_OK && !(result==Z_DATA_ERROR && !owner->inflating))
        observeFailure("Actual zlib End returned an unexpected cleanup status");
    for(const auto &block:run.blocks) if(block.pointer && block.owner==owner)
        observeFailure("Actual zlib End retained a stream raw block");
    if(owner->pointer->state) observeFailure("Actual zlib End retained its internal state pointer");
    owner->pointer->zalloc=owner->previousAllocate;owner->pointer->zfree=owner->previousFree;
    owner->pointer->opaque=owner->previousOpaque;
}
void start(std::size_t failCppAt=0,std::size_t failRawAt=0) {
    require(!run.active && !run.liveBlocks && !run.liveBytes,"Previous observed stream was not cleaned before a new operation");
    run={};run.active=true;run.failRawAt=failRawAt;sv_allocation::failBackendAtForContracts(failCppAt);
}
void stop() noexcept { run.active=false;sv_allocation::failBackendAtForContracts(0); }
void cleaned(std::size_t initialized,std::size_t attempted=1) {
    require(!run.error,run.error ? run.error : "Zlib observer error");
    require(run.initCalls==attempted && run.initialized==initialized && run.endCalls==initialized && !run.activeStreams,
            "End count differs from successful actual zlib initialization count");
    require(!run.liveBlocks && !run.liveBytes && run.rawAllocations==run.rawFrees,
            "Stream exit leaked actual zlib raw allocations");
    for(const auto &block:run.blocks) require(!block.pointer,"Independent raw block ledger is not empty after cleanup");
    totalInitializations+=run.initialized;totalEnds+=run.endCalls;
    totalRawAllocations+=run.rawAllocations;totalRawFrees+=run.rawFrees;totalRawFailures+=run.rawFailures;
    totalInitCleanupEnds+=run.initCleanupEnds;
}

struct DirectEnd {
    z_stream *stream;bool inflating;
    ~DirectEnd() noexcept { if(inflating) inflateEnd(stream);else deflateEnd(stream); }
};
Bytes directGzip(const Bytes &raw) {
    z_stream stream{};
    require(deflateInit2(&stream,Z_BEST_SPEED,Z_DEFLATED,16+MAX_WBITS,8,Z_DEFAULT_STRATEGY)==Z_OK,
            "Independent gzip fixture initialization failed");
    DirectEnd cleanup{&stream,false};
    Bytes result(deflateBound(&stream,uLong(raw.size())));
    stream.next_in=const_cast<Bytef *>(raw.data());stream.avail_in=uInt(raw.size());
    stream.next_out=result.data();stream.avail_out=uInt(result.size());
    require(deflate(&stream,Z_FINISH)==Z_STREAM_END,"Independent gzip fixture did not finish");
    result.resize(stream.total_out);return result;
}
std::uint32_t little32(const std::uint8_t *bytes) noexcept {
    return std::uint32_t(bytes[0])|(std::uint32_t(bytes[1])<<8)|(std::uint32_t(bytes[2])<<16)|(std::uint32_t(bytes[3])<<24);
}
void independentGzipOracle(const Bytes &encoded,const Bytes &expected) {
    require(!run.active && encoded.size()>=18 && encoded[0]==0x1f && encoded[1]==0x8b && encoded[2]==8,
            "Actual compressed output is not a gzip/deflate stream");
    require(little32(encoded.data()+encoded.size()-8)==crc32(0,expected.data(),uInt(expected.size())) &&
            little32(encoded.data()+encoded.size()-4)==expected.size(),"Gzip trailer CRC/ISIZE differs from independent raw input");
    z_stream stream{};
    require(inflateInit2(&stream,16+MAX_WBITS)==Z_OK,"Independent gzip oracle initialization failed");
    DirectEnd cleanup{&stream,true};Bytes decoded(expected.size()+1);
    stream.next_in=const_cast<Bytef *>(encoded.data());stream.avail_in=uInt(encoded.size());
    stream.next_out=decoded.data();stream.avail_out=uInt(decoded.size());
    require(inflate(&stream,Z_FINISH)==Z_STREAM_END && stream.total_out==expected.size() && stream.avail_in==0,
            "Direct zlib oracle did not completely consume the actual gzip output");
    decoded.resize(stream.total_out);require(decoded==expected,"Actual gzip payload differs from independent literal bytes");
}
void append32(Bytes &bytes,std::uint32_t value) {
    for(unsigned shift=0;shift<32;shift+=8) bytes.push_back(std::uint8_t(value>>shift));
}
struct Legacy {
    unsigned version{},count{};
    std::array<Bytes,5> fields;
    Bytes raw;
};
Legacy legacy(unsigned version,unsigned count) {
    // Independent legacy framing/attribute literals follow the existing SPZ
    // admission fixtures. No production SPZ encoder creates these input bytes.
    Legacy result{version,count,{},{}};
    for(unsigned i=0;i<count;++i) {
        for(const std::int32_t fixed:{i%2 ? 1024 : 512,1024,-2048})
            for(unsigned shift=0;shift<24;shift+=8) result.fields[0].push_back(std::uint8_t(std::uint32_t(fixed)>>shift));
        result.fields[1].push_back(128);result.fields[2].insert(result.fields[2].end(),3,128);
        result.fields[3].insert(result.fields[3].end(),3,160);
        if(version==2) result.fields[4].insert(result.fields[4].end(),3,128);
        else result.fields[4].insert(result.fields[4].end(),{0,0,0,0xc0});
    }
    append32(result.raw,0x5053474e);append32(result.raw,version);append32(result.raw,count);
    result.raw.insert(result.raw.end(),{0,12,0,0});
    for(const auto &field:result.fields) result.raw.insert(result.raw.end(),field.begin(),field.end());
    return result;
}
void matchesLegacy(const spz::PackedGaussians &actual,const Legacy &expected) {
    require(actual.version==expected.version && actual.numPoints==int(expected.count) && actual.shDegree==0 &&
            actual.fractionalBits==12 && !actual.antialiased && actual.usesQuaternionSmallestThree==(expected.version>=3),
            "Actual legacy SPZ decode metadata differs from independent framing");
    require(actual.positions==expected.fields[0] && actual.alphas==expected.fields[1] && actual.colors==expected.fields[2] &&
            actual.scales==expected.fields[3] && actual.rotations==expected.fields[4] && actual.sh.empty(),
            "Actual legacy SPZ decode differs from complete independent packed attribute bytes");
}
Bytes randomBytes() {
    Bytes result(65536);std::uint32_t state=0xa341316c;
    for(auto &value:result) { state^=state<<13;state^=state>>17;state^=state<<5;value=std::uint8_t(state); }
    return result;
}

void successAndCompatibility() {
    test([] {
        const Bytes raw{'1','2','3','4','5','6','7','8','9'};Bytes encoded;
        require(crc32(0,raw.data(),uInt(raw.size()))==0xcbf43926,"Independent CRC reference literal differs");
        start();const auto success=spz::compressGzipped(raw.data(),raw.size(),&encoded);stop();
        require(success && run.peakBytes>0,"Actual SPZ gzip compression did not own observed zlib storage");
        cleaned(1);independentGzipOracle(encoded,raw);
    });
    test([] {
        const auto raw=randomBytes();Bytes encoded;
        start();const auto success=spz::compressGzipped(raw.data(),raw.size(),&encoded);stop();
        require(success && encoded.size()>raw.size()/4 && encoded.size()>8192,"Incompressible gzip fixture did not cross vector growth boundaries");
        cleaned(1);independentGzipOracle(encoded,raw);
    });
    for(const unsigned version:{2u,3u}) test([=] {
        const auto expected=legacy(version,2);const auto encoded=directGzip(expected.raw);
        start();const auto decoded=spz::loadSpzPacked(encoded);stop();cleaned(1);matchesLegacy(decoded,expected);
        spz::UnpackOptions options;options.to=spz::CoordinateSystem::RUB;
        start();const auto cloud=spz::loadSpz(encoded,options);stop();cleaned(1);
        require(cloud.numPoints==2 && cloud.positions==std::vector<float>({.125f,.25f,-.5f,.25f,.25f,-.5f}),
                "Actual SPZ Gaussian decode differs from independent exact fixed-point positions");
    });
    for(const unsigned version:{2u,3u}) test([=] {
        spz::GaussianCloud cloud;cloud.numPoints=2;cloud.shDegree=0;
        cloud.positions={.125f,.25f,-.5f,.25f,.25f,-.5f};cloud.scales=std::vector<float>(6,0);
        cloud.rotations={0,0,0,1,0,0,0,1};cloud.alphas={0,0};cloud.colors=std::vector<float>(6,0);
        spz::PackOptions options;options.version=version;options.from=spz::CoordinateSystem::RUB;Bytes encoded;
        start();const auto success=spz::saveSpz(cloud,options,&encoded);stop();
        require(success,"Actual legacy SPZ export failed");cleaned(1);
        independentGzipOracle(encoded,legacy(version,2).raw);
    });
}

void throwingVectors() {
    const auto raw=randomBytes();const auto packed=legacy(3,2048);const auto compressed=directGzip(packed.raw);
    require(compressed.size()*3<8192 && packed.raw.size()>8192,
            "Independent compressible SPZ fixture cannot force decompression insert growth");
    for(const unsigned ordinal:{1u,2u,3u}) {
        test([&] {
            Bytes output;bool refused{};start(ordinal);
            try { spz::compressGzipped(raw.data(),raw.size(),&output); }
            catch(const std::bad_alloc &) { refused=true; }
            stop();require(refused && run.cppFailure,"Actual compression vector allocation did not refuse");
            if(ordinal==1) {
                require(run.refusedRequest==8192 && !run.failureActiveStreams && !run.failureLiveBytes && output.empty(),
                        "Scratch-vector refusal happened after an unexpected zlib initialization");
                cleaned(0,0);++beforeInitRefusals;
            } else {
                require(run.failureActiveStreams==1 && run.failureLiveBytes>0,
                        "Compression refusal did not occur while real initialized zlib raw storage was live");
                cleaned(1);
                if(ordinal==2) {
                    require(run.refusedRequest==raw.size()/4 && output.empty(),"Compression refusal missed actual output reserve");++reserveRefusals;
                } else {
                    require(run.refusedRequest>raw.size()/4 && !output.empty(),"Compression refusal missed growth insert after earlier chunks");++insertRefusals;
                }
            }
            start();require(spz::compressGzipped(raw.data(),raw.size(),&output),"Compression failed after one-shot refusal cleanup");
            stop();cleaned(1);independentGzipOracle(output,raw);
        });
        test([&] {
            bool refused{};start(ordinal);
            try { spz::loadSpzPacked(compressed); }
            catch(const std::bad_alloc &) { refused=true; }
            stop();require(refused && run.cppFailure,"Actual legacy decode vector allocation did not refuse");
            if(ordinal==1) {
                require(run.refusedRequest==8192 && !run.failureActiveStreams && !run.failureLiveBytes,
                        "Decode scratch-vector refusal happened after an unexpected zlib initialization");
                cleaned(0,0);++beforeInitRefusals;
            } else {
                require(run.failureActiveStreams==1 && run.failureLiveBytes>0,
                        "Decode refusal did not occur while real initialized zlib raw storage was live");cleaned(1);
                if(ordinal==2) {
                    require(run.refusedRequest==compressed.size()*3,"Decode refusal missed actual output reserve");++reserveRefusals;
                } else {
                    require(run.refusedRequest>=8192 && run.refusedRequest>compressed.size()*3,
                            "Decode refusal missed first growth insert");++insertRefusals;
                }
            }
            start();const auto recovered=spz::loadSpzPacked(compressed);stop();cleaned(1);matchesLegacy(recovered,packed);
        });
    }
}

void codecFailures() {
    test([] {
        Bytes output{7,11,13};start();
        const auto success=spz::compressGzipped(nullptr,17,&output);stop();
        require(!success && output.empty() && run.peakBytes>0,"Actual deflate invalid-input error changed pinned clear/false behavior");
        cleaned(1);++ordinaryCodecRefusals;
    });
    const auto expected=legacy(3,2048);const auto valid=directGzip(expected.raw);
    for(const bool truncate:{false,true}) test([&] {
        auto damaged=valid;
        if(truncate) damaged.resize(damaged.size()-6);
        else damaged[damaged.size()-8]^=0x80; // A real gzip CRC mismatch.
        start();const auto decoded=spz::loadSpzPacked(damaged);stop();
        require(decoded.numPoints==0 && run.peakBytes>0,"Actual gzip error did not refuse the corrupted independent fixture");
        cleaned(1);++ordinaryCodecRefusals;
    });
    test([] {
        const Bytes raw(64,3);Bytes output{7,11,13};start(0,3);
        const auto success=spz::compressGzipped(raw.data(),raw.size(),&output);stop();
        require(!success && output==Bytes({7,11,13}) && run.rawFailures==1 && run.rawAllocations>0,
                "Partial deflate initialization failure changed output or missed the actual allocator boundary");
        cleaned(0);++initRefusals;
    });
    test([&] {
        start(0,1);const auto decoded=spz::loadSpzPacked(valid);stop();
        require(decoded.numPoints==0 && run.rawFailures==1 && !run.rawAllocations,
                "Inflate initialization refusal created storage or returned a decoded fixture");cleaned(0);++initRefusals;
    });
    test([&] {
        for(unsigned i=0;i<8;++i) {
            bool refused{};start(3);
            try { spz::loadSpzPacked(valid); } catch(const std::bad_alloc &) { refused=true; }
            stop();require(refused && run.cppFailure && run.failureActiveStreams==1 && run.failureLiveBytes>0,
                    "Repeated insert refusal did not exercise initialized actual zlib state");cleaned(1);
            start();const auto recovered=spz::loadSpzPacked(valid);stop();cleaned(1);matchesLegacy(recovered,expected);
        }
    });
}
static_assert(sizeof(std::size_t)==4 && std::endian::native==std::endian::little);
}

extern "C" {
int __wrap_inflateInit2_(z_streamp stream,int window,const char *version,int size) {
    if(!run.active) return __real_inflateInit2_(stream,window,version,size);
    auto *owner=beginStream(stream,true);const auto result=__real_inflateInit2_(stream,window,version,size);
    finishInit(owner,result);return result;
}
int __wrap_deflateInit2_(z_streamp stream,int level,int method,int window,int memory,int strategy,const char *version,int size) {
    if(!run.active) return __real_deflateInit2_(stream,level,method,window,memory,strategy,version,size);
    auto *owner=beginStream(stream,false);const auto result=__real_deflateInit2_(stream,level,method,window,memory,strategy,version,size);
    finishInit(owner,result);return result;
}
int __wrap_inflateEnd(z_streamp stream) {
    if(!run.active) return __real_inflateEnd(stream);
    if(initializationCleanup(stream,true)) return __real_inflateEnd(stream);
    auto *owner=endStream(stream,true);const auto result=__real_inflateEnd(stream);finishEnd(owner,result);return result;
}
int __wrap_deflateEnd(z_streamp stream) {
    if(!run.active) return __real_deflateEnd(stream);
    if(initializationCleanup(stream,false)) return __real_deflateEnd(stream);
    auto *owner=endStream(stream,false);const auto result=__real_deflateEnd(stream);finishEnd(owner,result);return result;
}
}

int main() {
    try {
        sv_allocation::setObserverForContracts(observeCpp);
        successAndCompatibility();throwingVectors();codecFailures();
        require(totalInitializations==totalEnds && totalRawAllocations==totalRawFrees,
                "Actual zlib lifetime totals do not close after every tested path");
        std::printf("SPLATVIEW_SPZ_CLEANUP_CONTRACTS_PASS cases=%zu assertions=%zu reserveRefusals=%zu insertRefusals=%zu beforeInitRefusals=%zu ordinaryCodecRefusals=%zu initRefusals=%zu initialized=%zu ended=%zu rawAllocations=%zu rawFrees=%zu rawFailures=%zu initCleanupEnds=%zu\n",
            cases,assertions,reserveRefusals,insertRefusals,beforeInitRefusals,ordinaryCodecRefusals,initRefusals,
            totalInitializations,totalEnds,totalRawAllocations,totalRawFrees,totalRawFailures,totalInitCleanupEnds);
        return 0;
    } catch(const std::exception &error) {
        stop();std::fprintf(stderr,"SPLATVIEW_SPZ_CLEANUP_CONTRACTS_FAIL %s\n",error.what());return 1;
    } catch(...) {
        stop();std::fprintf(stderr,"SPLATVIEW_SPZ_CLEANUP_CONTRACTS_FAIL nonstandard exception\n");return 1;
    }
}
