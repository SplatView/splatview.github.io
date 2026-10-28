# Pinned WebP overlay-test source

`utils.c` is the byte-exact `src/utils/utils.c` from WebP 1.6.0, accompanied by
the original `COPYING`, `PATENTS` and `AUTHORS` notices. It is test data for the
source-only allocator-overlay test, not a codec build input or substitute SDK.

Source: <https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz>

The archive is already pinned by Emscripten 6.0.12 and
`tools/verify-toolchain.py`. Its SHA-512 is
`5c159d9760efcb92749092536daada22c0a73c20926c76097a5f0448ddbf874cf761324ca97925ca5f578b30477564b2b072b47667e504673797128b31cafcbf`.

`utils.c` SHA-256:
`c8d90b4ccd536136ac710321c2632912a1f6ee2492a423e14ab9deb159490a56`.
The production adapter checks this digest before transforming any source.
The regression keeps that check and the changed-source refusal, while running
without a locally installed Emscripten port cache. Do not regenerate or normalize
the fixture, or change the native source/toolchain locks, to update this test.
