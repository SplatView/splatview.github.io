import type { TransformComposition, TransformGizmoConfig, TransformGizmoFrame, TransformGizmoPose, TransformGizmoPrimitive,
  TransformGizmoSession } from '../document/transformGizmo';
import { validateTransformDefinition, validateTransformMatrix, type TransformDefinition, type TransformMatrix } from '../document/transformProtocol';

export type TransformGizmoModule = {
  HEAPF32: Float32Array<ArrayBuffer>;
  _malloc(bytes: number): number; _free(pointer: number): void;
  _sv_camera_transform_compose(input: number, output: number): number;
  _sv_camera_transform_gizmo_frame(input: number, output: number): number;
  _sv_camera_transform_gizmo_begin(input: number, handle: number, output: number): number;
  _sv_camera_transform_gizmo_update(state: number, pointer: number, output: number): number;
};
// Immutable native state is detached between calls; no live allocation per drag.
export const TRANSFORM_GIZMO_SCRATCH_FLOATS = 6388;
const INPUT = 0, FRAME = 61, STATE = 6209, POINTER = 6337, POSE = 6340;
const operation = { move: 0, rotate: 1, scale: 2 } as const;
const modes = { euler: 0, quaternion: 1, 'axis-angle': 2, matrix: 3 } as const;
function finite(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new Error('Invalid transform gizmo value.');
  return Math.fround(value);
}
function vector(value: readonly number[], count: number): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== count || Reflect.ownKeys(value).length !== count + 1)
    throw new Error('Invalid transform gizmo vector.');
  return Array.from({ length: count }, (_, at) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(at));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid transform gizmo vector.');
    return finite(descriptor.value);
  });
}
function flag(value: boolean) {
  if (typeof value !== 'boolean') throw new Error('Invalid transform gizmo option.');
  return Number(value);
}
function input(config: TransformGizmoConfig, camera: { view: Float32Array; projection: Float32Array }): number[] {
  if (!Object.hasOwn(operation, config.mode) || camera.view.length !== 16 || camera.projection.length !== 16)
    throw new Error('Invalid transform gizmo operation.');
  const viewport = config.viewport;
  return [...Array.from(camera.view, finite), ...Array.from(camera.projection, finite),
    finite(viewport.x), finite(viewport.y), finite(viewport.width), finite(viewport.height), finite(config.panelScale),
    operation[config.mode], flag(config.local), flag(config.snap), ...vector(config.pointer, 2),
    ...vector(config.pivot, 3), ...vector(config.widgetMatrix, 16)];
}
function allowedHandle(mode: number, handle: number) {
  return Number.isInteger(handle) && (mode === 0 ? handle >= 1 && handle <= 7 : mode === 1 ? handle >= 8 && handle <= 11 : handle >= 12 && handle <= 15);
}
export class TransformGizmoMath {
  private scratch = 0;
  private disposed = false;
  private sessions = new WeakMap<TransformGizmoSession, { state: readonly number[]; revision: number }>();
  private active?: TransformGizmoSession;
  constructor(private module: TransformGizmoModule, private camera: () => { view: Float32Array; projection: Float32Array; revision: number }) {}
  private address(offset: number) {
    if (this.disposed) throw new Error('The camera has been disposed.');
    if (!this.scratch) {
      this.scratch = this.module._malloc(TRANSFORM_GIZMO_SCRATCH_FLOATS * 4);
      if (!this.scratch) throw new Error('There is not enough memory for the transform gizmo.');
    }
    return this.scratch + offset * 4;
  }
  private write(offset: number, values: readonly number[]) {
    const pointer = this.address(offset); this.module.HEAPF32.set(values, pointer / 4); return pointer;
  }
  private read(offset: number, count: number): number[] {
    const at = this.address(offset) / 4;
    const values = Array.from(this.module.HEAPF32.subarray(at, at + count));
    if (values.length !== count || values.some(value => !Number.isFinite(value))) throw new Error('The transform gizmo returned invalid output.');
    return values;
  }
  compose(definition: TransformDefinition): TransformComposition | null {
    const checked = validateTransformDefinition(definition);if (!checked) return null;
    // Serialization only: all Euler/quaternion/pivot/flip/matrix arithmetic is native.
    const packed = new Array<number>(40).fill(0);
    packed[0] = modes[checked.mode];packed.splice(4, 3, 1, 1, 1);
    packed[13] = 1;packed[19] = 1;
    for (const at of [21, 26, 31, 36]) packed[at] = 1;
    packed.splice(7, 3, ...checked.pivot);packed.splice(37, 3, ...checked.flips.map(Number));
    if (checked.mode === 'matrix') packed.splice(21, 16, ...checked.matrix);
    else {
      packed.splice(1, 3, ...checked.translation);packed.splice(4, 3, ...checked.scale);
      if (checked.mode === 'euler') packed.splice(10, 3, ...checked.euler);
      else if (checked.mode === 'quaternion') packed.splice(13, 4, ...checked.quaternion);
      else { packed.splice(17, 3, ...checked.axis);packed[20] = checked.angle; }
    }
    if (this.module._sv_camera_transform_compose(this.write(INPUT, packed), this.address(FRAME)) !== 1) return null;
    const matrix = validateTransformMatrix(this.read(FRAME, 16));
    if (!matrix) throw new Error('The native transform composition is invalid.');
    return { matrix, pivot: [...checked.pivot] };
  }
  frame(config: TransformGizmoConfig): TransformGizmoFrame | null {
    const packed = input(config, this.camera());
    if (this.module._sv_camera_transform_gizmo_frame(this.write(INPUT, packed), this.address(FRAME)) !== 1) return null;
    const [count, hitHandle, x, y] = this.read(FRAME, 4);
    if (!Number.isInteger(count) || count < 0 || count > 512 || hitHandle !== 0 && !allowedHandle(packed[37], hitHandle))
      throw new Error('The transform gizmo returned invalid handles.');
    const values = this.read(FRAME + 4, count * 12), primitives: TransformGizmoPrimitive[] = [];
    for (let at = 0; at < values.length; at += 12) {
      const [handle, role, type] = values.slice(at, at + 3), weight = values[at + 11];
      if (!Number.isInteger(role) || role < 0 || role > 3 || !Number.isInteger(type) || type < 0 || type > 3 ||
          !allowedHandle(packed[37], handle) || weight <= 0 ||
          (type === 1 || type === 2) && values[at + 5] <= 0)
        throw new Error('The transform gizmo returned invalid drawing data.');
      primitives.push(Object.freeze({ handle, role: role as TransformGizmoPrimitive['role'], type: type as TransformGizmoPrimitive['type'],
        points: Object.freeze(values.slice(at + 3, at + 11)) as TransformGizmoPrimitive['points'], weight }));
    }
    if (hitHandle && !primitives.some(primitive => primitive.handle === hitHandle)) throw new Error('The transform gizmo returned an undrawn handle.');
    return Object.freeze({ primitives: Object.freeze(primitives), hitHandle, center: Object.freeze([x, y]) as readonly [number, number] });
  }
  begin(config: TransformGizmoConfig, handle: number): TransformGizmoSession | null {
    if (this.active) return null;
    const camera = this.camera(), packed = input(config, camera);
    if (!allowedHandle(packed[37], handle)) return null;
    if (this.module._sv_camera_transform_gizmo_begin(this.write(INPUT, packed), handle, this.address(STATE)) !== 1) return null;
    const state = Object.freeze(this.read(STATE, 128));
    if (state[0] !== 104731 || state[1] !== 1 || state[2] !== handle || state.slice(64).some(value => value !== 0) ||
        state.slice(3, 64).some((value, at) => value !== packed[at])) throw new Error('The transform gizmo returned invalid drag ownership.');
    const session = Object.freeze({}) as TransformGizmoSession;
    this.sessions.set(session, { state, revision: camera.revision });this.active = session;return session;
  }
  update(session: TransformGizmoSession, pointer: readonly [number, number], ctrl: boolean): TransformGizmoPose | null {
    const owner = this.sessions.get(session);
    if (!owner || this.disposed || this.active !== session) return null;
    if (this.camera().revision !== owner.revision) { this.end(session);return null; }
    const point = [...vector(pointer, 2), flag(ctrl)];
    if (this.module._sv_camera_transform_gizmo_update(this.write(STATE, owner.state), this.write(POINTER, point), this.address(POSE)) !== 1) return null;
    const values = this.read(POSE, 48), widgetMatrix = validateTransformMatrix(values.slice(0, 16)),
      deltaMatrix = validateTransformMatrix(values.slice(16, 32)), rowMajorDelta = values.slice(32, 48) as TransformMatrix;
    if (!widgetMatrix || !deltaMatrix || rowMajorDelta[12] !== 0 || rowMajorDelta[13] !== 0 || rowMajorDelta[14] !== 0 || rowMajorDelta[15] !== 1)
      throw new Error('The transform gizmo returned invalid matrices.');
    // Validate the native dual representation without composing or converting it.
    for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++)
      if (rowMajorDelta[row * 4 + column] !== deltaMatrix[column * 4 + row])
        throw new Error('The transform gizmo returned inconsistent delta matrices.');
    return { widgetMatrix, deltaMatrix, rowMajorDelta };
  }
  end(session: TransformGizmoSession) { this.sessions.delete(session);if (this.active === session) this.active = undefined; }
  dispose() {
    if (this.disposed) return;
    if (this.active) this.end(this.active);
    if (this.scratch) this.module._free(this.scratch);
    this.scratch = 0;this.disposed = true;
  }
}
