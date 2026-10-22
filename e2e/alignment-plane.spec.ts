import { expect, test, type Page } from '@playwright/test';
import type {} from './alignment-harness';

type Snapshot = Awaited<ReturnType<Window['alignmentHarness']['snapshot']>>;
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.alignmentHarness.snapshot());
const confirm = (page: Page) => page.getByRole('button', { name: 'Align plane', exact: true });
const flip = (page: Page) => page.getByRole('button', { name: 'Flip normal', exact: true });
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({
    busy: false, alignmentPicking: false, enabled: true, planeEnabled: true });
}
function mirrors(value: Snapshot) {
  expect(value.records).toEqual(value.gpuRecords); expect(value.masks).toEqual(value.gpuMasks);
  expect(value.nativeRecordHash).toBe(value.gpuRecordHash); expect(value.work).toEqual({ allocations: 0, bytes: 0 });
  expect(value.summary).toMatchObject({ pending: false, transaction: false, selectionDraft: false, shDegree: 3 });
}
function retained(value: Snapshot, before: Snapshot) {
  mirrors(value);
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'nativeRecordHash', 'exported', 'camera', 'defaultCamera',
    'checkpoints', 'background', 'sourceFingerprint'] as const) expect(value[key], key).toEqual(before[key]);
  expect(value.summary.alignment).toEqual(before.summary.alignment); expect(value.summary.camera).toEqual(before.summary.camera);
  expect(value.summary).toMatchObject({ count: before.summary.count, visible: before.summary.visible, selected: before.summary.selected,
    contentRevision: before.summary.contentRevision, canUndo: before.summary.canUndo, canRedo: before.summary.canRedo });
}
function numeric(actual: ArrayLike<number>, expected: ArrayLike<number>) {
  expect(actual).toHaveLength(expected.length); Array.from(actual).forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
}
async function start(page: Page) {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: 'Alignment', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Alignment actions', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: '1-point center', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: '2-point scale', exact: true })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: '3-point align', exact: true })).toBeEnabled();
  // Level floor is alignment.auto, which web-lite excludes.
  await expect(menu.getByRole('menuitemradio', { name: 'Level floor', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitemradio', { name: '3-point align', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: 'align',
    alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: false });
}
async function clickPoint(page: Page, id: number) {
  const point = await page.evaluate(id => window.alignmentHarness.pixel(id), id); await page.mouse.click(point.clientX, point.clientY);
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentPicking)).toBe(false);
}
async function triple(page: Page) {
  await start(page); await expect(confirm(page)).toBeDisabled();
  await clickPoint(page, 3); await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentPoint)).not.toBeNull();
  await expect(confirm(page)).toBeDisabled();
  await clickPoint(page, 4); await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentSecondPoint)).not.toBeNull();
  await expect(confirm(page)).toBeDisabled();
  await clickPoint(page, 0); await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().alignmentNormal)).not.toBeNull();
  await expect(confirm(page)).toBeEnabled(); return page.evaluate(() => window.alignmentHarness.state());
}
async function history(page: Page, action: 'Undo' | 'Redo') {
  await page.mouse.move(20, 200); await tools(page).getByRole('button', { name: action, exact: true }).click();
  await settled(page); return snapshot(page);
}
async function nativeCarry(page: Page, state: readonly number[], before: readonly number[], after: readonly number[], policy: 0 | 1 = 0) {
  return page.evaluate(({ state, before, after, policy }) => window.alignmentHarness.expectedFrameCamera(state, before, after, policy),
    { state, before, after, policy });
}
async function placement(page: Page) {
  const observe = () => page.evaluate(() => {
    const rect = (element: Element) => {
      const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height };
    };
    const popup = rect(document.querySelector('.alignment-popup')!);
    const shaft = document.querySelector('.alignment-normal'), head = document.querySelector('.alignment-normal-head');
    const normalParts = [shaft, head].filter((element): element is Element => !!element).map(element => {
      const value = rect(element), stroke = element === shaft ? Number.parseFloat(getComputedStyle(element).strokeWidth) / 2 : 0;
      return { x: value.x - stroke, y: value.y - stroke, width: value.width + stroke * 2, height: value.height + stroke * 2 };
    });
    const normalBounds = normalParts.length ? {
      x: Math.min(...normalParts.map(value => value.x)), y: Math.min(...normalParts.map(value => value.y)),
      width: Math.max(...normalParts.map(value => value.x + value.width)) - Math.min(...normalParts.map(value => value.x)),
      height: Math.max(...normalParts.map(value => value.y + value.height)) - Math.min(...normalParts.map(value => value.y)),
    } : null;
    const otherControls = Array.from(document.querySelectorAll('.tools-panel, .toolbar-group'))
      .filter(element => !element.closest('.chrome-hidden') && getComputedStyle(element).visibility !== 'hidden')
      .map(element => ({ kind: element.classList.contains('tools-panel') ? 'tools' : 'toolbar', ...rect(element) }))
      .filter(value => value.width > 0 && value.height > 0);
    const disjoint = (first: typeof popup, second: typeof popup) => first.x + first.width <= second.x || second.x + second.width <= first.x ||
      first.y + first.height <= second.y || second.y + second.height <= first.y;
    return { viewport: { width: innerWidth, height: innerHeight }, popup, normalParts, normalBounds, otherControls,
      normalPresent: !!shaft && !!normalBounds && normalBounds.width > 0 && normalBounds.height > 0,
      popupOutsideNormal: !!normalBounds && disjoint(popup, normalBounds), popupOutsideControls: otherControls.every(value => disjoint(popup, value)) };
  });
  await expect.poll(observe).toMatchObject({ normalPresent: true, popupOutsideNormal: true, popupOutsideControls: true });
  return observe();
}
// Numerical reconstruction is qualified independently against actual captured
// C++ by CPU fixtures. Here the native observer checks controller pose/roll ownership.
async function carried(page: Page, before: Snapshot, after: Snapshot, activeRoll: number, defaultRoll: number, policy: 0 | 1 = 0) {
  const active = await nativeCarry(page, before.camera, before.summary.alignment!.frame, after.summary.alignment!.frame, policy);
  active[9] = activeRoll; expect(after.camera).toEqual(active);
  const defaultCamera = await nativeCarry(page, before.defaultCamera, before.summary.alignment!.frame, after.summary.alignment!.frame, policy);
  // The mutable default owner overlays the canvas ratio before Camera.set's
  // float32 admission. Its observation therefore retains the raw ratio.
  const aspect = await page.evaluate(() => {
    const canvas = window.geometryViewer.controllerForSourceNavigation().renderer!.canvas; return canvas.width / canvas.height;
  });
  defaultCamera[6] = after.summary.radius; defaultCamera[9] = defaultRoll; defaultCamera[10] = aspect;
  expect(after.defaultCamera).toEqual(defaultCamera);
}
test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/alignment-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.alignmentHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.alignmentHarness.loadPlane()); await settled(page);
});

