import { expect, test, type Page } from '@playwright/test';
import type {} from './transform-harness';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const state = (page: Page) => page.evaluate(() => window.transformHarness.state());
const snapshot = (page: Page) => page.evaluate(() => window.transformHarness.snapshot());
const widget = (page: Page) => panel(page).getByRole('group', { name: 'Transform gizmo', exact: true });
async function settled(page: Page) {
  await expect.poll(() => state(page)).toMatchObject({ busy: false, pending: false, rendererState: 'ready', selectionRecovery: 'idle' });
}
async function gizmo(page: Page, label: 'Move' | 'Rotate' | 'Scale') {
  await widget(page).getByRole('button', { name: label, exact: true }).click();
  await expect.poll(() => state(page)).toMatchObject({ gizmoMode: label.toLowerCase(), dragging: false, gizmoEnabled: true });
}
async function drag(page: Page, handle: number) {
  const target = await page.evaluate(handle => window.transformHarness.target(handle), handle);
  await page.mouse.move(target.x, target.y); await page.mouse.down();
  await expect.poll(() => state(page)).toMatchObject({ dragging: true });
  await page.mouse.move(target.endX, target.endY, { steps: 5 }); return target;
}
function positionsClose(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((point, id) => point.forEach((value, axis) => expect(value).toBeCloseTo(expected[id][axis], 5)));
}
const bakes = (commands: string[]) => commands.filter(command => command === 'applyTransform' || command === 'transform');
type Snapshot = Awaited<ReturnType<Window['transformHarness']['snapshot']>>;
function retainedNumericGpu(after: Snapshot, entry: Snapshot) {
  // Absolute numeric preview draws the immutable entry GPU source with the
  // accepted native matrix. Raw source buffers materialize only on clean end.
  expect(after.gpuRecords).toEqual(entry.gpuRecords); expect(after.masks).toEqual(entry.masks);
  expect(after.gpuMasks).toEqual(after.masks); expect(after.preview?.kind).toBe('numeric');
  expect(after.preview!.matrix).toEqual(after.summary.transformSession!.appliedMatrix);
  expect(after.preview!.selectedOnly).toBe(after.summary.transformSession!.selectedOnly);
  expect(after.transform!.dirty).toBe(false); expect(after.summary.transformSession!.appliedEpoch).not.toBeNull();
}
async function materialized(page: Page, accepted: Snapshot) {
  expect(await page.evaluate(() => window.transformHarness.end())).toBe(true); await settled(page);
  const result = await snapshot(page); expect(result.transform).toBeNull(); expect(result.preview).toBeNull();
  expect(result.records).toEqual(accepted.records); expect(result.gpuRecords).toEqual(result.records);
  expect(result.masks).toEqual(accepted.masks); expect(result.gpuMasks).toEqual(result.masks);
  expect(result.summary.contentRevision).toBe(accepted.summary.contentRevision);
  expect(result.summary.canUndo).toBe(accepted.summary.canUndo); expect(result.summary.canRedo).toBe(accepted.summary.canRedo);
  return result;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/transform-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.transformHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.transformHarness.load());
  if (!(await state(page)).toolsOpen) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.evaluate(() => window.transformHarness.oblique()); await settled(page);
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.transformHarness?.stop()); });

