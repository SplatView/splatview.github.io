import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { admittedNativeCommand } from './fixtures/native-export';
import type { NativeSummary } from '../src/document/types';
import { wasmString, type ModuleFactory, type WasmModule } from '../src/workers/wasm';

// Independent binary/analytic oracle: no constructor, production parser,
// sampler, quaternion, covariance or half-conversion implementation is imported.
// Reviewed frozen model.cpp:119-296, format_utils.hpp:27-61 and scene_math.cpp.
const POLICY_ID = 'compressed-ply-numeric-v1';
const POLICY = Object.freeze({ positionsAbsolute: 6e-5, opacityAbsolute: 1e-7,
  covarianceRelativeToMaxAxisVariance: 8e-6, dcBeforeHalfAbsolute: 2e-6,
  exportCovarianceRelativeToMaxAxisVariance: 3e-5, exportOpacityAbsolute: 3e-7 });
// Bounds are fixed BEFORE native execution: |position bounds|<=120 and at most
// eight f32 rounding contributions give 8*2^-24*120<6e-5. Log scales lie in
// [-3,.25]; 8e-6*largest variance covers f32 ratio/lerp/exp, well-conditioned
// smallest-three reconstruction, normalization and matrix products/additions.
// Export decomposition/log/exp receives its separate 3e-5 variance bound.
// DC allows 2e-6 BEFORE binary16 rounding; every admissible half is derived from
// that fixed interval, never from a native observation. Other SH bins are exact
// dyadic half values; source/RUB signed-zero inactive terms are checked as bits.
const C0 = .28209479177387814;
const PARITY = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];
const REST = [0, 9, 24, 45];
const FULL_IDS = Array.from({ length: 257 }, (_, id) => id);
const SAMPLES = [{ cap: 1000, ids: FULL_IDS }, { cap: 3, ids: [85, 171, 256] },
  { cap: 2, ids: [128, 256] }, { cap: 1, ids: [256] }];
const CASES = [12, 18].flatMap(layout => ['le', 'be'].flatMap(endian => [0, 1, 2, 3].map(degree =>
  ({ layout, endian, degree, file: `layout${layout}-${endian}-sh${degree}.ply` }))));
const NATIVE_BRANCHES = ['model.cpp', 'format_utils.hpp', 'scene_math.cpp', 'ply_preview.cpp']
  .map(name => 'native/upstream/splatview/src/core/' + name);
const BOUND_NAMES = ['min_x', 'min_y', 'min_z', 'max_x', 'max_y', 'max_z',
  'min_scale_x', 'min_scale_y', 'min_scale_z', 'max_scale_x', 'max_scale_y', 'max_scale_z',
  'min_r', 'min_g', 'min_b', 'max_r', 'max_g', 'max_b'];
const BOUNDS = [[100, -30, 8, 108, -14, 12, -3, -2, -1.5, -1.5, -.75, -.25, .125, .25, .375, .875, .75, .625],
  [-120, 40, -16, -112, 72, -8, -2.75, -1.75, -1.25, -1.25, -.5, .25, .25, .125, .0625, .75, .875, .9375]];
