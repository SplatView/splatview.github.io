# Reusable browser renderer

Run `npm run build:engine` with the repository's locked Node toolchain. The
independent `dist-engine/` output contains `splatview-renderer.js`, its worker,
TypeScript declarations, a private package descriptor, source maps and a plain
example. Serve that directory over HTTP on localhost or HTTPS, then open
`example/`. The same directory works under a project subpath. Keep the worker's
relative location when copying the module. This does not publish an npm package.

| Module | Responsibility |
| --- | --- |
| `src/engine/index.ts` | Public browser API and standalone worker factory |
| `src/renderer/contracts.ts`, `frame.ts`, `defaults.ts`, `geometryLayout.ts` | Shared typed inputs and pure frame/layout validation |
| `src/renderer/factory.ts` | Backend negotiation and explicit canvas replacement |
| `src/app/renderCompute.ts` | SplatView-only verified artifact loading and full app/native identity |
| `src/renderer/webgl2/computeClient.ts`, `computeExecutor.ts` | One worker transport/executor, admission acknowledgements and cancellation |
| `src/renderer/webgpu/`, `webgl2/` | Backend submission, GPU resources, display/query execution and retirement |

```js
import { createRenderer, ResourceLedger, estimateSceneBytes } from './splatview-renderer.js';

const renderer = await createRenderer(canvas); // auto: WebGPU, then WebGL2
const ledger = new ResourceLedger(128 * 1024 ** 2);
renderer.admitWork = bytes => ledger.reserve('work', bytes);
renderer.admitSortScratch = bytes => ledger.reserve('render', bytes);
renderer.admitSteady = bytes => ledger.reserve('render', bytes);
const credit = ledger.reserve('render', estimateSceneBytes(count, degree));
const scene = await renderer.allocateScene(count, degree);
await scene.upload(0, count, ownedPackedBuffer);
await renderer.render(scene, camera);
await (renderer.displayCompletion()?.done ?? renderer.finish());
// Later: join borrowers and retire their owned image/map outputs first.
await scene.dispose();
await renderer.finish();
await renderer.close();
credit();
```

The runnable example contains error cleanup and animation scheduling. A host that
offers geometry, histogram or image output must also supply the corresponding
admission hook or operation admission function. `ResourceLedger` measures logical
reservations, not physical GPU/driver memory. `estimateSceneBytes` is the existing
conservative Gaussian storage estimate; transient queries, upload buffers, CPU
source retention, Steady targets and framebuffer size need their own credits.
`scene.allocationBytes` covers the base mirror. Optional compaction/sort storage
already has separate admission; do not add it again to base native/mirror coverage.
Apply your own dataset/framebuffer limits before allocation.

The host supplies a `RenderCamera`: `Float32Array` view[16], projection[16], eye[3],
numeric revision and `black`, `gray` or `white` background. Matrices are column
major, right handed, looking down -Z, with canonical WebGPU depth [0,1]. Increment
revision when changing camera inputs. Framebuffer dimensions and query positions
use physical pixels, with query origin at the top left. Resize `renderer.canvas`
and render again; the module does not attach navigation controls or a resize loop.
Use `onFrameNeeded` to schedule another host frame for Steady preparation/history.

Packed records have byte stride `packedStride(degree)` for SH degree 0–3: ten
little-endian float32 values (center xyz, opacity, covariance xx/xy/xz/yy/yz/zz),
then RGB-interleaved binary16 spherical harmonics, padded to a four-byte boundary.
Positions/covariance use the same scene units. Upload chunks must match their
record count and stride. Treat upload buffers as consumed on success; WebGL2
transfers them to its executor. Scene masks are the existing 0–3 state bytes
(bit 0 selected, bit 1 cleanup-hidden). `stageMasks`/preview operations keep their
explicit publish/retirement ownership. Loading PLY/SOG/SPZ and applying edits stay
with the host; this module includes no codecs, document/history or native WASM.

All existing sorted paths share the same implementation: Gaussian display,
geometry display, selected previews, exact pick/map queries and clean capture.
`setRenderSettings({ ...DEFAULT_STEADY_SETTINGS, mode: 'steady' })` opts into the
same SteadySplats logic on either backend. Unsupported projection/capabilities or
refused optional allocations use sorted display. Picks, surface maps and capture
retain their exact/clean contracts. Map/image results have `dispose()`; captures
accept an `ImageOperation` with admission and optional cancellation/currentness.
Surface admission returns a resizable `ResourceLease`; abort completion joins the
executor acknowledgement before releasing active work. Do not release a credit
while its operation or GPU retirement is pending.

