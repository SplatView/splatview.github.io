import { expect, test, type Page } from '@playwright/test';
import nativeMetrics from '../tests/fixtures/desktop-font-metrics-v1.json' with { type: 'json' };
import { gaussianPly } from '../tests/fixtures/gaussians';

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
  await page.getByLabel('Open scene files').setInputFiles({ name: 'demo.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) });
  await expect(page).toHaveTitle('demo.ply — SplatView');
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
  await page.evaluate(() => document.fonts.ready);
}

async function platformFonts(page: Page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable'); await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const result: Record<string, { familyName: string; postScriptName: string; isCustomFont: boolean; glyphCount: number }[]> = {};
    for (const [role, selector] of [['body', '.tools-section-caption'], ['title', '.tools-panel .panel-heading h1']] as const) {
      const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      expect(nodeId).toBeGreaterThan(0);
      result[role] = (await session.send('CSS.getPlatformFontsForNode', { nodeId })).fonts;
    }
    return result;
  } finally { await session.detach(); }
}

async function monoUsesItsOwnScale(page: Page, increase: number) {
  await panel(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await settings.getByRole('button', { name: 'About', exact: true }).click();
  const code = page.getByRole('dialog', { name: 'About', exact: true }).locator('code[data-app-input-id]');
  await expect(code).toBeVisible(); await expect(code).toHaveCSS('font-size', `${13 + increase}px`);
  await expect(code).toHaveCSS('font-size-adjust', 'none');
  expect(await code.evaluate(element => getComputedStyle(element).fontFamily)).toMatch(/^Consolas,/);
}

test('Small English Segoe UI advances match actual native measurements within one logical pixel', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'The native same-face width comparison needs the Chromium platform-font observer; this environment remains unqualified.');
  await open(page, 'small');
  expect(nativeMetrics.kind).toBe('splatview-native-font-metrics'); expect(nativeMetrics.cases).toHaveLength(12);
  const actualFonts = await platformFonts(page);
  // This width comparison is deliberately the recorded same-face English
  // scope; the portable fallback rule does not promise identical advances.
  const sameFace = ['body', 'title'].every(role => actualFonts[role].some(font => font.familyName === 'Segoe UI' && !font.isCustomFont && font.glyphCount > 0));
  await info.attach('native-font-comparison-scope.json', { body: JSON.stringify({ reference: nativeMetrics.reference, actualFonts,
    sameFace, scope: sameFace ? 'English-Segoe-UI-Small-advance-widths-only' : 'native-width-comparison-unqualified-actual-face-unavailable' }), contentType: 'application/json' });
  test.skip(!sameFace, 'The actual platform font is not the captured Segoe UI face; fallback advance widths remain unqualified.');
  const observed = await panel(page).evaluate((element, fixture) => {
    const body = element.querySelector('.tools-section-caption')!, title = element.querySelector('.panel-heading h1')!;
    const roles = { body: getComputedStyle(body), title: getComputedStyle(title) };
    const nodes = [...element.querySelectorAll('.tools-section-caption'), element.querySelector('.model-info')!,
      element.querySelector('.selection-boundary-row .selection-boundary-label')!, title];
    const cases = fixture.cases.map(expected => {
      const role = expected.role === 'body' ? 'body' : 'title', style = roles[role], font = fixture.fonts[role];
      const context = document.createElement('canvas').getContext('2d')!;
      // Canvas does not inherit CSS font-size-adjust. Use the independently
      // observed loaded native font's em conversion, not a fitted text width.
      context.font = `${expected.weight} ${expected.nominalSize * font.emToPixelHeightRatio}px ${style.fontFamily}`;
      if (style.fontKerning === 'none' || style.fontKerning === 'normal') context.fontKerning = style.fontKerning;
      const node = nodes.find(node => node.textContent === expected.text && (node === title ? 'title' : 'body') === role);
      let domWidth: number | null = null;
      if (node) { const range = document.createRange(); range.selectNodeContents(node); domWidth = range.getBoundingClientRect().width; }
      return { ...expected, canvasWidth: context.measureText(expected.text).width, canvasFont: context.font, domWidth,
        computedFontSize: style.fontSize, computedWeight: style.fontWeight, adjust: style.getPropertyValue('font-size-adjust') };
    });
    return { cases, devicePixelRatio, viewportScale: visualViewport?.scale ?? null };
  }, nativeMetrics);
  await info.attach('observed-native-font-advances.json', { body: JSON.stringify({ reference: nativeMetrics.reference,
    nativeFonts: nativeMetrics.fonts, actualFonts, observed, toleranceLogicalPixels: 1 }), contentType: 'application/json' });
  expect(observed.cases.filter(value => value.domWidth !== null)).toHaveLength(6);
  for (const actual of observed.cases) {
    expect(actual.computedFontSize).toBe(`${actual.nominalSize}px`); expect(actual.computedWeight).toBe(String(actual.weight));
    expect(Number(actual.adjust)).toBeCloseTo(nativeMetrics.targetXHeightRatio, 5);
    // This is an advance-width regression bound, not raster/ink identity or
    // acceptance of another font, language, size, browser or screenshot.
    expect(Math.abs(actual.canvasWidth - actual.width), `${actual.role} canvas ${actual.text}`).toBeLessThanOrEqual(1);
    if (actual.domWidth !== null) expect(Math.abs(actual.domWidth - actual.width), `${actual.role} DOM ${actual.text}`).toBeLessThanOrEqual(1);
  }
  await monoUsesItsOwnScale(page, 0);
});

for (const [size, increase] of [['small', 0], ['medium', 2], ['large', 4]] as const) {
  test(`${size} keeps logical font increments and control geometry with inherited sans normalization`, async ({ page }, info) => {
    await open(page, size);
    const actual = await panel(page).evaluate(element => {
      const body = element.querySelector('.tools-section-caption')!, title = element.querySelector('.panel-heading h1')!;
      // The Basic/Pro toggle (formerly the measured control) is hidden in web-lite.
      const header = element.querySelector('.tools-section-heading')!;
      const properties = (node: Element) => { const style = getComputedStyle(node); return { size: style.fontSize,
        adjust: style.getPropertyValue('font-size-adjust'), family: style.fontFamily }; };
      return { body: properties(body), title: properties(title),
        headerHeight: header.getBoundingClientRect().height,
        captionOffset: body.getBoundingClientRect().x - header.getBoundingClientRect().x,
        devicePixelRatio, viewportScale: visualViewport?.scale ?? null };
    });
    expect(actual.body.size).toBe(`${15 + increase}px`); expect(actual.title.size).toBe(`${20 + increase}px`);
    for (const font of [actual.body, actual.title]) expect(Number(font.adjust)).toBeCloseTo(nativeMetrics.targetXHeightRatio, 5);
    expect(actual.headerHeight).toBe(24); expect(actual.captionOffset).toBe(27 + increase);
    await info.attach('observed-logical-font-increments.json', { body: JSON.stringify(actual), contentType: 'application/json' });
    await monoUsesItsOwnScale(page, increase);
  });
}
