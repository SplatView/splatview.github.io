import { describe, expect, it } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, PROTOCOL_VERSION } from '../src/document/types';
import { SOURCE_FINGERPRINT_SCHEME } from '../src/io/fingerprint';
import { authenticRecoveryControl, recoveryRange, validateRecoveryBuffer, validateRecoveryControl,
  validateRecoveryId, validateRecoveryRange, validateRecoveryStart } from '../src/document/recoveryProtocol';
import type { RecoveryCheckpointBinding, RecoveryCheckpointPlan } from '../src/document/recoveryCheckpoint';
import type { OperationOwner } from '../src/document/operationProtocol';

const base = { documentId: '5a1e7922-bf6a-439c-85de-e72902e57c44', sourceGeneration: 2,
  contentRevision: 8, selectionRevision: 7, draftRevision: 3 };
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 4, base };
const binding: RecoveryCheckpointBinding = { version: 1, core: BUILD_DESCRIPTOR.native.core,
  source: { scheme: SOURCE_FINGERPRINT_SCHEME, assetDigest: 'a'.repeat(64), resourceCount: 1, totalBytes: 99, sourceKindHint: 'PLY' },
  subset: { sourceCount: 19, loadedCount: 9, maxSplats: 10 }, revision: base };
const plan: RecoveryCheckpointPlan = { ok: true, version: 2, byteLength: 1024 * 1024 + 123, workspaceBytes: 1700,
  currentLoadedCount: 9, currentSourceCount: 19, currentDuplicateRange: null, maximumGraphSplats: 9,
  maximumChunkBytes: 1048576, sceneCount: 1, maskCount: 1, normalizationFlags: 0, actualRevision: 8, revision: 8,
  contentRevision: 6, nextContentRevision: 9, memoryBytes: 4000, sha256: 'b'.repeat(64), headerSha256: 'c'.repeat(64) };
const request = { ...envelope, type: 'recovery-export' as const, recoveryId: 'checkpoint-1', binding };
const owner: OperationOwner = { version: 1, documentId: base.documentId, sourceGeneration: base.sourceGeneration,
  clientGeneration: 'ba84c26d-e7bc-48a1-aa43-5dde4d4d6785', operationId: 2 };
const range = recoveryRange(plan, 0)!;

