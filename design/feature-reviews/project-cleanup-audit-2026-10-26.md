# Feature review: second project cleanup audit

Reviewed October 26, 2026 before implementation. Baseline:
`15b57e39c7d6df739d4f485de38f7dfca9932358`, with a clean working tree. The user
requests another audit and cleanup after historical evidence was archived.
Read the shared product contract/template, AGENTS, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capabilities and approved UI differences. Consume the
local sealed product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

## Findings selected for cleanup

The maintainability review covers the source map, import/dependency directions,
maintained documentation, verification tools and one standalone-renderer trace
through factory, worker transport and executor. Separate code, design and
anti-pattern notes were reviewed sequentially before selecting these fixes.
There is no product UI change or applicable dark-pattern surface.

1. **An interrupted cache write prevents a later fetch from recovering.** Code
   smell; medium severity, high confidence. Evidence:
   `tools/evidence.py:151`, `with self.cache.open('xb') as output, temporary.open('rb') as source:`.
   A bounded fault-injection probe wrote 187 of 375 synthetic archive bytes and
   raised an I/O error. The partial cache remained; the next fetch failed with
   `Archive hash/size mismatch` without attempting a download. The download
   temporary is cleaned up, but the newly created cache has no failure cleanup.
   Keep exclusive creation and existing-cache verification. Remove only the
   cache owned by the failed publication; preserve a concurrent replacement or
   a file created by another process. Verify recovery, refusal and ownership.

2. **Maintained guides still link directly to archived files.** Design smell;
   low severity, high confidence. Evidence:
   `tools/bench/README.md:288`,
   `[attribute-export qualification](../../docs/validation/runs/generic-export-20261016-01/validation.json)`.
   The active renderer guide, allocation reference and benchmark guides contain
   31 such links. Update their destinations to the corresponding catalog groups,
   retain original historical descriptions, and extend the project layout check
   to catch this specific regression in active guides. A pre-existing missing
   export-contract source link retains its original filename as text. Do not
   rewrite frozen captures, feature reviews, receipts or vendor documentation.

3. **Two browser configurations are absent from normal TypeScript checks.** Code
   smell; low severity, high confidence. Evidence: `tsconfig.json:18`,
   `"playwright.engine.config.ts", "playwright.config.ts", "playwright.selection.config.ts"`.
   The actual compiler input list excludes `playwright.compat.config.ts` and
   `playwright.offline.config.ts`. Use one root Playwright configuration glob
   so current and future browser configurations receive the existing checks.
   Validate the compiler input list and normal typechecks/build contracts.

## Platform and surface policy

| Target | Policy and reason | Implementation and qualification |
| --- | --- | --- |
| Windows development / editor | Required consistent source verification; optional historical fetch uses existing Python and filesystem support. | Exercise cache ownership, typechecks and documentation checks on this host. No editor/runtime feature change. |
| macOS development / editor | Required equivalent maintainer checks; cache cleanup uses portable Python file identity without a new filesystem/link dependency. | Portable tests cover the logic; no Apple runtime, Metal or Quick Look qualification. |
| Ubuntu development / editor | Required equivalent source/tooling behavior and explicit optional fetch. | No Vulkan, SDL, installed-host or native qualification. |
| Web-lite / standalone module | Required preservation of viewing/editing, renderer APIs, defaults, input, formats, persistence, tutorials and resource ownership. | No browser UI or runtime logic change. Compile/build the existing browser configurations and standalone distribution. |

Windows Explorer, macOS Quick Look, GNOME/KDE previews and thumbnail providers
are unaffected; this change does not reach their runtime/provider entry points.
The archive CLI and verification are maintainer surfaces only. There are no
new commands, public/native action registrations, profile migrations, worker
budgets, source-overwrite operations or product permissions. Existing controller,
history, admission, cancellation and GPU retirement owners remain authoritative.

## Scope, validation and deferred work

Keep all source/toolchain/dependency locks and frozen/native/WASM inputs. Preserve
the archive catalog, published archive bytes and both retained witness pins.
Application builds must still work without downloading historical evidence.
No compatibility barrels, framework, scheduler or resource owner is introduced.

Run focused evidence-tool tests for failed writes, verified existing caches,
concurrent publication/replacement and active-guide archive links. Run the
project/product/source/generated/toolchain/build/type gates, Python tool suite,
Node build contracts and portable tests appropriate to these changes. Record
actual outcomes, failures, source/build identities and limits below. Browser
runtime qualification from the previous cleanup is historical; compilation is
not a new hardware/browser qualification.

