import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { emptyCensus } from './fixtures/allocation-census';
import { CoreClient } from '../src/document/coreClient';
import { livePreviewOutcome } from '../src/document/livePreview';
import type { NativeSummary, WorkerRequest } from '../src/document/types';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));

function summary(revision = 4): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: 3, sourceCount: 3, shDegree: 3, format: 'PLY', kind: 0,
    selected: 1, visible: 3, canUndo: true, canRedo: true, revision, contentRevision: 2,
    transaction: true, selectionDraft: true, sceneChanged: false, pending: false, progress: 1, floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [], memoryBytes: 100,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class ObservedWorker {
  static latest: ObservedWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: unknown;
  onmessageerror?: unknown;
  terminated = false;
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
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready',
        mode: value.mode, build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } }));
    } else { const posted = this.posted; this.posted = undefined; posted?.(value); }
  }
  next() { return new Promise<WorkerRequest>(resolve => { this.posted = resolve; }); }
  respond(request: WorkerRequest, result: Record<string, unknown>) { this.onmessage?.({ data: { ...request, ...this.telemetry(result), ...result } }); }
  terminate() { this.terminated = true; }
}
const clients: CoreClient[] = [];
async function client() {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', ObservedWorker);
  const result = new CoreClient(); clients.push(result); await result.ready(); return result;
}
afterEach(() => { for (const value of clients.splice(0)) value.dispose(); vi.unstubAllGlobals(); });

describe('typed live-selection response boundary', () => {
  it('keeps computation failure distinct from a published native summary', () => {
    expect(livePreviewOutcome({ kind: 'computation-failed', version: 1 })).toEqual({ kind: 'computation-failed', version: 1 });
    const value = summary(); expect(livePreviewOutcome({ kind: 'published', version: 1, summary: value })).toEqual({ kind: 'published', version: 1, summary: value });
  });
  for (const invalid of [false, null, {}, { kind: 'computation-failed', version: 2 },
    { kind: 'computation-failed', version: 1, summary: summary() }, { kind: 'computation-failed', version: 1, error: 'bad_alloc' },
    { kind: 'published', version: 1 }, { kind: 'published', version: 1, summary: { ...summary(), transaction: false } },
    { kind: 'published', version: 1, summary: { ...summary(), selectionDraft: false } },
    { kind: 'published', version: 1, summary: { ...summary(), pending: true } }])
    it(`refuses ambiguous or incompatible outcome ${JSON.stringify(invalid)}`, () => {
      expect(() => livePreviewOutcome(invalid)).toThrow();
    });
  it('dispatches the dedicated family and leaves revisions unchanged after computation failure', async () => {
    const core = await client(), worker = ObservedWorker.latest, before = { ...core.revision };
    const posted = worker.next(), result = core.livePreview({ command: 'polygon', fromBaseline: true });
    const request = await posted; expect(request.type).toBe('live-preview');
    worker.respond(request, { type: 'live-preview', outcome: { kind: 'computation-failed', version: 1 } });
    await expect(result).resolves.toEqual({ kind: 'computation-failed', version: 1 });
    expect(core.revision).toEqual(before); expect(core.nativeContentRevision).toBe(-1); expect(worker.terminated).toBe(false);
    // A failed preview must settle its ordinary queue so acknowledged rollback
    // can reach the live authority; no replay or worker replacement is needed.
    const rollbackPost = worker.next(), rollback = core.command({ command: 'rollbackTransaction' });
    const rollbackRequest = await rollbackPost;
    worker.respond(rollbackRequest, { type: 'result', summary: { ...summary(), transaction: false } });
    await expect(rollback).resolves.toMatchObject({ transaction: false });
  });
  it('accepts published revisions and ignores a duplicate completed response', async () => {
    const core = await client(), worker = ObservedWorker.latest, posted = worker.next();
    const result = core.livePreview({ command: 'rectangle', fromBaseline: true }), request = await posted;
    worker.respond(request, { type: 'live-preview', outcome: { kind: 'published', version: 1, summary: summary() } });
    await expect(result).resolves.toMatchObject({ kind: 'published', summary: { revision: 4 } });
    const after = { ...core.revision };
    worker.respond(request, { type: 'live-preview', outcome: { kind: 'published', version: 1, summary: summary(9) } });
    expect(core.revision).toEqual(after); expect(core.nativeContentRevision).toBe(2);
  });
  for (const fault of ['wrong-family', 'wrong-operation', 'stale-revision', 'malformed'] as const)
    it(`refuses ${fault} without interpreting it as deferred computation`, async () => {
      const core = await client(), worker = ObservedWorker.latest, posted = worker.next();
      const result = fault === 'wrong-operation' ? core.command({ command: 'summary' }) : core.livePreview({ command: 'polygon', fromBaseline: true });
      const rejected = expect(result).rejects.toThrow(), request = await posted;
      const response: Record<string, unknown> = { type: 'live-preview', outcome: { kind: 'computation-failed', version: 1 } };
      if (fault === 'wrong-family') Object.assign(response, { type: 'result', summary: summary() });
      if (fault === 'stale-revision') response.base = { ...request.base, selectionRevision: request.base.selectionRevision + 1 };
      if (fault === 'malformed') response.outcome = { kind: 'computation-failed', version: 1, summary: summary() };
      worker.respond(request, response); await rejected; expect(worker.terminated).toBe(true);
    });
  it('keeps an ordinary native error fatal without synthesizing a computation outcome', async () => {
    const core = await client(), worker = ObservedWorker.latest, posted = worker.next();
    const result = core.livePreview({ command: 'polygon', fromBaseline: true }), rejected = expect(result).rejects.toThrow('Native admission refused');
    worker.respond(await posted, { type: 'error', error: 'Native admission refused', summary: summary() });
    await rejected; expect(worker.terminated).toBe(false);
  });
});
