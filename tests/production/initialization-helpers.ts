import { expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BuildArtifact, BuildDescriptor, RuntimeManifest } from '../../src/build/contracts';
import type { NativeSummary, Revision } from '../../src/document/types';
import { gaussianPly } from '../fixtures/gaussians';

export type ObservedWorker = {
  id: number; url: string; terminated: boolean; heldReady: boolean;
  readyBuild?: BuildDescriptor;
  posts: { type: string; command?: string; base?: Revision }[];
  replies: { type: string; summary?: NativeSummary; masks?: number[]; error?: string }[];
};
type InitializationMonitor = {
  workers: ObservedWorker[]; createdBlobUrls: string[]; revokedBlobUrls: string[];
  holdNextReady: boolean; releaseHeld(id: number): void;
};
declare global { interface Window { __initializationMonitor: InitializationMonitor } }

export const sceneFile = (name = 'initialization-sh3.ply') => ({
  name, mimeType: 'application/octet-stream', buffer: Buffer.from(gaussianPly()),
});
export const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  const text = JSON.stringify(value); if (text === undefined) throw new Error('Invalid fixture data'); return text;
}
export async function deployment(): Promise<RuntimeManifest> {
  return JSON.parse(await readFile(resolve('dist/build-manifest.json'), 'utf8')) as RuntimeManifest;
}
export function artifact(manifest: RuntimeManifest, role: BuildArtifact['role']) {
  const row = manifest.artifacts.find(item => item.role === role);
  if (!row) throw new Error(`Missing shipped ${role} artifact`); return row;
}
export async function fulfillBytes(route: Route, bytes: Buffer | string, contentType: string) {
  await route.fulfill({ status: 200, contentType, headers: { 'cache-control': 'no-store' }, body: bytes });
}
async function installManifest(page: Page, manifest: RuntimeManifest) {
  const { deploymentId: _id, ...payload } = manifest;
  manifest.deploymentId = digest(canonical(payload));
  await page.route('**/build-manifest.json', route => fulfillBytes(route, JSON.stringify(manifest), 'application/json'));
}
export async function nativeFixture(page: Page, kind: 'core' | 'camera',
  change: (original: { glue: Buffer; wasm: Buffer }) => { glue?: Buffer; wasm?: Buffer }) {
  const manifest = await deployment(), glueRow = artifact(manifest, `${kind}-glue`), wasmRow = artifact(manifest, `${kind}-wasm`);
  const original = { glue: await readFile(resolve('dist', glueRow.path)), wasm: await readFile(resolve('dist', wasmRow.path)) };
  const changed = change(original);
  for (const [row, bytes, contentType] of [[glueRow, changed.glue, 'text/javascript'],
    [wasmRow, changed.wasm, 'application/wasm']] as const) {
    if (!bytes) continue;
    row.bytes = bytes.length; row.sha256 = digest(bytes);
    await page.route(`**/${row.path}`, route => fulfillBytes(route, bytes, contentType));
  }
  await installManifest(page, manifest); return manifest;
}
export function wrapGenuineFactory(glue: Buffer, body: string) {
  const original = glue.toString('utf8'), marker = 'export default Module;';
  expect(original.split(marker)).toHaveLength(2);
  return Buffer.from(original.replace(marker, `export default async function(options) {\n${body}\n}`));
}
/** Exact-hash fault fixture. It retains the genuine emitted factory and WASM;
 * its extra routed request controls only when a candidate's readiness settles.
 * This is not an independently built coherent deployment/provenance fixture. */
export async function controlledCore(page: Page, actions: ('pass' | 'reject' | 'hang')[]) {
  let calls = 0;
  await page.route('**/__initialization/factory', async route => {
    const action = actions[calls++];
    if (!action) throw new Error('Unexpected additional native factory invocation');
    await fulfillBytes(route, JSON.stringify({ action }), 'application/json');
  });
  const manifest = await nativeFixture(page, 'core', original => ({ glue: wrapGenuineFactory(original.glue, `
    const initialized = await Module(options);
    const response = await fetch(new URL('/__initialization/factory', self.location.origin));
    const { action } = await response.json();
    if (action === 'reject') throw new Error('Injected genuine-factory readiness failure');
    if (action === 'hang') await new Promise(() => {});
    return initialized;`) }));
  return { manifest, calls: () => calls };
}

