import { expect, test, type Page } from './backend-test';
import type {} from './alignment-harness';

type Snapshot = Awaited<ReturnType<Window['alignmentHarness']['snapshot']>>;
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ busy: false, alignmentPicking: false, enabled: true });
}
function mirrors(value: Snapshot) {
  expect(value.records).toEqual(value.gpuRecords); expect(value.masks).toEqual(value.gpuMasks);
  expect(value.nativeRecordHash).toBe(value.gpuRecordHash); expect(value.work).toEqual({ allocations: 0, bytes: 0 });
  expect(value.summary).toMatchObject({ pending: false, transaction: false, selectionDraft: false, shDegree: 3 });
}
function retained(value: Snapshot, before: Snapshot) {
  mirrors(value);
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'nativeRecordHash', 'exported', 'camera', 'background', 'sourceFingerprint'] as const)
    expect(value[key], key).toEqual(before[key]);
  expect(value.summary.alignment).toEqual(before.summary.alignment);
  expect(value.summary.camera).toEqual(before.summary.camera);
  expect(value.summary).toMatchObject({ count: before.summary.count, visible: before.summary.visible,
    selected: before.summary.selected, contentRevision: before.summary.contentRevision,
    canUndo: before.summary.canUndo, canRedo: before.summary.canRedo });
}
function numeric(actual: readonly number[], expected: readonly number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
}
async function start(page: Page) {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: 'Alignment', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Alignment actions', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: '3-point align', exact: true })).toBeEnabled();
  // Level floor is alignment.auto, which web-lite excludes.
  await expect(menu.getByRole('menuitemradio', { name: 'Level floor', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitemradio', { name: '2-point scale', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({
    alignmentTool: 'scale', alignmentPoint: null, alignmentSecondPoint: null });
}
async function clickPoint(page: Page, index: number) {
  const point = await page.evaluate(index => window.alignmentHarness.pixel(index), index);
  await page.mouse.click(point.clientX, point.clientY);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentPicking)).toBe(false);
}
async function pair(page: Page) {
  await start(page); await clickPoint(page, 3);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentPoint)).not.toBeNull();
  await clickPoint(page, 4);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentSecondPoint)).not.toBeNull();
  await expect(page.getByRole('button', { name: 'Set scale', exact: true })).toBeEnabled();
  return page.evaluate(() => window.alignmentHarness.state());
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: action, exact: true }).click();
  await settled(page); return snapshot(page);
}
async function expectedCamera(page: Page, state: readonly number[], before: readonly number[], after: readonly number[]) {
  return page.evaluate(({ state, before, after }) => window.alignmentHarness.expectedFrameCamera(state, before, after), { state, before, after });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/alignment-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.alignmentHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.alignmentHarness.load()); await settled(page);
});

