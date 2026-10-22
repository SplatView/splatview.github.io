import type { Revision } from '../document/types';
import type { RendererNegotiationSnapshot } from '../renderer/webgpu/diagnostics';

export type DeepReadonly<T> = T extends readonly (infer V)[] ? readonly DeepReadonly<V>[] :
  T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

/** Detached plain data; never freezes application-owned objects or typed views. */
export function benchmarkReadonlyCopy<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    return Object.freeze(Array.from(value as ArrayLike<unknown>, item => benchmarkReadonlyCopy(item))) as DeepReadonly<T>;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = benchmarkReadonlyCopy(item);
    return Object.freeze(result) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}

export type BenchmarkCameraObservation = {
  revision: number; state: number[]; view: number[]; projection: number[]; eye: number[];
};
export type BenchmarkFrameContext = {
  deviceEpoch: number; rendererSubmissionSequence: number;
  documentRevision: Revision | null; sceneRevision: number | null;
  camera: BenchmarkCameraObservation;
  framebuffer: { width: number; height: number; devicePixelRatio: number };
  visibility: string;
  drawError?: string | null;
};
export type BenchmarkFrameObservation = DeepReadonly<BenchmarkFrameContext & {
  sequence: number; status: 'submitted' | 'completed' | 'failed' | 'stale' | 'disabled';
  clock: 'performance.now'; rafAtMs: number; drawStartedAtMs: number;
  // render() has returned and its actual queue-submit counter advanced. The
  // queue submission occurred between drawStartedAtMs and this observation.
  submissionObservedAtMs: number; submissionBoundary: 'render-return-after-confirmed-queue-submit';
  queueSettledAtMs: number | null; queueCompletedAtMs: number | null;
  error: string | null; staleReason: string | null;
  presentation: { available: false; reason: string };
  gpuTimestamps: { available: false; reason: string };
}>;
export type BenchmarkOperationState = {
  busy: boolean; stage: string; error: string | null; navigationPrompt: boolean;
  hasScene: boolean; hasClient: boolean; documentRevision: Revision | null;
};
export type BenchmarkOperationObservation = DeepReadonly<{
  sequence: number; kind: 'open-files' | 'close-scene'; status: 'pending' | 'settled' | 'failed' | 'disabled';
  clock: 'performance.now'; startedAtMs: number; settledAtMs: number | null;
  before: BenchmarkOperationState; after: BenchmarkOperationState | null;
  // Pointer state at the joined public boundary, not a physical-memory claim.
  closed: boolean | null; error: string | null;
}>;
export type BenchmarkQueryOwner = {
  clientOwnerId:number|null;rendererOwnerId:number|null;sceneOwnerId:number|null;cameraOwnerId:number|null;
  documentRevision:Revision|null;camera:BenchmarkCameraObservation|null;
  scene:{revision:number;sourceRevision:number;selectedRevision:number;count:number}|null;
  deviceEpoch:number|null;rendererSubmissionSequence:number|null;
  framebuffer:{width:number;height:number;devicePixelRatio:number}|null;visibility:string;
};
export type BenchmarkPickContext = {
  path:'ordinary-single'|'ordinary-color';request:{x:number;y:number;centerRadius:0;sample:{x:number;y:number}};before:BenchmarkQueryOwner;
  renderState:{grade:number[];highlight:true;geometry:number[];selectedOnly:boolean;geometrySelectedOnly:boolean;opacityScale:1;opacitySelectedOnly:false};
};
export type BenchmarkDecodedPick = {index:number|null;depth:number|null;opacity:number|null;contribution:number|null;deviceEpoch:number};
export type BenchmarkPickObservation = DeepReadonly<BenchmarkPickContext & {
  sequence:number;status:'pending'|'completed'|'stale'|'failed'|'disabled';clock:'performance.now';startedAtMs:number;settledAtMs:number|null;
  after:BenchmarkQueryOwner|null;result:BenchmarkDecodedPick|null;error:string|null;staleReason:string|null;
  representation:'decoded-production-GpuPick-not-raw-readback';
}>;
export type BenchmarkMaskObservation = {
  schemaVersion:1;kind:'splatview-controller-benchmark-mask';status:'completed'|'stale'|'failed';clock:'performance.now';
  startedAtMs:number;settledAtMs:number;before:BenchmarkQueryOwner;after:BenchmarkQueryOwner;sourceCount:number;byteLength:number;
  encoding:'base64';bytesBase64:string|null;callbacks:number;summary:unknown|null;error:string|null;staleReason:string|null;
};
export type BenchmarkSurfaceEvent = DeepReadonly<{
  sequence:number;clock:'performance.now';atMs:number;stage:'surface-create'|'native-adopt';status:'started'|'completed'|'failed';
  key:string;sourceCount:number;channels:{colors:boolean;visible:boolean};mapId?:number;attempts?:number;tileCapacity?:number;
  error?:string;owner:BenchmarkQueryOwner;
}>;
export function benchmarkOwnerChange(before:BenchmarkQueryOwner,after:BenchmarkQueryOwner):string|null {
  for(const key of ['clientOwnerId','rendererOwnerId','sceneOwnerId','cameraOwnerId','deviceEpoch','documentRevision','camera','scene','framebuffer','visibility'] as const)
    if(JSON.stringify(before[key])!==JSON.stringify(after[key]))return`Query ${key} changed before completion.`;
  return null;
}
export const BENCHMARK_MASK_BYTE_LIMIT=3_000_000;
/** Bounded chunks avoid a scene-sized argument array or frozen numeric array. */
export function benchmarkMaskBase64(bytes:Uint8Array):string {
  if(bytes.byteLength>BENCHMARK_MASK_BYTE_LIMIT)throw new Error('Benchmark state mask exceeds the byte bound.');
  const parts:string[]=[];
  for(let first=0;first<bytes.length;first+=32766){
    const chunk=bytes.subarray(first,Math.min(first+32766,bytes.length));let binary='';
    for(let i=0;i<chunk.length;i++)binary+=String.fromCharCode(chunk[i]);parts.push(btoa(binary));
  }
  return parts.join('');
}

