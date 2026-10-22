import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';
import type { SceneCommand } from '../src/document/types';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['snapshot']>>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
type Fault = Parameters<Window['operationHarness']['start']>[1];
const baselineMasks = [1, 0, 1, 0, 2];
const sourcePositions = [[-.75, -.2, -.1], [-.4, .2, -.05], [0, -.3, .1], [.4, .3, -.15], [.75, -.1, .15]];
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.snapshot());
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
function recovery(value: Awaited<ReturnType<typeof state>>) {
  return value.recovery;
}
async function settled(page: Page) {
  await expect.poll(async () => ({ busy: (await state(page)).busy, recovery: recovery(await state(page)) }))
    .toEqual({ busy: false, recovery: 'idle' });
}
async function waitResponse(page: Page, action: 'begin' | 'commit' | 'rollback' | 'status' | 'retire', delivered = false) {
  await expect.poll(async () => (await trace(page)).responses.filter(value => value.action === action && value.delivered === delivered).length).toBeGreaterThan(0);
}
async function waitRequest(page: Page, action: 'begin' | 'commit', forwarded = false) {
  await expect.poll(async () => (await trace(page)).requests.filter(value => value.action === action && value.forwarded === forwarded).length).toBe(1);
}
async function expire(page: Page, kind: 'ack' | 'reconcile' = 'ack') {
  const name = kind === 'ack' ? 'operationAcknowledgementExpired' : 'operationReconciliationExpired';
  await expect.poll(async () => (await trace(page)).timers.some(value => value.name === name && value.armed)).toBe(true);
  await page.evaluate(kind => window.operationHarness.expire(kind), kind);
}
async function start(page: Page, faults: Fault, command?: SceneCommand) {
  await page.evaluate(({ faults, command }) => window.operationHarness.start(command ?? window.operationHarness.translation(), faults), { faults, command });
}
async function join(page: Page, accepted: boolean) {
  expect(await page.evaluate(() => window.operationHarness.join())).toBe(accepted); await settled(page); return snapshot(page);
}
async function command(page: Page, value: SceneCommand) {
  await page.evaluate(value => window.operationHarness.command(value), value); await settled(page); return snapshot(page);
}
function mirrors(value: Snapshot) {
  expect(value.packed).toEqual(value.gpu.data); expect(value.masks).toEqual(value.gpu.masks);
  expect(value.resources.work).toBe(0);
  expect(value.summary).toMatchObject({ pending: false, transaction: false, selectionDraft: false, count: 5, shDegree: 3 });
}
function oracle(value: Snapshot, before: Snapshot, masks: number[], dx = 0) {
  mirrors(value); expect(value.masks).toEqual(masks);
  expect(value.sourceFingerprint).toEqual(before.sourceFingerprint); expect(value.sourceName).toBe(before.sourceName);
  expect(value.document.documentId).toBe(before.document.documentId); expect(value.document.sourceGeneration).toBe(before.document.sourceGeneration);
  expect(value.camera).toEqual(before.camera);
  const packed = new DataView(Uint8Array.from(value.packed).buffer), old = new DataView(Uint8Array.from(before.packed).buffer);
  sourcePositions.forEach((position, id) => {
    const delta = id === 4 ? 0 : dx;
    expect([0, 4, 8].map(axis => packed.getFloat32(id * value.stride + axis, true)))
      .toEqual(position.map((coordinate, axis) => Math.fround(Math.fround(coordinate) + (axis === 0 ? delta : 0))));
    expect(value.packed.slice(id * value.stride + 12, (id + 1) * value.stride))
      .toEqual(before.packed.slice(id * before.stride + 12, (id + 1) * before.stride));
    expect(old.getFloat32(id * before.stride, true)).toBe(Math.fround(position[0]));
  });
  const original = before.sourceOutput;
  expect(original.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  const x = original.properties.indexOf('x'); expect(x).toBeGreaterThanOrEqual(0);
  value.outputs.forEach((output, scope) => {
    const ids = masks.flatMap((mask, id) => !(mask & 2) && (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output).not.toBeNull(); expect(output!.properties).toEqual(original.properties); expect(output!.records).toHaveLength(ids.length);
    output!.records.forEach((record, index) => {
      const id = ids[index], base = original.records.find(row => row[x] === Math.fround(sourcePositions[id][0]));
      expect(base).toBeDefined();
      expect(record).toEqual(base!.map((field, property) => property === x ? Math.fround(field + (id === 4 ? 0 : dx)) : field));
    });
  });
}
function retained(value: Snapshot, before: Snapshot, exactRevisions = true) {
  oracle(value, before, baselineMasks);
  expect(value.outputs).toEqual(before.outputs); expect(value.packed).toEqual(before.packed);
  expect(value.summary).toMatchObject({ selected: before.summary.selected, visible: before.summary.visible,
    ...(exactRevisions ? { revision: before.summary.revision, contentRevision: before.summary.contentRevision } : {}),
    canUndo: before.summary.canUndo, canRedo: before.summary.canRedo });
}
function requestsFor(value: Trace, action: string) { return value.requests.filter(request => request.type === 'operation' && request.action === action); }
function mutations(value: Trace, name: string) { return value.requests.filter(request => request.type === 'command' && request.command === name && request.forwarded); }
function singleMutation(value: Trace, name = 'transform') {
  expect(mutations(value, name)).toHaveLength(1);
  const begun = requestsFor(value, 'begin'); expect(begun).toHaveLength(1);
  const owners = value.requests.filter(request => request.type === 'operation').map(request => request.data.operationOwner);
  expect(owners.length).toBeGreaterThan(1); owners.forEach(owner => expect(owner).toEqual(owners[0]));
  expect(value.workers.filter(worker => worker.terminated > 0)).toHaveLength(0);
}
// Traverse every available item, not merely one enabled Undo/Redo button. The
// exact seed has four accepted past items and one future Add(id1) item.
async function history(page: Page, before: Snapshot, committed: boolean) {
  await page.evaluate(() => window.operationHarness.clear());
  const prior = [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]];
  const undone = committed ? [baselineMasks, ...prior] : prior;
  for (const masks of undone) oracle(await command(page, { command: 'undo' }), before, masks);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  const forward = [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], baselineMasks];
  for (const masks of forward) oracle(await command(page, { command: 'redo' }), before, masks);
  const last = await command(page, { command: 'redo' });
  oracle(last, before, committed ? baselineMasks : [1, 1, 1, 0, 2], committed ? .125 : 0);
  expect(last.summary.canRedo).toBe(false);
  if (!committed) retained(await command(page, { command: 'undo' }), before, false);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load()); await settled(page);
});

