# SplatView web

[Open the viewer](https://splatview.github.io/) | [Project map](docs/development/project-structure.md) | [Developer workflow](docs/development/automation.md)

A browser viewer and lightweight editor for Gaussian splats, with WebGPU and
WebGL2 rendering. Selected scene files are processed in the browser. The active
Basic product follows desktop SplatView's controls and editing behavior.

## Viewing and editing

- Open PLY, compressed PLY, SPLAT, KSPLAT, SPZ and packed or unpacked SOG/SOGS.
  Select files or a folder to browse a collection. Points and meshes have viewing
  controls.
- Select, clean up, transform, align and color Gaussian scenes with Undo/Redo.
  Save scene downloads a new copy; sampled scenes export their loaded subset.
- Capture prepares a JPEG download. Copy image writes PNG to the clipboard,
  subject to browser permissions and secure-context requirements.
- Settings / General offers Open folder and browser-local saved views. Remember
  view stores the camera and background; portable view bundles can be imported
  and exported there. Saved views do not save scene edits or update OS thumbnails.
- The tutorial offers 20 Essentials lessons and 34 topics. Starting it from an
  empty viewer opens the bundled Bench example; replaying it over a loaded scene
  preserves that scene and its history.

Advanced editing and agent access are excluded from the active web profile.
The [port plan](docs/porting/plan.md), [implementation status](docs/porting/status.md)
and [approved UI differences](docs/parity/ui-differences-v1.csv) describe scope,
platform decisions and remaining qualification.

## Rendering and limits

Automatic startup prefers WebGPU and falls back to WebGL2. Sorted rendering is
the default on both. Optional **SteadySplats**, in **Settings / General / Renderer**,
uses stochastic visibility and temporal reconstruction, with 16 refinement
frames at rest by default. Its extra capabilities and memory must be admitted;
otherwise sorted rendering remains available. Picking, editing maps and clean
captures retain deterministic sorted semantics.

**Settings / Help / Graphics diagnostics** offers a session-only backend choice;
close the scene before switching. `?graphics=webgl2` and `?graphics=webgpu` force
that backend for the session. Device-loss recovery retains the selected backend
and native document history.

The app's native candidate budget is **512 MiB**, including input and decoder
allocations. Sources of 512 MiB or more are refused before their bodies are read;
smaller inputs can also fail admission. The logical aggregate budget is **1 GiB**
and the Gaussian preview cap is **1,000,000 records**. History, GPU resources,
recovery and output have separate admission. These limits are not measurements
of available device memory or guaranteed scene capacity. See the
[input policy](docs/third-party/PLAYCANVAS_INPUT_LIMIT_REFERENCES.md) and
[rendering reviews](design/feature-reviews/rendering-optimization-plan-2026-10-25.md).

## Development

Use Node **24.21.0** (pinned in `.node-version`), npm and Python **3.11+**.
Development lives on `source`; `main` contains the published static site.

```sh
npm run setup
npm run dev
```

`setup` restores verified frozen references and checksum-pinned released WASM,
then installs locked npm dependencies. Native/codec changes require
`npm run build:core` with the reviewed Windows
[toolchain](native/TOOLCHAIN_LOCK.json). Runtime reuse is separate from native
compilation and qualification.

| Command | Purpose |
| --- | --- |
| `npm run doctor` | Read-only setup diagnostics. |
| `npm run check` | Contracts, types and portable/tool tests. |
| `npm run ci` | The same checks plus app and standalone builds. |
| `npm run build` / `npm run preview` | Build and serve the production app. |
| `npm run test:ci` | UI-only Chromium smoke checks. |
| `npm run test:e2e` | Full browser inventory; use the relevant feature/hardware profiles. |

Install the pinned browser with `npx playwright install chromium` before browser
checks. The [workflow guide](docs/development/automation.md),
[configuration map](config/README.md) and [tools map](tools/README.md) explain
logs, test lanes, native requirements and release promotion. Contributors and
agents must read [AGENTS.md](AGENTS.md) before feature work.

## Embed the renderer

`npm run build:engine` writes an independent WebGPU/WebGL2 ES module, worker,
TypeScript declarations and plain browser example to `dist-engine/`.
The [renderer API guide](docs/development/renderer-engine.md) defines camera,
admission, scheduling and shutdown ownership for other browser apps.

## Hosting and validation

Serve the complete `dist/` over HTTPS with correct JavaScript/WebAssembly MIME
types. Preserve relative paths and keep the manifest, workers, native modules,
public assets and current maps together. Root and project-subpath hosting are
supported. Offline/update controls activate after a verified cohort is cached.

Production builds reject unreviewed public assets and unowned output. Keep new
reports and traces in ignored `.build/validation/` directories. The
[validation catalog](docs/validation/README.md), [port documentation](docs/porting/README.md)
and [benchmark tools](tools/bench/README.md) retain historical results and their
actual source/browser/OS/GPU scope. Portable tests and development-server checks
do not qualify native providers, other devices or deployed HTTPS.

## Example and attribution

The bundled Bench example is an owner-supplied Gaussian reconstruction from the
[Mip-NeRF 360 dataset](https://jonbarron.info/mipnerf360/) by Jonathan T. Barron,
Ben Mildenhall, Dor Verbin, Pratul P. Srinivasan and Peter Hedman (CVPR 2022).
It contains 262,556 splats in a 5.1 MB SOG, adapted from the original photographs.
The source dataset is CC-BY-4.0, as stated in the
[SMERF authors' declaration](https://smerf-3d.github.io/#data). The
[attribution/change notice](public/licenses/Mip-NeRF-360-NOTICE.txt),
[full license](public/licenses/CC-BY-4.0.txt) and
[sample provenance](docs/third-party/DESKTOP_SAMPLE_REFERENCES.md) accompany it.

Component sources and references are in [docs/third-party](docs/third-party),
with distributed notices in [public/licenses](public/licenses) and the
[icon notice](public/icons/LICENSE.txt). Historical desktop reference versions
are explained in the [version erratum](docs/porting/status.md#desktop-reference-version-erratum).
