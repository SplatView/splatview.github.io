import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../../playwright.config';
const root = fileURLToPath(new URL('../../', import.meta.url)), phase = fileURLToPath(new URL('.', import.meta.url));
const origin = 'http://127.0.0.1:4173';
export default defineConfig({
  ...base, testDir: `${root}e2e`, projects: [
    ...['app', 'color', 'fill', 'web-lite', 'steady-settings', 'webgl-basic', 'backend-fallback'].map(name => ({ name: `production-${name}`, testMatch: `${name}.spec.ts` })),
    { name: 'production-portable-views', testMatch: 'portable-saved-view.spec.ts', grep: /actual .* App Settings/ },
  ],
  // Two private source-module injection cases remain in the development cohort.
  grepInvert: /Fill controller boundaries|an explicit selection-option assignment|blur cancels a released pending Fill/,
  use: { ...base.use, baseURL: origin, storageState: { cookies: [], origins: [{ origin, localStorage: [
    { name: 'splatview.tutorial.v1', value: '{"tutorial_prompt_handled":"handled"}' },
  ] }] } },
  webServer: { command: 'npm run preview -- --port 4173 --strictPort', cwd: root, url: origin, reuseExistingServer: true, timeout: 30000 },
  outputDir: `${phase}production-${process.env.SPLATVIEW_TEST_BACKEND ?? 'auto'}`, reporter: [['list'], ['json', { outputFile: `${phase}production-${process.env.SPLATVIEW_TEST_BACKEND ?? 'auto'}.json` }]],
});
