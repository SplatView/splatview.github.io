import { test, expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BuildArtifact, BuildDescriptor, NativeIdentity, RuntimeManifest } from '../../src/build/contracts';
import { nativeModuleIdentity, verifiedInstantiation } from '../../src/build/native';
import type { NativeSummary } from '../../src/document/types';
import { sourceWorkerBytes } from '../../src/document/source';
import { gaussianPly } from '../fixtures/gaussians';

type WorkerPost = { type: string; command?: string; requestId?: number };
type WorkerReply = { type: string; summary?: NativeSummary; masks?: number[]; error?: string;
  channel?: string; first?: number; count?: number; byteLength?: number };
type WorkerRecord = { id: number; url: string; terminated: boolean; posts: WorkerPost[]; replies: WorkerReply[];
  actualReadyBuild?: BuildDescriptor; changedReady: boolean; heldReady: boolean };
type CompatMonitor = { workers: WorkerRecord[]; createdBlobUrls: string[]; revokedBlobUrls: string[];
  failNextReady: boolean; holdNextReady: boolean; releaseHeld(id: number): void };
declare global { interface Window { __compatMonitor: CompatMonitor } }

const fixture = { name: 'production-sh3.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()) };
const replacement = { ...fixture, name: 'replacement-sh3.ply' };
const legacyDirectory = resolve('tests/fixtures/build-compat/legacy-abi6-camera1');
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function singleAssetDigest(bytes: Uint8Array) {
  // Independent literal v1 layout; do not derive this oracle from the writer
  // or the production worker's fingerprint result.
  const canonical = Buffer.alloc(69); canonical.write('SplatViewSource\0v1\0', 0, 'utf8');
  canonical.writeUInt32BE(1, 20); canonical[24] = 1; canonical.writeBigUInt64BE(BigInt(bytes.length), 29);
  createHash('sha256').update(bytes).digest().copy(canonical, 37);
  return digest(canonical);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const text = JSON.stringify(value); if (text === undefined) throw new Error('Invalid fixture canonical data'); return text;
}
async function deployment(): Promise<RuntimeManifest> {
  return JSON.parse(await readFile(resolve('dist/build-manifest.json'), 'utf8')) as RuntimeManifest;
}
function seal(manifest: RuntimeManifest) {
  const { deploymentId: _id, ...payload } = manifest;
  manifest.deploymentId = digest(canonical(payload)); return manifest;
}
function artifact(manifest: RuntimeManifest, role: BuildArtifact['role']) {
  const row = manifest.artifacts.find(item => item.role === role);
  if (!row) throw new Error(`Missing shipped ${role} artifact`); return row;
}
async function fulfillBytes(route: Route, bytes: Buffer | string, contentType: string) {
  await route.fulfill({ status: 200, contentType, headers: { 'cache-control': 'no-store' }, body: bytes });
}
async function alteredManifest(page: Page, mutate: (manifest: RuntimeManifest) => void) {
  const value = await deployment(); mutate(value); seal(value);
  await page.route('**/build-manifest.json', route => fulfillBytes(route, JSON.stringify(value), 'application/json'));
  return value;
}

/** Observe actual browser workers; only candidate-ready failure tests alter an event. */
async function observeWorkers(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    const held = new Map<number, { worker: Worker; data: unknown }>();
    const monitor: CompatMonitor = { workers: [], createdBlobUrls: [], revokedBlobUrls: [],
      failNextReady: false, holdNextReady: false,
      releaseHeld(id) {
        const item = held.get(id); if (!item) throw new Error('No held real worker response');
        held.delete(id); monitor.workers[id - 1].heldReady = false;
        item.worker.dispatchEvent(new MessageEvent('message', { data: item.data }));
      } };
    window.__compatMonitor = monitor;
    const createBlob = URL.createObjectURL.bind(URL), revokeBlob = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => { const url = createBlob(object); monitor.createdBlobUrls.push(url); return url; };
    URL.revokeObjectURL = url => { monitor.revokedBlobUrls.push(url); revokeBlob(url); };
    window.Worker = class extends NativeWorker {
      private record: WorkerRecord;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const failReady = monitor.failNextReady, holdReady = monitor.holdNextReady;
        monitor.failNextReady = false; monitor.holdNextReady = false;
        const record: WorkerRecord = { id: monitor.workers.length + 1, url: String(url), terminated: false,
          posts: [], replies: [], changedReady: false, heldReady: false };
        this.record = record; monitor.workers.push(record);
        let interceptReady = true;
        this.addEventListener('message', event => {
          const data = event.data as { type?: string; summary?: NativeSummary; bytes?: ArrayBuffer; channel?: string; first?: number; count?: number;
            error?: string; build?: BuildDescriptor };
          if (data?.type === 'ready' && interceptReady) {
            interceptReady = false; record.actualReadyBuild = structuredClone(data.build!);
            if (failReady) {
              const changed = structuredClone(data);
              changed.build!.appInputId = changed.build!.appInputId === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
              Object.defineProperty(event, 'data', { value: changed, configurable: true }); record.changedReady = true;
            }
            if (holdReady) {
              record.heldReady = true; held.set(record.id, { worker: this, data: event.data });
              event.stopImmediatePropagation(); return;
            }
          }
          record.replies.push({ type: data?.type ?? 'untyped', summary: data?.summary ? structuredClone(data.summary) : undefined,
            masks: data?.type === 'masks' && data.bytes instanceof ArrayBuffer ? Array.from(new Uint8Array(data.bytes)) : undefined,
            ...(data?.type === 'geometry-chunk' ? { channel: data.channel, first: data.first, count: data.count, byteLength: data.bytes?.byteLength } : {}),
            error: data?.error });
        });
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = message as { type?: string; command?: { command?: string }; requestId?: number };
        this.record.posts.push({ type: data?.type ?? 'untyped', command: data?.command?.command, requestId: data?.requestId });
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
      override terminate() { this.record.terminated = true; super.terminate(); }
    };
  });
}
async function workerRecords(page: Page) { return page.evaluate(() => window.__compatMonitor.workers); }
async function wake(page: Page) {
  await page.mouse.move(639, 399); await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
}
async function openFixture(page: Page, path = '/') {
  await page.goto(path);
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles(fixture);
  await expect(page).toHaveTitle(`${fixture.name} — SplatView`); await wake(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText('0/3 splats | SH3');
}
async function grade(page: Page, brightness: string) {
  await wake(page); await page.getByRole('slider', { name: 'Brightness', exact: true }).fill(brightness);
  await page.getByRole('button', { name: 'Apply color', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Apply color', exact: true })).toBeHidden();
  await expect(page.locator('.status.panel')).toHaveCount(0);
}
async function exportBytes(page: Page, scope = '0') {
  await wake(page); await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await dialog.getByLabel('Export scope', { exact: true }).selectOption(scope);
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending, file = await download.path(); expect(file).not.toBeNull();
  expect(download.suggestedFilename()).toBe('production-sh3-edited.ply');
  const bytes = await readFile(file!);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0);
  return bytes;
}
async function prepareEditedRedo(page: Page) {
  await openFixture(page);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await grade(page, '1.3'); const first = await exportBytes(page);
  await grade(page, '1.7'); const second = await exportBytes(page); expect(second.equals(first)).toBe(false);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await expect(page).toHaveTitle(`• ${fixture.name} — SplatView`);
  expect((await exportBytes(page)).equals(first)).toBe(true);
  const active = (await workerRecords(page)).find(item => item.posts.some(post => post.type === 'source-load'));
  expect(active).toBeDefined();
  const summary = active!.replies.findLast(reply => reply.summary)?.summary;
  const masks = active!.replies.findLast(reply => reply.masks)?.masks;
  expect(summary?.canRedo).toBe(true); expect(summary?.selected).toBe(3); expect(masks).toEqual([1, 1, 1]);
  return { first, second, activeId: active!.id, summary: summary!, masks: masks! };
}
async function checkRetained(page: Page, before: Awaited<ReturnType<typeof prepareEditedRedo>>) {
  await expect(page).toHaveTitle(`• ${fixture.name} — SplatView`);
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true }).locator('.model-stats')).toHaveText(/^3\/[\d,]+ splats \| SH[0-3]$/);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  const active = (await workerRecords(page)).find(item => item.id === before.activeId)!;
  expect(active.terminated).toBe(false);
  const after = active.replies.findLast(reply => reply.summary)!.summary!;
  expect(after.contentRevision).toBe(before.summary.contentRevision);
  expect(after.revision).toBe(before.summary.revision); expect(after.selected).toBe(before.summary.selected);
  expect(after.canRedo).toBe(true); expect(after.canUndo).toBe(true);
  await wake(page); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.second)).toBe(true);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  const restored = (await workerRecords(page)).find(item => item.id === before.activeId)!;
  expect(restored.replies.findLast(reply => reply.masks)!.masks).toEqual(before.masks);
  await grade(page, '1.1'); expect((await exportBytes(page)).equals(before.first)).toBe(false);
  await expect(page).toHaveTitle(`• ${fixture.name} — SplatView`);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
}

