# Feature review: concise Windows-aligned Settings and web 0.2.0 release

Reviewed October 25, 2026 before implementation. User requests: release the
completed renderer work, with Settings organized like Windows while retaining
only relevant browser features. Settings cleanup is included before publication.

## Authority and existing behavior

Read AGENTS, shared product contract/template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger and approved UI differences. Consume
local sealed bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
Desktop sources are inspection references, never build dependencies. Preserve
all source/toolchain/native/WASM/generated/typed-action/worker budgets and the
current controller/history/submission/cancellation/retirement owners.

Current Windows `src/app_ui_settings.cpp:84–136` uses General, Privacy and Help
with a fixed header and independently scrolling body. General's `setting` helper
at line 257 uses compact property labels/values; Language, Theme and Font size
follow the optional Gaussian View selector. Native agent, file association and
reporting controls are host-specific and do not become browser requirements.
The web already has those three pages and approved browser-local saved views.
Recent rendering controls mix backend notes/JSON, tuning and offline status into
General, increasing scrolling and using inconsistent row columns.

## Policy and host review

| Target | Policy / source evidence | Implementation and qualification |
| --- | --- | --- |
| Windows editor | Required native settings hierarchy, `../SplatPreview/src/app_ui_settings.cpp`. | Read current source; no native code/build/package changes or native screenshot claim. |
| macOS editor | Required native settings/host behavior per sealed product policy and `../splatview_macos/src/ui/editor_ui.cpp`. | Browser presentation changes only; Apple SDK/Metal/Quick Look remain unobserved. |
| Ubuntu editor | Required native settings/host behavior per sealed policy and `../splatview_ubuntu/src/ui/editor_ui.cpp`. | No Linux/Vulkan/package change; GNOME/KDE runtime remains unobserved. |
| Web-lite / browser provider | Required accessible Settings; rendering options conditional on Gaussian content and backend/resource support. | Keep actual browser permission/admission/fallback behavior, focus/preview/locale and static-host contracts. Qualify Windows Chromium locally and deployed Pages separately. |

Explorer, Quick Look, GNOME/KDE preview and OS thumbnail providers are unaffected.
Browser-local saved views remain General actions and do not overwrite source
files or update OS thumbnails. No native agent server, CLI, telemetry toggle,
file association, unsupported view mode or advanced editing UI is added.
Missing browser implementations remain gaps, not browser restrictions.

## UI and lifecycle decisions

- Keep General / Privacy / Help, 300 logical-pixel preferred width, 12-pixel
  inset, fixed heading/tabs and body-only scrolling. Reuse existing picker
  columns, 28-pixel controls and semantic tokens for rendering rows.
- General keeps appearance, relevant Gaussian rendering, scene actions and
  browser saved views. Geometry views omit Gaussian-only controls. Empty scenes
  can still choose a Gaussian renderer before loading.
- Put optional SteadySplats tuning behind an explicit disclosure. Preserve its
  settings, defaults and typed SDK/controller contract; this is not algorithm or
  capability removal. Surface genuine preparation/fallback status normally.
- Move manual graphics backend selection and technical JSON into Help's
  collapsed Graphics diagnostics. Preserve session-only scope, closed-scene
  requirement, canvas replacement and focus restoration.
- Put offline/application update information in Help with the other application
  support actions. Update-available notices open that actual page. Preserve the
  joined dirty-document/update guard, source authority and service-worker flow.
- Preserve Privacy's truthful local processing/storage statements; do not add
  dummy native reporting or host integration controls. Keep existing Help and
  tutorial targets, keyboard access, preview rollback and saved-view actions.

No new action/native/API/CLI IDs, wire formats, profile migration, precision,
freshness or renderer-default change. Existing registration bindings remain;
the presentation amendment supplements their pinned behavior reviews.

## Release plan and validation

