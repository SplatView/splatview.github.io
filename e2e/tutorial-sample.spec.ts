import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

const tutorialKey = 'splatview.tutorial.v1';
const exampleTitle = 'Bench example.sog — SplatView';
const layer = (page: Page) => page.locator('.tutorial-layer');
const card = (page: Page) => layer(page).getByRole('dialog', { name: 'Tutorial', exact: true });
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const stats = (page: Page) => tools(page).locator('.model-stats');
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

type TutorialSampleFault = { sourceLoads: number; held: boolean; release(): void };
declare global {
  interface Window { tutorialSampleFault?: TutorialSampleFault }
}

// Exercise the real first-run offer rather than the cohort's handled default.
test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

async function injectSampleFault(page: Page, mode: 'delay' | 'fail') {
  await page.addInitScript(mode => {
    const original = Worker.prototype.postMessage;
    let delayed: (() => void) | undefined;
    const control: TutorialSampleFault = { sourceLoads: 0, held: false, release() {
      const send = delayed; delayed = undefined; control.held = false; send?.();
    } };
    window.tutorialSampleFault = control;
    Worker.prototype.postMessage = function(this: Worker,
      ...args: [message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions]): void {
      const message = args[0];
      if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'source-load') {
        control.sourceLoads++;
        if (control.sourceLoads === 1) {
          if (mode === 'fail') throw new Error('Injected tutorial sample load failure');
          control.held = true;
          // Keep the actual Worker, argument objects and transferable ownership
          // untouched. Reflect.apply preserves both postMessage overloads and
          // whether the caller supplied its optional argument at all.
          delayed = () => { Reflect.apply(original, this, args); };
          return;
        }
      }
      Reflect.apply(original, this, args);
    };
  }, mode);
}

async function boot(page: Page, handled = false) {
  await page.addInitScript(({ handled, key }) => {
    localStorage.setItem('splatview.ui-language.v1', 'en');
    if (handled) localStorage.setItem(key, JSON.stringify({ tutorial_prompt_handled: 'handled' }));
  }, { handled, key: tutorialKey });
  await page.goto('/');
  // The ready viewer may already be inert behind its first-run offer.
  await expect(page.getByRole('button', { name: 'Open scene', exact: true, includeHidden: true })).toBeEnabled();
}

async function showTools(page: Page) {
  await page.mouse.move(640, 400);
  if (!await tools(page).isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page)).toBeVisible();
}

async function showSettings(page: Page) {
  await page.mouse.move(640, 400);
  if (!await page.getByRole('button', { name: 'Settings', exact: true }).isVisible()) await showTools(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

async function replay(page: Page) {
  await showSettings(page);
  await settings(page).getByRole('tab', { name: 'Help', exact: true }).click();
  const trigger = settings(page).getByRole('button', { name: 'Tutorial', exact: true });
  await expect(trigger).toBeEnabled(); await trigger.click();
  await expect(settings(page)).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
}

async function assertDirtyAndStay(page: Page) {
  await showSettings(page);
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Close scene', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Unsaved changes', exact: true });
  await expect(prompt).toContainText('This scene has unsaved edits.');
  await prompt.getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await showTools(page);
}

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    // Independent adapter probe, not access to the renderer's owned adapter.
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return { userAgent: navigator.userAgent, platform: navigator.platform, origin: location.origin,
      secureContext: isSecureContext, webGpu: !!navigator.gpu, devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null };
  });
  await info.attach('browser-environment.json', {
    body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json',
  });
});

