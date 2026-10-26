import { defineConfig } from '@playwright/test';

const origin = process.env.SPLATVIEW_OFFLINE_TEST_ORIGIN ?? 'http://127.0.0.1:5373';
const certificatePin = process.env.SPLATVIEW_TEST_CHROMIUM_SPKI_PIN;
if (certificatePin && !/^[A-Za-z0-9+/]{43}=$/.test(certificatePin)) throw new Error('Invalid test certificate SPKI pin.');

// The root runner owns the fixture server, browser cohort and its shutdown.
export default defineConfig({
  outputDir: './.build/validation/offline',
  testDir: './tests/offline', testMatch: 'offline.spec.ts', timeout: 90_000,
  expect: { timeout: 20_000 }, workers: 1, retries: 0, fullyParallel: false,
  use: { locale: 'en-US', baseURL: origin, viewport: { width: 1280, height: 800 },
    storageState: { cookies: [], origins: [{ origin: new URL(origin).origin,
      localStorage: [{ name: 'splatview.tutorial.v1', value: '{"tutorial_prompt_handled":"handled"}' },
        { name: 'splatview.tools-mode.v1', value: 'pro' }] }] },
    ignoreHTTPSErrors: process.env.SPLATVIEW_TEST_IGNORE_HTTPS_ERRORS === '1',
    channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu',
      ...(certificatePin ? [`--ignore-certificate-errors-spki-list=${certificatePin}`] : [])] },
    trace: 'retain-on-failure' },
});