Use v0.2.0 for the additive renderer/backend/module release. Update root package
and lockfile version only, without dependency/toolchain updates. Derive standalone
package version from the root instead of its hard-coded value. Build source and
SDK with current artifact identities, preserve all earlier review/measurement
receipts and qualify actual final release bytes.

Repository layout verified through GitHub: source branch `source`, Pages legacy
deployment from `main:/`, previous release v0.1.0. Keep that arrangement. Publish
a source commit/tag, clean app/SDK ZIPs, manifests/checksums and release notes;
deploy the validated site to the static branch without force-pushing. Verify
Pages completion, public manifest/artifact identity and actual HTTPS browsing.
The GitHub connector lacks release/Pages operations here, so use Git/GitHub CLI.

The first offline fixture build exposed an older incomplete capture: it omitted
the pinned pivot icon definitions, local product/review bundle and newer root
TypeScript configs. Extend this test-only capture from the existing reviewed
authority records and sealed local trees, retaining exact byte verification,
fresh capture IDs and failed logs. Do not relax checks or change frozen inputs.

Required: meaningful layout/accessibility/geometry and updated settings/update
journeys; preserved pick/map/capture/worker/backend/source/native/build contracts;
both typechecks, portable and product gates; app and isolated SDK artifacts;
production checks on both backends and offline-update behavior. Capture desktop,
narrow and large-font Settings and inspect the actual result. Record actual
commands/failures/browser/OS/GPU/security context and release IDs below. Other
OS/GPU/native/installed-host qualification stays separate.

## Qualified release candidate

Prepared version 0.2.0 with unchanged dependency versions and native publication.
App deployment ID:
`876142158bb9823310098d303da672463cbbb29d1ff289177709ce4e2a3b8c35`.
App input ID:
`d51d79422aa65cd86d3a4250edb59923b901800f2829d80189bbf2a73953eaea`.
Standalone source ID:
`41db01937f4a466b7ee8475dea366fd451be82c47c949a6ef8bd00e1d3bb1a81`.

Actual local checks: 6,470 portable tests; 40 build contracts; 100 Python tests
(one existing skip); both TypeScript projects; frozen-source/native/generated
and 133-registration product gates. Browser cohorts passed with zero retries,
skips, unexpected failures or flaky results: Settings 29, renderer 103, selection
126, WebGL output 54, WebGPU output 60, production 40 per backend, standalone 14,
and six offline/update journeys. Cohorts overlap and are not unique coverage.

Production desktop/narrow/large-font screenshots were inspected. General now
has consistent compact rows, full-width saved-view actions and a much shorter
default body. Help owns updates/diagnostics; genuine fallback/preparation status
remains visible. Native UI/source inspection is not matched native screenshot
qualification. Observed browser: Windows build 10.0.26100, Chromium 156.0.8078.4,
NVIDIA RTX 5090/ANGLE D3D11, secure localhost, cross-origin isolation false,
existing unsafe-WebGPU test flag. The standalone nested-path CSP check passed.

Retained diagnostics: the first unit run had one outdated exact CSS selector
expectation, corrected to include rendering in the existing shared-row contract.
The first offline capture omitted current frozen inputs; later host qualification
also needed the declared content-addressed render-worker source map. Capture
and host checks were corrected without changing frozen input bytes, relaxing
hash/ownership checks or changing deployed offline logic. The final fresh
offline capture is `release020-04`; the exact cache inventory is now 111 runtime
artifacts plus its manifest. All final checks passed. The existing build chunk
advisory and the Python host skip remain explicitly separate.

Prepared app/SDK archives passed exact extraction/manifest checks (111 app
artifacts, four maps; 63 SDK artifacts). Public publisher/legal files outside
the app distribution are retained; Git publication must preserve raw bytes.
Publication, public HTTPS artifact verification and existing-client upgrade
results are recorded in the release's `validation.json` asset rather than
rewriting this frozen source review after tagging. Local raw evidence and
before/after sources remain in `.build/release-v0.2.0/`.
