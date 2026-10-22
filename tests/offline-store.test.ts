import { describe, expect, it } from 'vitest';
import { SINGLETON_ROLES, type BuildDescriptor, type RuntimeManifest } from '../src/build/contracts';
import { canonicalJson, sha256 } from '../src/build/verification';
import { CohortStore, normalizeOfflineBase, offlineStoragePrefix, offlineUnavailable, type CohortMetadata, type MetadataStore } from '../src/offline/cohortStore';
import { UPDATE_QUERY } from '../src/offline/protocol';

function responseAt(body: BodyInit, url: string, headers?: HeadersInit): Response {
  const response = new Response(body, { headers });
  return withUrl(response, url);
}
function withUrl(response: Response, url: string): Response {
  const clone = response.clone.bind(response);
  Object.defineProperty(response, 'url', { value: url });
  Object.defineProperty(response, 'clone', { value: () => withUrl(clone(), url) });
  return response;
}
class MemoryCaches {
  readonly data = new Map<string, Map<string, Response>>();
  failPut = false;
  async keys() { return [...this.data.keys()]; }
  async delete(name: string) { return this.data.delete(name); }
  async open(name: string): Promise<Cache> {
    let rows = this.data.get(name); if (!rows) { rows = new Map(); this.data.set(name, rows); }
    const records = rows;
    return {
      match: async (request: RequestInfo | URL) => records.get(String(request instanceof Request ? request.url : request))?.clone(),
      put: async (request: RequestInfo | URL, response: Response) => {
        if (this.failPut) throw new DOMException('Storage quota exceeded', 'QuotaExceededError');
        records.set(String(request instanceof Request ? request.url : request), withUrl(new Response(await response.arrayBuffer(), { headers: response.headers }), response.url));
      },
      keys: async () => [...records.keys()].map(url => new Request(url)),
    } as unknown as Cache;
  }
}
function memoryMetadata(): MetadataStore {
  let state: CohortMetadata = { schemaVersion: 1, preferred: null, cohorts: {}, pins: {}, tickets: {} };
  let queue: Promise<unknown> = Promise.resolve();
  return {
    read: async () => structuredClone(state),
    update: <T>(change: (metadata: CohortMetadata) => T) => {
      const next = queue.then(() => {
        const candidate = structuredClone(state), result = change(candidate); state = candidate; return result;
      });
      queue = next.then(() => undefined, () => undefined); return next;
    },
  };
}
interface Deployment { manifest: RuntimeManifest; responses: Map<string, string>; base: string }
async function deployment(label: string, base = 'https://example.test/project/'): Promise<Deployment> {
  const inputId = await sha256(new TextEncoder().encode(label));
  const build: BuildDescriptor = { schemaVersion: 1, appInputId: inputId, protocolVersion: 23, uiWorkerContract: 19,
    native: {
      core: { schemaVersion: 1, kind: 'core', abi: 17, variant: 'scalar', nativeInputId: inputId, mapLayoutVersion: 1, capabilities: { transactionReceipt: 1 } },
      camera: { schemaVersion: 1, kind: 'camera', abi: 4, variant: 'scalar', nativeInputId: inputId, capabilities: { cameraInput: 1 } },
    } };
  const responses = new Map<string, string>();
  const artifacts = await Promise.all([...SINGLETON_ROLES, 'runtime-asset' as const].map(async role => {
    const path = role === 'html' ? 'index.html' : role === 'application-entry' ? `assets/app-${label}.js` :
      role === 'runtime-asset' ? 'service-worker.js' : role === 'core-wasm' ? 'wasm/core.wasm' : `${role}.bin`;
    const content = `${label}:${role}`; responses.set(new URL(path, base).href, content);
    const bytes = new TextEncoder().encode(content);
    return { role, path, bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }));
  const payload = { schemaVersion: 1 as const, build, artifacts };
  const manifest: RuntimeManifest = { ...payload, deploymentId: await sha256(new TextEncoder().encode(canonicalJson(payload))) };
  responses.set(new URL('build-manifest.json', base).href, JSON.stringify(manifest));
  return { manifest, responses, base };
}
function fixture(initial: Deployment) {
  const caches = new MemoryCaches(), metadata = memoryMetadata(), requests: string[] = [];
  let host = initial, online = true, fault: ((url: string, content: string) => Response | Promise<Response>) | undefined;
  let time = 0, sequence = 0;
  const options = {
    caches: caches as unknown as CacheStorage, metadata,
    fetch: async (url: string, _init: RequestInit) => {
      requests.push(url); if (!online) throw new TypeError('Network unavailable');
      const content = host.responses.get(url); if (content === undefined) throw new Error('Host artifact missing');
      return fault ? fault(url, content) : responseAt(content, url);
    },
    now: () => ++time, token: () => `token-${++sequence}`,
  };
  return { caches, metadata, requests, store: new CohortStore(initial.base, options), restart: () => new CohortStore(initial.base, options),
    host: (next: Deployment) => { host = next; }, online: (next: boolean) => { online = next; },
    fault: (next?: (url: string, content: string) => Response | Promise<Response>) => { fault = next; } };
}
const id = (value: Deployment) => value.manifest.deploymentId;
const owner = (clientId: string, resultingClientId: string) => ({ clientId, replacesClientId: clientId, resultingClientId });

describe('complete application-cache cohorts', () => {
  for (const base of ['https://example.test/', 'https://example.test/project/']) it(`admits and cold-starts an exact complete cohort at ${base}`, async () => {
    const a = await deployment('A', base), f = fixture(a);
    const pinned = await f.store.pin('tab-a', id(a), 'session-a');
    expect(pinned).toMatchObject({ current: id(a), preferred: id(a), ready: true, available: null });
    expect(f.requests).toHaveLength(a.responses.size);
    const state = await f.metadata.read(), record = state.cohorts[id(a)];
    expect([...f.caches.data.get(record.cacheName)!.keys()].sort()).toEqual([...a.responses.keys()].sort());
    f.online(false); const restarted = f.restart();
    const response = await restarted.navigate(base, owner('tab-a', 'tab-reloaded'));
    expect(response.status).toBe(200); expect(await response.text()).toBe('A:html');
    expect((await f.metadata.read()).pins['tab-reloaded']).toEqual({ deploymentId: id(a), sessionId: null, offered: null, navigation: 'reserved' });
    expect(await restarted.pin('tab-reloaded', id(a), 'session-reloaded')).toMatchObject({ ready: true });
  });
  for (const fault of ['hash', 'redirect', 'oversize', 'stream-overflow', 'quota', 'interrupted'] as const) it(`preserves the complete older cohort when an update fails: ${fault}`, async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); const previous = await f.metadata.read();
    f.host(b);
    if (fault === 'quota') f.caches.failPut = true;
    else f.fault((url, content) => {
      if (!url.endsWith('core.wasm')) return responseAt(content, url);
      if (fault === 'hash') return responseAt(content.replace('B:', 'Z:'), url);
      if (fault === 'redirect') return responseAt(content, url + '?redirected');
      if (fault === 'oversize') return responseAt(content, url, { 'content-length': '9999999' });
      if (fault === 'stream-overflow') return responseAt(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(content)); controller.enqueue(new Uint8Array([1])); },
      }), url);
      throw new TypeError('Connection interrupted');
    });
    await expect(f.store.checkUpdate('tab-a')).rejects.toThrow();
    const current = await f.metadata.read();
    expect(current.preferred).toBe(id(a)); expect(current.cohorts).toEqual(previous.cohorts);
    expect(await f.store.status('tab-a')).toMatchObject({ ready: true, current: id(a), available: null });
    expect(await f.caches.keys()).toEqual([previous.cohorts[id(a)].cacheName]);
  });
  it('does not admit a cache whose readback was evicted or modified', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    const record = (await f.metadata.read()).cohorts[id(a)], entries = f.caches.data.get(record.cacheName)!;
    entries.set(new URL('wasm/core.wasm', a.base).href, responseAt('malformed', new URL('wasm/core.wasm', a.base).href));
    f.online(false);
    const response = await f.restart().navigate(a.base, owner('tab-a', 'tab-new'));
    expect(response.status).toBe(503); expect(await response.text()).toContain('unavailable offline');
    expect((await f.store.status('tab-a')).ready).toBe(false);
    expect((await f.metadata.read()).pins['tab-new']).toBeUndefined();
  });
  it('keeps a verified live identity when the host changes before its cache can be installed', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(b);
    expect(await f.store.pin('tab-a', id(a), 'session-a')).toMatchObject({ current: id(a), ready: false });
    expect(await f.store.checkUpdate('tab-a')).toMatchObject({ current: id(a), ready: false, available: id(b) });
    const response = await f.store.fetchForClient('tab-a', new URL('wasm/core.wasm', a.base).href);
    expect(response?.status).toBe(503);
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'reload-b');
    const navigated = await f.store.navigate(`${b.base}?${UPDATE_QUERY}=${prepared.ticket}`, owner('tab-a', 'tab-b'));
    expect(await navigated.text()).toBe('B:html');
  });
  it('serves each tab its own shared native URLs, without filling an evicted entry from the new host', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.pin('tab-b', id(b), 'session-b');
    const url = new URL('wasm/core.wasm', a.base).href;
    expect(await (await f.store.fetchForClient('tab-a', url))!.text()).toBe('A:core-wasm');
    expect(await (await f.store.fetchForClient('tab-b', url))!.text()).toBe('B:core-wasm');
    const count = f.requests.length, record = (await f.metadata.read()).cohorts[id(a)];
    f.caches.data.get(record.cacheName)!.delete(url);
    expect((await f.restart().fetchForClient('tab-a', url))?.status).toBe(503); expect(f.requests).toHaveLength(count);
    await expect(f.store.pin('tab-a', id(b), 'session-b')).rejects.toThrow(/owner/);
  });
  it('does not cache scene requests, unrelated routes, queries or another application scope', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    const before = await f.caches.keys();
    for (const path of ['scene.ply', 'assets/unknown.js', 'wasm/core.wasm?new=1', '../other/scene.ply'])
      expect(await f.store.fetchForClient('tab-a', new URL(path, a.base).href)).toBeUndefined();
    expect(await f.store.fetchForClient('unknown', new URL('wasm/core.wasm', a.base).href)).toBeUndefined();
    expect(await f.caches.keys()).toEqual(before);
  });
  it('passes an unlisted scene request to the network even when the cached application manifest was evicted', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    const record = (await f.metadata.read()).cohorts[id(a)];
    f.caches.data.get(record.cacheName)!.delete(new URL('build-manifest.json', a.base).href);
    expect(await f.restart().fetchForClient('tab-a', new URL('scene.ply', a.base).href)).toBeUndefined();
    expect((await f.restart().fetchForClient('tab-a', new URL('wasm/core.wasm', a.base).href))?.status).toBe(503);
  });
  for (const inventory of [[], ['https://other.test/core.wasm'], ['https://example.test/project/../outside.js'],
    ['https://example.test/project/a.js', 'https://example.test/project/a.js']]) it(`refuses an invalid metadata inventory ${JSON.stringify(inventory)}`, async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    await f.metadata.update(state => { state.cohorts[id(a)].artifactUrls = inventory; });
    expect((await f.restart().fetchForClient('tab-a', new URL('scene.ply', a.base).href))?.status).toBe(503);
  });
});

