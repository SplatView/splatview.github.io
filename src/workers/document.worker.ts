/// <reference lib="webworker" />
import { requireWorkerProductCommand } from '../app/productPolicy';
import { BUILD_ID, PROTOCOL_VERSION, type Envelope, type InitializedWorkerTelemetry, type NativeAllocationSnapshot, type NativeSummary,
  type WorkerRequest, type WorkerResponse } from '../document/types';
import { loadCore, wasmString, type WasmModule } from './wasm';
import { validateMapEnvelope, validateSelectionMapDescriptor } from '../document/selectionMap';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import type { WorkerBootstrapResponse, WorkerInitialize } from '../build/bootstrap';
import { assertBuildDescriptor, canonicalJson, validateManifest } from '../build/verification';
import { nativeModuleIdentity } from '../build/native';
import { livePreviewOutcome } from '../document/livePreview';
import { isDuplicateCommand, sameDuplicateRange, validateDuplicateSummary } from '../document/duplicateProtocol';
import { geometryChannelCount, geometryChunkCount, geometryDescriptor, geometryHeapChunk, sameGeometryDescriptor,
  validateGeometryDescriptor, type GeometryChannel } from '../document/geometry';
import { sourceWorkerBytes, validateSourceDescriptor, validateSourceFingerprint, validateSourceRange,
  type SourceDescriptor, type SourceRange, type SourceReadDescriptor } from '../document/source';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupNativeStageBytes, groupTransferBytes, groupWorkerBytes,
  validateGroupSourceDescriptor, validateGroupSourceFingerprint } from '../document/sourceGroup';
import { ResourceLedger, type ResourceLease } from '../document/resources';
import { assertSceneInputBytes, assertSourceFitsDecodeBudget } from '../document/sceneInputLimits';
import { finishSourceFingerprint } from '../io/fingerprint';
import { stageSingleSourceInput, type SourceInputChunk, type StagedSourceInput } from './sourceInput';
import { stageGroupSourceInput, type StagedGroupSourceInput } from './groupSourceInput';
import { NativeHeapSampler } from '../document/nativeMemory';
import { validateNativeAllocationCensus, type NativeAllocationCensus } from '../document/allocationCensus';
import { NativeSummaryQuery } from './summaryQuery';
import { pumpEdit } from './editPump';
import { validateSceneExportPlan, validateSpz4ExportPlan } from '../document/spz4Export';
import { isAdmittedSceneExportFormat } from '../document/exportFormats';
import { sameColorBase, validateColorBaseIdentity, validateColorSession } from '../document/colorProtocol';
import { validateAlignmentSummary } from '../document/alignmentProtocol';
import { validateFloorSummary } from '../document/floorProtocol';
import { assertFilterResponse, assertFilterUnchanged, captureFilterRequest, captureFilterState, captureSelectionFilterCommand,
  filterSummaryState, FilterOperation, isFilterCommandName, isSelectionFilterCommand, validateFilterSummary, type FilterRequestProof } from '../document/filterProtocol';
import { assertTransformResponse, assertTransformUnchanged, captureTransformCommand, captureTransformRequest, captureTransformState,
  isTransformCommand, TRANSFORM_COMMANDS, sameTransformBase, TransformOperation, validateTransformBaseIdentity,
  validateTransformSummary, type TransformRequestProof } from '../document/transformProtocol';
import { assertTransformFocusBinding, assertTransformFocusUnchanged, captureTransformFocusState,
  transformFocusPoint, validateSelectionCommitRevision, validateTransformFocusCommand, type TransformFocusState } from '../document/transformPivot';
import { isOpacityCommand, OPACITY_COMMANDS, sameOpacityBase, validateOpacityBaseIdentity, validateOpacitySummary } from '../document/opacityProtocol';
import { captureSelectionViewCommand, isBeginColorCommand } from '../document/selectionView';
import { isMorphologyRangeCommand, isSelectionMorphologyCommand, validateMorphologyRange } from '../input/selectionMorphology';
import { assertOperationSummary, sameOperationOwner, validateOperationOwner, validateOperationReceipt, validateOperationScope,
  type OperationOwner, type OperationScope } from '../document/operationProtocol';
import { assertRecoveryCheckpointBinding, validateRecoveryCheckpointPlan, type RecoveryCheckpointBinding,
  type RecoveryCheckpointPlan, type RecoveryCheckpointRange } from '../document/recoveryCheckpoint';
import { authenticRecoveryControl, isRecoveryControlType, recoveryRange, RECOVERY_CONTROL_TIMEOUT_MS,
  validateRecoveryControl, validateRecoveryStart, type RecoveryControl, type RecoveryIntermediate,
  type RecoveryPhase, type RecoveryStart } from '../document/recoveryProtocol';
import type { SourceFingerprint } from '../io/fingerprint';
import { IncrementalCheckpointHash } from '../document/checkpointHash';
import { assertSelectionHistoryResponse, assertSelectionHistoryUnchanged, captureSelectionHistoryRequest, captureSelectionHistoryState,
  SelectionHistoryOperation, validateUndoSelectionRevision, type SelectionHistoryRequest } from '../document/selectionHistory';
import { assertToleranceRangeAcknowledgement, assertToleranceRangeOwnerUnchanged, assertToleranceOwnerRetainedOrRetired, assertToleranceRangeRequest, captureSelectionRangeCommand,
  captureToleranceRangeState, isSelectionRangeCommand, sameToleranceRangeOwner, toleranceRangeOwner,
  validateToleranceRangeSummary, ToleranceRangeOperation, type CapturedSelectionRangeCommand } from '../document/selectionRange';

const context = self as unknown as DedicatedWorkerGlobalScope;
let module: WasmModule | undefined;
let moduleInitializationId: string | undefined;
let summaryQuery: NativeSummaryQuery | undefined;
const heapSampler = new NativeHeapSampler();
let lastCensus: NativeAllocationCensus | undefined;
let cancelled = false;
let summary: NativeSummary;
let operationScope: OperationScope | undefined, operationOwner: OperationOwner | undefined;
let operationRange: ToleranceRangeOperation | undefined;
let operationFilter: FilterOperation | undefined;
let operationHistory: SelectionHistoryOperation | undefined;
let operationTransform: TransformOperation | undefined;
let transformRequest: TransformRequestProof | undefined;
let historyRequest: SelectionHistoryRequest | undefined;
let filterRequest: FilterRequestProof | undefined;
let toleranceBefore: ReturnType<typeof captureToleranceRangeState> | undefined;
let rangeRequest: { command: CapturedSelectionRangeCommand; before: ReturnType<typeof captureToleranceRangeState> } | undefined;
let sourceIdentity: { documentId: string; sourceGeneration: number } | undefined;
let sourceFingerprint: Readonly<SourceFingerprint> | undefined;
let sourceSubset: RecoveryCheckpointBinding['subset'] | undefined;
let restoreEligible = true;
let queue = Promise.resolve();
const acknowledgements = new Map<number, () => void>();
let geometryAcknowledgement: number | undefined;
let active: WorkerRequest | undefined;
type SourceLoad = Extract<WorkerRequest, { type: 'source-load' | 'source-group-load' }>;
type SourceCredit = { range: SourceRange; lease?: ResourceLease; phase: 'waiting' | 'delivered' | 'released';
  bytes?: ArrayBuffer; resolve(chunk: SourceInputChunk): void; reject(error: Error): void };
type SourceOwner = { request: SourceLoad; source: SourceDescriptor; ledger: ResourceLedger;
  resources: readonly SourceReadDescriptor[]; resourceIndex: number; offset: number; consumedBytes: number;
  rangeId: number; credit?: SourceCredit; retired: boolean };
let sourceOwner: SourceOwner | undefined;
let sourceTerminal = false;
type MapControl = Extract<WorkerRequest, { type: 'map-chunk' | 'map-commit' }>;
let inbound: { request: WorkerRequest; mapId: number; type: MapControl['type']; offset: number; length: number;
  resolve(value: MapControl): void; reject(error: Error): void } | undefined;
let cleanupFailed = false;
let controlError: Error | undefined;
let initializationState: 'uninitialized' | 'initializing' | 'ready' | 'failed' = 'uninitialized';
const initializationAbort = new AbortController();
let runtimeFailure: Error | undefined;
type RecoveryRequest = Envelope & RecoveryStart;
type RecoveryWait = { phase: RecoveryPhase; range: RecoveryCheckpointRange | null;
  timer: ReturnType<typeof setTimeout>; resolve(value: RecoveryControl): void; reject(error: Error): void };
type RecoveryOwner = { request: RecoveryRequest; ledger: ResourceLedger; retired: boolean;
  wait?: RecoveryWait; lease?: ResourceLease; bookkeeping?: ResourceLease; native: 'export' | 'restore' };
let recoveryOwner: RecoveryOwner | undefined;

function fatalRuntime(error: unknown): void {
  if (runtimeFailure) return;
  const failure = error instanceof Error ? error : new Error(String(error));
  runtimeFailure = failure; cleanupFailed = true; initializationState = 'failed';
  initializationAbort.abort(failure);
  // The client owns worker.onerror retirement. Report unmeasurable storage as
  // a fatal worker error, never as a fabricated or stale initialized response.
  setTimeout(() => { throw failure; }, 0);
}

