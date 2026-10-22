import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { BUILD_ID, PROTOCOL_VERSION, type NativeSummary, type WorkerRequest, type WorkerResponse } from '../src/document/types';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import type { WasmModule } from '../src/workers/wasm';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupBlockBytes, groupDescriptorBytes, groupTransferBytes, groupWorkerBytes } from '../src/document/sourceGroup';
import type { SourceRange } from '../src/document/source';
import { emptyCensus } from './fixtures/allocation-census';
import { GroupHashModule, groupFixture, groupShFixture, independentGroupKey } from './fixtures/group-source';

const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule }));
vi.mock('../src/workers/wasm', async importOriginal => ({ ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core }));
type Response = WorkerResponse | WorkerBootstrapResponse;
type Load = Extract<WorkerRequest, { type: 'source-group-load' }>;
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1,
  base: { documentId: 'group-worker', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function loadedSummary(): NativeSummary { return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, format: 'SOG v1', count: 3, sourceCount: 3,
  shDegree: 0, selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
  transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1, center: [0, 0, 0], radius: 1,
  yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 432, floor: null, filter: null, transformSession: null, opacitySession: null,
  selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] }; }
/** Native decoder call double: captures borrowed layout, never invents decoded
 * geometry or numerical acceptance. Hashes use Node's independent SHA256. */
