import { createHash } from 'node:crypto';

// This oracle deliberately imports no fixture builder, application parser,
// native implementation or production math. The analytic workload and wire
// layouts below are independently specified, original project test data.
export const BENCHMARK_FIXTURE_ID = 'dyadic-grid-256k-sh0-v1';
export const BENCHMARK_RECORD_COUNT = 256_000;
export const BENCHMARK_CANONICAL_RECORD_BYTES = 144;
const RAW_RECORD_BYTES = 32;
const BATCH_ROWS = 1_024;
const SCALE_X = 2 ** -10, SCALE_Y = 2 ** -9, SCALE_Z = 2 ** -8;
const VARIANCE_X = 2 ** -20, VARIANCE_Y = 2 ** -18, VARIANCE_Z = 2 ** -16;
const HALF_DC = 0x3f17;
const C0 = 0.28209479177387814;
const HALF_DC_VALUE = 1.7724609375;
const DISTRIBUTION_PREFIX = new TextEncoder().encode('SplatViewBenchmarkDistribution\0v1\0dyadic-grid-256k-sh0-v1\0');
// RDF -> RUB parity of the 15 real SH polynomials after the DC term.
// Only these negative-parity absent bands may contain half negative zero.
const NEGATIVE_SH_BANDS = new Set([1, 2, 4, 7, 9, 11, 12, 14]);
const ZERO_COVARIANCE_OFFSETS = [20, 24, 32] as const;

export interface BenchmarkExpectedRecord {
  sourceId: number;
  wirePosition: readonly [number, number, number];
  rubPosition: readonly [number, number, number];
  scales: readonly [number, number, number];
  rgba: readonly [number, number, number, number];
  quaternionBytes: readonly [number, number, number, number];
  covariance: readonly [number, number, number, number, number, number];
  dcHalfBits: readonly [number, number, number];
}

export interface BenchmarkIdentities {
  fixtureId: typeof BENCHMARK_FIXTURE_ID;
  count: number;
  canonicalRecordBytes: typeof BENCHMARK_CANONICAL_RECORD_BYTES;
  inputSha256: string;
  expectedSceneSha256: string;
  sourceOrderSha256: string;
  membershipSha256: string;
  distributionSha256: string;
}

export interface ExactBenchmarkValidation extends BenchmarkIdentities {
  encodedSha256: string;
  canonicalSceneSha256: string;
}

export interface NumericMaximum {
  maxAbsoluteError: number;
  maxNormalizedError: number;
  worstRecord: number | null;
  worstComponent: number | null;
}

export interface BenchmarkExportValidation extends BenchmarkIdentities {
  encodedSha256: string;
  // A semantic identity qualified by every exact membership/position check and
  // every fixed numeric bound below. This is not the hash of exported bytes.
  validatedSemanticSceneSha256: string;
  // Actual independently decoded attributes, including numeric differences.
  // Domain prefix then 68B/row: LE f32 xyz/opacity, six LE f64 covariance
  // components xx,xy,xz,yy,yz,zz, then RGB bytes and a zero reserved byte.
  decodedAttributeSha256: string;
  numeric: {
    policyId: 'ply-splat-numeric-v1';
    covariance: NumericMaximum;
    opacity: NumericMaximum;
    color: NumericMaximum;
    linearScalePolicy: 'dyadic-grid-linear-scales-v1';
    linearScales: NumericMaximum;
    exactRgba: true;
  };
}

/** Reused by scanRawSplat. A visitor must copy any values it retains. */
export interface RawSplatRow {
  position: Float64Array;
  scales: Float64Array;
  rgba: Uint8Array;
  quaternion: Float64Array;
  quaternionBytes: Uint8Array;
}

function hash() { return createHash('sha256'); }
function sha(bytes: Uint8Array): string { return hash().update(bytes).digest('hex'); }
function fail(message: string): never { throw new Error(`Benchmark oracle: ${message}`); }
function sourceId(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= BENCHMARK_RECORD_COUNT) fail('source ID outside the fixed workload');
}

function xFor(id: number): number { return id === 0 ? -8 : id === 1 ? 8 : id === 2 ? 0 : ((id % 64) * 2 - 63) / 32; }
function yFor(id: number): number { return id < 2 ? 0 : id === 2 ? 8 : ((Math.floor(id / 64) % 50) * 2 - 49) / 32; }
function zFor(id: number): number { return id < 3 ? 0 : (Math.floor(id / 3_200) * 2 - 79) / 32; }

