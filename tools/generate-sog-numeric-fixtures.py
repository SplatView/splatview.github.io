"""Construct numeric-kind SOG fixtures without importing production codecs.

The known v1 packet supplies only literal encoded resource bytes. Python's
standard ZIP implementation emits/checks each new archive and CRC. The paired
numeric cases must decode successfully before their boolean variants can prove
the native uint64 conversion boundary. Existing outputs are never overwritten.
"""
from pathlib import Path
import argparse
import copy
import hashlib
import io
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE_SHA = 'e243b5f55754a627d37d7465e4105fa6e300055d72c968d9185e3e9aa6e2ce28'


def bundle(resources):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name, payload in sorted(resources.items()):
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, payload)
    value = stream.getvalue()
    with zipfile.ZipFile(io.BytesIO(value)) as archive:
        assert set(archive.namelist()) == set(resources)
        assert all(archive.read(name) == payload for name, payload in resources.items())
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'tests/fixtures/sog-numeric-v1')
    destination = parser.parse_args().output.resolve()
    if destination.exists():
        raise ValueError('Use a new output directory; existing fixture packets are immutable.')
    raw = (ROOT / 'tests/fixtures/sog-group-v1/bundled-v1-sh0.sog').read_bytes()
    assert hashlib.sha256(raw).hexdigest() == BASE_SHA
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        resources = {name: archive.read(name) for name in archive.namelist()}
    legacy = json.loads(resources['meta.json'])
    legacy['means']['shape'][0] = 1
    modern = copy.deepcopy(legacy)
    modern['version'] = 2
    modern['count'] = 1
    del modern['means']['shape']
    # Every literal channel index is valid, independently of encoded pixels.
    for group in ['scales', 'sh0']:
        modern[group].pop('mins')
        modern[group].pop('maxs')
        modern[group]['codebook'] = [0] * 256
    cases = []
    for version, metadata in [(1, legacy), (2, modern)]:
        for boolean in [False, True]:
            value = copy.deepcopy(metadata)
            if boolean:
                if version == 1:
                    value['means']['shape'][0] = True
                else:
                    value['count'] = True
            packed = dict(resources)
            packed['meta.json'] = (json.dumps(value, separators=(',', ':')) + '\n').encode()
            payload = bundle(packed)
            cases.append((f'v{version}-count-{ "true" if boolean else "one" }.sog', payload, version, not boolean))
    manifest = {
        'schemaVersion': 1, 'scope': 'Native uint64 source-count numeric-kind comparison only',
        'baseArchiveSha256': BASE_SHA,
        'generatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'cases': [{'file': name, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
                   'version': version, 'accepted': accepted, 'sourceCount': 1 if accepted else None}
                  for name, payload, version, accepted in cases],
    }
    destination.mkdir(parents=True)
    for name, payload, _, _ in cases:
        with (destination / name).open('xb') as stream:
            stream.write(payload)
    with (destination / 'manifest.json').open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(manifest, stream, indent=2)
        stream.write('\n')
    print(json.dumps({'output': str(destination), 'cases': len(cases), 'zipRoundTrips': len(cases)}))


if __name__ == '__main__':
    main()
