import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoreClient } from '../src/document/coreClient';
import { transformDefaults, transformWireParameters, type TransformSessionSummary } from '../src/document/transformProtocol';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { type NativeSummary, type WorkerRequest } from '../src/document/types';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { emptyCensus } from './fixtures/allocation-census';

vi.mock('../src/build/runtime', () => ({
  ensureRuntime: async () => ({ mode: 'production-verified', assetBase: 'https://example.test/',
    artifacts: new Map([['document-worker', { bytes: new ArrayBuffer(1) }]]) }),
  runtimeNativeSource: () => undefined,
}));
function scene(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: 5, sourceCount: 8, shDegree: 0, format: 'PLY', kind: 0,
    selected: 2, visible: 4, canUndo: true, canRedo: false, revision: 7, contentRevision: 3,
    transaction: false, selectionDraft: false, sceneChanged: true, pending: false, progress: 1,
    floor: null, filter: null, transformSession: null, opacitySession: null,
    center: [3, 4, 5], radius: 10, yUp: false, camera: [], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
class FocusWorker {
  static latest: FocusWorker;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault(): void; message: string }) => void;
  onmessageerror?: () => void;
  sent: WorkerRequest[] = [];
  model = scene();
  terminated = false;
  private initializationId = '';
  private sequence = 0;
  constructor() { FocusWorker.latest = this; }
  private telemetry() {
    const sequence = ++this.sequence;
    return { initializationId: this.initializationId, heap: { sequence, heapBytes: 128 * 65536 }, census: emptyCensus(sequence),
      allocation: { loaded: this.model.loaded, kind: this.model.kind, count: this.model.count,
        memoryBytes: this.model.memoryBytes, selectionMapBytes: this.model.selectionMapBytes,
        selectionMapRetainedIds: [...this.model.selectionMapRetainedIds] } };
  }
  postMessage(value: WorkerRequest | { type: 'initialize'; initializationId: string; mode: string }) {
    if (value.type === 'initialize') {
      this.initializationId = value.initializationId;
      queueMicrotask(() => this.onmessage?.({ data: { type: 'ready', mode: value.mode, build: BUILD_DESCRIPTOR,
        core: BUILD_DESCRIPTOR.native.core, ...this.telemetry(), allocation: null } })); return;
    }
    const request = structuredClone(value); this.sent.push(request);
    if (request.type === 'command' && request.command.command === 'summary') this.emit(request, { type: 'result', summary: this.model });
  }
  emit(request: WorkerRequest, payload: Record<string, unknown>) {
    const data = structuredClone({ ...request, ...payload, ...this.telemetry() });
    queueMicrotask(() => this.onmessage?.({ data }));
  }
  focus() {
    const request = this.sent.find(value => value.type === 'command' && value.command.command === 'transformFocus');
    if (!request) throw new Error('No focus request was posted.'); return request;
  }
  terminate() { this.terminated = true; }
}
const clients: CoreClient[] = [];
async function flush() { for (let index = 0; index < 30; index++) await Promise.resolve(); }
async function client(patch: Partial<NativeSummary> = {}) {
  vi.stubGlobal('document', { baseURI: 'https://example.test/' }); vi.stubGlobal('Worker', FocusWorker);
  const core = new CoreClient(); clients.push(core); await core.ready();
  const worker = FocusWorker.latest; Object.assign(worker.model, patch);
  await core.command({ command: 'summary' }); return { core, worker };
}
afterEach(async () => { await Promise.all(clients.splice(0).map(core => core.dispose())); vi.unstubAllGlobals(); });