/** Analytic expectations; no data is inferred from observed native output. */
export function benchmarkExpectedRecord(id: number): BenchmarkExpectedRecord {
  sourceId(id);
  const x = xFor(id), y = yFor(id), z = zFor(id), channel = id % 3;
  return {
    sourceId: id, wirePosition: [x, y, z], rubPosition: [x, -y, -z],
    scales: [SCALE_X, SCALE_Y, SCALE_Z],
    rgba: [channel === 0 ? 255 : 0, channel === 1 ? 255 : 0, channel === 2 ? 255 : 0, 255],
    quaternionBytes: [255, 128, 128, 128],
    covariance: [VARIANCE_X, 0, 0, VARIANCE_Y, 0, VARIANCE_Z],
    dcHalfBits: [channel === 0 ? HALF_DC : HALF_DC | 0x8000,
      channel === 1 ? HALF_DC : HALF_DC | 0x8000, channel === 2 ? HALF_DC : HALF_DC | 0x8000],
  };
}

function writeExpectedRaw(view: DataView, at: number, id: number): void {
  view.setFloat32(at, xFor(id), true); view.setFloat32(at + 4, yFor(id), true); view.setFloat32(at + 8, zFor(id), true);
  view.setFloat32(at + 12, SCALE_X, true); view.setFloat32(at + 16, SCALE_Y, true); view.setFloat32(at + 20, SCALE_Z, true);
  view.setUint8(at + 24, id % 3 === 0 ? 255 : 0); view.setUint8(at + 25, id % 3 === 1 ? 255 : 0);
  view.setUint8(at + 26, id % 3 === 2 ? 255 : 0); view.setUint8(at + 27, 255);
  view.setUint8(at + 28, 255); view.setUint8(at + 29, 128); view.setUint8(at + 30, 128); view.setUint8(at + 31, 128);
}

function writeExpectedCanonical(view: DataView, at: number, id: number): void {
  // The reused batch starts zeroed. Every nonzero field is always overwritten;
  // all absent/padding fields stay positive zero. y/z zero signs normalize here.
  view.setFloat32(at, xFor(id) || 0, true); view.setFloat32(at + 4, -yFor(id) || 0, true);
  view.setFloat32(at + 8, -zFor(id) || 0, true); view.setFloat32(at + 12, 1, true);
  view.setFloat32(at + 16, VARIANCE_X, true); view.setFloat32(at + 28, VARIANCE_Y, true);
  view.setFloat32(at + 36, VARIANCE_Z, true);
  for (let channel = 0; channel < 3; channel++) view.setUint16(at + 48 + 2 * channel,
    id % 3 === channel ? HALF_DC : HALF_DC | 0x8000, true);
}

let identities: Readonly<BenchmarkIdentities> | undefined;
/** Recomputed independently in bounded batches, then cached as immutable data. */
export function benchmarkExpectedIdentities(): BenchmarkIdentities {
  if (!identities) {
    const raw = new Uint8Array(BATCH_ROWS * 32), canonical = new Uint8Array(BATCH_ROWS * 144), ids = new Uint8Array(BATCH_ROWS * 4);
    const rawView = new DataView(raw.buffer), canonicalView = new DataView(canonical.buffer), idsView = new DataView(ids.buffer);
    const rawHash = hash(), sceneHash = hash(), orderHash = hash(), distributionHash = hash().update(DISTRIBUTION_PREFIX);
    for (let first = 0; first < BENCHMARK_RECORD_COUNT; first += BATCH_ROWS) {
      const count = Math.min(BATCH_ROWS, BENCHMARK_RECORD_COUNT - first);
      for (let offset = 0; offset < count; offset++) {
        writeExpectedRaw(rawView, offset * 32, first + offset);
        writeExpectedCanonical(canonicalView, offset * 144, first + offset);
        idsView.setUint32(offset * 4, first + offset, true);
      }
      rawHash.update(raw.subarray(0, count * 32)); sceneHash.update(canonical.subarray(0, count * 144));
      distributionHash.update(canonical.subarray(0, count * 144)); orderHash.update(ids.subarray(0, count * 4));
    }
    const sourceOrderSha256 = orderHash.digest('hex');
    identities = Object.freeze({ fixtureId: BENCHMARK_FIXTURE_ID, count: BENCHMARK_RECORD_COUNT,
      canonicalRecordBytes: BENCHMARK_CANONICAL_RECORD_BYTES, inputSha256: rawHash.digest('hex'),
      expectedSceneSha256: sceneHash.digest('hex'), sourceOrderSha256,
      membershipSha256: sourceOrderSha256, distributionSha256: distributionHash.digest('hex') });
  }
  return { ...identities };
}

