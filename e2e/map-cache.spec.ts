import { expect, test } from '@playwright/test';
import type {} from './map-cache-harness';
import type { NativeMemoryState } from '../src/document/nativeMemory';
import { NEUTRAL_COLOR } from '../src/document/types';

type Accounting = { native: NativeMemoryState; nativeRemainderLeaseId: number; retainedExportLeaseId: number | null;
  workOwnership: { transient: { allocations: number; bytes: number }; retainedExport: { allocations: number; bytes: number }; total: { allocations: number; bytes: number } };
  surfaceScratch: { allocatedBytes: number; idleBytes: number; idleBuffers: number; activeBuffers: number;
    leases: { id: number; bytes: number; busy: boolean }[] };
  entries: { id: number; category: string; bytes: number }[] };
function retainedExportEntries(accounting: Accounting) {
  const retained = accounting.entries.filter(entry => entry.id === accounting.retainedExportLeaseId);
  expect(retained).toEqual(accounting.retainedExportLeaseId === null ? [] :
    [{ id: accounting.retainedExportLeaseId, category: 'work', bytes: accounting.workOwnership.retainedExport.bytes }]);
  expect(accounting.workOwnership.retainedExport.allocations).toBe(retained.length);
  const work = accounting.entries.filter(entry => entry.category === 'work');
  expect(accounting.workOwnership.total).toEqual({ allocations: work.length, bytes: work.reduce((sum, entry) => sum + entry.bytes, 0) });
  const transient = work.filter(entry => entry.id !== accounting.retainedExportLeaseId);
  expect(accounting.workOwnership.transient).toEqual({ allocations: transient.length, bytes: transient.reduce((sum, entry) => sum + entry.bytes, 0) });
  return retained;
}
function expectMapRetirement(before: Accounting, after: Accounting, nativeBytes: number) {
  expect(before.native).toMatchObject({ observed: true, active: true, retired: false, ledgerOverageBytes: 0, unreconciledHeapBytes: null });
  expect(after.native).toMatchObject({ observed: true, active: true, retired: false, ledgerOverageBytes: 0, unreconciledHeapBytes: null });
  expect(after.native.sequence).toBeGreaterThan(before.native.sequence);
  expect(after.native.heapBytes).toBe(before.native.heapBytes);
  expect(after.native.coveredBytes).toBe(before.native.coveredBytes - nativeBytes);
  expect(after.native.remainderBytes).toBe(before.native.remainderBytes + nativeBytes);
  expect(after.native.coveredBytes + after.native.remainderBytes).toBe(after.native.heapBytes);
  // Authenticate the client's remainder independently of the retained catalog.
  // Native payload release redistributes coverage into that exact owner.
  expect(after.nativeRemainderLeaseId).toBe(before.nativeRemainderLeaseId);
  expect(before.entries.filter(entry => entry.id === before.nativeRemainderLeaseId))
    .toEqual([{ id: before.nativeRemainderLeaseId, category: 'source', bytes: before.native.remainderBytes }]);
  const source = before.entries.filter(entry => entry.category === 'source');
  expect(source).toHaveLength(2);
  expect(after.entries.filter(entry => entry.category === 'source'))
    .toEqual(source.map(entry => entry.id === before.nativeRemainderLeaseId ? { ...entry, bytes: entry.bytes + nativeBytes } : entry));
  const beforeRetained = retainedExportEntries(before), afterRetained = retainedExportEntries(after);
  expect(after.workOwnership.retainedExport).toEqual(before.workOwnership.retainedExport);
  const scratchIds = before.surfaceScratch.leases.map(lease => lease.id);
  expect(before.surfaceScratch.activeBuffers).toBe(0); expect(before.surfaceScratch.idleBytes).toBe(before.surfaceScratch.allocatedBytes);
  expect(before.surfaceScratch.idleBytes).toBeGreaterThan(0); expect(before.surfaceScratch.idleBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
  expect(before.surfaceScratch.idleBuffers).toBeLessThanOrEqual(32); expect(before.surfaceScratch.leases).toHaveLength(before.surfaceScratch.idleBuffers);
  expect(before.surfaceScratch.leases.every(lease => !lease.busy)).toBe(true);
  expect(before.surfaceScratch.leases.reduce((sum, lease) => sum + lease.bytes, 0)).toBe(before.surfaceScratch.allocatedBytes);
  expect(before.entries.filter(entry => scratchIds.includes(entry.id)))
    .toEqual(before.surfaceScratch.leases.map(lease => ({ id: lease.id, category: 'work', bytes: lease.bytes })).sort((a, b) => a.id - b.id));
  expect(after.surfaceScratch.allocatedBytes).toBe(0); expect(after.surfaceScratch.leases).toEqual([]);
  const transient = before.entries.filter(entry => entry.category === 'work' && entry.id !== before.retainedExportLeaseId && !scratchIds.includes(entry.id));
  expect(transient.map(entry => entry.bytes).sort((a, b) => a - b))
    .toEqual([nativeBytes - Uint32Array.BYTES_PER_ELEMENT, nativeBytes]);
  expect(after.entries.filter(entry => transient.some(previous => previous.id === entry.id))).toEqual([]);
  expect(after.entries.filter(entry => scratchIds.includes(entry.id))).toEqual([]);
  expect(after.entries.filter(entry => entry.category === 'work')).toEqual(afterRetained);
  expect(beforeRetained.some(entry => transient.some(map => map.id === entry.id))).toBe(false);
}

function expectedMapBytes(shape: { width: number; height: number; sourceCount: number }) {
  expect(shape.sourceCount).toBe(3);
  // Independent layout oracle: depth/opacity/RGB are five float32 values
  // per pixel; visibility and native touched membership use one word each.
  const membership = Math.ceil(shape.sourceCount / 32) * Uint32Array.BYTES_PER_ELEMENT;
  const cpu = shape.width * shape.height * 5 * Float32Array.BYTES_PER_ELEMENT + membership;
  return { cpu, native: cpu + membership };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/map-cache-harness.html');
  await page.waitForFunction(() => Boolean(window.mapCacheHarness || window.mapCacheHarnessError));
  expect(await page.evaluate(() => window.mapCacheHarnessError)).toBeUndefined();
});

