import { expect, test, type APIRequestContext, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BuildDescriptor, RuntimeManifest } from '../../src/build/contracts';
import type { CohortMetadata } from '../../src/offline/cohortStore';
import type { OfflineReply, OfflineRequest } from '../../src/offline/protocol';
import { offlineHost, type OfflineScope } from './host';
import { exportBytes, grade, observeWorkers, retired, sceneFile, wake, workers } from '../production/initialization-helpers';

const origin = process.env.SPLATVIEW_OFFLINE_TEST_ORIGIN ?? 'http://127.0.0.1:5373';
const receiptPath = resolve(process.env.SPLATVIEW_OFFLINE_FIXTURE_RECEIPT ?? '.build/offline-tests/fixtures-04/fixture-set.json');
type Cohort = 'A' | 'B' | 'C';
type FileRecord = { path: string; bytes: number; sha256: string };
interface Fixture {
  root: string; dist: string; deploymentId: string; build: BuildDescriptor; manifest: FileRecord;
  variant: string; inputs: unknown; inventory: unknown;
  patches: { sourcePath: string; path: string; before: Omit<FileRecord, 'path'>; after: Omit<FileRecord, 'path'> }[];
  sourceDifferences: { path: string; before: Omit<FileRecord, 'path'>; after: Omit<FileRecord, 'path'> }[];
  nativePublication: (FileRecord & { name: string })[]; serviceWorker: { sha256: string };
}
interface FixtureSet {
  schemaVersion: 1; kind: string; fixtureSetId: string; fixtures: Record<Cohort, Fixture>;
  sourceCapture: unknown; shippingNativePublication: unknown;
  routerRelationships: { sha256: Record<Cohort, string>; aAndBIdentical: boolean; cDiffersFromAAndB: boolean; perApplicationIdentityEmbedded: boolean };
}
interface OfflineObservation { message: OfflineRequest; reply?: OfflineReply; page: string }
interface OfflineMonitor { sent: OfflineObservation[]; notifications: unknown[] }
declare global { interface Window {
  __offlineMonitor: OfflineMonitor;
  __offlineRouterUpdate?: { previous: ServiceWorker; transitions: { router: 'previous' | 'replacement'; state: ServiceWorkerState }[] };
} }
interface BrowserStorage {
  metadata: CohortMetadata | null;
  caches: { name: string; urls: string[] }[];
  databases: { name?: string; version?: number }[];
}
let fixtureSet: FixtureSet, fixtureBytes: Buffer;
const manifests = {} as Record<Cohort, RuntimeManifest>;
const dialogs = new WeakMap<Page, { type: string; message: string }[]>();
const dialogDismissals = new WeakMap<Page, Promise<void>[]>();
const verifiedHistoryCycles = new WeakMap<object, number>();
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const base = (scope: OfflineScope) => new URL(scope === 'root' ? '/' : '/project/', origin).href;
const prefix = (scope: OfflineScope) => `splatview-app-v1-${encodeURIComponent(base(scope))}-`;
const control = (request: APIRequestContext) => offlineHost(request, origin);

