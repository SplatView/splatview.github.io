import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import { polygonPly, polygonPositions } from './polygon-fixture';
import type { CleanupFault } from './cancel-cleanup-harness';

type Snapshot = Awaited<ReturnType<Window['cancelCleanupApp']['snapshot']>>;
const baselineIds = [0, 2], previewIds = [1];
const mask = (ids: readonly number[]) => polygonPositions.map((_, id) => Number(ids.includes(id)));
const snapshot = (page: Page) => page.evaluate(() => window.cancelCleanupApp.snapshot());
type AllocatedSnapshot = Pick<Snapshot, 'leases' | 'accounting'>;
const histogramLeaseBytes = 12_304;
function histogramEntries(value: AllocatedSnapshot) {
  const ids = value.accounting.histogramLeaseIds;
  expect(new Set(ids).size).toBe(ids.length);
  const entries = value.accounting.entries.filter(entry => ids.includes(entry.id));
  expect(entries.length).toBeLessThanOrEqual(1);
  for (const entry of entries) expect(entry).toMatchObject({ category: 'render', bytes: histogramLeaseBytes });
  return entries;
}
function recoveryEntry(value: AllocatedSnapshot) {
  const owner = value.accounting.recoveryOwner;
  expect(owner.category).toBe('recovery'); expect(owner.categoryAllocations).toBe(1);
  expect(owner.bytes).toBe(owner.categoryBytes); expect(owner.checkpointBytes).toBeGreaterThan(0);
  expect(owner.maximumChunkBytes).toBe(1_048_576);
  expect(owner.chunkCount).toBe(Math.ceil(owner.checkpointBytes / owner.maximumChunkBytes));
  // The external checkpoint owns payload, per-chunk tables, fixed bookkeeping
  // and positive metadata credit outside measured native H/C/R.
  expect(owner.bytes).toBeGreaterThan(owner.checkpointBytes + owner.chunkCount * 256 + 16 * 1024);
  expect(owner.checkpointRoot).toMatch(/^[0-9a-f]{64}$/); expect(owner.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(owner.documentId.length).toBeGreaterThan(0); expect(owner.sourceGeneration).toBeGreaterThan(0);
  const entries = value.accounting.entries.filter(entry => entry.category === 'recovery');
  expect(entries).toEqual([{ id: owner.id, category: 'recovery', bytes: owner.bytes }]);
  return entries[0];
}
function withoutHistogram<T extends AllocatedSnapshot>(value: T): T {
  // Remove only the real sampler's confirmed physical owner. All other
  // identities, capacities and native coverage remain exact assertions.
  const optional = histogramEntries(value), optionalIds = optional.map(entry => entry.id);
  recoveryEntry(value);
  expect(value.accounting.entries.length).toBe(value.leases.allocations);
  expect(value.accounting.entries.reduce((bytes, entry) => bytes + entry.bytes, 0)).toBe(value.leases.bytes);
  const entries = value.accounting.entries.filter(entry => !optionalIds.includes(entry.id));
  const leases = { ...value.leases, bytes: value.leases.bytes - optional.length * histogramLeaseBytes,
    allocations: value.leases.allocations - optional.length };
  expect(entries.length).toBe(leases.allocations);
  expect(entries.reduce((bytes, entry) => bytes + entry.bytes, 0)).toBe(leases.bytes);
  return { ...value, leases, accounting: { ...value.accounting, entries } };
}
function exact(value: Snapshot, ids: number[]) {
  expect(value.gpu).toEqual(mask(ids)); expect(value.ids).toEqual(ids); expect(value.summary.selected).toBe(ids.length);
  expect(value.summary.transaction).toBe(false); expect(value.summary.selectionMapId).toBeNull();
  expect(value.summary.pendingSelectionMapId).toBeNull(); expect(value.summary.selectionMapBytes).toBe(0); expect(value.leases.work).toEqual([]);
}
function restored(value: Snapshot, before: Snapshot) {
  exact(value, baselineIds); expect(value.selectedBytes).toEqual(before.selectedBytes); expect(value.allBytes).toEqual(before.allBytes);
  expect(value.summary.canUndo).toBe(before.summary.canUndo); expect(value.summary.canRedo).toBe(true);
  expect(value.summary.contentRevision).toBe(before.summary.contentRevision); expect(value.summary.memoryBytes).toBe(before.summary.memoryBytes);
  expect(value.summary.selectionDraft).toBe(false); expect(value.leases).toEqual(before.leases);
  expect(value.active).toBe(false); expect(value.editing).toBe(true); expect(value.busy).toBe(false); expect(value.recovery).toBe('idle');
}
async function open(page: Page, mode: 'basic' | 'pro', requireHistogramLease = false) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'cancel-cleanup-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(polygonPly()) });
  await expect(page).toHaveTitle('cancel-cleanup-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const current = page.getByRole('button', { name: mode === 'basic' ? 'Pro' : 'Basic', exact: true });
  if (await current.count()) await current.click();
  await chooseSelectionTool(page, 'Polygon');
  await page.evaluate(async () => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const { AppController } = await import(/* @vite-ignore */ resource('/src/app/controller.ts'));
    const harnessUrl = '/e2e/cancel-cleanup-harness.ts', { installCancelCleanupProbe } = await import(/* @vite-ignore */ harnessUrl);
    const original = AppController.prototype.setSelectionOperation;
    AppController.prototype.setSelectionOperation = function(operation: number) {
      AppController.prototype.setSelectionOperation = original; window.cancelCleanupApp = installCancelCleanupProbe(this);
      return original.call(this, operation);
    };
  });
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  if (requireHistogramLease) await page.waitForFunction(() => window.cancelCleanupApp.histogramLeaseReady());
  await page.evaluate(async mode => { window.cancelCleanupApp.profiles(mode); await window.cancelCleanupApp.baseline(); }, mode);
  const before = await snapshot(page); exact(before, baselineIds); expect(before.summary.canRedo).toBe(true);
  const points = await page.evaluate(() => window.cancelCleanupApp.outline());
  for (const [x, y] of points) await page.mouse.click(x, y);
  const preview = await snapshot(page); exact(preview, previewIds); expect(preview.summary.selectionDraft).toBe(true);
  return { before, preview, points };
}
async function refuse(page: Page, fault: CleanupFault) {
  await page.evaluate(fault => window.cancelCleanupApp.setFault(fault), fault); await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeEnabled();
  return snapshot(page);
}
async function blocked(page: Page, preview: Snapshot) {
  const current = await snapshot(page); exact(current, previewIds); expect(current.selectedBytes).toEqual(preview.selectedBytes);
  expect(current.allBytes).toEqual(preview.allBytes); expect(current.summary.selectionDraft).toBe(true);
  expect(current.summary.canUndo).toBe(preview.summary.canUndo); expect(current.summary.canRedo).toBe(preview.summary.canRedo);
  expect(current.leases).toEqual(preview.leases); expect(current.active).toBe(false); expect(current.editing).toBe(false);
  expect(current.busy).toBe(false); expect(current.recovery).toBe('required'); expect(current.outputPending).toBe(false);
  for (const name of ['Open scene', 'Save scene', 'Capture image', 'Copy image', 'Undo', 'Redo', 'Select all', 'Delete selected'])
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true })).toBeDisabled();
  // The selection filter is selection.volume, which web-lite excludes.
  await expect(page.getByRole('button', { name: 'Selection filter', exact: true })).toHaveCount(0);
  const result = await page.evaluate(() => window.cancelCleanupApp.blocked());
  expect(result.polygon).toBe(false); expect(result.geometric).toBe(false); expect(result.mutation).toBe(false);
  expect(result.traffic).toEqual([]); expect(result.counters).toEqual({ attempts: 0, nativeCancels: 0, admissions: 0, publications: 0, exports: 0, picks: 0, maps: 0, captures: 0 });
  expect(result.outputPending).toBe(false); expect(result.sameClient).toBe(true); expect(result.sourceName).toBe('cancel-cleanup-sh0.ply');
  expect(result.captureError).toMatch(/Restore.*selection/i); expect(result.mapError).toMatch(/Restore.*selection/i); return current;
}
async function recover(page: Page, before: Snapshot) {
  await page.evaluate(() => window.cancelCleanupApp.setFault());
  await page.getByRole('button', { name: 'Restore selection', exact: true }).click();
  const after = await snapshot(page); restored(after, before);
  await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), baselineIds);
}
async function freshGesture(page: Page, points: number[][]) {
  await chooseSelectionTool(page, 'Polygon');
  for (const [x, y] of points) await page.mouse.click(x, y);
  await page.keyboard.press('Enter'); const final = await snapshot(page); exact(final, previewIds);
  expect(final.summary.selectionDraft).toBe(false); expect(final.active).toBe(false); expect(final.summary.canRedo).toBe(false);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), baselineIds);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), previewIds);
}
async function downloadSelection(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('5'); await page.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
  const ids = rows.map(row => polygonPositions.findIndex(point => point.every((value, axis) => Math.abs(value - row[axis]) < 1e-5))).sort((a, b) => a - b);
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); return ids;
}
async function wakeChrome(page: Page) {
  // Native/GPU/history assertions provide no pointer activity. Supply the
  // movement a user makes before interacting with chrome after it has faded.
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
}

