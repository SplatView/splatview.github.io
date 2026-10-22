### Historical tutorial v3 reference

This record describes the earlier R0 tutorial. The current desktop-aligned implementation and source provenance are in [tutorial v7 references](TUTORIAL_V7_REFERENCES.md).

# Tutorial source references

The browser tutorial derives its version, ordered catalog and onboarding behavior
from the verified `windows-r0-20261012-02` SplatView desktop source capture. The
capture ID is `cc71f0df-8f38-4900-8aff-5c9ee0d6814c`; its
[capture manifest](../../reference/targets/windows-r0-20261012-02/CAPTURE_MANIFEST.json)
records the original source identities. The references below are captured source
evidence, not newly executed native contracts or a claim of complete desktop
visual parity.

## Exact captured sources

| Captured source | Bytes | SHA-256 | Reused contract |
| --- | ---: | --- | --- |
| [tutorial.hpp](../../reference/targets/windows-r0-20261012-02/source/src/tutorial.hpp) | 7,606 | `f6483dfcc7c1918e595f5a4cc1b4c1b5dd402b0c7598d5a1bf8bb4defd6deeb1` | Version3, 38 ordered steps, target enum, sections and displayed Basic/Pro mode |
| [app_ui_tutorial.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui_tutorial.cpp) | 16,102 | `6aa6586a8568b9d1b0d4da49da2b492c1d6ab9940d70da5a297e1a0c8b570189` | Offer/start/replay/close behavior, temporary layout, target revealing, bounded card placement and input ownership |
| [tools_preferences.cpp](../../reference/targets/windows-r0-20261012-02/source/src/tools_preferences.cpp) | 5,303 | `7dcb03c6228aaf6c7383af4170cb6b5335f5b47da80a53439528ca5489617a3b` | Handled-on-offer marker, prior-version suppression, v3 completion and failed-save behavior |
| [app_ui_settings.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui_settings.cpp) | 12,876 | `df5cb79ad36896c20ebb85526865dde11818788f925eb2b9574fdf537497b747` | Tutorial replay from Settings > Help |
| [app_ui_default_apps.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui_default_apps.cpp) | 9,572 | `c563ec5733ca639949865a76b1b504516ccc5ebece0f6aee92ded4ffac8c7a66` | Onboarding deferral during active input, processing, confirmations and popups |
| [app_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui.cpp) | 67,853 | `27c47e26e16186a96d4d287acf66d2e29b4964988816577839004483204c4700` | Target registration, displayed layout and tutorial keyboard admission before scene tools |

`tutorial.hpp:7` declares version3. Its initializer at lines56–152 contains
**38 steps and 37 unique targets**; Filter is intentionally used twice. The order
is nine toolbar steps, five fixed-header steps, twelve Selection steps, five Color
steps and seven Transform steps. Steps10–38 show Tools; only steps25,26,31,36,37
request Pro presentation. The browser
[catalog](../../src/app/tutorialCatalog.ts) retains every original native title,
body, target and source line alongside the browser-facing copy.

## Behavior and browser adaptations

`app_ui_tutorial.cpp:53–84` records an offer when it is first shown, before Start
or Skip. `tools_preferences.cpp:94–107` suppresses first-run onboarding after a
handled offer or any positive prior tutorial version, including versions older
than3. This differs from the current-version completion check at lines76–84.
Closing a tour early, pressing Escape or finishing records version3
(`app_ui_tutorial.cpp:152–168`, `tools_preferences.cpp:152–156`). Replay is requested
from Help (`app_ui_settings.cpp:251–263`) and marks the tutorial offered on start
(`app_ui_tutorial.cpp:171–194`). Failed writes retain the choice in the current
window and expose the captured preference-save error.

The browser [preference module](../../src/app/tutorialPreferences.ts) adapts the
native preference-file behavior to a dedicated versioned local-storage key. It
retains the native `tutorial_version` and `tutorial_prompt_handled` field meanings,
preserves unrelated record fields and keeps an in-window fallback after a refused
write. Browser storage is separate from scene and editor state.