test('real surface channels reach the native map and reuse ordinary selection/display changes without another transfer', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.reuse());
  expect(r.errors).toEqual([]); expect(r.sameOwner).toBe(true);
  expect(r.adoption.selectionMapId).toBeGreaterThan(0); expect(r.adoption.revision).toBe(r.before.revision);
  expect(r.adoption.contentRevision).toBe(r.before.contentRevision); expect(r.adoption.canUndo).toBe(r.before.canUndo);
  expect(r.after.selectionMapId).toBe(r.adoption.selectionMapId); expect(r.after.selected).toBe(1);
  expect(r.scratchBytes).toBeGreaterThan(0); expect(r.retained).toBe(r.cpuBytes + r.adoption.selectionMapBytes + r.scratchBytes);
  expect(r.releasedScratchBytes).toBe(0);
  expect(r.released).toBe(0); expect(r.nativeReleased.selectionMapId).toBeNull(); expect(r.nativeReleased.selectionMapBytes).toBe(0);
});

test('refused optional channels preserve the previous map and a successful upgrade retires it', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.upgradeRefusal());
  expect(r.errors).toEqual([]); expect(r.error).toMatch(/opacity|finite/i);
  expect(r.refused.selectionMapId).toBe(r.firstId); expect(r.sameAfterRefusal).toBe(true);
  expect(r.refusedBytes - r.refusedScratchBytes).toBe(r.retained - r.retainedScratchBytes);
  expect(r.upgradedId).toBeGreaterThan(r.firstId); expect(r.hasColors).toBe(true); expect(r.hasVisible).toBe(true);
  expect(r.retired).toBe(true); expect(r.committed.selectionMapRetainedIds).toEqual([r.upgradedId]); expect(r.released).toBe(0);
});

test('cancelled readback cannot adopt a map or leak retained CPU/native bytes', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.cancelled());
  expect(r.errors).toEqual([]); expect(r.outcome).toBe('AbortError'); expect(r.during).toBeGreaterThan(0);
  expect(r.after.selectionMapId).toBeNull(); expect(r.after.pendingSelectionMapId).toBeNull(); expect(r.after.selectionMapBytes).toBe(0);
  expect(r.after.revision).toBe(r.before.revision); expect(r.after.canUndo).toBe(r.before.canUndo); expect(r.released).toBe(0);
});

