# Benchmark acceptance contracts

The validator checks report consistency against separately pinned target and build
bytes. It does not collect measurements or attest the reported hardware. There
is no approved performance budget or collected benchmark packet in this change.
Synthetic unit fixtures exercise policy and are not performance evidence.

Version 1 remains the historical W09 Mac contract. Its `w09-initial` scope
requires the complete 64-cell minimum/newer Mac, Safari/Chrome,
256k/1M, SH0/SH3, low/high overdraw, standard/retina matrix. Local Chromium and
synthetic reports cannot qualify that contract. Existing v1 schemas and tooling
profiles retain their meaning.

Version 2 uses target scope `observed-browser-initial`, report purpose
`observed-browser-initial-baseline`, and `schemaVersion: 2` on both packets.
It supports a declared set of observed cells without requiring Mac hardware.
Each machine has tier `observed`. `observedHosts` pins one complete host record
for each machine/browser pair used by a cell: OS, model, RAM, browser family and
version, adapter name/features/limits, enabled features, power/cache policy,
isolation state, and `browserHost`. These fields must match every corresponding
report cell exactly; each framebuffer remains pinned by the cell's framebuffer
identity. Unused host, machine, browser, fixture, trace, or framebuffer entries
are rejected. Declared fixture workloads must be fully loaded.

For v2, `local-chromium` evidence retains `browserHost: "automation"` and Chrome
as its family. `observed-browser` retains `browserHost: "normal-launch"`.
`actual-mac` still requires macOS, and Safari requires macOS. The validator
refuses `synthetic-tooling` acceptance. These are checked declarations, not an
independent check of the browser launch or physical machine.

Both contracts require complete cell and scenario inventories, raw attempts,
minimum repeats, independent correctness identities, settlement and joined
retirement boundaries, exact raw summaries, approved latency thresholds, and
per-cell memory ceilings. Failed, refused, or cancelled attempts remain in the
report and disqualify it; a later retry cannot erase them. Missing required
measurements, skipped statuses, unavailable targeted observations, pending
owners, incomplete target coverage, and exceeded budgets cannot qualify.

An accepted v2 result has scope `observed-browser-initial-only` and an
`observedScope` containing only its exact cell IDs and pinned host records.
`capacityQualified` and `sustainedQualified` remain false. This does not qualify
other browsers, machines, framebuffers, workloads, generic file capacity, or
sustained performance. An unaccepted result has no `observedScope` receipt.

The validation CLI is unchanged and selects the contract from the checked JSON
shapes. The target and report must use the same version:

```text
node tools/bench/cli.ts --report REPORT --target TARGET --build BUILD --output NEW_RECEIPT
```

Exit 0 means consistency acceptance within the packet's declared scope; exit 2
preserves a valid diagnostic that did not qualify; exit 1 means invalid data.
Output writes are exclusive. The receipt retains hashes of the supplied report,
target, and expected build.

JSON schemas are exported from the same structural shapes used at runtime:

```text
node tools/bench/export-schemas.ts --output-dir NEW_DIRECTORY
node tools/bench/export-schemas.ts --check
```

The first command requires a fresh directory whose parent exists, writes all
four v1/v2 schema files exclusively, and never overwrites existing evidence.
The second compares the four checked-in schemas without writing. Running the
exporter without arguments retains exclusive writes to the default schema
directory; it refuses existing files. Cross-field acceptance rules remain in
`validate.ts`, in addition to these structural schemas.

Measurement collection and runner instrumentation are separate work. A release
packet still needs real raw observations, independently generated fixture and
oracle identities, and explicitly approved thresholds and memory ceilings for
every declared cell. A synthetic packet or a pending target cannot supply those
deliverables.

## Deterministic first workload

