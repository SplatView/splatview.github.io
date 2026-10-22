import { expect, test, type Page } from '@playwright/test';
import type {} from './opacity-harness';
import type {} from './filter-harness';
import type {} from './transform-harness';
import { TUTORIAL_VERSION } from '../src/app/tutorialCatalog';
import { TUTORIAL_OFFER_TEXT } from '../src/app/tutorialCourse';
import { EXAMPLE_SCENE } from '../src/app/exampleScene';
import { BROWSER_TUTORIAL_COURSES } from './tutorial-courses';

// tutorial-catalog.test.ts independently parses the pinned desktop v7 source.
// Start and Help replay present Essentials; assertions use its semantic step
// identities so reordering cannot silently move a native/GPU preservation
// checkpoint to an unrelated control.
const COURSE = BROWSER_TUTORIAL_COURSES.essentials.steps;
const STEPS = COURSE.map(step => [step.title, step.target] as const);
function stepIndex(id: string) {
  const index = COURSE.findIndex(step => step.id === id);
  if (index < 0) throw new Error(`Missing tutorial step ${id}`);
  return index + 1;
}
const TUTORIAL_KEY = 'splatview.tutorial.v1';
const layer = (page: Page) => page.locator('.tutorial-layer');
const card = (page: Page) => layer(page).locator('.tutorial-card[role="dialog"]');
const opacity = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
const storage = (page: Page) => page.evaluate(key => localStorage.getItem(key), TUTORIAL_KEY);
const toolsModeStorage = (page: Page) => page.evaluate(() => localStorage.getItem('splatview.tools-mode.v1'));
const title = (page: Page) => card(page).locator('h1');

test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

async function seedHandled(page: Page, version = TUTORIAL_VERSION) {
  await page.addInitScript(({ key, version }) => {
    if (localStorage.getItem(key) === null)
      localStorage.setItem(key, JSON.stringify({ tutorial_prompt_handled: 'handled', tutorial_version: version }));
  }, { key: TUTORIAL_KEY, version });
}
async function boot(page: Page, harness: 'opacity' | 'filter' | 'transform' = 'opacity') {
  await page.goto(`/e2e/${harness}-harness.html`);
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
}
async function emptyOffer(page: Page) {
  await boot(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await expect(card(page)).toHaveAttribute('aria-modal', 'true');
  await expect(card(page)).toHaveAccessibleName('Tutorial');
}
async function start(page: Page) {
  await card(page).getByRole('button', { name: 'Start', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
}
async function next(page: Page) {
  await card(page).getByRole('button', { name: 'Next', exact: true }).click();
}
async function at(page: Page, index: number) {
  const current = Number(await layer(page).getAttribute('data-tutorial-step'));
  expect(current).toBeGreaterThan(0);
  for (let step = current; step < index; step++) await next(page);
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
}
async function checkStep(page: Page, index: number) {
  const [name, target] = STEPS[index - 1];
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
  await expect(layer(page)).toHaveAttribute('data-tutorial-active-target', target);
  await expect(title(page)).toHaveText(name);
  await expect(layer(page).locator('.tutorial-counter')).toHaveText(`Tutorial ${index} / ${STEPS.length}`);
  const status = await layer(page).getAttribute('data-tutorial-target-status');
  expect(['visible', 'unavailable']).toContain(status);
  if (['single', 'brushes', 'area', 'color-select', 'fill'].includes(target)) {
    // Committed selection_ui.cpp:27–30 anchors all five explanations to the
    // same closed Tool trigger, without arming a tool or opening its popup.
    const trigger = page.locator('.tools-panel button[aria-label="Selection tool"]');
    await expect(trigger).toHaveCount(1); await expect(trigger).toBeVisible();
    await expect(trigger).toHaveAttribute('data-tutorial-target', 'single brushes area color-select fill');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`)).toHaveCount(1);
    await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', 'visible');
  }
  if (target === 'selection-finish') {
    const demo = layer(page).locator('[data-tutorial-demo="selection-finish"]');
    await expect(demo).toBeVisible(); await expect(demo).toHaveAttribute('aria-hidden', 'true');
    await expect(demo).toHaveAttribute('inert', '');
    await expect(demo.locator('button')).toHaveCount(3);
    for (const button of await demo.locator('button').all()) await expect(button).toBeDisabled();
  }
  if (status === 'visible') {
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`).first()).toBeVisible();
    expect(await layer(page).locator('.tutorial-highlight').count()).toBeGreaterThan(0);
  } else {
    await expect(card(page)).toContainText('This control is unavailable in the current view. You can continue the tutorial.');
  }
}
async function replay(page: Page) {
  if (!(await page.locator('.tools-panel').count()))
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.locator('.tools-panel').getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await expect(settings).toBeVisible();
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  const trigger = settings.locator('[data-tutorial-replay]');
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(settings).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
}
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const state = window.opacityHarness.state();
    return {busy: state.busy, renderer: state.rendererState, error: state.error};
  })).toEqual({busy: false, renderer: 'ready', error: null});
}
async function editedScene(page: Page) {
  await page.evaluate(async () => {
    await window.opacityHarness.load('tutorial-preservation.ply');
    await window.opacityHarness.selectedFixture();
    await window.opacityHarness.command({command: 'invert'});
    await window.opacityHarness.command({command: 'undo'});
  });
  await settled(page);
  if (!(await page.locator('.tools-panel').count()))
    await page.getByRole('button', {name: 'Tools', exact: true}).click();
  const brightness = page.locator('.tools-panel').getByRole('slider', {name: 'Brightness', exact: true});
  await brightness.press('Enter');
  await page.getByRole('textbox', {name: 'Brightness value', exact: true}).fill('1.25');
  await page.getByRole('textbox', {name: 'Brightness value', exact: true}).press('Enter');
  const current = await opacity(page);
  expect(current.summary.canRedo).toBe(true);expect(current.grade[0]).toBe(1.25);
}
async function rawFrame(page: Page) {
  // Digest the renderer's complete RGBA payload, excluding browser chrome.
  return page.evaluate(async () => {
    const app = window.geometryViewer.controllerForSourceNavigation(), state = window.opacityHarness.state();
    if (!app.scene || app.scene.kind !== 'gaussian' || !app.renderer || !app.camera) throw new Error('Actual Gaussian GPU scene required.');
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const blob = await app.renderer.capture(app.scene, app.camera, 'image/png', state.grade, identity,
      state.colorSession?.selectedOnly ?? false, false, 1, false);
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const hash = await crypto.subtle.digest('SHA-256', rgba);
      return {width: bitmap.width, height: bitmap.height,
        sha256: [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('')};
    } finally {bitmap.close();}
  });
}

