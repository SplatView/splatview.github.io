"""Generate the stable web capability inventory without modifying application inputs.

Use --check for drift detection, or --output-directory with a fresh workspace
directory. Publication to docs/parity is a separate, reviewed file operation.
Implementation labels describe code coverage, never release qualification.
"""
from pathlib import Path
import argparse
import csv
import hashlib
import io
import json
import stat

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "docs/parity/feature-matrix.csv"
CAPTURE = "reference/targets/windows-r0-20261012-02/CAPTURE_MANIFEST.json"
REVISION = "windows-r0-20261012-02"
CPU_CASE_MAP = "docs/parity/cpu-case-map-v1.json"
OFFLINE_CASE_MAP = "docs/parity/offline-case-map-v1.json"
# Each mapped cell requires every independently collected case in these reviewed
# files. Browser workflows, native reference numerics and capacity remain separate.
CPU_CASE_FILES = {
    "wasm-codecs:identity": ["tests/build-compat.test.ts", "tests/core.test.ts"],
    "dirty-recovery:protocol": ["tests/checkpoint-hash.test.ts", "tests/operation-client.test.ts",
        "tests/operation-protocol.test.ts", "tests/recovery-checkpoint.test.ts", "tests/recovery-client.test.ts",
        "tests/recovery-coordinator.test.ts", "tests/recovery-metadata.test.ts", "tests/recovery-protocol.test.ts",
        "tests/recovery-worker.test.ts"],
    "languages-accessibility:translations": ["tests/language-catalog.test.ts", "tests/language-format.test.ts",
        "tests/language-picker.test.ts", "tests/language-preferences.test.ts"],
}

