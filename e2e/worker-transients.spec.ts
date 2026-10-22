import { expect, test, type Page } from '@playwright/test';
import type {} from './operation-harness';
import type { SceneCommand } from '../src/document/types';

type Snapshot = Awaited<ReturnType<Window['operationHarness']['toolSnapshot']>>;
type Trace = ReturnType<Window['operationHarness']['trace']>;
const masks = [1, 0, 1, 0, 2];
// Literal world positions after the desktop PLY loader's Y/Z convention.
const positions = [[-.75, -.2, -.1], [-.4, .2, -.05], [0, -.3, .1], [.4, .3, -.15], [.75, -.1, .15]];
const state = (page: Page) => page.evaluate(() => window.operationHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.operationHarness.toolSnapshot());
const trace = (page: Page) => page.evaluate(() => window.operationHarness.trace());
const transients = (page: Page) => page.evaluate(() => {
  const app = window.geometryViewer.controllerForSourceNavigation();
  // Detached observations of the actual controller owners; no owner or
  // summary is installed or replaced by the browser test.
  const owner = (app as unknown as { tolerance?: { active: boolean; applying: boolean; tool: string } }).tolerance;
  return { tolerance: owner ? { active: owner.active, applying: owner.applying, tool: owner.tool } : null,
    updating: app.isToleranceUpdating, releasedBusy: app.isReleasedSelectionBusy,
    filterActive: app.filterActive, filterPreviewPending: app.filterPreviewPending };
});

