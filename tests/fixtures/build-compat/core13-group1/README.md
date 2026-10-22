# Actual core ABI13/groupedSog1 compatibility fixture

These are untouched test-only copies of this repository's locally compiled
C++/WebAssembly core from the sealed v1 grouped-SOG runtime. The embedded
identity is core ABI13, `groupedSog:1`, native input ID
`c20685f332ec961d586d149b07c59de86203b4de33b6106089d1ef267e704e18`.
The production compatibility case reads this manifest and the two artifacts,
invokes their actual factory/WASM, and checks capability-only and shipped
full-identity refusal before source decode. Keep these files as test fixtures.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| `splatview-core.mjs` | 81307 | `30afe35a61592a34dd6bef2af311c2da1b78239879f1b81f99d24a1da149d5e7` |
| `splatview-core.wasm` | 1638750 | `80635c7e502d83ed2b2353e1a6a869e9de1f78d7a9bac1629f0d3ad99e4a6516` |

The manifest records the [sealed v1 receipt](../../../../docs/validation/runs/sog-group-20261013-01/validation.json)
and the original/copy tuples from its preserved archive manifest
`.build/sog-v2-tests/v1-sealed-archive-01/archive.json`, SHA-256
`e1dcf30d71362221b66bf46ef79f57563890a709247b30aa0b8d67c9d14d48dd`.
Copy preparation verified that pinned manifest, receipt and both exact source
leaves before copying, then reread both destinations byte-for-byte. The private
archive paths record provenance; test execution uses the owned fixture files.

Retained source and dependency provenance is documented in
[SOURCE_LOCK.json](../../../../native/SOURCE_LOCK.json) and
[DEPENDENCIES.json](../../../../native/DEPENDENCIES.json). The retained SplatView
[license](../../../../native/upstream/splatview/LICENSE),
[third-party notices](../../../../native/upstream/splatview/THIRD-PARTY-NOTICES.txt)
and [port notices](../../../../native/upstream/splatview/THIRD_PARTY_PORT_NOTICES.txt)
apply to the compiled source and its dependencies. This fixture preserves a
historical identity for refusal testing; it adds no new decoder qualification.