describe('bounded recovery wire validation', () => {
  it('keeps native/core/source/public binding exact for export and restore', () => {
    expect(validateRecoveryStart(request, BUILD_DESCRIPTOR.native.core)).toBe(request);
    const restore = { ...request, type: 'recovery-restore' as const, plan, budgetBytes: 32 * 1024 * 1024 };
    expect(validateRecoveryStart(restore, BUILD_DESCRIPTOR.native.core)).toBe(restore);
    expect(() => validateRecoveryStart({ ...restore, base: { ...base, contentRevision: 9 } }, BUILD_DESCRIPTOR.native.core)).toThrow(/public revision/);
    expect(() => validateRecoveryStart({ ...request, binding: { ...binding, core: { ...binding.core, nativeInputId: 'd'.repeat(64) } } }, BUILD_DESCRIPTOR.native.core)).toThrow(/native core/);
    expect(() => validateRecoveryStart({ ...request, operationOwner: { ...owner, sourceGeneration: 3 } }, BUILD_DESCRIPTOR.native.core)).toThrow(/another source/);
    expect(() => validateRecoveryStart({ ...restore, budgetBytes: 0 }, BUILD_DESCRIPTOR.native.core)).toThrow(/budget/);
    expect(() => validateRecoveryStart({ ...restore, budgetBytes: Number.MAX_SAFE_INTEGER }, BUILD_DESCRIPTOR.native.core)).toThrow(/budget/);
    expect(() => validateRecoveryStart({ ...request, extra: true } as typeof request, BUILD_DESCRIPTOR.native.core)).toThrow(/fields/);
  });

  it('authenticates request, base, recovery identity and exact operation owner before phase validation', () => {
    const start = { ...request, operationOwner: owner };
    const control = { ...envelope, type: 'recovery-ack' as const, recoveryId: request.recoveryId, operationOwner: owner, ...range };
    expect(authenticRecoveryControl(control, start)).toBe(true);
    expect(validateRecoveryControl(control, start, 'ack', range)).toBe(control);
    for (const patch of [
      { requestId: 5 }, { recoveryId: 'stale' }, { base: { ...base, draftRevision: 4 } },
      { operationOwner: undefined }, { operationOwner: { ...owner, operationId: 3 } },
      { operationOwner: { ...owner, clientGeneration: 'fa3de06a-3f3d-4f69-8e12-235848a935d3' } },
    ]) expect(authenticRecoveryControl({ ...control, ...patch }, start)).toBe(false);
    expect(authenticRecoveryControl({ ...control, operationOwner: owner }, request)).toBe(false);
    expect(() => validateRecoveryControl({ ...control, offset: 1 }, start, 'ack', range)).toThrow(/range/);
    expect(() => validateRecoveryControl(control, start, 'release')).toThrow(/phase/);
    expect(() => validateRecoveryControl({ ...control, extra: 1 } as typeof control, start, 'ack', range)).toThrow(/fields/);
  });

  it('grants exactly one MiB or the terminal remainder with no replay or overflow', () => {
    expect(range).toEqual({ index: 0, offset: 0, length: 1048576 });
    expect(recoveryRange(plan, 1)).toEqual({ index: 1, offset: 1048576, length: 123 });
    expect(recoveryRange(plan, 2)).toBeNull();
    expect(validateRecoveryRange(range, range)).toBe(range);
    for (const patch of [{ index: 1 }, { offset: 1 }, { length: 1048575 }, { index: -0 }, { length: NaN }])
      expect(() => validateRecoveryRange({ ...range, ...patch }, range)).toThrow(/range/);
    expect(() => validateRecoveryRange(range, null)).toThrow(/range/);
    for (const index of [-1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) expect(() => recoveryRange(plan, index)).toThrow();
  });

  it('refuses detached, shared, resizable and forged buffer storage before native copying', () => {
    expect(validateRecoveryBuffer(new ArrayBuffer(4), 4).byteLength).toBe(4);
    for (const value of [new Uint8Array(4), { byteLength: 4 }, new ArrayBuffer(3), new SharedArrayBuffer(4)])
      expect(() => validateRecoveryBuffer(value, 4)).toThrow(/fixed, attached/);
    const detached = new ArrayBuffer(0); structuredClone(detached, { transfer: [detached] });
    expect(() => validateRecoveryBuffer(detached, 0)).toThrow(/fixed, attached/);
    if (Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')) {
      const resizable = Reflect.construct(ArrayBuffer, [4, { maxByteLength: 8 }]);
      expect(() => validateRecoveryBuffer(resizable, 4)).toThrow(/fixed, attached/);
    }
    const bytes = new ArrayBuffer(range.length);
    expect(validateRecoveryControl({ ...envelope, type: 'recovery-range', recoveryId: request.recoveryId, ...range, bytes }, request, 'range', range)).toMatchObject({ bytes });
  });

  it('rejects accessor fields without invoking them and bounds identities', () => {
    let reads = 0;
    const accessor = { ...envelope, type: 'recovery-proceed' as const, recoveryId: request.recoveryId };
    Object.defineProperty(accessor, 'extra', { enumerable: true, get() { reads++; return 1; } });
    expect(() => validateRecoveryControl(accessor, request, 'proceed')).toThrow(/fields/);
    expect(reads).toBe(0);
    expect(validateRecoveryId('c'.repeat(128))).toHaveLength(128);
    for (const id of ['', 'c'.repeat(129), '../checkpoint', 'contains spaces', null, 3]) expect(() => validateRecoveryId(id)).toThrow(/identity/);
  });
});
