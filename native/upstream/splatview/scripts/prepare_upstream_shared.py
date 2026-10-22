"""Prepare a NEW Windows adoption candidate from a verified frozen release.

Never writes to the live original repo or the frozen snapshot. The candidate is
an explicitly modified review tree, not a source release or a deployment.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import difflib
import hashlib
import json
from pathlib import Path
import re
import sys

import capture_source as capture


WORKSPACE = Path(__file__).resolve().parents[1]
MANIFEST = "UPSTREAM_ADOPTION_MANIFEST.json"
BASELINE = "UPSTREAM_BASELINE_MANIFEST.json"
PACKAGE = "SHARED_PACKAGE_MANIFEST.json"
INCOMPLETE = "ADOPTION_INCOMPLETE.json"
SCENE_ADAPTERS = ("src/model.hpp", "src/model.cpp", "src/renderer.hpp", "CMakeLists.txt", "cmake/Tests.cmake")
FINGERPRINT_ADAPTERS = SCENE_ADAPTERS + ("scripts/BuildSupport.psm1", "tests/build_workflow_contracts.ps1")
FINGERPRINT_PROFILE = "scene_with_shared_fingerprints"
STORAGE_PROFILE = "scene_with_storage_and_shared_fingerprints"
MATH_FUNCTIONS = (
    ("Gaussian", "packGaussian"), ("float", "shValue"), ("void", "fitBounds"),
    ("size_t", "previewSplatBudget"), ("size_t", "thumbnailSplatBudget"),
)
CAMERA_FUNCTIONS = (
    ("void", "fit"), ("SavedView", "savedView"), ("void", "restoreView"),
    ("Camera", "transformed"), ("Vec3", "eye"), ("XMMATRIX", "view"),
    ("std::array<float, 2>", "clipPlanes"), ("XMMATRIX", "projection"),
    ("void", "look"), ("void", "move"), ("void", "focus"),
    ("void", "orbit"), ("void", "zoom"), ("void", "pan"),
)


class AdoptionError(RuntimeError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def write_new(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(data)


def normalized(text):
    return text.replace("\r\n", "\n")


def tokens(text):
    # String/character literals remain intact; whitespace and comments do not
    # change a numeric algorithm's token comparison.
    pattern = r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|\s+|[A-Za-z_]\w*|\d+(?:\.\d*)?(?:[eE][+-]?\d+)?[fFuUlL]*|.'
    return [item for item in re.findall(pattern, text, re.S)
            if not item.isspace() and not item.startswith(("//", "/*"))]


def function_span(text, return_type, name):
    pattern = r"(?m)^" + re.escape(return_type) + r"\s+" + re.escape(name) + r"\s*\("
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        raise AdoptionError(f"Expected exactly one function: {return_type} {name}")
    start = matches[0].start()
    brace = text.find("{", matches[0].end())
    depth, index = 1, brace + 1
    while index < len(text) and depth:
        if text.startswith("//", index):
            end = text.find("\n", index)
            index = len(text) if end < 0 else end
        elif text.startswith("/*", index):
            end = text.find("*/", index + 2)
            if end < 0:
                raise AdoptionError(f"Unclosed comment in {name}")
            index = end + 2
        elif text[index] in ('"', "'"):
            quote, index = text[index], index + 1
            while index < len(text):
                if text[index] == "\\":
                    index += 2
                elif text[index] == quote:
                    index += 1
                    break
                else:
                    index += 1
        else:
            depth += (text[index] == "{") - (text[index] == "}")
            index += 1
    if brace < 0 or depth:
        raise AdoptionError(f"Unclosed function: {name}")
    end = index + (index < len(text) and text[index] == "\n")
    return start, end


def function_text(text, return_type, name):
    start, end = function_span(normalized(text), return_type, name)
    return normalized(text)[start:end]


def replace_once(text, before, after, label):
    if text.count(before) != 1:
        raise AdoptionError(f"Adapter precondition changed: {label}")
    return text.replace(before, after, 1)


def expected_camera(reference, name):
    if name == "transformed":
        reference = replace_once(reference, "const auto offset = position - focus;",
                                 "const auto offset = XMVectorSubtract(position, focus);", "camera offset")
        reference = replace_once(reference,
            "XMStoreFloat3(reinterpret_cast<XMFLOAT3 *>(&result.target), focus);",
            "XMFLOAT3 transformedTarget;\n    XMStoreFloat3(&transformedTarget, focus);\n"
            "    result.target = {transformedTarget.x, transformedTarget.y, transformedTarget.z};",
            "camera target storage")
        brace = reference.index("{") + 1
        reference = (reference[:brace] +
            '\n    if (std::any_of(matrix.begin(), matrix.end(), [](float value) { return !std::isfinite(value); }))\n'
            '        throw std::runtime_error("Alignment needs finite transform coordinates.");' +
            reference[brace:])
    elif name == "view":
        reference = replace_once(reference,
            "const auto up = upright * std::cos(roll) + right * std::sin(roll);",
            "const auto up = XMVectorAdd(XMVectorScale(upright, std::cos(roll)), XMVectorScale(right, std::sin(roll)));",
            "camera up vector")
    return reference


def review_math(snapshot, package):
    reference_math = (snapshot / "src/model.cpp").read_text(encoding="utf-8")
    shared_math = (package / "src/core/scene_math.cpp").read_text(encoding="utf-8")
    reference_camera = (snapshot / "src/camera.cpp").read_text(encoding="utf-8")
    shared_camera = (package / "src/core/camera.cpp").read_text(encoding="utf-8")
    review = []
    for return_type, name in MATH_FUNCTIONS:
        before = function_text(reference_math, return_type, name)
        after = function_text(shared_math, return_type, name)
        if tokens(before) != tokens(after):
            raise AdoptionError(f"Unreviewed numeric drift in {name}")
        review.append({"function": name, "status": "identical_cpp_tokens",
                       "baseline_sha256": digest(before.encode()), "shared_sha256": digest(after.encode())})
    for return_type, member in CAMERA_FUNCTIONS:
        name = "Camera::" + member
        before = function_text(reference_camera, return_type, name)
        after = function_text(shared_camera, return_type, name)
        if tokens(expected_camera(before, member)) != tokens(after):
            raise AdoptionError(f"Unreviewed camera drift in {name}")
        review.append({"function": name,
                       "status": "reviewed_portability_and_validation" if member in ("view", "transformed") else "identical_cpp_tokens",
                       "baseline_sha256": digest(before.encode()), "shared_sha256": digest(after.encode())})
    difference = "".join(difflib.unified_diff(normalized(reference_camera).splitlines(True),
        normalized(shared_camera).splitlines(True), fromfile="baseline/src/camera.cpp",
        tofile="shared-core/src/core/camera.cpp"))
    return review, difference


def package_inventory(package):
    cmake = (package / "shared/CMakeLists.txt").read_text(encoding="utf-8")
    source_files = set(re.findall(r"src/(?:core|render)/[\w.-]+\.(?:cpp|hpp)", cmake))
    required = {"src/core/" + name for name in ("scene_math.cpp", "camera.cpp", "navigation.cpp", "editing.cpp", "selection.cpp",
                "volume_selection.cpp", "geometry_tools.cpp", "surface_selection.cpp")}
    if not required.issubset(source_files):
        raise AdoptionError("Canonical package is missing expected shared source targets")
    paths = {"shared/CMakeLists.txt", "shared/README.md", "LICENSE", "THIRD-PARTY-NOTICES.txt",
             "THIRD_PARTY_PORT_NOTICES.txt", "third_party/HEADER_DEPENDENCIES.json"}
    # Capture the actual source/header closure, including optional CPU rendering,
    # without pulling unrelated loader/export headers into the domain package.
    pending = list(source_files | {"src/core/depth_sort.hpp", "src/core/tools_mode.hpp"})
    selected = set()
    while pending:
        relative = pending.pop()
        if relative in selected:
            continue
        selected.add(relative)
        source = capture._safe_path(package, relative)
        for include in re.findall(r'(?m)^\s*#\s*include\s*"([^"]+)"', source.read_text(encoding="utf-8")):
            choices = (source.parent / include, package / "src/core" / include, package / "src/render" / include)
            resolved = next((path.resolve() for path in choices if path.is_file()), None)
            if resolved is None or not any(resolved.is_relative_to(package / folder) for folder in ("src/core", "src/render")):
                raise AdoptionError(f"Shared package has an unresolved/nonportable local include: {relative}: {include}")
            pending.append(resolved.relative_to(package).as_posix())
    paths.update(selected)
    paths.update(path.relative_to(package).as_posix() for path in (package / "third_party/DirectXMath").rglob("*") if path.is_file())
    inventory = {}
    for relative in sorted(paths):
        path = capture._safe_path(package, relative)
        if not path.is_file():
            raise AdoptionError(f"Shared package entry is not a regular file: {relative}")
        inventory[relative] = capture._signature(path.lstat())
    return inventory


def fingerprint_support(text):
    """Retain the wrapper's existing input rules, adding the complete package.

    ConfigureOnly must include shared C++/headers too: fixture identity and the
    canonical math lock are evaluated at configure time, not just build time.
    """
    text = replace_once(text,
        "@('src','tests','cmake','scripts','assets','packaging','third_party','docs','design')",
        "@('src','tests','cmake','scripts','assets','packaging','third_party','docs','design','shared-core')",
        "wrapper shared source directory")
    return replace_once(text,
        "if (-not $ConfigureOnly -or $file.Extension -in @('.cmake','.in','.json') -or $file.Name -eq 'CMakeLists.txt')",
        "if (-not $ConfigureOnly -or $folder -eq 'shared-core' -or $file.Extension -in @('.cmake','.in','.json') -or $file.Name -eq 'CMakeLists.txt')",
        "wrapper configure-time shared source identity")


def shared_fixture_identity(text):
    return replace_once(text, "foreach(source IN ITEMS tests/shared_fixtures.cpp",
        "# Every canonical shared input participates in seed identity, including locked math.\n"
        'file(GLOB_RECURSE shared_fixture_sources CONFIGURE_DEPENDS RELATIVE "${CMAKE_SOURCE_DIR}"\n'
        '    "${CMAKE_SOURCE_DIR}/shared-core/*")\n'
        "list(SORT shared_fixture_sources)\n"
        "foreach(source IN ITEMS ${shared_fixture_sources} tests/shared_fixtures.cpp",
        "complete shared fixture identity")


def fingerprint_workflow_contracts(text):
    # These additions exercise the actual original wrapper, including its
    # configure/build/test receipts. All existing hardening assertions remain.
    text = replace_once(text,
        "[IO.File]::WriteAllText((Join-Path $source 'third_party/spz/LICENSE'),'Workflow fixture license')",
        "[IO.File]::WriteAllText((Join-Path $source 'third_party/spz/LICENSE'),'Workflow fixture license')\n"
        "$sharedFingerprintPaths = @('shared-core/src/core/scene_math.cpp','shared-core/src/core/scene.hpp','shared-core/third_party/HEADER_DEPENDENCIES.json')\n"
        "foreach ($relative in $sharedFingerprintPaths) {\n"
        "    $path = Join-Path $source $relative\n"
        "    [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null\n"
        "    [IO.File]::WriteAllText($path,\"initial shared input`n\")\n"
        "}", "shared wrapper contract inputs")
    text = replace_once(text, 'include(CTest)\nset(SPLATVIEW_BUILD_BENCHMARKS',
        'include(CTest)\n'
        'file(GLOB_RECURSE shared_fixture_sources CONFIGURE_DEPENDS RELATIVE "${CMAKE_SOURCE_DIR}" "${CMAKE_SOURCE_DIR}/shared-core/*")\n'
        'list(SORT shared_fixture_sources)\n'
        'set(shared_fixture_identity "")\n'
        'foreach(source IN LISTS shared_fixture_sources)\n'
        '    file(SHA256 "${CMAKE_SOURCE_DIR}/${source}" source_hash)\n'
        '    string(APPEND shared_fixture_identity "${source}:${source_hash}\\n")\n'
        '    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_SOURCE_DIR}/${source}")\n'
        'endforeach()\n'
        'string(SHA256 shared_fixture_identity "${shared_fixture_identity}")\n'
        'file(WRITE "${CMAKE_BINARY_DIR}/shared-fixture-identity.txt" "${shared_fixture_identity}")\n'
        'set(SPLATVIEW_BUILD_BENCHMARKS', "shared wrapper contract fixture identity")
    anchor = "    Run-Workflow (@('-Action','Test','-Configuration','Debug','-TestRegex','^ToolsContracts$','-NoBuild') + $common)\n"
    block = """    foreach ($relative in $sharedFingerprintPaths) {
        $configureBefore = Get-SourceFingerprint $source -ConfigureOnly
        $sourceBefore = Get-SourceFingerprint $source
        $fixtureBefore = Get-Content -LiteralPath (Join-Path $build 'shared-fixture-identity.txt') -Raw
        $buildReceiptPath = Join-Path $build 'workflow/Debug/receipts/SplatViewToolsTests.json'
        $buildBefore = Get-Content -LiteralPath $buildReceiptPath -Raw | ConvertFrom-Json
        $resultPath = Get-ChildItem -LiteralPath (Join-Path $build 'reports/Debug') -Filter result.json -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
        $resultBefore = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        Add-Content -LiteralPath (Join-Path $source $relative) -Value 'changed shared input'
        Assert ((Get-SourceFingerprint $source -ConfigureOnly) -ne $configureBefore) "$relative invalidates configure identity"
        Assert ((Get-SourceFingerprint $source) -ne $sourceBefore) "$relative invalidates source identity"
        $failureLogPath = Join-Path $OutputDirectory "expected-failure-$script:checks.log"
        Run-Workflow (@('-Action','Test','-Configuration','Debug','-TestRegex','^ToolsContracts$','-NoBuild') + $common) -Failure
        $failureLog = Get-Content -LiteralPath $failureLogPath -Raw
        Assert ($failureLog -match 'current configured tree and matching configure evidence') "$relative rejects stale configure receipt"
        Run-Workflow (@('-Action','Configure','-Configuration','Debug') + $common)
        $configureAfter = Get-Content -LiteralPath (Join-Path $build 'workflow/configure.json') -Raw | ConvertFrom-Json
        Assert ($configureAfter.fingerprint -ne $configureBefore) "$relative refreshes configure receipt"
        Assert ((Get-Content -LiteralPath (Join-Path $build 'shared-fixture-identity.txt') -Raw) -ne $fixtureBefore) "$relative invalidates fixture identity"
        $failureLogPath = Join-Path $OutputDirectory "expected-failure-$script:checks.log"
        Run-Workflow (@('-Action','Test','-Configuration','Debug','-TestRegex','^ToolsContracts$','-NoBuild') + $common) -Failure
        $failureLog = Get-Content -LiteralPath $failureLogPath -Raw
        Assert ($failureLog -match 'evidence.*stale') "$relative rejects stale build receipt after reconfigure"
        Run-Workflow (@('-Action','Test','-Configuration','Debug','-TestRegex','^ToolsContracts$') + $common)
        $buildAfter = Get-Content -LiteralPath $buildReceiptPath -Raw | ConvertFrom-Json
        Assert ($buildAfter.sourceFingerprint -ne $buildBefore.sourceFingerprint) "$relative refreshes build receipt"
        $resultPath = Get-ChildItem -LiteralPath (Join-Path $build 'reports/Debug') -Filter result.json -Recurse | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1 -ExpandProperty FullName
        $resultAfter = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
        Assert ($resultAfter.sourceFingerprint -ne $resultBefore.sourceFingerprint) "$relative refreshes test result identity"
    }
