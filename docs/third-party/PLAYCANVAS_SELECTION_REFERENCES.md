# PlayCanvas selection references

Reviewed 2026-10-18 against official SuperSplat **3.5.2**, commit
[`f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`](https://github.com/playcanvas/supersplat/commit/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b)
(2026-10-05). These are conceptual references for SplatView's original selection
surface optimization. No SuperSplat implementation code or shaders were copied
into the product for this change.

The workspace-only [source capture manifest](../../.build/playcanvas-selection-reference-20261018-01/reference.json)
records the immutable raw URLs, byte lengths and SHA-256 digests of 14 reviewed
files. Its SHA-256 is
`b7ea93056b4d5940044bb93cdba7f7aae40eddd11d2ec5107d65c677667a1ead`.
This capture is research evidence, not a build dependency. The public links below
remain usable without that ignored workspace directory.

## Bounded GPU work and readback

SuperSplat renders an ID target and reads the requested rectangle rather than
unconditionally reading its whole viewport. For scattered depth samples,
`readDepths` groups points into 64 by 64 pixel tiles and reads only the bounding
rectangle of the samples in each occupied tile. These tiles bound readback
regions; they are not SplatView's candidate-list tiles or a per-tile Gaussian
capacity. See [ID and depth readback](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/picker.ts#L143-L303).

Its sphere brush batches sample points. The camera renders a depth pass per
splat for that batch, uses one captured camera frame, and reconstructs positions
from those depths. This avoids a separate render for every brush sample.
See [batched depth intersections](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/camera.ts#L827-L934).

Through-mode region intersection runs on the GPU and returns a byte mask per
Gaussian, packed four bytes per word. The brush path buffer grows when needed;
the output allocation is reused when its size still matches. Footprint
intersection tests projected ellipses against per-row selection intervals.
See [intersection compute and allocation](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/intersect.ts#L253-L395)
and [footprint intersection](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/shaders/footprint-intersect-shader.ts).

CPU mask buffers are pooled by byte length. A queued operation keeps a query and
its history publication together, releasing its buffer after the selection
operation consumes it. See [buffer pool](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/buffer-pool.ts),
[query publication](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/editor.ts#L400-L416)
and [command queue](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/command-queue.ts).

## Semantic and cache differences

SuperSplat routes depth-enabled screen selection through a frontmost ID pass,
with selection-operation filtering that permits peeling. Its through-selection
paths instead test centers or projected footprints. These are distinct from
SplatView's composited depth, opacity and contributing-source visibility.
See [selection routing](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/editor.ts#L418-L432)
and [ID filtering and render state](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/picker.ts#L92-L133).

The reviewed Flood tool reads an offscreen image and performs a CPU flood fill
using an opacity threshold, then applies the resulting mask. Its ColorMatch
compute compares each Gaussian's final color with a picked Gaussian using
per-channel absolute differences. Neither supplies SplatView's connected-color
semantics or an interchangeable blended surface map.
See [Flood selection](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/tools/flood-selection.ts#L52-L111)
and [ColorMatch compute](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/color-match.ts#L58-L127).

SuperSplat shares projected GPU representations between rendering and queries,
but `renderSortedForPick` explicitly projects and sorts for picking. Footprint
selection calls it to refresh the camera-dependent data. This review does not
establish persistent selection-result caching across unchanged gestures.
SplatView retains its existing `DocumentSelectionMaps` cache and invalidation
owner. See [pick preparation](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/projected-splat-renderer.ts#L369-L400)
and [footprint preparation](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/projected-splat-renderer.ts#L695-L746).

## SplatView adaptation

The [reviewed SplatView design](../../design/feature-reviews/compact-selection-surface-2026-10-18.md)
applies the principles of bounded work, compact GPU data and explicit resource
ownership to our existing all-fragment surface query:

- Count candidates first, plan an individual power-of-two span per occupied
  tile, and allocate their combined spans. Empty tiles need no candidate span.
- Fill the compact spans and sort each tile's global depth ranks in workgroup
  memory where device limits admit that path, with a device-compatible fallback
  for larger spans. Preserve the same stable global order for compositing.
- Retain FP32 depth/opacity, raw view-dependent color, full-frame visibility,
  channel-specific readback, cancellation and complete-query admission. Resource
  exhaustion must refuse the query before a partial map can be published.

This count-first compact layout and sorting adaptation are original SplatView
work, not an implementation copied from the referenced SuperSplat picker.
It preserves the existing controller, native adoption, history and cache owners;
it does not substitute frontmost IDs for blended contributions. Device buffer
limits, safe index arithmetic and the resource ledger still constrain queries.
The source references establish design choices, not measured speedups, matching
capacity, or browser/hardware qualification. Performance claims require separate
same-workload measurements of SplatView.

## Attribution and license

The follow-up [interaction optimization](../../design/feature-reviews/selection-interaction-optimization-2026-10-18.md)
also draws on the bounded-readback and reuse principles above. SplatView now
prepares its own compute pipelines asynchronously after the first scene frame,
tightens candidate bounds using its existing fragment-alpha calculation,
retains a maximum of 16 MiB / 32 idle scratch buffers with live ledger credit,
and restricts eligible depth-only 3D-brush work/readback to conservative stroke
coverage. Fill, connected Color and source visibility still query full coverage.
The full native map dimensions, blended selection meaning and native/history
owners remain unchanged. These changes are original SplatView code; the pinned
SuperSplat files remain conceptual references, not a build dependency.

SuperSplat is published under the [MIT license](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/LICENSE).

> Copyright (c) 2011-2026 PlayCanvas Ltd.

The conceptual reference and original-code distinction above applies to this
change. Any later incorporation of substantial SuperSplat source must retain
its copyright and MIT permission notice with the copied material and identify
the exact upstream files and revision. The private source capture includes the
unmodified upstream license for inspection.
