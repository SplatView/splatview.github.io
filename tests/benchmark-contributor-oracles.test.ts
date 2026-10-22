import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { assertContributorPick, contributorAnchorCase, contributorBaselineMask, contributorDeletedAnchorCase, contributorDeletedAnchorMask,
  contributorSingleCase, expectedContributorAnchorMask, expectedContributorSingleMask } from '../tools/bench/contributor-oracles';
import { selectionMaskIdentity, type SelectionCombine } from '../tools/bench/selection-oracles';

describe('independent ordinary Single contributor cases', () => {
  it('binds the three existing isolated pixels to their exact single selected source byte', () => {
    const points = [[318.5, 400.5], [961.5, 400.5], [640.5, 721.5]];
    const originalHashes = ['219e64017a3908c81ddf40280d2d6fd77dc344387a233e3920ac0e24b010a8ab',
      '097bef445b753fe19bc555dcdd863ab1c8f50448269be8fd7de953b6e79a7647',
      'a25d75be83e46dc9e859f5837f052a0514764a1fb6248d2150fb7981b26beb8a'];
    for (const id of [0, 1, 2] as const) {
      const candidate = contributorAnchorCase(id), expected = expectedContributorAnchorMask(id);
      for (let source = 0; source < 256000; source++) assert.equal(expected[source], Number(source === id));
      assert.equal(candidate.parameters.expectedSourceId, id); assert.equal(candidate.parameters.operation, 0);
      assert.deepEqual(candidate.parameters.ui.pointer.requestedPoint, points[id]);
      assert.equal(candidate.parameters.ui.anchorProposalParametersSha256, originalHashes[id]);
      assert.deepEqual(candidate.expected.after, selectionMaskIdentity(expected));
      assert.equal(candidate.expected.before.selectedCount, 0); assert.equal(candidate.expected.after.selectedCount, 1);
      assert.equal(candidate.expected.after.deletedCount, 0); assert.notEqual(candidate.parametersSha256, originalHashes[id]);
    }
    for (const id of [-1, 3, 0.5, NaN, -0]) {
      assert.throws(() => contributorAnchorCase(id as 0)); assert.throws(() => expectedContributorAnchorMask(id as 0));
    }
  });
  it('checks every byte for all four changed Combine cases with and without a deleted source', () => {
    for (const deleted of [false, true]) for (const operation of [0, 1, 2, 3] as const) {
      const deletedIds = deleted ? [1] : [], before = contributorBaselineMask(operation, deletedIds);
      const after = expectedContributorSingleMask(before, operation, deletedIds), candidate = contributorSingleCase(operation, deletedIds);
      assert.equal(before.length, 256000); assert.equal(after.length, 256000);
      for (let id = 0; id < 256000; id++) {
        const original = deleted && id === 1 ? 2 : operation === 1 ? 0 : 1;
        const expected = deleted && id === 1 ? 2 : operation === 2 ? Number(id !== 0) : Number(id === 0);
        assert.equal(before[id], original, `before source ${id}`); assert.equal(after[id], expected, `after source ${id}`);
      }
      const count = operation === 2 ? deleted ? 255998 : 255999 : 1;
      assert.equal(candidate.expected.after.selectedCount, count); assert.equal(candidate.expected.after.deletedCount, Number(deleted));
      assert.equal(candidate.expected.after.visibleCount, deleted ? 255999 : 256000);
      assert.deepEqual(candidate.expected.before, selectionMaskIdentity(before)); assert.deepEqual(candidate.expected.after, selectionMaskIdentity(after));
      assert.deepEqual(candidate.expected.undo, candidate.expected.before); assert.deepEqual(candidate.expected.redo, candidate.expected.after);
      assert.deepEqual(candidate.expected.undoAgain, candidate.expected.before);
      assert.notEqual(candidate.expected.before.stateMaskSha256, candidate.expected.after.stateMaskSha256);
    }
  });
  it('binds all eight distinct original-baseline/operation identities and actual UI flags', () => {
    const hashes = new Set<string>();
    for (const operation of [0, 1, 2, 3] as const) for (const deletedIds of [[], [1]]) {
      const candidate = contributorSingleCase(operation, deletedIds), ui = candidate.parameters.ui;
      hashes.add(candidate.parametersSha256); assert.match(candidate.parametersSha256, /^[a-f0-9]{64}$/u);
      assert.equal(candidate.parameters.operation, operation); assert.equal(candidate.parameters.expectedSourceId, 0);
      assert.equal(ui.path, 'ordinary-Single-UI-query'); assert.equal(ui.tool, 'single'); assert.equal(ui.liveSelection, false);
      assert.deepEqual(ui.pointer.requestedPoint, [318.5, 400.5]); assert.deepEqual(ui.query.pixel, [318, 400]);
      assert.deepEqual(ui.query.sample, [318.5, 400.5]); assert.equal(ui.query.centerRadius, 0);
      assert.deepEqual(ui.pointer.modifiers, { shift: false, control: false, meta: false, alt: false });
      assert.deepEqual(ui.framebuffer, { width: 1280, height: 800, dpr: 1 });
      assert.deepEqual(ui.camera, [0, 0, 0, 0, 0, 24, 1, 45, 1, 0, 1.6]);
      assert.deepEqual(candidate.parameters.originalBaseline.deletedSourceIds, deletedIds);
      assert.equal(candidate.qualification.actualGpuContributor, false); assert.equal(candidate.qualification.numericAcceptanceBound, null);
      assert.equal(candidate.qualification.exactReadbackBytes, false); assert(Object.isFrozen(candidate.parameters.ui.query.sample));
    }
    assert.equal(hashes.size, 8);
  });
  it('rejects an undeclared baseline byte, state bit, length, operation, deleted set or target', () => {
    const correct = contributorBaselineMask(0), changed = correct.slice(); changed[255999] = 0;
    assert.throws(() => expectedContributorSingleMask(changed, 0), /255999/);
    const wrongDeleted = contributorBaselineMask(0, [1]); wrongDeleted[1] = 3;
    assert.throws(() => expectedContributorSingleMask(wrongDeleted, 0, [1]), /source 1/);
    assert.throws(() => expectedContributorSingleMask(new Uint8Array(255999), 0));
    assert.throws(() => expectedContributorSingleMask(correct, 1));
    for (const operation of [-1, 4, 0.5, NaN, Infinity, -0]) {
      assert.throws(() => contributorBaselineMask(operation as SelectionCombine));
      assert.throws(() => contributorSingleCase(operation as SelectionCombine));
    }
    for (const deletedIds of [[0], [2], [1, 1], new Array<number>(1), [NaN], [1, 2]]) {
      assert.throws(() => contributorBaselineMask(0, deletedIds)); assert.throws(() => contributorSingleCase(0, deletedIds));
    }
    for (const sourceId of [1, 2, 256000, -0, NaN]) assert.throws(() => expectedContributorSingleMask(correct, 0, [], sourceId));
    assert.equal(correct[255999], 1, 'refused checks must not mutate the input');
  });
  it('keeps declared and returned byte arrays detached from future calls', () => {
    const before = contributorBaselineMask(1, [1]), after = expectedContributorSingleMask(before, 1, [1]);
    after[0] = 0; before[1] = 0;
    assert.equal(contributorBaselineMask(1, [1])[1], 2);
    assert.equal(expectedContributorSingleMask(contributorBaselineMask(1, [1]), 1, [1])[0], 1);
  });
});

