import { describe, expect, it, vi } from 'vitest';
import { assertOperationSummary, isOperationRestoredError, operationSnapshot, OperationRestoredError,
  sameOperationOwner, sameOperationSnapshot, validateOperationOwner, validateOperationReceipt,
  validateOperationScope, validateOperationSnapshot } from '../src/document/operationProtocol';
import type { NativeSummary } from '../src/document/types';

const owner = () => ({ version: 1 as const, documentId: '04040404-0404-4404-8404-040404040404', sourceGeneration: 2,
  clientGeneration: '05050505-0505-4505-8505-050505050505', operationId: 3 });
const snapshot = () => ({ count: 4, sourceCount: 6, duplicateRange: null, revision: 17, contentRevision: 8, selected: 2, visible: 4,
  canUndo: true, canRedo: true, transaction: false, selectionDraft: true, pending: false,
  toleranceSessionId: 12, toleranceMapId: 13, selectionMapId: 13, pendingSelectionMapId: null,
  selectionMapRetainedIds: [13, 14] });
const receipt = (outcome: 'active' | 'committed' | 'rolled-back' | 'not-started' | 'expired-conflict' = 'committed') => ({
  version: 2 as const, owner: owner(), outcome,
  before: outcome === 'expired-conflict' ? null : snapshot(),
  terminal: ['active', 'expired-conflict'].includes(outcome) ? null : snapshot(),
});
const summary = (overrides: Partial<NativeSummary> = {}) => ({ ok: true, ...snapshot(), ...overrides } as NativeSummary);

