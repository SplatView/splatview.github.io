import { test, expect, type ZoomObservation } from './browser-zoom-fixture';
import type { Locator, Page } from '@playwright/test';
import type {} from './accessibility-harness';
import { BROWSER_TUTORIAL_COURSES } from './tutorial-courses';

type Snapshot = Awaited<ReturnType<Window['accessibilityApp']['snapshot']>>;
const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.accessibilityApp.snapshot());
function exact(value: Snapshot, ids: number[]) {
  expect(value.ids).toEqual(ids); expect(value.gpu).toEqual([0, 1, 2, 3].map(id => Number(ids.includes(id))));
  expect(value.summary.selected).toBe(ids.length);
}
function retained(after: Snapshot, before: Snapshot) {
  expect(after.allBytes).toEqual(before.allBytes); expect(after.records).toEqual(before.records); expect(after.gpu).toEqual(before.gpu);
  expect(after.summary.revision).toBe(before.summary.revision); expect(after.summary.contentRevision).toBe(before.summary.contentRevision);
  expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
  expect(after.sourceFingerprint).toEqual(before.sourceFingerprint); expect(after.dirty).toBe(before.dirty);
}
async function boot(page: Page, large = false) {
  if (large) await page.addInitScript(() => localStorage.setItem('splatview.ui-size.v1', 'large'));
  await page.goto('/e2e/accessibility-harness.html');
  await expect.poll(() => page.evaluate(() => window.accessibilityApp?.ready() ?? false)).toBe(true);
  await page.evaluate(() => window.accessibilityApp.load());
  const { original, edited } = await page.evaluate(() => window.accessibilityApp.editedRedo());
  exact(edited, [0]); expect(edited.allBytes).not.toEqual(original.allBytes); expect(edited.summary.canRedo).toBe(true);
  if (large) await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  return edited;
}
async function reachable(target: Locator) {
  await expect(target).toBeFocused(); await expect(target).toBeInViewport({ ratio: 1 });
  expect(await target.evaluate(element => {
    const r = element.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
  })).toBe(true);
}
async function tabTo(page: Page, target: Locator, backwards = false, maximum = 180) {
  for (let index = 0; index < maximum; index++) {
    if (await target.evaluate(element => element === document.activeElement)) { await reachable(target); return; }
    await page.keyboard.press(backwards ? 'Shift+Tab' : 'Tab');
  }
  throw new Error(`Keyboard focus did not reach ${await target.getAttribute('aria-label') ?? await target.textContent()}.`);
}
async function openTools(page: Page) {
  await scene(page).focus(); const trigger = page.getByRole('button', { name: 'Tools', exact: true });
  await tabTo(page, trigger); await page.keyboard.press('Enter'); await expect(tools(page)).toBeVisible();
}
async function settings(page: Page) {
  if (!await tools(page).count()) await openTools(page);
  const trigger = page.getByRole('button', { name: 'Settings', exact: true });
  await tabTo(page, trigger); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Settings', exact: true }); await expect(panel).toBeVisible(); return panel;
}
async function retainedAndRedo(page: Page, before: Snapshot) {
  const after = await snapshot(page); retained(after, before);
  const redone = await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' })); exact(redone, [0, 1]);
  expect(redone.allBytes).toEqual(before.allBytes);
  const undone = await page.evaluate(() => window.accessibilityApp.command({ command: 'undo' })); exact(undone, [0]);
  expect(undone.allBytes).toEqual(before.allBytes); expect(undone.summary.canRedo).toBe(true);
}
async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({ document: document.documentElement.scrollWidth > innerWidth,
    body: document.body.scrollWidth > innerWidth, x: scrollX, y: scrollY }))).toEqual({ document: false, body: false, x: 0, y: 0 });
}
// Basic offers fewer presets, so the menu only needs its own scroll at 400 percent.
async function presetMenu(page: Page, scrolls = true) {
  const trigger = tools(page).getByRole('button', { name: 'Color preset', exact: true });
  await tabTo(page, trigger); await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Color presets', exact: true }); await expect(menu).toBeVisible();
  const owner = tools(page), before = await owner.evaluate(element => element.scrollTop);
  await page.keyboard.press('End'); await reachable(menu.getByRole('menuitemradio').last());
  if (scrolls) expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  else expect(await menu.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1);
  expect(await owner.evaluate(element => element.scrollTop)).toBe(before);
  await page.keyboard.press('Home'); await reachable(menu.getByRole('menuitemradio').first());
  expect(await menu.evaluate(element => element.scrollTop)).toBe(0);
  expect(await owner.evaluate(element => element.scrollTop)).toBe(before);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await reachable(trigger);
}
async function modalControls(page: Page, factor: 2 | 4) {
  const save = page.getByRole('button', { name: 'Save scene', exact: true });
  await scene(page).focus(); await tabTo(page, save); await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Save scene', exact: true }); await expect(panel).toBeVisible();
  const values = [panel.getByLabel('Export format', { exact: true }), panel.getByLabel('Export scope', { exact: true }),
    panel.getByRole('button', { name: 'Cancel', exact: true }), panel.getByRole('button', { name: 'Download', exact: true })];
  await reachable(values[0]);
  for (let index = 1; index <= values.length; index++) { await page.keyboard.press('Tab'); await reachable(values[index % values.length]); }
  for (let index = values.length - 1; index >= 0; index--) { await page.keyboard.press('Shift+Tab'); await reachable(values[index]); }
  expect(await page.evaluate(() => innerHeight)).toBe(800 / factor);
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await reachable(save);
  const preferences = await settings(page), close = preferences.getByRole('button', { name: 'Close scene', exact: true });
  await tabTo(page, close); await page.keyboard.press('Enter');
  const unsaved = page.getByRole('dialog', { name: 'Unsaved changes', exact: true }); await expect(unsaved).toBeVisible();
  const actions = ['Stay', 'Discard and close', 'Save'].map(name => unsaved.getByRole('button', { name, exact: true }));
  await reachable(actions[0]);
  for (let index = 1; index <= actions.length; index++) { await page.keyboard.press('Tab'); await reachable(actions[index % actions.length]); }
  await page.keyboard.press('Shift+Tab'); await reachable(actions[2]);
  await page.keyboard.press('Escape'); await expect(unsaved).toHaveCount(0); await noPageOverflow(page);
}

