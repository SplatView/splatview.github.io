"""Source-release contracts; fixtures never touch the actual SplatPreview tree."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/capture_source.py"
spec = importlib.util.spec_from_file_location("capture_source", SCRIPT)
capture_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture_source)


class SourceCaptureContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="source-capture-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.source = root / "original"
        self.workspace = root / "workspace"
        self.source.mkdir()
        self.workspace.mkdir()
        self.destination = self.workspace / "snapshot"
        self.baseline = self.workspace / "SOURCE_BASELINE.json"
        self.baseline.write_text('{"source_version":"0.12.58"}\n', encoding="utf-8")
        for directory in capture_source.REQUIRED_DIRECTORIES:
            path = self.source / directory
            path.mkdir(parents=True, exist_ok=True)
            (path / "fixture.txt").write_text(directory + "\n", encoding="utf-8")
        for relative, data in {
            "CMakeLists.txt": "project(SplatView VERSION 0.12.70 LANGUAGES CXX)\n",
            "LICENSE": "fixture product license\n",
            "THIRD-PARTY-NOTICES.txt": (
                "Dear ImGui (MIT), pinned " + "a" * 40 + "\n"
                "Niantic SPZ (MIT), pinned commit " + "b" * 40 + "\n"
                "ImGuizmo (MIT), pinned " + "c" * 40 + "\n"),
            "vcpkg.json": json.dumps({"builtin-baseline": "d" * 40,
                                      "dependencies": ["zlib", "libwebp"]}),
            ".gitmodules": "[submodule \"third_party/imgui\"]\n",
            "src/main.cpp": "// original bytes\nint main() { return 0; }\n",
            "tests/scene.ply": "ply\nformat ascii 1.0\nend_header\n",
            "assets/日本語.txt": "Unicode payload: 日本語 🌍\n",
        }.items():
            (self.source / relative).write_text(data, encoding="utf-8")

    def capture(self, **kwargs):
        # Revision querying is independent of these byte/inventory fixture contracts.
        with patch.object(capture_source, "_revisions", return_value={
                "source": None, "imgui": "a" * 40, "spz": "b" * 40, "imguizmo": None}):
            return capture_source.capture(self.source, self.destination,
                                          workspace=self.workspace, **kwargs)

    def all_source_bytes(self):
        return {path.relative_to(self.source).as_posix(): path.read_bytes()
                for path in self.source.rglob("*") if path.is_file() and not path.is_symlink()}

    def failed_snapshot(self):
        self.assertTrue((self.destination / capture_source.INCOMPLETE).is_file())
        self.assertFalse((self.destination / capture_source.MANIFEST).exists())
        with self.assertRaises((capture_source.CaptureError, FileNotFoundError)):
            capture_source.verify(self.destination)

    def rewrite_manifest(self, change):
        path = self.destination / capture_source.MANIFEST
        data = json.loads(path.read_text(encoding="utf-8"))
        change(data)
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_capture_verify_and_original_unchanged(self):
        before = self.all_source_bytes()
        result = self.capture()
        verified = capture_source.verify(self.destination)
        self.assertEqual(result, verified)
        self.assertEqual(before, self.all_source_bytes())
        self.assertEqual(result["source"]["version"], "0.12.70")
        self.assertEqual(result["import_baseline"]["source_version"], "0.12.58")
        self.assertEqual(result["import_baseline"]["sha256"],
                         hashlib.sha256(self.baseline.read_bytes()).hexdigest())
        self.assertEqual(result["source"]["dependencies"]["vcpkg"]["builtin_baseline"], "d" * 40)
        self.assertEqual(result["source"]["dependencies"]["imgui"]["git_head"], "a" * 40)
        self.assertEqual(result["source"]["dependencies"]["imguizmo"]["notice_pin"], "c" * 40)
        self.assertFalse((self.destination / capture_source.INCOMPLETE).exists())
        self.assertEqual((self.source / "assets/日本語.txt").read_bytes(),
                         (self.destination / "assets/日本語.txt").read_bytes())

    def test_tree_digest_reproducible(self):
        first = self.capture()
        self.destination = self.workspace / "second"
        second = self.capture()
        self.assertEqual(first["files"], second["files"])
        self.assertEqual(first["tree_sha256"], second["tree_sha256"])

    def test_stat_identity_preserves_checks_across_windows_ctime_apis(self):
        path = self.source / "src/main.cpp"
        expected = capture_source._signature(path.lstat())
        different_clock = list(expected)
        different_clock[4] += 1000000000
        different_clock = tuple(different_clock)
        self.assertTrue(capture_source._same_opened_object(expected, different_clock, windows=True))
        self.assertFalse(capture_source._same_opened_object(expected, different_clock, windows=False))
        for index in (0, 1, 2, 3, 5, 6):
            changed = list(different_clock)
            changed[index] = (changed[index] or 0) + 1
            with self.subTest(field=index):
                self.assertFalse(capture_source._same_opened_object(expected, tuple(changed), windows=True))

    def test_stable_descriptor_ctime_api_difference_and_real_drift(self):
        path = self.source / "src/main.cpp"
        source = self.source.resolve()
        expected = capture_source._signature(path.lstat())
        actual_fstat = capture_source.os.fstat
        actual_compare = capture_source._same_opened_object

        def descriptor(stream, delta):
            info = actual_fstat(stream.fileno())
            return SimpleNamespace(st_dev=info.st_dev, st_ino=info.st_ino,
                                   st_size=info.st_size, st_mtime_ns=info.st_mtime_ns,
                                   st_ctime_ns=expected[4] + delta, st_mode=info.st_mode,
                                   st_birthtime_ns=getattr(info, "st_birthtime_ns", None))

        def signature(stream):
            return capture_source._signature(descriptor(stream, 1000000000))

        def windows_compare(left, right):
            return actual_compare(left, right, windows=True)

        with patch.object(capture_source, "_same_opened_object", side_effect=windows_compare):
            with patch.object(capture_source, "_descriptor_signature", side_effect=signature):
                result = capture_source._read(source, "src/main.cpp", expected)
            self.assertEqual(result["sha256"], hashlib.sha256(path.read_bytes()).hexdigest())
            calls = 0

            def drifting_signature(stream):
                nonlocal calls
                calls += 1
                return capture_source._signature(descriptor(stream, calls * 1000000000))

            with patch.object(capture_source, "_descriptor_signature", side_effect=drifting_signature):
                with self.assertRaisesRegex(capture_source.CaptureError, "changed while reading"):
                    capture_source._read(source, "src/main.cpp", expected)

    def test_explicit_scope_and_sensitive_output_exclusions(self):
        excluded = [".git/config", "build/object.cpp", "dist/SplatView.exe",
                    "src/cache/cached.hpp", "third_party/imgui/.git",
                    "packaging/signing/private.txt", "packaging/certificate.pfx",
                    "docs/credentials.json", "scripts/.env", "unselected/note.txt",
                    "src/omit.hpp"]
        for relative in excluded:
            path = self.source / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"must stay outside source release")
        result = self.capture(exclude=["src/omit.hpp"])
        actual = {item["path"] for item in result["files"]}
        for relative in excluded:
            self.assertNotIn(relative, actual)
            self.assertFalse((self.destination / relative).exists())
        reasons = {item["path"]: item["reason"] for item in result["exclusions"]}
        self.assertIn(".git", reasons)
        self.assertIn("third_party/imgui/.git", reasons)
        self.assertEqual(reasons["src/omit.hpp"], "explicit exclusion")
        self.assertEqual(result["scope"]["explicit_exclusions"], ["src/omit.hpp"])

    def test_refuse_existing_destination_without_changes(self):
        self.destination.mkdir()
        sentinel = self.destination / "user-file.txt"
        sentinel.write_bytes(b"preserve me")
        with self.assertRaisesRegex(capture_source.CaptureError, "existing destination"):
            self.capture()
        self.assertEqual(sentinel.read_bytes(), b"preserve me")
        self.assertEqual(list(self.destination.iterdir()), [sentinel])

    def test_refuse_destination_outside_workspace_and_inside_source(self):
        for destination in (self.workspace.parent / "outside", self.source / "capture"):
            self.destination = destination
            with self.assertRaises(capture_source.CaptureError):
                self.capture()
            self.assertFalse(destination.exists())

    def test_missing_required_source_file_fails_before_reservation(self):
        (self.source / "LICENSE").unlink()
        with self.assertRaisesRegex(capture_source.CaptureError, "Required source file"):
            self.capture()
        self.assertFalse(self.destination.exists())

    def test_missing_required_dependency_fails_before_reservation(self):
        path = self.source / "third_party/spz/fixture.txt"
        path.unlink()
        path.parent.rmdir()
        with self.assertRaises((capture_source.CaptureError, FileNotFoundError)):
            self.capture()
        self.assertFalse(self.destination.exists())

    def test_changed_source_during_copy_fails_without_valid_manifest(self):
        original_read = capture_source._read
        changed = False

        def read(root, relative, expected, output=None):
            nonlocal changed
            result = original_read(root, relative, expected, output)
            if output is not None and not changed:
                changed = True
                with (self.source / "src/main.cpp").open("ab") as stream:
                    stream.write(b"// changed concurrently\n")
            return result

        with patch.object(capture_source, "_read", side_effect=read):
            with self.assertRaises(capture_source.CaptureError):
                self.capture()
        self.failed_snapshot()

    def test_same_size_content_drift_between_passes_detected(self):
        original_inventory = capture_source._inventory
        calls = 0

        def inventory(root, custom=(), *, product_scope=True):
            nonlocal calls
            result = original_inventory(root, custom, product_scope=product_scope)
            if product_scope:
                calls += 1
                if calls == 2:
                    path = self.source / "src/main.cpp"
                    path.write_bytes(path.read_bytes().replace(b"return 0", b"return 1"))
            return result

        with patch.object(capture_source, "_inventory", side_effect=inventory):
            with self.assertRaises(capture_source.CaptureError):
                self.capture()
        self.failed_snapshot()

    def test_removed_source_during_copy_fails_without_valid_manifest(self):
        original_read = capture_source._read
        removed = False

        def read(root, relative, expected, output=None):
            nonlocal removed
            if output is not None and not removed:
                removed = True
                (self.source / "tests/scene.ply").unlink()
            return original_read(root, relative, expected, output)

        with patch.object(capture_source, "_read", side_effect=read):
            with self.assertRaises((capture_source.CaptureError, FileNotFoundError)):
                self.capture()
        self.failed_snapshot()

    def test_added_source_during_copy_fails_without_valid_manifest(self):
        original_read = capture_source._read
        added = False

        def read(root, relative, expected, output=None):
            nonlocal added
            if output is not None and not added:
                added = True
                (self.source / "src/new.hpp").write_bytes(b"// concurrent addition")
            return original_read(root, relative, expected, output)

        with patch.object(capture_source, "_read", side_effect=read):
            with self.assertRaisesRegex(capture_source.CaptureError, "inventory"):
                self.capture()
        self.failed_snapshot()

    def test_dependency_revision_drift_fails(self):
        with patch.object(capture_source, "_revisions", side_effect=[
                {"source": None, "imgui": "a" * 40, "spz": None, "imguizmo": None},
                {"source": None, "imgui": "b" * 40, "spz": None, "imguizmo": None}]):
            with self.assertRaisesRegex(capture_source.CaptureError, "Git revision changed"):
                capture_source.capture(self.source, self.destination, workspace=self.workspace)
        self.failed_snapshot()

    def test_symlink_entries_excluded(self):
        target = self.workspace / "outside.txt"
        target.write_bytes(b"do not copy target")
        link = self.source / "src/linked.hpp"
        directory_link = self.source / "src/linked-dir"
        try:
            link.symlink_to(target)
            directory_link.symlink_to(self.workspace, target_is_directory=True)
        except OSError as error:
            self.skipTest(f"Creating symlinks unavailable: {error}")
        result = self.capture()
        reasons = {item["path"]: item["reason"] for item in result["exclusions"]}
        self.assertEqual(reasons["src/linked.hpp"], "symlink/reparse point")
        self.assertEqual(reasons["src/linked-dir"], "symlink/reparse point")
        self.assertFalse((self.destination / "src/linked.hpp").exists())
        self.assertFalse((self.destination / "src/linked-dir").exists())

    def test_required_symlink_rejected(self):
        target = self.workspace / "license.txt"
        target.write_bytes(b"not an owned source entry")
        original = self.source / "LICENSE"
        original.unlink()
        try:
            original.symlink_to(target)
        except OSError as error:
            self.skipTest(f"Creating symlinks unavailable: {error}")
        with self.assertRaisesRegex(capture_source.CaptureError, "Required source file"):
            self.capture()
        self.assertFalse(self.destination.exists())

    def test_verify_tampered_missing_and_unexpected_file(self):
        self.capture()
        path = self.destination / "src/main.cpp"
        original = path.read_bytes()
        path.write_bytes(original.replace(b"return 0", b"return 1"))
        with self.assertRaisesRegex(capture_source.CaptureError, "hash mismatch"):
            capture_source.verify(self.destination)
        path.unlink()
        with self.assertRaisesRegex(capture_source.CaptureError, "inventory mismatch"):
            capture_source.verify(self.destination)
        path.write_bytes(original)
        (self.destination / "unexpected.hpp").write_bytes(b"unexpected")
        with self.assertRaisesRegex(capture_source.CaptureError, "inventory mismatch"):
            capture_source.verify(self.destination)

    def test_verify_rejects_partial_marker_even_with_manifest(self):
        self.capture()
        (self.destination / capture_source.INCOMPLETE).write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(capture_source.CaptureError, "INCOMPLETE"):
            capture_source.verify(self.destination)

    def test_verify_rejects_traversal_and_duplicate_manifest_paths(self):
        self.capture()
        path = self.destination / capture_source.MANIFEST
        original = path.read_bytes()
        for dangerous in ("../outside.txt", "/absolute", "C:/Windows/file", "src/../file",
                          "src\\file", "src/file:stream", "src/./file", "src//file", "NUL",
                          "src/wild*.hpp", "src/question?.hpp", 'src/quote".hpp'):
            with self.subTest(path=dangerous):
                path.write_bytes(original)
                self.rewrite_manifest(lambda data: data["files"][0].update(path=dangerous))
                with self.assertRaises(capture_source.CaptureError):
                    capture_source.verify(self.destination)
        path.write_bytes(original)
        self.rewrite_manifest(lambda data: data["files"].append(dict(data["files"][0])))
        with self.assertRaisesRegex(capture_source.CaptureError, "Duplicate"):
            capture_source.verify(self.destination)

    def test_refuse_traversal_in_explicit_exclusions(self):
        for path in ("../src", ".", "/", "C:/src"):
            with self.subTest(path=path), self.assertRaises(capture_source.CaptureError):
                self.capture(exclude=[path])
        self.assertFalse(self.destination.exists())

    def test_verify_rejects_invalid_manifest_schema(self):
        self.capture()
        path = self.destination / capture_source.MANIFEST
        original = path.read_bytes()
        for value in ([], None, {"schema_version": 999, "state": "complete"},
                      {"schema_version": 1, "state": "incomplete"}):
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(capture_source.CaptureError, "Unsupported/incomplete"):
                capture_source.verify(self.destination)
        path.write_bytes(original)

    def test_verify_cli(self):
        result = self.capture()
        process = subprocess.run([sys.executable, str(SCRIPT), "verify", str(self.destination)],
                                 capture_output=True, text=True, timeout=30)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout)["tree_sha256"], result["tree_sha256"])
        (self.destination / "LICENSE").write_text("damaged", encoding="utf-8")
        failed = subprocess.run([sys.executable, str(SCRIPT), "verify", str(self.destination)],
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(failed.returncode, 0)
        self.assertIn("hash mismatch", failed.stderr)


if __name__ == "__main__":
    unittest.main()
