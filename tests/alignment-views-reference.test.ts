import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { CameraController, type CameraModule } from '../src/input/camera';
import type { ModuleFactory } from '../src/workers/wasm';
import { prepareDefaultRolls, validateSimilarityAlignmentFrame, type AlignmentCameraPolicy } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';
import { prepareAlignmentView, replaceAlignmentDefaultRolls, resetAlignmentActiveRolls,
  type AlignmentViewCheckpoint, type AlignmentViewCheckpoints } from '../src/document/alignmentViews';
import reference from './fixtures/alignment-plane-reference.json';

let factory: ModuleFactory<CameraModule>;
const instances: CameraController[] = [];
beforeAll(async () => {
  factory = (await import(/* @vite-ignore */ pathToFileURL(resolve('public/wasm/splatview-camera.mjs')).href)).default;
});
afterEach(() => { for (const instance of instances.splice(0)) instance.dispose(); });

// The actual captured C++ oracle executes Viewer::prepareAlignmentView /
// carryAlignmentView with explicitly retained source mock scene tokens 0..4.
// These V2 identities transport that fixture, not an invented native history.
// Actual retained native roots/pruning are qualified by separate contracts.
function summary(branchId: number, frame: readonly number[]): AlignmentSummary {
  return Object.freeze({ version: 2, branchId, frame: validateSimilarityAlignmentFrame(frame), canReset: branchId !== 0,
    retainedBranchIds: Object.freeze([0, 1, 2, 3, 4]) });
}
function matches(actual: readonly number[], expected: readonly number[], label: string) {
  expect(actual, label).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(Math.abs(value - expected[index]), `${label}[${index}]`)
    .toBeLessThanOrEqual(2e-5 * Math.max(1, Math.abs(expected[index]))));
}
type SourceCheckpoint = { branchId: number; frame: number[]; activeRoll: number; defaultRoll: number; corrected: boolean };
function checkpoint(actual: AlignmentViewCheckpoint | undefined, expected: SourceCheckpoint, label: string) {
  expect(actual, label).toBeDefined(); expect(actual!.branchId, label).toBe(expected.branchId);
  expect(actual!.frame, `${label} literal source frame`).toEqual(expected.frame);
  expect(actual!.corrected, `${label} correction lineage`).toBe(expected.corrected);
  matches([actual!.activeRoll, actual!.defaultRoll], [expected.activeRoll, expected.defaultRoll], `${label} intentional rolls`);
}
function allCheckpoints(actual: AlignmentViewCheckpoints, expected: SourceCheckpoint[], label: string) {
  expect([...actual.keys()].sort((a, b) => a - b), label).toEqual(expected.map(value => value.branchId).sort((a, b) => a - b));
  for (const entry of expected) checkpoint(actual.get(entry.branchId), entry, `${label} branch ${entry.branchId}`);
}
function detached(value: AlignmentViewCheckpoints) {
  return [...value].map(([branch, entry]) => [branch, { ...entry, frame: [...entry.frame] }]);
}

