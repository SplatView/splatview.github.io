import { describe, expect, it } from 'vitest';
import { assertTransformFocusBinding, assertTransformFocusUnchanged, captureTransformFocusState, nextPivotMode, pivotPresentation,
  transformFocusPoint, validateSelectionCommitRevision, validateTransformFocusCommand } from '../src/document/transformPivot';
import { transformDefaults } from '../src/document/transformProtocol';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type NativeSummary } from '../src/document/types';

function scene(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, duplicateRange: null, loaded: true, count: 5, sourceCount: 8, shDegree: 0, format: 'PLY', kind: 0,
    selected: 2, visible: 4, canUndo: true, canRedo: false, revision: 7, contentRevision: 3,
    transaction: false, selectionDraft: false, sceneChanged: true, pending: false, progress: 1,
    floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [3, 4, 5], radius: 10, yUp: false, camera: [], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
const command = { command: 'transformFocus', scope: 'selection', revision: 7, contentRevision: 3, transformBase: null };
describe('desktop transform pivot reference protocol', () => {
  it('cycles through the exact desktop states and skips an absent selection', () => {
    expect((['scene', 'selection', 'origin', 'custom'] as const).map(mode => nextPivotMode(mode, true))).toEqual(
      ['selection', 'origin', 'scene', 'scene']);
    expect(nextPivotMode('scene', false)).toBe('origin');
    expect(pivotPresentation('scene', true)).toEqual({ icon: 'CenterPivot', tooltip: 'Pivot: scene center\nClick for selection center' });
    expect(pivotPresentation('scene', false)).toEqual({ icon: 'CenterPivot', tooltip: 'Pivot: scene center\nClick for origin (0,0,0)' });
    expect(pivotPresentation('selection', true)).toEqual({ icon: 'SelectionPivot', tooltip: 'Pivot: selection center\nClick for origin (0,0,0)' });
    expect(pivotPresentation('origin', false)).toEqual({ icon: 'OriginPivot', tooltip: 'Pivot: origin (0,0,0)\nClick for scene center' });
    expect(pivotPresentation('custom', true)).toEqual({ icon: 'PickCenter', tooltip: 'Pivot: custom\nClick for scene center' });
  });
  it('captures immutable native revisions and a copied transform tuple without view scope', () => {
    const tuple = { id: 4, baseId: 5, epoch: 6 };
    const captured = validateTransformFocusCommand({ ...command, scope: 'scene', transformBase: tuple });
    tuple.epoch++;
    expect(captured).toEqual({ ...command, scope: 'scene', transformBase: { id: 4, baseId: 5, epoch: 6 } });
    expect(Object.isFrozen(captured)).toBe(true); expect(Object.isFrozen(captured.transformBase)).toBe(true);
    expect(validateTransformFocusCommand({ ...command, revision: Number.MAX_SAFE_INTEGER })).toMatchObject({ revision: Number.MAX_SAFE_INTEGER });
  });
  it.each([
    { ...command, scope: 'visible' }, { ...command, scope: { toString: (): string => 'scene' } },
    { ...command, revision: -1 }, { ...command, revision: 1.5 }, { ...command, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...command, contentRevision: true }, { ...command, transformBase: undefined },
    { ...command, transformBase: { id: 0, baseId: 5, epoch: 0 } },
    { ...command, transformBase: { id: 1, baseId: 2, epoch: -1 } },
    { ...command, transformBase: { id: 1, baseId: 2, epoch: 0, appliedEpoch: null } },
    { ...command, selectionView: null }, { ...command, operationOwner: null }, { ...command, extra: true },
    { ...command, [Symbol('field')]: true },
  ])('refuses malformed, scoped or owned focus request %#', value => {
    expect(() => validateTransformFocusCommand(value)).toThrow('Invalid transform focus command.');
  });
  it('rejects hidden keys and accessors before evaluating them', () => {
    let reads = 0;
    const accessor = { ...command }; Object.defineProperty(accessor, 'scope', { enumerable: true, get() { reads++; return 'scene'; } });
    const hidden = { ...command }; Object.defineProperty(hidden, 'extra', { value: true });
    expect(() => validateTransformFocusCommand(accessor)).toThrow(); expect(() => validateTransformFocusCommand(hidden)).toThrow();
    expect(reads).toBe(0);
  });
  it('binds exact revisions and the retained transform tuple', () => {
    const summary = scene(); summary.transformSession = { id: 1, baseId: 2, epoch: 3, appliedEpoch: 3,
      kind: 'numeric', selectedOnly: true, appliedMatrix: transformDefaults().matrix, pivot: [1, 2, 3], gizmo: null };
    const state = captureTransformFocusState(summary);
    expect(() => assertTransformFocusBinding(validateTransformFocusCommand({ ...command, transformBase: { id: 1, baseId: 2, epoch: 3 } }), state)).not.toThrow();
    for (const patch of [{ revision: 8 }, { contentRevision: 4 }, { transformBase: null },
      { transformBase: { id: 2, baseId: 2, epoch: 3 } }, { transformBase: { id: 1, baseId: 3, epoch: 3 } },
      { transformBase: { id: 1, baseId: 2, epoch: 4 } }])
      expect(() => assertTransformFocusBinding(validateTransformFocusCommand({ ...command, transformBase: { id: 1, baseId: 2, epoch: 3 }, ...patch }), state)).toThrow('stale or busy');
  });
  it.each([{ pending: true }, { transaction: true }, { selectionDraft: true }, { pendingSelectionMapId: 3 },
    { loaded: false }, { kind: 1 }])('refuses active work %#', patch => {
    expect(() => assertTransformFocusBinding(validateTransformFocusCommand(command), captureTransformFocusState({ ...scene(), ...patch }))).toThrow('stale or busy');
  });
  it('permits per-response observations while forbidding unsolicited scene, selection and owner changes', () => {
    const summary = scene(), state = captureTransformFocusState(summary);
    expect(() => assertTransformFocusUnchanged(state, { ...summary, memoryBytes: 2048, sceneChanged: false, progress: 0, point: [1, 2, 3] })).not.toThrow();
    for (const patch of [{ revision: 8 }, { contentRevision: 4 }, { selectionCommitRevision: 1 }, { count: 4 }, { sourceCount: 9 }, { selected: 1 },
      { canUndo: false }, { canRedo: true }, { center: [4, 4, 5] as [number, number, number] }, { selectionMapId: 7 },
      { selectionMapRetainedIds: [7] }, { pending: true }, { selectionDraft: true }])
      expect(() => assertTransformFocusUnchanged(state, { ...summary, ...patch })).toThrow('changed the document');
  });
  it('permits settled retained owners and still binds every owner field to the query', () => {
    const retained: Partial<NativeSummary>[] = [
      { toleranceSessionId: 7, toleranceMapId: 8, toleranceTool: 'color', toleranceConnected: false },
      { colorSession: { version: 1, active: true, sessionId: 3, baseId: 4, epochId: 5, pending: false, selectedOnly: true,
        values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] } },
      { opacitySession: { id: 3, baseId: 4, epoch: 0, appliedEpoch: null, selectedOnly: true, appliedScale: 1 } },
    ];
    for (const patch of retained) {
      const summary = { ...scene(), ...patch }, state = captureTransformFocusState(summary);
      expect(() => assertTransformFocusBinding(validateTransformFocusCommand(command), state)).not.toThrow();
      expect(() => assertTransformFocusUnchanged(state, { ...summary, point: [1, 2, 3] })).not.toThrow();
      for (const name of Object.keys(patch)) expect(() => assertTransformFocusUnchanged(state, { ...summary, [name]: null })).toThrow('changed the document');
    }
    const colorSession = retained[1].colorSession!;
    expect(() => assertTransformFocusBinding(validateTransformFocusCommand(command),
      captureTransformFocusState({ ...scene(), colorSession: { ...colorSession, pending: true } }))).toThrow('stale or busy');
  });
  it('requires an explicit terminal point, preserves empty selection, and copies float coordinates', () => {
    const point = [Math.fround(.1), -2, 3];
    const parsed = transformFocusPoint({ point }); point[1] = 99;
    expect(parsed).toEqual([Math.fround(.1), -2, 3]); expect(Object.isFrozen(parsed)).toBe(true);
    expect(transformFocusPoint({ point: null })).toBeNull();
    expect(() => transformFocusPoint({ point: null }, 'scene')).toThrow('Invalid native transform focus point.');
    const accessor = {}; Object.defineProperty(accessor, 'point', { enumerable: true, get() { throw new Error('not evaluated'); } });
    for (const value of [{}, { center: [1, 2, 3] }, Object.create({ point: [1, 2, 3] }), accessor,
      { point: undefined }, { point: [1, 2] }, { point: [1, 2, 3, 4] }, { point: [1, NaN, 3] },
      { point: [1, Infinity, 3] }, { point: [1, 1e100, 3] }, { point: [.1, 2, 3] }, { point: new Array(3) },
      { point: Object.assign([1, 2, 3], { extra: true }) }])
      expect(() => transformFocusPoint(value)).toThrow('Invalid native transform focus point.');
  });
});

