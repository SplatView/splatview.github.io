"""Bounded, byte-checked artifact I/O for setup and release promotion."""
import hashlib
import re
import stat
import tempfile
import urllib.request
from pathlib import Path

MAX_BYTES = 128 * 1024 * 1024


def safe_name(name):
    if (not isinstance(name, str) or not name or
            any(char in name for char in '\\:\0?*<>|"') or
            any(part in ('', '.', '..') or part.endswith((' ', '.')) or
                re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?', part)
                for part in name.split('/'))):
        raise ValueError(f'Unsafe artifact path: {name!r}')
    return name


def checked_path(root, name):
    root = Path(root).resolve()
    path = root.joinpath(*safe_name(name).split('/'))
    if path.resolve() != path or not path.is_relative_to(root):
        raise ValueError(f'Linked artifact path: {name}')
    if path.exists() and not path.is_file():
        raise ValueError(f'Artifact is not a regular file: {name}')
    return path


def check_record(record):
    if (not isinstance(record, dict) or set(record) != {'bytes', 'sha256'} or
            type(record['bytes']) is not int or not 0 <= record['bytes'] <= MAX_BYTES or
            not isinstance(record['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', record['sha256'])):
        raise ValueError('Invalid artifact size/hash record')
    return record


def verify_bytes(data, record, label):
    check_record(record)
    if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
        raise ValueError(f'Artifact size/checksum differs: {label}')


def archive_members(bundle, allow_directories=False):
    members, aliases, total = {}, set(), 0
    for index, info in enumerate(bundle.infolist()):
        name = safe_name(info.orig_filename[:-1] if info.is_dir() else info.orig_filename)
        mode = stat.S_IFMT(info.external_attr >> 16)
        total += info.file_size
        allowed_modes = (0, stat.S_IFDIR) if info.is_dir() and allow_directories else (0, stat.S_IFREG)
        if ((info.is_dir() and not allow_directories) or mode not in allowed_modes or info.flag_bits & 1 or
                name.casefold() in aliases or total > MAX_BYTES or index >= 8192):
            raise ValueError(f'Unsafe, duplicate or oversized archive member: {name}')
        aliases.add(name.casefold())
        if not info.is_dir():
            members[name] = info
    if not members:
        raise ValueError('Empty artifact archive')
    return members


def download(url, record, cache):
    """Publish to the cache only after verifying the entire bounded download."""
    check_record(record)
    if not url.startswith('https://'):
        raise ValueError('Artifact downloads require HTTPS')
    cache = Path(cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    target = checked_path(cache, record['sha256'] + '.zip')
    if target.exists():
        verify_bytes(target.read_bytes(), record, target.name)
        return target
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=cache, suffix='.partial', delete=False) as output:
            temporary = Path(output.name)
            request = urllib.request.Request(url, headers={'User-Agent': 'SplatView-artifacts/1'})
            with urllib.request.urlopen(request, timeout=30) as response:
                if not response.url.startswith('https://'):
                    raise ValueError('Artifact redirect requires HTTPS')
                total = 0
                while block := response.read(min(1024 * 1024, record['bytes'] - total + 1)):
                    total += len(block)
                    if total > record['bytes']:
                        raise ValueError('Artifact download exceeds pinned size')
                    output.write(block)
        verify_bytes(temporary.read_bytes(), record, url)
        temporary.replace(target)
        return target
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
