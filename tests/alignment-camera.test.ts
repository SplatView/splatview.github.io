import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { alignmentFrameChange, cameraStateFromOriginal, cameraStateToOriginal, carryCameraState,
  IDENTITY_ALIGNMENT_FRAME, inverseAlignmentFrame, transformAlignmentPoint, validateAlignmentFrame,
  validateCenterAlignmentFrame, validateCenterScaleAlignmentFrame, validateSimilarityAlignmentFrame, validateAlignmentMatrix,
  prepareDefaultRolls, type AlignmentCameraPolicy } from '../src/document/alignment';
import { CameraController, type CameraModule } from '../src/input/camera';
import type { ModuleFactory } from '../src/workers/wasm';
import { savedViewCameraState, savedViewFromCamera } from '../src/io/savedView';
import reference from './fixtures/alignment-camera-reference.json';
import scaleReference from './fixtures/alignment-scale-reference.json';
import planeReference from './fixtures/alignment-plane-reference.json';

const identity = () => [...IDENTITY_ALIGNMENT_FRAME];
function translation(x: number, y: number, z: number) { const result = identity(); result.splice(12, 3, x, y, z); return result; }
const camera = () => [4, -2, 8, .5, -.25, 12, 3, 53, 1, .3, 1.6].map(Math.fround);
let factory: ModuleFactory<CameraModule>;
const instances: CameraController[] = [];
beforeAll(async () => {
  factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default;
});
afterEach(() => { for (const instance of instances.splice(0)) instance.dispose(); });
async function nativeCamera() { const value = await CameraController.create(factory); instances.push(value); return value; }
// Emitted by compiling actual captured Windows R0 camera.cpp; the driver and hash receipt
// are .build/alignment-camera-reference-draft-01. SSE/WASM comparison uses R0's 2e-5 tolerance.
function matchesReference(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(expected[index]))));
}
function matchesSourcePose(native: CameraController, actual: readonly number[], expected: {
  state: readonly number[]; view: readonly number[]; projection: readonly number[]; eye: readonly number[];
}) {
  expect(actual).toHaveLength(expected.state.length);
  actual.forEach((value, index) => {
    const difference = value - expected.state[index];
    // atan2 can select opposite signed-zero endpoints at the +/-pi cut.
    // View/eye/projection below independently check the physical pose.
    const distance = index === 3 || index === 9 ? Math.abs(Math.atan2(Math.sin(difference), Math.cos(difference))) : Math.abs(difference);
    expect(distance).toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(expected.state[index])));
  });
  native.set([...actual]);
  matchesReference(Array.from(native.view), expected.view); matchesReference(Array.from(native.projection), expected.projection);
  matchesReference(Array.from(native.eye), expected.eye);
}

describe('actual pinned Scale frame and camera source calibration', () => {
  it.each(scaleReference.cases)('$name yUp=$yUp carries raw native frames, source views and later orbit/zoom', async example => {
    const native = await nativeCamera(), frameChange = native.frameChange.bind(native), transform = native.transformState.bind(native);
    const before = Object.freeze([...example.beforeFrame]), after = Object.freeze([...example.nextFrame]), input = Object.freeze([...example.inputCamera.state]);
    const delta = frameChange(before, after);
    delta.forEach((value, index) => expect(Math.abs(value - example.delta[index])).toBeLessThanOrEqual(2e-5 * Math.max(1e-12, Math.abs(example.delta[index]))));
    const carried = carryCameraState(input, before, after, transform, frameChange);
    matchesReference(carried, example.carriedCamera.state);
    for (const index of [5, 6]) expect(Math.abs(carried[index] / example.carriedCamera.state[index] - 1)).toBeLessThan(2e-5);
    const source = cameraStateToOriginal(carried, after, transform, frameChange), restored = cameraStateFromOriginal(source, after, transform, frameChange);
    matchesReference(source, example.sourceCamera.state); matchesReference(restored, example.restoredCamera.state);
    native.set(carried); native.orbit(11, -7); native.zoom(.8);
    matchesReference(native.state, example.afterOrbitZoom.state); matchesReference(Array.from(native.eye), example.afterOrbitZoom.eye);
    expect(before).toEqual(example.beforeFrame); expect(after).toEqual(example.nextFrame); expect(input).toEqual(example.inputCamera.state);
  });

  it('retains actual-source rounded initial targets and unchanged opacity/SH in the geometry oracle', () => {
    const example = scaleReference.cases.find(value => value.name === 'initial-rounded-target')!;
    expect(example.target).toBe(4.242640495300293); expect(example.requested[0]).toBe(.9999999403953552);
    expect(example.requested).not.toEqual(identity());
    for (const test of scaleReference.cases) for (const member of test.members) {
      expect(member.after.opacity).toBe(member.before.opacity); expect(member.after.sh).toEqual(member.before.sh);
    }
    expect(scaleReference.refusals).toHaveLength(5); expect(scaleReference.refusals.every(value => value.refused)).toBe(true);
  });
});

