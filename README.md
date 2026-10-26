# SplatView web

[Project map](docs/development/project-structure.md) | [Historical validation](docs/validation/README.md)

Contributors and agents: read [AGENTS.md](AGENTS.md) before feature work. Every new or changed feature must review Windows, macOS, Ubuntu and web support under the shared product contract, while retaining the existing source-lock, browser and WASM contracts.

A browser viewer and editor for Gaussian splats, with desktop SplatView controls,
WebGPU and WebGL2 renderers, and portable C++ scene logic running as WebAssembly in a worker.
Selected scene files are processed in the browser.

For embedding in another browser app, `npm run build:engine` creates a standalone
WebGPU/WebGL2 ES module, worker, types and plain browser example in `dist-engine/`.
See the [renderer API and ownership guide](docs/development/renderer-engine.md).

**SteadySplats** is available in **Settings → General → Gaussian rendering**.
It uses stochastic visibility, spatial resampling and temporal reconstruction,
with 16 refinement frames at rest by default. Sorted rendering remains the
default and the fallback when optional resources cannot be admitted. Picking,
editing maps and clean capture/saved-view images retain deterministic sorted
semantics. These rendering preferences last for the viewer session.
See the [feature review](design/feature-reviews/steady-splats-2026-10-25.md)
and [reference attribution](docs/third-party/STEADY_SPLATS_REFERENCES.md).

The desktop behavior target is SplatView 1.0.2, committed revision
`4e1be155511fb49f08fd8c863d785ac008a4c43a`. COLMAPView and PlayCanvas inform browser
implementation choices; desktop SplatView remains the core and UI authority.
The active web product is a Basic viewer and lightweight editor. Agent access and
advanced editing are excluded. See the [implementation status](IMPLEMENTATION_STATUS.md)
and [port plan](WEB_PORT_PLAN.md) for the active scope and validation.

For selection changes, see the [module map, ownership invariants and focused
test commands](docs/development/selection.md).

WebGPU surface selection uses compact per-tile GPU lists and workgroup-memory
sorting for ordinary tiles, preserving desktop composited depth, color and
visibility. The default 8,192-overlap cutoff is removed; device buffers and
memory admission still apply. A local 512 × 512 surface benchmark reduced
candidate storage from 16 MiB to 65.7 KiB and its warm median from 13.2 to
10.4 ms. These are workload observations, not a universal speed or capacity
guarantee. [Implementation review](design/feature-reviews/compact-selection-surface-2026-10-18.md)
and [SuperSplat references](docs/third-party/PLAYCANVAS_SELECTION_REFERENCES.md)
describe the original optimization and upstream design references.

