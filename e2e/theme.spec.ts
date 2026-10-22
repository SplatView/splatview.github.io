import { expect, test, type Page } from '@playwright/test';
import type {} from './opacity-harness';

const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const theme = (page: Page) => settings(page).getByRole('button', { name: 'Theme', exact: true });
const menu = (page: Page) => page.getByRole('listbox', { name: 'Theme choices', exact: true });
const option = (page: Page, name: string) => menu(page).getByRole('option', { name, exact: true });
const root = (page: Page) => page.locator('html');
const saved = (page: Page) => page.evaluate(() => localStorage.getItem('splatview.ui-theme.v1'));
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.opacityHarness.state();
    return { busy: state.busy, ready: state.rendererState, error: state.error };
  })).toEqual({ busy: false, ready: 'ready', error: null });
}
async function choose(page: Page, name: string) {
  await theme(page).click(); await option(page, name).click();
  await expect(menu(page)).toHaveCount(0);
}
function unchanged(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  for (const key of ['records', 'gpuRecords', 'masks', 'gpuMasks', 'grade', 'appliedGrade', 'sourceFingerprint', 'camera', 'tool', 'fly', 'autoOrbit', 'scale'] as const)
    expect(after[key], key).toEqual(before[key]);
  for (const key of ['contentRevision', 'selected', 'visible', 'canUndo', 'canRedo'] as const)
    expect(after.summary[key], key).toEqual(before.summary[key]);
}
const bakes = (commands: string[]) => commands.filter(command => ['grade', 'autoColor', 'applyOpacity', 'resetOpacity', 'applyTransform'].includes(command));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(async () => {
    await window.opacityHarness.load('theme-preservation-sh3.ply');
    await window.opacityHarness.selectedFixture();
    await window.opacityHarness.command({ command: 'invert' });
    await window.opacityHarness.command({ command: 'undo' });
  });
  await settled(page); await page.mouse.move(640, 400);
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen)
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const brightness = page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('slider', { name: 'Brightness', exact: true });
  await brightness.press('Enter');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).fill('1.25');
  await page.getByRole('textbox', { name: 'Brightness value', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.opacityHarness?.stop()); });

test('native eight-theme order and compact selector precede Font size without changing the scene', async ({ page }) => {
  const before = await snapshot(page); expect(before.summary.canRedo).toBe(true); expect(before.grade[0]).toBe(1.25);
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'dark'); await expect(theme(page)).toHaveAttribute('aria-description', 'Current theme: Dark');
  expect((await theme(page).boundingBox())!.height).toBe(21);
  expect((await theme(page).boundingBox())!.y).toBeLessThan((await settings(page).getByRole('button', { name: 'Font size', exact: true }).boundingBox())!.y);
  await theme(page).click();
  const ordered = ['System', 'Dark', 'Bright', 'Solar', 'Slate', 'Midnight', 'Forest', 'Rose'];
  await expect(menu(page).getByRole('option')).toHaveCount(ordered.length);
  for (const [index, name] of ordered.entries()) await expect(menu(page).getByRole('option').nth(index)).toHaveAccessibleName(name);
  for (const item of await menu(page).getByRole('option').all()) {
    expect((await item.boundingBox())!.height).toBe(28); await expect(item.locator('.icon svg')).toHaveCount(1);
  }
  await expect(option(page, 'Dark')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape'); unchanged(await snapshot(page), before);
});

