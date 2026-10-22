These are independently generated Windows WIC reference bytes from the preserved
`../splatview-web-image-parity-draft-20261012/runs/wic-goldens-04` run. The original
manifest is preserved as `reference-manifest.json` (SHA-256
`4222129975e9274a370267119e51bb8a6a72b902b9cc4d2facdeef107d5c4e78`).

The 32 small input/output BGRA leaves are copied unchanged and checked against
that manifest. The multi-MiB maximum-size constant case is generated in the test
from its captured formula, `BGRA=(19,83,173,255)`, and its input/output hashes are
checked against the same manifest. Its binary arrays are intentionally omitted.
Pre-alpha outputs and COM traces remain in the preserved reference run; the
manifest retains their descriptions without duplicating those outputs here.

The independent portable filter matches all 17 final output fixtures through
the production implementation, including the full-size generated constant case.
Separate calibration matches 324 of 338 additional native measurements; 14
vertical-alpha cases remain different. These observations do not prove exact
Windows Fant behavior for arbitrary input. See
`docs/third-party/IMAGE_CAPTURE_REFERENCES.md` for the source/API boundaries.
