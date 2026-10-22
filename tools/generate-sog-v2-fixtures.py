"""Construct and verify independent flat SOG v2 SH0 fixture bytes and goldens.

Only Pillow/libwebp encodes and checks literal RGBA pixels. No SplatView loader,
exporter, native hash, or application helper is invoked. Decimal80 analytic
expectations and Python hashlib/struct source-key framing are independent of the
shipping float32 implementation. Existing differing outputs are never replaced.
"""
from pathlib import Path
from decimal import Decimal, localcontext
import argparse
import copy
import hashlib
import io
import json
import struct
import zipfile

import PIL
from PIL import Image, features


ROOT = Path(__file__).resolve().parents[1]
PACKET = "sog-group-v2"
FORMAT = "SOG v2"
HEADER = b"SplatViewSource\x00v1\x00"
PIXELS = {
    "positions-low.webp": [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [42, 43, 44, 255]],
    "positions-high.webp": [[0, 128, 255, 255], [64, 191, 0, 255], [255, 0, 128, 255], [45, 46, 47, 255]],
    "appearance.webp": [[0, 2, 5, 0], [4, 1, 3, 255], [2, 5, 0, 96], [6, 6, 6, 128]],
    "rotations.webp": [[128, 128, 128, 252], [200, 32, 128, 253], [64, 191, 224, 255], [0, 0, 0, 251]],
}
SCALE_BOOK = [-2.25, -1.125, -0.25, 0.375, 1.25, 2, 1e100]
COLOR_BOOK = [-3.5, -1.25, 0.125, 1.5, 4, 6.25, 1e100]
METADATA = {
    "version": 2,
    "count": 3,
    "means": {"mins": [-1, -0.5, -0.25], "maxs": [1, 0.5, 0.75],
              "files": ["positions-low.webp", "positions-high.webp", "declared-extra.bin"]},
    "scales": {"codebook": SCALE_BOOK, "files": ["appearance.webp"]},
    "quats": {"files": ["rotations.webp"]},
    "sh0": {"codebook": COLOR_BOOK, "files": ["appearance.webp"]},
    "shN": None,
}
EXTRA = b"SOG v2 declared-but-undecoded extra\x00\xff\x01\x80\n"
NEIGHBOR = b"UNRELATED v2: must not be opened or hashed\x00\xfe\n"
SH_PARITY = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1]
REFERENCE_FILES = [
    "native/upstream/splatview/src/core/model.cpp",
    "native/upstream/splatview/src/core/format_utils.hpp",
    "native/upstream/splatview/src/core/scene_math.cpp",
    "reference/windows/src/model.cpp",
    "reference/windows/src/format_utils.hpp",
]


def sha(value):
    return hashlib.sha256(value).hexdigest()


