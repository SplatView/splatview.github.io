#include "document.hpp"
#include "software_renderer.hpp"
#include "file_io.hpp"
#include "file_preferences.hpp"
#include "image_io.hpp"
#include "atomic_file.hpp"
#include <charconv>
#include <csignal>
#include <fstream>
#include <iostream>

namespace {
using namespace preview;
volatile std::sig_atomic_t interrupted=0;
void interrupt(int) { interrupted=1; }
void writeText(const std::filesystem::path &path,const std::string &text) {
    AtomicFile file(path); std::ofstream out(file.path(),std::ios::binary); out << text; out.close();
    if(!out) throw std::runtime_error("Cannot write output"); file.commit();
}
void help() {
    std::cout << "SplatView portable tools 0.1.0\n"
        "  splatview-cli --inspect scene [--output metadata.json]\n"
        "  splatview-cli --process scene --recipe pipeline.json --output edited.ply\n"
        "  splatview-cli --thumbnail scene --output image.png [--size 512] [--software] [--view camera.json]\n"
        "  splatview-cli --demo output.ply\n"
        "All thumbnail pixels are rendered on the CPU; no graphics API is required.\n"
        "Export: .ply .compressed.ply .spz .splat .ksplat .sog .sogs .csv\n";
}
Recipe inspect(const Scene &scene) {
    Recipe details{{"format",scene.format},{"radius",scene.radius},{"editable",scene.isGaussian()},
        {"center",{scene.center.x,scene.center.y,scene.center.z}}, {"sourceBytes",scene.sourceBytes}};
    if(scene.isGaussian()) { details["sourceSplats"]=scene.sourceCount; details["previewSplats"]=scene.gaussians.size(); details["shDegree"]=scene.shDegree; }
    else { details["sourceVertices"]=scene.sourceCount; details["previewVertices"]=scene.vertices.size(); details["sourceFaces"]=scene.sourceFaces;
        details["previewTriangles"]=scene.triangles.size(); details["sampled"]=scene.sampledGeometry; }
    return details;
}
int run(const std::vector<std::string> &args) {
    if(args.empty() || args[0]=="--help" || args[0]=="-h") { help(); return 0; }
    if(args[0]=="--version") { std::cout << "SplatViewMac 0.1.0 (SplatView 0.12.58 core)\n"; return 0; }
    if(args.size()<2) throw std::runtime_error("A scene path is required");
    const auto command=args[0];
    if(command!="--inspect" && command!="--process" && command!="--thumbnail" && command!="--demo") throw std::runtime_error("Unknown command; use --help");
    const auto source=pathFromUtf8(args[1]);
    if(command=="--demo") {
        if(args.size()!=2) throw std::runtime_error("Use --demo followed by one output path");
        if(std::filesystem::exists(source)) throw std::runtime_error("Demo output already exists");
        Scene scene; scene.yUp=true; scene.shDegree=3;
        for(int z=0;z<5;++z) for(int y=0;y<18;++y) for(int x=0;x<24;++x) {
            Attributes a; a.position={(x-11.5f)*.055f,(y-8.5f)*.055f,(z-2)*.08f}; a.scale={.03f,.025f,.02f}; a.opacity=.65f;
            a.sh[0]=(float(x)/23-.5f)/.2820947918f; a.sh[1]=(float(y)/17-.5f)/.2820947918f; a.sh[2]=(.75f-.5f)/.2820947918f;
            scene.gaussians.push_back(packGaussian(a));
        }
        fitBounds(scene); writeVisibleScene(scene,{},source,exportFormatForPath(source));
        std::cout << Recipe{{"output",pathUtf8(source)},{"splats",scene.gaussians.size()}}.dump() << '\n'; return 0;
    }
    std::filesystem::path output,recipePath,viewPath;
    unsigned size=512; bool software=false;
    for(size_t i=2;i<args.size();++i) {
        const auto &option=args[i];
        if(option=="--software" && command=="--thumbnail" && !software) { software=true; continue; }
        if(i+1>=args.size()) throw std::runtime_error("Missing option value");
        const auto &value=args[++i];
        if(option=="--output" && output.empty()) output=pathFromUtf8(value);
        else if(option=="--recipe" && command=="--process" && recipePath.empty()) recipePath=pathFromUtf8(value);
        else if(option=="--view" && command=="--thumbnail" && viewPath.empty()) viewPath=pathFromUtf8(value);
        else if(option=="--size" && command=="--thumbnail") {
            auto [end,ec]=std::from_chars(value.data(),value.data()+value.size(),size);
            if(ec!=std::errc{} || end!=value.data()+value.size() || !size || size>2048) throw std::runtime_error("Size must be 1 through 2048");
        } else throw std::runtime_error("Unknown or repeated command line option");
    }
    if(command!="--inspect" && output.empty()) throw std::runtime_error("--output is required");
    if(command=="--process" && recipePath.empty()) throw std::runtime_error("--recipe is required");
    std::stop_source cancellation;
    ResourceBudget resources(4ull*1024*1024*1024);
    std::vector<std::filesystem::path> inputs{source};
    if(!recipePath.empty()) inputs.push_back(recipePath);
    if(!viewPath.empty()) inputs.push_back(viewPath);
    if(!output.empty()) rejectOutputAliases(output,inputs,cancellation.get_token(),resources);
    std::signal(SIGINT,interrupt);
    std::jthread watcher([&](std::stop_token stop) {
        while(!stop.stop_requested()) { if(interrupted) { cancellation.request_stop(); return; } std::this_thread::sleep_for(std::chrono::milliseconds(25)); }
    });
    LoadOptions options; options.stop=cancellation.get_token(); options.resources=resources;
    if(command=="--thumbnail") options.maxSplats=thumbnailSplatBudget(size);
    auto loaded=loadSceneWithSources(source,options);
    auto scene=std::make_shared<Scene>(std::move(loaded.scene));
    inputs.insert(inputs.end(),loaded.sourceMembers.begin(),loaded.sourceMembers.end());
    if(command=="--inspect") {
        const auto text=inspect(*scene).dump(2)+"\n"; if(!output.empty()) writeText(output,text); std::cout << text;
    } else if(command=="--process") {
        const std::vector<uint8_t> states(scene->gaussians.size());
        auto result=processScene(scene,states,readRecipe(recipePath),false,cancellation.get_token(),{},resources);
        inputs.insert(inputs.end(),result.inputs.begin(),result.inputs.end()); rejectOutputAliases(output,inputs,cancellation.get_token(),resources);
        writeVisibleScene(*result.scene,result.states,output,exportFormatForPath(output),cancellation.get_token());
        std::cout << Recipe{{"message",result.message},{"output",pathUtf8(output)},{"loaded",result.scene->loadedCount()},
            {"source",result.scene->sourceCount},{"report",result.report}}.dump() << '\n';
    } else {
        Camera camera; camera.fit(*scene);
        if(!viewPath.empty()) { FileSnapshot view(viewPath,65536,cancellation.get_token(),resources); const auto bytes=view.bytes(); camera.restoreView(decodeSavedView({reinterpret_cast<const char *>(bytes.data()),bytes.size()})); }
        SoftwareRenderer renderer({sceneMemoryForBudget(resources,ResourceCategory::Render),
                                   sceneMemoryForBudget(resources,ResourceCategory::Work),
                                   sceneMemoryForBudget(resources,ResourceCategory::Image)});
        renderer.setScene(scene); renderer.resize(size,size); ViewSettings settings; settings.highlightSelection=false;
        renderer.draw(camera,settings,cancellation.get_token());
        const auto extension=pathUtf8(output.extension());
        if(extension==".png" || extension==".PNG") writePng(renderer.readback(),output);
        else if(extension==".jpg" || extension==".jpeg" || extension==".JPG" || extension==".JPEG") writeJpeg95(renderer.readback(),output);
        else throw std::runtime_error("Thumbnail output must use .png, .jpg or .jpeg");
        std::cout << Recipe{{"output",pathUtf8(output)},{"width",size},{"height",size},{"renderer","software"}}.dump() << '\n';
    }
    return 0;
}
int entry(const std::vector<std::string> &args) {
    try { return run(args); }
    catch(const std::exception &e) { std::cerr << "SplatView: " << e.what() << '\n'; return interrupted?130:1; }
}
} // namespace
#ifdef _WIN32
int wmain(int argc,wchar_t **argv) {
    try { std::vector<std::string> args; for(int i=1;i<argc;++i) args.push_back(preview::narrow(argv[i])); return entry(args); }
    catch(const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}
#else
int main(int argc,char **argv) { return entry({argv+1,argv+argc}); }
#endif
