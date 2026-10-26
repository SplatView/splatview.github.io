# Changelog

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
