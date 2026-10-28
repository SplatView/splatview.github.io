# Port documentation

The maintained browser-port references live here:

- [Plan and platform scope](plan.md)
- [Implementation status and qualification](status.md)
- [Implementation details and contracts](implementation.md)

Start development with the [project map](../development/project-structure.md)
and [workflow guide](../development/automation.md). Read the latest delivery
amendments before interpreting older planning sections. Moving these documents
does not establish new feature, profile, browser, GPU or native qualification.

The two source-review baselines are preserved byte for byte. Embedded paths and
versions describe their originally captured workspace; they are historical
metadata, not current file resolution or test results.

| Original root path | Preserved location |
| --- | --- |
| `REVIEW_BASELINE.json` | [review-baseline.json](review-baseline.json) |
| `REVIEW_UPDATE_BASELINE.json` | [review-update-baseline.json](review-update-baseline.json) |

The cleanup's [review](../../design/feature-reviews/root-layout-2026-10-28.md)
records the relocation and validation. Older feature reviews, receipt bytes,
source/toolchain locks and the [historical archive](../validation/README.md)
retain their original identities.