def document(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def encode(pixels, width=2, height=2):
    rgba = bytes(component for pixel in pixels for component in pixel)
    assert len(rgba) == width * height * 4
    image = Image.frombytes("RGBA", (width, height), rgba)
    stream = io.BytesIO()
    image.save(stream, format="WEBP", lossless=True, quality=100, method=6, exact=True)
    payload = stream.getvalue()
    assert payload[:4] == b"RIFF" and payload[8:12] == b"WEBP"
    assert len(payload) == struct.unpack("<I", payload[4:8])[0] + 8
    with Image.open(io.BytesIO(payload)) as decoded:
        assert decoded.size == (width, height)
        assert decoded.convert("RGBA").tobytes() == rgba, "Transparent RGB and all literal channels must remain exact"
    return payload


def canonical(resources, kind="group"):
    entries = sorted(resources.items(), key=lambda item: item[0].encode("utf-8"))
    encoded = bytearray(HEADER + (b"\x01" if kind == "group" else b"\x00") + struct.pack(">I", len(entries)))
    for name, payload in entries:
        utf8 = name.encode("utf-8")
        encoded += b"\x01" if name == ("meta.json" if kind == "group" else "") else b"\x00"
        encoded += struct.pack(">I", len(utf8)) + utf8 + struct.pack(">Q", len(payload))
        encoded += hashlib.sha256(payload).digest()
    return bytes(encoded)


def vector(name, resources, kind="group", **extra):
    encoded = canonical(resources, kind)
    return {"name": name, "scheme": "splatview-source-v1", "kind": kind,
            "sourceKindHint": FORMAT, "resourceCount": len(resources),
            "totalBytes": sum(map(len, resources.values())), "canonicalByteLength": len(encoded),
            "canonicalHex": encoded.hex(), "assetDigest": sha(encoded),
            "resources": [{"path": name,
                           "role": "primary" if name == ("meta.json" if kind == "group" else "") else "referenced",
                           "byteLength": len(payload), "sha256": sha(payload)}
                          for name, payload in sorted(resources.items(), key=lambda item: item[0].encode("utf-8"))],
            **extra}


def bundle(resources):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, payload in sorted(resources.items(), key=lambda item: item[0].encode("utf-8")):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.create_version = entry.extract_version = 20
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_STORED
            archive.writestr(entry, payload)
    payload = stream.getvalue()
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        assert archive.namelist() == sorted(resources, key=lambda name: name.encode("utf-8"))
        assert all(archive.read(name) == data for name, data in resources.items())
    return payload


def expected_records():
    with localcontext() as context:
        context.prec = 80
        D = Decimal
        low = [D(-1), D("-0.5"), D("-0.25")]
        high = [D(1), D("0.5"), D("0.75")]
        scales_book = [D(str(value)) for value in SCALE_BOOK]
        colors_book = [D(str(value)) for value in COLOR_BOOK]
        records = []
        for source_id in range(3):
            lo, hi = PIXELS["positions-low.webp"][source_id], PIXELS["positions-high.webp"][source_id]
            indexed, packed_q = PIXELS["appearance.webp"][source_id], PIXELS["rotations.webp"][source_id]
            encoded = [low[j] + D((hi[j] << 8) | lo[j]) / D(65535) * (high[j] - low[j]) for j in range(3)]
            position = [(abs(value).exp() - 1).copy_sign(value) for value in encoded]
            scales = [scales_book[indexed[j]].exp() for j in range(3)]
            dc = [colors_book[indexed[j]] for j in range(3)]
            opacity = D(indexed[3]) / D(255)
            missing = packed_q[3] - 252
            q = [(D(packed_q[j]) / D(255) - D("0.5")) * D("1.41421356237") for j in range(3)]
            q.insert(missing, max(D(0), D(1) - sum(value * value for value in q)).sqrt())
            length = sum(value * value for value in q).sqrt()
            w, x, y, z = [value / length for value in q]
            rotation = [[1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y)],
                        [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)],
                        [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)]]
            signs = [1, -1, -1]
            covariance = [[sum(rotation[i][k] * rotation[j][k] * scales[k]**2 for k in range(3)) *
                           signs[i] * signs[j] for j in range(3)] for i in range(3)]
            dc_bits = [struct.unpack("<H", struct.pack("<e", float(value)))[0] for value in dc]
            absent = [0x8000 if sign < 0 else 0 for sign in SH_PARITY for _ in range(3)]
            all_bits = dc_bits + absent
            packed_words = [all_bits[index] | (all_bits[index + 1] << 16) for index in range(0, 48, 2)]
            records.append({"sourceId": source_id, "positionRdf": list(map(float, position)),
                            "positionRub": [float(position[0]), float(-position[1]), float(-position[2])],
                            "linearScales": list(map(float, scales)), "logScales": [float(scales_book[indexed[j]]) for j in range(3)],
                            "quaternionWxyzRdf": list(map(float, q)), "opacity": float(opacity),
                            "opacityFloat32Bits": struct.unpack("<I", struct.pack("<f", float(opacity)))[0],
                            "dc": list(map(float, dc)), "packedDcHalf": [struct.unpack("<e", struct.pack("<H", bits))[0] for bits in dc_bits],
                            "packedDcHalfBits": dc_bits, "packedShWords": packed_words,
                            "covarianceRub": [float(covariance[i][j]) for i, j in ((0,0),(0,1),(0,2),(1,1),(1,2),(2,2))],
                            "absentShHalfBits": absent})
        assert records[0]["opacity"] == 0 and records[1]["opacity"] == 1
        return {"schemaVersion": 1, "sourceCount": 3, "shDegree": 0, "format": FORMAT, "yUp": True,
                "allSourceIds": [0, 1, 2], "cap2SourceIds": [1, 2], "cap1SourceIds": [2],
                "fourthPixelIsNotASource": True, "paddingContainsUnreferencedNonfiniteFloat32CodebookAndInvalidQuaternion": True,
                "records": records, "numericPolicy": {
                    "id": "sog-v2-sh0-small-v1", "positionsAbsolute": 0.000002, "opacityAbsolute": 0.0000003,
                    "covarianceRelativeToMaxAxisVariance": 0.000008,
                    "packedDcHalf": "Exact binary16 bits from dyadic DC codebook values and absent-band signed-zero parity",
                    "opacityEndpoints": "Exactly zero and one; interior literal alpha/255 float32 bits independently supplied",
                    "membership": "Exact source IDs/order/count; no tolerance",
                    "basis": "Decimal80 signed-expm1 position, exp(log-scale codebook), direct dyadic DC codebook, alpha/255, normalized quaternion and D R S^2 R^T D; fixed bounds cover native float32 arithmetic on this packet, not all SOG values"}}


