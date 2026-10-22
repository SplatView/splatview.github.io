#!/usr/bin/env python3
"""Audit the final R0 contract inventory against fixed, read-only inputs.

Run from any directory with --output NEW_REPORT.json. The sole write is an
exclusive-create JSON report; existing reports are never replaced. This checks
source binding and fixture-spec status, not native/browser/Mac acceptance. It
reads only the files listed below and never discovers source files by walking a
directory. The capture's full-tree digest is checked as recorded metadata, not
recomputed from all 720 captured files.
"""

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[4]
CSV_PATH = "docs/parity/current-target-deltas-v1.csv"
MD_PATH = "docs/parity/current-target-deltas-v1.md"
CAPTURE = "reference/targets/windows-r0-20261012-02"
SOURCE = CAPTURE + "/source"
MANIFEST_PATH = CAPTURE + "/CAPTURE_MANIFEST.json"
STATUS_PATH = CAPTURE + "/CAPTURE_STATUS.json"
CMAKE_PATH = SOURCE + "/CMakeLists.txt"
TARGET_VERSION = "0.12.116"
SNAPSHOT = "windows-r0-20261012-02"
CAPTURE_ID = "cc71f0df-8f38-4900-8aff-5c9ee0d6814c"
TREE_SHA256 = "162c4bb2b129dc49169b3678e21b1b607a13bfd249f75cb1a2b3a5b7e8e9a2f4"
CMAKE_SHA256 = "7255cf561615136a965a7b37dc6d88aba5020dde9109a213a575b45d0de724cd"
PINNED_SHA256 = {
    CSV_PATH: "0cae65c140e11a8bfe48e9713dd6addd6fc80182825094c58fc6f121134198bf",
    MD_PATH: "d4e6a5351abf8b01bb6214d5c4b659e244bac8d9f2390fd9858dcde5c0ab50f5",
    MANIFEST_PATH: "0156c58d345ecf633d57a0ff339c8c07a270efb0575e6158e49d7d0840678fe4",
    CMAKE_PATH: CMAKE_SHA256,
}
FIELDS = (
    "inventory_version", "target_version", "source_snapshot", "source_tree_sha256",
    "target_cmake_sha256", "contract_id", "area", "delta_kind", "source_path",
    "source_line", "source_symbol", "source_sha256", "supporting_anchors",
    "baseline_reference", "basic_available", "pro_available", "enabled_rule",
    "desktop_contract", "browser_boundary", "fixture_id", "fixture_spec",
    "acceptance_criteria", "review_status", "native_acceptance",
    "browser_implementation_status", "browser_acceptance", "mac_acceptance", "notes",
)
CURRENT_FILES = (
    "src/alignment_ui.cpp", "src/app_ui.cpp", "src/app_ui_about.cpp",
    "src/app_ui_default_apps.cpp", "src/app_ui_settings.cpp", "src/app_ui_tutorial.cpp",
    "src/camera.cpp", "src/commands.hpp", "src/editing.cpp", "src/editing.hpp",
    "src/geometry_tools.cpp", "src/main.cpp", "src/processing.cpp",
    "src/processing_ui.cpp", "src/save_dialog.cpp", "src/scene_export_formats.hpp",
    "src/scene_exports.cpp", "src/selection_morphology.cpp", "src/selection_morphology.hpp",
    "src/selection_ui.cpp", "src/tools_preferences.cpp", "src/tutorial.hpp",
    "src/ui_size.hpp", "src/viewer.cpp", "src/viewer.hpp", "src/viewer_processing.cpp",
    "src/viewer_selection.cpp", "src/viewport_tools.cpp", "src/viewport_tools.hpp",
)
HISTORICAL_FILES = (
    "reference/windows/src/alignment_ui.cpp", "reference/windows/src/app_ui_settings.cpp",
    "reference/windows/src/app_ui_tutorial.cpp", "reference/windows/src/camera.cpp",
    "reference/windows/src/geometry_tools.cpp", "reference/windows/src/processing.cpp",
    "reference/windows/src/processing_ui.cpp", "reference/windows/src/scene_export_formats.hpp",
    "reference/windows/src/tools_preferences.cpp", "reference/windows/src/tutorial.hpp",
    "reference/windows/src/viewer.cpp", "reference/windows/src/viewport_tools.cpp",
    "reference/windows/src/viewport_tools.hpp",
)
EXPECTED_LINKS = (
    "current-target-deltas-v1.csv", "../../" + SOURCE, "../../" + CMAKE_PATH,
    "../../src/ui/App.tsx", "../../src/app/controller.ts", "../../src/app/store.ts",
    "../../src/document/coreClient.ts", "../../src/document/types.ts",
)
EXPECTED_ROW_VALUES = {
    "inventory_version": "1-current-target-deltas",
    "target_version": TARGET_VERSION,
    "source_snapshot": SNAPSHOT,
    "source_tree_sha256": TREE_SHA256,
    "target_cmake_sha256": CMAKE_SHA256,
    "review_status": "source-reviewed;snapshot-bound;fixture-spec-only",
    "native_acceptance": "pending;not-run",
    "browser_implementation_status": "not-assessed-in-R0",
    "browser_acceptance": "pending;not-run",
    "mac_acceptance": "pending;not-run",
}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def audit():
    errors = []
    observed_inputs = {}

    def check(condition, detail):
        if not condition:
            errors.append(detail)

    def read_fixed(relative_path):
        try:
            data = (ROOT / relative_path).read_bytes()
        except OSError as exc:
            errors.append(f"Cannot read fixed input {relative_path}: {exc}")
            return b""
        observed_inputs[relative_path] = {"bytes": len(data), "sha256": sha256(data)}
        if relative_path in PINNED_SHA256:
            check(sha256(data) == PINNED_SHA256[relative_path],
                  f"Pinned digest mismatch: {relative_path}")
        return data

    def decode(data, relative_path):
        try:
            return data.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            errors.append(f"Invalid UTF-8 in {relative_path}: {exc}")
            return ""

    def read_json(relative_path):
        try:
            value = json.loads(decode(read_fixed(relative_path), relative_path))
            if not isinstance(value, dict):
                raise ValueError("top level must be an object")
            return value
        except (ValueError, TypeError) as exc:
            errors.append(f"Invalid JSON in {relative_path}: {exc}")
            return {}

    csv_text = decode(read_fixed(CSV_PATH), CSV_PATH)
    md_text = decode(read_fixed(MD_PATH), MD_PATH)
    manifest = read_json(MANIFEST_PATH)
    capture_status = read_json(STATUS_PATH)
    cmake_text = decode(read_fixed(CMAKE_PATH), CMAKE_PATH)

    project = re.search(r"project\(\s*(\S+)\s+VERSION\s+([0-9.]+)\b", cmake_text)
    observed_project = {"name": project.group(1), "version": project.group(2)} if project else None
    check(observed_project == {"name": "SplatView", "version": TARGET_VERSION},
          "CMake project identity mismatch")
    check(manifest.get("schemaVersion") == 1 and capture_status.get("schemaVersion") == 1,
          "Capture metadata schema mismatch")
    for label, value in (("manifest", manifest), ("status", capture_status)):
        check(value.get("kind") == "splatview-windows-source-capture", f"{label}: kind mismatch")
        check(value.get("captureId") == CAPTURE_ID, f"{label}: capture ID mismatch")
        check(value.get("treeSha256") == TREE_SHA256, f"{label}: tree identity mismatch")
    check(manifest.get("product") == {
        "name": "SplatView", "version": TARGET_VERSION, "versionSource": "CMakeLists.txt"
    }, "Manifest product identity mismatch")
    check(capture_status.get("state") == "complete", "Capture status is not complete")
    check(capture_status.get("manifestSha256") == observed_inputs.get(MANIFEST_PATH, {}).get("sha256"),
          "Capture status does not bind the observed manifest digest")

    entries = manifest.get("files", [])
    if not isinstance(entries, list):
        errors.append("Manifest files must be an array")
        entries = []
    index = {}
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            errors.append("Malformed manifest file entry")
            continue
        check(entry["path"] not in index, f"Duplicate manifest file: {entry['path']}")
        index[entry["path"]] = entry
    check(len(entries) == manifest.get("fileCount") == 720, "Manifest file count mismatch")

    current_paths = {SOURCE + "/" + name for name in CURRENT_FILES}
    historical_paths = set(HISTORICAL_FILES)
    line_counts = {}
    current_results = []
    historical_results = []
    for name in CURRENT_FILES:
        path = SOURCE + "/" + name
        data = read_fixed(path)
        line_counts[path] = len(decode(data, path).splitlines())
        entry = index.get(name, {})
        matches = sha256(data) == entry.get("sha256") and len(data) == entry.get("bytes")
        check(matches, f"Captured source differs from manifest: {path}")
        current_results.append({"path": path, "sha256": sha256(data), "bytes": len(data),
                                "lines": line_counts[path], "manifest_match": matches})
    cmake_input = observed_inputs.get(CMAKE_PATH, {})
    check(index.get("CMakeLists.txt", {}).get("sha256") == cmake_input.get("sha256")
          and index.get("CMakeLists.txt", {}).get("bytes") == cmake_input.get("bytes"),
          "CMake file differs from manifest")
    for path in HISTORICAL_FILES:
        data = read_fixed(path)
        line_counts[path] = len(decode(data, path).splitlines())
        historical_results.append({"path": path, "lines": line_counts[path], "sha256": sha256(data)})

    fields, rows = [], []
    try:
        reader = csv.DictReader(io.StringIO(csv_text, newline=""), strict=True)
        fields = reader.fieldnames or []
        rows = list(reader)
    except csv.Error as exc:
        errors.append(f"Invalid CSV: {exc}")
    check(tuple(fields) == FIELDS, "CSV header does not match the ordered 28-field schema")
    check(len(rows) == 32 and len(fields) == 28, "CSV must contain 32 records and 28 fields")
    uniqueness = {}
    for key in ("contract_id", "fixture_id"):
        values = [row.get(key) for row in rows]
        uniqueness[key] = {"values": len(values), "unique": len(set(values))}
        check(len(set(values)) == len(rows), f"Duplicate {key}")

    counts = {"primary_anchors": 0, "supporting_anchors": 0, "historical_anchors": 0,
              "valid_primary_anchors": 0, "valid_supporting_anchors": 0,
              "valid_historical_anchors": 0}
    used_current, used_historical = set(), set()
    status_counts = {key: 0 for key in EXPECTED_ROW_VALUES}

    def anchor(path, line, allowed, counter, row_label):
        counts[counter] += 1
        if path not in allowed:
            errors.append(f"{row_label}: anchor outside fixed allowlist: {path}")
            return
        if counter == "historical_anchors":
            used_historical.add(path)
        else:
            used_current.add(path)
        if not isinstance(line, str) or not line.isdecimal() or not 1 <= int(line) <= line_counts[path]:
            errors.append(f"{row_label}: anchor line out of range: {path}:{line}")
            return
        counts["valid_" + counter] += 1

    for number, row in enumerate(rows, start=2):
        label = f"CSV line {number} ({row.get('contract_id')})"
        if None in row or any(not isinstance(value, str) or value == "" for value in row.values()):
            errors.append(f"{label}: missing, empty or extra field")
            continue
        for key, expected in EXPECTED_ROW_VALUES.items():
            matched = row.get(key) == expected
            status_counts[key] += int(matched)
            check(matched, f"{label}: unexpected {key}")
        path = row.get("source_path", "")
        anchor(path, row.get("source_line", ""), current_paths, "primary_anchors", label)
        if path in current_paths:
            check(row.get("source_sha256") == observed_inputs.get(path, {}).get("sha256"),
                  f"{label}: primary source digest mismatch")
        for key, allowed, counter in (
            ("supporting_anchors", current_paths, "supporting_anchors"),
            ("baseline_reference", historical_paths, "historical_anchors"),
        ):
            for value in row.get(key, "").split(";"):
                if value in ("not-assessed", "not-applicable"):
                    continue
                if ":" not in value:
                    counts[counter] += 1
                    errors.append(f"{label}: malformed {key} anchor: {value}")
                    continue
                path, line = value.rsplit(":", 1)
                anchor(path, line, allowed, counter, label)

    counts.update({"rows": len(rows), "fields": len(fields),
                   "supporting_and_historical_anchors": counts["supporting_anchors"] + counts["historical_anchors"],
                   "current_anchor_files": len(used_current), "historical_anchor_files": len(used_historical),
                   "current_files_hashed": len(current_results),
                   "current_manifest_hash_matches": sum(item["manifest_match"] for item in current_results),
                   "manifest_file_entries": len(entries)})
    check(counts["primary_anchors"] == counts["valid_primary_anchors"] == 32,
          "Primary anchor count/validity mismatch")
    check(counts["supporting_anchors"] == counts["valid_supporting_anchors"] == 130,
          "Supporting anchor count/validity mismatch")
    check(counts["historical_anchors"] == counts["valid_historical_anchors"] == 40,
          "Historical anchor count/validity mismatch")
    check(counts["supporting_and_historical_anchors"] == 170, "Combined anchor count mismatch")
    check(used_current == current_paths and len(used_current) == 29, "Current anchor file set mismatch")
    check(used_historical == historical_paths, "Historical anchor file set mismatch")
    check("../SplatPreview/" not in csv_text and "../SplatPreview/" not in md_text,
          "Final documentation contains a mutable sibling source reference")

    links = re.findall(r"\[[^\]]+\]\(([^)]+)\)", md_text)
    link_results = []
    for link in links:
        # Only these eight literal local destinations may be inspected.
        allowed = link in EXPECTED_LINKS
        exists = allowed and (ROOT / "docs/parity" / link.split("#", 1)[0]).exists()
        check(allowed and exists, f"Unexpected or missing companion link: {link}")
        link_results.append({"destination": link, "allowed": allowed, "exists": exists})
    counts["markdown_links"] = len(links)
    counts["valid_markdown_links"] = sum(item["allowed"] and item["exists"] for item in link_results)
    check(len(links) == 8 and set(links) == set(EXPECTED_LINKS), "Companion link set/count mismatch")

    return {
        "schemaVersion": 1,
        "kind": "splatview-r0-current-target-contract-binding-audit",
        "generatedUtc": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if not errors else "fail",
        "scope": {
            "sourceBindingOnly": True, "directoryWalkPerformed": False,
            "fullCaptureTreeRehashed": False, "publicWasmTraversalPerformed": False,
            "nativeAcceptance": "pending;not-run", "browserAcceptance": "pending;not-run",
            "macAcceptance": "pending;not-run",
            "note": "Checks recorded capture tree identity and referenced file hashes; does not execute parity fixtures.",
        },
        "target": {"snapshot": SNAPSHOT, "version": TARGET_VERSION,
                   "recordedTreeSha256": manifest.get("treeSha256"), "cmakeProject": observed_project},
        "counts": counts, "schemaFields": fields, "uniqueness": uniqueness,
        "matchingRequiredRowValues": status_counts,
        "inputFiles": observed_inputs, "currentSourceFiles": current_results,
        "historicalSourceFiles": historical_results, "markdownLinks": link_results,
        "errors": errors,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path,
                        help="New JSON report path; its parent must already exist.")
    args = parser.parse_args()
    output = args.output.resolve()
    protected = {ROOT / name for name in (*PINNED_SHA256, STATUS_PATH)} | {Path(__file__).resolve()}
    source_roots = (ROOT / SOURCE, ROOT / "reference/windows")
    if output in protected or any(output == path or path in output.parents for path in source_roots):
        parser.error("Report output must not target the read-only inputs or source trees")
    report = audit()
    try:
        with output.open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(report, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
    except OSError as exc:
        print(f"Cannot exclusively create report {output}: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"status": report["status"], "report": str(output),
                      "counts": report["counts"], "errors": len(report["errors"])}, sort_keys=True))
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
