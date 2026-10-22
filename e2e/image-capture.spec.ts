import { expect, test, type TestInfo } from '@playwright/test';
import type {} from './image-capture-harness';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });
async function evidence(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, { contentType: 'application/json', body: JSON.stringify(value) });
}
function grayImage(value: { width: number; height: number; foreground: number; corner: number[] }, tolerance = 1) {
  expect(value.width).toBe(321); expect(value.height).toBe(241); expect(value.foreground).toBeGreaterThan(0);
  for (const channel of value.corner.slice(0, 3)) expect(Math.abs(channel - 127.5)).toBeLessThanOrEqual(tolerance);
  expect(value.corner[3]).toBe(255);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/image-capture-harness.html'); await page.waitForFunction(() => !!window.imageCaptureHarness);
});

test('actual owned PNG/JPEG freeze preview, camera, background and framebuffer while preserving native SH3/history', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.actualImages());
  await evidence(info, 'image-owned-native-gpu-evidence.json', value);
  expect(value.baseline).toEqual({ bytes: 0, allocations: 0 }); expect(value.final).toEqual(value.baseline);
  for (const image of [value.neutral, value.preview, value.jpeg]) {
    expect(image.size).toBeGreaterThan(0); expect(image.admitted.bytes).toBeGreaterThan(0); grayImage(image.pixels, image.type === 'image/jpeg' ? 2 : 1);
  }
  expect(value.neutral.type).toBe('image/png'); expect(value.preview.type).toBe('image/png'); expect(value.jpeg.type).toBe('image/jpeg');
  expect(value.preview.pixels.hash).not.toBe(value.neutral.pixels.hash); expect(value.frozen).toEqual(value.preview.pixels);
  expect(value.after.csv).toBe(value.before.csv); expect(value.after.document).toEqual(value.before.document);
  expect(value.after.summary).toMatchObject({ revision: value.before.summary.revision, contentRevision: value.before.summary.contentRevision, shDegree: 3, canRedo: true });
  expect(value.after.camera).toEqual(value.before.camera); expect(value.after.background).toBe('gray');
});

for (const reason of ['timeout', 'pagehide', 'close'] as const) {
  test(`actual snapshot Download retains its encoded JPEG owner until ${reason} settles the URL exactly once`, async ({ page }, info) => {
    const value = await page.evaluate(reason => window.imageCaptureHarness.downloadSettlement(reason), reason);
    await evidence(info, 'image-download-settlement-evidence.json', value);
    expect(value.name).toBe('SplatView.jpg'); expect(value.mime).toBe('image/jpeg'); grayImage(value.image, 2);
    expect(value.retained.bytes).toBeGreaterThan(value.baseline.bytes); expect(value.retained.allocations).toBeGreaterThan(value.baseline.allocations);
    expect(value.settled).toEqual(value.baseline); expect(value.afterSecond).toEqual(value.baseline); expect(value.revoked).toBe(1);
    if (reason === 'close') expect(value.after).toBeNull();
    else { expect(value.after!.csv).toBe(value.before.csv); expect(value.after!.document).toEqual(value.before.document); }
    expect(value.state.error).toBeNull();
  });
}

test('Close aborts an actual encoded snapshot but joins its held browser encoder before releasing image credits', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.closeHeldEncode());
  await evidence(info, 'image-close-held-encoder-evidence.json', value);
  expect(value.admitted.bytes).toBeGreaterThan(value.baseline.bytes);
  expect(value.whileHeld).toMatchObject({ closed: false, image: value.admitted, outputs: 0, encode: { calls: 1, completed: 1 } });
  expect(value.aborted).toBe(true); expect(value.closed).toBe(true); expect(value.outputs).toBe(0);
  expect(value.final).toMatchObject({ hasClient: false, hasScene: false, busy: false, image: value.baseline, error: null });
});

