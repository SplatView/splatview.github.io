# Feature review: application UI module organization

Reviewed October 28, 2026 before implementation. User requests better project
organization. Baseline: clean source `224d91f4fda0a7e5399b17d56c496fef9ada5a0d`
(published web 0.2.2). Read AGENTS, README, WEB_PORT_PLAN, IMPLEMENTATION_STATUS,
capabilities/approved differences, selection ownership guide, the shared product
contract/template and prior project/Settings reviews. Consume sealed local
product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

## Evidence and selected changes

Apply the maintainability review workflow in module/fix mode. Code and design
lanes independently inspected the UI imports, presentation boundaries, callers
and tests before synthesis. The anti-pattern lane found no additional justified
rewrite. Product flows and visual design are preserved; no dark-pattern finding
or new UX behavior is inferred from this organization pass.

1. **Presentation modules are embedded in the app entry.** Code smell, medium
   severity/high confidence. Evidence: `src/ui/App.tsx:131`,
   `export function SceneExportDialog(`; `src/ui/App.tsx:392`,
   `function ToolsPanel(`. About, export, saved-view choice, selection controls,
   tolerance input and the Tools panel occupy roughly 500 lines before the
   2,103-line file's application component. Separate existing functions into
   cohesive modules, keeping their bodies, props, hooks and lifecycle intact.
   Extract the shared IconButton and ModalFrame directly; do not introduce
   component factories, compatibility barrels or a second state/history owner.

2. **Settings files lack a clear feature boundary.** Design smell, low severity/
   high confidence. Evidence: `src/ui/App.tsx:24`,
   `import { FontSizePicker } from './FontSizePicker';`, followed by Theme,
   rendering, language and Settings-dialog imports. Group these five existing
   components under `src/ui/settings/`, keeping shared focus/popup primitives
   and the global offline notice with their actual owners. Import modules
   directly and update current tests/docs; frozen evidence remains unchanged.

3. **Pure navigation tests depend on the entire application.** Design smell,
   low severity/high confidence. Evidence: `tests/collection-ui.test.ts:2`,
   `import { collectionArrowVisibility, collectionPageDirection } from '../src/ui/App';`.
   Move those pure functions to `src/input/collectionNavigation.ts`. Selection
   and export tests should import their actual presentation modules, including
   the unchanged pointer-option capture next to SelectionControls. This removes
   their incidental App/bootstrap/renderer dependency without changing oracles.

## Ownership and scope

Keep App as the composition, file-picker, input-routing, modal-priority and
viewport lifecycle owner. Keep the existing Tools component's retained folding,
scroll and grade-draft behavior as one component; its retention object remains
owned by App. Existing selection/controller/native-history ownership and the
focused validation invariants in `docs/development/selection.md` remain.
Extract modal implementations into `src/ui/dialogs/`; keep their original focus
hook, initiating refs, initial focus, containment/return and accepted export
format/controller semantics. Source files and component references move; actions,
selectors, markup, classes, defaults and controller calls do not change.

No controller/renderer/resource-ledger extraction, dependency/toolchain change,
frozen/native/generated authority refresh, new worker, scheduler, dispatcher,
wire format, action/API/CLI registration, capability removal or profile migration.
The 133 product registrations and current advanced compatibility code remain.
No UI folders, subtitles, interactions or tutorial targets are added or removed.

## Platform and host policy

| Target | Policy and reason | Adapter/implementation/qualification |
| --- | --- | --- |
| Windows editor | Required preservation of native controls, algorithms and shared product semantics; no native implementation needs a browser module move. | No native source/package/installer change. Qualify web behavior on this Windows host separately. |
| macOS editor | Required preservation of native presentation, host behavior and accessibility under the sealed policy. | No AppKit/Metal/Quick Look change or qualification. Missing host execution is an evidence gap, not an exclusion. |
| Ubuntu editor | Required preservation of native SDL/Vulkan/host contracts under sealed policy. | No Linux package or GNOME/KDE runtime/provider change or new qualification. |
| Web-lite / standalone browser module | Required behavior-preserving module structure. Existing browser, graphics, file/storage and memory conditions remain. | Check direct imports, product/source/build contracts, existing portable and real UI/selection/dialog browser paths. Standalone API/defaults and resource ownership are untouched. |

Explorer preview, Quick Look, GNOME/KDE previews and OS thumbnail providers are
unaffected: no runtime/provider entry point is changed. Browser-local saved views
remain browser-local; no scene-file overwrite or OS thumbnail update is added.
This is internal module organization, with no new UI/API/CLI surface or tutorial.

## Validation plan

Compare extracted function bodies with the baseline and account for every moved
file/import. Update existing tests to import actual owners, retaining all test
bodies/oracles. Typecheck and inspect module directions so leaf UI has no import
back to App; pure collection navigation must have no React/renderer dependency.
Run project/product/source/generated/native/build/type gates, full portable
tests, standalone build/consumer checks and meaningful browser cohorts for
selection, dialogs/focus, Settings/font/locale, saved views, navigation and
production WebGPU/WebGL2 editing. Follow the focused selection workflow for the
presentation move without changing GPU/native selection inputs.

Document the UI map and explicit ownership boundaries in existing development
guides. Record actual results, failures and browser/OS/GPU/security context;
portable tests do not qualify host behavior. The existing optional strict
native-receipt collector issue and cross-platform native qualification remain
separate. Raw evidence: `.build/validation/ui-organization-20261028-01/`.
This pass updates source only; publishing another application release is outside
this organization request.

