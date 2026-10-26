# Actual App camera responsiveness

The current App completed the three-repetition orbit/pan/zoom benchmark on both
backends. **6,480 measured trusted inputs**, plus 288 warm-up inputs, passed the
pose/submission/fence checks. Every phase refined to exact 32-bit rendering and
App idle. This slice adds measurement only; renderer/controller/scheduler,
precision, freshness, native/WASM and product registrations are unchanged.

**WebGPU input-to-fence medians: 4.2–4.4 ms; WebGL: 36.65–38.05 ms.**
The current WebGL worker takes about 5.0–5.6 ms per sort round trip. Its response
fence wait is about 30.4–31.65 ms after submission, the larger observed component.

Decision: retain current display freshness. The next investigation is WebGL
completion behavior in a normal interactive browser and representative weaker
hardware. These observations do not justify changing the asynchronous-ordering
default on this workload. This is prioritization from measured components, not
proof of a driver/compositor/timer cause. Larger scenes can change the balance.
Faster fence polling was previously tried and rejected; it is not shipped here.

| Backend | Gesture | Input | Samples | Median / p95 (ms) | Worker median (ms) | Response fence median (ms) |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| webgl2 | orbit | isolated | 360 | 38.05 / 41.00 | 5.60 | 31.65 |
| webgl2 | orbit | stream | 720 | 37.70 / 40.40 | 5.10 | 31.20 |
| webgl2 | pan | isolated | 360 | 36.80 / 40.30 | 5.40 | 30.70 |
| webgl2 | pan | stream | 720 | 36.65 / 40.00 | 5.10 | 30.40 |
| webgl2 | zoom | isolated | 360 | 37.10 / 40.10 | 5.00 | 30.50 |
| webgl2 | zoom | stream | 720 | 37.10 / 40.10 | 5.00 | 30.70 |
| webgpu | orbit | isolated | 360 | 4.40 / 6.40 | — | 3.90 |
| webgpu | orbit | stream | 720 | 4.30 / 4.90 | — | 3.90 |
| webgpu | pan | isolated | 360 | 4.30 / 4.80 | — | 3.90 |
| webgpu | pan | stream | 720 | 4.30 / 4.70 | — | 3.90 |
| webgpu | zoom | isolated | 360 | 4.20 / 4.90 | — | 3.80 |
| webgpu | zoom | stream | 720 | 4.30 / 4.80 | — | 3.90 |

[Interactive timing viewer](comparison.html) · [CSV](timings.csv) ·
[Full summary](summary.json) · [Validation receipt](validation.json)

## Method and limits

Six browser cases contain 36 phases, aggregated into 12 series with three
independent repetitions each. Backends alternate by repetition. The real React
App opens the bundled Bench example: 262,556 Gaussians, SH3, viewport/framebuffer
1280 × 800, DPR 1. Every phase resets to the same captured camera baseline,
warms up eight inputs, then measures 120 isolated or 240 stream inputs. Orbit
uses middle-drag, pan right-drag, zoom the wheel. Inputs are trusted browser
events and ordinary native camera handling; the fixture never renders manually.

The clock starts at document capture. The sampler captures an immutable pose at
CPU render entry and confirms actual submission sequence at render return. It
joins that exact display checkpoint's existing completion promise. Pre-input
poses cannot satisfy isolated latency. Streams can combine inputs into a later
changed pose; here every measured input had an individual observed pose at the
actual delivered rates. Pending displays stayed within the existing bound: two
on GL, one on GPU during measured active intervals. The production stale-query
observer is unchanged; camera advancement during display is expected.

Input-to-entry, response preparation and response fence wait describe selected
responses. Active-frame metrics separately include exact refinements/inertia
within the input window. Stage medians are independent and do not add to the
median of the complete path. Worker metrics include queue/transport/wakeup;
optional clocks and one rAF heartbeat are fixture-only. No competing test/build/
GPU workload ran during the accepted cohort. The calibration is separate.

Observed Windows build 10.0.26100, headless Chromium 156.0.8078.4, secure loopback,
cross-origin isolation false and the existing `--enable-unsafe-webgpu` launch
flag. A separate post-run same-launch observation identifies NVIDIA RTX 5090 /
ANGLE D3D11. The actual App runs in its Vite e2e development host; this is not
normal-launch, headed-browser, deployed-host or CSP qualification. See
[environment.json](environment.json).

The observed rAF cadence was about 31 ms. Despite an 8 ms requested pause,
sequential automation delivered pointer streams about every 31 ms and wheel
streams about every 62 ms. Submission intervals are approximately 31 ms during
streams. These are observed automation/submission clocks, not physical FPS or
physical dropped frames. Physical input hardware, presentation and driver memory
are unavailable. Higher-rate input/coalescing stress, other OS/browser/GPU,
real datasets beyond Bench, SH0–2 performance, larger scenes and normal browser
launches remain unqualified. There is no paired before/after latency improvement
claim and no external-engine parity claim.

## Validation and provenance

- Six accepted browser cases passed, with zero retries, skips, failures or flaky
  results. All 6,480 measured inputs have observed subsequent changed poses;
  every phase ends at exact rest and idle.
- The separate WebGL calibration passed; it is retained and excluded from the
  three-repetition summary.
- 6,470 portable tests and six independent analysis contracts passed. Analysis
  tests reject pre-input/unchanged poses, untrusted events, duplicate sequences,
  invalid clocks, excess pending work and missing exact rest; known-clock and
  coalescing examples verify aggregation.
- Both TypeScript projects, production build, 919-source/generated/native gates
  and 133 product registrations passed. All 111 app artifacts/four source maps
  and 63 standalone artifacts/isolated declaration consumer passed byte closure.
- The captured sampler and all 351 app inputs stayed unchanged through timing.
  App deployment/input and SDK source identities match the worker-sort packet.
  The earlier 437 browser checks are unchanged-source prior evidence, not a
  newly rerun total. No new native runtime/preview-host qualification is claimed.

The production build retains its existing large-chunk advisory and succeeds.
There were no failed browser or analysis cases in this slice. PowerShell stderr
formatting in a log does not override the recorded successful process result.

See the [feature review](../../../../design/feature-reviews/app-responsiveness-2026-10-25.md)
and [tool guide](../../../../tools/bench/APP_RESPONSIVENESS.md). Raw browser reports,
calibration, source manifest/archive, environment, app/SDK artifact manifests and
exact commands are linked by [validation.json](validation.json).
