"""Import a recorded baseline once; never overwrite adapted files."""
from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
source = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else root.parent / "SplatPreview"
manifest = root / "SOURCE_BASELINE.json"
if manifest.exists():
    raise SystemExit("A baseline already exists; import will not overwrite ported code.")

files = []
def copy(relative, target):
    original = source / relative
    destination = root / target
    if destination.exists():
        raise SystemExit(f"Refusing to overwrite {destination}")
    data = original.read_bytes()
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    files.append({"source": relative.replace("\\", "/"), "destination": target.replace("\\", "/"),
                  "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)})

core = "model.hpp model.cpp format_utils.hpp extra_formats.cpp ply_preview.cpp editing.hpp editing.cpp selection.cpp volume_selection.cpp processing.hpp processing.cpp geometry_tools.hpp geometry_tools.cpp navigation.hpp navigation.cpp scene_exports.hpp scene_exports.cpp export_internal.hpp extra_exports.cpp sog_export.cpp binary_output.hpp parallel_for.hpp depth_sort.hpp color.hpp gsmod_presets.json gsmod_presets.hpp.in tutorial.hpp tools_mode.hpp".split()
for name in core:
    copy("src/" + name, "src/core/" + name)
for name in ("language.hpp", "language.cpp", "translations.inc", "tools_preferences.hpp", "tools_preferences.cpp"):
    copy("src/" + name, "src/core/" + name)
for name in "format_fixtures.hpp format_fixtures.cpp io_contracts.hpp io_contracts.cpp export_contracts.hpp export_contracts.cpp processing_contracts.hpp processing_contracts.cpp geometry_contracts.hpp geometry_contracts.cpp ply_preview_contracts.hpp ply_preview_contracts.cpp".split():
    copy("tests/" + name, "tests/" + name)
for path in sorted((source / "tests/fixtures").glob("*")):
    if path.is_file():
        copy(path.relative_to(source).as_posix(), "tests/fixtures/" + path.name)
copy("tests/contracts.cpp", "tests/format_decode_contracts.cpp")
for folder in ("src/cc", "extensions/cc"):
    for path in sorted((source / "third_party/spz" / folder).rglob("*")):
        if path.is_file():
            relative = path.relative_to(source).as_posix()
            copy(relative, relative)
for name in ("CMakeLists.txt", "LICENSE", "README.md", "cmake/spzConfig.cmake.in"):
    relative = "third_party/spz/" + name
    copy(relative, relative)
for name in "imgui.h imgui_internal.h imconfig.h imgui.cpp imgui_draw.cpp imgui_tables.cpp imgui_widgets.cpp imstb_rectpack.h imstb_textedit.h imstb_truetype.h LICENSE.txt backends/imgui_impl_osx.h backends/imgui_impl_osx.mm backends/imgui_impl_metal.h backends/imgui_impl_metal.mm".split():
    relative = "third_party/imgui/" + name
    copy(relative, relative)
for name in ("ImGuizmo.h", "ImGuizmo.cpp", "LICENSE"):
    relative = "third_party/ImGuizmo/" + name
    copy(relative, relative)
for path in sorted((source / "assets").rglob("*")):
    if path.is_file():
        relative = path.relative_to(source).as_posix()
        copy(relative, relative)
for path in sorted((source / "third_party/format-reference-licenses").glob("*")):
    if path.is_file():
        relative = path.relative_to(source).as_posix()
        copy(relative, relative)
copy("LICENSE", "LICENSE")
copy("THIRD-PARTY-NOTICES.txt", "THIRD-PARTY-NOTICES.txt")

def revision(relative):
    return subprocess.check_output(["git", "-C", str(source / relative), "rev-parse", "HEAD"], text=True).strip()

import re
version = re.search(r"project\(SplatView VERSION ([\d.]+)", (source / "CMakeLists.txt").read_text()).group(1)
imguizmo = re.search(r"ImGuizmo \(MIT\), pinned ([0-9a-f]{40})", (source / "THIRD-PARTY-NOTICES.txt").read_text()).group(1)
for item in files:
    if hashlib.sha256((source / item["source"]).read_bytes()).hexdigest() != item["sha256"]:
        raise SystemExit("Source changed during import; baseline must be reconciled before development.")
manifest.write_text(json.dumps({"source_project": "SplatView", "source_version": version,
    "source_commit": None, "note": "The source repository has no initial commit. File hashes record the imported working tree.",
    "dependencies": {"imgui": revision("third_party/imgui"), "spz": revision("third_party/spz"), "imguizmo": imguizmo},
    "files": files}, indent=2) + "\n", encoding="utf-8")
print(f"Imported {len(files)} files from SplatView {version}; baseline saved to {manifest.name}.")
