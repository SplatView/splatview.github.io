import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertApplicationClosure, assertBuildInputsUnchanged, canonicalJson, collectApplicationInputs, copyQualifiedPublic, createDeploymentManifest,
  descriptorFromInputs, emittedBundlePaths, prepareBuild, protectHtml, sha256, webBuildIdentityPlugin, workerClosurePlugin, workerEntryFileName, writeDeploymentManifest } from '../web-build.mjs';

const nativeInputId = sha256('native inputs A');
const contract = {
  schemaVersion: 1, protocolVersion: 6, uiWorkerContract: 1,
  core: { schemaVersion: 1, kind: 'core', abi: 6, variant: 'scalar', mapLayoutVersion: 1,
    capabilities: { atomicCheckpoint: 1, selectionMap: 1 } },
  camera: { schemaVersion: 1, kind: 'camera', abi: 1, variant: 'scalar', capabilities: { cameraInput: 1 } },
};
const provenance = {
  schemaVersion: 1, nativeInputId, nativeIdentity: {
    core: { ...contract.core, nativeInputId }, camera: { ...contract.camera, nativeInputId },
  },
};
const input = path => ({ path, bytes: path.length, sha256: sha256(path) });
const baseFiles = [input('index.html'), input('src/main.tsx')];
const descriptor = descriptorFromInputs(baseFiles, contract, provenance);
const runtimePaths = ['index.html', 'assets/index-A.js', 'assets/document.worker-A.js',
  'wasm/splatview-core.mjs', 'wasm/splatview-core.wasm', 'wasm/splatview-camera.mjs',
  'wasm/splatview-camera.wasm', 'wasm/build-provenance.json', 'assets/index-A.css',
  'icons/selection-square.svg', 'assets/lazy-A.js'];
const manifest = (files = runtimePaths.map(input)) => createDeploymentManifest(descriptor, files,
  'assets/index-A.js', 'assets/document.worker-A.js');

function writePublicInventory(root, files) {
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'tools/public-assets.json'), JSON.stringify({ schemaVersion: 1, files }));
}

function publicInventoryFixture(t) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-public-inventory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  for (const path of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'tools/web-build.mjs', 'tools/web-build.d.mts', 'native/wasm/runtime-contract.json',
    'src/main.tsx', 'public/icons/check.svg']) write(path, path);
  writePublicInventory(root, ['icons/check.svg']);
  return { root, write };
}

test('canonical deployment identity sorts object keys recursively and preserves array order', () => {
  assert.equal(canonicalJson({ z: [{ b: 2, a: 'é' }], a: true }), '{"a":true,"z":[{"a":"é","b":2}]}');
  assert.equal(sha256(canonicalJson({ b: 2, a: 1 })), sha256(canonicalJson({ a: 1, b: 2 })));
  assert.notEqual(sha256(canonicalJson([1, 2])), sha256(canonicalJson([2, 1])));
  for (const invalid of [undefined, NaN, Infinity, { bad: undefined }, new Date()]) {
    assert.throws(() => canonicalJson(invalid), /finite JSON/);
  }
});

test('UI-only content changes app identity and can reuse the exact native identity', () => {
  const files = structuredClone(baseFiles);
  files[1].sha256 = sha256('changed UI');
  const next = descriptorFromInputs(files, contract, provenance);
  assert.notEqual(next.appInputId, descriptor.appInputId);
  assert.deepEqual(next.native, descriptor.native);
  assert.equal(next.native.core.abi, descriptor.native.core.abi);
});

test('same ABI and changed command semantic revision changes compiled app identity', () => {
  const changed = structuredClone(contract);
  changed.uiWorkerContract += 1;
  const next = descriptorFromInputs(baseFiles, changed, provenance);
  assert.notEqual(next.appInputId, descriptor.appInputId);
  assert.deepEqual(next.native, descriptor.native);
});

test('native capability revisions are derived from reviewed required contract, never copied blindly from a report', () => {
  const changed = structuredClone(provenance);
  changed.nativeIdentity.core.capabilities.atomicCheckpoint += 1;
  assert.throws(() => descriptorFromInputs(baseFiles, contract, changed), /differs from required contract/);
  const changedContract = structuredClone(contract);
  changedContract.core.capabilities.atomicCheckpoint += 1;
  const next = descriptorFromInputs(baseFiles, changedContract, changed);
  assert.notEqual(next.appInputId, descriptor.appInputId);
  assert.equal(next.native.core.abi, descriptor.native.core.abi);
});

test('legacy provenance, missing capabilities, wrong variant and missing identity are refused', () => {
  assert.throws(() => descriptorFromInputs(baseFiles, contract, { schemaVersion: 1 }), /identity is missing/);
  for (const mutate of [
    value => { delete value.nativeIdentity.camera; },
    value => { delete value.nativeIdentity.core.capabilities.selectionMap; },
    value => { value.nativeIdentity.core.variant = 'simd'; },
    value => { value.nativeIdentity.camera.nativeInputId = sha256('different'); },
  ]) {
    const changed = structuredClone(provenance);
    mutate(changed);
    assert.throws(() => descriptorFromInputs(baseFiles, contract, changed), /differs from required contract/);
  }
});

