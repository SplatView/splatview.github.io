import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { collectApplicationInputs, createDeploymentManifest, descriptorFromInputs, sha256 } from '../web-build.mjs';
import { verifyDistribution } from '../verify-distribution.mjs';

function fixture(t) {
  const root = mkdtempSync(resolve(realpathSync.native(tmpdir()), 'splatview-promotion-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = resolve(root, 'source'), dist = resolve(root, 'dist');
  const write = (base, name, bytes) => { const path = resolve(base, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
  for (const name of ['index.html', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
    'tools/web-build.mjs', 'tools/web-build.d.mts', 'src/main.tsx']) write(source, name, name);
  write(source, 'package.json', JSON.stringify({ version: '0.2.2' }));
  write(source, 'tools/public-assets.json', JSON.stringify({ schemaVersion: 1, files: [] }));
  mkdirSync(resolve(source, 'public'));
  const contract = { schemaVersion: 1, protocolVersion: 1, uiWorkerContract: 1,
    core: { schemaVersion: 1, kind: 'core', abi: 1, variant: 'scalar', mapLayoutVersion: 1, capabilities: { selection: 1 } },
    camera: { schemaVersion: 1, kind: 'camera', abi: 1, variant: 'scalar', capabilities: { camera: 1 } } };
  const nativeInputId = sha256('fixture inputs');
  const provenance = { schemaVersion: 1, nativeInputId, nativeIdentity: {
    core: { ...contract.core, nativeInputId }, camera: { ...contract.camera, nativeInputId } } };
  write(source, 'native/wasm/runtime-contract.json', JSON.stringify(contract));
  const names = ['index.html', 'assets/index-A.js', 'assets/document.worker-A.js', 'wasm/splatview-core.mjs',
    'wasm/splatview-core.wasm', 'wasm/splatview-camera.mjs', 'wasm/splatview-camera.wasm', 'wasm/build-provenance.json'];
  for (const name of names) write(dist, name, name === 'wasm/build-provenance.json' ? JSON.stringify(provenance) : name);
  const build = descriptorFromInputs(collectApplicationInputs(source), contract, provenance);
  const records = names.map(path => { const data = readFileSync(resolve(dist, path)); return { path, bytes: data.length, sha256: sha256(data) }; });
  write(dist, 'build-manifest.json', JSON.stringify(createDeploymentManifest(build, records, names[1], names[2])));
  return { source, dist, write };
}

test('release verification derives the app identity from source and checks every emitted byte', t => {
  const { source, dist, write } = fixture(t);
  assert.equal(verifyDistribution(source, dist, '0.2.2').files.length, 9);
  assert.throws(() => verifyDistribution(source, dist, '0.2.3'), /version differs/);
  write(source, 'src/main.tsx', 'changed source');
  assert.throws(() => verifyDistribution(source, dist, '0.2.2'), /source inputs/);
});

test('tampered output, extra files and unowned maps are refused', t => {
  const { source, dist, write } = fixture(t);
  write(dist, 'assets/index-A.js', 'tampered');
  assert.throws(() => verifyDistribution(source, dist, '0.2.2'), /Size|Checksum/);
  write(dist, 'assets/index-A.js', 'assets/index-A.js');
  write(dist, 'extra.txt', 'unqualified');
  assert.throws(() => verifyDistribution(source, dist, '0.2.2'), /Unreviewed/);
  rmSync(resolve(dist, 'extra.txt'));
  write(dist, 'extra.js.map', '{}');
  assert.throws(() => verifyDistribution(source, dist, '0.2.2'), /Unowned/);
});
