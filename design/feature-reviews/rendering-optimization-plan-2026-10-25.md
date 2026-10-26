# Review and plan: additional rendering optimizations

Status: implemented and locally qualified, October 25, 2026. The original
findings below remain the retained baseline; final evidence is recorded below. The user's requirement is **all sorted paths**,
on both WebGPU and WebGL2. SteadySplats is an additional consumer of shared work;
it does not replace sorted rendering or supply approximate editing results.

## Authority, scope and platform review

Existing logical feature: `view.render`, with the current rendering, selection,
image-output and resource-lifecycle contracts. The base commit is
`fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2` plus the retained uncommitted work.
Relevant changed renderer/controller/benchmark files were compared with
[delivery receipt 02](../../docs/validation/runs/webgl2-implementation-20261025-02/validation.json).
The ordinary WebGPU shaders are unchanged HEAD inputs. Preserve all of that work.

Read the shared development product contract and feature-review template, root
README/port plan/status, capability ledger, approved UI differences and selection
module map. Builds continue to consume local product bundle **2.0.0**, manifest
SHA-256 `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
Sibling sources are documentation references, never build inputs.

| Target | Policy and evidence | Implementation/verification for this proposal |
| --- | --- | --- |
| Windows editor | Existing native rendering remains required; native owner `../SplatPreview/src/renderer.hpp` | This plan changes browser internals. No native change or new D3D11 qualification. |
| macOS editor | Existing native rendering remains required; Metal owner `../splatview_macos/src/render/render_frame.cpp` | No native change or Apple qualification. Browser optimizations remain conditional on browser capabilities, not OS exclusion. |
| Ubuntu editor | Existing native rendering remains required; Vulkan owner `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp` | No native change or Linux-native qualification. Browser evidence is still configuration-specific. |
| Web-lite on Windows/macOS/Ubuntu | Conditional on the existing WebGPU/WebGL2 capabilities and resource admission; exact sorted viewing/editing remains required within that supported surface | Current implementation is locally qualified on the recorded Windows configuration. The optimization packet is qualified on the recorded Windows Chromium/RTX 5090 configuration. Other browser/OS/GPU targets remain unobserved. Each optional fast path retains the working baseline. |

Windows Explorer, macOS Quick Look, GNOME previews, KDE previews and their native
thumbnail providers do not consume these browser modules. Each retains its
existing host policy and has no implementation change or new qualification here.
Browser-local saved views still do not update operating-system thumbnails.

Surfaces are the existing browser UI and internal renderer/query operations.
Profiling belongs to existing test/agent benchmark facilities; it adds no web
measurement UI or tutorial entry. There are no proposed UI actions, labels,
settings, formats, CLI/API commands, source-overwrite operations or persistence
fields. Existing backend/render-mode registrations and their review pins stay
unchanged during planning. Re-review any implementation that needs new
registrations, capability requirements or observable quality changes.

## What the review found

These findings are source observations and retained measurements, not fresh
performance qualification.

1. **WebGL2 always requests a full sort and uploads its order.**
   [`GlRenderer.sortedOrder`](../../src/renderer/webgl2/renderer.ts) has no reuse
   key. Sorted display and clean capture call it even when depth ordering is
   unchanged. The worker allocates radix arrays for each request. At the stress
   fixture, eight moving frames spent about 400.5 ms in sort-request wall time
   in total, excluding the caller's mask-copy/order-upload work.
2. **Display completion includes unrelated work.**
   [`AppController.draw`](../../src/app/controller.ts) retains its drawing guard
   until `renderer.finish()`. GL completion waits the renderer tail, a worker
   barrier, a GL fence and pending retirements. Picks and maps also hold the same
   [`GlRenderer.run`](../../src/renderer/webgl2/renderer.ts) tail while awaiting
   pure worker computation. This creates a path for query work to delay display.
   The actual contribution to input latency has not been isolated.
3. **GL repeats expensive projection in its quad vertex shader.**
   [`splat.vert.glsl`](../../src/renderer/webgl2/splat.vert.glsl) calls
   `projectGaussian` for each of six vertices. This includes covariance and SH
   evaluation. The source repeats the calculation; a sixfold runtime saving is
   not implied. Both backends also use six nonindexed quad vertices.
4. **WebGPU has avoidable preparation and coarse sort invalidation.**
   [`GaussianRenderer.prepare`](../../src/renderer/webgpu/renderer.ts) dispatches
   projection on every Gaussian display request, before SteadySplats decides
   whether it can composite a cached result. Sorting uses camera revision rather
   than depth-relevant matrix bits. However, its sorted payload also packs mask
   bits into `order.y`; skipping mask refresh would produce stale highlights.
5. **Cold program work and repeated API lookups are candidates for improvement.**
   [`createProgram`](../../src/renderer/webgl2/gl.ts) queries compile/link status
   synchronously; draw helpers repeatedly look up uniform locations. The first
   measured Steady frame has a large outlier, but its cause has not been proven
   to be compilation rather than first-use driver or synchronization work.
6. **Exact query cost is substantial and cancellation has a weak spot.**
   [`computePick`](../../src/renderer/webgl2/queryCompute.ts) projects and globally
   sorts the complete source for each pick. Surface projection still scans the
   source for a small map region. Large tile lists use synchronous comparator
   sorting, with checkpoints between tiles rather than within one large sort.
   WebGPU's [`pick`](../../src/renderer/webgpu/splats.wgsl) evaluates its ordered
   source in one compute invocation. Neither backend's query cost should be
   treated as ordinary raster frame time.
7. **Some transient resources can be smaller.** GL Gaussian capture allocates a
   depth attachment through `createTarget`, although sorted Gaussian drawing
   disables depth testing. Ordinary PLY capture does need depth. GL SteadySplats
   currently costs 224 bytes/pixel plus noise/parameters; WebGPU costs 136
   bytes/pixel plus its fixed/stripe overhead. Those are logical plans, not
   physical driver-memory measurements.

### Retained measurement context

Windows, Chromium 156, RTX 5090; GL uses ANGLE/D3D11. Secure localhost,
cross-origin isolation off, test flag `--enable-unsafe-webgpu`. Results include
queue/fence completion and task wakeups, not isolated GPU execution time.

| Renderer fixture | WebGPU sorted / steady median | GL sorted / steady median | GL mean sort-request wall time during sorted display |
| --- | --- | --- | --- |
| Bench SH3, 262,556, 320x200 | 2.5 / 3.4 ms | 30.6 / 32.5 ms | 11.7 ms |
| Two coincident copies, 525,112, 640x400, DPR2 | 2.6 / 3.0 ms | 31.0 / 31.7 ms | 23.5 ms |
| Four copies, 1,050,224, 1280x800, DPR2 | 3.0 / 3.0 ms | 64.0 / 31.3 ms | 50.1 ms |

The last renderer-only fixture exceeds the unchanged one-million application
load cap. It does not establish larger loader support. Counts and framebuffer
sizes change together, so the rows do not isolate count scaling. Each moving
series has only eight samples: the reported p95 is effectively its maximum, not
a robust tail estimate. The GL stress Steady series includes a 425.7 ms first
measured frame. Its pick/map/capture observations were about 467/479/319 ms;
the map covers a complete 32x32 region in the downsampled map grid, not a full
all-channel map. Preserve these receipts and rebaseline rather than rewriting
their results or presenting them as universal FPS.

## Required sorted-path coverage

Every packet must retain these operations; a fast path that cannot serve a cell
uses that cell's existing exact implementation.

| Operation | WebGPU | WebGL2 | Acceptance contract |
| --- | --- | --- | --- |
| Explicit/default sorted display | Required | Required | Native projection, SH0-3, f32 depth keys, source-ID ties, alpha/blend/background/highlights |
| Sorted while Steady resources prepare | Required | Required | Usable display during preparation; immutable captured frame/order |
| Sorted after Steady admission/capability/view refusal | Required | Required | Same supported baseline; no extra float-MRT/extension requirement |
| Clean PNG/JPEG, capture/copy/thumbnail/saved view while either mode is selected | Required | Required | Captured inputs before yielding; clean offscreen sorted composition; opaque pixels and existing image ownership |
| Strongest-contributor pick and radius eligibility | Required | Required | Stable front-to-back evaluation, all relevant occluders, strict winner ties, existing transmission exit |
| Raw depth/opacity/color and global visibility maps | Required | Required | Complete compact tile candidates, exact tile order, every surviving fragment; full-frame visibility |
| Brush, Color/Fill, cleanup, transform/alignment and Undo/Redo | Required | Required | Existing native/controller/map/history owners and accepted preview masks |
| Ordinary PLY points/meshes | Preserve viewing | Preserve viewing | Independent geometry/depth path, clean capture and read-only policy |

Exercise SH0-3; selected/unselected/deleted/duplicate masks; selected-only
geometry/color/opacity previews; asymmetric and equal-depth scenes; alpha/near
and footprint boundaries; multiple backgrounds; resize/DPR; navigation; fixed
and changed views; cancellation, scene replacement and loss. Preserve current
unsupported-projection behavior, including its normal sorted renderer.

Raw surface maps have their own sorting/compositing contract. Do not replace
them with a stochastic sample, nearest ID, capture pixels or a pick-style early
transmission exit. Do not force a display-wide sort on Steady frames merely to
populate a query cache. Public `DocumentSelectionMaps.request` still calls
`render` when creating a map; it can submit a real display frame.

## Implementation sequence

### P0. Attribute cost and fix the benchmark design first

Owner: `tools/bench/`, the existing observation adapter and backend benchmark
fixtures. Extend diagnostics there rather than adding a benchmark UI.

Measure submission time, worker queue delay/compute/transfer, projection, sorting,
raster/resolve, upload, fence polling/wakeup and resource retirement separately.
Add bounded counters for projection dispatches, sort jobs, installed-order hits,
uploads, pipeline preparation and cache bytes. Instrumentation remains disabled
in the ordinary path. Optional GPU timing never becomes a rendering requirement:
GL query results must be available and non-disjoint before consumption
([Khronos timer-query contract](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/));
WebGPU timing uses its optional
[`timestamp-query` feature](https://gpuweb.github.io/gpuweb/), consistent with the
pinned local WebGPU types. Record unavailable timing honestly.

Separate cold startup/first use, warm motion, fixed-view redraws and end-to-end
input-to-display latency in the actual App. Use at least 120 warm frames per
series and three repetitions, plus independent cold starts. Hold viewport/DPR
fixed while varying count and SH; then vary viewport/DPR at fixed source. Keep
the old exact Bench and overlap fixtures and add within-cap application loads.
Run sorted first and as a separately reported mandatory gate. Query timing and
capture timing stay separate. This packet attributes the 31 ms floor and cold
outlier before choosing a synchronization or compilation remedy.

### P1. Reuse exact sorted orders, then reuse sort scratch

Owner: backend renderer/scene owners, `frame.ts`, `radix.ts` and the existing GL
compute client/worker/protocol.

Start with a small resident-order key, using source identity/generation, actual
f32 depth-row bits, geometry and relevant transform-target/membership versions.
Conservative invalidation is preferable to a missed dependency. Projection/FOV,
background or grading alone should not require sorting when those inputs do not
change the key. Do not infer reuse solely from camera revision or assume camera
translation preserves f32 ties. Source ordering remains exact and stable.

Track the order actually installed in each scene's GPU buffer/texture. An
offscreen captured view can replace it; the following live display must recheck
its own key. Start GL reuse with the existing resident order texture, without
retaining another O(N) host array. Apply the check to display, fallback and clean
capture. Query reuse is allowed only with an exact matching query dependency key.

WebGPU can first retain conservative `sortDirty` behavior while replacing
revision-only camera misses. Decoupling mask updates from sorting is a separate
step: either refresh packed state bits in existing order, or read current state
by source ID in the sorted vertex path. Verify highlight/deletion/preview/tie
behavior before relaxing invalidation; mask bits must never become a tie-breaker.

Pool only worker scratch that remains owned. A transferred output ArrayBuffer is
detached and cannot be reused as scratch. Any retained order or projection needs
its own lease and pressure eviction; output-copy/return protocols must account
for both generations until acknowledged. Initially keep GL's four 8-bit radix
passes, WebGPU's eight 4-bit passes and each path's f32 operation order.
Exit: zero redundant sort jobs/order uploads on
unchanged-order redraw/capture, with byte-identical required permutations and
unchanged query/edit outcomes on both backends.

### P2. Scope display completion and keep query work cancellable

Owner: the existing App draw owner and renderer/compute owners; no second
scheduler, native history owner or document worker.

Introduce a narrowly typed completion for the submitted display checkpoint, if
P0 confirms the bottleneck. Ordinary drawing waits that checkpoint; full
`finish()` keeps its existing join-all role for replacement, Close, loss and
resource retirement. Retain a bounded number of display submissions and captured
frame/order/epoch identity. Do not simply delete fences or clear `drawing` early.

Move pure worker-query waiting out of the GL submission critical section where
immutable snapshots and publication checks allow it. Capture's GPU draw/readback
still has one GL owner. Sorted motion still needs worker sorting; releasing the
GL tail alone will not unblock a FIFO worker occupied by a long query. Use the
existing cancellation owner and bounded cooperative work so obsolete queries
yield before the latest frame preparation. Replace large noninterruptible tile
comparator sorts with an exact cooperative algorithm where needed, preserving
front-to-back depth/source ties and complete candidate admission.

Investigate repeated fence creation/polling only after measuring it. Avoid busy
spinning and retain real GPU/worker completion before releasing leases. Exit:
map/capture overlap and cancelled heavy tiles no longer delay unrelated eligible
display completion, while held terminal/readback/allocation tests still retain
all credits until their true retirement.

### P3. Reduce repeated projection and vertex work

Owner: backend draw/preparation shaders and resources, with shared pure key/layout
helpers only where both backends actually consume them.

First try indexed quads with four distinct vertices and the same six triangle
indices, on both Gaussian sorted draw paths. Preserve primitive order, winding,
top-left coverage and stable source IDs. Keep independent PLY geometry working.
Measure the benefit rather than promising a fixed percentage.

For WebGPU, cache resident projected data using actual scene/frame dependencies;
start with conservative complete canonical words and mask/source generations.
Capture or query work can replace resident data, so an old display key alone is
insufficient. Continue writing required uniforms and publishing the proper frame
identity even on a projection hit. Public renders still submit display frames;
Steady history/sample/rest counters keep their existing meanings.

If profiling still shows GL vertex projection as dominant, prototype one
projection per source into GPU-readable storage. A transform-feedback buffer is
not directly a random-access sampler: include the GPU-only lookup/transfer
representation, padding, extra passes, resource credit and binding restrictions
in the design ([WebGL2 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)).
A float-render-target version is conditional and cannot become a requirement for
the no-float-extension sorted baseline. Retain full axes/opacity precision and
the existing shader path on unsupported/admission-refused devices. Ship this
larger change only if total frame time improves after transfer and memory costs.

### P4. Prepare programs without avoidable main-thread stalls

Owner: GL program creation, linked-program binding data and renderer/Steady
initialization. Cache uniform locations and block/sampler bindings per linked
program; rebuild them with the context/program epoch.

Batch compile/link submission. When available, use nonblocking completion checks
from [`KHR_parallel_shader_compile`](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/),
then validate link success and report failures. Completion after context loss is
not successful initialization. Keep a bounded pending generation, cancellation
and the extension-absent baseline. Prepare optional Steady programs while sorted
rendering remains usable; evaluate first-draw warmup only with temporary admitted
resources and no changes to the user's display/sample clock. Reuse existing
WebGPU asynchronous preparation patterns where appropriate.

Exit: improved cold-input responsiveness on measured hosts, successful baseline
startup when the extension is absent, and unchanged fallback/canvas replacement,
error propagation and stale-initialization retirement.

### P5. Accelerate exact picks and map queries

Owner: current GL query computation/projection/radix modules, WebGPU pick/surface
shaders and existing map/cache adapters. Follow the selection module map.

Profile projection, candidate generation/sort and composition separately. Reduce
temporary JS arrays and reuse admitted scratch while retaining the exact f32
evaluation order. Consider a bounded, optional worker projection/order cache for
matching immutable inputs; retain geometry versus raw-color channel validity
separately where justified. The host must account for persistent worker bytes,
including idle retention, and evict before pressure/refusal. Existing published
native/map ownership remains with `SelectionMapCache` and the controller.

For picking on both backends, evaluate conservative pixel/tile candidate lists
followed by the existing ordered contribution calculation. The radius affects
winner eligibility, not which foreground occluders count. A parallel maximum of
alpha is not an equivalent strongest-contributor query. Admit complete lists;
optional acceleration refusal uses the existing exact path, not truncated lists.
Do not add center-only culling or a transmission exit to raw surface composition.
Keep full-frame visibility separate from downsampled/region map coverage.

Exit: exact IDs/membership/history, named numerical tolerances, responsive stale
cancellation and measured pick/map latency improvement under both display modes.

### P6. Reduce transient allocations and retain only useful caches

Owner: existing backend resource and image owners plus pure admission plans.

Use a color-only target for GL sorted Gaussian capture; retain depth for ordinary
PLY. This removes four bytes/pixel from that depth allocation (about 3.9 MiB at
1280x800), subject to actual allocation/retirement tests. WebGPU already allocates
capture depth only for geometry. Evaluate bounded reuse of compatible capture
targets/readbacks and static noise data across resize; keep busy generations
leased, image bytes immutable, and cached resources pressure-evictable.

Keep the current 224-byte GL and 136-byte WebGPU Steady plans as authorities
unless a separately justified representation change passes independent numerical
tests. Half opacity/axes, lossy conics, reduced resolution, dropped splats,
approximate depth bins or sorting every N moving frames are outside this plan.
Their speed would not establish exact sorted-path compatibility.

## Completion and validation gates

Implement P0, then P1/P2, then the measured low-risk parts of P3/P4/P6. Larger
projection/query changes follow their isolated profile evidence. Each packet is
reviewable independently and retains the previous working implementation when
its optional acceleration is unsupported or refused.

For every packet, run meaningful pure key/layout/order/admission checks and both
TypeScript projects. Selection changes retain `npm run test:selection` and the
maintained selection browser cohort. Complete the normal product/source/generated/
native/build contracts and full portable suite before delivery. Re-run affected
real browser lanes on both backends and the emitted production app, retaining the
existing `backend-state`, `backend-metadata`, query/FIFO, editing/alignment,
image/storage, idle, capability-refusal, fallback and lifecycle oracles. Production
coverage uses public journeys; deliberate private source injection remains in
the development lane, with both scopes named.

Add changed-view/capture interleaving, source/target-mask updates during sort,
FOV/resize/revision-only redraws, large-tile cancellation, held worker completion,
pressure eviction and context-loss cache invalidation. No stale projection/order,
pixel-origin change, source-ID mismatch, history change or early lease release is
an acceptable performance tradeoff. Sorted support without optional float/MRT,
parallel-compile or timestamp features is a release gate.

Keep only changes that show improvement above run-to-run variation in the named
target workload, with no material regression in other sorted operations. Report
cold maxima separately; compare median and genuine tail distributions, input
latency, sort/projection counts, quality and logical peak/retained memory. GPU
timing and physical memory are unavailable unless actually instrumented.
Record exact source/build/browser/OS/GPU/extensions/limits/context/flags. Preserve
old receipts. No universal FPS target or other-platform/native qualification is
claimed by this plan.

## Implemented packet

The original plan above remains the acceptance checklist. No settings, defaults,
product registrations, source locks, native interfaces or history owners changed.
The runtime packet currently implements:

- P0: opt-in worker queue/compute/transport timing, GL draw timer queries and
  bounded fixture counters; 120 motion plus 120 fixed frames in each mode,
  three independent repetitions, separate count/SH/resolution/DPR cases and
  trusted wheel events through the actual App observation adapter. WebGPU
  timestamps and physical presentation remain explicitly unavailable.
- P1: exact resident FP32 depth-row/geometry/source keys on both backends. GL
  also keys selected transform targets by their immutable generation. Its
  installed order texture serves ordinary display, fallback and clean capture;
  captured-view overwrite is followed by a checked live-view restore. GPU
  conservative mask dirtiness remains because its order packs state bits.
  Worker-owned radix scratch has an independent bounded lease, pinning, pressure
  retirement and terminal acknowledgement. The App accounts this retained cache
  in the renderer category through an internal admission callback; active jobs
  keep their existing work credits. Transferred outputs are copies,
  never the retained scratch. Last-scene removal/worker termination retires it.
- P2: a display completion checkpoint records actual submission/epoch identity.
  The App retains its single drawing guard until that checkpoint; full finish
  still joins unrelated queries/retirement. Pure GL query waits use the existing
  worker without holding the GL tail; obsolete geometry/view work is cancelled
  through acknowledged worker cancellation. GPU disposal joins pending pick
  preparation. Dense tile merge sorting yields within a single large tile.
- P3: four indexed quad vertices on both sorted Gaussian paths, preserving the
  two original triangles. GPU projection reuses the resident record only for
  the same scene generation and all 80 canonical uniform words. Captures also
  replace that resident identity. GL retains full-precision vertex projection.
- P4: program-owned uniform/block/sampler caches and batched asynchronous GL
  preparation. KHR parallel compilation is optional and checks link success
  after completion; cancellation/context loss discards pending generations.
  Optional Steady preparation leaves sorted display available.
- P5: GL projection uses job-owned scalar covariance scratch with the original
  f32 operation order. Picks sort only exact contributing pixel candidates,
  preserving every occluder and the existing strongest-contributor exit/ties.
  Large GPU picks use conservatively compacted candidates in the original
  front-to-back order; admission/preparation refusal keeps the exact baseline.
  Complete surface candidates and all-fragment composition remain unchanged.
- P6: Gaussian GL capture allocates a color-only target and releases it after
  the joined readback. PLY keeps its depth attachment. This removes 4 logical
  bytes/pixel from Gaussian capture scratch; owned image bytes remain separate.

A more frequent shared fence-poll prototype was measured, then discarded: it
increased wakeups without reducing the roughly 31 ms GL completion floor. It is
absent from the delivered runtime. Early instrumentation observed about 0.24 ms
of Gaussian raster GPU time at the base viewport, versus about 12 ms of repeated
worker sort and 18 ms of completion wait. This does not justify adding a GL
transform-feedback/buffer-to-texture projection path to this configuration.

Additional retained projection/order caches and capture/readback/noise pools
remain conditional experiments from the plan, not shipped claims. The existing
selection-map cache already owns native-map reuse; a second 48-byte/source worker
projection cache would add about 12 MiB for Bench before its masks/keys, while
exact pick candidate/scalar work already reduces query cost. Existing transient
capture targets and per-generation noise retain straightforward cancellation and
retirement. Keep these representations until a separate measured packet proves
an end-to-end improvement with their additional leases/transfers. The 224/136
bytes/pixel Steady authorities are unchanged. First-draw warmup is also omitted
without evidence of an additional useful admitted warmup pass.

Final checks pass: 6,426 portable cases in 205 files, 165 focused selection
cases, 40 build-tool cases, both TypeScript projects, pinned source/native/
generated/product gates, the 128-case GL lane, 126 maintained GPU selection
cases, 72 GPU editing/Steady cases, 52 applicable GL output cases and 55 GPU
output cases. A further 47-case lane validates the final opt-in diagnostic hooks.
Each backend passes the 40-case emitted public production cohort. Cohorts overlap
and must not be summed as unique tests; required cohorts have no retries/skips.

Eight image fixtures directly intercept WebGPU allocation/readback objects.
Their assertions remain unchanged in the GPU lane; GL uses its genuine held
readback/Close/loss lifecycle fixtures and the 52 applicable shared output cases.
A retained diagnostic records the initially unfiltered GL invocation. Other
resolved diagnostics include missing GPU mock methods, an idle cache initially
charged as active work, and a fixed-delay shader-readiness fixture. Assertions
were retained; the cache now has a renderer lease and readiness is observed.

## Final evidence and requirement audit

[Validation receipt](../../docs/validation/runs/rendering-optimization-20261025-01/validation.json),
[matched performance report](../../docs/validation/runs/rendering-optimization-20261025-01/performance.json),
[stage observations](../../docs/validation/runs/rendering-optimization-20261025-01/stage-observations.json)
and [production artifact closure](../../docs/validation/runs/rendering-optimization-20261025-01/artifact-closure.json)
bind current source, exact configuration, raw observations and checks. Historical
receipts remain unchanged. The emitted application input ID is
`0bfa965956f7f0e5094cabba8daf90c2d119e91ed3344dfb8a3c4bcefb66ed52`;
deployment ID is `eff94c0c130205f1fce05d56f0fb246a5b0d014e7816ef4dcbaa680b2420f963`.
There are 111 runtime artifacts, 116 distribution files and four owned maps.
This is local production-preview qualification, without remote publication.

| Requirement | Implemented behavior and authoritative evidence |
| --- | --- |
| P0: attribution and controlled repetition | Thirty baseline and thirty final renderer cases, 120 motion plus 120 fixed frames per mode, three fresh App/renderer/worker contexts per controlled count/SH/resolution/DPR case; six trusted App-input repetitions before/after. Six additional stage repetitions separate worker projection/candidates/radix/composition, ArrayBuffer transfer sizes, GL sampling/history/resolve/composite GPU timers, CPU upload/encoding, fence/wakeup and retirement wall intervals. WebGPU GPU timestamps and physical presentation/memory are explicitly unavailable. Driver caches are not claimed cold. |
| P1: exact resident order and leased scratch | Zero fixed-view sort jobs/order uploads on both backends, with zero redundant GPU projection dispatches. Actual GPU-buffer/GL-texture order readback covers revision/FOV/grade, captured-view overwrite/live restore, selected transforms and failure before publication. Unit and browser holds prove pinning/trim/worker-terminal retirement; pressure evicts optional scratch and retries baseline admission. |
| P2: display and cancellation ownership | One App drawing guard, one backend submission owner and actual submission/epoch completion checkpoints. Full completion still joins queries/retirement. A real GL map terminal can remain held while eligible display completes; full finish remains pending. Dense merge-sort cancellation, real readback/allocation holds, loss and pending GPU-pick disposal retain their credits. The unhelpful poll prototype is absent. |
| P3: projection and vertex work | Four indexed vertices preserve both original triangles. Full canonical GPU projection keys and actual resident order survive offscreen interleaving. Independent SH0-3 render/map oracles, exact sample metadata/ties and readonly PLY cases pass. Measured GL raster cost does not establish vertex projection as the dominant cost, so the conditional transfer/MRT prototype is not shipped. |
| P4: programs and bindings | Linked-program uniform/block/sampler caches and batched asynchronous GL preparation. Actual extension-absent startup, sorted display during optional preparation, automatic fallback/canvas replacement, state generations and loss pass. No additional first-draw warmup is admitted without measured justification. |
| P5: exact queries | Job-owned scalar f32 projection; complete exact pick candidates on GL and conservative stable GPU compaction with exact baseline refusal. Actual SH0-3/radius/tie comparisons preserve IDs and numerical outputs; full maps retain every fragment and full-frame visibility. Native selection, editing, preview and Undo/Redo lanes pass. Optional extra worker projection/color caches are not required by the plan and are omitted for the recorded memory/ownership tradeoff. |
| P6: transient memory | Actual Gaussian GL capture avoids a depth renderbuffer, reducing its logical scratch by four bytes/pixel; geometry keeps depth. Image credits survive genuine readback/encoder/storage/clipboard/Close boundaries. Optional extra capture/noise pools are omitted without evidence of useful total-latency benefit. The 224/136 bytes/pixel Steady authorities are unchanged. |
| Product/source/default contracts | Bundle 2.0.0 digest and 133 registrations remain fixed; no new UI/API/CLI command, format, profile migration, setting or tutorial. Existing native/WASM/toolchain locks, maps, worker policy, typed actions, automatic fallback and sorted default remain valid. |
| Final source and production | Frozen source hashes match the emitted application descriptor. Source/native/generated/product verification, 6,426 portable tests, focused selection, both typechecks, 40 build-tool tests, production build, exact artifact/source-map closure and 40 public production cases per backend pass. |

For original Bench SH3 (262,556 sources, physical 320x200, DPR1), the final
isolated median observations are:

| Operation | Baseline ms | Final ms |
| --- | ---: | ---: |
| GPU sorted pick | 51.5 | 5.4 |
| GPU pick while Steady display is selected | 49.2 | 3.8 |
| GL sorted pick | 148.1 | 45.2 |
| GL pick while Steady display is selected | 117.0 | 38.5 |
| GL sorted raw map | 183.8 | 124.2 |
| GL raw map while Steady display is selected | 159.4 | 108.3 |
| GL clean capture from sorted display | 268.2 | 8.7 |
| GL clean capture from Steady display | 272.5 | 268.3 |

Query/capture medians use one separate observation per repetition, three total;
they are not 360-query estimates. Frame series contain 360 motion and 360 fixed
samples per matched case/mode. Clean captures always use exact sorted output.

GL frame completion remains approximately 31 ms, and trusted App wheel-to-GPU
completion remains approximately 67.3 ms median. GPU App input median remains
approximately 4.2 ms. This packet does not claim a general FPS/input-latency gain.
The measured gains concern exact queries, clean sorted capture and removed
redundant work. Stage timing observes a roughly 0.23 ms sorted Gaussian draw at
the base viewport; it does not measure physical presentation. GPU compact picks
add optional admitted scratch of `8 * count + 4 * (ceil(count / 256) + 1)` bytes;
refusal uses the unchanged exact pick. Logical peak memory and remaining costs
are reported per fixture, without claiming physical driver memory.

No required work from this packet remains. Other browser/OS/GPU/security-context
and native/installed-provider qualification remains separate as decided above.

## Planning validation (retained preimplementation record)

This review reads current sources and retained receipts; it runs no new rendering
benchmark and claims no new optimization result. Product-bundle verification and
documentation whitespace/link checks are recorded with the handoff. Rendering
implementation, registrations, source/toolchain locks, generated assets and
existing pinned feature reviews remain untouched by this planning packet.

Actual planning checks:

- `python -B contracts/product/tool.py verify --root .`: valid bundle 2.0.0,
  133 registrations; native qualification remains separate.
- Ten reviewed source identities match delivery receipt 02 or unchanged HEAD
  shaders. No historical receipt was rewritten.
- Thirteen Markdown links parsed; local targets resolve. The new document has
  no trailing whitespace; `git -c core.whitespace=cr-at-eol diff --check` passes.
- No new runtime/GPU tests were run for this documentation-only packet. Future
  implementation must complete the gates above; retained timings stay historical.
