import { expect, test, type Page } from '@playwright/test';
import type {} from './opacity-harness';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const slider = (page: Page, label: string) => panel(page).getByRole('slider', { name: label, exact: true });
const entry = (page: Page, label: string) => panel(page).getByRole('textbox', { name: `${label} value`, exact: true });
const apply = (page: Page) => panel(page).getByRole('button', { name: 'Apply color', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
const state = (page: Page) => page.evaluate(() => window.opacityHarness.state());
const neutral = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
async function settled(page: Page) {
  await expect.poll(async () => {
    const value = await state(page);
    return { busy: value.busy, ready: value.rendererState, error: value.error };
  }).toEqual({ busy: false, ready: 'ready', error: null });
}
async function edit(page: Page, label: string, text: string) {
  await slider(page, label).press('Enter'); await expect(entry(page, label)).toBeFocused();
  await entry(page, label).fill(text);
}
function unchangedNative(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(after.records).toEqual(before.records); expect(after.gpuRecords).toEqual(before.gpuRecords);
  expect(after.masks).toEqual(before.masks); expect(after.gpuMasks).toEqual(before.gpuMasks);
  expect(after.summary.contentRevision).toBe(before.summary.contentRevision);
  expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
  expect(after.sourceFingerprint).toEqual(before.sourceFingerprint); expect(after.camera).toEqual(before.camera);
}
const bakes = (commands: string[]) => commands.filter(name => ['grade', 'autoColor', 'applyOpacity', 'resetOpacity', 'applyTransform'].includes(name));

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.opacityHarness.load('grading-input-sh3.ply')); await settled(page);
  await page.mouse.move(640, 400);
  if (!(await state(page)).toolsOpen) await page.getByRole('button', { name: 'Tools', exact: true }).click();
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.opacityHarness?.stop()); });

// web-lite exposes the four color.basic sliders; the other eleven grade
// channels and Fade / boost opacity are excluded (color.advanced).
test('the four Basic native formats and display-unit bounds', async ({ page }) => {
  const expected = [
    ['Brightness', '1.00×', 0, 5], ['Contrast', '100%', 0, 500],
    ['Saturation', '100%', 0, 500], ['Temperature', '0', -100, 100],
  ] as const;
  await expect(panel(page).getByRole('group', { name: 'Color grading', exact: true }).getByRole('slider')).toHaveCount(4);
  for (const [label, text, low, high] of expected) {
    const range = slider(page, label); await expect(range).toHaveAttribute('aria-valuetext', text);
    expect(Number(await range.getAttribute('min'))).toBeCloseTo(low, 6);
    expect(Number(await range.getAttribute('max'))).toBeCloseTo(high, 6);
    await expect(range.locator('..').locator('output')).toHaveText(text);
    expect((await range.locator('..').boundingBox())!.height).toBe(21);
  }
  await expect(slider(page, 'Fade / boost')).toHaveCount(0);
});

test('opening formatted entry leaves hidden precision unchanged and direct text stages actual GPU color without baking', async ({ page }, info) => {
  const before = await snapshot(page), imageBefore = await page.evaluate(() => window.opacityHarness.capture());
  await page.evaluate(() => window.opacityHarness.observe());
  await slider(page, 'Brightness').click({ modifiers: ['Control'] });
  await expect(entry(page, 'Brightness')).toBeFocused(); await expect(entry(page, 'Brightness')).toHaveValue('1.00');
  await entry(page, 'Brightness').fill('1.375123456'); await entry(page, 'Brightness').press('Enter');
  const typed = await snapshot(page); expect(typed.grade[0]).toBe(Math.fround(1.375123456));
  await expect(slider(page, 'Brightness')).toHaveAttribute('aria-valuetext', '1.38×');
  await slider(page, 'Brightness').press('Enter'); await expect(entry(page, 'Brightness')).toHaveValue('1.38');
  await entry(page, 'Brightness').press('Escape'); const closed = await snapshot(page);
  expect(closed.grade).toEqual(typed.grade); unchangedNative(closed, before);
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  const imageStaged = await page.evaluate(() => window.opacityHarness.capture()); expect(imageStaged.samples).not.toEqual(imageBefore.samples);
  await expect(apply(page)).toBeEnabled();
  await info.attach('formatted-entry-precision-native-gpu-preview', { body: JSON.stringify({ before, typed, closed, imageBefore, imageStaged }), contentType: 'application/json' });
});

test('percent, multiplier and temperature text clamp in their native display units without implicit Apply', async ({ page }) => {
  const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  for (const [label, text, index, value] of [
    ['Contrast', '123.456789%', 1, Math.fround(Math.fround(123.456789) / 100)],
    ['Brightness', '1.125×', 0, 1.125], ['Saturation', '-5%', 3, 0], ['Temperature', '250', 5, 1],
  ] as const) {
    await edit(page, label, text); await entry(page, label).press('Enter'); expect((await state(page)).grade[index]).toBe(value);
  }
  unchangedNative(await snapshot(page), before); expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await expect(slider(page, 'Brightness')).toHaveAttribute('aria-valuetext', '1.12×');
});

test('Escape conditionally restores native formatted entry and preserves edits hidden by the same format', async ({ page }) => {
  await edit(page, 'Brightness', '1.234'); await entry(page, 'Brightness').press('Enter');
  await edit(page, 'Brightness', '1.231'); await entry(page, 'Brightness').press('Escape');
  expect((await state(page)).grade[0]).toBe(Math.fround(1.231));
  await edit(page, 'Brightness', '1.4'); await entry(page, 'Brightness').press('Escape');
  expect((await state(page)).grade[0]).toBe(Math.fround(1.23));
});

