import { expect, test } from '@playwright/test';
import type { mapHarness } from './map-harness';
declare global { interface Window { mapHarness: typeof mapHarness } }
test.beforeEach(async ({ page }) => { await page.goto('/e2e/map-harness.html'); await page.waitForFunction(() => Boolean(window.mapHarness)); });

for (const channels of [3, 7, 11, 15]) test(`real worker adopts channel mask ${channels} without changing document state`, async ({ page }) => {
  const value = await page.evaluate(channels => window.mapHarness.adopt(channels, false), channels);
  expect(value.active).toBe(true); expect(value.unchanged).toBe(true); expect(value.callerBytes).toBe(value.layout.payloadBytes);
  expect(value.retained).toBe(value.layout.nativeBytes); expect(value.nativeBytes).toBe(value.layout.nativeBytes);
  expect(value.peak).toBe(value.layout.admissionBytes); expect(value.lengths).toEqual([value.layout.payloadBytes]);
  expect(value.transferCounts).toEqual([1]); expect(value.releasedId).toBeNull(); expect(value.endBytes).toBe(0); expect(value.disposedValid).toBe(false);
});
test('large native-floor map streams bounded acknowledged copies and preserves all caller buffers', async ({ page }) => {
  const value = await page.evaluate(() => window.mapHarness.adopt(15, true));
  expect(value.lengths.length).toBeGreaterThan(4); expect(value.lengths.every(bytes => bytes <= 1048576 && bytes % 4 === 0)).toBe(true);
  expect(value.lengths.reduce((a, b) => a + b, 0)).toBe(value.layout.payloadBytes); expect(value.transferCounts.every(count => count === 1)).toBe(true);
  expect(value.callerBytes).toBe(value.layout.payloadBytes); expect(value.retained).toBe(value.layout.nativeBytes);
  expect(value.peak).toBe(value.layout.nativeBytes + 2097152); expect(value.endBytes).toBe(0);
});
test('atomic replacement retires the old native lease and old disposal preserves the new map', async ({ page }) => {
  const value = await page.evaluate(() => window.mapHarness.replacement());
  expect(value.firstValid).toBe(false); expect(value.secondValid).toBe(true); expect(value.active).toBe(value.secondId);
  expect(value.afterReplace).toBeGreaterThan(value.firstBytes); expect(value.endBytes).toBe(0);
});
for (const kind of ['cancel-first', 'cancel-middle', 'cancel-ready', 'stale-middle', 'stale-ready', 'bad-offset', 'bad-length', 'bad-build', 'bad-base',
  'nan-depth', 'tail-bits', 'post-once', 'detach', 'wrong-count', 'wrong-dimensions', 'early-control', 'initial-post'] as const)
  test(`${kind} releases pending transfer before rejection and keeps the previous map`, async ({ page }) => {
    const value = await page.evaluate(kind => window.mapHarness.failure(kind), kind);
    expect(value.succeeded).toBe(false); expect(value.error).not.toBe(''); expect(value.usable).toBe(true); expect(value.oldValid).toBe(true);
    expect(value.active).toBe(value.oldId); expect(value.pending).toBeNull(); expect(value.retained).toEqual([value.oldId]);
    expect(value.beforeDispose).toBe(value.oldBytes); expect(value.endBytes).toBe(0);
  });
