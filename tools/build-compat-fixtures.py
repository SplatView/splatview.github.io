"""Capture, genuinely build and seal immutable A/B/C compatibility fixtures.

Run only after application/native/test/tool edits stop and the shipping native
and web builds pass. A reuses the shipping qualified native build; B changes only
the reviewed staged Fill adapter/capability and clean-builds both native targets;
C makes a real CSS change and reuses all five A native publication files.
No source lock, compiled identity, provenance or emitted artifact is rewritten.
Partial captures remain available for diagnosis but cannot publish active.json.
"""
from pathlib import Path, PurePosixPath
from contextlib import contextmanager
from datetime import datetime, timezone
import argparse
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import uuid

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ('index.html', 'package.json', 'package-lock.json', 'tsconfig.json',
              'vite.config.ts', 'playwright.config.ts', 'playwright.compat.config.ts',
              'native/SOURCE_LOCK.json', 'native/DEPENDENCIES.json', 'native/TOOLCHAIN_LOCK.json')
TREES = ('src', 'e2e', 'tests', 'tools', 'native/wasm', 'native/deps',
         'native/upstream/splatview', 'reference/windows', 'public')
PUBLICATION = ('splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs',
               'splatview-camera.wasm', 'build-provenance.json')
EVIDENCE = {'commandEvidence': '.build/wasm/build-commands.txt',
            'compileCommands': '.build/wasm/compile_commands.json', 'cmakeCache': '.build/wasm/CMakeCache.txt'}
IGNORED = {'__pycache__', '.git', 'node_modules'}
GENERATED = 'src/generated/buildIdentity.ts'


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(value).hexdigest()


def receipt_identity(value, node=None):
    """Use the browser builder's canonical JSON, including ECMAScript numbers.

    Python's JSON writes 1e-08 where JavaScript writes 1e-8. The real probe
    contains floating-point camera/covariance evidence, so its containing set
    must use the same canonicalizer the browser matrix uses.
    """
    node = node or ROOT / '.tools/node-v24.21.0-win-x64/node.exe'
    safe_regular(node)
    module_url = (ROOT / 'tools/web-build.mjs').as_uri()
    script = ('import {canonicalJson,sha256} from ' + json.dumps(module_url) + ';'
              'import {readFileSync} from "node:fs";'
              'process.stdout.write(sha256(canonicalJson(JSON.parse(readFileSync(0,"utf8")))));')
    env = os.environ.copy()
    env.pop('NODE_OPTIONS', None)
    env.pop('NODE_PATH', None)
    result = subprocess.run([str(node), '--input-type=module', '--eval', script],
                            input=canonical(value), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, check=True)
    identity = result.stdout.decode('ascii')
    if not re.fullmatch('[a-f0-9]{64}', identity):
        raise ValueError('Canonical fixture-set digest helper returned an invalid result')
    return identity


def safe_regular(path):
    info = path.lstat()
    if path.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400 or not stat.S_ISREG(info.st_mode):
        raise ValueError(f'Unsafe or non-regular input: {path}')


def summary(path):
    safe_regular(path)
    data = path.read_bytes()
    return {'bytes': len(data), 'sha256': digest(data)}


def relative(path):
    return path.resolve().relative_to(ROOT).as_posix()


def record(path):
    return {'path': relative(path), **summary(path)}


def checked_relative(base, name):
    if not isinstance(name, str):
        raise ValueError('Receipt path must be a string')
    parts = PurePosixPath(name).parts
    if not parts or name.startswith('/') or '\\' in name or ':' in name or any(p in ('.', '..') for p in parts):
        raise ValueError(f'Unsafe receipt path: {name}')
    target = base.joinpath(*parts)
    if not target.resolve().is_relative_to(base.resolve()):
        raise ValueError(f'Escaping receipt path: {name}')
    return target


def walk_files(directory, root, exclude=lambda name: False):
    """Exclude public/wasm before even enumerating that directory."""
    name = directory.relative_to(root).as_posix() if directory != root else ''
    if exclude(name):
        return []
    info = directory.lstat()
    if directory.is_symlink() or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ValueError(f'Unsafe input tree: {directory}')
    if stat.S_ISREG(info.st_mode):
        return [directory]
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError(f'Unsupported input tree entry: {directory}')
    files = []
    for child in sorted(directory.iterdir(), key=lambda path: path.name):
        files.extend(walk_files(child, root, exclude))
    return files