describe('actual pinned Plane frame and camera source calibration', () => {
  it.each(planeReference.planeCases)('$name yUp=$yUp flip=$flip matches source camera/frame and later navigation', async example => {
    const native = await nativeCamera(), transform = native.transformState.bind(native), change = native.frameChange.bind(native);
    const before = Object.freeze([...example.beforeFrame]), after = Object.freeze([...example.nextFrame]), input = Object.freeze([...example.inputCamera.state]);
    matchesReference(change(before, after), example.delta);
    const carried = carryCameraState(input, before, after, transform, change, 1);
    matchesSourcePose(native, carried, example.carriedCamera); expect(carried[9]).toBe(0);
    matchesSourcePose(native, carryCameraState(example.inputDefault.state, before, after, transform, change, 1), example.carriedDefault);
    const source = cameraStateToOriginal(carried, after, transform, change);
    matchesSourcePose(native, source, example.sourceCamera);
    matchesSourcePose(native, cameraStateFromOriginal(source, after, transform, change), example.restoredCamera);
    native.set(carried); native.orbit(11, -7); native.zoom(.8);
    matchesReference(native.state, example.afterOrbitZoom.state); matchesReference(Array.from(native.eye), example.afterOrbitZoom.eye);
    expect(before).toEqual(example.beforeFrame); expect(after).toEqual(example.nextFrame); expect(input).toEqual(example.inputCamera.state);
  });

  it.each(planeReference.defaultLineage)('$name yUp=$yUp matches actual source orientation-only default transport', async example => {
    const native = await nativeCamera(), transform = native.transformState.bind(native), orientation = native.orientationFrameChange.bind(native);
    const input = Object.freeze([...example.viewState]), before = Object.freeze([...example.beforeFrame]), after = Object.freeze([...example.afterFrame]);
    if (!example.sameFrameSkipped) matchesReference(orientation(before, after), example.delta!);
    const state = native.state, revision = native.revision;
    const rolls = prepareDefaultRolls(input, before, [after], transform, orientation);
    expect(Math.abs(rolls[0] - example.defaultRoll)).toBeLessThanOrEqual(2e-5);
    expect(Object.isFrozen(rolls)).toBe(true); expect(native.state).toEqual(state); expect(native.revision).toBe(revision);
    if (example.sameFrameSkipped) expect(rolls[0]).toBe(input[9]);
    if (example.name === 'usable-frames-full-change-overflows') {
      expect(() => validateSimilarityAlignmentFrame(before)).not.toThrow();
      expect(() => validateSimilarityAlignmentFrame(after)).not.toThrow();
      expect(() => native.frameChange(before, after)).toThrow('valid frame change');
    }
  });

  it.each(planeReference.rollLineage)('yUp=$yUp matches actual Viewer carry/default math through policy and history', async example => {
    const native = await nativeCamera(), transform = native.transformState.bind(native), change = native.frameChange.bind(native);
    for (const step of example.steps) {
      const policy = step.policy < 0 ? 0 : step.policy as AlignmentCameraPolicy;
      const active = carryCameraState(step.inputCamera.state, step.beforeFrame, step.afterFrame, transform, change, policy);
      const defaults = carryCameraState(step.inputDefault.state, step.beforeFrame, step.afterFrame, transform, change, policy);
      // Source checkpoints supply intentional roll; root's controller tests own
      // checkpoint bookkeeping. This comparison qualifies the native pose carry.
      if (step.policy < 0 && (step.sourceCheckpoint.corrected || step.targetCheckpoint.corrected)) {
        active[9] = step.targetCheckpoint.activeRoll; defaults[9] = step.targetCheckpoint.defaultRoll;
      }
      matchesReference(active, step.carriedCamera.state);
      // R0 defaultCamera fits current Scene radius; geometry/owner tests qualify
      // that radius separately from these pure native transformation fixtures.
      matchesReference(defaults.filter((_value, index) => index !== 6), step.carriedDefault.state.filter((_value, index) => index !== 6));
    }
    const update = example.rememberDefault;
    const rolls = prepareDefaultRolls(update.viewState, update.currentFrame,
      update.beforeCheckpoints.map(value => value.frame), transform, native.orientationFrameChange.bind(native));
    rolls.forEach((roll, index) => expect(Math.abs(roll - update.afterCheckpoints[index].defaultRoll)).toBeLessThanOrEqual(2e-5));
    expect(update.afterCheckpoints.map(value => value.activeRoll)).toEqual(update.beforeCheckpoints.map(value => value.activeRoll));
    expect(example.resetCamera.checkpoints.every(value => value.activeRoll === value.defaultRoll)).toBe(true);
    const current = example.snapCamera.checkpoints.find(value => value.branchId === example.snapCamera.currentBranchId)!;
    expect(current.activeRoll).toBe(0);
    for (const other of example.snapCamera.checkpoints.filter(value => value.branchId !== current.branchId))
      expect(other.activeRoll).toBe(example.resetCamera.checkpoints.find(value => value.branchId === other.branchId)!.activeRoll);
  });

  it('preserves the independently reexecuted sealed Scale source corpus', () => {
    expect(planeReference.preservedScale).toEqual(scaleReference);
    expect(planeReference.planeCases).toHaveLength(24); expect(planeReference.refusals).toHaveLength(5);
    expect(planeReference.refusals.every(value => value.normalRefused && value.alignmentRefused)).toBe(true);
  });
});