for (const kind of ['stale-committed', 'cancel-committed'] as const) test(`${kind} retires the committed candidate and invalidates the replaced handle`, async ({ page }) => {
  const value = await page.evaluate(kind => window.mapHarness.failure(kind), kind);
  expect(value.succeeded).toBe(false); expect(value.error).not.toBe(''); expect(value.usable).toBe(true);
  expect(value.oldValid).toBe(false); expect(value.active).toBeNull(); expect(value.pending).toBeNull(); expect(value.retained).toEqual([]);
  expect(value.beforeDispose).toBe(0); expect(value.endBytes).toBe(0);
});
test('concurrent map adoptions and ordinary commands serialize through the entire acknowledged transfer', async ({ page }) => {
  const value = await page.evaluate(() => window.mapHarness.serialized());
  const firstBegin = value.phases.indexOf(`begin:${value.firstId}`), firstCommit = value.phases.indexOf(`commit:${value.firstId}`);
  const secondBegin = value.phases.indexOf(`begin:${value.secondId}`), secondCommit = value.phases.indexOf(`commit:${value.secondId}`);
  expect(firstBegin).toBe(0); expect(firstCommit).toBeGreaterThan(firstBegin + 4); expect(secondBegin).toBe(firstCommit + 1);
  expect(secondCommit).toBe(secondBegin + 2); expect(value.phases[secondCommit + 1]).toBe('command:summary');
  expect(value.firstValid).toBe(false); expect(value.secondValid).toBe(true); expect(value.active).toBe(value.secondId); expect(value.endBytes).toBe(0);
});
for (const kind of ['post-all', 'dispose'] as const) test(`${kind} terminates the worker before releasing owned native memory`, async ({ page }) => {
  const value = await page.evaluate(kind => window.mapHarness.failure(kind), kind);
  expect(value.succeeded).toBe(false); expect(value.usable).toBe(false); expect(value.oldValid).toBe(false); expect(value.beforeDispose).toBe(0); expect(value.endBytes).toBe(0);
});
for (const native of [false, true]) test(`${native ? 'native' : 'aggregate JS'} refusal preserves the active map and releases candidate admission`, async ({ page }) => {
  const value = await page.evaluate(native => window.mapHarness.refusal(native), native);
  expect(value.error).not.toBe(''); expect(value.oldValid).toBe(true); expect(value.active).toBe(value.oldId); expect(value.pending).toBeNull();
  expect(value.retained).toEqual([value.oldId]); expect(value.endBytes).toBe(0); expect(value.candidateBytes).toBe(0);
});
for (const action of ['commit', 'rollback'] as const) test(`rollback-held map ownership survives disposal until transaction ${action}`, async ({ page }) => {
  const value = await page.evaluate(action => window.mapHarness.ownership(action), action);
  expect(value.heldId).toBeNull(); expect(value.heldIds).toEqual([value.handleId]); expect(value.retainedBytes).toBe(value.originalBytes);
  expect(value.finishedId).toBeNull(); expect(value.finishedIds).toEqual([]); expect(value.endBytes).toBe(0); expect(value.valid).toBe(false);
});
test('ordinary selection reuses a map but deletion retires its native lease', async ({ page }) => {
  const selection = await page.evaluate(() => window.mapHarness.ownership('select'));
  expect(selection.valid).toBe(true); expect(selection.retainedBytes).toBe(selection.originalBytes); expect(selection.endBytes).toBe(0);
  const deletion = await page.evaluate(() => window.mapHarness.ownership('delete'));
  expect(deletion.valid).toBe(false); expect(deletion.retainedBytes).toBe(0); expect(deletion.endBytes).toBe(0);
});
test('worker fault retires all native owners', async ({ page }) => {
  const value = await page.evaluate(() => window.mapHarness.ownership('worker-error'));
  expect(value.valid).toBe(false); expect(value.endBytes).toBe(0);
});
test('native visibility validation rejects deleted IDs and accepts a valid loaded-ID mask', async ({ page }) => {
  const value = await page.evaluate(() => window.mapHarness.deletedVisibility());
  expect(value.error).toMatch(/deleted/i); expect(value.active).not.toBeNull(); expect(value.count).toBe(3); expect(value.visible).toBe(2); expect(value.endBytes).toBe(0);
});

