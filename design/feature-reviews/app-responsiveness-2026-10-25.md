# Feature review: actual App camera responsiveness benchmark

Reviewed October 25, 2026 before implementation. The user approved measuring
actual orbit/pan/zoom responsiveness before deciding whether asynchronous WebGL
display ordering is useful. This slice adds internal measurement fixtures and
evidence; it does not change rendering precision, freshness or scheduling.

## Authority and scope

Read AGENTS, the shared cross-platform product contract and review template,
README, WEB_PORT_PLAN, IMPLEMENTATION_STATUS, capability inventory and approved
UI differences. Consume sealed local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
The sibling documents are development references; builds retain local pinned
inputs and never consume live sibling source. Existing registrations, source/
native/WASM/toolchain locks, worker budgets, generated assets and review pins
remain unchanged. Record dirty source hashes and frozen prior receipts.

Feature family `view.render`, internal developer/agent browser test surface.
No product UI/API/CLI, route, profile, format, tutorial, default or persistence
change. The browser-local benchmark uses the actual React App/controller,
bundled Bench SH3 scene, native camera input, renderer and completion fences.
Its existing e2e host is a development tool, not a web-lite local agent server.
No source-file write, scene edit, selection/history change or saved view is part
of the measured gestures. Do not advertise profile migration or native parity.

## Platform and provider policy

| Target | Policy, evidence and condition | Implementation/qualification |
| --- | --- | --- |
| Windows editor | Existing `view.render` required in the native editor (`../SplatPreview/src/renderer.hpp`); this browser instrumentation is conditional on the existing browser/worker/GPU and diagnostic test host. | No D3D11/native implementation change. Measure actual Windows Chromium separately. |
| macOS editor | Existing native rendering required (`../splatview_macos/src/render/render_frame.cpp`); browser measurements conditional on browser WebGPU/WebGL2/worker capability. | No Metal/AppKit change. Apple execution remains an evidence gap, not an exclusion. |
| Ubuntu editor | Existing native rendering required (`../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`); browser measurement conditional on browser/driver/worker support. | No Vulkan/native change. Linux execution remains unobserved. |
| Web-lite / browser provider | Conditional on current backend negotiation, secure-context/worker/CSP requirements, existing resource admission and opt-in e2e instrumentation. | Qualify observed OS/browser/GPU/flags/context explicitly; automatic backend fallback and exact output/query contracts remain. |

Explorer, Quick Look, GNOME/KDE previews and native thumbnail providers are
unaffected: the test fixture has no host integration or document persistence.
Browser saved views do not acquire OS thumbnail effects. Native measurement
policy and agent-only access remain unchanged; no public measurement lesson or
control is introduced.

## Measurement and ownership decisions

Extend coverage beyond the existing wheel-only and wheel-stream samplers.
Use trusted browser input for orbit, right-drag pan and wheel zoom. Run three
independent repetitions per backend on the same loaded source, viewport/DPR,
camera baseline and gesture trace. Report isolated action latency separately
from continuous streams, since coalescing intentionally has different semantics.

Capture immutable camera revision/pose at CPU render entry, confirmed actual
submission sequence at render return, and the existing display checkpoint's
real completion promise. Exclude pre-input poses from isolated latency; do not
use submit-observed time to assign an already-started draw to a newer input.
Measure input-to-entry, preparation/submission, fence wait, submission intervals,
input coverage/coalescing, pending display bounds and camera-pose age separately.
Physical presentation, physical dropped frames and driver memory are unavailable;
report observed rAF/submission gaps without renaming them FPS or dropped frames.

Bound all observations and join outstanding completions before restoring
fixture wrappers. Verify renderer/scene/camera owners, device epoch, framebuffer,
source count/degree and document revision; camera advancement is expected during
a stream and must not weaken production stale-query checks. Preserve the
controller's explicit owner of scheduling, cancellation, publication and history.
Do not force a GPU wait, issue extra display work or poll fences faster for timing.

