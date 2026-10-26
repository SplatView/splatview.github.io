# Feature review: reusable browser Gaussian renderer

Status: implemented and locally qualified, October 25, 2026. Qualification is
recorded below; the separate follow-up gaps remain explicit.

## Intent and existing behavior

The user requests a reusable standalone WebGPU/WebGL2 module for other browser
apps, together with a review of the current rendering implementation. This is
the browser provider surface of `view.render`. Base commit:
`fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2`, plus the retained implementation and
[optimization delivery](../../docs/validation/runs/rendering-optimization-20261025-01/validation.json).
That receipt and its review remain historical, immutable evidence.

Read the shared development product contract and feature-review template, README,
WEB_PORT_PLAN, IMPLEMENTATION_STATUS, capability ledger and approved UI differences.
The build consumes the reviewed local product bundle 2.0.0, manifest SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`, pinned by
`contracts/product-adapter.json`. Sibling sources are documentation references.

Expose the existing renderer through an independently built ES module and worker,
with typed matrix/camera inputs. Hosts supply already packed SH0–3 Gaussian data
or the existing geometry descriptor. Hosts retain loading, camera controls,
history, resource admission, animation scheduling and persistence. Rendering,
query cancellation, GPU submission, worker execution and retirement retain their
existing owners. No second controller, scheduler or history system is introduced.

The API supports sorted display, opt-in SteadySplats with sorted fallback, exact
picks/maps and clean capture through the existing kernels. Startup `auto` tries
WebGPU then WebGL2; a claimed canvas requires the host's replacement callback.
Device-loss recovery remains explicit and pinned to the selected backend.
Scene/image/map owners must be retired before disposing the renderer. Worker
initialization failures reject creation and terminate the executor.

## Platform support decision

| Target | Policy and reason | Adapter/condition/fallback | Evidence and implementation/qualification |
| --- | --- | --- | --- |
| Windows editor | Required existing rendering; standalone browser embedding is conditional on the browser host | Native D3D11 owner stays in `../SplatPreview/src/renderer.hpp`; browser uses the ES module | No native change or native qualification. Existing browser implementation will be exercised on the local Windows Chromium/GPU. |
| macOS editor | Required existing rendering; browser embedding conditional on capabilities | Native Metal owner stays in `../splatview_macos/src/render/render_frame.cpp`; browser WebGPU then supported WebGL2 | No native change. Safari/Chrome/Apple GPU execution remains unobserved, not excluded. |
| Ubuntu editor | Required existing rendering; browser embedding conditional on capabilities | Native Vulkan owner stays in `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`; browser WebGPU then supported WebGL2 | No native change. Linux browser/GPU qualification remains unobserved. |
| Web-lite and other browser hosts | Conditional on secure-context WebGPU or the existing WebGL2 precision/integer-texture/unit checks, workers, CSP and admitted resources | Independent module/worker; exact sorted rendering is the default. Optional Steady additionally needs float targets/four MRT attachments and more units; it falls back to sorted when unsupported or over budget | Implemented and locally qualified on the recorded Windows Chromium/GPU, without SplatView bootstrap, React, native WASM or a document worker. Other configurations remain unobserved. |

Windows Explorer preview, macOS Quick Look, GNOME preview, KDE preview and native
thumbnail providers do not import these browser modules; each retains its existing
host policy. No shell/thumbnail extension is changed or qualified. A browser-local
capture does not update OS thumbnails or prove disk persistence.

## Existing and new contract coverage

Surfaces: named provider API `src/engine/index.ts` and a plain browser example.
There is no new application typed action, native command, setting, codec, file
format or CLI command. The renderer provider consumes the existing `view.render`
contract; it cannot dispatch native editing or bypass app worker policy. Existing
133 application registrations and their reviewed bindings remain authoritative.
The SDK build script is a development tool, not a product CLI. No UI placement,
localization, icon or tutorial change is needed for this API-only surface.

Keep the application's verified deployment/worker loading and full build-descriptor
handshake in an explicit application host adapter. The standalone worker uses its
own source identity and protocol handshake. Moving loading policy must not relax
the app artifact hash checks or native/WASM contracts. Source and toolchain locks
are preserved; no frozen sources or generated assets are refreshed from siblings.

Coordinate inputs retain the current column-major right-handed view matrices,
WebGPU canonical depth [0,1], physical framebuffer pixels and packed native
Gaussian format. The module has no document/dirty/history effects, source overwrite,
agent server, file picker or persistence. Admission hooks and explicit result
disposal remain part of the host contract. CPU geometry/layout/encoding are kept
apart from GPU lifecycles; existing query and retirement owners remain intact.

## Independent review lanes

Scope: renderer module/package, fix mode. Code and design lanes were inspected
separately, then reconciled. No deceptive product flow is added by this packet.

1. Design, high confidence, medium severity: worker startup depends on app-wide
   initialization. Evidence: `src/renderer/webgl2/computeClient.ts:47`,
   `const runtime=await ensureRuntime(); let blobUrl:string|undefined;`.
   Corroboration: `src/build/runtime.ts` requires the verified app entry and native
   deployment closure. This prevents independent embedding. Fix: inject an owned
   executor factory and move verified app loading to an app adapter; keep the same
   compute client and cancellation/retirement protocol.
2. Design, high confidence, medium severity: the renderer camera contract names
   an app/native camera controller. Evidence: `src/renderer/frame.ts:4`,
   `export type RenderCamera = Pick<CameraController,`.
   Corroboration: `SceneRenderer.render` and capture signatures require that class.
   Fix: a structural matrix-only input contract accepted by the existing controller.
3. Code/performance residual: dense surface composition, retained optional scratch
   under query admission pressure and unbounded GL program-preparation waits need
   separate targeted evidence before changing exact query or startup behavior.
   These are candidates, not confirmed correctness findings in this review.

Large GPU renderer methods were inspected but are not classified as defects by
line count. Splitting their submission state without evidence would increase
ownership risk. No recurring anti-pattern or dark-pattern claim is made.

## Validation and handoff

Planned acceptance: independently build and load the ES module under a nested URL;
exercise both real backends, automatic fallback, all SH degrees, sorted display,
Steady transition, exact picks/maps, capture and disposal. Observe network requests
to prove absence of app bootstrap/native WASM. Test worker identity rejection and
failure cleanup. Re-run app browser numerical/lifecycle/fallback checks, typechecks,
portable tests, product/source/native/build gates and the production app build.

Preserve prior measured limitations: GL completion/input latency and Steady clean
capture remain expensive; WebGPU/WebGL2 do not have universal hardware/OS/browser
qualification. This module extraction claims no new rendering speedup.

Final commands, actual environment, failures and source/artifact digests will be
recorded in a separate `standalone-renderer-20261025-01` validation packet. Missing
platform evidence remains an explicit qualification gap, not a browser restriction.

### Implementation review amendment: shutdown

The first independent browser run reached sorted/Steady rendering, exact queries
and matching clean capture on SH0–3 on both backends. Its eight zero-credit
shutdown assertions failed: 1,736,944 bytes on GPU and 2,818,288 bytes on GL were
still retiring immediately after synchronous renderer disposal. This is not
evidence of a permanent leak; the existing disposal contract starts retirement.
Evidence: `src/renderer/webgpu/renderer.ts`, `this.steady.dispose();`, followed by
asynchronous owner retirement. The new host needs an awaitable completion boundary.

Add provider API `SceneRenderer.close(): Promise<void>` to dispose and join the
existing backend retirement owners, including optional preparation. Scenes and
borrowed outputs remain host-owned and must be retired/joined first. Keep existing
synchronous app disposal behavior. This is the third high-confidence, medium
severity modularity fix. No new submission, scheduling or history owner is added.
Also split pure geometry layout validation from the native-summary adapter so
standalone type declarations do not pull in native/document command contracts.

## Final gap review and follow-up plan

The following are source-backed follow-ups, separate from the completed module
extraction. None establishes incorrect numerical rendering or a permanent leak.

| Priority / confidence | Evidence and impact | Focused next step and acceptance |
| --- | --- | --- |
| Medium / high, code responsiveness | `src/renderer/webgl2/queryCompute.ts:87`: `for(let i=0;i<count;i++) {`; line 99: `if((y&7)===7) await checkpoint();`. Exact surface composition checks cancellation between groups of rows, without an inner fragment checkpoint. A dense short map can delay cancellation and the next worker job. Actual worst-case latency is unmeasured; host currentness checks still prevent stale publication. | Add a bounded fragment checkpoint without changing accumulation order. Test cancellation after tile sorting in a one-row, densely overlapping map; verify terminal acknowledgement, credit retirement, next queued sort and identical uncancelled outputs. |
| Medium / high, resource policy | `src/renderer/webgl2/renderer.ts:355`: `check(); const release=this.admitWork?.(checkedBytes(scene.count,67)+320+65536)`; line 370: `check(); const lease=options.admit(retained+scratch);`. Query admission does not evict the optional retained sort cache before refusing work. Rendering sort admission already has an acknowledged pressure fallback. This is an admission/headroom gap, not unaccounted memory. | On initial query pressure, retire optional scratch and retry admission before enqueuing the query. Candidate-admission pressure needs an explicit FIFO-safe design: do not wait for a trim queued behind a worker query waiting for admission. Test budgets fitting the exact baseline but not baseline plus optional cache. |
| Low / high, startup lifecycle | `src/renderer/webgl2/programPreparation.ts:26`: `while (programs.some(program => !gl.getProgramParameter(program, parallel.COMPLETION_STATUS_KHR))) {`. Polling checks context loss/generation, but initial renderer creation has no program-preparation deadline. The worker handshake's 45-second deadline does not bound a stalled driver compile. No actual stalled-driver observation is claimed. | Add a bounded/cancellable initial preparation policy, with cleanup and a useful startup error. Hold the optional completion flag in a browser fixture; verify no published renderer, retained worker, programs or shaders after termination. Evaluate the corresponding WebGPU startup policy separately. |

Retained performance limits are measured in the previous optimization receipt:
ordinary GL completion remains about 31 ms on that local configuration and Steady
clean capture remains expensive. This extraction does not claim improvements to
either. Re-measure a targeted follow-up using matched scenes, warm-up, repeated
samples and separate worker/GPU completion clocks. Mac/Ubuntu, Safari/Firefox,
other GPUs and restrictive hosting configurations remain runtime qualification
gaps. Missing observations do not change product support policy.

Coverage: code and design reviewed; three primary modularity fixes applied
(host loading, structural inputs/pure layouts, awaitable shutdown). The example's
single scheduler now retains requests received while an earlier completion is
pending. Large cohesive GPU methods were investigated without a line-count smell
finding. No recurring anti-pattern was established. Deceptive UX review is not
applicable to the provider API; the small example has transparent backend and
Steady controls. Broader product UI flows were covered by the retained app tests.

## Delivery evidence

The [validation packet](../../docs/validation/runs/standalone-renderer-20261025-01/validation.json)
binds final source hashes, both build manifests, commands, compressed original
test reports, environment and retained diagnostics. It does not replace earlier
receipts. No existing registration or review pin was refreshed.

Observed: Windows, Chromium 156.0.8078.4, NVIDIA RTX 5090 (GL ANGLE/D3D11),
Node 24.21.0. Browser runs use localhost and `--enable-unsafe-webgpu`, with secure
context true and cross-origin isolation false. The independent static SDK host
uses a nested URL and CSP `default-src 'self'; script-src 'self'; worker-src 'self';
connect-src 'self'`. Network assertions exclude app/source/React/WASM/document-worker
requests. This does not qualify different OS/browser/GPU/security configurations.

Final passing lanes (overlap; do not sum as unique test coverage):

- 6,436 portable tests in 206 files; 165 focused selection tests are a subset.
- 13 standalone production browser cases: both APIs, SH0–3, automatic fallback
  before/after canvas claim, forced-backend rejection, automatic rest convergence,
  delayed-completion scheduling, exact picks/maps, clean captures and zero-credit
  async close. An isolated TypeScript consumer passes without ambient app/Vite,
  React, native or WebGPU type dependencies.
- 82 app rendering/geometry/numerical/fallback/lifecycle cases and 126 maintained
  selection browser cases.
- 54 GL output/editing cases and 60 GPU output/settings/web-lite cases. Eight
  existing fixtures that intercept GPU allocation objects remain in the GPU lane;
  the GL lane uses the genuine corresponding GL lifecycle tests, not weakened
  GPU assertions.
- 40 public production app cases on each requested backend. Source-module/private
  controller injection fixtures remain in their development cohorts.
- Product bundle/inventory (133 registrations), pinned sources/assets/translations,
  native build provenance, both typechecks, 40 web-build tests, both production
  builds and exact artifact/source-map ownership checks pass. The main build keeps
  its existing large-chunk advisory. The SDK output-directory negative check
  rejects an unexpected target before mutation.

The first SDK run's eight shutdown-credit assertions exposed the missing async
close boundary; the first automatic-frame cohort exposed one dropped frame request.
Both diagnostics are retained and the final 13-case cohort passes without retries.
One production GPU run had a pre-startup fetch failure: its trace reports
`Failed to load resource: net::ERR_NO_BUFFER_SPACE` for the main application entry.
After stopping owned development servers, the unchanged source/build was rerun;
all 40 cases passed. The failed report, extracted console event and final outcome
are retained in the packet; the rerun replaced Playwright's temporary trace ZIP,
so that original archive is not retained. No runtime
retry, timeout increase or assertion relaxation was added for that observation.

Remaining work is the focused follow-up table and external platform/hosting
qualification. The requested standalone module and review are complete; none of
the follow-ups is advertised as implemented or universally optimized.
