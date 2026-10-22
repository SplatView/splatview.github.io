"""Freeze declared SplatView Windows inputs into a new, independently verifiable tree.

This captures source bytes and observations, not a complete build environment or
an atomic filesystem snapshot. Two inventories bracket copying. A failed capture
retains its files and a quarantine diagnostic; retry with a new destination.
Verification consults only the captured tree, never its live source checkout.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import re
import shlex
import stat
import subprocess
import sys
import uuid


SCHEMA_VERSION = 1
KIND = 'splatview-windows-source-capture'
MANIFEST_NAME = 'CAPTURE_MANIFEST.json'
STATUS_NAME = 'CAPTURE_STATUS.json'
DIRECTORY_ROOTS = tuple(sorted((
    'src', 'cmake', 'third_party', 'assets', 'design', 'docs', 'tests',
    'scripts', 'packaging', '.github', '.githooks',
)))
ROOT_FILES = tuple(sorted((
    'CMakeLists.txt', 'CMakePresets.json', 'Build.ps1', 'vcpkg.json',
    'vcpkg-configuration.json', '.gitmodules', '.clang-format', '.clang-tidy',
    '.gitignore', '.gitattributes', '.editorconfig', 'Install-Explorer.ps1',
    'Uninstall-Explorer.ps1', 'Package-Store.ps1', 'Prepare-Release.ps1',
    'Prepare-StoreSubmission.ps1', 'SECURITY.md', 'CODE_OF_CONDUCT.md',
    'SOURCE_REFERENCE.json',
)))
ROOT_DOCUMENT_PATTERN = (
    r'(?i)(?:licen[cs]e|copying|readme|changelog|changes|contributing|'
    r'contributors|authors|notice|third[-_]party[-_]notices|'
    r'third[-_]party[-_]port[-_]notices|privacy|eula)'
    r'(?:\.(?:md|txt|rst|markdown))?'
)
PRUNED_NAMES = tuple(sorted((
    '.git', 'build', 'dist', '.build', '.tools', '.vs', '__pycache__',
    'node_modules', 'vcpkg_installed',
)))
EXTERNAL_SCOPE = (
    'Source and build/workflow declarations only. Toolchains, Windows SDK, '
    'system libraries, installed package binaries and Git administration '
    'metadata are not captured; this is not full build provenance.'
)
STABILITY = {
    'method': 'inventory-and-sha256-before-copy-and-after-copy',
    'atomicFilesystemSnapshot': False,
}
SELECTION = {
    'profile': 'windows',
    'directoryRoots': list(DIRECTORY_ROOTS),
    'rootFileNames': list(ROOT_FILES),
    'rootDocumentPattern': ROOT_DOCUMENT_PATTERN,
    'prunedEntryNames': list(PRUNED_NAMES),
    'unknownRootEntries': 'excluded without traversal',
}


class CaptureError(ValueError):
    """An unsafe, incomplete or changing capture cannot be accepted."""


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical_bytes(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def tree_digest(directories, files):
    """SHA-256 of canonical JSON containing sorted directories and file rows."""
    return digest(canonical_bytes({'directories': directories, 'files': files}))


def safe_relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise CaptureError(f'Unsafe relative path: {value!r}')
    parts = value.split('/')
    if (PurePosixPath(value).is_absolute() or PureWindowsPath(value).is_absolute()
            or any(part in ('', '.', '..') for part in parts)):
        raise CaptureError(f'Unsafe relative path: {value!r}')
    for part in parts:
        if (part[-1:] in ('.', ' ') or any(ord(char) < 32 for char in part)
                or any(char in '<>"|?*' for char in part)
                or re.fullmatch(r'(?i)(?:con|prn|aux|nul|com[1-9]|lpt[1-9])',
                                part.split('.')[0])):
            raise CaptureError(f'Unsafe relative path: {value!r}')
    return value


def _unsafe_stat(info):
    return (stat.S_ISLNK(info.st_mode)
            or bool(getattr(info, 'st_file_attributes', 0)
                    & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0x400)))


def _lstat(path):
    try:
        info = path.lstat()
    except OSError as error:
        raise CaptureError(f'Cannot inspect {path}: {error}') from error
    if _unsafe_stat(info):
        raise CaptureError(f'Symlink or reparse point rejected: {path}')
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        raise CaptureError(f'Non-regular filesystem entry rejected: {path}')
    return info


def _directory(path):
    info = _lstat(path)
    if not stat.S_ISDIR(info.st_mode):
        raise CaptureError(f'Expected a directory: {path}')
    return info


def _absolute(path):
    # abspath is lexical; unlike resolve(), it never follows a link first.
    return Path(os.path.abspath(os.fspath(path)))


def _check_ancestors(path):
    for parent in reversed((path, *path.parents)):
        _directory(parent)


def _stamp(info):
    # Windows lstat infers execute bits from .bat/.cmd/.exe filenames while
    # fstat has only a handle. Compare the entry type, not those synthetic bits.
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode), info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
            getattr(info, 'st_file_attributes', 0))


def _read_regular(root, relative, output=None, collect=False):
    safe_relative(relative)
    path = root.joinpath(*relative.split('/'))
    _check_ancestors(path.parent)
    before = _lstat(path)
    if not stat.S_ISREG(before.st_mode):
        raise CaptureError(f'Expected a regular file: {path}')
    flags = os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags)
    result = hashlib.sha256()
    size = 0
    blocks = []
    with os.fdopen(descriptor, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        if _unsafe_stat(opened) or _stamp(opened) != _stamp(before):
            raise CaptureError(f'File changed while opening: {path}')
        while True:
            block = stream.read(1024 * 1024)
            if not block:
                break
            result.update(block)
            size += len(block)
            if output is not None:
                output.write(block)
            if collect:
                blocks.append(block)
        if _stamp(os.fstat(stream.fileno())) != _stamp(before):
            raise CaptureError(f'File changed while reading: {path}')
    if _stamp(_lstat(path)) != _stamp(before) or size != before.st_size:
        raise CaptureError(f'File changed while reading: {path}')
    row = {'path': relative, 'bytes': size, 'sha256': result.hexdigest()}
    return row, _stamp(before), b''.join(blocks) if collect else None


def _root_file_selected(name):
    return name in ROOT_FILES or re.fullmatch(ROOT_DOCUMENT_PATTERN, name) is not None


def _selected_path(relative, directory=False):
    safe_relative(relative)
    parts = relative.split('/')
    if any(part.casefold() in PRUNED_NAMES for part in parts):
        return False
    return (parts[0] in DIRECTORY_ROOTS if directory or len(parts) > 1
            else _root_file_selected(parts[0]))


def _inventory(root, expected=None):
    """Traverse only declared roots, or only manifest-declared directories.

    Unknown namespaces in a capture are rejected before descending into them.
    Source exclusions are pruned, including Git submodule .git files.
    """
    _check_ancestors(root)
    directories, files, stamps, directory_stamps, excluded = [], [], {}, {}, []
    seen = set()
    expected_files = ({row['path'] for row in expected['files']}
                      if expected is not None else None)
    expected_dirs = set(expected['directories']) if expected is not None else None

    def add_name(relative):
        safe_relative(relative)
        folded = relative.casefold()
        if folded in seen:
            raise CaptureError(f'Case-colliding filesystem path: {relative}')
        seen.add(folded)

    def walk(directory, prefix=''):
        before = _directory(directory)
        with os.scandir(directory) as scan:
            names = sorted(entry.name for entry in scan)
        for name in names:
            relative = f'{prefix}/{name}' if prefix else name
            if not prefix:
                selected = name in DIRECTORY_ROOTS or _root_file_selected(name)
                if not selected:
                    if expected is not None:
                        raise CaptureError(f'Unexpected capture entry: {relative}')
                    continue
            add_name(relative)
            path = directory / name
            info = _lstat(path)
            if name.casefold() in PRUNED_NAMES:
                if expected is not None:
                    raise CaptureError(f'Unexpected excluded entry: {relative}')
                excluded.append(relative)
                continue
            if stat.S_ISDIR(info.st_mode):
                if not _selected_path(relative, directory=True):
                    raise CaptureError(f'Unexpected directory: {relative}')
                if expected_dirs is not None and relative not in expected_dirs:
                    raise CaptureError(f'Unexpected directory: {relative}')
                directories.append(relative)
                walk(path, relative)
            else:
                if not _selected_path(relative):
                    raise CaptureError(f'Unexpected root file: {relative}')
                if expected_files is not None and relative not in expected_files:
                    raise CaptureError(f'Unexpected file: {relative}')
                row, stamp, _ = _read_regular(root, relative)
                files.append(row)
                stamps[relative] = stamp
        after = _directory(directory)
        if _stamp(before) != _stamp(after):
            raise CaptureError(f'Directory changed during inventory: {directory}')
        directory_stamps[prefix] = _stamp(after)

    walk(root)
    directories.sort()
    files.sort(key=lambda row: row['path'])
    if expected is not None:
        missing_dirs = expected_dirs - set(directories)
        missing_files = expected_files - {row['path'] for row in files}
        if missing_dirs or missing_files:
            raise CaptureError('Missing capture entries: '
                               + ', '.join(sorted(missing_dirs | missing_files)))
    return {'directories': directories, 'files': files, 'stamps': stamps,
            'directoryStamps': directory_stamps, 'excludedEntries': sorted(excluded)}


def _assert_same(before, after, label):
    for key in ('directories', 'files', 'stamps', 'directoryStamps'):
        if before[key] != after[key]:
            before_names = {row['path'] for row in before['files']}
            after_names = {row['path'] for row in after['files']}
            details = []
            if after_names - before_names:
                details.append('added: ' + ', '.join(sorted(after_names - before_names)))
            if before_names - after_names:
                details.append('removed: ' + ', '.join(sorted(before_names - after_names)))
            raise CaptureError(f'{label} changed between inventories'
                               + (' (' + '; '.join(details) + ')' if details else ''))


def _cmake_commands(text):
    """Read command bodies without evaluating CMake or mistaking comments for commands."""
    length, position = len(text), 0

    def comment_end(index):
        bracket = re.match(r'#\[(=*)\[', text[index:])
        if bracket:
            end = text.find(']' + bracket[1] + ']', index + len(bracket[0]))
            if end < 0:
                raise CaptureError('Unterminated CMake bracket comment')
            return end + len(bracket[1]) + 2
        end = text.find('\n', index)
        return length if end < 0 else end

    while position < length:
        if text[position] == '#':
            position = comment_end(position)
            continue
        name = re.match(r'[A-Za-z_][A-Za-z_0-9]*', text[position:])
        if not name:
            position += 1
            continue
        position += len(name[0])
        while position < length and (text[position].isspace() or text[position] == '#'):
            position = comment_end(position) if text[position] == '#' else position + 1
        if position >= length or text[position] != '(':
            continue
        position += 1
        depth, body = 1, []
        while position < length and depth:
            char = text[position]
            if char == '#':
                position = comment_end(position)
                body.append(' ')
                continue
            if char == '"':
                start = position
                position += 1
                while position < length:
                    if text[position] == '\\':
                        position += 2
                    elif text[position] == '"':
                        position += 1
                        break
                    else:
                        position += 1
                else:
                    raise CaptureError('Unterminated CMake quoted argument')
                body.append(text[start:position])
                continue
            bracket = re.match(r'\[(=*)\[', text[position:])
            if bracket:
                end = text.find(']' + bracket[1] + ']', position + len(bracket[0]))
                if end < 0:
                    raise CaptureError('Unterminated CMake bracket argument')
                end += len(bracket[1]) + 2
                body.append(text[position:end])
                position = end
                continue
            depth += (char == '(') - (char == ')')
            if depth:
                body.append(char)
            position += 1
        if depth:
            raise CaptureError(f'Unterminated CMake command: {name[0]}')
        yield name[0].casefold(), ''.join(body)


def product_version(cmake_bytes):
    try:
        text = cmake_bytes.decode('utf-8-sig')
        projects = [shlex.split(body, comments=False, posix=True)
                    for command, body in _cmake_commands(text) if command == 'project']
    except (UnicodeError, ValueError) as error:
        raise CaptureError(f'Cannot parse captured CMake project version: {error}') from error
    if len(projects) != 1 or not projects[0] or projects[0][0] != 'SplatView':
        raise CaptureError('Expected exactly one literal SplatView project in captured CMakeLists.txt')
    arguments = projects[0]
    indexes = [index for index, value in enumerate(arguments) if value == 'VERSION']
    if len(indexes) != 1 or indexes[0] + 1 >= len(arguments):
        raise CaptureError('Captured SplatView project must declare one literal VERSION')
    version = arguments[indexes[0] + 1]
    if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', version):
        raise CaptureError(f'Non-literal or unsupported captured CMake VERSION: {version!r}')
    return {'name': 'SplatView', 'version': version, 'versionSource': 'CMakeLists.txt'}


def _json_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise CaptureError(f'Duplicate JSON key: {key}')
        result[key] = value
    return result


def _json(data):
    try:
        return json.loads(data.decode('utf-8'), object_pairs_hook=_json_pairs,
                          parse_constant=lambda value: (_ for _ in ()).throw(
                              CaptureError(f'Invalid JSON constant: {value}')))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise CaptureError(f'Invalid capture JSON: {error}') from error


def external_requirements(root, files):
    declarations = []
    for row in files:
        relative = row['path']
        if relative == 'CMakeLists.txt' or relative.startswith('cmake/') and relative.endswith('.cmake'):
            _, _, data = _read_regular(root, relative, collect=True)
            for command, body in _cmake_commands(data.decode('utf-8-sig')):
                if command in ('find_package', 'find_program'):
                    declarations.append({'path': relative, 'command': command,
                                         'arguments': ' '.join(body.split())})
    paths = {row['path'] for row in files}
    result = {'scope': EXTERNAL_SCOPE, 'cmakeDeclarations': declarations,
              'presetDeclarations': [], 'vcpkgManifest': None}
    if 'CMakePresets.json' in paths:
        _, _, data = _read_regular(root, 'CMakePresets.json', collect=True)
        presets = _json(data)
        for preset in presets.get('configurePresets', []):
            result['presetDeclarations'].append({
                key: preset[key] for key in ('name', 'generator', 'architecture', 'inherits', 'cacheVariables')
                if key in preset})
    if 'vcpkg.json' in paths:
        _, _, data = _read_regular(root, 'vcpkg.json', collect=True)
        result['vcpkgManifest'] = _json(data)
    return result


def git_observation(source, root_files):
    """Read Git metadata with status restricted to the declared capture inputs."""
    def git(*arguments):
        result = subprocess.run(
            ['git', '--no-optional-locks', '-C', str(source), '-c', 'core.fsmonitor=false',
             *arguments], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
            check=False, env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'})
        if result.returncode:
            raise CaptureError(result.stderr.decode('utf-8', errors='replace').strip())
        return result.stdout.decode('utf-8', errors='replace')
    try:
        top = git('rev-parse', '--show-toplevel').strip()
        if os.path.normcase(os.path.abspath(top)) != os.path.normcase(str(source)):
            return {'available': False, 'reason': 'Source is not the Git working-tree root'}
        head = git('rev-parse', '--verify', 'HEAD').strip()
        pathspecs = [*DIRECTORY_ROOTS, *ROOT_FILES, *root_files]
        pathspecs += [f':(exclude,glob)**/{name}/**' for name in PRUNED_NAMES]
        status_text = git('status', '--porcelain=v1', '-z', '--untracked-files=all',
                          '--ignore-submodules=none', '--', *pathspecs)
        fields, records, index = status_text.split('\0'), [], 0
        while index < len(fields) and fields[index]:
            item = fields[index]
            index += 1
            record = {'code': item[:2], 'path': item[3:]}
            if 'R' in item[:2] or 'C' in item[:2]:
                if index >= len(fields) or not fields[index]:
                    raise CaptureError('Incomplete Git rename/copy observation')
                record['originalPath'] = fields[index]
                index += 1
            records.append(record)
        return {'available': True, 'head': head, 'scope': 'declared capture inputs only',
                'dirty': bool(records), 'untracked': [item['path'] for item in records if item['code'] == '??'],
                'status': records}
    except (OSError, subprocess.TimeoutExpired, CaptureError) as error:
        return {'available': False, 'reason': str(error)}


def _write_json_exclusive(path, value):
    _check_ancestors(path.parent)
    data = (json.dumps(value, ensure_ascii=True, sort_keys=True, indent=2,
                       allow_nan=False) + '\n').encode('utf-8')
    with path.open('xb') as stream:
        stream.write(data)
    return data


def _copy_file(source, target_root, row, expected_stamp):
    relative = row['path']
    target = target_root.joinpath(*relative.split('/'))
    _check_ancestors(target.parent)
    with target.open('xb') as output:
        copied, stamp, _ = _read_regular(source, relative, output=output)
    if copied != row or stamp != expected_stamp:
        raise CaptureError(f'Source changed while copying: {relative}')


def _new_destination(source, destination):
    _check_ancestors(destination.parent)
    if destination == source or destination.is_relative_to(source):
        raise CaptureError('Destination must be outside the source checkout')
    try:
        destination.mkdir(exist_ok=False)
    except FileExistsError as error:
        raise CaptureError(f'Destination already exists; choose a new directory: {destination}') from error


def capture(source, destination):
    source, destination = _absolute(source), _absolute(destination)
    _new_destination(source, destination)
    capture_id, stage = str(uuid.uuid4()), 'initial inventory'
    try:
        target_root = destination / 'source'
        target_root.mkdir(exist_ok=False)
        before = _inventory(source)
        if 'CMakeLists.txt' not in {row['path'] for row in before['files']}:
            raise CaptureError('Required source CMakeLists.txt is missing')
        root_files = [row['path'] for row in before['files'] if '/' not in row['path']]
        git_before = git_observation(source, root_files)
        stage = 'copy'
        for relative in sorted(before['directories'], key=lambda name: (name.count('/'), name)):
            path = target_root.joinpath(*relative.split('/'))
            _check_ancestors(path.parent)
            path.mkdir(exist_ok=False)
        for row in before['files']:
            _copy_file(source, target_root, row, before['stamps'][row['path']])
        stage = 'final source inventory'
        after = _inventory(source)
        _assert_same(before, after, 'Source')
        git_after = git_observation(source, root_files)
        if git_before != git_after:
            raise CaptureError('Git source observation changed during capture')
        stage = 'manifest'
        _, _, cmake = _read_regular(target_root, 'CMakeLists.txt', collect=True)
        manifest = {
            'schemaVersion': SCHEMA_VERSION, 'kind': KIND, 'captureId': capture_id,
            'capturedUtc': utc_now(), 'product': product_version(cmake),
            'source': {'path': str(source), 'gitBefore': git_before, 'gitAfter': git_after,
                       'excludedEntries': before['excludedEntries']},
            'selection': SELECTION, 'stability': STABILITY,
            'externalRequirements': external_requirements(target_root, before['files']),
            'directories': before['directories'], 'files': before['files'],
            'fileCount': len(before['files']), 'totalBytes': sum(row['bytes'] for row in before['files']),
            'treeSha256': tree_digest(before['directories'], before['files']),
        }
        manifest_data = _write_json_exclusive(destination / MANIFEST_NAME, manifest)
        stage = 'independent captured-tree verification'
        _verify(destination, require_complete=False)
        _write_json_exclusive(destination / STATUS_NAME, {
            'schemaVersion': SCHEMA_VERSION, 'kind': KIND, 'state': 'complete',
            'captureId': capture_id, 'completedUtc': utc_now(),
            'manifestSha256': digest(manifest_data), 'treeSha256': manifest['treeSha256'],
        })
        return manifest
    except (Exception, KeyboardInterrupt) as error:
        diagnostic = f'{type(error).__name__}: {error}'
        try:
            _write_json_exclusive(destination / STATUS_NAME, {
                'schemaVersion': SCHEMA_VERSION, 'kind': KIND, 'state': 'quarantined',
                'captureId': capture_id, 'failedUtc': utc_now(), 'stage': stage,
                'diagnostic': diagnostic,
            })
        except (Exception, KeyboardInterrupt) as status_error:
            diagnostic += f'; could not write quarantine status: {status_error}'
        raise CaptureError(f'Capture quarantined at {destination}; files retained. '
                           f'Stage {stage}: {diagnostic}. Retry with a new destination.') from error


def _validate_manifest(manifest):
    fields = {'schemaVersion', 'kind', 'captureId', 'capturedUtc', 'product', 'source',
              'selection', 'stability', 'externalRequirements', 'directories', 'files',
              'fileCount', 'totalBytes', 'treeSha256'}
    if (not isinstance(manifest, dict) or set(manifest) != fields
            or type(manifest['schemaVersion']) is not int or manifest['schemaVersion'] != SCHEMA_VERSION
            or manifest['kind'] != KIND or manifest['selection'] != SELECTION
            or manifest['stability'] != STABILITY):
        raise CaptureError('Unsupported or incomplete capture manifest')
    if not isinstance(manifest['captureId'], str) or not isinstance(manifest['capturedUtc'], str):
        raise CaptureError('Invalid capture identity metadata')
    directories, files = manifest['directories'], manifest['files']
    if not isinstance(directories, list) or not isinstance(files, list):
        raise CaptureError('Invalid capture inventory')
    seen = set()
    for relative in directories:
        if not _selected_path(relative, directory=True) or relative.casefold() in seen:
            raise CaptureError(f'Unsafe or duplicate manifest directory: {relative!r}')
        seen.add(relative.casefold())
    paths = []
    for row in files:
        if not isinstance(row, dict) or set(row) != {'path', 'bytes', 'sha256'}:
            raise CaptureError('Invalid manifest file row')
        relative = row['path']
        if not _selected_path(relative) or relative.casefold() in seen:
            raise CaptureError(f'Unsafe or duplicate manifest path: {relative!r}')
        seen.add(relative.casefold())
        if (type(row['bytes']) is not int or row['bytes'] < 0
                or not isinstance(row['sha256'], str) or not re.fullmatch('[0-9a-f]{64}', row['sha256'])):
            raise CaptureError(f'Invalid manifest file size/hash: {relative}')
        paths.append(relative)
    if directories != sorted(directories) or paths != sorted(paths) or 'CMakeLists.txt' not in paths:
        raise CaptureError('Manifest inventory is not canonical or lacks CMakeLists.txt')
    for relative in [*directories, *paths]:
        parent = PurePosixPath(relative).parent
        if str(parent) != '.' and str(parent) not in directories:
            raise CaptureError(f'Missing parent directory in manifest: {relative}')
    if (type(manifest['fileCount']) is not int or manifest['fileCount'] != len(files)
            or type(manifest['totalBytes']) is not int
            or manifest['totalBytes'] != sum(row['bytes'] for row in files)
            or manifest['treeSha256'] != tree_digest(directories, files)):
        raise CaptureError('Manifest canonical tree digest/count mismatch')


def _verify(destination, require_complete=True):
    destination = _absolute(destination)
    _check_ancestors(destination)
    allowed = {'source', MANIFEST_NAME, STATUS_NAME}
    with os.scandir(destination) as scan:
        names = {entry.name for entry in scan}
    if names - allowed:
        raise CaptureError('Unexpected capture metadata entry: ' + ', '.join(sorted(names - allowed)))
    required = {'source', MANIFEST_NAME} | ({STATUS_NAME} if require_complete else set())
    if required - names:
        raise CaptureError('Incomplete/quarantined capture: required metadata is missing')
    _, _, manifest_data = _read_regular(destination, MANIFEST_NAME, collect=True)
    manifest = _json(manifest_data)
    if not isinstance(manifest, dict):
        raise CaptureError('Unsupported or incomplete capture manifest')
    if require_complete:
        _, _, status_data = _read_regular(destination, STATUS_NAME, collect=True)
        status_record = _json(status_data)
        if not isinstance(status_record, dict) or status_record.get('state') != 'complete':
            raise CaptureError('Capture is quarantined or incomplete')
        if (set(status_record) != {'schemaVersion', 'kind', 'state', 'captureId', 'completedUtc',
                                  'manifestSha256', 'treeSha256'}
                or type(status_record['schemaVersion']) is not int
                or status_record['schemaVersion'] != SCHEMA_VERSION or status_record['kind'] != KIND
                or status_record['manifestSha256'] != digest(manifest_data)
                or status_record['captureId'] != manifest.get('captureId')
                or status_record['treeSha256'] != manifest.get('treeSha256')):
            raise CaptureError('Completion status or manifest hash mismatch')
    elif STATUS_NAME in names:
        raise CaptureError('Unexpected pre-existing capture status')
    _validate_manifest(manifest)
    root = destination / 'source'
    before = _inventory(root, manifest)
    if before['files'] != manifest['files']:
        raise CaptureError('Captured file bytes/hash mismatch')
    _, _, cmake = _read_regular(root, 'CMakeLists.txt', collect=True)
    if product_version(cmake) != manifest['product']:
        raise CaptureError('Product version differs from captured CMakeLists.txt')
    if external_requirements(root, manifest['files']) != manifest['externalRequirements']:
        raise CaptureError('External requirement metadata differs from captured declarations')
    after = _inventory(root, manifest)
    _assert_same(before, after, 'Captured tree')
    _, _, final_manifest_data = _read_regular(destination, MANIFEST_NAME, collect=True)
    if final_manifest_data != manifest_data:
        raise CaptureError('Capture manifest changed during verification')
    if require_complete:
        _, _, final_status_data = _read_regular(destination, STATUS_NAME, collect=True)
        if final_status_data != status_data:
            raise CaptureError('Capture status changed during verification')
    with os.scandir(destination) as scan:
        final_names = {entry.name for entry in scan}
    if final_names != names:
        raise CaptureError('Capture metadata entries changed during verification')
    return manifest


def verify(destination):
    return _verify(destination, require_complete=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    capture_parser = commands.add_parser('capture', help='capture into an exclusively new directory')
    capture_parser.add_argument('--source', type=Path, required=True)
    capture_parser.add_argument('--destination', type=Path, required=True)
    verify_parser = commands.add_parser('verify', help='verify captured bytes without reading the live origin')
    verify_parser.add_argument('--destination', type=Path, required=True)
    arguments = parser.parse_args(argv)
    try:
        manifest = (capture(arguments.source, arguments.destination)
                    if arguments.command == 'capture' else verify(arguments.destination))
    except (CaptureError, OSError, UnicodeError, TypeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    verb = 'Captured' if arguments.command == 'capture' else 'Verified'
    print(f'{verb} SplatView {manifest["product"]["version"]}: '
          f'{manifest["fileCount"]} files, tree SHA-256 {manifest["treeSha256"]}; '
          f'{_absolute(arguments.destination)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
