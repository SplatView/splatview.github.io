import serviceWorkerUrl from './service.worker.ts?worker&url';
import { ensureRuntime } from '../build/runtime';
import { commitUpdateNavigation } from './navigation';
import { OFFLINE_PROTOCOL, OFFLINE_REQUEST_TIMEOUT_MS, UPDATE_QUERY, isDeploymentId, parseOfflineNotification,
  parseOfflineReply, type OfflineReply, type OfflineRequest, type OfflineStatus } from './protocol';

export interface OfflineState {
  phase: 'unsupported' | 'installing' | 'ready' | 'unavailable';
  current: string | null; available: string | null; error: string | null; checking: boolean;
}
let snapshot: OfflineState = Object.freeze({ phase: 'unsupported', current: null, available: null, error: null, checking: false });
const listeners = new Set<() => void>();
function publish(patch: Partial<OfflineState>) {
  const next = Object.freeze({ ...snapshot, ...patch });
  if (Object.keys(next).every(key => next[key as keyof OfflineState] === snapshot[key as keyof OfflineState])) return;
  snapshot = next;
  for (const listener of listeners) listener();
}
export const offlineState = {
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
interface Connection { registration: ServiceWorkerRegistration; worker: ServiceWorker; base: string; deployment: string; session: string; script: string }
let connected: Connection | undefined;
let connecting: Promise<Connection | undefined> | undefined;
let initialCheck = false;
let check: Promise<void> | undefined;
let statusRefresh: Promise<void> | undefined;
let refreshAgain = false;
let rebinding: Promise<ServiceWorker> | undefined;
let pendingNavigation: { deployment: string; requestId: string; ticket?: string } | undefined;
const session = crypto.randomUUID();
const detail = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 4096);
class OfflineRefusal extends Error {}