def case_payloads(resources):
    cases, files, texture_overrides = [], {}, {}

    def add(name, metadata=None, replacements=None, accepted=False, reason="", layer="native-or-browser"):
        bodies = dict(resources)
        if metadata is not None:
            bodies["meta.json"] = document(metadata)
        for filename, payload in (replacements or {}).items():
            if payload is None:
                bodies.pop(filename)
            else:
                bodies[filename] = payload
        filename = f"cases/{name}.sog"
        files[filename] = bundle(bodies)
        cases.append({"name": name, "file": filename, "accepted": accepted, "cap": 3,
                      "reason": reason, "scope": layer, "sourceCount": 3 if accepted else None,
                      "originalMetadata": bodies["meta.json"].decode("utf-8"),
                      "resourceChanges": [{"path": path, "omitted": payload is None,
                                           "sha256": sha(payload) if payload is not None else None,
                                           "bytes": len(payload) if payload is not None else None}
                                          for path, payload in (replacements or {}).items()]})

    def meta_case(name, group, key, value, reason, accepted=False, layer="native-or-browser"):
        metadata = copy.deepcopy(METADATA)
        if group:
            metadata[group][key] = value
        else:
            metadata[key] = value
        add(name, metadata, accepted=accepted, reason=reason, layer=layer)

    for name, value in [("true", True), ("zero", 0), ("fractional-zero", 0.9), ("negative", -1), ("too-large", 10000001), ("image-overflow", 5), ("string", "3")]:
        meta_case(f"count-{name}", None, "count", value, "Invalid bounded integral source count or count exceeds decoded image pixels")
    meta_case("count-fractional-three", None, "count", 3.9,
              "Captured numeric uint64 conversion truncates3.9 to3; sampled records match canonical fixture", accepted=True)
    meta_case("version-fractional-two", None, "version", 2.9,
              "Captured numeric int conversion truncates2.9 to2; sampled records match canonical fixture", accepted=True)
    fractional = copy.deepcopy(METADATA)
    fractional["count"], fractional["version"] = 3.9, 2.9
    add("version-count-fractional", fractional, accepted=True,
        reason="Both numeric fields truncate tocanonical v2/count3; original metadata bytes and source key remain distinct")
    for group in ["scales", "sh0"]:
        book = SCALE_BOOK if group == "scales" else COLOR_BOOK
        meta_case(f"{group}-empty-codebook", group, "codebook", [], "Codebook length must be1..256")
        meta_case(f"{group}-oversized-codebook", group, "codebook", [0] * 257, "Codebook length must be1..256")
        meta_case(f"{group}-nonnumeric-codebook", group, "codebook", ["bad", *book[1:]], "Referenced codebook entry is not numeric")
        meta_case(f"{group}-referenced-f32-overflow", group, "codebook", [1e100, *book[1:]], "Referenced finite JSON number becomes nonfinite float32 and is refused")
        meta_case(f"{group}-unused-f32-overflow-changed", group, "codebook", [*book[:-1], -1e100],
                  "Unused finite JSON64 overflow entry is permitted; all sampled attributes are unchanged", accepted=True)
    for name, log_scale in [("exp-overflow", 100), ("exp-underflow", -120), ("covariance-overflow", 60), ("covariance-underflow", -60)]:
        meta_case(f"scales-{name}", "scales", "codebook", [log_scale, *SCALE_BOOK[1:]],
                  "Referenced log scale must yield finite positive float32 scale and positive representable squared variance")
    meta_case("sh0-half-overflow", "sh0", "codebook", [90000, *COLOR_BOOK[1:]], "Referenced DC exceeds finite binary16 coefficient limit")
    meta_case("means-short-bounds", "means", "mins", [-1, -0.5], "Position bounds require exactly three components")
    meta_case("means-range-overflow", "means", "maxs", [41, 0.5, 0.75], "Captured encoded-coordinate bound is absolute40")
    meta_case("means-reversed-range", "means", "maxs", [-2, 0.5, 0.75], "Encoded coordinate minimum exceeds maximum")
    meta_case("unsupported-version", None, "version", 3, "Flat grouped packet supports exact v1 or v2")
    meta_case("nonzero-sh", None, "shN", {"bands": 1, "count": 1, "codebook": [0], "files": ["appearance.webp", "rotations.webp"]},
              "This grouped browser increment explicitly supports SH0 only", layer="bounded-group-browser-policy")
    invalid_index = copy.deepcopy(PIXELS["appearance.webp"])
    invalid_index[0][0] = 255
    texture_overrides["scale-invalid-index.webp"] = encode(invalid_index)
    add("referenced-scale-codebook-index", replacements={"appearance.webp": texture_overrides["scale-invalid-index.webp"]},
        reason="Sampled scale index255 is outside seven-entry codebook; cap1 source2 remains valid")
    texture_overrides["dc-invalid-index.webp"] = encode(invalid_index)
    dc_only = copy.deepcopy(METADATA)
    dc_only["sh0"]["files"] = ["dc-invalid-index.webp"]
    add("referenced-dc-codebook-index", dc_only, replacements={"dc-invalid-index.webp": texture_overrides["dc-invalid-index.webp"]},
        reason="Sampled DC index255 is outside seven-entry codebook; scale role retains canonical appearance and cap1 source2 remains valid")
    used_overflow = copy.deepcopy(PIXELS["appearance.webp"])
    used_overflow[0][0] = 6
    texture_overrides["appearance-used-overflow.webp"] = encode(used_overflow)
    add("referenced-overflow-codebook-index", replacements={"appearance.webp": texture_overrides["appearance-used-overflow.webp"]},
        reason="Sampled source0 index6 addresses nonfinite float32 entry; unsampled bad source0 remains allowed atcap1")
    invalid_quaternion = copy.deepcopy(PIXELS["rotations.webp"])
    invalid_quaternion[0][3] = 251
    texture_overrides["rotation-invalid-mode.webp"] = encode(invalid_quaternion)
    add("referenced-quaternion-mode", replacements={"rotations.webp": texture_overrides["rotation-invalid-mode.webp"]},
        reason="Sampled quaternion mode is below252")
    texture_overrides["appearance-layout-1x4.webp"] = encode(PIXELS["appearance.webp"], 1, 4)
    add("property-layout-mismatch", replacements={"appearance.webp": texture_overrides["appearance-layout-1x4.webp"]},
        reason="Equal pixel count cannot replace equal image width and height")
    add("truncated-required-webp", replacements={"positions-low.webp": resources["positions-low.webp"][:12]},
        reason="RIFF/WEBP envelope alone has no decoded image")
    add("missing-shared-resource", replacements={"appearance.webp": None}, reason="Required aliased scale/DC original resource is absent")
    for name, payload in texture_overrides.items():
        files[f"case-textures/{name}"] = payload
    return files, {"schemaVersion": 1, "cap": 3, "scope": "Independent byte mutations and expected source/policy refusals; not runtime execution results",
                   "baseUnusedFloat32OverflowAccepted": True, "sampledLookupOnly": True,
                   "cases": cases, "textureOverrides": [{"file": f"case-textures/{name}", "bytes": len(payload), "sha256": sha(payload)}
                                                        for name, payload in texture_overrides.items()]}