const root = resolve('tests/fixtures/formats/compressed-ply-v1');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(root, name)));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Property = { type: string; name: string; offset: number; size: number };
type Element = { name: string; count: number; stride: number; offset: number; properties: Property[] };
type Input = { bytes: Uint8Array; end: number; text: string; little: boolean; elements: Map<string, Element> };
function split(bytes: Uint8Array) {
  const marker = Buffer.from('end_header\n'), at = Buffer.from(bytes).indexOf(marker);
  if (at < 0) throw new Error('Independent PLY header terminator is missing.');
  return { end: at + marker.length, text: new TextDecoder().decode(bytes.subarray(0, at + marker.length)) };
}
function parseInput(bytes: Uint8Array): Input {
  const { end, text } = split(bytes), elements = new Map<string, Element>();
  const little = text.includes('format binary_little_endian 1.0\n');
  expect(little || text.includes('format binary_big_endian 1.0\n')).toBe(true);
  let current: Element | undefined;
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === 'element') {
      current = { name: fields[1], count: Number(fields[2]), stride: 0, offset: 0, properties: [] };
      if (elements.has(current.name)) throw new Error('Duplicate independent input element.');
      elements.set(current.name, current);
    } else if (fields[0] === 'property') {
      if (!current) throw new Error('Orphan independent input property.');
      const size = ({ float: 4, float32: 4, uint: 4, uint32: 4, uchar: 1, uint8: 1 } as Record<string, number>)[fields[1]];
      if (!size) throw new Error('Unexpected independent scalar type.');
      current.properties.push({ type: fields[1], name: fields[2], offset: current.stride, size }); current.stride += size;
    }
  }
  let offset = end;
  for (const table of elements.values()) { table.offset = offset; offset += table.count * table.stride; }
  expect(offset).toBe(bytes.length);
  return { bytes, end, text, little, elements };
}
function field(input: Input, element: string, row: number, name: string) {
  const table = input.elements.get(element)!;
  const property = table.properties.find(value => value.name === name);
  if (!property || row >= table.count) throw new Error('Independent input field is unavailable.');
  return { property, offset: table.offset + row * table.stride + property.offset };
}
function scalar(input: Input, element: string, row: number, name: string) {
  const { property, offset } = field(input, element, row, name);
  const view = new DataView(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  return property.size === 1 ? view.getUint8(offset) : property.type.startsWith('float')
    ? view.getFloat32(offset, input.little) : view.getUint32(offset, input.little);
}
// Division/remainders, rather than the constructor's shifting/packing routines.
const triplet = (word: number) => [Math.floor(word / 2 ** 21), Math.floor(word / 2 ** 11) % 1024, word % 2048];
function covariance(scales: number[], quaternion: number[], rub: boolean) {
  const length = Math.hypot(...quaternion), [w, x, y, z] = quaternion.map(value => value / length);
  const rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  const signs = rub ? [1, -1, -1] : [1, 1, 1];
  return [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]].map(([i, j]) =>
    signs[i] * signs[j] * scales.reduce((sum, value, k) => sum + value * value * rotation[i][k] * rotation[j][k], 0));
}
function analytic(input: Input, id: number, degree: number) {
  const bound = (name: string, fallback: number) => input.elements.get('chunk')!.properties.some(p => p.name === name)
    ? scalar(input, 'chunk', id < 256 ? 0 : 1, name) : fallback;
  const positionCodes = triplet(scalar(input, 'vertex', id, 'packed_position'));
  const scaleCodes = triplet(scalar(input, 'vertex', id, 'packed_scale'));
  const axes = ['x', 'y', 'z'], denominators = [2047, 1023, 2047];
  const interpolate = (low: number, high: number, code: number, denominator: number) =>
    (low * (denominator - code) + high * code) / denominator;
  const position = axes.map((axis, i) => interpolate(bound('min_' + axis, 0), bound('max_' + axis, 0), positionCodes[i], denominators[i]));
  const scales = axes.map((axis, i) => Math.exp(interpolate(bound('min_scale_' + axis, 0), bound('max_scale_' + axis, 0), scaleCodes[i], denominators[i])));
  const rotation = scalar(input, 'vertex', id, 'packed_rotation'), missing = Math.floor(rotation / 2 ** 30);
  const codes = [Math.floor(rotation / 2 ** 20) % 1024, Math.floor(rotation / 2 ** 10) % 1024, rotation % 1024];
  const quaternion = [0, 0, 0, 0]; let next = 0;
  for (let lane = 0; lane < 4; lane++) if (lane !== missing) quaternion[lane] = (codes[next++] - 511.5) * Math.SQRT2 / 1023;
  quaternion[missing] = Math.sqrt(Math.max(0, 1 - quaternion.reduce((sum, value) => sum + value * value, 0)));
  const color = scalar(input, 'vertex', id, 'packed_color');
  const rgba = [24, 16, 8, 0].map(bits => Math.floor(color / 2 ** bits) % 256);
  const dc = ['r', 'g', 'b'].map((channel, i) => (interpolate(bound('min_' + channel, 0), bound('max_' + channel, 1), rgba[i], 255) - .5) / C0);
  const perChannel = REST[degree] / 3;
  const sh = Array.from({ length: 48 }, (_, index) => {
    const term = Math.floor(index / 3) - 1, channel = index % 3;
    if (term < 0) return dc[channel];
    const code = term < perChannel ? scalar(input, 'sh', id, `f_rest_${channel * perChannel + term}`) : null;
    const value = code === null ? 0 : code === 0 ? -4 : code === 255 ? 4 : (2 * code + 1 - 256) / 64;
    return value * PARITY[term];
  });
  return { position, scales, quaternion, missing, rgba, dc, sh, opacity: rgba[3] / 255,
    variance: Math.max(...scales.map(value => value * value)), covRub: covariance(scales, quaternion, true), covRdf: covariance(scales, quaternion, false) };
}
function halfValue(bits: number) {
  const sign = bits & 0x8000 ? -1 : 1, exponent = Math.floor(bits / 1024) % 32, fraction = bits % 1024;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (exponent === 0 ? fraction * 2 ** -24 : 2 ** (exponent - 15) * (1 + fraction / 1024));
}
function halfBits(value: number) {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, magnitude = Math.abs(value);
  if (magnitude === 0) return sign;
  let low = 0, high = 0x7bff;
  while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if (halfValue(mid) <= magnitude) low = mid; else high = mid; }
  const a = magnitude - halfValue(low), b = halfValue(high) - magnitude;
  return sign | (a < b ? low : b < a ? high : low % 2 === 0 ? low : high);
}
type Measurement = { maxAbsolute: number; maxNormalized: number; worst: string };
const measurements: Record<string, Measurement> = {};
function close(actual: number, expected: number, bound: number, fieldName: string, label: string) {
  expect(Number.isFinite(actual), label).toBe(true);
  const error = Math.abs(actual - expected), normalized = bound ? error / bound : error;
  const row = measurements[fieldName] ??= { maxAbsolute: 0, maxNormalized: 0, worst: '' };
  row.maxAbsolute = Math.max(row.maxAbsolute, error);
  if (!row.worst || normalized > row.maxNormalized) { row.maxNormalized = normalized; row.worst = label; }
  expect(error, `${label}: ${actual} vs ${expected}; fixed bound ${bound}`).toBeLessThanOrEqual(bound);
}
let core: WasmModule, coreAbi: number | null = null, nativeIdentity: { abi?: number; capabilities?: { selectionMorphology?: number } } | undefined;
let decoderCases = 0, scopeCases = 0, refusalCases = 0, acceptedEdgeCases = 0;
const decode = (pointer: number) => JSON.parse(core.UTF8ToString(pointer)) as NativeSummary;
function open(bytes: Uint8Array, cap = 1000) {
  const pointer = core._malloc(Math.max(1, bytes.length)); expect(pointer).not.toBe(0);
  try { core.HEAPU8.set(bytes, pointer); return decode(core._sv_open(pointer, bytes.length, 0, cap, 128 * 1024 * 1024)); }
  finally { core._free(pointer); }
}
const command = (value: unknown) => wasmString(core, JSON.stringify(admittedNativeCommand(core, value)), pointer => decode(core._sv_command(pointer)));
const sceneBytes = (count: number) => core.HEAPU8.slice(core._sv_scene_ptr(), core._sv_scene_ptr() + count * 144);
const masks = (count: number) => core.HEAPU8.slice(core._sv_states_ptr(), core._sv_states_ptr() + count);
const outputBytes = () => core.HEAPU8.slice(core._sv_output_ptr(), core._sv_output_ptr() + core._sv_output_len());
function exported(scope: number) {
  const result = command({ command: 'export', format: 0, scope }); expect(result.ok, result.error).toBe(true);
  return outputBytes();
}
function exportRecords(bytes: Uint8Array) {
  const h = split(bytes), properties = [...h.text.matchAll(/^property (\w+) (\w+)$/gm)];
  expect(h.text).toContain('format binary_little_endian 1.0\n'); expect(properties.every(row => row[1] === 'float')).toBe(true);
  const count = Number(/^element vertex (\d+)$/m.exec(h.text)?.[1]);
  expect(bytes.length - h.end).toBe(count * properties.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: count }, (_, row) => Object.fromEntries(properties.map((property, column) =>
    [property[2], view.getFloat32(h.end + 4 * (row * properties.length + column), true)])) as Record<string, number>);
}
function checkDecoded(input: Input, ids: number[], degree: number, label: string) {
  const native = new DataView(sceneBytes(ids.length).buffer);
  ids.forEach((id, row) => {
    const expected = analytic(input, id, degree), rub = [expected.position[0], -expected.position[1], -expected.position[2]];
    rub.forEach((value, axis) => close(native.getFloat32(row * 144 + axis * 4, true), value, POLICY.positionsAbsolute, 'positions', `${label}/${id}/${axis}`));
    close(native.getFloat32(row * 144 + 12, true), expected.opacity, POLICY.opacityAbsolute, 'opacity', `${label}/${id}/opacity`);
    if (expected.rgba[3] === 0 || expected.rgba[3] === 255)
      expect(native.getUint32(row * 144 + 12, true), `${label}/${id}/exact alpha endpoint`).toBe(expected.rgba[3] === 0 ? 0 : 0x3f800000);
    expected.covRub.forEach((value, component) => close(native.getFloat32(row * 144 + 16 + component * 4, true), value,
      POLICY.covarianceRelativeToMaxAxisVariance * expected.variance, 'covariance', `${label}/${id}/cov${component}`));
    expect([native.getUint32(row * 144 + 40, true), native.getUint32(row * 144 + 44, true)]).toEqual([0, 0]);
    expected.sh.forEach((value, component) => {
      const bits = native.getUint16(row * 144 + 48 + component * 2, true);
      if (component < 3) {
        const lo = halfBits(value - POLICY.dcBeforeHalfAbsolute), hi = halfBits(value + POLICY.dcBeforeHalfAbsolute);
        expect(bits, `${label}/${id}/dc${component} independent half interval`).toBeGreaterThanOrEqual(Math.min(lo, hi));
        expect(bits, `${label}/${id}/dc${component} independent half interval`).toBeLessThanOrEqual(Math.max(lo, hi));
        const ulp = 2 ** (Math.floor(Math.log2(Math.abs(value))) - 10);
        close(halfValue(bits), value, ulp / 2 + POLICY.dcBeforeHalfAbsolute, 'dcHalf', `${label}/${id}/dc${component}`);
      } else {
        expect(bits, `${label}/${id}/SH${component} exact channel/band/parity bits`).toBe(halfBits(value));
        close(halfValue(bits), value, 0, 'exactSh', `${label}/${id}/SH${component}`);
      }
    });
  });
  // Independently specified GPU stream: first ten float words, then the active
  // interleaved half words rounded to a complete uint32, with no cov padding.
  const stride = 40 + 4 * Math.ceil(3 * (degree + 1) ** 2 / 2), pointer = core._sv_pack(0, ids.length);
  expect(pointer).not.toBe(0); expect(core._sv_pack_len()).toBe(ids.length * stride);
  const streamed = core.HEAPU8.slice(pointer, pointer + ids.length * stride), nativeBytes = new Uint8Array(native.buffer);
  ids.forEach((_id, row) => {
    expect(streamed.slice(row * stride, row * stride + 40)).toEqual(nativeBytes.slice(row * 144, row * 144 + 40));
    expect(streamed.slice(row * stride + 40, (row + 1) * stride)).toEqual(nativeBytes.slice(row * 144 + 48, row * 144 + 48 + stride - 40));
  });
}
function checkExport(input: Input, ids: number[], degree: number, scope: number, label: string, translationX = 0) {
  const records = exportRecords(exported(scope)); expect(records).toHaveLength(ids.length);
  ids.forEach((id, row) => {
    const expected = analytic(input, id, degree), actual = records[row];
    ['x', 'y', 'z'].forEach((axis, index) => close(actual[axis], expected.position[index] + (index === 0 ? translationX : 0), POLICY.positionsAbsolute, 'exportPositions', `${label}/${id}/${axis}`));
    const cov = covariance([actual.scale_0, actual.scale_1, actual.scale_2].map(Math.exp), [actual.rot_0, actual.rot_1, actual.rot_2, actual.rot_3], false);
    cov.forEach((value, component) => close(value, expected.covRdf[component], POLICY.exportCovarianceRelativeToMaxAxisVariance * expected.variance,
      'exportCovariance', `${label}/${id}/cov${component}`));
    close(1 / (1 + Math.exp(-actual.opacity)), Math.min(1 - 1e-7, Math.max(1e-7, expected.opacity)), POLICY.exportOpacityAbsolute,
      'exportOpacity', `${label}/${id}/opacity`);
    expect([actual.nx, actual.ny, actual.nz]).toEqual([0, 0, 0]);
    const perChannel = REST[degree] / 3;
    expect(Object.keys(actual).filter(name => name.startsWith('f_rest_'))).toHaveLength(REST[degree]);
    for (let channel = 0; channel < 3; channel++) {
      const dc = expected.dc[channel], lo = halfBits(dc - POLICY.dcBeforeHalfAbsolute), hi = halfBits(dc + POLICY.dcBeforeHalfAbsolute);
      expect(halfBits(actual[`f_dc_${channel}`])).toBeGreaterThanOrEqual(Math.min(lo, hi));
      expect(halfBits(actual[`f_dc_${channel}`])).toBeLessThanOrEqual(Math.max(lo, hi));
      expect(actual[`f_dc_${channel}`]).toBe(halfValue(halfBits(actual[`f_dc_${channel}`])));
      for (let term = 0; term < perChannel; term++) expect(actual[`f_rest_${channel * perChannel + term}`])
        .toBe(expected.sh[(term + 1) * 3 + channel] * PARITY[term]);
    }
  });
}
beforeAll(async () => {
  const factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-core.mjs')).href) as { default: ModuleFactory }).default;
  core = await factory({ locateFile(name: string) { if (name !== 'splatview-core.wasm') throw new Error('Unexpected native artifact.'); return resolve('public/wasm/splatview-core.wasm'); } });
  coreAbi = core._sv_abi_version(); nativeIdentity = JSON.parse(core.UTF8ToString(core._sv_build_identity()));
  expect(coreAbi).toBe(24); expect(nativeIdentity).toMatchObject({ abi: 24, capabilities: { selectionMorphology: 2 } });
});
afterAll(() => process.stdout.write('SPLATVIEW_COMPRESSED_PLY_CALIBRATION ' + JSON.stringify({ policyId: POLICY_ID, coreAbi, fixtureCases: CASES.length,
  decoderCases, scopeCases, refusalCases, acceptedEdgeCases, capabilities: nativeIdentity?.capabilities, policy: POLICY, measurements }) + '\n'));

