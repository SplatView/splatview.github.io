This is a minimal construction and independent expected-data packet for one
unpacked SOG v1 SH0 group, plus a deterministic bundled `.sog` of the identical
original metadata/resources. It does not qualify native group open, browser
group loading, allocation quotas, large-scene performance or full SOG parity.

The metadata deliberately omits `version` (native default v1), declares three
sources in 2x2 textures, and has `shN: null`. The fourth pixel is not a source.
`means.files[2]` is a declared arbitrary-byte extra: include it in the source
key/staging, but never decode it as WebP. `scales.files[0]` and `sh0.files[0]`
repeat `appearance.webp`: hash/stage its original bytes once, decode its two
roles separately. The selected acquisition catalog includes
`collection/unrelated-neighbor.bin`; it must never enter the graph, body reads
or source key. The maximal selected-resource root is `collection/asset`.

`generator.cpp` encodes four literal 2x2 RGBA planes with pinned libwebp1.6.0.
Fixed lossless/exact settings preserve RGB even under the fourth appearance
pixel's alpha0. Its independent WebP decode checks all16 original bytes per
plane. It does not include SplatView model/decoder/export/hash code.

`tools/generate-sog-fixtures.py` independently constructs original metadata,
the extra/neighbor, Decimal80 numerical expectations and Python SHA-256 keys.
The expected records come directly from literal RGBA samples and analytic
unquantization, exponential scales/positions, sigmoid opacity and quaternion
covariance. They are never obtained by opening a fixture with SplatView.
`expected-records.json` fixes count/order, cap2 IDs1/2, cap1 ID2, RUB covariance,
binary16 DC and exact signed-zero absent-SH bits. Numeric bounds are fixed
before any native execution; they cover native float32 rounding, not image
quantization (these planes are lossless). Later native tests must report error
maxima and retain exact membership regardless of numeric tolerances.

`source-key-vectors.json` contains complete literal canonical hex, original
resource byte hashes/lengths and final keys. Group v1 uses UTF8-sorted distinct
asset-relative paths, includes all declared resources/extras and original
metadata bytes, and deduplicates the repeated resource. Reversed acquisition
order and a changed unrelated neighbor leave the key unchanged. Changing the
declared extra, original metadata whitespace, or one original alias spelling
changes it. The alias-spelling mutation is an identity vector only: existing
native bundled SOG refuses './' filenames. Original basename-only metadata is
valid for today's bundled loader and the future opaque-name grouped bridge.

The bundled form uses Python ZIP_STORED, fixed1980 timestamps, stable sorted
entry order and fixed attributes. It contains exactly the same six original
entry bodies and excludes the neighbor. Its source key uses single-file
framing with an empty path and the whole archive digest; it differs from the
unpacked grouped key. `SOG v1` is a format hint outside both canonical hashes.
Current single-file source validation does not admit grouped result records.

Three supplementary negative bundles have independently valid ZIP metadata
and CRCs: `negative-malformed-metadata.sog` contains truncated JSON;
`negative-missing-appearance.sog` omits the required shared scale/SH0 texture;
`negative-truncated-webp.sog` stores only the12-byte RIFF/WEBP envelope of the
required low-position plane. They isolate inner loader failures from corrupt
ZIP transport. Actual shipping-WASM refusal and retained executable Redo
checks are separate tests, not established by construction. This is not a
complete malformed-format corpus.

Build the standalone encoder with the pinned Emscripten6.0.12 SDK/config/cache:

```text
<SDK-Python> <SDK>/upstream/emscripten/em++.py generator.cpp
  --use-port=contrib.libwebp -std=c++17 -O2 -sENVIRONMENT=node
  -sFORCE_FILESYSTEM=1 -sNODERAWFS=1 -o <unique Temp>/encoder.js
```

Then use pinned Node and Python:

```text
<Python> tools/generate-sog-fixtures.py --encoder <Temp>/encoder.js
  --node <pinned Node> --write
```

Omit `--write` to verify exact output bytes. Existing differing files are never
overwritten. The generator source and this README are manually maintained;
all other packet outputs are deterministic construction artifacts. Manifest
hashes pin the exact generator/wrapper and locked desktop reference branches.
