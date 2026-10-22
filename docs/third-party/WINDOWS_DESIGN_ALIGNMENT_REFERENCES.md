# Current Windows design alignment

October 19 sample update: the procedural example described in this October 18
review has been replaced by the exact desktop Bench SOG and authored camera.
See [desktop sample provenance and Mip-NeRF 360 attribution](DESKTOP_SAMPLE_REFERENCES.md)
and the [new feature review](../../design/feature-reviews/desktop-tutorial-sample-2026-10-19.md).
The original presentation review and its evidence below remain historical.

Reviewed October 18, 2026. The authority is the current sibling Windows source at
commit `4e1be155511fb49f08fd8c863d785ac008a4c43a` plus the inspected dirty files.
This supplements the web's frozen native baseline for presentation only. Builds
continue to use their sealed local product bundle and pinned source/toolchain
inputs. No live sibling dependency or source-lock refresh is introduced.

The exact 14 inspected files and retained copies are recorded in
[the reference manifest](../../.build/windows-design-alignment-20261018-01/windows-reference.json).
Key implementation sources and resulting adaptations:

| Windows source | Web presentation |
| --- | --- |
| `src/app_ui.cpp:1461–1499` | Remove the empty-page headline and visible resource footnote. Retain the muted drop instruction, primary Open scene and secondary Open example. Actions share natural widths of at least 154 logical pixels, height 28, 6-pixel inline / 4-pixel stacked gaps, with 8 pixels below the instruction. |
| `src/app_ui.cpp:1478–1487` | Center within the available region below the actual wrapped toolbar. Reserve space above the branding target when actions overlap it horizontally. |
| `src/app_ui.cpp:866–891` | Round each actual toolbar row independently, retaining 36-pixel targets, semantic groups, action order and Guides/Background grouping. |
| `src/app_ui_settings.cpp:255–365`, `src/ui_widgets.hpp:52–69` | Language, Theme and Font size use compact label-left / field-right rows, with 6-pixel gaps and a bounded shared label column. Keep the existing browser menu/preview/persistence/focus owners. |
| `design/ui-design-system.md:62–67` | Selected menu choices use a decorative dot. Polygon point count is omitted visually; the browser retains a screen-reader status. |
| `src/selection_ui.cpp:446–561` | Contextual Options sits beside Combine; parameters and polygon commands follow at full width; Actions comes last. |

The design document still lists an old empty-view headline size. The actual
current canvas and `design/feature-reviews/ui-layout-audit-2026-10-17.md` establish
the headerless layout; the stale token does not restore a headline.

## Example content

The native example loads `assets/tutorial/bench.sog` through its existing
leave/open flow and resource owner. Its asset README leaves public distribution
provenance and attribution unresolved. This web update does not copy that data.

[exampleScene.ts](../../src/app/exampleScene.ts) creates an original colored
trefoil tube when Open example is clicked: 4,096 SPLAT records, 131,072 bytes,
with no external asset, fetch or persistent cache. The existing `openFiles`
controller, native decoder, GPU and resource-admission path load it. The sample
content differs from the desktop dataset; editing and history ownership remain
shared with ordinary opened files.

## Scope and evidence

Basic-only omissions, browser folder authorization, local saved views and
offline/recovery controls retain their existing decisions. No Agent or advanced
editor surface is added. The native engines, formats, generated icons/catalogs,
worker protocol, resource budgets and product bindings are unchanged.

[Feature review](../../design/feature-reviews/windows-design-alignment-2026-10-18.md).
[Scoped validation](../validation/runs/windows-design-alignment-20261018-01/validation.json).
Passing browser geometry and image checks are separate from native platform
qualification or a universal pixel-identical appearance claim.
