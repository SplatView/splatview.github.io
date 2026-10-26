import { expect, test, type Page } from '@playwright/test';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { desktopIcons } from '../src/generated/desktop';
import { currentDesktopIcons } from '../src/generated/currentDesktopIcons';
import type { AutoColorMethod } from '../src/document/colorProtocol';

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const auto = (page: Page) => tools(page).getByRole('button', { name: 'Auto color', exact: true });
const apply = (page: Page) => tools(page).getByRole('button', { name: 'Apply color', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.autoColorHarness.snapshot());
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.autoColorHarness.state())).toMatchObject({ busy: false, controlsEnabled: true });
}
async function app(page: Page, mode: 'basic' | 'pro' = 'basic') {
  await page.addInitScript(value => localStorage.setItem('splatview.tools-mode.v1', value), mode);
  await page.goto('/e2e/auto-color-harness.html');
  await expect.poll(() => page.evaluate(() => window.autoColorHarness?.ready() ?? false)).toBe(true);
  await page.evaluate(() => window.autoColorHarness.load()); await page.mouse.move(640, 400); await settled(page);
}
async function chooseAuto(page: Page, label: string) {
  await auto(page).click();
  await page.getByRole('menu', { name: 'Auto color actions', exact: true }).getByRole('menuitem', { name: label, exact: true }).click();
  await settled(page);
}
async function preview(page: Page, values: number[]) { await page.evaluate(values => window.autoColorHarness.preview(values), values); }
function retained(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  expect(after.exported).toBe(before.exported); expect(after.records).toEqual(before.records);
  expect(after.grade).toEqual(before.grade); expect(after.appliedGrade).toEqual(before.appliedGrade);
  expect(after.colorSession).toEqual(before.colorSession); expect(after.sourceFingerprint).toEqual(before.sourceFingerprint);
  expect(after.capture.hash).toBe(before.capture.hash);
  expect(after.camera).toEqual(before.camera); expect(after.background).toBe(before.background);
  expect(after.summary.selected).toBe(before.summary.selected); expect(after.summary.visible).toBe(before.summary.visible);
  expect(after.summary.canUndo).toBe(before.summary.canUndo); expect(after.summary.canRedo).toBe(before.summary.canRedo);
  expect(after.workBytes).toBe(0);
}

// web-lite has no Pro mode, so the selector layout is checked once per size.
for (const mode of ['basic'] as const) for (const size of ['small', 'medium', 'large'] as const)
  test(`${mode} ${size} Auto and Presets retain desktop selectors and all four exact icons`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('splatview.ui-size.v1', value), size); await app(page, mode);
    const row = tools(page).getByRole('group', { name: 'Color actions', exact: true });
    const a = (await auto(page).boundingBox())!, p = (await row.getByRole('button', { name: 'Color preset', exact: true }).boundingBox())!;
    expect(a.height).toBe(44); expect(p.height).toBe(44); expect(a.width).toBe(p.width); expect(p.x - a.x - a.width).toBe(6);
    await auto(page).click();
    const menu = page.getByRole('menu', { name: 'Auto color actions', exact: true });
    await expect(menu.getByRole('menuitem')).toHaveText(['Auto', 'Exposure', 'Contrast', 'White balance']);
    const scale = size === 'small' ? 1 : size === 'medium' ? 1.12 : 1.25;
    expect((await menu.boundingBox())!.width).toBeCloseTo(224 * scale, 1);
    for (const [label, icon] of [['Auto', 'AutoColor'], ['Exposure', 'Exposure'], ['Contrast', 'AutoContrast'], ['White balance', 'WhiteBalance']]) {
      const item = menu.getByRole('menuitem', { name: label, exact: true });
      expect((await item.boundingBox())!.height).toBe(28);
      const actual = await item.locator('.icon svg').evaluate(element => element.outerHTML);
      const expected = await page.evaluate(svg => {
        const container = document.createElement('div'); container.innerHTML = svg; return container.querySelector('svg')!.outerHTML;
      }, currentDesktopIcons[icon] ?? desktopIcons[icon]);
      expect(actual).toBe(expected);
    }
    await menu.getByRole('menuitem').first().press('Escape'); await expect(menu).toHaveCount(0); await expect(auto(page)).toBeFocused();
  });

