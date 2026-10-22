import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';
import { NEUTRAL_COLOR, type SceneCommand } from '../src/document/types';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['toolSnapshot']>>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
const masks = [1, 0, 1, 0, 2];
const positions = [-.75, -.4, 0, .4, .75];
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const tools = (page: Page) => page.evaluate(() => window.operationHarness.toolState());
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.toolSnapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page), tool = await tools(page);
    return { busy: value.busy, recovery: value.recovery, renderer: value.rendererState,
      transform: tool.transformPending, opacity: tool.opacityPending };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready', transform: false, opacity: false });
}
async function command(page: Page, value: SceneCommand) {
  await page.evaluate(value => window.operationHarness.command(value), value); await settled(page); return snapshot(page);
}
function nativeExportMatches(value: Snapshot) {
  if (!value.outputsAvailable) {
    // Native transform/opacity owners deliberately fence export until an
    // explicit owner end. The complete accepted native scene remains readable.
    expect(value.outputs).toEqual([null, null, null]); return;
  }
  const half = (bits: number) => {
    const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023;
    expect(exponent).toBeLessThan(31);
    return sign * (exponent ? 2 ** (exponent - 15) * (1 + fraction / 1024) : 2 ** -14 * fraction / 1024);
  };
  // Parity of real SH basis polynomials for a 180-degree rotation about X
  // (the viewer RUB to exported PLY RDF convention), coefficient order 1..15.
  const parity = [-1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, -1, 1, -1, 1];
  value.outputs.forEach((output, scope) => {
    const records = value.nativeScene.scopes[scope];
    if (!records.length) { expect(output).toBeNull(); return; }
    expect(output).not.toBeNull(); expect(output!.records).toHaveLength(records.length);
    expect(output!.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
    records.forEach((bytes, index) => {
      const view = new DataView(Uint8Array.from(bytes).buffer), row = output!.records[index];
      ['x', 'y', 'z'].forEach((name, axis) => expect(row[output!.properties.indexOf(name)])
        .toBe(view.getFloat32(axis * 4, true) * (axis ? -1 : 1)));
      for (let channel = 0; channel < 3; channel++) {
        expect(row[output!.properties.indexOf(`f_dc_${channel}`)]).toBe(half(view.getUint16(48 + channel * 2, true)));
        for (let coefficient = 1; coefficient < 16; coefficient++)
          expect(row[output!.properties.indexOf(`f_rest_${channel * 15 + coefficient - 1}`)])
            .toBe(half(view.getUint16(48 + (coefficient * 3 + channel) * 2, true)) * parity[coefficient - 1]);
      }
      const alpha = view.getFloat32(12, true);
      expect(row[output!.properties.indexOf('opacity')]).toBeCloseTo(Math.log(alpha / (1 - alpha)), 5);
    });
  });
}
function exactNative(value: Snapshot, expected: Snapshot) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    pending: false, transaction: false, selectionDraft: false, selected: expected.summary.selected, visible: expected.summary.visible });
  expect(value.summary.alignment).toEqual(expected.summary.alignment);
  expect(value.sourceFingerprint).toEqual(expected.sourceFingerprint); expect(value.sourceName).toBe(expected.sourceName);
  expect(value.document.documentId).toBe(expected.document.documentId);
  expect(value.document.sourceGeneration).toBe(expected.document.sourceGeneration);
  expect(value.masks).toEqual(expected.masks); expect(value.gpu.masks).toEqual(expected.masks);
  expect(value.packed).toEqual(expected.packed);
  // Independent checkpoint observation covers all144 native Gaussian bytes,
  // including all48 SH half words and reserved covariance bytes. It is bound
  // to the live stream in the harness, separately from GPU/base observations.
  expect(value.nativeScene.records).toEqual(expected.nativeScene.records);
  expect(value.nativeScene.scopes).toEqual(expected.nativeScene.scopes);
  if (value.outputsAvailable && expected.outputsAvailable) expect(value.outputs).toEqual(expected.outputs);
  nativeExportMatches(value); expect(value.resources.work).toBe(0);
}
function sourceWithMasks(value: Snapshot, baseline: Snapshot, expectedMasks: number[]) {
  expect(value.packed).toEqual(baseline.packed); expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  expect(value.nativeScene.records).toEqual(baseline.nativeScene.records); expect(value.outputsAvailable).toBe(true);
  const source = baseline.sourceOutput, x = source.properties.indexOf('x');
  value.outputs.forEach((output, scope) => {
    const ids = expectedMasks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output!.properties).toEqual(source.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = source.records.find(record => record[x] === Math.fround(positions[id]));
      expect(record).toBeDefined(); return record;
    }));
  });
  nativeExportMatches(value); expect(value.resources.work).toBe(0);
}
async function completeHistory(page: Page, baseline: Snapshot, edits: Snapshot[]) {
  // Traverse every retained content and selection node, rather than only the
  // last tool edit. The original fixture also includes a deleted splat.
  for (const expected of [...edits.slice(0, -1).reverse(), baseline])
    exactNative(await command(page, { command: 'undo' }), expected);
  for (const expected of [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]])
    sourceWithMasks(await command(page, { command: 'undo' }), baseline, expected);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const expected of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks])
    sourceWithMasks(await command(page, { command: 'redo' }), baseline, expected);
  for (const expected of edits) exactNative(await command(page, { command: 'redo' }), expected);
  expect((await snapshot(page)).summary.canRedo).toBe(false);
}
function replaced(value: Snapshot, accepted: Snapshot, evidence: Trace, canRedo = false) {
  expect(value.authoritativeWorker).not.toBe(accepted.authoritativeWorker);
  expect(value.clientGeneration).not.toBe(accepted.clientGeneration); expect(value.scene).not.toBe(accepted.scene);
  expect(value.document).toEqual(accepted.document);
  expect(value.checkpoint!.rootSha256).toBe(accepted.checkpoint!.rootSha256);
  expect(value.checkpoint!.binding).toEqual(accepted.checkpoint!.binding);
  expect(value.summary).toMatchObject({ revision: accepted.summary.revision, contentRevision: accepted.summary.contentRevision,
    canUndo: true, canRedo });
  expect(value.tools.defaultCamera).toEqual(accepted.tools.defaultCamera);
  expect(value.tools.checkpoints).toEqual(accepted.tools.checkpoints);
  expect(value.resources.scenes.find(scene => scene.id === accepted.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  expect(evidence.workers.find(worker => worker.id === accepted.authoritativeWorker)).toMatchObject({ injectedFailures: 1 });
  expect(evidence.workers.find(worker => worker.id === accepted.authoritativeWorker)!.terminated).toBeGreaterThanOrEqual(1);
  expect(evidence.workers.filter(worker => worker.injectedFailures > 0)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'recovery-restore' && request.forwarded)).toHaveLength(1);
  expect(evidence.responses.filter(response => response.type === 'recovery-result' && response.data.action === 'restore' && response.delivered)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'operation')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'command' &&
    ['grade', 'applyTransform', 'applyOpacity', 'resetTransform', 'resetOpacity'].includes(request.command ?? ''))).toHaveLength(0);
}
async function crash(page: Page, accepted: Snapshot) {
  await page.evaluate(() => window.operationHarness.clear());
  await page.evaluate(id => window.operationHarness.failWorker(id), accepted.authoritativeWorker); await settled(page);
  return snapshot(page);
}
function retainedBase(value: Snapshot, baseline: Snapshot, kind: 'color' | 'transform' | 'opacity') {
  expect(value.bases[kind]).not.toBeNull(); expect(value.bases[kind]!.packed).toEqual(baseline.packed);
  expect(value.bases[kind]!.masks).toEqual(masks); expect(value.gpu.data).toEqual(value.bases[kind]!.packed);
  expect(value.gpu.masks).toEqual(masks); expect(value.packed).not.toEqual(value.gpu.data);
}
function unchangedFields(value: Snapshot, baseline: Snapshot, changed: string[]) {
  const offsets: Record<string, number> = { x: 0, y: 4, z: 8, opacity: 12 };
  const mutable = new Set(changed.flatMap(name => Array.from({ length: 4 }, (_, byte) => offsets[name] + byte)));
  value.nativeScene.records.forEach((record, id) => {
    record.forEach((byte, offset) => { if (!mutable.has(offset)) expect(byte).toBe(baseline.nativeScene.records[id][offset]); });
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load()); await settled(page);
});

