import { expect, test, type Page } from '@playwright/test';
import type { SavedViewRecord } from '../src/io/savedView';

const title = 'Bench example.sog — SplatView';
const layer = (page: Page) => page.locator('.tutorial-layer');
const tutorial = (page: Page) => layer(page).getByRole('dialog', { name: 'Tutorial', exact: true });
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const chooser = (page: Page) => page.getByRole('dialog', { name: 'Choose saved view', exact: true });
const background = (page: Page) => page.locator('button[data-background]');

test.use({ locale: 'en-US', serviceWorkers: 'block', storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('splatview.ui-language.v1', 'en');
    localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}');
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
});

test.afterEach(async ({ page, browser }, info) => {
  const environment = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return { userAgent: navigator.userAgent, platform: navigator.platform, origin: location.origin,
      secureContext: isSecureContext, webGpu: !!navigator.gpu, devicePixelRatio,
      viewport: { width: innerWidth, height: innerHeight },
      adapterProbe: adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture,
        device: adapter.info.device, description: adapter.info.description, fallback: adapter.info.isFallbackAdapter } : null };
  });
  await info.attach('browser-environment.json', {
    body: JSON.stringify({ ...environment, browserVersion: browser.version() }), contentType: 'application/json',
  });
});

async function showSettings(page: Page) {
  await page.mouse.move(640, 400);
  if (!await tools(page).isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(settings(page)).toBeVisible();
}

async function storedViews(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('splatview-views', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const pairs = await new Promise<{ records: { meta: Blob }[]; images: number }>((resolve, reject) => {
        const transaction = database.transaction(['views', 'thumbnails']);
        const rows = transaction.objectStore('views').getAll(), images = transaction.objectStore('thumbnails').count();
        transaction.oncomplete = () => resolve({ records: rows.result, images: images.result });
        transaction.onabort = () => reject(transaction.error);
      });
      return { records: await Promise.all(pairs.records.map(async row => JSON.parse(await row.meta.text()) as SavedViewRecord)), images: pairs.images };
    } finally { database.close(); }
  });
}

async function remember(page: Page) {
  const button = settings(page).getByRole('button', { name: 'Remember view', exact: true });
  await button.click();
  await expect(settings(page).getByRole('status').filter({ hasText: 'Thumbnail and default view saved in this browser.' }))
    .toHaveText('Thumbnail and default view saved in this browser.');
  await expect(button).toBeEnabled();
}

/** Create two genuine matching pairs through capture/export/import, then close
 * the document. One saved frame is gray and the other white; initial is black.
 */
async function prepareChoices(page: Page) {
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  await expect(page).toHaveTitle(title);
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await showSettings(page);
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
  await remember(page);
  const downloading = page.waitForEvent('download');
  await settings(page).getByRole('button', { name: 'Export saved view', exact: true }).click();
  const download = await downloading, stream = await download.createReadStream();
  if (!stream) throw new Error('The actual saved-view download is unreadable.');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = Buffer.concat(chunks);
  expect(exported.byteLength).toBeGreaterThan(0);
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'white');
  await showSettings(page);
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
  await remember(page);
  const picking = page.waitForEvent('filechooser');
  await settings(page).getByRole('button', { name: 'Import view…', exact: true }).click();
  await (await picking).setFiles({ name: download.suggestedFilename(), mimeType: 'application/zip', buffer: exported });
  await expect.poll(async () => (await storedViews(page)).records.length).toBe(2);
  await expect(settings(page).getByRole('button', { name: 'Export saved view', exact: true })).toBeEnabled();
  const pairs = await storedViews(page);
  expect(pairs.images).toBe(2);
  expect(pairs.records.map(record => record.view.background).sort()).toEqual(['gray', 'white']);
  await settings(page).getByRole('button', { name: 'Close scene', exact: true }).click();
  await expect(page).toHaveTitle('SplatView');
  await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
  return pairs;
}

