import { afterEach, describe, expect, it, vi } from 'vitest';
import { BenchmarkObservation, benchmarkReadonlyCopy, benchmarkMaskBase64, type BenchmarkFrameContext, type BenchmarkOperationState,
  type BenchmarkPickContext, type BenchmarkQueryOwner } from '../src/app/benchmarkObservation';
import { ResourceLedger } from '../src/document/resources';
import type { RendererNegotiationSnapshot } from '../src/renderer/webgpu/diagnostics';

// These are collector semantics tests with deliberately injected boundary
// observations. They are not browser/GPU timing or performance evidence.
function context(submission = 1, deviceEpoch = 1): BenchmarkFrameContext {
  return { deviceEpoch, rendererSubmissionSequence: submission,
    documentRevision: { documentId: 'literal-doc', sourceGeneration: 1, contentRevision: 2, selectionRevision: 3, draftRevision: 0 },
    sceneRevision: 4, camera: { revision: 5, state: [0, 0, 0, 0, 0, 24, 1, 45, 0, 0, 1],
      view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], eye: [0, 0, 24] },
    framebuffer: { width: 800, height: 600, devicePixelRatio: 1 }, visibility: 'visible' };
}
function operationState(hasScene = false): BenchmarkOperationState {
  return { busy: false, stage: '', error: null, navigationPrompt: false, hasScene, hasClient: hasScene,
    documentRevision: hasScene ? { documentId: 'literal-doc', sourceGeneration: 1, contentRevision: 2, selectionRevision: 3, draftRevision: 0 } : null };
}
const negotiation: RendererNegotiationSnapshot = {
  schemaVersion: 1, kind: 'splatview-renderer-negotiation', status: 'ready', stage: 'ready', clock: 'performance.now',
  startedAtMs: 1, observedAtMs: 2, clockUnavailableReason: null, stages: [{ stage: 'ready', status: 'ready', atMs: 2 }],
  adapter: null, requested: { features: [], limits: {} }, device: null, failure: null,
  gpuTimestamps: { available: false, reason: 'Literal test observation, no GPU timestamps.' },
};
afterEach(() => vi.useRealTimers());

