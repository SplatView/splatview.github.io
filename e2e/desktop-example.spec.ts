import { expect, test, type Page } from '@playwright/test';
import { gaussianPly } from '../tests/fixtures/gaussians';
import type { SavedViewRecord } from '../src/io/savedView';

const samplePath = '**/examples/bench.sog';
const title = 'Bench example.sog — SplatView';
const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const background = (page: Page) => page.getByRole('button', { name: 'Background', exact: true });

// Network faults must reach the real fetch rather than a service-worker cache.
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

async function showTools(page: Page) {
  await page.mouse.move(640, 400);
  if (!await tools(page).isVisible()) await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(tools(page)).toBeVisible();
}

async function showSettings(page: Page) {
  await showTools(page);
  await tools(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'General', exact: true }).click();
}

async function openExample(page: Page) {
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  await expect(page).toHaveTitle(title);
  await expect(page.locator('main')).toHaveAttribute('data-scene-ready', 'true');
}

async function remember(page: Page) {
  const save = settings(page).getByRole('button', { name: 'Remember view', exact: true });
  await save.click();
  await expect(settings(page).getByRole('status').filter({ hasText: 'Thumbnail and default view saved in this browser.' }))
    .toHaveText('Thumbnail and default view saved in this browser.');
  await expect(save).toBeEnabled();
  return page.evaluate(async (): Promise<SavedViewRecord> => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('splatview-views', 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<{ meta: Blob }[]>((resolve, reject) => {
        const transaction = database.transaction('views'), request = transaction.objectStore('views').getAll();
        transaction.oncomplete = () => resolve(request.result); transaction.onabort = () => reject(transaction.error);
      });
      if (rows.length !== 1) throw new Error(`Expected one remembered sample view, received ${rows.length}.`);
      return JSON.parse(await rows[0].meta.text()) as SavedViewRecord;
    } finally { database.close(); }
  });
}

test('failed sample fetch leaves an empty viewer and Open example retries the real asset', async ({ page }, info) => {
  let requests = 0;
  await page.route(samplePath, async route => {
    requests++;
    if (requests === 1) await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Injected example outage' });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Open example', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'The example scene could not be loaded. Try again.' });
  await expect(error).toBeVisible();
  await expect(page).toHaveTitle('SplatView');
  await expect(page.locator('.empty-state')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  await expect(page.locator('.tutorial-layer')).toHaveCount(0);
  expect(requests).toBe(1);
  await error.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await openExample(page);
  expect(requests).toBe(2);
  await showTools(page);
  await expect(tools(page).locator('.model-stats')).toHaveText('0/262,556 splats | SH3');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('desktop-example-fetch-retry.json', { body: JSON.stringify({ requests, title }), contentType: 'application/json' });
});

for (const cancelFirst of [true, false]) test(`${cancelFirst ? 'Cancel then open' : 'A superseding file opens'} while the sample response is held; late completion keeps the newer file`, async ({ page }, info) => {
  let release!: () => void, completed!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const done = new Promise<void>(resolve => { completed = resolve; });
  let held = false;
  const failures: string[] = [], routeErrors: string[] = [];
  page.on('requestfailed', request => {
    if (new URL(request.url()).pathname.endsWith('/examples/bench.sog')) failures.push(request.failure()?.errorText ?? 'unknown');
  });
  await page.route(samplePath, async route => {
    try {
      const response = await route.fetch(); held = true;
      await released; await route.fulfill({ response });
    } catch (error) {
      if (!route.request().failure()) routeErrors.push(String(error));
    } finally { completed(); }
  });
  const newer = cancelFirst ? 'after-sample-cancel.ply' : 'superseding-sample.ply';
  try {
    await page.getByRole('button', { name: 'Open example', exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
    if (cancelFirst) {
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Open example', exact: true })).toBeEnabled();
      await expect(page).toHaveTitle('SplatView');
    }
    await page.getByLabel('Open scene files', { exact: true }).setInputFiles({ name: newer,
      mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly(0)) });
    await expect(page).toHaveTitle(`${newer} — SplatView`);
    await expect.poll(() => failures.length).toBe(1);
  } finally {
    release(); if (held) await done;
  }
  expect(routeErrors).toEqual([]);
  await expect(page).toHaveTitle(`${newer} — SplatView`);
  await showTools(page);
  await expect(tools(page).locator('.model-stats')).toHaveText('0/3 splats | SH0');
  await tools(page).getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH0');
  await tools(page).getByRole('button', { name: 'Delete selected', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('0/0 splats | SH0');
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(tools(page).locator('.model-stats')).toHaveText('3/3 splats | SH0');
  await expect(page).toHaveTitle(`${newer} — SplatView`);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('desktop-example-late-response.json', {
    body: JSON.stringify({ cancelFirst, newer, failures, routeErrors }), contentType: 'application/json',
  });
});

test('the authored desktop frame survives Reset and a matching Remember view wins when the sample reopens', async ({ page }, info) => {
  await openExample(page);
  await page.getByRole('button', { name: 'Narrower lens', exact: true }).click();
  await page.getByRole('button', { name: 'Flip up', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background(page)).toHaveAttribute('data-background', 'black');
  await showSettings(page);
  const authored = await remember(page);
  for (const [index, expected] of [2.602029323577881, -0.36847925186157227, -1.6119190454483032].entries())
    expect(authored.view.target[index]).toBeCloseTo(expected, 6);
  expect(Math.sin(authored.view.yaw)).toBeCloseTo(Math.sin(-7.259469985961914), 6);
  expect(Math.cos(authored.view.yaw)).toBeCloseTo(Math.cos(-7.259469985961914), 6);
  expect(authored.view.pitch).toBeCloseTo(0.38079535961151123, 6);
  expect(authored.view.distance).toBeCloseTo(3.7993321418762207, 6);
  expect(authored.view.roll).toBeCloseTo(0.21997733414173126, 6);
  expect(authored.view.fov).toBe(45); expect(authored.view.yUp).toBe(true);
  expect(authored.view.background).toBe('black'); expect(authored.thumbnail.byteLength).toBeGreaterThan(0);
  await settings(page).getByRole('button', { name: 'Close Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Narrower lens', exact: true }).click();
  await page.getByRole('button', { name: 'Flip up', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await showSettings(page);
  const saved = await remember(page);
  expect(saved.view.fov).not.toBe(authored.view.fov); expect(saved.view.yUp).not.toBe(authored.view.yUp);
  expect(saved.view.background).toBe('gray');
  await settings(page).getByRole('button', { name: 'Close scene', exact: true }).click();
  await expect(page).toHaveTitle('SplatView');
  await openExample(page);
  await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await page.getByRole('button', { name: 'Wider lens', exact: true }).click();
  await page.getByRole('button', { name: 'Flip up', exact: true }).click();
  await background(page).click(); await expect(background(page)).toHaveAttribute('data-background', 'white');
  await page.getByRole('button', { name: 'Reset camera', exact: true }).click();
  await expect(background(page)).toHaveAttribute('data-background', 'gray');
  await showSettings(page);
  const reopened = await remember(page);
  expect(reopened.recordId).toBe(saved.recordId); expect(reopened.view).toEqual(saved.view);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await info.attach('desktop-example-authored-and-remembered-view.json', {
    body: JSON.stringify({ authored, saved, reopened }), contentType: 'application/json',
  });
});