Selection now also prepares shaders asynchronously after the first scene frame,
uses tighter conservative splat bounds, reuses bounded GPU scratch buffers and
limits eligible 3D-brush depth work/readback to the stroke area. Fill, connected
Color and global visibility retain full coverage. The latest local remeasurement
improved the compact baseline's warm median from 15.2 to 11.6 ms; a small brush
tap read 4 KiB instead of about 2 MiB. Results depend on scene and hardware.
All 6,255 CPU tests, 126 focused browser cases and four production cases pass.
[Review](design/feature-reviews/selection-interaction-optimization-2026-10-18.md)
and [validation](docs/validation/README.md#selection-interaction-optimization-20261018-01).

The web file toolbar is simplified to **Open, Save, Capture and Copy**. Folder
loading is in **Settings / General / Scene**. **Remember view** in Settings saves
the camera and background in this browser; it does not update Finder or Explorer
thumbnails. The T shortcut and saved-view import/export remain available.
[Review and validation](design/feature-reviews/web-toolbar-simplification-2026-10-18.md).

The current Windows presentation has also been reviewed: the web now uses its
headerless empty view, paired Open scene / Open example actions, compact Settings
rows, selected dots and contextual selection layout. The Bench example described
below opens through the normal loader. The original presentation qualification
passed 106 focused UI/policy tests, 18 browser checks and the production build.
[Design sources and adaptations](docs/third-party/WINDOWS_DESIGN_ALIGNMENT_REFERENCES.md).

Earlier 1.0.4 labels for this commit are corrected by the
[desktop version erratum](IMPLEMENTATION_STATUS.md#desktop-reference-version-erratum).

### Exact rendering optimizations (October 25, 2026)

Both backends now reuse exact resident depth order; WebGPU also reuses unchanged
projected data. Indexed Gaussian quads, asynchronous GL program preparation,
exact pick candidates, cooperative dense-tile sorting and color-only GL Gaussian
capture retain sorted display/fallback, clean output, raw maps and native editing.
Automatic WebGPU-to-WebGL2 fallback and the sorted default are preserved.

The [review](design/feature-reviews/rendering-optimization-plan-2026-10-25.md) and
[validation receipt](docs/validation/README.md#rendering-optimization-20261025-01)
record 6,426 portable tests, actual browser/production checks and repeated
measurements on Windows Chromium/RTX 5090. Exact queries and sorted capture
improve; the approximately 31 ms GL completion floor and App input latency remain.
No native/profile migration or other-platform GPU qualification is claimed.

## Basic web interface

The user confirmed a Basic-only web app on October 18, 2026. The active `web-lite` profile offers viewing, basic selection and cleanup, manual transforms/alignment, basic and auto color, capture, browser-local saved views and export of a new copy. Agent access and advanced editing are excluded from this profile. The Pro switch, Current view only and Range controls are omitted. Existing advanced engine code remains available for independent compatibility work; its presence does not make it part of the Basic product.

The viewport controls and Selection, Transform, Color hierarchy retain the desktop SplatView design. Browser file access, local saved views, explicit Apply/Cancel and resource admission retain their documented adaptations.

Starting the tutorial from an empty viewer opens the bundled example before the
first step. The example remains available for practice afterward. Replaying the
tutorial with a scene already open preserves that scene, its edits and history.
Offering or skipping the tutorial does not open a scene.

The demo uses the same **Bench example** as the desktop app: a 5.1 MB SOG with
262,556 splats and the desktop's authored starting view. The app owner supplied
this reconstruction from the [Mip-NeRF 360 dataset](https://jonbarron.info/mipnerf360/),
by Jonathan T. Barron, Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan and
Peter Hedman (CVPR 2022). The source dataset is licensed under
[CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/), as stated in the
[SMERF authors' data declaration](https://smerf-3d.github.io/#data).
The owner-supplied edited Gaussian-splat reconstruction is encoded as SOG and
adapted from the original photographs. See the
[data attribution and change notice](public/licenses/Mip-NeRF-360-NOTICE.txt),
[bundled full license](public/licenses/CC-BY-4.0.txt) and
[sample provenance](docs/third-party/DESKTOP_SAMPLE_REFERENCES.md).

The tutorial uses the desktop course structure: **Essentials** covers
20 Basic lessons, and **Topics** opens all 34 supported topics, grouped by
chapter. Both courses follow the toolbar from left to right, then the Tools
panel from top to bottom, keeping each menu's topics together.
Use Back/Next or B/N to navigate. This is a text tour with highlighted
controls; close it to practice on the sample. Animated desktop demonstrations
remain separate work.

When several remembered views match the sample, choose a view first; the text
tour continues afterward. Auto color commits immediately, while preset and
slider previews use Apply color. The tour explains these differences and uses
the same Ctrl snapping shortcut as the web controls on every platform.

Validation passed: 6,181 CPU tests across 189 files, the pinned product verifier (128 registrations), source/native-artifact checks, both typechecks and the production build. Three production-browser journeys passed with zero retries: Basic cleanup/Undo and manual Flip/Apply, Color/Fill picking without Range, and all 34 projected tutorial steps with selection restoration. Browser evidence is Windows Chromium 156 on a secure localhost origin; the separate high-performance adapter probe reported NVIDIA Blackwell without fallback. This is scoped browser evidence, not new macOS/native-provider or universal device qualification. [Review](design/feature-reviews/web-lite-selection-policy-2026-10-18.md). [Validation](docs/validation/README.md#web-lite-selection-policy-20261018-01).

Earlier full-editor qualification records describe their captured source and profile. They remain historical evidence and do not advertise advanced editing in this Basic web interface.

The PlayCanvas-reference input-policy update passed 6,203 CPU tests in 189 files,
six focused development-browser checks and five production-browser checks, all
browser cases with zero retries. Both typechecks, the production build and the
pinned source/product/native-artifact checks pass. Refused inputs preserve the
edited document and executable Undo/Redo. [Input-policy review](design/feature-reviews/playcanvas-input-policy-2026-10-18.md).
[Validation](docs/validation/README.md#playcanvas-input-policy-20261018-01).

## Run locally

The prepared build workspace uses Node.js 24+, npm, Python, and the reviewed
Windows x86-64 Emscripten toolchain in [TOOLCHAIN_LOCK.json](native/TOOLCHAIN_LOCK.json).
The native builder expects Emscripten 6.0.12 under `.tools/emsdk` or `EMSDK`, plus
the pinned CMake/Ninja and codec inputs. Its installed SDK/cache fingerprints
must match the lock. Build commands verify these inputs and never update the lock.

After a fresh checkout, restore the frozen desktop references from the checked-in
archive. This explicit step verifies every member against the existing source
lock/capture manifests and refuses conflicting local files. It never reads a
sibling checkout or regenerates assets. See [the packaging review](design/feature-reviews/frozen-reference-packaging-2026-10-22.md).

```sh
python -B tools/restore-references.py
```

From that workspace:

```sh
npm ci
npm run build:core
npm run dev
```

Open the local URL printed by Vite. Once generated native artifacts exist, UI-only
development uses `npm run dev`. Native or codec changes require `build:core` again.
Generated native files are intentionally ignored by Git.

For the static production app:

```sh
npm run build
npm run preview
```

`build` verifies sources/native provenance, checks types, cleans `dist`, and
publishes the reviewed application assets and build manifest. `preview` serves
that emitted build locally. Opening `index.html` directly as a filesystem URL
does not provide the application's HTTP worker and asset environment.

The build lock describes the native build host. Browser clients use the emitted
static files and require WebAssembly and a graphics API with the capabilities
and limits checked at startup. WebGPU and clipboard APIs require a secure context. Mac hardware testing is optional for this project;
compatibility claims stay limited to observed browser environments.

## Scene workflow

- Open a file, select several files, choose a folder, or drag selected files into
  the viewer. Previous/next navigation uses only the selected collection.
- Gaussian inputs include PLY, compressed PLY, SPLAT, KSPLAT, SPZ, and bundled or
  unpacked SOG/SOGS. Ordinary PLY points and meshes have viewing controls.
- Basic provides selection, cleanup, compact transforms, basic color, alignment
  and history. Advanced controls are excluded from the active web profile.
- Save scene exports the loaded data through nine choices across eight format
  families. Exports of sampled scenes contain their loaded subset. The download
  acknowledgement belongs to the browser workflow.
- Capture image prepares a JPEG download; Copy image uses a gesture-initiated PNG
  clipboard write. Browser permissions and secure-context rules apply.
- Settings / General offers Open folder and Remember view. A remembered view
  stores the camera and background locally in this browser. Import/export the
  view as a portable bundle there; use Save scene to keep edited scene data.

Input admission uses memory checks, with PlayCanvas SuperSplat's local editor as
the policy reference. The arbitrary **256 MiB file cap has been removed**. Our
current loader still holds the complete source during decode: its **512 MiB
native candidate budget includes both input and decoder allocations**. Sources
of 512 MiB or more are refused before their bodies are read; smaller sources can also fail
later memory checks. Unpacked SOG admission counts unique original resources,
rewritten metadata and the native descriptor at their respective stages.

The logical aggregate budget remains **1 GiB**, and the loaded Gaussian preview
is capped at **1,000,000 records**. History, GPU resources, recovery and output
have separate admission. These checks do not measure available device memory or
guarantee a particular scene capacity or frame rate. Matching SuperSplat's larger
imports would require streaming decode; its separate 10 GB cloud-upload limit
does not describe local-editor capacity. [Reference sources and current
differences](docs/third-party/PLAYCANVAS_INPUT_LIMIT_REFERENCES.md).

Automatic startup prefers WebGPU and falls back to the integrated WebGL2 backend.
A separate WebGL compatibility viewer remains outside the active product. Native shell extensions, file associations and desktop packaging are
outside the browser app. Expensive hover computation is omitted where the plan
records that adaptation.

## Checks

With generated native artifacts available:

```sh
npm run typecheck
npm run typecheck:bench
npm test -- --maxWorkers=4
npm run test:web-build
```

Browser checks use the Playwright version pinned by `package-lock.json`:

```sh
npx playwright install chromium
npm run test:e2e
```

The default browser configuration starts the development server. Production
artifact, offline/update, native and benchmark qualifications have their own
recorded configurations; see [validation records](docs/validation/runs) and
[benchmark instructions](tools/bench/README.md). A development-server test does
not qualify deployed HTTPS or another browser/device.

## Static hosting and build hygiene

Serve the complete `dist` directory over HTTPS, preserving relative paths and
JavaScript/WebAssembly MIME types. The relative Vite base supports root and
project-subpath hosting. Keep the build manifest, workers, native modules,
reviewed public files and current maps together as one build. Offline/update
controls activate through the app's service-worker lifecycle after its asset
cohort is cached.

Production builds clear old outputs and reject unreviewed public assets and
unowned shipping files. Put diagnostics, fixtures, compiler intermediates and
test reports outside `public` and `dist`.

## Project structure and attribution

| Path | Responsibility |
| --- | --- |
| `src/ui`, `src/app`, `src/input` | Desktop-style React UI, orchestration and browser input ownership |
| `src/document`, `src/workers` | Typed document protocol, memory admission and worker lifecycle |
| `src/renderer` | Shared contracts, WebGPU/WebGL2 rendering and scene queries |
| `src/io` | File collections, images, saved views and browser downloads |
| `native/wasm` | Portable native adapters, cooperative jobs and contracts |
| `native/upstream`, `native/SOURCE_LOCK.json` | Captured source/dependency authority |
| `tools`, `tests`, `e2e` | Build verification, independent fixtures and browser checks |

Reuse and reference notes live in [docs/third-party](docs/third-party), including
[PlayCanvas references](docs/third-party/PLAYCANVAS_REFERENCES.md) and
[SOG/WebP provenance](docs/third-party/SOG_EXPORT_REFERENCES.md). Distributed
notices are retained in [public/licenses](public/licenses) and
[the icon notice](public/icons/LICENSE.txt). Preserve the applicable upstream
licenses and attribution when redistributing those components.

Settings / Help / Graphics diagnostics offers a session-only graphics backend choice.
Automatic prefers WebGPU, then uses WebGL2 if initialization fails. Close the
scene before switching backends. `?graphics=webgl2` and `?graphics=webgpu` force
a backend for this session. Sorted rendering remains the default on both;
SteadySplats requires additional tested float framebuffer capabilities and
admitted memory. Device loss restores the selected backend and native history.
See the [implementation review](design/feature-reviews/webgl2-implementation-2026-10-25.md)
and [local validation](docs/validation/README.md#webgl2-implementation-20261025-02)
for the observed Windows Chromium/NVIDIA configuration, checks and limitations.

The application uses 24-bit depth sorting during motion and refines to exact
32-bit sorting at rest. Picks, maps and clean captures retain full precision.
Large WebGPU scenes can use admitted visible-draw compaction; small scenes keep
the portable path. See the [throughput review](design/feature-reviews/rendering-throughput-2026-10-25.md)
and [evidence](docs/validation/README.md#rendering-throughput-20261025-01)
for local measurements and dense-scene costs.

Settings follows the Windows General / Privacy / Help structure. Appearance and
Gaussian rendering use aligned compact rows; optional SteadySplats tuning is
collapsed. Point and mesh views omit Gaussian controls. Application updates and
graphics diagnostics live in Help; browser-local saved views remain in General.

Exact WebGL worker sorting now skips uniform digits and uses admitted counting
sort for narrow key spans. The [matched benchmark](docs/validation/README.md#webgl-sort-20261025-01)
records 43–75% lower worker round-trip medians and 48 identical snapshot pairs;
precision, query/output behavior and the retained-memory cap are preserved.

Actual App orbit/pan/zoom measurements are recorded separately in the
[responsiveness packet](docs/validation/README.md#app-responsiveness-20261025-01).
The [developer tool guide](tools/bench/APP_RESPONSIVENESS.md) explains input
attribution, real completion fences and automation/environment limits.
