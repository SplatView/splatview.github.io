#!/usr/bin/env python3
"""Verify a sealed product bundle and its local, explicit registry adapter.

No network, sibling paths, automatic source-lock updates or runtime execution.
Generation/import are explicit maintenance commands; verification never writes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

PLATFORMS = ("windows", "macos", "ubuntu", "web")
SURFACES = ("ui", "api", "cli", "internal")
PROFILES = ("desktop-editor", "web-lite")
HOSTS = ("editor", "windows-explorer-preview", "macos-quicklook-preview",
         "ubuntu-gnome-preview", "ubuntu-kde-preview", "thumbnail-provider")
BUNDLE = Path(__file__).resolve().parent


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def read(path: Path):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate JSON key: {key} in {path}")
            result[key] = value
        return result
    return json.loads(path.read_text(encoding="utf-8-sig"), object_pairs_hook=pairs)


def local(root: Path, name: str) -> Path:
    if not isinstance(name, str) or not name or "\\" in name or ":" in name:
        raise ValueError(f"Expected a repository-relative path: {name!r}")
    result = (root / name).resolve()
    if not result.is_relative_to(root.resolve()) or not result.is_file():
        raise ValueError(f"Missing or escaping local file: {name}")
    return result


def put(path: Path, text: str, check: bool):
    data = text.encode("utf-8")
    if path.is_file() and path.read_bytes() == data:
        return
    if check:
        if not path.is_file() or path.read_bytes() != data:
            raise ValueError(f"Stale generated projection: {path}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def payloads(bundle: Path):
    return {p.relative_to(bundle).as_posix(): digest(p.read_bytes())
            for p in sorted(bundle.rglob("*"), key=lambda p: p.relative_to(bundle).as_posix()) if p.is_file()
            and p.name != "manifest.json" and "__pycache__" not in p.parts}


def manifest_files(bundle: Path):
    return [{"path": name, "sha256": sha} for name, sha in payloads(bundle).items()]


def catalog(bundle: Path):
    data = read(bundle / "features.json")
    if data.get("schemaVersion") != 1:
        raise ValueError("Unsupported feature schema")
    features = {}
    for f in data["features"]:
        name = f["id"]
        if not re.fullmatch(r"[a-z][a-z0-9_.-]+", name) or name in features:
            raise ValueError(f"Invalid/duplicate feature ID: {name}")
        if not f["surfaces"] or not set(f["surfaces"]) <= set(SURFACES):
            raise ValueError(f"Invalid surfaces: {name}")
        if set(f["platforms"]) != set(PLATFORMS):
            raise ValueError(f"All four platform decisions are required: {name}")
        for platform, decision in f["platforms"].items():
            if decision["policy"] not in ("required", "conditional", "excluded") or not decision["reason"].strip():
                raise ValueError(f"Invalid policy/reason: {name}/{platform}")
            if decision["policy"] == "conditional" and (not decision["requires"] or not decision["fallback"].strip()):
                raise ValueError(f"Conditional policy needs runtime requirements and fallback: {name}/{platform}")
            if decision["policy"] != "conditional" and decision["requires"]:
                raise ValueError(f"Unexpected runtime requirements: {name}/{platform}")
        if not set(f["hosts"]) <= set(HOSTS) or "editor" not in f["hosts"]:
            raise ValueError(f"Invalid host allowlist: {name}")
        local(bundle, f["review"])
        features[name] = f
    profiles = read(bundle / "profiles.json")
    if set(profiles["profiles"]) != set(PROFILES):
        raise ValueError("Missing product profile")
    for profile, value in profiles["profiles"].items():
        if not set(value["platforms"]) <= set(PLATFORMS) or not value["platforms"]:
            raise ValueError(f"Invalid profile platforms: {profile}")
    for topic in read(bundle / "tutorial.json")["topics"]:
        if not topic["features"] or not set(topic["features"]) <= features.keys():
            raise ValueError(f"Unknown tutorial dependency: {topic['id']}")
        if any("ui" not in features[f]["surfaces"] for f in topic["features"]):
            raise ValueError(f"API-only feature in ordinary tutorial: {topic['id']}")
    for name, value in read(bundle / "tokens.json")["logicalPixels"].items():
        if not isinstance(value, (float, int)) or isinstance(value, bool) or value <= 0:
            raise ValueError(f"Invalid logical geometry token: {name}")
    return features, profiles["profiles"]


def decision(features, profiles, feature, platform, profile, surface, host="editor", capabilities=()):
    f = features.get(feature)
    if not f or platform not in PLATFORMS or profile not in profiles or surface not in SURFACES or host not in HOSTS:
        return "unknown"
    if platform not in profiles[profile]["platforms"]:
        return "profile_excluded"
    if host != "editor" and surface == "api":
        return "host_excluded"
    if host not in f["hosts"]:
        return "host_excluded"
    if surface not in f["surfaces"]:
        return "surface_excluded"
    policy = f["platforms"][platform]
    if policy["policy"] == "excluded":
        return "platform_excluded"
    if not set(policy["requires"]) <= set(capabilities):
        return "condition_missing"
    return "allowed"


def declarations(root: Path, adapter):
    """Small explicit grammars; unsupported syntax fails rather than skipping it."""
    result = {}
    for source in adapter["inventories"]:
        path = local(root, source["path"])
        text = path.read_text(encoding="utf-8-sig")
        mode, prefix = source["syntax"], source["prefix"]
        rows = []
        if mode == "enum":
            found = re.findall(r"enum\s+class\s+" + re.escape(source["name"]) + r"\s*\{([^}]+)\}", text, re.S)
            if len(found) != 1:
                raise ValueError(f"Expected one enum: {path}/{source['name']}")
            body = re.sub(r"//[^\n]*|/\*.*?\*/", "", found[0], flags=re.S)
            for value in body.split(","):
                value = value.strip()
                if not value:
                    continue
                match = re.fullmatch(r"([A-Za-z_]\w*)(?:\s*=\s*\d+)?", value)
                if not match:
                    raise ValueError(f"Unsupported enum member: {value}")
                if "=" in value and int(value.split("=")[1]) != len(rows):
                    raise ValueError(f"Nonsequential enum needs an explicit value adapter: {value}")
                rows.append((match[1], value))
        elif mode == "macro":
            macro = source["name"]
            for line in text.splitlines():
                if re.match(r"\s*" + re.escape(macro) + r"\(", line):
                    match = re.fullmatch(r"\s*" + re.escape(macro) + r"\(\s*(\w+)\s*,(.*)\)\s*", line)
                    if not match:
                        raise ValueError(f"Unsupported registration: {line}")
                    rows.append((match[1], line.strip()))
        elif mode == "string-union":
            match = re.search(r"export\s+type\s+" + re.escape(source["name"]) + r"\s*=([^;]+);", text, re.S)
            if not match:
                raise ValueError(f"Missing typed union: {path}/{source['name']}")
            for item in match[1].split("|"):
                value = item.strip()
                if not re.fullmatch(r"'[a-zA-Z0-9_-]+'", value):
                    raise ValueError(f"Unsupported string union member: {value}")
                rows.append((value[1:-1], value))
        elif mode == "wasm-commands":
            # Native command dispatch is the final worker boundary, including commands
            # passed through generic SceneCommand objects by the UI controller.
            names = set(re.findall(r'command\s*==\s*"([A-Za-z0-9_]+)"', text))
            if len(names) < 10:
                raise ValueError(f"Native command dispatch was not found: {path}")
            rows.extend((name, name) for name in sorted(names))
        elif mode == "string-array":
            match = re.search(r"export\s+const\s+" + re.escape(source["name"]) +
                              r"\s*=\s*Object\.freeze\(\[([^]]+)\]", text, re.S)
            if not match:
                raise ValueError(f"Missing named string array: {path}/{source['name']}")
            for item in match[1].split(","):
                value = item.strip()
                if not value:
                    continue
                if not re.fullmatch(r"'[a-zA-Z0-9_-]+'", value):
                    raise ValueError(f"Unsupported string array member: {value}")
                rows.append((value[1:-1], value))
        elif mode == "cpp-string-array":
            match = re.search(r"std::array<std::string_view,\s*(\d+)>\s+" + re.escape(source["name"]) + r"\s*\{([^}]+)\}", text, re.S)
            if not match:
                raise ValueError(f"Missing named C++ string array: {path}/{source['name']}")
            for item in match[2].split(","):
                value = item.strip()
                if not value:
                    continue
                if not re.fullmatch(r'"[a-zA-Z0-9_-]+"', value):
                    raise ValueError(f"Unsupported C++ string array member: {value}")
                rows.append((value[1:-1], value))
            if len(rows) != int(match[1]):
                raise ValueError(f"C++ string array size disagrees with its declarations: {path}")
        elif mode == "windows-export":
            # Reuse the successful Windows guard. A second regex parser must not
            # weaken its source-family, test-registration or publication checks.
            with tempfile.TemporaryDirectory(prefix="splatview-product-") as directory:
                output = Path(directory) / "inventory.json"
                command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                           str(path), "-SourceDirectory", str(root), "-InventoryPath", str(output)]
                run = subprocess.run(command, capture_output=True, text=True, timeout=90)
                if run.returncode:
                    raise ValueError(f"Existing Windows inventory guard failed: {run.stdout}{run.stderr}")
                inventory = read(output)
            if inventory["schemaVersion"] != 1:
                raise ValueError("Unsupported existing Windows inventory export")
            for row in inventory["features"]:
                rows.append((row["id"], row["declaration"]))
        else:
            raise ValueError(f"Unknown inventory grammar: {mode}")
        if not rows:
            raise ValueError(f"Empty registry: {path}")
        for ordinal, (name, value) in enumerate(rows):
            key = prefix + name
            if key in result:
                raise ValueError(f"Duplicate registration: {key}")
            # Include ordinal for public compatibility enums. An insertion or
            # reordering must be reviewed even if member names stay unchanged.
            position = str(ordinal) + ":" if mode == "enum" else ""
            tokens = re.findall(r'"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|\S', value)
            result[key] = digest((position + "".join(tokens)).encode())
    return result


def projections(bundle, features, profiles, adapter):
    tokens = read(bundle / "tokens.json")["logicalPixels"]
    rows = []
    for name, f in features.items():
        for platform in PLATFORMS:
            for profile in PROFILES:
                for surface in SURFACES:
                    for host in HOSTS:
                        reason = decision(features, profiles, name, platform, profile, surface, host)
                        required = f["platforms"][platform]["requires"] if reason == "condition_missing" else []
                        if reason in ("allowed", "condition_missing"):
                            rows.append((name, platform, profile, surface, host, ",".join(required)))
    compact = json.dumps(rows, separators=(",", ":"))
    cpp = """// Generated by contracts/product/tool.py. Do not edit.
