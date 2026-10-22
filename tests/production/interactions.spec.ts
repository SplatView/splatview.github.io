import { expect, test } from '@playwright/test';
import { queuePly } from '../../e2e/queue-fixture';

test('shipped hover menus, browser wheel admission and T saved view preserve executable native Redo', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  const source = { name: 'shipped-interactions.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(queuePly()) };
  await page.getByLabel('Open scene files').setInputFiles(source);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  if (!(await tools.isVisible())) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const scene = page.getByLabel('SplatView scene', { exact: true });
  await tools.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText(/^5\/5 splats \| SH0$/);
  await scene.focus(); await page.keyboard.press('Delete');
  await expect(tools.locator('.model-stats')).toHaveText(/^0\/0 splats \| SH0$/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(tools.locator('.model-stats')).toHaveText(/^5\/5 splats \| SH0$/);
  const redo = tools.getByRole('button', { name: 'Redo', exact: true }); await expect(redo).toBeEnabled();

  await tools.getByRole('button', { name: 'Auto color', exact: true }).hover();
  const menu = page.getByRole('menu', { name: 'Auto color actions', exact: true });
  await expect(menu).toBeVisible(); await expect(scene).toBeFocused();
  await expect(redo).toBeEnabled(); await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    expect(await scene.evaluate((canvas, modifier) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, [modifier]: true });
      canvas.dispatchEvent(event); return event.defaultPrevented;
    }, modifier)).toBe(false);
  }

  const background = page.getByRole('button', { name: 'Background', exact: true });
  await background.click(); await expect(background).toHaveAttribute('data-background', 'gray');
  await page.mouse.move(800, 400); await scene.focus(); await page.keyboard.press('t');
  await expect(page.locator('.output-receipt[role="status"]')).toContainText('Thumbnail and default view saved in this browser.');
  await expect(page.getByRole('button', { name: 'Capture image', exact: true })).toBeEnabled();
  await expect(redo).toBeEnabled();
  await background.click(); await expect(background).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background).toHaveAttribute('data-background', 'gray');
  await redo.click(); await expect(tools.locator('.model-stats')).toHaveText(/^0\/0 splats \| SH0$/);
  await tools.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools.locator('.model-stats')).toHaveText(/^5\/5 splats \| SH0$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
