# Manual selection history: references and scope

Validation passed: 6,084 CPU tests in 184 files, 109 production-browser cases in one complete run, 14 executed native module suites, and 90 Python checks (1 existing host-dependent probe skipped). [Validation record](../validation/runs/selection-history-web-20261017-01/validation.json).

This record covers the runtime history stamp and continuous manual-session behavior. Full desktop visual parity and measured scene capacity remain open.

## Desktop authority

SplatView **1.0.2**, commit `4e1be155511fb49f08fd8c863d785ac008a4c43a`, retained at `.build/current-desktop-chrome-tests/desktop-source/`, is the UI and behavior authority. The preceding [floating actions reference](FLOATING_SELECTION_ACTIONS_REFERENCES.md) identifies the Check/Undo/X design, filter behavior and original source notices.

`src/viewer.cpp:369-375` captures the entry revision only when entering manual selection from an inactive state. Switching manual tools and Basic/Pro preserves that continuous session. `SceneEdits::canUndoSelectionSince` in `src/editing.cpp:1019-1021` tests the top Undo entry's selection revision against that entry boundary. `Viewer::canUndoSelectionStroke` and `Viewer::undoSelectionStroke` in `src/viewer_selection.cpp:1196-1233` consume this authority. An empty manual tray cannot be inferred from `canUndo`, selected count, global revision changes or content identity alone.

The following pinned reference inputs retain their exact identities from the reviewed next-work packet:

| Desktop source | Bytes | SHA-256 |
| --- | ---: | --- |
| `src/viewer.cpp` | 50881 | `bfda494deb74fa0bf770f85eab2634a9970ddf956f275f0124bdcdba72fc70f1` |
| `src/viewer_selection.cpp` | 93810 | `66196cd6bf505aae0ea2229f66b73eecd6527264a57f65f57817d30a4b9ec1fa` |
| `src/selection_ui.cpp` | 51604 | `4ca42d85710ed6d216236b37636be3c80d65bb9c0d36661174daa0ee434fddc1` |
| `src/editing.cpp` | 47367 | `8913f0ecb49c25c53210ead1525e6176c68a5291f7ebe5068147390e662286b2` |
| `src/editing.hpp` | 14770 | `b19929b855a13d3654feb0d2bba50b2c09202e0e1d25148ce90c2e4dca1ca5fc` |
| `src/viewer_processing.cpp` | 37398 | `27a29c251b29509b35404ea7d2276925443cb7a134c9ae5efbcfe92517eb358f` |
| `src/viewport_tools.cpp` | 45727 | `9e158605dd842b9fa1b5ac9b62863a7670b1db0cc1c66f5900ae473911cb0ca9` |
| `src/viewport_tools.hpp` | 4972 | `05cc536cb573b01595135d87614768a50b4609466b7a8e5e1c59d40c7513e178` |
| `src/ui_widgets.hpp` | 21262 | `5a8d2b2f0e9402f7aafdc8cee62a5e7e04225c1834e3530d787498efce24d2af` |
| `src/ui_design.hpp` | 15600 | `85e292656758ebf0c1fd542f8c41abc9318faa72db3beae3418e8471f59b3fe0` |
| `src/translations.inc` | 254928 | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` |
| `src/app_ui.cpp` | 79904 | `e42efb855d1b4cffbb3269ff1a3a2a1b983ed84c29d2af6cb1663b742ef1fd1e` |

## Implemented web adaptation

`selectionActions:2` requires an own safe-integer `undoSelectionRevision` on native summaries. A selection-only Undo entry carries its creation or latest accepted amendment ordinary revision. Other top entries, empty history, unloaded/non-Gaussian scenes and restored historical entries report zero. The value is bounded by the current ordinary revision; `canUndo:false` requires zero. Recovered history with `canUndo:true` and zero is valid.

No-ops preserve the stamp. Returning an amended click exactly to its original baseline removes that empty history entry and exposes the preceding stamp. Undo/Redo, copies, transactions and trimming retain the entry's original stamp; Redo does not make old history fresh. New stamp creation is checked for JavaScript-safe overflow before publication. Existing cancellation remains noexcept.

The controller captures one boundary per continuous manual session. Manual tool switches, same-tool shortcut rearm, Basic/Pro and graphics-only device recovery preserve it. Orbit/reentry starts a new boundary; source or worker replacement retires the old session. An empty tray qualifies only when there is no selection draft and the top selection stamp exceeds the session boundary. Pending input remains independently visible. A canceled applying/waiting tolerance click needs both acknowledged recorded ownership and qualifying session history before it may Undo.

Client and worker validate the runtime scalar independently of receipt2 across command responses, operation status/commit/rollback, read-only streams/focus/export, draft previews and fresh recovery. Runtime capability2 fails closed when this metadata is absent or malformed. Isolated historical controller test doubles may omit the optional TypeScript property; actual runtime boundaries require it.

Each native history Revision adds one `uint64_t` (8 logical bytes); actual deque block memory continues through the existing admitted allocator/census. There is no N-sized cache or summary history scan. Restored entries default to zero without adding durable fields. Core ABI24, camera ABI4, protocol28, UI23, filter2, Range1, pivot2, receipt2, recovery plan2/metadata2 and codec3 remain unchanged. The frozen portable upstream source is preserved; `tools/build-core.py` applies the adaptation to its disposable overlay.

## Verification and remaining scope

The existing native selection-commit executable adds four history-stamp groups, for twelve total selection-commit groups. It covers creation, content exclusion, no-ops, original Redo identity, drafts, amendments, exact baseline return, transactions/copies, trim/admission, refusal/overflow, response rollback and restored unstamped history. The validation record binds actual module-factory execution to frozen source and production artifacts.

Four production-browser cases observe actual worker summaries and compare native masks with the real projection GPU buffer. They cover generic toolbar Clear across the continuous manual session, original Undo/Redo stamps and fresh reentry, nonselection top entries, and actual `GPUDevice.destroy()` followed by production graphics recovery. No replacement native results or development-only app exports are used.

Gizmo drag-session Check/Undo/X, tutorial/complete visual and assistive acceptance, remaining retained-format/recovery/HTTPS checks, and measured limited-scene capacity remain separate work. Physical Mac testing is not required for this web-app slice.

## Copyright and reuse

The pinned current desktop application retains its **SplatView Proprietary Software Notice**, copyright 2026 OpsiClear LLC, in its own `LICENSE`. The separately frozen portable source retains its MIT notice at `native/upstream/splatview/LICENSE` and dependency notices in `THIRD_PARTY_PORT_NOTICES.txt`. Those notices describe distinct sources.

This slice follows the desktop selection-session behavior and extends the existing browser/native boundary. It adds no PlayCanvas code or assets. Existing COLMAPView and PlayCanvas references remain applicable to their previously integrated components.
