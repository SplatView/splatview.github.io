import { BUILD_ID, PROTOCOL_VERSION, acceptsResult, sameRevision, type LivePreviewOutcome, type NativeAllocationSnapshot, type NativeSummary, type Revision, type SceneCommand, type WorkerRequest, type WorkerResponse } from './types';
import { livePreviewOutcome } from './livePreview';
import { isDuplicateCommand, sameDuplicateRange, validateDuplicateRange, validateDuplicateSummary, type DuplicateRange } from './duplicateProtocol';
import { validateColorSession, type ColorSessionSummary } from './colorProtocol';
import { validateAlignmentSummary } from './alignmentProtocol';
import { validateFloorSummary } from './floorProtocol';
import { assertFilterResponse, assertFilterUnchanged, captureFilterRequest, captureFilterState, captureSelectionFilterCommand,
  filterSummaryState, FilterOperation, isFilterCommandName, isSelectionFilterCommand, validateFilterSummary,
  type FilterRequestProof, type FilterState } from './filterProtocol';
import { assertTransformResponse, assertTransformUnchanged, captureTransformCommand, captureTransformRequest, captureTransformState,
  TRANSFORM_COMMANDS, TransformOperation, validateTransformSummary, type TransformRequestProof, type TransformSessionSummary, type TransformState } from './transformProtocol';
import { assertTransformFocusBinding, assertTransformFocusUnchanged, captureTransformFocusState, transformFocusPoint,
  validateSelectionCommitRevision, validateTransformFocusCommand, type TransformFocusScope, type TransformFocusState } from './transformPivot';
import type { TransformBaseIdentity, TransformVec3 } from './transformProtocol';
import { isOpacityCommand, OPACITY_COMMANDS, validateOpacitySummary, type OpacitySessionSummary } from './opacityProtocol';
import { captureSelectionViewCommand, isBeginColorCommand, type MaskChannel } from './selectionView';
import { isMorphologyRangeCommand, isSelectionMorphologyCommand, validateMorphologyRange } from '../input/selectionMorphology';
import { selectionMapChunk, validateMapEnvelope, validateSelectionMap, type AdoptedSelectionMap, type SelectionMapAdoptionOptions,
  type SelectionMapData, type SelectionMapLayout } from './selectionMap';
import { AdmissionError, assertResourceCredit, resourceLeaseCredit, type ResourceLedger, type ResourceLease } from './resources';
import { NativeHeapAccounting, validateNativeHeapSnapshot, type NativeCoverageUpdate, type NativeHeapSnapshot } from './nativeMemory';
import { validateNativeAllocationCensus, type NativeAllocationCensus } from './allocationCensus';
import { ensureRuntime, runtimeNativeSource } from '../build/runtime';
import type { WorkerBootstrapResponse, WorkerInitialize } from '../build/bootstrap';
import { assertBuildDescriptor, assertNativeIdentity, canonicalJson } from '../build/verification';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import { sameGeometryDescriptor, validateGeometryDescriptor, type GeometryDescriptor } from '../renderer/geometryLayout';
import { geometryChannelCount, geometryDescriptor, validateGeometryChunk } from './geometry';
import { SourceReadBroker } from '../io/readBroker';
import { assertSourceFitsDecodeBudget, sceneFileBytes } from './sceneInputLimits';
import { assertPreparedSogGroup, type PreparedSogGroup } from '../io/sogGroup';
import { GROUP_NATIVE_BUDGET_BYTES, GROUP_NATIVE_WORK_BYTES, groupNativeStageBytes, groupStageBytes, groupTransferBytes, groupWorkerBytes,
  validateGroupSourceDescriptor, validateGroupSourceFingerprint } from './sourceGroup';
import { sourceStageBytes, sourceWorkerBytes, synchronousSourceHook, validateSourceDescriptor, validateSourceFingerprint,
  validateSourceRange, type SourceDescriptor, type SourceLoadOptions, type SourceLoadResult, type SourceRange, type SourceReadDescriptor } from './source';
import { OwnedExportBytes, validateSceneExportPlan, validateSpz4ExportPlan, type SceneExportPlan, type SceneExportOptions,
  type Spz4ExportPlan, type Spz4ExportOptions } from './spz4Export';
import { isAdmittedSceneExportFormat, isSceneExportFormat, type AdmittedSceneExportFormat } from './exportFormats';
import { assertOperationSummary, OperationRestoredError, OperationUncertainError, sameOperationOwner, validateOperationOwner,
  validateOperationReceipt, type OperationAction, type OperationOwner, type OperationReceipt, type OperationRecovery,
  type OperationResolution } from './operationProtocol';
import { RecoveryCheckpointBuilder, assertRecoveryCheckpointBinding, validateRecoveryCheckpointBinding, validateRecoveryCheckpointPlan,
  type PreparedRecoveryCheckpoint, type RecoveryCheckpointBinding, type RecoveryCheckpointPlan,
  type RecoveryCheckpointReader, type RecoveryCheckpointRead, type RecoveryJson } from './recoveryCheckpoint';
import { assertExternalCommitDecision, type ExternalCommitDecision } from './recoveryCoordinator';
import { isRecoveryIntermediateType, validateRecoveryId, validateRecoveryRange, type RecoveryIntermediate } from './recoveryProtocol';
import { assertSelectionHistoryResponse, assertSelectionHistoryUnchanged, captureSelectionHistoryRequest, captureSelectionHistoryState,
  SelectionHistoryOperation, validateUndoSelectionRevision, type SelectionHistoryRequest, type SelectionHistoryState } from './selectionHistory';
import { assertToleranceRangeAcknowledgement, assertToleranceRangeOwnerUnchanged, assertToleranceOwnerRetainedOrRetired, assertToleranceRangeRequest, captureSelectionRangeCommand,
  captureToleranceRangeState, isSelectionRangeCommand, sameToleranceRangeOwner, toleranceRangeOwner,
  validateToleranceRangeSummary, ToleranceRangeOperation, type CapturedSelectionRangeCommand } from './selectionRange';

export type RecoveryCaptureOptions = { ledger: ResourceLedger; binding: RecoveryCheckpointBinding; metadata: RecoveryJson; signal?: AbortSignal };
export type RecoveryRestoreOptions = { binding: RecoveryCheckpointBinding; plan: RecoveryCheckpointPlan; revision: Revision;
  expectedSummary: Pick<NativeSummary, 'kind' | 'count' | 'sourceCount' | 'duplicateRange' | 'shDegree' | 'format'>;
  budgetBytes: number; signal?: AbortSignal };
export type CoreClientRecoverySeed = { revision: Revision; expectedBinding: RecoveryCheckpointBinding };
export type CoreWorkerFailure = Readonly<{ error: Error; operationOwner?: OperationOwner; decision?: ExternalCommitDecision;
  revision: Readonly<Revision>; nativeContentRevision: number; nativeSelectionRevision: number }>;

type RecoveryTransfer = { kind: 'export' | 'restore'; id: string; binding: RecoveryCheckpointBinding;
  plan?: RecoveryCheckpointPlan; builder?: RecoveryCheckpointBuilder; reader?: RecoveryCheckpointReader;
  held?: RecoveryCheckpointRead; rangeSent: boolean; released: boolean; delivering?: Promise<void>;
  accept?: (prepared: PreparedRecoveryCheckpoint) => void; prepared?: PreparedRecoveryCheckpoint;
  capture?: RecoveryCaptureOptions; restore?: RecoveryRestoreOptions;
  exportedState?: Pick<NativeSummary, 'kind' | 'count' | 'sourceCount' | 'duplicateRange' | 'shDegree' | 'format' | 'revision' | 'contentRevision'>;
  exportedRange?: ReturnType<typeof captureToleranceRangeState>; exportedFilter?: FilterState; exportedHistory?: SelectionHistoryState; exportedTransform?: TransformState };
function recoveryIntermediate(response: WorkerResponse): response is Extract<WorkerResponse, { type: RecoveryIntermediate['type'] }> {
  return isRecoveryIntermediateType(response.type);
}

type MapTransfer = { data: SelectionMapData; layout: SelectionMapLayout; lease: ResourceLease; covered?: boolean; check(): void; nextOffset: number; committing: boolean; error?: Error; requestId?: number; cleanupConfirmed: boolean };
type MapOwner = { lease: ResourceLease; retired: boolean; disposeRequested: boolean; disposePromise?: Promise<void> };
type GeometryTransfer = { descriptor: GeometryDescriptor; vertices: NonNullable<Pending['chunk']>; indices: NonNullable<Pending['chunk']>;
  nextVertex: number; nextIndex: number; nextChunk: number; delivering?: Promise<void>; cancelled: boolean; failure?: Error };
type SourceTransfer = {
  descriptor: SourceDescriptor; resources: readonly SourceReadDescriptor[]; brokers: ReadonlyMap<string, SourceReadBroker>;
  resourceIndex: number; resourceOffset: number; transferBytes: number; nativeInputBytes: number; expectedCount?: number;
  check(): void; reserve(bytes: number, own: (lease: ResourceLease) => void): void;
  stage?: ResourceLease; range?: { value: SourceRange; lease?: ResourceLease; sent: boolean };
  nextRange: number; consumedBytes: number; delivering?: Promise<void>; failure?: Error;
  nativeLease?: ResourceLease; nativeInput: boolean; finalizing: boolean; covered: boolean; joined: Promise<void>; join(): void;
  maxSplats: number;
};

function allocationSnapshot(value: unknown): NativeAllocationSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['count,kind,loaded,memoryBytes,selectionMapBytes,selectionMapRetainedIds',
        'count,exportBytes,exportOutputBytes,kind,loaded,memoryBytes,selectionMapBytes,selectionMapRetainedIds'].includes(Object.keys(value).sort().join(',')))
    throw new Error('Invalid native allocation snapshot.');
  const input = value as NativeAllocationSnapshot;
  const { loaded, kind, count, memoryBytes, selectionMapBytes } = input;
  const exportBytes = input.exportBytes ?? 0, exportOutputBytes = input.exportOutputBytes ?? 0;
  const ids = input.selectionMapRetainedIds;
  if (typeof loaded !== 'boolean' || ![0, 1, 2].includes(kind) ||
      !Number.isSafeInteger(count) || count < 0 || count > 0xffff_ffff ||
      !Number.isSafeInteger(memoryBytes) || memoryBytes < 0 ||
      !Number.isSafeInteger(selectionMapBytes) || selectionMapBytes < 0 || selectionMapBytes > memoryBytes ||
      !Number.isSafeInteger(exportBytes) || exportBytes < 0 || exportBytes > memoryBytes - selectionMapBytes ||
      !Number.isSafeInteger(exportOutputBytes) || exportOutputBytes < 0 || exportOutputBytes > exportBytes ||
      !Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length ||
      !loaded && count !== 0)
    throw new Error('Invalid native allocation snapshot.');
  return Object.freeze({ loaded, kind, count, memoryBytes, selectionMapBytes, exportBytes, exportOutputBytes,
    selectionMapRetainedIds: Object.freeze([...ids]) as unknown as number[] });
}

function sameAllocation(a: NativeAllocationSnapshot, summary: NativeSummary): boolean {
  return a.loaded === summary.loaded && a.kind === summary.kind && a.count === summary.count &&
    a.memoryBytes === summary.memoryBytes && a.selectionMapBytes === summary.selectionMapBytes &&
    a.exportBytes === (summary.exportBytes ?? 0) && a.exportOutputBytes === (summary.exportOutputBytes ?? 0) &&
    a.selectionMapRetainedIds.length === summary.selectionMapRetainedIds.length &&
    a.selectionMapRetainedIds.every((id, index) => id === summary.selectionMapRetainedIds[index]);
}

