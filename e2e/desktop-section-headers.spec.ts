import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';

// Independent layout constants from capture02 ui_widgets.hpp:266–336 and
// ui_design.hpp:10–19. These cases load the real App, native decoder and GPU.
const sections = [
  ['Selection', 'Reset cleanup', 'selection-panel-controls'],
  ['Color', 'Reset color preview', 'color-panel-controls'],
  ['Transform', 'Reset transform', 'transform-panel-controls'],
] as const;
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });

async function open(page: Page, size: 'small' | 'medium' | 'large') {
  await page.addInitScript(size => {
    localStorage.setItem('splatview.ui-size.v1', size);
    localStorage.setItem('splatview.tools-mode.v1', 'basic');
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.ui-theme.v1', 'dark');
  }, size);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'desktop-section-headers.ply',
    mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('desktop-section-headers.ply — SplatView');
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(panel(page).locator('.mode-button')).toBeHidden();
  await expect(panel(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
}

for (const [size, increase] of [['small', 0], ['medium', 2], ['large', 4]] as const) {
  // web-lite has no Pro mode, so section folding toggles never render.
  test(`${size} Basic uses desktop caption, separator and independent Reset geometry`, async ({ page }, info) => {
    await open(page, size);
    const observations: unknown[] = [];
    for (const mode of ['basic'] as const) {
      for (const [name, resetName] of sections) {
        const heading = panel(page).getByRole('heading', { name, exact: true, level: 2 });
        await expect(heading).toHaveAccessibleName(name);
        const row = heading.locator('..');
        await row.scrollIntoViewIfNeeded(); await page.mouse.move(8, 300);
        await expect(row.getByRole('button', { name: resetName, exact: true })).toHaveCount(1);
        const toggle = row.getByRole('button', { name, exact: true });
        await expect(toggle).toHaveCount(0);
        const actual = await row.evaluate(element => {
          const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right }; };
          const heading = element.querySelector('h2')!, reset = element.querySelector(':scope > button')!;
          const caption = element.querySelector('.tools-section-caption')!, rule = element.querySelector('.tools-section-rule')!;
          const chevron = element.querySelector('.selection-section-chevron');
          return { row: box(element), caption: box(caption), rule: box(rule), reset: box(reset),
            weight: getComputedStyle(heading).fontWeight, font: getComputedStyle(heading).fontSize,
            ruleColor: getComputedStyle(rule).backgroundColor, resetBackground: getComputedStyle(reset).backgroundColor,
            resetBorder: getComputedStyle(reset).borderTopWidth, glyph: box(reset.querySelector('.icon')!),
            chevron: chevron ? { ...box(chevron), font: getComputedStyle(chevron).fontSize } : null };
        });
        observations.push({ size, mode, name, actual });
        expect(actual.row.height).toBe(24); expect(actual.weight).toBe('400'); expect(actual.font).toBe(`${15 + increase}px`);
        expect(actual.caption.x - actual.row.x).toBeCloseTo(27 + increase, 1);
        expect(actual.rule.x - actual.caption.right).toBeCloseTo(8, 1);
        expect(actual.rule.width).toBeGreaterThan(0); expect(actual.rule.height).toBe(1);
        expect(actual.rule.y + actual.rule.height / 2 - actual.row.y).toBeCloseTo(12, 1);
        expect(actual.ruleColor).toBe('rgb(34, 34, 34)');
        expect(actual.reset.x - actual.rule.right).toBeCloseTo(6, 1);
        expect(actual.reset).toMatchObject({ width: 24, height: 24, y: actual.row.y, right: actual.row.right });
        expect(actual.resetBackground).toBe('rgba(0, 0, 0, 0)'); expect(actual.resetBorder).toBe('0px');
        expect(actual.glyph).toMatchObject({ width: 16, height: 16 });
        expect(actual.chevron).toBeNull();
      }
    }
    await info.attach('desktop-section-header-geometry.json', { body: JSON.stringify(observations), contentType: 'application/json' });
  });
}

// Pro section folding is excluded; Reset remains an independent header action.
test('Basic Reset header action restores the preview without an edit', async ({ page }) => {
  await open(page, 'large');
  const brightness = panel(page).getByRole('slider', { name: 'Brightness', exact: true });
  await brightness.click({ button: 'right' });
  const entry = panel(page).getByRole('textbox', { name: 'Brightness value', exact: true });
  await entry.fill('1.25'); await entry.press('Enter'); await expect(brightness).toHaveValue('1.25');
  const toggle = panel(page).getByRole('button', { name: 'Color', exact: true });
  const reset = panel(page).getByRole('button', { name: 'Reset color preview', exact: true });
  await expect(reset).toBeEnabled();
  await reset.hover(); await expect(reset).toHaveCSS('background-color', 'rgb(38, 38, 38)');
  await expect(reset.locator('.icon')).toHaveCSS('color', 'rgb(232, 232, 232)');
  await expect(toggle).toHaveCount(0);
  await reset.focus(); await reset.press('Space'); await expect(brightness).toHaveValue('1');
  await expect(panel(page).getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

// Grow/Shrink refinement and its parameter row are excluded (selection.advanced).
test('the 300px Tools panel keeps the Basic Combine work region without refinement', async ({ page }, info) => {
  await open(page, 'small');
  const observations: unknown[] = [];
  for (const mode of ['basic'] as const) {
    for (const width of [1280, 310, 260]) {
      // Keep the full Pro controls visible so this test isolates the horizontal
      // wrap threshold from scrollbar width; existing shell cases cover scroll.
      await page.setViewportSize({ width, height: 2000 });
      await panel(page).getByRole('heading', { name: 'Selection', exact: true, level: 2 }).scrollIntoViewIfNeeded();
      const actual = await panel(page).evaluate(element => {
        const box = (node: Element) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const row = element.querySelector('.selection-boundary-row')!, groups = row.querySelectorAll(':scope > .selection-boundary-group');
        return { panel: box(element), fixed: box(element.querySelector('.tools-fixed')!), body: box(element.querySelector('.tools-body')!),
          work: box(element.querySelector('.tools-body > section')!),
          combine: box(groups[0]), refine: groups[1] ? box(groups[1]) : null,
          parameter: row.querySelector('.selection-morphology-parameter') ? box(row.querySelector('.selection-morphology-parameter')!) : null,
          buttons: groups[1] ? [...groups[1].querySelectorAll('button')].map(button => ({ ...box(button), label: button.getAttribute('aria-label') })) : [] };
      });
      observations.push({ mode, width, actual });
      expect(actual.fixed.x - actual.panel.x).toBe(12); expect(actual.body.x - actual.panel.x).toBe(12);
      expect(actual.fixed.width).toBe(actual.panel.width - 24); expect(actual.work.width).toBe(actual.panel.width - 24);
      // Native child scrolling extends into the right inset; its scrollbar
      // must leave the full section work width available to the controls.
      expect(actual.body.width).toBe(actual.work.width + 10);
      expect(actual.combine.width).toBe(120);
      if (width === 1280) {
        expect(actual.panel.width).toBe(300); expect(actual.body.width).toBe(286); expect(actual.work.width).toBe(276);
      }
      expect(actual.refine).toBeNull(); expect(actual.parameter).toBeNull(); expect(actual.buttons).toEqual([]);
    }
    await page.setViewportSize({ width: 1280, height: 2000 });
  }
  await info.attach('desktop-selection-work-region.json', { body: JSON.stringify(observations), contentType: 'application/json' });
});