The following wording changes describe the current browser controls:

- Explorer thumbnail/default-view integration becomes a browser saved camera
  view, background and thumbnail, with import/export in Settings. The tutorial
  does not promise Windows Explorer integration or the native T shortcut.
- Fill uses plain G while the scene has focus; Ctrl+G remains owned by the
  browser. Other shortcut wording distinguishes Ctrl from Command where needed.
- Auto color and Presets describe choosing a menu action. The current web menus
  do not preview corrections or presets on hover. A chosen preset updates the
  color preview; Apply color commits it.
- Lens/fullscreen and collection-browsing wording respects browser shortcut and
  focus boundaries. Reset color describes the actual preview reset without
  promising a new Undo entry merely from resetting pending controls.
- The web can explain disabled controls before a scene is open and displays an
  explicit unavailable-control message when a target is absent. It does not load
  a scene or create a filter, alignment or transform draft to manufacture targets.

These authored strings live in
[translations/tutorial.ts](../../src/app/translations/tutorial.ts). Unchanged
native titles, bodies, offer copy, navigation labels, counter and save error use
the existing exact-key native translation catalog. Its provenance and served
ownership notice remain documented in
[LANGUAGE_REFERENCES.md](LANGUAGE_REFERENCES.md). Browser adaptations do not alter
that frozen generated catalog.

## Presentation and input boundary

`app_ui_tutorial.cpp:48–50` selects a temporary displayed tools mode;
`app_ui.cpp:1047–1057` renders the tutorial layout without switching the viewer's
editing mode. The web follows that presentation boundary through
[App.tsx](../../src/ui/App.tsx), [useTutorial.ts](../../src/ui/useTutorial.ts),
[TutorialOverlay.tsx](../../src/ui/TutorialOverlay.tsx) and
[tutorialLayout.ts](../../src/ui/tutorialLayout.ts).

Step changes project Tools visibility, Basic/Pro presentation and required folds.
They do not call `switchToolsMode`, overwrite the committed or pending profile,
select a tool, change preferences for selection, or start/end a scene-editing
session. Existing local fields, folds and scroll positions are retained for exit.
The tutorial owns input before scene shortcut handlers; highlighted controls are
inert. Source, camera, selection, pending grading/native owners and Undo/Redo are
outside the tutorial's presentation state.

Native target registration/reveal and same-row merging are described at
`app_ui_tutorial.cpp:197–242`. Card placement uses clamped candidates and prefers
clear space around the target (`16–44`, `249–287`); navigation stays outside the
scrolling explanatory body (`296–328`). The browser uses semantic target IDs,
bounded target rectangles and the existing Tools scroll owner. It uses static
outlines, honors reduced motion and adds no scene-render animation loop. These
are bounded tutorial contracts, not additional scene processing or capacity
claims.

## Ownership and third-party scope

The captured SplatView application source and original tutorial catalog are
covered by the original
[proprietary notice](../../reference/targets/windows-r0-20261012-02/source/LICENSE):

> Copyright (c) 2026 OpsiClear LLC. All rights reserved.

That notice is 1,265 bytes with SHA-256
`ff39f450fd56ce98a7da38c5981e2f4661c55cdd404b6294eace5e805f9fc132`.
Source capture, catalog transcription and browser adaptation do not relabel this
material MIT or grant additional redistribution permission. The inherited
proprietary translation notice remains served at
[/licenses/SplatView-translations.txt](../../public/licenses/SplatView-translations.txt).
Existing third-party copyrights and licenses continue to apply to their own
materials.

This tutorial packet reuses no external PlayCanvas code and adds no PlayCanvas
runtime dependency. It adapts the captured SplatView tutorial behavior to the
repository's existing React/DOM presentation. Existing native/renderer and
third-party dependency attributions retain their prior scopes; this notice makes
no new native-build or native-execution claim.
