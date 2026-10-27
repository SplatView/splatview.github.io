# Feature review: update notice in the application toolbar

Reviewed October 27, 2026 before implementation. Source baseline:
`09bf2ba85a585d04889f5ad2fc10c685258ff8ca`, clean working tree. The user dislikes
the bottom update button and requests a better design. Read AGENTS, README,
WEB_PORT_PLAN, IMPLEMENTATION_STATUS, capabilities/approved UI differences,
the shared product contract/template and the local Settings/offline reviews.
Consume the sealed local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
No build reads live sibling source or refreshes frozen/generated authority.

## Intent and behavior

The current `OfflineUpdateNotice` is a separate bottom-left button at
`left: 60px; bottom: 12px`, adjacent to branding and over the viewing area.
Move the same action into the top toolbar's Viewer panel group beside
Tools/Settings. Use the existing native refresh/reset glyph, a modest accent
dot and a short localized label on desktop. On narrow screens use the same
36 px icon target as neighboring controls, with its accessible name and tooltip.
Use semantic theme colors and existing hover/focus rules; no pulse or toast.

Clicking still opens Settings / Help, never performs an immediate reload.
Retain the current candidate/current identity comparison, existing update
availability subscription, modal/tutorial disabling, real Help controls and
dirty-document/save/discard/cancel/navigation guards. The existing toolbar
owns auto-hide/inert/ARIA visibility, avoiding a second floating chrome owner.
Observe the stable toolbar groups as well as the toolbar so a late update
notice receives correct row rounding even when total toolbar size is unchanged.

No new settings, persistent flags, API/CLI/native action IDs, wire/storage
formats, cache policy, service-worker authority, scene/file writes, resource
budgets, renderer defaults or controller/history/submission/retirement owners.
Existing localization keys, native icons and tutorial target order remain.

## Platform and host decisions

| Target | Policy and reason | Conditions / implementation / qualification |
| --- | --- | --- |
| Windows editor | Required preservation of native app/update controls and semantic UI rules; the shared contract separates platform integration from browser adaptation. | No native source, package or installer changes. Reuse reviewed native glyph/toolbar tokens for the browser. No native UI qualification. |
| macOS editor | Required preservation of native application update/host behavior and shared vocabulary. | This DOM-only notice does not modify AppKit, Metal or Quick Look; those hosts remain unobserved. |
| Ubuntu editor | Required preservation of native app/host update behavior. | No SDL/Vulkan/package change or GNOME/KDE runtime qualification. |
| Web-lite | Required clear, accessible notice when a genuinely distinct candidate exists. Offline updating remains conditional on the existing verified production build, secure context, browser storage and service-worker support. | Qualify toolbar layout/focus/locale on Windows Chromium and actual guarded update flows with freshly built browser fixtures; no browser restriction inferred from missing host evidence. |

Explorer previews, Quick Look, GNOME/KDE previews and OS thumbnail providers are
unaffected: this feature has no runtime entry point in those hosts. Browser-local
scene/view behavior stays with its existing owners. The standalone renderer has
no application update UI; its settings and distribution contracts remain.

## Validation

Extend the existing appearance harness only for explicitly synthetic update
availability; its original unsupported snapshot remains the default. Use it to
check candidate/no-candidate state, late row rounding, desktop versus compact
layout, themes/locales, keyboard activation/return and modal disabling. These
tests do not qualify real service-worker installation or update authorization.

Exercise the new toolbar entry in the genuine offline fixture `offer` helper,
retaining real A/B identity, native dirty document and existing save/discard/
cancel checks. Build a fresh immutable fixture set after covered source stops
changing; do not relabel historical fixtures or loosen their readers. Preserve
source/toolchain/generated/native/WASM/product gates and all 133 registrations.
Run focused UI/offline checks, both typechecks and production/SDK builds. Capture
and inspect desktop, narrow, light/dark and translated update states. Record
actual outcomes, failures, browser/OS/GPU/security context and remaining limits.
Raw output belongs to `.build/validation/update-toolbar-20261027-01/`.

