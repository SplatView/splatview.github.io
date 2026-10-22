import type { ModuleFactory } from '../workers/wasm';
import { navigationKey } from './navigation';
import { nextBackground, type BackgroundColor } from './background';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import { ensureRuntime, runtimeNativeSource } from '../build/runtime';
import { instantiateVerifiedModule, nativeModuleIdentity } from '../build/native';
import { validateAlignmentFrame, validateAlignmentMatrix, type AlignmentCameraPolicy, type AlignmentCameraState, type AlignmentFrame } from '../document/alignment';
import type { SelectionFilterParameters } from '../document/filterProtocol';
import type { FilterGizmoConfig, FilterGizmoSession } from '../document/filterGizmo';
import { FilterGizmoMath } from './filterGizmo';
import { TransformGizmoMath } from './transformGizmo';
import type { TransformDefinition } from '../document/transformProtocol';
import type { TransformGizmoConfig, TransformGizmoSession } from '../document/transformGizmo';
export type { FilterGizmoConfig, FilterGizmoFrame, FilterGizmoPrimitive, FilterGizmoSession } from '../document/filterGizmo';
export type { TransformComposition, TransformGizmoConfig, TransformGizmoFrame, TransformGizmoPose,
  TransformGizmoPrimitive, TransformGizmoSession } from '../document/transformGizmo';

