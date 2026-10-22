# Selection dependency snapshots, immutable metadata and buffer accounting

Reviewed October 18, 2026 before implementation, following the user's request for another modularity/developer-experience review. This is a bounded internal follow-up to the [module refactor](selection-modularity-2026-10-18.md). Root instructions and its selection guide, the shared product contract/latest amendment/template, current README/plan/status and capability/UI-difference inventories remain the applicable sources. Product bundle 2.0.0 stays pinned to `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`. Exact preimages are retained in `.build/selection-dx-review-20261018-01/preimages.json` before edits.

## Findings and smallest changes

Independent design and code lanes inspected the application/cache boundary and GPU query/buffer contracts, respectively. These are maintenance hazards rather than observed selection-result failures.

1. **Dependency capture and execution are mixed.** Medium severity, high confidence, code/design smell. Before changes, `src/app/selectionMaps.ts:46` says `const revision = { ...client.revision }, contentRevision = client.nativeContentRevision;`; line58 says `const current = () => {`; line73 says `const key = [identity(client), revision.documentId, revision.sourceGeneration, contentRevision,`. The request method coordinates captured render inputs, key encoding, validity checks, admission and native/GPU execution. Extract one app-owned dependency snapshot with a key, currentness assertion and captured render inputs. Keep the actual cache, admission, observation, GPU work and native adoption in their existing owners. Preserve intentional reuse across display grading and ordinary selection changes.

2. **Published map metadata is writable through a borrowed reference.** Low severity, high confidence, encapsulation smell. Cache line16 declares `readonly map: SurfaceMap;`, but `surfaceQuery.ts:42` declares `width: number; height: number; fullWidth: number; fullHeight: number;` and line48 declares `region?: SurfaceRegion;`. A TypeScript borrower can replace metadata used by coverage reuse. Make published metadata and array references readonly in the shared contract; preserve mutable typed-array contents and disposal. No runtime freezing/copying or new ownership mechanism is proposed.

3. **Buffer accounting mixes physical and host lifetimes inline.** Medium severity, high confidence, code smell. `surface.ts:60` includes `projectionBytes + colorBytes * (options.colors ? 2 : 1) + visibilityBytes * 2 + 144, 1);`; line63 includes `countBytes + layoutBytes * 2 + 96`. Extract a pure buffer-size plan with named retained CPU, host scratch and physical GPU totals. Explain parameter-block copies by their existing size constant. Preserve all sizes, allocation order, device checks, pool credits and count-first candidate admission. The query retains every lease/fence/cancellation/publication operation.

Deferred: pure readback-layout/decoding extraction could later reduce duplicated byte/float indexing, but it is not required for these three fixes. Keep the scratch pool and GPU state machine cohesive. No general allocator/dependency framework, compatibility barrel or broad controller rewrite is justified.

## Platform and surface policy

| Target | Policy / source evidence | Change and qualification |
| --- | --- | --- |
| Windows editor | Required existing composited selection; `selection_map.hpp` / `viewer_selection.cpp` and the prior platform review | Native D3D11/controller implementation remains; no new Windows host qualification. |
| macOS editor | Required existing native selection under the shared contract and prior source review | AppKit/Metal implementation remains; no Apple SDK/runtime qualification. |
| Ubuntu editor | Required existing query behavior; `render/query_contract.hpp` / `core/color_selection_session.cpp` and prior review | Vulkan/native admission remains; no GNOME/KDE session qualification. |
| Web-lite | Required existing Basic semantics, conditional on WebGPU, complete-query admission and current view/source ownership | Internal TypeScript contracts and pure planning only. Preserve full/partial fallback, readonly snapshot inputs, exact query output and native/history ownership; verify in the browser. |

Explorer preview, Quick Look, GNOME preview, KDE preview and thumbnail providers exclude editor selection and do not execute these modules. Their provider, permission and read-only policies are unchanged. There is no new UI/API/CLI command, registration, setting/default, tutorial, localization/accessibility surface, file-format change, source mutation or history/dirty effect. Native/WASM protocol, frozen source/toolchain locks and product bindings must remain unchanged.

