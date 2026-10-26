import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: './.build/validation/compat',
  testDir: './tests/production', timeout: 60_000, expect: { timeout: 15_000 }, workers: 1,
  use: { locale: 'en-US', baseURL: 'http://127.0.0.1:4173', viewport: { width: 1280, height: 800 },
    storageState: { cookies: [], origins: [{ origin: 'http://127.0.0.1:4173',
      localStorage: [{ name: 'splatview.tutorial.v1', value: '{"tutorial_prompt_handled":"handled"}' }] }] },
    channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu'] }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run preview -- --port 4173 --strictPort', url: 'http://127.0.0.1:4173',
    reuseExistingServer: false, timeout: 30_000 },
});