## Implemented result and verification

App is now 1,572 lines instead of 2,103, a 531-line / 25.2% reduction. Its main
component body remains byte for byte identical. Eight extracted blocks retain
their original function/type bodies, apart from adding the required module
exports. The five Settings files differ only in relative import specifiers.
All nine affected existing unit-test files retain their oracles; only imports
changed. Seven portable-test imports of App are removed, and no portable unit
test imports App now. New leaf modules have no import back to App, and pure
collection navigation imports no React, renderer, worker or application module.

The new UI module map records each responsibility and preserved owner. Existing
project/selection guides link to it. There are no compatibility re-exports or
new framework layers. The retained App component still owns viewport input,
controller creation, pickers and modal priority. Extracted Tools retention,
selection controls and dialog focus use their original props/hooks/callbacks.

Actual checks on the implementation:

- TypeScript, project verification and application build passed, including
  919 pinned source files, generated assets/translations, native/toolchain
  verification, sealed product gate and both TypeScript projects. The product
  verifier reports all 133 registrations and native qualification false.
- Standalone build passed 63 artifacts and the isolated TypeScript consumer.
  Renderer source ID is unchanged:
  `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.
- Focused existing UI unit cases: 110 passed. Full portable suite: all 6,480
  passed. Node build contracts: all 40 passed. No new mirror-of-implementation
  tests or dependency/lint framework was introduced.
- Browser checks: 48 Settings/language/theme/font/focus, 126 maintained selection
  cases, 14 standalone, 40 production WebGPU, 40 production WebGL2 and six genuine
  offline/update cases passed. All 274 executions had zero failures, skips,
  flaky outcomes or retries. Cohorts overlap and are not unique capability counts.
- The fresh immutable offline fixture set is
  `19c90ef8c3fb70196e2ac0571fdd6789315d170f6054b757c95b9bdfd0322d31`.
  Root/project A/B native-history isolation, natural C-router rebind, Stay,
  Discard and download-acknowledged Save exercise the relocated modal/focus
  implementations through the unchanged real controller.
- Captured 11 production Settings layouts and compared them with published
  0.2.2 captures: ten are pixel identical. The remaining SteadySplats capture
  differs in 21 pixels confined to the rounded bottom-left corner (7 x 7 area),
  with all control/text pixels identical. This is consistent with the stochastic
  scene showing beneath that rounded corner; no control/layout difference was
  observed. Inspected the before/current Steady and Help captures. Desktop,
  narrow French and Large preferences retain their existing layout and controls.
- Exact source checks preserve all 1,184 controller/application, renderer,
  document/worker, native/public/product/reference/fixture and offline/standalone
  implementation files. Extraction proofs preserve the moved UI bodies and all
  existing assertions. New/updated maintainer-guide links resolve.
- Explicit product and project checks passed. The first staged whitespace check
  found copied in-file separator blank lines at EOF in three new modules;
  removing those lines resolved the staged check. All functional checks passed.
  The existing large-chunk advisory remains.

Observed host is Windows Chromium 156.0.8078.4, using the existing unsafe-WebGPU
test flag on secure localhost origins without cross-origin isolation. Browser
cohorts exercise actual WebGPU/WebGL2 and native editing on the NVIDIA host;
appearance harnesses remain explicitly separate from native/GPU qualification.
No native editor/provider, macOS/Ubuntu/Safari, other GPU, assistive-technology
or new performance/capacity qualification is claimed. Full Python tests were
not repeated because no Python/build-tool implementation changed; the existing
optional strict native-receipt collector issue remains separate.

The full portable/browser cohorts above ran before the final EOF separator
cleanup, at application input:
`27c7f7ee7d17153da997fee5afcbd340ad1eb4838554220b372408078dbd268f`.
Corresponding local deployment ID:
`b53733cfcd6c82cb3502ace56d071f35c7fb3035c2cb59592b6105b485b05a10`.
Native input remains
`59b0d5f23b429590c4804a68ecba23fb6d3b0b1c3c44f17cb92d6b5ba81b3230`.
These are source/local build identities; the published v0.2.2 site is unchanged.

After trimming only the trailing blank separators in collectionNavigation,
SelectionControls and ToolsPanel, extraction proof was repeated with EOF
separators excluded from the block comparison. All function-body bytes, main
App body, five Settings bodies and existing assertions remain identical.
The application was rebuilt through all source/product/native/type gates, then
five fresh production cases passed: SteadySplats settings/Undo, three actual
WebGPU-failure fallback paths and real WebGL2 editing. Those final cases had
zero failures, skips or retries. Earlier 274-case and genuine fixture evidence
retains its actual earlier identity; it is not relabeled as a rerun of these
last bytes. No strict evidence reader or source lock was weakened.

Final application input:
`f0d55b412e5dc634bd81326372a52241a3dd251946889b3287380fa6b8e488e0`.
Final local deployment:
`b5ce54cc76474297acdd1d2ffdd73d40dfd88e17c0b63af7c2e61f0296f70de3`.

Coverage: code/design lanes resolved the three selected organization findings;
anti-pattern lane found no additional justified rewrite; dark-pattern review is
not applicable to these behavior-preserving moves. A dedicated linter/dependency
analyzer is not present, so existing compiler/contracts/tests and direct import
checks were used. Further controller or viewport-event extraction is deferred
until a behavior-specific boundary justifies moving lifecycle state. No broad
renaming of fixtures, historical evidence or frozen source is appropriate here.
