# PlayCanvas source references

Reviewed on October 13, 2026. PlayCanvas provides useful browser rendering, GPU processing and file-reading references for SplatView. Desktop SplatView remains the authority for selection, covariance/SH math, color controls, Auto Color, fixed editing baselines, history and UI behavior. The references below document techniques and their provenance; they do not establish desktop parity or qualify a SplatView implementation.

## Pinned repositories and licenses

The official GitHub `main` commits were resolved once through the GitHub API, then all selected files were downloaded through URLs containing the full commit. These are observed source revisions, not claims about the deployed SuperSplat application or a published package version.

| Official repository | Pinned commit | Commit timestamp, UTC | License at that commit |
| --- | --- | --- | --- |
| [PlayCanvas Engine](https://github.com/playcanvas/engine) | [`3b389e05a4619dcb2a6efec3bc8139bf43cafd95`](https://github.com/playcanvas/engine/commit/3b389e05a4619dcb2a6efec3bc8139bf43cafd95) | 2026-10-13 02:33:57 | SPDX `MIT`; [LICENSE](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/LICENSE) |
| [SuperSplat](https://github.com/playcanvas/supersplat) | [`f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b`](https://github.com/playcanvas/supersplat/commit/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b) | 2026-10-05 15:15:32 | SPDX `MIT`; [LICENSE](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/LICENSE) |
| [SplatTransform](https://github.com/playcanvas/splat-transform) | [`45931669547a7c70cbc44d2657749f8a56e5533c`](https://github.com/playcanvas/splat-transform/commit/45931669547a7c70cbc44d2657749f8a56e5533c) | 2026-10-09 09:11:49 | SPDX `MIT`; [LICENSE](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/LICENSE) |

All three captured root licenses contain the copyright notice `Copyright (c) 2011-2026 PlayCanvas Ltd.` Their captured `package.json` files also declare `MIT`. The full license text is retained beside each local reference capture. This records the reviewed root licenses, rather than a complete dependency or asset-license audit.

| Material | Local reference capture | Copied/adapted into shipping SplatView by this review |
| --- | --- | --- |
| Engine selected sources, license and package metadata | 14 exact files, 224,942 bytes | No; reference only |
| SuperSplat selected sources, license and package metadata | 20 exact files, 220,289 bytes | No; reference only |
| SplatTransform selected sources, license and package metadata | 12 exact files, 142,762 bytes | No; reference only |
| Official developer documentation | Linked and read; no documentation/assets vendored | No; reference only |

## Rendering and GPU processing

| Technique | Exact pinned source | Useful SplatView application and boundary |
| --- | --- | --- |
| Project, cull, compact, sort, then draw from a projection cache | Engine [`src/scene/gsplat-unified/gsplat-hybrid-renderer.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/gsplat-unified/gsplat-hybrid-renderer.js#L364), [`gsplat-projector.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/gsplat-unified/gsplat-projector.js), and WGSL [`compute-gsplat-projector.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/shader-lib/wgsl/chunks/gsplat/compute-gsplat-projector.js#L1) | Reference GPU orchestration and per-camera scratch lifetimes. The projector computes cached attributes and sort keys, with a workgroup-local count and one global range reservation per workgroup. Any SplatView change still requires its established covariance projection, source-ID and picking contracts. |
| Portable radix sort and backend selection | Engine [`compute-radix-sort.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/graphics/radix-sort/compute-radix-sort.js#L12), [`compute-radix-sort-multipass.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/graphics/radix-sort/compute-radix-sort-multipass.js#L18), and WGSL [`compute-radix-sort-4bit.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/shader-lib/wgsl/chunks/radix-sort/compute-radix-sort-4bit.js) | Reference histogram/prefix/ranked-scatter decomposition and buffer reuse. The portable implementation describes a stable 4-bit, multi-pass sort without subgroup requirements. Its device selector has a separate OneSweep route. These are upstream descriptions; this review made no SplatView performance or hardware measurements. |
| GPU source/destination stream separation | Engine [`src/framework/gsplat/gsplat-processor.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/framework/gsplat/gsplat-processor.js#L36) | Reference reading source attributes while writing a separate preview/mask stream. The processor explicitly disallows overlapping read/write streams in one pass. Retain SplatView's admitted immutable editing baseline and transactional native ownership. |
| Minimal GPU selection example | Engine [`examples/src/examples/gaussian-splatting/editor.selection-processor.mjs`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/examples/src/examples/gaussian-splatting/editor.selection-processor.mjs#L1) | Demonstrates world-space center/AABB classification into a custom selection stream in WGSL/GLSL. It is a small API example, not an implementation of SplatView footprint, contributor, connected-color or morphology semantics. |

The official [renderer documentation](https://developer.playcanvas.com/user-manual/gaussian-splatting/rendering-architecture/renderers/) distinguishes asynchronous worker CPU sorting from WebGPU GPU sorting and global ordering across components. It is contextual documentation observed on the review date; the commit links above bind the implementation reference.

The portable sort file itself credits the paper *Fast 4-way parallel radix sorting on GPUs* and `kishimisu/WebGPU-Radix-Sort`, described there as MIT, at [lines 54-56](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/graphics/radix-sort/compute-radix-sort-multipass.js#L54). Preserve that existing credit in any future adaptation. This review inspected only the official PlayCanvas material and did not independently capture that secondary repository or its license.

## Editing, grading, selection and readback

| Technique | Exact pinned source | Useful SplatView application and boundary |
| --- | --- | --- |
| Immutable static attributes with mutable instance state | SuperSplat [`src/editor-splat-resource.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/editor-splat-resource.ts#L56), [`src/gaussian-instances.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/gaussian-instances.ts#L50), and [`src/splat.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/splat.ts#L40) | Instances reference immutable source rows and own flags plus transform/color palette indices. `GaussianInstances.flush()` uploads dirty spans at line 412. This is useful separation and upload reference material; SplatView's native committed scene, fixed session baseline, source-ID sampling and history remain authoritative. |
| CPU/GPU grading agreement | SuperSplat [`src/color-grade.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/color-grade.ts#L11) and [`src/shaders/color-grade-chunk.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/shaders/color-grade-chunk.ts#L1) | Reference reducing an authored grade to a shared evaluated representation and matching CPU export with GPU preview. SuperSplat uses seven authored controls and an affine color matrix/offset plus alpha multiplier. Those formulas and control ranges differ from desktop SplatView's color model and must not become its expected output. |
| Explicit Apply/Reset and reversible committed grades | SuperSplat [`src/editor.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/editor.ts#L925), [`SplatsColorOp` in `src/edit-ops.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/edit-ops.ts#L345), and [`src/color-palette.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/color-palette.ts) | `SplatsColorOp` allocates a new entry for each targeted pre-edit palette index, composes the grade, and restores indices/frees entries on Undo. It relies on strict LIFO history and re-derives its target set. This is a committed palette operation; it does not supply SplatView's repeated absolute adjustments against one immutable session baseline. |
| GPU shape/footprint classification | SuperSplat [`src/data-processor/intersect.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/intersect.ts#L315) and [`src/shaders/footprint-intersect-shader.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/shaders/footprint-intersect-shader.ts) | Reference batching classification and returning a mask through an owned readback buffer. SplatView's native geometry, map identity, fixed entry mask and operation/publication semantics require their existing parity evidence. |
| Color-match compute with pooled result ownership | SuperSplat [`src/data-processor/color-match.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/color-match.ts#L36), [`splat-value-compute.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/splat-value-compute.ts), and [`buffer-pool.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/buffer-pool.ts#L1) | Reference dispatch/readback ownership and avoiding a shared result buffer that a later run overwrites. Its shader compares clamped final RGB by per-channel thresholds and packs four byte results per `u32`; that differs from desktop SplatView's selection/color-distance authority. |
| Small-region ID and tiled depth readback | SuperSplat [`src/picker.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/picker.ts#L148) | Reference explicit submission timing, normalized-coordinate conversion, unsigned ID decoding and batched depth reads. SplatView's contributor and surface-depth definitions remain unchanged. |
| GPU min/max and histogram reduction | SuperSplat [`src/data-processor/calc-histogram.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/data-processor/calc-histogram.ts#L160) and [`src/shaders/splat-value-shader.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/shaders/splat-value-shader.ts) | Reference two compute passes and small result readbacks. This histogram describes per-splat property values with selected/unselected bins. SplatView's accepted display histogram samples actual rendered pixels including background and highlights, so its data source is different. |

The official [Color and Appearance manual](https://developer.playcanvas.com/user-manual/supersplat/editor/color-and-appearance/) documents pending previews and an explicit Apply action. The reviewed grading sources and manual did **not establish an automatic exposure or source-DC-percentile Auto Color algorithm**. Manual brightness, view exposure, histogram reduction and automatic color correction have distinct semantics. Implement SplatView Auto Color from its frozen desktop source, using PlayCanvas only for independently qualified browser execution techniques.

## SOG and header-first file reading

| Technique | Exact pinned source | Useful SplatView application and boundary |
| --- | --- | --- |
| Metadata-only SOG information | SplatTransform [`statSogSource` in `src/lib/readers/read-sog.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/readers/read-sog.ts#L345) | Reads metadata and returns v2 count/SH/model information without WebP decode; v1 returns `null`. This is a useful metadata-first workflow reference. Its `fetchSogMeta` uses whole-file read/ordinary JSON parsing and does not provide SplatView's bounded metadata/schema/resource admission. |
| Lazy row expansion over resident SOG planes | SplatTransform [`readSogSourceV2` in `read-sog.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/readers/read-sog.ts#L105) and [`src/lib/readers/read-sog-v1.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/readers/read-sog-v1.ts) | Reference version-specific attribute encoding and requested-layer expansion. V2 reads and decodes complete WebP planes up front, then expands requested rows lazily. This does not bound WebP allocation before decode or replace the existing native reader. |
| Unpacked and bundled Engine loading | Engine [`src/framework/parsers/sog.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/framework/parsers/sog.js#L137), [`sog-bundle.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/framework/parsers/sog-bundle.js), and [`src/scene/gsplat/gsplat-sog-data.js`](https://github.com/playcanvas/engine/blob/3b389e05a4619dcb2a6efec3bc8139bf43cafd95/src/scene/gsplat/gsplat-sog-data.js) | Reference metadata filename mapping, resource retirement and SOG representation. Engine asset fetching and texture loading use a different ownership model. Preserve SplatView's selected-resource authorization, original-byte group identity and candidate-only native span table. |
| Header-first, range-based PLY | SplatTransform [`readHeader` in `src/lib/readers/read-ply.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/readers/read-ply.ts#L193) and [`readPly`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/readers/read-ply.ts#L734) | Probes 128 KiB, validates binary layout and known source size, then uses chunk/range reads. This is a concrete header-first pattern. SplatView retains its existing 1 MiB PLY header policy, ordinary point/mesh support and authoritative native validation. |
| Pull-based file and range abstraction | SplatTransform [`src/lib/io/read/file-system.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/io/read/file-system.ts), [`url-file-system.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/io/read/url-file-system.ts), [`zip-file-system.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/io/read/zip-file-system.ts), and SuperSplat [`src/io/read/file-systems.ts`](https://github.com/playcanvas/supersplat/blob/f2a1b4975b4766e0ee0c95e63c2737dc2ecb6e5b/src/io/read/file-systems.ts) | Reference caller-provided buffers, seekable sources and explicit close. The convenience `readAll()` can grow its buffer and is not a SplatView input quota. Reuse the existing admitted 1 MiB range broker and joined cancellation instead of adding an unaccounted whole-file read. |
| Raw WebP bytes and codec lifetime | SplatTransform [`src/lib/utils/webp-codec.ts`](https://github.com/playcanvas/splat-transform/blob/45931669547a7c70cbc44d2657749f8a56e5533c/src/lib/utils/webp-codec.ts) | Reference codec module reuse and byte-preserving image handling. Its decoder copies compressed input into a separate WASM heap and copies decoded output out; those copies would require independent admission if adopted. The captured native SplatView codec path remains the implementation target. |

The official [SOG v2 format specification](https://developer.playcanvas.com/user-manual/gaussian-splatting/formats/sog/) describes file sets, ordered filenames, raw image channels and data-preserving lossless WebP. Use it as format context and fixture input. Keep desktop SplatView's v1/v2 reader, coordinate normalization and independent attribute oracles as the compatibility authority.

The next bounded group slice still uses SplatView's own 256 MiB sum of unique original metadata/resources, one-million loaded preview, metadata/resource/header/decoded/device checks and old-plus-candidate admission. Alias resources stage/hash once, while consumed texture roles allocate separately. These limits come from SplatView, not PlayCanvas. The source references here make no general allocator-quota or physical-memory claim.

## Capture provenance

The optional local reference packet is `.build/playcanvas-reference/20261013/`. It contains 46 selected files totaling 587,993 bytes, with each repository's `LICENSE` and `package.json`; no sample splat, texture, font, generated codec binary or full repository clone was acquired.

Each repository contains:

- `commit.json`: original official GitHub commit API response, including the complete commit and tree IDs.
- `tree.json`: original official recursive Git tree API response; capture refused a truncated response.
- `receipt.json`: repository URL, observed UTC time, requested ref, full commit/tree, API-response SHA-256/length and every selected file's path, length, SHA-256, Git blob ID and full-commit raw/permalink URLs.
- `source/`: exact selected reference bytes with the unmodified upstream root license.

For every selected file, capture checked both its byte length and Git blob SHA-1 (`SHA1("blob " + length + NUL + bytes)`) against the pinned tree entry, then recorded SHA-256. Receipt verification concerns these selected bytes; it is not repository/dependency closure, a build, a test, a deployed-host proof or browser/GPU qualification. No product/config/native/runtime files were changed by this review, and the restricted `public/wasm` directory was not accessed.

The final selected-file receipts are bound here so the optional local packet can be checked against this durable reference document:

| Receipt relative to the packet root | Bytes | SHA-256 |
| --- | --- | --- |
| `engine/receipt.json` | 9,905 | `a17961c40db17406b72d64a113f1cca264ce6ce8207e1a356646c6255a56d9e9` |
| `supersplat/receipt.json` | 12,703 | `7ee1dea320d31ed1f9a81cd718cdb3c085ddf0df93b239192331f7757d74eb28` |
| `splat-transform/receipt.json` | 8,178 | `6e6b99b4e6556e6784d973381f9dc9a64c53341eac9408e6ab36b193dbbf37b7` |

## Attribution for a future adaptation

For reference-only use, cite the exact commit permalink beside the design or technical claim and keep the usage status above accurate. A reference capture does not imply production reuse.

If actual upstream code is later copied or adapted, record the destination file, upstream repository/commit/path, affected functions, local changes, original byte hash and included license/notice location. Preserve existing source copyright/credit notices and include the full applicable MIT copyright and permission text with distributed copies or substantial portions, as stated by the pinned licenses. Capture any file-specific or secondary notices separately before describing the adaptation as fully attributed.

A future source comment may use this pattern, with real values substituted:

```text
Portions adapted from PlayCanvas <repository>, <upstream path>, commit <full SHA>.
Source: https://github.com/playcanvas/<repository>/blob/<full SHA>/<upstream path>
Copyright (c) 2011-2026 PlayCanvas Ltd.
SPDX-License-Identifier: MIT
Local changes: <specific functions/behavior changed>.
Upstream notices/license: <tracked notice file>; preserve any existing secondary credit.
```

This is an attribution template, not a statement that the current SplatView code contains these sources. New adapters still need desktop parity, ownership/admission and applicable local browser validation; upstream support claims and benchmark comments cannot qualify the port.
