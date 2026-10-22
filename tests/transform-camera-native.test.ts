import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CameraController, type CameraModule } from '../src/input/camera';
import { TRANSFORM_GIZMO_SCRATCH_FLOATS } from '../src/input/transformGizmo';
import type { TransformDefinition, TransformMatrix } from '../src/document/transformProtocol';
import type { TransformGizmoConfig } from '../src/document/transformGizmo';
import type { ModuleFactory } from '../src/workers/wasm';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

let factory: ModuleFactory<CameraModule>;
const cameras: CameraController[] = [];
beforeAll(async () => { factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default; });
afterEach(() => { for (const value of cameras.splice(0)) value.dispose(); });
async function camera(module?: CameraModule) {
  const value = await CameraController.create(module ? async () => module : factory);
  value.set([0, 0, 0, 0, 0, 4, 1, 60, 1, 0, 4 / 3]);cameras.push(value);return value;
}
const identity = (): TransformMatrix => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const common = () => ({ translation: [3, -4, 5] as [number, number, number], scale: [2, 3, 4] as [number, number, number],
  pivot: [0, 0, 0] as [number, number, number], flips: [false, false, false] as [boolean, boolean, boolean] });
function matches(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(expected[index]))));
}
function config(patch: Partial<TransformGizmoConfig> = {}): TransformGizmoConfig {
  return { mode: 'move', viewport: { x: 0, y: 0, width: 800, height: 600 }, panelScale: 1, local: false, snap: false,
    pointer: [426, 300], pivot: [0, 0, 0], widgetMatrix: identity(), ...patch };
}
describe('actual native transform composition and immutable matrix gizmo bridge', () => {
  it.each([
    { ...common(), mode: 'euler', euler: [0, 0, 90] },
    { ...common(), mode: 'quaternion', quaternion: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] },
    { ...common(), mode: 'axis-angle', axis: [0, 0, 5], angle: 90 },
  ] as TransformDefinition[])('composes equivalent $mode rotation/scale/translation using native arithmetic', async definition => {
    const value = await camera(), before = { state: value.state, revision: value.revision };
    matches(value.composeTransform(definition)!.matrix, [0, 2, 0, 0, -3, 0, 0, 0, 0, 0, 4, 0, 3, -4, 5, 1]);
    expect({ state: value.state, revision: value.revision }).toEqual(before);
  });
  it('keeps the nonsymmetric user row-major matrix and GPU matrix layouts distinct', async () => {
    const value = await camera();expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraTransformGizmo).toBe(1);
    const definition: TransformDefinition = { mode: 'matrix', matrix: [1, 2, 3, 17, 0, 1, 4, -3, 5, 6, 0, 8, 0, 0, 0, 1],
      pivot: [0, 0, 0], flips: [false, false, false] };
    expect(value.composeTransform(definition)!.matrix).toEqual([1, 0, 5, 0, 2, 1, 6, 0, 3, 4, 0, 0, 17, -3, 8, 1]);
    expect(definition.matrix[3]).toBe(17);expect(definition.matrix[12]).toBe(0);
  });
  it('composes scale around the retained pivot and the captured Flip X rotation around Y', async () => {
    const value = await camera(), definition: TransformDefinition = { ...common(), mode: 'euler', euler: [0, 0, 0], pivot: [1, 2, 3] };
    matches(value.composeTransform(definition)!.matrix, [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 2, -8, -4, 1]);
    definition.flips[0] = true;
    matches(value.composeTransform(definition)!.matrix, [-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, -4, 0, 0, -8, 10, 1]);
  });
  it('accepts singular/sheared affine input while refusing an invalid numeric scale draft', async () => {
    const value = await camera(), matrix = identity();matrix[0] = 0;matrix[1] = 2;
    expect(value.composeTransform({ mode: 'matrix', matrix, pivot: [0, 0, 0], flips: [false, false, false] })).not.toBeNull();
    expect(value.composeTransform({ ...common(), mode: 'euler', euler: [0, 0, 0], scale: [0, 1, 1] })).toBeNull();
  });
  it('uses an independently known perspective ray and emits both exact delta layouts', async () => {
    const value = await camera(), before = { state: value.state, revision: value.revision }, frame = value.transformGizmoFrame(config())!;
    expect(frame.center[0]).toBeCloseTo(400, 4);expect(frame.center[1]).toBeCloseTo(300, 4);expect(frame.hitHandle).toBe(1);
    const session = value.beginTransformGizmo(config(), 1)!, pose = value.updateTransformGizmo(session, [452, 300], false)!;
    const expected = 26 * 2 * 4 * Math.tan(Math.PI / 6) / 600;
    expect(pose.deltaMatrix[12]).toBeCloseTo(expected, 5);expect(pose.rowMajorDelta[3]).toBe(pose.deltaMatrix[12]);
    expect(pose.rowMajorDelta[12]).toBe(0);expect(pose.deltaMatrix[3]).toBe(0);
    expect({ state: value.state, revision: value.revision }).toEqual(before);
    value.endTransformGizmo(session);expect(value.updateTransformGizmo(session, [460, 300], false)).toBeNull();
  });
  it('detaches frames and press state, shares one lazy scratch block and frees it once', async () => {
    const module = await factory(), allocations: number[] = [], freed: number[] = [], malloc = module._malloc.bind(module), free = module._free.bind(module);
    module._malloc = bytes => { allocations.push(bytes);return malloc(bytes); };
    module._free = pointer => { freed.push(pointer);free(pointer); };
    const value = await camera(module);expect(allocations).toHaveLength(2);
    value.composeTransform({ ...common(), mode: 'euler', euler: [0, 0, 0] });
    const frame = value.transformGizmoFrame(config())!, saved = JSON.stringify(frame), session = value.beginTransformGizmo(config(), 1)!;
    const forward = value.updateTransformGizmo(session, [452, 300], false)!;forward.deltaMatrix[12] = 999;
    for (let at = 0; at < 5; at++) { value.composeTransform({ ...common(), mode: 'euler', euler: [0, 0, 0] });value.updateTransformGizmo(session, [447, 300], true); }
    expect(value.updateTransformGizmo(session, [426, 300], false)!.deltaMatrix).toEqual(identity());
    expect(JSON.stringify(frame)).toBe(saved);expect(Object.isFrozen(frame.primitives)).toBe(true);
    expect(allocations).toEqual([46 * 4, (11 + 16 + 46) * 4, TRANSFORM_GIZMO_SCRATCH_FLOATS * 4]);
    value.dispose();value.dispose();expect(freed).toHaveLength(3);expect(new Set(freed).size).toBe(3);
    expect(value.updateTransformGizmo(session, [452, 300], false)).toBeNull();
  });
  it.each(['_sv_camera_transform_compose', '_sv_camera_transform_gizmo_frame', '_sv_camera_transform_gizmo_begin', '_sv_camera_transform_gizmo_update'] as const)
    ('refuses missing %s before allocating camera owners', async name => {
      const module = await factory();let allocations = 0;
      module._malloc = () => { allocations++;return 0; };Object.defineProperty(module, name, { value: undefined });
      await expect(CameraController.create(async () => module)).rejects.toThrow('out of date');expect(allocations).toBe(0);
    });
  it('retries scratch refusal without retiring the usable camera', async () => {
    const module = await factory(), value = await camera(module), malloc = module._malloc.bind(module), before = value.state;
    module._malloc = () => 0;
    expect(() => value.transformGizmoFrame(config())).toThrow('memory for the transform gizmo');expect(value.state).toEqual(before);
    module._malloc = malloc;expect(value.transformGizmoFrame(config())?.hitHandle).toBe(1);
  });
  it('rejects foreign, forged, retired and camera-revision-stale gesture tokens', async () => {
    const value = await camera(), other = await camera(), session = value.beginTransformGizmo(config(), 1)!;
    expect(other.updateTransformGizmo(session, [452, 300], false)).toBeNull();expect(value.updateTransformGizmo({} as typeof session, [452, 300], false)).toBeNull();
    expect(value.beginTransformGizmo(config(), 1)).toBeNull();value.orbit(.1, 0);
    expect(value.updateTransformGizmo(session, [452, 300], false)).toBeNull();
  });
  it('keeps stored Snap and temporary Ctrl in the native absolute press replay', async () => {
    const value = await camera(), session = value.beginTransformGizmo(config(), 1)!;
    const raw = value.updateTransformGizmo(session, [447, 300], false)!, snapped = value.updateTransformGizmo(session, [447, 300], true)!;
    expect(raw.deltaMatrix[12]).toBeCloseTo(21 * 2 * 4 * Math.tan(Math.PI / 6) / 600, 5);
    expect(snapped.deltaMatrix[12]).toBeCloseTo(.2, 6);expect(value.updateTransformGizmo(session, [447, 300], false)).toEqual(raw);
    value.endTransformGizmo(session);const stored = value.beginTransformGizmo(config({ snap: true }), 1)!;
    expect(value.updateTransformGizmo(stored, [447, 300], false)).toEqual(snapped);
  });
  it('refuses a valid affine bake delta that differs from its GPU preview delta', async () => {
    const module = await factory(), value = await camera(module), original = module._sv_camera_transform_gizmo_update.bind(module);
    const session = value.beginTransformGizmo(config(), 1)!;
    module._sv_camera_transform_gizmo_update = (state, pointer, output) => {
      const result = original(state, pointer, output);
      if (result === 1) module.HEAPF32[output / 4 + 32 + 3] += .25;
      return result;
    };
    expect(() => value.updateTransformGizmo(session, [452, 300], false)).toThrow('inconsistent delta matrices');
    module._sv_camera_transform_gizmo_update = original;
    expect(value.updateTransformGizmo(session, [452, 300], false)).not.toBeNull();
  });
  it.each([['outline role', 1, 4], ['zero handle', 0, 0]] as const)
    ('refuses filter-only %s drawing data in a general transform frame', async (_name, field, replacement) => {
      const module = await factory(), value = await camera(module), original = module._sv_camera_transform_gizmo_frame.bind(module);
      module._sv_camera_transform_gizmo_frame = (input, output) => {
        const result = original(input, output);
        if (result === 1) module.HEAPF32[output / 4 + 4 + field] = replacement;
        return result;
      };
      expect(() => value.transformGizmoFrame(config())).toThrow('invalid drawing data');
    });
});
