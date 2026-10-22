#pragma once
#include "editing.hpp"

namespace preview {
enum class SceneExportFormat { Ply, Spz, Splat, CompressedPly, Ksplat, Csv, Sog, Sogs };
// Export only loaded, undeleted splats. SPZ v3 retains quantized SH0..3;
// compressed PLY quantizes attributes and SH; KSPLAT v0.1 mode 0 uses byte DC
// colors/opacity and float geometry/higher SH; SPLAT stores byte DC colors only.
// CSV uses PLY/RDF columns. All writes preserve an existing file on failure.
// SOG v2 / legacy SOGS v1 bundle lossless WebPs of quantized attributes and
// a bounded SH palette; compression uses the CPU without a GPU/runtime helper.
void writeVisibleScene(const Scene &, std::span<const uint8_t> states, const std::filesystem::path &,
                       SceneExportFormat, std::stop_token stop = {});
} // namespace preview
