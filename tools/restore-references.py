"""Restore missing frozen references from the local archive, never from siblings.

Run explicitly after checkout. Existing source/capture manifests remain the
authority; this command neither captures sources nor updates any manifest.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = 'reference/frozen-sources.zip'
CAPTURES = ('windows-r0-20261012-02', 'windows-pivot-20261016-01')


def safe_name(value):
    if (not isinstance(value, str) or not value or
            any(char in value for char in ('\\', ':', '\0')) or
            any(part in ('', '.', '..') for part in value.split('/')) or
            PurePosixPath(value).is_absolute()):
        raise ValueError(f'Unsafe reference path: {value!r}')
    return value


def expected_files(root):
    records, aliases = {}, set()

    def add(prefix, row):
        name = safe_name(prefix + safe_name(row['path']))
        if (type(row['bytes']) is not int or row['bytes'] < 0 or
                not isinstance(row['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', row['sha256'])):
            raise ValueError(f'Invalid reference record: {name}')
        if name.casefold() in aliases:
            raise ValueError(f'Duplicate reference record: {name}')
        records[name] = {'bytes': row['bytes'], 'sha256': row['sha256']}
        aliases.add(name.casefold())

    lock = json.loads((root / 'native/SOURCE_LOCK.json').read_bytes())
    if lock['schemaVersion'] != 1:
        raise ValueError('Unsupported source lock')
    windows = [row for row in lock['files'] if row['package'] == 'windows-reference']
    if not windows:
        raise ValueError('Missing Windows-reference source records')
    for row in windows:
        if row['path'] != 'reference/windows/' + safe_name(row['originPath']):
            raise ValueError('Windows-reference record escapes its source tree')
        add('', row)
    for capture in CAPTURES:
        prefix = f'reference/targets/{capture}/'
        manifest = json.loads((root / prefix / 'CAPTURE_MANIFEST.json').read_bytes())
        if manifest['schemaVersion'] != 1 or not manifest['files']:
            raise ValueError(f'Unsupported or empty capture: {capture}')
        for row in manifest['files']:
            add(prefix + 'source/', row)
    return records


def verify_bytes(data, record, name):
    if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        raise ValueError(f'Frozen reference bytes differ: {name}')


def checked_target(root, name):
    target = root.joinpath(*name.split('/'))
    if target.resolve() != target:
        raise ValueError(f'Linked reference path: {name}')
    for parent in target.parents:
        if parent == root:
            break
        if parent.exists() and not parent.is_dir():
            raise ValueError(f'Reference parent is not a directory: {name}')
    if target.exists() and (target.is_symlink() or not target.is_file()):
        raise ValueError(f'Reference target is not a regular file: {name}')
    return target


def restore(root):
    root = root.resolve()
    records = expected_files(root)
    # Captures share many exact files. Store one member per digest so their
    # binary assets are distributed once, retaining each original path/lock.
    blobs = {}
    for record in records.values():
        name = 'sha256/' + record['sha256']
        if name in blobs and blobs[name] != record:
            raise ValueError('Inconsistent records for one frozen reference digest')
        blobs[name] = record
    archive = root / ARCHIVE
    if archive.resolve() != archive or not archive.is_file():
        raise ValueError(f'Missing or linked frozen reference archive: {ARCHIVE}')
    with zipfile.ZipFile(archive) as bundle:
        members = {}
        aliases = set()
        for info in bundle.infolist():
            name = safe_name(info.orig_filename)
            mode = stat.S_IFMT(info.external_attr >> 16)
            if (info.is_dir() or mode not in (0, stat.S_IFREG) or
                    name.casefold() in aliases or info.flag_bits & 1):
                raise ValueError(f'Unsafe or duplicate archive member: {name}')
            members[name] = info
            aliases.add(name.casefold())
        if members.keys() != blobs.keys():
            raise ValueError('Frozen reference archive does not match the complete manifest inventory')

        # Preflight the entire archive and all existing files before any writes.
        for name, record in blobs.items():
            if members[name].file_size != record['bytes']:
                raise ValueError(f'Frozen reference size differs: {name}')
            verify_bytes(bundle.read(members[name]), record, name)
        missing = []
        for name, record in records.items():
            target = checked_target(root, name)
            if target.exists():
                verify_bytes(target.read_bytes(), record, name)
            else:
                missing.append(name)
        for name in missing:
            # Recheck bytes/paths and use exclusive creation; never overwrite.
            data = bundle.read(members['sha256/' + records[name]['sha256']])
            verify_bytes(data, records[name], name)
            target = checked_target(root, name)
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as output:
                output.write(data)
    return len(missing), len(records) - len(missing)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT, help='Web checkout root')
    args = parser.parse_args()
    try:
        restored, matched = restore(args.root)
    except (OSError, ValueError, KeyError, TypeError, RuntimeError, zipfile.BadZipFile) as error:
        parser.exit(1, f'Frozen reference restoration refused: {error}\n')
    print(f'Restored {restored} frozen reference files; {matched} already matched. '
          'Source locks and generated assets unchanged.')


if __name__ == '__main__':
    main()