function wireLength(bytes: Uint8Array, maxRecords: number): number {
  if (!(bytes instanceof Uint8Array)) fail('input must be bytes');
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 1_000_000) fail('invalid parser record bound');
  if (bytes.byteLength === 0 || bytes.byteLength % RAW_RECORD_BYTES !== 0) fail('SPLAT length must contain complete 32-byte rows');
  const count = bytes.byteLength / RAW_RECORD_BYTES;
  if (count > maxRecords) fail('SPLAT exceeds parser record bound');
  return count;
}

/**
 * Independently parses every raw SPLAT field. The single row object and its
 * fixed typed arrays are reused; memory does not grow with record count.
 * This generic bounded parser establishes wire validity, not benchmark scope.
 */
export function scanRawSplat(bytes: Uint8Array, visitor?: (row: RawSplatRow, index: number) => void,
  maxRecords = 1_000_000): { count: number; encodedSha256: string } {
  const count = wireLength(bytes, maxRecords), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const row: RawSplatRow = { position: new Float64Array(3), scales: new Float64Array(3), rgba: new Uint8Array(4),
    quaternion: new Float64Array(4), quaternionBytes: new Uint8Array(4) };
  for (let index = 0; index < count; index++) {
    const at = index * 32;
    for (let axis = 0; axis < 3; axis++) {
      row.position[axis] = view.getFloat32(at + axis * 4, true);
      row.scales[axis] = view.getFloat32(at + 12 + axis * 4, true);
      if (!Number.isFinite(row.position[axis])) fail(`row ${index} non-finite position ${axis}`);
      if (!Number.isFinite(row.scales[axis]) || row.scales[axis] <= 0) fail(`row ${index} invalid scale ${axis}`);
    }
    let norm = 0;
    for (let component = 0; component < 4; component++) {
      row.rgba[component] = bytes[at + 24 + component]; row.quaternionBytes[component] = bytes[at + 28 + component];
      row.quaternion[component] = (row.quaternionBytes[component] - 128) / 128;
      norm += row.quaternion[component] ** 2;
    }
    if (norm === 0) fail(`row ${index} zero quaternion`);
    visitor?.(row, index);
  }
  return { count, encodedSha256: sha(bytes) };
}

/** One-row assertion for small independent unit fixtures, not workload acceptance. */
export function assertBenchmarkRawRecord(row: RawSplatRow, id: number): void {
  sourceId(id);
  if (row.position[0] !== xFor(id) || row.position[1] !== yFor(id) || row.position[2] !== zFor(id)) fail(`source ${id} wire position/order`);
  if (row.scales[0] !== SCALE_X || row.scales[1] !== SCALE_Y || row.scales[2] !== SCALE_Z) fail(`source ${id} wire scales`);
  for (let component = 0; component < 4; component++) {
    if (row.rgba[component] !== (component === 3 || id % 3 === component ? 255 : 0)) fail(`source ${id} wire RGBA ${component}`);
    if (row.quaternionBytes[component] !== (component === 0 ? 255 : 128)) fail(`source ${id} wire quaternion ${component}`);
  }
}

function requireFullCount(count: number): void {
  if (count !== BENCHMARK_RECORD_COUNT) fail(`fixed workload requires ${BENCHMARK_RECORD_COUNT} complete records, got ${count}`);
}

