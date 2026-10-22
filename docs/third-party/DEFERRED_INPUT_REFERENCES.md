# Deferred scene pointer and popup input references

The desktop behavior reference is the pinned SplatView source capture
[`windows-r0-20261012-02`](../../reference/targets/windows-r0-20261012-02/CAPTURE_MANIFEST.json),
capture ID `cc71f0df-8f38-4900-8aff-5c9ee0d6814c`, captured
`2026-10-12T14:58:30.444801+00:00`. Its manifest records tree SHA-256
`162c4bb2b129dc49169b3678e21b1b607a13bfd249f75cb1a2b3a5b7e8e9a2f4`.
The `deferred_desktop_review` source review identified the contracts below;
this note retains its paths and ranges, checked against those captured files.

The predecessor implementation, tests and deployment files were preserved
before this packet's edits in the
[baseline preservation manifest](../../.build/deferred-tests/baseline-01/manifest.json).
That receipt preserves earlier bytes; it does not establish execution or
acceptance of the changes described here.

| Captured source | Bytes | SHA-256 | Relevant desktop contract |
| --- | ---: | --- | --- |
| [viewer.hpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer.hpp) | 22,071 | `037ee7b9cfe13d4c13266f9394b6126a846741a744a6c4d1bc45c5a22770e444` | Lines338-344 bound deferred physical presses and pointer messages; lines384-385 separately bound released selection strokes |
| [viewer.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer.cpp) | 45,885 | `9644da5fdb7a97d0c3fcc6dcd4e80ecab614f67ba04fffc6ca96121a4679086e` | Lines808-827 defer a scene selection press behind color work; lines730-737 preserve down/move/up/double-click FIFO order; lines652-722 bound capture and replay |
| [viewer_processing.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer_processing.cpp) | 32,363 | `26930730a03f9d7a5cfbabe8e2e37d6b89a8d7cb5466538a7ac8d4efced0d93c` | Lines34-44 bound deferred color actions, capture source generation and close further press admission; lines43-70 keep later actions behind the pointer barrier |
| [viewer_selection.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer_selection.cpp) | 59,776 | `ee3a4abf3b42222de6a9149663e9ee3a8e5634b614a702cb58dfb39115de7fcc` | Lines12-20 preserve a deferred gesture's captured Combine; lines1043-1059 snapshot released strokes and apply them successively to the latest committed baseline; lines920-955 cancel selection and deferred input |
| [viewer_scene.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer_scene.cpp) | 10,148 | `6c80d59a2f05a917ca458f3b15d600aa2022c8956715a24d09b60d8b907195ab` | Lines86-98 cancel selection before source opening; line176 advances the published source generation |
| [selection_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/selection_ui.cpp) | 46,403 | `6880ed61e5f7aaa31594c1cd0b52ebad36a1a1633ecf5e5cf498201ec595862c` | Lines13-25 give the selector group its popup ownership; lines140-160 retain pin/away/Escape behavior; lines200-207 finish and block the popup window |

## Captured ordering and lifetime rules

In `viewer.cpp:670-675`, a deferred press captures Combine, selection options
and brush radius. Replay restores those captured values at lines843-851,
rather than reading later toolbar defaults. Lines703-708 keep the next press
in the FIFO until an earlier release can finalize. Lines534-545 allow an
unfinished, released Polygon to wait for another point without holding the
barrier after its actual buffered and released work has drained.

Physical pointer capture and logical replay have separate lifetimes. In
`viewer.cpp:642-650` and lines676-685, replay of an older release must not
release capture for a newer physical press. Cancellation, capture transfer and
resize retire deferred input at lines724-740. Blur cancels selection,
navigation and scroll at lines1061-1066. Non-selection commands clear deferred
pointer input at lines229-237. Destruction clears color actions and stops
selection, processing and loading at lines42-47. Source generation also guards
deferred actions in `viewer_processing.cpp:38-42`.

## Bounded browser adaptation

