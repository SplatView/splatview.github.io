import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const options = (page: Page) => panel(page).getByRole('group', { name: 'Options', exact: true });
const option = (page: Page, name: string) => options(page).getByRole('button', { name, exact: true });
// web-lite has no Pro mode; every case runs in Basic.
async function boot(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'desktop-panels-sh3.ply',
    mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('desktop-panels-sh3.ply — SplatView');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(panel(page).locator('.mode-button')).toBeHidden();
}
async function observed(page: Page) {
  return page.evaluate(async () => {
    const url = '/src/app/store.ts', { useApp } = await import(/* @vite-ignore */ url);
    const state = useApp.getState();
    return { mode: state.mode, visibleOnly: state.visibleOnly, overlap: state.overlap, live: state.live,
      connected: state.connectedColor, selected: state.summary.selected, count: state.summary.count,
      dirty: state.dirty, canUndo: state.summary.canUndo, canRedo: state.summary.canRedo, error: state.error };
  });
}
async function help(page: Page) {
  await panel(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  return settings;
}

for (const mode of ['basic'] as const) {
  test(`${mode} exposes only desktop-supported joined Selection Options and toggles them without an edit`, async ({ page }) => {
    await boot(page);
    const original = await observed(page);
    // Literal captured cleanup_context.hpp policy; independent of TOOL_OPTIONS.
    const contexts = [
      ['Single splat', ['Live selection']],
      ['Brush', ['Visible only', 'Include splat edges', 'Live selection']],
      ['Volume brush', ['Visible only', 'Include splat edges', 'Live selection']],
      ['Box select', ['Include splat edges', 'Live selection']],
      ['Polygon', ['Include splat edges', 'Live selection']],
      ['Color picker', ['Connected colors']],
      ['Fill', ['Visible only', 'Include splat edges']],
    ] as const;
    await expect(options(page)).toHaveCount(0);
    for (const [tool, labels] of contexts) {
      await chooseSelectionTool(page, tool);
      await expect(options(page)).toBeVisible();
      await expect(options(page).getByRole('button')).toHaveCount(labels.length);
      expect(await options(page).getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')))).toEqual([...labels]);
      await expect(panel(page).locator('details.options, .selection-options input[type="checkbox"]')).toHaveCount(0);
      for (const label of labels) {
        const button = option(page, label), before = await button.getAttribute('aria-pressed');
        const bounds = await button.boundingBox(); expect(bounds?.width).toBe(30); expect(bounds?.height).toBe(28);
        await button.click(); await expect(button).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
        await button.click(); await expect(button).toHaveAttribute('aria-pressed', before!);
      }
      // The Windows-aligned layout places Options beside Combine, before the
      // selection actions (windows-design.spec.ts asserts the geometry).
      expect(await panel(page).locator('.selection-actions').evaluate(element =>
        !!(element.compareDocumentPosition(element.parentElement!.querySelector('.selection-options')!) & Node.DOCUMENT_POSITION_PRECEDING))).toBe(true);
      if (tool === 'Color picker') {
        await expect(panel(page).locator('.slider-row').getByRole('button', { name: 'Connected colors', exact: true })).toHaveCount(0);
      }
      const after = await observed(page);
      expect(after).toEqual(original);
    }
    await chooseSelectionTool(page, 'Navigate'); await expect(options(page)).toHaveCount(0);
    await expect(panel(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });
}

test('Basic option preferences survive Tools hide/reopen without an edit', async ({ page }) => {
  await boot(page); await chooseSelectionTool(page, 'Brush');
  await option(page, 'Visible only').click(); await option(page, 'Include splat edges').click();
  const visible = await option(page, 'Visible only').getAttribute('aria-pressed'), edges = await option(page, 'Include splat edges').getAttribute('aria-pressed');
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(option(page, 'Visible only')).toHaveAttribute('aria-pressed', visible!);
  await expect(option(page, 'Include splat edges')).toHaveAttribute('aria-pressed', edges!);
  const state = await observed(page); expect(state.selected).toBe(0); expect(state.canUndo).toBe(false); expect(state.dirty).toBe(false); expect(state.error).toBeNull();
});

test('Basic retains its Tools scroll offset through Tools hide/reopen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await boot(page); await chooseSelectionTool(page, 'Brush');
  const body = panel(page).locator('.tools-body');
  const basic = await body.evaluate(element => { element.scrollTop = 80; return element.scrollTop; }); expect(basic).toBeGreaterThan(20);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect.poll(() => body.evaluate(element => element.scrollTop)).toBe(basic);
});

// Basic/Pro profile switches and Pro section folding have no web-lite equivalent.

for (const mode of ['basic'] as const) {
  test(`${mode} Help opens the web About dialog with real identity, links, contained focus and Escape`, async ({ page }) => {
    await boot(page); const original = await observed(page), settings = await help(page);
    await expect(settings.getByRole('link', { name: 'Help & feedback', exact: true })).toHaveAttribute('href', 'https://opsiclear.com/');
    await expect(settings.getByRole('link', { name: 'Report a bug', exact: true })).toHaveAttribute('href', 'mailto:support@opsiclear.com?subject=SplatView%20web%20bug%20report');
    await settings.getByRole('button', { name: 'About', exact: true }).click();
    await expect(settings).toHaveCount(0);
    const about = page.getByRole('dialog', { name: 'About', exact: true }), close = about.getByRole('button', { name: 'Close about', exact: true });
    await expect(about).toBeVisible(); await expect(about).toHaveAttribute('aria-modal', 'true'); await expect(close).toBeFocused();
    await expect(about.locator('[data-web-version]')).toHaveText('0.1.0');
    const identity = await page.evaluate(async () => { const url = '/src/generated/buildIdentity.ts'; return (await import(/* @vite-ignore */ url)).BUILD_DESCRIPTOR.appInputId; });
    expect(identity).toMatch(/^[0-9a-f]{64}$/); await expect(about.locator('[data-app-input-id]')).toHaveText(identity);
    const website = about.getByRole('link', { name: 'Help & feedback', exact: true }), feedback = about.getByRole('link', { name: 'Report a bug', exact: true });
    await expect(website).toHaveAttribute('rel', 'noopener noreferrer'); await expect(feedback).toHaveAttribute('href', /^mailto:support@opsiclear\.com\?/);
    await close.press('Shift+Tab'); await expect(feedback).toBeFocused();
    await feedback.press('Tab'); await expect(close).toBeFocused();
    await close.press('Tab'); await expect(website).toBeFocused();
    await website.press('Escape'); await expect(about).toHaveCount(0); await expect(page.getByLabel('SplatView scene', { exact: true })).toBeFocused();
    expect(await observed(page)).toEqual(original);
    const reopened = await help(page); await reopened.getByRole('button', { name: 'About', exact: true }).click();
    await about.getByRole('button', { name: 'Close about', exact: true }).click(); await expect(about).toHaveCount(0);
  });
}
