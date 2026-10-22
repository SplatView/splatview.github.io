import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CameraController, type CameraModule } from '../src/input/camera';
import { navigationKey, translationKey, wheelTicks } from '../src/input/navigation';
import type { ModuleFactory } from '../src/workers/wasm';

let factory: ModuleFactory<CameraModule>;
const instances: CameraController[] = [];
const initial = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1.6];
async function camera() {
  const value = await CameraController.create(factory); value.set(initial); instances.push(value); return value;
}
function advance(value: CameraController, seconds: number, frames: number, fly = true) {
  for (let i = 0; i < frames; i++) value.tick(seconds / frames, fly);
}
const displacement = (value: CameraController) => Math.hypot(...value.state.slice(0, 3));
beforeAll(async () => {
  factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default;
});
afterEach(() => { for (const value of instances.splice(0)) value.dispose(); });

describe('real portable C++ camera and navigation WASM', () => {
  it('allocates fixed transform scratch once, reuses it and frees each camera owner exactly once', async () => {
    const module = await factory(), allocations: number[] = [], freed: number[] = [], deleted: number[] = [];
    const malloc = module._malloc.bind(module), free = module._free.bind(module), remove = module._sv_camera_input_delete.bind(module);
    module._malloc = bytes => { allocations.push(bytes); return malloc(bytes); };
    module._free = pointer => { freed.push(pointer); free(pointer); };
    module._sv_camera_input_delete = input => { deleted.push(input); remove(input); };
    const value = await CameraController.create(async () => module);
    const frame = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, -2, 3, 1];
    expect(allocations).toEqual([46 * 4, (11 + 16 + 46) * 4]);
    for (let i = 0; i < 4; i++) { value.transformState(initial, frame); value.frameChange(frame, frame); value.orientationFrameChange(frame, frame); }
    expect(allocations).toHaveLength(2); value.dispose(); value.dispose();
    expect(freed).toHaveLength(2); expect(new Set(freed).size).toBe(2); expect(deleted).toHaveLength(1);
  });
  it('releases live camera and native input if transform scratch admission fails', async () => {
    const module = await factory(), freed: number[] = [], deleted: number[] = [];
    const malloc = module._malloc.bind(module), free = module._free.bind(module), remove = module._sv_camera_input_delete.bind(module);
    let calls = 0;
    module._malloc = bytes => ++calls === 2 ? 0 : malloc(bytes);
    module._free = pointer => { freed.push(pointer); free(pointer); };
    module._sv_camera_input_delete = input => { deleted.push(input); remove(input); };
    await expect(CameraController.create(async () => module)).rejects.toThrow('memory for camera transforms');
    expect(calls).toBe(2); expect(freed).toHaveLength(1); expect(deleted).toHaveLength(1);
  });
  it('requires the pure transform export before allocating any owner', async () => {
    const module = await factory(); let allocations = 0;
    module._malloc = () => { allocations++; return 0; };
    Object.defineProperty(module, '_sv_camera_transform', { value: undefined });
    await expect(CameraController.create(async () => module)).rejects.toThrow('out of date'); expect(allocations).toBe(0);
  });
  it('requires the ABI3 frame export before allocating any owner', async () => {
    const module = await factory(); let allocations = 0;
    module._malloc = () => { allocations++; return 0; };
    Object.defineProperty(module, '_sv_camera_frame_change', { value: undefined });
    await expect(CameraController.create(async () => module)).rejects.toThrow('out of date'); expect(allocations).toBe(0);
  });
  it('requires the ABI4 orientation export before allocating any owner', async () => {
    const module = await factory(); let allocations = 0;
    module._malloc = () => { allocations++; return 0; };
    Object.defineProperty(module, '_sv_camera_orientation_change', { value: undefined });
    await expect(CameraController.create(async () => module)).rejects.toThrow('out of date'); expect(allocations).toBe(0);
  });
  it('keeps orientation frame transport detached while ignoring old frame translation and scale', async () => {
    const value = await camera(); value.key('KeyW', true); value.cycleBackground();
    const before = { state: value.state, view: Array.from(value.view), projection: Array.from(value.projection),
      revision: value.revision, active: value.active, background: value.background };
    const oldFrame = [0, .5, 0, 0, -.5, 0, 0, 0, 0, 0, .5, 0, 1e12, -1e12, 1e12, 1],
      nextFrame = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, -1e12, 1e12, -1e12, 1];
    const old = [...oldFrame], next = [...nextFrame], result = value.orientationFrameChange(oldFrame, nextFrame);
    expect(Object.isFrozen(result)).toBe(true); expect(result.slice(12, 15)).toEqual([0, 0, 0]);
    expect(oldFrame).toEqual(old); expect(nextFrame).toEqual(next);
    expect({ state: value.state, view: Array.from(value.view), projection: Array.from(value.projection),
      revision: value.revision, active: value.active, background: value.background }).toEqual(before);
    value.dispose(); expect(() => value.orientationFrameChange(oldFrame, nextFrame)).toThrow('disposed');
  });
  it('refuses native orientation failure or malformed output without touching live state', async () => {
    const module = await factory(), original = module._sv_camera_orientation_change.bind(module);
    const value = await CameraController.create(async () => module); instances.push(value);
    const frame = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, -2, 3, 1], state = value.state, revision = value.revision;
    module._sv_camera_orientation_change = () => 0;
    expect(() => value.orientationFrameChange(frame, frame)).toThrow('valid frame change');
    module._sv_camera_orientation_change = (before, after, output) => {
      const accepted = original(before, after, output); module.HEAPF32[output / 4] = Infinity; return accepted;
    };
    expect(() => value.orientationFrameChange(frame, frame)).toThrow('matrix');
    expect(value.state).toEqual(state); expect(value.revision).toBe(revision);
  });
  it('keeps pure frame results detached from live camera/navigation and refuses malformed frames', async () => {
    const value = await camera(); value.key('KeyW', true); value.cycleBackground();
    const live = () => ({ state: value.state, view: Array.from(value.view), projection: Array.from(value.projection),
      revision: value.revision, active: value.active, background: value.background });
    const before = live(), oldFrame = Object.freeze([.7, 0, 0, 0, 0, .7, 0, 0, 0, 0, .7, 0, .25, -.3, .75, 1]),
      nextFrame = Object.freeze([2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, -2, 3, 1]);
    const result = value.frameChange(oldFrame, nextFrame); expect(Object.isFrozen(result)).toBe(true); expect(live()).toEqual(before);
    for (const invalid of [new Array(16), oldFrame.slice(0, 15), [...oldFrame, 0], oldFrame.map((v, i) => i === 0 ? Infinity : v)])
      expect(() => value.frameChange(invalid, nextFrame)).toThrow();
    expect(live()).toEqual(before); value.dispose(); expect(() => value.frameChange(oldFrame, nextFrame)).toThrow('disposed');
  });
  it('refuses failed or malformed native frame output without touching live state or revision', async () => {
    const module = await factory(), original = module._sv_camera_frame_change.bind(module);
    const value = await CameraController.create(async () => module); instances.push(value);
    const frame = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, -2, 3, 1], state = value.state, revision = value.revision;
    module._sv_camera_frame_change = () => 0;
    expect(() => value.frameChange(frame, frame)).toThrow('valid frame change');
    module._sv_camera_frame_change = (before, after, output) => {
      const result = original(before, after, output); module.HEAPF32[output / 4] = Infinity; return result;
    };
    expect(() => value.frameChange(frame, frame)).toThrow('matrix'); expect(value.state).toEqual(state); expect(value.revision).toBe(revision);
  });
  it('preserves the view revision when a repeated viewport aspect has the same native precision', async () => {
    const value = await camera(), revision = value.revision, state = value.state, projection = Array.from(value.projection);
    expect(state[10]).toBe(Math.fround(320 / 200));
    for (let i = 0; i < 3; i++) value.aspect(320 / 200);
    expect(value.revision).toBe(revision); expect(value.state).toEqual(state); expect(Array.from(value.projection)).toEqual(projection);
    value.aspect(321 / 200);
    expect(value.revision).toBe(revision + 1); expect(value.state[10]).toBe(Math.fround(321 / 200));
    expect(Array.from(value.projection)).not.toEqual(projection);
    value.aspect(321 / 200); expect(value.revision).toBe(revision + 1);
  });
  it('uses native pixel pan, orbit and fixed-eye Look conventions', async () => {
    const value = await camera(); value.pan(100, 50);
    expect(value.state[0]).toBeCloseTo(-.39, 6); expect(value.state[1]).toBeCloseTo(-.195, 6);
    value.set(initial); value.orbit(10, 20);
    expect(value.state[3]).toBeCloseTo(-.07, 6); expect(value.state[4]).toBeCloseTo(.14, 6);
    value.set(initial); const eye = Array.from(value.eye); value.look(10, 20);
    Array.from(value.eye).forEach((coordinate, i) => expect(coordinate).toBeCloseTo(eye[i], 6));
  });
  it('eases wheel zoom in log distance with the native 80 ms response', async () => {
    const value = await camera(), revision = value.revision;
    value.queueScroll(1, false); expect(value.active).toBe(true); expect(value.revision).toBe(revision);
    expect(value.tick(.08, false)).toBe(true);
    expect(value.state[5]).toBeCloseTo(3 * Math.exp(-.13 * (1 - Math.exp(-1))), 6);
    expect(value.state[5]).toBeGreaterThan(3 * Math.exp(-.13));
    value.queueScroll(.5, false); advance(value, 2, 120, false);
    expect(value.state[5]).toBeCloseTo(3 * Math.exp(-.13 * 1.5), 6); expect(value.active).toBe(false);
    const stopped = value.state, stoppedRevision = value.revision;
    expect(value.tick(.1, false)).toBe(false); expect(value.state).toEqual(stopped); expect(value.revision).toBe(stoppedRevision);
  });
  it('composes the same wheel trace at 30 and 120 Hz and moves in Look mode', async () => {
    const slow = await camera(), fast = await camera();
    slow.queueScroll(2, false); fast.queueScroll(2, false);
    advance(slow, .4, 12, false); advance(fast, .4, 48, false);
    expect(slow.state[5]).toBeCloseTo(fast.state[5], 5);
    fast.set(initial); fast.queueScroll(2, true); fast.tick(2, true);
    expect(fast.state[2]).toBeCloseTo(.3, 6); expect(fast.state[5]).toBe(3); expect(fast.active).toBe(false);
  });
  it('integrates keyboard acceleration and release independently of repeat/frame rate', async () => {
    const slow = await camera(), fast = await camera();
    for (const value of [slow, fast]) value.key('KeyW', true);
    advance(slow, 1, 10); advance(fast, 1, 100);
    const expected = .75 * (1 - .065 * (1 - Math.exp(-1 / .065)));
    expect(displacement(slow)).toBeCloseTo(expected, 5); expect(displacement(fast)).toBeCloseTo(expected, 5);
    for (const value of [slow, fast]) value.key('KeyW', false);
    advance(slow, .5, 5); advance(fast, .5, 50);
    expect(displacement(slow)).toBeCloseTo(displacement(fast), 5);
    expect(displacement(fast)).toBeGreaterThan(expected);
    advance(fast, 1, 100); expect(fast.active).toBe(false);
  });
  it('normalizes diagonal travel and applies Shift tenfold and Alt one tenth', async () => {
    const straight = await camera(), diagonal = await camera(), accelerated = await camera(), precise = await camera();
    straight.key('KeyW', true); diagonal.key('KeyW', true); diagonal.key('KeyD', true);
    accelerated.key('KeyW', true, true); precise.key('KeyW', true, false, true);
    for (const value of [straight, diagonal, accelerated, precise]) advance(value, .5, 30);
    expect(displacement(diagonal)).toBeCloseTo(displacement(straight), 6);
    expect(displacement(accelerated) / displacement(straight)).toBeCloseTo(10, 5);
    expect(displacement(precise) / displacement(straight)).toBeCloseTo(.1, 6);
    expect(diagonal.state[0]).toBeGreaterThan(0); expect(diagonal.state[2]).toBeGreaterThan(0);
  });
  it('arrows turn at native speed while preserving the Orbit or Look pivot', async () => {
    const orbit = await camera(), look = await camera(), eye = Array.from(look.eye);
    orbit.key('ArrowRight', true); look.key('ArrowRight', true);
    advance(orbit, .5, 30, false); advance(look, .5, 30, true);
    const expected = -Math.PI / 2 * (.5 - .065 * (1 - Math.exp(-.5 / .065)));
    expect(orbit.state[3]).toBeCloseTo(expected, 5); expect(look.state[3]).toBeCloseTo(expected, 5);
    expect(orbit.state.slice(0, 3)).toEqual([0, 0, 0]);
    Array.from(look.eye).forEach((coordinate, i) => expect(coordinate).toBeCloseTo(eye[i], 5));
  });
  it('cancels input without a tail, isolates controllers and bounds a delayed key frame', async () => {
    const first = await camera(), second = await camera();
    first.key('KeyW', true); second.queueScroll(1, false); first.tick(10, true);
    const expected = .75 * (.1 - .065 * (1 - Math.exp(-.1 / .065)));
    expect(displacement(first)).toBeCloseTo(expected, 6);
    first.clearInput(); const stopped = first.state;
    expect(first.active).toBe(false); expect(second.active).toBe(true);
    expect(first.tick(.1, true)).toBe(false); expect(first.state).toEqual(stopped);
    second.set(initial); expect(second.active).toBe(false);
    expect(second.key('KeyB', true)).toBe(false); expect(second.tick(NaN, true)).toBe(false);
  });
  it('maps browser input without stealing primary shortcuts or quantizing trackpads', () => {
    expect(navigationKey('KeyW')).toBe(0); expect(navigationKey('ArrowDown')).toBe(10);
    expect(navigationKey('KeyB')).toBeUndefined(); expect(translationKey('Space')).toBe(true); expect(translationKey('ArrowLeft')).toBe(false);
    expect(wheelTicks(-100, 0)).toBe(1); expect(wheelTicks(-3, 1)).toBe(1); expect(wheelTicks(-1, 2)).toBe(1);
    expect(wheelTicks(-.125, 0)).toBe(.00125); expect(wheelTicks(NaN, 0)).toBe(0);
  });
});