describe('bound readonly transform focus transport', () => {
  it('posts exact native revisions without an edit owner, then returns a copied point without changing client revisions', async () => {
    const { core, worker } = await client(), before = { ...core.revision };
    const result = core.transformFocus('scene', null); await flush();
    const request = worker.focus(); expect(request).not.toHaveProperty('operationOwner');
    if (request.type !== 'command') throw new Error('Wrong request family');
    expect(request.command).toEqual({ command: 'transformFocus', scope: 'scene', revision: 7, contentRevision: 3, transformBase: null });
    worker.model.memoryBytes = 2048;
    worker.emit(request, { type: 'result', summary: { ...worker.model, sceneChanged: false, point: [8, 9, 10] } });
    const point = await result; expect(point).toEqual([8, 9, 10]); expect(Object.isFrozen(point)).toBe(true);
    expect(core.revision).toEqual(before); expect(core.operationOwner).toBeUndefined(); expect(worker.terminated).toBe(false);
    expect(worker.sent.filter(value => value.type === 'operation')).toHaveLength(0);
  });
  it('distinguishes an explicitly empty selection from a missing terminal result', async () => {
    const { core, worker } = await client({ selected: 0 });
    const result = core.transformFocus('selection', null); await flush();
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: null } });
    await expect(result).resolves.toBeNull();
  });
  it.each(['tolerance', 'color', 'opacity'] as const)('queries through a settled retained %s owner without replacing its state', async owner => {
    const patch: Partial<NativeSummary> = owner === 'tolerance' ? { toleranceSessionId: 7, toleranceMapId: 8,
      toleranceTool: 'color', toleranceConnected: false, toleranceRecorded: true, toleranceRange: { enabled: false, radius: null, center: [1, 2, 3] } } : owner === 'color' ? { colorSession: { version: 1, active: true,
      sessionId: 3, baseId: 4, epochId: 5, pending: false, selectedOnly: true, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] } } :
      { opacitySession: { id: 3, baseId: 4, epoch: 0, appliedEpoch: null, selectedOnly: true, appliedScale: 1 } };
    const { core, worker } = await client(patch), before = { ...core.revision }, result = core.transformFocus('selection', null);
    await flush(); worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [8, 9, 10] } });
    await expect(result).resolves.toEqual([8, 9, 10]); expect(core.revision).toEqual(before);
    expect(worker.model).toMatchObject(patch); expect(worker.sent.filter(value => value.type === 'operation')).toHaveLength(0);
  });
  it('copies the retained base tuple and preserves its applied epoch and pending numeric reference', async () => {
    const tuple = { id: 4, baseId: 5, epoch: 6 };
    const { core, worker } = await client({ transformSession: { ...tuple, appliedEpoch: 6, kind: 'numeric', selectedOnly: true,
      appliedMatrix: transformDefaults().matrix, pivot: [1, 2, 3], gizmo: null } });
    const before = { ...core.revision }, result = core.transformFocus('selection', tuple); tuple.epoch++; await flush();
    expect(worker.focus()).toMatchObject({ command: { transformBase: { id: 4, baseId: 5, epoch: 6 } } });
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3] } });
    await expect(result).resolves.toEqual([1, 2, 3]); expect(core.revision).toEqual(before);
  });
  it('rejects a successor mutation queued before the captured focus request', async () => {
    const { core, worker } = await client();
    const mutation = core.command({ command: 'mutate' }), result = core.transformFocus('selection', null);
    const rejection = expect(result).rejects.toThrow('stale or busy'); await flush();
    const request = worker.sent.find(value => value.type === 'command' && value.command.command === 'mutate')!;
    worker.model = { ...worker.model, revision: 8, selected: 3 };
    worker.emit(request, { type: 'result', summary: worker.model }); await mutation; await rejection;
    expect(worker.sent.some(value => value.type === 'command' && value.command.command === 'transformFocus')).toBe(false);
  });
  it('refuses operation ownership, active drafts and stale transform tuples before native dispatch', async () => {
    const one = await client(); one.core.createOperation();
    await expect(one.core.transformFocus('scene', null)).rejects.toThrow('Finish the current edit');
    const two = await client({ selectionDraft: true }); await expect(two.core.transformFocus('selection', null)).rejects.toThrow('stale or busy');
    const three = await client(); await expect(three.core.transformFocus('scene', { id: 1, baseId: 2, epoch: 0 })).rejects.toThrow('stale or busy');
    expect([one, two, three].every(value => !value.worker.sent.some(request => request.type === 'command' && request.command.command === 'transformFocus'))).toBe(true);
  });
  it('does not dispatch an already cancelled request', async () => {
    const { core, worker } = await client(), signal = AbortSignal.abort();
    await expect(core.transformFocus('scene', null, signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.sent.some(value => value.type === 'command' && value.command.command === 'transformFocus')).toBe(false);
  });
  it('joins cancellation to the exact native terminal before releasing the serial query', async () => {
    const { core, worker } = await client(), abort = new AbortController();
    const result = core.transformFocus('selection', null, abort.signal), rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
    await flush(); const request = worker.focus(); abort.abort(); await flush();
    expect(settled).toBe(false); expect(worker.sent.find(value => value.type === 'cancel')).toMatchObject({ requestId: request.requestId, base: request.base });
    worker.emit(request, { type: 'error', cancelled: true, error: 'Edit cancelled', summary: worker.model });
    await rejection; expect(settled).toBe(true); expect(worker.terminated).toBe(false);
  });
  it('joins a success already in flight before refusing its cancelled reference result', async () => {
    const { core, worker } = await client(), abort = new AbortController(), before = { ...core.revision };
    const result = core.transformFocus('selection', null, abort.signal), rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    let settled = false; void result.then(() => { settled = true; }, () => { settled = true; });
    await flush(); const request = worker.focus(); abort.abort(); await flush(); expect(settled).toBe(false);
    worker.emit(request, { type: 'result', summary: { ...worker.model, point: [8, 9, 10] } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(false);
  });
  it.each([{}, { point: undefined }, { point: [1, 2] }, { point: [1, Infinity, 3] }, { point: [.1, 2, 3] }, { point: null }])(
    'refuses a malformed scene-focus terminal %# without accepting document revisions', async patch => {
      const { core, worker } = await client(), before = { ...core.revision };
      const result = core.transformFocus('scene', null), rejection = expect(result).rejects.toThrow('Invalid native transform focus point.');
      await flush(); worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, ...patch } }); await rejection;
      expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
    });
  it('refuses unsolicited persistent metadata without accepting it', async () => {
    const { core, worker } = await client(), before = { ...core.revision };
    const result = core.transformFocus('selection', null), rejection = expect(result).rejects.toThrow('changed the document');
    await flush(); worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, canUndo: false, point: [1, 2, 3] } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
  });
  it('rejects a committed-selection event changing inside a readonly focus response', async () => {
    const { core, worker } = await client(), before = { ...core.revision };
    const result = core.transformFocus('selection', null), rejection = expect(result).rejects.toThrow('changed the document');
    await flush(); worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, selectionCommitRevision: 1, point: [1, 2, 3] } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
  });
  it('rejects a queued counter-only successor even when native content and selection revisions stay equal', async () => {
    const { core, worker } = await client(), before = { ...core.revision };
    const mutation = core.command({ command: 'counterEvent' }), result = core.transformFocus('selection', null);
    const rejection = expect(result).rejects.toThrow('stale or busy'); await flush();
    worker.model.selectionCommitRevision = 1;
    worker.emit(worker.sent.find(value => value.type === 'command' && value.command.command === 'counterEvent')!, { type: 'result', summary: worker.model });
    await mutation; await rejection; expect(core.revision).toEqual(before);
    expect(worker.sent.some(value => value.type === 'command' && value.command.command === 'transformFocus')).toBe(false);
  });
  it('accepts a rollback rewind and a reset on a newly handshaken client without interpreting them as durable revision order', async () => {
    const { core, worker } = await client({ selectionCommitRevision: 9 }), before = { ...core.revision };
    worker.model.selectionCommitRevision = 3;
    await expect(core.command({ command: 'summary' })).resolves.toMatchObject({ selectionCommitRevision: 3 });
    expect(core.revision).toEqual(before); expect(worker.terminated).toBe(false);
    const fresh = await client({ selectionCommitRevision: 0 });
    await expect(fresh.core.command({ command: 'summary' })).resolves.toMatchObject({ selectionCommitRevision: 0 });
  });
  it.each([undefined, null, true, '1', -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'requires a safe own counter on every actual handshaken result %#', async selectionCommitRevision => {
      const { core, worker } = await client(), before = { ...core.revision };
      const result = core.command({ command: 'invalidCounter' }), rejection = expect(result).rejects.toThrow('Invalid native selection commit revision.');
      await flush(); const request = worker.sent.find(value => value.type === 'command' && value.command.command === 'invalidCounter')!;
      const summary = { ...worker.model, selectionCommitRevision };
      if (selectionCommitRevision === undefined) delete summary.selectionCommitRevision;
      worker.emit(request, { type: 'result', summary }); await rejection;
      expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
    });
  it('refuses unsolicited operation ownership without acquiring an edit owner', async () => {
    const { core, worker } = await client(), before = { ...core.revision };
    const result = core.transformFocus('selection', null), rejection = expect(result).rejects.toThrow('acquired edit ownership');
    await flush(); worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3] },
      operationOwner: { version: 1, documentId: before.documentId, sourceGeneration: before.sourceGeneration,
        clientGeneration: 'unsolicited', operationId: 1 } });
    await rejection; expect(core.revision).toEqual(before); expect(core.operationOwner).toBeUndefined(); expect(worker.terminated).toBe(true);
  });
  it('reserves the generic command path for requests with an explicit readonly snapshot', async () => {
    await expect(CoreClient.prototype.command.call({} as CoreClient, { command: 'transformFocus' })).rejects.toThrow('bound readonly request');
  });
});