test('Scale real contributor confirmation changes all SH3 positions and covariance, including deleted records, without target-edit baking', async ({ page }, testInfo) => {
  await page.evaluate(async () => { await window.alignmentHarness.seed([2]); await window.alignmentHarness.command({ command: 'delete' }); await window.alignmentHarness.seed([0]); });
  const before = await snapshot(page), picked = await pair(page), a = picked.alignmentPoint!, b = picked.alignmentSecondPoint!;
  expect(before.masks).toEqual([1, 0, 2, 0, 0]);
  await expect(page.locator('.alignment-marker text')).toHaveText(['1', '2']);
  await expect(page.locator('.alignment-segment')).toHaveCount(1);
  const target = Math.fround(picked.alignmentTargetDistance! * 2), field = page.getByLabel('Target distance (m)', { exact: true });
  await field.fill(String(Math.fround(target * 1.5))); await field.fill(String(target));
  retained(await snapshot(page), before);
  await page.evaluate(() => window.alignmentHarness.navigate());
  const navigated = await snapshot(page); expect(navigated.alignmentPoint).toEqual(a); expect(navigated.alignmentSecondPoint).toEqual(b);
  await page.getByRole('button', { name: 'Set scale', exact: true }).click(); await settled(page);
  const after = await snapshot(page); mirrors(after);
  const d = a.map((value, axis) => value - b[axis]), distance = Math.sqrt(d.reduce((sum, value) => sum + value * value, 0));
  const factor = Math.fround(target / distance), midpoint = a.map((value, axis) => Math.fround(Math.fround(value * .5) + Math.fround(b[axis] * .5)));
  const translation = midpoint.map(value => Math.fround(Math.fround(-value * factor) + value));
  before.records.forEach((record, index) => {
    numeric(after.records[index].position, record.position.map((value, axis) => Math.fround(translation[axis] + factor * value)));
    numeric(after.records[index].covariance, record.covariance.map(value => Math.fround(factor * value * factor)));
    expect(after.records[index].opacity).toEqual(record.opacity); expect(after.records[index].appearance).toEqual(record.appearance);
  });
  expect(after.masks).toEqual(before.masks); expect(after.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(after.camera).toEqual(await expectedCamera(page, navigated.camera, navigated.summary.alignment!.frame, after.summary.alignment!.frame));
  expect(after.alignmentTool).toBeNull(); expect(after.summary.alignment!.canReset).toBe(true);
  await tools(page).getByRole('button', { name: 'Restore deleted', exact: true }).click(); await settled(page);
  const restored = await snapshot(page); mirrors(restored); expect(restored.records).toEqual(after.records);
  expect(restored.masks.every(mask => !(mask & 2))).toBe(true); expect(restored.csvRows).toHaveLength(5);
  await testInfo.attach('scale-all-native-gpu-members.json', { body: JSON.stringify({ before, picked, navigated, target, factor, after, restored }), contentType: 'application/json' });
});

test('mixed Center and Scale share the original Reset baseline and preserve current navigation through Reset history', async ({ page }, testInfo) => {
  const before = await snapshot(page); await page.evaluate(() => window.alignmentHarness.center());
  const scaled = await page.evaluate(() => window.alignmentHarness.scale()); mirrors(scaled);
  expect(scaled.summary.alignment!.frame[0]).not.toBe(1);
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigated = await snapshot(page);
  await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
  const reset = await snapshot(page); mirrors(reset); expect(reset.records).toEqual(before.records); expect(reset.masks).toEqual(before.masks);
  expect(reset.summary.alignment!.frame).toEqual(identity);
  expect(reset.camera).toEqual(await expectedCamera(page, navigated.camera, navigated.summary.alignment!.frame, identity));
  const undone = await history(page, 'Undo'); expect(undone.records).toEqual(scaled.records);
  expect(undone.camera).toEqual(await expectedCamera(page, reset.camera, identity, scaled.summary.alignment!.frame));
  const redone = await history(page, 'Redo'); expect(redone.records).toEqual(before.records);
  expect(redone.camera).toEqual(await expectedCamera(page, undone.camera, scaled.summary.alignment!.frame, identity));
  await testInfo.attach('scale-mixed-group-reset-history.json', { body: JSON.stringify({ before, scaled, navigated, reset, undone, redone }), contentType: 'application/json' });
});

test('Scale Undo and Redo carry current zoom/lens/roll and source-frame cameras rather than historical poses', async ({ page }) => {
  const before = await snapshot(page), scaled = await page.evaluate(() => window.alignmentHarness.scale());
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigated = await snapshot(page);
  const undone = await history(page, 'Undo'); mirrors(undone); expect(undone.records).toEqual(before.records);
  expect(undone.camera).toEqual(await expectedCamera(page, navigated.camera, scaled.summary.alignment!.frame, identity));
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigation = await snapshot(page);
  const redone = await history(page, 'Redo'); mirrors(redone); expect(redone.records).toEqual(scaled.records);
  expect(redone.camera).toEqual(await expectedCamera(page, navigation.camera, identity, scaled.summary.alignment!.frame));
});

test('numeric Backspace edits text; scene Backspace removes one point and retains target; right-click clears the pair and then exits', async ({ page }) => {
  await pair(page); const field = page.getByLabel('Target distance (m)', { exact: true });
  await field.fill('12'); await field.press('End'); await field.press('Backspace'); await expect(field).toHaveValue('1');
  expect((await snapshot(page)).alignmentSecondPoint).not.toBeNull();
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Backspace');
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentSecondPoint: null, alignmentTargetDistance: 1 });
  const point = await page.evaluate(() => window.alignmentHarness.pixel(3)); await page.mouse.click(point.clientX, point.clientY, { button: 'right' });
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: 'scale', alignmentPoint: null, alignmentTargetDistance: null });
  await page.mouse.click(point.clientX, point.clientY, { button: 'right' });
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentTool)).toBeNull();
});

test('the actual duplicate contributor refusal removes the retained point without geometry/history changes', async ({ page }) => {
  const before = await snapshot(page); await start(page); await clickPoint(page, 3); await clickPoint(page, 3);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentPoint: null, error: 'Pick a different point.' });
  retained(await snapshot(page), before);
});

