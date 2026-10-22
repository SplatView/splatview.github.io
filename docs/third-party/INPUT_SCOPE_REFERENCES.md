# Keyboard input and focus source references

The browser input boundary adapts the captured SplatView desktop keyboard
ownership rules to React and DOM focus. Its source is the verified
`windows-r0-20261012-02` capture, ID
`cc71f0df-8f38-4900-8aff-5c9ee0d6814c`. The
[capture manifest](../../reference/targets/windows-r0-20261012-02/CAPTURE_MANIFEST.json)
records the source identities. These are source references; current browser
observations and the inherited native execution receipt have separate scopes.

| Captured source | Bytes | SHA-256 | Relevant contract |
| --- | ---: | --- | --- |
| [app_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui.cpp) | 67,853 | `27c47e26e16186a96d4d287acf66d2e29b4964988816577839004483204c4700` | UI visibility and keyboard capture at lines470-552; region, popup, tutorial and scene admission at lines560-643 |
| [app_ui_settings.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui_settings.cpp) | 12,876 | `df5cb79ad36896c20ebb85526865dde11818788f925eb2b9574fdf537497b747` | Settings keyboard ownership and tutorial entry at lines65 and262 |
| [viewer.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer.cpp) | 45,885 | `9644da5fdb7a97d0c3fcc6dcd4e80ecab614f67ba04fffc6ca96121a4679086e` | Standalone-host camera keys, key release, readiness and navigation cancellation at lines460-500 |
| [viewer_selection.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer_selection.cpp) | 59,776 | `ee3a4abf3b42222de6a9149663e9ee3a8e5634b614a702cb58dfb39115de7fcc` | Selection shortcuts, repeat suppression, Escape priority and editing commands at lines1211-1290 |
| [navigation.cpp](../../reference/targets/windows-r0-20261012-02/source/src/navigation.cpp) | 4,845 | `114f1832669466f64c14548065a11f245e546b439a9db3a5f6ebe214e7f0cbce` | Held-key cancellation and camera integration at lines65-112 |
| [processing_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/processing_ui.cpp) | 26,538 | `48ac70e1211eb6e61b1e5efe5fe4dd2b855f422e34c0054e181c524126404b15` | Active filter Enter/Escape/operation priority and text/popup exclusion at lines459-487 |

In `app_ui.cpp:544-552`, Settings, tutorial, popups, active text and an occupied UI
keyboard region capture keyboard traffic. At lines603-606, a UI region cannot
also invoke viewport or editing shortcuts. The browser preserves this ownership
boundary through [inputScope.ts](../../src/input/inputScope.ts) and the stable
App input ledger. Tutorial ownership precedes synchronous store modal state,
registered menus, editing/composition and other UI focus. Scene shortcuts require
scene focus; scene and its captured pointer gesture share a keyboard region.
The ledger tracks physical key ownership, quarantines keys when UI takes over,
and drains on window blur or document hiding. Camera and selection modifiers
retain their existing native owners.

The browser-specific focus adaptation in
[useDialogFocus.ts](../../src/ui/useDialogFocus.ts) gives Save, Unsaved changes and
the output acknowledgment initial focus, contained Tab traversal and a surviving
return target. The output acknowledgment describes a browser download handoff;
it does not settle an operating-system save. Menu open/dismiss notification also
updates input ownership when a portal opens on hover without moving focus.
[useTutorial.ts](../../src/ui/useTutorial.ts) retains Tutorial's separate key
ownership and clears it when the window loses focus.

Browser shortcuts retain browser meanings. Ctrl/Cmd+C on selected UI or body
text stays browser Copy; image Copy requires scene focus. Plain scene-focused G
is the established browser adaptation of desktop Ctrl+G, while Ctrl/Cmd+G stays
browser Find Next. Text PageUp/PageDown remains available to its field. These
adaptations do not add scene commands or change Undo/Redo, selection, pending
grading, camera or source data ownership.

The native source also specifies T thumbnail and F6/Shift+F6 region traversal.
This bounded packet does not implement or qualify those shortcuts. Additional
wheel routing, announcements, and 200/400% zoom coverage remain separate work.
Local browser evidence does not establish assistive-technology, Mac/Safari,
deployed-host, complete keyboard accessibility or whole W25 acceptance.

The captured SplatView application sources remain covered by their original
[proprietary notice](../../reference/targets/windows-r0-20261012-02/source/LICENSE):

> Copyright (c) 2026 OpsiClear LLC. All rights reserved.

The notice is 1,265 bytes with SHA-256
`ff39f450fd56ce98a7da38c5981e2f4661c55cdd404b6294eace5e805f9fc132`.
Source review and browser adaptation grant no additional redistribution rights.
This packet adds no PlayCanvas source or runtime dependency. Existing ImGui,
ImGuizmo, renderer and other dependency notices retain their own scopes; this
document adds no native build or native execution claim.
