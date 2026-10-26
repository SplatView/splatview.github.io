import { requireWebGpuRenderer } from './gaussian-harness-scene';
import { admittedExport, exportWorkObservation } from './admitted-export';
// Test-only transport faults around the actual App, emitted worker, native
// transactions and GPU. No receipt, summary or scene stream is fabricated.
// Explicit recovery-corruption cases alter only a genuine outgoing restore
// copy after its reader has verified it, or the named restore binding field.
import { setApp, useApp } from '../src/app/store';
import type { SceneCommand } from '../src/document/types';
import { AdmissionError, resourceCreditBytes, resourceLeaseCredit, type ResourceLedger, type ResourceLease } from '../src/document/resources';
import type { GaussianRenderer, GpuScene } from '../src/renderer/webgpu/renderer';
import { requireGaussianScene } from './gaussian-harness-scene';
import type { RecoveryCheckpointDescription } from '../src/document/recoveryCheckpoint';
import type { AlignmentViewCheckpoints } from '../src/document/alignmentViews';
import type { TransformParameters } from '../src/document/transformProtocol';
import type { DocumentRecoveryStore } from '../src/document/recoveryCoordinator';
import type { CoreClient } from '../src/document/coreClient';
import type { NativeCoverageUpdate, NativeHeapAccounting } from '../src/document/nativeMemory';

type Action = 'begin' | 'commit' | 'rollback' | 'status' | 'retire';
type Wire = Record<string, unknown>;
type Fault = { direction: 'request' | 'response'; action: Action; effect: 'drop' | 'hold' | 'wrong-owner'; remaining?: number };
type WireFault = { direction: 'request' | 'response'; type: string; action?: Action; effect: 'drop' | 'hold'; remaining?: number };
type RequestEvidence = { worker: number; requestId: number; type: string; action: Action | null; command: string | null;
  forwarded: boolean; altered: boolean; data: Wire };
type ResponseEvidence = { worker: number; requestId: number; action: Action | null; type: string; delivered: boolean; data: Wire };
type TimerEvidence = { id: number; name: string; delay: number; armed: boolean; expired: boolean };
const requests: RequestEvidence[] = [], responses: ResponseEvidence[] = [];
const faults: (Fault & { used: number })[] = [], timers: TimerEvidence[] = [];
const recoveryFaults: (WireFault & { used: number })[] = [];
const rawResponses = new Map<number, { worker: ObservedWorker; data: unknown }>();
const timerCallbacks = new Map<number, () => void>();
const workers: { id: number; terminated: number; injectedFailures: number }[] = [];
const workerInstances = new Map<number, ObservedWorker>();
const NativeWorker = window.Worker, nativeSetTimeout = window.setTimeout.bind(window), nativeClearTimeout = window.clearTimeout.bind(window);
const acknowledgementTimers = new Set(['operationAcknowledgementExpired', 'operationReconciliationExpired']);
type ReconstructionMode = 'header' | 'payload' | 'range' | 'gpu' | 'source-generation' | 'core' | 'admission';
type ReconstructionObservation = { mode: ReconstructionMode; rangeIndex: number; oldWorker: number | null; oldScene: number;
  candidate: number | null; rangeHeld: boolean; consumed: number[]; errors: { worker: number; message: string; cancelled: boolean; cleanupFailed: boolean }[];
  mutation: { field: string; offset: number | null; length: number; beforeSha256: string | null; afterSha256: string | null; before: unknown; after: unknown } | null;
  heldEntries: ReturnType<typeof resources>['entries']; fillerBytes: number; admission: { requested: number; available: number; genuine: boolean; message: string } | null;
  gpu: { scene: number; epoch: number; fenceJoined: boolean; lossJoined: boolean; reason: string | null; beforePublication: boolean; disposalJoined: boolean;
    buffers: number; destroyedBuffers: number; entries: ReturnType<typeof resources>['entries'] } | null;
  closeStarted: boolean; closeSettled: boolean; cancellationHeld: boolean };
type HeldReconstructionRange = { worker: ObservedWorker; message: Wire; options?: Transferable[] | StructuredSerializeOptions; evidence: RequestEvidence };
let reconstructionFault: ReconstructionObservation | undefined;
let reconstructionOwner: { oldClient: CoreClient; oldScene: GpuScene; oldLease: ResourceLease; originalEntries: Set<number>;
  candidateClient?: CoreClient; held?: HeldReconstructionRange; filler?: ResourceLease; restore: (() => void)[];
  closeTask?: Promise<void>; holdCancellation: boolean } | undefined;
type RecoveryWatchdogObservation = { id: number; requestId: number; recoveryId: string; delay: number; requestedAt: number;
  armed: boolean; suppressedAt: number | null; clearedAt: number | null };
type ReleaseTimeoutObservation = { worker: number; oldScene: number; requestId: number | null; recoveryId: string | null;
  heldAt: number | null; decision: { rootSha256: string; binding: RecoveryCheckpointDescription['binding']; plan: RecoveryCheckpointDescription['plan'] } | null;
  error: { receivedAt: number; response: Wire } | null; watchdogs: RecoveryWatchdogObservation[] };
let releaseTimeoutOwner: { client: CoreClient; scene: GpuScene; lease: ResourceLease; observation: ReleaseTimeoutObservation } | undefined;

