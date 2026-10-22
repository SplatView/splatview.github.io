import { expect, test } from '@playwright/test';
import type {} from './floor-worker-harness';

// Floor detection (alignment.auto) is excluded from web-lite; the scene worker
// refuses detectFloor before it reaches native, so no floor owner is created.
test('web-lite scene worker refuses Floor detection before native dispatch', async ({ page }) => {
  await page.goto('/e2e/floor-worker-harness.html');
  await page.waitForFunction(() => window.floorWorkerError || window.floorWorker?.ready());
  expect(await page.evaluate(() => window.floorWorkerError)).toBeUndefined();
  await expect(page.evaluate(() => window.floorWorker.ownedCancellation()))
    .rejects.toThrow('This action is unavailable in the lightweight web editor: detectFloor');
  await page.evaluate(() => window.floorWorker.dispose());
});