for (const yUp of [true, false]) test(`three real contributors prepare a cheap native normal and explicit Flip/Enter aligns every SH3 member with yUp=${yUp}`, async ({ page }, testInfo) => {
  await page.evaluate(async yUp => {
    const app = window.geometryViewer.controllerForSourceNavigation();
    if (!!app.camera!.state[8] !== yUp) { app.camera!.flipUp(); app.invalidate(); }
    await window.alignmentHarness.seed([2]); await window.alignmentHarness.command({ command: 'delete' }); await window.alignmentHarness.seed([1]);
  }, yUp);
  const before = await snapshot(page), picked = await triple(page); expect(before.masks).toEqual([0, 1, 2, 0, 0]);
  await expect(page.locator('.alignment-marker text')).toHaveText(['1', '2', '3']);
  await expect(page.locator('.alignment-segment')).toHaveCount(3);
  await expect(page.locator('.alignment-normal')).toHaveCount(1);
  const layoutBeforeFlip = await placement(page);
  if (yUp) await testInfo.attach('plane-basic-three-points-ready.png', { body: await page.screenshot(), contentType: 'image/png' });
  const actualNormal = await page.evaluate(async () => {
    const state = window.alignmentHarness.state(), result = await window.geometryViewer.controllerForSourceNavigation().client!.command({
      command: 'planeNormal', points: [state.alignmentPoint, state.alignmentSecondPoint, state.alignmentThirdPoint] });
    return result.point;
  });
  expect(picked.alignmentNormal).toEqual(actualNormal); retained(await snapshot(page), before);
  const arrow = await page.locator('.alignment-normal').evaluate(element => ['x1', 'y1', 'x2', 'y2'].map(key => Number(element.getAttribute(key))));
  const changed = await page.evaluate(() => window.alignmentHarness.flip(true));
  expect(changed.calls).toEqual([]); expect(changed.cameraRevisionAfter).toBe(changed.cameraRevisionBefore);
  expect(changed.state.alignmentNormal).toEqual(picked.alignmentNormal); await expect(flip(page)).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.locator('.alignment-normal').evaluate(element => ['x1', 'y1', 'x2', 'y2'].map(key => Number(element.getAttribute(key)))))
    .not.toEqual(arrow);
  const layoutAfterFlip = await placement(page);
  retained(await snapshot(page), before);
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigated = await snapshot(page);
  expect(navigated.alignmentPoint).toEqual(picked.alignmentPoint); expect(navigated.alignmentSecondPoint).toEqual(picked.alignmentSecondPoint);
  expect(navigated.alignmentThirdPoint).toEqual(picked.alignmentThirdPoint); expect(navigated.alignmentNormal).toEqual(picked.alignmentNormal);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Enter'); await settled(page);
  const aligned = await snapshot(page); mirrors(aligned); expect(aligned.masks).toEqual(before.masks); expect(aligned.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(aligned.summary.alignment!.canReset).toBe(true); expect(aligned.alignmentTool).toBeNull(); expect(aligned.alignmentNormal).toBeNull();
  expect(aligned.camera[9]).toBe(0); expect(aligned.defaultCamera[9]).toBe(0); await carried(page, navigated, aligned, 0, 0, 1);
  // Transport/publication checks; source-oracle tests independently qualify the matrices, covariance and SH arithmetic.
  before.records.forEach((record, index) => {
    const frame = aligned.summary.alignment!.frame;
    numeric(aligned.records[index].position, [0, 1, 2].map(column => frame[12 + column] +
      record.position[0] * frame[column] + record.position[1] * frame[4 + column] + record.position[2] * frame[8 + column]));
    expect(aligned.records[index].covariance).not.toEqual(record.covariance);
    expect(aligned.records[index].appearance).not.toEqual(record.appearance);
    expect(aligned.records[index].opacity).toEqual(record.opacity);
  });
  expect(aligned.records.map(record => record.position)).not.toEqual(before.records.map(record => record.position));
  expect(aligned.summary.alignment!.frame).not.toEqual(identity);
  if (yUp) await testInfo.attach('plane-basic-applied.png', { body: await page.screenshot(), contentType: 'image/png' });
  await tools(page).getByRole('button', { name: 'Restore deleted', exact: true }).click(); await settled(page);
  const restored = await snapshot(page); mirrors(restored); expect(restored.records).toEqual(aligned.records);
  expect(restored.masks.every(mask => !(mask & 2))).toBe(true); expect(restored.csvRows).toHaveLength(5);
  await testInfo.attach(`plane-all-members-yup-${yUp}.json`, { body: JSON.stringify({ before, picked, actualNormal, changed, layoutBeforeFlip, layoutAfterFlip,
    navigated, aligned, restored }), contentType: 'application/json' });
});

