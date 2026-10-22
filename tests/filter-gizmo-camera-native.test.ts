import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CameraController, type CameraModule, type FilterGizmoConfig } from '../src/input/camera';
import { FILTER_GIZMO_SCRATCH_FLOATS } from '../src/input/filterGizmo';
import { filterDefaults } from '../src/document/filterProtocol';
import type { ModuleFactory } from '../src/workers/wasm';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

let factory: ModuleFactory<CameraModule>;
const cameras: CameraController[] = [];
beforeAll(async () => { factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default; });
afterEach(() => { for (const value of cameras.splice(0)) value.dispose(); });
async function camera(module?: CameraModule) {
  const value = await CameraController.create(module ? async () => module : factory);
  value.set([0, 0, 0, 0, 0, 4, 1, 60, 1, 0, 4 / 3]); cameras.push(value); return value;
}
function config(patch: Partial<FilterGizmoConfig> = {}): FilterGizmoConfig {
  return { kind: 'box', mode: 'move', parameters: filterDefaults(), viewport: { x: 0, y: 0, width: 800, height: 600 },
    panelScale: 1, local: false, snap: false, showVolume: false, pointer: [426, 300], ...patch };
}
describe('actual native filter gizmo bridge and camera ownership', () => {
  it('projects an independently known centered perspective frame and translates by its camera ray', async () => {
    const value = await camera(), before = { state: value.state, revision: value.revision }, definition = config();
    expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraFilterGizmo).toBe(1);
    const display = value.filterGizmoFrame(definition)!;
    expect(display.center[0]).toBeCloseTo(400, 4); expect(display.center[1]).toBeCloseTo(300, 4);
    expect(display.hitHandle).toBe(1); expect(display.primitives.length).toBeLessThanOrEqual(512);
    const session = value.beginFilterGizmo(definition, display.hitHandle)!;
    const pose = value.updateFilterGizmo(session, [452, 300], false)!;
    // Perspective ray-plane intersection at z=0: dx pixels * depth/focalPixels.
    expect(pose.center[0]).toBeCloseTo(26 * 2 * 4 * Math.tan(Math.PI / 6) / 600, 5);
    expect(pose.center[1]).toBeCloseTo(0, 6); expect(pose.center[2]).toBeCloseTo(0, 6);
    expect(pose.size).toEqual([1, 1, 1]); expect(definition.parameters).toEqual(filterDefaults());
    expect({ state: value.state, revision: value.revision }).toEqual(before);
    value.endFilterGizmo(session); expect(value.updateFilterGizmo(session, [460, 300], false)).toBeNull();
  });
  it('returns detached frames and fixed-baseline drag results without native allocation per move', async () => {
    const module = await factory(), allocations: number[] = [], freed: number[] = [];
    const malloc = module._malloc.bind(module), free = module._free.bind(module);
    module._malloc = bytes => { allocations.push(bytes); return malloc(bytes); };
    module._free = pointer => { freed.push(pointer); free(pointer); };
    const value = await camera(module); expect(allocations).toHaveLength(2);
    const first = value.filterGizmoFrame(config())!, firstCopy = JSON.stringify(first);
    expect(allocations).toEqual([46 * 4, (11 + 16 + 46) * 4, FILTER_GIZMO_SCRATCH_FLOATS * 4]);
    const session = value.beginFilterGizmo(config(), 1)!;
    const forward = value.updateFilterGizmo(session, [452, 300], false)!;
    forward.center[0] = 999; // A consumer cannot mutate the captured native baseline.
    for (let at = 0; at < 5; at++) { value.filterGizmoFrame(config({ pointer: [0, 0] })); value.updateFilterGizmo(session, [452, 300], true); }
    const original = value.updateFilterGizmo(session, [426, 300], false)!;
    expect(original.center).toEqual([0, 0, 0]); expect(JSON.stringify(first)).toBe(firstCopy);
    expect(Object.isFrozen(first)).toBe(true); expect(Object.isFrozen(first.primitives)).toBe(true);
    expect(allocations).toHaveLength(3); value.dispose(); value.dispose(); expect(freed).toHaveLength(3);
    expect(new Set(freed).size).toBe(3); expect(value.updateFilterGizmo(session, [452, 300], false)).toBeNull();
  });
  it('retries failed lazy scratch admission without retiring the usable camera', async () => {
    const module = await factory(), value = await camera(module), malloc = module._malloc.bind(module);
    const before = value.state; module._malloc = () => 0;
    expect(() => value.filterGizmoFrame(config())).toThrow('memory for the filter gizmo');
    expect(value.state).toEqual(before); module._malloc = malloc;
    expect(value.filterGizmoFrame(config())?.hitHandle).toBe(1);
  });
  it.each(['_sv_camera_filter_gizmo_frame', '_sv_camera_filter_gizmo_begin', '_sv_camera_filter_gizmo_update'] as const)
    ('refuses missing %s before allocating camera owners', async name => {
      const module = await factory(); let allocations = 0;
      module._malloc = () => { allocations++; return 0; }; Object.defineProperty(module, name, { value: undefined });
      await expect(CameraController.create(async () => module)).rejects.toThrow('out of date'); expect(allocations).toBe(0);
    });
  it('fences foreign, forged, retired and view-stale sessions', async () => {
    const value = await camera(), other = await camera(), session = value.beginFilterGizmo(config(), 1)!;
    expect(other.updateFilterGizmo(session, [452, 300], false)).toBeNull();
    expect(value.updateFilterGizmo({} as typeof session, [452, 300], false)).toBeNull();
    expect(value.beginFilterGizmo(config(), 1)).toBeNull();
    value.orbit(.1, 0); expect(value.updateFilterGizmo(session, [452, 300], false)).toBeNull();
    value.set([0, 0, 0, 0, 0, 4, 1, 60, 1, 0, 4 / 3]);
    expect(value.updateFilterGizmo(session, [452, 300], false)).toBeNull();
    expect(value.beginFilterGizmo(config(), 1)).not.toBeNull();
  });
  it('refuses undrawn handles, range filters, degenerate views and Frustum scale', async () => {
    const value = await camera(); expect(value.beginFilterGizmo(config({ pointer: [0, 0] }), 1)).toBeNull();
    expect(value.beginFilterGizmo(config(), 3)).toBeNull(); // Z axis is end-on in this view.
    expect(value.filterGizmoFrame(config({ viewport: { x: 0, y: 0, width: 0, height: 600 } }))).toBeNull();
    expect(value.filterGizmoFrame(config({ kind: 'frustum', mode: 'scale' }))).toBeNull();
    expect(value.beginFilterGizmo(config({ kind: 'frustum', mode: 'scale' }), 12)).toBeNull();
    expect(() => value.filterGizmoFrame(config({ kind: 'opacity' }))).toThrow('Invalid filter gizmo operation');
  });
  it('keeps stored Snap and temporary Ctrl in native fixed-baseline replay', async () => {
    const value = await camera(), session = value.beginFilterGizmo(config(), 1)!;
    const raw = value.updateFilterGizmo(session, [447, 300], false)!, snapped = value.updateFilterGizmo(session, [447, 300], true)!;
    expect(raw.center[0]).toBeCloseTo(21 * 2 * 4 * Math.tan(Math.PI / 6) / 600, 5);
    expect(snapped.center[0]).toBeCloseTo(.2, 6); expect(value.updateFilterGizmo(session, [447, 300], false)).toEqual(raw);
    value.endFilterGizmo(session);
    const stored = value.beginFilterGizmo(config({ snap: true }), 1)!;
    expect(value.updateFilterGizmo(stored, [447, 300], false)).toEqual(snapped);
  });
});
