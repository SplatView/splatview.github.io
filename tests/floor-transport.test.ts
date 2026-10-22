import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { CoreClient } from '../src/document/coreClient';
import type { NativeSummary, WorkerRequest } from '../src/document/types';
import { emptyCensus } from './fixtures/allocation-census';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));

type Command = Extract<WorkerRequest, { type: 'command' }>;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function summary(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, kind: 0, format: 'PLY', count: 3, sourceCount: 3, shDegree: 0,
    selected: 0, visible: 3, canUndo: false, canRedo: false, revision: 0, contentRevision: 0,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    center: [0, 0, 0], radius: 1, yUp: false, camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null };
}

// A controlled transport double, not actual native Floor computation or storage.
// Terminals are held explicitly; normal cancellation never replaces this worker.
class FakeWorker {
  static latest: FakeWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  onPost?: (value: WorkerRequest) => void;
  sent: WorkerRequest[] = [];
  terminateCalls = 0;
  failNextPost = false;
  private initializationId = '';
  private heapSequence = 0;
  private unread: WorkerRequest[] = [];
  private waiters: { type: WorkerRequest['type']; resolve(value: WorkerRequest): void }[] = [];
  private allocation = { loaded: false, kind: 0, count: 0, memoryBytes: 0,
    selectionMapBytes: 0, selectionMapRetainedIds: [] as number[] };
  constructor() { FakeWorker.latest = this; }
  private telemetry(result: Record<string, unknown> = {}) {
    if (result.summary) {
      const value = result.summary as NativeSummary;
      this.allocation = { loaded: value.loaded, kind: value.kind, count: value.count, memoryBytes: value.memoryBytes,
        selectionMapBytes: value.selectionMapBytes, selectionMapRetainedIds: [...value.selectionMapRetainedIds] };
    }
    return { initializationId: this.initializationId,
      heap: { sequence: ++this.heapSequence, heapBytes: 128 * 1024 * 1024 },
      census: emptyCensus(this.heapSequence), allocation: { ...this.allocation } };
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', mode: value.mode,
        build: BUILD_DESCRIPTOR, core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } }));
      return;
    }
    if (this.failNextPost) { this.failNextPost = false; throw new Error('Dispatch transfer refused.'); }
    const copy = structuredClone(value);
    this.sent.push(copy);
    const index = this.waiters.findIndex(waiter => waiter.type === copy.type);
    if (index < 0) this.unread.push(copy);
    else this.waiters.splice(index, 1)[0].resolve(copy);
    this.onPost?.(copy);
  }
  next<T extends WorkerRequest['type']>(type: T): Promise<Extract<WorkerRequest, { type: T }>> {
    const index = this.unread.findIndex(value => value.type === type);
    if (index >= 0) return Promise.resolve(this.unread.splice(index, 1)[0] as Extract<WorkerRequest, { type: T }>);
    return new Promise(resolve => this.waiters.push({ type, resolve: value => resolve(value as Extract<WorkerRequest, { type: T }>) }));
  }
  respond(request: WorkerRequest, result: Record<string, unknown>) {
    this.onmessage?.({ data: structuredClone({ ...request, ...this.telemetry(result), ...result }) });
  }
  terminate() { this.terminateCalls++; }
}

