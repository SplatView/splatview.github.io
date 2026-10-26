# Actual App camera responsiveness

Developer/agent measurement only. The fixture drives the real App, bundled
262,556-source Bench SH3 scene, native camera input, renderer and display fences.
It does not replace the App scheduler, render manually or add a product surface.

With the repository's pinned Node toolchain:

```powershell
npm run typecheck
npm run typecheck:bench
python -B tools/bench/app-responsiveness-report.test.py
$env:PLAYWRIGHT_JSON_OUTPUT_FILE = '.build/app-responsiveness-20261025-01/measured-01.json'
npx playwright test --project=spec:app-responsiveness.spec.ts --reporter=json
python -B tools/bench/app-responsiveness-report.py .build/app-responsiveness-20261025-01/measured-01.json --out=.build/app-responsiveness-20261025-01/summary.json
```

Create the output directory before running and use a fresh label/directory for
another accepted run. Preserve prior receipts. The default Playwright project
starts/reuses the existing loopback Vite host; do not rebuild or edit imported
sources while measuring. Run without competing test/build/GPU workloads.

There are three independent repetitions per backend, interleaved by repetition.
Each uses orbit via middle-drag, pan via right-drag, and wheel zoom, with isolated
and continuous input phases. Each phase resets to the captured camera baseline,
warms up eight inputs, then measures 120 isolated or 240 stream inputs. The
viewport is the existing 1280 × 800, DPR 1. Exact idle is joined between phases.

`e2e/app-input-probe.ts` wraps only the fixture renderer and owns its bounded
observations. `finish()` joins App idle and observed completions; the input driver
owns button release in one `finally` block. The probe captures input time/trust,
immutable draw-entry pose/revision,
confirmed submission sequence, the existing checkpoint completion, optional
worker timing and one rAF heartbeat. It restores wrappers after joining work.
The production stale-query observer remains intact and is not used to reject
expected camera advancement during a display stream.

The report independently validates direct isolated-input attribution and stable
source/framebuffer/camera baselines. It separates input-to-entry, CPU preparation,
post-submission fence wait, pose age, submission cadence and worker cost. Stream
inputs can share a subsequent changed pose; counts without an individual pose
are coalescing observations, not physical dropped frames. Stage medians are
independent summaries and must not be added as a latency identity.

The clock starts at browser DOM capture. Trusted automation does not measure the
physical mouse/trackpad, display presentation or driver memory. Playwright's
sequential commands can limit delivery rate; use the recorded intervals, not the
requested 8 ms stream pause, when interpreting load. The observed headless
Chromium calibration delivered pointer inputs about every 31 ms and wheel input
about every 62 ms. Higher-rate devices, headed/normal-launch browsers, other OS/
GPU, real datasets beyond Bench and larger scenes need separate measurements.

The current review is
[app-responsiveness-2026-10-25.md](../../design/feature-reviews/app-responsiveness-2026-10-25.md).
The evidence packet records exact source/build/browser/context identities and
keeps calibration separate from the accepted three-repetition cohort. Any
asynchronous display/freshness change requires its own implementation review and
measured acceptance, including exact rest, queries and captures.