/** Strict original 8,192,000-byte input, all attributes and source order. */
export function validateBenchmarkRaw(bytes: Uint8Array): ExactBenchmarkValidation & { rawSha256: string } {
  requireFullCount(wireLength(bytes, BENCHMARK_RECORD_COUNT));
  const batch = new Uint8Array(BATCH_ROWS * 144), target = new DataView(batch.buffer);
  const ids = new Uint8Array(BATCH_ROWS * 4), idsView = new DataView(ids.buffer);
  const sceneHash = hash(), distributionHash = hash().update(DISTRIBUTION_PREFIX), orderHash = hash();
  const observed = scanRawSplat(bytes, (row, index) => {
    assertBenchmarkRawRecord(row, index);
    const id = idFromWirePosition(row.position[0], row.position[1], row.position[2]);
    if (id !== index) fail('raw source order differs');
    const local = index % BATCH_ROWS, at = local * 144;
    idsView.setUint32(local * 4, id, true);
    for (let axis = 0; axis < 3; axis++) target.setFloat32(at + axis * 4, (axis === 0 ? row.position[axis] : -row.position[axis]) || 0, true);
    target.setFloat32(at + 12, row.rgba[3] / 255, true);
    target.setFloat32(at + 16, row.scales[0] ** 2, true); target.setFloat32(at + 28, row.scales[1] ** 2, true);
    target.setFloat32(at + 36, row.scales[2] ** 2, true);
    for (let channel = 0; channel < 3; channel++) target.setUint16(at + 48 + 2 * channel,
      row.rgba[channel] === 255 ? HALF_DC : HALF_DC | 0x8000, true);
    if (local === BATCH_ROWS - 1 || index === BENCHMARK_RECORD_COUNT - 1) {
      sceneHash.update(batch.subarray(0, (local + 1) * 144)); distributionHash.update(batch.subarray(0, (local + 1) * 144));
      orderHash.update(ids.subarray(0, (local + 1) * 4));
    }
  }, BENCHMARK_RECORD_COUNT), expected = benchmarkExpectedIdentities();
  // This additionally binds positive zero and every original encoded byte.
  if (observed.encodedSha256 !== expected.inputSha256) fail('original raw encoding differs from independently expected bytes');
  const canonicalSceneSha256 = sceneHash.digest('hex'), distributionSha256 = distributionHash.digest('hex');
  const sourceOrderSha256 = orderHash.digest('hex');
  if (canonicalSceneSha256 !== expected.expectedSceneSha256 || distributionSha256 !== expected.distributionSha256 ||
    sourceOrderSha256 !== expected.sourceOrderSha256) fail('raw decoded semantic identity differs');
  return { ...expected, encodedSha256: observed.encodedSha256, rawSha256: observed.encodedSha256,
    canonicalSceneSha256, distributionSha256, sourceOrderSha256, membershipSha256: sourceOrderSha256 };
}

/** One canonical-native row assertion; never a GPU 48-byte SH0 stream row. */
export function assertBenchmarkPackedRecord(view: DataView, at: number, id: number): void {
  sourceId(id);
  if (!Number.isSafeInteger(at) || at < 0 || at + 144 > view.byteLength) fail('incomplete native 144-byte record');
  if (view.getFloat32(at, true) !== xFor(id) || view.getFloat32(at + 4, true) !== -yFor(id) ||
    view.getFloat32(at + 8, true) !== -zFor(id)) fail(`source ${id} native RUB position/order`);
  if (view.getFloat32(at + 12, true) !== 1) fail(`source ${id} native opacity`);
  if (view.getFloat32(at + 16, true) !== VARIANCE_X || view.getFloat32(at + 28, true) !== VARIANCE_Y ||
    view.getFloat32(at + 36, true) !== VARIANCE_Z) fail(`source ${id} native covariance diagonal`);
  for (const offset of ZERO_COVARIANCE_OFFSETS) if (view.getUint32(at + offset, true) !== 0) fail(`source ${id} native covariance off diagonal`);
  if (view.getUint32(at + 40, true) !== 0 || view.getUint32(at + 44, true) !== 0) fail(`source ${id} native padding`);
  for (let channel = 0; channel < 3; channel++) if (view.getUint16(at + 48 + 2 * channel, true) !==
    (id % 3 === channel ? HALF_DC : HALF_DC | 0x8000)) fail(`source ${id} native DC ${channel}`);
  for (let component = 3; component < 48; component++) {
    const bits = view.getUint16(at + 48 + 2 * component, true), band = Math.floor(component / 3);
    if (bits !== 0 && !(bits === 0x8000 && NEGATIVE_SH_BANDS.has(band))) fail(`source ${id} absent native SH ${component}`);
  }
}

