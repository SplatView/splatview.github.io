import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { gaussianPly } from '../tests/fixtures/gaussians';
import { chooseSelectionTool } from './selectTool';

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.tools-mode.v1', 'pro');
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}');
  });
});

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    // This independent probe uses the renderer's adapter request options. It
    // does not expose the owned renderer adapter or establish a VRAM budget.
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return {
      userAgent: navigator.userAgent, platform: navigator.platform, secureContext: isSecureContext,
      webGpu: !!navigator.gpu, origin: location.origin, devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null,
    };
  });
  await info.attach('browser-environment.json', {
    body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json',
  });
});

async function wake(page: Page) {
  await page.mouse.move(8, 300); await page.mouse.move(9, 300);
  await expect(page.getByRole('toolbar', { name: 'Scene controls', exact: true })).toHaveCSS('opacity', '1');
}

async function openSmallScene(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files', { exact: true }).setInputFiles({
    name: 'windows-design.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(0)),
  });
  await expect(page).toHaveTitle('windows-design.ply — SplatView');
  await wake(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page).getByRole('button', { name: 'Select all', exact: true })).toBeEnabled();
}

async function selectedDot(option: Locator) {
  await expect(option).toHaveAttribute('aria-selected', 'true');
  await expect(option).not.toContainText('✓');
  const dots = await option.locator('.preference-selected-dot[aria-hidden="true"]').evaluateAll(elements => elements.filter(element => {
    const style = getComputedStyle(element), bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.width <= 8 && bounds.height === bounds.width &&
      style.borderRadius === '50%' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  }).length);
  expect(dots).toBe(1);
}

test('the exact desktop Bench example decodes and renders through the normal pipeline with desktop Basic selection order', async ({ page }, info) => {
  let requestPhase: 'startup' | 'action' = 'startup';
  const fetchedScenes: { url: string; phase: 'startup' | 'action'; owner: 'page' | 'service-worker'; ownerUrl: string }[] = [];
  page.context().on('request', request => {
    if (!/\.(?:splat|ply|spz|sog)(?:[?#]|$)/i.test(request.url())) return;
    const serviceWorker = request.serviceWorker();
    fetchedScenes.push({ url: request.url(), phase: requestPhase, owner: serviceWorker ? 'service-worker' : 'page',
      ownerUrl: serviceWorker ? serviceWorker.url() : request.frame().url() });
  });
  await page.goto('/');
  await expect(page.locator('.empty-state h1')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  // Production startup verifies every manifest leaf, including the bundled
  // sample, before this ready control. Offline caching has its own worker
  // requests. Count the page's actual Open example intake separately.
  requestPhase = 'action';
  const downloadedExample = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/examples/bench.sog'));
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  const response = await downloadedExample, sampleBytes = await response.body();
  const sample = { url: response.url(), status: response.status(), bytes: sampleBytes.byteLength,
    fromServiceWorker: response.fromServiceWorker(),
    sha256: createHash('sha256').update(sampleBytes).digest('hex') };
  expect(response.request().serviceWorker()).toBeNull(); expect(response.request().frame()).toBe(page.mainFrame());
  expect(new URL(sample.url).origin).toBe(new URL(page.url()).origin);
  expect(sample.status).toBe(200); expect(sample.bytes).toBe(5_124_962);
  expect(sample.sha256).toBe('a4f0b3d623a10a3d15cf4179c44a54ae88258ef66dbaddbf67009a40b44b1570');
  await expect(page).toHaveTitle('Bench example.sog — SplatView');
  await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'true');
  await expect(page.getByLabel('SplatView scene', { exact: true })).toHaveCSS('visibility', 'visible');
  await wake(page); await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/262,556 splats | SH3');
  await expect(tools(page)).toHaveAttribute('data-tutorial-display-mode', 'basic');
  await expect(tools(page).locator('.mode-button')).toBeHidden();

  // The clean image comes from the application's WebGPU capture path, rather
  // than a DOM screenshot or a test-only renderer/controller accessor.
  await expect(page.getByRole('button', { name: 'Capture image', exact: true })).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Capture image', exact: true }).click();
  const download = await downloading, stream = await download.createReadStream();
  if (!stream) throw new Error('Rendered example capture was not readable.');
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const image = await page.evaluate(async encoded => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(encoded)], { type: 'image/jpeg' }));
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0); bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let renderedPixels = 0;
    for (let index = 0; index < pixels.length; index += 4)
      if (pixels[index] > 24 || pixels[index + 1] > 24 || pixels[index + 2] > 24) renderedPixels++;
    return { width: canvas.width, height: canvas.height, renderedPixels };
  }, Array.from(Buffer.concat(chunks)));
  expect(image.width).toBeGreaterThan(0); expect(image.height).toBeGreaterThan(0);
  await info.attach('example-request-ownership.json', {
    body: JSON.stringify({ sample, fetchedScenes }), contentType: 'application/json',
  });
  expect(image.renderedPixels).toBeGreaterThan(100);
  expect(fetchedScenes.filter(request => request.owner === 'page' && request.phase === 'action').map(request => request.url))
    .toEqual([sample.url]);
  expect(fetchedScenes.filter(request => request.owner === 'page' && request.phase === 'startup').length).toBeLessThanOrEqual(1);
  for (const request of fetchedScenes) {
    expect(request.url).toBe(sample.url);
    if (request.owner === 'service-worker') {
      expect(new URL(request.ownerUrl).origin).toBe(new URL(sample.url).origin);
      expect(new URL(request.ownerUrl).pathname).toMatch(/\/service-worker\.js$/);
    }
  }

  await chooseSelectionTool(page, 'Brush');
  const combine = tools(page).locator('[data-tutorial-target~="combine"]');
  const options = tools(page).getByRole('group', { name: 'Options', exact: true });
  const actions = tools(page).getByRole('group', { name: 'Selection actions', exact: true });
  const brush = tools(page).getByRole('slider', { name: 'Brush size', exact: true });
  const combineBounds = (await combine.boundingBox())!, optionsBounds = (await options.boundingBox())!;
  expect(Math.abs(combineBounds.y + combineBounds.height - optionsBounds.y - optionsBounds.height)).toBeLessThanOrEqual(1);
  expect(optionsBounds.x).toBeGreaterThan(combineBounds.x + combineBounds.width);
  expect((await brush.boundingBox())!.y).toBeGreaterThanOrEqual(optionsBounds.y + optionsBounds.height);
  expect((await actions.boundingBox())!.y).toBeGreaterThan((await brush.boundingBox())!.y);
  await chooseSelectionTool(page, 'Polygon');
  const count = tools(page).getByRole('status').filter({ hasText: /^0 points$/ });
  await expect(count).toHaveCount(1);
  const countPaint = await count.evaluate(element => {
    const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
    return { width: bounds.width, height: bounds.height, clipped: style.clip !== 'auto' || style.clipPath !== 'none' };
  });
  expect(countPaint.width).toBeLessThanOrEqual(1); expect(countPaint.height).toBeLessThanOrEqual(1); expect(countPaint.clipped).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('example-native-count-rendered-capture.json', {
    body: JSON.stringify({ records: 262_556, shDegree: 3, sample, image, fetchedScenes }), contentType: 'application/json',
  });
  await page.screenshot({ path: info.outputPath('actual-windows-basic-selection-order.png') });
});

