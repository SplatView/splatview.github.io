import { test, expect, type Page } from '@playwright/test';
import type {} from './ui-size-harness';

const key = 'splatview.ui-size.v1';
async function open(page: Page) {
  await page.goto('/e2e/ui-size-harness.html');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
}
async function choices(page: Page) {
  await page.getByRole('button', { name: 'Font size', exact: true }).click();
  return page.getByRole('listbox', { name: 'Font size choices', exact: true });
}
const persisted = (page: Page) => page.evaluate(key => localStorage.getItem(key), key);
const appearance = (page: Page) => page.locator('main').getAttribute('data-ui-size');
async function geometry(page: Page) {
  return page.evaluate(() => {
    const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
    const bounds = (target: string | Element) => { const r = (typeof target === 'string' ? document.querySelector(target)! : target).getBoundingClientRect(); return { width: r.width, height: r.height }; };
    return { body: css('main').fontSize, heading: css('.tools-panel h1').fontSize, caption: css('.slider-control output').fontSize,
      tools: bounds('.tools-panel'), dialog: bounds('[role="dialog"][aria-label="Settings"]'), toolbar: bounds('[aria-label="Open scene"]'),
      smallIcon: bounds('[aria-label="Close Settings"]'), slider: bounds('.slider-control'),
      auto: bounds('.color-selector[aria-label="Auto color"]'), preset: bounds('.color-selector[aria-label="Color preset"]'),
      colorActions: bounds('.color-actions'), colorGap: Number.parseFloat(css('.color-actions').columnGap),
      settingAction: bounds(Array.from(document.querySelectorAll('[role="tabpanel"] button')).find(button => button.textContent?.trim() === 'Close scene')!),
      viewAction: bounds('.dialog-actions > button'), fontPicker: bounds('.font-size-trigger'),
      padding: css('.tools-panel').padding, canvas: bounds('canvas') };
  });
}

test('Font size previews pointer/keyboard choices and restores committed appearance when dismissed or suspended', async ({ page }) => {
  await open(page); expect(await appearance(page)).toBe('small');
  const before = await page.evaluate(() => window.uiSizeHarness.application());
  let menu = await choices(page);
  await expect(menu.getByRole('option')).toHaveCount(3);
  for (const name of ['Small', 'Medium', 'Large']) await expect(menu.getByRole('option', { name, exact: true })).toBeVisible();
  const anchor = await menu.boundingBox();
  await menu.getByRole('option', { name: 'Large', exact: true }).hover();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large'); expect(await persisted(page)).toBeNull();
  expect(await menu.boundingBox()).toEqual(anchor);
  await page.mouse.move(20, 200); await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  const trigger = page.getByRole('button', { name: 'Font size', exact: true });
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large'); expect(await persisted(page)).toBeNull();
  await page.keyboard.press('Escape'); await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  menu = await choices(page); await menu.getByRole('option', { name: 'Large', exact: true }).hover();
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  menu = await choices(page); await menu.getByRole('option', { name: 'Large', exact: true }).hover();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(menu).toHaveCount(0); await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('dialog', { name: 'Settings', exact: true }).press('ControlOrMeta+z');
  expect(await page.evaluate(() => window.uiSizeHarness.application())).toEqual(before);
});

