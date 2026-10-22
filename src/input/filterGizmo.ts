import type { FilterGizmoConfig, FilterGizmoFrame, FilterGizmoPose, FilterGizmoPrimitive, FilterGizmoSession } from '../document/filterGizmo';

export type FilterGizmoModule = {
  HEAPF32: Float32Array<ArrayBuffer>;
  _malloc(bytes: number): number; _free(pointer: number): void;
  _sv_camera_filter_gizmo_frame(input: number, output: number): number;
  _sv_camera_filter_gizmo_begin(input: number, handle: number, output: number): number;
  _sv_camera_filter_gizmo_update(state: number, pointer: number, output: number): number;
};
// Fixed ABI buffers shared by display, hit tests and immutable drag replay.
// All geometric operations belong to browser_filter_gizmo.cpp in the camera WASM.
export const FILTER_GIZMO_SCRATCH_FLOATS = 6319;
const INPUT = 0, FRAME = 58, STATE = 6206, POINTER = 6302, POSE = 6305;
const shape = { sphere: 1, box: 2, ellipsoid: 3, frustum: 4 } as const;
const operation = { move: 0, rotate: 1, scale: 2 } as const;
function finite(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)))
    throw new Error('Invalid filter gizmo value.');
  return Math.fround(value);
}
function vector(value: readonly number[], count: number): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== count || Reflect.ownKeys(value).length !== count + 1)
    throw new Error('Invalid filter gizmo vector.');
  return Array.from({ length: count }, (_, at) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(at));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid filter gizmo vector.');
    return finite(descriptor.value);
  });
}
function flag(value: boolean) {
  if (typeof value !== 'boolean') throw new Error('Invalid filter gizmo option.');
  return Number(value);
}
function input(config: FilterGizmoConfig, camera: { view: Float32Array; projection: Float32Array }): number[] {
  if (!Object.hasOwn(shape, config.kind) || !Object.hasOwn(operation, config.mode)) throw new Error('Invalid filter gizmo operation.');
  const viewport = config.viewport, pose = config.parameters;
  return [...Array.from(camera.view, finite), ...Array.from(camera.projection, finite),
    finite(viewport.x), finite(viewport.y), finite(viewport.width), finite(viewport.height), finite(config.panelScale),
    shape[config.kind as keyof typeof shape], operation[config.mode], flag(config.local), flag(config.snap), flag(config.showVolume),
    ...vector(config.pointer, 2), ...vector(pose.center, 3), ...vector(pose.size, 3), ...vector(pose.rotation, 3),
    finite(pose.radius), finite(pose.fov), finite(pose.aspect), finite(pose.near), finite(pose.far)];
}
function allowedHandle(mode: number, handle: number) {
  return Number.isInteger(handle) && (mode === 0 ? handle >= 1 && handle <= 7 : mode === 1 ? handle >= 8 && handle <= 11 : handle >= 12 && handle <= 15);
}
export class FilterGizmoMath {
  private scratch = 0;
  private disposed = false;
  private sessions = new WeakMap<FilterGizmoSession, { state: readonly number[]; revision: number }>();
  private active?: FilterGizmoSession;
  constructor(private module: FilterGizmoModule, private camera: () => { view: Float32Array; projection: Float32Array; revision: number }) {}
  private address(offset: number) {
    if (this.disposed) throw new Error('The camera has been disposed.');
    if (!this.scratch) {
      this.scratch = this.module._malloc(FILTER_GIZMO_SCRATCH_FLOATS * 4);
      if (!this.scratch) throw new Error('There is not enough memory for the filter gizmo.');
    }
    return this.scratch + offset * 4;
  }
  private write(offset: number, values: readonly number[]) {
    const pointer = this.address(offset); this.module.HEAPF32.set(values, pointer / 4); return pointer;
  }
  private read(offset: number, count: number): number[] {
    const at = this.address(offset) / 4;
    const values = Array.from(this.module.HEAPF32.subarray(at, at + count));
    if (values.length !== count || values.some(value => !Number.isFinite(value))) throw new Error('The filter gizmo returned invalid output.');
    return values;
  }
  frame(config: FilterGizmoConfig): FilterGizmoFrame | null {
    const packed = input(config, this.camera());
    if (this.module._sv_camera_filter_gizmo_frame(this.write(INPUT, packed), this.address(FRAME)) !== 1) return null;
    const [count, hitHandle, x, y] = this.read(FRAME, 4);
    if (!Number.isInteger(count) || count < 0 || count > 512 || hitHandle !== 0 && !allowedHandle(packed[38], hitHandle))
      throw new Error('The filter gizmo returned invalid handles.');
    const values = this.read(FRAME + 4, count * 12), primitives: FilterGizmoPrimitive[] = [];
    for (let at = 0; at < values.length; at += 12) {
      const [handle, role, type] = values.slice(at, at + 3), weight = values[at + 11];
      if (!Number.isInteger(role) || role < 0 || role > 4 || !Number.isInteger(type) || type < 0 || type > 3 ||
          !Number.isInteger(handle) || handle !== 0 && !allowedHandle(packed[38], handle) || weight <= 0 ||
          (type === 1 || type === 2) && values[at + 5] <= 0)
        throw new Error('The filter gizmo returned invalid drawing data.');
      primitives.push(Object.freeze({ handle, role: role as FilterGizmoPrimitive['role'], type: type as FilterGizmoPrimitive['type'],
        points: Object.freeze(values.slice(at + 3, at + 11)) as FilterGizmoPrimitive['points'], weight }));
    }
    if (hitHandle && !primitives.some(primitive => primitive.handle === hitHandle)) throw new Error('The filter gizmo returned an undrawn handle.');
    return Object.freeze({ primitives: Object.freeze(primitives), hitHandle, center: Object.freeze([x, y]) as readonly [number, number] });
  }
  begin(config: FilterGizmoConfig, handle: number): FilterGizmoSession | null {
    if (this.active) return null;
    const camera = this.camera(), packed = input(config, camera);
    if (!allowedHandle(packed[38], handle) || config.kind === 'frustum' && config.mode === 'scale') return null;
    if (this.module._sv_camera_filter_gizmo_begin(this.write(INPUT, packed), handle, this.address(STATE)) !== 1) return null;
    const state = Object.freeze(this.read(STATE, 96));
    if (state[0] !== 104729 || state[1] !== 1 || state[2] !== handle || state.slice(61).some(value => value !== 0) ||
        state.slice(3, 61).some((value, at) => value !== packed[at])) throw new Error('The filter gizmo returned invalid drag ownership.');
    const session = Object.freeze({}) as FilterGizmoSession;
    this.sessions.set(session, { state, revision: camera.revision }); this.active = session; return session;
  }
  update(session: FilterGizmoSession, pointer: readonly [number, number], ctrl: boolean): FilterGizmoPose | null {
    const owner = this.sessions.get(session);
    if (!owner || this.disposed || this.active !== session) return null;
    if (this.camera().revision !== owner.revision) { this.end(session); return null; }
    const point = [...vector(pointer, 2), flag(ctrl)];
    if (this.module._sv_camera_filter_gizmo_update(this.write(STATE, owner.state), this.write(POINTER, point), this.address(POSE)) !== 1) return null;
    const values = this.read(POSE, 14);
    const kind = owner.state[40];
    if (values.slice(10).some((value, at) => value !== owner.state[57 + at]) ||
        kind === 1 && (values[9] < 0 || values.slice(3, 6).some((value, at) => value !== owner.state[50 + at])) ||
        (kind === 2 || kind === 3) && (values.slice(3, 6).some(value => kind === 2 ? value < 0 : value <= 0) || values[9] !== owner.state[56]) ||
        kind === 4 && (values.slice(3, 6).some((value, at) => value !== owner.state[50 + at]) || values[9] !== owner.state[56]))
      throw new Error('The filter gizmo returned invalid filter parameters.');
    return { center: values.slice(0, 3) as [number, number, number], size: values.slice(3, 6) as [number, number, number],
      rotation: values.slice(6, 9) as [number, number, number], radius: values[9] };
  }
  end(session: FilterGizmoSession) { this.sessions.delete(session); if (this.active === session) this.active = undefined; }
  dispose() {
    if (this.disposed) return;
    if (this.active) this.end(this.active);
    if (this.scratch) this.module._free(this.scratch);
    this.scratch = 0; this.disposed = true;
  }
}
