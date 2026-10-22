import { expect, test, type Page } from '@playwright/test';
import type {} from './accessibility-harness';
import { BROWSER_TUTORIAL_COURSES } from './tutorial-courses';

type Snapshot = Awaited<ReturnType<Window['accessibilityApp']['snapshot']>>;
const scene = (page: Page) => page.locator('canvas[aria-describedby]');
const status = (page: Page) => page.getByRole('status', { name: 'Scene status', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.accessibilityApp.snapshot());
const modifiers = (page: Page) => page.evaluate(() => window.accessibilityApp.physicalModifiers());
const ready = (count: number) => `Ready. deferred-grade.ply. ${count} selected of 4 visible. Basic mode. Single splat. Combine: Replace.`;
const instructions = 'Tab moves between the scene and controls. Scene shortcuts work while the scene has focus. Open Tutorial for navigation and selection controls. The canvas is visual; scene status reports the current file, tool and selection counts.';
function exact(value: Snapshot, ids: number[]) {
  expect(value.ids).toEqual(ids); expect(value.gpu).toEqual([0, 1, 2, 3].map(id => Number(ids.includes(id))));
  expect(value.summary.selected).toBe(ids.length);
}
function retained(after: Snapshot, before: Snapshot) {
  expect(after.allBytes).toEqual(before.allBytes); expect(after.records).toEqual(before.records); expect(after.gpu).toEqual(before.gpu);
  expect(after.summary.contentRevision).toBe(before.summary.contentRevision); expect(after.summary.revision).toBe(before.summary.revision);
  expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
  expect(after.sourceFingerprint).toEqual(before.sourceFingerprint); expect(after.camera).toEqual(before.camera);
}
async function boot(page: Page, locale = 'en') {
  await page.addInitScript(locale => {
    localStorage.setItem('splatview.ui-language.v1', locale);
  }, locale);
  await page.goto('/e2e/accessibility-harness.html');
  await expect.poll(() => page.evaluate(() => window.accessibilityApp?.ready() ?? false)).toBe(true);
  await page.evaluate(() => window.accessibilityApp.load());
  if (locale === 'en') await expect(status(page)).toHaveText(ready(1));
}
async function queuedAdd(page: Page) {
  const centers = await page.evaluate(() => window.deferredGrade.centers());
  await page.keyboard.down('Shift'); await page.mouse.click(centers[2][0], centers[2][1]); await page.keyboard.up('Shift');
}
async function noFalseTwo(page: Page) {
  const value = await page.evaluate(() => window.accessibilityApp.status());
  expect(value.updates.filter(update => update.text.includes('2 selected of 4 visible'))).toEqual([]);
}

test('persistent polite atomic scene status follows real native selection, Undo and Redo counts', async ({ page }) => {
  await boot(page); const region = status(page), identity = await region.elementHandle();
  await expect(region).toHaveAttribute('aria-live', 'polite'); await expect(region).toHaveAttribute('aria-atomic', 'true');
  await expect(region).toHaveCount(1); await page.evaluate(() => window.accessibilityApp.observe());
  const before = await snapshot(page); exact(before, [0]);
  const selected = await page.evaluate(() => window.accessibilityApp.command({ command: 'single', index: 2, operation: 1 }));
  exact(selected, [0, 2]); await expect(region).toHaveText(ready(2));
  const undone = await page.evaluate(() => window.accessibilityApp.command({ command: 'undo' }));
  exact(undone, [0]); await expect(region).toHaveText(ready(1)); expect(undone.summary.canRedo).toBe(true);
  const redone = await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' }));
  exact(redone, [0, 2]); await expect(region).toHaveText(ready(2)); expect(redone.allBytes).toEqual(before.allBytes);
  const changes = await page.evaluate(() => window.accessibilityApp.status());
  expect(changes.updates.filter(update => update.text.startsWith('Ready.')).map(update => update.text)).toEqual([ready(1), ready(2), ready(1), ready(2)]);
  expect(await region.evaluate((element, previous) => element === previous, identity!)).toBe(true); await identity!.dispose();
});

test('held genuine grade and changing progress do not announce queued selection counts before native publication', async ({ page }) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.deferredGrade.hold());
  await expect(scene(page)).toHaveAttribute('aria-busy', 'true'); await expect(status(page)).toHaveText('Scene work in progress.');
  await page.evaluate(() => window.accessibilityApp.observe()); await queuedAdd(page);
  await expect.poll(() => modifiers(page)).toBe(0);
  await page.evaluate(async () => {
    for (let index = 1; index <= 20; index++) {
      window.accessibilityApp.progress(index / 25); await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
  });
  await expect(status(page)).toHaveText('Scene work in progress.'); await noFalseTwo(page);
  expect((await page.evaluate(() => window.accessibilityApp.status())).updates).toHaveLength(1);
  expect(await modifiers(page)).toBe(0);
  expect(await page.evaluate(() => window.deferredGrade.release())).toBe(true);
  await page.evaluate(() => window.deferredGrade.settle()); await expect(status(page)).toHaveText(ready(2));
  expect(await modifiers(page)).toBe(0);
  await expect(scene(page)).toHaveAttribute('aria-busy', 'false'); const after = await snapshot(page); exact(after, [0, 2]);
  expect(after.allBytes).not.toEqual(before.allBytes); expect(after.sourceFingerprint).toEqual(before.sourceFingerprint);
});

