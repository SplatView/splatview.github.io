# Renderer comparison

This is an internal browser benchmark, separate from the application and SDK.
It compares renderer cores/sessions with common SH0 geometry, cameras, background
and physical output size. It records different sort precision, culling, packing,
AA, output and asynchronous sorting choices. It does not require feature parity
or identical images.

The reviewed workspace is `.build/renderer-comparison-20261025-01/`. Its
`references.json` pins every external file. `references/` contains an integrity-
verified PlayCanvas 2.24.0-beta.10 package at commit
`3b389e05a4619dcb2a6efec3bc8139bf43cafd95`, and frozen COLMAPView 0.15.4 sources /
vendored gs-toolbox at `0a1d01c3c8c65f9c0a244f4608c50558c221c5fd`.
The original COLMAPView renderer session is bundled for this local benchmark;
the full application UI and its Spark/WebGL fallback are not measured.

The comparison builder accepts a prepared, frozen workspace inside `.build/`
and refuses changed reference bytes or references outside that directory.
Reference capture is a separate reviewed step: retain the pinned package/Git
revision, original licenses and exact file inventory before running. It does not
read/build live sibling sources, install production dependencies, modify source
locks or copy comparison code into `public`, `src` or the shipping outputs.

With the repository's locked Node toolchain and existing `dist-engine/`:

```powershell
node --test tools/bench/comparison/fixtures.test.mjs tools/bench/comparison/build.test.mjs
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --probe --label=my-probe
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --smoke --label=my-smoke
node tools/bench/comparison/run.mjs .build/renderer-comparison-20261025-01 --label=my-measured-run
python -B tools/bench/comparison/summarize.py .build/renderer-comparison-20261025-01
```

Labels must be new; run/image directories are not overwritten. The full run
has seven configurations, four scenes and three repetitions, with 12 warm-up,
60 moving and 60 fixed frames per case. Ordering rotates across repetitions.
Each case has a fresh browser context and explicit resource retirement. The
runner starts/stops a temporary loopback static host and headless Chromium.
Do not run other timed GPU workloads concurrently.

Use `--variants=splatview-webgl2-32,splatview-webgl2-24` to repeat just the affected
WebGL configurations. This preserves the fixtures, per-case sampling and three
repetitions. Freeze the old SDK before implementation and keep both labeled runs;
`results.json` is a working checkpoint. Compare those matched runs, including all
48 before/after PNG pairs, with:

```powershell
python -B tools/bench/comparison/compare-sorts.py .build/renderer-comparison-20261025-01 gl-sort-baseline-01 gl-sort-candidate-01 --output=.build/webgl-sort-20261025-01/performance.json
```

The original full-cohort summarizer still requires all seven configurations.

The benchmark packer uses `DataView.setFloat16`, qualified here on Chromium 156;
that is a tool requirement, not a new requirement of the shipping SDK.
GPU pass clocks opt into timestamp queries. GL completion uses `gl.finish` on
both implementations; it is not the application's fence-polling clock.
PlayCanvas GL can display the previous sort while its worker runs. Report its
worker compute cost and first/settled images separately from SplatView GL, which
awaits the current sort. Setup time includes adapter format conversion and is
not an app/file cold-load comparison.

The local bundle retains upstream algorithms: PlayCanvas uses unified rendering,
default minimum pixel size 2, sRGB output and no tone mapping; COLMAPView uses its
default 16-bit radix / front-to-back billboard / composite session. The calibration
fixture has four records with three visible colored points because the pinned
PlayCanvas GPU path rejected a 12-byte buffer for three records. The timed sparse
fixture uses splats large enough to produce visible output under upstream culling;
empty output cannot qualify a performance result.

The reference code has its original MIT, Apache-2.0 and AGPL-3.0 license material
in the frozen input tree. It is confined to this local comparison output and is
not a dependency of the distributed application or standalone engine.

Results and a portable image comparison are in the
[recorded packet](../../../docs/validation/README.md#renderer-comparison-20261025-01).
Image agreement uses SplatView exact output as an explicit common reference,
not perceptual ground truth. Physical presentation FPS and physical driver memory
are not observed. Other OS/browser/GPU, SH degrees, resolutions, real-world
datasets, LOD and stochastic/TAA behavior require separate measurements.