def cpp_header(files, expected, keys):
    arrays = [
        ("sogV2OriginalMeta", "collection/asset/meta.json"), ("sogV2Appearance", "collection/asset/appearance.webp"),
        ("sogV2Extra", "collection/asset/declared-extra.bin"), ("sogV2High", "collection/asset/positions-high.webp"),
        ("sogV2Low", "collection/asset/positions-low.webp"), ("sogV2Rotation", "collection/asset/rotations.webp"),
        ("sogV2Bundle", "bundled-v2-sh0.sog"),
        ("sogV2BadScaleIndexAppearance", "case-textures/scale-invalid-index.webp"),
        ("sogV2BadDcIndexAppearance", "case-textures/dc-invalid-index.webp"),
        ("sogV2UsedOverflowAppearance", "case-textures/appearance-used-overflow.webp"),
        ("sogV2BadModeRotation", "case-textures/rotation-invalid-mode.webp"),
        ("sogV2BadLayoutAppearance", "case-textures/appearance-layout-1x4.webp"),
    ]
    lines = ["// Generated nonshipping independent literal/Decimal80 fixture data; no decoder-derived expectations.",
             "// Generator: tools/generate-sog-v2-fixtures.py SHA256 " + sha(Path(__file__).read_bytes()),
             "#pragma once", "#include <cstdint>"]
    for name, filename in arrays:
        payload = files[filename]
        lines += [f"// tests/fixtures/{PACKET}/{filename} SHA256 {sha(payload)}",
                  f"inline constexpr uint8_t {name}[]={{" + ",".join(map(str, payload)) + "};"]
    for name, filename, payload in [
        ("sogV2ExpectedRecords", "expected-records.json", expected),
        ("sogV2SourceKeyVectors", "source-key-vectors.json", keys),
        ("sogV2Cases", "cases.json", files["cases.json"]),
    ]:
        assert b')SOGV2"' not in payload
        lines += [f"// tests/fixtures/{PACKET}/{filename} SHA256 {sha(payload)}",
                  f'inline constexpr char {name}[]=R"SOGV2(' + payload.decode("utf-8") + ')SOGV2";']
    return ("\n".join(lines) + "\n").encode("utf-8")


