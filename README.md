# SplatView web

Contributors and agents: read [AGENTS.md](AGENTS.md) before feature work. Every new or changed feature must review Windows, macOS, Ubuntu and web support under the shared product contract, while retaining the existing source-lock, browser and WASM contracts.

A browser viewer and editor for Gaussian splats, with desktop SplatView controls,
a WebGPU renderer, and portable C++ scene logic running as WebAssembly in a worker.
Selected scene files are processed in the browser.

The desktop behavior target is SplatView 1.0.2, committed revision
`4e1be155511fb49f08fd8c863d785ac008a4c43a`. COLMAPView and PlayCanvas inform browser
implementation choices; desktop SplatView remains the core and UI authority.
The active web product is a Basic viewer and lightweight editor. Agent access and
advanced editing are excluded. See the [implementation status](IMPLEMENTATION_STATUS.md)
and [port plan](WEB_PORT_PLAN.md) for the active scope and validation.

For selection changes, see the [module map, ownership invariants and focused
test commands](docs/development/selection.md).

Surface selection now uses compact per-tile GPU lists and workgroup-memory
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
and [validation](docs/validation/runs/selection-interaction-optimization-20261018-01/validation.json).

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

Validation passed: 6,181 CPU tests across 189 files, the pinned product verifier (128 registrations), source/native-artifact checks, both typechecks and the production build. Three production-browser journeys passed with zero retries: Basic cleanup/Undo and manual Flip/Apply, Color/Fill picking without Range, and all 34 projected tutorial steps with selection restoration. Browser evidence is Windows Chromium 156 on a secure localhost origin; the separate high-performance adapter probe reported NVIDIA Blackwell without fallback. This is scoped browser evidence, not new macOS/native-provider or universal device qualification. [Review](design/feature-reviews/web-lite-selection-policy-2026-10-18.md). [Validation](docs/validation/runs/web-lite-selection-policy-20261018-01/validation.json).

Earlier full-editor qualification records describe their captured source and profile. They remain historical evidence and do not advertise advanced editing in this Basic web interface.

The PlayCanvas-reference input-policy update passed 6,203 CPU tests in 189 files,
six focused development-browser checks and five production-browser checks, all
browser cases with zero retries. Both typechecks, the production build and the
pinned source/product/native-artifact checks pass. Refused inputs preserve the
edited document and executable Undo/Redo. [Input-policy review](design/feature-reviews/playcanvas-input-policy-2026-10-18.md).
[Validation](docs/validation/runs/playcanvas-input-policy-20261018-01/validation.json).

## Run locally

The prepared build workspace uses Node.js 24+, npm, Python, and the reviewed
Windows x86-64 Emscripten toolchain in [TOOLCHAIN_LOCK.json](native/TOOLCHAIN_LOCK.json).
The native builder expects Emscripten 6.0.12 under `.tools/emsdk` or `EMSDK`, plus
the pinned CMake/Ninja and codec inputs. Its installed SDK/cache fingerprints
must match the lock. Build commands verify these inputs and never update the lock.

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
static files and require a secure context, WebAssembly, and the WebGPU features
and limits checked at startup. Mac hardware testing is optional for this project;
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

The app targets WebGPU. A WebGL compatibility viewer is separate optional
work. Native shell extensions, file associations and desktop packaging are
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
| `src/renderer` | WebGPU rendering, geometry viewing and scene queries |
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