describe('Color/Fill Range client trust boundary', () => {
  const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
  const owner = { toleranceSessionId: 4, toleranceTool: 'color' as const, toleranceRecorded: true,
    toleranceRange: { enabled: true, radius: 2, center: [1, 2, 3] as const } };
  const pick = () => ({ command: 'colorPick', sessionId: 4, tolerance: .25, camera: [...camera], index: 0,
    width: 80, height: 40, seed: [12, 13], rangeEnabled: true, rangeRadius: 2 });
  it('captures click, camera, radius and seed before an earlier queued command completes', async () => {
    const { core, worker } = await client(), source = pick();
    const barrier = core.command({ command: 'held' }), selection = core.command(source); await flush();
    source.camera[0] = 99; source.seed[0] = 30; source.rangeRadius = 8;
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model }); await barrier; await flush();
    const request = worker.sent.at(-1)!;
    expect(request).toMatchObject({ type: 'command', command: { camera, seed: [12, 13], rangeRadius: 2 } });
    Object.assign(worker.model, owner); worker.emit(request, { type: 'result', summary: worker.model });
    const summary = await selection; expect(summary.toleranceRange).toEqual(owner.toleranceRange);
    expect(Object.isFrozen(summary.toleranceRange)).toBe(true); expect(Object.isFrozen(summary.toleranceRange!.center)).toBe(true);
  });
  it('accepts metadata-only amendments without inventing revision events', async () => {
    const { core, worker } = await client(owner), before = { ...core.revision };
    const response = core.command({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: false, rangeRadius: 3 });
    await flush(); worker.model.toleranceRange = { ...owner.toleranceRange, enabled: false, radius: 3 };
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).toleranceRange).toEqual(worker.model.toleranceRange); expect(core.revision).toEqual(before);
  });
  it('preserves the exact existing owner on a missed pick', async () => {
    const { core, worker } = await client(owner), response = core.command({ ...pick(), sessionId: 5 }); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).toleranceRange).toEqual(owner.toleranceRange); expect(worker.terminated).toBe(false);
  });
  it('rejects unsolicited frozen-center replacement on an unchanged revision amendment', async () => {
    const { core, worker } = await client(owner), before = { ...core.revision };
    const response = core.command({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 });
    const rejection = expect(response).rejects.toThrow('acknowledgement'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, toleranceRange: { ...owner.toleranceRange, center: [9, 2, 3] } } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
  });
  it('checks retained refusal metadata independently of the ordinary error text', async () => {
    const { core, worker } = await client(owner);
    const response = core.command({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 3 });
    const rejection = expect(response).rejects.toThrow('acknowledgement'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'error', error: 'native refusal', summary: { ...worker.model,
      toleranceRange: { ...owner.toleranceRange, center: [9, 2, 3] } } });
    await rejection; expect(worker.terminated).toBe(true);
  });
  it('requires physical Fill sampling and refuses stale amendments before dispatch', async () => {
    const { core, worker } = await client(), before = worker.sent.length;
    const fill: Record<string, unknown> & { command: string } = { ...pick(), command: 'fillPick', mapId: 8 }; delete fill.index;
    expect(() => core.command(fill)).toThrow('Invalid selection Range command');
    await expect(core.command({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 }))
      .rejects.toThrow('another captured owner');
    expect(worker.sent).toHaveLength(before);
  });
  it.each([undefined, { enabled: true, radius: .1, center: [1, 2, 3] }, { enabled: true, radius: 2, center: [.1, 2, 3] }])(
    'requires valid own nullable Range metadata after the actual handshake %#', async toleranceRange => {
      const { core, worker } = await client(), before = { ...core.revision };
      const response = core.command({ command: 'held' }), rejection = expect(response).rejects.toThrow('tolerance Range'); await flush();
      worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, toleranceRange } }); await rejection;
      expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
    });
  it('includes the complete retained Range in readonly focus authority', async () => {
    const { core, worker } = await client(owner), response = core.transformFocus('selection', null);
    const rejection = expect(response).rejects.toThrow('changed the document'); await flush();
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3],
      toleranceRange: { ...owner.toleranceRange, radius: 3 } } }); await rejection;
    expect(worker.terminated).toBe(true);
  });
  it('accepts an authoritative checkpoint rewind only in its captured amendment', async () => {
    const { core, worker } = await client(owner);
    const response = core.command({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 });
    await flush(); worker.model.toleranceRecorded = false;
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).toleranceRecorded).toBe(false); expect(worker.terminated).toBe(false);
    const generic = core.command({ command: 'held' }), rejection = expect(generic).rejects.toThrow('outside its captured request'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, toleranceRecorded: true } });
    await rejection; expect(worker.terminated).toBe(true);
  });
  it.each([undefined, null, 0, 1, 'true'])('requires an exact owned checkpoint scalar after an actual handshake %#', async toleranceRecorded => {
    const { core, worker } = await client(owner), response = core.command({ command: 'held' });
    const rejection = expect(response).rejects.toThrow('tolerance Range owner'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, toleranceRecorded } });
    await rejection; expect(worker.terminated).toBe(true);
  });
  it('binds the originating Undo bit through readonly focus without accepting a new owner state', async () => {
    const { core, worker } = await client(owner), response = core.transformFocus('selection', null);
    const rejection = expect(response).rejects.toThrow('changed the document'); await flush();
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3], toleranceRecorded: false } });
    await rejection; expect(worker.terminated).toBe(true);
  });
});

