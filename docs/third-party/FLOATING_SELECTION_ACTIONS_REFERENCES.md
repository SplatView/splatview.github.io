# Floating selection actions: references and scope

Validation passed: 6,050 CPU tests in 182 files, 105 production-browser cases in one complete run, 14 executed native module suites, and 90 Python checks (1 existing host-dependent probe skipped). [Validation record](../validation/runs/floating-selection-actions-web-20261017-01/validation.json).

This record identifies the source basis and implemented behavior of the manual/filter floating Check, Undo and X slice. Qualification covers the recorded Windows Chromium and native/CPU checks; complete desktop visual parity and measured performance remain open.

## Pinned desktop authority

The design reference is SplatView **1.0.2**, commit `4e1be155511fb49f08fd8c863d785ac008a4c43a`, retained at `.build/current-desktop-chrome-tests/desktop-source/`. Source identities below are copied exactly from `.build/color-fill-range-tests/next-floating-plan-01.json`; they identify the reference inputs, not the subsequently edited web implementation.

| Desktop source, relative to the pinned source root | Bytes | SHA-256 |
| --- | ---: | --- |
| `src/selection_ui.cpp` | 51604 | `4ca42d85710ed6d216236b37636be3c80d65bb9c0d36661174daa0ee434fddc1` |
| `src/viewer.cpp` | 50881 | `bfda494deb74fa0bf770f85eab2634a9970ddf956f275f0124bdcdba72fc70f1` |
| `src/viewer_selection.cpp` | 93810 | `66196cd6bf505aae0ea2229f66b73eecd6527264a57f65f57817d30a4b9ec1fa` |
| `src/viewport_tools.cpp` | 45727 | `9e158605dd842b9fa1b5ac9b62863a7670b1db0cc1c66f5900ae473911cb0ca9` |
| `src/viewer_processing.cpp` | 37398 | `27a29c251b29509b35404ea7d2276925443cb7a134c9ae5efbcfe92517eb358f` |
| `src/ui_widgets.hpp` | 21262 | `5a8d2b2f0e9402f7aafdc8cee62a5e7e04225c1834e3530d787498efce24d2af` |

The principal desktop anchors are `AppUi::selectionFinishOverlay` in `selection_ui.cpp`, `Viewer::finishSelectionTool`, `Viewer::clearSelection` and `Viewer::undoSelectionAction` in `viewer.cpp`, and `Viewer::canUndoSelectionStroke` / `Viewer::undoSelectionStroke` in `viewer_selection.cpp`. The additional history reference is `SceneEdits::canUndoSelectionSince` in `src/editing.cpp` at the same pinned commit.

The same planning packet records these pre-implementation web seams:

| Repository path | Bytes | SHA-256 |
| --- | ---: | --- |
| `src/ui/ManualSelectionFeedback.tsx` | 13062 | `6430713c1007a4b9b44eef6a18ba4bcad3189f0382b8c751f4f8b5d7a7be1911` |
| `src/ui/FilterOverlay.tsx` | 7770 | `fe89498bb9716d0fe17740ee389e972d4b9c05e27e1ac19e19db9a78ce8d6830` |
| `src/app/controller.ts` | 436544 | `4692846cb3ef195b3a58f1762a023456a74339598f1a94df6be337f59518d2ea` |
| `src/document/filterProtocol.ts` | 8435 | `6f54e0b1b36a50cfa6edc692679b6dd8d0cfb8e5202520d445cb989b85a1c0a7` |
| `src/document/types.ts` | 8437 | `120ab8f9397383c7d428b509ab6df58127105f43450fd39081efe067f11832e7` |

## Manual selection behavior

- **Check** finishes a valid polygon through the existing polygon path, joins released Color/Fill work and pending amendments, retires the completed tolerance owner, then returns to Orbit while retaining the selection. Native owner retirement must be acknowledged before the action reports success.
- **Undo** prioritizes an unfinished gesture, then the newest released FIFO item, then an applying/waiting tolerance operation. A canceled completed tolerance operation uses the authoritative `toleranceRecorded` value to decide whether its click created history. The settled history fallback uses ordinary Undo.
- **X** stops unfinished or pending selection work, joins cleanup and the color boundary, then clears selected highlights. The manual tool remains armed. The clear itself remains undoable when it changed selection.