test('actual browser 100, 200 and 400 percent zoom changes CSS viewport and DPR while preserving edited native data and executable Redo', async ({ page, zoom }, testInfo) => {
  const before = await boot(page); const measured: ZoomObservation[] = [];
  for (const factor of [1, 2, 4, 1] as const) {
    measured.push(await zoom.set(factor)); await noPageOverflow(page);
    await expect.poll(() => page.evaluate(() => window.deferredGrade.state().busy)).toBe(false);
    retained(await snapshot(page), before);
  }
  expect(measured.map(value => [value.requested, value.width, value.height, value.scale]))
    .toEqual([[1, 1280, 800, 1], [2, 640, 400, 1], [4, 320, 200, 1], [1, 1280, 800, 1]]);
  for (const value of measured) {
    expect(value.actual).toBeCloseTo(value.requested, 12);
    expect(value.dpr).toBeCloseTo(value.requested, 12);
  }
  await retainedAndRedo(page, before);
  await testInfo.attach('zoom-native-preservation', { contentType: 'application/json', body: JSON.stringify({ measured, before, after: await snapshot(page) }) });
});

test('200 percent compact toolbar and Settings remain reachable by Tab without scrolling the page', async ({ page, zoom }) => {
  const before = await boot(page); await zoom.set(2); await openTools(page);
  const panel = await settings(page), close = panel.getByRole('button', { name: 'Close Settings', exact: true });
  await reachable(close);
  for (const label of ['Language', 'Theme', 'Font size', 'Close scene']) {
    await tabTo(page, panel.getByRole('button', { name: label, exact: true }));
  }
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await noPageOverflow(page); await retainedAndRedo(page, before);
});

test('400 percent Large Pro selection menu reveals keyboard endpoints locally and preserves native history', async ({ page, zoom }) => {
  const before = await boot(page, true); await zoom.set(4); await openTools(page);
  const trigger = tools(page).getByRole('button', { name: 'Selection tool', exact: true }); await tabTo(page, trigger); await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Selection tools', exact: true }), owner = tools(page);
  await expect(menu).toBeVisible(); const scroll = await owner.evaluate(element => element.scrollTop);
  await page.keyboard.press('End'); await reachable(menu.getByRole('menuitemradio').last());
  expect(await menu.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await owner.evaluate(element => element.scrollTop)).toBe(scroll);
  await page.keyboard.press('Home'); await reachable(menu.getByRole('menuitemradio').first());
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await reachable(trigger);
  await noPageOverflow(page); await retainedAndRedo(page, before);
});

