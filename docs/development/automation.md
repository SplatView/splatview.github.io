# Developer workflow and CI/CD

Development lives on `source`, the repository default branch. `main` contains
only the published static site; GitHub Pages serves `main:/`. Never push source
code to `main` or use a force push for deployment.

## Fresh checkout

Install Node **24.21.0** (also in `.node-version`), its npm, and Python **3.11+**.
Run these commands from the source checkout on Windows, macOS or Ubuntu:

```sh
npm run setup
npm run doctor
npm run dev
```

`setup` verifies prerequisites, restores the checked-in frozen-reference archive,
restores the five exact reviewed native publication files when missing, and runs
`npm ci`. It refuses conflicting files and never reads a live sibling project.
The first native restore downloads the released web ZIP pinned by size and
SHA-256 in [native-runtime.json](../../tools/native-runtime.json); subsequent
restores verify the ignored download cache. Historical evidence is not fetched.

Every runtime restore passes the existing source/dependency/toolchain/adapters/
build-script freshness verifier before publication. A complete valid local native
build is preserved. Stale or corrupt existing files are refused, with no automatic
overwrite. Review/remove only the conflicting generated files before retrying.

Runtime reuse is not native compilation. Native input changes require
`npm run build:core` using the Windows compiler/SDK/cache fingerprints in
[TOOLCHAIN_LOCK.json](../../native/TOOLCHAIN_LOCK.json). Do not relax that lock to
make hosted CI pass. After a separately qualified native release, review the
seed release, full archive digest, native input ID and all five file hashes as
one change. The bootstrap itself never updates these pins.

`doctor` is read-only: it checks Node, frozen-source closure, native freshness and
installed npm dependencies. It neither restores inputs nor writes test receipts.

## One validation path

| Command | Checks |
| --- | --- |
| `npm run check` | Repository layout, sealed product/source/generated/native contracts, app and benchmark types, Python tool tests, Node build/deployment tests, full portable suite. |
| `npm run ci` | Everything in `check`, production app build and standalone renderer build with its isolated TypeScript consumer. |
| `npm run test:ci` | Chromium appearance/update-notice journeys using the UI-only startup harness. Install the pinned browser first with `npx playwright install chromium`. |
| `npm run test:e2e` | Existing browser suites; select the relevant hardware/feature projects for the change. |

Portable tests default to at most four workers, reserving one CPU for the runner.
Existing timeouts and isolation remain in place. Explicit CLI worker overrides
are available for profiling; app worker/codec budgets are separate.

`setup`, `check` and `ci` stream output and retain numbered UTF-8 logs plus exit
codes in fresh `.build/validation/<task>-<time>-<random>/` directories. The first
failed step stops the command. They never edit old receipts. Run `doctor` for
setup failures; open the reported log directory for validation failures.

[Source CI](../../.github/workflows/ci.yml) runs on pushes and PRs to `source`,
and manually. Windows and Ubuntu run `setup` and `ci` unchanged. Ubuntu also runs
the bounded UI smoke profile. These appearance tests substitute initialization;
they do not qualify WebGPU/WebGL rendering, native workers, OS providers or new
hardware. Existing actual browser/GPU/native qualification remains required for
affected changes. macOS supports the source workflow but has no hosted lane here.

CI pins official Actions by commit, grants read-only repository access, and
caches npm downloads rather than generated outputs. Successful distributions and
all available failure logs/traces are retained for seven days. PR artifacts are
never inputs to deployment. Dependabot proposes grouped Actions updates against
`source`; npm/native/source locks retain their explicit review process.

## Promote an existing release

Release creation and native/GPU qualification remain separate from deployment.
The [promotion workflow](../../.github/workflows/deploy.yml) accepts an already
published stable version such as `v0.2.2`; dry run is the default. It runs only
from `source`. Locally, with authenticated `gh` and `git`:

```sh
npm run deploy:check -- --release v0.2.2
```

The tool verifies the repository and Pages configuration, published stable
release, GitHub asset digests and `SHA256SUMS.txt`, annotated source tag and source
ancestry, source/package version and qualification receipt. It independently
recomputes the app descriptor and complete emitted-byte manifest with the
maintained verifier and checks native freshness against the tagged source.
Tagged source is exported as data; its scripts are not executed. The five native
files and all distribution members are explicitly checked. Unowned files/maps,
links, path traversal, case aliases and oversized archives are refused.

An isolated static worktree stages the qualified bytes. Git-index blobs must
match them exactly; nine existing publisher/legal assets and prior hashed assets
are preserved. Version downgrades and changing an already published version's
deployment identity are refused, as is reusing a published `assets/` path with
different bytes. The candidate, file inventory, base/source
commits, deployment identity and staged diff remain in a fresh ignored
`.build/validation/deploy-*/` directory for inspection. A dry run does not commit,
push, request a Pages build or alter a GitHub release.

Select **publish** in the manual workflow only when ready to promote that
release. The write-enabled job repeats every validation itself, pushes the
isolated static candidate to `main` without force, explicitly requests the Pages
build, checks its commit/status and verifies public file bytes and JS/WASM MIME
types. The read-only dry-run job has no write token. The equivalent maintainer
CLI adds `--publish`; that flag is an explicit publication action.

Publication failure after a push leaves the candidate/report available for
diagnosis. Re-running the same immutable version is safe; do not rewrite a tag
or weaken checks to recover. A rollback requires its own reviewed procedure.

The October 28 implementation was exercised against existing v0.2.2 without
publishing a new app version. The platform and qualification boundaries are in
the [feature review](../../design/feature-reviews/dx-cicd-2026-10-28.md).