test('actual worker recovery discards an unfinished color preview and retains applied SH3 color, Reset and complete history', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'applied-color-unfinished-preview-actual-worker-termination' };
  try {
    const baseline = await snapshot(page); report.baseline = baseline;
    const firstValues = [...NEUTRAL_COLOR]; firstValues[0] = Math.fround(1.2);
    await page.evaluate(values => window.operationHarness.previewColor(values), firstValues);
    await page.evaluate(() => window.operationHarness.applyColor()); await settled(page); const first = await snapshot(page);
    const applied = [...NEUTRAL_COLOR]; applied[0] = 1.5;
    await page.evaluate(values => window.operationHarness.previewColor(values), applied);
    await page.evaluate(() => window.operationHarness.applyColor()); await settled(page); const accepted = await snapshot(page); report.accepted = accepted;
    expect(first.outputs).not.toEqual(baseline.outputs); expect(accepted.outputs).not.toEqual(first.outputs);
    expect(accepted.summary.colorSession!.baseId).toBe(first.summary.colorSession!.baseId);
    expect(accepted.tools.grade).toEqual(applied); expect(accepted.tools.appliedGrade).toEqual(applied);
    retainedBase(accepted, baseline, 'color');
    const preview = [...applied]; preview[0] = 1.75;
    await page.evaluate(values => window.operationHarness.previewColor(values), preview);
    const unfinished = await snapshot(page); report.unfinished = unfinished;
    exactNative(unfinished, accepted); expect(unfinished.tools.colorPending).toBe(true); expect(unfinished.tools.grade).toEqual(preview);
    const camera = await page.evaluate(() => window.operationHarness.navigateToolCamera());
    const restored = await crash(page, accepted); report.restored = restored; report.recoveryTrace = await trace(page);
    exactNative(restored, accepted); replaced(restored, accepted, await trace(page)); retainedBase(restored, baseline, 'color');
    // This assertion specifically rejects carrying the discarded main-thread
    // preview B onto reconstructed native A. GPU-only recovery has a different
    // contract and is covered by the existing color/graphics tests.
    expect(restored.tools.grade).toEqual(applied); expect(restored.tools.appliedGrade).toEqual(applied);
    expect(restored.tools.colorPending).toBe(false); expect(restored.tools.colorResetEnabled).toBe(true);
    expect(restored.tools.colorSession).toEqual(accepted.tools.colorSession);
    expect(restored.camera).toEqual(camera); expect(restored.tools.background).toBe('white');
    await page.evaluate(() => window.operationHarness.resetColor()); await settled(page); const reset = await snapshot(page); report.reset = reset;
    exactNative(reset, baseline); expect(reset.tools.grade).toEqual(NEUTRAL_COLOR); expect(reset.tools.colorPending).toBe(false);
    await completeHistory(page, baseline, [first, accepted, reset]); report.historyVerified = true;
  } finally {
    report.finalState = await state(page).catch(error => ({ error: String(error) })); report.finalWire = await trace(page).catch(error => ({ error: String(error) }));
    await info.attach('worker-color-tools-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
  }
});

