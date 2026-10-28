# Feature review: SplatView web 0.2.2 publication

Reviewed October 27, 2026 before version/build changes. The user explicitly
requests publication of the current source, baseline
`da8b68000eb8b42ba6eb2afa161d69670d4d6ad4`. Read AGENTS, README, WEB_PORT_PLAN,
IMPLEMENTATION_STATUS, capabilities/approved differences, the shared product
contract/template and the Settings, update-notice and project-cleanup reviews.
Use sealed local bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

## Scope and retained behavior

Publish the already implemented flatter Settings and ordinary icon-only update
control in the top toolbar. General exposes SteadySplats tuning directly;
redundant headings/subtitles and a separate bottom update notice are removed.
Preserve rendering/defaults, exact picks/maps/captures, native history, sorted
fallback, automatic WebGPU/WebGL2 negotiation, localized accessibility/focus and
dirty-scene update/save/discard/cancel behavior. Source layout and historical
evidence cleanup are included; builds still do not fetch the evidence archive.

Only release metadata, generated build identity and publication records change
in this release step. Set root package/lock version to 0.2.2 without dependency
updates. The standalone package derives its version from root. Preserve all
133 registrations, source/toolchain locks, generated authority, native/WASM
publication and existing worker/admission/controller/history/GPU owners.

## Platform and surface policy

| Target | Policy and current evidence | Adapter, implementation and qualification |
| --- | --- | --- |
| Windows editor | Required preservation of native Settings/update/host behavior and the shared product contract. Existing browser adaptations are reviewed in Settings/update records. | No native editor/installer source changes. Qualify web artifacts on Windows Chromium; no new native runtime/package qualification. |
| macOS editor | Required preservation of native settings, AppKit/Metal and host integration under the sealed policy. | Browser presentation/distribution only; no Safari, Apple runtime, Metal or Quick Look qualification. |
| Ubuntu editor | Required preservation of native settings and host contracts under sealed policy. | No SDL/Vulkan/package change; GNOME/KDE runtime remains unobserved. |
| Web-lite and standalone browser module | Required publication of the reviewed UI and existing renderer APIs/defaults. Offline updating remains conditional on verified production assets, secure context, service-worker/storage support and existing admission. | Run current app/SDK checks, fresh production/backend tests and bounded genuine update cases. Verify actual Pages bytes and existing-client upgrade separately. Other browser/GPU evidence remains a gap. |

Explorer previews, Quick Look, GNOME preview, KDE preview and thumbnail providers
are unaffected; no runtime/provider entry point is changed. Browser-local saved
views still do not overwrite scene files or update OS thumbnails. No API/CLI,
action registration, advanced editing feature, profile migration, telemetry
setting or source-overwrite command is introduced. Existing tutorial targets
and course projection remain.

## Publication and validation

Source remains on remote `source`. Remote `main` contains static GitHub Pages
files; never push source commits to that branch. Use an isolated static worktree
based on the fetched published branch, preserve existing hashed assets and
publisher/legal pages, and compare the staged Git blobs to the tested build.
No history rewriting or force push. Create an annotated v0.2.2 source tag and
GitHub release with application/renderer ZIPs, manifests, checksums and bounded
validation evidence. Existing release assets/tags remain immutable.

Run project/product/source/generated/native/toolchain checks, both TypeScript
projects, full portable/Python/build-tool tests, standalone browser cases and
production WebGPU/WebGL2 journeys. Recheck the changed Settings/update/focus UI
with actual browser screenshots. Build fresh immutable offline A/B/C fixtures
and test the toolbar entry plus real save/discard/stay guards; do not label old
fixtures as current. Keep the full native receipt collector's existing strict
filter diagnostic issue separate; do not loosen it to claim new qualification.

Before deployment, retain an existing v0.2.1 HTTPS client for a real upgrade.
After Pages completes, fetch and hash every application distribution file and
protected publisher page, exercise a live WebGL fallback and Settings/Steady
journey, and verify the old client reaches 0.2.2 through the actual update flow.
Download published assets again and compare their sizes/SHA-256. Record actual
source/build/deployment/tag identities, results, failures and browser/OS/GPU/
security-context evidence. Qualification remains scoped; no new performance,
capacity, assistive-technology or cross-platform native claim is introduced.