def excluded(name):
    return (name == 'public/wasm' or name.startswith('public/wasm/') or name == GENERATED or
            any(part in IGNORED for part in PurePosixPath(name).parts))


def source_inventory(root, with_native=False):
    paths = [root / name for name in ROOT_FILES]
    for name in TREES:
        paths.extend(walk_files(root / name, root, excluded))
    if with_native:
        paths.extend(root / 'public/wasm' / name for name in PUBLICATION)
    rows = [{'path': path.relative_to(root).as_posix(), **summary(path)} for path in sorted(set(paths))]
    return {'sha256': digest(canonical(rows)), 'files': len(rows), 'bytes': sum(row['bytes'] for row in rows),
            'inventory': rows}


def tree_inventory(directory):
    return [{'path': path.relative_to(directory).as_posix(), **summary(path)}
            for path in walk_files(directory, directory)]


def copy_verified(origin, target, expected):
    if summary(origin) != {key: expected[key] for key in ('bytes', 'sha256')}:
        raise ValueError(f'Source drift before copying: {origin}')
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open('xb') as stream:
        stream.write(origin.read_bytes())
    if summary(target) != {key: expected[key] for key in ('bytes', 'sha256')} or summary(origin) != summary(target):
        raise ValueError(f'Source drift while copying: {origin}')