test('invalid protocol and capability revisions are refused', () => {
  for (const change of [
    value => { value.protocolVersion = 0; },
    value => { value.uiWorkerContract = 1.5; },
    value => { value.core.mapLayoutVersion = -1; },
    value => { value.camera.capabilities.cameraInput = 0; },
  ]) {
    const changed = structuredClone(contract);
    change(changed);
    assert.throws(() => descriptorFromInputs(baseFiles, changed, provenance), /Invalid/);
  }
});

test('final manifest covers copied native assets, emitted worker, CSS, runtime assets and lazy chunks', () => {
  const result = manifest();
  assert.equal(result.artifacts.length, runtimePaths.length);
  assert.equal(result.artifacts.find(item => item.path === 'assets/document.worker-A.js').role, 'document-worker');
  assert.equal(result.artifacts.find(item => item.path === 'assets/index-A.css').role, 'stylesheet');
  assert.equal(result.artifacts.find(item => item.path === 'assets/lazy-A.js').role, 'runtime-asset');
  const { deploymentId, ...payload } = result;
  assert.equal(deploymentId, sha256(canonicalJson(payload)));
  assert.equal(deploymentId, manifest(runtimePaths.toReversed().map(input)).deploymentId);
});

test('deployment identity changes for tampered final emitted bytes even when all names are unchanged', () => {
  const records = runtimePaths.map(input);
  records.find(record => record.path.endsWith('.wasm')).sha256 = sha256('changed wasm');
  assert.notEqual(manifest(records).deploymentId, manifest().deploymentId);
});

test('executing entry and linked CSS receive exact emitted-byte SRI before HTML manifest hashing', () => {
  const entry = Buffer.from('export const app = "coherent";');
  const css = Buffer.from('body { color: #eee; }');
  const records = runtimePaths.map(input).map(record => record.path === 'assets/index-A.js'
    ? { ...record, bytes: entry.length, sha256: sha256(entry) }
    : record.path === 'assets/index-A.css' ? { ...record, bytes: css.length, sha256: sha256(css) } : record);
  const html = '<script type="module" crossorigin src="./assets/index-A.js"></script>\n<link href="./assets/index-A.css" rel="stylesheet">';
  const protectedHtml = protectHtml(html, records, 'assets/index-A.js');
  assert(protectedHtml.includes(`integrity="sha256-${Buffer.from(sha256(entry), 'hex').toString('base64')}" crossorigin="anonymous"`));
  assert(protectedHtml.includes(`integrity="sha256-${Buffer.from(sha256(css), 'hex').toString('base64')}" crossorigin="anonymous"`));
  assert.equal(protectHtml(protectedHtml, records, 'assets/index-A.js'), protectedHtml);
  const finalRecords = records.map(record => record.path === 'index.html'
    ? { ...record, bytes: Buffer.byteLength(protectedHtml), sha256: sha256(protectedHtml) } : record);
  const result = manifest(finalRecords);
  assert.equal(result.artifacts.find(item => item.role === 'html').sha256, sha256(protectedHtml));
  assert.notEqual(result.deploymentId, manifest(records).deploymentId);
});

test('HTML integrity protection rejects absent, ambiguous and foreign entry/stylesheet references', () => {
  const records = runtimePaths.map(input);
  const entry = '<script type="module" src="./assets/index-A.js"></script>';
  for (const html of ['', entry + entry,
    '<script type="module" src="./assets/other.js"></script>',
    `${entry}<link rel="stylesheet" href="https://other.test/a.css">`,
    `${entry}<link rel="stylesheet" href="./assets/absent.css">`,
    `${entry}<link rel="stylesheet" href="./assets/index-A.css?next=1">`]) {
    assert.throws(() => protectHtml(html, records, 'assets/index-A.js'), /qualified|absent/);
  }
});

test('duplicate artifacts, missing roles, malformed digests and ambiguous entry are refused', () => {
  assert.throws(() => manifest([...runtimePaths.map(input), input('assets/index-A.js')]), /Duplicate/);
  for (const path of runtimePaths.slice(0, 8)) {
    assert.throws(() => manifest(runtimePaths.filter(item => item !== path).map(input)), /exactly one/);
  }
  const records = runtimePaths.map(input);
  records[0].sha256 = 'BAD';
  assert.throws(() => manifest(records), /Invalid deployment artifact digest/);
  assert.throws(() => createDeploymentManifest(descriptor, runtimePaths.map(input),
    'assets/document.worker-A.js', 'assets/document.worker-A.js'), /exactly one/);
});

test('URL escape aliases, queries, fragments, credentials and encoded traversal paths are refused before publishing', () => {
  for (const path of ['../x.js', '/x.js', 'assets//x.js', 'assets/./x.js', 'assets/../x.js',
    'assets/x.js?v=1', 'assets/x.js#hash', 'https://evil.test/x.js', 'assets/%2e%2e/x.js',
    'assets\\x.js', 'assets/@user.js', 'assets/x js']) {
    assert.throws(() => manifest([...runtimePaths.map(input), input(path)]), /Unsafe deployment artifact path/);
  }
});

