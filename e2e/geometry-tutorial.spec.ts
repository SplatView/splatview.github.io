import { expect, test, type Page } from '@playwright/test';
import type {} from './geometry-viewer-harness';
import { TUTORIAL_VERSION } from '../src/app/tutorialCatalog';
import { BROWSER_TUTORIAL_COURSES } from './tutorial-courses';

// Start and Help replay both present Essentials; the catalog oracle pins desktop order separately.
const COURSE = BROWSER_TUTORIAL_COURSES.essentials.steps;
const STEPS = COURSE.map(step => [step.title, step.target] as const);
function stepIndex(id: string) {
  const index = COURSE.findIndex(step => step.id === id);
  if (index < 0) throw new Error(`Missing tutorial step ${id}`);
  return index + 1;
}
const KEY = 'splatview.tutorial.v1';
const layer = (page: Page) => page.locator('.tutorial-layer');
const card = (page: Page) => layer(page).locator('.tutorial-card[role="dialog"]');
const panel = (page: Page) => page.locator('.tools-panel');
const observation = (page: Page) => page.evaluate(() => window.geometryTutorialObservation!());
const inspect = (page: Page) => page.evaluate(() => window.geometryViewer.inspect());

declare global {
  interface Window {
    geometryTutorialObservation?: ReturnType<Window['geometryViewer']['observeTutorial']>;
  }
}

test.use({ locale: 'en-US', storageState: { cookies: [], origins: [] } });

