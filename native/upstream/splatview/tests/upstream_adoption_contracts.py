"""Adoption adapters and real fingerprint/fixture invalidation, in temp trees only.

Run directly with Python. These tests never mutate the frozen source, an adoption
candidate, or the live Windows project. Native receipt rejection/recovery is also
added to the new candidate's existing BuildWorkflowContracts suite.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import prepare_upstream_shared as adoption

FROZEN = ROOT / "source-reference-0.12.74"
CAPTURED = ROOT / "upstream-work/0.12.74-shared/shared-core"


def read_original(relative):
    return adoption.normalized((FROZEN / relative).read_text(encoding="utf-8"))


def find_cmake():
    configured = os.environ.get("CMAKE_COMMAND") or shutil.which("cmake")
    if configured:
        return configured
    for directory in (Path("C:/Program Files/Microsoft Visual Studio/2022"),
                      Path("C:/Program Files (x86)/Microsoft Visual Studio/2022")):
        found = list(directory.glob("*/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"))
        if found:
            return str(found[0])
    return None


class AdoptionContracts(unittest.TestCase):
    def setUp(self):
        if not FROZEN.is_dir() or not CAPTURED.is_dir():
            self.skipTest("requires the recorded frozen reference and first captured package")
        self.temp = tempfile.TemporaryDirectory(prefix="splatview-adoption-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)

    def test_existing_destination_is_never_overwritten(self):
        destination = self.base / "existing"
        destination.mkdir()
        sentinel = destination / "keep.txt"
        sentinel.write_bytes(b"user data")
        with self.assertRaisesRegex(adoption.AdoptionError, "Refusing existing destination"):
            adoption.prepare(FROZEN, destination, CAPTURED, shared_fingerprints=True)
        self.assertEqual(sentinel.read_bytes(), b"user data")

    def test_wrapper_adapter_preserves_every_other_rule(self):
        original = read_original("scripts/BuildSupport.psm1")
        adapted = adoption.fingerprint_support(original)
        self.assertEqual(adapted.replace(",'shared-core'", "").replace(
            " -or $folder -eq 'shared-core'", ""), original)
        self.assertIn("$folder -eq 'shared-core'", adapted)

    def test_wrapper_adapter_rejects_changed_preconditions(self):
        original = read_original("scripts/BuildSupport.psm1")
        with self.assertRaisesRegex(adoption.AdoptionError, "configure-time shared source identity"):
            adoption.fingerprint_support(original.replace("'.cmake','.in','.json'", "'.cmake','.json'"))

    def test_native_workflow_keeps_existing_assertions_and_adds_rejection(self):
        original = read_original("tests/build_workflow_contracts.ps1")
        adapted = adoption.fingerprint_workflow_contracts(original)
        for line in original.splitlines():
            if re.match(r"\s*(Assert|Expect-Failure|Run-Workflow)\b", line):
                self.assertIn(line, adapted)
        for expected in ("rejects stale configure receipt", "rejects stale build receipt after reconfigure",
                         "refreshes test result identity", "invalidates fixture identity"):
            self.assertIn(expected, adapted)

    def test_fixture_scope_includes_complete_shared_package(self):
        original = read_original("cmake/Tests.cmake")
        adapted = adoption.shared_fixture_identity(original)
        self.assertIn('"${CMAKE_SOURCE_DIR}/shared-core/*"', adapted)
        self.assertIn("foreach(source IN ITEMS ${shared_fixture_sources}", adapted)
        self.assertIn("CMAKE_CONFIGURE_DEPENDS", adapted)
        # All original seed inputs remain in the same hash loop.
        for path in re.findall(r"(?:tests|src)/[\w/.-]+\.(?:cpp|hpp)", original.split("string(SHA256 fixture_identity", 1)[0]):
            self.assertIn(path, adapted)

    def scene_only_adapter(self):
        candidate = self.base / "scene-only candidate"
        for relative in adoption.FINGERPRINT_ADAPTERS:
            output = candidate / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes((FROZEN / relative).read_bytes())
        changes, _ = adoption.adapt(candidate, shared_fingerprints=True, scene_only=True)
        self.assertEqual({item["path"] for item in changes}, set(adoption.FINGERPRINT_ADAPTERS))
        return candidate

    def test_scene_only_adapter_disables_domain_before_adding_package(self):
        candidate = self.scene_only_adapter()
        cmake = adoption.normalized((candidate / "CMakeLists.txt").read_text(encoding="utf-8"))
        self.assertIn("set(SPLATVIEW_BUILD_DOMAIN OFF)\nadd_subdirectory(shared-core/shared EXCLUDE_FROM_ALL)", cmake)
        self.assertIn("target_link_libraries(preview_core PUBLIC SplatView::Scene splatview_language", cmake)
        self.assertNotIn("    src/camera.cpp\n", cmake)
        self.assertIn("src/selection.cpp", cmake)
        self.assertIn("src/renderer.cpp", cmake)

    def test_scene_only_profile_rejects_package_without_configuration_boundary(self):
        with self.assertRaisesRegex(adoption.AdoptionError, "SPLATVIEW_BUILD_DOMAIN option"):
            adoption.require_scene_only_package(CAPTURED)
        with self.assertRaisesRegex(adoption.AdoptionError, "requires --shared-fingerprints"):
            adoption.prepare(FROZEN, self.base / "rejected", ROOT, scene_only=True)

    def test_real_scene_only_adapter_configures_with_json_and_threads_disabled(self):
        cmake = find_cmake()
        if not cmake:
            self.skipTest("CMake not installed")
        adoption.require_scene_only_package(ROOT)
        candidate = self.scene_only_adapter()
        for relative in adoption.package_inventory(ROOT):
            output = candidate / "shared-core" / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes((ROOT / relative).read_bytes())
        adapted = adoption.normalized((candidate / "CMakeLists.txt").read_text(encoding="utf-8"))
        start = adapted.index("# Adopt only shared scene/camera math;")
        end = adapted.index("add_library(preview_core STATIC\n", start)
        (candidate / "CMakeLists.txt").write_text(
            'cmake_minimum_required(VERSION 3.25)\nproject(SceneAdoptionBoundary LANGUAGES CXX)\n' +
            adapted[start:end] + '''
if(NOT TARGET SplatView::Scene OR TARGET SplatView::Domain OR TARGET SplatView::RenderCPU OR TARGET Threads::Threads OR TARGET nlohmann_json::nlohmann_json)
    message(FATAL_ERROR "Scene-only adapter configured an unrelated target or omitted Scene")
endif()
get_target_property(scene_dependencies splatview_scene INTERFACE_LINK_LIBRARIES)
if(scene_dependencies)
    message(FATAL_ERROR "Scene exports an unexpected link dependency")
endif()
file(WRITE "${CMAKE_BINARY_DIR}/scope.txt" "Scene only")
''', encoding="utf-8")
        command = [cmake, "-S", str(candidate), "-B", str(self.base / "scene-only build"),
                   "-DCMAKE_DISABLE_FIND_PACKAGE_Threads=ON", "-DCMAKE_DISABLE_FIND_PACKAGE_nlohmann_json=ON"]
        if os.name == "nt":
            command += ["-G", "Visual Studio 17 2022", "-A", "x64"]
        subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
        self.assertEqual((self.base / "scene-only build/scope.txt").read_text(), "Scene only")

    @unittest.skipUnless(os.name == "nt", "executes the authoritative PowerShell Windows wrapper module")
    def test_real_fingerprints_invalidate_shared_inputs_but_preserve_native_filter(self):
        executable = shutil.which("powershell") or shutil.which("pwsh")
        if not executable:
            self.skipTest("PowerShell not installed")
        source = self.base / "source with spaces"
        source.mkdir()
        paths = ["shared-core/src/core/scene_math.cpp", "shared-core/src/core/scene.hpp",
                 "shared-core/third_party/HEADER_DEPENDENCIES.json", "shared-core/shared/CMakeLists.txt",
                 "shared-core/third_party/DirectXMath/Inc/DirectXMath.h", "src/native.cpp"]
        for path in paths:
            target = source / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("initial\n", encoding="utf-8")
        module = self.base / "BuildSupport.psm1"
        module.write_text(adoption.fingerprint_support(read_original("scripts/BuildSupport.psm1")), encoding="utf-8")
        script = self.base / "fingerprints.ps1"
        script.write_text("""param([string]$ModulePath,[string]$SourceRoot)
