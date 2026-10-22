This packet constructs thirteen small KSPLAT v0.1 decoder inputs: the twelve
`mode{0|1|2}-sh{0|1|2|3}.ksplat` files and `mode2-mixed.ksplat`. The builder is
`tools/formats/build-ksplat-v1.mjs`. Run it with the workspace's pinned Node.
With no arguments it checks every binary and manifest byte without writing;
`--write` authorizes only those thirteen leaves and `manifest.json`. It checks
the literal destination ancestors and every exact output leaf, rejects linked
or shared-file aliases, and never enumerates the destination or rewrites this
README. Fixture construction/reproduction is distinct from decoder execution,
ordinary-App qualification, third-party interoperability and capacity acceptance.

All fixture bytes are original analytic project data. No third-party code,
fixture, native encoder output or decoder-generated expected record is copied.
The compatibility authority is the pinned local
[`loadKsplat`](../../../../native/upstream/splatview/src/core/extra_formats.cpp),
with `format_utils.hpp` for sampling and RDF-to-RUB conversion,
`scene_math.cpp` for packed covariance/half SH, and `ply_export.cpp` for diagnostic
export conventions. The manifest checks these exact branch hashes against
`native/SOURCE_LOCK.json`, records the package tree, constructor hash and each
output hash, and carries raw layout metadata without decoded numeric goldens.

