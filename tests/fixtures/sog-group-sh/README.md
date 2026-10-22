# Independent unpacked SOG higher-SH fixtures

Six independent v1/v2 x SH1/2/3 packets use three sources in2x2 base planes. Labels0/63/64 span centroid rows. Legacy palettes derive128 entries from2rows; v2 declares65 entries with3rows. The seven decode roles use6distinct compressed textures because scale/DC alias appearance. One extra is declared twice, staged/hashed once; the unrelated neighbor is excluded.

Unchanged base WebP bytes and independently constructed SH0 goldens are copied/cited from the existing literal packets. Directional SH expected values come solely from explicit endpoint/dyadic literals, the pinned15sign vector and Python IEEEbinary16. No production decoder/exporter or platform oracle supplies these expectations. All canonical directional RGB values are nonzero; the companion signed-zero case verifies both signs. Inactive bands retain source signed-zero parity in the full48-half storage.

cases.json lists intended captured-source/policy outcomes at caps3/2/1, not observed native/browser results. Palette booleans are desktopWindows64 refusals despite WASM32 JSON conversion differences. Fractional65.9palette, 1.9bands and truebands remain source-compatible. Only sampled labels/referenced centroid values must be valid; ignoredBA/alpha, padding, unreferenced cells and unused float32-overflow book entries are preserved.

Generate with tools/generate-sog-sh-fixtures.py --write, verify without --write. Existing differing outputs are never overwritten. The native/wasm/sog_sh_contract_data.hpp header contains only independently constructed contract data. Fixture construction and byte verification do not establish native/browser runtime qualification.
