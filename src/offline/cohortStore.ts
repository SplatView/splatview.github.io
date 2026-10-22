import type { RuntimeManifest } from '../build/contracts';
import { MAX_MANIFEST_BYTES, parseBuildDescriptor, sha256, validateManifest, verifyArtifactBytes, type VerifiedManifest } from '../build/verification';
import { UPDATE_QUERY, isDeploymentId, type OfflineStatus } from './protocol';

/** These records contain application identities and client ownership, never scene bytes. */
export interface CohortRecord {
  deploymentId: string; cacheName: string; completedAt: number; manifestBytes: number; manifestSha256: string;
  artifactUrls: string[];
}
export interface ClientPin { deploymentId: string; sessionId: string | null; offered: string | null; navigation?: 'reserved' | 'handled' }
export interface NavigationTicket {
  clientId: string; sessionId: string; deploymentId: string; requestId: string;
  disposition: 'unused' | 'cancelled' | 'consumed';
}
export interface CohortMetadata {
  schemaVersion: 1; preferred: string | null;
  cohorts: Record<string, CohortRecord>;
  pins: Record<string, ClientPin>;
  tickets: Record<string, NavigationTicket>;
}
export interface MetadataStore {
  read(): Promise<CohortMetadata>;
  update<T>(change: (metadata: CohortMetadata) => T): Promise<T>;
}
export interface CohortEnvironment {
  caches: CacheStorage;
  metadata: MetadataStore;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): number;
  token(): string;
  changed?(): Promise<void>;
}
export interface NavigationOwner { clientId: string; replacesClientId: string; resultingClientId: string }
export interface ReconciledClient { id: string; deploymentId?: string; sessionId?: string }
interface AcceptedCohort { record: CohortRecord; verified: VerifiedManifest; cache: Cache }
/** A transport timeout is safer than falsely acknowledging retirement that IDB could not record. */
export class OfflineUnknownOutcome extends Error {}
const INSTALL_TIMEOUT_MS = 45_000;
const INSTALL_PARALLELISM = 4;
const CACHE_SCHEMA = 'splatview-app-v1-';
const emptyMetadata = (): CohortMetadata => ({ schemaVersion: 1, preferred: null, cohorts: {}, pins: {}, tickets: {} });
const failure = (detail: string) => new Error(`SplatView offline storage is unavailable: ${detail} Reconnect and retry.`);
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
function cancelBody(response: Response): void { void response.body?.cancel().catch(() => undefined); }

export function normalizeOfflineBase(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/'))
    throw failure('the application scope is invalid.');
  return url.href;
}
/** Percent encoding is injective, and avoids collisions between root and project deployments. */
export function offlineStoragePrefix(base: string): string { return `${CACHE_SCHEMA}${encodeURIComponent(normalizeOfflineBase(base))}-`; }

/** Read and write the single metadata record in one IDB transaction, including across worker restarts. */
export function indexedMetadataStore(name: string, factory: IDBFactory = indexedDB): MetadataStore {
  let connection: Promise<IDBDatabase> | undefined;
  const database = () => connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('metadata')) request.result.createObjectStore('metadata'); };
    request.onerror = () => { connection = undefined; reject(request.error ?? failure('the metadata database could not open.')); };
    request.onblocked = () => reject(failure('another application-cache version is holding its metadata database.'));
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); connection = undefined; }; resolve(db); };
  });
  const transaction = async <T>(write: boolean, change: (metadata: CohortMetadata) => T): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction('metadata', write ? 'readwrite' : 'readonly'), store = tx.objectStore('metadata');
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? failure('the metadata transaction was interrupted.'));
      const request = store.get('state');
      request.onerror = () => { try { tx.abort(); } catch { /* Already aborted. */ } };
      request.onsuccess = () => {
        try {
          const metadata = request.result === undefined ? emptyMetadata() : request.result as CohortMetadata;
          if (metadata.schemaVersion !== 1 || !metadata.cohorts || !metadata.pins || !metadata.tickets)
            throw failure('the metadata schema is not supported.');
          result = change(metadata);
          if (write) store.put(metadata, 'state');
        } catch (error) { reject(error); try { tx.abort(); } catch { /* Already aborted. */ } }
      };
    });
  };
  return { read: () => transaction(false, metadata => metadata), update: change => transaction(true, change) };
}

