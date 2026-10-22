#include "browser_sog_export.hpp"
#include "allocation_census.hpp"
#include "resource_budget.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <new>
#include <stdexcept>

namespace preview::browser_sog {
namespace {
thread_local Operation *operation{};
thread_local TextureMemory *texture{};
thread_local bool metadataAuthority{};
thread_local Statistics last{};
constexpr std::size_t kib=1024,mib=1024*kib;
std::size_t tiles(std::size_t width,std::size_t height) {
    return checkedByteProduct((width+63)/64,(height+63)/64);
}
std::size_t webpOutput(std::size_t width,std::size_t height) {
    // Frozen lossless preset1 is method1/quality20/exact1/thread_level0.
    // GetHistoBits starts at >=6 (palette >=8); ClampBits can reduce it
    // only when the entire histogram image remains one cell. Predictor and
    // color-transform images use >=6, with the same one-cell exception.
    // Literal/copy tokens need <=8 bytes per source pixel (15-bit Huffman
    // codes plus length/distance extras). Five tree alphabets contain at most
    // 3136 entries; <=2 bytes per header token fits 8192 bytes per group.
    // 16 bytes/pixel + 32768 bytes/tile +128KiB covers those groups, all
    // auxiliary no-Huffman images/palette and RIFF/padding, conservatively.
    return checkedByteSum({checkedByteProduct(checkedByteProduct(width,height),16),
        checkedByteProduct(tiles(width,height),32768),128*kib});
}
} // namespace
Bounds bounds(std::size_t count,unsigned degree) {
    if(!count||count>1'000'000||degree>3)throw std::invalid_argument("Unsupported admitted SOG count/degree");
    const auto rest=(degree+1)*(degree+1)-1;
    const auto side=(static_cast<std::size_t>(std::ceil(std::sqrt(double(count))))+3)&~std::size_t{3};
    const auto base=checkedByteProduct(side,side), paletteCount=std::min<std::size_t>(count,65536);
    const std::size_t paletteWidth=64*rest,paletteHeight=(paletteCount+63)/64;
    const auto palettePixels=checkedByteProduct(paletteWidth,paletteHeight);
    const auto maxPixels=std::max(base,palettePixels);
    const auto maxTiles=std::max(tiles(side,side),rest?tiles(paletteWidth,paletteHeight):0);
    Bounds result;
    result.output=checkedByteSum({checkedByteProduct(rest?6:5,webpOutput(side,side)),
        rest?webpOutput(paletteWidth,paletteHeight):0,256*kib});
    result.pixels=checkedByteProduct(maxPixels,4);
    result.palette=rest?checkedByteProduct(paletteCount,12*rest):0;
    result.labels=rest?checkedByteProduct(count,2):0;
    // Sum, rather than alias, Range buckets, growth overlap in codebook
    // samples/distances, Archive entries and complete JSON DOM/dump payloads.
    result.scratch=2*mib;
    // Enforced admission policy allowance, not a theorem that every possible
    // WebP image completes. It includes ARGB import, hash/ref lists, transforms,
    // histogram sets, bit-writer resize/clone overlap and aligned block headers.
    // Actual callback cap/refusal is authoritative; contracts record high water.
    result.codec=checkedByteSum({16*mib,checkedByteProduct(maxPixels,256),checkedByteProduct(maxTiles,65536)});
    return result;
}
Statistics lastStatistics() noexcept { return last; }
Operation::Operation(std::size_t codecLimit):limit(codecLimit) {
    if(operation||!browser_export::directActive())throw std::runtime_error("Invalid nested SOG export operation");
    operation=this;
}
Operation::~Operation() noexcept { last=statistics;operation=nullptr; }
TextureMemory::TextureMemory():memory_(browser_export::scratchMemory()) {
    if(texture)throw std::runtime_error("Nested SOG property encoder");
    if(memory_&&!operation)throw std::runtime_error("SOG encoder lost its admitted operation");
    limit_=operation?operation->limit:0;texture=this;if(operation)++operation->statistics.textures;
}
TextureMemory::TextureMemory(std::shared_ptr<SceneMemory> memory,std::size_t codecLimit)
    :memory_(std::move(memory)),limit_(codecLimit) {
    if(texture||!memory_)throw std::runtime_error("Invalid SOG codec memory owner");texture=this;
}
TextureMemory::~TextureMemory() noexcept {
    // Every property picture/encoder must retire before this lexical owner.
    if(live_)std::abort();texture=nullptr;
}
void TextureMemory::rethrowFailure() const { if(failure_)std::rethrow_exception(failure_); }
void *allocateWebp(std::uint64_t count,std::size_t stride,bool zero) noexcept {
    if(!texture||!texture->memory_) {
        if(count&&stride>std::numeric_limits<std::size_t>::max()/count)return nullptr;
        return zero?std::calloc(static_cast<std::size_t>(count),stride):std::malloc(static_cast<std::size_t>(count)*stride);
    }
    auto &self=*texture;if(self.failure_)return nullptr;
    try {
        if(count>std::numeric_limits<std::size_t>::max())throw std::bad_array_new_length();
        const auto payload=checkedByteProduct(static_cast<std::size_t>(count),stride);
        const auto bytes=checkedByteSum({sizeof(TextureMemory::Header),payload});
        if(bytes>self.limit_-self.live_)throw std::runtime_error("SOG WebP exceeds its admitted codec allowance");
        // The in-band grant/size/owner header is part of the charged payload.
        // No allocation-index map or second realloc owner is hidden off-ledger.
        auto grant=self.memory_->admit(bytes);sv_allocation::PayloadTag tag(bytes);
        auto *raw=::operator new(bytes);
        auto *header=::new(raw) TextureMemory::Header{&self,bytes,std::move(grant)};
        self.live_+=bytes;
        if(operation){++operation->statistics.codecAllocations;operation->statistics.peakCodecBytes=std::max(operation->statistics.peakCodecBytes,self.live_);}
        auto *data=reinterpret_cast<std::byte *>(header+1);if(zero&&payload)std::memset(data,0,payload);return data;
    }catch(...){if(operation)++operation->statistics.codecRefusals;self.failure_=std::current_exception();return nullptr;}
}
void freeWebp(void *address) noexcept {
    if(!address)return;
    if(!texture||!texture->memory_){std::free(address);return;}
    auto *header=static_cast<TextureMemory::Header *>(address)-1;
    if(header->owner!=texture)std::abort();
    const auto bytes=header->bytes;auto grant=std::move(header->grant);std::destroy_at(header);
    ::operator delete(header);texture->live_-=bytes;
}
void noteMetadataAllocation() noexcept { if(operation)++operation->statistics.metadataAllocations; }
void noteMetadataRefusal() noexcept { if(operation)++operation->statistics.metadataRefusals; }
String MetadataOwner::dump() const {
    String result;
    using Adapter=nlohmann::detail::output_string_adapter<char,String>;
    auto adapter=std::allocate_shared<Adapter>(MetadataAllocator<Adapter>{},result);
    nlohmann::detail::serializer<Json> serializer(adapter,' ',nlohmann::detail::error_handler_t::strict);
    serializer.dump(dom_,false,false,0);return result;
}
MetadataOwner::Authority::Authority() noexcept:previous_(metadataAuthority) { metadataAuthority=true; }
MetadataOwner::Authority::~Authority() noexcept { metadataAuthority=previous_; }
bool metadataCleanupActive() noexcept { return metadataAuthority; }
} // namespace preview::browser_sog
bool sv_sog_export_metadata_cleanup_active() noexcept { return preview::browser_sog::metadataCleanupActive(); }
extern "C" void *sv_sog_webp_allocate(std::uint64_t count,std::size_t stride,int zero) noexcept {
    return preview::browser_sog::allocateWebp(count,stride,zero!=0);
}
extern "C" void sv_sog_webp_free(void *address) noexcept { preview::browser_sog::freeWebp(address); }