test('shipped entry opens, selects, edits, retains isolated Redo and exports real native bytes', async ({ page }) => {
  await observeWorkers(page); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const before = await prepareEditedRedo(page); await checkRetained(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  const records = await workerRecords(page); expect(records).toHaveLength(1);
  expect(records[0].actualReadyBuild).toEqual((await deployment()).build);
  expect(records[0].posts[0].type).toBe('initialize'); expect(records[0].url).toMatch(/^blob:/);
});

test('shipped Settings tabs and Font size preserve native edits and Redo while owning keyboard focus', async ({ page }) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page);
  const runtimeBefore = await workerRecords(page), commands = runtimeBefore[0].posts.filter(post => post.type === 'command');
  const opener = page.getByRole('button', { name: 'Settings', exact: true });
  await opener.click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect.poll(() => settings.evaluate(dialog => dialog.contains(document.activeElement))).toBe(true);
  // Exercise both browser modifier conventions without refocusing a dialog
  // child. Neither may reach the real document worker while Settings is open.
  for (const shortcut of ['Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z']) await page.keyboard.press(shortcut);
  const checkTab = async (name: 'General' | 'Privacy' | 'Help') => {
    const tablist = settings.getByRole('tablist', { name: 'Settings sections', exact: true });
    await expect(tablist.getByRole('tab')).toHaveCount(3);
    for (const label of ['General', 'Privacy', 'Help']) {
      const tab = tablist.getByRole('tab', { name: label, exact: true });
      await expect(tab).toHaveAttribute('aria-selected', String(label === name));
      await expect(tab).toHaveAttribute('tabindex', label === name ? '0' : '-1');
    }
    const selected = tablist.getByRole('tab', { name, exact: true }), panel = settings.getByRole('tabpanel', { name, exact: true });
    await expect(settings.getByRole('tabpanel')).toHaveCount(1); await expect(panel).toBeVisible();
    await expect(selected).toHaveAttribute('aria-controls', /.+/); await expect(panel).toHaveAttribute('aria-labelledby', /.+/);
    expect(await selected.getAttribute('aria-controls')).toBe(await panel.getAttribute('id'));
    expect(await panel.getAttribute('aria-labelledby')).toBe(await selected.getAttribute('id'));
    await expect(settings.getByRole('button', { name: 'Font size', exact: true })).toHaveCount(name === 'General' ? 1 : 0);
    for (const shortcut of ['Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z']) await page.keyboard.press(shortcut);
    expect(await workerRecords(page)).toEqual(runtimeBefore);
  };
  await checkTab('General');
  for (const name of ['Privacy', 'Help', 'General'] as const) {
    await settings.getByRole('tab', { name, exact: true }).click(); await checkTab(name);
  }
  await settings.getByRole('tab', { name: 'General', exact: true }).focus();
  for (const [key, name] of [['ArrowRight', 'Privacy'], ['ArrowRight', 'Help'], ['ArrowRight', 'General'],
    ['ArrowLeft', 'Help'], ['Home', 'General'], ['End', 'Help']] as const) {
    await page.keyboard.press(key); await expect(settings.getByRole('tab', { name, exact: true })).toBeFocused(); await checkTab(name);
  }
  // Selection belongs to the Settings view and survives dismiss/reopen without
  // posting any document operation or changing the retained history endpoint.
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(settings).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click(); await expect(settings.getByRole('button', { name: 'Close Settings', exact: true })).toBeFocused();
  await checkTab('Help');
  await settings.getByRole('tab', { name: 'General', exact: true }).click(); await checkTab('General');
  const trigger = settings.getByRole('button', { name: 'Font size', exact: true });
  await trigger.click();
  await page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: 'Large', exact: true }).hover();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-size.v1'))).toBeNull();
  await page.keyboard.press('Escape');
  await expect(settings).toBeVisible(); await expect(trigger).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'small');
  await trigger.click();
  await page.getByRole('listbox', { name: 'Font size choices', exact: true }).getByRole('option', { name: 'Large', exact: true }).click();
  await expect(page.locator('main')).toHaveAttribute('data-ui-size', 'large');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-size.v1'))).toBe('large');
  expect((await workerRecords(page))[0].posts.filter(post => post.type === 'command')).toEqual(commands);
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(settings).toHaveCount(0); await expect(opener).toBeFocused();
  await checkRetained(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await workerRecords(page))[0].actualReadyBuild).toEqual((await deployment()).build);
});

