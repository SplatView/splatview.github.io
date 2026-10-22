export type FloorVec3 = readonly [number, number, number];
export type FloorPlane = Readonly<{
  normal: FloorVec3; center: FloorVec3; radius: number; rms: number; inliers: number; tested: number;
}>;
export type FloorPendingStage = 'sampling' | 'threshold' | 'ransac' | 'refine';
export type FloorStage = FloorPendingStage | 'complete';
type FloorIdentity = Readonly<{ version: 1; id: number; selectedOnly: boolean }>;
export type FloorSummary = FloorIdentity & (
  | Readonly<{ status: 'pending'; stage: FloorPendingStage; plane: null }>
  | Readonly<{ status: 'ready'; stage: 'complete'; plane: FloorPlane }>
  | Readonly<{ status: 'none'; stage: 'complete'; plane: null }>
);
export type FloorSummaryContext = Readonly<{ loadedCount: number; pending: boolean }>;

export const MAX_FLOOR_TESTED_POINTS = 50_000;
// The captured detector casts its double unit vector to float32. This admits
// that rounding; it does not assert full-precision or full-domain equivalence.
export const FLOOR_NORMAL_TOLERANCE = 1e-4;
const summaryFields = ['version', 'id', 'status', 'stage', 'selectedOnly', 'plane'] as const;
const planeFields = ['normal', 'center', 'radius', 'rms', 'inliers', 'tested'] as const;
const contextFields = ['loadedCount', 'pending'] as const;
const pendingStages: readonly FloorPendingStage[] = ['sampling', 'threshold', 'ransac', 'refine'];

function invalid(label: string): never { throw new Error(`Invalid native floor ${label}.`); }

function fields(value: unknown, names: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(label);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== 'string' || !names.includes(key))) invalid(label);
  const result: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid(label);
    result[name] = descriptor.value;
  }
  return result;
}

function float32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(label);
  const result = Math.fround(value);
  if (!Number.isFinite(result) || (value !== 0 && result === 0)) invalid(label);
  return result;
}

function vector(value: unknown, label: string): FloorVec3 {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 3 ||
      Reflect.ownKeys(value).length !== 4) invalid(label);
  const result = Array.from({ length: 3 }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) invalid(label);
    return float32(descriptor.value, label);
  });
  return Object.freeze(result) as unknown as FloorVec3;
}

function plane(value: unknown, loadedCount: number): FloorPlane {
  const data = fields(value, planeFields, 'plane');
  const normal = vector(data.normal, 'normal'), center = vector(data.center, 'center');
  const norm = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
  if (Math.abs(norm - 1) > FLOOR_NORMAL_TOLERANCE) invalid('unit normal');
  const radius = float32(data.radius, 'radius'), rms = float32(data.rms, 'rms');
  if (radius <= 0 || rms < 0) invalid('radius or error');
  if (typeof data.inliers !== 'number' || !Number.isSafeInteger(data.inliers) || data.inliers < 3 ||
      typeof data.tested !== 'number' || !Number.isSafeInteger(data.tested) || data.tested < data.inliers ||
      data.tested > Math.min(MAX_FLOOR_TESTED_POINTS, loadedCount)) invalid('support counts');
  return Object.freeze({ normal, center, radius, rms, inliers: data.inliers, tested: data.tested });
}

/** Parse candidate metadata only; its response envelope owns admission and publication. */
export function validateFloorSummary(value: unknown, context: FloorSummaryContext): FloorSummary | null {
  const owner = fields(context, contextFields, 'summary context');
  if (typeof owner.loadedCount !== 'number' || !Number.isSafeInteger(owner.loadedCount) || owner.loadedCount < 0 ||
      typeof owner.pending !== 'boolean') invalid('summary context');
  if (value === null) return null;
  const data = fields(value, summaryFields, 'metadata');
  if (data.version !== 1 || typeof data.id !== 'number' || !Number.isSafeInteger(data.id) || data.id <= 0 ||
      typeof data.selectedOnly !== 'boolean') invalid('identity');
  const identity = { version: 1 as const, id: data.id, selectedOnly: data.selectedOnly };
  if (data.status === 'pending') {
    if (!owner.pending || !pendingStages.includes(data.stage as FloorPendingStage) || data.plane !== null) invalid('pending state');
    return Object.freeze({ ...identity, status: 'pending', stage: data.stage as FloorPendingStage, plane: null });
  }
  if (data.stage !== 'complete') invalid('terminal stage');
  if (data.status === 'ready')
    return Object.freeze({ ...identity, status: 'ready', stage: 'complete', plane: plane(data.plane, owner.loadedCount) });
  if (data.status === 'none' && data.plane === null)
    return Object.freeze({ ...identity, status: 'none', stage: 'complete', plane: null });
  return invalid('terminal state');
}