test('Center, Scale and plane Align share one original Reset baseline with corrected-roll navigation through Undo and Redo', async ({ page }, testInfo) => {
  const baseline = await snapshot(page);
  await page.evaluate(() => window.alignmentHarness.center()); await page.evaluate(() => window.alignmentHarness.scale(1.5));
  const aligned = await page.evaluate(() => window.alignmentHarness.plane(true)); mirrors(aligned);
  await page.evaluate(() => { window.alignmentHarness.navigate(); window.alignmentHarness.setRoll(.8125); }); const navigation = await snapshot(page);
  await tools(page).getByRole('button', { name: 'Reset transform', exact: true }).click(); await settled(page);
  const reset = await snapshot(page); mirrors(reset); expect(reset.records).toEqual(baseline.records); expect(reset.masks).toEqual(baseline.masks);
  expect(reset.summary.alignment!.frame).toEqual(identity); expect(reset.summary.alignment!.canReset).toBe(false);
  await carried(page, navigation, reset, baseline.camera[9], baseline.defaultCamera[9]);
  const undone = await history(page, 'Undo'); mirrors(undone); expect(undone.records).toEqual(aligned.records);
  await carried(page, reset, undone, aligned.camera[9], aligned.defaultCamera[9]);
  const redone = await history(page, 'Redo'); mirrors(redone); expect(redone.records).toEqual(baseline.records);
  await carried(page, undone, redone, baseline.camera[9], baseline.defaultCamera[9]);
  await testInfo.attach('plane-mixed-group-reset-history.json', { body: JSON.stringify({ baseline, aligned, navigation, reset, undone, redone }), contentType: 'application/json' });
});

