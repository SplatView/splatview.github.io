# Maintaining the application UI

Start at [the project map](project-structure.md) and follow [AGENTS](../../AGENTS.md).
The browser application composes existing feature components; its reusable
renderer remains separate under `src/engine/` and `src/renderer/`.

| Module | Responsibility |
| --- | --- |
| [App.tsx](../../src/ui/App.tsx) | Application/controller creation, canvas and file-picker refs, input routing, modal priority, tutorial projection and viewport lifecycle. |
| [ToolsPanel.tsx](../../src/ui/ToolsPanel.tsx) | Tools presentation, existing folding/scroll restoration, grade drafts and calls to controller operations. App owns the retained panel state across mounting. |
| [SelectionControls.tsx](../../src/ui/SelectionControls.tsx) | Selection actions/help/options, polygon controls, tolerance input and immutable pointer-option capture. Native selection/history stays with the existing controller. |
| [IconButton.tsx](../../src/ui/IconButton.tsx) | Shared icon-button markup, translation, tooltip, shortcut, focus ref and tutorial target. |
| [dialogs/ModalFrame.tsx](../../src/ui/dialogs/ModalFrame.tsx) | Existing modal frame and shared focus-options type. Uses the existing focus hook. |
| [dialogs/AboutDialog.tsx](../../src/ui/dialogs/AboutDialog.tsx) | Application version/build information and support links. |
| [dialogs/SceneExportDialog.tsx](../../src/ui/dialogs/SceneExportDialog.tsx) | Per-opening export format draft, scope and download/cancel presentation. The controller owns accepted formats and output acknowledgement. |
| [dialogs/SavedViewChooser.tsx](../../src/ui/dialogs/SavedViewChooser.tsx) | Matching browser-local saved-view choices and existing focus/keyboard behavior. |
| [settings/SettingsDialog.tsx](../../src/ui/settings/SettingsDialog.tsx) | Settings tabs, scroll boundary, keyboard containment and focus return. App owns the active tab and page composition. |
| [settings/LanguagePicker.tsx](../../src/ui/settings/LanguagePicker.tsx), [ThemePicker.tsx](../../src/ui/settings/ThemePicker.tsx), [FontSizePicker.tsx](../../src/ui/settings/FontSizePicker.tsx) | Controlled preference menus, preview/commit/rollback, portal and focus behavior. Preference stores remain in `src/app/`. |
| [settings/RenderSettings.tsx](../../src/ui/settings/RenderSettings.tsx) | Existing renderer settings and Help diagnostics. Controller/renderer retain preparation, fallback and resource ownership. |
| [OfflineStatus.tsx](../../src/ui/OfflineStatus.tsx) | Application/update information and toolbar notice, shared with the existing offline client. |
| [collectionNavigation.ts](../../src/input/collectionNavigation.ts) | Pure collection-arrow placement and PageUp/PageDown admission. No React, GPU, worker or application initialization. |

Import a symbol from its owning module. Internal moves do not require App
re-exports or an `index.ts` compatibility barrel. Shared focus and popup helpers
stay beside the other UI primitives; a feature directory should group existing
responsibilities rather than add a new state/controller layer.

Preserve component identity, props, hook lifetime and parent-owned refs during
extraction. Modal priority and output/save/discard decisions stay in App and the
existing controller. Keep initial focus, portal containment, Escape/Tab handling,
usable focus return, disabled states and tutorial targets intact. Browser-local
saved views do not write source files or operating-system thumbnails.

Selection changes also follow [the selection guide](selection.md). UI projection
does not grant editing to a geometry viewer or bypass product policy. Rendering,
native history, worker/cancellation, resource admission and output retirement
retain their existing owners.

Run the nearest existing tests and the required product gate:

```sh
npm run typecheck
npm run verify:project
python -B contracts/product/tool.py verify --root .
npm test -- tests/collection-ui.test.ts tests/export-dialog-ui.test.ts tests/filter-ui.test.ts tests/selection-range-ui.test.ts tests/theme-picker.test.ts tests/language-picker.test.ts
npm run build
```

Use the existing Settings, appearance, selection, saved-view, modal/focus and
production browser cohorts for changes that reach those paths. Keep raw reports
under `.build/validation/`. Static rendering tests do not prove browser focus,
native Undo/Redo, file persistence, GPU behavior or other-platform qualification.
