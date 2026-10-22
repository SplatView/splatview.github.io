"""Run the frozen, existing native UI render cases into one fresh directory.

This evidence helper adds no native hooks and does not capture desktop windows.
It runs only the fixture generator and existing isolated-preference test routes.
"""

from __future__ import annotations

import ctypes
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import struct
import subprocess
import sys
import time


ROOT = Path(__file__).resolve().parents[4]
CAPTURE = ROOT / "reference/targets/windows-r0-20261012-02"
BINARIES = ROOT / ".build/r0-native-02/attempt05/Release"
OUTPUT = ROOT / ".build/native-ui-reference/r0-20261012-01"
RECEIPTS = Path(__file__).resolve().parent
PREFIX = "native-ui-reference"


def utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def identity(path: Path) -> dict:
    return {"path": str(path), "bytes": path.stat().st_size, "sha256": digest(path)}


def write_json(path: Path, value: dict) -> None:
    with path.open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2, ensure_ascii=False)
        handle.write("\n")


def inventory(path: Path) -> list[dict]:
    if not path.exists():
        return []
    result = []
    # Only this runner's fresh, explicitly owned output directory is traversed.
    for file in sorted(path.rglob("*")):
        if file.is_symlink():
            raise RuntimeError(f"Unexpected symlink in private output: {file}")
        if file.is_file():
            item = identity(file)
            item["path"] = file.relative_to(OUTPUT).as_posix()
            result.append(item)
    return result


def observer_environment() -> dict:
    result = {"platform": platform.platform(), "python": sys.version,
              "note": "DPI values describe this observer process; child test DPI is not measured."}
    if os.name == "nt":
        user = ctypes.windll.user32
        result["observerGetDpiForSystem"] = int(user.GetDpiForSystem())
        result["observerVirtualScreen"] = {str(i): int(user.GetSystemMetrics(i))
                                            for i in (76, 77, 78, 79)}
    return result


def run_case(name: str, arguments: list[str], timeout: int) -> dict:
    stdout_path = RECEIPTS / f"{PREFIX}-{name}.stdout.log"
    stderr_path = RECEIPTS / f"{PREFIX}-{name}.stderr.log"
    receipt_path = RECEIPTS / f"{PREFIX}-{name}.command.json"
    record = {"schemaVersion": 1, "case": name, "argv": arguments,
              "workingDirectory": str(OUTPUT), "startedUtc": utc(),
              "stdout": str(stdout_path), "stderr": str(stderr_path),
              "timeoutSeconds": timeout}
    print(f"START {name}: {subprocess.list2cmdline(arguments)}", flush=True)
    started = time.monotonic()
    try:
        with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
            completed = subprocess.run(arguments, cwd=OUTPUT, stdin=subprocess.DEVNULL,
                                       stdout=stdout, stderr=stderr, timeout=timeout,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
                                       check=False)
        record["exitCode"] = completed.returncode
    except Exception as error:
        record["exitCode"] = None
        record["runnerError"] = f"{type(error).__name__}: {error}"
    record["finishedUtc"] = utc()
    record["durationSeconds"] = round(time.monotonic() - started, 3)
    record["stdoutIdentity"] = identity(stdout_path) if stdout_path.exists() else None
    record["stderrIdentity"] = identity(stderr_path) if stderr_path.exists() else None
    write_json(receipt_path, record)
    for label, path in (("stdout", stdout_path), ("stderr", stderr_path)):
        if path.exists():
            text = path.read_text(encoding="utf-8", errors="replace")
            if text:
                print(f"{name} {label}:\n{text}", flush=True)
    print(f"END {name}: exit={record['exitCode']} duration={record['durationSeconds']}s", flush=True)
    return record


