# Transform pivot implementation references

The browser pivot controls adapt committed SplatView **1.0.2**,
`4e1be155511fb49f08fd8c863d785ac008a4c43a`, identified by the
[current desktop validation record](../validation/runs/current-desktop-chrome-20261016-02/validation.json).
The exact desktop source checkout is
`.build/current-desktop-chrome-tests/desktop-source`. Its following inputs were
read directly for this implementation:

| Desktop input | SHA-256 | Behavior adapted |
| --- | --- | --- |
| `src/processing_ui.cpp` | `cb283fae89a55a898817b73a23a035c80c1ad92a20f9edf54a0219d4e30b0587` | Lines 243-307: refresh, icons, reference-only pivot changes and Scene/Selection/Origin cycle. Lines 391-406: Reset. Lines 444-475: Pro button, tooltip and numeric Custom pivot. Lines 178-228 describe the separate automatic committed-selection default policy. |
| `src/editing.cpp` | `8913f0ecb49c25c53210ead1525e6176c68a5291f7ebe5068147390e662286b2` | Lines 1056-1079: exclude deleted records, use selected records when present, expand each Gaussian by three standard deviations along the covariance diagonal, and use the combined AABB midpoint. |
| `src/processing.cpp` | `9b2c1c8cd8d237cba53319137883e1c54f231736a6a87049a40079ed6b6e7e7b` | Lines 289-319: translation and pivot composition, `t = translation + pivot - A*pivot`. |
| `src/translations.inc` | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` | Lines 302-307: Cycle pivot label and all five state/next-action tooltips, in English and seven translated locales. |
| `src/icons.def` | `ad6d4bfdb71fa00f5e19b462eb5c518bf0da5d67f2ef013ea30e1da6d77e6ea6` | Lines 61-64: Custom uses PickCenter/crosshair; Scene, Selection and Origin use their three pivot SVGs. |
| `assets/icons/pivot-center.svg` | `371619a63f9a803ed520beb9319639e36963d7c4f5c8034790774bd29c500142` | Existing 260-byte Scene icon. |
| `assets/icons/pivot-selection.svg` | `f85caf6effc4aa768ee08734ca0c5106081d30983dd6e14dc9bc17c51e78fcf7` | Exact 324-byte Selection icon. |
| `assets/icons/pivot-origin.svg` | `d5357c49ada218878f065839a7098b6199048104bf61d5e62a4168bfbf891957` | Exact 312-byte Origin icon. |
| `assets/icons/crosshair.svg` | `ae9ed8583286ea03bffae85bb69aee5227540e588b0370cf185f2141ebe25e8d` | Existing 412-byte Custom icon. |

The finite [pivot icon and copy capture](../../reference/targets/windows-pivot-20261016-01/CAPTURE_MANIFEST.json)
has SHA-256 `129a67f590536b2724adb6984de7f72b5752f58d9d340cbe1915a2d975f16639`.
It retains `src/icons.def`, the Selection/Origin SVGs and the exact localized
rows under the pinned desktop version and commit. The
[asset generator](../../tools/generate-assets.py) verifies these finite inputs
and combines the two new SVGs with the existing Scene/Custom assets in
[current desktop icons](../../src/generated/currentDesktopIcons.ts).
[Editing translations](../../src/app/translations/editing.ts) retain the
desktop English label/tooltips and Spanish, French, German, Portuguese,
Simplified Chinese, Japanese and Korean text.

The [native focus adapter](../../native/wasm/browser_focus_bounds.cpp) implements
a cooperative selected-record scan with a fixed-size admitted owner of at most
512 bytes, defined in [its header](../../native/wasm/browser_focus_bounds.hpp).
It computes the desktop covariance-diagonal three-sigma AABB midpoint. It
returns an explicit absent point for an empty selection so the pivot control
can choose Origin; it does not borrow camera focus's all-visible fallback.
The adapter preserves desktop float midpoint arithmetic where finite and uses
half-before-add only when the original intermediate overflows. It refuses
nonfinite geometry or bounds rather than publishing an invalid pivot.

The [binding](../../native/wasm/bindings.cpp) fences the query by document
generation, current scene/mask ownership, native revisions and retained
transform identity/epoch. With an active transform, the query reads that
owner's original `base` and canonical `states`, rather than a baked successor
or a current-view effective target mask. This keeps a pivot reference in the
same coordinates as absolute browser previews. Scene focus returns that base
scene's center. The query creates no scene copy, mask copy, content mutation
or Undo entry. Its fixed-size owner does not make total scene/editing capacity
constant. The existing synchronous selected-focus calculation during native
`beginTransform` remains unchanged; this adapter does not make that entry path
cooperative.

[The pivot protocol](../../src/document/transformPivot.ts),
[core client](../../src/document/coreClient.ts) and
[worker](../../src/workers/document.worker.ts) validate the exact request,
retained transform binding, explicit finite float32 result and unchanged
persistent document state. A focus query cannot acquire edit-operation
ownership. The [controller](../../src/app/controller.ts) admits and retires its
work owner, rejects canceled/stale completion, and keeps source replacement,
Reset, explicit preview Apply/Cancel and gizmo transitions coherent.
[Transform controls](../../src/ui/TransformControls.tsx) expose the Pro cycle
and numeric Custom state through the existing compact strip; affine matrix
mode hides the cycle as on desktop.

Scene cycles to Selection when selected records exist, otherwise to Origin;
Selection cycles to Origin; Origin and Custom cycle to Scene. Changing only a
pivot reference with neutral rotation, unit scale and no flips keeps the
composed transform unchanged and creates no edit/history step. Translation
and other parameter fields remain intact. A pivot change that actually changes
a nonneutral transform remains part of the explicit browser preview/Apply
workflow. Gizmo references share the chosen pivot. New sources start at Scene;
Reset chooses Selection when nonempty and Origin otherwise.

This implementation slice does not claim the desktop's automatic switch to
Selection after every completed membership edit: the portable core lacks its
distinct `selectionCommitRevision()` counter. General content revision,
selected count and GPU mask revision alone are insufficient substitutes.
Automatic committed-selection default refresh remains separate work, as do
complete current-source visual/assistive equivalence and measured capacity.
Validation passed: 5,774 CPU tests, 96 production-browser tests, 10 native module suites and 47 Python verification tests. See the [qualified pivot validation record](../validation/runs/pivot-controls-web-20261016-01/validation.json). The native focus suite observed six groups, 144 bytes per admitted owner, and complete allocation-refusal, cancellation and stale-identity checks. The allocation sweep found and fixed an allocating JSON comparison inside a noexcept operator; borrowed string comparison now preserves refusal handling.

SplatView application code retains its proprietary notice: Copyright (c) 2026
OpsiClear LLC. All rights reserved. The captured desktop `LICENSE` has SHA-256
`a4e250aeb90355f40a09587cfaad8a5a6d1c79d0a3a539fc6cc1ab0537384010`.
This adaptation adds no redistribution rights. No PlayCanvas or COLMAPView
implementation was copied for this pivot adapter; their existing references
and notices retain their separate scopes.

## Automatic selection defaults and derived-reference refresh

This later adapter addresses the automatic-selection gap recorded by the
explicit-pivot slice above. The frozen portable source remains unchanged; a
guarded browser build overlay supplies the committed-selection notification.
The desktop authority remains SplatView 1.0.2,
`4e1be155511fb49f08fd8c863d785ac008a4c43a`.

| Source input | SHA-256 | Behavior adapted or implemented |
| --- | --- | --- |
| Desktop `src/processing_ui.cpp` | `cb283fae89a55a898817b73a23a035c80c1ad92a20f9edf54a0219d4e30b0587` | Lines 178-228: defer while editing/selection is active, default committed nonempty membership to Selection, use Origin when Selection becomes empty, and refresh derived pivots. |
| Desktop `src/editing.hpp` | `b19929b855a13d3654feb0d2bba50b2c09202e0e1d25148ce90c2e4dca1ca5fc` | Lines 69-73 and 235-238: distinct completed-membership notification, excluding live preview and cancellation. |
| Desktop `src/editing.cpp` | `8913f0ecb49c25c53210ead1525e6176c68a5291f7ebe5068147390e662286b2` | Lines 182-201, 344-352, 436-477, 480-509 and 722-803: selected-bit comparison, draft confirmation/cancellation and geometry/history replacement semantics. |
| Browser `tools/build-core.py` | `32ef97b3336d8a053487bbb22c3011fea7c92f4453a653c7ab937e3b171ce622` | Lines 251-335: guarded disposable-core notification adapter, exact selected-bit/cardinality comparisons and safe-identity preflight before publication. |
| Browser `native/wasm/selection_checkpoint.hpp` | `17f9aad58c944cd89642847755e6e76bd3242b850c7fc644d5134a6bea331fcb` | Preserve notification on selection candidates, advance accepted Duplicate membership, guard amendments and start fresh recovery at zero. |
| Browser `native/wasm/bindings.cpp` | `507ffcf7d75e373c6f1200c495be3a0a5cb49ee11d11fdd6453b940ce9f57f46` | Publish the notification; share the readonly persistent-owner guard at admission and every focus step while compatible settled Color/Fill, grade or opacity owners retain their baselines and maps. |
| Browser `src/document/transformPivot.ts` | `89d40133f87b31d05731013f352882998ca02e34440f80c33ed97dcdabbb49de` | Validate the event representation and include it in the readonly persistent-state signature without cross-response monotonicity assumptions. |
| Browser `src/app/controller.ts` | `1e7e3fdebc1bf4bc80c7d06417bf74f8daf91874306ea54eaf6db32f97674c68` | Coalesced automatic default/refresh, activity deferral, retained base coordinates, recipe retirement and retry after graphics recovery or canceled-load cleanup. |
| Browser `src/ui/TransformControls.tsx` | `6013604a41beea3c5dba18fdb1ece24f94811d70fd9761f90a2d8a2e651525f2` | Numeric focus tokens defer automatic reference changes until blur or field retirement. |
| Browser `src/ui/App.tsx` | `9b33a86ae6cf096a3efbc1e8f435e1d060f2b83532e36bbcb20cedd2ca0a4cbd` | Lines 305-360: tolerance numeric entry and actual slider pointer/held-key activity; idle slider focus does not hold the automatic pivot. |

The [build overlay](../../tools/build-core.py) adds only a scalar event counter;
it reuses existing sparse deltas and admitted masks instead of retaining another
full selection mask. A selected-bit change advances it even when the selected
count stays the same. A mask-cardinality change also counts. Draft previews and
their cancellation do not advance the completed notification; confirmation
records the accepted membership change. Attribute-only scene replacements with
the same selected bits leave it unchanged. Increment capacity is checked before
history or mask mutation, and the final publication remains nonthrowing.

`selectionCommitRevision` is a worker-lifetime notification, not a durable
content identity. A native transaction's rollback restores its prior value;
fresh checkpoint recovery deliberately starts it at zero. The
[client](../../src/document/coreClient.ts) and
[worker](../../src/workers/document.worker.ts) require its safe-integer
representation under `transformPivot: 2`. They do not impose monotonicity across
rollback or replacement workers. The
[response serializer](../../native/wasm/response.cpp) emits zero for unloaded
and non-Gaussian documents and includes the field in ordinary summaries.

The [controller synchronizer](../../src/app/controller.ts) observes only settled
accepted summaries and primes a new worker without treating its reset as a
selection action. A completed nonempty membership change chooses Selection.
When that change empties Selection mode, the pivot becomes Origin; an already
different mode is not reset just because selection becomes empty. Automatic
work waits for physical selection, released-click drain, tolerance amendments
and pending map acquisition, numeric editing, gizmo activity and incompatible
editing/output owners. Transform and tolerance numeric-entry tokens are cleared
on blur and unmount. A tolerance slider reports activity while its pointer is
held or an adjustment key remains pressed. Pointer release/cancellation/lost
capture, key release, blur and unmount end the corresponding activity; idle
slider focus remains compatible with an automatic update.
Store notifications coalesce; repeated store updates do not create an idle
scene-scan loop, and a refused automatic query is not retried continuously at
the same synchronization stamp. Successful graphics recovery and canceled
source-load cleanup clear the remembered refusal stamp so a later attempt can
proceed with the retained document.

The native readonly focus query permits compatible settled Color/Fill, grade
and opacity sessions. The automatic controller path uses it without ending
those sessions, replacing their maps or changing their checkpoint/history.
Admission and every cooperative focus step call the same
`requireFocusPersistentOwnersCurrent()` guard. Its persistent-state signature
still certifies that the query changed no document or retained tool state.
Active/busy or stale owners remain guarded throughout the scan.
The earlier explicit pivot action retains its explicit settlement boundary.

Geometry identity is separate from membership. Scene and Selection references
refresh when geometry changes, while Custom and Origin choices survive a
geometry-only change. During a retained transform, the base owner identity
defines the reference coordinates; a later applied epoch moves the display
without recentering the recipe on its baked successor. When the recipe retires,
numeric parameters return to neutral, a Custom pivot is mapped through the
accepted matrix once, Origin remains zero and derived references refresh in
the accepted scene. This prevents carrying the old recipe or applying its
translation twice. Apply and gizmo entry join pending pivot synchronization
before starting a new transform action.

This phase preserves wire protocol 28, UI-worker contract 23, core ABI 24 and
camera ABI 4, with `transformPivot: 2` advertising the completed-selection event.
It introduces no new scene-format version, transaction-receipt version or
checkpoint codec/plan/metadata version. Existing recovery normalization and
Duplicate topology/source binding retain their separate contracts.

Validation passed: 5,837 CPU tests, 98 distinct production-browser cases across the full run and targeted rerun, and 11 native module suites; 90 Python verification checks passed and one host-dependent filesystem probe was skipped. [Validation record](../validation/runs/selection-pivot-web-20261016-01/validation.json). The earlier explicit-pivot validation
above keeps its original scope. Color/Fill Range and logarithmic Radius have a
source-backed private implementation design, but their controls, amendments
and sphere feedback remain future work. Joined floating confirmations,
current tutorial and complete current-source visual/assistive and measured
limited-scene capacity acceptance remain separate.
