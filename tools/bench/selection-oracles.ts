import { createHash } from 'node:crypto';
import { scanRawSplat, assertBenchmarkSplatExportRecord, benchmarkExpectedIdentities } from './oracles.ts';

// Original independent analytic selection expectations. No fixture generator,
// application/native selector, camera, projection or production math is used.
// The imported parser/attribute oracle is independently authored test tooling.
const COUNT = 256_000;
const FIXTURE_ID = 'dyadic-grid-256k-sh0-v1';
export const SELECTION_ORACLE_ID = 'dyadic-grid-selection-v1';
export type SelectionCombine = 0 | 1 | 2 | 3;
export type SelectionBaseline = 'none' | 'all' | 'red' | 'central-box' | 'grid-only' | 'central-box-right-anchor-deleted';
export type AnalyticSelectionQuery = 'sphere-left-anchor' | 'sphere-right-anchor' | 'sphere-bottom-anchor' | 'central-box' | 'ordinary-red-low' | 'ordinary-red-high';
export type SelectionExportScope = 'all' | 'selected' | 'remainder';
const CAMERA = Object.freeze([0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6]);
const FRAMEBUFFER = Object.freeze({ width: 1280, height: 800, dpr: 1 });
const BASELINES: readonly SelectionBaseline[] = ['none', 'all', 'red', 'central-box', 'grid-only', 'central-box-right-anchor-deleted'];
const QUERIES: readonly AnalyticSelectionQuery[] = ['sphere-left-anchor', 'sphere-right-anchor', 'sphere-bottom-anchor', 'central-box', 'ordinary-red-low', 'ordinary-red-high'];
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const failure = (message: string): never => { throw new Error(`Selection oracle: ${message}`); };
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

export interface SelectionMaskIdentity {
  count: number; selectedCount: number; deletedCount: number; visibleCount: number;
  stateMaskSha256: string; selectedMembershipSha256: string; deletedMembershipSha256: string; visibleMembershipSha256: string;
}

/** Sorted object keys, original array order, JSON numbers, no whitespace/LF. */
export function selectionParameterBytes(value: unknown): Uint8Array {
  const ancestors = new Set<object>();
  const serialize = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item);
    if (!item || typeof item !== 'object' || ancestors.has(item)) return failure('parameters must be finite acyclic plain JSON data');
    ancestors.add(item);
    try {
      if (Array.isArray(item)) {
        if (item.length > 65536 || Reflect.ownKeys(item).length !== item.length + 1) return failure('parameter arrays must be complete and bounded');
        const values: string[] = [];
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property?.enumerable || !('value' in property)) return failure('parameter arrays must be complete data without accessors');
          values.push(serialize(property.value));
        }
        return '[' + values.join(',') + ']';
      }
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) return failure('parameters must be plain JSON data');
      if (Reflect.ownKeys(item).length !== Object.keys(item).length) return failure('parameter keys must be enumerable strings');
      const entries: string[] = [];
      for (const key of Object.keys(item).sort()) {
        const property = Object.getOwnPropertyDescriptor(item, key)!;
        if (!('value' in property)) return failure('parameter accessors are forbidden');
        entries.push(JSON.stringify(key) + ':' + serialize(property.value));
      }
      return '{' + entries.join(',') + '}';
    } finally { ancestors.delete(item); }
  };
  return new TextEncoder().encode(serialize(value));
}

function mask(value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.byteLength !== COUNT) failure('a complete 256000-byte source-state mask is required');
  for (let id = 0; id < COUNT; id++) if (value[id] > 2) failure(`source ${id} has an invalid selected/deleted state`);
}
function combine(value: number): asserts value is SelectionCombine {
  if (!Number.isInteger(value) || value < 0 || value > 3) failure('Combine must be Set0, Add1, Remove2 or Intersect3');
}
function central(id: number): boolean {
  if (id < 3) return false;
  const x = id % 64, y = Math.floor(id / 64) % 50, z = Math.floor(id / 3200);
  // |RUB x/y/z| <= 1. All boundaries are halfway between grid centers,
  // avoiding float thresholds. Box size is full extent, not radii.
  return x >= 16 && x <= 47 && y >= 9 && y <= 40 && z >= 24 && z <= 55;
}

