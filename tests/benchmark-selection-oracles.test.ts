import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { anchorPickProposal, assertSelectionMask, expectedOrdinaryColorAmendments, expectedSelectionMask,
  selectionBaselineMask, selectionCase, selectionCombinedState, selectionMaskIdentity, selectionParameterBytes,
  validateSelectionExport, type SelectionCombine } from '../tools/bench/selection-oracles.ts';

// Literal original anchor rows; neither the fixture generator nor any native,
// application selector/camera/projection helper is imported by this test.
function literalAnchor(id: 0 | 1 | 2): Uint8Array {
  const bytes = new Uint8Array(32), view = new DataView(bytes.buffer);
  view.setFloat32(0, id === 0 ? -8 : id === 1 ? 8 : 0, true);
  view.setFloat32(4, id === 2 ? 8 : 0, true); view.setFloat32(8, 0, true);
  view.setFloat32(12, 1 / 1024, true); view.setFloat32(16, 1 / 512, true); view.setFloat32(20, 1 / 256, true);
  bytes.set([id === 0 ? 255 : 0, id === 1 ? 255 : 0, id === 2 ? 255 : 0, 255, 255, 128, 128, 128], 24);
  return bytes;
}
function twoAnchors(first: 0 | 1 | 2 = 0, second: 0 | 1 | 2 = 2): Uint8Array {
  const bytes = new Uint8Array(64); bytes.set(literalAnchor(first)); bytes.set(literalAnchor(second), 32); return bytes;
}
function anchorSubset(): Uint8Array {
  const states = selectionBaselineMask('none'); states[0] = 1; states[1] = 2; states[2] = 1; return states;
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('independent original fixed-workload selection foundations', () => {
  it.each([
    ['none', 0, 0], ['all', 256000, 0], ['red', 85334, 0], ['central-box', 32768, 0],
    ['grid-only', 255997, 0], ['central-box-right-anchor-deleted', 32768, 1],
  ] as const)('fixes baseline %s counts without observing production output', (kind, selected, deleted) => {
    const identity = selectionMaskIdentity(selectionBaselineMask(kind));
    expect(identity.count).toBe(256000); expect(identity.selectedCount).toBe(selected);
    expect(identity.deletedCount).toBe(deleted); expect(identity.visibleCount).toBe(256000 - deleted);
  });

  it('fixes central-box integer faces and excludes all off-grid anchors', () => {
    const states = selectionBaselineMask('central-box');
    expect([...states.subarray(0, 3)]).toEqual([0, 0, 0]);
    expect(states[77392]).toBe(1); // (16,9,24), first included corner.
    expect(states[178607]).toBe(1); // (47,40,55), opposite included corner.
    expect(states[77391]).toBe(0); expect(states[77328]).toBe(0); expect(states[74192]).toBe(0);
    states[77392] = 0; expect(selectionBaselineMask('central-box')[77392]).toBe(1);
  });

  it.each([
    ['sphere-left-anchor', 0], ['sphere-right-anchor', 1], ['sphere-bottom-anchor', 2],
  ] as const)('fixes isolated query %s to one original source', (query, id) => {
    const states = expectedSelectionMask(query, selectionBaselineMask('none'), 0);
    const identity = selectionMaskIdentity(states);
    expect(identity.selectedCount).toBe(1); expect(states[id]).toBe(1);
    const encodedId = new Uint8Array(4); new DataView(encodedId.buffer).setUint32(0, id, true);
    expect(identity.selectedMembershipSha256).toBe(sha(encodedId));
  });

  it('uses RUB coordinates for the bottom anchor sphere while exports retain wire RDF positions', () => {
    const candidate = selectionCase('sphere-bottom-anchor');
    expect(candidate.parameters.query).toEqual({ tool: 'filter', kind: 'sphere', parameters: { center: [0, -8, 0], radius: 0.125 } });
    const mask = expectedSelectionMask('sphere-bottom-anchor', selectionBaselineMask('none'), 0);
    expect(validateSelectionExport(literalAnchor(2), mask, 'selected').count).toBe(1);
  });

  it.each([
    [0, false, [0, 0, 0, 0]], [0, true, [1, 1, 0, 0]],
    [1, false, [0, 1, 1, 0]], [1, true, [1, 1, 0, 1]],
    [2, false, [2, 2, 2, 2]], [2, true, [2, 2, 2, 2]],
  ] as const)('fixes Combine truth table for state %i and inside %s', (before, inside, expected) => {
    for (const operation of [0, 1, 2, 3] as const) expect(selectionCombinedState(before, inside, operation)).toBe(expected[operation]);
  });

  it.each([
    [0, 85334, 256000], [1, 107180, 256000], [2, 21846, 0], [3, 10922, 32768],
  ] as const)('amends ordinary Color Combine %i against the original baseline', (operation, lowCount, highCount) => {
    const candidate = expectedOrdinaryColorAmendments('central-box', operation);
    expect(candidate.initial.expected.selectedCount).toBe(lowCount); expect(candidate.widened.expected.selectedCount).toBe(highCount);
    expect(candidate.narrowed.expected).toEqual(candidate.initial.expected);
    expect(candidate.initial.parameters.originalBaseline.stateMaskSha256).toBe(candidate.widened.parameters.originalBaseline.stateMaskSha256);
    expect(candidate.initial.parameters.query).toEqual({ tool: 'ordinary-color', index: 0, connected: false, tolerance: 0.25 });
    expect(candidate.widened.parameters.query).toEqual({ tool: 'ordinary-color', index: 0, connected: false, tolerance: 0.95 });
    expect(candidate.status).toBe('pending-actual-session-comparison');
  });

  it.each([0, 1, 2, 3] as const)('preserves deleted state while amending Combine %i', operation => {
    const baseline = selectionBaselineMask('central-box-right-anchor-deleted'), before = sha(baseline);
    for (const query of ['ordinary-red-low', 'ordinary-red-high', 'sphere-right-anchor'] as const) {
      const result = expectedSelectionMask(query, baseline, operation);
      expect(result[1]).toBe(2); expect(selectionMaskIdentity(result).deletedCount).toBe(1);
    }
    expect(sha(baseline)).toBe(before);
  });

  it('does not permit a widened amendment to become the next Combine baseline', () => {
    const baseline = selectionBaselineMask('central-box');
    const widened = expectedSelectionMask('ordinary-red-high', baseline, 1);
    const wronglyAccumulated = expectedSelectionMask('ordinary-red-low', widened, 1);
    const correct = expectedSelectionMask('ordinary-red-low', baseline, 1);
    expect(selectionMaskIdentity(wronglyAccumulated).selectedCount).toBe(256000);
    expect(selectionMaskIdentity(correct).selectedCount).toBe(107180);
  });

  it('binds all 256000 state bytes and separate selected/deleted source-ID memberships', () => {
    const states = anchorSubset(), identity = assertSelectionMask(states.slice(), states);
    expect(identity.selectedCount).toBe(2); expect(identity.deletedCount).toBe(1);
    expect(identity.selectedMembershipSha256).toBe(sha(new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0])));
    expect(identity.deletedMembershipSha256).toBe(sha(new Uint8Array([1, 0, 0, 0])));
    const wrong = states.slice(); wrong[255999] = 1;
    expect(() => assertSelectionMask(wrong, states)).toThrow(/source 255999 mask mismatch/);
    wrong[0] = 3; expect(() => assertSelectionMask(wrong, states)).toThrow(/invalid selected\/deleted state/);
    expect(() => selectionMaskIdentity(states.subarray(1))).toThrow(/complete 256000-byte/);
  });

  it('uses canonical sorted parameter keys and rejects executable/ambiguous values', () => {
    expect(new TextDecoder().decode(selectionParameterBytes({ z: [2, 1], a: { c: true, b: null } }))).toBe('{"a":{"b":null,"c":true},"z":[2,1]}');
    expect(selectionParameterBytes({ b: 2, a: 1 })).toEqual(selectionParameterBytes({ a: 1, b: 2 }));
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0, undefined, new Date(0)]) expect(() => selectionParameterBytes(value)).toThrow(/parameters/);
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get: () => { throw new Error('must not execute'); } });
    expect(() => selectionParameterBytes(getter)).toThrow(/accessors/);
    const arrayGetter = Object.defineProperty([0], '0', { enumerable: true, get: () => { throw new Error('must not execute'); } });
    expect(() => selectionParameterBytes(arrayGetter)).toThrow(/accessors/);
    expect(() => selectionParameterBytes(new Array(1))).toThrow(/complete/);
    const cyclic: { next?: unknown } = {}; cyclic.next = cyclic;
    expect(() => selectionParameterBytes(cyclic)).toThrow(/acyclic/);
  });

  it('binds camera/framebuffer/options/query/baseline/Combine and retains pending qualifications', () => {
    const candidate = selectionCase('central-box', 'red', 2);
    expect(candidate.parameters.camera).toEqual([0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6]);
    expect(candidate.parameters.framebuffer).toEqual({ width: 1280, height: 800, dpr: 1 });
    expect(candidate.parameters.query).toEqual({ tool: 'filter', kind: 'box', parameters: { center: [0, 0, 0], size: [2, 2, 2], rotation: [0, 0, 0] } });
    expect(candidate.parametersSha256).toBe(sha(selectionParameterBytes(candidate.parameters)));
    expect(selectionCase('central-box', 'red', 3).parametersSha256).not.toBe(candidate.parametersSha256);
    expect(candidate.status).toBe('pending-actual-comparison'); expect(candidate.qualification.actualNative).toBe(false);
    expect(candidate.qualification.actualBrowser).toBe(false); expect(candidate.qualification.performanceAccepted).toBe(false);
    expect(Object.isFrozen(candidate.parameters.camera)).toBe(true);
  });

  it('independently validates every selected export attribute and exact original order', () => {
    const bytes = twoAnchors(), result = validateSelectionExport(bytes, anchorSubset(), 'selected');
    expect(result.count).toBe(2); expect(result.encodedSha256).toBe(sha(bytes));
    expect(result.membershipSha256).toBe(sha(new Uint8Array([0, 0, 0, 0, 2, 0, 0, 0])));
    expect(result.sourceOrderSha256).toBe(result.expectedMembershipSha256);
    expect(result.numeric.covariance.maxNormalizedError).toBe(0); expect(result.numeric.exactRgba).toBe(true);
  });

  it.each([
    ['reordered', 2, 0, /reordered or duplicated/], ['duplicated', 0, 0, /reordered or duplicated/],
    ['deleted member', 0, 1, /outside its expected scope/],
  ] as const)('refuses a valid-wire export with %s members', (_label, first, second, message) => {
    expect(() => validateSelectionExport(twoAnchors(first, second), anchorSubset(), 'selected')).toThrow(message);
  });

  it('refuses missing, extra, malformed and wrong-attribute subset exports', () => {
    const states = anchorSubset(), bytes = twoAnchors();
    expect(() => validateSelectionExport(bytes.subarray(0, 32), states, 'selected')).toThrow(/length\/count/);
    expect(() => validateSelectionExport(new Uint8Array(96), states, 'selected')).toThrow(/length\/count/);
    const badScale = bytes.slice(); new DataView(badScale.buffer).setFloat32(12, 2 ** -30, true);
    expect(() => validateSelectionExport(badScale, states, 'selected')).toThrow(/linear scale/);
    const badColor = bytes.slice(); badColor[24] = 254;
    expect(() => validateSelectionExport(badColor, states, 'selected')).toThrow(/exact workload RGBA/);
    const nonfinite = bytes.slice(); new DataView(nonfinite.buffer).setFloat32(0, Number.NaN, true);
    expect(() => validateSelectionExport(nonfinite, states, 'selected')).toThrow(/non-finite position/);
    expect(() => validateSelectionExport(new Uint8Array(), selectionBaselineMask('none'), 'selected')).toThrow(/observe the actual export refusal/);
  });

  it.each([0, 1, 2] as const)('provides a full-footprint separated anchor %i candidate while keeping GPU qualification pending', id => {
    const proposal = anchorPickProposal(id);
    expect(proposal.expectedSourceId).toBe(id);
    expect(proposal.parameters.pixel).toEqual(id === 0 ? [318, 400] : id === 1 ? [961, 400] : [640, 721]);
    expect(proposal.analytic.mahalanobisSquared).toBeLessThan(2);
    expect(proposal.analytic.idealAlpha).toBeGreaterThan(0.49); expect(proposal.analytic.idealAlpha).toBeLessThan(0.55);
    expect(proposal.analytic.projectedCovariance[0]).toBeGreaterThan(0.3); expect(proposal.analytic.projectedCovariance[2]).toBeGreaterThan(0.3);
    expect(proposal.analytic.separationProof.conservativeGridSupportBounds).toEqual([544, 322, 736, 478]);
    expect(proposal.parametersSha256).toBe(sha(selectionParameterBytes(proposal.parameters)));
    expect(proposal.status).toBe('pending-actual-gpu-comparison'); expect(proposal.qualification.actualGpu).toBe(false);
    expect(proposal.qualification.numericAcceptanceBound).toBeNull(); expect(proposal.qualification.overdrawMeasured).toBe(false);
  });

  it('does not silently generalize the fixed source mask or accepted Combine domain', () => {
    expect(() => selectionBaselineMask('other' as never)).toThrow(/unknown fixed baseline/);
    expect(() => expectedSelectionMask('other' as never, selectionBaselineMask('none'), 0)).toThrow(/unknown analytic query/);
    expect(() => selectionCombinedState(0, true, 4 as SelectionCombine)).toThrow(/Combine/);
    expect(() => selectionCombinedState(3, true, 0)).toThrow(/truth-table/);
    expect(() => anchorPickProposal(3 as never)).toThrow(/only three isolated anchors/);
  });
});
