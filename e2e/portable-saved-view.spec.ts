import { expect, test, type Page } from '@playwright/test';
import type {} from './saved-view-harness';
import { queuePly } from './queue-fixture';

const ZERO_IMAGES = { bytes: 0, allocations: 0 };
const ONE_RECORD = { bytes: 8192 * 2 + 2048, allocations: 1 };

type PortableSceneSnapshot = Awaited<ReturnType<Window['savedViewHarness']['portableDirtyHistory']>>['before'];
function expectSnapshotAfterJsonImport(actual: PortableSceneSnapshot | null, expected: PortableSceneSnapshot) {
  expect(actual).not.toBeNull();
  if (!actual) throw new Error('Successful import lost the current document.');
  const { state: actualState, ...actualRest } = actual, { state: expectedState, ...expectedRest } = expected;
  expect(actualRest).toEqual(expectedRest);
  expect(actualState).toHaveLength(expectedState.length);
  // The schema uses JSON.stringify, which serializes -0 as 0. Numeric ===
  // permits exactly that equivalence, with no tolerance or coercion. Native
  // summary, CSV, dirty state and every other snapshot field stay deep-exact.
  actualState.forEach((value, index) => expect(value === expectedState[index]).toBe(true));
}

test.describe('Portable saved views through real native/WebGPU, ZIP and IndexedDB', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/saved-view-harness.html'); await page.waitForFunction(() => !!window.savedViewHarness);
  });
  for (const kind of ['gaussian', 'points', 'mesh'] as const) test(`${kind} exports the stored immutable pair and imports a fresh view on renamed matching content`, async ({ page }) => {
    const result = await page.evaluate(kind => window.savedViewHarness.portableRoundTrip(kind), kind);
    expect(result.afterExport).toEqual(result.beforeExport); expect(result.beforeExport.outputPending).toBe(false);
    expect(result.members.map(value => value.name).sort()).toEqual(['thumbnail.png', 'view.json']);
    for (const member of result.members) { expect(member.method).toBe(0); expect(member.crcValid).toBe(true); expect(member.size).toBeGreaterThan(0); }
    expect(result.packageRecord).toEqual(result.original); expect(result.packageImage).toEqual(result.originalImage);
    expect(result.name).toMatch(/-view\.splatview-view\.zip$/); expect(result.original.sourceKind).toBe(kind);
    expect(result.original.source).toEqual(result.source); expect(result.imported).toBe(true); expect(result.again).toBe(true);
    expect(result.after).toEqual(result.before); expect(result.restored.background).toBe('gray'); expect(result.restored.available).toBe(true);
    const view = result.original.view, camera = [...view.target, view.yaw, view.pitch, view.distance, view.radius, view.fov, view.yUp ? 1 : 0, view.roll];
    expect(result.exportBackground).toBe('white'); expect(result.exportCamera.slice(0, 10)).not.toEqual(camera);
    expect(result.restored.camera.slice(0, 10)).toEqual(camera); expect(result.restored.camera[10]).toBe(Math.fround(result.restored.aspect));
    expect(result.restored.aspect).toBe(407 / 239); expect(result.reset).toEqual({ camera: result.restored.camera, background: 'gray' });
    expect(result.adopted.recordId).not.toBe(result.original.recordId); expect(result.adopted.source).toEqual(result.original.source);
    expect(result.adopted.sourceKind).toBe(kind); expect(result.adopted.view).toEqual(result.original.view);
    expect(result.adopted.thumbnail).toEqual(result.original.thumbnail); expect(result.adopted.displayName).toBe(result.original.displayName);
    expect(result.adopted.createdAt).toBeGreaterThanOrEqual(result.startedAt); expect(result.adopted.updatedAt).toBeLessThanOrEqual(result.finishedAt);
    expect(result.records).toHaveLength(3); expect(new Set(result.records.map(value => value.recordId)).size).toBe(3);
    const originalIndex = result.records.findIndex(value => value.recordId === result.original.recordId);
    expect(result.records[originalIndex]).toEqual(result.original); expect(result.metadata[originalIndex]).toBe(result.originalMetadata);
    for (const image of result.importedImages) expect(image).toEqual(result.originalImage);
    expect(result.savedAdmissions).toEqual(ONE_RECORD); expect(result.baseline.allocations).toBe(2);
    // IDB cloning loses the imported-slice backing identity: retain possible
    // old container overhead plus separately constructed output JSON/headers.
    expect(result.baseline.bytes - result.savedAdmissions.bytes).toBe(result.original.thumbnail.byteLength + 2 * (8192 + 2048));
    expect(result.admissions).toEqual(result.baseline);
    if (kind === 'gaussian') {
      expect(result.before.summary.canRedo).toBe(true); expect(result.redo).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]);
      expect(result.undo).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    }
    expect(result.revoked).toBe(true); expect(result.closedAdmissions).toEqual(ZERO_IMAGES);
    expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });

  test('portable export/import preserves a dirty scene and executable retained Redo without a scene-output receipt', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.portableDirtyHistory());
    expect(result.before.dirty).toBe(true); expect(result.before.summary.visible).toBe(4); expect(result.before.summary.canRedo).toBe(true);
    expect(result.exported).toBe(true); expect(result.afterExport).toEqual(result.before);
    expect(result.imported).toBe(true); expectSnapshotAfterJsonImport(result.afterImport, result.before);
    expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 3, 4]);
    expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    expect(result.outputPending).toBe(false); expect(result.error).toBeNull();
  });

  for (const kind of ['source', 'kind', 'hash', 'schema', 'crc'] as const) test(`refuses ${kind} mismatch without publishing a pair, camera or history`, async ({ page }) => {
    const result = await page.evaluate(kind => window.savedViewHarness.portableRefusal(kind), kind);
    expect(result.accepted).toBe(false); expect(result.status).toContain('Could not import'); expect(result.sameOwner).toBe(true);
    expect(result.before.summary.canRedo).toBe(true); expect(result.after).toEqual(result.before); expect(result.admissions).toEqual(result.baseline);
    expect(result.afterRecords).toEqual(result.beforeRecords); expect(result.afterMetadata).toEqual(result.beforeMetadata);
    expect(result.afterImage).toBe(result.beforeImage); expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]);
    expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    expect(result.outputPending).toBe(false); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });

  for (const mode of ['cancel', 'replace', 'close', 'newer'] as const) test(`${mode} revokes a held real import read but retains its admission until settlement`, async ({ page }) => {
    const result = await page.evaluate(mode => window.savedViewHarness.portableHeldRead(mode), mode);
    expect(result.counts).toEqual({ started: 1, completed: 1 }); expect(result.admitted.bytes).toBeGreaterThan(result.baseline.bytes);
    expect(result.admitted.allocations).toBeGreaterThan(result.baseline.allocations);
    expect(result.whileHeld.settled).toBe(false); expect(result.whileHeld.closed).toBe(false);
    expect(result.whileHeld.counts).toEqual(result.counts); expect(result.whileHeld.admissions.bytes).toBeGreaterThan(0);
    expect(result.accepted).toBe(false); expect(result.currentOriginalMetadata).toBe(result.originalMetadata);
    expect(result.afterRecords).toHaveLength(mode === 'newer' ? 2 : 1);
    if (mode === 'cancel' || mode === 'newer') {
      expect(result.sameSource).toBe(true);
      if (mode === 'newer') expectSnapshotAfterJsonImport(result.after, result.before);
      else expect(result.after).toEqual(result.before);
      expect(result.admissions).toEqual(result.baseline);
      expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    }
    if (mode === 'replace') { expect(result.sameSource).toBe(false); expect(result.name).toBe('held-portable-replacement.ply'); expect(result.after?.background).toBe('black'); }
    if (mode === 'close') { expect(result.whileHeld.sourceCleared).toBe(true); expect(result.closed).toBe(true); expect(result.after).toBeNull(); }
    if (mode === 'newer') expect(result.newer).toBe(true);
    expect(result.finalAdmissions).toEqual(ZERO_IMAGES); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });

  for (const mode of ['edit', 'replace', 'close', 'newer'] as const) test(`${mode} aborts both queued import puts before the held real transaction commits`, async ({ page }) => {
    const result = await page.evaluate(mode => window.savedViewHarness.portableHeldTransaction(mode), mode);
    expect(result.queued.queuedWrites).toBe(2); expect(result.queued.terminalStatus).toBeNull();
    expect(result.admitted.bytes).toBeGreaterThan(result.baseline.bytes); expect(result.terminal.terminalStatus).toBe('aborted'); expect(result.accepted).toBe(false);
    expect(result.currentOriginalMetadata).toBe(result.originalMetadata); expect(result.currentOriginalImage).toBe(result.originalImage);
    expect(result.afterRecords).toHaveLength(mode === 'newer' ? 2 : 1);
    if (mode === 'edit') {
      expect(result.edited).toBe(true); expect(result.before.summary.canRedo).toBe(true); expect(result.before.summary.visible).toBe(5);
      expect(result.after?.summary.visible).toBe(4); expect(result.after?.dirty).toBe(true); expect(result.sameSource).toBe(true);
      expect(result.undone).toBe(true); expect(result.undoIds).toEqual([0, 1, 2, 3, 4]); expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]);
      expect(result.admissions).toEqual(result.baseline);
    }
    if (mode === 'replace') { expect(result.sameSource).toBe(false); expect(result.background).toBe('black'); }
    if (mode === 'close') { expect(result.after).toBeNull(); expect(result.admissions).toEqual(ZERO_IMAGES); }
    if (mode === 'newer') {
      expect(result.newer).toBe(true); expectSnapshotAfterJsonImport(result.after, result.before); expect(result.admissions).toEqual(result.baseline);
      expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.undoIds).toEqual([0, 1, 2, 3, 4]);
    }
    expect(result.finalAdmissions).toEqual(ZERO_IMAGES); expect(result.pending).toBe(false); expect(result.error).toBeNull();
  });

  test('a newer import cannot retire the old export comparison snapshot while its genuine bitmap delivery is held', async ({ page }) => {
    const result = await page.evaluate(() => window.savedViewHarness.portableHeldExportOwner());
    expect(result.initiallyHeld.dimensions).toEqual([241, 241]); expect(result.initiallyHeld.closes).toBe(0);
    expect(result.initiallyHeld.recordOwners).toBe(3); expect(result.initiallyHeld.admissions.bytes).toBeGreaterThan(result.baseline.bytes);
    expect(result.imported).toBe(true); expect(result.whileHeld.settled).toBe(false); expect(result.whileHeld.closes).toBe(0);
    expect(result.whileHeld.recordOwners).toBe(3); expect(result.whileHeld.admissions).toEqual(result.initiallyHeld.admissions);
    expect(result.exported).toBe(false); expect(result.closes).toBe(1); expect(result.remainingRecordOwners).toBe(1);
    expect(result.admissions).toEqual(result.baseline); expectSnapshotAfterJsonImport(result.after, result.before); expect(result.records).toBe(2); expect(result.downloads).toBe(1);
    expect(result.redone).toBe(true); expect(result.redoIds).toEqual([0, 2, 3, 4]); expect(result.undone).toBe(true); expect(result.undoCsv).toBe(result.before.csv);
    expect(result.finalAdmissions).toEqual(ZERO_IMAGES); expect(result.revoked).toBe(true); expect(result.error).toBeNull();
  });
});