describe('durable exact-target update navigation', () => {
  it('keeps an offered B and its idempotent ticket stable after another tab installs C', async () => {
    const a = await deployment('A'), b = await deployment('B'), c = await deployment('C'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    f.host(c); await f.store.pin('tab-c', id(c), 'session-c');
    expect(await f.store.status('tab-a')).toMatchObject({ available: id(b), preferred: id(c) });
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'request-b');
    const repeated = await f.restart().prepareNavigation('tab-a', id(b), 'session-a', 'request-b');
    expect(repeated.ticket).toBe(prepared.ticket);
    const navigated = await f.restart().navigate(`${a.base}?${UPDATE_QUERY}=${prepared.ticket}`, owner('tab-a', 'tab-new'));
    expect(await navigated.text()).toBe('B:html');
    expect((await f.metadata.read()).pins['tab-new'].deploymentId).toBe(id(b));
    await expect(f.store.prepareNavigation('tab-a', id(b), 'session-a', 'request-b')).rejects.toThrow(/consumed/);
    await expect(f.store.cancelNavigation('tab-a', prepared.ticket)).rejects.toThrow(/consumed/);
    await expect(f.store.prepareNavigation('tab-a', id(c), 'session-a', 'request-b')).rejects.toThrow(/different application/);
  });
  it('records cancellation durably, refuses ownership theft and never remints an old request', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'cancel-me');
    await expect(f.store.cancelNavigation('tab-other', prepared.ticket)).rejects.toThrow(/own/);
    await f.store.cancelNavigation('tab-a', prepared.ticket); await f.restart().cancelNavigation('tab-a', prepared.ticket);
    await expect(f.store.prepareNavigation('tab-a', id(b), 'session-a', 'cancel-me')).rejects.toThrow(/cancelled/);
    const result = await f.store.navigate(`${a.base}?${UPDATE_QUERY}=${prepared.ticket}`, owner('tab-a', 'tab-new'));
    expect(result.status).toBe(503); expect((await f.metadata.read()).pins['tab-new']).toBeUndefined();
  });
  it('does not consume a ticket without the exact source and a resulting browser client', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'navigate');
    for (const target of [owner('foreign-client', 'tab-new'), owner('tab-a', '')])
      expect((await f.store.navigate(`${a.base}?${UPDATE_QUERY}=${prepared.ticket}`, target)).status).toBe(503);
    expect((await f.metadata.read()).tickets[prepared.ticket].disposition).toBe('unused');
  });
  it('admits an unguessable owned ticket when the browser omits both navigation source fields', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'navigation');
    const response = await f.store.navigate(`${a.base}?${UPDATE_QUERY}=${prepared.ticket}`, { clientId: '', replacesClientId: '', resultingClientId: 'tab-new' });
    expect(await response.text()).toBe('B:html');
  });
  it('durably retires an unused request before acknowledging that its exact target was evicted', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'lost-ack');
    const record = (await f.metadata.read()).cohorts[id(b)]; await f.caches.delete(record.cacheName);
    await expect(f.restart().prepareNavigation('tab-a', id(b), 'session-a', 'lost-ack')).rejects.toThrow(/evicted/);
    expect((await f.metadata.read()).tickets[prepared.ticket].disposition).toBe('cancelled');
  });
  it('preserves a refused request receipt when no ticket was minted and its refusal acknowledgement was lost', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a');
    await expect(f.store.prepareNavigation('tab-a', id(b), 'session-a', 'refused-request')).rejects.toThrow(/not been completely saved/);
    f.host(b); await f.store.checkUpdate('tab-a');
    await expect(f.restart().prepareNavigation('tab-a', id(b), 'session-a', 'refused-request')).rejects.toThrow(/cancelled/);
    const fresh = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'fresh-request');
    expect(fresh.ticket).toBeTruthy();
  });
  it('bounds live navigation receipts without expiring tickets during a user dialog', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    for (let index = 0; index < 32; index++) {
      const prepared = await f.store.prepareNavigation('tab-a', id(a), 'session-a', `request-${index}`);
      await f.store.cancelNavigation('tab-a', prepared.ticket);
    }
    await expect(f.store.prepareNavigation('tab-a', id(a), 'session-a', 'request-over-limit')).rejects.toThrow(/limit/);
  });
});

