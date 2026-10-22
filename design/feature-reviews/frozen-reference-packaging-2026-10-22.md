# Frozen reference packaging

Review date: October 22, 2026. Origin: web checkout at
`a34b4685e5887773263d98a9ee37b1c2b12cf6c0`, initially clean. This corrects
development-source distribution; it changes no application feature or registration.
The local product bundle remains version 2.0.0, manifest SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

The import omits all 616 Windows-reference files required by
`native/SOURCE_LOCK.json`, plus the earlier desktop capture used by asset and
translation checks. Local verification succeeds only because ignored files
survive in this workspace. The captured ImGui and desktop `.gitattributes`
can normalize hash-locked bytes if those trees are committed as ordinary files.
The finite pivot capture is already tracked separately.

Package the existing, verified references in a local ZIP and provide an explicit
restore command. Every member must match the unchanged source lock or capture
manifest. Reject incomplete, additional, unsafe or corrupt members and conflicting
existing files before restoring anything. Restore only missing files; preserve
matching files, manifests, generated assets and sibling workspaces. Build and
verification commands must not capture, restore or refresh inputs implicitly.

| Target | Policy and evidence | Implementation and qualification |
| --- | --- | --- |
| Windows editor | Excluded from this web development command. Its current source/capture identities remain authority; `tools/capture-sources.py` and `tools/generate-assets.py` consume their sealed bytes. | No native editor changes or new native qualification. Windows web-development restoration requires Python and the checked-in archive. |
| macOS editor | Excluded from this command. The portable native snapshot under `native/upstream/splatview` remains separately tracked and pinned. | No AppKit/Metal changes or qualification. The Python restoration tool must use portable paths and ZIP handling. |
| Ubuntu editor | Excluded from this command. This distribution correction does not alter the shared native product or its adapter. | No Linux editor/session changes or qualification. The same portable restoration rules apply to a web source checkout. |
| Web-lite | Required reproducible development inputs; source/toolchain/native gates remain mandatory. Runtime feature policy, browser budgets and current controller/history/worker ownership remain unchanged. | Qualify a fresh Git worktree, archive refusal/idempotency tests, source/product/generated-asset checks, both typechecks and the existing build/test suites. Browser results qualify only their observed environment. |

Explorer, Quick Look, GNOME/KDE previews and thumbnail providers do not consume
this development archive or command. Their integration policy and qualification
are unaffected. There is no application UI, tutorial, agent/API or shipping CLI
surface, file-format change, browser permission, persistence change or background
work. The command is an explicit contributor setup step documented in README.

Keep all 919 source pins, capture manifests, product bindings, generated assets,
native inputs and native publication unchanged. Validate corrupt and incomplete
archives, unsafe paths, duplicate members and pre-existing conflicts using
temporary fixtures. Record the reproduced fresh-checkout failure, archive
identity and actual post-fix checks below before committing.

Validation completed on October 22, 2026:

- A fresh detached worktree of the import fails
  `python -B tools/capture-sources.py verify`; the missing published-logo source
  raises `FileNotFoundError`. Git inventory independently confirms 616 missing
  source-lock members. No source locks or sibling files were modified.
- `reference/frozen-sources.zip` contains 836 unique `sha256/<digest>` members
  representing all 1,339 paths in the Windows source lock and two retained
  capture manifests. Its size is 46,462,980 bytes and SHA-256 is
  `e98fe627693951e53a7b98a35b6ca173d7ed2534b5a425318833bc5937dc69ea`.
  Packaging used sorted digest names, DEFLATE level 9, a fixed 1980-01-01 ZIP
  timestamp and regular-file mode 0644. Every input was checked against its
  existing manifest before packaging; duplicate contents are stored once.
- `python -B tools/restore-references.py --root <fresh-worktree>` restores
  1,336 missing files and preserves the three tracked pivot files. A second
  invocation restores zero and verifies all 1,339 files. The existing prepared
  checkout likewise restores zero. The fresh worktree then passes
  `tools/capture-sources.py verify`, `tools/generate-assets.py --check`,
  `tools/generate-native-translations.py --check` and the product verifier.
  `tools/capture-target.py verify --destination
  reference/targets/windows-r0-20261012-02` independently verifies the complete
  720-file capture and its original completion status.
- `python -B -m unittest discover -s tools -p 'test_*.py'` runs 100 tests:
  99 pass and one existing real-symlink probe skips because Windows denies
  symlink creation (WinError 1314). The real Windows-junction probe passes.
  All nine new restoration tests pass. The first focused negative-fixture run
  exposed Python's Windows ZIP-name normalization; the corrected fixture
  preserves raw names, and restoration validates `orig_filename` explicitly.
- `npm test -- --maxWorkers=4`: all 6,383 tests in 198 files pass.
  `npm run test:web-build`: all 39 tests pass. Both TypeScript projects,
  `npm run build`, the 919-source integrity gate, the 128-registration product
  verifier and `tools/verify-toolchain.py verify-build` pass. The build retains
  its existing large-chunk warning. Application/native sources and generated
  assets have no diff, so the tested runtime identity is unchanged by this
  contributor-tooling correction.
- Production preview at `http://127.0.0.1:4173` passes all 16 cases across
  `e2e/desktop-example.spec.ts`, `e2e/tutorial-sample.spec.ts`,
  `e2e/tutorial-saved-view.spec.ts` and `e2e/web-lite.spec.ts`, with zero retries,
  skips or unexpected outcomes. This includes real remembered-view choices,
  sample supersession/cancellation, dirty-scene history and Basic cleanup.
  Observed environment: Windows x64, Chromium 156.0.8078.4, 1280x800 at DPR 1,
  secure localhost context with WebGPU. The separate high-performance adapter
  probe reports NVIDIA Blackwell, fallback false; it does not identify the
  renderer's owned adapter or establish capacity.

The observed build has application input identity
`7dac8f6dbffe9131b036806a82831ce5a811f0335a851ec8cc6c010aca8b2374`
and deployment identity
`45bb9b11d1ebd2dc08789494f6fe91192f4d256304193e06f5328c3bb14b5799`.
Local command logs and the browser JSON report are retained under
`.build/review-import-20261022/`. Native artifacts were verified in the prepared
workspace; a clean native rebuild, other browser/OS/GPU combinations and native
editor/preview/provider qualification were not performed. No deployment or
profile migration is part of this correction.