function heapTelemetry() {
  if (runtimeFailure) throw runtimeFailure;
  if (!module) return { initializationId: null, heap: null, census: null } as const;
  try {
    if (!moduleInitializationId) throw new Error('The native module has no initialization identity.');
    // Primary replies and borrowed bytes have already been copied, and the
    // canonical summary has returned. Query after C++ temporary destruction;
    // sample actual linear capacity last, synchronously from this same module.
    const value: unknown = JSON.parse(module.UTF8ToString(module._sv_allocation_snapshot()));
    const heap = heapSampler.sample(module);
    const census = validateNativeAllocationCensus(value, heap, lastCensus);
    lastCensus = census;
    return { initializationId: moduleInitializationId, heap, census };
  } catch (error) { fatalRuntime(error); throw error; }
}
type BootstrapPayload = WorkerBootstrapResponse extends infer Response ?
  Response extends WorkerBootstrapResponse ? Omit<Response, 'heap' | 'census' | 'moduleInitializationId' | 'allocation'> : never : never;
function bootstrapResponse(response: BootstrapPayload) {
  const telemetry = heapTelemetry();
  if (response.type === 'ready') {
    if (!telemetry.heap || telemetry.initializationId !== response.initializationId)
      throw new Error('The scene worker has no initialized native heap.');
    context.postMessage({ ...response, heap: telemetry.heap, census: telemetry.census, allocation: null } satisfies WorkerBootstrapResponse);
  } else if (telemetry.heap) context.postMessage({ ...response, heap: telemetry.heap, census: telemetry.census,
    moduleInitializationId: telemetry.initializationId, allocation: null } satisfies WorkerBootstrapResponse);
  else context.postMessage({ ...response, heap: null, census: null, moduleInitializationId: null,
    allocation: null } satisfies WorkerBootstrapResponse);
}
async function initialize(request: WorkerInitialize) {
  if (initializationState !== 'uninitialized') {
    bootstrapResponse({ type: 'initialization-failed', initializationId: request.initializationId, error: 'The scene worker was already initialized.' }); return;
  }
  initializationState = 'initializing';
  try {
    if (typeof request.initializationId !== 'string' || !request.initializationId || request.initializationId.length > 128)
      throw new Error('Invalid scene initialization identity.');
    assertBuildDescriptor(request.build, BUILD_DESCRIPTOR);
    const assetBase = new URL(request.assetBase);
    if (!/^https?:$/.test(assetBase.protocol) || assetBase.origin !== context.location.origin || assetBase.username || assetBase.password ||
        assetBase.search || assetBase.hash || !assetBase.pathname.endsWith('/') || assetBase.href !== request.assetBase)
      throw new Error('Invalid scene initialization asset base.');
    if (request.mode === 'production-verified') {
      if (!request.source || !request.manifest || !request.manifestUrl || !request.entryUrl) throw new Error('Missing verified scene initialization bytes.');
      const verified = await validateManifest(request.manifest, request.manifestUrl, request.entryUrl, BUILD_DESCRIPTOR);
      if (verified.assetBase !== assetBase.href) throw new Error('The scene worker received a different deployment base.');
      const source = request.source;
      if (!(source.glue instanceof ArrayBuffer) || !(source.wasm instanceof ArrayBuffer) ||
          source.assetBase !== new URL('wasm/', assetBase).href) throw new Error('Invalid verified scene module bytes.');
      const glue = [...verified.artifacts.values()].find(row => row.artifact.role === 'core-glue')!.artifact;
      const wasm = [...verified.artifacts.values()].find(row => row.artifact.role === 'core-wasm')!.artifact;
      if (canonicalJson(source.glueArtifact) !== canonicalJson(glue) || canonicalJson(source.wasmArtifact) !== canonicalJson(wasm))
        throw new Error('The scene worker received different native artifact descriptors.');
    } else if (request.mode !== 'development-module-graph' || !import.meta.env.DEV || request.source || request.manifest) {
      throw new Error('The scene worker requires a verified production deployment.');
    }
    const initialized = await loadCore(assetBase.href, request.source, initializationAbort.signal);
    initializationAbort.signal.throwIfAborted();
    const identity = nativeModuleIdentity(initialized, BUILD_DESCRIPTOR.native.core);
    module = initialized; moduleInitializationId = request.initializationId;
    summaryQuery = new NativeSummaryQuery(initialized);
    initializationState = 'ready';
    bootstrapResponse({ type: 'ready', initializationId: request.initializationId,
      build: BUILD_DESCRIPTOR, core: identity, mode: request.mode });
  } catch (error) {
    summaryQuery?.dispose(); summaryQuery = undefined;
    initializationState = 'failed'; initializationAbort.abort(error);
    bootstrapResponse({ type: 'initialization-failed', initializationId: request.initializationId,
      error: error instanceof Error ? error.message : String(error) });
  }
}

type WorkerPayload<Response = WorkerResponse> = Response extends WorkerResponse ?
  Omit<Response, keyof Envelope | keyof InitializedWorkerTelemetry> : never;