test('plane Undo and Redo carry current navigation but restore independent intentional active/default checkpoint rolls', async ({ page }, testInfo) => {
  await page.evaluate(() => window.alignmentHarness.setRoll(.625)); const before = await snapshot(page);
  const aligned = await page.evaluate(() => window.alignmentHarness.plane());
  expect(aligned.checkpoints.find(entry => entry.branchId === before.summary.alignment!.branchId)).toMatchObject({
    activeRoll: .625, defaultRoll: before.defaultCamera[9], corrected: false });
  expect(aligned.checkpoints.find(entry => entry.branchId === aligned.summary.alignment!.branchId)).toMatchObject({ activeRoll: 0, defaultRoll: 0, corrected: true });
  await page.evaluate(() => { window.alignmentHarness.navigate(); window.alignmentHarness.setRoll(.8125); }); const current = await snapshot(page);
  const undone = await history(page, 'Undo'); mirrors(undone); expect(undone.records).toEqual(before.records);
  await carried(page, current, undone, .625, before.defaultCamera[9]);
  await page.evaluate(() => { window.alignmentHarness.navigate(); window.alignmentHarness.setRoll(-.375); }); const navigation = await snapshot(page);
  const redone = await history(page, 'Redo'); mirrors(redone); expect(redone.records).toEqual(aligned.records);
  await carried(page, navigation, redone, 0, 0);
  expect(redone.checkpoints).toEqual(aligned.checkpoints);
  await testInfo.attach('plane-current-navigation-intentional-roll-history.json', { body: JSON.stringify({ before, aligned, current, undone, navigation, redone }), contentType: 'application/json' });
});

test('saving a plane default replaces only default-roll lineage; Reset camera then replaces every active roll from that default', async ({ page }, testInfo) => {
  await page.evaluate(() => window.alignmentHarness.setRoll(.625)); await page.evaluate(() => window.alignmentHarness.plane());
  await page.evaluate(() => { window.alignmentHarness.navigate(); window.alignmentHarness.setRoll(.375); }); const before = await snapshot(page);
  expect(await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().updateThumbnail())).toBe(true);
  const saved = await snapshot(page); mirrors(saved); expect(saved.defaultCamera.slice(0, 6)).toEqual(before.camera.slice(0, 6));
  for (const checkpoint of saved.checkpoints) {
    expect(checkpoint.activeRoll).toBe(before.checkpoints.find(entry => entry.branchId === checkpoint.branchId)!.activeRoll);
    const expected = await page.evaluate(({ state, frame, target }) => {
      if (frame.every((value, index) => value === target[index])) return state[9];
      const camera = window.geometryViewer.controllerForSourceNavigation().camera!;
      return camera.transformState([0, 0, 0, state[3], state[4], 3, 1, 45, state[8], state[9], 1], camera.orientationFrameChange(frame, target))[9];
    }, { state: before.camera, frame: before.summary.alignment!.frame, target: checkpoint.frame });
    expect(checkpoint.defaultRoll).toBe(expected);
  }
  await page.evaluate(() => window.alignmentHarness.navigate()); const reset = await page.evaluate(() => window.alignmentHarness.resetCamera());
  mirrors(reset); expect(reset.records).toEqual(saved.records); expect(reset.camera).toEqual(saved.defaultCamera.map(Math.fround));
  for (const checkpoint of reset.checkpoints) expect(checkpoint).toEqual({ ...saved.checkpoints.find(entry => entry.branchId === checkpoint.branchId)!, activeRoll: checkpoint.defaultRoll });
  await page.evaluate(() => window.alignmentHarness.navigate()); const navigation = await snapshot(page);
  const undone = await history(page, 'Undo'), target = reset.checkpoints.find(entry => entry.branchId === undone.summary.alignment!.branchId)!;
  await carried(page, navigation, undone, target.defaultRoll, target.defaultRoll);
  await testInfo.attach('plane-saved-default-reset-camera-roll-lineage.json', { body: JSON.stringify({ before, saved, reset, navigation, undone }), contentType: 'application/json' });
});

