"""Restore the reviewed published WASM; never refresh native source/tool locks."""
import importlib.util
import json
import re
import tempfile
import zipfile
from pathlib import Path

from artifact_io import archive_members, check_record, checked_path, download, verify_bytes

ROOT = Path(__file__).resolve().parents[1]
NATIVE_FILES = ('splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs',
                'splatview-camera.wasm', 'build-provenance.json')


def load_tool(root, name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), root / 'tools' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_pin(root):
    pin = json.loads((root / 'tools/native-runtime.json').read_bytes())
    if (set(pin) != {'schemaVersion', 'release', 'nativeInputId', 'archive', 'files'} or
            pin['schemaVersion'] != 1 or not re.fullmatch(r'v\d+\.\d+\.\d+', pin['release']) or
            not re.fullmatch('[a-f0-9]{64}', pin['nativeInputId']) or set(pin['files']) != set(NATIVE_FILES)):
        raise ValueError('Unsupported native runtime pin')
    archive = pin['archive']
    expected_url = ('https://github.com/SplatView/splatview.github.io/releases/download/' +
                    pin['release'] + '/SplatView-web-' + pin['release'] + '.zip')
    if set(archive) != {'url', 'bytes', 'sha256'} or archive['url'] != expected_url:
        raise ValueError('Unexpected native seed URL')
    check_record({key: archive[key] for key in ('bytes', 'sha256')})
    for record in pin['files'].values():
        check_record(record)
    return pin


def restore(root=ROOT):
    root = Path(root).resolve()
    verifier = load_tool(root, 'verify-toolchain')
    # A valid local build remains authoritative, including newly reviewed native
    # inputs. Never replace it with an older bootstrap binary.
    if all(checked_path(root, 'public/wasm/' + name).is_file() for name in NATIVE_FILES):
        verifier.verify_build_report(root)
        return 'Existing WASM verified against current native inputs.'
    pin = load_pin(root)
    if verifier.native_input_id(root) != pin['nativeInputId']:
        raise ValueError('Native seed is stale. Run npm run build:core with the reviewed Windows '
                         'toolchain; review a new published seed before changing tools/native-runtime.json.')
    for name, record in pin['files'].items():
        target = checked_path(root, 'public/wasm/' + name)
        if target.exists():
            verify_bytes(target.read_bytes(), record, name)
    record = {key: pin['archive'][key] for key in ('bytes', 'sha256')}
    archive = download(pin['archive']['url'], record, root / '.build/cache/native-runtime')
    with zipfile.ZipFile(archive) as bundle:
        members = archive_members(bundle)
        contents = {}
        for name, record in pin['files'].items():
            member = members.get('wasm/' + name)
            if member is None or member.file_size != record['bytes']:
                raise ValueError(f'Missing or wrong native seed member: {name}')
            data = bundle.read(member)
            verify_bytes(data, record, name)
            contents[name] = data
    # Qualify a complete candidate with the unchanged source/native verifier
    # before publishing any files into public/wasm.
    with tempfile.TemporaryDirectory(prefix='splatview-runtime-') as temporary:
        candidate = Path(temporary)
        for name, data in contents.items():
            path = candidate / 'public/wasm' / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        # The verifier takes its input tree from the given root. Mirror only its
        # exact reviewed inputs, using bytes rather than links or sibling trees.
        inputs = ['native/SOURCE_LOCK.json', 'native/DEPENDENCIES.json', 'native/TOOLCHAIN_LOCK.json',
                  *('tools/' + name for name in verifier.build_inputs(root)['buildScripts'])]
        inputs += [p.relative_to(root).as_posix() for p in (root / 'native/wasm').rglob('*') if p.is_file()]
        for name in inputs:
            destination = checked_path(candidate, name)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(checked_path(root, name).read_bytes())
        verifier.verify_build_report(candidate)
    for name, data in contents.items():
        target = checked_path(root, 'public/wasm/' + name)
        if target.exists():
            verify_bytes(target.read_bytes(), pin['files'][name], name)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as output:
            output.write(data)
    verifier.verify_build_report(root)
    return f'Restored five verified WASM files from {pin["release"]}; no native compilation performed.'


if __name__ == '__main__':
    try:
        print(restore())
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        raise SystemExit(f'Runtime restoration refused: {error}') from error
