import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['toolSnapshot']>>;
type Pressure = NonNullable<ReturnType<Window['operationHarness']['pressure']>>;
const masks = [1, 0, 1, 0, 2], positions = [-.75, -.4, 0, .4, .75];
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.toolSnapshot());
const pressure = (page: Page) => page.evaluate(() => window.operationHarness.pressure()!);
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await pressure(page); return { ready: value.current.ready, busy: value.current.busy,
      renderer: value.current.rendererState, recovery: value.current.recovery };
  }).toEqual({ ready: true, busy: false, renderer: 'ready', recovery: 'idle' });
}
function exact(value: Snapshot, before: Snapshot, expectedMasks = masks) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    transaction: false, selectionDraft: false, pending: false });
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.sourceName).toBe(before.sourceName);
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset);
  expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  expect(value.camera).toEqual(before.camera); expect(value.tools.defaultCamera).toEqual(before.tools.defaultCamera);
  expect(value.tools.background).toEqual(before.tools.background); expect(value.tools.checkpoints).toEqual(before.tools.checkpoints);
  expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  expect(value.packed).toEqual(before.packed); expect(value.gpu.data).toEqual(value.packed);
  // The independent accepted-checkpoint observer includes all144 native
  // Gaussian bytes, including every SH3 half word and covariance padding.
  expect(value.nativeScene.records).toEqual(before.nativeScene.records);
  expect(value.nativeScene.masks).toEqual(expectedMasks);
  expect(value.nativeScene.scopes).toEqual([0, 1, 2].map(scope => before.nativeScene.records.filter((_, id) =>
    !(expectedMasks[id] & 2) && (scope === 0 || scope === 1 && (expectedMasks[id] & 1) || scope === 2 && !(expectedMasks[id] & 1)))));
  expect(value.outputsAvailable).toBe(true); const source = before.sourceOutput, x = source.properties.indexOf('x');
  expect(source.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  value.outputs.forEach((output, scope) => {
    const ids = expectedMasks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output!.properties).toEqual(source.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = source.records.find(row => row[x] === Math.fround(positions[id])); expect(record).toBeDefined(); return record;
    }));
  });
  expect(value.resources.work).toBe(0);
}
async function command(page: Page, command: 'undo' | 'redo') {
  await page.evaluate(command => window.operationHarness.command({ command }), command); await settled(page); return snapshot(page);
}
async function completeHistory(page: Page, before: Snapshot) {
  for (const expected of [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]])
    exact(await command(page, 'undo'), before, expected);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const expected of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks, [1, 1, 1, 0, 2]])
    exact(await command(page, 'redo'), before, expected);
  expect((await snapshot(page)).summary.canRedo).toBe(false);
  const restored = await command(page, 'undo'); exact(restored, before); expect(restored.outputs).toEqual(before.outputs);
  expect(restored.summary.canRedo).toBe(true);
}
async function start(page: Page, mode: 'recoverable' | 'insufficient', before: Snapshot) {
  await page.evaluate(mode => window.operationHarness.armPressure(mode), mode);
  await page.evaluate(() => window.operationHarness.clear());
  await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
}
async function heldRetirement(page: Page, before: Snapshot) {
  await expect.poll(async () => (await pressure(page)).attempts[0]?.outcome).toBe('refused');
  const refused = await pressure(page), first = refused.attempts[0];
  expect(first).toMatchObject({ admissionError: true, retirementJoined: false, oldRetired: false,
    oldCreditBytes: refused.oldAllocationBytes, afterBytes: first.beforeBytes });
  expect(first.availableBytes).toBe(first.requiredDelta - refused.deficit);
  expect(refused.fillerHeld).toBe(true); expect(refused.limit).toBe(1024 * 1024 * 1024);
  expect((await trace(page)).responses.filter(row => row.type === 'recovery-result' && row.data.action === 'restore' && row.delivered)).toHaveLength(1);
  // Regression boundary: the old implementation stopped after a genuine
  // admission refusal, even though joining its old GPU would make room.
  await expect.poll(async () => {
    const value = await pressure(page); return { calls: value.retirementCalls, fence: value.queueFenceJoined };
  }).toEqual({ calls: 1, fence: true });
  const held = await pressure(page);
  expect(held).toMatchObject({ oldRetired: true, retirementJoined: false, borrowerReleased: false,
    destroyedBuffers: 0, oldCreditBytes: held.oldAllocationBytes, fillerHeld: true });
  expect(held.current).toMatchObject({ ready: false, busy: true, rendererState: 'recovering' });
  expect(held.attempts).toHaveLength(1); expect(held.oldScene).toBe(before.scene);
  expect(held.resources.usage.bytes).toBe(first.beforeBytes);
  return held;
}
function joined(value: Pressure) {
  expect(value).toMatchObject({ retirementCalls: 1, retirementJoined: true, borrowerReleased: true,
    queueFenceJoined: true, oldRetired: true, oldCreditBytes: null, oldHistoryBytes: null });
  expect(value.destroyedBuffers).toBe(value.bufferCount); expect(value.attempts).toHaveLength(2);
  expect(value.attempts[1]).toMatchObject({ worker: value.attempts[0].worker, generation: value.attempts[0].generation,
    oldCreditBytes: null, oldRetired: true, retirementJoined: true });
  expect(value.attempts[1].beforeBytes).toBe(value.attempts[0].beforeBytes - value.oldAllocationBytes);
  expect(value.attempts[1].availableBytes).toBe(value.attempts[0].availableBytes + value.oldAllocationBytes);
  expect(value.limit).toBe(1024 * 1024 * 1024);
}
async function closed(page: Page) {
  await page.evaluate(() => window.operationHarness.closePressure());
  await page.evaluate(() => window.operationHarness.releasePressureCredit());
  const value = await pressure(page);
  expect(value.current).toMatchObject({ hasClient: false, hasScene: false, checkpoint: null, summary: null, busy: false, recovery: 'idle' });
  expect(value.resources.usage).toMatchObject({ bytes: 0, allocations: 0 }); expect(value.resources.work).toBe(0);
  expect(value.retirementCalls).toBe(1); expect(value.resources.scenes.every(scene => scene.retired)).toBe(true);
  return value;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load());
  await page.evaluate(() => window.operationHarness.navigateToolCamera());
});