declare global {
  interface Window { restoreTutorialStorage?: () => void }
}
test.afterEach(async ({ page }) => {
  await page.evaluate(() => {
    window.restoreTutorialStorage?.();
    window.opacityHarness?.stop();window.transformHarness?.stop();
  });
});

test('first offer appears before any scene, owns focus, and Skip persists only the handled marker', async ({ page }) => {
  await emptyOffer(page);
  expect((await page.evaluate(() => window.opacityHarness.state())).summary).toBeNull();
  await expect(card(page)).toContainText(TUTORIAL_OFFER_TEXT);
  expect(await page.evaluate(() => [...document.querySelectorAll('[inert]')].some(node => node.contains(document.querySelector('canvas'))))).toBe(true);
  expect(JSON.parse((await storage(page))!).tutorial_prompt_handled).toBe('handled');
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.tutorial-layer'))).toBe(true);
  }
  await card(page).getByRole('button', {name: 'Skip', exact: true}).click();
  await expect(layer(page)).toHaveCount(0);
  const skipped = JSON.parse((await storage(page))!);
  expect(skipped.tutorial_prompt_handled).toBe('handled');
  expect(skipped.tutorial_version ?? 0).toBe(0);
  await page.reload();await page.waitForFunction(() => window.opacityHarness?.ready());
  await expect(layer(page)).toHaveCount(0);
  expect((await page.evaluate(() => window.opacityHarness.state())).summary).toBeNull();
});

test('Start presents the Essentials order and actual semantic targets', async ({ page }, info) => {
  await emptyOffer(page);await start(page);
  expect(STEPS).toHaveLength(20);
  const observations = [];
  for (let index = 1; index <= STEPS.length; index++) {
    await checkStep(page, index);
    observations.push({index, title: STEPS[index - 1][0], target: STEPS[index - 1][1],
      status: await layer(page).getAttribute('data-tutorial-target-status')});
    if (index < STEPS.length) await next(page);
  }
  await expect(card(page).getByRole('button', {name: 'Finish', exact: true})).toBeVisible();
  await card(page).getByRole('button', {name: 'Finish', exact: true}).click();
  await expect(layer(page)).toHaveCount(0);
  expect(JSON.parse((await storage(page))!).tutorial_version).toBe(TUTORIAL_VERSION);
  // Start opens the sample scene, which stays available after Finish.
  expect((await page.evaluate(() => window.opacityHarness.state())).sourceName).toBe(EXAMPLE_SCENE.name);
  await info.attach('tutorial-essentials-actual-targets', {body: JSON.stringify(observations), contentType: 'application/json'});
});

