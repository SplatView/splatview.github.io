import { describe, expect, it } from 'vitest';
import { acceptsResult, BUILD_ID, PROTOCOL_VERSION, type Revision } from '../src/document/types';
import { AdmissionError, checkedBytes, estimateSceneBytes, packedStride, ResourceLedger } from '../src/document/resources';

describe('document revisions', () => {
  const state: Revision = { documentId: 'scene-a', sourceGeneration: 1, contentRevision: 2, selectionRevision: 3, draftRevision: 4 };
  const result = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1, base: state };
  it('accepts only the complete matching dependency tuple', () => {
    expect(acceptsResult(result, state)).toBe(true);
    for (const key of ['sourceGeneration', 'contentRevision', 'selectionRevision', 'draftRevision'] as const)
      expect(acceptsResult(result, { ...state, [key]: state[key] + 1 })).toBe(false);
    expect(acceptsResult(result, { ...state, documentId: 'scene-b' })).toBe(false);
    expect(acceptsResult({ ...result, buildId: 'old-build' }, state)).toBe(false);
  });
});
describe('memory admission', () => {
  it('rejects overflow and over-budget work before allocating', () => {
    expect(() => checkedBytes(Number.MAX_SAFE_INTEGER, 2)).toThrow(AdmissionError);
    expect(() => checkedBytes(-1, 144)).toThrow(AdmissionError);
    const ledger = new ResourceLedger(100);
    const release = ledger.reserve('decoded', 80);
    expect(() => ledger.reserve('work', 21)).toThrow(AdmissionError);
    expect(ledger.usage.bytes).toBe(80);
    release(); release(); expect(ledger.usage.bytes).toBe(0);
    expect(ledger.usage.peakBytes).toBe(80);
  });
  it('uses native packed covariance/half SH rather than float SH expansion', () => {
    expect([0, 1, 2, 3].map(packedStride)).toEqual([48, 64, 96, 136]);
    expect(packedStride(3) * 1_000_000).toBeGreaterThan(128 * 1024 * 1024);
    expect(estimateSceneBytes(3_000_000, 3)).toBeGreaterThan(852_000_000);
  });
  it('moves work reservations into retained history atomically and refuses partial redistribution', () => {
    const ledger = new ResourceLedger(100), history = ledger.reserve('history', 20), work = ledger.reserve('work', 80);
    ledger.rebalance([{ lease: history, bytes: 60 }, { lease: work, bytes: 40 }]);
    expect(history.bytes).toBe(60); expect(work.bytes).toBe(40); expect(ledger.usage.bytes).toBe(100);
    expect(() => ledger.rebalance([{ lease: history, bytes: 61 }, { lease: work, bytes: 40 }])).toThrow(AdmissionError);
    expect(history.bytes).toBe(60); expect(work.bytes).toBe(40);
    expect(() => ledger.rebalance([{ lease: history, bytes: 0 }, { lease: history, bytes: 0 }])).toThrow(AdmissionError);
    work(); history.resize(30); expect(ledger.usage.bytes).toBe(30); history();
    expect(() => history.resize(1)).toThrow(AdmissionError); expect(ledger.usage.bytes).toBe(0);
  });
});