describe('durable operation receipt protocol', () => {
  it('copies and freezes the exact document/client generation owner and scope', () => {
    const original = owner(), accepted = validateOperationOwner(original);
    original.operationId++; expect(accepted.operationId).toBe(3); expect(Object.isFrozen(accepted)).toBe(true);
    const { operationId: _operationId, ...scope } = owner();
    expect(validateOperationScope(scope)).toEqual(scope); expect(Object.isFrozen(validateOperationScope(scope))).toBe(true);
    expect(sameOperationOwner(accepted, owner())).toBe(true);
    for (const key of ['documentId', 'clientGeneration', 'sourceGeneration', 'operationId'] as const) {
      const changed = { ...owner(), [key]: typeof accepted[key] === 'number' ? Number(accepted[key]) + 1 : '06060606-0606-4606-8606-060606060606' };
      expect(sameOperationOwner(accepted, changed)).toBe(false);
    }
  });
  it.each([
    undefined, null, [], {}, { ...owner(), version: 2 }, { ...owner(), extra: true },
    { ...owner(), documentId: '' }, { ...owner(), documentId: 'scene' }, { ...owner(), clientGeneration: 'client' },
    ...['sourceGeneration', 'operationId'].flatMap(key => [0, -1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null].map(value => ({ ...owner(), [key]: value }))),
  ])('refuses malformed or unscoped owner %#', value => {
    expect(() => validateOperationOwner(value)).toThrow();
  });
  it('does not evaluate accessors or inherited metadata when validating an owner', () => {
    const getter = vi.fn(() => 3), value = Object.defineProperty(owner(), 'operationId', { enumerable: true, get: getter });
    expect(() => validateOperationOwner(value)).toThrow(); expect(getter).not.toHaveBeenCalled();
    expect(() => validateOperationOwner(Object.create(owner()))).toThrow();
    expect(() => validateOperationOwner({ ...owner(), [Symbol('owner')]: 1 })).toThrow();
    expect(() => validateOperationScope(owner())).toThrow();
  });
  it('preserves draft, pending, map, exact selection and history state independently of content revision', () => {
    const original = snapshot(), accepted = validateOperationSnapshot(original);
    original.selectionMapRetainedIds[0] = 99; expect(accepted.selectionMapRetainedIds).toEqual([13, 14]);
    expect(Object.isFrozen(accepted)).toBe(true); expect(Object.isFrozen(accepted.selectionMapRetainedIds)).toBe(true);
    expect(sameOperationSnapshot(accepted, snapshot())).toBe(true);
    for (const key of ['count', 'sourceCount', 'revision', 'contentRevision', 'selected', 'visible', 'toleranceSessionId', 'toleranceMapId', 'selectionMapId'] as const)
      expect(sameOperationSnapshot(accepted, { ...snapshot(), [key]: Number(accepted[key]) + 1 })).toBe(false);
    for (const key of ['canUndo', 'canRedo', 'transaction', 'selectionDraft', 'pending'] as const)
      expect(sameOperationSnapshot(accepted, { ...snapshot(), [key]: !accepted[key] })).toBe(false);
    expect(sameOperationSnapshot(accepted, { ...snapshot(), selectionMapRetainedIds: [14, 13] })).toBe(false);
  });
  it.each([
    undefined, null, [], {}, { ...snapshot(), extra: 1 },
    ...['revision', 'contentRevision', 'selected', 'visible'].flatMap(key => [-1, .5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null].map(value => ({ ...snapshot(), [key]: value }))),
    ...['canUndo', 'canRedo', 'transaction', 'selectionDraft', 'pending'].map(key => ({ ...snapshot(), [key]: 1 })),
    ...['toleranceSessionId', 'toleranceMapId', 'selectionMapId', 'pendingSelectionMapId'].flatMap(key => [0, -1, .5, '1', undefined].map(value => ({ ...snapshot(), [key]: value }))),
    ...[null, [0], [1, 1], [1, 2, 3, 4, 5, 6], ['1'], Array(1)].map(selectionMapRetainedIds => ({ ...snapshot(), selectionMapRetainedIds })),
  ])('refuses incomplete or invalid exact snapshots %#', value => {
    expect(() => validateOperationSnapshot(value)).toThrow();
  });
  it('refuses accessor array elements and unsupported array properties without invoking getters', () => {
    const getter = vi.fn(() => 13), ids = Object.defineProperty([13], '0', { enumerable: true, get: getter });
    expect(() => validateOperationSnapshot({ ...snapshot(), selectionMapRetainedIds: ids })).toThrow(); expect(getter).not.toHaveBeenCalled();
    const extra = Object.assign([13], { extra: 1 });
    expect(() => validateOperationSnapshot({ ...snapshot(), selectionMapRetainedIds: extra })).toThrow();
  });
  it.each(['active', 'committed', 'rolled-back', 'not-started', 'expired-conflict'] as const)('accepts the explicit %s outcome without guessing from history counters', outcome => {
    const accepted = validateOperationReceipt(receipt(outcome), owner());
    expect(accepted.outcome).toBe(outcome); expect(Object.isFrozen(accepted)).toBe(true);
    expect(accepted.before === null || Object.isFrozen(accepted.before)).toBe(true);
    if (outcome === 'active') assertOperationSummary(accepted, summary({ transaction: true }));
    else if (outcome === 'expired-conflict') expect(() => assertOperationSummary(accepted, summary())).toThrow();
    else assertOperationSummary(accepted, summary());
  });
  it.each([
    {}, { ...receipt(), version: 1 }, { ...receipt(), outcome: 'complete' }, { ...receipt(), outcome: 1 },
    { ...receipt(), before: null }, { ...receipt(), terminal: null }, { ...receipt(), before: { ...snapshot(), transaction: true } },
    { ...receipt(), terminal: { ...snapshot(), transaction: true } }, { ...receipt('active'), terminal: snapshot() },
    { ...receipt('expired-conflict'), before: snapshot() }, { ...receipt('expired-conflict'), terminal: snapshot() },
    { ...receipt(), owner: { ...owner(), operationId: 4 } }, { ...receipt(), extra: true },
  ])('refuses incompatible or unproven terminal outcomes %#', value => {
    expect(() => validateOperationReceipt(value, owner())).toThrow();
  });
  it('requires every terminal snapshot field to match the native result before acceptance', () => {
    const proof = validateOperationReceipt(receipt());
    for (const key of ['revision', 'contentRevision', 'selected', 'visible', 'toleranceSessionId', 'toleranceMapId', 'selectionMapId'] as const)
      expect(() => assertOperationSummary(proof, summary({ [key]: Number(snapshot()[key]) + 1 }))).toThrow();
    for (const key of ['canUndo', 'canRedo', 'transaction', 'selectionDraft', 'pending'] as const)
      expect(() => assertOperationSummary(proof, summary({ [key]: !snapshot()[key] }))).toThrow();
    expect(() => assertOperationSummary(proof, summary({ selectionMapRetainedIds: [13] }))).toThrow();
    expect(() => assertOperationSummary(proof, summary({ ok: false }))).toThrow();
    expect(() => assertOperationSummary(validateOperationReceipt(receipt('active')), summary())).toThrow();
  });
  it('binds changed cardinality and value-equal suffixes in receipt version 2', () => {
    const before = snapshot(), terminal = { ...snapshot(), count: 6, sourceCount: 8, duplicateRange: { first: 4, count: 2 } };
    const proof = validateOperationReceipt({ ...receipt(), before, terminal });
    const result = summary({ ...terminal, loaded: true, kind: 0 });
    expect(() => assertOperationSummary(proof, result)).not.toThrow();
    expect(sameOperationSnapshot(proof.terminal!, { ...terminal, duplicateRange: { first: 4, count: 2 } })).toBe(true);
    for (const patch of [{ count: 5 }, { sourceCount: 7 }, { duplicateRange: null }, { duplicateRange: { first: 5, count: 1 } }])
      expect(() => assertOperationSummary(proof, { ...result, ...patch })).toThrow();
    expect(() => validateOperationReceipt({ ...receipt(), version: 1 })).toThrow();
    expect(() => validateOperationSnapshot({ ...snapshot(), duplicateRange: undefined })).toThrow();
  });
  it('normalizes absent legacy optional tolerance fields only when capturing a summary', () => {
    const value = summary({ toleranceSessionId: undefined, toleranceMapId: undefined });
    expect(operationSnapshot(value)).toMatchObject({ toleranceSessionId: null, toleranceMapId: null });
    expect(() => validateOperationSnapshot({ ...snapshot(), toleranceSessionId: undefined })).toThrow();
  });
  it('carries a validated restoration proof without claiming committed work was restored', () => {
    const proof = validateOperationReceipt(receipt('rolled-back')), value = summary();
    const error = new OperationRestoredError(proof, value);
    expect(isOperationRestoredError(error)).toBe(true); expect(error.summary).toBe(value); expect(error.receipt).toBe(proof);
    expect(isOperationRestoredError(new Error('restored'))).toBe(false);
    expect(() => new OperationRestoredError(validateOperationReceipt(receipt()), value)).toThrow();
    expect(() => new OperationRestoredError(proof, summary({ canRedo: false }))).toThrow();
  });
});