test('Fill-held native map survives active upgrade/release and retires only after its final completed owner ends', async ({ page }) => {
  const r = await page.evaluate(() => window.mapHarness.fillHeldUpgrade());
  expect(r.picked.toleranceSessionId).toBe(1); expect(r.picked.selected).toBe(3);
  for (const summary of [r.upgraded, r.oldReleased, r.wrongEnd]) {
    expect(summary.selectionMapId).toBe(r.secondId); expect([...summary.selectionMapRetainedIds].sort((a, b) => a - b)).toEqual([r.firstId, r.secondId]);
    expect(summary.selectionMapBytes).toBe(r.firstBytes + r.secondBytes); expect(summary.toleranceSessionId).toBe(1);
  }
  expect(r.upgradedBytes).toBe(r.firstBytes + r.secondBytes); expect(r.oldReleasedBytes).toBe(r.upgradedBytes);
  expect(r.activeReleased.selectionMapId).toBeNull(); expect(r.activeReleased.selectionMapRetainedIds).toEqual([r.firstId]);
  expect(r.activeReleased.selectionMapBytes).toBe(r.firstBytes); expect(r.heldBytes).toBe(r.firstBytes);
  expect(r.amended.toleranceSessionId).toBe(1); expect(r.amended.selected).toBe(3);
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.ended.selectionMapBytes).toBe(0);
  expect(r.endBytes).toBe(0); expect(r.firstValid).toBe(false); expect(r.secondValid).toBe(false);
});
test('Fill replacement rollback restores the original session/map/Redo without releasing transaction-held leases early', async ({ page }) => {
  const r = await page.evaluate(() => window.mapHarness.fillRollbackRetention());
  expect(r.original.toleranceSessionId).toBe(1); expect(r.original.selected).toBe(3); expect(r.original.canRedo).toBe(true);
  expect(r.endedInside.toleranceSessionId).toBeNull(); expect(r.replacement.toleranceSessionId).toBe(2); expect(r.replacement.selected).toBe(0);
  for (const summary of [r.before, r.endedInside, r.replacement, r.restored, r.wrongEnd, r.amended])
    expect([...summary.selectionMapRetainedIds].sort((a, b) => a - b)).toEqual([r.firstId, r.secondId]);
  expect(r.beforeBytes).toBe(r.firstBytes + r.secondBytes); expect(r.endedInsideBytes).toBe(r.beforeBytes);
  expect(r.replacementBytes).toBe(r.beforeBytes); expect(r.restoredBytes).toBe(r.beforeBytes);
  expect(r.restored.toleranceSessionId).toBe(1); expect(r.restored.selected).toBe(3); expect(r.restored.canRedo).toBe(true);
  expect(r.wrongEnd.toleranceSessionId).toBe(1); expect(r.amended.toleranceSessionId).toBe(1); expect(r.amended.canRedo).toBe(true);
  expect(r.held.selectionMapId).toBeNull(); expect(r.held.selectionMapRetainedIds).toEqual([r.firstId]); expect(r.heldBytes).toBe(r.firstBytes);
  expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.ended.toleranceSessionId).toBeNull(); expect(r.endBytes).toBe(0);
});

test('ordinary Color first enable retains one RGB/visibility map across off/on, active replacement and release', async ({ page }) => {
  const r = await page.evaluate(() => window.mapHarness.connectedHeldUpgrade());
  expect(r.ordinary.toleranceTool).toBe('color'); expect(r.ordinary.toleranceConnected).toBe(false); expect(r.ordinary.toleranceMapId).toBeNull();
  expect(r.ordinary.selectionMapRetainedIds).toEqual([]); expect(r.enabled.toleranceConnected).toBe(true); expect(r.enabled.toleranceMapId).toBe(r.firstId);
  expect(r.enabled.selected).toBe(3); expect(r.disabled.toleranceConnected).toBe(false); expect(r.disabled.toleranceMapId).toBe(r.firstId);
  for (const summary of [r.upgraded, r.oldReleased, r.wrongEnd]) {
    expect(summary.toleranceSessionId).toBe(1); expect(summary.toleranceTool).toBe('color'); expect(summary.toleranceMapId).toBe(r.firstId);
    expect(summary.selectionMapId).toBe(r.secondId); expect([...summary.selectionMapRetainedIds].sort((a, b) => a - b)).toEqual([r.firstId, r.secondId]);
    expect(summary.selectionMapBytes).toBe(r.firstBytes + r.secondBytes);
  }
  expect(r.upgradedBytes).toBe(r.firstBytes + r.secondBytes);
  expect(r.activeReleased.selectionMapId).toBeNull(); expect(r.activeReleased.selectionMapRetainedIds).toEqual([r.firstId]); expect(r.heldBytes).toBe(r.firstBytes);
  expect(r.reenabled.toleranceSessionId).toBe(1); expect(r.reenabled.toleranceConnected).toBe(true); expect(r.reenabled.toleranceMapId).toBe(r.firstId);
  expect(r.reenabled.selected).toBe(3); expect(r.reenabled.selectionMapId).toBeNull();
  expect(r.ended.toleranceSessionId).toBeNull(); expect(r.ended.toleranceTool).toBeNull(); expect(r.ended.toleranceConnected).toBeNull(); expect(r.ended.toleranceMapId).toBeNull();
  expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.endBytes).toBe(0); expect(r.firstValid).toBe(false); expect(r.secondValid).toBe(false);
});

