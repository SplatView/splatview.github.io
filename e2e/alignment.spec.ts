import { expect, test, type Page } from './backend-test';
import type {} from './alignment-harness';
import { queuePositions } from './queue-fixture';

type Snapshot = Awaited<ReturnType<Window['alignmentHarness']['snapshot']>>;
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function translation(value: Snapshot) { return value.summary.alignment!.frame.slice(12, 15); }
function coordinates(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((coordinate, axis) => expect(coordinate).toBeCloseTo(expected[axis], 6));
}
function mirrors(value: Snapshot, shDegree = 3) {
  expect(value.records).toEqual(value.gpuRecords); expect(value.masks).toEqual(value.gpuMasks);
  expect(value.nativeRecordHash).toBe(value.gpuRecordHash);
  expect(value.work).toEqual({ allocations: 0, bytes: 0 });
  expect(value.summary).toMatchObject({ pending: false, transaction: false, selectionDraft: false, shDegree });
}
function positions(value: Snapshot, delta: readonly number[]) {
  mirrors(value);
  queuePositions.forEach(([x, y, z], id) => coordinates(value.records[id].position,
    [x, -y, -z].map((coordinate, axis) => Math.fround(Math.fround(coordinate) + delta[axis]))));
}
function attributes(value: Snapshot, before: Snapshot) {
  expect(value.records.map(record => record.attributes)).toEqual(before.records.map(record => record.attributes));
}
async function expectedCamera(page: Page, state: readonly number[], oldFrame: readonly number[], newFrame: readonly number[]) {
  return page.evaluate(({ state, oldFrame, newFrame }) => window.alignmentHarness.expectedCamera(state, oldFrame, newFrame),
    { state, oldFrame, newFrame });
}
async function carry(page: Page, before: Snapshot, after: Snapshot) {
  const oldFrame = translation(before), nextFrame = translation(after);
  const targets = before.camera.slice(0, 3).map((value, axis) => Math.fround(value + Math.fround(nextFrame[axis] - oldFrame[axis])));
  expect(after.camera.slice(0, 3)).toEqual(targets);
  // Numeric reconstruction is independently calibrated against actual R0 C++ in CPU tests.
  // This native observer verifies which current camera/frame the controller carries.
  expect(after.camera).toEqual(await expectedCamera(page, before.camera, before.summary.alignment!.frame, after.summary.alignment!.frame));
}
function retained(value: Snapshot, before: Snapshot) {
  mirrors(value);
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'nativeRecordHash', 'exported', 'camera', 'background', 'sourceFingerprint'] as const)
    expect(value[key], key).toEqual(before[key]);
  expect(value.summary.alignment).toEqual(before.summary.alignment);
  expect(value.summary.camera).toEqual(before.summary.camera);
  expect(value.summary).toMatchObject({ count: before.summary.count, visible: before.summary.visible,
    selected: before.summary.selected, contentRevision: before.summary.contentRevision, canUndo: before.summary.canUndo, canRedo: before.summary.canRedo });
}
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ busy: false, alignmentPicking: false, enabled: true });
}
async function start(page: Page) {
  await page.mouse.move(20, 200);
  await tools(page).getByRole('button', { name: 'Alignment', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Alignment actions', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: '2-point scale', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: '3-point align', exact: true })).toBeEnabled();
  // Level floor is alignment.auto, which web-lite excludes.
  await expect(menu.getByRole('menuitemradio', { name: 'Level floor', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitemradio', { name: '1-point center', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: 'center', alignmentPoint: null });
}
async function clickPoint(page: Page, id = 3) {
  const pixel = await page.evaluate(id => window.alignmentHarness.pixel(id), id);
  await page.mouse.click(pixel.clientX, pixel.clientY);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentPicking: false, alignmentTool: 'center' });
  await expect(page.getByRole('button', { name: 'Set center', exact: true })).toBeEnabled();
  return page.evaluate(() => window.alignmentHarness.state());
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: action, exact: true }).click();
  await settled(page); return snapshot(page);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/alignment-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.alignmentHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.alignmentHarness.load()); await settled(page);
});

