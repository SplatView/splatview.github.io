"""Construct/verify a small original-byte grouped SOG packet, independently.

No SplatView decoder, export, native hash or application encoder is invoked.
The external standalone encoder writes four fixed exact-RGBA lossless WebPs.
All numerical expectations use independent high-precision Decimal math; source
keys use Python hashlib and literal big-endian binary framing.
"""
from pathlib import Path
from decimal import Decimal, localcontext
import argparse
import hashlib
import json
import struct
import subprocess
import tempfile
import io
import zipfile

PACKET = "sog-group-v1"
HEADER = b"SplatViewSource\x00v1\x00"
FORMAT = "SOG v1"
PIXELS = {
    "positions-low.webp": [[0, 0, 255, 255], [0, 255, 0, 255], [255, 0, 0, 255], [42, 43, 44, 255]],
    "positions-high.webp": [[0, 128, 255, 255], [64, 191, 0, 255], [255, 0, 128, 255], [45, 46, 47, 255]],
    "appearance.webp": [[0, 128, 255, 32], [255, 64, 192, 128], [80, 160, 240, 224], [1, 2, 3, 0]],
    "rotations.webp": [[128, 128, 128, 252], [200, 32, 128, 253], [64, 191, 224, 255], [0, 0, 0, 254]],
}
META = b'''{
  "means": {
    "shape": [3, 3],
    "mins": [-1, -0.5, -0.25],
    "maxs": [1, 0.5, 0.75],
    "files": ["positions-low.webp", "positions-high.webp", "declared-extra.bin"]
  },
  "scales": {
    "mins": [-2, -1, 0],
    "maxs": [0, 1, 2],
    "files": ["appearance.webp"]
  },
  "quats": {"files": ["rotations.webp"]},
  "sh0": {
    "mins": [-1, -0.5, -2, -4],
    "maxs": [1, 1.5, 2, 4],
    "files": ["appearance.webp"]
  },
  "shN": null
}
'''
EXTRA = b"SOG declared-but-undecoded extra\x00\xff\x01\x80\n"
NEIGHBOR = b"UNRELATED: must not be opened or hashed\x00\xfe\n"
BRANCHES = (
    "native/upstream/splatview/src/core/model.cpp",
    "native/upstream/splatview/src/core/format_utils.hpp",
    "native/upstream/splatview/src/core/scene_math.cpp",
    "reference/windows/tests/shared_fixtures.cpp",
)
SH_PARITY = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1]


def digest(value):
    return hashlib.sha256(value).hexdigest()


