import { describe, expect, it, vi } from 'vitest';
import { IDENTITY_ALIGNMENT_FRAME, validateSimilarityAlignmentFrame, type AlignmentFrame } from '../src/document/alignment';
import type { AlignmentSummary } from '../src/document/alignmentProtocol';
import { MAX_ALIGNMENT_VIEW_CHECKPOINTS, prepareAlignmentView, replaceAlignmentDefaultRolls, resetAlignmentActiveRolls,
  type AlignmentViewCheckpoint, type AlignmentViewCheckpoints } from '../src/document/alignmentViews';

// Metadata ownership tests with deliberate transport doubles. These do not
// qualify native frame arithmetic, Camera reconstruction, or captured R0 math.
function frame(x = 0, scale = 1): AlignmentFrame {
  const value = [...IDENTITY_ALIGNMENT_FRAME]; value[0] = value[5] = value[10] = scale; value[12] = x;
  return validateSimilarityAlignmentFrame(value);
}
function summary(branchId: number, value = frame(), retainedBranchIds: readonly number[] = [0, branchId]): AlignmentSummary {
  return Object.freeze({ version: 2, branchId, frame: value, canReset: branchId !== 0,
    retainedBranchIds: Object.freeze([...new Set(retainedBranchIds)].sort((a, b) => a - b)) });
}
function camera(roll = .375, x = 10) {
  return Object.freeze([x, 2, 3, .25, -.125, 9, 2, 55, 1, roll, 1.5].map(Math.fround));
}
function checkpoint(branchId: number, activeRoll: number, defaultRoll: number, corrected = false, value = frame()): AlignmentViewCheckpoint {
  return Object.freeze({ branchId, frame: value, activeRoll: Math.fround(activeRoll), defaultRoll: Math.fround(defaultRoll), corrected });
}
function snapshot(checkpoints: AlignmentViewCheckpoints) { return [...checkpoints].map(([id, value]) => [id, { ...value }]); }
function transport() {
  const frameChange = vi.fn((before: readonly number[], after: readonly number[]) => {
    const result = [...IDENTITY_ALIGNMENT_FRAME]; result[12] = Math.fround(after[12] - before[12]); return result;
  });
  // The known changes let assertions distinguish freshly carried navigation
  // from cached intentional rolls without using a camera numerical oracle.
  const transform = vi.fn((state: readonly number[], delta: readonly number[], _policy?: number) => {
    const result = [...state]; result[0] += delta[12]; result[3] += .125; result[5] += 2; result[7] += 3; result[9] += .125;
    return result;
  });
  return { frameChange, transform };
}