test('a plane thumbnail persists original-source camera coordinates and reopening restores the saved view in original history', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => window.alignmentHarness.savedRoundtrip('align'));
  expect(result.saved.records).toHaveLength(1); expect(result.afterStorage).toEqual(result.saved);
  const record = result.saved.records[0], original = await nativeCarry(page, result.aligned.camera, result.aligned.summary.alignment!.frame, identity);
  expect(record.view).toMatchObject({ target: original.slice(0, 3), yaw: original[3], pitch: original[4], distance: original[5],
    fov: original[7], yUp: !!original[8], roll: original[9] });
  expect(record.source).toEqual(result.aligned.sourceFingerprint); expect(result.resetEdited.records).toEqual(result.aligned.records);
  expect(result.resetEdited.camera).toEqual(result.aligned.camera.map((value, index) => index === 6 ? result.resetEdited.summary.radius : value));
  expect(result.reopened.summary.alignment!.frame).toEqual(identity); expect(result.reopened.summary.canUndo).toBe(false);
  original[6] = result.reopened.summary.radius; expect(result.reopened.camera).toEqual(original); mirrors(result.reopened);
  await testInfo.attach('plane-saved-source-view-roundtrip.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('plane export/reopen retains rotated positions, covariance, opacity and directional SH while starting original-frame history', async ({ page }, testInfo) => {
  await page.evaluate(() => window.alignmentHarness.plane(true)); const result = await page.evaluate(() => window.alignmentHarness.reopenExport());
  mirrors(result.before); mirrors(result.after); result.before.records.forEach((record, index) => {
    numeric(result.after.records[index].position, record.position); numeric(result.after.records[index].covariance, record.covariance);
    expect(result.after.records[index].opacity).toEqual(record.opacity);
    expect(result.after.records[index].appearance).toEqual(record.appearance);
  });
  expect(result.after.summary.alignment!.frame).toEqual(identity); expect(result.after.summary.canUndo).toBe(false); expect(result.after.checkpoints).toEqual([]);
  await testInfo.attach('plane-export-reopened-members.json', { body: JSON.stringify(result), contentType: 'application/json' });
});

test('collinear real contributors refuse the third point and permit a fresh valid third without baking geometry', async ({ page }) => {
  const before = await snapshot(page), two = await page.evaluate(() => window.alignmentHarness.pickPlane([0, 1]));
  const refused = await page.evaluate(async () => { const point = window.alignmentHarness.pixel(3); return window.geometryViewer.controllerForSourceNavigation().pickAlignmentPoint(point.x, point.y); });
  expect(refused).toBe(false); const after = await snapshot(page); retained(after, before);
  expect(after.alignmentPoint).toEqual(two.alignmentPoint); expect(after.alignmentSecondPoint).toEqual(two.alignmentSecondPoint);
  expect(after.alignmentThirdPoint).toBeNull(); expect(after.alignmentNormal).toBeNull(); expect(after.error).toBeTruthy(); await expect(confirm(page)).toBeDisabled();
  const accepted = await page.evaluate(async () => { const point = window.alignmentHarness.pixel(4); return window.geometryViewer.controllerForSourceNavigation().pickAlignmentPoint(point.x, point.y); });
  expect(accepted).toBe(true); await expect(confirm(page)).toBeEnabled(); retained(await snapshot(page), before);
});