test('actual worker restoration reuses its imported native candidate when joined old GPU retirement resolves genuine ledger admission pressure', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'real-ledger-pressure-old-gpu-retirement-same-native-candidate' };
  try {
    const before = await snapshot(page); report.before = before;
    await start(page, 'recoverable', before); report.held = await heldRetirement(page, before);
    await page.evaluate(() => window.operationHarness.releasePressureBorrower()); await settled(page);
    const admitted = await pressure(page); report.admitted = admitted; joined(admitted);
    expect(admitted.attempts[1]).toMatchObject({ outcome: 'accepted', admissionError: false, error: null });
    expect(admitted.current.worker).toBe(admitted.attempts[0].worker); expect(admitted.fillerHeld).toBe(true);
    expect(admitted.attempts[1].afterBytes - admitted.attempts[1].beforeBytes).toBe(admitted.attempts[1].requiredDelta);
    const evidence = await trace(page); report.evidence = evidence;
    expect(evidence.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
    expect(evidence.workers.find(worker => worker.id === admitted.current.worker)).toMatchObject({ terminated: 0, injectedFailures: 0 });
    expect(evidence.requests.filter(row => row.type === 'source-load' || row.type === 'source-group-load' || row.type === 'operation')).toHaveLength(0);
    await page.evaluate(() => window.operationHarness.releasePressureCredit());
    const after = await snapshot(page); report.after = after; exact(after, before); expect(after.document).toEqual(before.document);
    expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision, canUndo: true, canRedo: true });
    expect(after.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
    await completeHistory(page, before); report.historyVerified = true; report.closed = await closed(page);
  } finally {
    report.finalPressure = await pressure(page).catch(error => ({ error: String(error) })); report.finalTrace = await trace(page).catch(error => ({ error: String(error) }));
    await page.evaluate(() => window.operationHarness.disarmPressure()).catch(() => undefined);
    await info.attach('worker-pressure-recovered-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
  }
});