/** Observe real workers and optionally delay an actual ready event. */
export async function observeWorkers(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker, held = new Map<number, { worker: Worker; data: unknown }>();
    const monitor: InitializationMonitor = { workers: [], createdBlobUrls: [], revokedBlobUrls: [], holdNextReady: false,
      releaseHeld(id) {
        const item = held.get(id); if (!item) throw new Error('No held actual readiness event');
        held.delete(id); monitor.workers[id - 1].heldReady = false;
        item.worker.dispatchEvent(new MessageEvent('message', { data: item.data }));
      } };
    window.__initializationMonitor = monitor;
    const createBlob = URL.createObjectURL.bind(URL), revokeBlob = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = object => { const url = createBlob(object); monitor.createdBlobUrls.push(url); return url; };
    URL.revokeObjectURL = url => { monitor.revokedBlobUrls.push(url); revokeBlob(url); };
    window.Worker = class extends NativeWorker {
      private record: ObservedWorker;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const holdReady = monitor.holdNextReady; monitor.holdNextReady = false;
        const record: ObservedWorker = { id: monitor.workers.length + 1, url: String(url), terminated: false,
          heldReady: false, posts: [], replies: [] };
        this.record = record; monitor.workers.push(record);
        let interceptReady = true;
        this.addEventListener('message', event => {
          const data = event.data as { type?: string; build?: BuildDescriptor; summary?: NativeSummary; bytes?: ArrayBuffer; error?: string };
          if (data?.type === 'ready' && interceptReady) {
            interceptReady = false; record.readyBuild = structuredClone(data.build!);
            if (holdReady) {
              record.heldReady = true; held.set(record.id, { worker: this, data: event.data });
              event.stopImmediatePropagation(); return;
            }
          }
          record.replies.push({ type: data?.type ?? 'untyped', summary: data?.summary ? structuredClone(data.summary) : undefined,
            masks: data?.type === 'masks' && data.bytes instanceof ArrayBuffer ? Array.from(new Uint8Array(data.bytes)) : undefined,
            error: data?.error });
        });
      }
      override postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
        const data = message as { type?: string; command?: { command?: string }; base?: Revision };
        this.record.posts.push({ type: data?.type ?? 'untyped', command: data?.command?.command,
          base: data?.base ? structuredClone(data.base) : undefined });
        if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
      }
      override terminate() { this.record.terminated = true; super.terminate(); }
    };
  });
}
export async function workers(page: Page) { return page.evaluate(() => window.__initializationMonitor.workers); }
export async function retired(page: Page, id: number) {
  await expect.poll(async () => (await workers(page)).find(item => item.id === id)?.terminated).toBe(true);
  const worker = (await workers(page)).find(item => item.id === id)!;
  expect(worker.posts.map(post => post.type)).toEqual(['initialize']);
  expect(await page.evaluate(url => window.__initializationMonitor.revokedBlobUrls.includes(url), worker.url)).toBe(true);
  return worker;
}
export async function wake(page: Page) {
  await page.mouse.move(639, 399); await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
}
export async function openScene(page: Page, file = sceneFile(), initial = false) {
  if (initial) {
    await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  }
  await page.getByLabel('Open scene files').setInputFiles(file);
  if (!initial)
    await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page).toHaveTitle(`${file.name} \u2014 SplatView`); await wake(page);
  if (!await page.getByRole('complementary', { name: 'Tools', exact: true }).count())
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true }), stats = panel.locator('.model-stats');
  if ((await stats.innerText()).includes('| SH')) await expect(stats).toHaveText('0/3 splats | SH3');
  else await expect(panel).toContainText('3 splats \u00b7 SH3');
}
export async function replaceScene(page: Page, name = 'failed-candidate.ply') {
  await page.getByLabel('Open scene files').setInputFiles(sceneFile(name));
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
}
export async function grade(page: Page, brightness: string) {
  await wake(page); await page.getByRole('slider', { name: 'Brightness', exact: true }).fill(brightness);
  await page.getByRole('button', { name: 'Apply color', exact: true }).click();
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true });
  const apply = panel.getByRole('button', { name: 'Apply color', exact: true });
  // Genuine historical A/B/C builds retain their visible disabled action.
  // Current shipped App uses the desktop statistics and hides a clean Apply.
  if ((await panel.locator('.model-stats').innerText()).includes('| SH')) await expect(apply).toBeHidden();
  else {
    await expect(panel).toContainText('3 splats \u00b7 SH3');
    await expect(apply).toBeVisible(); await expect(apply).toBeDisabled();
  }
  await expect(page.locator('.status.panel')).toHaveCount(0);
}
export async function exportBytes(page: Page, name = 'initialization-sh3') {
  await wake(page); await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true });
  await dialog.getByLabel('Export scope', { exact: true }).selectOption('0');
  const pending = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await pending, file = await download.path(); expect(file).not.toBeNull();
  expect(download.suggestedFilename()).toBe(`${name}-edited.ply`);
  const bytes = await readFile(file!);
  await page.getByRole('status').filter({ hasText: 'Download prepared' }).getByRole('button', { name: 'Stay', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Save scene', exact: true })).toHaveCount(0); return bytes;
}
// Genuine A/B/C fixtures retain their original UI; current dist uses desktop statistics.
async function selectedThree(page: Page) {
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true }), stats = panel.locator('.model-stats');
  if ((await stats.innerText()).includes('| SH')) await expect(stats).toHaveText(/^3\/3 splats \| SH3$/);
  else await expect(panel).toContainText('3 selected');
}
export async function editedRedo(page: Page) {
  await openScene(page, sceneFile(), true);
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await selectedThree(page);
  await grade(page, '1.3'); const first = await exportBytes(page);
  await grade(page, '1.7'); const second = await exportBytes(page); expect(second.equals(first)).toBe(false);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await exportBytes(page)).equals(first)).toBe(true);
  const active = (await workers(page)).find(item => item.posts.some(post => post.type === 'source-load'))!;
  const summary = active.replies.findLast(reply => reply.summary)!.summary!, masks = active.replies.findLast(reply => reply.masks)!.masks!;
  expect(summary.canRedo).toBe(true); expect(summary.selected).toBe(3); expect(masks).toEqual([1, 1, 1]);
  const base = active.posts.findLast(post => post.base)!.base!;
  return { first, second, activeId: active.id, summary, masks, base };
}
export async function retainedScene(page: Page, before: Awaited<ReturnType<typeof editedRedo>>) {
  await expect(page).toHaveTitle(`\u2022 initialization-sh3.ply \u2014 SplatView`);
  await selectedThree(page);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  const active = (await workers(page)).find(item => item.id === before.activeId)!;
  expect(active.terminated).toBe(false);
  const summary = active.replies.findLast(reply => reply.summary)!.summary!, base = active.posts.findLast(post => post.base)!.base!;
  expect(summary.contentRevision).toBe(before.summary.contentRevision); expect(summary.revision).toBe(before.summary.revision);
  expect(summary.canRedo).toBe(true); expect(summary.canUndo).toBe(true); expect(summary.selected).toBe(before.summary.selected);
  expect(base).toEqual(before.base); expect(active.replies.findLast(reply => reply.masks)!.masks).toEqual(before.masks);
  await wake(page); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.second)).toBe(true);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  await grade(page, '1.1'); expect((await exportBytes(page)).equals(before.first)).toBe(false);
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(page).toHaveTitle(`\u2022 initialization-sh3.ply \u2014 SplatView`);
}