describe('captured C++ camera reconstruction through ABI2', () => {
  it.each(reference.cases)('$name yUp=$yUp policy=$policy matches actual pinned source', async example => {
    const native = await nativeCamera(), input = Object.freeze([...example.input.state]), frame = Object.freeze([...example.frame]);
    const result = native.transformState(input, frame, example.policy as AlignmentCameraPolicy);
    matchesReference(result, example.native.state);
    for (const index of [0, 1, 2, 6, 7, 8, 10]) expect(result[index]).toBe(example.native.state[index]);
    native.set(result); native.orbit(11, -7); native.zoom(.8);
    matchesReference(native.state, example.nativeAfterOrbitZoom.state);
    matchesReference(Array.from(native.eye), example.nativeAfterOrbitZoom.eye);
    expect(input).toEqual(example.input.state); expect(frame).toEqual(example.frame);
  });

  it('reconstructs material float32 eye-focus loss and preserves the resulting orbit behavior', async () => {
    const native = await nativeCamera(), example = reference.cases.find(value => value.name === 'mantissa-translation' && value.yUp && !value.policy)!;
    const result = carryCameraState(example.input.state, identity(), example.frame, (state, frame) => native.transformState(state, frame),
      (before, after) => native.frameChange(before, after));
    expect(result[3]).toBeCloseTo(.6496565341949463, 5); expect(result[5]).toBeCloseTo(3.3062608242034912, 5);
    expect(Math.abs(result[3] - example.retained.state[3])).toBeGreaterThan(.14);
    native.set(result); native.orbit(11, -7); native.zoom(.8);
    matchesReference(native.state, example.nativeAfterOrbitZoom.state);
    expect(Math.abs(native.state[5] - example.retainedAfterOrbitZoom.state[5])).toBeGreaterThan(.27);
  });

  it('leaves live state, matrices, revision, background and pending navigation untouched and detaches output', async () => {
    const native = await nativeCamera(); native.set(camera()); native.cycleBackground(); native.key('KeyW', true); native.queueScroll(.5, false);
    const live = () => ({ state: native.state, view: Array.from(native.view), projection: Array.from(native.projection),
      eye: Array.from(native.eye), revision: native.revision, background: native.background, active: native.active });
    const before = live(), input = Object.freeze(camera()), matrix = Object.freeze(translation(-3, 5, -2));
    const result = native.transformState(input, matrix); expect(result).not.toBe(input); result[0] = 700;
    expect(live()).toEqual(before); expect(input).toEqual(camera()); expect(matrix).toEqual(translation(-3, 5, -2));
    expect(native.tick(.05, true)).toBe(true);
  });

  it('refuses malformed or collapsed states, unsupported native transforms and policies without live mutation', async () => {
    const native = await nativeCamera(), state = native.state, revision = native.revision;
    const invalid: unknown[] = [new Array(11), camera().slice(0, 10), [...camera(), 0],
      camera().map((value, index) => index === 0 ? Infinity : value),
      camera().map((value, index) => index === 8 ? 2 : value),
      camera().map((value, index) => index === 5 ? 0 : value),
      camera().map((value, index) => index === 10 ? 0 : value)];
    for (const input of invalid) expect(() => native.transformState(input as number[], identity())).toThrow();
    const getter = camera(); Object.defineProperty(getter, '0', { get: () => { throw new Error('getter ran'); } });
    expect(() => native.transformState(getter, identity())).toThrow('Invalid camera transform state');
    const shear = identity(); shear[1] = .25; expect(() => native.transformState(camera(), shear)).toThrow('valid camera');
    const collapse = [0, 0, 0, .5, 0, 3, 1, 55, 1, 0, 1];
    expect(() => native.transformState(collapse, translation(2 ** 30, 2 ** 30, 2 ** 30))).toThrow('valid camera');
    expect(() => native.transformState(camera(), identity(), 2 as AlignmentCameraPolicy)).toThrow('policy');
    expect(native.state).toEqual(state); expect(native.revision).toBe(revision);
    native.dispose(); expect(() => native.transformState(camera(), identity())).toThrow('disposed');
  });

  it('uses captured validation without imposing new UI FOV or pitch limits', async () => {
    const native = await nativeCamera(), state = camera(); state[7] = 5; state[4] = 2;
    const result = native.transformState(state, identity()); expect(result[7]).toBe(5); expect(result[10]).toBe(state[10]);
    expect(result.every(Number.isFinite)).toBe(true);
  });
});