Keep worker stage clocks/GL GPU timing diagnostics separate from the minimal
input sampler if their overhead materially changes timing. Record actual input
delivery cadence; Playwright command rate is not a physical input-device rate.
Failures, warm-up and rejected calibration runs stay in the new evidence packet.

## Validation and decision gate

Before timing, run both typechecks, the 133-registration local product gate and
existing source/native/generated/browser/build contracts appropriate to this
fixture-only change. Run timings sequentially without competing test/build/GPU
loads. Require expected complete samples, finite clocks, trusted inputs, changed
camera poses, bounded pending frames, exact 32-bit rest and eventual idle.
Retain raw reports, environment, source/build identity, trace/settings and
independent aggregation checks. Existing product browser/SDK qualification is
prior evidence, not a newly rerun cohort.

Use the results to choose the next implementation. A timer/presentation floor
alone does not justify asynchronous sorting; more frequent fence polling was
already rejected in earlier evidence. Propose bounded asynchronous ordering only
if current sort waiting is material, with explicit order-age bounds, newest-input
coalescing, owner guards and exact rest/pick/map/capture. Any actual freshness,
default or registration change needs an implementation amendment and binding
review before code changes. This record does not claim such a change is shipped.

## Observed result and next decision

All six accepted browser cases passed with no retries, skips or failures. They
contain 36 phases / 12 aggregate series, three independent repetitions per
backend, 6,480 measured trusted inputs and 288 warm-up inputs. Every measured
input had an observed subsequent changed camera pose. All phases returned to
exact 32-bit rendering and App idle; maximum observed pending displays were two
on WebGL and one on WebGPU. The WebGL-only calibration is retained separately.

On the bundled 262,556-source SH3 scene at 1280 × 800, DPR 1, WebGPU medians
were 4.2–4.4 ms input-to-fence, p95 4.7–6.4 ms. WebGL medians were
36.65–38.05 ms, p95 40.0–41.0 ms. WebGL worker round-trip medians were
5.0–5.6 ms; response CPU preparation was about 5.8–6.2 ms and post-submission
fence wait about 30.4–31.65 ms. Independently summarized stage medians do not
add to the median of the full path. WebGPU response fence medians were
3.8–3.9 ms. These are current-policy observations, not paired optimization or
physical-presentation measurements.

Observed platform: Windows build 10.0.26100, headless Chromium 156.0.8078.4,
NVIDIA RTX 5090/ANGLE D3D11 in a separate same-launch environment observation,
secure loopback, cross-origin isolation false, existing unsafe-WebGPU test flag.
The app is served through the existing e2e Vite development harness, not a
normal-launch/deployed hosting qualification. Pointer stream delivery was about
31 ms and wheel stream delivery about 62 ms despite the requested 8 ms pause.
All measured inputs had individual observed poses at those delivered rates;
higher-rate device/coalescing stress remains unqualified.

Decision: preserve current display freshness and precision. The observed
post-submission WebGL wait is the larger component; investigate its behavior in
a normal/interactive browser and on representative weaker hardware before
shipping asynchronous ordering for this workload. This is a prioritization
inference, not proof of the underlying driver/compositor/timer cause. A larger
scene or different hardware can change the balance. Earlier faster-polling
rejections remain valid evidence; no such optimization is retried or shipped.

The production app input/deployment IDs and standalone SDK source ID match the
preceding worker-sort packet. No renderer, controller, scheduler, source/WASM,
product registration, precision/default/freshness binding or native code changed.
Both typechecks, the full 6,470 portable tests, six independent analysis contracts,
source/native/generated/product gates and app/SDK artifact checks passed.
The [new packet](../../docs/validation/runs/app-responsiveness-20261025-01/validation.json)
records raw browser observations, environment and source/build hashes. Prior
437-case renderer/output/selection/production/SDK qualification is explicitly
prior unchanged-source evidence, not a newly rerun browser total.