test('Back and Next preserve one-based progress; Escape closes without a scene and version suppresses a repeated offer', async ({ page }) => {
  await emptyOffer(page);await start(page);
  await next(page);await next(page);await checkStep(page, 3);
  await card(page).getByRole('button', {name: 'Back', exact: true}).click();await checkStep(page, 2);
  await page.keyboard.press('Escape');await expect(layer(page)).toHaveCount(0);
  expect(JSON.parse((await storage(page))!).tutorial_version).toBe(TUTORIAL_VERSION);
  await page.reload();await page.waitForFunction(() => window.opacityHarness?.ready());
  await expect(layer(page)).toHaveCount(0);
});

test('Help Replay closes Settings and starts again without changing the committed Tools mode', async ({ page }) => {
  await seedHandled(page);await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'basic'));
  await boot(page);await page.evaluate(() => window.opacityHarness.load());await settled(page);
  await page.getByRole('button', {name: 'Tools', exact: true}).click();
  const before = await opacity(page), mode = await toolsModeStorage(page);
  expect(before.mode).toBe('basic');
  await replay(page);await checkStep(page, 1);
  for (const id of ['brushes', 'gizmo', 'color-slider']) {
    await at(page, stepIndex(id));await checkStep(page, stepIndex(id));
    await expect(page.locator('.tools-panel')).toHaveAttribute('data-tutorial-display-mode', 'basic');
    expect((await page.evaluate(() => window.opacityHarness.state())).mode).toBe('basic');
    expect(await toolsModeStorage(page)).toBe(mode);
  }
  await card(page).getByRole('button', {name: 'Close tutorial', exact: true}).click();
  await expect(layer(page)).toHaveCount(0);
  expect(await toolsModeStorage(page)).toBe(mode);
  expect(await opacity(page)).toEqual(before);
});

test('stored completed or older positive version avoids a fresh prompt; invalid JSON safely offers once', async ({ page }) => {
  await seedHandled(page);await boot(page);await expect(layer(page)).toHaveCount(0);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({tutorial_prompt_handled: 'handled', tutorial_version: 2})), TUTORIAL_KEY);
  await page.reload();await page.waitForFunction(() => window.opacityHarness?.ready());await expect(layer(page)).toHaveCount(0);
  await page.evaluate(key => localStorage.setItem(key, '{bad-json'), TUTORIAL_KEY);
  await page.reload();await page.waitForFunction(() => window.opacityHarness?.ready());
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  await card(page).getByRole('button', {name: 'Skip', exact: true}).click();
  await expect(layer(page)).toHaveCount(0);
});

test('refused Tutorial preference writes show the native error while Start and Close remain usable', async ({ page }) => {
  await page.addInitScript(key => {
    const original = Storage.prototype.setItem;
    window.restoreTutorialStorage = () => {Storage.prototype.setItem = original;delete window.restoreTutorialStorage;};
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException('Test refusal', 'QuotaExceededError');
      original.call(this, name, value);
    };
  }, TUTORIAL_KEY);
  await emptyOffer(page);expect(await storage(page)).toBeNull();
  await expect(card(page).getByRole('alert')).toHaveText('Could not save tool preferences. This window keeps your choice.');
  await start(page);await checkStep(page, 1);
  await card(page).getByRole('button', {name: 'Close tutorial', exact: true}).click();
  await expect(layer(page)).toHaveCount(0);expect(await storage(page)).toBeNull();
  await expect(page.getByRole('alert')).toContainText('Could not save tool preferences. This window keeps your choice.');
  await page.evaluate(() => window.restoreTutorialStorage!());
});