$ErrorActionPreference='Stop'
Import-Module $ModulePath -Force -DisableNameChecking
$results=@()
$paths=@('shared-core/src/core/scene_math.cpp','shared-core/src/core/scene.hpp','shared-core/third_party/HEADER_DEPENDENCIES.json','shared-core/shared/CMakeLists.txt','shared-core/third_party/DirectXMath/Inc/DirectXMath.h','src/native.cpp')
foreach($relative in $paths) {
    $beforeConfigure=Get-SourceFingerprint $SourceRoot -ConfigureOnly
    $beforeSource=Get-SourceFingerprint $SourceRoot
    [IO.File]::AppendAllText((Join-Path $SourceRoot $relative),"changed`n")
    $results += [ordered]@{path=$relative;configureChanged=((Get-SourceFingerprint $SourceRoot -ConfigureOnly) -ne $beforeConfigure);sourceChanged=((Get-SourceFingerprint $SourceRoot) -ne $beforeSource)}
}
$results | ConvertTo-Json -Compress
""", encoding="utf-8")
        result = subprocess.run([executable, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script),
                                 "-ModulePath", str(module), "-SourceRoot", str(source)],
                                check=True, capture_output=True, text=True, timeout=60)
        records = json.loads(result.stdout)
        self.assertEqual(len(records), len(paths))
        for item in records:
            self.assertTrue(item["sourceChanged"], item["path"])
            self.assertEqual(item["configureChanged"], item["path"].startswith("shared-core/"), item["path"])

    def test_real_cmake_fixture_identity_changes_for_shared_source_header_lock_and_inventory(self):
        cmake = find_cmake()
        if not cmake:
            self.skipTest("CMake not installed")
        source, build = self.base / "fixture source", self.base / "fixture build"
        source.mkdir()
        original = read_original("cmake/Tests.cmake")
        adapted = adoption.shared_fixture_identity(original)
        start = adapted.index('set(fixture_identity "")')
        end = adapted.index('string(SHA256 fixture_identity "${fixture_identity}")')
        block = adapted[start:end] + 'string(SHA256 fixture_identity "${fixture_identity}")\n'
        for relative in re.findall(r"(?:tests|src)/[\w/.-]+\.(?:cpp|hpp)", block):
            path = source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original fixture input\n", encoding="utf-8")
        for path in CAPTURED.rglob("*"):
            if path.is_file():
                destination = source / "shared-core" / path.relative_to(CAPTURED)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(path.read_bytes())
        (source / "CMakeLists.txt").write_text('cmake_minimum_required(VERSION 3.25)\n'
            'project(FingerprintFixture LANGUAGES NONE)\n' + block +
            'file(WRITE "${CMAKE_BINARY_DIR}/identity.txt" "${fixture_identity}")\n', encoding="utf-8")

        def identity():
            command = [cmake, "-S", str(source), "-B", str(build)]
            if os.name == "nt":
                command += ["-G", "Visual Studio 17 2022", "-A", "x64"]
            subprocess.run(command, check=True, capture_output=True, text=True, timeout=60)
            return (build / "identity.txt").read_text()

        previous = identity()
        for relative in ("src/core/scene_math.cpp", "src/core/scene.hpp", "third_party/HEADER_DEPENDENCIES.json",
                         "third_party/DirectXMath/Inc/DirectXMath.h", "src/core/new_shared_input.hpp"):
            path = source / "shared-core" / relative
            with path.open("ab") as stream:
                stream.write(b"\n")
            current = identity()
            self.assertNotEqual(current, previous, relative)
            previous = current

    def test_legacy_manifest_remains_verifiable(self):
        result = adoption.verify(ROOT / "upstream-work/0.12.74-shared")
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["tree_sha256"], "e424a38f556d37f4f4f8d14dfeba4a99eb2438f1527526f4a74f2b10c28c4874")

    def test_fingerprint_manifest_remains_verifiable_and_unchanged(self):
        candidate = ROOT / "upstream-work/0.12.74-shared-fingerprints"
        manifest = candidate / adoption.MANIFEST
        before = manifest.read_bytes()
        self.assertEqual(adoption.digest(before), "36d88e0589e2f467086ace96e8f68e44610ef74f2df6979152365001bf8733b1")
        result = adoption.verify(candidate)
        self.assertEqual(result["schema_version"], 2)
        self.assertEqual(result["adoption_profile"], adoption.FINGERPRINT_PROFILE)
        self.assertEqual(result["tree_sha256"], "a72bc6c6b4222747dbc8d5f63a52384559d35373c9b29bf23a1866f96c2c3e80")
        self.assertEqual(manifest.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
