import { describe, expect, it } from 'vitest';
import { assertTransformAcknowledgement, assertTransformRequest, assertTransformResponse, captureTransformCommand, captureTransformRequest,
  captureTransformState, sameTransformSummary, TransformOperation, transformDefaults, transformWireParameters, validateTransformSummary,
  type TransformSessionSummary } from '../src/document/transformProtocol';

const session = (patch: Partial<TransformSessionSummary> = {}): TransformSessionSummary => ({ id: 1, baseId: 2, epoch: 0, appliedEpoch: null,
  kind: 'gizmo', selectedOnly: true, appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0],
  gizmo: { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false }, ...patch });
const scene = (transformSession: TransformSessionSummary | null = session(), patch: Record<string, unknown> = {}) => ({
  loaded: true, kind: 0, revision: 7, contentRevision: 3, pending: false, transformSession, ...patch });
const retained = { cancelBaseId: 2, cancelContentRevision: 3, canUndo: true, canRedo: false };
const applied = () => scene(session({ baseId: 4, epoch: 1, gizmo: retained }), { revision: 8, contentRevision: 4 });

describe('gizmo transform session wire contract', () => {
  it('requires own exact nested metadata while numeric sessions carry explicit null', () => {
    expect(validateTransformSummary(session())).toEqual(session());
    expect(validateTransformSummary(session({ kind: 'numeric', gizmo: null }))?.gizmo).toBeNull();
    for (const gizmo of [undefined, null, {}, { ...retained, extra: true }, { ...retained, cancelBaseId: null },
      { ...retained, cancelBaseId: 0 }, { ...retained, cancelContentRevision: -0 }, { ...retained, canUndo: 1 },
      { cancelBaseId: null, cancelContentRevision: null, canUndo: true, canRedo: false }])
      expect(() => validateTransformSummary({ ...session(), gizmo })).toThrow('Invalid native transform session.');
    expect(() => validateTransformSummary(session({ kind: 'numeric' }))).toThrow();
    let reads = 0;
    const gizmo = Object.defineProperty({ ...retained }, 'canRedo', { enumerable: true, get() { reads++; return false; } });
    expect(() => validateTransformSummary({ ...session(), gizmo })).toThrow(); expect(reads).toBe(0);
    expect(Object.isFrozen(validateTransformSummary(session())?.gizmo)).toBe(true);
  });
  it('captures physical-press scope and all transform arrays before either queue', () => {
    const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
    const request = captureTransformCommand({ command: 'rebaseTransform', id: 1, epoch: 1, selectedOnly: false, selectionView: camera });
    camera[0] = 99; expect(request).toMatchObject({ selectionView: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1] });
    expect(Object.isFrozen(request)).toBe(true);
    const parameters = transformWireParameters(transformDefaults())!, apply = captureTransformCommand({ command: 'applyTransform', id: 1, epoch: 1, parameters });
    parameters.pivot[0] = 88;
    expect(apply).toMatchObject({ parameters: { pivot: [0, 0, 0] } });
    if (apply.command === 'applyTransform') { expect(Object.isFrozen(apply.parameters)).toBe(true); expect(Object.isFrozen(apply.parameters.pivot)).toBe(true); }
    for (const command of [{ command: 'undoTransform', id: 1, epoch: 0 }, { command: 'cancelTransform', id: 1, epoch: 1, extra: true },
      { command: 'rebaseTransform', id: 1, epoch: 1, selectedOnly: true, selectionView: [1] }]) expect(() => captureTransformCommand(command)).toThrow();
  });
  it('requires exact gizmo owner, epochs and native history eligibility without changing numeric Reset', () => {
    const before = captureTransformState(scene());
    for (const command of [{ command: 'rebaseTransform', id: 2, epoch: 1, selectedOnly: true },
      { command: 'undoTransform', id: 1, epoch: 1 }, { command: 'redoTransform', id: 1, epoch: 1 },
      { command: 'resetTransform', id: 1, epoch: 1 }]) expect(() => assertTransformRequest(captureTransformCommand(command), before)).toThrow('captured owner');
    expect(() => assertTransformRequest(captureTransformCommand({ command: 'resetTransform', id: 1, epoch: 1 }),
      captureTransformState(scene(session({ kind: 'numeric', gizmo: null }))))).not.toThrow();
  });
  it('rotates the press base without geometry or Cancel-baseline ownership changes', () => {
    const before = captureTransformState(scene()), command = captureTransformCommand({ command: 'rebaseTransform', id: 1, epoch: 1, selectedOnly: false });
    const after = scene(session({ baseId: 4, epoch: 1, selectedOnly: false }));
    expect(() => assertTransformAcknowledgement(command, before, after)).not.toThrow();
    expect(() => assertTransformAcknowledgement(command, before, scene(session({ epoch: 1, selectedOnly: false })))).toThrow();
    expect(() => assertTransformAcknowledgement(command, before, scene(session({ baseId: 4, epoch: 1, selectedOnly: false, gizmo: retained })))).toThrow();
  });
  it('rebases every successful release and captures the original baseline only on real geometry publication', () => {
    const before = captureTransformState(scene()), command = captureTransformCommand({ command: 'applyTransform', id: 1, epoch: 1,
      parameters: transformWireParameters(transformDefaults()) });
    expect(() => assertTransformAcknowledgement(command, before, applied())).not.toThrow();
    expect(() => assertTransformAcknowledgement(command, before, scene(session({ baseId: 4, epoch: 1 })))).not.toThrow();
    expect(() => assertTransformAcknowledgement(command, before, scene(session({ epoch: 1 })))).toThrow();
    expect(() => assertTransformAcknowledgement(command, before, scene(session({ baseId: 4, epoch: 1, gizmo: { ...retained, cancelBaseId: 9 } }),
      { revision: 8, contentRevision: 4 }))).toThrow();
    const interrupted = scene(session({ epoch: 1 }));
    expect(() => assertTransformAcknowledgement(command, before, interrupted, true)).not.toThrow();
    expect(() => assertTransformAcknowledgement(command, before, interrupted)).toThrow();
  });
  it('keeps the original Cancel pair through history moves and authenticates exact original-content restoration', () => {
    const before = captureTransformState(applied()), undo = captureTransformCommand({ command: 'undoTransform', id: 1, epoch: 2 });
    const baseline = scene(session({ baseId: 5, epoch: 2, gizmo: { ...retained, canUndo: false, canRedo: true } }), { revision: 9, contentRevision: 3 });
    expect(() => assertTransformAcknowledgement(undo, before, baseline)).not.toThrow();
    const redo = captureTransformCommand({ command: 'redoTransform', id: 1, epoch: 3 });
    expect(() => assertTransformAcknowledgement(redo, captureTransformState(baseline),
      scene(session({ baseId: 6, epoch: 3, gizmo: retained }), { revision: 10, contentRevision: 4 }))).not.toThrow();
    const cancel = captureTransformCommand({ command: 'cancelTransform', id: 1, epoch: 2 });
    expect(() => assertTransformAcknowledgement(cancel, before, scene(null, { revision: 9, contentRevision: 3 }))).not.toThrow();
    expect(() => assertTransformAcknowledgement(cancel, before, scene(null, { revision: 9, contentRevision: 4 }))).toThrow();
  });
  it('binds the full transient owner independently of readonly responses and receipt2', () => {
    const before = captureTransformState(applied()), proof = captureTransformRequest({ command: 'summary' }, before);
    const forged = scene(session({ baseId: 4, epoch: 1, gizmo: { ...retained, canUndo: false } }), { revision: 8, contentRevision: 4 });
    expect(() => assertTransformResponse(proof, forged)).toThrow('outside its captured request');
    const operation = new TransformOperation(scene()); operation.accept(applied());
    operation.assert('committed', applied()); operation.assert('rolled-back', scene());
    expect(() => operation.assert('committed', forged)).toThrow('outside its captured request');
    expect(sameTransformSummary(session(), session({ gizmo: retained }))).toBe(false);
  });
});
