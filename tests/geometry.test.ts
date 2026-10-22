import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { emptyCensus } from './fixtures/allocation-census';
import { CoreClient } from '../src/document/coreClient';
import { GEOMETRY_CHUNK_BYTES, geometryChunkCount, geometryDescriptor, geometryHeapChunk, sameGeometryDescriptor,
  validateGeometryChunk, validateGeometryDescriptor, type GeometryDescriptor } from '../src/document/geometry';
import type { NativeSummary, WorkerRequest } from '../src/document/types';
import { ResourceLedger } from '../src/document/resources';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));
function descriptor(kind: 1 | 2 = 2, vertices = 3): GeometryDescriptor {
  return { layoutVersion: 1, kind, vertexCount: vertices, triangleCount: kind === 2 ? 1 : 0,
    vertexStride: 16, indexStride: 4, vertexBytes: vertices * 16, indexBytes: kind === 2 ? 12 : 0, revision: 0, contentRevision: 0 };
}
function summary(geometry = descriptor()): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: geometry.vertexCount, sourceCount: geometry.vertexCount + 4,
    shDegree: 0, format: 'PLY', kind: geometry.kind, selected: 0, visible: geometry.vertexCount,
    canUndo: false, canRedo: false, revision: geometry.revision, contentRevision: geometry.contentRevision,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 100, 45, 0, 0, 1], memoryBytes: geometry.vertexBytes + geometry.indexBytes,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [],
    geometry, sourceFaces: geometry.kind === 2 ? 1 : 0, sampledGeometry: true };
}
class ObservedWorker {
  static latest: ObservedWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: unknown;
  onmessageerror?: unknown;
  terminated = false;
  sent: WorkerRequest[] = [];
  private posted?: (value: WorkerRequest) => void;
  private initializationId = '';
  private heapSequence = 0;
  private allocation = { loaded: false, kind: 0, count: 0, memoryBytes: 0, selectionMapBytes: 0, selectionMapRetainedIds: [] as number[] };
  constructor() { ObservedWorker.latest = this; }
  telemetry(result: Record<string, unknown> = {}) {
    const state = result.summary ?? (result.outcome as { summary?: unknown } | undefined)?.summary;
    if (state) {
      const value = state as NativeSummary;
      this.allocation = { loaded: value.loaded, kind: value.kind, count: value.count, memoryBytes: value.memoryBytes,
        selectionMapBytes: value.selectionMapBytes, selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
    }
    return { initializationId: this.initializationId, heap: { sequence: ++this.heapSequence, heapBytes: 128 * 1024 * 1024 }, census: emptyCensus(this.heapSequence), allocation: { ...this.allocation } };
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }, transfer: Transferable[] = []) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready',
        mode: value.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } }));
    } else {
      const received = transfer.length ? structuredClone(value, { transfer }) : value;
      if (value.type === 'source-range') expect(value.bytes.byteLength).toBe(0);
      this.sent.push(received); const posted = this.posted; this.posted = undefined; posted?.(received);
    }
  }
  next() { return new Promise<WorkerRequest>(resolve => { this.posted = resolve; }); }
  respond(request: WorkerRequest, result: Record<string, unknown>) {
    const data = { ...request, ...this.telemetry(result), ...result };
    const deliver = () => this.onmessage?.({ data });
    // Source replies are later worker message events; never synchronously
    // acknowledge inside the host's transfer-and-consume call stack.
    if (typeof result.type === 'string' && result.type.startsWith('source-')) setTimeout(deliver, 0);
    else deliver();
  }
  terminate() { this.terminated = true; }
}
const clients: CoreClient[] = [];
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
async function client(geometry = descriptor()) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', ObservedWorker);
  const result = new CoreClient(); clients.push(result); await result.ready();
  const bytes = Buffer.from('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n1 0 0\n0 1 0\n');
  // Independent literal v1 single-file layout: prefix, kind/count, role/path,
  // big-endian resource length, then the SHA-256 of the actual transferred bytes.
  const canonical = Buffer.alloc(69); canonical.write('SplatViewSource\0v1\0', 0, 'utf8');
  canonical.writeUInt32BE(1, 20); canonical[24] = 1; canonical.writeBigUInt64BE(BigInt(bytes.length), 29);
  createHash('sha256').update(bytes).digest().copy(canonical, 37);
  const fingerprint = { scheme: 'splatview-source-v1', resourceCount: 1, totalBytes: bytes.length,
    assetDigest: createHash('sha256').update(canonical).digest('hex'), sourceKindHint: 'PLY' };
  const ledger = new ResourceLedger(1024 * 1024), generation = result.revision.sourceGeneration;
  const worker = ObservedWorker.latest, posted = worker.next();
  const opening = result.load(new File([new Uint8Array(bytes)], 'geometry-fixture.ply'), 100, 10000, {
    admit: size => ledger.reserve('work', size),
    current() { if (result.revision.sourceGeneration !== generation) throw new Error('The fixture source was replaced.'); },
  });
  const request = await posted;
  if (request.type !== 'source-load') throw new Error('Expected a source descriptor load.');
  expect(request).not.toHaveProperty('file');
  expect(request.source).toMatchObject({ kind: 'single', byteLength: bytes.length, path: '', role: 'primary' });
  const range = { operationId: request.source.operationId, resourceId: request.source.resourceId,
    rangeId: 0, offset: 0, length: bytes.length };
  const transferred = worker.next(); worker.respond(request, { type: 'source-range-request', ...range });
  const received = await transferred;
  expect(received).toMatchObject({ type: 'source-range', ...range });
  if (received.type !== 'source-range') throw new Error('Expected transferred source bytes.');
  expect(new Uint8Array(received.bytes)).toEqual(new Uint8Array(bytes));
  worker.respond(request, { type: 'source-range-consumed', ...range }); await tick();
  worker.respond(request, { type: 'source-load-result', operationId: range.operationId, resourceId: range.resourceId,
    consumedBytes: bytes.length, summary: summary(geometry), fingerprint });
  await expect(opening).resolves.toEqual({ summary: summary(geometry), fingerprint });
  expect(ledger.usage.bytes).toBe(0); expect(ledger.usage.allocations).toBe(0);
  return { core: result, worker };
}
function chunk(geometry: GeometryDescriptor, channel: 'vertices' | 'indices', first = 0, chunkId = channel === 'vertices' ? 0 : 1) {
  const count = geometryChunkCount(geometry, channel, first);
  return { type: 'geometry-chunk', descriptor: geometry, channel, first, count, chunkId,
    bytes: new ArrayBuffer(count * (channel === 'vertices' ? 16 : 4)) };
}
afterEach(() => { for (const value of clients.splice(0)) value.dispose(); vi.unstubAllGlobals(); });

