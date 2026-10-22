import assert from 'node:assert/strict';

// Independent analytic input/output oracle. This file imports no fixture
// constructor, production decoder, sampler, half, quaternion or covariance code.
export type KsplatMode = 0 | 1 | 2;
export type KsplatDegree = 0 | 1 | 2 | 3;
export interface KsplatFixture {
  mode: KsplatMode;
  degree: KsplatDegree;
  mixed?: boolean;
  /** Raw header mutations used only by independently declared boundary cases. */
  minSh?: number;
  maxSh?: number;
  positionRange?: number;
}
export const KSPLAT_POLICY_ID = 'ksplat-numeric-v1';
export const KSPLAT_POLICY = Object.freeze({ positionsAbsolute: 1e-5, opacityAbsolute: 1e-7,
  covarianceRelativeToMaxAxisVariance: 1e-5, dcBeforeHalfAbsolute: 2e-6, mode2ShBeforeHalfAbsolute: 2e-6,
  exportPositionsAbsolute: 1e-5, exportCovarianceRelativeToMaxAxisVariance: 3e-5, exportOpacityAbsolute: 3e-7 });
export const KSPLAT_COUNT = 263;
export const KSPLAT_IDS = Object.freeze(Array.from({ length: KSPLAT_COUNT }, (_, id) => id));
export const KSPLAT_SAMPLES = Object.freeze([
  { cap: 1000, ids: KSPLAT_IDS }, { cap: 3, ids: [87, 175, 262] },
  { cap: 2, ids: [131, 262] }, { cap: 1, ids: [262] },
]);
export const KSPLAT_CASES: readonly (KsplatFixture & { file: string })[] = Object.freeze([
  ...([0, 1, 2] as const).flatMap(mode => ([0, 1, 2, 3] as const).map(degree =>
    ({ mode, degree, file: `mode${mode}-sh${degree}.ksplat` }))),
  { mode: 2, degree: 3, mixed: true, file: 'mode2-mixed.ksplat' },
]);
const REST = [0, 9, 24, 45];
const PARITY = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];
const C0 = .28209479177387814;
const QUATERNIONS = [[2, 1, 0, 0], [2, 0, 1, 0], [2, 0, 0, 1], [1, 1, 1, 1],
  [3, 1, 2, 0], [3, 0, 1, 2], [2, -1, 1, 0]];
