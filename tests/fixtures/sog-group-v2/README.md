# Flat SOG v2 SH0 fixture packet

Three literal sources occupy the first three pixels of2x2 lossless RGBA textures. The fourth pixel is padding, with unused overflow codebook entries and an invalid quaternion mode. One appearance resource serves both scales and DC/alpha. The declared extra is never decoded; the neighbor is excluded.

Expected positions/covariances use independent Decimal80 math. Direct dyadic DC values have exact binary16 expectations; opacity uses literal alpha/255, including0 and255 endpoints. Preview source membership is exact for caps3/2/1. No SplatView loader/exporter supplies expected records. Numerical bounds cover only this small packet.

`cases.json` describes byte mutations and expected source/policy outcomes, not observed runtime acceptance. Unused finite JSON64 codebook entries that overflow float32 remain allowed; sampled lookups must be finite. Negative cases retain independently valid ZIP structure/CRC. The bundled baseline adds a different single-file source key while preserving every original member byte.

Generate/verify with the owned `tools/generate-sog-v2-fixtures.py`, observed Pillow12.1.0/libwebp1.6.0. Existing differing outputs are refused. The generated native header is nonshipping contract data.