test('first Start opens the sample before all 20 Essentials steps and keeps an editable document after Finish', async ({ page }, info) => {
  await boot(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await expect(page).toHaveTitle('SplatView');
  await expect(page.locator('.empty-state')).toHaveCount(1);
  await card(page).getByRole('button', { name: 'Start', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(page).toHaveTitle(exampleTitle);
  await expect(page.locator('.empty-state')).toHaveCount(0);
  await expect(layer(page).locator('.tutorial-counter')).toHaveText('Tutorial 1 / 20');

  const targets: string[] = [];
  for (let step = 1; step <= 20; step++) {
    await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(step));
    await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
    const target = await layer(page).getAttribute('data-tutorial-active-target');
    expect(target).toBeTruthy(); targets.push(target!);
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`).first()).toBeVisible();
    await expect(layer(page).locator('.tutorial-highlight').first()).toBeVisible();
    await card(page).getByRole('button', { name: step === 20 ? 'Finish' : 'Next', exact: true }).click();
  }
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(exampleTitle);
  await showTools(page);
  await expect(stats(page)).toHaveText('0/262,556 splats | SH3');
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(stats(page)).toHaveText('262,556/262,556 splats | SH3');
  await tools(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH3');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('262,556/262,556 splats | SH3');
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('sample-tutorial-targets.json', { body: JSON.stringify({ total: 20, targets }), contentType: 'application/json' });
});

test('offering and skipping the tutorial leave the viewer empty across reload', async ({ page }) => {
  await boot(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await expect(page).toHaveTitle('SplatView');
  await expect(page.locator('.empty-state')).toHaveCount(1);
  await card(page).getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(layer(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), tutorialKey);
  expect(stored.tutorial_prompt_handled).toBe('handled'); expect(stored.tutorial_version ?? 0).toBe(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Scene status', exact: true })).toContainText('No scene open.');
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle('SplatView');
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Help replay from an empty viewer opens the sample and Close leaves it available', async ({ page }) => {
  await boot(page, true);
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  await expect(page).toHaveTitle('SplatView');
  await replay(page);
  await expect(page).toHaveTitle(exampleTitle);
  await card(page).getByRole('button', { name: 'Close tutorial', exact: true }).click();
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(exampleTitle);
  await showTools(page);
  await expect(tools(page).locator('.model-info')).toHaveText('Bench example.sog');
  await expect(stats(page)).toHaveText('0/262,556 splats | SH3');
  await expect(tools(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Help replay preserves a loaded dirty user scene and executable native Redo', async ({ page }) => {
  await boot(page, true);
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: 'tutorial-user.ply',
    mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(0)) });
  await expect(page).toHaveTitle('tutorial-user.ply — SplatView');
  await showTools(page);
  await expect(tools(page).getByRole('button', { name: 'Flip X', exact: true })).toBeEnabled();
  await tools(page).getByRole('button', { name: 'Flip X', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Apply transform', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Apply transform', exact: true })).toBeHidden();
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await tools(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH0');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await assertDirtyAndStay(page);
  const beforeTitle = await page.title();

  await replay(page);
  await expect(page).toHaveTitle(beforeTitle);
  await expect(page.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Close tutorial', exact: true }).click();
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(beforeTitle);
  await showTools(page);
  await expect(tools(page).locator('.model-info')).toHaveText('tutorial-user.ply');
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await assertDirtyAndStay(page);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(stats(page)).toHaveText('0/0 splats | SH0');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(stats(page)).toHaveText('3/3 splats | SH0');
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('pending sample preparation rejects duplicate Start and Escape retires only the tutorial presentation', async ({ page }) => {
  await injectSampleFault(page, 'delay');
  await boot(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  // Both clicks are real input. Once the first starts preparation, the disabled
  // Start control must prevent another intake from being queued.
  await card(page).getByRole('button', { name: 'Start', exact: true }).dblclick();
  await expect.poll(() => page.evaluate(() => window.tutorialSampleFault?.held)).toBe(true);
  await expect(card(page)).toHaveAttribute('aria-busy', 'true');
  await expect(card(page).getByRole('button', { name: 'Opening scene', exact: true })).toBeDisabled();
  const skip = card(page).getByRole('button', { name: 'Skip', exact: true });
  await expect(skip).toBeEnabled(); await expect(skip).toBeFocused();
  await page.evaluate(() => {
    // Simulate an outside portal trying to take focus while Start is disabled.
    // Remove this test-only element immediately; no application hook is added.
    const outside = document.createElement('button');
    outside.textContent = 'Test external focus target'; document.body.append(outside);
    try { outside.focus(); } finally { outside.remove(); }
  });
  await expect(skip).toBeFocused();
  expect(await page.evaluate(() => window.tutorialSampleFault?.sourceLoads)).toBe(1);
  await expect(page).toHaveTitle('SplatView');

  await page.keyboard.press('Escape');
  await expect(layer(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.tutorialSampleFault?.held)).toBe(true);
  await page.evaluate(() => window.tutorialSampleFault!.release());
  // Dismissing the tour does not replace the controller's ordinary load owner.
  // Its completed document remains usable without resurrecting the overlay.
  await expect(page).toHaveTitle(exampleTitle);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('status', { name: 'Scene status', exact: true }))
    .toContainText('Ready. Bench example.sog.');
  await expect(layer(page)).toHaveCount(0);
  await showTools(page);
  await expect(stats(page)).toHaveText('0/262,556 splats | SH3');
  expect(await page.evaluate(() => window.tutorialSampleFault?.sourceLoads)).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('sample load failure shows the normal error without a phantom tour and Help replay retries', async ({ page }) => {
  await injectSampleFault(page, 'fail');
  await boot(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await card(page).getByRole('button', { name: 'Start', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'Injected tutorial sample load failure' });
  await expect(error).toBeVisible();
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle('SplatView');
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.tutorialSampleFault?.sourceLoads)).toBe(1);
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  await replay(page);
  await expect(page).toHaveTitle(exampleTitle);
  expect(await page.evaluate(() => window.tutorialSampleFault?.sourceLoads)).toBe(2);
  await card(page).getByRole('button', { name: 'Close tutorial', exact: true }).click();
  await expect(layer(page)).toHaveCount(0);
  await showTools(page);
  await expect(stats(page)).toHaveText('0/262,556 splats | SH3');
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
