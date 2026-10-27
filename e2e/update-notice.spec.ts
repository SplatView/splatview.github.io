import { expect, test, type Page } from '@playwright/test';
import type {} from './ui-size-harness';
import type { UiTheme } from '../src/app/themePreferences';

async function load(page: Page, size = 'small', language = 'en', theme: UiTheme = 'dark') {
  await page.addInitScript(({ size, language, theme }) => {
    localStorage.setItem('splatview.ui-size.v1', size);
    localStorage.setItem('splatview.ui-language.v1', language);
    localStorage.setItem('splatview.ui-theme.v1', theme);
  }, { size, language, theme });
  await page.goto('/e2e/ui-size-harness.html');
  await page.locator('.toolbar button[data-tutorial-target="tools"]').click();
}
const notice = (page: Page) => page.locator('.offline-update-notice');
const offer = (page: Page, available = true) => page.evaluate(value => window.uiSizeHarness.updateAvailable(value), available);

test('a distinct candidate appears beside viewer controls and disappears when withdrawn', async ({ page }) => {
  await load(page);
  await expect(notice(page)).toHaveCount(0);
  await offer(page);
  const toolbar = page.getByRole('toolbar', { name: 'Scene controls', exact: true });
  const action = toolbar.getByRole('group', { name: 'Viewer panel', exact: true }).getByRole('button', { name: 'Update available', exact: true });
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(action.locator('.update-notice-label')).toBeVisible();
  const bounds = (await action.boundingBox())!, bar = (await toolbar.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(bar.y);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(bar.y + bar.height);
  expect(bounds.y).toBeLessThan(100);
  await offer(page, false); await expect(notice(page)).toHaveCount(0);
});

test('late compact availability updates row rounding without changing total toolbar bounds', async ({ page }) => {
  await load(page); await page.setViewportSize({ width: 360, height: 480 });
  const toolbar = page.getByRole('toolbar'), tools = toolbar.locator('button[data-tutorial-target="tools"]');
  await expect(tools).toHaveAttribute('data-row-end', '');
  const before = (await toolbar.boundingBox())!;
  await offer(page);
  await expect(notice(page)).toHaveAttribute('data-row-end', '');
  await expect(tools).not.toHaveAttribute('data-row-end', '');
  const after = (await toolbar.boundingBox())!;
  expect(after.width).toBe(before.width); expect(after.height).toBe(before.height);
  expect((await notice(page).boundingBox())!.y).toBe((await tools.boundingBox())!.y);
  await offer(page, false); await expect(tools).toHaveAttribute('data-row-end', '');
});

test('keyboard activation opens Help without navigation and returns focus to the notice', async ({ page }) => {
  await load(page); await offer(page);
  const before = await page.evaluate(() => window.uiSizeHarness.application()), url = page.url();
  await notice(page).focus(); await page.keyboard.press('Enter');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Help', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(notice(page)).toBeDisabled(); expect(page.url()).toBe(url);
  expect(await page.evaluate(() => window.uiSizeHarness.application())).toEqual(before);
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0);
  await expect(notice(page)).toBeEnabled(); await expect(notice(page)).toBeFocused();
});

test('withdrawing the candidate while Help is open keeps a usable focus fallback', async ({ page }) => {
  await load(page); await offer(page); await notice(page).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await offer(page, false); await expect(notice(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeFocused();
});

for (const [width, theme] of [[360, 'bright'], [1280, 'dark']] as const) {
  test(`large French ${theme} update control fits ${width}px and retains its accessible name`, async ({ page }, info) => {
    await load(page, 'large', 'fr', theme); await page.setViewportSize({ width, height: 480 }); await offer(page);
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', theme);
    await expect(notice(page)).toBeVisible();
    const label = notice(page).locator('.update-notice-label');
    const accessibleName = await notice(page).getAttribute('aria-label');
    expect(accessibleName).toBeTruthy(); expect(accessibleName).not.toBe('Update available');
    await expect(notice(page)).toHaveAttribute('title', accessibleName!);
    if (width <= 640) { await expect(label).toBeHidden(); expect((await notice(page).boundingBox())!.width).toBe(36); }
    else await expect(label).toBeVisible();
    expect(await page.locator('main').evaluate(element => element.scrollWidth)).toBeLessThanOrEqual(width);
    const bounds = (await notice(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.x + bounds.width).toBeLessThanOrEqual(width - 12);
    await page.screenshot({ path: info.outputPath('update-toolbar.png') });
    await info.attach('update-toolbar-appearance-only', { path: info.outputPath('update-toolbar.png'), contentType: 'image/png' });
  });
}