describe('alignment checkpoint module against actual captured Viewer roll-lineage output and published CAM4', () => {
  it.each(reference.rollLineage)('yUp=$yUp matches eleven source carry steps, explicit defaults and ResetCamera; web Snap excluded', async sequence => {
    const native = await CameraController.create(factory); instances.push(native);
    const transform = native.transformState.bind(native), change = native.frameChange.bind(native), orientation = native.orientationFrameChange.bind(native);
    const untouchedState = native.state, untouchedRevision = native.revision;
    let checkpoints: AlignmentViewCheckpoints = new Map();
    expect(sequence.steps).toHaveLength(12);
    expect(sequence.steps[11].name).toBe('undo-identical-frame-after-snap-other-branch-roll');
    // Snap is not implemented in the web runtime. Do not manufacture its state
    // change merely to exercise the oracle's final post-Snap history step.
    for (const step of sequence.steps.slice(0, 11)) {
      const active = Object.freeze([...step.inputCamera.state]), defaultCamera = Object.freeze([...step.inputDefault.state]);
      const before = summary(step.beforeBranchId, step.beforeFrame), after = summary(step.afterBranchId, step.afterFrame);
      if (step.name === 'new-branch-identical-current-frame') {
        // The captured sequence calls rememberDefaultView before this carry.
        // Apply the real default-lineage module to the captured default input.
        const input = detached(checkpoints), rolls = prepareDefaultRolls(defaultCamera, before.frame,
          [...checkpoints.values()].map(entry => entry.frame), transform, orientation);
        const replaced = replaceAlignmentDefaultRolls(checkpoints, rolls);
        expect(detached(checkpoints)).toEqual(input); checkpoints = replaced;
        expect(before.frame).toEqual(after.frame); expect(before.branchId).not.toBe(after.branchId);
      }
      const original = detached(checkpoints), policy = step.policy < 0 ? undefined : step.policy as AlignmentCameraPolicy;
      expect(checkpoints.size, `${step.name} source checkpoint count`).toBe(step.checkpointCountBefore);
      const result = prepareAlignmentView(before, after, active, defaultCamera, checkpoints, transform, change, policy);
      expect(result, `${step.name} must carry distinct identity`).not.toBeNull();
      matches(result!.active, step.carriedCamera.state, `${step.name} current camera`);
      // This fixture's source Viewer defaultCamera fits its retained Scene
      // radius. CAM4's full pose/radius carry is compared with the same bounded
      // SSE/WASM tolerance; real Scene/default-owner radius is tested elsewhere.
      matches(result!.defaultCamera, step.carriedDefault.state, `${step.name} current default`);
      expect(detached(checkpoints), `${step.name} input map immutable`).toEqual(original);
      expect(active).toEqual(step.inputCamera.state); expect(defaultCamera).toEqual(step.inputDefault.state);
      expect(result!.checkpoints.size, `${step.name} committed count`).toBe(step.checkpointCountAfter);
      checkpoint(result!.checkpoints.get(before.branchId), step.sourceCheckpoint, `${step.name} source`);
      checkpoint(result!.checkpoints.get(after.branchId), step.targetCheckpoint, `${step.name} target`);
      if (policy === 1) { expect(result!.active[9]).toBe(0); expect(result!.defaultCamera[9]).toBe(0); }
      if (policy === undefined && (step.sourceCheckpoint.corrected || step.targetCheckpoint.corrected)) {
        const target = result!.checkpoints.get(after.branchId)!;
        expect(result!.active[9]).toBe(target.activeRoll); expect(result!.defaultCamera[9]).toBe(target.defaultRoll);
      }
      // Carry through the actual module-produced map rather than injecting
      // source checkpoint outputs as the next input.
      checkpoints = result!.checkpoints;
    }
    const update = sequence.rememberDefault;
    allCheckpoints(checkpoints, update.beforeCheckpoints, 'before captured final rememberDefaultView');
    const input = detached(checkpoints), defaults = prepareDefaultRolls(update.viewState, update.currentFrame,
      [...checkpoints.values()].map(entry => entry.frame), transform, orientation);
    const replaced = replaceAlignmentDefaultRolls(checkpoints, defaults);
    allCheckpoints(replaced, update.afterCheckpoints, 'after captured final rememberDefaultView');
    expect(detached(checkpoints)).toEqual(input);
    for (const [branch, entry] of replaced) {
      const previous = checkpoints.get(branch)!; expect(entry.activeRoll).toBe(previous.activeRoll);
      expect(entry.corrected).toBe(previous.corrected); expect(entry.frame).toBe(previous.frame);
    }
    const saved = detached(replaced), reset = resetAlignmentActiveRolls(replaced);
    allCheckpoints(reset, sequence.resetCamera.checkpoints, 'captured ResetCamera active/default lineage');
    for (const [branch, entry] of reset) {
      const previous = replaced.get(branch)!; expect(entry.activeRoll).toBe(previous.defaultRoll);
      expect(entry.defaultRoll).toBe(previous.defaultRoll); expect(entry.corrected).toBe(previous.corrected); expect(entry.frame).toBe(previous.frame);
    }
    expect(detached(replaced)).toEqual(saved);
    expect(native.state).toEqual(untouchedState); expect(native.revision).toBe(untouchedRevision);
  });
});
