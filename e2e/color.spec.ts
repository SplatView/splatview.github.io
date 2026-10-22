import { expect, test, type Page } from '@playwright/test';
import { fixtureCenters } from './sceneCoordinates';
import { chooseSelectionTool } from './selectTool';

const positions = [[-.8, 0, 0], [-.4, .4, 0], [0, 0, 0], [.4, .4, 0], [.8, 0, 0]];
// SH0 gives camera-independent colors. The two identical colors are separated
// by three different colors: ordinary Color must match across the scene.
const colors = [[.6, .4, .3], [.62, .4, .3], [.8, .4, .3], [.1, .8, .1], [.6, .4, .3]];
function colorPly() {
  const properties = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const header = ['ply', 'format ascii 1.0', 'element vertex 5', ...properties.map(name => `property float ${name}`), 'end_header'];
  const body = positions.map((point, index) => [...point, ...colors[index].map(color => (color - .5) / .2820947918),
    1.38629436, -2.65926004, -2.65926004, -2.65926004, 1, 0, 0, 0].join(' '));
  return new TextEncoder().encode([...header, ...body, ''].join('\n'));
}
const bytes = colorPly();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const slider = (page: Page) => page.getByRole('slider', { name: 'Selection tolerance', exact: true });
async function ready(page: Page) { await expect(page.locator('.status.panel')).toHaveCount(0); }
async function selected(page: Page, count: number) {
  await expect(panel(page).locator('.model-stats')).toHaveText(new RegExp(`^${count.toLocaleString('en-US')}/[\\d,]+ splats \\| SH[0-3]$`)); await ready(page);
}
async function tolerance(page: Page, percent: number | string) {
  await slider(page).click({ button: 'right' });
  const input = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await input.fill(String(percent)); await input.press('Enter'); await ready(page);
}
async function pick(page: Page, index = 0) {
  const centers = await fixtureCenters(page, bytes, positions);
  await page.mouse.click(...centers[index] as [number, number]); await ready(page); return centers;
}
test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'color-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('color-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Color picker');
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
});