async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page), transient = await transients(page);
    return { busy: value.busy, recovery: value.recovery, renderer: value.rendererState,
      updating: transient.updating, releasedBusy: transient.releasedBusy, filterPending: transient.filterPreviewPending };
  }).toEqual({ busy: false, recovery: 'idle', renderer: 'ready', updating: false, releasedBusy: false, filterPending: false });
}
async function command(page: Page, value: SceneCommand) {
  await page.evaluate(value => window.operationHarness.command(value), value); await settled(page); return snapshot(page);
}
function exactScene(value: Snapshot, expected: Snapshot) {
  expect(value.summary).toMatchObject({ ok: true, loaded: true, kind: 0, count: 5, sourceCount: 5, shDegree: 3,
    pending: false, transaction: false, selectionDraft: false, selected: expected.summary.selected, visible: expected.summary.visible });
  expect(value.packed).toEqual(expected.packed); expect(value.gpu.data).toEqual(expected.packed);
  expect(value.masks).toEqual(expected.masks); expect(value.gpu.masks).toEqual(expected.masks);
  // All three outputs were independently parsed from actual native binary
  // PLY exports; equality includes every one of the 45 SH3 coefficients.
  expect(value.outputs).toEqual(expected.outputs);
  for (const output of value.outputs) if (output)
    expect(output.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  expect(value.sourceFingerprint).toEqual(expected.sourceFingerprint); expect(value.sourceName).toBe(expected.sourceName);
  expect(value.document.documentId).toBe(expected.document.documentId);
  expect(value.document.sourceGeneration).toBe(expected.document.sourceGeneration);
  expect(value.resources.work).toBe(0);
}
function sourceMasks(value: Snapshot, baseline: Snapshot, expectedMasks: number[]) {
  expect(value.packed).toEqual(baseline.packed); expect(value.gpu.data).toEqual(baseline.packed);
  expect(value.masks).toEqual(expectedMasks); expect(value.gpu.masks).toEqual(expectedMasks);
  const source = baseline.sourceOutput, x = source.properties.indexOf('x'); expect(x).toBeGreaterThanOrEqual(0);
  expect(source.properties.filter(name => /^f_rest_\d+$/.test(name))).toHaveLength(45);
  value.outputs.forEach((output, scope) => {
    const ids = expectedMasks.flatMap((mask, id) => !(mask & 2) &&
      (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? [id] : []);
    if (!ids.length) { expect(output).toBeNull(); return; }
    expect(output!.properties).toEqual(source.properties);
    expect(output!.records).toEqual(ids.map(id => {
      const record = source.records.find(row => row[x] === Math.fround(positions[id][0]));
      expect(record).toBeDefined(); return record;
    }));
  });
  expect(value.resources.work).toBe(0);
}
function replaced(value: Snapshot, accepted: Snapshot, evidence: Trace) {
  expect(value.authoritativeWorker).not.toBe(accepted.authoritativeWorker);
  expect(value.clientGeneration).not.toBe(accepted.clientGeneration); expect(value.scene).not.toBe(accepted.scene);
  expect(value.checkpoint!.rootSha256).toBe(accepted.checkpoint!.rootSha256);
  expect(value.checkpoint!.binding).toEqual(accepted.checkpoint!.binding);
  expect(value.summary.contentRevision).toBe(accepted.summary.contentRevision);
  expect(value.resources.scenes.find(scene => scene.id === accepted.scene)).toMatchObject({ retired: true, disposeCalls: 1 });
  const old = evidence.workers.find(worker => worker.id === accepted.authoritativeWorker);
  expect(old).toMatchObject({ injectedFailures: 1 }); expect(old!.terminated).toBeGreaterThanOrEqual(1);
  expect(evidence.workers.filter(worker => worker.injectedFailures > 0)).toHaveLength(1);
  const restores = evidence.requests.filter(request => request.type === 'recovery-restore' && request.forwarded);
  expect(restores).toHaveLength(1); expect(restores[0].worker).toBe(value.authoritativeWorker);
  expect(evidence.responses.filter(response => response.type === 'recovery-result' && response.data.action === 'restore' && response.delivered)).toHaveLength(1);
  expect(evidence.requests.filter(request => request.type === 'source-load' || request.type === 'source-group-load')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'operation')).toHaveLength(0);
  expect(evidence.requests.filter(request => request.type === 'command' &&
    ['colorPick', 'colorTolerance', 'endTolerance', 'beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter',
      'alignCenter', 'alignScale', 'alignPlane', 'undo', 'redo'].includes(request.command ?? ''))).toHaveLength(0);
}
async function crash(page: Page, accepted: Snapshot) {
  await page.evaluate(() => window.operationHarness.clear());
  await page.evaluate(id => window.operationHarness.failWorker(id), accepted.authoritativeWorker); await settled(page);
  return snapshot(page);
}
async function fixtureHistory(page: Page, baseline: Snapshot, future: number[]) {
  // The fixture has four accepted history steps before its optional Redo.
  for (const current of [[1, 0, 0, 0, 2], [0, 0, 0, 0, 2], [0, 0, 0, 0, 1], [0, 0, 0, 0, 0]])
    sourceMasks(await command(page, { command: 'undo' }), baseline, current);
  expect((await snapshot(page)).summary.canUndo).toBe(false);
  for (const current of [[0, 0, 0, 0, 1], [0, 0, 0, 0, 2], [1, 0, 0, 0, 2], masks, future])
    sourceMasks(await command(page, { command: 'redo' }), baseline, current);
  expect((await snapshot(page)).summary.canRedo).toBe(false);
}
async function carriedCenterCamera(page: Page, before: Snapshot, target: Snapshot) {
  return page.evaluate(({ state, oldFrame, newFrame }) => {
    // Match the existing alignment-harness pure ABI observer: independent
    // literal translation, never installed into the viewport. Desktop
    // Camera::transformed reconstructs roll from float32 up/right bases and
    // atan2 even for a translation, so the carried roll need not equal .75.
    const delta = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    for (let axis = 0; axis < 3; axis++) delta[12 + axis] = Math.fround(newFrame[12 + axis] - oldFrame[12 + axis]);
    const camera = window.geometryViewer.controllerForSourceNavigation().camera!, revision = camera.revision, original = camera.state;
    const expected = camera.transformState(state, delta);
    if (camera.revision !== revision || camera.state.some((value, index) => value !== original[index]))
      throw new Error('The pure native camera observer mutated the viewport owner.');
    return expected;
  }, { state: before.camera, oldFrame: before.summary.alignment!.frame, newFrame: target.summary.alignment!.frame });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/e2e/operation-harness.html');
  await expect.poll(() => page.evaluate(() => window.operationHarness?.ready() ?? false)).toBe(true);
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.operationHarness.load()); await settled(page);
});

