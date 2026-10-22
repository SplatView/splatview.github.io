#include "model.hpp"
#include "scene_exports.hpp"
#include "file_io.hpp"
#include "file_preferences.hpp"
#include "export_contracts.hpp"
#include "processing_contracts.hpp"
#include "geometry_contracts.hpp"
#include "io_contracts.hpp"
#include "ply_preview_contracts.hpp"
#include "portable_contracts.hpp"
#include "camera_contracts.hpp"
#include "document_job_contracts.hpp"
#include "preview_kernel_contracts.hpp"
#include "document_draft_contracts.hpp"
#include "background_job_contracts.hpp"
#include "frame_capture_contracts.hpp"
#include "document_loader_contracts.hpp"
#include "image_output_contracts.hpp"
#include "resource_budget_contracts.hpp"
#include "preference_job_contracts.hpp"
#include "source_admission_contracts.hpp"
#include "scene_storage_contracts.hpp"
#include "decode_admission_contracts.hpp"
#include "decode_work_contracts.hpp"
#include "side_input_contracts.hpp"
#include "image_decode_contracts.hpp"
#include "document_capture_contracts.hpp"
#include "spz_admission_contracts.hpp"
#include "admitted_storage_contracts.hpp"
#include "history_admission_contracts.hpp"
#include "processing_scratch_contracts.hpp"
#include "selection_work_contracts.hpp"
#include "bounds_work_contracts.hpp"
#include "selection_map_work_contracts.hpp"
#include "preview_coordinator_contracts.hpp"
#include "render_storage_contracts.hpp"
#include "renderer_cache_contracts.hpp"
#include <fstream>
#include <functional>
#include <sstream>
#include <cstring>
#include <iostream>