// Web-lite has no Pro profile; Basic is the only cleanup profile.
for (const mode of ['basic'] as const) test.describe(`${mode} terminal geometric cancellation recovery`, () => {
  for (const fault of ['admission', 'native', 'acknowledgement', 'publication'] as const)
    test(`${fault} refusal retains the exact draft and Redo, blocks edits and saving, then explicitly restores`, async ({ page }) => {
      const { before, preview, points } = await open(page, mode); const refused = await refuse(page, fault);
      exact(refused, previewIds); await blocked(page, preview);
      const counts = await page.evaluate(() => ({ ...window.cancelCleanupApp.counters })); expect(counts.attempts).toBe(1);
      expect(counts.nativeCancels).toBe(fault === 'acknowledgement' || fault === 'publication' ? 1 : 0);
      await recover(page, before); const after = await page.evaluate(() => ({ ...window.cancelCleanupApp.counters }));
      expect(after.attempts).toBe(2); expect(after.nativeCancels).toBe(counts.nativeCancels + 1);
      await freshGesture(page, points); if (fault === 'admission') expect(await downloadSelection(page)).toEqual(previewIds);
    });
  test('persistent admission refusal remains closed across cancellation, attempted commands and an explicit failed retry', async ({ page }) => {
    const { before, preview } = await open(page, mode); await refuse(page, 'admission'); await blocked(page, preview);
    const repeated = await page.evaluate(async () => {
      const h = window.cancelCleanupApp;
      return { results: await Promise.all([h.controller.cancelSelectionGesture(), h.controller.cancelSelectionGesture(false)]), counters: { ...h.counters } };
    });
    expect(repeated.results).toEqual([false, false]); expect(repeated.counters.attempts).toBe(1);
    await page.getByRole('button', { name: 'Restore selection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeEnabled(); await blocked(page, preview);
    expect(await page.evaluate(() => window.cancelCleanupApp.counters.attempts)).toBe(2);
    await recover(page, before); expect(await page.evaluate(() => window.cancelCleanupApp.counters.attempts)).toBe(3);
  });
  test('concurrent retries publish one restoration and a late older cancel cannot retire the new owner', async ({ page }) => {
    const { before, preview } = await open(page, mode); await refuse(page, 'admission'); await blocked(page, preview);
    await page.evaluate(() => { const h = window.cancelCleanupApp; h.setFault(); h.hold(); h.concurrentRetry(); });
    await page.waitForFunction(() => window.cancelCleanupApp.control.entered);
    expect(await page.evaluate(() => window.cancelCleanupApp.counters.attempts)).toBe(2);
    await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeDisabled();
    await page.evaluate(() => window.cancelCleanupApp.release());
    const retry = await page.evaluate(() => window.cancelCleanupApp.joinedRetry());
    expect(retry).toEqual({ first: true, second: true, fresh: true, olderSettled: false });
    await page.evaluate(() => window.cancelCleanupApp.previewFresh()); const fresh = await snapshot(page); exact(fresh, previewIds);
    expect(fresh.active).toBe(true); expect(fresh.summary.selectionDraft).toBe(true);
    expect(await page.evaluate(() => window.cancelCleanupApp.releaseOlder())).toBe(true);
    const afterOlder = await snapshot(page); exact(afterOlder, previewIds); expect(afterOlder.active).toBe(true);
    expect(afterOlder.summary.selectionDraft).toBe(true); expect(afterOlder.selectedBytes).toEqual(fresh.selectedBytes);
    const counts = await page.evaluate(() => ({ ...window.cancelCleanupApp.counters })); expect(counts.attempts).toBe(2); expect(counts.nativeCancels).toBe(1);
    expect(await page.evaluate(() => window.cancelCleanupApp.finishFresh())).toBe(true);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); const undone = await snapshot(page); exact(undone, baselineIds);
    expect(undone.selectedBytes).toEqual(before.selectedBytes); expect(undone.summary.canRedo).toBe(true);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), previewIds);
  });
});
for (const fault of ['throw', 'unknown'] as const) test(`${fault} cancellation adapter acknowledgement stays owned and explicitly retryable`, async ({ page }) => {
  const { before, preview } = await open(page, 'basic'); await refuse(page, fault); await blocked(page, preview);
  expect(await page.evaluate(() => window.cancelCleanupApp.counters.attempts)).toBe(1);
  expect(await page.evaluate(() => window.cancelCleanupApp.counters.nativeCancels)).toBe(0);
  await recover(page, before); expect(await page.evaluate(() => window.cancelCleanupApp.counters.nativeCancels)).toBe(1);
});

