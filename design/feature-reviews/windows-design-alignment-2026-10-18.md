# Current Windows design alignment for the Basic web app

Reviewed October 18, 2026 before implementation. The user requests the latest Windows design, explicitly removes “Your scene, in focus.” and asks to align the remaining presentation. The Basic-only product and existing document/history owners remain authoritative.

## Source and scope

The shared cross-platform contract, its delivery amendment and feature-review template were read. Builds continue to consume the sealed local product 1.0.0 bundle (manifest SHA-256 `045805ef1da463f2f8b63ea965cf4847378f9a7c3025564c74f9c0c5adf29e75`) and frozen native/source/toolchain inputs. No sibling source becomes a build dependency.

Current Windows is commit `4e1be155511fb49f08fd8c863d785ac008a4c43a` plus its current dirty design files. This is newer presentation than the retained web snapshot. Source-inspected authority: `src/app_ui.cpp:1461–1499` (headerless empty view, paired actions and bounded centering), `src/app_ui_settings.cpp:255–365` / `src/ui_widgets.hpp:52–69` (compact property rows), `src/selection_ui.cpp:446–561` (Combine/Options, parameters, Actions) and `design/ui-design-system.md:62–67` (selected dots, no polygon count). The old prose headline-size token is superseded by the actual current canvas implementation. Exact inspected hashes and web preimages are retained with the scoped validation record under `.build/windows-design-alignment-20261018-01/`.

Implement presentation corrections through existing React components: remove the empty-view headline and visible resource footnote; retain the resource explanation on Open scene's tooltip; use the native muted instruction and primary/secondary action layout; center below the actual wrapped toolbar, protecting the branding target; align Language/Theme/Font size as compact label/field rows with selected dots; put contextual Options next to Combine, parameters/polygon controls beneath and Actions last. Hide the visible polygon point count while retaining accessible status. Preserve the established toolbar/panel/icon/palette/font tokens and per-control focus targets.

The desktop Open example uses a bundled 5,124,962-byte SOG whose asset README leaves public redistribution provenance unresolved. The web supplies a small original procedural example instead, opened through the same `openFiles` controller and normal worker/codec/resource checks: 4,096 records / 131,072 bytes, generated only on request. It does not fetch external scene data, bypass admission, add a second document/history owner or represent that scene as the desktop dataset. This is an explicit sample-content adaptation. No advanced editing or agent surface is introduced.

## Platform and host decisions

| Target | Policy and reason | Implementation and evidence |
| --- | --- | --- |
| Windows editor | Required current native design and its existing Open/OpenExample dispatch | Current source inspected; no Windows source/build/package is modified or newly qualified. |
| macOS editor | Required shared hierarchy and logical design tokens through native controls | Native font, permission and AppKit/Metal owners remain; this browser correction does not establish native implementation or qualification. |
| Ubuntu editor | Required shared hierarchy and logical tokens through its existing adapter | Existing SDL/ImGui/Vulkan and portal owners remain; no desktop/session qualification is inferred. |
| Web-lite | Required matching presentation for included Basic controls; file/example actions conditional on current readiness and resource admission | Reuse the current picker/controller, menu preview/persistence, worker, tutorial and input ownership. Original procedural example is a reviewed sample-content adaptation. |

Explorer, Quick Look and GNOME/KDE preview hosts retain their current bounded read-only presentation and host policies. Interactive editor/example/settings actions remain excluded from preview/thumbnail-only surfaces. Static thumbnail providers, native associations and headless/CLI behavior are unaffected. No API command, wire ID, format, setting/default, source overwrite, scheduler or history owner changes.

## Preservation and verification

Keep 128 explicit product bindings, frozen generated icons/translations, Basic omissions and tutorial projection. Existing folder acquisition, local saved views, offline/recovery UI and truthful export/persistence wording remain approved browser adaptations. Empty actions retain semantic names, keyboard focus, disabled gates and current file authority; a tutorial/modal owns input. Existing menu preview/cancel/commit, eight languages/themes, size scaling, focus restoration and portal positioning remain under their original owners.

Use focused existing picker/presentation contracts, both typechecks, the production build (including source/product/native verification) and scoped development/production browser checks. Verify header absence, real file/example opening, compact property rows and menu preview/focus, contextual selection order, narrow/short layouts, large text and long translations. Preserve offline test semantics when replacing the old slogan readiness anchor. Test results identify actual browser/OS/GPU/security context and their limits; no Mac hardware prerequisite or broad native/pixel parity claim. Record failures and exact passing attempts after execution.

Wrapped toolbar row paint must retain independently rounded ends when a group splits; implement only through existing toolbar geometry observation, preserving action order, Guides/Background grouping and independent targets.

## Executed validation

CPU01 passed 106 focused UI/policy cases in nine files. Build01 passed verification of 919 pinned sources, the product bundle and 128 bindings, unchanged native artifacts/toolchain provenance, application/benchmark typechecks and 100 runtime artifacts. Native code was not rebuilt or newly platform-qualified.

Development01 and Production01 each passed nine browser cases with zero retries. The four new Windows-design cases in each run prove actual 4,096-record example load and GPU JPEG capture, Basic selection order and accessible polygon status, Large/French narrow and short layouts, and Small/Large Settings property rows with selected dots and keyboard preview/cancel/commit. Existing checks cover actual primary file opening, Small/Large toolbar/Tools reflow and the bright empty view; production also replays Basic cleanup/Undo, Flip/Apply, Color/Fill and all 34 tutorial steps. Admission information remains on Open tooltips. Offline changes replace four obsolete heading readiness anchors without changing offline runtime behavior; the full offline matrix was not rerun for this presentation change.

The recorded environments are Windows Chromium on secure localhost with WebGPU. Independent adapter probes use the renderer's request options; they do not identify its owned adapter or measure physical GPU memory. Rendered captures of the French empty layout and the Basic example/selection UI were visually inspected. No Mac hardware test, native/provider qualification, staging, commit, push or remote deployment is implied. [Validation record](../../docs/validation/runs/windows-design-alignment-20261018-01/validation.json). [Source references and sample adaptation](../../docs/third-party/WINDOWS_DESIGN_ALIGNMENT_REFERENCES.md).