export interface KsplatSection {
  sectionIndex: number; count: number; capacity: number; degree: KsplatDegree;
  bucketSize: number; full: number; partialLengths: number[];
}
export interface KsplatInspectedSection extends KsplatSection {
  headerOffset: number; payloadOffset: number; partialLengthsOffset: number;
  bucketCentersOffset: number; dataOffset: number; metadataBytes: number;
  stride: number; storageBytes: number; bucketCount: number; sourceFirstId: number | null;
}
export function ksplatSections(fixture: KsplatFixture): KsplatSection[] {
  const entries: Omit<KsplatSection, 'sectionIndex'>[] = fixture.mixed ? [
    { count: 0, capacity: 2, degree: 3, bucketSize: 0, full: 0, partialLengths: [] },
    { count: 5, capacity: 8, degree: 0, bucketSize: 2, full: 1, partialLengths: [1, 2] },
    { count: 66, capacity: 69, degree: 1, bucketSize: 16, full: 3, partialLengths: [2, 16] },
    { count: 64, capacity: 67, degree: 2, bucketSize: 32, full: 1, partialLengths: [7, 25] },
    { count: 128, capacity: 131, degree: 3, bucketSize: 32, full: 3, partialLengths: [5, 27] },
    { count: 0, capacity: 1, degree: 3, bucketSize: 0, full: 0, partialLengths: [] },
  ] : [
    { count: 0, capacity: 2, degree: 3, bucketSize: 0, full: 0, partialLengths: [] },
    { count: 5, capacity: 8, degree: fixture.degree, bucketSize: 2, full: 1, partialLengths: [1, 2] },
    { count: 258, capacity: 261, degree: fixture.degree, bucketSize: 64, full: 3, partialLengths: [2, 64] },
    { count: 0, capacity: 1, degree: 3, bucketSize: 0, full: 0, partialLengths: [] },
  ];
  return entries.map((entry, sectionIndex) => ({ ...entry, sectionIndex }));
}
function stride(mode: KsplatMode, degree: number) { return (mode === 0 ? 44 : 24) + REST[degree] * [4, 2, 1][mode]; }
export function ksplatHalfValue(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = Math.floor(bits / 1024) % 32, fraction = bits % 1024;
  return exponent === 31 ? fraction ? NaN : sign * Infinity
    : sign * (exponent === 0 ? fraction * 2 ** -24 : 2 ** (exponent - 15) * (1 + fraction / 1024));
}
/** Binary search over the independently defined finite IEEE binary16 grid. */
export function ksplatHalfBits(value: number): number {
  assert(Number.isFinite(value) && Math.abs(value) < 65504, 'Expected a bounded finite oracle half.');
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, magnitude = Math.abs(value);
  if (magnitude === 0) return sign;
  let low = 0, high = 0x7bff;
  while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if (ksplatHalfValue(mid) <= magnitude) low = mid; else high = mid; }
  const a = magnitude - ksplatHalfValue(low), b = ksplatHalfValue(high) - magnitude;
  return sign | (a < b ? low : b < a ? high : low % 2 === 0 ? low : high);
}
function covariance(scales: readonly number[], quaternion: readonly number[], rub: boolean): number[] {
  const length = Math.sqrt(quaternion.reduce((sum, value) => sum + value * value, 0));
  const [w, x, y, z] = quaternion.map(value => value / length);
  const rotation = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  const signs = rub ? [1, -1, -1] : [1, 1, 1];
  return [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]].map(([i, j]) =>
    signs[i] * signs[j] * scales.reduce((sum, scale, k) => sum + scale * scale * rotation[i][k] * rotation[j][k], 0));
}
function locate(fixture: KsplatFixture, sourceId: number) {
  assert(Number.isInteger(sourceId) && sourceId >= 0 && sourceId < KSPLAT_COUNT);
  let start = 0;
  for (const section of ksplatSections(fixture)) {
    if (sourceId < start + section.count) {
      const local = sourceId - start, lengths = [...Array.from({ length: section.full }, () => section.bucketSize), ...section.partialLengths];
      let covered = 0;
      const bucket = lengths.findIndex(length => { const match = local < covered + length; covered += length; return match; });
      assert(bucket >= 0);
      return { section, local, bucket };
    }
    start += section.count;
  }
  throw new Error('Source ID is outside the independently declared section topology.');
}
const center = (section: number, bucket: number) => [section * 32 + bucket * 4, section * 8 - bucket * 2, -section * 16 + bucket * 3];
const shScalar = (id: number, band: number, channel: number, j: number) => (((id * 7 + band * 11 + channel * 13 + j * 3) % 31) - 15) / 32;
const shCode = (id: number, band: number, channel: number, j: number) => (id * 17 + band * 37 + channel * 41 + j * 13) % 256;
export function ksplatExpectedRecord(fixture: KsplatFixture, sourceId: number) {
  const { section, bucket } = locate(fixture, sourceId), origin = center(section.sectionIndex, bucket);
  const rawRange = fixture.positionRange ?? 4096, range = rawRange === 0 ? 32767 : rawRange;
  const position = origin.map((value, axis) => {
    const delta = ((sourceId * (axis + 1) + axis * 7) % 31) - 15;
    return value + (fixture.mode === 0 ? delta / 512 : (4096 + delta - range) * 8 / range);
  });
  const scales = [.5 + (sourceId % 7) / 16, .25 + (sourceId % 5) / 32, .125 + (sourceId % 3) / 64];
  const quaternion = QUATERNIONS[sourceId % QUATERNIONS.length];
  const rgba = [sourceId % 256, (sourceId * 3 + 17) % 256, (sourceId * 7 + 29) % 256, [0, 64, 128, 192, 255][sourceId % 5]];
  const rawMin = fixture.minSh ?? (fixture.mixed ? 0 : -.75), rawMax = fixture.maxSh ?? (fixture.mixed ? 0 : 1.25);
  const min = rawMin === 0 ? -1.5 : rawMin, max = rawMax === 0 ? 1.5 : rawMax;
  const sh = Array.from({ length: 48 }, (_, component) => {
    if (component < 3) return (rgba[component] / 255 - .5) / C0;
    const coefficient = Math.floor(component / 3), band = Math.floor(Math.sqrt(coefficient));
    const channel = component % 3, j = coefficient - band * band;
    const value = band > section.degree ? 0 : fixture.mode === 2
      ? (min * (255 - shCode(sourceId, band, channel, j)) + max * shCode(sourceId, band, channel, j)) / 255
      : shScalar(sourceId, band, channel, j);
    return value * PARITY[coefficient - 1];
  });
  return { sourceId, section, bucket, position, scales, quaternion, rgba, opacity: rgba[3] / 255,
    sh, variance: Math.max(...scales.map(value => value * value)), covarianceRub: covariance(scales, quaternion, true),
    covarianceRdf: covariance(scales, quaternion, false) };
}
export function inspectKsplatFixture(bytes: Uint8Array, fixture: KsplatFixture): KsplatInspectedSection[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), sections = ksplatSections(fixture);
  assert.equal(view.getUint8(0), 0); assert.equal(view.getUint8(1), 1);
  assert.equal(view.getUint32(4, true), sections.length); assert.equal(view.getUint32(8, true), sections.length);
  assert.equal(view.getUint32(12, true), sections.reduce((sum, s) => sum + s.capacity, 0));
  assert.equal(view.getUint32(16, true), KSPLAT_COUNT); assert.equal(view.getUint16(20, true), fixture.mode);
  assert.equal(view.getFloat32(36, true), fixture.mixed ? 0 : -.75); assert.equal(view.getFloat32(40, true), fixture.mixed ? 0 : 1.25);
  const usedMain = new Set([0, 1, ...Array.from({ length: 16 }, (_, i) => i + 4), 20, 21, ...Array.from({ length: 8 }, (_, i) => i + 36)]);
  for (let i = 0; i < 4096; i++) if (!usedMain.has(i)) assert.equal(bytes[i], 0, `main reserved byte${i}`);
  let offset = 4096 + sections.length * 1024, first = 0;
  const result = sections.map(section => {
    const h = 4096 + section.sectionIndex * 1024, bucketCount = section.full + section.partialLengths.length;
    for (const [at, value] of [[0, section.count], [4, section.capacity], [8, section.bucketSize], [12, bucketCount], [24, 4096], [32, section.full], [36, section.partialLengths.length]])
      assert.equal(view.getUint32(h + at, true), value, `section${section.sectionIndex}/u32@${at}`);
    assert.equal(view.getFloat32(h + 16, true), 16); assert.equal(view.getUint16(h + 20, true), 12); assert.equal(view.getUint16(h + 40, true), section.degree);
    const usedSection = new Set([...Array.from({ length: 22 }, (_, i) => i), ...Array.from({ length: 4 }, (_, i) => i + 24), ...Array.from({ length: 10 }, (_, i) => i + 32)]);
    for (let i = 0; i < 1024; i++) if (!usedSection.has(i)) assert.equal(bytes[h + i], 0, `section${section.sectionIndex}/reserved${i}`);
    const partialLengthsOffset = offset, bucketCentersOffset = offset + 4 * section.partialLengths.length;
    const metadataBytes = 4 * section.partialLengths.length + 12 * bucketCount, dataOffset = offset + metadataBytes;
    const recordStride = stride(fixture.mode, section.degree), storageBytes = metadataBytes + section.capacity * recordStride;
    section.partialLengths.forEach((value, i) => assert.equal(view.getUint32(offset + i * 4, true), value));
    for (let bucket = 0; bucket < bucketCount; bucket++) center(section.sectionIndex, bucket).forEach((value, axis) =>
      assert.equal(view.getFloat32(bucketCentersOffset + bucket * 12 + axis * 4, true), value));
    for (let local = 0; local < section.capacity; local++) {
      const at = dataOffset + local * recordStride;
      if (local >= section.count) {
        const word = fixture.mode === 0 ? 4 : 2, poison = fixture.mode === 0 ? 0x7fc00000 : 0x7e00;
        for (let i = 0; i + word <= recordStride; i += word) assert.equal(word === 4 ? view.getUint32(at + i, true) : view.getUint16(at + i, true), poison);
        if (recordStride % word) assert.equal(bytes[at + recordStride - 1], 0xa5, 'Odd compressed reserve has a literal final byte.');
        continue;
      }
      const id = first + local, expected = ksplatExpectedRecord(fixture, id), raw = expected.position;
      for (let axis = 0; axis < 3; axis++) {
        assert.equal(fixture.mode === 0 ? view.getFloat32(at + axis * 4, true) : view.getUint16(at + axis * 2, true),
          fixture.mode === 0 ? raw[axis] : 4096 + ((id * (axis + 1) + axis * 7) % 31) - 15);
        assert.equal(fixture.mode === 0 ? view.getFloat32(at + 12 + axis * 4, true) : view.getUint16(at + 6 + axis * 2, true),
          fixture.mode === 0 ? expected.scales[axis] : ksplatHalfBits(expected.scales[axis]));
      }
      expected.quaternion.forEach((value, q) => assert.equal(fixture.mode === 0 ? view.getFloat32(at + 24 + q * 4, true) : view.getUint16(at + 12 + q * 2, true),
        fixture.mode === 0 ? value : ksplatHalfBits(value)));
      expected.rgba.forEach((value, channel) => assert.equal(bytes[at + (fixture.mode === 0 ? 40 : 20) + channel], value));
      let sourceBand = 0;
      for (let band = 1; band <= section.degree; band++) {
        const count = band * 2 + 1;
        for (let channel = 0; channel < 3; channel++) for (let j = 0; j < count; j++) {
          const atSh = at + (fixture.mode === 0 ? 44 : 24) + (sourceBand + channel * count + j) * [4, 2, 1][fixture.mode];
          const actual = fixture.mode === 0 ? view.getFloat32(atSh, true) : fixture.mode === 1 ? view.getUint16(atSh, true) : bytes[atSh];
          const value = shScalar(id, band, channel, j);
          assert.equal(actual, fixture.mode === 0 ? value : fixture.mode === 1 ? ksplatHalfBits(value) : shCode(id, band, channel, j));
        }
        sourceBand += count * 3;
      }
    }
    const entry = { ...section, headerOffset: h, payloadOffset: offset, partialLengthsOffset, bucketCentersOffset, dataOffset,
      metadataBytes, stride: recordStride, storageBytes, bucketCount, sourceFirstId: section.count ? first : null };
    offset += storageBytes; first += section.count; return entry;
  });
  assert.equal(first, KSPLAT_COUNT); assert.equal(offset, bytes.byteLength); return result;
}
export interface KsplatMeasurement { maxAbsolute: number; maxNormalized: number; worst: string }
export type KsplatMeasurements = Record<string, KsplatMeasurement>;
function near(metrics: KsplatMeasurements, actual: number, expected: number, bound: number, field: string, label: string) {
  assert(Number.isFinite(actual), `${label} is nonfinite.`);
  const error = Math.abs(actual - expected), normalized = bound ? error / bound : error;
  const row = metrics[field] ??= { maxAbsolute: 0, maxNormalized: 0, worst: '' };
  row.maxAbsolute = Math.max(row.maxAbsolute, error);
  if (!row.worst || normalized > row.maxNormalized) { row.maxNormalized = normalized; row.worst = label; }
  assert(error <= bound, `${label}: ${actual} vs ${expected}, fixed bound ${bound}.`);
}
function checkHalf(metrics: KsplatMeasurements, bits: number, expected: number, allowance: number, label: string) {
  const value = ksplatHalfValue(bits);
  if (allowance === 0) { assert.equal(bits, ksplatHalfBits(expected), `${label}/exact half bits`); near(metrics, value, expected, 0, 'exactSh', label); return; }
  const a = ksplatHalfValue(ksplatHalfBits(expected - allowance)), b = ksplatHalfValue(ksplatHalfBits(expected + allowance));
  assert(Number.isFinite(value) && value >= Math.min(a, b) && value <= Math.max(a, b), `${label}/independent pre-half interval`);
  const halfStep = Math.max(2 ** -25, 2 ** (Math.floor(Math.log2(Math.max(Math.abs(expected), 2 ** -14))) - 11));
  near(metrics, value, expected, halfStep + allowance, label.includes('/dc') ? 'dcHalf' : 'mode2ShHalf', label);
}
function allowance(fixture: KsplatFixture, sourceId: number, component: number) {
  if (component < 3) return KSPLAT_POLICY.dcBeforeHalfAbsolute;
  return fixture.mode === 2 && Math.floor(Math.sqrt(Math.floor(component / 3))) <= locate(fixture, sourceId).section.degree
    ? KSPLAT_POLICY.mode2ShBeforeHalfAbsolute : 0;
}
export function assertKsplatNative(bytes: Uint8Array, fixture: KsplatFixture, sourceIds: readonly number[], label = 'native') {
  assert.equal(bytes.byteLength, sourceIds.length * 144);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), measurements: KsplatMeasurements = {};
  sourceIds.forEach((id, row) => {
    const expected = ksplatExpectedRecord(fixture, id), at = row * 144;
    [expected.position[0], -expected.position[1], -expected.position[2]].forEach((value, axis) =>
      near(measurements, view.getFloat32(at + axis * 4, true), value, KSPLAT_POLICY.positionsAbsolute, 'positions', `${label}/${id}/position${axis}`));
    near(measurements, view.getFloat32(at + 12, true), expected.opacity, KSPLAT_POLICY.opacityAbsolute, 'opacity', `${label}/${id}/opacity`);
    if (expected.rgba[3] === 0 || expected.rgba[3] === 255) assert.equal(view.getUint32(at + 12, true), expected.rgba[3] === 0 ? 0 : 0x3f800000);
    expected.covarianceRub.forEach((value, component) => near(measurements, view.getFloat32(at + 16 + component * 4, true), value,
      KSPLAT_POLICY.covarianceRelativeToMaxAxisVariance * expected.variance, 'covariance', `${label}/${id}/cov${component}`));
    assert.equal(view.getUint32(at + 40, true), 0); assert.equal(view.getUint32(at + 44, true), 0);
    expected.sh.forEach((value, component) => checkHalf(measurements, view.getUint16(at + 48 + component * 2, true), value,
      allowance(fixture, id, component), `${label}/${id}/${component < 3 ? 'dc' : 'sh'}${component}`));
  });
  return { recordCount: sourceIds.length, measurements };
}
function plyRecords(bytes: Uint8Array) {
  const marker = new TextEncoder().encode('end_header\n');
  let end = -1;
  outer: for (let i = 0; i <= Math.min(bytes.length - marker.length, 65536); i++) {
    for (let j = 0; j < marker.length; j++) if (bytes[i + j] !== marker[j]) continue outer;
    end = i + marker.length; break;
  }
  assert(end > 0, 'Independent PLY header terminator is missing.');
  const text = new TextDecoder().decode(bytes.subarray(0, end));
  assert(text.startsWith('ply\n')); assert(text.includes('format binary_little_endian 1.0\n'));
  const declarations = [...text.matchAll(/^property (\w+) (\w+)$/gm)];
  assert(declarations.every(row => row[1] === 'float'), 'Expected scalar float PLY export.');
  const properties = declarations.map(row => row[2]); assert.equal(new Set(properties).size, properties.length);
  const count = Number(/^element vertex (\d+)$/m.exec(text)?.[1]); assert(Number.isSafeInteger(count) && count >= 0);
  assert.equal(bytes.length - end, count * properties.length * 4);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { properties, rows: Array.from({ length: count }, (_, row) => Object.fromEntries(properties.map((property, column) =>
    [property, view.getFloat32(end + 4 * (row * properties.length + column), true)]))) };
}
/** Reusable by production Playwright: no Vitest runtime or native dependency. */
export function assertKsplatPly(bytes: Uint8Array, fixture: KsplatFixture, sourceIds: readonly number[], options: { translationX?: number } = {}) {
  const { properties, rows } = plyRecords(bytes), measurements: KsplatMeasurements = {};
  assert.equal(rows.length, sourceIds.length); assert.equal(properties.filter(name => name.startsWith('f_rest_')).length, REST[fixture.degree]);
  for (const name of ['x', 'y', 'z', 'nx', 'ny', 'nz', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3', 'f_dc_0', 'f_dc_1', 'f_dc_2']) assert(properties.includes(name), `Missing PLY ${name}.`);
  const perChannel = REST[fixture.degree] / 3;
  sourceIds.forEach((id, row) => {
    const expected = ksplatExpectedRecord(fixture, id), actual = rows[row];
    ['x', 'y', 'z'].forEach((axis, i) => near(measurements, actual[axis], expected.position[i] + (i === 0 ? options.translationX ?? 0 : 0),
      KSPLAT_POLICY.exportPositionsAbsolute, 'exportPositions', `PLY/${id}/${axis}`));
    const cov = covariance([0, 1, 2].map(i => Math.exp(actual[`scale_${i}`])), [0, 1, 2, 3].map(i => actual[`rot_${i}`]), false);
    cov.forEach((value, i) => near(measurements, value, expected.covarianceRdf[i], KSPLAT_POLICY.exportCovarianceRelativeToMaxAxisVariance * expected.variance,
      'exportCovariance', `PLY/${id}/cov${i}`));
    near(measurements, 1 / (1 + Math.exp(-actual.opacity)), Math.min(1 - 1e-7, Math.max(1e-7, expected.opacity)),
      KSPLAT_POLICY.exportOpacityAbsolute, 'exportOpacity', `PLY/${id}/opacity`);
    assert.deepEqual([actual.nx, actual.ny, actual.nz], [0, 0, 0]);
    for (let channel = 0; channel < 3; channel++) {
      const value = actual[`f_dc_${channel}`], bits = ksplatHalfBits(value); assert.equal(value, ksplatHalfValue(bits));
      checkHalf(measurements, bits, expected.sh[channel], KSPLAT_POLICY.dcBeforeHalfAbsolute, `PLY/${id}/dc${channel}`);
      for (let term = 0; term < perChannel; term++) {
        const component = (term + 1) * 3 + channel, value = actual[`f_rest_${channel * perChannel + term}`] * PARITY[term];
        const bits = ksplatHalfBits(value); assert.equal(value, ksplatHalfValue(bits));
        checkHalf(measurements, bits, expected.sh[component], allowance(fixture, id, component), `PLY/${id}/sh${component}`);
      }
    }
  });
  return { recordCount: rows.length, measurements };
}