test('shipped eight-theme selector previews, persists and follows System without document operations or losing native Redo', async ({ page }, info) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page), runtime = await workerRecords(page);
  const commands = runtime[0].posts.filter(post => post.type === 'command');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  const trigger = dialog.getByRole('button', { name: 'Theme', exact: true });
  const choices = page.getByRole('listbox', { name: 'Theme choices', exact: true });
  await trigger.click();
  const ordered = ['System', 'Dark', 'Bright', 'Solar', 'Slate', 'Midnight', 'Forest', 'Rose'];
  await expect(choices.getByRole('option')).toHaveCount(ordered.length);
  for (const [index, name] of ordered.entries()) await expect(choices.getByRole('option').nth(index)).toHaveAccessibleName(name);
  await choices.getByRole('option', { name: 'Rose', exact: true }).hover(); await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'rose');
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-theme.v1'))).toBeNull();
  await page.keyboard.press('Escape'); await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark'); await expect(trigger).toBeFocused();
  for (const [name, code] of [['Bright', 'bright'], ['Solar', 'solar'], ['Slate', 'slate'], ['Midnight', 'midnight'], ['Forest', 'forest'], ['Rose', 'rose'], ['Dark', 'dark']] as const) {
    await trigger.click(); await choices.getByRole('option', { name, exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-ui-theme', code);
    expect(await page.evaluate(() => localStorage.getItem('splatview.ui-theme.v1'))).toBe(code);
    expect((await workerRecords(page))[0].posts.filter(post => post.type === 'command')).toEqual(commands);
  }
  await page.emulateMedia({ colorScheme: 'light' }); await trigger.click(); await choices.getByRole('option', { name: 'System', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'bright');
  await page.emulateMedia({ colorScheme: 'dark' }); await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'dark');
  await expect(trigger).toHaveAttribute('aria-description', 'Current theme: System');
  expect((await workerRecords(page))[0].posts.filter(post => post.type === 'command')).toEqual(commands);
  await info.attach('shipped-themes-preserved-worker', { body: JSON.stringify({ before, runtimeBefore: runtime, runtimeAfter: await workerRecords(page) }), contentType: 'application/json' });
  await dialog.getByRole('button', { name: 'Close Settings', exact: true }).click(); await checkRetained(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped language preview and all eight catalogs preserve the edited native scene and executable Redo', async ({ page }, info) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page), runtime = await workerRecords(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.locator('.settings-dialog'), trigger = dialog.locator('.language-trigger');
  const menu = page.locator('.ui-language-menu');
  await trigger.click(); await expect(menu.getByRole('option')).toHaveCount(9);
  await menu.locator('[data-language="es"]').hover();
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(dialog.getByRole('heading', { name: 'Configuración', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('splatview.ui-language.v1'))).toBeNull();
  await page.keyboard.press('Escape'); await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(trigger).toBeFocused();
  const observations = [];
  for (const code of ['es', 'fr', 'de', 'pt', 'zh-Hans', 'ja', 'ko', 'en']) {
    await trigger.click(); await menu.locator(`[data-language="${code}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('lang', code);
    expect(await page.evaluate(() => localStorage.getItem('splatview.ui-language.v1'))).toBe(code);
    expect(await workerRecords(page)).toEqual(runtime);
    observations.push({ code, heading: await dialog.locator('h1').innerText(), caption: await trigger.getAttribute('aria-label') });
  }
  await info.attach('shipped-languages-preserved-worker', { body: JSON.stringify({ before, observations, runtimeBefore: runtime,
    runtimeAfter: await workerRecords(page) }), contentType: 'application/json' });
  await dialog.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await checkRetained(page, before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped viewport guides cycle without worker operations or changing exact edited native bytes and Redo', async ({ page }, info) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page), runtime = await workerRecords(page);
  const button = page.getByRole('button', { name: 'Viewport guides', exact: true }), overlay = page.locator('.viewport-guides');
  const navigation = page.getByRole('group', { name: 'View navigation', exact: true });
  expect(await navigation.getByRole('button').evaluateAll(buttons => buttons.map(value => value.getAttribute('aria-label'))))
    .toEqual(['Reset camera', 'Orbit / Look', 'Auto orbit', 'Flip up', 'Viewport guides', 'Background']);
  await expect(button).toHaveAttribute('aria-pressed', 'false'); await expect(overlay).toHaveCount(0);
  const observations = [];
  for (const [mode, title] of [['grid', 'Guides: horizontal grid. Click for XYZ axes.'],
    ['axes', 'Guides: XYZ axes. Click for both.'], ['both', 'Guides: grid and axes. Click to hide.'],
    ['none', 'Guides: none. Click for grid.']] as const) {
    await button.click(); await expect(button).toHaveAttribute('title', title);
    await expect(button).toHaveAttribute('aria-pressed', String(mode !== 'none'));
    if (mode === 'none') await expect(overlay).toHaveCount(0);
    else {
      await expect(overlay).toHaveAttribute('data-guides-mode', mode);
      await expect.poll(() => overlay.locator('line').count()).toBeGreaterThan(0);
      await expect(overlay).toHaveAttribute('aria-hidden', 'true');
      expect(await overlay.evaluate(element => getComputedStyle(element).pointerEvents)).toBe('none');
    }
    observations.push({ mode, lines: await overlay.locator('line').count() });
    expect(await workerRecords(page)).toEqual(runtime);
  }
  await info.attach('shipped-guides-preserved-worker', { body: JSON.stringify({ before, observations, runtimeBefore: runtime, runtimeAfter: await workerRecords(page) }), contentType: 'application/json' });
  await checkRetained(page, before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped Help tutorial replays over an edited native scene without touching worker history or export bytes', async ({ page }, info) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('splatview.tutorial.v1') === null)
      localStorage.setItem('splatview.tutorial.v1', JSON.stringify({ tutorial_prompt_handled: 'handled', tutorial_version: 3 }));
  });
  await observeWorkers(page);const before = await prepareEditedRedo(page), runtime = await workerRecords(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Help', exact: true }).click();
  await settings.locator('[data-tutorial-replay]').click();
  await expect(settings).toHaveCount(0);
  const layer = page.locator('.tutorial-layer[data-tutorial-phase="tour"]');
  const card = layer.locator('.tutorial-card[role="dialog"]');
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(layer).toHaveAttribute('data-tutorial-step', '1');
  await expect(layer).toHaveAttribute('data-tutorial-active-target', 'open');
  await expect(card.locator('h1')).toHaveText('Open a scene');
  await card.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(layer).toHaveAttribute('data-tutorial-active-target', 'save');
  await card.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(layer).toHaveAttribute('data-tutorial-active-target', 'thumbnail');
  await expect(card.locator('h1')).toHaveText('Save this view');
  await card.locator('.tutorial-card-body').focus();
  for (const key of ['Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z', 'PageUp', 'g'])
    await page.keyboard.press(key);
  expect(await workerRecords(page)).toEqual(runtime);
  await card.getByRole('button', { name: 'Close tutorial', exact: true }).click();
  await expect(layer).toHaveCount(0);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('splatview.tutorial.v1')))!).tutorial_version).toBe(7);
  await info.attach('shipped-tutorial-preserved-worker', { body: JSON.stringify({ before, runtimeBefore: runtime,
    runtimeAfter: await workerRecords(page) }), contentType: 'application/json' });
  await checkRetained(page, before);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('same production entry and native workers operate under a GitHub Pages project subpath', async ({ page }) => {
  const escaped: string[] = []; page.on('request', request => {
    if (/^\/(assets|wasm|icons)\//.test(new URL(request.url()).pathname)) escaped.push(request.url());
  });
  await page.route('**/project/**', async route => {
    const target = new URL(route.request().url()); target.pathname = target.pathname.replace(/^\/project/, '');
    const response = await route.fetch({ url: target.href }); await route.fulfill({ response });
  });
  await observeWorkers(page); await openFixture(page, '/project/');
  await grade(page, '1.2'); expect((await exportBytes(page)).length).toBeGreaterThan(100);
  await expect(page.getByRole('alert')).toHaveCount(0); expect(escaped).toEqual([]);
  expect((await workerRecords(page))[0].actualReadyBuild).toEqual((await deployment()).build);
});

const descriptorFaults = ['application-input', 'protocol', 'ui-worker-contract', 'native-input',
  'native-semantics', 'missing-native-capability', 'camera-input', 'camera-semantics', 'map-layout', 'native-variant'] as const;
for (const fault of descriptorFaults) test(`shipped entry refuses ${fault} mismatch before creating a worker`, async ({ page }) => {
  await observeWorkers(page);
  await alteredManifest(page, value => {
    if (fault === 'application-input') value.build.appInputId = 'd'.repeat(64);
    if (fault === 'protocol') value.build.protocolVersion++;
    if (fault === 'ui-worker-contract') value.build.uiWorkerContract++;
    if (fault === 'native-input') value.build.native.core.nativeInputId = 'd'.repeat(64);
    if (fault === 'native-semantics') value.build.native.core.capabilities.connectedColorSelection++;
    if (fault === 'missing-native-capability') delete value.build.native.core.capabilities.selectionMap;
    if (fault === 'camera-input') value.build.native.camera.nativeInputId = 'd'.repeat(64);
    if (fault === 'camera-semantics') value.build.native.camera.capabilities.cameraInput++;
    if (fault === 'map-layout') value.build.native.core.mapLayoutVersion!++;
    if (fault === 'native-variant') Object.assign(value.build.native.core, { variant: 'simd' });
  });
  await page.goto('/'); await expect(page.getByRole('alert')).toContainText(/could not verify this build/);
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toHaveCount(0);
  expect(await workerRecords(page)).toEqual([]);
});

const manifestFaults = ['missing-worker', 'duplicate-role', 'duplicate-url', 'foreign-url', 'escaping-path',
  'encoded-path', 'query-path', 'fragment-path', 'wrong-entry', 'wrong-deployment-id'] as const;
for (const fault of manifestFaults) test(`shipped entry refuses manifest ${fault} before creating a worker`, async ({ page }) => {
  await observeWorkers(page);
  const value = await alteredManifest(page, manifest => {
    const worker = artifact(manifest, 'document-worker');
    if (fault === 'missing-worker') manifest.artifacts = manifest.artifacts.filter(row => row !== worker);
    if (fault === 'duplicate-role') manifest.artifacts.push({ ...worker, path: 'assets/duplicate-worker.js' });
    if (fault === 'duplicate-url') artifact(manifest, 'core-glue').path = worker.path;
    if (fault === 'foreign-url') worker.path = 'https://other.example/worker.js';
    if (fault === 'escaping-path') worker.path = '../worker.js';
    if (fault === 'encoded-path') worker.path = 'assets/%2e%2e/worker.js';
    if (fault === 'query-path') worker.path += '?version=old';
    if (fault === 'fragment-path') worker.path += '#old';
    if (fault === 'wrong-entry') artifact(manifest, 'application-entry').path = 'assets/another-application.js';
  });
  if (fault === 'wrong-deployment-id') {
    value.deploymentId = 'f'.repeat(64); await page.unroute('**/build-manifest.json');
    await page.route('**/build-manifest.json', route => fulfillBytes(route, JSON.stringify(value), 'application/json'));
  }
  await page.goto('/'); await expect(page.getByRole('alert')).toContainText(/could not verify this build/);
  expect(await workerRecords(page)).toEqual([]);
});

for (const role of ['document-worker', 'core-glue', 'core-wasm', 'camera-glue', 'camera-wasm'] as const)
  for (const fault of ['tampered', 'truncated'] as const)
    test(`shipped entry refuses ${fault} ${role} bytes before creating a worker`, async ({ page }) => {
      await observeWorkers(page); const row = artifact(await deployment(), role);
      const original = await readFile(resolve('dist', row.path));
      const changed = fault === 'truncated' ? original.subarray(0, original.length - 1) : Buffer.from(original);
      if (fault === 'tampered') changed[Math.floor(changed.length / 2)] ^= 1;
      await page.route(`**/${row.path}`, route => fulfillBytes(route, changed,
        role.endsWith('wasm') ? 'application/wasm' : 'text/javascript'));
      await page.goto('/'); await expect(page.getByRole('alert')).toContainText(/bytes differ|declared byte limit/);
      expect(await workerRecords(page)).toEqual([]);
    });

for (const kind of ['core', 'camera'] as const)
  test(`real legacy ${kind} passes exact-byte hashes and is refused by its older ABI`, async ({ page }) => {
    await observeWorkers(page); const value = await deployment();
    for (const extension of ['mjs', 'wasm'] as const) {
      const name = `splatview-${kind}.${extension}`, bytes = await readFile(resolve(legacyDirectory, name));
      const row = artifact(value, `${kind}-${extension === 'mjs' ? 'glue' : 'wasm'}`);
      row.bytes = bytes.length; row.sha256 = digest(bytes);
      await page.route(`**/${row.path}`, route => fulfillBytes(route, bytes, extension === 'mjs' ? 'text/javascript' : 'application/wasm'));
    }
    seal(value); await page.route('**/build-manifest.json', route => fulfillBytes(route, JSON.stringify(value), 'application/json'));
    await page.goto('/'); await expect(page.getByRole('alert')).toContainText(kind === 'core' ?
      'The application core has a different version' : 'The camera core is out of date. Reload SplatView.');
    await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeDisabled();
    const records = await workerRecords(page); expect(records).toHaveLength(1);
    expect(records[0].posts.map(post => post.type)).toEqual(['initialize']); expect(records[0].terminated).toBe(true);
    if (kind === 'camera') expect(records[0].actualReadyBuild).toEqual(value.build);
  });

test('real sealed core13 proves isolated groupedSog3, bounded codec, view-scope and morphology refusals plus shipped ABI23 refusal despite exact hashes', async ({ page }, testInfo) => {
  const fixtureRoot = resolve('tests/fixtures/build-compat/core13-group1');
  const manifestBytes = await readFile(resolve(fixtureRoot, 'manifest.json'));
  expect(digest(manifestBytes)).toBe('81d683c43c5ca1ff3e538d4859627d38d2bbf587efa39dcf1df4d0e40f0325f0');
  const fixtureManifest = JSON.parse(manifestBytes.toString('utf8')) as {
    schemaVersion: number; kind: string; coreIdentity: NativeIdentity;
    artifacts: Record<string, { bytes: number; sha256: string }>;
  };
  expect(fixtureManifest.schemaVersion).toBe(1);
  expect(fixtureManifest.kind).toBe('actual-core13-group1-production-compatibility-fixture');
  expect(Object.keys(fixtureManifest.artifacts).sort()).toEqual(['splatview-core.mjs', 'splatview-core.wasm']);
  const oldBytes = new Map<'mjs' | 'wasm', Buffer>();
  for (const extension of ['mjs', 'wasm'] as const) {
    const name = `splatview-core.${extension}`;
    const bytes = await readFile(resolve(fixtureRoot, name));
    expect({ bytes: bytes.length, sha256: digest(bytes) }).toEqual(fixtureManifest.artifacts[name]);
    oldBytes.set(extension, bytes);
  }

  const current = await deployment();
  expect(current.build).toMatchObject({ protocolVersion: 28, uiWorkerContract: 23,
    native: { core: { abi: 24, capabilities: { selectionActions: 2, colorFillRange: 1, transformPivot: 2, transactionReceipt: 2, recoveryCheckpoint: 2, duplicate: 1, groupedSog: 3, exportSpz4: 1, boundedAttributeExport: 1, boundedSpz3Export: 1, boundedSogExport: 1, currentViewScope: 1, selectionMorphology: 2, selectionFilter: 2, proTransformSession: 2,
      absoluteOpacitySession: 1, opacityBaseStream: 1 } },
      camera: { abi: 4, capabilities: { cameraTransformGizmo: 1 } } } });
  type IdentityCore = { _sv_abi_version(): number; _sv_build_identity(): number; UTF8ToString(pointer: number): string;
    _sv_open_group: (...arguments_: number[]) => number };
  const compiled = await WebAssembly.compile(new Uint8Array(oldBytes.get('wasm')!));
  const imported = await import(pathToFileURL(resolve(fixtureRoot, 'splatview-core.mjs')).href) as {
    default: (options: Record<string, unknown>) => Promise<IdentityCore>;
  };
  // Invoke the untouched factory with its real fixture compiled WASM. The
  // production identity function reads the real native identity export.
  const oldCore = await imported.default({ instantiateWasm: verifiedInstantiation(compiled) });
  const actualIdentity = JSON.parse(oldCore.UTF8ToString(oldCore._sv_build_identity())) as NativeIdentity;
  expect(oldCore._sv_abi_version()).toBe(13);
  expect(typeof oldCore._sv_open_group).toBe('function');
  expect(actualIdentity).toMatchObject({ kind: 'core', abi: 13, capabilities: { groupedSog: 1 } });
  expect(actualIdentity).toEqual(fixtureManifest.coreIdentity);
  expect(nativeModuleIdentity(oldCore, actualIdentity)).toEqual(actualIdentity);

  // Keep this isolated requirement on the actual old ABI13 identity. Changing
  // only groupedSog1 to3 proves its capability refusal independently from the
  // shipped ABI23/input/recovery/SPZ/filter/transform/opacity/view-scope requirements checked by the actual App below.
  expect(actualIdentity.capabilities).not.toHaveProperty('exportSpz4');
  const capabilityOnlyRequirement = { ...actualIdentity, capabilities: { ...actualIdentity.capabilities, groupedSog: 3 } };
  expect({ ...capabilityOnlyRequirement, capabilities: { ...capabilityOnlyRequirement.capabilities, groupedSog: 1 } }).toEqual(actualIdentity);
  expect(() => nativeModuleIdentity(oldCore, capabilityOnlyRequirement)).toThrow(/the core identity or required capabilities differ/);
  expect(actualIdentity.capabilities).not.toHaveProperty('boundedSpz3Export');
  const spz3CapabilityOnlyRequirement = { ...actualIdentity, capabilities: { ...actualIdentity.capabilities, boundedSpz3Export: 1 } };
  expect({ ...spz3CapabilityOnlyRequirement, capabilities: actualIdentity.capabilities }).toEqual(actualIdentity);
  expect(() => nativeModuleIdentity(oldCore, spz3CapabilityOnlyRequirement)).toThrow(/the core identity or required capabilities differ/);
  expect(actualIdentity.capabilities).not.toHaveProperty('boundedSogExport');
  const sogCapabilityOnlyRequirement = { ...actualIdentity, capabilities: { ...actualIdentity.capabilities, boundedSogExport: 1 } };
  expect({ ...sogCapabilityOnlyRequirement, capabilities: actualIdentity.capabilities }).toEqual(actualIdentity);
  expect(() => nativeModuleIdentity(oldCore, sogCapabilityOnlyRequirement)).toThrow(/the core identity or required capabilities differ/);
  expect(actualIdentity.capabilities).not.toHaveProperty('currentViewScope');
  const viewCapabilityOnlyRequirement = { ...actualIdentity, capabilities: { ...actualIdentity.capabilities, currentViewScope: 1 } };
  expect({ ...viewCapabilityOnlyRequirement, capabilities: actualIdentity.capabilities }).toEqual(actualIdentity);
  expect(() => nativeModuleIdentity(oldCore, viewCapabilityOnlyRequirement)).toThrow(/the core identity or required capabilities differ/);
  expect(actualIdentity.capabilities.selectionMorphology).toBe(1);
  const morphologyCapabilityOnlyRequirement = { ...actualIdentity,
    capabilities: { ...actualIdentity.capabilities, selectionMorphology: 2 } };
  expect({ ...morphologyCapabilityOnlyRequirement, capabilities: actualIdentity.capabilities }).toEqual(actualIdentity);
  expect(() => nativeModuleIdentity(oldCore, morphologyCapabilityOnlyRequirement)).toThrow(/the core identity or required capabilities differ/);
  expect(nativeModuleIdentity(oldCore, actualIdentity)).toEqual(actualIdentity);

  // The shipped App requires ABI23 and recovery checkpoints, its current input identity, cap3, SPZ v4,
  // bounded SPZ v3/SOG/SOGS, selection filters and transform sessions. Its combined refusal is not a cap-only runtime claim.
  await observeWorkers(page);
  const served: string[] = [];
  for (const extension of ['mjs', 'wasm'] as const) {
    const bytes = oldBytes.get(extension)!, row = artifact(current, extension === 'mjs' ? 'core-glue' : 'core-wasm');
    row.bytes = bytes.length; row.sha256 = digest(bytes);
    await page.route(`**/${row.path}`, async route => {
      served.push(extension);
      await fulfillBytes(route, bytes, extension === 'mjs' ? 'text/javascript' : 'application/wasm');
    });
  }
  seal(current);
  await page.route('**/build-manifest.json', route => fulfillBytes(route, JSON.stringify(current), 'application/json'));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText(/core has a different version|the core identity or required capabilities differ/);
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeDisabled();
  await expect.poll(async () => (await workerRecords(page)).filter(record => record.terminated).length).toBe(1);
  const records = await workerRecords(page);
  expect(records).toHaveLength(1); expect(records[0].posts.map(post => post.type)).toEqual(['initialize']);
  expect(records[0].actualReadyBuild).toBeUndefined();
  expect(records[0].replies.some(reply => reply.type === 'initialization-failed' &&
    /core has a different version|the core identity or required capabilities differ/.test(reply.error ?? ''))).toBe(true);
  expect(served.sort()).toEqual(['mjs', 'wasm']);
  await testInfo.attach('actual-old-core13-groupedSog1-identity-guard.json', { contentType: 'application/json',
    body: Buffer.from(JSON.stringify({ actualIdentity, shippedRequirement: current.build.native.core, capabilityOnlyRequirement, spz3CapabilityOnlyRequirement, sogCapabilityOnlyRequirement, viewCapabilityOnlyRequirement, morphologyCapabilityOnlyRequirement,
      byteHashesMatchManifest: true, actualAbi: oldCore._sv_abi_version(), workerPosts: records[0].posts,
      scope: 'Untouched compiled old module proves groupedSog3, missing boundedSpz3Export/boundedSogExport/currentViewScope and morphology version2 cap-only refusals against its own ABI13/input identity. Actual shipped ABI23 App refuses the combined old ABI/input/capabilities before ready or source dispatch.' }, null, 2)) });
});

const families = ['source-load', 'source-range', 'command', 'live-preview', 'geometry-stream', 'stream', 'masks', 'export', 'selection-map', 'ack', 'cancel', 'map-chunk', 'map-commit'] as const;

for (const kind of ['points', 'mesh'] as const) test(`verified production ${kind} PLY streams real geometry and keeps desktop view-only controls`, async ({ page }) => {
  await observeWorkers(page); const manifest = await deployment();
  // Literal ordinary PLY, independent of Gaussian encoders and GPU packers.
  const name = `production-${kind}.ply`, bytes = Buffer.from(['ply', 'format ascii 1.0', 'element vertex 4',
    'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue',
    ...(kind === 'mesh' ? ['element face 1', 'property list uchar int vertex_indices'] : []), 'end_header',
    '-1 -1 0 255 0 0', '1 -1 0 0 255 0', '1 1 0 0 0 255', '-1 1 0 200 180 40',
    ...(kind === 'mesh' ? ['4 0 1 2 3'] : []), ''].join('\n'));
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: bytes });
  await expect(page).toHaveTitle(`${name} — SplatView`); await wake(page);
  await expect(page.getByRole('button', { name: 'Tools', exact: true })).toHaveCount(0);
  const panel = page.getByRole('group', { name: 'Viewer panel', exact: true });
  await expect(panel.getByRole('button')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Settings', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save scene', exact: true })).toBeDisabled();
  await expect(page.getByRole('complementary', { name: 'Tools', exact: true })).toHaveCount(0);
  for (const label of ['Reset camera', 'Orbit / Look', 'Flip up', 'Narrower lens', 'Wider lens', 'Capture image', 'Copy image', 'Background', 'Fullscreen'])
    await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled();
  await page.getByLabel('SplatView scene').focus(); await page.keyboard.press('Control+s');
  await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0);
  const downloadReady = page.waitForEvent('download'); await page.getByRole('button', { name: 'Capture image', exact: true }).click();
  const download = await downloadReady, file = await download.path(); expect(download.suggestedFilename()).toBe('SplatView.jpg');
  expect(file).not.toBeNull(); const jpeg = await readFile(file!);
  expect([...jpeg.subarray(0, 2)]).toEqual([255, 216]); expect([...jpeg.subarray(-2)]).toEqual([255, 217]);
  const dimensions = await page.evaluate(async encoded => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(encoded)], { type: 'image/jpeg' }));
    try { return [bitmap.width, bitmap.height]; } finally { bitmap.close(); }
  }, [...jpeg]);
  expect(dimensions).toEqual([1280, 800]);
  const records = await workerRecords(page), active = records.find(record => record.posts.some(post => post.type === 'source-load'))!;
  expect(active.actualReadyBuild).toEqual(manifest.build);
  const summary = active.replies.findLast(reply => reply.summary)?.summary!;
  expect(summary.kind).toBe(kind === 'mesh' ? 2 : 1); expect(summary.count).toBe(4); expect(summary.sourceCount).toBe(4);
  expect(summary.sourceFaces).toBe(kind === 'mesh' ? 1 : 0); expect(summary.geometry?.triangleCount).toBe(kind === 'mesh' ? 2 : 0);
  expect(summary.selected).toBe(0); expect(summary.canUndo).toBe(false); expect(summary.canRedo).toBe(false);
  const chunks = active.replies.filter(reply => reply.type === 'geometry-chunk');
  expect(chunks.map(reply => [reply.channel, reply.first, reply.count, reply.byteLength])).toEqual([
    ['vertices', 0, 4, 64], ...(kind === 'mesh' ? [['indices', 0, 6, 24]] : []),
  ]);
  expect(active.posts.filter(post => post.type === 'ack')).toHaveLength(chunks.length);
  expect(active.posts.some(post => ['stream', 'masks', 'selection-map', 'export'].includes(post.type))).toBe(false);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const family of families) test(`actual production worker refuses ${family} before initialize`, async ({ page }) => {
  const manifest = await deployment(); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  const response = await page.evaluate(async ({ manifest, family, ply, sourceBudgetBytes }) => {
    const workerArtifact = manifest.artifacts.find(row => row.role === 'document-worker')!;
    const worker = new Worker(new URL(workerArtifact.path, location.href), { type: 'module' });
    try {
      return await new Promise<{ type: string; error?: string; summary?: unknown }>((resolveResponse, reject) => {
        const timer = setTimeout(() => reject(new Error('No pre-initialization refusal')), 10_000);
        worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
        worker.onmessage = event => { clearTimeout(timer); resolveResponse(event.data); };
        worker.postMessage({ type: family, protocolVersion: manifest.build.protocolVersion, buildId: manifest.build.appInputId,
          requestId: 1, base: { documentId: 'pre-init-probe', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 },
          source: { kind: 'single', operationId: 'pre-init-operation', resourceId: 'pre-init-resource', byteLength: ply.length, path: '', role: 'primary' },
          operationId: 'pre-init-operation', resourceId: 'pre-init-resource', rangeId: 0, length: ply.length,
          format: 0, maxSplats: 100, budgetBytes: 64 * 1024 * 1024, sourceBudgetBytes,
          command: { command: family === 'export' ? 'export' : 'selectAll' }, chunkId: 0,
          descriptor: family === 'geometry-stream' ? { layoutVersion: 1, kind: 1, vertexCount: 4, triangleCount: 0,
            vertexStride: 16, indexStride: 4, vertexBytes: 64, indexBytes: 0, revision: 0, contentRevision: 0 }
            : { layoutVersion: 1, mapId: 1, fullWidth: 1, fullHeight: 1, mapWidth: 1, mapHeight: 1, sourceCount: 3, channels: 3 },
          mapId: 1, offset: 0, bytes: family === 'source-range' ? new Uint8Array(ply).buffer : new ArrayBuffer(8) });
      });
    } finally { worker.terminate(); }
  }, { manifest, family, ply: Array.from(gaussianPly()), sourceBudgetBytes: sourceWorkerBytes(gaussianPly().byteLength) });
  expect(response.type).toBe('error'); expect(response.error).toMatch(/not ready.*Initialize a compatible build first/);
  expect(response.summary).toBeUndefined();
});

test('actual production worker refuses duplicate initialization and oversized input, then loads a supported file', async ({ page }) => {
  const manifest = await deployment(); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  const replies = await page.evaluate(async ({ manifest, ply, sourceBudgetBytes }) => {
    const row = (role: BuildArtifact['role']) => manifest.artifacts.find(item => item.role === role)!;
    const base = new URL('.', location.href).href, glue = row('core-glue'), wasm = row('core-wasm');
    const worker = new Worker(new URL(row('document-worker').path, base), { type: 'module' });
    const source = { assetBase: new URL('wasm/', base).href,
      glue: await (await fetch(new URL(glue.path, base))).arrayBuffer(), wasm: await (await fetch(new URL(wasm.path, base))).arrayBuffer(),
      glueArtifact: glue, wasmArtifact: wasm };
    const request = { type: 'initialize', initializationId: 'duplicate-init-probe', build: manifest.build,
      mode: 'production-verified', assetBase: base, source, manifest, manifestUrl: new URL('build-manifest.json', base).href,
      entryUrl: new URL(row('application-entry').path, base).href };
    const send = (message: unknown, observed?: Record<string, unknown>[]) => new Promise<Record<string, unknown>>((resolveReply, reject) => {
      const timer = setTimeout(() => reject(new Error('Production worker did not reply')), 10_000);
      worker.onerror = event => { clearTimeout(timer); reject(new Error(event.message)); };
      worker.onmessage = event => {
        observed?.push(event.data);
        if (event.data.type === 'progress') return; clearTimeout(timer); resolveReply(event.data);
      };
      worker.postMessage(message);
    });
    try {
      const ready = await send(request), duplicate = await send(request);
      const file = new File([new Uint8Array(ply)], 'probe.ply');
      const descriptor = { kind: 'single', operationId: 'post-duplicate-operation', resourceId: 'post-duplicate-resource',
        byteLength: file.size, path: '', role: 'primary' };
      const envelope = { protocolVersion: manifest.build.protocolVersion, buildId: manifest.build.appInputId,
        requestId: 1, base: { documentId: 'post-duplicate-probe', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
      // Send only a descriptor, never a large source body. The emitted worker
      // must refuse it before requesting any bytes or starting decode.
      const sizeReplies: Record<string, unknown>[] = [];
      const oversized = await send({ ...envelope, type: 'source-load',
        source: { ...descriptor, byteLength: 64 }, format: 0, maxSplats: 100,
        budgetBytes: 64, sourceBudgetBytes: 64 + 65_536 + 64 }, sizeReplies);
      envelope.requestId++;
      const requested: number[][] = [], consumed: number[][] = [];
      const loaded = await new Promise<Record<string, unknown>>((resolveReply, reject) => {
        let settled = false, offset = 0, rangeId = 0;
        let credit: { rangeId: number; offset: number; length: number; transferred: boolean } | undefined;
        const fail = (reason: unknown) => {
          if (settled) return; settled = true; clearTimeout(timer);
          reject(reason instanceof Error ? reason : new Error(String(reason)));
        };
        const timer = setTimeout(() => fail(new Error('Production source load did not finish')), 10_000);
        worker.onerror = event => fail(new Error(event.message));
        worker.onmessage = event => {
          if (settled) return;
          void (async () => {
            const data = event.data;
            if (data.type === 'progress') return;
            if (data.protocolVersion !== envelope.protocolVersion || data.buildId !== envelope.buildId ||
                data.requestId !== envelope.requestId || Object.entries(envelope.base).some(([key, value]) => data.base?.[key] !== value))
              throw new Error('Production source response changed its envelope.');
            if (data.type === 'error') throw new Error(data.error);
            if (data.operationId !== descriptor.operationId || data.resourceId !== descriptor.resourceId)
              throw new Error('Production source response changed its resource identity.');
            if (data.type === 'source-range-request') {
              const length = Math.min(1024 * 1024, file.size - offset);
              if (credit || length === 0 || data.rangeId !== rangeId || data.offset !== offset || data.length !== length)
                throw new Error('Invalid production source read credit.');
              const active = { rangeId, offset, length, transferred: false }; credit = active;
              requested.push([rangeId, offset, length]);
              const bytes = await file.slice(offset, offset + length).arrayBuffer();
              if (settled) return;
              if (bytes.byteLength !== length) throw new Error('Production fixture read was truncated.');
              worker.postMessage({ ...envelope, type: 'source-range', operationId: descriptor.operationId,
                resourceId: descriptor.resourceId, rangeId, offset, length, bytes }, [bytes]);
              if (bytes.byteLength !== 0) throw new Error('Production source buffer was not transferred.');
              active.transferred = true; return;
            }
            if (data.type === 'source-range-consumed') {
              if (!credit?.transferred || data.rangeId !== credit.rangeId || data.offset !== credit.offset || data.length !== credit.length)
                throw new Error('Production source consumption did not match its transfer.');
              consumed.push([credit.rangeId, credit.offset, credit.length]);
              offset += credit.length; rangeId++; credit = undefined; return;
            }
            if (data.type !== 'source-load-result' || credit || offset !== file.size || data.consumedBytes !== file.size)
              throw new Error('Production source load completed before all native consumption receipts.');
            settled = true; clearTimeout(timer); resolveReply(data);
          })().catch(fail);
        };
        worker.postMessage({ ...envelope, type: 'source-load', source: descriptor, format: 0,
          maxSplats: 100, budgetBytes: 64 * 1024 * 1024, sourceBudgetBytes });
      });
      return { ready, duplicate, oversized, sizeReplies, loaded, requested, consumed };
    } finally { worker.terminate(); }
  }, { manifest, ply: Array.from(gaussianPly()), sourceBudgetBytes: sourceWorkerBytes(gaussianPly().byteLength) });
  expect(replies.ready.type).toBe('ready'); expect(replies.ready.build).toEqual(manifest.build);
  expect(replies.ready.core).toEqual(manifest.build.native.core);
  expect(replies.oversized.type).toBe('error');
  expect(replies.oversized.error).toBe('The scene source does not fit within the available decode memory budget.');
  expect(replies.sizeReplies).toHaveLength(1);
  expect(replies.sizeReplies[0].type).toBe('error');
  expect(replies.duplicate.type).toBe('initialization-failed'); expect(replies.duplicate.error).toMatch(/already initialized/);
  expect(replies.loaded.type).toBe('source-load-result'); expect((replies.loaded.summary as NativeSummary).count).toBe(3);
  expect(replies.requested).toEqual([[0, 0, fixture.buffer.length]]); expect(replies.consumed).toEqual(replies.requested);
  expect(replies.loaded.fingerprint).toEqual({ scheme: 'splatview-source-v1', resourceCount: 1,
    totalBytes: fixture.buffer.length, sourceKindHint: 'PLY', assetDigest: singleAssetDigest(fixture.buffer) });
});

test('a real candidate ready mismatch retains the edited active scene, exact bytes and isolated Redo', async ({ page }) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page);
  await page.evaluate(() => { window.__compatMonitor.failNextReady = true; });
  await page.getByLabel('Open scene files').setInputFiles(replacement);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/different builds/);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  const records = await workerRecords(page), candidate = records.find(item => item.id !== before.activeId)!;
  expect(records).toHaveLength(2); expect(candidate.actualReadyBuild).toEqual((await deployment()).build);
  expect(candidate.changedReady).toBe(true); expect(candidate.posts.map(post => post.type)).toEqual(['initialize']);
  expect(candidate.terminated).toBe(true);
  expect(await page.evaluate(url => window.__compatMonitor.revokedBlobUrls.includes(url), candidate.url)).toBe(true);
  await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await checkRetained(page, before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('Cancel while a real candidate ready is held retires its worker and preserves the edited active scene', async ({ page }) => {
  await observeWorkers(page); const before = await prepareEditedRedo(page);
  await page.evaluate(() => { window.__compatMonitor.holdNextReady = true; });
  await page.getByLabel('Open scene files').setInputFiles(replacement);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(async () => (await workerRecords(page)).some(item => item.heldReady)).toBe(true);
  let candidate = (await workerRecords(page)).find(item => item.heldReady)!;
  expect(candidate.actualReadyBuild).toEqual((await deployment()).build);
  expect(candidate.posts.map(post => post.type)).toEqual(['initialize']);
  await page.locator('.status.panel').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(async () => (await workerRecords(page)).find(item => item.id === candidate.id)?.terminated).toBe(true);
  await expect(page.locator('.status.panel')).toHaveCount(0);
  expect(await page.evaluate(url => window.__compatMonitor.revokedBlobUrls.includes(url), candidate.url)).toBe(true);
  // A late actual ready event cannot revive the retired candidate or dispatch load.
  await page.evaluate(id => window.__compatMonitor.releaseHeld(id), candidate.id);
  candidate = (await workerRecords(page)).find(item => item.id === candidate.id)!;
  expect(candidate.posts.map(post => post.type)).toEqual(['initialize']); expect(candidate.terminated).toBe(true);
  await checkRetained(page, before); await expect(page.getByRole('alert')).toHaveCount(0);
});

test('shipped Save traps and restores focus while UI and modal shortcuts preserve native edits and executable Redo', async ({ page }, info) => {
  await observeWorkers(page); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const before = await prepareEditedRedo(page), runtimeBefore = await workerRecords(page);
  const commands = runtimeBefore.map(record => ({ id: record.id, posts: record.posts.filter(post => post.type === 'command') }));
  const tools = page.getByRole('button', { name: 'Tools', exact: true });
  const navigate = page.getByRole('button', { name: 'Selection tool', exact: true });
  await expect(navigate).toHaveAttribute('aria-expanded', 'false');
  await expect(navigate.getByText('Navigate', { exact: true })).toBeVisible();
  await tools.focus(); await expect(tools).toBeFocused();
  for (const key of ['Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z', 'Control+a', 'Control+i', 'Delete', 'PageDown', 'g', 'b']) {
    await page.keyboard.press(key); await expect(tools).toBeFocused();
  }
  await expect(navigate).toHaveAttribute('aria-expanded', 'false');
  await expect(navigate.getByText('Navigate', { exact: true })).toBeVisible();
  expect((await workerRecords(page)).map(record => ({ id: record.id, posts: record.posts.filter(post => post.type === 'command') }))).toEqual(commands);

  await wake(page);
  const save = page.getByRole('button', { name: 'Save scene', exact: true });
  await save.click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  const format = dialog.getByLabel('Export format', { exact: true }), scope = dialog.getByLabel('Export scope', { exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true }), download = dialog.getByRole('button', { name: 'Download', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true'); await expect(format).toBeFocused();
  for (const target of [scope, cancel, download, format]) {
    await page.keyboard.press('Tab'); await expect(target).toBeFocused();
  }
  for (const target of [download, cancel, scope, format]) {
    await page.keyboard.press('Shift+Tab'); await expect(target).toBeFocused();
  }
  // A button avoids native select typeahead, so these keys exercise modal
  // ownership rather than changing the export format or scope locally.
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await expect(cancel).toBeFocused();
  for (const key of ['Control+z', 'Control+Shift+z', 'Meta+z', 'Meta+Shift+z', 'Control+a', 'Control+i', 'Delete', 'PageUp', 'g', 'b']) {
    await page.keyboard.press(key); await expect(cancel).toBeFocused();
  }
  await expect(navigate).toHaveAttribute('aria-expanded', 'false');
  await expect(navigate.getByText('Navigate', { exact: true })).toBeVisible();
  const runtimeAfter = await workerRecords(page);
  expect(runtimeAfter.map(record => ({ id: record.id, posts: record.posts.filter(post => post.type === 'command') }))).toEqual(commands);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(save).toBeFocused();
  await info.attach('shipped-save-input-preserved-worker', { body: JSON.stringify({ commands, runtimeBefore, runtimeAfter }), contentType: 'application/json' });

  // The retained endpoint is real native history: replay Redo, compare the
  // second edited export byte-for-byte, Undo, and confirm a new edit retires it.
  await checkRetained(page, before); await expect(page.getByRole('alert')).toHaveCount(0); expect(errors).toEqual([]);
  expect((await workerRecords(page))[0].actualReadyBuild).toEqual((await deployment()).build);
});
