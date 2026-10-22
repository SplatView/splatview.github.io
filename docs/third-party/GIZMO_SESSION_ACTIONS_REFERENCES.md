# Transform gizmo sessions: references and scope

Validation passed: 6,139 CPU tests in 187 files, 113 production-browser cases in one complete run, 14 executed native module suites, and 90 Python checks (1 existing host-dependent probe skipped). [Validation record](../validation/runs/gizmo-session-actions-web-20261017-01/validation.json).

This record binds the implemented gizmo session behavior to the validation record above. Original private drafts are preserved with their source inventories. Full visual parity and measured capacity remain outside this qualification.

## Desktop authority

SplatView **1.0.2**, commit `4e1be155511fb49f08fd8c863d785ac008a4c43a`, captured at `.build/current-desktop-chrome-tests/desktop-source/`, is the behavior and UI authority. The prior [selection history](SELECTION_HISTORY_REFERENCES.md), [floating selection actions](FLOATING_SELECTION_ACTIONS_REFERENCES.md) and [pivot](PIVOT_REFERENCES.md) references retain their own scopes. In the table, `desktop/` abbreviates that pinned checkout only.

| Source | Bytes | SHA-256 |
| --- | ---: | --- |
| `desktop/src/viewport_tools.cpp` | 45727 | `9e158605dd842b9fa1b5ac9b62863a7670b1db0cc1c66f5900ae473911cb0ca9` |
| `desktop/src/viewer_processing.cpp` | 37398 | `27a29c251b29509b35404ea7d2276925443cb7a134c9ae5efbcfe92517eb358f` |
| `desktop/src/viewer.cpp` | 50881 | `bfda494deb74fa0bf770f85eab2634a9970ddf956f275f0124bdcdba72fc70f1` |
| `desktop/src/processing_ui.cpp` | 32682 | `cb283fae89a55a898817b73a23a035c80c1ad92a20f9edf54a0219d4e30b0587` |
| `desktop/src/ui_widgets.hpp` | 21262 | `5a8d2b2f0e9402f7aafdc8cee62a5e7e04225c1834e3530d787498efce24d2af` |
| `desktop/src/ui_design.hpp` | 15600 | `85e292656758ebf0c1fd542f8c41abc9318faa72db3beae3418e8471f59b3fe0` |
| `desktop/src/translations.inc` | 254928 | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` |
| `desktop/src/tutorial.hpp` | 10582 | `1e0fe1551a5d9f475c43635892146e03b09430e666180de52cf88072a2f05055` |
| `desktop/src/app_ui_tutorial.cpp` | 20106 | `87d5a2b27fb3625bd6f0eef9e0e07e5c85c1fa84b55c00384ec5ba02aabc7558` |
| `desktop/src/app_ui.cpp` | 79904 | `e42efb855d1b4cffbb3269ff1a3a2a1b983ed84c29d2af6cb1663b742ef1fd1e` |

`desktop/src/viewport_tools.cpp:182-215,412-454,950-981` defines arming, the floating Check/Undo/X tray and release of nonidentity drag deltas. The tray exists while armed, including before the first drag, and hides during capture. Each button is 30 by 28 logical pixels; the joined row is 90 by 28, scaled with the UI. `ui_design.hpp:12-16` and `ui_widgets.hpp:101-147` define dimensions and release-safe placement. `translations.inc:308-310` provides all eight locale rows: **Finish transform tool (Enter)**, **Undo transform**, **Cancel transforms (Esc)**. `app_ui.cpp:1563-1579` suppresses the ordinary viewport trays during tutorial/modal capture and accounts for their bounds.

`viewer_processing.cpp:104-188` separates the current drag's input from the first shared Cancel baseline. Each accepted drag starts from the current accepted geometry. Check keeps accepted geometry and retires the session. Floating Undo moves one eligible geometry entry while retaining the original Cancel base. X restores the exact original scene, mask and content identity through an ordinary undoable scene replacement, then retires the session; it does not erase the drag history. `viewer_processing.cpp:233-263` is the reset/restoration authority. Generic toolbar Undo can still fall back to preceding history at the gizmo base (`viewer.cpp:519-539`); the floating Undo eligibility is narrower.

`viewport_tools.cpp:633-675` gives captured Ctrl+Z priority over settled history: it discards only the unfinished delta. Enter finishes an idle tool; Escape cancels the session. `viewport_tools.cpp:892-909` rebuilds an idle widget from identity orientation/scale at the reference pivot. Keeping a rotated/scaled widget frame across accepted drags would not reproduce this behavior. Selection/Scene pivots refresh from accepted geometry; explicit Custom/Origin references remain explicit.

Header **Reset transform** has separate semantics: `processing_ui.cpp:384-406` and `viewport_tools.cpp:283-294` cancel the gizmo first, deactivate it, then reset alignment/numeric transform state and numeric presentation. The authored browser route now follows this order: `src/app/controller.ts:2896-2924` calls `cancelGizmoOwner` before entering the existing alignment/numeric Reset path; `tests/transform-controller.test.ts:728-733` exercises the command order and reset presentation. It does not send numeric-only `resetTransform` to a live gizmo owner. The phase qualification includes this controller command-order check.

## Native and transport authority

The additive capability is `proTransformSession:2` in `native/wasm/runtime-contract.json`. Protocol 28, UI-worker contract 23, core ABI 24, camera ABI 4 and durable codec 3 retain their existing versions. This does not introduce a new file format.

`src/document/transformProtocol.ts:20-27` defines the required `transformSession.gizmo` field: null for numeric sessions; for gizmos, paired nullable `cancelBaseId`/`cancelContentRevision` plus native `canUndo`/`canRedo`. The Cancel pair stays null until the first accepted nonidentity bake. New exact-ID/epoch commands are `rebaseTransform`, `undoTransform`, `redoTransform` and `cancelTransform`; Check uses existing `endTransform`. Numeric `resetTransform` remains numeric-only.

`native/wasm/browser_transform_session.hpp:21-43` retains an immutable, shared first Cancel baseline separately from the per-press canonical base. `native/wasm/bindings.cpp:748-897` admits exact current owners, freezes selected-only/current-view scope at each physical press, handles empty/neutral releases without a scene-history bake, and publishes native history eligibility. `rebaseTransformResult` rotates the base ID to current accepted geometry and clears applied delta metadata. Accepted cooperative completion at `bindings.cpp:2533-2552` captures the first Cancel base lazily, records the geometry replacement, then automatically rebases again. Keeping the Cancel baseline does not itself copy an N-sized Gaussian payload; ordinary accepted geometry/history remains budgeted.

`bindings.cpp:841-853` restores the original scene/mask/content ID through `BrowserSelectionAccess::restoreContentScene`, or moves actual native Undo/Redo and rebases. This gives X an undoable restoration entry. JavaScript does not reconstruct Gaussian transforms or approximate the original baseline.

Both `src/workers/document.worker.ts` and `src/document/coreClient.ts` independently validate cap2 session metadata and command transitions at ordinary results, operation/transaction terminals, readonly streams and recovery boundaries. Safe identities and monotonically increasing attempt epochs fence stale requests. A receipt without matching native session proof does not authorize publication.

| Frozen authored source input | Bytes | SHA-256 |
| --- | ---: | --- |
| `native/wasm/runtime-contract.json` | 1401 | `dc63d967fe892427b0788a7741d1d8da1b169bba204ed33629239eef3d64eea0` |
| `native/wasm/browser_transform_session.hpp` | 4043 | `e3274784c5e0a58acac46327eb3a1ca16a780547c7ed09d41c5be85f72c1561d` |
| `native/wasm/browser_transform_session.cpp` | 10783 | `df9576620efa91d0fa6f27e01f4a066ab97c39a0220210c8cb644eba2eed7f4a` |
| `native/wasm/browser_document_checkpoint.cpp` | 43867 | `0877c971ffc9a8cdbc99f6822b03f424bf6919b519cdba9512ac83a8efda6f43` |
| `native/wasm/browser_document_checkpoint.hpp` | 5663 | `ed2ba12f32a8d5fbaae39c48cf97ec62df8caead4823dc022c26639c59172592` |
| `native/wasm/selection_checkpoint.hpp` | 18711 | `111fbd0a8f7fd27e002a71b6033d972bc14873e69833b6c59d528969a01b58b4` |
| `native/wasm/bindings.cpp` | 208980 | `e1997744742eefe079e64019aa90e2f8d2704a0ce8bbcc8669a2cc7f16c79441` |
| `src/document/transformProtocol.ts` | 23902 | `95063eee53f0e045d40c312ebeb2136508e60c863cc01dabcbd1dbbef1151d6c` |
| `src/document/coreClient.ts` | 137125 | `bfdf43aa1a3c5b3f72a87280f0eb08343a21177f809a971f5ebf632771eb064d` |
| `src/workers/document.worker.ts` | 75712 | `fe9297cd357c2e95ddc433ca25b92cf6ffffc2cee31729219f5f3dfece1cb4f1` |
| `src/app/controller.ts` | 468482 | `ab7516d9c17725b0aa60ffab8c2e781883ec90f7b9f5776dbd71bebf3124b51d` |
| `src/ui/App.tsx` | 171804 | `8fd6e964beca5b6417e2f29ed6846837a373c4652a38e3939bf4c86a66a8dc2e` |
| `src/ui/FloatingSelectionActions.tsx` | 11194 | `ac9ef901adff0f996788949ebdf7f73127b838f5466ed61c7ab2506697e04a60` |
| `src/ui/TransformGizmoActions.tsx` | 1651 | `8a7edcc93017612bd2e2154d2a0725e4d3991d44fcb107e5f6cc1181a900b1a3` |
| `src/app/translations/editing.ts` | 12879 | `638046691b14689dcb78f31cbf6bb33a14a7573107352843d1b3a3f4ea910214` |
| `native/wasm/gizmo_session_contracts.cpp` | 31353 | `40aac73009da327e435972a11888dba7563fb805fc42425bb42b77739ba92add` |
| `tests/gizmo-session-protocol.test.ts` | 8009 | `155b2bc34142683bb402e44148e388e97bf0a85d0ce444effc22dab0ef6240d6` |
| `tests/gizmo-session-module.test.ts` | 1301 | `35f8c933cca80046a7561dee17e1d92d03671104617a110e338857ea519d041d` |
| `tests/transform-controller.test.ts` | 71875 | `af26dc9cb4e27d4e98901a2cf8819bc1c6531b734782044a4285a713d92328f2` |
| `tests/transform-gizmo-actions-ui.test.ts` | 7559 | `d3e5573e86b4dbd75684575fd0d423f8b2c7c931ca626667c980c2042c5d512f` |
| `tests/production/gizmo-floating-actions.spec.ts` | 24847 | `3a6f5ad99f55fd5a3f7bff17229d977bd6921ab8e39c5ba0a6912d1f91c7c0ae` |
| `tests/production/build-compat.spec.ts` | 63036 | `d8d17fe826d4f7f046895862300e1b7d222b8d80d84b774455bec5cc3960db92` |

These are the frozen authored input hashes re-read for draft 03, not the final qualification seal. All 56 exact inputs were re-read; relative to frozen draft 02, only the production test changed. The complete inventory is in `next-tutorial-plan-03.json`. Generated build descriptors, identity and emitted artifacts are bound by the validation record above. The next tutorial packet is refreshed separately after documentation publication.

## Browser ownership and presentation

`src/app/controller.ts:2973-3004,3038-3100` owns the gizmo-action lane, press rebase, native bake and cancellation. A physical press keeps a synchronous gesture token while its asynchronous rebase runs; pose/release work waits for that admitted base. Captured Undo cancels unfinished intent before settled history. Check is admitted only for an idle, ready owner (`controller.ts:3027-3029`); Undo and Cancel join the work relevant to their captured owner. The queued lane rechecks source ownership before invoking an action, so replacement sources cannot inherit it.

The controller and App fence source/client/document/source-generation identity, owner and base IDs, press epoch, accepted summary, camera/view/viewport/device capture and physical gesture ownership. `controller.ts:4014-4021,4171-4191` streams an accepted changed base, adopts native session metadata, then publishes the accepted summary with its identity gizmo preview before invalidation and prior GPU retirement. This avoids displaying an accepted drag with the old delta applied again. The explicit press-rebase refresh at `controller.ts:2998-3002` updates owner metadata and preview even if the initiating unfinished gesture has already been canceled.

`src/ui/TransformGizmoActions.tsx`, `FloatingSelectionActions.tsx` and `App.tsx` attach explicit transform semantics to the shared tray. Transform X calls Cancel; manual/filter X retains Clear semantics. Presentation uses translated desktop tooltips, accessible names that distinguish the Undo buttons, separate source/mode-keyed release anchors, input admission and focus-return guards. Placement repaints on events and has no owned persistent idle animation loop. Existing gizmo rendering architecture is outside that narrow idle-loop statement. Basic/Pro retains an idle gizmo owner and its accepted history; Basic uses world axes. Numeric transform and opacity retain explicit Apply/Cancel.

## Worker replacement and graphics recovery

Codec 3 intentionally finalizes a gizmo on worker replacement. `native/wasm/browser_document_checkpoint.cpp:383-398,496-498` keeps accepted geometry and native Undo/Redo, but exports/restores no gizmo owner. Older codec-3 one-base gizmo metadata is normalized away because it cannot prove the original multi-drag Cancel baseline. Numeric absolute-session bases retain their existing codec behavior. `document.worker.ts:694-698` and `coreClient.ts:1075` reject a fresh recovery result that unexpectedly retains a gizmo.

Graphics-only recovery keeps the existing native worker and original Cancel owner. `controller.ts:885-901,1093,1237` captures the armed mode before cleanup and reinstalls it with readiness, avoiding a transient readiness watcher retiring the recovered owner. Device-bound rendering resources are recreated; the original source is not replayed merely to recover graphics. No claim of a complete browser/host recovery matrix follows from this bounded behavior.

## Authored acceptance and remaining scope

`tests/production/gizmo-floating-actions.spec.ts` authors four production cases using the shipped worker/native summaries, actual GPU projection buffers/uniforms, real masks and exported PLY data: incremental multi-drag geometry with Check; per-drag Undo/Redo and exact undoable Cancel; captured keyboard priority and profile continuity; and real GPU-device loss followed by graphics retry with retained Cancel ownership. `native/wasm/gizmo_session_contracts.cpp:96-264` authors native no-op, incremental/cancel, per-press scope, transaction, refusal, readonly and codec-3 recovery checks. Its successful-rollback oracle (`gizmo_session_contracts.cpp:66-73`) allows sparse vector capacity to compact while requiring exact logical owners/history, non-growth and settled retained admission. `tests/gizmo-session-protocol.test.ts` authors exact wire transitions; `tests/gizmo-session-module.test.ts` authors capability identity checks and imports the generated descriptor sealed by this validation. `tests/transform-controller.test.ts` authors source-lane, header Reset and atomic GPU-preview cases. The UI test and production capability expectation cover the presentation contract. Executed counts and the final source/build identity are recorded in the validation above.

The Scale production case now requests native axis handle IDs **12 and 13** at `gizmo-floating-actions.spec.ts:197,203`; its earlier Move IDs 1 and 2 supplied no Scale candidates. The exact repair-03 preimage is retained under `.build/gizmo-session-actions-tests/repair-03-preimages/tests/production/gizmo-floating-actions.spec.ts` (24,842 bytes, SHA-256 `4b3c890fa87a18439a0839ef2f9ca0e50cf9f073904a333e1c8081205ff37d73`). Only those two call arguments changed. The target helper still requires the actual native `data-gizmo-hit` before capture, and all geometry, covariance, masks, incremental bases, exported PLY and device-loss oracles remain unchanged. This repair is a test correction, with no new execution result claimed here.

The next bounded slice is the already planned current-source tutorial, keyboard and assistive/visual acceptance work, described in the private `next-tutorial-plan-03.json`. Full appearance, observed assistive-technology speech, cross-browser release acceptance, deployed HTTPS and measured limited-scene performance/capacity remain separate acceptance work. Physical Mac hardware is not a prerequisite for this browser app.

## Source notices

The pinned desktop checkout retains its own **SplatView — Proprietary Software Notice**, copyright 2026 OpsiClear LLC, at `.build/current-desktop-chrome-tests/desktop-source/LICENSE`. The frozen portable native package retains its separate MIT notice at `native/upstream/splatview/LICENSE` and dependency notices at `native/upstream/splatview/THIRD_PARTY_PORT_NOTICES.txt`. These notices describe different source inputs and must not be conflated.

No PlayCanvas code, assets or new PlayCanvas-derived logic were added for this gizmo slice. Existing ColmapView/PlayCanvas references continue to describe their previously integrated components only.