describe('selection filter changed client trust boundary', () => {
  const filter = { id: 7, kind: 'sphere' as const, epoch: 0, previewEpoch: null, changed: false };
  const preview = () => ({ command: 'previewFilter', id: 7, epoch: 1, kind: 'sphere', operation: 0,
    parameters: { center: [1, 2, 3], radius: 2 } });
  it('requires an unchanged begin owner with an explicit false difference', async () => {
    const { core, worker } = await client(), response = core.command({ command: 'beginFilter', kind: 'sphere' }); await flush();
    worker.model.filter = filter; worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).filter).toEqual(filter); expect(worker.terminated).toBe(false);
  });
  it.each([false, true])('accepts native changed=%s even when selected count and revisions are identical', async changed => {
    const { core, worker } = await client({ filter }), before = { ...core.revision }, response = core.command(preview()); await flush();
    worker.model.filter = { ...filter, epoch: 1, previewEpoch: 1, changed };
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).filter!.changed).toBe(changed); expect(worker.model.selected).toBe(2); expect(core.revision).toEqual(before);
  });
  it('detaches preview predicates before an earlier queued request releases', async () => {
    const { core, worker } = await client({ filter }), source = preview();
    const barrier = core.command({ command: 'held' }), response = core.command(source); await flush();
    source.parameters.center[0] = 99; source.parameters.radius = 20;
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model }); await barrier; await flush();
    expect(worker.sent.at(-1)).toMatchObject({ command: { parameters: { center: [1, 2, 3], radius: 2 } } });
    worker.model.filter = { ...filter, epoch: 1, previewEpoch: 1, changed: true };
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model }); await response;
  });
  it('joins an interrupted preview while retaining exactly its prior acknowledged visible difference', async () => {
    const { core, worker } = await client({ filter }), response = core.command(preview());
    const rejection = expect(response).rejects.toThrow('preview cancelled'); await flush();
    worker.model.filter = { ...filter, epoch: 1 };
    worker.emit(worker.sent.at(-1)!, { type: 'error', error: 'preview cancelled', summary: worker.model, cancelled: true });
    await rejection; expect(worker.terminated).toBe(false);
  });
  it('requires an explicit visible-preview confirmation to commit the acknowledged epoch after a canceled successor', async () => {
    const { core, worker } = await client({ filter: { ...filter, epoch: 2, previewEpoch: 1, changed: true } });
    const before = worker.sent.length;
    await expect(core.command({ command: 'confirmFilter', id: 7, epoch: 1 })).rejects.toThrow('another captured owner');
    expect(worker.sent).toHaveLength(before);
    const response = core.command({ command: 'confirmFilter', id: 7, epoch: 1, visiblePreview: true }); await flush();
    expect(worker.sent.at(-1)).toMatchObject({ command: { command: 'confirmFilter', id: 7, epoch: 1, visiblePreview: true } });
    worker.model.filter = null; worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).filter).toBeNull(); expect(worker.terminated).toBe(false);
  });
  it('rejects changed-only metadata on a non-filter response before adopting the native summary', async () => {
    const visible = { ...filter, epoch: 1, previewEpoch: 1, changed: false };
    const { core, worker } = await client({ filter: visible }), before = { ...core.revision }, response = core.command({ command: 'held' });
    const rejection = expect(response).rejects.toThrow('outside its captured request'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, filter: { ...visible, changed: true } } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
  });
  it.each([undefined, null, 0, 'true'])('requires own native changed metadata at every actual boundary %#', async changed => {
    const { core, worker } = await client({ filter }), response = core.command({ command: 'held' });
    const rejection = expect(response).rejects.toThrow('Invalid native selection filter metadata'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, filter: { ...filter, changed } } });
    await rejection; expect(worker.terminated).toBe(true);
  });
});