Actions retain client, document, source-generation and tool guards across awaits. They must not apply a late clear/undo to a replacement source or report successful cleanup while an old native tolerance owner remains.

## Filter behavior

- **Check** uses ordinary latest-preview confirmation and its existing request/attempt fences.
- **Undo** cancels an in-flight or changed draft. When the draft is unchanged, it cancels the draft and undoes committed history. It then reopens the same filter enclosure and Combine mode paused, without automatically evaluating current desired parameters.
- **X** retains the last acknowledged visible preview in history, clears highlights, and reopens the same enclosure paused. It does not evaluate a newer dirty or invalid desired parameter set merely to clear the visible selection.

The shared controls follow the desktop three-button, 90-by-28 design, with release-safe placement, viewport obstacle handling, and capture/popup/tutorial suppression. Layout refresh is driven by actual events rather than an idle polling loop.

## Native and wire additions

`selectionFilter:2` adds required `filter.changed:boolean`. This reports whether the last accepted preview's membership differs from the original filter baseline, including equal-count identity swaps. Begin reports false. Pending work retains the previous accepted value. The native filter job computes the value during its existing bounded evaluation pass after final captured-view clipping, and publishes it with the accepted mask. A fixed boolean is copied with the filter owner and transaction snapshots; summaries do not compare N records.

`selectionActions:1` adds required top-level `toleranceRecorded:boolean|null`. It is null exactly when there is no completed tolerance owner; otherwise it is the native checkpoint's `recorded` flag. No-op picks and metadata-only amendments can remain false. An amendment back to the exact original baseline removes its empty click Undo and changes true to false. Response preparation predicts this scalar before history/mask/owner publication. Transaction rollback restores it; retirement, source replacement and fresh recovery clear it with the transient owner. The existing Range DTO shape and `colorFillRange:1` remain unchanged.

The same capability permits the additive command field `visiblePreview:true` on `confirmFilter`. It confirms only a matching owner's current acknowledged `previewEpoch`, with no active job. It can therefore retain visible epoch1 after a newer epoch2 attempt was canceled. Omitted `visiblePreview` preserves ordinary strict latest-epoch and attempted-epoch checks. False, nonboolean, missing/mismatched identity or epoch, and active-work cases refuse publication. This flag does not accept replacement parameters or acquire a new selection mask.

There is no additional persistent N-sized mask or distance cache. These additions use fixed scalar metadata and the existing job result, selection checkpoint and history. ABI24, protocol28, UI23, transformPivot2, Range1, receipt2, recovery codec3, recovery plan2 and recovery metadata2 remain unchanged; no new durable checkpoint fields or C exports are introduced.

The native authoring inventory is `.build/floating-selection-actions-tests/native-authoring-02.json`. Contract source additions exercise equal-count changes, pending/no-op/deleted/current-view cases, cancel/confirm, explicit visible confirmation, transaction rollback, reply/allocation refusal, recorded tolerance transitions and transient recovery. Their authored PASS markers include `SPLATVIEW_FILTER_CHANGED_CONTRACTS_PASS` and `SPLATVIEW_TOLERANCE_RECORDED_CONTRACTS_PASS`. The validation record binds execution of these native module factories to the frozen source and production build.

## Limits of this slice

Exact generic manual per-tool history visibility remains deferred. The newer desktop carries a creation/amendment stamp on each selection history entry; current global revision/count/content fields cannot reconstruct that stamp after Undo/Redo, amendment, rollback and history trimming. `filter.changed` and `toleranceRecorded` provide exact information for their retained owners without claiming that missing generic history signal.

Transform-gizmo drag-session history and its floating Undo/X actions are a separate phase. Numeric transform and opacity keep their existing explicit Apply/Cancel controls. Full visual parity, cross-browser behavior and performance are not claimed by this implementation record.

## Copyright and licensing references

The pinned desktop reference's original application notice is `.build/current-desktop-chrome-tests/desktop-source/LICENSE`: **SplatView — Proprietary Software Notice**, copyright 2026 OpsiClear LLC. Its third-party notices remain separate. The frozen portable macOS source package retains its own MIT notice at `native/upstream/splatview/LICENSE` and dependency notices at `native/upstream/splatview/THIRD_PARTY_PORT_NOTICES.txt`. These distinct source notices must not be conflated.

No PlayCanvas code, assets or new PlayCanvas-derived logic were added in this slice. Existing project references and notices remain applicable to their own previously integrated components.