test('captured Shift Add replays while a newer held primary modifier keeps physical Subtract status until release', async ({ page }) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.deferredGrade.hold());
  await queuedAdd(page); await expect.poll(() => modifiers(page)).toBe(0);
  const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.down(primary); let held = true;
  try {
    await expect.poll(() => modifiers(page)).toBe(2);
    expect(await page.evaluate(() => window.deferredGrade.release())).toBe(true);
    await page.evaluate(() => window.deferredGrade.settle());
    expect(await modifiers(page)).toBe(2);
    await expect(status(page)).toHaveText(ready(2).replace('Combine: Replace.', 'Combine: Subtract.'));
    const after = await snapshot(page); exact(after, [0, 2]);
    expect(after.allBytes).not.toEqual(before.allBytes); expect(after.sourceFingerprint).toEqual(before.sourceFingerprint);
    expect(after.camera).toEqual(before.camera); expect(after.error).toBeNull();
    expect(after.calls.filter(call => call.command.command === 'single').map(call => [call.command.index, call.command.operation])).toEqual([[2, 1]]);
    await page.keyboard.up(primary); held = false; await expect.poll(() => modifiers(page)).toBe(0);
    await expect(status(page)).toHaveText(ready(2));
    const selectionUndone = await page.evaluate(() => window.accessibilityApp.command({ command: 'undo' }));
    exact(selectionUndone, [0]); expect(selectionUndone.allBytes).toEqual(after.allBytes);
    const gradeUndone = await page.evaluate(() => window.accessibilityApp.command({ command: 'undo' }));
    exact(gradeUndone, [0]); expect(gradeUndone.allBytes).toEqual(before.allBytes);
    const gradeRedone = await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' }));
    exact(gradeRedone, [0]); expect(gradeRedone.allBytes).toEqual(after.allBytes);
    const selectionRedone = await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' }));
    exact(selectionRedone, [0, 2]); expect(selectionRedone.allBytes).toEqual(after.allBytes);
    expect(await modifiers(page)).toBe(0); await expect(status(page)).toHaveText(ready(2));
  } finally { if (held) await page.keyboard.up(primary); }
});

test('refused genuine GPU publication clears scene status and never announces unapplied queued counts', async ({ page }) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.accessibilityApp.observe());
  await page.evaluate(() => window.deferredGrade.hold()); await queuedAdd(page);
  await page.evaluate(() => window.deferredGrade.failPublication());
  expect(await page.evaluate(() => window.deferredGrade.release())).toBe(false);
  await page.evaluate(() => window.deferredGrade.settle());
  await expect(page.getByRole('alert')).toContainText('refused publication after actual GPU completion'); await expect(status(page)).toHaveText('');
  const after = await snapshot(page); exact(after, [0]); expect(after.allBytes).toEqual(before.allBytes);
  expect(after.sourceFingerprint).toEqual(before.sourceFingerprint); await noFalseTwo(page);
});

test('actual cancellation retains original native bytes and publishes no queued selection completion', async ({ page }) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.accessibilityApp.observe());
  await page.evaluate(() => window.deferredGrade.hold()); await queuedAdd(page); await page.evaluate(() => window.accessibilityApp.cancel());
  expect(await page.evaluate(() => window.deferredGrade.release())).toBe(false);
  await page.evaluate(() => window.deferredGrade.settle()); await expect(status(page)).toHaveText(ready(1));
  const after = await snapshot(page); exact(after, [0]); expect(after.allBytes).toEqual(before.allBytes); expect(after.error).toBeNull(); await noFalseTwo(page);
});

test('real source replacement describes the new document and drops the old queued count', async ({ page }) => {
  await boot(page); const before = await snapshot(page); await page.evaluate(() => window.accessibilityApp.observe());
  await page.evaluate(() => window.deferredGrade.hold()); await queuedAdd(page); await page.evaluate(() => window.deferredGrade.startReplacement());
  await page.evaluate(() => window.deferredGrade.release()); await page.evaluate(() => window.deferredGrade.joinReplacement());
  await page.evaluate(() => window.deferredGrade.settle());
  await expect(status(page)).toHaveText(/^Ready\. deferred-replacement\.ply\. 0 selected of 4 visible\./);
  const after = await snapshot(page); exact(after, []); expect(after.sourceFingerprint).not.toEqual(before.sourceFingerprint); await noFalseTwo(page);
});