The browser stores scalar pointer and per-press option snapshots in
[deferredPointer.ts](../../src/input/deferredPointer.ts).
[App.tsx](../../src/ui/App.tsx) owns DOM capture, queue admission and replay
through the existing selection handlers.
[controller.ts](../../src/app/controller.ts) owns the color-operation barrier,
source/camera/renderer identity checks and the temporary work lease. DOM event
objects, source-sized arrays and native/GPU buffers are not retained in these
pointer records. This is a bounded browser adaptation of the desktop ordering
contract; its limits are admission policies, not measured performance capacity.

| Queue or replay boundary | Captured desktop | Browser policy |
| --- | --- | --- |
| Deferred physical selection presses | At most 32 unreplayed presses, `viewer.hpp:338-344` | At most 32 unreplayed presses in `DeferredPointerQueue` |
| Deferred pointer messages | At most 65,536 retained messages, `viewer.hpp:338-344` | At most 65,536 retained event records; overflow retires the whole queue |
| Replay scheduling | At most 512 events per replay call, `viewer.cpp:697-708` | Yield to the browser after each 512 replayed records |
| Deferred color actions | At most 32 actions, `viewer_processing.cpp:34-44` | A distinct desktop reference; it is not the physical-pointer or released Color/Fill queue |
| Released selection strokes | At most 32 pending strokes, `viewer.hpp:384-385` | Existing released Color/Fill requests retain their independent 1,024-request ceiling in `controller.ts` |

Only a physical pointer-down begins a new press in the browser queue; its
mouse-down and double-click records are companions. Closing admission refuses
new presses while retaining already accepted continuations. Reaching the event
ceiling cancels the queue instead of silently dropping motion or a release.
Pointer cancellation, loss of the required focus/capture/viewport identity,
hiding, modal/menu ownership and source or processing invalidation retire the
owner. Replay yields rather than blocking the browser event loop while waiting
for work to settle. The released Color/Fill FIFO remains a separate owner with
its existing cancellation, revision and latest-baseline rules; its 1,024 limit
must not be described as the desktop's 32-press limit.

## Browser popup activation ownership

[menuPress.ts](../../src/ui/menuPress.ts) is project browser event bookkeeping.
The captured popup behavior above supplies the ownership reference; it does
not supply a DOM `contextmenu` or `auxclick` algorithm.
[SelectionMenus.tsx](../../src/ui/SelectionMenus.tsx) and
[AutoColorActions.tsx](../../src/ui/AutoColorActions.tsx) consume the activation
belonging to the outside physical press even after that press dismisses the
portal. That includes primary `click`, middle `auxclick`, and both
`contextmenu` and a later `auxclick` when one right press emits both.

A physical `contextmenu` can have `detail=0`, so that value alone does not
classify it as keyboard input. Keyboard `click` with `detail=0` remains usable;
a ContextMenu or Shift+F10 keydown explicitly retires physical ownership before
the keyboard context request. Each sibling activation is claimed at most once.
A fresh pointer-down, pointer cancellation, blur, document hiding or component
unmount retires the previous press. MouseEvent-only activations without a
pointer ID retain the existing button-matching fallback. These rules prevent
an outside right press from opening the underlying Tolerance editor and keep
later independent activations available.

The source references and policy description make no current test-pass,
physical Mac input, Safari, assistive-technology, deployed-host, native build
or native execution claim. Existing
[keyboard/focus](INPUT_SCOPE_REFERENCES.md) and
[thumbnail/wheel/menu](INTERACTION_REFERENCES.md) references retain their own
scopes.

SplatView application sources retain their original
[proprietary notice](../../reference/targets/windows-r0-20261012-02/source/LICENSE):
Copyright (c) 2026 OpsiClear LLC. All rights reserved. The notice is 1,265 bytes,
SHA-256 `ff39f450fd56ce98a7da38c5981e2f4661c55cdd404b6294eace5e805f9fc132`.
This behavioral reference grants no redistribution rights or additional rights
to dependency sources. The browser glue introduces no PlayCanvas attribution
or runtime dependency; existing renderer, ImGui, ImGuizmo and other notices
retain their separate scopes.