class BoundedRing<T extends { readonly sequence: number }> {
  private entries: (T | undefined)[];
  private positions = new Map<number, number>();
  private head = 0;
  private count = 0;
  dropped = 0;
  constructor(readonly capacity: number) { this.entries = new Array(capacity); }
  push(value: T): void {
    const previous = this.entries[this.head];
    if (previous) { this.positions.delete(previous.sequence); this.dropped++; }
    this.entries[this.head] = value; this.positions.set(value.sequence, this.head);
    this.head = (this.head + 1) % this.capacity; this.count = Math.min(this.capacity, this.count + 1);
  }
  get(sequence: number): T | undefined { const at = this.positions.get(sequence); return at === undefined ? undefined : this.entries[at]; }
  replace(value: T): void { const at = this.positions.get(value.sequence); if (at !== undefined) this.entries[at] = value; }
  values(): T[] {
    const result: T[] = [], start = (this.head - this.count + this.capacity) % this.capacity;
    for (let offset = 0; offset < this.count; offset++) result.push(this.entries[(start + offset) % this.capacity]!);
    return result;
  }
}

type Waiter = { after: number; resolve(value: BenchmarkFrameObservation): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
const unavailablePresentation = { available: false as const, reason: 'Queue completion does not observe browser presentation.' };
const unavailableGpuTime = { available: false as const, reason: 'GPU timestamp queries are not instrumented for these display submissions.' };
function timestamp(value: number): void { if (!Number.isFinite(value) || value < 0) throw new Error('Invalid benchmark clock observation.'); }
function sequence(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid benchmark sequence.'); }

/** Opt-in bounded observations. Its caller supplies real boundary timestamps. */
export class BenchmarkObservation {
  private frames: BoundedRing<BenchmarkFrameObservation>;
  private operations = new BoundedRing<BenchmarkOperationObservation>(256);
  private queries = new BoundedRing<BenchmarkPickObservation>(128);
  private surfaces = new BoundedRing<BenchmarkSurfaceEvent>(128);
  private querySequence = 0;
  private surfaceSequence = 0;
  private ownerSequence = 0;
  private identities = new WeakMap<object,number>();
  private negotiations: DeepReadonly<RendererNegotiationSnapshot>[] = [];
  private negotiationDrops = 0;
  private waiters = new Set<Waiter>();
  private enabled = true;
  private disabledReason: string | null = null;
  private frameSequence: number;
  private operationSequence = 0;
  private openFilesOperationSequence = 0;
  private closeSceneOperationSequence = 0;
  private previousSubmission?: { deviceEpoch: number; sequence: number; atMs: number };
  constructor(maxFrames = 4096, initialFrameSequence = 0) {
    if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 8192) throw new Error('Benchmark frame bound must be between 1 and 8192.');
    sequence(initialFrameSequence); this.frames = new BoundedRing(maxFrames); this.frameSequence = initialFrameSequence;
  }
  get active(): boolean { return this.enabled; }
  get lastSequence(): number { return this.frameSequence; }
  objectIdentity(value:object):number {
    let id=this.identities.get(value);if(id===undefined){id=++this.ownerSequence;this.identities.set(value,id);}return id;
  }
  beginPick(context:BenchmarkPickContext,atMs:number):number {
    if(!this.enabled)throw new Error('Benchmark observation is disabled.');timestamp(atMs);
    const value=benchmarkReadonlyCopy({...context,sequence:++this.querySequence,status:'pending' as const,clock:'performance.now' as const,
      startedAtMs:atMs,settledAtMs:null,after:null,result:null,error:null,staleReason:null,
      representation:'decoded-production-GpuPick-not-raw-readback' as const});this.queries.push(value);return value.sequence;
  }
  settlePick(id:number,atMs:number,after:BenchmarkQueryOwner,result:BenchmarkDecodedPick|null,error:string|null=null,staleReason:string|null=null):void {
    if(!this.enabled)return;const previous=this.queries.get(id);if(!previous||previous.status!=='pending')return;
    timestamp(atMs);if(atMs<previous.startedAtMs)throw new Error('Benchmark pick clock moved backwards.');
    this.queries.replace(benchmarkReadonlyCopy({...previous,status:error?'failed' as const:staleReason?'stale' as const:'completed' as const,
      settledAtMs:atMs,after,result,error,staleReason}));
  }
  recordSurface(event:Omit<BenchmarkSurfaceEvent,'sequence'|'clock'>):void {
    if(!this.enabled)return;timestamp(event.atMs);this.surfaces.push(benchmarkReadonlyCopy({...event,sequence:++this.surfaceSequence,clock:'performance.now' as const}));
  }
  recordNegotiation(value: RendererNegotiationSnapshot): void {
    if (!this.enabled) return;
    if (this.negotiations.length === 64) { this.negotiations.shift(); this.negotiationDrops++; }
    this.negotiations.push(benchmarkReadonlyCopy(value));
  }
  recordSubmission(context: BenchmarkFrameContext, rafAtMs: number, drawStartedAtMs: number, submissionObservedAtMs: number): number {
    if (!this.enabled) throw new Error('Benchmark observation is disabled.');
    timestamp(rafAtMs); timestamp(drawStartedAtMs); timestamp(submissionObservedAtMs);
    if (submissionObservedAtMs < drawStartedAtMs) throw new Error('Benchmark submission clock moved backwards.');
    sequence(context.deviceEpoch); sequence(context.rendererSubmissionSequence);
    if (context.rendererSubmissionSequence < 1) throw new Error('Benchmark frame requires an actual queue submission.');
    if (this.previousSubmission && (context.deviceEpoch < this.previousSubmission.deviceEpoch ||
      context.deviceEpoch === this.previousSubmission.deviceEpoch && context.rendererSubmissionSequence <= this.previousSubmission.sequence ||
      drawStartedAtMs < this.previousSubmission.atMs)) throw new Error('Benchmark submission identity/clock is not monotonic.');
    this.previousSubmission = { deviceEpoch: context.deviceEpoch, sequence: context.rendererSubmissionSequence, atMs: submissionObservedAtMs };
    const value = benchmarkReadonlyCopy({ ...context, sequence: ++this.frameSequence, status: 'submitted' as const,
      clock: 'performance.now' as const, rafAtMs, drawStartedAtMs, submissionObservedAtMs,
      submissionBoundary: 'render-return-after-confirmed-queue-submit' as const,
      queueSettledAtMs: null, queueCompletedAtMs: null, error: null, staleReason: null, drawError: context.drawError ?? null,
      presentation: unavailablePresentation, gpuTimestamps: unavailableGpuTime });
    this.frames.push(value); return value.sequence;
  }
  failFrameBeforeQueueObservation(id: number, error: string): void {
    if (!this.enabled) return;
    const previous = this.frames.get(id); if (!previous || previous.status !== 'submitted') return;
    this.frames.replace(benchmarkReadonlyCopy({ ...previous, status: 'failed' as const, error }));
    for (const waiter of [...this.waiters]) if (id > waiter.after) {
      clearTimeout(waiter.timer); this.waiters.delete(waiter); waiter.reject(new Error(error));
    }
  }
  settleFrame(id: number, atMs: number, error: string | null = null, staleReason: string | null = null): void {
    if (!this.enabled) return;
    const previous = this.frames.get(id);
    if (!previous || previous.status !== 'submitted') return;
    timestamp(atMs);
    if (atMs < previous.submissionObservedAtMs) throw new Error('Benchmark queue completion clock moved backwards.');
    const value = benchmarkReadonlyCopy({ ...previous, status: error || previous.drawError ? 'failed' as const : staleReason ? 'stale' as const : 'completed' as const,
      queueSettledAtMs: atMs, queueCompletedAtMs: error ? null : atMs, error: error ?? previous.drawError ?? null, staleReason });
    this.frames.replace(value);
    for (const waiter of [...this.waiters]) if (id > waiter.after) {
      clearTimeout(waiter.timer); this.waiters.delete(waiter);
      if (value.status === 'completed') waiter.resolve(value);
      else waiter.reject(new Error(value.error ?? staleReason ?? 'Benchmark frame did not complete.'));
    }
  }
  beginOperation(kind: BenchmarkOperationObservation['kind'], atMs: number, before: BenchmarkOperationState): number {
    if (!this.enabled) throw new Error('Benchmark observation is disabled.');
    timestamp(atMs);
    const value = benchmarkReadonlyCopy({ sequence: ++this.operationSequence, kind, status: 'pending' as const,
      clock: 'performance.now' as const, startedAtMs: atMs, settledAtMs: null, before, after: null, closed: null, error: null });
    this.operations.push(value);
    if (kind === 'open-files') this.openFilesOperationSequence = value.sequence; else this.closeSceneOperationSequence = value.sequence;
    return value.sequence;
  }
  settleOperation(id: number, atMs: number, after: BenchmarkOperationState, error: string | null = null): void {
    if (!this.enabled) return;
    const previous = this.operations.get(id); if (!previous || previous.status !== 'pending') return;
    timestamp(atMs); if (atMs < previous.startedAtMs) throw new Error('Benchmark operation clock moved backwards.');
    this.operations.replace(benchmarkReadonlyCopy({ ...previous, status: error ? 'failed' as const : 'settled' as const,
      settledAtMs: atMs, after, closed: previous.kind === 'close-scene' ? !after.hasScene && !after.hasClient : null, error }));
  }
  waitForFrame(afterSequence: number, timeoutMs = 10000): Promise<BenchmarkFrameObservation> {
    sequence(afterSequence);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) return Promise.reject(new Error('Benchmark frame timeout must be between 1 and 60000 ms.'));
    if (!this.enabled) return Promise.reject(new Error(this.disabledReason ?? 'Benchmark observation is disabled.'));
    for (const frame of this.frames.values()) if (frame.sequence > afterSequence && frame.status !== 'submitted') {
      return frame.status === 'completed' ? Promise.resolve(frame) : Promise.reject(new Error(frame.error ?? frame.staleReason ?? 'Benchmark frame did not complete.'));
    }
    if (this.waiters.size >= 64) return Promise.reject(new Error('Benchmark frame waiter bound exceeded.'));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { after: afterSequence, resolve, reject, timer: setTimeout(() => {
        this.waiters.delete(waiter); reject(new Error('Timed out waiting for a completed benchmark frame.'));
      }, timeoutMs) };
      this.waiters.add(waiter);
    });
  }
  disable(reason = 'Benchmark observation disabled.'): void {
    if (!this.enabled) return;
    this.enabled = false; this.disabledReason = reason;
    for (const frame of this.frames.values()) if (frame.status === 'submitted') this.frames.replace(benchmarkReadonlyCopy({
      ...frame, status: 'disabled' as const, staleReason: reason }));
    for (const operation of this.operations.values()) if (operation.status === 'pending') this.operations.replace(benchmarkReadonlyCopy({
      ...operation, status: 'disabled' as const, error: reason }));
    for(const query of this.queries.values())if(query.status==='pending')this.queries.replace(benchmarkReadonlyCopy({...query,status:'disabled' as const,staleReason:reason}));
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(reason)); }
    this.waiters.clear();
  }
  snapshot() {
    return benchmarkReadonlyCopy({ enabled: this.enabled, disabledReason: this.disabledReason, maxFrames: this.frames.capacity,
      frameScope: 'scheduled-AppController.draw-display-submissions', operationScope: 'public-openFiles-and-closeScene-promise-boundaries',
      lastFrameSequence: this.frameSequence, droppedFrames: this.frames.dropped, frames: this.frames.values(),
      pendingFrameWaiters: this.waiters.size, maxFrameWaiters: 64, maxNegotiations: 64,
      negotiations: this.negotiations, droppedNegotiations: this.negotiationDrops,
      lastOperationSequence: this.operationSequence, lastOpenFilesOperationSequence: this.openFilesOperationSequence,
      lastCloseSceneOperationSequence: this.closeSceneOperationSequence, operations: this.operations.values(),
      maxOperations: this.operations.capacity, droppedOperations: this.operations.dropped,
      queryScope:'actual-ordinary-single-and-color-renderer-pick-calls',queries:this.queries.values(),lastQuerySequence:this.querySequence,
      maxQueries:this.queries.capacity,droppedQueries:this.queries.dropped,
      surfaceEvents:this.surfaces.values(),lastSurfaceSequence:this.surfaceSequence,maxSurfaceEvents:this.surfaces.capacity,droppedSurfaceEvents:this.surfaces.dropped });
  }
}