test('canvas keyboard focus has a visible ring and stable localized description without changing native history', async ({ page }) => {
  await boot(page); const { edited } = await page.evaluate(() => window.accessibilityApp.editedRedo());
  const description = await scene(page).getAttribute('aria-describedby'); expect(description).toBeTruthy();
  await expect(scene(page)).toHaveAccessibleDescription(new RegExp(instructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await scene(page).focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab'); await expect(scene(page)).toBeFocused();
  const focus = await scene(page).evaluate(element => { const css = getComputedStyle(element); return {
    visible: element.matches(':focus-visible'), style: css.outlineStyle, width: Number.parseFloat(css.outlineWidth), color: css.outlineColor,
  }; });
  expect(focus.visible).toBe(true); expect(focus.style).not.toBe('none'); expect(focus.width).toBeGreaterThanOrEqual(2);
  expect(focus.color).not.toBe('rgba(0, 0, 0, 0)'); retained(await snapshot(page), edited);
  expect(await scene(page).getAttribute('aria-describedby')).toBe(description);
  exact(await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' })), [0, 1]);
  await boot(page, 'de'); await expect(page.getByRole('status', { name: 'Szenenstatus', exact: true })).toHaveCount(1);
  await expect(scene(page)).toHaveAccessibleDescription(/Tab wechselt zwischen Szene und Bedienelementen/);
  const ids = (await scene(page).getAttribute('aria-describedby'))!.split(/\s+/);
  expect(await page.evaluate(ids => ids.every(id => !!document.getElementById(id)), ids)).toBe(true);
});

test('faded chrome is inert and hidden from accessibility until Tab wakes it and ShiftTab returns to the scene', async ({ page }) => {
  await boot(page); const centers = await page.evaluate(() => window.deferredGrade.centers());
  await page.mouse.click(centers[0][0], centers[0][1]); await page.evaluate(() => window.deferredGrade.settle());
  const { edited } = await page.evaluate(() => window.accessibilityApp.editedRedo());
  await page.mouse.move(centers[0][0] + 2, centers[0][1]);
  await expect(scene(page)).toBeFocused();
  await expect(page.locator('main')).toHaveClass(/chrome-hidden/, { timeout: 6_000 });
  expect(await page.locator('[data-chrome]').evaluateAll(elements => elements.length > 0 && elements.every(element =>
    element.hasAttribute('inert') && element.getAttribute('aria-hidden') === 'true'))).toBe(true);
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Open scene"]')!.focus());
  await expect(scene(page)).toBeFocused(); await page.keyboard.press('Tab');
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(scene(page)).toBeFocused();
  retained(await snapshot(page), edited);
  exact(await page.evaluate(() => window.accessibilityApp.command({ command: 'redo' })), [0, 1]);
});

test('current tutorial suppresses the persistent scene status and restores neutral native counts without an edit', async ({ page }) => {
  await boot(page);
  exact(await page.evaluate(() => window.accessibilityApp.command({command: 'single', index: 2, operation: 1})), [0, 2]);
  exact(await page.evaluate(() => window.accessibilityApp.command({command: 'undo'})), [0]);
  const before = await snapshot(page), region = status(page), identity = await region.elementHandle();
  await expect(region).toHaveText(ready(1)); expect(before.summary.canRedo).toBe(true);
  if (!await page.locator('.tools-panel').isVisible()) await page.getByRole('button', {name: 'Tools', exact: true}).click();
  await page.locator('.tools-panel').getByRole('button', {name: 'Settings', exact: true}).click();
  const settings = page.locator('.settings-dialog[role="dialog"]');
  await settings.getByRole('tab', {name: 'Help', exact: true}).click();
  await settings.locator('[data-tutorial-replay]').click();
  const layer = page.locator('.tutorial-layer'), card = layer.getByRole('dialog', {name: 'Tutorial', exact: true});
  await expect(layer).toHaveAttribute('data-tutorial-step', '1'); await expect(region).toHaveText('');
  const destination = BROWSER_TUTORIAL_COURSES.essentials.steps.find(step => step.id === 'selection-finish')!.index;
  for (let index = 1; index < destination; index++) await card.getByRole('button', {name: 'Next', exact: true}).click();
  await expect(layer).toHaveAttribute('data-tutorial-active-target', 'selection-finish');
  await expect(region).toHaveText(''); await expect(region).toHaveAttribute('aria-live', 'polite');
  await expect(region).toHaveAttribute('aria-atomic', 'true');
  expect(await region.evaluate((element, original) => element === original, identity)).toBe(true);
  const demo = layer.locator('[data-tutorial-demo="selection-finish"]');
  await expect(demo).toHaveAttribute('aria-hidden', 'true'); await expect(demo).toHaveAttribute('inert', '');
  await expect(layer.getByRole('button', {name: 'Finalize selection', exact: true})).toHaveCount(0);
  await card.locator('.tutorial-card-body').focus(); await page.keyboard.press('Tab');
  await expect(card.getByRole('button', {name: 'Back', exact: true})).toBeFocused();
  retained(await snapshot(page), before);
  await page.keyboard.press('Escape'); await expect(layer).toHaveCount(0);
  await expect(region).toHaveText(ready(1)); retained(await snapshot(page), before);
  exact(await page.evaluate(() => window.accessibilityApp.command({command: 'redo'})), [0, 2]);
  exact(await page.evaluate(() => window.accessibilityApp.command({command: 'undo'})), [0]);
});
