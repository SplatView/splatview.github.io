import type { ImageOperation } from './image';
import type { SourceFingerprint } from './fingerprint';
import { AdmissionError } from '../document/resources';
import { MAX_SAVED_THUMBNAIL_BYTES, MAX_SAVED_VIEW_RECORD_BYTES, savedViewMatches, validateSavedViewRecord, type SavedViewRecord } from './savedView';
import { checkSavedViewOperation, verifySavedThumbnail } from './thumbnail';

const MAX_MATCHES = 64;
export const SAVED_VIEW_DATABASE = 'splatview-views';
export const SAVED_VIEW_RETENTION_BYTES = MAX_SAVED_VIEW_RECORD_BYTES * 2 + 2048;
type StoredView = { recordId: string; source: { assetDigest: string }; binding: string; createdAt: number; updatedAt: number; imageBytes: number; meta: Blob };
type Pair = { stored: StoredView; image: unknown };
export type SavedViewLookup = { records: readonly SavedViewRecord[]; corrupt: boolean; dispose(): void };
export type SavedViewPair = { record: SavedViewRecord; image: Blob; dispose(): void };
const binding = (record: SavedViewRecord) => JSON.stringify([record.source.scheme, record.source.assetDigest, record.source.resourceCount,
  record.source.totalBytes, record.source.sourceKindHint, record.sourceKind]);
function storedView(value: unknown): StoredView {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved-view storage envelope.');
  const item = value as StoredView;
  if (Object.keys(item).sort().join(',') !== 'binding,createdAt,imageBytes,meta,recordId,source,updatedAt' ||
      typeof item.recordId !== 'string' || item.recordId.length < 1 || item.recordId.length > MAX_SAVED_VIEW_RECORD_BYTES ||
      !item.source || typeof item.source !== 'object' || Array.isArray(item.source) ||
      Object.keys(item.source).join(',') !== 'assetDigest' || typeof item.source.assetDigest !== 'string' || !/^[0-9a-f]{64}$/.test(item.source.assetDigest) ||
      typeof item.binding !== 'string' || item.binding.length > 1024 ||
      !Number.isSafeInteger(item.createdAt) || item.createdAt < 0 || !Number.isSafeInteger(item.updatedAt) || item.updatedAt < item.createdAt ||
      !Number.isSafeInteger(item.imageBytes) || item.imageBytes < 1 || item.imageBytes > MAX_SAVED_THUMBNAIL_BYTES ||
      !(item.meta instanceof Blob) || item.meta.type !== 'application/json' || item.meta.size < 1 || item.meta.size > MAX_SAVED_VIEW_RECORD_BYTES)
    throw new Error('Invalid or unsupported saved-view storage envelope.');
  return item;
}
async function readStoredView(item: StoredView, operation: ImageOperation): Promise<SavedViewRecord> {
  // Bounded UTF-8 body plus conservative parse/object workspace, including corrupt JSON.
  const release = operation.admit(MAX_SAVED_VIEW_RECORD_BYTES * 128);
  try {
    checkSavedViewOperation(operation);
    const bytes = await item.meta.arrayBuffer(); checkSavedViewOperation(operation);
    const record = validateSavedViewRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (record.recordId !== item.recordId || record.source.assetDigest !== item.source.assetDigest || binding(record) !== item.binding ||
        record.createdAt !== item.createdAt || record.updatedAt !== item.updatedAt || record.thumbnail.byteLength !== item.imageBytes)
      throw new Error('The saved view does not match its storage envelope.');
    return record;
  } finally { release(); }
}