describe('independent compressed-PLY input provenance and analytic anchors', () => {
  it('binds sixteen original inputs, unaligned layouts and frozen decoder branches', () => {
    const manifest = JSON.parse(new TextDecoder().decode(fixture('manifest.json'))) as {
      schemaVersion: number; packet: string; policyId: string; policies: Record<string, unknown>; construction: string; constructionSha256: string;
      sourceLock: { path: string; sha256: string; package: string; treeSha256: string }; nativeBranches: { path: string; sha256: string; bytes: number }[];
      inputs: { file: string; bytes: number; sha256: string; layoutBoundCount: number; retainedDegree: number; sourceCount: number; chunkCount: number;
        encoding: string; headerBytes: number; chunkStride: number; vertexStride: number; shStride: number; shPropertyCount: number;
        payloadOffsets: { chunk: number; vertex: number; sh: number | null }; cap3SourceIds: number[]; cap2SourceIds: number[]; cap1SourceIds: number[] }[];
    };
    expect(manifest).toMatchObject({ schemaVersion: 1, packet: 'compressed-ply-v1', policyId: POLICY_ID, policies: POLICY,
      construction: 'tools/formats/build-compressed-ply-v1.mjs' });
    expect(sha(readFileSync(manifest.construction))).toBe(manifest.constructionSha256);
    expect(manifest.sourceLock).toMatchObject({ path: 'native/SOURCE_LOCK.json', package: 'splatview' }); expect(sha(readFileSync(manifest.sourceLock.path))).toBe(manifest.sourceLock.sha256);
    const lock = JSON.parse(readFileSync(manifest.sourceLock.path, 'utf8')) as { packages: { splatview: { treeSha256: string } }; files: { path: string; sha256: string }[] };
    expect(manifest.sourceLock.treeSha256).toBe('f0b272ebe75f0c8380610e4c242faab76e3922f7494cf675d679c9d8dad37e61');
    expect(manifest.sourceLock.treeSha256).toBe(lock.packages.splatview.treeSha256);
    expect(manifest.nativeBranches.map(row => row.path)).toEqual(NATIVE_BRANCHES);
    for (const row of manifest.nativeBranches) { const bytes = readFileSync(row.path); expect(bytes.length).toBe(row.bytes); expect(sha(bytes)).toBe(row.sha256); expect(row.sha256).toBe(lock.files.find(value => value.path === row.path)!.sha256); }
    expect(manifest.inputs.map(row => row.file)).toEqual(CASES.map(row => row.file));
    for (const [index, row] of manifest.inputs.entries()) {
      const bytes = fixture(row.file), input = parseInput(bytes), sample = CASES[index];
      expect(bytes.length).toBe(row.bytes); expect(sha(bytes)).toBe(row.sha256);
      expect(row).toMatchObject({ layoutBoundCount: sample.layout, retainedDegree: sample.degree, sourceCount: 257, chunkCount: 2,
        vertexStride: 17, shPropertyCount: REST[sample.degree], cap3SourceIds: [85, 171, 256], cap2SourceIds: [128, 256], cap1SourceIds: [256] });
      expect(input.end % 4).toBe(1); expect(input.little).toBe(sample.endian === 'le');
      expect([...input.elements.keys()]).toEqual(sample.degree ? ['chunk', 'vertex', 'sh'] : ['chunk', 'vertex']);
      const chunk = input.elements.get('chunk')!, vertex = input.elements.get('vertex')!, sh = input.elements.get('sh');
      expect([chunk.count, vertex.count, sh?.count ?? null]).toEqual([2, 257, sample.degree ? 257 : null]);
      expect(vertex.stride).toBe(17);
      expect(vertex.properties.map(p => [p.type, p.name, p.offset])).toEqual([
        ['uchar', 'sentinel', 0], ['uint32', 'packed_scale', 1], ['uint', 'packed_color', 5], ['uint32', 'packed_rotation', 9], ['uint', 'packed_position', 13],
      ]);
      expect(row).toMatchObject({ encoding: sample.endian === 'le' ? 'binary_little_endian' : 'binary_big_endian', headerBytes: input.end,
        chunkStride: chunk.stride, shStride: sh?.stride ?? 0, payloadOffsets: { chunk: chunk.offset, vertex: vertex.offset, sh: sh?.offset ?? null } });
      if (sh) expect(sh.properties.map(p => p.name)).toEqual(Array.from({ length: REST[sample.degree] }, (_, i) => `f_rest_${REST[sample.degree] - 1 - i}`));
      for (let chunk = 0; chunk < 2; chunk++) BOUND_NAMES.slice(0, sample.layout).forEach((name, component) => expect(scalar(input, 'chunk', chunk, name)).toBe(BOUNDS[chunk][component]));
      const anchors = [[0, 0, 0, 0], [1, 2047, 1023, 2047], [85, 608, 92, 72], [128, 909, 659, 1163], [171, 1210, 202, 206], [256, 1805, 275, 267]];
      for (const [id, ...codes] of anchors) expect(triplet(scalar(input, 'vertex', id, 'packed_position'))).toEqual(codes);
      expect(triplet(scalar(input, 'vertex', 256, 'packed_scale'))).toEqual([859, 309, 1381]);
      expect(analytic(input, 256, sample.degree).rgba).toEqual([5, 250, 73, 96]);
      expect(new Set(FULL_IDS.map(id => analytic(input, id, sample.degree).missing))).toEqual(new Set([0, 1, 2, 3]));
      if (sample.degree) expect(analytic(input, 0, sample.degree).sh.slice(3, 6)).toEqual([4, -.015625, 3.453125]);
    }
  });
  it('anchors covariance signs, half endpoints/ties and literal cap memberships independently', () => {
    covariance([1, 2, 3], [2, 1, 0, 0], true).forEach((value, i) => expect(Math.abs(value - [1, 0, 0, 7.2, -2.4, 5.8][i])).toBeLessThan(4e-15));
    expect([halfBits(0), halfBits(-0), halfBits(1), halfBits(-4), halfBits(4), halfBits(1 + 2 ** -11), halfBits(1 + 3 * 2 ** -11)])
      .toEqual([0, 0x8000, 0x3c00, 0xc400, 0x4400, 0x3c00, 0x3c02]);
    expect(SAMPLES.slice(1).map(row => row.ids)).toEqual([[85, 171, 256], [128, 256], [256]]);
  });
});
for (const sample of CASES) {
  for (const load of SAMPLES) it(`${sample.file}: cap${load.cap} independently decodes ${load.ids.length} attributes and SH stride`, () => {
    const input = parseInput(fixture(sample.file)), result = open(input.bytes, load.cap);
    expect(result.ok, result.error).toBe(true);
    expect(result).toMatchObject({ kind: 0, format: 'Compressed PLY', loaded: true, sourceCount: 257, count: load.ids.length,
      shDegree: sample.degree, yUp: true, selected: 0, visible: load.ids.length });
    checkDecoded(input, load.ids, sample.degree, `${sample.file}/cap${load.cap}`); checkExport(input, load.ids, sample.degree, 0, `${sample.file}/cap${load.cap}`); decoderCases++;
  });
  it(`${sample.file}: independent All/Selected/Remainder PLY membership and delete/Undo`, () => {
    const input = parseInput(fixture(sample.file)); expect(open(input.bytes, 3).ok).toBe(true);
    checkExport(input, [85, 171, 256], sample.degree, 0, sample.file);
    expect(command({ command: 'single', index: 1 }).selected).toBe(1);
    checkExport(input, [171], sample.degree, 1, sample.file); checkExport(input, [85, 256], sample.degree, 2, sample.file);
    expect(command({ command: 'delete' }).visible).toBe(2); checkExport(input, [85, 256], sample.degree, 0, sample.file);
    expect(command({ command: 'undo' }).visible).toBe(3); checkExport(input, [85, 171, 256], sample.degree, 0, sample.file); scopeCases++;
  });
}

