# Feature review: responsiveness benchmark cleanup

Reviewed October 25, 2026 before implementation. User request: clean up and
simplify the recent work. Scope is the responsiveness fixture and its Python
report, with rendering behavior and historical evidence preserved.

Authority: AGENTS, shared product contract/template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger and approved UI differences. Local
sealed bundle 2.0.0 remains pinned at
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
No live sibling build inputs, frozen-source/native/WASM/toolchain refresh, registration,
default, UI/API/CLI, format, tutorial, persistence, scheduler or history change.

## Policy and ownership

| Target | Policy and evidence | Change / qualification |
| --- | --- | --- |
| Windows | Existing native viewing required (`../SplatPreview/src/renderer.hpp`); browser benchmark conditional on existing browser/worker/GPU support. | Fixture-only cleanup; actual Windows Chromium checks below. No native change. |
| macOS | Native viewing required (`../splatview_macos/src/render/render_frame.cpp`); browser benchmark conditional on browser capabilities. | No Metal/AppKit change; Apple runtime remains unobserved. |
| Ubuntu | Native viewing required (`../splatview_ubuntu/src/vulkan/vulkan_renderer.hpp`); browser benchmark conditional on browser capabilities. | No Vulkan/native change; Linux runtime remains unobserved. |
| Web-lite / standalone host | Conditional on existing secure-context/backend/worker/admission requirements. Internal e2e diagnostics only. | Preserve exact pose/submission/fence attribution, sample counts, bounds and 32-bit idle; no product measurement surface or local agent server. |

Explorer, Quick Look, GNOME/KDE preview and native thumbnail hosts are unaffected.
Browser saved-view/disk/OS-thumbnail boundaries remain unchanged. The App retains
submission, cancellation, retirement, native selection and history ownership.

## Review and selected fixes

Applied the `review-smells-and-antipatterns` skill in module/fix mode. Code and
design notes were collected separately before synthesis; no UI/deceptive-pattern
lane applies to these internal fixtures. No subagent delegation was requested.

1. **Repeated validation (code smell, low severity, high confidence).** Before
   cleanup, `tools/bench/app-responsiveness-report.py:53` contains
   `pairs=[pair for value in values for pair in validate(value)]`, while line 67
   invokes `len(validate(value))` again. Validate each observation once and reuse
   its matched responses, preserving all report fields and oracle checks.
2. **Scattered gesture completion (design smell, low severity, high confidence).**
   `e2e/app-responsiveness.spec.ts:44` and `:60` both release the mouse button;
   the same test separately imports the probe to wait for idle before `finish()`.
   Give the input driver one guaranteed button-release path. Let probe `finish()`
   own its existing idle/fence join, retaining the outer observer-restoration
   boundary. Use one gesture-specific input listener and share the response type.

Keep the pure Python validator independent of the browser sampler. No generic
benchmark framework, compatibility barrel or new dispatcher is justified.
Historical reports/reviews/source archives retain their original bytes. Existing
receipts describe their recorded source revisions, not the refactored tool.

## Validation

Planned: six existing independent report contracts; replay the accepted 6,480-
input cohort with byte-identical archived output and compare calibration against
the captured pre-cleanup processor; both typechecks;
portable/source/generated/product/native build gates; actual WebGPU and WebGL
orbit/pan/zoom fixture regression with exact idle. Record actual results below.
Local raw outputs and before/source digests live in
`.build/benchmark-cleanup-20261025-01/`; no duplicate historical data packet is
needed. Prior full browser/SDK qualification remains separate unchanged-source
evidence. Native/other OS/GPU/normal-launch qualification is not implied.

Coverage: code/design lanes reviewed; broad anti-pattern and product UX lanes
not applicable. Deferred: higher-rate input and normal-browser GL completion
investigation remain benchmark follow-ups, outside this cleanup.

## Completed validation

- `npm run build` passed, including both TypeScript projects, frozen/native/
  generated source checks and the product gate; 133 registrations are unchanged.
  The existing large-chunk advisory remains. `npm run typecheck` passed again
  after the final fixture edit.
- `npm test -- --maxWorkers=4` passed all 6,470 portable tests. All six Python
  report contracts passed. The accepted 6,480-input summary is byte-identical;
  calibration results also match the captured pre-cleanup processor exactly.
- Playwright `spec:app-responsiveness.spec.ts --grep 'repetition 1'` passed both
  backends: 12 orbit/pan/zoom isolated/stream phases and 2,160 measured inputs,
  with no retries, skips, failures or flaky results. The independent report
  validator accepted every phase and observed response. This is functional
  regression evidence, not a repeated performance comparison.
- Actual browser evidence is Windows, headless Chromium 156 / NVIDIA RTX 5090,
  secure localhost, cross-origin isolation false, existing unsafe-WebGPU flag.
  Native/normal-launch/other OS/browser/GPU qualification remains unclaimed.
- App artifact closure (111 artifacts/four source maps) and SDK closure/isolated
  consumer (63 artifacts) passed with the previous app/SDK identities. Historical
  responsiveness and worker-sort receipts retain their original hashes.

Preflight corrected a shell-encoding change to the test title before browser
execution. The older calibration summary predates some diagnostic fields, so
calibration equivalence uses the captured pre-cleanup processor; no old receipt
was rewritten. No validation failure remains unresolved.

Re-scan confirms one report validation per observation, one pointer-release
site, one gesture-specific listener pair and one owner of phase idle/completion.
No broad refactor or additional public evidence packet was introduced. Detailed
local reports/source backups are under `.build/benchmark-cleanup-20261025-01/`.