window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
  const watchdog = releaseWatchdog(callback, delay);
  // Only the old client's identified recovery-export watchdog is gated. Its
  // genuine 60-second page timer still runs; its competing callback is held.
  // Worker timers and worker/native execution are never wrapped or advanced.
  const scheduled = watchdog && typeof callback === 'function' ? () => { watchdog.suppressedAt = performance.now(); } : callback;
  const id = nativeSetTimeout(scheduled, delay, ...args);
  if (watchdog) watchdog.id = id;
  if (typeof callback === 'function' && acknowledgementTimers.has(callback.name)) {
    timers.push({ id, name: callback.name, delay: delay ?? 0, armed: true, expired: false });
    timerCallbacks.set(id, () => callback(...args));
  }
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  const timer = timers.findLast(value => value.id === id); if (timer) timer.armed = false;
  if (id !== undefined) timerCallbacks.delete(id); nativeClearTimeout(id);
  const watchdog = releaseTimeoutOwner?.observation.watchdogs.find(value => value.id === id);
  if (watchdog) { watchdog.armed = false; watchdog.clearedAt = performance.now(); }
}) as typeof window.clearTimeout;
function takeFault(direction: Fault['direction'], action: Action | null) {
  const fault = faults.find(value => value.direction === direction && value.action === action && value.used < (value.remaining ?? 1));
  if (fault) fault.used++; return fault;
}
function takeWireFault(direction: WireFault['direction'], type: string, action: Action | null) {
  const fault = recoveryFaults.find(value => value.direction === direction && value.type === type &&
    (value.action === undefined || value.action === action) && value.used < (value.remaining ?? 1));
  if (fault) fault.used++; return fault;
}
class ObservedWorker extends NativeWorker {
  readonly observerId = workers.length + 1;
  private requestById = new Map<number, RequestEvidence>();
  private replaying = new WeakSet<Event>();
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options); workers.push({ id: this.observerId, terminated: 0, injectedFailures: 0 }); workerInstances.set(this.observerId, this);
    // Registered before CoreClient installs onmessage, so a real completed
    // terminal can be withheld without replacing its native payload.
    super.addEventListener('message', event => {
      if (this.replaying.has(event)) return;
      const data = event.data as Wire;
      if (!data || typeof data !== 'object' || typeof data.requestId !== 'number') return;
      const request = this.requestById.get(data.requestId);
      const action = request?.action ?? null;
      if (data.type === 'progress' || !action && !String(data.type).startsWith('recovery-') &&
          !(data.type === 'error' && (request?.type.startsWith('recovery-') || reconstructionFault?.candidate === this.observerId))) return;
      const forcedHold = observeReconstructionResponse(this.observerId, data);
      observeReleaseTimeoutResponse(this.observerId, data);
      const fault = takeFault('response', action) ?? takeWireFault('response', String(data.type), action), index = responses.length;
      const delivered = !fault && !forcedHold;
      responses.push({ worker: this.observerId, requestId: data.requestId, action,
        type: String(data.type), delivered, data: evidenceWire(data) });
      if ((!reconstructionFault && !releaseTimeoutOwner) || !(data.bytes instanceof ArrayBuffer)) rawResponses.set(index, { worker: this, data: event.data });
      if (fault || forcedHold) event.stopImmediatePropagation();
    });
  }
  postMessage(message: unknown, transfer: Transferable[]): void;
  postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  postMessage(message: unknown, options?: Transferable[] | StructuredSerializeOptions) {
    const data = message as Wire;
    let forwarded = message;
    if (data && typeof data === 'object' && typeof data.requestId === 'number') {
      const action = data.type === 'operation' ? data.action as Action : null;
      const fault = takeFault('request', action) ?? takeWireFault('request', String(data.type), action);
      const injected = injectReconstructionRequest(this.observerId, data);
      const heldRelease = holdTimedRelease(this.observerId, data);
      forwarded = injected.message;
      const evidence: RequestEvidence = { worker: this.observerId, requestId: data.requestId, type: String(data.type), action,
        command: data.type === 'command' ? String((data.command as Wire).command) : null,
        forwarded: !heldRelease && !injected.hold && (!fault || fault.effect === 'wrong-owner'),
        altered: injected.altered || fault?.effect === 'wrong-owner', data: evidenceWire(forwarded as Wire) };
      requests.push(evidence); this.requestById.set(data.requestId, evidence);
      if (heldRelease) return;
      if (injected.hold) {
        reconstructionOwner!.held = { worker: this, message: forwarded as Wire, options, evidence };
        return;
      }
      if (fault?.effect === 'wrong-owner') {
        forwarded = structuredClone(data);
        // Only the operation owner changes. The real authenticated envelope,
        // request ID and native execution/response path are preserved.
        (forwarded as Wire).operationOwner = { ...(data.operationOwner as Wire), clientGeneration: crypto.randomUUID() };
      } else if (fault) return;
    }
    if (Array.isArray(options)) super.postMessage(forwarded, options); else super.postMessage(forwarded, options);
  }
  replay(data: unknown) {
    const event = new MessageEvent('message', { data }); this.replaying.add(event); this.dispatchEvent(event);
  }
  forwardHeld(message: Wire, options?: Transferable[] | StructuredSerializeOptions) {
    if (Array.isArray(options)) super.postMessage(message, options); else super.postMessage(message, options);
  }
  terminate() {
    if (reconstructionOwner?.held?.worker === this) reconstructionOwner.held = undefined;
    workers[this.observerId - 1].terminated++; super.terminate();
  }
  fail() {
    workers[this.observerId - 1].injectedFailures++;
    // Worker.terminate destroys the actual native authority but deliberately
    // emits no error event. Deliver that separate, explicit test seam through
    // the unchanged CoreClient.onerror handler after termination has happened.
    this.terminate();
    this.dispatchEvent(new ErrorEvent('error', { cancelable: true,
      message: 'The browser test terminated the authoritative scene worker.',
      error: new Error('The browser test terminated the authoritative scene worker.') }));
  }
}
window.Worker = ObservedWorker;
// The observer is installed before the real App starts creating workers.
await import('./geometry-viewer-harness');
const controller = () => window.geometryViewer.controllerForSourceNavigation();
const ledger = () => (controller() as unknown as { ledger: ResourceLedger }).ledger;
const positions = [[-.75, .2, .1], [-.4, -.2, .05], [0, .3, -.1], [.4, -.3, .15], [.75, .1, -.15]];
const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .125, 0, 0, 1];
function fixture() {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...Array.from({ length: 45 }, (_, field) => `f_rest_${field}`)];
  const rows = positions.map((point, id) => [...point, .2 + id * .125, -.3 + id * .0625, .1 - id * .03125,
    Math.log((.6 + id * .05) / (.4 - id * .05)), ...[.035, .05, .075].map(scale => Math.log(scale * (1 + id * .1))), 1, 0, 0, 0,
    ...Array.from({ length: 45 }, (_, field) => ((id + 1) * ((field % 7) - 3)) / 512)].join(' '));
  return new TextEncoder().encode(['ply', 'format ascii 1.0', 'element vertex 5', ...names.map(name => `property float ${name}`), 'end_header', ...rows, ''].join('\n'));
}
const resourceIds = new Map<symbol, number>(), sceneIds = new WeakMap<GpuScene, number>();
const scenes: { scene: GpuScene; id: number; disposeCalls: number }[] = [];
let observingRenderer: unknown, pending: Promise<boolean> | undefined, finished: boolean | null = null;
let publicationRestore: (() => void) | undefined;
let sourceOutput: ReturnType<typeof ply> | undefined;
let maskPublication: { calls: number; afterCommit: boolean; owner: unknown } | null = null;
type PostPublicationLoss = { calls: number; oldScene: number; oldWorker: number | null; oldDeviceEpoch: number;
  oldBorrowersJoined: boolean; oldRetired: boolean; publishedScene: number | null; publishedWorker: number | null;
  publishedGeneration: string | null; publishedDeviceEpoch: number | null; lossJoined: boolean; lossReason: string | null };
let postPublicationLoss: PostPublicationLoss | null = null;
type CoverageAttempt = { worker: number; generation: string; requiredDelta: number; availableBytes: number;
  beforeBytes: number; afterBytes: number; oldCreditBytes: number | null; oldRetired: boolean;
  retirementJoined: boolean; outcome: 'pending' | 'accepted' | 'refused'; admissionError: boolean; error: string | null };
type PressureObservation = { mode: 'recoverable' | 'insufficient'; limit: number; oldWorker: number | null; oldScene: number;
  oldAllocationBytes: number; fillerBytes: number; fillerHeld: boolean; deficit: number; attempts: CoverageAttempt[];
  retirementCalls: number; queueFenceJoined: boolean; borrowerReleased: boolean; retirementJoined: boolean;
  destroyedBuffers: number; bufferCount: number };
let pressureOwner: { observation: PressureObservation; oldScene: GpuScene; oldLease: ResourceLease;
  oldHistory?: ResourceLease; filler?: ResourceLease; releaseBorrower(): void; restore(): void } | undefined;