test('a genuinely executed commit with lost acknowledgement reconciles once and ignores late duplicate native terminals', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }]); await waitResponse(page, 'commit');
  const held = await state(page); expect(held.scene).toBe(before.scene); expect(held.busy).toBe(true);
  expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
  expect(held.resources.work).toBeGreaterThan(0);
  expect(held.resources.scenes.filter(scene => !scene.current && !scene.retired)).toHaveLength(1);
  await expire(page); const after = await join(page, true); oracle(after, before, baselineMasks, .125);
  expect(after.resources.scenes.find(scene => scene.id === before.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  expect(after.resources.scenes.filter(scene => !scene.retired && scene.current)).toHaveLength(1);
  const evidence = await trace(page); singleMutation(evidence); expect(requestsFor(evidence, 'commit')).toHaveLength(1);
  expect(requestsFor(evidence, 'status')).toHaveLength(1); expect(requestsFor(evidence, 'rollback')).toHaveLength(0);
  const terminal = evidence.responses.findIndex(response => response.action === 'commit' && !response.delivered);
  await page.evaluate(index => window.operationHarness.release(index, 2), terminal);
  const late = await snapshot(page); expect(late).toMatchObject({ document: after.document, scene: after.scene });
  expect(late.outputs).toEqual(after.outputs); expect(late.packed).toEqual(after.packed); expect(late.gpu).toEqual(after.gpu);
  await history(page, before, true);
});

test('a lost real begin acknowledgement rolls back its active native owner without executing the requested mutation', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'begin', effect: 'drop' }]); await waitResponse(page, 'begin');
  await expire(page); retained(await join(page, false), before);
  const evidence = await trace(page); expect(mutations(evidence, 'transform')).toHaveLength(0);
  expect(requestsFor(evidence, 'begin')).toHaveLength(1); expect(requestsFor(evidence, 'status')).toHaveLength(1);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(1); expect(requestsFor(evidence, 'commit')).toHaveLength(0);
  await history(page, before, false);
});

test('a begin never delivered to the genuine worker is proven not-started and its delayed owner cannot create an edit', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'request', action: 'begin', effect: 'drop' }]); await waitRequest(page, 'begin');
  await expire(page); retained(await join(page, false), before);
  const evidence = await trace(page); expect(mutations(evidence, 'transform')).toHaveLength(0);
  expect(requestsFor(evidence, 'status')).toHaveLength(1); expect(requestsFor(evidence, 'commit')).toHaveLength(0);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(0);
  expect(evidence.responses.some(response => response.action === 'status' && JSON.stringify(response.data).includes('not-started'))).toBe(true);
  await history(page, before, false);
});

