# Desktop-style tutorial courses for Basic web

Review date: October 18, 2026. User requested a tutorial revision and selected “Closer to the latest desktop tutorial”. This amends the existing `tutorial.play` UI behavior and the empty-viewer sample adaptation; no new feature, target registration, native/worker command, format or agent surface is introduced.

## Authority and scope

Current Windows tutorial v8 uses `tutorial_course.hpp` Essentials (22 lessons) and All topics (49 topics), with chapters, Topics navigation, progress and authored sample playback. Reviewed current-source bytes for `tutorial.hpp`, `tutorial_course.hpp`, `app_ui_tutorial.cpp`, `tutorial_demo.hpp` and `tutorial_demo.cpp` are preserved in `.build/tutorial-course-20261018-01/desktop-source.json` and its exact source copies. The course header SHA-256 is `0787d3bc3fd10df607cce928329d61b8b15cad5b0a0177f5b7b25204d360469c`. These are review inputs, not build dependencies or a refresh of frozen desktop sources.

Keep the original v7 capture, its 47 adapted native steps, fixture hashes, version and source provenance intact. Product contract 2.0.0 remains sealed at SHA-256 `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`, with 128 bindings. Use a separate pure browser course descriptor composed from allowed Basic topics, preserving stable IDs and native lineage.

The Basic Essentials course follows the current desktop sequence with the two excluded advanced selection lessons removed: 20 lessons. All topics exposes the existing 34 supported Basic topics. The combined Settings/modes native lesson becomes Settings. Chapters, compact counter, Topics picker, thin progress and B/N navigation follow the current desktop card. Back/Next/Exit remain reachable while only the body scrolls. Translate all new copy for the existing eight UI locales.

The current browser implementation is a text tour with highlighted real controls and a visible scene, not native authored animation playback. Label it “Text tour”; do not add nonfunctional Play/Replay, claim an animated demonstration or enable editing under the modal. Native isolated-demo playback/retirement and explicit practice adoption remain separate parity work. The existing bounded web behavior stays: prepare the original trefoil only when empty, leave it available for practice, and retain an already loaded user document without replacing it.

Correct browser-specific copy: Save downloads a new copy; remembered views are browser-local; Clear is C (X chooses Rectangle), gizmo cancellation is Esc, color uses preview/Apply semantics, and excluded Pro/agent instructions stay absent. Preserve source grants, dirty previews, native history/Redo, camera, saved views, resource admission and all controller/worker ownership.

## Platform and host decision

| Target | Policy, source and implementation boundary |
| --- | --- |
| Windows editor | Tutorial required; current v8 course/presentation source is the reviewed reference. Existing isolated `TutorialDemoSession`, playback and practice adoption stay native and unchanged. |
| macOS editor | Tutorial required; local shared editor still retains the older text walkthrough (`../splatview_macos/src/ui/editor_ui.cpp:1377`). Native course/playback parity and Apple runtime qualification are separate gaps; no native code changes. |
| Ubuntu editor | Tutorial required; `../splatview_ubuntu/src/linux/tutorial_app.inl:29–37,700–765` owns an isolated tutorial Document/UI and restores its original document after retirement. Preserve those owners; no new Linux qualification. |
| Web-lite | Capability-projected Basic tutorial required. Implement desktop-style Essentials/All topics, chapters, progress and navigation over the existing text-tour/sample boundary. Demo animation and full desktop editing topics are not advertised. |

Windows Explorer, macOS Quick Look, Ubuntu GNOME/KDE preview and thumbnail providers receive no course entrypoint or new resource/permission. Their allowlists and native qualification remain unchanged. No API or CLI lesson/surface is added to this UI-only capability.

## Ownership, accessibility and validation

`useTutorial` remains the sole course/index/preparation/input owner. A pure course module owns topic composition and chapter metadata; the overlay owns its local Topics browser presentation. Topic jumps never mutate a document, saved profile or selection. Closing Topics returns to the tour; Escape then closes the tour. B/N requires no modifiers, no composition/repeat and a non-editable target; it is disabled while browsing Topics or preparing. Keep input/key-up consumption, focus containment, reduced-motion rules, existing layout helpers and readable fixed navigation at narrow/zoomed sizes.

Do not re-offer onboarding just because copy/course composition changed. Preserve existing positive-version suppression, failed-storage fallback and completion semantics; the sealed v7 identity is not silently migrated to v8.

Validate frozen-catalog provenance, explicit 20/34 course composition, Basic policy, new locale rows, source/native/product checks and both TypeScript projects. In the actual built app, validate first-run sample preparation, every Essentials and All-topic anchor, Topics switching/jumps/focus, guarded keyboard navigation, translated narrow/reduced-motion layout, completion/dismissal/failure/retry, and edited-scene/native Redo preservation. Publish only the exact clean qualified build, remove its superseded hashed leaves and verify HTTPS asset bytes/MIME plus actual deployed browser journeys. Evidence will be recorded in `docs/validation/runs/tutorial-course-20261018-01/validation.json`; physical Mac testing is not required.

Validation status: 63 focused CPU tests, source/native/product checks, both TypeScript projects and the production build pass. Both production cohorts passed all 16 cases, including every Essentials/All topic target, Topics navigation/focus/keyboard guards, German narrow and Chinese normal layout, sample failure/retry/dismissal and loaded dirty-scene/native Redo preservation. Visual review confirmed the welcome card and narrow Topics browser; topic rows were then aligned to the start edge to match the desktop list, rebuilt and checked again. Final build identities, deployed HTTPS checks and visual evidence are recorded in the validation record linked above. No new native provider, physical Mac or animated-playback qualification is claimed.