describe('native selection Undo history client boundary', () => {
  it.each(['point', 'planeNormal'])('refuses history changes in readonly %s before client adoption', async command => {
    const { core, worker } = await client(), before = { ...core.revision }, response = core.command({ command });
    const rejection = expect(response).rejects.toThrow('outside its captured request'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, undoSelectionRevision: 1 } });
    await rejection; expect(core.revision).toEqual(before); expect(worker.terminated).toBe(true);
  });
  it.each([undefined, -1, .5, 8, Number.MAX_SAFE_INTEGER + 1])('requires a valid own stamp on each actual response %#', async undoSelectionRevision => {
    const { core, worker } = await client(), response = core.command({ command: 'single', index: 0 });
    const rejection = expect(response).rejects.toThrow('Invalid native selection history metadata.'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, undoSelectionRevision } });
    await rejection; expect(worker.terminated).toBe(true);
  });
  it('accepts authoritative history changes for an edit and refuses a later readonly stamp change', async () => {
    const { core, worker } = await client(), response = core.command({ command: 'single', index: 0 }); await flush();
    worker.model.undoSelectionRevision = 3; worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await response).undoSelectionRevision).toBe(3);
    const query = core.command({ command: 'morphologyRange' }), rejection = expect(query).rejects.toThrow('outside its captured request'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, undoSelectionRevision: 4 } });
    await rejection; expect(worker.terminated).toBe(true);
  });
  it('includes the top history stamp in readonly focus authority', async () => {
    const { core, worker } = await client(), response = core.transformFocus('selection', null);
    const rejection = expect(response).rejects.toThrow('changed the document'); await flush();
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3], undoSelectionRevision: 1 } });
    await rejection; expect(worker.terminated).toBe(true);
  });
});