describe('worker-lifetime selection commit event scalar', () => {
  it('accepts zero, safe integer endpoints, rollback rewind and a fresh worker reset', () => {
    expect([0, Number.MAX_SAFE_INTEGER, 9, 3, 0].map(selectionCommitRevision =>
      validateSelectionCommitRevision({ loaded: true, kind: 0, selectionCommitRevision }))).toEqual([0, Number.MAX_SAFE_INTEGER, 9, 3, 0]);
    for (const state of [{ loaded: false, kind: 0 }, { loaded: true, kind: 1 }, { loaded: true, kind: 2 }]) {
      expect(validateSelectionCommitRevision({ ...state, selectionCommitRevision: 0 })).toBe(0);
      expect(() => validateSelectionCommitRevision({ ...state, selectionCommitRevision: 1 })).toThrow('Invalid native selection commit revision.');
    }
  });
  it.each([undefined, null, true, '1', -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('refuses invalid scalar %#', selectionCommitRevision => {
    expect(() => validateSelectionCommitRevision({ loaded: true, kind: 0, selectionCommitRevision })).toThrow('Invalid native selection commit revision.');
  });
  it('requires an own enumerable data field and does not evaluate accessors', () => {
    let reads = 0;
    const accessor = { loaded: true, kind: 0 }; Object.defineProperty(accessor, 'selectionCommitRevision', { enumerable: true, get() { reads++; return 1; } });
    const hidden = { loaded: true, kind: 0 }; Object.defineProperty(hidden, 'selectionCommitRevision', { value: 1 });
    const inherited = Object.assign(Object.create({ selectionCommitRevision: 1 }), { loaded: true, kind: 0 });
    for (const value of [{ loaded: true, kind: 0 }, accessor, hidden, inherited])
      expect(() => validateSelectionCommitRevision(value)).toThrow('Invalid native selection commit revision.');
    expect(reads).toBe(0);
  });
});