for (const mode of ['basic'] as const) for (const finish of ['physical Enter', 'controller confirmation'] as const)
  test(`${mode} failed ${finish} retains cleanup after refused restoration and repeated finish cannot retire its pending owner`, async ({ page }) => {
    const { before, preview, points } = await open(page, mode);
    await page.evaluate(() => window.cancelCleanupApp.holdConfirmationFailure());
    if (finish === 'physical Enter') await page.keyboard.press('Enter');
    else await page.evaluate(() => window.cancelCleanupApp.startConfirmation());
    await page.waitForFunction(() => window.cancelCleanupApp.control.confirmEntered);
    if (finish === 'physical Enter') await page.keyboard.press('Enter');
    const duplicate = await page.evaluate(() => window.cancelCleanupApp.duplicateFinish());
    expect(duplicate.results).toEqual([false, false, false, false]); expect(duplicate.traffic).toEqual([]);
    expect(duplicate.ownedBefore).toBe(true); expect(duplicate.ownedAfter).toBe(true); expect(duplicate.closed).toBe(true);
    expect(duplicate.summary.transaction).toBe(true); expect(duplicate.summary.selectionDraft).toBe(false);
    const accepted = await page.evaluate(() => window.cancelCleanupApp.releaseConfirmation());
    if (finish === 'controller confirmation') expect(accepted).toBe(false);
    await expect(page.getByRole('button', { name: 'Restore selection', exact: true })).toBeEnabled(); await blocked(page, preview);
    const failed = await page.evaluate(() => ({ traffic: window.cancelCleanupApp.traffic, counters: { ...window.cancelCleanupApp.counters } }));
    expect(failed.traffic.filter(command => command.command === 'confirmSelection')).toHaveLength(1);
    expect(failed.traffic.some(command => command.command === 'rollbackTransaction')).toBe(true);
    expect(failed.counters.attempts).toBe(1);
    await recover(page, before);
    expect(await page.evaluate(() => window.cancelCleanupApp.traffic.filter(command => command.command === 'confirmSelection').length)).toBe(1);
    await freshGesture(page, points);
  });

