import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';
import type { SceneCommand } from '../src/document/types';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['snapshot']>>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
type WireFaults = Parameters<Window['operationHarness']['wireFaults']>[0];
const masks = [1, 0, 1, 0, 2];
// Literal expected coordinates after the desktop loader's Y/Z convention.
// The observer parses actual native binary PLY independently of app loading.
const positions = [[-.75, -.2, -.1], [-.4, .2, -.05], [0, -.3, .1], [.4, .3, -.15], [.75, -.1, .15]];
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.snapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());

async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page);
    return { busy: value.busy, recovery: value.recovery, renderer: value.rendererState,
      authoritative: typeof value.authoritativeWorker === 'number' };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready', authoritative: true });
}
async function command(page: Page, value: SceneCommand): Promise<Snapshot> {
  await page.evaluate(value => window.operationHarness.command(value), value); await settled(page); return snapshot(page);
}
function oracle(value: Snapshot, before: Snapshot, expectedMasks = masks, dx = 0) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, count: 5, sourceCount: 5, shDegree: 3,
    pending: false, transaction: false, selectionDraft: false });
  expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  expect(value.packed).toEqual(value.gpu.data); expect(value.resources.work).toBe(0);
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.sourceName).toBe(before.sourceName);
  expect(value.document.documentId).toBe(before.document.documentId);
  expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.camera).toEqual(before.camera);
  expect(value.checkpoint?.binding.source).toEqual(before.checkpoint?.binding.source);
  expect(value.checkpoint?.binding.subset).toEqual(before.checkpoint?.binding.subset);
  expect(value.checkpoint?.binding.core).toEqual(before.checkpoint?.binding.core);
  const packed = new DataView(Uint8Array.from(value.packed).buffer);
  positions.forEach((point, id) => {
    const delta = id === 4 ? 0 : dx;
    expect([0, 4, 8].map(axis => packed.getFloat32(id * value.stride + axis, true)))
      .toEqual(point.map((coordinate, axis) => Math.fround(Math.fround(coordinate) + (axis === 0 ? delta : 0))));
    expect(value.packed.slice(id * value.stride + 12, (id + 1) * value.stride))
      .toEqual(before.packed.slice(id * before.stride + 12, (id + 1) * before.stride));
  });
  // Check every SH3 field of every output record in all three native scopes.
  // GPU equality alone would not detect discarded high SH coefficients.
  const original = before.sourceOutput, x = original.properties.indexOf('x');
  expect(original.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45); expect(x).toBeGreaterThanOrEqual(0);
  value.outputs.forEach((output, scope) => {
    const ids = expectedMasks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output).not.toBeNull(); expect(output!.properties).toEqual(original.properties); expect(output!.records).toHaveLength(ids.length);
    output!.records.forEach((record, index) => {
      const id = ids[index], baseline = original.records.find(row => row[x] === Math.fround(positions[id][0]));
      expect(baseline).toBeDefined();
      expect(record).toEqual(baseline!.map((field, property) => property === x ? Math.fround(field + (id === 4 ? 0 : dx)) : field));
    });
  });
}
function predecessor(value: Snapshot, before: Snapshot) {
  oracle(value, before);
  expect(value.outputs).toEqual(before.outputs); expect(value.packed).toEqual(before.packed);
  expect(value.summary).toMatchObject({ revision: before.summary.revision, contentRevision: before.summary.contentRevision,
    selected: before.summary.selected, visible: before.summary.visible, canUndo: true, canRedo: true });
}
function replaced(value: Snapshot, before: Snapshot, evidence: Trace) {
  expect(value.authoritativeWorker).not.toBe(before.authoritativeWorker);
  expect(value.clientGeneration).not.toBe(before.clientGeneration);
  expect(value.document.documentId).toBe(before.document.documentId);
  expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.scene).not.toBe(before.scene);
  expect(value.resources.scenes.find(scene => scene.id === before.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  const old = evidence.workers.find(worker => worker.id === before.authoritativeWorker);
  expect(old).toMatchObject({ injectedFailures: 1 }); expect(old!.terminated).toBeGreaterThanOrEqual(1);
  expect(evidence.workers.filter(worker => worker.injectedFailures > 0)).toHaveLength(1);
  const restores = evidence.requests.filter(request => request.type === 'recovery-restore' && request.forwarded);
  expect(restores).toHaveLength(1); expect(restores[0].worker).toBe(value.authoritativeWorker);
  expect(restores[0].data.binding).toMatchObject({ source: before.sourceFingerprint, subset: before.checkpoint!.binding.subset,
    core: before.checkpoint!.binding.core, revision: { documentId: before.document.documentId, sourceGeneration: before.document.sourceGeneration } });
  expect(evidence.responses.filter(response => response.type === 'recovery-result' && response.data.action === 'restore' && response.delivered)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.worker === value.authoritativeWorker && request.type === 'command' && request.command === 'transform')).toHaveLength(0);
}
async function crash(page: Page, before: Snapshot) {
  await page.evaluate(id => window.operationHarness.failWorker(id), before.authoritativeWorker); await settled(page);
}
async function history(page: Page, before: Snapshot, committed: boolean) {
  // Traverse the complete restored graph, including the pre-existing Redo.
  const prior = [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]];
  for (const current of committed ? [masks, ...prior] : prior) oracle(await command(page, { command: 'undo' }), before, current);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const current of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks])
    oracle(await command(page, { command: 'redo' }), before, current);
  const last = await command(page, { command: 'redo' });
  oracle(last, before, committed ? masks : [1, 1, 1, 0, 2], committed ? .125 : 0);
  expect(last.summary.canRedo).toBe(false);
}
async function start(page: Page, configuration: WireFaults) {
  await page.evaluate(configuration => {
    window.operationHarness.wireFaults(configuration);
    window.operationHarness.start(window.operationHarness.translation());
  }, configuration);
}
async function heldResponse(page: Page, type: string) {
  await expect.poll(async () => (await trace(page)).responses.some(response => response.type === type && !response.delivered)).toBe(true);
}
async function heldRequest(page: Page, type: string, action?: string) {
  await expect.poll(async () => (await trace(page)).requests.some(request => request.type === type &&
    (action === undefined || request.action === action) && !request.forwarded)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load()); await settled(page);
});

