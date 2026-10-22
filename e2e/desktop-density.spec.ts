import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { gaussianPly } from '../tests/fixtures/gaussians';

// Committed4e1be155 native-run-01: Basic panel610, Tool44, manual strip28;
// Selection→Transform→Color. Font increments retain native fixed spacing.
// ui_design.hpp/processing_ui.cpp/ui_widgets.hpp define the frame geometry.
// These cases load the ordinary App, actual worker/WASM and WebGPU renderer.
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const brightness = (page: Page) => tools(page).getByRole('slider', { name: 'Brightness', exact: true });
const apply = (page: Page) => tools(page).getByRole('button', { name: 'Apply color', exact: true });
const restore = (page: Page) => tools(page).getByRole('button', { name: 'Restore deleted', exact: true });
const sceneName = 'desktop-density.ply';

async function open(page: Page, size: 'small' | 'medium' | 'large' = 'small') {
  await page.addInitScript(size => {
    localStorage.setItem('splatview.ui-size.v1', size);
    localStorage.setItem('splatview.tools-mode.v1', 'basic');
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.ui-theme.v1', 'dark');
  }, size);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: sceneName, mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle(`${sceneName} \u2014 SplatView`);
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await page.evaluate(() => document.fonts.ready);
  const heading = (await tools(page).getByRole('heading', { name: 'Tools', exact: true }).boundingBox())!;
  await page.mouse.move(heading.x + heading.width / 2, heading.y + heading.height / 2);
}

async function gradeGeometry(page: Page) {
  return tools(page).getByRole('group', { name: 'Color grading', exact: true }).evaluate(element => {
    const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return [...element.querySelectorAll(':scope > .slider-row')].filter(node => !(node as HTMLElement).hidden).map(row => {
      const label = row.querySelector(':scope > span')!, frame = row.querySelector('.slider-control')!, output = frame.querySelector('output')!;
      const range = document.createRange(); range.selectNodeContents(output);
      const text = range.getBoundingClientRect(), valueBox = box(output), style = getComputedStyle(output);
      return { field: row.getAttribute('data-grade-field'), row: box(row), label: box(label), frame: box(frame),
        labelFont: getComputedStyle(label).fontSize, outputFont: style.fontSize,
        textCenterX: text.x + text.width / 2, outputCenterY: valueBox.y + valueBox.height / 2 };
    });
  });
}

