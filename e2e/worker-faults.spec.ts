import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {} from './operation-harness';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['toolSnapshot']>>;
type Compact = Awaited<ReturnType<Window['operationHarness']['compactRecoverySnapshot']>>;
type Observation = ReturnType<Window['operationHarness']['reconstruction']>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
const masks = [1, 0, 1, 0, 2], positions = [-.75, -.4, 0, .4, .75];
const graph = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks, [1, 1, 1, 0, 2]];
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.toolSnapshot());
const observation = (page: Page) => page.evaluate(() => window.operationHarness.reconstruction());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await page.evaluate(() => window.operationHarness.state());
    // The automatic selection pivot refreshes in the background after history.
    return { busy: value.busy || value.transformPivotPending, recovery: value.recovery, renderer: value.rendererState };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready' });
}
// The pivot follows the selection, so it matches the baseline only when the
// selection does. Every other tool value is history-invariant.
function tools(value: Snapshot, sameSelection: boolean) {
  return sameSelection ? value.tools : { ...value.tools, transformParameters: { ...value.tools.transformParameters, pivot: null } };
}
async function failed(page: Page) {
  // restoreWorker publishes refusal before its finally block joins borrowers.
  // Wait for real native retirement too, rather than using the UI as a fence.
  await expect.poll(async () => {
    const value = await observation(page);
    return { busy: value.current.busy, recovery: value.current.recovery, renderer: value.current.rendererState,
      retired: value.candidateMemory?.retired, remainder: value.candidateMemory?.remainderBytes };
  }).toEqual({ busy: false, recovery: 'required', renderer: 'unavailable', retired: true, remainder: 0 });
  return observation(page);
}
function exact(value: Snapshot, before: Snapshot, expectedMasks = masks) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    selected: expectedMasks.filter(mask => (mask & 1) && !(mask & 2)).length,
    visible: expectedMasks.filter(mask => !(mask & 2)).length,
    contentRevision: expectedMasks[4] === 2 ? 1 : 0, transaction: false, pending: false, selectionDraft: false });
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.document.draftRevision).toBe(0); expect(value.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(value.sourceName).toBe(before.sourceName); expect(value.camera).toEqual(before.camera);
  expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset);
  expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  const sameSelection = expectedMasks.every((mask, id) => (mask & 1) === (masks[id] & 1));
  expect(tools(value, sameSelection)).toEqual(tools(before, sameSelection)); expect(value.packed).toEqual(before.packed); expect(value.gpu.data).toEqual(before.packed);
  expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  expect(value.nativeScene.records).toEqual(before.nativeScene.records); expect(value.nativeScene.masks).toEqual(expectedMasks);
  expect(value.resources.work).toBe(0);
  const source = before.sourceOutput, x = source.properties.indexOf('x');
  expect(source.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  value.outputs.forEach((output, scope) => {
    const ids = expectedMasks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    expect(value.nativeScene.scopes[scope]).toEqual(ids.map(id => before.nativeScene.records[id]));
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output!.properties).toEqual(source.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = source.records.find(record => record[x] === Math.fround(positions[id])); expect(record).toBeDefined(); return record;
    }));
  });
}
async function history(page: Page, before: Snapshot) {
  for (const expected of [...graph.slice(0, 4)].reverse()) {
    await page.evaluate(() => window.operationHarness.command({ command: 'undo' })); await settled(page); exact(await snapshot(page), before, expected);
  }
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const expected of graph.slice(1)) {
    await page.evaluate(() => window.operationHarness.command({ command: 'redo' })); await settled(page); exact(await snapshot(page), before, expected);
  }
  expect((await snapshot(page)).summary.canRedo).toBe(false);
  await page.evaluate(() => window.operationHarness.command({ command: 'undo' })); await settled(page);
  const end = await snapshot(page); exact(end, before); expect(end.summary.canRedo).toBe(true);
}
function noReplay(evidence: Trace, transforms = 0) {
  expect(evidence.requests.filter(row => ['source-load', 'source-group-load', 'source-range'].includes(row.type))).toHaveLength(0);
  expect(evidence.requests.filter(row => row.type === 'command' && row.command === 'transform' && row.forwarded)).toHaveLength(transforms);
}
function retained(value: Observation, before: { scene: number | null; clientGeneration: string | null; checkpoint: Snapshot['checkpoint'] }) {
  expect(value.current.scene).toBe(before.scene); expect(value.oldRetired).toBe(false); expect(value.oldCreditBytes).toBeGreaterThan(0);
  expect(value.current.generation).toBe(before.clientGeneration); expect(value.current.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
  expect(value.current.checkpoint!.binding).toEqual(before.checkpoint!.binding); expect(value.current.checkpoint!.plan).toEqual(before.checkpoint!.plan);
  const introduced = [...value.heldEntries, ...(value.gpu?.entries ?? [])].filter(entry => !value.originalEntryIds.includes(entry.id));
  expect(introduced.length).toBeGreaterThan(0);
  expect(value.resources.entries.filter(entry => introduced.some(prior => prior.id === entry.id))).toEqual([]);
  expect(value.resources.work).toBe(0); expect(value.heldPayloadRetained).toBe(false);
}
async function retry(page: Page) {
  const button = page.getByRole('button', { name: 'Retry edit recovery', exact: true });
  await expect(button).toBeEnabled(); await button.focus(); await expect(button).toBeFocused(); await button.press('Enter'); await settled(page);
}
async function lateIsolation(page: Page, worker: number, before: Snapshot) {
  const evidence = await trace(page), index = evidence.responses.findIndex(row => row.worker === worker &&
    (row.type === 'error' || row.type === 'recovery-range-request' || row.type === 'recovery-result'));
  expect(index).toBeGreaterThanOrEqual(0); await page.evaluate(index => window.operationHarness.release(index, 2), index);
  const after = await snapshot(page); expect(after.document).toEqual(before.document); expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after.gpu).toEqual(before.gpu); expect(after.outputs).toEqual(before.outputs); expect(after.nativeScene).toEqual(before.nativeScene);
}
async function finishRetry(page: Page, before: Snapshot, refused: Observation, report: Record<string, unknown>) {
  await retry(page); const after = await snapshot(page), evidence = await trace(page); report.after = after; report.afterTrace = evidence;
  exact(after, before); expect(after.document).toEqual(before.document); expect(after.checkpoint).toEqual(before.checkpoint);
  expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision, canUndo: true, canRedo: true });
  expect(after.authoritativeWorker).not.toBe(before.authoritativeWorker); expect(after.authoritativeWorker).not.toBe(refused.candidate);
  expect(after.clientGeneration).not.toBe(before.clientGeneration); expect(after.scene).not.toBe(before.scene);
  expect(evidence.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(2);
  expect(evidence.workers.find(row => row.id === refused.candidate)!.terminated).toBeGreaterThanOrEqual(1);
  expect(after.resources.scenes.find(scene => scene.id === before.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  noReplay(evidence); expect(evidence.requests.filter(row => row.type === 'operation')).toHaveLength(0);
  await lateIsolation(page, refused.candidate!, after); report.lateTerminalsIgnored = true;
  await history(page, before); report.fullHistoryVerified = true;
  const final = await trace(page); noReplay(final); expect(final.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(2);
}
async function attach(page: Page, info: TestInfo, report: Record<string, unknown>) {
  report.final = await observation(page).catch(error => ({ error: String(error) }));
  report.finalTrace = await trace(page).catch(error => ({ error: String(error) }));
  await info.attach('worker-fault-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
  await page.evaluate(() => window.operationHarness.disarmReconstructionFault()).catch(() => undefined);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

for (const mode of ['header', 'payload', 'source-generation', 'core'] as const) {
  test(`actual replacement rejects ${mode} corruption at its named verification gate and retries the untouched accepted checkpoint`, async ({ page }, info) => {
    const report: Record<string, unknown> = { scenario: `unpublished-restore-${mode}`, gate: mode === 'core' ? 'worker compiled native identity' :
      mode === 'source-generation' ? 'binding source generation equals authenticated public base' : `worker independent ${mode} SHA-256` };
    try {
      await page.evaluate(() => window.operationHarness.load()); const before = await snapshot(page); report.before = before;
      await page.evaluate(mode => window.operationHarness.armReconstructionFault(mode), mode);
      await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
      const refused = await failed(page); report.refused = refused; retained(refused, before);
      expect(refused.errors).toHaveLength(1); expect(refused.errors[0]).toMatchObject({ cancelled: false, cleanupFailed: false });
      expect(refused.errors[0].message).toMatch(mode === 'header' ? /header does not match/ : mode === 'payload' ? /payload does not match/ : /another native core or public revision/);
      const evidence = await trace(page); report.refusalTrace = evidence; noReplay(evidence);
      expect(evidence.responses.filter(row => row.worker === refused.candidate && row.type === 'recovery-result')).toHaveLength(0);
      if (mode === 'header' || mode === 'payload') {
        await expect.poll(async () => (await observation(page)).mutation!.afterSha256).toMatch(/^[a-f0-9]{64}$/);
        const mutation = (await observation(page)).mutation!; report.mutation = mutation;
        expect(mutation).toMatchObject({ offset: mode === 'header' ? 0 : 64, length: before.checkpoint!.plan.byteLength });
        expect(mutation.beforeSha256).toBe(refused.current.checkpoint!.chunks[0].sha256); expect(mutation.afterSha256).not.toBe(mutation.beforeSha256);
        expect(evidence.requests.filter(row => row.worker === refused.candidate && row.type === 'recovery-range' && row.altered)).toHaveLength(1);
        expect(refused.consumed).toEqual(mode === 'header' ? [] : [0]);
      } else {
        expect(refused.mutation!.before).not.toEqual(refused.mutation!.after); expect(refused.consumed).toEqual([]);
        expect(evidence.responses.filter(row => row.worker === refused.candidate && row.type === 'recovery-range-request')).toHaveLength(0);
        expect(evidence.requests.find(row => row.worker === refused.candidate && row.type === 'recovery-restore')).toMatchObject({ altered: true, forwarded: true });
      }
      expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
      await finishRetry(page, before, refused, report);
    } finally { await attach(page, info, report); }
  });
}

test('actual replacement termination at its first held range joins the admitted copy and retries without claiming partial import', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'prepared-input-no-payload-written' };
  try {
    await page.evaluate(() => window.operationHarness.load()); const before = await snapshot(page); report.before = before;
    await page.evaluate(() => window.operationHarness.armReconstructionFault('range'));
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    await expect.poll(async () => (await observation(page)).rangeHeld).toBe(true);
    const held = await observation(page); report.held = held;
    expect(held.consumed).toEqual([]); expect(held.candidateMemory).toMatchObject({ retired: false }); expect(held.heldPayloadRetained).toBe(true);
    expect(held.current).toMatchObject({ busy: true, rendererState: 'recovering', scene: before.scene });
    expect((await trace(page)).requests.find(row => row.worker === held.candidate && row.type === 'recovery-range'))
      .toMatchObject({ forwarded: false, data: { index: 0, offset: 0, length: before.checkpoint!.plan.byteLength } });
    await page.evaluate(id => window.operationHarness.failWorker(id), held.candidate);
    const refused = await failed(page); report.refused = refused; retained(refused, before);
    expect((await trace(page)).workers.find(row => row.id === held.candidate)).toMatchObject({ injectedFailures: 1 });
    await finishRetry(page, before, refused, report);
  } finally { await attach(page, info, report); }
});

test('Close joins a real cancelled replacement terminal before returning held restore-copy credit and prevents late adoption', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'close-while-real-restore-copy-held' };
  try {
    await page.evaluate(() => window.operationHarness.load()); const before = await snapshot(page); report.before = before;
    await page.evaluate(() => window.operationHarness.armReconstructionFault('range'));
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    await expect.poll(async () => (await observation(page)).rangeHeld).toBe(true);
    const held = await observation(page); report.held = held;
    await page.evaluate(() => window.operationHarness.beginReconstructionClose());
    await expect.poll(async () => (await observation(page)).cancellationHeld).toBe(true);
    const cancelling = await observation(page); report.cancelling = cancelling;
    expect(cancelling).toMatchObject({ closeStarted: true, closeSettled: false, oldRetired: false });
    expect(cancelling.candidateMemory).toMatchObject({ retired: false });
    const introduced = held.heldEntries.filter(entry => !held.originalEntryIds.includes(entry.id) && entry.category === 'recovery');
    expect(introduced.length).toBeGreaterThan(0);
    expect(cancelling.resources.entries.filter(entry => introduced.some(prior => prior.id === entry.id))).toEqual(introduced);
    const evidence = await trace(page), terminal = evidence.responses.findIndex(row => row.worker === held.candidate && row.type === 'error' && !row.delivered);
    expect(terminal).toBeGreaterThanOrEqual(0); expect(evidence.responses[terminal].data).toMatchObject({ cancelled: true, cleanupFailed: false });
    await page.evaluate(index => window.operationHarness.release(index), terminal);
    const closed = await page.evaluate(() => window.operationHarness.joinReconstructionClose()); report.closed = closed;
    expect(closed.closeSettled).toBe(true); expect(closed.current).toMatchObject({ hasClient: false, scene: null, checkpoint: null, busy: false, recovery: 'idle' });
    expect(closed.resources.usage).toMatchObject({ bytes: 0, allocations: 0 }); expect(closed.oldRetired).toBe(true); expect(closed.oldCreditBytes).toBeNull();
    expect(closed.candidateMemory).toMatchObject({ retired: true, remainderBytes: 0 });
    expect(closed.heldPayloadRetained).toBe(false);
    await page.evaluate(index => window.operationHarness.release(index, 2), terminal);
    const late = await observation(page); expect(late.current).toEqual(closed.current); expect(late.resources.usage).toEqual(closed.resources.usage);
    noReplay(await trace(page)); expect((await trace(page)).requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(1);
  } finally { await attach(page, info, report); }
});

test('actual replacement GPU destruction after upload fence and before publication retires the candidate and retries a fresh native import', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'actual-prepublication-device-destroy' };
  try {
    await page.evaluate(() => window.operationHarness.load()); const before = await snapshot(page); report.before = before;
    await page.evaluate(() => window.operationHarness.armReconstructionFault('gpu'));
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    const refused = await failed(page); report.refused = refused; retained(refused, before);
    expect(refused.gpu).toMatchObject({ fenceJoined: true, beforePublication: true, lossJoined: true, reason: 'destroyed', disposalJoined: true });
    expect(refused.gpu!.destroyedBuffers).toBe(refused.gpu!.buffers); expect(refused.gpu!.buffers).toBeGreaterThan(0);
    expect(refused.resources.scenes.find(scene => scene.id === refused.gpu!.scene)).toMatchObject({ retired: true, disposeCalls: 1, current: false });
    expect(refused.candidateFailed).toBe(true);
    const evidence = await trace(page); report.refusalTrace = evidence;
    expect(evidence.responses.filter(row => row.worker === refused.candidate && row.type === 'recovery-result' && row.data.action === 'restore')).toHaveLength(1);
    await finishRetry(page, before, refused, report);
  } finally { await attach(page, info, report); }
});