Raw run output: `.build/validation/release-v0.2.2-20261027-01/`. Final local
qualification is appended before tagging. Publication/live evidence is attached
as `validation.json` and a checksum-pinned release evidence archive, preserving
the tagged review bytes.

## Final local release qualification

Prepared package/application/standalone version 0.2.2 with unchanged dependencies
and native publication. The lockfile differs from the baseline only in its root
and root-package versions. All 1,184 protected application/controller, renderer,
document/worker, offline, standalone, native/public/product/reference and fixture
implementation files match baseline exactly.

Current application input:
`a3927b83a69a3a632ee43f6e60abff2afd022ecb2c6b3838479845e5996a7686`.
Current deployment:
`176da6c5ad6ed0fef031e73f1819795b999b9abf1bf2f6ba1d41ee334aab68b3`.
Native input remains
`59b0d5f23b429590c4804a68ecba23fb6d3b0b1c3c44f17cb92d6b5ba81b3230`.
Standalone renderer source remains
`69b1994252a7e622f4ddee742748aa50e7ea56dbdcedd222e7c495192f01d5b1`.

Actual final-artifact checks:

- App build passed the 919-file source closure, generated assets/translations,
  sealed product adapter, native/toolchain verifier, both TypeScript projects
  and production build. Project layout check passed. Product bundle 2.0.0
  verifies all 133 registrations; native qualification remains false.
- Standalone build verified 63 artifacts and an isolated TypeScript consumer.
- Full portable suite: 6,480 passed. Node build contracts: 40 passed. Python
  tools: 115 tests, 114 passed and one existing host skip.
- Browser executions: 33 Settings/appearance/focus cases, 14 standalone cases,
  40 production WebGPU cases, 40 production WebGL2 cases, and six genuine
  offline/update cases. All passed with zero skips, failures, flaky outcomes or
  retries. Coverage overlaps; 133 executions are not unique capability coverage.
- Fresh immutable offline fixture set:
  `ce2d4da6068ea4db22600b72eeeb247f18ef48ad0cd72b76583a8387049a56ca`.
  Root/project A/B isolation, natural first-visit C-router activation/rebinding,
  Update and Stay, Update and Discard, and whole-scene download-acknowledged
  Update Save passed. The offer helper exercises the real toolbar entry before
  the existing dirty-scene update path. No cache/navigation guard was weakened.
- Eleven production Settings captures cover desktop Small/Large, Help/Privacy
  and narrow French layout; all measured bodies have no horizontal overflow.
  Inspected General, narrow scrolled actions, Bright compact update UI and the
  real offered-update toolbar. The production update button is 36 x 36 at
  y=12 while the old application remains pinned. Actual native edits/Undo/Redo
  are covered by the browser cohorts, independently of appearance-only tests.
- The distribution manifest was reconstructed from current inputs and all
  111 artifact hashes, the four source maps and exact 116-file app closure were
  checked. Application/renderer ZIP members were compared byte for byte to their
  distributions. Nine existing publisher/legal file identities are pinned for
  deployment preservation. Whitespace checks pass.

Observed host: Windows Chromium 156.0.8078.4, NVIDIA Blackwell / RTX 5090 hardware
family, non-fallback WebGPU plus actual WebGL2 production paths. Secure localhost
origins are not cross-origin isolated. WebGPU cohorts use the existing
`--enable-unsafe-webgpu` flag. Other OS/browser/GPU, native editor/preview/provider,
assistive-technology, full offline fault matrix, physical presentation/memory
and scene capacity are not newly qualified. The existing large-chunk advisory,
one Python host skip and separately documented optional strict native collector
filter-diagnostic issue remain explicit; there are no new failed local checks.

Publication/live results will be captured in the release assets without editing
this review after the annotated source tag. The GitHub connector does not
provide release/Pages operations; publication uses the existing Git/GitHub CLI
workflow with an isolated static checkout.