function observeScene(scene: GpuScene) {
  let id = sceneIds.get(scene); if (id !== undefined) return id;
  id = scenes.length + 1; sceneIds.set(scene, id);
  const observation = { scene, id, disposeCalls: 0 }, original = scene.dispose.bind(scene); scenes.push(observation);
  scene.dispose = (...args) => { observation.disposeCalls++; return original(...args); }; return id;
}
function observeRenderer() {
  const renderer = requireWebGpuRenderer(controller().renderer);
  if (observingRenderer !== renderer) {
    const original = renderer.allocateScene.bind(renderer);
    renderer.allocateScene = async (...args) => { const scene = await original(...args); observeScene(scene); return scene; };
    observingRenderer = renderer;
  }
  if (controller().scene?.kind === 'gaussian') observeScene(requireGaussianScene(controller().scene));
}
function resources() {
  const owner = ledger(), client = controller().client;
  const memory = client?.nativeMemory, retired = memory?.state.retired === true;
  const native = client as unknown as { worker?: Worker; exportOutputLease?: ResourceLease;
    lastAllocation?: { exportOutputBytes?: number } } | undefined;
  // Recovery can retain the old client reference after its joined heap
  // retirement. Its last allocation describes that former worker, while all
  // actual ledger entries (including reconstruction work) remain observable.
  if (retired && (!client?.failed || native?.worker || native?.exportOutputLease ||
      owner.owns(memory!.remainder) || resourceCreditBytes(resourceLeaseCredit(memory!.remainder)) !== undefined ||
      memory!.state.coveredBytes !== 0 || memory!.state.remainderBytes !== 0))
    throw new Error('The retired native export observation still has a live worker or authenticated credit.');
  const entries = [...(owner as unknown as { entries: Map<symbol, { category: string; bytes: number }> }).entries].map(([identity, entry]) => {
    if (!resourceIds.has(identity)) resourceIds.set(identity, resourceIds.size + 1);
    return { id: resourceIds.get(identity)!, ...entry };
  });
  const observed = client && !retired ? exportWorkObservation(client, owner) : {
    transient: owner.categorySnapshot.work, retainedExport: { bytes: 0, allocations: 0 }, total: owner.categorySnapshot.work,
  };
  return { entries, work: observed.transient.bytes, retainedExport: observed.retainedExport, totalWork: observed.total,
    retiredExportObservation: retired ? { historicalOutputBytes: native?.lastAllocation?.exportOutputBytes ?? 0,
      workerStopped: true, remainderCreditReleased: true, coveredBytes: memory!.state.coveredBytes } : null,
    scenes: scenes.map(value => ({ id: value.id, retired: value.scene.retired, disposeCalls: value.disposeCalls,
      current: controller().scene === value.scene })), usage: owner.usage };
}
function state() {
  const value = useApp.getState(), app = controller();
  const client = app.client as unknown as { worker?: Worker; initializationId: string } | undefined;
  const recovery = (app as unknown as { documentRecovery?: { description?: RecoveryCheckpointDescription } }).documentRecovery?.description;
  return { busy: value.busy, transformPivotPending: value.transformPivotPending, error: value.error, summary: value.summary ? structuredClone(value.summary) : null,
    recovery: value.operationRecovery, recoveryCommitted: value.operationRecoveryCommitted,
    maskPublication: maskPublication ? structuredClone(maskPublication) : null,
    postPublicationLoss: postPublicationLoss ? structuredClone(postPublicationLoss) : null,
    sourceName: value.sourceName, sourceFingerprint: app.sourceFingerprint, document: { ...app.client!.revision },
    sourceWorker: workers.findLast(value => value.terminated === 0)?.id, rendererState: value.rendererState,
    authoritativeWorker: client?.worker instanceof ObservedWorker ? client.worker.observerId : null,
    clientGeneration: client?.initializationId ?? null,
    checkpoint: recovery ? { rootSha256: recovery.rootSha256, binding: structuredClone(recovery.binding),
      plan: structuredClone(recovery.plan) } : null,
    selectionActive: app.selectionActive, selectionRecovery: value.selectionRecovery,
    scene: app.scene?.kind === 'gaussian' ? observeScene(app.scene) : null, camera: [...app.camera!.state],
    deviceEpoch: requireWebGpuRenderer(app.renderer).deviceEpoch, finished, resources: resources() };
}
async function gpuBytes(buffer: GPUBuffer, size: number) {
  const device = requireWebGpuRenderer(controller().renderer).device, readback = device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(buffer, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const bytes = readback.getMappedRange().slice(0); readback.unmap(); return bytes;
  } finally { readback.destroy(); }
}
async function gpu() {
  const scene = requireGaussianScene(controller().scene);
  return { data: Array.from(new Uint8Array(await gpuBytes(scene.buffers.splats, scene.count * scene.stride))),
    masks: Array.from(new Uint32Array(await gpuBytes(scene.buffers.states, scene.count * 4))) };
}
// Independent export observer, restricted to the scalar binary PLY emitted by
// the native exporter. It does not import the application loader or packer.
function ply(bytes: ArrayBuffer) {
  const raw = new Uint8Array(bytes), marker = new TextEncoder().encode('end_header\n'); let offset = -1;
  for (let first = 0; first <= raw.length - marker.length; first++) {
    if (marker.every((value, index) => raw[first + index] === value)) { offset = first + marker.length; break; }
  }
  if (offset < 0) throw new Error('Actual native export has no PLY header.');
  const header = new TextDecoder().decode(raw.subarray(0, offset));
  if (!header.includes('format binary_little_endian 1.0')) throw new Error('Expected the actual binary native PLY export.');
  const count = Number(/element vertex (\d+)/.exec(header)?.[1]);
  const properties = [...header.matchAll(/^property (\w+) (\w+)$/gm)].map(match => ({ type: match[1], name: match[2] }));
  const sizes: Record<string, number> = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4 };
  const stride = properties.reduce((sum, property) => sum + (sizes[property.type] ?? NaN), 0);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(stride) || offset + count * stride !== raw.byteLength)
    throw new Error('Unexpected actual native PLY layout.');
  const view = new DataView(bytes);
  const records = Array.from({ length: count }, (_, index) => {
    let field = offset + index * stride;
    return properties.map(property => {
      const at = field; field += sizes[property.type];
      return property.type === 'float' || property.type === 'float32' ? view.getFloat32(at, true) : property.type === 'double' ? view.getFloat64(at, true) :
        sizes[property.type] === 1 ? view.getUint8(at) : property.type === 'uint' ? view.getUint32(at, true) : view.getInt32(at, true);
    });
  });
  return { properties: properties.map(value => value.name), records, bytes: Array.from(raw) };
}
async function snapshot(allowOwnedTools = false) {
  if (pending && finished === null) throw new Error('Do not query native state through an unresolved operation.');
  const app = controller(), client = app.client!, scene = requireGaussianScene(app.scene), chunks: Uint8Array[] = [];
  const source = await client.command({ command: 'summary' }); let masks: number[] = [];
  await client.stream(async (_first, _count, bytes) => { chunks.push(new Uint8Array(bytes)); }, bytes => { masks = Array.from(new Uint8Array(bytes)); });
  const packed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let at = 0; for (const chunk of chunks) { packed.set(chunk, at); at += chunk.byteLength; }
  const outputsAvailable = !allowOwnedTools || !source.transformSession && !source.opacitySession;
  const outputs = await Promise.all([source.visible, source.selected, source.visible - source.selected]
    .map(async (count, scope) => count && outputsAvailable ? ply(await admittedExport(client, 0, scope)) : null));
  const summary = await client.command({ command: 'summary' });
  if (!sourceOutput) throw new Error('The complete original native SH3 output was not retained.');
  return { ...state(), summary, packed: Array.from(packed), masks, gpu: await gpu(), outputs, outputsAvailable, sourceOutput, stride: scene.stride };
}
async function checkpointScene(expectedCount = 5, maximumBytes = 256 * 1024) {
  const store = (controller() as unknown as { documentRecovery?: DocumentRecoveryStore }).documentRecovery;
  if (!store) throw new Error('The actual accepted recovery owner is missing.');
  const reader = await store.openRestore(), description = reader.description;
  // Test-only independent observer of native checkpoint v1, limited to this
  // five-splat fixture. Never imports native packing/export/codec helpers and
  // never ends or replaces an owner in the actual application.
  if (description.plan.byteLength > maximumBytes) { await reader.cancel(); throw new Error('Unexpected test checkpoint size.'); }
  const bytes = new Uint8Array(description.plan.byteLength);
  try {
    while (reader.nextRange) {
      const chunk = await reader.read(reader.nextRange);
      try { bytes.set(new Uint8Array(chunk.bytes), chunk.offset); } finally { chunk.release(); }
    }
    await reader.finish();
  } finally { await reader.cancel(); }
  const view = new DataView(bytes.buffer); let at = 0;
  const take = (size: number) => {
    if (!Number.isSafeInteger(size) || size < 0 || at + size > bytes.length) throw new Error('Truncated native checkpoint observation.');
    const start = at; at += size; return bytes.subarray(start, at);
  };
  const u8 = () => take(1)[0], u32 = () => { const start = at; take(4); return view.getUint32(start, true); };
  const u64 = () => { const start = at; take(8); const value = Number(view.getBigUint64(start, true));
    if (!Number.isSafeInteger(value)) throw new Error('Invalid native checkpoint integer.'); return value; };
  // Codec 2 appends tool effective masks after the mask table; codec 3 adds a
  // per-scene duplicate range. Both stay outside the bytes compared below.
  if (new TextDecoder().decode(take(8)) !== 'SVCKPT01') throw new Error('Unsupported native checkpoint observation.');
  const codec = u32();
  if (codec < 1 || codec > 3 || u32() !== 64 || u64() !== bytes.length) throw new Error('Unsupported native checkpoint observation.');
  take(32); if (u32() !== 0) throw new Error('Unsupported native checkpoint header.');
  const flags = u32(); if (u32() !== flags) throw new Error('Mismatched native checkpoint policy.');
  const sceneCount = u32(), maskCount = u32(), currentScene = u32(), currentMask = u32();
  if (sceneCount < 1 || sceneCount > 128 || maskCount < 1 || maskCount > 128 || u8() !== 1)
    throw new Error('Invalid editable native checkpoint.');
  take((3 + 1 + 6 + 2 + 12) * 8); // counters, document, six sequences, transient IDs and attempt fences
  let records: number[][] | undefined;
  for (let scene = 1; scene <= sceneCount; scene++) {
    if (u8() !== 0) throw new Error('Expected only actual Gaussian checkpoint owners.');
    take(8 + 1 + 12 + 4); if (u8()) take(12); if (u8()) take(12 + 16 + 1 + 4);
    take(64 + 8); const degree = u32(); take(1 + 8 + 8);
    for (let text = 0; text < 3; text++) take(u32());
    const count = u32(), vertices = u32(), triangles = u32();
    if (count !== expectedCount || degree !== 3 || vertices || triangles) throw new Error('Unexpected native SH3 fixture owner.');
    if (codec >= 3 && u8()) take(8);
    const body = take(count * 144);
    if (scene === currentScene) records = Array.from({ length: count }, (_, id) => Array.from(body.subarray(id * 144, (id + 1) * 144)));
  }
  let masks: number[] | undefined;
  for (let mask = 1; mask <= maskCount; mask++) {
    const count = u32(); if (count !== expectedCount) throw new Error('Unexpected checkpoint mask size.');
    const body = take(count); if (mask === currentMask) masks = Array.from(body);
  }
  if (!records || !masks) throw new Error('The actual checkpoint current owner is missing.');
  return { rootSha256: description.rootSha256, records, masks,
    scopes: [0, 1, 2].map(scope => records!.filter((_, id) => !(masks![id] & 2) &&
      (scope === 0 || scope === 1 && (masks![id] & 1) || scope === 2 && !(masks![id] & 1)))) };
}
function toolState() {
  const value = useApp.getState(), app = controller();
  const owners = app as unknown as { alignmentViews: AlignmentViewCheckpoints; defaultAlignmentCamera(): number[] };
  return { grade: [...value.grade], appliedGrade: [...value.appliedGrade],
    colorSession: value.colorSession ? structuredClone(value.colorSession) : null,
    colorPending: app.colorPending, colorResetEnabled: app.colorResetPreviewEnabled,
    transform: value.transform ? structuredClone(value.transform) : null,
    transformParameters: structuredClone(value.transformParameters),
    transformPreview: value.transformPreview ? structuredClone(value.transformPreview) : null,
    transformPending: app.transformPending, transformDirty: app.transformDirty, transformResetEnabled: app.transformResetEnabled,
    opacity: value.opacity ? structuredClone(value.opacity) : null, opacityScale: value.opacityScale,
    opacityPreview: value.opacityPreview ? structuredClone(value.opacityPreview) : null,
    opacityPending: app.opacityPending, opacityDirty: app.opacityDirty, opacityResetEnabled: app.opacityResetEnabled,
    defaultCamera: [...owners.defaultAlignmentCamera()], background: app.camera!.background,
    checkpoints: [...owners.alignmentViews.values()].map(entry => ({ branchId: entry.branchId, frame: [...entry.frame],
      activeRoll: entry.activeRoll, defaultRoll: entry.defaultRoll, corrected: entry.corrected })) };
}
async function toolSnapshot() {
  const actual = await snapshot(true), client = controller().client!, nativeScene = await checkpointScene();
  // The current accepted 144-byte native records contain all 48 SH half
  // words, including all 45 higher coefficients. SH3 uploads remove only the
  // eight reserved covariance bytes, which independently binds this observer
  // to the live document stream rather than trusting a checkpoint root alone.
  const uploaded = nativeScene.records.flatMap(record => [...record.slice(0, 40), ...record.slice(48)]);
  if (actual.stride !== 136 || uploaded.length !== actual.packed.length ||
      uploaded.some((byte, index) => byte !== actual.packed[index]) || nativeScene.masks.some((mask, index) => mask !== actual.masks[index]))
    throw new Error('The accepted complete native SH3 owner differs from the live document stream.');
  const base = async (channel: 'colorBase' | 'transformBase' | 'opacityBase') => {
    const chunks: Uint8Array[] = []; let masks: number[] = [];
    await client.stream(async (_first, _count, bytes) => { chunks.push(new Uint8Array(bytes)); },
      bytes => { masks = Array.from(new Uint8Array(bytes)); }, channel);
    const packed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    let at = 0; for (const chunk of chunks) { packed.set(chunk, at); at += chunk.byteLength; }
    return { packed: Array.from(packed), masks };
  };
  // These are the actual native immutable tool streams. Applied owners draw
  // their GPU base plus preview; their document stream is already baked.
  return { ...actual, nativeScene, tools: toolState(), bases: {
    color: actual.summary.colorSession ? await base('colorBase') : null,
    transform: actual.summary.transformSession ? await base('transformBase') : null,
    opacity: actual.summary.opacitySession ? await base('opacityBase') : null } };
}
function previewColor(values: number[]) { controller().setGrade(values); }
async function applyColor() { if (!await controller().commitGrade()) throw new Error(useApp.getState().error ?? 'Actual color Apply was refused.'); }
async function resetColor() {
  if (!await controller().resetColorPreview() || !await controller().commitGrade())
    throw new Error(useApp.getState().error ?? 'Actual neutral Reset and color Apply were refused.');
}
function previewTransform(parameters: Partial<TransformParameters>) { controller().setTransformParameters(parameters); }
async function applyTransform() { if (!await controller().applyTransform()) throw new Error(useApp.getState().error ?? 'Actual transform Apply was refused.'); }
async function resetTransform() { if (!await controller().resetTransform()) throw new Error(useApp.getState().error ?? 'Actual transform Reset was refused.'); }
function previewOpacity(scale: number) { controller().setOpacityScale(scale); }
async function applyOpacity() { if (!await controller().applyOpacity()) throw new Error(useApp.getState().error ?? 'Actual opacity Apply was refused.'); }
async function resetOpacity() { if (!await controller().resetOpacity()) throw new Error(useApp.getState().error ?? 'Actual opacity Reset was refused.'); }
function navigateToolCamera() {
  const app = controller(), camera = [...app.camera!.state]; camera[0] += .0625; camera[9] += .125;
  app.camera!.set(camera); app.camera!.background = 'white'; app.invalidate(); return [...app.camera!.state];
}
async function command(value: SceneCommand) {
  if (!await controller().command(value)) throw new Error(useApp.getState().error ?? `Actual ${value.command} was refused.`);
}
async function load() {
  disarmReleaseTimeout();
  disarmReconstructionFault();
  disarmPressure(); pressureOwner = undefined;
  faults.length = 0; pending = undefined; finished = null; publicationRestore?.(); publicationRestore = undefined;
  maskPublication = null;
  postPublicationLoss = null;
  const app = controller(); await app.openFiles([new File([fixture()], 'operation-sh3.ply')]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().summary?.shDegree !== 3) throw new Error(useApp.getState().error ?? 'SH3 operation fixture did not open.');
  setApp({ toolsOpen: true }); observeRenderer();
  sourceOutput = ply(await admittedExport(app.client!, 0, 0));
  await command({ command: 'single', index: 4, operation: 0 }); await command({ command: 'delete' });
  await command({ command: 'single', index: 0, operation: 0 }); await command({ command: 'single', index: 2, operation: 1 });
  await command({ command: 'single', index: 1, operation: 1 }); await command({ command: 'undo' });
  clear(); return snapshot();
}
function clear() {
  if (pending && finished === null) throw new Error('Cannot erase an unresolved operation trace.');
  requests.length = 0; responses.length = 0; rawResponses.clear(); faults.length = 0; recoveryFaults.length = 0;
  timers.splice(0, timers.length, ...timers.filter(value => value.armed));
  for (const scene of scenes) scene.disposeCalls = 0;
}
function start(value: SceneCommand, configuration: Fault[] = []) {
  if (pending && finished === null) throw new Error('An operation is already pending.');
  faults.splice(0, faults.length, ...configuration.map(value => ({ ...value, used: 0 }))); finished = null;
  pending = controller().command(value).then(value => { finished = value; return value; });
  void pending.catch(() => undefined);
}
async function join() { if (!pending) throw new Error('No operation was started.'); return pending; }
function expire(kind: 'ack' | 'reconcile') {
  const name = kind === 'ack' ? 'operationAcknowledgementExpired' : 'operationReconciliationExpired';
  const timer = timers.findLast(value => value.name === name && value.armed);
  if (!timer) throw new Error(`The real ${name} clock is not armed.`);
  if (timer.delay !== (kind === 'ack' ? 30_000 : 10_000)) throw new Error('The actual operation bound changed.');
  const callback = timerCallbacks.get(timer.id); if (!callback) throw new Error('The real timer callback was lost.');
  nativeClearTimeout(timer.id); timerCallbacks.delete(timer.id); timer.armed = false; timer.expired = true; callback();
}
function release(index: number, copies = 1) {
  const response = rawResponses.get(index); if (!response) throw new Error('No genuine response was retained.');
  for (let copy = 0; copy < copies; copy++) response.worker.replay(response.data);
}
function trace() { return { requests: structuredClone(requests), responses: structuredClone(responses), faults: structuredClone(faults), recoveryFaults: structuredClone(recoveryFaults),
  timers: structuredClone(timers), workers: structuredClone(workers) }; }
