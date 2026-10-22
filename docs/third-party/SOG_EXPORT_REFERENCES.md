# SOG export source references

SplatView's frozen desktop `src/core/sog_export.cpp` remains the serializer and
complete-file byte reference for SOG v2 and legacy SOGS. Its quantization,
coordinate conversion, texture channels, lossless WebP settings, ZIP members and
metadata layout remain authoritative. The browser adapters change allocation
and output ownership. PlayCanvas's format context remains cited in
[PlayCanvas source references](PLAYCANVAS_REFERENCES.md); this export adapter
does not copy a PlayCanvas encoder.

The pinned dependency is libwebp 1.6.0. The build takes a verified copy of
[`src/utils/utils.c`](https://github.com/webmproject/libwebp/blob/v1.6.0/src/utils/utils.c)
from its installed source tree into the disposable desktop overlay. Its
`WebPSafeMalloc`, `WebPSafeCalloc` and `WebPSafeFree` entry points are adapted to
the browser's scoped allocation owner. The replacement retains the original
utility symbols and copyright comments; codec algorithms and the installed
cache are unchanged. Outside the admitted encoder scope, the original checked
allocation behavior remains available to the desktop file reference.

| Pinned source leaf | SHA-256 |
| --- | --- |
| `src/utils/utils.c` | `c8d90b4ccd536136ac710321c2632912a1f6ee2492a423e14ab9deb159490a56` |
| `COPYING` | `5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf` |
| `PATENTS` | `cc3273e0694ea5896145e0677699b53471b03ea43021ddc50e7923fbb9f5023c` |
| `AUTHORS` | `f251be89fd442bd9d701360730aea163cc8e2076ff03528f59267dc2c4f8b60a` |

The exact upstream [COPYING notice](https://github.com/webmproject/libwebp/blob/v1.6.0/COPYING)
is shipped at `public/licenses/libwebp-BSD3.txt`. Upstream also provides its
[patent grant](https://github.com/webmproject/libwebp/blob/v1.6.0/PATENTS) and
[author list](https://github.com/webmproject/libwebp/blob/v1.6.0/AUTHORS).
The source overlay preserves their existing references.

## Output bound and workspace policy

The output bound is a conservative derivation from the pinned encoder, rather
than an upstream capacity claim. For texture width `w`, height `h`, let
`N=w*h` and `G=ceil(w/64)*ceil(h/64)`. The frozen preset permits at most `G`
main Huffman groups. Its predictor, cross-color and histogram auxiliary images
each contain at most `G` pixels; its palette contains at most 256. Auxiliary
encoding uses one tree set without recursively tiled histogram images. See
[`GetHistoBits`, `ClampBits` and `EncodeImageNoHuffman`](https://github.com/webmproject/libwebp/blob/v1.6.0/src/enc/vp8l_enc.c).

Conservative literal/copy bodies, five-tree headers, auxiliary data and framing
sum below `8*N + 6168*G + 19456` bytes. The implemented per-texture allowance
`16*N + 32768*G + 131072` is larger. The derivation uses the pinned
[15-bit Huffman limit](https://github.com/webmproject/libwebp/blob/v1.6.0/src/webp/format_constants.h)
and the encoder's tree and transform topology. A codec/preset change requires a
new derivation. Native complete-file comparisons remain separate evidence.

The aggregate codec workspace allowance is an enforced policy. It covers live
ARGB, histogram, reference, hash, transform and bit-writer allocations, including
resize/clone overlap. It can reject work; it does not promise successful
encoding of every scene or establish browser physical memory usage.

This document records source provenance and intended ownership boundaries.
Implementation acceptance is established by the applicable native, unit and
browser reports, rather than these references. A bounded synchronous worker
encoder does not establish mid-call cancellation, a physical-memory ceiling,
scene capacity or a performance guarantee.