# Stable IDs survive prose changes in the historical feature matrix. Each scope
# describes the evidence still required, rather than asserting it already exists.
FEATURES = [
    ("source-reference", "Source and native reference", "implemented", [
        ("vitest", "identity", "Pinned source inventories, licenses and source-lock validation."),
        ("native", "desktop-contract", "Frozen desktop contract capture and reviewed upstream differences.")]),
    ("wasm-codecs", "WASM and codec builds", "implemented", [
        ("native", "toolchain", "Reproducible pinned toolchain, native provenance and ABI/capability freshness."),
        ("vitest", "identity", "Exact shipping native files and worker protocol compatibility checks.")]),
    ("gaussian-ply", "Gaussian PLY", "implemented", [
        ("format", "interoperability", "Independent Gaussian PLY decoder fixtures, SH/order conventions and numeric tolerances."),
        ("playwright", "import", "Genuine PLY file acquisition, rendering, cancellation and malformed-input refusal.")]),
    ("compressed-ply", "Compressed PLY", "implemented", [
        ("format", "interoperability", "Independent compressed PLY fixtures, quantization and SH tolerance policy."),
        ("playwright", "import", "Genuine compressed PLY import and bounded malformed-input refusal.")]),
    ("spz", "SPZ", "implemented", [
        ("format", "interoperability", "Independent SPZ versions, coordinate/SH conventions and explicit lossy tolerances."),
        ("playwright", "import", "Genuine SPZ import, replacement, cancellation and failure behavior.")]),
    ("splat-ksplat", "SPLAT and KSPLAT", "implemented", [
        ("format", "interoperability", "Independent SPLAT/KSPLAT versions, layouts and supported-feature/refusal policy."),
        ("playwright", "import", "Genuine SPLAT and KSPLAT import, replacement and failure behavior.")]),
    ("sog-sogs", "SOG and SOGS", "implemented", [
        ("format", "interoperability", "Independent SOG/SOGS containers and image-codec/coordinate/SH tolerance policy."),
        ("playwright", "import", "Genuine single-file and multi-file import, decoding and bounded refusal.")]),
    ("ply-readonly", "Read-only PLY points/meshes", "implemented", [
        ("format", "interoperability", "Independent point/mesh PLY vertex/topology/color identity, separate from Gaussian SH0 fixtures."),
        ("playwright", "readonly", "Opaque depth/navigation, geometry capability refusals, unavailable Gaussian-only edits and retention.")]),
    ("file-acquisition", "File acquisition and replacement", "implemented", [
        ("vitest", "policy", "Unique-source byte limits, cancellation, admission and transactional replacement."),
        ("playwright", "workflow", "Picker/drop/directory inputs, replace/close, dirty decisions and recoverable failures.")]),
    ("camera-navigation", "Camera and navigation", "implemented", [
        ("native", "numerics", "Frozen desktop camera transforms, bounds, projection and navigation numerics."),
        ("playwright", "interaction", "Orbit/pan/zoom, view presets, fit/reset, shortcuts and resize behavior.")]),
    ("viewport-background", "Viewport background", "implemented", [
        ("playwright", "interaction", "Background choices, state persistence and capture consistency."),
        ("visual", "appearance", "Frozen desktop background colors and composition at named DPR/framebuffer.")]),
    ("rendering-picking", "Rendering and contributor picking", "implemented", [
        ("native", "numerics", "Independent depth, covariance, SH, compositing and contributor-order comparisons."),
        ("playwright", "interaction", "Actual WebGPU render and visible contributor picking after camera/edit changes."),
        ("visual", "appearance", "Independent desktop images with named camera, DPR, color space and tolerances.")]),
    ("selection-surfaces", "Surface depth opacity RGB and visibility", "implemented", [
        ("native", "numerics", "Frozen surface/depth/opacity/RGB/visibility selection maps and occlusion policies."),
        ("playwright", "interaction", "Visible surface, depth and color selection behavior after view/edit changes.")]),
    ("manual-selection", "Single/Brush/Rectangle/Polygon", "implemented", [
        ("native", "numerics", "Exact masks, amendment operations, boundaries and contributor policies."),
        ("playwright", "interaction", "Pointer/keyboard tools, feedback, polygon finish/undo/cancel and history.")]),
    ("volume-brush", "Volume brush", "implemented", [
        ("native", "numerics", "Frozen desktop volume geometry, depth, radius and amendment masks."),
        ("playwright", "interaction", "Volume cursor, strokes, cancellation, tool switching and history.")]),
    ("color-connected-fill", "Color picker Connected colors and Fill", "implemented", [
        ("native", "numerics", "Frozen RGB/connected/fill tolerance, adjacency and exact-mask comparisons."),
        ("playwright", "interaction", "Picker feedback, tolerance previews, commit/cancel and history.")]),
    ("cleanup-history", "Cleanup and history", "implemented", [
        ("native", "numerics", "Deletion/visibility, compaction, restore and exact history checkpoint semantics."),
        ("playwright", "interaction", "Cleanup actions, undo/redo, dirty decisions and history-limit refusals.")]),
    ("basic-color-presets", "Basic color and presets", "implemented", [
        ("native", "numerics", "Frozen basic color math and absolute preview/commit/cancel behavior."),
        ("playwright", "interaction", "Color controls, presets, selection scope, reset and undo/redo.")]),
    ("alignment", "Alignment", "implemented", [
        ("native", "numerics", "Frozen desktop alignment axes, units, transform order and fit/camera behavior."),
        ("playwright", "interaction", "Alignment controls, previews, reset, cancellation and history.")]),
    ("rendered-histogram", "Rendered histogram", "implemented", [
        ("native", "numerics", "Frozen desktop rendered three-channel RGB bins, bounds and sample/alpha policy."),
        ("playwright", "interaction", "Histogram updates, hidden/closed-panel lifecycle and pending work cleanup.")]),
    ("pro-grading-transforms", "Pro grading and transforms", "implemented", [
        ("native", "numerics", "Frozen grading/transform math, scope, preview and exact cancellation/restoration."),
        ("playwright", "interaction", "Pro controls, transforms, presets, commit/cancel/reset and history.")]),
    ("filters", "Filters", "implemented", [
        ("native", "numerics", "Frozen filter policies, thresholds, bounds and exact selection outcomes."),
        ("playwright", "interaction", "Separate filter preview/confirm/cancel ownership, gizmos, selection amendments, stale/refused cleanup and history.")]),
    ("selection-morphology", "Grow and Shrink selection", "implemented", [
        ("native", "numerics", "Frozen morphology neighborhood, ordering, thresholds and exact masks."),
        ("playwright", "interaction", "Explicit one-layer Grow/Shrink commands, repeated/no-op/refused outcomes, cancellation and history.")]),
    ("scene-exporters", "Scene exporters: eight families and nine choices", "implemented", [
        ("format", "interoperability", "All eight families/nine choices times All/Selected/Remainder, independent decode, membership/order, coordinate/SH and lossy tolerance rules."),
        ("playwright", "workflow", "Actual filenames/downloads, every selection/deletion scope, cancellation, refusal and joined allocation cleanup for every choice.")]),
    ("capture-clipboard", "Capture and image clipboard", "implemented", [
        ("native", "image-policy", "Independent image resizing, alpha/color-space policy and unresolved Fant differences."),
        ("playwright", "workflow", "Actual PNG download/clipboard permission outcomes and joined GPU/Blob lifetimes."),
        ("https", "secure-context", "Deployed HTTPS capture, permission policy and browser clipboard outcomes.")]),
    ("saved-views", "Saved views and thumbnails", "partial", [
        ("playwright", "workflow", "Save/rename/replace/delete views, portable resolution, reload, camera restoration, malformed storage/quota refusals and resource cleanup."),
        ("visual", "thumbnails", "Desktop thumbnail composition and independent resize/alpha policy, including 14 unresolved vertical-alpha calibration cases beyond the 17 matched WIC fixtures.")]),
    ("dirty-recovery", "Dirty navigation and recovery", "implemented", [
        ("vitest", "protocol", "Ownership, stale messages, recovery acknowledgements, cancellation and exact state invariants."),
        ("playwright", "workflow", "Real in-tab worker crash/timeout recovery, close/replace decisions, checkpoint lifetimes and no replay; cross-reload database recovery remains optional.")]),
    ("desktop-appearance", "Desktop appearance and interaction", "partial", [
        ("visual", "desktop-comparison", "Frozen desktop chrome, layout, typography, icons, DPR and named font profile."),
        ("playwright", "interaction", "Menus/panels/dialogs, floating controls, tool feedback, keyboard, focus, zoom/DPR and fullscreen behavior.")]),
    ("languages-accessibility", "Languages tutorial accessibility", "implemented", [
        ("vitest", "translations", "All supported language keys, captions and desktop/web shortcut differences."),
        ("playwright", "interaction", "Tutorial, language preview/persistence, localized narrow-width layout, reduced motion, zoom, keyboard focus, labels, errors and dialog semantics."),
        ("manual", "assistive-technology", "Actual keyboard and screen-reader workflow on a named available browser/host; no Mac prerequisite.")]),
    ("static-offline", "Static deployment and offline", "implemented", [
        ("playwright", "offline-update", "Genuine immutable build A/B/C update, offline, native-cache and cleanup scenarios."),
        ("https", "deployed-host", "Actual static HTTPS host, subpath, headers, workers, WASM, reload and offline update.")]),
    ("browser-operating-budgets", "Mac operating budgets", "planned", [
        ("benchmark", "observed-browser", "Observed available browser/host, real production fixtures, all required correctness/timing/memory/retention scenarios, actual cancellation-request through joined-retirement clocks, and measured approved budgets; no Mac prerequisite.")]),
    ("webgl-compatibility", "WebGL compatibility viewer", "excluded", []),
    ("native-shell-integration", "Finder shell and native integration", "excluded", []),
]
EXCLUSIONS = {
    "webgl-compatibility": "Optional separate compatibility release; the editor requires WebGPU and does not claim a WebGL fallback.",
    "native-shell-integration": "Browser scope excludes Finder/Explorer previews, native shell extensions, file associations and native packaging.",
}
GATES = [
    ("shipping-integrity", "vitest", "Exact source/native/distribution identities, runtime artifact roles and stale-asset refusal."),
    ("format-policy", "format", "Versioned independent fixtures and approved format tolerance/refusal policy for every retained codec."),
    ("desktop-numerical-policy", "native", "Pinned desktop binary/source provenance and independent numerical comparison policy."),
    ("desktop-visual-policy", "visual", "Versioned desktop image tolerances, camera, font, DPR and color-space profile."),
    ("browser-workflows", "playwright", "Complete retained workflow inventory on each explicitly claimed observed browser configuration."),
    ("deployed-https", "https", "Real deployed HTTPS environment, security headers, storage, download/clipboard and update outcomes."),
    ("measured-budgets", "benchmark", "Real deterministic fixtures, full observed-host measurements, resource retention and approved capacity budgets."),
]
# Reviewed narrow mappings from a separate Playwright collection, rather than
# from the observed pass report. Their fixture/config/source/list receipts are
# independently bound by each release request. They cannot qualify the broader
# interaction, native numerical, image-policy, or complete-feature cells.
FEEDBACK_CASES = {
    "manual-selection": ("feedback", "Actual manual cursor/operation feedback, bounded brush trail/Volume ellipse and basic/pro Polygon Finish/Exit/Previous/Cancel controls.", [
        "5cc930181a2ded5f96e2-17901371dfce60cfb49e",
        "5cc930181a2ded5f96e2-04e353e3809a403ff2fa",
        "5cc930181a2ded5f96e2-376de5ce3922e5bd1a8d",
    ]),
    "capture-clipboard": ("confirmation", "Actual joined PNG/clipboard confirmation, stale Close suppression and browser-policy-denied failure feedback.", [
        "5cc930181a2ded5f96e2-52b802b713b519ae67cb",
        "5cc930181a2ded5f96e2-727fde4dfd4135a15ea5",
        "5cc930181a2ded5f96e2-2ac0e4656dceba691b6e",
    ]),
}