function wireFaults(configuration: WireFault[]) {
  if (configuration.length > 8 || configuration.some(value => !['request', 'response'].includes(value.direction) ||
      !['hold', 'drop'].includes(value.effect) || !/^(?:recovery-[a-z-]+|operation|operation-result)$/.test(value.type) ||
      value.remaining !== undefined && (!Number.isInteger(value.remaining) || value.remaining < 1 || value.remaining > 4)))
    throw new Error('Invalid bounded worker recovery fault.');
  recoveryFaults.splice(0, recoveryFaults.length, ...configuration.map(value => ({ ...value, used: 0 })));
}
function failWorker(id = state().authoritativeWorker) {
  if (id === null) throw new Error('The authoritative worker is not live.');
  const worker = workerInstances.get(id);
  if (!worker || workers[id - 1].terminated > 0) throw new Error('The requested authoritative worker is already retired.');
  worker.fail();
}
async function unfinishedDraft() {
  const app = controller();
  if (!app.beginSelectionGesture()) throw new Error('The real selection gesture did not begin.');
  const selection = (app as unknown as { selection?: { session: { update(command: SceneCommand): void; flush(): Promise<void> } } }).selection;
  if (!selection) throw new Error('The actual selection session is missing.');
  selection.session.update({ command: 'single', index: 1, operation: 1 }); await selection.session.flush();
  if (!useApp.getState().summary?.selectionDraft) throw new Error('The actual native selection draft was not published.');
  return state();
}
function armPostPublicationLoss() {
  if (publicationRestore) throw new Error('A publication fault is already installed.');
  const app = controller(), scene = requireGaussianScene(app.scene), renderer = requireWebGpuRenderer(app.renderer), client = app.client!;
  const original = scene.dispose.bind(scene);
  const observed: PostPublicationLoss = { calls: 0, oldScene: observeScene(scene), oldWorker: state().authoritativeWorker,
    oldDeviceEpoch: renderer.deviceEpoch, oldBorrowersJoined: false, oldRetired: false,
    publishedScene: null, publishedWorker: null, publishedGeneration: null, publishedDeviceEpoch: null,
    lossJoined: false, lossReason: null };
  postPublicationLoss = observed;
  scene.dispose = async (...args) => {
    scene.dispose = original; publicationRestore = undefined; observed.calls++;
    // Retire the actual old scene and join its real GPU borrowers first. The
    // restoration caller remains suspended at this exact retirement boundary.
    await original(...args); observed.oldBorrowersJoined = true; observed.oldRetired = scene.retired;
    const current = controller();
    if (current.scene === scene || current.renderer === renderer || current.client === client || !current.renderer || !current.scene)
      throw new Error('The retirement fault did not follow publication of a fresh native and GPU authority.');
    const published = state();
    observed.publishedScene = published.scene; observed.publishedWorker = published.authoritativeWorker;
    observed.publishedGeneration = published.clientGeneration; observed.publishedDeviceEpoch = current.renderer.deviceEpoch;
    const device = current.renderer.device;
    device.destroy();
    const lost = await device.lost; observed.lossJoined = true; observed.lossReason = lost.reason;
  };
  publicationRestore = () => { scene.dispose = original; };
}
function startupCore() {
  const client = (controller() as unknown as { bootstrapClient?: CoreClient }).bootstrapClient;
  if (!client) return null;
  const observed = client as unknown as { worker?: Worker; initializationId: string }, worker = observed.worker;
  return { worker: worker instanceof ObservedWorker ? worker.observerId : null,
    generation: observed.initializationId, failed: client.failed, memory: client.nativeMemory ? { ...client.nativeMemory.state } : null };
}
function pressure() {
  const owner = pressureOwner; if (!owner) return null;
  const app = controller(), value = useApp.getState(), client = app.client as unknown as { worker?: Worker; initializationId: string } | undefined;
  const recovery = (app as unknown as { documentRecovery?: DocumentRecoveryStore }).documentRecovery?.description;
  return { ...structuredClone(owner.observation), oldCreditBytes: resourceCreditBytes(resourceLeaseCredit(owner.oldLease)) ?? null,
    oldHistoryBytes: owner.oldHistory ? resourceCreditBytes(resourceLeaseCredit(owner.oldHistory)) ?? null : null,
    oldRetired: owner.oldScene.retired, resources: resources(), current: { ready: value.ready, busy: value.busy,
      rendererState: value.rendererState, recovery: value.operationRecovery, error: value.error,
      hasClient: !!app.client, hasScene: !!app.scene, hasRenderer: !!app.renderer,
      worker: client?.worker instanceof ObservedWorker ? client.worker.observerId : null,
      generation: client?.initializationId ?? null, checkpoint: recovery?.rootSha256 ?? null,
      bootstrap: startupCore(),
      summary: value.summary ? structuredClone(value.summary) : null } };
}
function armPressure(mode: 'recoverable' | 'insufficient') {
  if (pressureOwner || publicationRestore || !['recoverable', 'insufficient'].includes(mode)) throw new Error('A pressure owner is already installed or invalid.');
  const app = controller(), oldClient = app.client!, oldScene = requireGaussianScene(app.scene), queue = requireWebGpuRenderer(app.renderer).device.queue;
  const leases = app as unknown as { releaseScene: ResourceLease; releaseHistory?: ResourceLease };
  const oldLease = leases.releaseScene, oldHistory = leases.releaseHistory, budget = ledger();
  const observation: PressureObservation = { mode, limit: budget.limit, oldWorker: state().authoritativeWorker,
    oldScene: observeScene(oldScene), oldAllocationBytes: oldScene.allocationBytes, fillerBytes: 0, fillerHeld: false, deficit: 0,
    attempts: [], retirementCalls: 0, queueFenceJoined: false, borrowerReleased: false, retirementJoined: false,
    destroyedBuffers: 0, bufferCount: 0 };
  let release!: () => void; const borrower = new Promise<void>(resolve => { release = resolve; });
  const queueDone = queue.onSubmittedWorkDone.bind(queue), dispose = oldScene.dispose.bind(oldScene);
  const wrappedDone = async () => {
    await queueDone();
    if (observation.retirementCalls) { observation.queueFenceJoined = true; await borrower; }
    return undefined;
  };
  queue.onSubmittedWorkDone = wrappedDone;
  const wrappedDispose = async (...args: Parameters<GpuScene['dispose']>) => {
    observation.retirementCalls++; await dispose(...args); observation.retirementJoined = true;
  };
  oldScene.dispose = wrappedDispose;
  const destroyHooks = [...Object.values(oldScene.buffers), ...(oldScene as unknown as { params: GPUBuffer[] }).params].map(buffer => {
    const original = buffer.destroy.bind(buffer), wrapped = () => { observation.destroyedBuffers++; original(); return undefined; };
    buffer.destroy = wrapped; return () => { if (buffer.destroy === wrapped) buffer.destroy = original; };
  });
  observation.bufferCount = destroyHooks.length;
  type CoverageMethod = (this: CoreClient, updates: readonly NativeCoverageUpdate[]) => void;
  const prototype = Object.getPrototypeOf(oldClient) as { updateNativeCoverage: CoverageMethod }, original = prototype.updateNativeCoverage;
  const completed = new Set<CoreClient>();
  const wrappedCoverage: CoverageMethod = function(updates) {
    const internals = this as unknown as { worker?: Worker; nativeMemory?: NativeHeapAccounting; initializationId: string };
    const worker = internals.worker instanceof ObservedWorker ? internals.worker.observerId : null;
    const imported = worker !== null && responses.some(row => row.worker === worker && row.type === 'recovery-result' && row.data.action === 'restore' && row.delivered);
    if (this === oldClient || completed.has(this) || !imported || updates.length !== 2 || updates.some(update => update.lease.bytes !== 0)) return original.call(this, updates);
    const native = internals.nativeMemory?.state;
    if (!native?.observed || native.retired || native.coveredBytes !== 0 || worker === null || observation.limit !== budget.limit)
      throw new Error('The actual imported native coverage boundary changed.');
    const requiredDelta = updates.reduce((sum, update) => sum + update.nextLeaseBytes - update.lease.bytes, 0) +
      Math.max(0, native.heapBytes - updates.reduce((sum, update) => sum + update.nativeBytes, 0)) - native.remainderBytes;
    if (!observation.attempts.length) {
      const gpuBytes = resourceCreditBytes(resourceLeaseCredit(oldLease));
      if (gpuBytes !== observation.oldAllocationBytes || requiredDelta <= gpuBytes || oldScene.retired) throw new Error('Unexpected real old GPU coverage.');
      observation.deficit = mode === 'recoverable' ? Math.max(1, Math.floor(gpuBytes / 2)) : gpuBytes + 1;
      const availableBytes = requiredDelta - observation.deficit, fillerBytes = budget.limit - budget.usage.bytes - availableBytes;
      if (availableBytes < 0 || fillerBytes <= 0) throw new Error('The bounded admission-pressure fixture no longer fits.');
      pressureOwner!.filler = budget.reserve('work', fillerBytes); observation.fillerBytes = fillerBytes; observation.fillerHeld = true;
    }
    const attempt: CoverageAttempt = { worker, generation: internals.initializationId, requiredDelta,
      availableBytes: budget.limit - budget.usage.bytes, beforeBytes: budget.usage.bytes, afterBytes: budget.usage.bytes,
      oldCreditBytes: resourceCreditBytes(resourceLeaseCredit(oldLease)) ?? null, oldRetired: oldScene.retired,
      retirementJoined: observation.retirementJoined, outcome: 'pending', admissionError: false, error: null };
    observation.attempts.push(attempt);
    try { original.call(this, updates); attempt.outcome = 'accepted'; completed.add(this); }
    catch (error) { attempt.outcome = 'refused'; attempt.admissionError = error instanceof AdmissionError; attempt.error = String(error); throw error; }
    finally { attempt.afterBytes = budget.usage.bytes; }
  };
  prototype.updateNativeCoverage = wrappedCoverage;
  pressureOwner = { observation, oldScene, oldLease, oldHistory,
    releaseBorrower() { observation.borrowerReleased = true; release(); },
    restore() { release(); if (prototype.updateNativeCoverage === wrappedCoverage) prototype.updateNativeCoverage = original;
      if (queue.onSubmittedWorkDone === wrappedDone) queue.onSubmittedWorkDone = queueDone;
      if (oldScene.dispose === wrappedDispose) oldScene.dispose = dispose; for (const restore of destroyHooks) restore(); } };
  return pressure();
}
function releasePressureBorrower() { if (!pressureOwner) throw new Error('No real pressure borrower exists.'); pressureOwner.releaseBorrower(); }
function releasePressureCredit() { const owner = pressureOwner; if (!owner) throw new Error('No pressure credit exists.'); owner.filler?.(); owner.filler = undefined; owner.observation.fillerHeld = false; }
function disarmPressure() { if (pressureOwner) { releasePressureCredit(); pressureOwner.restore(); } }
async function closePressure() {
  await controller().closeScene(); if (useApp.getState().navigationPrompt) await controller().discardAndContinue(); return pressure();
}
function refusePublication() {
  const queue = requireWebGpuRenderer(controller().renderer).device.queue, original = queue.onSubmittedWorkDone.bind(queue); let failed = false;
  queue.onSubmittedWorkDone = async () => { await original(); if (!failed) { failed = true; throw new Error('Operation fixture refused publication after actual GPU completion.'); } };
  publicationRestore = () => { queue.onSubmittedWorkDone = original; };
}
function refuseMaskPublication() {
  if (publicationRestore) throw new Error('A publication fault is already installed.');
  const scene = requireGaussianScene(controller().scene), original = scene.stageMasks.bind(scene);
  const observed = { calls: 0, afterCommit: false, owner: null as unknown }; maskPublication = observed;
  scene.stageMasks = async bytes => {
    const actual = await original(bytes), publish = actual.publish.bind(actual);
    scene.stageMasks = original; publicationRestore = undefined;
    actual.publish = () => {
      observed.calls++;
      const terminal = responses.findLast(response => response.action === 'commit' && response.delivered && response.type === 'operation-result');
      const receipt = terminal?.data.receipt as Wire | undefined, summary = terminal?.data.summary as Wire | undefined;
      if (receipt?.outcome !== 'committed' || summary?.transaction !== false)
        throw new Error('The mask publication fault did not follow an actual native commit.');
      observed.afterCommit = true; observed.owner = structuredClone(receipt.owner);
      if (observed.calls === 1) throw new Error('Operation fixture refused staged mask publication after native commit.');
      return publish();
    };
    return actual;
  };
  publicationRestore = () => { scene.stageMasks = original; };
}
async function retry() {
  return (controller() as unknown as { retryOperationRecovery(): Promise<boolean> }).retryOperationRecovery();
}
async function blocked() {
  const before = state(), accepted = await controller().command({ command: 'selectAll' });
  let captureError: string | null = null; try { await controller().capture('image/png'); } catch (error) { captureError = String(error); }
  await controller().exportScene(0, 0);
  await controller().openFiles([new File([fixture()], 'operation-replacement.ply')]);
  return { before, after: state(), accepted, captureError };
}
async function loseDevice() { const device = requireWebGpuRenderer(controller().renderer).device; device.destroy(); await device.lost; }
async function recoverGraphics() { return controller().retryRenderer(); }