test('compact step positioning reveals actual targets and keeps the card inside the viewport', async ({ page }) => {
  await page.setViewportSize({width: 640, height: 480});
  await emptyOffer(page);await start(page);
  for (const index of ['open', 'capture', 'histogram', 'selection-finish', 'gizmo', 'color-slider'].map(stepIndex)) {
    await at(page, index);await checkStep(page, index);
    const bounds = (await card(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(640.5);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(480.5);
    if (await layer(page).getAttribute('data-tutorial-target-status') === 'visible')
      for (const highlight of await layer(page).locator('.tutorial-highlight').all()) {
        const rect = (await highlight.boundingBox())!;
        expect(rect.x + rect.width).toBeGreaterThan(0);expect(rect.y + rect.height).toBeGreaterThan(0);
        expect(rect.x).toBeLessThan(640);expect(rect.y).toBeLessThan(480);
      }
  }
});

for (const {size, locale} of [
  {size: 'small', locale: 'ko'}, {size: 'medium', locale: 'ja'}, {size: 'large', locale: 'zh-Hans'},
] as const) test(`${size} ${locale} tour fits 420x240 with reduced motion and finishes`, async ({page}, info) => {
  await page.setViewportSize({width: 420, height: 240});
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.addInitScript(({size, locale}) => {
    localStorage.setItem('splatview.ui-size.v1', size);
    localStorage.setItem('splatview.ui-language.v1', locale);
  }, {size, locale});
  await boot(page);
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', size);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  const fit = async (offer: boolean) => {
    await expect.poll(() => card(page).evaluate((element, offer) => {
      const box = element.getBoundingClientRect();
      const body = element.querySelector('.tutorial-card-body')!.getBoundingClientRect();
      const footer = element.querySelector(offer ? '.tutorial-offer-actions' : '.tutorial-card-actions')!.getBoundingClientRect();
      const buttons = [...element.querySelectorAll(`${offer ? '.tutorial-offer-actions' : '.tutorial-card-actions'} button`)]
        .map(node => node.getBoundingClientRect());
      const within = (rect: DOMRect) => rect.left >= -.5 && rect.top >= -.5 && rect.right <= 420.5 && rect.bottom <= 240.5;
      return {card: within(box), body: within(body), footer: within(footer), buttons: buttons.every(within),
        bodyBeforeFooter: body.bottom <= footer.top + .5, footerInsideCard: footer.bottom <= box.bottom + .5};
    }, offer)).toEqual({card: true, body: true, footer: true, buttons: true, bodyBeforeFooter: true, footerInsideCard: true});
    await card(page).locator('.tutorial-card-body').focus();
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('.tutorial-layer'))).toBe(true);
  };
  await fit(true);
  await card(page).locator('.tutorial-start').click();
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  const advance = async (index: number, target: string) => {
    const current = Number(await layer(page).getAttribute('data-tutorial-step'));
    for (let step = current; step < index; step++) await card(page).locator('.tutorial-card-actions button').last().click();
    await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
    await expect(layer(page)).toHaveAttribute('data-tutorial-active-target', target);
    await expect(card(page).locator('.tutorial-card-body h1')).not.toBeEmpty();
    await fit(false);
  };
  await advance(1, 'open');
  await advance(stepIndex('selection-finish'), 'selection-finish');
  await advance(stepIndex('gizmo'), 'gizmo');
  await info.attach(`actual-tutorial-${locale}-${size}-gizmo-420x240.png`,
    {body: await page.screenshot(), contentType: 'image/png'});
  await advance(stepIndex('color-slider'), 'color-slider');
  await card(page).locator('.tutorial-card-actions button').last().click();
  await expect(layer(page)).toHaveCount(0);
  expect(JSON.parse((await storage(page))!).tutorial_version).toBe(TUTORIAL_VERSION);
});

test('modal input guard blocks scene shortcuts, wheel and a dropped file before a scene exists', async ({ page }) => {
  await emptyOffer(page);await start(page);
  const before = await page.evaluate(() => window.opacityHarness.state());
  await card(page).locator('.tutorial-card-body').focus();
  for (const key of ['PageUp', 'PageDown', 'g', 'G', 'Control+z', 'Meta+z', 'Control+e', 'Enter'])
    await page.keyboard.press(key);
  await page.mouse.move(500, 350);await page.mouse.wheel(0, 120);
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['ply\nformat ascii 1.0\nelement vertex 0\nend_header\n'], 'blocked.ply'));
    document.querySelector('canvas')!.dispatchEvent(new DragEvent('drop', {bubbles: true, cancelable: true, dataTransfer: data}));
  });
  await checkStep(page, 1);
  const after = await page.evaluate(() => window.opacityHarness.state());
  expect(after.sourceName).toBe(before.sourceName);expect(after.summary).toEqual(before.summary);
  expect(after.mode).toBe(before.mode);expect(after.tool).toBe(before.tool);expect(after.camera).toEqual(before.camera);
  await page.keyboard.press('Escape');await expect(layer(page)).toHaveCount(0);
});