test('Connected Color rejects absent channels, incompatible/stale/substituted maps and wrong owner amendments without changing masks or export', async ({ page }) => {
  const r = await page.evaluate(() => window.mapHarness.connectedRefusals());
  expect(Object.values(r.errors).every(error => error.length > 0)).toBe(true);
  for (const summary of [r.missingChannels, r.mismatchedView, r.staleMap]) {
    expect(summary.toleranceSessionId).toBe(1); expect(summary.toleranceTool).toBe('color'); expect(summary.toleranceConnected).toBe(false); expect(summary.toleranceMapId).toBeNull();
  }
  for (const summary of [r.enabled, r.wrongKind, r.wrongSession, r.substitutedMap]) {
    expect(summary.toleranceSessionId).toBe(1); expect(summary.toleranceTool).toBe('color'); expect(summary.toleranceConnected).toBe(true);
    expect(summary.toleranceMapId).toBe(r.firstId); expect(summary.selected).toBe(r.enabled.selected); expect(summary.canUndo).toBe(r.enabled.canUndo);
  }
  expect(r.substitutedMap.selectionMapId).toBe(r.secondId); expect(r.substitutedMap.selectionMapBytes).toBe(r.firstBytes + r.secondBytes);
  expect(r.beforeEndBytes).toBe(r.firstBytes + r.secondBytes); expect(r.afterMasks).toEqual(r.masks); expect(r.sameOutput).toBe(true); expect(r.endBytes).toBe(0);
});

test('Color to Fill replacement rollback restores the connected owner/map, exact masks/export and Redo while shared leases stay counted once', async ({ page }) => {
  const r = await page.evaluate(() => window.mapHarness.connectedFillRollbackRetention());
  expect(r.original.toleranceTool).toBe('color'); expect(r.original.toleranceConnected).toBe(true); expect(r.original.canRedo).toBe(true);
  expect(r.endedInside.toleranceSessionId).toBeNull(); expect(r.replacement.toleranceSessionId).toBe(2); expect(r.replacement.toleranceTool).toBe('fill');
  expect(r.replacement.toleranceConnected).toBeNull(); expect(r.replacement.toleranceMapId).toBe(r.secondId); expect(r.replacement.selected).toBe(0);
  for (const summary of [r.before, r.endedInside, r.replacement, r.restored, r.wrongEnd])
    expect([...summary.selectionMapRetainedIds].sort((a, b) => a - b)).toEqual([r.firstId, r.secondId]);
  expect(r.beforeBytes).toBe(r.firstBytes + r.secondBytes); expect(r.replacementBytes).toBe(r.beforeBytes); expect(r.restoredBytes).toBe(r.beforeBytes);
  expect(r.restored.toleranceSessionId).toBe(1); expect(r.restored.toleranceTool).toBe('color'); expect(r.restored.toleranceConnected).toBe(true);
  expect(r.restored.toleranceMapId).toBe(r.firstId); expect(r.restored.selected).toBe(r.original.selected); expect(r.restored.canRedo).toBe(true);
  expect(r.afterMasks).toEqual(r.masks); expect(r.sameOutput).toBe(true); expect(r.wrongEnd.toleranceSessionId).toBe(1);
  expect(r.held.selectionMapId).toBeNull(); expect(r.held.selectionMapRetainedIds).toEqual([r.firstId]); expect(r.heldBytes).toBe(r.firstBytes);
  expect(r.amended.toleranceSessionId).toBe(1); expect(r.amended.toleranceMapId).toBe(r.firstId); expect(r.amended.canRedo).toBe(true);
  expect(r.ended.selectionMapRetainedIds).toEqual([]); expect(r.ended.toleranceSessionId).toBeNull(); expect(r.endBytes).toBe(0);
});