test('manual color changes remain absolute on one baseline and neutral Apply restores that baseline', async ({ page }) => {
  await app(page);
  // Keep the real pointer on chrome while native/GPU snapshots cross the idle-hide delay.
  const heading = (await tools(page).getByRole('heading', { name: 'Tools', exact: true }).boundingBox())!;
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  const original = await snapshot(page), firstValues = [...NEUTRAL_COLOR]; firstValues[0] = Math.fround(1.2);
  await preview(page, firstValues); await apply(page).click(); await settled(page); const first = await snapshot(page);
  expect(first.exported).not.toBe(original.exported); expect(first.capture.hash).not.toBe(original.capture.hash);
  expect(first.grade).toEqual(firstValues); expect(first.appliedGrade).toEqual(firstValues);
  const secondValues = [...firstValues]; secondValues[0] = 1.5;
  await preview(page, secondValues); await apply(page).click(); await settled(page); const second = await snapshot(page);
  expect(second.exported).not.toBe(first.exported); expect(second.colorSession?.baseId).toBe(first.colorSession?.baseId);
  await preview(page, firstValues); await apply(page).click(); await settled(page);
  const repeated = await snapshot(page); expect(repeated.exported).toBe(first.exported); expect(repeated.capture.hash).toBe(first.capture.hash);
  await tools(page).getByRole('button', { name: 'Reset color preview', exact: true }).click();
  await expect(apply(page)).toBeEnabled(); await apply(page).click(); await settled(page);
  const restored = await snapshot(page); expect(restored.exported).toBe(original.exported); expect(restored.capture.hash).toBe(original.capture.hash);
  expect(restored.appliedGrade).toEqual(NEUTRAL_COLOR);
  await expect(apply(page)).toBeHidden();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  expect((await snapshot(page)).exported).toBe(first.exported);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  expect((await snapshot(page)).exported).toBe(original.exported);
});

