import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILD_DESCRIPTOR } from '../src/generated/buildIdentity';
import { NEUTRAL_COLOR } from '../src/renderer/defaults';
import { BUILD_ID, PROTOCOL_VERSION, type NativeSummary, type WorkerResponse } from '../src/document/types';
import type { WasmModule } from '../src/workers/wasm';
import type { WorkerBootstrapResponse } from '../src/build/bootstrap';
import { transformDefaults, transformWireParameters, type TransformSessionSummary } from '../src/document/transformProtocol';
import { emptyCensus } from './fixtures/allocation-census';

// Shipping worker + controlled module: native focus bounds/admission are tested
// independently by the C++ ABI contract, rather than recreated by this fixture.
const runtime = vi.hoisted(() => ({ core: undefined as unknown as WasmModule, engineOnly: true }));
// Existing advanced-engine protocol fixtures are independent of product scope.
// The production-policy block below forwards to the real gate and proves that
// web-lite refuses those commands before the controlled module can execute them.
vi.mock('../src/app/productPolicy', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/app/productPolicy')>();
  return { ...actual, requireWorkerProductCommand(value: unknown) {
    if (!runtime.engineOnly) actual.requireWorkerProductCommand(value);
  } };
});
vi.mock('../src/workers/wasm', async importOriginal => ({
  ...await importOriginal<typeof import('../src/workers/wasm')>(), loadCore: async () => runtime.core,
}));
vi.mock('../src/build/native', () => ({ nativeModuleIdentity: () => BUILD_DESCRIPTOR.native.core }));
type Response = WorkerResponse | WorkerBootstrapResponse;
class WorkerContext {
  location = { origin: 'https://example.test' };
  onmessage?: (event: { data: unknown }) => void;
  sent: Response[] = [];
  private unread: Response[] = [];
  private waiters: { type: Response['type']; resolve(value: Response): void }[] = [];
  postMessage(value: Response, transfer: Transferable[] = []) {
    const copy = structuredClone(value, { transfer }); this.sent.push(copy);
    const index = this.waiters.findIndex(waiter => waiter.type === copy.type);
    if (index === -1) this.unread.push(copy); else this.waiters.splice(index, 1)[0].resolve(copy);
  }
  next(type: Response['type']) {
    const index = this.unread.findIndex(value => value.type === type);
    if (index !== -1) return Promise.resolve(this.unread.splice(index, 1)[0]);
    return new Promise<Response>(resolve => this.waiters.push({ type, resolve }));
  }
  send(value: unknown) { this.onmessage?.({ data: structuredClone(value) }); }
}
function scene(): NativeSummary {
  return { ok: true, selectionCommitRevision: 0, undoSelectionRevision: 0, toleranceRecorded: null, toleranceRange: null, toleranceSessionId: null, toleranceTool: null, duplicateRange: null, loaded: true, count: 5, sourceCount: 8, shDegree: 0, format: 'PLY', kind: 0,
    selected: 2, visible: 4, canUndo: true, canRedo: false, revision: 7, contentRevision: 3,
    transaction: false, selectionDraft: false, sceneChanged: false, pending: false, progress: 1,
    floor: null, filter: null, colorSession: null, transformSession: null, opacitySession: null,
    center: [3, 4, 5], radius: 10, yUp: false, camera: [], memoryBytes: 1024,
    selectionMapId: null, pendingSelectionMapId: null, selectionMapBytes: 0, selectionMapRetainedIds: [] };
}
const envelope = { protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 2,
  base: { documentId: 'focus-worker-test', sourceGeneration: 1, contentRevision: 0, selectionRevision: 0, draftRevision: 0 } };
