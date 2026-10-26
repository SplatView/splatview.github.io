# Feature review: scene loading and Gaussian mode-switch latency

Reviewed October 25, 2026 before implementation, against source commit
`2c9d5f04f043f5bbbe90548fbcdf1a7e11c289a6`. The user reports slow loading and
switching viewer type. Inspect the actual scene-loading path and assume the
Sorted / SteadySplats selector pending clarification; backend changes remain
closed-scene session operations.

Read the shared product contract and template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger and approved UI differences. Consume
the local sealed product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
Sibling sources are inspection references only. Preserve pinned native inputs,
worker/codec budgets, exact picks/maps/capture, display precision, controller,
history, resource admission, cancellation, retirement and publication owners.

## Platform and surface decisions

| Target | Policy / source evidence | Implementation and qualification |
| --- | --- | --- |
| Windows editor | Required responsive loading and native View settings; current `../SplatPreview/src/app_ui_settings.cpp` and sealed behavior policy. Optional GPU modes depend on renderer capabilities. | No native implementation change or new Windows app qualification. |
| macOS editor | Required responsive native scene/view workflows; `../splatview_macos/src/ui/editor_ui.cpp` and sealed policy. | No Metal/AppKit change. Browser performance measurements do not qualify Apple hosts. |
| Ubuntu editor | Required responsive native scene/view workflows; `../splatview_ubuntu/src/ui/editor_ui.cpp` and sealed policy. | No Vulkan/SDL/installed-host change or runtime qualification. |
| Web-lite / standalone browser renderer | Required existing loading and Sorted / SteadySplats workflows; conditional WebGPU/WebGL2 support and admitted optional resources. | Measure actual App/controller and renderer paths on both backends, then change only demonstrated redundant work or blocking preparation. Browser/OS/GPU evidence remains scoped. |

Explorer preview, Quick Look, GNOME/KDE previews and OS thumbnail providers are
unaffected; their existing conditional host policies and qualification remain.
Browser-local views do not update system thumbnails. No agent, native API/CLI,
format, source-write, tutorial or settings registration is added or removed.
Existing UI and standalone APIs retain their defaults and error/fallback behavior.

## Investigation and implementation constraints

Separate navigation/runtime verification, native decode, stream/upload, recovery
checkpoint and first display from mode preparation. Record cold and repeated
mode changes separately. Observe synchronous pipeline creation and event-loop
long tasks; GPU completion is not physical presentation. Retain raw samples,
failed attempts and exact source/environment identities. Do not benchmark while
other tests or builds compete for the GPU.

Current WebGPU SteadySplats creates pipelines synchronously on first use; both
backends release optional framebuffer resources when switching to Sorted.
Measure those paths before selecting an optimization. Any async preparation must
retain one owner, await every submitted preparation on failure/cancellation,
publish only current valid results, and release every resource credit after
retirement. Do not retain large optional buffers or weaken recovery/source/hash
verification merely to improve a timer. Keep scene/canvas/renderer/device epochs,
query and capture semantics intact.

Required checks: affected lifecycle/cancellation/admission and preparation tests,
actual App loading/mode switching on both backends, unchanged selection/output
contracts, both TypeScript projects, source/native/generated/product gates and
production app/isolated SDK builds. Record before/after measurements separately
from correctness evidence and disclose any remaining startup or environment gap.

## Selected implementation

Prepare optional Steady shaders when General settings is shown for a Gaussian
or empty viewer. Add the same optional `prepareRenderMode(mode)` to the existing
typed browser renderer boundary for standalone hosts. This method compiles only,
does not select a mode or allocate frame buffers, deduplicates concurrent calls,
rejects errors and allows retry. Existing mode selection works without warmup.
Sorted preparation does nothing. Close joins outstanding compilers; stale results
cannot allocate or publish after disposal. Do not create another scheduler.

Use asynchronous WebGPU Steady pipeline creation with all compilers joined on
failure. WebGL keeps its existing parallel-program helper and explicit GL owner.
Retain compiled shaders across switches but continue releasing large optional
buffers on Sorted/unsupported views. Launch independent WebGPU startup compute,
raster and geometry compilers together instead of three serial phases; cleanup
waits for all launched compilers. No worker/native/source/recovery verification
is deferred or removed.

