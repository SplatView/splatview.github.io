import { CohortStore, OfflineUnknownOutcome, indexedMetadataStore, offlineStoragePrefix, offlineUnavailable, type ReconciledClient } from './cohortStore';
import { OFFLINE_PROTOCOL, isOfflineToken, parseOfflineRequest, type OfflineReply, type OfflineRequest } from './protocol';

// Keep this adapter independent of the application's compiled build identity. A new
// deployment is data admitted by its manifest, even when the worker script is unchanged.
interface AppClient { id: string; url: string; type: string; postMessage(message: unknown): void }
interface WorkerGlobal {
  registration: { scope: string };
  caches: CacheStorage;
  indexedDB: IDBFactory;
  crypto: Crypto;
  clients: {
    get(id: string): Promise<AppClient | undefined>;
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<AppClient[]>;
  };
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  addEventListener(type: string, listener: (event: never) => void): void;
}
interface LifetimeEvent { waitUntil(work: Promise<unknown>): void }
interface MessageEvent extends LifetimeEvent {
  data: unknown; ports: readonly MessagePort[]; source: { id?: string } | null;
}
interface FetchEvent extends LifetimeEvent {
  request: Request; clientId: string; resultingClientId: string; replacesClientId: string;
  handled?: Promise<void>;
  respondWith(response: Promise<Response>): void;
}
const worker = globalThis as unknown as WorkerGlobal;
const base = worker.registration.scope;
const metadata = indexedMetadataStore(`${offlineStoragePrefix(base)}metadata`, worker.indexedDB);
const inScope = (client: AppClient) => {
  try { const url = new URL(client.url), scope = new URL(base); return client.type === 'window' && url.origin === scope.origin && url.pathname.startsWith(scope.pathname); }
  catch { return false; }
};
async function windows(): Promise<AppClient[]> {
  return (await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(inScope);
}
async function broadcast(): Promise<void> {
  for (const client of await windows()) { try { client.postMessage({ protocol: OFFLINE_PROTOCOL, type: 'CHANGED' }); } catch { /* A tab can close between enumeration and delivery. */ } }
}
const store = new CohortStore(base, {
  caches: worker.caches, metadata, fetch: (url, init) => worker.fetch(url, init),
  now: () => Date.now(), token: () => worker.crypto.randomUUID(), changed: broadcast,
});
const rounds = new Map<string, Map<string, ReconciledClient>>();
let housekeeping: Promise<void> | undefined;
async function reconcile(): Promise<void> {
  const round = worker.crypto.randomUUID(), replies = new Map<string, ReconciledClient>();
  rounds.set(round, replies);
  try {
    const clients = await windows();
    for (const client of clients) {
      try { client.postMessage({ protocol: OFFLINE_PROTOCOL, type: 'RECONCILE', round }); }
      catch { /* Missing acknowledgement defers complete-cache retirement. */ }
    }
    // This is a grace period, not evidence of acknowledgement. Every surviving
    // client must reply, and a second actual client snapshot is authoritative.
    if (clients.length) await new Promise<void>(resolve => setTimeout(resolve, 1500));
    const fence = await store.retirementFence(), current = await windows();
    await store.collect(current.map(client => replies.get(client.id) ?? { id: client.id }), fence);
  } finally { rounds.delete(round); }
}
function scheduleHousekeeping(): Promise<void> {
  if (!housekeeping) housekeeping = reconcile().catch(() => undefined).finally(() => { housekeeping = undefined; });
  return housekeeping;
}
async function settleHandledNavigation(clientId: string): Promise<void> {
  if (!clientId) return;
  let exists: boolean | 'unknown';
  try { exists = !!await worker.clients.get(clientId); }
  catch { exists = 'unknown'; }
  await store.settleNavigation(clientId, exists);
}
async function sourceClient(event: MessageEvent): Promise<AppClient> {
  const id = event.source?.id;
  if (typeof id !== 'string' || !id || id.length > 256) throw new Error('The offline-cache request has no browser client owner.');
  const client = await worker.clients.get(id);
  if (!client || !inScope(client)) throw new Error('The offline-cache request is outside this application scope.');
  return client;
}
async function dispatch(client: AppClient, request: OfflineRequest): Promise<OfflineReply> {
  let status;
  switch (request.type) {
    case 'PIN': status = await store.pin(client.id, request.deploymentId!, request.sessionId!); break;
    case 'STATUS': status = await store.status(client.id); break;
    case 'CHECK_UPDATE': status = await store.checkUpdate(client.id); break;
    case 'PREPARE_NAVIGATION': {
      const prepared = await store.prepareNavigation(client.id, request.deploymentId!, request.sessionId!, request.requestId);
      return { protocol: OFFLINE_PROTOCOL, requestId: request.requestId, ok: true, ...prepared };
    }
    case 'CANCEL_NAVIGATION': status = await store.cancelNavigation(client.id, request.ticket!); break;
    case 'RECONCILE_REPLY': {
      const pending = rounds.get(request.round!);
      if (pending) pending.set(client.id, { id: client.id, deploymentId: request.deploymentId, sessionId: request.sessionId });
      status = await store.status(client.id); break;
    }
  }
  return { protocol: OFFLINE_PROTOCOL, requestId: request.requestId, ok: true, status };
}
async function message(event: MessageEvent): Promise<void> {
  const port = event.ports.length === 1 ? event.ports[0] : undefined;
  if (!port) return;
  let requestId: string | undefined;
  try {
    const request = parseOfflineRequest(event.data); requestId = request.requestId;
    const client = await sourceClient(event);
    const reply = await dispatch(client, request);
    port.postMessage(reply);
    if (request.type !== 'RECONCILE_REPLY' && request.type !== 'STATUS') await scheduleHousekeeping();
  } catch (error) {
    if (error instanceof OfflineUnknownOutcome) return;
    if (!requestId && event.data && typeof event.data === 'object') {
      const candidate = (event.data as { requestId?: unknown }).requestId;
      if (isOfflineToken(candidate)) requestId = candidate;
    }
    if (requestId) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 4096) || 'The application cache request failed.';
      try { port.postMessage({ protocol: OFFLINE_PROTOCOL, requestId, ok: false, error: detail } satisfies OfflineReply); } catch { /* The requesting page may already be gone. */ }
    }
  } finally { port.close(); }
}
worker.addEventListener('message', (event: MessageEvent) => { event.waitUntil(message(event)); });
worker.addEventListener('install', (event: LifetimeEvent) => {
  // Installation does not depend on the network and never takes over open pages.
  event.waitUntil(Promise.resolve());
});
worker.addEventListener('activate', (event: LifetimeEvent) => { event.waitUntil(scheduleHousekeeping()); });
worker.addEventListener('fetch', (event: FetchEvent) => {
  if (event.request.method !== 'GET') return;
  let url: URL;
  try { url = new URL(event.request.url); } catch { return; }
  if (!store.inScope(url)) return;
  if (event.request.mode === 'navigate') {
    if (store.isApplicationNavigation(url)) {
      event.respondWith(store.navigate(url.href, {
        clientId: event.clientId, replacesClientId: event.replacesClientId, resultingClientId: event.resultingClientId,
      }));
      if (event.handled) event.waitUntil(event.handled.then(
        () => settleHandledNavigation(event.resultingClientId),
        () => settleHandledNavigation(event.resultingClientId),
      ).catch(() => undefined));
    }
    return;
  }
  event.respondWith((async () => {
    try { return await store.fetchForClient(event.clientId, url.href) ?? await worker.fetch(event.request); }
    catch (error) { return offlineUnavailable(error instanceof Error ? error.message : String(error), base, false); }
  })());
});
