`minimal.splat` and `minimal.ksplat` are unchanged interoperability fixtures from
[PlayCanvas splat-transform 3.9.0](https://github.com/playcanvas/splat-transform/tree/435b972a97a278c655d8f7015b1355215cba0d71/test/fixtures/splat),
the format library used by SuperSplat 3.5.2. Each contains four splats with known
positions, scales, colors and opacity. Their generator is
`test/fixtures/create-fixtures.mjs` in that revision.

Copyright (c) 2011-2026 PlayCanvas Ltd. MIT license:
`../../third_party/format-reference-licenses/playcanvas.txt`.

The contracts additionally generate anisotropic scenes in all new formats,
including compressed KSPLAT with mixed SH degrees, reserved capacity and short
spatial buckets, reordered packed PLY properties and SOG v1 palettes.
