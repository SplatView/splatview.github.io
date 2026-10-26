# Exact WebGL worker sorting

The shared app/standalone sorter now uses bounded synchronous key/count/scatter
kernels, skips uniform key digits, and uses stable counting when the requested
key span fits admitted histogram storage. Wider spans retain stable radix.
Float32 operation order, source/candidate ties, display precision and freshness
are unchanged. No extra quality reduction was needed.

Matched old/new builds measured **43–75% lower current-sort worker round-trip
medians** across the tested scenes. All **48 snapshot pairs are byte-identical**.
The before/after source and complete SDK distributions are archived below.

| Scene | Bits | Before median / p95 (ms) | After median / p95 (ms) | Median reduction |
| --- | ---: | ---: | ---: | ---: |
| 256k-sparse | 32 | 9.30 / 16.70 | 5.20 / 6.70 | 44.1% |
| 256k-sparse | 24 | 7.30 / 9.90 | 4.15 / 5.70 | 43.2% |
| 256k-dense | 32 | 9.20 / 10.50 | 5.00 / 5.60 | 45.7% |
| 256k-dense | 24 | 7.30 / 8.20 | 2.20 / 2.50 | 69.9% |
| 1m-sparse | 32 | 40.90 / 51.00 | 20.80 / 24.10 | 49.1% |
| 1m-sparse | 24 | 30.90 / 35.10 | 16.00 / 17.10 | 48.2% |
| 1m-dense | 32 | 41.20 / 44.80 | 20.75 / 22.10 | 49.6% |
| 1m-dense | 24 | 31.90 / 35.10 | 8.00 / 10.90 | 74.9% |

Each row contains 186 observed sort round trips, including queue, transport and
wakeup. The frame cohort separately contains 180 moving and 180 fixed samples
per scene/precision/build. Raw completion uses `gl.finish` on both builds;
this is not physical FPS or the app's fence-polling cadence. Existing app GL
polling can still limit input/display completion even after sorting improves.

## Method and environment

Two identical 24-case cohorts: four deterministic SH0 scenes, 24/32-bit sorting,
three repetitions, 12 warm-up then 60 moving/60 fixed frames per case. The
framebuffer is 640 × 400. Sparse scenes have 25% nominal visible sources; dense
scenes have 100%. The sampler, common cameras, image poses, completion fences
and frozen external references are unchanged. The filtered configuration order
rotates across repetitions. The full seven-configuration runner keeps its
original rotation. No competing test/build workload ran during timing.

Observed Windows build 10.0.26100, Chromium 156.0.8078.4,
NVIDIA RTX 5090 through ANGLE Direct3D11. Loopback is secure, cross-origin
isolation is false. Chromium used `--enable-unsafe-webgpu`; the internal static
benchmark host sets no CSP. The standalone browser cohort additionally tests
its nested path and `script-src`/`worker-src 'self'` hosting. See
[environment.json](environment.json), [performance.json](performance.json) and
[the image/timing viewer](comparison.html).

## Memory, exact results and ownership

Large retained display pools add 65,536 uint32 histogram bins: 12 × count +
262,144 bytes, within the existing 16 MiB optional cap. Smaller pools retain
256 bins: 12 × count + 1,024 bytes. The host and worker share one byte planner.
At one million sources the pool occupies 12,262,144 bytes. The largest admitted
pool is now 1,376,256 sources; larger/refused pools fall back to the original-size
transient allocation, without reducing the supported scene count. Queries always
retain their original 256-bin scratch and admission formulas.

Key work yields after at most 8,192 sources; histogram/scatter/remapping chunks
contain at most 65,536 entries. A large prefix also yields. These are work bounds,
not wall-clock guarantees. One existing serial executor owns cancellation and
publication acknowledgement; the renderer retains fences and retirement.
Pool-owned returned arrays are copied before transfer. No stale/asynchronous
display order or replacement controller/history owner was introduced.

The independent comparison-sort oracle covers 16/24/32-bit keys, signed zero,
subnormals/boundary depths, scoped projective transforms, source/candidate ties,
narrow/wide spans and both histogram sizes. Cancellation covers key generation,
counting/prefix/scatter/remapping, wide radix, and subsequent pool reuse.
Optional refusal/cap and acknowledged retirement retain their existing tests.

## Checks

- 6,470 portable tests and the focused 165 selection tests passed.
- 437 browser checks passed with zero retries, skips, unexpected failures or
  flaky results: renderer 103, selection 126, WebGL output 54, WebGPU output 60,
  production 40 per backend, standalone SDK 14.
- Both TypeScript projects, production build, frozen-source/generated/native
  provenance, 133 product registration bindings, 40 web-build tests and six
  benchmark contract tests passed.
- Every app artifact/source-map and all 63 standalone artifacts passed byte/hash
  closure checks; an isolated TypeScript consumer passed. Actual app fallback,
  all SH degrees, exact pick/map/capture, staged masks, lifecycle and clean output
  remain in the browser cohorts.

The initial focused run had one incorrect diagnostic pass-name expectation;
the independent permutation oracles passed. Correcting that assertion produced
a green focused run, followed by the complete green suite. Both reports are
retained. No measured implementation candidate was discarded. The production
build emitted its existing large-chunk advisory; it exited successfully.

## Reproduction and provenance

Use the locked Node/toolchain and the frozen comparison workspace described in
[the benchmark guide](../../../../tools/bench/comparison/README.md). The runner's
new `--variants=splatview-webgl2-32,splatview-webgl2-24` filter preserves per-case
sampling; retain both labeled JSON runs, since `results.json` is a checkpoint.

```powershell
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --variants=splatview-webgl2-32,splatview-webgl2-24 --label=gl-sort-baseline-01
# Install the frozen candidate SDK as dist-engine before the second run.
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --variants=splatview-webgl2-32,splatview-webgl2-24 --label=gl-sort-candidate-01
python -B tools/bench/comparison/compare-sorts.py .build/renderer-comparison-20261025-01 gl-sort-baseline-01 gl-sort-candidate-01 --output=.build/webgl-sort-20261025-01/performance.json
```

The frozen SDK archives include complete notices, workers, declarations and
maps; source archives reconstruct each source digest. They are evidence, not
application build inputs. The existing reference comparison's receipts,
upstream bundles and pinned reviews remain unchanged. This optimization uses
no new external renderer code or runtime dependency.

See [the feature review](../../../../design/feature-reviews/webgl-worker-sort-2026-10-25.md)
and [validation.json](validation.json) for hashes, commands, raw cohorts and
failures. The existing motion-24/rest-32 and standalone-default-32 policies and
registration pins remain unchanged. No external-engine parity, native/preview
host, other OS/browser/GPU, real dataset, SH1–3 performance, physical memory,
normal-launch/deployed hosting or physical presentation qualification is claimed.
