# Feature review: source layout and historical evidence ownership

Reviewed October 26, 2026 before implementation. The user requests project and
structure cleanup after finding too many JSON files on the source branch.
Baseline: `8a6b069aa10889b6a436d84ab8bdebed8845baab` / published v0.2.1.
Read AGENTS, shared product contract/template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger and approved UI differences. Consume
sealed local product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
Preserve all 133 registrations, source/toolchain locks, generated inputs,
native/WASM contracts and existing runtime/history/worker owners.

## Evidence and scope

The source tip tracks 502 JSON files / 180 MiB. The root contains 149 generated
report/log/command files among 172 tracked root files. Historical validation
contains 921 files / 261 MiB in 111 run directories. JSON contracts, translation
data, fixtures and source captures are separate maintained inputs.

The maintainability review uses independent code, design and anti-pattern lanes
for repository layout, output ownership and evidence references. Product UX is
outside this change. The lanes are synthesized into two high-confidence fixes:

- Generated qualification files occupy the maintained source layout. Concrete
  producer evidence: `tools/run-native-contracts.mjs:60`,
  `Expected --output docs/validation/runs/NEW-RUN/NAME.json.`. Root examples recur
  across `test-results-cleanup-*`, `test-results-json-cleanup-*` and
  `test-results-viewer-shell-*`. Preserve their bytes while moving historical
  payloads behind an explicit archive boundary.
- Browser output locations are implicit across the main, compatibility, engine
  and offline runners. Set explicit ignored output directories and add a
  project-layout check so generated reports are not committed by accident.

Existing source/module ownership is intentional. Keep the current renderer,
controller and worker boundaries; a broad code rewrite is not justified by
these layout findings. Add a project map and evidence workflow for maintainers.

## Platform and surface policy

| Target | Policy and reason | Implementation / qualification |
| --- | --- | --- |
| Windows development / editor | Required maintained source layout; archive inspection conditional on existing development Python support. Preserve native editor behavior and pinned inputs. | Implement and test the developer tools locally. No Windows native runtime/package change or new native qualification. |
| macOS development / editor | Required equivalent source layout; Python/standard ZIP tooling provides the same optional historical inspection. | Portable tool tests do not qualify Apple runtime, Metal or Quick Look. |
| Ubuntu development / editor | Required equivalent source layout and development workflow. | No Vulkan/SDL/installed-host change or new desktop qualification. |
| Web-lite / standalone browser module | Required unchanged product behavior, API/defaults, formats, persistence, tutorials and worker/resource contracts. | Repository/build/test tooling changes only; qualify source/build and relevant browser checks separately. |

Explorer, Quick Look, GNOME/KDE previews and OS thumbnail providers are unaffected.
The archive CLI is a maintainer surface, not an agent or browser UI feature.
No public action/native/API/CLI registration, profile migration, rendering
quality/default, source-overwrite or OS persistence capability is introduced.

## Migration and invariants

Create one deterministic ZIP of the tracked historical run payloads, generated
root reports and old loose validation receipts. Keep active schemas/templates,
runtime JSON, tests/fixtures, native/reference/product captures and all feature
reviews in source. Record every original path, size and SHA-256, archive size
and SHA-256, and the exact source revision. Verify every ZIP member against the
original file and Git blob before removing its loose copy. Preserve local
untracked browser outputs under ignored `.build/validation/` with a location map.

Publish the already-public historical bundle and its checksum as additional
assets on v0.2.1. Preserve the existing release assets, tag and receipts. Source
keeps a compact catalog and an explicit fetch/verify/show/extract tool. Builds
must not fetch the archive or depend on its cache. Extraction checks paths,
bounded sizes, hashes and existing-file conflicts, and never overwrites differing
files. Historical receipts retain original addresses and bytes; materialize
them explicitly when using strict existing evidence readers. Do not add an
implicit fallback or weaken their path/hash/ownership checks.

New browser reports go into `.build/validation/`. Native-contract collection
accepts that location while retaining its existing explicit legacy output form.
Ignore old collection paths and check the tracked project layout. Keep all
dependency/toolchain versions and frozen source payloads unchanged. Update
maintained documentation links to the catalog; frozen review/provenance text
remains historical and unchanged.

## Validation