test('actual worker recovery restores applied numeric affine parameters and discards unfinished values before native Reset and complete history', async ({ page }, info) => {
  const report: Record<string, unknown> = { scenario: 'applied-numeric-transform-unfinished-preview-actual-worker-termination' };
  try {
    const baseline = await snapshot(page); report.baseline = baseline;
    const matrix = [1, 0, 0, .125, 0, 1, 0, -.25, 0, 0, 1, .5, 0, 0, 0, 1] as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number];
    await page.evaluate(matrix => window.operationHarness.previewTransform({ mode: 'matrix', matrix }), matrix); await settled(page);
    await page.evaluate(() => window.operationHarness.applyTransform()); await settled(page); const accepted = await snapshot(page); report.accepted = accepted;
    retainedBase(accepted, baseline, 'transform'); expect(accepted.tools.transform!.dirty).toBe(false);
    unchangedFields(accepted, baseline, ['x', 'y', 'z']);
    accepted.nativeScene.records.forEach((record, id) => {
      const before = new DataView(Uint8Array.from(baseline.nativeScene.records[id]).buffer), after = new DataView(Uint8Array.from(record).buffer);
      for (let axis = 0; axis < 3; axis++) expect(after.getFloat32(axis * 4, true))
        .toBe(Math.fround(before.getFloat32(axis * 4, true) + (masks[id] & 1 ? [.125, -.25, .5][axis] : 0)));
    });
    const unfinishedMatrix = [...matrix] as typeof matrix; unfinishedMatrix[3] = .75;
    await page.evaluate(matrix => window.operationHarness.previewTransform({ matrix }), unfinishedMatrix); await settled(page);
    const unfinished = await snapshot(page); report.unfinished = unfinished; exactNative(unfinished, accepted);
    expect(unfinished.tools.transformDirty).toBe(true); expect(unfinished.tools.transformPreview!.matrix).not.toEqual(accepted.tools.transformPreview!.matrix);
    const camera = await page.evaluate(() => window.operationHarness.navigateToolCamera());
    const restored = await crash(page, accepted); report.restored = restored; report.recoveryTrace = await trace(page);
    exactNative(restored, accepted); replaced(restored, accepted, await trace(page)); retainedBase(restored, baseline, 'transform');
    expect(restored.tools.transform).toMatchObject({ kind: 'numeric', dirty: false, phase: 'ready',
      id: accepted.tools.transform!.id, baseId: accepted.tools.transform!.baseId, selectedOnly: true });
    expect(restored.tools.transformDirty).toBe(false); expect(restored.tools.transformResetEnabled).toBe(true);
    expect(restored.tools.transformPreview).toEqual(accepted.tools.transformPreview);
    expect(restored.tools.transformParameters.mode).toBe('matrix');
    expect(restored.tools.transformParameters.matrix).toEqual(matrix);
    expect(restored.camera).toEqual(camera); expect(restored.tools.background).toBe('white');
    await page.evaluate(() => window.operationHarness.resetTransform()); await settled(page); const reset = await snapshot(page); report.reset = reset;
    exactNative(reset, baseline); await completeHistory(page, baseline, [accepted, reset]); report.historyVerified = true;
  } finally {
    report.finalState = await state(page).catch(error => ({ error: String(error) })); report.finalWire = await trace(page).catch(error => ({ error: String(error) }));
    await info.attach('worker-transform-tools-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
  }
});

