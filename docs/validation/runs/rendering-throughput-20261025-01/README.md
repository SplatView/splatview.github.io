# Rendering throughput delivery, October 25, 2026

The application now uses 24-bit depth sorting during camera motion and exact
32-bit refinement at rest on WebGPU and WebGL2. Exact picks, editing maps and
clean captures retain full precision. The standalone module defaults to 32 bits
and exposes typed precision plus optional pure host admission/motion helpers.

The controller permits two matching display submissions while keeping CPU
preparation serialized and genuine completion/retirement ownership intact.
WebGPU scenes of at least 262,144 sources can reserve a private compact sorted
draw list and a GPU indirect instance count. Refusal retains full drawing.
Closing also joins pending scene allocation/optional compilation and cleanup.
Base mirror/native coverage excludes separately admitted optional storage so
recovery and edit accounting cannot charge the compaction buffer twice.

## Measured results

Observed environment: Windows, Chromium 156, NVIDIA RTX 5090 / Blackwell;
WebGL2 uses ANGLE D3D11. Secure localhost, cross-origin isolation false.
Chromium uses the existing `--enable-unsafe-webgpu` test flag. Only the GPU
timing fixture opts into timestamp queries; production adds no optional feature.
Production and standalone builds have separate artifact identities. Other
browser/OS/GPU/hosting configurations require their own runtime qualification.

The trusted-input stream ran three repetitions per backend, with 240 wheel
events per rendering mode. Median sorted **submission interval** improved from
62.5 ms to 31.3 ms on WebGL2. WebGPU sorted and both Steady paths remained around
31.2-31.3 ms. These are actual submissions and queue fences, not physical
presentation FPS. Exact single-frame completion medians remained about 2.9 ms
on WebGPU and 31.2 ms on WebGL2 in the representative controlled fixture.

The 24-bit WebGL worker's median sort compute cost was 8.8 ms versus 10.5 ms
for current 32-bit sorting at 262,556 sources, and 17.2 ms versus 22.15 ms at
525,112 coincident sources. These are separate three-repetition same-fixture
series. The exact historical worker series varied slightly; full data are in
`controlled-series.json`, rather than a universal speedup claim.

GPU implementation comparison below uses the sum of median project/sort/
compaction/raster pass timestamps, in milliseconds. Each variant has 32 measured
frames after eight warm-up frames, interleaved on one device. "Placed in view"
describes synthetic source-center placement, not a read-back visibility ratio.

| Sources | Placed in view | Full draw, 32-bit | Compact draw, 32-bit | Compact draw, 24-bit |
| --- | --- | --- | --- | --- |
| 262,144 | 25% | 0.235 | 0.150 | 0.132 |
| 262,144 | 100% | 0.276 | 0.285 | 0.264 |
| 1,000,000 | 25% | 0.751 | 0.419 | 0.374 |
| 1,000,000 | 100% | 0.854 | 0.875 | 0.830 |

Sparse 1M-source GPU work approximately halved. Dense 1M-source 24-bit work
improved about 3%; exact dense moving views paid roughly 2-3% compaction cost.
Small scenes avoid compaction. These final-implementation variant clocks are
separate from the historical source-stable before/after app measurements.
No matched PlayCanvas/COLMAPView workload was run.

The representative quality test compared eight Bench camera poses at both
262,556 and 525,112 sources, on each backend, against 32-bit output. Minimum
PSNR was 59.21 dB; maximum mean absolute RGB error was 0.00009028 normalized,
about 0.023/255. Localized maximum error reached 39/255, so the mean is not a
per-pixel bound. Near-depth/overlap stress cases can show larger order changes.
16-bit sorting failed the conservative representative quality budget and remains
explicit SDK opt-in. Rest and clean output use exact sorting.

## Validation and retained diagnostics

Portable: **6,451 tests in 210 files**. Focused selection: 165 tests, a subset of
that total. Both typechecks, 40 build-contract tests, frozen source/native gates,
generated assets, the 133-registration product gate, app build, SDK build and
independent artifact/declaration consumer checks passed.

| Browser cohort | Passed |
| --- | --- |
| performance-render-only.json | 56 |
| input-fences-qualified.json | 6 |
| postsort-qualified.json | 21 |
| final-fast-order.json | 21 |
| renderer-regression.json | 103 |
| selection-browser.json | 126 |
| outputs-webgl2.json | 54 |
| outputs-webgpu.json | 60 |
| sdk-browser.json | 14 |
| production-webgl2.json | 40 |
| production-webgpu.json | 40 |

Cohorts overlap and are not summed as unique coverage. The intermediate
`postsort-qualified` cohort precedes the shutdown fix; the shipping renderer and
standalone cohorts repeat those paths and add held-compilation shutdown coverage.
The final fast-order cohort also checks that all 262,145 sources survive the
all-visible branch and that independently admitted storage leaves base coverage
unchanged. Final production/SDK tests run against the rebuilt budget fix.

The first 62-case timed run had 59 passes and three WebGL input-observer failures:
the existing benchmark correctly classified a moving camera as stale while its
previous submitted frame was pending. All six input cases were replaced by a
fixture that records the actual display fence for a draw that starts after the
input. The production benchmark's staleness checks were preserved. Historical
and corrected input samplers have different inclusion rules; no paired input
latency improvement is claimed. The 56 non-input passing cases are explicitly
derived from the retained raw report, with excluded input cases identified.

Rendering measurements ran with byte-stable source. Shipping changes after that
cohort only join pending allocation during close, correct base budget accounting,
strengthen the test-only input/all-visible fixtures and regenerate build identity;
GPU/GL frame, sorting/compaction and shader algorithms are unchanged. Both measured
and shipping inventories and the exact delta are retained.

Other rejected candidates are retained: serial-prefix/eight-bit radix overhead,
indirect-radix dense/small-scene regressions, an invalid zero timestamp probe,
a reserved WGSL identifier, the original compact/full query-buffer aliasing,
and fixture snapshot/readback mistakes. They are not included as successful
shipping performance evidence. See `validation.json` for full reasons, counts,
compressed raw reports/logs and hashes.

## Scope and next work

The required all-platform policy and the explicit sorted-rendering registration
binding are in the [feature review](../../../../design/feature-reviews/rendering-throughput-2026-10-25.md).
The [browser module guide](../../../development/renderer-engine.md) describes
host scheduling, precision, budgets and shutdown. Prior receipts/reviews and
frozen native/WASM/source/toolchain inputs are preserved.

Next performance work is a matched immutable PlayCanvas/COLMAPView comparison,
then measured adaptive resolution/overdraw work for large dense views. Existing
dense GL map cancellation, optional scratch eviction and initial program
preparation remain follow-ups. Native editors, installed preview/thumbnail hosts
and other browser/OS/GPU/security contexts remain separate qualification gaps.
There is no external publication/deployment or completed profile migration.