test('actual worker termination retains a completed GPU Color tolerance amendment as one Undo step and retires its transient owner', async ({ page }, info) => {
  const baseline = await snapshot(page);
  const picked = await page.evaluate(async () => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    if (!await app.activateSelectionTool('color')) throw new Error('The actual Color tool could not start.');
    const canvas = app.renderer!.canvas;
    app.camera!.set([0, 0, 0, 0, 0, 3, 1, 45, 0, 0, canvas.width / canvas.height]);
    app.setConnectedColor(false); app.setSelectionTolerance(0); app.invalidate();
    // Project the literal first source point independently of renderer pick
    // helpers. The actual GPU contributor query chooses the native seed.
    const multiply = (vector: number[], matrix: Float32Array) => Array.from({ length: 4 }, (_, column) =>
      vector.reduce((sum, value, row) => sum + value * matrix[row * 4 + column], 0));
    const clip = multiply(multiply([Math.fround(-.75), Math.fround(-.2), Math.fround(-.1), 1], app.camera!.view), app.camera!.projection);
    const x = Math.floor((clip[0] / clip[3] + 1) * canvas.width / 2), y = Math.floor((1 - clip[1] / clip[3]) * canvas.height / 2);
    return { accepted: await app.selectColorPixel(x, y, 0), pixel: [x, y] };
  });
  expect(picked.accepted).toBe(true); await settled(page);
  const initial = await snapshot(page); sourceMasks(initial, baseline, [1, 0, 0, 0, 2]);
  expect(initial.summary.toleranceSessionId).toEqual(expect.any(Number));
  await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().setSelectionTolerance(1));
  await expect.poll(async () => ({ selected: (await state(page)).summary?.selected, ...(await transients(page)) }))
    .toMatchObject({ selected: 4, updating: false, tolerance: { active: true, applying: false, tool: 'color' } });
  await settled(page); const accepted = await snapshot(page); sourceMasks(accepted, baseline, [1, 1, 1, 1, 2]);
  expect(accepted.summary.canRedo).toBe(false); expect(accepted.checkpoint!.rootSha256).not.toBe(baseline.checkpoint!.rootSha256);
  const after = await crash(page, accepted), evidence = await trace(page);
  exactScene(after, accepted); replaced(after, accepted, evidence);
  expect(after.document).toEqual(accepted.document); expect(after.camera).toEqual(accepted.camera);
  expect(after.tools.defaultCamera).toEqual(accepted.tools.defaultCamera); expect(after.tools.checkpoints).toEqual(accepted.tools.checkpoints);
  expect((await transients(page)).tolerance).toBeNull(); expect(after.summary.toleranceSessionId ?? null).toBeNull();
  // Later tolerance input cannot amend a dead-generation pick or manufacture
  // another history entry. A new physical pick is required after recovery.
  await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().setSelectionTolerance(0)); await settled(page);
  const stale = await snapshot(page); exactScene(stale, after); expect(stale.summary.revision).toBe(after.summary.revision);
  expect((await trace(page)).requests.filter(request => request.command === 'colorTolerance')).toHaveLength(0);
  const undone = await command(page, { command: 'undo' }); sourceMasks(undone, baseline, masks);
  await fixtureHistory(page, baseline, [1, 1, 1, 1, 2]);
  await info.attach('completed-tolerance-actual-worker-recovery', { contentType: 'application/json',
    body: JSON.stringify({ baseline, picked, initial, accepted, after, stale, undone, evidence, final: await snapshot(page) }) });
});

// The unfinished Sphere filter recovery case is omitted: selection.volume is excluded from web-lite.