const nativeHistory = (summary: { memoryBytes: number; count: number; selectionMapBytes: number; exportBytes?: number }) => {
  const exported = summary.exportBytes ?? 0;
  expect(Number.isSafeInteger(exported)).toBe(true); expect(exported).toBeGreaterThanOrEqual(0);
  const payloads = summary.count * 144 + summary.selectionMapBytes + exported;
  expect(payloads).toBeLessThanOrEqual(summary.memoryBytes);
  const history = summary.memoryBytes - payloads;
  expect(history).toBeGreaterThanOrEqual(0); return history;
};
test('AppController selection/Undo reuse keeps maps out of history accounting', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerReuse());
  expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.selectionAccepted).toBe(true); expect(r.undoAccepted).toBe(true);
  expect(r.sameOwner).toBe(true); expect(r.adoptions).toBe(1); expect(r.selected.selected).toBe(1); expect(r.undone.selected).toBe(0);
  expect(r.adopted.selectionMapId).toBeGreaterThan(0); expect(r.selected.selectionMapId).toBe(r.adopted.selectionMapId); expect(r.undone.selectionMapId).toBe(r.adopted.selectionMapId);
  expect(r.afterAdoption.history).toBe(r.beforeCategories.history);
  expect(r.selectedCategories.history).toBe(nativeHistory(r.selected)); expect(r.undoneCategories.history).toBe(nativeHistory(r.undone));
  expect(r.afterAdoption.scratch).toBeGreaterThan(0);
  expect(r.afterAdoption.work).toBe(r.cpuBytes + r.adopted.selectionMapBytes + r.afterAdoption.scratch);
  const mapBytes = expectedMapBytes(r.mapShape);
  expect(r.cpuBytes).toBe(mapBytes.cpu); expect(r.adopted.selectionMapBytes).toBe(mapBytes.native);
  expect(r.beforeReleaseSummary.memoryBytes - r.released.memoryBytes).toBe(mapBytes.native);
  expectMapRetirement(r.accountingBefore, r.accountingAfter, mapBytes.native);
  expect(r.beforeRelease - r.afterReleaseBytes).toBe(mapBytes.cpu + r.accountingBefore.surfaceScratch.allocatedBytes);
  const retiredWorkIds = r.accountingBefore.entries.filter(entry => entry.category === 'work' && entry.id !== r.accountingBefore.retainedExportLeaseId).map(entry => entry.id);
  expect(r.accountingAfter.entries).toEqual(r.accountingBefore.entries.filter(entry => !retiredWorkIds.includes(entry.id))
    .map(entry => entry.id === r.accountingBefore.nativeRemainderLeaseId ? { ...entry, bytes: entry.bytes + mapBytes.native } : entry));
  expect(r.afterRelease.work ?? 0).toBe(0); expect(r.afterRelease.history).toBe(nativeHistory(r.released)); expect(r.oldValid).toBe(false);
});
test('pending color settles before a surface map, retires its previous owner and keeps the bake executable in history', async ({ page }, testInfo) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerColorBoundary());
  await testInfo.attach('pending-color-surface-map-boundary', { contentType: 'application/json', body: JSON.stringify(r) });
  expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.before.summary.canUndo).toBe(false);
  expect(r.pending.grade).toEqual(r.values); expect(r.pending.appliedGrade).toEqual(NEUTRAL_COLOR);
  expect(r.pending.colorPending).toBe(true); expect(r.pending.colorSelectedOnly).toBe(false); expect(r.pendingSameScene).toBe(true);
  expect(r.pending.exported).toBe(r.before.exported); expect(r.pending.summary.contentRevision).toBe(r.before.summary.contentRevision);
  expect(r.sameOwner).toBe(false); expect(r.oldValid).toBe(false); expect(r.newValid).toBe(true); expect(r.adoptions).toBe(2);
  expect(r.sceneChanged).toBe(true); expect(r.oldSceneRetired).toBe(true); expect(r.colorsChanged).toBe(true);
  expect(r.after.summary.selectionMapId).toBeGreaterThan(r.before.summary.selectionMapId!);
  expect(r.after.summary.selectionMapRetainedIds).toEqual([r.after.summary.selectionMapId]);
  expect(r.after.summary.contentRevision).toBeGreaterThan(r.before.summary.contentRevision); expect(r.after.exported).not.toBe(r.before.exported);
  expect(r.after.summary.canUndo).toBe(true); expect(r.after.summary.canRedo).toBe(false);
  for (const endpoint of [r.after, r.released, r.undone, r.redone]) {
    expect(endpoint.grade).toEqual(NEUTRAL_COLOR); expect(endpoint.appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(endpoint.colorSession).toBeNull(); expect(endpoint.colorPending).toBe(false); expect(endpoint.colorSelectedOnly).toBe(false);
    expect(endpoint.nativeMasks).toEqual(r.before.nativeMasks); expect(endpoint.gpuMasks).toEqual(endpoint.nativeMasks);
    expect(endpoint.summary.selected).toBe(0); expect(endpoint.categories.history).toBe(nativeHistory(endpoint.summary));
  }
  const mapBytes = expectedMapBytes(r.mapShape);
  expect(r.cpuBytes).toBe(mapBytes.cpu); expect(r.after.summary.selectionMapBytes).toBe(mapBytes.native);
  expect(r.after.categories.scratch).toBeGreaterThan(0);
  expect(r.after.categories.work).toBe(mapBytes.cpu + mapBytes.native + r.after.categories.scratch);
  expect(r.after.summary.memoryBytes - r.released.summary.memoryBytes).toBe(mapBytes.native);
  expectMapRetirement(r.accountingBefore, r.accountingAfter, mapBytes.native);
  expect(r.accountingAfter.retainedExportLeaseId).toBe(r.accountingBefore.retainedExportLeaseId);
  expect(retainedExportEntries(r.accountingAfter)).toEqual(retainedExportEntries(r.accountingBefore));
  expect(r.beforeRelease - r.afterReleaseBytes).toBe(mapBytes.cpu + r.accountingBefore.surfaceScratch.allocatedBytes);
  expect(r.newValidAfterRelease).toBe(false); expect(r.released.categories.work ?? 0).toBe(0);
  expect(r.released.summary.selectionMapRetainedIds).toEqual([]); expect(r.released.exported).toBe(r.after.exported);
  expect(r.undoAccepted).toBe(true); expect(r.undone.exported).toBe(r.before.exported);
  expect(r.undone.summary.canUndo).toBe(false); expect(r.undone.summary.canRedo).toBe(true);
  expect(r.redoAccepted).toBe(true); expect(r.redone.exported).toBe(r.after.exported);
  expect(r.redone.summary.canUndo).toBe(true); expect(r.redone.summary.canRedo).toBe(false);
});
for (const kind of ['delete', 'geometry', 'history'] as const) test(`AppController refused ${kind} publication restores the original map, native state and ledger`, async ({ page }) => {
  const r = await page.evaluate(kind => window.mapCacheHarness.controllerFailure(kind), kind);
  expect(r.historyPublicationRefused).toBe(kind === 'history');
  expect(r.accepted).toBe(false); expect(r.error).toMatch(/Injected map/); expect(r.busy).toBe(false);
  expect(r.sameScene).toBe(true); expect(r.sameOutput).toBe(true); expect(r.afterMasks).toEqual(r.masks);
  expect(r.mapValid).toBe(true); expect(r.sameMap).toBe(true); expect(r.after.selectionMapId).toBe(r.before.selectionMapId);
  expect(r.after.selectionMapRetainedIds).toEqual([r.before.selectionMapId]); expect(r.after.selectionMapBytes).toBe(r.before.selectionMapBytes);
  expect(r.held!.selectionMapId).toBeNull(); expect(r.held!.selectionMapRetainedIds).toEqual([r.before.selectionMapId]);
  expect(r.heldCategories!.work).toBeGreaterThanOrEqual(r.originalCategories.work);
  expect(r.usageAfter.bytes).toBe(r.usageBefore.bytes); expect(r.usageAfter.allocations).toBe(r.usageBefore.allocations); expect(r.afterCategories).toEqual(r.originalCategories);
  expect(r.restoredNativeStamp).toBe(r.originalNativeStamp);
  if (kind === 'geometry') expect(r.browserStampAfter).toBeGreaterThan(r.originalBrowserStamp);
  expect(r.after.canUndo).toBe(r.before.canUndo); expect(r.after.canRedo).toBe(true); expect(r.redone).toBe(true); expect(r.redoneVisible).toBe(2);
  expect(r.released.selectionMapId).toBeNull(); expect(r.released.selectionMapRetainedIds).toEqual([]);
});
for (const kind of ['camera', 'viewport', 'geometry', 'delete'] as const) test(`AppController ${kind} change retires old map ownership before reacquisition`, async ({ page }) => {
  const r = await page.evaluate(kind => window.mapCacheHarness.controllerInvalidation(kind), kind);
  expect(r.accepted).toBe(true); expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.oldValid).toBe(false);
  expect(r.retired.selectionMapId).toBeNull(); expect(r.retired.selectionMapRetainedIds).toEqual([]); expect(r.releasedWork).toBe(0);
  expect(r.sameOwner).toBe(false); expect(r.newValid).toBe(true); expect(r.after.selectionMapId).toBeGreaterThan(r.before.selectionMapId!);
  expect(r.sceneChanged).toBe(kind === 'geometry');
  if (kind === 'delete') expect(r.after.visible).toBe(2);
  if (kind === 'viewport') expect(r.width).toBeGreaterThan(320);
});
test('AppController refused replacement preserves the old admitted map and document', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerReplacement(true));
  expect(r.error).toMatch(/Injected replacement/); expect(r.oldValid).toBe(true); expect(r.sameOwner).toBe(true); expect(r.sameClient).toBe(true); expect(r.sameScene).toBe(true);
  expect(r.after.selectionMapId).toBe(r.before.selectionMapId); expect(r.usageAfter!.bytes).toBe(r.usageBefore!.bytes); expect(r.usageAfter!.allocations).toBe(r.usageBefore!.allocations);
});
test('AppController replacement retires the old map/worker/source and creates a new document owner', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerReplacement(false));
  expect(r.error).toBeNull(); expect(r.oldValid).toBe(false); expect(r.sameOwner).toBe(false); expect(r.sameClient).toBe(false); expect(r.sameScene).toBe(false);
  expect(r.oldSceneRetired).toBe(true); expect(r.oldWorkerAlive).toBe(false); expect(r.newDocument).toBe(true); expect(r.newValid).toBe(true); expect(r.releasedWork).toBe(0);
  expect(r.retired!.selectionMapId).toBeNull(); expect(r.retired!.selectionMapRetainedIds).toEqual([]); expect(r.after.selectionMapId).toBeGreaterThan(0);
});
test('AppController graphics recreation retires old map bytes while retaining committed document/history/view', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerRecovery());
  expect(r.accepted).toBe(true); expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.oldValid).toBe(false); expect(r.newValid).toBe(true); expect(r.sameOwner).toBe(false);
  expect(r.sameClient).toBe(true); expect(r.sceneChanged).toBe(true); expect(r.oldSceneRetired).toBe(true); expect(r.newEpoch).toBeGreaterThan(r.oldEpoch);
  expect(r.sameOutput).toBe(true); expect(r.afterMasks).toEqual(r.masks); expect(r.sameView).toBe(true);
  expect(r.after.selectionMapId).toBeNull(); expect(r.after.selectionMapRetainedIds).toEqual([]);
  const mapBytes = expectedMapBytes(r.mapShape);
  expect(r.cpuBytes).toBe(mapBytes.cpu); expect(r.before.selectionMapBytes).toBe(mapBytes.native);
  expect(r.before.memoryBytes - r.after.memoryBytes).toBe(mapBytes.native);
  expectMapRetirement(r.accountingBefore, r.accountingAfter, mapBytes.native);
  expect(r.accountingAfter.retainedExportLeaseId).toBe(r.accountingBefore.retainedExportLeaseId);
  expect(retainedExportEntries(r.accountingAfter)).toEqual(retainedExportEntries(r.accountingBefore));
  expect(r.bytesBeforeReacquire).toBe(r.retainedBytesBefore - mapBytes.cpu - r.accountingBefore.surfaceScratch.allocatedBytes);
  expect(r.accountingAfter.entries.filter(entry => !['work', 'decoded'].includes(entry.category)))
    .toEqual(r.accountingBefore.entries.filter(entry => !['work', 'decoded'].includes(entry.category))
      .map(entry => entry.id === r.accountingBefore.nativeRemainderLeaseId ? { ...entry, bytes: entry.bytes + mapBytes.native } : entry));
  expect(r.accountingAfter.entries.filter(entry => entry.category === 'decoded').map(entry => entry.bytes))
    .toEqual(r.accountingBefore.entries.filter(entry => entry.category === 'decoded').map(entry => entry.bytes));
  expect(r.after.contentRevision).toBe(r.before.contentRevision); expect(r.after.selected).toBe(r.before.selected); expect(r.after.canUndo).toBe(r.before.canUndo); expect(r.after.canRedo).toBe(r.before.canRedo);
});
test('AppController dispose retires cached CPU/native ownership and terminates its worker', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerDispose());
  expect(r.before.selectionMapId).toBeGreaterThan(0); expect(r.retainedBytes).toBeGreaterThan(0);
  expect(r.after.bytes).toBe(0); expect(r.after.allocations).toBe(0); expect(r.workerAlive).toBe(false); expect(r.oldValid).toBe(false); expect(r.sceneRetired).toBe(true);
});
test('AppController gesture cancellation aborts its pending map waiter and retires the query without adoption', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerPendingCancellation());
  expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.endedImmediately).toBe(true); expect(r.restartBlocked).toBe(true);
  expect(r.adoptions).toBe(0); expect(r.duringBytes).toBeGreaterThan(r.beforeBytes); expect(r.afterBytes).toBe(r.beforeBytes);
  expect(r.after.selectionMapId).toBeNull(); expect(r.after.selectionMapRetainedIds).toEqual([]); expect(r.after.selectionDraft).toBe(false);
  expect(r.afterMasks).toEqual(r.masks); expect(r.after.selected).toBe(r.before.selected); expect(r.after.canUndo).toBe(r.before.canUndo); expect(r.after.canRedo).toBe(r.before.canRedo);
});