async function boundedBytes(response: Response, url: string, maximumBytes: number, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (!response.ok || response.redirected || response.url !== url) {
    cancelBody(response); throw failure(`the response for ${new URL(url).pathname} is unavailable or redirected.`);
  }
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    cancelBody(response); throw failure('an application response exceeds its verified size.');
  }
  if (!response.body) throw failure('an application response has no readable bytes.');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let length = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) throw failure('an application response exceeds its verified size.');
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes.buffer;
  // A cloned response is a tee. Awaiting only this branch's cancellation would
  // wait for its unconsumed sibling and could prevent a bounded refusal forever.
  } catch (error) { void reader.cancel().catch(() => undefined); throw error; }
  finally { reader.releaseLock(); }
}

async function parseManifest(bytes: ArrayBuffer, manifestUrl: string): Promise<VerifiedManifest> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw failure('the application manifest is not valid UTF-8 JSON.'); }
  if (!value || typeof value !== 'object') throw failure('the application manifest is missing.');
  const raw = value as RuntimeManifest;
  const descriptor = parseBuildDescriptor(raw.build);
  const entries = Array.isArray(raw.artifacts) ? raw.artifacts.filter(artifact => artifact?.role === 'application-entry') : [];
  if (entries.length !== 1 || typeof entries[0].path !== 'string') throw failure('the application entry is ambiguous.');
  // validateManifest supplies the path, digest, closure, byte-budget and singleton checks.
  return validateManifest(value, manifestUrl, new URL(entries[0].path, new URL('.', manifestUrl)).href, descriptor);
}