describe('gizmo session client authority', () => {
  const initial = (): TransformSessionSummary => ({ id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: 'gizmo', selectedOnly: true,
    appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } });
  it('captures a per-press target, then accepts only a rebased successful release with its first Cancel baseline', async () => {
    const { core, worker } = await client({ transformSession: initial() }), camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
    const rebasing = core.command({ command: 'rebaseTransform', id: 1, epoch: 1, selectedOnly: false, selectionView: camera });
    camera[0] = 99; await flush(); const press = worker.sent.at(-1)!;
    expect(press).toMatchObject({ command: { selectionView: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1] } });
    const rebased = { ...initial(), baseId: 3, epoch: 1, selectedOnly: false }; worker.model.transformSession = rebased;
    worker.emit(press, { type: 'result', summary: worker.model }); await rebasing;
    const parameters = transformDefaults(); parameters.translation[0] = 1;
    const applying = core.command({ command: 'applyTransform', id: 1, epoch: 2, parameters: transformWireParameters(parameters) }); await flush();
    worker.model = { ...worker.model, revision: 8, contentRevision: 4, transformSession: { ...rebased, baseId: 4, epoch: 2,
      gizmo: { cancelBaseId: 3, cancelContentRevision: 3, canUndo: true, canRedo: false } } };
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: worker.model });
    expect((await applying).transformSession).toMatchObject({ baseId: 4, appliedEpoch: null, gizmo: { cancelBaseId: 3 } });
    expect(worker.terminated).toBe(false);
  });
  it('rejects unsolicited valid Cancel ownership in a readonly response before publishing any successor', async () => {
    const { core, worker } = await client({ transformSession: initial() }), before = { ...core.revision };
    const query = core.command({ command: 'point', index: 0 }), refusal = expect(query).rejects.toThrow('outside its captured request'); await flush();
    worker.emit(worker.sent.at(-1)!, { type: 'result', summary: { ...worker.model, transformSession: { ...initial(),
      gizmo: { cancelBaseId: 2, cancelContentRevision: 3, canUndo: false, canRedo: false } } } });
    await refusal; expect(worker.terminated).toBe(true); expect(core.revision).toEqual(before);
  });
  it('binds new gizmo metadata through readonly focus and rejects a missing own numeric gizmo field', async () => {
    const { core, worker } = await client({ transformSession: initial() }), query = core.transformFocus('scene', { id: 1, baseId: 2, epoch: 0 });
    const refusal = expect(query).rejects.toThrow('changed the document'); await flush();
    worker.emit(worker.focus(), { type: 'result', summary: { ...worker.model, point: [1, 2, 3], transformSession: { ...initial(),
      gizmo: { cancelBaseId: 2, cancelContentRevision: 3, canUndo: false, canRedo: false } } } }); await refusal;
    const next = await client(), response = next.core.command({ command: 'held' }), rejected = expect(response).rejects.toThrow('Invalid native transform session.');
    await flush(); const { gizmo: _omitted, ...numeric } = { ...initial(), kind: 'numeric' };
    next.worker.emit(next.worker.sent.at(-1)!, { type: 'result', summary: { ...next.worker.model, transformSession: numeric } }); await rejected;
  });
});