// Applied opacity fade/boost recovery is omitted: color.advanced is excluded from web-lite.

// The opacity owner variant is omitted: color.advanced is excluded from web-lite.
for (const kind of ['transform'] as const) {
  test(`actual worker recovery normalizes an unapplied ${kind} owner without inserting history or losing its native Reset`, async ({ page }, info) => {
    const report: Record<string, unknown> = { scenario: 'unapplied-tool-owner-actual-worker-termination', kind };
    try {
      const baseline = await snapshot(page); report.baseline = baseline;
      expect(baseline.summary).toMatchObject({ canUndo: true, canRedo: true });
      await page.evaluate(() => window.operationHarness.previewTransform({ translation: [.25, -.125, .5] }));
      await settled(page); const unfinished = await snapshot(page); report.unfinished = unfinished;
      exactNative(unfinished, baseline); expect(unfinished.tools[`${kind}Dirty`]).toBe(true);
      expect(unfinished.summary[`${kind}Session`]).toMatchObject({ selectedOnly: true, appliedEpoch: null, epoch: 0 });
      expect(unfinished.summary).toMatchObject({ canUndo: true, canRedo: true,
        revision: baseline.summary.revision, contentRevision: baseline.summary.contentRevision });
      expect(unfinished.bases[kind]!.packed).toEqual(baseline.packed);
      const restored = await crash(page, unfinished); report.restored = restored; report.recoveryTrace = await trace(page);
      exactNative(restored, baseline); replaced(restored, unfinished, await trace(page), true);
      expect(restored.summary[`${kind}Session`]).toEqual(unfinished.summary[`${kind}Session`]);
      expect(restored.tools[`${kind}Dirty`]).toBe(false); expect(restored.tools[`${kind}ResetEnabled`]).toBe(true);
      expect(restored.bases[kind]!.packed).toEqual(baseline.packed); expect(restored.gpu.data).toEqual(baseline.packed);
      expect(restored.tools.transformPreview!.matrix).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
      expect(restored.tools.transformParameters.translation).toEqual([0, 0, 0]);
      await page.evaluate(() => window.operationHarness.resetTransform());
      await settled(page); const reset = await snapshot(page); report.reset = reset;
      exactNative(reset, baseline); expect(reset.summary).toMatchObject({ canUndo: true, canRedo: true });
      // Exactly the four original Undo nodes and five original Redo nodes
      // remain. An artificial recovery/Reset node would fail this traversal.
      for (const expected of [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]])
        sourceWithMasks(await command(page, { command: 'undo' }), baseline, expected);
      expect((await snapshot(page)).summary.canUndo).toBe(false);
      for (const expected of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks, [1, 1, 1, 0, 2]])
        sourceWithMasks(await command(page, { command: 'redo' }), baseline, expected);
      expect((await snapshot(page)).summary.canRedo).toBe(false);
      exactNative(await command(page, { command: 'undo' }), baseline); report.historyVerified = true;
    } finally {
      report.finalState = await state(page).catch(error => ({ error: String(error) })); report.finalWire = await trace(page).catch(error => ({ error: String(error) }));
      await info.attach('worker-unapplied-tools-evidence.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify(report, null, 2)) });
    }
  });
}