export function selectionBaselineMask(kind: SelectionBaseline): Uint8Array {
  if (!BASELINES.includes(kind)) failure('unknown fixed baseline');
  const result = new Uint8Array(COUNT);
  for (let id = 0; id < COUNT; id++) result[id] = Number(kind === 'all' || kind === 'red' && id % 3 === 0 ||
    kind === 'grid-only' && id >= 3 || (kind === 'central-box' || kind === 'central-box-right-anchor-deleted') && central(id));
  if (kind === 'central-box-right-anchor-deleted') result[1] = 2;
  return result;
}

/** Pure one-source truth table. Deleted sources are never selected or restored. */
export function selectionCombinedState(before: number, inside: boolean, operation: SelectionCombine): number {
  combine(operation);
  if (!Number.isInteger(before) || before < 0 || before > 2 || typeof inside !== 'boolean') failure('invalid source-state truth-table input');
  if (before === 2) return 2;
  const selected = before === 1;
  return Number(operation === 0 ? inside : operation === 1 ? selected || inside : operation === 2 ? selected && !inside : selected && inside);
}

export function expectedSelectionMask(query: AnalyticSelectionQuery, originalBaseline: Uint8Array, operation: SelectionCombine): Uint8Array {
  if (!QUERIES.includes(query)) failure('unknown analytic query');
  mask(originalBaseline); combine(operation);
  const result = new Uint8Array(COUNT);
  for (let id = 0; id < COUNT; id++) {
    const inside = query === 'sphere-left-anchor' ? id === 0 : query === 'sphere-right-anchor' ? id === 1 :
      query === 'sphere-bottom-anchor' ? id === 2 : query === 'central-box' ? central(id) : query === 'ordinary-red-low' ? id % 3 === 0 : true;
    result[id] = selectionCombinedState(originalBaseline[id], inside, operation);
  }
  return result;
}

function idsHash(states: Uint8Array, includes: (state: number) => boolean): string {
  const hash = createHash('sha256'), bytes = new Uint8Array(4096), view = new DataView(bytes.buffer);
  let count = 0;
  for (let id = 0; id < COUNT; id++) if (includes(states[id])) {
    view.setUint32(count * 4, id, true); count++;
    if (count === 1024) { hash.update(bytes); count = 0; }
  }
  if (count) hash.update(bytes.subarray(0, count * 4));
  return hash.digest('hex');
}

export function selectionMaskIdentity(states: Uint8Array): SelectionMaskIdentity {
  mask(states);
  let selectedCount = 0, deletedCount = 0;
  for (const state of states) { if (state === 1) selectedCount++; if (state === 2) deletedCount++; }
  return { count: COUNT, selectedCount, deletedCount, visibleCount: COUNT - deletedCount,
    stateMaskSha256: sha(states), selectedMembershipSha256: idsHash(states, state => state === 1),
    deletedMembershipSha256: idsHash(states, state => state === 2), visibleMembershipSha256: idsHash(states, state => state !== 2) };
}

export function assertSelectionMask(actual: Uint8Array, expected: Uint8Array): SelectionMaskIdentity {
  mask(actual); mask(expected);
  for (let id = 0; id < COUNT; id++) if (actual[id] !== expected[id]) failure(`source ${id} mask mismatch: ${actual[id]} instead of ${expected[id]}`);
  return selectionMaskIdentity(actual);
}

function queryParameters(query: AnalyticSelectionQuery) {
  if (query === 'central-box') return { tool: 'filter', kind: 'box', parameters: { center: [0, 0, 0], size: [2, 2, 2], rotation: [0, 0, 0] } };
  if (query === 'sphere-left-anchor' || query === 'sphere-right-anchor' || query === 'sphere-bottom-anchor') {
    return { tool: 'filter', kind: 'sphere', parameters: { center: query === 'sphere-left-anchor' ? [-8, 0, 0] :
      query === 'sphere-right-anchor' ? [8, 0, 0] : [0, -8, 0], radius: 0.125 } };
  }
  return { tool: 'ordinary-color', index: 0, connected: false, tolerance: query === 'ordinary-red-low' ? 0.25 : 0.95 };
}