test('Fill checkpoint retains its original native map across cache upgrade/release while CPU channels and history stay accounted once', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerFillHeldUpgrade());
  expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.picked.toleranceSessionId).toBeGreaterThan(0);
  expect(r.upgraded.selectionMapId).toBe(r.secondId); expect([...r.upgraded.selectionMapRetainedIds].sort((a, b) => a - b)).toEqual([r.firstId, r.secondId]);
  expect(r.upgradedCategories.scratch).toBeGreaterThan(0);
  expect(r.upgradedCategories.work).toBe(r.secondCpuBytes + r.upgraded.selectionMapBytes + r.upgradedCategories.scratch);
  expect(r.upgradedCategories.history).toBe(nativeHistory(r.upgraded));
  expect(r.activeReleased.selectionMapId).toBeNull(); expect(r.activeReleased.selectionMapRetainedIds).toEqual([r.firstId]);
  expect(r.activeReleased.selectionMapBytes).toBe(r.firstNativeBytes); expect(r.heldCategories.work).toBe(r.firstNativeBytes);
  expect(r.amended.toleranceSessionId).toBe(r.picked.toleranceSessionId); expect(r.amended.selectionMapId).toBeNull();
  expect(r.amended.selectionMapRetainedIds).toEqual([r.firstId]); expect(r.amendedCategories.work).toBe(r.firstNativeBytes);
  expect(r.amendedCategories.history).toBe(nativeHistory(r.amended)); expect(r.firstValid).toBe(false); expect(r.secondValid).toBe(false);
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.ended.selectionMapBytes).toBe(0);
  expect(r.endedCategories.work ?? 0).toBe(0); expect(r.endedCategories.history).toBe(nativeHistory(r.ended));
});
test('refused Fill replacement restores the old completed owner, shared map, exact masks/history/Redo and ledger', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerFillReplacementFailure());
  expect(r.accepted).toBe(false); expect(r.error).toMatch(/Injected Fill checkpoint/); expect(r.busy).toBe(false);
  expect(r.before.canRedo).toBe(true); expect(r.after.canRedo).toBe(true); expect(r.before.toleranceSessionId).toBeGreaterThan(0);
  expect(r.after.toleranceSessionId).toBe(r.before.toleranceSessionId); expect(r.held!.toleranceSessionId).not.toBe(r.before.toleranceSessionId);
  expect(r.after.selectionMapId).toBe(r.before.selectionMapId); expect(r.after.selectionMapRetainedIds).toEqual([r.before.selectionMapId]);
  expect(r.held!.selectionMapBytes).toBe(r.before.selectionMapBytes); expect(r.after.selectionMapBytes).toBe(r.before.selectionMapBytes);
  expect(r.afterMasks).toEqual(r.masks); expect(r.sameOutput).toBe(true); expect(r.mapValid).toBe(true); expect(r.sameMap).toBe(true);
  expect(r.afterUsage.bytes).toBe(r.beforeUsage.bytes); expect(r.afterUsage.allocations).toBe(r.beforeUsage.allocations); expect(r.afterCategories).toEqual(r.beforeCategories);
  expect(r.amended.toleranceSessionId).toBe(r.before.toleranceSessionId); expect(r.amended.canRedo).toBe(true);
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.finalWorkBytes).toBe(0);
});
for (const replace of [false, true]) test(`Fill-held native map retires on controller ${replace ? 'document replacement' : 'dispose'}`, async ({ page }) => {
  const r = await page.evaluate(replace => window.mapCacheHarness.controllerFillHeldClose(replace), replace);
  expect(r.error).toBeNull(); expect(r.held.selectionMapId).toBeNull(); expect(r.held.toleranceSessionId).toBeGreaterThan(0);
  expect(r.held.selectionMapRetainedIds).toHaveLength(1); expect(r.heldBytes).toBe(r.held.selectionMapBytes);
  expect(r.workBytes).toBe(0); expect(r.oldWorkerAlive).toBe(false); expect(r.oldValid).toBe(false); expect(r.upgradedValid).toBe(false);
  if (replace) { expect(r.after!.toleranceSessionId).toBeNull(); expect(r.after!.selectionMapRetainedIds).toEqual([]); }
  else { expect(r.afterUsage.bytes).toBe(0); expect(r.afterUsage.allocations).toBe(0); }
});