`tests/fixtures/bench/manifest-v1.json` describes the original
`dyadic-grid-256k-sh0-v1` workload: 256,000 complete SH0 records, 8,192,000 input
bytes, unique dyadic positions, three isolated anchors, opaque primary colors
and unequal power-of-two scales. The checked-in manifest pins construction
identities; the binary scene and trace are generated into a fresh private
directory and are never published through `public` or `dist`.

```text
node tools/bench/build-fixtures.ts --output-dir .build/bench-fixtures/NEW_RUN_ID
```

Construction uses an independently declared orbit procedure: five seconds of
warmup, thirty seconds of replay and a subsequent one-second hidden interval.
The manifest fixes camera and framebuffer inputs. These describe intended
actions; they are not observations that a browser replay or hidden transition
occurred. A low-footprint workload declaration does not measure projected
overdraw. Contributor, query and amendment cases remain pending until their
production parameters and independent mask oracles are pinned.

`--prepare` writes a candidate manifest for an intentional new fixture revision.
It does not approve or silently replace the checked-in manifest. Verify the
candidate with the independent oracle and actual native import/export before
pinning it. Existing output directories and unsafe paths are refused.

`oracles.ts` imports no generator, production decoder or native math helper.
It checks the full raw payload, the native **144-byte canonical record** layout
(distinct from the 48-byte SH0 GPU stream), and every independently decoded
SPLAT export record. Membership and source order remain explicit. Canonical
identities normalize signed zero; covariance, color and opacity checks preserve
the existing `ply-splat-numeric-v1` numeric policy. Export evidence retains its
actual encoded and decoded identities plus maximum errors, without treating a
tolerated covariance reparameterization as byte-identical output.
The workload also requires its three distinct linear scales and exact primary
RGBA bytes, so the general covariance tolerance cannot hide a lost small axis.

