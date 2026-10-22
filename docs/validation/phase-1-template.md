# Phase 1 Apple Silicon browser proof template

**Status: pending. No Mac qualification run or measurement is recorded by this template.** Copy this file to `phase-1.md` and [the evidence template](phase-1-template.json) to `phase-1.json` when collecting actual results. Keep one JSON run per machine, browser and browser host; index the runs in the Markdown report. Preserve failed runs and raw evidence under `runs/<run-id>/`.

This packet implements the [immediate Mac proof](../../WEB_PORT_PLAN.md#immediate-mac-proof-alongside-foundation-work), using the [measurement protocol](../../WEB_IMPLEMENTATION_DETAILS.md#performance-measurement-protocol), [capture contract](../../WEB_IMPLEMENTATION_DETAILS.md#reference-capture-manifest) and [evidence lifetime rules](../../WEB_PORT_PLAN.md#qualification-evidence-lifetime). It qualifies a bounded foundation workflow. Complete formats, all retained editor features, 1M scenes and the separate 3M gate require later packets.

## Required browser cells

| Machine | Browser host | Result | Run evidence |
| --- | --- | --- | --- |
| 8 GB M1-class Apple Silicon Mac | Shipping Safari tab | Pending | Pending |
| Same minimum Mac | Shipping Chrome tab | Pending | Pending |
| Newer Apple Silicon Mac, exact model and RAM recorded | Shipping Safari tab | Pending | Pending |
| Same newer Mac | Shipping Chrome tab | Pending | Pending |

Record actual macOS and browser versions separately. The initial Safari WebGPU target requires macOS Tahoe 26 or later; a Safari version alone is insufficient. Use a normal browser launch and a production HTTPS deployment. Record all launch flags, extensions, profile mode, cross-origin isolation and response headers actually present. Development flags, Windows Chromium and Playwright WebKit do not qualify these cells. Qualify Safari Add to Dock in an additional run if offered; do not merge it into the Safari-tab result.

## Prepare a reproducible run

1. Record the operator, UTC interval, machine/chip/RAM, displays, power source/mode and thermal observations. Save browser/OS version evidence. Use a clean browser profile where available; document Safari website-data cleanup and extensions instead of assuming it matches a Chrome profile.
2. Build with `npm run build`, deploy the resulting static assets over HTTPS and record the exact URL. Archive the build log and a SHA-256 receipt for the **served** HTML, application JS/CSS, document worker, core/camera glue and WASM, provenance report and any additional loaded runtime assets. Include response MIME types and cache/isolation headers. Confirm fetched bytes against the deployment receipt. A local preview may diagnose bundling but does not qualify the real host.
3. Hash the source lock, dependency manifest, build provenance and fixture/trace manifests. Record source-tree identity or a hashed source receipt when no commit exists. The [source lock](../../native/SOURCE_LOCK.json) and [dependency manifest](../../native/DEPENDENCIES.json) identify inputs. Collect the production deployment manifest, compiled application-input identity, actual core/camera identities and capability-handshake outcome from the served build. These implemented identities supplement the artifact receipts; ABI numbers alone do not establish matching semantics. Template fields stay `null` and handshake status stays `pending` until this Mac run supplies its own evidence.
4. Record `navigator.gpu`, adapter information that the browser exposes, adapter/device feature lists and limits, requested features, and any refusal/error. Save unavailable adapter details as `null` with a reason. Do not infer Apple GPU memory from system RAM. Keep the normal, unisolated browser path unless the actual deployment provides isolation; record `crossOriginIsolated` and `SharedArrayBuffer` availability.
5. Freeze the small SH3 correctness fixture, expected source IDs/masks, edit trace, export settings and exact camera/background state. Freeze the 256k low/high-overdraw pair and orbit/pick traces before timing. Record hashes, source order, loaded count, SH degree, sampling, opacity/covariance distributions and projected-overlap descriptors from the plan. An absent fixture generator, oracle, trace or collector remains a gap; do not replace it with an unrecorded manual orbit and call the benchmark repeatable.

## Correctness and browser host checks

Record each check's result, exact steps, expected/observed state, screenshot/trace paths and defects in the JSON. Use `pending`, `pass`, `fail`, `refused` or `unavailable`; `refused` only passes a refusal check when the refusal and preserved state match its oracle.

| Check | Required observation |
| --- | --- |
| SH3 open and navigation | File input opens the hashed fixture; loaded count/SH agree. Fit, orbit and focus use the fixed camera trace; record real trackpad and mouse/modifier behavior. |
| Contributor and selection | Pick the independently expected overlapping source ID; perform the declared selection/Combine operation and compare the exact source mask. |
| Grade and history | Apply the declared grade/edit; Undo restores the original mask/content/history, Redo restores the edited result. Check rendered and exported state together. |
| Export, download and reopen | Export the declared format/scope/revision, record browser download handoff separately from an observed file receipt, hash the downloaded file and reopen it. Use the format's reviewed tolerance; hash equality is required only where the contract requires it. A click on Save does not prove a durable file. |
| Capture and backgrounds | Capture the same state on black, gray and white. Record camera/roll/up/FOV, grade/scope, CSS/framebuffer dimensions, DPR, MIME/color-space metadata and image hashes. Check clean capture versus UI screenshot separately. |
| DPR and display transition | Repeat the fixed picks/captures at actual DPR 1 and 2 where available; record exact CSS size and canvas width/height. Record unavailable physical display configurations rather than substituting browser zoom silently. |
| Clipboard | Invoke from an actual user gesture, allow then deny permission where the browser supports it, and record MIME/result. If clipboard is unavailable, verify actionable failure and continued editing/export. |
| Hidden tab and resume | Hide for a recorded interval, observe scheduler/idle work where measurable, resume and compare scene/camera/history. Check that held keys or scrolling do not continue unexpectedly. |
| Capability/admission refusal | Use a declared unsupported-capability or oversized-input case. Record the requested operation, limits, exact user-facing error and unchanged prior scene/mask/Undo/Redo/dirty/export state. Do not enable experimental GPU flags to erase the refusal. |
| Failed replacement | Begin with an edited fixture and available Redo. Attempt a hashed malformed/unsupported replacement; compare the retained scene, source identity, history, dirty state, output and resource snapshots before/after. |
| Graphics retry | Record the actual device-loss/failure trigger and retry path, then verify retained edits/Undo/Redo/export plus a fresh pick/capture. If a production-safe trigger or retry control is unavailable, leave this check pending with the missing mechanism. Graphics retry does not prove worker-crash reconstruction. |
| Follow-up workflows | Record folder/unpacked-resource, private-mode/storage and unfinished features as separate gaps. Do not mark unimplemented workflows accepted because the small PLY path passes. |

Capture UI evidence only after `document.fonts.ready`; record the platform font profile, glyph/fallback observations, Basic/Pro/tool/options, expanded sections, scroll and hover/focus state. Native visual comparisons additionally need a verified Windows executable reference and tolerance manifest; absent references leave that part pending.

## First scale measurements

Run four cells per browser host: 256k SH3 **low/high overdraw**, each at a **1280 × 800 framebuffer** and a **recorded Retina framebuffer**. Record CSS size, actual framebuffer size/DPR and any adaptive resolution at every run; 1280 × 800 is a render target, not an assumed CSS viewport. Keep fixture, camera, grade, selected scope and settings constant within a comparison. Report each cell separately.

| Scenario | Planned minimum repeats | Record in milliseconds unless specified |
| --- | --- | --- |
| Open | 3 cold app/scene opens, then 5 warm reopens; document precisely which caches were cleared | Read, decode, pack, worker transfer, GPU upload and first-present boundary; total open-to-first-rendered-frame elapsed time. Missing stage instrumentation is `null`, not a guessed split. |
| Orbit | 5 s warm-up, then 3 × 30 s of the same hashed trace | Raw frame elapsed samples, p50/p95, blocked/dropped observations, long-task duration/count. GPU sort/raster times only with advertised/requested timestamp queries; otherwise label CPU elapsed timing. |
| Pick and edit | 30 requests per fixed pick/edit/amendment case after initialization | Pointer-to-preview and query/readback/adoption/native/publication/retirement boundaries where instrumented; exact source-mask result and refusal/retry count. Separate cold map acquisition from warm reuse. |
| Export | 3 runs per declared first-packet format/scope | Encoding, output-copy/Blob and download-handoff elapsed times, output bytes/hash, captured revision and format tolerance result. |
| Retention | 20 open → edit → Undo/Redo → export → capture → replace → close cycles | Settled live reservations, pending retirement, WASM linear-memory/high-water bytes and available JS/process observations after each cycle. |

Use monotonic browser timestamps for CPU boundaries. State each metric's start/end events and timing source. A frame callback is not proof of physical display presentation; queue completion is not isolated GPU time. Save raw samples and completed counts alongside percentiles, failures and exclusions. Keep thermal/power changes and failed runs in the evidence. A missing collector or unsupported API must produce `null` plus a reason, not zero or a synthetic sample.

Memory observations use **bytes** and an explicit method/process attribution: accounted live/peak ledger, native live allocations, WASM linear-memory capacity/high-water, JS heap estimate, browser/worker process footprint and unavailable GPU/driver totals remain distinct. Record settled baseline, load peak, edited/export/capture peak, post-close and final-cycle observations where available. OS measurements include process IDs, sampling interval and attachment; do not subtract unrelated totals to invent GPU usage. A stable ledger alone does not prove browser/driver reclamation.

## Evidence and gate decision

Index raw JSON/CSV, build/fixture receipts, screenshots, screen recordings, profiler traces, download receipts and issue links using paths relative to the run report. Hash stored evidence. Add exact unavailable reasons instead of leaving unexplained blanks. The JSON template is a report shape, not an implemented benchmark runner or validator; the proposed tooling in the measurement protocol remains separate work.

| Decision field | Pending report value |
| --- | --- |
| Correctness and host checks | Pending |
| Required browser/hardware cells completed | Pending |
| Reproducible scale and retention evidence | Pending |
| Capability refusals and preserved-document behavior | Pending |
| Blocking defects and unavailable evidence | Pending |
| Reviewer, review date and applicable build hashes | Pending |
| Foundation architecture decision | Pending: continue, revise or remain pending after review |
| Supported operating limits / full-editor release | Pending; this template establishes neither |

The reviewer may accept only the exact tested build/environment and declared foundation scope, with unresolved gates listed. Record the reason for continuing or revising the renderer/codec/host adapters and any measured admission-budget change. Do not erase retained editor features to make the packet pass. Requalify affected cells when artifacts, UI/input, hosting, browser/OS, hardware or operating budgets change.