"""
    # The original has another later successful retry; insert only at the first
    # success immediately before its existing direct-cache mutation scenario.
    next_line = "    $null = Invoke-CheckedNative $tools.CMake @('-S',$source,'-B',$build,'-DCMAKE_CXX_FLAGS=/DWORKFLOW_CACHE_CHANGE')"
    return replace_once(text, anchor + next_line, anchor + block + next_line,
                        "shared source receipt invalidation contracts")


def require_scene_only_package(package):
    cmake = (Path(package) / "shared/CMakeLists.txt").read_text(encoding="utf-8")
    if not re.search(r'\boption\s*\(\s*SPLATVIEW_BUILD_DOMAIN\b', cmake):
        raise AdoptionError("Scene-only adoption requires a package with the SPLATVIEW_BUILD_DOMAIN option")
    if not (Path(package) / "src/core/scene_storage.hpp").is_file():
        raise AdoptionError("Scene storage adoption requires the dependency-neutral allocator header")


def adapt(candidate, shared_fingerprints=False, scene_only=False):
    updates = {}
    for relative in FINGERPRINT_ADAPTERS if shared_fingerprints else SCENE_ADAPTERS:
        updates[relative] = (candidate / relative).read_bytes()
    header = normalized(updates["src/model.hpp"].decode("utf-8"))
    start, end = header.index("using Matrix4 ="), header.index("enum class InputFormat")
    header = header[:start] + header[end:]
    header = replace_once(header, '#pragma once\n', '#pragma once\n#include "../shared-core/src/core/scene.hpp"\n', "shared scene include")
    for declaration in ("size_t previewSplatBudget(unsigned width, unsigned height);\n",
                        "size_t thumbnailSplatBudget(unsigned size);\n",
                        "Gaussian packGaussian(const Attributes &attributes);\n",
                        "float shValue(const Gaussian &gaussian, unsigned coefficient, unsigned channel);\n",
                        "void fitBounds(Scene &scene);\n"):
        header = replace_once(header, declaration, "", "remove extracted declaration")

    model = normalized(updates["src/model.cpp"].decode("utf-8"))
    spans = [function_span(model, return_type, name) for return_type, name in MATH_FUNCTIONS]
    for start, end in sorted(spans, reverse=True):
        model = model[:start] + model[end:]

    renderer = normalized(updates["src/renderer.hpp"].decode("utf-8"))
    start, end = renderer.index("struct Camera {"), renderer.index("struct SelectionPreview {")
    renderer = renderer[:start] + renderer[end:]
    renderer = replace_once(renderer, '#include "model.hpp"\n',
        '#include "model.hpp"\n#include "../shared-core/src/core/camera.hpp"\n', "shared camera include")

    cmake = normalized(updates["CMakeLists.txt"].decode("utf-8"))
    cmake = replace_once(cmake, "add_library(preview_core STATIC\n",
        "# Adopt only shared scene/camera math; native Windows editing and UI remain.\n"
        + ("set(SPLATVIEW_BUILD_DOMAIN OFF)\n" if scene_only else "") +
        "add_subdirectory(shared-core/shared EXCLUDE_FROM_ALL)\n"
        "add_library(preview_core STATIC\n", "shared package target")
    cmake = replace_once(cmake, "    src/camera.cpp\n", "", "native camera source exclusion")
    cmake = replace_once(cmake, "target_link_libraries(preview_core PUBLIC splatview_language",
        "target_link_libraries(preview_core PUBLIC SplatView::Scene splatview_language", "scene consumer link")
    cmake += ("\n# Vendored math notices accompany every Runtime package using the shared scene target.\n"
        "install(FILES shared-core/third_party/DirectXMath/LICENSE DESTINATION licenses RENAME directxmath.txt COMPONENT Runtime)\n"
        "install(FILES shared-core/third_party/DirectXMath/SAL-LICENSE.txt DESTINATION licenses RENAME directxmath-sal.txt COMPONENT Runtime)\n")

    tests = normalized(updates["cmake/Tests.cmake"].decode("utf-8"))
    if shared_fingerprints:
        tests = shared_fixture_identity(tests)
    else:
        tests = replace_once(tests, "        src/editing.cpp src/editing.hpp src/scene_exports.cpp src/extra_exports.cpp src/sog_export.cpp)",
            "        src/editing.cpp src/editing.hpp src/scene_exports.cpp src/extra_exports.cpp src/sog_export.cpp\n"
            "        shared-core/src/core/scene.hpp shared-core/src/core/camera.hpp\n"
            "        shared-core/src/core/scene_math.cpp shared-core/src/core/camera.cpp\n"
            "        shared-core/src/core/math.hpp shared-core/third_party/HEADER_DEPENDENCIES.json)", "fixture identity shared sources")
    modified = {"src/model.hpp": header, "src/model.cpp": model, "src/renderer.hpp": renderer,
                "CMakeLists.txt": cmake, "cmake/Tests.cmake": tests}
    if shared_fingerprints:
        modified["scripts/BuildSupport.psm1"] = fingerprint_support(normalized(updates["scripts/BuildSupport.psm1"].decode("utf-8")))
        modified["tests/build_workflow_contracts.ps1"] = fingerprint_workflow_contracts(normalized(updates["tests/build_workflow_contracts.ps1"].decode("utf-8")))
    changes, difference = [], []
    for relative, text in modified.items():
        before = updates[relative]
        newline = "\r\n" if b"\r\n" in before else "\n"
        after = text.replace("\n", newline).encode("utf-8")
        (candidate / relative).write_bytes(after)
        changes.append({"path": relative, "baseline_sha256": digest(before), "modified_sha256": digest(after)})
        difference.extend(difflib.unified_diff(normalized(before.decode()).splitlines(True), text.splitlines(True),
            fromfile="baseline/" + relative, tofile="candidate/" + relative))
    return changes, "".join(difference)


def prepare(snapshot, destination, package=WORKSPACE, expected_version="0.12.74", shared_fingerprints=False,
            scene_only=False):
    if scene_only and not shared_fingerprints:
        raise AdoptionError("Scene storage adoption requires --shared-fingerprints")
    snapshot, package = Path(snapshot).resolve(strict=True), Path(package).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise AdoptionError(f"Refusing existing destination: {destination}")
    # This tool creates review candidates only inside its own workspace.
    resolved_destination = destination.resolve(strict=False)
    work_root = (WORKSPACE / "upstream-work").resolve(strict=False)
    if (not resolved_destination.is_relative_to(work_root) or resolved_destination == work_root or
            resolved_destination.is_relative_to(snapshot) or snapshot.is_relative_to(resolved_destination)):
        raise AdoptionError("Destination must be new, under upstream-work, and separate from the frozen baseline")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination = destination.parent.resolve(strict=True) / destination.name
    if (not destination.is_relative_to(WORKSPACE) or destination == WORKSPACE or
            destination.is_relative_to(snapshot) or snapshot.is_relative_to(destination)):
        raise AdoptionError("Destination must be new, inside this workspace, and separate from the frozen baseline")
    baseline = capture.verify(snapshot)
    if baseline["source"]["version"] != expected_version:
        raise AdoptionError("Frozen release does not match the expected version")
    baseline_bytes = (snapshot / capture.MANIFEST).read_bytes()
    if scene_only:
        require_scene_only_package(package)
    package_before = package_inventory(package)
    review, camera_diff = review_math(snapshot, package)
    started = datetime.now(timezone.utc).isoformat()
    destination.mkdir()
    marker = destination / INCOMPLETE
    write_new(marker, json_bytes({"state": "incomplete", "started_utc": started}))
    try:
        copied = []
        for item in baseline["files"]:
            source = capture._safe_path(snapshot, item["path"])
            output = destination / item["path"]
            output.parent.mkdir(parents=True, exist_ok=True)
            record = capture._read(snapshot, item["path"], capture._signature(source.lstat()), output)
            if record != item:
                raise AdoptionError(f"Frozen source changed during copy: {item['path']}")
            copied.append(record)
        # Preserve original provenance under an explicit baseline-only name.
        # SOURCE_SNAPSHOT.json is never copied into a modified candidate.
        write_new(destination / BASELINE, baseline_bytes)
        package_files = []
        for relative, signature in package_before.items():
            output = destination / "shared-core" / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            package_files.append(capture._read(package, relative, signature, output))
        if package_inventory(package) != package_before:
            raise AdoptionError("Canonical package inventory changed while copying")
        for item in package_files:
            if capture._read(package, item["path"], package_before[item["path"]]) != item:
                raise AdoptionError(f"Canonical package changed while copying: {item['path']}")
        if package_inventory(package) != package_before:
            raise AdoptionError("Canonical package changed during final observation")
        if capture.verify(snapshot) != baseline or (snapshot / capture.MANIFEST).read_bytes() != baseline_bytes:
            raise AdoptionError("Frozen baseline changed during candidate preparation")
        write_new(destination / PACKAGE, json_bytes({"schema_version": 1, "state": "verified_source_copy",
            "source_package": str(package), "files": package_files, "tree_sha256": capture._tree_digest(package_files),
            "observation": "two byte passes and inventories; bounded observation, not filesystem-atomic"}))
        changes, difference = adapt(destination, shared_fingerprints, scene_only)
        write_new(destination / "UPSTREAM_ADOPTION.diff", difference.encode())
        write_new(destination / "CAMERA_PARITY.diff", camera_diff.encode())
        inventory, exclusions = capture._inventory(destination, product_scope=False)
        if exclusions:
            raise AdoptionError("Candidate contains symlink/reparse entries")
        files = [capture._read(destination, relative, signature) for relative, signature in sorted(inventory.items())
                 if relative != INCOMPLETE]
        result = {"schema_version": 3 if scene_only else 2 if shared_fingerprints else 1, "state": "review_candidate", "started_utc": started,
            "completed_utc": datetime.now(timezone.utc).isoformat(),
            "baseline": {"directory": str(snapshot), "manifest": BASELINE, "manifest_sha256": digest(baseline_bytes),
                         "version": expected_version, "tree_sha256": baseline["tree_sha256"], "file_count": len(copied)},
            "package": {"manifest": PACKAGE, "tree_sha256": capture._tree_digest(package_files), "file_count": len(package_files)},
            "adapters": changes, "function_review": review,
            "script_sha256": digest(Path(__file__).read_bytes()),
            "capture_script_sha256": digest(Path(capture.__file__).read_bytes()),
            "files": files, "tree_sha256": capture._tree_digest(files), "file_count": len(files),
            "validation": "Copy/hash/function equivalence verified. Build/runtime/Explorer checks are separate evidence.",
            "limitations": "Modified review tree; no commit, release, deployment, signing, Explorer registration or live-original modification."}
        if shared_fingerprints:
            result["adoption_profile"] = STORAGE_PROFILE if scene_only else FINGERPRINT_PROFILE
            result["fingerprint_scope"] = "Complete shared-core subtree in configure/source receipts and fixture identity; original wrapper guards retained"
        if scene_only:
            result["shared_target_scope"] = "Scene only; Domain and CPU rendering targets are not configured"
        write_new(destination / MANIFEST, json_bytes(result))
        marker.unlink()
        verify(destination)
        return result
    except BaseException as error:
        marker.write_bytes(json_bytes({"state": "failed", "started_utc": started, "error": str(error)}))
        raise


def verify(candidate):
    candidate = Path(candidate).resolve(strict=True)
    result = json.loads((candidate / MANIFEST).read_bytes())
    if result.get("schema_version") not in (1, 2, 3) or result.get("state") != "review_candidate" or (candidate / INCOMPLETE).exists():
        raise AdoptionError("Candidate is incomplete or has an unsupported manifest")
    if (candidate / capture.MANIFEST).exists():
        raise AdoptionError("Modified candidates must not retain a valid snapshot manifest name")
    inventory, exclusions = capture._inventory(candidate, product_scope=False)
    records = result["files"]
    paths = [capture._relative(item["path"]) for item in records]
    if (exclusions or paths != sorted(set(paths)) or len(paths) != result["file_count"] or
            set(inventory) - {MANIFEST} != set(paths) or capture._tree_digest(records) != result["tree_sha256"]):
        raise AdoptionError("Candidate inventory or tree digest differs from its manifest")
    for item in records:
        if capture._read(candidate, item["path"], inventory[item["path"]]) != item:
            raise AdoptionError(f"Candidate hash mismatch: {item['path']}")
    baseline_bytes = (candidate / BASELINE).read_bytes()
    if digest(baseline_bytes) != result["baseline"]["manifest_sha256"]:
        raise AdoptionError("Baseline provenance was modified")
    baseline = json.loads(baseline_bytes)
    expected_changes = {item["path"]: item for item in result["adapters"]}
    expected_profile = STORAGE_PROFILE if result["schema_version"] == 3 else FINGERPRINT_PROFILE
    if result["schema_version"] in (2, 3) and (result.get("adoption_profile") != expected_profile or
            set(expected_changes) != set(FINGERPRINT_ADAPTERS) or len(result["adapters"]) != len(FINGERPRINT_ADAPTERS)):
        raise AdoptionError("Unsupported fingerprint profile or adapter scope")
    if result["schema_version"] == 3:
        require_scene_only_package(candidate / "shared-core")
        cmake = normalized((candidate / "CMakeLists.txt").read_text(encoding="utf-8"))
        if "set(SPLATVIEW_BUILD_DOMAIN OFF)\nadd_subdirectory(shared-core/shared EXCLUDE_FROM_ALL)" not in cmake:
            raise AdoptionError("Scene storage candidate must explicitly disable the shared Domain target")
        if result.get("shared_target_scope") != "Scene only; Domain and CPU rendering targets are not configured":
            raise AdoptionError("Unsupported Scene storage target scope")
    by_path = {item["path"]: item for item in records}
    for item in baseline["files"]:
        expected = expected_changes.get(item["path"])
        expected_hash = expected["modified_sha256"] if expected else item["sha256"]
        if by_path[item["path"]]["sha256"] != expected_hash:
            raise AdoptionError(f"Unexpected original-source change: {item['path']}")
        if expected and expected["baseline_sha256"] != item["sha256"]:
            raise AdoptionError(f"Adapter baseline mismatch: {item['path']}")
    package = json.loads((candidate / PACKAGE).read_bytes())
    if capture._tree_digest(package["files"]) != result["package"]["tree_sha256"]:
        raise AdoptionError("Canonical package manifest differs")
    for item in package["files"]:
        if by_path["shared-core/" + item["path"]]["sha256"] != item["sha256"]:
            raise AdoptionError(f"Canonical package copy differs: {item['path']}")
    final, excluded_after = capture._inventory(candidate, product_scope=False)
    if inventory != final or excluded_after:
        raise AdoptionError("Candidate changed during verification")
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("prepare", help="create a NEW modified review tree")
    stage.add_argument("--snapshot", type=Path, default=WORKSPACE / "source-reference-0.12.74")
    stage.add_argument("--destination", type=Path, default=WORKSPACE / "upstream-work/0.12.74-shared")
    stage.add_argument("--package", type=Path, default=WORKSPACE)
    stage.add_argument("--expected-version", default="0.12.74")
    stage.add_argument("--shared-fingerprints", action="store_true",
                       help="schema v2: include complete shared package in original wrapper/fixture identities")
    stage.add_argument("--scene-only", action="store_true",
                       help="schema v3: adopt allocator-aware Scene only, with --shared-fingerprints")
    check = commands.add_parser("verify", help="verify candidate bytes and adapter scope offline")
    check.add_argument("candidate", type=Path)
    args = parser.parse_args(argv)
    try:
        result = (prepare(args.snapshot, args.destination, args.package, args.expected_version,
                          args.shared_fingerprints, args.scene_only)
                  if args.command == "prepare" else verify(args.candidate))
    except (AdoptionError, capture.CaptureError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Upstream adoption {args.command} failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"command": args.command, "state": result["state"], "baseline_version": result["baseline"]["version"],
                      "file_count": result["file_count"], "tree_sha256": result["tree_sha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
