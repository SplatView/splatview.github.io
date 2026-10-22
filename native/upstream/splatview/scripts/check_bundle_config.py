"""Static bundle checks usable without an Apple SDK; not a native build test."""
from pathlib import Path
import argparse
import hashlib
import json
import plistlib
import re
import shutil
import subprocess

root = Path(__file__).resolve().parents[1]
arguments = argparse.ArgumentParser(description=__doc__)
arguments.add_argument("--cmake", default=shutil.which("cmake"))
cmake = arguments.parse_args().cmake
if not cmake:
    arguments.error("Pass --cmake <CMake executable> to verify the SPZ patch closure")
subprocess.run([cmake, f"-DSPLATVIEW_VERIFY_ROOT={root}", "-P", str(root / "cmake/VerifySpz.cmake")], check=True)
values = {"SPLATVIEW_BUNDLE_ID": "com.opsiclear.splatview", "PROJECT_VERSION": "0.1.0",
          "SPLATVIEW_APP_GROUP": "group.com.opsiclear.splatview",
          "APP_GROUP_ENTITLEMENT": "<key>com.apple.security.application-groups</key><array><string>group.com.opsiclear.splatview</string></array>"}

def template(path):
    text = (root / path).read_text(encoding="utf-8")
    text = re.sub(r"@([A-Z_]+)@", lambda match: values[match[1]], text)
    assert not re.search(r"@[A-Z_]+@", text)
    return plistlib.loads(text.encode())

app = template("macos/App/Info.plist.in")
declared = {v["UTTypeIdentifier"] for v in app["UTImportedTypeDeclarations"]}
assert len(declared) == 6
assert set(app["CFBundleDocumentTypes"][0]["LSItemContentTypes"]) == declared
for name, principal in (("Preview", "PreviewViewController"), ("Thumbnail", "ThumbnailProvider")):
    plist = template(f"macos/{name}/Info.plist.in")
    ext = plist["NSExtension"]
    assert plist["CFBundleExecutable"] == "SplatView" + name
    assert ext["NSExtensionPrincipalClass"] == principal
    assert ext["NSExtensionPointIdentifier"] == "com.apple.quicklook." + name.lower()
    assert set(ext["NSExtensionAttributes"]["QLSupportedContentTypes"]) == declared
    assert (root / f"macos/{name}/{principal}.mm").is_file()
    assert plist["SplatViewAppGroup"] == app["SplatViewAppGroup"]
for path in ("macos/App/App.entitlements.in", "macos/Shared/Extension.entitlements.in"):
    assert template(path)["com.apple.security.application-groups"] == [app["SplatViewAppGroup"]]
shader = (root / "macos/Shaders/SplatView.metal").read_text()
adapter = (root / "macos/Shared/SVMetalRenderer.mm").read_text()
for function in ("splatVertex", "splatFragment", "pointVertex", "pointFragment", "meshVertex", "meshFragment", "imageVertex", "imageFragment"):
    assert function in shader and '@"' + function + '"' in adapter
for item in json.loads((root / "third_party/HEADER_DEPENDENCIES.json").read_text()):
    assert hashlib.sha256((root / item["path"]).read_bytes()).hexdigest() == item["sha256"], item["path"]
for item in json.loads((root / "SOURCE_BASELINE.json").read_text())["files"]:
    path = item["destination"]
    if path.startswith(("third_party/", "assets/")) and not path.startswith("third_party/spz/"):
        assert hashlib.sha256((root / path).read_bytes()).hexdigest() == item["sha256"], path
for path in (root / "src/core").glob("*"):
    if path.suffix in (".hpp", ".cpp") and path.name != "language.cpp":
        assert not re.search(r"#\s*include\s*[<\"](?:windows|d3d|wrl|shlobj)", path.read_text(encoding="utf-8"), re.I), path
print("PASS static bundles, shader entry points, pinned dependencies/assets and core platform boundaries")