test('synchronous Close inside actual capture allocation joins the registered image task before releasing its readback owner', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.reentrantAllocationClose());
  await evidence(info, 'image-reentrant-allocation-close-evidence.json', value);
  expect(value.whileHeld).toMatchObject({ synchronous: true, closed: false, readbackAllocated: true, destroyed: 0, outputs: 0 });
  expect(value.whileHeld.image.bytes).toBeGreaterThan(value.baseline.bytes);
  expect(value.closed).toBe(true); expect(value.destroyed).toBe(1); expect(value.outputs).toBe(0); expect(value.remainingTasks).toBe(0);
  expect(value.final).toMatchObject({ hasClient: false, hasScene: false, busy: false, image: value.baseline, error: null });
});

test('Close reentering actual URL creation settles the stale image and its late timer cannot retire a fresh Download', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.reentrantUrlClose());
  await evidence(info, 'image-reentrant-url-close-evidence.json', value);
  expect(value.synchronous).toBe(false); // URL creation follows the genuine asynchronous GPU/encoder work.
  expect(value.afterClose).toMatchObject({ closed: true, image: value.baseline, revoked: 1, trackedDownloads: 0,
    state: { hasClient: false, hasScene: false, busy: false, error: null } });
  expect(value.retained.bytes).toBeGreaterThan(value.baseline.bytes);
  expect(value.afterOldTimer).toEqual({ image: value.retained, oldRevocations: 1, freshRevocations: 0, trackedDownloads: 1 });
  expect(value.final).toMatchObject({ hasClient: false, hasScene: false, busy: false, image: value.baseline, error: null });
});

test('Copy starts native clipboard.write synchronously in a trusted click and Close joins pending clipboard ownership', async ({ page }, info) => {
  const setup = await page.evaluate(() => window.imageCaptureHarness.clipboardSetup());
  try {
    await page.getByRole('button', { name: 'Copy image', exact: true }).click();
    const held = await page.evaluate(() => window.imageCaptureHarness.clipboardHeld());
    await evidence(info, 'image-clipboard-held-evidence.json', { setup, held });
    expect(held).toMatchObject({ calls: 1, synchronous: true, trusted: true, nativeSettled: true, returnedSettled: false, png: true, closed: false });
    expect(held.image.hash).toBe(setup.expected.pixels.hash); grayImage(held.image);
    expect(held.retained.bytes).toBeGreaterThan(setup.baseline.bytes); expect(held.whileHeld).toEqual(held.retained);
  } finally {
    const final = await page.evaluate(() => window.imageCaptureHarness.clipboardRelease());
    await evidence(info, 'image-clipboard-settled-evidence.json', final);
    expect(final.returnedSettled).toBe(true); expect(final.closed).toBe(true);
    expect(final.final).toMatchObject({ image: setup.baseline, hasClient: false, hasScene: false, busy: false, error: null });
  }
});

test('actual saved thumbnail crops raw GPU pixels with one PNG encode and no source PNG decode', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.rawThumbnail());
  await evidence(info, 'image-raw-thumbnail-idb-evidence.json', value);
  expect(value.accepted).toBe(true); expect(value.calls).toEqual({ decodes: 1, encodes: 1 });
  // Storage validates its final PNG before the atomic write. That decode must
  // consume the sole completed thumbnail encode, without a source PNG round trip.
  expect(value.decodeInputs).toEqual([{ afterEncode: true, finalEncodedBlob: true, type: 'image/png', bytes: value.blobSize, width: 241, height: 241 }]);
  expect(value.records).toBe(1); expect(value.images).toBe(1); expect(value.image.width).toBe(241); expect(value.image.height).toBe(241);
  expect(value.image.hash).toBe(value.expectedCropHash); expect(value.metadata).toMatchObject({ type: 'image/png', width: 241, height: 241,
    byteLength: value.blobSize, sha256: value.blobHash });
  expect(value.after.csv).toBe(value.before.csv); expect(value.after.document).toEqual(value.before.document);
  expect(value.after.summary).toMatchObject({ revision: value.before.summary.revision, contentRevision: value.before.summary.contentRevision, canRedo: true });
  expect(value.retained).toEqual({ bytes: 18432, allocations: 1 });
  expect(value.final).toMatchObject({ image: value.baseline, hasClient: false, hasScene: false, thumbnailPending: false, error: null });
});