test('application input inventory excludes generated identities/native outputs and includes runtime source and reviewed public assets', t => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-web-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'tools/web-build.mjs', 'tools/web-build.d.mts', 'native/wasm/runtime-contract.json',
    'src/main.tsx', 'src/shaders/splat.wgsl', 'src/generated/buildIdentity.ts',
    'public/icons/check.svg', 'public/wasm/build-provenance.json', 'public/wasm/splatview-core.wasm'];
  for (const path of files) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path); }
  writePublicInventory(root, ['icons/check.svg']);
  const inventory = collectApplicationInputs(root);
  assert(inventory.some(item => item.path === 'src/shaders/splat.wgsl'));
  assert(inventory.some(item => item.path === 'public/icons/check.svg'));
  assert(inventory.some(item => item.path === 'tools/public-assets.json'));
  assert(!inventory.some(item => item.path === 'src/generated/buildIdentity.ts' || item.path.startsWith('public/wasm/')));
  writeFileSync(join(root, 'src/generated/buildIdentity.ts'), 'new derived identity');
  writeFileSync(join(root, 'public/wasm/build-provenance.json'), 'different output timestamp');
  assert.deepEqual(collectApplicationInputs(root), inventory);
  writeFileSync(join(root, 'public/icons/check.svg'), 'new icon');
  assert.notDeepEqual(collectApplicationInputs(root), inventory);
  const main = readFileSync(join(root, 'src/main.tsx'));
  assert.equal(inventory.find(item => item.path === 'src/main.tsx').sha256, sha256(main));
});

test('public inventory refuses compiler junk, temporary files, obsolete scripts/icons and unowned maps', t => {
  const { root, write } = publicInventoryFixture(t);
  const before = collectApplicationInputs(root);
  for (const path of ['unused.obj', 'scratch.tmp', 'assets/index-old.js', 'icons/obsolete.svg', 'assets/index-old.js.map']) {
    write(`public/${path}`, 'unreviewed public output');
    assert.throws(() => collectApplicationInputs(root), /Unreviewed public asset/, path);
    assert.equal(readFileSync(join(root, 'public', path), 'utf8'), 'unreviewed public output');
    rmSync(join(root, 'public', path));
  }
  assert.deepEqual(collectApplicationInputs(root), before);
});

test('public inventory refuses a missing reviewed leaf instead of silently reducing the deployment', t => {
  const { root } = publicInventoryFixture(t);
  rmSync(join(root, 'public/icons/check.svg'));
  assert.throws(() => collectApplicationInputs(root), /Missing reviewed public asset/);
});

test('public inventory validates schema, exact fields, relative paths and case-insensitive uniqueness', t => {
  const { root, write } = publicInventoryFixture(t);
  const invalid = [null, [], {}, { schemaVersion: 2, files: ['icons/check.svg'] },
    { schemaVersion: 1, files: 'icons/check.svg' }, { schemaVersion: 1, files: [null] },
    { schemaVersion: 1, files: ['icons/check.svg'], extra: true },
    ...['../outside.svg', '/outside.svg', 'icons//check.svg', 'icons/./check.svg', 'icons/../check.svg',
      'icons/check.svg?next=1', 'icons/check.svg#fragment', 'icons/%2e%2e/outside.svg', 'icons\\check.svg',
      'https://other.test/check.svg'].map(path => ({ schemaVersion: 1, files: ['icons/check.svg', path] })),
    { schemaVersion: 1, files: ['icons/check.svg', 'icons/check.svg'] },
    { schemaVersion: 1, files: ['icons/check.svg', 'icons/CHECK.svg'] }];
  for (const value of invalid) {
    write('tools/public-assets.json', JSON.stringify(value));
    assert.throws(() => collectApplicationInputs(root), /public asset inventory|Unsafe deployment artifact path/, JSON.stringify(value));
  }
  write('tools/public-assets.json', '{');
  assert.throws(() => collectApplicationInputs(root), /public asset inventory/);
  writePublicInventory(root, ['icons/check.svg']);
  assert.doesNotThrow(() => collectApplicationInputs(root));
});

test('explicitly reviewing an additional public asset changes application identity and retains native identity', t => {
  const { root, write } = publicInventoryFixture(t);
  const before = descriptorFromInputs(collectApplicationInputs(root), contract, provenance);
  write('public/icons/additional.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.throws(() => collectApplicationInputs(root), /Unreviewed public asset/);
  writePublicInventory(root, ['icons/check.svg', 'icons/additional.svg']);
  const inputs = collectApplicationInputs(root);
  assert(inputs.some(item => item.path === 'public/icons/additional.svg'));
  const after = descriptorFromInputs(inputs, contract, provenance);
  assert.notEqual(after.appInputId, before.appInputId);
  assert.deepEqual(after.native, before.native);
});

test('application input inventory rejects linked files instead of hashing an external path', t => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-web-build-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'tools/web-build.mjs', 'tools/web-build.d.mts', 'native/wasm/runtime-contract.json', 'public/icon.svg'];
  for (const path of files) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), path); }
  writePublicInventory(root, ['icon.svg']);
  mkdirSync(join(root, 'src'));
  // A directory junction is available to unprivileged Windows test processes.
  symlinkSync(join(root, 'public'), join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => collectApplicationInputs(root), /Symlink/);
});

test('worker closure gate rejects static imports and separately emitted dynamic worker chunks', () => {
  const check = bundle => workerClosurePlugin().generateBundle({}, bundle);
  assert.doesNotThrow(() => check({ worker: { type: 'chunk', imports: [], dynamicImports: [] },
    map: { type: 'asset' } }));
  assert.throws(() => check({ worker: { type: 'chunk', imports: ['shared.js'], dynamicImports: [] } }), /self-contained/);
  assert.throws(() => check({ worker: { type: 'chunk', imports: [], dynamicImports: ['lazy.js'] } }), /self-contained/);
  assert.throws(() => check({ worker: { type: 'chunk', imports: [], dynamicImports: [] },
    extra: { type: 'chunk', imports: [], dynamicImports: [] } }), /self-contained/);
});