const clients: CoreClient[] = [];
async function client() {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', FakeWorker);
  const core = new CoreClient(); clients.push(core); await core.ready(); return { core, worker: FakeWorker.latest };
}
function trackedSignal() {
  const controller = new AbortController();
  return { controller, signal: controller.signal,
    add: vi.spyOn(controller.signal, 'addEventListener'), remove: vi.spyOn(controller.signal, 'removeEventListener') };
}
function expectReleased(tracked: ReturnType<typeof trackedSignal>) {
  const registered = tracked.add.mock.calls.filter(([type]) => type === 'abort');
  expect(registered).toHaveLength(1);
  expect(tracked.remove.mock.calls.some(([type, listener]) => type === 'abort' && listener === registered[0][1])).toBe(true);
}
async function nextSuccessfulCommand(core: CoreClient, worker: FakeWorker) {
  const result = core.command({ command: 'summary' }), request = await worker.next('command');
  worker.respond(request, { type: 'result', summary: summary() }); await result; return request;
}
afterEach(() => { for (const core of clients.splice(0)) core.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Floor command cancellation transport ownership', () => {
  it('accepts the compact unloaded native DTO without pending and keeps the worker for a later loaded summary', async () => {
    const { core, worker } = await client();
    const unloaded = { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, duplicateRange: null, loaded: false, kind: 0, count: 0, sourceCount: 0, memoryBytes: 0,
      toleranceSessionId: null, toleranceTool: null, toleranceConnected: null, toleranceMapId: null,
      selectionMapId: null, selectionMapBytes: 0, pendingSelectionMapId: null, selectionMapRetainedIds: [], floor: null, filter: null, transformSession: null, opacitySession: null };
    const result = core.command({ command: 'summary' }), request = await worker.next('command');
    worker.respond(request, { type: 'result', summary: unloaded });
    await expect(result).resolves.toMatchObject({ loaded: false, count: 0, pending: false, floor: null });
    expect(unloaded).not.toHaveProperty('pending'); expect(worker.terminateCalls).toBe(0);
    await nextSuccessfulCommand(core, worker); expect(worker.terminateCalls).toBe(0);
  });

  it('refuses a pre-aborted command before dispatch or listener registration', async () => {
    const { core, worker } = await client(), tracked = trackedSignal(); tracked.controller.abort();
    await expect(core.command({ command: 'detectFloor' }, tracked.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.sent).toHaveLength(0); expect(tracked.add).not.toHaveBeenCalled(); expect(worker.terminateCalls).toBe(0);
    await nextSuccessfulCommand(core, worker); expect(worker.terminateCalls).toBe(0);
  });

  it('never dispatches a queued command whose signal aborts behind an active request', async () => {
    const { core, worker } = await client();
    const active = core.command({ command: 'detectFloor' }), first = await worker.next('command');
    const tracked = trackedSignal(), queued = core.command({ command: 'detectFloor' }, tracked.signal);
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    tracked.controller.abort(); await tick();
    expect(worker.sent).toHaveLength(1); expect(tracked.add).not.toHaveBeenCalled();
    worker.respond(first, { type: 'result', summary: summary() }); await active; await rejected;
    const next = await nextSuccessfulCommand(core, worker);
    expect(next.requestId).toBe(first.requestId + 1);
    expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0); expect(worker.terminateCalls).toBe(0);
  });

  it('cancels the exact active request/base and joins its native terminal before admitting the next job', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request = await worker.next('command');
    let settled = false; const joined = result.then(() => { settled = true; }, error => { settled = true; return error; });
    core.revision.contentRevision++; core.revision.selectionRevision++; core.revision.draftRevision++;
    tracked.controller.abort(); const cancel = await worker.next('cancel');
    expect(cancel.requestId).toBe(request.requestId); expect(cancel.base).toEqual(request.base); expect(cancel.base).not.toEqual(core.revision);
    const following = core.command({ command: 'summary' }); await tick();
    expect(settled).toBe(false); expect(worker.sent.filter(value => value.type === 'command')).toHaveLength(1);
    worker.respond(request, { type: 'error', cancelled: true, error: 'Floor cancelled.', summary: summary() });
    expect(await joined).toMatchObject({ name: 'AbortError' }); expectReleased(tracked);
    const next = await worker.next('command'); expect(next.requestId).toBeGreaterThan(request.requestId);
    worker.respond(next, { type: 'result', summary: summary() }); await following;
    expect(worker.terminateCalls).toBe(0);
  });

  it.each(['no-signal', 'unaborted-signal', 'uncancelled-error'] as const)
    ('keeps %s native errors distinct from an owned signal cancellation', async mode => {
      const { core, worker } = await client(), tracked = trackedSignal();
      const result = core.command({ command: 'detectFloor' }, mode === 'no-signal' ? undefined : tracked.signal);
      const rejected = expect(result).rejects.toMatchObject({ name: 'Error', message: 'Native refusal.' });
      const request = await worker.next('command');
      if (mode === 'uncancelled-error') tracked.controller.abort(); else core.cancel();
      const cancel = await worker.next('cancel'); expect(cancel.requestId).toBe(request.requestId); expect(cancel.base).toEqual(request.base);
      worker.respond(request, { type: 'error', cancelled: mode !== 'uncancelled-error', error: 'Native refusal.', summary: summary() });
      await rejected; if (mode !== 'no-signal') expectReleased(tracked);
      expect(worker.terminateCalls).toBe(0); await nextSuccessfulCommand(core, worker);
    });

  it('delivers a signal that aborts reentrantly inside command postMessage to that same request', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    worker.onPost = value => { if (value.type === 'command') tracked.controller.abort(); };
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request = await worker.next('command');
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    const cancel = await worker.next('cancel');
    expect(cancel.requestId).toBe(request.requestId); expect(cancel.base).toEqual(request.base);
    expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(1);
    worker.respond(request, { type: 'error', cancelled: true, error: 'Floor cancelled.', summary: summary() }); await rejected;
    expectReleased(tracked); expect(worker.terminateCalls).toBe(0);
  });

  it('does not send a cancellation after reentrant terminal publication and abort during posting', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    worker.onPost = value => {
      if (value.type === 'command') { worker.respond(value, { type: 'result', summary: summary() }); tracked.controller.abort(); }
    };
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request = await worker.next('command');
    expect(request.command.command).toBe('detectFloor');
    await expect(result).resolves.toMatchObject({ floor: null });
    expectReleased(tracked); expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    worker.onPost = undefined; await nextSuccessfulCommand(core, worker); expect(worker.terminateCalls).toBe(0);
  });

  it('releases a successful request listener and keeps its late abort away from the next active job', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request = await worker.next('command');
    worker.respond(request, { type: 'result', summary: summary() }); await result; expectReleased(tracked);
    const following = core.command({ command: 'detectFloor' }), next = await worker.next('command');
    tracked.controller.abort(); await tick(); expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    worker.respond(next, { type: 'result', summary: summary() }); await following; expect(worker.terminateCalls).toBe(0);
  });

  it('releases a native-error request listener without letting its late abort affect later work', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request = await worker.next('command');
    const rejected = expect(result).rejects.toThrow('Native refusal.');
    worker.respond(request, { type: 'error', error: 'Native refusal.', cancelled: false, summary: summary() }); await rejected; expectReleased(tracked);
    const following = core.command({ command: 'detectFloor' }), next = await worker.next('command');
    tracked.controller.abort(); await tick(); expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    worker.respond(next, { type: 'result', summary: summary() }); await following; expect(worker.terminateCalls).toBe(0);
  });

  it('releases a listener when command dispatch throws and preserves the worker for a subsequent command', async () => {
    const { core, worker } = await client(), tracked = trackedSignal(); worker.failNextPost = true;
    await expect(core.command({ command: 'detectFloor' }, tracked.signal)).rejects.toThrow('Dispatch transfer refused.');
    expectReleased(tracked); tracked.controller.abort(); expect(worker.sent).toHaveLength(0);
    await nextSuccessfulCommand(core, worker); expect(worker.terminateCalls).toBe(0);
  });

  it('releases a listener after an actual worker fault rather than sending a late cancellation to a retired worker', async () => {
    const { core, worker } = await client(), tracked = trackedSignal();
    const result = core.command({ command: 'detectFloor' }, tracked.signal); await worker.next('command');
    const rejected = expect(result).rejects.toThrow('Worker failed.');
    worker.onerror?.({ preventDefault() {}, message: 'Worker failed.' }); await rejected;
    expectReleased(tracked); tracked.controller.abort(); expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    expect(worker.terminateCalls).toBe(1);
  });

  it.each(['missing-floor', 'loaded-missing-pending', 'unloaded-owner'] as const)('retires %s terminal metadata and cleans the signal listener', async kind => {
    const { core, worker } = await client(), tracked = trackedSignal();
    const result = core.command({ command: 'detectFloor' }, tracked.signal), request: Command = await worker.next('command');
    const rejected = expect(result).rejects.toThrow(kind === 'loaded-missing-pending' ? 'Invalid native selection filter metadata.' : /floor/);
    const invalid = { ...summary() } as Record<string, unknown>;
    if (kind === 'missing-floor') delete invalid.floor;
    else if (kind === 'loaded-missing-pending') delete invalid.pending;
    else {
      invalid.loaded = false; invalid.count = invalid.sourceCount = invalid.visible = invalid.memoryBytes = 0;
      invalid.floor = { version: 1, id: 1, status: 'none', stage: 'complete', selectedOnly: false, plane: null };
    }
    worker.respond(request, { type: 'result', summary: invalid }); await rejected;
    expectReleased(tracked); tracked.controller.abort(); expect(worker.sent.filter(value => value.type === 'cancel')).toHaveLength(0);
    expect(worker.terminateCalls).toBe(1);
  });
});
