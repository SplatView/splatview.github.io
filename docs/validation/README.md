# Validation and historical evidence

Current source keeps active schemas/templates, the archive catalog and required
fixtures/contracts. Raw historical reports are preserved byte for byte in the
[historical evidence archive](https://github.com/SplatView/splatview.github.io/releases/download/v0.2.1/historical-evidence-v0.2.1.zip).

The catalog pins every original path, size and SHA-256, plus the archive digest
and source revision. This preserves old receipts, failures, screenshots and
provenance without rewriting their captured paths or qualification claims.
The archive is attached to v0.2.1; that tag also retains the original loose tree.
Existing release assets and checksums are unchanged. Git history is retained.

Some historical plans also name local reports that were never committed. Those
names remain as text; the archive catalog covers files present at the pinned
source revision.

## Inspect or restore

```sh
npm run verify:project
python -B tools/evidence.py list
python -B tools/evidence.py fetch
python -B tools/evidence.py verify
python -B tools/evidence.py show docs/validation/runs/scene-load-mode-20261025-01/validation.json
python -B tools/evidence.py extract --run scene-load-mode-20261025-01
```

Fetching is explicit and optional; application builds do not download or depend
on historical evidence. The cache is `.build/validation/archive/`. Default
extraction restores the original relative tree under `.build/validation/restored/`.
Pass `--destination` to choose another directory inside the workspace. Extraction
refuses unsafe paths, corrupt bytes and conflicting files. It does not overwrite
differing content. Use `--destination .` only when deliberately materializing
original locations for an existing strict evidence reader; those restored paths
are ignored by Git. Keep old path/hash fields and reader checks intact.

This is preserved historical evidence, not fresh browser or native qualification.
See [the project map](../development/project-structure.md) for new run output.

## Archive inventory

Source revision: `8a6b069aa10889b6a436d84ab8bdebed8845baab`.

1,089 files; 286,745,481 original bytes; 122,059,353 archive bytes.

Archive SHA-256: `ee37c1e7a37ac583ce8afe0a5c89f4584bc847c9459c27378267e48f39794f94`.

The [catalog](archive/index.json) records every original file. To restore one
group, use `python -B tools/evidence.py extract --run GROUP` from the project root.

| Group | Files | Original bytes |
| --- | ---: | ---: |
| <a id="accessibility-20261015-01"></a>`accessibility-20261015-01` | 1 | 34,586 |
| <a id="align-20261013-01"></a>`align-20261013-01` | 5 | 5,359,537 |
| <a id="alignment-20261013-01"></a>`alignment-20261013-01` | 8 | 1,822,783 |
| <a id="app-responsiveness-20261025-01"></a>`app-responsiveness-20261025-01` | 41 | 2,309,565 |
| <a id="auto-color-20261013-01"></a>`auto-color-20261013-01` | 4 | 1,706,505 |
| <a id="benchmark-fixture-20261015-01"></a>`benchmark-fixture-20261015-01` | 1 | 24,608 |
| <a id="build-assets-20261014-01"></a>`build-assets-20261014-01` | 1 | 250,851 |
| <a id="capture-opacity-20261016-01"></a>`capture-opacity-20261016-01` | 1 | 26,985 |
| <a id="census-20261012-01"></a>`census-20261012-01` | 1 | 156,899 |
| <a id="cleanup-20261012-01"></a>`cleanup-20261012-01` | 1 | 155,415 |
| <a id="collection-20261014-01"></a>`collection-20261014-01` | 2 | 1,027,549 |
| <a id="color-fill-range-web-20261016-01"></a>`color-fill-range-web-20261016-01` | 1 | 41,965 |
| <a id="compat-fixture-20261014-01"></a>`compat-fixture-20261014-01` | 1 | 213,874 |
| <a id="compressed-ply-20261016-01"></a>`compressed-ply-20261016-01` | 1 | 47,677 |
| <a id="current-desktop-chevron-web-20261017-01"></a>`current-desktop-chevron-web-20261017-01` | 1 | 42,477 |
| <a id="current-desktop-chrome-20261016-02"></a>`current-desktop-chrome-20261016-02` | 1 | 1,678,904 |
| <a id="current-tutorial-v7-web-20261017-01"></a>`current-tutorial-v7-web-20261017-01` | 1 | 85,607 |
| <a id="dataset-license-correction-20261019-01"></a>`dataset-license-correction-20261019-01` | 1 | 129,764 |
| <a id="deferred-input-20261015-01"></a>`deferred-input-20261015-01` | 1 | 243,808 |
| <a id="delivery-readiness-20261016-01"></a>`delivery-readiness-20261016-01` | 1 | 32,195 |
| <a id="desktop-density-20261015-01"></a>`desktop-density-20261015-01` | 1 | 100,754 |
| <a id="desktop-pro-20261015-01"></a>`desktop-pro-20261015-01` | 1 | 158,801 |
| <a id="desktop-recovery-20261015-01"></a>`desktop-recovery-20261015-01` | 1 | 345,408 |
| <a id="desktop-visual-20261015-01"></a>`desktop-visual-20261015-01` | 2 | 43,513 |
| <a id="evidence-adapters-20261015-02"></a>`evidence-adapters-20261015-02` | 7 | 7,421,442 |
| <a id="filter-20261014-01"></a>`filter-20261014-01` | 2 | 4,437,266 |
| <a id="filter-gizmo-20261014-01"></a>`filter-gizmo-20261014-01` | 2 | 3,071,798 |
| <a id="floating-selection-actions-web-20261017-01"></a>`floating-selection-actions-web-20261017-01` | 1 | 102,459 |
| <a id="floor-20261013-01"></a>`floor-20261013-01` | 4 | 386,884 |
| <a id="generic-export-20261016-01"></a>`generic-export-20261016-01` | 4 | 140,150 |
| <a id="github-pages-publication-20261018-01"></a>`github-pages-publication-20261018-01` | 1 | 42,121 |
| <a id="gizmo-session-actions-web-20261017-01"></a>`gizmo-session-actions-web-20261017-01` | 1 | 796,506 |
| <a id="grade-input-20261015-01"></a>`grade-input-20261015-01` | 1 | 2,117,975 |
| <a id="guides-20261015-01"></a>`guides-20261015-01` | 1 | 6,179,426 |
| <a id="histogram-20261012-01"></a>`histogram-20261012-01` | 3 | 273,007 |
| <a id="hygiene-20261015-01"></a>`hygiene-20261015-01` | 1 | 36,852 |
| <a id="image-capture-20261015-01"></a>`image-capture-20261015-01` | 1 | 93,265 |
| <a id="input-20261015-01"></a>`input-20261015-01` | 1 | 20,289,608 |
| <a id="interactions-20261015-01"></a>`interactions-20261015-01` | 1 | 204,051 |
| <a id="json-cleanup-20261012-01"></a>`json-cleanup-20261012-01` | 1 | 174,454 |
| <a id="ksplat-input-20261016-01"></a>`ksplat-input-20261016-01` | 1 | 31,100 |
| <a id="language-20261015-01"></a>`language-20261015-01` | 1 | 8,843,212 |
| <a id="legacy-root"></a>`legacy-root` | 149 | 12,065,326 |
| <a id="legacy-summaries"></a>`legacy-summaries` | 19 | 863,291 |
| <a id="lifecycle-20261015-01"></a>`lifecycle-20261015-01` | 1 | 184,404 |
| <a id="limited-input-20261012-01"></a>`limited-input-20261012-01` | 1 | 184,502 |
| <a id="manual-feedback-20261015-01"></a>`manual-feedback-20261015-01` | 1 | 1,964,540 |
| <a id="morphology-20261012-01"></a>`morphology-20261012-01` | 4 | 417,740 |
| <a id="morphology-icons-20261012-01"></a>`morphology-icons-20261012-01` | 3 | 789,771 |
| <a id="native-census-20261012-01"></a>`native-census-20261012-01` | 1 | 9,019 |
| <a id="native-cleanup-20261012-01"></a>`native-cleanup-20261012-01` | 1 | 13,661 |
| <a id="native-json-cleanup-20261012-01"></a>`native-json-cleanup-20261012-01` | 1 | 15,137 |
| <a id="native-response-20261012-02"></a>`native-response-20261012-02` | 1 | 7,622 |
| <a id="offline-20261015-01"></a>`offline-20261015-01` | 1 | 293,240 |
| <a id="opacity-20261015-01"></a>`opacity-20261015-01` | 2 | 3,591,724 |
| <a id="orbit-observation-20261015-01"></a>`orbit-observation-20261015-01` | 1 | 90,329 |
| <a id="pivot-controls-web-20261016-01"></a>`pivot-controls-web-20261016-01` | 1 | 46,161 |
| <a id="playcanvas-input-policy-20261018-01"></a>`playcanvas-input-policy-20261018-01` | 1 | 41,699 |
| <a id="pro-duplicate-core-20261016-01"></a>`pro-duplicate-core-20261016-01` | 1 | 16,010 |
| <a id="pro-duplicate-web-20261016-01"></a>`pro-duplicate-web-20261016-01` | 1 | 28,301 |
| <a id="pro-morphology-20261016-01"></a>`pro-morphology-20261016-01` | 2 | 79,432 |
| <a id="production-observation-20261015-01"></a>`production-observation-20261015-01` | 1 | 50,233 |
| <a id="r0-20261012-01"></a>`r0-20261012-01` | 42 | 1,735,125 |
| <a id="reconciliation-20261015-01"></a>`reconciliation-20261015-01` | 2 | 428,268 |
| <a id="recovery-20261015-01"></a>`recovery-20261015-01` | 2 | 2,067,177 |
| <a id="release-evidence-20261015-02"></a>`release-evidence-20261015-02` | 6 | 675,901 |
| <a id="renderer-comparison-20261025-01"></a>`renderer-comparison-20261025-01` | 297 | 37,522,259 |
| <a id="rendering-optimization-20261025-01"></a>`rendering-optimization-20261025-01` | 7 | 35,789,568 |
| <a id="rendering-throughput-20261025-01"></a>`rendering-throughput-20261025-01` | 133 | 44,868,689 |
| <a id="response-ui-20261012-01"></a>`response-ui-20261012-01` | 1 | 172,089 |
| <a id="scale-20261013-01"></a>`scale-20261013-01` | 4 | 2,363,691 |
| <a id="scene-load-mode-20261025-01"></a>`scene-load-mode-20261025-01` | 45 | 1,273,600 |
| <a id="selection-actions-20261014-01"></a>`selection-actions-20261014-01` | 1 | 33,260 |
| <a id="selection-dx-review-20261018-01"></a>`selection-dx-review-20261018-01` | 1 | 39,032 |
| <a id="selection-history-web-20261017-01"></a>`selection-history-web-20261017-01` | 1 | 192,143 |
| <a id="selection-interaction-optimization-20261018-01"></a>`selection-interaction-optimization-20261018-01` | 1 | 60,370 |
| <a id="selection-modularity-20261018-01"></a>`selection-modularity-20261018-01` | 1 | 44,418 |
| <a id="selection-observation-20261015-01"></a>`selection-observation-20261015-01` | 1 | 83,749 |
| <a id="selection-pivot-web-20261016-01"></a>`selection-pivot-web-20261016-01` | 1 | 3,299,482 |
| <a id="selection-surface-optimization-20261018-01"></a>`selection-surface-optimization-20261018-01` | 1 | 63,680 |
| <a id="settings-panel-20261012-01"></a>`settings-panel-20261012-01` | 2 | 259,984 |
| <a id="sog-export-20261016-01"></a>`sog-export-20261016-01` | 2 | 65,001 |
| <a id="sog-group-20261013-01"></a>`sog-group-20261013-01` | 2 | 1,223,951 |
| <a id="sog-sh-20261014-01"></a>`sog-sh-20261014-01` | 2 | 924,307 |
| <a id="sog-v2-20261013-01"></a>`sog-v2-20261013-01` | 2 | 803,650 |
| <a id="spz3-export-20261016-01"></a>`spz3-export-20261016-01` | 2 | 59,567 |
| <a id="spz4-20261014-01"></a>`spz4-20261014-01` | 3 | 10,618,257 |
| <a id="standalone-renderer-20261025-01"></a>`standalone-renderer-20261025-01` | 22 | 860,055 |
| <a id="steady-splats-20261025-01"></a>`steady-splats-20261025-01` | 1 | 20,274 |
| <a id="theme-20261015-01"></a>`theme-20261015-01` | 1 | 4,978,212 |
| <a id="transform-20261014-01"></a>`transform-20261014-01` | 2 | 5,500,042 |
| <a id="tutorial-20261015-01"></a>`tutorial-20261015-01` | 1 | 13,603,426 |
| <a id="tutorial-continuity-20261019-01"></a>`tutorial-continuity-20261019-01` | 1 | 316,655 |
| <a id="tutorial-course-20261018-01"></a>`tutorial-course-20261018-01` | 1 | 67,441 |
| <a id="tutorial-desktop-sample-20261019-01"></a>`tutorial-desktop-sample-20261019-01` | 1 | 385,851 |
| <a id="tutorial-order-20261019-01"></a>`tutorial-order-20261019-01` | 1 | 62,335 |
| <a id="tutorial-sample-20261018-01"></a>`tutorial-sample-20261018-01` | 1 | 52,985 |
| <a id="tutorial-spatial-20261019-01"></a>`tutorial-spatial-20261019-01` | 1 | 108,022 |
| <a id="tutorial-text-refinement-20261019-01"></a>`tutorial-text-refinement-20261019-01` | 1 | 496,115 |
| <a id="ui-ledger-alignment-20261018-01"></a>`ui-ledger-alignment-20261018-01` | 1 | 29,203 |
| <a id="view-scope-20261016-01"></a>`view-scope-20261016-01` | 2 | 99,295 |
| <a id="viewer-shell-20261012-01"></a>`viewer-shell-20261012-01` | 3 | 318,436 |
| <a id="web-lite-selection-policy-20261018-01"></a>`web-lite-selection-policy-20261018-01` | 1 | 32,326 |
| <a id="web-toolbar-simplification-20261018-01"></a>`web-toolbar-simplification-20261018-01` | 1 | 41,874 |
| <a id="webgl-sort-20261025-01"></a>`webgl-sort-20261025-01` | 166 | 16,354,364 |
| <a id="webgl2-implementation-20261025-01"></a>`webgl2-implementation-20261025-01` | 2 | 148,586 |
| <a id="webgl2-implementation-20261025-02"></a>`webgl2-implementation-20261025-02` | 3 | 2,734,933 |
| <a id="windows-design-alignment-20261018-01"></a>`windows-design-alignment-20261018-01` | 1 | 67,145 |
| <a id="worker-capacity-20261015-01"></a>`worker-capacity-20261015-01` | 1 | 63,864 |
| <a id="worker-pressure-20261015-01"></a>`worker-pressure-20261015-01` | 1 | 26,989 |
| <a id="worker-recovery-20261015-01"></a>`worker-recovery-20261015-01` | 2 | 2,126,290 |
| <a id="worker-retry-20261015-01"></a>`worker-retry-20261015-01` | 1 | 2,117,707 |
| <a id="worker-tools-20261015-01"></a>`worker-tools-20261015-01` | 1 | 32,090 |

## Pinned fixture provenance

Two small historical witnesses remain at their original source paths because
unchanged native compatibility and font fixtures pin their paths and hashes:

- `docs/validation/runs/sog-group-20261013-01/validation.json`
- `docs/validation/runs/desktop-visual-20261015-01/native-font-reference.json`

The layout check requires their exact archived bytes. They are also preserved
in the archive; the fixture pins and strict readers are unchanged.
