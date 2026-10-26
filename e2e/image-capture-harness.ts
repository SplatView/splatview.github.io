import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport } from './admitted-export';
// Real App/native/GPU/image/IndexedDB paths. Holds delay genuine asynchronous
// completions; they never fabricate image bytes, allocator receipts or pixels.
import { AppController } from '../src/app/controller';
import { setApp, useApp } from '../src/app/store';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { ResourceLedger } from '../src/document/resources';
import type { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import type { SceneRenderer } from '../src/renderer/contracts';
import { SAVED_VIEW_DATABASE } from '../src/io/savedViewStorage';
import { withRgbaImage, type OwnedRgbaImage } from '../src/io/image';
import { gaussianPly } from '../tests/fixtures/gaussians';

type CaptureKind = 'gaussian' | 'points' | 'mesh';
// Independent literal PLYs used by the existing saved-view/geometry fixtures;
// importing their harness entry modules would also initialize another App.
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
  return { entered: new Promise<void>(resolve => { enter = resolve; }), held: new Promise<void>(resolve => { release = resolve; }), enter, release };
}
async function until(predicate: () => boolean) {
  const deadline = performance.now() + 10000;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('The actual image lifecycle boundary was not reached.'); await new Promise<void>(resolve => setTimeout(resolve, 0)); }
}
const digest = async (bytes: BufferSource) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
async function pixels(blob: Blob) {
  const bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0); const rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const corner = Array.from(rgba.slice(0, 4)); let foreground = 0;
    for (let index = 0; index < rgba.length; index += 4) if ([0, 1, 2].some(channel => Math.abs(rgba[index + channel] - corner[channel]) > 5)) foreground++;
    return { width: bitmap.width, height: bitmap.height, corner, foreground, hash: await digest(rgba), rgba };
  } finally { bitmap.close(); }
}
const compactPixels = ({ rgba: _rgba, ...value }: Awaited<ReturnType<typeof pixels>>) => value;
function admissions(app: AppController) {
  const ledger = (app as unknown as { ledger: ResourceLedger }).ledger;
  const entries = [...(ledger as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries.values()].filter(entry => entry.category === 'image');
  return { bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), allocations: entries.length };
}
async function setup(kind: CaptureKind = 'gaussian') {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SAVED_VIEW_DATABASE); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); request.onblocked = () => reject(new Error('Image test storage was blocked.'));
  });
  const canvas = document.createElement('canvas'); canvas.style.width = '321px'; canvas.style.height = '241px'; document.body.append(canvas);
  const app = new AppController(); await app.initialize(canvas);
  const initialImage = admissions(app);
  const open = async (name: string, bytes = gaussianPly(3)) => {
    await app.openFiles([new File([bytes], name)]); if (useApp.getState().navigationPrompt) await app.discardAndContinue();
    if (!app.scene || !app.client || useApp.getState().sourceName !== name) throw new Error(useApp.getState().error ?? 'Actual image fixture did not open.');
  };
  if (kind === 'gaussian') {
    await open('image-sh3.ply');
    for (const command of [{ command: 'single', index: 0, operation: 0 }, { command: 'single', index: 2, operation: 1 },
      { command: 'single', index: 1, operation: 1 }, { command: 'undo' }]) if (!await app.command(command)) throw new Error('Image history fixture was refused.');
  } else await open(`image-${kind}.ply`, new TextEncoder().encode(geometrySources[kind]));
  app.camera!.background = 'gray'; setApp({ background: 'gray' });
  // The history fixture leaves the automatic transform pivot query briefly running.
  let idleSince: number | undefined;
  for (const start = performance.now(); performance.now() - start < 10_000;) {
    const state = useApp.getState(), now = performance.now();
    if (state.busy || state.transformPivotPending) idleSince = undefined;
    else if ((idleSince ??= now) <= now - 50) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  const summary = () => ({ image: admissions(app), sourceName: useApp.getState().sourceName, hasClient: !!app.client, hasScene: !!app.scene,
    busy: useApp.getState().busy, thumbnailPending: useApp.getState().thumbnailPending, error: useApp.getState().error, viewStatus: useApp.getState().viewStatus });
  const native = async () => {
    const csv = new TextDecoder().decode(await admittedExport(app.client!, 5, 0));
    return { summary: await app.client!.command({ command: 'summary' }), document: { ...app.client!.revision },
      csv, camera: [...app.camera!.state], background: app.camera!.background, sourceFingerprint: app.sourceFingerprint };
  };
  const close = async () => { await app.closeScene(); if (useApp.getState().navigationPrompt) await app.discardAndContinue(); };
  return { app, canvas, open, close, summary, native, initialImage,
    dispose: async () => { await close(); app.dispose(); canvas.remove(); } };
}
type Session = Awaited<ReturnType<typeof setup>>;
function rgbaPlane(bytes: Uint8ClampedArray<ArrayBuffer>) {
  if (!bytes.length || bytes.length % 4) throw new Error('The observed RGBA plane is incomplete.');
  const corner = Array.from(bytes.subarray(0, 4));
  let opaque = 0, minimum = 255, maximum = 0, foreground = 0;
  for (let at = 0; at < bytes.length; at += 4) {
    const alpha = bytes[at + 3]; minimum = Math.min(minimum, alpha); maximum = Math.max(maximum, alpha);
    if (alpha === 255) opaque++;
    if (Math.abs(bytes[at] - corner[0]) > 5 || Math.abs(bytes[at + 1] - corner[1]) > 5 || Math.abs(bytes[at + 2] - corner[2]) > 5) foreground++;
  }
  const count = bytes.length / 4;
  return { count, opaque, nonOpaque: count - opaque, minimum, maximum, foreground, background: count - foreground, corner };
}
async function captureDocument(h: Session) {
  const app = h.app, client = app.client!, scene = app.scene!;
  const csv = scene.kind === 'gaussian' ? new TextDecoder().decode(await admittedExport(client, 5, 0)) : null;
  let masks: number[] | null = null;
  if (scene.kind === 'gaussian') await client.readMasks(bytes => { masks = Array.from(new Uint8Array(bytes)); });
  return { summary: await client.command({ command: 'summary' }), document: { ...client.revision }, csv, masks,
    sceneKind: scene.kind, geometry: scene.kind === 'geometry' ? { ...scene.descriptor } : null,
    editingAvailable: app.editingAvailable, camera: [...app.camera!.state], sourceFingerprint: app.sourceFingerprint, dirty: useApp.getState().dirty };
}
async function opaqueThumbnailBackground(h: Session, background: 'black' | 'gray' | 'white') {
  const app = h.app, renderer = app.renderer!, originalCapture = renderer.captureRgba;
  const decode = window.createImageBitmap, encode = OffscreenCanvas.prototype.convertToBlob;
  const captures: (ReturnType<typeof rgbaPlane> & { width: number; height: number; hash: string; sceneKind: string; nativeKind: number; currentScene: boolean; currentCamera: boolean })[] = [];
  const rawOwners: OwnedRgbaImage[] = [];
  const decodeInputs: { finalEncodedBlob: boolean; type: string | null; width: number; height: number }[] = [];
  let captureCalls = 0, encodes = 0, encoded: Blob | undefined;
  app.camera!.background = background; setApp({ background });
  const before = await captureDocument(h);
  renderer.captureRgba = async function (...args) {
    captureCalls++; const raw = await originalCapture.apply(this, args);
    try {
      await withRgbaImage(raw, async bytes => {
        const operation = args[2], release = operation.admit(bytes.byteLength + 64);
        try {
          const plane = rgbaPlane(bytes), hash = await digest(bytes);
          operation.signal?.throwIfAborted(); operation.current?.();
          captures.push({ ...plane, width: raw.width, height: raw.height, hash, sceneKind: args[0].kind,
            nativeKind: args[0].kind === 'gaussian' ? 0 : args[0].descriptor.kind,
            currentScene: args[0] === app.scene, currentCamera: args[1] === app.camera });
        } finally { release(); }
      });
      rawOwners.push(raw); return raw;
    } catch (error) { raw.dispose(); throw error; }
  };
  OffscreenCanvas.prototype.convertToBlob = async function (...args) {
    encodes++; encoded = await encode.apply(this, args); return encoded;
  };
  window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
    const input = args[0], bitmap = await decode(...args);
    decodeInputs.push({ finalEncodedBlob: input === encoded, type: input instanceof Blob ? input.type : null, width: bitmap.width, height: bitmap.height });
    return bitmap;
  }) as typeof createImageBitmap;
  let accepted: boolean;
  try { accepted = await app.updateThumbnail(); }
  finally {
    renderer.captureRgba = originalCapture; window.createImageBitmap = decode; OffscreenCanvas.prototype.convertToBlob = encode;
  }
  const pair = await stored();
  if (!accepted || pair.records.length !== 1 || pair.images.length !== 1 || captures.length !== 1 || rawOwners.length !== 1)
    throw new Error(useApp.getState().viewStatus ?? 'The actual opaque capture did not publish one thumbnail pair.');
  const blob = pair.images[0].image, record = JSON.parse(await pair.records[0].meta.text());
  const ledger = (app as unknown as { ledger: ResourceLedger }).ledger;
  // Bound this diagnostic's bitmap/canvas/readback/hash copies separately from
  // the production owner, which has already finished filtering and storage.
  const release = ledger.reserve('image', blob.size * 3 + 1024 * 1024 * 4 * 4 + 16384 + 64);
  let bitmap: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined, rgba: Uint8ClampedArray<ArrayBuffer> | undefined, encodedBytes: ArrayBuffer | undefined;
  try {
    bitmap = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d'); if (!context) throw new Error('The actual thumbnail readback is unavailable.');
    context.drawImage(bitmap, 0, 0); rgba = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const image = { width: bitmap.width, height: bitmap.height, hash: await digest(rgba), ...rgbaPlane(rgba) };
    encodedBytes = await blob.arrayBuffer();
    return { background, accepted, before, after: await captureDocument(h), raw: captures[0],
      calls: { captures: captureCalls, encodes, decodes: decodeInputs.length }, decodeInputs,
      rawBytesAfterStorage: rawOwners[0].pixels.byteLength,
      records: pair.records.length, images: pair.images.length,
      recordId: record.recordId as string, imageRecordId: pair.images[0].recordId, storedRecordId: pair.records[0].recordId,
      sourceKind: record.sourceKind as string, savedBackground: record.view.background as string,
      metadata: record.thumbnail as { type: string; width: number; height: number; byteLength: number; sha256: string },
      image, blobSize: blob.size, blobHash: await digest(encodedBytes) };
  } finally {
    bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; }
    if (rgba?.byteLength) structuredClone(rgba.buffer, { transfer: [rgba.buffer] });
    if (encodedBytes?.byteLength) structuredClone(encodedBytes, { transfer: [encodedBytes] });
    release();
  }
}
function captureSignal(renderer: SceneRenderer) {
  const original = renderer.captureRgba, aborted = gate(); let observed = false;
  renderer.captureRgba = function (...args) {
    const operation = args[2]; operation.signal?.addEventListener('abort', () => { observed = true; aborted.enter(); }, { once: true });
    return original.apply(this, args);
  };
  return { aborted: aborted.entered, observed: () => observed, restore: () => { renderer.captureRgba = original; } };
}
function holdEncode() {
  const original = OffscreenCanvas.prototype.convertToBlob, held = gate(); let calls = 0, completed = 0, released = false;
  OffscreenCanvas.prototype.convertToBlob = async function (...args) {
    calls++; const blob = await original.apply(this, args); completed++;
    if (!released) { held.enter(); await held.held; } return blob;
  };
  return { entered: held.entered, release: () => { released = true; held.release(); }, state: () => ({ calls, completed }), restore: () => { OffscreenCanvas.prototype.convertToBlob = original; } };
}
function holdReadback() {
  const original = GPUBuffer.prototype.mapAsync, destroy = GPUBuffer.prototype.destroy, held = gate(); let readback: GPUBuffer | undefined, destroyed = 0;
  GPUBuffer.prototype.mapAsync = async function (...args) {
    await original.apply(this, args);
    if (this.label === 'Image capture readback' && !readback) { readback = this; held.enter(); await held.held; }
    return undefined;
  };
  GPUBuffer.prototype.destroy = function () { if (this === readback) destroyed++; destroy.call(this); };
  return { entered: held.entered, release: held.release, state: () => ({ mapped: !!readback, destroyed }), restore: () => { GPUBuffer.prototype.mapAsync = original; GPUBuffer.prototype.destroy = destroy; } };
}
type AllocationHost = { checkedAllocation<T>(create: () => T, retire: (value: T) => void): Promise<T> };
function holdAllocation(renderer: GaussianRenderer) {
  const host = renderer as unknown as AllocationHost, original = host.checkedAllocation.bind(host), held = gate(); let used = false;
  host.checkedAllocation = async function <T>(create: () => T, retire: (value: T) => void) {
    const result = await original(create, retire); if (!used) { used = true; held.enter(); await held.held; } return result;
  };
  return { entered: held.entered, release: held.release, restore: () => { host.checkedAllocation = original; } };
}
function downloads() {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL, click = HTMLAnchorElement.prototype.click;
  const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
  const blobs = new Map<string, Blob>(), outputs: { blob: Blob; name: string; url: string }[] = [], revoked: string[] = [], timers: { id: number; fire: () => void; delay: number }[] = [];
  URL.createObjectURL = function (value) { const url = create.call(URL, value); if (value instanceof Blob) blobs.set(url, value); return url; };
  URL.revokeObjectURL = function (url) { revoked.push(url); revoke.call(URL, url); };
  HTMLAnchorElement.prototype.click = function () {
    if (/\.(?:jpe?g|png)$/i.test(this.download)) { const blob = blobs.get(this.href); if (!blob) throw new Error('No actual Download Blob was observed.'); outputs.push({ blob, name: this.download, url: this.href }); }
    click.call(this);
  };
  window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    const id = timeout(callback, delay, ...args);
    if (typeof callback === 'function' && delay === 60000) timers.push({ id, delay, fire: () => callback(...args) }); return id;
  }) as typeof window.setTimeout;
  const expireAt = (index: number) => { const timer = timers[index]; if (!timer || timer.delay !== 60000) throw new Error('The real 60-second Download settlement timer was not armed.'); clear(timer.id); timer.fire(); };
  return { outputs, revoked, expire: () => expireAt(timers.length - 1), expireAt,
    restore() { URL.createObjectURL = create; URL.revokeObjectURL = revoke; HTMLAnchorElement.prototype.click = click; window.setTimeout = timeout; } };
}
async function stored() {
  const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(SAVED_VIEW_DATABASE, 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  try { return await new Promise<{ records: { recordId: string; meta: Blob }[]; images: { recordId: string; image: Blob }[] }>((resolve, reject) => {
    const tx = db.transaction(['views', 'thumbnails'], 'readonly'), records = tx.objectStore('views').getAll(), images = tx.objectStore('thumbnails').getAll();
    tx.oncomplete = () => resolve({ records: records.result, images: images.result }); tx.onabort = () => reject(tx.error);
  }); } finally { db.close(); }
}
function holdTransaction() {
  const put = IDBObjectStore.prototype.put, held = gate(); let transaction: IDBTransaction | undefined, active = true, terminal: string | null = null, writes = 0;
  IDBObjectStore.prototype.put = function (...args) {
    const request = put.apply(this, args);
    if (!transaction && this.name === 'views' && this.transaction.mode === 'readwrite') {
      transaction = this.transaction; transaction.addEventListener('abort', () => { active = false; terminal = 'aborted'; }); transaction.addEventListener('complete', () => { active = false; terminal = 'completed'; });
    }
    if (this.transaction === transaction) { request.addEventListener('success', () => { writes++; });
      if (this.name === 'thumbnails') { const store = this; const keepAlive = () => { if (!active) return; const request = store.get('__image_capture_keepalive__'); request.onsuccess = keepAlive; }; keepAlive(); held.enter(); }
    }
    return request;
  };
  return { entered: held.entered, state: () => ({ writes, terminal }), release: () => { active = false; }, restore: () => { IDBObjectStore.prototype.put = put; } };
}
async function ownedPixels(h: Session, type: string) {
  const output = await h.app.captureOwned(type);
  try { return { type: output.blob.type, size: output.blob.size, admitted: admissions(h.app), pixels: compactPixels(await pixels(output.blob)) }; }
  finally { output.dispose(); }
}

const harness = {
  async actualImages() {
    const h = await setup(); let held: ReturnType<typeof holdAllocation> | undefined;
    try {
      const before = await h.native(), baseline = admissions(h.app), neutral = await ownedPixels(h, 'image/png');
      const grade = [...NEUTRAL_COLOR]; grade[0] = 1.4; h.app.setGrade(grade);
      const preview = await ownedPixels(h, 'image/png'); held = holdAllocation(requireWebGpuRenderer(h.app.renderer));
      const pending = h.app.captureOwned('image/png'); await held.entered;
      grade[0] = .35; h.app.setGrade([...grade]); h.app.camera!.pan(80, 30); h.app.camera!.background = 'white';
      h.canvas.width = 333; h.canvas.height = 199; h.app.camera!.aspect(333 / 199);
      held.release(); held.restore(); const output = await pending;
      let frozen; try { frozen = compactPixels(await pixels(output.blob)); } finally { output.dispose(); }
      h.app.setGrade([...NEUTRAL_COLOR]); h.app.camera!.set(before.camera); h.app.camera!.background = 'gray';
      h.canvas.width = 321; h.canvas.height = 241; h.app.camera!.aspect(321 / 241);
      const jpeg = await ownedPixels(h, 'image/jpeg'), after = await h.native();
      return { before, after, baseline, neutral, preview, frozen, jpeg, final: admissions(h.app) };
    } finally { held?.release(); held?.restore(); h.app.setGrade([...NEUTRAL_COLOR]); await h.dispose(); }
  },
  async downloadSettlement(reason: 'timeout' | 'pagehide' | 'close') {
    const h = await setup(), observed = downloads();
    try {
      const before = await h.native(), baseline = admissions(h.app); await h.app.snapshot();
      if (observed.outputs.length !== 1) throw new Error('Snapshot did not hand off one actual image.');
      const output = observed.outputs[0], image = compactPixels(await pixels(output.blob)), retained = admissions(h.app);
      if (reason === 'timeout') observed.expire(); else if (reason === 'pagehide') window.dispatchEvent(new PageTransitionEvent('pagehide')); else await h.close();
      const settled = admissions(h.app), revoked = observed.revoked.filter(url => url === output.url).length;
      window.dispatchEvent(new PageTransitionEvent('pagehide')); const afterSecond = admissions(h.app);
      return { reason, before, baseline, retained, settled, afterSecond, revoked, name: output.name, mime: output.blob.type, image,
        after: h.app.client ? await h.native() : null, state: h.summary() };
    } finally { await h.dispose(); observed.restore(); }
  },
  async closeHeldEncode() {
    const h = await setup(), held = holdEncode(), signal = captureSignal(h.app.renderer!), observed = downloads(); let closed = false;
    try {
      const baseline = admissions(h.app), capturing = h.app.snapshot(); await held.entered;
      const admitted = admissions(h.app), closing = h.close().then(() => { closed = true; }); await signal.aborted;
      const whileHeld = { closed, image: admissions(h.app), encode: held.state(), outputs: observed.outputs.length };
      held.release(); await Promise.all([capturing, closing]);
      return { baseline, admitted, whileHeld, final: h.summary(), closed, outputs: observed.outputs.length, aborted: signal.observed() };
    } finally { held.release(); held.restore(); signal.restore(); await h.dispose(); observed.restore(); }
  },
  async reentrantAllocationClose() {
    const h = await setup(), observed = downloads(), signal = captureSignal(h.app.renderer!), held = gate();
    const host = requireWebGpuRenderer(h.app.renderer) as unknown as AllocationHost, allocate = host.checkedAllocation.bind(host), device = requireWebGpuRenderer(h.app.renderer).device;
    const create = device.createBuffer.bind(device); let readback: GPUBuffer | undefined, destroyed = 0, returned = false, synchronous = false, closed = false;
    let closing: Promise<void> | undefined, once = false;
    device.createBuffer = descriptor => {
      const buffer = create(descriptor);
      if (descriptor.label === 'Image capture readback') { readback = buffer; const destroy = buffer.destroy.bind(buffer); buffer.destroy = () => { destroyed++; destroy(); return undefined; }; }
      return buffer;
    };
    host.checkedAllocation = async <T>(factory: () => T, retire: (value: T) => void) => {
      const first = !once; if (first) once = true;
      const value = await allocate(() => { const actual = factory(); if (first) { synchronous = !returned; closing = h.close().then(() => { closed = true; }); } return actual; }, retire);
      if (first) { held.enter(); await held.held; } return value;
    };
    try {
      const baseline = admissions(h.app), capturing = h.app.snapshot(); returned = true; await held.entered; await signal.aborted;
      const whileHeld = { synchronous, closed, readbackAllocated: !!readback, destroyed, image: admissions(h.app), outputs: observed.outputs.length };
      held.release(); await Promise.all([capturing, closing]);
      return { baseline, whileHeld, closed, destroyed, outputs: observed.outputs.length, final: h.summary(),
        remainingTasks: (h.app as unknown as { imageTasks: Set<unknown> }).imageTasks.size };
    } finally { held.release(); host.checkedAllocation = allocate; device.createBuffer = create; signal.restore(); await h.dispose(); observed.restore(); }
  },
  async reentrantUrlClose() {
    const h = await setup(), observed = downloads(), create = URL.createObjectURL; let once = false, returned = false, synchronous = false, closed = false;
    let closing: Promise<void> | undefined, oldUrl: string | undefined;
    URL.createObjectURL = value => {
      const url = create.call(URL, value);
      if (!once && value instanceof Blob && value.type === 'image/jpeg') { once = true; oldUrl = url; synchronous = !returned; closing = h.close().then(() => { closed = true; }); }
      return url;
    };
    try {
      const baseline = admissions(h.app), capturing = h.app.snapshot(); returned = true; await capturing; await closing;
      const afterClose = { closed, image: admissions(h.app), revoked: observed.revoked.filter(url => url === oldUrl).length,
        trackedDownloads: (h.app as unknown as { imageDownloads: Set<unknown> }).imageDownloads.size, state: h.summary() };
      URL.createObjectURL = create; await h.open('after-reentrant-download.ply'); await h.app.snapshot();
      const current = observed.outputs.at(-1)!; if (current.url === oldUrl) throw new Error('No fresh image Download was created after reopening.');
      const retained = admissions(h.app); observed.expireAt(0);
      const afterOldTimer = { image: admissions(h.app), oldRevocations: observed.revoked.filter(url => url === oldUrl).length,
        freshRevocations: observed.revoked.filter(url => url === current.url).length,
        trackedDownloads: (h.app as unknown as { imageDownloads: Set<unknown> }).imageDownloads.size };
      await h.close(); return { baseline, synchronous, afterClose, retained, afterOldTimer, final: h.summary() };
    } finally { URL.createObjectURL = create; await h.dispose(); observed.restore(); }
  },
  async clipboardSetup() {
    const h = await setup(), write = navigator.clipboard.write.bind(navigator.clipboard), held = gate();
    const observation = { calls: 0, synchronous: false, trusted: false, nativeSettled: false, returnedSettled: false, png: false };
    let gesture = false, trusted = false;
    navigator.clipboard.write = async items => {
      observation.calls++; observation.synchronous = gesture; observation.trusted = trusted; observation.png = items.length === 1 && items[0].types.includes('image/png');
      await write(items); observation.nativeSettled = true; held.enter(); await held.held; observation.returnedSettled = true;
    };
    const button = document.createElement('button'); button.textContent = 'Copy image'; document.body.append(button);
    button.addEventListener('click', event => { gesture = true; trusted = event.isTrusted; try { h.app.copyImage(); } finally { gesture = false; } });
    let closing: Promise<void> | undefined, closed = false;
    const session = { h, held, observation, button, write, startClose() { closing = h.close().then(() => { closed = true; }); }, closed: () => closed,
      joined: async () => { await closing; }, restore() { navigator.clipboard.write = write; button.remove(); } };
    clipboardSession = session; return { baseline: admissions(h.app), expected: await ownedPixels(h, 'image/png') };
  },
  async clipboardHeld() {
    const session = clipboardSession!; await session.held.entered;
    const items = await navigator.clipboard.read(), png = await items.find(item => item.types.includes('image/png'))!.getType('image/png');
    const image = compactPixels(await pixels(png)), retained = admissions(session.h.app); session.startClose();
    await until(() => !session.h.app.client || !!(session.h.app as unknown as { closing?: Promise<void> }).closing);
    return { ...session.observation, retained, image, closed: session.closed(), whileHeld: admissions(session.h.app) };
  },
  async clipboardRelease() {
    const session = clipboardSession!;
    try { session.held.release(); await session.joined(); return { ...session.observation, closed: session.closed(), final: session.h.summary() }; }
    finally { session.held.release(); session.restore(); await session.h.dispose(); clipboardSession = undefined; }
  },
  async rawThumbnail() {
    const h = await setup(), decode = window.createImageBitmap, encode = OffscreenCanvas.prototype.convertToBlob; let decodes = 0, encodes = 0;
    let encoded: Blob | undefined, encodeCompleted = false;
    const decodeInputs: { afterEncode: boolean; finalEncodedBlob: boolean; type: string | null; bytes: number | null; width: number; height: number }[] = [];
    try {
      const before = await h.native(), baseline = admissions(h.app), output = await h.app.captureOwned('image/png');
      let full; try { full = await pixels(output.blob); } finally { output.dispose(); }
      window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
        decodes++; const input = args[0], observed = { afterEncode: encodeCompleted, finalEncodedBlob: input === encoded,
          type: input instanceof Blob ? input.type : null, bytes: input instanceof Blob ? input.size : null, width: 0, height: 0 };
        decodeInputs.push(observed); const bitmap = await decode(...args); observed.width = bitmap.width; observed.height = bitmap.height; return bitmap;
      }) as typeof createImageBitmap;
      OffscreenCanvas.prototype.convertToBlob = async function (...args) {
        encodes++; encoded = await encode.apply(this, args); encodeCompleted = true; return encoded;
      };
      const accepted = await h.app.updateThumbnail(), calls = { decodes, encodes };
      window.createImageBitmap = decode; OffscreenCanvas.prototype.convertToBlob = encode;
      const pair = await stored(), image = await pixels(pair.images[0].image), record = JSON.parse(await pair.records[0].meta.text());
      // 321x241 has a literal 241-square centered crop, without resampling.
      const cropped = new Uint8ClampedArray(241 * 241 * 4);
      for (let y = 0; y < 241; y++) cropped.set(full.rgba.subarray((y * 321 + 40) * 4, (y * 321 + 281) * 4), y * 241 * 4);
      const after = await h.native(), retained = admissions(h.app); await h.close();
      return { accepted, before, after, baseline, calls, decodeInputs, records: pair.records.length, images: pair.images.length,
        image: compactPixels(image), expectedCropHash: await digest(cropped), metadata: record.thumbnail, blobSize: pair.images[0].image.size,
        blobHash: await digest(await pair.images[0].image.arrayBuffer()), retained, final: h.summary() };
    } finally { window.createImageBitmap = decode; OffscreenCanvas.prototype.convertToBlob = encode; await h.dispose(); }
  },
  async opaqueThumbnails(kind: CaptureKind) {
    const h = await setup(kind);
    try {
      // The short side exceeds the desktop1024 limit: this is a real centered
      // 1025-to-1024 resample, rather than the existing identity-crop case.
      h.canvas.style.width = '1027px'; h.canvas.style.height = '1025px';
      await until(() => h.canvas.width === 1027 && h.canvas.height === 1025);
      h.app.camera!.aspect(1027 / 1025);
      const baseline = admissions(h.app), rows = [];
      for (const background of ['black', 'gray', 'white'] as const) rows.push(await opaqueThumbnailBackground(h, background));
      let history: { before: Awaited<ReturnType<typeof captureDocument>>; redoAccepted: boolean; redone: Awaited<ReturnType<typeof captureDocument>>;
        undoAccepted: boolean; restored: Awaited<ReturnType<typeof captureDocument>> } | null = null;
      if (kind === 'gaussian') {
        const before = await captureDocument(h), redoAccepted = await h.app.command({ command: 'redo' }), redone = await captureDocument(h);
        const undoAccepted = await h.app.command({ command: 'undo' }), restored = await captureDocument(h);
        history = { before, redoAccepted, redone, undoAccepted, restored };
      }
      const retained = admissions(h.app); await h.close();
      const tasks = h.app as unknown as { imageTasks: Set<unknown>; thumbnailTasks: Set<unknown>; viewTransferTasks: Set<unknown> };
      return { kind, initialImage: h.initialImage, baseline, rows, retained, history, final: h.summary(),
        remainingTasks: { images: tasks.imageTasks.size, thumbnails: tasks.thumbnailTasks.size, transfers: tasks.viewTransferTasks.size } };
    } finally { await h.dispose(); }
  },
  async thumbnailCloseTransaction() {
    const h = await setup(); let held: ReturnType<typeof holdTransaction> | undefined;
    try {
      if (!await h.app.updateThumbnail()) throw new Error('The previous actual view/PNG pair was not saved.');
      const old = await stored(), previous = { meta: await old.records[0].meta.text(), hash: await digest(await old.images[0].image.arrayBuffer()) }, baseline = admissions(h.app);
      h.app.camera!.background = 'white'; held = holdTransaction(); const updating = h.app.updateThumbnail(); await held.entered; await until(() => held!.state().writes === 2);
      const queued = held.state(), admitted = admissions(h.app); const closing = h.close(); await until(() => held!.state().terminal !== null);
      const terminal = held.state(); held.release(); const accepted = await updating; await closing;
      const after = await stored(); return { baseline, admitted, queued, terminal, accepted,
        previous, current: { meta: await after.records[0].meta.text(), hash: await digest(await after.images[0].image.arrayBuffer()) },
        records: after.records.length, images: after.images.length, final: h.summary() };
    } finally { held?.release(); held?.restore(); await h.dispose(); }
  },
  async invalidateReadback(kind: 'replace' | 'loss') {
    const h = await setup(), held = holdReadback(), signal = captureSignal(h.app.renderer!), observed = downloads();
    try {
      const before = await h.native(), oldClient = h.app.client, oldScene = h.app.scene, oldEpoch = requireWebGpuRenderer(h.app.renderer).deviceEpoch;
      const capturing = h.app.snapshot(); await held.entered; const admitted = admissions(h.app);
      const competing = kind === 'replace' ? h.open('replacement-image.ply', new TextEncoder().encode(new TextDecoder().decode(gaussianPly(3)).replace('-0.4 0 0', '-0.5 0 0')))
        : (async () => { requireWebGpuRenderer(h.app.renderer).device.destroy(); await requireWebGpuRenderer(h.app.renderer).device.lost; await h.app.retryRenderer(); })();
      await signal.aborted; const whileHeld = { image: admissions(h.app), readback: held.state(), outputs: observed.outputs.length };
      held.release(); await Promise.all([capturing, competing]);
      const after = await h.native(); return { kind, before, after, admitted, whileHeld, final: h.summary(), readback: held.state(),
        outputs: observed.outputs.length, sameClient: h.app.client === oldClient, replacedScene: h.app.scene !== oldScene,
        oldEpoch, epoch: requireWebGpuRenderer(h.app.renderer).deviceEpoch, aborted: signal.observed() };
    } finally { held.release(); held.restore(); signal.restore(); await h.dispose(); observed.restore(); }
  },
};
let clipboardSession: { h: Session; held: ReturnType<typeof gate>; observation: { calls: number; synchronous: boolean; trusted: boolean; nativeSettled: boolean; returnedSettled: boolean; png: boolean };
  button: HTMLButtonElement; write: typeof navigator.clipboard.write; startClose(): void; closed(): boolean; joined(): Promise<void>; restore(): void } | undefined;
declare global { interface Window { imageCaptureHarness: typeof harness } }
window.imageCaptureHarness = harness;
