import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['snapshot']>>;
const baselineMasks = [1, 0, 1, 0, 2];
const positions = [-.75, -.4, 0, .4, .75];
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.snapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page);
    return { renderer: value.rendererState, recovery: value.recovery, busy: value.busy };
  }).toEqual({ renderer: 'ready', recovery: 'idle', busy: false });
}
function exact(value: Snapshot, before: Snapshot, masks = baselineMasks) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    transaction: false, selectionDraft: false, pending: false });
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.sourceName).toBe(before.sourceName);
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset);
  expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  expect(value.camera).toEqual(before.camera); expect(value.masks).toEqual(masks); expect(value.gpu.masks).toEqual(masks);
  expect(value.packed).toEqual(before.packed); expect(value.gpu.data).toEqual(value.packed); expect(value.resources.work).toBe(0);
  const source = before.sourceOutput, x = source.properties.indexOf('x');
  expect(source.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45); expect(x).toBeGreaterThanOrEqual(0);
  value.outputs.forEach((output, scope) => {
    const ids = masks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output).not.toBeNull(); expect(output!.properties).toEqual(source.properties);
    // Independent binary-PLY observation checks every full native SH3 field,
    // including all 45 higher coefficients absent from a GPU-only oracle.
    expect(output!.records).toEqual(ids.map(id => {
      const row = source.records.find(record => record[x] === Math.fround(positions[id]));
      expect(row).toBeDefined(); return row;
    }));
  });
}
async function command(page: Page, command: 'undo' | 'redo') {
  await page.evaluate(command => window.operationHarness.command({ command }), command); await settled(page); return snapshot(page);
}
async function completeHistory(page: Page, before: Snapshot) {
  for (const masks of [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]])
    exact(await command(page, 'undo'), before, masks);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const masks of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], baselineMasks, [1, 1, 1, 0, 2]])
    exact(await command(page, 'redo'), before, masks);
  expect((await snapshot(page)).summary.canRedo).toBe(false);
  const baseline = await command(page, 'undo'); exact(baseline, before);
  expect(baseline.outputs).toEqual(before.outputs); expect(baseline.summary.canRedo).toBe(true);
}

test('Retry edit recovery rebuilds a lost published GPU from the surviving replacement native worker after old-scene retirement', async ({ page }, testInfo) => {
  const report: Record<string, unknown> = { schemaVersion: 1,
    scenario: 'replacement-device-loss-during-old-scene-retirement',
    fault: 'Actual original Worker.terminate plus ErrorEvent; actual published replacement GPUDevice.destroy after old scene borrowers join.' };
  try {
    await page.goto('/e2e/operation-harness.html');
    await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
    expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
    await page.evaluate(() => window.operationHarness.load()); await settled(page);
    const before = await snapshot(page); report.before = before;
    expect(before.summary).toMatchObject({ canUndo: true, canRedo: true });
    await page.evaluate(() => window.operationHarness.armPostPublicationLoss());
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    await expect.poll(async () => {
      const value = await state(page);
      return { injected: value.postPublicationLoss?.lossJoined, renderer: value.rendererState,
        recovery: value.recovery, busy: value.busy };
    }).toEqual({ injected: true, renderer: 'unavailable', recovery: 'required', busy: false });
    const first = await state(page), firstTrace = await trace(page); report.firstAttempt = first; report.firstTrace = firstTrace;
    expect(first.postPublicationLoss).toMatchObject({ calls: 1, oldScene: before.scene, oldWorker: before.authoritativeWorker,
      oldDeviceEpoch: before.deviceEpoch, oldBorrowersJoined: true, oldRetired: true, lossJoined: true, lossReason: 'destroyed' });
    expect(first.authoritativeWorker).not.toBe(before.authoritativeWorker);
    expect(first.clientGeneration).not.toBe(before.clientGeneration);
    expect(first.scene).toBe(first.postPublicationLoss!.publishedScene);
    expect(first.authoritativeWorker).toBe(first.postPublicationLoss!.publishedWorker);
    expect(first.clientGeneration).toBe(first.postPublicationLoss!.publishedGeneration);
    expect(first.deviceEpoch).toBe(first.postPublicationLoss!.publishedDeviceEpoch);
    expect(firstTrace.requests.filter(request => request.type === 'recovery-restore' && request.forwarded)).toHaveLength(1);
    expect(firstTrace.workers.find(worker => worker.id === first.authoritativeWorker)).toMatchObject({ terminated: 0, injectedFailures: 0 });
    const retry = page.getByRole('button', { name: 'Retry edit recovery', exact: true });
    await expect(retry).toBeEnabled(); await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
    await settled(page);
    const after = await snapshot(page), afterTrace = await trace(page); report.afterRetry = after; report.afterTrace = afterTrace;
    exact(after, before); expect(after.outputs).toEqual(before.outputs);
    expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision,
      selected: before.summary.selected, visible: before.summary.visible, canUndo: true, canRedo: true });
    expect(after.authoritativeWorker).toBe(first.authoritativeWorker); expect(after.clientGeneration).toBe(first.clientGeneration);
    expect(after.document).toEqual(first.document); expect(after.scene).not.toBe(first.scene); expect(after.deviceEpoch).not.toBe(first.deviceEpoch);
    expect(afterTrace.workers).toHaveLength(firstTrace.workers.length);
    expect(afterTrace.workers.filter(worker => worker.injectedFailures > 0)).toHaveLength(1);
    expect(afterTrace.workers.find(worker => worker.id === first.authoritativeWorker)).toMatchObject({ terminated: 0, injectedFailures: 0 });
    expect(afterTrace.requests.filter(request => request.type === 'recovery-restore' && request.forwarded)).toHaveLength(1);
    expect(afterTrace.responses.filter(response => response.type === 'recovery-result' && response.data.action === 'restore' && response.delivered)).toHaveLength(1);
    expect(afterTrace.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
    expect(afterTrace.requests.filter(request => request.type === 'operation')).toHaveLength(0);
    expect(after.resources.scenes.find(scene => scene.id === first.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
    await expect(page.getByRole('alert')).toHaveCount(0);
    await completeHistory(page, before); report.historyVerified = true;
    const finalTrace = await trace(page); report.finalTrace = finalTrace;
    expect(finalTrace.workers).toHaveLength(afterTrace.workers.length);
    expect(finalTrace.requests.filter(request => request.type === 'recovery-restore' && request.forwarded)).toHaveLength(1);
    expect(finalTrace.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
  } finally {
    report.finalState = await state(page).catch(error => ({ observationError: String(error) }));
    report.finalWire = await trace(page).catch(error => ({ observationError: String(error) }));
    await testInfo.attach('worker-retirement-retry-evidence.json', { contentType: 'application/json',
      body: Buffer.from(JSON.stringify(report, null, 2)) });
  }
});