test('graphics recovery retains cleanup through real replacement upload failure and clears it only after a coherent new GPU mirror', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  const { before: beforeRaw, preview: previewRaw, points } = await open(page, 'basic', true);
  await refuse(page, 'admission'); await blocked(page, previewRaw);
  const before = withoutHistogram(beforeRaw), preview = withoutHistogram(previewRaw);
  expect(histogramEntries(beforeRaw)).toHaveLength(1); expect(histogramEntries(previewRaw)).toHaveLength(1);
  expect(preview.accounting.recoveryOwner).toEqual(before.accounting.recoveryOwner);
  // This four-source fixture has one uint8 state per source. Its detached
  // preview mask is the only extra live native payload over the baseline.
  const detachedMaskBytes = Uint8Array.from(mask(previewIds)).byteLength;
  expect(detachedMaskBytes).toBe(4); expect(before.summary.count).toBe(detachedMaskBytes);
  expect(preview.summary.count).toBe(before.summary.count);
  expect(preview.summary.memoryBytes).toBe(before.summary.memoryBytes + detachedMaskBytes);
  expect(preview.accounting.native).toMatchObject({ observed: true, active: true, retired: false,
    coveredBytes: preview.summary.memoryBytes, ledgerOverageBytes: 0, unreconciledHeapBytes: null });
  expect(preview.accounting.native.remainderBytes).toBe(preview.accounting.native.heapBytes - preview.summary.memoryBytes);
  expect(preview.accounting.entries.map(entry => entry.category).sort()).toEqual(['decoded', 'history', 'recovery', 'source', 'source']);
  expect(preview.leases.allocations).toBe(5);
  expect(preview.accounting.entries.reduce((bytes, entry) => bytes + entry.bytes, 0)).toBe(preview.leases.bytes);
  await page.evaluate(() => window.cancelCleanupApp.loseGraphicsWithUploadFailure());
  await page.waitForFunction(() => window.cancelCleanupApp.control.graphicsEntered);
  // Stream is deliberately waiting for its actual upload callback. Inspect
  // the real cancellation acknowledgement without enqueuing a command behind
  // that stream; the held candidate has not become the App's GPU scene.
  const held = await page.evaluate(() => window.cancelCleanupApp.graphicsHeldState());
  expect(held.nativeCancellation?.selectionDraft).toBe(false); expect(held.nativeCancellation?.transaction).toBe(false);
  expect(held.nativeCancellation?.memoryBytes).toBe(before.summary.memoryBytes);
  expect(held.nativeCancellation?.selected).toBe(baselineIds.length); expect(held.cleanupOwned).toBe(true);
  expect(held.originalRenderer).toBe(true); expect(held.originalScene).toBe(true); expect(held.editing).toBe(false);
  expect(held.busy).toBe(true); expect(held.rendererState).toBe('recovering'); expect(held.creations).toBe(1);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.cancelCleanupApp.releaseGraphicsFailure())).toBe(false);
  const failedRaw = await page.evaluate(() => window.cancelCleanupApp.nativeSnapshot());
  expect(histogramEntries(failedRaw)).toEqual([]);
  expect(failedRaw.leases.bytes).toBe(previewRaw.leases.bytes + detachedMaskBytes - histogramLeaseBytes);
  expect(failedRaw.leases.allocations).toBe(previewRaw.leases.allocations - 1);
  const failed = withoutHistogram(failedRaw);
  expect(failed.accounting.recoveryOwner).toEqual(preview.accounting.recoveryOwner);
  expect(failed.summary.selectionDraft).toBe(false); expect(failed.summary.transaction).toBe(false); expect(failed.ids).toEqual(baselineIds);
  expect(failed.selectedBytes).toEqual(before.selectedBytes); expect(failed.allBytes).toEqual(before.allBytes);
  expect(failed.summary.canRedo).toBe(true); expect(failed.sameClient).toBe(true); expect(failed.sameView).toBe(true);
  expect(failed.cleanupOwned).toBe(true); expect(failed.originalRenderer).toBe(true); expect(failed.originalScene).toBe(true);
  expect(failed.editing).toBe(false); expect(failed.busy).toBe(false); expect(failed.recovery).toBe('required');
  expect(failed.rendererState).toBe('unavailable'); expect(failed.error).toMatch(/Injected replacement scene upload refusal/);
  expect(failed.summary.count).toBe(before.summary.count); expect(failed.summary.selectionMapBytes).toBe(0);
  expect(failed.summary.memoryBytes).toBe(before.summary.memoryBytes);
  expect(failed.summary.memoryBytes).toBe(preview.summary.memoryBytes - detachedMaskBytes);
  // Cancellation frees that native mask, while the failed GPU replacement
  // retains the same history reservation until a coherent mirror publishes.
  // At unchanged H, actual coverage C falls by exactly four and R=H-C rises
  // by four. The extra reservation is unused credit, not another owner.
  expect(failed.accounting.native.sequence).toBeGreaterThan(preview.accounting.native.sequence);
  expect(failed.accounting.native).toEqual({ ...preview.accounting.native, sequence: expect.any(Number),
    coveredBytes: preview.accounting.native.coveredBytes - detachedMaskBytes,
    remainderBytes: preview.accounting.native.remainderBytes + detachedMaskBytes });
  expect(failed.accounting.native.coveredBytes).toBe(failed.summary.memoryBytes);
  expect(failed.accounting.native.remainderBytes).toBe(failed.accounting.native.heapBytes - failed.summary.memoryBytes);
  expect(preview.accounting.entries.find(entry => entry.id === preview.accounting.nativeRemainderLeaseId)?.bytes).toBe(preview.accounting.native.remainderBytes);
  expect(failed.accounting.nativeRemainderLeaseId).toBe(preview.accounting.nativeRemainderLeaseId);
  expect(failed.accounting.entries).toEqual(preview.accounting.entries.map(entry => entry.id === preview.accounting.nativeRemainderLeaseId ?
    { ...entry, bytes: entry.bytes + detachedMaskBytes } : entry));
  expect(failed.accounting.entries.find(entry => entry.id === failed.accounting.nativeRemainderLeaseId)?.bytes).toBe(failed.accounting.native.remainderBytes);
  expect(failed.accounting.entries.reduce((bytes, entry) => bytes + entry.bytes, 0)).toBe(failed.leases.bytes);
  expect(failed.leases).toEqual({ ...preview.leases, bytes: preview.leases.bytes + detachedMaskBytes });
  expect(failed.readyExposures).toEqual([]);
  expect(await page.evaluate(() => window.cancelCleanupApp.graphicsBlocked())).toEqual({ mutation: false, traffic: [], exports: 0, polygon: false, geometric: false });
  await page.evaluate(() => window.cancelCleanupApp.setFault());
  await page.getByRole('button', { name: 'Retry graphics', exact: true }).click();
  expect(await page.evaluate(() => window.cancelCleanupApp.joinGraphicsRecovery())).toBe(true);
  await page.waitForFunction(() => window.cancelCleanupApp.histogramLeaseReady());
  restored(withoutHistogram(await snapshot(page)), before);
  const installedRaw = await page.evaluate(() => window.cancelCleanupApp.nativeSnapshot()), installed = withoutHistogram(installedRaw);
  expect(installed.accounting.recoveryOwner).toEqual(before.accounting.recoveryOwner);
  expect(installedRaw.accounting.entries.some(entry => histogramEntries(previewRaw).some(previous => previous.id === entry.id))).toBe(false);
  expect(installed.accounting.entries).toEqual(before.accounting.entries);
  expect(installed.accounting.native).toEqual({ ...before.accounting.native, sequence: expect.any(Number) });
  expect(installed.accounting.native.sequence).toBeGreaterThan(failed.accounting.native.sequence);
  expect(installed.cleanupOwned).toBe(false); expect(installed.sameClient).toBe(true); expect(installed.sameView).toBe(true);
  expect(installed.originalRenderer).toBe(false); expect(installed.originalScene).toBe(false); expect(installed.epoch).toBeGreaterThan(installed.originalEpoch);
  expect(installed.readyExposures).toEqual([true]);
  expect(installed.readiness).toEqual([{ editing: true, cleanupOwned: false, recovering: false, selectionRecovery: 'idle' }]);
  await wakeChrome(page);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), baselineIds);
  await freshGesture(page, points); expect(failures).toEqual([]);
});