test('actual worker termination preserves nonidentity alignment, the current navigation and exact default-camera roll lineage', async ({ page }, info) => {
  const baseline = await snapshot(page);
  const center = async (point: number[], roll: number) => {
    await page.evaluate(async ({ point, roll }) => {
      const app = window.geometryViewer.controllerForSourceNavigation(), camera = [...app.camera!.state];
      camera[9] = roll; app.camera!.set(camera); app.invalidate();
      await window.operationHarness.command({ command: 'alignCenter', point, camera: [...app.camera!.state],
        defaultCamera: window.operationHarness.toolState().defaultCamera });
    }, { point, roll });
    await settled(page); return snapshot(page);
  };
  const firstPoint = [.125, -.25, .0625], secondPoint = [-.0625, .125, -.03125];
  const first = await center(firstPoint, .375), second = await center(secondPoint, .625);
  const translated = (value: Snapshot, translations: number[][]) => {
    expect(value.masks).toEqual(masks); expect(value.gpu.masks).toEqual(masks); expect(value.gpu.data).toEqual(value.packed);
    expect(value.summary.alignment!.branchId).toBeGreaterThan(0);
    expect(value.summary.alignment!.frame.slice(12, 15)).toEqual([0, 1, 2].map(axis =>
      translations.reduce((coordinate, point) => Math.fround(coordinate - point[axis]), 0)));
    const packed = new DataView(Uint8Array.from(value.packed).buffer);
    positions.forEach((point, id) => {
      expect([0, 4, 8].map(offset => packed.getFloat32(id * value.stride + offset, true))).toEqual(point.map((coordinate, axis) =>
        translations.reduce((current, center) => Math.fround(current - center[axis]), Math.fround(coordinate))));
      expect(value.packed.slice(id * value.stride + 12, (id + 1) * value.stride))
        .toEqual(baseline.packed.slice(id * baseline.stride + 12, (id + 1) * baseline.stride));
    });
    value.outputs.forEach((output, scope) => {
      const before = baseline.outputs[scope]; expect(output!.properties).toEqual(before!.properties);
      const axes = ['x', 'y', 'z'].map(name => output!.properties.indexOf(name));
      output!.records.forEach((row, record) => row.forEach((field, property) => {
        const axis = axes.indexOf(property);
        // Desktop ply_export.cpp:42–44 writes RDF (x,-y,-z), while
        // alignCenter subtracts its world-space point from every native
        // record. Exported Y/Z consequently add that point's components.
        expect(field).toBe(axis < 0 ? before!.records[record][property] :
          translations.reduce((coordinate, point) => Math.fround(coordinate - point[axis] * (axis === 0 ? 1 : -1)), before!.records[record][property]));
      }));
    });
  };
  translated(first, [firstPoint]); translated(second, [firstPoint, secondPoint]);
  expect(second.tools.checkpoints).toHaveLength(3);
  expect(second.tools.checkpoints.map(entry => entry.activeRoll)).toEqual([.375, .625, .625]);
  expect(second.tools.checkpoints.map(entry => entry.defaultRoll)).toEqual([baseline.tools.defaultCamera[9], baseline.tools.defaultCamera[9], baseline.tools.defaultCamera[9]]);
  await page.evaluate(() => window.operationHarness.navigateToolCamera());
  const accepted = await snapshot(page); expect(accepted.camera[9]).toBe(.75); expect(accepted.tools.background).toBe('white');
  expect(accepted.camera).not.toEqual(second.camera); expect(accepted.checkpoint!.rootSha256).toBe(second.checkpoint!.rootSha256);
  const after = await crash(page, accepted), evidence = await trace(page);
  exactScene(after, accepted); replaced(after, accepted, evidence); expect(after.document).toEqual(accepted.document);
  expect(after.summary.alignment).toEqual(accepted.summary.alignment); expect(after.summary.camera).toEqual(accepted.summary.camera);
  expect(after.camera).toEqual(accepted.camera); expect(after.tools.defaultCamera).toEqual(accepted.tools.defaultCamera);
  expect(after.tools.checkpoints).toEqual(accepted.tools.checkpoints); expect(after.tools.background).toBe('white');
  const undoCamera = await carriedCenterCamera(page, after, first);
  const undone = await command(page, { command: 'undo' }); exactScene(undone, first);
  expect(undone.summary.alignment!.branchId).toBe(first.summary.alignment!.branchId);
  expect(undone.summary.alignment!.frame).toEqual(first.summary.alignment!.frame); expect(undone.camera).toEqual(undoCamera);
  const redoCamera = await carriedCenterCamera(page, undone, second);
  const redone = await command(page, { command: 'redo' }); exactScene(redone, second);
  expect(redone.summary.alignment!.branchId).toBe(second.summary.alignment!.branchId);
  expect(redone.summary.alignment!.frame).toEqual(second.summary.alignment!.frame); expect(redone.camera).toEqual(redoCamera);
  await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().resetCamera()); await settled(page);
  const reset = await snapshot(page); exactScene(reset, redone); expect(reset.summary.revision).toBe(redone.summary.revision);
  expect(reset.camera).toEqual(redone.tools.defaultCamera.map(Math.fround));
  expect(reset.tools.checkpoints).toEqual(redone.tools.checkpoints.map(entry => ({ ...entry, activeRoll: entry.defaultRoll })));
  await info.attach('alignment-default-roll-lineage-actual-worker-recovery', { contentType: 'application/json',
    body: JSON.stringify({ baseline, first, second, accepted, after, undone, redone, reset, evidence }) });
});
