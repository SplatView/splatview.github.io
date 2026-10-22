# Tutorial sample preparation

Review date: October 18, 2026. User request: “tutorial should load the sample data”. This changes preparation of the existing UI-only `tutorial.play` capability; no registration, native ABI, worker command, format, settings schema or product policy changes. Product contract 2.0.0 remains sealed, manifest SHA-256 `fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`. Preimages of changed runtime files are recorded in `.build/tutorial-sample-20261018-01/preimages.json`.

## Behavior and ownership

The first-run offer currently starts a presentation-only tour over an empty viewport. Start and Help → Tutorial will prepare the existing original procedural web example when the viewer is empty, using `createExampleScene()` and the existing controller file intake, admission, worker/native decode and renderer publication path. The example is 4,096 splats / 128 KiB; it requires no download or external dataset grant. An accepted offer alone and Skip do not load anything.

Wait for actual loaded-summary and renderer readiness before entering the first step. `openFiles()` resolves without throwing on some refusals, so promise settlement alone is insufficient. Disable duplicate Start while preparing and retain Skip/Escape through the tutorial portal. Preparation failure dismisses the presentation so the controller's existing error surface is available; Help replay may retry. A retired presentation attempt must never reopen the tour. Closing preparation dismisses tutorial ownership; the ordinary controller-owned example intake may finish as a normal open scene, and a newer intake supersedes it using existing controller ownership. Do not call global cancellation from a stale presentation callback.

If any scene is already loaded (including an empty edited Gaussian document or a geometry scene), do not call any loader or replace the document. Existing selection, dirty previews, history, executable Redo, source grants, saved views, camera and current document stay under their existing owners. A sample opened from an empty viewer remains a normal practice scene on exit. No saves, source overwrites, remembered views or thumbnails are created automatically. The hook owns presentation/preparation state only; it receives an application-owned preparation callback.

## Platform and provider review

| Target | Policy / source evidence | Decision and verification boundary |
| --- | --- | --- |
| Windows editor | Tutorial required; latest `../SplatPreview/src/tutorial_demo.hpp` and `src/app_ui_tutorial.cpp:290–335,952` use a suspended real viewer and isolated sample session | Preserve native behavior; this browser patch does not implement or qualify a native session. |
| macOS editor | Tutorial required; current local `../splatview_macos/src/ui/editor_ui.cpp:1377` retains an older text walkthrough | Preserve existing adapter; native tutorial session work and Apple SDK/runtime qualification remain separate. |
| Ubuntu editor | Tutorial required; `../splatview_ubuntu/src/linux/tutorial_app.inl:29–37,700–765` isolates its tutorial Document/UI and retires it before restoring the user document | Preserve native owners and session restoration. No Linux changes or new native qualification. |
| Web-lite | Projected Basic tutorial required, ordinary sample intake conditional on an empty ready viewer and existing resource admission | Empty-only preparation is a bounded browser adaptation. Replay on a loaded scene remains lossless. This does not claim latest Windows/Ubuntu isolated-sample-and-return parity. |

Windows Explorer, macOS Quick Look, Ubuntu GNOME/KDE preview and thumbnail providers receive no tutorial entrypoint, sample, agent/API/CLI surface or resource. Their host allowlists, grants and qualification remain unchanged. Use the original browser trefoil; native `bench.sog` redistribution is not established by this patch (see `docs/third-party/WINDOWS_DESIGN_ALIGNMENT_REFERENCES.md`).

## Contracts and checks

Retain source/toolchain/generated-asset checks, the pinned product verifier (128 bindings), Basic tutorial projection/order/targets, localized labels, focus trapping, keyboard ownership, native worker/resource/history contracts, and normal file-admission/error handling. Pending text reuses localized “Opening scene”; Start/Skip labels and placement remain shared with the existing offer. No advanced feature or agent access becomes reachable.

Validate real-app first Start and empty Help replay, no-load Skip, readiness before the tour, completion/close with the sample still usable, and preservation of a loaded edited scene with executable Undo/Redo. Cover late preparation completion and failed intake without a phantom tour. Run focused tutorial contracts, TypeScript/build/source/native/product checks, production Basic workflows, then publish the complete clean build and verify deployed HTTPS assets and browser journeys. Physical Mac testing is not required; observed browser evidence must name its actual platform.

Validation status: the implementation passed 51 focused tutorial CPU tests and 10 production-browser cases, including all 34 projected steps with the loaded sample, no-load Skip, empty Help replay, edited-scene/native Redo preservation, duplicate activation/pending focus/Escape/late completion, and injected failure followed by successful retry. Source/product/native checks, both TypeScript projects and the production build pass. The first pending-focus case exposed a real disabled-button double-click blur; preventing that pointer default fixed the issue and the complete cohort then passed with zero retries. Live HTTPS qualification and publication evidence will be recorded in `docs/validation/runs/tutorial-sample-20261018-01/validation.json`. Browser evidence is Windows Chromium 156 with WebGPU; native providers and other browser/platform configurations are not newly qualified.