describe('bounded opt-in benchmark observations', () => {
  it('retains actual decoded pick outcomes, detached ownership and bounded drops',()=>{
    const observation=new BenchmarkObservation(),frame=context(),owner:BenchmarkQueryOwner={clientOwnerId:1,rendererOwnerId:2,sceneOwnerId:3,cameraOwnerId:4,
      documentRevision:frame.documentRevision,camera:frame.camera,scene:{revision:4,sourceRevision:1,selectedRevision:0,count:256000},
      deviceEpoch:1,rendererSubmissionSequence:1,framebuffer:frame.framebuffer,visibility:'visible'};
    const query:BenchmarkPickContext={path:'ordinary-single',request:{x:318.5,y:400.5,centerRadius:0,sample:{x:318.5,y:400.5}},before:owner,
      renderState:{grade:[0],highlight:true,geometry:[1],selectedOnly:false,geometrySelectedOnly:false,opacityScale:1,opacitySelectedOnly:false}};
    for(let i=0;i<130;i++){const id=observation.beginPick(query,i*2);observation.settlePick(id,i*2+1,owner,
      {index:0,depth:24,opacity:.8,contribution:.7,deviceEpoch:1},null,i===129?'Camera changed.':null);}
    owner.camera!.state[0]=99;query.renderState.grade[0]=99;
    const value=observation.snapshot();expect(value.queries).toHaveLength(128);expect(value.droppedQueries).toBe(2);
    expect(value.queries[0].before.camera!.state[0]).toBe(0);expect(value.queries[0].renderState.grade).toEqual([0]);
    expect(value.queries.at(-1)).toMatchObject({status:'stale',settledAtMs:259,result:{index:0},staleReason:'Camera changed.',representation:'decoded-production-GpuPick-not-raw-readback'});
    const pending=observation.beginPick(query,300);observation.disable('owner ended');expect(observation.snapshot().queries.find(row=>row.sequence===pending)?.status).toBe('disabled');
  });
  it('encodes exact mask bytes across bounded base64 chunks without numeric-array serialization',()=>{
    for(const length of [0,1,2,3,32765,32766,32767,65539]){
      const bytes=Uint8Array.from({length},(_,i)=>i%256),encoded=benchmarkMaskBase64(bytes);
      expect(Uint8Array.from(atob(encoded),value=>value.charCodeAt(0))).toEqual(bytes);
    }
    expect(()=>benchmarkMaskBase64(new Uint8Array(3_000_001))).toThrow(/bound/);
  });
  it('detaches typed arrays and nested mutable owners without freezing the originals', () => {
    const original = { nested: [{ value: 1 }], matrix: new Float32Array([1, 2, 3]) };
    const copied = benchmarkReadonlyCopy(original);
    original.nested[0].value = 7; original.matrix[0] = 8;
    expect(copied).toEqual({ nested: [{ value: 1 }], matrix: [1, 2, 3] });
    expect(Object.isFrozen(copied)).toBe(true); expect(Object.isFrozen(copied.nested[0])).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });

  it.each([0, -1, 1.5, 8193, Number.NaN])('refuses invalid frame capacity %s', capacity => {
    expect(() => new BenchmarkObservation(capacity)).toThrow(/between 1 and 8192/);
  });

  it('retains an ordered bounded ring and explicit dropped count', () => {
    const observation = new BenchmarkObservation(2);
    const first = observation.recordSubmission(context(1), 1, 2, 3); observation.settleFrame(first, 4);
    const second = observation.recordSubmission(context(2), 5, 6, 7); observation.settleFrame(second, 8);
    const third = observation.recordSubmission(context(3), 9, 10, 11); observation.settleFrame(third, 12);
    const snapshot = observation.snapshot();
    expect(snapshot.frames.map(frame => frame.sequence)).toEqual([2, 3]);
    expect(snapshot.droppedFrames).toBe(1); expect(snapshot.maxFrames).toBe(2);
    expect(snapshot.lastFrameSequence).toBe(3);
  });

  it('captures immutable owner/camera/framebuffer identities at submission', () => {
    const observation = new BenchmarkObservation(), original = context();
    observation.recordSubmission(original, 1, 2, 3);
    original.camera.state[5] = 99; original.camera.view[0] = 99; original.framebuffer.width = 1;
    original.documentRevision!.contentRevision = 99;
    const frame = observation.snapshot().frames[0];
    expect(frame.camera.state[5]).toBe(24); expect(frame.camera.view[0]).toBe(1);
    expect(frame.framebuffer.width).toBe(800); expect(frame.documentRevision!.contentRevision).toBe(2);
    expect(frame.status).toBe('submitted'); expect(frame.queueCompletedAtMs).toBeNull();
    expect(frame.presentation.available).toBe(false); expect(frame.gpuTimestamps.available).toBe(false);
    expect(frame.submissionBoundary).toBe('render-return-after-confirmed-queue-submit');
  });

  it('never resolves a waiter merely because CPU work submitted a frame', async () => {
    const observation = new BenchmarkObservation();
    const id = observation.recordSubmission(context(), 1, 2, 3);
    let resolved = false;
    const pending = observation.waitForFrame(0, 1000).then(frame => { resolved = true; return frame; });
    await Promise.resolve(); expect(resolved).toBe(false);
    observation.settleFrame(id, 4);
    const frame = await pending;
    expect(frame.status).toBe('completed'); expect(frame.queueCompletedAtMs).toBe(4);
    expect(frame.queueSettledAtMs).toBe(4); expect(frame.submissionObservedAtMs).toBe(3);
    expect(observation.snapshot().pendingFrameWaiters).toBe(0);
  });

  it('returns an existing completed frame only after the requested sequence', async () => {
    const observation = new BenchmarkObservation();
    const first = observation.recordSubmission(context(1), 1, 2, 3); observation.settleFrame(first, 4);
    const second = observation.recordSubmission(context(2), 5, 6, 7); observation.settleFrame(second, 8);
    expect((await observation.waitForFrame(first)).sequence).toBe(second);
    expect((await observation.waitForFrame(0)).sequence).toBe(first);
  });

  it('reports actual queue failure with no invented successful completion timestamp', async () => {
    const observation = new BenchmarkObservation(), id = observation.recordSubmission(context(), 1, 2, 3);
    const pending = expect(observation.waitForFrame(0)).rejects.toThrow('device lost');
    observation.settleFrame(id, 4, 'device lost'); await pending;
    expect(observation.snapshot().frames[0]).toMatchObject({ status: 'failed', queueSettledAtMs: 4, queueCompletedAtMs: null, error: 'device lost' });
  });

  it('retains fulfilled queue time but refuses a stale owner', async () => {
    const observation = new BenchmarkObservation(), id = observation.recordSubmission(context(), 1, 2, 3);
    observation.settleFrame(id, 4, null, 'Document revision changed.');
    expect(observation.snapshot().frames[0]).toMatchObject({ status: 'stale', queueCompletedAtMs: 4, staleReason: 'Document revision changed.' });
    await expect(observation.waitForFrame(0)).rejects.toThrow('Document revision changed.');
  });

  it('records a render failure after submit without inventing a queue fence', async () => {
    const observation = new BenchmarkObservation(), id = observation.recordSubmission({ ...context(), drawError: 'render failed after submit' }, 1, 2, 3);
    observation.failFrameBeforeQueueObservation(id, 'render failed after submit');
    expect(observation.snapshot().frames[0]).toMatchObject({ status: 'failed', queueCompletedAtMs: null, queueSettledAtMs: null });
    await expect(observation.waitForFrame(0)).rejects.toThrow('render failed after submit');
  });

  it('rejects waiters and marks pending observations when disabled or disposed', async () => {
    const observation = new BenchmarkObservation(), id = observation.recordSubmission(context(), 1, 2, 3);
    observation.beginOperation('open-files', 2, operationState());
    const pending = expect(observation.waitForFrame(0)).rejects.toThrow('Controller disposed.');
    observation.disable('Controller disposed.'); await pending;
    observation.settleFrame(id, 7);
    expect(observation.snapshot()).toMatchObject({ enabled: false, disabledReason: 'Controller disposed.', pendingFrameWaiters: 0 });
    expect(observation.snapshot().frames[0]).toMatchObject({ status: 'disabled', queueCompletedAtMs: null, staleReason: 'Controller disposed.' });
    expect(observation.snapshot().operations[0].status).toBe('disabled');
    await expect(observation.waitForFrame(0)).rejects.toThrow('Controller disposed.');
    expect(() => observation.recordSubmission(context(2), 8, 9, 10)).toThrow(/disabled/);
  });

  it('times out bounded waits and removes their subscriptions', async () => {
    vi.useFakeTimers();
    const observation = new BenchmarkObservation();
    const pending = expect(observation.waitForFrame(0, 25)).rejects.toThrow(/Timed out/);
    await vi.advanceTimersByTimeAsync(25); await pending;
    expect(observation.snapshot().pendingFrameWaiters).toBe(0);
    await expect(observation.waitForFrame(0, 60001)).rejects.toThrow(/between 1 and 60000/);
  });

  it('bounds concurrent waiter owners and retires all of them', async () => {
    const observation = new BenchmarkObservation();
    const waits = Array.from({ length: 64 }, () => observation.waitForFrame(0).catch(error => error.message));
    await expect(observation.waitForFrame(0)).rejects.toThrow(/waiter bound/);
    expect(observation.snapshot().pendingFrameWaiters).toBe(64);
    observation.disable('capture ended');
    expect(await Promise.all(waits)).toEqual(Array.from({ length: 64 }, () => 'capture ended'));
  });

  it('rejects regressing or repeated actual renderer submission identities and clocks', () => {
    const observation = new BenchmarkObservation(); observation.recordSubmission(context(10, 4), 1, 2, 3);
    expect(() => observation.recordSubmission(context(10, 4), 4, 5, 6)).toThrow(/monotonic/);
    expect(() => observation.recordSubmission(context(11, 3), 4, 5, 6)).toThrow(/monotonic/);
    expect(() => observation.recordSubmission(context(11, 4), 1, 2, 3)).toThrow(/monotonic/);
    expect(() => observation.recordSubmission(context(1, 5), 4, 5, 6)).not.toThrow();
    expect(() => observation.settleFrame(2, 5)).toThrow(/clock moved backwards/);
    expect(observation.snapshot().lastFrameSequence).toBe(2);
  });

  it('continues frame sequence across captures while an old capture stays disabled', () => {
    const old = new BenchmarkObservation(); old.recordSubmission(context(), 1, 2, 3); old.disable();
    const next = new BenchmarkObservation(2, old.lastSequence);
    expect(next.recordSubmission(context(1, 2), 4, 5, 6)).toBe(2);
    old.disable('repeated old unsubscribe'); expect(next.active).toBe(true);
  });

  it('preserves real open and close promise boundaries without inferring semantic success', () => {
    const observation = new BenchmarkObservation();
    const open = observation.beginOperation('open-files', 1, operationState());
    const loaded = operationState(true); observation.settleOperation(open, 4, loaded);
    const close = observation.beginOperation('close-scene', 5, loaded);
    const prompted = { ...loaded, navigationPrompt: true }; observation.settleOperation(close, 6, prompted);
    const events = observation.snapshot().operations;
    expect(events[0]).toMatchObject({ status: 'settled', startedAtMs: 1, settledAtMs: 4, closed: null });
    expect(events[1]).toMatchObject({ status: 'settled', startedAtMs: 5, settledAtMs: 6, closed: false, after: { navigationPrompt: true } });
    const actualClose = observation.beginOperation('close-scene', 7, loaded);
    observation.settleOperation(actualClose, 8, operationState());
    expect(observation.snapshot().operations[2].closed).toBe(true);
  });

  it('retains failed operations and bounded operation inventory', () => {
    const observation = new BenchmarkObservation();
    for (let index = 0; index < 257; index++) {
      const id = observation.beginOperation('open-files', 2 * index, operationState());
      observation.settleOperation(id, 2 * index + 1, operationState(), 'input refused');
    }
    const snapshot = observation.snapshot();
    expect(snapshot.operations.length).toBe(256); expect(snapshot.droppedOperations).toBe(1);
    expect(snapshot.operations[0].sequence).toBe(2); expect(snapshot.operations[255].status).toBe('failed');
    expect(snapshot.operations[255].error).toBe('input refused');
  });

  it('bounds copied negotiation histories independently of frame records', () => {
    const observation = new BenchmarkObservation();
    for (let index = 0; index < 65; index++) observation.recordNegotiation({ ...negotiation, observedAtMs: index });
    const snapshot = observation.snapshot();
    expect(snapshot.negotiations.length).toBe(64); expect(snapshot.droppedNegotiations).toBe(1);
    expect(snapshot.negotiations[0].observedAtMs).toBe(1); expect(snapshot.negotiations[63].observedAtMs).toBe(64);
    expect(Object.isFrozen(snapshot.negotiations[0].requested!.features)).toBe(true);
  });

  it('snapshots logical category byte/count totals, including live zero-byte reservations', () => {
    const ledger = new ResourceLedger(100), source = ledger.reserve('source', 10), render = ledger.reserve('render', 20);
    const zero = ledger.reserve('source', 0), before = ledger.categorySnapshot;
    expect(before.source).toEqual({ bytes: 10, allocations: 2 }); expect(before.render).toEqual({ bytes: 20, allocations: 1 });
    expect(Object.values(before).reduce((sum, value) => sum + value.bytes, 0)).toBe(ledger.usage.bytes);
    expect(Object.values(before).reduce((sum, value) => sum + value.allocations, 0)).toBe(ledger.usage.allocations);
    source.resize(15); render(); zero();
    expect(before.source.bytes).toBe(10); expect(ledger.categorySnapshot.source).toEqual({ bytes: 15, allocations: 1 });
    expect(Object.isFrozen(before.source)).toBe(true); expect(ledger.categorySnapshot.render).toEqual({ bytes: 0, allocations: 0 });
    source(); expect(ledger.usage.bytes).toBe(0);
  });
});
