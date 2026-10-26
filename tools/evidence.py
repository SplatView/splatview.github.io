"""Inspect byte-pinned historical evidence; application builds never fetch it."""
import argparse
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path, PurePosixPath

MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
CATALOG = 'docs/validation/archive/index.json'
ACTIVE_JSON = {'phase-1-template.json', 'release-evidence.schema.json'}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def safe_path(value):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError('Invalid relative evidence path')
    parts = value.split('/')
    if any(char in value for char in '\\:\0') or any(ord(char) < 32 for char in value):
        raise ValueError('Unsafe evidence path')
    if any(part in {'', '.', '..'} or part.endswith(('.', ' ')) for part in parts):
        raise ValueError('Ambiguous evidence path')
    if any(re.fullmatch(r'(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?', part, re.I) for part in parts):
        raise ValueError('Reserved evidence path')
    return value


def historical_path(value):
    safe_path(value)
    parts = value.split('/')
    return (len(parts) == 1 and value.startswith('test-results-')
            or value.startswith('docs/validation/runs/')
            or len(parts) == 3 and parts[:2] == ['docs', 'validation']
            and parts[-1].endswith('.json') and parts[-1] not in ACTIVE_JSON)


def checked_path(root, relative):
    safe_path(relative)
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ValueError('Evidence path escapes the workspace')
    current = root
    parts = PurePosixPath(relative).parts
    for index, part in enumerate(parts):
        current = current / part
        if current.is_symlink():
            raise ValueError('Linked evidence path')
        if index + 1 < len(parts) and current.exists() and not current.is_dir():
            raise ValueError('Non-directory evidence ancestor')
    return target


def file_digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


