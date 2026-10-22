"""Verify the qualified Windows build installation and unpacked codec inputs.

The lock is a reviewed fingerprint of this installation, not an upstream
signature or a claim that Windows and every dynamically loaded host DLL are
reproducible. Updating it is an explicit operation; builds never update it.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
SDK = Path(os.environ.get('EMSDK', ROOT / '.tools/emsdk')).resolve()
LOCK = ROOT / 'native/TOOLCHAIN_LOCK.json'
IGNORED = {'__pycache__', '.git'}


def digest_file(path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def file_summary(path):
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise ValueError(f'Missing or unsafe input: {path}')
    return {'bytes': path.stat().st_size, 'sha256': digest_file(path)}


def tree_summary(directory, excluded=()):
    directory = Path(directory).resolve()
    if not directory.is_dir():
        raise ValueError(f'Missing input tree: {directory}')
    digest = hashlib.sha256()
    count = total = 0
    for path in sorted(directory.rglob('*'), key=lambda p: p.relative_to(directory).as_posix()):
        relative = path.relative_to(directory)
        if any(part in IGNORED for part in relative.parts) or relative.parts[0] in excluded:
            continue
        if path.is_symlink() or not path.resolve().is_relative_to(directory):
            raise ValueError(f'Unsafe input tree entry: {path}')
        if not path.is_file():
            continue
        record = file_summary(path)
        # JSON plus LF is an unambiguous, portable encoding of path/size/hash.
        row = [relative.as_posix(), record['bytes'], record['sha256']]
        digest.update((json.dumps(row, separators=(',', ':'), ensure_ascii=True) + '\n').encode())
        count += 1
        total += record['bytes']
    return {'files': count, 'bytes': total, 'sha256': digest.hexdigest()}


def verify_tree(directory, expected, excluded=()):
    observed = tree_summary(directory, excluded)
    if observed != expected:
        raise ValueError(f'Input tree differs from lock: {directory}; expected {expected}, observed {observed}')
    return observed


def verify_archive_tree(archive, directory, replacements=None, omitted_links=None):
    """Compare every regular archive entry; reject absent/extra files and links.

    Tarballs must have a single top directory. Replacements are an explicit
    relative path -> reviewed file mapping (Emscripten replaces zlib/zconf.h).
    """
    directory = Path(directory).resolve()
    replacements = replacements or {}
    omitted_links = omitted_links or {}
    seen_omitted = set()
    expected = set()
    top = None
    with tarfile.open(archive) as source:
        for member in source:
            parts = PurePosixPath(member.name).parts
            if not parts or member.name.startswith('/') or '..' in parts or '\\' in member.name:
                raise ValueError(f'Unsafe dependency archive path: {member.name}')
            if top is None:
                top = parts[0]
            if parts[0] != top:
                raise ValueError(f'Multiple dependency archive roots: {member.name}')
            if member.isdir():
                continue
            if len(parts) < 2:
                raise ValueError(f'Unsafe dependency archive entry: {member.name}')
            relative = PurePosixPath(*parts[1:]).as_posix()
            if member.issym() and omitted_links.get(relative) == member.linkname:
                # CMake's Windows tar extraction omits these explicitly named
                # non-build CLI-test aliases. No other archive links are allowed.
                target = directory.joinpath(*parts[1:])
                if target.exists() or target.is_symlink():
                    raise ValueError(f'Omitted archive link unexpectedly exists: {relative}')
                if relative in seen_omitted:
                    raise ValueError(f'Duplicate dependency archive entry: {member.name}')
                seen_omitted.add(relative)
                continue
            if not member.isfile():
                raise ValueError(f'Unsafe dependency archive entry: {member.name}')
            if relative in expected:
                raise ValueError(f'Duplicate dependency archive entry: {member.name}')
            expected.add(relative)
            target = directory.joinpath(*parts[1:])
            if target.is_symlink() or not target.resolve().is_relative_to(directory):
                raise ValueError(f'Unsafe extracted dependency entry: {relative}')
            content = Path(replacements[relative]).read_bytes() if relative in replacements else source.extractfile(member).read()
            if not target.is_file() or target.read_bytes() != content:
                raise ValueError(f'Extracted dependency differs from pinned archive: {relative}')
    if set(replacements) - expected:
        raise ValueError('Dependency replacement is absent from the pinned archive')
    if set(omitted_links) != seen_omitted:
        raise ValueError('Reviewed omitted link differs from the pinned archive')
    actual = set()
    for path in directory.rglob('*'):
        if path.is_symlink() or not path.resolve().is_relative_to(directory):
            raise ValueError(f'Unsafe extracted dependency entry: {path}')
        if path.is_file():
            actual.add(path.relative_to(directory).as_posix())
    if actual != expected:
        raise ValueError(f'Extracted dependency has missing or unexpected files: {directory}')
    return tree_summary(directory)


def tool_locations():
    cmake = Path(shutil.which('cmake') or ROOT / '.tools/python/cmake/data/bin/cmake.exe').resolve()
    ninja = Path(shutil.which('ninja') or ROOT / '.tools/python/ninja/data/bin/ninja.exe').resolve()
    return cmake, ninja


def observe_toolchain():
    if platform.system() != 'Windows' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise ValueError('This lock qualifies Windows x86_64 build tools; review a separate host lock for this platform.')
    cmake, ninja = tool_locations()
    emscripten = SDK / 'upstream/emscripten'
    dependencies = json.loads((ROOT / 'native/DEPENDENCIES.json').read_text(encoding='utf-8'))
    release = dependencies['emscripten']['sdkRevision']
    version = emscripten.joinpath('emscripten-version.txt').read_text().strip().strip('"')
    marker = SDK.joinpath('upstream/.emsdk_version').read_text().strip()
    if version != dependencies['emscripten']['version'] or marker != f'releases-{release}-64bit':
        raise ValueError('SDK version/release identity differs from DEPENDENCIES.json')
    groups = {
        'emscriptenCompilerSources': (emscripten, ('cache', 'test', 'docs', 'media')),
        'llvmAndBinaryenExecutables': (SDK / 'upstream/bin', ()),
        'clangBuiltinHeaders': (SDK / 'upstream/lib', ()),
        'sdkPythonRuntime': (SDK / 'python/3.13.3_64bit', ()),
        'sdkNodeRuntime': (SDK / 'node/24.19.0_64bit', ()),
        'cmakeDistribution': (cmake.parent.parent, ('doc',)),
        'compiledSysrootCache': (emscripten / 'cache/sysroot', ()),
    }
    return {
        'host': 'windows-x86_64',
        'emscriptenVersion': version,
        'sdkRelease': release,
        'emscriptenRevision': emscripten.joinpath('emscripten-revision.txt').read_text().strip(),
        'files': {'emsdkConfig': file_summary(SDK / '.emscripten'), 'cmake': file_summary(cmake), 'ninja': file_summary(ninja)},
        'trees': {name: tree_summary(path, exclusions) for name, (path, exclusions) in groups.items()},
    }


def verify_toolchain():
    locked = json.loads(LOCK.read_text(encoding='utf-8'))
    if locked.get('schemaVersion') != 1:
        raise ValueError('Unsupported toolchain lock schema')
    observed = observe_toolchain()
    if observed != locked['inputs']:
        changed = [key for key in observed if observed[key] != locked['inputs'].get(key)]
        raise ValueError(f'Toolchain installation differs from reviewed lock ({", ".join(changed)}). Review differences before updating native/TOOLCHAIN_LOCK.json.')
    return observed


def verify_ports():
    """Check SDK definitions, downloaded tarballs and actual extracted trees."""
    emscripten = SDK / 'upstream/emscripten'
    ports = emscripten / 'cache/ports'
    # These hashes are the reviewed Emscripten 6.0.12 port definitions, rather
    # than values parsed from possibly modified Python code at verification time.
    definitions = {
        'webp': ('contrib.libwebp.6.0.tar.gz', 'contrib.libwebp/libwebp-1.6.0', '5c159d9760efcb92749092536daada22c0a73c20926c76097a5f0448ddbf874cf761324ca97925ca5f578b30477564b2b072b47667e504673797128b31cafcbf'),
        'zlib': ('zlib.3.2.tar.gz', 'zlib/zlib-1.3.2', '16fea4df307a68cf0035858abe2fd550250618a97590e202037acd18a666f57afc10f8836cbbd472d54a0e76539d0e558cb26f059d53de52ff90634bbf4f47d4'),
    }
    result = {}
    for name, (archive_name, directory, expected) in definitions.items():
        archive = ports / archive_name
        if digest_file(archive, 'sha512') != expected:
            raise ValueError(f'SDK {name} archive differs from reviewed SHA512')
        replacements = {'zconf.h': emscripten / 'tools/ports/zlib/zconf.h'} if name == 'zlib' else None
        result[name] = {'archiveSha512': expected, 'tree': verify_archive_tree(archive, ports / directory, replacements)}
    return result


def verify_zstd(build_directory):
    build_directory = Path(build_directory)
    archive = build_directory / '_deps/zstd-subbuild/zstd-populate-prefix/src/zstd-1.5.6.tar.gz'
    lock = json.loads((ROOT / 'native/DEPENDENCIES.json').read_text(encoding='utf-8'))['zstd']
    if digest_file(archive) != lock['sha256']:
        raise ValueError('Zstd archive differs from DEPENDENCIES.json')
    omitted = {'tests/cli-tests/bin/unzstd': 'zstd', 'tests/cli-tests/bin/zstdcat': 'zstd'}
    return {'archiveSha256': lock['sha256'],
            'omittedNonBuildSymlinksOnWindows': omitted,
            'tree': verify_archive_tree(archive, build_directory / '_deps/zstd-src', omitted_links=omitted)}


def build_inputs(root=ROOT):
    root = Path(root)
    return {
        'sourceLock': file_summary(root / 'native/SOURCE_LOCK.json'),
        'dependencyLock': file_summary(root / 'native/DEPENDENCIES.json'),
        'toolchainLock': file_summary(root / 'native/TOOLCHAIN_LOCK.json'),
        'wasmAdapters': tree_summary(root / 'native/wasm'),
        'buildScripts': {name: file_summary(root / 'tools' / name)
                         for name in ('build-core.py', 'verify-toolchain.py', 'capture-sources.py',
                                      'spz_stream_cleanup.py', 'json_cleanup_overlay.py')},
    }


def canonical_native_inputs(root=ROOT, inputs=None):
    """Content identity, without capture locations, clocks or generated files.

    The full lock bytes remain freshness inputs above. In particular, hashing
    SOURCE_LOCK.json wholesale would also hash its capture timestamp and the
    absolute path of the original desktop checkout. Those are provenance
    metadata, rather than native implementation inputs.
    """
    root = Path(root)
    inputs = build_inputs(root) if inputs is None else inputs
    source = json.loads((root / 'native/SOURCE_LOCK.json').read_text(encoding='utf-8'))
    toolchain = json.loads((root / 'native/TOOLCHAIN_LOCK.json').read_text(encoding='utf-8'))
    dependencies = json.loads((root / 'native/DEPENDENCIES.json').read_text(encoding='utf-8'))
    if source.get('schemaVersion') != 1 or toolchain.get('schemaVersion') != 1:
        raise ValueError('Unsupported source/toolchain lock schema for native identity')
    rows = []
    seen = set()
    for record in source['files']:
        path = record['path']
        if not isinstance(path, str):
            raise ValueError('Unsafe or duplicate source path in native identity')
        parts = PurePosixPath(path).parts
        if (not parts or path.startswith('/') or '\\' in path or
                '..' in parts or ':' in path or path in seen):
            raise ValueError('Unsafe or duplicate source path in native identity')
        seen.add(path)
        rows.append({key: record[key] for key in ('package', 'path', 'bytes', 'sha256')})
    packages = {name: {key: record[key] for key in ('files', 'treeSha256')}
                for name, record in source['packages'].items()}
    return {
        'schemaVersion': 1,
        'sourceSnapshot': {'schemaVersion': source['schemaVersion'],
                           'windowsBehaviorVersion': source['windowsBehaviorVersion'],
                           'packages': packages, 'files': sorted(rows, key=lambda row: row['path'])},
        'dependencyLock': dependencies,
        'toolchainInputs': toolchain['inputs'],
        'wasmAdapters': inputs['wasmAdapters'],
        'buildScripts': inputs['buildScripts'],
    }


def native_input_id(root=ROOT, inputs=None):
    serialized = json.dumps(canonical_native_inputs(root, inputs), sort_keys=True,
                            separators=(',', ':'), ensure_ascii=True)
    return hashlib.sha256(serialized.encode('utf-8')).hexdigest()


def runtime_identities(root=ROOT, inputs=None):
    """Static native capabilities compiled into both modules before allocation."""
    root = Path(root)
    contract = json.loads((root / 'native/wasm/runtime-contract.json').read_text(encoding='utf-8'))
    if (contract.get('schemaVersion') != 1 or type(contract.get('protocolVersion')) is not int or
            contract['protocolVersion'] <= 0 or type(contract.get('uiWorkerContract')) is not int or
            contract['uiWorkerContract'] <= 0):
        raise ValueError('Unsupported browser runtime contract')
    identity = {}
    input_id = native_input_id(root, inputs)
    for kind, abi in (('core', 24), ('camera', 4)):
        item = contract[kind]
        expected = {'schemaVersion', 'kind', 'abi', 'variant', 'capabilities'}
        if kind == 'core':
            expected.add('mapLayoutVersion')
        capabilities = item.get('capabilities')
        required_capabilities = ('currentViewScope', 'boundedSogExport', 'boundedSpz3Export', 'boundedAttributeExport', 'absoluteOpacitySession', 'opacityBaseStream', 'duplicate', 'colorFillRange') if kind == 'core' else ('cameraTransformGizmo',)
        if (set(item) != expected or item.get('schemaVersion') != 1 or item.get('kind') != kind or
                item.get('abi') != abi or item.get('variant') != 'scalar' or
                (kind == 'core' and item.get('mapLayoutVersion') != 1) or
                not isinstance(capabilities, dict) or not capabilities or
                any(capabilities.get(name) != 1 for name in required_capabilities) or
                (kind == 'core' and (capabilities.get('proTransformSession') != 2 or capabilities.get('selectionMorphology') != 2 or
                                     capabilities.get('selectionFilter') != 2 or
                                     capabilities.get('selectionActions') != 2 or
                                     capabilities.get('transformPivot') != 2 or
                                     capabilities.get('transactionReceipt') != 2 or
                                     capabilities.get('recoveryCheckpoint') != 2)) or
                any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9]*', name) or
                    type(version) is not int or version <= 0 for name, version in capabilities.items())):
            raise ValueError(f'Unsupported {kind} runtime identity contract')
        identity[kind] = {**item, 'nativeInputId': input_id}
    return identity


def verify_build_report(root=ROOT, require_local_evidence=False):
    """Verify published output freshness; installed-tool verification is separate."""
    root = Path(root).resolve()
    report_path = root / 'public/wasm/build-provenance.json'
    report = json.loads(report_path.read_text(encoding='utf-8'))
    if report.get('schemaVersion') != 1 or report.get('buildMode') != 'clean-first':
        raise ValueError('Unsupported or unqualified build report; perform a clean tools/build-core.py build')
    inputs = build_inputs(root)
    if report.get('inputs') != inputs:
        raise ValueError('Build report is stale: current source/dependency/toolchain locks, adapters or build scripts differ')
    identities = runtime_identities(root, inputs)
    if (report.get('nativeInputId') != identities['core']['nativeInputId'] or
            report.get('nativeIdentity') != identities):
        raise ValueError('Build report native identity differs from canonical reviewed inputs or runtime capabilities')
    names = ('splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm')
    if set(report.get('outputs', {})) != set(names):
        raise ValueError('Build report has missing or unexpected outputs')
    for name in names:
        if file_summary(root / 'public/wasm' / name) != report['outputs'][name]:
            raise ValueError(f'Published build output differs from report: {name}')
    if require_local_evidence:
        verify_tree(root / '.build/desktop-package', report['desktopOverlay'])
        paths = {'commandEvidence': root / '.build/wasm/build-commands.txt',
                 'compileCommands': root / '.build/wasm/compile_commands.json',
                 'cmakeCache': root / '.build/wasm/CMakeCache.txt'}
        for key, path in paths.items():
            expected = {name: report[key][name] for name in ('bytes', 'sha256')}
            if file_summary(path) != expected:
                raise ValueError(f'Local build command/configuration evidence differs from report: {key}')
    return {name: report['outputs'][name] for name in names}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('verify', 'verify-build', 'capture'))
    parser.add_argument('--build-directory', type=Path, default=ROOT / '.build/wasm')
    parser.add_argument('--local-evidence', action='store_true', help='Also verify local Ninja commands, compile commands and CMake cache')
    args = parser.parse_args()
    if args.action == 'capture':
        if LOCK.exists():
            raise ValueError('Refusing to overwrite an existing reviewed lock; remove it explicitly after reviewing the intended toolchain changes.')
        result = {
            'schemaVersion': 1,
            'qualification': 'Reviewed installed Windows x86_64 fingerprints, not upstream binary authentication or a complete host dependency closure.',
            'exclusions': ['Python bytecode and Git metadata', 'SDK documentation/tests/media', 'CMake documentation', 'Windows OS and dynamically loaded host DLLs outside these distributions', 'bootstrap Python standard library outside the SDK', 'Independent reproduction of cached sysroot archives from reviewed SDK/codec sources', 'native reference executable/toolchain provenance'],
            'cachePolicy': 'Installed compiled sysroot files are pinned as observed binary build inputs; their source-to-cache derivation is not independently reproduced. A legitimate cache extension or rebuild requires review and a new lock; builds never refresh this lock.',
            'inputs': observe_toolchain(),
        }
        LOCK.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
        print(f'Captured reviewed toolchain candidate: {LOCK}')
    elif args.action == 'verify-build':
        print(json.dumps({'buildReport': 'verified', 'outputs': verify_build_report(require_local_evidence=args.local_evidence)}, indent=2))
    else:
        observed = verify_toolchain()
        dependencies = {'ports': verify_ports(), 'zstd': verify_zstd(args.build_directory)}
        print(json.dumps({'toolchain': 'verified', 'host': observed['host'], 'dependencies': dependencies}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        raise SystemExit(str(error)) from error