test('ordinary Color first enable upgrades channels once and retained off/on survives cache invalidation without another surface query', async ({ page }) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerConnectedHeldUpgrade());
  expect(r.error).toBeNull(); expect(r.busy).toBe(false); expect(r.ordinary.toleranceTool).toBe('color');
  expect(r.ordinary.toleranceConnected).toBe(false); expect(r.ordinary.toleranceMapId).toBeNull(); expect(r.ordinary.selectionMapId).toBe(r.ordinaryId);
  expect(r.enabled.toleranceSessionId).toBe(r.ordinary.toleranceSessionId); expect(r.enabled.toleranceConnected).toBe(true);
  expect(r.connectedId).toBeGreaterThan(r.ordinaryId); expect(r.enabled.toleranceMapId).toBe(r.connectedId); expect(r.enabled.selectionMapId).toBe(r.connectedId);
  expect(r.enabled.selectionMapRetainedIds).toEqual([r.connectedId]); expect(r.enabledCategories.scratch).toBeGreaterThan(0);
  expect(r.enabledCategories.work).toBe(r.cpuBytes + r.enabled.selectionMapBytes + r.enabledCategories.scratch);
  expect(r.enabledCategories.history).toBe(nativeHistory(r.enabled)); expect(r.enabledAdoptions).toBe(2); expect(r.adoptions).toBe(2);
  expect(r.disabled.toleranceConnected).toBe(false); expect(r.disabled.toleranceMapId).toBe(r.connectedId);
  expect(r.activeReleased.selectionMapId).toBeNull(); expect(r.activeReleased.selectionMapRetainedIds).toEqual([r.connectedId]);
  expect(r.heldCategories.work).toBe(r.enabled.selectionMapBytes); expect(r.reenabledCategories.work).toBe(r.enabled.selectionMapBytes);
  expect(r.reenabled.toleranceSessionId).toBe(r.ordinary.toleranceSessionId); expect(r.reenabled.toleranceConnected).toBe(true);
  expect(r.reenabled.toleranceMapId).toBe(r.connectedId); expect(r.reenabled.selectionMapId).toBeNull(); expect(r.reenabledCategories.history).toBe(nativeHistory(r.reenabled));
  expect(r.afterMasks).toEqual(r.enabledMasks); expect(r.sameOutput).toBe(true); expect(r.ordinaryValid).toBe(false); expect(r.connectedValid).toBe(false);
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.ended.selectionMapBytes).toBe(0);
  expect(r.endedCategories.work ?? 0).toBe(0); expect(r.endedCategories.history).toBe(nativeHistory(r.ended));
});