// Numeric representations, absolute values, affine matrices, rotation modes and
// custom pivots are transform.numeric, which web-lite excludes.
test('Basic selected Flip X previews, explicitly applies and retains exact native/GPU history', async ({ page }, info) => {
  await page.evaluate(() => window.transformHarness.selectedFixture()); await settled(page);
  await expect.poll(() => state(page)).toMatchObject({ mode: 'basic' });
  const before = await snapshot(page); await page.evaluate(() => window.transformHarness.observe());
  const flip = panel(page).getByRole('button', { name: 'Flip X', exact: true });
  await flip.click(); await settled(page);
  const staged = await snapshot(page);
  expect(staged.records).toEqual(before.records); expect(staged.gpuRecords).toEqual(before.gpuRecords);
  expect(staged.masks).toEqual(before.masks); expect(staged.summary.contentRevision).toBe(before.summary.contentRevision);
  expect(bakes(await page.evaluate(() => window.transformHarness.commands()))).toEqual([]);
  await expect(flip).toHaveAttribute('aria-pressed', 'true');
  await panel(page).getByRole('button', { name: 'Cancel transform preview', exact: true }).click(); await settled(page);
  expect((await snapshot(page)).records).toEqual(before.records);
  expect(bakes(await page.evaluate(() => window.transformHarness.commands()))).toEqual([]);
  await flip.click(); await settled(page);
  // Basic flips about the automatic pivot (the selection center when splats are selected).
  const pivot = (await state(page)).parameters.pivot;
  await panel(page).getByRole('button', { name: 'Apply transform', exact: true }).click(); await settled(page);
  const accepted = await snapshot(page);
  positionsClose(accepted.records.map(record => record.position), before.records.map((record, id) =>
    id === 1 ? [2 * pivot[0] - record.position[0], record.position[1], 2 * pivot[2] - record.position[2]] : record.position));
  // Flip X is a 180-degree Y rotation, so the selected splat's orientation must change.
  expect(accepted.records[1].covariance).not.toEqual(before.records[1].covariance);
  retainedNumericGpu(accepted, before);
  expect(accepted.records.map(record => record.appearance)).toEqual(before.records.map(record => record.appearance));
  expect(accepted.summary.alignment).toEqual(before.summary.alignment);
  const ended = await materialized(page, accepted);
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const undone = await snapshot(page); expect(undone.records).toEqual(before.records); expect(undone.gpuRecords).toEqual(before.records);
  await panel(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const redone = await snapshot(page); expect(redone.records).toEqual(ended.records); expect(redone.gpuRecords).toEqual(ended.records);
  expect(redone.masks).toEqual(before.masks);
  await info.attach('basic-selected-flip-preview-apply-native-gpu-history', {
    body: JSON.stringify({ before, staged, accepted, ended, undone, redone }), contentType: 'application/json',
  });
});

test('Basic native Move/Rotate/Scale handles preview only, then release performs exactly one bake', async ({ page }, info) => {
  // The Basic widget uses world coordinates without Pro axis or pivot controls.
  await expect(panel(page).getByRole('button', { name: 'Local axes', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Pivot at scene center', exact: true })).toHaveCount(0);
  await expect.poll(() => state(page)).toMatchObject({ mode: 'basic' });
  const traces = [];
  for (const [label, handle] of [['Move', 1], ['Rotate', 8], ['Scale', 15]] as const) {
    await gizmo(page, label); const before = await snapshot(page); await page.evaluate(() => window.transformHarness.observe());
    await drag(page, handle); const during = await snapshot(page);
    expect(during.records).toEqual(before.records); expect(during.gpuRecords).toEqual(before.gpuRecords);
    expect(during.masks).toEqual(before.masks); expect(during.summary.revision).toBe(before.summary.revision);
    expect(during.preview!.matrix).not.toEqual(before.preview!.matrix); expect(bakes(await page.evaluate(() => window.transformHarness.commands()))).toEqual([]);
    await page.keyboard.press('Enter'); await page.keyboard.press('w'); await page.mouse.wheel(0, 100);
    expect((await state(page)).camera).toEqual(before.camera); expect((await state(page)).dragging).toBe(true);
    // Basic retains the idle gizmo after release until the Finish tray ends it.
    await page.mouse.up(); await settled(page); await expect.poll(() => state(page)).toMatchObject({ dragging: false, gizmoMode: label.toLowerCase() });
    const after = await snapshot(page); expect(after.records).not.toEqual(before.records); expect(after.gpuRecords).toEqual(after.records);
    expect(after.records.map(record => record.appearance)).toEqual(before.records.map(record => record.appearance));
    expect(bakes(await page.evaluate(() => window.transformHarness.commands()))).toEqual(['applyTransform']); traces.push({ label, handle, before, during, after });
    await page.evaluate(() => window.transformHarness.stop());
  }
  await info.attach('real-transform-native-handles-release-bake', { body: JSON.stringify(traces), contentType: 'application/json' });
});

test('captured Escape/blur/lost capture/resize/Tools hide cancel preview without native/GPU/history changes', async ({ page }) => {
  for (const cause of ['escape', 'blur', 'capture', 'resize', 'tools'] as const) {
    await gizmo(page, 'Move'); const before = await snapshot(page); await page.evaluate(() => window.transformHarness.observe()); await drag(page, 7);
    if (cause === 'escape') await page.keyboard.press('Escape');
    else if (cause === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else if (cause === 'capture') await page.evaluate(() => window.transformHarness.loseCapture());
    else if (cause === 'resize') await page.setViewportSize({ width: 1270, height: 790 });
    else await page.getByRole('button', { name: 'Tools', exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await page.mouse.up(); await settled(page); await expect.poll(() => state(page)).toMatchObject({ dragging: false });
    const after = await snapshot(page); expect(after.records).toEqual(before.records); expect(after.gpuRecords).toEqual(before.gpuRecords);
    expect(after.masks).toEqual(before.masks); expect(after.summary.revision).toBe(before.summary.revision);
    expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
    expect(bakes(await page.evaluate(() => window.transformHarness.commands()))).toEqual([]); await page.evaluate(() => window.transformHarness.stop());
    if (cause === 'tools') await page.getByRole('button', { name: 'Tools', exact: true }).click();
    if ((await state(page)).gizmoMode) await widget(page).getByRole('button', { name: 'Move', exact: true }).click();
    await settled(page);
  }
});

// Numeric drafts and Pro/Basic switching are transform.numeric and absent in web-lite.