function releaseWatchdog(callback: TimerHandler, delay?: number): RecoveryWatchdogObservation | undefined {
  const owner = releaseTimeoutOwner;
  if (!owner || delay !== 60_000 || typeof callback !== 'function' ||
      !Function.prototype.toString.call(callback).includes('The recovery checkpoint transfer did not finish in time.')) return;
  const pending = (owner.client as unknown as { pending: Map<number, { family: string; recovery?: { kind: string; id: string } }> }).pending;
  const entry = [...pending].find(([, value]) => value.family === 'recovery-export' && value.recovery?.kind === 'export');
  if (!entry) return;
  const [requestId, transfer] = entry, recoveryId = transfer.recovery!.id;
  if (owner.observation.requestId !== null && (requestId !== owner.observation.requestId || recoveryId !== owner.observation.recoveryId)) return;
  const observation: RecoveryWatchdogObservation = { id: 0, requestId, recoveryId, delay, requestedAt: performance.now(),
    armed: true, suppressedAt: null, clearedAt: null };
  owner.observation.watchdogs.push(observation); return observation;
}
function holdTimedRelease(worker: number, data: Wire): boolean {
  const owner = releaseTimeoutOwner; if (!owner || worker !== owner.observation.worker) return false;
  const value = owner.observation;
  if (data.type === 'recovery-export' && value.requestId === null) {
    value.requestId = Number(data.requestId); value.recoveryId = String(data.recoveryId);
  }
  if (data.type !== 'recovery-release' || data.requestId !== value.requestId || data.recoveryId !== value.recoveryId || value.heldAt !== null) return false;
  const description = (controller() as unknown as { documentRecovery?: DocumentRecoveryStore }).documentRecovery?.description;
  if (!description) throw new Error('The accepted successor must precede release dispatch.');
  value.heldAt = performance.now(); value.decision = { rootSha256: description.rootSha256,
    binding: structuredClone(description.binding), plan: structuredClone(description.plan) };
  // A release has no payload. Do not retain its callback, transfer options or
  // a source/checkpoint buffer merely to withhold this genuine control.
  return true;
}
function observeReleaseTimeoutResponse(worker: number, data: Wire) {
  const value = releaseTimeoutOwner?.observation;
  if (value && worker === value.worker && data.requestId === value.requestId && data.type === 'error' && !value.error)
    value.error = { receivedAt: performance.now(), response: structuredClone(data) };
}
function armReleaseTimeout() {
  if (releaseTimeoutOwner || reconstructionFault || publicationRestore || pressureOwner) throw new Error('A recovery observer already owns this boundary.');
  const app = controller(), client = app.client!, scene = requireGaussianScene(app.scene), worker = state().authoritativeWorker;
  if (worker === null) throw new Error('The original native worker must be live.');
  releaseTimeoutOwner = { client, scene, lease: (app as unknown as { releaseScene: ResourceLease }).releaseScene,
    observation: { worker, oldScene: observeScene(scene), requestId: null, recoveryId: null, heldAt: null, decision: null, error: null, watchdogs: [] } };
  return releaseTimeout();
}
function releaseTimeout() {
  const owner = releaseTimeoutOwner; if (!owner) throw new Error('No release-timeout observer is armed.');
  const client = owner.client as unknown as { fault?: Error };
  return { ...structuredClone(owner.observation), oldRetired: owner.scene.retired,
    oldCreditBytes: resourceCreditBytes(resourceLeaseCredit(owner.lease)) ?? null,
    oldNativeMemory: owner.client.nativeMemory ? { ...owner.client.nativeMemory.state } : null,
    oldFailure: client.fault?.message ?? null, current: state() };
}
function disarmReleaseTimeout() {
  const owner = releaseTimeoutOwner; if (!owner) return;
  for (const timer of owner.observation.watchdogs) if (timer.armed) {
    nativeClearTimeout(timer.id); timer.armed = false; timer.clearedAt = performance.now();
  }
  releaseTimeoutOwner = undefined;
}
function sendForeignRecoveryControls() {
  const owner = reconstructionOwner, value = reconstructionFault, held = owner?.held;
  if (!owner || !value || value.mode !== 'range' || !held || value.candidate === null || held.message.type !== 'recovery-range')
    throw new Error('A genuine live replacement range must remain held.');
  const original = held.message, envelope: Wire = {};
  for (const key of ['protocolVersion','buildId','requestId','base','assetBase','recoveryId'])
    if (Object.hasOwn(original,key)) envelope[key] = structuredClone(original[key]);
  const base = original.base as { documentId: string; sourceGeneration: number };
  const controls = [
    { gate: 'foreign-recovery-id', message: { ...envelope, type: 'recovery-release', recoveryId: crypto.randomUUID() } },
    { gate: 'foreign-request-id', message: { ...envelope, type: 'recovery-release', requestId: Number(original.requestId) + 1 } },
    { gate: 'foreign-operation-owner', message: { ...envelope, type: 'recovery-release', operationOwner: { version: 1,
      documentId: base.documentId, sourceGeneration: base.sourceGeneration, clientGeneration: crypto.randomUUID(), operationId: 1 } } },
  ];
  // These are explicitly untrusted control inputs, not invented native
  // replies. FIFO order places them before the original authentic range.
  const sent = controls.map(({ gate,message }) => {
    const data = message as Wire;
    requests.push({ worker: value.candidate!, requestId: Number(data.requestId), type: String(data.type), action: null,
      command: null, forwarded: true, altered: true, data: structuredClone(data) });
    held.worker.forwardHeld(data); return { gate, worker: value.candidate!, sentAt: performance.now(), data: structuredClone(data) };
  });
  return { controls: sent, heldPayloadRetained: !!owner.held, candidate: value.candidate, requestId: original.requestId, recoveryId: original.recoveryId };
}