test('only the offline service-worker source receives a stable application-root name for Pages scope', () => {
  for (const facadeModuleId of ['/work/src/offline/service.worker.ts', 'C:\\work\\src\\offline\\service.worker.ts',
    '/work/src/offline/service.worker.ts?worker_file&type=module', 'src/offline/service.worker.ts']) {
    assert.equal(workerEntryFileName({ facadeModuleId }), 'service-worker.js');
  }
  for (const facadeModuleId of [null, '/work/src/core/document.worker.ts', '/work/src/service.worker.ts',
    '/work/src/offline/service.worker.tsx', '/work/src/offline/service.worker.ts/extra',
    '/work/src/other/service.worker.ts']) {
    assert.equal(workerEntryFileName({ facadeModuleId }), 'assets/[name]-[hash].js');
  }
});

test('generic service-worker closure cannot embed the generated per-application descriptor', () => {
  const chunk = { type: 'chunk', facadeModuleId: '/work/src/offline/service.worker.ts', imports: [], dynamicImports: [],
    moduleIds: ['/work/src/offline/service.worker.ts', '/work/src/build/verification.ts'] };
  const check = entry => workerClosurePlugin().generateBundle({}, { entry });
  assert.doesNotThrow(() => check(chunk));
  for (const generated of ['/work/src/generated/buildIdentity.ts', 'C:\\work\\src\\generated\\buildIdentity.ts?direct']) {
    assert.throws(() => check({ ...chunk, moduleIds: [...chunk.moduleIds, generated] }), /cannot embed/);
  }
});

test('application entry closure rejects unchecked imports before HTML SRI can qualify it', () => {
  const entry = { type: 'chunk', isEntry: true, fileName: 'assets/index-A.js', imports: [], dynamicImports: [] };
  assert.equal(assertApplicationClosure({ entry }), entry.fileName);
  assert.throws(() => assertApplicationClosure({}), /self-contained/);
  assert.throws(() => assertApplicationClosure({ entry, other: { ...entry, fileName: 'assets/other.js' } }), /self-contained/);
  assert.throws(() => assertApplicationClosure({ entry, extra: { ...entry, isEntry: false, fileName: 'assets/extra.js' } }), /self-contained/);
  assert.throws(() => assertApplicationClosure({ entry: { ...entry, imports: ['assets/shared.js'] } }), /self-contained/);
  assert.throws(() => assertApplicationClosure({ entry: { ...entry, dynamicImports: ['assets/lazy.js'] } }), /self-contained/);
});

function qualifiedFixture(t) {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-web-build-qualified-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  function write(path, content) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  for (const path of ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'tools/web-build.mjs', 'tools/web-build.d.mts', 'src/main.tsx', 'public/icons/check.svg',
    'tools/build-core.py', 'tools/capture-sources.py', 'tools/spz_stream_cleanup.py',
    'tools/json_cleanup_overlay.py', 'native/wasm/bindings.cpp',
    'public/wasm/splatview-core.mjs', 'public/wasm/splatview-core.wasm',
    'public/wasm/splatview-camera.mjs', 'public/wasm/splatview-camera.wasm']) write(path, path);
  writePublicInventory(root, ['icons/check.svg']);
  write('tools/verify-toolchain.py', readFileSync(new URL('../verify-toolchain.py', import.meta.url)));
  write('native/wasm/runtime-contract.json', readFileSync(new URL('../../native/wasm/runtime-contract.json', import.meta.url)));
  write('native/SOURCE_LOCK.json', JSON.stringify({ schemaVersion: 1, capturedUtc: 'fixture-time',
    windowsBehaviorVersion: '0.12.82', packages: { splatview: { files: 1, treeSha256: 'a'.repeat(64), origin: '/fixture' } },
    files: [{ package: 'splatview', path: 'native/upstream/splatview/src/core/model.cpp', bytes: 10, sha256: 'b'.repeat(64) }] }));
  write('native/DEPENDENCIES.json', JSON.stringify({ codec: { version: '1', sha256: 'c'.repeat(64) } }));
  write('native/TOOLCHAIN_LOCK.json', JSON.stringify({ schemaVersion: 1, inputs: { host: 'fixture',
    files: { compiler: { bytes: 20, sha256: 'd'.repeat(64) } } } }));
  // Real verification logic qualifies this disposable input/output fixture. It
  // does not claim the opaque fixture modules are executable native artifacts.
  execFileSync(process.env.SPLATVIEW_BUILD_PYTHON || 'python', ['-c', `
import importlib.util, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('verifier', root / 'tools/verify-toolchain.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
inputs = verifier.build_inputs(root)
identities = verifier.runtime_identities(root, inputs)
names = ('splatview-core.mjs', 'splatview-core.wasm', 'splatview-camera.mjs', 'splatview-camera.wasm')
report = {'schemaVersion': 1, 'buildMode': 'clean-first', 'inputs': inputs,
 'nativeInputId': identities['core']['nativeInputId'], 'nativeIdentity': identities,
 'outputs': {name: verifier.file_summary(root / 'public/wasm' / name) for name in names}}
(root / 'public/wasm/build-provenance.json').write_text(json.dumps(report), encoding='utf-8')
verifier.verify_build_report(root)
`, root], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  return { root, write, snapshot: prepareBuild(root) };
}