test('Large French empty actions fit the actual free area below wrapped chrome in narrow and short windows', async ({ page }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.ui-size.v1', 'large');
    localStorage.setItem('splatview.ui-language.v1', 'fr');
  });
  await page.setViewportSize({ width: 360, height: 280 }); await page.goto('/');
  await expect(page.locator('.primary-open')).toBeEnabled();
  const observations = [];
  for (const viewport of [{ width: 360, height: 280 }, { width: 420, height: 260 }, { width: 640, height: 300 }]) {
    await page.setViewportSize(viewport);
    const empty = page.locator('.empty-state'), open = empty.locator('.primary-open');
    const example = empty.locator('.secondary-open');
    await expect(empty.getByRole('button')).toHaveCount(2);
    const buttons = empty.getByRole('button'), first = buttons.nth(0), second = buttons.nth(1);
    await expect(empty.locator('h1')).toHaveCount(0);
    await expect(empty.locator('small')).toHaveCount(0);
    const geometry = async () => ({
      empty: (await empty.boundingBox())!, actions: (await empty.locator('.empty-actions').boundingBox())!,
      open: (await first.boundingBox())!, example: (await second.boundingBox())!,
      toolbar: (await page.locator('.toolbar').boundingBox())!, brand: (await page.locator('.brand-link').boundingBox())!,
    });
    await expect.poll(async () => {
      const current = await geometry();
      const clearOfBrand = [current.open, current.example].every(bounds =>
        bounds.x + bounds.width <= current.brand.x || bounds.x >= current.brand.x + current.brand.width ||
        bounds.y + bounds.height <= current.brand.y || bounds.y >= current.brand.y + current.brand.height);
      return current.empty.y >= current.toolbar.y + current.toolbar.height &&
        current.empty.y + current.empty.height <= viewport.height - 12 && clearOfBrand;
    }).toBe(true);
    const current = await geometry();
    expect(current.open.height).toBe(28); expect(current.example.height).toBe(28);
    expect(current.open.width).toBeGreaterThanOrEqual(154); expect(current.open.width).toBe(current.example.width);
    for (const bounds of [current.empty, current.open, current.example]) {
      expect(bounds.x).toBeGreaterThanOrEqual(12); expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 12);
    }
    if (Math.abs(current.open.y - current.example.y) < 1) expect(current.example.x - current.open.x - current.open.width).toBe(6);
    else expect(current.example.y - current.open.y - current.open.height).toBe(4);
    const overlapsBrandHorizontally = current.actions.x < current.brand.x + current.brand.width &&
      current.actions.x + current.actions.width > current.brand.x;
    const bottom = overlapsBrandHorizontally ? current.brand.y - 6 : viewport.height - 12;
    if (overlapsBrandHorizontally) expect(current.empty.y + current.empty.height).toBeLessThanOrEqual(current.brand.y - 6);
    const center = current.empty.y + current.empty.height / 2;
    expect(Math.abs(center - (current.toolbar.y + current.toolbar.height + 8 + bottom) / 2)).toBeLessThanOrEqual(2);
    expect(await open.innerText()).not.toBe('Open scene');
    expect(await example.count()).toBe(1);
    observations.push({ viewport, ...current });
  }
  await info.attach('translated-empty-action-geometry.json', { body: JSON.stringify(observations), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('actual-empty-large-french-short.png') });
});

