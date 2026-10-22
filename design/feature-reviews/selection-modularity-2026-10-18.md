# Selection module boundaries and developer workflow

Reviewed October 18, 2026 before implementation, following the user's request for modular, organized code and long-term developer experience. This is an internal refactor of the qualified [selection optimizations](selection-interaction-optimization-2026-10-18.md), not a new editor feature. Root instructions, shared product contract/latest delivery amendment/template, current README/plan/status, capability inventory and approved UI differences were read. Product bundle 2.0.0 remains pinned to manifest `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`. Exact source preimages are captured in `.build/selection-modularity-20261018-01/preimages.json` before edits.

## Review findings and intended changes

Independent code and design lanes review only this subsystem. No UI, agent/API/CLI registration, native protocol, file format, settings/default, source lock, gesture, history or dirty-state behavior is to change.

1. Shared request/uniform knowledge is duplicated across application/cache/controller and buried in GPU execution. Evidence before changes: `selectionMapCache.ts:6`, `type Channels = { colors?: boolean; visible?: boolean; region?: SurfaceRegion };`; `surface.ts:174`, `new Float32Array(dimensions.buffer)[10] = scale;`. This is a medium-severity, high-confidence change-prevention/encapsulation smell: adding a channel or inspecting packed coordinates requires coordinated handwritten shapes and positional arithmetic. Introduce one pure typed query contract, named constants and uniform encoder; preserve all 48 bytes and existing fallback/admission behavior. Use the shared request type at each existing boundary and add direct layout/normalization tests.

2. `surfaceResources.ts` holds two independent lifecycles. Evidence: line11, `const preparations = new WeakMap<GaussianRenderer, Promise<Preparation>>();`; line70, `export class SurfaceScratchPool {`. This is low-severity, high-confidence insufficient modularization. Split into direct pipeline-preparation and scratch-pool modules, preserving state/cleanup exactly and avoiding an unnecessary compatibility barrel.

Keep the asynchronous GPU query together as the orchestration owner: its scope/fence/cancellation/retirement state is cohesive. Keep native adoption, cache replacement and history in their current owners. Add a concise subsystem map, invariants and reproducible focused validation commands so future contributors do not need ignored historical qualification helpers to select the right tests. Broader controller extraction is deferred; no evidence supports a large rewrite in this packet.

## Platform and host decisions

| Target | Policy and evidence | Adapter and qualification |
| --- | --- | --- |
| Windows editor | Required existing composited selection; desktop `selection_map.hpp` / `viewer_selection.cpp` and the prior review | Native D3D11/controller owners remain; no new native implementation or qualification. |
| macOS editor | Required existing native selection under the shared contract and prior source review | AppKit/Metal ownership remains; no Apple build/runtime claim. |
| Ubuntu editor | Required existing query behavior; `render/query_contract.hpp` / `core/color_selection_session.cpp` in prior review | Vulkan/native admission remains; no desktop/session qualification claim. |
| Web-lite | Required same Basic selection behavior, conditional on WebGPU, current source/view ownership and complete-query admission | Internal TS module boundaries only; full/partial coverage, pressure, cancellation, shader ABI and worker/native/history owners remain. Browser verification is required after refactoring. |

Explorer preview, Quick Look, GNOME preview, KDE preview and thumbnail providers exclude editor selection and do not load these browser modules. Their read-only/provider/file-permission contracts remain unchanged. This internal refactor adds no public headless/API surface, UI copy/icon/localization/accessibility change or tutorial topic.

## Validation and handoff

Run shared query/uniform tests and existing pipeline/pool, coverage/layout and cache/adoption suites. Run the qualified 126-case selection browser cohort, including independent GPU oracles, partial/full native masks, Undo/Redo, preparation, cancellation, memory pressure and device recovery. Run typechecks, source/product/native checks, production build and four current Basic production journeys. Preserve prior evidence, native leaves and source locks; audit emitted assets and bounded Vite caches after runners stop, then restore the local preview. Record actual results and any failed attempts here before handoff. No staging, commit, push or remote deployment is requested.

Code/design lanes apply; deceptive-pattern/UX and rule-of-three anti-pattern lanes are not applicable to this internal refactor. No user-facing behavior is added or removed.

## Completed result

The pure `surfaceQuery.ts` contract now owns shared request/result types, dimensions, coverage validation, named tile/flag/coordinate limits and the uniform encoder. Application/cache/controller signatures import the same request type. Shader region fields are named `coverageMinPacked` / `coverageMaxPacked`; all 12 words, f32 scale, flag values and 48-byte layout are unchanged. `surface.ts` retains its allocation/submission/check/fence/retirement/publication state machine. Independent static re-review found no new runtime/type import cycle or coverage/lifecycle regression.

Shader compilation and scratch-buffer ownership now live in `surfacePipelines.ts` and `surfaceScratchPool.ts`. Their implementation bodies are unchanged from the captured preimage. The original five pipeline cases and 21 expanded pool cases are moved intact to matching test files. The obsolete combined module/test is removed without a compatibility barrel. New ABI/normalization tests cover exact words, unsigned packing/exclusive maxima, empty versus full coverage, f32 scale, shader field/flag/workgroup agreement, malformed coordinates and fallback behavior.

Added `npm run test:selection` and `npm run test:selection:e2e`, with a strictly typechecked reusable browser configuration preserving the exact reviewed cohort and separate browser project identities. The new [maintainer guide](../../docs/development/selection.md) maps responsibilities, imports, ownership invariants, extension points and validation commands. Root contributor instructions now make cohesive modules/shared contracts and explicit lifecycle ownership an ongoing project convention.

Passed 96 focused CPU cases in seven files, all 126 development-browser cases and four production Basic/shipped cases, with zero browser retries. The developer commands themselves were exercised, including automatic development-server startup/retirement. The production build passes both typechecks, 919 pinned sources, generated icon/catalog checks, product bundle 2.0.0 / 128 bindings and exact native artifacts. Source locks/native outputs/registrations remain unchanged. The complete CPU suite was not rerun for this bounded refactor; the earlier 6,255-case report remains historical optimization evidence. No command/test failure occurred in this packet. A second focused CPU report follows a final boundary-fixture clarification; it is the selected final report.

Browser evidence is Windows Chromium 156.0.8078.4, secure localhost, nonfallback NVIDIA Blackwell WebGPU. Existing independent shader/full-map/native-mask, Undo/Redo, cancellation, refusal, pooled accounting and recovery checks remain in the 126-case cohort. No new performance measurement, Apple SDK/native host or remote deployment claim is made. The existing build chunk-size advisory remains outside this module refactor.

The emitted distribution is audited as 100 runtime artifacts / 104 total files with no stale assets, and only bounded Vite caches are retired after the owned services stop. Diagnostics and preimages are preserved. [Canonical validation](../../docs/validation/runs/selection-modularity-20261018-01/validation.json) binds actual source/helper identities, selected reports, all command receipts, unchanged native leaves, product/build identity and cleanup evidence. Broader controller extraction is the deferred backlog item; it would need a separate bounded ownership review. There is no unresolved implementation/test failure in this scope. The local production preview is restored for handoff; no staging/commit/push/deployment occurs.
