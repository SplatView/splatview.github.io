# PlayCanvas input-limit references

Reviewed 2026-10-18 against official PlayCanvas documentation and SuperSplat
3.5.2 source at commit
[`f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`](https://github.com/playcanvas/supersplat/commit/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b).
These references inform input policy; they do not establish equivalent capacity
for SplatView or qualify our loader on additional hardware.

## Local editor

No general fixed file-byte cap was found in the reviewed local import path or
published editor documentation. The inspected path accepts local files through
the [file handler](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/file-handler.ts#L292-L386)
and a [Blob reader](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/io/read/file-systems.ts#L17-L65)
without a universal byte-admission threshold. This is a scoped source finding,
not a guarantee that every format or arbitrarily large file can load.

PlayCanvas describes large-scene failures in terms of available GPU memory and
recommends importing a lower LOD or reducing Gaussian count. Its editor also
allocates resources from decoded scene properties and per-Gaussian state.
See [editor troubleshooting](https://developer.playcanvas.com/user-manual/supersplat/editor/troubleshooting/#the-editor-is-slow-or-runs-out-of-memory)
and [editor resource allocation](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/editor-splat-resource.ts#L98-L110).

The source's `LOD_MAX_SPLATS = 20_000_000` is a default-LOD selection heuristic.
It prefers the most detailed level below that count, or the least detailed
available level when none qualifies. It does not reject all scenes above
20 million Gaussians. The editor offers the available levels for selection.
See [LOD heuristic](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/io/read/loader.ts#L34-L47)
and [LOD picker](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/asset-loader.ts#L60-L92).

## Upload and streamed viewer

The documented **10 GB** maximum belongs to hosted **Direct Upload**, which
bypasses the editor and sends the input to PlayCanvas storage. It is not a
browser-local decoding or editing limit.
See [Direct Upload](https://developer.playcanvas.com/user-manual/supersplat/upload/).

The streamed viewer selects LODs and limits Gaussians drawn concurrently:
desktop 2 million with Performance Mode enabled or 4 million disabled;
mobile/XR 1 million enabled or 2 million disabled. These are viewer budgets,
not source-file ceilings or local-editor import guarantees.
See [LOD streaming](https://developer.playcanvas.com/user-manual/supersplat/streaming/).

## SplatView policy boundary

Use SuperSplat as a reference for resource-aware admission and clear failure
messages, rather than borrowing a hosting limit or a scene-count heuristic.
Our current all-resident loader retains independent constraints:

- A **512 MiB native candidate budget**, including source bytes concurrently
  with decoding work; this is not a 512 MiB supported-file-size promise.
  [Source admission](../../src/document/sceneInputLimits.ts) and
  [group admission](../../src/document/sourceGroup.ts) enforce that distinction.
- A **1 GiB aggregate reservation ledger**, with existing documents and other
  retained resources charged separately. The ledger accounts for logical
  reservations, not measured physical browser/GPU memory.
  See [controller](../../src/app/controller.ts) and
  [resource ledger](../../src/document/resources.ts).
- A **1 million loaded-preview limit**, distinct from source record count.
  See [load probe](../../src/document/loadProbe.ts).
- A **uint32 transport domain** for source lengths and ranges, at most
  `4,294,967,295` bytes. Passing that technical bound does not imply that a
  source fits decode, aggregate-memory or device limits.
  See [input limits](../../src/document/sceneInputLimits.ts) and
  [source descriptors](../../src/document/source.ts).

These budgets do not implement hardware-adaptive allocation or SuperSplat's
streaming architecture. Capacity claims require separate measurements of our
own loading, editing, recovery and export paths.