test('an undelivered commit after external acceptance retries its active native owner once and publishes the decided successor', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'request', action: 'commit', effect: 'drop' }]); await waitRequest(page, 'commit');
  // External acceptance precedes native commit dispatch. Its authenticated
  // successor remains authoritative even when that first dispatch is lost.
  const decided = await state(page);
  expect(decided.checkpoint).not.toBeNull();
  expect(decided.checkpoint!.rootSha256).not.toBe(before.checkpoint!.rootSha256);
  expect(decided.busy).toBe(true); expect(decided.scene).toBe(before.scene);
  expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
  await expire(page); const after = await join(page, true); oracle(after, before, baselineMasks, .125);
  expect(after.checkpoint!.rootSha256).toBe(decided.checkpoint!.rootSha256);
  const evidence = await trace(page); singleMutation(evidence);
  expect(requestsFor(evidence, 'commit').map(request => request.forwarded)).toEqual([false, true]);
  expect(requestsFor(evidence, 'status')).toHaveLength(1); expect(requestsFor(evidence, 'rollback')).toHaveLength(0);
  expect(evidence.responses.find(response => response.action === 'status' && response.delivered)?.data.receipt)
    .toMatchObject({ outcome: 'active' });
  expect(evidence.responses.filter(response => response.action === 'commit' && response.delivered)).toHaveLength(1);
  expect(evidence.responses.find(response => response.action === 'commit' && response.delivered)?.data.receipt)
    .toMatchObject({ outcome: 'committed' });
  await history(page, before, true);
});

test('a genuine completed rollback whose acknowledgement is lost preserves native SH, GPU bytes and executable Redo', async ({ page }) => {
  const before = await snapshot(page); await page.evaluate(() => window.operationHarness.refusePublication());
  await start(page, [{ direction: 'response', action: 'rollback', effect: 'drop' }]); await waitResponse(page, 'rollback');
  await expire(page); retained(await join(page, false), before);
  const evidence = await trace(page); singleMutation(evidence); expect(requestsFor(evidence, 'commit')).toHaveLength(0);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(1); expect(requestsFor(evidence, 'status')).toHaveLength(1);
  await history(page, before, false);
});