test('actual quiescent worker termination reconstructs edited SH3 bytes, deleted masks and the complete Undo/Redo graph', async ({ page }) => {
  const before = await snapshot(page); expect(before.checkpoint).not.toBeNull(); expect(before.summary.canRedo).toBe(true);
  await crash(page, before); const after = await snapshot(page), evidence = await trace(page);
  predecessor(after, before); replaced(after, before, evidence);
  expect(after.document).toEqual(before.document);
  expect(after.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
  expect(evidence.requests.filter(request => request.type === 'operation')).toHaveLength(0);
  await history(page, before, false);
});

test('actual worker termination cancels an unfinished real selection draft and retains accepted history plus Redo', async ({ page }) => {
  const before = await snapshot(page), draft = await page.evaluate(() => window.operationHarness.unfinishedDraft());
  expect(draft.selectionActive).toBe(true); expect(draft.summary).toMatchObject({ selectionDraft: true, selected: 3 });
  expect(draft.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
  expect((await page.evaluate(() => window.operationHarness.gpu())).masks).toEqual([1, 1, 1, 0, 2]);
  // Separate traces for the accepted history and for the physical worker loss.
  await page.evaluate(() => window.operationHarness.clear());
  await crash(page, before); const after = await snapshot(page), evidence = await trace(page);
  predecessor(after, before); replaced(after, before, evidence);
  expect(after.selectionActive).toBe(false); expect(after.selectionRecovery).toBe('idle'); expect(after.document.draftRevision).toBe(0);
  expect(after.document.selectionRevision).toBeGreaterThan(draft.document.selectionRevision);
  expect(evidence.requests.filter(request => request.type === 'command' && request.command === 'cancelSelection')).toHaveLength(0);
  await history(page, before, false);
});

for (const phase of ['recovery-plan', 'recovery-chunk'] as const) {
  test(`termination before external acceptance at a held ${phase} restores the predecessor without replaying the edit`, async ({ page }) => {
    const before = await snapshot(page);
    await start(page, [{ direction: 'response', type: phase, effect: 'hold' }]); await heldResponse(page, phase);
    const preparing = await state(page); expect(preparing.busy).toBe(true);
    expect(preparing.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
    expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
    await crash(page, before); expect(await page.evaluate(() => window.operationHarness.join())).toBe(false);
    const after = await snapshot(page), evidence = await trace(page); predecessor(after, before); replaced(after, before, evidence);
    expect(evidence.requests.filter(request => request.type === 'command' && request.command === 'transform' && request.forwarded)).toHaveLength(1);
    expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'commit' && request.forwarded)).toHaveLength(0);
    expect(after.checkpoint!.rootSha256).toBe(before.checkpoint!.rootSha256);
    const held = evidence.responses.findIndex(response => response.type === phase && !response.delivered);
    await page.evaluate(index => window.operationHarness.release(index, 2), held);
    const late = await snapshot(page); expect(late.document).toEqual(after.document); expect(late.outputs).toEqual(after.outputs); expect(late.gpu).toEqual(after.gpu);
    await history(page, before, false);
  });
}

for (const phase of ['release', 'commit'] as const) {
  test(`termination after accepted external decision at held ${phase} dispatch reconstructs its successor exactly once`, async ({ page }) => {
    const before = await snapshot(page);
    const type = phase === 'release' ? 'recovery-release' : 'operation';
    await start(page, [{ direction: 'request', type, ...(phase === 'commit' ? { action: 'commit' as const } : {}), effect: 'hold' }]);
    await heldRequest(page, type, phase === 'commit' ? 'commit' : undefined);
    const decided = await state(page); expect(decided.checkpoint!.rootSha256).not.toBe(before.checkpoint!.rootSha256);
    expect(decided.busy).toBe(true); expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
    await crash(page, before); expect(await page.evaluate(() => window.operationHarness.join())).toBe(true);
    const after = await snapshot(page), evidence = await trace(page); oracle(after, before, masks, .125); replaced(after, before, evidence);
    expect(after.checkpoint!.rootSha256).toBe(decided.checkpoint!.rootSha256);
    expect(after.summary).toMatchObject({ canUndo: true, canRedo: false });
    expect(evidence.requests.filter(request => request.type === 'command' && request.command === 'transform' && request.forwarded)).toHaveLength(1);
    expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'commit' && request.forwarded)).toHaveLength(0);
    expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'rollback' && request.forwarded)).toHaveLength(0);
    await history(page, before, true);
  });
}

