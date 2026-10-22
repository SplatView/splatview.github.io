import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const stats = (page: Page) => panel(page).locator('.model-stats');
const bytes = gaussianPly(0);

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    // A separate read-only adapter probe with the renderer's request options;
    // this does not claim access to the renderer's owned adapter or GPU memory.
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return {
      userAgent: navigator.userAgent, platform: navigator.platform,
      secureContext: isSecureContext, webGpu: !!navigator.gpu,
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null,
      devicePixelRatio, viewport: { width: innerWidth, height: innerHeight }, origin: location.origin,
    };
  });
  await info.attach('browser-environment.json', {
    body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json',
  });
});

async function open(page: Page, content = bytes, name = 'web-lite.ply') {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}');
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(content) });
  await expect(page).toHaveTitle(`${name} — SplatView`);
  await page.mouse.move(640, 400);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
}

test('web-lite omits advanced selection and retains cleanup history and manual flips', async ({ page }) => {
  await open(page);
  await expect(panel(page)).toHaveAttribute('data-tutorial-display-mode', 'basic');
  await expect(panel(page).locator('.mode-button')).toBeHidden();
  await expect(page.getByRole('button', { name: /agent access/i })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Current view only', exact: true })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Duplicate selection', exact: true })).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await panel(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH0');
  await panel(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await panel(page).getByRole('button', { name: 'Flip X', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Apply transform', exact: true })).toBeEnabled();
  await panel(page).getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Color and Fill keep ordinary picking without offering Range', async ({ page }) => {
  const [header, body] = new TextDecoder().decode(bytes).split('end_header\n');
  const single = new TextEncoder().encode(`${header.replace('element vertex 3', 'element vertex 1')}end_header\n${body.split('\n')[0]}\n`);
  await open(page, single, 'web-lite-picking.ply');
  for (const tool of ['Color picker', 'Fill']) {
    await chooseSelectionTool(page, tool);
    await expect(panel(page).getByRole('button', { name: 'Range', exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole('slider', { name: 'Selection tolerance', exact: true })).toBeEnabled();
    const canvas = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await expect(stats(page)).toHaveText('1/1 splats | SH0');
    await panel(page).getByRole('button', { name: 'Clear selection', exact: true }).click();
    await expect(stats(page)).toHaveText('0/1 splats | SH0');
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
});

test('the complete projected tutorial uses available targets and restores the loaded selection', async ({ page }, info) => {
  await open(page);
  await panel(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await panel(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await settings.locator('[data-tutorial-replay]').click();
  const layer = page.locator('.tutorial-layer'), card = layer.locator('.tutorial-card[role="dialog"]');
  await expect(layer).toHaveAttribute('data-tutorial-phase', 'tour');
  const excluded = ['filter', 'refine', 'duplicate', 'current-view', 'range', 'pro-color', 'floor', 'coordinates', 'pivot', 'modes'];
  const counter = await layer.locator('.tutorial-counter').innerText();
  const total = Number(counter.match(/^Tutorial 1 \/ (\d+)$/)?.[1]);
  expect(total).toBe(20);
  const targets: string[] = [];
  for (let index = 1; index <= total; index++) {
    await expect(layer).toHaveAttribute('data-tutorial-step', String(index));
    const target = (await layer.getAttribute('data-tutorial-active-target'))!;
    expect(excluded).not.toContain(target); targets.push(target);
    await expect(layer).toHaveAttribute('data-tutorial-target-status', 'visible');
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`).first()).toBeVisible();
    await expect(layer.locator('.tutorial-highlight').first()).toBeVisible();
    await card.getByRole('button', { name: index === total ? 'Finish' : 'Next', exact: true }).click();
  }
  await expect(layer).toHaveCount(0);
  await expect(page).toHaveTitle('web-lite.ply — SplatView');
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await expect(panel(page)).toHaveAttribute('data-tutorial-display-mode', 'basic');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('web-lite-tutorial-targets.json', { body: JSON.stringify({ total, targets }), contentType: 'application/json' });
});