describe('conservative application-cache retirement', () => {
  it('keeps live pins, stable offers and exact targets, then retires closed owners with two complete fallbacks', async () => {
    const a = await deployment('A'), b = await deployment('B'), c = await deployment('C'), d = await deployment('D'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'hold-b');
    f.host(c); await f.store.stage(); f.host(d); await f.store.stage();
    expect(await f.store.collect([{ id: 'tab-a', deploymentId: id(a), sessionId: 'session-a' }])).toEqual({ deleted: [], deferred: false });
    expect(Object.keys((await f.metadata.read()).cohorts)).toHaveLength(4);
    const retired = await f.restart().collect([]);
    expect(retired.deferred).toBe(false); expect(retired.deleted).toHaveLength(2);
    const state = await f.metadata.read(); expect(Object.keys(state.cohorts).sort()).toEqual([id(c), id(d)].sort());
    expect(state.pins).toEqual({}); expect(state.tickets).toEqual({});
  });
  it('defers all unproven physical-cache deletion for unknown or unresponsive windows', async () => {
    const a = await deployment('A'), b = await deployment('B'), c = await deployment('C'), f = fixture(a);
    await f.store.stage(); f.host(b); await f.store.stage(); f.host(c); await f.store.stage();
    const orphan = `${offlineStoragePrefix(a.base)}orphan-staging`; await f.caches.open(orphan);
    const collected = await f.store.collect([{ id: 'unknown-window' }]);
    expect(collected.deferred).toBe(true); expect(collected.deleted).toEqual([]);
    expect(await f.caches.keys()).toContain(orphan);
    expect(Object.keys((await f.metadata.read()).cohorts)).toHaveLength(3);
    expect((await f.store.collect([])).deleted).toHaveLength(2);
  });
  it('preserves a physical complete cache after metadata eviction while an unknown window remains', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.stage();
    const names = await f.caches.keys();
    await f.metadata.update(state => { state.cohorts = {}; state.preferred = null; });
    expect(await f.store.collect([{ id: 'unknown-tab' }])).toEqual({ deleted: [], deferred: true });
    expect(await f.caches.keys()).toEqual(names);
  });
  it('preserves a pin admitted after the fresh client-snapshot fence', async () => {
    const a = await deployment('A'), b = await deployment('B'), c = await deployment('C'), f = fixture(a);
    await f.store.stage(); f.host(b); await f.store.stage(); f.host(c); await f.store.stage();
    const fence = await f.store.retirementFence();
    await f.store.pin('new-tab', id(a), 'new-session');
    expect(await f.store.collect([], fence)).toEqual({ deleted: [], deferred: true });
    expect((await f.metadata.read()).pins['new-tab'].deploymentId).toBe(id(a));
  });
  it('protects a reserved navigation client until PIN or positive post-handled closure evidence', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    expect((await f.store.navigate(a.base, owner('tab-a', 'tab-reserved'))).status).toBe(200);
    expect((await f.store.collect([])).deferred).toBe(true);
    expect((await f.metadata.read()).pins['tab-reserved']).toBeDefined();
    await f.store.settleNavigation('tab-reserved', false);
    expect((await f.store.collect([])).deferred).toBe(false);
    expect((await f.metadata.read()).pins['tab-reserved']).toBeUndefined();
  });
  it('retires a cancelled destination only after positive closure while preserving the executing source and its consumed receipt', async () => {
    const a = await deployment('A'), b = await deployment('B'), f = fixture(a);
    await f.store.pin('tab-a', id(a), 'session-a'); f.host(b); await f.store.checkUpdate('tab-a');
    const prepared = await f.store.prepareNavigation('tab-a', id(b), 'session-a', 'cancel-browser-navigation');
    expect((await f.store.navigate(`${a.base}?${UPDATE_QUERY}=${prepared.ticket}`, owner('tab-a', 'cancelled-destination'))).status).toBe(200);
    const caches = await f.caches.keys(), source = { id: 'tab-a', deploymentId: id(a), sessionId: 'session-a' };
    // An aborted browser navigation may fail to provide a client lookup result.
    // Unknown presence cannot be promoted into proof that the reserved tab died.
    await f.store.settleNavigation('cancelled-destination', 'unknown');
    expect(await f.store.collect([source])).toEqual({ deleted: [], deferred: true });
    expect((await f.metadata.read()).pins['cancelled-destination']).toBeDefined();
    expect(await f.caches.keys()).toEqual(caches);
    // After handled settles, a successful browser lookup with no client proves
    // closure. Retire only that unacknowledged destination, not the live source.
    await f.store.settleNavigation('cancelled-destination', false);
    expect(await f.store.collect([source])).toEqual({ deleted: [], deferred: false });
    const state = await f.metadata.read();
    expect(state.pins['cancelled-destination']).toBeUndefined(); expect(state.pins['tab-a'].deploymentId).toBe(id(a));
    expect(state.tickets[prepared.ticket].disposition).toBe('consumed'); expect(await f.caches.keys()).toEqual(caches);
  });
  it('does not retire a destination that already acknowledged its own verified application pin', async () => {
    const a = await deployment('A'), f = fixture(a); await f.store.pin('tab-a', id(a), 'session-a');
    await f.store.navigate(a.base, owner('tab-a', 'joined-destination'));
    await f.store.pin('joined-destination', id(a), 'session-joined');
    await f.store.settleNavigation('joined-destination', false);
    expect((await f.metadata.read()).pins['joined-destination']).toEqual({ deploymentId: id(a), sessionId: 'session-joined', offered: null });
  });
});

describe('offline boundary utilities', () => {
  it('separates root and project storage and rejects ambiguous scope URLs', () => {
    expect(offlineStoragePrefix('https://example.test/')).not.toBe(offlineStoragePrefix('https://example.test/project/'));
    for (const base of ['https://example.test/project', 'https://example.test/?x=1', 'https://user:password@example.test/', 'file:///project/'])
      expect(() => normalizeOfflineBase(base)).toThrow();
  });
  it('returns a non-executable accessible failure instead of interpolating server content', async () => {
    const response = offlineUnavailable('<script>alert("unsafe")</script>', 'https://example.test/project/');
    expect(response.status).toBe(503); expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text(); expect(html).toContain('role="alert"'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>');
  });
});
