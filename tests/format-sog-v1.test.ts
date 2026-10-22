import { admittedNativeCommand } from './fixtures/native-export';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ResourceLedger } from '../src/document/resources';
import type { NativeSummary } from '../src/document/types';
import { prepareCanonicalSource, type SourceResourceDigest } from '../src/io/fingerprint';
import { parseSogMetadata } from '../src/io/sogMetadata';
import { prepareSogCatalog } from '../src/io/sogResources';
import { prepareSogDecoderMetadata } from '../src/io/sogDecoderMetadata';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';
import manifest from './fixtures/sog-group-v1/manifest.json';
import oracle from './fixtures/sog-group-v1/expected-records.json';
import vectors from './fixtures/sog-group-v1/source-key-vectors.json';

// Independent Decimal80/literal-pixel records were fixed before native execution.
// No production decoder, exporter, sampler or covariance helper creates them.
const root = resolve('tests/fixtures/sog-group-v1');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(root, name)));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const measurements = new Map<string, number>();
function close(actual: number, expected: number, bound: number, label: string) {
  expect(Number.isFinite(actual), label).toBe(true);
  const error = Math.abs(actual - expected);
  measurements.set(label.split('/')[0], Math.max(measurements.get(label.split('/')[0]) ?? 0, error / bound));
  expect(error, `${label}: ${actual} vs ${expected}, fixed bound ${bound}`).toBeLessThanOrEqual(bound);
}
let core: WasmModule;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
function open(bytes: Uint8Array, maxSplats = 100, budgetBytes = 128 * 1024 * 1024) {
  const pointer = core._malloc(Math.max(1, bytes.length));
  expect(pointer).not.toBe(0);
  try { core.HEAPU8.set(bytes, pointer); return decode(core._sv_open(pointer, bytes.length, 0, maxSplats, budgetBytes)); }
  finally { core._free(pointer); }
}
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
function records(count: number) {
  const pointer = core._sv_scene_ptr(), view = new DataView(core.HEAPU8.buffer);
  return Array.from({ length: count }, (_, row) => ({
    fields: Array.from({ length: 12 }, (_, i) => view.getFloat32(pointer + 144 * row + 4 * i, true)),
    half: Array.from({ length: 48 }, (_, i) => view.getUint16(pointer + 144 * row + 48 + 2 * i, true)),
  }));
}
const sceneBytes = (count: number) => core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + 144 * count);
const states = (count: number) => core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + count);
function halfBits(value: number) {
  // Expected DC values are already exactly binary16, supplied by Python struct.
  // Convert the finite half grid by enumeration; no native conversion is used.
  for (let bits = 0; bits < 0x10000; bits++) {
    const exponent = bits >>> 10 & 31, fraction = bits & 1023;
    if (exponent === 31) continue;
    const decoded = (bits & 0x8000 ? -1 : 1) * (exponent === 0 ? 2 ** -14 * fraction / 1024 : 2 ** (exponent - 15) * (1 + fraction / 1024));
    if (Object.is(decoded, value)) return bits;
  }
  throw new Error('Expected oracle DC is not an exact finite binary16 value.');
}
function checkRecords(ids: readonly number[]) {
  const actual = records(ids.length), policy = oracle.numericPolicy;
  ids.forEach((id, index) => {
    const expected = oracle.records[id], row = actual[index];
    expected.positionRub.forEach((value, axis) => close(row.fields[axis], value, policy.positionsAbsolute, `position/${id}/${axis}`));
    close(row.fields[3], expected.opacity, policy.opacityAbsolute, `opacity/${id}`);
    const scale = Math.max(...expected.linearScales.map(value => value * value));
    expected.covarianceRub.forEach((value, i) => close(row.fields[4 + i], value,
      policy.covarianceRelativeToMaxAxisVariance * scale, `covariance/${id}/${i}`));
    expect(row.fields.slice(10)).toEqual([0, 0]);
    expect(row.half.slice(0, 3), `exact DC half/source${id}`).toEqual(expected.packedDcHalf.map(halfBits));
    expect(row.half.slice(3), `exact absent-band bits/source${id}`).toEqual(expected.absentShHalfBits);
  });
}
function output(format: number, scope: number) {
  const result = command({ command: 'export', format, scope }); expect(result.ok, result.error).toBe(true);
  return core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
}
function exportedPositions(format: number, scope: number) {
  const bytes = output(format, scope), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 2) {
    expect(bytes.length % 32).toBe(0);
    return Array.from({ length: bytes.length / 32 }, (_, row) => [0, 1, 2].map(axis => view.getFloat32(row * 32 + axis * 4, true)));
  }
  // Independent narrow binary-PLY parser. No reopen through the native decoder.
  const marker = Buffer.from('end_header\n'), end = Buffer.from(bytes).indexOf(marker) + marker.length;
  expect(end).toBeGreaterThan(marker.length);
  const header = new TextDecoder().decode(bytes.subarray(0, end));
  expect(header).toContain('format binary_little_endian 1.0\n');
  const properties = [...header.matchAll(/^property (\w+) (\w+)$/gm)];
  expect(properties.every(property => property[1] === 'float')).toBe(true);
  const count = Number(/^element vertex (\d+)$/m.exec(header)?.[1]);
  expect(bytes.length - end).toBe(count * properties.length * 4);
  const indices = ['x', 'y', 'z'].map(name => properties.findIndex(property => property[2] === name));
  expect(indices.every(index => index >= 0)).toBe(true);
  return Array.from({ length: count }, (_, row) => indices.map(index => view.getFloat32(end + 4 * (row * properties.length + index), true)));
}
function checkMembership(ids: readonly number[], scope: number) {
  for (const format of [0, 2]) {
    if (ids.length === 0) {
      const result = command({ command: 'export', format, scope });
      expect(result.ok).toBe(false);
      expect(result.error).toBe('There are no visible Gaussians to save. Undo or restore first.');
      continue;
    }
    const positions = exportedPositions(format, scope); expect(positions).toHaveLength(ids.length);
    ids.forEach((id, index) => oracle.records[id].positionRdf.forEach((value, axis) =>
      close(positions[index][axis], value, oracle.numericPolicy.positionsAbsolute, `export-position/${id}/${axis}`)));
  }
}
beforeAll(async () => {
  const url = pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href;
  const factory = (await import(/* @vite-ignore */ url) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) {
    if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact request.');
    return resolve('public/wasm/splatview-core.wasm');
  } });
});
afterAll(() => process.stdout.write('SOG v1 fixed-policy normalized error maxima: ' + JSON.stringify(Object.fromEntries(measurements)) + '\n'));