/** An atomic view/PNG pair. Neither store alone is a restoration candidate. */
export class SavedViewStorage {
  constructor(private factory: () => IDBFactory = () => globalThis.indexedDB) {}
  private open(operation: ImageOperation): Promise<IDBDatabase> {
    checkSavedViewOperation(operation);
    return new Promise((resolve, reject) => {
      let request: IDBOpenDBRequest, settled = false;
      const finish = (error?: unknown, database?: IDBDatabase) => {
        if (settled) { database?.close(); return; }
        settled = true; operation.signal?.removeEventListener('abort', cancel);
        if (error) reject(error); else resolve(database!);
      };
      const cancel = () => finish(operation.signal?.reason ?? new DOMException('Saved view cancelled', 'AbortError'));
      try {
        const factory = this.factory();
        if (!factory) throw new Error('Saved views are unavailable in this browser.');
        request = factory.open(SAVED_VIEW_DATABASE, 1);
        request.onupgradeneeded = () => {
          if (settled) { request.transaction?.abort(); return; }
          const records = request.result.createObjectStore('views', { keyPath: 'recordId' });
          records.createIndex('digest', 'source.assetDigest');
          request.result.createObjectStore('thumbnails', { keyPath: 'recordId' });
        };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); finish(undefined, request.result); };
        request.onerror = () => finish(request.error ?? new Error('Could not open saved views.'));
        request.onblocked = () => finish(new Error('Saved views are in use by another application version. Close its tab and retry.'));
        operation.signal?.addEventListener('abort', cancel, { once: true });
        if (operation.signal?.aborted) cancel();
      } catch (error) { finish(error); }
    });
  }
  private transaction<T>(database: IDBDatabase, mode: IDBTransactionMode, operation: ImageOperation,
    run: (transaction: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    checkSavedViewOperation(operation);
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(['views', 'thumbnails'], mode);
      let value: T, failure: unknown;
      const fail = (error: unknown) => { failure = error; try { transaction.abort(); } catch { /* Already terminal. */ } };
      const cancel = () => fail(operation.signal?.reason ?? new DOMException('Saved view cancelled', 'AbortError'));
      const clean = () => operation.signal?.removeEventListener('abort', cancel);
      transaction.oncomplete = () => {
        clean(); try { checkSavedViewOperation(operation); resolve(value); } catch (error) { reject(error); }
      };
      transaction.onabort = () => { clean(); reject(failure ?? transaction.error ?? new Error('Could not store the saved view.')); };
      transaction.onerror = () => { failure ??= transaction.error; };
      operation.signal?.addEventListener('abort', cancel, { once: true });
      try { checkSavedViewOperation(operation); run(transaction, next => { value = next; }, fail); }
      catch (error) { fail(error); }
    });
  }
  async list(source: SourceFingerprint, kind: SavedViewRecord['sourceKind'], operation: ImageOperation): Promise<SavedViewLookup> {
    // IndexedDB clones bounded envelopes/Blob handles, never a whole JSON tree.
    // Legacy raw-object records are unsupported and excluded from restoration.
    const release = operation.admit((MAX_MATCHES + 1) * SAVED_VIEW_RETENTION_BYTES);
    const imageOwners: (() => void)[] = [];
    let retained: (() => void) | undefined;
    let database: IDBDatabase | undefined;
    try {
      database = await this.open(operation);
      const found = await this.transaction<{ pairs: Pair[]; corrupt: boolean }>(database, 'readonly', operation, (transaction, result, fail) => {
        const request = transaction.objectStore('views').index('digest').getAll(source.assetDigest, MAX_MATCHES + 1);
        request.onsuccess = () => {
          try {
            checkSavedViewOperation(operation);
            if (request.result.length > MAX_MATCHES) throw new Error('Too many saved views match this content.');
            const output: { pairs: Pair[]; corrupt: boolean } = { pairs: [], corrupt: false }; result(output);
            for (const value of request.result as unknown[]) {
              let item: StoredView;
              try { item = storedView(value); }
              catch { output.corrupt = true; continue; }
              imageOwners.push(operation.admit(item.imageBytes));
              const image = transaction.objectStore('thumbnails').get(item.recordId);
              image.onsuccess = () => { output.pairs.push({ stored: item, image: image.result?.image }); };
            }
          } catch (error) { fail(error); }
        };
      });
      const records: SavedViewRecord[] = []; let corrupt = found.corrupt;
      for (const pair of found.pairs) {
        try {
          const record = await readStoredView(pair.stored, operation);
          if (!savedViewMatches(record, source, kind)) throw new Error('The saved source identity does not match.');
          await verifySavedThumbnail(record, pair.image, operation); records.push(record);
        }
        catch (error) {
          checkSavedViewOperation(operation);
          if (error instanceof AdmissionError || error instanceof Error && error.name === 'AbortError') throw error;
          corrupt = true;
        }
      }
      checkSavedViewOperation(operation);
      records.sort((a, b) => b.updatedAt - a.updatedAt || (a.recordId < b.recordId ? -1 : a.recordId === b.recordId ? 0 : 1));
      if (records.length) retained = operation.admit(records.length * SAVED_VIEW_RETENTION_BYTES);
      checkSavedViewOperation(operation);
      let owner = retained; retained = undefined;
      return { records: Object.freeze(records), corrupt, dispose() { owner?.(); owner = undefined; } };
    } finally { retained?.(); database?.close(); for (const owner of imageOwners) owner(); release(); }
  }
  /** Read exactly one atomic, validated pair and retain its Blob/metadata until disposal. */
  async get(recordId: string, operation: ImageOperation): Promise<SavedViewPair> {
    checkSavedViewOperation(operation);
    if (typeof recordId !== 'string' || recordId.length < 1 || recordId.length > MAX_SAVED_VIEW_RECORD_BYTES)
      throw new Error('Invalid saved-view record ID.');
    let recordOwner: (() => void) | undefined = operation.admit(SAVED_VIEW_RETENTION_BYTES);
    let imageOwner: (() => void) | undefined, database: IDBDatabase | undefined;
    try {
      database = await this.open(operation);
      const pair = await this.transaction<Pair>(database, 'readonly', operation, (transaction, result, fail) => {
        const request = transaction.objectStore('views').get(recordId);
        request.onsuccess = () => {
          try {
            checkSavedViewOperation(operation);
            const item = storedView(request.result);
            if (item.recordId !== recordId) throw new Error('The saved-view record ID changed.');
            // An imported PNG may share the backing of its bounded two-member ZIP.
            // IndexedDB cloning does not preserve the original Blob's WeakMap identity.
            imageOwner = operation.admit(item.imageBytes + MAX_SAVED_VIEW_RECORD_BYTES + 2048);
            const image = transaction.objectStore('thumbnails').get(recordId);
            image.onsuccess = () => result({ stored: item, image: image.result?.image });
          } catch (error) { fail(error); }
        };
      });
      const record = await readStoredView(pair.stored, operation);
      const image = await verifySavedThumbnail(record, pair.image, operation);
      checkSavedViewOperation(operation);
      let retainedRecord: (() => void) | undefined = recordOwner, retainedImage: (() => void) | undefined = imageOwner;
      recordOwner = imageOwner = undefined;
      return { record, image, dispose() {
        retainedImage?.(); retainedRecord?.(); retainedImage = retainedRecord = undefined;
      } };
    } finally { database?.close(); imageOwner?.(); recordOwner?.(); }
  }
  async put(input: SavedViewRecord, image: Blob, operation: ImageOperation): Promise<SavedViewRecord> {
    checkSavedViewOperation(operation);
    const release = operation.admit(MAX_SAVED_VIEW_RECORD_BYTES * 2 + 1024);
    let database: IDBDatabase | undefined;
    try {
      const record = validateSavedViewRecord(input); await verifySavedThumbnail(record, image, operation);
      const item: StoredView = { recordId: record.recordId, source: { assetDigest: record.source.assetDigest }, binding: binding(record),
        createdAt: record.createdAt, updatedAt: record.updatedAt, imageBytes: image.size,
        meta: new Blob([JSON.stringify(record)], { type: 'application/json' }) };
      storedView(item);
      database = await this.open(operation);
      await this.transaction<void>(database, 'readwrite', operation, (transaction, result, fail) => {
        const views = transaction.objectStore('views'), previous = views.get(record.recordId);
        previous.onsuccess = () => {
          try {
            checkSavedViewOperation(operation);
            if (previous.result) {
              const old = storedView(previous.result);
              if (old.binding !== item.binding || old.createdAt !== record.createdAt || old.updatedAt > record.updatedAt)
                throw new Error('A newer or different saved view already uses this record.');
            }
            const count = views.index('digest').count(record.source.assetDigest);
            count.onsuccess = () => {
              try {
                checkSavedViewOperation(operation);
                if (!previous.result && count.result >= MAX_MATCHES) throw new Error('Too many saved views match this content.');
                views.put(item); transaction.objectStore('thumbnails').put({ recordId: record.recordId, image }); result(undefined);
              } catch (error) { fail(error); }
            };
          } catch (error) { fail(error); }
        };
      });
      return record;
    } finally { database?.close(); release(); }
  }
}