describe('Center camera coordinate ownership', () => {
  it('passes a detached current state and exact float32 old-frame inverse times new-frame to the native owner', () => {
    const current = Object.freeze(camera()), oldFrame = Object.freeze(translation(-.20000000298023224, 0, 0)), next = Object.freeze(translation(-.30000001192092896, 0, 0));
    const callback = vi.fn((state: readonly number[], delta: readonly number[]) => {
      expect(state).not.toBe(current); expect(delta).toEqual(translation(-.10000000894069672, 0, 0));
      return [9, -16, 12, .75, -.45, 8.5, 3, 68, 1, -.4, current[10]];
    });
    const change = vi.fn((before: readonly number[], after: readonly number[]) => {
      expect(before).not.toBe(oldFrame); expect(after).not.toBe(next); return translation(-.10000000894069672, 0, 0);
    });
    expect(carryCameraState(current, oldFrame, next, callback, change)).toEqual([9, -16, 12, .75, -.45, 8.5, 3, 68, 1, -.4, current[10]].map(Math.fround));
    expect(change).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce(); expect(current).toEqual(camera());
  });

  it('reconstructs history including equal matrices while original-source identity conversion skips', () => {
    const state = camera(), callback = vi.fn(() => [...state]), change = vi.fn(() => identity());
    carryCameraState(state, identity(), identity(), callback, change); expect(callback).toHaveBeenCalledOnce();
    expect(cameraStateToOriginal(state, identity(), callback, change)).toEqual(state);
    expect(cameraStateFromOriginal(state, identity(), callback, change)).toEqual(state);
    expect(callback).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledOnce();
  });

  it('carries current navigation through two Centers and Undo with independent active/default owners', async () => {
    const native = await nativeCamera(), transform = (state: readonly number[], frame: readonly number[]) => native.transformState(state, frame),
      frameChange = (before: readonly number[], after: readonly number[]) => native.frameChange(before, after);
    const first = translation(-4, 6, -8), second = translation(-2, 1, -9), initial = camera(), defaultCamera = [0, 0, 0, 0, 0, 18, 6, 45, 0, 0, 1];
    const centered = carryCameraState(initial, identity(), first, transform, frameChange), centeredDefault = carryCameraState(defaultCamera, identity(), first, transform, frameChange);
    expect(centered.slice(0, 3)).toEqual([0, 4, 0]); expect(centeredDefault.slice(0, 3)).toEqual([-4, 6, -8]);
    native.set(centered); native.orbit(11, -7); native.pan(8, -4); native.zoom(.8); native.lens(10); const current = native.state;
    const secondCamera = carryCameraState(current, first, second, transform, frameChange);
    matchesReference(secondCamera, native.transformState(current, translation(2, -5, -1)));
    const undone = carryCameraState(secondCamera, second, first, transform, frameChange); matchesReference(undone, current); expect(undone).not.toEqual(initial);
    matchesReference(carryCameraState(centeredDefault, first, identity(), transform, frameChange), defaultCamera);
  });

  it('normalizes saved views through the native owner and restores into the current source frame', async () => {
    const native = await nativeCamera(), transform = (state: readonly number[], frame: readonly number[]) => native.transformState(state, frame),
      frameChange = (before: readonly number[], after: readonly number[]) => native.frameChange(before, after);
    const original = camera(), first = translation(-3, 5, -2), next = translation(9, -4, 7);
    const edited = cameraStateFromOriginal(original, first, transform, frameChange), source = cameraStateToOriginal(edited, first, transform, frameChange);
    const saved = savedViewFromCamera(source, 'gray'); expect(saved.target).toEqual([4, -2, 8]); expect(saved.background).toBe('gray');
    const restored = cameraStateFromOriginal(savedViewCameraState(saved, 2.25), next, transform, frameChange);
    expect(restored.slice(0, 3)).toEqual([13, -6, 15]); expect(restored[10]).toBe(2.25);
    matchesReference(cameraStateToOriginal(restored, next, transform, frameChange).slice(0, 10), original.slice(0, 10));
  });

  it('rejects an invalid native result or changed aspect and propagates refusal without altering inputs', () => {
    const state = Object.freeze(camera()), matrix = Object.freeze(translation(-3, 5, -2));
    expect(() => carryCameraState(state, identity(), matrix, () => { throw new Error('native refusal'); }, alignmentFrameChange)).toThrow('native refusal');
    expect(() => carryCameraState(state, identity(), matrix, () => new Array(11), alignmentFrameChange)).toThrow('camera');
    expect(() => carryCameraState(state, identity(), matrix, () => [...state.slice(0, 10), 2], alignmentFrameChange)).toThrow('aspect');
    expect(state).toEqual(camera()); expect(matrix).toEqual(translation(-3, 5, -2));
  });
  it('joins frame refusal before preparing a camera and never replaces native delta with JS inversion', () => {
    const transform = vi.fn(() => camera()), scaled = [3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, .25, -.3, .75, 1];
    expect(() => carryCameraState(camera(), identity(), scaled, transform, () => { throw new Error('native frame refusal'); })).toThrow('native frame refusal');
    expect(() => carryCameraState(camera(), identity(), scaled, transform, () => new Array(16))).toThrow('matrix');
    expect(transform).not.toHaveBeenCalled();
  });
});