describe('read-only geometry descriptor', () => {
  it('copies the exact point and mesh layouts, including immutable native revisions', () => {
    for (const kind of [1, 2] as const) {
      const source = descriptor(kind), validated = validateGeometryDescriptor(source);
      expect(validated).toEqual(source); expect(validated).not.toBe(source);
      expect(geometryDescriptor(summary(source))).toEqual(source);
      expect(sameGeometryDescriptor(source, { ...validated, contentRevision: 1 })).toBe(false);
    }
  });
  for (const change of [{ layoutVersion: 2 }, { kind: 0 }, { vertexStride: 12 }, { indexStride: 2 },
    { vertexCount: -1 }, { vertexCount: 0 }, { vertexCount: 1.5 }, { triangleCount: 0 }, { triangleCount: 0x100000000 },
    { vertexBytes: 47 }, { indexBytes: 8 }, { revision: NaN }, { contentRevision: -1 }, { extra: true }])
    it(`refuses malformed descriptor ${JSON.stringify(change)}`, () => {
      expect(() => validateGeometryDescriptor({ ...descriptor(), ...change })).toThrow();
    });
  it('refuses indices in a point layout and incomplete read-only summary metadata', () => {
    expect(() => validateGeometryDescriptor({ ...descriptor(), kind: 1 })).toThrow();
    for (const change of [{ kind: 0 }, { count: 4 }, { revision: 1 }, { selected: 1 }, { canUndo: true },
      { transaction: true }, { selectionDraft: true }, { pending: true }, { sceneChanged: true }, { shDegree: 1 },
      { sourceCount: 2 }, { sourceFaces: 0 }, { sampledGeometry: undefined }, { selectionMapId: 1 },
      { selectionMapBytes: 4 }, { selectionMapRetainedIds: [1] }])
      expect(() => geometryDescriptor({ ...summary(), ...change })).toThrow();
  });
  it('checks deterministic contiguous ranges, vertex-first order and the one MiB copy limit', () => {
    const large = descriptor(2, 65537);
    expect(geometryChunkCount(large, 'vertices', 0)).toBe(65536);
    expect(geometryChunkCount(large, 'vertices', 65536)).toBe(1);
    expect(() => validateGeometryChunk(large, 'vertices', 0, 65536, new ArrayBuffer(GEOMETRY_CHUNK_BYTES), 0, 0)).not.toThrow();
    for (const [channel, first, count, bytes, vertex, index] of [
      ['colors', 0, 3, new ArrayBuffer(48), 0, 0], ['indices', 0, 3, new ArrayBuffer(12), 0, 0],
      ['vertices', 1, 65536, new ArrayBuffer(GEOMETRY_CHUNK_BYTES), 0, 0],
      ['vertices', 0, 65537, new ArrayBuffer(GEOMETRY_CHUNK_BYTES + 16), 0, 0],
      ['vertices', 65536, 1, new ArrayBuffer(15), 65536, 0],
    ]) expect(() => validateGeometryChunk(large, channel, first, count, bytes, Number(vertex), Number(index))).toThrow();
  });
  it('refuses truncated, zero, unaligned and oversized native heap ranges before copying', () => {
    const heap = new Uint8Array(64); heap.set([1, 2, 3, 4], 16);
    expect(Array.from(new Uint8Array(geometryHeapChunk(heap, 16, 4, 4)))).toEqual([1, 2, 3, 4]);
    for (const [pointer, length, expected] of [[0, 4, 4], [17, 4, 4], [16, 0, 4], [16, 3, 4], [60, 8, 8],
      [Number.MAX_SAFE_INTEGER, 4, 4], [4, GEOMETRY_CHUNK_BYTES + 4, GEOMETRY_CHUNK_BYTES + 4]])
      expect(() => geometryHeapChunk(heap, pointer, length, expected)).toThrow();
  });
});
describe('acknowledged geometry CoreClient family', () => {
  it.each([1, 2] as const)('streams geometry kind %i without Gaussian chunks or masks', async kind => {
    const geometry = descriptor(kind), { core, worker } = await client(geometry), vertices = vi.fn(async () => undefined), indices = vi.fn(async () => undefined);
    const posted = worker.next(), upload = core.streamGeometry(geometry, vertices, indices), request = await posted;
    expect(request).toMatchObject({ type: 'geometry-stream', descriptor: geometry });
    const vertexAck = worker.next(); worker.respond(request, chunk(geometry, 'vertices')); expect(await vertexAck).toMatchObject({ type: 'ack', chunkId: 0 });
    if (kind === 2) { const indexAck = worker.next(); worker.respond(request, chunk(geometry, 'indices')); expect(await indexAck).toMatchObject({ type: 'ack', chunkId: 1 }); }
    worker.respond(request, { type: 'result', summary: summary(geometry) }); await expect(upload).resolves.toMatchObject({ kind });
    expect(vertices).toHaveBeenCalledTimes(1); expect(indices).toHaveBeenCalledTimes(kind === 2 ? 1 : 0);
    expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(kind === 2 ? 2 : 1); expect(worker.terminated).toBe(false);
  });
  it('detaches the requested descriptor and refuses a stale descriptor before posting', async () => {
    const { core, worker } = await client();
    await expect(core.streamGeometry({ ...descriptor(), revision: 1 }, async () => undefined, async () => undefined)).rejects.toThrow(/no longer current/);
    expect(worker.sent.filter(row => row.type === 'geometry-stream')).toHaveLength(0);
    const source = descriptor(), posted = worker.next(), upload = core.streamGeometry(source, async () => undefined, async () => undefined);
    source.vertexCount = 999;
    const request = await posted; expect(request).toMatchObject({ descriptor: { vertexCount: 3 } });
    const rejected = expect(upload).rejects.toThrow('Refused'); worker.respond(request, { type: 'error', error: 'Refused', summary: summary() }); await rejected;
    expect(worker.terminated).toBe(false);
  });
  for (const fault of ['channel', 'family', 'stride', 'range', 'count', 'bytes', 'chunk-id', 'stale-envelope', 'stale-descriptor', 'early-terminal'] as const)
    it(`refuses ${fault} before acknowledging or publishing any geometry`, async () => {
      const { core, worker } = await client(), vertices = vi.fn(async () => undefined), posted = worker.next();
      const upload = core.streamGeometry(descriptor(), vertices, async () => undefined), rejected = expect(upload).rejects.toThrow(), request = await posted;
      const response: Record<string, unknown> = chunk(descriptor(), 'vertices');
      if (fault === 'channel') response.channel = 'colors';
      if (fault === 'family') Object.assign(response, { type: 'chunk' });
      if (fault === 'stride') response.descriptor = { ...descriptor(), vertexStride: 12 };
      if (fault === 'range') response.first = 1;
      if (fault === 'count') response.count = 2;
      if (fault === 'bytes') response.bytes = new ArrayBuffer(47);
      if (fault === 'chunk-id') response.chunkId = 2;
      if (fault === 'stale-envelope') response.base = { ...request.base, contentRevision: request.base.contentRevision + 1 };
      if (fault === 'stale-descriptor') response.descriptor = { ...descriptor(), contentRevision: 1 };
      if (fault === 'early-terminal') Object.assign(response, { type: 'result', summary: summary() });
      worker.respond(request, response); await rejected;
      expect(vertices).not.toHaveBeenCalled(); expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0); expect(worker.terminated).toBe(true);
    });
  it('requires contiguous complete index coverage and rejects a duplicate vertex chunk', async () => {
    const { core, worker } = await client(), posted = worker.next(), upload = core.streamGeometry(descriptor(), async () => undefined, async () => undefined);
    const rejected = expect(upload).rejects.toThrow(), request = await posted, ack = worker.next();
    worker.respond(request, chunk(descriptor(), 'vertices')); await ack;
    worker.respond(request, chunk(descriptor(), 'vertices', 0, 1)); await rejected;
    expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(1); expect(worker.terminated).toBe(true);
  });
  it('refuses terminal success after vertices alone and an altered terminal descriptor', async () => {
    for (const terminal of [summary(), summary({ ...descriptor(), contentRevision: 1 })]) {
      const { core, worker } = await client(), posted = worker.next(), upload = core.streamGeometry(descriptor(), async () => undefined, async () => undefined);
      const rejected = expect(upload).rejects.toThrow(), request = await posted, ack = worker.next();
      worker.respond(request, chunk(descriptor(), 'vertices')); await ack;
      worker.respond(request, { type: 'result', summary: terminal }); await rejected; expect(worker.terminated).toBe(true);
    }
  });
  it('holds cancellation settlement until its callback returns and never acknowledges its retired copy', async () => {
    const { core, worker } = await client(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = vi.fn(() => held), posted = worker.next();
    const upload = core.streamGeometry(descriptor(), entered, async () => undefined); let settled = false;
    void upload.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(upload).rejects.toMatchObject({ name: 'AbortError' }), request = await posted;
    worker.respond(request, chunk(descriptor(), 'vertices')); await tick(); expect(entered).toHaveBeenCalledTimes(1);
    core.cancel(); worker.respond(request, { type: 'error', error: 'Upload cancelled', cancelled: true, summary: summary() });
    await tick(); expect(settled).toBe(false); expect(worker.sent.filter(row => row.type === 'cancel')).toHaveLength(1);
    release(); await rejected; expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0); expect(worker.terminated).toBe(false);
    const next = worker.next(), read = core.command({ command: 'summary' }); worker.respond(await next, { type: 'result', summary: summary() }); await read;
  });
  it.each(['overlap', 'early-result'] as const)('keeps the held copy owned while refusing %s', async fault => {
    const { core, worker } = await client(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), entered = vi.fn(() => held), posted = worker.next();
    const upload = core.streamGeometry(descriptor(), entered, async () => undefined), rejected = expect(upload).rejects.toThrow(); let settled = false;
    void upload.catch(() => { settled = true; }); const request = await posted;
    worker.respond(request, chunk(descriptor(), 'vertices')); await tick();
    worker.respond(request, fault === 'overlap' ? chunk(descriptor(), 'vertices') : { type: 'result', summary: summary() });
    await tick(); expect(settled).toBe(false); expect(entered).toHaveBeenCalledTimes(1);
    release(); await rejected; expect(worker.terminated).toBe(true); expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0);
  });
  it('makes callback upload refusal fatal and emits no acknowledgement', async () => {
    const { core, worker } = await client(), posted = worker.next();
    const upload = core.streamGeometry(descriptor(), async () => { throw new Error('Upload admission refused'); }, async () => undefined);
    const rejected = expect(upload).rejects.toThrow('Upload admission refused'), request = await posted;
    worker.respond(request, chunk(descriptor(), 'vertices')); await rejected;
    expect(worker.terminated).toBe(true); expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0);
  });
  it('joins the held upload copy when its candidate is disposed', async () => {
    const { core, worker } = await client(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), posted = worker.next();
    const upload = core.streamGeometry(descriptor(), () => held, async () => undefined), rejected = expect(upload).rejects.toThrow('The scene was closed.');
    let settled = false; void upload.catch(() => { settled = true; }); const request = await posted;
    worker.respond(request, chunk(descriptor(), 'vertices')); await tick(); core.dispose();
    await tick(); expect(worker.terminated).toBe(true); expect(settled).toBe(false);
    release(); await rejected; expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0);
  });
  it('refuses a revision that expires during its held callback before acknowledging', async () => {
    const { core, worker } = await client(); let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), posted = worker.next();
    const upload = core.streamGeometry(descriptor(), () => held, async () => undefined), rejected = expect(upload).rejects.toThrow(/obsolete/), request = await posted;
    worker.respond(request, chunk(descriptor(), 'vertices')); await tick(); core.revision.contentRevision++;
    release(); await rejected; expect(worker.sent.filter(row => row.type === 'ack')).toHaveLength(0); expect(worker.terminated).toBe(true);
  });
  it('rejects a geometry family sent to an ordinary command', async () => {
    const { core, worker } = await client(), posted = worker.next(), read = core.command({ command: 'summary' });
    const rejected = expect(read).rejects.toThrow(/family/); worker.respond(await posted, chunk(descriptor(), 'vertices')); await rejected; expect(worker.terminated).toBe(true);
  });
});