/**
 * Full canonical native scene from _sv_scene_ptr: 256000 x 144B. This is not
 * CoreClient.stream()'s SH0 GPU encoding. Actual validated fields are hashed
 * after normalizing only numeric signed zeros. Padding is checked before hash.
 */
export function validateBenchmarkPacked(bytes: Uint8Array): ExactBenchmarkValidation & { packedSha256: string } {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== BENCHMARK_RECORD_COUNT * 144) fail('native scene length is not the complete fixed 144-byte workload');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), batch = new Uint8Array(BATCH_ROWS * 144);
  const target = new DataView(batch.buffer), sceneHash = hash(), distributionHash = hash().update(DISTRIBUTION_PREFIX);
  const ids = new Uint8Array(BATCH_ROWS * 4), idsView = new DataView(ids.buffer), orderHash = hash();
  for (let first = 0; first < BENCHMARK_RECORD_COUNT; first += BATCH_ROWS) {
    const count = Math.min(BATCH_ROWS, BENCHMARK_RECORD_COUNT - first);
    for (let offset = 0; offset < count; offset++) {
      const id = first + offset, at = id * 144, destination = offset * 144;
      assertBenchmarkPackedRecord(view, at, id);
      const recovered = idFromWirePosition(view.getFloat32(at, true), -view.getFloat32(at + 4, true), -view.getFloat32(at + 8, true));
      if (recovered !== id) fail('native source order differs');
      idsView.setUint32(offset * 4, recovered, true);
      for (let component = 0; component < 12; component++) {
        const value = view.getFloat32(at + 4 * component, true);
        target.setFloat32(destination + 4 * component, value === 0 ? 0 : value, true);
      }
      for (let component = 0; component < 48; component++) {
        const bits = view.getUint16(at + 48 + 2 * component, true);
        target.setUint16(destination + 48 + 2 * component, bits === 0x8000 ? 0 : bits, true);
      }
    }
    sceneHash.update(batch.subarray(0, count * 144)); distributionHash.update(batch.subarray(0, count * 144));
    orderHash.update(ids.subarray(0, count * 4));
  }
  const expected = benchmarkExpectedIdentities(), canonicalSceneSha256 = sceneHash.digest('hex'), distributionSha256 = distributionHash.digest('hex');
  const sourceOrderSha256 = orderHash.digest('hex');
  if (canonicalSceneSha256 !== expected.expectedSceneSha256 || distributionSha256 !== expected.distributionSha256 ||
    sourceOrderSha256 !== expected.sourceOrderSha256) fail('validated native canonical identity differs');
  const encodedSha256 = sha(bytes);
  return { ...expected, encodedSha256, packedSha256: encodedSha256, canonicalSceneSha256, distributionSha256,
    sourceOrderSha256, membershipSha256: sourceOrderSha256 };
}

function idFromWirePosition(x: number, y: number, z: number): number {
  if (x === -8 && y === 0 && z === 0) return 0;
  if (x === 8 && y === 0 && z === 0) return 1;
  if (x === 0 && y === 8 && z === 0) return 2;
  const ix = (32 * x + 63) / 2, iy = (32 * y + 49) / 2, iz = (32 * z + 79) / 2;
  if (!Number.isInteger(ix) || ix < 0 || ix >= 64 || !Number.isInteger(iy) || iy < 0 || iy >= 50 ||
    !Number.isInteger(iz) || iz < 0 || iz >= 80) fail('export position is not a unique original workload member');
  const id = ix + 64 * iy + 3_200 * iz;
  if (id < 3) fail('export contains a replaced grid position');
  return id;
}

function maximum(): NumericMaximum { return { maxAbsoluteError: 0, maxNormalizedError: 0, worstRecord: null, worstComponent: null }; }
function compareNumeric(actual: number, expected: number, bound: number, result: NumericMaximum, id: number, component: number, label: string,
  policy = 'ply-splat-numeric-v1'): void {
  if (!Number.isFinite(actual)) fail(`source ${id} non-finite ${label}`);
  const error = Math.abs(actual - expected), normalized = error / bound;
  result.maxAbsoluteError = Math.max(result.maxAbsoluteError, error);
  if (result.worstRecord === null || normalized > result.maxNormalizedError) {
    result.maxNormalizedError = normalized; result.worstRecord = id; result.worstComponent = component;
  }
  if (error > bound) fail(`source ${id} ${label} ${component} exceeds ${policy}: error ${error}, bound ${bound}`);
}