function send(request: WorkerRequest, data: WorkerPayload, transfer: Transferable[] = []) {
  let allocation: NativeAllocationSnapshot | null = null;
  if (runtimeFailure) throw runtimeFailure;
  if (recoveryOwner) throw new Error('Release native recovery ownership before querying ordinary allocation telemetry.');
  if (module) {
    try {
      // Query after work/cleanup and after copying borrowed transfer bytes. A
      // global summary can be stale after failed computations or checkpoints.
      const value = readSummary();
      const acknowledged = 'summary' in data ? data.summary : data.type === 'live-preview' && data.outcome.kind === 'published' ? data.outcome.summary : undefined;
      if (acknowledged) assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(acknowledged), value);
      if (acknowledged) assertFilterUnchanged(filterSummaryState(acknowledged), value);
      if (acknowledged) assertSelectionHistoryUnchanged(captureSelectionHistoryState(acknowledged), value);
      if (acknowledged) assertTransformUnchanged(captureTransformState(acknowledged).transformSession, value);
      allocation = Object.freeze({ loaded: value.loaded, kind: value.kind, count: value.count,
        memoryBytes: value.memoryBytes, selectionMapBytes: value.selectionMapBytes,
        exportBytes: value.exportBytes ?? 0, exportOutputBytes: value.exportOutputBytes ?? 0,
        selectionMapRetainedIds: Object.freeze([...value.selectionMapRetainedIds]) });
    } catch (error) { fatalRuntime(error); throw error; }
  }
  const telemetry = heapTelemetry();
  if (!telemetry.heap && data.type !== 'error') throw new Error('The scene worker has no initialized native heap.');
  context.postMessage({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: request.requestId,
    base: request.base, ...(request.operationOwner ? { operationOwner: request.operationOwner } : {}), ...data, ...telemetry, allocation }, transfer);
}
function sendRecovery(request: RecoveryRequest, data: RecoveryIntermediate, transfer: Transferable[] = []): void {
  const telemetry = heapTelemetry();
  if (!telemetry.heap) throw new Error('The recovery worker has no initialized native heap.');
  context.postMessage({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: request.requestId,
    base: request.base, ...(request.operationOwner ? { operationOwner: request.operationOwner } : {}),
    ...data, ...telemetry, allocation: null } satisfies WorkerResponse, transfer);
}
function result(pointer: number): NativeSummary {
  const value = JSON.parse(module!.UTF8ToString(pointer)) as NativeSummary;
  return checkedSummary(value);
}
function checkedSummary(value: NativeSummary): NativeSummary {
  if (!value.ok) throw new Error(value.error || 'The scene operation failed.');
  validateSelectionCommitRevision(value);
  validateUndoSelectionRevision(value);
  value.toleranceRange = validateToleranceRangeSummary(value);
  value.duplicateRange = validateDuplicateSummary(value);
  if (summary && value.revision === summary.revision && active?.type !== 'source-load' && active?.type !== 'source-group-load' &&
      active?.type !== 'recovery-restore' && (value.count !== summary.count || value.sourceCount !== summary.sourceCount ||
        !sameDuplicateRange(value.duplicateRange, summary.duplicateRange)))
    throw new Error('The native scene changed topology without a revision.');
  if (value.morphologyRange !== undefined) {
    value.morphologyRange = validateMorphologyRange(value.morphologyRange);
    if (value.morphologyRange && (!value.loaded || value.kind !== 0)) throw new Error('The morphology range belongs to another scene kind.');
  }
  value.colorSession = validateColorSession(value.colorSession);
  value.alignment = validateAlignmentSummary(value.alignment);
  if (value.kind !== 0 && value.alignment) throw new Error('Geometry returned alignment metadata.');
  // The native unloaded response is compact and omits its idle pending flag.
  // Loaded scene summaries still require the explicit native boolean.
  if (value.loaded === false && value.kind === 0 && value.count === 0 && value.floor === null && value.pending === undefined) value.pending = false;
  value.floor = validateFloorSummary(value.floor, { loadedCount: value.count, pending: value.pending });
  if ((!value.loaded || value.kind !== 0) && value.floor) throw new Error('The native floor owner belongs to another scene kind.');
  value.filter = filterSummaryState(value);
  if (value.filter && (!value.loaded || value.kind !== 0 || value.selectionDraft))
    throw new Error('The native filter owner belongs to another scene or gesture.');
  value.transformSession = validateTransformSummary(value.transformSession);
  value.opacitySession = validateOpacitySummary(value.opacitySession);
  if (value.opacitySession && (!value.loaded || value.kind !== 0 || value.selectionDraft || value.filter || value.colorSession || value.transformSession))
    throw new Error('The native opacity owner belongs to another scene or gesture.');
  if (value.transformSession && (!value.loaded || value.kind !== 0 || value.selectionDraft || value.filter || value.colorSession))
    throw new Error('The native transform owner belongs to another scene or gesture.');
  captureTransformState(value);
  return value;
}
function ownedCommand(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid scene command.');
  if (Object.hasOwn(value, 'operationOwner')) throw new Error('Operation ownership belongs to the request envelope.');
  const command = captureSelectionViewCommand(value as { command: string });
  return active?.operationOwner ? { ...command, operationOwner: active.operationOwner } : command;
}
function command(value: unknown) {
  const captured = ownedCommand(value);
  requireWorkerProductCommand(captured);
  return wasmString(module!, JSON.stringify(captured), pointer => result(module!._sv_command(pointer)));
}
function operationValue(value: unknown): Record<string, unknown> {
  return wasmString(module!, JSON.stringify(value), pointer => {
    const result = JSON.parse(module!.UTF8ToString(module!._sv_command(pointer))) as Record<string, unknown>;
    if (!result || result.ok !== true) throw new Error(typeof result?.error === 'string' ? result.error : 'The edit outcome could not be verified.');
    return result;
  });
}
function handleOperation(request: Extract<WorkerRequest, { type: 'operation' }>): void {
  const owner = validateOperationOwner(request.operationOwner);
  if (!['begin', 'commit', 'rollback', 'status', 'retire'].includes(request.action) || !sourceIdentity ||
      owner.documentId !== request.base.documentId || owner.sourceGeneration !== request.base.sourceGeneration ||
      owner.documentId !== sourceIdentity.documentId || owner.sourceGeneration !== sourceIdentity.sourceGeneration)
    throw new Error('The edit operation belongs to another source.');
  const scope = validateOperationScope({ version: owner.version, documentId: owner.documentId,
    sourceGeneration: owner.sourceGeneration, clientGeneration: owner.clientGeneration });
  if (operationScope && (scope.documentId !== operationScope.documentId || scope.sourceGeneration !== operationScope.sourceGeneration ||
      scope.clientGeneration !== operationScope.clientGeneration)) throw new Error('The edit operation belongs to another client.');
  if (operationOwner && !sameOperationOwner(owner, operationOwner)) throw new Error('Another edit outcome must be resolved first.');
  if (!operationScope) {
    const bound = operationValue({ command: 'operationBind', operationScope: scope });
    if (Object.keys(bound).sort().join(',') !== 'kind,ok,scope,version' || bound.kind !== 'operation-bound' || bound.version !== 1)
      throw new Error('The native edit scope was not acknowledged.');
    const accepted = validateOperationScope(bound.scope);
    if (accepted.documentId !== scope.documentId || accepted.sourceGeneration !== scope.sourceGeneration ||
        accepted.clientGeneration !== scope.clientGeneration) throw new Error('The native edit scope changed.');
    operationScope = accepted;
  }
  const previous = operationOwner;
  if (!operationRange || !operationFilter || !operationHistory || !operationTransform) {
    const before = readSummary();
    operationRange ??= new ToleranceRangeOperation(before);
    operationFilter ??= new FilterOperation(before);
    operationHistory ??= new SelectionHistoryOperation(captureSelectionHistoryState(before));
    operationTransform ??= new TransformOperation(before);
  }
  operationOwner = owner;
  const names = { begin: 'beginTransaction', commit: 'commitTransaction', rollback: 'rollbackTransaction', status: 'operationStatus', retire: 'operationRetire' } as const;
  const value = operationValue({ command: names[request.action], operationOwner: owner });
  if (request.action === 'retire') {
    if (Object.keys(value).sort().join(',') !== 'kind,ok,owner,version' || value.kind !== 'operation-retired' || value.version !== 1 ||
        !sameOperationOwner(validateOperationOwner(value.owner), owner)) throw new Error('The native edit receipt was not retired.');
    operationOwner = undefined;
    operationRange = undefined;
    operationFilter = undefined;
    operationHistory = undefined;
    operationTransform = undefined;
    send(request, { type: 'operation-retired' }); return;
  }
  if (Object.keys(value).sort().join(',') !== 'kind,ok,receipt,summary,version' || value.kind !== 'operation-receipt' || value.version !== 2)
    throw new Error('The native edit outcome has an invalid response.');
  const receipt = validateOperationReceipt(value.receipt, owner);
  if (receipt.outcome === 'expired-conflict') {
    if (!previous) { operationOwner = undefined; operationRange = undefined; operationFilter = undefined; operationHistory = undefined; operationTransform = undefined; }
    throw new Error('The native edit receipt is expired or conflicts with another edit.');
  }
  summary = checkedSummary(value.summary as NativeSummary);
  assertOperationSummary(receipt, summary);
  operationRange.assert(receipt.outcome, summary);
  operationFilter.assert(receipt.outcome, summary);
  operationHistory.assert(receipt.outcome, summary);
  operationTransform.assert(receipt.outcome, summary);
  send(request, { type: 'operation-result', receipt, summary });
}
function readSummary(): NativeSummary {
  if (!summaryQuery) throw new Error('The native telemetry query is not initialized.');
  return result(summaryQuery.read());
}
const cancellation = () => new DOMException('Operation cancelled', 'AbortError');
function checkCancelled() { if (cancelled) throw controlError ?? cancellation(); }
const sourceBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const sourceBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;
function sourceKeys(value: object, fields: string[]): void {
  const allowed = new Set(['protocolVersion', 'buildId', 'requestId', 'base', 'assetBase', 'type', ...fields]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Invalid source message fields.');
}
function sourceInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum;
}
function releaseSourceCredit(owner: SourceOwner, credit: SourceCredit): void {
  if (credit.phase === 'released') return;
  credit.phase = 'released'; credit.bytes = undefined;
  if (owner.credit === credit) owner.credit = undefined;
  const lease = credit.lease; credit.lease = undefined;
  try { lease?.(); } catch (error) { cleanupFailed = true; throw error; }
}
function abortSource(error: Error): void {
  cancelled = true;
  if (!(error instanceof DOMException && error.name === 'AbortError')) controlError ??= error;
  const owner = sourceOwner, credit = owner?.credit;
  // A delivered chunk is borrowed by stageSingleSourceInput until it releases
  // it. A waiting wire credit owns no received buffer and can reject now.
  if (owner && credit?.phase === 'waiting') {
    try { releaseSourceCredit(owner, credit); }
    finally { credit.reject(controlError ?? error); }
  }
}
function currentSource(owner: SourceOwner): void {
  checkCancelled();
  if (sourceOwner !== owner || owner.retired || active !== owner.request)
    throw new Error('The source candidate is no longer current.');
}
function sourceRead(owner: SourceOwner, resourceId: string, offset: number, length: number): Promise<SourceInputChunk> {
  currentSource(owner);
  if (owner.credit) throw new Error('A source receive credit is already outstanding.');
  const resource = owner.resources[owner.resourceIndex];
  if (!resource || resource.resourceId !== resourceId) throw new Error('Invalid source resource transfer order.');
  const range = validateSourceRange({ operationId: owner.source.operationId, resourceId,
    rangeId: owner.rangeId, offset, length }, resource, owner.rangeId, owner.offset);
  return new Promise((resolve, reject) => {
    const credit: SourceCredit = { range, phase: 'waiting', resolve, reject };
    owner.credit = credit;
    try {
      credit.lease = owner.ledger.reserve('source', length);
      currentSource(owner);
      send(owner.request, { type: 'source-range-request', ...range });
    } catch (error) {
      try { releaseSourceCredit(owner, credit); }
      finally { reject(error); }
    }
  });
}
function receiveSource(request: Extract<WorkerRequest, { type: 'source-range' }>): void {
  const owner = sourceOwner, credit = owner?.credit;
  if (!owner || !credit || credit.phase !== 'waiting') throw new Error('Invalid source transfer phase.');
  currentSource(owner);
  sourceKeys(request, ['operationId', 'resourceId', 'rangeId', 'offset', 'length', 'bytes']);
  validateSourceRange(request, owner.resources[owner.resourceIndex], owner.rangeId, owner.offset);
  const bytes = request.bytes;
  if (sourceBufferLength.call(bytes) !== credit.range.length || sourceBufferResizable?.call(bytes))
    throw new Error('Invalid source transfer byte buffer.');
  new Uint8Array(bytes); // Also reject detached buffers using the intrinsic view.
  credit.bytes = bytes; credit.phase = 'delivered';
  credit.resolve(Object.freeze({
    get bytes(): ArrayBuffer {
      currentSource(owner);
      if (owner.credit !== credit || credit.phase !== 'delivered') throw new Error('The source range was released.');
      return credit.bytes!;
    },
    consume(): void {
      currentSource(owner);
      if (owner.credit !== credit || credit.phase !== 'delivered') throw new Error('The source range was released.');
      releaseSourceCredit(owner, credit);
      owner.offset += credit.range.length; owner.consumedBytes += credit.range.length; owner.rangeId++;
      while (owner.resourceIndex < owner.resources.length && owner.offset === owner.resources[owner.resourceIndex].byteLength) {
        owner.resourceIndex++; owner.offset = 0;
      }
      // stageSingleSourceInput calls this only after copying and hashing the
      // exact decoder range synchronously. The next credit follows this ack.
      send(owner.request, { type: 'source-range-consumed', ...credit.range });
    },
    release(): void { releaseSourceCredit(owner, credit); },
  }));
}
async function adoptSource(request: Extract<SourceLoad, { type: 'source-load' }>) {
  sourceKeys(request, ['source', 'format', 'maxSplats', 'budgetBytes', 'sourceBudgetBytes']);
  const source = validateSourceDescriptor(request.source);
  assertSceneInputBytes(source.byteLength);
  const { format, maxSplats, budgetBytes, sourceBudgetBytes } = request;
  if (!sourceInteger(format, 0, 4) || !sourceInteger(maxSplats, 1, 0xffff_ffff) ||
      !sourceInteger(budgetBytes, 1, 0xffff_ffff) || sourceBudgetBytes !== sourceWorkerBytes(source.byteLength))
    throw new Error('Invalid source load limits.');
  assertSourceFitsDecodeBudget(source.byteLength, budgetBytes);
  const owner: SourceOwner = { request, source, ledger: new ResourceLedger(sourceBudgetBytes),
    resources: [source], resourceIndex: source.byteLength === 0 ? 1 : 0, offset: 0, consumedBytes: 0, rangeId: 0, retired: false };
  sourceOwner = owner;
  let staged: StagedSourceInput | undefined;
  try {
    send(request, { type: 'progress', stage: 'Reading scene', fraction: 0 });
    staged = await stageSingleSourceInput(module!, source.byteLength, {
      current: () => currentSource(owner), admit: bytes => owner.ledger.reserve('source', bytes),
      read: (offset, length) => sourceRead(owner, source.resourceId, offset, length),
    });
    currentSource(owner);
    if (owner.consumedBytes !== source.byteLength || owner.credit) throw new Error('Incomplete source transfer.');
    send(request, { type: 'progress', stage: 'Decoding scene', fraction: 0.2 });
    currentSource(owner);
    summary = result(module!._sv_open(staged.pointer, staged.byteLength, format, maxSplats, budgetBytes));
    currentSource(owner);
    const fingerprint = validateSourceFingerprint(
      finishSourceFingerprint(staged.summary, staged.assetDigest, summary.format), source, summary);
    return { operationId: source.operationId, resourceId: source.resourceId,
      consumedBytes: owner.consumedBytes, summary, fingerprint };
  } finally {
    owner.retired = true;
    try { staged?.dispose(); }
    catch (error) { cleanupFailed = true; throw error; }
    finally {
      try { if (owner.credit) releaseSourceCredit(owner, owner.credit); }
      finally {
        if (sourceOwner === owner) sourceOwner = undefined;
        if (owner.ledger.usage.bytes !== 0) cleanupFailed = true;
      }
    }
    if (cleanupFailed) throw new Error('Source input ownership could not be released.');
  }
}
async function adoptGroupSource(request: Extract<SourceLoad, { type: 'source-group-load' }>) {
  sourceKeys(request, ['source', 'maxSplats', 'budgetBytes', 'sourceBudgetBytes', 'nativeWorkBytes']);
  const source = validateGroupSourceDescriptor(request.source);
  const { maxSplats, budgetBytes, sourceBudgetBytes, nativeWorkBytes } = request;
  if (!sourceInteger(maxSplats, 1, 1_000_000) || budgetBytes !== GROUP_NATIVE_BUDGET_BYTES ||
      sourceBudgetBytes !== groupWorkerBytes(source) || nativeWorkBytes !== GROUP_NATIVE_WORK_BYTES)
    throw new Error('Invalid grouped source load limits.');
  assertSourceFitsDecodeBudget(groupNativeStageBytes(source), budgetBytes);
  const resources = [...source.resources, source.decoder].map(resource => ({ ...resource, operationId: source.operationId }));
  const owner: SourceOwner = { request, source, ledger: new ResourceLedger(sourceBudgetBytes), resources,
    resourceIndex: 0, offset: 0, consumedBytes: 0, rangeId: 0, retired: false };
  sourceOwner = owner; let staged: StagedGroupSourceInput | undefined;
  try {
    send(request, { type: 'progress', stage: 'Reading scene', fraction: 0 });
    staged = await stageGroupSourceInput(module!, source, { current: () => currentSource(owner),
      admit: bytes => owner.ledger.reserve('source', bytes), read: (id, offset, length) => sourceRead(owner, id, offset, length) });
    currentSource(owner);
    if (owner.consumedBytes !== groupTransferBytes(source) || owner.credit || owner.resourceIndex !== resources.length)
      throw new Error('Incomplete grouped source transfer.');
    send(request, { type: 'progress', stage: 'Decoding scene', fraction: .2 }); currentSource(owner);
    if (typeof module!._sv_open_group !== 'function') throw new Error('The native core cannot decode grouped SOG.');
    summary = result(module!._sv_open_group(staged.pointer, staged.byteLength, staged.descriptorPointer,
      staged.descriptorByteLength, maxSplats, budgetBytes, nativeWorkBytes));
    currentSource(owner);
    if (summary.sourceCount !== staged.sourceCount) throw new Error('The native grouped decoder changed its source count.');
    const fingerprint = validateGroupSourceFingerprint(finishSourceFingerprint(staged.summary, staged.assetDigest, summary.format), source, summary, staged.shDegree);
    return { operationId: source.operationId, resourceId: source.resourceId, consumedBytes: owner.consumedBytes, summary, fingerprint };
  } finally {
    owner.retired = true;
    try { staged?.dispose(); } catch (error) { cleanupFailed = true; throw error; }
    finally {
      try { if (owner.credit) releaseSourceCredit(owner, owner.credit); }
      finally { if (sourceOwner === owner) sourceOwner = undefined; if (owner.ledger.usage.bytes !== 0) cleanupFailed = true; }
    }
    if (cleanupFailed) throw new Error('Grouped source input ownership could not be released.');
  }
}
function mapControl(request: WorkerRequest, mapId: number, offset: number, length: number): Promise<MapControl> {
  return new Promise((resolve, reject) => {
    inbound = { request, mapId, offset, length, type: length ? 'map-chunk' : 'map-commit', resolve, reject };
    send(request, length ? { type: 'map-chunk-request', mapId, offset, length } : { type: 'map-ready', mapId });
  });
}
async function adoptMap(request: Extract<WorkerRequest, { type: 'selection-map' }>) {
  const layout = validateSelectionMapDescriptor(request.descriptor), mapId = layout.descriptor.mapId;
  let begun = false, committed = false;
  try {
    checkCancelled(); summary = command({ command: 'selectionMapBegin', ...layout.descriptor }); begun = true;
    for (let offset = 0; offset < layout.payloadBytes;) {
      checkCancelled(); const length = Math.min(layout.chunkBytes, layout.payloadBytes - offset);
      const chunk = await mapControl(request, mapId, offset, length); checkCancelled();
      if (chunk.type !== 'map-chunk') throw new Error('Invalid selection map transfer phase.');
      const pointer = module!._malloc(length);
      if (!pointer) throw new Error('There is not enough memory to transfer this selection map.');
      try { module!.HEAPU8.set(new Uint8Array(chunk.bytes), pointer); summary = result(module!._sv_map_write(mapId, offset, pointer, length)); }
      finally { module!._free(pointer); }
      offset += length;
    }
    await mapControl(request, mapId, layout.payloadBytes, 0); checkCancelled();
    summary = command({ command: 'selectionMapCommit', mapId }); committed = true;
  } finally {
    inbound = undefined;
    if (begun && !committed) {
      try { summary = command({ command: 'selectionMapRelease', mapId }); }
      catch { cleanupFailed = true; }
    }
  }
}

