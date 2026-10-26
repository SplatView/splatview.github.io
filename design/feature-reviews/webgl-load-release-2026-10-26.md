# Feature review: publish WebGL loading improvements in web 0.2.1

Reviewed October 26, 2026 before changing release metadata. The user confirms
slow loading on the public SplatView site and asks to continue publishing the
tested improvements. Public Pages still serves v0.2.0 deployment
`876142158bb9823310098d303da672463cbbb29d1ff289177709ce4e2a3b8c35`.
The source and deployment branches remain `source` and `main` respectively;
local `main` tracks `origin/source`. Never push source code to the static branch.

## Authority and policy

Read AGENTS, the shared product contract/template, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capability ledger, approved UI differences and the
existing scene-load/mode-latency review. Use sealed local bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.
No live sibling build, frozen input refresh, dependency/toolchain update,
native/WASM contract, profile migration or registration change is included.
All 133 registered bindings keep their policies and owners.

| Target | Policy and evidence | Implementation / qualification |
| --- | --- | --- |
| Windows editor | Required responsive native viewing/settings; current Windows sources cited in the previous reviewed latency record and sealed policy. | No native source/package change or new Windows native qualification. |
| macOS editor | Required native viewing and applicable capability fallbacks; existing Apple UI and sealed policy. | No Metal/AppKit change or Apple host qualification. |
| Ubuntu editor | Required native viewing and applicable capability fallbacks; existing Linux UI and sealed policy. | No Vulkan/SDL/installed-host change or new Linux qualification. |
| Web-lite / standalone browser renderer | Required existing loading and mode workflows; WebGPU/WebGL2, optional SteadySplats and output depend on actual capabilities/admission. | Publish the tested shared implementation and qualify final production bytes, public HTTPS WebGL and existing-client updates. Other browser/OS/GPU combinations remain qualification gaps. |

Explorer, Quick Look, GNOME/KDE preview and OS thumbnail providers are unaffected.
Browser-local saved views do not update system thumbnails or overwrite scene
files. UI and standalone renderer surfaces keep their existing scope. No agent,
new API/CLI action ID, tutorial topic, format or renderer/default change is added.
The additive shader-preparation SDK method was reviewed in the preceding record.

## Change and evidence

The existing local implementation overlaps final GPU upload completion with
saved-view lookup and recovery checkpoint creation, then joins both before
publishing the private candidate. Old documents survive failed/cancelled loads.
General settings prepares Steady shaders without allocating full frame buffers;
WebGPU uses asynchronous Steady compilation and concurrent independent startup
compilers. Keep every source/native identity, memory, worker, controller,
history, cancellation, retirement and publication check.

The immutable preceding evidence packet is
`docs/validation/runs/scene-load-mode-20261025-01/validation.json`: 6,480 portable
tests, 40 build contracts, 100 Python tests with one skip, 166 final browser
executions, app/SDK closure and exact source identities. Local three-run medians
showed WebGL load 970.9 -> 690.5 ms and first WebGPU Steady selection after a
fixed 500 ms Settings reading interval 109.1 -> 30.6 ms. First WebGL Steady
activation remains about 419 ms. These are Windows Chromium/NVIDIA observations,
not universal or physical-presentation performance claims. The public site had
not received this code when the user reported the continued delay.

Publish v0.2.1, changing root/lock version metadata only and deriving SDK version
from it. Preserve the preceding reviews and raw receipts. Build app and SDK;
run the existing product/source/native/generated/type/build gates and meaningful
final-artifact production/SDK browser checks. Keep an old public client open,
deploy exact bytes without force, retain old hashed assets and publisher/legal
pages, verify Pages plus every public artifact, then verify updating that old
client and automatic WebGL fallback. Publish archives, manifests, checksums and
validation evidence. No new algorithm experiment is part of this release.

## Release qualification

Final local build identities and checks will be recorded here before source
tagging. Publication, HTTP byte checks and live browser evidence belong in the
release's validation asset so the tagged source review remains immutable.

Qualified release candidate: app deployment `8977efc22888cb00b735baf3309b184beb6b8b3376722c80cb6c12d87bc10e02`, app input `59211030f56c0006c3f337edc68d92ded8a4434b932336c8d354551929f3547a`, SDK source `69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`. Fresh checks passed: 6,480 portable tests, 40 build contracts, both TypeScript projects, 919 frozen source/native/generated inputs and product 2.0.0 / 133 registrations. Final-artifact browser cohorts passed: 14 standalone plus 40 production per backend, with zero retries, skips, flakes or unexpected results. The archives match all 111 app / 63 SDK artifact hashes and passed exact extraction checks. The prior 166-case packet remains separately identified historical qualification. Native/provider and other browser/OS/GPU qualification remain separate. Publication and public byte/update evidence will be added to the release validation asset.

The fresh Python tool suite also passed all 100 cases with one existing host skip. The Node build-contract suite passed 40/40. Release browser evidence is Windows Chromium 156 / NVIDIA RTX 5090, secure loopback, cross-origin isolation false and the existing unsafe-WebGPU flag; public HTTPS is checked separately.