function request(worker: ServiceWorker, message: OfflineRequest): Promise<Extract<OfflineReply, { ok: true }>> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (error?: unknown, reply?: Extract<OfflineReply, { ok: true }>) => {
      if (settled) return;
      settled = true; clearTimeout(timer); channel.port1.close(); channel.port2.close();
      if (error) reject(error); else resolve(reply!);
    };
    const timer = setTimeout(() => finish(new Error('Offline-cache acknowledgement timed out. Retry the same action.')), OFFLINE_REQUEST_TIMEOUT_MS);
    channel.port1.onmessage = event => {
      try {
        const reply = parseOfflineReply(event.data, message.requestId);
        if (!reply.ok) finish(new OfflineRefusal(reply.error)); else finish(undefined, reply);
      } catch (error) { finish(error); }
    };
    channel.port1.onmessageerror = () => finish(new Error('The offline-cache acknowledgement could not be read.'));
    try { worker.postMessage(message, [channel.port2]); } catch (error) { finish(error); }
  });
}
function message(type: OfflineRequest['type'], fields: Partial<OfflineRequest> = {}): OfflineRequest {
  return { protocol: OFFLINE_PROTOCOL, requestId: crypto.randomUUID(), type, ...fields };
}
function adopt(connection: Connection, status: OfflineStatus) {
  if (status.current !== connection.deployment) {
    const error = status.current === null
      ? 'Offline cache metadata is missing. Check for updates while online to repair it.'
      : 'The offline cache belongs to a different application build. Reload when ready.';
    publish({ phase: 'unavailable', available: pendingNavigation?.deployment ?? null, error });
    throw new Error(error);
  }
  publish({ current: connection.deployment, phase: status.ready ? 'ready' : 'unavailable',
    available: pendingNavigation?.deployment ?? status.available, error: status.error ?? null });
}
async function activeWorker(registration: ServiceWorkerRegistration): Promise<ServiceWorker> {
  if (registration.active?.state === 'activated') return registration.active;
  return new Promise((resolve, reject) => {
    const watched = new Set<ServiceWorker>();
    const done = (error?: Error, worker?: ServiceWorker) => {
      clearTimeout(timer); registration.removeEventListener('updatefound', inspect);
      for (const value of watched) value.removeEventListener('statechange', inspect);
      if (error) reject(error); else resolve(worker!);
    };
    const inspect = () => {
      if (registration.active?.state === 'activated') { done(undefined, registration.active); return; }
      for (const value of [registration.active, registration.installing, registration.waiting]) {
        if (value && !watched.has(value)) { watched.add(value); value.addEventListener('statechange', inspect); }
      }
    };
    const timer = setTimeout(() => done(new Error('Offline installation did not activate. Retry while online.')), 30_000);
    registration.addEventListener('updatefound', inspect); inspect();
  });
}
async function router(connection: Connection): Promise<ServiceWorker> {
  const active = connection.registration.active;
  if (active === connection.worker && active?.state === 'activated') return active;
  if (!rebinding) rebinding = (async () => {
    const worker = await activeWorker(connection.registration);
    if (worker.scriptURL !== connection.script || connection.registration.scope !== connection.base)
      throw new Error('The offline router has a different application scope.');
    const reply = await request(worker, message('PIN', { deploymentId: connection.deployment, sessionId: connection.session }));
    adopt(connection, reply.status); connection.worker = worker;
    return worker;
  })().finally(() => { rebinding = undefined; });
  return rebinding;
}
async function query(connection: Connection, value: OfflineRequest) { return request(await router(connection), value); }
async function refreshStatus(connection: Connection) {
  if (statusRefresh) { refreshAgain = true; return statusRefresh; }
  statusRefresh = (async () => {
    do {
      refreshAgain = false;
      try { const reply = await query(connection, message('STATUS')); adopt(connection, reply.status); }
      catch (error) { publish({ error: detail(error) }); }
    } while (refreshAgain);
  })().finally(() => { statusRefresh = undefined; });
  return statusRefresh;
}
function onNotification(event: MessageEvent) {
  const connection = connected, source = event.source;
  if (!connection || !source || !('scriptURL' in source) || source.scriptURL !== connection.script ||
      event.origin && event.origin !== location.origin) return;
  const notification = parseOfflineNotification(event.data);
  if (notification?.type === 'CHANGED') void refreshStatus(connection);
  if (notification?.type === 'RECONCILE') {
    // A browser may restart the router at any time; acknowledge the retained
    // verified app, never a deployment supplied by a notification payload.
    void request(source as ServiceWorker, message('RECONCILE_REPLY', { round: notification.round,
      deploymentId: connection.deployment, sessionId: connection.session })).catch(() => undefined);
  }
}
async function connect(): Promise<Connection | undefined> {
  const runtime = await ensureRuntime();
  if (runtime.mode !== 'production-verified' || !runtime.verified || !isSecureContext ||
      !('serviceWorker' in navigator) || !('caches' in globalThis) || !('indexedDB' in globalThis)) {
    publish({ phase: 'unsupported' }); return;
  }
  const base = runtime.assetBase, script = new URL(serviceWorkerUrl, document.baseURI).href;
  if (script !== new URL('service-worker.js', base).href || !runtime.verified.artifacts.has(script))
    throw new Error('This build does not contain its qualified offline router.');
  const deployment = runtime.verified.manifest.deploymentId;
  publish({ phase: 'installing', current: deployment, error: null });
  const registration = await navigator.serviceWorker.register(script, { type: 'module', scope: base, updateViaCache: 'none' });
  if (registration.scope !== base) throw new Error('Offline registration has a different application scope.');
  const worker = await activeWorker(registration);
  const connection: Connection = { registration, worker, base, deployment, session, script };
  connected = connection;
  navigator.serviceWorker.removeEventListener('message', onNotification);
  navigator.serviceWorker.addEventListener('message', onNotification);
  const reply = await request(worker, message('PIN', { deploymentId: deployment, sessionId: session }));
  adopt(connection, reply.status);
  // Remove only the consumed ticket after normal executable verification and a
  // durable pin acknowledgement. Other URL parameters and the fragment survive.
  const address = new URL(location.href);
  if (address.searchParams.has(UPDATE_QUERY)) {
    address.searchParams.delete(UPDATE_QUERY); history.replaceState(history.state, '', address.href);
  }
  return connection;
}
function connectOnce() {
  if (!connecting) connecting = connect().catch(error => {
    connecting = undefined; publish({ phase: 'unavailable', error: detail(error), checking: false }); throw error;
  });
  return connecting;
}
/** Start only after the production entry has verified its complete closure. */
export async function initializeOffline(): Promise<void> {
  try {
    const connection = await connectOnce();
    if (connection && !initialCheck) {
      initialCheck = true;
      if (navigator.onLine) await checkOfflineUpdate();
    }
  } catch { /* Optional application caching does not prevent online editing. */ }
}
export async function checkOfflineUpdate(): Promise<void> {
  if (pendingNavigation) throw new Error('Retry the pending update before checking for a different build.');
  if (check) return check;
  check = (async () => {
    const connection = await connectOnce();
    if (!connection) throw new Error('Offline application caching is unavailable in this browser.');
    publish({ checking: true, error: null });
    try {
      const current = await query(connection, message('STATUS'));
      if (current.status.current === null) {
        // Browser storage can be evicted independently of the live document.
        // An explicit check may restore only this already verified app/session.
        // A different existing owner is never overwritten.
        publish({ phase: 'unavailable', available: null });
        const repaired = await query(connection, message('PIN', {
          deploymentId: connection.deployment, sessionId: connection.session,
        }));
        adopt(connection, repaired.status);
      } else adopt(connection, current.status);
      const reply = await query(connection, message('CHECK_UPDATE'));
      adopt(connection, reply.status);
      if (reply.status.error) throw new Error(reply.status.error);
    } catch (error) { publish({ error: detail(error) }); throw error; }
    finally { publish({ checking: false }); }
  })().finally(() => { check = undefined; });
  return check;
}
/** Called only after the controller's joined Save/Discard/Stay boundary. */
export async function reloadOfflineUpdate(deploymentId: string, guard: () => boolean = () => true,
  beginUnload?: () => () => void): Promise<void> {
  if (!isDeploymentId(deploymentId) || !guard()) throw new Error('The document changed before the update could start.');
  const connection = await connectOnce();
  if (!connection || !guard()) throw new Error('The application is not ready to reload.');
  if (pendingNavigation && pendingNavigation.deployment !== deploymentId)
    throw new Error('A previous update is awaiting acknowledgement. Retry that update first.');
  if (!pendingNavigation && snapshot.available !== deploymentId) throw new Error('The offered update changed. Check for updates again.');
  const pending = pendingNavigation ??= { deployment: deploymentId, requestId: crypto.randomUUID() };
  publish({ checking: true, error: null, available: pending.deployment });
  let navigating = false;
  let releaseUnload: (() => void) | undefined;
  try {
    // A timeout retains this exact request identity. A retry queries its durable
    // result rather than minting another navigation capability.
    const reply = await query(connection, { ...message('PREPARE_NAVIGATION'), requestId: pending.requestId,
      deploymentId, sessionId: connection.session });
    if (!reply.ticket) throw new Error('The update has no acknowledged navigation ticket.');
    pending.ticket = reply.ticket;
    adopt(connection, reply.status);
    if (!guard()) {
      await query(connection, message('CANCEL_NAVIGATION', { ticket: reply.ticket }));
      if (pendingNavigation === pending) pendingNavigation = undefined;
      throw new Error('The document changed while preparing the update. Your current scene remains open.');
    }
    const target = new URL(connection.base); target.searchParams.set(UPDATE_QUERY, reply.ticket);
    releaseUnload = beginUnload?.();
    if (!guard()) throw new Error('The document changed before update navigation.');
    await commitUpdateNavigation(target.href); navigating = true;
  } catch (error) {
    releaseUnload?.(); releaseUnload = undefined;
    // A refused request has a known terminal result. Transport uncertainty
    // keeps the exact id so a subsequent user action can reconcile it.
    if (error instanceof OfflineRefusal && pendingNavigation === pending) pendingNavigation = undefined;
    else if (pending.ticket && pendingNavigation === pending) {
      try {
        await query(connection, message('CANCEL_NAVIGATION', { ticket: pending.ticket }));
        if (pendingNavigation === pending) pendingNavigation = undefined;
      } catch (cancellation) {
        if (cancellation instanceof OfflineRefusal && pendingNavigation === pending) pendingNavigation = undefined;
      }
    }
    publish({ error: detail(error) }); throw error;
  }
  finally { releaseUnload?.(); if (!navigating) publish({ checking: false }); }
}