// Double-precision independent covariance using rotation columns (not native
// matrix/storage helpers). Equivalent axis permutations and quaternion signs
// are compared through their covariance, never their chosen parameterization.
function decodedCovariance(row: RawSplatRow, output: Float64Array): void {
  const norm = Math.hypot(row.quaternion[0], row.quaternion[1], row.quaternion[2], row.quaternion[3]);
  const w = row.quaternion[0] / norm, x = row.quaternion[1] / norm, y = row.quaternion[2] / norm, z = row.quaternion[3] / norm;
  const a = 1 - 2 * (y * y + z * z), b = 2 * (x * y + w * z), c = 2 * (x * z - w * y);
  const d = 2 * (x * y - w * z), e = 1 - 2 * (x * x + z * z), f = 2 * (y * z + w * x);
  const g = 2 * (x * z + w * y), h = 2 * (y * z - w * x), i = 1 - 2 * (x * x + y * y);
  const vx = row.scales[0] ** 2, vy = row.scales[1] ** 2, vz = row.scales[2] ** 2;
  output[0] = a * a * vx + d * d * vy + g * g * vz;
  output[1] = a * b * vx + d * e * vy + g * h * vz;
  output[2] = a * c * vx + d * f * vy + g * i * vz;
  output[3] = b * b * vx + e * e * vy + h * h * vz;
  output[4] = b * c * vx + e * f * vy + h * i * vz;
  output[5] = c * c * vx + f * f * vy + i * i * vz;
}

/** One independently parsed export row assertion, useful for small literals. */
export function assertBenchmarkSplatExportRecord(row: RawSplatRow, id: number,
  numeric = { covariance: maximum(), opacity: maximum(), color: maximum(), linearScales: maximum() }): typeof numeric {
  sourceId(id);
  if (row.position[0] !== xFor(id) || row.position[1] !== yFor(id) || row.position[2] !== zFor(id)) fail(`source ${id} exported position/order`);
  const covariance = new Float64Array(6);
  checkExportAttributes(row, id, covariance, numeric);
  return numeric;
}

function checkExportAttributes(row: RawSplatRow, id: number, covariance: Float64Array,
  numeric: { covariance: NumericMaximum; opacity: NumericMaximum; color: NumericMaximum; linearScales: NumericMaximum }): void {
  decodedCovariance(row, covariance);
  for (let component = 0; component < 6; component++) compareNumeric(covariance[component],
    component === 0 ? VARIANCE_X : component === 3 ? VARIANCE_Y : component === 5 ? VARIANCE_Z : 0,
    0.09 * VARIANCE_Z, numeric.covariance, id, component, 'exported covariance');
  compareNumeric(row.rgba[3] / 255, 1, 0.5 / 255 + 2e-7, numeric.opacity, id, 3, 'exported opacity');
  for (let channel = 0; channel < 3; channel++) {
    const dc = id % 3 === channel ? HALF_DC_VALUE : -HALF_DC_VALUE;
    const expectedByte = Math.min(255, Math.max(0, Math.round((dc * C0 + 0.5) * 255)));
    compareNumeric(row.rgba[channel], expectedByte, 1, numeric.color, id, channel, 'exported color');
  }
  // Additional fixture-specific invariants supplement, and do not widen, the
  // established codec bounds. The generic covariance bound alone is larger
  // than this fixture's smallest variance, so it cannot detect its erasure.
  const minimum = Math.min(row.scales[0], row.scales[1], row.scales[2]);
  const maximumScale = Math.max(row.scales[0], row.scales[1], row.scales[2]);
  const middle = row.scales[0] + row.scales[1] + row.scales[2] - minimum - maximumScale;
  compareNumeric(minimum, SCALE_X, 4e-6 * SCALE_X, numeric.linearScales, id, 0, 'fixture sorted linear scale', 'dyadic-grid-linear-scales-v1');
  compareNumeric(middle, SCALE_Y, 4e-6 * SCALE_Y, numeric.linearScales, id, 1, 'fixture sorted linear scale', 'dyadic-grid-linear-scales-v1');
  compareNumeric(maximumScale, SCALE_Z, 4e-6 * SCALE_Z, numeric.linearScales, id, 2, 'fixture sorted linear scale', 'dyadic-grid-linear-scales-v1');
  for (let component = 0; component < 4; component++) if (row.rgba[component] !==
    (component === 3 || id % 3 === component ? 255 : 0)) fail(`source ${id} exact workload RGBA ${component}`);
}