test.describe('opaque compositor input reaches actual resized saved thumbnails', () => {
  test.use({ deviceScaleFactor: 1, viewport: { width: 1100, height: 1100 } });
  for (const kind of ['gaussian', 'points', 'mesh'] as const) {
    test(`${kind} keeps every pre-filter capture alpha opaque over black, gray and white`, async ({ page }, info) => {
      const value = await page.evaluate(kind => window.imageCaptureHarness.opaqueThumbnails(kind), kind);
      await evidence(info, `image-opaque-capture-${kind}-evidence.json`, value);
      const nativeKind = kind === 'gaussian' ? 0 : kind === 'points' ? 1 : 2, count = kind === 'mesh' ? 6 : 3;
      expect(value.kind).toBe(kind); expect(value.initialImage).toEqual({ bytes: 0, allocations: 0 });
      expect(value.baseline).toEqual(value.initialImage);
      expect(value.rows.map(row => row.background)).toEqual(['black', 'gray', 'white']);
      expect(new Set(value.rows.map(row => row.raw.hash)).size).toBe(3);
      expect(new Set(value.rows.map(row => row.recordId)).size).toBe(1);
      for (const row of value.rows) {
        expect(row.accepted).toBe(true); expect(row.calls).toEqual({ captures: 1, encodes: 1, decodes: 1 });
        // These are the actual OwnedRgbaImage bytes before the filter's final
        // opaque-alpha write. An opaque decoded PNG alone cannot prove this.
        expect(row.raw).toMatchObject({ width: 1027, height: 1025, nativeKind, currentScene: true, currentCamera: true,
          sceneKind: kind === 'gaussian' ? 'gaussian' : 'geometry',
          count: 1027 * 1025, opaque: 1027 * 1025, nonOpaque: 0, minimum: 255, maximum: 255 });
        expect(row.raw.hash).toMatch(/^[0-9a-f]{64}$/); expect(row.raw.foreground).toBeGreaterThan(0); expect(row.raw.background).toBeGreaterThan(0);
        expect(row.rawBytesAfterStorage).toBe(0);
        const shade = row.background === 'black' ? 0 : row.background === 'gray' ? 127.5 : 255;
        for (const channel of row.raw.corner.slice(0, 3)) expect(Math.abs(channel - shade)).toBeLessThanOrEqual(.5);
        expect(row.decodeInputs).toEqual([{ finalEncodedBlob: true, type: 'image/png', width: 1024, height: 1024 }]);
        expect(row.records).toBe(1); expect(row.images).toBe(1);
        expect(row.recordId).toBe(row.imageRecordId); expect(row.recordId).toBe(row.storedRecordId);
        expect(row.sourceKind).toBe(kind); expect(row.savedBackground).toBe(row.background);
        expect(row.blobSize).toBeGreaterThan(0); expect(row.blobHash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.metadata).toEqual({ type: 'image/png', width: 1024, height: 1024, byteLength: row.blobSize, sha256: row.blobHash });
        expect(row.image).toMatchObject({ width: 1024, height: 1024, count: 1024 * 1024,
          opaque: 1024 * 1024, nonOpaque: 0, minimum: 255, maximum: 255 });
        expect(row.image.foreground).toBeGreaterThan(0); expect(row.image.background).toBeGreaterThan(0);
        for (const channel of row.image.corner.slice(0, 3)) expect(Math.abs(channel - shade)).toBeLessThanOrEqual(.5);
        expect(row.before.summary).toMatchObject({ kind: nativeKind, count, visible: count, loaded: true, transaction: false, selectionDraft: false, pending: false });
        expect(row.after).toEqual(row.before);
        if (kind === 'gaussian') {
          expect(row.before.summary).toMatchObject({ shDegree: 3, selected: 2, canUndo: true, canRedo: true });
          expect(row.before.masks).toEqual([1, 0, 1]); expect(row.before.csv).toContain('x,y,z'); expect(row.before.geometry).toBeNull();
          expect(row.before.editingAvailable).toBe(true);
        } else {
          expect(row.before.summary).toMatchObject({ selected: 0, canUndo: false, canRedo: false });
          expect(row.before.sceneKind).toBe('geometry'); expect(row.before.geometry).toMatchObject({ kind: nativeKind, vertexCount: count });
          expect(row.before.csv).toBeNull(); expect(row.before.masks).toBeNull(); expect(row.before.editingAvailable).toBe(false);
        }
      }
      if (kind === 'gaussian') {
        const history = value.history!;
        expect(history.redoAccepted).toBe(true); expect(history.undoAccepted).toBe(true);
        expect(history.before.masks).toEqual([1, 0, 1]); expect(history.redone.masks).toEqual([1, 1, 1]); expect(history.restored.masks).toEqual(history.before.masks);
        expect(history.redone.summary).toMatchObject({ selected: 3, canUndo: true, canRedo: false, shDegree: 3, contentRevision: history.before.summary.contentRevision });
        expect(history.restored.summary).toMatchObject({ selected: 2, canUndo: true, canRedo: true, shDegree: 3, contentRevision: history.before.summary.contentRevision });
        expect(history.redone.csv).toBe(history.before.csv); expect(history.restored.csv).toBe(history.before.csv);
        expect(history.restored.camera).toEqual(history.before.camera); expect(history.restored.sourceFingerprint).toEqual(history.before.sourceFingerprint);
        expect(history.restored.dirty).toBe(history.before.dirty);
      } else expect(value.history).toBeNull();
      expect(value.retained).toEqual({ bytes: 18432, allocations: 1 });
      expect(value.final).toMatchObject({ image: value.initialImage, hasClient: false, hasScene: false, busy: false, thumbnailPending: false, error: null });
      expect(value.remainingTasks).toEqual({ images: 0, thumbnails: 0, transfers: 0 });
    });
  }
});

