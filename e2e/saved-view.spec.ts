import { expect, test } from './backend-test';
import type {} from './saved-view-harness';

test.describe('Saved views and thumbnails through real IndexedDB/native/rendering', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/e2e/saved-view-harness.html'); await page.waitForFunction(() => !!window.savedViewHarness); });
  test('saves one atomic pair without editing history, restores Reset and renamed content', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.roundTrip());
    expect(result.accepted).toBe(true); expect(result.after).toEqual(result.before);
    expect(result.before.summary.canRedo).toBe(true); expect(result.records).toBe(1); expect(result.images).toBe(1);
    expect(result.image.width).toBe(241); expect(result.image.height).toBe(241);
    for (const channel of result.image.corner.slice(0, 3)) expect(Math.abs(channel - 127.5)).toBeLessThanOrEqual(.5);
    expect(result.image.corner[3]).toBe(255);
    // Captured R0 Camera::fit(defaultView) restores pose/lens/background after
    // fitting radius from the scene; SavedView itself has no radius field.
    const fitted = [...result.before.state]; fitted[6] = result.before.summary.radius;
    expect(result.record.view.background).toBe('gray'); expect(result.reset).toEqual(fitted); expect(result.reopened).toEqual(fitted);
    expect(result.background).toBe('gray'); expect(result.choices).toBe(0); expect(result.name).toBe('renamed-copy.ply'); expect(result.error).toBeNull();
  });
  test('capture freezes camera/background/framebuffer before actual allocation settles', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.immutableCapture());
    expect(result.actual).toEqual(result.baseline); expect(result.actual.width).toBe(321); expect(result.actual.height).toBe(241);
    for (const channel of result.actual.corner.slice(0, 3)) expect(Math.abs(channel - 127.5)).toBeLessThanOrEqual(.5);
    expect(result.actual.corner[3]).toBe(255); expect(result.now).toBe('white');
    expect(result.baseline.hash).not.toBe(result.neutral.hash); expect(result.nowGrade).toBe(Math.fround(.35));
  });
  test('a newer thumbnail request wins over an older held GPU allocation', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.newerRequest());
    expect(result.old).toBe(false); expect(result.second).toBe(true); expect(result.count).toBe(1);
    expect(result.view.background).toBe('white'); expect(result.image.corner).toEqual([255, 255, 255, 255]); expect(result.pending).toBe(false);
  });
  test('source replacement cancels a held thumbnail without storing an old pair', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.replacement());
    expect(result.accepted).toBe(false); expect(result.records).toBe(0); expect(result.before?.assetDigest).not.toBe(result.after?.assetDigest);
    expect(result.name).toBe('new-source.ply'); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });
  test('denied storage preserves content/history and native framing remains usable', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.denied());
    expect(result.accepted).toBe(false); expect(result.status).toContain('Storage denied'); expect(result.after).toEqual(result.before);
    expect(result.name).toBe('denied-reopen.ply'); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });
  test('failure after metadata put aborts the real transaction and retains the previous complete pair', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.atomicFailure());
    expect(result.injected).toBe(true); expect(result.accepted).toBe(false); expect(result.after).toEqual(result.before);
    expect(result.afterImage).toEqual(result.beforeImage); expect(result.status).toContain('Quota refused'); expect(result.error).toBeNull();
  });
  test('a content edit aborts queued metadata/PNG writes before the real transaction can commit', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.editDuringStorage());
    expect(result.queued.queuedWrites).toBe(2); expect(result.queued.terminalStatus).toBeNull();
    expect(result.admitted.bytes).toBeGreaterThan(result.baseline.bytes); expect(result.terminal.terminalStatus).toBe('aborted');
    expect(result.accepted).toBe(false); expect(result.edited).toBe(true); expect(result.before.summary.canRedo).toBe(true);
    expect(result.before.summary.visible).toBe(5); expect(result.after.summary.visible).toBe(4);
    expect(result.ids).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.redone).toBe(true);
    expect(result.undoIds).toEqual([0, 1, 2, 3, 4]); expect(result.redoIds).toEqual([0, 2, 3, 4]);
    expect(result.undoCsv).toBe(result.before.csv); expect(result.redoCsv).toBe(result.after.csv); expect(result.after.dirty).toBe(true);
    expect(result.afterRecords).toEqual(result.beforeRecords); expect(result.afterMetadata).toEqual(result.beforeMetadata);
    expect(result.afterImageHash).toBe(result.beforeImageHash); expect(result.imageCount).toBe(1);
    expect(result.admissions).toEqual(result.baseline); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });
  test('an oversized stored metadata Blob is refused before any body read or slice', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.oversizedMetadata());
    expect(result.bodyReads).toBe(0); expect(result.bodySlices).toBe(0); expect(result.records).toBe(0); expect(result.corrupt).toBe(true);
    expect(result.after).toEqual(result.before); expect(result.admissions).toEqual(result.baseline);
    expect(result.name).toBe('oversized-reopen.ply'); expect(result.background).toBe('black'); expect(result.status).toContain('could not be read'); expect(result.error).toBeNull();
  });
  test('per-record workspace admission failure remains an AdmissionError and retains the complete pair', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.lookupAdmissionRefusal());
    expect(result.resolved).toBe(false); expect(result.admissionError).toBe(true); expect(result.message.length).toBeGreaterThan(0);
    expect(result.admitted).toHaveLength(2); expect(result.attempts).toHaveLength(3);
    expect(result.usage.bytes).toBe(0); expect(result.usage.allocations).toBe(0); expect(result.usage.peakBytes).toBeGreaterThan(0);
    expect(result.after).toEqual(result.before); expect(result.afterRecords).toEqual(result.beforeRecords);
    expect(result.afterMetadata).toEqual(result.beforeMetadata); expect(result.afterImage).toBe(result.beforeImage);
    expect(result.admissions).toEqual(result.baseline);
  });
  test('mismatched and huge PNG IHDR dimensions refuse before browser decoding with no residual admissions', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.pngDimensionsBeforeDecode());
    expect(result.outcomes.map(value => value.declaredWidth)).toEqual([2, 0x7fff_ffff]); expect(result.decodeCalls).toBe(0);
    for (const value of result.outcomes) {
      expect(value.verifyError).toContain('header'); expect(value.decodeCalls).toBe(0);
      expect(value.admissions).toEqual(result.baseline);
    }
    expect(result.after).toEqual(result.before); expect(result.admissions).toEqual(result.baseline);
  });
  test('Close joins a held real capture allocation before releasing its image ownership and permits reopen', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.closeHeldCapture());
    expect(result.baseline).toEqual({ bytes: 0, allocations: 0 }); expect(result.captureAdmissions.bytes).toBeGreaterThan(0);
    expect(result.whileHeld.closed).toBe(false); expect(result.whileHeld.admissions).toEqual(result.captureAdmissions);
    expect(result.whileHeld.sourceCleared).toBe(true); expect(result.whileHeld.sceneCleared).toBe(true);
    expect(result.accepted).toBe(false); expect(result.after.closed).toBe(true); expect(result.after.summary).toBeNull();
    expect(result.after.admissions).toEqual(result.baseline); expect(result.after.pending).toBe(false); expect(result.after.pairs).toBe(0);
    expect(result.name).toBe('after-held-close.ply'); expect(result.reopenedIds).toEqual([0, 1, 2, 3, 4]); expect(result.error).toBeNull();
  });
  test('canceling an open aborts its held real readonly lookup before manual release and retains old Redo', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.cancelHeldLookup());
    expect(result.beforeCancel).toBeNull(); expect(result.terminal).toBe('aborted'); expect(result.sameOwner).toBe(true);
    expect(result.after).toEqual(result.before); expect(result.before.summary.canRedo).toBe(true); expect(result.name).toBe('original.ply');
    expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    expect(result.admissions).toEqual(result.baseline); expect(result.closed).toBe(true); expect(result.finalAdmissions).toEqual({ bytes: 0, allocations: 0 });
  });
  test('retained record ownership follows choose, dismiss, replacement, repeated save/reopen and Close', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.recordOwnership());
    const zero = { bytes: 0, allocations: 0 }, one = { bytes: 8192 * 2 + 2048, allocations: 1 },
      two = { bytes: 2 * (8192 * 2 + 2048), allocations: 1 };
    expect(result.empty).toEqual(zero); expect(result.single).toEqual(one); expect(result.cycles).toHaveLength(3);
    for (const cycle of result.cycles) {
      expect(cycle.saved).toEqual(one); expect(cycle.reopened).toEqual(one);
      expect(cycle.records).toBe(1); expect(cycle.images).toBe(1); expect(cycle.recordId).toBe(result.firstRecordId); expect(cycle.choices).toBe(0);
    }
    expect(result.two).toEqual({ admissions: two, choices: 2 }); expect(result.chosen).toBe(true);
    expect(result.one).toEqual({ admissions: one, choices: 0, background: 'gray' });
    expect(result.beforeDismiss.admissions).toEqual(two); expect(result.beforeDismiss.choices).toBe(2);
    expect(result.dismissed.admissions).toEqual(zero); expect(result.dismissed.choices).toBe(0);
    expect(result.dismissed.camera).toEqual(result.beforeDismiss.camera); expect(result.dismissed.background).toBe('black');
    expect(result.beforeReplacement).toEqual(two);
    expect(result.replaced).toEqual({ admissions: zero, choices: 0, keyChanged: true, background: 'black' });
    expect(result.beforeClose).toEqual(two);
    expect(result.closed).toEqual({ admissions: zero, choices: 0, summary: null, sourceCleared: true });
    expect(result.records).toBe(2); expect(result.images).toBe(2); expect(result.error).toBeNull();
  });
  test('final returned-record retention admission refuses as AdmissionError after valid decoding without corrupting data', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.retentionAdmissionRefusal());
    expect(result.resolved).toBe(false); expect(result.admissionError).toBe(true); expect(result.message.length).toBeGreaterThan(0);
    expect(result.attempts).toHaveLength(5); expect(result.admitted).toEqual(result.attempts.slice(0, -1));
    expect(result.attempts.at(-1)).toBe(8192 * 2 + 2048);
    expect(result.usage.bytes).toBe(0); expect(result.usage.allocations).toBe(0); expect(result.usage.peakBytes).toBeGreaterThan(0);
    expect(result.after).toEqual(result.before); expect(result.afterRecords).toEqual(result.beforeRecords);
    expect(result.afterMetadata).toEqual(result.beforeMetadata); expect(result.afterImage).toBe(result.beforeImage);
    expect(result.admissions).toEqual(result.baseline);
  });
  for (const kind of ['missing', 'hash'] as const) test(`a real stored ${kind === 'missing' ? 'missing PNG' : 'PNG hash mismatch'} retains executable old history and falls back to native framing`, async ({ page }) => {
    const result = await page.evaluate(kind => window.savedViewHarness.storedImageRefusal(kind), kind);
    expect(result.records).toBe(0); expect(result.corrupt).toBe(true); expect(result.decodeCalls).toBe(0);
    expect(result.before.summary.canRedo).toBe(true); expect(result.after).toEqual(result.before); expect(result.admissions).toEqual(result.baseline);
    expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    expect(result.reopened.camera.slice(0, 10)).toEqual(result.reopened.nativeCamera.slice(0, 10));
    expect(result.reopened.camera[10]).toBeCloseTo(321 / 241, 6); expect(result.reopened.background).toBe('black');
    expect(result.reopened.choices).toBe(0); expect(result.reopened.admissions).toEqual({ bytes: 0, allocations: 0 });
    expect(result.reopened.status).toContain('could not be read'); expect(result.reopened.name).toBe(`corrupt-${kind}-reopened.ply`);
    expect(result.afterMetadata).toEqual(result.beforeMetadata); expect(result.afterImage).toBe(result.corruptedImage);
    expect(result.imageCount).toBe(kind === 'missing' ? 0 : 1);
    if (kind === 'missing') expect(result.corruptedImage).toBeNull();
    else { expect(result.corruptedImage).not.toBeNull(); expect(result.corruptedImage).not.toBe(result.expectedImageHash); }
    expect(result.error).toBeNull();
  });
  for (const kind of ['points', 'mesh'] as const) test(`ordinary ${kind} saved view restores camera/background through Reset and renamed native reopen`, async ({ page }) => {
    const result = await page.evaluate(kind => window.savedViewHarness.geometryView(kind), kind);
    const count = kind === 'points' ? 3 : 6, nativeKind = kind === 'points' ? 1 : 2;
    expect(result.summary.kind).toBe(nativeKind); expect(result.summary.count).toBe(count); expect(result.after).toEqual(result.summary);
    expect(result.accepted).toBe(true); expect(result.records).toBe(1); expect(result.images).toBe(1);
    expect(result.record.sourceKind).toBe(kind); expect(result.record.source).toEqual(result.initialKey);
    expect(result.image.width).toBe(241); expect(result.image.height).toBe(241);
    expect(result.reset).toEqual({ camera: result.requested, background: 'gray' });
    expect(result.reopened.camera).toEqual(result.requested); expect(result.reopened.background).toBe('gray');
    expect(result.reopened.key).toEqual(result.initialKey); expect(result.reopened.kind).toBe(nativeKind); expect(result.reopened.count).toBe(count);
    expect(result.reopened.sceneKind).toBe('geometry'); expect(result.reopened.choices).toBe(0); expect(result.reopened.dirty).toBe(false);
    expect(result.reopened.admissions).toEqual({ bytes: 8192 * 2 + 2048, allocations: 1 }); expect(result.reopened.name).toBe(`renamed-${kind}.ply`);
    expect(result.editAccepted).toBe(false); expect(result.closedAdmissions).toEqual({ bytes: 0, allocations: 0 }); expect(result.error).toBeNull();
  });
  test('odd landscape/portrait, small and downsampled crops obey the native centered-square policy', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.crops());
    expect(result.map(value => value.pixels.width)).toEqual([5, 5, 3, 1024]);
    for (const value of result) {
      expect(value.pixels.width).toBe(value.pixels.height); expect(value.pixels.corner).toEqual([0, 0, 255, 255]);
      expect(value.thumbnail.width).toBe(value.pixels.width); expect(value.thumbnail.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  test('identical-content ambiguity keeps initial framing until an explicit record is chosen', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.ambiguity());
    expect(result.choices).toEqual(['gray', 'white']); expect(result.initial).toBe('black'); expect(result.chosen).toBe(true);
    expect(result.background).toBe('gray'); expect(result.remaining).toBe(0); expect(result.error).toBeNull();
  });
});