test('termination after real native commit with its ACK held restores the decided successor and ignores late old-generation terminals', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', type: 'operation-result', action: 'commit', effect: 'hold' }]);
  await heldResponse(page, 'operation-result'); const held = await trace(page);
  const terminal = held.responses.findIndex(response => response.type === 'operation-result' && response.action === 'commit' && !response.delivered);
  expect(terminal).toBeGreaterThanOrEqual(0);
  expect(held.responses[terminal].data.receipt).toMatchObject({ outcome: 'committed' });
  expect(held.responses[terminal].data.summary).toMatchObject({ transaction: false });
  const decided = await state(page); expect(decided.checkpoint!.rootSha256).not.toBe(before.checkpoint!.rootSha256);
  expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
  await crash(page, before); expect(await page.evaluate(() => window.operationHarness.join())).toBe(true);
  const after = await snapshot(page), evidence = await trace(page); oracle(after, before, masks, .125); replaced(after, before, evidence);
  expect(evidence.requests.filter(request => request.type === 'command' && request.command === 'transform' && request.forwarded)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'commit' && request.forwarded)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'operation' && request.action === 'rollback' && request.forwarded)).toHaveLength(0);
  await page.evaluate(index => window.operationHarness.release(index, 2), terminal);
  const late = await snapshot(page); expect(late.document).toEqual(after.document); expect(late.outputs).toEqual(after.outputs); expect(late.gpu).toEqual(after.gpu);
  await history(page, before, true);
});