test('postbundle source, public inventory, generated descriptor and published native mutations refuse publication', t => {
  const { root, snapshot } = qualifiedFixture(t);
  assert.doesNotThrow(() => assertBuildInputsUnchanged(snapshot));
  for (const path of ['src/main.tsx', 'tools/public-assets.json', 'src/generated/buildIdentity.ts', 'public/wasm/splatview-camera.wasm']) {
    const original = readFileSync(join(root, path));
    // Keep the inventory valid JSON with identical membership. Its exact
    // reviewed source bytes are still covered by the build snapshot.
    const change = path === 'tools/public-assets.json' ? '\n ' : ' changed during bundling';
    writeFileSync(join(root, path), Buffer.concat([original, Buffer.from(change)]));
    assert.throws(() => assertBuildInputsUnchanged(snapshot), /inputs changed while bundling/, path);
    writeFileSync(join(root, path), original);
  }
  assert.doesNotThrow(() => assertBuildInputsUnchanged(snapshot));
  // Native-source freshness is still checked when published outputs and every
  // application input are unchanged; the native gate is not replaced by JS IDs.
  writeFileSync(join(root, 'native/wasm/bindings.cpp'), 'changed native adapter');
  assert.throws(() => assertBuildInputsUnchanged(snapshot), /Build report is stale/);
});

const emittedPaths = ['index.html', 'assets/index-A.js', 'assets/index-A.css', 'assets/document.worker-A.js',
  'assets/index-A.js.map', 'assets/document.worker-A.js.map'];

function emittedFixture(t, { serviceWorker = false } = {}) {
  const { root, write, snapshot } = qualifiedFixture(t);
  copyQualifiedPublic(snapshot, join(root, 'dist'));
  write('dist/index.html', '<script type="module" src="./assets/index-A.js"></script><link rel="stylesheet" href="./assets/index-A.css">');
  write('dist/assets/index-A.js', 'export const app = 1;\n//# sourceMappingURL=index-A.js.map');
  write('dist/assets/index-A.css', 'body {}');
  write('dist/assets/document.worker-A.js', 'self.onmessage = () => {};\n//# sourceMappingURL=document.worker-A.js.map');
  if (serviceWorker) write('dist/service-worker.js', 'self.addEventListener("fetch", () => {});\n//# sourceMappingURL=service-worker.js.map');
  for (const owner of ['assets/index-A.js', 'assets/document.worker-A.js', ...(serviceWorker ? ['service-worker.js'] : [])]) write(`dist/${owner}.map`, JSON.stringify({
    version: 3, file: basename(owner), sources: ['../src/main.tsx'], sourcesContent: ['fixture source'], names: [], mappings: '',
  }));
  return { root, write, snapshot, publish: () => writeDeploymentManifest(snapshot, join(root, 'dist'),
    'assets/index-A.js', 'assets/document.worker-A.js',
    [...emittedPaths, ...(serviceWorker ? ['service-worker.js', 'service-worker.js.map'] : [])], serviceWorker ? 'service-worker.js' : undefined) };
}

test('stable root service-worker bytes are runtime inventory and its exact third map stays debug metadata', t => {
  const { root, write, snapshot, publish } = emittedFixture(t, { serviceWorker: true });
  const originalMap = readFileSync(join(root, 'dist/service-worker.js.map'));
  const first = publish(), worker = first.artifacts.find(item => item.path === 'service-worker.js');
  assert.equal(first.artifacts.length, 11);
  assert.equal(worker.role, 'runtime-asset');
  assert.equal(worker.sha256, sha256(readFileSync(join(root, 'dist/service-worker.js'))));
  assert(!first.artifacts.some(item => item.path.endsWith('.map') || item.path === 'build-manifest.json'));
  assert.deepEqual(readFileSync(join(root, 'dist/service-worker.js.map')), originalMap);
  assert.equal(first.build.appInputId, snapshot.descriptor.appInputId);
  write('dist/service-worker.js', 'self.addEventListener("fetch", () => { /* changed generic worker */ });\n//# sourceMappingURL=service-worker.js.map');
  const second = publish();
  assert.notEqual(second.deploymentId, first.deploymentId);
  assert.deepEqual(second.build, first.build);
});

test('explicit render executor ownership qualifies exact script/map bytes and rejects other executable names', t => {
  const { root, write, snapshot } = emittedFixture(t, { serviceWorker: true });
  const executor = 'assets/compute.worker-A.js';
  write(`dist/${executor}`, 'self.onmessage = () => {};\n//# sourceMappingURL=compute.worker-A.js.map');
  write(`dist/${executor}.map`, JSON.stringify({ version: 3, file: 'compute.worker-A.js', sources: ['../src/renderer/webgl2/compute.worker.ts'], sourcesContent: ['executor'], names: [], mappings: '' }));
  const emitted = [...emittedPaths, 'service-worker.js', 'service-worker.js.map', executor, `${executor}.map`];
  const publish = path => writeDeploymentManifest(snapshot, join(root, 'dist'), 'assets/index-A.js', 'assets/document.worker-A.js', emitted, 'service-worker.js', path);
  assert.throws(() => publish(undefined), /Unowned emitted script/);
  for (const path of ['assets/extra.js', 'compute.worker-A.js', 'assets/compute.worker.js', '../compute.worker-A.js']) {
    assert.throws(() => publish(path), /content-addressed/);
  }
  const manifest = publish(executor), record = manifest.artifacts.find(item => item.path === executor);
  assert.equal(record.role, 'runtime-asset'); assert.equal(record.sha256, sha256(readFileSync(join(root, 'dist', executor))));
  assert(!manifest.artifacts.some(item => item.path.endsWith('.map')));
  write(`dist/${executor}.map`, JSON.stringify({ version: 3, file: 'old.js', sources: ['old.ts'], sourcesContent: ['old'] }));
  assert.throws(() => publish(executor), /does not belong/);
});