def safe_file(name):
    path = ROOT / name
    if not path.is_relative_to(ROOT) or path.resolve() != path.absolute():
        raise ValueError(f"Unsafe input: {name}")
    for item in [path, *path.parents]:
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError(f"Linked/reparse input: {name}")
        if item == ROOT:
            break
    if not path.is_file() or path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError(f"Missing/oversize input: {name}")
    return path.read_bytes()


def ref(name, data=None):
    data = safe_file(name) if data is None else data
    return dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest())


def generate():
    source = safe_file(SOURCE)
    reader = csv.DictReader(io.StringIO(source.decode("utf-8-sig"), newline=""), strict=True)
    if reader.fieldnames != ["capability", "backlog", "release_tier", "desktop_contract", "current_coverage", "remaining_work", "evidence_required"]:
        raise ValueError("Historical feature ledger headers changed; review the mapping")
    rows = list(reader)
    if [row["capability"] for row in rows] != [entry[1] for entry in FEATURES]:
        raise ValueError("Historical feature ledger inventory changed; review every capability")
    capabilities = []
    for identity, label, status, cells in FEATURES:
        capabilities.append(dict(id=identity, desktopFeature=label,
            scope="excluded" if status == "excluded" else "retained", implementation=status,
            requiredCells=[dict(id=f"{identity}:{suffix}", kind=kind, scope=scope, configurationIds=[], requiredCaseIds=[])
                           for kind, suffix, scope in cells], approvedDifferenceIds=[],
            exclusionReason=EXCLUSIONS.get(identity)))
        if identity in FEEDBACK_CASES:
            suffix, scope, ids = FEEDBACK_CASES[identity]
            capabilities[-1]["requiredCells"].append(dict(id=f"{identity}:{suffix}", kind="playwright", scope=scope,
                configurationIds=[], requiredCaseIds=["spec:manual-feedback.spec.ts::" + item for item in ids]))
    if (ROOT / CPU_CASE_MAP).exists():
        case_map = json.loads(safe_file(CPU_CASE_MAP).decode("utf-8"))
        if set(case_map) != {"schemaVersion", "kind", "collection", "mappings"} or case_map["schemaVersion"] != 1 or case_map["kind"] != "splatview-reviewed-cpu-case-map":
            raise ValueError("Unexpected CPU case-map contract")
        receipt = case_map["collection"]
        if not isinstance(receipt, dict) or set(receipt) != {"path", "bytes", "sha256"} or not isinstance(receipt["bytes"], int) or receipt["bytes"] < 0 or not isinstance(receipt["path"], str) or len(receipt["sha256"]) != 64 or any(character not in "0123456789abcdef" for character in receipt["sha256"]):
            raise ValueError("Malformed independent CPU collection reference")
        mappings = case_map["mappings"]
        if not isinstance(mappings, list) or len(mappings) != len(CPU_CASE_FILES) or {item.get("cellId") for item in mappings} != set(CPU_CASE_FILES):
            raise ValueError("CPU case map must cover exactly the reviewed cells")
        cells = {cell["id"]: cell for feature in capabilities for cell in feature["requiredCells"]}
        for mapping in mappings:
            if set(mapping) != {"cellId", "files"} or not isinstance(mapping["files"], list):
                raise ValueError("Unexpected CPU cell mapping fields")
            expected = CPU_CASE_FILES[mapping["cellId"]]
            if sorted(file.get("path") for file in mapping["files"]) != sorted(expected):
                raise ValueError("CPU cell mapping omits or adds a reviewed source file")
            identifiers = []
            for file in sorted(mapping["files"], key=lambda item: item["path"]):
                if set(file) != {"path", "fullNames"} or not isinstance(file["fullNames"], list) or not file["fullNames"] or any(not isinstance(name, str) or not name for name in file["fullNames"]) or len(set(file["fullNames"])) != len(file["fullNames"]):
                    raise ValueError("Malformed or empty collected CPU case inventory")
                identifiers.extend(file["path"] + "::" + name for name in sorted(file["fullNames"]))
            cell = cells[mapping["cellId"]]
            if cell["kind"] != "vitest" or cell["requiredCaseIds"]:
                raise ValueError("CPU mapping cannot replace another evidence kind or existing mapping")
            cell["requiredCaseIds"] = identifiers
    if (ROOT / OFFLINE_CASE_MAP).exists():
        offline = json.loads(safe_file(OFFLINE_CASE_MAP).decode("utf-8"))
        if set(offline) != {"schemaVersion", "kind", "collection", "cellId", "files"} or offline["schemaVersion"] != 1 or offline["kind"] != "splatview-reviewed-offline-case-map" or offline["cellId"] != "static-offline:offline-update":
            raise ValueError("Unexpected offline case-map contract")
        files = offline["files"]
        receipt = offline["collection"]
        if not isinstance(receipt, dict) or set(receipt) != {"path", "bytes", "sha256"} or not isinstance(receipt["bytes"], int) or receipt["bytes"] < 0 or not isinstance(receipt["path"], str) or not isinstance(receipt["sha256"], str) or len(receipt["sha256"]) != 64 or any(character not in "0123456789abcdef" for character in receipt["sha256"]):
            raise ValueError("Malformed independent offline collection reference")
        if not isinstance(files, list) or len(files) != 1 or set(files[0]) != {"path", "leaves"} or files[0]["path"] != "tests/offline/offline.spec.ts" or not isinstance(files[0]["leaves"], list) or not files[0]["leaves"]:
            raise ValueError("Offline case map must pin the complete reviewed offline spec")
        identifiers = []
        for leaf in files[0]["leaves"]:
            if set(leaf) != {"id", "title", "project"} or not all(isinstance(leaf[key], str) and leaf[key] for key in ["id", "title"]) or leaf["project"] != "":
                raise ValueError("Malformed offline collection leaf")
            identifiers.append(leaf["project"] + "::" + leaf["id"])
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("Duplicate offline case ID")
        cell = next(cell for feature in capabilities for cell in feature["requiredCells"] if cell["id"] == offline["cellId"])
        if cell["kind"] != "playwright" or cell["requiredCaseIds"]:
            raise ValueError("Offline mapping cannot replace another evidence kind or existing mapping")
        cell["requiredCaseIds"] = sorted(identifiers)
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\n")
    writer.writerow(["id", "desktop_feature", "scope", "implementation", "required_cells", "exclusion_reason"])
    for item in capabilities:
        writer.writerow([item["id"], item["desktopFeature"], item["scope"], item["implementation"],
                         ";".join(cell["id"] for cell in item["requiredCells"]), item["exclusionReason"] or ""])
    csv_bytes = stream.getvalue().encode("utf-8")
    ledger = dict(schemaVersion=1, kind="splatview-capability-ledger",
        desktopContract=dict(revision=REVISION, capture=ref(CAPTURE)), sourceFeatureLedger=ref(SOURCE, source),
        capabilityInventory=ref("docs/parity/capabilities-v1.csv", csv_bytes), capabilities=capabilities,
        gates=[dict(id=f"gate:{identity}", kind=kind, scope=scope, configurationIds=[], requiredCaseIds=[])
               for identity, kind, scope in GATES], differences=[])
    return {"capabilities-v1.csv": csv_bytes,
            "capabilities-v1.json": (json.dumps(ledger, indent=2, ensure_ascii=False) + "\n").encode("utf-8")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check", action="store_true")
    group.add_argument("--output-directory")
    args = parser.parse_args()
    outputs = generate()
    if args.check:
        for name, data in outputs.items():
            if safe_file(f"docs/parity/{name}") != data:
                raise ValueError(f"Capability ledger drift: {name}")
    else:
        relative = Path(args.output_directory)
        if relative.is_absolute() or any(part in (".", "..") for part in relative.parts) or not relative.parts:
            raise ValueError("Output must be a fresh workspace-relative directory")
        directory = ROOT / relative
        if directory.exists() or directory.resolve() != directory.absolute() or not directory.is_relative_to(ROOT):
            raise ValueError("Output directory already exists or is linked/outside workspace")
        directory.mkdir(parents=True, exist_ok=False)
        for name, data in outputs.items():
            with (directory / name).open("xb") as stream:
                stream.write(data)
    print(json.dumps(dict(status="passed", mode="check" if args.check else "generate",
                          capabilities=len(FEATURES), retained=len(FEATURES)-len(EXCLUSIONS),
                          requiredCells=sum(len(item[3]) for item in FEATURES)+len(GATES)+len(FEEDBACK_CASES),
                          files={name: dict(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                                 for name, data in outputs.items()})))


if __name__ == "__main__":
    main()