test('Font size commits across reload while retaining native logical increments, panel ratios and fixed controls', async ({ page }, testInfo) => {
  await open(page); const small = await geometry(page);
  expect(small.body).toBe('15px'); expect(small.heading).toBe('20px'); expect(small.caption).toBe('15px');
  expect(small.slider.height).toBe(21);
  expect(small.tools.width).toBe(300); expect(small.dialog.width).toBe(300); expect(small.toolbar).toEqual({ width: 36, height: 36 });
  // Captured ui_design.hpp/color_ui.cpp: both icon selectors use the 44px
  // selector height and split their row equally with a 6px gap.
  expect(small.auto.height).toBe(44); expect(small.preset.height).toBe(44); expect(small.colorGap).toBe(6);
  expect(small.auto.width).toBe(small.preset.width); expect(small.auto.width * 2 + small.colorGap).toBe(small.colorActions.width);
  await page.screenshot({ path: testInfo.outputPath('browser-only-settings-small.png') });
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('browser-only-tools-small.png') });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // Numeric transform vectors are excluded from web-lite (transform.numeric); the Basic/Pro toggle is hidden.
  for (const [name, size, font, heading, caption, sliderHeight, width, scale] of [
    ['Medium', 'medium', '17px', '22px', '17px', 23, 336, 1.12], ['Large', 'large', '19px', '24px', '19px', 25, 375, 1.25],
  ] as const) {
    const menu = await choices(page); await menu.getByRole('option', { name, exact: true }).click();
    expect(await persisted(page)).toBe(size); const changed = await geometry(page);
    expect(changed.body).toBe(font); expect(changed.heading).toBe(heading); expect(changed.caption).toBe(caption);
    expect(changed.tools.width).toBeCloseTo(width, 1); expect(changed.dialog.width).toBeCloseTo(small.dialog.width * scale, 1);
    for (const control of ['toolbar', 'smallIcon', 'canvas'] as const) expect(changed[control]).toEqual(small[control]);
    expect(changed.slider.height).toBe(sliderHeight);
    for (const control of ['auto', 'preset', 'viewAction'] as const) expect(changed[control].height).toBe(small[control].height);
    // Compact Settings property rows scale with the font (windows-design.spec.ts);
    // plain General actions follow the existing 28px non-small button rule.
    expect(small.fontPicker.height).toBe(21); expect(changed.fontPicker.height).toBe(size === 'medium' ? 23 : 25);
    expect(changed.colorGap).toBe(6); expect(changed.auto.width).toBe(changed.preset.width);
    expect(changed.auto.width * 2 + changed.colorGap).toBe(changed.colorActions.width);
    expect(changed.padding).toBe(small.padding);
  }
  await page.screenshot({ path: testInfo.outputPath('browser-only-settings-large.png') });
  await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath('browser-only-tools-large.png') });
  await page.reload(); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  expect(await page.evaluate(() => window.uiSizeHarness.application())).toMatchObject({ mode: 'basic', dirty: false, summary: null, commands: [] });
});

test('Font size save failures restore the committed choice, report the error and permit retry', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (key === 'splatview.ui-size.v1') throw new DOMException('Blocked', 'QuotaExceededError'); original.call(this, key, value); };
    (window as unknown as { restoreUiSizeStorage(): void }).restoreUiSizeStorage = () => { Storage.prototype.setItem = original; };
  });
  let menu = await choices(page); await menu.getByRole('option', { name: 'Large', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Could not save font size');
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small'); expect(await persisted(page)).toBeNull();
  await expect(page.getByRole('button', { name: 'Font size', exact: true })).toBeEnabled();
  await page.evaluate(() => (window as unknown as { restoreUiSizeStorage(): void }).restoreUiSizeStorage());
  menu = await choices(page); await menu.getByRole('option', { name: 'Medium', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0); expect(await persisted(page)).toBe('medium');
});

test('Large font stays reachable at a compact viewport and keyboard activation commits', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 500 }); await open(page);
  const trigger = page.getByRole('button', { name: 'Font size', exact: true });
  await trigger.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('End'); await page.keyboard.press('Enter');
  expect(await persisted(page)).toBe('large');
  const menu = await choices(page), bounds = await menu.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420);
  await expect(menu.getByRole('option', { name: 'Small', exact: true })).toBeInViewport();
  await expect(menu.getByRole('option', { name: 'Large', exact: true })).toBeInViewport();
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
});

test('Settings contains keyboard focus including its picker portal and restores the opener', async ({ page }) => {
  await open(page);
  const close = page.getByRole('button', { name: 'Close Settings', exact: true }), trigger = page.getByRole('button', { name: 'Font size', exact: true });
  await expect(close).toBeFocused();
  // General now ends with folder and remembered-view actions (web-toolbar.spec.ts).
  await page.keyboard.press('Shift+Tab'); await expect(close).not.toBeFocused();
  expect(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"][aria-label="Settings"]'))).toBe(true);
  await page.keyboard.press('Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('tab', { name: 'General', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Language', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('listbox', { name: 'Font size choices', exact: true });
  await expect(menu.getByRole('option', { name: 'Small', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  await page.keyboard.press('Tab'); await expect(menu).toHaveCount(0);
  const renderer = page.getByRole('combobox', { name: 'Gaussian renderer', exact: true });
  await expect(renderer).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Open folder', exact: true })).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  await page.keyboard.press('Shift+Tab'); await expect(renderer).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(trigger).toBeFocused();
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('End');
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeFocused();
});