function currentRecovery(owner: RecoveryOwner): void {
  checkCancelled();
  if (recoveryOwner !== owner || owner.retired || active !== owner.request)
    throw new Error('The recovery transfer is no longer current.');
}
function releaseRecoveryWait(owner: RecoveryOwner): RecoveryWait | undefined {
  const wait = owner.wait; owner.wait = undefined;
  if (wait) clearTimeout(wait.timer);
  return wait;
}
function abortRecovery(owner: RecoveryOwner, error: Error): void {
  if (recoveryOwner !== owner || owner.retired) return;
  cancelled = true;
  if (!(error instanceof DOMException && error.name === 'AbortError')) controlError ??= error;
  releaseRecoveryWait(owner)?.reject(controlError ?? error);
}
function recoveryWait(owner: RecoveryOwner, phase: RecoveryPhase, range: RecoveryCheckpointRange | null,
  notify: () => void): Promise<RecoveryControl> {
  currentRecovery(owner);
  if (owner.wait) throw new Error('A recovery control is already outstanding.');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => abortRecovery(owner, new Error('The recovery transfer acknowledgement timed out.')),
      RECOVERY_CONTROL_TIMEOUT_MS);
    owner.wait = { phase, range, timer, resolve, reject };
    try { notify(); }
    catch (error) {
      releaseRecoveryWait(owner);
      reject(error);
    }
  });
}
function receiveRecovery(request: Envelope & RecoveryControl): void {
  const owner = recoveryOwner;
  if (!owner) return;
  currentRecovery(owner);
  const wait = owner.wait;
  if (!wait) throw new Error('No recovery control is outstanding.');
  const accepted = validateRecoveryControl(request, owner.request, wait.phase, wait.range);
  releaseRecoveryWait(owner); wait.resolve(accepted);
}
function recoveryNativeValue(pointer: number): Record<string, unknown> {
  const value: unknown = JSON.parse(module!.UTF8ToString(pointer));
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { ok?: unknown }).ok !== true)
    throw new Error(typeof (value as { error?: unknown })?.error === 'string' ?
      (value as { error: string }).error : 'The native recovery operation failed.');
  return value as Record<string, unknown>;
}
function assertRecoveryWrite(value: Record<string, unknown>, byteLength: number, written: number, begin = false): void {
  if (Object.keys(value).sort().join(',') !== (begin ? 'byteLength,ok,version,written' : 'byteLength,ok,written') ||
      value.byteLength !== byteLength || value.written !== written || begin && value.version !== 1)
    throw new Error('The native recovery input was not acknowledged.');
}
function cleanupRecovery(owner: RecoveryOwner): void {
  owner.retired = true;
  releaseRecoveryWait(owner)?.reject(cancellation());
  try {
    // Native ownership ends before ordinary summary/telemetry paths can run.
    if (owner.native === 'export') module!._sv_recovery_release();
    else module!._sv_recovery_restore_cancel();
  } catch (error) { cleanupFailed = true; throw error; }
  finally {
    owner.lease?.(); owner.lease = undefined;
    owner.bookkeeping?.(); owner.bookkeeping = undefined;
    if (recoveryOwner === owner) recoveryOwner = undefined;
    if (owner.ledger.usage.bytes !== 0) cleanupFailed = true;
  }
}
function assertExportBinding(request: RecoveryRequest, before: NativeSummary): void {
  if (!sourceIdentity || !sourceFingerprint || !sourceSubset || !before.loaded ||
      sourceIdentity.documentId !== request.base.documentId || sourceIdentity.sourceGeneration !== request.base.sourceGeneration)
    throw new Error('The recovery checkpoint has no matching successfully loaded source.');
  assertRecoveryCheckpointBinding(request.binding, { version: 1, core: BUILD_DESCRIPTOR.native.core,
    source: sourceFingerprint, subset: sourceSubset, revision: request.base });
}
async function exportRecovery(request: Extract<RecoveryRequest, { type: 'recovery-export' }>): Promise<void> {
  validateRecoveryStart(request, BUILD_DESCRIPTOR.native.core);
  const before = readSummary();
  assertExportBinding(request, before);
  const owner: RecoveryOwner = { request, ledger: new ResourceLedger(1024 * 1024), native: 'export', retired: false };
  recoveryOwner = owner;
  try {
    const plan = validateRecoveryCheckpointPlan(recoveryNativeValue(module!._sv_recovery_prepare()));
    if (plan.actualRevision !== before.revision || plan.contentRevision !== before.contentRevision ||
        plan.currentLoadedCount !== before.count || plan.currentSourceCount !== before.sourceCount ||
        !sameDuplicateRange(plan.currentDuplicateRange, before.duplicateRange))
      throw new Error('The native recovery plan changed the captured document.');
    await recoveryWait(owner, 'proceed', null, () => sendRecovery(request,
      { type: 'recovery-plan', recoveryId: request.recoveryId, plan, summary: before }));
    currentRecovery(owner);
    for (let index = 0, range: RecoveryCheckpointRange | null; (range = recoveryRange(plan, index)); index++) {
      currentRecovery(owner);
      owner.lease = owner.ledger.reserve('recovery', range.length);
      try {
        const pointer = module!._sv_recovery_read(range.offset, range.length);
        const length = module!._sv_recovery_read_size(), heap = module!.HEAPU8;
        if (!Number.isSafeInteger(pointer) || pointer <= 0 || length !== range.length ||
            pointer > heap.byteLength || length > heap.byteLength - pointer)
          throw new Error('The native recovery chunk is unavailable.');
        const bytes = heap.slice(pointer, pointer + length).buffer;
        await recoveryWait(owner, 'ack', range, () => sendRecovery(request,
          { type: 'recovery-chunk', recoveryId: request.recoveryId, ...range!, bytes }, [bytes]));
        currentRecovery(owner);
      } finally { owner.lease?.(); owner.lease = undefined; }
    }
    // The external owner accepts the full authenticated checkpoint and records
    // its decision while native mutation remains locked by the immutable plan.
    await recoveryWait(owner, 'release', null, () => sendRecovery(request,
      { type: 'recovery-exported', recoveryId: request.recoveryId }));
    currentRecovery(owner);
  } finally { cleanupRecovery(owner); }
  summary = readSummary();
  assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(before), summary);
  assertFilterUnchanged(filterSummaryState(before), summary);
  assertSelectionHistoryUnchanged(captureSelectionHistoryState(before), summary);
  assertTransformUnchanged(captureTransformState(before).transformSession, summary);
  if (summary.count !== before.count || summary.sourceCount !== before.sourceCount ||
      !sameDuplicateRange(summary.duplicateRange, before.duplicateRange)) throw new Error('The native recovery owner changed its captured scene.');
  send(request, { type: 'recovery-result', recoveryId: request.recoveryId, action: 'export', summary });
}
async function restoreRecovery(request: Extract<RecoveryRequest, { type: 'recovery-restore' }>): Promise<void> {
  validateRecoveryStart(request, BUILD_DESCRIPTOR.native.core);
  if (!restoreEligible || sourceIdentity || operationScope || operationOwner || readSummary().loaded)
    throw new Error('Recovery restoration requires a fresh, unloaded scene worker.');
  restoreEligible = false;
  assertSceneInputBytes(request.binding.source.totalBytes);
  const plan: RecoveryCheckpointPlan = validateRecoveryCheckpointPlan(request.plan);
  const owner: RecoveryOwner = { request, ledger: new ResourceLedger(1024 * 1024 + 4096), native: 'restore', retired: false };
  recoveryOwner = owner;
  let payloadHash: IncrementalCheckpointHash | undefined, headerHash: IncrementalCheckpointHash | undefined;
  try {
    owner.bookkeeping = owner.ledger.reserve('recovery', 4096);
    payloadHash = new IncrementalCheckpointHash(); headerHash = new IncrementalCheckpointHash();
    const expected = { codecVersion: 3, currentLoadedCount: plan.currentLoadedCount, currentSourceCount: plan.currentSourceCount,
      currentDuplicateRange: plan.currentDuplicateRange, maximumGraphSplats: plan.maximumGraphSplats,
      originalSourceCount: request.binding.subset.sourceCount, revision: plan.revision,
      contentRevision: plan.contentRevision, nextContentRevision: plan.nextContentRevision };
    assertRecoveryWrite(wasmString(module!, JSON.stringify(expected), pointer => recoveryNativeValue(module!._sv_recovery_restore_begin(
      plan.byteLength, plan.maximumGraphSplats, request.budgetBytes, pointer))), plan.byteLength, 0, true);
    for (let index = 0, range: RecoveryCheckpointRange | null; (range = recoveryRange(plan, index)); index++) {
      currentRecovery(owner);
      owner.lease = owner.ledger.reserve('recovery', range.length);
      try {
        const received = await recoveryWait(owner, 'range', range, () => sendRecovery(request,
          { type: 'recovery-range-request', recoveryId: request.recoveryId, ...range! }));
        currentRecovery(owner);
        if (received.type !== 'recovery-range') throw new Error('Invalid recovery input phase.');
        const input = new Uint8Array(received.bytes);
        if (range.index === 0) {
          headerHash.update(input.subarray(0, 64));
          if (headerHash.digest() !== plan.headerSha256) throw new Error('The recovery header does not match its admitted plan.');
        }
        payloadHash.update(range.index === 0 ? input.subarray(64) : input);
        const pointer = module!._malloc(range.length);
        if (!Number.isSafeInteger(pointer) || pointer <= 0) throw new Error('There is not enough memory for the recovery range.');
        try {
          module!.HEAPU8.set(input, pointer);
          assertRecoveryWrite(recoveryNativeValue(module!._sv_recovery_restore_write(range.offset, pointer, range.length)),
            plan.byteLength, range.offset + range.length);
        } finally { module!._free(pointer); }
        currentRecovery(owner);
        sendRecovery(request, { type: 'recovery-range-consumed', recoveryId: request.recoveryId, ...range });
      } finally { owner.lease?.(); owner.lease = undefined; }
    }
    currentRecovery(owner);
    if (payloadHash.digest() !== plan.sha256) throw new Error('The recovery payload does not match its admitted plan.');
    summary = result(module!._sv_recovery_restore_finish());
    if (!summary.loaded || summary.revision !== plan.revision || summary.contentRevision !== plan.contentRevision ||
        summary.count !== plan.currentLoadedCount || summary.sourceCount !== plan.currentSourceCount ||
        !sameDuplicateRange(summary.duplicateRange, plan.currentDuplicateRange) || summary.memoryBytes > request.budgetBytes ||
        summary.format !== request.binding.source.sourceKindHint || summary.transaction || summary.selectionDraft || summary.pending || summary.toleranceRange !== null || summary.filter !== null || summary.undoSelectionRevision !== 0 || summary.transformSession?.kind === 'gizmo')
      throw new Error('The native restored document does not match the admitted checkpoint.');
    sourceIdentity = { documentId: request.base.documentId, sourceGeneration: request.base.sourceGeneration };
    sourceFingerprint = request.binding.source; sourceSubset = request.binding.subset;
    operationScope = undefined; operationOwner = undefined; operationRange = undefined; operationFilter = undefined; operationHistory = undefined; operationTransform = undefined;
  } finally { payloadHash?.dispose(); headerHash?.dispose(); cleanupRecovery(owner); }
  send(request, { type: 'recovery-result', recoveryId: request.recoveryId, action: 'restore', summary });
}