for (const size of ['small', 'large'] as const) test(`${size} Settings uses three compact property rows and selected dots while keyboard previews still cancel and commit`, async ({ page }, info) => {
  await page.addInitScript(size => localStorage.setItem('splatview.ui-size.v1', size), size);
  await openSmallScene(page); await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  const rows = [['Language', 'language'], ['Theme', 'theme'], ['Font size', 'font-size']] as const;
  const rowGeometry = [];
  for (const [name, prefix] of rows) {
    const trigger = settings(page).getByRole('button', { name, exact: true });
    const caption = settings(page).locator(`.${prefix}-caption`), captionBounds = (await caption.boundingBox())!;
    const bounds = (await trigger.boundingBox())!;
    expect(bounds.height).toBe(size === 'small' ? 21 : 25);
    expect(captionBounds.x + captionBounds.width).toBeLessThan(bounds.x);
    expect(Math.abs(captionBounds.y + captionBounds.height / 2 - bounds.y - bounds.height / 2)).toBeLessThanOrEqual(1);
    await expect(trigger.locator('.icon')).toHaveCount(0);
    rowGeometry.push({ name, caption: captionBounds, trigger: bounds });
  }
  expect(rowGeometry[0].trigger.x).toBe(rowGeometry[1].trigger.x); expect(rowGeometry[1].trigger.x).toBe(rowGeometry[2].trigger.x);
  expect(rowGeometry[0].trigger.y).toBeLessThan(rowGeometry[1].trigger.y); expect(rowGeometry[1].trigger.y).toBeLessThan(rowGeometry[2].trigger.y);

  const language = settings(page).getByRole('button', { name: 'Language', exact: true });
  await language.press('ArrowDown');
  await selectedDot(page.getByRole('listbox', { name: 'Language choices', exact: true }).getByRole('option', { name: 'English', exact: true }));
  await page.keyboard.press('Escape'); await expect(language).toBeFocused();
  const theme = settings(page).getByRole('button', { name: 'Theme', exact: true });
  await theme.press('ArrowDown');
  const menu = page.getByRole('listbox', { name: 'Theme choices', exact: true });
  await selectedDot(menu.getByRole('option', { name: 'Dark', exact: true }));
  await page.keyboard.press('ArrowDown'); await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'bright');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-theme.v1'))).toBeNull();
  await page.keyboard.press('Escape'); await expect(theme).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark');
  await theme.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(theme).toBeFocused(); await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'bright');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-theme.v1'))).toBe('bright');
  const font = settings(page).getByRole('button', { name: 'Font size', exact: true });
  await font.press('ArrowDown');
  await selectedDot(page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: size === 'small' ? 'Small' : 'Large', exact: true }));
  await page.keyboard.press('Escape'); await expect(font).toBeFocused();
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH0');
  await expect(page).toHaveTitle('windows-design.ply — SplatView'); await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('compact-settings-property-geometry.json', { body: JSON.stringify(rowGeometry), contentType: 'application/json' });
});
