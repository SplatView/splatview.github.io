# Feature review: flatter Settings presentation

Reviewed October 26, 2026 before implementation, from source
`8dcfbf18cb49321e62991352c33f7e1427e72e16` with a clean working tree. The user
requests further Settings simplification, removing unnecessary subtitles and
folders. Interpret folders as collapsible option groups, not the existing
Open folder scene-loading feature.

Read AGENTS, README, WEB_PORT_PLAN, IMPLEMENTATION_STATUS, capabilities, approved
UI differences, the shared product contract/template and the previous
`settings-and-release-2026-10-25.md` presentation review. Consume local sealed
product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
The previous desktop inspection identifies compact General/Privacy/Help tabs
and property rows in Windows `src/app_ui_settings.cpp`; this is a browser
presentation amendment, not a refresh of frozen desktop or generated inputs.

## Intent and layout

- Retain the Settings title, General/Privacy/Help tabs, aligned property rows,
  fixed header, body-only scrolling, focus trap/return and responsive widths.
- Remove repeated Rendering, Scene and Saved view headings from General and
  the redundant saved-view helper subtitle. Preserve named semantic groups,
  the existing button title explaining browser-local saved views, and all scene
  and saved-view actions, enabled states and owners.
- Show the four existing SteadySplats tuning rows directly when that renderer
  is selected. Remove its extra disclosure/summary and explanatory body line;
  keep the capture/saved-view sorted-output explanation on the renderer control.
  Genuine preparation, fallback, transfer and error statuses stay visible.
- Remove redundant subsection headings from Privacy and Help. Preserve truthful
  local processing/reporting/storage statements, offline cache/update scope,
  keyboard guidance, help/tutorial actions and actual update/recovery guards.
- Keep only Help's useful Graphics diagnostics disclosure, whose backend override
  and large technical JSON would otherwise overwhelm the simple page. Retain
  its closed-scene/session restriction, active backend and fallback evidence.
- Use modest spacing and hairline separators to distinguish rows from actions;
  no nested cards, new navigation folders or replacement Settings framework.

No renderer/default/precision change, action or native/API/CLI registration,
format, persistence, tutorial projection, resource admission or controller/
history/worker ownership changes. Existing localization keys and frozen catalogs
remain; new visual copy is unnecessary. The presentation changes do not remove
engine capabilities or the advanced compatibility code.

## Platform and host policy

| Target | Policy and reason | Conditions, implementation and qualification |
| --- | --- | --- |
| Windows editor | Required preservation of native Settings and shared vocabulary; current reviewed desktop uses compact property rows. | No native source/package change. Web spacing is an explicit browser adaptation; no matched native screenshot claim. |
| macOS editor | Required preservation of native settings, accessibility and host integration under the sealed product policy. | Browser DOM changes only; no AppKit/Metal/Quick Look qualification. |
| Ubuntu editor | Required preservation of native settings and host controls under sealed policy. | No SDL/Vulkan/package changes or GNOME/KDE runtime qualification. |
| Web-lite / browser module | Required usable, localized Settings with direct relevant controls. Gaussian options conditional on Gaussian/empty content; existing fallback/admission still applies. | Qualify actual browser layout, keyboard/focus, geometry omission, tuning, backend and saved-view paths on the observed host. No other-browser/GPU claim. |

Explorer preview, Quick Look, GNOME preview, KDE preview and OS thumbnail
providers are unaffected: this change does not reach their entry points.
Browser-local saved views still do not update OS thumbnails, and source files
are never overwritten. The standalone renderer API has no Settings DOM; retain
its settings/default contracts and distribution checks. Missing host evidence
is a qualification gap, not an exclusion inferred from missing browser code.

## Validation plan and evidence

Preserve all existing product/source/generated/toolchain/native/WASM/browser
contracts and the unchanged 133 registrations. Update existing Settings and
SteadySplats browser assertions to exercise direct controls rather than the
removed disclosure. Verify default mode, tuning dependencies and native
cleanup/Undo, geometry omission, session backend selection/fallback, locale/font
preview rollback, keyboard trap/return, narrow/short layout and support/update
placement. Keep meaningful failure and scope messages.

Capture and inspect desktop, expanded SteadySplats, narrow/large-font and Help/
Privacy screenshots. Run both TypeScript projects, app/SDK builds, focused UI
tests, applicable browser journeys and the explicit product/layout gates.
Record actual commands, results, failures, browser/OS/GPU/security context and
current build identities below; portable tests alone do not qualify browser UI.
Raw output belongs to `.build/validation/settings-simple-20261026-01/`.
Do not advertise a new application release or native/profile migration.

## Implemented result and verification