test('Close aborts actual queued thumbnail PNG/metadata writes and retains the previous complete pair', async ({ page }, info) => {
  const value = await page.evaluate(() => window.imageCaptureHarness.thumbnailCloseTransaction());
  await evidence(info, 'image-thumbnail-close-idb-evidence.json', value);
  expect(value.queued).toEqual({ writes: 2, terminal: null }); expect(value.admitted.bytes).toBeGreaterThan(value.baseline.bytes);
  expect(value.terminal.terminal).toBe('aborted'); expect(value.accepted).toBe(false); expect(value.current).toEqual(value.previous);
  expect(value.records).toBe(1); expect(value.images).toBe(1);
  expect(value.final).toMatchObject({ image: { bytes: 0, allocations: 0 }, hasClient: false, hasScene: false, busy: false, thumbnailPending: false, error: null });
});

for (const kind of ['replace', 'loss'] as const) {
  test(`an actual held capture readback is invalidated by ${kind} and cannot publish stale image output`, async ({ page }, info) => {
    const value = await page.evaluate(kind => window.imageCaptureHarness.invalidateReadback(kind), kind);
    await evidence(info, 'image-invalidated-readback-evidence.json', value);
    expect(value.aborted).toBe(true); expect(value.whileHeld).toMatchObject({ image: value.admitted, readback: { mapped: true, destroyed: 0 }, outputs: 0 });
    expect(value.readback).toEqual({ mapped: true, destroyed: 1 }); expect(value.outputs).toBe(0); expect(value.replacedScene).toBe(true);
    expect(value.final).toMatchObject({ image: { bytes: 0, allocations: 0 }, busy: false, hasClient: true, hasScene: true, error: null });
    if (kind === 'replace') {
      expect(value.sameClient).toBe(false); expect(value.after.sourceFingerprint).not.toEqual(value.before.sourceFingerprint); expect(value.final.sourceName).toBe('replacement-image.ply');
    } else {
      expect(value.sameClient).toBe(true); expect(value.epoch).toBeGreaterThan(value.oldEpoch);
      expect(value.after.csv).toBe(value.before.csv); expect(value.after.document).toEqual(value.before.document);
    }
  });
}
