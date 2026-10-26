# Feature review: rendering throughput and display precision

Reviewed October 25, 2026 before implementation; amended after measured candidate
comparisons and the user's explicit acceptance of a small quality drop for speed.
This supersedes this record's initial exact-display-only proposal. Runtime
qualification is separate from platform policy and is recorded in the
[delivery receipt](../../docs/validation/runs/rendering-throughput-20261025-01/validation.json).

## Authority and scope

Read the shared product contract and template, repository contributor instructions,
README, WEB_PORT_PLAN, IMPLEMENTATION_STATUS, capability ledger, approved UI
differences and selection ownership/validation guide. Builds consume the sealed
local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`,
through `contracts/product-adapter.json`; sibling sources are documentation
references, never build dependencies.

Base commit `fea86cfe91a52fe3f68cc5bb4cfedc5cebcb7db2` plus retained dirty work
qualified by the immutable [standalone receipt](../../docs/validation/runs/standalone-renderer-20261025-01/validation.json)
and [previous optimization receipt](../../docs/validation/runs/rendering-optimization-20261025-01/validation.json).
Preserve those receipts/reviews. This packet has its own before/after source
snapshots, artifacts, measurements and retained rejected-candidate diagnostics.

Feature `view.render`, application and standalone browser provider; WebGPU and
WebGL2; Gaussian sorted display/fallback, scoped previews, exact queries and clean
capture. Geometry and SteadySplats retain their algorithms. Sorted remains the
initial/default rendering mode. No new UI action/setting, native command, CLI,
format, persistence field, tutorial or product removal.

## All-platform and host policy

| Target | Policy and current capability evidence | Implementation/qualification |
| --- | --- | --- |
| Windows editor | Required existing native rendering. D3D11 owner: `../SplatPreview/src/renderer.hpp`. These browser optimizations are conditional on browser capabilities/resources. | No native change or new native runtime qualification. |
| macOS editor | Required existing native rendering. Metal owner: `../splatview_macos/src/render/render_frame.cpp`. Browser optimization is conditional; unsupported/refused optional resources retain the portable renderer. | No native change; Apple/browser execution remains unobserved. |
| Ubuntu editor | Required existing native rendering. Vulkan owner: `../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`. Browser optimization is conditional on current capabilities/resources. | No native change; Linux/native/browser execution remains unobserved. |
| Web-lite and standalone browser apps | Conditional on WebGPU or the existing WebGL2 integer-texture/precision checks, browser workers/CSP, secure context where required and admitted resources. Missing observations are qualification gaps, not browser restrictions. | Both backends implemented. Observed claims are limited to the delivery receipt's Windows Chromium/GPU/localhost configuration. |

Windows Explorer, macOS Quick Look, GNOME preview, KDE preview and native thumbnail
providers retain their existing host policy. Browser renderer internals do not
reach those providers or operating-system thumbnails. Browser-local saved views
and downloads retain their existing contracts; no disk-persistence claim, local
agent server, source overwrite command or agent-measurement UI/tutorial is added.

## Final behavior and API decisions

The application uses stable **24-bit depth keys while the submitted camera pose
changes**, followed by an exact **32-bit refinement when motion stops**. First
frames/new owners use 32 bits. Sorting below 2,048 sources remains exact. Source
records are unchanged; source-ID order resolves quantized ties. This affects the
registered `GaussianRenderMode.sorted` behavior and its sorted fallback, so that
binding explicitly pins this reviewed record. The other 132 bindings and their
historical reviewed identities are retained.

The standalone provider defaults to 32-bit precision. Its typed `sortPrecision`
option and mutable `displaySortPrecision` accept only 16, 24 or 32. Hosts may use
the exported pure `interactiveDisplayPrecision` helper to adopt the application's
motion/rest policy. Explicit 16-bit mode is available for hosts accepting larger
order artifacts, but is not the application's default: it failed the conservative
representative-view quality target. The target used to choose 24 bits was at least
40 dB PSNR and mean absolute normalized RGB error <= 0.002. Report mean, PSNR and
localized maximum error; the tested views do not establish a universal bound.
Near-depth/high-overlap stress cases can show larger changes and retain exact mode.

Exact picks, composited depth/opacity/raw-color/visibility maps and clean captures
always retain original data and 32-bit ordering. Full-order cache identity includes
precision; reduced display order cannot satisfy an exact query. WebGL's odd-pass
24-bit radix result is copied before transfer if it belongs to either retained
worker scratch array. Preserve the app's verified worker/full native identity and
the standalone worker's independent protocol/source handshake.

Host display admission allows at most two matching owner/scene/viewport submissions.
CPU preparation remains serialized. Slots release only after genuine completion,
including rejection; cached checkpoints are deduplicated. Changed owners/scenes/
viewports drain old work. An old completion cannot clear a new CPU drawing owner.
The helper owns metadata, not scheduling, submission, cancellation, retirement,
history or publication. The existing application controller remains the scheduler.
SDK hosts continue to own their scheduling and shutdown.

WebGPU retains the portable stable four-bit radix implementation. Six passes serve
24-bit display, four serve optional 16-bit display, eight serve exact output.
Optional draw compaction starts at 262,144 sources and removes only entries the
existing projector already rejects. A hierarchical GPU prefix scan preserves the
sorted permutation and full source IDs. The draw uses a GPU-produced indirect
instance count without CPU readback. A private compact buffer cannot overwrite the
complete query pairs. Canonical and divergent preview-mask replacement still goes
through the single staged base-order/project binding publication owner.

Additional retained buffers cost approximately eight bytes per source plus bounded
scan buffers/metadata. Reserve credit before allocation/compilation; the scene
holds it through genuine retirement. Unsupported limits, admission refusal or
optional preparation failure retain portable full drawing. Small scenes avoid
compaction overhead. Exact dense moving scenes can pay a small compaction cost;
record that regression alongside sparse-scene gains. No universal speedup is promised.

The initial compact-before-sort/indirect-radix prototype was rejected: dense and
small scenes regressed. Sorting first and compacting only the draw list measured
better. The serial-prefix/eight-bit prototype was also rejected. No vendor-specific
sort/subgroup feature or copied external implementation was introduced. Existing
PlayCanvas attribution/licenses remain. Inspection of PlayCanvas/COLMAPView is not
a matched external benchmark or evidence of equal performance.

## Ownership, compatibility and validation

Preserve controller/history/native/WASM/source/toolchain locks, generated assets,
worker/codec budgets, input and editing scopes, coordinate/packed layouts,
background processing, cancellation, genuine finish semantics and result disposal.
Queries restore full precision without advancing the public display/sample clocks.
Full and compact caches separately track their actual inputs and submission failure.
Optional scene allocations cannot escape the existing resource ledger or lifecycle.

Qualification includes source-stable matched before/after count, SH, resolution,
DPR, sorted/Steady and trusted-input cohorts; both APIs' 24-bit representative-view
quality; interleaved GPU pass clocks at sparse/dense visibility and multiple counts;
SH0-3/tie/order/pixel/pick/map/capture/scoped-mask regression; zero/all-visible and
resource refusal; held preparation/retirement; app motion/rest/idle; selection;
backend negotiation/loss/recovery; independent SDK and production output tests;
portable/type/source/product/native-build/asset gates and artifact hash closure.
The receipt records actual commands, pass/failure/skip counts, source/build identity
and retained diagnostic failures, separately from this required policy.

GPU timestamps cover opted-in test-only pass clocks. Queue/fence wall clocks and
trusted-input submission/completion are not physical presentation FPS. Logical
reservation totals are not measured driver memory. Native editors, preview hosts,
other OS/browser/GPU/security contexts and restrictive hosting remain separate
runtime qualification gaps. Do not advertise full cross-engine parity.