test('graphics recovery refuses a real active native checkpoint even when the selection draft is already false', async ({ page }) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  const { before: beforeRaw, preview: previewRaw, points } = await open(page, 'basic', true);
  await refuse(page, 'admission'); await blocked(page, previewRaw);
  const before = withoutHistogram(beforeRaw), preview = withoutHistogram(previewRaw);
  expect(histogramEntries(beforeRaw)).toHaveLength(1); expect(histogramEntries(previewRaw)).toHaveLength(1);
  expect(preview.accounting.recoveryOwner).toEqual(before.accounting.recoveryOwner);
  const attempt = await page.evaluate(() => window.cancelCleanupApp.loseGraphicsWithCheckpoint());
  expect(attempt.checkpoint.selectionDraft).toBe(false); expect(attempt.checkpoint.transaction).toBe(true); expect(attempt.recovered).toBe(false);
  const failedRaw = await page.evaluate(() => window.cancelCleanupApp.nativeSnapshot());
  expect(histogramEntries(failedRaw)).toEqual([]);
  expect(failedRaw.leases).toEqual({ ...previewRaw.leases, bytes: previewRaw.leases.bytes - histogramLeaseBytes,
    allocations: previewRaw.leases.allocations - 1 });
  const failed = withoutHistogram(failedRaw);
  expect(failed.accounting.recoveryOwner).toEqual(preview.accounting.recoveryOwner);
  expect(failed.summary.selectionDraft).toBe(false); expect(failed.summary.transaction).toBe(true); expect(failed.ids).toEqual(baselineIds);
  expect(failed.selectedBytes).toEqual(before.selectedBytes); expect(failed.allBytes).toEqual(before.allBytes);
  expect(failed.sameClient).toBe(true); expect(failed.cleanupOwned).toBe(true); expect(failed.editing).toBe(false);
  expect(failed.rendererState).toBe('unavailable'); expect(failed.recovery).toBe('required'); expect(failed.busy).toBe(false);
  expect(failed.error).toMatch(/checkpoint could not be reconciled/); expect(failed.leases).toEqual(preview.leases);
  expect(failed.accounting.entries).toEqual(preview.accounting.entries);
  // This fixture creates a checkpoint directly, without a controller Work
  // coverage grant. Its extra payload remains inside the already charged H/R.
  expect(failed.accounting.native.sequence).toBeGreaterThan(preview.accounting.native.sequence);
  expect(failed.accounting.native).toEqual({ ...preview.accounting.native, sequence: expect.any(Number) });
  expect(failed.accounting.native.remainderBytes).toBe(failed.accounting.native.heapBytes - failed.accounting.native.coveredBytes);
  expect(failed.accounting.entries.find(entry => entry.id === failed.accounting.nativeRemainderLeaseId)?.bytes).toBe(failed.accounting.native.remainderBytes);
  expect(failed.summary.memoryBytes).toBe(attempt.checkpoint.memoryBytes);
  expect(failed.summary.count).toBe(attempt.checkpoint.count);
  expect(failed.readyExposures).toEqual([]);
  expect(await page.evaluate(() => window.cancelCleanupApp.control.creations)).toBe(0);
  expect(await page.evaluate(() => window.cancelCleanupApp.graphicsBlocked())).toEqual({ mutation: false, traffic: [], exports: 0, polygon: false, geometric: false });
  const rollback = await page.evaluate(() => window.cancelCleanupApp.rollbackCheckpoint());
  expect(rollback.transaction).toBe(false); expect(rollback.selectionDraft).toBe(false);
  await page.evaluate(() => window.cancelCleanupApp.setFault());
  await page.getByRole('button', { name: 'Retry graphics', exact: true }).click();
  expect(await page.evaluate(() => window.cancelCleanupApp.joinGraphicsRecovery())).toBe(true);
  await page.waitForFunction(() => window.cancelCleanupApp.histogramLeaseReady());
  restored(withoutHistogram(await snapshot(page)), before);
  const installedRaw = await page.evaluate(() => window.cancelCleanupApp.nativeSnapshot()), installed = withoutHistogram(installedRaw);
  expect(installed.accounting.recoveryOwner).toEqual(before.accounting.recoveryOwner);
  expect(installedRaw.accounting.entries.some(entry => histogramEntries(previewRaw).some(previous => previous.id === entry.id))).toBe(false);
  expect(installed.accounting.entries).toEqual(before.accounting.entries);
  expect(installed.cleanupOwned).toBe(false); expect(installed.sameClient).toBe(true); expect(installed.epoch).toBeGreaterThan(installed.originalEpoch);
  expect(installed.readyExposures).toEqual([true]);
  expect(installed.readiness).toEqual([{ editing: true, cleanupOwned: false, recovering: false, selectionRecovery: 'idle' }]);
  expect(await page.evaluate(() => window.cancelCleanupApp.control.creations)).toBe(1);
  await wakeChrome(page);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), baselineIds);
  await freshGesture(page, points); expect(failures).toEqual([]);
});
