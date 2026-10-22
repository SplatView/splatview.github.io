"""Independent flat SOG v1/v2 x SH1/2/3 byte fixtures and contract data.

Only Pillow/libwebp encodes literal RGBA and checks exact roundtrips. The
existing independently constructed SH0 goldens supply unchanged position,
covariance/DC/opacity values; no native decoder/exporter is called. Directional
SH goldens use endpoint dyadics or literal dyadic codebooks and Python's IEEE
binary16 packing, with the explicitly pinned RDF->RUB sign vector.
Construction does not qualify a runtime. The generated native header is
nonshipping test data; no production decoder/exporter supplies expectations.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import io
import json
import struct
import zipfile

import PIL
from PIL import Image, features


REPO = Path(__file__).resolve().parents[1]
SOURCE_HEADER = b"SplatViewSource\x00v1\x00"
SIGNS = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1]
LABELS = [0, 63, 64]
BOOK = [0.0, -0.0] + [(-1 if i & 1 else 1) * i / 8 for i in range(1, 33)] + [1e100]
OVERFLOW_INDEX = len(BOOK) - 1
BASE_NAMES = ["positions-low.webp", "positions-high.webp", "appearance.webp", "rotations.webp"]
REFERENCE_PATHS = [
    "reference/targets/windows-r0-20261012-02/source/src/model.cpp",
    "reference/targets/windows-r0-20261012-02/source/src/format_utils.hpp",
    "native/upstream/splatview/src/core/model.cpp",
    "native/upstream/splatview/src/core/format_utils.hpp",
    "native/upstream/splatview/src/core/scene_math.cpp",
    "native/upstream/splatview/third_party/spz/src/cc/splat-types.h",
    "native/deps/include/nlohmann/json.hpp",
    "native/SOURCE_LOCK.json",
    "docs/third-party/PLAYCANVAS_REFERENCES.md",
]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def document(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def tuple_for(path, data):
    return {"path": path, "bytes": len(data), "sha256": digest(data)}


def encode(rgba, width, height):
    assert len(rgba) == width * height * 4
    stream = io.BytesIO()
    Image.frombytes("RGBA", (width, height), rgba).save(
        stream, format="WEBP", lossless=True, quality=100, method=6, exact=True)
    payload = stream.getvalue()
    assert payload[:4] == b"RIFF" and payload[8:12] == b"WEBP"
    assert len(payload) == struct.unpack("<I", payload[4:8])[0] + 8
    with Image.open(io.BytesIO(payload)) as decoded:
        assert decoded.size == (width, height)
        assert decoded.convert("RGBA").tobytes() == rgba, "Every RGBA byte, including RGB under alpha0, must roundtrip"
    return payload


def zip_bytes(resources):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, data in sorted(resources.items(), key=lambda entry: entry[0].encode("utf-8")):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.create_version = entry.extract_version = 20
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_STORED
            archive.writestr(entry, data)
    data = stream.getvalue()
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        assert archive.namelist() == sorted(resources)
        assert all(archive.read(name) == body for name, body in resources.items())
    return data


def vector(name, resources, kind="group", **extra):
    entries = sorted(resources.items(), key=lambda entry: entry[0].encode("utf-8"))
    frame = bytearray(SOURCE_HEADER + bytes([kind == "group"]) + struct.pack(">I", len(entries)))
    records = []
    for path, body in entries:
        role = path == ("meta.json" if kind == "group" else "")
        utf8 = path.encode("utf-8")
        frame += bytes([role]) + struct.pack(">I", len(utf8)) + utf8
        frame += struct.pack(">Q", len(body)) + hashlib.sha256(body).digest()
        records.append({"path": path, "role": "primary" if role else "referenced",
                        "byteLength": len(body), "sha256": digest(body)})
    return {"name": name, "scheme": "splatview-source-v1", "kind": kind,
            "resourceCount": len(entries), "totalBytes": sum(map(len, resources.values())),
            "canonicalByteLength": len(frame), "canonicalHex": frame.hex(),
            "assetDigest": digest(frame), "resources": records, **extra}


def codes(version, source, coefficient):
    if version == 1:
        # A unique 9-bit endpoint signature across the three source RGB triples.
        signature = ((coefficient + 1) * 37 + 91) & 511
        return [255 if (signature >> (3 * source + channel)) & 1 else 0 for channel in range(3)]
    return [2 + ((13 * source + 5 * coefficient + 9 * channel) % 32) for channel in range(3)]


def atlas(version, degree, height=None, labels=LABELS):
    coefficients = (degree + 1) ** 2 - 1
    width = 64 * coefficients
    height = height if height is not None else (2 if version == 1 else 3)
    # v2 unused cells deliberately contain an invalid codebook index. Source
    # lookup validates only cells actually reached by loaded labels.
    fill = [0, 255, 0, 0] if version == 1 else [255, 255, 255, 0]
    rgba = bytearray(bytes(fill) * (width * height))
    for source, label in enumerate(labels):
        assert label < 64 * height
        for coefficient in range(coefficients):
            start = 4 * (label * coefficients + coefficient)
            rgba[start:start + 4] = bytes(codes(version, source, coefficient) + [(source + coefficient) % 256])
    return bytes(rgba), width, height


def label_rgba(labels=LABELS, padding=65535):
    values = list(labels) + [padding]
    # Alpha0 on source0 catches encoders which discard transparent RGB.
    return bytes(channel for source, label in enumerate(values)
                 for channel in [label & 255, label >> 8, 51 + source, [0, 17, 255, 0][source]])


def half(value):
    return struct.unpack("<H", struct.pack("<e", value))[0]


def expected(base, version, degree, value_overrides=None):
    output = copy.deepcopy(base)
    output.update({"schemaVersion": 1, "format": f"SOG v{version}", "shDegree": degree,
                   "labels": LABELS, "paletteCount": 128 if version == 1 else 65,
                   "centroidHeight": 2 if version == 1 else 3,
                   "basisSignsCoefficients1Through15": SIGNS})
    count = (degree + 1) ** 2 - 1
    signatures = []
    for record in output["records"]:
        source = record["sourceId"]
        rdf, rub, active_bits = [], [], []
        for coefficient in range(count):
            values = codes(version, source, coefficient)
            triple = []
            for channel, code in enumerate(values):
                value = (-2.0 if code == 0 else 4.0) if version == 1 else BOOK[code]
                value = (value_overrides or {}).get((source, coefficient, channel), value)
                converted = value * SIGNS[coefficient]
                triple.append(value)
                rub.append(converted)
                active_bits.append(half(converted))
            rdf.append(triple)
        dc_bits = record.get("packedDcHalfBits") or [half(value) for value in record["packedDcHalf"]]
        inactive = [0x8000 if sign < 0 else 0 for sign in SIGNS[count:] for _ in range(3)]
        full = dc_bits + active_bits + inactive
        assert len(full) == 48
        record.update({"directionalShRdf": rdf, "directionalShRub": rub,
                       "packedDcHalfBits": dc_bits, "activeDirectionalHalfBits": active_bits,
                       "inactiveDirectionalHalfBits": inactive,
                       "packedShHalfBits": full,
                       "packedShWords": [full[i] | (full[i + 1] << 16) for i in range(0, 48, 2)]})
        record.pop("absentShHalfBits", None)
        signatures.append(rdf)
    assert all(value != 0 for record in signatures for triple in record for value in triple) if not value_overrides else True
    output["numericPolicy"] = {**base["numericPolicy"], "directionalSH":
        "Exact binary16 bits: v1 endpoint dyadics -2/4; v2 direct dyadic book; explicit RDF->RUB signs. Inactive bands preserve signed-zero parity.",
        "id": f"sog-v{version}-sh{degree}-private-literal-draft-v1"}
    output["activeDirectionalHalfCount"] = 3 * count
    output["inactiveDirectionalHalfCount"] = 3 * (15 - count)
    output["fullShStorageBytes"] = 96
    return output


def assemble(repo):
    if PIL.__version__ != "12.1.0" or features.version("webp") != "1.6.0":
        raise ValueError("Deterministic construction requires observed Pillow12.1.0/libwebp1.6.0")
    outputs, packets, sources, cases, header_blobs = {}, {}, [], [], {}
    for version in (1, 2):
        original = repo / f"tests/fixtures/sog-group-v{version}"
        base = json.loads((original / "expected-records.json").read_text(encoding="utf-8"))
        meta0 = json.loads((original / "collection/asset/meta.json").read_text(encoding="utf-8"))
        literals = json.loads((original / "rgba-literals.json").read_text(encoding="utf-8"))["planes"]
        for relative in ["expected-records.json", "rgba-literals.json", "collection/asset/meta.json",
                         *["collection/asset/" + name for name in BASE_NAMES], "collection/asset/declared-extra.bin"]:
            path = original / relative
            sources.append(tuple_for(path.relative_to(repo).as_posix(), path.read_bytes()))
        for degree in (1, 2, 3):
            name = f"v{version}-sh{degree}"
            prefix = "packets/" + name + "/"
            metadata = copy.deepcopy(meta0)
            metadata["shN"] = {"files": ["centroids.webp", "labels.webp", "declared-extra.bin"]}
            if version == 1:
                metadata["shN"].update({"mins": -2, "maxs": 4})
            else:
                metadata["shN"].update({"bands": degree, "count": 65, "codebook": BOOK})
            rgba, width, height = atlas(version, degree)
            labels = label_rgba()
            resource = {"meta.json": document(metadata)}
            for body_name in BASE_NAMES:
                payload = (original / "collection/asset" / body_name).read_bytes()
                literal_bytes = bytes(channel for pixel in literals[body_name] for channel in pixel)
                with Image.open(io.BytesIO(payload)) as decoded:
                    assert decoded.size == (2, 2) and decoded.convert("RGBA").tobytes() == literal_bytes
                resource[body_name] = payload
            extra = (original / "collection/asset/declared-extra.bin").read_bytes()
            resource.update({"declared-extra.bin": extra, "centroids.webp": encode(rgba, width, height),
                             "labels.webp": encode(labels, 2, 2)})
            neighbor = b"PRIVATE higher-SH unrelated neighbor; excluded from identity\x00\xfe\n"
            for body_name, payload in resource.items():
                outputs[prefix + "collection/asset/" + body_name] = payload
                header_blobs[name + "/" + body_name] = payload
            outputs[prefix + "collection/unrelated-neighbor.bin"] = neighbor
            archive = zip_bytes(resource)
            outputs[prefix + "bundled.sog"] = archive
            header_blobs[name + "/bundled.sog"] = archive
            records = expected(base, version, degree)
            outputs[prefix + "expected-records.json"] = document(records)
            outputs[prefix + "centroids.rgba"] = rgba
            outputs[prefix + "labels.rgba"] = labels
            outputs[prefix + "rgba-literals.json"] = document({"basePlanes": literals,
                "centroidWidth": width, "centroidHeight": height, "coefficients": (degree + 1) ** 2 - 1,
                "literalLabels": [list(labels[i:i + 4]) for i in range(0, 16, 4)],
                "loadedCentroidCodes": [[codes(version, source, c) for c in range((degree + 1) ** 2 - 1)] for source in range(3)],
                "v1ScalarBounds": [-2, 4] if version == 1 else None, "v2Codebook": BOOK if version == 2 else None,
                "fullCentroidRgba": tuple_for(prefix + "centroids.rgba", rgba),
                "unreferencedCentroidFillRgba": [0, 255, 0, 0] if version == 1 else [255, 255, 255, 0]})
            vectors = [vector("original-complete-group", resource),
                vector("reversed-acquisition-order", dict(reversed(list(resource.items())))),
                vector("unrelated-neighbor-mutated", resource, excludedNeighborSha256=digest(neighbor + b"changed")),
                vector("declared-extra-last-byte-changed", {**resource, "declared-extra.bin": extra[:-1] + b"!"}),
                vector("declared-extra-empty", {**resource, "declared-extra.bin": b""}),
                vector("metadata-whitespace-changed", {**resource, "meta.json": resource["meta.json"] + b" "})]
            assert len({v["assetDigest"] for v in vectors[:3]}) == 1
            assert len({v["assetDigest"] for v in vectors[2:]}) == 4
            declared = [{"group": group, "index": i, "reference": path,
                         "decoded": i < (2 if group in ("means", "shN") else 1)}
                        for group in ("means", "scales", "quats", "sh0", "shN")
                        for i, path in enumerate(metadata[group]["files"])]
            keys = {"schemaVersion": 1, "scheme": "splatview-source-v1", "declaredOrder": declared,
                    "expectedDecodedCalls": ["positions-low.webp", "positions-high.webp", "appearance.webp",
                        "rotations.webp", "appearance.webp", "centroids.webp", "labels.webp"],
                    "vectors": vectors, "excludedAcquiredPaths": ["collection/unrelated-neighbor.bin"],
                    "bundledSingleFileVector": vector("bundled-single-file", {"": archive}, kind="single")}
            outputs[prefix + "source-key-vectors.json"] = document(keys)
            packets[name] = {"version": version, "degree": degree, "metadata": metadata,
                "resource": resource, "rgba": rgba, "width": width, "height": height,
                "labels": labels, "baseExpected": base, "expected": records, "keys": keys}

    def add(name, packet="v2-sh1", changes=None, replacements=None, accepted=False,
            caps=None, reason="", value_overrides=None, policy="captured-desktop"):
        base_packet = packets[packet]
        metadata = copy.deepcopy(base_packet["metadata"])
        if changes:
            metadata["shN"].update(changes)
        resources = {**base_packet["resource"], "meta.json": document(metadata)}
        resource_changes = []
        for body_name, payload in (replacements or {}).items():
            resources[body_name] = payload
            override_path = "cases/" + name + "/" + body_name
            outputs[override_path] = payload
            header_blobs["case/" + name + "/" + body_name] = payload
            resource_changes.append({"path": body_name, "file": override_path, "bytes": len(payload), "sha256": digest(payload)})
        metadata_path = "cases/" + name + "/meta.json"
        outputs[metadata_path] = resources["meta.json"]
        header_blobs["case/" + name + "/meta.json"] = resources["meta.json"]
        archive_path = "cases/" + name + "/bundled.sog"
        outputs[archive_path] = zip_bytes(resources)
        caps = caps or {"3": accepted, "2": accepted, "1": accepted}
        row = {"name": name, "packet": packet, "metadata": metadata_path, "bundle": archive_path,
               "acceptanceByCap": caps, "expectedSourceIdsByCap": {"3": [0, 1, 2], "2": [1, 2], "1": [2]},
               "reason": reason, "policyAuthority": policy, "resourceChanges": resource_changes,
               "sourceKey": vector(name, resources)}
        if value_overrides:
            changed = expected(base_packet["baseExpected"], base_packet["version"], base_packet["degree"], value_overrides)
            row["expectedRecordsOverride"] = "cases/" + name + "/expected-records.json"
            outputs[row["expectedRecordsOverride"]] = document(changed)
        cases.append(row)

    # Structural header failures precede any decode/publication.
    for packet in ("v1-sh1", "v2-sh1"):
        p = packets[packet]
        invalid_width = p["width"] - 1
        cropped = b"".join(p["rgba"][row * p["width"] * 4:row * p["width"] * 4 + invalid_width * 4] for row in range(p["height"]))
        add(packet + "-centroid-width", packet, replacements={"centroids.webp": encode(cropped, invalid_width, p["height"])}, reason="Centroid width must be64*coefficientCount")
        add(packet + "-label-dimensions", packet, replacements={"labels.webp": encode(bytes([0, 0, 0, 0]) * 4, 4, 1)}, reason="Label dimensions must equal base position plane dimensions")
        add(packet + "-invalid-header", packet, replacements={"centroids.webp": b"RIFF\x04\0\0\0WEBP"}, reason="Invalid WebP header is refused before decoded plane allocation")
        bad = bytearray(p["labels"]); bad[0:2] = bytes([255, 255])
        add(packet + "-bad-source0-label", packet, replacements={"labels.webp": encode(bytes(bad), 2, 2)},
            caps={"3": False, "2": True, "1": True}, reason="Out-of-palette source0 label fails only when sampled; cap2/cap1 omit source0")
        ignored = bytearray(p["labels"])
        for i in range(4): ignored[4*i+2:4*i+4] = bytes([255-i, 0])
        add(packet + "-ignored-label-ba", packet, replacements={"labels.webp": encode(bytes(ignored), 2, 2)}, accepted=True, reason="Label B/A channels do not participate in palette lookup")
        alpha = bytearray(p["rgba"])
        for i in range(3, len(alpha), 4): alpha[i] = (i * 17) & 255
        add(packet + "-ignored-centroid-alpha", packet, replacements={"centroids.webp": encode(bytes(alpha), p["width"], p["height"])}, accepted=True, reason="Centroid alpha is ignored; transparent RGB still roundtrips exactly")

    big, w, h = atlas(1, 1, height=1025)
    add("v1-palette-height-over-limit", "v1-sh1", replacements={"centroids.webp": encode(big, w, h)}, reason="Legacy height1025 derives palette65600>65536")
    for name, value in [("boolean", True), ("string", "65"), ("zero", 0), ("negative", -1), ("oversized", 65537), ("insufficient-capacity", 193)]:
        add("v2-palette-" + name, changes={"count": value}, reason="Desktop numeric size_t64 conversion and palette/capacity guard", policy="captured-Windows-size_t64; WASM bool coercion must not broaden desktop acceptance")
    add("v2-palette-fraction", changes={"count": 65.9}, accepted=True, reason="Numeric palette65.9 truncates to65")
    add("v2-bands-boolean", changes={"bands": True}, accepted=True, reason="Captured unsigned generic JSON conversion maps true toSH1")
    add("v2-bands-fraction", changes={"bands": 1.9}, accepted=True, reason="Numeric bands1.9 truncates toSH1")
    for name, value in [("zero", 0), ("four", 4), ("string", "1")]:
        add("v2-bands-" + name, changes={"bands": value}, reason="Unsupported SH degree or invalid numeric conversion")
    for name, book in [("empty", []), ("oversized", [1] * 257), ("unused-string", BOOK[:-1] + ["bad"])]:
        add("v2-book-" + name, changes={"codebook": book}, reason="Codebook must have1..256 numeric/bool-convertible entries even if a bad type is unused")
    add("v2-unused-f32overflow-book", changes={"codebook": BOOK[:-1] + [-1e100]}, accepted=True, reason="Unused finite JSON64 value may overflow float32; no blanket finiteness rejection")
    p = packets["v2-sh1"]
    for name, code in [("invalid-index", 255), ("f32overflow", OVERFLOW_INDEX)]:
        bad = bytearray(p["rgba"]); bad[0] = code
        add("v2-source0-" + name, replacements={"centroids.webp": encode(bytes(bad), p["width"], p["height"])},
            caps={"3": False, "2": True, "1": True}, reason="Bad source0 centroid RGB lookup is refused only when its source is sampled")
    # Zero book entries are used explicitly only in this companion case; all
    # canonical directional coefficients remain nonzero.
    p = packets["v2-sh3"]
    zero = bytearray(p["rgba"]); zero[0], zero[1] = 0, 1
    add("v2-sh3-used-signed-zeros", "v2-sh3", replacements={"centroids.webp": encode(bytes(zero), p["width"], p["height"])},
        accepted=True, value_overrides={(0, 0, 0): 0.0, (0, 0, 1): -0.0}, reason="Positive/negative RDF zeros acquire opposite RUB signs and exact binary16 sign bits")
    # Max palette uses SH1 to keep the independent full RGBA construction<1MiB.
    max_labels = [0, 65535, 64]
    maximum, width, height = atlas(2, 1, height=1025, labels=max_labels)
    add("v2-palette65536-with-extra-row", changes={"count": 65536}, accepted=True,
        replacements={"centroids.webp": encode(maximum, width, height), "labels.webp": encode(label_rgba(max_labels), 2, 2)},
        reason="Maximum16-bit palette index65535 accepted;1025rows include an unused extra row; source1 retains its independently assigned values")

    packet_rows = [{"name": name, "version": p["version"], "shDegree": p["degree"],
                   "sourceCount": 3, "paletteCount": 128 if p["version"] == 1 else 65,
                   "centroidWidth": p["width"], "centroidHeight": p["height"],
                   "originalResources": 8, "declaredReferences": 9, "decodedCalls": 7, "uniqueDecodedResources": 6,
                   "decodedRgbaBytes": 96 + len(p["rgba"]),
                   "assetDigest": p["keys"]["vectors"][0]["assetDigest"],
                   "originalTotalBytes": p["keys"]["vectors"][0]["totalBytes"],
                   "expectedRecords": tuple_for("packets/" + name + "/expected-records.json", outputs["packets/" + name + "/expected-records.json"])}
                   for name, p in packets.items()]
    outputs["cases.json"] = document({"schemaVersion": 1, "scope": "Expected source/policy behavior; not observed runtime acceptance", "cases": cases})
    outputs["packets.json"] = document({"schemaVersion": 1, "packets": packet_rows})
    aggregate_expected = {"schemaVersion": 1, "packets": {name: p["expected"] for name, p in packets.items()},
        "caseOverrides": {case["name"]: json.loads(outputs[case["expectedRecordsOverride"]])
                          for case in cases if "expectedRecordsOverride" in case}}
    aggregate_keys = {"schemaVersion": 1, "packets": {name: p["keys"] for name, p in packets.items()}}
    outputs["expected-records.json"] = document(aggregate_expected)
    outputs["source-key-vectors.json"] = document(aggregate_keys)
    lines = ["// Independent literal SOG v1/v2 SH1..3 nonshipping contract data; construction is not runtime acceptance.",
             "// Generator: tools/generate-sog-sh-fixtures.py SHA256 " + digest(Path(__file__).read_bytes()),
             "#pragma once", "#include <cstdint>", "#include <span>"]
    bindings = []
    for i, (path, body) in enumerate(sorted(header_blobs.items())):
        symbol = "sogShDraftBlob" + str(i)
        lines += ["// " + path + " SHA256 " + digest(body),
                  "inline constexpr uint8_t " + symbol + "[]={" + ",".join(map(str, body)) + "};"]
        bindings.append({"name": symbol, "path": path, "bytes": len(body), "sha256": digest(body)})
    lines.append("inline constexpr std::span<const uint8_t> sogShDraftBlobs[]={" +
                 ",".join(binding["name"] for binding in bindings) + "};")
    outputs["header-bindings.json"] = document({"schemaVersion": 1, "blobs": bindings})
    for symbol, path in [("sogShDraftExpected", "expected-records.json"), ("sogShDraftKeys", "source-key-vectors.json"),
                         ("sogShDraftCases", "cases.json"), ("sogShDraftBindings", "header-bindings.json")]:
        text = outputs[path].decode("utf-8")
        assert ')SOGSH"' not in text
        lines += ['inline constexpr char ' + symbol + '[]=R"SOGSH(' + text + ')SOGSH";']
    outputs["generated/sog_sh_contract_data.hpp"] = ("\n".join(lines) + "\n").encode("utf-8")
    outputs["README.md"] = ("# Independent unpacked SOG higher-SH fixtures\n\n"
        "Six independent v1/v2 x SH1/2/3 packets use three sources in2x2 base planes. Labels0/63/64 span centroid rows. "
        "Legacy palettes derive128 entries from2rows; v2 declares65 entries with3rows. The seven decode roles use6distinct compressed textures "
        "because scale/DC alias appearance. One extra is declared twice, staged/hashed once; the unrelated neighbor is excluded.\n\n"
        "Unchanged base WebP bytes and independently constructed SH0 goldens are copied/cited from the existing literal packets. "
        "Directional SH expected values come solely from explicit endpoint/dyadic literals, the pinned15sign vector and Python IEEEbinary16. "
        "No production decoder/exporter or platform oracle supplies these expectations. All canonical directional RGB values are nonzero; "
        "the companion signed-zero case verifies both signs. Inactive bands retain source signed-zero parity in the full48-half storage.\n\n"
        "cases.json lists intended captured-source/policy outcomes at caps3/2/1, not observed native/browser results. "
        "Palette booleans are desktopWindows64 refusals despite WASM32 JSON conversion differences. Fractional65.9palette, "
        "1.9bands and truebands remain source-compatible. Only sampled labels/referenced centroid values must be valid; ignoredBA/alpha, "
        "padding, unreferenced cells and unused float32-overflow book entries are preserved.\n\n"
        "Generate with tools/generate-sog-sh-fixtures.py --write, verify without --write. Existing differing outputs are never overwritten. "
        "The native/wasm/sog_sh_contract_data.hpp header contains only independently constructed contract data. "
        "Fixture construction and byte verification do not establish native/browser runtime qualification.\n").encode("utf-8")
    references = [tuple_for(path, (repo / path).read_bytes()) for path in REFERENCE_PATHS]
    manifest = {"schemaVersion": 1, "kind": "independent-sog-higher-sh-fixture-construction",
        "qualification": "Construction/byte verification only; no runtime/native/browser acceptance",
        "constructionSource": tuple_for("tools/generate-sog-sh-fixtures.py", Path(__file__).read_bytes()),
        "encoder": {"Pillow": PIL.__version__, "libwebp": features.version("webp"),
            "lossless": True, "quality": 100, "method": 6, "exact": True,
            "roundtrip": "Every encoded full RGBA plane byte-equal, including transparent RGB"},
        "baseIndependentInputs": sources, "localSourceAndFormatContext": references,
        "formatContextAuthority": "PLAYCANVAS_REFERENCES.md supplies pinned citation context only; desktop source is math authority",
        "packets": packet_rows, "caseCounts": {"total": len(cases),
            "acceptedAtAllCaps": sum(all(case["acceptanceByCap"].values()) for case in cases),
            "refusedAtAllCaps": sum(not any(case["acceptanceByCap"].values()) for case in cases),
            "sampleDependent": sum(any(case["acceptanceByCap"].values()) and not all(case["acceptanceByCap"].values()) for case in cases)},
        "generatedContractData": tuple_for("native/wasm/sog_sh_contract_data.hpp", outputs["generated/sog_sh_contract_data.hpp"]),
        "artifacts": [tuple_for(path, body) for path, body in sorted(outputs.items())
                      if path != "generated/sog_sh_contract_data.hpp"]}
    outputs["manifest.json"] = document(manifest)
    return outputs, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=REPO)
    parser.add_argument("--output", type=Path, default=REPO / "tests/fixtures/sog-group-sh")
    parser.add_argument("--header", type=Path, default=REPO / "native/wasm/sog_sh_contract_data.hpp")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    args.repo_root = args.repo_root.resolve()
    args.output = args.output.resolve()
    args.header = args.header.resolve()
    if args.report and args.report.exists():
        raise ValueError("Refuse report overwrite: " + str(args.report))
    files, manifest = assemble(args.repo_root.resolve())
    header = files.pop("generated/sog_sh_contract_data.hpp")
    targets = [(args.output / path, body) for path, body in files.items()] + [(args.header, header)]
    # Compare EVERY existing leaf before writing ANY missing leaf. This avoids
    # partially extending a differing generated packet.
    for target, body in targets:
        if target.exists() and target.read_bytes() != body:
            raise ValueError("Deterministic output differs; refused overwrite: " + str(target))
        if not target.exists() and not args.write:
            raise ValueError("Missing output; use --write: " + str(target))
    if args.write:
        for target, body in targets:
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open("xb") as stream: stream.write(body)
    report = {"status": "passed", "scope": manifest["qualification"],
        "mode": "construct-and-compare" if args.write else "compare-only",
        "files": len(files), "fixtureBytes": sum(map(len, files.values())), "headerBytes": len(header),
        "packets": len(manifest["packets"]), "cases": manifest["caseCounts"],
        "manifest": tuple_for((args.output / "manifest.json").relative_to(args.repo_root).as_posix(), files["manifest.json"]),
        "header": tuple_for(args.header.relative_to(args.repo_root).as_posix(), header),
        "expected": tuple_for((args.output / "expected-records.json").relative_to(args.repo_root).as_posix(), files["expected-records.json"]),
        "keys": tuple_for((args.output / "source-key-vectors.json").relative_to(args.repo_root).as_posix(), files["source-key-vectors.json"])}
    if args.report:
        with args.report.open("xb") as stream: stream.write(document(report))
    print(json.dumps(report))


if __name__ == "__main__":
    main()