async function boot(page: Page, source: 'points' | 'mesh') {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(source => window.geometryViewer.load(source), source);
  await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'true');
}
async function remember(page: Page) {
  await page.evaluate(() => { window.geometryTutorialObservation = window.geometryViewer.observeTutorial(); });
  const result = await observation(page);
  expect(result).toMatchObject({ sameClient: true, sameScene: true, sameRenderer: true, sameCamera: true,
    originalSceneRetired: false, hasClient: true, sceneKind: 'geometry', busy: false, ready: true, rendererState: 'ready', error: null,
    pendingMode: null, toolsOpen: false, tool: null, settingsOpen: false, exportOpen: false, navigationPrompt: false,
    selectionRecovery: 'idle', operationRecovery: 'idle', pendingSelectionCount: 0, selectionDragging: false,
    memoryOverageBytes: 0, outputPending: false, savedViewChoices: 0, autoOrbit: false,
    filter: null, transform: null, opacity: null,
    controls: { editing: false, color: false, opacity: false, transform: false, filter: false, alignment: false, floor: false, morphology: false } });
  return result;
}
async function readonlyChrome(page: Page) {
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  await expect(page.getByRole('group', { name: 'Viewer panel', exact: true }).getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
}
async function replay(page: Page) {
  await page.mouse.move(20, 20); await page.mouse.move(21, 21);
  await page.getByRole('group', { name: 'Viewer panel', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await expect(settings.locator('[data-tutorial-replay]')).toBeEnabled();
  await settings.locator('[data-tutorial-replay]').click();
  await expect(settings).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
}
async function advance(page: Page, destination: number) {
  const current = Number(await layer(page).getAttribute('data-tutorial-step'));
  for (let step = current; step < destination; step++) await card(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(destination));
}
async function step(page: Page, index: number) {
  const [title, target] = STEPS[index - 1];
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', String(index));
  await expect(layer(page)).toHaveAttribute('data-tutorial-active-target', target);
  await expect(card(page).locator('h1')).toHaveText(title);
  await expect(card(page).locator('.tutorial-counter')).toHaveText(`Tutorial ${index} / ${STEPS.length}`);
  const unavailable = target === 'tools';
  await expect(layer(page)).toHaveAttribute('data-tutorial-target-status', unavailable ? 'unavailable' : 'visible');
  if (unavailable) await expect(card(page)).toContainText('This control is unavailable in the current view. You can continue the tutorial.');
  else expect(await layer(page).locator('.tutorial-highlight').count()).toBeGreaterThan(0);
  if (['single', 'brushes', 'area', 'color-select', 'fill'].includes(target)) {
    const trigger = panel(page).locator('button[aria-label="Selection tool"]');
    await expect(trigger).toHaveCount(1); await expect(trigger).toBeVisible(); await expect(trigger).toBeDisabled();
    await expect(trigger).toHaveAttribute('data-tutorial-target', 'single brushes area color-select fill');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`)).toHaveCount(1);
  }
  // Only the tutorial's presentation owns this temporary panel. The real
  // Tools preference and every document editing capability remain untouched.
  if (!COURSE[index - 1].tools) await expect(panel(page)).toHaveCount(0);
  else {
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-tutorial-display-mode', 'basic');
    await expect(panel(page).locator('.mode-button')).toBeDisabled();
    await expect(panel(page).locator('.model-info')).toHaveText(/^(points|mesh)\.ply$/);
    // Native's projected readonly template has no editable splats. The real
    // point/vertex count must not be relabeled as editable Gaussian splats.
    await expect(panel(page).locator('.model-stats')).toHaveText(/^0\/0 splats \| SH\d$/);
    const enabled = await panel(page).locator('.tools-body input:visible, .tools-body select:visible, .tools-body button:visible').evaluateAll(nodes =>
      nodes.filter(node => !node.matches(':disabled, .tools-section-label')).map(node => node.getAttribute('aria-label') ?? node.textContent?.trim()));
    expect(enabled).toEqual([]);
  }
  await expect(page.locator('.toolbar [aria-label="Save scene"]')).toBeDisabled();
  const bounds = (await card(page).boundingBox())!, viewport = page.viewportSize()!;
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + .5);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + .5);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.tutorial-layer'))).toBe(true);
}

for (const source of ['points', 'mesh'] as const) {
  test(`${source} first-run tour walks every Essentials readonly projection and preserves actual native/GPU data`, async ({ page }, info) => {
    await boot(page, source);
    await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
    const before = await inspect(page), original = await remember(page);
    expect(before.descriptor.vertexCount).toBe(source === 'points' ? 3 : 6);
    expect(before.capture.foreground).toBeGreaterThan(source === 'points' ? 10 : 1000);
    await page.evaluate(() => window.geometryViewer.keyboardStart());
    await card(page).getByRole('button', { name: 'Start', exact: true }).click();
    const observed: unknown[] = [];
    for (let index = 1; index <= STEPS.length; index++) {
      await step(page, index);
      expect(await observation(page)).toEqual(original);
      if (['histogram', 'selection-finish', 'gizmo', 'color-slider'].map(stepIndex).includes(index)) {
        const actual = await inspect(page); expect(actual).toEqual(before);
        observed.push({ step: index, actual });
      }
      if (index < STEPS.length) await card(page).getByRole('button', { name: 'Next', exact: true }).click();
    }
    await card(page).getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(layer(page)).toHaveCount(0); await readonlyChrome(page);
    expect(await observation(page)).toEqual(original);
    expect(await inspect(page)).toEqual(before);
    const traffic = await page.evaluate(() => window.geometryViewer.keyboardFinish());
    expect(traffic.calls.length).toBeGreaterThan(0);
    expect(traffic.calls.every(name => name === 'summary')).toBe(true);
    expect(JSON.parse((await page.evaluate(key => localStorage.getItem(key), KEY))!).tutorial_version).toBe(TUTORIAL_VERSION);
    await info.attach(`${source}-tour-actual-native-gpu-preservation.json`, { body: JSON.stringify({ before, original, observed, traffic }), contentType: 'application/json' });
  });

  test(`${source} Help replay exits with readonly admission intact and replacement/close retire the original geometry`, async ({ page }, info) => {
    await page.addInitScript(({key, version}) => {
      localStorage.setItem(key, JSON.stringify({tutorial_prompt_handled: 'handled', tutorial_version: version}));
    }, {key: KEY, version: TUTORIAL_VERSION});
    await boot(page, source); await readonlyChrome(page);
    const before = await inspect(page), original = await remember(page);
    expect(original.mode).toBe('basic');
    await page.evaluate(() => window.geometryViewer.keyboardStart());
    await replay(page); await step(page, 1);
    await advance(page, stepIndex('color-slider')); await step(page, stepIndex('color-slider'));
    await card(page).locator('.tutorial-card-body').focus();
    // B and N are tour navigation keys, so they are not scene shortcut probes here.
    for (const key of ['g', 'Delete', 'ControlOrMeta+a', 'ControlOrMeta+e', 'ControlOrMeta+s', 'ControlOrMeta+z'])
      await page.keyboard.press(key);
    await page.mouse.move(650, 420); await page.mouse.wheel(0, 120);
    expect(await observation(page)).toEqual(original); expect(await inspect(page)).toEqual(before);
    await card(page).getByRole('button', { name: 'Back', exact: true }).click(); await step(page, stepIndex('color-slider') - 1);
    await page.keyboard.press('Escape'); await expect(layer(page)).toHaveCount(0);
    await readonlyChrome(page); expect(await observation(page)).toEqual(original);
    expect(await inspect(page)).toEqual(before);
    const traffic = await page.evaluate(() => window.geometryViewer.keyboardFinish());
    expect(traffic.calls.every(name => name === 'summary')).toBe(true);
    // Re-enter and close using the visible action too. No hidden panel or
    // stale projected mode can survive either tutorial exit path.
    await replay(page); await advance(page, stepIndex('gizmo')); await step(page, stepIndex('gizmo'));
    await card(page).getByRole('button', { name: 'Close tutorial', exact: true }).click();
    await expect(layer(page)).toHaveCount(0); await readonlyChrome(page);
    expect(await observation(page)).toEqual(original); expect(await inspect(page)).toEqual(before);
    const replacement: 'points' | 'mesh' = source === 'points' ? 'mesh' : 'points';
    await page.evaluate((source: 'points' | 'mesh') => window.geometryViewer.load(source), replacement);
    await readonlyChrome(page);
    const replaced = await inspect(page), retired = await observation(page);
    expect(retired).toMatchObject({ sameClient: false, sameScene: false, sameRenderer: true, sameCamera: true,
      originalSceneRetired: true, mode: 'basic', toolsOpen: false, busy: false, error: null });
    expect(replaced.summary.kind).toBe(source === 'points' ? 2 : 1);
    expect(replaced.summary.canUndo).toBe(false); expect(replaced.summary.canRedo).toBe(false);
    await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().closeScene());
    const closed = await observation(page);
    expect(closed).toMatchObject({ hasClient: false, sceneKind: null, originalSceneRetired: true,
      mode: 'basic', toolsOpen: false, busy: false, ready: true, rendererState: 'ready', error: null, depthBytes: 0,
      ledger: { bytes: 0, allocations: 0, entries: [] } });
    await expect(layer(page)).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'false');
    await info.attach(`${source}-replay-replacement-close.json`, { body: JSON.stringify({ before, original, traffic, replaced, retired, closed }), contentType: 'application/json' });
  });
}