for (const kind of ['admission', 'gpu', 'cancel'] as const) test(`${kind} Scale refusal retains both points, target, GPU/native owners and executable Redo`, async ({ page }, testInfo) => {
  const result = await page.evaluate(kind => window.alignmentHarness.refusal(kind, 'scale'), kind);
  expect(result.accepted).toBe(false); retained(result.after, result.before);
  expect(result.after.alignmentPoint).toEqual(result.before.alignmentPoint);
  expect(result.after.alignmentSecondPoint).toEqual(result.before.alignmentSecondPoint);
  expect(result.after.alignmentTargetDistance).toBe(result.before.alignmentTargetDistance);
  expect(result.redone).toBe(true); mirrors(result.afterRedo);
  await testInfo.attach(`scale-${kind}-retained-redo.json`, { body: JSON.stringify(result), contentType: 'application/json' });
});

test('scaled saved thumbnails persist original-source camera coordinates and reopen with current source fit radius', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.alignmentHarness.savedRoundtrip('scale'));
  expect(result.saved.records).toHaveLength(1); expect(result.afterStorage).toEqual(result.saved);
  const record = result.saved.records[0], original = await expectedCamera(page, result.aligned.camera, result.aligned.summary.alignment!.frame, identity);
  expect(record.view).toMatchObject({ target: original.slice(0, 3), yaw: original[3], pitch: original[4], distance: original[5],
    fov: original[7], yUp: !!original[8], roll: original[9] });
  expect(record.thumbnail.sha256).toBe(result.saved.imageHashes[0]);
  const edited = [...result.aligned.camera]; edited[6] = result.resetEdited.summary.radius; edited[10] = result.resetEdited.camera[10];
  expect(result.resetEdited.camera).toEqual(edited);
  original[6] = result.reopened.summary.radius; original[10] = result.reopened.camera[10];
  expect(result.reopened.camera).toEqual(original); expect(result.reopened.summary.alignment!.frame).toEqual(identity);
  expect(result.reopened.summary.canUndo).toBe(false); expect(result.reopened.savedViewAvailable).toBe(true);
  await testInfo.attach('scale-source-coordinate-saved-view.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('Scale export/reopen keeps scaled geometry and covariance while starting an original-frame history', async ({ page }) => {
  await page.evaluate(() => window.alignmentHarness.scale());
  const result = await page.evaluate(() => window.alignmentHarness.reopenExport()); mirrors(result.before); mirrors(result.after);
  result.before.records.forEach((record, index) => {
    numeric(result.after.records[index].position, record.position); numeric(result.after.records[index].covariance, record.covariance);
    expect(result.after.records[index].opacity).toEqual(record.opacity); expect(result.after.records[index].appearance).toEqual(record.appearance);
  });
  expect(result.after.summary.alignment!.frame).toEqual(identity); expect(result.after.summary.canUndo).toBe(false);
});

test('a selection boundary retires the mixed alignment Reset group without changing scaled geometry', async ({ page }) => {
  const scaled = await page.evaluate(() => window.alignmentHarness.scale());
  await page.evaluate(() => window.alignmentHarness.command({ command: 'selectNone' })); await settled(page);
  expect((await snapshot(page)).summary.alignment!.canReset).toBe(true);
  await page.evaluate(() => window.alignmentHarness.seed([0])); await settled(page);
  const selected = await snapshot(page); mirrors(selected); expect(selected.records).toEqual(scaled.records);
  expect(selected.masks).toEqual([1, 0, 0, 0, 0]); expect(selected.summary.alignment!.canReset).toBe(false);
  await expect(tools(page).getByRole('button', { name: 'Reset transform', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.geometryViewer.controllerForRendererNavigation().resetAlignment())).toBe(false);
  await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
  retained(await snapshot(page), selected);
});

test('compact Scale controls retain explicit confirmation without background geometry baking', async ({ page }) => {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().mode)).toBe('basic');
  await page.setViewportSize({ width: 640, height: 360 });
  await page.waitForFunction(() => {
    const render = window.alignmentHarness.renderState(), camera = window.geometryViewer.controllerForRendererNavigation().camera!;
    return render.width === 640 && render.height === 360 && camera.state[10] === Math.fround(640 / 360);
  });
  await page.evaluate(() => window.alignmentHarness.pickScale());
  const before = await snapshot(page), field = page.getByLabel('Target distance (m)', { exact: true });
  await expect(field).toBeVisible(); await expect(page.getByRole('button', { name: 'Set scale', exact: true })).toBeVisible();
  await field.fill('0'); await expect(page.getByRole('button', { name: 'Set scale', exact: true })).toBeDisabled();
  await field.fill('2'); retained(await snapshot(page), before);
  await page.getByRole('button', { name: 'Cancel alignment', exact: true }).click();
  expect((await snapshot(page)).alignmentTool).toBeNull(); retained(await snapshot(page), before);
});