// Bounded faults for unpublished reconstruction. Payloads in these traces are
// compact observations; the sole accepted checkpoint is never edited or kept
// alive by the observer. A held range retains only the real in-flight copy.
function fnv1a(bytes: Uint8Array) {
  let value = 0x811c9dc5; for (const byte of bytes) value = Math.imul(value ^ byte, 0x01000193);
  return (value >>> 0).toString(16).padStart(8, '0');
}
async function exactHash(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}
function evidenceWire(data: Wire): Wire {
  if ((!reconstructionFault && !releaseTimeoutOwner) || !(data.bytes instanceof ArrayBuffer)) return structuredClone(data);
  return structuredClone({ ...data, bytes: { byteLength: data.bytes.byteLength, fnv1a32: fnv1a(new Uint8Array(data.bytes)) } });
}
function observeReconstructionResponse(worker: number, data: Wire): boolean {
  const value = reconstructionFault, owner = reconstructionOwner;
  if (!value || !owner) return false;
  if (value.mode === 'admission' && data.type === 'recovery-plan' && worker === value.oldWorker && !owner.filler) {
    const available = ledger().limit - ledger().usage.bytes;
    if (available <= 1) throw new Error('No genuine checkpoint admission filler fits.');
    owner.filler = ledger().reserve('work', available - 1); value.fillerBytes = owner.filler.bytes;
  }
  if (worker !== value.candidate) return false;
  if (data.type === 'recovery-range-consumed') value.consumed.push(Number(data.index));
  if (data.type === 'error') {
    // Cancellation/failed native cleanup can no longer consume this request.
    // Drop the observer's aliases before CoreClient joins/detaches its sole
    // admitted copy; never retain a byte payload after its credit returns.
    owner.held = undefined;
    value.errors.push({ worker, message: String(data.error), cancelled: data.cancelled === true, cleanupFailed: data.cleanupFailed === true });
    if (owner.holdCancellation && data.cancelled === true) {
      owner.holdCancellation = false; value.cancellationHeld = true; return true;
    }
  }
  return false;
}
function injectReconstructionRequest(worker: number, data: Wire): { message: Wire; hold: boolean; altered: boolean } {
  const value = reconstructionFault, owner = reconstructionOwner;
  if (!value || !owner) return { message: data, hold: false, altered: false };
  if (data.type === 'recovery-restore' && value.candidate === null) {
    value.candidate = worker;
    value.heldEntries = resources().entries;
    if (value.mode === 'core' || value.mode === 'source-generation') {
      const changed = structuredClone(data), binding = changed.binding as { core: { nativeInputId: string }; revision: { sourceGeneration: number } };
      const before = value.mode === 'core' ? binding.core.nativeInputId : binding.revision.sourceGeneration;
      if (value.mode === 'core') binding.core.nativeInputId = `${binding.core.nativeInputId[0] === '0' ? '1' : '0'}${binding.core.nativeInputId.slice(1)}`;
      else binding.revision.sourceGeneration++;
      const after = value.mode === 'core' ? binding.core.nativeInputId : binding.revision.sourceGeneration;
      value.mutation = { field: value.mode === 'core' ? 'binding.core.nativeInputId' : 'binding.revision.sourceGeneration',
        offset: null, length: 0, beforeSha256: null, afterSha256: null, before, after };
      return { message: changed, hold: false, altered: true };
    }
  }
  if (data.type !== 'recovery-range' || worker !== value.candidate) return { message: data, hold: false, altered: false };
  if ((value.mode === 'range' || value.mode === 'admission') && !owner.held && !value.rangeHeld && data.index === value.rangeIndex) {
    value.rangeHeld = true; value.heldEntries = resources().entries;
    return { message: data, hold: true, altered: false };
  }
  if ((value.mode === 'header' || value.mode === 'payload') && !value.mutation && data.index === 0) {
    if (!(data.bytes instanceof ArrayBuffer) || data.bytes.byteLength <= 64) throw new Error('The genuine checkpoint range is missing.');
    const bytes = new Uint8Array(data.bytes), offset = value.mode === 'header' ? 0 : 64;
    const before = bytes[offset], beforeCopy = data.bytes.slice(0); bytes[offset] ^= 1;
    const mutation = { field: value.mode, offset, length: bytes.length, beforeSha256: null as string | null,
      afterSha256: null as string | null, before, after: bytes[offset] };
    value.mutation = mutation; value.heldEntries = resources().entries;
    // Digest copies are bounded to this five-record fixture and released by
    // Web Crypto settlement. The actual original transfer proceeds unchanged.
    void Promise.all([exactHash(beforeCopy), exactHash(data.bytes.slice(0))]).then(([beforeHash, afterHash]) => {
      mutation.beforeSha256 = beforeHash; mutation.afterSha256 = afterHash;
    });
    return { message: data, hold: false, altered: true };
  }
  return { message: data, hold: false, altered: false };
}
function reconstruction() {
  const value = reconstructionFault, owner = reconstructionOwner;
  if (!value || !owner) throw new Error('No reconstruction fault is armed.');
  const app = controller(), state = useApp.getState();
  const client = app.client as unknown as { worker?: Worker; initializationId: string } | undefined;
  const description = (app as unknown as { documentRecovery?: DocumentRecoveryStore }).documentRecovery?.description;
  return { ...structuredClone(value), fillerHeld: !!owner.filler, heldPayloadRetained: !!owner.held,
    oldCreditBytes: resourceCreditBytes(resourceLeaseCredit(owner.oldLease)) ?? null, oldRetired: owner.oldScene.retired,
    candidateMemory: owner.candidateClient?.nativeMemory ? { ...owner.candidateClient.nativeMemory.state } : null,
    candidateFailed: owner.candidateClient?.failed ?? null, resources: resources(), originalEntryIds: [...owner.originalEntries],
    current: { ready: state.ready, busy: state.busy, recovery: state.operationRecovery, rendererState: state.rendererState,
      error: state.error, hasClient: !!app.client, hasRenderer: !!app.renderer, scene: app.scene?.kind === 'gaussian' ? observeScene(app.scene) : null,
      worker: client?.worker instanceof ObservedWorker ? client.worker.observerId : null, generation: client?.initializationId ?? null,
      document: app.client ? { ...app.client.revision } : null, checkpoint: description ? structuredClone(description) : null,
      summary: state.summary ? structuredClone(state.summary) : null, bootstrap: startupCore() } };
}
function armReconstructionFault(mode: ReconstructionMode, rangeIndex = 0) {
  if (reconstructionFault || publicationRestore || pressureOwner || !['header', 'payload', 'range', 'gpu', 'source-generation', 'core', 'admission'].includes(mode) ||
      ![0, 1].includes(rangeIndex)) throw new Error('Invalid or overlapping reconstruction fault.');
  const app = controller(), oldClient = app.client!, oldScene = requireGaussianScene(app.scene), oldRenderer = requireWebGpuRenderer(app.renderer);
  const oldLease = (app as unknown as { releaseScene: ResourceLease }).releaseScene;
  reconstructionFault = { mode, rangeIndex, oldWorker: state().authoritativeWorker, oldScene: observeScene(oldScene), candidate: null,
    rangeHeld: false, consumed: [], errors: [], mutation: null, heldEntries: [], fillerBytes: 0, admission: null, gpu: null,
    closeStarted: false, closeSettled: false, cancellationHeld: false };
  const owner = reconstructionOwner = { oldClient, oldScene, oldLease, originalEntries: new Set(resources().entries.map(entry => entry.id)),
    restore: [] as (() => void)[], holdCancellation: false } as NonNullable<typeof reconstructionOwner>;
  const prototype = Object.getPrototypeOf(oldClient) as CoreClient, restore = prototype.restoreRecoveryCheckpoint;
  const wrappedRestore: CoreClient['restoreRecoveryCheckpoint'] = function(this: CoreClient, ...args) {
    owner.candidateClient ??= this; return restore.apply(this, args);
  };
  prototype.restoreRecoveryCheckpoint = wrappedRestore;
  owner.restore.push(() => { if (prototype.restoreRecoveryCheckpoint === wrappedRestore) prototype.restoreRecoveryCheckpoint = restore; });
  if (mode === 'admission') {
    const budget = ledger(), reserve = budget.reserve.bind(budget);
    const wrappedReserve: ResourceLedger['reserve'] = (category, bytes) => {
      try { return reserve(category, bytes); }
      catch (error) {
        if (category === 'recovery' && owner.filler && !reconstructionFault!.admission)
          reconstructionFault!.admission = { requested: bytes, available: budget.limit - budget.usage.bytes,
            genuine: error instanceof AdmissionError, message: String(error) };
        throw error;
      }
    };
    budget.reserve = wrappedReserve;
    owner.restore.push(() => { if (budget.reserve === wrappedReserve) budget.reserve = reserve; });
  }
  if (mode === 'gpu') {
    const rendererPrototype = Object.getPrototypeOf(oldRenderer) as GaussianRenderer, allocate = rendererPrototype.allocateScene;
    const wrappedAllocate: GaussianRenderer['allocateScene'] = async function(this: GaussianRenderer, ...args) {
      const scene = await allocate.apply(this, args);
      if (this === oldRenderer || reconstructionFault!.gpu) return scene;
      const observation: NonNullable<ReconstructionObservation['gpu']> = { scene: observeScene(scene), epoch: this.deviceEpoch, fenceJoined: false, lossJoined: false,
        reason: null as string | null, beforePublication: false, disposalJoined: false, buffers: 0, destroyedBuffers: 0, entries: [] as ReturnType<typeof resources>['entries'] };
      reconstructionFault!.gpu = observation;
      const queue = this.device.queue, done = queue.onSubmittedWorkDone.bind(queue), dispose = scene.dispose.bind(scene);
      queue.onSubmittedWorkDone = async () => {
        await done();
        if (observation.fenceJoined) return undefined;
        observation.fenceJoined = true;
        observation.beforePublication = controller().scene === oldScene && controller().client === oldClient && controller().renderer === oldRenderer;
        observation.entries = resources().entries;
        this.device.destroy(); const lost = await this.device.lost; observation.lossJoined = true; observation.reason = lost.reason;
        return undefined;
      };
      scene.dispose = async () => { await dispose(); observation.disposalJoined = true; };
      const buffers = [...Object.values(scene.buffers), ...(scene as unknown as { params: GPUBuffer[] }).params];
      observation.buffers = buffers.length;
      for (const buffer of buffers) {
        const destroy = buffer.destroy.bind(buffer); buffer.destroy = () => { observation.destroyedBuffers++; destroy(); return undefined; };
      }
      return scene;
    };
    rendererPrototype.allocateScene = wrappedAllocate;
    owner.restore.push(() => { if (rendererPrototype.allocateScene === wrappedAllocate) rendererPrototype.allocateScene = allocate; });
  }
  return reconstruction();
}
function releaseReconstructionFiller() {
  const owner = reconstructionOwner; if (!owner) throw new Error('No reconstruction owner exists.'); owner.filler?.(); owner.filler = undefined;
}
function releaseReconstructionRange() {
  const owner = reconstructionOwner, held = owner?.held;
  if (!held) throw new Error('No genuine reconstruction range is held.');
  owner!.held = undefined; held.evidence.forwarded = true; held.worker.forwardHeld(held.message, held.options);
}
function beginReconstructionClose() {
  const owner = reconstructionOwner, value = reconstructionFault;
  if (!owner || !value || owner.closeTask) throw new Error('No fresh reconstruction Close exists.');
  value.closeStarted = true; owner.holdCancellation = true;
  owner.closeTask = (async () => {
    await controller().closeScene(); if (useApp.getState().navigationPrompt) await controller().discardAndContinue(); value.closeSettled = true;
  })();
  void owner.closeTask.catch(() => undefined);
}
async function joinReconstructionClose() { if (!reconstructionOwner?.closeTask) throw new Error('Close was not started.'); await reconstructionOwner.closeTask; return reconstruction(); }
function disarmReconstructionFault() {
  const owner = reconstructionOwner; if (!owner) return;
  releaseReconstructionFiller(); for (const restore of owner.restore.reverse()) restore(); owner.held = undefined;
  reconstructionOwner = undefined; reconstructionFault = undefined;
}
const partialCount = 8192;
let partialSource: { properties: string[]; stride: number; body: Uint8Array<ArrayBuffer> } | undefined;
function binaryPlyView(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer), marker = new TextEncoder().encode('end_header\n'); let start = -1;
  for (let at = 0; at < Math.min(bytes.length, 16 * 1024); at++)
    if (marker.every((byte, index) => bytes[at + index] === byte)) { start = at + marker.length; break; }
  if (start < 0) throw new Error('Missing actual binary PLY header.');
  const header = new TextDecoder().decode(bytes.subarray(0, start)), count = Number(/element vertex (\d+)/.exec(header)?.[1]);
  const properties = [...header.matchAll(/^property (\w+) (\w+)$/gm)];
  const sizes: Record<string, number> = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, int: 4, uint: 4 };
  const stride = properties.reduce((sum, property) => sum + (sizes[property[1]] ?? NaN), 0);
  if (!header.includes('format binary_little_endian 1.0') || !Number.isSafeInteger(count) || !Number.isSafeInteger(stride) || start + count * stride !== bytes.length)
    throw new Error('Unexpected actual native binary PLY extent.');
  return { properties: properties.map(property => property[2]), count, stride, body: bytes.subarray(start) };
}
function partialFixture() {
  const names = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3',
    ...Array.from({ length: 45 }, (_, field) => `f_rest_${field}`)];
  const header = new TextEncoder().encode(['ply', 'format binary_little_endian 1.0', `element vertex ${partialCount}`,
    ...names.map(name => `property float ${name}`), 'end_header', ''].join('\n'));
  const bytes = new Uint8Array(header.length + partialCount * 236); bytes.set(header); const view = new DataView(bytes.buffer);
  for (let id = 0; id < partialCount; id++) {
    const values = [(id % 128 - 64) / 128, (Math.floor(id / 128) - 32) / 64, (id % 7 - 3) / 64,
      .2, -.3, .1, 1, Math.log(.01), Math.log(.015), Math.log(.02), 1, 0, 0, 0,
      ...Array.from({ length: 45 }, (_, field) => ((id % 17 + 1) * (field % 7 - 3)) / 512)];
    values.forEach((value, field) => view.setFloat32(header.length + id * 236 + field * 4, value, true));
  }
  return bytes;
}
async function loadPartialRecovery() {
  disarmReconstructionFault(); pending = undefined; finished = null;
  const input = partialFixture(), app = controller(); await app.openFiles([new File([input], 'recovery-partial-sh3.ply')]);
  if (useApp.getState().navigationPrompt) await app.discardAndContinue();
  if (useApp.getState().summary?.count !== partialCount || useApp.getState().summary?.shDegree !== 3)
    throw new Error(useApp.getState().error ?? 'The bounded multi-chunk SH3 fixture did not load.');
  setApp({ toolsOpen: true }); observeRenderer();
  const source = binaryPlyView(await admittedExport(app.client!, 0, 0));
  if (source.count !== partialCount || source.properties.filter(name => /^f_rest_\d+$/.test(name)).length !== 45)
    throw new Error('The complete original SH3 export is missing.');
  partialSource = { properties: source.properties, stride: source.stride, body: source.body.slice() };
  await command({ command: 'single', index: 4, operation: 0 }); await command({ command: 'delete' });
  await command({ command: 'single', index: 0, operation: 0 }); await command({ command: 'single', index: 2, operation: 1 });
  await command({ command: 'single', index: 1, operation: 1 }); await command({ command: 'undo' });
  clear(); return { count: partialCount, inputBytes: input.length };
}
async function compactRecoverySnapshot(firstMasks = [1, 0, 1, 0, 2]) {
  if (!partialSource || firstMasks.length !== 5) throw new Error('The compact recovery fixture was not initialized.');
  const app = controller(), client = app.client!, scene = requireGaussianScene(app.scene);
  const expectedMasks = new Uint8Array(partialCount); expectedMasks.set(firstMasks);
  const packed = new Uint8Array(partialCount * scene.stride); let actualMasks = new Uint8Array(0);
  await client.stream(async (first, count, bytes) => {
    if (bytes.byteLength !== count * scene.stride) throw new Error('Invalid actual compact stream range.'); packed.set(new Uint8Array(bytes), first * scene.stride);
  }, bytes => { actualMasks = new Uint8Array(bytes); });
  const native = await checkpointScene(partialCount, 8 * 1024 * 1024), nativeBytes = Uint8Array.from(native.records.flat());
  const nativePacked = new Uint8Array(partialCount * 136);
  native.records.forEach((record, index) => { nativePacked.set(record.slice(0, 40), index * 136); nativePacked.set(record.slice(48), index * 136 + 40); });
  const scopeIds = [0, 1, 2].map(scope => Array.from(expectedMasks, (mask, id) => !(mask & 2) &&
    (scope === 0 || scope === 1 && (mask & 1) || scope === 2 && !(mask & 1)) ? id : -1).filter(id => id >= 0));
  const outputs = [];
  for (let scope = 0; scope < 3; scope++) {
    const ids = scopeIds[scope], expected = new Uint8Array(ids.length * partialSource.stride);
    ids.forEach((id, index) => expected.set(partialSource!.body.subarray(id * partialSource!.stride, (id + 1) * partialSource!.stride), index * partialSource!.stride));
    if (!ids.length) { outputs.push({ count: 0, sha256: null, expectedSha256: null, properties: partialSource.properties }); continue; }
    const actual = binaryPlyView(await admittedExport(client, 0, scope));
    outputs.push({ count: actual.count, sha256: await exactHash(actual.body), expectedSha256: await exactHash(expected), properties: actual.properties });
  }
  const gpuData = await gpuBytes(scene.buffers.splats, partialCount * scene.stride), gpuMasks = await gpuBytes(scene.buffers.states, partialCount * 4);
  const summary = await client.command({ command: 'summary' });
  return { ...state(), summary, count: partialCount, stride: scene.stride,
    packedSha256: await exactHash(packed), gpuSha256: await exactHash(gpuData), nativePackedSha256: await exactHash(nativePacked),
    masksSha256: await exactHash(actualMasks), expectedMasksSha256: await exactHash(expectedMasks),
    gpuMasksSha256: await exactHash(gpuMasks), expectedGpuMasksSha256: await exactHash(Uint32Array.from(expectedMasks).buffer),
    nativeSha256: await exactHash(nativeBytes), nativeMasksSha256: await exactHash(Uint8Array.from(native.masks)),
    scopeCounts: scopeIds.map(ids => ids.length), outputs };
}
const harness = { ready: () => window.geometryViewer?.ready() ?? false, state, snapshot, gpu, load, command, start, join, expire, release, trace,
  clear, retry, blocked, refusePublication, refuseMaskPublication, loseDevice, recoverGraphics,
  wireFaults, failWorker, unfinishedDraft, armPostPublicationLoss,
  toolState, toolSnapshot, previewColor, applyColor, resetColor, previewTransform, applyTransform, resetTransform,
  previewOpacity, applyOpacity, resetOpacity, navigateToolCamera,
  pressure, armPressure, releasePressureBorrower, releasePressureCredit, disarmPressure, closePressure, resources, startupCore,
  reconstruction, armReconstructionFault, releaseReconstructionFiller, releaseReconstructionRange,
  beginReconstructionClose, joinReconstructionClose, disarmReconstructionFault, loadPartialRecovery, compactRecoverySnapshot,
  armReleaseTimeout, releaseTimeout, disarmReleaseTimeout, sendForeignRecoveryControls,
  translation: () => ({ command: 'transform', matrix: [...translate], selectedOnly: false } as SceneCommand) };
declare global { interface Window { operationHarness: typeof harness } }
window.operationHarness = harness;