/** A complete cache is immutable. Only a successful readback transaction makes it discoverable. */
export class CohortStore {
  readonly base: string;
  readonly prefix: string;
  readonly manifestUrl: string;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly installing = new Set<string>();
  private readonly stages = new Map<string, Promise<AcceptedCohort>>();
  private admissions = 0;
  constructor(base: string, private readonly environment: CohortEnvironment) {
    this.base = normalizeOfflineBase(base); this.prefix = offlineStoragePrefix(this.base);
    this.manifestUrl = new URL('build-manifest.json', this.base).href;
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work); this.queue = next.then(() => undefined, () => undefined); return next;
  }
  private async changed(): Promise<void> { await this.environment.changed?.().catch(() => undefined); }
  private async network(url: string, maximumBytes: number, signal: AbortSignal): Promise<{ response: Response; bytes: ArrayBuffer }> {
    const response = await this.environment.fetch(url, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal });
    try { const bytes = await boundedBytes(response.clone(), url, maximumBytes, signal); return { response, bytes }; }
    catch (error) { cancelBody(response); throw error; }
  }
  private inventory(record: CohortRecord): Set<string> {
    if (!Array.isArray(record.artifactUrls) || record.artifactUrls.length < 1 || record.artifactUrls.length > 4096)
      throw failure('the saved application inventory is invalid.');
    const urls = new Set<string>();
    for (const value of record.artifactUrls) {
      if (typeof value !== 'string' || value.length > 8192) throw failure('a saved application inventory URL is invalid.');
      const url = new URL(value);
      if (url.href !== value || !this.inScope(url) || url.username || url.password || url.search || url.hash || value === this.manifestUrl || urls.has(value))
        throw failure('a saved application inventory URL is invalid.');
      urls.add(value);
    }
    return urls;
  }
  private async inspect(record: CohortRecord): Promise<AcceptedCohort> {
    if (!record.cacheName.startsWith(this.prefix) || !isDeploymentId(record.deploymentId)) throw failure('an application cache has an invalid owner.');
    if (!(await this.environment.caches.keys()).includes(record.cacheName)) throw failure('this application version was evicted from browser storage.');
    const cache = await this.environment.caches.open(record.cacheName), manifestResponse = await cache.match(this.manifestUrl);
    if (!manifestResponse) throw failure('the saved application manifest is missing.');
    const manifestBytes = await boundedBytes(manifestResponse, this.manifestUrl, MAX_MANIFEST_BYTES);
    if (manifestBytes.byteLength !== record.manifestBytes || await sha256(manifestBytes) !== record.manifestSha256)
      throw failure('the exact saved application manifest bytes changed.');
    const verified = await parseManifest(manifestBytes, this.manifestUrl);
    if (verified.manifest.deploymentId !== record.deploymentId || verified.assetBase !== this.base) throw failure('the saved application identity differs.');
    const inventory = this.inventory(record);
    if (inventory.size !== verified.artifacts.size || [...verified.artifacts.keys()].some(url => !inventory.has(url))) throw failure('the saved application inventory differs from its manifest.');
    const expected = new Set([this.manifestUrl, ...verified.artifacts.keys()]);
    const keys = await cache.keys();
    if (keys.length !== expected.size || keys.some(request => !expected.has(request.url))) throw failure('the saved application cache is incomplete or contains unlisted data.');
    const rows = [...verified.artifacts.values()];
    for (let first = 0; first < rows.length; first += INSTALL_PARALLELISM) {
      await Promise.all(rows.slice(first, first + INSTALL_PARALLELISM).map(async ({ artifact, url }) => {
        const response = await cache.match(url); if (!response) throw failure('a saved application asset was evicted.');
        await verifyArtifactBytes(await boundedBytes(response, url, artifact.bytes), artifact);
      }));
    }
    return { record, verified, cache };
  }
  private async accepted(id: string): Promise<AcceptedCohort> {
    const record = (await this.environment.metadata.read()).cohorts[id];
    if (!record) throw failure('this application version has not been completely saved.');
    return this.inspect(record);
  }
  private async fetchStage(expectedId?: string): Promise<AcceptedCohort> {
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(failure('saving the application timed out.')), INSTALL_TIMEOUT_MS);
    let cacheName: string | undefined;
    try {
      const manifest = await this.network(this.manifestUrl, MAX_MANIFEST_BYTES, abort.signal);
      const verified = await parseManifest(manifest.bytes, this.manifestUrl), id = verified.manifest.deploymentId;
      if (expectedId && id !== expectedId) throw failure('the host has already changed to a different application version.');
      const existing = (await this.environment.metadata.read()).cohorts[id];
      if (existing) {
        try {
          const accepted = await this.inspect(existing);
          abort.signal.throwIfAborted();
          await this.serial(() => this.environment.metadata.update(metadata => { if (metadata.cohorts[id]?.cacheName === existing.cacheName) metadata.preferred = id; }));
          await this.changed();
          return accepted;
        } catch { /* A damaged complete cohort may be replaced only by a new fully verified staging cache. */ }
      }
      cacheName = `${this.prefix}${id}-${this.environment.token()}`;
      this.installing.add(cacheName);
      const cache = await this.environment.caches.open(cacheName);
      await cache.put(this.manifestUrl, manifest.response);
      const rows = [...verified.artifacts.values()];
      for (let first = 0; first < rows.length; first += INSTALL_PARALLELISM) {
        await Promise.all(rows.slice(first, first + INSTALL_PARALLELISM).map(async ({ artifact, url }) => {
          const fetched = await this.network(url, artifact.bytes, abort.signal);
          await verifyArtifactBytes(fetched.bytes, artifact); await cache.put(url, fetched.response);
        }));
      }
      const record: CohortRecord = { deploymentId: id, cacheName, completedAt: this.environment.now(), manifestBytes: manifest.bytes.byteLength,
        manifestSha256: await sha256(manifest.bytes), artifactUrls: [...verified.artifacts.keys()] };
      let accepted = await this.inspect(record);
      abort.signal.throwIfAborted();
      const published = await this.serial(() => this.environment.metadata.update(metadata => {
        abort.signal.throwIfAborted();
        const concurrent = metadata.cohorts[id];
        // Concurrent PIN/current and update checks may download the same
        // identity. A completed, newly published equal cohort wins; avoid
        // changing cache ownership beneath an admitted navigation.
        if (concurrent && concurrent.cacheName !== existing?.cacheName) { metadata.preferred = id; return concurrent; }
        metadata.cohorts[id] = record; metadata.preferred = id; return record;
      }));
      if (published.cacheName !== record.cacheName) {
        await this.environment.caches.delete(record.cacheName); accepted = await this.inspect(published);
      }
      await this.changed(); return accepted;
    } catch (error) {
      if (cacheName) await this.environment.caches.delete(cacheName).catch(() => false);
      throw failure(errorText(error));
    } finally { clearTimeout(timer); abort.abort(); if (cacheName) this.installing.delete(cacheName); }
  }
  /** Downloads are outside the metadata queue; a slow install never blocks an existing tab's cache reads. */
  stage(expectedId?: string): Promise<AcceptedCohort> {
    const key = expectedId ?? '*', existing = this.stages.get(key); if (existing) return existing;
    const stage = this.fetchStage(expectedId); this.stages.set(key, stage);
    void stage.then(() => { if (this.stages.get(key) === stage) this.stages.delete(key); }, () => { if (this.stages.get(key) === stage) this.stages.delete(key); });
    return stage;
  }
  async pin(clientId: string, deploymentId: string, sessionId: string): Promise<OfflineStatus> {
    await this.serial(() => this.environment.metadata.update(metadata => {
      const pin = metadata.pins[clientId];
      if (pin && (pin.deploymentId !== deploymentId || pin.sessionId !== null && pin.sessionId !== sessionId))
        throw failure('this live tab changed its application owner.');
      metadata.pins[clientId] = { deploymentId, sessionId, offered: pin?.offered ?? null };
    }));
    // The executing page has already passed its ordinary production gate. Its
    // identity remains useful when the host rolls forward before caching starts.
    // It may explicitly update to a newer complete cohort, while cache misses for
    // its own identity continue to fail closed.
    let installationError: string | undefined;
    try { await this.accepted(deploymentId); }
    catch { try { await this.stage(deploymentId); } catch (error) { installationError = errorText(error); } }
    const status = await this.status(clientId);
    return installationError ? { ...status, error: installationError } : status;
  }
  async status(clientId: string): Promise<OfflineStatus> {
    const metadata = await this.environment.metadata.read(), pin = metadata.pins[clientId];
    let ready = false, error: string | undefined;
    if (pin) { try { await this.accepted(pin.deploymentId); ready = true; } catch (caught) { error = errorText(caught); } }
    const available = await this.serial(() => this.environment.metadata.update(state => {
      const current = state.pins[clientId]; if (!current) return null;
      if (current.offered && !state.cohorts[current.offered]) current.offered = null;
      if (!current.offered && state.preferred && state.preferred !== current.deploymentId && state.cohorts[state.preferred]) current.offered = state.preferred;
      return current.offered === current.deploymentId ? null : current.offered;
    }));
    const latest = await this.environment.metadata.read();
    return { current: pin?.deploymentId ?? null, preferred: latest.preferred, ready, available, ...(error ? { error } : {}) };
  }
  async checkUpdate(clientId: string): Promise<OfflineStatus> {
    if (!(await this.environment.metadata.read()).pins[clientId]) throw failure('this tab has not pinned a verified application.');
    const offered = await this.stage();
    await this.serial(() => this.environment.metadata.update(metadata => {
      const pin = metadata.pins[clientId]; if (!pin) throw failure('the requesting tab no longer owns an application cache.');
      if (!metadata.cohorts[offered.record.deploymentId]) throw failure('the new application cache was retired.');
      pin.offered = offered.record.deploymentId === pin.deploymentId ? null : offered.record.deploymentId;
    }));
    await this.changed(); return this.status(clientId);
  }
  async prepareNavigation(clientId: string, deploymentId: string, sessionId: string, requestId: string): Promise<{ status: OfflineStatus; ticket: string }> {
    try { return await this.prepareOwnedNavigation(clientId, deploymentId, sessionId, requestId); }
    catch (error) {
      // An explicit refusal is terminal for this logical request. If recording
      // that fence fails, the adapter deliberately withholds acknowledgement so
      // the page retains and retries the same request identity.
      try {
        await this.serial(() => this.environment.metadata.update(metadata => {
          const receipts = Object.values(metadata.tickets).filter(ticket => ticket.clientId === clientId);
          const matching = receipts.filter(ticket => ticket.sessionId === sessionId && ticket.requestId === requestId);
          for (const ticket of matching) if (ticket.disposition === 'unused') ticket.disposition = 'cancelled';
          // A refusal whose acknowledgement is lost is still the same terminal
          // logical request on retry. Keep a tombstone even if no capability
          // was minted before the failure. A full receipt set remains full
          // until the owner closes, so it cannot later remint the refused id.
          if (!matching.length && receipts.length < 32) {
            const token = this.environment.token(); if (metadata.tickets[token]) throw failure('a navigation receipt collision occurred.');
            metadata.tickets[token] = { clientId, sessionId, deploymentId, requestId, disposition: 'cancelled' };
          }
        }));
      } catch { throw new OfflineUnknownOutcome('The application navigation outcome could not be recorded. Retry the same request.'); }
      throw error;
    }
  }
  private async prepareOwnedNavigation(clientId: string, deploymentId: string, sessionId: string, requestId: string): Promise<{ status: OfflineStatus; ticket: string }> {
    const previous = Object.entries((await this.environment.metadata.read()).tickets).find(([, ticket]) =>
      ticket.clientId === clientId && ticket.sessionId === sessionId && ticket.requestId === requestId);
    if (previous) {
      if (previous[1].deploymentId !== deploymentId) throw failure('a navigation request was reused for a different application.');
      if (previous[1].disposition !== 'unused') throw failure(`this application navigation request was already ${previous[1].disposition}.`);
      await this.accepted(deploymentId);
      return { status: await this.status(clientId), ticket: previous[0] };
    }
    await this.accepted(deploymentId);
    const ticket = await this.serial(() => this.environment.metadata.update(metadata => {
      const pin = metadata.pins[clientId];
      if (!pin || pin.sessionId !== sessionId || deploymentId !== pin.deploymentId && deploymentId !== pin.offered)
        throw failure('this tab does not own the selected application update.');
      const duplicate = Object.entries(metadata.tickets).find(([, value]) => value.clientId === clientId && value.sessionId === sessionId && value.requestId === requestId);
      if (duplicate) {
        if (duplicate[1].deploymentId !== deploymentId) throw failure('a navigation request was reused for a different application.');
        if (duplicate[1].disposition !== 'unused') throw failure(`this application navigation request was already ${duplicate[1].disposition}.`);
        return duplicate[0];
      }
      if (Object.values(metadata.tickets).filter(ticket => ticket.clientId === clientId).length >= 32)
        throw failure('this tab has reached its application update request limit. Close and reopen it after saving your scene.');
      const token = this.environment.token();
      if (metadata.tickets[token]) throw failure('a navigation ticket collision occurred.');
      metadata.tickets[token] = { clientId, sessionId, deploymentId, requestId, disposition: 'unused' }; return token;
    }));
    return { status: await this.status(clientId), ticket };
  }
  async cancelNavigation(clientId: string, ticket: string): Promise<OfflineStatus> {
    await this.serial(() => this.environment.metadata.update(metadata => {
      const found = metadata.tickets[ticket];
      if (!found || found.clientId !== clientId) throw failure('this tab does not own that navigation request.');
      if (found.disposition === 'consumed') throw failure('that application navigation ticket was already consumed.');
      found.disposition = 'cancelled';
    }));
    return this.status(clientId);
  }
  /** Exact target admission happens before HTML is returned, so its first asset fetch has a durable pin. */
  async navigate(requestUrl: string, owner: NavigationOwner): Promise<Response> {
    this.admissions++;
    try {
      if (!owner.resultingClientId) throw failure('the browser did not identify the destination tab.');
      const url = new URL(requestUrl);
      if (!this.isApplicationNavigation(url)) throw failure('the navigation is outside the application scope.');
      const tickets = url.searchParams.getAll(UPDATE_QUERY);
      let accepted: AcceptedCohort, ticket: string | undefined;
      if (tickets.length) {
        if (tickets.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/.test(tickets[0])) throw failure('the selected application update ticket is invalid.');
        ticket = tickets[0];
        const state = await this.environment.metadata.read(), selected = state.tickets[ticket];
        if (!selected || !this.ticketOwned(selected, state, owner))
          throw failure('the selected application update is no longer owned by this tab.');
        accepted = await this.accepted(selected.deploymentId);
      } else {
        const metadata = await this.environment.metadata.read();
        const previous = metadata.pins[owner.replacesClientId] ?? metadata.pins[owner.clientId];
        if (previous) {
          try { accepted = await this.accepted(previous.deploymentId); }
          catch { accepted = await this.stage(previous.deploymentId); }
        }
        else {
          try { accepted = await this.stage(); }
          catch (error) {
            const fallback = await this.fallback(); if (!fallback) throw error; accepted = fallback;
          }
        }
      }
      const admitted = accepted;
      await this.serial(() => this.environment.metadata.update(metadata => {
        if (metadata.cohorts[admitted.record.deploymentId]?.cacheName !== admitted.record.cacheName)
          throw failure('the selected application cache changed before navigation.');
        if (ticket) {
          const selected = metadata.tickets[ticket];
          if (!selected || selected.deploymentId !== admitted.record.deploymentId || !this.ticketOwned(selected, metadata, owner))
            throw failure('the selected application update ticket was already consumed.');
          selected.disposition = 'consumed';
        }
        const current = metadata.pins[owner.resultingClientId];
        if (current && current.deploymentId !== admitted.record.deploymentId) throw failure('the destination tab already owns another application.');
        metadata.pins[owner.resultingClientId] = { deploymentId: admitted.record.deploymentId, sessionId: null, offered: null, navigation: 'reserved' };
      }));
      const html = [...accepted.verified.artifacts.values()].find(row => row.artifact.role === 'html');
      if (!html) throw failure('the saved application page is missing.');
      return await this.artifact(accepted, html.url);
    } catch (error) { return offlineUnavailable(errorText(error), this.base); }
    finally { this.admissions--; }
  }
  private ticketOwned(ticket: NavigationTicket, state: CohortMetadata, owner: NavigationOwner): boolean {
    const pin = state.pins[ticket.clientId], supplied = [owner.clientId, owner.replacesClientId].filter(Boolean);
    // Some navigation modes omit both source fields. The unguessable durable
    // ticket still names a verified live owner; any supplied browser identity
    // must agree with that owner, and the resulting client remains mandatory.
    return ticket.disposition === 'unused' && !!pin && pin.sessionId === ticket.sessionId && supplied.every(id => id === ticket.clientId);
  }
  async settleNavigation(clientId: string, exists: boolean | 'unknown'): Promise<void> {
    if (!clientId || exists === 'unknown') return;
    await this.serial(() => this.environment.metadata.update(metadata => {
      const pin = metadata.pins[clientId]; if (!pin || pin.navigation !== 'reserved') return;
      if (!exists && pin.sessionId === null) delete metadata.pins[clientId];
      else pin.navigation = 'handled';
    }));
  }
  async retirementFence(): Promise<Record<string, ClientPin>> { return (await this.environment.metadata.read()).pins; }
  private async fallback(): Promise<AcceptedCohort | undefined> {
    const state = await this.environment.metadata.read();
    const ordered = Object.values(state.cohorts).sort((a, b) => b.completedAt - a.completedAt || a.deploymentId.localeCompare(b.deploymentId));
    if (state.preferred) ordered.sort((a, b) => Number(b.deploymentId === state.preferred) - Number(a.deploymentId === state.preferred));
    for (const record of ordered) { try { return await this.inspect(record); } catch { /* Try another completely validated fallback, never a partial cache. */ } }
  }
  isApplicationNavigation(url: URL): boolean {
    const base = new URL(this.base);
    return url.origin === base.origin && (url.pathname === base.pathname || url.pathname === `${base.pathname}index.html`);
  }
  inScope(url: URL): boolean { const base = new URL(this.base); return url.origin === base.origin && url.pathname.startsWith(base.pathname); }
  private async artifact(cohort: AcceptedCohort, url: string): Promise<Response> {
    const response = await cohort.cache.match(url); if (!response) throw failure('a saved application asset was evicted.');
    try {
    if (url === this.manifestUrl) {
      const bytes = await boundedBytes(response.clone(), url, MAX_MANIFEST_BYTES);
      if (bytes.byteLength !== cohort.record.manifestBytes || await sha256(bytes) !== cohort.record.manifestSha256)
        throw failure('the exact saved application manifest bytes changed.');
      const verified = await parseManifest(bytes, this.manifestUrl);
      if (verified.manifest.deploymentId !== cohort.record.deploymentId) throw failure('the saved application manifest changed.');
    } else {
      const row = cohort.verified.artifacts.get(url); if (!row) throw failure('the requested asset is not in this application version.');
      await verifyArtifactBytes(await boundedBytes(response.clone(), url, row.artifact.bytes), row.artifact);
    }
      return response;
    } catch (error) { cancelBody(response); throw error; }
  }
  /** undefined means an unrelated request: leave it to the browser/network without caching it. */
  async fetchForClient(clientId: string, requestUrl: string): Promise<Response | undefined> {
    const url = new URL(requestUrl);
    if (!this.inScope(url) || url.search || url.hash) return;
    const pin = (await this.environment.metadata.read()).pins[clientId]; if (!pin) return;
    try {
      const record = (await this.environment.metadata.read()).cohorts[pin.deploymentId];
      if (!record) throw failure('this tab\'s saved application version is missing.');
      const inventory = this.inventory(record);
      if (requestUrl !== this.manifestUrl && !inventory.has(requestUrl)) return;
      if (record.deploymentId !== pin.deploymentId || !record.cacheName.startsWith(this.prefix) || !(await this.environment.caches.keys()).includes(record.cacheName))
        throw failure('this tab\'s saved application cache was evicted.');
      const cache = await this.environment.caches.open(record.cacheName), manifestResponse = await cache.match(this.manifestUrl);
      if (!manifestResponse) throw failure('this tab\'s saved manifest was evicted.');
      const manifestBytes = await boundedBytes(manifestResponse, this.manifestUrl, MAX_MANIFEST_BYTES);
      if (manifestBytes.byteLength !== record.manifestBytes || await sha256(manifestBytes) !== record.manifestSha256)
        throw failure('the exact saved application manifest bytes changed.');
      const verified = await parseManifest(manifestBytes, this.manifestUrl);
      if (verified.manifest.deploymentId !== pin.deploymentId) throw failure('this tab\'s saved application identity changed.');
      if (inventory.size !== verified.artifacts.size || [...verified.artifacts.keys()].some(url => !inventory.has(url))) throw failure('the saved application inventory differs from its manifest.');
      if (requestUrl !== this.manifestUrl && !verified.artifacts.has(requestUrl)) return;
      return await this.artifact({ record, cache, verified }, requestUrl);
    } catch (error) { return offlineUnavailable(errorText(error), this.base, false); }
  }
  /** Unknown/unresponsive clients prevent complete-cache deletion. Closed owners can be retired from a fresh client snapshot. */
  async collect(clients: readonly ReconciledClient[], expectedPins?: Record<string, ClientPin>): Promise<{ deleted: string[]; deferred: boolean }> {
    const fence = expectedPins ?? await this.retirementFence();
    return this.serial(async () => {
      if (this.installing.size || this.stages.size || this.admissions) return { deleted: [], deferred: true };
      const live = new Set(clients.map(client => client.id));
      const retirement = await this.environment.metadata.update(metadata => {
        if (this.installing.size || this.stages.size || this.admissions) return {
          deferred: true, retained: new Set(Object.values(metadata.cohorts).map(record => record.cacheName)),
        };
        const changed = new Set(Object.keys(metadata.pins).filter(id => !fence[id] || JSON.stringify(metadata.pins[id]) !== JSON.stringify(fence[id])));
        const reserved = new Set(Object.keys(metadata.pins).filter(id => metadata.pins[id].sessionId === null && metadata.pins[id].navigation !== 'handled'));
        const deferred = changed.size > 0 || reserved.size > 0 || clients.some(client => {
          const pin = metadata.pins[client.id];
          return !pin || !client.deploymentId || !client.sessionId || pin.deploymentId !== client.deploymentId || pin.sessionId !== client.sessionId;
        });
        for (const clientId of Object.keys(metadata.pins)) if (!live.has(clientId) && !changed.has(clientId) && !reserved.has(clientId)) delete metadata.pins[clientId];
        for (const [ticket, owner] of Object.entries(metadata.tickets)) if (!live.has(owner.clientId) && !metadata.pins[owner.clientId]) delete metadata.tickets[ticket];
        const keep = new Set<string>();
        for (const pin of Object.values(metadata.pins)) { keep.add(pin.deploymentId); if (pin.offered) keep.add(pin.offered); }
        for (const ticket of Object.values(metadata.tickets)) if (ticket.disposition === 'unused') keep.add(ticket.deploymentId);
        const newest = Object.values(metadata.cohorts).sort((a, b) => b.completedAt - a.completedAt || a.deploymentId.localeCompare(b.deploymentId));
        for (const record of newest.slice(0, 2)) keep.add(record.deploymentId);
        if (metadata.preferred) keep.add(metadata.preferred);
        if (!deferred) for (const id of Object.keys(metadata.cohorts)) if (!keep.has(id)) delete metadata.cohorts[id];
        return { deferred, retained: new Set(Object.values(metadata.cohorts).map(record => record.cacheName)) };
      });
      const deleted: string[] = [];
      // Without a complete ownership round, a physical cache absent from IDB
      // could be a complete cache whose metadata was evicted, rather than an
      // abandoned staging cache. Do not infer permission to destroy it.
      if (retirement.deferred || this.installing.size || this.stages.size || this.admissions) return { deleted, deferred: true };
      for (const name of await this.environment.caches.keys()) {
        if (!name.startsWith(this.prefix) || retirement.retained.has(name) || this.installing.has(name)) continue;
        if (await this.environment.caches.delete(name)) deleted.push(name);
      }
      return { deleted, deferred: retirement.deferred };
    });
  }
}

/** A failed admission is a static, accessible response; neither cached code nor server error text executes. */
export function offlineUnavailable(detail: string, base: string, html = true): Response {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
  const body = html ? `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SplatView offline unavailable</title><body><main><h1>SplatView is unavailable offline</h1><p role="alert">${escape(detail.slice(0, 4096))}</p><p>Reconnect to the internet to save a complete application version, then retry.</p><a href="${escape(base)}">Retry SplatView</a></main></body></html>` : detail.slice(0, 4096);
  return new Response(body, { status: 503, headers: { 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' } });
}
