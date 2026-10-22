import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {} from './operation-harness';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['toolSnapshot']>>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
const masks = [1, 0, 1, 0, 2], positions = [-.75, -.4, 0, .4, .75];
const graph = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks];
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.toolSnapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
const timeout = (page: Page) => page.evaluate(() => window.operationHarness.releaseTimeout());
async function settled(page: Page) {
  await expect.poll(async () => {
    const state = await page.evaluate(() => window.operationHarness.state());
    // The automatic selection pivot refreshes in the background after history.
    return { busy: state.busy || state.transformPivotPending, recovery: state.recovery, renderer: state.rendererState };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready' });
}
// The pivot follows the selection (and its translation), so it matches the
// baseline only when the selection does. Other tool values are history-invariant.
function tools(value: Snapshot['tools'], sameSelection: boolean, dx = 0) {
  const [x, y, z] = value.transformParameters.pivot;
  return { ...value, transformParameters: { ...value.transformParameters, pivot: sameSelection ? [x + dx, y, z] : null } };
}
function fixtureRadius(records: number[][]) {
  // All five opaque fixture splats participate in native bounds, including
  // the deleted fifth record. The four visible records alone are translated.
  // This fixture has no distant background; its 90th-percentile covariance
  // footprint and half-extents give the radius independently of the summary.
  const views = records.map(bytes => new DataView(Uint8Array.from(bytes).buffer));
  expect(views).toHaveLength(5);
  expect(views.every(view => view.getFloat32(12,true) >= 1 / 255)).toBe(true);
  const extents = [0,4,8].map(offset => {
    const coordinates = views.map(view => view.getFloat32(offset,true));
    return Math.fround(Math.fround(Math.max(...coordinates) - Math.min(...coordinates)) * .5);
  });
  const footprints = views.map(view => Math.fround(3 * Math.fround(Math.sqrt(Math.max(0,
    view.getFloat32(16,true),view.getFloat32(28,true),view.getFloat32(36,true)))))).sort((a,b) => a - b);
  return Math.max(Math.fround(.05),Math.fround(Math.fround(Math.hypot(...extents)) + footprints[3]));
}
function exact(value: Snapshot, before: Snapshot, expectedMasks = masks, dx = 0) {
  const selected = expectedMasks.filter(mask => (mask & 1) && !(mask & 2)).length;
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    selected, visible: expectedMasks.filter(mask => !(mask & 2)).length, transaction: false, pending: false, selectionDraft: false,
    contentRevision: dx ? 2 : expectedMasks[4] === 2 ? 1 : 0 });
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.document.draftRevision).toBe(0); expect(value.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(value.sourceName).toBe(before.sourceName); expect(value.camera).toEqual(before.camera);
  expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset); expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  const native = before.nativeScene.records.map((record,id) => {
    const bytes = Uint8Array.from(record), view = new DataView(bytes.buffer);
    if (id !== 4) view.setFloat32(0, Math.fround(view.getFloat32(0,true) + dx), true);
    return Array.from(bytes);
  });
  const radius = fixtureRadius(native), defaultCamera = [...before.tools.defaultCamera];
  expect(before.tools.defaultCamera[6]).toBe(fixtureRadius(before.nativeScene.records));
  expect(value.summary.radius).toBe(radius); defaultCamera[6] = radius;
  const sameSelection = expectedMasks.every((mask, id) => (mask & 1) === (masks[id] & 1));
  expect(tools(value.tools, sameSelection)).toEqual(tools({ ...before.tools, defaultCamera }, sameSelection, dx));
  const packed = Uint8Array.from(before.packed), view = new DataView(packed.buffer);
  positions.forEach((position,id) => view.setFloat32(id * before.stride, Math.fround(Math.fround(position) + (id === 4 ? 0 : dx)), true));
  expect(value.packed).toEqual(Array.from(packed)); expect(value.gpu.data).toEqual(Array.from(packed));
  expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  expect(value.nativeScene.records).toEqual(native); expect(value.nativeScene.masks).toEqual(expectedMasks);
  const original = before.sourceOutput, x = original.properties.indexOf('x');
  expect(original.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  value.outputs.forEach((output,scope) => {
    const ids = expectedMasks.flatMap((mask,id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    expect(value.nativeScene.scopes[scope]).toEqual(ids.map(id => native[id]));
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output!.properties).toEqual(original.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = original.records.find(row => row[x] === Math.fround(positions[id])); expect(record).toBeDefined();
      return record!.map((field,property) => property === x ? Math.fround(field + (id === 4 ? 0 : dx)) : field);
    }));
  });
  expect(value.resources.work).toBe(0);
}
async function history(page: Page, before: Snapshot, successor: boolean) {
  const backwards = successor ? [...graph].reverse() : [...graph.slice(0,4)].reverse();
  for (const expected of backwards) {
    await page.evaluate(() => window.operationHarness.command({ command: 'undo' })); await settled(page); exact(await snapshot(page),before,expected);
  }
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const expected of graph.slice(1)) {
    await page.evaluate(() => window.operationHarness.command({ command: 'redo' })); await settled(page); exact(await snapshot(page),before,expected);
  }
  await page.evaluate(() => window.operationHarness.command({ command: 'redo' })); await settled(page);
  const last = await snapshot(page); exact(last,before,successor ? masks : [1,1,1,0,2],successor ? .125 : 0);
  expect(last.summary.canRedo).toBe(false);
}
function noReplay(evidence: Trace, transforms: number) {
  expect(evidence.requests.filter(row => ['source-load','source-group-load','source-range'].includes(row.type))).toHaveLength(0);
  expect(evidence.requests.filter(row => row.type === 'command' && row.command === 'transform' && row.forwarded)).toHaveLength(transforms);
}
async function attach(page: Page, info: TestInfo, report: Record<string,unknown>) {
  report.finalTrace = await trace(page).catch(error => ({ error: String(error) }));
  report.finalState = await page.evaluate(() => window.operationHarness.state()).catch(error => ({ error: String(error) }));
  await info.attach('worker-timing-evidence.json',{ contentType: 'application/json',body: Buffer.from(JSON.stringify(report,null,2)) });
  await page.evaluate(() => { window.operationHarness.disarmReleaseTimeout(); window.operationHarness.disarmReconstructionFault(); }).catch(() => undefined);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load());
});