`await renderer.prepareRenderMode('steady')` optionally compiles the shaders
before a user selects SteadySplats. It leaves the active mode, status and history
unchanged and allocates no optional frame buffers. Concurrent requests share one
preparation; failures reject and can be retried. The normal mode setter still
prepares shaders on demand, so warmup is optional. `prepareRenderMode('sorted')`
does no preparation. Handle a warmup rejection without changing a working view;
`close()` joins pending compilation. The app starts this warmup when General
settings opens for a Gaussian or empty view.

`preference` is `auto`, `webgpu` or `webgl2`; forced choices reject instead of
switching APIs. If a failed WebGPU attempt has claimed the canvas, `auto` invokes
the supplied `replaceCanvas(previous)` callback before WebGL2. The example shows
how to replace the DOM node. `onLost`/`onDeviceLost` report loss. Recovery is a host
operation: create a new canvas and renderer with `recoveryBackend` equal to the
old backend, then re-upload retained source. No document or automatic recovery
scheduler is created by the module. Stop scheduling, join operations, retire
scenes and results, then await renderer `close()` to join optional preparation and retirement. The
existing synchronous `dispose()` starts shutdown without awaiting it; neither
method is a scene owner.

WebGPU needs a secure context and compatible adapter. Sorted WebGL2 uses integer
textures and the existing fragment precision/texture-unit checks. Optional Steady
adds floating-point render targets, four MRT attachments and more texture units;
its absence retains sorted display. Both backends need browser workers.
CSP must allow module/worker assets from the deployment origin (`worker-src
'self'` for this standalone build). Cross-origin isolation is not required.
Self-host the complete output and serve JS with the proper MIME type. The worker
handshake verifies its host kind, protocol and source digest. `engine-manifest.json`
lists output hashes for deployment checking; ordinary browser module fetching is
used. The SplatView app separately retains verified artifact fetching and its full
application/native build handshake. Neither build consumes live sibling source.

Local qualification covers the recorded Windows Chromium/GPU only. Other OS,
browser, GPU and restrictive hosting configurations need their own runtime checks.
The module extraction does not improve measured GL frame-completion latency or
Steady capture cost. Existing rendering attribution and PlayCanvas MIT notices
are included; this private build does not change the repository's licensing.

Display precision defaults to 32 bits. Pass `sortPrecision: 24` to `createRenderer`
or assign `renderer.displaySortPrecision = 24` for faster interactive sorting;
16 bits is explicit opt-in and can cause larger overlap artifacts. Invalid
precision values reject. Small scenes below 2,048 sources keep exact ordering.
Picks, maps and clean captures always restore/use exact 32-bit keys. Quantization
changes order only, never packed source data.

`interactiveDisplayPrecision(previous, current)` returns 24 when the same
owner/scene/camera changes revision and 32 otherwise. A host adopting it must
schedule an exact refinement after motion stops. SplatView's controller does so;
the standalone factory does not introduce a scheduler. `DisplayFrameAdmission`
can track up to two actual matching display checkpoints and blocks changed
owner/scene/viewport metadata until they finish. Keep CPU preparation serialized,
track only a newly submitted checkpoint, and wait on its actual `done` promise.
This helper does not submit, schedule, cancel, or retire resources.

WebGPU scenes of at least 262,144 sources may reserve approximately eight extra
bytes per source plus scan/metadata storage through `admitSortScratch`. They
sort using the portable radix, then compact exactly the projector's visible
entries into a private indirect draw list. Scene retirement owns that credit;
refusal/failure retains full drawing. This saves raster work for sparse views
and adds a small compaction cost to dense exact views. See the
[throughput packet](../validation/runs/rendering-throughput-20261025-01/validation.json)
for measured scope, quality and limitations.

WebGL worker sorting uses bounded synchronous key/count/scatter kernels, skips
uniform digits and uses exact counting when the requested key span fits its
histogram. The permutation, float32 math, precision and stable ties are unchanged.
Retained display scratch uses `12 * count + 1024` bytes below 65,536 sources and
`12 * count + 262144` bytes at or above that threshold, within the same 16 MiB cap.
Host admission and worker allocation share `webgl2/sortScratchLayout.ts`.
Refused optional storage uses the transient 256-bin radix/counting path; exact
queries keep that smaller allocation. Cancellation and retirement remain owned
by the existing serial executor. See the
[matched benchmark](../validation/runs/webgl-sort-20261025-01/README.md):
43–75% lower worker round-trip medians in the measured configurations, with
48 byte-identical before/after snapshot pairs. These clocks exclude the app's
separate fence-polling/presentation behavior.