describe('validated alignment frame math', () => {
  it('uses row-vector composition order for source/current frame changes', () => {
    const oldFrame = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 4, -2, 8, 1], next = translation(-3, 5, -2);
    const editedPoint = transformAlignmentPoint([2, 3, 5], oldFrame); expect(editedPoint).toEqual([1, 0, 13]);
    expect(transformAlignmentPoint(editedPoint, inverseAlignmentFrame(oldFrame))).toEqual([2, 3, 5]);
    expect(transformAlignmentPoint(editedPoint, alignmentFrameChange(oldFrame, next))).toEqual([-1, 8, 3]);
    expect(alignmentFrameChange(translation(-4, 6, -8), translation(-2, 1, -9))).toEqual(translation(2, -5, -1));
  });

  it.each([
    [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
    [1, .25, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  ].map(matrix => ({ matrix })))('refuses shear, nonuniform scale and reflection before calling the camera owner %#', ({ matrix }) => {
    const callback = vi.fn(() => camera()); expect(() => validateAlignmentFrame(matrix)).not.toThrow();
    expect(() => validateCenterAlignmentFrame(matrix)).toThrow('Only translation');
    expect(() => carryCameraState(camera(), identity(), matrix, callback, alignmentFrameChange)).toThrow(/uniform|shear|rotation/);
    expect(() => cameraStateToOriginal(camera(), matrix, callback, alignmentFrameChange)).toThrow(/uniform|shear|rotation/);
    expect(() => cameraStateFromOriginal(camera(), matrix, callback, alignmentFrameChange)).toThrow(/uniform|shear|rotation/); expect(callback).not.toHaveBeenCalled();
  });

  it('admits proper uniformly scaled rotations and forwards WorldUpright to the native authority', () => {
    const rotated = [0, 2, 0, 0, -2, 0, 0, 0, 0, 0, 2, 0, 4, -2, 8, 1];
    expect(validateSimilarityAlignmentFrame(rotated)).toEqual(rotated);
    const transform = vi.fn((state: readonly number[], _delta: readonly number[], policy?: AlignmentCameraPolicy) => {
      expect(policy).toBe(1); const result = [...state]; result[9] = 0; return result;
    });
    const result = carryCameraState(camera(), identity(), rotated, transform, () => rotated, 1);
    expect(result[9]).toBe(0); expect(transform).toHaveBeenCalledOnce();
    expect(() => carryCameraState(camera(), identity(), rotated, transform, () => rotated, 2 as AlignmentCameraPolicy)).toThrow('policy');
  });

  it('uses captured row-length/orthogonality tolerances instead of accepting arbitrary affine frames', () => {
    const almostUniform = identity(); almostUniform[5] = Math.fround(1 + .00005);
    expect(validateSimilarityAlignmentFrame(almostUniform)).toEqual(almostUniform);
    const nonuniform = identity(); nonuniform[5] = Math.fround(1 + .0002);
    expect(() => validateSimilarityAlignmentFrame(nonuniform)).toThrow('uniform');
    const slightDot = identity(); slightDot[1] = .00005;
    expect(validateSimilarityAlignmentFrame(slightDot)).toEqual(slightDot.map(Math.fround));
    const shear = identity(); shear[1] = .0002;
    expect(() => validateSimilarityAlignmentFrame(shear)).toThrow('shear');
  });

  it('prepares default rolls with captured orientation-only Camera defaults and leaves caller owners untouched', () => {
    const view = camera(), before = [...view], rotated = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 1e12, -1e12, 1e12, 1];
    const frames = [rotated, identity()], frameInputs = frames.map(value => [...value]);
    const orientation = vi.fn((current: readonly number[], checkpoint: readonly number[]) => {
      expect(current).toEqual(rotated.map(Math.fround));
      expect([rotated.map(Math.fround), identity()]).toContainEqual(checkpoint); return identity();
    });
    const transform = vi.fn((state: readonly number[]) => {
      expect(state).toEqual([0, 0, 0, view[3], view[4], 3, 1, 45, view[8], view[9], 1].map(Math.fround));
      const result = [...state]; result[9] = .125; return result;
    });
    const rolls = prepareDefaultRolls(view, rotated, frames, transform, orientation);
    expect(rolls).toEqual([Math.fround(view[9]), .125]); expect(Object.isFrozen(rolls)).toBe(true);
    expect(orientation).toHaveBeenCalledTimes(2); expect(transform).toHaveBeenCalledOnce();
    expect(view).toEqual(before); expect(frames).toEqual(frameInputs);
  });

  it('refuses default-roll preparation as a whole without publishing partially prepared values', () => {
    const view = camera(), frames = [translation(1, 0, 0), translation(2, 0, 0)], before = JSON.stringify({ view, frames });
    let calls = 0;
    const change = () => { if (++calls === 3) throw new Error('orientation refused'); return identity(); };
    expect(() => prepareDefaultRolls(view, identity(), frames, state => [...state], change)).toThrow('orientation refused');
    expect(calls).toBe(3); expect(JSON.stringify({ view, frames })).toBe(before);
  });

  it('accepts positive uniform scene scale and preserves raw native delta homogeneous rounding', () => {
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 3, -4, 5, 1];
    expect(validateCenterScaleAlignmentFrame(scaled)).toEqual(scaled);
    const raw = [...scaled]; raw[15] = Math.fround(1 - 2 ** -24);
    expect(validateAlignmentMatrix(raw)[15]).toBe(raw[15]); expect(() => validateAlignmentFrame(raw)).toThrow('affine');
    const transform = vi.fn((_state: readonly number[], delta: readonly number[]) => { expect(delta).toEqual(raw); return camera(); });
    carryCameraState(camera(), identity(), scaled, transform, () => raw); expect(transform).toHaveBeenCalledOnce();
  });

  it('rounds float decimals, freezes a private frame and rejects malformed or unusable inverses', () => {
    const input = translation(.1, -.2, .3), parsed = validateAlignmentFrame(input);
    expect(parsed[12]).toBe(Math.fround(.1)); expect(Object.isFrozen(parsed)).toBe(true); input[12] = 7; expect(parsed[12]).toBe(Math.fround(.1));
    for (const [index, value] of [[3, .25], [15, 0], [0, 0], [0, 1e-40], [0, 1e40], [0, 1e-50], [12, Infinity]]) {
      const invalid = identity(); invalid[index] = value; expect(() => validateAlignmentFrame(invalid)).toThrow();
    }
    const overflowDet = identity(); overflowDet[0] = overflowDet[5] = overflowDet[10] = 1e20;
    expect(() => validateAlignmentFrame(overflowDet)).toThrow('frame inverse');
  });
});
