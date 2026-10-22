import { admittedExport } from './admitted-export';
import { AppController } from '../src/app/controller';
import { useApp } from '../src/app/store';
import { SavedViewStorage, SAVED_VIEW_DATABASE } from '../src/io/savedViewStorage';
import { createSavedThumbnail, verifySavedThumbnail } from '../src/io/thumbnail';
import { ownRgbaImage } from '../src/io/image';
import { validateSavedViewRecord } from '../src/io/savedView';
import { AdmissionError, ResourceLedger } from '../src/document/resources';
import { NEUTRAL_COLOR } from '../src/document/types';
import type { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import { queuePly, queuePositions } from './queue-fixture';

// Selection and content changes briefly own the automatic transform pivot query;
// a required save waits for a stable idle window, as a person would.
async function settledThumbnail(controller: { updateThumbnail(): Promise<boolean> }) {
  let idleSince: number | undefined;
  for (const start = performance.now(); performance.now() - start < 10_000;) {
    const state = useApp.getState(), now = performance.now();
    if (state.busy || state.transformPivotPending) idleSince = undefined;
    else if ((idleSince ??= now) <= now - 50) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return controller.updateThumbnail();
}
// The same independent literal point/concave-mesh inputs used by the existing
// geometry-viewer harness, without importing that App-mounting entry module.
const geometrySources = {
  points: `ply
format ascii 1.0
element vertex 3
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
end_header
-.4 0 0 255 0 0
.4 0 0 0 255 0
0 .4 .1 0 0 255
`,
  mesh: `ply
format ascii 1.0
element vertex 6
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 1
property list uchar int vertex_indices
end_header
0 0 0 255 180 30
2 0 0 255 180 30
2 1 0 255 180 30
1 1 0 255 180 30
1 2 0 255 180 30
0 2 0 255 180 30
6 0 1 2 3 4 5
`,
};

function gate() {
  let enter!: () => void, release!: () => void;
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }),
    enter: () => enter(), release: () => release() };
}
async function clearStorage() {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SAVED_VIEW_DATABASE);
    request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Test storage is blocked.'));
  });
}
async function pixels(image: Blob) {
  const bitmap = await createImageBitmap(image);
  try {
    const output = new OffscreenCanvas(bitmap.width, bitmap.height), context = output.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', rgba)), value => value.toString(16).padStart(2, '0')).join('');
    return { width: bitmap.width, height: bitmap.height, corner: Array.from(rgba.slice(0, 4)), hash };
  } finally { bitmap.close(); }
}
async function blobHash(image: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await image.arrayBuffer())),
    value => value.toString(16).padStart(2, '0')).join('');
}
function imageAdmissions(controller: AppController) {
  const ledger = (controller as unknown as { ledger: ResourceLedger }).ledger;
  const entries = [...(ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()]
    .filter(value => value.category === 'image');
  return { bytes: entries.reduce((sum, value) => sum + value.bytes, 0), allocations: entries.length };
}
function csvIds(csv: string) {
  return csv.trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number);
    return queuePositions.findIndex(source => source.every((value, axis) => Math.abs(value - point[axis]) < 1e-5));
  }).sort((a, b) => a - b);
}
async function stored() {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    const data = await new Promise<{ records: { meta: Blob }[]; images: { recordId: string; image: Blob }[] }>((resolve, reject) => {
      const transaction = database.transaction(['views', 'thumbnails']), views = transaction.objectStore('views').getAll(), images = transaction.objectStore('thumbnails').getAll();
      transaction.oncomplete = () => resolve({ records: views.result, images: images.result }); transaction.onabort = () => reject(transaction.error);
    });
    return { records: await Promise.all(data.records.map(async value => validateSavedViewRecord(JSON.parse(await value.meta.text())))),
      metadataHashes: await Promise.all(data.records.map(value => blobHash(value.meta))), images: data.images };
  } finally { database.close(); }
}
async function corruptMetadata(recordId: string) {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('views', 'readwrite'), store = transaction.objectStore('views'), request = store.get(recordId);
      request.onsuccess = () => {
        // Preserve the real indexed envelope; only its encoded body is corrupt.
        store.put({ ...request.result, meta: new Blob([' '.repeat(8193)], { type: 'application/json' }) });
      };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
async function corruptStoredImage(recordId: string, kind: 'missing' | 'hash') {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  try {
    // Materialize the bounded existing PNG before starting the write transaction.
    const existing = (await stored()).images.find(value => value.recordId === recordId)!;
    const bytes = await existing.image.arrayBuffer();
    const altered = new Uint8Array(bytes); altered[altered.length - 1] ^= 1;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('thumbnails', 'readwrite'), images = transaction.objectStore('thumbnails');
      if (kind === 'missing') images.delete(recordId);
      else images.put({ recordId, image: new Blob([bytes], { type: 'image/png' }) });
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error);
    });
  } finally { database.close(); }
}
/** Hold the actual transaction, not its completion callback or returned promise. */
function holdPairTransaction() {
  const original = IDBObjectStore.prototype.put, held = gate();
  let active = true, transaction: IDBTransaction | undefined, queuedWrites = 0, succeededWrites = 0, terminalStatus: 'aborted' | 'completed' | null = null;
  let finish!: () => void;
  const terminal = new Promise<void>(resolve => { finish = resolve; });
  IDBObjectStore.prototype.put = function(value, key) {
    const request = original.call(this, value, key);
    if (!transaction && this.name === 'views' && this.transaction.mode === 'readwrite') {
      transaction = this.transaction;
      transaction.addEventListener('abort', () => { active = false; terminalStatus = 'aborted'; finish(); }, { once: true });
      transaction.addEventListener('complete', () => { active = false; terminalStatus = 'completed'; finish(); }, { once: true });
    }
    if (this.transaction === transaction && (this.name === 'views' || this.name === 'thumbnails')) {
      queuedWrites++; request.addEventListener('success', () => { succeededWrites++; }, { once: true });
      if (this.name === 'thumbnails') {
        const store = this;
        const keepAlive = () => {
          if (!active) return;
          // At most one extra request is outstanding. Its success callback is
          // an active IDB task, so requeueing prevents automatic commit.
          let credit: IDBRequest;
          try { credit = store.get('__test_saved_view_keepalive__'); }
          catch (error) {
            if (error instanceof DOMException && ['TransactionInactiveError', 'InvalidStateError'].includes(error.name)) { active = false; return; }
            throw error;
          }
          credit.onsuccess = keepAlive;
        };
        keepAlive(); held.enter();
      }
    }
    return request;
  };
  return { entered: held.entered, terminal, release: () => { active = false; },
    state: (): { queuedWrites: number; succeededWrites: number; terminalStatus: 'aborted' | 'completed' | null } =>
      ({ queuedWrites, succeededWrites, terminalStatus }), restore: () => { IDBObjectStore.prototype.put = original; } };
}
function holdLookupTransaction() {
  const original = IDBIndex.prototype.getAll, held = gate();
  let active = true, transaction: IDBTransaction | undefined, terminalStatus: 'aborted' | 'completed' | null = null;
  let finish!: () => void; const terminal = new Promise<void>(resolve => { finish = resolve; });
  IDBIndex.prototype.getAll = function(query, count) {
    const request = original.call(this, query, count);
    if (!transaction && this.name === 'digest' && this.objectStore.name === 'views' && this.objectStore.transaction.mode === 'readonly') {
      const store = this.objectStore; transaction = store.transaction;
      transaction.addEventListener('abort', () => { active = false; terminalStatus = 'aborted'; finish(); }, { once: true });
      transaction.addEventListener('complete', () => { active = false; terminalStatus = 'completed'; finish(); }, { once: true });
      const keepAlive = () => {
        if (!active) return;
        let credit: IDBRequest;
        try { credit = store.get('__test_saved_view_lookup_keepalive__'); }
        catch (error) {
          if (error instanceof DOMException && ['TransactionInactiveError', 'InvalidStateError'].includes(error.name)) { active = false; return; }
          throw error;
        }
        credit.onsuccess = keepAlive;
      };
      keepAlive(); held.enter();
    }
    return request;
  };
  return { entered: held.entered, terminal, release: () => { active = false; },
    status: (): 'aborted' | 'completed' | null => terminalStatus, restore: () => { IDBIndex.prototype.getAll = original; } };
}
async function setup() {
  await clearStorage();
  const canvas = document.createElement('canvas'); canvas.style.width = '321px'; canvas.style.height = '241px'; document.body.append(canvas);
  const controller = new AppController(); await controller.initialize(canvas);
  const bytes = queuePly(), open = async (name: string, input = bytes) => {
    await controller.openFiles([new File([input], name)]);
    if (useApp.getState().navigationPrompt) await controller.discardAndContinue();
    if (useApp.getState().sourceName !== name || !controller.scene || !controller.client) throw new Error(useApp.getState().error ?? 'Fixture did not open.');
  };
  await open('original.ply');
  const snapshot = async () => {
    const csv = new TextDecoder().decode(await admittedExport(controller.client!, 5, 0));
    return { summary: await controller.client!.command({ command: 'summary' }), csv, state: controller.camera!.state,
      background: controller.camera!.background, dirty: useApp.getState().dirty };
  };
  const operation = { admit: (bytes: number) => (controller as unknown as { ledger: { reserve(category: 'image', bytes: number): () => void } }).ledger.reserve('image', bytes) };
  return { canvas, controller, bytes, open, snapshot, operation,
    dispose: async () => { await controller.closeScene(); if (useApp.getState().navigationPrompt) await controller.discardAndContinue(); controller.dispose(); canvas.remove(); } };
}
type AllocationHost = { checkedAllocation<T>(create: () => T, retire: (value: T) => void): Promise<T> };
function holdAllocation(renderer: GaussianRenderer) {
  const host = renderer as unknown as AllocationHost, original = host.checkedAllocation.bind(host), held = gate(); let first = true;
  host.checkedAllocation = async <T>(create: () => T, retire: (value: T) => void) => {
    const value = await original(create, retire);
    if (first) { first = false; held.enter(); await held.held; }
    return value;
  };
  return { ...held, restore: () => { host.checkedAllocation = original; } };
}