function compactExact(value: Compact, before: Compact, expectedMasks = masks) {
  const selected = expectedMasks.filter(mask => (mask & 1) && !(mask & 2)).length, deleted = expectedMasks.filter(mask => mask & 2).length;
  expect(value.summary).toMatchObject({ ok: true, loaded: true, count: 8192, sourceCount: 8192, shDegree: 3, selected, visible: 8192 - deleted,
    contentRevision: deleted ? 1 : 0, pending: false, transaction: false, selectionDraft: false });
  expect(value.stride).toBe(136); expect(value.packedSha256).toBe(before.packedSha256);
  expect(value.gpuSha256).toBe(value.packedSha256); expect(value.nativePackedSha256).toBe(value.packedSha256);
  expect(value.nativeSha256).toBe(before.nativeSha256); expect(value.masksSha256).toBe(value.expectedMasksSha256);
  expect(value.nativeMasksSha256).toBe(value.expectedMasksSha256); expect(value.gpuMasksSha256).toBe(value.expectedGpuMasksSha256);
  expect(value.scopeCounts).toEqual([8192 - deleted, selected, 8192 - deleted - selected]);
  value.outputs.forEach((output, scope) => {
    expect(output.count).toBe(value.scopeCounts[scope]); expect(output.sha256).toBe(output.expectedSha256);
    expect(output.properties).toEqual(before.outputs[0].properties); expect(output.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  });
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.checkpoint!.binding.source).toEqual(before.checkpoint!.binding.source);
  expect(value.checkpoint!.binding.subset).toEqual(before.checkpoint!.binding.subset); expect(value.checkpoint!.binding.core).toEqual(before.checkpoint!.binding.core);
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.camera).toEqual(before.camera); expect(value.resources.work).toBe(0);
}
test('actual multi-chunk replacement termination after a consumed native write preserves exact compact SH3 outputs, GPU, masks and history', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'actual-partial-import-after-consumed-first-MiB', hashAlgorithm: 'SHA-256' };
  try {
    report.input = await page.evaluate(() => window.operationHarness.loadPartialRecovery());
    const before = await page.evaluate(() => window.operationHarness.compactRecoverySnapshot()); report.before = before;
    compactExact(before, before); expect(before.checkpoint!.plan.byteLength).toBeGreaterThan(1024 * 1024);
    expect(before.checkpoint!.plan.byteLength).toBeLessThan(2 * 1024 * 1024);
    await page.evaluate(() => window.operationHarness.armReconstructionFault('range', 1));
    await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker);
    await expect.poll(async () => (await observation(page)).rangeHeld).toBe(true);
    const held = await observation(page), evidence = await trace(page); report.held = held; report.partialTrace = evidence;
    expect(held.consumed).toEqual([0]); expect(held.candidateMemory).toMatchObject({ retired: false });
    expect(evidence.requests.filter(row => row.worker === held.candidate && row.type === 'recovery-range')).toMatchObject([
      { forwarded: true, data: { index: 0, offset: 0, length: 1024 * 1024 } },
      { forwarded: false, data: { index: 1, offset: 1024 * 1024, length: before.checkpoint!.plan.byteLength - 1024 * 1024 } },
    ]);
    expect(evidence.responses.filter(row => row.worker === held.candidate && row.type === 'recovery-result')).toHaveLength(0);
    await page.evaluate(id => window.operationHarness.failWorker(id), held.candidate);
    const refused = await failed(page); report.refused = refused; retained(refused, before);
    await retry(page); const after = await page.evaluate(() => window.operationHarness.compactRecoverySnapshot()); report.after = after;
    compactExact(after, before); expect(after.document).toEqual(before.document); expect(after.checkpoint).toEqual(before.checkpoint);
    expect(after.authoritativeWorker).not.toBe(held.candidate); expect(after.authoritativeWorker).not.toBe(before.authoritativeWorker);
    const afterTrace = await trace(page); report.afterTrace = afterTrace; noReplay(afterTrace);
    expect(afterTrace.requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(2);
    const lateIndex = afterTrace.responses.findIndex(row => row.worker === held.candidate && row.type === 'recovery-range-request' && row.data.index === 1);
    expect(lateIndex).toBeGreaterThanOrEqual(0); await page.evaluate(index => window.operationHarness.release(index, 2), lateIndex);
    const late = await page.evaluate(() => window.operationHarness.compactRecoverySnapshot()); compactExact(late, before); expect(late.document).toEqual(after.document);
    const visited = [];
    for (const [direction, nodes] of [['undo', [...graph.slice(0, 4)].reverse()], ['redo', graph.slice(1)]] as const) {
      for (const expected of nodes) {
        await page.evaluate(command => window.operationHarness.command({ command }), direction); await settled(page);
        const actual = await page.evaluate(masks => window.operationHarness.compactRecoverySnapshot(masks), expected);
        compactExact(actual, before, expected); visited.push({ direction, masks: expected, nativeSha256: actual.nativeSha256, outputs: actual.outputs });
      }
      const summary = (await page.evaluate(() => window.operationHarness.state())).summary!;
      expect(direction === 'undo' ? summary.canUndo : summary.canRedo).toBe(false);
    }
    report.history = visited; report.fullHistoryVerified = true; noReplay(await trace(page));
    expect((await trace(page)).requests.filter(row => row.type === 'recovery-restore' && row.forwarded)).toHaveLength(2);
  } finally { await attach(page, info, report); }
});