export type CameraModule = {
  HEAPF32: Float32Array<ArrayBuffer>;
  _malloc(size: number): number; _free(pointer: number): void;
  _sv_camera(pointer: number, action: number, a: number, b: number, c: number): void;
  _sv_camera_transform(input: number, frame: number, output: number, policy: number): number;
  _sv_camera_frame_change(before: number, after: number, output: number): number;
  _sv_camera_orientation_change(before: number, after: number, output: number): number;
  _sv_camera_filter_view(input: number, output: number): number;
  _sv_camera_filter_gizmo_frame(input: number, output: number): number;
  _sv_camera_filter_gizmo_begin(input: number, handle: number, output: number): number;
  _sv_camera_filter_gizmo_update(state: number, pointer: number, output: number): number;
  _sv_camera_transform_compose(input: number, output: number): number;
  _sv_camera_transform_gizmo_frame(input: number, output: number): number;
  _sv_camera_transform_gizmo_begin(input: number, handle: number, output: number): number;
  _sv_camera_transform_gizmo_update(state: number, pointer: number, output: number): number;
  _sv_camera_abi_version(): number;
  _sv_camera_build_identity(): number;
  UTF8ToString(pointer: number): string;
  _sv_camera_input_create(): number;
  _sv_camera_input_delete(input: number): void;
  _sv_camera_input(input: number, pointer: number, action: number, a: number, b: number, c: number): void;
  _sv_camera_input_active(input: number): number;
  _sv_camera_tick(input: number, pointer: number, fly: number, seconds: number): number;
};
export class CameraController {
  private pointer: number;
  private input: number;
  private transformPointer: number;
  private disposed = false;
  private values = new Float32Array(46);
  private filterGizmos: FilterGizmoMath;
  private transformGizmos: TransformGizmoMath;
  revision = 0;
  // Display state is deliberately outside camera ABI and its view revision.
  // Changing this must preserve raw surface queries and selection owners.
  background: BackgroundColor = 'black';
  private constructor(private module: CameraModule) {
    if (module._sv_camera_abi_version?.() !== 4 || typeof module._sv_camera_transform !== 'function' ||
        typeof module._sv_camera_frame_change !== 'function' || typeof module._sv_camera_orientation_change !== 'function' ||
        typeof module._sv_camera_filter_view !== 'function' || typeof module._sv_camera_filter_gizmo_frame !== 'function' ||
        typeof module._sv_camera_filter_gizmo_begin !== 'function' || typeof module._sv_camera_filter_gizmo_update !== 'function' ||
        typeof module._sv_camera_transform_compose !== 'function' || typeof module._sv_camera_transform_gizmo_frame !== 'function' ||
        typeof module._sv_camera_transform_gizmo_begin !== 'function' || typeof module._sv_camera_transform_gizmo_update !== 'function')
      throw new Error('The camera core is out of date. Reload SplatView.');
    nativeModuleIdentity(module, BUILD_DESCRIPTOR.native.camera);
    this.pointer = module._malloc(46 * 4);
    if (!this.pointer) throw new Error('There is not enough memory for the camera.');
    this.input = module._sv_camera_input_create();
    if (!this.input) { module._free(this.pointer); throw new Error('There is not enough memory for camera input.'); }
    this.transformPointer = module._malloc((11 + 16 + 46) * 4);
    if (!this.transformPointer) {
      module._sv_camera_input_delete(this.input); module._free(this.pointer);
      throw new Error('There is not enough memory for camera transforms.');
    }
    this.filterGizmos = new FilterGizmoMath(module, () => ({ view: this.view, projection: this.projection, revision: this.revision }));
    this.transformGizmos = new TransformGizmoMath(module, () => ({ view: this.view, projection: this.projection, revision: this.revision }));
    this.set([0, 0, 0, .35, .18, 3, 1, 45, 0, 0, 1]);
  }
  static async create(factory?: ModuleFactory<CameraModule>) {
    if (!factory) {
      const context = await ensureRuntime(), source = runtimeNativeSource(context, 'camera');
      if (source) return new CameraController(await instantiateVerifiedModule<CameraModule>(source));
      if (!import.meta.env.DEV) throw new Error('The camera requires verified deployment bytes.');
      const url = new URL('wasm/splatview-camera.mjs', context.assetBase);
      factory = (await import(/* @vite-ignore */ url.href) as { default: ModuleFactory<CameraModule> }).default;
    }
    return new CameraController(await factory());
  }
  get active() { return !this.disposed && this.module._sv_camera_input_active(this.input) !== 0; }
  get state() { return Array.from(this.values.subarray(0, 11)); }
  get view() { return this.values.subarray(11, 27); }
  get projection() { return this.values.subarray(27, 43); }
  get eye() { return this.values.subarray(43, 46); }
  filterGizmoFrame(config: FilterGizmoConfig) { return this.filterGizmos.frame(config); }
  beginFilterGizmo(config: FilterGizmoConfig, handle: number) { return this.filterGizmos.begin(config, handle); }
  updateFilterGizmo(session: FilterGizmoSession, pointer: readonly [number, number], ctrl: boolean) { return this.filterGizmos.update(session, pointer, ctrl); }
  endFilterGizmo(session: FilterGizmoSession) { this.filterGizmos.end(session); }
  composeTransform(definition: TransformDefinition) { return this.transformGizmos.compose(definition); }
  transformGizmoFrame(config: TransformGizmoConfig) { return this.transformGizmos.frame(config); }
  beginTransformGizmo(config: TransformGizmoConfig, handle: number) { return this.transformGizmos.begin(config, handle); }
  updateTransformGizmo(session: TransformGizmoSession, pointer: readonly [number, number], ctrl: boolean) { return this.transformGizmos.update(session, pointer, ctrl); }
  endTransformGizmo(session: TransformGizmoSession) { this.transformGizmos.end(session); }
  /** Captured native Frustum-from-view policy, including axis-angle and clip planes. */
  filterView(): Pick<SelectionFilterParameters, 'center' | 'rotation' | 'fov' | 'aspect' | 'near' | 'far'> {
    if (this.disposed) throw new Error('The camera has been disposed.');
    if (typeof this.module._sv_camera_filter_view !== 'function') throw new Error('The camera does not support filter views. Reload SplatView.');
    const start = this.transformPointer / 4, output = this.transformPointer + 11 * 4;
    this.module.HEAPF32.set(checkedCameraState(this.state), start);
    if (this.module._sv_camera_filter_view(this.transformPointer, output) !== 1) throw new Error('The filter view could not be captured.');
    const values = Array.from(this.module.HEAPF32.subarray(output / 4, output / 4 + 10));
    if (values.some(value => !Number.isFinite(value))) throw new Error('The filter view is invalid.');
    return { center: values.slice(0, 3) as [number, number, number], rotation: values.slice(3, 6) as [number, number, number],
      fov: values[6], aspect: values[7], near: values[8], far: values[9] };
  }
  /** Pure captured Camera::transformed call; live navigation and input remain owned by this camera. */
  transformState(state: readonly number[], frame: readonly number[], policy: AlignmentCameraPolicy = 0): AlignmentCameraState {
    if (this.disposed) throw new Error('The camera has been disposed.');
    if (policy !== 0 && policy !== 1) throw new Error('Invalid camera transform policy.');
    const input = checkedCameraState(state), matrix = validateAlignmentMatrix(frame);
    const start = this.transformPointer / 4, output = this.transformPointer + (11 + 16) * 4;
    this.module.HEAPF32.set(input, start); this.module.HEAPF32.set(matrix, start + 11);
    if (this.module._sv_camera_transform(this.transformPointer, this.transformPointer + 11 * 4, output, policy) !== 1)
      throw new Error('The alignment cannot produce a valid camera.');
    // The native call can grow memory. Read the current heap and detach every output field.
    const result = Array.from(this.module.HEAPF32.subarray(output / 4, output / 4 + 46));
    if (result.length !== 46 || result.some(value => !Number.isFinite(value)))
      throw new Error('The camera transform returned invalid output.');
    const transformed = checkedCameraState(result.slice(0, 11));
    if (transformed[10] !== input[10]) throw new Error('The camera transform changed the view aspect.');
    return transformed;
  }
  /** Pure native inverse(before) * after; reuse lifecycle-owned scratch and retain every native bit. */
  frameChange(before: readonly number[], after: readonly number[]): AlignmentFrame {
    return this.changeFrame(before, after, false);
  }
  /** Pure captured default-lineage orientation transport; translation and scale are discarded natively. */
  orientationFrameChange(before: readonly number[], after: readonly number[]): AlignmentFrame {
    return this.changeFrame(before, after, true);
  }
  private changeFrame(before: readonly number[], after: readonly number[], orientation: boolean): AlignmentFrame {
    if (this.disposed) throw new Error('The camera has been disposed.');
    const oldFrame = orientation ? validateAlignmentMatrix(before) : validateAlignmentFrame(before),
      newFrame = orientation ? validateAlignmentMatrix(after) : validateAlignmentFrame(after);
    const start = this.transformPointer / 4, output = this.transformPointer + 32 * 4;
    this.module.HEAPF32.set(oldFrame, start); this.module.HEAPF32.set(newFrame, start + 16);
    const accepted = orientation ? this.module._sv_camera_orientation_change(this.transformPointer, this.transformPointer + 16 * 4, output) :
      this.module._sv_camera_frame_change(this.transformPointer, this.transformPointer + 16 * 4, output);
    if (accepted !== 1)
      throw new Error('The alignment cannot produce a valid frame change.');
    return validateAlignmentMatrix(Array.from(this.module.HEAPF32.subarray(output / 4, output / 4 + 16)));
  }
  cycleBackground() { return this.background = nextBackground(this.background); }
  set(state: number[]) { this.clearInput(); this.values.set(state.slice(0, 11)); this.update(0); }
  aspect(value: number) { const aspect = Math.fround(value); if (this.values[10] !== aspect) { this.values[10] = aspect; this.update(0); } }
  orbit(x: number, y: number) { this.update(1, x, y); }
  pan(x: number, y: number) { this.update(2, x, y); }
  zoom(ticks: number) { this.update(3, ticks); }
  look(x: number, y: number) { this.update(4, x, y); }
  move(right: number, up: number, forward: number) { this.update(5, right, up, forward); }
  focus(point: number[]) { this.update(6, point[0], point[1], point[2]); }
  flipUp() { this.values[8] = this.values[8] ? 0 : 1; this.update(0); }
  lens(delta: number) { this.values[7] = Math.max(10, Math.min(120, this.values[7] + delta)); this.update(0); }
  queueScroll(ticks: number, fly: boolean) { this.inputEvent(1, ticks, Number(fly)); }
  key(code: string, down: boolean, fast = false, slow = false) {
    const key = navigationKey(code); this.speed(fast, slow);
    if (key === undefined) return false;
    this.inputEvent(2, key, Number(down)); return true;
  }
  speed(fast: boolean, slow: boolean) { this.inputEvent(3, Number(fast), Number(slow)); }
  clearInput() { if (!this.disposed) this.inputEvent(4); }
  tick(seconds: number, fly: boolean) {
    if (!this.active || !Number.isFinite(seconds) || seconds <= 0) return false;
    this.module.HEAPF32.set(this.values, this.pointer / 4);
    if (!this.module._sv_camera_tick(this.input, this.pointer, Number(fly), seconds)) return false;
    this.read(); return true;
  }
  private inputEvent(action: number, a = 0, b = 0, c = 0) {
    this.module.HEAPF32.set(this.values, this.pointer / 4);
    this.module._sv_camera_input(this.input, this.pointer, action, a, b, c);
  }
  private read() {
    this.values.set(this.module.HEAPF32.subarray(this.pointer / 4, this.pointer / 4 + 46)); this.revision++;
  }
  private update(action: number, a = 0, b = 0, c = 0) {
    this.module.HEAPF32.set(this.values, this.pointer / 4);
    this.module._sv_camera(this.pointer, action, a, b, c);
    this.read();
  }
  dispose() {
    if (this.disposed) return;
    this.clearInput(); this.module._sv_camera_input_delete(this.input); this.module._free(this.pointer);
    this.filterGizmos.dispose();
    this.transformGizmos.dispose();
    this.module._free(this.transformPointer); this.disposed = true;
  }
}

function checkedCameraState(value: readonly number[]): AlignmentCameraState {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 11 ||
      Reflect.ownKeys(value).length !== 12) throw new Error('Invalid camera transform state.');
  const result = Array.from({ length: 11 }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor) || typeof descriptor.value !== 'number' ||
        !Number.isFinite(descriptor.value) || !Number.isFinite(Math.fround(descriptor.value)))
      throw new Error('Invalid camera transform state.');
    return Math.fround(descriptor.value);
  });
  if (result[5] <= 0 || result[6] <= 0 || result[10] <= 0 || result[8] !== 0 && result[8] !== 1)
    throw new Error('Invalid camera transform state.');
  return result as AlignmentCameraState;
}
