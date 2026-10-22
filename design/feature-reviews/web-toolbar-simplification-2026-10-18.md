# Simplify browser file and remembered-view controls

Reviewed October 18, 2026 before implementation. The user questions the two Open icons and desktop-style thumbnail action and requests simplification. This explicit browser adaptation supersedes retaining those desktop toolbar slots.

The shared contract, its save/view/thumbnail distinction and delivery amendment, feature-review template and current web design/status were read. The sealed local product 1.0.0 bundle (manifest SHA-256 `045805ef1da463f2f8b63ea965cf4847378f9a7c3025564c74f9c0c5adf29e75`), 128 bindings and native/source/toolchain locks remain. Exact preimages are captured in `.build/web-toolbar-simplification-20261018-01/preimages.json`.

## Intent and owners

The two adjacent Folder icons currently choose files and folders. Keep one one-click Open scene toolbar icon. Move Open folder to Settings / General / Scene using the existing directory input, picker ownership and collection/SOG acquisition. Keep file/drop/collection support and normal readiness/operation/memory/navigation guards. Close Settings before requesting a folder picker, retaining the original user activation and focus behavior.

Remove Update Thumbnail from the toolbar. It already saves a camera/background and clean PNG pair to browser storage through `AppController.updateThumbnail`; it cannot change operating-system file thumbnails. Expose the same operation as Remember view in Settings / General / Saved view, with clear browser-local wording. Keep transactional storage, T shortcut/focus ownership, thumbnail leases/admission, saved-view import/export, restoration, history/dirty semantics and success/failure feedback. This does not save scene edits or overwrite a source.

Keep the exact native tutorial capture separate from the active browser projection. The projected remembered-view topic opens the Tools presentation and highlights Settings, teaching Settings / General / Remember view. Its logical topic/target and registered bindings remain; all 34 active steps must still point to visible controls. Do not open a real Settings modal from the read-only tour or create a second presentation/input owner.

## Platform and surface decisions

| Target | Policy and reason | Implementation / evidence |
| --- | --- | --- |
| Windows editor | Required native Open/Open-folder authority and host-thumbnail behavior | Existing native toolbar/actions remain. Current Windows design and saved-view contracts were reviewed in the preceding alignment packet; no source/package changes or new native qualification. |
| macOS editor | Required native file grants and host-supported view/thumbnail behavior | Retain AppKit/Metal/file-grant/Quick Look owners; no native implementation or qualification claim from this web change. |
| Ubuntu editor | Required native/portal file selection and declared thumbnail host behavior | Retain SDL/Vulkan and GNOME/KDE/portal owners independently; no new desktop/provider qualification. |
| Web-lite | Required simple file toolbar; folder acquisition conditional on selected directory/files; remembered view conditional on browser storage and resource admission | Reuse the picker/controller and saved-view transaction owners. Settings placement and browser-local name are the explicit product adaptation requested by the user. |

Explorer, Quick Look and GNOME/KDE preview hosts keep their bounded read-only policies; these editor settings are excluded from provider-only surfaces. Static thumbnail providers and native file associations are unaffected. No new API/CLI, worker command, codec, format, setting/default, history owner or agent surface is introduced.

## Validation

Preserve focus-sensitive T behavior without opening Settings merely to observe a test state. Update existing toolbar, folder, saved-view and feedback browser checks to their actual reachable controls. Check real file/folder opening, clean browser view persistence/restoration, transaction refusal preserving the old pair, export/import and unchanged edited scene/history. Run relevant CPU/tutorial/product contracts, both typechecks/build, focused development/production browser checks and all 34 tutorial targets. Record actual environment and exact results; no physical Mac or native-provider qualification is required. Build output must retain only current assets and temporary Vite caches may be removed after test owners stop.

## Executed checks and limits

CPU03 passed all 84 focused cases in eight files. Build02 passed the 919-source lock, 128 product bindings, native-artifact/toolchain checks, application/benchmark typechecks and 100 runtime artifacts. The final test-source typecheck also passed. Native code and public native bytes remain unchanged.

Development02 passed 23 cases; Production01 passed 14 cases, all with zero retries. New production-friendly cases verify the four-button file group, actual file chooser, browser metadata plus PNG hash, camera/background Reset restoration with a retained executable Redo branch, and an actual directory picker receiving an empty directory without changing the open scene/history. Existing cases exercise six nested v1/v2 SOG graphs, Gaussian/point portable saved-view transfer, T focus/modifier/repeat/pointer behavior, transaction-abort preservation, Capture/Save feedback and Small/Large layout/focus. Production retains Basic cleanup/Undo, Flip/Apply, Color/Fill, all 34 tutorial steps and the packaged T/Redo journey.

The native-dialog Cancel button is not claimed: automation selects a real empty folder and observes zero files. A separate high-performance adapter probe records the available browser environment; it is not an owned-renderer identity or physical memory measurement. Evidence is Windows Chromium on secure localhost; native Apple/Ubuntu/provider qualification is unaffected. The latest Large Settings screenshot was visually inspected.

CPU01/02 retained a missing authored tutorial translation row and subsequently unused old tutorial rows; copy ownership was corrected without weakening catalog checks. Build01 retained four test-callback Node/Element typing errors, repaired without runtime changes. Development01 retained six failures: two ambiguous Settings status selectors, an unsupported directory-picker automation call, two fixtures invoking grading before actual color admission, and a retained advanced Fade/boost scenario outside the Basic product. Selectors/fixtures were repaired with all storage/history assertions intact. The advanced scenario remains in source and is excluded only from the scoped Basic configuration. No runtime source changed after Build02.

[Validation record](../../docs/validation/runs/web-toolbar-simplification-20261018-01/validation.json). No staging, commit, push, deployment or native version migration is performed.