test('a full plane ignores a distinct fourth pick; duplicate-last and Backspace remove the last candidate while retaining Flip', async ({ page }) => {
  const before = await snapshot(page), selected = await triple(page); await flip(page).click();
  const extra = await page.evaluate(async () => { const point = window.alignmentHarness.pixel(1); return window.geometryViewer.controllerForSourceNavigation().pickAlignmentPoint(point.x, point.y); });
  expect(extra).toBe(false); expect((await snapshot(page)).alignmentThirdPoint).toEqual(selected.alignmentThirdPoint);
  await clickPoint(page, 0); await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({
    alignmentTool: 'align', alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: true, error: 'Pick a different point.' });
  await expect(page.locator('.alignment-triangle-edge')).toHaveCount(0); await expect(page.locator('.alignment-normal')).toHaveCount(0);
  await expect(page.locator('.alignment-segment')).toHaveCount(1);
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Backspace');
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentSecondPoint: null, alignmentFlip: true });
  await page.keyboard.press('Enter'); retained(await snapshot(page), before); await expect(confirm(page)).toBeDisabled();
  const point = await page.evaluate(() => window.alignmentHarness.pixel(3)); await page.mouse.click(point.clientX, point.clientY, { button: 'right' });
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: 'align', alignmentPoint: null, alignmentFlip: true });
  await page.mouse.click(point.clientX, point.clientY, { button: 'right' });
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: null, alignmentFlip: false }); retained(await snapshot(page), before);
});

for (const boundary of ['camera', 'edit', 'source', 'device', 'clear'] as const) test(`an actual native plane-normal response cannot publish after its ${boundary} owner changes`, async ({ page }, testInfo) => {
  const result = await page.evaluate(boundary => window.alignmentHarness.stalePlaneNormal(boundary), boundary);
  expect(result.normal).toHaveLength(3); expect(result.accepted).toBe(false); mirrors(result.after);
  expect(result.after.alignmentThirdPoint).toBeNull(); expect(result.after.alignmentNormal).toBeNull(); expect(result.after.alignmentPicking).toBe(false);
  if (boundary === 'camera' || boundary === 'clear') {
    expect(result.after.alignmentTool).toBe('align'); expect(result.after.records).toEqual(result.before.records);
    expect(result.after.masks).toEqual(result.before.masks); expect(result.after.summary.alignment).toEqual(result.before.summary.alignment);
    expect(result.after.alignmentPoint).toEqual(result.before.alignmentPoint);
    expect(result.after.alignmentSecondPoint).toEqual(boundary === 'clear' ? null : result.before.alignmentSecondPoint);
  } else expect(result.after.alignmentTool).toBeNull();
  if (boundary === 'device') expect(result.after.deviceEpoch).not.toBe(result.before.deviceEpoch);
  await testInfo.attach(`plane-stale-native-normal-${boundary}.json`, { body: JSON.stringify(result), contentType: 'application/json' });
});

for (const kind of ['admission', 'gpu', 'cancel'] as const) test(`${kind} plane confirmation refusal joins rollback and retains three points, Flip, camera checkpoints and executable Redo`, async ({ page }, testInfo) => {
  const result = await page.evaluate(kind => window.alignmentHarness.refusal(kind, 'align'), kind);
  expect(result.accepted).toBe(false); retained(result.after, result.before);
  expect(result.after.alignmentTool).toBe('align'); expect(result.after.alignmentPoint).toEqual(result.before.alignmentPoint);
  expect(result.after.alignmentSecondPoint).toEqual(result.before.alignmentSecondPoint); expect(result.after.alignmentThirdPoint).toEqual(result.before.alignmentThirdPoint);
  expect(result.after.alignmentNormal).toEqual(result.before.alignmentNormal); expect(result.after.alignmentFlip).toBe(true);
  expect(result.decoded).toBe(kind !== 'admission'); expect(result.failed).toBe(kind !== 'admission');
  expect(result.redone).toBe(true); mirrors(result.afterRedo); expect(result.afterRedo.masks).toEqual([0, 1, 0, 0, 0]);
  await testInfo.attach(`plane-${kind}-rollback-executable-redo.json`, { body: JSON.stringify(result), contentType: 'application/json' });
});

