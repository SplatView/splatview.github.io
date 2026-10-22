This is the first ten-input **small native-decoder/export** PLY/SPLAT packet.
It does not establish renderer, Windows visual, Mac, browser-host, large-scene,
compressed PLY, SPZ, KSPLAT or SOG acceptance. `manifest.json` binds each input,
its exact count/degree, the frozen reference and the reviewed native branches.

Run the pinned Node with `tools/formats/build-ply-splat-v1.mjs --write` to
reconstruct the ten inputs and manifest, or omit `--write` to compare the exact
bytes without writing. The independent test does not import the builder.
`tests/format-ply-splat.test.ts` supplies separate literal records, double
precision matrix math, real packed-byte reads and deliberately narrow independent
export parsers. Export comparisons do not reopen an output with the native codec.

The first eight PLY inputs share ten analytic records. Source positions encode
IDs 0..9 as x=100..109; a preview cap of three must return IDs **3,6,9**, in order.
SH3 exercises ASCII, unaligned LE float32, BE float32 and reordered LE mixed
scalar properties. SH0/1/2/4 inputs exercise all supported contiguous rest counts;
SH4's original24/channel stride retains indices0..14,24..38,48..62. SH values and
DC values are exactly representable binary16; absent bands include the signed
zero produced by their coordinate parity. Optional normals/ignored fields
occur only in the mixed fixture, proving they are not required elsewhere.

The custom SPLAT uses independently recognizable byte RGBA, anisotropic linear
scales, nonunit centered-byte w/x/y/z quaternions and the same ten positions.
Source0 in both generated families has tiny positive variances, so covariance
comparison has **no global absolute-error floor**. The frozen four-record
`playcanvas-minimal.splat` is an unchanged copy of the locked PlayCanvas fixture;
its MIT notice is in
`native/upstream/splatview/third_party/format-reference-licenses/playcanvas.txt`.
Its exact source revision/license and byte SHA are in the manifest. Other inputs
are original analytic project fixtures.

Comparison policy `ply-splat-numeric-v1` is fixed before execution:

| Attribute | Bound and reasoning |
| --- | --- |
| Positions/count/order | Exact float32 positions, source IDs and source/loaded counts; no numeric tolerance can excuse membership. |
| Decoded covariance | Each of six independent symmetric components: `4e-6 * max(scale²)`. This exceeds float32 exp/normalization and the short product/add chain while retaining relative checks at tiny scales. Oracle is `D R diag(scale²) Rᵀ D`, `D=diag(1,-1,-1)`. |
| PLY exported covariance | `1e-5 * max(scale²)`, allowing float32 eigensystem/quaternion/log-scale reconstruction. Compare reconstructed covariance so equivalent axis permutations and quaternion signs remain valid. |
| SPLAT exported covariance | `0.09 * max(scale²)`. Rounded centered-byte quaternion error is at most1/256 per ordinary component and1/128 at a clamped +1 endpoint. A unit quaternion can have at most one such clamped component. The raw error norm is therefore at most `sqrt(7)/256`; normalization changes it by at most `2e/(1-e)`, rotation operator error by at most twice that, and covariance operator error by at most twice the rotation error times max variance (<0.084 max variance). The declared0.09 also covers the preceding float32 math. This is a conservative byte-codec bound, not a renderer tolerance. |
| Opacity | Decode absolute2e-7; PLY sigmoid roundtrip3e-7 including native endpoint clamp; SPLAT0.5/255+2e-7. |
| SH/DC | Generated all48 half values exact, including zero absent bands and explicit coordinate parity. SPLAT DC half absolute0.0005; byte export within one byte of the independently evaluated DC/color conversion. SPLAT carries SH0 only. |

The test logs each numeric policy's maximum absolute error, maximum fraction of
its fixed bound and worst source/component to the observed runner log. It also
checks exact All/Selected/Remainder/deleted/Undo export membership using parsed
output bytes. This packet's supplementary in-memory malformed mutations check
refusal without replacing an edited owner/Redo, accepted SH orphan-prefix
semantics, Gaussian ASCII declared-integer conversion, sampled-out validation,
opacity endpoints, dropped SH4 terms and SPLAT zero-quaternion/partial records.
They are explicitly supplementary, not additional valid inputs or a complete
malformed-format corpus. Large allocation/cancellation tests and independent
third-party decoder comparisons remain separate gates.