describe('independent default-v1 SH0 SOG packet', () => {
  it('binds original inputs, negative archives, independent oracle and frozen source references', () => {
    expect(sha(fixture('manifest.json'))).toBe('f6de5637792d07e7ec1a562a7df7af034f15a4f21672e69f9c06ffb35c2d0505');
    for (const row of [...manifest.inputs, ...manifest.artifacts]) {
      const bytes = fixture(row.file); expect(bytes.length, row.file).toBe(row.bytes); expect(sha(bytes), row.file).toBe(row.sha256);
    }
    for (const row of manifest.nativeReferences) expect(sha(new Uint8Array(readFileSync(resolve(row.path))))).toBe(row.sha256);
    expect(sha(fixture('generator.cpp'))).toBe(manifest.encoder.sourceSha256);
    expect(sha(new Uint8Array(readFileSync('tools/generate-sog-fixtures.py')))).toBe(manifest.constructionSourceSha256);
    expect(manifest).toMatchObject({ sourceCount: 3, shDegree: 0, decodedTextureCalls: 5, uniqueDecodedTextures: 4, uniqueResourceCountIncludingMetadata: 6 });
  });
  it('prepares the real original group, includes extras, deduplicates aliases and excludes neighbor bodies', () => {
    const ledger = new ResourceLedger(32 * 1024 * 1024), options = { admit: (bytes: number) => ledger.reserve('source', bytes), current() {} };
    const original = fixture('collection/asset/meta.json'), metadata = parseSogMetadata(original, options);
    const catalog = prepareSogCatalog(manifest.inputs.map((row, i) => ({ resourceId: `resource-${i}`, acquisitionPath: row.file, byteLength: row.bytes })), options);
    const owner = prepareSogDecoderMetadata(metadata, 'collection/asset/meta.json', catalog, options);
    try {
      const originals: Uint8Array[] = [], decoder: Uint8Array[] = [];
      owner.writeOriginal(bytes => { originals.push(bytes); }, 7); owner.writeDecoder(bytes => { decoder.push(bytes); }, 7);
      expect(new Uint8Array(Buffer.concat(originals))).toEqual(original);
      const names = [['appearance.webp', 'r0000.webp'], ['declared-extra.bin', 'r0001.webp'],
        ['positions-high.webp', 'r0002.webp'], ['positions-low.webp', 'r0003.webp'], ['rotations.webp', 'r0004.webp']];
      const expected = names.reduce((text, [from, to]) => text.replaceAll('"' + from + '"', '"' + to + '"'), new TextDecoder().decode(original));
      expect(new TextDecoder().decode(Buffer.concat(decoder))).toBe(expected);
      expect(owner.bindings.filter(binding => binding.decoderName === 'r0000.webp').map(binding => binding.group)).toEqual(['scales', 'sh0']);
      const bodyReads: string[] = [];
      const resources: SourceResourceDigest[] = owner.resources.map(row => {
        bodyReads.push(row.acquisitionPath); const bytes = fixture(row.acquisitionPath);
        return { path: row.fingerprintPath, role: row.role, byteLength: bytes.length, sha256: new Uint8Array(createHash('sha256').update(bytes).digest()) };
      });
      expect(bodyReads).toHaveLength(6); expect(bodyReads).not.toContain('collection/unrelated-neighbor.bin');
      expect(bodyReads).toContain('collection/asset/declared-extra.bin');
      const segments: Uint8Array[] = []; prepareCanonicalSource({ kind: 'group', resources }).write(bytes => { segments.push(bytes); }, 3);
      const canonical = Buffer.concat(segments); expect(canonical.toString('hex')).toBe(vectors.vectors[0].canonicalHex);
      expect(sha(canonical)).toBe(manifest.completeAssetDigest);
    } finally { owner.dispose(); metadata.dispose(); catalog.dispose(); }
    expect(ledger.usage.bytes).toBe(0); expect(ledger.usage.allocations).toBe(0);
  });
  for (const vector of [...vectors.vectors, vectors.bundledSingleFileVector]) it(`matches independent canonical vector ${vector.name}`, () => {
    const segments: Uint8Array[] = [];
    const prepared = prepareCanonicalSource({ kind: vector.kind as 'single' | 'group', resources: vector.resources.map(row => ({
      path: row.path, role: row.role as 'primary' | 'referenced', byteLength: row.byteLength, sha256: new Uint8Array(Buffer.from(row.sha256, 'hex')),
    })) });
    prepared.write(bytes => { segments.push(bytes); }, 11);
    const encoded = Buffer.concat(segments); expect(encoded.toString('hex')).toBe(vector.canonicalHex); expect(sha(encoded)).toBe(vector.assetDigest);
    expect(prepared.resourceCount).toBe(vector.resourceCount); expect(prepared.totalBytes).toBe(vector.totalBytes);
  });
  for (const [limit, ids] of [[100, [0, 1, 2]], [2, [1, 2]], [1, [2]]] as const) it(`decodes bundled v1 at cap${limit} with exact source IDs and independent attributes`, () => {
    const result = open(fixture('bundled-v1-sh0.sog'), limit); expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({ loaded: true, kind: 0, format: 'SOG v1', sourceCount: 3, count: ids.length, shDegree: 0, yUp: true });
    checkRecords(ids); checkMembership(ids, 0);
  });
  it('exports exact All/Selected/Remainder membership and Undo restores the deleted source', () => {
    expect(open(fixture('bundled-v1-sh0.sog')).ok).toBe(true); checkMembership([0, 1, 2], 0);
    expect(command({ command: 'single', index: 1 }).selected).toBe(1); checkMembership([1], 1); checkMembership([0, 2], 2);
    expect(command({ command: 'delete' }).visible).toBe(2); checkMembership([0, 2], 0); checkMembership([], 1); checkMembership([0, 2], 2);
    expect(command({ command: 'undo' }).visible).toBe(3); checkMembership([0, 1, 2], 0); checkRecords([0, 1, 2]);
  });
  for (const [name, budget] of [...manifest.negativeBundles.map(row => [row.file, 128 * 1024 * 1024] as const), ['bundled-v1-sh0.sog', 64] as const])
    it(`${name} at budget${budget} refuses while preserving exact old bytes, selection and executable Redo`, () => {
      expect(open(fixture('bundled-v1-sh0.sog')).ok).toBe(true);
      expect(command({ command: 'single', index: 1 }).selected).toBe(1);
      expect(command({ command: 'delete' }).visible).toBe(2); expect(command({ command: 'undo' }).canRedo).toBe(true);
      const bytes = sceneBytes(3), masks = states(3), all = output(0, 0), selected = output(2, 1);
      // The last diagnostic export retains an admitted native output owner.
      const before = command({ command: 'summary' });
      const refused = open(fixture(name), 100, budget); expect(refused.ok).toBe(false); expect(refused.error).toBeTruthy();
      const after = command({ command: 'summary' });
      for (const field of ['count', 'sourceCount', 'format', 'shDegree', 'selected', 'visible', 'revision', 'contentRevision', 'canUndo', 'canRedo', 'memoryBytes'] as const)
        expect(after[field], field).toEqual(before[field]);
      expect(sceneBytes(3)).toEqual(bytes); expect(states(3)).toEqual(masks); expect(output(0, 0)).toEqual(all); expect(output(2, 1)).toEqual(selected);
      expect(command({ command: 'redo' }).visible).toBe(2); checkMembership([0, 2], 0);
      expect(Array.from(states(3), value => (value & 2) !== 0)).toEqual([false, true, false]);
      expect(command({ command: 'undo' }).canRedo).toBe(true); expect(sceneBytes(3)).toEqual(bytes); expect(states(3)).toEqual(masks); checkMembership([0, 1, 2], 0);
    });
});