/**
 * Full-scene SPLAT export: independently parses all rows, recovers membership
 * from unique positions, preserves source order, and checks every attribute.
 * Limits are the pre-existing ply-splat-numeric-v1 codec policy; no capacity,
 * renderer, projected-overdraw or browser performance claim follows.
 */
export function validateBenchmarkSplatExport(bytes: Uint8Array): BenchmarkExportValidation {
  requireFullCount(wireLength(bytes, BENCHMARK_RECORD_COUNT));
  const seen = new Uint8Array(BENCHMARK_RECORD_COUNT), covariance = new Float64Array(6), idBatch = new Uint8Array(BATCH_ROWS * 4);
  const idView = new DataView(idBatch.buffer), decodedBatch = new Uint8Array(BATCH_ROWS * 68), decodedView = new DataView(decodedBatch.buffer);
  const sourceOrderHash = hash(), membershipHash = hash(), decodedHash = hash().update('SplatViewBenchmarkExportDecoded\0v1\0');
  const numeric = { covariance: maximum(), opacity: maximum(), color: maximum(), linearScales: maximum() };
  const observed = scanRawSplat(bytes, (row, index) => {
    const id = idFromWirePosition(row.position[0], row.position[1], row.position[2]);
    if (seen[id]) fail(`duplicate exported source ${id}`);
    seen[id] = 1;
    if (id !== index) fail(`export source order: row ${index} contains source ${id}`);
    checkExportAttributes(row, id, covariance, numeric);
    const local = index % BATCH_ROWS, at = local * 68;
    idView.setUint32(local * 4, id, true);
    for (let axis = 0; axis < 3; axis++) decodedView.setFloat32(at + axis * 4, row.position[axis] || 0, true);
    decodedView.setFloat32(at + 12, row.rgba[3] / 255, true);
    for (let component = 0; component < 6; component++) decodedView.setFloat64(at + 16 + component * 8, covariance[component] || 0, true);
    decodedBatch[at + 64] = row.rgba[0]; decodedBatch[at + 65] = row.rgba[1]; decodedBatch[at + 66] = row.rgba[2];
    if (local === BATCH_ROWS - 1 || index === BENCHMARK_RECORD_COUNT - 1) {
      sourceOrderHash.update(idBatch.subarray(0, (local + 1) * 4)); decodedHash.update(decodedBatch.subarray(0, (local + 1) * 68));
    }
  }, BENCHMARK_RECORD_COUNT);
  for (let first = 0; first < BENCHMARK_RECORD_COUNT; first += BATCH_ROWS) {
    const count = Math.min(BATCH_ROWS, BENCHMARK_RECORD_COUNT - first);
    for (let local = 0; local < count; local++) {
      if (!seen[first + local]) fail(`omitted exported source ${first + local}`);
      idView.setUint32(local * 4, first + local, true);
    }
    membershipHash.update(idBatch.subarray(0, count * 4));
  }
  const expected = benchmarkExpectedIdentities(), sourceOrderSha256 = sourceOrderHash.digest('hex'), membershipSha256 = membershipHash.digest('hex');
  if (sourceOrderSha256 !== expected.sourceOrderSha256 || membershipSha256 !== expected.membershipSha256) fail('export membership/order identity differs');
  return { ...expected, encodedSha256: observed.encodedSha256, sourceOrderSha256, membershipSha256,
    validatedSemanticSceneSha256: expected.expectedSceneSha256, decodedAttributeSha256: decodedHash.digest('hex'),
    numeric: { policyId: 'ply-splat-numeric-v1', linearScalePolicy: 'dyadic-grid-linear-scales-v1', exactRgba: true, ...numeric } };
}
