# Implementation plan: WebGL2 rendering and SteadySplats

Reviewed plan, October 25, 2026. Implementation is tracked separately in
[the active feature review](webgl2-implementation-2026-10-25.md). This record
does not itself establish product-policy migration or browser qualification.

The goal is a second rendering backend for the existing web app: sorted Gaussian
rendering plus the same opt-in SteadySplats behavior, with Basic editing preserved
when its query contracts are qualified. Rendering and editing are separate
milestones. Keep early WebGL2 integration behind a development/test option; enable
automatic fallback only after the complete declared product surface passes.
WebGL1 and model training are outside this plan.

## Sources, scope and policy

The current checkout is based on `fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2`, with
the preceding WebGPU SteadySplats work uncommitted. Its exact changed-source hashes
are recorded in [that validation record](../../docs/validation/runs/steady-splats-20261025-01/validation.json).
Preserve those edits. Consume the local product bundle 2.0.0 with manifest digest
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
The shared product contract and feature template were read from the development
sibling; builds continue to use the pinned local bundle.

Reference the same reviewed [PlayCanvas PR 9819](https://github.com/playcanvas/engine/pull/9819)
at `12542cf99f2b2b23c7e84c6602f8b5e537e74e73`, still a draft at inspection.
Its `gsplat-steady-webgl-pass.js`, `gsplat-steady-webgl-renderer.js` and GLSL chunks
provide the texture-based reconstruction reference. Preserve the existing MIT
notice and extend [the attribution](../../docs/third-party/STEADY_SPLATS_REFERENCES.md)
when code is ported. SplatView's Gaussian/color conventions remain authoritative.
For consistency decisions, the current local WebGPU implementation is the
behavioral authority. The PlayCanvas WebGL2 code supplies implementation ideas;
its Gaussian encoding and resource layout are not an alternate product contract.

`docs/parity/capabilities-v1.json` currently excludes a separate WebGL compatibility
viewer; the current app requires WebGPU. This plan proposes conditional WebGL2
backend support. Before implementation, amend the capability/review records under
the existing guards, keeping policy, implementation status and qualification
separate. Do not report the proposed support as shipped. `view.render` already
covers web rendering in the pinned bundle; any new backend-choice registrations
need explicit bindings and regenerated local projections. If additional sealed
profile changes are necessary, import a reviewed producer release explicitly.
Do not reseal the consumer copy, relax source locks or rewrite old receipts.

| Target | Intended policy and condition | Existing owner and remaining work |
| --- | --- | --- |
| Windows editor | Existing native rendering remains required; this browser backend does not change native support | `../SplatPreview/src/renderer.hpp`; no D3D11 change or new native evidence |
| macOS editor | Existing native rendering remains required | `../splatview_macos/src/render/render_frame.cpp`; no Metal change or Apple qualification |
| Ubuntu editor | Existing native rendering remains required | `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`; no Vulkan change or Linux-native qualification |
| Web-lite on any OS | Conditional on actual WebGL2 capabilities, admitted resources and qualified feature operations | Existing controller, worker and history owners; WebGL2 implementation and observed-host qualification are pending |

Explorer, Quick Look, GNOME and KDE previews and native thumbnail providers are
unaffected: they do not consume this browser backend. Browser-local remembered
views still do not update system thumbnails. No agent server, CLI, public API,
source-overwrite command or new scene format is added.

## Behavior to preserve

- Separate the graphics backend (`webgpu` / `webgl2`) from Gaussian rendering
  mode (`sorted` / `steady`). Final automatic selection prefers WebGPU. Sorted
  remains the default mode on both backends.
- Preserve covariance projection, SH0-3, native half rounding, alpha support and
  cutoff, opacity preview, selected-only geometry/color/opacity targets, stable
  source IDs, masks and highlights. Do not copy PlayCanvas's different normalized
  Gaussian alpha profile.
- Use the same STBN ranks, primitive phase, noise-cycle shift, four spatial
  neighbors, four distinct foreground occluders and temporal rejection/reprojection.
  Keep history weight 0.7, animated samples and 16-frame rest convergence as
  defaults, with the current 1-1024 frame contract and UI choices.
- Preserve motion history; reset the stationary average after movement. Scene,
  projection, viewport, grade, background, transform, opacity and mask changes
  invalidate the appropriate history. Weight zero preserves spatial reuse.
- Exact contributor picking, composited editing maps and clean capture use
  deterministic semantics, independently of the stochastic display. A visibility
  sample or nearest-source ID cannot substitute for an editing map.
- Preserve on-demand rendering, hidden-tab behavior, cancellation, Undo/Redo,
  dirty state, selected-file authority and browser download acknowledgements.

## WebGPU parity contract

This section records the October 25 consistency review against the implemented
WebGPU path. Reuse the current pure logic and fixtures before changing its module
location. Resource representation may differ; the following behavior must agree.

| Concern | Current source authority | Required WebGL2 behavior |
| --- | --- | --- |
| Settings | [`steadySettings.ts`](../../src/renderer/steadySettings.ts) | Sorted default; weight 0.7 within 0-0.95; animate/convergence true; integer refinement count 1-1024. UI choices remain 16/64/256/1024. Assigning identical settings is a no-op; changing settings resets display history. |
| View admission | [`supportsSteadyProjection`](../../src/renderer/steadyState.ts) and `GaussianRenderer.render` | Run the same finite, non-skewed perspective-matrix predicate on the canonical projection. Orthographic, oblique and non-Gaussian views use their existing renderer. Apply GL depth conversion afterward. |
| Display identity | `SteadyFrameState.observe` in [`steadyState.ts`](../../src/renderer/steadyState.ts) | Copy the canonical 80-word frame identity. Source object/revision, shade and every uniform word except view 0-15 and eye 32-34 invalidate reuse. Compare actual view bits to decide stationary; camera revision alone is insufficient. Preserve canonical mask and all preview-target identities. |
| Sample clock | `SteadyFrameState.observe`, `SteadySplats.encode` | The sampling frame counts reconstruction passes. Picks, captures, pure readbacks and cached composites do not increment it. Content/uniform invalidation retains this clock; explicit history reset, changed settings and new frame resources restart it at zero. |
| Rest convergence | `SteadyFrameState.observe`, `steadyResolvePass` | Initial/moving reconstruction has `restFrames=0`; each subsequent stationary reconstruction increments it. A default uninterrupted view therefore uses 1 initial + 16 stationary samples. Cache after the target; further display requests composite without new samples. |
| Refinement requests | `SteadyFrameState.observe` | Request more frames only when animate AND convergence AND weight > 0 AND the stationary target is incomplete. Weight zero, fixed samples and disabled convergence still reconstruct on explicit display requests, but do not schedule idle refinement. |
| Alpha and projection | [`splats.wgsl`](../../src/renderer/webgpu/splats.wgsl), `steadyAlpha`/`steadyAlphaAt` in [`steady.wgsl`](../../src/renderer/webgpu/steady.wgsl) | Preserve projected axes, opacity, clipping, support and grading operations. Sampling and PDF evaluation use `min(0.99, opacity * exp(-0.5*r))`, cutoff `alpha >= 1/255`, and `r <= min(9, opacitySupport(opacity)+0.001)`. Use the existing piecewise support function. |
| Sample depth and ID | `steadyVertex`, `steadyFragment`, pipeline creation in [`steady.ts`](../../src/renderer/webgpu/steady.ts) | Stable ID = source index + 1; 0 means background. Store linear depth at full precision. Draw source order with depth writes and LEQUAL so equal-depth tie behavior is retained. Half opacity/color packing must not alter coverage. |
| Noise | `steadyPrimitivePhase`/`steadyFragment` in `steady.wgsl`, [`steadyNoise.ts`](../../src/renderer/steadyNoise.ts) | Reuse the exact 32x32x64 rank volume and unsigned 32-bit arithmetic. Preserve per-ID offsets/phase, frame modulo 64, golden-ratio cycle shift and 24-bit threshold conversion. Accept a fragment only when alpha > threshold. Use canonical top-left pixel coordinates. |
| FIFO and spatial ratios | `steadyHistoryPass`, `steadyResolvePass` | Compute outward weights from the previous FIFO. Apply only entries with a different nonzero ID and strictly smaller linear depth. Empty or duplicate samples neither evict nor refresh entries/depth/ratios. Preserve newest-to-oldest multiplication and packed half-ratio rounding. |
| Temporal and stationary color | `steadyTemporalAt`, `steadyResolvePass` | Reuse the same stationary texel, moving-camera cubic reprojection, background ray handling and YCoCg weight rejection. Do not substitute RGB clipping. At rest use spatial estimates for samples 1-8, raw samples afterward, then mix temporal color with the FP32 average using n/(n+8). Apply the same coverage/premultiplication clamp. |
| Queries, output and histogram | [`renderer.ts`](../../src/renderer/webgpu/renderer.ts), [`surface.wgsl`](../../src/renderer/webgpu/surface.wgsl), [`histogram.ts`](../../src/renderer/webgpu/histogram.ts) | Keep lazy deterministic sorting for picks/capture, independent raw surface computation, clean sorted capture and the displayed-image histogram. Histogram identity includes reconstruction progress; retain its 200 ms cadence and at most 256x144 samples. |

For framebuffer passes, preserve the WebGPU history sequence explicitly:

1. Rasterize current visibility and per-pixel Gaussian metadata.
2. Write next FIFO textures while reading only the previous FIFO textures.
3. Resolve current outward ratios from that same previous FIFO and gather them
   at each destination; do not read the newly inserted FIFO for current weights.
4. Resolve temporal color from the previous reconstructed image and stationary
   average, write their next images, then swap those generations for the next
   reconstruction only. There must be no framebuffer read/write feedback.

Neighbor order is +X, -X, +Y, -Y in canonical top-left coordinates. A destination
`p` gathers source `p - neighbor[n]` and that source's outward component `n`;
normalize by `1 + sum(weights)`. An empty source starts with ID 0, maximum depth
and outward ratio 1 before applying its cached foreground occluders. Preserve
the shader's 1e-20 and 1e-6 denominator floors. Clear mixed targets with the
appropriate integer/float operations and ignore prior history whenever invalid.

Pure capture/query operations do not update `SteadyFrameState`. There is one
important existing call boundary: [`DocumentSelectionMaps.request`](../../src/app/selectionMaps.ts)
calls public `renderer.render()` before computing a map. That call really submits
a display frame and can advance or invalidate history with its captured render
inputs. Preserve and test that behavior; introducing query-only preparation on
both backends requires a separately reviewed behavior change. Captures use an
offscreen sorted target and never consume the stochastic display image.

## Delivery sequence

### 1. Define the backend boundary and capability probes

Owner: renderer integration in `src/renderer/` and the existing controller.

Introduce a small shared renderer/scene contract for the operations actually
consumed by `src/app/controller.ts`, selection-map adapters, capture and recovery.
It must cover upload, mask transactions, immutable frame identity, submission
sequence, asynchronous preparation/completion, query results and resource
retirement. Keep backend resources opaque. Replace direct controller assumptions
about `GPUDevice`, `GPUBuffer.destroy()` and `queue.onSubmittedWorkDone()` with
typed backend operations while retaining the current controller/history owners.
Keep the existing WebGPU implementation and benchmark observations working.

Extract pure matrices/display-history state from `webgpu/steadyState.ts` and the
shared projection-admission predicate, plus STBN data from `webgpu/steadyNoise.ts`,
into shared modules. Leave WebGPU allocation
limits and resource lifecycles in their backend. Use direct imports rather than
compatibility barrels. Frame snapshots must preserve current bit-level identity
rules and cannot depend on a live mutable camera or temporary capture uniforms.
Keep the existing 320-byte canonical frame representation and native camera ABI;
make GL-specific raster matrices derived values. Rendering, sampling, query and
benchmark counters retain their distinct existing meanings.

Add a factory with forced-backend test selection and capability diagnostics.
Probe WebGL2, texture/viewport sizes, vertex/fragment texture units, draw buffers,
color attachments and shader precision. For SteadySplats, require
`EXT_color_buffer_float`, at least four draw buffers/color attachments and complete
framebuffers with the exact mixed float/integer formats. Check framebuffer status
and allocation results; extension names alone do not establish support.
Use nearest `texelFetch` and explicit cubic reconstruction, without making float
linear filtering or float blending a blanket SteadySplats requirement. See the
[Khronos extension contract](https://registry.khronos.org/webgl/extensions/EXT_color_buffer_float/).

Probe before committing the presentation canvas, or replace the canvas explicitly
after a failed published context. A canvas cannot be assumed to switch between
WebGPU and WebGL2 contexts. Restore React/input/resize bindings without changing
the authoritative document. Do not require `navigator.gpu` on the WebGL2 path.

Exit: the shared state-machine traces, public-render/query-preparation behavior,
current product/source/worker guards and existing WebGPU production journeys
still pass. Forced WebGL2 startup
and unsupported-capability refusal are testable without enabling a public fallback.

### 2. Implement the sorted WebGL2 baseline

Owner: `src/renderer/webgl2/{renderer,scene,sceneLayout,capabilities}.ts`, GLSL
projection/color/raster shaders and a bounded renderer computation worker.

Upload the existing packed stream and masks into integer/float data textures with
explicit padding and texture-size/texture-unit admission. Port native projection,
color and blending to GLSL ES 3.00 with instanced quads. Keep point/mesh viewing,
orientation, depth and lighting available for supported ordinary PLY inputs.
Convert the camera's 0-to-1 clip depth at the shader boundary
(`z_gl = 2 * z_webgpu - w`), keeping the native camera ABI unchanged. Specify
bottom-left texture/readback coordinates and top-left UI/query coordinates once
and exercise their conversion with asymmetric fixtures.
Keep canonical matrices unchanged for temporal inverse projection, previous
view-projection and query identity. Translate `gl_FragCoord` to canonical top-left
pixels for STBN, neighbors and reprojection; translate canonical texture addresses
back to GL rows at fetches. Apply the readback vertical flip exactly once.

Use a stable CPU radix sort in a renderer-owned worker for the initial sorted
path. Keep the document worker authoritative; the render worker executes immutable
snapshots and never commits edits or history. Account for retained centers, packed
query data, masks, sort scratch and transfers. Apply captured geometry/target
scope before generating the same float depth keys and source-ID tie order as
`webgpu/sort.wgsl`.
Preserve source order for equal keys; packed selection/deletion bits cannot become
a new tie-breaker. In active SteadySplats display, request the global draw/pick
order only when a pick or sorted capture needs it, or while rendering a sorted
fallback. Surface queries retain their own independent tile sorting.

The controller must keep one frame owner across asynchronous sort/preparation,
submission and retirement. Publish camera/projection/order as one captured frame;
discard stale epochs instead of combining new projection with an obsolete order.
Coalesce pending work and test continuous navigation for starvation. Cancel or
join outstanding jobs on scene replacement and context loss.

Exit: analytic Gaussian and PLY fixtures match independent numerical/image
expectations; sorted capture works; normal loader formats and SH0-3 are preserved
within the backend's measured resource admission. No main-thread sort stall or
partially uploaded scene is published.

### 3. Port the SteadySplats passes

Owner: `src/renderer/webgl2/steady.ts`, pure framebuffer planning, GLSL shaders
and the WebGL2 resource owner.

| Pass | WebGL2 implementation | Required invariant |
| --- | --- | --- |
| Stochastic visibility | Unsorted instanced splats, depth test, mixed render targets | Same alpha acceptance, STBN and stable integer source IDs |
| Occluder history | Two sets of four integer history textures | Preserve distinct foreground FIFO entries; empty samples do not evict them |
| Spatial/temporal resolve | Fullscreen GLSL with neighbor-density ratios and ping-pong color | Same four-neighbor weighting, cubic reprojection and YCoCg history rejection |
| Stationary convergence | Ping-pong FP32 average textures | First eight estimates use spatial results, then raw samples; stop at configured count |
| Composite | Fullscreen reconstruction/background composite | Correct premultiplication, background, GL origin and depth conventions |

Use an axes-preserving initial layout: RGBA16F raw color, RGBA32UI sample
ID/depth/center, RGBA32F projected axes and a separate R32F opacity attachment,
plus depth. This uses four sample color attachments. Keep the two sets of four
RGBA32UI histories, two RGBA16F color images and two RGBA32F stationary averages.
The metadata must carry the same post-preview opacity and full-precision axes
used for rasterization; reconstruct local coordinates with the WebGPU axis/dot
formula. Do not silently substitute upstream's normalized conic or round opacity
to half precision. A three-conic-coefficient layout is a later optimization only
after independent coverage/PDF tests qualify its numerical behavior.

Recalculate density from SplatView's support/cutoff in both sampling and
resampling. Port the parity-contract constants and equations, including the
temporal rejection extent, two-pixel moving-history border rejection, empty-ray
world transform and final premultiplied coverage correction. Adapt PlayCanvas
shader plumbing rather than depending on engine-specific preprocessing or output
declarations. Initial WebGL2 resource allocation stays complete across settings,
as in current WebGPU; zero history weight disables color retention, not the
occluder FIFO or spatial reuse. Optimize optional allocations separately.

Exit: the existing analytic SteadySplats fixtures run on both backends: black/white
background, reversed source order, overlapping transparency, fixed/animated
samples, zero history weight, camera motion, invalidation and cached convergence.
Supported steady display frames do not invoke the depth sorter.
Verify pass-level values as well as final images: projected axes/opacity,
sample IDs/depth, outward weights, FIFO ordering, temporal output and rest average.
Use scripted samples for isolated FIFO tests, independently of stochastic noise.
Include default 17-sample completion, idle requests with convergence off, fixed
samples, weight zero, equal-depth ties, frame 63/64 and duplicate-occluder motion.

### 4. Preserve Basic editing and output semantics

Owner: the existing selection-map cache/controller/native adoption boundaries,
with a WebGL2 query executor. Follow [the selection module workflow](../../docs/development/selection.md).

Implement exact contributor picking and composited depth/opacity/raw RGB/visibility
queries against captured frame/source revisions. Start with bounded tiled work
in the renderer computation worker, preserving every accepted fragment, stable
depth order, f32/half conventions and source IDs. Qualify cancellation and latency;
GPU optimizations can follow an independent correct baseline. Do not replace
these outputs with stochastic IDs, nearest centers or partial success.
Keep the current pick/surface distinction: strongest-contributor picks retain
their center-radius eligibility, strict winning-weight comparison and transmission
exit below 1e-5; the composited surface accumulates every surviving fragment with
no transmission exit. Surface RGB excludes display grading/highlight/background
and is opacity-normalized/clamped as today. Surface quad coverage retains its
top-left fill-rule checks; a pick kernel is not a substitute for that kernel.

Route query execution through the shared renderer contract while preserving
`DocumentSelectionMaps`, dependency snapshots, map cache and native history
adoption. Preserve restricted brush coverage, full Color/Fill/visibility coverage,
preview eligibility and exact stale-result checks. Keep operation refusal visible
when a complete query cannot be admitted.
Retain the 262,144-pixel map cap, current 48-byte map parameter contract and
full-frame source visibility footprints even when map outputs are downsampled.
Ordinary display grading/highlight changes do not invalidate unrestricted raw
maps; selected geometry/opacity target changes do. Reuse the existing dependency
snapshot rather than applying the display-history invalidation key to map caches.
This exemption applies to display previews: committed color changes update the
source/content identity and must invalidate raw maps as they do on WebGPU.

Port histogram reduction with bounded sampling/readback. Implement deterministic
clean capture, clipboard and remembered-view image paths, including GL bottom-left
readback conversion and explicit display/encoding color handling. Copy pixels
before the drawing buffer may be cleared; do not enable a permanently preserved
buffer just to simplify capture. Scene export continues through the existing
worker and codec paths.
Capture must snapshot camera, shade, grade, geometry, opacity and source revision
before yielding, use a dedicated sorted target without selection highlight, and
retain that target/readback and admission until actual retirement. A displayed
SteadySplats image is never the clean capture source. Histogram sampling follows
the actual displayed image, including refinement, rather than a sorted capture.

Exit: Basic brush/rectangle/polygon/Color/Fill, cleanup/Undo/Redo, manual transforms,
alignment, color, histogram, capture, saved views and export pass through the same
controller. Any remaining query gap keeps full-editor automatic fallback disabled.

### 5. Resource admission and context recovery

Owner: WebGL2 resources under the existing controller ledger and recovery policy.

The axes-preserving initial layout uses approximately 224 bytes per render pixel:
48 for raw/sample/axes/opacity/depth, 128 for both four-entry FIFO generations,
16 for reconstructed color generations and 32 for FP32 average generations.
That is about 219 MiB at 1280x800 or 443 MiB at 1920x1080. The upstream conic
layout's 220 bytes per pixel is a reference optimization, not this port's budget.
Current WebGPU instead plans 136 bytes per pixel plus its STBN and stripe
uniforms; neither number is a cross-backend capacity guarantee.

Both GL estimates exclude splat textures, CPU mirrors/sort/query work, the shared
64 KiB STBN volume, uploads, uniforms and context overhead. These are planning
calculations, not measured device budgets. Admit the exact configuration and
overlapping old/new resources before allocation. Retire credits only after
submitted work/readbacks/jobs complete, or context loss establishes retirement.
Use nonblocking GL sync polling; avoid per-frame `gl.finish()`.
Backend-specific admission plans remain separate; do not apply WebGPU buffer
stripes or its 136-byte multiplier to GL textures. Preserve full viewport and
cross-row neighbor reads. Keep a single in-flight initialization generation and
retire a stale candidate before releasing its credits or publishing another owner.

Handle `webglcontextlost` and restoration through the existing document recovery
owner, with new resource epochs and stale-publication checks. Recreate programs,
textures and framebuffers, then restore the committed scene, accepted previews,
camera and session settings. Preserve document/history when restoration fails.
Do not silently move an edited document between backends during device loss.

Fallback within WebGL2 is sorted rendering when SteadySplats requirements or
memory admission fail. If the baseline itself fails, use the graphics-unavailable
state. A lower render scale needs explicit reviewed behavior and honest quality
reporting; do not silently change current DPR or query geometry.
Match the current `sorted` / `preparing` / `steady` / `unavailable` status behavior.
Preparing renders the sorted baseline until resources publish. Failed admission
or initialization falls back once rather than reallocating every frame; changed
settings, resized targets or returning from a suspended unsupported view provide
the existing retry opportunities. Ordinary camera motion and unchanged settings
must not retry a failed allocation at the same viewport size.

Exit: resize, allocation refusal, initialization cancellation, replacement,
pending readback, context loss and failed restoration release all owned credits
without destroying the authoritative document.

### 6. Qualify and enable backend selection

Run the product/source/generated/native gates, both typechecks, full CPU suite,
production build and relevant selection/build tests. Keep the WebGPU regression
suite. Add forced-WebGL2 browser projects, including startup with WebGPU absent,
WebGPU initialization failure before/after canvas ownership, missing float/MRT
support, and actual context loss using `WEBGL_lose_context` where available.

Use independent CPU/native oracles and named cross-backend tolerances approved
before assessing results. Require deterministic source-ID/tie behavior and
operation outcomes; distinguish floating-point image tolerance from semantic
query errors. Run the Bench scene and larger admitted scenes, SH0-3, high DPR,
heavy overlap, cancellation, recovery and worker-retention workloads.
Add a backend-parameterized state trace for settings, sample/rest counters,
history validity, frame requests, status and public submission sequence. Test
explicit cached renders separately from reconstruction; picks and captures may
submit GPU work without becoming display frames. Include selection-map requests
that intentionally call public render, plus raw-map cache retention across grade
preview changes and invalidation after a committed color change. Verify valid
data and stale cancellation at the real publication boundary. Display submission
sequence advances only after a real successful display submission; worker startup,
early target preparation, rejected submits and offscreen captures do not advance it.

Record exact browser, OS, GPU/renderer identification when exposed, extensions,
limits, security context, launch flags and fallback reason. Benchmark steady
versus sorted paths on identical models/camera paths; separate frame time, sorting,
queries, convergence quality and peak/retained memory. Do not reuse PlayCanvas
timings as local evidence or require unavailable Mac hardware for this delivery.
Claims about other browsers/devices remain pending their own evidence.

Only after those gates pass, enable WebGPU-first / WebGL2-fallback selection and
the reviewed backend override/diagnostics. Keep rendering-mode settings shared,
localized and session-only; preserve Settings focus and tutorial projection.
Update availability at both discovery and dispatch. Publish current receipts and
limitations without advertising an incomplete Basic editor as a complete fallback.

## Suggested implementation packets

1. Shared renderer contracts, pure state/data extraction, policy review and probes;
   WebGPU behavior unchanged.
2. WebGL2 scene storage, stable worker sorting, sorted splats/PLY and clean capture;
   development/test only.
3. WebGL2 SteadySplats passes, framebuffer planning and cross-backend visual fixtures.
4. Exact queries, Basic workflows, histogram/output and context-recovery integration.
5. Final production qualification, measured operating limits and backend fallback.

## Consistency review result

Reviewed the plan against current `steadySettings.ts`, `steadyState.ts`,
`steady.ts`, `steady.wgsl`, `splats.wgsl`, `renderer.ts`, the surface/pick kernels,
selection-map adapter/cache dependencies, histogram and existing state/browser
fixtures. Corrected the conic-first texture proposal, framebuffer budget,
previous-FIFO ordering, convergence/sample-clock details, GL coordinate boundary,
query preparation assumptions and missing cache/capture/status acceptance rules.
The parity contract above is the implementation checklist for those findings.

Checks passed: 38 existing portable tests in `tests/steady-state.test.ts` and
`tests/renderer-diagnostics.test.ts`, the pinned product verifier (bundle 2.0.0 /
130 registrations), document formatting and preservation of all 34 source hashes
from the preceding WebGPU validation. The audit preimage and test report remain
in `.build/webgl-plan-audit-20261025-01/`.

This review changes the plan only. The WebGL2 shaders, resource layout, worker
queries and browser acceptance cases remain implementation work. No WebGL2,
browser/GPU or native qualification is claimed. Implementation begins with
packet 1; the preceding WebGPU work and its qualification remain separate.
