import { expect, test } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

for (const failure of ['missing-api', 'no-adapter', 'claimed-canvas'] as const) test(`automatic App startup retains Basic editing after ${failure} WebGPU failure`, async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(failure => {
    if (failure === 'missing-api') Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined });
    else if (failure === 'no-adapter') navigator.gpu.requestAdapter = async () => null;
    else {
      const configure = GPUCanvasContext.prototype.configure;
      GPUCanvasContext.prototype.configure = function (...args) { configure.apply(this, args); throw new Error('The actual claimed WebGPU presentation was refused.'); };
    }
  }, failure);
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  const canvas = page.getByLabel('SplatView scene', { exact: true }); await expect(canvas).toHaveAttribute('data-graphics-backend', 'webgl2');
  await page.getByLabel('Open scene files').setInputFiles({ name: 'automatic-fallback-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(3)) });
  await expect(page).toHaveTitle('automatic-fallback-sh3.ply — SplatView');
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true });
  await tools.getByRole('button', { name: 'Select all', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await tools.getByRole('button', { name: 'Delete selected', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText('0/0 splats | SH3');
  await tools.getByRole('button', { name: 'Undo', exact: true }).click(); await expect(tools.locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await tools.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings.getByRole('combobox', { name: 'Gaussian renderer', exact: true })).toHaveValue('sorted');
  await expect(settings.getByText('WebGPU is unavailable. Using WebGL2.', { exact: true })).toBeVisible();
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await settings.getByText('Graphics diagnostics', { exact: true }).click();
  await expect(settings.getByRole('combobox', { name: 'Graphics backend', exact: true })).toHaveValue('auto');
  const diagnostics = JSON.parse(await settings.locator('.graphics-diagnostics pre').innerText());
  expect(diagnostics.backend).toBe('webgl2'); expect(diagnostics.fallbackReason).toBeTruthy();
  await info.attach('actual-fallback-environment.json', { body: JSON.stringify({ failure, diagnostics, environment: await page.evaluate(() => ({ userAgent: navigator.userAgent, secureContext: isSecureContext, crossOriginIsolated })) }), contentType: 'application/json' });
  await settings.getByRole('tab', { name: 'General', exact: true }).click();
  await settings.getByRole('combobox', { name: 'Gaussian renderer', exact: true }).selectOption('steady');
  await expect(settings.getByText('Preparing SteadySplats…', { exact: true })).toBeHidden();
  await expect(settings.getByText('SteadySplats is unavailable for this view. Using sorted rendering.', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a forced WebGPU override reports its failure without selecting another backend', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => undefined }));
  await page.goto('/?graphics=webgpu');
  await expect(page.getByRole('button', { name: 'Retry graphics', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeDisabled();
  await expect(page.getByLabel('SplatView scene', { exact: true })).not.toHaveAttribute('data-graphics-backend', 'webgl2');
});