test('200 percent Presets keyboard navigation keeps the Tools anchor and pending grade unchanged', async ({ page, zoom }) => {
  const before = await boot(page); await zoom.set(2); await openTools(page); await presetMenu(page, false);
  expect(await page.evaluate(() => window.deferredGrade.state().colorPending)).toBe(false);
  await noPageOverflow(page); await retainedAndRedo(page, before);
});

test('400 percent Large Presets and Settings keep focus visible in local scroll owners', async ({ page, zoom }) => {
  const before = await boot(page, true); await zoom.set(4); await openTools(page); await presetMenu(page);
  const panel = await settings(page); await tabTo(page, panel.getByRole('button', { name: 'Font size', exact: true }));
  await page.keyboard.press('ArrowDown'); const sizes = page.getByRole('listbox', { name: 'Font size choices', exact: true });
  await page.keyboard.press('End'); await reachable(sizes.getByRole('option', { name: 'Large', exact: true }));
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
  await noPageOverflow(page); await retainedAndRedo(page, before);
});

for (const factor of [2, 4] as const) test(`${factor * 100} percent ${factor === 4 ? 'Large ' : ''}Save and Unsaved dialogs reveal every trapped keyboard control`, async ({ page, zoom }) => {
  const before = await boot(page, factor === 4); await zoom.set(factor); await modalControls(page, factor); await retainedAndRedo(page, before);
});

test('400 percent Large Tutorial reveals compact Tools targets and restores the retained Tools scroll', async ({ page, zoom }, testInfo) => {
  const before = await boot(page, true); await zoom.set(4); await openTools(page); await presetMenu(page);
  const owner = tools(page), scroll = await owner.evaluate(element => element.scrollTop); expect(scroll).toBeGreaterThan(0);
  const preferences = await settings(page); await tabTo(page, preferences.getByRole('tab', { name: 'General', exact: true }));
  await page.keyboard.press('End'); await expect(preferences.getByRole('tab', { name: 'Help', exact: true })).toBeFocused();
  const replay = preferences.getByRole('button', { name: 'Tutorial', exact: true }); await tabTo(page, replay);
  const afterSettings = await owner.evaluate(element => element.scrollTop);
  // Reaching Settings reveals its header. Arrange a nonzero passive panel
  // position while the dialog owns focus, then preserve the actual tour entry.
  const beforeReplay = await owner.evaluate(async (element, value) => {
    element.scrollTop = value; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    return element.scrollTop;
  }, scroll);
  expect(beforeReplay).toBeGreaterThan(0); await page.keyboard.press('Enter');
  const layer = page.locator('.tutorial-layer'), card = layer.getByRole('dialog', { name: 'Tutorial', exact: true });
  await expect(layer).toHaveAttribute('data-tutorial-step', '1'); await reachable(card.getByRole('button', { name: 'Next', exact: true }));
  const course = BROWSER_TUTORIAL_COURSES.essentials.steps;
  const destination = course.find(step => step.id === 'presets')!.index;
  const checkpoints = course.filter(step => ['brushes', 'combine', 'selection-finish', 'gizmo', 'presets'].includes(step.id));
  for (let index = 1; index < destination; index++) {
    await page.keyboard.press('Enter'); await expect(layer).toHaveAttribute('data-tutorial-step', String(index + 1));
    const checkpoint = checkpoints.find(step => step.index === index + 1);
    if (checkpoint) {
      await expect(layer).toHaveAttribute('data-tutorial-target-status', 'visible');
      const target = checkpoint.target;
      await expect(page.locator(`[data-tutorial-target~="${target}"]:visible`).first()).toBeInViewport();
      await reachable(card.getByRole('button', { name: 'Next', exact: true }));
    }
  }
  await page.keyboard.press('Escape'); await expect(layer).toHaveCount(0);
  await expect.poll(() => owner.evaluate(element => element.scrollTop)).toBe(beforeReplay);
  await retainedAndRedo(page, before);
  const afterEscape = await owner.evaluate(element => element.scrollTop); expect(afterEscape).toBe(beforeReplay); await noPageOverflow(page);
  await testInfo.attach('tutorial-panel-scroll', { contentType: 'application/json', body: JSON.stringify({ afterPresets: scroll, afterSettings, beforeReplay, afterEscape }) });
});