test('service-worker publication requires the exact root name, emitted source and current owned map', t => {
  const { root, snapshot, publish } = emittedFixture(t, { serviceWorker: true });
  const paths = [...emittedPaths, 'service-worker.js', 'service-worker.js.map'];
  const check = (emitted, serviceWorkerPath = 'service-worker.js') => writeDeploymentManifest(snapshot,
    join(root, 'dist'), 'assets/index-A.js', 'assets/document.worker-A.js', emitted, serviceWorkerPath);
  for (const path of ['assets/service-worker.js', 'service-worker-A.js', 'Service-Worker.js', '../service-worker.js']) {
    assert.throws(() => check(paths, path), /stable application-root/);
  }
  for (const path of ['service-worker.js', 'service-worker.js.map']) {
    assert.throws(() => check(paths.filter(item => item !== path)), /Required emitted bundle path is missing/);
    const absolute = join(root, 'dist', path), bytes = readFileSync(absolute);rmSync(absolute);
    assert.throws(publish, /Missing deployment output/);
    assert(!existsSync(join(root, 'dist/build-manifest.json')));
    writeFileSync(absolute, bytes);
  }
  assert.doesNotThrow(publish);
});

test('service-worker map must belong to its current root script before HTML or manifest publication', t => {
  const { root, write, publish } = emittedFixture(t, { serviceWorker: true });
  const html = readFileSync(join(root, 'dist/index.html'));
  const path = 'dist/service-worker.js.map', original = readFileSync(join(root, path));
  write(path, JSON.stringify({ version: 3, file: 'service-worker-old.js', sources: ['old.ts'], sourcesContent: ['old'] }));
  assert.throws(publish, /does not belong/);
  assert.deepEqual(readFileSync(join(root, 'dist/index.html')), html);
  assert(!existsSync(join(root, 'dist/build-manifest.json')));
  write(path, original);write('dist/service-worker.js', 'self.addEventListener("fetch", () => {});');
  assert.throws(publish, /does not belong/);
  assert.deepEqual(readFileSync(join(root, 'dist/index.html')), html);
  assert(!existsSync(join(root, 'dist/build-manifest.json')));
});

test('production build requires its root service worker even when document worker and app closure are present', t => {
  const { root } = emittedFixture(t);
  const plugin = webBuildIdentityPlugin();
  const previous = process.env.VITEST;delete process.env.VITEST;
  try {
    plugin.configResolved({ mode: 'production', command: 'build', root,
      build: { outDir: 'dist', emptyOutDir: true }, logger: { info() {} } });
  } finally {
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
  const entry = { type: 'chunk', isEntry: true, fileName: 'assets/index-A.js', imports: [], dynamicImports: [] };
  const bundle = { 'assets/index-A.js': entry, 'assets/document.worker-A.js': { type: 'asset', fileName: 'assets/document.worker-A.js' } };
  assert.throws(() => plugin.writeBundle({}, bundle), /requires.*application-root service-worker/);
  assert.throws(() => plugin.writeBundle({}, { ...bundle, 'assets/service-worker-A.js': { type: 'asset', fileName: 'assets/service-worker-A.js' } }), /requires.*application-root service-worker/);
});

test('undeclared service workers and extra emitted executable scripts refuse publication', t => {
  const { root, snapshot } = emittedFixture(t);
  const check = paths => writeDeploymentManifest(snapshot, join(root, 'dist'), 'assets/index-A.js', 'assets/document.worker-A.js', paths);
  for (const path of ['service-worker.js', 'assets/service-worker-old.js', 'assets/extra.js', 'assets/extra.mjs']) {
    assert.throws(() => check([...emittedPaths, path]), /Unowned emitted script/);
  }
  assert.throws(() => check([...emittedPaths, 'service-worker.js.map']), /Unowned emitted source map/);
  assert(!existsSync(join(root, 'dist/build-manifest.json')));
});

test('final disk inventory hashes SRI-protected HTML, retains exact current maps and rejects altered copied native bytes', t => {
  const { root, write, publish } = emittedFixture(t);
  const maps = emittedPaths.filter(path => path.endsWith('.map')).map(path => [path, readFileSync(join(root, 'dist', path))]);
  const result = publish();
  assert.equal(result.artifacts.length, 10);
  const html = readFileSync(join(root, 'dist/index.html'));
  assert.equal(result.artifacts.find(item => item.role === 'html').sha256, sha256(html));
  assert(html.toString().includes('integrity="sha256-'));
  assert(!result.artifacts.some(item => item.path.endsWith('.map') || item.path === 'build-manifest.json'));
  for (const [path, bytes] of maps) assert.deepEqual(readFileSync(join(root, 'dist', path)), bytes);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'dist/build-manifest.json'))), result);
  write('dist/wasm/splatview-core.wasm', 'tampered after copy');
  assert.throws(publish, /Copied native artifact differs/);
});

