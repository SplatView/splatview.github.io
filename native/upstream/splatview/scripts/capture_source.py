"""Capture a stable, read-only SplatView source release without requiring a commit.

This is a bounded working-tree observation, not a filesystem-atomic snapshot.
The selected inventory and every selected file are checked twice. On failure the
new destination retains INCOMPLETE.json and never receives a valid manifest.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import datetime, timezone
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys


WORKSPACE = Path(__file__).resolve().parents[1]
MANIFEST = "SOURCE_SNAPSHOT.json"
INCOMPLETE = "INCOMPLETE.json"
SCHEMA = 1
ROOT_DIRECTORIES = (
    ".github", "assets", "cmake", "design", "docs", "packaging", "scripts",
    "src", "tests", "third_party",
)
ROOT_FILES = (
    ".clang-format", ".clang-tidy", ".editorconfig", ".gitattributes",
    ".gitignore", ".gitmodules", "Build.ps1", "CMakeLists.txt",
    "CMakePresets.json", "CONTRIBUTING.md", "Install-Explorer.ps1", "LICENSE",
    "Package-Store.ps1", "Prepare-StoreSubmission.ps1", "PRIVACY.txt",
    "README.md", "THIRD-PARTY-NOTICES.txt", "Uninstall-Explorer.ps1",
    "vcpkg.json", "vcpkg-configuration.json",
)
REQUIRED_FILES = ("CMakeLists.txt", "LICENSE", "THIRD-PARTY-NOTICES.txt", "vcpkg.json")
REQUIRED_DIRECTORIES = (
    "src", "tests", "assets", "cmake", "packaging", "scripts", "third_party",
    "third_party/imgui", "third_party/spz", "third_party/ImGuizmo",
)
EXCLUDED_DIRECTORIES = (
    ".git", ".hg", ".svn", "build", "build-*", "cmake-build-*", "dist",
    "output", "out", ".deps", ".cache", "cache", "vcpkg_installed",
    "node_modules", "__pycache__", ".venv", "venv", "cmakefiles",
    "credentials", "secrets", "signing", "signing-data",
)
EXCLUDED_FILES = (
    ".git", ".hg", ".svn", ".env", ".env.*", ".netrc", ".npmrc",
    "*.pfx", "*.p12", "*.pem", "*.key", "*.keystore",
    "*.jks", "*.mobileprovision", "*.provisionprofile", "credentials*",
    "secrets*", "*private-key*", "*private_key*", "id_rsa*", "id_ed25519*",
    "*.dll", "*.exe", "*.obj", "*.o", "*.pdb", "*.lib", "*.a", "*.so",
    "*.dylib", "*.metallib", "*.cso", "*.pyc", "CMakeCache.txt",
)


class CaptureError(RuntimeError):
    """The source observation or snapshot failed its contract."""


def _json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _digest(data):
    return hashlib.sha256(data).hexdigest()


def _relative(value):
    """Accept portable manifest paths only; reject traversal and Windows ADS."""
    if not isinstance(value, str) or not value or "\\" in value:
        raise CaptureError(f"Invalid relative path: {value!r}")
    path = PurePosixPath(value)
    if (not path.parts or path.is_absolute() or path.as_posix() != value
            or any(part in (".", "..") or ":" in part for part in path.parts)
            or any(char in '<>"|?*' for char in value)
            or any(ord(char) < 32 or ord(char) == 127 for char in value)):
        raise CaptureError(f"Invalid relative path: {value!r}")
    for part in path.parts:
        stem = part.split(".", 1)[0].upper()
        if (part.endswith((".", " ")) or stem in ("CON", "PRN", "AUX", "NUL")
                or re.fullmatch(r"(?:COM|LPT)[1-9]", stem)):
            raise CaptureError(f"Non-portable relative path: {value!r}")
    return value


def _is_link(info):
    # Windows junctions and other reparse points also need excluding.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & 0x400)


def _signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns, stat.S_IFMT(info.st_mode),
            getattr(info, "st_birthtime_ns", None))


def _same_opened_object(path_signature, descriptor_signature, *, windows=None):
    if windows is None:
        windows = os.name == "nt"
    if windows:
        # Python 3.12 on Windows can expose creation time through path.stat's
        # st_ctime and change time through fstat's st_ctime for the same file.
        # Compare common identity/size/mtime/type/birthtime across these APIs;
        # retain each API's full ctime in its own before/after drift checks.
        return (path_signature[:4] + path_signature[5:]
                == descriptor_signature[:4] + descriptor_signature[5:])
    return path_signature == descriptor_signature


def _descriptor_signature(stream):
    return _signature(os.fstat(stream.fileno()))


def _safe_path(root, relative):
    relative = _relative(relative)
    current = root
    for part in PurePosixPath(relative).parts:
        current = current / part
        info = current.lstat()
        if _is_link(info):
            raise CaptureError(f"Symlink/reparse point appeared: {relative}")
    if not current.resolve().is_relative_to(root):
        raise CaptureError(f"Path escapes source root: {relative}")
    return current


def _excluded(relative, is_directory, custom):
    name = PurePosixPath(relative).name.casefold()
    if any(relative == item or relative.startswith(item + "/") for item in custom):
        return "explicit exclusion"
    patterns = EXCLUDED_DIRECTORIES if is_directory else EXCLUDED_FILES
    if any(fnmatch.fnmatchcase(name, item.casefold()) for item in patterns):
        return "directory policy" if is_directory else "file policy (outputs/credentials/signing)"
    return None


def _inventory(root, custom=(), *, product_scope=True):
    files, exclusions, seen = {}, [], set()

    def visit(directory, prefix=""):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            relative = _relative(prefix + entry.name)
            # DirEntry.stat on Windows can report st_ino/st_dev as zero; use
            # lstat consistently so descriptor identity comparisons are meaningful.
            info = Path(entry.path).lstat()
            if _is_link(info):
                exclusions.append({"path": relative, "reason": "symlink/reparse point"})
                continue
            is_directory = stat.S_ISDIR(info.st_mode)
            reason = None
            if product_scope:
                reason = _excluded(relative, is_directory, custom)
                if not prefix and not reason:
                    allowed = ROOT_DIRECTORIES if is_directory else ROOT_FILES
                    if entry.name not in allowed:
                        reason = "outside explicit root scope"
            if reason:
                exclusions.append({"path": relative, "reason": reason})
                continue
            key = relative.casefold()
            if key in seen:
                raise CaptureError(f"Case-insensitive path collision: {relative}")
            seen.add(key)
            if is_directory:
                visit(Path(entry.path), relative + "/")
            elif stat.S_ISREG(info.st_mode):
                files[relative] = _signature(info)
            else:
                raise CaptureError(f"Unsupported source entry: {relative}")

    visit(root)
    if product_scope:
        for relative in REQUIRED_FILES:
            if relative not in files:
                raise CaptureError(f"Required source file missing/excluded: {relative}")
        for relative in REQUIRED_DIRECTORIES:
            path = _safe_path(root, relative)
            if not path.is_dir() or _excluded(relative, True, custom):
                raise CaptureError(f"Required source directory missing/excluded: {relative}")
            if not any(item.startswith(relative + "/") for item in files):
                raise CaptureError(f"Required source directory is empty: {relative}")
    return files, exclusions


def _read(root, relative, expected, output=None):
    """Hash bytes through an open descriptor and detect replacement/truncation."""
    path = _safe_path(root, relative)
    if _signature(path.lstat()) != expected:
        raise CaptureError(f"Source changed before reading: {relative}")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    digest, size = hashlib.sha256(), 0
    with ExitStack() as stack:
        stream = stack.enter_context(os.fdopen(os.open(path, flags), "rb"))
        opened = _descriptor_signature(stream)
        if not _same_opened_object(expected, opened):
            raise CaptureError(f"Source replaced while opening: {relative}")
        target = stack.enter_context(output.open("xb")) if output is not None else None
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            size += len(chunk)
            if target is not None:
                target.write(chunk)
        if _descriptor_signature(stream) != opened or size != expected[2]:
            raise CaptureError(f"Source changed while reading: {relative}")
    if _signature(_safe_path(root, relative).lstat()) != expected:
        raise CaptureError(f"Source replaced after reading: {relative}")
    return {"path": relative, "bytes": size, "sha256": digest.hexdigest()}


def _git_revision(folder):
    # rev-parse is read-only; unlike status it does not refresh/write an index.
    def run(*arguments):
        result = subprocess.run(
            ["git", "--no-optional-locks", "-C", str(folder), "rev-parse", *arguments],
            capture_output=True, text=True, timeout=15, check=False)
        return result.stdout.strip() if result.returncode == 0 else None
    try:
        top = run("--show-toplevel")
        if top is None or Path(top).resolve() != folder.resolve():
            return None
        head = run("--verify", "HEAD")
        return head if head and re.fullmatch(r"[0-9a-f]{40,64}", head) else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def _revisions(source):
    return {name: _git_revision(source / folder) for name, folder in (
        ("source", "."), ("imgui", "third_party/imgui"),
        ("spz", "third_party/spz"), ("imguizmo", "third_party/ImGuizmo"))}


def _tree_digest(files):
    # Canonical JSON avoids ambiguity in filenames and is independent of timestamps.
    return _digest(json.dumps(files, sort_keys=True, separators=(",", ":"),
                              ensure_ascii=False).encode("utf-8"))


def _source_metadata(destination, revisions):
    cmake = (destination / "CMakeLists.txt").read_text(encoding="utf-8-sig")
    version = re.search(r"project\s*\(\s*SplatView\s+VERSION\s+([0-9.]+)", cmake, re.I)
    if not version:
        raise CaptureError("Cannot read SplatView project version from captured CMakeLists.txt")
    notices = (destination / "THIRD-PARTY-NOTICES.txt").read_text(encoding="utf-8-sig")
    manifest = json.loads((destination / "vcpkg.json").read_text(encoding="utf-8-sig"))
    dependencies = {}
    for name, pattern in (
        ("imgui", r"Dear ImGui[^\n]*?([0-9a-f]{40})"),
        ("spz", r"Niantic SPZ[^\n]*?([0-9a-f]{40})"),
        ("imguizmo", r"ImGuizmo[^\n]*?([0-9a-f]{40})")):
        match = re.search(pattern, notices)
        dependencies[name] = {"git_head": revisions[name],
                              "notice_pin": match.group(1) if match else None}
    dependencies["vcpkg"] = {"builtin_baseline": manifest.get("builtin-baseline"),
                              "manifest_sha256": _digest((destination / "vcpkg.json").read_bytes())}
    return {"project": "SplatView", "version": version.group(1),
            "git_head": revisions["source"], "dependencies": dependencies}


def capture(source, destination, *, workspace=WORKSPACE, baseline=None, exclude=()):
    source, workspace = Path(source).resolve(strict=True), Path(workspace).resolve(strict=True)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink():
        raise CaptureError(f"Refusing existing destination: {destination}")
    # Resolve the existing parent so a destination routed through a junction cannot escape.
    parent = destination.parent.resolve(strict=True)
    destination = parent / destination.name
    if not destination.is_relative_to(workspace) or destination == workspace:
        raise CaptureError("Destination must be a new directory inside this workspace")
    if destination.is_relative_to(source) or source.is_relative_to(destination):
        raise CaptureError("Source and destination must not overlap")
    custom = tuple(sorted(set(_relative(item.rstrip("/")) for item in exclude)))
    baseline = Path(baseline) if baseline is not None else workspace / "SOURCE_BASELINE.json"
    baseline_data = baseline.read_bytes()
    baseline_json = json.loads(baseline_data.decode("utf-8-sig"))
    before, exclusions = _inventory(source, custom)
    revisions = _revisions(source)
    started = datetime.now(timezone.utc).isoformat()
    destination.mkdir()  # Exclusive reservation; never overwrite or delete an existing tree.
    marker = destination / INCOMPLETE
    marker.write_bytes(_json_bytes({"state": "incomplete", "source": str(source),
                                    "started_utc": started}))
    try:
        files = []
        for relative, signature in sorted(before.items()):
            output = destination / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            files.append(_read(source, relative, signature, output))
        after, exclusions_after = _inventory(source, custom)
        if before != after or exclusions != exclusions_after:
            raise CaptureError("Source inventory/metadata changed during capture; retry after edits settle")
        for item in files:
            if _read(source, item["path"], after[item["path"]]) != item:
                raise CaptureError(f"Source bytes changed during capture: {item['path']}")
        final_inventory, final_exclusions = _inventory(source, custom)
        if before != final_inventory or exclusions != final_exclusions:
            raise CaptureError("Source inventory changed during final verification")
        if revisions != _revisions(source):
            raise CaptureError("Source/dependency Git revision changed during capture")
        if baseline.read_bytes() != baseline_data:
            raise CaptureError("Import baseline changed during capture")
        metadata = _source_metadata(destination, revisions)
        result = {"schema_version": SCHEMA, "state": "complete",
                  "started_utc": started, "completed_utc": datetime.now(timezone.utc).isoformat(),
                  "source_directory": str(source), "source": metadata,
                  "import_baseline": {"filename": baseline.name,
                                      "sha256": _digest(baseline_data),
                                      "source_version": baseline_json.get("source_version")},
                  "scope": {"root_directories": list(ROOT_DIRECTORIES), "root_files": list(ROOT_FILES),
                            "required_directories": list(REQUIRED_DIRECTORIES),
                            "required_files": list(REQUIRED_FILES),
                            "excluded_directory_patterns": list(EXCLUDED_DIRECTORIES),
                            "excluded_file_patterns": list(EXCLUDED_FILES),
                            "explicit_exclusions": list(custom),
                            "symlinks": "excluded; required entries must be regular files/directories",
                            "limitations": "Name-based secret filtering; reviewed inputs required. "
                            "Two content passes and three inventories detect observed drift; "
                            "not an atomic filesystem snapshot, signed provenance, dependency download, "
                            "or native build verification."},
                  "exclusions": exclusions, "files": files,
                  "file_count": len(files), "total_bytes": sum(item["bytes"] for item in files),
                  "tree_sha256": _tree_digest(files)}
        # The marker remains until the exact copied tree has independently verified.
        _verify_files(destination, result, allow_incomplete=True)
        with (destination / MANIFEST).open("xb") as stream:
            stream.write(_json_bytes(result))
            stream.flush()
            os.fsync(stream.fileno())
        marker.unlink()
        return result
    except BaseException as error:
        # Leave only our newly-created directory for inspection. No recursive cleanup.
        marker.write_bytes(_json_bytes({"state": "failed", "source": str(source),
                                       "started_utc": started, "error": str(error)}))
        raise


def _verify_files(snapshot, manifest, *, allow_incomplete=False):
    if (not isinstance(manifest, dict) or manifest.get("schema_version") != SCHEMA
            or manifest.get("state") != "complete"):
        raise CaptureError("Unsupported/incomplete source snapshot manifest")
    if not allow_incomplete and (snapshot / INCOMPLETE).exists():
        raise CaptureError("Snapshot retains INCOMPLETE.json; it is not a valid source release")
    records = manifest.get("files")
    if not isinstance(records, list) or not records:
        raise CaptureError("Snapshot manifest has no source files")
    paths, keys = [], set()
    for item in records:
        if not isinstance(item, dict) or set(item) != {"path", "bytes", "sha256"}:
            raise CaptureError("Invalid file record")
        relative = _relative(item["path"])
        if relative in (MANIFEST, INCOMPLETE) or relative.casefold() in keys:
            raise CaptureError(f"Duplicate/reserved manifest path: {relative}")
        keys.add(relative.casefold())
        paths.append(relative)
        if (type(item["bytes"]) is not int or item["bytes"] < 0
                or not isinstance(item["sha256"], str)
                or not re.fullmatch(r"[0-9a-f]{64}", item["sha256"])):
            raise CaptureError(f"Invalid size/hash: {relative}")
    if paths != sorted(paths):
        raise CaptureError("Manifest paths are not in canonical order")
    if (manifest.get("tree_sha256") != _tree_digest(records)
            or manifest.get("file_count") != len(records)
            or manifest.get("total_bytes") != sum(item["bytes"] for item in records)):
        raise CaptureError("Manifest tree digest/count/byte total is inconsistent")
    inventory, exclusions = _inventory(snapshot, product_scope=False)
    if exclusions:
        raise CaptureError("Snapshot contains symlink/reparse entries")
    actual = set(inventory) - {MANIFEST, INCOMPLETE}
    if actual != set(paths):
        raise CaptureError(f"Snapshot inventory mismatch: missing={sorted(set(paths) - actual)}, "
                           f"unexpected={sorted(actual - set(paths))}")
    for item in records:
        if _read(snapshot, item["path"], inventory[item["path"]]) != item:
            raise CaptureError(f"Snapshot hash mismatch: {item['path']}")
    final, excluded_after = _inventory(snapshot, product_scope=False)
    if inventory != final or excluded_after:
        raise CaptureError("Snapshot changed during verification")
    if _source_metadata(snapshot, {"source": manifest["source"]["git_head"],
                                  **{name: manifest["source"]["dependencies"][name]["git_head"]
                                     for name in ("imgui", "spz", "imguizmo")}}) != manifest["source"]:
        raise CaptureError("Source metadata does not match captured build/dependency definitions")


def verify(snapshot):
    snapshot = Path(snapshot).resolve(strict=True)
    path = _safe_path(snapshot, MANIFEST)
    manifest = json.loads(path.read_bytes().decode("utf-8"))
    _verify_files(snapshot, manifest)
    return manifest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    copy = commands.add_parser("capture", help="reserve a NEW destination and capture stable source bytes")
    copy.add_argument("--source", type=Path, default=WORKSPACE.parent / "SplatPreview")
    copy.add_argument("--destination", type=Path, required=True, help="new directory under this workspace; parent must exist")
    copy.add_argument("--baseline", type=Path, default=WORKSPACE / "SOURCE_BASELINE.json")
    copy.add_argument("--exclude", action="append", default=[], metavar="RELATIVE_PATH",
                      help="additional exact relative file/directory exclusion, recorded in manifest")
    check = commands.add_parser("verify", help="verify a captured source tree offline against its manifest")
    check.add_argument("snapshot", type=Path)
    args = parser.parse_args(argv)
    try:
        result = (capture(args.source, args.destination, baseline=args.baseline, exclude=args.exclude)
                  if args.command == "capture" else verify(args.snapshot))
    except (CaptureError, OSError, ValueError, KeyError, TypeError) as error:
        print(f"Source {args.command} failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"command": args.command, "source_version": result["source"]["version"],
                      "file_count": result["file_count"], "tree_sha256": result["tree_sha256"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
