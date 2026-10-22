# Current desktop tutorial v7 references

Validation passed: 6,160 CPU tests in 188 files, 118 production-browser cases, 48 tutorial/input/zoom browser cases and 14 executed native module suites. Browser runs used zero retries. [Validation record](../validation/runs/current-tutorial-v7-web-20261017-01/validation.json).

SplatView 1.0.2 commit `4e1be155511fb49f08fd8c863d785ac008a4c43a` is the authority for this update. The exact captured [tutorial header](../../tests/fixtures/tutorial-v7.hpp) and [referenced locale rows with source/line provenance](../../tests/fixtures/tutorial-v7-translations.json) are portable test fixtures. The original desktop checkout remains frozen. The current source identifies Copyright (c) 2026 OpsiClear LLC, LicenseRef-OpsiClear-Proprietary; its [exact proprietary notice](../../tests/fixtures/tutorial-v7-translations.json) and source/license hashes are retained. The older R0 MIT notice applies to that older capture; [prior tutorial references](TUTORIAL_REFERENCES.md) document the earlier R0 implementation.

| Pinned source | Bytes | SHA-256 |
| --- | ---: | --- |
| `tutorial.hpp` | 10582 | `1e0fe1551a5d9f475c43635892146e03b09430e666180de52cf88072a2f05055` |
| `app_ui_tutorial.cpp` | 20106 | `87d5a2b27fb3625bd6f0eef9e0e07e5c85c1fa84b55c00384ec5ba02aabc7558` |
| `translations.inc` | 254928 | `ac3f88336d930a838f3180e1fe74a018137902bf1f2c2afd9e491ac76f90a4c2` |
| `viewport_tools.cpp` | 45727 | `9e158605dd842b9fa1b5ac9b62863a7670b1db0cc1c66f5900ae473911cb0ca9` |
| `processing_ui.cpp` | 32682 | `cb283fae89a55a898817b73a23a035c80c1ad92a20f9edf54a0219d4e30b0587` |

The native catalog defines 48 steps. The web retains 47 steps and 46 targets, omitting native AgentAccess. Both Filter stages have distinct stable semantic IDs. Native decoded title/body text, source lines, target mapping and displayed profile are independently checked against the pinned fixture. The browser follows the current Selection, Transform, Color order and the desktop's temporary Pro presentation without changing the real editor profile.

Browser adaptations explain saved views, browser-owned shortcuts, plain G for Fill, explicit color/numeric/opacity application, bounded Range feedback, selection Clear versus gizmo Cancel, per-drag Undo and pivot behavior. New unchanged native text uses exact referenced locale rows; browser-specific copy supplies all seven translated rows plus English. Generated R0 catalogs stay frozen.

`app_ui_tutorial.cpp:268-306` is the authority for a disabled tutorial completion example. The browser's Range and manual completion examples are presentation only. The tour does not arm a native tool, write raw Range settings or launch morphology/range statistics. Event-coalesced target layout and owner-specific scroll reveal remain in use. When compact layouts cannot fit a floating example, the example appears inert inside the scrolling tour card. Replay over a loaded scene returns focus to the canvas. Temporary Settings or Export dialogs stop any physical gizmo drag while preserving an idle armed transform and its native session; passive chrome hiding also preserves that arm.

The validation binds actual shipping worker/native data, masks, exports, executable Undo/Redo and an idle retained gizmo through replay. It also records the eight-locale empty tour and real browser zoom at 200% and 400%, plus existing tutorial, geometry-viewer, input, scene-status and zoom regressions. Native/GPU transform geometry remains covered by the existing production gizmo cases. Source/bundle/native coherence and clean output inventories are checked separately.

This is bounded browser layout and automated accessibility evidence on the recorded Windows/Chromium host. It does not claim whole-app pixel identity, observed assistive speech or universal browser/capacity results. A fresh Basic/Pro browser capture is compared with the unchanged pinned desktop chrome at a fixed 0.5 logical-pixel tolerance. The comparison retains its bounded control/font/geometry scope. No new PlayCanvas code or media is added; [existing renderer references](PLAYCANVAS_REFERENCES.md) remain unchanged. No native/worker/transport contract version changes in this tutorial slice.
