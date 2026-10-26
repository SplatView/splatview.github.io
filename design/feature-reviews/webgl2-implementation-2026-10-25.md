# Feature review: view.render - WebGL2 backend implementation

Implementation and local qualification, October 25, 2026. The user authorized implementing the
[reviewed plan](steady-splats-webgl2-plan-2026-10-25.md). This record does not claim
WebGL2 qualification before the implementation and observed-browser gates pass.

The starting checkout is `fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2` plus the retained
WebGPU SteadySplats changes captured in
`docs/validation/runs/steady-splats-20261025-01/validation.json`. Preserve concurrent
work and native/generated source locks. The local product bundle is 2.0.0, pinned
by manifest SHA-256 `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
The shared development contract and review template were read; builds use only
the reviewed local bundle, never live sibling sources.

## Intent, surfaces and compatibility

Implement WebGL2 sorted rendering and opt-in SteadySplats with the current WebGPU
logic. Keep the existing controller, document worker, native history, codecs,
capture and selected-file authority. Rendering backend and Gaussian render mode
are independent. New typed `GraphicsBackendPreference.auto`, `.webgpu` and
`.webgl2` registrations bind explicitly to `view.render`. Backend selection is
session UI/test configuration; no public API, CLI, agent server, source overwrite
or document-format field is added. Sorted remains the Gaussian mode default.

Early WebGL2 startup is forced/test-only. Automatic WebGPU-first/WebGL2 fallback
is enabled only after all declared Basic operations, output and recovery pass.
Runtime permission, dataset, operation admission and source/worker checks retain
their separate owners. Unsupported actions must be refused at dispatch as well
as discovery. Tutorials retain existing semantic targets and availability rules.

| Target | Policy and conditions | Source owner and implementation evidence |
| --- | --- | --- |
| Windows editor | Required existing native rendering; browser backend does not change D3D11 policy | `../SplatPreview/src/renderer.hpp`; unaffected, no new native qualification |
| macOS editor | Required existing native rendering | `../splatview_macos/src/render/render_frame.cpp`; unaffected, no new Metal/Apple qualification |
| Ubuntu editor | Required existing native rendering | `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`; unaffected, no new Vulkan/Linux qualification |
| Web-lite | Conditional on WebGL2 capability probes, actual allocation admission and qualified feature operations | `src/renderer/`, existing controller/cache/worker; implemented; observed Windows Chromium qualification is recorded separately |

Explorer, Quick Look, GNOME/KDE previews and native thumbnail providers are
unaffected: they do not consume this browser backend. Browser saved views remain
origin-local and do not update operating-system thumbnails.

## Existing and new contracts

Follow every invariant and acceptance gate in the reviewed plan, especially:
canonical 320-byte frame identity; full-precision axes/opacity; native alpha;
old-FIFO resampling order; initial plus N stationary samples; distinct display
and sample clocks; lazy deterministic picks/capture; exact all-fragment surfaces;
shared source/preview dependencies; snapshot-before-yield capture; independent
backend resource plans; queue-fenced/GL-fenced retirement; stale worker rejection;
context replacement without changing document/history ownership.

Product registration generation/verification supplements source/generated assets,
native/WASM provenance, worker/codec budgets, typechecks, CPU and browser tests.
No frozen native input or ABI change is planned. The `webgl-compatibility` ledger
entry will receive a reviewed conditional-backend scope amendment during delivery;
historical receipts and excluded separate-viewer claims remain historical.

## Validation and handoff

Record commands/results and exact browser/OS/GPU/extensions/limits/context/flags.
Keep the WebGPU regressions and new WebGL2 state, shader, query, output, recovery
and production Basic fixtures. Portable tests alone never establish GL behavior.
Profile/registration/capability migrations remain pending until their actual
changes and checks are recorded. No remote deployment is authorized by this work.

Implementation checkpoints and actual results are appended as work proceeds.

## Historical checkpoint 01: forced backend and deterministic query baseline

The shared renderer boundary, canonical frame encoder, history state and STBN
volume are implemented. WebGPU retains its actual GPU owners and direct GPU
oracles. WebGL2 now owns packed integer scene textures, a revisioned computation
worker with build verification, stable native-depth radix sorting, native SH0-3
projection/grading, PLY points/meshes and clean offscreen image readback.

The GL SteadySplats implementation uses the reviewed 224-byte framebuffer plan,
separate old/new FIFO generations, full-precision axes/opacity, cubic/YCoCg
temporal reconstruction and FP32 rest averages. The shared frame state preserves
the initial plus 16 stationary samples and cached composites. Optional allocation
refusal falls back once. Worker surface maps preserve compact complete tile
admission, the 48-byte parameter ABI, top-left quad coverage, raw SH, full-frame
visibility and separate map dependencies. Picking retains pixel-center snapping,
center-radius eligibility, strongest-contributor ties and transmission exit.

The controller now consumes backend operations, including asynchronous display
preparation and completion. Backend-specific estimates include the GL worker's
packed mirror, physical texture padding, masks, sort/query scratch and image work.
GL fences retain queued allocations/readbacks through retirement. Context loss
uses the existing native recovery owner and replaces the React canvas, including
wheel/pointer/resize bindings. Recovery remains on the selected backend.

The application still sets `allowFallback: false`. Forced `?graphics=webgl2` is
available for qualification; it does not advertise an automatic editor fallback.
The factory's automatic path is exercised separately for adapter/presentation
failure and canvas replacement. Missing float targets/MRT disable SteadySplats
while preserving sorted display. No profile migration or additional native
qualification is claimed.

Observed development evidence includes 30 GL render/query/history/histogram
cases, four capability/startup failure cases, the real editor cleanup/Undo and
context-loss journeys, all 13 public Color cases, all nine public Fill cases,
the shared brush/rectangle/polygon journeys, and 11 WebGPU SteadySplats regressions.
The first gesture run exposed tests starting new input while Undo still retired
its resource owner; readiness assertions now wait on the actual controls, with
membership/history assertions retained. A scripted FIFO test checks integer IDs
above 2^24, empty/duplicate retention, old-generation ratios and packing against
the observed WebGPU implementation. An initial round-to-nearest-only expectation
was incorrect for the observed backend pair; both packed the same half value.

Both TypeScript projects and the production build passed at an intermediate
checkpoint. The build gate now explicitly owns the content-addressed render
executor and its current source map; all 39 preceding build-tool cases passed.
The full portable suite initially exposed stale renderer-boundary fixtures;
their completion, surface and shared stale-error contracts are updated, and the
204 affected focused cases pass. Fresh full-suite/build/browser receipts remain
required after the final source changes.

Remaining delivery work includes broader native editing/transform/alignment,
clipboard/saved-view, cancellation/retention and production workflow coverage;
backend override presentation; measured Bench/larger-scene operating limits;
cross-backend state traces and further pass-level values; final policy/status
updates and automatic fallback only after those gates pass. Other browsers,
OS/GPU configurations and native preview providers remain separately qualified.

## Delivery: conditional integrated backend

The Basic gates now cover shared selection/cleanup history, selected Flip X and
native Move/Rotate/Scale gestures, Center/Scale/plane alignment, camera/history
lineage, actual native/graphics packed SH3 and masks, PNG/JPEG output, trusted
clipboard ownership, thumbnails, saved-view import/export and real IndexedDB
transaction cancellation. GPU oracles retain actual WebGPU buffers. GL editing
observations read actual R32UI/RGBA32UI allocations rather than worker/host mirrors.

The app enables WebGPU-first startup with WebGL2 fallback after initialization
failure. Explicit overrides remain authoritative. Actual App journeys exercise
missing navigator.gpu, absent adapters and failure after WebGPU claims its canvas.
React replaces the canvas and preserves input, Settings focus and controller
ownership. Device loss stays on the selected backend. Failed GL restoration
retains the native document and executable Redo until retry. An accepted Basic
transform restores the same clean image and camera after actual context loss.

Settings exposes the three reviewed backend registrations, actual backend/fallback
diagnostics and session rendering settings in eight languages. Switching is
disabled while loaded and refused at controller dispatch. Existing native/WASM
and source locks, loader formats, one-million application preview cap, DPR,
1 GiB aggregate admission, worker/native owners and tutorial targets remain
unchanged. No CLI, agent, source overwrite, profile migration or native thumbnail
host is added. The separate compatibility-viewer inventory row stays excluded.

Held actual initialization, readback and worker-terminal checks retain credits
until retirement through cancellation, resize, Close, candidate refusal and loss.
The render worker yields through MessageChannel task boundaries rather than
clamped nested timers, preserving cooperative cancellation. Real paired state
traces agree through rest 7/8, sample 63/64, convergence/cached display, motion,
content/settings changes and query/capture clocks. Actual native map creation
calls public render; grade-only raw-cache reuse retains that map. Committed color
invalidates it through the existing native color settlement and map owner.

Measured workloads use the bundled Bench SH3 stream and coincident copies with
distinct IDs: 262,556 at 320x200/DPR1; 525,112 at 640x400/DPR2; and a renderer-only
1,050,224-record stress fixture at 1280x800/DPR2. The last exceeds the unchanged
one-million application load cap and does not establish larger loader support.
Both backends follow the same native camera path. Evidence separates completed
wall time, GL worker sorting, picks, a complete 32x32 map region, sorted capture,
convergence MSE and logical peak/retained memory. It does not measure hardware
timestamps or physical driver memory. The GL stress fixture measured about
64 ms sorted and 31 ms steady median, with a roughly 426 ms steady first-use
outlier. Image MSE fell from about 794 to 51 after 64 rest samples, matching the
observed WebGPU quality. These are local observations, not universal capacity
or frame-rate guarantees. Render scale and the default sorted mode are retained.

Actual final checks, exact source/build identities, environment/flags, diagnostic
failures and superseding runs are retained in
[delivery receipt 02](../../docs/validation/runs/webgl2-implementation-20261025-02/validation.json).
Previous WebGPU and forced-backend receipts stay historical. Qualification is
limited to observed Windows Chromium 156 / NVIDIA RTX 5090 on secure localhost,
without cross-origin isolation and with the recorded test WebGPU flag. Other
OS/browser/GPU/security contexts, deployed hosting and native preview providers
retain separate evidence requirements; portable tests do not qualify them.