test('ordinary Color selects the matching scene colors on release, including a disconnected splat', async ({ page }) => {
  const centers = await fixtureCenters(page, bytes, positions);
  await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down(); await selected(page, 0);
  await page.mouse.up(); await selected(page, 2);
  await expect(page.getByRole('button', { name: 'Connected colors', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Connected colors', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('5'); await page.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const stream = await (await downloading).createReadStream(); const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
  expect(rows).toHaveLength(2); expect(rows.map(row => Number(row[0].toFixed(2))).sort((a, b) => a - b)).toEqual([-.8, .8]);
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Color tolerance grows and shrinks against its original mask in one Undo entry', async ({ page }) => {
  await pick(page); await selected(page, 2);
  // RMS RGB distances from the seed are .02/sqrt(3) and .2/sqrt(3).
  // The desktop squares displayed fractions: 11% and 35% cross those boundaries.
  for (const [percent, count] of [[11, 3], [35, 4], [0, 2], [100, 5], [1, 2]]) { await tolerance(page, percent); await selected(page, count); }
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await selected(page, 2); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Color tolerance accepts continued exact typing and pointer dragging while amendments coalesce', async ({ page }) => {
  await pick(page); await selected(page, 2);
  await slider(page).click({ button: 'right' });
  const exact = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await exact.pressSequentially('35', { delay: 5 }); await selected(page, 4);
  await expect(exact).toBeFocused(); await expect(exact).toBeEnabled(); await exact.press('Escape'); await selected(page, 2);
  const bounds = (await slider(page).boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .67, bounds.y + bounds.height / 2); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .95, bounds.y + bounds.height / 2, { steps: 15 });
  await page.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height / 2, { steps: 15 });
  await page.mouse.up(); await selected(page, 2); await expect(slider(page)).toBeEnabled();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('each Color Combine operation adjusts against its captured baseline', async ({ page }) => {
  for (const [operation, baseline, initial, expanded] of [
    ['Replace', 5, 2, 3], ['Add', 0, 2, 3], ['Subtract', 5, 3, 2], ['Intersect', 5, 2, 3],
  ] as const) {
    await page.getByRole('button', { name: baseline ? 'Select all' : 'Clear selection', exact: true }).click(); await selected(page, baseline);
    await page.getByRole('button', { name: operation, exact: true }).click(); await tolerance(page, 1);
    await pick(page); await selected(page, initial); await tolerance(page, 11); await selected(page, expanded);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, baseline);
  }
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a no-op Color pick can become an adjustable selection without consuming an extra Undo', async ({ page }) => {
  await tolerance(page, 100); await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 5);
  await pick(page); await selected(page, 5); await tolerance(page, 1); await selected(page, 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 5);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('empty Color clicks preserve every Combine mask and the previous valid tolerance checkpoint', async ({ page }) => {
  await pick(page); await selected(page, 2);
  for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect']) {
    await page.getByRole('button', { name: operation, exact: true }).click(); await page.mouse.click(400, 700); await selected(page, 2);
  }
  await tolerance(page, 11); await selected(page, 3);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

// Basic/Pro selection-profile restoration has no web-lite equivalent: Pro mode is excluded.

test('an explicit selection-option assignment ends Color ownership even when its value is unchanged', async ({ page }) => {
  await pick(page); await selected(page, 2);
  // Color's option controls are correctly disabled. Exercise the shared
  // explicit option action, which must differ from restoring a mode profile.
  await page.evaluate(async () => {
    // Reuse the loaded module URL, including Vite's HMR timestamp, so this
    // test never creates a second independent store in a reused dev server.
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')?.name;
    if (!url) throw new Error('The app store module was not loaded.');
    const { useApp, setSelectionPreferences } = await import(/* @vite-ignore */ url);
    setSelectionPreferences({ overlap: useApp.getState().overlap });
  });
  await tolerance(page, 100); await selected(page, 2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Color ignores a drag beyond five CSS pixels and retains the last adjustable pick', async ({ page }) => {
  const centers = await pick(page); await selected(page, 2);
  await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down(); await page.mouse.move(centers[0][0] + 6, centers[0][1]);
  await selected(page, 2); await page.mouse.up(); await selected(page, 2);
  await tolerance(page, 35); await selected(page, 4);
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const invalidation of ['camera', 'tool', 'history'] as const) test(`Color tolerance cannot revive a checkpoint after ${invalidation} changes`, async ({ page }) => {
  const centers = await pick(page); await selected(page, 2);
  if (invalidation === 'camera') {
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down({ button: 'right' });
    await page.mouse.move(centers[0][0] + 30, centers[0][1] + 10); await page.mouse.up({ button: 'right' });
  } else if (invalidation === 'tool') {
    await chooseSelectionTool(page, 'Brush'); await chooseSelectionTool(page, 'Color picker');
  } else { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); }
  await tolerance(page, 100); await selected(page, invalidation === 'history' ? 0 : 2);
  if (invalidation === 'history') { await page.getByRole('button', { name: 'Redo', exact: true }).click(); await selected(page, 2); await tolerance(page, 0); await selected(page, 2); }
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Color uses the desktop logarithmic percent scale, exact entry, independent preferences and brush default', async ({ page }) => {
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%');
  await slider(page).fill('0.5'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '0.1%');
  await tolerance(page, '0.123456789'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '0.1235%');
  await slider(page).click({ button: 'right' });
  const exact = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  expect(Number(await exact.inputValue())).toBeCloseTo(.123456789, 12); await exact.fill('11'); await exact.press('Escape');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '0.1235%');
  await tolerance(page, -5); await expect(slider(page)).toHaveValue('0');
  await tolerance(page, 150); await expect(slider(page)).toHaveValue('1');
  await tolerance(page, '.00001234'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '1.234e-05%');
  await tolerance(page, 35); await chooseSelectionTool(page, 'Brush');
  await expect(page.getByRole('slider', { name: 'Brush size', exact: true })).toHaveValue('48');
  // A focused Tools control does not own the scene's Ctrl+E shortcut.
  await page.getByRole('button', { name: 'Replace', exact: true }).focus(); await page.keyboard.press('ControlOrMeta+e');
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Brush', { exact: true })).toBeVisible();
  const viewport = page.getByLabel('SplatView scene', { exact: true }); await viewport.focus(); await expect(viewport).toBeFocused();
  await page.keyboard.press('ControlOrMeta+e');
  await expect(page.getByRole('button', { name: 'Selection tool', exact: true }).getByText('Color picker', { exact: true })).toBeVisible();
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '35%');
  await chooseSelectionTool(page, 'Fill');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%');
  await chooseSelectionTool(page, 'Color picker');
  await expect(slider(page)).toHaveAttribute('aria-valuetext', '35%');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('Retina Color', () => {
  test.use({ deviceScaleFactor: 2 });
  test('uses framebuffer contributor coordinates and a five CSS-pixel click tolerance', async ({ page }) => {
    const centers = await fixtureCenters(page, bytes, positions);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down();
    await page.mouse.move(centers[0][0] + 4, centers[0][1]); await page.mouse.up(); await selected(page, 2);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down();
    await page.mouse.move(centers[0][0] + 6, centers[0][1]); await page.mouse.up(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});