The format reference is [PlayCanvas splat-transform 3.9.0](https://github.com/playcanvas/splat-transform/tree/435b972a97a278c655d8f7015b1355215cba0d71),
under MIT, as recorded in the frozen native third-party notices. The benchmark
scene, recipe and oracle are independently authored; they contain no borrowed
fixture bytes. Native correctness tests do not establish browser latency,
retention, supported input capacity or an approved performance budget.

## Initial production observations

Build and serve the ordinary production application, then run the first
open/export/close probe against that exact deployment:

```text
npm run bench:run -- --base-url http://127.0.0.1:4173/ --fixture .build/bench-fixtures/PINNED_RUN/fixture.splat --out .build/bench-runs/NEW_RUN
```

The optional `--manifest` and `--build` flags default to the checked-in fixture
manifest and `dist/build-manifest.json`; `--attempts` defaults to three and is
bounded to 1–30. The served manifest must match the supplied local build bytes.
Outputs are exclusive, private and include every unsuccessful attempt.

The collector uses the actual production UI file picker and save dialog. It
persists each complete browser SPLAT download and checks it through the independent oracle,
then clicks the real "I have kept the file" confirmation before closing.
An unsuccessful save, oracle comparison or acknowledgement cannot mark a run successful. It
records actual public open/close promise boundaries and scheduled display-frame
queue completion, then joins each browser context and the browser. The
versioned observation bridge is enabled only by the literal query pair
`__splatview_benchmark=1`; ordinary URLs expose no bridge. Readonly snapshots
include the verified runtime identity, actual renderer negotiation, bounded
frame/operation histories, logical ledger categories and explicitly scoped
pending-owner observations. GPU timestamps, presentation and physical memory
remain unavailable unless separately observed.

This first collector emits a raw `splatview-production-open-export-close-probe`
observation, **not** a completed v2 benchmark report. Its fresh browser contexts
do not establish cold GPU-driver caches. Snapshot polling and automation are
present. The 214-attempt protocol, actual orbit/hidden transitions and overdraw,
independent contributor/query/amendment masks, detailed pipeline timings and
sustained retention/history remain work. Targets and memory ceilings stay
pending; a successful probe cannot approve a performance or capacity budget.

## Continuous orbit and native visibility

The orbit collector reuses the real open/export/close lifecycle and replays the
pinned trace against the opt-in production camera bridge:

```text
node tools/bench/orbit.ts --base-url http://127.0.0.1:4173/ --fixture .build/bench-fixtures/PINNED_RUN/fixture.splat --trace .build/bench-fixtures/PINNED_RUN/orbit-trace.json --out .build/bench-runs/orbit-NEW_RUN --attempts 3
```

Use a lowercase run ID of at most 80 characters. The private host directories
are exclusive. Each attempt uses a fresh, owned full Chromium process and its
existing default context through local CDP with `noDefaults: true`. This avoids
automation focus emulation masking real tab visibility. Native download events
and completed browser files remain separate from application export timing.
The process, connection, command, logs and terminal outcome remain recorded.
Keep the host receipts and raw scene exports; browser profiles and duplicate
download caches can be removed only after all owners and runners have joined.

The camera updates on every actual browser animation frame during the pinned
five-second warmup and thirty-second orbit. Input does not wait for a GPU fence
after each update. Setup and terminal poses join an actual completed queue
frame. The observer separately retains browser animation-frame timestamps,
camera acknowledgments, native view/projection matrices, scheduled display
submissions, queue settlement and bounded long-task observations. A camera can
advance while an earlier display submission is in flight; those actual stale
camera observations stay in the raw history. They do not become fabricated
current-camera completions. Observation-ring drops, browser intervals and
unavailable presentation/drop counters retain distinct meanings.

The hidden interval switches to a real other tab, requires `document.hidden`
and `visibilityState === 'hidden'` for at least the pinned second, checks the
application's submission counters, and restores the original tab. A dispatched
visibility event or a frozen lifecycle cannot supply that observation. The
collector retains failed or partial phases and refuses a host that does not
produce the required actual state. These raw observations do not approve a
latency, physical-memory or supported-capacity budget.

The historical trace calls camera field 6 `speed`. The frozen native camera ABI
uses that unchanged numeric value as the scene radius. The collector records
the actual native interpretation and projection; it preserves the original
trace bytes and identity rather than silently relabeling pinned input.

## Independent selection expectations

`selection-oracles.ts` constructs complete one-byte source-state masks for the
fixed workload, with explicit original baselines, all four Combine modes,
geometric anchor/box queries and ordinary Color amendments. Parameter, state
and source-membership identities are separate. The subset-export oracle checks
every independently decoded row, source ID, order and attribute. Expected
values import no production selector, camera math or fixture generator.

Native comparisons establish only their exact native cases. The isolated
anchor pick candidates include independent covariance and footprint-separation
calculations, with actual GPU contributor comparison still required. They do
not establish cache reuse, projected overdraw, browser timing or the complete
214-attempt matrix. The original fixture manifest remains unchanged; additive
selection qualification must bind the predeclared oracle and actual native
evidence before its cases can be used for timing.

## Production Single contributor observations

The Single collector drives the ordinary production UI and observes the same
GPU pick invocation used by that click:

```text
node tools/bench/contributors.ts --base-url http://127.0.0.1:4173/ --fixture .build/bench-fixtures/PINNED_RUN/fixture.splat --out .build/bench-runs/contributors-NEW_RUN --attempts 3
```

Its independent contracts declare the three separated anchor pixels, all four
Combine modes against explicit baselines, and a deleted-anchor negative case.
Each real click is checked for an unobstructed canvas hit and the fixed camera,
framebuffer and production render inputs. Observation records contain the
actual decoded `GpuPick` result; the renderer's original 16 readback bytes are
not exposed. Exact contributor IDs are checked independently. The analytic
projection values do not approve a float error bound for the GPU shader.

The opt-in `readMasks()` bridge reads source-ordered native state bytes through
the existing worker channel. The collector preserves each complete byte mask
before checking its independently declared membership, deleted bits and
Undo/Redo baselines. It restores the original scene before the shared full
SPLAT export and joined Close proof. Failed cases and partial attempts remain
in the private output; a later passing run does not erase them.

These observations cover isolated contributors and Single selection. They do
not qualify overlapping contributors, Color/Connected Color/Fill, surface-map
cache reuse, overdraw, latency budgets, supported capacity, sustained retention
or the complete 214-attempt matrix. Ordinary URLs keep instrumentation disabled.
Keep generated masks, browser output and fixtures outside `public` and `dist`;
retire regenerable caches only after their browser and service owners join.

## Same-page lifecycle retention observations

The retention collector keeps one browser, context, page, installed observation
bridge, controller and browser clock for the entire twenty-cycle sequence:

```text
node tools/bench/retention.ts --base-url http://127.0.0.1:4173/ --fixture .build/bench-fixtures/PINNED_RUN/fixture.splat --out .build/bench-runs/retention-NEW_RUN
```

`--manifest` and `--build` retain the initial probe defaults. `--cycles` defaults
to 20 and accepts 1 through 20; fewer cycles are explicitly a tooling diagnostic
with `twentyCycleSequenceObserved: false`, not W28 completion. `--attempts` is
refused because fresh contexts would conceal retention across cycles. The
served build manifest must match the supplied local shipping bytes. The
private output directory, predeclared sequence, each cycle record, checkpoint
mask, SPLAT export and JPEG download are written exclusively. Failed and
partial cycles remain recorded, incomplete runs exit nonzero, and both browser
context and browser cleanup must join before a run can be observed.

Each cycle opens the pinned 256k SH0 input through the real file picker, sets
the independently declared camera with the existing opt-in setup bridge, then
uses ordinary Single/Replace to select isolated source 1. Complete native
source-state masks prove the original, selected, deleted, Undo and Redo states;
history capability flags are checked alongside membership. The edited All
SPLAT download must contain exactly 255,999 independently decoded records,
with original source order and attributes and source 1 absent. Its actual
saved bytes must pass that oracle before the real “I have kept the file”
acknowledgement is clicked. Capture image must produce a complete real JPEG
download that independently decodes to 1280 by 800. The original file then
replaces the edited document, and ordinary Settings → Close scene must join a
settled native close with no logical allocations, native accounts or named
document owners remaining. A retained bridge object and monotonic operation,
frame and browser clock observations forbid page/controller replacement.

Each barrier retains the full snapshot, logical memory categories, currently
addressable native accounts and named pending owners. Sampled barrier maxima
and the controller's cumulative ledger high-water mark are reported separately;
neither measures physical JavaScript, process or GPU memory. Downloads can
retain their ordinary callbacks until replacement/Close joins them. JPEG
decode proves a real complete image file and dimensions, without approving
pixel fidelity or physical presentation. A concise progress record is emitted
after each terminal cycle; detailed evidence stays in the private files.

The current [attribute-export qualification](../../docs/validation/README.md#generic-export-20261016-01)
closes the bounded native-workspace and retained output/Blob ownership path for
SPLAT and the other attribute writers. The [SPZ v3](../../docs/validation/README.md#spz3-export-20261016-01),
[SOG/SOGS](../../docs/validation/README.md#sog-export-20261016-01) and
[SPZ v4](../../docs/validation/README.md#spz4-20261014-01)
receipts record the other codec-owned paths. Their admission and cancellation
limits retain each receipt's scope; they do not establish physical-memory ceilings.
This lifecycle collector keeps `closedExportAccounting` false because its
observations alone do not audit those codec grants or alter historical reports.
A zero ledger at joined Close proves neither physical memory nor capacity.
Even a complete twenty-cycle observation leaves `performanceAccepted`,
`capacityQualified`, `sustainedQualified`, `fullMatrixAccepted` and
`fullReleaseAccepted` false. Automation, mask reads and independent download
decoding also introduce work outside application measurements. Operating
budgets and the complete v2 benchmark matrix require separate evidence.