test('Bright empty viewer uses the native window palette and leaves the Open action readable', async ({ page }, info) => {
  await page.evaluate(() => localStorage.setItem('splatview.ui-theme.v1', 'bright'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled();
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright');
  await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'false');
  await expect(page.locator('main')).toHaveCSS('background-color', 'rgb(237, 240, 244)');
  await expect(page.getByRole('heading', { name: 'Your scene, in focus.', exact: true })).toHaveCount(0);
  await expect(page.getByText('Drop a Gaussian splat file to begin.', { exact: true })).toHaveCSS('color', 'rgb(97, 102, 110)');
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  await expect(page.locator('canvas')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({ path: info.outputPath('actual-theme-bright-empty.png') });
});

test('all seven literal desktop palettes change chrome while exact native, GPU, Redo and rendered scene stay unchanged', async ({ page }, info) => {
  const before = await snapshot(page), image = await page.evaluate(() => window.opacityHarness.capture());
  await page.evaluate(() => window.opacityHarness.observe());
  // Independent literal panel/text byte expectations from ui_design.hpp.
  const palettes = [
    ['Bright', 'bright', 'rgb(247, 249, 251)', 'rgb(31, 33, 38)'],
    ['Solar', 'solar', 'rgb(251, 245, 224)', 'rgb(61, 56, 46)'],
    ['Slate', 'slate', 'rgb(36, 43, 54)', 'rgb(235, 240, 245)'],
    ['Midnight', 'midnight', 'rgb(18, 22, 41)', 'rgb(232, 237, 255)'],
    ['Forest', 'forest', 'rgb(19, 36, 29)', 'rgb(230, 245, 235)'],
    ['Rose', 'rose', 'rgb(251, 242, 245)', 'rgb(64, 43, 54)'],
    ['Dark', 'dark', 'rgb(22, 22, 22)', 'rgb(232, 232, 232)'],
  ] as const;
  const observations = [];
  for (const [name, code, panelColor, textColor] of palettes) {
    await choose(page, name); await expect(root(page)).toHaveAttribute('data-ui-theme', code);
    await expect(settings(page)).toHaveCSS('background-color', panelColor); await expect(settings(page)).toHaveCSS('color', textColor);
    expect(await saved(page)).toBe(code); const current = await snapshot(page); unchanged(current, before);
    expect((await page.evaluate(() => window.opacityHarness.capture())).samples).toEqual(image.samples);
    await theme(page).click(); await expect(menu(page)).toHaveCSS('background-color', panelColor);
    await expect(option(page, name)).toHaveAttribute('aria-selected', 'true'); await page.keyboard.press('Escape');
    observations.push({ name, panelColor, textColor, current });
  }
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await info.attach('theme-palettes-native-gpu-history-preservation', { body: JSON.stringify({ before, image, observations }), contentType: 'application/json' });
});

test('pointer preview is ephemeral and Escape restores the committed palette and trigger focus', async ({ page }) => {
  const before = await snapshot(page); await theme(page).click(); await option(page, 'Bright').hover();
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright'); await expect(theme(page)).toHaveAttribute('aria-description', 'Current theme: Bright');
  expect(await saved(page)).toBeNull(); await expect(option(page, 'Dark')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape'); await expect(root(page)).toHaveAttribute('data-ui-theme', 'dark'); await expect(theme(page)).toBeFocused();
  expect(await saved(page)).toBeNull(); unchanged(await snapshot(page), before);
});

test('keyboard preview wraps in native order, commits on Enter and Tabs through Theme then Font size', async ({ page }) => {
  const close = settings(page).getByRole('button', { name: 'Close Settings', exact: true });
  await expect(close).toBeFocused(); await page.keyboard.press('Tab'); await expect(settings(page).getByRole('tab', { name: 'General', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(settings(page).getByRole('button', { name: 'Language', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(theme(page)).toBeFocused(); await page.keyboard.press('ArrowDown');
  await expect(option(page, 'Dark')).toBeFocused(); await page.keyboard.press('ArrowDown'); await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright');
  await page.keyboard.press('End'); await expect(option(page, 'Rose')).toBeFocused(); await expect(root(page)).toHaveAttribute('data-ui-theme', 'rose');
  await page.keyboard.press('ArrowDown'); await expect(option(page, 'System')).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(option(page, 'Dark')).toBeFocused(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(theme(page)).toBeFocused(); expect(await saved(page)).toBe('bright');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Tab');
  await expect(menu(page)).toHaveCount(0); await expect(settings(page).getByRole('button', { name: 'Font size', exact: true })).toBeFocused();
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright');
});

test('System follows live browser color-scheme changes while an explicit choice remains fixed', async ({ page }) => {
  const before = await snapshot(page); await page.emulateMedia({ colorScheme: 'light' }); await choose(page, 'System');
  expect(await saved(page)).toBe('system'); await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright');
  await expect(theme(page)).toHaveAttribute('aria-description', 'Current theme: System');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(root(page)).toHaveAttribute('data-ui-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' }); await expect(root(page)).toHaveAttribute('data-ui-theme', 'bright');
  await choose(page, 'Forest'); await page.emulateMedia({ colorScheme: 'dark' }); await expect(root(page)).toHaveAttribute('data-ui-theme', 'forest');
  unchanged(await snapshot(page), before);
});

test('the saved theme reloads and an unrecognized stored value falls back to native Dark', async ({ page }) => {
  await choose(page, 'Solar'); await page.reload();
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'solar');
  await page.evaluate(() => localStorage.setItem('splatview.ui-theme.v1', 'unknown-theme')); await page.reload();
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'dark');
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
});

test('a refused preference save cancels preview and retains committed choice, exact scene and executable Redo', async ({ page }, info) => {
  await choose(page, 'Solar'); const before = await snapshot(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Object.assign(window, { restoreThemeStorage: () => { Storage.prototype.setItem = original; } });
    Storage.prototype.setItem = function(key, value) {
      if (key === 'splatview.ui-theme.v1') throw new DOMException('Test refusal', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  await theme(page).click(); await option(page, 'Forest').hover(); await expect(root(page)).toHaveAttribute('data-ui-theme', 'forest');
  await option(page, 'Forest').click(); await expect(root(page)).toHaveAttribute('data-ui-theme', 'solar'); expect(await saved(page)).toBe('solar');
  await expect(settings(page).getByRole('alert')).toContainText('Could not save'); await expect(theme(page)).toBeFocused();
  const refused = await snapshot(page); unchanged(refused, before);
  await page.evaluate(() => (window as unknown as { restoreThemeStorage(): void }).restoreThemeStorage());
  await choose(page, 'Forest'); await expect(settings(page).getByRole('alert')).toHaveCount(0); expect(await saved(page)).toBe('forest');
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  // History navigation first cancels an existing unapplied grading preview.
  // Cancel it explicitly so this click tests the retained native Redo endpoint.
  await page.getByRole('button', { name: 'Reset color preview', exact: true }).click(); await settled(page);
  const readyForRedo = await snapshot(page); expect(readyForRedo.masks).toEqual(before.masks); expect(readyForRedo.summary.canRedo).toBe(true);
  await page.getByRole('complementary', { name: 'Tools', exact: true }).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const redone = await snapshot(page); expect(redone.masks).toEqual([1, 1, 0, 1, 1, 2]);
  await info.attach('theme-save-refusal-retained-native-history', { body: JSON.stringify({ before, refused, readyForRedo, redone }), contentType: 'application/json' });
});

test('outside dismissal, window blur and resize or ancestor scroll notifications retire only the transient preview', async ({ page }) => {
  const before = await snapshot(page);
  for (const boundary of ['outside', 'blur', 'resize', 'scroll'] as const) {
    if (boundary === 'scroll') await settings(page).getByRole('tabpanel', { name: 'General', exact: true }).evaluate(element => {
      (element as HTMLElement).style.maxHeight = '160px'; element.scrollTop = 0;
    });
    await theme(page).click(); await option(page, 'Rose').hover(); await expect(root(page)).toHaveAttribute('data-ui-theme', 'rose');
    if (boundary === 'outside') await settings(page).getByRole('heading', { name: 'Settings', exact: true }).click();
    else if (boundary === 'scroll') {
      const moved = await settings(page).getByRole('tabpanel', { name: 'General', exact: true }).evaluate(element => {
        const previous = element.scrollTop; element.scrollTop += 16; return element.scrollTop > previous;
      }); expect(moved).toBe(true);
    } else await page.evaluate(boundary => window.dispatchEvent(new Event(boundary)), boundary);
    await expect(menu(page)).toHaveCount(0); await expect(root(page)).toHaveAttribute('data-ui-theme', 'dark');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  }
  expect(await saved(page)).toBeNull(); unchanged(await snapshot(page), before);
});

test('the Theme portal owns scene shortcuts and both primary undo modifiers without editing scene or camera', async ({ page }) => {
  const before = await snapshot(page); await page.evaluate(() => window.opacityHarness.observe());
  await theme(page).press('ArrowDown');
  for (const key of ['g', 'b', 'c', 'x', 'i', 'p', 'r', 'o', 'PageDown', 'Control+z', 'Meta+z']) await page.keyboard.press(key);
  await expect(menu(page)).toBeVisible(); unchanged(await snapshot(page), before);
  expect(bakes(await page.evaluate(() => window.opacityHarness.commands()))).toEqual([]);
  await page.keyboard.press('Escape'); await expect(theme(page)).toBeFocused();
});

test('switching Settings tabs unmounts Theme preview and reopening retains only the committed theme', async ({ page }) => {
  await choose(page, 'Slate'); const before = await snapshot(page);
  await theme(page).click(); await option(page, 'Bright').hover();
  await settings(page).getByRole('tab', { name: 'Help', exact: true }).click(); await expect(menu(page)).toHaveCount(0);
  await expect(root(page)).toHaveAttribute('data-ui-theme', 'slate');
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click(); await expect(theme(page)).toHaveAttribute('aria-description', 'Current theme: Slate');
  unchanged(await snapshot(page), before);
});

for (const size of ['Small', 'Large']) test(`${size} compact Settings keeps Theme reachable, scrolls its own menu and preserves native geometry`, async ({ page }, info) => {
  await page.setViewportSize({ width: 420, height: 240 });
  await settings(page).getByRole('button', { name: 'Font size', exact: true }).click();
  await page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: size, exact: true }).click();
  const before = await snapshot(page);
  const panel = settings(page).getByRole('tabpanel', { name: 'General', exact: true });
  const ancestorScroll = await panel.evaluate(element => element.scrollTop);
  await theme(page).press('ArrowDown');
  for (const [key, name] of [['End', 'Rose'], ['Home', 'System'], ['End', 'Rose']]) {
    await page.keyboard.press(key); await expect(option(page, name)).toBeFocused();
    await expect(option(page, name)).toBeInViewport({ ratio: 1 });
    const revealed = await menu(page).evaluate((element, choice) => {
      const item = element.querySelector<HTMLElement>(`[data-theme="${choice.toLowerCase()}"]`)!;
      const row = item.getBoundingClientRect(), popup = element.getBoundingClientRect();
      const top = popup.top + element.clientTop, bottom = top + element.clientHeight;
      return { contained: row.top >= top - 0.25 && row.bottom <= bottom + 0.25, scroll: element.scrollTop };
    }, name);
    expect(revealed.contained).toBe(true);
    if (name === 'Rose') expect(revealed.scroll).toBeGreaterThan(0);
    expect(await panel.evaluate(element => element.scrollTop)).toBe(ancestorScroll);
  }
  await expect(menu(page)).toBeVisible();
  const bounds = (await menu(page).boundingBox())!; expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.y).toBeGreaterThanOrEqual(12);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(408); expect(bounds.y + bounds.height).toBeLessThanOrEqual(228);
  await page.keyboard.press('Enter'); await expect(root(page)).toHaveAttribute('data-ui-theme', 'rose');
  expect((await theme(page).boundingBox())!.height).toBe(size === 'Small' ? 21 : 25); unchanged(await snapshot(page), before);
  await page.screenshot({ path: info.outputPath(`actual-theme-rose-${size.toLowerCase()}-420x240.png`) });
});