test('refused first Connected Color publication restores the ordinary owner and exact native/GPU masks, export, Redo and ledger', async ({ page }, testInfo) => {
  const r = await page.evaluate(() => window.mapCacheHarness.controllerConnectedPublicationFailure());
  await testInfo.attach('connected-publication-native-accounting', { contentType: 'application/json', body: JSON.stringify({
    before: { summary: r.before, accounting: r.accountingBefore }, held: { summary: r.held, accounting: r.accountingHeld },
    after: { summary: r.after, accounting: r.accountingAfter }, amended: { summary: r.amended, accounting: r.accountingAmended },
    ended: { summary: r.ended, accounting: r.accountingEnded },
  }) });
  expect(r.error).toMatch(/Injected Connected Color/); expect(r.busy).toBe(false); expect(r.before.canRedo).toBe(true);
  expect(r.before.toleranceTool).toBe('color'); expect(r.before.toleranceConnected).toBe(false); expect(r.before.toleranceMapId).toBeNull();
  expect(r.held!.toleranceConnected).toBe(true); expect(r.held!.toleranceSessionId).toBe(r.before.toleranceSessionId); expect(r.held!.toleranceMapId).toBe(r.before.selectionMapId);
  expect(r.after.toleranceSessionId).toBe(r.before.toleranceSessionId); expect(r.after.toleranceTool).toBe('color'); expect(r.after.toleranceConnected).toBe(false);
  expect(r.after.toleranceMapId).toBeNull(); expect(r.after.canRedo).toBe(true); expect(r.after.canUndo).toBe(r.before.canUndo);
  expect(r.after.selectionMapId).toBe(r.before.selectionMapId); expect(r.after.selectionMapRetainedIds).toEqual([r.before.selectionMapId]);
  expect(r.after.selectionMapBytes).toBe(r.before.selectionMapBytes); expect(r.afterMasks).toEqual(r.masks); expect(r.sameOutput).toBe(true);
  expect(r.before.count).toBe(3); expect(r.before.selected).toBe(3); expect(r.masks).toEqual([1, 1, 1]);
  // Delete/Undo leaves three Change records in a four-slot Redo vector.
  // The pinned wasm32 {uint32,uint8,uint8} Change has an eight-byte stride.
  // Rollback adopts the checkpoint's size-three copy, retiring one spare
  // slot. H stays retained while C falls and R gains that exact capacity.
  const spareRedoBytes = (4 - 3) * (2 * Uint32Array.BYTES_PER_ELEMENT);
  expect(r.before.memoryBytes - r.after.memoryBytes).toBe(spareRedoBytes);
  expect(r.accountingBefore.native.coveredBytes).toBe(r.before.memoryBytes);
  expect(r.accountingAfter.native.coveredBytes).toBe(r.after.memoryBytes);
  expect({ ...r.accountingAfter.native, sequence: r.accountingBefore.native.sequence }).toEqual({
    ...r.accountingBefore.native, coveredBytes: r.accountingBefore.native.coveredBytes - spareRedoBytes,
    remainderBytes: r.accountingBefore.native.remainderBytes + spareRedoBytes,
  });
  expect(r.accountingAfter.native.sequence).toBeGreaterThan(r.accountingBefore.native.sequence);
  expect(r.accountingAfter.entries).toEqual(r.accountingBefore.entries
    .map(entry => entry.id === r.accountingBefore.nativeRemainderLeaseId ? { ...entry, bytes: entry.bytes + spareRedoBytes } : entry));
  expect(r.mapValid).toBe(true); expect(r.sameMap).toBe(true); expect(r.afterUsage.bytes).toBe(r.beforeUsage.bytes + spareRedoBytes);
  expect(r.afterUsage.allocations).toBe(r.beforeUsage.allocations);
  expect(r.afterCategories).toEqual({ ...r.beforeCategories, source: r.beforeCategories.source + spareRedoBytes });
  expect(r.amended.toleranceSessionId).toBe(r.before.toleranceSessionId); expect(r.amended.toleranceConnected).toBe(false); expect(r.amended.canRedo).toBe(true);
  expect({ ...r.accountingAmended.native, sequence: r.accountingAfter.native.sequence }).toEqual(r.accountingAfter.native);
  expect(r.accountingAmended.entries).toEqual(r.accountingAfter.entries);
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.finalWorkBytes).toBe(0);
  expect(r.accountingEnded.entries.filter(entry => entry.category === 'history')).toEqual(r.accountingBefore.entries
    .filter(entry => entry.category === 'history').map(entry => ({ ...entry, bytes: entry.bytes - spareRedoBytes })));
  expect(r.accountingEnded.native.heapBytes).toBe(r.accountingBefore.native.heapBytes);
  expect(r.accountingEnded.native.coveredBytes).toBe(r.ended.memoryBytes);
  expect(r.accountingEnded.native.remainderBytes).toBe(r.accountingBefore.native.remainderBytes + spareRedoBytes + r.before.selectionMapBytes);
  expect(r.redone).toBe(true); expect(r.redoneVisible).toBe(0);
});

for (const replace of [false, true]) test(`Connected Color retained map retires on controller ${replace ? 'document replacement' : 'dispose'}`, async ({ page }) => {
  const r = await page.evaluate(replace => window.mapCacheHarness.controllerConnectedHeldClose(replace), replace);
  expect(r.error).toBeNull(); expect(r.held.toleranceTool).toBe('color'); expect(r.held.toleranceConnected).toBe(true);
  expect(r.held.selectionMapId).toBeNull(); expect(r.held.toleranceSessionId).toBeGreaterThan(0); expect(r.held.selectionMapRetainedIds).toEqual([r.held.toleranceMapId]);
  expect(r.heldBytes).toBe(r.held.selectionMapBytes); expect(r.workBytes).toBe(0); expect(r.oldWorkerAlive).toBe(false); expect(r.oldValid).toBe(false);
  if (replace) { expect(r.after!.toleranceSessionId).toBeNull(); expect(r.after!.toleranceTool).toBeNull(); expect(r.after!.selectionMapRetainedIds).toEqual([]); }
  else { expect(r.afterUsage.bytes).toBe(0); expect(r.afterUsage.allocations).toBe(0); }
});