This is a source/UI improvement, not authorization to claim a new deployed
release, native/profile migration or universal device/host qualification.

## Implemented result and actual checks

The bottom floating control is removed. A 36 px-high update action now shares
the Viewer panel toolbar group, beside Tools or Settings. Desktop keeps the
localized caption; at 640 px and below it becomes a 36 x 36 icon target with
the same accessible name, dialog semantics and tooltip. The native glyph,
theme accent dot, hover/focus treatment and row rounding are consistent with
neighboring controls. The enclosing toolbar owns hiding/inert behavior.

Actual checks on the final source:

- TypeScript and `npm run build` passed, including the 919-file source lock,
  generated assets/translations, sealed product and native/toolchain checks,
  both TypeScript projects and production output. The existing large-chunk
  advisory remains. Product verification still reports bundle 2.0.0, all
  133 registrations and native qualification false.
- `npm run build:engine` passed all 63 standalone artifacts and the isolated
  TypeScript consumer. Renderer source ID remains
  `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.
- Vitest: all 6,480 tests passed. Node build contracts: all 40 passed.
- Final notice/Settings/font/theme browser cohort: 33 passed, with no failures,
  skips or retries. Includes six new notice cases: candidate withdrawal, late
  row rounding while total toolbar bounds stay unchanged, keyboard Help/focus
  return, a withdrawn trigger's focus fallback, and Large French Bright/Dark
  layouts. The first appearance run also passed 11 cases; counts overlap.
- Built a fresh immutable A/B/C fixture set using the existing reviewed native
  publication, without native compilation or frozen-source refresh:
  `96800e608ae79bef24e0810dbc46f76873217c9a21bb2a26496fe6964902027c`.
  Each ordinary fixture build passed its existing gates. A and B share identical
  router bytes; their authored entry comments produce distinct application IDs.
- Five genuine offline/update cases passed across two runs (four plus one),
  with no failures, skips or retries: root/project A/B native-history isolation,
  Update and Stay, Update and Discard, and Update Save's matching whole-scene
  download acknowledgement. The shared offer helper now opens the actual
  toolbar notice and verifies the Help page before the existing update action.
  Stay retains native masks, byte-exact exports and executable Redo; no reload
  ticket is minted. The remaining offline/fault matrix was not rerun.
- Captured and inspected French Large Bright compact and Dark desktop states,
  plus the genuine production toolbar/page with an offered B candidate while
  A remains pinned. The production action is at x=534, y=12, height=36, within
  the toolbar. The compact variant has no horizontal page overflow and retains
  its localized accessible name when the visible caption is hidden.
- All 1,184 protected native/public/product/reference/fixture/application,
  renderer/document/worker/standalone/offline implementation files match the
  baseline. No cache authority, controller/history or renderer logic changed.
- Explicit product gate, `npm run verify:project` and
  `git -c core.whitespace=cr-at-eol diff --check` passed.

Retained verification corrections: the first visual fixture used unsupported
`light`; it fell back to Dark. It now uses the desktop contract's `bright`
value, a typed theme argument and an explicit actual-theme assertion. Fresh
Bright/Dark screenshots were inspected. The standalone capture initially waited
for first-visit service-worker control, which is intentionally not claimed by
this application. Its timeout is retained; reloading A after installation while
the host still served A provided a controlled tab before offering B. No
production theme, router or installation behavior was changed for either probe.

Observed production browser is Chromium 156.0.8078.4 on Windows, NVIDIA Blackwell,
non-fallback WebGPU, at secure loopback `http://127.0.0.1:5373`, cross-origin
isolation false, with the existing `--enable-unsafe-webgpu` test flag. The genuine
fixture host PID was 43580. Appearance-only harnesses have no initialized native
worker/GPU and are not used as service-worker authorization evidence. No Safari,
other OS/GPU, native application/provider, assistive-technology or deployed HTTPS
qualification is claimed.