test('lost reconciliation retains the prepared owner and reservations, blocks competing work and resolves only on explicit retry', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }, { direction: 'response', action: 'status', effect: 'hold' }]);
  await waitResponse(page, 'commit'); await expire(page); await waitResponse(page, 'status');
  expect(recovery(await state(page))).toBe('checking'); await expire(page, 'reconcile');
  await expect.poll(async () => recovery(await state(page))).toBe('required');
  const required = await state(page); expect(required.finished).toBeNull(); expect(required.scene).toBe(before.scene);
  const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Retry edit recovery', exact: true }) });
  await expect(alert).toHaveCount(1); await expect(alert.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveCount(0);
  await expect(page.locator('.status.panel').getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
  const canvas = page.getByLabel('SplatView scene', { exact: true });
  await expect(canvas).toHaveAttribute('aria-busy', 'true');
  let pickerOpened = false; page.on('filechooser', () => { pickerOpened = true; });
  await canvas.focus();
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${primary}+o`); await page.keyboard.press(`${primary}+s`);
  expect(pickerOpened).toBe(false); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(required.resources.work).toBeGreaterThan(0); expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
  const blocked = await page.evaluate(() => window.operationHarness.blocked());
  expect(blocked.accepted).toBe(false); expect(blocked.captureError).toBeTruthy();
  expect(blocked.after.sourceFingerprint).toEqual(before.sourceFingerprint); expect(blocked.after.sourceName).toBe(before.sourceName);
  expect(blocked.after.document).toEqual(required.document); expect(blocked.after.resources.entries).toEqual(required.resources.entries);
  expect(blocked.after.resources.scenes).toEqual(required.resources.scenes);
  const retry = alert.getByRole('button', { name: 'Retry edit recovery', exact: true });
  await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
  oracle(await join(page, true), before, baselineMasks, .125);
  const evidence = await trace(page); singleMutation(evidence); expect(requestsFor(evidence, 'status')).toHaveLength(2);
  expect(requestsFor(evidence, 'commit')).toHaveLength(1); expect(mutations(evidence, 'selectAll')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'source-load')).toHaveLength(0);
  const late = evidence.responses.findIndex(response => response.action === 'status' && !response.delivered);
  await page.evaluate(index => window.operationHarness.release(index), late); oracle(await snapshot(page), before, baselineMasks, .125);
  await history(page, before, true);
});

test('a genuine status ownership refusal remains unresolved and a bounded explicit retry uses the original owner', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }, { direction: 'request', action: 'status', effect: 'wrong-owner' }]);
  await waitResponse(page, 'commit'); await expire(page);
  await expect.poll(async () => recovery(await state(page))).toBe('required');
  const required = await state(page); expect(required.finished).toBeNull(); expect(required.scene).toBe(before.scene);
  expect(await page.evaluate(() => window.operationHarness.gpu())).toEqual(before.gpu);
  expect(await page.evaluate(() => window.operationHarness.retry())).toBe(true); oracle(await join(page, true), before, baselineMasks, .125);
  const evidence = await trace(page); singleMutation(evidence); expect(requestsFor(evidence, 'status')).toHaveLength(2);
  expect(requestsFor(evidence, 'status').map(request => request.altered)).toEqual([true, false]);
  expect(evidence.responses.some(response => response.action === 'status' &&
    (response.type === 'error' || JSON.stringify(response.data).includes('expired-conflict')))).toBe(true);
  await history(page, before, true);
});

test('device loss after genuine commit execution preserves commit proof and rebuilds the same authoritative edit', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }]); await waitResponse(page, 'commit');
  await page.evaluate(() => window.operationHarness.loseDevice()); await expire(page);
  await expect.poll(async () => (await state(page)).finished).not.toBeNull();
  const lost = await state(page); expect(lost.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(await page.evaluate(() => window.operationHarness.recoverGraphics())).toBe(true); await settled(page);
  const after = await snapshot(page); oracle(after, before, baselineMasks, .125); expect(after.deviceEpoch).not.toBe(before.deviceEpoch);
  const evidence = await trace(page); singleMutation(evidence); expect(requestsFor(evidence, 'commit')).toHaveLength(1);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(0);
  await history(page, before, true);
});

test('lost no-op and selection-only commits use native receipts despite unchanged scene content revisions', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }], { command: 'single', index: 0, operation: 1 });
  await waitResponse(page, 'commit'); await expire(page); const noOp = await join(page, true); retained(noOp, before);
  singleMutation(await trace(page), 'single'); await history(page, before, false);
  const selectionBaseline = await snapshot(page);
  await page.evaluate(() => window.operationHarness.clear());
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }], { command: 'single', index: 1, operation: 1 });
  await waitResponse(page, 'commit'); await expire(page); const selected = await join(page, true);
  oracle(selected, before, [1, 1, 1, 0, 2]); expect(selected.summary.contentRevision).toBe(selectionBaseline.summary.contentRevision);
  expect(selected.summary.canRedo).toBe(false); singleMutation(await trace(page), 'single');
  retained(await command(page, { command: 'undo' }), before, false);
  oracle(await command(page, { command: 'redo' }), before, [1, 1, 1, 0, 2]);
});

test('lost Undo and Redo commit acknowledgements move the existing history once instead of appending an edit', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }], { command: 'undo' });
  await waitResponse(page, 'commit'); await expire(page); oracle(await join(page, true), before, [1, 0, 0, 0, 2]);
  singleMutation(await trace(page), 'undo'); await page.evaluate(() => window.operationHarness.clear());
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' }], { command: 'redo' });
  await waitResponse(page, 'commit'); await expire(page); retained(await join(page, true), before, false); singleMutation(await trace(page), 'redo');
  await history(page, before, false);
});

test('Retry reconciles a lost retirement acknowledgement before graphics restoration joins the known committed edit', async ({ page }) => {
  const before = await snapshot(page);
  await start(page, [{ direction: 'response', action: 'commit', effect: 'drop' },
    { direction: 'response', action: 'retire', effect: 'drop', remaining: 2 }]);
  await waitResponse(page, 'commit'); await page.evaluate(() => window.operationHarness.loseDevice());
  await expire(page); await waitResponse(page, 'retire');
  // The first native retirement already executed. Lose its bounded automatic
  // idempotent retry too, so the actual controller continuation remains parked.
  await expire(page);
  await expect.poll(async () => (await trace(page)).responses.filter(response => response.action === 'retire' && !response.delivered).length).toBe(2);
  await expire(page, 'reconcile'); await expect.poll(async () => recovery(await state(page))).toBe('required');
  expect((await state(page)).finished).toBeNull();
  const retry = page.getByRole('button', { name: 'Retry edit recovery', exact: true });
  await expect(page.getByRole('alert').filter({ has: retry })).toContainText('The edit is committed. Restore graphics to continue.');
  await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter');
  await expect.poll(async () => (await state(page)).finished).toBe(true);
  expect(await page.evaluate(() => window.operationHarness.join())).toBe(true);
  const resolved = await state(page);
  // A real device-loss restoration may already be waiting on edit.finished.
  // Join it when present; otherwise the next explicit Retry restores graphics.
  if (resolved.rendererState === 'recovering') {
    expect(await page.evaluate(() => window.operationHarness.recoverGraphics())).toBe(true);
  } else if (resolved.rendererState === 'unavailable' && recovery(resolved) === 'required') {
    await retry.focus(); await retry.press('Enter');
  }
  await settled(page); const after = await snapshot(page); oracle(after, before, baselineMasks, .125);
  expect(after.deviceEpoch).not.toBe(before.deviceEpoch);
  const evidence = await trace(page); singleMutation(evidence);
  expect(requestsFor(evidence, 'commit')).toHaveLength(1); expect(requestsFor(evidence, 'status')).toHaveLength(1);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(0); expect(requestsFor(evidence, 'retire')).toHaveLength(3);
  expect(evidence.responses.filter(response => response.action === 'retire' && response.delivered)).toHaveLength(1);
  await history(page, before, true);
});

test('a staged mask publication refusal after real native commit retains proof and rebuilds the selected edit once', async ({ page }) => {
  const before = await snapshot(page), selectedMasks = [1, 1, 1, 0, 2];
  await page.evaluate(() => window.operationHarness.refuseMaskPublication());
  await start(page, [], { command: 'single', index: 1, operation: 1 });
  await expect.poll(async () => (await state(page)).finished).toBe(false);
  expect(await page.evaluate(() => window.operationHarness.join())).toBe(false);
  const required = await state(page);
  expect(recovery(required)).toBe('required'); expect(required.recoveryCommitted).toBe(true);
  expect(required.maskPublication).toMatchObject({ calls: 1, afterCommit: true });
  const retry = page.getByRole('button', { name: 'Retry edit recovery', exact: true });
  const alert = page.getByRole('alert').filter({ has: retry });
  await expect(alert).toContainText('The edit is committed. Restore graphics to continue.');
  await expect(alert).not.toContainText('The edit result is unknown.');
  await expect(alert.getByRole('button', { name: 'Dismiss error', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('SplatView scene', { exact: true })).toHaveAttribute('aria-busy', 'true');
  // The native operation is known and retired, so genuine inspection is safe.
  // Its new selection must remain distinct from the retained old GPU mirror.
  const known = await snapshot(page);
  expect(known.masks).toEqual(selectedMasks); expect(known.summary).toMatchObject({ selected: 3, visible: 4, canUndo: true, canRedo: false });
  expect(known.packed).toEqual(before.packed); expect(known.outputs[0]).toEqual(before.outputs[0]);
  expect(known.gpu).toEqual(before.gpu); expect(known.scene).toBe(before.scene);
  const blocked = await page.evaluate(() => window.operationHarness.blocked());
  expect(blocked.accepted).toBe(false); expect(blocked.captureError).toBeTruthy();
  expect(blocked.after.document).toEqual(required.document); expect(blocked.after.sourceFingerprint).toEqual(before.sourceFingerprint);
  await retry.focus(); await expect(retry).toBeFocused(); await retry.press('Enter'); await settled(page);
  const after = await snapshot(page); oracle(after, before, selectedMasks);
  expect(after.recoveryCommitted).toBe(false); expect(after.outputs).toEqual(known.outputs); expect(after.masks).toEqual(known.masks);
  expect(after.deviceEpoch).not.toBe(before.deviceEpoch);
  expect(after.maskPublication).toMatchObject({ calls: 1, afterCommit: true });
  const evidence = await trace(page); singleMutation(evidence, 'single');
  expect(requestsFor(evidence, 'begin')).toHaveLength(1); expect(requestsFor(evidence, 'commit')).toHaveLength(1);
  expect(requestsFor(evidence, 'rollback')).toHaveLength(0); expect(requestsFor(evidence, 'status')).toHaveLength(0);
  expect(requestsFor(evidence, 'retire')).toHaveLength(1);
  expect(evidence.responses.find(response => response.action === 'commit')!.data.receipt)
    .toMatchObject({ owner: after.maskPublication!.owner, outcome: 'committed' });
  // The new selection consumes the old Redo and contributes one logical item.
  const past = [baselineMasks, [1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]];
  for (const masks of past) oracle(await command(page, { command: 'undo' }), before, masks);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const masks of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], baselineMasks, selectedMasks])
    oracle(await command(page, { command: 'redo' }), before, masks);
  expect((await snapshot(page)).summary.canRedo).toBe(false);
});
