import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CameraController, type CameraModule } from '../src/input/camera';
import type { ModuleFactory } from '../src/workers/wasm';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

let factory: ModuleFactory<CameraModule>;
const cameras: CameraController[] = [];
beforeAll(async () => { factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default; });
afterEach(() => { for (const camera of cameras.splice(0)) camera.dispose(); });
async function camera() { const value = await CameraController.create(factory); cameras.push(value); return value; }

describe('actual native desktop Frustum-from-view capture', () => {
  it.each([false, true])('captures an analytic axis-aligned view, yUp=%s, without changing navigation', async yUp => {
    const value = await camera(); value.set([2, 4, 6, 0, 0, 3, 2, 60, Number(yUp), 0, 1.5]);
    const before = { state: value.state, view: Array.from(value.view), projection: Array.from(value.projection), revision: value.revision };
    const actual = value.filterView();
    // Independent source formulas: Camera::eye = target + sign*distance Z;
    // clipPlanes = max(.0001,radius*.0001), max(distance+radius*10,radius*1000).
    expect(actual.center).toEqual([2, 4, yUp ? 9 : 3]);
    expect(actual.fov).toBe(60); expect(actual.aspect).toBe(1.5);
    expect(actual.near).toBeCloseTo(.0002, 8); expect(actual.far).toBe(2000);
    // yUp orbit0 inverse view is identity; yDown flips Y/Z with a half-turn X.
    expect(actual.rotation[1]).toBeCloseTo(0, 4); expect(actual.rotation[2]).toBeCloseTo(0, 4);
    expect(Math.abs(actual.rotation[0])).toBeCloseTo(yUp ? 0 : 180, 4);
    expect({ state: value.state, view: Array.from(value.view), projection: Array.from(value.projection), revision: value.revision }).toEqual(before);
  });
  it('uses native lens/aspect/clip clamps and retains signed roll in its axis-angle orientation', async () => {
    const value = await camera(); value.set([0, 0, 0, 0, 0, 3000, 1, 160, 1, .5, .005]);
    const actual = value.filterView();
    expect(actual.fov).toBe(120); expect(actual.aspect).toBe(Math.fround(.01));
    expect(actual.near).toBe(Math.fround(.0001)); expect(actual.far).toBe(3010);
    expect(Math.abs(actual.rotation[2])).toBeCloseTo(.5 * 180 / Math.PI, 4);
    expect(actual.rotation[0]).toBeCloseTo(0, 4); expect(actual.rotation[1]).toBeCloseTo(0, 4);
  });
  it('rejects invalid native pointer/state inputs before publishing or touching the output', async () => {
    expect(BUILD_DESCRIPTOR.native.camera.capabilities.cameraFilterView).toBe(1);
    const module = await factory(), input = module._malloc(21 * 4), output = input + 11 * 4;
    try {
      const state = [0, 0, 0, 0, 0, 3, 1, 60, 1, 0, 1];
      for (const [index, bad] of [[3, NaN], [5, 0], [6, -1], [8, 2], [10, 0]] as const) {
        module.HEAPF32.set(state, input / 4); module.HEAPF32[input / 4 + index] = bad;
        module.HEAPF32.fill(123, output / 4, output / 4 + 10);
        expect(module._sv_camera_filter_view(input, output)).toBe(0);
        expect(Array.from(module.HEAPF32.subarray(output / 4, output / 4 + 10))).toEqual(Array(10).fill(123));
      }
      expect(module._sv_camera_filter_view(0, output)).toBe(0); expect(module._sv_camera_filter_view(input + 1, output)).toBe(0);
      module.HEAPF32.set(state, input / 4);
      expect(module._sv_camera_filter_view(input, input)).toBe(1);
      expect(Array.from(module.HEAPF32.subarray(input / 4, input / 4 + 3))).toEqual([0, 0, 3]);
    } finally { module._free(input); }
  });
});
