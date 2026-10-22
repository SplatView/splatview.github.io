import { test as base, chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export type ZoomObservation = { requested: number; actual: number; tabId: number; width: number; height: number; dpr: number; scale: number };
type ZoomControl = { set(factor: 1 | 2 | 4): Promise<ZoomObservation>; observations: ZoomObservation[] };
type Extension = { set(url: string, factor: number): Promise<{ tabId: number; factor: number; url: string }> };
const extensionPath = fileURLToPath(new URL('../tests/fixtures/zoom-extension/', import.meta.url));

// Official persistent-context/headless Chromium extension pattern:
// https://playwright.dev/docs/chrome-extensions
// Overriding context/page without a browser dependency creates exactly one
// browser and a new temporary profile; no existing user profile is opened.
export const test = base.extend<{ zoom: ZoomControl }>({
  context: async ({ baseURL, ignoreHTTPSErrors }, use) => {
    const pin = process.env.SPLATVIEW_TEST_CHROMIUM_SPKI_PIN;
    if (pin && !/^[A-Za-z0-9+/]{43}=$/.test(pin)) throw new Error('Invalid test certificate SPKI pin.');
    const context: BrowserContext = await chromium.launchPersistentContext('', {
      channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
      locale: 'en-US', baseURL, ignoreHTTPSErrors,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--enable-unsafe-webgpu',
        ...(pin ? [`--ignore-certificate-errors-spki-list=${pin}`] : [])],
    });
    await context.addInitScript(() => {
      // Page fixtures may supply their own offer/profile before this script;
      // context/page init-script order is unspecified. Defaults fill gaps only.
      if (localStorage.getItem('splatview.tutorial.v1') === null)
        localStorage.setItem('splatview.tutorial.v1', '{"tutorial_prompt_handled":"handled"}');
      if (localStorage.getItem('splatview.tools-mode.v1') === null)
        localStorage.setItem('splatview.tools-mode.v1', 'pro');
    });
    try { await use(context); }
    // The runner's context-creation hook already starts/stops failure tracing,
    // including custom persistent contexts. Starting it again would conflict.
    finally { await context.close(); }
  },
  page: async ({ context }, use) => { await use(context.pages()[0] ?? await context.newPage()); },
  zoom: async ({ context, page }, use, testInfo) => {
    const observations: ZoomObservation[] = [];
    let worker: Worker | undefined = context.serviceWorkers().find(value => value.url().startsWith('chrome-extension://'));
    worker ??= await context.waitForEvent('serviceworker', { predicate: value => value.url().startsWith('chrome-extension://') });
    const extensionWorker = worker;
    await use({ observations, async set(factor) {
      const result = await extensionWorker.evaluate(async ({ url, factor }) =>
        (globalThis as unknown as { splatviewZoom: Extension }).splatviewZoom.set(url, factor), { url: page.url(), factor });
      // Chromium returns a double (e.g. 3.9999999999999996 for 400%). Keep
      // that raw value in evidence and compare at sub-picounit precision.
      expect(result.factor).toBeCloseTo(factor, 12);
      await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280 / factor);
      await expect.poll(() => page.evaluate(() => window.devicePixelRatio)).toBeCloseTo(factor, 12);
      const measured = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
        dpr: devicePixelRatio, scale: visualViewport?.scale ?? 1 }));
      expect(measured.height).toBe(800 / factor); expect(measured.scale).toBe(1);
      const observation = { requested: factor, actual: result.factor, tabId: result.tabId, ...measured };
      observations.push(observation); return observation;
    } });
    await testInfo.attach('actual-browser-zoom', { contentType: 'application/json', body: JSON.stringify({
      method: 'chrome.tabs.setZoom/getZoom', extension: extensionWorker.url(), observations,
    }) });
  },
});
export { expect };
