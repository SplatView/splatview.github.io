// Additive observations of the actual mounted App. Holds delay a genuine
// completed browser encode; no image/native/history result is substituted.
import './opacity-harness';
import { useApp } from '../src/app/store';
import type { ResourceLedger } from '../src/document/resources';
import { SAVED_VIEW_DATABASE } from '../src/io/savedViewStorage';

const app = () => window.geometryViewer.controllerForSourceNavigation();
type Encoding = { type: string; bytes: number; width: number; height: number; sha256: string };
let releaseEncoding: (() => void) | undefined, restoreEncoding: (() => void) | undefined;
let encoded: Encoding | null = null, pendingEncodes: Promise<Blob>[] = [];
let restoreStorage: (() => void) | undefined;
let closeTask: Promise<void> | undefined, closeSettled = false;
const digest = async (blob: Blob) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), n => n.toString(16).padStart(2, '0')).join('');
function state() {
  const value = useApp.getState(), controller = app();
  const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
  const image = [...(ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()]
    .filter(entry => entry.category === 'image');
  return { feedback: value.toolbarFeedback, dirty: value.dirty, outputPending: value.outputPending, error: value.error,
    thumbnailPending: value.thumbnailPending, viewStatus: value.viewStatus, sourceName: value.sourceName,
    document: controller.client ? { ...controller.client.revision } : null, hasScene: !!controller.scene,
    image: { bytes: image.reduce((sum, entry) => sum + entry.bytes, 0), allocations: image.length }, encoded,
    close: { started: !!closeTask, settled: closeSettled } };
}
const harness = {
  ready: () => window.opacityHarness.ready(), state,
  load: (name = 'toolbar-feedback-sh3.ply') => window.opacityHarness.load(name),
  snapshot: () => window.opacityHarness.snapshot(),
  holdEncoding(mode: 'hold' | 'deny' = 'hold') {
    if (restoreEncoding) throw new Error('An encoder observation is already active.');
    encoded = null; pendingEncodes = [];
    let release!: () => void, claimed = false; const held = new Promise<void>(resolve => { release = resolve; });
    releaseEncoding = release;
    const original = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = function (...args) {
      if (claimed) return original.apply(this, args);
      claimed = true;
      const task = (async () => {
        const blob = await original.apply(this, args);
        const bitmap = await createImageBitmap(blob);
        try { encoded = { type: blob.type, bytes: blob.size, width: bitmap.width, height: bitmap.height, sha256: await digest(blob) }; }
        finally { bitmap.close(); }
        if (mode === 'deny') throw new DOMException('The observed image adapter refused the completed encode.', 'NotAllowedError');
        await held; return blob;
      })();
      pendingEncodes.push(task); void task.catch(() => undefined); return task;
    };
    restoreEncoding = () => { OffscreenCanvas.prototype.convertToBlob = original; restoreEncoding = undefined; };
  },
  releaseEncoding() { releaseEncoding?.(); },
  async finishEncoding() {
    releaseEncoding?.(); releaseEncoding = undefined;
    try { await Promise.allSettled(pendingEncodes); }
    finally { restoreEncoding?.(); pendingEncodes = []; }
  },
  beginClose() {
    if (closeTask && !closeSettled) throw new Error('A real Close is already pending.');
    closeSettled = false;
    closeTask = app().closeScene().finally(() => { closeSettled = true; });
    void closeTask.catch(() => undefined);
  },
  async joinClose() { await closeTask; },
  abortNextThumbnailWrite() {
    if (restoreStorage) throw new Error('A storage observation is already active.');
    const original = IDBObjectStore.prototype.put; let consumed = false;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      if (!consumed && this.name === 'views' && this.transaction.mode === 'readwrite') {
        consumed = true; this.transaction.abort();
      }
      return request;
    };
    restoreStorage = () => { IDBObjectStore.prototype.put = original; restoreStorage = undefined; };
  },
  restoreStorage() { restoreStorage?.(); },
  async savedPair() {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      const pair = await new Promise<{ views: { recordId: string; meta: Blob }[]; images: { recordId: string; image: Blob }[] }>((resolve, reject) => {
        const tx = database.transaction(['views', 'thumbnails'], 'readonly'), views = tx.objectStore('views').getAll(), images = tx.objectStore('thumbnails').getAll();
        tx.oncomplete = () => resolve({ views: views.result, images: images.result }); tx.onabort = () => reject(tx.error);
      });
      return Promise.all(pair.views.map(async view => {
        const image = pair.images.find(item => item.recordId === view.recordId)!;
        const bitmap = await createImageBitmap(image.image);
        try { return { record: JSON.parse(await view.meta.text()), imageRecordId: image.recordId, type: image.image.type,
          bytes: image.image.size, sha256: await digest(image.image), width: bitmap.width, height: bitmap.height }; }
        finally { bitmap.close(); }
      }));
    } finally { database.close(); }
  },
  async stop() {
    try { await harness.finishEncoding(); await closeTask; }
    finally { restoreStorage?.(); window.opacityHarness.stop(); }
  },
};
declare global { interface Window { toolbarFeedbackHarness: typeof harness } }
window.toolbarFeedbackHarness = harness;
