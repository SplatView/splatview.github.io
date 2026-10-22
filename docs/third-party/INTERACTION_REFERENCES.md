# Thumbnail, wheel and color-menu interaction references

These browser interactions follow the captured SplatView desktop source in
[`windows-r0-20261012-02`](../../reference/targets/windows-r0-20261012-02/CAPTURE_MANIFEST.json),
capture ID `cc71f0df-8f38-4900-8aff-5c9ee0d6814c`.
The sources below are behavioral references. The native camera mathematics,
color processing, saved-view persistence and generated preset catalog retain
their existing implementations and attribution.

| Captured source | Bytes | SHA-256 | Behavior used |
| --- | ---: | --- | --- |
| [app_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/app_ui.cpp) | 67,853 | `27c47e26e16186a96d4d287acf66d2e29b4964988816577839004483204c4700` | Lines611–624: plain first-press T saves a thumbnail only when the viewport owns input and work/capture permit it |
| [main.cpp](../../reference/targets/windows-r0-20261012-02/source/src/main.cpp) | 50,059 | `c102d043566a2865fd482e326a2169eaba001ac60268e5ef2d9396efa7a9f40c` | Hovered viewport wheel ownership, excluding UI and popups |
| [preview_pane.cpp](../../reference/targets/windows-r0-20261012-02/source/src/preview_pane.cpp) | 11,959 | `a4e1f546b9be47f9046e7473deb253fa861658345709750d810e056f0710efeb` | Embedded preview wheel routing follows the same pointer boundary |
| [viewer.cpp](../../reference/targets/windows-r0-20261012-02/source/src/viewer.cpp) | 45,885 | `9644da5fdb7a97d0c3fcc6dcd4e80ecab614f67ba04fffc6ca96121a4679086e` | Alt-wheel changes Brush/Volume diameter; ordinary wheel uses eased native navigation |
| [color_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/color_ui.cpp) | 4,267 | `3a6574a1ccf3565e5a669ac03b42092e84a4060b6ba6c688e806b01b45d64469` | Auto and Presets use the shared hover-open icon menus and retain explicit action/recipe choices |
| [selection_ui.cpp](../../reference/targets/windows-r0-20261012-02/source/src/selection_ui.cpp) | 46,403 | `6880ed61e5f7aaa31594c1cd0b52ebad36a1a1633ecf5e5cf498201ec595862c` | Shared 300ms hover/away timing, pin/unpin, grouped switching and selector-to-popup bridge |

The browser keeps Ctrl/Cmd+T for a new tab and Ctrl/Meta-wheel for browser zoom.
Wheel follows the hovered canvas independently of keyboard focus. Fresh modal,
registered menu and tutorial state precedes scene wheel actions, including
Alt-wheel sizing; UI scroll containers keep scrolling local at their edges.
The browser normalizes pixel, line and page wheel deltas before passing ticks
to the existing native smoothing implementation.

The T shortcut calls the same browser thumbnail/default-view operation as the
toolbar, with matching availability and additional first-press/no-capture
guards. It saves in this browser's IndexedDB; it does not write a sibling file
or invoke an operating-system preview extension.

Color-menu hover controls presentation and focus ownership only. It performs
no Auto analysis, preset image rendering, scene bake or history operation.
Automatic full-scene commits on pointer release and Auto-on-hover analysis
remain outside this browser interaction change; explicit Apply is retained.

SplatView application sources retain their original
[proprietary notice](../../reference/targets/windows-r0-20261012-02/source/LICENSE):
Copyright (c) 2026 OpsiClear LLC. All rights reserved. This reference adds no
redistribution rights, third-party runtime or PlayCanvas-derived source.
The [keyboard and focus notice](INPUT_SCOPE_REFERENCES.md) and existing native,
renderer and dependency notices retain their separate scopes. Automated DOM
wheel admission and Chromium mouse-wheel checks do not establish physical
Mac trackpad, Safari or assistive-technology behavior.