type PortableKind = 'gaussian' | 'points' | 'mesh';
type PortableRefusal = 'source' | 'kind' | 'hash' | 'schema' | 'crc';
type PortableReadRace = 'cancel' | 'replace' | 'close' | 'newer';
type PortableWriteRace = 'edit' | 'replace' | 'close' | 'newer';
/** Observe the real immutable download at the browser adapter boundary only. */
function captureViewDownloads() {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
  const blobs = new Map<string, Blob>(), downloads: { blob: Blob; name: string; url: string }[] = [], revoked: string[] = [];
  URL.createObjectURL = function(value) {
    const url = create.call(URL, value); if (value instanceof Blob) blobs.set(url, value); return url;
  };
  URL.revokeObjectURL = function(url) { revoked.push(url); return revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function() {
    if (this.download.endsWith('.splatview-view.zip')) {
      const blob = blobs.get(this.href); if (!blob) throw new Error('Download did not retain its actual Blob.');
      downloads.push({ blob, name: this.download, url: this.href }); return;
    }
    return click.call(this);
  };
  return { downloads, revoked, restore() {
    URL.createObjectURL = create; URL.revokeObjectURL = revoke; HTMLAnchorElement.prototype.click = click;
  } };
}
// Independent test ZIP codec: bitwise CRC (no production table/reader/writer),
// central-directory parsing and literal stored-member headers.
function portableCrc(bytes: Uint8Array) {
  let crc = 0xffff_ffff;
  for (const value of bytes) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
async function inspectPortable(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer()), view = new DataView(bytes.buffer), end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50 || view.getUint16(end + 10, true) !== 2) throw new Error('Expected a two-member ZIP.');
  let cursor = view.getUint32(end + 16, true);
  const members = [];
  for (let index = 0; index < 2; index++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Expected a central-directory entry.');
    const length = view.getUint16(cursor + 28, true), size = view.getUint32(cursor + 24, true), offset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(cursor + 46, cursor + 46 + length));
    const body = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true), data = bytes.slice(body, body + size);
    members.push({ name, data, size, method: view.getUint16(cursor + 10, true), crcValid: portableCrc(data) === view.getUint32(cursor + 16, true) });
    cursor += 46 + length + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
  }
  const json = members.find(value => value.name === 'view.json'), png = members.find(value => value.name === 'thumbnail.png');
  if (!json || !png) throw new Error('Portable download omitted its fixed members.');
  return { members: members.map(({ name, size, method, crcValid }) => ({ name, size, method, crcValid })),
    record: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json.data)),
    json: json.data, png: new Blob([png.data], { type: 'image/png' }) };
}
function independentPortable(json: Uint8Array<ArrayBuffer>, png: Uint8Array<ArrayBuffer>) {
  const parts: BlobPart[] = [], directories: Uint8Array<ArrayBuffer>[] = []; let offset = 0;
  for (const [name, data] of [['view.json', json], ['thumbnail.png', png]] as const) {
    const nameBytes = new TextEncoder().encode(name), crc = portableCrc(data);
    const local = new Uint8Array(30 + nameBytes.length), a = new DataView(local.buffer);
    a.setUint32(0, 0x04034b50, true); a.setUint16(4, 20, true); a.setUint16(12, 0x21, true);
    a.setUint32(14, crc, true); a.setUint32(18, data.length, true); a.setUint32(22, data.length, true); a.setUint16(26, nameBytes.length, true); local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length), b = new DataView(central.buffer);
    b.setUint32(0, 0x02014b50, true); b.setUint16(4, 20, true); b.setUint16(6, 20, true); b.setUint16(14, 0x21, true);
    b.setUint32(16, crc, true); b.setUint32(20, data.length, true); b.setUint32(24, data.length, true); b.setUint16(28, nameBytes.length, true);
    b.setUint32(42, offset, true); central.set(nameBytes, 46);
    parts.push(local, data); directories.push(central); offset += local.length + data.length;
  }
  const end = new Uint8Array(22), c = new DataView(end.buffer);
  c.setUint32(0, 0x06054b50, true); c.setUint16(8, 2, true); c.setUint16(10, 2, true);
  c.setUint32(12, directories.reduce((sum, entry) => sum + entry.length, 0), true); c.setUint32(16, offset, true);
  return new Blob([...parts, ...directories, end], { type: 'application/zip' });
}
async function malformedPortable(blob: Blob, kind: Exclude<PortableRefusal, 'source'>) {
  if (kind === 'crc') {
    const bytes = new Uint8Array(await blob.arrayBuffer()); bytes[30 + 'view.json'.length] ^= 1;
    return new Blob([bytes], { type: 'application/zip' });
  }
  const parsed = await inspectPortable(blob), record = parsed.record;
  if (kind === 'kind') record.sourceKind = 'points';
  if (kind === 'hash') record.thumbnail.sha256 = '0'.repeat(64);
  if (kind === 'schema') record.schemaVersion = 2;
  return independentPortable(new TextEncoder().encode(JSON.stringify(record)), new Uint8Array(await parsed.png.arrayBuffer()));
}
function holdPortableRead(input: Blob) {
  const blob = new Blob([input], { type: 'application/zip' }), slice = blob.slice.bind(blob), held = gate();
  let first = true, started = 0, completed = 0;
  blob.slice = (start, end, type) => {
    const range = slice(start, end, type), read = range.arrayBuffer.bind(range);
    range.arrayBuffer = async () => {
      started++; const bytes = await read(); completed++;
      if (first) { first = false; held.enter(); await held.held; }
      return bytes;
    };
    return range;
  };
  return { ...held, blob, counts: () => ({ started, completed }) };
}
async function executableRedo(controller: AppController) {
  if (!await controller.command({ command: 'single', index: 1 }) || !await controller.command({ command: 'delete' }) ||
      !await controller.command({ command: 'undo' })) throw new Error('Portable fixture did not establish executable Redo.');
}
async function portableScene(controller: AppController) {
  const source = await controller.client!.command({ command: 'summary' });
  const csv = source.kind === 0 ? new TextDecoder().decode(await admittedExport(controller.client!, 5, 0)) : null;
  const summary = await controller.client!.command({ command: 'summary' });
  return { summary, csv,
    dirty: useApp.getState().dirty, outputPending: useApp.getState().outputPending };
}
async function portableSetup(kind: PortableKind = 'gaussian') {
  const h = await setup(), download = captureViewDownloads();
  try {
    const input = kind === 'gaussian' ? h.bytes : new TextEncoder().encode(geometrySources[kind]);
    if (kind !== 'gaussian') await h.open(`original-${kind}.ply`, input);
    else await executableRedo(h.controller);
    const view = h.controller.camera!.state; view[0] += .125; view[1] -= .25; view[7] = 62; view[9] = .25;
    h.controller.camera!.set(view); h.controller.camera!.background = 'gray'; useApp.setState({ background: 'gray' });
    if (!await settledThumbnail(h.controller)) throw new Error(useApp.getState().viewStatus ?? 'Portable initial pair did not save.');
    const saved = await stored(), savedAdmissions = imageAdmissions(h.controller), savedCamera = h.controller.camera!.state;
    // Export must read the saved pair, even while the live view differs.
    h.controller.camera!.pan(55, 35); h.controller.camera!.background = 'white'; useApp.setState({ background: 'white' });
    const exportCamera = h.controller.camera!.state, exportBackground = h.controller.camera!.background,
      beforeExport = await portableScene(h.controller);
    if (!await h.controller.exportSavedView() || download.downloads.length !== 1) throw new Error(useApp.getState().viewStatus ?? 'Portable export did not hand off a ZIP.');
    const afterExport = await portableScene(h.controller);
    h.controller.camera!.set(savedCamera); h.controller.camera!.background = 'gray'; useApp.setState({ background: 'gray' });
    return { ...h, input, download, saved, savedAdmissions, exportCamera, exportBackground, beforeExport, afterExport, package: download.downloads[0].blob,
      baseline: imageAdmissions(h.controller), dispose: async () => { try { await h.dispose(); } finally { download.restore(); } } };
  } catch (error) { try { await h.dispose(); } finally { download.restore(); } throw error; }
}
function harness() {
  return {
    async portableRoundTrip(kind: PortableKind) {
      const h = await portableSetup(kind);
      try {
        const original = h.saved.records[0], originalImage = await pixels(h.saved.images[0].image), packaged = await inspectPortable(h.package),
          packageImage = await pixels(packaged.png), source = h.controller.sourceFingerprint;
        await h.open(`portable-renamed-${kind}.ply`, h.input);
        if (kind === 'gaussian') await executableRedo(h.controller);
        h.canvas.style.width = '407px'; h.canvas.style.height = '239px';
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        h.controller.camera!.pan(40, 25); h.controller.camera!.background = 'white'; useApp.setState({ background: 'white' });
        const before = await portableScene(h.controller), startedAt = Date.now(), imported = await h.controller.importSavedView(h.package),
          finishedAt = Date.now(), after = await portableScene(h.controller), first = await stored();
        const adopted = first.records.find(record => record.recordId !== original.recordId)!;
        const restored = { camera: h.controller.camera!.state, background: h.controller.camera!.background,
          aspect: h.canvas.width / h.canvas.height, available: useApp.getState().savedViewAvailable };
        h.controller.camera!.pan(30, 15); h.controller.camera!.background = 'white'; h.controller.resetCamera();
        const reset = { camera: h.controller.camera!.state, background: h.controller.camera!.background };
        const again = await h.controller.importSavedView(h.package), current = await stored(), admissions = imageAdmissions(h.controller);
        const redo = kind === 'gaussian' ? await h.controller.command({ command: 'redo' }) : null,
          redoIds = kind === 'gaussian' ? csvIds((await h.snapshot()).csv) : null;
        const undo = kind === 'gaussian' ? await h.controller.command({ command: 'undo' }) : null,
          undoCsv = kind === 'gaussian' ? (await h.snapshot()).csv : null;
        const importedImages = await Promise.all(current.images.map(value => pixels(value.image)));
        await h.controller.closeScene();
        if (useApp.getState().navigationPrompt) await h.controller.discardAndContinue();
        return { kind, original, source, originalImage, packageImage, packageRecord: packaged.record, members: packaged.members,
          name: h.download.downloads[0].name, exportCamera: h.exportCamera, exportBackground: h.exportBackground,
          beforeExport: h.beforeExport, afterExport: h.afterExport,
          imported, again, before, after, adopted, startedAt, finishedAt, restored, reset,
          records: current.records, metadata: current.metadataHashes, originalMetadata: h.saved.metadataHashes[0],
          importedImages, savedAdmissions: h.savedAdmissions, baseline: h.baseline, admissions, redo, redoIds, undo, undoCsv,
          revoked: h.download.revoked.includes(h.download.downloads[0].url), closedAdmissions: imageAdmissions(h.controller),
          pending: useApp.getState().viewTransferPending, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async portableRefusal(kind: PortableRefusal) {
      const h = await portableSetup();
      try {
        if (kind === 'source') { await h.open('different-portable-source.ply', new Uint8Array([...h.bytes, 10])); await executableRedo(h.controller); }
        h.controller.camera!.pan(20, 10); h.controller.camera!.background = 'white'; useApp.setState({ background: 'white' });
        const input = kind === 'source' ? h.package : await malformedPortable(h.package, kind), before = await h.snapshot(),
          previous = await stored(), baseline = imageAdmissions(h.controller), source = h.controller.sourceFingerprint,
          client = h.controller.client, scene = h.controller.scene;
        const accepted = await h.controller.importSavedView(input), status = useApp.getState().viewStatus, after = await h.snapshot(),
          current = await stored(), admissions = imageAdmissions(h.controller);
        const redone = await h.controller.command({ command: 'redo' }), redoIds = csvIds((await h.snapshot()).csv),
          undone = await h.controller.command({ command: 'undo' }), undoCsv = (await h.snapshot()).csv;
        return { kind, accepted, status, before, after, baseline, admissions, sameOwner: source === h.controller.sourceFingerprint &&
          client === h.controller.client && scene === h.controller.scene, beforeRecords: previous.records, afterRecords: current.records,
          beforeMetadata: previous.metadataHashes, afterMetadata: current.metadataHashes,
          beforeImage: await blobHash(previous.images[0].image), afterImage: await blobHash(current.images[0].image),
          redone, redoIds, undone, undoCsv, outputPending: useApp.getState().outputPending,
          pending: useApp.getState().viewTransferPending, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async portableDirtyHistory() {
      const h = await portableSetup();
      try {
        if (!await h.controller.command({ command: 'redo' }) || !await h.controller.command({ command: 'single', index: 2 }) ||
            !await h.controller.command({ command: 'delete' }) || !await h.controller.command({ command: 'undo' }))
          throw new Error('The dirty retained-Redo fixture did not execute.');
        const before = await h.snapshot(), exported = await h.controller.exportSavedView(), afterExport = await h.snapshot();
        const imported = await h.controller.importSavedView(h.download.downloads[1].blob), afterImport = await h.snapshot();
        const redone = await h.controller.command({ command: 'redo' }), redoIds = csvIds((await h.snapshot()).csv),
          undone = await h.controller.command({ command: 'undo' }), undoCsv = (await h.snapshot()).csv;
        return { before, exported, afterExport, imported, afterImport, redone, redoIds, undone, undoCsv,
          outputPending: useApp.getState().outputPending, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async portableHeldRead(mode: PortableReadRace) {
      const h = await portableSetup(), held = holdPortableRead(h.package); let unwatch: (() => void) | undefined;
      try {
        const before = await h.snapshot(), source = h.controller.sourceFingerprint, previous = await stored(), baseline = imageAdmissions(h.controller),
          state = { settled: false, closed: false };
        const first = h.controller.importSavedView(held.blob).then(value => { state.settled = true; return value; });
        await held.entered; const admitted = imageAdmissions(h.controller), counts = held.counts();
        let newer: boolean | null = null, closing: Promise<void> | undefined;
        if (mode === 'cancel') h.controller.cancelSavedViewTransfer();
        if (mode === 'replace') await h.open('held-portable-replacement.ply', new Uint8Array([...h.bytes, 10]));
        if (mode === 'newer') newer = await h.controller.importSavedView(h.package);
        if (mode === 'close') {
          const entered = gate(); unwatch = useApp.subscribe(next => { if (next.stage === 'Closing scene' && next.summary === null) entered.enter(); });
          closing = h.controller.closeScene().then(() => { state.closed = true; }); await entered.entered;
        }
        // The actual first read completed; publication is revoked, but no early
        // promise race may release its retained input/scratch owners.
        await Promise.resolve(); await Promise.resolve();
        const whileHeld = { settled: Boolean(state.settled), closed: Boolean(state.closed), admissions: imageAdmissions(h.controller),
          counts: held.counts(), sourceCleared: h.controller.sourceFingerprint === undefined };
        held.release(); const accepted = await first; await closing;
        const current = await stored(), after = h.controller.client ? await h.snapshot() : null, admissions = imageAdmissions(h.controller),
          sameSource = h.controller.sourceFingerprint === source, name = useApp.getState().sourceName;
        let redone: boolean | null = null, undone: boolean | null = null, redoIds: number[] | null = null, undoCsv: string | null = null;
        if (mode === 'cancel' || mode === 'newer') {
          redone = await h.controller.command({ command: 'redo' }); redoIds = csvIds((await h.snapshot()).csv);
          undone = await h.controller.command({ command: 'undo' }); undoCsv = (await h.snapshot()).csv;
        }
        await h.controller.closeScene(); if (useApp.getState().navigationPrompt) await h.controller.discardAndContinue();
        return { mode, before, after, baseline, admitted, counts, whileHeld, accepted, newer, admissions, sameSource, name,
          beforeRecords: previous.records, afterRecords: current.records, originalMetadata: previous.metadataHashes[0],
          currentOriginalMetadata: current.metadataHashes[current.records.findIndex(value => value.recordId === previous.records[0].recordId)],
          redone, redoIds, undone, undoCsv, closed: Boolean(state.closed), finalAdmissions: imageAdmissions(h.controller),
          pending: useApp.getState().viewTransferPending, error: useApp.getState().error };
      } finally { unwatch?.(); held.release(); await h.dispose(); }
    },
    async portableHeldExportOwner() {
      const h = await portableSetup(), held = gate(), decode = globalThis.createImageBitmap, close = ImageBitmap.prototype.close;
      let first = true, heldBitmap: ImageBitmap | undefined, heldCloses = 0;
      const state = { settled: false };
      const recordOwners = () => {
        const ledger = (h.controller as unknown as { ledger: ResourceLedger }).ledger;
        return [...(ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()]
          .filter(value => value.category === 'image' && value.bytes === 8192 * 2 + 2048).length;
      };
      try {
        const before = await h.snapshot(), baseline = imageAdmissions(h.controller);
        ImageBitmap.prototype.close = function() { if (this === heldBitmap) heldCloses++; return close.call(this); };
        globalThis.createImageBitmap = (async (...args: unknown[]) => {
          const bitmap: ImageBitmap = await Reflect.apply(decode, globalThis, args);
          if (first) { first = false; heldBitmap = bitmap; held.enter(); await held.held; }
          return bitmap;
        }) as typeof createImageBitmap;
        const exporting = h.controller.exportSavedView().then(value => { state.settled = true; return value; });
        await held.entered;
        const initiallyHeld = { recordOwners: recordOwners(), admissions: imageAdmissions(h.controller),
          dimensions: [heldBitmap!.width, heldBitmap!.height], closes: heldCloses };
        const imported = await h.controller.importSavedView(h.package), whileHeld = { settled: Boolean(state.settled),
          recordOwners: recordOwners(), admissions: imageAdmissions(h.controller), closes: heldCloses };
        held.release(); const exported = await exporting;
        const after = await h.snapshot(), admissions = imageAdmissions(h.controller), remainingRecordOwners = recordOwners(),
          closes = heldCloses, pairs = await stored();
        globalThis.createImageBitmap = decode; ImageBitmap.prototype.close = close;
        const redone = await h.controller.command({ command: 'redo' }), redoIds = csvIds((await h.snapshot()).csv),
          undone = await h.controller.command({ command: 'undo' }), undoCsv = (await h.snapshot()).csv;
        await h.controller.closeScene(); if (useApp.getState().navigationPrompt) await h.controller.discardAndContinue();
        return { before, after, baseline, initiallyHeld, imported, whileHeld, exported, admissions, remainingRecordOwners, closes,
          records: pairs.records.length, downloads: h.download.downloads.length, redone, redoIds, undone, undoCsv,
          finalAdmissions: imageAdmissions(h.controller), revoked: h.download.revoked.includes(h.download.downloads[0].url), error: useApp.getState().error };
      } finally { held.release(); globalThis.createImageBitmap = decode; ImageBitmap.prototype.close = close; await h.dispose(); }
    },
    async portableHeldTransaction(mode: PortableWriteRace) {
      const h = await portableSetup(); let held: ReturnType<typeof holdPairTransaction> | undefined;
      try {
        const before = await h.snapshot(), previous = await stored(), baseline = imageAdmissions(h.controller), source = h.controller.sourceFingerprint;
        held = holdPairTransaction(); const importing = h.controller.importSavedView(h.package); await held.entered;
        const queued = held.state(), admitted = imageAdmissions(h.controller);
        let edited: boolean | null = null, newer: boolean | null = null;
        if (mode === 'edit') edited = await h.controller.command({ command: 'delete' });
        if (mode === 'replace') await h.open('transaction-portable-replacement.ply', new Uint8Array([...h.bytes, 10]));
        if (mode === 'close') await h.controller.closeScene();
        if (mode === 'newer') newer = await h.controller.importSavedView(h.package);
        await held.terminal; const terminal = held.state();
        // The real transaction must abort before the test releases keepalive.
        const accepted = await importing; held.release(); held.restore();
        const after = h.controller.client ? await h.snapshot() : null, current = await stored(), admissions = imageAdmissions(h.controller),
          sameSource = source === h.controller.sourceFingerprint, background = h.controller.camera!.background;
        let undone: boolean | null = null, redone: boolean | null = null, undoIds: number[] | null = null, redoIds: number[] | null = null;
        if (mode === 'edit') {
          undone = await h.controller.command({ command: 'undo' }); undoIds = csvIds((await h.snapshot()).csv);
          redone = await h.controller.command({ command: 'redo' }); redoIds = csvIds((await h.snapshot()).csv);
          await h.controller.command({ command: 'undo' });
        } else if (mode === 'newer') {
          redone = await h.controller.command({ command: 'redo' }); redoIds = csvIds((await h.snapshot()).csv);
          undone = await h.controller.command({ command: 'undo' }); undoIds = csvIds((await h.snapshot()).csv);
        }
        await h.controller.closeScene(); if (useApp.getState().navigationPrompt) await h.controller.discardAndContinue();
        const originalIndex = current.records.findIndex(value => value.recordId === previous.records[0].recordId);
        return { mode, before, after, baseline, queued, admitted, terminal, accepted, edited, newer, sameSource, background, admissions,
          beforeRecords: previous.records, afterRecords: current.records, originalMetadata: previous.metadataHashes[0],
          currentOriginalMetadata: current.metadataHashes[originalIndex], originalImage: await blobHash(previous.images[0].image),
          currentOriginalImage: await blobHash(current.images.find(value => value.recordId === previous.records[0].recordId)!.image),
          undone, redone, undoIds, redoIds, finalAdmissions: imageAdmissions(h.controller),
          pending: useApp.getState().viewTransferPending, error: useApp.getState().error };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async roundTrip() {
      const h = await setup();
      try {
        await h.controller.command({ command: 'single', index: 1 }); await h.controller.command({ command: 'delete' }); await h.controller.command({ command: 'undo' });
        h.controller.camera!.set([.25, -.5, .1, .2, -.3, 4.25, 1.5, 62, 1, .4, h.canvas.width / h.canvas.height]);
        h.controller.camera!.background = 'gray'; useApp.setState({ background: 'gray' });
        const before = await h.snapshot(), accepted = await h.controller.updateThumbnail(), after = await h.snapshot(), data = await stored();
        h.controller.camera!.pan(100, 50); h.controller.camera!.background = 'white'; h.controller.resetCamera(); const reset = h.controller.camera!.state;
        await h.open('renamed-copy.ply');
        return { accepted, before, after, record: data.records[0], records: data.records.length, images: data.images.length,
          image: await pixels(data.images[0].image), reset, reopened: h.controller.camera!.state, background: h.controller.camera!.background,
          choices: useApp.getState().savedViewChoices.length, name: useApp.getState().sourceName, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async immutableCapture() {
      const h = await setup(); let held: ReturnType<typeof holdAllocation> | undefined;
      try {
        h.controller.camera!.background = 'gray';
        const neutral = await pixels(await h.controller.capture('image/png'));
        const grade = [...NEUTRAL_COLOR]; grade[0] = 1.4; h.controller.setGrade(grade);
        const baseline = await pixels(await h.controller.capture('image/png'));
        held = holdAllocation(h.controller.renderer!); const capture = h.controller.capture('image/png'); await held.entered;
        // Mutate the original caller-owned array, not only a new store array.
        // The capture must own its rendering inputs before allocation yields.
        grade[0] = .35; h.controller.setGrade([...grade]);
        h.controller.camera!.pan(100, 50); h.controller.camera!.background = 'white';
        h.canvas.width = 333; h.canvas.height = 199; h.controller.camera!.aspect(333 / 199);
        held.release(); held.restore();
        return { baseline, neutral, actual: await pixels(await capture), now: h.controller.camera!.background, nowGrade: useApp.getState().grade[0] };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async newerRequest() {
      const h = await setup(); let held: ReturnType<typeof holdAllocation> | undefined;
      try {
        h.controller.camera!.background = 'gray'; held = holdAllocation(h.controller.renderer!);
        const first = h.controller.updateThumbnail(); await held.entered;
        h.controller.camera!.background = 'white'; const second = await h.controller.updateThumbnail();
        held.release(); const old = await first; held.restore(); const data = await stored();
        return { old, second, count: data.records.length, view: data.records[0].view, image: await pixels(data.images[0].image), pending: useApp.getState().thumbnailPending };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async replacement() {
      const h = await setup(); let held: ReturnType<typeof holdAllocation> | undefined;
      try {
        const before = h.controller.sourceFingerprint; held = holdAllocation(h.controller.renderer!);
        const first = h.controller.updateThumbnail(); await held.entered;
        await h.open('new-source.ply', new Uint8Array([...h.bytes, 10]));
        held.release(); const accepted = await first; held.restore(); const data = await stored();
        return { accepted, records: data.records.length, before, after: h.controller.sourceFingerprint, name: useApp.getState().sourceName,
          pending: useApp.getState().thumbnailPending, error: useApp.getState().error };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async denied() {
      const h = await setup();
      try {
        const before = await h.snapshot();
        (h.controller as unknown as { viewStorage: SavedViewStorage }).viewStorage = new SavedViewStorage(() => { throw new DOMException('Storage denied', 'SecurityError'); });
        const accepted = await h.controller.updateThumbnail(), status = useApp.getState().viewStatus, after = await h.snapshot();
        await h.open('denied-reopen.ply');
        return { accepted, status, before, after, name: useApp.getState().sourceName, error: useApp.getState().error, pending: useApp.getState().thumbnailPending };
      } finally { await h.dispose(); }
    },
    async atomicFailure() {
      const h = await setup(); const original = IDBObjectStore.prototype.put;
      try {
        if (!await settledThumbnail(h.controller)) throw new Error(useApp.getState().viewStatus ?? 'Initial save failed.');
        const before = await stored(); let injected = false;
        IDBObjectStore.prototype.put = function(value, key) {
          if (this.name === 'thumbnails') { injected = true; throw new DOMException('Quota refused', 'QuotaExceededError'); }
          return original.call(this, value, key);
        };
        h.controller.camera!.background = 'white'; const accepted = await h.controller.updateThumbnail();
        IDBObjectStore.prototype.put = original; const after = await stored();
        return { accepted, injected, before: before.records, after: after.records, beforeImage: await pixels(before.images[0].image),
          afterImage: await pixels(after.images[0].image), status: useApp.getState().viewStatus, error: useApp.getState().error };
      } finally { IDBObjectStore.prototype.put = original; await h.dispose(); }
    },
    async editDuringStorage() {
      const h = await setup(); let held: ReturnType<typeof holdPairTransaction> | undefined;
      try {
        if (!await h.controller.command({ command: 'single', index: 1 }) || !await h.controller.command({ command: 'delete' }) ||
            !await h.controller.command({ command: 'undo' })) throw new Error('The executable Redo fixture was not established.');
        h.controller.camera!.background = 'gray';
        if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const before = await h.snapshot(), previous = await stored(), beforeImageHash = await blobHash(previous.images[0].image),
          baseline = imageAdmissions(h.controller);
        held = holdPairTransaction(); h.controller.camera!.background = 'white';
        const saving = h.controller.updateThumbnail(); await held.entered;
        const queued = held.state(), admitted = imageAdmissions(h.controller);
        const editing = h.controller.command({ command: 'delete' });
        await held.terminal; const terminal = held.state(); held.release(); held.restore();
        const edited = await editing, accepted = await saving, after = await h.snapshot(), current = await stored();
        const undone = await h.controller.command({ command: 'undo' }), afterUndo = await h.snapshot();
        const redone = await h.controller.command({ command: 'redo' }), afterRedo = await h.snapshot();
        return { queued, terminal, admitted, baseline, accepted, edited, before, after, undone, redone,
          ids: csvIds(after.csv), undoIds: csvIds(afterUndo.csv), redoIds: csvIds(afterRedo.csv),
          undoCsv: afterUndo.csv, redoCsv: afterRedo.csv, beforeRecords: previous.records, afterRecords: current.records,
          beforeMetadata: previous.metadataHashes, afterMetadata: current.metadataHashes,
          beforeImageHash, afterImageHash: await blobHash(current.images[0].image),
          imageCount: current.images.length, admissions: imageAdmissions(h.controller), pending: useApp.getState().thumbnailPending,
          error: useApp.getState().error };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async oversizedMetadata() {
      const h = await setup(), original = Blob.prototype.arrayBuffer, originalText = Blob.prototype.text,
        originalSlice = Blob.prototype.slice, originalStream = Blob.prototype.stream;
      let bodyReads = 0, bodySlices = 0;
      try {
        h.controller.camera!.background = 'gray'; if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const data = await stored(); await corruptMetadata(data.records[0].recordId);
        const before = await h.snapshot(), baseline = imageAdmissions(h.controller);
        Blob.prototype.arrayBuffer = function(this: Blob) {
          if (this.type === 'application/json' && this.size === 8193) bodyReads++;
          return original.call(this);
        };
        Blob.prototype.text = function(this: Blob) {
          if (this.type === 'application/json' && this.size === 8193) bodyReads++;
          return originalText.call(this);
        };
        Blob.prototype.stream = function(this: Blob) {
          if (this.type === 'application/json' && this.size === 8193) bodyReads++;
          return originalStream.call(this);
        };
        Blob.prototype.slice = function(this: Blob, start, end, type) {
          if (this.type === 'application/json' && this.size === 8193) bodySlices++;
          return originalSlice.call(this, start, end, type);
        };
        const lookup = await new SavedViewStorage().list(h.controller.sourceFingerprint!, 'gaussian', h.operation);
        lookup.dispose();
        const after = await h.snapshot(), admissions = imageAdmissions(h.controller);
        await h.open('oversized-reopen.ply');
        return { bodyReads, bodySlices, records: lookup.records.length, corrupt: lookup.corrupt, before, after, baseline, admissions,
          background: h.controller.camera!.background, name: useApp.getState().sourceName, status: useApp.getState().viewStatus, error: useApp.getState().error };
      } finally {
        Blob.prototype.arrayBuffer = original; Blob.prototype.text = originalText; Blob.prototype.slice = originalSlice; Blob.prototype.stream = originalStream;
        await h.dispose();
      }
    },
    async lookupAdmissionRefusal() {
      const h = await setup();
      try {
        if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const previous = await stored(), before = await h.snapshot(), beforeImage = await blobHash(previous.images[0].image),
          baseline = imageAdmissions(h.controller);
        const ledger = new ResourceLedger(2 * 1024 * 1024), attempts: number[] = [], admitted: number[] = [];
        let resolved = false, admissionError = false, message = '';
        try {
          const lookup = await new SavedViewStorage().list(h.controller.sourceFingerprint!, 'gaussian', { admit: bytes => {
            attempts.push(bytes); const lease = ledger.reserve('image', bytes); admitted.push(bytes); return lease;
          } });
          lookup.dispose();
          resolved = true;
        } catch (error) { admissionError = error instanceof AdmissionError; message = error instanceof Error ? error.message : String(error); }
        const current = await stored();
        return { resolved, admissionError, message, attempts, admitted, usage: ledger.usage, baseline,
          before, after: await h.snapshot(), beforeRecords: previous.records, afterRecords: current.records,
          beforeMetadata: previous.metadataHashes, afterMetadata: current.metadataHashes,
          beforeImage, afterImage: await blobHash(current.images[0].image), admissions: imageAdmissions(h.controller) };
      } finally { await h.dispose(); }
    },
    async pngDimensionsBeforeDecode() {
      const h = await setup(); const original = globalThis.createImageBitmap; let decodeCalls = 0;
      try {
        if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const saved = await stored(), first = saved.records[0];
        const canvas = new OffscreenCanvas(1, 1), context = canvas.getContext('2d')!;
        context.fillStyle = '#ffffff'; context.fillRect(0, 0, 1, 1);
        const png = await canvas.convertToBlob({ type: 'image/png' }), input = await png.arrayBuffer();
        const before = await h.snapshot(), baseline = imageAdmissions(h.controller), outcomes = [];
        globalThis.createImageBitmap = ((...args: unknown[]): Promise<ImageBitmap> => {
          decodeCalls++; return Reflect.apply(original, globalThis, args);
        }) as typeof createImageBitmap;
        for (const declaredWidth of [2, 0x7fff_ffff]) {
          const bytes = input.slice(0); new DataView(bytes).setUint32(16, declaredWidth);
          const bomb = new Blob([bytes], { type: 'image/png' });
          const record = validateSavedViewRecord({ ...first, thumbnail: { type: 'image/png', width: 1, height: 1,
            byteLength: bomb.size, sha256: await blobHash(bomb) } });
          let verifyError = '';
          try { await verifySavedThumbnail(record, bomb, h.operation); }
          catch (error) { verifyError = error instanceof Error ? error.message : String(error); }
          outcomes.push({ declaredWidth, verifyError, admissions: imageAdmissions(h.controller), decodeCalls });
        }
        return { before, after: await h.snapshot(), baseline, outcomes, decodeCalls, admissions: imageAdmissions(h.controller) };
      } finally { globalThis.createImageBitmap = original; await h.dispose(); }
    },
    async closeHeldCapture() {
      const h = await setup(); let held: ReturnType<typeof holdAllocation> | undefined, unwatch: (() => void) | undefined;
      try {
        const baseline = imageAdmissions(h.controller); held = holdAllocation(h.controller.renderer!);
        const saving = h.controller.updateThumbnail(); await held.entered;
        const captureAdmissions = imageAdmissions(h.controller), closingEntered = gate();
        unwatch = useApp.subscribe(state => { if (state.stage === 'Closing scene' && state.summary === null) closingEntered.enter(); });
        let closed = false;
        const closing = h.controller.closeScene().then(() => { closed = true; });
        await closingEntered.entered;
        const whileHeld = { closed: Boolean(closed), admissions: imageAdmissions(h.controller), pending: useApp.getState().thumbnailPending,
          sourceCleared: h.controller.sourceFingerprint === undefined, sceneCleared: h.controller.scene === undefined };
        held.release(); held.restore(); const accepted = await saving; await closing;
        const after = { closed: Boolean(closed), admissions: imageAdmissions(h.controller), summary: useApp.getState().summary,
          pending: useApp.getState().thumbnailPending, pairs: (await stored()).records.length };
        await h.open('after-held-close.ply');
        return { baseline, captureAdmissions, whileHeld, accepted, after, name: useApp.getState().sourceName,
          reopenedIds: csvIds((await h.snapshot()).csv), error: useApp.getState().error };
      } finally { unwatch?.(); held?.release(); held?.restore(); await h.dispose(); }
    },
    async cancelHeldLookup() {
      const h = await setup(); let held: ReturnType<typeof holdLookupTransaction> | undefined;
      try {
        if (!await h.controller.command({ command: 'single', index: 1 }) || !await h.controller.command({ command: 'delete' }) ||
            !await h.controller.command({ command: 'undo' })) throw new Error('The executable Redo fixture was not established.');
        h.controller.camera!.background = 'gray'; if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const client = h.controller.client, scene = h.controller.scene, key = h.controller.sourceFingerprint,
          before = await h.snapshot(), baseline = imageAdmissions(h.controller);
        held = holdLookupTransaction();
        // Undo can restore the saved content revision while retaining Redo.
        // An immediate open must reach the held lookup without awaiting its
        // completion; only a genuinely dirty source requires confirmation.
        const opening = h.controller.openFiles([new File([h.bytes], 'held-lookup-copy.ply')]);
        let continuing: Promise<void> | undefined;
        if (before.dirty) {
          await opening;
          if (!useApp.getState().navigationPrompt) throw new Error('The dirty source did not require replacement confirmation.');
          continuing = h.controller.discardAndContinue();
        }
        await held.entered;
        const beforeCancel = held.status(); h.controller.cancelLoad(); await held.terminal;
        const terminal = held.status(); await opening; await continuing;
        // No manual release preceded the real abort or candidate cleanup.
        const after = await h.snapshot(), sameOwner = client === h.controller.client && scene === h.controller.scene && key === h.controller.sourceFingerprint;
        const admissions = imageAdmissions(h.controller); held.release(); held.restore();
        const redone = await h.controller.command({ command: 'redo' }), redoIds = csvIds((await h.snapshot()).csv);
        const undone = await h.controller.command({ command: 'undo' }), undoCsv = (await h.snapshot()).csv;
        const name = useApp.getState().sourceName;
        await h.controller.closeScene(); if (useApp.getState().navigationPrompt) await h.controller.discardAndContinue();
        return { beforeCancel, terminal, before, after, sameOwner, baseline, admissions, redone, redoIds, undone, undoCsv, name,
          closed: useApp.getState().summary === null, finalAdmissions: imageAdmissions(h.controller) };
      } finally { held?.release(); held?.restore(); await h.dispose(); }
    },
    async recordOwnership() {
      const h = await setup();
      try {
        const empty = imageAdmissions(h.controller);
        h.controller.camera!.background = 'gray';
        if (!await settledThumbnail(h.controller)) throw new Error('Initial retained view did not save.');
        const firstPair = await stored(), first = firstPair.records[0], single = imageAdmissions(h.controller), cycles = [];
        for (let index = 0; index < 3; index++) {
          h.controller.camera!.background = index % 2 === 0 ? 'white' : 'gray';
          if (!await settledThumbnail(h.controller)) throw new Error('Repeated retained view did not save.');
          const saved = imageAdmissions(h.controller);
          await h.open(`retained-repeat-${index}.ply`);
          const data = await stored();
          cycles.push({ saved, reopened: imageAdmissions(h.controller), records: data.records.length, images: data.images.length,
            recordId: data.records[0].recordId, choices: useApp.getState().savedViewChoices.length });
        }
        const other = validateSavedViewRecord({ ...first, recordId: crypto.randomUUID(), displayName: 'Retention other copy' });
        await new SavedViewStorage().put(other, firstPair.images[0].image, h.operation);
        await h.open('retained-two.ply');
        const two = { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length };
        const chosen = await h.controller.chooseSavedView(other.recordId);
        const one = { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length,
          background: h.controller.camera!.background };
        await h.open('retained-dismiss.ply');
        const beforeDismiss = { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length,
          camera: h.controller.camera!.state, background: h.controller.camera!.background };
        h.controller.dismissSavedViews();
        const dismissed = { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length,
          camera: h.controller.camera!.state, background: h.controller.camera!.background };
        await h.open('retained-replacement-start.ply');
        const beforeReplacement = imageAdmissions(h.controller), beforeKey = h.controller.sourceFingerprint;
        await h.open('retained-unmatched.ply', new Uint8Array([...h.bytes, 10]));
        const replaced = { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length,
          keyChanged: beforeKey!.assetDigest !== h.controller.sourceFingerprint!.assetDigest, background: h.controller.camera!.background };
        await h.open('retained-close.ply'); const beforeClose = imageAdmissions(h.controller);
        await h.controller.closeScene();
        const data = await stored();
        return { empty, single, firstRecordId: first.recordId, cycles, two, chosen, one, beforeDismiss, dismissed, beforeReplacement,
          replaced, beforeClose, closed: { admissions: imageAdmissions(h.controller), choices: useApp.getState().savedViewChoices.length,
            summary: useApp.getState().summary, sourceCleared: h.controller.sourceFingerprint === undefined },
          records: data.records.length, images: data.images.length, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async retentionAdmissionRefusal() {
      const h = await setup();
      try {
        if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const previous = await stored(), before = await h.snapshot(), beforeImage = await blobHash(previous.images[0].image),
          baseline = imageAdmissions(h.controller), ledger = new ResourceLedger(8 * 1024 * 1024), attempts: number[] = [], admitted: number[] = [];
        let ballast: (() => void) | undefined, resolved = false, admissionError = false, message = '';
        try {
          const lookup = await new SavedViewStorage().list(h.controller.sourceFingerprint!, 'gaussian', { admit: bytes => {
            attempts.push(bytes);
            // Literal v1 one-record retention allowance. Exhaust only that
            // final admission through the genuine ledger, after successful
            // metadata/hash/decode work; do not manufacture an exception.
            if (bytes === 8192 * 2 + 2048) ballast = ledger.reserve('work', ledger.limit - ledger.usage.bytes - bytes + 1);
            const owner = ledger.reserve('image', bytes); admitted.push(bytes); return owner;
          } });
          lookup.dispose(); resolved = true;
        } catch (error) { admissionError = error instanceof AdmissionError; message = error instanceof Error ? error.message : String(error); }
        finally { ballast?.(); }
        const current = await stored();
        return { resolved, admissionError, message, attempts, admitted, usage: ledger.usage, baseline,
          before, after: await h.snapshot(), beforeRecords: previous.records, afterRecords: current.records,
          beforeMetadata: previous.metadataHashes, afterMetadata: current.metadataHashes,
          beforeImage, afterImage: await blobHash(current.images[0].image), admissions: imageAdmissions(h.controller) };
      } finally { await h.dispose(); }
    },
    async storedImageRefusal(kind: 'missing' | 'hash') {
      const h = await setup(); const original = globalThis.createImageBitmap; let decodeCalls = 0;
      try {
        if (!await h.controller.command({ command: 'single', index: 1 }) || !await h.controller.command({ command: 'delete' }) ||
            !await h.controller.command({ command: 'undo' })) throw new Error('The executable Redo fixture was not established.');
        h.controller.camera!.background = 'gray'; if (!await settledThumbnail(h.controller)) throw new Error('Initial pair did not save.');
        const previous = await stored(), before = await h.snapshot(), baseline = imageAdmissions(h.controller);
        await corruptStoredImage(previous.records[0].recordId, kind);
        const corrupted = await stored(), corruptedImage = corrupted.images[0] ? await blobHash(corrupted.images[0].image) : null;
        globalThis.createImageBitmap = ((...args: unknown[]): Promise<ImageBitmap> => {
          decodeCalls++; return Reflect.apply(original, globalThis, args);
        }) as typeof createImageBitmap;
        const lookup = await new SavedViewStorage().list(h.controller.sourceFingerprint!, 'gaussian', h.operation);
        lookup.dispose(); globalThis.createImageBitmap = original;
        const after = await h.snapshot(), admissions = imageAdmissions(h.controller);
        const redone = await h.controller.command({ command: 'redo' }), redoIds = csvIds((await h.snapshot()).csv);
        const undone = await h.controller.command({ command: 'undo' }), undoCsv = (await h.snapshot()).csv;
        await h.open(`corrupt-${kind}-reopened.ply`);
        const reopened = { camera: h.controller.camera!.state, nativeCamera: useApp.getState().summary!.camera.map(Math.fround),
          background: h.controller.camera!.background, choices: useApp.getState().savedViewChoices.length, status: useApp.getState().viewStatus,
          admissions: imageAdmissions(h.controller), name: useApp.getState().sourceName };
        const current = await stored();
        return { kind, records: lookup.records.length, corrupt: lookup.corrupt, decodeCalls, before, after, baseline, admissions,
          redone, redoIds, undone, undoCsv, reopened, beforeMetadata: corrupted.metadataHashes, afterMetadata: current.metadataHashes,
          expectedImageHash: previous.records[0].thumbnail.sha256, corruptedImage,
          afterImage: current.images[0] ? await blobHash(current.images[0].image) : null, imageCount: current.images.length,
          error: useApp.getState().error };
      } finally { globalThis.createImageBitmap = original; await h.dispose(); }
    },
    async geometryView(kind: 'points' | 'mesh') {
      const h = await setup();
      try {
        const bytes = new TextEncoder().encode(geometrySources[kind]); await h.open(`saved-${kind}.ply`, bytes);
        const summary = await h.controller.client!.command({ command: 'summary' }), initialKey = h.controller.sourceFingerprint;
        const view = h.controller.camera!.state;
        view[0] += .125; view[7] = 62; view[9] = .25; h.controller.camera!.set(view); h.controller.camera!.background = 'gray';
        const requested = h.controller.camera!.state, accepted = await h.controller.updateThumbnail(), data = await stored();
        const after = await h.controller.client!.command({ command: 'summary' });
        h.controller.camera!.pan(70, 30); h.controller.camera!.background = 'white'; h.controller.resetCamera();
        const reset = { camera: h.controller.camera!.state, background: h.controller.camera!.background };
        await h.open(`renamed-${kind}.ply`, bytes);
        const reopened = { camera: h.controller.camera!.state, background: h.controller.camera!.background,
          key: h.controller.sourceFingerprint, kind: useApp.getState().summary!.kind, count: useApp.getState().summary!.count,
          sceneKind: h.controller.scene!.kind, choices: useApp.getState().savedViewChoices.length, dirty: useApp.getState().dirty,
          admissions: imageAdmissions(h.controller), name: useApp.getState().sourceName };
        const editAccepted = await h.controller.command({ command: 'delete' });
        await h.controller.closeScene();
        return { kind, summary, after, requested, accepted, initialKey, reset, reopened, editAccepted, record: data.records[0],
          records: data.records.length, images: data.images.length, image: await pixels(data.images[0].image),
          closedAdmissions: imageAdmissions(h.controller), error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
    async crops() {
      const results = [];
      for (const [width, height] of [[9, 5], [5, 9], [3, 3], [2048, 2048]]) {
        const canvas = new OffscreenCanvas(width, height), context = canvas.getContext('2d')!;
        context.fillStyle = '#ff0000'; context.fillRect(0, 0, width, height);
        // Literal centered blue square. Red margins must never appear in output.
        const side = Math.min(width, height); context.fillStyle = '#0000ff'; context.fillRect(Math.floor((width - side) / 2), Math.floor((height - side) / 2), side, side);
        const raw = ownRgbaImage(width, height, context.getImageData(0, 0, width, height).data, () => {});
        try {
          const cropped = await createSavedThumbnail(raw, { admit: () => () => {} });
          try { results.push({ width, height, thumbnail: cropped.thumbnail, pixels: await pixels(cropped.image) }); }
          finally { cropped.dispose(); }
        } finally { raw.dispose(); }
      }
      return results;
    },
    async ambiguity() {
      const h = await setup();
      try {
        h.controller.camera!.background = 'gray'; if (!await settledThumbnail(h.controller)) throw new Error('First view save failed.');
        const data = await stored(), first = data.records[0];
        h.controller.camera!.background = 'white'; if (!await settledThumbnail(h.controller)) throw new Error('Second view save failed.');
        // Keep the independently captured first pair as a second legitimate record.
        const other = validateSavedViewRecord({ ...first, recordId: crypto.randomUUID(), displayName: 'Other saved copy' });
        await new SavedViewStorage().put(other, data.images[0].image, h.operation);
        await h.open('ambiguous-copy.ply'); const choices = useApp.getState().savedViewChoices;
        const initial = h.controller.camera!.background, chosen = await h.controller.chooseSavedView(other.recordId);
        h.controller.camera!.background = 'white'; h.controller.resetCamera();
        return { choices: choices.map(value => value.view.background).sort(), initial, chosen, background: h.controller.camera!.background,
          remaining: useApp.getState().savedViewChoices.length, error: useApp.getState().error };
      } finally { await h.dispose(); }
    },
  };
}
declare global { interface Window { savedViewHarness: ReturnType<typeof harness> } }
window.savedViewHarness = harness();
