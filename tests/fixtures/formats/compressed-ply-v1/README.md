This packet constructs sixteen small compressed-PLY inputs: both 12/18-bound
layouts, little/big endian, and SH0/1/2/3. The builder is
`tools/formats/build-compressed-ply-v1.mjs`. With no arguments it compares every
binary and manifest byte without writing. `--write` authorizes only the sixteen
fixed `layout{12|18}-{le|be}-sh{0|1|2|3}.ply` leaves and `manifest.json`; it never
rewrites this README or scans an output namespace. Run it with the pinned Node
from the workspace. Construction and reproduction are not native/browser
qualification, third-party interoperability, renderer or capacity acceptance.

All binary data are original analytic project inputs. No third-party fixture,
encoder, decoder-generated expectations or source implementation was copied.
`manifest.json` records the constructor hash and exact output hashes, as well as
the frozen package tree and four reviewed native source hashes. The branch pins
are checked against both current bytes and `native/SOURCE_LOCK.json` before any
output writes. The native compressed reader is
`native/upstream/splatview/src/core/model.cpp:119`; sampling/coordinate policy is
in `format_utils.hpp`, and normalized covariance/native half packing is in
`scene_math.cpp`. The local
`docs/third-party/PLAYCANVAS_REFERENCES.md` records external format context and
reference provenance; these inputs do not copy its optional reference captures.

Each input contains 257 vertices and two chunks. Chunk 0 owns source 0..255;
chunk 1 owns source 256. The two chunks have distinct position, anisotropic
log-scale and explicit RGB bounds. The 12-field layout omits RGB bounds and
therefore exercises the reader's implicit 0..1 RGB range. All bounds are exact
binary32 literals. Full loading must retain all 257 source records in order;
caps 3/2/1 must retain **85,171,256** / **128,256** / **256** respectively. These
literal membership checks are separate from numeric tolerances.

Every header declares `chunk`, `vertex`, and optional `sh` in that order. Required
chunk properties are deliberately reordered and alternate `float`/`float32` type
spellings. Vertex properties are, in order: `uchar sentinel`, `uint32
packed_scale`, `uint packed_color`, `uint32 packed_rotation`, `uint
packed_position`. The 17-byte stride and one-byte sentinel exercise legal extra
attributes and unaligned integer reads. Header padding fixes the body offset
modulo 4 to 1. The SH element has exactly 9/24/45 byte fields, declared in reverse
`f_rest_` order with alternating `uchar`/`uint8` spellings; its logical data remain
channel-major.

The packed position and scale words use independently authored 11/10/11-bit
integer codes, including both endpoints and interior values. Source 0/1 contain
explicit endpoints; all other source positions are recognizable from their
integer IDs. Rotations cycle through all four omitted quaternion components and
eight nontrivial smallest-three code patterns, paired with anisotropic scales.
RGBA includes alpha 0/255/1/254/interior values and RGB endpoints/interiors;
source 256 deliberately retains nonzero alpha. The SH byte palette includes
0/255 endpoint bins and interior 1/254/17/63/127/128/191/239 bins, with a distinct
source/channel/coefficient pattern. Native inactive half components include the
coordinate conversion's signed-zero behavior and are not shader stride padding.

`tests/format-compressed-ply.test.ts` owns the independent binary reader,
mathematical expected attributes, half rounding and comparisons. It must not
import the constructor or use production parsing/encoding as expected output.
The manifest names fixed policy `compressed-ply-numeric-v1`: position
absolute 6e-5; decoded covariance 8e-6 times maximum axis variance, with no absolute
floor; opacity 1e-7; PLY exported covariance 3e-5 times maximum axis variance and
sigmoid opacity 3e-7. Rest-SH and absent signed-zero native half bits are exact;
DC admissible bits independently round the fixed interval
`[analyticDC - 2e-6, analyticDC + 2e-6]` to binary16 with IEEE ties-to-even. These
fixture-specific bounds belong to the independently authored validator, not to
a runtime calibration or a general format/performance claim.

Malformed/refusal and accepted-edge cases are supplementary in-memory mutations
in the independent validator, not extra binaries silently added to this packet.
They must preserve the source distinctions: all chunk bounds are validated even
when their vertices are sampled out; vertex reconstruction occurs only for
retained records. Independent export membership and edited-old-owner/Redo checks
are separate from simply reopening the native writer's own bytes. Actual App
publication, cancellation, upload failure, wider layouts/counts and million-point
capacity remain separate work.