test('replay blocks edited-scene shortcuts and keeps exact native/GPU data, raw RGBA and executable Redo', async ({ page }, info) => {
  await seedHandled(page);
  await boot(page);await editedScene(page);
  const before = await opacity(page), image = await rawFrame(page);
  await page.evaluate(() => window.opacityHarness.observe());
  await replay(page);await checkStep(page, 1);
  await card(page).locator('.tutorial-card-body').focus();
  for (const key of ['PageUp', 'PageDown', 'g', 'G', 'Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z', 'Enter'])
    await page.keyboard.press(key);
  await page.mouse.move(480, 360);await page.mouse.wheel(0, 140);
  await at(page, stepIndex('color-slider'));await checkStep(page, stepIndex('color-slider'));
  const during = await opacity(page), duringImage = await rawFrame(page);
  expect(during).toEqual(before);expect(duringImage).toEqual(image);
  await card(page).getByRole('button', {name: 'Close tutorial', exact: true}).click();
  expect(await opacity(page)).toEqual(before);expect(await rawFrame(page)).toEqual(image);
  const mutating = (await page.evaluate(() => window.opacityHarness.commands()))
    .filter(name => ['grade', 'autoColor', 'applyOpacity', 'resetOpacity', 'applyTransform', 'transform', 'undo', 'redo'].includes(name));
  expect(mutating).toEqual([]);
  // A pending grade owns the first history action. Clear that preview before
  // exercising the saved native Redo entry, as in the qualified Language case.
  await page.locator('.tools-panel').getByRole('button', {name: 'Reset color preview', exact: true}).click();
  await settled(page);
  const readyForRedo = await opacity(page);
  expect(readyForRedo.masks).toEqual(before.masks);
  expect(readyForRedo.gpuMasks).toEqual(before.gpuMasks);
  expect(readyForRedo.summary.canRedo).toBe(true);
  expect(await page.evaluate(() => window.opacityHarness.command({command: 'redo'}))).toBe(true);
  await settled(page);
  const redone = await opacity(page);expect(redone.masks).toEqual([1, 1, 0, 1, 1, 2]);expect(redone.gpuMasks).toEqual(redone.masks);
  expect(await page.evaluate(() => window.opacityHarness.command({command: 'undo'}))).toBe(true);
  await settled(page);
  const undone = await opacity(page);expect(undone.masks).toEqual(before.masks);expect(undone.gpuMasks).toEqual(before.gpuMasks);
  await info.attach('tutorial-native-gpu-rgba-redo', {body: JSON.stringify({before, image, during, duringImage, readyForRedo, redone, undone}), contentType: 'application/json'});
});

test('modifier and Escape keyups after closing the tour cannot leak into selection or scene state', async ({ page }) => {
  await seedHandled(page);
  await boot(page);await editedScene(page);
  const before = await opacity(page);
  await replay(page);
  await card(page).locator('.tutorial-card-body').focus();
  await page.keyboard.down('Shift');
  await page.keyboard.press('Escape');
  await expect(layer(page)).toHaveCount(0);
  await page.keyboard.up('Shift');
  const modifiers = await page.evaluate(async () => {
    const moduleUrl = new URL('../src/app/store.ts', location.href).href;
    const {useApp} = await import(/* @vite-ignore */ moduleUrl) as typeof import('../src/app/store');
    return useApp.getState().selectionModifiers;
  });
  expect(modifiers).toBe(0);
  expect(await opacity(page)).toEqual(before);
});

test('projected Tools steps restore panel scroll and an invalid numeric draft', async ({ page }) => {
  await page.setViewportSize({width: 900, height: 600});
  await seedHandled(page);
  await boot(page);await page.evaluate(() => window.opacityHarness.load());await settled(page);
  if (!(await page.locator('.tools-panel').count())) await page.getByRole('button', {name: 'Tools', exact: true}).click();
  const panel = page.locator('.tools-panel'), body = panel.locator('.tools-body');
  const brightness = panel.getByRole('slider', {name: 'Brightness', exact: true});
  await brightness.press('Enter');
  const draft = panel.getByRole('textbox', {name: 'Brightness value', exact: true});
  await draft.fill('');await expect(draft).toHaveAttribute('aria-invalid', 'true');
  const before = await opacity(page);
  const originalScroll = await body.evaluate(node => {node.scrollTop = 120;return node.scrollTop;});
  expect(originalScroll).toBeGreaterThan(0);
  await replay(page);await at(page, stepIndex('brushes'));await checkStep(page, stepIndex('brushes'));
  await expect(panel).toHaveAttribute('data-tutorial-display-mode', 'basic');
  await at(page, stepIndex('color-slider'));await checkStep(page, stepIndex('color-slider'));
  await card(page).getByRole('button', {name: 'Close tutorial', exact: true}).click();
  expect(await body.evaluate(node => node.scrollTop)).toBe(originalScroll);
  await expect(draft).toHaveValue('');await expect(draft).toHaveAttribute('aria-invalid', 'true');
  expect(await opacity(page)).toEqual(before);
});

// Opacity Fade / boost, the selection filter and numeric transforms are
// excluded from web-lite (color.advanced, selection.volume, transform.numeric);
// product-profile.spec.ts asserts their absence.
