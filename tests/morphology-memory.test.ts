import { describe, expect, it } from 'vitest';
import { estimateMorphologyWorkBytes, morphologyNodeCapacity, MORPHOLOGY_OWNER_BYTES, MORPHOLOGY_RANGE_WORK_BYTES } from '../src/document/morphologyMemory';
import { AdmissionError, MiB, ResourceLedger } from '../src/document/resources';

// Independent recurrence follows the actual median split topology, without
// using the closed form in the browser estimator.
function nodes(count: number): number {
  return count === 0 ? 0 : count <= 16 ? 1 : 1 + nodes(Math.floor(count / 2)) + nodes(Math.ceil(count / 2));
}
describe('bounded Grow/Shrink admission', () => {
  it('admits bounded metrics scratch and its owner independently of edit/history overlap', () => {
    expect(MORPHOLOGY_RANGE_WORK_BYTES).toBe(614400);
    expect(MORPHOLOGY_RANGE_WORK_BYTES).toBeGreaterThanOrEqual(36 * 16384 + 2048);
    const ledger = new ResourceLedger(528 + MORPHOLOGY_RANGE_WORK_BYTES - 1);
    const scene = ledger.reserve('decoded', 432), history = ledger.reserve('history', 96), before = ledger.usage;
    expect(() => ledger.reserve('work', MORPHOLOGY_RANGE_WORK_BYTES)).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(ledger.owns(scene)).toBe(true); expect(ledger.owns(history)).toBe(true);
  });
  it('matches independent median trees through leaf and power-of-two boundaries', () => {
    for (let count = 0; count <= 2048; count++) expect(morphologyNodeCapacity(count)).toBe(nodes(count));
    for (const count of [4095, 4096, 4097, 65535, 65536, 65537, 1_000_000])
      expect(morphologyNodeCapacity(count)).toBe(nodes(count));
    expect(morphologyNodeCapacity(1_000_000)).toBe(131071);
  });
  it('covers measured million-splat scratch plus publication and refuses before allocating when short', () => {
    const scratch = 42_767_124, publication = 24_000_000;
    const expected = scratch + MORPHOLOGY_OWNER_BYTES + publication + 4 * MiB;
    expect(MORPHOLOGY_OWNER_BYTES).toBe(6280);
    expect(estimateMorphologyWorkBytes(1_000_000)).toBe(expected);
    const retained = 8_000_000, historyOverlap = 16_000_000;
    const ledger = new ResourceLedger(retained + historyOverlap + expected - 1);
    const resident = ledger.reserve('decoded', retained), before = ledger.usage;
    expect(() => ledger.reserve('work', historyOverlap + estimateMorphologyWorkBytes(1_000_000))).toThrow(AdmissionError);
    expect(ledger.usage).toEqual(before); expect(ledger.owns(resident)).toBe(true);
  });
  it.each([-1, .5, NaN, Infinity, 1_000_001, Number.MAX_SAFE_INTEGER])('refuses invalid or unsupported size %s', count => {
    expect(() => morphologyNodeCapacity(count)).toThrow(AdmissionError);
    expect(() => estimateMorphologyWorkBytes(count)).toThrow(AdmissionError);
  });
});
