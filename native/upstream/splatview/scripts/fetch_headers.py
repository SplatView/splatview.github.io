"""Fetch pinned header dependencies and record their content hashes."""
from pathlib import Path
import hashlib
import json
import urllib.request

root = Path(__file__).resolve().parents[1]
math = "5bbe2ceeec3236c27ad44c877715e1e0f3b9817a"
runtime = "8630d8988107478d249e2fdb8162f8c7dcbd3dbb"
stb = "2c980bb59875b0d32144a71867fbdebb2f77cd20"
pico = "161cb3fc4170fa7a3eca9e582cebd27cc4d1fe29"
files = []
def fetch(repo, revision, source, destination):
    url = f"https://raw.githubusercontent.com/{repo}/{revision}/{source}"
    path = root / "third_party" / destination
    data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "SplatView-port"}), timeout=30).read()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    files.append({"path": path.relative_to(root).as_posix(), "url": url,
                  "sha256": hashlib.sha256(data).hexdigest()})
for name in "DirectXMath.h DirectXMathConvert.inl DirectXMathVector.inl DirectXMathMatrix.inl DirectXMathMisc.inl DirectXPackedVector.h DirectXPackedVector.inl".split():
    fetch("microsoft/DirectXMath", math, "Inc/" + name, "DirectXMath/Inc/" + name)
fetch("microsoft/DirectXMath", math, "LICENSE", "DirectXMath/LICENSE")
fetch("dotnet/runtime", runtime, "src/coreclr/pal/inc/rt/sal.h", "DirectXMath/Inc/sal.h")
fetch("dotnet/runtime", runtime, "LICENSE.TXT", "DirectXMath/SAL-LICENSE.txt")
for name in ("stb_image.h", "stb_image_write.h", "LICENSE"):
    fetch("nothings/stb", stb, name, "stb/" + name)
for name in ("picosha2.h", "LICENSE"):
    fetch("okdshin/PicoSHA2", pico, name, "picosha2/" + name)
(root / "third_party/HEADER_DEPENDENCIES.json").write_text(json.dumps(files, indent=2) + "\n", encoding="utf-8")
print(f"Fetched {len(files)} pinned dependency files.")