def build_files(args):
    if PIL.__version__ != "12.1.0" or features.version("webp") != "1.6.0":
        raise ValueError("Deterministic construction requires observed Pillow12.1.0/libwebp1.6.0")
    textures = {name: encode(pixels) for name, pixels in PIXELS.items()}
    resources = {"meta.json": document(METADATA), **textures, "declared-extra.bin": EXTRA}
    original = vector("original-complete-group", resources)
    fractional = copy.deepcopy(METADATA)
    fractional["count"], fractional["version"] = 3.9, 2.9
    vectors = [original,
               vector("reversed-acquisition-order", dict(reversed(list(resources.items())))),
               vector("unrelated-neighbor-bytes-changed", resources, excludedNeighborSha256=sha(NEIGHBOR + b"changed")),
               vector("declared-extra-last-byte-changed", {**resources, "declared-extra.bin": EXTRA[:-1] + b"!"}),
               vector("declared-extra-empty", {**resources, "declared-extra.bin": b""}),
               vector("original-metadata-whitespace-changed", {**resources, "meta.json": resources["meta.json"] + b" "}),
               vector("alias-spelling-changed-original-metadata", {**resources, "meta.json": resources["meta.json"].replace(b'"appearance.webp"', b'"./appearance.webp"', 1)}),
               vector("fractional-version-and-count-truncate-to-v2-three", {**resources, "meta.json": document(fractional)})]
    assert len({entry["assetDigest"] for entry in vectors[:3]}) == 1
    assert len({entry["assetDigest"] for entry in vectors[2:]}) == 6
    files = {f"collection/asset/{name}": payload for name, payload in resources.items()}
    files["collection/unrelated-neighbor.bin"] = NEIGHBOR
    files["bundled-v2-sh0.sog"] = bundle(resources)
    mutated_files, cases = case_payloads(resources)
    files.update(mutated_files)
    files["cases.json"] = document(cases)
    files["rgba-literals.json"] = document({"width": 2, "height": 2, "sourceCount": 3, "planes": PIXELS,
                                            "scalesCodebook": SCALE_BOOK, "dcCodebook": COLOR_BOOK})
    files["expected-records.json"] = document(expected_records())
    declared = [("means", 0, "positions-low.webp", True), ("means", 1, "positions-high.webp", True),
                ("means", 2, "declared-extra.bin", False), ("scales", 0, "appearance.webp", True),
                ("quats", 0, "rotations.webp", True), ("sh0", 0, "appearance.webp", True)]
    bundled = vector("bundled-archive-single-file", {"": files["bundled-v2-sh0.sog"]}, kind="single")
    files["source-key-vectors.json"] = document({"schemaVersion": 1, "scheme": "splatview-source-v1", "kindByte": 1,
        "framing": "ASCII SplatViewSource NUL v1 NUL; u8 group=1; u32be count; UTF8-sorted distinct original resource records: u8 primary, u32be pathbytes, UTF8 path, u64be original length, raw SHA25632",
        "sourceKindHintExcludedFromDigest": FORMAT, "assetRoot": "collection/asset",
        "primaryAcquiredPath": "collection/asset/meta.json", "primaryFingerprintPath": "meta.json",
        "declaredOrder": [{"group": group, "index": index, "reference": name, "fingerprintPath": name, "decoded": decoded}
                          for group, index, name, decoded in declared],
        "acquisitionCatalog": list(reversed([f"collection/asset/{name}" for name in resources] + ["collection/unrelated-neighbor.bin"])),
        "excludedAcquiredPaths": ["collection/unrelated-neighbor.bin"],
        "expectedDecodedCalls": ["positions-low.webp", "positions-high.webp", "appearance.webp", "rotations.webp", "appearance.webp"],
        "vectors": vectors, "bundledSingleFileVector": bundled})
    header = cpp_header(files, files["expected-records.json"], files["source-key-vectors.json"])
    lock = json.loads((args.repo_root / "native/SOURCE_LOCK.json").read_text(encoding="utf-8"))
    locked = {entry["path"]: entry for entry in lock["files"]}
    references = []
    for name in REFERENCE_FILES:
        payload = (args.repo_root / name).read_bytes()
        if name not in locked or sha(payload) != locked[name]["sha256"]:
            raise ValueError(f"Frozen numeric-source mismatch: {name}")
        references.append({"path": name, "bytes": len(payload), "sha256": sha(payload)})
    files["README.md"] = ("# Flat SOG v2 SH0 fixture packet\n\n"
        "Three literal sources occupy the first three pixels of2x2 lossless RGBA textures. "
        "The fourth pixel is padding, with unused overflow codebook entries and an invalid quaternion mode. "
        "One appearance resource serves both scales and DC/alpha. The declared extra is never decoded; the neighbor is excluded.\n\n"
        "Expected positions/covariances use independent Decimal80 math. Direct dyadic DC values have exact binary16 expectations; "
        "opacity uses literal alpha/255, including0 and255 endpoints. Preview source membership is exact for caps3/2/1. "
        "No SplatView loader/exporter supplies expected records. Numerical bounds cover only this small packet.\n\n"
        "`cases.json` describes byte mutations and expected source/policy outcomes, not observed runtime acceptance. "
        "Unused finite JSON64 codebook entries that overflow float32 remain allowed; sampled lookups must be finite. "
        "Negative cases retain independently valid ZIP structure/CRC. The bundled baseline adds a different single-file source key "
        "while preserving every original member byte.\n\n"
        "Generate/verify with the owned `tools/generate-sog-v2-fixtures.py`, observed Pillow12.1.0/libwebp1.6.0. "
        "Existing differing outputs are refused. The generated native header is nonshipping contract data.\n").encode("utf-8")
    files["manifest.json"] = document({"schemaVersion": 1, "packet": PACKET,
        "scope": "One three-source flat v2 SH0 independent construction/key/numeric packet; no native/App/runtime parity acceptance",
        "provenance": "Literal project RGBA pixels/codebooks; independent Decimal80 expected records; no production decoder/export results",
        "encoder": {"library": "Pillow", "version": PIL.__version__, "webpVersion": features.version("webp"),
                    "parameters": {"lossless": True, "quality": 100, "method": 6, "exact": True},
                    "verification": "Pillow2x2 RGBA roundtrip byte-equal, including transparent RGB; no SplatView codec"},
        "constructionSource": {"path": "tools/generate-sog-v2-fixtures.py", "bytes": len(Path(__file__).read_bytes()), "sha256": sha(Path(__file__).read_bytes())},
        "nativeReferences": references, "frozenPackageTreeSha256": lock["packages"]["splatview"]["treeSha256"],
        "windowsReferenceTreeSha256": lock["packages"]["windows-reference"]["treeSha256"],
        "sourceCount": 3, "shDegree": 0, "version": 2, "kind": "group", "format": FORMAT,
        "uniqueResourceCountIncludingMetadata": 6, "declaredReferenceCount": 6, "decodedTextureCalls": 5,
        "uniqueDecodedTextures": 4, "rgbaBytesPerDecode": 16, "decodedRgbaBytesAcrossCalls": 80,
        "declaredExtraCount": 1, "repeatedAliasCount": 1, "unrelatedNeighborCount": 1,
        "completeAssetDigest": original["assetDigest"], "originalTotalBytes": original["totalBytes"],
        "unusedFiniteJson64Float32OverflowEntriesPermitted": True, "onlySampledIndicesValidated": True,
        "generatedContractData": {"path": "native/wasm/sog_group_v2_contract_data.hpp", "bytes": len(header), "sha256": sha(header)},
        "bundle": {"file": "bundled-v2-sh0.sog", "bytes": len(files["bundled-v2-sh0.sog"]), "sha256": sha(files["bundled-v2-sh0.sog"]),
                   "singleFileAssetDigest": bundled["assetDigest"], "entries": sorted(resources), "compression": "ZIP_STORED",
                   "timestamp": "1980-01-01T00:00:00", "originalEntryBytesUnchanged": True},
        "caseCounts": {"total": len(cases["cases"]), "accepted": sum(entry["accepted"] for entry in cases["cases"]),
                       "refused": sum(not entry["accepted"] for entry in cases["cases"])},
        "inputs": [{"file": name, "bytes": len(payload), "sha256": sha(payload),
                    "role": "excluded-neighbor" if name.endswith("unrelated-neighbor.bin") else "primary" if name.endswith("meta.json") else "declared-resource"}
                   for name, payload in files.items() if name.startswith("collection/")],
        "artifacts": [{"file": name, "bytes": len(payload), "sha256": sha(payload)}
                      for name, payload in files.items() if not name.startswith("collection/")]})
    return files, header