test('bundle inventory includes declared worker map assets and entry map metadata without reading disk leftovers', () => {
  const bundle = {
    'assets/index-A.js': { type: 'chunk', fileName: 'assets/index-A.js', map: {}, sourcemapFileName: 'assets/index-A.js.map' },
    'assets/document.worker-A.js': { type: 'asset', fileName: 'assets/document.worker-A.js' },
    'assets/document.worker-A.js.map': { type: 'asset', fileName: 'assets/document.worker-A.js.map' },
    'service-worker.js': { type: 'asset', fileName: 'service-worker.js' },
    'service-worker.js.map': { type: 'asset', fileName: 'service-worker.js.map' },
    'index.html': { type: 'asset', fileName: 'index.html' },
  };
  assert.deepEqual(emittedBundlePaths(bundle), ['assets/document.worker-A.js', 'assets/document.worker-A.js.map', 'assets/index-A.js', 'assets/index-A.js.map', 'index.html', 'service-worker.js', 'service-worker.js.map']);
  bundle['assets/index-A.js'].sourcemapFileName = null;
  assert.throws(() => emittedBundlePaths(bundle), /no output filename/);
});

test('stale scripts, old maps, compiler objects and temporary files refuse publication and remain untouched', t => {
  const { root, write, publish } = emittedFixture(t);
  publish();
  const previous = readFileSync(join(root, 'dist/build-manifest.json')), html = readFileSync(join(root, 'dist/index.html'));
  for (const path of ['assets/index-old.js', 'assets/document.worker-old.js', 'assets/index-old.js.map',
    'assets/document.worker-old.js.map', 'old.map', 'unused.obj', 'unused.o', 'scratch.tmp', 'backup.bak', 'stale.old']) {
    write(`dist/${path}`, 'retained diagnostic junk');
    assert.throws(publish, /Unowned deployment output/, path);
    assert.equal(readFileSync(join(root, 'dist', path), 'utf8'), 'retained diagnostic junk');
    assert.deepEqual(readFileSync(join(root, 'dist/build-manifest.json')), previous);
    assert.deepEqual(readFileSync(join(root, 'dist/index.html')), html);
    rmSync(join(root, 'dist', path));
  }
});

test('missing emitted entry, worker, maps, CSS and qualified public/native leaves refuse publication', t => {
  const { root, publish } = emittedFixture(t);
  for (const path of [...emittedPaths, 'icons/check.svg', 'wasm/splatview-core.wasm']) {
    const absolute = join(root, 'dist', path), bytes = readFileSync(absolute);rmSync(absolute);
    assert.throws(publish, /Missing deployment output/, path);
    assert(!existsSync(join(root, 'dist/build-manifest.json')));
    writeFileSync(absolute, bytes);
  }
  assert.doesNotThrow(publish);
});

test('emitted paths are mandatory, unique and safe; only the current entry and worker maps are allowed', t => {
  const { root, snapshot } = emittedFixture(t);
  const check = paths => writeDeploymentManifest(snapshot, join(root, 'dist'), 'assets/index-A.js', 'assets/document.worker-A.js', paths);
  assert.throws(() => check(), /emitted bundle paths are required/);
  for (const paths of [[], emittedPaths.filter(path => path !== 'assets/index-A.js.map')]) assert.throws(() => check(paths), /required|missing/);
  assert.throws(() => check([...emittedPaths, 'assets/old.js.map']), /Unowned emitted source map/);
  assert.throws(() => check([...emittedPaths, 'assets/old.js.MAP']), /Unowned emitted source map/);
  assert.throws(() => check([...emittedPaths, 'build-manifest.json']), /cannot be a bundler output/);
  for (const path of ['../outside.js', 'assets/../outside.js', '/outside.js', 'assets\\outside.js']) assert.throws(() => check([...emittedPaths, path]), /Unsafe/);
  assert.throws(() => check([...emittedPaths, 'assets/index-A.js']), /Duplicate/);
  assert.throws(() => check([...emittedPaths, 'assets/INDEX-A.js']), /case-aliased/);
  assert(!existsSync(join(root, 'dist/build-manifest.json')));
});

test('source-map owner metadata and copied public asset bytes must match before HTML changes', t => {
  const { root, write, publish } = emittedFixture(t);
  const html = readFileSync(join(root, 'dist/index.html')), mapPath = 'dist/assets/index-A.js.map', original = readFileSync(join(root, mapPath));
  write(mapPath, JSON.stringify({ version: 3, file: 'old.js', sources: ['old.ts'], sourcesContent: ['old source'] }));
  assert.throws(publish, /does not belong/);assert.deepEqual(readFileSync(join(root, 'dist/index.html')), html);
  write(mapPath, original);write('dist/icons/check.svg', 'changed copied icon');
  assert.throws(publish, /Copied public asset differs/);assert.deepEqual(readFileSync(join(root, 'dist/index.html')), html);
  assert(!existsSync(join(root, 'dist/build-manifest.json')));
});