test('Center real contributor confirmation translates selected, unselected and deleted SH3 records, then Restore exposes the translated record', async ({ page }, testInfo) => {
  await page.evaluate(async () => { await window.alignmentHarness.seed([2]); await window.alignmentHarness.command({ command: 'delete' }); await window.alignmentHarness.seed([0]); });
  const before = await snapshot(page); positions(before, [0, 0, 0]);
  expect(before.masks[0] & 3).toBe(1); expect(before.masks[2] & 2).toBe(2);
  await start(page); const picked = await clickPoint(page);
  coordinates(picked.alignmentPoint!, [Math.fround(.7), 0, 0]);
  // An accepted world point survives navigation before explicit confirmation.
  await page.evaluate(() => window.alignmentHarness.navigate());
  const navigated = await snapshot(page); expect(navigated.alignmentPoint).toEqual(picked.alignmentPoint);
  await page.getByRole('button', { name: 'Set center', exact: true }).click(); await settled(page);
  const centered = await snapshot(page), delta = [-Math.fround(.7), 0, 0];
  positions(centered, delta); attributes(centered, before); await carry(page, navigated, centered);
  expect(centered.masks).toEqual(before.masks); coordinates(centered.records[3].position, [0, 0, 0]);
  coordinates(translation(centered), delta); expect(centered.summary.alignment!.canReset).toBe(true);
  before.summary.camera.slice(0, 3).forEach((value, axis) => expect(centered.summary.camera[axis]).toBeCloseTo(Math.fround(value + delta[axis]), 6));
  const expectedDefault = await expectedCamera(page, before.summary.camera, identity, centered.summary.alignment!.frame);
  expectedDefault[6] = centered.summary.radius; expectedDefault[10] = centered.summary.camera[10]; expect(centered.summary.camera).toEqual(expectedDefault);
  expect(centered.summary.camera[6]).toBe(centered.summary.radius);
  expect(centered.alignmentTool).toBeNull(); expect(centered.csvRows).toHaveLength(4);
  await tools(page).getByRole('button', { name: 'Restore deleted', exact: true }).click(); await settled(page);
  const restored = await snapshot(page); positions(restored, delta); attributes(restored, before);
  expect(restored.masks.every(mask => !(mask & 2))).toBe(true); expect(restored.csvRows).toHaveLength(5);
  restored.csvRows.forEach((row, id) => coordinates(row.slice(0, 3), [restored.records[id].position[0], -restored.records[id].position[1], -restored.records[id].position[2]]));
  await testInfo.attach('alignment-center-all-source-members.json', { body: JSON.stringify({ before, picked, navigated, centered, restored }), contentType: 'application/json' });
});

test('two Centers preserve current orbit, pan, zoom and lens across Undo, Redo and cumulative Reset with its original mask baseline', async ({ page }, testInfo) => {
  await page.evaluate(async () => { await window.alignmentHarness.seed([2]); await window.alignmentHarness.command({ command: 'delete' }); await window.alignmentHarness.seed([0]); });
  const baseline = await snapshot(page), first = await page.evaluate(() => window.alignmentHarness.center(3));
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigation = await snapshot(page);
  // A second contributor is projected using original source coordinates + native cumulative frame.
  const second = await page.evaluate(() => window.alignmentHarness.center(4)); await carry(page, navigation, second);
  coordinates(translation(second), [0, Math.fround(.85), 0]); attributes(second, baseline); expect(second.masks).toEqual(baseline.masks);
  // Reset owns only the uninterrupted alignment group. Ordinary history/selection edits retire that group.
  await page.evaluate(() => window.alignmentHarness.navigate()); const beforeReset = await snapshot(page);
  await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
  const reset = await snapshot(page); await carry(page, beforeReset, reset); positions(reset, [0, 0, 0]); attributes(reset, baseline);
  expect(reset.nativeRecordHash).toBe(baseline.nativeRecordHash); expect(reset.masks).toEqual(baseline.masks);
  coordinates(reset.summary.alignment!.frame, identity); expect(reset.summary.alignment!.canReset).toBe(false);
  const undoReset = await history(page, 'Undo'); await carry(page, reset, undoReset); expect(undoReset.records).toEqual(beforeReset.records); expect(undoReset.masks).toEqual(beforeReset.masks);
  const undoSecond = await history(page, 'Undo'); await carry(page, undoReset, undoSecond); expect(undoSecond.summary.alignment!.branchId).toBe(first.summary.alignment!.branchId);
  const redoSecond = await history(page, 'Redo'); await carry(page, undoSecond, redoSecond); expect(redoSecond.summary.alignment!.branchId).toBe(second.summary.alignment!.branchId);
  const redoReset = await history(page, 'Redo'); await carry(page, redoSecond, redoReset); expect(redoReset.nativeRecordHash).toBe(baseline.nativeRecordHash);
  await testInfo.attach('alignment-two-center-navigation-reset.json', { body: JSON.stringify({ baseline, first, navigation, second, beforeReset, reset, undoReset, undoSecond, redoSecond, redoReset }), contentType: 'application/json' });
});