def write_or_compare(filename, payload, write):
    if filename.exists():
        if filename.read_bytes() != payload:
            raise ValueError(f"Deterministic fixture differs; never overwritten: {filename}")
    elif write:
        filename.parent.mkdir(parents=True, exist_ok=True)
        with filename.open("xb") as stream:
            stream.write(payload)
    else:
        raise ValueError(f"Missing fixture: {filename}; use --write")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "tests/fixtures/sog-group-v2")
    parser.add_argument("--header", type=Path, default=ROOT / "native/wasm/sog_group_v2_contract_data.hpp")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    files, header = build_files(args)
    for name, payload in files.items():
        write_or_compare(args.output / name, payload, args.write)
    write_or_compare(args.header, header, args.write)
    manifest = json.loads(files["manifest.json"])
    print(json.dumps({"status": "passed", "scope": "Independent fixture construction and deterministic byte verification only",
                      "output": str(args.output), "files": len(files), "fixtureBytes": sum(map(len, files.values())),
                      "header": manifest["generatedContractData"], "cases": manifest["caseCounts"],
                      "sourceCount": 3, "caps": {"3": [0, 1, 2], "2": [1, 2], "1": [2]},
                      "assetDigest": manifest["completeAssetDigest"], "originalTotalBytes": manifest["originalTotalBytes"],
                      "expectedRecords": {"bytes": len(files["expected-records.json"]), "sha256": sha(files["expected-records.json"])},
                      "sourceKeys": {"bytes": len(files["source-key-vectors.json"]), "sha256": sha(files["source-key-vectors.json"])}}))


if __name__ == "__main__":
    main()