describe('deleted isolated right-anchor negative control', () => {
  it('predeclares a null actual UI winner and unchanged full state, without assuming a history checkpoint', () => {
    const candidate = contributorDeletedAnchorCase(), mask = contributorDeletedAnchorMask();
    for (let id = 0; id < mask.length; id++) assert.equal(mask[id], id === 1 ? 2 : 0);
    assert.equal(candidate.parameters.expectedSourceId, null); assert.equal(candidate.parameters.operation, 0);
    assert.deepEqual(candidate.parameters.ui.pointer.requestedPoint, [961.5, 400.5]);
    assert.deepEqual(candidate.parameters.ui.query.sample, [961.5, 400.5]); assert.equal(candidate.parameters.ui.query.centerRadius, 0);
    assert.deepEqual(candidate.expected.before, selectionMaskIdentity(mask)); assert.deepEqual(candidate.expected.after, candidate.expected.before);
    assert.equal(candidate.expected.after.selectedCount, 0); assert.equal(candidate.expected.after.deletedCount, 1);
    assert.match(candidate.parameters.history, /no Undo checkpoint/);
    mask[1] = 0; assert.equal(contributorDeletedAnchorMask()[1], 2);
  });
});

describe('actual decoded contributor DTO, without invented numeric tolerances', () => {
  const hit = { index: 0, depth: 24, opacity: 0.514, contribution: 0.514, deviceEpoch: 7 };
  it('requires exact source/device identity and copies actual finite observations without quantizing them', () => {
    const result = assertContributorPick(hit, 0, 7); assert.deepEqual(result, hit); assert.notEqual(result, hit);
    assertContributorPick({ ...hit, index: 1 }, 1, 7); assertContributorPick({ ...hit, index: 2 }, 2, 7);
    assertContributorPick({ index: null, depth: 0, opacity: 0, contribution: 0, deviceEpoch: 7 }, null, 7);
    const differentFinite = { ...hit, depth: 24.03125, opacity: 0.3, contribution: 0.2 };
    assert.deepEqual(assertContributorPick(differentFinite, 0, 7), differentFinite,
      'this structural assertion must not pretend to approve agreement with an analytic float value');
  });
  it('rejects wrong/deleted winners, stale epochs, nonfinite values and invalid semantic ranges', () => {
    assert.throws(() => assertContributorPick(hit, null, 7)); assert.throws(() => assertContributorPick({ ...hit, index: null }, 0, 7));
    assert.throws(() => assertContributorPick(hit, 0, 8)); assert.throws(() => assertContributorPick(hit, 0, 0));
    assert.throws(() => assertContributorPick({ ...hit, index: -0 }, 0, 7));
    for (const name of ['depth', 'opacity', 'contribution'] as const) for (const value of [NaN, Infinity, -Infinity, '0.5', undefined])
      assert.throws(() => assertContributorPick({ ...hit, [name]: value }, 0, 7));
    for (const corruption of [{ depth: -1 }, { depth: 0 }, { opacity: 0 }, { opacity: 1.1 }, { contribution: 0 }, { contribution: -0.1 }, { contribution: 0.8 }])
      assert.throws(() => assertContributorPick({ ...hit, ...corruption }, 0, 7));
    for (const missing of [null, undefined, [], 0, 'hit']) assert.throws(() => assertContributorPick(missing, 0, 7));
  });
});
