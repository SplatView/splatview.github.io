# Duplicate implementation references

The browser Duplicate adapter follows committed SplatView 1.0.2,
`4e1be155511fb49f08fd8c863d785ac008a4c43a`, captured and identified in the
[current desktop validation record](../validation/runs/current-desktop-chrome-20261016-02/validation.json).
The following paths and hashes identify the exact desktop inputs:

| Desktop source | SHA-256 | Behavior adapted |
| --- | --- | --- |
| `src/processing.cpp` | `9b2c1c8cd8d237cba53319137883e1c54f231736a6a87049a40079ed6b6e7e7b` | Lines 1140–1165: append eligible records in source order, deselect originals, select copies, increase source count and retain the latest-copy suffix. |
| `src/viewer.cpp` | `bfda494deb74fa0bf770f85eab2634a9970ddf956f275f0124bdcdba72fc70f1` | Lines 293–308: guard a selection containing exactly the latest untouched copies. |
| `src/selection_ui.cpp` | `4ca42d85710ed6d216236b37636be3c80d65bb9c0d36661174daa0ee434fddc1` | Lines 643–691: Pro action availability and selection behavior. |
| `src/processing_ui.cpp` | `cb283fae89a55a898817b73a23a035c80c1ad92a20f9edf54a0219d4e30b0587` | Lines 168–171: submit the Duplicate processing operation. |
| `src/translations.inc` | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` | Lines 15 and 356: exact eight-language Duplicate label and three-line tooltip. |
| `src/shaders/splat.hlsl` | `be4683593fa6f897747cc314afc6ca432c356eebfa9078c980599ac7a57564b7` | Lines 188-189: selected unchanged copies use literal green `(0.49,0.824,0.573)` with mix `0.72`. |

[The native adapter](../../native/wasm/browser_duplicate.cpp) uses cooperative
count/copy traversal and browser memory admission. It preserves all 144 bytes
of each Gaussian, including inactive SH and reserved lanes. Its one-million
loaded-splat limit is the retained browser policy; the desktop operation uses
its own editing limit. The adapter shares the existing native full-scene history
representation rather than reconstructing copies through an export format.

The [functional Duplicate validation](../validation/runs/pro-duplicate-web-20261016-01/validation.json)
qualifies the integrated browser action. The [native command and atomic publication](../../native/wasm/bindings.cpp),
[summary/receipt response](../../native/wasm/response.cpp) and [receipt topology](../../native/wasm/operation_receipt.hpp)
carry the copied scene, counts and nullable duplicate range through wire protocol 28,
UI-worker contract 23 and core ABI 24 (camera ABI 4 unchanged), with Duplicate 1,
transaction receipt 2 and recovery checkpoint 2. The [codec 3 checkpoint implementation](../../native/wasm/browser_document_checkpoint.cpp)
and [core client](../../src/document/coreClient.ts) authenticate grown/shrunk history
and per-scene duplicate lineage without replacing the immutable import binding.
The [controller](../../src/app/controller.ts) admits retained old-plus-candidate ownership
and publishes accepted native/GPU state; the [GPU mirror](../../src/renderer/webgpu/renderer.ts)
and [splat shader](../../src/renderer/webgpu/splats.wgsl) apply the green feedback only
to presentation, preserving exported and captured source colors.

The [Pro control](../../src/ui/App.tsx), [current desktop icon](../../src/generated/currentDesktopIcons.ts)
and [editing translations](../../src/app/translations/editing.ts) use the committed
Duplicate icon and exact English/seven translated label and three-line tooltip.
Desktop `src/icons.def:78` maps Duplicate to `copy`. Desktop `src/translations.inc:15,356`
supplies English, Spanish, French, German, Portuguese, Simplified Chinese, Japanese
and Korean; `src/selection_ui.cpp:675-676` supplies the tooltip call site. Desktop
`src/shaders/splat.hlsl:188-189` uses the literal `float3(0.49,0.824,0.573)` with
`lerp(...,0.72)` for selected unchanged copies. The browser uses those same numeric
literals, rather than a rounded eight-bit color conversion. The [native append contracts](../../native/wasm/duplicate_contracts.cpp)
and [actual binding contracts](../../native/wasm/duplicate_binding_contracts.cpp)
cover record/mask/history semantics and failure-atomic publication.

SplatView application code retains its proprietary notice: Copyright (c) 2026
OpsiClear LLC. All rights reserved. The captured desktop `LICENSE` has SHA-256
`a4e250aeb90355f40a09587cfaad8a5a6d1c79d0a3a539fc6cc1ab0537384010`.
This adaptation adds no redistribution rights. No PlayCanvas or COLMAPView
implementation was copied for this native adapter; their existing references
and notices retain their separate scopes.
