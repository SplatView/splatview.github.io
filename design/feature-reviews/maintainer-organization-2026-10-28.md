# Feature review: maintainer tests and project introduction

Reviewed October 28, 2026 before implementation, at source
`aa8d5550a72d508a8d18bd7c7ee0444117a097de`. The user asks to continue project
cleanup after reducing the root to 12 files. Read AGENTS, the shared product
contract/template, README, current port/status documents, capability inventory
and approved differences. Use sealed product bundle 2.0.0, SHA-256
`fff64dad4589c07b26821cb23a866aaec6f824e7786d719ca6e3122b3750895a`.

## Intent and boundaries

`tools/` mixes 11 regression files with its maintainer commands. Group the
Python and Node regressions in `tools/tests/`. Retain the npm command names and
standard unittest/Node runners; use unittest's existing explicit start/top-level
directories and an ordinary test package. Keep the same test bodies, cases,
refusal assertions, timeouts and source/native publication boundaries. Update
only moved tests' imports/resource paths and the two npm test commands. Do not
introduce an adapter, forwarding test files or a custom discovery framework.

The README is 298 lines and mixes current setup with historical validation and
optimization paragraphs. Rewrite it as a concise introduction covering current
viewing/light-editing scope, rendering defaults/fallback, formats, editing/output,
resource admission, setup/check/build commands, standalone embedding, static
hosting and attribution. Point historical claims to existing port documents,
feature reviews and archive catalog; their original records remain untouched.
Keep the example's complete dataset attribution/license/change notice reachable.
Add one tools map explaining command ownership and test locations; avoid another
copy of the development/CI guide or native build instructions.

Root entry files remain 12. Keep native/source/toolchain locks and the five
native identity input scripts byte-identical. No runtime/UI, product action/
API/CLI registration, format/default/input/persistence/tutorial, profile, worker/
codec budget, scene/history/controller or GPU lifecycle change is involved.
The npm script bytes change the app input identity normally; regenerate it with
the ordinary build rather than modifying a receipt or stale artifact.

## Platform and host policy

| Target | Policy / reason | Implementation and evidence |
| --- | --- | --- |
| Windows | Required equivalent setup, tool tests and builds. | Compare all Python cases after relocation; run the shared local and hosted CI commands. Native toolchain qualification remains separate. |
| macOS | Required portable maintainer paths, conditional on the documented Node/Python prerequisites. | Keep normal path/import/discovery conventions. No new Apple hardware/provider qualification is claimed. |
| Ubuntu | Required equivalent tool tests and source/build gates. | Run hosted CI, including the existing UI-only smoke lane. |
| Web-lite / standalone browser renderer | Required preservation of shipped behavior and host boundaries. | Existing app/SDK builds, source/product/native checks and scoped browser evidence remain applicable; no renderer algorithm is changed. |

Explorer, Quick Look, GNOME/KDE preview and thumbnail hosts are unaffected.
These are maintainer surfaces with no new user UI, tutorial or agent-server
entry. Portable test success is not a new native/GPU/platform qualification.

## Validation and handoff

Capture the original Python case inventory and compare it with the relocated
suite, accounting explicitly for its standard `tests.` package prefix. Preserve
all 133 Python and 42 Node cases and their assertions. Run both npm test commands,
the shared CI path, product/source/native/layout gates, both typechecks and app/
standalone builds. Check README/tool-map links and retained product/admission/
attribution facts. Verify pinned native/reference/contract/baseline/history bytes
and the 12 root entry files. Observe hosted Windows/Ubuntu CI and confirm that
the source branch is pushed while static Pages and published release assets are
unchanged. Keep fresh evidence in
`.build/validation/maintainer-organization-20261028-01/`. Do not rewrite old
receipts or present their cases as newly run at this source.

The first full local run passed all moved Python/Node tests, then an existing
file-heavy genuine-fixture case exceeded its five-second limit under the default
Vitest pool on a 32-logical-CPU host. Bound default file concurrency to
`min(4, max(1, availableParallelism() - 1))` in the existing Vite/Vitest configuration and
rerun the full suite. Preserve isolation, all cases/assertions and per-case
timeouts. This is test-runner scheduling, not an app worker/codec budget or
renderer change. Retain the failed diagnostic and allow ordinary CLI worker
overrides for explicit profiling. Record the final source-specific CI result.

The initial four-worker cap passed locally but used all four CPUs on hosted CI;
its timed-out benchmark/memory and sort-oracle cases remain diagnostic. The
final expression retains Vitest's existing one-CPU runner reserve, verified in
the locked installed Vitest source, while bounding high-core machines. No case
is skipped, retried, removed or given a longer deadline to obtain a passing run.
