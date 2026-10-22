#include "editing.hpp"
#include "geometry_tools.hpp"
#include "navigation.hpp"
#include "surface_selection.hpp"
#include <cmath>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
template<class F> void rejects(F action) {
    bool rejected = false;
    try { action(); } catch (const std::exception &) { rejected = true; }
    require(rejected, "Invalid domain input must fail");
}
bool close(float a, float b, float tolerance = 1e-5f) {
    return std::abs(a - b) <= tolerance;
}
}
int main() {
    using namespace preview;
    try {
        Attributes attributes;
        attributes.position = {1, 2, 3};
        attributes.scale = {.1f, .2f, .3f};
        attributes.sh[0] = .5f;
        const auto gaussian = packGaussian(attributes);
        require(close(gaussian.covA[0], .01f) && close(gaussian.covA[3], .04f) &&
                close(gaussian.covB[1], .09f), "Analytic diagonal covariance");
        require(close(shValue(gaussian, 0, 0), .5f), "Half-float SH conversion");
        attributes.scale.x = 0;
        rejects([&] { packGaussian(attributes); });
        attributes.scale.x = .1f;
        attributes.sh[1] = std::numeric_limits<float>::infinity();
        rejects([&] { packGaussian(attributes); });

        auto scene = std::make_shared<Scene>();
        scene->gaussians = {gaussian, gaussian};
        scene->gaussians[1].positionOpacity[0] = -1;
        fitBounds(*scene);
        SceneEdits edits(scene);
        const auto clean = edits.contentRevision();
        require(edits.selectSingle(0, SelectOperation::Set), "Single selection");
        require(edits.contentRevision() == clean, "Selection preserves content identity");
        require(edits.deleteSelected() && edits.visibleCount() == 1, "Deletion changes content");
        const auto deleted = edits.contentRevision();
        require(deleted != clean && edits.undo() && edits.contentRevision() == clean,
                "Undo restores previous content identity");
        require(edits.redo() && edits.contentRevision() == deleted, "Redo restores saved identity");
        require(edits.undo(), "Restore before selection draft");
        edits.beginSelectionDraft();
        edits.selectAll();
        require(edits.cancelSelectionDraft() && edits.selectedCount() == 1,
                "Cancel draft restores selection baseline");

        Camera camera;
        camera.fit(*scene);
        camera.roll = .3f;
        Matrix4 translation = identityMatrix;
        translation[12] = 4;
        translation[13] = -2;
        const auto shifted = camera.transformed(translation);
        require(close(shifted.target.x, camera.target.x + 4) &&
                close(shifted.target.y, camera.target.y - 2) && close(shifted.roll, camera.roll),
                "Camera follows translation without losing roll");
        require(camera.savedView().roll == camera.roll, "Saved camera includes roll");

        require(close(pointDistance({0,0,0}, {3,4,0}), 5), "Analytic distance");
        require(close(pointAngle({1,0,0}, {0,0,0}, {0,1,0}), 90), "Analytic angle");
        rejects([] { pointAngle({0,0,0}, {0,0,0}, {1,0,0}); });
        Scene points;
        points.type = SceneType::PointCloud;
        points.vertices = {{{-1,-2,-3}, 0xffffffff}, {{1,2,3}, 0xffffffff}};
        fitBounds(points);
        require(close(points.center.x, 0) && close(points.radius, std::sqrt(14.f)),
                "Ordinary PLY bounds do not require a format decoder");
        std::cout << "PASS standalone domain: packing, history/drafts, camera/alignment, geometry and bounds\n";
        return 0;
    } catch (const std::exception &error) {
        std::cerr << "FAIL " << error.what() << '\n';
        return 1;
    }
}