def main() -> int:
    if os.name != "nt":
        raise RuntimeError("These existing frozen native UI cases require Windows.")
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir()  # Exclusively fresh. Failures and partial renders are retained.
    manifest_path = CAPTURE / "CAPTURE_MANIFEST.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {item["path"]: item["sha256"] for item in manifest["files"]}
    anchors = ["tests/tools_mode_contracts.cpp", "tests/processing_ui_contracts.cpp",
               "tests/tools_workflow_contracts.cpp", "tests/tools_settings_contracts.cpp",
               "tests/tools_onboarding_contracts.cpp", "tests/tools_ui_support.cpp",
               "tests/shared_fixtures.cpp", "tests/fixture_generator.cpp", "src/main.cpp"]
    source_files = []
    for relative in anchors:
        item = identity(CAPTURE / "source" / relative)
        if item["sha256"] != expected[relative]:
            raise RuntimeError(f"Inspected source no longer matches capture manifest: {relative}")
        item["captureRelativePath"] = relative
        source_files.append(item)
    executables = {name: BINARIES / name for name in
                   ("SplatViewFixtureGenerator.exe", "SplatViewModeTests.exe", "SplatViewToolsTests.exe")}
    binary_before = {name: identity(path) for name, path in executables.items()}
    inputs = {"schemaVersion": 1, "startedUtc": utc(), "outputDirectory": str(OUTPUT),
              "runner": identity(Path(__file__).resolve()), "environment": observer_environment(),
              "sourceCapture": {"path": str(CAPTURE), "manifest": identity(manifest_path),
                                "status": identity(CAPTURE / "CAPTURE_STATUS.json"),
                                "captureId": manifest["captureId"], "product": manifest["product"],
                                "treeSha256": manifest["treeSha256"], "fileCount": manifest["fileCount"]},
              "inspectedSourceFiles": source_files, "binariesBefore": binary_before,
              "scope": "Native test-generated offscreen AppUi draw-list renders; no desktop/window screenshot or browser pairing.",
              "buildProvenanceBoundary": "Parent native build receipt binds binaries to source; this runner observes their identities.",
              "limitations": [
                  "Existing commands have hardcoded render cases; no arbitrary logical viewport, DPR, UI font preset, or camera CLI.",
                  "PNG dimensions are render pixels. Test ui.scale_ injection is distinct from observed Windows window DPI.",
                  "Default Store/workflow UI scale is not explicitly forced by these routes; do not infer DPR=1 from PNG size.",
                  "Font presets/language are test state, and this runner does not measure actual glyph/font metrics.",
                  "Camera values are not exported by these routes; Store case uses the scene-load default camera.",
                  "Draw-list helper clears a private texture and renders ImGui; scene framebuffer composition is not independently established here.",
                  "No clean empty Basic/Pro pair is produced. Settings cases follow an intentional failed scene load and use test reporting callbacks.",
                  "Workflow points/mesh captures follow scripted navigation, guide cycling, and gray-background selection.",
                  "No native/browser visual acceptance or production desktop host behavior is asserted."
              ]}
    write_json(RECEIPTS / f"{PREFIX}-inputs.json", inputs)
    fixture_directory = OUTPUT / "fixtures"
    commands = []
    commands.append(run_case("fixtures", [str(executables["SplatViewFixtureGenerator.exe"]),
                                           str(fixture_directory)], 120))
    fixture_before = inventory(fixture_directory)
    if commands[-1]["exitCode"] == 0:
        commands.append(run_case("store-assets", [str(executables["SplatViewModeTests.exe"]),
                                                   "--store-assets", str(fixture_directory),
                                                   str(OUTPUT / "store-assets")], 180))
    commands.append(run_case("workflow", [str(executables["SplatViewToolsTests.exe"]),
                                           str(OUTPUT / "workflow"), "--workflow-only"], 240))
    commands.append(run_case("settings", [str(executables["SplatViewToolsTests.exe"]),
                                           str(OUTPUT / "settings"), "--settings-only"], 240))
    fixture_after = inventory(fixture_directory)
    binary_after = {name: identity(path) for name, path in executables.items()}
    files = inventory(OUTPUT)
    images = []
    for item in files:
        if item["path"].lower().endswith(".png"):
            with (OUTPUT / item["path"]).open("rb") as handle:
                header = handle.read(24)
            if header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
                raise RuntimeError(f"Invalid PNG header: {item['path']}")
            image = dict(item)
            image["pixelWidth"], image["pixelHeight"] = struct.unpack(">II", header[16:24])
            images.append(image)
    succeeded = (len(commands) == 4 and all(case["exitCode"] == 0 for case in commands)
                 and fixture_before == fixture_after and binary_before == binary_after)
    summary = {"schemaVersion": 1, "finishedUtc": utc(), "status": "passed" if succeeded else "partial-or-failed",
               "scope": inputs["scope"], "outputDirectory": str(OUTPUT),
               "sourceCapture": inputs["sourceCapture"], "commands": commands,
               "binariesAfter": binary_after, "binariesUnchanged": binary_before == binary_after,
               "fixturesBefore": fixture_before, "fixturesAfter": fixture_after,
               "fixtureSeedUnchanged": fixture_before == fixture_after,
               "pngCount": len(images), "images": images, "outputFiles": files,
               "limitations": inputs["limitations"]}
    write_json(RECEIPTS / f"{PREFIX}-results.json", summary)
    print(json.dumps({"status": summary["status"], "pngCount": len(images),
                      "fixtureSeedUnchanged": summary["fixtureSeedUnchanged"],
                      "binariesUnchanged": summary["binariesUnchanged"],
                      "results": str(RECEIPTS / f"{PREFIX}-results.json")}, indent=2), flush=True)
    return 0 if succeeded else 1


if __name__ == "__main__":
    raise SystemExit(main())