#pragma once
#include <array>
#include <cstddef>
#include <string_view>
namespace splatview::product {
struct Availability { std::string_view feature, platform, profile, surface, host, requiresAll; };
inline constexpr std::array availability{
"""
    cpp += ",\n".join("    Availability{" + ", ".join(json.dumps(v) for v in row) + "}" for row in rows)
    cpp += """
};
inline bool allowed(std::string_view feature, std::string_view platform, std::string_view profile,
                    std::string_view surface, std::string_view host = "editor",
                    std::string_view capabilities = {}) {
    for (const auto &row : availability) {
        if (row.feature != feature || row.platform != platform || row.profile != profile ||
            row.surface != surface || row.host != host) continue;
        auto required = row.requiresAll;
        while (!required.empty()) {
            const auto comma = required.find(',');
            const auto key = required.substr(0, comma);
            bool found = false;
            auto supplied = capabilities;
            while (!supplied.empty()) {
                const auto end = supplied.find(',');
                found |= supplied.substr(0, end) == key;
                if (end == std::string_view::npos) break;
                supplied.remove_prefix(end + 1);
            }
            if (!found) return false;
            if (comma == std::string_view::npos) break;
            required.remove_prefix(comma + 1);
        }
        return true;
    }
    return false;
}
namespace tokens {
"""
    cpp += "".join(f"inline constexpr float {key} = {value}f;\n" if isinstance(value, float)
                   else f"inline constexpr float {key} = {value}.0f;\n" for key, value in tokens.items())
    cpp += "} // namespace tokens\n} // namespace splatview::product\n"
    ts = "// Generated by contracts/product/tool.py. Do not edit.\n"
    ts += f"const availability = {compact} as const;\n"
    ts += """export function productAllowed(feature: string, platform: string, profile: string,
  surface: string, host = 'editor', capabilities: readonly string[] = []): boolean {
  return availability.some(row => row[0] === feature && row[1] === platform && row[2] === profile &&
    row[3] === surface && row[4] === host && (!row[5] || row[5].split(',').every(c => capabilities.includes(c))));
}
"""
    ts += "export const productTokens = " + json.dumps(tokens) + " as const;\n"
    topics = read(bundle / "tutorial.json")["topics"]
    ts += "export const productTopics = " + json.dumps(topics) + " as const;\n"
    generated = {"include/splatview_product/policy.hpp": cpp, "generated/policy.ts": ts}
    if adapter:
        bindings = adapter["bindings"]
        cpp = """// Generated local binding projection. Do not edit.
#pragma once
#include <splatview_product/policy.hpp>
namespace splatview::product {
inline std::string_view registeredFeature(std::string_view binding) {
"""
        cpp = cpp.replace('inline std::string_view registeredFeature',
            f'inline constexpr std::string_view localPlatform = {json.dumps(adapter["platform"])};\n'
            f'inline constexpr std::string_view bundleSha256 = {json.dumps(adapter["bundleSha256"])};\n'
            'inline std::string_view registeredFeature')
        for key, row in sorted(bindings.items()):
            cpp += f"    if (binding == {json.dumps(key)}) return {json.dumps(row['feature'])};\n"
        cpp += '    return {};\n}\ninline bool registeredAllowed(std::string_view binding, std::string_view surface,\n'
        cpp += '    std::string_view host = "editor", std::string_view capabilities = {}) {\n'
        for host, overrides in adapter.get("hostBindings", {}).items():
            for key, feature in overrides.items():
                cpp += f"    if (surface == \"ui\" && host == {json.dumps(host)} && binding == {json.dumps(key)})\n"
                cpp += f"        return allowed({json.dumps(feature)}, {json.dumps(adapter['platform'])}, {json.dumps(adapter['profile'])}, surface, host, capabilities);\n"
        cpp += f"    return allowed(registeredFeature(binding), {json.dumps(adapter['platform'])}, {json.dumps(adapter['profile'])}, surface, host, capabilities);\n"
        cpp += "}\n} // namespace splatview::product\n"
        enum_cpp = ''
        for source in adapter["inventories"]:
            if source["syntax"] != "enum":
                continue
            prefix = source["prefix"]
            keys = [key for key in bindings if key.startswith(prefix)]
            enum_cpp += f"    if (group == {json.dumps(source['name'])}) {{\n        switch (value) {{\n"
            for i, key in enumerate(keys):
                enum_cpp += f"        case {i}: return registeredAllowed({json.dumps(key)}, surface, host, capabilities);\n"
            enum_cpp += "        default: return false;\n        }\n    }\n"
        cpp = cpp.replace('} // namespace splatview::product\n',
            'inline bool registeredEnumAllowed(std::string_view group, std::size_t value, std::string_view surface,\n'
            '    std::string_view host = "editor", std::string_view capabilities = {}) {\n' + enum_cpp +
            '    return false;\n}\n} // namespace splatview::product\n')
        ts = "// Generated local binding projection. Do not edit.\n"
        ts += "import { productAllowed } from './product-policy';\n"
        ts += f"export const productContractPin = {json.dumps(adapter['bundleSha256'])};\n"
        ts += "export const productBindings: Readonly<Record<string, string>> = "
        ts += json.dumps({key: row["feature"] for key, row in sorted(bindings.items())}, indent=2) + ";\n"
        ts += "export function registeredAllowed(binding: string, surface = 'ui', capabilities: readonly string[] = []): boolean {\n"
        ts += f"  return productAllowed(productBindings[binding] ?? '', '{adapter['platform']}', '{adapter['profile']}', surface, 'editor', capabilities);\n}}\n"
        generated["adapter.hpp"] = cpp
        generated["adapter.ts"] = ts
    return generated


def verify_bundle(bundle):
    manifest = read(bundle / "manifest.json")
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", str(manifest.get("contractVersion", ""))):
        raise ValueError("Invalid contract semantic version")
    if manifest.get("schemaVersion") != 1 or manifest["files"] != manifest_files(bundle):
        raise ValueError("Contract bundle payload differs from its sealed manifest")
    features, profiles = catalog(bundle)
    for name, content in projections(bundle, features, profiles, None).items():
        put(bundle / name, content, True)
    return features, profiles


def verify_adapter(root, bundle, features, profiles, *, generate=False):
    path = root / "contracts/product-adapter.json"
    adapter = read(path)
    if adapter.get("schemaVersion") != 1:
        raise ValueError("Unsupported product adapter schema")
    pin = adapter["bundleSha256"]
    if pin != digest((bundle / "manifest.json").read_bytes()):
        raise ValueError("Consumer bundle pin does not match the sealed bundle")
    if adapter["platform"] not in PLATFORMS or adapter["profile"] not in profiles:
        raise ValueError("Invalid consumer platform/profile")
    inventory = declarations(root, adapter)
    if inventory.keys() != adapter["bindings"].keys():
        raise ValueError(f"Unreviewed/missing registrations: {sorted(inventory.keys() - adapter['bindings'].keys())}; "
                         f"retired without review: {sorted(adapter['bindings'].keys() - inventory.keys())}")
    for key, fingerprint in inventory.items():
        row = adapter["bindings"][key]
        if row["feature"] not in features or row["fingerprint"] != fingerprint:
            raise ValueError(f"Unreviewed/changed registration: {key}")
        review = local(root, row["review"])
        if digest(review.read_bytes()) != row["reviewSha256"]:
            raise ValueError(f"Review pin changed: {key}")
    for host, overrides in adapter.get("hostBindings", {}).items():
        if host not in HOSTS or host == "editor":
            raise ValueError(f"Invalid contextual host binding: {host}")
        for key, feature in overrides.items():
            if key not in inventory or not key.startswith("UiActionKind.") or feature not in features:
                raise ValueError(f"Invalid contextual UI binding: {host}/{key}")
    ledger = root / "design/feature-reviews/feature-coverage.json"
    if adapter["platform"] == "windows" and ledger.is_file():
        for record in read(ledger)["features"]:
            if record["id"] not in features:
                continue
            shared = features[record["id"]]
            if set(record["surfaces"]) != set(shared["surfaces"]) or any(
                record["platforms"][platform]["policy"] != shared["platforms"][platform]["policy"]
                for platform in PLATFORMS):
                raise ValueError(f"Review ledger and runtime policy disagree: {record['id']}")
    generated = projections(bundle, features, profiles, adapter)
    for name, content in generated.items():
        if name == "adapter.hpp":
            target = root / "contracts/generated/product_adapter.hpp"
        elif name == "adapter.ts":
            target = root / "src/generated/product-adapter.ts" if adapter["platform"] == "web" else None
        elif name == "generated/policy.ts":
            target = root / "src/generated/product-policy.ts" if adapter["platform"] == "web" else None
        else:
            target = None
        if target:
            put(target, content, not generate)
    return len(inventory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("verify", "generate", "seal", "import", "inventory"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--bundle", type=Path, default=BUNDLE)
    parser.add_argument("--from-bundle", type=Path)
    parser.add_argument("--pin")
    parser.add_argument("--contract-version", help="Producer semantic version for seal; preserves existing version by default")
    args = parser.parse_args()
    bundle = args.bundle.resolve()
    if args.command == "import":
        if not args.root or not args.from_bundle or not args.pin:
            parser.error("import requires --root, --from-bundle and an explicit --pin")
        source = args.from_bundle.resolve()
        verify_bundle(source)
        if args.pin != digest((source / "manifest.json").read_bytes()):
            raise ValueError("Import pin mismatch")
        target = args.root.resolve() / "contracts/product"
        target.mkdir(parents=True, exist_ok=True)
        expected = {*payloads(source), "manifest.json"}
        existing = {p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
        if existing - expected:
            raise ValueError("Import would leave unexpected files; review the obsolete files explicitly")
        for name in sorted(expected):
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, destination)
        verify_bundle(target)
        print(encoded({"imported": args.pin, "runtimeQualification": False}))
        return
    if args.command == "inventory":
        if not args.root:
            parser.error("inventory requires --root")
        root = args.root.resolve()
        print(encoded(declarations(root, read(root / "contracts/product-adapter.json"))))
        return
    if args.contract_version and args.command != "seal":
        parser.error("--contract-version is only valid with seal")
    if args.command == "seal":
        version = args.contract_version or (read(bundle / "manifest.json").get("contractVersion", "1.0.0")
                                             if (bundle / "manifest.json").is_file() else "1.0.0")
        if not re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", version):
            raise ValueError("Invalid contract semantic version")
        features, profiles = catalog(bundle)
        for name, content in projections(bundle, features, profiles, None).items():
            put(bundle / name, content, False)
        put(bundle / "manifest.json", encoded({"schemaVersion": 1, "contractVersion": version,
            "files": manifest_files(bundle)}), False)
    features, profiles = verify_bundle(bundle)
    count = None
    if args.root:
        count = verify_adapter(args.root.resolve(), bundle, features, profiles, generate=args.command == "generate")
    print(encoded({"valid": True, "contractVersion": read(bundle / "manifest.json")["contractVersion"],
        "bundleSha256": digest((bundle / "manifest.json").read_bytes()), "registrations": count,
        "nativeQualification": False}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        print(f"Product bundle check failed: {error}", file=sys.stderr)
        sys.exit(1)
