# SplatView / PlayCanvas / COLMAPView renderer benchmark

**84 comparison cases and seven camera/color probes passed.** Each fixture /
renderer cell contains three repetitions, 180 moving and 180 fixed-view samples.
The application and standalone engine algorithms were unchanged for this work.

Observed configuration: Windows, Chromium 156, NVIDIA RTX 5090 / Blackwell,
640x400 physical pixels, DPR 1, SH0, black background. The temporary loopback
host is a secure context without cross-origin isolation or a CSP header;
upstream blob workers are allowed. Chromium uses `--enable-unsafe-webgpu`.
GPU clocks add timestamp-query support; ordinary renderer feature selection is
retained. The post-run adapter observation and per-case features are recorded.

Open the [interactive image comparison](comparison.html), inspect
[timings.csv](timings.csv), or read the complete [summary](summary.json) and
[validation receipt](validation.json).

## GPU work

Median GPU pass totals in milliseconds, shown as **moving / fixed**. These sum
each frame's actual GPU pass timestamps before calculating the distribution.
They exclude CPU work, queue callback latency, readback and presentation.
The full report also contains p95 values and CPU submission/completion clocks.

| Fixture | SplatView 32-bit | SplatView 24-bit | PlayCanvas GPU default | COLMAPView GPU 16-bit |
| --- | --- | --- | --- | --- |
| 256k-sparse | 0.167 / 0.050 | 0.144 / 0.050 | 0.150 / 0.157 | 0.772 / 0.066 |
| 256k-dense | 0.356 / 0.238 | 0.335 / 0.237 | 0.323 / 0.321 | 0.968 / 0.250 |
| 1m-sparse | 0.479 / 0.172 | 0.424 / 0.172 | 0.329 / 0.332 | 1.089 / 1.516 |
| 1m-dense | 1.183 / 0.881 | 1.123 / 0.882 | 0.975 / 1.209 | 1.736 / 2.554 |

PlayCanvas leads the larger moving-camera cases. SplatView's 24-bit path leads
the 256k sparse moving case and every unchanged-view redraw case, and is ahead
of the measured COLMAPView session. At 1M moving sources, SplatView takes about 0.424 ms sparse / 1.123 ms dense;
PlayCanvas takes 0.329 / 0.975 ms and COLMAPView takes 1.089 / 1.736 ms.
These are results for this hardware, input and configuration, not a universal
ranking or a parity target.
The fixed phase forces redraws of an unchanged view. It measures reuse/caching;
it does not claim that an idle application continuously submits frames.

## WebGL and sort freshness

Moving-frame median CPU-through-GPU-completion in milliseconds. Both GL adapters
use `gl.finish`, avoiding different browser fence-poll intervals. **PlayCanvas
retains asynchronous sorting and may display its previous order; SplatView waits
for the current sort.** The low PlayCanvas first-display value is therefore not
a same-freshness sorting-latency result. Worker compute/round-trip timings and
first-versus-settled images are retained separately.

| Fixture | SplatView 32-bit | SplatView 24-bit | PlayCanvas first display, async sort |
| --- | --- | --- | --- |
| 256k-sparse | 10.50 | 8.50 | 0.80 |
| 256k-dense | 10.40 | 8.30 | 0.80 |
| 1m-sparse | 45.85 | 34.00 | 0.90 |
| 1m-dense | 44.80 | 35.60 | 0.90 |

SplatView's main opportunity is WebGL worker sorting. Useful follow-up work is
approximate or asynchronous display ordering with bounded freshness, followed
by exact refinement at rest and exact queries/captures. GPU sorting/projector
work is a smaller remaining gap to PlayCanvas on this device. This benchmark
does not change either implementation to match the other.

## Image agreement and configuration differences

Minimum settled-image PSNR across the tested poses/scenes. The reference is
**SplatView GPU 32-bit**, not perceptual ground truth; these are agreement scores,
not an independent image-quality ranking. Foreground scores exclude the black
background using the union of pixels above 8/255. Compare the actual images.

| Variant | Whole-image PSNR, dB | Foreground PSNR, dB |
| --- | --- | --- |
| splatview-webgpu-24 | 63.10 | 58.28 |
| playcanvas-webgpu | 34.82 | 29.55 |
| colmapview-webgpu-16 | 34.87 | 29.55 |
| splatview-webgl2-32 | 82.32 | 77.55 |
| splatview-webgl2-24 | 63.07 | 58.26 |
| playcanvas-webgl2 | 34.93 | 29.66 |

The common scene supplies activated positions, scales, identity quaternions,
opacity and SH0 colors. SplatView uses float covariance / half SH0, PlayCanvas
uses its texture packing and default minimum pixel size 2 with sRGB output and
no tone mapping, and COLMAPView uses float scale/quaternion SH0 with its original
16-bit radix / front-to-back billboard / composite session. AA, culling, color
handling and sorting choices differ. Sorting precision alone does not explain
the cross-renderer image differences.

Sparse cases place 25% of source centers in the view region with scale 0.025;
dense cases place all centers there with scale 0.05 and greater overlap. These
are composite workloads, not an isolated culling experiment. Camera poses,
physical viewport and input values are shared within each fixture.

## Reproduction and evidence

The [tool guide](../../../../tools/bench/comparison/README.md) documents commands,
scope and frozen-input requirements. PlayCanvas is the integrity-verified
2.24.0-beta.10 package at
[`3b389e0`](https://github.com/playcanvas/engine/commit/3b389e05a4619dcb2a6efec3bc8139bf43cafd95).
COLMAPView uses its original renderer session and vendored gs-toolbox from
[`0a1d01c`](https://github.com/ColmapView/Colmapview.github.io/tree/0a1d01c3c8c65f9c0a244f4608c50558c221c5fd).
Original reference licenses remain in the isolated frozen tree. No shipping
dependency, application source, worker protocol or product binding was changed.

The accepted run rotates renderer order across repetitions and keeps GPU
workloads sequential. Every case has a new browser context, real completion and
resource retirement. Source/reference hashes stayed fixed through measurement.
Setup timings include adapter conversion and constructor/upload after module
preloading; they are not app cold-load or file-loading performance.

Six benchmark contract tests and 6,451 existing portable tests passed, along
with both typechecks, frozen source/native/build, generated asset/product and
standalone artifact checks. The existing 133 product registrations and prior
throughput receipt are unchanged. NativeQualification remains false.

Calibration failures were retained and excluded: an oversized query-set probe,
a three-source PlayCanvas GPU binding rejection, and a tiny-splat sparse fixture
discarded by default culling. The final probe has four records / three visible
points, and timed images must contain nontrivial foreground. The first calibration
used linear PlayCanvas output; the accepted run uses sRGB. Some initial calibration
image paths were superseded; those metadata are not accepted as image evidence.
Accepted runs have distinct image directories and hashes.

This is a renderer-core/session benchmark. Full viewer UI, codecs/file loading,
editing/picking, Spark/WebGL fallback in COLMAPView, LOD streaming, SH1-3,
stochastic/TAA, larger resolutions and other browser/OS/GPU configurations remain
outside this comparison. Physical presentation FPS and driver memory are not
observed. Implementation or feature parity is not an acceptance requirement.