The frozen source's
[`THIRD-PARTY-NOTICES.txt`](../../../../native/upstream/splatview/THIRD-PARTY-NOTICES.txt)
credits [Spark commit c57ebb936a5d364e021a66a118204d599f6fdaa8](https://github.com/sparkjsdev/spark/tree/c57ebb936a5d364e021a66a118204d599f6fdaa8)
for Rust SPLAT/KSPLAT decoding conventions and
[PlayCanvas splat-transform 3.9.0, commit 435b972a97a278c655d8f7015b1355215cba0d71](https://github.com/playcanvas/splat-transform/tree/435b972a97a278c655d8f7015b1355215cba0d71)
for layout context. Those are the format reader's recorded references, distinct
from the later browser review in
[`PLAYCANVAS_REFERENCES.md`](../../../../docs/third-party/PLAYCANVAS_REFERENCES.md).
This packet does not copy the upstream `minimal.ksplat` fixture or assert that
these constructed bytes were decoded by Spark or PlayCanvas.

Each file has 263 live source records. All integers and floating-point fields
are little endian. The main header is 4096 bytes; section headers are 1024
bytes each. Main offsets 0/1 are version bytes 0/1, uint32 offsets 4/8 are actual
and maximum section count, uint32 offset 12 is summed capacity, uint32 offset16
is live count263, uint16 offset20 is compression mode, and float32 offsets36/40
are raw minimum/maximum SH. All other unlisted main/section header bytes are zero.

Section header offsets are: uint32 0=count, 4=capacity, 8=bucket size,
12=bucket count; float32 16=block size16; uint16 20=bucket bytes12;
uint32 24=range4096, 32=full bucket count, 36=partial bucket count;
uint16 40=SH degree. Each section's physical storage contains uint32 partial
bucket lengths, then float32 XYZ bucket centers, then **capacity** records.
The next section starts after this complete storage, including unused capacity.

Uniform fixtures contain these four sections, where D is the filename degree:

| Physical section | Live count | Capacity | Degree | Bucket size | Full buckets | Partial lengths |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 2 | 3 | 0 | 0 | none |
| 1 | 5 | 8 | D | 2 | 1 | 1,2 |
| 2 | 258 | 261 | D | 64 | 3 | 2,64 |
| 3 | 0 | 1 | 3 | 0 | 0 | none |

The mixed mode2 fixture instead contains:

| Physical section | Live count | Capacity | Degree | Bucket size | Full buckets | Partial lengths |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | 2 | 3 | 0 | 0 | none |
| 1 | 5 | 8 | 0 | 2 | 1 | 1,2 |
| 2 | 66 | 69 | 1 | 16 | 3 | 2,16 |
| 3 | 64 | 67 | 2 | 32 | 1 | 7,25 |
| 4 | 128 | 131 | 3 | 32 | 3 | 5,27 |
| 5 | 0 | 1 | 3 | 0 | 0 | none |

Empty sections retain degree3 but must not inflate a uniform SH0–2 scene's
retained degree. Every inactive record, including wholly empty sections, has
invalid geometry: mode0 uses float32 quiet-NaN words `0x7fc00000`; modes1/2 use
half quiet-NaN words `0x7e00` for every complete two-byte word, with a final
unpaired byte `0xa5` where needed. These bytes must be skipped, while the
capacity storage still contributes to subsequent offsets. Mode0 preserves all
bucket metadata even though its decoder uses direct float32 positions.

Let `id` be the global live source ID, `s` the physical section index including
empty sections, `b` its bucket index, and `a` axis0/1/2. Full buckets precede the
listed partial buckets. The center is `[s*32+b*4, s*8-b*2, -s*16+b*3]`.
The integer delta is `(id*(a+1)+a*7)%31-15`, and position is center plus delta/512.
Modes1/2 store position code4096+delta; block16/range4096 gives exactly1/512.
Scales are `[.5+(id%7)/16, .25+(id%5)/32, .125+(id%3)/64]`. Quaternion wxyz cycles
through `[2,1,0,0]`, `[2,0,1,0]`, `[2,0,0,1]`, `[1,1,1,1]`, `[3,1,2,0]`,
`[3,0,1,2]`, `[2,-1,1,0]`; source quaternions are deliberately unnormalized.
RGBA is `[id%256, (id*3+17)%256, (id*7+29)%256, [0,64,128,192,255][id%5]]`.

Mode0 records are 44+4*rest bytes: position float32 at0, scale float32 at12,
quaternion float32 at24, RGBA at40 and rest-SH at44. Modes1/2 records are
24+2*rest or 24+rest bytes: position uint16 at0, scale half at6, quaternion half
at12, RGBA at20 and rest-SH at24. Rest counts for SH0/1/2/3 are0/9/24/45.
SH wire order is **channel-major separately within each band**. For band1..D,
channel0..2 and j0..2*band, modes0/1 encode
`((id*7+band*11+channel*13+j*3)%31-15)/32` as exact float32/half. Mode2 stores
byte `(id*17+band*37+channel*41+j*13)%256`. Uniform raw SH range is[-.75,1.25];
mixed raw range[0,0] invokes native defaults[-1.5,1.5]. No equal-range edge input
is silently added: accepted/refused mutations belong to the independent tests.

Full load must retain source IDs0..262 in order. Caps3/2/1 must retain literal
IDs **87,175,262** / **131,262** / **262** respectively, crossing section and
partial-bucket boundaries. Tests independently parse the bytes and reconstruct
expected attributes; they must not import this constructor or production math.

Policy **ksplat-numeric-v1** is fixed before decoder execution: position absolute
1e-5; opacity absolute1e-7; each covariance component1e-5 times the independently
reconstructed maximum axis variance with no absolute floor. DC admissible half
bits round `[analyticDC-2e-6, analyticDC+2e-6]` with IEEE ties-to-even. Modes0/1
retained rest-SH half bits are exact after RDF-to-RUB signs; mode2 uses the same
half interval policy with coefficient error2e-6. Omitted native components obey
the exact signed-zero policy. Diagnostic exported PLY permits position1e-5,
covariance3e-5 times maximum axis variance and sigmoid opacity3e-7. Count,
source membership, masks and ordering are exact and separate from tolerances.

Malformed/refusal and accepted-edge cases are bounded in-memory mutations in
the independent test packet. They must preserve the prior edited scene, masks,
retained output and executable Redo; header/topology validation and sampled-out
attribute reconstruction are distinct branches. A decoder calibration and its
recorded maxima do not imply whole-format, renderer, host, large-input or
performance acceptance. Ordinary-App input/edit/download checks are separate.
