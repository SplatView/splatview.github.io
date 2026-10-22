"""Capture an immutable, verified upstream source package; never edit siblings.

This is a dependency snapshot, not a new independently maintained core. Browser
adaptations live outside it and must be upstreamable patches. A new upstream
revision requires a new destination and reviewed manifest, never a silent sync.
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
LOCK = ROOT / 'native' / 'SOURCE_LOCK.json'
PACKAGES = {
    'splatview': {
        'source': ROOT.parent / 'splatview_macos',
        'destination': ROOT / 'native/upstream/splatview',
        'directories': ['src', 'shared', 'cmake', 'third_party', 'tests', 'scripts', 'assets'],
        'files': ['CMakeLists.txt', 'CMakePresets.json', 'LICENSE', 'THIRD-PARTY-NOTICES.txt',
                  'THIRD_PARTY_PORT_NOTICES.txt', 'vcpkg.json', 'SOURCE_REFERENCE.json'],
    },
    'windows-reference': {
        'source': ROOT.parent / 'splatpreview',
        'destination': ROOT / 'reference/windows',
        'directories': ['src', 'cmake', 'third_party', 'tests', 'assets', 'design'],
        'files': ['CMakeLists.txt', 'LICENSE', 'README.md'],
    },
}

# Reviewed artwork from finite desktop captures. This is a
# publication override only: SOURCE_LOCK and reference/windows retain their
# historical bytes. Neither a modified capture nor a self-updated manifest can
# silently authorize another icon. All other public artwork uses the lock.
REVIEWED_ICON_OVERRIDES = {
    'pivot-center.svg': {
        'captureRoot': 'reference/targets/windows-r0-20261012-02',
        'schemaVersion': 1,
        'kind': 'splatview-windows-source-capture',
        'captureId': 'cc71f0df-8f38-4900-8aff-5c9ee0d6814c',
        'record': {
            'path': 'assets/icons/pivot-center.svg',
            'bytes': 260,
            'sha256': '371619a63f9a803ed520beb9319639e36963d7c4f5c8034790774bd29c500142',
        },
    },
    'pivot-selection.svg': {
        'captureRoot': 'reference/targets/windows-pivot-20261016-01',
        'schemaVersion': 1,
        'kind': None,
        'captureId': 'windows-pivot-20261016-01',
        'desktopCommit': '4e1be155511fb49f08fd8c863d785ac008a4c43a',
        'desktopVersion': '1.0.2',
        'record': {
            'path': 'assets/icons/pivot-selection.svg',
            'bytes': 324,
            'sha256': 'f85caf6effc4aa768ee08734ca0c5106081d30983dd6e14dc9bc17c51e78fcf7',
        },
    },
    'pivot-origin.svg': {
        'captureRoot': 'reference/targets/windows-pivot-20261016-01',
        'schemaVersion': 1,
        'kind': None,
        'captureId': 'windows-pivot-20261016-01',
        'desktopCommit': '4e1be155511fb49f08fd8c863d785ac008a4c43a',
        'desktopVersion': '1.0.2',
        'record': {
            'path': 'assets/icons/pivot-origin.svg',
            'bytes': 312,
            'sha256': 'd5357c49ada218878f065839a7098b6199048104bf61d5e62a4168bfbf891957',
        },
    },
}

def digest(data):
    return hashlib.sha256(data).hexdigest()

def _unique_manifest_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f'Duplicate capture manifest field: {key}')
        value[key] = item
    return value

def _regular_capture_file(path):
    return path.is_file() and not path.is_symlink() and path.resolve() == path.absolute()

def reviewed_icon_sources(failures):
    """Read only explicitly pinned capture leaves; never walk their source tree."""
    sources = {}
    for name, override in REVIEWED_ICON_OVERRIDES.items():
        capture_root = ROOT / override['captureRoot']
        manifest_path = capture_root / 'CAPTURE_MANIFEST.json'
        record = override['record']
        source_path = capture_root / 'source' / record['path']
        try:
            if not _regular_capture_file(manifest_path):
                raise ValueError('Capture manifest must be an unaliased regular file')
            capture_manifest = json.loads(manifest_path.read_text(encoding='utf-8'),
                                          object_pairs_hook=_unique_manifest_object)
            if (not isinstance(capture_manifest, dict) or
                    type(capture_manifest.get('schemaVersion')) is not int or
                    capture_manifest.get('schemaVersion') != override['schemaVersion'] or
                    capture_manifest.get('kind') != override['kind'] or
                    capture_manifest.get('captureId') != override['captureId'] or
                    any(capture_manifest.get(field) != override[field]
                        for field in ('desktopCommit', 'desktopVersion') if field in override)):
                raise ValueError('Capture manifest identity differs from reviewed override')
            entries = capture_manifest.get('files')
            if (not isinstance(entries, list) or
                    any(not isinstance(entry, dict) or not isinstance(entry.get('path'), str)
                        for entry in entries)):
                raise ValueError('Capture manifest file index is invalid')
            matches = [entry for entry in entries
                       if entry['path'].casefold() == record['path'].casefold()]
            if len(matches) != 1 or matches[0] != record or type(matches[0].get('bytes')) is not int:
                raise ValueError('Capture manifest needs the exact single reviewed icon record')
            if not _regular_capture_file(source_path):
                raise ValueError('Reviewed icon source must be an unaliased regular file')
            data = source_path.read_bytes()
            if len(data) != record['bytes'] or digest(data) != record['sha256']:
                raise ValueError('Reviewed icon source differs from pinned bytes')
            sources[name] = data
        except (OSError, ValueError, TypeError) as error:
            failures.append(f'Reviewed product icon override invalid: {name}: {error}')
    return sources

def capture():
    if LOCK.exists() or any(spec['destination'].exists() for spec in PACKAGES.values()):
        raise SystemExit('A source capture exists. Verify it; do not overwrite pinned inputs.')
    manifest = {'schemaVersion': 1, 'capturedUtc': datetime.now(timezone.utc).isoformat(),
                'windowsBehaviorVersion': '0.12.82', 'packages': {}, 'files': []}
    for name, spec in PACKAGES.items():
        origin, destination = spec['source'], spec['destination']
        inputs = [origin / item for item in spec['files'] if (origin / item).is_file()]
        for directory in spec['directories']:
            inputs.extend(path for path in (origin / directory).rglob('*') if path.is_file()
                          and not any(part in {'.git', '__pycache__', 'node_modules'} for part in path.parts))
        paths = sorted(set(inputs))
        tree = []
        for path in paths:
            relative = path.relative_to(origin)
            data = path.read_bytes()
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            sha = digest(data)
            if digest(path.read_bytes()) != sha:
                raise SystemExit(f'Source changed during capture: {path}; captured bytes retained for review.')
            manifest['files'].append({'package': name, 'path': target.relative_to(ROOT).as_posix(),
                                      'originPath': relative.as_posix(), 'bytes': len(data), 'sha256': sha})
            tree.append(f'{relative.as_posix()}\0{sha}\n')
        manifest['packages'][name] = {'origin': str(origin), 'files': len(paths),
                                      'treeSha256': digest(''.join(tree).encode())}
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    # Owned product assets keep their source path and hash in the package lock.
    asset_source = ROOT / 'reference/windows/assets'
    shutil.copytree(asset_source / 'icons', ROOT / 'public/icons', dirs_exist_ok=True)
    shutil.copy2(asset_source / 'opsiclear.png', ROOT / 'public/opsiclear.png')
    verify()

def verify():
    manifest = json.loads(LOCK.read_text(encoding='utf-8'))
    if manifest.get('schemaVersion') != 1 or set(manifest.get('packages', {})) != set(PACKAGES):
        raise SystemExit('Unsupported or incomplete source lock; review the frozen inputs.')
    failures = []
    expected = {name: set() for name in PACKAGES}
    trees = {name: [] for name in PACKAGES}
    for item in manifest['files']:
        package = item['package']
        if package not in PACKAGES:
            failures.append(f'Unknown source package: {package}')
            continue
        origin_path = Path(item['originPath'])
        if origin_path.is_absolute() or '..' in origin_path.parts:
            failures.append(f'Invalid package path: {item["originPath"]}')
            continue
        target = PACKAGES[package]['destination'] / origin_path
        relative = target.relative_to(ROOT).as_posix()
        if item['path'] != relative or relative in expected[package]:
            failures.append(f'Invalid or duplicate source entry: {item["path"]}')
            continue
        expected[package].add(relative)
        trees[package].append(f'{item["originPath"]}\0{item["sha256"]}\n')
        path = ROOT / item['path']
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(PACKAGES[package]['destination'].resolve()):
            failures.append(item['path'])
            continue
        data = path.read_bytes()
        if len(data) != item['bytes'] or digest(data) != item['sha256']:
            failures.append(item['path'])
    for name, spec in PACKAGES.items():
        actual = {path.relative_to(ROOT).as_posix() for path in spec['destination'].rglob('*')
                  if path.is_file() or path.is_symlink()}
        failures.extend(f'Unexpected source file: {path}' for path in sorted(actual - expected[name]))
        failures.extend(f'Missing source file: {path}' for path in sorted(expected[name] - actual))
        record = manifest['packages'][name]
        if record['files'] != len(expected[name]) or record['treeSha256'] != digest(''.join(trees[name]).encode()):
            failures.append(f'Package manifest mismatch: {name}')
    # Published artwork is the frozen closure plus explicitly reviewed current
    # capture leaves. A validated supplemental filename never modifies the lock.
    # Additions outside these explicitly pinned overrides remain failures.
    icons = ROOT / 'reference/windows/assets/icons'
    expected_icons = {path.relative_to(icons).as_posix(): path for path in icons.rglob('*') if path.is_file()}
    overrides = reviewed_icon_sources(failures)
    expected_icons.update(overrides)
    published = ROOT / 'public/icons'
    actual_icons = {path.relative_to(published).as_posix(): path for path in published.rglob('*') if path.is_file() or path.is_symlink()}
    for name in sorted(set(expected_icons) | set(actual_icons)):
        source, target = expected_icons.get(name), actual_icons.get(name)
        if (source is None or target is None or target.is_symlink() or
                target.read_bytes() != (source if isinstance(source, bytes) else source.read_bytes())):
            failures.append(f'Published product icon differs: {name}')
    logo = ROOT / 'public/opsiclear.png'
    if not logo.is_file() or logo.is_symlink() or logo.read_bytes() != (ROOT / 'reference/windows/assets/opsiclear.png').read_bytes():
        failures.append('Published product logo differs: public/opsiclear.png')
    if failures:
        raise SystemExit('Pinned source integrity failure:\n' + '\n'.join(failures))
    print(f'Verified exact closure of {len(manifest["files"])} pinned source files and published product assets; desktop siblings untouched.')

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['capture', 'verify'])
    args = parser.parse_args()
    capture() if args.command == 'capture' else verify()