Local application input:
`8c9418d2ecad03ce0e4e51c068ad66e6575e71352b165dbc12c81a88e20b8bbd`.
Local production deployment:
`13b45fcc034882a29cfd721cb3f1cb3877ac1896d740d3f1cb792d825b428745`.
Native input remains
`59b0d5f23b429590c4804a68ecba23fb6d3b0b1c3c44f17cb92d6b5ba81b3230`.
The genuine browser capture keeps fixture A
`27a7e1c0ce75921694b029063fe678ddf8101434cac17eb405d49a197caef446`
while offering B
`93e2013e280e53e2a8827eb494c77b88d8d7dbc9621e5ee71299ad786aa3a150`.
Those fixture IDs are intentionally distinct from the local shipping build.

Raw reports, screenshots, initial probe diagnostics and source comparisons are
in `.build/validation/update-toolbar-20261027-01/`; the fixture builder retains
its byte-pinned source/build packet under
`.build/offline-tests/update-toolbar-20261027-01/`. Existing contracts retain
ownership of that packet. No new application release or static-site deployment
is included in this source update.

## Style amendment: match the existing toolbar

Reviewed October 27 before implementation, baseline
`226207596539c88574fc69fab715705eae4e69b9`. The user requests the same style as
the rest of the project. Replace the bespoke desktop label, accent glyph and
notification dot with the ordinary icon-only toolbar button at every width.
Use the existing native glyph and shared 36 px size, padding, icon color,
grouped borders, hover/focus and disabled treatment. Keep the localized
accessible name/tooltip, dialog semantics, availability condition and Help action.
No update-specific CSS is necessary.

Re-reviewed the four platform decisions above: native Windows/macOS/Ubuntu
controls and preview/thumbnail hosts remain unaffected; web support remains
required with the same verified-update conditions. Shared visual tokens are
the presentation authority. No registration, policy/surface, cache, renderer,
controller/history or native/WASM ownership changes. The same local bundle
2.0.0 and digest apply; no frozen source or generated authority is refreshed.

Update the existing notice checks to compare the shared toolbar geometry and
icon/padding colors, then verify desktop/compact Bright/Dark French appearance,
dynamic grouping, keyboard/focus and modal behavior. Run existing style tests,
build/type/source/native/product gates and inspect new browser screenshots.
The earlier genuine A/B update tests remain historical unchanged-logic evidence;
do not relabel their previous styled fixture bytes as this presentation.
Raw checks belong to `.build/validation/update-style-20261027-01/`.

The amendment is implemented with all update-specific CSS removed. The existing
button class supplies its appearance at every width; only the native icon,
localized tooltip/accessibility name and existing dialog action remain.

Actual amendment checks: six notice browser cases passed with no failures,
skips or retries, including comparison of dimensions, padding and icon color
against the neighboring Tools button. Inspected Large French Bright/Dark
screenshots and an English toolbar capture. The focused theme-style, theme-picker,
offline-controller and offline-navigation suites passed all 46 tests. Both
application/SDK builds passed the existing type/source/generated/native/product
gates; the SDK verified 63 artifacts and its isolated TypeScript consumer.
The source closure remains 919 files and the product gate remains 133
registrations with native qualification false. All 1,184 protected implementation,
native, public, contract/reference and fixture files match baseline exactly.
Whitespace/project checks pass; the existing build chunk-size advisory remains.

Observed browser: Chromium 156.0.8078.4, Windows/Win32, secure loopback,
cross-origin isolation false. These are actual DOM appearance/focus checks in
the synthetic availability harness, with no native/GPU or new service-worker
authorization qualification. The previously recorded genuine update checks
remain scoped to their earlier fixture bytes; the full portable/offline matrix
was not repeated for this styling-only amendment.

Amended application input:
`1139e94ca6f4a492256dda350cd9a4de3dbfddd2a84e03d5ccfcdc4eaba8d990`.
Local deployment:
`0009d832338adf17adf9c7e0823ecb449374bc4e967f869ad56d128d2578c793`.
Native input and standalone renderer source identity remain as recorded above.
No new application release or deployed-site qualification is claimed.
