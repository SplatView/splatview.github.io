#include "image_output_contracts.hpp"
#include "image_io.hpp"
#include "file_io.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <stdexcept>
#include <string>

using namespace preview;
namespace {
void require(bool value,const char *message) { if(!value) throw std::runtime_error(message); }
template<class F> void rejects(F action,const char *message) {
    try { action(); } catch(const std::exception &) { return; }
    throw std::runtime_error(message);
}
std::vector<uint8_t> bytes(const std::filesystem::path &path) {
    const FileSnapshot file(path,1024*1024);
    return {file.bytes().begin(),file.bytes().end()};
}
std::vector<std::filesystem::path> entries(const std::filesystem::path &folder) {
    std::vector<std::filesystem::path> paths;
    for(const auto &entry:std::filesystem::directory_iterator(folder)) paths.push_back(entry.path().filename());
    std::sort(paths.begin(),paths.end()); return paths;
}
Image fixture() {
    Image image{64,48,AdmittedVector<uint8_t>(64*48*4)};
    for(unsigned y=0;y<image.height;++y) for(unsigned x=0;x<image.width;++x) {
        const auto pixel=(size_t(y)*image.width+x)*4;
        image.bgra[pixel]=uint8_t(20+x*3);
        image.bgra[pixel+1]=uint8_t(25+y*4);
        image.bgra[pixel+2]=uint8_t(30+(x+y)*2);
        image.bgra[pixel+3]=255;
    }
    return image;
}
} // namespace
void imageOutputContracts(const std::filesystem::path &directory) {
    const auto folder=directory/"image-output"; std::filesystem::create_directories(folder);
    const auto image=fixture(); const auto pixels=image.bgra;
    const auto source=folder/"source.png"; writePng(image,source); const auto sourceBytes=bytes(source);
    const auto destination=folder/"capture.jpg";
    { std::ofstream file(destination,std::ios::binary); file<<"existing destination"; }
    const auto preserved=bytes(destination); const auto before=entries(folder);
    std::stop_source stopped; stopped.request_stop();
    rejects([&] { writeJpeg95(image,destination,stopped.get_token()); },"Pre-cancelled JPEG output fails before publication");
    require(bytes(destination)==preserved && entries(folder)==before && image.bgra==pixels,
            "Cancellation preserves destination bytes and input pixels and leaves no temporary file");
    rejects([&] { writeJpeg95(image,source,stopped.get_token()); },"Pre-cancelled JPEG cannot replace a source image");
    require(bytes(source)==sourceBytes,"A cancelled source-path output preserves the source payload");
    const auto absent=folder/"absent-cancelled.jpg";
    std::error_code error; std::filesystem::remove(absent,error);
    rejects([&] { writeJpeg95(image,absent,stopped.get_token()); },"Pre-cancelled JPEG creates no destination");
    require(!std::filesystem::exists(absent),"A cancelled new output stays absent");
    auto invalid=image; invalid.bgra.pop_back();
    rejects([&] { writeJpeg95(invalid,destination); },"Invalid pixels fail encoding without output replacement");
    require(bytes(destination)==preserved && entries(folder)==before,
            "Encoding failure preserves existing destination and leaves no partial output");
    const auto occupied=folder/"occupied.jpg"; std::filesystem::create_directories(occupied);
    const auto beforeCommitFailure=entries(folder);
    rejects([&] { writeJpeg95(image,occupied); },"An output directory cannot be atomically replaced by an image");
    require(std::filesystem::is_directory(occupied) && entries(folder)==beforeCommitFailure,
            "Publication failure removes temporary data and preserves the existing destination directory");
    writeJpeg95(image,destination);
    require(bytes(destination)==jpeg95(image) && image.bgra==pixels,
            "Normal JPEG output retains the existing quality-95 encoder bytes without changing input pixels");
    const auto decoded=readImage(destination);
    require(decoded.width==image.width && decoded.height==image.height,"JPEG roundtrip preserves capture dimensions");
    double totalError=0; unsigned maxError=0;
    for(size_t i=0;i<pixels.size();i+=4) for(unsigned channel=0;channel<3;++channel) {
        const auto difference=unsigned(std::abs(int(pixels[i+channel])-int(decoded.bgra[i+channel])));
        totalError+=difference; maxError=std::max(maxError,difference);
    }
    require(totalError/(image.width*image.height*3)<2.5 && maxError<15,
            "Quality-95 JPEG preserves gradient detail, BGRA channels and row orientation");
    require(bytes(source)==sourceBytes,"Normal image output preserves the separate source image");
}