/** Observe genuine channels without replacing requests, replies or their delivery. */
async function observeOffline(page: Page) {
  await page.addInitScript(() => {
    const key = '__splatview_offline_test_transport';
    let prior: OfflineObservation[] = [];
    try { prior = JSON.parse(sessionStorage.getItem(key) ?? '[]') as OfflineObservation[]; } catch { /* A fresh tab has no observations. */ }
    const monitor: OfflineMonitor = { sent: prior, notifications: [] }; window.__offlineMonitor = monitor;
    const persist = () => { try { sessionStorage.setItem(key, JSON.stringify(monitor.sent)); } catch { /* Evidence remains in memory if test storage is full. */ } };
    const post = ServiceWorker.prototype.postMessage as (this: ServiceWorker, message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void;
    ServiceWorker.prototype.postMessage = function(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      if (message && typeof message === 'object' && (message as { protocol?: unknown }).protocol === 1) {
        monitor.sent.push({ message: structuredClone(message) as OfflineRequest, page: location.href }); persist();
      }
      return post.call(this, message, options);
    };
    const NativeChannel = window.MessageChannel;
    window.MessageChannel = class extends NativeChannel {
      constructor() {
        super();
        this.port1.addEventListener('message', event => {
          const value = event.data as Partial<OfflineReply>;
          if (value?.protocol !== 1 || typeof value.requestId !== 'string') return;
          const sent = monitor.sent.findLast(item => item.message.requestId === value.requestId && !item.reply);
          if (sent) { sent.reply = structuredClone(value) as OfflineReply; persist(); }
        });
        this.port1.start();
      }
    };
    navigator.serviceWorker.addEventListener('message', event => monitor.notifications.push(structuredClone(event.data)));
  });
}
async function prepare(page: Page) {
  const observed: { type: string; message: string }[] = []; dialogs.set(page, observed);
  const dismissed: Promise<void>[] = []; dialogDismissals.set(page, dismissed);
  page.on('dialog', dialog => {
    observed.push({ type: dialog.type(), message: dialog.message() });
    const done = dialog.dismiss(); dismissed.push(done); void done.catch(() => undefined);
  });
  await observeWorkers(page); await observeOffline(page);
}
async function settings(page: Page) {
  if (await page.getByRole('dialog', { name: 'Settings', exact: true }).isVisible()) return;
  await wake(page);
  if (!await page.getByRole('button', { name: 'Settings', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Settings', exact: true })).toBeVisible();
}
async function closeSettings(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close Settings', exact: true }).click();
}
const application = (page: Page) => page.getByRole('region', { name: 'Application', exact: true });
async function installed(page: Page) {
  await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await settings(page); await expect(application(page)).toContainText('Available offline');
  await expect(application(page).getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
  await closeSettings(page);
}
async function start(page: Page, scope: OfflineScope = 'root', controlled = true) {
  await page.goto(base(scope)); await installed(page);
  // Installation deliberately leaves the first online page uncontrolled.
  // A clean normal navigation admits its pin before its first asset request.
  if (controlled && !await page.evaluate(script => navigator.serviceWorker.controller?.scriptURL === script,
    new URL('service-worker.js', base(scope)).href)) { await page.reload(); await installed(page); }
}
async function pinnedManifest(page: Page, scope: OfflineScope) {
  return page.evaluate(async url => { const response = await fetch(url); return { status: response.status, url: response.url, manifest: await response.json() as RuntimeManifest }; }, new URL('build-manifest.json', base(scope)).href);
}
async function storage(page: Page, scope: OfflineScope): Promise<BrowserStorage> {
  return page.evaluate(async ({ prefix, name }) => {
    const databases = await indexedDB.databases();
    const metadata = databases.some(db => db.name === name) ? await new Promise<CohortMetadata | null>((yes, no) => {
      const request = indexedDB.open(name);
      request.onerror = () => no(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('metadata', 'readonly'), read = tx.objectStore('metadata').get('state');
        let result: CohortMetadata | null = null;
        read.onsuccess = () => { result = read.result as CohortMetadata | undefined ?? null; };
        tx.oncomplete = () => { db.close(); yes(result); }; tx.onerror = tx.onabort = () => { db.close(); no(tx.error); };
      };
    }) : null;
    const entries = [];
    for (const name of (await caches.keys()).filter(name => name.startsWith(prefix))) {
      const cache = await caches.open(name); entries.push({ name, urls: (await cache.keys()).map(request => request.url).sort() });
    }
    return { metadata, caches: entries.sort((a, b) => a.name.localeCompare(b.name)), databases };
  }, { prefix: prefix(scope), name: `${prefix(scope)}metadata` });
}
async function observe(page: Page) { return page.evaluate(() => window.__offlineMonitor); }
async function raw(page: Page, scope: OfflineScope, fields: Partial<OfflineRequest> & Pick<OfflineRequest, 'type'>, timeoutMs = 12_000): Promise<OfflineReply> {
  return page.evaluate(async ({ url, fields, timeoutMs }) => {
    const registration = await navigator.serviceWorker.getRegistration(url);
    if (!registration?.active) throw new Error('No genuine active offline worker');
    return new Promise<OfflineReply>((yes, no) => {
      const channel = new MessageChannel(), message = { protocol: 1, requestId: crypto.randomUUID(), ...fields };
      const timer = setTimeout(() => { channel.port1.close(); no(new Error(`Actual offline channel timed out: ${message.type}`)); }, timeoutMs);
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); yes(event.data as OfflineReply); };
      registration.active!.postMessage(message, [channel.port2]);
    });
  }, { url: base(scope), fields, timeoutMs });
}
async function pinOwner(page: Page) {
  const pin = (await observe(page)).sent.findLast(item => item.message.type === 'PIN' && item.reply?.ok);
  expect(pin).toBeDefined(); return { deploymentId: pin!.message.deploymentId!, sessionId: pin!.message.sessionId! };
}
async function assertBuild(page: Page, cohort: Cohort) {
  const actual = await workers(page); expect(actual.length).toBeGreaterThan(0);
  for (const worker of actual.filter(worker => worker.readyBuild)) expect(worker.readyBuild).toEqual(fixtureSet.fixtures[cohort].build);
  expect(actual.some(worker => worker.readyBuild && !worker.terminated)).toBe(true);
}
async function assertCache(page: Page, scope: OfflineScope, cohort: Cohort) {
  const state = await storage(page, scope), fixture = fixtureSet.fixtures[cohort], manifest = manifests[cohort];
  expect(manifest.artifacts).toHaveLength(97);
  const record = state.metadata?.cohorts[fixture.deploymentId]; expect(record).toBeDefined();
  const cache = state.caches.find(value => value.name === record!.cacheName); expect(cache).toBeDefined();
  const urls = [new URL('build-manifest.json', base(scope)).href, ...manifest.artifacts.map(artifact => new URL(artifact.path, base(scope)).href)].sort();
  expect(cache!.urls).toEqual(urls); expect(cache!.urls).toHaveLength(98);
  expect(cache!.urls.some(url => /\.(?:map|ply|spz|splat)(?:$|\?)/.test(url))).toBe(false);
  const actual = await page.evaluate(async ({ cacheName, urls }) => {
    const cache = await caches.open(cacheName), rows = [];
    for (const url of urls) {
      const response = await cache.match(url); if (!response) throw new Error('A listed cache entry disappeared');
      const bytes = await response.arrayBuffer(), digest = await crypto.subtle.digest('SHA-256', bytes);
      rows.push({ url, responseUrl: response.url, bytes: bytes.byteLength, sha256: Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('') });
    }
    return rows;
  }, { cacheName: cache!.name, urls });
  for (const row of actual) {
    expect(row.responseUrl).toBe(row.url);
    const artifact = manifest.artifacts.find(artifact => new URL(artifact.path, base(scope)).href === row.url);
    expect({ bytes: row.bytes, sha256: row.sha256 }).toEqual(artifact ? { bytes: artifact.bytes, sha256: artifact.sha256 } : { bytes: fixture.manifest.bytes, sha256: fixture.manifest.sha256 });
  }
  return { state, verifiedEntries: actual };
}
async function loadScene(page: Page) {
  await page.getByLabel('Open scene files').setInputFiles(sceneFile());
  await expect(page).toHaveTitle('initialization-sh3.ply — SplatView'); await wake(page);
  if (!await page.getByRole('complementary', { name: 'Tools', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect(page.locator('.model-stats')).toHaveText('0/3 splats | SH3');
}
async function edited(page: Page) {
  await loadScene(page); await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await grade(page, '1.3'); const first = await exportBytes(page);
  await grade(page, '1.7'); const second = await exportBytes(page); expect(second.equals(first)).toBe(false);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await exportBytes(page)).equals(first)).toBe(true);
  const active = (await workers(page)).find(worker => worker.posts.some(post => post.type === 'source-load'))!;
  const summary = active.replies.findLast(reply => reply.summary)!.summary!, masks = active.replies.findLast(reply => reply.masks)!.masks!;
  expect(summary.canRedo).toBe(true); expect(summary.selected).toBe(3); expect(masks).toEqual([1, 1, 1]);
  return { first, second, activeId: active.id, summary, masks, base: active.posts.findLast(post => post.base)!.base! };
}
async function retained(page: Page, before: Awaited<ReturnType<typeof edited>>) {
  // Only this helper's previously completed, independently checked Redo/Undo
  // cycles advance its expectation. Never adopt an arbitrary observed revision.
  // Native content returns to the same history entry; client counters advance
  // once per accepted transition while document/source/draft identities stay fixed.
  const cycles = verifiedHistoryCycles.get(before) ?? 0, revision = before.summary.revision + 2 * cycles;
  const base = { ...before.base, contentRevision: before.base.contentRevision + 2 * cycles,
    selectionRevision: before.base.selectionRevision + 2 * cycles };
  await closeSettings(page); await wake(page);
  await expect(page).toHaveTitle('• initialization-sh3.ply — SplatView');
  await expect(page.locator('.model-stats')).toHaveText('3/3 splats | SH3');
  await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  const active = (await workers(page)).find(worker => worker.id === before.activeId)!;
  expect(active.terminated).toBe(false); expect(active.replies.findLast(reply => reply.masks)!.masks).toEqual(before.masks);
  expect(active.replies.findLast(reply => reply.summary)!.summary).toMatchObject({ contentRevision: before.summary.contentRevision,
    revision, selected: 3, canUndo: true, canRedo: true });
  expect(active.posts.findLast(post => post.base)!.base).toEqual(base);
  await wake(page); await page.getByRole('button', { name: 'Redo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.second)).toBe(true);
  await wake(page); await page.getByRole('button', { name: 'Undo', exact: true }).click();
  expect((await exportBytes(page)).equals(before.first)).toBe(true);
  const restored = (await workers(page)).find(worker => worker.id === before.activeId)!;
  expect(restored.terminated).toBe(false); expect(restored.replies.findLast(reply => reply.masks)!.masks).toEqual(before.masks);
  expect(restored.replies.findLast(reply => reply.summary)!.summary).toMatchObject({ contentRevision: before.summary.contentRevision,
    revision: revision + 2, selected: 3, canUndo: true, canRedo: true });
  expect(restored.posts.findLast(post => post.base)!.base).toEqual({ ...base,
    contentRevision: base.contentRevision + 2, selectionRevision: base.selectionRevision + 2 });
  verifiedHistoryCycles.set(before, cycles + 1);
}
async function offer(page: Page, request: APIRequestContext, scope: OfflineScope, cohort: Cohort = 'B') {
  await control(request).select(scope, cohort); await settings(page);
  await application(page).getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(application(page).getByRole('button', { name: 'Reload to update', exact: true })).toBeEnabled();
  await expect(application(page).getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
}
async function requestUpdate(page: Page) {
  await settings(page); await application(page).getByRole('button', { name: 'Reload to update', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Unsaved changes', exact: true })).toBeVisible();
}
async function ticketDrop(context: BrowserContext, scope: OfflineScope) {
  const worker = context.serviceWorkers().find(worker => worker.url() === new URL('service-worker.js', base(scope)).href);
  expect(worker).toBeDefined();
  await worker!.evaluate(() => {
    const target = globalThis as typeof globalThis & { __offlineTicketDrop?: { dropped: unknown[]; remaining: number } };
    target.__offlineTicketDrop = { dropped: [], remaining: 1 };
    const original = MessagePort.prototype.postMessage as (this: MessagePort, message: unknown, options?: Transferable[] | StructuredSerializeOptions) => void;
    MessagePort.prototype.postMessage = function(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
      const value = message as { protocol?: unknown; ok?: unknown; ticket?: unknown };
      if (value?.protocol === 1 && value.ok === true && typeof value.ticket === 'string' && target.__offlineTicketDrop!.remaining > 0) {
        target.__offlineTicketDrop!.remaining--; target.__offlineTicketDrop!.dropped.push(structuredClone(message)); return;
      }
      return original.call(this, message, options);
    };
  });
  return worker!;
}
async function attach(testInfo: TestInfo, name: string, value: unknown) { await testInfo.attach(name, { body: Buffer.from(JSON.stringify(value, null, 2)), contentType: 'application/json' }); }
async function denyCohortNetwork(request: APIRequestContext, scope: OfflineScope, cohort: Cohort) {
  const paths = ['build-manifest.json', ...manifests[cohort].artifacts.map(artifact => artifact.path)];
  expect(new Set(paths).size).toBe(98);
  // Browser-owned registration updates can bypass renderer offline emulation.
  // The real host refuses every application response, including that script.
  return control(request).configure({ clearFaults: true,
    faults: paths.map(path => ({ scope, path, mode: '503' as const, times: 1000 })) });
}

test.beforeAll(async ({ request }) => {
  fixtureBytes = await readFile(receiptPath); fixtureSet = JSON.parse(fixtureBytes.toString('utf8')) as FixtureSet;
  expect(fixtureSet.schemaVersion).toBe(1); expect(fixtureSet.kind).toBe('genuine-offline-application-fixture-set');
  const state = await control(request).state();
  for (const cohort of ['A', 'B', 'C'] as const) {
    const fixture = fixtureSet.fixtures[cohort], raw = await readFile(resolve(fixture.manifest.path));
    expect({ bytes: raw.length, sha256: hash(raw) }).toEqual({ bytes: fixture.manifest.bytes, sha256: fixture.manifest.sha256 });
    manifests[cohort] = JSON.parse(raw.toString('utf8')) as RuntimeManifest;
    expect(manifests[cohort].deploymentId).toBe(fixture.deploymentId);
    expect(state.cohorts[cohort]).toMatchObject({ deploymentId: fixture.deploymentId, appInputId: fixture.build.appInputId,
      manifestSha256: fixture.manifest.sha256, serviceWorkerSha256: fixture.serviceWorker.sha256, runtimeArtifacts: 97, files: 101 });
    const expectedChanges = cohort === 'C' ? ['src/main.tsx', 'src/offline/cohortStore.ts'] : ['src/main.tsx'];
    expect(fixture.patches.map(patch => patch.sourcePath).sort()).toEqual(expectedChanges);
    expect(fixture.sourceDifferences.map(difference => difference.path).sort()).toEqual(expectedChanges);
    expect(fixture.variant).toBe(cohort === 'C' ? 'ui-and-compatible-offline-error-title' : 'ui-input');
    expect(fixture.nativePublication).toHaveLength(5);
    expect(fixture.nativePublication.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 }))).toEqual(
      fixtureSet.fixtures.A.nativePublication.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256 })));
  }
  expect(new Set(Object.values(fixtureSet.fixtures).map(fixture => fixture.deploymentId)).size).toBe(3);
  expect(new Set(Object.values(fixtureSet.fixtures).map(fixture => fixture.build.appInputId)).size).toBe(3);
  expect(fixtureSet.fixtures.A.serviceWorker.sha256).toBe(fixtureSet.fixtures.B.serviceWorker.sha256);
  expect(fixtureSet.fixtures.C.serviceWorker.sha256).not.toBe(fixtureSet.fixtures.A.serviceWorker.sha256);
  expect(fixtureSet.routerRelationships).toMatchObject({ aAndBIdentical: true, cDiffersFromAAndB: true, perApplicationIdentityEmbedded: false,
    sha256: Object.fromEntries((['A', 'B', 'C'] as const).map(cohort => [cohort, fixtureSet.fixtures[cohort].serviceWorker.sha256])) });
  expect(fixtureSet.fixtures.B.build.native).toEqual(fixtureSet.fixtures.A.build.native);
  expect(fixtureSet.fixtures.C.build.native).toEqual(fixtureSet.fixtures.A.build.native);
});
test.beforeEach(async ({ page, request }, testInfo) => {
  await control(request).configure({ resetCounters: true, clearFaults: true, select: { root: 'A', project: 'A' } });
  await prepare(page);
  await attach(testInfo, 'genuine-fixture-inputs', { receipt: { path: receiptPath, bytes: fixtureBytes.length, sha256: hash(fixtureBytes) },
    fixtureSetId: fixtureSet.fixtureSetId, qualification: 'Local Chromium browser acceptance; no deployed-host or Mac claim.',
    fixtures: fixtureSet.fixtures, routerRelationships: fixtureSet.routerRelationships,
    sourceCapture: fixtureSet.sourceCapture, shippingNativePublication: fixtureSet.shippingNativePublication });
});
test.afterEach(async ({ context, request }, testInfo) => {
  const pages = [];
  for (const page of context.pages()) {
    if (page.isClosed() || !page.url().startsWith(new URL(origin).origin)) continue;
    try { pages.push({ url: page.url(), dialogs: dialogs.get(page) ?? [], transport: await page.evaluate(() => window.__offlineMonitor ?? null),
      workers: await page.evaluate(() => window.__initializationMonitor?.workers ?? []),
      root: await storage(page, 'root'), project: await storage(page, 'project') }); }
    catch (error) { pages.push({ url: page.url(), evidenceError: String(error) }); }
  }
  await attach(testInfo, 'browser-ownership-and-cache-evidence', { pages, host: await control(request).state() });
  await control(request).clearFaults();
});

for (const scope of ['root', 'project'] as const) {
  test(`${scope}: installs only 98 verified application URLs and cold-starts offline with genuine native edits`, async ({ page, context, request }, testInfo) => {
    expect((await page.goto(new URL('first-visit-storage.html', base(scope)).href))!.status()).toBe(404);
    expect((await storage(page, scope)).caches).toEqual([]);
    await start(page, scope, false); await assertBuild(page, 'A');
    await attach(testInfo, 'first-complete-cache', { ...await assertCache(page, scope, 'A'), workers: await workers(page), transport: await observe(page) });
    const denied = await denyCohortNetwork(request, scope, 'A');
    expect(denied.counters.some(row => row.scope === scope && row.artifactPath === 'build-manifest.json' && row.completed)).toBe(true);
    await page.close(); await context.setOffline(true);
    const cold = await context.newPage(); await prepare(cold); await cold.goto(base(scope)); await installed(cold);
    expect((await pinnedManifest(cold, scope)).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
    await assertBuild(cold, 'A'); const before = await edited(cold); await retained(cold, before);
    await attach(testInfo, 'cold-native-history', { before: { ...before, first: hash(before.first), second: hash(before.second) }, cache: await assertCache(cold, scope, 'A') });
    const after = await control(request).state();
    expect(after.counterGeneration).toBe(denied.counterGeneration);
    expect(after.counters.filter(row => row.id <= denied.sequence).map(row => row.id)).toEqual(denied.counters.map(row => row.id));
    const offlineRequests = after.counters.filter(row => row.id > denied.sequence);
    const scriptFault = denied.faults.find(fault => fault.scope === scope && fault.path === 'service-worker.js')!;
    for (const row of offlineRequests) expect(row).toMatchObject({ method: 'GET', scope, artifactPath: 'service-worker.js',
      status: 503, fault: '503', faultId: scriptFault.id, servedArtifact: false, completed: true });
    for (const fault of denied.faults) expect(after.faults.find(value => value.id === fault.id)?.remaining).toBe(
      fault.remaining - (fault.id === scriptFault.id ? offlineRequests.length : 0));
    await attach(testInfo, 'offline-host-refusals-and-browser-owned-update-attempts', { denied, after,
      offlineRequests, browserOwnedScriptAttempts: offlineRequests.length, rendererRuntimeFallbackSuccesses: 0 });
  });
  test(`${scope}: A and B tabs retain separate runtime pins and independent native Redo while the host changes`, async ({ page, context, request }, testInfo) => {
    await start(page, scope); const a = await edited(page); await offer(page, request, scope); await closeSettings(page);
    const second = await context.newPage(); await prepare(second); await start(second, scope); const b = await edited(second);
    expect((await pinnedManifest(page, scope)).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
    expect((await pinnedManifest(second, scope)).manifest.deploymentId).toBe(fixtureSet.fixtures.B.deploymentId);
    await assertBuild(page, 'A'); await assertBuild(second, 'B');
    await retained(page, a); await retained(second, b);
    await attach(testInfo, 'isolated-native-documents', { A: { ...a, first: hash(a.first), second: hash(a.second) }, B: { ...b, first: hash(b.first), second: hash(b.second) },
      ACache: await assertCache(page, scope, 'A'), BCache: await assertCache(second, scope, 'B') });
  });
}

test('A first-visit uncontrolled tab rebinds to a naturally activated C router while its native document stays A until explicit update', async ({ page, request }, testInfo) => {
  await start(page, 'root', false);
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  const before = await edited(page), originalOwner = await pinOwner(page), originalWorkers = await workers(page);
  await control(request).select('root', 'C');
  // This is the browser's ordinary update/activation algorithm. The test does
  // not claim the page, skip waiting, replace its client or inject router bytes.
  await page.evaluate(async url => {
    const registration = await navigator.serviceWorker.getRegistration(url), previous = registration?.active;
    if (!registration || !previous || previous.state !== 'activated' || navigator.serviceWorker.controller)
      throw new Error('The first-visit A tab must still be uncontrolled with its original active router');
    const transitions: NonNullable<Window['__offlineRouterUpdate']>['transitions'] = [{ router: 'previous', state: previous.state }];
    window.__offlineRouterUpdate = { previous, transitions };
    previous.addEventListener('statechange', () => transitions.push({ router: 'previous', state: previous.state }));
    registration.addEventListener('updatefound', () => {
      const replacement = registration.installing; if (!replacement) return;
      transitions.push({ router: 'replacement', state: replacement.state });
      replacement.addEventListener('statechange', () => transitions.push({ router: 'replacement', state: replacement.state }));
    });
    await registration.update();
  }, base('root'));
  await expect.poll(async () => page.evaluate(async url => {
    const registration = await navigator.serviceWorker.getRegistration(url), previous = window.__offlineRouterUpdate?.previous;
    return { previous: previous?.state, replacement: registration?.active?.state,
      changed: !!previous && registration?.active !== previous, controlled: !!navigator.serviceWorker.controller };
  }, base('root'))).toEqual({ previous: 'redundant', replacement: 'activated', changed: true, controlled: false });
  const lifecycle = await page.evaluate(() => ({ transitions: window.__offlineRouterUpdate!.transitions,
    previous: window.__offlineRouterUpdate!.previous.state, controller: navigator.serviceWorker.controller?.scriptURL ?? null }));
  expect(lifecycle.transitions).toContainEqual({ router: 'replacement', state: 'activated' });
  expect(lifecycle.transitions).toContainEqual({ router: 'previous', state: 'redundant' });
  const routerBytes = await page.evaluate(async url => {
    const response = await fetch(url, { cache: 'no-store' }), bytes = await response.arrayBuffer();
    return { status: response.status, url: response.url, bytes: bytes.byteLength,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('') };
  }, new URL('service-worker.js', base('root')).href);
  expect(routerBytes).toMatchObject({ status: 200, sha256: fixtureSet.fixtures.C.serviceWorker.sha256 });
  expect((await control(request).state()).counters.some(row => row.cohort === 'C' && row.artifactPath === 'service-worker.js' && row.servedArtifact)).toBe(true);

  await settings(page); await application(page).getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(application(page).getByRole('button', { name: 'Reload to update', exact: true })).toBeEnabled();
  await expect(application(page).getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
  const rebound = (await observe(page)).sent.filter(item => item.message.type === 'PIN' && item.reply?.ok);
  expect(rebound.length).toBeGreaterThanOrEqual(2);
  for (const pin of rebound) expect(pin.message).toMatchObject(originalOwner);
  expect(rebound.at(-1)!.reply).toMatchObject({ ok: true, status: { current: fixtureSet.fixtures.A.deploymentId, ready: true } });
  const cache = await storage(page, 'root');
  expect(cache.metadata!.preferred).toBe(fixtureSet.fixtures.C.deploymentId);
  expect(Object.values(cache.metadata!.pins)).toContainEqual(expect.objectContaining({ deploymentId: originalOwner.deploymentId,
    sessionId: originalOwner.sessionId, offered: fixtureSet.fixtures.C.deploymentId }));
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
  expect((await workers(page)).map(worker => ({ id: worker.id, terminated: worker.terminated, readyBuild: worker.readyBuild }))).toEqual(
    originalWorkers.map(worker => ({ id: worker.id, terminated: worker.terminated, readyBuild: worker.readyBuild })));
  await assertBuild(page, 'A'); await retained(page, before);
  await attach(testInfo, 'natural-router-update-retains-uncontrolled-native-owner', { originalOwner, lifecycle, routerBytes,
    rebound, cache, workers: await workers(page), history: { ...before, first: hash(before.first), second: hash(before.second) } });

  await requestUpdate(page); await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Stay', exact: true }).click();
  await retained(page, before); await assertBuild(page, 'A');
  await requestUpdate(page); await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled(); await installed(page); await assertBuild(page, 'C');
  expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.C.deploymentId);
  expect(dialogs.get(page)).toEqual([]);
});

test('Root A and project B scopes coexist with separate metadata, caches and native history', async ({ page, context, request }, testInfo) => {
  await start(page, 'root'); const root = await edited(page);
  await control(request).select('project', 'B');
  const project = await context.newPage(); await prepare(project); await start(project, 'project'); const nested = await edited(project);
  expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
  expect((await pinnedManifest(project, 'project')).manifest.deploymentId).toBe(fixtureSet.fixtures.B.deploymentId);
  await assertBuild(page, 'A'); await assertBuild(project, 'B'); await retained(page, root); await retained(project, nested);
  await offer(page, request, 'root', 'C'); await closeSettings(page);
  const rootCache = await assertCache(page, 'root', 'A'), projectCache = await assertCache(project, 'project', 'B');
  expect(rootCache.state.caches.every(cache => cache.name.startsWith(prefix('root')))).toBe(true);
  expect(projectCache.state.caches.every(cache => cache.name.startsWith(prefix('project')))).toBe(true);
  expect(projectCache.state.metadata!.preferred).toBe(fixtureSet.fixtures.B.deploymentId);
  await attach(testInfo, 'simultaneous-root-project-owners', { root: rootCache, project: projectCache });
});

test('Update and Stay retains A masks, exact exports and executable Redo without minting a reload ticket', async ({ page, context, request }) => {
  await start(page); const before = await edited(page); await offer(page, request, 'root'); await requestUpdate(page);
  expect((await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION')).toEqual([]);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Stay', exact: true }).click();
  await retained(page, before); expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
  expect(Object.keys((await storage(page, 'root')).metadata!.tickets)).toEqual([]);
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send('Page.enable'); await cdp.send('Page.reload');
    await expect.poll(() => dialogs.get(page)?.length).toBe(1);
    await dialogDismissals.get(page)![0];
  } finally { try { await cdp.send('Page.disable'); } finally { await cdp.detach(); } }
  expect(dialogs.get(page)?.map(dialog => dialog.type)).toEqual(['beforeunload']);
  await retained(page, before);
});

test('Update and Discard navigates to coherent B only after the explicit dirty decision', async ({ page, request }) => {
  await start(page); await edited(page); await offer(page, request, 'root'); await requestUpdate(page);
  expect((await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION')).toEqual([]);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled(); await installed(page);
  expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.B.deploymentId); await assertBuild(page, 'B');
  const prepared = (await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION');
  expect(prepared).toHaveLength(1); expect(prepared[0].reply).toMatchObject({ ok: true, requestId: prepared[0].message.requestId });
  expect(page.url()).toBe(base('root'));
  expect(dialogs.get(page)).toEqual([]);
});

test('Update Save waits for a matching whole-scene download acknowledgement before preparing or navigating', async ({ page, request }, testInfo) => {
  await start(page); const before = await edited(page); await offer(page, request, 'root'); await requestUpdate(page);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Save', exact: true }).click();
  const download = await downloadEvent, saved = await readFile((await download.path())!);
  expect(saved.equals(before.first)).toBe(true); await expect(page.getByRole('button', { name: 'I have kept the file', exact: true })).toBeVisible();
  expect((await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION')).toEqual([]);
  expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled(); await installed(page);
  await assertBuild(page, 'B'); expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.B.deploymentId);
  expect(dialogs.get(page)).toEqual([]);
  await attach(testInfo, 'acknowledged-whole-scene-output', { bytes: saved.length, sha256: hash(saved), expectedSha256: hash(before.first),
    prepares: (await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION') });
});

test('Acknowledging Selected output preserves dirty state and still requires an update decision', async ({ page, request }, testInfo) => {
  await start(page); const before = await edited(page); await wake(page);
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const save = page.getByRole('dialog', { name: 'Save scene', exact: true }); await save.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await save.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloading, bytes = await readFile((await download.path())!);
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click();
  await expect(page).toHaveTitle('• initialization-sh3.ply — SplatView'); await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeEnabled();
  await offer(page, request, 'root'); await requestUpdate(page);
  expect((await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION')).toEqual([]);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Stay', exact: true }).click();
  await retained(page, before); await attach(testInfo, 'selected-output-is-not-whole-scene-consent', { scope: 1, bytes: bytes.length, sha256: hash(bytes) });
});

for (const mode of ['truncate', 'disconnect', 'corrupt'] as const) {
  test(`A stays complete and editable after a ${mode} B application download`, async ({ page, request }, testInfo) => {
    await start(page); const before = await edited(page), host = control(request);
    await host.select('root', 'B');
    const failedPath = manifests.B.artifacts.find(artifact => artifact.role === 'core-wasm')!.path;
    await host.fault({ scope: 'root', path: failedPath, mode, times: 1, ...(mode === 'disconnect' ? { bytes: 1024 } : {}) });
    await settings(page); await application(page).getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(application(page)).toContainText('Could not check for updates. Try again when connected.');
    await expect(application(page).getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
    expect((await storage(page, 'root')).metadata!.cohorts[fixtureSet.fixtures.B.deploymentId]).toBeUndefined();
    expect((await storage(page, 'root')).caches).toHaveLength(1); await assertCache(page, 'root', 'A');
    expect((await host.state()).counters.some(row => row.fault === mode && row.artifactPath === failedPath)).toBe(true);
    await retained(page, before); await attach(testInfo, 'failed-install-preserves-complete-cohort', { mode, cache: await storage(page, 'root') });
  });
}

test('A real Chromium storage quota refusal does not publish B or damage A history', async ({ page, context, request }, testInfo) => {
  await start(page); const before = await edited(page), cdp = await context.newCDPSession(page);
  // Primary API: https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin
  const usage = await cdp.send('Storage.getUsageAndQuota', { origin: new URL(origin).origin });
  const quota = usage.usage + 65_536; await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin, quotaSize: quota });
  try {
    await control(request).select('root', 'B'); await settings(page);
    await application(page).getByRole('button', { name: 'Check for updates', exact: true }).click();
    await expect(application(page)).toContainText('Could not check for updates. Try again when connected.');
    expect((await storage(page, 'root')).metadata!.cohorts[fixtureSet.fixtures.B.deploymentId]).toBeUndefined();
    const quotaReply = (await observe(page)).sent.findLast(item => item.message.type === 'CHECK_UPDATE')!.reply;
    expect(quotaReply).toMatchObject({ ok: false, error: expect.stringMatching(/quota/i) });
    await attach(testInfo, 'actual-origin-quota-refusal', { before: usage, quotaSize: quota,
      after: await cdp.send('Storage.getUsageAndQuota', { origin: new URL(origin).origin }), cache: await storage(page, 'root') });
  } finally { await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(origin).origin }); await cdp.detach(); }
  await assertCache(page, 'root', 'A'); await retained(page, before);
});

test('An evicted native entry produces actionable offline 503 and an online retry repairs a coherent cohort', async ({ page, context, request }, testInfo) => {
  await start(page); const accepted = await storage(page, 'root'), record = accepted.metadata!.cohorts[fixtureSet.fixtures.A.deploymentId];
  const nativeUrl = new URL(manifests.A.artifacts.find(artifact => artifact.role === 'core-wasm')!.path, base('root')).href;
  expect(await page.evaluate(async ({ cacheName, url }) => (await caches.open(cacheName)).delete(url), { cacheName: record.cacheName, url: nativeUrl })).toBe(true);
  const denied = await denyCohortNetwork(request, 'root', 'A');
  await page.close(); await context.setOffline(true);
  const cold = await context.newPage(); await prepare(cold); const response = await cold.goto(base('root'));
  expect(response!.status()).toBe(503); await expect(cold.getByRole('heading', { name: 'SplatView is unavailable offline', exact: true })).toBeVisible();
  await expect(cold.getByRole('link', { name: 'Retry SplatView', exact: true })).toBeVisible();
  expect(await cold.evaluate(() => window.__initializationMonitor.workers)).toEqual([]);
  await attach(testInfo, 'eviction-refusal', { status: response!.status(), nativeUrl, cache: await storage(cold, 'root'),
    denied, hostAfterColdRefusal: await control(request).state() });
  await control(request).clearFaults(); await context.setOffline(false); await control(request).select('root', 'B');
  await cold.getByRole('link', { name: 'Retry SplatView', exact: true }).click(); await installed(cold); await assertBuild(cold, 'B');
  expect((await pinnedManifest(cold, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.B.deploymentId); await assertCache(cold, 'root', 'B');
});

test('Stopping and restarting the actual router restores client pins and retires interrupted staging after reconciliation', async ({ page, context, request }, testInfo) => {
  await start(page); const before = await edited(page), host = control(request), owner = await pinOwner(page);
  await host.select('root', 'B'); const entry = manifests.B.artifacts.find(artifact => artifact.role === 'application-entry')!.path;
  await host.fault({ scope: 'root', path: entry, mode: 'delay', times: 1, delayMs: 30_000 });
  const interrupted = raw(page, 'root', { type: 'CHECK_UPDATE', requestId: 'interrupted-router-install' }, 5000).catch(error => String(error));
  await expect.poll(async () => (await host.state()).counters.some(row => row.artifactPath === entry && row.fault === 'delay' && !row.completed)).toBe(true);
  await expect.poll(async () => (await storage(page, 'root')).caches.length).toBe(2);
  const stagedState = await storage(page, 'root');
  const staged = stagedState.caches.find(cache => cache.name !== stagedState.metadata!.cohorts[fixtureSet.fixtures.A.deploymentId].cacheName)!;
  const cdp = await context.newCDPSession(page);
  // Primary API: https://chromedevtools.github.io/devtools-protocol/tot/ServiceWorker/#method-stopAllWorkers
  try { await cdp.send('ServiceWorker.enable'); await cdp.send('ServiceWorker.stopAllWorkers'); }
  finally { try { await cdp.send('ServiceWorker.disable'); } finally { await cdp.detach(); } }
  await interrupted; await host.clearFaults();
  expect((await storage(page, 'root')).metadata!.cohorts[fixtureSet.fixtures.B.deploymentId]).toBeUndefined();
  const reply = await raw(page, 'root', { type: 'PIN', ...owner }); expect(reply.ok).toBe(true);
  await expect.poll(async () => (await storage(page, 'root')).caches.map(cache => cache.name)).not.toContain(staged.name);
  expect((await observe(page)).notifications.some(value => (value as { type?: unknown }).type === 'RECONCILE')).toBe(true);
  await retained(page, before); await attach(testInfo, 'router-restart-ownership', { interruptedCache: staged.name, reply, storage: await storage(page, 'root') });
});

test('An unknown in-scope browser client defers every cache deletion until it closes', async ({ page, context, request }, testInfo) => {
  await start(page); await offer(page, request, 'root'); await closeSettings(page);
  const current = await context.newPage(); await prepare(current); await start(current);
  const unknown = await context.newPage(); expect((await unknown.goto(new URL('unresponsive-client.html', base('root')).href))!.status()).toBe(404);
  const orphan = `${prefix('root')}interrupted-orphan`;
  await current.evaluate(async name => { const cache = await caches.open(name); await cache.put(new URL('staging-sentinel', location.href), new Response('interrupted application stage')); }, orphan);
  await page.close(); await offer(current, request, 'root', 'C');
  await expect.poll(async () => (await storage(current, 'root')).metadata!.preferred).toBe(fixtureSet.fixtures.C.deploymentId);
  await expect.poll(async () => (await observe(current)).notifications.filter(value => (value as { type?: unknown }).type === 'RECONCILE').length).toBeGreaterThan(0);
  // A full ownership round takes 1.5s. STATUS does not schedule another round.
  await current.waitForTimeout(2000);
  const deferred = await storage(current, 'root');
  expect(deferred.metadata!.cohorts[fixtureSet.fixtures.A.deploymentId]).toBeDefined();
  expect(deferred.caches.some(cache => cache.name === orphan)).toBe(true);
  await attach(testInfo, 'unknown-client-retains-complete-and-orphan-caches', { unknown: unknown.url(), storage: await storage(current, 'root') });
  await unknown.close(); await application(current).getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect.poll(async () => (await storage(current, 'root')).metadata!.cohorts[fixtureSet.fixtures.A.deploymentId]).toBeUndefined();
  await expect.poll(async () => (await storage(current, 'root')).caches.some(cache => cache.name === orphan)).toBe(false);
  await assertCache(current, 'root', 'B'); await assertCache(current, 'root', 'C');
});

test('An explicit check repairs evicted metadata with the same live A owner and offers B without replacing its native document', async ({ page, context, request }, testInfo) => {
  await start(page); const before = await edited(page), owner = await pinOwner(page), originalWorkers = await workers(page);
  const originalCache = await assertCache(page, 'root', 'A');
  const cacheName = originalCache.state.metadata!.cohorts[fixtureSet.fixtures.A.deploymentId].cacheName;
  const unknown = await context.newPage();
  expect((await unknown.goto(new URL('metadata-reset-unknown-client.html', base('root')).href))!.status()).toBe(404);
  await control(request).select('root', 'B');
  // Delete the actual single IDB metadata record, retaining CacheStorage and
  // every native/GPU owner. No response, outcome or storage API is mocked.
  await page.evaluate(name => new Promise<void>((yes, no) => {
    const request = indexedDB.open(name);
    request.onerror = () => no(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('metadata', 'readwrite');
      tx.objectStore('metadata').delete('state');
      tx.oncomplete = () => { db.close(); yes(); }; tx.onerror = tx.onabort = () => { db.close(); no(tx.error); };
    };
  }), `${prefix('root')}metadata`);
  const reset = await storage(page, 'root');
  expect(Object.keys(reset.metadata?.pins ?? {})).toEqual([]); expect(Object.keys(reset.metadata?.cohorts ?? {})).toEqual([]);
  expect(reset.caches).toEqual(originalCache.state.caches);
  const absent = await raw(page, 'root', { type: 'STATUS' });
  expect(absent).toMatchObject({ ok: true, status: { current: null, ready: false, available: null } });
  const firstRepairMessage = (await observe(page)).sent.length;
  await settings(page); await application(page).getByRole('button', { name: 'Check for updates', exact: true }).click();
  await expect(application(page).getByRole('button', { name: 'Reload to update', exact: true })).toBeEnabled();
  await expect(application(page).getByRole('button', { name: 'Check for updates', exact: true })).toBeEnabled();
  // A's unindexed cache cannot be claimed ready merely because its bytes still
  // exist. The exact A document survives while the newer complete B is offered.
  await expect(application(page)).toContainText('Offline use unavailable');
  const repair = (await observe(page)).sent.slice(firstRepairMessage);
  const statusIndex = repair.findIndex(item => item.message.type === 'STATUS' && item.reply?.ok && item.reply.status.current === null);
  const pinIndex = repair.findIndex(item => item.message.type === 'PIN');
  const updateIndex = repair.findIndex(item => item.message.type === 'CHECK_UPDATE');
  expect(statusIndex).toBeGreaterThanOrEqual(0); expect(pinIndex).toBeGreaterThan(statusIndex); expect(updateIndex).toBeGreaterThan(pinIndex);
  expect(repair[pinIndex].message).toMatchObject({ type: 'PIN', ...owner });
  expect(repair[pinIndex].reply).toMatchObject({ ok: true, status: { current: fixtureSet.fixtures.A.deploymentId } });
  expect(repair[updateIndex].reply).toMatchObject({ ok: true,
    status: { current: fixtureSet.fixtures.A.deploymentId, ready: false, available: fixtureSet.fixtures.B.deploymentId } });
  expect(repair.filter(item => item.message.type === 'PREPARE_NAVIGATION')).toEqual([]);
  expect((await workers(page)).map(worker => ({ id: worker.id, terminated: worker.terminated, readyBuild: worker.readyBuild }))).toEqual(
    originalWorkers.map(worker => ({ id: worker.id, terminated: worker.terminated, readyBuild: worker.readyBuild })));
  await assertBuild(page, 'A'); await retained(page, before);
  // Cross the real reconciliation grace period with an unresponsive browser
  // client present: physical caches whose metadata was lost must be retained.
  await page.waitForTimeout(2000);
  const retainedCache = await storage(page, 'root');
  expect(retainedCache.metadata!.cohorts[fixtureSet.fixtures.A.deploymentId]).toBeUndefined();
  expect(retainedCache.caches.find(cache => cache.name === cacheName)).toEqual(originalCache.state.caches.find(cache => cache.name === cacheName));
  expect(Object.values(retainedCache.metadata!.pins)).toContainEqual(expect.objectContaining({ ...owner, offered: fixtureSet.fixtures.B.deploymentId }));
  await assertCache(page, 'root', 'B'); expect(dialogs.get(page)).toEqual([]);
  await attach(testInfo, 'metadata-eviction-and-explicit-owner-repair', { originalOwner: owner, originalCache,
    reset, absent, repair, unknownClient: unknown.url(), retainedCache,
    history: { ...before, first: hash(before.first), second: hash(before.second) }, workers: await workers(page) });
});

test('Durable PREPARE acknowledgement survives a lost reply, duplicates, cancellation and one-use navigation', async ({ page, context, request }, testInfo) => {
  await start(page); await offer(page, request, 'root'); await closeSettings(page);
  const owner = await pinOwner(page), drop = await ticketDrop(context, 'root');
  const prepareRequest = { type: 'PREPARE_NAVIGATION' as const, requestId: 'durable-prepare-lost-reply', deploymentId: fixtureSet.fixtures.B.deploymentId, sessionId: owner.sessionId };
  await expect(raw(page, 'root', prepareRequest, 2500)).rejects.toThrow('Actual offline channel timed out');
  const durable = await storage(page, 'root'), entry = Object.entries(durable.metadata!.tickets).find(([, ticket]) => ticket.requestId === prepareRequest.requestId)!;
  expect(entry[1]).toMatchObject({ disposition: 'unused', deploymentId: fixtureSet.fixtures.B.deploymentId });
  const repeated = await raw(page, 'root', prepareRequest); expect(repeated).toMatchObject({ ok: true, ticket: entry[0], requestId: prepareRequest.requestId });
  expect(Object.values((await storage(page, 'root')).metadata!.tickets).filter(ticket => ticket.requestId === prepareRequest.requestId)).toHaveLength(1);
  expect((await raw(page, 'root', { type: 'CANCEL_NAVIGATION', ticket: entry[0] })).ok).toBe(true);
  expect((await raw(page, 'root', prepareRequest)).ok).toBe(false);
  const next = await raw(page, 'root', { ...prepareRequest, requestId: 'durable-prepare-consumed' }); expect(next.ok).toBe(true);
  const ticket = next.ok ? next.ticket! : ''; expect(ticket).not.toBe(entry[0]);
  await attach(testInfo, 'durable-transport-and-tickets', { durable, duplicate: repeated, next,
    dropped: await drop.evaluate(() => (globalThis as typeof globalThis & { __offlineTicketDrop?: unknown }).__offlineTicketDrop) });
  const address = new URL(base('root')); address.searchParams.set('__splatview_update', ticket);
  expect((await page.goto(address.href))!.status()).toBe(200); await installed(page); await assertBuild(page, 'B');
  const reuse = await context.newPage(); await prepare(reuse); expect((await reuse.goto(address.href))!.status()).toBe(503);
  await expect(reuse.getByRole('heading', { name: 'SplatView is unavailable offline', exact: true })).toBeVisible();
});

test('An actual lost UI PREPARE reply times out safely and explicit retry reuses the same logical request', async ({ page, context, request }, testInfo) => {
  test.setTimeout(160_000);
  await start(page); const before = await edited(page); await offer(page, request, 'root'); await ticketDrop(context, 'root'); await requestUpdate(page);
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(async () => (await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION').length).toBe(1);
  const first = (await observe(page)).sent.findLast(item => item.message.type === 'PREPARE_NAVIGATION')!.message;
  await expect(page.getByRole('alert').filter({ hasText: 'The update could not be opened. Your current scene is still available.' })).toBeVisible({ timeout: 75_000 });
  await retained(page, before); expect((await pinnedManifest(page, 'root')).manifest.deploymentId).toBe(fixtureSet.fixtures.A.deploymentId);
  await attach(testInfo, 'lost-ui-ack-retained-document', { request: first, storage: await storage(page, 'root'), workers: await workers(page) });
  await settings(page); await application(page).getByRole('button', { name: 'Reload to update', exact: true }).click();
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Choose a scene file', exact: true })).toBeEnabled(); await installed(page); await assertBuild(page, 'B');
  const requests = (await observe(page)).sent.filter(item => item.message.type === 'PREPARE_NAVIGATION');
  expect(requests).toHaveLength(2); expect(requests.map(item => item.message.requestId)).toEqual([first.requestId, first.requestId]);
  expect(dialogs.get(page)).toEqual([]);
});

test('A cancels and retires its genuine candidate worker after B is offered without fetching foreign runtime bytes', async ({ page, request }, testInfo) => {
  await start(page); const before = await edited(page); await offer(page, request, 'root'); await closeSettings(page); await control(request).reset();
  await page.evaluate(() => { window.__initializationMonitor.holdNextReady = true; });
  await page.getByLabel('Open scene files').setInputFiles(sceneFile('cancelled-candidate.ply'));
  await page.getByRole('dialog', { name: 'Unsaved changes', exact: true }).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(async () => (await workers(page)).findLast(worker => worker.heldReady)?.id).toBeDefined();
  const candidate = (await workers(page)).findLast(worker => worker.heldReady)!;
  expect(candidate.readyBuild).toEqual(fixtureSet.fixtures.A.build);
  await page.locator('.status.panel').getByRole('button', { name: 'Cancel', exact: true }).click(); await retired(page, candidate.id);
  await retained(page, before); await assertBuild(page, 'A');
  const counters = (await control(request).state()).counters;
  expect(counters.filter(row => row.servedArtifact)).toEqual([]);
  await attach(testInfo, 'candidate-retirement-and-fetch-counts', { candidate: (await workers(page)).find(worker => worker.id === candidate.id), counters });
});