test('late unknown output during qualification is caught by a complete second inventory', t => {
  const { root, write, publish } = emittedFixture(t), original = fs.readFileSync;
  const trigger = resolve(root, 'dist/assets/document.worker-A.js.map');let injected = false;
  fs.readFileSync = (path, ...args) => {
    const bytes = original(path, ...args);
    if (!injected && typeof path === 'string' && resolve(path) === trigger) {
      injected = true;write('dist/assets/late-extra.js', 'late writer output');
    }
    return bytes;
  };
  syncBuiltinESMExports();
  try { assert.throws(publish, /output changed before manifest publication/); }
  finally { fs.readFileSync = original;syncBuiltinESMExports(); }
  assert(injected);assert(!existsSync(join(root, 'dist/build-manifest.json')));
  assert.equal(readFileSync(join(root, 'dist/assets/late-extra.js'), 'utf8'), 'late writer output');
});

test('build plugin rejects redirected or linked dist before Vite can empty it', t => {
  const { root, write } = qualifiedFixture(t);
  const outside = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-web-output-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'keep.txt'), 'outside retained');
  const dist = join(root, 'dist');symlinkSync(outside, dist, process.platform === 'win32' ? 'junction' : 'dir');
  const config = { mode: 'production', command: 'build', root, build: { outDir: 'dist', emptyOutDir: true }, logger: { info() {} } };
  assert.throws(() => webBuildIdentityPlugin().configResolved(config), /Unsafe deployment output directory/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside retained');
  assert.throws(() => webBuildIdentityPlugin().configResolved({ ...config, build: { outDir: outside, emptyOutDir: true } }), /current workspace dist/);
  // Also refuse an aliased parent whose dist child is itself a regular folder.
  fs.unlinkSync(dist);write('dist/keep.txt', 'regular folder retained');
  const alias = join(outside, 'root-alias');symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => webBuildIdentityPlugin().configResolved({ ...config, root: alias }), /Unsafe deployment output directory/);
  assert.equal(readFileSync(join(root, 'dist/keep.txt'), 'utf8'), 'regular folder retained');
});

test('linked final tree entries and non-clean output policy refuse publication', t => {
  const { root, publish } = emittedFixture(t);
  symlinkSync(join(root, 'public'), join(root, 'dist/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(publish, /Symlink/);assert(!existsSync(join(root, 'dist/build-manifest.json')));
  assert.throws(() => webBuildIdentityPlugin().configResolved({ mode: 'production', command: 'build', root,
    build: { outDir: 'dist', emptyOutDir: false }, logger: { info() {} } }), /explicitly clean dist/);
});

test('test mode and Vitest identity bypass never bypass build output safety', t => {
  const { root } = qualifiedFixture(t);
  const outside = mkdtempSync(join(realpathSync.native(tmpdir()), 'splatview-web-test-output-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'keep.txt'), 'outside retained');
  const config = { mode: 'test', command: 'build', root,
    build: { outDir: outside, emptyOutDir: true }, logger: { info() {} } };
  assert.throws(() => webBuildIdentityPlugin().configResolved(config), /current workspace dist/);
  assert.throws(() => webBuildIdentityPlugin().configResolved({ ...config,
    build: { outDir: 'dist', emptyOutDir: false } }), /explicitly clean dist/);
  const previous = process.env.VITEST;
  process.env.VITEST = 'true';
  try {
    assert.throws(() => webBuildIdentityPlugin().configResolved({ ...config, mode: 'production' }), /current workspace dist/);
    assert.throws(() => webBuildIdentityPlugin().configResolved({ ...config, mode: 'production',
      build: { outDir: 'dist', emptyOutDir: false } }), /explicitly clean dist/);
    // Test serving has no output deletion and can keep its identity bypass.
    assert.doesNotThrow(() => webBuildIdentityPlugin().configResolved({ ...config, command: 'serve' }));
  } finally {
    if (previous === undefined) delete process.env.VITEST;
    else process.env.VITEST = previous;
  }
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside retained');
});

test('production public copying publishes the qualified assets and never reads extra native compiler intermediates', t => {
  const { root, write, snapshot } = qualifiedFixture(t);
  write('public/wasm/splatview-core.wasm.tmp0', 'unqualified compiler intermediate');
  write('public/wasm/unpublished/extra.js', 'unqualified extra native-directory output');
  // A dangling link provides an unreadable input in the excluded native tree:
  // copying/enumerating that tree indiscriminately would fail or publish it.
  symlinkSync(join(root, 'missing-intermediate'), join(root, 'public/wasm/intermediate-link'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const outDir = join(root, 'dist');
  assert.doesNotThrow(() => copyQualifiedPublic(snapshot, outDir));
  for (const path of ['icons/check.svg', 'wasm/splatview-core.mjs', 'wasm/splatview-core.wasm',
    'wasm/splatview-camera.mjs', 'wasm/splatview-camera.wasm', 'wasm/build-provenance.json']) {
    assert.deepEqual(readFileSync(join(outDir, path)), readFileSync(join(root, 'public', path)));
  }
  for (const path of ['wasm/splatview-core.wasm.tmp0', 'wasm/unpublished', 'wasm/intermediate-link']) {
    assert(!existsSync(join(outDir, path)), path);
  }
  assert(!collectApplicationInputs(root).some(record => record.path.startsWith('public/wasm/')));
});
