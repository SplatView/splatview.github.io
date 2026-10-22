import { defineConfig } from '@playwright/test';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const specRoot = resolve(fileURLToPath(new URL('./e2e/', import.meta.url)));
const certificatePin = process.env.SPLATVIEW_TEST_CHROMIUM_SPKI_PIN;
if (certificatePin && !/^[A-Za-z0-9+/]{43}=$/.test(certificatePin)) throw new Error('Invalid test certificate SPKI pin.');
const specs: string[] = [];
const canonical = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
function discover(directory: string) {
  if (canonical(realpathSync.native(directory)) !== canonical(directory)) throw new Error(`Linked test directory: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const filename = resolve(directory, entry.name), within = relative(specRoot, filename), info = lstatSync(filename);
    if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`) || info.isSymbolicLink())
      throw new Error(`Test discovery escapes its source directory: ${filename}`);
    if (info.isDirectory()) discover(filename);
    else if (info.isFile()) { if (/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(entry.name)) specs.push(filename); }
    else throw new Error(`Unsupported test source entry: ${filename}`);
  }
}
discover(specRoot);
if (!specs.length) throw new Error('No browser specs were discovered.');
const names = new Set<string>();
const projects = specs.map(filename => {
  const name = `spec:${relative(specRoot, filename).split(sep).join('/')}`;
  if (names.has(canonical(name))) throw new Error(`Duplicate browser project: ${name}`);
  names.add(canonical(name));
  // Project identity changes the worker hash. With one worker, Playwright
  // retires the old worker/browser before the next spec's project starts.
  const escaped = filename.split(sep).join('/').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { name, testMatch: new RegExp(`^${escaped}$`) };
});
export default defineConfig({
  testDir: './e2e', timeout: 60_000, expect: { timeout: 15_000 }, workers: 1, retries: 0, fullyParallel: false, projects,
  use: { locale: 'en-US', baseURL: process.env.SPLATVIEW_TEST_ORIGIN ?? 'http://127.0.0.1:5173',
    // Existing feature cohorts start after onboarding. Tutorial specs override
    // this state and exercise the actual first-run offer separately.
    storageState: { cookies: [], origins: [{ origin: new URL(process.env.SPLATVIEW_TEST_ORIGIN ?? 'http://127.0.0.1:5173').origin,
      localStorage: [{ name: 'splatview.tutorial.v1', value: '{"tutorial_prompt_handled":"handled"}' }] }] },
    ignoreHTTPSErrors: process.env.SPLATVIEW_TEST_IGNORE_HTTPS_ERRORS === '1', viewport: { width: 1280, height: 800 },
    channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu',
      ...(certificatePin ? [`--ignore-certificate-errors-spki-list=${certificatePin}`] : [])] }, trace: 'retain-on-failure' },
  webServer: { command: 'npm run dev', url: process.env.SPLATVIEW_TEST_ORIGIN ?? 'http://127.0.0.1:5173', reuseExistingServer: true, timeout: 30_000 },
});
