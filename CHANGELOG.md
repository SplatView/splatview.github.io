# Changelog

## 0.2.1 — October 26, 2026

- Reduce loading delay by overlapping GPU upload completion with saved-view and
  recovery preparation. Publish only after both finish; preserve the old scene
  through cancellation and failure.
- Prepare optional SteadySplats shaders while General settings opens, without
  allocating its full frame buffers or changing the active rendering mode.
- Compile WebGPU Steady pipelines asynchronously and independent startup
  pipelines concurrently. Share the same preparation API with standalone hosts.
- Preserve rendering quality/defaults, exact picks/maps/captures, native history,
  source verification, memory budgets and automatic WebGL2 fallback.

Local benchmark medians improved WebGL loading from 971 to 691 ms and the first
WebGPU mode selection from 109 to 31 ms after opening Settings. First WebGL
SteadySplats activation remains about 420 ms. Measurements cover the documented
Windows Chromium/NVIDIA workload and do not measure physical presentation FPS.

## 0.2.0 — October 25, 2026

- Add integrated WebGL2 rendering and automatic startup fallback when WebGPU
  initialization is unavailable, with exact picks/maps/captures and Basic editing.
- Add optional SteadySplats on both backends with sorted fallback when its
  framebuffer features or resource admission are unavailable.
- Provide a standalone browser renderer with typed WebGPU/WebGL2 APIs, workers,
  resource admission and a plain-browser example.
- Improve exact WebGL worker sorting with bounded synchronous kernels, stable
  counting and uniform-digit skipping. Preserve stable source IDs and exact
  query/output behavior.
- Use 24-bit display sorting during camera motion with exact 32-bit refinement
  at rest. The standalone module defaults to 32-bit precision. Add optional
  large-scene WebGPU visible-draw compaction and two bounded display submissions.
- Simplify Settings around the Windows General / Privacy / Help structure.
  Align property rows, collapse optional SteadySplats tuning, hide Gaussian
  controls for geometry, and place application updates/graphics diagnostics in Help.
- Retain browser-local saved views, source protection, native history, worker
  identity checks and the existing web-lite product scope.

Measured performance and browser qualification are documented in the source
tree's feature reviews and validation records. Local GPU results cover Windows
Chromium/NVIDIA; other OS/browser/GPU and native preview-host qualification remain
separate. Frame/fence timings do not measure physical presentation FPS.

## 0.1.0 — October 22, 2026

Initial published web-lite application with verified native assets, frozen
source checkout support, browser-local saved views and offline application use.