test('the real 60-second worker RELEASE wait expires after external acceptance and reconstructs its successor once', async ({ page },info) => {
  test.setTimeout(100_000);
  const report: Record<string,unknown> = { scenario: 'genuine-worker-release-timeout-after-external-decision',
    clock: 'Actual unchanged worker60-second timer; only the identified competing main-thread recovery-export callback is suppressed.',
    nativeTerminalFabricated: false, workerTimerReplaced: false };
  try {
    const before = await snapshot(page); report.before = before; expect(before.summary.canRedo).toBe(true);
    await page.evaluate(() => { window.operationHarness.clear(); window.operationHarness.armReleaseTimeout(); window.operationHarness.start(window.operationHarness.translation()); });
    await expect.poll(async () => (await timeout(page)).heldAt).not.toBeNull();
    const held = await timeout(page), heldTrace = await trace(page); report.held = held; report.heldTrace = heldTrace;
    expect(held.decision!.rootSha256).not.toBe(before.checkpoint!.rootSha256);
    expect(held.current.checkpoint).toEqual(held.decision); expect(held.current.busy).toBe(true);
    expect(held.decision!.plan.contentRevision).toBe(2); expect(held.oldRetired).toBe(false); expect(held.oldCreditBytes).toBeGreaterThan(0);
    expect(held.watchdogs.length).toBeGreaterThan(0); expect(held.watchdogs.some(timer => timer.armed)).toBe(true);
    for (const timer of held.watchdogs) expect(timer).toMatchObject({ delay: 60_000, requestId: held.requestId, recoveryId: held.recoveryId, suppressedAt: null });
    expect(heldTrace.requests.filter(row => row.worker === held.worker && row.type === 'recovery-release'))
      .toMatchObject([{ forwarded: false, data: { requestId: held.requestId, recoveryId: held.recoveryId } }]);
    expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
    // Do not advance a fake clock or replay an invented result. The genuine
    // worker must release its held native export owner and emit this error.
    await expect.poll(async () => (await timeout(page)).error?.response.error ?? null,
      { timeout: 80_000, intervals: [100,500,1000] }).toBe('The recovery transfer acknowledgement timed out.');
    const expired = await timeout(page); report.expired = expired;
    const elapsed = expired.error!.receivedAt - held.heldAt!; report.observedReleaseWaitMs = elapsed;
    expect(elapsed).toBeGreaterThanOrEqual(59_000); expect(elapsed).toBeLessThan(85_000);
    expect(expired.error!.response).toMatchObject({ requestId: held.requestId, cancelled: false, cleanupFailed: false,
      summary: { loaded: true, count: 5, shDegree: 3, transaction: true }, allocation: { loaded: true, count: 5 }, census: { ok: true,scope: 'scoped-cxx-v1' } });
    expect(await page.evaluate(() => window.operationHarness.join())).toBe(true); await settled(page);
    const after = await snapshot(page), complete = await timeout(page), evidence = await trace(page);
    report.after = after; report.complete = complete; report.evidence = evidence;
    exact(after,before,masks,.125); expect(after.summary).toMatchObject({ canUndo: true,canRedo: false,revision: held.decision!.plan.revision,contentRevision: 2 });
    expect(after.checkpoint).toEqual(held.decision); expect(after.document).toEqual(held.decision!.binding.revision);
    expect(after.authoritativeWorker).not.toBe(before.authoritativeWorker); expect(after.clientGeneration).not.toBe(before.clientGeneration);
    expect(after.scene).not.toBe(before.scene); expect(complete.oldRetired).toBe(true); expect(complete.oldCreditBytes).toBeNull();
    expect(complete.oldNativeMemory).toMatchObject({ retired: true,remainderBytes: 0 });
    expect(complete.oldFailure).toBe('The recovery transfer acknowledgement timed out.');
    expect(complete.watchdogs.every(timer => !timer.armed && timer.clearedAt !== null)).toBe(true);
    for (const timer of complete.watchdogs) if (timer.suppressedAt !== null) expect(timer.suppressedAt - timer.requestedAt).toBeGreaterThanOrEqual(59_000);
    expect(evidence.workers.find(worker => worker.id === before.authoritativeWorker)).toMatchObject({ injectedFailures: 0 });
    expect(evidence.workers.find(worker => worker.id === before.authoritativeWorker)!.terminated).toBeGreaterThanOrEqual(1);
    expect(evidence.workers.filter(worker => worker.injectedFailures)).toHaveLength(0);
    expect(evidence.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
    expect(evidence.responses.filter(row => row.type === 'recovery-result' && row.data.action === 'restore' && row.delivered)).toHaveLength(1);
    expect(evidence.responses.filter(row => row.worker === held.worker && row.type === 'error')).toHaveLength(1);
    expect(evidence.requests.filter(row => row.type === 'operation' && ['commit','rollback'].includes(row.action ?? '') && row.forwarded)).toHaveLength(0);
    noReplay(evidence,1); expect(after.resources.scenes.find(scene => scene.id === before.scene)).toMatchObject({ retired: true,disposeCalls: 1 });
    const errorIndex = evidence.responses.findIndex(row => row.worker === held.worker && row.type === 'error');
    expect(errorIndex).toBeGreaterThanOrEqual(0); await page.evaluate(index => window.operationHarness.release(index,2),errorIndex);
    const late = await snapshot(page); exact(late,before,masks,.125); expect(late.document).toEqual(after.document); expect(late.checkpoint).toEqual(after.checkpoint);
    await history(page,before,true); report.fullHistoryVerified = true; report.lateErrorIgnored = true;
    const final = await trace(page); noReplay(final,1); expect(final.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
  } finally { await attach(page,info,report); }
});

test('foreign recovery controls cannot cancel a genuine held import and its authentic range completes on the same candidate', async ({ page },info) => {
  const report: Record<string,unknown> = { scenario: 'foreign-recovery-controls-ignored-before-authentic-range', nativeTerminalFabricated: false };
  try {
    const before = await snapshot(page); report.before = before;
    await page.evaluate(() => { window.operationHarness.clear(); window.operationHarness.armReconstructionFault('range'); });
    await page.evaluate(id => window.operationHarness.failWorker(id),before.authoritativeWorker);
    await expect.poll(() => page.evaluate(() => window.operationHarness.reconstruction().rangeHeld)).toBe(true);
    const held = await page.evaluate(() => window.operationHarness.reconstruction()); report.held = held;
    expect(held.heldPayloadRetained).toBe(true); expect(held.consumed).toEqual([]); expect(held.current.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
    const probes = await page.evaluate(() => window.operationHarness.sendForeignRecoveryControls()); report.foreignControls = probes;
    expect(probes.candidate).toBe(held.candidate); expect(probes.heldPayloadRetained).toBe(true);
    expect(probes.controls.map(control => control.gate)).toEqual(['foreign-recovery-id','foreign-request-id','foreign-operation-owner']);
    probes.controls.forEach(control => {
      expect(control.data).toMatchObject({ type: 'recovery-release',protocolVersion: BUILD_DESCRIPTOR.protocolVersion,base: before.document });
      expect(Object.hasOwn(control.data,'bytes')).toBe(false);
    });
    await page.evaluate(() => window.operationHarness.releaseReconstructionRange()); await settled(page);
    const after = await snapshot(page), end = await page.evaluate(() => window.operationHarness.reconstruction()), evidence = await trace(page);
    report.after = after; report.end = end; report.evidence = evidence;
    exact(after,before); expect(after.document).toEqual(before.document); expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.authoritativeWorker).toBe(held.candidate); expect(after.authoritativeWorker).not.toBe(before.authoritativeWorker);
    expect(after.summary).toMatchObject({ revision: before.summary.revision,contentRevision: before.summary.contentRevision,canUndo: true,canRedo: true });
    expect(end.errors).toEqual([]); expect(end.consumed).toEqual([0]); expect(end.heldPayloadRetained).toBe(false);
    expect(end.candidateMemory).toMatchObject({ active: true,retired: false,unreconciledHeapBytes: null });
    expect(evidence.workers.find(worker => worker.id === held.candidate)).toMatchObject({ terminated: 0,injectedFailures: 0 });
    expect(evidence.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
    expect(evidence.requests.filter(row => row.worker === held.candidate && row.type === 'recovery-release' && row.altered && row.forwarded)).toHaveLength(3);
    expect(evidence.requests.filter(row => row.worker === held.candidate && row.type === 'recovery-range' && row.forwarded)).toHaveLength(1);
    expect(evidence.responses.filter(row => row.worker === held.candidate && row.type === 'recovery-result' && row.data.action === 'restore' && row.delivered)).toHaveLength(1);
    expect(evidence.responses.filter(row => row.worker === held.candidate && row.type === 'error')).toHaveLength(0);
    noReplay(evidence,0); expect(evidence.requests.filter(row => row.type === 'operation')).toHaveLength(0);
    expect(end.oldRetired).toBe(true); expect(end.oldCreditBytes).toBeNull();
    await history(page,before,false); report.fullHistoryVerified = true;
    const final = await trace(page); noReplay(final,0); expect(final.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
  } finally { await attach(page,info,report); }
});
