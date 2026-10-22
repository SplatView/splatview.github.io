"""Negative contracts for the explicit SPZ patch closure; no real vendor edits."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

VERIFY = Path(__file__).resolve().parents[1] / "cmake/VerifySpz.cmake"
CMAKE = sys.argv[1]
GENERATOR = sys.argv[2] if len(sys.argv) > 2 else None
MAKE_PROGRAM = sys.argv[3] if len(sys.argv) > 3 else None
sys.argv = sys.argv[:1]


def digest(data):
    return hashlib.sha256(data).hexdigest()


class VendorIntegrityContracts(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="spz-integrity-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.vendor = self.root / "third_party/spz"
        self.vendor.mkdir(parents=True)
        self.original = {"third_party/spz/load.cc": b"original decode\n",
                         "third_party/spz/load.h": b"original API\n",
                         "third_party/spz/LICENSE": b"MIT license\n"}
        baseline = {"dependencies": {"spz": "recorded-upstream-commit"},
                    "files": [{"destination": path, "sha256": digest(data)}
                              for path, data in self.original.items()]}
        encoded = (json.dumps(baseline, indent=2) + "\n").encode()
        (self.root / "SOURCE_BASELINE.json").write_bytes(encoded)
        for path, data in self.original.items():
            (self.root / path).write_bytes(data)
        modified = b"decode with caller-owned buffers\n"
        (self.vendor / "load.cc").write_bytes(modified)
        notice = b"Local decode patch. Preserve MIT notice.\n"
        (self.vendor / "LOCAL_CHANGES.md").write_bytes(notice)
        self.lock = {
            "schemaVersion": 1, "upstreamCommit": baseline["dependencies"]["spz"],
            "baselineSha256": digest(encoded),
            "sourceFiles": [{"path": path, "upstreamSha256": digest(data),
                             "sha256": digest((self.root / path).read_bytes()),
                             "bytes": (self.root / path).stat().st_size}
                            for path, data in self.original.items()],
            "changes": [{"path": "third_party/spz/load.cc", "reason": "Caller-owned decode"}],
            "auxiliaryFiles": [{"path": "third_party/spz/LOCAL_CHANGES.md",
                                "sha256": digest(notice), "bytes": len(notice)}],
        }

    def verify(self, expected=True):
        (self.vendor / "LOCAL_PATCHES.json").write_text(json.dumps(self.lock), encoding="utf-8")
        result = subprocess.run([CMAKE, f"-DSPLATVIEW_VERIFY_ROOT={self.root}", "-P", str(VERIFY)],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode == 0, expected, result.stdout + result.stderr)
        return result.stdout + result.stderr

    def test_complete_modified_and_unchanged_closure_passes(self):
        self.verify()

    def test_source_and_license_tampering_rejected(self):
        for path in self.original:
            with self.subTest(path=path):
                target = self.root / path
                original = target.read_bytes()
                target.write_bytes(original + b"unreviewed change")
                self.assertIn("Locked SPZ source changed", self.verify(False))
                target.write_bytes(original)

    def test_omitted_duplicate_and_foreign_source_paths_rejected(self):
        original = copy.deepcopy(self.lock)
        mutations = (
            lambda lock: lock["sourceFiles"].pop(),
            lambda lock: lock["sourceFiles"].__setitem__(1, copy.deepcopy(lock["sourceFiles"][0])),
            lambda lock: lock["sourceFiles"][0].__setitem__("path", "third_party/spz/unlisted.cc"),
            lambda lock: lock["sourceFiles"][0].__setitem__("path", "third_party/spz/../escape.cc"),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.lock = copy.deepcopy(original)
                mutate(self.lock)
                self.verify(False)

    def test_wrong_original_baseline_commit_and_schema_rejected(self):
        original = copy.deepcopy(self.lock)
        for field, value in (("baselineSha256", "0" * 64),
                             ("upstreamCommit", "another-commit"), ("schemaVersion", 2)):
            with self.subTest(field=field):
                self.lock = copy.deepcopy(original)
                self.lock[field] = value
                self.verify(False)
        self.lock = copy.deepcopy(original)
        self.lock["sourceFiles"][0]["upstreamSha256"] = "0" * 64
        self.assertIn("immutable baseline", self.verify(False))

    def test_changed_file_list_is_exact_and_requires_reason(self):
        original = copy.deepcopy(self.lock)
        mutations = (
            lambda lock: lock["changes"].clear(),
            lambda lock: lock["changes"].append(copy.deepcopy(lock["changes"][0])),
            lambda lock: lock["changes"][0].__setitem__("path", "third_party/spz/LICENSE"),
            lambda lock: lock["changes"][0].__setitem__("reason", " \t\n"),
        )
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.lock = copy.deepcopy(original)
                mutate(self.lock)
                self.verify(False)

    def test_auxiliary_notice_is_locked(self):
        path = self.vendor / "LOCAL_CHANGES.md"
        path.write_bytes(path.read_bytes() + b"unreviewed notice")
        self.assertIn("notice changed", self.verify(False))

    def test_missing_and_extra_vendor_files_rejected(self):
        extra = self.vendor / "unreviewed.cc"
        extra.write_bytes(b"extra compilation input")
        self.assertIn("inventory differs", self.verify(False))
        extra.unlink()
        (self.vendor / "load.h").unlink()
        self.verify(False)

    def test_invalid_hash_and_byte_length_rejected(self):
        original = copy.deepcopy(self.lock)
        for field, value in (("sha256", "not-a-hash"), ("bytes", -1), ("bytes", 9999)):
            with self.subTest(field=field, value=value):
                self.lock = copy.deepcopy(original)
                self.lock["sourceFiles"][0][field] = value
                self.verify(False)

    @unittest.skipIf(GENERATOR is None, "Configure/build generator was not supplied")
    def test_build_rechecks_changed_header_and_manifest(self):
        self.verify()
        project = ("cmake_minimum_required(VERSION 3.25)\n"
                   "project(SpzIntegrityFixture NONE)\n"
                   f"include([==[{VERIFY.as_posix()}]==])\n"
                   "splatview_verify_spz(\"${CMAKE_CURRENT_SOURCE_DIR}\")\n"
                   "file(APPEND \"${CMAKE_BINARY_DIR}/configure-marker\" \"configured\\n\")\n")
        (self.root / "CMakeLists.txt").write_text(project, encoding="utf-8")
        build = self.root / "build"
        command = [CMAKE, "-S", str(self.root), "-B", str(build), "-G", GENERATOR]
        if MAKE_PROGRAM:
            command.append(f"-DCMAKE_MAKE_PROGRAM={MAKE_PROGRAM}")
        configured = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(configured.returncode, 0, configured.stdout + configured.stderr)
        marker = build / "configure-marker"
        original_count = len(marker.read_text().splitlines())
        header = self.vendor / "load.h"
        original = header.read_bytes()
        header.write_bytes(original + b"unreviewed header change\n")
        command = [CMAKE, "--build", str(build), "--config", "Release"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Locked SPZ source changed", result.stdout + result.stderr)
        header.write_bytes(original)
        self.lock["changes"][0]["reason"] = "Reviewed caller-owned decode update"
        (self.vendor / "LOCAL_PATCHES.json").write_text(json.dumps(self.lock), encoding="utf-8")
        result = subprocess.run(command, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertGreater(len(marker.read_text().splitlines()), original_count)


if __name__ == "__main__":
    unittest.main()