const BASE = 'layout18-le-sh3.ply';
function headerChange(change: (header: string) => string) {
  const bytes = fixture(BASE), h = split(bytes); return new Uint8Array(Buffer.concat([Buffer.from(change(h.text)), bytes.subarray(h.end)]));
}
function floatChange(name: string, value: number, chunk = 0) {
  const input = parseInput(fixture(BASE)), at = field(input, 'chunk', chunk, name).offset;
  new DataView(input.bytes.buffer).setFloat32(at, value, input.little); return input.bytes;
}
function preserveRefusal(bytes: Uint8Array, cap = 1000) {
  const input = parseInput(fixture(BASE)); expect(open(input.bytes).ok).toBe(true);
  let moved = command({ command: 'transform', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .125, 0, 0, 1], selectedOnly: false });
  expect(moved.ok, moved.error).toBe(true);
  for (let step = 0; moved.pending && step < 2; step++) moved = decode(core._sv_step(65536));
  expect(moved.ok, moved.error).toBe(true); expect(moved.pending).toBe(false);
  expect(new DataView(sceneBytes(257).buffer).getFloat32(0, true)).toBe(100.125);
  expect(command({ command: 'single', index: 85 }).selected).toBe(1);
  expect(command({ command: 'delete' }).visible).toBe(256); expect(command({ command: 'undo' }).canRedo).toBe(true);
  // Export before the baseline summary: retained output is real native memory.
  const previousOutput = exported(0), before = command({ command: 'summary' }), previousScene = sceneBytes(257), previousMasks = masks(257);
  const pointers = [core._sv_scene_ptr(), core._sv_states_ptr(), core._sv_output_ptr(), core._sv_output_len()];
  const refused = open(bytes, cap); expect(refused.ok).toBe(false); expect(refused.error).toBeTruthy();
  const after = command({ command: 'summary' });
  for (const fieldName of ['count', 'sourceCount', 'kind', 'format', 'shDegree', 'selected', 'visible', 'revision', 'contentRevision', 'canUndo', 'canRedo', 'memoryBytes', 'exportBytes', 'exportOutputBytes'] as const)
    expect(after[fieldName], fieldName).toEqual(before[fieldName]);
  expect([core._sv_scene_ptr(), core._sv_states_ptr(), core._sv_output_ptr(), core._sv_output_len()]).toEqual(pointers);
  expect(sceneBytes(257)).toEqual(previousScene); expect(masks(257)).toEqual(previousMasks); expect(outputBytes()).toEqual(previousOutput);
  const redone = command({ command: 'redo' }); expect(redone.ok, redone.error).toBe(true); expect(redone.visible).toBe(256); expect(redone.canRedo).toBe(false);
  expect(Array.from(masks(257), state => Boolean(state & 2))).toEqual(FULL_IDS.map(id => id === 85));
  checkExport(input, FULL_IDS.filter(id => id !== 85), 3, 0, 'refused-old-owner/redo', .125);
  expect(command({ command: 'undo' }).canRedo).toBe(true); expect(sceneBytes(257)).toEqual(previousScene); expect(masks(257)).toEqual(previousMasks);
  expect(exported(0)).toEqual(previousOutput); refusalCases++;
}
const HEADER_REFUSALS: [string, (text: string) => string][] = [
  ['ASCII packed input', text => text.replace('binary_little_endian', 'ascii')],
  ['unsupported scalar', text => text.replace('property uint packed_position', 'property uint64 packed_position')],
  ['missing bound', text => text.replace(/property (?:float|float32) min_x\n/, '')],
  ['missing packed position', text => text.replace('property uint packed_position\n', '')],
  ['wrong bound scalar', text => text.replace(/property (float|float32) min_x/, 'property uint min_x')],
  ['wrong packed scalar', text => text.replace('property uint packed_position', 'property float packed_position')],
  ['wrong SH scalar', text => text.replace(/property (uchar|uint8) f_rest_0\n/, 'property char f_rest_0\n')],
  ['wrong chunk count', text => text.replace('element chunk 2', 'element chunk 1')],
  ['wrong SH count', text => text.replace('element sh 257', 'element sh 256')],
  ['zero vertices', text => text.replace('element vertex 257', 'element vertex 0')],
  ['duplicate property', text => text.replace('property uint packed_position', 'property uint packed_position\nproperty uint packed_position')],
  ['duplicate element', text => text.replace('end_header', 'element chunk 0\nproperty float duplicate\nend_header')],
  ['unsupported element', text => text.replace('end_header', 'element face 0\nproperty uint ignored\nend_header')],
  ['list property', text => text.replace('property uchar sentinel', 'property list uchar uint sentinel')],
];
describe('source-reviewed compressed-PLY refusal transaction and accepted edges', () => {
  for (const [name, change] of HEADER_REFUSALS) it(`${name} refuses without changing old bytes, masks, output or executable Redo`, () => preserveRefusal(headerChange(change)));
  for (const value of [NaN, Infinity, -Infinity]) it(`nonfinite bound ${value} is refused even when its chunk is sampled out`, () => preserveRefusal(floatChange('min_x', value), 1));
  for (const [low, high] of [['min_x', 109], ['min_scale_y', 1], ['min_b', 1]] as const)
    it(`reversed ${low} refuses with complete old-owner preservation`, () => preserveRefusal(floatChange(low, high)));
  for (const table of ['chunk', 'vertex', 'sh']) it(`truncated ${table} payload refuses with complete old-owner preservation`, () => {
    const input = parseInput(fixture(BASE)), element = input.elements.get(table)!;
    preserveRefusal(input.bytes.subarray(0, element.offset + element.count * element.stride - 1));
  });
  for (const value of [1000, -1000]) it(`retained log-scale ${value} refuses but finite invalid sampled-out vertices remain packed`, () => {
    const input = parseInput(fixture(BASE)), view = new DataView(input.bytes.buffer);
    for (const name of ['min_scale_x', 'max_scale_x']) view.setFloat32(field(input, 'chunk', 0, name).offset, value, true);
    preserveRefusal(input.bytes);
    expect(open(input.bytes, 1).ok).toBe(true); checkDecoded(input, [256], 3, 'skipped-invalid-scale'); acceptedEdgeCases++;
  });
  it('finite equal bounds are accepted without inventing a positive bound span', () => {
    const input = parseInput(floatChange('max_x', 100)); expect(open(input.bytes).ok).toBe(true);
    checkDecoded(input, FULL_IDS, 3, 'equal-bound'); acceptedEdgeCases++;
  });
  it('smallest-three negative residual is clamped and its nonzero quaternion normalized', () => {
    const input = parseInput(fixture(BASE)); new DataView(input.bytes.buffer).setUint32(field(input, 'vertex', 0, 'packed_rotation').offset, 0, true);
    expect(analytic(input, 0, 3).quaternion[0]).toBe(0); expect(open(input.bytes).ok).toBe(true);
    checkDecoded(input, FULL_IDS, 3, 'clamped-quaternion'); acceptedEdgeCases++;
  });
  it('trailing bytes are accepted without changing declared records', () => {
    const input = parseInput(fixture(BASE)), bytes = new Uint8Array(Buffer.concat([input.bytes, Buffer.from([0xde, 0xad, 0xbe, 0xef])]));
    expect(open(bytes).ok).toBe(true); checkDecoded(input, FULL_IDS, 3, 'trailing-bytes'); acceptedEdgeCases++;
  });
});