for (const action of ['retry', 'close'] as const) {
  test(`actual worker restoration retains its checkpoint when pressure remains after joined old GPU retirement and supports explicit ${action}`, async ({ page }, info) => {
    const report: Record<string, unknown> = { scenario: 'real-ledger-pressure-insufficient-after-old-gpu-retirement', action };
    try {
      const before = await snapshot(page); report.before = before;
      await start(page, 'insufficient', before); report.held = await heldRetirement(page, before);
      await page.evaluate(() => window.operationHarness.releasePressureBorrower());
      await expect.poll(async () => {
        const value = await pressure(page); return { busy: value.current.busy, recovery: value.current.recovery, renderer: value.current.rendererState };
      }).toEqual({ busy: false, recovery: 'required', renderer: 'unavailable' });
      const refused = await pressure(page); report.refused = refused; joined(refused);
      expect(refused.attempts[1]).toMatchObject({ outcome: 'refused', admissionError: true, afterBytes: refused.attempts[1].beforeBytes });
      expect(refused.attempts[1].availableBytes).toBe(refused.attempts[1].requiredDelta - 1);
      expect(refused.current).toMatchObject({ hasScene: false, hasRenderer: false, checkpoint: before.checkpoint!.rootSha256 });
      expect((await trace(page)).workers.find(worker => worker.id === refused.attempts[0].worker)!.terminated).toBeGreaterThanOrEqual(1);
      report.evidence = await trace(page);
      if (action === 'retry') {
        await page.evaluate(() => window.operationHarness.releasePressureCredit());
        const retry = page.getByRole('button', { name: 'Retry edit recovery', exact: true });
        await expect(retry).toBeEnabled(); await retry.focus(); await retry.press('Enter'); await settled(page);
        const admitted = await pressure(page); report.admitted = admitted;
        expect(admitted.attempts).toHaveLength(3); expect(admitted.attempts[2].outcome).toBe('accepted');
        expect(admitted.current.worker).toBe(admitted.attempts[2].worker); expect(admitted.current.worker).not.toBe(refused.attempts[0].worker);
        expect(admitted.retirementCalls).toBe(1); expect(admitted.limit).toBe(refused.limit);
        const evidence = await trace(page); report.evidence = evidence;
        expect(evidence.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(2);
        expect(evidence.requests.filter(row => row.type === 'source-load' || row.type === 'source-group-load' || row.type === 'operation')).toHaveLength(0);
        const after = await snapshot(page); report.after = after; exact(after, before); expect(after.document).toEqual(before.document);
        await completeHistory(page, before); report.historyVerified = true;
      }
      report.closed = await closed(page);
      if (action === 'close') {
        expect((await pressure(page)).current.rendererState).toBe('unavailable');
        expect(await page.evaluate(() => window.operationHarness.recoverGraphics())).toBe(true);
        const empty = await pressure(page); report.emptyRecovery = empty;
        expect(empty.current).toMatchObject({ ready: true, hasClient: false, hasScene: false, hasRenderer: true, checkpoint: null, rendererState: 'ready' });
        expect(empty.resources.usage).toMatchObject({ bytes: 32 * 1024 * 1024, allocations: 1 });
        expect(empty.resources.entries.map(({ category, bytes }) => ({ category, bytes })))
          .toEqual([{ category: 'source', bytes: 32 * 1024 * 1024 }]);
        expect(empty.current.bootstrap).toMatchObject({ worker: expect.any(Number), generation: expect.any(String), failed: false,
          memory: { observed: true, retired: false, coveredBytes: 0, heapBytes: 32 * 1024 * 1024,
            remainderBytes: 32 * 1024 * 1024, unreconciledHeapBytes: null } });
        await page.evaluate(() => window.operationHarness.load());
        const reopened = await snapshot(page); report.reopened = reopened;
        expect(reopened.authoritativeWorker).toBe(empty.current.bootstrap!.worker);
        expect(reopened.clientGeneration).toBe(empty.current.bootstrap!.generation);
        expect(await page.evaluate(() => window.operationHarness.startupCore())).toBeNull();
        expect(reopened.rendererState).toBe('ready'); expect(reopened.sourceFingerprint).toEqual(before.sourceFingerprint);
        expect(reopened.nativeScene.records).toEqual(before.nativeScene.records); expect(reopened.masks).toEqual(before.masks);
        expect(reopened.outputs).toEqual(before.outputs); expect(reopened.gpu).toEqual(before.gpu);
        await page.evaluate(() => window.operationHarness.closePressure());
        const finalResources = await page.evaluate(() => window.operationHarness.resources()); report.reopenedClosed = finalResources;
        expect(finalResources.usage).toMatchObject({ bytes: 0, allocations: 0 }); expect(finalResources.scenes.every(scene => scene.retired)).toBe(true);
      }
    } finally {
      report.finalPressure = await pressure(page).catch(error => ({ error: String(error) })); report.finalTrace = await trace(page).catch(error => ({ error: String(error) }));
      await page.evaluate(() => window.operationHarness.disarmPressure()).catch(() => undefined);
      await info.attach('worker-pressure-insufficient-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
    }
  });
}