async function appPairs(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('splatview-views', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const pairs = await new Promise<{ metadata: { meta: Blob }[]; images: { recordId: string; image: Blob }[] }>((resolve, reject) => {
        const transaction = database.transaction(['views', 'thumbnails']), records = transaction.objectStore('views').getAll(), images = transaction.objectStore('thumbnails').getAll();
        transaction.oncomplete = () => resolve({ metadata: records.result, images: images.result }); transaction.onabort = () => reject(transaction.error);
      });
      return { records: await Promise.all(pairs.metadata.map(async entry => JSON.parse(await entry.meta.text()))), imageCount: pairs.images.length };
    } finally { database.close(); }
  });
}
for (const kind of ['gaussian', 'points'] as const) test(`actual ${kind} App Settings exposes real portable download and file-input import without enabling geometry edits`, async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.evaluate(() => new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase('splatview-views');
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Saved storage is blocked.')); }));
  const input = kind === 'gaussian' ? Buffer.from(queuePly()) : Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n-.4 0 0 255 0 0\n.4 0 0 0 255 0\n0 .4 .1 0 0 255\n');
  await page.getByLabel('Open scene files').setInputFiles({ name: `portable-app-${kind}.ply`, mimeType: 'application/octet-stream', buffer: input });
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  const remember = settings.getByRole('button', { name: 'Remember view', exact: true }), background = page.getByRole('button', { name: 'Background', exact: true });
  await expect(background).toBeEnabled(); await page.mouse.move(640, 400);
  if (kind === 'gaussian') await page.getByRole('button', { name: 'Tools', exact: true }).click();
  else {
    await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Viewer panel', exact: true }).getByRole('button')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import view…', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Export saved view', exact: true })).toBeDisabled();
  await expect(remember).toBeEnabled();
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await background.click(); await expect(background).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await remember.click();
  await expect.poll(async () => (await appPairs(page)).records.length).toBe(1); await expect(remember).toBeEnabled();
  const previous = await appPairs(page);
  await page.evaluate(() => {
    const host = window as unknown as { portableAppDownload?: Blob; portableAppFilename?: string }, create = URL.createObjectURL,
      click = HTMLAnchorElement.prototype.click, blobs = new Map<string, Blob>();
    URL.createObjectURL = function(value) { const url = create.call(URL, value); if (value instanceof Blob) blobs.set(url, value); return url; };
    HTMLAnchorElement.prototype.click = function() {
      if (this.download.endsWith('.splatview-view.zip')) { host.portableAppDownload = blobs.get(this.href); host.portableAppFilename = this.download; return; }
      return click.call(this);
    };
  });
  await expect(page.getByRole('button', { name: 'Export saved view', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Export saved view', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { portableAppDownload?: Blob }).portableAppDownload instanceof Blob);
  const download = await page.evaluate(async () => {
    const host = window as unknown as { portableAppDownload: Blob; portableAppFilename: string };
    return { name: host.portableAppFilename, bytes: Array.from(new Uint8Array(await host.portableAppDownload.arrayBuffer())) };
  });
  expect(download.name).toBe(`portable-app-${kind}-view.splatview-view.zip`);
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await background.click(); await expect(background).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Import saved view')).toHaveAttribute('accept', '.zip,.splatview-view.zip');
  await page.getByRole('button', { name: 'Import view…', exact: true }).click();
  await page.getByLabel('Import saved view').setInputFiles({ name: download.name, mimeType: 'application/zip', buffer: Buffer.from(download.bytes) });
  await expect.poll(async () => (await appPairs(page)).records.length).toBe(2);
  await expect(page.getByRole('button', { name: 'Export saved view', exact: true })).toBeEnabled();
  const current = await appPairs(page);
  expect(current.imageCount).toBe(2); expect(current.records.find(record => record.recordId === previous.records[0].recordId)).toEqual(previous.records[0]);
  const imported = current.records.find(record => record.recordId !== previous.records[0].recordId)!;
  expect(imported.source).toEqual(previous.records[0].source); expect(imported.sourceKind).toBe(kind); expect(imported.view).toEqual(previous.records[0].view);
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click(); await expect(background).toHaveAttribute('data-background', 'gray');
  await background.click(); await page.getByRole('button', { name: 'Reset camera', exact: true }).click(); await expect(background).toHaveAttribute('data-background', 'gray');
  await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0);
  if (kind === 'points') await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
});
