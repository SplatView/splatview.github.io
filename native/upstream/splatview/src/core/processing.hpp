#pragma once
#include "model.hpp"
#include "recipe.hpp"
#include <memory>

namespace preview {
// Immutable input/output lets rendering and exports continue while a CPU job runs.
struct ProcessingResult {
    std::shared_ptr<const Scene> scene;
    SceneVector<uint8_t> states; // Independently admitted Work storage for a mutable result.
    std::string message;
    Recipe report;
    std::vector<std::filesystem::path> inputs;
};
struct AlignmentView {
    Matrix4 transform{identityMatrix};
    SavedView defaultView; // The default camera in the aligned coordinates.
};
const Recipe &editingPresets();
Recipe resolveRecipe(const Recipe &);
Matrix4 transformMatrix(const Recipe &values);
// With resources, input vector storage must already belong to that ledger.
// Writable copies inherit it; additional path-based scene loads join it too.
ProcessingResult processScene(std::shared_ptr<const Scene>, std::span<const uint8_t>, const Recipe &,
                              bool selectedOnly = false, std::stop_token = {},
                              const std::optional<AlignmentView> & = {},
                              std::optional<ResourceBudget> = {});
Recipe readRecipe(const std::filesystem::path &);
void writeRecipe(const std::filesystem::path &, const Recipe &);
} // namespace preview