async function handle(request: WorkerRequest) {
  active = request; cancelled = false; cleanupFailed = false; controlError = undefined; sourceTerminal = false; rangeRequest = undefined; filterRequest = undefined; toleranceBefore = undefined; historyRequest = undefined; transformRequest = undefined;
  if (initializationState !== 'ready' || !module) throw new Error('The scene worker is not ready.');
  if (request.type === 'command' || request.type === 'live-preview' || request.type === 'export')
    requireWorkerProductCommand(request.command);
  checkCancelled();
  if (request.type !== 'recovery-restore') restoreEligible = false;
  if (request.type === 'recovery-restore') { await restoreRecovery(request); return; }
  if (request.type === 'operation') { handleOperation(request); return; }
  if (operationOwner ? !request.operationOwner || !sameOperationOwner(validateOperationOwner(request.operationOwner), operationOwner) : request.operationOwner !== undefined)
    throw new Error('Resolve the owned edit before starting other scene work.');
  if (request.type === 'recovery-export') { await exportRecovery(request); return; }
  if (request.type !== 'source-load' && request.type !== 'source-group-load') {
    const before = readSummary();
    filterRequest = captureFilterRequest(request.type === 'command' ? request.command : undefined, captureFilterState(before));
    toleranceBefore = captureToleranceRangeState(before);
    historyRequest = captureSelectionHistoryRequest(captureSelectionHistoryState(before), request.type, request.type === 'command' ? request.command : undefined);
    transformRequest = captureTransformRequest(request.type === 'command' ? request.command : undefined, captureTransformState(before));
  }
  if (request.type === 'export-plan') {
    const value = readSummary();
    if (!value.loaded || value.kind !== 0 || value.pending || value.selectionDraft || value.filter || value.transformSession || value.opacitySession)
      throw new Error('Finish the current operation before exporting.');
    const plan = validateSpz4ExportPlan({ count: value.count, shDegree: value.shDegree,
      outputCapacity: module._sv_spz4_output_bound!(value.count, value.shDegree),
      nativeWorkBytes: module._sv_spz4_work_bound!(value.count, value.shDegree) });
    send(request, { type: 'export-plan', plan, summary: value }); return;
  }
  if (request.type === 'scene-export-plan') {
    if (!isAdmittedSceneExportFormat(request.format) || !Number.isInteger(request.scope) || request.scope < 0 || request.scope > 2)
      throw new Error('Unsupported admitted export format or scope.');
    const value = readSummary();
    if (!value.loaded || value.kind !== 0 || value.pending || value.selectionDraft || value.filter || value.transformSession || value.opacitySession)
      throw new Error('Finish the current operation before exporting.');
    const plan = validateSceneExportPlan({ format: request.format, scope: request.scope, count: value.count, shDegree: value.shDegree,
      outputCapacity: module._sv_export_output_bound!(request.format, value.count, value.shDegree),
      nativeWorkBytes: module._sv_export_work_bound!(request.format, value.count, value.shDegree) });
    send(request, { type: 'scene-export-plan', plan, summary: value }); return;
  }
  if (request.type === 'source-load' || request.type === 'source-group-load') {
    const loaded = request.type === 'source-load' ? await adoptSource(request) : await adoptGroupSource(request);
    if (loaded.summary.filter !== null) throw new Error('A newly loaded source returned a filter owner.');
    if (loaded.summary.transformSession !== null) throw new Error('A newly loaded source returned a transform owner.');
    if (loaded.summary.opacitySession !== null) throw new Error('A newly loaded source returned an opacity owner.');
    if (loaded.summary.duplicateRange !== null) throw new Error('A newly loaded source returned a Duplicate range.');
    if (loaded.summary.toleranceRange !== null) throw new Error('A newly loaded source returned a tolerance Range owner.');
    if (loaded.summary.undoSelectionRevision !== 0) throw new Error('A newly loaded source returned a selection Undo stamp.');
    checkCancelled();
    sourceIdentity = { documentId: request.base.documentId, sourceGeneration: request.base.sourceGeneration };
    sourceFingerprint = loaded.fingerprint;
    sourceSubset = Object.freeze({ sourceCount: loaded.summary.sourceCount, loadedCount: loaded.summary.count, maxSplats: request.maxSplats });
    operationScope = undefined; operationOwner = undefined; operationRange = undefined; operationFilter = undefined; operationHistory = undefined; operationTransform = undefined;
    send(request, { type: 'source-load-result', ...loaded }); sourceTerminal = true; return;
  } else if (request.type === 'selection-map') {
    await adoptMap(request);
  } else if (request.type === 'live-preview') {
    const value = wasmString(module, JSON.stringify(ownedCommand(request.command)), pointer => JSON.parse(module!.UTF8ToString(module!._sv_live_preview(pointer)))) as Record<string, unknown>;
    if (value.ok !== true) throw new Error(typeof value.error === 'string' ? value.error : 'The live selection operation failed.');
    const { ok: _ok, ...payload } = value;
    const outcome = livePreviewOutcome(payload);
    if (outcome.kind === 'published') {
      outcome.summary = checkedSummary(outcome.summary);
      outcome.summary.filter = validateFilterSummary(outcome.summary.filter);
      if (outcome.summary.filter) throw new Error('A manual preview returned a filter owner.');
      outcome.summary.transformSession = validateTransformSummary(outcome.summary.transformSession);
      if (outcome.summary.transformSession) throw new Error('A manual preview returned a transform owner.');
      outcome.summary.opacitySession = validateOpacitySummary(outcome.summary.opacitySession);
      if (outcome.summary.opacitySession) throw new Error('A manual preview returned an opacity owner.');
      summary = outcome.summary;
      if (filterRequest) assertFilterResponse(filterRequest, summary);
      if (historyRequest) assertSelectionHistoryResponse(historyRequest, summary);
      if (transformRequest) assertTransformResponse(transformRequest, summary);
      operationRange?.accept(summary);
      operationFilter?.accept(summary);
      operationHistory?.accept(summary);
      operationTransform?.accept(summary);
    }
    send(request, { type: 'live-preview', outcome }); return;
  } else if (request.type === 'command' || request.type === 'export') {
    let transformFocus: TransformFocusState | undefined;
    let sceneCommand = request.command;
    if (isSelectionRangeCommand(sceneCommand)) {
      sceneCommand = captureSelectionRangeCommand(sceneCommand);
      rangeRequest = { command: sceneCommand as CapturedSelectionRangeCommand, before: captureToleranceRangeState(readSummary()) };
      assertToleranceRangeRequest(rangeRequest.command, rangeRequest.before);
    }
    if (request.command.command === 'transformFocus') {
      if (request.type !== 'command' || request.operationOwner !== undefined || operationOwner)
        throw new Error('Transform focus cannot own an edit operation.');
      const focusCommand = validateTransformFocusCommand(request.command);
      transformFocus = captureTransformFocusState(readSummary());
      assertTransformFocusBinding(focusCommand, transformFocus);
      sceneCommand = focusCommand;
    }
    if (request.command.command === 'duplicate' && !isDuplicateCommand(request.command)) throw new Error('Invalid Duplicate command.');
    if (request.command.command === 'morphology' && !isSelectionMorphologyCommand(request.command, false) ||
        request.command.command === 'morphologyRange' && !isMorphologyRangeCommand(request.command)) throw new Error('Invalid selection morphology command.');
    if (request.command.command === 'beginColor' && !isBeginColorCommand(request.command)) throw new Error('Invalid color session command.');
    if (request.type === 'command' && request.command.command === 'export')
      throw new Error('Scene export requires the owned export request family.');
    if ((OPACITY_COMMANDS as readonly string[]).includes(request.command.command) && !isOpacityCommand(request.command))
      throw new Error('Invalid opacity session command.');
    if ((TRANSFORM_COMMANDS as readonly string[]).includes(request.command.command) && !isTransformCommand(request.command))
      throw new Error('Invalid transform session command.');
    if ((TRANSFORM_COMMANDS as readonly string[]).includes(request.command.command)) sceneCommand = captureTransformCommand(request.command);
    if (['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(request.command.command) &&
        !isSelectionFilterCommand(request.command)) throw new Error('Invalid selection filter command.');
    if (request.type === 'export') {
      if (request.command.command !== 'export' || !isAdmittedSceneExportFormat(request.command.format) ||
          !Number.isInteger(request.command.scope) || Number(request.command.scope) < 0 || Number(request.command.scope) > 2)
        throw new Error('Unsupported export format or scope.');
      const value = readSummary();
      const plan = validateSceneExportPlan({ format: request.command.format, scope: Number(request.command.scope), count: value.count, shDegree: value.shDegree,
        outputCapacity: module._sv_export_output_bound!(request.command.format, value.count, value.shDegree),
        nativeWorkBytes: module._sv_export_work_bound!(request.command.format, value.count, value.shDegree) });
      if (request.command.outputCapacity !== plan.outputCapacity || request.command.nativeWorkBytes !== plan.nativeWorkBytes)
        throw new Error('Invalid scene output admission.');
    }
    summary = command(sceneCommand);
    summary = await pumpEdit(summary, {
      checkCancelled() {
        if (cancelled) { command({ command: 'cancel' }); throw new DOMException('Edit cancelled', 'AbortError'); }
      },
      step: work => result(module!._sv_step(work)),
      progress: value => send(request, { type: 'progress',
        stage: request.type === 'export' ? 'Exporting scene' : request.command.command === 'detectFloor' ? 'Detecting floor' :
          request.command.command === 'morphologyRange' ? 'Measuring selection reach' :
          request.command.command === 'transformFocus' ? 'Measuring transform pivot' : 'Applying edit', fraction: value.progress }),
    });
    if (rangeRequest) assertToleranceRangeAcknowledgement(rangeRequest.command, rangeRequest.before, summary);
    else if (toleranceBefore && !transformFocus) assertToleranceOwnerRetainedOrRetired(toleranceRangeOwner(toleranceBefore), summary);
    if (filterRequest && !transformFocus) assertFilterResponse(filterRequest, summary);
    if (historyRequest && !transformFocus) assertSelectionHistoryResponse(historyRequest, summary);
    if (transformRequest && !transformFocus) assertTransformResponse(transformRequest, summary);
    if (transformFocus) {
      assertTransformFocusUnchanged(transformFocus, summary);
      transformFocusPoint(summary, sceneCommand.scope === 'scene' ? 'scene' : 'selection');
    }
    if (request.type === 'export') {
      const pointer = module._sv_output_ptr(), length = module._sv_output_len();
      checkCancelled();
      if (!pointer || !length || !Number.isSafeInteger(pointer) || !Number.isSafeInteger(length) ||
          pointer < 0 || length < 0 || pointer > module.HEAPU8.byteLength || length > module.HEAPU8.byteLength - pointer ||
          length > Number(request.command.outputCapacity))
        throw new Error('Invalid native export range.');
      const bytes = module.HEAPU8.slice(pointer, pointer + length).buffer;
      send(request, { type: 'output', bytes, summary }, [bytes]); return;
    }
  } else if (request.type === 'geometry-stream') {
    const descriptor = validateGeometryDescriptor(request.descriptor);
    summary = readSummary();
    if (!sameGeometryDescriptor(descriptor, geometryDescriptor(summary))) throw new Error('The requested geometry is no longer current.');
    let chunkId = 0;
    for (const channel of ['vertices', 'indices'] as GeometryChannel[]) {
      for (let first = 0; first < geometryChannelCount(descriptor, channel);) {
        checkCancelled();
        const count = geometryChunkCount(descriptor, channel, first), stride = channel === 'vertices' ? 16 : 4;
        const pointer = module._sv_geometry_range(channel === 'vertices' ? 0 : 1, first, count);
        const bytes = geometryHeapChunk(module.HEAPU8, pointer, module._sv_geometry_range_len(), count * stride);
        geometryAcknowledgement = chunkId;
        const acknowledged = new Promise<void>(resolve => acknowledgements.set(chunkId, resolve));
        send(request, { type: 'geometry-chunk', descriptor, channel, first, count, chunkId, bytes }, [bytes]);
        await acknowledged; geometryAcknowledgement = undefined; checkCancelled();
        first += count; chunkId++;
      }
    }
    summary = readSummary();
    if (!sameGeometryDescriptor(descriptor, geometryDescriptor(summary))) throw new Error('The geometry changed during upload.');
  } else if (request.type === 'stream' || request.type === 'masks') {
    if (!summary?.loaded || summary.kind !== 0) throw new Error('Gaussian upload is unavailable for this scene.');
    const capturedColorBase = request.channel === 'colorBase' ?
      validateColorBaseIdentity(request.colorBase) : undefined;
    const capturedTransformBase = request.channel === 'transformBase' ?
      validateTransformBaseIdentity(request.transformBase) : undefined;
    const capturedOpacityBase = request.channel === 'opacityBase' ? validateOpacityBaseIdentity(request.opacityBase) : undefined;
    const checkColorBase = () => {
      if (request.channel !== undefined && !['document', 'colorBase', 'transformBase', 'opacityBase'].includes(request.channel))
        throw new Error('Invalid scene stream channel.');
      if (request.channel !== 'colorBase') {
        if (request.colorBase !== undefined) throw new Error('Unexpected color-base stream identity.');
        return false;
      }
      const session = readSummary().colorSession;
      if (!session || session.pending || !capturedColorBase || !sameColorBase(session, capturedColorBase))
        throw new Error('The color-base stream is stale.');
      return true;
    };
    const checkTransformBase = () => {
      if (request.channel !== 'transformBase') {
        if (request.transformBase !== undefined) throw new Error('Unexpected transform-base stream identity.');
        return false;
      }
      const current = readSummary(), session = current.transformSession;
      if (!session || current.pending || !capturedTransformBase || !sameTransformBase(session, capturedTransformBase))
        throw new Error('The transform-base stream is stale.');
      return true;
    };
    const colorBase = checkColorBase();
    const transformBase = checkTransformBase();
    const checkOpacityBase = () => {
      if (request.channel !== 'opacityBase') {
        if (request.opacityBase !== undefined) throw new Error('Unexpected opacity-base stream identity.');
        return false;
      }
      const current = readSummary(), session = current.opacitySession;
      if (!session || current.pending || !capturedOpacityBase || !sameOpacityBase(session, capturedOpacityBase))
        throw new Error('The opacity-base stream is stale.');
      return true;
    };
    const opacityBase = checkOpacityBase();
    const stride = 40 + 4 * Math.ceil(3 * (Math.min(summary.shDegree, 3) + 1) ** 2 / 2);
    const chunkCount = Math.max(1, Math.floor(1024 * 1024 / stride));
    for (let first = 0; request.type === 'stream' && first < summary.count; first += chunkCount) {
      if (cancelled) throw new DOMException('Upload cancelled', 'AbortError');
      const count = Math.min(chunkCount, summary.count - first);
      checkColorBase();
      checkTransformBase();
      checkOpacityBase();
      const pointer = colorBase ? module._sv_pack_color_base(first, count) : transformBase ?
        module._sv_pack_transform_base(capturedTransformBase!.id, capturedTransformBase!.baseId, capturedTransformBase!.epoch, first, count) : opacityBase ?
        module._sv_pack_opacity_base(capturedOpacityBase!.id, capturedOpacityBase!.baseId, capturedOpacityBase!.epoch, first, count) : module._sv_pack(first, count);
      const length = module._sv_pack_len();
      if (!pointer || length !== count * stride) throw new Error('Invalid packed scene chunk.');
      if (transformBase && (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > module.HEAPU8.byteLength - length))
        throw new Error('The transform-base packed range is unavailable.');
      if (opacityBase && (!Number.isSafeInteger(pointer) || pointer < 0 || pointer > module.HEAPU8.byteLength - length))
        throw new Error('The opacity-base packed range is unavailable.');
      const bytes = module.HEAPU8.slice(pointer, pointer + length).buffer;
      const chunkId = first;
      const acknowledged = new Promise<void>(resolve => acknowledgements.set(chunkId, resolve));
      send(request, { type: 'chunk', first, count, chunkId, bytes }, [bytes]);
      await acknowledged;
    }
    checkCancelled();
    checkColorBase();
    checkTransformBase();
    checkOpacityBase();
    const pointer = colorBase ? module._sv_color_base_states_ptr(capturedColorBase!.sessionId, capturedColorBase!.baseId, capturedColorBase!.epochId) : transformBase ? module._sv_transform_base_states_ptr(capturedTransformBase!.id, capturedTransformBase!.baseId, capturedTransformBase!.epoch) : opacityBase ?
      module._sv_opacity_base_states_ptr(capturedOpacityBase!.id, capturedOpacityBase!.baseId, capturedOpacityBase!.epoch) : module._sv_states_ptr();
    if (!Number.isSafeInteger(pointer) || pointer < 0 || summary.count > 0 && pointer === 0 || pointer > module.HEAPU8.byteLength - summary.count)
      throw new Error('The scene mask range is unavailable.');
    const bytes = module.HEAPU8.slice(pointer, pointer + summary.count).buffer;
    send(request, { type: 'masks', bytes }, [bytes]);
  }
  if (filterRequest) assertFilterResponse(filterRequest, summary);
  if (historyRequest) assertSelectionHistoryResponse(historyRequest, summary);
  if (transformRequest) assertTransformResponse(transformRequest, summary);
  operationRange?.accept(summary); operationFilter?.accept(summary); operationHistory?.accept(summary); operationTransform?.accept(summary);
  send(request, { type: 'result', summary });
}
context.onmessage = (event: MessageEvent<WorkerRequest | WorkerInitialize>) => {
  if (runtimeFailure) return;
  if (event.data?.type === 'initialize') { void initialize(event.data).catch(fatalRuntime); return; }
  let request = event.data as WorkerRequest;
  const control = request && (['ack', 'cancel', 'map-chunk', 'map-commit', 'source-range'].includes(request.type) || isRecoveryControlType(request.type));
  let authenticatedControl = false;
  const matchesActive = () => {
    if (!active) return false;
    try {
      validateMapEnvelope(request, active);
      return active.operationOwner ? !!request.operationOwner &&
        sameOperationOwner(validateOperationOwner(request.operationOwner), active.operationOwner) : request.operationOwner === undefined;
    } catch { return false; }
  };
  try {
    validateMapEnvelope(request);
    if (request.type === 'command' && isSelectionRangeCommand(request.command))
      request = { ...request, command: captureSelectionRangeCommand(request.command) };
    if (request.type === 'command' && isFilterCommandName(request.command))
      request = { ...request, command: captureSelectionFilterCommand(request.command) };
    if (request.type === 'command' && (TRANSFORM_COMMANDS as readonly string[]).includes(request.command.command))
      request = { ...request, command: captureTransformCommand(request.command) };
    if (!['operation', 'ack', 'cancel', 'map-chunk', 'map-commit', 'source-load', 'source-group-load', 'source-range', 'command', 'live-preview', 'export', 'export-plan', 'scene-export-plan', 'stream', 'geometry-stream', 'masks', 'selection-map', 'recovery-export', 'recovery-restore'].includes(request.type) && !isRecoveryControlType(request.type)) throw new Error('Unknown scene message type.');
    if (initializationState !== 'ready' || !module) throw new Error('The scene worker is not ready. Initialize a compatible build first.');
    if (isRecoveryControlType(request.type)) {
      // Authenticate recoveryId as well as the envelope before malformed phase
      // data gains any authority over this pump. Late/foreign controls vanish.
      if (!recoveryOwner || !authenticRecoveryControl(request, recoveryOwner.request)) return;
      authenticatedControl = true;
      receiveRecovery(request as Envelope & RecoveryControl); return;
    }
    if (request.type === 'ack' || request.type === 'cancel' || request.type === 'map-chunk' || request.type === 'map-commit' || request.type === 'source-range') {
      if (!active) return;
      if ((active.type === 'source-load' || active.type === 'source-group-load') && sourceTerminal) return;
      validateMapEnvelope(request, active);
      if (active.operationOwner ? !request.operationOwner ||
          !sameOperationOwner(validateOperationOwner(request.operationOwner), active.operationOwner) : request.operationOwner !== undefined)
        throw new Error('The control message belongs to a different edit operation.');
      authenticatedControl = true;
      if (recoveryOwner) {
        if (request.type === 'cancel') { abortRecovery(recoveryOwner, cancellation()); return; }
        throw new Error('Invalid recovery transfer message family.');
      }
      if (active.type === 'source-load' || active.type === 'source-group-load') {
        if (request.type === 'cancel') { abortSource(cancellation()); return; }
        if (request.type !== 'source-range') throw new Error('Invalid source transfer message family.');
        receiveSource(request); return;
      }
      if (request.type === 'source-range') throw new Error('Invalid source transfer message family.');
      if (request.type === 'ack') {
        if (active.type === 'geometry-stream' && (geometryAcknowledgement === undefined || request.chunkId !== geometryAcknowledgement || !acknowledgements.has(request.chunkId)))
          throw new Error('Invalid geometry chunk acknowledgement.');
        acknowledgements.get(request.chunkId)?.(); acknowledgements.delete(request.chunkId); return;
      }
      if (request.type === 'cancel') {
        cancelled = true; inbound?.reject(cancellation()); inbound = undefined;
        for (const acknowledge of acknowledgements.values()) acknowledge();
        acknowledgements.clear(); return;
      }
      const wait = inbound;
      if (!wait || request.type !== wait.type || request.mapId !== wait.mapId) throw new Error('Invalid selection map transfer phase.');
      if (request.type === 'map-chunk' && (request.offset !== wait.offset || !(request.bytes instanceof ArrayBuffer) || request.bytes.byteLength !== wait.length))
        throw new Error('Invalid selection map transfer range.');
      inbound = undefined; wait.resolve(request); return;
    }
    if ((active?.type === 'source-load' || active?.type === 'source-group-load') && request.requestId === active.requestId && !sourceTerminal)
      throw new Error('Invalid source transfer message family.');
  } catch (error) {
    // A late/foreign control has no authority to cancel the active pump, nor
    // to send an error using the active caller's request identity.
    if (control && !authenticatedControl && (recoveryOwner || isRecoveryControlType(request?.type) || active?.operationOwner || request?.operationOwner)) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    if (recoveryOwner) {
      if (authenticatedControl) abortRecovery(recoveryOwner, failure);
      else if (request && typeof request === 'object') {
        // A foreign refusal waits for owner cleanup; ordinary telemetry must
        // never traverse a graph locked by native recovery preparation/import.
        queue = queue.then(() => send(request, { type: 'error', error: failure.message })).catch(fatalRuntime);
      }
      return;
    }
    if (active?.type === 'source-load' || active?.type === 'source-group-load') {
      if (!sourceTerminal && matchesActive()) {
        try { abortSource(failure); } catch { cleanupFailed = true; }
      } else { try { send(request, { type: 'error', error: failure.message }); } catch (sendError) { fatalRuntime(sendError); } }
    }
    else if ((active?.type === 'selection-map' || active?.type === 'geometry-stream') &&
        (active.operationOwner || request.operationOwner ? matchesActive() : request?.requestId === active.requestId)) {
      cancelled = true; controlError = failure; inbound?.reject(failure); inbound = undefined;
      for (const acknowledge of acknowledgements.values()) acknowledge(); acknowledgements.clear();
    }
    else if (request && typeof request === 'object') {
      // A synchronous message refusal bypasses the queued operation catch.
      // Observe transport/telemetry failure here as well, so retirement gets
      // one fatal task rather than a second uncaught handler exception.
      try { send(request, { type: 'error', error: failure.message }); }
      catch (sendError) { fatalRuntime(sendError); }
    }
    return;
  }
  queue = queue.then(() => handle(request)).catch((error: unknown) => {
    if (module && summary?.loaded && !cleanupFailed) { try { summary = readSummary(); } catch { cleanupFailed = true; } }
    if (historyRequest && !cleanupFailed) {
      try { assertSelectionHistoryResponse(historyRequest, summary); operationHistory?.accept(summary); }
      catch { cleanupFailed = true; }
    }
    if (transformRequest && !cleanupFailed) {
      try { assertTransformResponse(transformRequest, summary, true); operationTransform?.accept(summary); }
      catch { cleanupFailed = true; }
    }
    if (filterRequest && !cleanupFailed) {
      try { assertFilterResponse(filterRequest, summary, true); operationFilter?.accept(summary); }
      catch { cleanupFailed = true; }
    }
    if (toleranceBefore && !rangeRequest && !cleanupFailed) {
      try { assertToleranceOwnerRetainedOrRetired(toleranceRangeOwner(toleranceBefore), summary); }
      catch { cleanupFailed = true; }
    }
    if (rangeRequest && !cleanupFailed) {
      try {
        if (!sameToleranceRangeOwner(toleranceRangeOwner(rangeRequest.before), toleranceRangeOwner(summary)))
          assertToleranceRangeAcknowledgement(rangeRequest.command, rangeRequest.before, summary);
        operationRange?.accept(summary);
      } catch { cleanupFailed = true; }
    }
    else if (operationRange && !cleanupFailed) {
      try { operationRange.assertRetained(summary); operationRange.accept(summary); }
      catch { cleanupFailed = true; }
    }
    send(request, { type: 'error', error: error instanceof Error ? error.message : String(error),
      cancelled: error instanceof DOMException && error.name === 'AbortError', summary: module && summary?.loaded ? summary : undefined, cleanupFailed });
    if (request.type === 'source-load' || request.type === 'source-group-load') sourceTerminal = true;
  }).finally(() => { active = undefined; inbound = undefined; sourceOwner = undefined; rangeRequest = undefined; filterRequest = undefined; toleranceBefore = undefined; historyRequest = undefined; transformRequest = undefined; geometryAcknowledgement = undefined; acknowledgements.clear(); })
    .catch(fatalRuntime);
};