test('O/F/V/R keyboard actions and camera ticks cannot alter staged owners while an actual native commit acknowledgement is held', async ({ page }, testInfo) => {
  const pending = await page.evaluate(() => window.alignmentHarness.beginPlaneCommitHold());
  expect(pending.held.busy).toBe(true); expect(pending.committed!.transaction).toBe(false);
  expect(pending.committed!.alignment!.branchId).not.toBe(pending.before.summary.alignment!.branchId);
  let during: Awaited<ReturnType<Window['alignmentHarness']['commitState']>>;
  try {
    await page.getByLabel('SplatView scene', { exact: true }).focus();
    for (const key of ['o', 'f', 'v', 'r']) await page.keyboard.press(key);
    // Exercise the actual queued native input owner as well as guarded App keys.
    expect(await page.evaluate(() => window.alignmentHarness.queueHeldCameraInput())).toBe(true);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
    during = await page.evaluate(() => window.alignmentHarness.commitState()); expect(during).toEqual(pending.held);
  } finally {
    const finished = await page.evaluate(() => window.alignmentHarness.finishPlaneCommitHold());
    expect(finished.accepted).toBe(true); mirrors(finished.after); await carried(page, pending.before, finished.after, 0, 0, 1);
    await testInfo.attach('plane-held-native-commit-keyboard-ownership.json', { body: JSON.stringify({ pending, finished }), contentType: 'application/json' });
  }
});

test('compact Basic presents three points and Flip without geometry baking, and Escape cancels the candidate', async ({ page }, testInfo) => {
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state().mode)).toBe('basic'); await page.setViewportSize({ width: 640, height: 300 });
  await page.waitForFunction(() => {
    const render = window.geometryViewer.renderState(), camera = window.geometryViewer.controllerForSourceNavigation().camera!;
    return render.width === 640 && render.height === 300 && camera.state[10] === Math.fround(640 / 300);
  });
  const before = await snapshot(page); await page.evaluate(() => window.alignmentHarness.pickPlane());
  await expect(confirm(page)).toBeVisible(); await expect(flip(page)).toBeVisible(); await flip(page).click(); retained(await snapshot(page), before);
  await expect(page.locator('.alignment-marker text')).toHaveText(['1', '2', '3']);
  await expect(page.locator('.alignment-segment')).toHaveCount(3);
  const layout = await placement(page);
  const bounds = await page.getByRole('region', { name: 'Alignment action', exact: true }).boundingBox();
  expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(12); expect(bounds!.y).toBeGreaterThanOrEqual(12);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(628); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(288);
  const controls = await page.getByRole('region', { name: 'Alignment action', exact: true }).locator('button').evaluateAll(elements => elements.map(element => {
    const rect = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') ?? element.textContent,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }));
  expect(controls).toHaveLength(4);
  controls.forEach((control, index) => {
    expect(control.left).toBeGreaterThanOrEqual(bounds!.x); expect(control.right).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    expect(control.top).toBeGreaterThanOrEqual(bounds!.y); expect(control.bottom).toBeLessThanOrEqual(bounds!.y + bounds!.height);
    controls.slice(index + 1).forEach(other => expect(Math.min(control.right, other.right) <= Math.max(control.left, other.left) ||
      Math.min(control.bottom, other.bottom) <= Math.max(control.top, other.top)).toBe(true));
  });
  await testInfo.attach('plane-compact-pro-three-points-flipped.png', { body: await page.screenshot(), contentType: 'image/png' });
  await testInfo.attach('plane-compact-pro-popup-bounds.json', { body: JSON.stringify({ viewport: { width: 640, height: 300 }, bounds, controls, placement: layout }), contentType: 'application/json' });
  await page.getByLabel('SplatView scene', { exact: true }).focus(); await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.alignmentHarness.state())).toMatchObject({ alignmentTool: null, alignmentPoint: null,
    alignmentSecondPoint: null, alignmentThirdPoint: null, alignmentNormal: null, alignmentFlip: false }); retained(await snapshot(page), before);
});