namespace {
void run(const char *name, const std::function<void()> &test) {
    test(); std::cout << "PASS " << name << '\n';
}
std::vector<uint8_t> ioFixture() {
    std::ostringstream header;
    header << "ply\nformat binary_little_endian 1.0\nelement vertex 1\n";
    for(const char *name:{"opacity","z","x","y","scale_0","scale_1","scale_2","rot_0","rot_1","rot_2","rot_3"})
        header << "property float " << name << '\n';
    for(unsigned c=0;c<3;++c) header << "property float f_dc_" << c << '\n';
    for(unsigned c=0;c<45;++c) header << "property float f_rest_" << c << '\n';
    header << "end_header\n";
    auto text=header.str(); std::vector<uint8_t> out(text.begin(),text.end());
    std::array<float,59> values{}; values[4]=values[5]=values[6]=-3; values[7]=1; values[11]=1;
    const auto size=out.size(); out.resize(size+sizeof(values)); std::memcpy(out.data()+size,values.data(),sizeof(values));
    return out;
}
}
void formatDecodeContracts(const std::filesystem::path &);
void surfaceContracts();
int main(int argc, char **argv) {
    using namespace preview;
    try {
        const auto directory = argc > 1 ? pathFromUtf8(argv[1]) : std::filesystem::temp_directory_path() / "splatview-core-contracts";
        std::filesystem::create_directories(directory);
        setPreferencesRoot(directory / "preferences");
        Scene scene;
        scene.shDegree = 3;
        for (unsigned i = 0; i < 8; ++i) {
            Attributes a;
            a.position = {float(i % 4) * .2f - .3f, float(i / 4) * .2f, float(i % 3) * .1f};
            a.scale = {.04f, .025f, .03f}; a.opacity = .8f;
            a.sh = {}; a.sh[0] = 1; a.sh[1] = -.25f; a.sh[2] = .1f;
            scene.gaussians.push_back(packGaussian(a));
        }
        fitBounds(scene);
        const auto fixture = directory / "demo.ply";
        writeVisiblePly(scene, {}, fixture);
        for (auto [name, format] : {std::pair{"demo.spz", SceneExportFormat::Spz}, {"demo.splat", SceneExportFormat::Splat},
             {"demo.ksplat", SceneExportFormat::Ksplat}, {"demo-compressed.ply", SceneExportFormat::CompressedPly},
             {"demo.sog", SceneExportFormat::Sog}, {"demo-legacy.sogs", SceneExportFormat::Sogs}})
            writeVisibleScene(scene, {}, directory / name, format);
        std::filesystem::copy_file(directory / "demo.sog", directory / "demo.zip", std::filesystem::copy_options::overwrite_existing);
        run("eight export formats", [&] { sceneExportContracts(directory); });
        run("format quantization", [&] { formatQuantizationContracts(directory); });
        run("format extremes", [&] { formatExtremesContracts(directory); });
        run("processing color", [&] { processingColorContracts(directory); });
        run("processing geometry", [&] { processingGeometryContracts(directory); });
        run("processing composition", [&] { processingCompositionContracts(directory); });
        run("processing analysis and image references", [&] { processingAnalysisContracts(directory); });
        run("selection and content history", [&] { processingHistoryContracts(directory); });
        run("calibration and floor alignment", [] { geometryToolsContracts(); });
        run("current-source processing alignment and view history", [&] { processingAlignmentContracts(directory); });
        run("alignment floor and vertical camera geometry", [] { geometryAlignmentContracts(); });
        run("camera roll, transformations and saved-view compatibility", [] { cameraContracts(); });
        run("pure preview kernels match committed processing", [] { previewKernelContracts(); });
        run("regular PLY decode and software rendering", [&] { plyPreviewContracts(directory); });
        run("format decode, SPZ1-4, compression, memory budgets and malformed inputs", [&] { formatDecodeContracts(directory/"decode"); });
        run("portable file, image, preferences and language services", [&] { platformContracts(directory); });
        run("software compositing, picking, depth and selections", [&] { renderContracts(directory); });
        run("surface unprojection and continuous volume brush", [] { surfaceContracts(); });
        run("document history and asynchronous loading", [&] { documentContracts(directory); });
        run("immutable document jobs, saved revisions and alignment history", [&] { documentJobContracts(directory); });
        run("controller-owned absolute color and transient geometry drafts", [&] { documentDraftContracts(directory); });
        run("bounded background execution and cancellation delivery", [] { backgroundJobContracts(); });
        run("immutable clean frame capture and extent admission", [] { frameCaptureContracts(); });
        run("loader lifetime, latest-request coalescing and admission", [] { documentLoaderContracts(); });
        run("cancellable JPEG output publication", [&] { imageOutputContracts(directory); });
        run("byte admission, shared allocation identity and reservation lifetimes", [] { resourceBudgetContracts(); });
        run("source snapshot byte admission and aggregate rollback", [&] { sourceAdmissionContracts(directory); });
        run("allocator-backed scene capacity, copies and lifetime admission", [] { sceneStorageContracts(); });
        run("decoded scene admission through formats, jobs, history and capture", [&] { decodeAdmissionContracts(directory); });
        run("decoder scratch admission, validation and rollback", [&] { decodeWorkContracts(directory); });
        run("captured side-input policies, member manifests and worker export admission", [&] { sideInputContracts(directory); });
        run("immutable background saved-view and thumbnail jobs", [&] { preferenceJobContracts(directory); });
        run("image source, decoder scratch, resize and returned-pixel admission", [&] { imageDecodeContracts(directory); });
        run("document capture allocation failures preserve sessions and issued jobs", [] { documentCaptureContracts(); });
        run("SPZ packed buffers, extension views and conversion admission", [&] { spzAdmissionContracts(directory); });
        run("admitted rebound storage, container growth and allocator lifetime", [] { runAdmittedStorageContracts(); });
        run("immutable masks, admitted history and queued ownership", [] { historyAdmissionContracts(); });
        run("processing sample, histogram, learning and floor scratch admission", [&] { processingScratchContracts(directory); });
        run("selection masks, volume indices and returned stroke admission", [] { selectionWorkContracts(); });
        run("bounds scratch admission and atomic metadata publication", [] { boundsWorkContracts(); });
        run("selection map output, scratch, lifetime and cancellation admission", [] { selectionMapWorkContracts(); });
        run("latest preview coordination, reentry and detached ownership", [] { previewCoordinatorContracts(); });
        run("immutable live preview identity, drafts and allocation lifetime", [] { livePreviewContracts(); });
        run("actual packet allocation ownership, stable sorting and cancellation", [] { renderStorageContracts(); });
        run("actual renderer cache, raster and Image allocation ownership", [] { rendererCacheContracts(); });
        const auto bytes=ioFixture();
        run("parallel sampled decode and endian contracts", [&] { fusedDecodeContracts(bytes, 1); });
        run("streaming gzip contracts", [&] { streamingGzipContracts(bytes, 1, directory); });
        return 0;
    } catch (const std::exception &error) { std::cerr << "FAIL " << error.what() << '\n'; return 1; }
}
