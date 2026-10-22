# Web-lite selection policy completion

Review date: October 18, 2026. This amends the local `contract-gap-implementation.md` adoption review for the existing `selection.advanced` policy. It introduces no registration, wire ID, format, profile or shared-policy change.

The reviewed local bundle is product contract 1.0.0, manifest SHA-256 `045805ef1da463f2f8b63ea965cf4847378f9a7c3025564c74f9c0c5adf29e75`, pinned by `contracts/product-adapter.json`. Source archives/preimages for the affected current files are recorded in `.build/web-lite-policy-20261018-01/preimages.json`. The shared development reference and its feature-review template were read; builds continue to consume the sealed local bundle.

## Intent and existing behavior

The adoption currently hides the Pro tier, advanced lessons and the Range radius editor, and rejects excluded commands in the existing worker. However, the shared SelectionActions and SelectionOptions still expose Current view only and Range. Clicking those controls reaches commands that the worker correctly refuses. An optional `selectionView` payload also needs the same exclusion as the existing `rangeEnabled` payload gate.

Omit the two permanently excluded UI actions, refuse the advanced selection payload before native execution, and preserve ordinary manual/color selection, selected/whole-scene edit scope, camera inputs, cancellation, history, and existing advanced engine code. This is enforcement of the adopted profile, not a browser API limitation. No agent API, CLI or source-overwrite surface is added. The existing worker remains the execution boundary and the existing controller remains the state/history owner.

## Platform and host decisions

| Target | Policy and reason | Implementation and evidence boundary |
| --- | --- | --- |
| Windows editor | Required in the full desktop profile | Keep the native owner and current full-editor selection behavior; this browser patch does not change or requalify it. Current shared review and sealed feature/profile policy supply the decision. |
| macOS editor | Required in the full desktop profile | Keep the native adapter; Apple SDK, Metal and host qualification remain separate. No native source change. |
| Ubuntu editor | Required in the full desktop profile | Keep the native adapter and existing session-specific qualification boundaries. No native source change. |
| Web-lite | Advanced selection excluded by product scope; manual/color selection and cleanup required within existing admission | Hide Current view only and Range, and reject their excluded payload/commands in the existing worker. Preserve retained engine compatibility tests separately from active-profile browser tests. |

Windows Explorer, macOS Quick Look, Ubuntu GNOME/KDE preview hosts and background thumbnail providers receive no new action or entry point. Their sealed host allowlists, file grants and native implementation evidence remain unchanged. The browser patch cannot establish any provider's qualification.

## Existing contracts and validation

Registrations remain those in `contracts/product-adapter.json`; the verifier must continue to accept all 128 explicit bindings and the unchanged manifest pin. Existing source/toolchain locks, generated assets, native/WASM ABI, worker envelopes, codec/resource budgets, dirty/history ownership and download acknowledgement semantics remain mandatory.

Use the generated policy for UI visibility. Excluded controls have no keyboard target or tutorial step. Retain the active projected tutorial, localized remaining controls, browser-reserved shortcuts and existing Selection/Transform/Color hierarchy. No new label, icon, popup or tutorial registration is needed.

Check the real worker rejects an advanced selection view before native execution and leaves the model unchanged. Omitted/null selection views, ordinary camera input and selected-only transform scope remain permitted. Check the real browser omits both controls, preserves brush/rectangle/color selection and required manual transforms, and can complete the projected tutorial without unavailable anchors. Run the product verifier, appropriate CPU contracts, typechecks and production build. Record actual commands and browser/OS/GPU/security-context observations separately from source review; physical Mac testing is not required.

Validation status: the implementation and checks described in this record passed. Validation passed: 6,181 CPU tests across 189 files, the pinned product verifier (128 registrations), source/native-artifact checks, both typechecks and the production build. Three production-browser journeys passed with zero retries: Basic cleanup/Undo and manual Flip/Apply, Color/Fill picking without Range, and all 34 projected tutorial steps with selection restoration. Browser evidence is Windows Chromium 156 on a secure localhost origin; the separate high-performance adapter probe reported NVIDIA Blackwell without fallback. This is scoped browser evidence, not new macOS/native-provider or universal device qualification.

Exact commands, earlier failed fixtures, source/build identities and cleanup evidence are recorded in [`validation.json`](../../docs/validation/runs/web-lite-selection-policy-20261018-01/validation.json). The original sealed bundle and pinned adoption review remain unchanged.

The user explicitly confirmed Basic only, without agent access or advanced editing. The worker gate enforces excluded command families and the Range/current-view payload extensions. Shared numeric transform and color representations remain compatible because Basic flips, gizmo deltas, presets and auto color use them too; this packet does not claim an owner-aware prohibition of every advanced parameter representation. A separate registration cleanup can reclassify legacy WorkerCommand.color from color.basic to selection.color; both families are currently allowed, so that classification is not an admission failure in these workflows.