class Evidence:
    def __init__(self, root, cache=None):
        self.root = Path(root).resolve()
        self.catalog = json.loads(checked_path(self.root, CATALOG).read_text(encoding='utf-8'))
        data = self.catalog
        if data.get('schemaVersion') != 1 or data.get('kind') != 'splatview-historical-evidence':
            raise ValueError('Unsupported evidence catalog')
        if not re.fullmatch(r'[0-9a-f]{40}', data.get('sourceRevision', '')):
            raise ValueError('Invalid source revision')
        archive = data['archive']
        name = safe_path(archive['file'])
        if '/' in name or not name.endswith('.zip'):
            raise ValueError('Invalid archive filename')
        self._record(archive, MAX_TOTAL)
        url = urllib.parse.urlsplit(archive['downloadUrl'])
        if (url.scheme != 'https' or url.netloc != 'github.com' or url.query or url.fragment
                or not url.path.startswith('/SplatView/splatview.github.io/releases/download/')
                or not url.path.endswith('/' + name)):
            raise ValueError('Invalid archive download URL')
        self.files = data['files']
        if not isinstance(self.files, list) or not 0 < len(self.files) <= 20000:
            raise ValueError('Invalid evidence file count')
        seen, total = set(), 0
        for record in self.files:
            name = record['path']
            if not historical_path(name) or name.casefold() in seen:
                raise ValueError('Unsafe or duplicate historical path')
            seen.add(name.casefold())
            self._record(record, MAX_FILE)
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,127}', record['group']):
                raise ValueError('Invalid evidence group')
            total += record['bytes']
        if total > MAX_TOTAL or data['totals'] != {'files': len(self.files), 'bytes': total}:
            raise ValueError('Invalid evidence aggregate bound')
        self.by_path = {record['path']: record for record in self.files}
        retained = data.get('retainedInputs', [])
        if (not isinstance(retained, list) or any(not isinstance(name, str) for name in retained)
                or len(retained) != len(set(retained)) or any(name not in self.by_path for name in retained)):
            raise ValueError('Invalid retained evidence inputs')
        self.retained = {name: self.by_path[name] for name in retained}
        location = Path(cache) if cache else Path('.build/validation/archive') / archive['file']
        self.cache = location if location.is_absolute() else self.root / location
        if not self.cache.resolve().is_relative_to(self.root):
            raise ValueError('Evidence cache must stay inside the workspace')
        checked_path(self.root, self.cache.relative_to(self.root).as_posix())

    @staticmethod
    def _record(record, limit):
        if type(record['bytes']) is not int or not 0 <= record['bytes'] <= limit:
            raise ValueError('Evidence byte bound exceeded')
        if not re.fullmatch(r'[0-9a-f]{64}', record['sha256']):
            raise ValueError('Invalid evidence SHA-256')

    def fetch(self):
        if self.cache.exists():
            self.verify()
            return
        self.cache.parent.mkdir(parents=True, exist_ok=True)
        metadata = self.catalog['archive']
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=self.cache.parent, delete=False) as output:
                temporary = Path(output.name)
                value, received = hashlib.sha256(), 0
                with urllib.request.urlopen(metadata['downloadUrl'], timeout=60) as response:
                    if urllib.parse.urlsplit(response.geturl()).scheme != 'https':
                        raise ValueError('Archive redirect is not HTTPS')
                    while True:
                        chunk = response.read(min(1024 * 1024, metadata['bytes'] - received + 1))
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > metadata['bytes']:
                            raise ValueError('Archive download exceeds its pinned size')
                        value.update(chunk)
                        output.write(chunk)
                if received != metadata['bytes'] or value.hexdigest() != metadata['sha256']:
                    raise ValueError('Archive download hash/size mismatch')
            # Exclusive creation preserves a competing cache. Failed publication
            # removes only our own file, so the next fetch can retry normally.
            identity = None
            try:
                with temporary.open('rb') as source, self.cache.open('xb') as output:
                    identity = os.fstat(output.fileno())
                    for chunk in iter(lambda: source.read(1024 * 1024), b''):
                        output.write(chunk)
                self.verify()
            except BaseException:
                if identity is not None:
                    try:
                        if os.path.samestat(identity, self.cache.lstat()):
                            self.cache.unlink()
                    except FileNotFoundError:
                        pass
                raise
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def _open(self):
        expected = self.catalog['archive']
        if not self.cache.is_file() or self.cache.is_symlink():
            raise ValueError('Archive cache missing; run python -B tools/evidence.py fetch')
        if self.cache.stat().st_size != expected['bytes'] or file_digest(self.cache) != expected['sha256']:
            raise ValueError('Archive hash/size mismatch')
        archive = zipfile.ZipFile(self.cache)
        try:
            names = archive.namelist()
            if len(names) != len(self.files) or set(names) != set(self.by_path):
                raise ValueError('Archive member inventory differs from the catalog')
            for item in archive.infolist():
                mode = item.external_attr >> 16
                if (item.is_dir() or stat.S_ISLNK(mode) or item.flag_bits & 1
                        or item.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                        or item.file_size != self.by_path[item.filename]['bytes']):
                    raise ValueError('Invalid archive member')
            return archive
        except Exception:
            archive.close()
            raise

    @staticmethod
    def _read(archive, record):
        with archive.open(record['path']) as stream:
            data = stream.read(record['bytes'] + 1)
        if len(data) != record['bytes'] or digest(data) != record['sha256']:
            raise ValueError('Historical evidence hash/size mismatch: ' + record['path'])
        return data

    def verify(self):
        with self._open() as archive:
            for record in self.files:
                self._read(archive, record)

    def show(self, name):
        with self._open() as archive:
            return self._read(archive, self.by_path[safe_path(name)])

    def extract(self, destination, group=None):
        destination = Path(destination)
        destination = destination if destination.is_absolute() else self.root / destination
        destination = destination.resolve()
        if not destination.is_relative_to(self.root):
            raise ValueError('Extraction must stay inside the workspace')
        selected = [record for record in self.files if group is None or record['group'] == group]
        if not selected:
            raise ValueError('Unknown evidence group')
        with self._open() as archive:
            # Preflight every target before creating any output.
            for record in selected:
                target = checked_path(self.root, (destination / record['path']).relative_to(self.root).as_posix())
                if target.exists() and (not target.is_file() or target.stat().st_size != record['bytes'] or file_digest(target) != record['sha256']):
                    raise ValueError('Extraction would overwrite differing content: ' + record['path'])
            for record in selected:
                target = checked_path(self.root, (destination / record['path']).relative_to(self.root).as_posix())
                data = self._read(archive, record)
                target.parent.mkdir(parents=True, exist_ok=True)
                if not target.exists():
                    with target.open('xb') as output:
                        output.write(data)
        return len(selected)