After the native stream completes, overlap the existing GPU upload completion
with saved-view lookup and recovery checkpoint preparation. These consume
independent GPU and native/storage owners. Join both before activating/publishing
the candidate, retain the old document until then, and join pending completion
before failure/cancellation cleanup releases source or GPU credits. The final
upload tail is already bounded by the existing 16 MiB upload barriers; no new
buffer pool, source admission, checkpoint format or memory allowance is added.
Real browser tests must hold completion, observe checkpoint acceptance without
publication, then release it or cancel/close and verify complete cleanup.

Investigation and checks are in progress. Initial exact-frame measurements on
the bundled Bench scene distinguish first selection from repeated selection and
16-frame refinement. The first timing probe stopped before an actual Steady
frame and is retained as a rejected diagnostic; do not use it for improvements.
Final measurements, results and qualification will be recorded below.

## Qualified local result

Implemented shader-only preparation on General settings and in the standalone
renderer, asynchronous WebGPU Steady compilation, concurrent independent
startup compilation, and overlapping candidate GPU completion with saved-view /
checkpoint preparation. All readiness, source/native identity, cancellation,
failure and publication barriers remain. No visual quality/default change or
optional frame-buffer cache was introduced. The 133 registered bindings and
sealed product bundle are unchanged; the additive SDK method is documented in
`docs/development/renderer-engine.md`.

Measured the shipped 0.2.0 static files and the new production build using the
same normal UI workflow, 1280 x 800 CSS viewport and bundled 262,556-source SH3
Bench. Each revision has three runs per backend, fresh browser contexts and a
fixed 500 ms reading interval after opening Settings. Shader warmup happens
during that interval; its cost is excluded from selector latency and visible in
the compiler trace. GPU frame completion uses the existing queue/fence calls;
these are not physical presentation measurements. All samples and cold outliers
are retained; OS/driver caches were not reset.

Observed medians: first WebGPU Steady selection 109.1 -> 30.6 ms; WebGL scene
load 970.9 -> 690.5 ms; WebGPU load approximately 681 ms unchanged. First WebGL
Steady selection remains about 419 ms (450 ms baseline); there is no substantial
cold-WebGL improvement claim. Repeated GL selection medians were 55.9 -> 39.7 ms.
These are small local cohorts, not universal performance guarantees. Further
cold-WebGL profiling remains useful; no retained full-size resource pool is
justified by this change.

Passed 6,480 portable tests; 40 build contracts; 100 Python tests with one skip;
both TypeScript projects; frozen source/native/generated and product gates;
111 app artifacts / 116 files / four source maps / 351 source inputs; 63 SDK
artifacts and the isolated consumer. Final browser cohorts passed with retries disabled and no final skipped or
unexpected results: 72 development/lifecycle/settings/recovery,
14 standalone and 40 production per backend. These 166 executions overlap.
Held completion proves the private candidate checkpoint can prepare while the
old document remains current; success, close/cancel and rejection join cleanup.

Diagnostics retained: the initial timing probe accepted preparation before a
Steady frame and is rejected; an existing 5-second worker test timed out during
overlapping test tools, then passed unchanged in isolated complete runs. New
load instrumentation initially imported a second development module identity;
it now observes the actual client's constructor. A preexisting geometry-test
ledger oracle required a renderer after disposal; the ledger observation now
uses its surviving controller owner. Initial production checks used the Python
benchmark host, which served .mjs as text/plain: 20 direct test-helper imports
failed while the ordinary app worked. A later preview run hit
`net::ERR_NO_BUFFER_SPACE` fetching the verified entry before App startup; its
trace is retained. The same isolated case and subsequent complete cohorts
passed unchanged. Both complete production cohorts passed on the normal Vite
preview host with identical app bytes. No production runtime
or native check was relaxed for these test-host corrections.

Observed environment: Windows 10.0.26100, headless Chromium 156.0.8078.4,
secure loopback, cross-origin isolation false and the existing unsafe-WebGPU
test flag. The same-run standalone environment receipt records the actual
NVIDIA RTX 5090 / ANGLE D3D11 and WebGPU device capabilities; it is a separate
observation from the production timing clock. Other OS/browser/GPU, normal
interactive browser and native/provider hosts remain unqualified.

Exact manifests, source digests, raw reports, diagnostics and benchmark script:
`docs/validation/runs/scene-load-mode-20261025-01/validation.json`.
The changes are local development work; no new tag, release or Pages deployment
was made by this follow-up.