test('genuine precommit checkpoint admission refusal retains the predecessor decision and complete Redo graph without replay', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'actual-precommit-checkpoint-builder-admission', secondaryAdmissionFault: false };
  try {
    await page.evaluate(() => window.operationHarness.load()); const before = await snapshot(page); report.before = before;
    await page.evaluate(() => { window.operationHarness.armReconstructionFault('admission'); window.operationHarness.start(window.operationHarness.translation()); });
    await expect.poll(async () => {
      const value = await observation(page); return !!value.admission && (value.rangeHeld || !value.current.busy && value.current.recovery === 'required');
    }).toBe(true);
    const refused = await observation(page), evidence = await trace(page); report.refused = refused; report.refusalTrace = evidence;
    expect(refused.admission).toMatchObject({ genuine: true, available: 1 }); expect(refused.admission!.requested).toBeGreaterThan(1);
    expect(refused.fillerHeld).toBe(true); expect(refused.current.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
    expect(refused.current.checkpoint!.binding).toEqual(before.checkpoint!.binding); expect(refused.oldRetired).toBe(false);
    expect(evidence.workers.find(row => row.id === before.authoritativeWorker)).toMatchObject({ injectedFailures: 0 });
    expect(evidence.workers.find(row => row.id === before.authoritativeWorker)!.terminated).toBeGreaterThanOrEqual(1);
    expect(evidence.requests.filter(row => ['recovery-proceed', 'recovery-ack', 'recovery-release'].includes(row.type))).toHaveLength(0);
    expect(evidence.requests.filter(row => row.type === 'operation' && ['commit', 'rollback'].includes(row.action ?? '') && row.forwarded)).toHaveLength(0);
    noReplay(evidence, 1); expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
    const failedCounters = refused.current.document!; report.failedPublicCounters = failedCounters;
    await page.evaluate(() => window.operationHarness.releaseReconstructionFiller());
    if (refused.rangeHeld) { report.resume = 'same genuine held automatic import'; await page.evaluate(() => window.operationHarness.releaseReconstructionRange()); await settled(page); }
    else { report.resume = 'explicit Retry after natural recovery admission refusal'; await retry(page); }
    expect(await page.evaluate(() => window.operationHarness.join())).toBe(false);
    const after = await snapshot(page); report.after = after; exact(after, before);
    expect(after.checkpoint).toEqual(before.checkpoint); expect(after.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision, canUndo: true, canRedo: true });
    const advance = (saved: number, observed: number) => saved === observed ? saved : Math.max(saved, observed) + 1;
    expect(after.document).toEqual({ ...before.document, contentRevision: advance(before.document.contentRevision, failedCounters.contentRevision),
      selectionRevision: advance(before.document.selectionRevision, failedCounters.selectionRevision), draftRevision: 0 });
    expect(after.authoritativeWorker).not.toBe(before.authoritativeWorker); noReplay(await trace(page), 1);
    await history(page, before); report.fullHistoryVerified = true;
  } finally { await attach(page, info, report); }
});
