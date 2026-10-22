"""End-to-end contracts for the installed-style command line interface."""
from pathlib import Path
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import zipfile

exe = Path(sys.argv[1]).resolve()
work_parent = Path(sys.argv[2]).resolve()
work_parent.mkdir(parents=True, exist_ok=True)

with tempfile.TemporaryDirectory(prefix="cli-", dir=work_parent) as folder:
    work = Path(folder)
    env = dict(os.environ, SPLATVIEW_DATA_DIR=str(work / "preferences"))

    def run(*args, ok=True):
        result = subprocess.run([str(exe), *map(str, args)], cwd=work, env=env,
                                capture_output=True, encoding="utf-8", timeout=60)
        if (result.returncode == 0) != ok:
            raise AssertionError(f"Unexpected exit {result.returncode}: {args}\n{result.stdout}\n{result.stderr}")
        return result

    def inspect(path):
        return json.loads(run("--inspect", path).stdout)

    run("--help")
    source = work / "scène-日本-🌍.ply"
    run("--demo", source)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    info = inspect(source)
    assert info["sourceSplats"] == 2160 and info["editable"]
    pipeline = work / "pipeline.json"
    pipeline.write_text(json.dumps({"steps": [
        {"type": "color", "values": {"brightness": 1.1}},
        {"type": "transform", "values": {"translation": [0.1, 0, 0]}}
    ]}), encoding="utf-8")
    for suffix in ("ply", "compressed.ply", "spz", "splat", "ksplat", "sog", "sogs", "csv"):
        output = work / ("edited." + suffix)
        json.loads(run("--process", source, "--recipe", pipeline, "--output", output).stdout)
        assert output.stat().st_size > 30
        if suffix != "csv":
            assert inspect(output)["sourceSplats"] == 2160
    png = work / "capture.png"
    result = json.loads(run("--thumbnail", source, "--output", png, "--size", 128, "--software").stdout)
    assert result["renderer"] == "software"
    raw = png.read_bytes()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", raw[16:24]) == (128, 128)
    jpeg = work / "capture.jpg"
    run("--thumbnail", work / "edited.spz", "--output", jpeg, "--size", 64)
    assert jpeg.read_bytes().startswith(b"\xff\xd8")
    run("--thumbnail", source, "--output", png, "--size", "2049", ok=False)
    run("--thumbnail", source, "--output", png, "--size", "-1", ok=False)
    run("--inspect", source, "--unknown", "value", ok=False)
    run("--process", source, "--recipe", pipeline, "--output", source, ok=False)
    run("--inspect", source, "--output", source, ok=False)
    run("--thumbnail", source, "--output", source, ok=False)
    run("--process", source, "--output", png, ok=False)
    pipeline.write_text('{"type":"invalid-step"}', encoding="utf-8")
    previous = png.read_bytes()
    run("--process", source, "--recipe", pipeline, "--output", png, ok=False)
    assert png.read_bytes() == previous
    unpacked = work / "unpacked"
    unpacked.mkdir()
    with zipfile.ZipFile(work / "edited.sog") as bundle:
        bundle.extractall(unpacked)
    assert inspect(unpacked)["sourceSplats"] == 2160
    assert inspect(unpacked / "meta.json")["sourceSplats"] == 2160
    meta = (unpacked / "meta.json").read_bytes()
    run("--inspect", unpacked, "--output", unpacked / "meta.json", ok=False)
    assert (unpacked / "meta.json").read_bytes() == meta
    alias = work / "alias.ply"
    try:
        os.link(source, alias)
    except OSError:
        pass
    else:
        run("--inspect", source, "--output", alias, ok=False)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
print("PASS CLI: Unicode, eight exporters, CPU PNG/JPEG, unpacked SOG, aliases and failed-output preservation")
