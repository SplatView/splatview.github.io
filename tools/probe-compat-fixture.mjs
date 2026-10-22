/** Exercise the real compiled native identity and diagonal Fill contract. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}
if (args.includes('--help')) {
  process.stdout.write('Usage: node tools/probe-compat-fixture.mjs --root STAGE --expected-mask 1,0,0 --out NEW_JSON\n');
  process.exit(0);
}
for (let at = 0; at < args.length; at += 2) {
  assert(['--root', '--expected-mask', '--out'].includes(args[at]) && args[at + 1], 'Invalid probe argument');
}
assert(option('--root') && option('--expected-mask') && option('--out'), 'All probe arguments are required');
const root = resolve(option('--root'));
const expectedMask = option('--expected-mask').split(',').map(Number);
assert(expectedMask.length === 3 && expectedMask.every(value => value === 0 || value === 1), 'Invalid expected mask');
const provenance = JSON.parse(readFileSync(resolve(root, 'public/wasm/build-provenance.json'), 'utf8'));
const contract = JSON.parse(readFileSync(resolve(root, 'native/wasm/runtime-contract.json'), 'utf8'));
const modules = {};
const identityReads = {};
const calls = {};
for (const kind of ['core', 'camera']) {
  const imported = await import(pathToFileURL(resolve(root, `public/wasm/splatview-${kind}.mjs`)).href);
  assert.equal(typeof imported.default, 'function');
  const module = await imported.default(); // Genuine generated Emscripten factory and adjacent WASM.
  modules[kind] = module;
  const names = kind === 'core' ? ['_malloc', '_sv_open', '_sv_command', '_sv_map_write']
    : ['_malloc', '_sv_camera_input_create'];
  calls[kind] = Object.fromEntries(names.map(name => [name, 0]));
  for (const name of names) {
    const original = module[name];
    assert.equal(typeof original, 'function', `Missing ${kind} export ${name}`);
    // Observation only: the genuine exports receive every original argument.
    module[name] = (...values) => { calls[kind][name]++; return original(...values); };
  }
  const getter = module[kind === 'core' ? '_sv_build_identity' : '_sv_camera_build_identity'];
  const abi = module[kind === 'core' ? '_sv_abi_version' : '_sv_camera_abi_version']();
  assert.equal(abi, kind === 'core' ? 6 : 1);
  const pointers = Array.from({ length: 11 }, () => getter());
  assert(pointers[0] > 0 && pointers.every(pointer => pointer === pointers[0]), 'Native identity pointer is not static');
  const values = pointers.map(pointer => JSON.parse(module.UTF8ToString(pointer)));
  const expected = { ...contract[kind], nativeInputId: provenance.nativeInputId };
  for (const value of values) assert.deepEqual(value, expected);
  assert.deepEqual(values[0], provenance.nativeIdentity[kind]);
  assert(Object.values(calls[kind]).every(count => count === 0), 'Identity read allocated scene/input data');
  identityReads[kind] = { abi, readCount: pointers.length, pointer: pointers[0], stablePointer: true,
    beforeDataAllocation: true, observedCalls: { ...calls[kind] }, identity: values[0] };
}

const core = modules.core;
function checked(pointer) {
  const summary = JSON.parse(core.UTF8ToString(pointer));
  assert.equal(summary.ok, true, summary.error ?? 'Native command failed');
  return summary;
}
function bytesCall(bytes, call) {
  const pointer = core._malloc(Math.max(4, bytes.byteLength));
  assert(pointer, 'Native allocation failed');
  try { core.HEAPU8.set(bytes, pointer); return checked(call(pointer)); }
  finally { core._free(pointer); }
}
function command(value) {
  return bytesCall(new TextEncoder().encode(JSON.stringify(value) + '\0'), pointer => core._sv_command(pointer));
}
const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity',
  'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
const row = [0, 0, 0, 0, 0, 0, 1.38629436, -2.12026354, -2.30258509, -2.52572864, 1, 0, 0, 0].join(' ');
const ply = new TextEncoder().encode(['ply', 'format ascii 1.0', 'element vertex 3',
  ...properties.map(name => `property float ${name}`), 'end_header', row, row, row, ''].join('\n'));
const opened = bytesCall(ply, pointer => core._sv_open(pointer, ply.byteLength, 0, 1000, 128 * 1024 * 1024));
assert.equal(opened.count, 3);
const width = 7, height = 5, pixels = width * height;
const islands = [[1, 1], [2, 2], [5, 1]];
// Same independent projection/storage fixture as tests/core.test.ts. No flood
// implementation or result mask is substituted for the real native command.
islands.forEach(([x, y], index) => {
  new Float32Array(core.HEAPU8.buffer, core._sv_scene_ptr() + index * 144, 12).set([
    ((x + .5) * 2 / width - 1) * 3 * width / height,
    (1 - (y + .5) * 2 / height) * 3, 0, .8, 1e-8, 0, 0, 1e-8, 0, 1e-8, 0, 0,
  ]);
});
assert.deepEqual(Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3)), [0, 0, 0]);
const header = { layoutVersion: 1, mapId: 1, fullWidth: width, fullHeight: height,
  mapWidth: width, mapHeight: height, sourceCount: 3, channels: 3 };
const payload = new Uint8Array(8 * pixels), view = new DataView(payload.buffer);
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const at = y * width + x;
  view.setFloat32(4 * at, 3, true);
  view.setFloat32(4 * (pixels + at), islands.some(([ix, iy]) => x === ix && y === iy) ? .5 : 0, true);
}
command({ command: 'selectionMapBegin', ...header });
bytesCall(payload, pointer => core._sv_map_write(header.mapId, 0, pointer, payload.byteLength));
command({ command: 'selectionMapCommit', mapId: header.mapId });
const camera = [0, 0, 0, 0, 0, 3, 1, 90, 1, 0, 1];
const picked = command({ command: 'fillPick', sessionId: 1, mapId: header.mapId, camera,
  width, height, seed: [1, 1], operation: 0, tolerance: 1, overlap: false, visibleOnly: false });
const fillMask = Array.from(core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + 3));
assert.deepEqual(fillMask, expectedMask, 'Real native Fill does not have the reviewed fixture semantics');
const result = { schemaVersion: 1, kind: 'real-native-diagonal-fill-probe',
  nodeVersion: process.version, identityReads, coreIdentity: identityReads.core.identity,
  cameraIdentity: identityReads.camera.identity, fillMask, calls,
  fixture: { header, camera, islands, seed: [1, 1], depth: 3, islandOpacity: .5,
    covariance: [1e-8, 1e-8, 1e-8], tolerance: 1, operation: 0, overlap: false, visibleOnly: false },
  opened, picked };
writeFileSync(resolve(option('--out')), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(`Verified genuine native diagonal Fill: [${fillMask}]\n`);
