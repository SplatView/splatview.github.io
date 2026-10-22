"""Genuinely build three immutable W26 application cohorts with exact native reuse.

Unlike the behavioral compatibility generator, every cohort reuses the five
shipping native/provenance files. A/B differ only by an authored main.tsx
comment. C also changes one offline error-page title in its staged copy, so
a compatible generic service-worker update has genuinely different bytes.
The protocol, storage schema and algorithms are unchanged. Each ordinary
npm build derives its own application identity and verified runtime closure.
Run after all covered source edits stop. A failure leaves diagnostic output
and never publishes fixture-set.json. No native compilation is performed.
"""
from pathlib import Path
import argparse
import ast
import importlib.util
import json
import os
import re
import sys

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('offline_compat_helpers', ROOT / 'tools/build-compat-fixtures.py')
helpers = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helpers)
CAPTURE_SPEC = importlib.util.spec_from_file_location('offline_reviewed_capture_inputs', ROOT / 'tools/capture-sources.py')
capture_sources = importlib.util.module_from_spec(CAPTURE_SPEC)
CAPTURE_SPEC.loader.exec_module(capture_sources)
TITLE_BEFORE = b'<title>SplatView offline unavailable</title>'
TITLE_AFTER = b'<title>SplatView offline cache unavailable</title>'
EXTRA_ROOT_FILES = ('playwright.offline.config.ts',)
PROVENANCE_AUTHORITIES = ('tools/capture-sources.py', 'tools/generate-assets.py', 'tools/generate-native-translations.py')


def assigned_node(filename, name):
    """Inspect reviewed constants without executing asset generation or argparse."""
    path = ROOT / filename
    helpers.safe_regular(path)
    module = ast.parse(path.read_text(encoding='utf-8'), filename=filename)
    values = [node.value for node in module.body if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == name for target in node.targets)]
    if len(values) != 1:
        raise ValueError(f'Expected one reviewed top-level assignment: {filename}:{name}')
    return values[0]


def assigned_literal(filename, name):
    return ast.literal_eval(assigned_node(filename, name))


def reviewed_capture_path(filename, name, path_call=False):
    node = assigned_node(filename, name)
    if path_call:
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'Path'
                and len(node.args) == 1 and not node.keywords):
            raise ValueError(f'Reviewed Path literal shape changed: {filename}:{name}')
        value = ast.literal_eval(node.args[0])
    else:
        if not (isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div)
                and isinstance(node.left, ast.Name) and node.left.id == 'root'):
            raise ValueError(f'Reviewed root-relative path shape changed: {filename}:{name}')
        value = ast.literal_eval(node.right)
    if not isinstance(value, str):
        raise ValueError('Reviewed capture path must be a literal string')
    helpers.checked_relative(ROOT, value)
    return value


def reviewed_override_leaves():
    """Qualify the complete three-verifier supplement without a capture-tree walk."""
    failures = []
    capture_sources.reviewed_icon_sources(failures)
    if failures:
        raise ValueError('Reviewed icon provenance is not qualified: ' + '; '.join(failures))
    names = set()
    for override in capture_sources.REVIEWED_ICON_OVERRIDES.values():
        base = override['captureRoot']
        names.add(base + '/CAPTURE_MANIFEST.json')
        names.add(base + '/source/' + override['record']['path'])
    asset_script = 'tools/generate-assets.py'
    language_script = 'tools/generate-native-translations.py'
    asset_base = reviewed_capture_path(asset_script, 'current_capture')
    language_base = reviewed_capture_path(language_script, 'CAPTURE_RELATIVE', path_call=True)
    captures = {}

    def checked_summary(name):
        path = helpers.checked_relative(ROOT, name)
        if path.resolve() != path.absolute():
            raise ValueError(f'Linked reviewed supplemental input: {name}')
        return helpers.summary(path)

    def expected_record(value):
        if not isinstance(value, tuple) or len(value) != 2 or type(value[0]) is not int or value[0] < 0 or \
                not isinstance(value[1], str) or not re.fullmatch('[a-f0-9]{64}', value[1]):
            raise ValueError('Reviewed source digest tuple changed shape')
        return {'bytes': value[0], 'sha256': value[1]}

    for base in (asset_base, language_base):
        name = base + '/CAPTURE_MANIFEST.json'
        checked_summary(name)
        manifest = json.loads((ROOT / name).read_text(encoding='utf-8'), object_pairs_hook=capture_sources._unique_manifest_object)
        if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1 or not isinstance(manifest.get('files'), list):
            raise ValueError('Reviewed supplemental capture manifest changed shape')
        captures[base] = manifest
        names.add(name)
    manifest_expected = expected_record(assigned_literal(language_script, 'CAPTURE_MANIFEST'))
    if checked_summary(language_base + '/CAPTURE_MANIFEST.json') != manifest_expected or \
            captures[language_base].get('captureId') != assigned_literal(language_script, 'CAPTURE_ID'):
        raise ValueError('Reviewed translation capture manifest identity or pinned bytes differ')
    for base, filename, constant in ((asset_base, asset_script, 'supplemental_records'),
                                     (language_base, language_script, 'SOURCE_RECORDS')):
        records = assigned_literal(filename, constant)
        if not isinstance(records, dict) or not records:
            raise ValueError(f'Reviewed source record table changed shape: {filename}:{constant}')
        for relative, value in records.items():
            expected = expected_record(value)
            name = base + '/source/' + relative
            matches = [row for row in captures[base]['files'] if isinstance(row, dict) and row.get('path') == relative]
            if len(matches) != 1 or any(matches[0].get(key) != expected[key] for key in expected) or checked_summary(name) != expected:
                raise ValueError(f'Reviewed supplemental source differs from its authority: {name}')
            names.add(name)
    for name in names:
        helpers.checked_relative(ROOT, name)
    return sorted(names)