test('blank and malformed drafts fence Auto, Presets and Apply until correction or explicit Reset', async ({ page }) => {
  await edit(page, 'Brightness', '1.25'); const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  for (const invalid of ['', '1.2junk', 'NaN']) {
    await entry(page, 'Brightness').fill(invalid); await expect(entry(page, 'Brightness')).toHaveAttribute('aria-invalid', 'true');
    await expect(apply(page)).toBeDisabled(); await expect(panel(page).getByRole('button', { name: 'Auto color', exact: true })).toBeDisabled();
    await expect(panel(page).getByRole('button', { name: 'Color preset', exact: true })).toBeDisabled();
    await entry(page, 'Brightness').press('Enter'); await expect(entry(page, 'Brightness')).toBeFocused();
    expect((await state(page)).grade[0]).toBe(1.25);
  }
  unchangedNative(await snapshot(page), before); expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await panel(page).getByRole('button', { name: 'Reset color preview', exact: true }).click();
  await expect(entry(page, 'Brightness')).toHaveCount(0); expect((await state(page)).grade).toEqual(neutral);
  await expect(panel(page).getByRole('button', { name: 'Color preset', exact: true })).toBeEnabled(); await expect(apply(page)).toBeHidden();
});

test('numeric text owns selection, undo and navigation keys while pointer right-click enters the same field', async ({ page }) => {
  await slider(page, 'Brightness').click({ button: 'right' }); await expect(entry(page, 'Brightness')).toBeFocused();
  await entry(page, 'Brightness').fill('1.25'); const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  for (const key of ['c', 'i', 'g', 'b', 'x', 'p', 'ArrowUp', 'ArrowDown', 'Control+z']) await entry(page, 'Brightness').press(key);
  const after = await snapshot(page); unchangedNative(after, before); expect(after.camera).toEqual(before.camera);
  expect(after.tool).toBe(before.tool); expect(after.fly).toBe(before.fly); expect(after.autoOrbit).toBe(before.autoOrbit);
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await expect(entry(page, 'Brightness')).toBeFocused();
});

test('native Left/Right increments honor Ctrl slow and Shift fast without HTML vertical steps', async ({ page }) => {
  await slider(page, 'Brightness').focus(); await slider(page, 'Brightness').press('ArrowRight'); expect((await state(page)).grade[0]).toBe(Math.fround(1.05));
  // The first half-cent step stays below the binary32 formatting boundary;
  // its retained normalized remainder carries the next slow step to 1.06.
  await slider(page, 'Brightness').press('Control+ArrowRight'); expect((await state(page)).grade[0]).toBe(Math.fround(1.05));
  await slider(page, 'Brightness').press('Control+ArrowRight'); expect((await state(page)).grade[0]).toBe(Math.fround(1.06));
  await slider(page, 'Brightness').press('Shift+ArrowRight'); expect((await state(page)).grade[0]).toBe(Math.fround(1.56));
  await slider(page, 'Contrast').press('ArrowRight'); expect((await state(page)).grade[1]).toBe(Math.fround(1.05));
  await slider(page, 'Contrast').press('Control+ArrowRight'); expect((await state(page)).grade[1]).toBe(Math.fround(1.06));
  const before = await snapshot(page);
  for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) await slider(page, 'Contrast').press(key);
  const after = await snapshot(page); expect(after.grade).toEqual(before.grade); unchangedNative(after, before);
});

test('Basic preset choices retain the explicit seven and stage a preview without baking', async ({ page }) => {
  const trigger = panel(page).getByRole('button', { name: 'Color preset', exact: true }); await trigger.click();
  const menu = page.getByRole('menu', { name: 'Color presets', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['neutral', 'warm', 'cool', 'vibrant', 'muted', 'cinematic', 'grayscale']);
  await page.evaluate(() => window.opacityHarness.observe());
  await menu.getByRole('menuitemradio', { name: 'warm', exact: true }).click();
  expect((await state(page)).grade).not.toEqual(neutral);
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
});

// Folding the Color section is Pro-only panel layout; Basic has no section toggles.

test('Apply publishes only selected color attributes, and native Undo restores the unchanged entry bytes', async ({ page }, info) => {
  await page.evaluate(() => window.opacityHarness.selectedFixture()); const before = await snapshot(page);
  await edit(page, 'Brightness', '1.25'); await entry(page, 'Brightness').press('Enter'); const staged = await snapshot(page); unchangedNative(staged, before);
  await apply(page).click(); await settled(page); const accepted = await snapshot(page);
  expect(accepted.appliedGrade[0]).toBe(1.25); expect(accepted.summary.contentRevision).toBe(before.summary.contentRevision + 1);
  expect(accepted.records[2].otherBytes).not.toEqual(before.records[2].otherBytes);
  accepted.records.forEach((record, index) => {
    expect(record.alphaBytes).toEqual(before.records[index].alphaBytes);
    expect(record.otherBytes.slice(0, 36)).toEqual(before.records[index].otherBytes.slice(0, 36));
    if (index !== 2) expect(record).toEqual(before.records[index]);
  });
  expect(accepted.masks).toEqual(before.masks); await panel(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const restored = await snapshot(page); expect(restored.records).toEqual(before.records); expect(restored.masks).toEqual(before.masks);
  await info.attach('numeric-selected-grade-apply-undo', { body: JSON.stringify({ before, staged, accepted, restored }), contentType: 'application/json' });
});

// Held Fade / boost opacity sessions are excluded from web-lite (color.advanced).
