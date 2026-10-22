"""Construct nested-path inputs and independent original-byte keys; never decode."""
import hashlib
import json
from pathlib import Path
import struct
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'tests/fixtures/sog-group-sh/packets/v2-sh3/collection/asset'
OUT = ROOT / 'tests/fixtures/scene-collection-nested-v1'
MAPPING = {
    'positions-low.webp': 'asset/textures/positions-low.webp',
    'positions-high.webp': 'shared/positions-high.webp',
    'rotations.webp': 'asset/textures/transforms/rotations.webp',
    'appearance.webp': 'shared/appearance.webp',
    'declared-extra.bin': 'shared/declared-extra.bin',
    'centroids.webp': 'shared/palette/centroids.webp',
    'labels.webp': 'asset/textures/labels.webp',
}
REFERENCES = {
    'positions-low.webp': 'textures/positions-low.webp',
    'positions-high.webp': '../shared/positions-high.webp',
    'rotations.webp': 'textures/transforms/rotations.webp',
    'appearance.webp': '../shared/appearance.webp',
    'declared-extra.bin': '../shared/declared-extra.bin',
    'centroids.webp': '../shared/palette/centroids.webp',
    'labels.webp': 'textures/labels.webp',
}
PRIMARY = 'asset/META.JSON'
def sha(data):
    return hashlib.sha256(data).hexdigest()
def summary(name, data):
    return {'path': name, 'bytes': len(data), 'sha256': sha(data)}
def json_bytes(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')
def construct():
    metadata = json.loads((BASE / 'meta.json').read_bytes())
    original_inputs = [summary('tests/fixtures/sog-group-sh/packets/v2-sh3/collection/asset/meta.json', (BASE / 'meta.json').read_bytes())]
    for group in ['means','scales','quats','sh0','shN']:
        metadata[group]['files'] = [REFERENCES[name] for name in metadata[group]['files']]
    resources = {PRIMARY: json_bytes(metadata)}
    files = {}
    for original, acquired in MAPPING.items():
        body = (BASE / original).read_bytes()
        original_inputs.append(summary(f'tests/fixtures/sog-group-sh/packets/v2-sh3/collection/asset/{original}', body))
        resources[acquired] = body
    canonical = bytearray(b'SplatViewSource\x00v1\x00\x01' + struct.pack('>I',len(resources)))
    records = []
    for name, body in sorted(resources.items(),key=lambda row: row[0].encode('utf-8')):
        encoded = name.encode('utf-8')
        canonical += bytes([name == PRIMARY]) + struct.pack('>I',len(encoded)) + encoded
        canonical += struct.pack('>Q',len(body)) + hashlib.sha256(body).digest()
        records.append({**summary(name,body),'role':'primary' if name == PRIMARY else 'referenced'})
    golden = ROOT / 'tests/fixtures/sog-group-sh/packets/v2-sh3/expected-records.json'
    vector = {'schemaVersion':1,'scheme':'splatview-source-v1','kind':'group','primaryPath':PRIMARY,
              'resourceCount':len(resources),'totalBytes':sum(map(len,resources.values())),
              'assetDigest':sha(canonical),'canonicalHex':canonical.hex(),'resources':records,
              'numericOracle':summary('tests/fixtures/sog-group-sh/packets/v2-sh3/expected-records.json',golden.read_bytes()),
              'scope':'Independent framing over complete original metadata and unique declared resource bytes. No production decoder, resource catalog or fingerprint implementation used.'}
    files.update({f'collection/{name}':body for name,body in resources.items()})
    files['collection/private/unrelated-neighbor.bin'] = b'An unread, undeclared collection neighbor.\n'
    files['expected-source-key.json'] = json_bytes(vector)
    files['README.md'] = b'''# Nested selected-collection fixture\n\nThe uppercase asset/META.JSON declares nested textures and ../shared resources inside the explicit selected root. Scale/DC share one original; an unused original is declared twice. The private neighbor is not a group resource.\n\nAll WebP bytes and numeric goldens are reused unchanged from the independently constructed v2-sh3 packet. This tool changes only reference names, copies the original bodies and calculates SHA-256 framing from the documented splatview-source-v1 layout using Python hashlib/struct. No production loader or key helper supplies expectations.\n\nThe expected key covers all eight unique originals, including unused declarations. Outer picker/drop folder labels and unrelated neighbors are absent. Construction alone is not browser/native qualification.\n'''
    manifest = {'schemaVersion':1,'kind':'independent-nested-collection-fixture-construction',
                'constructionSource':summary('tools/generate-scene-collection-fixtures.py',Path(__file__).read_bytes()),
                'originalInputs':original_inputs,'files':[summary(name,body) for name,body in sorted(files.items())],
                'qualification':'Construction and exact-byte verification only; native/browser calibration is separate.'}
    files['manifest.json'] = json_bytes(manifest)
    return files
def main():
    write = sys.argv[1:] == ['--write']
    if sys.argv[1:] not in ([],['--write']):
        raise SystemExit('Usage: generate-scene-collection-fixtures.py [--write]')
    files = construct()
    for name, body in files.items():
        target = OUT / name
        if target.exists():
            if target.read_bytes() != body:
                raise RuntimeError(f'Existing fixture differs; refusing overwrite: {name}')
        elif write:
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(body)
        else:
            raise RuntimeError(f'Missing fixture: {name}')
    actual = {path.relative_to(OUT).as_posix() for path in OUT.rglob('*') if path.is_file()}
    if actual != set(files):
        raise RuntimeError('Unexpected or missing fixture leaves')
    print(json.dumps({'status':'passed','files':len(files),'bytes':sum(map(len,files.values())),
                      'assetDigest':json.loads(files['expected-source-key.json'])['assetDigest']}))
if __name__ == '__main__':
    main()