class Module extends GroupHashModule {
  format = 'SOG v1';
  degree = 0;
  opens: { block: Buffer; descriptor: Buffer; max: number; budget: number; work: number }[] = [];
  private loaded = false; private census = 0;
  _sv_abi_version() { return BUILD_DESCRIPTOR.native.core.abi; }
  _sv_build_identity() { return 1; }
  _sv_command() { return 2; }
  _sv_allocation_snapshot() { this.census++; return 3; }
  UTF8ToString(pointer: number) {
    if (pointer === 1) return JSON.stringify(BUILD_DESCRIPTOR.native.core);
    if (pointer === 3) return JSON.stringify(emptyCensus(this.census));
    return JSON.stringify(this.loaded ? { ...loadedSummary(), format: this.format, shDegree: this.degree } : { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: false, kind: 0, count: 0, sourceCount: 0, memoryBytes: 0, floor: null, filter: null, transformSession: null, opacitySession: null,
      selectionMapId: null, selectionMapBytes: 0, pendingSelectionMapId: null, selectionMapRetainedIds: [] });
  }
  _sv_open_group(pointer: number, length: number, descriptor: number, descriptorBytes: number, max: number, budget: number, work: number) {
    this.opens.push({ block: Buffer.from(this.HEAPU8.slice(pointer, pointer + length)),
      descriptor: Buffer.from(this.HEAPU8.slice(descriptor, descriptor + descriptorBytes)), max, budget, work });
    this.loaded = true; return 2;
  }
}
class Context {
  location = { origin: 'https://example.test' }; onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = []; private unread: Response[] = [];
  private waiters: { type: Response['type']; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []) {
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    const index = this.waiters.findIndex(waiter => waiter.type === copy.type);
    if (index < 0) this.unread.push(copy); else this.waiters.splice(index, 1)[0].resolve(copy);
  }
  next<T extends Response['type']>(type: T): Promise<Extract<Response, { type: T }>> {
    const index = this.unread.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(this.unread.splice(index, 1)[0] as Extract<Response, { type: T }>);
    return new Promise(resolve => this.waiters.push({ type, resolve: value => resolve(value as Extract<Response, { type: T }>) }));
  }
  send(value: unknown, transfer: Transferable[] = []) { this.onmessage?.({ data: structuredClone(value, { transfer }) }); }
}
let context: Context, module: Module;
beforeEach(async () => {
  vi.resetModules(); context = new Context(); module = new Module(); runtime.core = module as unknown as WasmModule;
  vi.stubGlobal('self', context); await import('../src/workers/document.worker');
});
afterEach(() => { vi.unstubAllGlobals(); });
async function initialize() {
  context.send({ type: 'initialize', initializationId: 'group-worker-module', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' });
  expect((await context.next('ready')).core).toEqual(BUILD_DESCRIPTOR.native.core);
}
function request(source: Awaited<ReturnType<typeof groupFixture>>, requestId = 1): Load {
  return { ...envelope, requestId, type: 'source-group-load', source: source.group.descriptor,
    maxSplats: 100, budgetBytes: GROUP_NATIVE_BUDGET_BYTES, nativeWorkBytes: GROUP_NATIVE_WORK_BYTES, sourceBudgetBytes: groupWorkerBytes(source.group.descriptor) };
}
function deliver(load: Load, range: SourceRange, source: Awaited<ReturnType<typeof groupFixture>>, changes: Record<string, unknown> = {}) {
  const bytes = source.bytes.get(range.resourceId)!.slice(range.offset, range.offset + range.length).buffer;
  const fields = { operationId: range.operationId, resourceId: range.resourceId, rangeId: range.rangeId, offset: range.offset, length: range.length };
  context.send({ ...envelope, requestId: load.requestId, type: 'source-range', ...fields, bytes, ...changes }, [bytes]); expect(bytes.byteLength).toBe(0);
}
async function deliverAll(load: Load, source: Awaited<ReturnType<typeof groupFixture>>, first?: SourceRange) {
  let rangeId = 0;
  for (const resource of [...load.source.resources, load.source.decoder]) for (let offset = 0; offset < resource.byteLength;) {
    const range = first ?? await context.next('source-range-request'); first = undefined;
    expect(range).toMatchObject({ resourceId: resource.resourceId, offset, rangeId: rangeId++, length: Math.min(1024 * 1024, resource.byteLength - offset) });
    deliver(load, range, source); const consumed = await context.next('source-range-consumed');
    expect(consumed).toMatchObject({ rangeId: range.rangeId, resourceId: range.resourceId, offset, length: range.length }); offset += range.length;
  }
}
async function finish(load: Load, source: Awaited<ReturnType<typeof groupFixture>>, first?: SourceRange) {
  await deliverAll(load, source, first); return context.next('source-load-result');
}
function clean() { expect(module.allocations.size).toBe(1); expect(module.opens).toHaveLength(0); }
describe('grouped source worker transfer boundary', () => {
  it.each([[1, 1], [1, 2], [1, 3], [2, 1], [2, 2], [2, 3]] as const)('publishes a v%i SH%i transport only when the native-boundary summary agrees with authenticated metadata', async (version, degree) => {
    await initialize(); const source = await groupShFixture(version, degree), load = request(source);
    module.format = `SOG v${version}`; module.degree = degree; context.send(load);
    try {
      const terminal = await finish(load, source);
      expect(terminal.summary).toMatchObject({ format: `SOG v${version}`, shDegree: degree, sourceCount: 3 });
      expect(terminal.fingerprint.assetDigest).toBe(independentGroupKey(load.source, source.bytes));
      expect(terminal.fingerprint.totalBytes).toBe(load.source.byteLength); expect(module.opens).toHaveLength(1);
      await tick(); expect(module.allocations.size).toBe(1);
    } finally { source.dispose(); }
  });

  it.each([[2, 3, 2], [2, 1, 0], [1, 2, 0]] as const)('refuses v%i SH%i native degree %i before publishing the loaded source', async (version, degree, returnedDegree) => {
    await initialize(); const source = await groupShFixture(version, degree), load = request(source);
    module.format = `SOG v${version}`; module.degree = returnedDegree; context.send(load);
    try {
      await deliverAll(load, source); const error = await context.next('error');
      expect(error.error).toMatch(/fingerprint/); expect(error.cleanupFailed).toBe(false); expect(module.opens).toHaveLength(1);
      expect(context.sent.filter(value => value.type === 'source-load-result')).toHaveLength(0);
      await tick(); expect(module.allocations.size).toBe(1);
    } finally { source.dispose(); }
  });

  it('refuses an unexpected nonzero native degree for an authenticated SH0 group before publication', async () => {
    await initialize(); const source = await groupFixture(undefined, 2), load = request(source); module.format = 'SOG v2'; module.degree = 3; context.send(load);
    try {
      await deliverAll(load, source); expect((await context.next('error')).error).toMatch(/fingerprint/);
      expect(context.sent.filter(value => value.type === 'source-load-result')).toHaveLength(0); expect(module.opens).toHaveLength(1);
      await tick(); expect(module.allocations.size).toBe(1);
    } finally { source.dispose(); }
  });
  it('revalidates v2 originals and transports a literal independent key before the real native-call boundary double', async () => {
    await initialize(); const source = await groupFixture(undefined, 2), load = request(source); module.format = 'SOG v2'; context.send(load);
    try {
      const terminal = await finish(load, source);
      expect(terminal.summary).toMatchObject({ loaded: true, format: 'SOG v2', count: 3, sourceCount: 3, shDegree: 0 });
      expect(terminal.consumedBytes).toBe(groupTransferBytes(load.source));
      expect(terminal.fingerprint.assetDigest).toBe(independentGroupKey(load.source, source.bytes));
      expect(terminal.fingerprint).toMatchObject({ sourceKindHint: 'SOG v2', resourceCount: 6, totalBytes: load.source.byteLength });
      expect(module.opens).toHaveLength(1); expect(module.opens[0].block)
        .toEqual(Buffer.concat([...load.source.resources, load.source.decoder].map(resource => Buffer.from(source.bytes.get(resource.resourceId)!))));
      await tick(); expect(module.allocations.size).toBe(1);
    } finally { source.dispose(); }
  });

  it('refuses a valid altered v2 decoder count before any native decode or source publication', async () => {
    await initialize(); const source = await groupFixture(undefined, 2), load = request(source);
    const bytes = source.bytes.get(load.source.decoder.resourceId)!;
    const changed = new TextEncoder().encode(new TextDecoder().decode(bytes).replace(/"count":\s*3/, value => value.slice(0, -1) + '2'));
    expect(changed.byteLength).toBe(bytes.byteLength); expect(changed).not.toEqual(bytes); source.bytes.set(load.source.decoder.resourceId, changed); context.send(load);
    try {
      for (const resource of [...load.source.resources, load.source.decoder]) {
        const range = await context.next('source-range-request'); expect(range.resourceId).toBe(resource.resourceId);
        deliver(load, range, source); await context.next('source-range-consumed');
      }
      const error = await context.next('error'); expect(error.error).toMatch(/decoder metadata differs/); expect(error.cleanupFailed).toBe(false);
      expect(context.sent.filter(value => value.type === 'source-load-result')).toHaveLength(0); await tick(); clean();
    } finally { source.dispose(); }
  });
  it('loads only after original revalidation, uses the exact seven-argument native borrow, and publishes the original-only fingerprint', async () => {
    await initialize(); const source = await groupFixture(), load = request(source); context.send(load);
    try {
      const first = await context.next('source-range-request');
      expect(module.mallocSizes.slice(1, 3)).toEqual([groupBlockBytes(load.source), groupDescriptorBytes(load.source)]);
      const terminal = await finish(load, source, first);
      expect(terminal.consumedBytes).toBe(groupTransferBytes(load.source)); expect(terminal.fingerprint.totalBytes).toBe(701);
      expect(terminal.fingerprint.assetDigest).toBe(independentGroupKey(load.source, source.bytes)); expect(terminal.summary.floor).toBeNull();
      expect(module.opens).toHaveLength(1); const open = module.opens[0];
      expect(open.block).toEqual(Buffer.concat([...load.source.resources, load.source.decoder].map(resource => Buffer.from(source.bytes.get(resource.resourceId)!))));
      expect([open.descriptor.readUInt32LE(0), open.descriptor.readUInt32LE(4), open.descriptor.readUInt32LE(8)]).toEqual([0x47535653, 1, 5]);
      expect([open.max, open.budget, open.work]).toEqual([100, GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES]);
      await tick(); expect(module.allocations.size).toBe(1);
    } finally { source.dispose(); }
  });
  it('reconstructs the rewrite from staged originals and rejects altered decoder bytes before native open', async () => {
    await initialize(); const source = await groupFixture(), load = request(source); source.bytes.get(load.source.decoder.resourceId)![0] ^= 1;
    context.send(load);
    try {
      let rangeId = 0;
      for (const resource of [...load.source.resources, load.source.decoder]) {
        const range = await context.next('source-range-request'); expect(range.rangeId).toBe(rangeId++); expect(range.resourceId).toBe(resource.resourceId);
        deliver(load, range, source); await context.next('source-range-consumed');
      }
      expect((await context.next('error')).error).toMatch(/decoder metadata differs/); await tick(); clean();
    } finally { source.dispose(); }
  });
  it.each(['foreign-id', 'foreign-base', 'old-cancel'] as const)('refuses %s control without aborting the active grouped source', async kind => {
    await initialize(); const source = await groupFixture(), load = request(source, 2); context.send(load);
    try {
      const first = await context.next('source-range-request');
      context.send({ ...envelope, requestId: kind === 'foreign-base' ? 2 : 1, type: kind === 'old-cancel' ? 'cancel' : 'ack', chunkId: 0,
        base: kind === 'foreign-base' ? { ...envelope.base, sourceGeneration: 2 } : envelope.base });
      expect((await context.next('error')).error).toBe('Discarded an obsolete scene message.');
      expect(module.opens).toHaveLength(0); expect(module.allocations.size).toBeGreaterThan(1);
      const terminal = await finish(load, source, first); expect(terminal.summary.loaded).toBe(true);
    } finally { source.dispose(); }
  });
  it.each(['wrong-resource', 'wrong-family', 'duplicate-load'] as const)('retires a same-owner %s violation and joins input cleanup', async kind => {
    await initialize(); const source = await groupFixture(), load = request(source); context.send(load);
    try {
      const first = await context.next('source-range-request');
      if (kind === 'wrong-resource') deliver(load, first, source, { resourceId: load.source.decoder.resourceId });
      else context.send(kind === 'duplicate-load' ? load : { ...envelope, type: 'ack', chunkId: 0 });
      const error = await context.next('error'); expect(error.error).toMatch(/source|range|family/); expect(error.cleanupFailed).toBe(false);
      await tick(); clean();
    } finally { source.dispose(); }
  });
  it('cancels a held middle-resource credit without decoding or publishing the source', async () => {
    await initialize(); const source = await groupFixture(), load = request(source); context.send(load);
    try {
      const primary = await context.next('source-range-request'); deliver(load, primary, source); await context.next('source-range-consumed');
      const middle = await context.next('source-range-request'); expect(middle.resourceId).toBe(load.source.resources[1].resourceId);
      context.send({ ...envelope, type: 'cancel' });
      const error = await context.next('error'); expect(error.cancelled).toBe(true); expect(error.cleanupFailed).toBe(false); await tick(); clean();
      expect(context.sent.filter(value => value.type === 'source-load-result')).toHaveLength(0);
    } finally { source.dispose(); }
  });
  it('refuses grouped messages before initialization and duplicate initialization without changing a live source credit', async () => {
    const source = await groupFixture(), load = request(source); context.send(load);
    try {
      const error = await context.next('error'); expect(error.heap).toBeNull(); expect(error.error).toMatch(/Initialize/); expect(module.allocations.size).toBe(0);
      await initialize(); context.send(load); const first = await context.next('source-range-request');
      context.send({ type: 'initialize', initializationId: 'duplicate', build: BUILD_DESCRIPTOR,
        mode: 'development-module-graph', assetBase: 'https://example.test/' });
      expect((await context.next('initialization-failed')).error).toMatch(/already initialized/);
      expect((await finish(load, source, first)).summary.loaded).toBe(true);
    } finally { source.dispose(); }
  });
});