def source_inventory(root, override_names, with_native=False):
    """Add only reviewed provenance and the named offline acceptance config."""
    ordinary = helpers.source_inventory(root, with_native=with_native)
    rows = {row['path']: row for row in ordinary['inventory']}
    for name in (*override_names, *EXTRA_ROOT_FILES):
        path = helpers.checked_relative(root, name)
        if path.resolve() != path.absolute():
            raise ValueError(f'Linked supplemental provenance input: {path}')
        row = {'path': name, **helpers.summary(path)}
        if name in rows and rows[name] != row:
            raise ValueError('Supplemental input disagrees with the ordinary capture inventory')
        rows[name] = row
    records = [rows[name] for name in sorted(rows)]
    return {'sha256': helpers.digest(helpers.canonical(records)), 'files': len(records),
            'bytes': sum(row['bytes'] for row in records), 'inventory': records}


def input_differences(before_rows, after_rows, expected_paths):
    """Prove every source outside the explicitly authored patches is identical."""
    before = {row['path']: row for row in before_rows}
    after = {row['path']: row for row in after_rows}
    if before.keys() != after.keys():
        raise ValueError('Staged source membership differs from the frozen shipping capture')
    differences = [{'path': path,
                    'before': {key: before[path][key] for key in ('bytes', 'sha256')},
                    'after': {key: after[path][key] for key in ('bytes', 'sha256')}}
                   for path in sorted(before) if before[path] != after[path]]
    if {row['path'] for row in differences} != expected_paths:
        raise ValueError('A cohort changed sources outside its reviewed authored patches')
    return differences


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture-id', required=True, help='Fresh directory under .build/offline-tests; never overwritten')
    parser.add_argument('--node', type=Path, default=ROOT / '.tools/node-v24.21.0-win-x64/node.exe')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', args.capture_id):
        raise ValueError('Capture ID must be a safe filename with at most 40 characters')
    parent = ROOT / '.build/offline-tests'
    parent.mkdir(parents=True, exist_ok=True)
    for directory in (ROOT, ROOT / '.build', parent):
        if directory.is_symlink() or getattr(directory.stat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError(f'Linked fixture output ancestor: {directory}')
    capture = parent / args.capture_id
    if capture.exists() or capture.is_symlink():
        raise ValueError('Capture already exists; use a fresh ID rather than overwrite evidence')
    capture.mkdir()
    node = args.node.resolve()
    npm = node.parent / 'node_modules/npm/bin/npm-cli.js'
    python = Path(sys.executable).resolve()
    for tool in (node, npm, python):
        helpers.safe_regular(tool)
    dependency_root = ROOT / 'node_modules'
    if dependency_root.is_symlink() or dependency_root.resolve() != dependency_root or not dependency_root.is_dir() or \
            getattr(dependency_root.stat(), 'st_file_attributes', 0) & 0x400:
        raise ValueError('The shared workspace node_modules must be a regular canonical directory')
    dependency_lock = helpers.record(dependency_root / '.package-lock.json')
    tool_records = {name: {'path': str(path), **helpers.summary(path)}
                    for name, path in (('node', node), ('npm', npm), ('python', python))}
    env = os.environ.copy()
    for name in ('NODE_OPTIONS', 'NODE_PATH', 'VITEST', 'TS_NODE_PROJECT', 'PYTHONPATH', 'PYTHONHOME'):
        env.pop(name, None)
    env.update({'PYTHONDONTWRITEBYTECODE': '1', 'PYTHONNOUSERSITE': '1',
                'SPLATVIEW_BUILD_PYTHON': str(python), 'EMSDK': str(ROOT / '.tools/emsdk')})
    env['PATH'] = os.pathsep.join((str(node.parent), str(python.parent), env.get('PATH', '')))
    commands = helpers.Commands(capture, env)
    override_names = reviewed_override_leaves()
    override_authorities = [helpers.record(ROOT / name) for name in PROVENANCE_AUTHORITIES]
    override_initial = [helpers.record(ROOT / name) for name in override_names]
    initial = source_inventory(ROOT, override_names, with_native=True)
    helpers.write_once(capture / 'source-initial.json', initial)
    source_rows = [row for row in initial['inventory'] if not row['path'].startswith('public/wasm/')]
    publication = [{'name': name, **helpers.record(ROOT / 'public/wasm' / name)} for name in helpers.PUBLICATION]
    build_commands = [commands.run('shipping-native-freshness',
        [python, ROOT / 'tools/verify-toolchain.py', 'verify-build'], ROOT)]
    fixtures = {}
    for name in 'ABC':
        stage = capture / name
        stage.mkdir()
        for row in source_rows:
            helpers.copy_verified(ROOT / row['path'], stage / row['path'], row)
        for row in publication:
            helpers.copy_verified(ROOT / row['path'], stage / 'public/wasm' / row['name'], row)
        if source_inventory(ROOT, override_names, with_native=True) != initial:
            raise ValueError('Shipping source changed during fixture copying')
        main_path = stage / 'src/main.tsx'
        before = helpers.summary(main_path)
        original = main_path.read_bytes()
        comment = f'// Offline cohort fixture {name}.\n'.encode('utf-8')
        main_path.write_bytes(comment + original)
        patches = [{'sourcePath': 'src/main.tsx', 'path': helpers.relative(main_path),
                    'description': comment.decode().strip(), 'before': before, 'after': helpers.summary(main_path)}]
        expected_changes = {'src/main.tsx': comment + original}
        if name == 'C':
            store_path = stage / 'src/offline/cohortStore.ts'
            store_original = store_path.read_bytes()
            if store_original.count(TITLE_BEFORE) != 1:
                raise ValueError('The exact offline fallback title anchor must occur once; do not silently rebase it')
            store_before = helpers.summary(store_path)
            changed = store_original.replace(TITLE_BEFORE, TITLE_AFTER, 1)
            store_path.write_bytes(changed)
            expected_changes['src/offline/cohortStore.ts'] = changed
            patches.append({'sourcePath': 'src/offline/cohortStore.ts', 'path': helpers.relative(store_path),
                'description': 'Fixture-only compatible generic-router update: change only the fallback HTML document title',
                'replacement': {'before': TITLE_BEFORE.decode(), 'after': TITLE_AFTER.decode(), 'occurrences': 1},
                'before': store_before, 'after': helpers.summary(store_path)})
        inputs = source_inventory(stage, override_names)
        differences = input_differences(source_rows, inputs['inventory'], set(expected_changes))
        # The stages live under the workspace, so Node/npm naturally discover
        # the one qualified ancestor node_modules. No links or dependency copies
        # are created, and no package installation mutates that dependency set.
        command = commands.run(f'{name}-npm-build', [node, npm, 'run', 'build'], stage)
        build_commands.append(command)
        if source_inventory(stage, override_names) != inputs or any((stage / path).read_bytes() != data
                                                            for path, data in expected_changes.items()):
            raise ValueError(f'{name} staged source changed during its build')
        manifest, manifest_file, inventory = helpers.manifest_record(stage)
        workers = [artifact for artifact in manifest['artifacts'] if artifact['path'] == 'service-worker.js']
        if len(workers) != 1 or workers[0]['role'] != 'runtime-asset':
            raise ValueError(f'{name} did not emit the genuine application-root offline worker')
        staged_publication = [{'name': row['name'], **helpers.record(stage / 'public/wasm' / row['name'])}
                              for row in publication]
        for actual, expected in zip(staged_publication, publication):
            if any(actual[key] != expected[key] for key in ('name', 'bytes', 'sha256')):
                raise ValueError('A native publication changed; this generator permits no native variant')
        override_copies = [{'before': row, 'after': helpers.record(stage / row['path'])} for row in override_initial]
        if any(any(row['before'][key] != row['after'][key] for key in ('bytes', 'sha256')) for row in override_copies):
            raise ValueError('A reviewed supplemental provenance leaf changed while staging')
        acceptance_copies = [{'before': helpers.record(ROOT / path), 'after': helpers.record(stage / path)}
                             for path in EXTRA_ROOT_FILES]
        if any(any(row['before'][key] != row['after'][key] for key in ('bytes', 'sha256')) for row in acceptance_copies):
            raise ValueError('The offline acceptance configuration changed while staging')
        fixtures[name] = {'root': helpers.relative(stage), 'dist': helpers.relative(stage / 'dist'),
            'variant': 'ui-input' if name != 'C' else 'ui-and-compatible-offline-error-title',
            'inputs': inputs, 'patches': patches, 'sourceDifferences': differences,
            'build': manifest['build'], 'deploymentId': manifest['deploymentId'], 'manifest': manifest_file,
            'inventory': inventory, 'serviceWorker': workers[0], 'nativeMode': 'reused',
            'nativePublication': staged_publication, 'reviewedOverrideProvenance': override_copies,
            'acceptanceConfiguration': acceptance_copies, 'command': command}
    final = source_inventory(ROOT, override_names, with_native=True)
    if final != initial:
        raise ValueError('Shipping covered source changed; cannot seal this fixture set')
    values = list(fixtures.values())
    if len({value['deploymentId'] for value in values}) != 3 or len({value['build']['appInputId'] for value in values}) != 3:
        raise ValueError('All three genuine UI-input cohorts require distinct emitted identities')
    if any(value['build']['native'] != values[0]['build']['native'] for value in values):
        raise ValueError('A/B/C native identity must remain exactly equal')
    worker_hashes = {name: fixture['serviceWorker']['sha256'] for name, fixture in fixtures.items()}
    if worker_hashes['A'] != worker_hashes['B'] or worker_hashes['C'] == worker_hashes['A']:
        raise ValueError('A/B require identical generic routers and C requires a genuinely changed compatible router')
    app_ids = [fixture['build']['appInputId'].encode('ascii') for fixture in values]
    for name, fixture in fixtures.items():
        stage = ROOT / fixture['root']
        manifest, manifest_file, inventory = helpers.manifest_record(stage)
        if source_inventory(stage, override_names) != fixture['inputs'] or manifest_file != fixture['manifest'] or \
                inventory != fixture['inventory'] or manifest['build'] != fixture['build']:
            raise ValueError(f'{name} staged source or output changed before sealing')
        if input_differences(source_rows, fixture['inputs']['inventory'],
                             {patch['sourcePath'] for patch in fixture['patches']}) != fixture['sourceDifferences']:
            raise ValueError(f'{name} source-difference evidence changed')
        if any(app_id in (stage / 'dist/service-worker.js').read_bytes() for app_id in app_ids):
            raise ValueError('A generic router must not embed any per-application descriptor identity')
    if helpers.record(dependency_root / '.package-lock.json') != dependency_lock:
        raise ValueError('Shared dependency root changed')
    if any(helpers.summary(Path(row['path'])) != {key: row[key] for key in ('bytes', 'sha256')}
           for row in tool_records.values()):
        raise ValueError('A pinned build entrypoint changed during fixture generation')
    override_final = [helpers.record(ROOT / name) for name in reviewed_override_leaves()]
    if override_final != override_initial or [helpers.record(ROOT / name) for name in PROVENANCE_AUTHORITIES] != override_authorities:
        raise ValueError('Reviewed override authority or exact provenance leaves changed before sealing')
    payload = {'schemaVersion': 1, 'kind': 'genuine-offline-application-fixture-set', 'captureId': args.capture_id,
        'qualification': 'Three real browser builds with exact shared native publication. A/B differ only in authored UI-input '
            'comments and share identical generic router bytes. C also changes only the fallback HTML document title, '
            'yielding a genuine compatible router-code update with unchanged protocol, storage schema and algorithms. '
            'No native behavioral variant, browser acceptance, deployed host or Mac qualification is claimed.',
        'routerRelationships': {'sha256': worker_hashes, 'aAndBIdentical': True, 'cDiffersFromAAndB': True,
            'perApplicationIdentityEmbedded': False,
            'closureQualification': 'Each ordinary production build enforces one self-contained worker and forbids its generated buildIdentity.ts dependency'},
        'sourceCapture': {'initial': initial, 'final': final, 'additionalRootFiles': list(EXTRA_ROOT_FILES)},
        'reviewedOverrideProvenance': {'authorities': override_authorities,
            'scope': 'Exact reviewed capture manifest, icon supplement and translation source leaves from all verify:sources gates; no supplemental tree enumeration',
            'initial': override_initial, 'final': override_final},
        'tools': {**tool_records, 'sharedDependencyLock': dependency_lock,
            'dependencyResolution': 'Canonical workspace ancestor node_modules; no junction or installation created'},
        'shippingNativePublication': publication, 'commands': build_commands, 'fixtures': fixtures}
    receipt = {**payload, 'fixtureSetId': helpers.receipt_identity(payload, node)}
    helpers.write_once(capture / 'fixture-set.json', receipt)
    print(json.dumps({'status': 'qualified', 'receiptPath': helpers.relative(capture / 'fixture-set.json'),
                      'fixtureSetId': receipt['fixtureSetId']}, indent=2), flush=True)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
        raise SystemExit(str(error)) from error