type Pending = {
  family: WorkerRequest['type'];
  base: Revision; resolve: (value: NativeSummary | ArrayBuffer | LivePreviewOutcome | SourceLoadResult | Spz4ExportPlan | SceneExportPlan | OperationResolution | OperationOwner) => void; reject: (reason: Error) => void;
  chunk?: (first: number, count: number, bytes: ArrayBuffer) => Promise<void>;
  masks?: (bytes: ArrayBuffer) => void;
  maskDelivered?: boolean;
  maskChannel?: MaskChannel;
  maskSelected?: number;
  maskVisible?: number;
  map?: MapTransfer;
  geometry?: GeometryTransfer;
  source?: SourceTransfer;
  delivering?: Promise<void>;
  commandSignal?: AbortSignal;
  sceneExport?: { format: AdmittedSceneExportFormat; scope: number };
  operationOwner?: OperationOwner;
  operationAction?: OperationAction;
  operationAccept?: boolean;
  recovery?: RecoveryTransfer;
  touch?: () => void;
  transformFocus?: TransformFocusState;
  transformFocusScope?: TransformFocusScope;
  selectionRange?: { command: CapturedSelectionRangeCommand; before: ReturnType<typeof captureToleranceRangeState> };
  filterRequest?: FilterRequestProof;
  toleranceBefore?: ReturnType<typeof captureToleranceRangeState>;
  historyRequest?: SelectionHistoryRequest;
  transformRequest?: TransformRequestProof;
};
type OwnedOperation = {
  owner: OperationOwner; state: 'created' | 'active' | 'uncertain' | 'terminal' | 'retiring';
  receipt?: OperationReceipt; summary?: NativeSummary;
  decided?: ExternalCommitDecision;
  waiting?: { phase: OperationAction | 'request'; resolve(value: OperationResolution | NativeSummary | OperationOwner): void; reject(error: Error): void };
  retry?: Promise<boolean>;
  retiredRequests: Set<number>;
  rangeProof?: ToleranceRangeOperation;
  rangeOutstanding?: Pending['selectionRange'] | null;
  filterProof?: FilterOperation;
  filterOutstanding?: FilterRequestProof;
  historyProof?: SelectionHistoryOperation;
  historyOutstanding?: SelectionHistoryRequest;
  transformProof?: TransformOperation;
  transformOutstanding?: TransformRequestProof;
};
export class CoreClient {
  private exportOutputLease?: ResourceLease;
  private exportWorkLease?: ResourceLease;
  private lastShDegree = 0;
  private spzPlan?: { value: Spz4ExportPlan; revision: Revision };
  // Nine admitted formats and three validated scopes bound this cache to 27
  // records. Parallel callers can plan distinct scopes before their encoders
  // reach the serial queue without replacing one another's authority.
  private scenePlans = new Map<string, { value: SceneExportPlan; revision: Revision }>();
  private exportJoins = new Set<Promise<void>>();
  private recoveryJoins = new Set<Promise<void>>();
  private worker?: Worker;
  private workerUrl?: string;
  private initialization: Promise<void>;
  private initializationId = crypto.randomUUID();
  private initializationAbort = new AbortController();
  private initializationDone = false;
  private bootstrap?: { resolve(): void; reject(error: Error): void; mode: WorkerInitialize['mode'] };
  private sequence = 0;
  private operationSequence = 0;
  private retiredOperationThrough = 0;
  private operation?: OwnedOperation;
  private operations: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private fault?: Error;
  private lastContentRevision = -1;
  private lastSelectionRevision = -1;
  private lastTopology?: { count: number; sourceCount: number; duplicateRange: DuplicateRange };
  private lastGeometry?: GeometryDescriptor;
  private lastColorSession: ColorSessionSummary | null = null;
  private lastTransformSession: TransformSessionSummary | null = null;
  private transformRequired = false;
  private lastTransformState?: TransformState;
  private lastTransformFocusState?: TransformFocusState;
  private selectionCommitRevisionRequired = false;
  private selectionRangeRequired = false;
  private lastToleranceRangeState?: ReturnType<typeof captureToleranceRangeState>;
  private lastOpacitySession: OpacitySessionSummary | null = null;
  private gaussianAlignmentObserved = false;
  private filterMetadataObserved = false;
  private filterMetadataRequired = false;
  private lastFilterState?: FilterState;
  private historyRequired = false;
  private lastHistoryState?: SelectionHistoryState;
  private pending = new Map<number, Pending>();
  // Retirements outlive pending-map removal and immediate worker termination.
  private sourceOwners = new Set<SourceTransfer>();
  private deliveries = new Set<Promise<void>>();
  private stoppedNativeReleases = new Set<ResourceLease>();
  private lastHeap?: NativeHeapSnapshot;
  private lastCensus?: NativeAllocationCensus;
  private lastAllocation?: NativeAllocationSnapshot;
  private coveragePlanner?: (allocation: NativeAllocationSnapshot) => readonly NativeCoverageUpdate[];
  private nativeWork?: ResourceLease;
  private nativeRetirement?: Promise<void>;
  private mapSequence = 0;
  private mapOwners = new Map<number, MapOwner>();
  private activeMapId: number | null = null;
  private recoverySource?: Pick<RecoveryCheckpointBinding, 'source' | 'subset'>;
  private recoverySeed?: RecoveryCheckpointBinding;
  private liveAuthority = false;
  private failureNotified = false;
  readonly revision: Revision = { documentId: crypto.randomUUID(), sourceGeneration: 1,
    contentRevision: 0, selectionRevision: 0, draftRevision: 0 };
  onProgress?: (stage: string, fraction: number) => void;
  onOperationRecovery?: (recovery: OperationRecovery) => void;
  onWorkerFailure?: (failure: CoreWorkerFailure) => void;
  get failed(): boolean { return this.fault !== undefined; }
  get operationOwner(): OperationOwner | undefined { return this.operation?.owner; }
  get operationResolution(): OperationResolution | undefined {
    const operation = this.operation;
    return operation?.receipt && operation.summary ? Object.freeze({ receipt: operation.receipt, summary: operation.summary }) : undefined;
  }
  onNativeMemoryChanged?: () => void;
  private nativeMemoryNotificationPending = false;
  private notifyNativeMemory(): void {
    if (!this.nativeMemory || this.nativeMemoryNotificationPending) return;
    this.nativeMemoryNotificationPending = true;
    // Publish only after the accounting registry, leases and caller finalizer
    // finish their synchronous transition. Observers cannot reenter a partial
    // H/C/R update, and UI notification never changes admission authority.
    queueMicrotask(() => {
      this.nativeMemoryNotificationPending = false;
      this.onNativeMemoryChanged?.();
    });
  }
  get nativeContentRevision() { return this.lastContentRevision; }
  get nativeAllocationCensus(): NativeAllocationCensus | undefined { return this.lastCensus; }
  constructor(readonly nativeMemory?: NativeHeapAccounting, seed?: CoreClientRecoverySeed) {
    if (seed) {
      const binding = validateRecoveryCheckpointBinding(seed.expectedBinding);
      assertNativeIdentity(binding.core, BUILD_DESCRIPTOR.native.core);
      this.assertRecoveryRevision(seed.revision, binding);
      if (canonicalJson(seed.revision) !== canonicalJson(binding.revision)) throw new Error('The replacement worker must start at the captured recovery revision.');
      Object.assign(this.revision, seed.revision); this.recoverySeed = binding;
    }
    this.initialization = this.initialize().catch(error => {
      const failure = error instanceof Error ? error : new Error(String(error)); this.stopWorker(failure); throw failure;
    });
    // Eager initialization has a rejection observer even if the caller has not
    // admitted a document operation yet. ready() still receives the same error.
    void this.initialization.catch(() => undefined);
  }
  async ready(): Promise<void> {
    await this.initialization;
    if (this.disposed || this.fault) throw this.fault ?? new Error('The scene was closed.');
  }
  private assertRecoveryRevision(revision: Revision, binding: RecoveryCheckpointBinding): void {
    if (!revision || revision.documentId !== binding.revision.documentId || revision.sourceGeneration !== binding.revision.sourceGeneration ||
        Object.keys(revision).sort().join(',') !== 'contentRevision,documentId,draftRevision,selectionRevision,sourceGeneration' ||
        ['contentRevision', 'selectionRevision', 'draftRevision'].some(key => !Number.isSafeInteger(revision[key as keyof Revision]) ||
          Number(revision[key as keyof Revision]) < 0 || Object.is(revision[key as keyof Revision], -0)))
      throw new Error('The recovery revision belongs to another document.');
  }
  getRecoveryBinding(): RecoveryCheckpointBinding {
    if (!this.recoverySource) throw new Error('The scene has no complete source identity for recovery.');
    return validateRecoveryCheckpointBinding({ version: 1, core: BUILD_DESCRIPTOR.native.core,
      ...this.recoverySource, revision: { ...this.revision } });
  }
  private joinRecovery<T>(task: Promise<T>): Promise<T> {
    const joined = task.then(() => undefined, () => undefined);
    this.recoveryJoins.add(joined);
    void joined.then(() => this.recoveryJoins.delete(joined));
    return task;
  }
  captureRecoveryCheckpoint(options: RecoveryCaptureOptions, accept: (prepared: PreparedRecoveryCheckpoint) => void): Promise<NativeSummary> {
    return this.joinRecovery(this.enqueue(async () => { await this.ready(); return this.captureRecoveryDirect(options, accept); }));
  }
  private async captureRecoveryDirect(options: RecoveryCaptureOptions, accept: (prepared: PreparedRecoveryCheckpoint) => void): Promise<NativeSummary> {
    const binding = assertRecoveryCheckpointBinding(options.binding, this.getRecoveryBinding());
    if (typeof accept !== 'function') throw new Error('A recovery checkpoint needs a synchronous acceptance boundary.');
    const transfer: RecoveryTransfer = { kind: 'export', id: crypto.randomUUID(), binding, capture: options, accept,
      rangeSent: false, released: false };
    try {
      return await this.dispatch({ type: 'recovery-export', recoveryId: transfer.id, binding },
        { recovery: transfer, commandSignal: options.signal }) as NativeSummary;
    } finally {
      await transfer.delivering?.catch(() => undefined);
      await transfer.builder?.cancel(); transfer.prepared?.abort();
    }
  }
  restoreRecoveryCheckpoint(reader: RecoveryCheckpointReader, options: RecoveryRestoreOptions): Promise<NativeSummary> {
    return this.joinRecovery(this.enqueue(async () => {
      let transfer: RecoveryTransfer | undefined;
      try {
        await this.ready();
        if (!this.recoverySeed || this.recoverySource || this.lastContentRevision !== -1 || this.operation)
          throw new Error('Recovery requires a fresh, unloaded replacement worker.');
        const binding = assertRecoveryCheckpointBinding(options.binding, this.recoverySeed);
        assertRecoveryCheckpointBinding(reader.description.binding, binding);
        const plan = validateRecoveryCheckpointPlan(options.plan);
        if (canonicalJson(plan) !== canonicalJson(reader.description.plan)) throw new Error('The restore plan changed its accepted checkpoint.');
        this.assertRecoveryRevision(options.revision, binding);
        if (options.revision.contentRevision < binding.revision.contentRevision || options.revision.selectionRevision < binding.revision.selectionRevision ||
            options.revision.draftRevision !== 0) throw new Error('The restore publication revision must preserve or advance the captured document.');
        const expected = options.expectedSummary;
        const expectedFields = ['count', 'duplicateRange', 'format', 'kind', 'shDegree', 'sourceCount'];
        if (!expected || Object.getPrototypeOf(expected) !== Object.prototype || Reflect.ownKeys(expected).length !== expectedFields.length ||
            expectedFields.some(key => { const field = Object.getOwnPropertyDescriptor(expected, key); return !field?.enumerable || !('value' in field); }) ||
            Object.keys(expected).sort().join(',') !== 'count,duplicateRange,format,kind,shDegree,sourceCount' ||
            ![0, 1, 2].includes(expected.kind) || expected.count !== plan.currentLoadedCount || expected.sourceCount !== plan.currentSourceCount ||
            !sameDuplicateRange(validateDuplicateRange(expected.duplicateRange, expected.count, expected.kind === 0), plan.currentDuplicateRange) ||
            !Number.isInteger(expected.shDegree) || expected.shDegree < 0 || expected.shDegree > 3 ||
            typeof expected.format !== 'string' || expected.format !== binding.source.sourceKindHint ||
            !Number.isSafeInteger(options.budgetBytes) || options.budgetBytes < 1 || options.budgetBytes > 0xffff_ffff)
          throw new Error('The restored scene metadata does not match its source.');
        const restore = { ...options, binding, plan, revision: { ...options.revision },
          expectedSummary: { ...expected, duplicateRange: validateDuplicateRange(expected.duplicateRange, expected.count, expected.kind === 0) } };
        transfer = { kind: 'restore', id: crypto.randomUUID(), binding, plan, reader, restore,
          rangeSent: false, released: false };
        return await this.dispatch({ type: 'recovery-restore', recoveryId: transfer.id, binding, plan, budgetBytes: options.budgetBytes },
          { recovery: transfer, commandSignal: options.signal }) as NativeSummary;
      } catch (error) {
        if (transfer) this.stopWorker(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
        await transfer?.delivering?.catch(() => undefined);
        // A consumed ACK or confirmed worker termination is the only boundary
        // at which a transferred copy can return its independent read credit.
        transfer?.held?.release();
        if (transfer) transfer.held = undefined;
        await reader.cancel();
      }
    }));
  }
  createOperation(): OperationOwner {
    if (this.operation || this.disposed || this.fault) throw this.fault ?? new Error('Finish the current edit before starting another operation.');
    if (this.operationSequence === Number.MAX_SAFE_INTEGER) throw new Error('The operation identity space is exhausted. Reopen the scene.');
    const owner = validateOperationOwner({ version: 1, documentId: this.revision.documentId,
      sourceGeneration: this.revision.sourceGeneration, clientGeneration: this.initializationId, operationId: ++this.operationSequence });
    this.operation = { owner, state: 'created', retiredRequests: new Set(),
      ...(this.lastToleranceRangeState ? { rangeProof: new ToleranceRangeOperation(this.lastToleranceRangeState) } : {}),
      ...(this.lastFilterState ? { filterProof: new FilterOperation(this.lastFilterState) } : {}),
      ...(this.lastHistoryState ? { historyProof: new SelectionHistoryOperation(this.lastHistoryState) } : {}),
      ...(this.lastTransformState ? { transformProof: new TransformOperation(this.lastTransformState) } : {}) }; return owner;
  }
  private ownedOperation(owner: OperationOwner): OwnedOperation {
    const validated = validateOperationOwner(owner), operation = this.operation;
    if (!operation || !sameOperationOwner(operation.owner, validated)) throw new Error('The edit operation owner changed.');
    return operation;
  }
  beginOperation(owner: OperationOwner): Promise<NativeSummary> {
    const operation = this.ownedOperation(owner);
    if (operation.state !== 'created') return Promise.reject(new Error('The edit operation has already started.'));
    return this.enqueue(async () => {
      await this.ready(); this.ownedOperation(owner);
      const result = await this.ownedDispatch(operation, 'begin', { type: 'operation', action: 'begin', operationOwner: owner }) as OperationResolution;
      operation.state = 'active'; operation.receipt = result.receipt; operation.summary = result.summary; return result.summary;
    });
  }
  commitOperation(owner: OperationOwner, checkpoint?: RecoveryCaptureOptions & { accept(prepared: PreparedRecoveryCheckpoint): ExternalCommitDecision }): Promise<NativeSummary> {
    const operation = this.ownedOperation(owner);
    return this.enqueue(async () => {
      await this.ready(); this.ownedOperation(owner);
      if (operation.state !== 'active') throw new Error('The edit operation is not ready to commit.');
      if (checkpoint) {
        try {
          await this.joinRecovery(this.captureRecoveryDirect(checkpoint, prepared => {
            const decision = checkpoint.accept(prepared);
            assertExternalCommitDecision(decision, owner, prepared.description);
            this.ownedOperation(owner); operation.decided = decision;
          }));
        } catch (error) {
          // The external decision already owns the successor bytes. A failed
          // terminal cannot turn that successor into a rollback of its parent.
          if (operation.decided) this.stopWorker(error instanceof Error ? error : new Error(String(error)));
          throw error;
        }
      }
      const result = await this.ownedDispatch(operation, 'commit', { type: 'operation', action: 'commit', operationOwner: owner }) as OperationResolution;
      operation.state = 'terminal'; operation.receipt = result.receipt; operation.summary = result.summary; return result.summary;
    });
  }
  rollbackOperation(owner: OperationOwner): Promise<NativeSummary> {
    const operation = this.ownedOperation(owner);
    if (operation.decided) return Promise.reject(new Error('The externally decided edit cannot be rolled back.'));
    if (operation.receipt && ['rolled-back', 'not-started'].includes(operation.receipt.outcome) && operation.summary)
      return Promise.resolve(operation.summary);
    return this.enqueue(async () => {
      await this.ready(); this.ownedOperation(owner);
      if (operation.decided || operation.receipt?.outcome === 'committed') throw new Error('The committed edit cannot be rolled back.');
      const result = await this.ownedDispatch(operation, 'rollback', { type: 'operation', action: 'rollback', operationOwner: owner }) as OperationResolution;
      operation.state = 'terminal'; operation.receipt = result.receipt; operation.summary = result.summary; return result.summary;
    });
  }
  finishOperation(owner: OperationOwner): Promise<void> {
    const operation = this.ownedOperation(owner);
    return this.enqueue(async () => {
      await this.ready(); this.ownedOperation(owner);
      // Even an unused identity must be sealed before retirement. Never infer
      // not-started from a missing transaction or unchanged revision counters.
      if (!operation.receipt || operation.receipt.outcome === 'active') {
        const result = await this.ownedDispatch(operation, 'status', { type: 'operation', action: 'status', operationOwner: owner }) as OperationResolution;
        if (result.receipt.outcome === 'active') throw new Error('Restore the active edit before retiring its owner.');
        operation.receipt = result.receipt; operation.summary = result.summary;
      }
      operation.state = 'retiring';
      await this.ownedDispatch(operation, 'retire', { type: 'operation', action: 'retire', operationOwner: owner });
      this.completeOperation(operation);
    });
  }
  /** Bypasses the parked ordinary queue, but never bypasses worker execution order. */
  retryOperation(owner: OperationOwner): Promise<boolean> {
    const operation = this.ownedOperation(owner);
    if (!operation.waiting) return Promise.resolve(false);
    return this.recoverOperation(operation);
  }
  private completeOperation(operation: OwnedOperation): void {
    if (this.operation !== operation) return;
    this.retiredOperationThrough = operation.owner.operationId; this.operation = undefined;
    this.onOperationRecovery?.({ owner: operation.owner, phase: 'retire', state: 'idle' });
  }
  private ownedDispatch(operation: OwnedOperation, phase: OperationAction | 'request', data: Record<string, unknown>, callbacks: Partial<Pending> = {}) {
    return this.dispatch(data, { ...callbacks, operationOwner: operation.owner,
      operationAction: phase === 'request' ? undefined : phase, operationAccept: true }).catch(error => {
      if (this.disposed || this.fault || phase === 'request' && !(error instanceof OperationUncertainError)) throw error;
      if (operation.waiting) throw new Error('An edit reconciliation is already outstanding.');
      operation.state = phase === 'retire' ? 'retiring' : 'uncertain';
      const parked = new Promise<OperationResolution | NativeSummary | OperationOwner>((resolve, reject) => {
        operation.waiting = { phase, resolve, reject };
      });
      // One automatic attempt; unsuccessful reconciliation deliberately keeps
      // the original caller and all of its candidate/resource owners parked.
      void this.recoverOperation(operation); return parked;
    });
  }
  private operationControl(operation: OwnedOperation, action: Exclude<OperationAction, 'retire'>): Promise<OperationResolution> {
    return this.dispatch({ type: 'operation', action, operationOwner: operation.owner },
      { operationOwner: operation.owner, operationAction: action, operationAccept: false }) as Promise<OperationResolution>;
  }
  private recoverOperation(operation: OwnedOperation): Promise<boolean> {
    if (operation.retry) return operation.retry;
    const waiting = operation.waiting;
    if (!waiting) return Promise.resolve(false);
    const attempt = Promise.resolve().then(async () => {
      this.onOperationRecovery?.({ owner: operation.owner, phase: waiting.phase, state: 'checking' });
      try {
        await this.ready(); this.ownedOperation(operation.owner);
        if (waiting.phase === 'retire') {
          await this.dispatch({ type: 'operation', action: 'retire', operationOwner: operation.owner },
            { operationOwner: operation.owner, operationAction: 'retire', operationAccept: false });
          operation.waiting = undefined; waiting.resolve(operation.owner); return true;
        }
        let result = await this.operationControl(operation, 'status');
        const requireDecidedSuccessor = (resolution: OperationResolution) => {
          if (operation.decided && ['rolled-back', 'not-started', 'expired-conflict'].includes(resolution.receipt.outcome)) {
            // This matching owner's validated native receipt contradicts its
            // external successor. Unknown or missing replies never reach this
            // boundary and keep the live authority available for Retry.
            const error = new Error('The live receipt conflicts with an externally decided successor.');
            this.stopWorker(error); throw error;
          }
        };
        requireDecidedSuccessor(result);
        if (result.receipt.outcome === 'active') result = await this.operationControl(operation, operation.decided ? 'commit' : 'rollback');
        requireDecidedSuccessor(result);
        const { receipt, summary } = result;
        if (receipt.outcome === 'expired-conflict' || receipt.outcome === 'active' || operation.decided && receipt.outcome !== 'committed')
          throw new Error('The edit outcome is still unknown.');
        if (receipt.outcome === 'committed' && waiting.phase !== 'commit' && waiting.phase !== 'status') throw new Error('The retained edit committed at an unexpected boundary.');
        // A retired stream no longer owns acknowledgements, but its callback
        // still owns an upload copy until it actually returns.
        await Promise.all([...this.deliveries].map(delivery => delivery.catch(() => undefined)));
        this.ownedOperation(operation.owner);
        this.acceptSummary(summary); operation.receipt = receipt; operation.summary = summary; operation.state = 'terminal';
        operation.waiting = undefined;
        if (receipt.outcome === 'committed' || waiting.phase === 'rollback' || waiting.phase === 'status') waiting.resolve(result);
        else waiting.reject(new OperationRestoredError(receipt, summary));
        return true;
      } catch (error) {
        if (this.operation === operation && operation.waiting === waiting && !this.fault && !this.disposed)
          this.onOperationRecovery?.({ owner: operation.owner, phase: waiting.phase, state: 'required',
            error: error instanceof Error ? error : new Error(String(error)) });
        return false;
      }
    });
    operation.retry = attempt;
    void attempt.then(() => { if (operation.retry === attempt) operation.retry = undefined; });
    return attempt;
  }
  setNativeCoveragePlanner(planner: (allocation: NativeAllocationSnapshot) => readonly NativeCoverageUpdate[]): void {
    this.coveragePlanner = planner;
  }
  setNativeWork(lease: ResourceLease | undefined): void {
    if (lease && this.nativeMemory && !this.nativeMemory.covers(lease))
      throw new AdmissionError('Native work requires an existing covered admission owner.');
    this.nativeWork = lease;
  }
  updateNativeCoverage(updates: readonly NativeCoverageUpdate[]): void {
    this.nativeMemory?.updateCoverage(updates); this.notifyNativeMemory();
  }
  transferNativeCoverage(updates: readonly NativeCoverageUpdate[]): void {
    if (!this.nativeMemory || !this.worker || this.fault || this.disposed) return;
    this.nativeMemory.transferCoverage(updates, this.lastAllocation?.memoryBytes ?? 0);
    this.notifyNativeMemory();
  }
  releaseNativeCoverage(lease: ResourceLease): void {
    if (!this.nativeMemory || this.nativeMemory.state.retired) { synchronousSourceHook(lease()); this.notifyNativeMemory(); return; }
    // A terminated module cannot send another measurement. Preserve the exact
    // leases until the caller joins reads/uploads/GPU retirement and retires R.
    if (!this.worker || this.fault || this.disposed) { this.stoppedNativeReleases.add(lease); return; }
    this.nativeMemory.releaseCovered(lease);
    this.notifyNativeMemory();
  }
  activateNativeMemory(): void { this.nativeMemory?.activate(); this.liveAuthority = true; this.notifyNativeMemory(); }
  assertNativeAdmission(): void {
    if (this.nativeMemory && this.nativeMemory.state.ledgerOverageBytes > 0)
      throw new AdmissionError('Native memory is retained above the scene budget. Close a scene or finish cleanup before starting more work.');
  }
  private assertDispatchAdmission(data: Record<string, unknown>): void {
    if (!this.nativeMemory || this.nativeMemory.state.ledgerOverageBytes === 0) return;
    if (data.type === 'operation' && ['status', 'rollback', 'retire'].includes(String(data.action))) return;
    if (data.type === 'operation' && data.action === 'commit' && this.nativeWork) return;
    const command = (data.command as SceneCommand | undefined)?.command;
    if (data.type === 'command' && ['summary', 'cancel', 'cancelFloor', 'rollbackTransaction', 'cancelSelection', 'endTolerance', 'selectionMapRelease'].includes(command ?? '')) return;
    if (this.nativeWork && (['stream', 'geometry-stream', 'masks'].includes(String(data.type)) ||
        data.type === 'command' && command === 'commitTransaction')) return;
    this.assertNativeAdmission();
  }
  async retireNativeMemory(): Promise<void> {
    if (!this.nativeRetirement) {
      this.dispose();
      const joins = [...this.sourceOwners].map(source => source.joined).concat([...this.exportJoins], [...this.recoveryJoins]);
      const deliveries = [...this.deliveries];
      this.nativeRetirement = (async () => {
        await Promise.all([...joins, ...deliveries.map(value => value.catch(() => undefined))]);
        this.nativeMemory?.retire();
        this.exportOutputLease?.(); this.exportOutputLease = undefined;
        const failures: unknown[] = [];
        for (const lease of this.stoppedNativeReleases) { try { lease(); } catch (error) { failures.push(error); } }
        this.stoppedNativeReleases.clear();
        this.notifyNativeMemory();
        if (failures.length) throw new AggregateError(failures, 'Native retirement cleanup failed.');
      })();
    }
    return this.nativeRetirement;
  }
  private async initialize() {
    const context = await ensureRuntime(); this.initializationAbort.signal.throwIfAborted();
    if (context.mode === 'development-module-graph' && import.meta.env.DEV) {
      // Keep Vite's literal worker reference: production emits the same bundled
      // worker, then loads only its independently verified bytes below.
      this.worker = new Worker(new URL('../workers/document.worker.ts', import.meta.url), { type: 'module' });
    } else {
      const artifact = context.artifacts.get('document-worker');
      if (!artifact) throw new Error('The verified scene worker is missing.');
      this.workerUrl = URL.createObjectURL(new Blob([artifact.bytes], { type: 'text/javascript' }));
      this.worker = new Worker(this.workerUrl, { type: 'module' });
    }
    this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerBootstrapResponse>) => {
      if (event.data?.type === 'ready' || event.data?.type === 'initialization-failed') this.receiveBootstrap(event.data);
      else if (!this.initializationDone) this.stopWorker(new Error('The scene worker returned data before initialization.'));
      else void this.receive(event.data);
    };
    this.worker.onerror = event => { event.preventDefault(); this.stopWorker(new Error(event.message || 'The scene worker stopped.')); };
    this.worker.onmessageerror = () => this.stopWorker(new Error('The scene worker returned an unreadable result.'));
    const source = runtimeNativeSource(context, 'core');
    const request: WorkerInitialize = { type: 'initialize', initializationId: this.initializationId,
      build: BUILD_DESCRIPTOR, mode: context.mode, assetBase: context.assetBase, source,
      manifest: context.verified?.manifest, manifestUrl: context.verified?.manifestUrl, entryUrl: context.entryUrl };
    const timer = setTimeout(() => this.stopWorker(new Error('The scene worker could not verify this build in time. Reload SplatView.')), 45_000);
    try {
      await new Promise<void>((resolve, reject) => {
        this.bootstrap = { resolve, reject, mode: context.mode };
        this.worker!.postMessage(request);
      });
    } finally { clearTimeout(timer); this.bootstrap = undefined; this.revokeWorkerUrl(); }
  }
  private receiveBootstrap(response: WorkerBootstrapResponse) {
    try {
      if (!this.bootstrap || this.initializationDone || response.initializationId !== this.initializationId)
        throw new Error('Unexpected scene worker initialization response.');
      if (response.allocation !== null) throw new Error('Scene worker initialization returned an unexpected native allocation.');
      if (response.type === 'initialization-failed') {
        if (response.heap !== null) {
          if (response.moduleInitializationId !== this.initializationId) throw new Error('The failed native module changed its initialization identity.');
          const heap = validateNativeHeapSnapshot(response.heap);
          const census = validateNativeAllocationCensus(response.census, heap);
          validateNativeHeapSnapshot(heap, this.lastHeap); validateNativeAllocationCensus(census, heap, this.lastCensus);
          this.nativeMemory?.observe(heap); this.lastHeap = heap; this.lastCensus = census; this.notifyNativeMemory();
        } else if (response.moduleInitializationId !== null || response.census !== null) throw new Error('Invalid failed native module measurement.');
        throw new Error(response.error);
      }
      if (response.mode !== this.bootstrap.mode) throw new Error('The scene worker changed its verification mode.');
      assertBuildDescriptor(response.build, BUILD_DESCRIPTOR); assertNativeIdentity(response.core, BUILD_DESCRIPTOR.native.core);
      this.selectionCommitRevisionRequired = response.core.capabilities.transformPivot === 2;
      this.selectionRangeRequired = response.core.capabilities.colorFillRange === 1;
      this.filterMetadataRequired = response.core.capabilities.selectionFilter === 2;
      this.historyRequired = response.core.capabilities.selectionActions === 2;
      this.transformRequired = response.core.capabilities.proTransformSession === 2;
      const heap = validateNativeHeapSnapshot(response.heap);
      const census = validateNativeAllocationCensus(response.census, heap);
      validateNativeHeapSnapshot(heap, this.lastHeap); validateNativeAllocationCensus(census, heap, this.lastCensus);
      this.nativeMemory?.observe(heap); this.lastHeap = heap; this.lastCensus = census; this.notifyNativeMemory();
      this.initializationDone = true; this.bootstrap.resolve();
    } catch (error) { this.stopWorker(error instanceof Error ? error : new Error(String(error))); }
  }
  private revokeWorkerUrl() {
    if (this.workerUrl) { URL.revokeObjectURL(this.workerUrl); this.workerUrl = undefined; }
  }
  private observeResponse(response: WorkerResponse, pending: Pending | undefined): void {
    validateMapEnvelope(response);
    if (this.selectionCommitRevisionRequired) {
      if ('summary' in response && response.summary !== undefined) validateSelectionCommitRevision(response.summary);
      if (response.type === 'live-preview' && response.outcome.kind === 'published')
        validateSelectionCommitRevision(response.outcome.summary);
    }
    if (this.selectionRangeRequired) {
      if ('summary' in response && response.summary !== undefined) response.summary.toleranceRange = validateToleranceRangeSummary(response.summary);
      if (response.type === 'live-preview' && response.outcome.kind === 'published')
        response.outcome.summary.toleranceRange = validateToleranceRangeSummary(response.outcome.summary);
    }
    if (this.filterMetadataRequired) {
      if ('summary' in response && response.summary !== undefined) response.summary.filter = filterSummaryState(response.summary);
      if (response.type === 'live-preview' && response.outcome.kind === 'published')
        response.outcome.summary.filter = filterSummaryState(response.outcome.summary);
    }
    if (this.historyRequired) {
      if ('summary' in response && response.summary !== undefined) validateUndoSelectionRevision(response.summary);
      if (response.type === 'live-preview' && response.outcome.kind === 'published') validateUndoSelectionRevision(response.outcome.summary);
    }
    if (this.transformRequired) {
      if ('summary' in response && response.summary !== undefined) captureTransformState(response.summary);
      if (response.type === 'live-preview' && response.outcome.kind === 'published') captureTransformState(response.outcome.summary);
    }
    if (response.initializationId !== this.initializationId || response.base.documentId !== this.revision.documentId ||
        response.base.sourceGeneration !== this.revision.sourceGeneration || response.requestId > this.sequence ||
        response.base.contentRevision > this.revision.contentRevision ||
        response.base.selectionRevision > this.revision.selectionRevision || response.base.draftRevision > this.revision.draftRevision)
      throw new Error('The native heap measurement belongs to another scene operation.');
    const heap = validateNativeHeapSnapshot(response.heap);
    const census = validateNativeAllocationCensus(response.census, heap);
    if (recoveryIntermediate(response)) {
      const recovery = pending?.recovery;
      if (!recovery || !('recoveryId' in response) || response.recoveryId !== recovery.id || response.allocation !== null ||
          pending.family !== `recovery-${recovery.kind}`)
        throw new Error('The recovery heap measurement belongs to another checkpoint.');
      validateNativeHeapSnapshot(heap, this.lastHeap); validateNativeAllocationCensus(census, heap, this.lastCensus);
      // A held native plan forbids scene traversal. Measure its actual heap and
      // census, retaining existing coverage without inventing an allocation
      // snapshot or attributing checkpoint bytes to native scene coverage.
      this.lastHeap = heap; this.lastCensus = census;
      this.nativeMemory?.observe(heap); this.notifyNativeMemory(); return;
    }
    const allocation = allocationSnapshot(response.allocation);
    if (allocation.memoryBytes > heap.heapBytes) throw new Error('Native allocations exceed their measured heap.');
    // Recheck copied scalars against the latest committed sequences in case a
    // hostile transport getter reentered while the input fields were copied.
    validateNativeHeapSnapshot(heap, this.lastHeap); validateNativeAllocationCensus(census, heap, this.lastCensus);
    // Commit authentication/sequence synchronously, before any awaited upload,
    // source finalizer or user callback can overlap a newer worker message.
    this.lastHeap = heap; this.lastCensus = census; this.lastAllocation = allocation;
    if (pending?.source && response.type === 'source-load-result') pending.source.finalizing = true;
    if ([...this.sourceOwners].some(source => source.finalizing)) return;
    if (pending?.source && response.type === 'source-range-request') pending.source.nativeInput = true;
    if (pending?.source && response.type === 'error') pending.source.nativeInput = false;
    const updates: NativeCoverageUpdate[] = [];
    if (![...this.sourceOwners].some(source => source.stage)) updates.push(...this.coveragePlanner?.(allocation) ?? []);
    const exported = allocation.exportBytes ?? 0, retainedExport = allocation.exportOutputBytes ?? 0;
    const coveredExport = Math.min(retainedExport, this.exportOutputLease?.bytes ?? 0);
    if (this.exportOutputLease) updates.push({ lease: this.exportOutputLease,
      nextLeaseBytes: this.exportOutputLease.bytes, nativeBytes: coveredExport });
    if (this.exportWorkLease) updates.push({ lease: this.exportWorkLease,
      nextLeaseBytes: this.exportWorkLease.bytes, nativeBytes: Math.min(exported - coveredExport, this.exportWorkLease.bytes) });
    for (const source of this.sourceOwners) if (source.stage) updates.push({ lease: source.stage,
      nextLeaseBytes: source.stage.bytes, nativeBytes: source.nativeInput ? source.nativeInputBytes : 0 });
    const retained = new Set(allocation.selectionMapRetainedIds);
    for (const [id, owner] of this.mapOwners) updates.push({ lease: owner.lease,
      nextLeaseBytes: retained.has(id) ? owner.lease.bytes : 0, nativeBytes: retained.has(id) ? owner.lease.bytes : 0 });
    if (pending?.map) updates.push({ lease: pending.map.lease, nextLeaseBytes: pending.map.lease.bytes,
      nativeBytes: retained.has(pending.map.layout.descriptor.mapId) ? pending.map.layout.nativeBytes : 0 });
    this.nativeMemory?.reconcile(heap, updates);
    if (this.exportOutputLease && !this.exportWorkLease && !exported) {
      this.releaseNativeCoverage(this.exportOutputLease); this.exportOutputLease = undefined;
    }
    for (const source of this.sourceOwners) if (source.stage) source.covered = true;
    if (pending?.map) pending.map.covered = true;
    for (const [id, owner] of this.mapOwners) if (!retained.has(id)) {
      this.releaseNativeCoverage(owner.lease); owner.retired = true; this.mapOwners.delete(id);
    }
    this.notifyNativeMemory();
  }
  private async receive(response: WorkerResponse) {
    if (!this.worker || this.disposed || this.fault) return;
    if (!response || typeof response !== 'object') { this.stopWorker(new Error('The scene worker returned an invalid message.')); return; }
    const pending = this.pending.get(response.requestId);
    // Retired owned transports can arrive after a newer reconciliation sample.
    // Authenticate their scope, then discard them before observing old heap
    // counters or accepting the same native revision a second time.
    if (!pending && response.operationOwner) {
      try {
        validateMapEnvelope(response);
        const owner = validateOperationOwner(response.operationOwner);
        if (response.initializationId !== this.initializationId || owner.documentId !== this.revision.documentId ||
            owner.sourceGeneration !== this.revision.sourceGeneration || owner.clientGeneration !== this.initializationId ||
            response.base.documentId !== owner.documentId || response.base.sourceGeneration !== owner.sourceGeneration || response.requestId > this.sequence)
          throw new Error('The retired edit response belongs to another scene.');
        if (owner.operationId <= this.retiredOperationThrough || this.operation && sameOperationOwner(owner, this.operation.owner) &&
            this.operation.retiredRequests.has(response.requestId)) return;
      } catch (error) { this.stopWorker(error instanceof Error ? error : new Error(String(error))); return; }
    }
    try { this.observeResponse(response, pending); }
    catch (error) {
      // Authentication failure leaves this module's storage unverifiable.
      // Retire it for every family, including nonterminal progress/chunks;
      // ordinary operation cancellation cannot establish a trusted snapshot.
      this.stopWorker(error instanceof Error ? error : new Error(String(error))); return;
    }
    try {
      if (!pending) return;
      validateMapEnvelope(response, { requestId: response.requestId, base: pending.base });
      if (!acceptsResult(response, this.revision) && response.type !== 'error') throw new Error('Discarded an obsolete scene result.');
      if (pending.operationOwner) {
        if (!response.operationOwner || !sameOperationOwner(validateOperationOwner(response.operationOwner), pending.operationOwner))
          throw new OperationUncertainError(pending.operationOwner, pending.operationAction ?? 'request', 'The edit acknowledgement changed its owner.');
        pending.touch?.();
      }
      if (pending.recovery) { pending.touch?.(); await this.receiveRecovery(response, pending); return; }
      if (recoveryIntermediate(response) || response.type === 'recovery-result') throw new Error('Unexpected recovery response family.');
      if (pending.family === 'operation') { this.receiveOperation(response, pending); return; }
      if (response.type === 'operation-result' || response.type === 'operation-retired') throw new Error('Unexpected edit operation response.');
      if (pending.historyRequest && !pending.transformFocus) {
        if ('summary' in response && response.summary !== undefined) assertSelectionHistoryResponse(pending.historyRequest, response.summary);
        if (response.type === 'live-preview' && response.outcome.kind === 'published') assertSelectionHistoryResponse(pending.historyRequest, response.outcome.summary);
      }
      if (pending.filterRequest && !pending.transformFocus) {
        if ('summary' in response && response.summary !== undefined) assertFilterResponse(pending.filterRequest, response.summary, response.type === 'error');
        if (response.type === 'live-preview' && response.outcome.kind === 'published') assertFilterResponse(pending.filterRequest, response.outcome.summary);
      }
      if (pending.transformRequest && !pending.transformFocus) {
        if ('summary' in response && response.summary !== undefined) assertTransformResponse(pending.transformRequest, response.summary, response.type === 'error');
        if (response.type === 'live-preview' && response.outcome.kind === 'published') assertTransformResponse(pending.transformRequest, response.outcome.summary);
      }
      if (pending.toleranceBefore && !pending.selectionRange && !pending.transformFocus) {
        if ('summary' in response && response.summary !== undefined)
          assertToleranceOwnerRetainedOrRetired(toleranceRangeOwner(pending.toleranceBefore), response.summary);
        if (response.type === 'live-preview' && response.outcome.kind === 'published')
          assertToleranceOwnerRetainedOrRetired(toleranceRangeOwner(pending.toleranceBefore), response.outcome.summary);
      }
      if (pending.transformFocus) {
        if (response.operationOwner !== undefined) throw new Error('A transform focus query acquired edit ownership.');
        if (response.type === 'progress') { this.onProgress?.(response.stage, response.fraction); return; }
        if (response.type !== 'result' && response.type !== 'error') throw new Error('The transform focus response family changed.');
        if (response.type === 'error') {
          if (response.summary) assertTransformFocusUnchanged(pending.transformFocus, response.summary);
          this.removePending(response.requestId);
          if (response.cleanupFailed) this.stopWorker(new Error(response.error));
          pending.reject(pending.commandSignal?.aborted && response.cancelled ?
            new DOMException(response.error, 'AbortError') : new Error(response.error)); return;
        }
        assertTransformFocusUnchanged(pending.transformFocus, response.summary);
        transformFocusPoint(response.summary, pending.transformFocusScope);
        this.removePending(response.requestId); pending.resolve(response.summary); return;
      }
      if (pending.source) { await this.receiveSource(response, pending); return; }
      if (response.type === 'source-range-request' || response.type === 'source-range-consumed' || response.type === 'source-load-result')
        throw new Error('Unexpected source response family.');
      if (pending.geometry) { await this.receiveGeometry(response, pending); return; }
      if (response.type === 'geometry-chunk') throw new Error('Unexpected geometry response family.');
      if (response.type === 'live-preview') {
        if (pending.family !== 'live-preview') throw new Error('Unexpected live selection response.');
        const outcome = livePreviewOutcome(response.outcome);
        if (outcome.kind === 'published') this.acceptSummary(outcome.summary);
        this.removePending(response.requestId); pending.resolve(outcome); return;
      }
      if (pending.family === 'live-preview' && response.type !== 'error') throw new Error('The live selection response family changed.');
      if (response.type === 'map-chunk-request' || response.type === 'map-ready') {
        const map = pending.map;
        if (!map || response.mapId !== map.layout.descriptor.mapId) throw new Error('Unexpected selection map transfer response.');
        if (map.error) return;
        map.check();
        if (response.type === 'map-ready') {
          if (map.nextOffset !== map.layout.payloadBytes) throw new Error('Selection map commit arrived before its channels.');
          map.committing = true;
          this.post({ type: 'map-commit', mapId: response.mapId }, response.requestId, [], pending.base, pending.operationOwner);
        } else {
          if (response.offset !== map.nextOffset || response.length !== Math.min(map.layout.chunkBytes, map.layout.payloadBytes - map.nextOffset))
            throw new Error('Invalid selection map transfer range.');
          const bytes = selectionMapChunk(map.data, map.layout, response.offset, response.length);
          this.post({ type: 'map-chunk', mapId: response.mapId, offset: response.offset, bytes }, response.requestId, [bytes], pending.base, pending.operationOwner);
          map.nextOffset += response.length;
        }
        return;
      }
      if (response.type === 'progress') { this.onProgress?.(response.stage, response.fraction); return; }
      if (response.type === 'chunk') {
        const delivering = Promise.resolve().then(() => pending.chunk?.(response.first, response.count, response.bytes));
        pending.delivering = delivering; this.deliveries.add(delivering);
        try { await delivering; }
        finally { this.deliveries.delete(delivering); if (pending.delivering === delivering) pending.delivering = undefined; }
        if (!this.worker || this.disposed || this.fault || this.pending.get(response.requestId) !== pending) return;
        this.post({ type: 'ack', chunkId: response.chunkId }, response.requestId, [], pending.base, pending.operationOwner); return;
      }
      if (response.type === 'masks') {
        if (!pending.masks || pending.maskDelivered || !(response.bytes instanceof ArrayBuffer) ||
            response.bytes.byteLength !== response.allocation.count || new Uint8Array(response.bytes).some(value => value > 2))
          throw new Error('The scene worker returned an invalid mask channel.');
        const values = new Uint8Array(response.bytes);
        pending.maskSelected = 0; pending.maskVisible = 0;
        for (const value of values) { if (value === 1) pending.maskSelected++; if (value !== 2) pending.maskVisible++; }
        pending.maskDelivered = true; pending.masks(response.bytes); return;
      }
      if (response.type === 'export-plan') {
        if (pending.family !== 'export-plan') throw new Error('Unexpected export plan response.');
        const plan = validateSpz4ExportPlan(response.plan);
        if (plan.count !== response.summary.count || plan.shDegree !== response.summary.shDegree ||
            !response.summary.loaded || response.summary.kind !== 0 || response.summary.pending)
          throw new Error('The export plan belongs to another scene.');
        this.acceptSummary(response.summary); this.spzPlan = { value: plan, revision: { ...this.revision } };
        this.removePending(response.requestId); pending.resolve(plan); return;
      }
      if (pending.family === 'export-plan' && response.type !== 'error') throw new Error('The export plan response family changed.');
      if (response.type === 'scene-export-plan') {
        if (pending.family !== 'scene-export-plan' || !pending.sceneExport) throw new Error('Unexpected scene export plan response.');
        const plan = validateSceneExportPlan(response.plan);
        if (plan.format !== pending.sceneExport.format || plan.scope !== pending.sceneExport.scope ||
            plan.count !== response.summary.count || plan.shDegree !== response.summary.shDegree ||
            !response.summary.loaded || response.summary.kind !== 0 || response.summary.pending)
          throw new Error('The export plan belongs to another scene, format or scope.');
        this.acceptSummary(response.summary);
        this.scenePlans.set(`${plan.format}/${plan.scope}`, { value: plan, revision: { ...this.revision } });
        this.removePending(response.requestId); pending.resolve(plan); return;
      }
      if (pending.family === 'scene-export-plan' && response.type !== 'error') throw new Error('The scene export plan response family changed.');
      if (pending.family === 'export' && response.type !== 'error' &&
          (response.type !== 'output' || !(response.bytes instanceof ArrayBuffer) || !response.bytes.byteLength)) {
        const error = new Error('The export response family or output bytes changed.');
        this.stopWorker(error); throw error;
      }
      if (response.type === 'output' && pending.family !== 'export') {
        const error = new Error('Unexpected export output response.');
        this.stopWorker(error); throw error;
      }
      this.removePending(response.requestId);
      if (response.type === 'error') {
        if (response.summary) {
          if (pending.selectionRange) this.authenticateRangeRequest(pending.selectionRange, response.summary, true);
          else if (this.selectionRangeRequired && this.lastToleranceRangeState && response.summary.toleranceRange !== null)
            assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(this.lastToleranceRangeState), response.summary);
          response.summary.duplicateRange = this.validateDuplicateTopology(response.summary);
          if (response.summary.morphologyRange !== undefined) {
            response.summary.morphologyRange = validateMorphologyRange(response.summary.morphologyRange);
            if (response.summary.morphologyRange && (!response.summary.loaded || response.summary.kind !== 0))
              throw new Error('The morphology range belongs to another scene kind.');
          }
          if (response.summary.loaded === false && response.summary.kind === 0 && response.summary.count === 0 &&
              response.summary.floor === null && response.summary.pending === undefined) response.summary.pending = false;
          response.summary.floor = validateFloorSummary(response.summary.floor, { loadedCount: response.summary.count, pending: response.summary.pending });
          if ((!response.summary.loaded || response.summary.kind !== 0) && response.summary.floor)
            throw new Error('The scene worker returned an invalid retired floor owner.');
          if (response.summary.filter !== undefined || this.filterMetadataObserved) {
            response.summary.filter = validateFilterSummary(response.summary.filter);
            if (response.summary.filter && (!response.summary.loaded || response.summary.kind !== 0 || response.summary.selectionDraft))
              throw new Error('The scene worker returned an invalid retained filter owner.');
          }
          response.summary.transformSession = validateTransformSummary(response.summary.transformSession);
          response.summary.opacitySession = validateOpacitySummary(response.summary.opacitySession);
          if (response.summary.opacitySession && (!response.summary.loaded || response.summary.kind !== 0 || response.summary.selectionDraft ||
            response.summary.filter || response.summary.colorSession || response.summary.transformSession))
            throw new Error('The scene worker returned an invalid retained opacity owner.');
          if (response.summary.transformSession && (!response.summary.loaded || response.summary.kind !== 0 ||
            response.summary.selectionDraft || response.summary.filter || response.summary.colorSession))
            throw new Error('The scene worker returned an invalid retained transform owner.');
          this.reconcileMaps(response.summary);
          if (this.selectionRangeRequired) this.lastToleranceRangeState = captureToleranceRangeState(response.summary);
          this.operation?.rangeProof?.accept(response.summary);
          if (this.filterMetadataRequired) this.lastFilterState = captureFilterState(response.summary);
          this.operation?.filterProof?.accept(response.summary);
          if (this.historyRequired) this.lastHistoryState = captureSelectionHistoryState(response.summary);
          this.operation?.historyProof?.accept(response.summary);
          if (this.transformRequired) {
            this.lastTransformState = captureTransformState(response.summary); this.lastTransformSession = this.lastTransformState.transformSession;
            this.operation?.transformProof?.accept(response.summary);
          }
          if (this.operation) this.operation.transformOutstanding = undefined;
          if (this.operation) this.operation.historyOutstanding = undefined;
          if (this.operation) { this.operation.rangeOutstanding = undefined; this.operation.filterOutstanding = undefined; }
        }
        if (pending.map) pending.map.cleanupConfirmed = Boolean(response.summary && !response.summary.selectionMapRetainedIds.includes(pending.map.layout.descriptor.mapId));
        const error = pending.map?.error ?? (pending.commandSignal?.aborted && response.cancelled ?
          new DOMException(response.error, 'AbortError') : new Error(response.error));
        if (response.cleanupFailed) this.stopWorker(error);
        pending.reject(error); return;
      }
      const summary = response.summary;
      if (pending.selectionRange) this.authenticateRangeRequest(pending.selectionRange, summary);
      if (pending.masks && !pending.maskDelivered) throw new Error('The scene worker did not return its requested mask channel.');
      if (pending.masks && (pending.maskVisible !== summary.visible ||
          (pending.maskChannel === undefined || pending.maskChannel === 'document') && pending.maskSelected !== summary.selected))
        throw new Error('The scene worker mask channel disagrees with its acknowledged selection.');
      this.acceptSummary(summary);
      if (this.operation) { this.operation.rangeOutstanding = undefined; this.operation.filterOutstanding = undefined; }
      pending.resolve(response.type === 'output' ? response.bytes : response.summary);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!pending) { this.stopWorker(failure); return; }
      if (pending.recovery) {
        this.stopWorker(failure); pending.reject(failure); return;
      }
      if (pending.transformFocus) {
        // Invalid readonly authority must retire the native job as well as its
        // transport. Merely dropping this pending record could release query
        // work credit while the worker still owns a cooperative scan.
        this.stopWorker(failure); pending.reject(failure); return;
      }
      if (pending.operationOwner && (pending.family === 'operation' || failure instanceof OperationUncertainError)) {
        this.removePending(response.requestId);
        pending.reject(failure instanceof OperationUncertainError ? failure : new OperationUncertainError(pending.operationOwner,
          pending.operationAction ?? 'request', failure.message)); return;
      }
      if (pending.source || response.type === 'source-range-request' || response.type === 'source-range-consumed' || response.type === 'source-load-result') {
        this.stopWorker(failure); pending.reject(failure); return;
      }
      if (pending.geometry) {
        pending.geometry.failure ??= failure; pending.geometry.cancelled = true;
        // The callback owns the transferred copy until it returns, including
        // when cancellation or a bad terminal arrives while upload is held.
        await pending.geometry.delivering?.catch(() => undefined);
        this.stopWorker(pending.geometry.failure); pending.reject(pending.geometry.failure); return;
      }
      if (pending.family === 'live-preview' || response.type === 'live-preview' || response.type === 'geometry-chunk' || response.type === 'masks' || response.type === 'error' || response.type === 'result' || response.type === 'output') {
        this.stopWorker(failure); pending.reject(failure); return;
      }
      if (pending.map && this.pending.has(response.requestId)) { this.cancelMap(response.requestId, pending, failure); return; }
      try { this.post({ type: 'cancel' }, response.requestId, [], pending.base, pending.operationOwner); } catch { this.stopWorker(failure); }
      this.removePending(response.requestId); pending.reject(failure);
    }
  }
  private async receiveRecovery(response: WorkerResponse, pending: Pending): Promise<void> {
    const recovery = pending.recovery!;
    const current = () => {
      if (!this.worker || this.disposed || this.fault || this.pending.get(response.requestId) !== pending)
        throw this.fault ?? new Error('The recovery checkpoint owner was retired.');
      pending.commandSignal?.throwIfAborted();
    };
    if (response.type === 'error') {
      // The worker emits this only after releasing/cancelling its native owner.
      // A simultaneous Web Crypto/read callback still owns its JS copy.
      await recovery.delivering?.catch(() => undefined);
      if (this.selectionRangeRequired && recovery.kind === 'export' && response.summary && this.lastToleranceRangeState)
        assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(this.lastToleranceRangeState), response.summary);
      if (this.filterMetadataRequired && recovery.kind === 'export' && response.summary && this.lastFilterState)
        assertFilterUnchanged(this.lastFilterState.filter, response.summary);
      if (this.historyRequired && recovery.kind === 'export' && response.summary && this.lastHistoryState)
        assertSelectionHistoryUnchanged(this.lastHistoryState, response.summary);
      if (this.transformRequired && recovery.kind === 'export' && response.summary && this.lastTransformState)
        assertTransformUnchanged(this.lastTransformState.transformSession, response.summary);
      recovery.held?.release(); recovery.held = undefined;
      this.removePending(response.requestId);
      const error = response.cancelled ? new DOMException(response.error, 'AbortError') : new Error(response.error);
      if (response.cleanupFailed) this.stopWorker(error);
      pending.reject(error); return;
    }
    if (!recoveryIntermediate(response) && response.type !== 'recovery-result') throw new Error('The recovery response family changed.');
    if (!('recoveryId' in response) || validateRecoveryId(response.recoveryId) !== recovery.id) throw new Error('The recovery response changed its checkpoint owner.');
    current();
    if (response.type === 'recovery-plan') {
      if (recovery.kind !== 'export' || recovery.plan || recovery.delivering) throw new Error('Unexpected recovery export plan.');
      const plan = validateRecoveryCheckpointPlan(response.plan), summary = response.summary;
      if (this.selectionRangeRequired && this.lastToleranceRangeState)
        assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(this.lastToleranceRangeState), summary);
      if (this.filterMetadataRequired && this.lastFilterState) assertFilterUnchanged(this.lastFilterState.filter, summary);
      if (this.historyRequired && this.lastHistoryState) assertSelectionHistoryUnchanged(this.lastHistoryState, summary);
      if (this.transformRequired && this.lastTransformState) assertTransformUnchanged(this.lastTransformState.transformSession, summary);
      summary.duplicateRange = validateDuplicateSummary(summary);
      if (summary.ok !== true || !summary.loaded || summary.sourceCount !== plan.currentSourceCount ||
          summary.count !== plan.currentLoadedCount || !sameDuplicateRange(summary.duplicateRange, plan.currentDuplicateRange) ||
          summary.format !== recovery.binding.source.sourceKindHint ||
          plan.actualRevision !== summary.revision || plan.contentRevision !== summary.contentRevision ||
          summary.revision !== this.lastSelectionRevision || summary.contentRevision !== this.lastContentRevision)
        throw new Error('The recovery plan belongs to another native scene state.');
      const options = recovery.capture!;
      recovery.builder = new RecoveryCheckpointBuilder(options.ledger, recovery.binding, recovery.binding, plan, options.metadata);
      recovery.plan = plan;
      recovery.exportedState = { kind: summary.kind, count: summary.count, sourceCount: summary.sourceCount, shDegree: summary.shDegree,
        duplicateRange: summary.duplicateRange, format: summary.format, revision: summary.revision, contentRevision: summary.contentRevision };
      if (this.selectionRangeRequired) recovery.exportedRange = captureToleranceRangeState(summary);
      if (this.filterMetadataRequired) recovery.exportedFilter = captureFilterState(summary);
      if (this.historyRequired) recovery.exportedHistory = captureSelectionHistoryState(summary);
      if (this.transformRequired) recovery.exportedTransform = captureTransformState(summary);
      this.post({ type: 'recovery-proceed', recoveryId: recovery.id }, response.requestId, [], pending.base, pending.operationOwner); return;
    }
    if (response.type === 'recovery-chunk') {
      if (recovery.kind !== 'export' || !recovery.builder || recovery.released || recovery.delivering)
        throw new Error('Unexpected recovery export chunk.');
      const range = validateRecoveryRange({ index: response.index, offset: response.offset, length: response.length }, recovery.builder.nextRange);
      const delivering = (async () => {
        await recovery.builder!.append(range, response.bytes); current();
        this.post({ type: 'recovery-ack', recoveryId: recovery.id, ...range }, response.requestId, [], pending.base, pending.operationOwner);
      })();
      recovery.delivering = delivering; this.deliveries.add(delivering);
      try { await delivering; }
      finally { this.deliveries.delete(delivering); if (recovery.delivering === delivering) recovery.delivering = undefined; }
      return;
    }
    if (response.type === 'recovery-exported') {
      if (recovery.kind !== 'export' || !recovery.builder || recovery.builder.nextRange || recovery.released || recovery.delivering)
        throw new Error('Recovery export ended before all admitted chunks.');
      const delivering = (async () => {
        const prepared = await recovery.builder!.prepare(); recovery.prepared = prepared; current();
        // No await is allowed between accepting the successor bytes, recording
        // the caller's irreversible decision, and releasing the native plan.
        synchronousSourceHook(recovery.accept!(prepared)); current();
        recovery.released = true;
        this.post({ type: 'recovery-release', recoveryId: recovery.id }, response.requestId, [], pending.base, pending.operationOwner);
      })();
      recovery.delivering = delivering; this.deliveries.add(delivering);
      try { await delivering; }
      finally { this.deliveries.delete(delivering); if (recovery.delivering === delivering) recovery.delivering = undefined; }
      return;
    }
    if (response.type === 'recovery-range-request') {
      if (recovery.kind !== 'restore' || !recovery.reader || recovery.held || recovery.delivering || recovery.released)
        throw new Error('Unexpected recovery restore range request.');
      const range = validateRecoveryRange({ index: response.index, offset: response.offset, length: response.length }, recovery.reader.nextRange);
      const delivering = (async () => {
        const chunk = await recovery.reader!.read(range); recovery.held = chunk; current();
        this.post({ type: 'recovery-range', recoveryId: recovery.id, ...range, bytes: chunk.bytes }, response.requestId,
          [chunk.bytes], pending.base, pending.operationOwner);
        recovery.rangeSent = true;
      })();
      recovery.delivering = delivering; this.deliveries.add(delivering);
      try { await delivering; }
      finally { this.deliveries.delete(delivering); if (recovery.delivering === delivering) recovery.delivering = undefined; }
      return;
    }
    if (response.type === 'recovery-range-consumed') {
      if (recovery.kind !== 'restore' || !recovery.held || !recovery.rangeSent || recovery.delivering)
        throw new Error('Unexpected recovery restore consumption acknowledgement.');
      const held = recovery.held;
      validateRecoveryRange({ index: response.index, offset: response.offset, length: response.length },
        { index: held.index, offset: held.offset, length: held.length });
      held.release(); recovery.held = undefined; recovery.rangeSent = false; return;
    }
    if (response.type !== 'recovery-result' || response.action !== recovery.kind || recovery.delivering)
      throw new Error('The recovery terminal changed its action or outstanding copy.');
    if (recovery.kind === 'export') {
      if (!recovery.released) throw new Error('Recovery export completed before its acceptance boundary.');
      const expected = recovery.exportedState!;
      if (recovery.exportedRange) assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(recovery.exportedRange), response.summary);
      if (recovery.exportedFilter) assertFilterUnchanged(recovery.exportedFilter.filter, response.summary);
      if (recovery.exportedHistory) assertSelectionHistoryUnchanged(recovery.exportedHistory, response.summary);
      if (recovery.exportedTransform) assertTransformUnchanged(recovery.exportedTransform.transformSession, response.summary);
      if ((Object.keys(expected) as (keyof typeof expected)[]).some(key => key === 'duplicateRange' ?
        !sameDuplicateRange(validateDuplicateSummary(response.summary), expected.duplicateRange) : response.summary[key] !== expected[key]))
        throw new Error('The native scene changed while its recovery plan was held.');
    } else {
      const { plan, expectedSummary, revision, budgetBytes } = recovery.restore!;
      const summary = response.summary;
      if (recovery.held || recovery.reader!.nextRange || !summary.loaded || !summary.ok || summary.transaction || summary.pending ||
          summary.selectionDraft || summary.revision !== plan.revision || summary.contentRevision !== plan.contentRevision ||
          summary.memoryBytes > budgetBytes || !this.lastAllocation || !sameAllocation(this.lastAllocation, summary) ||
          summary.selectionMapBytes !== 0 || summary.selectionMapId !== null ||
          summary.pendingSelectionMapId !== null || summary.selectionMapRetainedIds.length !== 0 || summary.floor !== null ||
          summary.filter !== null || summary.toleranceSessionId != null || summary.toleranceMapId != null || summary.toleranceRange !== null ||
          this.transformRequired && summary.transformSession?.kind === 'gizmo' ||
          this.historyRequired && summary.undoSelectionRevision !== 0 ||
          summary.count !== plan.currentLoadedCount || summary.sourceCount !== plan.currentSourceCount ||
          !sameDuplicateRange(validateDuplicateSummary(summary), plan.currentDuplicateRange) ||
          (Object.keys(expectedSummary) as (keyof typeof expectedSummary)[]).some(key => key === 'duplicateRange' ?
            !sameDuplicateRange(summary.duplicateRange, expectedSummary.duplicateRange) : summary[key] !== expectedSummary[key]))
        throw new Error('The replacement worker did not restore the accepted native checkpoint.');
      await recovery.reader!.finish(); current(); recovery.released = true;
      Object.assign(this.revision, revision);
      this.lastContentRevision = plan.contentRevision; this.lastSelectionRevision = plan.revision;
      this.recoverySource = { source: recovery.binding.source, subset: recovery.binding.subset };
      this.recoverySeed = undefined;
    }
    this.acceptSummary(response.summary); this.removePending(response.requestId); pending.resolve(response.summary);
  }
  private receiveOperation(response: WorkerResponse, pending: Pending): void {
    const owner = pending.operationOwner!, action = pending.operationAction!;
    if (response.type === 'error') throw new OperationUncertainError(owner, action, response.error);
    if (action === 'retire') {
      if (response.type !== 'operation-retired' || !sameOperationOwner(validateOperationOwner(response.operationOwner), owner))
        throw new Error('The operation retirement acknowledgement changed its owner.');
      this.removePending(response.requestId); pending.resolve(owner); return;
    }
    if (response.type !== 'operation-result') throw new Error('The operation acknowledgement changed its response family.');
    const receipt = validateOperationReceipt(response.receipt, owner);
    const decidedControl = pending.operationAccept === false && this.operation?.decided && sameOperationOwner(this.operation.owner, owner);
    // Expiry proves only that this native ledger cannot answer its matching
    // owner. It cannot authenticate a scene summary, but a retained external
    // decision can reconstruct the successor without accepting that summary.
    if (!decidedControl || receipt.outcome !== 'expired-conflict') assertOperationSummary(receipt, response.summary);
    if (this.selectionRangeRequired && receipt.outcome !== 'expired-conflict') {
      const operation = this.ownedOperation(owner);
      operation.rangeProof ??= new ToleranceRangeOperation(response.summary);
      if (receipt.outcome === 'active' && operation.rangeOutstanding !== undefined) {
        if (operation.rangeOutstanding) this.authenticateRangeRequest(operation.rangeOutstanding, response.summary, true);
        else if (response.summary.toleranceRange !== null && this.lastToleranceRangeState)
          assertToleranceRangeOwnerUnchanged(toleranceRangeOwner(this.lastToleranceRangeState), response.summary);
      } else operation.rangeProof.assert(receipt.outcome, response.summary);
    }
    if (this.filterMetadataRequired && receipt.outcome !== 'expired-conflict') {
      const operation = this.ownedOperation(owner);
      operation.filterProof ??= new FilterOperation(response.summary);
      if (receipt.outcome === 'active' && operation.filterOutstanding) assertFilterResponse(operation.filterOutstanding, response.summary, true);
      else operation.filterProof.assert(receipt.outcome, response.summary);
    }
    if (this.historyRequired && receipt.outcome !== 'expired-conflict') {
      const operation = this.ownedOperation(owner);
      operation.historyProof ??= new SelectionHistoryOperation(captureSelectionHistoryState(response.summary));
      if (receipt.outcome === 'active' && operation.historyOutstanding) assertSelectionHistoryResponse(operation.historyOutstanding, response.summary);
      else operation.historyProof.assert(receipt.outcome, response.summary);
    }
    if (this.transformRequired && receipt.outcome !== 'expired-conflict') {
      const operation = this.ownedOperation(owner);
      operation.transformProof ??= new TransformOperation(response.summary);
      if (receipt.outcome === 'active' && operation.transformOutstanding) assertTransformResponse(operation.transformOutstanding, response.summary, true);
      else operation.transformProof.assert(receipt.outcome, response.summary);
    }
    if (pending.operationAccept && this.operation?.decided && sameOperationOwner(this.operation.owner, owner) &&
        ['rolled-back', 'not-started', 'expired-conflict'].includes(receipt.outcome))
      throw new Error('The live receipt conflicts with an externally decided successor.');
    if (!decidedControl && (action === 'begin' && receipt.outcome !== 'active' || action === 'commit' && receipt.outcome !== 'committed' ||
        action === 'rollback' && !['rolled-back', 'not-started'].includes(receipt.outcome)))
      throw new Error('The operation acknowledgement does not prove its requested outcome.');
    if (pending.operationAccept) this.acceptSummary(response.summary);
    this.removePending(response.requestId); pending.resolve({ receipt, summary: response.summary });
  }
  private removePending(requestId: number): void {
    const pending = this.pending.get(requestId);
    if (pending?.operationOwner && this.operation && sameOperationOwner(pending.operationOwner, this.operation.owner))
      this.operation.retiredRequests.add(requestId);
    this.pending.delete(requestId);
  }
  private async receiveSource(response: WorkerResponse, pending: Pending): Promise<void> {
    const source = pending.source!;
    source.check();
    if (response.type === 'progress') {
      if (typeof response.stage !== 'string' || response.stage.length > 128 || !Number.isFinite(response.fraction) || response.fraction < 0 || response.fraction > 1)
        throw new Error('Invalid source progress.');
      this.onProgress?.(response.stage, response.fraction); return;
    }
    if (response.type === 'source-range-request') {
      if (source.range || source.delivering) throw new Error('A source read credit is already outstanding.');
      const resource = source.resources[source.resourceIndex];
      if (!resource) throw new Error('The source requested bytes after its final resource.');
      const value = validateSourceRange(response, resource, source.nextRange, source.resourceOffset);
      const range: NonNullable<SourceTransfer['range']> = { value, sent: false }; source.range = range;
      source.reserve(value.length, lease => { range.lease = lease; });
      const delivering = (async () => {
        const chunk = await source.brokers.get(resource.resourceId)!.read(value);
        try {
          source.check();
          const bytes = chunk.bytes;
          this.post({ type: 'source-range', ...value, bytes }, response.requestId, [bytes], pending.base, pending.operationOwner);
          // A successful transfer releases only the sender's broker credit.
          chunk.consume(); range.sent = true;
        } catch (error) { chunk.release(); throw error; }
      })();
      source.delivering = delivering;
      try { await delivering; } finally { if (source.delivering === delivering) source.delivering = undefined; }
      return;
    }
    if (response.type === 'source-range-consumed') {
      const range = source.range;
      if (!range || !range.sent || source.delivering) throw new Error('Unexpected native source consumption acknowledgment.');
      validateSourceRange(response, source.resources[source.resourceIndex], range.value.rangeId, range.value.offset);
      source.consumedBytes += range.value.length; source.nextRange++;
      source.resourceOffset += range.value.length;
      while (source.resourceIndex < source.resources.length && source.resourceOffset === source.resources[source.resourceIndex].byteLength) {
        source.resourceIndex++; source.resourceOffset = 0;
      }
      const lease = range.lease; range.lease = undefined; source.range = undefined;
      if (lease) synchronousSourceHook(lease());
      source.check(); return;
    }
    if (response.type === 'error') {
      // Source-load failure invalidates this candidate module. Joining actual
      // browser reads remains the load finalizer's responsibility.
      throw response.cancelled ? new DOMException(response.error, 'AbortError') : new Error(response.error);
    }
    if (response.type !== 'source-load-result') throw new Error('The source response family changed.');
    if (response.summary.filter != null) throw new Error('A new source returned an active filter owner.');
    if (response.summary.transformSession != null) throw new Error('A new source returned an active transform owner.');
    if (response.summary.opacitySession != null) throw new Error('A new source returned an active opacity owner.');
    if (this.selectionRangeRequired && response.summary.toleranceRange !== null) throw new Error('A new source returned a tolerance Range owner.');
    if (this.historyRequired && response.summary.undoSelectionRevision !== 0) throw new Error('A new source returned a selection Undo stamp.');
    if (validateDuplicateSummary(response.summary) !== null) throw new Error('A new source returned a Duplicate range.');
    if (response.operationId !== source.descriptor.operationId || response.resourceId !== source.descriptor.resourceId ||
        response.consumedBytes !== source.transferBytes || source.range || source.delivering ||
        source.consumedBytes !== source.transferBytes || source.resourceIndex !== source.resources.length ||
        [...source.brokers.values()].some(broker => !broker.complete))
      throw new Error('The source completed before all bytes were consumed.');
    const fingerprint = source.descriptor.kind === 'single' ? validateSourceFingerprint(response.fingerprint, source.descriptor, response.summary) :
      validateGroupSourceFingerprint(response.fingerprint, source.descriptor, response.summary);
    if (source.expectedCount !== undefined && response.summary.sourceCount !== source.expectedCount)
      throw new Error('The grouped source decoded a different original count.');
    source.check(); this.lastTopology = undefined; this.acceptSummary(response.summary);
    this.recoverySource = { source: fingerprint,
      subset: Object.freeze({ sourceCount: response.summary.sourceCount, loadedCount: response.summary.count,
        maxSplats: source.maxSplats }) };
    this.removePending(response.requestId);
    pending.resolve(Object.freeze({ summary: response.summary, fingerprint }));
  }
  private async receiveGeometry(response: WorkerResponse, pending: Pending) {
    const transfer = pending.geometry!;
    if (response.type === 'geometry-chunk') {
      if (transfer.delivering) throw new Error('Overlapping geometry chunks.');
      const descriptor = validateGeometryDescriptor(response.descriptor);
      if (!sameGeometryDescriptor(descriptor, transfer.descriptor)) throw new Error('The geometry descriptor changed during transfer.');
      if (!Number.isSafeInteger(response.chunkId) || response.chunkId !== transfer.nextChunk) throw new Error('Invalid geometry chunk acknowledgement.');
      validateGeometryChunk(descriptor, response.channel, response.first, response.count, response.bytes, transfer.nextVertex, transfer.nextIndex);
      if (transfer.cancelled) return;
      const callback = response.channel === 'vertices' ? transfer.vertices : transfer.indices;
      const delivering = Promise.resolve().then(() => callback(response.first, response.count, response.bytes));
      transfer.delivering = delivering; this.deliveries.add(delivering);
      try { await delivering; } finally { this.deliveries.delete(delivering); if (transfer.delivering === delivering) transfer.delivering = undefined; }
      if (transfer.failure) throw transfer.failure;
      if (!acceptsResult(response, this.revision)) throw new Error('Discarded an obsolete geometry upload.');
      if (this.pending.get(response.requestId) !== pending || transfer.cancelled) return;
      if (response.channel === 'vertices') transfer.nextVertex += response.count; else transfer.nextIndex += response.count;
      transfer.nextChunk++;
      this.post({ type: 'ack', chunkId: response.chunkId }, response.requestId, [], pending.base, pending.operationOwner); return;
    }
    if (response.type !== 'error' && response.type !== 'result') throw new Error('The geometry response family changed.');
    if (response.type === 'result' && transfer.delivering) throw new Error('Geometry completed before its upload acknowledgement.');
    await transfer.delivering;
    if (this.pending.get(response.requestId) !== pending) return;
    if (transfer.failure) throw transfer.failure;
    if (!acceptsResult(response, this.revision)) throw new Error('Discarded an obsolete geometry result.');
    if (!response.summary || !sameGeometryDescriptor(geometryDescriptor(response.summary), transfer.descriptor))
      throw new Error('The geometry state changed during transfer.');
    if (response.type === 'error') {
      this.removePending(response.requestId);
      if (response.cleanupFailed) this.stopWorker(new Error(response.error));
      pending.reject(response.cancelled ? new DOMException(response.error, 'AbortError') : new Error(response.error)); return;
    }
    if (transfer.cancelled) {
      this.removePending(response.requestId); pending.reject(new DOMException('Geometry upload cancelled', 'AbortError')); return;
    }
    if (transfer.nextVertex !== transfer.descriptor.vertexCount || transfer.nextIndex !== geometryChannelCount(transfer.descriptor, 'indices'))
      throw new Error('Geometry completed before every channel was uploaded.');
    this.removePending(response.requestId); this.acceptSummary(response.summary); pending.resolve(response.summary);
  }
  private post(data: Record<string, unknown>, requestId: number, transfer: Transferable[] = [], base = this.revision, operationOwner?: OperationOwner) {
    if (!this.initializationDone || !this.worker || this.disposed || this.fault) throw this.fault ?? new Error('The scene worker is not ready.');
    this.worker.postMessage({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId,
      base: { ...base }, assetBase: new URL(import.meta.env.BASE_URL, document.baseURI).href,
      ...(operationOwner ? { operationOwner } : {}),
      ...data } as WorkerRequest, transfer);
  }
  private enqueue<T>(execute: () => Promise<T>) {
    const operation = this.operations.then(execute, execute); this.operations = operation.catch(() => undefined); return operation;
  }
  private dispatch(data: Record<string, unknown>, callbacks: Partial<Pending> = {}) {
    let releaseAbort = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    return new Promise<NativeSummary | ArrayBuffer | LivePreviewOutcome | SourceLoadResult | Spz4ExportPlan | SceneExportPlan | OperationResolution | OperationOwner>((resolve, reject) => {
      if (this.disposed || this.fault) { reject(this.fault ?? new Error('The scene was closed.')); return; }
      const operation = this.operation;
      if (operation && data.type !== 'operation') {
        if (operation.state !== 'active' || ['source-load', 'source-group-load', 'export', 'export-plan', 'scene-export-plan', 'selection-map'].includes(String(data.type))) {
          reject(new Error('Resolve the retained edit before starting other scene work.')); return;
        }
        data = { ...data, operationOwner: operation.owner };
        callbacks = { ...callbacks, operationOwner: operation.owner };
      }
      try { this.assertDispatchAdmission(data); } catch (error) { reject(error); return; }
      if (callbacks.commandSignal?.aborted) { reject(new DOMException('Operation cancelled', 'AbortError')); return; }
      const id = ++this.sequence;
      const pending: Pending = { family: data.type as WorkerRequest['type'], base: { ...this.revision }, resolve, reject, ...callbacks };
      if (this.selectionRangeRequired && data.type !== 'operation') pending.toleranceBefore = this.lastToleranceRangeState;
      if (this.selectionRangeRequired && data.type === 'command' && isSelectionRangeCommand(data.command)) {
        if (!this.lastToleranceRangeState) { reject(new Error('Read the scene summary before starting a Range selection.')); return; }
        pending.selectionRange = { command: data.command as CapturedSelectionRangeCommand, before: this.lastToleranceRangeState };
        try { assertToleranceRangeRequest(pending.selectionRange.command, pending.selectionRange.before); } catch (error) { reject(error); return; }
      }
      if (operation && data.type !== 'operation') operation.rangeOutstanding = pending.selectionRange ?? null;
      if (this.filterMetadataRequired && data.type === 'command' && isFilterCommandName(data.command) && !this.lastFilterState) {
        reject(new Error('Read the scene summary before starting a selection filter.')); return;
      }
      if (this.filterMetadataRequired && data.type !== 'operation' && this.lastFilterState) {
        try { pending.filterRequest = captureFilterRequest(data.type === 'command' ? data.command : undefined, this.lastFilterState); }
        catch (error) { reject(error); return; }
        if (operation) operation.filterOutstanding = pending.filterRequest;
      }
      if (this.historyRequired && data.type !== 'operation' && this.lastHistoryState) {
        pending.historyRequest = captureSelectionHistoryRequest(this.lastHistoryState, String(data.type), data.command);
        if (operation) operation.historyOutstanding = pending.historyRequest;
      }
      if (this.transformRequired && data.type === 'command' &&
          (TRANSFORM_COMMANDS as readonly string[]).includes((data.command as SceneCommand).command) && !this.lastTransformState) {
        reject(new Error('Read the scene summary before starting a transform session.')); return;
      }
      if (this.transformRequired && !['operation', 'source-load', 'source-group-load', 'recovery-restore', 'recovery-export'].includes(String(data.type)) && this.lastTransformState) {
        try { pending.transformRequest = captureTransformRequest(data.type === 'command' ? data.command : undefined, this.lastTransformState); }
        catch (error) { reject(error); return; }
        if (operation) operation.transformOutstanding = pending.transformRequest;
      }
      this.pending.set(id, pending);
      const expire = () => {
        if (this.pending.get(id) !== pending || !pending.operationOwner) return;
        this.removePending(id);
        // Exact transport cancellation releases stream/chunk waits. The native
        // operation remains owned and can only be restored by owner rollback.
        if (pending.family !== 'operation') {
          try { this.post({ type: 'cancel' }, id, [], pending.base, pending.operationOwner); } catch { /* Status reports whether the live authority remains reachable. */ }
        }
        reject(new OperationUncertainError(pending.operationOwner, pending.operationAction ?? 'request',
          'The scene worker did not acknowledge the retained edit in time.'));
      };
      pending.touch = () => {
        if (!pending.operationOwner && !pending.recovery) return;
        clearTimeout(timer);
        if (pending.recovery) {
          timer = setTimeout(() => {
            if (this.pending.get(id) === pending) this.stopWorker(new Error('The recovery checkpoint transfer did not finish in time.'));
          }, 60_000); return;
        }
        if (pending.operationAccept === false) timer = setTimeout(function operationReconciliationExpired() { expire(); }, 10_000);
        else timer = setTimeout(function operationAcknowledgementExpired() { expire(); }, 30_000);
      };
      pending.touch();
      if (callbacks.map) callbacks.map.requestId = id;
      let sent = false;
      const abort = () => {
        // This signal owns this exact request, including when dispatch was queued.
        // It cannot cancel a later operation or discard the document worker.
        if (!sent || this.pending.get(id) !== pending) return;
        try { this.post({ type: 'cancel' }, id, [], pending.base, pending.operationOwner); }
        catch (error) { this.stopWorker(error instanceof Error ? error : new Error(String(error))); }
      };
      callbacks.commandSignal?.addEventListener('abort', abort, { once: true });
      releaseAbort = () => callbacks.commandSignal?.removeEventListener('abort', abort);
      try { this.post(data, id, [], pending.base, pending.operationOwner); sent = true; if (callbacks.commandSignal?.aborted) abort(); }
      catch (error) { this.removePending(id); reject(error); }
    }).finally(() => { clearTimeout(timer); releaseAbort(); });
  }
  private request(data: Record<string, unknown>, callbacks: Partial<Pending> = {}) {
    if (this.operation && ['uncertain', 'terminal', 'retiring'].includes(this.operation.state))
      return Promise.reject(new Error('Resolve the retained edit before starting other scene work.'));
    return this.enqueue(async () => {
      await this.ready();
      const operation = this.operation;
      return operation?.state === 'active' ? this.ownedDispatch(operation, 'request', data, callbacks) : this.dispatch(data, callbacks);
    });
  }
  async load(file: File, maxSplats: number, budgetBytes: number, options: SourceLoadOptions): Promise<SourceLoadResult> {
    const byteLength = sceneFileBytes(file);
    assertSourceFitsDecodeBudget(byteLength, budgetBytes);
    const descriptor = validateSourceDescriptor({ kind: 'single', operationId: crypto.randomUUID(), resourceId: crypto.randomUUID(),
      byteLength, path: '', role: 'primary' });
    const name = file.name;
    if (typeof name !== 'string') throw new Error('Invalid source loading options.');
    const extension = name.toLowerCase().split('.').pop();
    const format = extension === 'splat' ? 1 : extension === 'ksplat' ? 2 :
      extension === 'sog' || extension === 'sogs' ? 3 : extension === 'zip' ? 4 : 0;
    return this.loadSource(descriptor, [{ resourceId: descriptor.resourceId, blob: file }], maxSplats, budgetBytes,
      options, { type: 'source-load', source: descriptor, format, maxSplats, budgetBytes, sourceBudgetBytes: sourceWorkerBytes(byteLength) });
  }
  async loadGroup(group: PreparedSogGroup, maxSplats: number, budgetBytes: number, options: SourceLoadOptions): Promise<SourceLoadResult> {
    assertPreparedSogGroup(group);
    const descriptor = validateGroupSourceDescriptor(group.descriptor);
    if (!Number.isInteger(maxSplats) || maxSplats < 1 || maxSplats > 1_000_000 || budgetBytes !== GROUP_NATIVE_BUDGET_BYTES)
      throw new Error('Invalid grouped source loading limits.');
    assertSourceFitsDecodeBudget(groupNativeStageBytes(descriptor), budgetBytes);
    return this.loadSource(descriptor, group.sources, maxSplats, budgetBytes, options, {
      type: 'source-group-load', source: descriptor, maxSplats, budgetBytes,
      sourceBudgetBytes: groupWorkerBytes(descriptor), nativeWorkBytes: GROUP_NATIVE_WORK_BYTES },
    () => assertPreparedSogGroup(group), group.sourceCount);
  }
  private async loadSource(descriptor: SourceDescriptor, blobs: readonly { resourceId: string; blob: Blob }[],
    maxSplats: number, budgetBytes: number, options: SourceLoadOptions, request: Record<string, unknown>,
    currentGroup?: () => void, expectedCount?: number): Promise<SourceLoadResult> {
    if (!options || typeof options !== 'object') throw new Error('Invalid source loading options.');
    const admit = options.admit, current = options.current, nativeLease = options.nativeLease;
    if (!Number.isInteger(maxSplats) || maxSplats < 1 || maxSplats > 0xffff_ffff ||
        !Number.isInteger(budgetBytes) || budgetBytes < 1 || budgetBytes > 0xffff_ffff ||
        typeof admit !== 'function' || typeof current !== 'function')
      throw new Error('Invalid source loading options.');
    if (this.nativeMemory && (!nativeLease || this.nativeMemory.state.active))
      throw new AdmissionError('A source must load into an independently admitted native candidate.');
    const resources: SourceReadDescriptor[] = descriptor.kind === 'single' ? [descriptor] :
      [...descriptor.resources, descriptor.decoder].map(resource => ({ ...resource, operationId: descriptor.operationId }));
    if (blobs.length !== resources.length || new Set(blobs.map(resource => resource.resourceId)).size !== blobs.length)
      throw new Error('Invalid grouped source Blob union.');
    let source!: SourceTransfer;
    const check = () => {
      if (source?.failure || this.disposed || this.fault) throw source?.failure ?? this.fault ?? new DOMException('Source loading cancelled', 'AbortError');
      synchronousSourceHook(Reflect.apply(current, options, []));
      currentGroup?.();
      if (source?.failure || this.disposed || this.fault) throw source?.failure ?? this.fault ?? new DOMException('Source loading cancelled', 'AbortError');
    };
    const reserve = (bytes: number, own: (lease: ResourceLease) => void) => {
      check(); const lease = Reflect.apply(admit, options, [bytes]) as ResourceLease;
      if (typeof lease === 'function') own(lease);
      synchronousSourceHook(lease);
      if (typeof lease !== 'function' || lease.bytes !== bytes) throw new Error('Invalid source memory reservation.');
      check();
    };
    const brokers = new Map<string, SourceReadBroker>();
    for (const resource of resources) {
      const blob = blobs.find(value => value.resourceId === resource.resourceId)?.blob;
      if (!blob) throw new Error('Missing source Blob.');
      const broker = new SourceReadBroker(blob, resource, {
      current: check,
      admit: bytes => {
        let lease: ResourceLease | undefined;
        try { reserve(bytes, value => { lease = value; }); return lease!; }
        catch (error) {
          try { if (lease) synchronousSourceHook(lease()); }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'Source read admission cleanup failed.'); }
          throw error;
        }
      },
      });
      brokers.set(resource.resourceId, broker);
    }
    let join!: () => void;
    const transferBytes = descriptor.kind === 'single' ? descriptor.byteLength : groupTransferBytes(descriptor);
    source = { descriptor, resources, brokers, resourceIndex: 0, resourceOffset: 0, transferBytes, maxSplats,
      nativeInputBytes: descriptor.kind === 'single' ? descriptor.byteLength : groupNativeStageBytes(descriptor),
      expectedCount, check, reserve, nativeLease, nextRange: 0, consumedBytes: 0,
      nativeInput: false, finalizing: false, covered: false, joined: new Promise<void>(resolve => { join = resolve; }), join: () => join() };
    while (source.resourceIndex < resources.length && resources[source.resourceIndex].byteLength === 0) source.resourceIndex++;
    this.sourceOwners.add(source);
    return this.enqueue(async () => {
      let failure: unknown, loaded: SourceLoadResult | undefined;
      try {
        await this.ready(); check();
        this.assertNativeAdmission();
        if (nativeLease) this.nativeMemory?.updateCoverage([{ lease: nativeLease, nextLeaseBytes: nativeLease.bytes, nativeBytes: 0 }]);
        reserve(descriptor.kind === 'single' ? sourceStageBytes(descriptor.byteLength) : groupStageBytes(descriptor), lease => { source.stage = lease; });
        loaded = await this.dispatch(request, { source }) as SourceLoadResult;
        return loaded;
      } catch (error) {
        failure = error;
        this.stopWorker(error instanceof Error ? error : new Error(String(error)));
        throw error;
      } finally {
      const errors: unknown[] = [];
      for (const result of await Promise.allSettled([...brokers.values()].map(broker => broker.retire())))
        if (result.status === 'rejected') errors.push(result.reason);
      // The actual read and transferred-copy sender must settle before any
      // candidate staging reservation becomes reusable, even after dispose().
      await source.delivering?.catch(() => undefined);
      const receive = source.range?.lease, stage = source.stage;
      if (loaded && this.nativeMemory && this.worker && !this.fault && !this.disposed) {
        try {
          if (!this.lastHeap || !this.lastAllocation || !sameAllocation(this.lastAllocation, loaded.summary))
            throw new Error('The final native allocation measurement does not match the decoded scene.');
          const updates: NativeCoverageUpdate[] = [];
          if (stage) updates.push({ lease: stage, nextLeaseBytes: 0, nativeBytes: 0 });
          if (nativeLease) updates.push({ lease: nativeLease, nextLeaseBytes: nativeLease.bytes, nativeBytes: loaded.summary.memoryBytes });
          // Use the latest authenticated sample, including valid late telemetry
          // received while the broker retirement promise was being joined.
          this.nativeMemory.reconcile(this.lastHeap, updates); source.covered = Boolean(stage);
        } catch (error) {
          // Final decoded adoption is part of loading, rather than cleanup.
          // Preserve its admission/validation reason while the stopped
          // candidate's covered stage remains held for joined retirement.
          failure ??= error;
          this.stopWorker(error instanceof Error ? error : new Error(String(error)));
        }
      }
      if (source.range) source.range.lease = undefined;
      source.range = undefined; source.stage = undefined;
      if (receive) { try { synchronousSourceHook(receive()); } catch (error) { errors.push(error); } }
      if (stage) {
        try {
          if (source.covered || this.nativeMemory && (!this.worker || this.fault || this.disposed)) this.releaseNativeCoverage(stage);
          else synchronousSourceHook(stage());
        } catch (error) { errors.push(error); }
      }
      source.finalizing = false; this.sourceOwners.delete(source); source.join();
      if (loaded && this.fault) failure ??= this.fault;
      if (errors.length) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Source loading cleanup failed.');
      if (failure !== undefined) throw failure;
      }
    });
  }
  command(command: SceneCommand, signal?: AbortSignal) {
    if (isFilterCommandName(command)) command = captureSelectionFilterCommand(command);
    if (isSelectionRangeCommand(command)) command = captureSelectionRangeCommand(command, true);
    if (command.command === 'transformFocus') return Promise.reject(new Error('Transform focus requires a bound readonly request.'));
    if (command.command === 'duplicate' && !isDuplicateCommand(command)) return Promise.reject(new Error('Invalid Duplicate command.'));
    command = captureSelectionViewCommand(command);
    if (command.command === 'duplicate') command = Object.freeze({ ...command });
    if (command.command === 'morphology' && !isSelectionMorphologyCommand(command, false) ||
        command.command === 'morphologyRange' && !isMorphologyRangeCommand(command))
      return Promise.reject(new Error('Invalid selection morphology command.'));
    if (command.command === 'beginColor' && !isBeginColorCommand(command)) return Promise.reject(new Error('Invalid color session command.'));
    if (command.command === 'export') return Promise.reject(new Error('Scene export requires the owned export request family.'));
    if ((OPACITY_COMMANDS as readonly string[]).includes(command.command) && !isOpacityCommand(command))
      throw new Error('Invalid opacity session command.');
    if ((TRANSFORM_COMMANDS as readonly string[]).includes(command.command)) {
      try { command = captureTransformCommand(command); }
      catch (error) { return Promise.reject(error); }
    }
    if (['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(command.command) && !isSelectionFilterCommand(command))
      return Promise.reject(new Error('Invalid selection filter command.'));
    return this.request({ type: 'command', command }, { commandSignal: signal }) as Promise<NativeSummary>;
  }
  /** A reference query has no transaction, history, draft or revision authority.
   * Capture before entering the serial queue so a queued mutation cannot silently
   * redirect the requested pivot to a successor scene or transform epoch. */
  async transformFocus(scope: TransformFocusScope, transformBase: TransformBaseIdentity | null,
    signal?: AbortSignal): Promise<TransformVec3 | null> {
    const state = this.lastTransformFocusState, revision = { ...this.revision };
    if (!state || this.operation) throw new Error('Finish the current edit before measuring a transform pivot.');
    const command = validateTransformFocusCommand({ command: 'transformFocus', scope,
      revision: state.revision, contentRevision: state.contentRevision, transformBase });
    assertTransformFocusBinding(command, state);
    return this.enqueue(async () => {
      await this.ready(); signal?.throwIfAborted();
      if (this.operation || !sameRevision(revision, this.revision) || this.lastTransformFocusState?.signature !== state.signature)
        throw new Error('The transform focus snapshot is stale or busy.');
      const summary = await this.dispatch({ type: 'command', command }, { commandSignal: signal,
        transformFocus: state, transformFocusScope: scope }) as NativeSummary;
      // A successful terminal can already be in flight when cancellation is
      // posted. Join that terminal, then refuse its reference result as well.
      signal?.throwIfAborted();
      if (this.operation || !sameRevision(revision, this.revision) || this.lastTransformFocusState?.signature !== state.signature)
        throw new Error('The transform focus snapshot is stale or busy.');
      return transformFocusPoint(summary, scope);
    });
  }
  livePreview(command: SceneCommand) { return this.request({ type: 'live-preview', command: captureSelectionViewCommand(command) }) as Promise<LivePreviewOutcome>; }
  private maskChannel(channel: MaskChannel) {
    if (!['document', 'colorBase', 'transformBase', 'opacityBase'].includes(channel)) throw new Error('Invalid scene mask channel.');
    const session = this.lastColorSession;
    if (channel === 'colorBase' && (!session || session.pending)) throw new Error('The color base is unavailable.');
    const colorBase = channel === 'colorBase' && session ?
      { sessionId: session.sessionId, baseId: session.baseId, epochId: session.epochId } : undefined;
    const transform = this.lastTransformSession;
    if (channel === 'transformBase' && (!transform || this.lastAllocation?.kind !== 0)) throw new Error('The transform base is unavailable.');
    const transformBase = channel === 'transformBase' && transform ? { id: transform.id, baseId: transform.baseId, epoch: transform.epoch } : undefined;
    const opacity = this.lastOpacitySession;
    if (channel === 'opacityBase' && (!opacity || this.lastAllocation?.kind !== 0)) throw new Error('The opacity base is unavailable.');
    const opacityBase = channel === 'opacityBase' && opacity ? { id: opacity.id, baseId: opacity.baseId, epoch: opacity.epoch } : undefined;
    return { channel, colorBase, transformBase, opacityBase };
  }
  stream(chunk: NonNullable<Pending['chunk']>, masks: NonNullable<Pending['masks']>, channel: MaskChannel = 'document') {
    return this.request({ type: 'stream', ...this.maskChannel(channel) }, { chunk, masks, maskChannel: channel }) as Promise<NativeSummary>;
  }
  streamGeometry(value: GeometryDescriptor, vertices: NonNullable<Pending['chunk']>, indices: NonNullable<Pending['chunk']>) {
    const descriptor = validateGeometryDescriptor(value);
    return this.enqueue(async () => {
      await this.ready();
      if (!this.lastGeometry || !sameGeometryDescriptor(this.lastGeometry, descriptor)) throw new Error('The requested geometry is no longer current.');
      return this.dispatch({ type: 'geometry-stream', descriptor }, { geometry: { descriptor, vertices, indices,
        nextVertex: 0, nextIndex: 0, nextChunk: 0, cancelled: false } }) as Promise<NativeSummary>;
    });
  }
  readMasks(masks: NonNullable<Pending['masks']>, channel: MaskChannel = 'document') {
    return this.request({ type: 'masks', ...this.maskChannel(channel) }, { masks, maskChannel: channel }) as Promise<NativeSummary>;
  }
  export(format: number, scope: number, _signal?: AbortSignal) {
    if (!isSceneExportFormat(format) || !Number.isInteger(scope) || scope < 0 || scope > 2)
      return Promise.reject(new Error('Unsupported export format or scope.'));
    return Promise.reject<ArrayBuffer>(new Error('This format requires an admitted export plan.'));
  }
  exportPlan(signal?: AbortSignal): Promise<Spz4ExportPlan> {
    return this.request({ type: 'export-plan' }, { commandSignal: signal }) as Promise<Spz4ExportPlan>;
  }
  sceneExportPlan(format: number, scope: number, signal?: AbortSignal): Promise<SceneExportPlan> {
    if (!isAdmittedSceneExportFormat(format) || !Number.isInteger(scope) || scope < 0 || scope > 2)
      return Promise.reject(new Error('Unsupported admitted export format or scope.'));
    return this.request({ type: 'scene-export-plan', format, scope }, { commandSignal: signal, sceneExport: { format, scope } }) as Promise<SceneExportPlan>;
  }
  exportOwned(format: number, scope: number, value: SceneExportPlan, options: SceneExportOptions): Promise<OwnedExportBytes> {
    const plan = validateSceneExportPlan(value);
    if (format !== plan.format || scope !== plan.scope)
      return Promise.reject(new Error('The export plan belongs to another format or scope.'));
    return this.exportAdmitted(plan.format, plan.scope, plan, options, () => this.scenePlans.get(`${plan.format}/${plan.scope}`));
  }
  exportSpz4(scope: number, value: Spz4ExportPlan, options: Spz4ExportOptions): Promise<OwnedExportBytes> {
    const plan = validateSpz4ExportPlan(value);
    if (!Number.isInteger(scope) || scope < 0 || scope > 2) return Promise.reject(new Error('Unsupported export scope.'));
    return this.exportAdmitted(8, scope, plan, options, () => this.spzPlan);
  }
  private exportAdmitted(format: AdmittedSceneExportFormat, scope: number, plan: Spz4ExportPlan, options: SceneExportOptions,
    cached: () => { value: Spz4ExportPlan; revision: Revision } | undefined): Promise<OwnedExportBytes> {
    let plannedRevision: Revision | undefined;
    const check = () => {
      options.signal.throwIfAborted(); synchronousSourceHook(options.current());
      if (plannedRevision && !acceptsResult({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1, base: plannedRevision }, this.revision))
        throw new Error('The export plan is no longer current.');
    };
    let finish!: () => void;
    const joined = new Promise<void>(resolve => { finish = resolve; }); this.exportJoins.add(joined);
    const operation = this.enqueue(async () => {
      await this.ready(); check(); this.assertNativeAdmission();
      const received = cached();
      if (!this.lastAllocation?.loaded || this.lastAllocation.kind !== 0 ||
          this.lastAllocation.count !== plan.count || this.lastShDegree !== plan.shDegree || !received ||
          !acceptsResult({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1, base: received.revision }, this.revision) ||
          Object.keys(plan).some(key => Reflect.get(plan, key) !== Reflect.get(received.value, key)))
        throw new Error('The export plan is no longer current.');
      plannedRevision = { ...received.revision };
      let work: ResourceLease | undefined, transfer: ResourceLease | undefined, provisionalOutput: ResourceLease | undefined;
      let covered = false, transferred = false, newOutput = false;
      try {
        work = options.admitNative(plan.nativeWorkBytes); synchronousSourceHook(work);
        if (this.exportOutputLease && resourceLeaseCredit(work) === resourceLeaseCredit(this.exportOutputLease)) {
          work = undefined; throw new AdmissionError('Export work cannot borrow the previous output credit.');
        }
        assertResourceCredit(resourceLeaseCredit(work), plan.nativeWorkBytes);
        transfer = options.admitOutput(2 * plan.outputCapacity); synchronousSourceHook(transfer);
        if (resourceLeaseCredit(transfer) === resourceLeaseCredit(work) ||
            this.exportOutputLease && resourceLeaseCredit(transfer) === resourceLeaseCredit(this.exportOutputLease)) {
          transfer = undefined; throw new AdmissionError('Export output requires a separate credit.');
        }
        assertResourceCredit(resourceLeaseCredit(transfer), 2 * plan.outputCapacity);
        if (!this.exportOutputLease) {
          const retained = options.admitNative(0); synchronousSourceHook(retained);
          if ([resourceLeaseCredit(work), resourceLeaseCredit(transfer)].includes(resourceLeaseCredit(retained)))
            throw new AdmissionError('Native output requires a separate credit.');
          provisionalOutput = retained;
          assertResourceCredit(resourceLeaseCredit(retained), 0); this.exportOutputLease = retained; provisionalOutput = undefined; newOutput = true;
        }
        this.updateNativeCoverage([
          { lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 },
          { lease: this.exportOutputLease, nextLeaseBytes: this.exportOutputLease.bytes,
            nativeBytes: Math.min(this.exportOutputLease.bytes, this.lastAllocation.exportOutputBytes ?? 0) },
        ]);
        covered = true; this.exportWorkLease = work;
        assertResourceCredit(resourceLeaseCredit(work), plan.nativeWorkBytes);
        assertResourceCredit(resourceLeaseCredit(transfer), 2 * plan.outputCapacity);
        check(); synchronousSourceHook(options.onAccepted()); check();
        const bytes = await this.dispatch({ type: 'export', command: { command: 'export', format, scope,
          outputCapacity: plan.outputCapacity, nativeWorkBytes: plan.nativeWorkBytes } }, { commandSignal: options.signal }) as ArrayBuffer;
        const retained = this.lastAllocation?.exportOutputBytes ?? 0;
        if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength || bytes.byteLength > plan.outputCapacity ||
            retained < plan.outputCapacity || retained > plan.nativeWorkBytes || this.lastAllocation?.exportBytes !== retained) {
          const error = new Error('The scene export returned invalid output ownership.'); this.stopWorker(error); throw error;
        }
        // The old output has retired. Move existing admitted credit atomically
        // into the new native output; the measured heap remainder stays charged.
        this.transferNativeCoverage([
          { lease: work, nextLeaseBytes: 0, nativeBytes: 0 },
          { lease: this.exportOutputLease, nextLeaseBytes: retained, nativeBytes: retained },
        ]);
        check(); const owned = new OwnedExportBytes(bytes, transfer); transferred = true; return owned;
      } finally {
        this.exportWorkLease = undefined;
        const errors: unknown[] = [];
        const cleanup = (action: () => unknown) => { try { synchronousSourceHook(action()); } catch (error) { errors.push(error); } };
        if (work) cleanup(() => covered ? this.releaseNativeCoverage(work!) : work!());
        if (!transferred && transfer) cleanup(() => transfer!());
        if (provisionalOutput) cleanup(() => provisionalOutput!());
        if (this.exportOutputLease && !(this.lastAllocation?.exportOutputBytes ?? 0)) {
          const retained = this.exportOutputLease; this.exportOutputLease = undefined;
          cleanup(() => newOutput && !covered ? retained() : this.releaseNativeCoverage(retained));
        }
        if (errors.length) throw new AggregateError(errors, 'Scene export cleanup failed.');
      }
    });
    const settled = () => { this.exportJoins.delete(joined); finish(); };
    void operation.then(settled, settled); return operation;
  }
  async adoptSelectionMap(source: SelectionMapData, options: SelectionMapAdoptionOptions): Promise<AdoptedSelectionMap> {
    const data = { ...source }, layout = validateSelectionMap(data, ++this.mapSequence), captured = { ...this.revision };
    const check = () => {
      options.signal?.throwIfAborted(); options.current();
      if (!acceptsResult({ protocolVersion: PROTOCOL_VERSION, buildId: BUILD_ID, requestId: 1, base: captured }, this.revision))
        throw new Error('The scene changed before selection map adoption completed.');
    };
    check();
    return this.enqueue(async () => {
      await this.ready(); check(); this.assertNativeAdmission(); const lease = options.admit(layout.admissionBytes);
      const map: MapTransfer = { data, layout, lease, check, nextOffset: 0, committing: false, cleanupConfirmed: false };
      const abort = () => {
        if (!map.committing && map.requestId) {
          const pending = this.pending.get(map.requestId);
          if (pending) this.cancelMap(map.requestId, pending, options.signal?.reason instanceof Error ? options.signal.reason : new DOMException('Selection map cancelled', 'AbortError'));
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      let retained = false;
      try {
        check();
        const summary = await this.dispatch({ type: 'selection-map', descriptor: layout.descriptor }, { map }) as NativeSummary;
        if (summary.selectionMapId !== layout.descriptor.mapId || summary.pendingSelectionMapId !== null)
          throw new Error('The core did not publish the requested selection map.');
        check();
        if (this.nativeMemory) this.updateNativeCoverage([{ lease, nextLeaseBytes: layout.nativeBytes, nativeBytes: layout.nativeBytes }]);
        else lease.resize(layout.nativeBytes);
        const owner: MapOwner = { lease, retired: false, disposeRequested: false }; this.mapOwners.set(layout.descriptor.mapId, owner); retained = true;
        return { mapId: layout.descriptor.mapId, payloadBytes: layout.payloadBytes, nativeBytes: layout.nativeBytes, summary,
          assertCurrent: () => { options.current(); if (this.disposed || this.fault || owner.retired || owner.disposeRequested || this.activeMapId !== layout.descriptor.mapId)
            throw this.fault ?? new Error('The selection map is no longer active.'); },
          dispose: () => this.releaseMap(layout.descriptor.mapId, owner) };
      } catch (error) {
        if (!map.cleanupConfirmed && !this.disposed && !this.fault) {
          try { await this.dispatch({ type: 'command', command: { command: 'selectionMapRelease', mapId: layout.descriptor.mapId } }); }
          catch (cleanup) { this.stopWorker(new Error(`Could not release selection map memory: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`)); }
        }
        throw error;
      } finally {
        options.signal?.removeEventListener('abort', abort);
        if (!retained) {
          if (map.covered || this.nativeMemory && (!this.worker || this.fault || this.disposed)) this.releaseNativeCoverage(lease);
          else lease();
        }
      }
    });
  }
  private cancelMap(id: number, pending: Pending, error: Error) {
    pending.map!.error ??= error;
    try { this.post({ type: 'cancel' }, id, [], pending.base, pending.operationOwner); } catch { this.stopWorker(error); }
  }
  private releaseMap(mapId: number, owner: MapOwner): Promise<void> {
    owner.disposeRequested = true;
    if (owner.retired || this.disposed || this.fault) return Promise.resolve();
    if (!owner.disposePromise) {
      owner.disposePromise = this.command({ command: 'selectionMapRelease', mapId }).then(() => undefined);
      void owner.disposePromise.then(() => { owner.disposePromise = undefined; }, () => { owner.disposePromise = undefined; });
    }
    return owner.disposePromise;
  }
  private validateDuplicateTopology(summary: NativeSummary) {
    const duplicateRange = validateDuplicateSummary(summary);
    if (this.lastTopology && summary.revision === this.lastSelectionRevision &&
        (summary.count !== this.lastTopology.count || summary.sourceCount !== this.lastTopology.sourceCount ||
          !sameDuplicateRange(duplicateRange, this.lastTopology.duplicateRange)))
      throw new Error('The native scene changed topology without a revision.');
    return duplicateRange;
  }
  private acceptSummary(summary: NativeSummary) {
    if (this.historyRequired) validateUndoSelectionRevision(summary);
    if (this.filterMetadataRequired) summary.filter = filterSummaryState(summary);
    if (this.selectionRangeRequired) summary.toleranceRange = validateToleranceRangeSummary(summary);
    const duplicateRange = this.validateDuplicateTopology(summary);
    summary.duplicateRange = duplicateRange;
    if (summary.morphologyRange !== undefined) {
      summary.morphologyRange = validateMorphologyRange(summary.morphologyRange);
      if (summary.morphologyRange && (!summary.loaded || summary.kind !== 0)) throw new Error('The morphology range belongs to another scene kind.');
    }
    this.lastShDegree = summary.shDegree;
    const alignment = validateAlignmentSummary(summary.alignment);
    // Preserve the canonical compact unloaded response; loaded work must
    // always carry its own pending flag before Floor metadata is admitted.
    if (summary.loaded === false && summary.kind === 0 && summary.count === 0 && summary.floor === null && summary.pending === undefined) summary.pending = false;
    const floor = validateFloorSummary(summary.floor, { loadedCount: summary.count, pending: summary.pending });
    if ((!summary.loaded || summary.kind !== 0) && floor) throw new Error('The scene worker returned an invalid floor owner.');
    summary.floor = floor;
    // The real ABI14 worker requires this field on every native summary.
    // Older isolated transport doubles may omit it until metadata is observed.
    if (summary.filter !== undefined || this.filterMetadataObserved) {
      const filter = validateFilterSummary(summary.filter);
      if (filter && (!summary.loaded || summary.kind !== 0 || summary.selectionDraft))
        throw new Error('The scene worker returned an invalid selection filter owner.');
      summary.filter = filter;
      this.filterMetadataObserved = true;
    }
    const transform = validateTransformSummary(summary.transformSession);
    if (transform && (!summary.loaded || summary.kind !== 0 || summary.selectionDraft || summary.filter || summary.colorSession))
      throw new Error('The scene worker returned an invalid transform session owner.');
    summary.transformSession = transform; this.lastTransformSession = transform;
    const opacity = validateOpacitySummary(summary.opacitySession);
    if (opacity && (!summary.loaded || summary.kind !== 0 || summary.selectionDraft || summary.filter || summary.colorSession || transform))
      throw new Error('The scene worker returned an invalid opacity session owner.');
    summary.opacitySession = opacity; this.lastOpacitySession = opacity;
    const gaussian = summary.loaded && summary.kind === 0;
    // ABI9 scenes establish this metadata at source acceptance. Once seen,
    // losing it on any later Gaussian result (including commit/rollback) must
    // retire the transport instead of silently reverting cameras to identity.
    // Older isolated doubles may omit it until they establish a real owner.
    if (gaussian && this.gaussianAlignmentObserved && !alignment)
      throw new Error('The scene worker lost its alignment metadata.');
    if (summary.kind !== 0 && alignment) throw new Error('Geometry returned alignment metadata.');
    if (summary.alignment !== undefined) summary.alignment = alignment;
    this.lastColorSession = validateColorSession(summary.colorSession);
    if (summary.kind !== 0 && this.lastColorSession) throw new Error('Geometry returned a color session.');
    this.lastGeometry = summary.loaded && summary.kind !== 0 ? geometryDescriptor(summary) : undefined;
    if (summary.kind === 0 && summary.geometry != null) throw new Error('Gaussian state returned a geometry descriptor.');
    this.reconcileMaps(summary);
    if (summary.contentRevision !== this.lastContentRevision) this.revision.contentRevision++;
    if (summary.revision !== this.lastSelectionRevision) this.revision.selectionRevision++;
    this.lastContentRevision = summary.contentRevision; this.lastSelectionRevision = summary.revision;
    this.lastTopology = { count: summary.count, sourceCount: summary.sourceCount, duplicateRange };
    this.lastTransformFocusState = captureTransformFocusState(summary);
    if (this.selectionRangeRequired) {
      this.lastToleranceRangeState = captureToleranceRangeState(summary);
      this.operation?.rangeProof?.accept(summary);
    }
    if (this.filterMetadataRequired) {
      this.lastFilterState = captureFilterState(summary);
      this.operation?.filterProof?.accept(summary);
    }
    if (this.historyRequired) {
      this.lastHistoryState = captureSelectionHistoryState(summary);
      this.operation?.historyProof?.accept(summary);
      if (this.operation) this.operation.historyOutstanding = undefined;
    }
    if (this.transformRequired) {
      this.lastTransformState = captureTransformState(summary); this.operation?.transformProof?.accept(summary);
      if (this.operation) this.operation.transformOutstanding = undefined;
    }
    // Publish the latch only after every acceptance check succeeded. An invalid
    // unloaded/geometry boundary cannot discharge a Gaussian metadata owner.
    this.gaussianAlignmentObserved = gaussian ? this.gaussianAlignmentObserved || alignment !== null : false;
  }
  private authenticateRangeRequest(request: NonNullable<Pending['selectionRange']>, summary: NativeSummary, allowRetained = false): void {
    if (allowRetained && sameToleranceRangeOwner(toleranceRangeOwner(request.before), toleranceRangeOwner(summary))) return;
    assertToleranceRangeAcknowledgement(request.command, request.before, summary);
  }
  private reconcileMaps(summary: NativeSummary) {
    this.activeMapId = summary.selectionMapId;
    const retained = new Set(summary.selectionMapRetainedIds);
    for (const [id, owner] of this.mapOwners) if (!retained.has(id)) { owner.retired = true; this.releaseNativeCoverage(owner.lease); this.mapOwners.delete(id); }
    const disposedActive = this.activeMapId === null ? undefined : this.mapOwners.get(this.activeMapId);
    if (disposedActive?.disposeRequested && !disposedActive.disposePromise) void this.releaseMap(this.activeMapId!, disposedActive).catch(() => undefined);
  }
  cancel() {
    if (this.operation?.state === 'uncertain' || this.operation?.state === 'retiring') return;
    const active = this.pending.entries().next().value as [number, Pending] | undefined;
    if (!active) return;
    if (active[1].source) { this.stopWorker(new DOMException('Source loading cancelled', 'AbortError')); return; }
    if (active[1].map) {
      if (!active[1].map.committing) this.cancelMap(active[0], active[1], new DOMException('Selection map cancelled', 'AbortError'));
    } else {
      if (active[1].geometry) active[1].geometry.cancelled = true;
      this.post({ type: 'cancel' }, active[0], [], active[1].base, active[1].operationOwner);
    }
  }
  private failAll(error: Error) {
    for (const pending of this.pending.values()) {
      if (pending.delivering || pending.geometry?.delivering || pending.recovery?.delivering) {
        const delivering = pending.delivering ?? pending.geometry?.delivering ?? pending.recovery!.delivering!;
        if (pending.geometry) { pending.geometry.failure ??= error; pending.geometry.cancelled = true; }
        // Closing a candidate terminates its worker immediately, but its load
        // promise still owns an in-flight upload copy until that callback joins.
        void delivering.then(() => pending.reject(error), () => pending.reject(error));
      } else pending.reject(error);
    }
    this.pending.clear();
  }
  private stopWorker(error: Error) {
    const notify = !this.failureNotified && !this.disposed && this.initializationDone && this.liveAuthority && this.recoverySource !== undefined;
    this.fault ??= error;
    const operation = this.operation;
    if (operation?.waiting) {
      const waiting = operation.waiting; operation.waiting = undefined; waiting.reject(this.fault);
    }
    for (const source of this.sourceOwners) {
      source.failure ??= this.fault;
      for (const broker of source.brokers.values()) {
        try { broker.cancel(this.fault); } catch { /* Finalizer joins/reports cleanup. */ }
        void broker.retire().catch(() => undefined);
      }
    }
    this.initializationAbort.abort(this.fault);
    const worker = this.worker; this.worker = undefined; worker?.terminate(); this.revokeWorkerUrl();
    this.bootstrap?.reject(this.fault); this.failAll(this.fault);
    for (const owner of this.mapOwners.values()) { owner.retired = true; this.releaseNativeCoverage(owner.lease); } this.mapOwners.clear();
    if (notify) {
      this.failureNotified = true;
      const failure: CoreWorkerFailure = Object.freeze({ error: this.fault, operationOwner: operation?.owner, decision: operation?.decided,
        revision: Object.freeze({ ...this.revision }), nativeContentRevision: this.lastContentRevision,
        nativeSelectionRevision: this.lastSelectionRevision });
      this.onWorkerFailure?.(failure);
    }
  }
  dispose() { this.disposed = true; this.stopWorker(new Error('The scene was closed.')); }
}