/** Analytic candidate only. Actual native/browser/GUI observations must be bound separately. */
export function selectionCase(query: AnalyticSelectionQuery, baseline: SelectionBaseline = 'none', operation: SelectionCombine = 0) {
  const states = selectionBaselineMask(baseline), baselineIdentity = selectionMaskIdentity(states);
  const expected = selectionMaskIdentity(expectedSelectionMask(query, states, operation));
  const fixture = benchmarkExpectedIdentities();
  const parameters = { schemaVersion: 1, oracleId: SELECTION_ORACLE_ID, fixtureId: FIXTURE_ID,
    fixtureInputSha256: fixture.inputSha256, fixtureCanonicalSceneSha256: fixture.expectedSceneSha256, queryId: query,
    originalBaseline: { id: baseline, stateMaskSha256: baselineIdentity.stateMaskSha256 }, operation,
    camera: [...CAMERA], framebuffer: { ...FRAMEBUFFER }, options: { visibleOnly: false, overlap: false, connected: false },
    query: queryParameters(query), opaqueIdentityPolicy: 'Capture fresh runtime filter/session IDs in observations; these do not change analytic membership.' };
  return frozen({ schemaVersion: 1, kind: 'splatview-analytic-selection-candidate', status: 'pending-actual-comparison',
    parameters, parametersSha256: sha(selectionParameterBytes(parameters)), expected,
    serialization: { stateMask: 'Exactly 256000 bytes in source ID order: 0 unselected, 1 selected, 2 deleted.',
      membership: 'Ascending original source IDs encoded uint32 little-endian without a prefix.',
      parameters: 'UTF-8 JSON with recursively sorted object keys, original array order, no whitespace or LF.' },
    qualification: { actualNative: false, actualBrowser: false, gpuContributor: 'not-established', performanceAccepted: false } });
}

/** Every amendment is independently combined against the SAME original mask. */
export function expectedOrdinaryColorAmendments(baseline: SelectionBaseline, operation: SelectionCombine) {
  return frozen({ status: 'pending-actual-session-comparison', originalBaseline: selectionMaskIdentity(selectionBaselineMask(baseline)), operation,
    initial: selectionCase('ordinary-red-low', baseline, operation),
    widened: selectionCase('ordinary-red-high', baseline, operation),
    narrowed: selectionCase('ordinary-red-low', baseline, operation),
    historyExpectation: 'One completed Color checkpoint; one Undo restores the original baseline; Redo restores the final narrowed mask.',
    limitation: 'Ordinary unconnected Color only; Connected Color and Fill need actual composited-map/flood oracles.' });
}

function sourceFromPosition(x: number, y: number, z: number): number {
  if (x === -8 && y === 0 && z === 0) return 0;
  if (x === 8 && y === 0 && z === 0) return 1;
  if (x === 0 && y === 8 && z === 0) return 2;
  const gx = (x * 32 + 63) / 2, gy = (y * 32 + 49) / 2, gz = (z * 32 + 79) / 2;
  if (![gx, gy, gz].every(Number.isInteger) || gx < 0 || gx > 63 || gy < 0 || gy > 49 || gz < 0 || gz > 79) return failure('export has an unknown position/member');
  const id = gx + gy * 64 + gz * 3200;
  if (id < 3) return failure('export resurrected a replaced grid position');
  return id;
}

/** Full independent attribute and exact source membership/order check for a subset export. */
export function validateSelectionExport(bytes: Uint8Array, expectedStates: Uint8Array, scope: SelectionExportScope) {
  mask(expectedStates);
  if (!['all', 'selected', 'remainder'].includes(scope)) failure('unknown export scope');
  const includes = (state: number) => scope === 'all' ? state !== 2 : scope === 'selected' ? state === 1 : state === 0;
  let expectedCount = 0;
  for (const state of expectedStates) if (includes(state)) expectedCount++;
  if (!expectedCount) failure('expected scope is empty; observe the actual export refusal separately');
  if (bytes.byteLength !== expectedCount * 32) failure('export length/count does not match its complete expected scope');
  const zero = () => ({ maxAbsoluteError: 0, maxNormalizedError: 0, worstRecord: null as number | null, worstComponent: null as number | null });
  const numeric = { covariance: zero(), opacity: zero(), color: zero(), linearScales: zero() };
  const ids = new Uint8Array(4096), view = new DataView(ids.buffer), hash = createHash('sha256');
  let previous = -1, buffered = 0;
  const parsed = scanRawSplat(bytes, row => {
    const id = sourceFromPosition(row.position[0], row.position[1], row.position[2]);
    if (id <= previous) failure(`export reordered or duplicated source ${id}`);
    if (!includes(expectedStates[id])) failure(`export includes source ${id} outside its expected scope`);
    assertBenchmarkSplatExportRecord(row, id, numeric);
    previous = id; view.setUint32(buffered++ * 4, id, true);
    if (buffered === 1024) { hash.update(ids); buffered = 0; }
  }, COUNT);
  if (buffered) hash.update(ids.subarray(0, buffered * 4));
  const sourceOrderSha256 = hash.digest('hex'), expectedMembershipSha256 = idsHash(expectedStates, includes);
  if (sourceOrderSha256 !== expectedMembershipSha256) failure('export membership/order differs from the independent source mask');
  return { count: parsed.count, encodedSha256: parsed.encodedSha256, scope, sourceOrderSha256,
    membershipSha256: sourceOrderSha256, expectedMembershipSha256, numeric: { policyId: 'ply-splat-numeric-v1',
      linearScalePolicy: 'dyadic-grid-linear-scales-v1', exactRgba: true, ...numeric } };
}