def write_once(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        stream.write(json.dumps(value, indent=2, ensure_ascii=False) + '\n')


def load_json(path):
    safe_regular(path)
    return json.loads(path.read_text(encoding='utf-8'))


@contextmanager
def native_build_lock():
    """A live OS lock, rather than interpreting a stale lock filename."""
    path = ROOT / '.build/cf/native-build.lock'
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a+b') as stream:
        if path.stat().st_size == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        if os.name == 'nt':
            import msvcrt
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise ValueError('Another fixture generator holds the shared SDK native-build lock') from error
            try:
                yield
            finally:
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def patched_file(stage, name, transform, description):
    path = stage / name
    before = summary(path)
    original = path.read_text(encoding='utf-8')
    changed = transform(original)
    if changed == original:
        raise ValueError(f'Reviewed patch did not change {name}')
    path.write_text(changed, encoding='utf-8', newline='\n')
    return {'path': relative(path), 'description': description, 'before': before, 'after': summary(path)}


def revise_fill(original):
    anchor = '        if(y+1<map.height) visit(x,y+1);\n'
    if original.count(anchor) != 1 or 'if(colors.empty()) {\n            if(x && y)' in original:
        raise ValueError('Reviewed Fill adapter anchor changed; do not silently rebase the fixture revision')
    return original.replace(anchor, anchor + '''        // Compatibility fixture B: opacity Fill alone admits diagonal neighbors.
        if(colors.empty()) {
            if(x && y) visit(x-1,y-1);
            if(x+1<map.width && y) visit(x+1,y-1);
            if(x && y+1<map.height) visit(x-1,y+1);
            if(x+1<map.width && y+1<map.height) visit(x+1,y+1);
        }
''')


def revise_contract(original):
    value = json.loads(original)
    if value['core']['capabilities']['fillSelection'] != 1:
        raise ValueError('Reviewed shipping Fill capability is no longer revision 1')
    value['core']['capabilities']['fillSelection'] = 2
    return json.dumps(value, indent=2) + '\n'


def revise_hover(original):
    anchor = '--hover: #262626;'
    if original.count(anchor) != 1:
        raise ValueError('Reviewed UI-only CSS anchor changed')
    return original.replace(anchor, '--hover: #272727;')


class Commands:
    def __init__(self, capture, env):
        self.capture, self.env, self.count = capture, env, 0

    def run(self, label, argv, cwd):
        self.count += 1
        path = self.capture / 'logs' / f'{self.count:02d}-{label}.log'
        path.parent.mkdir(parents=True, exist_ok=True)
        args = [str(value) for value in argv]
        print(f'Running {label}; retained log: {relative(path)}', flush=True)
        with path.open('xb') as stream:
            process = subprocess.run(args, cwd=cwd, env=self.env, stdout=stream, stderr=subprocess.STDOUT, check=False)
        result = {'label': label, 'argv': args, 'cwd': relative(cwd) if cwd != ROOT else '.',
                  'exitCode': process.returncode, 'log': record(path)}
        if process.returncode != 0:
            raise ValueError(f'{label} failed with exit {process.returncode}; inspect {path}')
        print(f'Passed {label}', flush=True)
        return result


def web_build(commands, stage, node, python):
    """The exact ordered gates from package.json's ordinary npm run build."""
    definitions = [
        ('verify-sources', [python, stage / 'tools/capture-sources.py', 'verify']),
        ('verify-assets', [python, stage / 'tools/generate-assets.py', '--check']),
        ('verify-native', [python, stage / 'tools/verify-toolchain.py', 'verify-build']),
        ('prepare-web', [node, stage / 'tools/web-build.mjs', 'prepare']),
        ('typecheck', [node, ROOT / 'node_modules/typescript/bin/tsc', '--noEmit']),
        ('web-build', [node, ROOT / 'node_modules/vite/bin/vite.js', 'build', '--config', stage / 'vite.config.ts']),
    ]
    return [commands.run(stage.name + '-' + label, argv, stage) for label, argv in definitions]


def manifest_record(stage):
    path = stage / 'dist/build-manifest.json'
    value = load_json(path)
    if value.get('schemaVersion') != 1:
        raise ValueError('Unsupported emitted manifest')
    payload = {key: item for key, item in value.items() if key != 'deploymentId'}
    if value.get('deploymentId') != digest(canonical(payload)):
        raise ValueError('Emitted manifest identity differs from actual manifest payload')
    inventory = tree_inventory(stage / 'dist')
    indexed = {row['path']: row for row in inventory}
    seen = set()
    for artifact in value['artifacts']:
        name = artifact['path']
        checked_relative(stage / 'dist', name)
        if name in seen or name not in indexed or any(artifact[key] != indexed[name][key] for key in ('bytes', 'sha256')):
            raise ValueError(f'Emitted artifact differs from manifest: {name}')
        seen.add(name)
    expected = {row['path'] for row in inventory if row['path'] != 'build-manifest.json' and not row['path'].endswith('.map')}
    if seen != expected:
        raise ValueError('Emitted runtime artifact closure differs from manifest')
    for role in ('html', 'application-entry', 'document-worker', 'core-glue', 'core-wasm',
                 'camera-glue', 'camera-wasm', 'build-provenance'):
        if sum(artifact['role'] == role for artifact in value['artifacts']) != 1:
            raise ValueError(f'Emitted manifest must contain exactly one {role}')
    return value, record(path), inventory


def validate_relationships(fixtures):
    a, b, c = (fixtures[name] for name in 'ABC')
    if len({fixture['deploymentId'] for fixture in (a, b, c)}) != 3:
        raise ValueError('A/B/C must have separately emitted deployment identities')
    if len({fixture['build']['appInputId'] for fixture in (a, b, c)}) != 3:
        raise ValueError('A/B/C application input identities must differ')
    for field in ('schemaVersion', 'protocolVersion', 'uiWorkerContract'):
        if len({fixture['build'][field] for fixture in (a, b, c)}) != 1:
            raise ValueError(f'A/B/C must retain the same {field}')
    if [fixture['nativeMode'] for fixture in (a, b, c)] != ['reused', 'compiled', 'reused']:
        raise ValueError('Native compilation/reuse ownership differs from the reviewed fixture procedure')
    if a['build']['native'] != c['build']['native'] or a['build']['native'] == b['build']['native']:
        raise ValueError('Native A/C reuse or native B independence failed')
    for kind in ('core', 'camera'):
        if a['build']['native'][kind]['abi'] != b['build']['native'][kind]['abi']:
            raise ValueError('B must retain the same public ABI')
    expected_b = json.loads(json.dumps(a['build']['native']))
    for kind in ('core', 'camera'):
        expected_b[kind]['nativeInputId'] = b['build']['native'][kind]['nativeInputId']
    expected_b['core']['capabilities']['fillSelection'] = 2
    if b['build']['native'] != expected_b:
        raise ValueError('B changed an unreviewed native contract field')
    if a['native']['publication'] != c['native']['publication']:
        # Publication paths differ by stage; compare only names and actual bytes.
        def output_bytes(fixture):
            return [{key: row[key] for key in ('name', 'bytes', 'sha256')} for row in fixture['native']['publication']]
        if output_bytes(a) != output_bytes(c):
            raise ValueError('C must reuse all five A native/provenance files exactly')
    for name, expected in (('A', [1, 0, 0]), ('B', [1, 1, 0]), ('C', [1, 0, 0])):
        fixture = fixtures[name]
        probe = fixture['semanticProbe']['result']
        if probe['fillMask'] != expected:
            raise ValueError(f'{name} semantic probe failed')
        for kind in ('core', 'camera'):
            if probe['identityReads'][kind]['identity'] != fixture['build']['native'][kind]:
                raise ValueError(f'{name} probe and actual web/native descriptor differ')


def verify_receipt(path, node=None):
    receipt = load_json(path)
    if receipt.get('schemaVersion') != 1 or receipt.get('kind') != 'genuine-coherent-compatibility-fixture-set':
        raise ValueError('Unsupported coherent fixture receipt')
    payload = {key: value for key, value in receipt.items() if key != 'fixtureSetId'}
    if receipt.get('fixtureSetId') != receipt_identity(payload, node):
        raise ValueError('Immutable fixture-set identity differs')
    capture = receipt['sourceCapture']
    current = source_inventory(ROOT, with_native=True)
    if capture['initial'] != capture['final'] or current != capture['final']:
        raise ValueError('Shipping covered source/native inputs drifted from fixture capture')
    for evidence in receipt['shippingNativeEvidence']:
        if summary(checked_relative(ROOT, evidence['path'])) != {key: evidence[key] for key in ('bytes', 'sha256')}:
            raise ValueError('Original retained shipping native evidence changed')
    for command in receipt['commands']:
        if command['exitCode'] != 0 or record(checked_relative(ROOT, command['log']['path'])) != command['log']:
            raise ValueError('Fixture command/log evidence changed')
    for fixture in receipt['fixtures'].values():
        stage = checked_relative(ROOT, fixture['root'])
        if source_inventory(stage) != fixture['inputs']:
            raise ValueError(f'Staged inputs changed: {stage}')
        manifest, manifest_file, inventory = manifest_record(stage)
        if manifest_file != fixture['manifest'] or inventory != fixture['inventory']:
            raise ValueError('Sealed complete dist inventory changed')
        if manifest['build'] != fixture['build'] or manifest['deploymentId'] != fixture['deploymentId']:
            raise ValueError('Sealed emitted build identity changed')
        for row in fixture['native']['publication'] + fixture['native']['evidence']:
            if summary(checked_relative(ROOT, row['path'])) != {key: row[key] for key in ('bytes', 'sha256')}:
                raise ValueError('Sealed native publication/evidence changed')
        probe = fixture['semanticProbe']
        if record(checked_relative(ROOT, probe['path'])) != {key: probe[key] for key in ('path', 'bytes', 'sha256')}:
            raise ValueError('Sealed native probe changed')
        if load_json(checked_relative(ROOT, probe['path'])) != probe['result']:
            raise ValueError('Probe receipt/result differ')
    validate_relationships(receipt['fixtures'])
    return receipt


def generate(args):
    capture_id = args.capture_id or datetime.now(timezone.utc).strftime('%y%m%d%H%M%S') + '-' + uuid.uuid4().hex[:4]
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,27}', capture_id):
        raise ValueError('Capture ID must be a short safe filename (at most 28 characters)')
    capture = ROOT / '.build/cf' / capture_id
    if capture.exists():
        raise ValueError('Capture already exists; create a new ID rather than overwriting immutable evidence')
    capture.parent.mkdir(parents=True, exist_ok=True)
    if capture.parent.is_symlink() or not capture.resolve().is_relative_to(ROOT.resolve()):
        raise ValueError('Unsafe fixture output directory')
    capture.mkdir()
    sdk = (args.sdk or ROOT / '.tools/emsdk').resolve()
    node = (args.node or ROOT / '.tools/node-v24.21.0-win-x64/node.exe').resolve()
    python = Path(sys.executable).resolve()
    safe_regular(node)
    os.environ['EMSDK'] = str(sdk)
    spec = importlib.util.spec_from_file_location('fixture_toolchain', ROOT / 'tools/verify-toolchain.py')
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    cmake, ninja = verifier.tool_locations()
    env = os.environ.copy()
    for name in ('NODE_OPTIONS', 'NODE_PATH', 'VITEST', 'TS_NODE_PROJECT', 'PYTHONPATH', 'PYTHONHOME'):
        env.pop(name, None)
    env.update({'EMSDK': str(sdk), 'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
                'SPLATVIEW_BUILD_PYTHON': str(python)})
    env['PATH'] = os.pathsep.join(str(path) for path in (node.parent, cmake.parent, ninja.parent, python.parent)) + os.pathsep + env.get('PATH', '')
    commands = Commands(capture, env)
    initial = source_inventory(ROOT, with_native=True)
    write_once(capture / 'source-initial.json', initial)
    all_commands = []
    with native_build_lock():
        all_commands.append(commands.run('shipping-native-freshness',
            [python, ROOT / 'tools/verify-toolchain.py', 'verify-build', '--local-evidence'], ROOT))
        all_commands.append(commands.run('shipping-toolchain-codecs',
            [python, ROOT / 'tools/verify-toolchain.py', 'verify'], ROOT))
        observed = verifier.observe_toolchain()
        if observed != load_json(ROOT / 'native/TOOLCHAIN_LOCK.json')['inputs']:
            raise ValueError('Installed compiler/tool/cache drifted before fixture capture')
        tools = {'observedToolchain': observed,
                 'node': {'path': str(node), **summary(node)}, 'python': {'path': str(python), **summary(python)},
                 'cmake': {'path': str(cmake), **summary(cmake)}, 'ninja': {'path': str(ninja), **summary(ninja)},
                 'javascriptBuildEntrypoints': [record(ROOT / name) for name in
                    ('node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js', 'node_modules/.package-lock.json')]}
        native_report = load_json(ROOT / 'public/wasm/build-provenance.json')
        shipping_evidence = []
        for key, name in EVIDENCE.items():
            origin = ROOT / name
            expected = {field: native_report[key][field] for field in ('bytes', 'sha256')}
            destination = capture / 'shipping-native-evidence' / Path(name).name
            copy_verified(origin, destination, expected)
            shipping_evidence.append(record(destination))
        base_rows = [row for row in initial['inventory'] if not row['path'].startswith('public/wasm/')]
        fixtures = {}
        for name in 'ABC':
            stage = capture / name
            stage.mkdir()
            for row in base_rows:
                copy_verified(ROOT / row['path'], stage / row['path'], row)
            expected_base = {**initial, 'inventory': base_rows}
            expected_base.update({'sha256': digest(canonical(base_rows)), 'files': len(base_rows),
                                  'bytes': sum(row['bytes'] for row in base_rows)})
            if source_inventory(stage) != expected_base or source_inventory(ROOT, with_native=True) != initial:
                raise ValueError('Source/stage inventory drifted while copying the physical stage')
            patches = []
            stage_commands = []
            if name == 'B':
                patches.append(patched_file(stage, 'native/wasm/flood_selection.hpp', revise_fill,
                    'Opacity Fill eight-neighbor; RGB Connected Color retains four-neighbor connectivity'))
                patches.append(patched_file(stage, 'native/wasm/runtime-contract.json', revise_contract,
                    'core.capabilities.fillSelection revision 1 to 2; public ABI/protocol unchanged'))
                inputs = source_inventory(stage)
                stage_commands.append(commands.run('B-clean-native-build', [python, stage / 'tools/build-core.py'], stage))
                stage_commands.append(commands.run('B-local-native-evidence',
                    [python, stage / 'tools/verify-toolchain.py', 'verify-build', '--local-evidence'], stage))
                evidence = [record(stage / value) for value in EVIDENCE.values()]
            else:
                if name == 'C':
                    patches.append(patched_file(stage, 'src/styles/app.css', revise_hover,
                        'Actual UI-only hover color #262626 to #272727'))
                inputs = source_inventory(stage)
                source_native = ROOT if name == 'A' else capture / 'A'
                for output in PUBLICATION:
                    origin = source_native / 'public/wasm' / output
                    copy_verified(origin, stage / 'public/wasm' / output, summary(origin))
                evidence = shipping_evidence
            stage_commands.extend(web_build(commands, stage, node, python))
            probe_path = capture / f'{name}-native-probe.json'
            stage_commands.append(commands.run(name + '-real-native-probe', [node, stage / 'tools/probe-compat-fixture.mjs',
                '--root', stage, '--expected-mask', '1,1,0' if name == 'B' else '1,0,0', '--out', probe_path], stage))
            if source_inventory(stage) != inputs:
                raise ValueError(f'{name} staged source inputs changed while building/probing')
            manifest, manifest_file, inventory = manifest_record(stage)
            report = load_json(stage / 'public/wasm/build-provenance.json')
            fixtures[name] = {'root': relative(stage), 'dist': relative(stage / 'dist'), 'manifest': manifest_file,
                'inventory': inventory, 'artifacts': manifest['artifacts'],
                'build': manifest['build'], 'deploymentId': manifest['deploymentId'],
                'nativeMode': 'compiled' if name == 'B' else 'reused', 'inputs': inputs, 'patches': patches,
                'native': {'reuseOf': None if name == 'B' else ('shipping' if name == 'A' else 'A'),
                    'nativeInputId': report['nativeInputId'], 'identity': report['nativeIdentity'],
                    'publication': [{'name': output, **record(stage / 'public/wasm' / output)} for output in PUBLICATION],
                    'evidence': evidence},
                'semanticProbe': {**record(probe_path), 'result': load_json(probe_path)},
                'commands': stage_commands}
            all_commands.extend(stage_commands)
        final = source_inventory(ROOT, with_native=True)
        if final != initial:
            raise ValueError('Shipping source inputs changed during fixture generation; cannot qualify this set')
        if verifier.observe_toolchain() != observed:
            raise ValueError('Shared installed compiler/cache changed while compiling fixtures')
    validate_relationships(fixtures)
    payload = {'schemaVersion': 1, 'kind': 'genuine-coherent-compatibility-fixture-set', 'captureId': capture_id,
        'sourceCapture': {'initial': initial, 'final': final,
            'scope': {'rootFiles': list(ROOT_FILES), 'trees': list(TREES), 'qualifiedNativePublication': list(PUBLICATION),
                'excluded': ['builder-owned src/generated/buildIdentity.ts', 'public/wasm except the five named publications',
                    '__pycache__', '.git', 'node_modules', '.build', 'dist', 'docs', 'root test-results receipts']}},
        'tools': tools, 'shippingNativeEvidence': shipping_evidence, 'commands': all_commands, 'fixtures': fixtures,
        'qualification': 'Local Windows coherent fixture builds, static identity reads and real native Fill semantics. '
            'A/C explicitly reuse a prior clean native build. No browser execution, actual Mac, deployment, publisher '
            'authentication, cross-host reproducibility or independent installed JavaScript dependency authentication is established.'}
    receipt = {**payload, 'fixtureSetId': receipt_identity(payload, node)}
    path = capture / 'fixture-set.json'
    write_once(path, receipt)
    verify_receipt(path, node)
    active = {'schemaVersion': 1, 'receiptPath': relative(path), 'receiptSha256': summary(path)['sha256']}
    temporary = capture.parent / f'active-{capture_id}.tmp.json'
    write_once(temporary, active)
    os.replace(temporary, capture.parent / 'active.json')
    print(json.dumps({'status': 'qualified', **active, 'fixtureSetId': receipt['fixtureSetId']}, indent=2), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    generate_parser = actions.add_parser('generate', help='Build a new physical immutable fixture capture')
    generate_parser.add_argument('--capture-id', help='Unique short ID; never overwrites an existing capture')
    generate_parser.add_argument('--sdk', type=Path, help='Existing reviewed absolute Emscripten SDK installation')
    generate_parser.add_argument('--node', type=Path, help='Pinned Node executable (defaults to workspace Node24.21.0)')
    verify_parser = actions.add_parser('verify', help='Recheck immutable inputs, command evidence, probes and complete emitted trees')
    verify_parser.add_argument('--receipt', type=Path, help='Immutable receipt or active pointer; defaults to .build/cf/active.json')
    args = parser.parse_args()
    if args.action == 'generate':
        generate(args)
    else:
        path = (args.receipt or ROOT / '.build/cf/active.json').resolve()
        value = load_json(path)
        if 'receiptPath' in value:
            target = checked_relative(ROOT, value['receiptPath'])
            if value.get('schemaVersion') != 1 or summary(target)['sha256'] != value.get('receiptSha256'):
                raise ValueError('Active fixture pointer/receipt hash differs')
            path = target
        receipt = verify_receipt(path)
        print(json.dumps({'status': 'verified', 'receiptPath': relative(path), 'fixtureSetId': receipt['fixtureSetId']}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