for (const [size, increase, panelWidth] of [['small', 0, 300], ['medium', 2, 336], ['large', 4, 375]] as const) {
  test(`${size} Basic matches native idle density and both modes retain native grade frames`, async ({ page }, info) => {
    await open(page, size);
    await expect(apply(page)).toBeHidden(); await expect(restore(page)).toBeHidden();
    const bodyFont = 15 + increase, selectionY = 112 + 2 * bodyFont;
    const transformY = selectionY + 148 + 2 * bodyFont, colorY = transformY + 108;
    const actual = await tools(page).evaluate(element => {
      const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
      const node = (selector: string) => box(element.querySelector(selector)!);
      return { panel: box(element), heading: node('.tools-fixed > .panel-heading'), filename: node('.model-info'), stats: node('.model-stats'),
        histogram: node('.rendered-histogram'), sections: [...element.querySelectorAll('.tools-body > section > .tools-section-heading, .tools-body > section > fieldset > .tools-section-heading')].map(box),
        tool: node('.selection-menus [aria-label="Selection tool"]'), combine: node('.selection-boundary-label'), combineButtons: node('.selection-boundary-group .selection-segments'),
        alignment: node('.alignment-controls'), transformStrip: node('.transform-option-actions'),
        actionCaption: node('.selection-actions-caption'), actions: node('.selection-action-groups'), colorActions: node('.color-actions') };
    });
    expect(actual.panel.width).toBe(panelWidth); expect(actual.panel.height).toBe(610 + 8 * increase);
    expect(actual.heading).toMatchObject({ y: 18, height: 24 });
    expect(actual.filename).toMatchObject({ y: 46, height: bodyFont });
    expect(actual.stats).toMatchObject({ y: 50 + bodyFont, height: bodyFont });
    expect(actual.histogram).toMatchObject({ y: 54 + 2 * bodyFont, height: 54 });
    expect(actual.sections).toHaveLength(3);
    expect(actual.sections.map(row => [row.y, row.height])).toEqual([[selectionY, 24], [transformY, 24], [colorY, 24]]);
    expect(actual.tool).toMatchObject({ y: selectionY + 28, height: 44, width: panelWidth - 24 });
    expect(actual.combine).toMatchObject({ y: selectionY + 76, height: bodyFont });
    expect(actual.combineButtons).toMatchObject({ y: selectionY + 80 + bodyFont, height: 28 });
    expect(actual.actionCaption).toMatchObject({ y: selectionY + 112 + bodyFont, height: bodyFont });
    expect(actual.actions).toMatchObject({ y: selectionY + 116 + 2 * bodyFont, height: 28 });
    expect(actual.alignment).toMatchObject({ y: transformY + 28, height: 44 });
    expect(actual.transformStrip).toMatchObject({ y: transformY + 76, height: 28 });
    expect(actual.colorActions).toMatchObject({ y: colorY + 28, height: 44 });
    const observations: unknown[] = [{ mode: 'basic', actual }];
    // web-lite has no Pro mode; its eleven extra grade rows and Fade / boost are excluded (color.advanced).
    for (const mode of ['basic'] as const) {
      const rows = await gradeGeometry(page); observations.push({ mode, rows });
      expect(rows).toHaveLength(4);
      const workWidth = panelWidth - 24, labelWidth = Math.min(108 * bodyFont / 15, .43 * workWidth);
      for (const [index, row] of rows.entries()) {
        expect(row.row.width).toBe(workWidth); expect(row.labelFont).toBe(`${bodyFont}px`); expect(row.outputFont).toBe(`${bodyFont}px`);
        expect(row.label.width).toBeCloseTo(labelWidth, 1); expect(row.frame.x - row.row.x).toBeCloseTo(labelWidth + 6, 1);
        expect(row.frame.height).toBe(bodyFont + 6);
        expect(row.textCenterX).toBeCloseTo(row.frame.x + row.frame.width / 2, 1);
        expect(row.outputCenterY).toBeCloseTo(row.frame.y + row.frame.height / 2, 1);
        if (index) expect(row.row.y - rows[index - 1].row.y).toBe(bodyFont + 10);
      }
      expect(rows[0].frame.y).toBe(colorY + 80);
      await brightness(page).press('Enter');
      const entry = tools(page).getByRole('textbox', { name: 'Brightness value', exact: true });
      await expect(entry).toBeFocused(); expect((await entry.boundingBox())!.height).toBe(bodyFont + 4);
      await entry.fill('1.375'); await entry.press('Enter'); await expect(brightness(page)).toBeFocused();
      await expect(brightness(page)).toHaveValue('1.375');
      await tools(page).getByRole('button', { name: 'Reset color preview', exact: true }).click(); await expect(brightness(page)).toHaveValue('1');
      await expect(apply(page)).toBeHidden();
    }
    await info.attach('ordinary-app-native-density.json', { body: JSON.stringify({ size, increase, nativeBodyFont: bodyFont, observations }), contentType: 'application/json' });
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('Restore occupies a row only after real deletion and follows Undo and Redo', async ({ page }, info) => {
  await open(page); const color = tools(page).getByRole('heading', { name: 'Color', exact: true });
  const originalY = (await color.boundingBox())!.y;
  await expect(tools(page).locator('.selection-action-restore')).toHaveAttribute('hidden', '');
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await expect(restore(page)).toBeHidden();
  await tools(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/0 splats | SH3');
  await expect(restore(page)).toBeEnabled();
  const deletedY = (await color.boundingBox())!.y; expect(deletedY).toBeGreaterThan(originalY);
  await restore(page).click(); await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH3');
  await expect(restore(page)).toBeHidden(); expect((await color.boundingBox())!.y).toBe(originalY);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/0 splats | SH3'); await expect(restore(page)).toBeEnabled();
  expect((await color.boundingBox())!.y).toBe(deletedY);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH3'); await expect(restore(page)).toBeHidden();
  expect((await color.boundingBox())!.y).toBe(originalY);
  await expect(tools(page).locator('.selection-action-restore')).toHaveCount(1);
  await info.attach('conditional-restore-row.json', { body: JSON.stringify({ originalY, deletedY }), contentType: 'application/json' });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function exported(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await dialog.getByLabel('Export format', { exact: true }).selectOption('0');
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending, path = await downloaded.path(); expect(path).not.toBeNull();
  const bytes = await readFile(path!);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  return bytes;
}

test('pending-only Apply preserves keyboard preview, real color export, neutral restoration and history', async ({ page }, info) => {
  const failures: string[] = []; page.on('pageerror', error => failures.push(error.message));
  await open(page); const original = await exported(page);
  // Keep the comparison away from Tools and notifications: conditional rows
  // alone must not satisfy the actual rendered-color preview assertion.
  const sceneImage = () => page.screenshot({ clip: { x: 240, y: 150, width: 640, height: 600 } });
  const before = await sceneImage(), transform = tools(page).getByRole('heading', { name: 'Transform', exact: true });
  const idleY = (await transform.boundingBox())!.y;
  await expect(apply(page)).toBeHidden(); await expect(tools(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await brightness(page).focus(); await brightness(page).press('ArrowRight');
  await expect.poll(async () => Math.fround(Number(await brightness(page).inputValue()))).toBe(Math.fround(1.05)); await expect(apply(page)).toBeEnabled();
  await brightness(page).press('Enter'); const entry = tools(page).getByRole('textbox', { name: 'Brightness value', exact: true });
  await entry.fill('1.375'); await entry.press('Enter'); await expect(brightness(page)).toBeFocused();
  await expect(brightness(page)).toHaveValue('1.375');
  await expect(page).toHaveTitle(`${sceneName} \u2014 SplatView`); await expect(tools(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  // Color follows Transform in desktop order. Its conditional Apply row must
  // leave the preceding Transform section at the same position.
  const pendingY = (await transform.boundingBox())!.y; expect(pendingY).toBe(idleY);
  await expect.poll(async () => (await sceneImage()).equals(before)).toBe(false);
  await apply(page).click(); await expect(apply(page)).toBeHidden(); await expect(brightness(page)).toBeFocused();
  await expect(page).toHaveTitle(`\u2022 ${sceneName} \u2014 SplatView`);
  await expect(tools(page).getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  expect((await transform.boundingBox())!.y).toBe(idleY);
  // Export settles the absolute-color baseline. Restore neutral before crossing
  // that boundary; inspect the baked endpoint through executable Undo below.
  await tools(page).getByRole('button', { name: 'Reset color preview', exact: true }).click();
  await expect(brightness(page)).toHaveValue('1'); await expect(apply(page)).toBeEnabled();
  expect((await transform.boundingBox())!.y).toBe(pendingY);
  await apply(page).click(); await expect(apply(page)).toBeHidden(); await expect(brightness(page)).toBeFocused();
  expect((await exported(page)).equals(original)).toBe(true);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  const baked = await exported(page); expect(baked.equals(original)).toBe(false);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  expect((await exported(page)).equals(original)).toBe(true);
  await expect(tools(page).locator('button').filter({ hasText: /^Apply color$/ })).toHaveCount(1);
  await expect(apply(page)).toBeHidden(); await expect(page.getByRole('alert')).toHaveCount(0); expect(failures).toEqual([]);
  await info.attach('pending-apply-native-export-history.json', { body: JSON.stringify({ originalBytes: original.length, bakedBytes: baked.length,
    originalAndBakedDiffer: !original.equals(baked), idleY, pendingY }), contentType: 'application/json' });
});