Require archive hash/member/Git equivalence, complete restoration, refusal of
unsafe paths/corrupt or missing data/conflicting extraction, layout checks,
existing product/source/native/generated/build/type gates and portable tests.
Compare runtime/native/fixture source bytes to the baseline, inspect actual
browser test output placement, and verify app/SDK artifacts. Record actual
results, failures and environment below. Publishing the archive does not publish
a new application release or change the live site's qualification.

The retained-input scan found two historical JSON witnesses pinned by the
unchanged core13 compatibility manifest and desktop font fixture. Retain their
original paths/bytes in source as explicit checksum-checked catalog exceptions.
All other historical payloads move to the archive. No fixture or witness pin is
rewritten, and archive availability is not a build dependency.

## Implemented result and qualification

The archive contains 1,089 original files / 286,745,481 bytes. It is published as
`historical-evidence-v0.2.1.zip` (122,059,353 bytes), SHA-256
`ee37c1e7a37ac583ce8afe0a5c89f4584bc847c9459c27378267e48f39794f94`.
Every original filesystem file, Git blob and archive member was compared by size
and SHA-256. The published asset was downloaded again and all 1,089 files were
restored and verified before removing 1,087 loose copies. Two pinned witnesses
remain in source. Existing release assets, application tag and live static
branch are unchanged. Git history still contains the historical files.

Maintained source now has 1,904 files (previously 2,985), 144 JSON files
(previously 502), and 23 root files (previously 172). The catalog replaces the
loose reports; maintained links point to its groups. Another 829 links already
referenced local reports absent from the baseline Git tree. Their filenames
remain as text, without implying those reports exist in the archive. Frozen
reviews, original receipt bytes and fixture pins were not rewritten.

Verification on the final implementation:

- `npm run build`: passed the 919-file source lock, generated assets and native
  translations, product adapter, pinned native/toolchain verification, both
  TypeScript checks and production build. The existing large-chunk advisory
  remains. Product bundle 2.0.0 verifies all 133 registrations; native
  qualification remains false.
- `npm run build:engine`: passed, including 63 standalone artifacts and an
  isolated TypeScript consumer. Renderer source identity remains
  `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.
- Vitest: 6,480 tests passed. Python tools: 109 tests, 108 passed and one existing
  host-specific skip, including nine archive-tool tests. Node build tools:
  40 tests passed.
- Browser checks: eight application tests and 14 standalone renderer tests
  passed with zero failures, skips or retries. Actual output directories are
  `.build/validation/playwright/` and `.build/validation/engine/`. Coverage
  includes automatic WebGPU failure fallback, both renderer-mode transitions,
  WebGL2 editing/context recovery and standalone WebGPU/WebGL2 rendering.
- Browser environment: Windows, Headless Chromium 156, NVIDIA GeForce RTX 5090,
  ANGLE/D3D11 for WebGL2; localhost is a secure context and is not cross-origin
  isolated. Chromium uses the existing `--enable-unsafe-webgpu` test flag.
  These checks do not add macOS, Ubuntu, Safari, interactive-browser, other-GPU,
  offline-host or native runtime qualification.
- All 1,265 protected runtime/native/public/contract/reference/fixture files
  match the baseline exactly. The generated application build identity changes
  because `package.json` adds a maintainer command; rendering code is unchanged.
- `npm run verify:project`, the explicit product gate and archive verification
  passed. Maintained links to archived files resolve to existing catalog groups.

The optional linked-native receipt collector was exercised with the new output
path. It accepted that path and ran until its unchanged filter-output guard
rejected `FILTER_CHANGED_GROUP_PASS` diagnostic lines. The original collector
from the baseline commit fails at the same guard with its legacy output path.
No complete new native receipt was produced. Preserve this existing failure;
do not weaken the diagnostic guard or refresh frozen native inputs as part of
source-layout cleanup. Qualifying that collector against its current linked
contract output is separate follow-up work.

Raw checks, source comparisons, archive/restore proof and the preserved collector
failure are local under `.build/project-cleanup-20261026-01/`. Existing untracked
browser results were moved intact into `.build/validation/legacy-local/` with a
location/digest map. Future raw runs stay ignored; curated records and archive
digests remain source-controlled. No dependency, product registration, renderer
ownership or controller/history migration was added.