/**
 * A separated-contributor proposal, NOT a measured GPU picking oracle. The
 * proof includes full projected covariance/support, rather than center hits.
 * Actual shader contributor/readback comparisons remain a required next gate.
 */
export function anchorPickProposal(id: 0 | 1 | 2) {
  if (id !== 0 && id !== 1 && id !== 2) failure('only three isolated anchors have this projection proof');
  const focal = 400 * (1 + Math.SQRT2), x = id === 0 ? -8 : id === 1 ? 8 : 0, y = id === 2 ? -8 : 0;
  const center = [640 + focal * x / 24, 400 - focal * y / 24];
  const pixel = id === 0 ? [318, 400] : id === 1 ? [961, 400] : [640, 721];
  const a = (focal / 24) ** 2 * 2 ** -20 + (focal * x / 24 ** 2) ** 2 * 2 ** -16 + 0.3;
  const c = (focal / 24) ** 2 * 2 ** -18 + (focal * y / 24 ** 2) ** 2 * 2 ** -16 + 0.3;
  const dx = pixel[0] + 0.5 - center[0], dy = pixel[1] + 0.5 - center[1];
  const mahalanobisSquared = dx * dx / a + dy * dy / c, idealAlpha = Math.min(0.99, Math.exp(-mahalanobisSquared / 2));
  const fixture = benchmarkExpectedIdentities();
  const parameters = { schemaVersion: 1, oracleId: SELECTION_ORACLE_ID, fixtureId: FIXTURE_ID,
    fixtureInputSha256: fixture.inputSha256, fixtureCanonicalSceneSha256: fixture.expectedSceneSha256,
    camera: [...CAMERA], framebuffer: { ...FRAMEBUFFER }, pixel, pixelSample: [pixel[0] + 0.5, pixel[1] + 0.5],
    centerRadius: 0, baselineMaskSha256: selectionMaskIdentity(selectionBaselineMask('none')).stateMaskSha256,
    options: { deleted: false, geometryTransform: 'identity', opacityScale: 1, grade: 'neutral' } };
  return frozen({ status: 'pending-actual-gpu-comparison', expectedSourceId: id, parameters, parametersSha256: sha(selectionParameterBytes(parameters)),
    analytic: { focal, center, projectedCovariance: [a, 0, c], mahalanobisSquared, idealAlpha,
      depth: 24, opacityCutoff: 1 / 255, supportSquared: 9,
      separationProof: {
        gridDepth: [21.53125, 26.46875], gridCenterBounds: [548, 326, 732, 474],
        conservativeGridSupportBounds: [544, 322, 736, 478], supportPaddingPixels: 4,
        basis: 'All grid |x|<2, |y|<1.6, depth>21, focal<966; covariance uses dyadic axis variances and +0.3 low-pass. Trace<0.62 bounds both 3-sigma axes below2.37px; their coordinate extent sum is below4px. Other anchors are separated by hundreds of pixels.',
      } },
    qualification: { actualGpu: false, numericAcceptanceBound: null, cacheIdentityObserved: false, overdrawMeasured: false,
      limitation: 'Do not infer general contributor ordering, overlapping picks, Connected Color, Fill or browser correctness from this candidate.' } });
}