General now has plain appearance/renderer rows and scene/saved-view actions,
with no visible subsection headings or option disclosures. Selecting SteadySplats
immediately exposes History weight, Animate samples, Converge at rest and
Refinement frames. The renderer control retains the sorted capture explanation
as its accessible description/tooltip. All eight redundant subsection headings
are removed across the three tabs; meaningful privacy, offline-scope, shortcut,
fallback and operation-status text remains. Graphics diagnostics is the sole
disclosure. Scene and Saved view retain accessible group names without visible
folder chrome. The README now describes the actual flat layout.

Inspected development and production screenshots at 1280 x 800 with Small and
Large fonts, plus 360 x 420 with Large French text. Default General is 361 px high
instead of 443.5 px (82.5 px / 18.6% shorter). The directly expanded SteadySplats
page is 449 px, compared with the old 473.5 px page whose options were collapsed.
These comparisons use the same development scene, viewport and preferences.
All captured bodies have equal client/scroll widths; narrow content scrolls
vertically, preserving the header/tabs. A separately inspected scrolled French
capture shows the scene and saved-view actions still reachable. Short-window
keyboard tests cover forward/backward focus wrapping with expanded options.

Actual checks:

- `npm run verify:project` and the explicit product gate passed. Bundle 2.0.0
  still verifies all 133 registrations; native qualification remains false.
- `npm run build` passed the 919-file frozen-source closure, generated assets/
  translations, product and native/toolchain checks, both TypeScript projects
  and production build. The existing large-chunk advisory remains.
- `npm run build:engine` passed 63 standalone artifacts and an isolated
  TypeScript consumer. Renderer source ID remains
  `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.
- Vitest: all 6,480 tests passed. Node build contracts: all 40 passed.
- Initial Settings/SteadySplats browser run: 11 passed. The broader 70-case
  appearance/support/saved-view run passed 67 and exposed three stale keyboard
  expectations described below. All 18 cases in the four changed browser
  suites then passed in one final run, with zero skips, failures or retries.
  The other 54 cases from the broader run passed with unchanged test sources.
  These cohorts overlap and are not added as unique coverage.
- Fresh production app: eight passed, including automatic fallback, real
  SteadySplats controls/Bench refinement, Basic cleanup/Undo and WebGL context
  recovery. Another two SteadySplats app journeys passed with forced WebGL2.
  Both production cohorts had zero failures, skips, flaky results or retries.
- Eleven production screenshots were captured; inspected General, Help, Large
  Privacy and scrolled French actions alongside the development SteadySplats
  and before captures. Source comparison preserves 1,179 native,
  public, product, reference, fixture, renderer, document, worker, standalone
  and application/controller inputs exactly. The archive catalog is unchanged.
- `git -c core.whitespace=cr-at-eol diff --check` passed.

The initial three failures expected Font size's portal Tab to focus Open folder
immediately. A separate source export of baseline `8dcfbf1` was verified against
all 1,905 original Git files; only the five existing native publication files
were copied explicitly. A browser probe of the baseline and current appearance
harnesses showed both focus the Gaussian renderer selector first, restoring
Small font and closing the preview. The tests now assert Renderer, then Open
folder, including reverse traversal, without altering production focus logic or
discarding native records/masks/camera/Undo/Redo preservation checks. The focused
three-case recheck and final complete changed suites passed. Failed reports,
baseline proof and traces remain in the ignored run directory.

Production browser: Chromium 156.0.8078.4 on Windows, NVIDIA RTX 5090 (WebGPU
Blackwell and WebGL2 ANGLE/D3D11), non-fallback WebGPU adapter; actual fallback/recovery
also ran. Local origin `http://127.0.0.1:4173` is secure and not cross-origin
isolated. Tests use the existing `--enable-unsafe-webgpu` flag. The appearance
harness baseline probe has no native/GPU initialization; the separate native
preservation tests exercise real WASM/GPU state. Their Meta variant simulates
the platform string and does not qualify macOS. No Safari, other OS/GPU,
assistive-technology, native editor/provider or full offline-update matrix
qualification is added by this presentation change.

App input: `ae2024756443b194fe7db106ccf07e592b84214c3374ecfff76e935a24f5df08`.
Local deployment ID:
`8ed9251da90171712cb16c1f948eeba0f381a2f151be7c9859da9d76ea53b46f`.
Native input remains
`59b0d5f23b429590c4804a68ecba23fb6d3b0b1c3c44f17cb92d6b5ba81b3230`.
These qualify local source/production checks; no new release or deployed HTTPS
site is claimed. Raw commands/reports/screenshots and baseline evidence are
under `.build/validation/settings-simple-20261026-01/`.
