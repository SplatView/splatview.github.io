import { expect, test } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

test('lightweight profile offers manual editing without advanced controls', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({
    name: 'product-profile.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(0)),
  });
  await expect(page).toHaveTitle('product-profile.ply — SplatView');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true });
  await expect(panel).toHaveAttribute('data-tutorial-display-mode', 'basic');
  await expect(panel.getByRole('button', { name: 'Selection tool', exact: true })).toBeEnabled();
  await expect(panel.getByRole('button', { name: 'Selection filter', exact: true })).toHaveCount(0);
  await expect(panel.locator('.mode-button')).toBeHidden();
  await expect(panel.getByRole('slider', { name: 'Brightness', exact: true })).toBeVisible();
  await expect(panel.getByRole('slider', { name: 'Gamma', exact: true })).toBeHidden();
  await expect(panel.getByRole('slider', { name: 'Fade / boost', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('spinbutton', { name: 'Translation X', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Alignment', exact: true })).toBeEnabled();
  await panel.getByRole('button', { name: 'Alignment', exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: /1-point center/ })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /Level floor/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('web-lite.png') });
});