def check_layout(root):
    root = Path(root).resolve()
    evidence = Evidence(root)
    for name, record in evidence.retained.items():
        path = checked_path(root, name)
        if not path.is_file() or path.stat().st_size != record['bytes'] or file_digest(path) != record['sha256']:
            raise ValueError('Pinned evidence input differs or is missing: ' + name)
    if (root / '.git').exists():
        names = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode('utf-8').split('\0')
    else:
        names = [p.name for p in root.iterdir() if p.is_file()]
        directory = root / 'docs/validation'
        names += [p.relative_to(root).as_posix() for p in directory.rglob('*') if p.is_file()]
    bad = [name for name in names if name and historical_path(name) and name not in evidence.retained and (root / name).is_file()]
    if bad:
        raise ValueError('Loose generated evidence is tracked in source: ' + ', '.join(bad[:5]))
    check_guide_links(root, evidence)


def check_guide_links(root, evidence):
    archived = {(root / name).resolve() for name in evidence.by_path if name not in evidence.retained}
    guides = [root / name for name in ['README.md', 'WEB_PORT_PLAN.md', 'IMPLEMENTATION_STATUS.md',
                                      'WEB_IMPLEMENTATION_DETAILS.md', 'docs/native-allocation-census.md']]
    for directory in ['docs/development', 'tools']:
        guides.extend((root / directory).rglob('*.md'))
    for guide in guides:
        if not guide.is_file():
            continue
        for target in re.findall(r'\]\(([^)\s]+)\)', guide.read_text(encoding='utf-8')):
            url = urllib.parse.urlsplit(target)
            if not url.scheme and not url.netloc and (guide.parent / urllib.parse.unquote(url.path)).resolve() in archived:
                raise ValueError('Maintained guide links to archived evidence; use the catalog: '
                                 + guide.relative_to(root).as_posix() + ' -> ' + target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--cache', type=Path)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ['check', 'list', 'fetch', 'verify']:
        commands.add_parser(name)
    commands.add_parser('show').add_argument('path')
    extract = commands.add_parser('extract')
    extract.add_argument('--destination', type=Path, default=Path('.build/validation/restored'))
    extract.add_argument('--run')
    args = parser.parse_args()
    evidence = Evidence(args.root, args.cache)
    if args.command == 'check':
        check_layout(evidence.root)
        print('Project layout and evidence catalog verified; archive payload verification is explicit.')
    elif args.command == 'list':
        for group, count in sorted(Counter(record['group'] for record in evidence.files).items()):
            print(f'{group}: {count} files')
    elif args.command == 'fetch':
        evidence.fetch()
        print('Fetched and verified historical evidence archive.')
    elif args.command == 'verify':
        evidence.verify()
        print(f'Verified {len(evidence.files)} original paths, sizes and SHA-256 digests.')
    elif args.command == 'show':
        sys.stdout.buffer.write(evidence.show(args.path))
    else:
        print(f'Extracted {evidence.extract(args.destination, args.run)} files without overwriting differing content.')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError, zipfile.BadZipFile) as error:
        print(f'Evidence error: {error}', file=sys.stderr)
        raise SystemExit(1)