## Verification plan

Add direct dependency/invalidation tables and independently calculated buffer fixtures. Add compile-time readonly guards and preserve writable array-content fixtures. Run the maintained focused CPU and 126-case development-browser lanes, including full/ROI pixel/native-mask oracles, Undo/Redo, refusal, cancellation, pooled credit and recovery. Run both typechecks, production/source/product/native checks and four current production Basic journeys. Preserve previous evidence; audit emitted assets and retire only bounded caches after owned services/runners stop, then restore the preview. Record actual results and failures before handoff. No remote deployment or staging/commit/push is requested.

Code/design lanes apply. UX/deceptive-pattern review is not applicable because no user flow changes; no rule-of-three anti-pattern claim is made.

## Completed result and evidence

All three findings are addressed. `selectionMapSnapshot.ts` now owns the cache dependency capture/key/currentness rules and captured render inputs; `DocumentSelectionMaps` keeps cache acquisition, admission, diagnostics, rendering/query execution and native adoption. Original key order, weak object identities, conditional preview/mask dependencies and display-grading/ordinary-selection exclusions remain. The snapshot and copied geometry are frozen; the existing mutable renderer boundary receives a localized copy of that small matrix. No scene channel arrays are frozen or copied by this change.

Published `SurfaceMap` metadata, channel references and profile snapshots are readonly in TypeScript. Existing typed-array contents and disposal remain available. `tests/surface-query.types.ts` contains negative compile-time guards for accidental metadata writes and positive array-content access; typecheck/build verifies these guards, without inventing runtime test cases or freezing large arrays.

`surfaceBuffers.ts` supplies readonly named per-buffer sizes and separate retained-CPU, temporary host/upload and physical-GPU totals. Fresh-query host-plus-physical accounting exactly matches the previous aggregate; pooled admission retains the previous host-only amount. Count-first candidate credit, real physical pool leases, buffer creation order/labels, device-limit checks, mapping, cancellation, retirement and publication remain in `surface.ts`. Independent static re-review of both extractions found no regression or new import cycle.

Passed 165 focused CPU cases in nine files: the previous 96 cases, 44 direct dependency-snapshot cases and 25 independently calculated buffer/overflow cases. The maintained command includes both new test files. All 126 development-browser cases and four production Basic/shipped cases pass with zero retries. Their existing independent GPU/full-map/native-mask oracles, Undo/Redo, failure/cancellation, cache upgrades, pooled accounting and device recovery remain intact. Both typechecks, 919 pinned sources, generated icon/catalog checks, product bundle 2.0.0 / 128 bindings, exact native artifacts and the production build pass. No test/build failure occurred in this packet. The complete CPU suite was not rerun; previous complete-suite evidence remains historical.

Browser evidence is Windows Chromium 156.0.8078.4, secure localhost and a nonfallback NVIDIA Blackwell adapter. This is an internal behavior-preserving refactor, with no new performance measurement or Apple/native-provider qualification. Existing source/toolchain locks, native/WASM outputs, UI and registrations are unchanged. The existing build chunk-size advisory remains outside this scope.

The [maintainer guide](../../docs/development/selection.md) now documents dependency snapshots, immutable borrowed metadata and the three accounting lifetimes. Readback decoding/layout extraction and broader controller decomposition remain deferred; neither is an unresolved defect required for this scope.

The final emitted distribution is audited as 100 runtime artifacts / 104 total files, with no stale assets. Only bounded Vite caches are retired after owned runners/services stop; preimages and prior diagnostics remain. [Canonical validation](../../docs/validation/runs/selection-dx-review-20261018-01/validation.json) binds source/helper identities, reports/command receipts, environment, product/native identities, build artifacts and cleanup. The local production preview is restored after cleanup. No staging, commit, push or remote deployment is performed.
