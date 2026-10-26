# Feature review: view.render — opt-in SteadySplats

## Intent and existing behavior

Reviewed October 25, 2026 in the web workspace, starting at clean revision
`fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2`. This review amends the existing
`view.render` family. The local product bundle remains 2.0.0, manifest SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`, pinned by
`contracts/product-adapter.json`. The shared development contract and its feature
template were read from `../SplatPreview/design/`; no sibling inputs enter a build.

The user requested the renderer in PlayCanvas engine PR 9819. Its reviewed head
is `12542cf99f2b2b23c7e84c6602f8b5e537e74e73` (draft). Adapt its per-primitive
spatiotemporal blue noise, four-neighbor PDF resampling, four distinct foreground
occluder history, motion reprojection and stationary refinement to this renderer.
Keep SplatView's covariance, SH/grade/opacity, support cutoff and highlight rules.
This is a rendering change, with no model training or model-format conversion.

The sorted renderer remains the default. Settings / General offers an opt-in
Gaussian rendering choice and history/convergence settings. These are viewer
session preferences, independent of document history, dirty state, saved views
and source files. Capture, clipboard and remembered-view images keep the clean
deterministic renderer; selection, contributor picking and surface queries keep
their exact sorted semantics. Explain the clean capture behavior in Settings.
No agent server, public API, CLI, source-overwrite command or new tutorial target
is added. The existing Settings lesson remains applicable. Register both render
mode values explicitly against `view.render` in the local adapter and regenerate
its projections; do not reseal or refresh the shared bundle.

## Platform support decision

| Target | Policy and reason | Adapter, conditions and fallback | Source evidence and remaining work |
| --- | --- | --- | --- |
| Windows editor | Conditional: optional renderer improvement is within viewing scope | D3D11 stochastic visibility and reconstruction require a native adapter; retain sorted rendering | Current `../SplatPreview/src/renderer.hpp` owns preparation, sort and retirement. No native implementation or qualification is claimed; implement and test its native adapter separately. |
| macOS editor | Conditional: same viewing capability; Metal is not a product exclusion | Native GPU admission and temporal resources; sorted fallback | Current `../splatview_macos/src/render/render_frame.cpp` retains stable source-ID ordering and native alpha cutoff. Metal integration and actual Apple runtime tests remain gaps. |
| Ubuntu editor | Conditional: same optional viewing capability | Vulkan visibility/reconstruction resources and render demand; sorted fallback | Current `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp` owns GPU projection/radix sorting, memory and display; `src/ui/render_demand.cpp` owns scheduling. Native adapter and Linux runtime tests remain gaps. |
| Web-lite | Conditional: supported Gaussian viewing, perspective/full viewport, admitted WebGPU resources | Adapt existing projection to stochastic depth-tested visibility; four-neighbor reconstruction and temporal refinement. Unsupported projections, non-Gaussians, allocation refusal and initialization failure use existing rendering | `src/renderer/webgpu/renderer.ts`, `splats.wgsl`, `frame.wgsl`, controller render demand, resource ledger and browser tests. Implementation and observed-host evidence recorded below. WebGL remains a separate excluded compatibility profile. |

Explorer preview, Quick Look, GNOME preview and KDE preview are conditional for
this optional rendering technique, with their existing renderer as fallback and
their own lifecycle/deadline/admission requirements. They gain no controls from
this web change; native integration and qualification remain explicit gaps.
Thumbnail providers exclude temporal refinement in this packet: one-shot bounded
deterministic output remains the provider contract. Browser-local saved views
do not modify operating-system thumbnails.

## Existing and new contract coverage

Preserve source/toolchain/native locks, WASM ABI, worker/codec budgets, typed
actions, selection controllers, history owners and frozen assets. Existing
`docs/parity/capabilities-v1.json` rendering/picking, selection surfaces, histogram,
capture and resource gates remain applicable, as do the approved UI differences.
No old capability receipt is rewritten as new qualification.

Pure render settings, frame identity/convergence and resource planning belong in
separate modules. GaussianRenderer retains submission/publication ownership;
the SteadySplats resource owner performs checked asynchronous allocation and
queue-fenced retirement. Reserve full overlapping old/new allocations through
the controller's existing render ledger. Refusal keeps the document usable and
shows sorted fallback. Device loss/replacement cannot publish stale resources.
Resize, scene/source/mask, color, opacity, transform, highlight, background and
projection changes invalidate reconstruction; ordinary camera motion preserves
reprojectable color history while restarting stationary averaging. Queries and
captures cannot contaminate display-history identity. Stop requesting frames
after convergence; respect the controller's existing hidden-tab policy.

Settings controls use existing compact rows, labels, translated text and modal
keyboard ownership. Temporarily unavailable rendering reports a reason. There
is no new shortcut, icon, permission prompt or persistence claim. No new lesson
is needed for this optional Settings preference.

## Validation and handoff

Planned checks: product verifier and regenerated bindings, source/generated/native
integrity, both typechecks, relevant renderer/controller tests, full CPU suite,
production build, analytic real-WebGPU rendering tests (transparency, overlap,
history invalidation, motion, refinement, fallback, resize/retirement and exact
picking), and current Basic production journeys. Record actual browser, OS,
adapter, security context, failures and test scope before handoff. Portable tests
alone do not qualify rendering. No remote deployment or native-port qualification
is implied by this change.

## Implemented result and observed checks

`steadySettings.ts` defines the session settings. `steadyState.ts` owns pure
display identity, matrices, convergence and framebuffer planning. `steady.ts`
owns checked allocation, publication and queue-fenced retirement; the existing
GaussianRenderer/controller retain command submission and on-demand scheduling.
History buffers are striped when a device's storage-binding limit requires it.
Logical GPU resources total 136 bytes per framebuffer pixel, plus a 64 KiB STBN
texture and 240 bytes per stripe. This is resource planning, not physical VRAM or
whole-process capacity evidence. Both mode registrations explicitly bind to
`view.render`; local projections are regenerated and the sealed bundle unchanged.

The sorted default, sorted unsupported/over-budget fallback, exact lazy sorting
for contributor picks, independent selection-map computation and deterministic
clean capture are retained. Stationary reconstruction stops submitting new
samples after the selected refinement count; subsequent unchanged display
requests reuse the retained image. Histogram identity advances with actual
reconstruction samples. Ordinary camera motion retains reprojectable color
history and restarts the independent stationary average. Settings have all eight
language entries and preserve existing Settings focus ownership.

The completed CPU run passed **6,402 tests**, with no skipped cases. The initial
complete focused browser run passed **51 cases**, with no retries: SteadySplats
numerics/resources/fallback/device loss, Settings controls, Basic editing and
tutorial, geometry, histogram and product policy. Four analytic two-layer
fixtures reduced RGB mean-squared error from 53.66–60.45 on the first spatial
estimate to 0.399–0.477 after 256 refinement samples (8-bit channel units).
Retained-frame and sorted capture differences were zero; picks matched exactly.
These are bounded quality fixtures, not speed or general scene-quality claims.

The owned adapter identified NVIDIA Blackwell with `isFallbackAdapter=false` on
Windows Chromium 156, secure localhost, `crossOriginIsolated=false`. The created
device used core features only; no optional float filtering/blending was enabled.
No Apple, Linux/native editor, installed provider or deployed HTTPS qualification
is claimed. Final build checks, additional Bench-scene and production-browser
outcomes are recorded in [the validation record](../../docs/validation/runs/steady-splats-20261025-01/validation.json).

Retained diagnostics: the first full CPU run exposed six recovery fixtures
missing the new renderer-settings interface; their mocks were updated, without
changing their assertions. The first browser run exposed asynchronous canvas
snapshot clearing; the harness now copies the exact submitted WebGPU texture
before presentation. The failed reports remain in `.build/steady-splats-20261025-01/`.
Subsequent full runs above passed. The workspace-local Node 24 toolchain is used;
the initial bare `npm` invocation failed because Node was not on the shell PATH.