async function replay(page: Page) {
  await showSettings(page);
  await settings(page).getByRole('tab', { name: 'Help', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Tutorial', exact: true }).click();
  await expect(settings(page)).toHaveCount(0);
}

for (const useInitial of [false, true]) test(`empty Help replay waits for ${useInitial ? 'Use initial view' : 'a remembered view'} and resumes the same tutorial attempt`, async ({ page }, info) => {
  let sampleLoads = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/examples/bench.sog')) sampleLoads++;
  });
  const pairs = await prepareChoices(page);
  expect(sampleLoads).toBe(1);
  await replay(page);
  await expect(chooser(page)).toBeVisible();
  await expect(layer(page)).toHaveCount(0);
  await expect(page.locator('main')).not.toHaveAttribute('inert');
  await expect(chooser(page).locator('.saved-view-choice').first()).toBeFocused();
  await expect(page.getByRole('dialog', { includeHidden: false })).toHaveCount(1);
  expect(sampleLoads).toBe(2);
  if (useInitial) {
    await chooser(page).getByRole('button', { name: 'Use initial view', exact: true }).focus();
    await page.keyboard.press('Enter');
  } else await chooser(page).locator('.saved-view-choice').first().click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'tour');
  await expect(layer(page)).toHaveAttribute('data-tutorial-course', 'essentials');
  await expect(layer(page)).toHaveAttribute('data-tutorial-step', '1');
  await expect(tutorial(page).locator('.tutorial-counter')).toHaveText('Tutorial 1 / 20');
  await expect(tutorial(page).getByRole('button', { name: 'Next', exact: true })).toBeFocused();
  await expect(page.getByRole('dialog', { includeHidden: false })).toHaveCount(1);
  await expect(background(page)).toHaveAttribute('data-background', useInitial ? 'black' : 'gray');
  expect(sampleLoads).toBe(2);
  await tutorial(page).getByRole('button', { name: 'Close tutorial', exact: true }).click();
  await expect(layer(page)).toHaveCount(0);
  await expect(page).toHaveTitle(title);
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await page.mouse.move(640, 400);
  if (!await tools(page).isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/262,556 splats | SH3');
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await tools(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/0 splats | SH3');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('262,556/262,556 splats | SH3');
  await expect(tools(page).getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await storedViews(page)).records).toEqual(pairs.records);
  await info.attach('tutorial-saved-view-resume.json', {
    body: JSON.stringify({ useInitial, sampleLoads, pairs }), contentType: 'application/json',
  });
});

test('Skip during held preparation leaves the late saved-view choice usable without reopening the tour', async ({ page }, info) => {
  const pairs = await prepareChoices(page);
  let release!: () => void, completed!: () => void, held = false;
  const released = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  await page.route('**/examples/bench.sog', async route => {
    try {
      const response = await route.fetch(); held = true;
      await released; await route.fulfill({ response });
    } finally { completed(); }
  });
  try {
    await replay(page);
    await expect.poll(() => held).toBe(true);
    await expect(layer(page)).toHaveAttribute('data-tutorial-phase', 'offer');
    await expect(tutorial(page).getByRole('button', { name: 'Opening scene', exact: true })).toBeDisabled();
    await tutorial(page).getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(layer(page)).toHaveCount(0);
  } finally { release(); if (held) await done; }
  await expect(chooser(page)).toBeVisible();
  await expect(chooser(page).locator('.saved-view-choice').first()).toBeFocused();
  await expect(layer(page)).toHaveCount(0);
  await chooser(page).locator('.saved-view-choice').first().click();
  await expect(chooser(page)).toHaveCount(0);
  await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeEnabled();
  await expect(page).toHaveTitle(title);
  await expect(layer(page)).toHaveCount(0);
  expect((await storedViews(page)).records).toEqual(pairs.records);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('tutorial-saved-view-dismissed-preparation.json', {
    body: JSON.stringify({ held, pairs }), contentType: 'application/json',
  });
});
