# Basic web input admission, using SuperSplat as the reference

Reviewed October 18, 2026 before implementation. The user selected PlayCanvas as the file-capacity reference and explicitly retains a Basic-only interface without agent access or advanced editing. This changes the existing input-admission policy, not formats, registrations, wire IDs or editing scope.

## Sources and identity

The shared product contract and feature-review template were read from the development workspace. The consumer still builds against its sealed local product 1.0.0 bundle, manifest SHA-256 `045805ef1da463f2f8b63ea965cf4847378f9a7c3025564c74f9c0c5adf29e75`. Current preimages are captured in `.build/playcanvas-input-policy-20261018-01/preimages.json`; frozen desktop/source/toolchain inputs will not be refreshed.

The reference is PlayCanvas SuperSplat's local editor, inspected at commit `f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b` (3.5.2), not its hosted publishing allowance. [Import handling](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/file-handler.ts#L292-L386) and its [Blob reader](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/io/read/file-systems.ts#L17-L65) do not show a universal file-byte cap in the inspected path. [Troubleshooting](https://developer.playcanvas.com/user-manual/supersplat/editor/troubleshooting/#the-editor-is-slow-or-runs-out-of-memory) describes available GPU memory as a practical constraint. This is not a guarantee that arbitrary files fit. Its [20-million LOD default](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/io/read/loader.ts#L34-L47) is a choice heuristic, not a ceiling. [10 GB Direct Upload](https://developer.playcanvas.com/user-manual/supersplat/upload/) is a separate hosted flow. No PlayCanvas implementation or media is copied in this change.

## Intended behavior and platform decisions

Remove the arbitrary 256 MiB product ceiling for single files and unpacked SOG groups. Retain intrinsic Blob size checks and unsigned-32-bit descriptor/range validation as technical transport constraints. Keep the existing native candidate budget (512 MiB), aggregate logical budget (1 GiB), decoded/GPU/history/recovery/output admission and one-million retained-splat preview cap. These are our current implementation constraints, not PlayCanvas capacity claims.

The current loader reads bounded ranges into a complete native input allocation. Native decode charges the whole input as well as parser/decoded allocations to its candidate budget. Refuse a source or reconstructed grouped native stage that already exhausts that budget before body acquisition or native staging, including direct worker requests. Smaller sources can still be refused by later allocation admission. Replace the fixed-size UI promise with localized resource-dependent wording. Do not advertise 4 GiB or 10 GB support, device-adaptive memory allocation, streamed decode or equal SuperSplat performance.

| Target | Policy and adapter | Current evidence and scope |
| --- | --- | --- |
| Windows editor | Required format loading with its own native file/memory authority | Full native product policy in the sealed bundle; no native editor/provider source or capacity change. |
| macOS editor | Required with its native file grants, renderer and allocation owner | Same platform decision in the sealed bundle; Apple SDK, Metal and Quick Look qualification remain separate. |
| Ubuntu editor | Required with its native file/portal and renderer owners | Same platform decision in the sealed bundle; desktop/session/provider qualification remains separate. |
| Web-lite | Conditional on actual source/decoded/GPU/operation admission | Browser source descriptor checks remain uint32; all-resident WASM/native budget remains an explicit implementation gap relative to streamed SuperSplat loading. Basic-only UI and create-copy export remain unchanged. |

Windows Explorer, macOS Quick Look, Ubuntu GNOME/KDE preview and thumbnail providers get no new surface or capability. Their existing host allowlists and file/renderer authority remain unchanged. No web agent API, CLI, overwrite command, scheduler or second history owner is introduced.

## Contracts and checks

Preserve current selection, edits, camera/default view, dirty state and executable Undo/Redo when a replacement is refused. Preserve cancellation, stale-source checks, read-credit limits, source hashing, grouped alias accounting, metadata rewriting and decoder byte ownership. Check budget refusals at controller/client/worker and grouped acquisition/staging boundaries; do not rely on hidden UI or a cooperating caller.

Keep all 128 registered product bindings and the existing source/WASM/toolchain locks. Reuse current controllers, worker envelope, native budgets and resource ledger. Keep unrelated image, export, metadata and deployment limits. Update only limit-specific test fixtures and assertions, retaining old-document/history/cancellation checks. Do not allocate a multi-GiB Blob merely to exercise scalar uint32 boundaries.

Run the full CPU suite, product/source/native-artifact checks, typechecks/build and focused browser input-refusal/basic-workflow checks. Capture actual browser/OS/GPU/security context separately; no physical Mac prerequisite or broad capacity promise. Test inputs may establish policy behavior without establishing general large-scene performance. Exact results will be recorded in the plan/status and scoped validation record after execution.

Future capacity work should replace whole-source native staging/decoding with a reviewed streaming/chunked design before claiming PlayCanvas-scale imports. This is an implementation gap, not an inherent browser limitation or a reason to add advanced editing.

## Executed validation

Full CPU02 passed 6,203 cases in 189 files. The production build passed pinned source verification (919 files), product 1.0.0 verification (128 registrations), native-artifact/toolchain checks, application and benchmark typechecks and Vite bundling (100 runtime artifacts). Native bytes remain unchanged; no native suite or platform/provider qualification was rerun.

Development03 passed all six scoped browser cases with zero retries: localized English resource-policy presentation, picker/drop/adjacent/shadowed-size refusal, and the empty-shell open workflow. Refusal checks retain exact edited exports, selection/GPU masks, camera/background, dirty state, old owners, ledger credits and executable Redo without reading the rejected body or starting a candidate worker. Production01 passed five cases with zero retries: Basic cleanup/Undo and Flip/Apply, Color/Fill without Range, all 34 projected tutorial steps with selection restoration, resource-policy presentation and actual emitted-worker budget refusal followed by successful load with checked range/fingerprint receipts.

The observed environment is Windows Chromium 156 on secure localhost. Three Basic production journeys record separate high-performance adapter probes reporting NVIDIA Blackwell without fallback. These probes do not identify the renderer-owned adapter or measure physical memory. No Mac hardware prerequisite or large-scene capacity/performance qualification is inferred.

CPU01 retained two failures: the actual missing pre-prompt collection guard, now fixed, and an intentionally heap-sized source fixture whose default budget was too small, now explicit. Development01/02 retained four fixture-setup failures each; the final fixture joins actual color readiness between edits before exercising refusal. Assertions for old state, edit history and I/O isolation remain intact. [Scoped validation record](../../docs/validation/runs/playcanvas-input-policy-20261018-01/validation.json). [PlayCanvas references](../../docs/third-party/PLAYCANVAS_INPUT_LIMIT_REFERENCES.md).