for (const boundary of ['selection', 'history', 'grade'] as const)
  test(`an ordinary ${boundary} edit retires stale Reset ownership and a fresh Center captures its current scene and masks`, async ({ page }, testInfo) => {
    await page.evaluate(() => window.alignmentHarness.seed([0]));
    const first = await page.evaluate(() => window.alignmentHarness.center());
    expect(first.summary.alignment!.canReset).toBe(true);
    await page.evaluate(async boundary => {
      if (boundary === 'selection') await window.alignmentHarness.seed([1]);
      else if (boundary === 'history') await window.alignmentHarness.command({ command: 'undo' });
      else {
        await window.alignmentHarness.command({ command: 'grade', selectedOnly: false, values: [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
        await window.alignmentHarness.command({ command: 'endColor' });
      }
    }, boundary);
    const newBaseline = await snapshot(page); mirrors(newBaseline); expect(newBaseline.summary.alignment!.canReset).toBe(false);
    await expect(tools(page).getByRole('button', { name: 'Reset transform', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => window.geometryViewer.controllerForRendererNavigation().resetAlignment())).toBe(false);
    // The captured header also resets numeric defaults; a retired alignment
    // baseline cannot be resurrected by that broader action.
    await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
    retained(await snapshot(page), newBaseline);
    const second = await page.evaluate(() => window.alignmentHarness.center(4)); expect(second.summary.alignment!.canReset).toBe(true);
    await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
    const reset = await snapshot(page); await carry(page, second, reset); mirrors(reset);
    expect(reset.records).toEqual(newBaseline.records); expect(reset.masks).toEqual(newBaseline.masks);
    expect(reset.summary.alignment!.frame).toEqual(newBaseline.summary.alignment!.frame);
    expect(reset.summary.alignment!.canReset).toBe(false);
    await testInfo.attach(`alignment-stale-${boundary}-reset-fresh-baseline.json`, { body: JSON.stringify({ first, newBaseline, second, reset }), contentType: 'application/json' });
  });

test('a manual color preview retires an accepted Center point and disables Reset without baking color or changing native geometry, masks, frame or history', async ({ page }, testInfo) => {
  await page.evaluate(() => window.alignmentHarness.center());
  const picked = await page.evaluate(() => window.alignmentHarness.pick(4));
  expect(picked.alignmentPoint).not.toBeNull(); expect(picked.alignmentTool).toBe('center');
  const before = await snapshot(page); expect(before.summary.alignment!.canReset).toBe(true); expect(before.colorPending).toBe(false);
  const preview = await page.evaluate(async () => {
    const app = window.geometryViewer.controllerForRendererNavigation(), client = app.client!, original = client.command.bind(client), calls: string[] = [];
    client.command = async (...args) => { calls.push(args[0].command); return original(...args); };
    try {
      app.setGrade([1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
      return { confirm: await app.confirmAlignment(), reset: await app.resetAlignment(), pending: app.colorPending, calls };
    } finally { client.command = original; }
  });
  expect(preview).toEqual({ confirm: false, reset: false, pending: true, calls: [] });
  await expect(tools(page).getByRole('button', { name: 'Reset transform', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Alignment action', exact: true })).toHaveCount(0);
  const after = await snapshot(page); retained(after, before);
  expect(after.alignmentPoint).toBeNull(); expect(after.alignmentTool).toBeNull(); expect(after.alignmentPicking).toBe(false);
  expect(after.colorPending).toBe(true); expect(after.grade[0]).toBe(Math.fround(1.2)); expect(after.appliedGrade).toEqual(before.appliedGrade);
  expect(after.colorSession).toEqual(before.colorSession); expect(after.summary.alignment!.canReset).toBe(true);
  await testInfo.attach('alignment-manual-color-preview-point-reset-boundary.json', { body: JSON.stringify({ picked, before, preview, after }), contentType: 'application/json' });
});

test('a divergent Center at the same contributor produces equal geometry and frame with a distinct executable history branch', async ({ page }, testInfo) => {
  const first = await page.evaluate(() => window.alignmentHarness.center());
  const undone = await history(page, 'Undo'); expect(undone.summary.canRedo).toBe(true);
  await page.evaluate(() => window.alignmentHarness.view());
  const divergent = await page.evaluate(() => window.alignmentHarness.center());
  expect(divergent.nativeRecordHash).toBe(first.nativeRecordHash); expect(divergent.summary.alignment!.frame).toEqual(first.summary.alignment!.frame);
  expect(divergent.summary.alignment!.branchId).not.toBe(first.summary.alignment!.branchId); expect(divergent.summary.canRedo).toBe(false);
  const nextUndo = await history(page, 'Undo'), nextRedo = await history(page, 'Redo'); await carry(page, nextUndo, nextRedo);
  expect(nextRedo.summary.alignment!.branchId).toBe(divergent.summary.alignment!.branchId);
  await testInfo.attach('alignment-divergent-equal-frame-history.json', { body: JSON.stringify({ first, undone, divergent, nextUndo, nextRedo }), contentType: 'application/json' });
});

test('three isolated real contributors distinguish float32 cumulative frame camera carry from subtracting the picked point', async ({ page }, testInfo) => {
  const initial = await page.evaluate(() => window.alignmentHarness.loadPrecision('third-center'));
  mirrors(initial, 0); expect(initial.records.map(record => record.position[0])).toEqual([Math.fround(.1), Math.fround(.2), Math.fround(.3)]);
  const steps: { before: Snapshot; point: readonly number[]; after: Snapshot }[] = [];
  for (const id of [0, 1, 2]) {
    const before = await snapshot(page), accepted = await page.evaluate(id => window.alignmentHarness.pick(id), id);
    expect(accepted.alignmentPoint).not.toBeNull();
    expect(await page.evaluate(() => window.geometryViewer.controllerForRendererNavigation().confirmAlignment())).toBe(true);
    await settled(page); const after = await snapshot(page); mirrors(after, 0); attributes(after, initial);
    const oldFrame = translation(before), nextFrame = translation(after);
    for (const axis of [0, 1, 2]) {
      const delta = Math.fround(nextFrame[axis] - oldFrame[axis]);
      expect(after.camera[axis]).toBe(Math.fround(before.camera[axis] + delta));
      expect(after.summary.camera[axis]).toBe(Math.fround(Math.fround(before.summary.camera[axis]) + delta));
    }
    await carry(page, before, after);
    const expectedDefault = await expectedCamera(page, before.summary.camera, before.summary.alignment!.frame, after.summary.alignment!.frame);
    expectedDefault[6] = after.summary.radius; expectedDefault[10] = after.summary.camera[10]; expect(after.summary.camera).toEqual(expectedDefault);
    expect(after.summary.camera[6]).toBe(after.summary.radius);
    steps.push({ before, point: accepted.alignmentPoint!, after });
  }
  const third = steps[2];
  expect(translation(third.before)[0]).toBe(-.20000000298023224);
  expect(translation(third.after)[0]).toBe(-.30000001192092896);
  const frameDelta = Math.fround(translation(third.after)[0] - translation(third.before)[0]);
  expect(frameDelta).toBe(-.10000000894069672);
  expect(-third.point[0]).toBe(-.10000001639127731); expect(frameDelta).not.toBe(-third.point[0]);
  expect(third.after.camera[0]).not.toBe(Math.fround(third.before.camera[0] - third.point[0]));
  expect(third.after.summary.camera[0]).not.toBe(Math.fround(third.before.summary.camera[0] - third.point[0]));
  expect(third.after.records[2].position[0]).toBe(0);
  await testInfo.attach('alignment-third-center-float32-frame-carry.json', { body: JSON.stringify({ initial, steps, frameDelta }), contentType: 'application/json' });
});

test('Undo carries the current unsaved default camera through float32 frames and Reset camera uses that owner instead of the historical scene default', async ({ page }, testInfo) => {
  const initial = await page.evaluate(() => window.alignmentHarness.loadPrecision('default-undo'));
  mirrors(initial, 0); expect(initial.savedViewAvailable).toBe(false);
  expect(initial.records.map(record => record.position[0])).toEqual([-Math.fround(.9998), 1]);
  expect(initial.summary.camera[0]).toBe(.00009998679161071777);
  const centered = await page.evaluate(() => window.alignmentHarness.center(1)); mirrors(centered, 0);
  expect(centered.summary.camera[0]).toBe(-.9998999834060669);
  const undone = await history(page, 'Undo'); mirrors(undone, 0);
  expect(undone.summary.camera[0]).toBe(.00009998679161071777);
  expect(undone.camera[0]).toBe(.00010001659393310547);
  // Change the active camera before exercising the actual Reset camera path.
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigated = await snapshot(page);
  const reset = await page.evaluate(() => window.alignmentHarness.resetCamera()); mirrors(reset, 0);
  expect(reset.camera).not.toEqual(navigated.camera);
  expect(reset.camera[0]).toBe(.00010001659393310547);
  expect(reset.camera[0]).not.toBe(reset.summary.camera[0]);
  expect(reset.camera[0]).toBe(Math.fround(centered.summary.camera[0] + 1));
  const expectedDefault = await expectedCamera(page, centered.summary.camera, centered.summary.alignment!.frame, undone.summary.alignment!.frame);
  expectedDefault[6] = reset.summary.radius; expectedDefault[10] = reset.camera[10]; expect(reset.camera).toEqual(expectedDefault);
  expect(reset.camera[6]).toBe(reset.summary.radius); expect(reset.savedViewAvailable).toBe(false);
  expect(reset.records).toEqual(initial.records); expect(reset.masks).toEqual(initial.masks);
  await testInfo.attach('alignment-undo-current-default-camera-float32.json', { body: JSON.stringify({ initial, centered, undone, navigated, reset }), contentType: 'application/json' });
});

for (const kind of ['admission', 'gpu', 'cancel'] as const)
  test(`${kind} Center refusal retains native and GPU geometry, masks, active/default camera, accepted point and executable Redo`, async ({ page }, testInfo) => {
    const result = await page.evaluate(kind => window.alignmentHarness.refusal(kind), kind);
    expect(result.accepted).toBe(false); expect(result.before.summary.canRedo).toBe(true); retained(result.after, result.before);
    expect(result.after.alignmentPoint).toEqual(result.before.alignmentPoint); expect(result.after.alignmentTool).toBe('center');
    expect(result.decoded).toBe(kind !== 'admission'); expect(result.failed).toBe(kind !== 'admission');
    if (kind !== 'cancel') expect(result.error).toMatch(kind === 'admission' ? /budget/ : /actual GPU completion/);
    expect(result.redone).toBe(true); expect(result.afterRedo.summary.canRedo).toBe(false);
    expect(result.afterRedo.masks[1] & 3).toBe(1); mirrors(result.afterRedo);
    await testInfo.attach(`alignment-${kind}-rollback.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });

for (const kind of ['camera', 'edit', 'source', 'device'] as const)
  test(`a held actual contributor pick refuses stale ${kind} ownership before accepting a Center point`, async ({ page }, testInfo) => {
    const result = await page.evaluate(kind => window.alignmentHarness.stalePick(kind), kind);
    expect(result.picked).toBe(3); expect(result.accepted).toBe(false); expect(result.after.alignmentPoint).toBeNull();
    expect(result.after.records).toEqual(result.before.records); attributes(result.after, result.before); mirrors(result.after);
    coordinates(result.after.summary.alignment!.frame, identity); expect(result.after.summary.alignment!.canReset).toBe(false);
    if (kind === 'device') expect(result.after.deviceEpoch).toBeGreaterThan(result.before.deviceEpoch);
    if (kind !== 'edit') expect(result.after.masks).toEqual(result.before.masks);
    await testInfo.attach(`alignment-stale-${kind}-pick.json`, { body: JSON.stringify(result), contentType: 'application/json' });
  });

test('aligned saved thumbnail persists original-source camera coordinates, resets into edited coordinates and restores on original-source reopen', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.alignmentHarness.savedRoundtrip());
  expect(result.saved.records).toHaveLength(1); expect(result.saved.imageHashes).toHaveLength(1);
  const record = result.saved.records[0], frame = translation(result.aligned);
  coordinates(record.view.target, result.aligned.camera.slice(0, 3).map((value, axis) => Math.fround(value - frame[axis])));
  const sourceCamera = await expectedCamera(page, result.aligned.camera, result.aligned.summary.alignment!.frame, identity);
  expect(record.view).toMatchObject({ target: sourceCamera.slice(0, 3), yaw: sourceCamera[3], pitch: sourceCamera[4],
    distance: sourceCamera[5], fov: sourceCamera[7], yUp: !!sourceCamera[8], roll: sourceCamera[9] });
  expect(record.thumbnail.sha256).toBe(result.saved.imageHashes[0]);
  coordinates(result.resetEdited.camera.slice(0, 3), result.aligned.camera.slice(0, 3));
  for (const field of [3, 4, 5, 7, 8, 9]) expect(result.resetEdited.camera[field]).toBe(result.aligned.camera[field]);
  expect(result.resetEdited.camera[6]).toBe(result.resetEdited.summary.radius);
  coordinates(result.reopened.camera.slice(0, 3), record.view.target);
  sourceCamera[6] = result.reopened.summary.radius; sourceCamera[10] = result.reopened.camera[10];
  expect(result.reopened.camera).toEqual(sourceCamera);
  positions(result.reopened, [0, 0, 0]); expect(result.reopened.savedViewAvailable).toBe(true);
  expect(result.afterStorage).toEqual(result.saved); expect(result.reopened.summary.canUndo).toBe(false);
  await testInfo.attach('alignment-original-source-saved-thumbnail.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('a saved thumbnail initializes the mutable default camera while later Center and Undo carry it independently of unchanged original-source metadata', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.alignmentHarness.savedDefaultCarry());
  expect(result.saved.records).toHaveLength(1); expect(result.afterStorage).toEqual(result.saved);
  const oldFrame = result.captured.summary.alignment!.frame, newFrame = result.second.summary.alignment!.frame;
  const initialDefault = [...result.captured.camera]; initialDefault[6] = result.captured.summary.radius;
  const centeredDefault = await expectedCamera(page, initialDefault, oldFrame, newFrame);
  centeredDefault[6] = result.second.summary.radius; centeredDefault[10] = result.second.summary.camera[10];
  expect(result.second.summary.camera).toEqual(centeredDefault);
  const carriedDefault = await expectedCamera(page, centeredDefault, newFrame, oldFrame);
  carriedDefault[6] = result.reset.summary.radius; carriedDefault[10] = result.reset.camera[10];
  expect(result.reset.camera).toEqual(carriedDefault);
  expect(result.reset.camera[6]).toBe(result.reset.summary.radius);
  const sourceCamera = await expectedCamera(page, result.captured.camera, oldFrame, identity);
  coordinates(result.saved.records[0].view.target, sourceCamera.slice(0, 3));
  expect(result.reset.records).toEqual(result.captured.records); expect(result.reset.masks).toEqual(result.captured.masks);
  expect(result.reset.camera).not.toEqual(result.undone.camera); mirrors(result.reset);
  await testInfo.attach('alignment-saved-view-current-default-carry.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('Center export and actual native reopen retain translated positions and all directional SH3 bytes with a fresh source frame', async ({ page }, testInfo) => {
  await page.evaluate(() => window.alignmentHarness.center());
  const result = await page.evaluate(() => window.alignmentHarness.reopenExport());
  mirrors(result.after); expect(result.before.exportedBytes.length).toBeGreaterThan(100);
  result.after.records.forEach((record, id) => {
    coordinates(record.position, result.before.records[id].position);
    // SH starts at packed byte40, or attribute byte28; independently distinguish it from covariance bytes.
    expect(record.attributes.slice(28)).toEqual(result.before.records[id].attributes.slice(28));
  });
  coordinates(result.after.summary.alignment!.frame, identity); expect(result.after.summary.alignment!.canReset).toBe(false);
  expect(result.after.summary.canUndo).toBe(false); expect(result.after.sourceFingerprint).not.toEqual(result.before.sourceFingerprint);
  await testInfo.attach('alignment-export-reopen-sh3.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('Center UI enforces four-pixel click threshold, navigation drags, clear-then-exit, Backspace, Escape and explicit Enter confirmation', async ({ page }, testInfo) => {
  const before = await snapshot(page); await start(page);
  const point = await page.evaluate(() => window.alignmentHarness.pixel(3));
  await page.mouse.move(point.clientX, point.clientY); await page.mouse.down(); await page.mouse.move(point.clientX + 5, point.clientY); await page.mouse.up();
  await settled(page); expect((await snapshot(page)).alignmentPoint).toBeNull();
  await page.mouse.move(point.clientX, point.clientY); await page.mouse.down(); await page.mouse.move(point.clientX + 3, point.clientY); await page.mouse.up();
  await expect(page.getByRole('button', { name: 'Set center', exact: true })).toBeEnabled();
  const picked = await snapshot(page); coordinates(picked.alignmentPoint!, [Math.fround(.7), 0, 0]);
  await page.mouse.move(point.clientX - 50, point.clientY - 80); await page.mouse.down({ button: 'right' });
  await page.mouse.move(point.clientX - 38, point.clientY - 73); await page.mouse.up({ button: 'right' });
  const panned = await snapshot(page); expect(panned.camera).not.toEqual(picked.camera); expect(panned.alignmentPoint).toEqual(picked.alignmentPoint);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Backspace');
  expect((await snapshot(page)).alignmentPoint).toBeNull(); expect((await snapshot(page)).alignmentTool).toBe('center');
  await page.evaluate(() => window.alignmentHarness.view()); await clickPoint(page);
  await page.mouse.click(400, 200, { button: 'right' }); expect((await snapshot(page)).alignmentPoint).toBeNull();
  await page.mouse.click(400, 200, { button: 'right' }); expect((await snapshot(page)).alignmentTool).toBeNull();
  await start(page); await clickPoint(page); await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Escape');
  const cancelled = await snapshot(page); expect(cancelled.alignmentTool).toBeNull();
  expect(cancelled.records).toEqual(before.records); expect(cancelled.masks).toEqual(before.masks); expect(cancelled.summary.alignment).toEqual(before.summary.alignment);
  await start(page); await clickPoint(page); await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Enter'); await settled(page);
  const confirmed = await snapshot(page); positions(confirmed, [-Math.fround(.7), 0, 0]); attributes(confirmed, before); expect(confirmed.alignmentTool).toBeNull();
  await testInfo.attach('alignment-ui-gesture-key-contract.json', { body: JSON.stringify({ before, picked, panned, cancelled, confirmed }), contentType: 'application/json' });
});