describe('alignment view checkpoint ownership using transport doubles', () => {
  it('skips only the same frame and branch without allocating or transporting views', () => {
    const before = summary(2), checkpoints = new Map([[2, checkpoint(2, .25, -.25, true)]]), input = snapshot(checkpoints), native = transport();
    expect(prepareAlignmentView(before, { ...before }, camera(), camera(-.125), checkpoints, native.transform, native.frameChange)).toBeNull();
    expect(native.transform).not.toHaveBeenCalled(); expect(native.frameChange).not.toHaveBeenCalled(); expect(snapshot(checkpoints)).toEqual(input);
  });
  it('records independent source and target rolls for explicit PreserveView', () => {
    const old = checkpoint(0, .875, -.75), checkpoints = new Map([[0, old]]), native = transport();
    const result = prepareAlignmentView(summary(0), summary(1, frame(3)), camera(), camera(-.125), checkpoints, native.transform, native.frameChange, 0)!;
    expect(result.checkpoints.get(0)).toMatchObject({ activeRoll: .375, defaultRoll: -.125, corrected: false });
    expect(result.checkpoints.get(1)).toMatchObject({ activeRoll: .5, defaultRoll: 0, corrected: false });
    expect(result.active[0]).toBe(13); expect(result.defaultCamera[0]).toBe(13);
    expect(checkpoints.get(0)).toBe(old); expect(old.activeRoll).toBe(.875); expect(checkpoints.size).toBe(1);
    expect(Object.isFrozen(result.checkpoints.get(0))).toBe(true); expect(Object.isFrozen(result.checkpoints.get(1))).toBe(true);
  });
  it('applies WorldUpright to equal-frame divergent branches while retaining the source intentional rolls', () => {
    const value = frame(), native = transport(), checkpoints = new Map([[0, checkpoint(0, .5, .25)]]);
    const result = prepareAlignmentView(summary(0, value), summary(1, value), camera(.625), camera(-.375), checkpoints, native.transform, native.frameChange, 1)!;
    expect(native.transform).toHaveBeenCalledTimes(2); expect(result.active[9]).toBe(0); expect(result.defaultCamera[9]).toBe(0);
    expect(result.checkpoints.get(0)).toMatchObject({ activeRoll: .625, defaultRoll: -.375, corrected: false });
    expect(result.checkpoints.get(1)).toMatchObject({ activeRoll: 0, defaultRoll: 0, corrected: true });
  });
  it('keeps correction lineage through subsequent Center and Scale PreserveView operations', () => {
    const native = transport(), base = summary(0), aligned = summary(1), centered = summary(2, frame(4), [0, 1, 2]);
    const scaled = summary(3, frame(4, 2), [0, 1, 2, 3]);
    const orientation = prepareAlignmentView(base, aligned, camera(), camera(-.125), new Map(), native.transform, native.frameChange, 1)!;
    const center = prepareAlignmentView(aligned, centered, camera(.75), camera(-.25), orientation.checkpoints, native.transform, native.frameChange, 0)!;
    const scale = prepareAlignmentView(centered, scaled, camera(.875), camera(.125), center.checkpoints, native.transform, native.frameChange, 0)!;
    expect(center.checkpoints.get(1)).toMatchObject({ activeRoll: .75, defaultRoll: -.25, corrected: true });
    expect(center.active[9]).toBe(.875); expect(center.defaultCamera[9]).toBe(-.125);
    expect(scale.checkpoints.get(2)).toMatchObject({ activeRoll: .875, defaultRoll: .125, corrected: true });
    expect(scale.checkpoints.get(3)).toMatchObject({ activeRoll: 1, defaultRoll: .25, corrected: true });
    expect(orientation.checkpoints.get(1)?.activeRoll).toBe(0);
  });
  it.each([
    { action: 'Undo', source: 3, target: 2, sourceCorrected: true, targetCorrected: false },
    { action: 'Redo', source: 2, target: 3, sourceCorrected: false, targetCorrected: true },
    { action: 'Reset', source: 3, target: 0, sourceCorrected: true, targetCorrected: false },
  ])('$action carries current navigation and independently restores cached active/default rolls', value => {
    const sourceFrame = frame(-1), targetFrame = frame(2), native = transport();
    const source = checkpoint(value.source, .125, .25, value.sourceCorrected, sourceFrame);
    const target = checkpoint(value.target, -.625, .875, value.targetCorrected, targetFrame);
    const checkpoints = new Map([[value.source, source], [value.target, target]]), input = snapshot(checkpoints);
    const active = camera(.75, 30), defaultCamera = camera(-.375, 50), retained = [0, value.source, value.target];
    const result = prepareAlignmentView(summary(value.source, sourceFrame, retained), summary(value.target, targetFrame, retained),
      active, defaultCamera, checkpoints, native.transform, native.frameChange)!;
    expect(result.active).toEqual([33, 2, 3, .375, -.125, 11, 2, 58, 1, -.625, 1.5]);
    expect(result.defaultCamera).toEqual([53, 2, 3, .375, -.125, 11, 2, 58, 1, .875, 1.5]);
    expect(result.checkpoints.get(value.source)).toBe(source); expect(result.checkpoints.get(value.target)).toBe(target);
    expect(snapshot(checkpoints)).toEqual(input); expect(active[9]).toBe(.75); expect(defaultCamera[9]).toBe(-.375);
  });
  it('keeps current reconstructed roll on uncorrected history instead of restoring unrelated cached roll', () => {
    const native = transport(), checkpoints = new Map([[1, checkpoint(1, .875, .875)], [2, checkpoint(2, -.625, -.625)]]);
    const result = prepareAlignmentView(summary(1, frame(), [1, 2]), summary(2, frame(3), [1, 2]), camera(.375), camera(.125),
      checkpoints, native.transform, native.frameChange)!;
    expect(result.active[9]).toBe(.5); expect(result.defaultCamera[9]).toBe(.25);
    expect(result.checkpoints.get(2)?.activeRoll).toBe(-.625);
  });
  it('prunes abandoned identities using actual retained metadata while keeping initial branch zero', () => {
    const checkpoints = new Map([0, 1, 4, 9].map(id => [id, checkpoint(id, .25, .5)] as const)), input = snapshot(checkpoints), native = transport();
    const result = prepareAlignmentView(summary(1, frame(), [0, 1, 4, 9]), summary(2, frame(3), [1, 2, 4]),
      camera(), camera(-.125), checkpoints, native.transform, native.frameChange, 0)!;
    expect([...result.checkpoints.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 4]); expect(snapshot(checkpoints)).toEqual(input);
  });
  it('admits exactly34 checkpoints and refuses the next identity without modifying the input map', () => {
    const native = transport(), entries = Array.from({ length: MAX_ALIGNMENT_VIEW_CHECKPOINTS }, (_, id) => [id, checkpoint(id, .25, .5, false, frame(id === 33 ? 1 : 0))] as const);
    const checkpoints = new Map(entries), input = snapshot(checkpoints), retained = Array.from({ length: 35 }, (_, id) => id);
    const within = prepareAlignmentView(summary(32, frame(), retained), summary(33, frame(1), retained), camera(), camera(-.125),
      checkpoints, native.transform, native.frameChange, 0)!;
    expect(within.checkpoints.size).toBe(34);
    expect(() => prepareAlignmentView(summary(33, frame(1), retained), summary(34, frame(2), retained), camera(), camera(-.125),
      checkpoints, native.transform, native.frameChange, 0)).toThrow('alignment camera history is full');
    expect(snapshot(checkpoints)).toEqual(input); expect(checkpoints.size).toBe(34);
  });
  it('leaves the entire map and caller poses unchanged if default transport refuses after active transport', () => {
    const native = transport(), checkpoints = new Map([[0, checkpoint(0, .25, .5)]]), input = snapshot(checkpoints);
    const active = camera(), defaultCamera = camera(-.125), output = [...active];
    native.transform.mockImplementationOnce(() => output).mockImplementationOnce(() => { throw new Error('default transport refused'); });
    expect(() => prepareAlignmentView(summary(0), summary(1, frame(3)), active, defaultCamera, checkpoints,
      native.transform, native.frameChange, 1)).toThrow('default transport refused');
    expect(snapshot(checkpoints)).toEqual(input); expect(active).toEqual(camera()); expect(defaultCamera).toEqual(camera(-.125));
  });
  it('replaces default rolls atomically in checkpoint iteration order without changing active intent or correction flags', () => {
    const checkpoints = new Map([[5, checkpoint(5, .25, .5, true, frame(2))], [0, checkpoint(0, -.25, -.5)], [12, checkpoint(12, .75, .125, true, frame(4, 2))]]);
    const input = snapshot(checkpoints), result = replaceAlignmentDefaultRolls(checkpoints, [-.375, .625, Math.PI]);
    expect([...result.keys()]).toEqual([5, 0, 12]); expect([...result.values()].map(value => value.defaultRoll)).toEqual([-.375, .625, Math.fround(Math.PI)]);
    for (const [id, value] of result) {
      expect(value.frame).toBe(checkpoints.get(id)!.frame); expect(value.activeRoll).toBe(checkpoints.get(id)!.activeRoll);
      expect(value.corrected).toBe(checkpoints.get(id)!.corrected); expect(Object.isFrozen(value)).toBe(true);
    }
    expect(snapshot(checkpoints)).toEqual(input);
  });
  it.each([{ rolls: [.25] }, { rolls: [.25, NaN] }, { rolls: [.25, Infinity] }, { rolls: [.25, Number.MAX_VALUE] }])('refuses invalid default-roll batch$rolls without partial mutation', ({ rolls }) => {
    const checkpoints = new Map([[0, checkpoint(0, .25, .5)], [1, checkpoint(1, -.25, -.5, true)]]), input = snapshot(checkpoints);
    expect(() => replaceAlignmentDefaultRolls(checkpoints, rolls)).toThrow('valid alignment roll checkpoints'); expect(snapshot(checkpoints)).toEqual(input);
  });
  it('ResetCamera replaces every active checkpoint roll from its default while preserving frame/default/corrected and the input map', () => {
    const checkpoints = new Map([[0, checkpoint(0, .25, -.5)], [2, checkpoint(2, -.75, .625, true, frame(3))]]), input = snapshot(checkpoints);
    const reset = resetAlignmentActiveRolls(checkpoints);
    for (const [id, value] of reset) {
      const previous = checkpoints.get(id)!; expect(value.activeRoll).toBe(previous.defaultRoll);
      expect(value.defaultRoll).toBe(previous.defaultRoll); expect(value.frame).toBe(previous.frame); expect(value.corrected).toBe(previous.corrected);
      expect(value).not.toBe(previous); expect(Object.isFrozen(value)).toBe(true);
    }
    expect(snapshot(checkpoints)).toEqual(input); expect([...reset.keys()]).toEqual([...checkpoints.keys()]);
  });
});