const focus = { command: 'transformFocus', scope: 'selection', revision: 7, contentRevision: 3, transformBase: null };
let context: WorkerContext, model: NativeSummary, commands: Record<string, unknown>[], steps: number[];
let batchCount: number, terminalPatch: Record<string, unknown>;
let rangePatch: Partial<NativeSummary> | undefined;
let filterPatch: Partial<NativeSummary> | undefined;
let historyPatch: Partial<NativeSummary> | undefined;
let transformPatch: Partial<NativeSummary> | undefined;
beforeEach(async () => {
  runtime.engineOnly = true;
  vi.resetModules(); context = new WorkerContext(); vi.stubGlobal('self', context);
  model = scene(); commands = []; steps = []; batchCount = 0; terminalPatch = { point: [8, 9, 10] }; rangePatch = undefined; filterPatch = undefined; historyPatch = undefined; transformPatch = undefined;
  const heap = new Uint8Array(new WebAssembly.Memory({ initial: 32 }).buffer);
  let output: unknown = model, pointer = 128, censusSequence = 0, remaining = 0;
  runtime.core = {
    HEAPU8: heap, HEAPF32: new Float32Array(heap.buffer), _malloc: (bytes: number) => { const value = pointer; pointer += bytes + 16; return value; },
    _free: () => undefined,
    UTF8ToString: (value: number) => JSON.stringify(value === 12 ? emptyCensus(censusSequence) : output),
    _sv_allocation_snapshot: () => { censusSequence++; return 12; },
    _sv_command: (value: number) => {
      const end = heap.indexOf(0, value), command = JSON.parse(new TextDecoder().decode(heap.subarray(value, end))) as Record<string, unknown>;
      if (command.command !== 'summary') commands.push(command);
      if (command.command === 'transformFocus') {
        remaining = batchCount;
        output = remaining ? { ...model, pending: true, progress: 0 } : { ...model, ...terminalPatch };
      } else {
        if (command.command === 'cancel') remaining = 0;
        if (['colorPick', 'colorTolerance', 'fillPick', 'fillTolerance'].includes(String(command.command))) Object.assign(model, rangePatch);
        if (['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(String(command.command))) Object.assign(model, filterPatch);
        if (command.command !== 'summary') Object.assign(model, historyPatch);
        if (command.command !== 'summary') Object.assign(model, transformPatch);
        output = model;
      }
      return 8;
    },
    _sv_step: (work: number) => {
      steps.push(work); remaining--;
      output = remaining > 0 ? { ...model, pending: true, progress: .5 } : { ...model, ...terminalPatch };
      return 8;
    },
  } as unknown as WasmModule;
  await import('../src/workers/document.worker');
  context.send({ type: 'initialize', initializationId: 'focus-worker-test', build: BUILD_DESCRIPTOR,
    mode: 'development-module-graph', assetBase: 'https://example.test/' }); await context.next('ready');
  context.send({ ...envelope, requestId: 1, type: 'command', command: { command: 'summary' } }); await context.next('result');
});

describe('web-lite production worker policy', () => {
  beforeEach(() => { runtime.engineOnly = false; });
  it.each(['command', 'live-preview'])(
    'refuses enabled Range through %s without native execution', async type => {
      const before = structuredClone(model);
      request({ command: 'colorPick', sessionId: 4, tolerance: .25, index: 0,
        camera: [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1], rangeEnabled: true, rangeRadius: 2 }, { type });
      expect(await context.next('error')).toMatchObject({ error: expect.stringContaining('Selection range is unavailable') });
      expect(commands).toEqual([]);
      expect(model).toEqual(before);
    });
  it.each(['brush', 'rectangle', 'colorPick', 'beginTransform'])(
    'refuses current-view %s before native execution and retains the document', async command => {
      const before = structuredClone(model);
      const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
      request({ command, selectionView: camera,
        ...(command === 'colorPick' ? { sessionId: 4, tolerance: .25, index: 0, camera } : {}),
        ...(command === 'beginTransform' ? { kind: 'gizmo', selectedOnly: true } : {}) });
      expect(await context.next('error')).toMatchObject({ error: expect.stringContaining('Current-view selection is unavailable') });
      expect(commands.some(value => value.command === command)).toBe(false);
      expect(model).toEqual(before);
    });
  it.each(['beginFilter', 'morphology', 'duplicate', 'beginOpacity', 'detectFloor', 'futureCommand'])(
    'refuses %s before native execution and retains the document', async command => {
      const before = structuredClone(model);
      request({ command, ...(command === 'beginFilter' ? { kind: 'sphere' } : {}) });
      const response = await context.next('error');
      expect(response.type).toBe('error');
      expect(response).toMatchObject({ error: expect.stringContaining('unavailable in the lightweight web editor') });
      expect(commands.some(value => value.command === command)).toBe(false);
      expect(model).toEqual(before);
    });
});

describe('Color/Fill Range shipping worker boundary', () => {
  const camera = [0, 0, 0, 0, 0, 3, 1, 45, 0, 0, 1];
  const owner = { toleranceSessionId: 4, toleranceTool: 'color' as const, toleranceRecorded: true,
    toleranceRange: { enabled: true, radius: 2, center: [1, 2, 3] as const } };
  const pick = { command: 'colorPick', sessionId: 4, tolerance: .25, index: 0, camera, rangeEnabled: true, rangeRadius: 2 };
  it('publishes a validated exact frozen Color center through the existing result family', async () => {
    rangePatch = owner; request(pick);
    expect(await context.next('result')).toMatchObject({ summary: owner });
    expect(commands).toEqual([pick]);
  });
  it('accepts a full-value metadata-only amendment with an unchanged native revision', async () => {
    Object.assign(model, owner); rangePatch = { toleranceRange: { ...owner.toleranceRange, enabled: false, radius: 3 } };
    request({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: false, rangeRadius: 3 });
    expect(await context.next('result')).toMatchObject({ summary: { revision: 7, contentRevision: 3, selectionCommitRevision: 0,
      toleranceRange: { enabled: false, radius: 3, center: [1, 2, 3] } } });
  });
  it('retains the complete preceding owner when an initial pick misses', async () => {
    Object.assign(model, owner); request({ ...pick, sessionId: 5 });
    expect(await context.next('result')).toMatchObject({ summary: owner });
  });
  it('refuses center replacement in a retained error outcome as well as a success', async () => {
    Object.assign(model, owner); rangePatch = { toleranceRange: { ...owner.toleranceRange, center: [9, 2, 3] } };
    request({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 });
    expect(await context.next('error')).toMatchObject({ error: 'The tolerance Range acknowledgement changed its captured request.', cleanupFailed: true });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it('rejects stale amendments and injected centers before entering native code', async () => {
    request({ command: 'colorTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 });
    expect(await context.next('error')).toMatchObject({ error: 'The tolerance Range request belongs to another captured owner.' });
    expect(commands).toHaveLength(0);
    request({ ...pick, center: [1, 2, 3] }); expect(await context.next('error')).toMatchObject({ error: 'Invalid selection Range command.' });
    expect(commands).toHaveLength(0);
  });
  it('allows documented disabled legacy Fill entry while requiring physical sampling for enabled initial Fill', async () => {
    const fill = { command: 'fillPick', sessionId: 4, tolerance: .25, mapId: 8, camera, width: 80, height: 40, seed: [12, 13] };
    rangePatch = { toleranceSessionId: 4, toleranceTool: 'fill', toleranceRecorded: false, toleranceRange: { enabled: false, radius: null, center: null } };
    request(fill); expect(await context.next('result')).toMatchObject({ summary: rangePatch });
    expect(commands[0]).toEqual({ ...fill, rangeEnabled: false, rangeRadius: null });
    request({ ...fill, sessionId: 5, rangeEnabled: true, rangeRadius: 2 });
    expect(await context.next('error')).toMatchObject({ error: 'Invalid selection Range command.' }); expect(commands).toHaveLength(1);
    rangePatch = { toleranceRange: { enabled: true, radius: 2, center: null } };
    request({ command: 'fillTolerance', sessionId: 4, tolerance: .25, rangeEnabled: true, rangeRadius: 2 });
    expect(await context.next('result')).toMatchObject({ summary: { toleranceSessionId: 4, toleranceTool: 'fill',
      toleranceRange: { enabled: true, radius: 2, center: null } } });
  });
  it('binds retained Range metadata throughout readonly cooperative pivot scans', async () => {
    Object.assign(model, owner); batchCount = 2;
    terminalPatch = { point: [1, 2, 3], toleranceRange: { ...owner.toleranceRange, radius: 3 } }; request();
    expect(await context.next('error')).toMatchObject({ error: 'The transform focus response changed the document.' });
  });
  it('binds the originating checkpoint Undo bit throughout readonly pivot scans', async () => {
    Object.assign(model, owner); terminalPatch = { point: [1, 2, 3], toleranceRecorded: false }; request();
    expect(await context.next('error')).toMatchObject({ error: 'The transform focus response changed the document.' });
  });
  it('refuses missing own nullable Range telemetry instead of fabricating a fallback', async () => {
    vi.useFakeTimers();
    try {
      delete model.toleranceRange; const before = context.sent.length; request();
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1); expect(() => vi.runOnlyPendingTimers()).toThrow('Invalid native tolerance Range owner.');
      expect(context.sent).toHaveLength(before); expect(commands).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});

describe('selection filter changed shipping worker boundary', () => {
  const filter = { id: 7, kind: 'sphere' as const, epoch: 0, previewEpoch: null, changed: false };
  const preview = { command: 'previewFilter', id: 7, epoch: 1, kind: 'sphere', operation: 0,
    parameters: { center: [1, 2, 3], radius: 2 } };
  it('publishes an explicit false baseline owner without a new command family', async () => {
    filterPatch = { filter }; request({ command: 'beginFilter', kind: 'sphere' });
    expect(await context.next('result')).toMatchObject({ summary: { filter } });
    expect(commands).toEqual([{ command: 'beginFilter', kind: 'sphere' }]);
  });
  it.each([false, true])('retains authoritative changed=%s for a completed same-count preview', async changed => {
    model.filter = filter; filterPatch = { filter: { ...filter, epoch: 1, previewEpoch: 1, changed } }; request(preview);
    expect(await context.next('result')).toMatchObject({ summary: { selected: 2, revision: 7, filter: { epoch: 1, previewEpoch: 1, changed } } });
    expect(commands).toEqual([preview]);
  });
  it('rejects stale preview ownership before native dispatch', async () => {
    model.filter = { ...filter, epoch: 1, previewEpoch: 1, changed: true }; request(preview);
    expect(await context.next('error')).toMatchObject({ error: 'The selection filter request belongs to another captured owner.' });
    expect(commands).toHaveLength(0);
  });
  it('refuses a mismatched begin owner despite a structurally valid changed boolean', async () => {
    filterPatch = { filter: { ...filter, kind: 'box' } }; request({ command: 'beginFilter', kind: 'sphere' });
    expect(await context.next('error')).toMatchObject({ error: 'The selection filter acknowledgement changed its captured request.', cleanupFailed: true });
  });
  it('removes the exact captured owner on cancel and clears its metadata', async () => {
    model.filter = { ...filter, epoch: 1, previewEpoch: 1, changed: true }; filterPatch = { filter: null };
    request({ command: 'cancelFilter', id: 7 }); expect(await context.next('result')).toMatchObject({ summary: { filter: null } });
  });
  it('accepts only explicit true for confirming a prior acknowledged visible epoch after cancellation', async () => {
    model.filter = { ...filter, epoch: 2, previewEpoch: 1, changed: true }; filterPatch = { filter: null };
    request({ command: 'confirmFilter', id: 7, epoch: 1 });
    expect(await context.next('error')).toMatchObject({ error: 'The selection filter request belongs to another captured owner.' });
    expect(commands).toHaveLength(0);
    request({ command: 'confirmFilter', id: 7, epoch: 1, visiblePreview: true });
    expect(await context.next('result')).toMatchObject({ summary: { filter: null } });
    expect(commands).toEqual([{ command: 'confirmFilter', id: 7, epoch: 1, visiblePreview: true }]);
  });
  it('rejects an unknown changed scalar at native telemetry without inventing false', async () => {
    vi.useFakeTimers();
    try {
      model.filter = { id: filter.id, kind: filter.kind, epoch: filter.epoch, previewEpoch: filter.previewEpoch };
      const before = context.sent.length; request({ command: 'summary' });
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1); expect(() => vi.runOnlyPendingTimers()).toThrow('Invalid native selection filter metadata.');
      expect(context.sent).toHaveLength(before);
    } finally { vi.useRealTimers(); }
  });
});

describe('native selection Undo history shipping worker boundary', () => {
  it('publishes a valid authoritative selection edit stamp', async () => {
    historyPatch = { undoSelectionRevision: 7 }; request({ command: 'single', index: 0 });
    expect(await context.next('result')).toMatchObject({ summary: { revision: 7, canUndo: true, undoSelectionRevision: 7 } });
  });
  it.each(['morphologyRange', 'point', 'planeNormal'])('refuses changed history from readonly %s before publishing success', async command => {
    historyPatch = { undoSelectionRevision: 1 }; request({ command });
    expect(await context.next('error')).toMatchObject({ error: 'The selection history changed outside its captured request.', cleanupFailed: true });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it('includes the history stamp in the persistent focus signature', async () => {
    terminalPatch = { point: [1, 2, 3], undoSelectionRevision: 1 }; request();
    expect(await context.next('error')).toMatchObject({ error: 'The transform focus response changed the document.' });
  });
  it('rejects missing own history telemetry without fabricating zero', async () => {
    vi.useFakeTimers();
    try {
      delete model.undoSelectionRevision; const before = context.sent.length; request();
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1); expect(() => vi.runOnlyPendingTimers()).toThrow('Invalid native selection history metadata.');
      expect(context.sent).toHaveLength(before);
    } finally { vi.useRealTimers(); }
  });
});

describe('gizmo session shipping worker boundary', () => {
  const initial = (): TransformSessionSummary => ({ id: 1, baseId: 2, epoch: 0, appliedEpoch: null, kind: 'gizmo', selectedOnly: true,
    appliedMatrix: transformDefaults().matrix, pivot: [0, 0, 0], gizmo: { cancelBaseId: null, cancelContentRevision: null, canUndo: false, canRedo: false } });
  it('publishes a correctly rebased accepted bake without incrementing or preserving a stale absolute preview', async () => {
    model.transformSession = initial(); transformPatch = { revision: 8, contentRevision: 4, transformSession: { ...initial(), baseId: 3, epoch: 1,
      gizmo: { cancelBaseId: 2, cancelContentRevision: 3, canUndo: true, canRedo: false } } };
    const parameters = transformDefaults(); parameters.translation[0] = 1;
    request({ command: 'applyTransform', id: 1, epoch: 1, parameters: transformWireParameters(parameters) });
    expect(await context.next('result')).toMatchObject({ summary: { transformSession: { baseId: 3, appliedEpoch: null, gizmo: { cancelBaseId: 2 } } } });
  });
  it('refuses a valid but unsolicited owner metadata change in a readonly query', async () => {
    model.transformSession = initial(); transformPatch = { transformSession: { ...initial(),
      gizmo: { cancelBaseId: 2, cancelContentRevision: 3, canUndo: false, canRedo: false } } };
    request({ command: 'point', index: 0 });
    expect(await context.next('error')).toMatchObject({ error: 'The transform session changed outside its captured request.', cleanupFailed: true });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it('refuses stale press epochs before native invocation', async () => {
    model.transformSession = { ...initial(), epoch: 2 };
    request({ command: 'rebaseTransform', id: 1, epoch: 1, selectedOnly: true });
    expect(await context.next('error')).toMatchObject({ error: 'The transform request belongs to another captured owner.' }); expect(commands).toHaveLength(0);
  });
});
afterEach(() => vi.unstubAllGlobals());
function request(command: unknown = focus, extra: Record<string, unknown> = {}) {
  context.send({ ...envelope, type: 'command', command, ...extra });
}

describe('transform focus shipping worker boundary', () => {
  it('returns a readonly native point with the existing result family and no operation envelope', async () => {
    request(); const result = await context.next('result');
    expect(result).toMatchObject({ type: 'result', summary: { point: [8, 9, 10], revision: 7, contentRevision: 3, canUndo: true } });
    expect(result).not.toHaveProperty('operationOwner'); expect(commands).toEqual([focus]); expect(steps).toEqual([]);
  });
  it('keeps a retained immutable base tuple, with no current-view target substitution', async () => {
    model.transformSession = { id: 4, baseId: 5, epoch: 6, appliedEpoch: 6, kind: 'numeric', selectedOnly: true,
      appliedMatrix: transformDefaults().matrix, pivot: [1, 2, 3], gizmo: null };
    request({ ...focus, transformBase: { id: 4, baseId: 5, epoch: 6 } });
    expect(await context.next('result')).toMatchObject({ summary: { point: [8, 9, 10], transformSession: { epoch: 6, appliedEpoch: 6 } } });
    expect(commands).toEqual([{ ...focus, transformBase: { id: 4, baseId: 5, epoch: 6 } }]);
  });
  it.each(['tolerance', 'color', 'opacity'] as const)('reads a settled retained %s owner without cleanup commands', async owner => {
    const patch: Partial<NativeSummary> = owner === 'tolerance' ? { toleranceSessionId: 7, toleranceMapId: 8,
      toleranceTool: 'fill', toleranceConnected: true, toleranceRecorded: true, toleranceRange: { enabled: false, radius: null, center: [1, 2, 3] } } : owner === 'color' ? { colorSession: { version: 1, active: true,
      sessionId: 3, baseId: 4, epochId: 5, pending: false, selectedOnly: true, values: [...NEUTRAL_COLOR], applied: [...NEUTRAL_COLOR] } } :
      { opacitySession: { id: 3, baseId: 4, epoch: 0, appliedEpoch: null, selectedOnly: true, appliedScale: 1 } };
    Object.assign(model, patch); request();
    expect(await context.next('result')).toMatchObject({ summary: { ...patch, point: [8, 9, 10], selectionCommitRevision: 0 } });
    expect(commands).toEqual([focus]);
  });
  it('runs a cooperative native focus job through bounded normal pump steps', async () => {
    batchCount = 3; request(); expect(await context.next('result')).toMatchObject({ summary: { point: [8, 9, 10], pending: false } });
    expect(steps).toEqual([4096, 4096, 4096]);
    expect(context.sent.some(value => value.type === 'progress' && value.stage === 'Measuring transform pivot')).toBe(true);
  });
  it('cancels the exact cooperative query and joins native cleanup before its error response', async () => {
    batchCount = 258; request(); await context.next('progress');
    context.send({ ...envelope, type: 'cancel' });
    expect(await context.next('error')).toMatchObject({ cancelled: true, summary: { pending: false, revision: 7 } });
    expect(commands.filter(value => value.command === 'cancel')).toHaveLength(1);
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it.each([
    { ...focus, selectionView: null }, { ...focus, operationOwner: null }, { ...focus, scope: 'visible' },
    { ...focus, revision: 1.5 }, { ...focus, extra: true },
  ])('rejects malformed requests before the native focus entry %#', async command => {
    request(command); expect(await context.next('error')).toMatchObject({ error: 'Invalid transform focus command.' });
    expect(commands).toEqual([]);
  });
  it.each([{ revision: 8 }, { contentRevision: 4 }, { transformBase: { id: 4, baseId: 5, epoch: 6 } }])(
    'rejects stale native state before focus dispatch %#', async patch => {
      request({ ...focus, ...patch }); expect(await context.next('error')).toMatchObject({ error: 'The transform focus snapshot is stale or busy.' });
      expect(commands).toEqual([]);
    });
  it('refuses a request with operation ownership before executing the query', async () => {
    request(focus, { operationOwner: { version: 1, documentId: 'focus-worker-test', sourceGeneration: 1, clientGeneration: 'focus-worker-test', operationId: 1 } });
    expect(await context.next('error')).toMatchObject({ error: 'Resolve the owned edit before starting other scene work.' }); expect(commands).toEqual([]);
  });
  it.each([{}, { point: undefined }, { point: [1, 2] }, { point: [1, 1e100, 3] }, { point: [.1, 2, 3] }])(
    'requires a valid explicit point from every terminal %#', async patch => {
      terminalPatch = patch; request(); expect(await context.next('error')).toMatchObject({ error: 'Invalid native transform focus point.' });
      expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
    });
  it('preserves an empty selection result without borrowing the scene center', async () => {
    model.selected = 0; terminalPatch = { point: null }; request();
    expect(await context.next('result')).toMatchObject({ summary: { point: null, center: [3, 4, 5] } });
  });
  it('rejects terminal state changes before publishing any focus result', async () => {
    terminalPatch = { point: [8, 9, 10], canRedo: true }; request();
    expect(await context.next('error')).toMatchObject({ error: 'The transform focus response changed the document.' });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it('binds the committed-selection event throughout the cooperative query', async () => {
    batchCount = 3; terminalPatch = { point: [8, 9, 10], selectionCommitRevision: 1 }; request();
    expect(await context.next('error')).toMatchObject({ error: 'The transform focus response changed the document.' });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it.each([undefined, -1, .5, Number.MAX_SAFE_INTEGER + 1])('refuses an invalid scalar in a terminal native focus reply %#', async selectionCommitRevision => {
    terminalPatch = { point: [8, 9, 10], selectionCommitRevision }; request();
    expect(await context.next('error')).toMatchObject({ error: 'Invalid native selection commit revision.' });
    expect(context.sent.filter(value => value.type === 'result' && value.requestId === 2)).toHaveLength(0);
  });
  it.each([undefined, -1, .5, Number.MAX_SAFE_INTEGER + 1])('retires invalid scalar telemetry with one fatal worker error %#', async selectionCommitRevision => {
    vi.useFakeTimers();
    try {
      model.selectionCommitRevision = selectionCommitRevision;
      const before = context.sent.length; request();
      for (let index = 0; index < 20; index++) await Promise.resolve();
      expect(vi.getTimerCount()).toBe(1); expect(() => vi.runOnlyPendingTimers()).toThrow('Invalid native selection commit revision.');
      expect(context.sent).toHaveLength(before); expect(commands).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });
});
