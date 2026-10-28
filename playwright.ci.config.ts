import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// These specs use ui-size-harness: startup substitutes initialize() and never
// creates a native worker or GPU. Hardware-rendering suites retain their own lanes.
const names = ['spec:ui-size.spec.ts', 'spec:update-notice.spec.ts'];
const projects = base.projects!.filter(project => names.includes(project.name!));
if (projects.length !== names.length) throw new Error('CI appearance coverage is missing a required project.');
const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error('CI expects the single app development server.');
export default defineConfig({
  ...base,
  projects,
  forbidOnly: true,
  outputDir: './.build/validation/ci-browser',
  reporter: [['list'], ['json', { outputFile: './.build/validation/ci-browser.json' }]],
  webServer: { ...webServer, reuseExistingServer: false },
});