test('Single selection settles the pending manual scope and Undo restores selection before the grade', async ({ page }, testInfo) => {
  await app(page); await page.evaluate(() => window.autoColorHarness.seed([0]));
  const observe = async () => {
    const value = await snapshot(page);
    const masks = await page.evaluate(async () => {
      const controller = window.geometryViewer.controllerForSourceNavigation();
      let nativeMasks: number[] = [];
      await controller.client!.stream(async () => {}, bytes => { nativeMasks = Array.from(new Uint8Array(bytes)); });
      return { nativeMasks, gpuMasks: (await window.geometryViewer.snapshot()).gpuMasks };
    });
    return { ...value, ...masks };
  };
  const original = await observe(), values = [...NEUTRAL_COLOR]; values[0] = 1.5;
  await preview(page, values); const pending = await observe();
  expect(pending.colorPending).toBe(true); expect(pending.colorSelectedOnly).toBe(true);
  expect(pending.grade).toEqual(values); expect(pending.appliedGrade).toEqual(NEUTRAL_COLOR);
  expect(pending.exported).toBe(original.exported); expect(pending.records).toEqual(original.records);
  expect(pending.capture.hash).not.toBe(original.capture.hash); await expect(apply(page)).toBeEnabled();
  await page.evaluate(() => window.autoColorHarness.command({ command: 'single', index: 1, operation: 0 })); await settled(page);
  const selected = await observe();
  expect(selected.nativeMasks).toEqual([0, 1, 0]); expect(selected.summary.selected).toBe(1);
  expect(selected.records[0]).not.toEqual(original.records[0]); expect(selected.records.slice(1)).toEqual(original.records.slice(1));
  expect(selected.exported).not.toBe(original.exported); expect(selected.capture.hash).not.toBe(original.capture.hash);
  await expect(apply(page)).toBeHidden();
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const selectionUndone = await observe();
  expect(selectionUndone.nativeMasks).toEqual(original.nativeMasks); expect(selectionUndone.summary.selected).toBe(1);
  expect(selectionUndone.exported).toBe(selected.exported); expect(selectionUndone.records).toEqual(selected.records);
  expect(selectionUndone.capture.hash).toBe(selected.capture.hash);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  const gradeUndone = await observe();
  expect(gradeUndone.exported).toBe(original.exported); expect(gradeUndone.records).toEqual(original.records);
  expect(gradeUndone.nativeMasks).toEqual(original.nativeMasks); expect(gradeUndone.capture.hash).toBe(original.capture.hash);
  for (const endpoint of [original, pending, selected, selectionUndone, gradeUndone]) {
    expect(endpoint.gpuMasks).toEqual(endpoint.nativeMasks); expect(endpoint.sourceFingerprint).toEqual(original.sourceFingerprint);
    expect(endpoint.camera).toEqual(original.camera); expect(endpoint.background).toBe(original.background);
  }
  for (const endpoint of [selected, selectionUndone, gradeUndone]) {
    expect(endpoint.grade).toEqual(NEUTRAL_COLOR); expect(endpoint.appliedGrade).toEqual(NEUTRAL_COLOR);
    expect(endpoint.colorSession).toBeNull(); expect(endpoint.colorPending).toBe(false); expect(endpoint.colorSelectedOnly).toBe(false);
    expect(endpoint.summary).toMatchObject({ pending: false, transaction: false, selectionDraft: false });
    expect(endpoint.workBytes).toBe(0);
  }
  await testInfo.attach('pending-color-single-boundary', { contentType: 'application/json', body: JSON.stringify({
    original, pending, selected, selectionUndone, gradeUndone,
  }) });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Exposure preserves other absolute fields and the selected scope, including fields hidden in Basic', async ({ page }) => {
  await app(page); await page.evaluate(() => window.autoColorHarness.seed([0]));
  const values = [...NEUTRAL_COLOR]; values[2] = 1.25; values[3] = Math.fround(1.4); values[4] = Math.fround(1.1); values[12] = 33; values[14] = 15;
  await preview(page, values); const before = await snapshot(page);
  await chooseAuto(page, 'Exposure');
  const after = await snapshot(page);
  expect(after.grade.slice(1)).toEqual(values.slice(1)); expect(after.grade[0]).not.toBe(values[0]);
  expect(after.appliedGrade).toEqual(after.grade); expect(after.colorSelectedOnly).toBe(true);
  expect(after.summary.selected).toBe(1); expect(after.records.slice(1)).toEqual(before.records.slice(1));
  expect(after.records[0]).not.toEqual(before.records[0]); await expect(apply(page)).toBeHidden();
  await expect(tools(page).getByRole('button', { name: 'Color preset', exact: true })).toContainText('Custom');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('the remembered Auto action survives Tools changes, and resets for a newly published source', async ({ page }) => {
  await app(page); await chooseAuto(page, 'White balance'); await expect(auto(page)).toContainText('White balance');
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(auto(page)).toContainText('White balance'); await page.evaluate(() => window.autoColorHarness.load('auto-color-new.ply'));
  await settled(page); await expect(auto(page)).toContainText('Auto'); await expect(auto(page)).not.toContainText('White balance');
});

test('presets dispatch all 15 values and click menus close without applying on Escape', async ({ page }) => {
  await app(page); const before = await snapshot(page), trigger = tools(page).getByRole('button', { name: 'Color preset', exact: true });
  await trigger.click(); const menu = page.getByRole('menu', { name: 'Color presets', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['neutral', 'warm', 'cool', 'vibrant', 'muted', 'cinematic', 'grayscale']);
  await menu.getByRole('menuitemradio').first().press('Escape'); await expect(menu).toHaveCount(0); retained(await snapshot(page), before);
  await trigger.click(); await menu.getByRole('menuitemradio', { name: 'warm', exact: true }).click();
  await expect(trigger).toContainText('warm'); await expect(apply(page)).toBeEnabled();
  const previewed = await snapshot(page); expect(previewed.grade).toHaveLength(15); expect(previewed.exported).toBe(before.exported);
});

test('a newer manual preview survives an older actual native bake acknowledgement', async ({ page }) => {
  await app(page); const first = [...NEUTRAL_COLOR], next = [...NEUTRAL_COLOR]; first[0] = Math.fround(1.2); next[0] = 1.5;
  await preview(page, first); await page.evaluate(() => window.autoColorHarness.holdManualBake());
  await expect(auto(page)).toBeDisabled(); await expect(apply(page)).toBeDisabled();
  await expect(tools(page).getByRole('slider', { name: 'Brightness', exact: true })).toBeEnabled();
  await preview(page, next); expect(await page.evaluate(() => window.autoColorHarness.releaseManualBake())).toBe(true); await settled(page);
  const after = await snapshot(page); expect(after.appliedGrade).toEqual(first); expect(after.grade).toEqual(next);
  await expect(apply(page)).toBeEnabled(); await apply(page).click(); await settled(page);
  expect((await snapshot(page)).appliedGrade).toEqual(next);
});

for (const method of ['enhance', 'exposure', 'contrast', 'white_balance'] as const satisfies readonly AutoColorMethod[])
  test(`${method} admission refusal preserves actual native data, fields and executable Redo`, async ({ page }) => {
    await app(page); const values = [...NEUTRAL_COLOR]; values[0] = 1.2;
    await preview(page, values); await apply(page).click(); await settled(page);
    await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
    const result = await page.evaluate(method => window.autoColorHarness.admissionRefusal(method), method);
    expect(result.accepted).toBe(false); expect(result.error).toMatch(/budget|memory|allocation/i); retained(result.after, result.before);
    await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
    expect((await snapshot(page)).exported).not.toBe(result.before.exported);
  });

test('refused publication rolls back after actual native Auto computation and GPU completion', async ({ page }) => {
  await app(page); const result = await page.evaluate(() => window.autoColorHarness.publicationRefusal());
  expect(result).toMatchObject({ accepted: false, decoded: true, failed: true }); retained(result.after, result.before);
  expect(result.error).toContain('refused publication');
});

test('cancelling real cooperative Auto work retires its candidate and retains original data and fields', async ({ page }) => {
  await app(page); const result = await page.evaluate(() => window.autoColorHarness.cancelPending());
  expect(result.cancelled).toBe(true); expect(result.progress.some(value => value < 1)).toBe(true); expect(result.accepted).toBe(false);
  retained(result.after, result.before);
});

test('actual graphics recovery retains baked absolute fields and the native color baseline', async ({ page }) => {
  await app(page); await chooseAuto(page, 'Exposure');
  const result = await page.evaluate(() => window.autoColorHarness.recover()); retained(result.after, result.before);
  expect(result.after.rendererState).toBe('ready'); expect(result.after.colorSession?.baseId).toBe(result.before.colorSession?.baseId);
  await expect(apply(page)).toBeHidden();
  await tools(page).getByRole('button', { name: 'Reset color preview', exact: true }).click(); await expect(apply(page)).toBeEnabled();
  await apply(page).click(); await settled(page); expect((await snapshot(page)).appliedGrade).toEqual(NEUTRAL_COLOR);
});
