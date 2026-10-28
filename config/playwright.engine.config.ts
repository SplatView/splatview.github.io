import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  outputDir: '../.build/validation/engine',
  testDir: '../tests/browser-engine', testMatch: '**/*.spec.ts', timeout: 60_000, workers: 1, retries: 0,
  expect: { timeout: 15_000 },
  use: { baseURL: 'http://127.0.0.1:4175', channel: 'chromium',
    launchOptions: { args: ['--enable-unsafe-webgpu'] }, trace: 'retain-on-failure' },
  webServer: { cwd: fileURLToPath(new URL('../', import.meta.url)), command: 'node tools/serve-engine.mjs', url: 'http://127.0.0.1:4175/nested/renderer/example/',
    reuseExistingServer: true, timeout: 30_000 },
});