The renderer/resource boundary was traced through `src/engine/index.ts`,
`src/renderer/factory.ts`, `webgl2/computeClient.ts` and `computeExecutor.ts`.
The shared `document/resources.ts` contains the intentional authenticated credit
and ledger owner. Moving that owner solely to change its directory would add
import churn without establishing a new boundary. A candidate WebGPU import
cycle involves `GaussianRenderer` only as a type in `surface.ts`; do not report
it as a demonstrated runtime initialization defect.

The 6,621-line controller and 2,104-line App remain possible future extraction
targets, but size alone does not justify changing their state/history ownership.
The original native receipt collector's filter-diagnostic failure remains a
separate qualification task. Do not loosen that guard or refresh native inputs
to turn this source-cleanup audit green. No linter or dependency analyzer is
present; use existing compiler, contract and test tools.

Audit probes and the exact baseline file inventory are local under
`.build/project-cleanup-20261026-02/`.

## Implemented result and checks

All three selected fixes are implemented. Failed cache writes and failed member
verification remove the cache only when its filesystem identity is still the
one created by this fetch. Exclusive creation, prior-cache verification,
concurrent replacement and original archive hashes remain enforced. Focused
tests reproduce interruption/retry, competing creation/replacement and corrupt
member refusal. Existing historical receipts and archive bytes are unchanged.

The 31 archived-file links now point to existing catalog groups. The active
maintainer-guide scan has no missing local links or catalog anchors. Project
verification also rejects regressions in these archive links while allowing
the two retained, byte-pinned witnesses and historical review references.
The actual compiler input list includes all five Playwright configurations.

Checks run on Windows with the existing locked Node toolchain and development
Python:

- `python -B -m unittest discover -s tools -p test_evidence.py`: 15 tests passed.
- `npm run verify:project`: passed; no historical payload fetch is required.
- `npm run build`: passed source locks (919 files), generated assets and native
  translations, sealed product adapter, native/toolchain verification, both
  TypeScript checks and production build. Existing large-chunk advisory remains.
- `npm run build:engine`: passed, including 63 distribution artifacts and the
  isolated TypeScript consumer. Renderer source identity remains
  `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.
- Full Python tools: 115 tests, 114 passed and one existing skip. Node build
  contracts: 40 passed. Vitest: all 6,480 tests passed.
- `tsc --noEmit --listFilesOnly`: confirmed base, selection, engine, compatibility
  and offline configurations are included.
- `python -B contracts/product/tool.py verify --root .`: passed for bundle 2.0.0,
  all 133 registrations; native qualification remains false.
- `python -B tools/evidence.py verify`: verified all 1,089 archive paths, sizes
  and SHA-256 digests. Baseline comparison preserves all 1,265 runtime/native/
  public/contract/reference/fixture files byte for byte.
- `git -c core.whitespace=cr-at-eol diff --check`: passed.

The generated app build identity correctly changes with the TypeScript config.
App input is `b5d48b7284342d60110a7172cf373c6fb6d5c89062f0a8acdc011f85b4ea3dd4`;
local deployment ID is
`3c378314da6d712a504a28ba1f19c0aa8955dc8eedc63c2097d5d16251d27479`.
The native input remains
`59b0d5f23b429590c4804a68ecba23fb6d3b0b1c3c44f17cb92d6b5ba81b3230`.
These are local build identities, not a new published application release.

No browser cohort was rerun for this tooling/configuration-only change.
Previous Windows/Chromium/RTX 5090 secure-localhost observations remain
historical and are not relabeled as current browser/OS/GPU qualification.
Portable tests and compilation do not qualify macOS, Ubuntu, Safari, offline
hosts, native editors or preview/thumbnail providers. The native receipt
collector was not changed or requalified in this pass.

Coverage: code smells and design smells reviewed and fixed; anti-pattern lane
reviewed with no additional evidence-backed finding; dark-pattern lane is not
applicable to these maintainer tools. The source/tool/test scan found no
byte-identical whole files over 200 bytes outside fixtures. The type-only import
cycle and shared ledger location were investigated and not reported as defects.
The deferred controller/App extraction and strict native receipt qualification
remain the bounded backlog; no speculative refactor was introduced.
