#include "image_decode_contracts.hpp"
#include "document.hpp"
#include "file_io.hpp"
#include "image_io.hpp"
#include <algorithm>
#include <array>
#include <cstring>
#include <fstream>
#include <future>
#include <limits>
#include <stdexcept>
#include <type_traits>

namespace preview {
struct ImageDecodeTestAccess {
    static void checkpoint(void (*function)(void *,const char *),void *context) {
        DecodedImage::setCheckpoint(function,context);
    }
};
} // namespace preview

namespace {
using namespace preview;
constexpr std::size_t allowance = 64 * 1024 * 1024;
void require(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
template<class Error = std::exception, class F> void rejects(F &&action, const char *message) {
    try { action(); } catch (const Error &) { return; }
    throw std::runtime_error(message);
}
std::size_t category(const ResourceBudget &budget, ResourceCategory kind) {
    return budget.usage().categoryBytes[std::size_t(kind)];
}
ResourceBudget capped(ResourceCategory kind, std::size_t bytes) {
    ResourceLimits limits{allowance}; limits.categoryBytes[std::size_t(kind)] = bytes;
    return ResourceBudget(limits);
}
void write(const std::filesystem::path &path, const std::vector<uint8_t> &bytes) {
    std::ofstream file(path, std::ios::binary | std::ios::trunc);
    file.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
    require(bool(file), "Image fixture write succeeds");
}
void put(std::vector<uint8_t> &bytes, std::size_t offset, uint32_t value, unsigned count = 4) {
    for (unsigned i = 0; i < count; ++i) bytes.at(offset+i) = uint8_t(value >> (8*i));
}
Image fixture(unsigned width = 256, unsigned height = 128) {
    Image image{width, height, AdmittedVector<uint8_t>(std::size_t(width)*height*4)};
    for (unsigned y = 0; y < height; ++y) for (unsigned x = 0; x < width; ++x) {
        const auto pixel = (std::size_t(y)*width+x)*4;
        image.bgra[pixel] = uint8_t(x*3+y);
        image.bgra[pixel+1] = uint8_t(y*7+x);
        image.bgra[pixel+2] = uint8_t(x+y*5);
        image.bgra[pixel+3] = 255;
    }
    return image;
}
// Independent uncompressed bottom-up 24-bit BMP; full decoder output is the
// sole large Work allocation, enabling exact Source+Work+Image peak checks.
std::vector<uint8_t> bmp(const Image &image) {
    const auto stride = (std::size_t(image.width)*3+3) & ~std::size_t(3);
    std::vector<uint8_t> bytes(54+stride*image.height);
    bytes[0]='B'; bytes[1]='M'; put(bytes,2,uint32_t(bytes.size())); put(bytes,10,54);
    put(bytes,14,40); put(bytes,18,image.width); put(bytes,22,image.height);
    put(bytes,26,1,2); put(bytes,28,24,2);
    for (unsigned y=0; y<image.height; ++y) for (unsigned x=0; x<image.width; ++x)
        std::copy_n(image.bgra.data()+(std::size_t(y)*image.width+x)*4,3,
                    bytes.data()+54+std::size_t(image.height-1-y)*stride+x*3);
    return bytes;
}
bool same(const Image &left, const Image &right) {
    return left.width==right.width && left.height==right.height && left.bgra==right.bgra;
}
void ownerAndPeak(const std::filesystem::path &folder) {
    const auto image=fixture(); const auto encoded=bmp(image); const auto path=folder/"rows.bmp";
    write(path,encoded); const auto mtime=std::filesystem::last_write_time(path);
    const auto full=imagePayloadBytes(image.width,image.height);
    ResourceBudget budget(encoded.size()+full+4);
    {
        auto decoded=readImage(path,ImageReadOptions{1,{},budget});
        require(decoded.image().width==1 && decoded.image().height==1 && decoded.image().bgra.size()==4,
                "Tiny requested output retains the requested bounded extent");
#ifndef __APPLE__
        require(std::equal(decoded.image().bgra.begin(),decoded.image().bgra.end(),image.bgra.begin(),image.bgra.begin()+4),
                "Portable nearest sampling preserves the top-left pixel and BGRA channels");
        require(budget.usage().peakBytes==encoded.size()+full+4,
                "Even a one-pixel request charges full decoded Work overlapping Source and final Image");
#endif
        require(budget.usage().totalBytes==4 && category(budget,ResourceCategory::Image)==4 &&
                    category(budget,ResourceCategory::Source)==0 && category(budget,ResourceCategory::Work)==0 &&
                    decoded.admittedImageBytes()==4,
                "Only returned pixels remain charged after source/decoder storage is freed");
        auto moved=std::move(decoded);
        require(moved.image().bgra.size()==4 && budget.usage().totalBytes==4,
                "Moving the returned owner retains its grant exactly once");
        {
            Image copied=moved.image();
            require(copied.bgra.data()!=moved.image().bgra.data() &&
                        sceneMemorySharesLedger(copied.bgra.get_allocator().memory(),budget) &&
                        budget.usage().totalBytes==moved.admittedImageBytes()+copied.bgra.capacity(),
                    "A deep Image copy inherits the pixel policy and admits a distinct actual allocation");
            copied.bgra[0]^=255;
            require(copied.bgra[0]!=moved.image().bgra[0],"Admitted copies must not mutate borrowed decoded pixels");
        }
        require(budget.usage().totalBytes==4,"Destroying a deep Image copy releases only its own grant");
    }
    require(budget.usage().totalBytes==0,"Returned image owners release all grants");
    ResourceBudget twoOwners(encoded.size()+full+8);
    {
        auto first=readImage(path,ImageReadOptions{1,{},twoOwners});
        auto second=readImage(path,ImageReadOptions{1,{},twoOwners});
        first=std::move(second);
        require(twoOwners.usage().totalBytes==8,"Move assignment keeps both physical images charged until destruction");
    }
    require(twoOwners.usage().totalBytes==0,"Overwritten and replacement images release their matching grants");
    ResourceBudget left(allowance),right(allowance);
    {
        auto first=readImage(path,ImageReadOptions{1,{},left});
        auto second=readImage(path,ImageReadOptions{1,{},right});
        first=std::move(second);
        require(sceneMemorySharesLedger(first.image().bgra.get_allocator().memory(),right) &&
                    sceneMemorySharesLedger(second.image().bgra.get_allocator().memory(),left) &&
                    left.usage().totalBytes==4 && right.usage().totalBytes==4,
                "Decode wrapper move assignment preserves both physical allocations and their original independent ledgers");
    }
    require(left.usage().totalBytes==0 && right.usage().totalBytes==0,
            "Cross-ledger decode wrapper destruction releases each actual pixel allocation exactly once");
    for (const auto &[kind,limit] : {std::pair{ResourceCategory::Source,encoded.size()-1},
                                   std::pair{ResourceCategory::Work,full-1},
                                   std::pair{ResourceCategory::Image,std::size_t(3)}}) {
        auto denied=capped(kind,limit);
        rejects<ResourceBudgetExceeded>([&] { readImage(path,ImageReadOptions{1,{},denied}); },
                                        "Each source/decode/output category can deny before its allocation");
        require(denied.usage().totalBytes==0,"Every decode denial releases source, scratch and output grants");
    }
    ResourceBudget tight(encoded.size()+full+3);
    rejects<ResourceBudgetExceeded>([&] { readImage(path,ImageReadOptions{1,{},tight}); },
                                    "Total limit includes simultaneous source/full decode/output even with sampling");
    require(tight.usage().totalBytes==0 && FileSnapshot(path,allowance).bytes().size()==encoded.size() &&
                std::filesystem::last_write_time(path)==mtime,
            "Failed requests preserve source identity/mtime and release admission");
    ResourceBudget retained(allowance);
    std::optional<DecodedImage> escaped;
    {
        ResourceBudget temporary=retained;
        escaped.emplace(readImage(path,ImageReadOptions{16,{},temporary}));
    }
    require(retained.usage().totalBytes==escaped->image().bgra.capacity(),
            "Returned pixels retain the ledger beyond the caller's policy handle");
    escaped.reset(); require(retained.usage().totalBytes==0,"Escaped output grants eventually release");
}
void imageAndThumbnailOwnership(const std::filesystem::path &folder) {
    const auto path=folder/"rows.bmp";
    require(!readImage(path,1).bgra.get_allocator().memory(),"The historical image reader retains its unbudgeted policy");
    auto single=capped(ResourceCategory::Image,4);
    {
        auto decoded=readImage(path,ImageReadOptions{1,{},single});
        const auto *pixels=decoded.image().bgra.data();
        const auto first=decoded.image().bgra[0];
        for (bool thumbnail: {false,true}) {
            bool denied=false;
            try {
                if (thumbnail) { auto copy=squareThumbnail(decoded.image()); }
                else { Image copy=decoded.image(); }
            } catch (const ResourceBudgetExceeded &error) {
                denied=error.requestedBytes()==4 && error.availableBytes()==0;
            }
            require(denied && single.usage().totalBytes==4 && decoded.image().bgra.data()==pixels &&
                        decoded.image().bgra[0]==first,
                    "Deep copy and inherited thumbnail admission must fail before allocating and preserve the original pixels");
        }
    }
    require(single.usage().totalBytes==0,"Denied image copies cannot retain grants after the source owner dies");
    ResourceBudget inherited(allowance);
    std::optional<Image> escaped;
    {
        auto decoded=readImage(path,ImageReadOptions{1,{},inherited});
        escaped.emplace(squareThumbnail(decoded.image()));
        require(same(*escaped,decoded.image()) && escaped->bgra.data()!=decoded.image().bgra.data() &&
                    sceneMemorySharesLedger(escaped->bgra.get_allocator().memory(),inherited) &&
                    inherited.usage().totalBytes==decoded.image().bgra.capacity()+escaped->bgra.capacity(),
                "The default thumbnail inherits the source Image policy and charges both physical owners during overlap");
    }
    require(inherited.usage().totalBytes==escaped->bgra.capacity(),
            "An independent thumbnail retains its grant after the decode wrapper is destroyed");
    Image moved=std::move(*escaped);
    require(inherited.usage().totalBytes==moved.bgra.capacity(),"Moving an Image retains its actual pixel grant without copying");
    escaped->bgra.resize(4);
    require(sceneMemorySharesLedger(escaped->bgra.get_allocator().memory(),inherited) &&
                inherited.usage().totalBytes==moved.bgra.capacity()+escaped->bgra.capacity(),
            "Reusing moved-from Image storage must retain its original admission policy");
    escaped.reset(); moved.bgra=AdmittedVector<uint8_t>{};
    require(inherited.usage().totalBytes==0,"Final Image vector destruction releases every actual allocation grant");

    ResourceBudget target(allowance);
    const auto untracked=fixture(7,5);
    const auto plain=squareThumbnail(untracked,3);
    {
        auto tracked=squareThumbnail(untracked,3,sceneMemoryForBudget(target,ResourceCategory::Image));
        require(same(tracked,plain) && sceneMemorySharesLedger(tracked.bgra.get_allocator().memory(),target) &&
                    target.usage().totalBytes==tracked.bgra.capacity() && !untracked.bgra.get_allocator().memory(),
                "An explicit thumbnail service admits only the new output and preserves unbudgeted input compatibility");
    }
    require(target.usage().totalBytes==0,"Explicit thumbnail policy grants release with the real output allocation");
    auto zero=capped(ResourceCategory::Image,0);
    rejects<ResourceBudgetExceeded>([&] {
        squareThumbnail(untracked,3,sceneMemoryForBudget(zero,ResourceCategory::Image));
    },"An explicit zero thumbnail policy rejects before output allocation");
    require(zero.usage().totalBytes==0 && !plain.bgra.get_allocator().memory(),
            "Explicit rejection releases admission while unbudgeted thumbnail compatibility remains available");
}
void codecFailuresAndEquivalence(const std::filesystem::path &folder) {
    const auto image=fixture(97,53);
    for (const char *name : {"alpha.png","gradient.jpg"}) {
        const auto path=folder/name;
        auto pixels=image;
        if (path.extension()==".png") {
            for (std::size_t i=0; i<pixels.bgra.size(); i+=4) pixels.bgra[i+3]=uint8_t(i/4);
            writePng(pixels,path);
        } else writeJpeg95(pixels,path);
        const auto original=FileSnapshot(path,allowance); const auto stamp=std::filesystem::last_write_time(path);
#ifndef __APPLE__
        if (path.extension()==".png") {
            require(same(readImage(path),pixels),
                    "Independent PNG source pixels preserve BGRA orientation and straight/hidden alpha colors");
            const auto sampled=readImage(path,17);
            require(sampled.width==17 && sampled.height==9,"Independent nearest resize extent rounds down");
            for (unsigned y=0; y<sampled.height; ++y) for (unsigned x=0; x<sampled.width; ++x) {
                const auto from=(std::size_t(y)*97/17*pixels.width+std::size_t(x)*97/17)*4;
                const auto to=(std::size_t(y)*sampled.width+x)*4;
                require(std::equal(pixels.bgra.begin()+from,pixels.bgra.begin()+from+4,sampled.bgra.begin()+to),
                        "Independent integer source coordinates preserve the existing nearest resize samples");
            }
        }
#endif
        for (unsigned edge : {0u,1u,17u,4096u,std::numeric_limits<unsigned>::max()}) {
            ResourceBudget budget(allowance);
            {
                const auto admitted=readImage(path,ImageReadOptions{edge,{},budget});
                require(same(admitted.image(),readImage(path,edge)),
                        "Compatibility and admitted routes preserve existing decode/resize/alpha pixels");
                require(admitted.admittedImageBytes()==admitted.image().bgra.capacity() &&
                            budget.usage().totalBytes==admitted.admittedImageBytes(),
                        "PNG/JPEG leave only returned output charged");
            }
            require(budget.usage().totalBytes==0,"PNG/JPEG returned storage releases all grants");
        }
        // Sweep denials through header, compressed-input growth, inflate, row,
        // conversion and codec workspace allocations. Scope drainage also
        // protects pinned stb error paths that abandon an earlier allocation.
        unsigned failed=0,passed=0;
        for (std::size_t limit : {0u,1u,1024u,8192u,16384u,24576u,32768u,49152u,65536u,131072u,262144u}) {
            auto budget=capped(ResourceCategory::Work,limit);
            try { auto decoded=readImage(path,ImageReadOptions{17,{},budget}); ++passed; }
            catch (const ResourceBudgetExceeded &) { ++failed; }
            require(budget.usage().totalBytes==0,"Codec capacity denials and successes release every temporary allocation");
        }
        require(failed>0 && passed>0,"Codec denial sweep covers both failing and passing allowance levels");
        // stb intentionally permits some incomplete JPEG entropy streams; a
        // missing JPEG header is a deterministic malformed-input oracle.
        const auto prefix=path.extension()==".jpg" ? std::size_t(4) : original.bytes().size()/2;
        std::vector<uint8_t> truncated(original.bytes().begin(),original.bytes().begin()+prefix);
        const auto bad=folder/(std::string(name)+".truncated"); write(bad,truncated);
        ResourceBudget malformed(allowance);
        rejects([&] { readImage(bad,ImageReadOptions{8,{},malformed}); },"Malformed PNG data and truncated JPEG headers reject without pixels");
        require(malformed.usage().totalBytes==0 && std::filesystem::last_write_time(path)==stamp,
                "Corrupt decoding rolls back without touching the original image");
        const FileSnapshot after(path,allowance);
        require(std::equal(original.bytes().begin(),original.bytes().end(),after.bytes().begin(),after.bytes().end()),
                "All image decoding preserves source bytes");
    }
#ifndef __APPLE__
    // 16-bit grayscale -> 16-bit RGBA -> 8-bit RGBA. Deny only the last
    // conversion: earlier 10*N overlap fits, final 12*N does not. The pinned
    // stb conversion path drops its old pointer on failure; the scope owns it.
    const unsigned width=256,height=128; const auto count=std::size_t(width)*height;
    const auto header="P5\n"+std::to_string(width)+" "+std::to_string(height)+"\n65535\n";
    std::vector<uint8_t> gray(header.begin(),header.end()); gray.resize(gray.size()+count*2,127);
    const auto grayPath=folder/"gray16.pgm"; write(grayPath,gray);
    auto denied=capped(ResourceCategory::Work,count*10);
    bool converted=false;
    try { readImage(grayPath,ImageReadOptions{1,{},denied}); }
    catch (const ResourceBudgetExceeded &error) {
        converted=error.requestedBytes()==count*4 && error.availableBytes()==count*2;
    }
    require(converted && denied.usage().peakBytes==gray.size()+count*10 && denied.usage().totalBytes==0,
            "Exact 16-to-8 conversion denial frees its abandoned earlier buffer and every grant");
    ResourceBudget admitted(allowance);
    { const auto decoded=readImage(grayPath,ImageReadOptions{1,{},admitted});
      require(decoded.image().bgra.size()==4,"16-bit compatibility decode still succeeds with adequate capacity"); }
    require(admitted.usage().totalBytes==0,"16-bit successful decode releases every intermediate");
#endif
}
void malformedAndStop(const std::filesystem::path &folder) {
    const auto path=folder/"dimensions.bmp"; auto bytes=bmp(fixture(2,2));
    for (const auto &[width,height] : {std::pair{uint32_t(0),uint32_t(1)},
                                    std::pair{uint32_t(65'000'000),uint32_t(1)},
                                    std::pair{uint32_t(0x7fffffff),uint32_t(0x7fffffff)}}) {
        put(bytes,18,width); put(bytes,22,height); write(path,bytes);
        ResourceBudget budget(allowance);
        rejects([&] { readImage(path,ImageReadOptions{1,{},budget}); },
                "Invalid/overflowing/full-resolution dimensions reject despite tiny requested output");
        require(budget.usage().totalBytes==0,"Dimension preflight releases encoded data and metadata scratch");
    }
    std::stop_source stop; stop.request_stop(); ResourceBudget cancelled(0);
    bool sawCancellation=false;
    try { readImage(folder/"rows.bmp",ImageReadOptions{1,stop.get_token(),cancelled}); }
    catch (const ResourceBudgetExceeded &) {
        throw std::runtime_error("Pre-cancelled image reached admission before observing stop");
    } catch (const std::runtime_error &error) {
        sawCancellation=std::string_view(error.what()).find("cancel")!=std::string_view::npos;
    }
    require(sawCancellation,"Pre-cancelled valid image reports cancellation before filesystem/decode admission");
    require(cancelled.usage().peakBytes==0,"Pre-cancelled image work admits no storage");
    struct StopAtStage {
        std::string_view stage;
        std::stop_source stop;
        const ResourceBudget &budget;
        bool reached{};
        explicit StopAtStage(std::string_view at,const ResourceBudget &policy) : stage(at),budget(policy) {
            ImageDecodeTestAccess::checkpoint([](void *context,const char *stage) {
                auto &self=*static_cast<StopAtStage *>(context);
                if (self.stage!=stage) return;
                require(category(self.budget,ResourceCategory::Source)>0 &&
                            category(self.budget,ResourceCategory::Work)>0 &&
                            (self.stage!="pixels.ready" || category(self.budget,ResourceCategory::Image)>0),
                        "Stage cancellation observes live source/decoder/output storage before cleanup");
                self.reached=true; self.stop.request_stop();
            },this);
        }
        ~StopAtStage() { ImageDecodeTestAccess::checkpoint(nullptr,nullptr); }
    };
    for (const char *stage : {"decode.ready","pixels.ready"}) {
        ResourceBudget budget(allowance);
        StopAtStage injection(stage,budget);
        bool stopped=false;
        try { readImage(folder/"rows.bmp",ImageReadOptions{17,injection.stop.get_token(),budget}); }
        catch (const std::runtime_error &error) {
            stopped=std::string_view(error.what()).find("cancel")!=std::string_view::npos;
        }
        require(injection.reached && stopped && budget.usage().totalBytes==0,
                "Stop after opaque decode or output allocation rejects publication and releases all owners");
    }
}
void processingPolicy(const std::filesystem::path &directory, const std::filesystem::path &folder) {
    const auto path=folder/"reference.png"; writePng(fixture(31,19),path);
    const FileSnapshot source(directory/"demo.ply",allowance);
    const FileSnapshot reference(path,allowance);
    const auto sourceTime=std::filesystem::last_write_time(directory/"demo.ply");
    const auto referenceTime=std::filesystem::last_write_time(path);
    const auto plain=std::make_shared<Scene>(loadScene(source.bytes()));
    const auto count=plain->gaussians.size();
    require(count>=2,"Image policy fixture needs two splats for a real redo entry");
    // Fixture decode now has its own bounds Work phase. Admit that measured
    // phase and all prior processing owners, then target image-owned Work.
    // Use real reserve capacities rather than a container growth formula.
    ResourceBudget boundsPolicy(allowance);
    auto boundsProbe=*plain;
    fitBounds(boundsProbe,sceneMemoryForBudget(boundsPolicy,ResourceCategory::Work));
    const auto boundsPeak=boundsPolicy.usage().peakBytes;
    require(boundsPolicy.usage().totalBytes==0 && boundsPeak>0,"Bounds probe releases every actual scratch grant");
    SceneVector<uint8_t> maskProbe(count,uint8_t{});
    SceneVector<std::array<float,3>> rgbProbe; rgbProbe.reserve(count);
    SceneVector<float> columnProbe; columnProbe.reserve(count);
    const auto prefix=checkedByteSum({maskProbe.capacity()*sizeof(uint8_t),
        rgbProbe.capacity()*sizeof(std::array<float,3>),4*columnProbe.capacity()*sizeof(float)});
    const auto workCap=std::max(boundsPeak,prefix);
    const auto imageBytes=imagePayloadBytes(31,19);
    require(workCap<imageBytes,"Image Work fixture must admit prior phases while denying full reference decode");
    struct Stages {
        bool decoded{},pixels{};
        Stages() {
            ImageDecodeTestAccess::checkpoint([](void *context,const char *stage) {
                auto &self=*static_cast<Stages *>(context);
                if(std::string_view(stage)=="decode.ready") self.decoded=true;
                if(std::string_view(stage)=="pixels.ready") self.pixels=true;
            },this);
        }
        ~Stages() { ImageDecodeTestAccess::checkpoint(nullptr,nullptr); }
    };
    for (auto kind : {ResourceCategory::Source,ResourceCategory::Work,ResourceCategory::Image}) {
        auto budget=capped(kind,kind==ResourceCategory::Work ? workCap : 0);
        {
            LoadOptions options; options.resources=budget;
            auto scene=std::make_shared<Scene>(loadScene(source.bytes(),options));
            Document document; document.replace(directory/"demo.ply",scene,budget);
            require(document.edits()->selectSingle(0,SelectOperation::Set) &&
                        document.edits()->selectSingle(1,SelectOperation::Add) && document.undo(),
                    "Image policy fixture retains a real undo/redo history");
            document.edits()->beginSelectionDraft();
            const auto issued=document.maskSnapshot();
            const auto *baseline=document.edits()->selectionBaseline().data();
            const auto before=document.savePoint(); const auto revision=document.revision();
            const auto retained=budget.usage().totalBytes;
            for (const char *type : {"match","learn"}) {
                const Recipe recipe{{"type",type},{"values",{{"path",pathUtf8(path)}}}};
                const auto job=document.captureProcessing(recipe);
                Stages stages;
                bool rejected=false;
                try { (void)job.run(); }
                catch(const ResourceBudgetExceeded &error) {
                    rejected=true;
                    if(kind==ResourceCategory::Source)
                        require(error.requestedBytes()==reference.bytes().size() && error.availableBytes()==0,
                                "Source denial must identify the exact encoded image capture");
                    else if(kind==ResourceCategory::Image)
                        require(error.requestedBytes()==imageBytes && error.availableBytes()==0 && stages.decoded,
                                "Image denial must follow successful decode and identify the returned reference pixels");
                    else
                        require(error.requestedBytes()>workCap && error.availableBytes()<=workCap,
                                "Work denial must identify an image-owned request beyond all admitted processing/bounds prefixes");
                }
                require(rejected && !stages.pixels && stages.decoded==(kind==ResourceCategory::Image),
                        "Each captured image policy rejects at its intended source/decoder/output phase");
                require(document.scene()==scene && document.savePoint()==before && document.revision()==revision &&
                            !document.dirty() && document.current(job) && document.states().data()==issued.data() &&
                            document.edits()->selectionBaseline().data()==baseline && document.edits()->selectionDraft() &&
                            document.edits()->canUndo() && document.edits()->canRedo() && document.edits()->selectedCount()==1 &&
                            document.states()[0]==1 && document.states()[1]==0 &&
                            std::memcmp(scene->gaussians.data(),plain->gaussians.data(),count*sizeof(Gaussian))==0 &&
                            budget.usage().totalBytes==retained,
                        "Image-reference rejection preserves source, issued mask, draft baseline, real history and document identities");
            }
            document.edits()->cancelSelectionDraft();
            require(document.redo() && document.states()[0]==1 && document.states()[1]==1,
                    "The original redo remains executable after both failed image-reference requests");
        }
        require(budget.usage().totalBytes==0,"Image policy fixture/history destruction releases every retained grant");
    }
    const FileSnapshot sourceAfter(directory/"demo.ply",allowance),referenceAfter(path,allowance);
    require(std::equal(source.bytes().begin(),source.bytes().end(),sourceAfter.bytes().begin(),sourceAfter.bytes().end()) &&
                std::equal(reference.bytes().begin(),reference.bytes().end(),referenceAfter.bytes().begin(),referenceAfter.bytes().end()) &&
                std::filesystem::last_write_time(directory/"demo.ply")==sourceTime &&
                std::filesystem::last_write_time(path)==referenceTime,
            "Image-reference policy failures preserve both source files and modification times");
    ResourceBudget budget(allowance); LoadOptions options; options.resources=budget;
    auto scene=std::make_shared<Scene>(loadScene(source.bytes(),options));
    Document document; document.replace(directory/"demo.ply",scene,budget);
    const std::vector<uint8_t> states(scene->gaussians.size(),1);
    for (const char *type : {"match","learn"}) {
        Recipe recipe{{"type",type},{"values",{{"path",pathUtf8(path)}}}};
        if (std::string_view(type)=="learn") recipe["values"]["iterations"]=8;
        auto expected=processScene(plain,states,recipe,true);
        auto actual=processScene(scene,states,recipe,true,{}, {},budget);
        require(expected.states==actual.states && expected.report==actual.report &&
                    expected.scene->gaussians.size()==actual.scene->gaussians.size() &&
                    std::memcmp(expected.scene->gaussians.data(),actual.scene->gaussians.data(),
                                actual.scene->gaussians.size()*sizeof(Gaussian))==0 &&
                    std::find(actual.inputs.begin(),actual.inputs.end(),path)!=actual.inputs.end(),
                "Budgeted selected-only matching/learning preserves numerical output and image alias provenance");
    }
    std::vector<std::future<void>> jobs;
    for (unsigned i=0; i<4; ++i) jobs.push_back(std::async(std::launch::async,[&,i] {
        ResourceBudget own(allowance);
        for (unsigned repeat=0; repeat<8; ++repeat) {
            if (i%2) {
                auto denied=capped(ResourceCategory::Work,1);
                rejects<ResourceBudgetExceeded>([&] { readImage(path,ImageReadOptions{16,{},denied}); },
                                                "Concurrent failed decoder uses its own thread-local policy");
                require(denied.usage().totalBytes==0,"Concurrent denial releases its own ledger");
            } else {
                auto decoded=readImage(path,ImageReadOptions{16,{},own});
                require(decoded.image().width==16 && own.usage().totalBytes==decoded.image().bgra.capacity(),
                        "Concurrent successful decoder is isolated from another request's failure/context");
            }
        }
        require(own.usage().totalBytes==0,"Concurrent success releases all owned images");
    }));
    for (auto &job : jobs) job.get();
}
} // namespace
void imageDecodeContracts(const std::filesystem::path &directory) {
    static_assert(!std::is_copy_constructible_v<preview::DecodedImage>);
    static_assert(std::is_nothrow_move_constructible_v<preview::DecodedImage>);
    static_assert(std::is_nothrow_move_assignable_v<preview::DecodedImage>);
    static_assert(std::is_aggregate_v<preview::Image>);
    const auto folder=directory/"image-decode"; std::filesystem::create_directories(folder);
    ownerAndPeak(folder); imageAndThumbnailOwnership(folder); codecFailuresAndEquivalence(folder); malformedAndStop(folder);
    processingPolicy(directory,folder);
}