def document(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode("utf-8")


def canonical(resources, kind="group"):
    """Literal independent v1 framing; do not import application code."""
    entries = sorted(resources.items(), key=lambda item: item[0].encode("utf-8"))
    result = bytearray(HEADER + (b"\x01" if kind == "group" else b"\x00") + struct.pack(">I", len(entries)))
    for path, payload in entries:
        name = path.encode("utf-8")
        result += b"\x01" if path == ("meta.json" if kind == "group" else "") else b"\x00"
        result += struct.pack(">I", len(name)) + name + struct.pack(">Q", len(payload))
        result += hashlib.sha256(payload).digest()
    return bytes(result)


def vector(name, resources, kind="group", **extra):
    encoded = canonical(resources, kind)
    return {
        "name": name, "scheme": "splatview-source-v1", "kind": kind,
        "sourceKindHint": FORMAT, "resourceCount": len(resources),
        "totalBytes": sum(map(len, resources.values())),
        "canonicalByteLength": len(encoded), "canonicalHex": encoded.hex(),
        "assetDigest": digest(encoded),
        "resources": [{"path": path, "role": "primary" if path == ("meta.json" if kind == "group" else "") else "referenced",
                       "byteLength": len(data), "sha256": digest(data)}
                      for path, data in sorted(resources.items(), key=lambda item: item[0].encode("utf-8"))],
        **extra,
    }


def bundle_bytes(resources):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, data in sorted(resources.items(), key=lambda item: item[0].encode("utf-8")):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.create_version = 20
            entry.extract_version = 20
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_STORED
            archive.writestr(entry, data)
    result = buffer.getvalue()
    # read() checks each independently emitted CRC, including malformed bodies.
    with zipfile.ZipFile(io.BytesIO(result)) as archive:
        assert archive.namelist() == sorted(resources, key=lambda name: name.encode("utf-8"))
        assert all(archive.read(name) == data for name,data in resources.items())
    return result


def expected_records():
    # High-precision mathematical oracle, rather than copying native float32
    # temporaries or obtaining records by opening the constructed fixture.
    with localcontext() as context:
        context.prec = 80
        D = Decimal
        positions_low = list(map(D, (-1, "-0.5", "-0.25")))
        positions_high = list(map(D, (1, "0.5", "0.75")))
        scale_low, scale_high = list(map(D, (-2, -1, 0))), list(map(D, (0, 1, 2)))
        color_low = list(map(D, (-1, "-0.5", -2, -4)))
        color_high = list(map(D, (1, "1.5", 2, 4)))
        records = []
        for source_id in range(3):
            lo, hi = PIXELS["positions-low.webp"][source_id], PIXELS["positions-high.webp"][source_id]
            appearance, packed_q = PIXELS["appearance.webp"][source_id], PIXELS["rotations.webp"][source_id]
            encoded = [positions_low[j] + D((hi[j] << 8) | lo[j]) / D(65535) *
                       (positions_high[j] - positions_low[j]) for j in range(3)]
            source_position = [(abs(v).exp() - 1).copy_sign(v) for v in encoded]
            rub_position = [source_position[0], -source_position[1], -source_position[2]]
            scales = [(scale_low[j] + D(appearance[j]) / D(255) *
                       (scale_high[j] - scale_low[j])).exp() for j in range(3)]
            dc = [color_low[j] + D(appearance[j]) / D(255) *
                  (color_high[j] - color_low[j]) for j in range(3)]
            logit = color_low[3] + D(appearance[3]) / D(255) * (color_high[3] - color_low[3])
            opacity = D(1) / (D(1) + (-logit).exp())
            missing = packed_q[3] - 252
            q = [(D(packed_q[j]) / D(255) - D("0.5")) * D("1.41421356237") for j in range(3)]
            q.insert(missing, max(D(0), D(1) - sum(v * v for v in q)).sqrt())
            norm = sum(v * v for v in q).sqrt()
            w, x, y, z = [v / norm for v in q]
            # D R diag(scale^2) R^T D, D=diag(1,-1,-1), independently.
            rotation = [[1-2*(y*y+z*z), 2*(x*y-w*z), 2*(x*z+w*y)],
                        [2*(x*y+w*z), 1-2*(x*x+z*z), 2*(y*z-w*x)],
                        [2*(x*z-w*y), 2*(y*z+w*x), 1-2*(x*x+y*y)]]
            signs = [1, -1, -1]
            covariance = [[sum(rotation[i][k] * rotation[j][k] * scales[k]**2 for k in range(3)) *
                           signs[i] * signs[j] for j in range(3)] for i in range(3)]
            half_dc = [struct.unpack("<e", struct.pack("<e", float(value)))[0] for value in dc]
            records.append({
                "sourceId": source_id, "positionRdf": list(map(float, source_position)),
                "positionRub": list(map(float, rub_position)), "linearScales": list(map(float, scales)),
                "quaternionWxyzRdf": list(map(float, q)), "opacity": float(opacity),
                "dc": list(map(float, dc)), "packedDcHalf": half_dc,
                "covarianceRub": [float(covariance[i][j]) for i,j in ((0,0),(0,1),(0,2),(1,1),(1,2),(2,2))],
                "absentShHalfBits": [0x8000 if sign < 0 else 0 for sign in SH_PARITY for _ in range(3)],
            })
        return {"schemaVersion": 1, "sourceCount": 3, "shDegree": 0, "format": FORMAT, "yUp": True,
                "allSourceIds": [0, 1, 2], "cap2SourceIds": [1, 2], "cap1SourceIds": [2],
                "fourthPixelIsNotASource": True, "records": records,
                "numericPolicy": {
                    "id": "sog-v1-sh0-small-v1",
                    "positionsAbsolute": 0.000002, "opacityAbsolute": 0.0000003,
                    "covarianceRelativeToMaxAxisVariance": 0.000008,
                    "packedDcHalf": "Exact binary16 values, including absent-band signed-zero parity",
                    "membership": "Exact source IDs/order/count; no tolerance",
                    "basis": "Decimal80 analytic unquantization, exp, sigmoid, normalized quaternion and D R S^2 R^T D; bounds cover native float32 math, not codec quantization",
                }}


def build_files(args):
    with tempfile.TemporaryDirectory(prefix="splatview-sog-encode-") as directory:
        command = [str(args.node), str(args.encoder), directory]
        print("Standalone encoder:", json.dumps(command), flush=True)
        subprocess.run(command, check=True)
        textures = {name: (Path(directory) / name).read_bytes() for name in PIXELS}
    for name, data in textures.items():
        if data[:4] != b"RIFF" or data[8:12] != b"WEBP" or len(data) != struct.unpack("<I", data[4:8])[0] + 8:
            raise ValueError(f"Malformed deterministic WebP envelope: {name}")
    resources = {"meta.json": META, **textures, "declared-extra.bin": EXTRA}
    references = [
        ("means", 0, "positions-low.webp", "positions-low.webp", True),
        ("means", 1, "positions-high.webp", "positions-high.webp", True),
        ("means", 2, "declared-extra.bin", "declared-extra.bin", False),
        ("scales", 0, "appearance.webp", "appearance.webp", True),
        ("quats", 0, "rotations.webp", "rotations.webp", True),
        ("sh0", 0, "appearance.webp", "appearance.webp", True),
    ]
    original = vector("original-complete-group", resources)
    reordered = vector("reversed-acquisition-order", dict(reversed(list(resources.items()))))
    neighbor = vector("unrelated-neighbor-bytes-changed", resources, excludedNeighborSha256=digest(NEIGHBOR + b"changed"))
    changed_extra = vector("declared-extra-last-byte-changed", {**resources, "declared-extra.bin": EXTRA[:-1] + b"!"})
    changed_meta = vector("original-metadata-whitespace-changed", {**resources, "meta.json": META + b" "})
    changed_alias = vector("alias-spelling-changed-original-metadata", {
        **resources, "meta.json": META.replace(b'"files": ["appearance.webp"]', b'"files": ["./appearance.webp"]', 1)})
    assert original["assetDigest"] == reordered["assetDigest"] == neighbor["assetDigest"]
    assert len({original["assetDigest"], changed_extra["assetDigest"], changed_meta["assetDigest"], changed_alias["assetDigest"]}) == 4
    files = {"collection/asset/" + name: data for name, data in resources.items()}
    files["collection/unrelated-neighbor.bin"] = NEIGHBOR
    acquisition_catalog = list(reversed(list(files)))
    bundle = bundle_bytes(resources)
    files["bundled-v1-sh0.sog"] = bundle
    negatives = [
        ("negative-malformed-metadata.sog", {**resources, "meta.json": b'{"means":\n'},
         "Replace only original metadata body with truncated JSON; ZIP/CRC remain valid"),
        ("negative-missing-appearance.sog", {name:data for name,data in resources.items() if name != "appearance.webp"},
         "Omit required shared scale/SH0 resource; metadata and all other bodies unchanged"),
        ("negative-truncated-webp.sog", {**resources, "positions-low.webp": resources["positions-low.webp"][:12]},
         "Retain only RIFF/WEBP twelve-byte envelope of required low-position texture; ZIP/CRC remain valid"),
    ]
    for name,bodies,_ in negatives:
        files[name] = bundle_bytes(bodies)
    bundled_key = vector("bundled-archive-single-file", {"": bundle}, kind="single")
    assert bundled_key["assetDigest"] != original["assetDigest"]
    files["rgba-literals.json"] = document({"width": 2, "height": 2, "sourceCount": 3, "planes": PIXELS})
    files["expected-records.json"] = document(expected_records())
    files["source-key-vectors.json"] = document({
        "schemaVersion": 1, "scheme": "splatview-source-v1", "kindByte": 1,
        "framing": "ASCII SplatViewSource NUL v1 NUL; u8 group=1; u32be count; UTF8-sorted distinct resource records: u8 primary, u32be pathbytes, UTF8 path, u64be original length, raw SHA25632",
        "sourceKindHintExcludedFromDigest": FORMAT, "assetRoot": "collection/asset",
        "primaryAcquiredPath": "collection/asset/meta.json", "primaryFingerprintPath": "meta.json",
        "declaredOrder": [{"group": group, "index": index, "reference": reference,
                           "fingerprintPath": path, "decoded": decoded}
                          for group,index,reference,path,decoded in references],
        "acquisitionCatalog": acquisition_catalog,
        "excludedAcquiredPaths": ["collection/unrelated-neighbor.bin"],
        "expectedDecodedCalls": ["positions-low.webp", "positions-high.webp",
                                 "appearance.webp", "rotations.webp", "appearance.webp"],
        "vectors": [original, reordered, neighbor, changed_extra, changed_meta, changed_alias],
        "bundledSingleFileVector": bundled_key,
    })
    lock = json.loads((args.repo_root / "native/SOURCE_LOCK.json").read_text(encoding="utf-8"))
    locked = {row["path"]: row for row in lock["files"]}
    branches = []
    for path in BRANCHES:
        data = (args.repo_root / path).read_bytes()
        if path not in locked or digest(data) != locked[path]["sha256"]:
            raise ValueError(f"Frozen fixture reference mismatch: {path}")
        branches.append({"path": path, "sha256": digest(data)})
    generator = args.generator.read_bytes()
    files["manifest.json"] = document({
        "schemaVersion": 1, "packet": PACKET,
        "scope": "One three-source default-v1 SH0 unpacked group; construction/key vectors only, no native/App/group ABI/SOG parity qualification",
        "provenance": "Original analytic project pixels and metadata; no decoder/export-generated expected records",
        "encoder": {"library": "libwebp", "version": "1.6.0", "toolchain": "Emscripten6.0.12",
                    "config": {"lossless": 1, "quality": 100, "method": 6, "exact": 1,
                               "near_lossless": 100, "thread_level": 0},
                    "source": "tests/fixtures/sog-group-v1/generator.cpp", "sourceSha256": digest(generator)},
        "oracle": "tools/generate-sog-fixtures.py: Python hashlib/struct binary framing and Decimal80 literal-pixel math; no application imports",
        "constructionSourceSha256": digest(Path(__file__).read_bytes()),
        "nativeReferences": branches,
        "frozenPackageTreeSha256": lock["packages"]["splatview"]["treeSha256"],
        "windowsReferenceTreeSha256": lock["packages"]["windows-reference"]["treeSha256"],
        "sourceCount": 3, "shDegree": 0, "defaultVersion": 1, "kind": "group", "format": FORMAT,
        "uniqueResourceCountIncludingMetadata": 6, "declaredReferenceCount": 6,
        "decodedTextureCalls": 5, "uniqueDecodedTextures": 4, "rgbaBytesPerDecode": 16,
        "decodedRgbaBytesAcrossCalls": 80, "declaredExtraCount": 1, "repeatedAliasCount": 1,
        "unrelatedNeighborCount": 1, "completeAssetDigest": original["assetDigest"],
        "bundle": {"file": "bundled-v1-sh0.sog", "bytes": len(bundle), "sha256": digest(bundle),
                   "singleFileAssetDigest": bundled_key["assetDigest"],
                   "entries": sorted(resources), "compression": "ZIP_STORED", "timestamp": "1980-01-01T00:00:00",
                   "originalEntryBytesUnchanged": True, "unrelatedNeighborIncluded": False},
        "negativeBundles": [{"file": name, "bytes": len(files[name]), "sha256": digest(files[name]),
                             "mutation": mutation, "zipMetadataAndCrcValid": True,
                             "expected": "Native loader refusal before replacing an edited owner; actual executable Redo remains to be tested"}
                            for name,_,mutation in negatives],
        "inputs": [{"file": path, "bytes": len(data), "sha256": digest(data),
                    "role": "excluded-neighbor" if path.endswith("unrelated-neighbor.bin") else
                            "primary" if path.endswith("meta.json") else "declared-resource"}
                   for path,data in files.items() if path.startswith("collection/")],
        "artifacts": [{"file": path, "bytes": len(data), "sha256": digest(data)}
                      for path,data in files.items() if not path.startswith("collection/")],
    })
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    base = Path(__file__).resolve().parents[1]
    parser.add_argument("--encoder", required=True, type=Path)
    parser.add_argument("--node", required=True, type=Path)
    parser.add_argument("--repo-root", default=base, type=Path)
    parser.add_argument("--generator", default=base / "tests/fixtures/sog-group-v1/generator.cpp", type=Path)
    parser.add_argument("--output", default=base / "tests/fixtures/sog-group-v1", type=Path)
    parser.add_argument("--write", action="store_true", help="Create missing owned outputs; refuse differing existing files")
    args = parser.parse_args()
    files = build_files(args)
    for name, data in files.items():
        output = args.output / name
        if output.exists():
            if output.read_bytes() != data:
                raise ValueError(f"Deterministic fixture mismatch (never overwritten): {output}")
        elif args.write:
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as target:
                target.write(data)
        else:
            raise ValueError(f"Missing fixture: {output}; use --write to create it")
        print(f"{name}: {len(data)} bytes SHA256 {digest(data)}", flush=True)
    print(f"Verified {len(files)} deterministic files; fixture asset {json.loads(files['manifest.json'])['completeAssetDigest']}", flush=True)


if __name__ == "__main__":
    main()
