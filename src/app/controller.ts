import { createVerifiedRenderCompute } from './renderCompute';
import { DisplayFrameAdmission } from '../renderer/displayFrameAdmission';
import { interactiveDisplayPrecision, type DisplayPoseIdentity } from '../renderer/displayPrecision';
import type { ImageOperation } from '../io/image';
import { CoreClient, type CoreClientRecoverySeed, type CoreWorkerFailure } from '../document/coreClient';
import { DocumentRecoveryStore, recoveryPublicationRevision } from '../document/recoveryCoordinator';
import { encodeRecoveryMetadata, decodeRecoveryMetadata, type RecoveryMetadata } from './recoveryMetadata';
import { assertOperationSummary, isOperationRestoredError, type OperationOwner, type OperationResolution } from '../document/operationProtocol';
import { AdmissionError, checkedBytes, estimateFloorWorkBytes,
  FLOOR_VIEW_BOOKKEEPING_BYTES, MiB, ResourceLedger, type ResourceLease } from '../document/resources';
import { LOADED_PREVIEW_LIMIT, probeSceneFile, PROBE_WORK_BYTES } from '../document/loadProbe';
import { assertSourceFitsDecodeBudget, NATIVE_LOAD_BUDGET_BYTES, sceneFileBytes } from '../document/sceneInputLimits';
import { GROUP_NATIVE_BUDGET_BYTES, groupDecodeAdmissionBytes } from '../document/sourceGroup';
import { prepareSogGroup, prepareSogCollectionGroup, type PreparedSogGroup } from '../io/sogGroup';
import { acquireSceneCollectionFromFiles, acquireSceneCollectionFromFolderFiles, acquireSceneCollectionFromDrop,
  snapshotSceneCollectionDrop, type SceneCollectionDrop } from '../io/collectionAcquisition';
import type { OwnedSceneCollection } from '../io/sceneCollection';
import { EXAMPLE_SCENE, EXAMPLE_SCENE_LOAD_ERROR, prepareExampleSceneCollection } from './exampleScene';
import { sameGeometryDescriptor } from '../renderer/geometryLayout';
import { geometryDescriptor } from '../document/geometry';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../renderer/defaults';
import { sameRevision, type NativeAllocationSnapshot, type NativeSummary, type Revision, type SceneCommand } from '../document/types';
import { NativeHeapAccounting, type NativeCoverageUpdate } from '../document/nativeMemory';
import { CameraController } from '../input/camera';
import { SelectionSession, type SelectionRunResult } from '../input/selectionSession';
import { ToleranceSession } from '../input/toleranceSession';
import { isSelectionMorphologyCommand, selectionDistance, selectionSigma, validateMorphologyRange,
  type SelectionMorphologyMethod } from '../input/selectionMorphology';
import { estimateMorphologyWorkBytes, MORPHOLOGY_RANGE_WORK_BYTES } from '../document/morphologyMemory';
import { DUPLICATE_SCENE_LIMIT, isDuplicateCommand, sameDuplicateRange } from '../document/duplicateProtocol';
import { estimateDuplicateWorkBytes } from '../document/duplicateMemory';
import { colorValues, colorSessionState, estimateColorWorkBytes, isAutoColorMethod, sameColorValues,
  type AutoColorMethod, type ColorDisplayBinding } from '../document/colorSession';
import { createSceneRenderer } from '../renderer/factory';
import { estimateRendererSceneBytes } from '../renderer/sceneResources';
import { estimateSceneBytes as estimateWebGpuSceneBytes } from '../document/resources';
import { validateBackendPreference, type GraphicsBackend, type GraphicsBackendPreference } from '../renderer/backend';
import { StaleRenderQueryError, type SceneRenderer, type MaskUpdate, type GaussianScene, type RenderPick, type RenderScene, type RetiredRenderResource } from '../renderer/contracts';
import { validateSteadySettings, type SteadySettings } from '../renderer/steadySettings';
import { registeredAllowed } from '../generated/product-adapter';
import { useApp, setApp, setSelectionPreferences, type SelectionTool, type ToolbarAction, type ToolbarFeedback } from './store';
import { DocumentSelectionMaps, type SelectionMapContext } from './selectionMaps';
import { surfaceDimensions, type SurfaceChannels } from '../renderer/webgpu/surfaceQuery';
import { volumeSurfaceRegion } from '../renderer/webgpu/surfaceCoverage';
import type { CachedSelectionMap } from '../document/selectionMapCache';
import { ensureRuntime, getRuntimeVerificationMode } from '../build/runtime';
import type { SourceFingerprint } from '../io/fingerprint';
import { savedViewCameraState, savedViewFromCamera, savedViewMatches, validateSavedViewRecord, type SavedViewRecord } from '../io/savedView';
import { SAVED_VIEW_RETENTION_BYTES, SavedViewStorage } from '../io/savedViewStorage';
import { createSavedThumbnail } from '../io/thumbnail';
import { encodeRgba, type OwnedImageOutput, type OwnedRgbaImage } from '../io/image';
import { readPortableSavedView, writePortableSavedView } from '../io/portableSavedView';
import { IDENTITY_ALIGNMENT_FRAME, cameraStateFromOriginal, cameraStateToOriginal, prepareDefaultRolls } from '../document/alignment';
import { sameAlignmentBranch, validateAlignmentSummary } from '../document/alignmentProtocol';
import { validateFloorSummary, type FloorSummary } from '../document/floorProtocol';
import { ALIGNMENT_VIEW_BOOKKEEPING_BYTES, prepareAlignmentView, replaceAlignmentDefaultRolls, resetAlignmentActiveRolls,
  type AlignmentViewCheckpoints } from '../document/alignmentViews';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import { canonicalJson } from '../build/verification';
import { sceneExportDescriptor, type SceneExportFormat } from '../document/exportFormats';
import type { OwnedExportBytes } from '../document/spz4Export';
import { filterDefaults, filterWireParameters, isSelectionFilterCommand, validateFilterSummary,
  type SelectionFilterKind, type SelectionFilterParameters, type SelectionFilterSummary } from '../document/filterProtocol';
import { estimateFilterWorkBytes } from '../document/filterMemory';
import type { FilterGizmoMode, FilterGizmoPose } from '../document/filterGizmo';
import { assertTransformAcknowledgement, captureTransformCommand, captureTransformState, isTransformCommand, isTransformMode, patchTransformParameters, sameTransformParameters, sameTransformSummary,
  TRANSFORM_COMMANDS, transformDefaults, transformUiParameters, transformWireParameters, validateTransformDefinition,
  validateTransformMatrix, validateTransformSummary, type TransformDefinition, type TransformKind, type TransformMatrix,
  type TransformMode, type TransformParameters, type TransformSessionSummary, type TransformVec3 } from '../document/transformProtocol';
import { estimateTransformWorkBytes } from '../document/transformMemory';
import { nextPivotMode, type TransformPivotMode } from '../document/transformPivot';
import { assertToleranceRangeAcknowledgement, sameToleranceRange, validateSelectionRangePreference,
  type SelectionRangeFields, type SelectionRangePreference } from '../document/selectionRange';
import { resolveSelectionRange, resolvedSelectionRangeFields } from './selectionRange';
import type { TransformGizmoPose } from '../document/transformGizmo';
import { isOpacityCommand, OPACITY_COMMANDS, opacityScale, opacityUiScale, sameOpacitySummary,
  validateOpacitySummary, type OpacitySessionSummary } from '../document/opacityProtocol';
import { estimateOpacityWorkBytes } from '../document/opacityMemory';
import { SELECTION_VIEW_COMMANDS, validateSelectionView, type MaskChannel, type SelectionView } from '../document/selectionView';
import { BenchmarkObservation, benchmarkReadonlyCopy, type BenchmarkFrameContext, type BenchmarkFrameObservation,
  type BenchmarkOperationState, type BenchmarkQueryOwner, type BenchmarkMaskObservation, benchmarkOwnerChange,
  benchmarkMaskBase64, BENCHMARK_MASK_BYTE_LIMIT } from './benchmarkObservation';
export type { FilterGizmoPose } from '../document/filterGizmo';
export type FilterGizmoGestureToken = Readonly<{ id: number; mode: FilterGizmoMode }>;
export type TransformGizmoGestureToken = Readonly<{ id: number; mode: FilterGizmoMode }>;
export type DeferredColorPointerToken = Readonly<{ id: number }>;
export type DeferredSelectionOptions = Readonly<{ live: boolean; overlap: boolean; visibleOnly: boolean;
  colorTolerance: number; fillTolerance: number; connectedColor: boolean; currentViewOnly?: boolean;
  colorRange?: SelectionRangePreference; fillRange?: SelectionRangePreference; sampleRadiusPixels?: number }>;

function nativeHistoryBytes(summary: NativeSummary) {
  if (summary.kind !== 0) return 0;
  // Native map allocations have their own CoreClient-owned ledger leases.
  return Math.max(0, summary.memoryBytes - summary.count * 144 - (summary.selectionMapBytes ?? 0) - (summary.exportBytes ?? 0));
}
function selectionRestored(summary: NativeSummary) {
  return summary.ok === true && summary.loaded === true && summary.transaction === false &&
    summary.selectionDraft === false && (summary.filter === undefined || summary.filter === null) &&
    summary.pending === false && summary.pendingSelectionMapId === null;
}
function sameToleranceOwner(expected: NativeSummary, actual: NativeSummary) {
  return (expected.toleranceSessionId ?? null) === (actual.toleranceSessionId ?? null) &&
    (expected.toleranceTool ?? null) === (actual.toleranceTool ?? null) &&
    (expected.toleranceRecorded ?? null) === (actual.toleranceRecorded ?? null) &&
    sameToleranceRange(expected.toleranceRange ?? null, actual.toleranceRange ?? null);
}
function sameFilter(a: SelectionFilterSummary | null, b: SelectionFilterSummary | null) {
  return a === null ? b === null : b !== null && a.id === b.id && a.kind === b.kind && a.epoch === b.epoch && a.previewEpoch === b.previewEpoch && a.changed === b.changed;
}
const filterParameterFields = ['center', 'size', 'rotation', 'radius', 'fov', 'aspect', 'near', 'far',
  'minOpacity', 'maxOpacity', 'minScale', 'maxScale'] as const;
/** Keep finite UI input even when its active predicate is temporarily invalid. */
function filterUiParameters(value: unknown): SelectionFilterParameters | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== filterParameterFields.length || keys.some(key => typeof key !== 'string' ||
    !filterParameterFields.includes(key as typeof filterParameterFields[number]))) return null;
  const result: Record<string, unknown> = {};
  for (const name of filterParameterFields) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property?.enumerable || !('value' in property)) return null;
    if (name === 'center' || name === 'size' || name === 'rotation') {
      const array = property.value;
      if (!Array.isArray(array) || Object.getPrototypeOf(array) !== Array.prototype || array.length !== 3 || Reflect.ownKeys(array).length !== 4) return null;
      const cloned: number[] = [];
      for (let index = 0; index < 3; index++) {
        const item = Object.getOwnPropertyDescriptor(array, String(index));
        if (!item?.enumerable || !('value' in item) || typeof item.value !== 'number' || !Number.isFinite(item.value)) return null;
        cloned.push(item.value);
      }
      result[name] = cloned;
    } else {
      if (typeof property.value !== 'number' || !Number.isFinite(property.value)) return null;
      result[name] = property.value;
    }
  }
  return result as SelectionFilterParameters;
}
function patchFilterUiParameters(previous: SelectionFilterParameters, patch: unknown): SelectionFilterParameters | null {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) return null;
  const result = { ...previous };
  for (const key of Reflect.ownKeys(patch)) {
    if (typeof key !== 'string' || !filterParameterFields.includes(key as typeof filterParameterFields[number])) return null;
    const property = Object.getOwnPropertyDescriptor(patch, key);
    if (!property?.enumerable || !('value' in property)) return null;
    Object.defineProperty(result, key, { value: property.value, enumerable: true, writable: true, configurable: true });
  }
  return filterUiParameters(result);
}
function sameFilterParameters(a: SelectionFilterParameters, b: SelectionFilterParameters) {
  return filterParameterFields.every(key => {
    const left = a[key], right = b[key];
    return Array.isArray(left) ? Array.isArray(right) && left.every((value, index) => value === right[index]) : left === right;
  });
}
function filterPose(parameters: SelectionFilterParameters): FilterGizmoPose {
  return { center: [...parameters.center], rotation: [...parameters.rotation], size: [...parameters.size], radius: parameters.radius };
}

export function downloadBlob(blob: Blob, name: string, onSettled?: () => void, current?: () => void): () => void {
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  let settled = false, timer: ReturnType<typeof setTimeout> | undefined;
  const settle = () => {
    if (settled) return;
    settled = true; clearTimeout(timer); window.removeEventListener('pagehide', settle);
    URL.revokeObjectURL(url); onSettled?.();
  };
  try {
    timer = setTimeout(settle, 60_000); window.addEventListener('pagehide', settle, { once: true });
    current?.();
    anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; document.body.append(anchor); current?.(); anchor.click();
    return settle;
  } catch (error) { settle(); throw error; }
  finally { anchor?.remove(); }
}
type SavedViewTransfer = {
  source: Readonly<SourceFingerprint>; client: CoreClient; scene: RenderScene; renderer: SceneRenderer;
  camera: CameraController; record?: SavedViewRecord; operation: ImageOperation; current(): void;
};
type ToleranceRequest = SelectionRangeFields & { tolerance: number; connected: boolean; sequence: number };
type ToleranceSelection = {
  id: number; client: CoreClient; renderer: SceneRenderer; scene: GaussianScene; camera: CameraController;
  tool: 'color' | 'fill'; sourceRevision: number;
  cameraRevision: number; width: number; height: number; optionsRevision: number;
  revision: Revision; active: boolean; applying: boolean; session: ToleranceSession<ToleranceRequest>;
  request: ToleranceRequest; acceptedRequest?: ToleranceRequest; cancelledRequest?: Partial<Omit<ToleranceRequest, 'sequence'>> & { sequence: number };
  seed: [number, number]; mapId?: number; mapQuery?: AbortController; waitingMap: boolean; mapReady: boolean;
  previous?: ToleranceSelection;
  deferredPointer?: DeferredColorPointerToken;
};
type GestureSelection = {
  session: SelectionSession;
  client: CoreClient;
  cameraRevision: number;
  optionsRevision: number;
  selectionView: SelectionView | null;
  deferredOptions?: DeferredSelectionOptions;
  deferredTool?: SelectionTool | null;
  deferredPointer?: DeferredColorPointerToken;
  operationRevision: number;
  cancel: AbortController;
  liveFailure?: { generation: number; documentId: string; operationRevision: number };
  polygon?: {
    operation: number; liveRequested: boolean; capturedOverlap?: boolean;
    shape?: SceneCommand; shapeKey?: string; shapeRevision: number; publishedRevision: number;
  };
};
type SelectionCleanupOwner = {
  selection: GestureSelection; client: CoreClient; documentId: string;
  attempt?: Promise<boolean>; restored?: boolean; error?: string;
};
type FilterOwner = {
  client: CoreClient; documentId: string; sourceGeneration: number; generation: number;
  scene?: GaussianScene; renderer?: SceneRenderer; kind: SelectionFilterKind; id?: number; nextEpoch: number;
  parameters: SelectionFilterParameters; operation: number; desiredRevision: number; previewRevision: number | null;
  parameterRevision: number;
  viewRevision?: string;
  previewEpoch: number | null; phase: NonNullable<ReturnType<typeof useApp.getState>['filter']>['phase'];
  previewRequested: boolean; confirmRequested: boolean; cancelRequested: boolean;
  task?: Promise<boolean>; cancellation?: Promise<boolean>; error?: string; validationError?: string;
  centerPick?: object; centerTask?: Promise<boolean>;
};
type FilterGizmoGesture = {
  token: FilterGizmoGestureToken; owner: FilterOwner; id: number; kind: SelectionFilterKind;
  pose: FilterGizmoPose; originalParameters: SelectionFilterParameters; lastParameters: SelectionFilterParameters;
  operation: number; clean: boolean; previewRevision: number | null; previewEpoch: number | null;
  candidate: SelectionFilterSummary; nativeRevision: Revision;
  expectedDesiredRevision: number; expectedParameterRevision: number; lastUpdateRevision: number;
};
type TransformOwner = {
  client: CoreClient; documentId: string; sourceGeneration: number; generation: number; scene?: GaussianScene; renderer?: SceneRenderer;
  kind: TransformKind; selectedOnly: boolean; metadata?: TransformSessionSummary; nextEpoch: number;
  parameters: TransformParameters; appliedParameters: TransformParameters; desiredRevision: number; appliedRevision: number | null;
  phase: NonNullable<ReturnType<typeof useApp.getState>['transform']>['phase']; applyRequested: boolean;
  widgetMatrix?: TransformMatrix;
  appliedPivotMode?: TransformPivotMode; appliedPivotChosen?: boolean;
  task?: Promise<boolean>; ending?: Promise<boolean>; cancelRequested: boolean; error?: string;
};
type TransformGizmoGesture = {
  token: TransformGizmoGestureToken; owner: TransformOwner; metadata: TransformSessionSummary; revision: Revision;
  camera: CameraController; cameraRevision: number; deviceEpoch: number; width: number; height: number;
  viewport: { x: number; y: number; width: number; height: number; dpr: number };
  desiredRevision: number; pose?: TransformGizmoPose; preparing?: Promise<boolean>; ready: boolean;
  widgetMatrix: TransformMatrix;
};
type OpacityOwner = {
  client: CoreClient; documentId: string; sourceGeneration: number; generation: number; scene?: GaussianScene; renderer?: SceneRenderer;
  selectedOnly: boolean; metadata?: OpacitySessionSummary; nextEpoch: number; scale: number; appliedScale: number;
  desiredRevision: number; appliedRevision: number | null; phase: NonNullable<ReturnType<typeof useApp.getState>['opacity']>['phase'];
  applyRequested: boolean; cancelRequested: boolean; task?: Promise<boolean>; ending?: Promise<boolean>; error?: string;
};
type EditOperation = { cancel: AbortController; committing: boolean; finished: Promise<void>; tolerance: boolean };
type ExportOperation = { cancel: AbortController; finished: Promise<void> };
type ToolbarAttempt = { action: ToolbarAction; sequence: number; client?: CoreClient; generation: number;
  documentId?: string; sourceGeneration?: number };
type MorphologyRangeOwner = { client: CoreClient; scene: GaussianScene; generation: number; revision: Revision;
  cancel: AbortController; finished: Promise<void>; task: Promise<boolean> };
type CollectionIntake = {
  cancel: AbortController; collection?: OwnedSceneCollection; scan?: Promise<OwnedSceneCollection>;
  drop?: SceneCollectionDrop; cleanup?: Promise<void>; ownsCollection: boolean; barrier: boolean;
  example?: { ownsFile(file: File): boolean; published?: { scene: RenderScene; client: CoreClient; generation: number } };
};
type SourceSelection = Readonly<{ files: readonly File[]; index: number; groupFiles?: readonly File[] }> |
  Readonly<{ collection: OwnedSceneCollection; index: number; intake: CollectionIntake; file?: File }>;
type NativeSceneCoverage = { scene: ResourceLease; sceneNativeBytes?: number; history?: ResourceLease; work?: ResourceLease };
type AlignmentToolOwner = {
  client: CoreClient; renderer: SceneRenderer; scene: GaussianScene; generation: number; revision: Revision;
  tool: 'center' | 'scale' | 'align'; point?: readonly [number, number, number];
  secondPoint?: readonly [number, number, number]; targetDistance?: number;
  thirdPoint?: readonly [number, number, number]; normal?: readonly [number, number, number]; flip: boolean;
};
type FloorToolOwner = {
  client: CoreClient; renderer: SceneRenderer; scene: GaussianScene; generation: number; sourceRevision: number;
  revision: Revision; baseline: NativeSummary; cancel: AbortController; detecting: boolean;
  task?: Promise<boolean>; candidate?: FloorSummary; nativeId?: number;
  metadata: ResourceLease; retirement?: Promise<void>;
};
type ReleasedSelection = {
  tool: 'color' | 'fill'; seed: [number, number]; operation: number;
  renderer: SceneRenderer; scene: GaussianScene; camera: CameraController; client: CoreClient;
  cameraRevision: number; sourceRevision: number; width: number; height: number; optionsRevision: number;
  cameraState: number[]; grade: number[]; visibleOnly: boolean; overlap: boolean; sampleRadiusPixels: number;
  selectionView: SelectionView | null;
  releaseRevision: Revision; revision: Revision; pendingEdit?: EditOperation;
  request: ToleranceRequest; cancel: AbortController; owner?: ToleranceSelection;
  deferredPointer?: DeferredColorPointerToken;
  lease: ResourceLease; complete: (accepted: boolean) => void; settled: Promise<void>; settle: () => void;
};
// Bookkeeping only: JS object/closure overhead is engine-dependent. This
// conservative reservation and count bound do not replace operation/map peaks.
const releasedSelectionBytes = 1024;
const maxReleasedSelections = 1024;
export class AppController {
  renderer?: SceneRenderer;
  camera?: CameraController;
  scene?: RenderScene;
  client?: CoreClient;
  private morphologyRangeOwner?: MorphologyRangeOwner;
  private morphologyRangeFailure?: { client: CoreClient; generation: number; revision: Revision };
  private candidate?: CoreClient;
  private bootstrapClient?: CoreClient;
  private bootstrapMemory?: NativeHeapAccounting;
  private sourceMemory?: NativeHeapAccounting;
  private nativeCoverage = new WeakMap<CoreClient, NativeSceneCoverage>();
  private fingerprint?: Readonly<SourceFingerprint>;
  private documentRecovery?: DocumentRecoveryStore;
  private workerFailure?: { client: CoreClient; failure: CoreWorkerFailure };
  private viewStorage = new SavedViewStorage();
  private savedViewRecord?: SavedViewRecord;
  private releaseSavedViews?: () => void;
  private thumbnailAbort?: AbortController;
  private thumbnailTasks = new Set<Promise<boolean>>();
  private viewTransferAbort?: AbortController;
  private viewTransferTasks = new Set<Promise<boolean>>();
  private viewDownloads = new Set<() => void>();
  private imageAborts = new Set<AbortController>();
  private imageTasks = new Set<Promise<unknown>>();
  private imageDownloads = new Set<() => void>();
  private toolbarSequences: Record<ToolbarAction, number> = { save: 0, capture: 0, thumbnail: 0 };
  private toolbarTimers: Partial<Record<ToolbarAction, ReturnType<typeof setTimeout>>> = {};
  private toolbarReceipts: Partial<Record<ToolbarAction, ToolbarFeedback>> = {};
  private clearToolbarFeedback(action?: ToolbarAction) {
    for (const name of action ? [action] : ['save', 'capture', 'thumbnail'] as const) {
      this.toolbarSequences[name]++;
      clearTimeout(this.toolbarTimers[name]); delete this.toolbarTimers[name];
      const previous = this.toolbarReceipts[name]; delete this.toolbarReceipts[name];
      if (previous && useApp.getState().toolbarFeedback[name] === previous)
        setApp(state => ({ toolbarFeedback: { ...state.toolbarFeedback, [name]: null } }));
    }
  }
  private beginToolbarAttempt(action: ToolbarAction): ToolbarAttempt {
    this.clearToolbarFeedback(action);
    const client = this.client;
    return { action, sequence: this.toolbarSequences[action], client, generation: this.generation,
      documentId: client?.revision?.documentId, sourceGeneration: client?.revision?.sourceGeneration };
  }
  private confirmToolbarAttempt(attempt: ToolbarAttempt, message: ToolbarFeedback['message']) {
    const { action, sequence, client } = attempt;
    if (this.toolbarSequences[action] !== sequence || this.destroyed || this.closing || this.closeRequest || this.recovery || !this.scene ||
        client !== this.client || attempt.generation !== this.generation || attempt.documentId !== client?.revision?.documentId ||
        attempt.sourceGeneration !== client?.revision?.sourceGeneration) return;
    const receipt: ToolbarFeedback = Object.freeze({ sequence, message });
    this.toolbarReceipts[action] = receipt;
    // Install before publication: a synchronous store subscriber can Close and
    // must be able to retire this timer along with its source-scoped receipt.
    this.toolbarTimers[action] = setTimeout(() => {
      if (this.toolbarReceipts[action] === receipt) this.clearToolbarFeedback(action);
    }, 3000);
    setApp(state => ({ toolbarFeedback: { ...state.toolbarFeedback, [action]: receipt } }));
  }
  get sourceFingerprint() { return this.fingerprint; }
  private generation = 0;
  private frame = 0;
  private warmedSurfaceRenderers = new WeakSet<SceneRenderer>();
  private viewportListeners = new Set<() => void>();
  private drawing = false;
  private readonly displayAdmission = new DisplayFrameAdmission();
  private lastDisplayPose?:DisplayPoseIdentity;
  private dirtyFrame = true;
  private histogramVisible = false;
  private lastTime = 0;
  private releaseScene?: ResourceLease;
  private releaseHistory?: ResourceLease;
  private editOperation?: EditOperation;
  private committedGraphicsRecovery?: { client: CoreClient; resolution: OperationResolution; admittedGpuBytes?: number };
  private retainedGraphicsCredit?: { client: CoreClient; scene: GaussianScene; lease: ResourceLease };
  // The sole live GPU scene is the immutable color base while native content
  // and history advance. A boundary stages baked content before clearing this.
  private colorDisplay?: ColorDisplayBinding & { scene: GaussianScene };
  private colorBoundary?: Promise<boolean>;
  private colorJob?: 'manual' | 'auto';
  private deferredColorPointer?: {
    token: DeferredColorPointerToken; client: CoreClient; camera: CameraController; renderer: SceneRenderer;
    generation: number; documentId: string; sourceGeneration: number; cameraRevision: number;
    width: number; height: number; tool: SelectionTool | null; operation: EditOperation; lease: ResourceLease; ready?: Promise<boolean>;
  };
  private deferredColorPointerId = 0;
  onDeferredPointerCancel?: () => void;
  private alignmentOwner?: AlignmentToolOwner;
  private alignmentPick?: object;
  private alignmentConfirming = false;
  private floorOwner?: FloorToolOwner;
  private floorPreparing?: object;
  private floorCleanup: Promise<void> = Promise.resolve();
  private floorTasks = new Set<Promise<boolean>>();
  // Desktop defaultCamera is a mutable view owner: history carries its current
  // values through frames instead of reading a historical Scene.defaultView.
  private alignmentDefaultCamera?: number[];
  private alignmentViews: AlignmentViewCheckpoints = new Map();
  private alignmentViewsLease?: ResourceLease;
  private canvas?: HTMLCanvasElement;
  private recovery?: Promise<boolean>;
  private recoveryCancel?: AbortController;
  private editingFailed = false;
  private selection?: GestureSelection;
  private selectionCleanup: Promise<void> = Promise.resolve();
  private selectionCleanupOwner?: SelectionCleanupOwner;
  private filterOwner?: FilterOwner;
  private filterGizmoGesture?: FilterGizmoGesture;
  private filterGizmoSequence = 0;
  private filterGizmoUnsubscribe?: () => void;
  private transformOwner?: TransformOwner;
  private opacityOwner?: OpacityOwner;
  private opacityTasks = new Set<Promise<boolean>>();
  private opacityEntryTask?: Promise<void>;
  private opacityEntryRequest?: { scale: number; client: CoreClient; documentId: string; generation: number; sourceGeneration: number };
  private transformTasks = new Set<Promise<boolean>>();
  private transformGizmoGesture?: TransformGizmoGesture;
  private transformGizmoSequence = 0;
  private transformGizmoActionOwner?: TransformOwner;
  private recoveredGizmo?: { owner: TransformOwner; mode: FilterGizmoMode };
  private transformGizmoUnsubscribe?: () => void;
  private transformGradeTask?: Promise<void>;
  private transformGradeRequest?: { values: number[]; client: CoreClient; generation: number; documentId: string; sourceGeneration: number };
  private transformToolSequence = 0;
  private transformNumericTask?: Promise<void>;
  private transformNumericRequest?: { parameters: TransformParameters; client: CoreClient; generation: number; sourceGeneration: number };
  private transformPivotQuery?: { cancel: AbortController; querying: boolean; automatic: boolean; task: Promise<boolean> };
  private transformPivotUnsubscribe?: () => void;
  private transformPivotQueued = false;
  private transformNumericFocus?: object;
  private transformPivotObserved?: { client: CoreClient; documentId: string; sourceGeneration: number; counter: number; geometry: string };
  private transformPivotDefaultPending = false;
  private transformPivotRefreshPending = false;
  private transformPivotFailedStamp?: string;
  private filterTasks = new Set<Promise<boolean>>();
  private cancellingSelection = false;
  private tolerance?: ToleranceSelection;
  private toleranceSequence = 0;
  private toleranceUpdateSequence = 0;
  private toleranceCleanup: Promise<void> = Promise.resolve();
  private selectionMaps = new DocumentSelectionMaps();
  private pendingTolerancePicks = new Set<Promise<void>>();
  private releasedSelections: ReleasedSelection[] = [];
  private releasedDrain?: Promise<void>;
  private selectionBarriers = 0;
  private selectionAction?: object;
  private manualSelectionHistoryWatch?: object;
  private manualSelectionHistory?: { client: CoreClient; documentId: string; sourceGeneration: number; startRevision: number };
  private releaseSelectionBarrier() {
    this.selectionBarriers--;
    // App renders availability from controller getters. Notify after the last
    // private barrier closes, rather than leaving the final busy:false render
    // with controls disabled. This changes no scene or render state.
    if (this.selectionBarriers === 0 && !this.destroyed) setApp({});
  }
  private exporting = false;
  private exportOperation?: ExportOperation;
  private exportDownloads = new Set<() => void>();
  acceptedExportFormat: SceneExportFormat = 0;
  private savedContent = 0;
  private outputReceipt?: { documentId: string; contentRevision: number; scope: number };
  // Compatibility observation only. Providers/Files belong to the authenticated
  // catalog; UI state receives scalar navigation data, never acquisition owners.
  private files: readonly Readonly<{ name: string }>[] = Object.freeze([]);
  private currentFile = 0;
  private collection?: OwnedSceneCollection;
  private intake?: CollectionIntake;
  private collectionCleanup = new Set<Promise<void>>();
  private collectionLoads = new WeakMap<OwnedSceneCollection, Set<Promise<void>>>();
  private dropIntakes = new WeakMap<SceneCollectionDrop, CollectionIntake>();
  private pendingNavigation?: { kind: 'replace' | 'close'; run(): Promise<void>; retire?(): Promise<void> };
  private sourceLoads = new Set<Promise<void>>();
  private loadAbort?: AbortController;
  private closeRequest?: Promise<void>;
  private closing?: Promise<void>;
  private appUpdateIntent?: { navigationCurrent?: () => boolean; unloading?: boolean };
  private ledger = new ResourceLedger(1024 * MiB);
  private resize?: ResizeObserver;
  private viewport?: { width: number; height: number };
  private destroyed = false;
  private benchmarkObservation?: BenchmarkObservation;
  private benchmarkMaskRead?:Promise<BenchmarkMaskObservation>;
  private benchmarkPickTasks?:Set<Promise<RenderPick>>;
  /** An explicit opt-in capture. Its unsubscribe owns only this capture. */
  enableBenchmarkObservation(options: { maxFrames?: number } = {}): () => void {
    if (this.destroyed) throw new Error('The viewer has been disposed.');
    if (this.benchmarkObservation?.active) throw new Error('Benchmark observation is already enabled.');
    const observation = new BenchmarkObservation(options.maxFrames, this.benchmarkObservation?.lastSequence ?? 0);
    this.benchmarkObservation = observation;
    if (this.renderer) observation.recordNegotiation(this.renderer.negotiationSnapshot);
    return () => observation.disable();
  }
  waitForBenchmarkFrame(afterSequence: number, timeoutMs = 10000): Promise<BenchmarkFrameObservation> {
    if (!this.benchmarkObservation) return Promise.reject(new Error('Benchmark observation has not been enabled.'));
    return this.benchmarkObservation.waitForFrame(afterSequence, timeoutMs);
  }
  private benchmarkQueryOwner(observation:BenchmarkObservation):BenchmarkQueryOwner {
    const client=this.client,renderer=this.renderer,scene=this.scene,camera=this.camera;
    return{clientOwnerId:client?observation.objectIdentity(client):null,rendererOwnerId:renderer?observation.objectIdentity(renderer):null,
      sceneOwnerId:scene?observation.objectIdentity(scene):null,cameraOwnerId:camera?observation.objectIdentity(camera):null,
      documentRevision:client?{...client.revision}:null,camera:camera?{revision:camera.revision,state:camera.state,
        view:Array.from(camera.view),projection:Array.from(camera.projection),eye:Array.from(camera.eye)}:null,
      scene:scene?.kind==='gaussian'?{revision:scene.revision,sourceRevision:scene.sourceRevision,selectedRevision:scene.selectedRevision,count:scene.count}:null,
      deviceEpoch:renderer?.deviceEpoch??null,rendererSubmissionSequence:renderer?.frameSubmissionSequence??null,
      framebuffer:renderer?{width:renderer.canvas.width,height:renderer.canvas.height,devicePixelRatio:window.devicePixelRatio}:null,
      visibility:document.visibilityState};
  }
  /** Existing ordinary UI preparation/pick, with observations only when opted in. */
  private selectionPixelPick(path:'ordinary-single'|'ordinary-color',renderer:SceneRenderer,scene:GaussianScene,camera:CameraController,
    x:number,y:number,grade:number[],selectedOnly:boolean){
    const observation=this.benchmarkObservation?.active?this.benchmarkObservation:undefined;
    if(!observation){const pending=renderer.render(scene,camera,grade,true,IDENTITY_MATRIX,selectedOnly);return pending?pending.then(()=>renderer.pick(scene,x,y)):renderer.pick(scene,x,y);}
    const task=this.observedSelectionPixelPick(observation,path,renderer,scene,camera,x,y,grade,selectedOnly);
    const tasks=this.benchmarkPickTasks??=new Set();tasks.add(task);void task.finally(()=>tasks.delete(task)).catch(()=>undefined);return task;
  }
  private async observedSelectionPixelPick(observation:BenchmarkObservation,path:'ordinary-single'|'ordinary-color',renderer:SceneRenderer,
    scene:GaussianScene,camera:CameraController,x:number,y:number,grade:number[],selectedOnly:boolean){
    let sequence:number|undefined,before:BenchmarkQueryOwner|undefined;
    try{before=this.benchmarkQueryOwner(observation);sequence=observation.beginPick({path,request:{x,y,centerRadius:0,sample:{x:Math.floor(x)+.5,y:Math.floor(y)+.5}},
      before:before!,renderState:{grade:[...grade],highlight:true,geometry:[...IDENTITY_MATRIX],selectedOnly,
        geometrySelectedOnly:selectedOnly,opacityScale:1,opacitySelectedOnly:false}},performance.now());}
    catch(error){observation.disable(`Pick observation failed: ${error instanceof Error?error.message:String(error)}`);}
    try{
      const pending=renderer.render(scene,camera,grade,true,IDENTITY_MATRIX,selectedOnly);if(pending)await pending;
      const hit=await renderer.pick(scene,x,y);
      if(observation?.active&&sequence!==undefined)try{
        const after=this.benchmarkQueryOwner(observation),bad=[hit.depth,hit.opacity,hit.contribution].some(value=>!Number.isFinite(value));
        observation.settlePick(sequence,performance.now(),after,{...hit,depth:Number.isFinite(hit.depth)?hit.depth:null,
          opacity:Number.isFinite(hit.opacity)?hit.opacity:null,contribution:Number.isFinite(hit.contribution)?hit.contribution:null},
          bad?'Production GPU pick returned non-finite decoded values.':null,before?benchmarkOwnerChange(before,after):'Pick observation was evicted.');
      }catch(error){observation.disable(`Pick settlement observation failed: ${error instanceof Error?error.message:String(error)}`);}
      return hit;
    }catch(error){
      if(observation?.active&&sequence!==undefined)try{observation.settlePick(sequence,performance.now(),this.benchmarkQueryOwner(observation),null,
        error instanceof Error?error.message:String(error));}catch{/* Preserve the actual UI failure. */}
      throw error;
    }
  }
  readBenchmarkMasks():Promise<BenchmarkMaskObservation>{
    const observation=this.benchmarkObservation;
    if(!observation?.active||this.destroyed)return Promise.reject(new Error('Benchmark mask observation is not active.'));
    if(this.benchmarkMaskRead)return Promise.reject(new Error('A benchmark state-mask read is already pending.'));
    const task=this.readBenchmarkMasksOwned(observation);this.benchmarkMaskRead=task;
    void task.finally(()=>{if(this.benchmarkMaskRead===task)this.benchmarkMaskRead=undefined;}).catch(()=>undefined);return task;
  }
  async joinBenchmarkQueries():Promise<void>{
    while(this.benchmarkMaskRead||this.benchmarkPickTasks?.size)
      await Promise.allSettled([...(this.benchmarkMaskRead?[this.benchmarkMaskRead]:[]),...(this.benchmarkPickTasks??[])]);
  }
  private async readBenchmarkMasksOwned(observation:BenchmarkObservation):Promise<BenchmarkMaskObservation>{
    const client=this.client,scene=this.scene,state=useApp.getState(),count=state.summary?.count;
    if(!client||scene?.kind!=='gaussian'||!this.renderer||this.renderer.lost||!this.camera||!state.ready||state.busy||this.editOperation||
      this.recovery||this.closing||this.closeRequest||this.destroyed||this.releasedSelections.length||this.releasedDrain||this.tolerance?.applying||
      !Number.isSafeInteger(count)||count!<1||count!>BENCHMARK_MASK_BYTE_LIMIT||count!==scene.count)
      throw new Error('Wait for a stable, bounded Gaussian document before reading its native state mask.');
    const startedAtMs=performance.now(),before=this.benchmarkQueryOwner(observation);let callbacks=0,byteLength=0,bytes:ArrayBuffer|undefined;
    let summary:unknown=null,error:string|null=null,lease:ResourceLease|undefined;
    try{
      lease=this.ledger.reserve('work',count!*9+65536);
      summary=await client.readMasks(value=>{callbacks++;if(callbacks===1&&value instanceof ArrayBuffer){byteLength=value.byteLength;if(value.byteLength<=BENCHMARK_MASK_BYTE_LIMIT)bytes=value;}});
      if(callbacks!==1||!bytes||bytes.byteLength!==count)error='Native state-mask callback count or byte length does not match the document.';
    }catch(failure){error=failure instanceof Error?failure.message:String(failure);}
    try{
      const after=this.benchmarkQueryOwner(observation),staleReason=benchmarkOwnerChange(before,after)??(!observation.active?'Benchmark observer ended during mask read.':null);
      return{schemaVersion:1,kind:'splatview-controller-benchmark-mask',status:error?'failed':staleReason?'stale':'completed',clock:'performance.now',
        startedAtMs,settledAtMs:performance.now(),before,after,sourceCount:count!,byteLength,encoding:'base64',
        bytesBase64:bytes?benchmarkMaskBase64(new Uint8Array(bytes)):null,callbacks,summary,error,staleReason};
    }finally{lease?.();}
  }
  private benchmarkOperationState(): BenchmarkOperationState {
    const state = useApp.getState();
    return { busy: state.busy, stage: state.stage, error: state.error, navigationPrompt: state.navigationPrompt,
      hasScene: !!this.scene, hasClient: !!this.client, documentRevision: this.client ? { ...this.client.revision } : null };
  }
  /** Opt-in camera boundary only; avoids copying accumulated frame/operation histories. */
  benchmarkCameraSnapshot() {
    const observation = this.benchmarkObservation;
    if (!observation?.active || this.destroyed) throw new Error('Benchmark camera observation is not active.');
    const state = useApp.getState(), renderer = this.renderer, camera = this.camera;
    return benchmarkReadonlyCopy({ schemaVersion: 1, kind: 'splatview-controller-benchmark-camera', capturedAtMs: performance.now(),
      state: { ready: state.ready, busy: state.busy, error: state.error, bootstrapState: state.bootstrapState,
        rendererState: state.rendererState, runtimeMode: state.runtimeMode, hasScene: !!this.scene, hasClient: !!this.client,
        documentRevision: this.client ? { ...this.client.revision } : null },
      camera: camera ? { revision: camera.revision, state: camera.state, view: Array.from(camera.view),
        projection: Array.from(camera.projection), eye: Array.from(camera.eye) } : null,
      framebuffer: this.canvas ? { width: this.canvas.width, height: this.canvas.height, devicePixelRatio: window.devicePixelRatio } : null,
      renderer: renderer ? { ready: !renderer.lost, deviceEpoch: renderer.deviceEpoch, frameSubmissionSequence: renderer.frameSubmissionSequence } : null,
      observation: { enabled: observation.active, lastFrameSequence: observation.lastSequence } });
  }
  /** Detached observations; logical reservations are not physical memory. */
  benchmarkSnapshot() {
    const state = useApp.getState(), renderer = this.renderer, camera = this.camera;
    const nativeAccounts: { roles: string[]; state: NativeHeapAccounting['state']; census: Exclude<CoreClient['nativeAllocationCensus'], undefined> | null }[] = [];
    const accountIndices = new Map<NativeHeapAccounting, number>();
    const addAccount = (memory: NativeHeapAccounting | undefined, role: string, client?: CoreClient) => {
      if (!memory) return;
      const existing = accountIndices.get(memory);
      if (existing !== undefined) {
        nativeAccounts[existing].roles.push(role);
        if (client?.nativeAllocationCensus) nativeAccounts[existing].census = client.nativeAllocationCensus;
      } else {
        accountIndices.set(memory, nativeAccounts.length);
        nativeAccounts.push({ roles: [role], state: memory.state, census: client?.nativeAllocationCensus ?? null });
      }
    };
    addAccount(this.client?.nativeMemory, 'active-client', this.client);
    addAccount(this.candidate?.nativeMemory, 'candidate-client', this.candidate);
    addAccount(this.bootstrapClient?.nativeMemory, 'bootstrap-client', this.bootstrapClient);
    addAccount(this.sourceMemory, 'source-accounting'); addAccount(this.bootstrapMemory, 'bootstrap-accounting');
    return benchmarkReadonlyCopy({ schemaVersion: 1, kind: 'splatview-controller-benchmark-observation', clock: 'performance.now', capturedAtMs: performance.now(),
      state: { ready: state.ready, busy: state.busy, stage: state.stage, progress: state.progress, error: state.error,
        rendererState: state.rendererState, bootstrapState: state.bootstrapState, runtimeMode: state.runtimeMode,
        summary: state.summary, navigationPrompt: state.navigationPrompt, outputPending: state.outputPending, destroyed: this.destroyed,
        hasScene: !!this.scene, hasClient: !!this.client, dirty: state.dirty,
        documentRevision: this.client ? { ...this.client.revision } : null },
      camera: camera ? { revision: camera.revision, state: camera.state, view: Array.from(camera.view),
        projection: Array.from(camera.projection), eye: Array.from(camera.eye), background: camera.background } : null,
      framebuffer: this.canvas ? { width: this.canvas.width, height: this.canvas.height, devicePixelRatio: window.devicePixelRatio } : null,
      renderer: renderer ? { ready: !renderer.lost, deviceEpoch: renderer.deviceEpoch,
        frameSubmissionSequence: renderer.frameSubmissionSequence, negotiation: renderer.negotiationSnapshot } : null,
      observation: this.benchmarkObservation?.snapshot() ?? null,
      selectionMapCache:this.benchmarkObservation?.active?this.selectionMaps.diagnosticSnapshot(value=>this.benchmarkObservation!.objectIdentity(value)):null,
      memory: { logicalLedger: { limitBytes: this.ledger.limit, ...this.ledger.usage, overageBytes: this.ledger.overageBytes,
          categories: this.ledger.categorySnapshot }, nativeAccounts, nativeAccountScope: 'currently-addressable-controller-accounts',
        physicalJsHeap: { available: false, reason: 'The controller does not measure physical JavaScript heap usage.' },
        physicalGpuMemory: { available: false, reason: 'WebGPU does not expose physical device allocation usage here.' } },
      knownPending: { scope: 'named-controller-owned-sets-and-flags-only', sourceLoadTasks: this.sourceLoads.size,
        collectionCleanupTasks: this.collectionCleanup.size, thumbnailTasks: this.thumbnailTasks.size,
        savedViewTransferTasks: this.viewTransferTasks.size, imageTasks: this.imageTasks.size,
        filterTasks: this.filterTasks.size, transformTasks: this.transformTasks.size, opacityTasks: this.opacityTasks.size,
        floorTasks: this.floorTasks.size, tolerancePickTasks: this.pendingTolerancePicks.size,
        releasedSelectionOwners: this.releasedSelections.length, selectionBarriers: this.selectionBarriers,
        viewDownloadCallbacks: this.viewDownloads.size, imageDownloadCallbacks: this.imageDownloads.size,
        exportDownloadCallbacks: this.exportDownloads.size, candidateClient: !!this.candidate, bootstrapClient: !!this.bootstrapClient,
        collectionIntakeOwner: !!this.intake, recoveryTask: !!this.recovery, closeRequest: !!this.closeRequest,
        closeDocumentTask: !!this.closing, editOperation: !!this.editOperation, exportOperation: !!this.exportOperation,
        filterOwner: !!this.filterOwner, transformOwner: !!this.transformOwner, opacityOwner: !!this.opacityOwner,
        floorOwner: !!this.floorOwner, selectionCleanupOwner: !!this.selectionCleanupOwner,
        opacityEntryTask: !!this.opacityEntryTask, transformGradeTask: !!this.transformGradeTask,
        transformNumericTask: !!this.transformNumericTask, releasedSelectionDrain: !!this.releasedDrain,
        drawing: this.drawing, scheduledAnimationFrame: this.frame !== 0,
        benchmarkMaskReads:this.benchmarkMaskRead?1:0,
        benchmarkPickTasks:this.benchmarkPickTasks?.size??0,
        unavailable: ['CoreClient private pending requests/deliveries', 'renderer private query/retirement queues', 'promise settlement of cleanup chain fields'] } });
  }
  private graphicsBackend?: GraphicsBackend;
  private backendPreferenceInitialized = false;
  onCanvasReplacement?: (previous: HTMLCanvasElement) => Promise<HTMLCanvasElement>;
  private estimateSceneBytes(count: number, degree: number) {
    return estimateRendererSceneBytes(count, degree, this.graphicsBackend ?? this.renderer?.backend ?? 'webgpu');
  }
  private async createRenderer(canvas: HTMLCanvasElement): Promise<SceneRenderer> {
    if (!this.backendPreferenceInitialized) {
      this.backendPreferenceInitialized = true;
      const requested = typeof location === 'undefined' ? null : new URL(location.href).searchParams.get('graphics');
      if (requested) setApp({ backendPreference: validateBackendPreference(requested) });
    }
    const observation = this.benchmarkObservation;
    const renderer = await createSceneRenderer(canvas, { createCompute: createVerifiedRenderCompute, preference: useApp.getState().backendPreference,
      recoveryBackend: this.graphicsBackend, allowFallback: true,
      observe: observation?.active ? value => observation.recordNegotiation(value) : undefined,
      fallback: graphicsFallbackReason => setApp({ graphicsFallbackReason }),
      replaceCanvas: async previous => {
        if (!this.onCanvasReplacement) throw new Error('A new presentation canvas is required to restore graphics. Your document is retained.');
        this.onViewportResize?.(); this.camera?.clearInput();
        const next = await this.onCanvasReplacement(previous);
        if (this.destroyed || this.canvas !== previous) throw new DOMException('Graphics restoration cancelled', 'AbortError');
        this.resize?.disconnect(); this.resize = undefined; this.canvas = next;
        this.synchronizeViewport(); this.observeCanvas(); return next;
      } });
    this.graphicsBackend = renderer.backend; setApp({ graphicsBackend: renderer.backend }); return renderer;
  }
  async setBackendPreference(value: GraphicsBackendPreference) {
    const preference = validateBackendPreference(value);
    if (!registeredAllowed(`GraphicsBackendPreference.${preference}`, 'ui')) throw new Error('This graphics backend is unavailable.');
    if (this.scene || this.client || this.recovery || this.closing || this.closeRequest || this.destroyed || useApp.getState().busy) return false;
    this.backendPreferenceInitialized = true; this.graphicsBackend = undefined;
    setApp({ backendPreference: preference, graphicsFallbackReason: null }); return this.retryRenderer();
  }
  private async observeBenchmarkOperation(kind: 'open-files' | 'close-scene', run: () => Promise<void>) {
    const observation = this.benchmarkObservation!;
    const id = observation.beginOperation(kind, performance.now(), this.benchmarkOperationState());
    try {
      await run(); if (observation.active) observation.settleOperation(id, performance.now(), this.benchmarkOperationState());
    } catch (error) {
      if (observation.active) observation.settleOperation(id, performance.now(), this.benchmarkOperationState(), error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
  private observeBenchmarkSubmission(observation: BenchmarkObservation, context: BenchmarkFrameContext,
    renderer: SceneRenderer, camera: CameraController, scene: RenderScene | undefined, client: CoreClient | undefined,
    previousSubmission: number, rafAtMs: number, drawStartedAtMs: number, drawError: unknown = null) {
    if (!observation.active || renderer.frameSubmissionSequence <= previousSubmission) return;
    try {
      context.rendererSubmissionSequence = renderer.frameSubmissionSequence;
      context.drawError = drawError === null ? null : drawError instanceof Error ? drawError.message : String(drawError);
      const id = observation.recordSubmission(context, rafAtMs, drawStartedAtMs, performance.now());
      if (context.drawError !== null) {
        // render() threw after submit; ordinary draw() has no queue fence on
        // this failure path. Preserve that boundary and do not invent one.
        observation.failFrameBeforeQueueObservation(id, context.drawError); return;
      }
      const staleReason = () => this.destroyed ? 'Controller disposed before queue completion.' :
        this.renderer !== renderer || renderer.deviceEpoch !== context.deviceEpoch ? 'Renderer owner changed before queue completion.' :
        this.scene !== scene || (scene?.revision ?? null) !== context.sceneRevision ? 'Scene owner/revision changed before queue completion.' :
        this.client !== client || context.documentRevision && (!client || !sameRevision(context.documentRevision, client.revision)) ? 'Document owner/revision changed before queue completion.' :
        this.camera !== camera || camera.revision !== context.camera.revision ? 'Camera owner/revision changed before queue completion.' :
        renderer.canvas.width !== context.framebuffer.width || renderer.canvas.height !== context.framebuffer.height ? 'Framebuffer changed before queue completion.' : null;
      return (error: unknown = null) => {
        if (!observation.active) return;
        try { observation.settleFrame(id, performance.now(), error === null ? null : error instanceof Error ? error.message : String(error), staleReason()); }
        catch (failure) { observation.disable(`Benchmark completion observation failed: ${failure instanceof Error ? failure.message : String(failure)}`); }
      };
    } catch (failure) { observation.disable(`Benchmark submission observation failed: ${failure instanceof Error ? failure.message : String(failure)}`); }
  }
  onOpenPicker?: () => void;
  onViewportResize?: () => void;
  onSelectionOperationChanged?: (operation: number) => void;
  async initialize(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.watchTransformPivot();
    let coreReady = false;
    setApp({ bootstrapState: 'initializing', ready: false });
    try {
      await this.ensureStartupCore(); coreReady = true;
      if (this.destroyed) return;
      setApp({ bootstrapState: 'ready', runtimeMode: getRuntimeVerificationMode() ?? null });
      const [graphics, navigation] = await Promise.allSettled([this.createRenderer(canvas), CameraController.create()]);
      if (graphics.status === 'rejected' || navigation.status === 'rejected') {
        if (graphics.status === 'fulfilled') graphics.value.dispose();
        if (navigation.status === 'fulfilled') navigation.value.dispose();
        throw graphics.status === 'rejected' ? graphics.reason : navigation.status === 'rejected' ? navigation.reason : new Error('Initialization failed');
      }
      this.renderer = graphics.value; this.camera = navigation.value;
      if (this.destroyed) { this.renderer.dispose(); this.camera.dispose(); return; }
      this.synchronizeViewport(); this.observeCanvas(); this.watchRenderer(this.renderer);
      if (this.renderer.lost) throw new Error('The graphics device was lost during initialization. Retry graphics.');
      setApp({ ready: true, rendererState: 'ready' }); this.invalidate();
    } catch (error) {
      const bootstrap = this.bootstrapClient, memory = this.bootstrapMemory;
      this.bootstrapClient = undefined; this.bootstrapMemory = undefined;
      if (bootstrap) await bootstrap.retireNativeMemory(); else memory?.retire();
      if (!this.destroyed) setApp({ ready: false, rendererState: 'unavailable', bootstrapState: coreReady ? 'ready' : 'failed' });
      this.error(error);
    }
  }
  private async ensureStartupCore() {
    await ensureRuntime();
    if (this.destroyed) throw new DOMException('The viewer was closed.', 'AbortError');
    // Keep this scene-free client for the first candidate instead of retaining
    // an extra idle native heap throughout editing.
    if (!this.client && !this.bootstrapClient) {
      const memory = this.createNativeMemory(); this.bootstrapMemory = memory;
      try { this.bootstrapClient = this.createCoreClient(memory); }
      catch (error) { memory.retire(); this.bootstrapMemory = undefined; throw error; }
    }
    const client = this.client ?? this.bootstrapClient!;
    await client.ready();
  }
  private createNativeMemory() {
    const lease = this.ledger.reserve('source', 32 * MiB);
    try { return new NativeHeapAccounting(this.ledger, lease); }
    catch (error) { lease(); throw error; }
  }
  private recoveryMetadata(summary: NativeSummary, activeCamera = this.camera!.state,
    defaultCamera = this.defaultAlignmentCamera(), checkpoints = this.alignmentViews,
    savedContent = this.savedContent, background = this.camera!.background): RecoveryMetadata {
    const currentTransform = validateTransformSummary(summary.transformSession ?? null);
    // Gizmo Cancel baselines are transient. A new worker retains accepted
    // geometry/history and finalizes the gizmo, while numeric owners restore.
    const transform = currentTransform?.kind === 'numeric' ? currentTransform : null;
    // The acknowledged native matrix is authoritative even if a numeric input
    // changed while Apply was in flight. Unfinished UI values are not replayed.
    const parameters = transform ? { ...transformDefaults(), mode: 'matrix' as const,
      matrix: transform.appliedMatrix.map((_, index, values) => values[(index % 4) * 4 + Math.floor(index / 4)]) as TransformMatrix,
      pivot: [...transform.pivot] as TransformVec3 } : null;
    return encodeRecoveryMetadata({ native: { kind: summary.kind, count: summary.count,
      sourceCount: summary.sourceCount, duplicateRange: summary.duplicateRange, shDegree: summary.shDegree, format: summary.format },
      alignment: validateAlignmentSummary(summary.alignment), activeCamera, defaultCamera, background,
      alignmentViews: checkpoints, savedContent, applied: { color: colorSessionState(summary.colorSession),
        transform: transform ? { session: transform, parameters: parameters! } : null,
        opacity: validateOpacitySummary(summary.opacitySession ?? null) } });
  }
  private createCoreClient(memory: NativeHeapAccounting, seed?: CoreClientRecoverySeed) {
    const client = new CoreClient(memory, seed);
    client.onNativeMemoryChanged = () => this.syncMemoryOverage();
    client.onOperationRecovery = recovery => {
      if (this.destroyed || this.client !== client) return;
      this.camera?.clearInput();
      const retained = this.committedGraphicsRecovery?.client === client;
      setApp({ operationRecovery: retained && recovery.state === 'idle' ? 'required' : recovery.state,
        operationRecoveryCommitted: retained,
        ...(recovery.state === 'checking' ? { stage: 'Checking the edit result' } : {}), autoOrbit: false });
    };
    client.onWorkerFailure = failure => {
      if (this.destroyed || this.client !== client || this.workerFailure) return;
      this.workerFailure = { client, failure };
      this.camera?.clearInput(); cancelAnimationFrame(this.frame); this.frame = 0;
      setApp({ ready: false, rendererState: 'unavailable', operationRecovery: 'required',
        operationRecoveryCommitted: !!failure.decision, autoOrbit: false,
        dirty: useApp.getState().dirty || (this.documentRecovery?.description?.plan.contentRevision ?? this.savedContent) !== this.savedContent,
        error: 'The scene worker stopped. Restoring the last accepted state.' });
      // Enter through the same controller lock as graphics recovery. The edit
      // finalizer, rather than its caller, owns the resource-join barrier.
      queueMicrotask(() => { if (this.workerFailure?.client === client && this.documentRecovery?.description) void this.retryRenderer(); });
    };
    return client;
  }
  private get operationRecoveryBlocked() {
    return useApp.getState().operationRecovery !== 'idle' || !!this.committedGraphicsRecovery;
  }
  async retryOperationRecovery(): Promise<boolean> {
    if (this.workerFailure) return this.retryRenderer();
    const client = this.client, owner = client?.operationOwner;
    try {
      if (client && owner) return await client.retryOperation(owner);
      // Native reconstruction can publish before a later GPU retirement
      // fails. That surviving authority needs a new mirror, without an old
      // edit receipt or another worker reconstruction.
      const retainedNative = !!client && !client.failed && !this.editingFailed &&
        !!this.documentRecovery?.description && useApp.getState().rendererState === 'unavailable';
      return this.committedGraphicsRecovery || retainedNative ? await this.retryRenderer() : false;
    } catch (error) { this.error(error); return false; }
  }
  private syncMemoryOverage() {
    if (!this.destroyed && useApp.getState().memoryOverageBytes !== this.ledger.overageBytes)
      setApp({ memoryOverageBytes: this.ledger.overageBytes });
  }
  private bindNativeCoverage(client: CoreClient, scene: ResourceLease, history?: ResourceLease, sceneNativeBytes?: number) {
    const coverage: NativeSceneCoverage = { scene, history, sceneNativeBytes };
    this.nativeCoverage.set(client, coverage);
    client.setNativeCoveragePlanner(allocation => this.planNativeCoverage(coverage, allocation));
    return coverage;
  }
  private planNativeCoverage(coverage: NativeSceneCoverage, allocation: NativeAllocationSnapshot): NativeCoverageUpdate[] {
    const base = allocation.loaded ? allocation.kind === 0 ? allocation.count * 144 : allocation.memoryBytes : 0;
    const history = allocation.loaded && allocation.kind === 0 ?
      Math.max(0, allocation.memoryBytes - base - allocation.selectionMapBytes - (allocation.exportBytes ?? 0)) : 0;
    // A growing candidate cannot borrow the old mirror's GPU reservation.
    // Its extra native records stay under work until both owners publish.
    const sceneBytes = Math.min(base, allocation.kind === 0 ? coverage.sceneNativeBytes ?? base : base, coverage.scene.bytes), historyBytes = Math.min(history, coverage.history?.bytes ?? 0);
    const updates: NativeCoverageUpdate[] = [{ lease: coverage.scene, nextLeaseBytes: coverage.scene.bytes, nativeBytes: sceneBytes }];
    if (coverage.history) updates.push({ lease: coverage.history, nextLeaseBytes: coverage.history.bytes, nativeBytes: historyBytes });
    if (coverage.work) updates.push({ lease: coverage.work, nextLeaseBytes: coverage.work.bytes,
      nativeBytes: Math.min(Math.max(0, base - sceneBytes + history - historyBytes), coverage.work.bytes) });
    return updates;
  }
  private shrinkNativeHistory(client: CoreClient, summary: NativeSummary) {
    const history = this.nativeCoverage.get(client)?.history;
    if (history) {
      const bytes = Math.min(history.bytes, nativeHistoryBytes(summary));
      client.updateNativeCoverage([{ lease: history, nextLeaseBytes: bytes, nativeBytes: bytes }]);
    }
  }
  private transferEditCoverage(client: CoreClient, history: ResourceLease, work: ResourceLease,
    actualHistoryBytes: number, nextHistoryBytes: number, retirementBytes: number,
    sceneChange?: { bytes: number; nativeBytes: number }) {
    const admitted = checkedBytes(history.bytes + work.bytes, 1);
    // The response planner covers history first and any remaining actual
    // payload with work. Moving that payload changes R by the opposite amount;
    // future GPU/JS credit never contributes to native coverage.
    const currentNative = Math.min(actualHistoryBytes, admitted);
    const nextNative = Math.min(actualHistoryBytes, nextHistoryBytes);
    const coverage = this.nativeCoverage.get(client);
    if (sceneChange && !coverage) throw new AdmissionError('The edit target has no admitted scene owner.');
    const sceneDelta = sceneChange && coverage ? sceneChange.bytes - coverage.scene.bytes : 0;
    const nextWorkBytes = admitted - nextHistoryBytes + nextNative - currentNative - sceneDelta;
    if (!Number.isSafeInteger(nextWorkBytes) || nextWorkBytes < retirementBytes)
      throw new AdmissionError('The admitted edit memory cannot retain its GPU retirement.');
    client.transferNativeCoverage([
      ...(sceneChange && coverage ? [{ lease: coverage.scene, nextLeaseBytes: sceneChange.bytes, nativeBytes: sceneChange.nativeBytes }] : []),
      { lease: history, nextLeaseBytes: nextHistoryBytes, nativeBytes: nextNative },
      { lease: work, nextLeaseBytes: nextWorkBytes, nativeBytes: 0 },
    ]);
    if (sceneChange && coverage) coverage.sceneNativeBytes = sceneChange.nativeBytes;
  }
  private releaseRetainedGraphics(scene: RenderScene | undefined) {
    const retained = this.retainedGraphicsCredit;
    if (!retained || retained.scene !== scene) return;
    this.retainedGraphicsCredit = undefined;
    retained.client.releaseNativeCoverage(retained.lease);
  }
  private syncDuplicateFeedback(summary = useApp.getState().summary) {
    if (summary?.kind === 0 && this.scene?.kind === 'gaussian' && this.scene.count === summary.count)
      this.scene.setDuplicateRange(summary.duplicateRange);
  }
  private observeCanvas() {
    if (this.resize || !this.canvas) return;
    this.resize = new ResizeObserver(() => {
      if (this.synchronizeViewport()) this.invalidate();
    });
    this.resize.observe(this.canvas);
  }
  private synchronizeViewport() {
    const canvas = this.canvas, camera = this.camera;
    if (!canvas || !camera || this.destroyed) return false;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr)), height = Math.max(1, Math.round(rect.height * dpr));
    // Publish the displayed viewport before accepting input. The observer's
    // delayed first delivery must preserve owners created after readiness.
    // CSS changes still cancel pointer work when rounding keeps pixels equal.
    const resized = this.viewport?.width !== rect.width || this.viewport?.height !== rect.height ||
      canvas.width !== width || canvas.height !== height;
    if (resized) { this.cancelFilterGizmoGesture(); this.cancelTransformGizmoGesture(); this.onViewportResize?.(); }
    this.viewport = { width: rect.width, height: rect.height };
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const revision = camera.revision;
    camera.aspect(width / height);
    return resized || camera.revision !== revision;
  }
  private watchRenderer(renderer: SceneRenderer) {
    renderer.admitWork = bytes => { this.client?.assertNativeAdmission(); return this.ledger.reserve('work', bytes); };
    renderer.admitSortScratch = bytes => { this.client?.assertNativeAdmission(); return this.ledger.reserve('render', bytes); };
    renderer.admitGeometryDepth = bytes => { this.client?.assertNativeAdmission(); return this.ledger.reserve('render', bytes); };
    renderer.admitHistogram = bytes => { this.client?.assertNativeAdmission(); return this.ledger.reserve('render', bytes); };
    renderer.admitSteady = bytes => { this.client?.assertNativeAdmission(); return this.ledger.reserve('render', bytes); };
    renderer.onRenderStatus = renderStatus => {
      if (renderer === this.renderer && !this.destroyed) setApp({ renderStatus });
    };
    renderer.setRenderSettings(useApp.getState().renderSettings);
    setApp({ renderStatus: renderer.steadySnapshot.status });
    renderer.onHistogram = (histogram, scene) => {
      if (renderer === this.renderer && scene === this.scene && this.histogramVisible && !this.destroyed &&
          !this.recovery && !this.closing && !document.hidden) setApp({ histogram });
    };
    renderer.onHistogramUnavailable = () => {
      if (renderer === this.renderer && !this.destroyed) setApp({ histogram: null, histogramUnavailable: true });
    };
    setApp({ histogram: null, histogramUnavailable: false });
    renderer.onFrameNeeded = () => { if (renderer === this.renderer && !this.destroyed) this.invalidate(); };
    renderer.onLost = message => { if (renderer === this.renderer && !this.destroyed) this.error(new Error(message)); };
    renderer.onDeviceLost = () => { if (renderer === this.renderer && !this.destroyed) void this.retryRenderer(); };
  }
  setHistogramVisible(visible: boolean) {
    if (this.histogramVisible === visible) return;
    this.histogramVisible = visible;
    this.renderer?.setHistogramEnabled(visible && this.scene?.kind === 'gaussian' && !document.hidden);
    if (!visible) setApp({ histogram: null });
    this.invalidate();
  }
  retryRenderer(): Promise<boolean> {
    this.cancelDeferredColorPointers();
    if (this.recovery) return this.recovery;
    if (this.destroyed || this.closing || this.closeRequest || !this.canvas) return Promise.resolve(false);
    this.cancelImageCaptures();
    const recoveringGizmoMode = !this.workerFailure ? useApp.getState().transformGizmoMode : null;
    this.recoveredGizmo = undefined;
    const abort = new AbortController(); this.recoveryCancel = abort;
    const task = (this.workerFailure ? this.restoreWorker(abort.signal) : this.restoreRenderer(abort.signal, recoveringGizmoMode)).catch(error => {
      if (!this.destroyed) { setApp({ ready: false, rendererState: 'unavailable', busy: false, stage: '' }); this.error(error); }
      return false;
    }).then(restored => {
      if (restored && this.recovery === task && !this.destroyed) {
        // Publish readiness after releasing the controller lock so every
        // subscriber observes an editor that can actually accept input.
        this.recovery = undefined; this.recoveryCancel = undefined;
        this.transformPivotFailedStamp = undefined;
        const recoveredGizmo = this.recoveredGizmo; this.recoveredGizmo = undefined;
        const keepGizmo = recoveredGizmo && this.transformScopeCurrent(recoveredGizmo.owner);
        setApp({ ready: true, rendererState: 'ready', bootstrapState: 'ready', runtimeMode: getRuntimeVerificationMode() ?? null, busy: false, stage: '', error: null, selectionRecovery: 'idle', operationRecovery: 'idle', operationRecoveryCommitted: false,
          ...(keepGizmo ? { transformGizmoMode: recoveredGizmo.mode } : {}) });
        if (keepGizmo) this.watchTransformGizmo();
        this.invalidate();
      }
      return restored;
    }).finally(() => {
      if (this.recovery === task) { this.recovery = undefined; this.recoveryCancel = undefined; this.invalidate(); }
    });
    this.recovery = task; return task;
  }
  private async restoreWorker(signal: AbortSignal): Promise<boolean> {
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    const failed = this.workerFailure, store = this.documentRecovery, description = store?.description;
    if (!failed || !store || !description || !this.canvas || !this.camera) return false;
    const metadata = decodeRecoveryMetadata(description.metadata);
    const oldClient = failed.client, oldScene = this.scene, oldRenderer = this.renderer;
    const oldLease = this.releaseScene, oldHistory = this.releaseHistory;
    const publishedAlignment = validateAlignmentSummary(useApp.getState().summary?.alignment);
    const sameFrame = metadata.alignment === null ? publishedAlignment === null :
      publishedAlignment !== null && sameAlignmentBranch(metadata.alignment, publishedAlignment);
    // Main-thread navigation can advance after the latest scene checkpoint.
    // Carry it only when it belongs to that checkpoint's coordinate frame.
    const active = sameFrame ? this.camera.state : [...metadata.activeCamera];
    const defaultCamera = sameFrame ? this.defaultAlignmentCamera() : [...metadata.defaultCamera];
    const views = sameFrame ? this.alignmentViews : new Map(metadata.alignmentViews);
    this.cancelLoad(); const generation = this.generation;
    this.camera.clearInput(); cancelAnimationFrame(this.frame); this.frame = 0;
    this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer(); this.exportOperation?.cancel.abort();
    setApp({ ready: false, rendererState: 'recovering', busy: true, stage: 'Restoring scene', error: null,
      autoOrbit: false, histogram: null });
    let candidate: CoreClient | undefined, memory: NativeHeapAccounting | undefined;
    let replacement: SceneRenderer | undefined, staged: RenderScene | undefined;
    let lease: ResourceLease | undefined, history: ResourceLease | undefined;
    let viewsLease: ResourceLease | undefined;
    let reader: Awaited<ReturnType<DocumentRecoveryStore['openRestore']>> | undefined;
    let acceptedTransformReference: TransformOwner | undefined;
    let oldGraphicsRetirement: Promise<void> | undefined, oldGraphicsReleased = false;
    const releaseOldGraphics = () => {
      if (oldGraphicsReleased) return;
      oldGraphicsReleased = true;
      try { oldRenderer?.dispose(); }
      finally {
        oldLease?.(); oldHistory?.();
        // Early retirement can precede publication. A later Retry must not
        // resize released leases or reuse a disposed scene or renderer.
        if (this.scene === oldScene) this.scene = undefined;
        if (this.renderer === oldRenderer) this.renderer = undefined;
        if (this.releaseScene === oldLease) this.releaseScene = undefined;
        if (this.releaseHistory === oldHistory) this.releaseHistory = undefined;
        if (this.colorDisplay?.scene === oldScene) this.colorDisplay = undefined;
      }
    };
    const retireOldGraphics = () => oldGraphicsRetirement ??= Promise.resolve().then(async () => {
      await oldScene?.dispose();
      this.releaseRetainedGraphics(oldScene);
      releaseOldGraphics();
    });
    const check = () => {
      if (signal.aborted || this.destroyed || this.generation !== generation || this.workerFailure !== failed ||
          this.documentRecovery !== store || store.description !== description || this.client !== oldClient)
        throw new DOMException('Scene restoration cancelled', 'AbortError');
    };
    try {
      this.cancelEdit(); this.selection?.cancel.abort();
      for (const record of this.releasedSelections) record.cancel.abort();
      this.tolerance?.mapQuery?.abort(); this.tolerance?.session.retire(); this.tolerance?.previous?.session.retire();
      const operation = this.editOperation;
      if (operation) await operation.finished;
      check();
      // These owners belong to the terminated generation. Their asynchronous
      // finalizers retain their leases until they join, but cannot publish into
      // the replacement document or issue cleanup commands against it.
      this.selection = undefined; this.tolerance = undefined; this.selectionCleanupOwner = undefined;
      this.cancellingSelection = false; this.filterOwner = undefined; this.filterGizmoGesture = undefined;
      acceptedTransformReference = this.transformOwner;
      this.transformOwner = undefined; this.transformGizmoGesture = undefined; this.transformGradeRequest = undefined;
      this.opacityOwner = undefined; this.opacityEntryRequest = undefined;
      this.alignmentOwner = undefined; this.alignmentPick = undefined; this.floorPreparing = undefined;
      const floor = this.floorOwner; this.floorOwner = undefined; floor?.cancel.abort();
      if (floor) void Promise.resolve(floor.task).finally(() => floor.metadata()).catch(() => undefined);
      await this.selectionMaps.invalidate();
      await oldClient.retireNativeMemory(); check();
      // Termination has joined native borrowers. Retain only the old GPU
      // mirror while admitting the new module and its complete import peak.
      oldLease?.resize(oldScene?.allocationBytes ?? 0); oldHistory?.resize(0);
      if (views.size) viewsLease = this.ledger.reserve('history', ALIGNMENT_VIEW_BOOKKEEPING_BYTES);
      memory = this.createNativeMemory();
      candidate = this.createCoreClient(memory, { revision: { ...description.binding.revision }, expectedBinding: description.binding });
      await candidate.ready(); check();
      reader = await store.openRestore(signal); check();
      const budgetBytes = Math.min(512 * MiB, this.ledger.limit - this.ledger.usage.bytes + memory.remainder.bytes);
      const summary = await candidate.restoreRecoveryCheckpoint(reader, { binding: description.binding, plan: description.plan,
        revision: recoveryPublicationRevision(description.binding.revision, failed.failure.revision),
        expectedSummary: metadata.native, budgetBytes, signal }); reader = undefined; check();
      const alignment = validateAlignmentSummary(summary.alignment), transform = validateTransformSummary(summary.transformSession ?? null),
        opacity = validateOpacitySummary(summary.opacitySession ?? null), color = colorSessionState(summary.colorSession);
      if (canonicalJson(alignment) !== canonicalJson(metadata.alignment) ||
          !sameTransformSummary(transform, metadata.applied.transform?.session ?? null) ||
          !sameOpacitySummary(opacity, metadata.applied.opacity) || canonicalJson(color) !== canonicalJson(metadata.applied.color) ||
          !selectionRestored(summary)) throw new Error('The restored scene does not match its accepted browser metadata.');
      lease = this.ledger.reserve('decoded', 0); history = this.ledger.reserve('history', 0);
      const nativeBytes = summary.kind === 0 ? summary.count * 144 : summary.memoryBytes;
      const coverage: NativeCoverageUpdate[] = [{ lease,
        nextLeaseBytes: summary.kind === 0 ? this.estimateSceneBytes(summary.count, summary.shDegree) : nativeBytes,
        nativeBytes }, { lease: history, nextLeaseBytes: nativeHistoryBytes(summary), nativeBytes: nativeHistoryBytes(summary) }];
      try { candidate.updateNativeCoverage(coverage); }
      catch (error) {
        if (!(error instanceof AdmissionError) || candidate.failed || candidate.nativeMemory?.state.unreconciledHeapBytes !== null ||
            !oldScene || oldScene.retired || !oldLease || !this.ledger.owns(oldLease, 'decoded') || oldLease.bytes === 0) throw error;
        // Native import is already complete. Join the retained old mirror
        // before retrying its replacement's admission once on this candidate.
        check(); await retireOldGraphics(); check();
        candidate.updateNativeCoverage(coverage);
      }
      this.bindNativeCoverage(candidate, lease, history, summary.kind === 0 ? summary.count * 144 : undefined);
      replacement = await this.createRenderer(this.canvas); this.watchRenderer(replacement); check();
      if (summary.kind === 0) {
        const gaussian = await replacement.allocateScene(summary.count, summary.shDegree); staged = gaussian;
        const streamed = await this.uploadNativeScene(candidate, gaussian, opacity ? 'opacityBase' : transform ? 'transformBase' : color ? 'colorBase' : 'document', check,
          bytes => candidate!.updateNativeCoverage([{ lease: lease!, nextLeaseBytes: lease!.bytes + bytes, nativeBytes }]));
        if (streamed.revision !== summary.revision || streamed.contentRevision !== summary.contentRevision || streamed.count !== summary.count ||
            streamed.sourceCount !== summary.sourceCount || !sameDuplicateRange(streamed.duplicateRange, summary.duplicateRange))
          throw new Error('The restored graphics do not match the accepted scene.');
      } else {
        const descriptor = geometryDescriptor(summary), geometry = await replacement.allocateGeometry(descriptor); staged = geometry;
        const streamed = await candidate.streamGeometry(descriptor,
          (first, count, bytes) => { check(); return geometry.uploadVertices(first, count, bytes); },
          (first, count, bytes) => { check(); return geometry.uploadIndices(first, count, bytes); });
        if (!sameGeometryDescriptor(geometryDescriptor(streamed), descriptor)) throw new Error('The restored geometry changed.');
        candidate.updateNativeCoverage([{ lease, nextLeaseBytes: nativeBytes + geometry.allocationBytes + 64 * 1024, nativeBytes }]);
      }
      await replacement.finish(); check();
      if (replacement.lost) throw new Error('The replacement graphics device was lost.');
      candidate.activateNativeMemory();
      this.client = candidate; candidate = undefined; this.sourceMemory = memory; memory = undefined;
      this.renderer = replacement; replacement = undefined; this.scene = staged; staged = undefined;
      this.releaseScene = lease; lease = undefined; this.releaseHistory = history; history = undefined;
      this.workerFailure = undefined; this.committedGraphicsRecovery = undefined; this.editingFailed = false; this.colorDisplay = undefined;
      active[10] = this.renderer.canvas.width / this.renderer.canvas.height; this.camera.set(active);
      this.camera.background = sameFrame ? this.camera.background : metadata.background;
      this.alignmentDefaultCamera = defaultCamera; this.alignmentViews = views;
      this.alignmentViewsLease?.(); this.alignmentViewsLease = viewsLease; viewsLease = undefined;
      setApp({ summary, dirty: summary.contentRevision !== this.savedContent, background: this.camera.background,
        tool: null, filter: null, selectionDragging: false, selectionOperation: null, pendingMode: null,
        filterGizmoMode: null, filterGizmoDragging: false, filterCenterPicking: false, filterCenterPending: false,
        transform: null, transformPreview: null, transformGizmoMode: null, transformGizmoDragging: false,
        opacity: null, opacityPreview: null, opacityScale: opacity?.appliedScale ?? 1,
        alignmentTool: null, alignmentFloor: null, alignmentPicking: false });
      // A reconstructed worker owns the accepted checkpoint, including its
      // applied color. Discard desired previews from the terminated generation.
      this.acknowledgeColor(summary, color?.applied ?? [...NEUTRAL_COLOR], false, useApp.getState().gradeRevision);
      if (transform && metadata.applied.transform) {
        const parameters = transformUiParameters(metadata.applied.transform.parameters)!;
        const previous = acceptedTransformReference, sameBase = previous?.metadata && previous.metadata.id === transform.id &&
          previous.metadata.baseId === transform.baseId && previous.metadata.epoch === transform.epoch;
        // Only an acknowledged reference can accompany the restored matrix.
        // A pending pivot under nonneutral rotation/scale belongs to the draft.
        const pivotMode = sameBase ? previous.appliedPivotMode ?? 'custom' : 'custom';
        const pivotChosen = sameBase ? previous.appliedPivotChosen ?? false : false;
        if (sameBase) parameters.pivot = [...previous.appliedParameters.pivot];
        this.transformOwner = { client: this.client, documentId: this.client.revision.documentId,
          sourceGeneration: this.client.revision.sourceGeneration, generation, scene: this.scene as GaussianScene, renderer: this.renderer,
          kind: transform.kind, selectedOnly: transform.selectedOnly, metadata: transform, nextEpoch: transform.epoch + 1,
          parameters, appliedParameters: transformUiParameters(parameters)!, desiredRevision: 0, appliedRevision: 0,
          phase: 'ready', applyRequested: false, cancelRequested: false,
          appliedPivotMode: pivotMode, appliedPivotChosen: pivotChosen };
        setApp({ transformParameters: parameters, transformPivotMode: pivotMode, transformPivotChosen: pivotChosen }); this.refreshTransformPreview(this.transformOwner);
      }
      if (opacity) {
        this.opacityOwner = { client: this.client, documentId: this.client.revision.documentId,
          sourceGeneration: this.client.revision.sourceGeneration, generation, scene: this.scene as GaussianScene, renderer: this.renderer,
          selectedOnly: opacity.selectedOnly, metadata: opacity, nextEpoch: opacity.epoch + 1,
          scale: opacity.appliedScale, appliedScale: opacity.appliedScale, desiredRevision: 0, appliedRevision: 0,
          phase: 'ready', applyRequested: false, cancelRequested: false };
        this.refreshOpacityPreview(this.opacityOwner);
      }
      try { await retireOldGraphics(); }
      finally { releaseOldGraphics(); }
      if (this.renderer.lost) throw new Error('The replacement graphics device was lost during restoration.');
      this.syncMemoryOverage(); return true;
    } catch (error) {
      if (!this.destroyed) {
        setApp({ ready: false, rendererState: 'unavailable', busy: false, stage: '', operationRecovery: 'required' });
        this.error(new Error(`The scene could not be restored. Its accepted checkpoint is retained; retry restoration. ${error instanceof Error ? error.message : String(error)}`));
      }
      return false;
    } finally {
      if (reader) await reader.cancel();
      if (staged) await staged.dispose(); replacement?.dispose();
      if (candidate) { candidate.dispose(); await candidate.retireNativeMemory(); } else memory?.retire();
      lease?.(); history?.(); viewsLease?.(); this.syncMemoryOverage();
    }
  }
  private async restoreRenderer(signal: AbortSignal, recoveringGizmoMode: FilterGizmoMode | null = null) {
    await this.cancelTransformPivotFocus();
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    this.cancelFilterGizmoGesture(undefined, true);
    this.cancelTransformGizmoGesture(undefined, true);
    this.cancelAlignment();
    await this.floorCleanup;
    const oldRenderer = this.renderer;
    oldRenderer?.setHistogramEnabled(false);
    setApp({ histogram: null });
    this.cancelLoad(); cancelAnimationFrame(this.frame); this.frame = 0; this.lastTime = 0;
    const generation = this.generation;
    const previewBeforeRecovery = useApp.getState();
    const recoveringFilter = this.filterOwner;
    let recoveringTransform = this.transformOwner;
    let recoveringOpacity = this.opacityOwner;
    this.opacityEntryRequest = undefined;
    if (recoveringOpacity) { recoveringOpacity.cancelRequested = true; recoveringOpacity.applyRequested = false; }
    if (recoveringTransform) { recoveringTransform.cancelRequested = true; recoveringTransform.applyRequested = false; }
    if (recoveringFilter) {
      recoveringFilter.cancelRequested = true; recoveringFilter.previewRequested = false; recoveringFilter.confirmRequested = false;
      recoveringFilter.phase = 'cancelling'; this.cancelFilterCenterPick(); this.publishFilter(recoveringFilter);
    }
    this.camera?.clearInput();
    setApp({ rendererState: 'recovering', ready: false, busy: true, stage: 'Restoring graphics', error: null, autoOrbit: false });
    let replacement: SceneRenderer | undefined, staged: RenderScene | undefined, lease: ResourceLease | undefined;
    const check = () => { if (signal.aborted || this.destroyed || this.generation !== generation) throw new DOMException('Graphics restoration cancelled', 'AbortError'); };
    try {
      await this.ensureStartupCore(); check();
      // Finish/roll back the native edit before rebuilding its GPU mirror. A
      // lost renderer cannot publish the selection cancellation itself.
      const operation = this.editOperation; this.cancelEdit();
      if (operation) await operation.finished;
      const committedRecovery = this.committedGraphicsRecovery;
      if (committedRecovery && committedRecovery.client !== this.client)
        throw new Error('The committed edit belongs to a different document.');
      if (recoveringFilter) await Promise.allSettled([...(recoveringFilter.task ? [recoveringFilter.task] : []),
        ...(recoveringFilter.cancellation ? [recoveringFilter.cancellation] : []), ...(recoveringFilter.centerTask ? [recoveringFilter.centerTask] : [])]);
      if (recoveringTransform) await Promise.allSettled([...(recoveringTransform.task ? [recoveringTransform.task] : []), ...(recoveringTransform.ending ? [recoveringTransform.ending] : [])]);
      if (recoveringTransform && this.transformOwner !== recoveringTransform) {
        if (this.transformOwner) throw new Error('The transform owner changed during graphics restoration.');
        recoveringTransform = undefined;
      }
      if (this.opacityEntryTask) await this.opacityEntryTask;
      if (recoveringOpacity) await Promise.allSettled([...(recoveringOpacity.task ? [recoveringOpacity.task] : []), ...(recoveringOpacity.ending ? [recoveringOpacity.ending] : [])]);
      if (recoveringOpacity && this.opacityOwner !== recoveringOpacity) {
        if (this.opacityOwner) throw new Error('The opacity owner changed during graphics restoration.');
        recoveringOpacity = undefined;
      }
      // A durable Floor commit can create its retirement only after the edit
      // joins. Close that newer owner before rebuilding graphics.
      this.cancelAlignment(); await this.floorCleanup; check();
      if (!committedRecovery) {
        await this.selectionMaps.invalidate();
        await this.closeToleranceSelection();
        await this.cancelSelectionGesture();
      }
      check();
      const client = this.client, cleanup = this.selectionCleanupOwner, filterCleanup = this.filterOwner, documentId = client?.revision.documentId;
      let summary = client ? await client.command({ command: committedRecovery || filterCleanup || recoveringTransform || recoveringOpacity || this.scene?.kind === 'geometry' || useApp.getState().colorSession?.active ? 'summary' : 'cancelSelection' }) : null;
      if (committedRecovery && summary) assertOperationSummary(committedRecovery.resolution.receipt, summary);
      const opacityMetadata = summary ? validateOpacitySummary(summary.opacitySession) : null;
      if (opacityMetadata && (!recoveringOpacity || recoveringOpacity.metadata && (opacityMetadata.id !== recoveringOpacity.metadata.id || opacityMetadata.baseId !== recoveringOpacity.metadata.baseId) ||
        opacityMetadata.selectedOnly !== recoveringOpacity.selectedOnly)) throw new Error('Graphics restoration found a different opacity owner.');
      if (recoveringOpacity && this.editingFailed) throw new Error('The opacity commit could not be reconciled. Close and reopen the source.');
      if (recoveringOpacity?.metadata && !opacityMetadata) throw new Error('Graphics restoration lost the retained opacity owner.');
      const transformMetadata = summary ? validateTransformSummary(summary.transformSession ?? null) : null;
      if (transformMetadata && (!recoveringTransform || recoveringTransform.metadata &&
        (transformMetadata.id !== recoveringTransform.metadata.id || !committedRecovery && transformMetadata.baseId !== recoveringTransform.metadata.baseId) ||
        transformMetadata.kind !== recoveringTransform.kind || transformMetadata.selectedOnly !== recoveringTransform.selectedOnly))
        throw new Error('Graphics restoration found a different transform owner.');
      if (recoveringTransform && this.editingFailed) throw new Error('The transform commit could not be reconciled. Close and reopen the source.');
      if (recoveringTransform?.metadata && !transformMetadata) throw new Error('Graphics restoration lost the retained transform owner.');
      if (summary && client && filterCleanup && !committedRecovery) {
        const metadata = validateFilterSummary(summary.filter);
        if (metadata) {
          if (metadata.kind !== filterCleanup.kind || filterCleanup.id !== undefined && metadata.id !== filterCleanup.id)
            throw new Error('Graphics restoration found a different filter owner.');
          filterCleanup.id = metadata.id;
          summary = await client.command({ command: 'cancelFilter', id: metadata.id });
        }
      }
      check();
      if (summary && (!committedRecovery && !selectionRestored(summary) || (cleanup || filterCleanup) && this.editingFailed))
        throw new Error('The selection or edit checkpoint could not be reconciled. The document is retained.');
      const revision = client && { ...client.revision };
      const checkDocument = () => {
        check();
        if (this.client !== client || client && (client.revision.documentId !== documentId || !sameRevision(client.revision, revision!)) ||
            this.selectionCleanupOwner !== cleanup || this.filterOwner !== filterCleanup || this.transformOwner !== recoveringTransform || this.opacityOwner !== recoveringOpacity)
          throw new Error('The document changed during graphics restoration.');
      };
      checkDocument();
      if (!this.camera) this.camera = await CameraController.create();
      this.synchronizeViewport(); this.observeCanvas();
      if (summary) {
        client?.assertNativeAdmission();
        const geometry = summary.kind === 0 ? null : geometryDescriptor(summary);
        lease = this.ledger.reserve('render', geometry ? checkedBytes(geometry.vertexBytes + geometry.indexBytes, 1) + 20 * MiB :
          this.estimateSceneBytes(summary.count, summary.shDegree) - summary.count * 144 + 20 * MiB);
      }
      replacement = await this.createRenderer(this.canvas!); this.watchRenderer(replacement); check();
      if (summary && client) {
        let streamed: NativeSummary;
        if (summary.kind === 0) {
          const gaussian = await replacement.allocateScene(summary.count, summary.shDegree); staged = gaussian; check();
          streamed = await this.uploadNativeScene(client, gaussian, opacityMetadata ? 'opacityBase' : transformMetadata ? 'transformBase' : summary.colorSession?.active ? 'colorBase' : 'document', checkDocument,
            bytes => lease!.resize(lease!.bytes + bytes));
        } else {
          const descriptor = geometryDescriptor(summary);
          const geometry = await replacement.allocateGeometry(descriptor); staged = geometry; check();
          streamed = await client.streamGeometry(descriptor,
            (first, count, bytes) => { checkDocument(); return geometry.uploadVertices(first, count, bytes); },
            (first, count, bytes) => { checkDocument(); return geometry.uploadIndices(first, count, bytes); });
          if (!sameGeometryDescriptor(geometryDescriptor(streamed), descriptor))
            throw new Error('The restored geometry does not match the authoritative document.');
        }
        checkDocument();
        if (committedRecovery) assertOperationSummary(committedRecovery.resolution.receipt, streamed);
        if (!committedRecovery && !selectionRestored(streamed) || streamed.kind !== summary.kind || streamed.count !== summary.count || streamed.shDegree !== summary.shDegree ||
            streamed.sourceCount !== summary.sourceCount || !sameDuplicateRange(streamed.duplicateRange, summary.duplicateRange) ||
            streamed.contentRevision !== summary.contentRevision || streamed.revision !== summary.revision ||
            opacityMetadata && !sameOpacitySummary(validateOpacitySummary(streamed.opacitySession), opacityMetadata))
          throw new Error('The restored graphics do not match the authoritative document.');
        await replacement.finish(); checkDocument();
      }
      if (replacement.lost) throw new Error('The replacement graphics device was lost.');
      const oldScene = this.scene;
      if (client && summary?.kind === 0 && staged && this.releaseScene) {
        // A committed edit already transferred the source lease to its target
        // mirror before the acknowledgement failed. Its retained old mirror
        // has separate retirement credit and cannot supply this baseline twice.
        const delta = staged.allocationBytes - (committedRecovery?.admittedGpuBytes ?? oldScene?.allocationBytes ?? 0);
        if (delta) client.updateNativeCoverage([{ lease: this.releaseScene, nextLeaseBytes: this.releaseScene.bytes + delta, nativeBytes: summary.count * 144 }]);
      }
      this.renderer = replacement; replacement = undefined; this.scene = staged; staged = undefined;
      if (recoveringTransform) {
        if (transformMetadata) {
          recoveringTransform.scene = this.scene as GaussianScene; recoveringTransform.renderer = this.renderer;
          recoveringTransform.generation = generation;
          recoveringTransform.metadata = transformMetadata; recoveringTransform.nextEpoch = Math.max(recoveringTransform.nextEpoch, transformMetadata.epoch + 1);
          recoveringTransform.cancelRequested = false; recoveringTransform.phase = 'ready';
          if (recoveringTransform.kind === 'gizmo') {
            this.rebuildTransformGizmoWidget(recoveringTransform);
            if (recoveringGizmoMode) this.recoveredGizmo = { owner: recoveringTransform, mode: recoveringGizmoMode };
          }
          this.refreshTransformPreview(recoveringTransform);
        } else this.retireTransform(recoveringTransform, false);
      }
      this.colorDisplay = undefined;
      this.watchRenderer(this.renderer);
      if (recoveringOpacity) {
        if (opacityMetadata) {
          recoveringOpacity.scene = this.scene as GaussianScene; recoveringOpacity.renderer = this.renderer; recoveringOpacity.metadata = opacityMetadata;
          recoveringOpacity.generation = generation;
          recoveringOpacity.nextEpoch = Math.max(recoveringOpacity.nextEpoch, opacityMetadata.epoch + 1);
          recoveringOpacity.cancelRequested = false; recoveringOpacity.phase = 'ready'; this.refreshOpacityPreview(recoveringOpacity);
        } else this.retireOpacity(recoveringOpacity, false);
      }
      if (summary) {
        if (client) this.shrinkNativeHistory(client, summary);
        setApp({ summary, dirty: summary.contentRevision !== this.savedContent || this.transformDirty || this.opacityDirty });
        this.acknowledgeColor(summary, summary.colorSession?.values);
        if (!summary.colorSession && !previewBeforeRecovery.colorSession &&
          summary.contentRevision === previewBeforeRecovery.summary?.contentRevision &&
          !sameColorValues(previewBeforeRecovery.grade, previewBeforeRecovery.appliedGrade)) {
          setApp({ grade: [...previewBeforeRecovery.grade], appliedGrade: [...previewBeforeRecovery.appliedGrade],
            colorSelectedOnly: previewBeforeRecovery.colorSelectedOnly, gradeRevision: useApp.getState().gradeRevision + 1, dirty: true });
        }
      }
      if (oldScene) await oldScene.dispose();
      this.releaseRetainedGraphics(oldScene); oldRenderer?.dispose();
      checkDocument();
      if (this.renderer.lost) throw new Error('The replacement graphics device was lost during restoration.');
      // The old renderer may have been unable to publish cancellation. Only
      // this exact native acknowledgement plus installed replacement mirror
      // can discharge its retained cleanup authority.
      if (cleanup && this.selectionCleanupOwner === cleanup) {
        cleanup.restored = true; this.selectionCleanupOwner = undefined; this.cancellingSelection = false;
      }
      if (filterCleanup && this.filterOwner === filterCleanup) {
        if (committedRecovery && summary?.filter) {
          filterCleanup.scene = this.scene as GaussianScene; filterCleanup.renderer = this.renderer;
          filterCleanup.cancelRequested = false; filterCleanup.phase = 'ready'; this.publishFilter(filterCleanup);
        } else this.retireFilter(filterCleanup);
      }
      if (committedRecovery && this.committedGraphicsRecovery === committedRecovery) this.committedGraphicsRecovery = undefined;
      return true;
    } catch (error) {
      if (!this.destroyed) {
        if (recoveringFilter && this.filterOwner === recoveringFilter) this.requireFilterCleanup(recoveringFilter);
        if (recoveringTransform && this.transformOwner === recoveringTransform) this.requireTransformCleanup(recoveringTransform);
        if (recoveringOpacity && this.opacityOwner === recoveringOpacity) this.requireOpacityCleanup(recoveringOpacity);
        setApp({ ready: false, rendererState: 'unavailable', busy: false, stage: '',
          ...(this.committedGraphicsRecovery ? { operationRecovery: 'required' as const } : {}) });
        const action = this.selectionCleanupOwner || this.filterOwner ? 'retry graphics to restore the selection' :
          this.scene?.kind === 'geometry' ? 'retry graphics or reopen the source' : 'retry graphics or save the scene';
        this.error(new Error(`Graphics could not be restored. Your document is retained; ${action}. ${error instanceof Error ? error.message : String(error)}`));
      }
      return false;
    } finally {
      if (staged) await staged.dispose(); replacement?.dispose(); lease?.();
    }
  }
  private error(error: unknown) { if (!this.destroyed) setApp({ error: error instanceof Error ? error.message : String(error) }); }
  /** Base geometry and its effective edit targets are separate from the full
   * acknowledged selection. A replacement is unpublished until both arrive. */
  private async uploadNativeScene(client: CoreClient, scene: GaussianScene, channel: MaskChannel, check: () => void, admitTarget: (bytes: number) => void) {
    const work = channel === 'document' ? undefined : this.ledger.reserve('work', scene.count * 6);
    let target: ArrayBuffer | undefined;
    let update: Awaited<ReturnType<GaussianScene['stagePreviewMasks']>> | undefined;
    try {
      const summary = await client.stream((first, count, bytes) => { check(); return scene.upload(first, count, bytes); }, bytes => {
        check();
        if (channel === 'document') scene.masks(bytes); else target = bytes;
      }, channel);
      check();
      if (channel !== 'document') {
        let canonical: ArrayBuffer | undefined;
        await client.readMasks(bytes => { check(); canonical = bytes; scene.masks(bytes); }); check();
        if (!target || target.byteLength !== scene.count) throw new Error('The retained edit target is unavailable.');
        if (!canonical || canonical.byteLength !== scene.count) throw new Error('The acknowledged document mask is unavailable.');
        const selectedOnly = channel === 'colorBase' ? summary.colorSession?.selectedOnly : channel === 'transformBase' ?
          summary.transformSession?.selectedOnly : summary.opacitySession?.selectedOnly;
        if (selectedOnly) {
          admitTarget(scene.count * 4); check();
          update = await scene.stagePreviewMasks(target, channel); target = undefined;
          await scene.renderer.finish(); check();
          update.publish();
          await scene.renderer.finish(); check();
          for (const buffer of update.retirementBuffers) buffer.destroy();
        }
      }
      scene.setDuplicateRange(summary.duplicateRange);
      return summary;
    } finally { await update?.dispose(); work?.(); }
  }
  /** Observe displayed camera frames without scheduling another scene render. */
  subscribeViewport(listener: () => void) {
    if (this.destroyed) return () => {};
    this.viewportListeners.add(listener);
    return () => { this.viewportListeners.delete(listener); };
  }
  invalidate() {
    this.syncMemoryOverage();
    if (this.alignmentOwner && !this.alignmentConfirming &&
        (!this.alignmentCurrent(this.alignmentOwner) || !sameRevision(this.alignmentOwner.revision, this.alignmentOwner.client.revision)))
      this.cancelAlignment();
    if (!this.editOperation) this.selectionMaps.validate();
    this.validateReleasedSelections();
    if (this.selection && this.camera?.revision !== this.selection.cameraRevision) void this.cancelSelectionGesture();
    if (this.tolerance && !this.toleranceCurrent(this.tolerance)) this.endToleranceSelection();
    const filter = this.filterOwner;
    if (filter && useApp.getState().currentViewOnly && !filter.cancelRequested && filter.phase !== 'preparing') {
      const revision = this.selectionViewRevision();
      if (filter.viewRevision !== revision) {
        filter.viewRevision = revision; filter.desiredRevision++;
        if (filter.previewEpoch !== null || filter.previewRequested) {
          filter.previewRequested = true;
          if (!filter.task && !this.editOperation) void this.trackFilterTask(filter, () => this.runFilterRequests(filter));
        }
      }
    }
    this.dirtyFrame = true;
    if (!this.frame && !this.destroyed && !document.hidden) this.frame = requestAnimationFrame(time => this.draw(time));
  }
  setRenderSettings(value: SteadySettings) {
    const settings = validateSteadySettings(value);
    if (!registeredAllowed(`GaussianRenderMode.${settings.mode}`, 'ui')) throw new Error('This rendering mode is unavailable.');
    this.renderer?.setRenderSettings(settings);
    setApp({ renderSettings: settings }); this.invalidate();
  }
  async prepareRenderMode(mode: SteadySettings['mode']): Promise<void> {
    if (!this.renderer || this.renderer.lost || this.destroyed || this.recovery || this.closing) return Promise.resolve();
    return this.renderer.prepareRenderMode(mode);
  }
  private async draw(time: number) {
    this.frame = 0;
    if (!this.renderer || !this.camera || this.renderer.lost || this.recovery || this.destroyed || document.hidden) { this.lastTime = 0; return; }
    if (this.drawing) { this.invalidate(); return; }
    const displayRenderer = this.renderer, displayScene = this.scene;
    const displayIdentity = { owner: displayRenderer, scene: displayScene, width: displayRenderer.canvas.width, height: displayRenderer.canvas.height };
    if (!this.displayAdmission.canSubmit(displayIdentity)) return;
    const displayBefore = displayRenderer.frameSubmissionSequence;
    const state = useApp.getState();
    const elapsed = this.lastTime ? Math.max(0, (time - this.lastTime) / 1000) : 0;
    // Freeze input-driven pose updates across the irreversible commit reply;
    // camera/default/roll metadata publish as one prepared result afterward.
    if (!this.editOperation?.committing && !this.transformGizmoGesture && !this.filterGizmoGesture) {
      if (this.camera.tick(elapsed, state.fly)) this.dirtyFrame = true;
      if (state.autoOrbit) { this.camera.orbit(Math.min(.05, elapsed) * 30, 0); this.dirtyFrame = true; }
    }
    this.validateReleasedSelections();
    this.lastTime = time;
    const displayPose={owner:displayRenderer,scene:displayScene,camera:this.camera,revision:this.camera.revision};
    displayRenderer.displaySortPrecision=interactiveDisplayPrecision(this.lastDisplayPose,displayPose);
    if (!this.dirtyFrame) { if (this.camera.active || state.autoOrbit) this.invalidate(); else this.lastTime = 0; return; }
    this.dirtyFrame = false; this.drawing = true;
    const observation = this.benchmarkObservation?.active ? this.benchmarkObservation : undefined;
    const observedRenderer = observation ? this.renderer : undefined, observedCamera = observation ? this.camera : undefined;
    const observedScene = observation ? this.scene : undefined, observedClient = observation ? this.client : undefined;
    const observedContext: BenchmarkFrameContext | undefined = observation ? {
      deviceEpoch: this.renderer.deviceEpoch, rendererSubmissionSequence: this.renderer.frameSubmissionSequence,
      documentRevision: this.client ? { ...this.client.revision } : null, sceneRevision: this.scene?.revision ?? null,
      camera: { revision: this.camera.revision, state: this.camera.state, view: Array.from(this.camera.view),
        projection: Array.from(this.camera.projection), eye: Array.from(this.camera.eye) },
      framebuffer: { width: this.renderer.canvas.width, height: this.renderer.canvas.height, devicePixelRatio: window.devicePixelRatio },
      visibility: document.visibilityState,
    } : undefined;
    const observedPreviousSubmission = observedContext?.rendererSubmissionSequence;
    const observedDrawStart = observation ? performance.now() : undefined;
    try {
      this.renderer.setHistogramEnabled(this.histogramVisible && state.toolsOpen && this.scene?.kind === 'gaussian' && !document.hidden);
      this.syncDuplicateFeedback(state.summary);
      const pendingRender = this.renderer.render(this.scene, this.camera, state.grade, true, state.transformPreview?.matrix ?? IDENTITY_MATRIX,
        this.colorScope, state.transformPreview?.selectedOnly ?? false, state.opacityPreview?.scale ?? 1, state.opacityPreview?.selectedOnly ?? false);
      if (pendingRender) await pendingRender;
    }
    catch (error) {
      if (observation && observedContext && observedRenderer && observedCamera) this.observeBenchmarkSubmission(observation, observedContext,
        observedRenderer, observedCamera, observedScene, observedClient, observedPreviousSubmission!, time, observedDrawStart!, error);
      this.drawing = false; if (this.renderer === displayRenderer) this.error(error); return;
    }
    const observeCompletion = observation && observedContext && observedRenderer && observedCamera ? this.observeBenchmarkSubmission(observation, observedContext,
      observedRenderer, observedCamera, observedScene, observedClient, observedPreviousSubmission!, time, observedDrawStart!) : undefined;
    const checkpoint = displayRenderer.displayCompletion?.();
    if (checkpoint && checkpoint.submissionSequence > displayBefore) {
      this.displayAdmission.track(displayIdentity, checkpoint);
      this.lastDisplayPose=displayPose;
      if(displayRenderer.displaySortPrecision<32)this.dirtyFrame=true;
    }
    const submittedWork = checkpoint?.done ?? displayRenderer.finish();
    // Prepare after an actual first frame, without delaying loading or a
    // selection. A failed warmup is retried by the real query, not every frame.
    if (this.scene?.kind === 'gaussian' && !this.warmedSurfaceRenderers.has(this.renderer)) {
      this.warmedSurfaceRenderers.add(this.renderer);
      void this.renderer.prepareSurfaceResources().catch(() => undefined);
    }
    // Reuse the exact existing fence; the normal path adds no timing calls,
    // frame records, camera copies or extra GPU API calls.
    if (observeCompletion) void submittedWork.then(() => observeCompletion(), error => observeCompletion(error));
    // CPU preparation remains serialized. A second matching display may be
    // submitted while the first fence is pending; full finish/retirement stays
    // with the renderer. Old-owner completion never releases a newer CPU draw.
    this.drawing = false;
    const continueDisplay = () => {
      if (this.dirtyFrame || useApp.getState().autoOrbit || this.camera?.active) this.invalidate();
      else if (!this.drawing && !this.displayAdmission.inFlight) this.lastTime = 0;
    };
    void submittedWork.catch(error => { if (this.renderer === displayRenderer) this.error(error); }).finally(continueDisplay);
    continueDisplay();
    // Presentation overlays follow an actual display frame and do not keep the
    // scheduler awake. Snapshot subscriptions so cleanup cannot extend a pass.
    if (this.viewportListeners.size) for (const listener of [...this.viewportListeners]) listener();
  }
  private collectionOptions(owner: CollectionIntake) {
    return { admit: (bytes: number) => this.ledger.reserve('source', bytes), current: () => this.checkIntake(owner) };
  }
  private checkIntake(owner: CollectionIntake) {
    if (this.destroyed || this.closing || this.closeRequest || this.intake !== owner || owner.cancel.signal.aborted)
      throw new DOMException('Collection intake cancelled', 'AbortError');
  }
  private trackCollectionCleanup(task: Promise<void>) {
    this.collectionCleanup.add(task);
    void task.catch(error => { if (!this.destroyed) this.error(error); }).finally(() => this.collectionCleanup.delete(task));
    return task;
  }
  private retireCollection(collection: OwnedSceneCollection): Promise<void> {
    const loads = [...(this.collectionLoads.get(collection) ?? [])];
    return this.trackCollectionCleanup((async () => {
      await Promise.allSettled(loads);
      await collection.dispose();
    })());
  }
  private async drainCollectionCleanup() {
    for (;;) {
      const pending = [...this.collectionCleanup];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }
  private collectionIntakeBlocked() {
    return this.operationRecoveryBlocked || this.destroyed || this.exporting || !!this.closing || !!this.closeRequest || !!this.selectionCleanupOwner || !!this.filterOwner ||
      this.transformBlocksOrdinary || this.opacityBlocksOrdinary || !!this.opacityEntryTask || useApp.getState().selectionRecovery !== 'idle';
  }
  private holdIntakeBarrier(owner: CollectionIntake) {
    if (owner.barrier) return;
    owner.barrier = true; this.selectionBarriers++;
  }
  private releaseIntakeBarrier(owner: CollectionIntake) {
    if (!owner.barrier) return;
    owner.barrier = false; this.releaseSelectionBarrier();
  }
  private retireIntake(owner: CollectionIntake): Promise<void> {
    if (owner.cleanup) return owner.cleanup;
    owner.cancel.abort();
    if (this.intake === owner) this.intake = undefined;
    // Cancellation retires admission authority immediately. Actual provider
    // callbacks still retain their credits through the tracked joined cleanup.
    this.releaseIntakeBarrier(owner);
    return owner.cleanup = this.trackCollectionCleanup((async () => {
      try {
        let collection = owner.collection;
        if (owner.scan) { try { collection ??= await owner.scan; } catch { /* Factory joins its callbacks before rejecting. */ } }
        if (collection && owner.ownsCollection && collection !== this.collection) {
          await Promise.allSettled(this.collectionLoads.get(collection) ?? []);
          await collection.dispose();
        }
        await owner.drop?.dispose();
        if (owner.drop) this.dropIntakes.delete(owner.drop);
        owner.collection = undefined; owner.scan = undefined; owner.drop = undefined;
      } finally {
        this.releaseIntakeBarrier(owner);
      }
    })());
  }
  private cancelIntake() {
    const navigation = this.pendingNavigation; this.pendingNavigation = undefined;
    if (navigation?.retire) void navigation.retire();
    if (this.intake) void this.retireIntake(this.intake);
    setApp({ navigationPrompt: false, navigationIntent: null, outputPending: false });
  }
  private beginIntake(ownsCollection: boolean): CollectionIntake {
    // A new source request supersedes a waiting application reload, including
    // one whose cleanup or durable ticket has not returned yet.
    this.appUpdateIntent = undefined;
    this.cancelDeferredColorPointers();
    const owner: CollectionIntake = { cancel: new AbortController(), ownsCollection, barrier: false };
    // Fence export and selection admission before discovery or supersession can
    // invoke callbacks; a retiring old owner cannot release this owner's fence.
    this.holdIntakeBarrier(owner);
    try {
      this.cancelIntake();
      if (this.candidate || this.loadAbort) this.cancelCandidateLoad();
      this.intake = owner; return owner;
    } catch (error) { this.releaseIntakeBarrier(owner); throw error; }
  }
  private async intakeCollection(owner: CollectionIntake, factory: () => Promise<OwnedSceneCollection>) {
    try {
      this.checkIntake(owner);
      if (this.collectionIntakeBlocked()) return;
      setApp({ busy: true, stage: 'Finding scene files', progress: 0, error: null });
      owner.scan = factory(); owner.collection = await owner.scan;
      this.checkIntake(owner);
      if (this.collectionIntakeBlocked()) return;
      if (!owner.collection.entries.length) throw new Error('Choose a PLY, SPZ, SPLAT, KSPLAT, SOG or SOGS scene, or SOG meta.json with its resources.');
      await this.navigateCollection(owner, 0);
    } catch (error) { if (this.intake === owner && !owner.cancel.signal.aborted) this.error(error); }
    finally {
      if (!this.destroyed && !this.candidate && !this.editOperation && this.intake === owner) setApp({ busy: false, stage: '' });
      if (!this.pendingNavigation || this.intake !== owner) await this.retireIntake(owner);
    }
  }
  openFiles(files: ArrayLike<File>): Promise<void> {
    return this.benchmarkObservation?.active ? this.observeBenchmarkOperation('open-files', () => this.openFilesUnobserved(files)) : this.openFilesUnobserved(files);
  }
  /** The ordinary intake owns download, supersession, dirty navigation and publication. */
  async openExample(): Promise<boolean> {
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked) return false;
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return false;
    if (this.transformOwner && !await this.endTransformSession()) return false;
    if (this.collectionIntakeBlocked()) return false;
    const owner = this.beginIntake(true);
    await this.intakeCollection(owner, async () => {
      const sample = prepareExampleSceneCollection({ ...this.collectionOptions(owner), signal: owner.cancel.signal,
        url: new URL(EXAMPLE_SCENE.path, new URL(import.meta.env.BASE_URL, document.baseURI)) });
      owner.example = { ownsFile: sample.ownsFile };
      return sample.collection;
    });
    const published = owner.example?.published, state = useApp.getState();
    return !!published && !this.destroyed && !this.closing && !this.closeRequest &&
      published.generation === this.generation && published.scene === this.scene && published.client === this.client &&
      state.ready && state.rendererState === 'ready' && !state.busy && !state.error;
  }
  private async openFilesUnobserved(files: ArrayLike<File>) {
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked) return;
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return;
    if (this.transformOwner && !await this.endTransformSession()) return;
    if (this.collectionIntakeBlocked()) return;
    const owner = this.beginIntake(true);
    await this.intakeCollection(owner, () => acquireSceneCollectionFromFiles(files, this.collectionOptions(owner)));
  }
  async openFolder(files: ArrayLike<File>) {
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked) return;
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return;
    if (this.transformOwner && !await this.endTransformSession()) return;
    if (this.collectionIntakeBlocked()) return;
    const owner = this.beginIntake(true);
    await this.intakeCollection(owner, () => acquireSceneCollectionFromFolderFiles(files, this.collectionOptions(owner)));
  }
  /** Capture browser entry handles during the drop event, before its protected data store closes. */
  snapshotDrop(dataTransfer: DataTransfer): SceneCollectionDrop | undefined {
    this.cancelDeferredColorPointers();
    if (this.transformOwner || this.opacityOwner || this.opacityEntryTask) return undefined;
    if (this.collectionIntakeBlocked()) return undefined;
    const owner = this.beginIntake(true);
    try {
      const snapshot = snapshotSceneCollectionDrop(dataTransfer, this.collectionOptions(owner));
      owner.drop = snapshot; this.dropIntakes.set(snapshot, owner); return snapshot;
    } catch (error) { this.error(error); void this.retireIntake(owner); return undefined; }
  }
  async openDrop(snapshot: SceneCollectionDrop) {
    // The drop event already captured its protected handles synchronously.
    // Preserve immediate enumeration when no metrics owner needs joining.
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked) return;
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return;
    if (this.transformOwner && !await this.endTransformSession()) return;
    const owner = this.dropIntakes.get(snapshot);
    if (this.collectionIntakeBlocked()) { if (owner) await this.retireIntake(owner); return; }
    if (!owner || owner.drop !== snapshot) { this.error(new Error('A current controller-owned drop is required.')); return; }
    this.dropIntakes.delete(snapshot);
    await this.intakeCollection(owner, () => acquireSceneCollectionFromDrop(snapshot, this.collectionOptions(owner)));
  }
  get previousAssetPath() { return this.collection?.entries[this.currentFile - 1]?.path; }
  get nextAssetPath() { return this.collection?.entries[this.currentFile + 1]?.path; }
  get collectionNavigationAvailable() {
    const state = useApp.getState();
    return !this.destroyed && !this.closing && !this.closeRequest && !this.exporting && !!this.collection && !!this.scene &&
      !!this.renderer && state.ready && !this.renderer.lost && !this.recovery && !this.editOperation && !this.selectionCleanupOwner && !this.filterOwner && !this.transformBlocksOrdinary && !this.opacityBlocksOrdinary &&
      !this.selectionBarriers && !this.colorBoundary && !this.cancellingSelection && state.pendingSelectionCount === 0 &&
      !state.busy && !state.thumbnailPending && !state.viewTransferPending && !state.outputPending &&
      !state.summary?.pending && !state.selectionDragging && !state.navigationPrompt && !state.settingsOpen &&
      !state.exportOpen && !state.savedViewChoices.length && state.selectionRecovery === 'idle' && state.memoryOverageBytes === 0;
  }
  async adjacent(direction: number) {
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return;
    if (this.transformOwner && !await this.endTransformSession()) return;
    if ((direction !== -1 && direction !== 1) || !this.collectionNavigationAvailable) return;
    const collection = this.collection!, index = this.currentFile + direction;
    if (!collection.entries[index]) return;
    const owner = this.beginIntake(false); owner.collection = collection;
    try { await this.navigateCollection(owner, index); }
    catch (error) { if (this.intake === owner && !owner.cancel.signal.aborted) this.error(error); }
    finally { if (!this.pendingNavigation || this.intake !== owner) await this.retireIntake(owner); }
  }
  private async navigateCollection(owner: CollectionIntake, index: number) {
    this.cancelDeferredColorPointers();
    try {
      this.checkIntake(owner); setApp({ busy: false, stage: '' });
      await this.closeToleranceSelection(); this.checkIntake(owner);
      if (!await this.cancelSelectionGesture()) { await this.retireIntake(owner); return; }
      this.checkIntake(owner);
      if (!await this.settleColorSession()) { await this.retireIntake(owner); return; }
      this.checkIntake(owner);
      if (this.collectionIntakeBlocked()) { await this.retireIntake(owner); return; }
      const collection = owner.collection!, entry = collection.entries[index];
      if (!entry) throw new Error('The selected collection entry is unavailable.');
      let file: File | undefined;
      if (entry.kind === 'file') {
        // Only the chosen ordinary source is acquired. Its immutable File is
        // handed into loading so a dirty prompt never delays the size refusal
        // or invokes a mutable provider for a second snapshot.
        // The example provider downloads here, before a decoder candidate exists.
        // Keep its normal intake Cancel visible while the lazy source is pending.
        if (owner.example) setApp({ busy: true, stage: 'Opening scene', progress: 0 });
        try { file = await collection.acquireResource(entry.path, () => this.checkIntake(owner)); }
        finally {
          if (owner.example && this.intake === owner && !owner.cancel.signal.aborted &&
              !this.destroyed && !this.candidate && !this.editOperation) setApp({ busy: false, stage: '' });
        }
        this.checkIntake(owner);
        if (this.collectionIntakeBlocked()) { await this.retireIntake(owner); return; }
        assertSourceFitsDecodeBudget(sceneFileBytes(file), NATIVE_LOAD_BUDGET_BYTES);
      }
      // Discovery has joined; a dirty prompt is idle and retains its staged catalog.
      if (!this.editOperation) setApp({ busy: false, stage: '' });
      const source = Object.freeze({ collection, index, intake: owner, ...(file ? { file } : {}) });
      await this.navigate(async () => {
        try {
          this.checkIntake(owner); this.holdIntakeBarrier(owner);
          await this.open(source);
        }
        finally { await this.retireIntake(owner); }
      }, 'replace', () => this.retireIntake(owner));
    } finally { this.releaseIntakeBarrier(owner); }
  }
  private async navigate(action: () => Promise<void>, kind: 'replace' | 'close' = 'replace', retire?: () => Promise<void>) {
    this.cancelDeferredColorPointers();
    if (this.destroyed || this.closing || kind === 'replace' && (this.closeRequest || this.filterOwner)) { await retire?.(); return; }
    if (useApp.getState().dirty) { this.pendingNavigation = { kind, run: action, retire }; setApp({ navigationPrompt: true, navigationIntent: kind }); }
    else await action();
  }
  private appUpdateSafe(navigating = false) {
    const state = useApp.getState();
    return !this.operationRecoveryBlocked && !this.client?.operationOwner && !this.destroyed && !this.closing && !this.closeRequest &&
      !this.recovery && !this.editingFailed && !this.editOperation && !this.exporting && !this.exportOperation &&
      !this.candidate && !this.intake && !this.loadAbort && !this.sourceLoads.size && !this.collectionCleanup.size &&
      !this.thumbnailTasks.size && !this.viewTransferTasks.size && !this.imageTasks.size && !this.selectionCleanupOwner && !this.cancellingSelection &&
      !this.colorBoundary && !this.transformGradeTask && !this.transformNumericTask && !this.opacityEntryTask &&
      this.selectionBarriers <= (navigating ? 1 : 0) && this.ledger.overageBytes === 0 &&
      !!this.renderer && !this.renderer.lost && !!this.camera && state.ready && state.rendererState === 'ready' &&
      !state.busy && !state.outputPending && !state.exportOpen && !state.navigationPrompt && !this.pendingNavigation &&
      !state.thumbnailPending && !state.viewTransferPending && !state.savedViewChoices.length && !state.summary?.pending &&
      state.pendingSelectionCount === 0 && state.selectionRecovery === 'idle' && state.memoryOverageBytes === 0;
  }
  private appUpdateSettled() {
    const state = useApp.getState(), summary = state.summary;
    return !this.selection && !this.tolerance && !this.filterOwner && !this.transformOwner && !this.opacityOwner &&
      !this.floorOwner && !this.floorPreparing && !this.alignmentOwner && !this.alignmentPick && !this.alignmentConfirming &&
      !this.colorPending && !this.colorDisplay && !state.colorSession?.active && !state.selectionDragging &&
      !summary?.transaction && !summary?.selectionDraft && !summary?.toleranceSessionId && !summary?.filter && !summary?.floor &&
      !summary?.transformSession && !summary?.opacitySession && !summary?.colorSession &&
      (this.scene ? !!this.client && summary?.loaded === true : !this.client && !summary);
  }
  get appUpdateAvailable() { return !this.appUpdateIntent && this.appUpdateSafe(); }
  /** Rechecked by the offline client after its durable reload ticket joins. */
  get appUpdateNavigationCurrent() { return this.appUpdateIntent?.navigationCurrent?.() === true; }
  get appUpdateUnloadAllowed() { return this.appUpdateIntent?.unloading === true && this.appUpdateNavigationCurrent; }
  beginAppUpdateUnload(): () => void {
    const owner = this.appUpdateIntent;
    if (!owner?.navigationCurrent?.()) throw new Error('The update no longer owns this document.');
    owner.unloading = true;
    return () => { if (this.appUpdateIntent === owner) owner.unloading = false; };
  }
  async requestAppUpdate(action: () => Promise<void>): Promise<boolean> {
    if (!this.appUpdateAvailable) return false;
    const client = this.client, renderer = this.renderer, camera = this.camera, generation = this.generation, fingerprint = this.fingerprint,
      documentId = client?.revision.documentId, sourceGeneration = client?.revision.sourceGeneration;
    const owner: { navigationCurrent?: () => boolean; unloading?: boolean } = {};
    this.appUpdateIntent = owner; setApp({});
    const current = () => this.appUpdateIntent === owner && this.client === client && this.renderer === renderer && this.camera === camera &&
      this.generation === generation && this.fingerprint === fingerprint && client?.revision.documentId === documentId && client?.revision.sourceGeneration === sourceGeneration;
    const safe = () => current() && this.appUpdateSafe();
    const retire = async () => { if (this.appUpdateIntent === owner) { this.appUpdateIntent = undefined; if (!this.destroyed) setApp({}); } };
    let queued = false, ran = false;
    try {
      this.cancelDeferredColorPointers(); this.camera?.clearInput();
      this.cancelFilterGizmoGesture(undefined, true); this.cancelTransformGizmoGesture(undefined, true); this.cancelAlignment();
      await this.floorCleanup; if (!safe()) return false;
      if (this.filterOwner && !await this.cancelFilter()) return false;
      if (!safe()) return false;
      if (!await this.cancelTransformPreview() || !safe()) return false;
      if (!await this.cancelOpacityPreview() || !safe()) return false;
      if (!await this.endTransformSession(true) || !safe()) return false;
      if (!await this.endOpacitySession(true) || !safe()) return false;
      await this.closeToleranceSelection(); if (!safe()) return false;
      if (!await this.cancelSelectionGesture() || !safe()) return false;
      if (!await this.settleColorSession() || !safe()) return false;
      if (!this.appUpdateSettled()) return false;
      // Intentional settlement may publish a baked GPU scene. Pin its final
      // identity and full native revision before asking Save/Discard/Stay.
      const scene = this.scene, revision = client ? { ...client.revision } : undefined;
      owner.navigationCurrent = () => current() && this.appUpdateSafe(true) && this.appUpdateSettled() && this.scene === scene &&
        (!client || !!revision && sameRevision(revision, client.revision));
      const run = async () => {
        try {
          if (!owner.navigationCurrent?.()) return;
          await action(); ran = true;
        } catch { this.error(new Error('The update could not be opened. Your current scene is still available.')); }
        finally { await retire(); }
      };
      await this.navigate(run, 'replace', retire);
      queued = this.pendingNavigation?.run === run;
      return queued || ran;
    } catch { this.error(new Error('The update could not be opened. Your current scene is still available.')); return false; }
    finally { if (!queued) await retire(); }
  }
  stay() {
    const action = this.pendingNavigation; this.pendingNavigation = undefined;
    if (action?.retire) void action.retire();
    setApp({ navigationPrompt: false, navigationIntent: null, outputPending: false });
  }
  async discardAndContinue() {
    this.cancelDeferredColorPointers();
    const action = this.pendingNavigation; this.pendingNavigation = undefined;
    setApp({ navigationPrompt: false, navigationIntent: null, outputPending: false });
    if (!action) return;
    if (action.kind === 'close') { await action.run(); return; }
    this.selectionBarriers++;
    let barrier = true;
    try {
      await this.closeToleranceSelection();
      if (!await this.cancelSelectionGesture()) { await action.retire?.(); return; }
      if (!await this.settleColorSession()) { await action.retire?.(); return; }
      const replacement = action.run();
      // The deferred collection action synchronously reacquires its own fence.
      // Transfer settlement ownership before obsolete GPU retirement can wait.
      this.releaseSelectionBarrier(); barrier = false;
      await replacement;
    } finally {
      try { await action.retire?.(); } finally { if (barrier) this.releaseSelectionBarrier(); }
    }
  }
  private async open(source: SourceSelection) {
    await this.cancelTransformPivotFocus();
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    this.cancelDeferredColorPointers();
    const collectionSource = 'collection' in source ? source : undefined;
    const entry = collectionSource?.collection.entries[source.index];
    let file = 'files' in source ? source.files[source.index] : source.file;
    const sourceName = entry?.name ?? file?.name;
    if (!sourceName || this.destroyed || this.closing || !this.renderer || !this.camera || this.renderer.lost || this.recovery || this.editOperation || this.selectionCleanupOwner || this.filterOwner) return false;
    if (file) { try { assertSourceFitsDecodeBudget(sceneFileBytes(file), NATIVE_LOAD_BUDGET_BYTES); } catch (error) { this.error(error); return false; } }
    this.cancelImageCaptures();
    this.cancelAlignment();
    await this.floorCleanup;
    if (this.destroyed || this.closing || this.closeRequest || !this.renderer || this.renderer.lost || this.recovery) return false;
    if (collectionSource) this.checkIntake(collectionSource.intake);
    let finish!: () => void;
    const settled = new Promise<void>(resolve => { finish = resolve; }); this.sourceLoads.add(settled);
    if (collectionSource) {
      let loads = this.collectionLoads.get(collectionSource.collection);
      if (!loads) { loads = new Set(); this.collectionLoads.set(collectionSource.collection, loads); }
      loads.add(settled);
    }
    this.cancelCandidateLoad(); const generation = ++this.generation, cancel = new AbortController(); this.loadAbort = cancel;
    let candidate: CoreClient | undefined;
    let lease: ResourceLease | undefined, memory: NativeHeapAccounting | undefined, historyLease: ResourceLease | undefined;
    let probeLease: ResourceLease | undefined, staged: RenderScene | undefined;
    let group: PreparedSogGroup | undefined;
    let viewsOwner: (() => void) | undefined;
    let recoveryStore: DocumentRecoveryStore | undefined;
    let uploadCompletion: Promise<void> | undefined;
    const renderer = this.renderer;
    const check = () => {
      if (collectionSource) this.checkIntake(collectionSource.intake);
      if (cancel.signal.aborted || generation !== this.generation || this.destroyed || renderer !== this.renderer || renderer.lost)
        throw new DOMException('Scene loading cancelled', 'AbortError');
    };
    setApp({ busy: true, stage: 'Opening scene', progress: 0, error: null });
    if (collectionSource) this.releaseIntakeBarrier(collectionSource.intake);
    try {
      check();
      if (collectionSource && entry?.kind === 'file' && !file) {
        file = await collectionSource.collection.acquireResource(entry.path, check); check();
        assertSourceFitsDecodeBudget(sceneFileBytes(file), NATIVE_LOAD_BUDGET_BYTES);
      }
      this.client?.assertNativeAdmission();
      memory = this.bootstrapMemory ?? this.createNativeMemory(); this.bootstrapMemory = undefined;
      candidate = this.bootstrapClient ?? this.createCoreClient(memory); this.bootstrapClient = undefined; this.candidate = candidate;
      candidate.onProgress = (stage, progress) => { if (generation === this.generation) setApp({ stage, progress }); };
      const isGroup = entry?.kind === 'sog-group' || ('groupFiles' in source && !!source.groupFiles);
      const probe = isGroup ? await (async () => {
        setApp({ stage: 'Reading SOG metadata' });
        const options = { admit: (bytes: number) => this.ledger.reserve('source', bytes), current: check };
        group = collectionSource ? await prepareSogCollectionGroup(collectionSource.collection, entry!.path, options) :
          await prepareSogGroup(('groupFiles' in source ? source.groupFiles : undefined)!, options); check();
        const count = Math.min(group.sourceCount, LOADED_PREVIEW_LIMIT);
        // Legacy SOG infers its degree from the centroid texture. Until the
        // native header check resolves it, reserve the largest supported stride.
        const degree = group.shDegree ?? 3;
        return { kind: 'gaussian' as const, count, degree,
          peakBytes: groupDecodeAdmissionBytes(group.descriptor, count, degree) };
      })() : await (async () => {
        probeLease = this.ledger.reserve('work', PROBE_WORK_BYTES);
        const result = await probeSceneFile(file!); check();
        probeLease(); probeLease = undefined; return result;
      })();
      const rendererDelta = probe.kind === 'gaussian' && renderer.backend === 'webgl2' ?
        Math.max(0, this.estimateSceneBytes(probe.count, probe.degree) - estimateWebGpuSceneBytes(probe.count, probe.degree)) : 0;
      lease = this.ledger.reserve('decoded', probe.peakBytes + rendererDelta);
      const options = {
        admit: (bytes: number) => this.ledger.reserve('source', bytes), current: check, nativeLease: lease,
      };
      const { summary, fingerprint } = group ? await candidate.loadGroup(group, LOADED_PREVIEW_LIMIT, GROUP_NATIVE_BUDGET_BYTES, options) :
        await candidate.load(file!, LOADED_PREVIEW_LIMIT, NATIVE_LOAD_BUDGET_BYTES, options); check();
      const example = file && collectionSource?.intake.example?.ownsFile(file) ? collectionSource.intake.example : undefined;
      if (example && (summary.kind !== 0 || summary.count !== EXAMPLE_SCENE.splats)) throw new Error(EXAMPLE_SCENE_LOAD_ERROR);
      group?.dispose(); group = undefined;
      if (summary.kind === 0) {
        if (probe.kind !== 'gaussian' || summary.count > probe.count || summary.shDegree > probe.degree)
          throw new Error('The decoded scene exceeds its preflight estimate.');
        historyLease = this.ledger.reserve('history', 0);
        candidate.updateNativeCoverage([
          { lease, nextLeaseBytes: isGroup ? this.estimateSceneBytes(summary.count, summary.shDegree) : Math.max(lease.bytes, this.estimateSceneBytes(summary.count, summary.shDegree)), nativeBytes: summary.count * 144 },
          { lease: historyLease, nextLeaseBytes: nativeHistoryBytes(summary), nativeBytes: nativeHistoryBytes(summary) },
        ]);
        this.bindNativeCoverage(candidate, lease, historyLease, summary.count * 144);
        const gaussian = await renderer.allocateScene(summary.count, summary.shDegree); staged = gaussian; check();
        setApp({ stage: 'Preparing scene', progress: .8 });
        const streamed = await candidate.stream((first, count, bytes) => { check(); return gaussian.upload(first, count, bytes); },
          bytes => { check(); gaussian.masks(bytes); });
        check();
        if (streamed.kind !== 0 || streamed.count !== summary.count || streamed.contentRevision !== summary.contentRevision ||
            streamed.revision !== summary.revision || streamed.shDegree !== summary.shDegree)
          throw new Error('The uploaded scene does not match the decoded document.');
      } else {
        if (probe.kind !== 'geometry' || summary.count > probe.count || summary.sourceCount !== probe.sourceVertices ||
            summary.sourceFaces !== probe.sourceFaces || !selectionRestored(summary))
          throw new Error('The decoded geometry exceeds its preflight estimate.');
        const descriptor = geometryDescriptor(summary);
        if (descriptor.triangleCount > probe.triangleLimit) throw new Error('The decoded mesh exceeds its triangle budget.');
        this.bindNativeCoverage(candidate, lease);
        const geometry = await renderer.allocateGeometry(descriptor); staged = geometry; check();
        setApp({ stage: 'Preparing scene', progress: .8 });
        const streamed = await candidate.streamGeometry(descriptor,
          (first, count, bytes) => { check(); return geometry.uploadVertices(first, count, bytes); },
          (first, count, bytes) => { check(); return geometry.uploadIndices(first, count, bytes); });
        check();
        if (!selectionRestored(streamed) || !sameGeometryDescriptor(geometryDescriptor(streamed), descriptor))
          throw new Error('The uploaded geometry does not match the decoded document.');
      }
      // Native checkpoint creation and saved-view lookup do not read the GPU
      // mirror. Overlap that work with its bounded upload tail, but keep the
      // candidate private until both have completed and join on every exit.
      uploadCompletion = renderer.finish();
      void uploadCompletion.catch(() => undefined);
      check();
      let views: readonly SavedViewRecord[] = [], viewStatus: string | null = null;
      try {
        const lookup = await this.viewStorage.list(fingerprint, summary.kind === 0 ? 'gaussian' : summary.kind === 1 ? 'points' : 'mesh', {
          signal: cancel.signal, current: check, admit: bytes => this.ledger.reserve('image', bytes),
        }); viewsOwner = lookup.dispose; check();
        views = lookup.records;
        if (lookup.corrupt) viewStatus = 'Some saved views could not be read. Initial framing is available.';
      } catch (error) {
        check(); viewStatus = `Saved views could not be read. ${error instanceof Error ? error.message : 'Initial framing is available.'}`;
      }
      const restoredView = views.length === 1 ? views[0] : undefined;
      const aspect = renderer.canvas.width / renderer.canvas.height;
      const initialView = restoredView?.view ?? (example ? { ...EXAMPLE_SCENE.view, radius: summary.radius } : undefined);
      const restoredCamera = initialView ? savedViewCameraState(initialView, aspect) : [...summary.camera];
      const restoredBackground = initialView?.background ?? 'black';
      restoredCamera[6] = summary.radius; restoredCamera[10] = aspect;
      recoveryStore = new DocumentRecoveryStore(this.ledger);
      await candidate.captureRecoveryCheckpoint({ ledger: this.ledger, binding: candidate.getRecoveryBinding(),
        metadata: this.recoveryMetadata(summary, restoredCamera, restoredCamera, new Map(), summary.contentRevision,
          restoredBackground), signal: cancel.signal }, prepared => {
        check(); recoveryStore!.installInitial(prepared);
      }); check();
      await uploadCompletion; check();
      if (staged.kind === 'geometry') candidate.updateNativeCoverage([{ lease,
        nextLeaseBytes: checkedBytes(summary.memoryBytes + staged.allocationBytes + 64 * 1024, 1), nativeBytes: summary.memoryBytes }]);
      candidate.activateNativeMemory();
      const oldScene = this.scene, oldClient = this.client, oldLease = this.releaseScene, oldHistory = this.releaseHistory,
        oldMemory = this.sourceMemory, oldCollection = this.collection, oldRecovery = this.documentRecovery;
      this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer(); this.cancelImageCaptures(); this.savedViewRecord = restoredView;
      const oldViewsOwner = this.releaseSavedViews; this.releaseSavedViews = viewsOwner; viewsOwner = undefined;
      this.scene = staged; staged = undefined; this.client = candidate; this.candidate = undefined;
      this.resetTransformPivotSynchronization();
      this.documentRecovery = recoveryStore; recoveryStore = undefined; this.workerFailure = undefined;
      oldRecovery?.release();
      this.colorDisplay = undefined;
      renderer.resetHistogram();
      // Navigation belongs to this winner, before any old-owner retirement can
      // await and let a newer source publish its own catalog and index.
      this.collection = collectionSource?.collection;
      this.files = collectionSource ? collectionSource.collection.entries : ('files' in source ? source.files : Object.freeze([]));
      this.currentFile = source.index;
      this.fingerprint = fingerprint; this.sourceMemory = memory; memory = undefined;
      this.releaseScene = lease; lease = undefined; this.releaseHistory = historyLease; historyLease = undefined;
      this.editingFailed = false;
      this.savedContent = summary.contentRevision; this.camera.background = restoredBackground;
      // Desktop SavedView contains pose/lens/background, while camera radius is
      // fitted from the current scene. Keep older web metadata readable without
      // restoring its historical clipping radius as a desktop default.
      restoredCamera[6] = summary.radius;
      this.camera.set(restoredCamera); this.camera.aspect(aspect);
      this.clearAlignmentViews();
      this.alignmentDefaultCamera = this.camera.state;
      if (example) example.published = { scene: this.scene, client: this.client, generation };
      setApp({ summary, histogram: null, sourceName, collectionCount: this.files.length, collectionIndex: source.index, collectionPath: entry?.path ?? sourceName,
        collectionPrevious: source.index > 0, collectionNext: source.index + 1 < this.files.length, busy: false, stage: '', progress: 1, dirty: false,
        grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, colorSelectedOnly: false,
        opacity: null, opacityScale: 1, opacityPreview: null, opacityPreviewRevision: useApp.getState().opacityPreviewRevision + 1,
        gradeRevision: useApp.getState().gradeRevision + 1, tool: null, outputPending: false, exportOpen: false, background: this.camera.background,
        savedViewChoices: views.length > 1 ? views : [], savedViewAvailable: !!restoredView, viewStatus, thumbnailPending: false,
        selectionOperation: null, selectionDragging: false, pendingMode: null,
        transformParameters: { ...transformDefaults(), pivot: [...summary.center] },
        transformPivotMode: 'scene', transformPivotChosen: false, transformPivotPending: false,
        ...(summary.kind !== 0 ? { toolsOpen: false } : {}) });
      document.title = `${sourceName} — SplatView`; this.invalidate(); oldClient?.dispose(); oldViewsOwner?.();
      try { await Promise.allSettled([this.selectionMaps.invalidate(), ...(oldScene ? [oldScene.dispose()] : [])]); }
      finally {
        this.releaseRetainedGraphics(oldScene);
        if (oldClient) await oldClient.retireNativeMemory(); else oldMemory?.retire();
        oldLease?.(); oldHistory?.();
        if (oldCollection && oldCollection !== this.collection) {
          // The winner is already published. Older loads may still own a GPU
          // retirement fence; retain that catalog independently until they join.
          void this.retireCollection(oldCollection);
        }
        this.syncMemoryOverage();
      }
      return true;
    } catch (error) { if (generation === this.generation) this.error(error); return false; }
    finally {
      try {
        await uploadCompletion?.catch(() => undefined);
        if (staged) await staged.dispose();
        if (memory) {
          candidate?.dispose();
          if (this.candidate === candidate) this.candidate = undefined;
          // load() joins pending Blob reads and delivery before it settles. The
          // staged GPU mirror above is also retired before its module remainder.
          if (candidate) await candidate.retireNativeMemory(); else memory.retire();
        }
        group?.dispose(); group = undefined;
        lease?.(); historyLease?.(); probeLease?.(); viewsOwner?.(); recoveryStore?.release();
        if (generation === this.generation && !this.closing) setApp({ busy: false, stage: '' });
      } finally {
        if (this.loadAbort === cancel) { this.loadAbort = undefined; this.transformPivotFailedStamp = undefined; }
        this.sourceLoads.delete(settled);
        if (collectionSource) this.collectionLoads.get(collectionSource.collection)?.delete(settled);
        finish(); this.syncMemoryOverage();
      }
    }
  }
  closeScene(): Promise<void> {
    this.clearToolbarFeedback();
    if(this.benchmarkMaskRead||this.benchmarkPickTasks?.size)return this.joinBenchmarkQueries().then(()=>this.closeScene());
    return this.benchmarkObservation?.active ? this.observeBenchmarkOperation('close-scene', () => this.closeSceneUnobserved()) : this.closeSceneUnobserved();
  }
  private closeSceneUnobserved(): Promise<void> {
    if (this.workerFailure && !this.destroyed) {
      this.recoveryCancel?.abort();
      return Promise.resolve(this.recovery).then(() => this.navigate(() => this.closeDocument(this.client), 'close'));
    }
    if (this.operationRecoveryBlocked) return Promise.resolve();
    this.cancelDeferredColorPointers();
    if (this.destroyed) return Promise.resolve();
    if (this.closing) return this.closing;
    if (this.closeRequest) return this.closeRequest;
    this.appUpdateIntent = undefined;
    this.transformPivotQuery?.cancel.abort();
    this.cancelTransformGizmoGesture(undefined, true); this.cancelAlignment();
    const transformCancellation = this.cancelTransformPreview();
    const opacityCancellation = this.cancelOpacityPreview();
    const filterCancellation = this.filterOwner ? this.cancelFilter() : Promise.resolve(true);
    this.exportOperation?.cancel.abort();
    this.morphologyRangeOwner?.cancel.abort();
    const task = Promise.resolve().then(async () => {
      const client = this.client;
      if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
      await this.exportOperation?.finished;
      await filterCancellation;
      await transformCancellation;
      await opacityCancellation;
      await this.floorCleanup;
      this.cancelLoad(); this.cancelEdit();
      const operation = this.editOperation;
      if (operation) { setApp({ busy: true, stage: 'Finishing current operation' }); await operation.finished; }
      if (this.destroyed || client !== this.client) return;
      this.cancelAlignment(); await this.floorCleanup;
      if (this.destroyed || client !== this.client) return;
      // Explicit destruction remains available when retained memory or a lost
      // device prevents allocating a color-boundary GPU candidate.
      if (this.ledger.overageBytes === 0 && !this.renderer?.lost && !this.editingFailed && !await this.settleColorSession()) return;
      await this.navigate(() => this.closeDocument(client), 'close');
    }).catch(error => this.error(error)).finally(() => {
      if (this.closeRequest === task) this.closeRequest = undefined;
    });
    this.closeRequest = task; return task;
  }
  private closeDocument(client: CoreClient | undefined): Promise<void> {
    this.cancelDeferredColorPointers();
    if (this.destroyed || client !== this.client) return Promise.resolve();
    if (this.closing) return this.closing;
    const task = Promise.resolve().then(async () => {
      if (this.destroyed || client !== this.client) return;
      this.cancelFilterGizmoGesture(undefined, true);
      this.cancelTransformGizmoGesture(undefined, true);
      const scene = this.scene, memory = this.sourceMemory, sceneLease = this.releaseScene, historyLease = this.releaseHistory,
        viewsOwner = this.releaseSavedViews, collection = this.collection; this.releaseSavedViews = undefined;
      this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer(); this.cancelImageCaptures(); this.savedViewRecord = undefined;
      this.alignmentDefaultCamera = undefined;
      this.clearAlignmentViews();
      const bootstrap = this.bootstrapClient, bootstrapMemory = this.bootstrapMemory;
      this.recoveryCancel?.abort(); this.cancelLoad();
      this.documentRecovery?.release(); this.documentRecovery = undefined; this.workerFailure = undefined;
      this.selection?.cancel.abort(); this.selection = undefined;
      this.tolerance?.mapQuery?.abort(); this.tolerance?.session.retire(); this.tolerance?.previous?.session.retire(); this.tolerance = undefined;
      const released = this.cancelReleasedSelections(), maps = this.selectionMaps.invalidate();
      const edit = this.editOperation?.finished, recovery = this.recovery;
      const morphologyRange = this.morphologyRangeOwner?.finished; this.morphologyRangeOwner?.cancel.abort();
      const filterTasks = [...this.filterTasks]; this.cancelFilterCenterPick(); this.filterOwner = undefined;
      const transformTasks = [...this.transformTasks]; this.transformOwner = undefined; this.transformGradeRequest = undefined;
      const opacityTasks = [...this.opacityTasks]; this.clearOpacityPreview(); this.opacityOwner = undefined; this.opacityEntryRequest = undefined;
      client?.dispose(); bootstrap?.dispose();
      this.client = undefined; this.scene = undefined; this.sourceMemory = undefined;
      this.resetTransformPivotSynchronization();
      this.committedGraphicsRecovery = undefined;
      this.colorDisplay = undefined;
      this.renderer?.setHistogramEnabled(false); this.renderer?.resetHistogram();
      this.releaseScene = undefined; this.releaseHistory = undefined; this.bootstrapClient = undefined; this.bootstrapMemory = undefined;
      this.collection = undefined; this.files = Object.freeze([]); this.currentFile = 0; this.fingerprint = undefined;
      this.pendingNavigation = undefined; this.outputReceipt = undefined; this.savedContent = 0;
      this.selectionCleanupOwner = undefined; this.cancellingSelection = false; this.editingFailed = false;
      this.camera?.clearInput();
      setApp({ summary: null, histogram: null, sourceName: '', collectionCount: 0, collectionIndex: 0, collectionPath: '',
        collectionPrevious: false, collectionNext: false, dirty: false, busy: true, stage: 'Closing scene', progress: 0,
        navigationPrompt: false, navigationIntent: null, outputPending: false, exportOpen: false, settingsOpen: false,
        tool: null, filter: null, filterCenterPicking: false, filterCenterPending: false, transform: null, transformPreview: null,
        opacity: null, opacityScale: 1, opacityPreview: null,
        transformParameters: transformDefaults(), transformGizmoMode: null, transformGizmoDragging: false,
        transformPivotMode: 'scene', transformPivotChosen: false, transformPivotPending: false,
        autoOrbit: false, fly: false, selectionRecovery: 'idle', operationRecovery: 'idle', operationRecoveryCommitted: false, selectionOperation: null,
        thumbnailPending: false, viewTransferPending: false, savedViewAvailable: false, savedViewChoices: [], viewStatus: null,
        selectionDragging: false, pendingMode: null, grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR],
        colorSession: null, colorSelectedOnly: false, gradeRevision: useApp.getState().gradeRevision + 1, error: null });
      document.title = 'SplatView'; this.invalidate();
      await Promise.allSettled([released, maps, ...(morphologyRange ? [morphologyRange] : []), this.selectionCleanup, this.toleranceCleanup, ...filterTasks, ...transformTasks, ...opacityTasks, ...(this.opacityEntryTask ? [this.opacityEntryTask] : []),
        this.floorCleanup, ...this.floorTasks,
        ...this.sourceLoads, ...this.collectionCleanup, ...this.thumbnailTasks, ...this.viewTransferTasks, ...this.imageTasks, ...(scene ? [scene.dispose()] : []), ...(edit ? [edit] : []), ...(recovery ? [recovery] : [])]);
      // A source load can schedule old-catalog retirement while its captured
      // GPU fence settles. Join those newly tracked provider owners as well.
      await this.drainCollectionCleanup();
      await collection?.dispose();
      for (const settle of this.viewDownloads) settle();
      for (const settle of this.exportDownloads) settle();
      this.releaseRetainedGraphics(scene);
      if (client) await client.retireNativeMemory(); else memory?.retire();
      if (bootstrap) await bootstrap.retireNativeMemory(); else bootstrapMemory?.retire();
      sceneLease?.(); historyLease?.(); viewsOwner?.(); this.syncMemoryOverage();
    }).finally(() => {
      if (this.closing === task) this.closing = undefined;
      if (!this.destroyed) {
        const ready = !!this.renderer && !this.renderer.lost;
        setApp({ busy: false, stage: '', ready, rendererState: ready ? 'ready' : 'unavailable' });
        this.invalidate();
      }
    });
    this.closing = task; return task;
  }
  cancelLoad() {
    this.morphologyRangeOwner?.cancel.abort();
    this.cancelDeferredColorPointers();
    this.cancelIntake(); this.cancelCandidateLoad();
  }
  private cancelCandidateLoad() {
    this.clearToolbarFeedback();
    this.cancelSavedViewTransfer();
    this.generation++; this.loadAbort?.abort(); this.loadAbort = undefined;
    this.candidate?.dispose(); this.candidate = undefined; setApp({ busy: false, stage: '' });
  }
  private get colorScope() {
    const state = useApp.getState();
    return state.colorSession?.active || this.colorPending ? state.colorSelectedOnly : (state.summary?.selected ?? 0) > 0;
  }
  private colorEntryTask?: Promise<boolean>;
  private colorEntryRequest?: { client: CoreClient; generation: number; values: number[]; selectionView: SelectionView };
  get colorPending() { return !sameColorValues(useApp.getState().grade, useApp.getState().appliedGrade); }
  private get needsColorSettlement() {
    return !!this.colorEntryTask || this.colorPending || !!useApp.getState().colorSession?.active || !!this.colorDisplay || !!this.colorBoundary;
  }
  private colorControlsReady(ownedBarrier = false) {
    const state = useApp.getState();
    return !this.deferredColorPointer && this.editingAvailable && state.ready && !!state.summary && !state.busy &&
      !state.summary.selectionDraft && !state.summary.pending && !state.selectionDragging &&
      state.pendingSelectionCount === 0 && !this.selectionActive && !this.releasedSelections.length &&
      !this.releasedDrain && !this.pendingTolerancePicks.size && !this.isToleranceUpdating &&
      !this.editOperation && !this.cancellingSelection && !this.exporting && !this.colorBoundary &&
      this.selectionBarriers === Number(ownedBarrier) && !state.outputPending && !state.exportOpen &&
      !state.settingsOpen && !state.savedViewChoices.length;
  }
  get colorControlsEnabled() { return this.colorControlsReady(); }
  get colorPreviewEnabled() {
    if (this.deferredColorPointer) return false;
    return !!this.transformGradeTask && !this.transformDirty && !this.opacityDirty && !this.filterOwner && !this.destroyed && !this.closing && !this.closeRequest ||
      this.colorControlsReady() || this.colorJob === 'manual' && this.editingAvailable &&
      !this.colorBoundary && !this.selectionActive && !useApp.getState().selectionDragging &&
      useApp.getState().pendingSelectionCount === 0;
  }
  setGrade(grade: number[]) {
    const values = colorValues(grade), owner = this.transformOwner ?? this.opacityOwner;
    if (owner || this.transformGradeTask) {
      if (!values || !this.client || this.transformDirty || this.opacityDirty || this.transformGizmoGesture || owner &&
        !(owner.phase === 'ready' && !owner.task || owner.ending && !!this.transformGradeTask) || this.destroyed || this.closing || this.closeRequest) return;
      const client = this.client;
      this.transformGradeRequest = { values, client, generation: this.generation, documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration };
      if (!this.transformGradeTask) {
        const task = Promise.resolve().then(async () => {
          if (!await this.endOpacitySession() || !await this.endTransformSession()) return;
          const latest = this.transformGradeRequest; this.transformGradeRequest = undefined;
          if (latest && this.client === latest.client && this.generation === latest.generation && latest.client.revision.documentId === latest.documentId &&
            latest.client.revision.sourceGeneration === latest.sourceGeneration && !this.destroyed && !this.closing && !this.closeRequest)
            this.setSettledGrade(latest.values);
        }).finally(() => { if (this.transformGradeTask === task) this.transformGradeTask = undefined; this.transformGradeRequest = undefined; });
        this.transformGradeTask = task; void task.catch(error => this.error(error));
      }
      return;
    }
    this.setSettledGrade(grade);
  }
  private setSettledGrade(grade: number[]) {
    const values = colorValues(grade), state = useApp.getState();
    if (!values) return;
    const entry = this.colorEntryRequest;
    if (this.colorEntryTask) {
      if (entry && entry.client === this.client && entry.generation === this.generation && !this.destroyed && !this.closing && !this.closeRequest)
        entry.values = values;
      return;
    }
    if (state.currentViewOnly && (state.summary?.selected ?? 0) > 0 && !state.colorSession?.active && !this.colorDisplay &&
        !this.colorPending && !sameColorValues(values, state.grade)) {
      if (!this.colorControlsReady() || !this.client) return;
      const selectionView = this.captureSelectionView();
      if (!selectionView) return;
      const request = { client: this.client, generation: this.generation, values, selectionView };
      this.colorEntryRequest = request; this.selectionBarriers++;
      const current = () => request.client === this.client && request.generation === this.generation && !this.destroyed && !this.closing && !this.closeRequest;
      const task = Promise.resolve().then(async () => {
        if (!current()) return false;
        const begun = await this.executeEditCommand({ command: 'beginColor', selectedOnly: true, selectionView }, current);
        if (begun !== true || !current()) return false;
        this.applySettledGrade(request.values, true); return true;
      }).finally(() => {
        if (this.colorEntryTask === task) { this.colorEntryTask = undefined; this.colorEntryRequest = undefined; }
        this.releaseSelectionBarrier();
      });
      this.colorEntryTask = task; void task.catch(error => this.error(error)); return;
    }
    this.applySettledGrade(values);
  }
  private applySettledGrade(grade: number[], ownedEntry = false) {
    const values = colorValues(grade), state = useApp.getState();
    // A manual worker may acknowledge an older captured grade while a newer
    // preview remains visible. Automatic analysis fences competing previews.
    if (!values || this.deferredColorPointer || this.colorJob === 'auto' || this.colorBoundary || this.selectionCleanupOwner ||
      this.scene?.kind !== 'gaussian' || !this.editingAvailable || state.busy && this.colorJob !== 'manual' ||
      this.selectionBarriers > 0 && this.colorJob !== 'manual' && !ownedEntry ||
      this.selectionActive || state.selectionDragging || state.pendingSelectionCount > 0 || this.isToleranceUpdating) return;
    const selectedOnly = state.colorSession?.active || this.colorPending ? state.colorSelectedOnly : (state.summary?.selected ?? 0) > 0;
    if (!sameColorValues(values, state.grade)) this.cancelAlignment();
    setApp({ grade: values, colorSelectedOnly: selectedOnly, gradeRevision: state.gradeRevision + 1,
      dirty: (state.summary?.contentRevision ?? this.savedContent) !== this.savedContent || !sameColorValues(values, state.appliedGrade) });
    this.invalidate();
  }
  async commitGrade() {
    if (!this.colorControlsReady() || !this.colorPending) return false;
    return this.command({ command: 'grade', values: [...useApp.getState().grade], selectedOnly: this.colorScope });
  }
  async autoColor(method: AutoColorMethod) {
    if (!isAutoColorMethod(method) || !this.colorControlsReady()) return false;
    return this.command({ command: 'autoColor', method, values: [...useApp.getState().grade], selectedOnly: this.colorScope });
  }
  private acknowledgeColor(summary: NativeSummary, valuesBefore?: readonly number[], automatic = false, previewRevision?: number) {
    const session = colorSessionState(summary.colorSession), state = useApp.getState();
    const preserveNewer = !automatic && (previewRevision === undefined ?
      valuesBefore && !sameColorValues(state.grade, valuesBefore) : state.gradeRevision !== previewRevision);
    const applied = session?.active ? [...session.applied] : [...NEUTRAL_COLOR];
    const grade = session?.active ? preserveNewer ? state.grade : [...session.values] : [...NEUTRAL_COLOR];
    setApp({ colorSession: session, appliedGrade: applied, grade,
      colorSelectedOnly: session?.active ? session.selectedOnly : false,
      gradeRevision: state.gradeRevision + Number(!sameColorValues(state.grade, grade)),
      dirty: summary.contentRevision !== this.savedContent || !sameColorValues(grade, applied) || this.transformDirty || this.opacityDirty });
    if (session?.active && this.scene?.kind === 'gaussian' && this.client) {
      if (this.colorDisplay && (this.colorDisplay.scene !== this.scene ||
        this.colorDisplay.documentId !== this.client.revision.documentId ||
        this.colorDisplay.sourceGeneration !== this.client.revision.sourceGeneration ||
        this.colorDisplay.sessionId !== session.sessionId || this.colorDisplay.baseId !== session.baseId))
        throw new Error('The color display no longer owns the acknowledged base.');
      this.colorDisplay = { scene: this.scene, documentId: this.client.revision.documentId,
        sourceGeneration: this.client.revision.sourceGeneration, sessionId: session.sessionId,
        baseId: session.baseId, epochId: session.epochId };
    } else this.colorDisplay = undefined;
  }
  private settleColorSession(): Promise<boolean> {
    if (this.colorEntryTask) return this.colorEntryTask.then(accepted => accepted ? this.settleColorSession() : false);
    if (this.colorBoundary) return this.colorBoundary;
    const state = useApp.getState();
    if (!this.colorPending && !state.colorSession?.active && !this.colorDisplay) return Promise.resolve(true);
    const client = this.client, generation = this.generation;
    const task = Promise.resolve().then(async () => {
      if (!client || this.client !== client || this.destroyed || this.generation !== generation || this.selectionCleanupOwner) return false;
      if (this.editOperation) await this.editOperation.finished;
      if (client !== this.client || this.destroyed || this.generation !== generation) return false;
      if (!this.colorPending && !useApp.getState().colorSession?.active && !this.colorDisplay) return true;
      return await this.executeEditCommand({ command: 'endColor' }, undefined, false, undefined, undefined, false, true) === true;
    }).finally(() => { if (this.colorBoundary === task) this.colorBoundary = undefined; });
    this.colorBoundary = task; return task;
  }
  /** Only color work may retain a physical scene press. Other busy owners refuse it. */
  get colorPointerDeferralAvailable() {
    const state = useApp.getState();
    return !!this.editOperation && !!this.colorJob && !this.editOperation.cancel.signal.aborted &&
      !this.deferredColorPointer && this.selectionBarriers <= 1 && this.editingAvailable &&
      !!this.client && !!this.camera && !!this.renderer && this.scene?.kind === 'gaussian' &&
      state.ready && state.busy && state.rendererState === 'ready' && !this.renderer.lost &&
      !this.recovery && !this.editingFailed && !this.destroyed && !this.closing && !this.closeRequest &&
      !state.navigationPrompt && !state.settingsOpen && !state.exportOpen && !state.outputPending &&
      !state.error &&
      !state.savedViewChoices.length && !state.viewTransferPending && !state.thumbnailPending &&
      !this.selectionCleanupOwner && !this.selection && !this.cancellingSelection && !this.exporting;
  }
  beginDeferredColorPointers(): DeferredColorPointerToken | undefined {
    if (!this.colorPointerDeferralAvailable) return;
    let lease: ResourceLease;
    // Scalar event/option snapshots have a fixed admission ceiling. They never
    // retain DOM events, scene-sized arrays, images or native/GPU allocations.
    try { lease = this.ledger.reserve('work', 65_536 * 256 + 32 * 512); }
    catch (error) { this.error(error); return; }
    const token = Object.freeze({ id: ++this.deferredColorPointerId }), client = this.client!, camera = this.camera!, renderer = this.renderer!;
    this.deferredColorPointer = { token, client, camera, renderer, generation: this.generation,
      documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration,
      cameraRevision: camera.revision, width: renderer.canvas.width, height: renderer.canvas.height,
      tool: useApp.getState().tool, operation: this.editOperation!, lease };
    camera.clearInput(); setApp({ autoOrbit: false }); return token;
  }
  deferredColorPointersCurrent(token: DeferredColorPointerToken): boolean {
    const owner = this.deferredColorPointer, state = useApp.getState();
    const restoringOwnGesture = state.selectionRecovery === 'restoring' &&
      this.selectionCleanupOwner?.selection.deferredPointer === token;
    return !!owner && owner.token === token && owner.client === this.client && owner.camera === this.camera && owner.renderer === this.renderer &&
      owner.generation === this.generation && owner.documentId === owner.client.revision.documentId &&
      owner.sourceGeneration === owner.client.revision.sourceGeneration && owner.cameraRevision === owner.camera.revision &&
      owner.width === owner.renderer.canvas.width && owner.height === owner.renderer.canvas.height &&
      owner.tool === state.tool &&
      !owner.operation.cancel.signal.aborted && !owner.renderer.lost && !this.recovery && !this.editingFailed && !this.destroyed &&
      !this.closing && !this.closeRequest && state.ready && state.rendererState === 'ready' &&
      (state.selectionRecovery === 'idle' || restoringOwnGesture) &&
      !state.error && !state.settingsOpen && !state.exportOpen && !state.outputPending && !state.navigationPrompt &&
      !state.savedViewChoices.length && !state.thumbnailPending && !state.viewTransferPending;
  }
  waitForDeferredColorPointers(token: DeferredColorPointerToken): Promise<boolean> {
    const owner = this.deferredColorPointer;
    if (!owner || owner.token !== token) return Promise.resolve(false);
    return owner.ready ??= (async () => {
      await owner.operation.finished;
      if (!this.deferredColorPointersCurrent(token) || !await this.settleColorSession()) return false;
      return this.deferredColorPointersCurrent(token);
    })();
  }
  endDeferredColorPointers(token: DeferredColorPointerToken) {
    if (this.deferredColorPointer?.token !== token) return;
    // A completed captured click remains a normal amendment owner after the
    // physical queue drains. Future option assignments regain strict expiry.
    if (this.tolerance?.deferredPointer === token) {
      this.tolerance.optionsRevision = useApp.getState().selectionOptionsRevision;
      this.tolerance.deferredPointer = undefined;
    }
    const owner = this.deferredColorPointer; this.deferredColorPointer = undefined; owner.lease();
    this.queueTransformPivotSynchronization();
  }
  cancelDeferredColorPointers() {
    const owner = this.deferredColorPointer;
    if (!owner) return;
    this.deferredColorPointer = undefined; owner.lease(); this.onDeferredPointerCancel?.();
    this.queueTransformPivotSynchronization();
  }
  private opacityScopeCurrent(owner: OpacityOwner) {
    return this.opacityOwner === owner && owner.client === this.client && owner.documentId === owner.client.revision.documentId &&
      owner.sourceGeneration === owner.client.revision.sourceGeneration && owner.generation === this.generation &&
      (!owner.scene || owner.scene === this.scene) && (!owner.renderer || owner.renderer === this.renderer);
  }
  private opacityCurrent(owner: OpacityOwner) { return this.opacityScopeCurrent(owner) && this.filterBaseAvailable() && !this.filterOwner && !this.transformOwner; }
  get opacityActive() { return !!this.opacityOwner || !!this.opacityEntryTask; }
  get opacityPending() { return !!this.opacityOwner?.task || !!this.opacityOwner?.ending || !!this.opacityEntryTask; }
  get opacityDirty() { return this.opacityOwner ? this.opacityOwner.desiredRevision !== this.opacityOwner.appliedRevision :
    !!this.opacityEntryRequest && this.opacityEntryRequest.scale !== 1; }
  private get opacityBlocksOrdinary() { return !!this.opacityOwner && (this.opacityDirty || this.opacityPending || this.opacityOwner.phase !== 'ready'); }
  get opacityControlsEnabled() {
    const state = useApp.getState(), owner = this.opacityOwner;
    if (owner?.phase === 'preparing' || this.opacityEntryTask) {
      const request = this.opacityEntryRequest, client = this.client;
      const owned = owner ? this.opacityScopeCurrent(owner) && !owner.cancelRequested : !!request && request.client === client &&
        request.documentId === client?.revision.documentId && request.sourceGeneration === client?.revision.sourceGeneration && request.generation === this.generation;
      return owned && !!client && this.scene?.kind === 'gaussian' && !!this.renderer && !this.renderer.lost && !this.filterOwner &&
        !this.destroyed && !this.closing && !this.closeRequest && !this.recovery && !this.editingFailed && !this.selectionCleanupOwner && this.ledger.overageBytes === 0 &&
        state.ready && state.mode === 'pro' && !state.navigationPrompt && !state.settingsOpen && !state.exportOpen && !state.outputPending &&
        !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length;
    }
    return this.filterBaseAvailable() && !this.filterOwner && !this.transformBlocksOrdinary && state.mode === 'pro' && state.ready &&
      !state.settingsOpen && !state.exportOpen && !state.outputPending && !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length &&
      !this.opacityEntryTask && (!owner ? this.editingAvailable && !state.busy && !this.selectionBarriers && !state.selectionDragging &&
        !state.summary?.selectionDraft && !state.pendingSelectionCount : this.opacityCurrent(owner) && !owner.cancelRequested &&
        (owner.phase === 'ready' || owner.phase === 'applying') && (!state.busy || owner.phase === 'applying' && !!owner.task));
  }
  get opacityApplyEnabled() { return this.opacityControlsEnabled && !this.opacityEntryTask && this.opacityOwner?.phase !== 'preparing'; }
  get opacityResetEnabled() {
    const owner = this.opacityOwner;
    return !!owner && this.opacityCurrent(owner) && owner.phase === 'ready' && !owner.task && !owner.ending && !useApp.getState().busy;
  }
  get opacityCancelEnabled() { return (!!this.opacityOwner || !!this.opacityEntryTask) && !this.destroyed && !this.closing && !this.opacityOwner?.ending && !this.recovery; }
  get colorResetPreviewEnabled() {
    const state = useApp.getState(), owner = this.opacityOwner;
    const meaningful = !sameColorValues(state.grade, NEUTRAL_COLOR) || state.opacityScale !== 1 || owner?.metadata?.appliedScale !== undefined && owner.metadata.appliedScale !== 1;
    return meaningful && !this.opacityEntryTask && (owner ? this.opacityResetEnabled : this.colorPreviewEnabled);
  }
  private publishOpacity(owner: OpacityOwner) {
    if (this.opacityOwner !== owner || this.destroyed) return;
    setApp({ opacity: { phase: owner.phase, selectedOnly: owner.selectedOnly, id: owner.metadata?.id ?? null, baseId: owner.metadata?.baseId ?? null,
      desiredRevision: owner.desiredRevision, appliedRevision: owner.appliedRevision, dirty: owner.desiredRevision !== owner.appliedRevision },
      dirty: (useApp.getState().summary?.contentRevision ?? this.savedContent) !== this.savedContent || this.colorPending || owner.desiredRevision !== owner.appliedRevision });
  }
  private refreshOpacityPreview(owner: OpacityOwner) {
    if (!this.opacityScopeCurrent(owner) || this.destroyed) return;
    const scale = opacityScale(owner.scale), revision = useApp.getState().opacityPreviewRevision + 1;
    setApp({ opacityPreviewRevision: revision });
    if (!owner.metadata || owner.phase === 'preparing') { this.publishOpacity(owner); return; }
    if (scale !== null) {
      owner.renderer?.setOpacityPreview(scale, owner.selectedOnly);
      setApp({ opacityPreviewRevision: revision, opacityPreview: { scale, selectedOnly: owner.selectedOnly,
        id: owner.metadata.id, baseId: owner.metadata.baseId, epoch: owner.metadata.epoch, revision } });
    }
    this.publishOpacity(owner); this.invalidate();
  }
  private clearOpacityPreview() {
    if (useApp.getState().opacityPreview) this.renderer?.setOpacityPreview(1, false);
    setApp({ opacityPreview: null, opacityPreviewRevision: useApp.getState().opacityPreviewRevision + 1 });
  }
  private retireOpacity(owner: OpacityOwner, resetScale = true) {
    if (this.opacityOwner !== owner) return;
    this.clearOpacityPreview(); this.opacityOwner = undefined;
    if (!this.destroyed) setApp({ opacity: null, ...(resetScale ? { opacityScale: 1 } : {}),
      ...(owner.error && useApp.getState().error === owner.error ? { error: null } : {}) });
  }
  private requireOpacityCleanup(owner: OpacityOwner) {
    if (this.opacityOwner !== owner || this.destroyed) return;
    owner.phase = 'required'; owner.error = useApp.getState().error ?? 'The opacity session could not be reconciled. Retry graphics or close the scene.';
    this.publishOpacity(owner); setApp({ error: owner.error });
  }
  private trackOpacityTask(owner: OpacityOwner, run: () => Promise<boolean>): Promise<boolean> {
    const task = Promise.resolve().then(run).catch(error => { this.error(error); if (this.editingFailed) this.requireOpacityCleanup(owner); return false; }).finally(() => {
      if (owner.task === task) owner.task = undefined; this.opacityTasks.delete(task);
      if (this.opacityOwner === owner && owner.phase !== 'required' && owner.phase !== 'ending') { owner.phase = 'ready'; this.publishOpacity(owner); }
    });
    owner.task = task; this.opacityTasks.add(task); return task;
  }
  private beginOpacityOwner(): Promise<boolean> {
    if (this.opacityOwner) return Promise.resolve(this.opacityCurrent(this.opacityOwner));
    const state = useApp.getState(), client = this.client;
    if (!client || !this.opacityControlsEnabled || this.transformOwner) return Promise.resolve(false);
    const owner: OpacityOwner = { client, documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration,
      generation: this.generation, selectedOnly: (state.summary?.selected ?? 0) > 0, nextEpoch: 1, scale: state.opacityScale, appliedScale: 1,
      desiredRevision: 0, appliedRevision: state.opacityScale === 1 ? 0 : null, phase: 'preparing', applyRequested: false, cancelRequested: false };
    this.opacityOwner = owner; this.publishOpacity(owner); this.selectionBarriers++;
    return this.trackOpacityTask(owner, async () => {
      try {
        this.cancelAlignment(); await this.floorCleanup; await this.closeToleranceSelection();
        if (!this.opacityCurrent(owner) || !await this.cancelSelectionGesture() || !await this.settleColorSession() || !this.opacityCurrent(owner)) return false;
        owner.scene = this.scene as GaussianScene; owner.renderer = this.renderer; owner.selectedOnly = (useApp.getState().summary?.selected ?? 0) > 0;
        this.camera?.clearInput(); setApp({ tool: null, fly: false, autoOrbit: false });
        const begun = await this.executeEditCommand({ command: 'beginOpacity', selectedOnly: owner.selectedOnly }, () => this.opacityCurrent(owner));
        const metadata = validateOpacitySummary(useApp.getState().summary?.opacitySession);
        if (begun !== true || !metadata || metadata.epoch !== 0 || metadata.appliedEpoch !== null || metadata.appliedScale !== 1 || metadata.selectedOnly !== owner.selectedOnly) {
          if (this.editingFailed || metadata) this.requireOpacityCleanup(owner); else this.retireOpacity(owner, false); return false;
        }
        owner.metadata = metadata; owner.phase = 'ready'; this.refreshOpacityPreview(owner); return true;
      } finally {
        this.releaseSelectionBarrier();
        if (this.opacityOwner === owner && !owner.metadata && !this.editingFailed && !owner.cancelRequested) this.retireOpacity(owner, false);
      }
    });
  }
  setOpacityScale(value: number) {
    const scale = opacityUiScale(value);
    if (scale === null) return;
    if (this.transformOwner || this.opacityEntryTask) {
      const client = this.client;
      if (!client || this.transformDirty || this.transformGizmoGesture || !this.opacityControlsEnabled || this.opacityEntryTask && !this.opacityEntryRequest) return;
      this.opacityEntryRequest = { scale, client, documentId: client.revision.documentId, generation: this.generation, sourceGeneration: client.revision.sourceGeneration };
      setApp({ opacityScale: scale, dirty: useApp.getState().dirty || scale !== 1 });
      if (!this.opacityEntryTask) {
        const task = Promise.resolve().then(async () => {
          if (!await this.endTransformSession()) return;
          const latest = this.opacityEntryRequest; this.opacityEntryRequest = undefined;
          if (this.opacityEntryTask === task) this.opacityEntryTask = undefined;
          if (latest && latest.client === this.client && latest.documentId === latest.client.revision.documentId && latest.generation === this.generation &&
            latest.sourceGeneration === latest.client.revision.sourceGeneration && !this.destroyed && !this.closing && !this.closeRequest) this.setOpacityScale(latest.scale);
        }).finally(() => { if (this.opacityEntryTask === task) this.opacityEntryTask = undefined; this.opacityEntryRequest = undefined; });
        this.opacityEntryTask = task; void task.catch(error => this.error(error));
      }
      return;
    }
    if (!this.opacityControlsEnabled || this.opacityOwner && scale === this.opacityOwner.scale ||
      !this.opacityOwner && scale === 1 && useApp.getState().opacityScale === 1) return;
    if (!this.opacityOwner) {
      const starting = this.beginOpacityOwner(), owner = this.opacityOwner as OpacityOwner | undefined;
      if (!owner) return;
      owner.scale = scale; owner.desiredRevision++; setApp({ opacityScale: scale }); this.refreshOpacityPreview(owner);
      void starting.then(() => { if (this.opacityOwner === owner) this.refreshOpacityPreview(owner); });
    } else {
      const owner = this.opacityOwner; owner.scale = scale; owner.desiredRevision++; setApp({ opacityScale: scale }); this.refreshOpacityPreview(owner);
    }
  }
  applyOpacity(): Promise<boolean> {
    if (!this.opacityApplyEnabled) return Promise.resolve(false);
    if (!this.opacityOwner) return this.endTransformSession().then(ended => ended ? this.beginOpacityOwner().then(begun => begun ? this.applyOpacity() : false) : false);
    const owner = this.opacityOwner; owner.applyRequested = true;
    return owner.task ?? this.trackOpacityTask(owner, async () => {
      while (this.opacityCurrent(owner) && !owner.cancelRequested && owner.applyRequested) {
        owner.applyRequested = false;
        const scale = opacityScale(owner.scale), revision = owner.desiredRevision, desired = owner.scale;
        if (scale === null || !owner.metadata) { this.error(new Error('The opacity value is invalid. Correct it before applying.')); return false; }
        const epoch = owner.nextEpoch++; owner.phase = 'applying'; this.publishOpacity(owner);
        const accepted = await this.executeEditCommand({ command: 'applyOpacity', id: owner.metadata.id, epoch, scale }, () => this.opacityCurrent(owner) && !owner.cancelRequested) === true;
        if (!accepted) { owner.applyRequested = false; if (this.editingFailed) this.requireOpacityCleanup(owner); return false; }
        const metadata = validateOpacitySummary(useApp.getState().summary?.opacitySession);
        if (!metadata || metadata.id !== owner.metadata.id || metadata.baseId !== owner.metadata.baseId || metadata.appliedEpoch !== epoch || metadata.epoch !== epoch || metadata.appliedScale !== scale) {
          this.requireOpacityCleanup(owner); return false;
        }
        owner.metadata = metadata; owner.appliedScale = desired; owner.appliedRevision = revision; owner.phase = 'ready'; this.refreshOpacityPreview(owner);
      }
      return !owner.cancelRequested;
    });
  }
  async cancelOpacityPreview(): Promise<boolean> {
    const owner = this.opacityOwner;
    if (!owner && !this.opacityEntryTask && !this.opacityEntryRequest) return true;
    if (!owner) {
      this.opacityEntryRequest = undefined;
      if (this.opacityEntryTask) await this.opacityEntryTask;
      if (this.opacityOwner) return this.cancelOpacityPreview();
      if (!this.destroyed) setApp({ opacityScale: 1, dirty: (useApp.getState().summary?.contentRevision ?? this.savedContent) !== this.savedContent || this.colorPending || this.transformDirty });
      return true;
    }
    owner.applyRequested = false;
    if (owner.task) { owner.cancelRequested = true; this.cancelEdit(); await owner.task; owner.cancelRequested = false; }
    if (!this.opacityScopeCurrent(owner) || this.editingFailed || owner.phase === 'required') return false;
    owner.scale = owner.appliedScale; owner.desiredRevision++; owner.appliedRevision = owner.desiredRevision; owner.phase = 'ready';
    setApp({ opacityScale: owner.scale }); this.refreshOpacityPreview(owner); return true;
  }
  resetOpacity(): Promise<boolean> {
    const owner = this.opacityOwner;
    if (!owner) return Promise.resolve(false);
    if (!this.opacityResetEnabled || !owner.metadata) return Promise.resolve(false);
    return this.trackOpacityTask(owner, async () => {
      const epoch = owner.nextEpoch++; owner.phase = 'resetting'; this.publishOpacity(owner);
      const accepted = await this.executeEditCommand({ command: 'resetOpacity', id: owner.metadata!.id, epoch }, () => this.opacityCurrent(owner)) === true;
      if (!accepted) { if (this.editingFailed) this.requireOpacityCleanup(owner); return false; }
      const metadata = validateOpacitySummary(useApp.getState().summary?.opacitySession);
      if (!metadata || metadata.id !== owner.metadata!.id || metadata.baseId !== owner.metadata!.baseId || metadata.appliedEpoch !== epoch || metadata.epoch !== epoch || metadata.appliedScale !== 1) {
        this.requireOpacityCleanup(owner); return false;
      }
      owner.metadata = metadata; owner.scale = owner.appliedScale = 1; owner.desiredRevision++; owner.appliedRevision = owner.desiredRevision; owner.phase = 'ready';
      setApp({ opacityScale: 1 }); this.refreshOpacityPreview(owner); return true;
    });
  }
  endOpacitySession(cancelDraft = false): Promise<boolean> {
    const owner = this.opacityOwner;
    if (!owner) return this.opacityEntryTask && cancelDraft ? this.cancelOpacityPreview().then(cancelled => cancelled ? this.endOpacitySession(true) : false) : Promise.resolve(!this.opacityEntryTask);
    if (owner.ending) return owner.ending;
    if (this.opacityDirty && !cancelDraft) return Promise.resolve(false);
    const task = (async () => {
      if (cancelDraft && !await this.cancelOpacityPreview()) return false;
      await owner.task;
      if (this.opacityOwner !== owner) return true;
      if (!this.opacityCurrent(owner) || !owner.metadata || this.opacityDirty) return false;
      owner.phase = 'ending'; this.publishOpacity(owner);
      const ended = await this.executeEditCommand({ command: 'endOpacity', id: owner.metadata.id }, () => this.opacityScopeCurrent(owner)) === true;
      if (ended && useApp.getState().summary?.opacitySession === null) { this.retireOpacity(owner); return true; }
      this.requireOpacityCleanup(owner); return false;
    })().catch(error => { this.error(error); this.requireOpacityCleanup(owner); return false; }).finally(() => {
      if (owner.ending === task) owner.ending = undefined; this.opacityTasks.delete(task);
    });
    owner.ending = task; this.opacityTasks.add(task); return task;
  }
  async resetColorPreview(): Promise<boolean> {
    if (!this.colorResetPreviewEnabled) return false;
    const client = this.client, generation = this.generation, sourceGeneration = client?.revision.sourceGeneration, documentId = client?.revision.documentId;
    if (this.opacityOwner && (!await this.resetOpacity() || !await this.endOpacitySession())) return false;
    if (this.transformOwner && !await this.endTransformSession()) return false;
    if (client !== this.client || generation !== this.generation || documentId !== client?.revision.documentId || sourceGeneration !== client?.revision.sourceGeneration ||
      this.destroyed || this.closing || this.closeRequest) return false;
    if (!this.opacityOwner && useApp.getState().opacityScale !== 1) setApp({ opacityScale: 1 });
    this.setGrade([...NEUTRAL_COLOR]); return sameColorValues(useApp.getState().grade, NEUTRAL_COLOR);
  }
  private transformScopeCurrent(owner: TransformOwner) {
    return this.transformOwner === owner && owner.client === this.client && owner.documentId === owner.client.revision.documentId &&
      owner.sourceGeneration === owner.client.revision.sourceGeneration && owner.generation === this.generation &&
      (!owner.scene || owner.scene === this.scene) && (!owner.renderer || owner.renderer === this.renderer);
  }
  private transformCurrent(owner: TransformOwner) { return this.transformScopeCurrent(owner) && this.filterBaseAvailable() && !this.filterOwner; }
  get transformActive() { return !!this.transformOwner; }
  get transformPending() { return !!this.transformOwner?.task || !!this.transformOwner?.ending; }
  get transformDirty() { return !!this.transformOwner && this.transformOwner.desiredRevision !== this.transformOwner.appliedRevision; }
  get transformControlsEnabled() {
    const owner = this.transformOwner, state = useApp.getState();
    // Committed desktop viewport tools expose manual transforms in both modes.
    return !this.transformGizmoActionOwner && this.filterBaseAvailable() && !this.filterOwner && !this.opacityBlocksOrdinary && !this.opacityEntryTask && state.ready &&
      !state.settingsOpen && !state.exportOpen && !state.outputPending && !state.viewTransferPending && !state.thumbnailPending &&
      !state.savedViewChoices.length && !this.transformPivotQuery && !this.transformGizmoGesture && (!owner ? this.editingAvailable && !state.busy &&
        !this.selectionBarriers && !state.selectionDragging && !state.summary?.selectionDraft && !state.pendingSelectionCount :
        this.transformCurrent(owner) && !owner.cancelRequested && (owner.phase === 'ready' || owner.kind === 'numeric' && owner.phase === 'applying') &&
        (!state.busy || owner.kind === 'numeric' && owner.phase === 'applying' && !!owner.task));
  }
  get transformApplyEnabled() { return this.transformControlsEnabled && (!this.transformOwner || this.transformOwner.kind === 'numeric') && this.transformOwner?.phase !== 'preparing'; }
  get transformResetEnabled() {
    if (this.colorPending || this.transformGizmoGesture || this.transformPivotQuery || this.transformGizmoActionOwner) return false;
    try { if (!validateAlignmentSummary(useApp.getState().summary?.alignment)) return false; } catch { return false; }
    const owner = this.transformOwner;
    return owner ? this.transformCurrent(owner) && owner.phase === 'ready' && !owner.task && !owner.ending :
      this.alignmentReady();
  }
  get transformCancelEnabled() { return !!this.transformOwner && !this.transformPivotQuery && !this.destroyed && !this.closing && !this.transformOwner.ending && !this.recovery; }
  get transformGizmoGestureActive() { return !!this.transformGizmoGesture; }
  get transformGizmoWidgetMatrix() { return this.transformOwner?.kind === 'gizmo' ? this.transformOwner.widgetMatrix ?? null : null; }
  get transformGizmoModeEnabled() {
    const owner = this.transformOwner, state = useApp.getState();
    return !this.transformGizmoActionOwner && this.filterBaseAvailable() && !this.filterOwner && !this.opacityBlocksOrdinary && !this.opacityEntryTask && state.ready && state.toolsOpen && !state.busy &&
      !this.editOperation && !this.selectionBarriers && !this.transformPivotQuery && !this.transformPending && !this.transformGizmoActionOwner && !this.transformNumericTask && !this.transformGradeTask && !this.transformGizmoGesture && !this.transformDirty &&
      !state.selectionDragging && !state.summary?.selectionDraft && !state.pendingSelectionCount && !state.settingsOpen && !state.exportOpen &&
      !state.outputPending && !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length &&
      (!owner || this.transformCurrent(owner) && owner.phase === 'ready');
  }
  get transformGizmoControlsEnabled() {
    const owner = this.transformOwner, state = useApp.getState();
    return !!owner && owner.kind === 'gizmo' && owner.phase === 'ready' && !!owner.metadata && !!owner.widgetMatrix &&
      this.transformCurrent(owner) && !this.transformPivotQuery && !this.transformPivotDefaultPending && !this.transformPivotRefreshPending &&
      !this.transformPending && !this.transformGizmoActionOwner && !this.opacityOwner && !this.opacityEntryTask && !state.busy && !owner.cancelRequested && !!state.transformGizmoMode &&
      state.toolsOpen && state.ready && !state.settingsOpen && !state.exportOpen && !state.outputPending &&
      !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length && !state.summary?.pending;
  }
  private publishTransform(owner: TransformOwner) {
    if (this.transformOwner !== owner || this.destroyed) return;
    setApp({ transform: { phase: owner.phase, kind: owner.kind, selectedOnly: owner.selectedOnly, id: owner.metadata?.id ?? null,
      baseId: owner.metadata?.baseId ?? null, desiredRevision: owner.desiredRevision, appliedRevision: owner.appliedRevision,
      dirty: owner.desiredRevision !== owner.appliedRevision },
      dirty: (useApp.getState().summary?.contentRevision ?? this.savedContent) !== this.savedContent || this.colorPending || owner.desiredRevision !== owner.appliedRevision });
  }
  private refreshTransformPreview(owner: TransformOwner) {
    if (!this.transformScopeCurrent(owner) || !owner.metadata || !this.camera || this.destroyed) return;
    let matrix: TransformMatrix | null = owner.metadata.appliedMatrix, pivot: TransformVec3 = owner.metadata.pivot;
    if (owner.kind === 'gizmo' && this.transformHasPivotReference()) pivot = owner.parameters.pivot;
    if (owner.kind === 'numeric') {
      const definition = transformWireParameters(owner.parameters), composed = definition && this.camera.composeTransform(definition);
      matrix = composed ? validateTransformMatrix(composed.matrix) : null;
      if (composed) pivot = [...composed.pivot] as TransformVec3;
    } else if (this.transformGizmoGesture?.owner === owner && this.transformGizmoGesture.ready && this.transformGizmoGesture.pose) matrix = validateTransformMatrix(this.transformGizmoGesture.pose.deltaMatrix);
    // Invalid staged input retains the last valid display; Apply still refuses.
    if (matrix) setApp({ transformPreview: { matrix: [...matrix] as TransformMatrix, pivot: [...pivot] as TransformVec3,
      selectedOnly: owner.selectedOnly, kind: owner.kind, id: owner.metadata.id, baseId: owner.metadata.baseId, epoch: owner.metadata.epoch } });
    this.publishTransform(owner); this.invalidate();
  }
  private retireTransform(owner: TransformOwner, resetParameters = true) {
    if (this.transformOwner !== owner) return;
    const state = useApp.getState();
    let pivot = [...state.transformParameters.pivot] as TransformVec3;
    if (resetParameters && owner.kind === 'numeric' && state.transformPivotMode === 'custom' && owner.metadata) {
      const m = owner.metadata.appliedMatrix, p = pivot;
      pivot = [0, 1, 2].map(axis => m[axis] * p[0] + m[axis + 4] * p[1] + m[axis + 8] * p[2] + m[axis + 12]) as TransformVec3;
    }
    this.cancelTransformGizmoGesture(undefined, true); this.transformOwner = undefined;
    if (!this.destroyed) setApp({ transform: null, transformPreview: null, ...(resetParameters ? {
      transformParameters: { ...transformDefaults(), pivot: state.transformPivotMode === 'origin' ? [0, 0, 0] : pivot } } : {}),
      ...(owner.error && useApp.getState().error === owner.error ? { error: null } : {}) });
    this.queueTransformPivotSynchronization();
  }
  private requireTransformCleanup(owner: TransformOwner) {
    if (this.transformOwner !== owner || this.destroyed) return;
    this.cancelTransformGizmoGesture(undefined, true); owner.phase = 'required';
    owner.error = useApp.getState().error ?? 'The transform could not be reconciled. Retry graphics or close the scene.';
    this.publishTransform(owner); setApp({ error: owner.error });
  }
  private trackTransformTask(owner: TransformOwner, run: () => Promise<boolean>): Promise<boolean> {
    const task = Promise.resolve().then(run).catch(error => {
      this.error(error); if (this.editingFailed) this.requireTransformCleanup(owner); return false;
    }).finally(() => {
      if (owner.task === task) owner.task = undefined; this.transformTasks.delete(task);
      if (this.transformOwner === owner && owner.phase !== 'required' && owner.phase !== 'ending') { owner.phase = 'ready'; this.publishTransform(owner); }
      this.queueTransformPivotSynchronization();
    });
    owner.task = task; this.transformTasks.add(task); return task;
  }
  private beginTransformOwner(kind: TransformKind): Promise<boolean> {
    if (this.transformOwner) return Promise.resolve(this.transformOwner.kind === kind && this.transformCurrent(this.transformOwner));
    const state = useApp.getState(), parameters = transformUiParameters(state.transformParameters);
    if (!parameters || !this.filterBaseAvailable() || this.filterOwner || this.opacityOwner || !state.ready || state.busy ||
      this.editOperation || this.exporting || this.selectionBarriers || state.settingsOpen || state.exportOpen || state.outputPending ||
      state.viewTransferPending || state.thumbnailPending || state.savedViewChoices.length) return Promise.resolve(false);
    const client = this.client!;
    const baseline = transformDefaults(); baseline.pivot = [...parameters.pivot];
    const owner: TransformOwner = { client, documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration,
      generation: this.generation, kind, selectedOnly: (state.summary?.selected ?? 0) > 0, nextEpoch: 1,
      parameters, appliedParameters: baseline, desiredRevision: 0,
      appliedPivotMode: state.transformPivotMode, appliedPivotChosen: state.transformPivotChosen,
      appliedRevision: kind === 'gizmo' || sameTransformParameters(parameters, baseline) ? 0 : null,
      phase: 'preparing', applyRequested: false, cancelRequested: false };
    this.transformOwner = owner; this.publishTransform(owner); this.selectionBarriers++;
    return this.trackTransformTask(owner, async () => {
      try {
        this.cancelAlignment(); await this.floorCleanup; await this.closeToleranceSelection();
        if (!this.transformCurrent(owner) || !await this.cancelSelectionGesture() || !await this.settleColorSession() || !this.transformCurrent(owner)) return false;
        owner.selectedOnly = (useApp.getState().summary?.selected ?? 0) > 0;
        owner.scene = this.scene as GaussianScene; owner.renderer = this.renderer;
        this.camera?.clearInput(); setApp({ tool: null, fly: false, autoOrbit: false });
        const started = await this.executeEditCommand({ command: 'beginTransform', kind, selectedOnly: owner.selectedOnly }, () => this.transformCurrent(owner));
        const metadata = validateTransformSummary(useApp.getState().summary?.transformSession ?? null);
        if (started !== true || !metadata || metadata.kind !== kind || metadata.epoch !== 0 || metadata.appliedEpoch !== null || metadata.selectedOnly !== owner.selectedOnly) {
          if (this.editingFailed || metadata) this.requireTransformCleanup(owner); else this.retireTransform(owner, false); return false;
        }
        owner.metadata = metadata; owner.phase = 'ready';
        if (kind === 'gizmo') {
          const defaults = transformDefaults(); defaults.translation = this.transformHasPivotReference() ? [...owner.parameters.pivot] : [...metadata.pivot];
          const composition = this.camera?.composeTransform(transformWireParameters(defaults)!);
          owner.widgetMatrix = composition ? validateTransformMatrix(composition.matrix) ?? undefined : undefined;
          if (!owner.widgetMatrix) { this.error(new Error('The transform widget pivot is unavailable.')); return false; }
        }
        this.refreshTransformPreview(owner); return true;
      } finally { this.releaseSelectionBarrier(); }
    });
  }
  setTransformMode(mode: TransformMode) { if (isTransformMode(mode)) this.setTransformParameters({ mode }); }
  setTransformParameters(patch: Partial<TransformParameters>) {
    if (this.transformPivotQuery) return;
    const validated = patchTransformParameters(this.transformNumericRequest?.parameters ?? this.transformOwner?.parameters ?? useApp.getState().transformParameters, patch);
    if (!validated) return;
    if (Reflect.ownKeys(patch).length === 1 && Object.hasOwn(patch, 'pivot')) {
      if (this.transformControlsEnabled) this.setTransformPivotReference(validated.pivot, 'custom');
      return;
    }
    if (this.opacityOwner || this.transformOwner?.kind === 'gizmo' || this.transformNumericTask) {
      const owner = this.transformOwner, client = this.client;
      if (!client || this.transformGizmoGesture || this.transformDirty || this.opacityDirty || !this.transformNumericTask && !this.transformControlsEnabled ||
        owner && !(owner.phase === 'ready' && !owner.task || owner.ending && !!this.transformNumericTask)) return;
      const previous = this.transformNumericRequest?.parameters ?? useApp.getState().transformParameters,
        parameters = patchTransformParameters(previous, patch);
      if (!parameters || sameTransformParameters(parameters, previous)) return;
      this.transformNumericRequest = { parameters, client, generation: this.generation, sourceGeneration: client.revision.sourceGeneration };
      if (!this.transformNumericTask) {
        const task = Promise.resolve().then(async () => {
          if (!await this.endOpacitySession() || !await this.endTransformSession()) return;
          const latest = this.transformNumericRequest; this.transformNumericRequest = undefined;
          if (this.transformNumericTask === task) this.transformNumericTask = undefined;
          if (latest && latest.client === this.client && latest.generation === this.generation && latest.sourceGeneration === latest.client.revision.sourceGeneration &&
            !this.destroyed && !this.closing && !this.closeRequest) this.setTransformParameters(latest.parameters);
        }).finally(() => { if (this.transformNumericTask === task) this.transformNumericTask = undefined; this.transformNumericRequest = undefined; });
        this.transformNumericTask = task; void task.catch(error => this.error(error));
      }
      return;
    }
    if (!this.transformControlsEnabled) return;
    const previous = this.transformOwner?.parameters ?? useApp.getState().transformParameters, parameters = patchTransformParameters(previous, patch);
    if (!parameters || sameTransformParameters(parameters, previous)) return;
    if (Object.hasOwn(patch, 'pivot')) {
      this.consumeTransformPivotDefaults(); setApp({ transformPivotMode: 'custom', transformPivotChosen: true });
    }
    if (!this.transformOwner) {
      const starting = this.beginTransformOwner('numeric'), owner = this.transformOwner as TransformOwner | undefined;
      if (!owner) return;
      owner.parameters = parameters; owner.desiredRevision++; setApp({ transformParameters: parameters }); this.publishTransform(owner);
      void starting.then(() => { if (this.transformOwner === owner) this.refreshTransformPreview(owner); });
    } else {
      const owner = this.transformOwner; owner.parameters = parameters; owner.desiredRevision++;
      setApp({ transformParameters: parameters }); this.refreshTransformPreview(owner);
    }
  }
  setTransformFlip(axis: number, value: boolean) {
    if (!Number.isInteger(axis) || axis < 0 || axis > 2 || typeof value !== 'boolean') return;
    const flip = [...(this.transformNumericRequest?.parameters ?? useApp.getState().transformParameters).flips] as [boolean, boolean, boolean];
    flip[axis] = value; this.setTransformParameters({ flips: flip });
  }
  /** A pivot is a reference: neutral scale/rotation must not create an edit. */
  private transformHasPivotReference() {
    const state = useApp.getState(); return state.transformPivotChosen || state.transformPivotMode !== 'scene';
  }
  /** Store notifications are coalesced after the authoritative edit has joined.
   * The native counter records membership, including same-count replacements;
   * draft previews and content-only revisions do not choose a new reference. */
  private watchTransformPivot() {
    this.transformPivotUnsubscribe ??= useApp.subscribe(() => this.queueTransformPivotSynchronization());
    this.queueTransformPivotSynchronization();
  }
  private resetTransformPivotSynchronization() {
    this.transformPivotObserved = undefined; this.transformPivotDefaultPending = false;
    this.transformPivotRefreshPending = false; this.transformPivotFailedStamp = undefined; this.transformNumericFocus = undefined;
  }
  setTransformNumericFocus(token: object, active: boolean) {
    if (active) this.transformNumericFocus = token;
    else if (this.transformNumericFocus === token) {
      this.transformNumericFocus = undefined; this.queueTransformPivotSynchronization();
    }
  }
  private queueTransformPivotSynchronization() {
    if (!this.transformPivotUnsubscribe || this.transformPivotQueued || this.destroyed) return;
    this.transformPivotQueued = true;
    queueMicrotask(() => {
      this.transformPivotQueued = false;
      if (this.transformPivotUnsubscribe && !this.destroyed) void this.synchronizeTransformPivot();
    });
  }
  private transformPivotGeometry(summary: NativeSummary) {
    const base = summary.transformSession;
    // Applied epochs move the display; the retained native base stays fixed.
    return base ? `base:${base.id}:${base.baseId}` : `content:${summary.contentRevision}`;
  }
  private observeTransformPivot() {
    const client = this.client, summary = useApp.getState().summary;
    if (!client || !summary?.loaded || summary.kind !== 0 || !Number.isSafeInteger(summary.selectionCommitRevision) ||
        this.editOperation || this.recovery || summary.transaction || summary.pending || summary.selectionDraft) return;
    const counter = summary.selectionCommitRevision!, geometry = this.transformPivotGeometry(summary), previous = this.transformPivotObserved;
    if (previous && previous.client === client && previous.documentId === client.revision.documentId &&
        previous.sourceGeneration === client.revision.sourceGeneration) {
      if (counter !== previous.counter) this.transformPivotDefaultPending = true;
      if (geometry !== previous.geometry) this.transformPivotRefreshPending = true;
    } else {
      this.transformPivotFailedStamp = undefined;
      // Durable geometry survives recovery: an edit completed by the successor
      // still moves the reference, even though its selection counter is reset.
      if (previous && previous.client !== client && previous.documentId === client.revision.documentId &&
          previous.sourceGeneration === client.revision.sourceGeneration && geometry !== previous.geometry) this.transformPivotRefreshPending = true;
    }
    // A fresh/recovered worker primes this non-durable counter without treating
    // its reset as a selection event. Accepted source replacement resets pending.
    this.transformPivotObserved = { client, documentId: client.revision.documentId,
      sourceGeneration: client.revision.sourceGeneration, counter, geometry };
  }
  private consumeTransformPivotDefaults() {
    this.observeTransformPivot();
    this.transformPivotDefaultPending = false; this.transformPivotRefreshPending = false; this.transformPivotFailedStamp = undefined;
  }
  private automaticTransformPivotReady() {
    const state = useApp.getState(), summary = state.summary, owner = this.transformOwner;
    return this.filterBaseAvailable() && state.ready && !state.busy && !this.editOperation && !this.exporting &&
      !this.filterOwner && !this.selection && !this.selectionBarriers && !this.releasedDrain && !this.releasedSelections.length &&
      !this.deferredColorPointer && !state.selectionDragging && !state.pendingSelectionCount && !summary?.pending && !summary?.transaction && !summary?.selectionDraft &&
      summary?.pendingSelectionMapId === null && !summary.colorSession?.pending && !this.colorEntryTask && !this.colorJob &&
      !this.transformPivotQuery && !this.morphologyRangeOwner && !this.transformNumericFocus && !this.transformGizmoGesture && !this.transformNumericTask &&
      !this.transformGradeTask && !this.opacityEntryTask && !this.opacityPending && !this.tolerance?.applying &&
      !this.tolerance?.waitingMap && !this.tolerance?.mapQuery && !this.alignmentPick && !this.alignmentConfirming &&
      !this.floorPreparing && !this.floorOwner?.detecting && !state.settingsOpen && !state.exportOpen && !state.outputPending &&
      !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length &&
      (!owner || this.transformCurrent(owner) && owner.phase === 'ready' && !owner.task && !owner.ending && !owner.cancelRequested);
  }
  private transformPivotSynchronizationStamp() {
    const summary = useApp.getState().summary;
    return JSON.stringify([summary?.selectionCommitRevision, summary?.revision, summary?.contentRevision,
      summary && this.transformPivotGeometry(summary), this.renderer?.deviceEpoch, this.ledger.usage.bytes]);
  }
  private synchronizeTransformPivot(): Promise<boolean> {
    this.observeTransformPivot();
    if (this.transformPivotQuery) return this.transformPivotQuery.task;
    if (!this.transformPivotDefaultPending && !this.transformPivotRefreshPending) return Promise.resolve(true);
    if (!this.automaticTransformPivotReady() || this.transformPivotFailedStamp === this.transformPivotSynchronizationStamp()) return Promise.resolve(false);
    const state = useApp.getState();
    let mode = state.transformPivotMode, chosen = state.transformPivotChosen;
    if (this.transformPivotDefaultPending) {
      if ((state.summary?.selected ?? 0) > 0) { mode = 'selection'; chosen = true; }
      else if (mode === 'selection') { mode = 'origin'; chosen = true; }
      else {
        this.transformPivotDefaultPending = false;
        if (!this.transformPivotRefreshPending) return Promise.resolve(true);
      }
    }
    if (mode === 'custom' || mode === 'origin' && !this.transformPivotDefaultPending) {
      this.transformPivotDefaultPending = false; this.transformPivotRefreshPending = false; return Promise.resolve(true);
    }
    return this.chooseTransformPivot(mode, chosen, true);
  }
  private setTransformPivotReference(pivot: TransformVec3, mode: TransformPivotMode, chosen = true, explicit = true): boolean {
    const owner = this.transformOwner, previous = owner?.parameters ?? useApp.getState().transformParameters;
    const parameters = patchTransformParameters(previous, { pivot });
    if (!parameters || owner && (owner.task || owner.ending || owner.phase !== 'ready')) return false;
    const sameMatrix = (left: TransformParameters, right: TransformParameters) => {
      const a = transformWireParameters(left), b = transformWireParameters(right);
      const first = a && this.camera?.composeTransform(a), second = b && this.camera?.composeTransform(b);
      return !!first && !!second && first.matrix.every((value, index) => value === second.matrix[index]);
    };
    if (owner) {
      if (owner.kind === 'gizmo') {
        const values = transformDefaults(); values.translation = [...parameters.pivot];
        const composition = this.camera?.composeTransform(transformWireParameters(values)!);
        const matrix = composition && validateTransformMatrix(composition.matrix);
        if (!matrix) return false;
        owner.widgetMatrix = matrix;
      } else if (!sameMatrix(previous, parameters)) owner.desiredRevision++;
      const applied = patchTransformParameters(owner.appliedParameters, { pivot: parameters.pivot })!;
      if (owner.kind === 'gizmo' || sameMatrix(owner.appliedParameters, applied)) {
        owner.appliedParameters = applied; owner.appliedPivotMode = mode; owner.appliedPivotChosen = chosen;
      }
      owner.parameters = parameters;
    }
    if (explicit) this.consumeTransformPivotDefaults();
    setApp({ transformParameters: parameters, transformPivotMode: mode, transformPivotChosen: chosen });
    if (owner) this.refreshTransformPreview(owner); else this.invalidate();
    return true;
  }
  cycleTransformPivot(): Promise<boolean> {
    const state = useApp.getState();
    if (state.mode !== 'pro' || state.transformParameters.mode === 'matrix') return Promise.resolve(false);
    return this.chooseTransformPivot(nextPivotMode(state.transformPivotMode, (state.summary?.selected ?? 0) > 0));
  }
  private chooseTransformPivot(mode: Exclude<TransformPivotMode, 'custom'>, chosen = true, automatic = false): Promise<boolean> {
    if (this.transformPivotQuery) return this.transformPivotQuery.task;
    const state = useApp.getState(), client = this.client, scene = this.scene, owner = this.transformOwner;
    if (!client || !(automatic ? this.automaticTransformPivotReady() : this.transformControlsEnabled) ||
        owner && (owner.task || owner.ending || owner.phase !== 'ready')) return Promise.resolve(false);
    if (mode === 'origin') {
      const accepted = this.setTransformPivotReference([0, 0, 0], mode, chosen, !automatic);
      if (accepted && automatic) { this.transformPivotDefaultPending = false; this.transformPivotRefreshPending = false; }
      return Promise.resolve(accepted);
    }
    const generation = this.generation, revision = owner?.desiredRevision, documentId = client.revision.documentId,
      sourceGeneration = client.revision.sourceGeneration, parameters = transformUiParameters(state.transformParameters)!;
    let capturedRevision: Revision | undefined;
    const query = { cancel: new AbortController(), querying: false, automatic, task: undefined! as Promise<boolean> };
    // An automatic reference read is preemptible: it neither fences input nor
    // publishes busy. Native work owners cancel and join it before claiming
    // the work slot (see joinAutomaticTransformPivot).
    this.transformPivotQuery = query; if (!automatic) this.selectionBarriers++;
    setApp({ transformPivotPending: true });
    const sameSource = () => this.transformPivotQuery === query && this.client === client && this.scene === scene &&
      this.generation === generation && this.transformOwner === owner && owner?.desiredRevision === revision &&
      client.revision.documentId === documentId && client.revision.sourceGeneration === sourceGeneration &&
      (!capturedRevision || sameRevision(capturedRevision, client.revision)) &&
      sameTransformParameters(parameters, useApp.getState().transformParameters) &&
      !this.destroyed && !this.closing && !this.closeRequest && !query.cancel.signal.aborted;
    const coverage = this.nativeCoverage.get(client);
    let work: ResourceLease | undefined, covered = false, accepted = false;
    const task = Promise.resolve().then(async () => {
      try {
        if (!automatic) {
          this.cancelAlignment(); await this.floorCleanup;
          await this.closeToleranceSelection();
          if (!sameSource() || !await this.endOpacitySession() || !await this.settleColorSession() || !sameSource()) return false;
        }
        if (!sameSource()) return false;
        // Constant-sized admitted native owner; no scene clone, mask copy or Undo.
        client.assertNativeAdmission(); work = this.ledger.reserve('work', 64 * 1024);
        client.updateNativeCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]); covered = true;
        if (coverage) coverage.work = work; client.setNativeWork(work);
        query.querying = true; if (!automatic) setApp({ busy: true, stage: 'Finding pivot', progress: 0 });
        capturedRevision = { ...client.revision };
        const base = owner?.metadata;
        const point = await client.transformFocus(mode, base ? { id: base.id, baseId: base.baseId, epoch: base.epoch } : null, query.cancel.signal);
        if (!sameSource()) return false;
        accepted = this.setTransformPivotReference(point ?? [0, 0, 0], point ? mode : 'origin', chosen, !automatic);
        if (accepted && automatic) { this.transformPivotDefaultPending = false; this.transformPivotRefreshPending = false; this.transformPivotFailedStamp = undefined; }
        return accepted;
      } catch (error) {
        if (sameSource()) this.error(error);
        return false;
      } finally {
        try {
          client.setNativeWork(undefined); if (coverage && coverage.work === work) coverage.work = undefined;
          if (work) { if (client.failed) await client.retireNativeMemory(); if (covered && !client.failed) client.releaseNativeCoverage(work); else work(); }
        } finally {
          if (this.transformPivotQuery === query) {
            this.transformPivotQuery = undefined;
            // A preempted read is retried once its preempting owner settles.
            if (automatic && !accepted && !query.cancel.signal.aborted) this.transformPivotFailedStamp = this.transformPivotSynchronizationStamp();
            if (!this.destroyed) setApp({ transformPivotPending: false,
              ...(!automatic && client === this.client && !this.recovery && !this.closing ? { busy: false, stage: '' } : {}) });
          }
          this.transformTasks.delete(task); if (!automatic) this.releaseSelectionBarrier();
        }
      }
    });
    query.task = task; this.transformTasks.add(task); return task;
  }
  private async cancelTransformPivotFocus() {
    const query = this.transformPivotQuery;
    if (query) { query.cancel.abort(); await query.task; }
  }
  /** Native work owners call this immediately before a synchronous claim of the
   * work slot; their own owner state then fences a successor automatic read. */
  private async joinAutomaticTransformPivot() {
    while (this.transformPivotQuery?.automatic) await this.cancelTransformPivotFocus();
  }
  applyTransform(): Promise<boolean> {
    if (this.transformPivotQuery) return this.transformPivotQuery.task.then(accepted => accepted ? this.applyTransform() : false);
    this.observeTransformPivot();
    if (this.transformPivotDefaultPending || this.transformPivotRefreshPending)
      return this.synchronizeTransformPivot().then(accepted => accepted ? this.applyTransform() : false);
    if (!this.transformApplyEnabled) return Promise.resolve(false);
    if (this.opacityOwner) return this.endOpacitySession().then(ended => ended ? this.applyTransform() : false);
    if (!this.transformOwner) return this.beginTransformOwner('numeric').then(started => started ? this.applyTransform() : false);
    const owner = this.transformOwner; owner.applyRequested = true;
    return owner.task ?? this.trackTransformTask(owner, () => this.runTransformRequests(owner));
  }
  private async runTransformRequests(owner: TransformOwner, gizmoDefinition?: TransformDefinition): Promise<boolean> {
    let accepted = true;
    while (this.transformCurrent(owner) && !owner.cancelRequested && owner.applyRequested) {
      owner.applyRequested = false;
      const parameters = gizmoDefinition ?? transformWireParameters(owner.parameters), revision = owner.desiredRevision;
      if (!parameters || !this.camera?.composeTransform(parameters) || !owner.metadata) {
        this.error(new Error('The transform values are invalid. Correct them before applying.')); return false;
      }
      const full = transformUiParameters(owner.parameters)!, epoch = owner.nextEpoch++, previousMetadata = owner.metadata;
      owner.phase = 'applying'; this.publishTransform(owner);
      accepted = await this.executeEditCommand({ command: 'applyTransform', id: owner.metadata.id, epoch, parameters },
        () => this.transformCurrent(owner) && !owner.cancelRequested) === true;
      if (!accepted) { owner.applyRequested = false; if (this.editingFailed) this.requireTransformCleanup(owner); return false; }
      const metadata = validateTransformSummary(useApp.getState().summary?.transformSession);
      if (!metadata || metadata.id !== owner.metadata.id || metadata.epoch !== epoch ||
        (owner.kind === 'numeric' ? metadata.baseId !== previousMetadata.baseId || metadata.appliedEpoch !== epoch :
          !metadata.gizmo || metadata.baseId === previousMetadata.baseId || metadata.appliedEpoch !== null)) {
        this.requireTransformCleanup(owner); return false;
      }
      owner.metadata = metadata; owner.appliedParameters = full; owner.appliedRevision = revision;
      owner.appliedPivotMode = useApp.getState().transformPivotMode; owner.appliedPivotChosen = useApp.getState().transformPivotChosen;
      owner.phase = 'ready';
      if (owner.kind === 'gizmo') this.rebuildTransformGizmoWidget(owner);
      this.refreshTransformPreview(owner);
    }
    return accepted && !owner.cancelRequested;
  }
  async cancelTransformPreview(): Promise<boolean> {
    await this.cancelTransformPivotFocus();
    const owner = this.transformOwner;
    if (!owner) return true;
    this.cancelTransformGizmoGesture(undefined, true); owner.applyRequested = false;
    if (owner.task) { owner.cancelRequested = true; this.cancelEdit(); await owner.task; owner.cancelRequested = false; }
    if (!this.transformScopeCurrent(owner) || this.editingFailed || owner.phase === 'required') return false;
    owner.parameters = transformUiParameters(owner.appliedParameters)!; owner.desiredRevision++; owner.appliedRevision = owner.desiredRevision;
    owner.phase = 'ready'; setApp({ transformParameters: owner.parameters,
      transformPivotMode: owner.appliedPivotMode ?? 'custom', transformPivotChosen: owner.appliedPivotChosen ?? false }); this.refreshTransformPreview(owner); return true;
  }
  async resetTransform(): Promise<boolean> {
    if (!this.transformResetEnabled) return false;
    // Desktop header Reset first cancels the entire gizmo, then performs
    // its existing alignment/numeric reset. Numeric Reset is owner-specific.
    if (this.transformOwner?.kind === 'gizmo') {
      const owner = this.transformOwner;
      return await this.cancelGizmoOwner(owner) ? this.resetTransform() : false;
    }
    this.cancelTransformGizmoGesture(undefined, true); const owner = this.transformOwner;
    if (!owner) {
      const reset = !useApp.getState().summary?.alignment?.canReset || await this.command({ command: 'resetAlignment' });
      if (reset) {
        setApp({ transformParameters: transformDefaults(), transformPivotMode: 'origin', transformPivotChosen: false });
        await this.chooseTransformPivot((useApp.getState().summary?.selected ?? 0) > 0 ? 'selection' : 'origin', false);
      }
      return reset;
    }
    if (owner.task || !owner.metadata || !this.transformCurrent(owner)) return false;
    const reset = await this.trackTransformTask(owner, async () => {
      const epoch = owner.nextEpoch++; owner.phase = 'resetting'; this.publishTransform(owner);
      const accepted = await this.executeEditCommand({ command: 'resetTransform', id: owner.metadata!.id, epoch }, () => this.transformCurrent(owner)) === true;
      if (!accepted) { if (this.editingFailed) this.requireTransformCleanup(owner); return false; }
      const metadata = validateTransformSummary(useApp.getState().summary?.transformSession);
      if (!metadata || metadata.id !== owner.metadata!.id || metadata.appliedEpoch !== epoch) { this.requireTransformCleanup(owner); return false; }
      owner.metadata = metadata; owner.parameters = transformDefaults(); owner.appliedParameters = transformDefaults(); owner.desiredRevision++;
      owner.appliedRevision = owner.desiredRevision; owner.phase = 'ready'; setApp({ transformParameters: owner.parameters }); this.refreshTransformPreview(owner); return true;
    });
    if (reset) await this.chooseTransformPivot((useApp.getState().summary?.selected ?? 0) > 0 ? 'selection' : 'origin', false);
    return reset;
  }
  endTransformSession(cancelDraft = false): Promise<boolean> {
    if (this.transformPivotQuery) return this.cancelTransformPivotFocus().then(() => this.endTransformSession(cancelDraft));
    const owner = this.transformOwner;
    if (!owner) return Promise.resolve(true);
    if (owner.ending) return owner.ending;
    if (this.transformDirty && !cancelDraft || this.transformGizmoGesture && !cancelDraft) return Promise.resolve(false);
    const task = (async () => {
      if (cancelDraft && !await this.cancelTransformPreview()) return false;
      await owner.task;
      if (this.transformOwner !== owner) return true;
      if (!this.transformCurrent(owner) || !owner.metadata || this.transformDirty) return false;
      this.cancelTransformGizmoGesture(undefined, true); owner.phase = 'ending'; this.publishTransform(owner);
      const ended = await this.executeEditCommand({ command: 'endTransform', id: owner.metadata.id }, () => this.transformScopeCurrent(owner)) === true;
      if (ended && useApp.getState().summary?.transformSession === null) { this.retireTransform(owner); return true; }
      this.requireTransformCleanup(owner); return false;
    })().catch(error => { this.error(error); this.requireTransformCleanup(owner); return false; }).finally(() => {
      if (owner.ending === task) owner.ending = undefined; this.transformTasks.delete(task);
    });
    owner.ending = task; this.transformTasks.add(task); return task;
  }
  setTransformLocalAxes(value: boolean) { if (typeof value === 'boolean' && !this.transformGizmoGesture && !this.filterGizmoGesture) setApp({ filterLocalAxes: value }); }
  setTransformSnap(value: boolean) { if (typeof value === 'boolean' && !this.transformGizmoGesture && !this.filterGizmoGesture) setApp({ filterSnap: value }); }
  private watchTransformGizmo() {
    if (this.transformGizmoUnsubscribe) return;
    this.transformGizmoUnsubscribe = useApp.subscribe(state => {
      const gesture = this.transformGizmoGesture, owner = this.transformOwner;
      if (!state.toolsOpen || !state.ready || state.rendererState !== 'ready' || !owner || owner.kind !== 'gizmo' ||
        !this.transformScopeCurrent(owner) || gesture && state.transformGizmoMode !== gesture.token.mode) {
        this.cancelTransformGizmoGesture(undefined, true);
      } else if (gesture && (state.settingsOpen || state.exportOpen)) {
        // A modal owns input, but does not finish an armed tool. Do not
        // publish again for an idle modal inside this synchronous subscriber.
        this.cancelTransformGizmoGesture(undefined, false);
      }
    });
  }
  async setTransformGizmoMode(mode: FilterGizmoMode | null): Promise<boolean> {
    if (mode !== null) {
      this.observeTransformPivot();
      if ((this.transformPivotQuery || this.transformPivotDefaultPending || this.transformPivotRefreshPending) &&
          !await this.synchronizeTransformPivot()) return false;
    }
    if (mode !== null && (!['move', 'rotate', 'scale'].includes(mode) || !this.transformGizmoModeEnabled)) return false;
    const selected = useApp.getState().transformGizmoMode;
    this.cancelTransformGizmoGesture(undefined, true);
    if (mode === null || mode === selected) return this.endTransformSession();
    if (this.opacityOwner && !await this.endOpacitySession()) return false;
    if (this.transformOwner && !await this.endTransformSession()) return false;
    this.observeTransformPivot();
    if ((this.transformPivotQuery || this.transformPivotDefaultPending || this.transformPivotRefreshPending) && !await this.synchronizeTransformPivot()) return false;
    if (!await this.beginTransformOwner('gizmo')) return false;
    this.watchTransformGizmo(); this.camera?.clearInput(); setApp({ transformGizmoMode: mode, autoOrbit: false }); return true;
  }
  beginTransformGizmoGesture(): TransformGizmoGestureToken | null {
    const owner = this.transformOwner, mode = useApp.getState().transformGizmoMode, camera = this.camera;
    if (!owner || !mode || !camera || !this.transformGizmoControlsEnabled || this.transformGizmoGesture || !owner.metadata || !owner.renderer || !owner.widgetMatrix) return null;
    const viewport = this.transformGizmoViewport(owner.renderer);
    if (!viewport) return null;
    const token = Object.freeze({ id: ++this.transformGizmoSequence, mode });
    // Capture both presence and absence of the physical press view. Neither a
    // later camera nor a queued profile change can substitute a new target.
    const selectedOnly = (useApp.getState().summary?.selected ?? 0) > 0, view = selectedOnly ? this.captureSelectionView() : null;
    const gesture: TransformGizmoGesture = { token, owner, metadata: owner.metadata, revision: { ...owner.client.revision }, camera,
      cameraRevision: camera.revision, deviceEpoch: owner.renderer.deviceEpoch, width: owner.renderer.canvas.width,
      height: owner.renderer.canvas.height, viewport, desiredRevision: owner.desiredRevision, ready: false,
      widgetMatrix: [...owner.widgetMatrix] as TransformMatrix };
    this.transformGizmoGesture = gesture;
    this.watchTransformGizmo(); camera.clearInput(); setApp({ transformGizmoDragging: true, autoOrbit: false });
    owner.phase = 'preparing'; this.publishTransform(owner);
    gesture.preparing = this.trackTransformTask(owner, async () => {
      const epoch = owner.nextEpoch++;
      const command: SceneCommand = { command: 'rebaseTransform', id: gesture.metadata.id, epoch, selectedOnly,
        ...(view ? { selectionView: view } : {}) };
      if (!await this.executeEditCommand(command, () => this.transformCurrent(owner) && !owner.cancelRequested) || !this.transformScopeCurrent(owner)) return false;
      const metadata = validateTransformSummary(useApp.getState().summary?.transformSession);
      if (!metadata || metadata.kind !== 'gizmo' || metadata.id !== gesture.metadata.id || metadata.epoch !== epoch || metadata.appliedEpoch !== null || metadata.selectedOnly !== selectedOnly) {
        this.requireTransformCleanup(owner); return false;
      }
      owner.metadata = metadata; owner.selectedOnly = metadata.selectedOnly; owner.phase = 'ready';
      if (this.transformGizmoGesture === gesture) {
        gesture.metadata = metadata; gesture.revision = { ...owner.client.revision }; gesture.ready = true;
      }
      this.refreshTransformPreview(owner); return true;
    });
    void gesture.preparing.then(accepted => { if (!accepted && this.transformGizmoGesture === gesture) this.cancelTransformGizmoGesture(token, false); });
    return token;
  }
  private rebuildTransformGizmoWidget(owner: TransformOwner) {
    if (!owner.metadata) return false;
    const defaults = transformDefaults();
    defaults.translation = this.transformHasPivotReference() ? [...owner.parameters.pivot] : [...owner.metadata.pivot];
    const composed = this.camera?.composeTransform(transformWireParameters(defaults)!);
    owner.widgetMatrix = composed ? validateTransformMatrix(composed.matrix) ?? undefined : undefined;
    return !!owner.widgetMatrix;
  }
  get transformGizmoActionsVisible() {
    const state = useApp.getState(), owner = this.transformOwner;
    return !!owner && owner.kind === 'gizmo' && !!state.transformGizmoMode && state.toolsOpen && state.ready && this.transformScopeCurrent(owner) &&
      !!this.renderer && !this.renderer.lost && !this.recovery && !this.destroyed && !this.closing && !this.closeRequest;
  }
  private get transformGizmoActionReady() {
    const state = useApp.getState(), owner = this.transformOwner;
    return this.transformGizmoActionsVisible && !!owner?.metadata && !this.transformGizmoActionOwner && !this.selectionAction &&
      !this.transformPivotQuery && !state.settingsOpen && !state.exportOpen && !state.outputPending &&
      !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length &&
      !this.operationRecoveryBlocked && !this.editingFailed && !state.navigationPrompt && !owner.ending && owner.phase !== 'required';
  }
  get transformGizmoFinishEnabled() {
    const owner = this.transformOwner;
    return this.transformGizmoActionReady && !!owner && !owner.task && owner.phase === 'ready' && !this.transformGizmoGesture && !useApp.getState().busy;
  }
  private transformGizmoHistoryEnabled(direction: 'undo' | 'redo') {
    const owner = this.transformOwner;
    return this.transformGizmoFinishEnabled && !!owner?.metadata?.gizmo?.[direction === 'undo' ? 'canUndo' : 'canRedo'];
  }
  get transformGizmoUndoEnabled() { return !!this.transformGizmoGesture && this.transformGizmoActionReady || this.transformGizmoHistoryEnabled('undo'); }
  get transformGizmoCancelEnabled() { return this.transformGizmoActionReady; }
  /** Single source/owner-fenced lane for floating and admitted keyboard work. */
  private runTransformGizmoAction(owner: TransformOwner, run: () => Promise<boolean>): Promise<boolean> {
    if (this.transformGizmoActionOwner || this.selectionAction || !this.transformScopeCurrent(owner)) return Promise.resolve(false);
    this.transformGizmoActionOwner = owner; this.selectionBarriers++; this.publishTransform(owner);
    const task = Promise.resolve().then(() => this.transformScopeCurrent(owner) && !this.destroyed && !this.closing && !this.closeRequest && !this.recovery ? run() : false)
      .catch(error => { if (this.transformScopeCurrent(owner)) { this.error(error); if (this.editingFailed) this.requireTransformCleanup(owner); } return false; })
      .finally(() => {
        if (this.transformGizmoActionOwner === owner) this.transformGizmoActionOwner = undefined;
        this.transformTasks.delete(task); this.releaseSelectionBarrier(); this.publishTransform(owner);
      });
    this.transformTasks.add(task); return task;
  }
  finishTransformGizmo(): Promise<boolean> {
    if (!this.transformGizmoFinishEnabled) return Promise.resolve(false);
    const owner = this.transformOwner!;
    return this.runTransformGizmoAction(owner, () => this.endTransformSession());
  }
  undoTransformGizmo(): Promise<boolean> {
    const owner = this.transformOwner, unfinished = this.transformGizmoGesture;
    if (!owner || owner.kind !== 'gizmo' || !this.transformGizmoActionReady) return Promise.resolve(false);
    // Capture this priority synchronously: App retires its camera/pointer
    // capture immediately after admission, before this async lane runs.
    if (unfinished) {
      const preparing = unfinished.preparing;
      this.cancelTransformGizmoGesture(unfinished.token, false);
      return this.runTransformGizmoAction(owner, async () => { await preparing; return this.transformScopeCurrent(owner) && owner.phase !== 'required'; });
    }
    return this.moveTransformGizmoHistory('undo');
  }
  private moveTransformGizmoHistory(direction: 'undo' | 'redo'): Promise<boolean> {
    if (!this.transformGizmoHistoryEnabled(direction)) return Promise.resolve(false);
    const owner = this.transformOwner!;
    return this.runTransformGizmoAction(owner, () => this.trackTransformTask(owner, async () => {
      if (!this.transformCurrent(owner) || !owner.metadata) return false;
      const id = owner.metadata.id, epoch = owner.nextEpoch++;
      owner.phase = 'applying'; this.publishTransform(owner);
      if (!await this.executeEditCommand({ command: direction === 'undo' ? 'undoTransform' : 'redoTransform', id, epoch }, () => this.transformCurrent(owner))) return false;
      const metadata = validateTransformSummary(useApp.getState().summary?.transformSession);
      if (!metadata || metadata.kind !== 'gizmo' || metadata.id !== id || metadata.epoch !== epoch || metadata.appliedEpoch !== null) {
        this.requireTransformCleanup(owner); return false;
      }
      owner.metadata = metadata; owner.selectedOnly = metadata.selectedOnly; owner.desiredRevision++; owner.appliedRevision = owner.desiredRevision;
      owner.phase = 'ready'; this.rebuildTransformGizmoWidget(owner); this.refreshTransformPreview(owner); return true;
    }));
  }
  cancelTransformGizmo(): Promise<boolean> {
    if (!this.transformGizmoCancelEnabled) return Promise.resolve(false);
    return this.cancelGizmoOwner(this.transformOwner!);
  }
  private cancelGizmoOwner(owner: TransformOwner): Promise<boolean> {
    this.cancelTransformGizmoGesture(undefined, false); owner.applyRequested = false;
    if (owner.task) { owner.cancelRequested = true; this.cancelEdit(); }
    return this.runTransformGizmoAction(owner, async () => {
      await owner.task;
      if (!this.transformScopeCurrent(owner) || owner.phase === 'required' || this.editingFailed) return false;
      owner.cancelRequested = false;
      const metadata = validateTransformSummary(useApp.getState().summary?.transformSession);
      if (!metadata || metadata.id !== owner.metadata?.id || metadata.kind !== 'gizmo') { this.requireTransformCleanup(owner); return false; }
      owner.metadata = metadata; owner.nextEpoch = Math.max(owner.nextEpoch, metadata.epoch + 1);
      const epoch = owner.nextEpoch++; owner.phase = 'ending'; this.publishTransform(owner);
      if (!await this.executeEditCommand({ command: 'cancelTransform', id: metadata.id, epoch }, () => this.transformScopeCurrent(owner)) || !this.transformScopeCurrent(owner)) return false;
      if (useApp.getState().summary?.transformSession !== null) { this.requireTransformCleanup(owner); return false; }
      this.retireTransform(owner); return true;
    });
  }
  private transformGizmoViewport(renderer: SceneRenderer): TransformGizmoGesture['viewport'] | null {
    try {
      const rect = renderer.canvas.getBoundingClientRect(), dpr = Math.min(typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1, 2);
      if (![rect.x, rect.y, rect.width, rect.height, dpr].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || dpr <= 0) return null;
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, dpr };
    } catch { return null; }
  }
  private transformGizmoCurrent(gesture: TransformGizmoGesture) {
    const owner = gesture.owner, renderer = owner.renderer, state = useApp.getState(), parameters = transformUiParameters(state.transformParameters);
    const viewport = renderer && this.transformGizmoViewport(renderer);
    return this.transformScopeCurrent(owner) && !owner.cancelRequested && !this.transformGizmoActionOwner &&
      state.ready && !state.settingsOpen && !state.exportOpen && !this.recovery && state.transformGizmoMode === gesture.token.mode &&
      !!parameters && sameTransformParameters(parameters, owner.parameters) &&
      (!gesture.ready || sameTransformSummary(validateTransformSummary(state.summary?.transformSession), gesture.metadata)) &&
      (!gesture.ready || sameRevision(owner.client.revision, gesture.revision)) && owner.desiredRevision === gesture.desiredRevision && gesture.camera === this.camera &&
      gesture.camera.revision === gesture.cameraRevision && !!renderer && renderer.deviceEpoch === gesture.deviceEpoch &&
      renderer.canvas.width === gesture.width && renderer.canvas.height === gesture.height && !!viewport &&
      viewport.x === gesture.viewport.x && viewport.y === gesture.viewport.y && viewport.width === gesture.viewport.width &&
      viewport.height === gesture.viewport.height && viewport.dpr === gesture.viewport.dpr;
  }
  updateTransformGizmoGesture(token: TransformGizmoGestureToken, pose: TransformGizmoPose): boolean {
    const gesture = this.transformGizmoGesture;
    if (!gesture || gesture.token !== token) return false;
    if (!this.transformGizmoCurrent(gesture)) { this.cancelTransformGizmoGesture(token, true); return false; }
    const widgetMatrix = validateTransformMatrix(pose.widgetMatrix), deltaMatrix = validateTransformMatrix(pose.deltaMatrix),
      definition = validateTransformDefinition({ mode: 'matrix', matrix: pose.rowMajorDelta,
        pivot: this.transformHasPivotReference() ? gesture.owner.parameters.pivot : gesture.metadata.pivot, flips: [false, false, false] });
    if (!widgetMatrix || !deltaMatrix || !definition || !this.camera?.composeTransform(definition)) return false;
    gesture.pose = { widgetMatrix, deltaMatrix, rowMajorDelta: [...pose.rowMajorDelta] } as TransformGizmoPose;
    gesture.owner.widgetMatrix = widgetMatrix; gesture.owner.desiredRevision++; gesture.desiredRevision = gesture.owner.desiredRevision;
    this.refreshTransformPreview(gesture.owner); return true;
  }
  async finishTransformGizmoGesture(token: TransformGizmoGestureToken): Promise<boolean> {
    const gesture = this.transformGizmoGesture;
    if (!gesture || gesture.token !== token) return false;
    if (gesture.preparing && !await gesture.preparing || this.transformGizmoGesture !== gesture || !gesture.ready || !this.transformGizmoCurrent(gesture)) {
      this.cancelTransformGizmoGesture(token, true); return false;
    }
    if (!gesture.pose) { this.transformGizmoGesture = undefined; setApp({ transformGizmoDragging: false }); return true; }
    const definition = validateTransformDefinition({ mode: 'matrix', matrix: gesture.pose.rowMajorDelta,
      pivot: this.transformHasPivotReference() ? gesture.owner.parameters.pivot : gesture.metadata.pivot, flips: [false, false, false] });
    if (!definition) { this.cancelTransformGizmoGesture(token, true); return false; }
    const owner = gesture.owner;
    if (definition.mode === 'matrix' && definition.matrix.every((value, index) => value === (index % 5 === 0 ? 1 : 0))) {
      this.transformGizmoGesture = undefined; owner.appliedRevision = owner.desiredRevision;
      this.rebuildTransformGizmoWidget(owner); setApp({ transformGizmoDragging: false }); this.refreshTransformPreview(owner); return true;
    }
    this.transformGizmoGesture = undefined; setApp({ transformGizmoDragging: false }); owner.applyRequested = true;
    const applied = await this.trackTransformTask(owner, () => this.runTransformRequests(owner, definition));
    if (!applied) {
      if (this.transformOwner === owner && !owner.cancelRequested) {
        this.rebuildTransformGizmoWidget(owner); this.refreshTransformPreview(owner);
      }
      return false;
    }
    return this.transformScopeCurrent(owner);
  }
  cancelTransformGizmoGesture(token?: TransformGizmoGestureToken, deactivate = false): boolean {
    const gesture = this.transformGizmoGesture;
    if (token && (!gesture || gesture.token !== token)) return false;
    this.transformGizmoGesture = undefined;
    if (deactivate) { this.transformGizmoUnsubscribe?.(); this.transformGizmoUnsubscribe = undefined; }
    let restored = !gesture;
    if (gesture && this.transformScopeCurrent(gesture.owner)) {
      const owner = gesture.owner; owner.desiredRevision++; owner.appliedRevision = owner.desiredRevision;
      owner.widgetMatrix = [...gesture.widgetMatrix] as TransformMatrix;
      this.refreshTransformPreview(owner); restored = true;
    }
    if (!this.destroyed) setApp({ transformGizmoDragging: false, ...(deactivate ? { transformGizmoMode: null } : {}) });
    return restored;
  }
  private filterBaseAvailable() {
    const state = useApp.getState();
    return !!this.client && this.scene?.kind === 'gaussian' && state.summary?.kind === 0 && !!this.renderer && !this.renderer.lost &&
      !this.operationRecoveryBlocked && !this.editingFailed && !this.destroyed && !this.recovery && !this.closing && !this.closeRequest &&
      !state.navigationPrompt && !this.selectionCleanupOwner && !this.colorBoundary && this.ledger.overageBytes === 0;
  }
  private filterCurrent(owner: FilterOwner) {
    return this.filterOwner === owner && owner.client === this.client && owner.documentId === this.client.revision.documentId &&
      owner.sourceGeneration === this.client.revision.sourceGeneration && owner.generation === this.generation &&
      (!owner.scene || owner.scene === this.scene) && (!owner.renderer || owner.renderer === this.renderer) &&
      this.filterBaseAvailable();
  }
  private publishFilter(owner: FilterOwner) {
    if (this.filterOwner !== owner || this.destroyed) return;
    setApp({ filter: { kind: owner.kind, phase: owner.phase, parameters: owner.parameters, operation: owner.operation,
      dirty: owner.previewRevision !== owner.desiredRevision, desiredRevision: owner.desiredRevision,
      previewRevision: owner.previewRevision, id: owner.id ?? null } });
  }
  private retireFilter(owner: FilterOwner) {
    if (this.filterOwner !== owner) return;
    this.cancelFilterGizmoGesture(undefined, true);
    this.filterOwner = undefined;
    if (!this.destroyed) setApp({ filter: null, filterCenterPicking: false, filterCenterPending: false,
      ...(!this.selectionCleanupOwner ? { selectionRecovery: 'idle' as const } : {}),
      ...(owner.error && useApp.getState().error === owner.error ? { error: null } : {}) });
  }
  private requireFilterCleanup(owner: FilterOwner) {
    if (this.filterOwner !== owner || this.destroyed) return;
    this.cancelFilterGizmoGesture(undefined, true);
    owner.phase = 'required';
    owner.error = useApp.getState().error ?? 'The filter baseline could not be restored. Choose Restore selection or retry graphics.';
    this.publishFilter(owner);
    setApp({ selectionRecovery: 'required', selectionDragging: false, selectionOperation: null, error: owner.error });
  }
  private trackFilterTask(owner: FilterOwner, run: () => Promise<boolean>): Promise<boolean> {
    const task = Promise.resolve().then(run).catch(error => {
      this.error(error); if (this.editingFailed) this.requireFilterCleanup(owner); return false;
    }).finally(() => {
      if (owner.task === task) owner.task = undefined;
      this.filterTasks.delete(task);
      if (this.filterOwner === owner && !owner.cancelRequested && owner.phase !== 'required') {
        owner.phase = 'ready'; this.publishFilter(owner);
      }
    });
    owner.task = task; this.filterTasks.add(task); return task;
  }
  get filterActive() { return !!this.filterOwner; }
  get filterControlsEnabled() {
    const owner = this.filterOwner, state = useApp.getState();
    return !this.selectionAction && !!owner && this.filterCurrent(owner) && state.mode === 'pro' &&
      (owner.phase === 'ready' || owner.phase === 'previewing') && !owner.cancelRequested &&
      (!state.busy || owner.phase === 'previewing' && !!owner.task) && !state.settingsOpen && !state.exportOpen &&
      !state.outputPending && !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length;
  }
  get filterPreviewEnabled() {
    const state = useApp.getState();
    return this.filterControlsEnabled && !this.filterGizmoGesture && !state.filterCenterPicking && !state.filterCenterPending;
  }
  get filterFinishEnabled() { return this.filterPreviewEnabled; }
  private get filterSelectionActionsReady() {
    const owner = this.filterOwner, state = useApp.getState();
    return !this.selectionAction && !!owner && this.filterCurrent(owner) && !owner.cancellation && !owner.cancelRequested &&
      ['preparing', 'ready', 'previewing'].includes(owner.phase) && !this.filterGizmoGesture && !state.filterCenterPicking && !state.filterCenterPending &&
      !state.settingsOpen && !state.exportOpen && !state.outputPending && !state.viewTransferPending && !state.thumbnailPending &&
      !state.savedViewChoices.length;
  }
  get filterUndoEnabled() {
    const state = useApp.getState();
    return this.filterSelectionActionsReady && (!!this.filterOwner?.task || !!state.summary?.filter?.changed || !!state.summary?.canUndo);
  }
  get filterClearEnabled() {
    return this.filterSelectionActionsReady;
  }
  get filterCancelEnabled() { return !!this.filterOwner && !this.destroyed && !this.closing && !this.recovery && !this.filterOwner.cancellation; }
  get filterPreviewPending() { return !!this.filterOwner?.task || !!this.filterOwner?.cancellation; }
  get filterGizmoGestureActive() { return !!this.filterGizmoGesture; }
  get filterGizmoModeEnabled() {
    const owner = this.filterOwner, state = useApp.getState(), metadata = state.summary?.filter;
    return !!owner && this.filterControlsEnabled && state.toolsOpen && state.ready && state.rendererState === 'ready' &&
      owner.phase === 'ready' && owner.id !== undefined && !!metadata && metadata.id === owner.id && metadata.kind === owner.kind &&
      !state.summary?.pending && !state.summary?.transaction && !state.busy && !this.editOperation && !owner.task && !owner.cancellation &&
      !owner.centerTask && !state.filterCenterPending &&
      ['sphere', 'box', 'ellipsoid', 'frustum'].includes(owner.kind);
  }
  get filterGizmoControlsEnabled() { return this.filterGizmoModeEnabled && !useApp.getState().filterCenterPicking; }
  private filterGizmoScopeCurrent(gesture: FilterGizmoGesture) {
    const owner = gesture.owner;
    return this.filterOwner === owner && owner.client === this.client && owner.id === gesture.id && owner.kind === gesture.kind &&
      owner.documentId === owner.client.revision.documentId && owner.sourceGeneration === owner.client.revision.sourceGeneration &&
      owner.generation === this.generation && (!owner.scene || owner.scene === this.scene) && (!owner.renderer || owner.renderer === this.renderer);
  }
  private watchFilterGizmo() {
    if (this.filterGizmoUnsubscribe) return;
    const watchedOwner = this.filterOwner;
    this.filterGizmoUnsubscribe = useApp.subscribe(state => {
      const owner = this.filterOwner, metadata = state.summary?.filter;
      if (!state.toolsOpen || state.mode !== 'pro' || !state.ready || state.rendererState !== 'ready' || !owner ||
        owner !== watchedOwner || !this.filterCurrent(owner) || !metadata || metadata.id !== owner.id || metadata.kind !== owner.kind ||
        !['ready', 'previewing'].includes(owner.phase) || owner.cancelRequested || state.filterCenterPicking ||
        state.settingsOpen || state.exportOpen || state.navigationPrompt || state.selectionRecovery !== 'idle' ||
        this.filterGizmoGesture && (!this.filterGizmoScopeCurrent(this.filterGizmoGesture) ||
          state.filterGizmoMode !== this.filterGizmoGesture.token.mode)) this.cancelFilterGizmoGesture(undefined, true);
      else if (this.filterGizmoGesture && !this.filterGizmoControlsEnabled) this.cancelFilterGizmoGesture();
    });
  }
  setFilterGizmoMode(mode: FilterGizmoMode | null): boolean {
    if (mode !== null && (!['move', 'rotate', 'scale'].includes(mode) || !this.filterGizmoModeEnabled ||
      mode === 'scale' && this.filterOwner?.kind === 'frustum')) return false;
    if (mode !== null && useApp.getState().filterCenterPicking) this.cancelFilterCenterPick();
    if (mode !== null && !this.filterGizmoControlsEnabled) return false;
    const selected = useApp.getState().filterGizmoMode;
    this.cancelFilterGizmoGesture();
    const next = mode === selected ? null : mode;
    if (next === null) { this.filterGizmoUnsubscribe?.(); this.filterGizmoUnsubscribe = undefined; }
    else this.watchFilterGizmo();
    this.camera?.clearInput(); setApp({ filterGizmoMode: next, filterGizmoDragging: false, ...(next ? { autoOrbit: false } : {}) });
    this.invalidate(); return true;
  }
  beginFilterGizmoGesture(): FilterGizmoGestureToken | null {
    const owner = this.filterOwner, mode = useApp.getState().filterGizmoMode;
    if (!owner || !mode || !this.filterGizmoControlsEnabled || this.filterGizmoGesture || mode === 'scale' && owner.kind === 'frustum') return null;
    const parameters = filterUiParameters(owner.parameters), metadata = validateFilterSummary(useApp.getState().summary?.filter);
    if (!parameters || !filterWireParameters(owner.kind, parameters) || !metadata || metadata.id !== owner.id || metadata.kind !== owner.kind) return null;
    const token = Object.freeze({ id: ++this.filterGizmoSequence, mode });
    this.filterGizmoGesture = { token, owner, id: metadata.id, kind: owner.kind, pose: filterPose(parameters),
      originalParameters: parameters, lastParameters: filterUiParameters(parameters)!, operation: owner.operation,
      clean: owner.previewRevision === owner.desiredRevision, previewRevision: owner.previewRevision, previewEpoch: owner.previewEpoch,
      candidate: { ...metadata }, nativeRevision: { ...owner.client.revision },
      expectedDesiredRevision: owner.desiredRevision, expectedParameterRevision: owner.parameterRevision, lastUpdateRevision: owner.desiredRevision };
    this.watchFilterGizmo(); this.camera?.clearInput(); setApp({ filterGizmoDragging: true, autoOrbit: false }); return token;
  }
  updateFilterGizmoGesture(token: FilterGizmoGestureToken, patch: Partial<FilterGizmoPose>): boolean {
    const gesture = this.filterGizmoGesture, owner = gesture?.owner;
    if (!gesture || gesture.token !== token || !owner || !this.filterGizmoCandidateCurrent(gesture) || !patch || typeof patch !== 'object' ||
      Reflect.ownKeys(patch).some(key => !['center', 'rotation', 'size', 'radius'].includes(key as string))) return false;
    const parameters = patchFilterUiParameters(owner.parameters, patch);
    if (!parameters || !filterWireParameters(owner.kind, parameters)) return false;
    this.writeFilterParameters(owner, parameters, gesture);
    gesture.lastUpdateRevision = owner.desiredRevision;
    return true;
  }
  private filterGizmoCandidateCurrent(gesture: FilterGizmoGesture) {
    const owner = gesture.owner, state = useApp.getState(), parameters = filterUiParameters(owner.parameters),
      persisted = filterUiParameters(state.filterParameters), published = filterUiParameters(state.filter?.parameters);
    return this.filterGizmoScopeCurrent(gesture) && this.filterGizmoControlsEnabled && state.filterGizmoMode === gesture.token.mode &&
      owner.desiredRevision === gesture.expectedDesiredRevision && owner.parameterRevision === gesture.expectedParameterRevision &&
      sameRevision(gesture.nativeRevision, owner.client.revision) && sameFilter(state.summary?.filter ?? null, gesture.candidate) &&
      !!parameters && !!persisted && !!published && sameFilterParameters(parameters, gesture.lastParameters) &&
      sameFilterParameters(persisted, gesture.lastParameters) && sameFilterParameters(published, gesture.lastParameters);
  }
  finishFilterGizmoGesture(token: FilterGizmoGestureToken): boolean {
    const gesture = this.filterGizmoGesture;
    if (!gesture || gesture.token !== token) return false;
    if (!this.filterGizmoCandidateCurrent(gesture) || gesture.owner.desiredRevision !== gesture.lastUpdateRevision) {
      this.cancelFilterGizmoGesture(token); return false;
    }
    this.filterGizmoGesture = undefined; setApp({ filterGizmoDragging: false }); this.invalidate(); return true;
  }
  cancelFilterGizmoGesture(token?: FilterGizmoGestureToken, deactivate = false): boolean {
    const gesture = this.filterGizmoGesture;
    if (token && (!gesture || gesture.token !== token)) return false;
    this.filterGizmoGesture = undefined;
    // Unsubscribe before publishing: a transition listener must not recursively
    // settle the same gesture while its pose restoration is being published.
    if (deactivate) { this.filterGizmoUnsubscribe?.(); this.filterGizmoUnsubscribe = undefined; }
    let restored = false;
    if (gesture && this.filterGizmoScopeCurrent(gesture)) {
      const owner = gesture.owner, state = useApp.getState(), current = filterUiParameters(owner.parameters),
        persisted = filterUiParameters(state.filterParameters), published = filterUiParameters(state.filter?.parameters);
      const candidate = state.summary?.filter ?? null;
      const ownWrites = current && persisted && published && owner.parameterRevision === gesture.expectedParameterRevision &&
        owner.desiredRevision === gesture.expectedDesiredRevision && sameFilterParameters(current, gesture.lastParameters) &&
        sameFilterParameters(persisted, gesture.lastParameters) && sameFilterParameters(published, gesture.lastParameters);
      const parameters = current && patchFilterUiParameters(current, gesture.pose);
      if (parameters) {
        const clean = gesture.clean && ownWrites && sameFilter(candidate, gesture.candidate) &&
          sameRevision(gesture.nativeRevision, owner.client.revision) && owner.previewRevision === gesture.previewRevision &&
          owner.previewEpoch === gesture.previewEpoch && owner.operation === gesture.operation &&
          sameFilterParameters(parameters, gesture.originalParameters);
        if (!sameFilterParameters(parameters, owner.parameters)) { owner.parameters = parameters; owner.parameterRevision++; owner.desiredRevision++; }
        if (clean) owner.previewRevision = owner.desiredRevision;
        else if (owner.previewRevision === owner.desiredRevision) owner.desiredRevision++;
        setApp({ filterParameters: owner.parameters }); this.publishFilter(owner); restored = true;
      }
    }
    if (!this.destroyed) setApp({ filterGizmoDragging: false, ...(deactivate ? { filterGizmoMode: null } : {}) });
    if (gesture || deactivate) this.invalidate();
    return !gesture || restored;
  }
  async selectFilter(kind: SelectionFilterKind, initialPreview = true, action?: object): Promise<boolean> {
    if (this.selectionAction && action !== this.selectionAction) return false;
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return false;
    if (this.transformOwner && !await this.endTransformSession()) return false;
    if (!['sphere', 'box', 'ellipsoid', 'frustum', 'opacity', 'scale'].includes(kind)) return false;
    const existing = this.filterOwner;
    if (existing?.kind === kind && !existing.cancelRequested && existing.phase !== 'required') return true;
    if (existing && !await this.cancelFilter()) return false;
    const state = useApp.getState();
    if (!this.filterBaseAvailable() || !state.ready || state.mode !== 'pro' || state.busy || this.editOperation || this.exporting ||
      this.selectionBarriers !== Number(!!action && action === this.selectionAction) || state.outputPending || state.exportOpen || state.settingsOpen || state.viewTransferPending ||
      state.thumbnailPending || state.savedViewChoices.length || state.selectionRecovery !== 'idle') return false;
    const parameters = filterUiParameters(state.filterParameters);
    if (!parameters) return false;
    const client = this.client!;
    const owner: FilterOwner = { client, documentId: client.revision.documentId, sourceGeneration: client.revision.sourceGeneration,
      generation: this.generation, kind, nextEpoch: 1, parameters, operation: state.operation, desiredRevision: 0, parameterRevision: 0,
      viewRevision: this.selectionViewRevision(),
      previewRevision: null, previewEpoch: null, phase: 'preparing', previewRequested: initialPreview, confirmRequested: false, cancelRequested: false };
    this.filterOwner = owner; this.publishFilter(owner); this.selectionBarriers++;
    setApp({ filterParameters: parameters });
    return this.trackFilterTask(owner, async () => {
      try {
        this.cancelAlignment(); await this.floorCleanup;
        await this.closeToleranceSelection();
        if (owner.cancelRequested || !this.filterCurrent(owner) || !await this.cancelSelectionGesture() ||
          !await this.settleColorSession() || owner.cancelRequested || !this.filterCurrent(owner)) return false;
        owner.scene = this.scene as GaussianScene; owner.renderer = this.renderer;
        this.camera?.clearInput(); setApp({ tool: null, fly: false, autoOrbit: false });
        const started = await this.executeEditCommand({ command: 'beginFilter', kind }, () => this.filterCurrent(owner) && !owner.cancelRequested);
        if (started !== true) {
          if (this.editingFailed) this.requireFilterCleanup(owner);
          else if ((useApp.getState().summary?.filter ?? null) === null) this.retireFilter(owner);
          return false;
        }
        const metadata = validateFilterSummary(useApp.getState().summary?.filter);
        if (!metadata || metadata.kind !== kind || metadata.epoch !== 0 || metadata.previewEpoch !== null) {
          this.requireFilterCleanup(owner); return false;
        }
        owner.id = metadata.id; owner.phase = 'ready'; this.publishFilter(owner);
        return await this.runFilterRequests(owner);
      } finally {
        this.releaseSelectionBarrier();
        if (this.filterOwner === owner && owner.id === undefined && !this.editingFailed && !owner.cancelRequested) this.retireFilter(owner);
      }
    });
  }
  setFilterParameters(patch: Partial<SelectionFilterParameters>) {
    const owner = this.filterOwner;
    if (!owner || !this.filterControlsEnabled) return;
    const parameters = patchFilterUiParameters(owner.parameters, patch);
    if (parameters) this.writeFilterParameters(owner, parameters);
  }
  private writeFilterParameters(owner: FilterOwner, parameters: SelectionFilterParameters, gesture?: FilterGizmoGesture) {
    if (sameFilterParameters(parameters, owner.parameters)) return;
    owner.parameters = parameters; owner.desiredRevision++; owner.parameterRevision++;
    if (gesture) {
      gesture.expectedDesiredRevision = owner.desiredRevision; gesture.expectedParameterRevision = owner.parameterRevision;
      gesture.lastParameters = filterUiParameters(parameters)!;
    }
    setApp({ filterParameters: parameters, ...(owner.validationError && useApp.getState().error === owner.validationError &&
      filterWireParameters(owner.kind, parameters) ? { error: null } : {}) });
    this.publishFilter(owner); this.invalidate();
  }
  setFilterOperation(operation: number) {
    const owner = this.filterOwner;
    if (!owner || !this.filterControlsEnabled || !Number.isInteger(operation) || operation < 0 || operation > 3 || owner.operation === operation) return;
    const gesture = this.filterGizmoGesture;
    if (gesture?.owner === owner && gesture.expectedDesiredRevision === owner.desiredRevision)
      gesture.expectedDesiredRevision = owner.desiredRevision + 1;
    owner.operation = operation; owner.desiredRevision++; setSelectionPreferences({ operation }); this.publishFilter(owner);
  }
  resetFilter() {
    const owner = this.filterOwner;
    if (!owner || !this.filterControlsEnabled) return;
    this.cancelFilterGizmoGesture(undefined, true);
    this.cancelFilterCenterPick();
    const defaults = filterDefaults();
    const patch: Partial<SelectionFilterParameters> = owner.kind === 'opacity' ? { minOpacity: defaults.minOpacity, maxOpacity: defaults.maxOpacity } :
      owner.kind === 'scale' ? { minScale: defaults.minScale, maxScale: defaults.maxScale } :
      { center: defaults.center, size: defaults.size, rotation: defaults.rotation, radius: defaults.radius };
    this.setFilterParameters(patch);
    if (owner.kind === 'frustum') this.useFilterCurrentView();
  }
  useFilterCurrentView(): boolean {
    if (!this.filterControlsEnabled || this.filterOwner?.kind !== 'frustum' || !this.camera) return false;
    try { this.setFilterParameters(this.camera.filterView()); return true; }
    catch (error) { this.error(error); return false; }
  }
  startFilterCenterPick(): boolean {
    const owner = this.filterOwner;
    if (!owner || !this.filterControlsEnabled || owner.task || !this.camera || !['sphere', 'box', 'ellipsoid', 'frustum'].includes(owner.kind)) return false;
    this.cancelFilterGizmoGesture(undefined, true);
    owner.centerPick = undefined; this.camera.clearInput(); setApp({ filterCenterPicking: true, filterCenterPending: false, autoOrbit: false }); return true;
  }
  cancelFilterCenterPick() {
    if (this.filterOwner) this.filterOwner.centerPick = undefined;
    if (!this.destroyed) setApp({ filterCenterPicking: false, filterCenterPending: false });
  }
  async rightClickFilter(clear = (useApp.getState().summary?.selected ?? 0) > 0): Promise<boolean> {
    const owner = this.filterOwner;
    if (!owner) return false;
    if (useApp.getState().filterCenterPicking) { this.cancelFilterCenterPick(); return true; }
    const kind = owner.kind;
    if (!await this.cancelFilter() || !await this.command({ command: 'selectNone' })) return false;
    // Capture02 cancels the old draft, clears its restored baseline, then
    // starts a fresh empty draft only when the press captured highlights.
    // Explicit Preview policy leaves this fresh baseline empty until asked.
    return clear ? this.selectFilter(kind, false) : true;
  }
  pickFilterCenter(x: number, y: number): Promise<boolean> {
    const owner = this.filterOwner, camera = this.camera;
    if (!owner || !camera || !useApp.getState().filterCenterPicking || !this.filterControlsEnabled || owner.task || owner.centerTask ||
      !owner.scene || !owner.renderer || !Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(false);
    const scene = owner.scene, renderer = owner.renderer, token = {}, view = camera.revision,
      revision = { ...owner.client.revision }, desired = owner.desiredRevision, epoch = renderer.deviceEpoch,
      width = renderer.canvas.width, height = renderer.canvas.height;
    owner.centerPick = token; setApp({ filterCenterPending: true });
    const current = () => this.filterCurrent(owner) && owner.centerPick === token && useApp.getState().filterCenterPicking &&
      this.camera === camera && camera.revision === view && renderer.deviceEpoch === epoch && renderer.canvas.width === width &&
      renderer.canvas.height === height && sameRevision(revision, owner.client.revision) && owner.desiredRevision === desired &&
      !owner.task && !useApp.getState().busy && !owner.cancelRequested;
    const task = (async () => {
      try {
        owner.client.assertNativeAdmission();
        const pendingRender = renderer.render(scene, camera, useApp.getState().grade, true, IDENTITY_MATRIX, this.colorScope);
        if (pendingRender) await pendingRender;
        const radius = 8 * width / Math.max(1, renderer.canvas.getBoundingClientRect().width);
        const hit = await renderer.pick(scene, x, y, radius);
        if (!current() || hit.deviceEpoch !== epoch || hit.index === null) return false;
        const result = await owner.client.command({ command: 'point', index: hit.index });
        if (!current() || !Array.isArray(result.point) || result.point.length !== 3 ||
          result.point.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value)))) return false;
        this.setFilterParameters({ center: result.point.map(Math.fround) as [number, number, number] });
        this.cancelFilterCenterPick(); return true;
      } catch (error) { if (!(error instanceof StaleRenderQueryError) && current()) this.error(error); return false; }
      finally {
        if (owner.centerPick === token) { owner.centerPick = undefined; if (!this.destroyed) setApp({ filterCenterPending: false }); }
      }
    })().finally(() => { if (owner.centerTask === task) owner.centerTask = undefined; this.filterTasks.delete(task); });
    owner.centerTask = task; this.filterTasks.add(task); return task;
  }
  async activateSelectionTool(tool: SelectionTool | null): Promise<boolean> {
    if (this.selectionAction) return false;
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession(true)) return false;
    if (this.transformOwner && !await this.endTransformSession(true)) return false;
    if (this.filterOwner && !await this.cancelFilter()) return false;
    if (!this.editingAvailable || useApp.getState().busy || this.exporting || this.selectionBarriers) return false;
    this.cancelAlignment(); await this.floorCleanup;
    await this.closeToleranceSelection();
    if (!await this.cancelSelectionGesture() || !this.editingAvailable) return false;
    this.camera?.clearInput(); setApp({ tool, fly: false, autoOrbit: false }); this.invalidate(); return true;
  }
  previewFilter(): Promise<boolean> {
    const owner = this.filterOwner;
    if (!owner || !this.filterPreviewEnabled) return Promise.resolve(false);
    owner.previewRequested = true;
    return owner.task ?? this.trackFilterTask(owner, () => this.runFilterRequests(owner));
  }
  confirmFilter(): Promise<boolean> {
    const owner = this.filterOwner;
    if (!owner || !this.filterFinishEnabled) return Promise.resolve(false);
    owner.confirmRequested = true;
    return owner.task ?? this.trackFilterTask(owner, () => this.runFilterRequests(owner));
  }
  private async runFilterRequests(owner: FilterOwner): Promise<boolean> {
    let accepted = true;
    while (this.filterCurrent(owner) && !owner.cancelRequested && (owner.previewRequested || owner.confirmRequested)) {
      const mustPreview = owner.previewRequested || owner.previewRevision !== owner.desiredRevision;
      owner.previewRequested = false;
      if (mustPreview) {
        const revision = owner.desiredRevision, operation = owner.operation;
        const parameters = filterWireParameters(owner.kind, owner.parameters);
        if (!parameters) {
          owner.previewRequested = false; owner.confirmRequested = false;
          owner.validationError = `The ${owner.kind} filter values are invalid. Correct them before previewing or confirming.`;
          this.error(new Error(owner.validationError)); this.publishFilter(owner); return false;
        }
        if (owner.id === undefined) return false;
        const epoch = owner.nextEpoch++;
        owner.phase = 'previewing'; this.publishFilter(owner);
        accepted = await this.executeEditCommand({ command: 'previewFilter', id: owner.id, epoch, kind: owner.kind, parameters, operation },
          () => this.filterCurrent(owner) && !owner.cancelRequested) === true;
        if (!accepted) {
          owner.previewRequested = false; owner.confirmRequested = false;
          if (this.editingFailed) this.requireFilterCleanup(owner);
          return false;
        }
        const metadata = validateFilterSummary(useApp.getState().summary?.filter);
        if (!metadata || metadata.id !== owner.id || metadata.kind !== owner.kind || metadata.epoch !== epoch || metadata.previewEpoch !== epoch) {
          this.requireFilterCleanup(owner); return false;
        }
        owner.previewRevision = revision; owner.previewEpoch = epoch; owner.phase = 'ready'; this.publishFilter(owner);
      }
      if (owner.cancelRequested) return false;
      if (owner.confirmRequested) {
        // Parameter changes during the held preview are cheap desired state.
        // Confirm samples their latest revision before freezing its publication.
        if (owner.previewRevision !== owner.desiredRevision || owner.previewRequested) continue;
        if (owner.id === undefined || owner.previewEpoch === null) return false;
        this.camera?.clearInput(); setApp({ autoOrbit: false });
        owner.phase = 'confirming'; this.publishFilter(owner);
        accepted = await this.executeEditCommand({ command: 'confirmFilter', id: owner.id, epoch: owner.previewEpoch },
          () => this.filterCurrent(owner) && !owner.cancelRequested) === true;
        owner.confirmRequested = false;
        if (accepted && (useApp.getState().summary?.filter ?? null) === null) this.retireFilter(owner);
        else if (this.editingFailed) this.requireFilterCleanup(owner);
        return accepted;
      }
    }
    return accepted && !owner.cancelRequested;
  }
  cancelFilter(): Promise<boolean> {
    const owner = this.filterOwner;
    if (!owner) return Promise.resolve(true);
    if (owner.cancellation) return owner.cancellation;
    this.cancelFilterGizmoGesture(undefined, true);
    owner.cancelRequested = true; owner.previewRequested = false; owner.confirmRequested = false;
    this.cancelFilterCenterPick();
    owner.phase = 'cancelling'; this.publishFilter(owner);
    if (owner.task) this.cancelEdit();
    const task = (async () => {
      await owner.task;
      await owner.centerTask;
      if (this.filterOwner !== owner) return true;
      if (this.destroyed || owner.client !== this.client || owner.documentId !== this.client.revision.documentId ||
        owner.sourceGeneration !== this.client.revision.sourceGeneration || owner.generation !== this.generation) return false;
      const summary = useApp.getState().summary;
      const metadata = validateFilterSummary(summary?.filter ?? null);
      if (metadata) {
        if (metadata.kind !== owner.kind || owner.id !== undefined && owner.id !== metadata.id) {
          this.requireFilterCleanup(owner); return false;
        }
        owner.id = metadata.id;
      }
      if (owner.id === undefined && !this.editingFailed && summary?.transaction === false && !metadata) {
        this.retireFilter(owner); return true;
      }
      // A native-only restoration (for example graphics recovery) may have
      // succeeded while its GPU publication failed. Rebuild that acknowledged
      // baseline without submitting an already-retired filter ID again.
      const command: SceneCommand = metadata ? { command: 'cancelFilter', id: metadata.id } : { command: 'summary' };
      const restored = await this.executeEditCommand(command, () => this.filterOwner === owner && owner.client === this.client) === true;
      if (restored && selectionRestored(useApp.getState().summary!)) { this.retireFilter(owner); return true; }
      this.requireFilterCleanup(owner); return false;
    })().catch(error => { this.error(error); this.requireFilterCleanup(owner); return false; }).finally(() => {
      if (owner.cancellation === task) owner.cancellation = undefined;
      this.filterTasks.delete(task);
    });
    owner.cancellation = task; this.filterTasks.add(task); return task;
  }
  /** Cancel a changed draft, or undo history after an unchanged draft, then
   * reopen the same enclosure paused. Never evaluate dirty desired values. */
  undoFilterSelection(): Promise<boolean> {
    if (!this.filterUndoEnabled) return Promise.resolve(false);
    return this.runSelectionAction(async (current, token) => {
      const owner = this.filterOwner!;
      const preview = !!owner.task || useApp.getState().summary?.filter?.changed === true;
      if (!await this.cancelFilter() || !current()) return false;
      if (!preview && useApp.getState().summary?.canUndo && !await this.executeCommand({ command: 'undo' }, current)) return false;
      return current() && this.selectFilter(owner.kind, false, token);
    });
  }
  /** Preserve the acknowledged visible draft in history before clearing it.
   * Parameter edits since that preview remain cheap enclosure state. */
  clearFilterSelection(): Promise<boolean> {
    if (!this.filterClearEnabled) return Promise.resolve(false);
    return this.runSelectionAction(async (current, token) => {
      const owner = this.filterOwner!;
      owner.previewRequested = false; owner.confirmRequested = false;
      this.cancelFilterGizmoGesture(undefined, true); this.cancelFilterCenterPick();
      if (owner.task) this.cancelEdit();
      await owner.task; await owner.centerTask;
      if (!current() || this.filterOwner !== owner || !this.filterCurrent(owner)) return false;
      const metadata = validateFilterSummary(useApp.getState().summary?.filter ?? null);
      if (!metadata || metadata.id !== owner.id || metadata.kind !== owner.kind) return false;
      if (metadata.previewEpoch === null) {
        if (!await this.cancelFilter()) return false;
      } else {
        owner.phase = 'confirming'; this.publishFilter(owner);
        if (!await this.executeCommand({ command: 'confirmFilter', id: metadata.id, epoch: metadata.previewEpoch, visiblePreview: true }, current)) return false;
        if (useApp.getState().summary?.filter) { this.requireFilterCleanup(owner); return false; }
        this.retireFilter(owner);
      }
      if (!current() || !await this.executeCommand({ command: 'selectNone' }, current) || !current()) return false;
      return this.selectFilter(owner.kind, false, token);
    });
  }
  private validateOpacityEdit(command: SceneCommand, before: NativeSummary, updated: NativeSummary) {
    const previous = validateOpacitySummary(before.opacitySession), metadata = validateOpacitySummary(updated.opacitySession);
    const scopedBake = previous?.selectedOnly && ['applyOpacity', 'resetOpacity'].includes(command.command);
    const beforeAlignment = validateAlignmentSummary(before.alignment), afterAlignment = validateAlignmentSummary(updated.alignment);
    if (updated.ok !== true || !updated.loaded || updated.kind !== 0 || updated.count !== before.count || updated.sourceCount !== before.sourceCount ||
      updated.shDegree !== before.shDegree || (scopedBake ? command.command === 'resetOpacity' ? updated.selected < 0 || updated.selected > updated.visible : updated.selected > before.selected : updated.selected !== before.selected) || updated.visible !== before.visible || updated.selectionDraft ||
      updated.radius !== before.radius || updated.yUp !== before.yUp || !Array.isArray(updated.center) || updated.center.length !== before.center.length ||
      updated.center.some((value, index) => value !== before.center[index]) || !Array.isArray(updated.camera) || updated.camera.length !== before.camera.length ||
      updated.camera.some((value, index) => value !== before.camera[index]) ||
      updated.filter || updated.transformSession || updated.colorSession || updated.pending || beforeAlignment && (!afterAlignment || !sameAlignmentBranch(beforeAlignment, afterAlignment)))
      throw new Error('The opacity publication did not preserve its captured scene, masks and alignment.');
    if (command.command === 'beginOpacity') {
      if (previous || !metadata || metadata.selectedOnly !== command.selectedOnly || metadata.epoch !== 0 || metadata.appliedEpoch !== null ||
        metadata.appliedScale !== 1 || updated.revision !== before.revision || updated.contentRevision !== before.contentRevision)
        throw new Error('The opacity session did not capture its baseline.');
      if (this.opacityOwner) this.opacityOwner.metadata = metadata;
    } else if (command.command === 'endOpacity') {
      if (!previous || previous.id !== command.id || metadata !== null || updated.revision !== before.revision || updated.contentRevision !== before.contentRevision)
        throw new Error('The opacity session did not end coherently.');
    } else if (!previous || !metadata || previous.id !== command.id || metadata.id !== previous.id || metadata.baseId !== previous.baseId ||
      metadata.selectedOnly !== previous.selectedOnly || metadata.epoch !== command.epoch || metadata.appliedEpoch !== command.epoch ||
      metadata.appliedScale !== (command.command === 'resetOpacity' ? 1 : opacityScale(command.scale)))
      throw new Error('The opacity publication belongs to another owner or definition.');
  }
  private validateTransformEdit(command: SceneCommand, before: NativeSummary, updated: NativeSummary) {
    const previous = validateTransformSummary(before.transformSession), metadata = validateTransformSummary(updated.transformSession);
    const movingHistory = ['undoTransform', 'redoTransform', 'cancelTransform'].includes(command.command);
    const scopedBake = previous?.selectedOnly && ['applyTransform', 'resetTransform'].includes(command.command);
    if (updated.ok !== true || !updated.loaded || updated.kind !== 0 || updated.count !== before.count || updated.sourceCount !== before.sourceCount || updated.shDegree !== before.shDegree ||
      (movingHistory || scopedBake && command.command === 'resetTransform' ? updated.selected < 0 || updated.selected > updated.visible :
        scopedBake ? updated.selected > before.selected : updated.selected !== before.selected) ||
      updated.visible !== before.visible || updated.selectionDraft || updated.filter || updated.colorSession || updated.opacitySession || updated.pending)
      throw new Error('The transform did not preserve its captured scene and masks.');
    assertTransformAcknowledgement(captureTransformCommand(command), captureTransformState(before), updated);
    // Retain the beginning identity before an irreversible commit reply. Other
    // candidate metadata is adopted only after publication or proved recovery.
    if (command.command === 'beginTransform' && this.transformOwner) this.transformOwner.metadata = metadata!;
  }
  private validateFilterEdit(command: SceneCommand, before: NativeSummary, updated: NativeSummary) {
    const metadata = validateFilterSummary(updated.filter);
    if (updated.ok !== true || updated.loaded !== true || updated.kind !== 0 || updated.count !== before.count ||
      updated.sourceCount !== before.sourceCount || updated.shDegree !== before.shDegree || updated.visible !== before.visible ||
      updated.contentRevision !== before.contentRevision || updated.sceneChanged || updated.selectionDraft !== false || updated.pending)
      throw new Error('The filter did not preserve its captured source and completed draft.');
    if (command.command === 'beginFilter') {
      if (!metadata || metadata.kind !== command.kind || metadata.epoch !== 0 || metadata.previewEpoch !== null || before.filter ||
        updated.selected !== before.selected) throw new Error('The filter baseline was not acknowledged.');
      // Retain this ID before the irreversible commit reply. An unknown commit
      // result still needs exact native baseline authority during recovery.
      if (this.filterOwner) this.filterOwner.id = metadata.id;
    } else if (command.command === 'previewFilter') {
      if (!metadata || metadata.id !== command.id || metadata.kind !== command.kind || metadata.epoch !== command.epoch ||
        metadata.previewEpoch !== command.epoch) throw new Error('The filter preview does not match its captured request.');
    } else if (metadata !== null) throw new Error('The filter owner was not retired.');
  }
  async command(command: SceneCommand, deferredPointer?: DeferredColorPointerToken) {
    if (this.selectionAction || this.transformGizmoActionOwner) return false;
    if (this.transformOwner?.kind === 'gizmo') {
      if (command.command === 'undo' && this.transformGizmoGesture) return this.undoTransformGizmo();
      const direction = command.command === 'undo' ? 'undo' : command.command === 'redo' ? 'redo' : null;
      if (direction && this.transformGizmoHistoryEnabled(direction)) return this.moveTransformGizmoHistory(direction);
    }
    const duplicate = command.command === 'duplicate';
    // Capture the camera synchronously with the click. A waiting color boundary
    // must not silently substitute a later camera or cancel an unfinished tool.
    if (duplicate) {
      if (!isDuplicateCommand(command) || !this.duplicateControlsReady()) return false;
      const view = Object.hasOwn(command, 'selectionView') ? validateSelectionView(command.selectionView) : this.captureSelectionView();
      command = view ? { command: 'duplicate', selectionView: view } : { command: 'duplicate' };
      this.camera?.clearInput(); setApp({ autoOrbit: false, fly: false });
    }
    const duplicateClient = duplicate ? this.client : undefined, duplicateGeneration = this.generation;
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked) return false;
    const deferredCurrent = () => !deferredPointer || this.deferredColorPointersCurrent(deferredPointer);
    if (!deferredCurrent()) return false;
    if (command.command !== 'grade' && command.command !== 'autoColor' &&
        !deferredPointer) this.cancelDeferredColorPointers();
    if ((OPACITY_COMMANDS as readonly string[]).includes(command.command)) return false;
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession(['undo', 'redo', 'resetCleanup'].includes(command.command))) return false;
    if ((TRANSFORM_COMMANDS as readonly string[]).includes(command.command)) return false;
    if (this.transformOwner && !await this.endTransformSession(['undo', 'redo', 'resetCleanup'].includes(command.command))) return false;
    // A filter baseline is an explicit owner. Ordinary shortcuts cannot end
    // it as a side effect of alignment or manual-gesture cancellation.
    if (this.filterOwner) {
      if (command.command !== 'resetCleanup' || !await this.cancelFilter()) return false;
    }
    if (!deferredCurrent()) return false;
    if (['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(command.command)) return false;
    if (command.command === 'resetAlignment') return this.resetAlignment();
    if (command.command !== 'alignCenter' && command.command !== 'alignScale' && command.command !== 'alignPlane' && command.command !== 'alignFloor') this.cancelAlignment();
    const color = command.command === 'grade' || command.command === 'autoColor';
    if (color && (!colorValues(command.values) || command.command === 'autoColor' && !isAutoColorMethod(command.method) ||
      !this.colorControlsReady())) return false;
    const morphology = command.command === 'morphology';
    // Grow/Shrink must refuse a captured gesture or released click; the
    // ordinary command path would otherwise cancel that selection first.
    if (morphology && (!isSelectionMorphologyCommand(command) ||
      !this.morphologyControlsReady() || !this.morphologyHasBoundary() || !this.morphologyDistanceCurrent(command))) return false;
    const morphologyClient = morphology ? this.client : undefined;
    const morphologyScene = morphology ? this.scene : undefined;
    const morphologyGeneration = this.generation;
    const morphologyRevision = morphologyClient ? { ...morphologyClient.revision } : undefined;
    this.selectionBarriers++;
    try {
      await this.floorCleanup;
      await this.closeToleranceSelection();
      if (!deferredCurrent()) return false;
      if (duplicate) {
        if (!this.duplicateControlsReady(true) || this.client !== duplicateClient || this.generation !== duplicateGeneration) return false;
        if (!await this.settleColorSession()) return false;
        if (!this.duplicateControlsReady(true) || this.client !== duplicateClient || this.generation !== duplicateGeneration) return false;
        return await this.executeCommand(command);
      }
      if (morphology) {
        if (!this.morphologyControlsReady(true) || !this.morphologyHasBoundary() ||
          this.client !== morphologyClient || this.scene !== morphologyScene ||
          !morphologyClient || !morphologyRevision || !sameRevision(morphologyRevision, morphologyClient.revision)) return false;
        if (!await this.settleColorSession()) return false;
        if (!this.morphologyControlsReady(true) || !this.morphologyHasBoundary() || this.client !== morphologyClient ||
            this.generation !== morphologyGeneration || morphologyClient.revision.documentId !== morphologyRevision.documentId ||
            morphologyClient.revision.sourceGeneration !== morphologyRevision.sourceGeneration) return false;
        if (command.method === 'volume' && !this.selectionMorphologyRange && !await this.queryMorphologyRange(true)) return false;
        if (!this.morphologyDistanceCurrent(command)) return false;
        return await this.executeCommand(command);
      }
      const hadGesture = !!this.selection;
      if (!await this.cancelSelectionGesture()) return false;
      if (!deferredCurrent()) return false;
      if (hadGesture && ['undo', 'redo'].includes(command.command)) return true;
      if (!color && !await this.settleColorSession()) return false;
      if (!deferredCurrent()) return false;
      const applied = await (deferredPointer ? this.executeCommand(command, deferredCurrent) : this.executeCommand(command));
      if (applied && command.command === 'resetCleanup') {
        // Desktop Cleanup Reset also returns to Orbit, without changing the
        // camera pose, geometry or color settings. Publish this only after the
        // native reset and its GPU masks have been acknowledged.
        this.camera?.clearInput();
        setApp({ tool: null, fly: false, autoOrbit: false });
        this.invalidate();
      }
      return applied;
    } finally { this.releaseSelectionBarrier(); }
  }
  private async executeCommand(command: SceneCommand, current?: () => boolean, tolerance = false,
    refused?: (error: unknown) => void, cleanupSelection?: GestureSelection): Promise<boolean> {
    return await this.executeEditCommand(command, current, tolerance, refused, cleanupSelection) === true;
  }
  private async executeEditCommand(command: SceneCommand, current?: () => boolean, tolerance = false,
    refused?: (error: unknown) => void, cleanupSelection?: GestureSelection, livePreview = false, colorBoundaryCommand = false): Promise<SelectionRunResult> {
    if (this.transformPivotQuery?.querying) await this.cancelTransformPivotFocus();
    if (this.morphologyRangeOwner) await this.cancelMorphologyRange();
    if (this.operationRecoveryBlocked || this.editOperation) return false;
    if (command.command !== 'alignFloor') {
      if (this.floorOwner || useApp.getState().alignmentFloor?.phase === 'cancelling') this.cancelAlignment();
      await this.floorCleanup;
    }
    // Duplicate already captured either a view or the absence of one at entry.
    if (!['duplicate', 'rebaseTransform'].includes(command.command)) command = this.scopedCommand(command);
    const beginColor = command.command === 'beginColor';
    const color = command.command === 'grade' || command.command === 'autoColor', endColor = command.command === 'endColor';
    const filterCommand = ['beginFilter', 'previewFilter', 'confirmFilter', 'cancelFilter'].includes(command.command);
    const transformCommand = (TRANSFORM_COMMANDS as readonly string[]).includes(command.command), endTransform = command.command === 'endTransform' || command.command === 'cancelTransform';
    const opacityCommand = (OPACITY_COMMANDS as readonly string[]).includes(command.command), endOpacity = command.command === 'endOpacity';
    if (opacityCommand && !isOpacityCommand(command)) return false;
    if (transformCommand && !isTransformCommand(command)) return false;
    if (filterCommand && !isSelectionFilterCommand(command)) return false;
    const requestedColor = color ? colorValues(command.values) : null;
    if (color && !requestedColor) return false;
    const submittedCommand = color ? { ...command, values: requestedColor! } : command;
    const previewBefore = [...useApp.getState().grade];
    const appliedBefore = [...useApp.getState().appliedGrade], scopeBefore = useApp.getState().colorSelectedOnly;
    const previewRevision = useApp.getState().gradeRevision;
    const flushColor = endColor && !sameColorValues(previewBefore, appliedBefore);
    if (flushColor && !colorValues(previewBefore)) return false;
    const cleanupAllowed = () => (!this.selectionCleanupOwner || command.command === 'cancelSelection' &&
      this.selectionCleanupOwner.selection === cleanupSelection && this.selectionCleanupOwner.client === this.client) &&
      (!this.filterOwner || filterCommand || endColor && this.filterOwner.phase === 'preparing' ||
        command.command === 'cancelSelection' && this.filterOwner.phase === 'preparing' ||
        command.command === 'summary' && this.filterOwner.cancelRequested) &&
      (!this.transformOwner || transformCommand || (endColor || command.command === 'cancelSelection') && this.transformOwner.phase === 'preparing') &&
      (!this.opacityOwner || opacityCommand || (endColor || command.command === 'cancelSelection') && this.opacityOwner.phase === 'preparing');
    if (!cleanupAllowed()) return false;
    await this.selectionMaps.cancelPending();
    await this.joinAutomaticTransformPivot();
    if (command.command === 'morphology' && (!this.morphologyControlsReady(true) || !this.morphologyHasBoundary() || !this.morphologyDistanceCurrent(command))) return false;
    const client = this.client, scene = this.scene, renderer = this.renderer, summary = useApp.getState().summary, camera = this.camera;
    // Deferred replacement Save joins released selection work admitted before
    // its export barrier. The modal must not refuse that owned work while Save
    // waits for it; exporting still fences newer picks and tolerance setters.
    const savingReleasedSelection = tolerance && current !== undefined && this.exporting && this.pendingNavigation?.kind === 'replace';
    if (!client || !scene || scene.kind !== 'gaussian' || !renderer || !summary || summary.kind !== 0 || renderer.lost || this.recovery || this.closing ||
        (this.closeRequest || useApp.getState().navigationPrompt && !savingReleasedSelection) && command.command !== 'cancelSelection' &&
          command.command !== 'cancelFilter' && !endTransform && !endOpacity && !(command.command === 'summary' && this.filterOwner?.cancelRequested) && !colorBoundaryCommand ||
        useApp.getState().busy || this.editingFailed || !cleanupAllowed()) {
      refused?.(new Error('The selection update could not start. Wait for the current operation or reopen the source.'));
      return false;
    }
    // Cancellation must not need another allocation to discard a draft. Its
    // GPU mirror cannot be claimed restored without an admitted publication.
    if ((command.command === 'cancelSelection' || command.command === 'cancelFilter') && this.ledger.overageBytes > 0) {
      try {
        const restored = await client.command(command);
        if (client === this.client && !this.destroyed) {
          this.shrinkNativeHistory(client, restored);
          setApp({ summary: restored, dirty: restored.contentRevision !== this.savedContent });
          this.error(new Error('The native selection was cancelled. Close the scene to release retained memory; retrying graphics cannot shrink its native heap.'));
        }
      } catch (error) { this.error(error); }
      return false;
    }
    try { client.assertNativeAdmission(); }
    catch (error) { refused?.(error); this.error(error); return false; }
    const beforeAlignment = validateAlignmentSummary(summary.alignment);
    const alignmentCommand = command.command === 'alignCenter' || command.command === 'alignScale' || command.command === 'alignPlane' ||
      command.command === 'alignFloor' || command.command === 'resetAlignment';
    if (alignmentCommand && (!beforeAlignment || !camera)) return false;
    if (alignmentCommand || command.command === 'undo' || command.command === 'redo') {
      camera?.clearInput(); setApp({ autoOrbit: false });
    }
    let settled!: () => void;
    const before = { ...client.revision };
    const operation: EditOperation = { cancel: new AbortController(), committing: false,
      finished: new Promise<void>(resolve => { settled = resolve; }), tolerance }; this.editOperation = operation;
    if (color || beginColor) this.colorJob = command.command === 'autoColor' ? 'auto' : 'manual';
    const check = () => {
      if (operation.cancel.signal.aborted || client !== this.client || this.destroyed || !cleanupAllowed()) throw new DOMException('Edit cancelled', 'AbortError');
      if (current && !current()) throw new DOMException('Selection query expired', 'AbortError');
      if (renderer.lost) throw new Error('The graphics device is unavailable. Your edits are retained.');
      if (colorBoundaryCommand && useApp.getState().gradeRevision !== previewRevision)
        throw new Error('The color preview changed before its boundary could be published.');
    };
    setApp({ busy: true, stage: 'Applying edit', ...(command.command === 'cancelSelection' ? {} : { error: null }) });
    const previousHistory = this.releaseHistory;
    const history = previousHistory ?? this.ledger.reserve('history', 0), historyBytes = history.bytes;
    let workLease: ResourceLease | undefined, staged: GaussianScene | undefined, masks: MaskUpdate | undefined;
    let transaction = false, published = false, workCovered = false, historyCovered = previousHistory !== undefined;
    let nativeOperation: OperationOwner | undefined;
    let externallyDecided = false;
    let alignedCamera: number[] | undefined, alignedDefaultCamera: number[] | undefined;
    let alignedViews: AlignmentViewCheckpoints | undefined, alignedViewsLease: ResourceLease | undefined;
    let terminalRevision: Revision | undefined, terminalSummary = summary;
    let admittedGpuBytes = scene.allocationBytes;
    let sceneRetirement: Promise<void> | undefined;
    const retireScene = () => sceneRetirement ??= Promise.resolve().then(() => scene.dispose());
    let retainedTransformBase = false;
    const coverage = this.nativeCoverage.get(client);
    const originalSceneLeaseBytes = coverage?.scene.bytes;
    try {
      if (!previousHistory) {
        client.updateNativeCoverage([{ lease: history, nextLeaseBytes: 0, nativeBytes: 0 }]); historyCovered = true;
      }
      const mayChangeContent = ['duplicate', 'grade', 'autoColor', 'endColor', 'transform', 'alignCenter', 'alignScale', 'alignPlane', 'alignFloor', 'resetAlignment', 'undo', 'redo'].includes(command.command);
      // A Redo scene can be larger than the current one. Its retained native
      // payload supplies a conservative count ceiling without probing history.
      const historyCount = command.command === 'undo' || command.command === 'redo' ?
        Math.max(summary.count, Math.min(DUPLICATE_SCENE_LIMIT, Math.floor(summary.memoryBytes / 144))) : summary.count;
      const workBytes = command.command === 'duplicate' ? estimateDuplicateWorkBytes(summary.count, summary.selected, summary.shDegree) :
        opacityCommand ? estimateOpacityWorkBytes(summary.count, summary.shDegree) : transformCommand ? estimateTransformWorkBytes(summary.count, summary.shDegree) : filterCommand ? estimateFilterWorkBytes(summary.count) : command.command === 'morphology' ? estimateMorphologyWorkBytes(summary.count) :
        color || beginColor ? estimateColorWorkBytes(summary.count, summary.shDegree, command.command === 'autoColor') :
        mayChangeContent ? this.estimateSceneBytes(historyCount, summary.shDegree) : summary.count * 24 + 4 * MiB;
      // Color publication stages another admitted SceneEdits history copy in
      // addition to the outer rollback checkpoint. Shared scene references do
      // not duplicate payload charges; physical history copies still overlap.
      // Native effective mask N, two transferred byte masks2N, expanded
      // uploads8N and target GPU4N overlap; retain another N of mask headroom.
      const backendWork = renderer.backend === 'webgl2' && (mayChangeContent || color || beginColor || transformCommand || opacityCommand) ?
        Math.max(0, this.estimateSceneBytes(historyCount, summary.shDegree) - estimateWebGpuSceneBytes(historyCount, summary.shDegree)) : 0;
      const previewWork = (beginColor || color || transformCommand || opacityCommand) &&
        (command.selectedOnly === true || summary.colorSession?.selectedOnly || summary.transformSession?.selectedOnly || summary.opacitySession?.selectedOnly) ? summary.count * 16 : 0;
      const scopeWork = command.selectionView && command.command === 'morphology' ? summary.count + 1024 : 0;
      workLease = this.ledger.reserve('work', (opacityCommand || transformCommand || filterCommand || color || beginColor || flushColor ? 2 : 1) * historyBytes + workBytes + backendWork + previewWork + scopeWork);
      client.updateNativeCoverage([{ lease: workLease, nextLeaseBytes: workLease.bytes, nativeBytes: 0 }]);
      workCovered = true;
      if (coverage) { coverage.history = history; coverage.work = workLease; }
      client.setNativeWork(workLease);
      nativeOperation = client.createOperation();
      await client.beginOperation(nativeOperation); transaction = true; check();
      const validateColorBake = (updated: NativeSummary, requested: readonly number[], automatic = false, selectedOnly = command.selectedOnly === true) => {
        const session = colorSessionState(updated.colorSession);
        const manualNoop = !automatic && !session && !updated.sceneChanged &&
          updated.revision === summary.revision && updated.contentRevision === summary.contentRevision &&
          sameColorValues(requested, summary.colorSession?.applied ?? NEUTRAL_COLOR);
        const scopeCanClip = (!!command.selectionView || this.hasPreviewTarget('colorBase')) && selectedOnly;
        if (updated.count !== summary.count || updated.shDegree !== summary.shDegree ||
          (scopeCanClip ? updated.selected > summary.selected : updated.selected !== summary.selected) || updated.visible !== summary.visible ||
          session && (session.pending || !sameColorValues(session.values, session.applied)) || !session && !manualNoop)
          throw new Error('The color bake did not preserve its captured geometry, mask and session.');
        if (session && this.colorDisplay && (this.colorDisplay.scene !== scene || this.colorDisplay.documentId !== client.revision.documentId ||
          this.colorDisplay.sourceGeneration !== client.revision.sourceGeneration || this.colorDisplay.baseId !== session.baseId ||
          this.colorDisplay.sessionId !== session.sessionId)) throw new Error('The captured color base changed before publication.');
      };
      // A source/mask/history boundary owns one checkpoint for both the last
      // pending bake and its GPU materialization. A failed upload must also
      // restore the history and source that preceded that pending bake.
      if (flushColor) {
        const baked = await client.command({ command: 'grade', values: previewBefore, selectedOnly: scopeBefore });
        terminalSummary = baked; check(); validateColorBake(baked, previewBefore, false, scopeBefore);
      }
      let updated: NativeSummary;
      if (livePreview) {
        const outcome = await client.livePreview(submittedCommand);
        check();
        if (outcome.kind === 'computation-failed') {
          // This outcome leaves the native candidate unpublished. Join the
          // exact transaction rollback before the gesture may defer its live
          // worker and restore the original selection/Redo baseline.
          let restored: NativeSummary;
          try {
            restored = await client.rollbackOperation(nativeOperation);
            if (restored.ok !== true || restored.transaction !== false)
              throw new Error('The scene worker did not acknowledge edit rollback.');
            if (!sameToleranceOwner(summary, restored)) throw new Error('The scene worker did not restore the captured Range owner.');
            transaction = false; terminalRevision = { ...client.revision };
            terminalSummary = restored;
          } catch (rollbackError) {
            this.editingFailed = true;
            this.error(new Error(`The scene worker could not restore the edit. Reopen the source to continue. ${rollbackError instanceof Error ? rollbackError.message : ''}`));
            refused?.(rollbackError);
            return false;
          }
          check();
          setApp({ summary: restored, dirty: restored.contentRevision !== this.savedContent });
          return outcome;
        }
        updated = outcome.summary;
      } else updated = await client.command(submittedCommand);
      terminalSummary = updated;
      if (['colorPick', 'colorTolerance', 'fillPick', 'fillTolerance'].includes(command.command))
        assertToleranceRangeAcknowledgement(submittedCommand, summary, updated);
      if (command.command === 'duplicate') {
        const copied = updated.count - summary.count;
        if (updated.kind !== 0 || copied < 1 || copied > summary.selected || updated.count > DUPLICATE_SCENE_LIMIT ||
            updated.sourceCount !== summary.sourceCount + copied || updated.selected !== copied || updated.visible !== summary.visible + copied ||
            !sameDuplicateRange(updated.duplicateRange, { first: summary.count, count: copied }) ||
            updated.shDegree !== summary.shDegree || !updated.sceneChanged || updated.revision <= summary.revision ||
            updated.contentRevision <= summary.contentRevision || updated.selectionDraft || updated.pending ||
            updated.colorSession || updated.transformSession || updated.opacitySession || updated.filter)
          throw new Error('The duplicate did not preserve its captured source, selected copies and scene lineage.');
      }
      if (filterCommand) this.validateFilterEdit(command, summary, updated);
      if (transformCommand) this.validateTransformEdit(command, summary, updated);
      if (opacityCommand) this.validateOpacityEdit(command, summary, updated);
      retainedTransformBase = transformCommand && (updated.transformSession !== null ||
        endTransform && summary.transformSession?.appliedEpoch === null && !(command.command === 'cancelTransform' && updated.contentRevision !== summary.contentRevision)) ||
        opacityCommand && (updated.opacitySession !== null || endOpacity && summary.opacitySession?.appliedEpoch === null);
      check();
      if (color) {
        validateColorBake(updated, requestedColor!, command.command === 'autoColor');
      }
      if (beginColor && (!updated.colorSession || updated.colorSession.selectedOnly !== command.selectedOnly || updated.colorSession.pending ||
          updated.count !== summary.count || updated.shDegree !== summary.shDegree || updated.selected !== summary.selected || updated.visible !== summary.visible ||
          updated.revision !== summary.revision || updated.contentRevision !== summary.contentRevision || updated.sceneChanged ||
          !sameColorValues(updated.colorSession.values, updated.colorSession.applied)))
        throw new Error('The color session did not capture its unchanged baseline.');
      const targets: Partial<Record<Exclude<MaskChannel, 'document'>, ArrayBuffer | null>> = {};
      const viewTargets = !!updated.colorSession?.selectedOnly || !!updated.transformSession?.selectedOnly || !!updated.opacitySession?.selectedOnly ||
        !!summary.colorSession?.selectedOnly || !!summary.transformSession?.selectedOnly || !!summary.opacitySession?.selectedOnly;
      const readTarget = async (channel: Exclude<MaskChannel, 'document'>, active: boolean) => {
        if (!active) { targets[channel] = null; return; }
        let bytes: ArrayBuffer | undefined;
        await client.readMasks(value => { bytes = value; }, channel); check();
        if (!bytes || bytes.byteLength !== updated.count) throw new Error('The captured edit target was not received.');
        targets[channel] = bytes;
      };
      if (viewTargets && (beginColor || color || endColor)) await readTarget('colorBase', !!updated.colorSession);
      if (viewTargets && transformCommand) await readTarget('transformBase', !!updated.transformSession);
      if (viewTargets && opacityCommand) await readTarget('opacityBase', !!updated.opacitySession);
      const changedGizmoBase = transformCommand && updated.transformSession?.kind === 'gizmo' &&
        updated.transformSession.baseId !== summary.transformSession?.baseId && updated.contentRevision !== summary.contentRevision;
      if (changedGizmoBase) {
        staged = await renderer.allocateScene(updated.count, updated.shDegree); check();
        const streamed = await this.uploadNativeScene(client, staged, 'transformBase', check, bytes => client.updateNativeCoverage([{ lease: workLease!, nextLeaseBytes: workLease!.bytes + bytes, nativeBytes: 0 }]));
        if (streamed.revision !== updated.revision || streamed.contentRevision !== updated.contentRevision ||
            !sameTransformSummary(validateTransformSummary(streamed.transformSession), validateTransformSummary(updated.transformSession)))
          throw new Error('The gizmo base changed during its admitted GPU stream.');
      } else if ((color || beginColor || retainedTransformBase) && !viewTargets) {
        // Unrestricted owners retain the existing canonical mask binding.
      } else if (!color && !beginColor && !retainedTransformBase && (updated.sceneChanged && !(transformCommand && updated.transformSession) || endColor || endTransform || endOpacity)) {
        if (endColor && colorSessionState(updated.colorSession)) throw new Error('The scene worker did not settle its color session.');
        staged = await renderer.allocateScene(updated.count, updated.shDegree); check();
        const streamed = await client.stream((first, count, bytes) => staged!.upload(first, count, bytes), bytes => staged!.masks(bytes));
        if (streamed.count !== updated.count || streamed.sourceCount !== updated.sourceCount || streamed.revision !== updated.revision ||
            streamed.contentRevision !== updated.contentRevision || !sameDuplicateRange(streamed.duplicateRange, updated.duplicateRange))
          throw new Error('The replacement GPU scene changed during its captured stream.');
        staged.setDuplicateRange(updated.duplicateRange);
      } else {
        let bytes: ArrayBuffer | undefined;
        await client.readMasks(value => { bytes = value; }); check();
        if (!bytes) throw new Error('The scene state update was not received.');
        masks = await scene.stageMasks(bytes, targets);
      }
      await renderer.finish(); check();
      const nextAlignment = validateAlignmentSummary(updated.alignment);
      if (beforeAlignment && !nextAlignment) throw new Error('The scene worker lost its alignment metadata.');
      if (alignmentCommand && (!nextAlignment || updated.count !== summary.count || updated.shDegree !== summary.shDegree))
        throw new Error('The alignment did not preserve its captured scene.');
      if (beforeAlignment && nextAlignment && !sameAlignmentBranch(beforeAlignment, nextAlignment)) {
        if (!camera || camera !== this.camera) throw new Error('The alignment camera is unavailable.');
        // Prepare before the irreversible native/GPU publication. Preserve the
        // user's current navigation instead of restoring a historical camera.
        const transform = (state: readonly number[], frame: readonly number[], policy: 0 | 1 = 0) => camera.transformState(state, frame, policy);
        const change = (oldFrame: readonly number[], newFrame: readonly number[]) => camera.frameChange(oldFrame, newFrame);
        const policy = command.command === 'alignPlane' || command.command === 'alignFloor' ? 1 :
          command.command === 'alignCenter' || command.command === 'alignScale' ? 0 : undefined;
        // Reserve the detached metadata copy before allocating/preparing it.
        alignedViewsLease = this.ledger.reserve('history', ALIGNMENT_VIEW_BOOKKEEPING_BYTES);
        const prepared = prepareAlignmentView(beforeAlignment, nextAlignment, camera.state,
          this.defaultAlignmentCamera(), this.alignmentViews, transform, change, policy);
        if (prepared) {
          // This metadata allowance is separate from native scene/history credit.
          alignedCamera = prepared.active; alignedDefaultCamera = prepared.defaultCamera;
          alignedViews = prepared.checkpoints;
        }
      }
      // Admit retained native history and old GPU retirement together, before
      // committing either side. No allocation/admission remains after this.
      this.transferEditCoverage(client, history, workLease, nativeHistoryBytes(updated), nativeHistoryBytes(updated),
        checkedBytes(staged ? scene.allocationBytes : masks ? masks.allocationBytes + (masks.retirementBytes ?? updated.count * 5) : 0, 1),
        coverage ? { bytes: coverage.scene.bytes + (updated.count - summary.count) * 144 + (staged ? staged.allocationBytes - scene.allocationBytes : masks ? masks.allocationBytes - (masks.retirementBytes ?? updated.count * 5) : 0), nativeBytes: updated.count * 144 } : undefined);
      admittedGpuBytes = staged?.allocationBytes ?? scene.allocationBytes + (masks ? masks.allocationBytes - (masks.retirementBytes ?? updated.count * 5) : 0);
      check();
      operation.committing = true;
      const store = this.documentRecovery;
      const checkpoint = store && !updated.selectionDraft && !updated.pending && !updated.filter ? {
        ledger: this.ledger, binding: client.getRecoveryBinding(), signal: operation.cancel.signal,
        metadata: this.recoveryMetadata(updated, alignedCamera ?? camera!.state,
          alignedDefaultCamera ?? this.defaultAlignmentCamera(), alignedViews ?? this.alignmentViews),
        accept: (prepared: import('../document/recoveryCheckpoint').PreparedRecoveryCheckpoint) => {
          check();
          if (store !== this.documentRecovery || client !== this.client || !nativeOperation)
            throw new Error('The recovery decision no longer belongs to this document.');
          const decision = store.decide(nativeOperation, prepared); externallyDecided = true; return decision;
        },
      } : undefined;
      const committed = await client.commitOperation(nativeOperation, checkpoint); transaction = false;
      terminalSummary = committed;
      terminalRevision = { ...client.revision };
      if (!sameToleranceOwner(updated, committed)) throw new Error('The committed Range owner does not match its admitted GPU candidate.');
      if (committed.count !== updated.count || committed.sourceCount !== updated.sourceCount ||
          !sameDuplicateRange(committed.duplicateRange, updated.duplicateRange))
        throw new Error('The committed scene topology does not match its admitted GPU candidate.');
      if (filterCommand) {
        try {
          const expected = validateFilterSummary(updated.filter), actual = validateFilterSummary(committed.filter);
          if (!sameFilter(expected, actual) || committed.ok !== true || committed.transaction !== false || committed.loaded !== updated.loaded ||
            committed.kind !== updated.kind || committed.count !== updated.count || committed.shDegree !== updated.shDegree ||
            committed.revision !== updated.revision || committed.contentRevision !== updated.contentRevision ||
            committed.selected !== updated.selected || committed.visible !== updated.visible || committed.selectionDraft !== false || committed.pending)
            throw new Error('The scene worker returned an inconsistent filter commit.');
        } catch (error) {
          this.editingFailed = true;
          this.error(new Error(`The scene worker could not verify the committed filter. Reopen the source to continue. ${error instanceof Error ? error.message : ''}`));
          throw error;
        }
      }
      if (transformCommand) {
        try {
          if (!sameTransformSummary(validateTransformSummary(updated.transformSession), validateTransformSummary(committed.transformSession)) ||
            committed.ok !== true || committed.transaction !== false || committed.loaded !== updated.loaded || committed.kind !== updated.kind ||
            committed.count !== updated.count || committed.shDegree !== updated.shDegree || committed.revision !== updated.revision ||
            committed.contentRevision !== updated.contentRevision || committed.selected !== updated.selected || committed.visible !== updated.visible ||
            committed.selectionDraft !== false || committed.pending) throw new Error('The scene worker returned an inconsistent transform commit.');
        } catch (error) {
          this.editingFailed = true;
          this.error(new Error(`The scene worker could not verify the committed transform. Reopen the source to continue. ${error instanceof Error ? error.message : ''}`));
          throw error;
        }
      }
      if (opacityCommand) {
        try {
          if (!sameOpacitySummary(validateOpacitySummary(updated.opacitySession), validateOpacitySummary(committed.opacitySession)) ||
            committed.ok !== true || committed.transaction !== false || committed.loaded !== updated.loaded || committed.kind !== updated.kind ||
            committed.count !== updated.count || committed.sourceCount !== updated.sourceCount || committed.shDegree !== updated.shDegree || committed.revision !== updated.revision ||
            committed.contentRevision !== updated.contentRevision || committed.selected !== updated.selected || committed.visible !== updated.visible || committed.selectionDraft !== false || committed.pending ||
            committed.radius !== updated.radius || committed.yUp !== updated.yUp || !Array.isArray(committed.center) || committed.center.length !== updated.center.length ||
            committed.center.some((value, index) => value !== updated.center[index]) || !Array.isArray(committed.camera) || committed.camera.length !== updated.camera.length ||
            committed.camera.some((value, index) => value !== updated.camera[index]))
            throw new Error('The scene worker returned an inconsistent opacity commit.');
        } catch (error) {
          this.editingFailed = true; this.error(new Error(`The scene worker could not verify committed opacity. Reopen the source to continue. ${error instanceof Error ? error.message : ''}`)); throw error;
        }
      }
      // The native checkpoint has already been released. A malformed commit
      // acknowledgement cannot authorize publishing candidate GPU/camera owners,
      // and must not be reported as a successfully rolled-back edit.
      if (nextAlignment) {
        try {
          const committedAlignment = validateAlignmentSummary(committed.alignment);
          if (!committedAlignment || !sameAlignmentBranch(nextAlignment, committedAlignment) ||
              committedAlignment.canReset !== nextAlignment.canReset || committed.ok !== true ||
              committedAlignment.retainedBranchIds.length !== nextAlignment.retainedBranchIds.length ||
              committedAlignment.retainedBranchIds.some((branch, index) => branch !== nextAlignment.retainedBranchIds[index]) ||
              committed.transaction !== false || committed.loaded !== updated.loaded ||
              committed.kind !== updated.kind || committed.count !== updated.count ||
              committed.shDegree !== updated.shDegree || committed.revision !== updated.revision ||
              committed.contentRevision !== updated.contentRevision || committed.selected !== updated.selected ||
              committed.visible !== updated.visible || command.command === 'alignFloor' && committed.floor !== null)
            throw new Error('The scene worker returned an inconsistent alignment commit.');
        } catch (error) {
          this.editingFailed = true;
          this.error(new Error(`The scene worker could not verify the committed edit. Reopen the source to continue. ${error instanceof Error ? error.message : ''}`));
          throw error;
        }
      }
      let retiredMasks: readonly RetiredRenderResource[] = [];
      if (renderer.lost) {
        const resolution = client.operationResolution;
        if (!resolution || resolution.receipt.outcome !== 'committed') throw new Error('The committed edit proof is unavailable.');
        this.committedGraphicsRecovery = { client, resolution, admittedGpuBytes };
        setApp({ operationRecovery: 'required', operationRecoveryCommitted: true, ready: false, rendererState: 'unavailable',
          error: 'The edit is committed. Restore graphics to continue.' });
      } else {
        if (staged) { this.scene = staged; staged = undefined; }
        else if (masks) {
          const canonical = masks.publish();
          retiredMasks = masks.retirementBuffers ?? (canonical ? [canonical] : []);
        }
      }
      if (alignedCamera && camera) { alignedCamera[10] = camera.state[10]; camera.set(alignedCamera); }
      if (alignedDefaultCamera) this.alignmentDefaultCamera = alignedDefaultCamera;
      if (alignedViews) {
        this.alignmentViewsLease?.(); this.alignmentViews = alignedViews;
        this.alignmentViewsLease = alignedViewsLease; alignedViewsLease = undefined;
      }
      let acceptedGizmoPreview: ReturnType<typeof useApp.getState>['transformPreview'] | undefined;
      if (transformCommand && this.transformOwner) {
        this.transformOwner.scene = this.scene as GaussianScene;
        const metadata = validateTransformSummary(committed.transformSession);
        if (metadata) {
          this.transformOwner.metadata = metadata; this.transformOwner.selectedOnly = metadata.selectedOnly;
          if (metadata.kind === 'gizmo') acceptedGizmoPreview = { ...metadata,
            matrix: [...metadata.appliedMatrix] as TransformMatrix, pivot: [...metadata.pivot] as TransformVec3 };
        }
      }
      published = true; this.releaseHistory = history;
      this.shrinkNativeHistory(client, committed);
      if (endOpacity) this.clearOpacityPreview();
      setApp({ summary: committed, dirty: committed.contentRevision !== this.savedContent,
        ...(endTransform ? { transformPreview: null } : acceptedGizmoPreview ? { transformPreview: acceptedGizmoPreview } : {}) });
      this.syncDuplicateFeedback(committed);
      if (beginColor || color || endColor) this.acknowledgeColor(committed, color ? requestedColor! : previewBefore, command.command === 'autoColor', previewRevision);
      this.invalidate();
      document.title = `${committed.contentRevision !== this.savedContent ? '• ' : ''}${useApp.getState().sourceName} — SplatView`;
      if (this.scene !== scene) await retireScene();
      else { await renderer.finish().catch(() => undefined); for (const buffer of retiredMasks) buffer.destroy(); }
      return true;
    } catch (error) {
      if (client.failed && client === this.client && !this.destroyed && this.documentRecovery?.description) {
        // Return the recovery promise without awaiting it here: finally must
        // release the edit's borrowed owners before restore can pass finished.
        return this.retryRenderer().then(restored => restored && externallyDecided);
      }
      const committedResolution = client.operationResolution;
      if (!published && committedResolution?.receipt.outcome === 'committed' && client === this.client && !this.destroyed) {
        // Native success survives any failed GPU/metadata publication. Retain
        // its exact proof and history until a replacement mirror is installed.
        this.committedGraphicsRecovery = { client, resolution: committedResolution, admittedGpuBytes };
        transaction = false;
        terminalSummary = committedResolution.summary; terminalRevision = { ...client.revision };
        published = true; this.releaseHistory = history;
        this.shrinkNativeHistory(client, terminalSummary);
        setApp({ summary: terminalSummary, dirty: terminalSummary.contentRevision !== this.savedContent,
          operationRecovery: 'required', operationRecoveryCommitted: true, ready: false, rendererState: 'unavailable',
          error: 'The edit is committed. Restore graphics to continue.' });
      }
      if (isOperationRestoredError(error)) {
        if (!sameToleranceOwner(summary, error.summary)) {
          this.editingFailed = true;
          this.error(new Error('The scene worker did not restore the captured Range owner. Reopen the source to continue.'));
        } else {
          terminalSummary = error.summary; terminalRevision = { ...client.revision };
          setApp({ summary: error.summary, dirty: error.summary.contentRevision !== this.savedContent });
        }
      }
      if (transaction && client === this.client && !this.destroyed) {
        try {
          const restored = await client.rollbackOperation(nativeOperation!);
          if (!sameToleranceOwner(summary, restored)) throw new Error('The scene worker did not restore the captured Range owner.');
          terminalSummary = restored;
          terminalRevision = { ...client.revision };
          setApp({ summary: restored, dirty: restored.contentRevision !== this.savedContent });
          if (color || endColor) {
            const latestPreview = [...useApp.getState().grade];
            this.acknowledgeColor(restored);
            setApp({ grade: latestPreview, appliedGrade: appliedBefore, colorSelectedOnly: scopeBefore,
              gradeRevision: useApp.getState().gradeRevision + 1,
              dirty: restored.contentRevision !== this.savedContent || !sameColorValues(latestPreview, appliedBefore) });
          }
        } catch (rollbackError) {
          this.editingFailed = true;
          this.error(new Error(`The scene worker could not restore the edit. Reopen the source to continue. ${rollbackError instanceof Error ? rollbackError.message : ''}`));
        }
      }
      // CoreClient currently turns the worker's cancellation response into an
      // Error. Recognize only its source-defined cancellation messages when
      // this operation was actually aborted. A physical stage/admission error
      // arriving after Combine/final fallback still refuses the gesture.
      const cancelled = error instanceof DOMException && error.name === 'AbortError' ||
        operation.cancel.signal.aborted && error instanceof Error &&
        ['Operation cancelled', 'Edit cancelled', 'Upload cancelled'].includes(error.message);
      if (!cancelled) refused?.(error);
      if (!operation.cancel.signal.aborted && !this.editingFailed && !this.committedGraphicsRecovery) this.error(error);
      return false;
    }
    finally {
      try {
        if (staged) await staged.dispose();
        await renderer.finish().catch(() => undefined); await masks?.dispose();
        if (this.scene !== scene) await retireScene();
        client.setNativeWork(undefined);
        if (coverage) coverage.work = undefined;
        if (published && workLease && this.committedGraphicsRecovery?.client === client && this.scene === scene && !renderer.lost) {
          if (this.retainedGraphicsCredit) throw new Error('A previous GPU retirement still owns the retained edit credit.');
          // A committed shrink may still display the larger old mirror. Keep
          // its credit until that exact GPU owner has joined retirement.
          client.updateNativeCoverage([{ lease: workLease, nextLeaseBytes: scene.allocationBytes, nativeBytes: 0 }]);
          this.retainedGraphicsCredit = { client, scene, lease: workLease }; workLease = undefined;
        }
        try {
          if (client.failed) {
            await client.retireNativeMemory();
            if (externallyDecided && workLease && this.scene === scene && !renderer.lost) {
              if (this.retainedGraphicsCredit) throw new Error('A previous GPU retirement still owns the retained edit credit.');
              workLease.resize(scene.allocationBytes);
              this.retainedGraphicsCredit = { client, scene, lease: workLease }; workLease = undefined;
            }
          }
          else if (!published && !this.destroyed && client === this.client && workCovered && workLease) {
            this.transferEditCoverage(client, history, workLease, nativeHistoryBytes(terminalSummary), historyBytes, 0,
              originalSceneLeaseBytes === undefined ? undefined : { bytes: originalSceneLeaseBytes, nativeBytes: summary.count * 144 });
          }
        } finally {
          if (workLease) { if (workCovered && !client.failed) client.releaseNativeCoverage(workLease); else workLease(); }
          if (!published && !previousHistory) {
            if (coverage) coverage.history = undefined;
            if (historyCovered && !client.failed) client.releaseNativeCoverage(history); else history();
          }
        }
      } catch (error) {
        this.editingFailed = true; this.error(error);
      } finally {
        alignedViewsLease?.();
        if (nativeOperation && !client.failed && client === this.client && !this.destroyed) {
          try { await client.finishOperation(nativeOperation); }
          catch (error) { this.editingFailed = true; setApp({ operationRecovery: 'required' }); this.error(error); }
        }
        if (this.editingFailed) void this.cancelReleasedSelections();
        else if (tolerance && terminalRevision) this.advanceReleasedRevision(client, before, terminalRevision, operation);
        if (this.editOperation === operation) this.editOperation = undefined;
        if (color || beginColor) this.colorJob = undefined;
        this.selectionMaps.validate();
        if (client === this.client && !this.destroyed && !this.recovery) setApp({ busy: false, stage: '' });
        settled();
      }
    }
  }
  get selectionActive() { return !!this.selection && !this.selection.session.closed; }
  private duplicateControlsReady(ownedBarrier = false) {
    const state = useApp.getState(), summary = state.summary;
    this.syncDuplicateFeedback(summary);
    return state.mode === 'pro' && this.morphologyControlsReady(ownedBarrier) && !!this.client && !!this.camera &&
      this.scene?.kind === 'gaussian' && !!summary && this.scene.count === summary.count && summary.kind === 0 && summary.selected > 0 &&
      summary.count < DUPLICATE_SCENE_LIMIT && !this.scene.duplicateSelectionGuarded &&
      !this.morphologyRangeOwner && !this.transformOwner && !this.opacityOwner && !this.opacityEntryTask && !this.filterOwner && !this.colorBoundary &&
      !this.floorOwner && !this.floorPreparing && !this.alignmentOwner && !this.alignmentPick && !this.alignmentConfirming;
  }
  get duplicateControlsEnabled() { return this.duplicateControlsReady(); }
  private morphologyControlsReady(ownedBarrier = false) {
    const state = useApp.getState();
    return this.editingAvailable && state.ready && !!state.summary && !state.busy &&
      !state.summary.selectionDraft && !state.summary.pending && !state.selectionDragging &&
      state.pendingSelectionCount === 0 && !this.selectionActive && !this.releasedSelections.length &&
      !this.releasedDrain && !this.pendingTolerancePicks.size && !this.isToleranceUpdating &&
      !this.editOperation && !this.cancellingSelection && !this.exporting &&
      this.selectionBarriers === Number(ownedBarrier) && !state.outputPending && !state.exportOpen &&
      !state.settingsOpen && !state.savedViewChoices.length;
  }
  private morphologyHasBoundary() {
    const summary = useApp.getState().summary;
    return !!summary && summary.selected > 0 && (useApp.getState().currentViewOnly || summary.selected < summary.visible);
  }
  private selectionViewRevision() {
    return `${this.camera?.revision ?? -1}/${this.renderer?.canvas.width ?? 0}/${this.renderer?.canvas.height ?? 0}`;
  }
  private hasPreviewTarget(channel: Exclude<MaskChannel, 'document'>) {
    const scene = this.scene;
    return scene?.kind === 'gaussian' && typeof scene.hasPreviewMask === 'function' && scene.hasPreviewMask(channel);
  }
  private captureSelectionView(enabled = useApp.getState().currentViewOnly): SelectionView | null {
    return enabled && this.camera ? validateSelectionView(this.camera.state) : null;
  }
  private scopedCommand(command: SceneCommand, view?: SelectionView | null): SceneCommand {
    if (!(SELECTION_VIEW_COMMANDS as readonly string[]).includes(command.command) || Object.hasOwn(command, 'selectionView')) return command;
    if (['beginColor', 'grade', 'autoColor', 'beginTransform', 'beginOpacity'].includes(command.command) && command.selectedOnly !== true) return command;
    if (['grade', 'autoColor'].includes(command.command) && useApp.getState().colorSession?.active) return command;
    const selectionView = view === undefined ? this.captureSelectionView() : view;
    return selectionView ? { ...command, selectionView } : command;
  }
  get currentViewOnlyControlsEnabled() {
    const state = useApp.getState();
    return this.editingAvailable && !!this.client && !!this.camera && this.scene?.kind === 'gaussian' &&
      state.ready && !state.busy && !state.summary?.selectionDraft && !state.summary?.pending && !this.filterOwner &&
      !this.editOperation && !this.selectionCleanupOwner && !this.selectionBarriers && !this.exporting &&
      !this.colorBoundary && !this.recovery && !this.closing && !this.closeRequest && !this.destroyed &&
      !state.navigationPrompt && !state.outputPending && !state.exportOpen && !state.settingsOpen &&
      !state.savedViewChoices.length && !state.viewTransferPending && !state.thumbnailPending;
  }
  async setCurrentViewOnly(enabled: boolean): Promise<boolean> {
    if (typeof enabled !== 'boolean' || !this.currentViewOnlyControlsEnabled) return false;
    if (useApp.getState().currentViewOnly === enabled) return true;
    const client = this.client, generation = this.generation;
    this.cancelDeferredColorPointers(); this.selectionBarriers++;
    try {
      if (!await this.endOpacitySession() || !await this.endTransformSession()) return false;
      await this.floorCleanup; await this.closeToleranceSelection();
      if (!await this.cancelSelectionGesture() || !await this.settleColorSession() || client !== this.client ||
          generation !== this.generation || this.destroyed || this.closing || this.closeRequest || this.filterOwner) return false;
      if (enabled && !await this.executeCommand({ command: 'clipSelection', selectionView: this.captureSelectionView(true) })) return false;
      if (client !== this.client || generation !== this.generation || this.destroyed) return false;
      setApp({ currentViewOnly: enabled, selectionOptionsRevision: useApp.getState().selectionOptionsRevision + 1 });
      this.invalidate(); return true;
    } finally { this.releaseSelectionBarrier(); }
  }
  get selectionMorphologyControlsEnabled() { return this.morphologyControlsReady(); }
  get selectionRangeControlsEnabled() {
    const state = useApp.getState();
    return this.editingAvailable && state.ready && state.summary?.kind === 0 &&
      (state.tool === 'color' || state.tool === 'fill') && (!state.busy || this.isReleasedSelectionBusy) &&
      !state.selectionDragging && !this.filterOwner && !this.transformOwner && !this.opacityOwner &&
      !this.opacityEntryTask && !this.selectionCleanupOwner && !this.selectionBarriers && !this.exporting &&
      !state.outputPending && !state.exportOpen && !state.settingsOpen && !state.savedViewChoices.length;
  }
  selectionRangeBounds(tool: 'color' | 'fill' = useApp.getState().tool === 'fill' ? 'fill' : 'color') {
    const state = useApp.getState(), summary = state.summary;
    if (!summary?.loaded || summary.kind !== 0) return undefined;
    return resolveSelectionRange(tool === 'fill' ? state.fillRange : state.colorRange, validateMorphologyRange(summary.morphologyRange));
  }
  async ensureSelectionRangeBounds(): Promise<boolean> {
    const prepared = await this.queryMorphologyRange(false);
    const owner = this.tolerance, state = useApp.getState();
    if (prepared && owner?.active && this.toleranceCurrent(owner) &&
        (owner.tool === 'fill' ? state.fillRange : state.colorRange).enabled) {
      const fields = this.selectionRangeFields(owner.tool), accepted = state.summary?.toleranceRange;
      if (fields && (fields.rangeEnabled !== accepted?.enabled || fields.rangeRadius !== accepted?.radius)) this.queueToleranceUpdate('range');
    }
    return prepared;
  }
  private selectionRangeFields(tool: 'color' | 'fill', preference?: SelectionRangePreference) {
    const state = useApp.getState(), summary = state.summary;
    return resolvedSelectionRangeFields(preference ?? (tool === 'fill' ? state.fillRange : state.colorRange),
      summary?.loaded && summary.kind === 0 ? validateMorphologyRange(summary.morphologyRange) : null);
  }
  setSelectionRangeEnabled(enabled: boolean, tool: 'color' | 'fill' = useApp.getState().tool === 'fill' ? 'fill' : 'color') {
    if (typeof enabled !== 'boolean' || !this.selectionRangeControlsEnabled || useApp.getState().tool !== tool) return;
    const state = useApp.getState(), before = tool === 'fill' ? state.fillRange : state.colorRange;
    if (before.enabled === enabled) return;
    const preference = validateSelectionRangePreference({ ...before, enabled });
    setApp(tool === 'fill' ? { fillRange: preference } : { colorRange: preference });
    if (enabled) this.morphologyRangeFailure = undefined;
    this.queueToleranceUpdate('range'); this.invalidate();
    if (enabled && !this.selectionRangeBounds(tool)) void this.ensureSelectionRangeBounds();
  }
  setSelectionRangeRadius(radius: number | null, tool: 'color' | 'fill' = useApp.getState().tool === 'fill' ? 'fill' : 'color') {
    if (radius !== null && (!Number.isFinite(radius) || radius <= 0) || !this.selectionRangeControlsEnabled || useApp.getState().tool !== tool) return;
    const state = useApp.getState(), before = tool === 'fill' ? state.fillRange : state.colorRange;
    if (before.radius === radius) return;
    const preference = validateSelectionRangePreference({ ...before, radius });
    setApp(tool === 'fill' ? { fillRange: preference } : { colorRange: preference });
    this.queueToleranceUpdate('range'); this.invalidate();
  }
  get selectionRangePreview(): Readonly<{ center: readonly [number, number, number]; radius: number }> | undefined {
    const owner = this.tolerance, state = useApp.getState(), range = state.summary?.toleranceRange;
    if (!owner?.active || !this.toleranceCurrent(owner, false) || state.summary?.toleranceSessionId !== owner.id ||
        !range?.center || !(owner.tool === 'fill' ? state.fillRange : state.colorRange).enabled) return undefined;
    const bounds = this.selectionRangeBounds(owner.tool);
    return bounds ? Object.freeze({ center: range.center, radius: bounds.value }) : undefined;
  }
  get selectionMorphologyRange(): Readonly<{ minimum: number; maximum: number; value: number }> | null {
    const summary = useApp.getState().summary;
    if (!summary?.loaded || summary.kind !== 0) return null;
    const range = validateMorphologyRange(summary.morphologyRange);
    if (!range) return null;
    const stored = useApp.getState().selectionDistance;
    const value = stored === null ? range.default : selectionDistance(stored, range);
    return value === null ? null : Object.freeze({ minimum: range.minimum, maximum: range.maximum, value });
  }
  get selectionMorphologyVolumeEnabled() { return this.morphologyControlsReady() && this.selectionMorphologyRange !== null; }
  private morphologyDistanceCurrent(command: SceneCommand) {
    if (command.method !== 'volume') return true;
    const range = this.selectionMorphologyRange, distance = typeof command.distance === 'number' ? Math.fround(command.distance) : NaN;
    return !!range && Number.isFinite(distance) && distance >= range.minimum && distance <= range.maximum;
  }
  setSelectionMorphologyMethod(method: SelectionMorphologyMethod) {
    if (!this.morphologyControlsReady() || method !== 'volume' && method !== 'sigma') return;
    if (method === 'volume') this.morphologyRangeFailure = undefined;
    if (method !== useApp.getState().selectionMorphologyMethod) setApp({ selectionMorphologyMethod: method });
    if (method === 'volume') void this.ensureSelectionMorphologyRange();
  }
  setSelectionDistance(value: number | null) {
    if (!this.morphologyControlsReady() || !this.selectionMorphologyRange) return;
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || !Number.isFinite(Math.fround(value)) || Math.fround(value) <= 0)) return;
    const distance = value === null ? null : Math.fround(value);
    if (distance !== useApp.getState().selectionDistance) setApp({ selectionDistance: distance });
  }
  ensureSelectionMorphologyRange(): Promise<boolean> { return this.queryMorphologyRange(false); }
  private queryMorphologyRange(ownedBarrier: boolean): Promise<boolean> {
    if (this.morphologyRangeOwner) return this.morphologyRangeOwner.task;
    if (this.selectionMorphologyRange) return Promise.resolve(true);
    const client = this.client, scene = this.scene, state = useApp.getState(), before = state.summary;
    if (!client || scene?.kind !== 'gaussian' || !before?.loaded || before.kind !== 0 || !this.morphologyControlsReady(ownedBarrier)) return Promise.resolve(false);
    const failure = this.morphologyRangeFailure;
    if (failure?.client === client && failure.generation === this.generation && sameRevision(failure.revision, client.revision)) return Promise.resolve(false);
    let finish!: () => void;
    const owner: MorphologyRangeOwner = { client, scene, generation: this.generation, revision: { ...client.revision },
      cancel: new AbortController(), finished: new Promise<void>(resolve => { finish = resolve; }), task: undefined! };
    this.morphologyRangeOwner = owner;
    const sameSource = () => this.morphologyRangeOwner === owner && client === this.client && scene === this.scene &&
      owner.generation === this.generation && !this.destroyed && !this.closing && !this.closeRequest;
    const coverage = this.nativeCoverage.get(client);
    let work: ResourceLease | undefined, covered = false;
    const task = Promise.resolve().then(async () => {
      try {
        await this.joinAutomaticTransformPivot();
        owner.cancel.signal.throwIfAborted(); if (!sameSource()) return false;
        client.assertNativeAdmission(); work = this.ledger.reserve('work', MORPHOLOGY_RANGE_WORK_BYTES);
        client.updateNativeCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]); covered = true;
        if (coverage) coverage.work = work; client.setNativeWork(work);
        const updated = await client.command({ command: 'morphologyRange' }, owner.cancel.signal);
        owner.cancel.signal.throwIfAborted(); if (!sameSource()) return false;
        const range = validateMorphologyRange(updated.morphologyRange);
        // A readonly job has no edit checkpoint to roll back. Certify every
        // document/retained-owner field, including maps, camera and history;
        // only query metadata and progress may differ at its joined terminal.
        const unchanged = (value: NativeSummary) => Object.fromEntries(Object.entries(value).filter(([key, field]) =>
          field !== undefined && !['ok', 'error', 'progress', 'morphologyRange'].includes(key)));
        if (!range || !sameRevision(owner.revision, client.revision) || updated.pending || updated.sceneChanged ||
            canonicalJson(unchanged(updated)) !== canonicalJson(unchanged(before))) {
          this.editingFailed = true;
          throw new Error('The selection reach query did not preserve its captured document and edit owners.');
        }
        setApp({ summary: { ...updated, morphologyRange: range } }); this.morphologyRangeFailure = undefined; return true;
      } catch (error) {
        if (sameSource()) {
          this.morphologyRangeFailure = { client, generation: owner.generation, revision: { ...client.revision } };
          if (!owner.cancel.signal.aborted) this.error(error);
        }
        return false;
      } finally {
        try {
          client.setNativeWork(undefined); if (coverage && coverage.work === work) coverage.work = undefined;
          if (work) { if (client.failed) await client.retireNativeMemory(); if (covered && !client.failed) client.releaseNativeCoverage(work); else work(); }
        } finally {
          if (this.morphologyRangeOwner === owner) {
            this.morphologyRangeOwner = undefined;
            if (client === this.client && !this.destroyed && !this.closing && !this.recovery) setApp({ busy: false, stage: '' });
          }
          finish();
        }
      }
    });
    // Pro can request this statistic automatically after another operation
    // fails. Measuring it does not acknowledge that operation's error.
    owner.task = task; setApp({ busy: true, stage: 'Measuring selection reach' }); return task;
  }
  private cancelMorphologyRange(): Promise<void> {
    const owner = this.morphologyRangeOwner;
    if (!owner) return Promise.resolve();
    owner.cancel.abort(); return owner.finished;
  }
  setSelectionSigma(value: number) {
    if (!this.morphologyControlsReady()) return;
    const sigma = selectionSigma(value);
    if (sigma !== null && sigma !== useApp.getState().selectionSigma) setApp({ selectionSigma: sigma });
  }
  setSelectionOperation(operation: number) {
    if (this.selectionAction) return;
    if (this.filterOwner) { this.setFilterOperation(operation); return; }
    if (this.selectionCleanupOwner || !Number.isInteger(operation) || operation < 0 || operation > 3) return;
    setSelectionPreferences({ operation });
    const selection = this.selection, polygon = selection?.polygon, generation = this.generation;
    // Deferred presses retain the operation recorded at physical admission.
    // The toolbar preference still changes for later presses, without
    // replacing this baseline or asking App to rewrite its captured outline.
    if (selection?.deferredOptions) return;
    if (selection && polygon && polygon.operation !== operation) {
      const requested = polygon.liveRequested, state = useApp.getState();
      polygon.operation = operation;
      // A requested desktop worker is stopped/recreated by Combine using the
      // profile visible at assignment. Capture it before awaited rollback;
      // later profile restoration cannot change this replacement's options.
      polygon.liveRequested = requested && state.live;
      polygon.capturedOverlap = polygon.liveRequested ? state.overlap : undefined;
      polygon.publishedRevision = 0;
      const command = polygon.liveRequested && polygon.shape ? this.polygonCommand(polygon.shape, polygon) : undefined;
      void selection.session.restart(operation, command).then(() => this.settleSelectionPublication(selection, generation));
    } else if (selection && !polygon) {
      selection.session.setOperation(operation);
      void selection.session.flush().then(() => this.settleSelectionPublication(selection, generation));
    }
    this.onSelectionOperationChanged?.(operation);
  }
  get editingAvailable() {
    return !this.filterOwner && !this.transformBlocksOrdinary && !this.opacityBlocksOrdinary && this.filterBaseAvailable();
  }
  private get manualSelectionActionsReady() {
    const state = useApp.getState();
    return !this.selectionAction && !!state.tool && this.editingAvailable && !this.transformOwner && !this.opacityOwner &&
      !this.opacityEntryTask && !this.exporting && !this.selectionBarriers && !state.settingsOpen && !state.exportOpen &&
      !state.outputPending && !state.viewTransferPending && !state.thumbnailPending && !state.savedViewChoices.length &&
      (!state.busy || !!this.selection || !!this.releasedSelections.length || !!this.tolerance?.applying);
  }
  /** One viewer-owned subscription, paired with the App lifecycle. Manual
   * tool/profile switches keep the desktop's continuous session boundary. */
  trackManualSelectionHistory(): () => void {
    const token = {}; this.manualSelectionHistoryWatch = token;
    const observe = (state: ReturnType<typeof useApp.getState>) => {
      if (this.manualSelectionHistoryWatch !== token) return;
      if (!state.tool) { this.manualSelectionHistory = undefined; return; }
      const client = this.client, scope = this.manualSelectionHistory;
      if (client && scope?.client === client && scope.documentId === client.revision.documentId &&
        scope.sourceGeneration === client.revision.sourceGeneration) return;
      this.manualSelectionHistory = undefined;
      const summary = state.summary;
      if (client && summary?.loaded && summary.kind === 0 && Number.isSafeInteger(summary.revision) && summary.revision >= 0)
        this.manualSelectionHistory = { client, documentId: client.revision.documentId,
          sourceGeneration: client.revision.sourceGeneration, startRevision: summary.revision };
    };
    observe(useApp.getState());
    const unwatch = useApp.subscribe(observe);
    return () => {
      unwatch();
      if (this.manualSelectionHistoryWatch === token) { this.manualSelectionHistoryWatch = undefined; this.manualSelectionHistory = undefined; }
    };
  }
  private get manualSelectionHistoryUndoable() {
    const state = useApp.getState(), scope = this.manualSelectionHistory, summary = state.summary, client = this.client;
    return !!state.tool && !!client && !!scope && scope.client === client && scope.documentId === client.revision.documentId &&
      scope.sourceGeneration === client.revision.sourceGeneration && summary?.loaded === true && summary.kind === 0 &&
      !summary.selectionDraft && summary.canUndo && Number.isSafeInteger(summary.undoSelectionRevision) &&
      summary.undoSelectionRevision! <= summary.revision && summary.undoSelectionRevision! > scope.startRevision;
  }
  get manualSelectionActionsVisible() {
    const state = useApp.getState();
    return !!state.tool && !this.filterOwner && ((state.summary?.selected ?? 0) > 0 || this.selectionActive ||
      state.pendingSelectionCount > 0 || !!this.tolerance?.applying || !!this.tolerance?.waitingMap || this.manualSelectionHistoryUndoable);
  }
  get manualSelectionFinishEnabled() { return this.manualSelectionActionsReady && !useApp.getState().selectionDragging; }
  get manualSelectionUndoEnabled() {
    return this.manualSelectionActionsReady && (this.selectionActive || this.releasedSelections.length > 0 ||
      !!this.tolerance?.applying || !!this.tolerance?.waitingMap || !!useApp.getState().summary?.canUndo);
  }
  get manualSelectionClearEnabled() {
    return this.manualSelectionActionsReady && (this.selectionActive || this.releasedSelections.length > 0 ||
      !!this.tolerance?.applying || !!this.tolerance?.waitingMap ||
      (useApp.getState().summary?.selected ?? 0) > 0);
  }
  private async runSelectionAction(run: (current: () => boolean, token: object) => Promise<boolean>): Promise<boolean> {
    if (this.selectionAction || !this.client) return false;
    const token = {}, client = this.client, generation = this.generation, tool = useApp.getState().tool;
    const { documentId, sourceGeneration } = client.revision;
    const current = () => this.selectionAction === token && this.client === client && this.generation === generation &&
      client.revision.documentId === documentId && client.revision.sourceGeneration === sourceGeneration &&
      useApp.getState().tool === tool && this.filterBaseAvailable();
    this.selectionAction = token; this.selectionBarriers++; this.camera?.clearInput();
    setApp({ selectionActionPending: true, autoOrbit: false });
    try { return await run(current, token); }
    catch (error) { if (this.client === client && generation === this.generation) this.error(error); return false; }
    finally {
      if (this.selectionAction === token) { this.selectionAction = undefined; setApp({ selectionActionPending: false }); }
      this.releaseSelectionBarrier(); this.invalidate();
    }
  }
  finishManualSelection(): Promise<boolean> {
    if (!this.manualSelectionFinishEnabled) return Promise.resolve(false);
    return this.runSelectionAction(async current => {
      if (this.selectionActive) return false;
      await Promise.all([...this.pendingTolerancePicks]); await this.releasedDrain;
      await this.tolerance?.session.flush();
      if (!current() || !await this.settleColorSession() || !current()) return false;
      await this.closeToleranceSelection();
      const summary = useApp.getState().summary;
      if (!current() || !summary || !selectionRestored(summary) || summary.toleranceSessionId != null) return false;
      setApp({ tool: null, fly: false, autoOrbit: false }); return true;
    });
  }
  clearManualSelection(): Promise<boolean> {
    if (!this.manualSelectionClearEnabled) return Promise.resolve(false);
    return this.runSelectionAction(async current => {
      if (!await this.cancelSelectionGesture() || !current()) return false;
      await this.closeToleranceSelection();
      const summary = useApp.getState().summary;
      if (!current() || !summary || !selectionRestored(summary) || summary.toleranceSessionId != null ||
        !await this.settleColorSession() || !current()) return false;
      if (!await this.executeCommand({ command: 'selectNone' }, current) || !current()) return false;
      return true;
    });
  }
  undoManualSelection(): Promise<boolean> {
    if (!this.manualSelectionUndoEnabled) return Promise.resolve(false);
    return this.runSelectionAction(async current => {
      if (this.selectionActive) return this.cancelSelectionGesture(false);
      const tail = this.releasedSelections.at(-1);
      let recorded: boolean | undefined;
      if (tail) {
        tail.cancel.abort();
        if (tail.owner && tail.owner === this.tolerance && this.editOperation?.tolerance) this.cancelEdit();
        await tail.settled;
        if (!current()) return false;
        const summary = useApp.getState().summary;
        recorded = !!tail.owner && summary?.toleranceSessionId === tail.owner.id && summary.toleranceRecorded === true && this.manualSelectionHistoryUndoable;
        if (!recorded) return true;
      } else if (this.tolerance?.applying || this.tolerance?.waitingMap) {
        const owner = this.tolerance;
        owner.session.discardPending(); owner.mapQuery?.abort(); this.cancelEdit();
        await owner.session.flush();
        if (!current()) return false;
        const summary = useApp.getState().summary;
        recorded = summary?.toleranceSessionId === owner.id && summary.toleranceRecorded === true && this.manualSelectionHistoryUndoable;
      }
      await this.closeToleranceSelection();
      const summary = useApp.getState().summary;
      if (!current() || !summary || !selectionRestored(summary) || summary.toleranceSessionId != null) return false;
      if (recorded === false) return true;
      if (!await this.settleColorSession() || !current() || !useApp.getState().summary?.canUndo ||
        !await this.executeCommand({ command: 'undo' }, current)) return false;
      return true;
    });
  }
  private get transformBlocksOrdinary() {
    const owner = this.transformOwner;
    return !!owner && (this.transformDirty || this.transformPending || !!this.transformGizmoGesture || owner.phase !== 'ready');
  }
  beginSelectionGesture(operation?: number, options?: DeferredSelectionOptions) {
    return this.beginGesture(operation, false, options);
  }
  beginPolygonGesture(operation: number, options?: DeferredSelectionOptions) {
    return this.beginGesture(operation, true, options);
  }
  private beginGesture(operation?: number, polygon = false, options?: DeferredSelectionOptions) {
    if (this.filterOwner || this.transformOwner || this.opacityOwner || this.opacityEntryTask || this.selection || this.cancellingSelection || this.selectionCleanupOwner || this.scene?.kind !== 'gaussian' || !this.client || !this.camera || !this.renderer ||
      this.renderer.lost || this.recovery || this.closing || this.closeRequest || useApp.getState().navigationPrompt ||
      this.editingFailed || this.destroyed || this.selectionBarriers || this.exporting || this.colorBoundary ||
      useApp.getState().busy) return false;
    try { this.client.assertNativeAdmission(); }
    catch (error) { this.error(error); return false; }
    this.endToleranceSelection();
    setApp({ autoOrbit: false });
    const state = useApp.getState(), initialOperation = operation ?? (options ? state.operation : undefined);
    const deferredOptions = options ? Object.freeze({ live: options.live, overlap: options.overlap, visibleOnly: options.visibleOnly,
      colorTolerance: options.colorTolerance, fillTolerance: options.fillTolerance, connectedColor: options.connectedColor,
      currentViewOnly: options.currentViewOnly ?? state.currentViewOnly }) : undefined;
    const selection: GestureSelection = { session: undefined!, client: this.client, cameraRevision: this.camera.revision,
      optionsRevision: state.selectionOptionsRevision, deferredOptions, deferredTool: options ? state.tool : undefined,
      selectionView: this.captureSelectionView(options?.currentViewOnly ?? state.currentViewOnly),
      deferredPointer: options ? this.deferredColorPointer?.token : undefined,
      operationRevision: 0, cancel: new AbortController() };
    if (polygon) selection.polygon = { operation: initialOperation ?? state.operation, liveRequested: false,
      shapeRevision: 0, publishedRevision: 0 };
    selection.session = new SelectionSession((command, livePreview) => this.runSelectionCommand(selection, command, livePreview), () => {
      if (this.selection === selection) { selection.operationRevision++; this.cancelEdit(); }
    }, initialOperation, polygon, () => {
      const epoch = selection.liveFailure;
      if (!epoch || this.selection !== selection || selection.client !== this.client ||
          this.generation !== epoch.generation || this.client.revision.documentId !== epoch.documentId ||
          selection.operationRevision !== epoch.operationRevision || selection.cancel.signal.aborted || this.destroyed) return;
      selection.liveFailure = undefined;
      // The requested desktop worker has stopped before baseline restoration
      // begins. Keep the gesture and its outline for a later vertex/final pass.
      if (selection.polygon) {
        selection.polygon.liveRequested = false;
        selection.polygon.capturedOverlap = undefined;
        selection.polygon.publishedRevision = 0;
      }
    });
    this.selection = selection;
    return true;
  }
  private async runSelectionCommand(selection: GestureSelection, command: SceneCommand, livePreview = false): Promise<SelectionRunResult> {
    command = this.scopedCommand(command, selection.selectionView);
    const options = selection.deferredOptions;
    if (options && ['polygon', 'rectangle', 'brush', 'volume'].includes(command.command)) command = {
      ...command, overlap: options.overlap,
      visibleOnly: (command.command === 'brush' || command.command === 'volume') && options.visibleOnly,
    };
    await this.toleranceCleanup;
    // Begin/cancel have no preview-current predicate. Bind them to their actual
    // document and retained owner, so late cleanup cannot mutate a replacement.
    if (selection.client !== this.client || this.destroyed ||
        this.selection !== selection && this.selectionCleanupOwner?.selection !== selection) return false;
    if (command.command === 'beginSelection' && this.needsColorSettlement && !await this.settleColorSession()) return false;
    if (selection.client !== this.client || this.destroyed ||
      this.selection !== selection && this.selectionCleanupOwner?.selection !== selection) return false;
    const selectionClient = this.client, generation = this.generation, documentId = selectionClient.revision.documentId;
    const mapped = command.command === 'volume' || command.command === 'brush' && command.visibleOnly === true;
    const preview = !['beginSelection', 'confirmSelection', 'cancelSelection'].includes(command.command);
    const operationRevision = selection.operationRevision;
    const previewCurrent = () => this.selection === selection && !selection.cancel.signal.aborted &&
      selectionClient === this.client && this.generation === generation && selectionClient.revision.documentId === documentId &&
      selection.operationRevision === operationRevision && this.camera?.revision === selection.cameraRevision &&
      (options !== undefined || useApp.getState().selectionOptionsRevision === selection.optionsRevision) &&
      (selection.deferredTool === undefined || useApp.getState().tool === selection.deferredTool) && !this.destroyed && !this.recovery;
    const nativeLivePreview = livePreview && ['polygon', 'rectangle', 'brush', 'volume'].includes(command.command);
    const refused = (error: unknown) => {
      // A physical failure stays fatal even if Combine superseded its request.
      // Only an actual cancellation may restart the same gesture baseline.
      selection.session.fail();
      if (this.selection === selection && this.client === selectionClient && this.generation === generation) this.error(error);
    };
    const result = (accepted: SelectionRunResult): SelectionRunResult => {
      if (accepted !== true && accepted !== false) {
        if (!previewCurrent()) return false;
        selection.liveFailure = { generation, documentId, operationRevision };
      }
      return accepted;
    };
    if (!mapped) {
      const accepted = await this.executeEditCommand(command, preview || command.command === 'confirmSelection' ? previewCurrent : undefined, false,
        refused, command.command === 'cancelSelection' ? selection : undefined, nativeLivePreview);
      if (command.command !== 'cancelSelection' || accepted !== true) return result(accepted);
      const summary = useApp.getState().summary;
      return !!summary && selectionRestored(summary);
    }
    const client = this.client, renderer = this.renderer, scene = this.scene, camera = this.camera;
    const current = () => previewCurrent() &&
      client === this.client && renderer === this.renderer && scene === this.scene && camera === this.camera &&
      !!camera && camera.revision === selection.cameraRevision &&
      useApp.getState().tool === command.command && !this.destroyed && !this.recovery;
    try {
      if (!current()) return false;
      const dimensions = renderer ? surfaceDimensions(renderer.canvas.width, renderer.canvas.height) : undefined;
      const region = command.command === 'volume' && command.visibleOnly !== true && renderer && dimensions &&
        Array.isArray(command.points) && command.width === renderer.canvas.width && command.height === renderer.canvas.height ? volumeSurfaceRegion({
          points: command.points, viewportWidth: command.width, viewportHeight: command.height,
          mapWidth: dimensions.width, mapHeight: dimensions.height,
        }) : undefined;
      const map = await this.selectionMap({ visible: command.visibleOnly === true, region }, selection.cancel.signal);
      const valid = () => {
        if (!current()) return false;
        try { map.assertCurrent(); return true; } catch { return false; }
      };
      if (!valid()) return false;
      return result(await this.executeEditCommand({ ...command, mapId: map.mapId }, valid, false, refused, undefined, nativeLivePreview));
    } catch (error) {
      if (!(error instanceof StaleRenderQueryError) && !(error instanceof DOMException && error.name === 'AbortError')) refused(error);
      return false;
    }
  }
  previewSelection(command: SceneCommand) {
    const selection = this.selection, generation = this.generation;
    if (!selection) return;
    selection.session.update(command);
    void selection.session.flush().then(() => this.settleSelectionPublication(selection, generation));
  }
  private polygonShapeKey(command: SceneCommand) {
    // Options/Combine belong to the captured worker. Readiness belongs to the
    // exact final outline and view, even when two different shapes hit the
    // same source IDs.
    return JSON.stringify([command.camera, command.width, command.height, command.points]);
  }
  private polygonCommand(command: SceneCommand, polygon: NonNullable<GestureSelection['polygon']>) {
    return { ...command, command: 'polygon', operation: polygon.operation,
      overlap: polygon.capturedOverlap ?? useApp.getState().overlap, visibleOnly: false };
  }
  private recordPolygonPublication(selection: GestureSelection) {
    const polygon = selection.polygon;
    if (polygon && selection.session.complete && selection.session.appliedCommand &&
      this.polygonShapeKey(selection.session.appliedCommand) === polygon.shapeKey)
      polygon.publishedRevision = polygon.shapeRevision;
  }
  private async settleSelectionPublication(selection: GestureSelection, generation: number) {
    if (this.selection !== selection || this.generation !== generation) return;
    this.recordPolygonPublication(selection);
    if (!selection.session.hasFailed) return;
    if (selection.session.restorationFailed) {
      // The drain already tried this exact restoration. Keep its authority for
      // explicit Restore selection; publication settlement must not retry it.
      this.retireFinishedSelection(selection);
      setApp({ selectionDragging: false, selectionOperation: null });
      return;
    }
    // The session drain has already joined rollback and restored the original
    // baseline. Retire its exact UI owner outside that drain, so cancellation
    // cannot wait on itself or clear a newer gesture/document. A fatal command
    // refusal has no final fallback and must not consume the next Undo/Redo.
    const cleanup = this.cancelSelectionGesture(false);
    setApp({ selectionDragging: false, selectionOperation: null });
    await cleanup;
  }
  get polygonSelectionState() {
    const selection = this.selection, polygon = selection?.polygon;
    if (!selection || !polygon) return;
    const exact = selection.session.appliedCommand && this.polygonShapeKey(selection.session.appliedCommand) === polygon.shapeKey;
    const complete = polygon.liveRequested && !!exact && selection.session.complete;
    return { liveRequested: polygon.liveRequested, pending: selection.session.pending, complete,
      failed: selection.session.hasFailed, computationFailed: selection.session.computationFailed, shapeRevision: polygon.shapeRevision,
      publishedRevision: complete ? polygon.shapeRevision : polygon.publishedRevision,
      capturedOverlap: polygon.capturedOverlap };
  }
  async updatePolygon(command: SceneCommand, vertex = false): Promise<void> {
    const selection = this.selection, polygon = selection?.polygon, generation = this.generation;
    if (!selection || !polygon || selection.session.closed) return;
    const shapeKey = this.polygonShapeKey(command), changed = shapeKey !== polygon.shapeKey;
    if (changed) {
      // App commands own fresh arrays. Retain an immutable snapshot so the
      // worker's final identity cannot change with the visible cursor/profile.
      polygon.shape = structuredClone(command); polygon.shapeKey = shapeKey; polygon.shapeRevision++;
    }
    let requested = false;
    if (!polygon.liveRequested && vertex && (selection.deferredOptions?.live ?? useApp.getState().live)) {
      selection.session.resumePreview();
      polygon.liveRequested = true; polygon.capturedOverlap = selection.deferredOptions?.overlap ?? useApp.getState().overlap; requested = true;
    }
    if (polygon.liveRequested && polygon.shape && (changed || requested))
      selection.session.update(this.polygonCommand(polygon.shape, polygon));
    await selection.session.flush();
    await this.settleSelectionPublication(selection, generation);
  }
  async finishPolygonGesture(command: SceneCommand): Promise<boolean> {
    const selection = this.selection, polygon = selection?.polygon;
    if (!selection || !polygon || selection.session.closed) return false;
    const finalKey = this.polygonShapeKey(command);
    // Check readiness synchronously after recording the final outline. Do not
    // turn a pending final shape into a captured-options success by awaiting a
    // new preview: desktop instead stops that worker and evaluates current
    // profile options from the original baseline. A deferred physical press
    // instead retains its admitted profile for this fallback as well.
    const ready = polygon.liveRequested && selection.session.complete && !!selection.session.appliedCommand &&
      this.polygonShapeKey(selection.session.appliedCommand) === finalKey;
    if (finalKey !== polygon.shapeKey) {
      polygon.shape = structuredClone(command); polygon.shapeKey = finalKey; polygon.shapeRevision++;
    }
    const final = { ...command, command: 'polygon', operation: polygon.operation,
      overlap: selection.deferredOptions?.overlap ?? useApp.getState().overlap, visibleOnly: false };
    try { return await (ready ? selection.session.confirm() : selection.session.finishFromBaseline(final)); }
    finally { this.retireFinishedSelection(selection); }
  }
  previewSinglePixel(x: number, y: number, operation: number) {
    const selection = this.selection;
    return selection?.session.updateQuery(() => this.singleSelectionQuery(selection, x, y, operation));
  }
  async finishSinglePixel(x: number, y: number, operation: number): Promise<boolean> {
    const selection = this.selection;
    if (!selection || selection.session.closed) return false;
    try { return await selection.session.finishQuery(() => this.singleSelectionQuery(selection, x, y, operation)); }
    finally { this.retireFinishedSelection(selection); }
  }
  async confirmSelectionGesture(): Promise<boolean> {
    const selection = this.selection;
    if (!selection || selection.session.closed) return false;
    try { return await selection.session.confirm(); }
    finally { this.retireFinishedSelection(selection); }
  }
  private async singleSelectionQuery(selection: NonNullable<AppController['selection']>, x: number, y: number, operation: number) {
    const renderer = this.renderer, scene = this.scene, camera = this.camera, client = this.client;
    if (this.selection !== selection || !renderer || !scene || scene.kind !== 'gaussian' || !camera || !client || renderer.lost || this.recovery) return;
    const revision = camera.revision, content = { ...client.revision }, state = useApp.getState(), grade = state.grade.join(',');
    const current = () => this.selection === selection && renderer === this.renderer && !renderer.lost && scene === this.scene &&
      camera === this.camera && client === this.client && camera.revision === revision && sameRevision(content, client.revision) &&
      useApp.getState().tool === 'single' && useApp.getState().grade.join(',') === grade && !this.recovery && !this.destroyed;
    try {
      client.assertNativeAdmission();
      const pendingRender = renderer.render(scene, camera, state.grade, true, IDENTITY_MATRIX, this.colorScope);
      if (pendingRender) await pendingRender;
      const hit = await renderer.pick(scene, x, y);
      if (current() && hit.deviceEpoch === renderer.deviceEpoch) return this.scopedCommand({ command: 'single', index: hit.index, operation }, selection.selectionView);
    } catch (error) { if (!(error instanceof StaleRenderQueryError) && current()) this.error(error); }
  }
  async finishSelectionGesture(command: SceneCommand) {
    const selection = this.selection;
    if (!selection || selection.session.closed) return false;
    try { return await selection.session.finish(command); }
    finally { this.retireFinishedSelection(selection); }
  }
  private retainSelectionCleanup(selection: GestureSelection) {
    if (!this.selectionCleanupOwner) this.selectionCleanupOwner = {
      selection, client: selection.client, documentId: selection.client.revision.documentId,
    };
    return this.selectionCleanupOwner;
  }
  private requireSelectionCleanup(owner: SelectionCleanupOwner) {
    if (this.selectionCleanupOwner !== owner || this.destroyed) return;
    owner.error = useApp.getState().error ?? 'Selection could not be restored. Editing and saving are paused. Choose Restore selection to try again.';
    setApp({ selectionRecovery: 'required', selectionDragging: false, selectionOperation: null, error: owner.error });
  }
  private retireFinishedSelection(selection: GestureSelection) {
    if (this.selection !== selection) return;
    this.selection = undefined;
    this.queueTransformPivotSynchronization();
    if (!selection.session.cleanupNeeded) return;
    selection.cancel.abort();
    // Finish already attempted restoration. Retain its authority without
    // silently issuing a second cancellation or replaying the failed edit.
    this.requireSelectionCleanup(this.retainSelectionCleanup(selection));
  }
  private attemptSelectionCleanup(owner: SelectionCleanupOwner): Promise<boolean> {
    if (owner.attempt) return owner.attempt;
    if (this.selectionCleanupOwner !== owner || owner.client !== this.client ||
        owner.documentId !== this.client.revision.documentId || this.destroyed) return Promise.resolve(false);
    this.cancellingSelection = true;
    // Successful restoration can belong to an ongoing Single press outside
    // its click radius. Preserve that UI owner for reentry; refused cleanup
    // retires it through requireSelectionCleanup instead.
    setApp({ selectionRecovery: 'restoring' });
    const task = (async () => {
      let restored = false;
      try { restored = await owner.selection.session.cancel(); }
      catch (error) { this.error(error); }
      if (this.selectionCleanupOwner !== owner || owner.client !== this.client || owner.documentId !== this.client.revision.documentId || this.destroyed) return false;
      if (restored && !owner.selection.session.cleanupNeeded && !this.editingFailed) {
        owner.restored = true; this.selectionCleanupOwner = undefined;
        setApp({ selectionRecovery: 'idle', ...(owner.error && useApp.getState().error === owner.error ? { error: null } : {}) });
        return true;
      }
      this.requireSelectionCleanup(owner);
      return false;
    })().finally(() => {
      if (owner.attempt === task) owner.attempt = undefined;
      if (!this.selectionCleanupOwner || this.selectionCleanupOwner === owner) this.cancellingSelection = false;
    });
    owner.attempt = task; this.selectionCleanup = task.then(() => undefined);
    return task;
  }
  retrySelectionCleanup(): Promise<boolean> {
    if (this.filterOwner?.phase === 'required') return this.cancelFilter();
    const owner = this.selectionCleanupOwner;
    return owner ? this.attemptSelectionCleanup(owner) : Promise.resolve(true);
  }
  async cancelSelectionGesture(clearReleased = true): Promise<boolean> {
    const selection = this.selection;
    const releasedCleanup = clearReleased ? this.cancelReleasedSelections() : Promise.resolve();
    if (clearReleased && this.tolerance?.applying && !this.tolerance.active) this.cancelEdit();
    // Windows discards a completed owner's waiting first RGB upgrade on
    // default cancellation. Its committed selection/history and requested
    // Connected preference survive; later tolerance input needs a new pick.
    const toleranceCleanup = clearReleased && this.tolerance?.waitingMap ? this.closeToleranceSelection() : Promise.resolve();
    if (selection?.session.restorationFailed) {
      // View/blur/command cancellation can overtake post-drain settlement.
      // It may retain failed cleanup, but only Restore selection retries it.
      this.retireFinishedSelection(selection);
      await Promise.all([releasedCleanup, toleranceCleanup, this.selectionCleanup]);
      return false;
    }
    if (!selection) {
      const owner = this.selectionCleanupOwner, cleanup = this.selectionCleanup;
      await Promise.all([releasedCleanup, toleranceCleanup, cleanup]);
      // An older waiter observes its own result, without touching a newer
      // gesture admitted after successful restoration. Failed cleanup needs
      // explicit retry, rather than another view/blur/invalidation loop.
      return !owner || owner.restored === true;
    }
    // Clear ownership immediately so a restored mask cannot repeatedly trigger
    // cancellation when the view/tool changes during an awaited update.
    const owner = this.retainSelectionCleanup(selection);
    this.selection = undefined; this.cancelEdit();
    selection.cancel.abort();
    const cleanup = this.attemptSelectionCleanup(owner);
    const [restored] = await Promise.all([cleanup, releasedCleanup, toleranceCleanup]);
    return restored;
  }
  cancelEdit() {
    if (this.transformPivotQuery) { this.transformPivotQuery.cancel.abort(); return; }
    if (this.morphologyRangeOwner) { this.morphologyRangeOwner.cancel.abort(); return; }
    // Escape can cancel the gesture and then the operation in the same event.
    // Once strict baseline cleanup owns the edit, both calls must join it.
    if (this.selection?.session.restoring || this.selectionCleanupOwner?.selection.session.restoring) return;
    if (!this.editOperation?.committing) { this.editOperation?.cancel.abort(); this.client?.cancel(); }
  }
  cancelOperation() { this.cancelDeferredColorPointers(); if (this.recoveryCancel) this.recoveryCancel.abort(); else if (this.exportOperation) this.exportOperation.cancel.abort();
    else if (this.candidate || this.loadAbort || this.intake) this.cancelLoad();
    else if (this.filterOwner || this.opacityOwner) { this.cancelEdit(); }
    else if (this.floorOwner || this.floorPreparing) this.cancelAlignment(); else { this.cancelEdit(); void this.cancelSelectionGesture(); } }
  cancelExport() { this.exportOperation?.cancel.abort(); }
  private alignmentReady(ownedBarrier = false): boolean {
    const state = useApp.getState();
    return !!this.client && this.scene?.kind === 'gaussian' && !!this.camera && !!this.renderer &&
      !this.renderer.lost && state.rendererState === 'ready' && !!state.summary?.alignment &&
      !state.busy && !state.navigationPrompt && !state.outputPending && !state.exportOpen && !state.settingsOpen &&
      !state.viewTransferPending && state.savedViewChoices.length === 0 &&
      state.alignmentFloor?.phase !== 'cancelling' &&
      state.selectionRecovery === 'idle' && state.memoryOverageBytes === 0 &&
      !this.destroyed && !this.closing && !this.closeRequest && !this.recovery && !this.editingFailed &&
      !this.exporting && !this.selectionCleanupOwner && !this.filterOwner && !this.transformBlocksOrdinary && !this.opacityBlocksOrdinary && !this.floorOwner?.detecting &&
      (ownedBarrier || !this.selectionBarriers);
  }
  get alignmentControlsEnabled() { return this.alignmentReady(); }
  get alignmentPlaneControlsEnabled() {
    return this.alignmentReady() && BUILD_DESCRIPTOR.native.core.capabilities.alignment >= 3;
  }
  get floorDetectionEnabled() {
    return this.alignmentReady() && !this.alignmentConfirming && BUILD_DESCRIPTOR.native.core.capabilities.alignment >= 4;
  }
  get floorCandidateReady() {
    const owner = this.floorOwner;
    return !!owner && !owner.detecting && owner.candidate?.status === 'ready' && this.floorCurrent(owner) &&
      useApp.getState().alignmentFloor?.phase === 'candidate' && sameRevision(owner.revision, owner.client.revision) &&
      this.alignmentReady() && !this.alignmentConfirming;
  }
  get cameraNavigationEnabled() {
    const state = useApp.getState(), owner = this.floorOwner;
    return !this.destroyed && !this.recovery && !this.editOperation && !this.closing && !this.closeRequest && !this.filterGizmoGesture && !this.transformGizmoGesture &&
      !!this.camera && !!this.renderer && !this.renderer.lost && state.rendererState === 'ready' &&
      !state.settingsOpen && !state.exportOpen && !state.navigationPrompt && !state.outputPending &&
      !state.viewTransferPending && state.savedViewChoices.length === 0 &&
      state.alignmentFloor?.phase !== 'cancelling' &&
      (!state.busy || !!owner && owner.detecting && this.floorCurrent(owner) && !owner.cancel.signal.aborted);
  }
  private floorCurrent(owner: FloorToolOwner): boolean {
    return this.floorOwner === owner && owner.client === this.client && owner.scene === this.scene &&
      owner.scene.sourceRevision === owner.sourceRevision && owner.renderer === this.renderer && !owner.renderer.lost &&
      owner.generation === this.generation && !this.destroyed && !this.closing && !this.closeRequest &&
      !this.recovery && !this.editingFailed && useApp.getState().alignmentTool === 'floor';
  }
  private validateFloorObservation(owner: FloorToolOwner, summary: NativeSummary) {
    const before = owner.baseline, alignment = validateAlignmentSummary(summary.alignment), original = validateAlignmentSummary(before.alignment);
    if (!summary.loaded || summary.kind !== 0 || summary.pending || summary.sceneChanged || summary.transaction ||
        summary.count !== before.count || summary.sourceCount !== before.sourceCount || summary.shDegree !== before.shDegree ||
        summary.selected !== before.selected || summary.visible !== before.visible || summary.revision !== before.revision ||
        summary.contentRevision !== before.contentRevision || summary.canUndo !== before.canUndo || summary.canRedo !== before.canRedo ||
        !alignment || !original || !sameAlignmentBranch(original, alignment) || alignment.canReset !== original.canReset ||
        alignment.retainedBranchIds.length !== original.retainedBranchIds.length ||
        alignment.retainedBranchIds.some((id, index) => id !== original.retainedBranchIds[index]))
      throw new Error('Floor detection changed its captured scene or history.');
    return validateFloorSummary(summary.floor, { loadedCount: summary.count, pending: summary.pending });
  }
  private retireFloorNative(owner: FloorToolOwner): Promise<void> {
    if (!owner.retirement) owner.retirement = (async () => {
      if (owner.nativeId === undefined) return;
      const summary = await owner.client.command({ command: 'cancelFloor', id: owner.nativeId });
      if (summary.floor?.id === owner.nativeId) throw new Error('The scene worker did not retire the floor candidate.');
      if (owner.client === this.client && owner.generation === this.generation && !this.destroyed &&
          !this.recovery && !this.closing && !this.closeRequest) setApp({ summary });
    })();
    return owner.retirement;
  }
  private async prepareTransformToolBoundary(): Promise<boolean> {
    const client = this.client, generation = this.generation, sourceGeneration = client?.revision.sourceGeneration,
      documentId = client?.revision.documentId, sequence = ++this.transformToolSequence;
    if (!client || this.transformDirty || this.opacityDirty || this.transformGizmoGesture || !await this.endOpacitySession() || !await this.endTransformSession()) return false;
    return sequence === this.transformToolSequence && client === this.client && generation === this.generation &&
      sourceGeneration === client.revision.sourceGeneration && documentId === client.revision.documentId && !this.destroyed && !this.closing && !this.closeRequest;
  }
  async startFloorDetection(): Promise<boolean> {
    if ((this.transformOwner || this.opacityOwner || this.opacityEntryTask) && !await this.prepareTransformToolBoundary()) return false;
    if (!this.floorDetectionEnabled) return false;
    const client = this.client!, generation = this.generation;
    this.cancelAlignment();
    const preparing = {}; this.floorPreparing = preparing; this.selectionBarriers++;
    let barrier = true;
    const currentPreparation = () => this.floorPreparing === preparing && client === this.client && generation === this.generation &&
      !this.destroyed && !this.closing && !this.closeRequest && !this.recovery && !this.editingFailed;
    try {
      await this.floorCleanup; if (!currentPreparation()) return false;
      await this.closeToleranceSelection(); if (!currentPreparation()) return false;
      if (!await this.cancelSelectionGesture() || !currentPreparation()) return false;
      if (!await this.settleColorSession() || !currentPreparation() || !this.alignmentReady(true) || useApp.getState().pendingSelectionCount > 0) return false;
      const metadata = this.ledger.reserve('work', FLOOR_VIEW_BOOKKEEPING_BYTES);
      const owner: FloorToolOwner = { client, generation, renderer: this.renderer!, scene: this.scene as GaussianScene,
        sourceRevision: (this.scene as GaussianScene).sourceRevision, revision: { ...client.revision }, baseline: useApp.getState().summary!,
        cancel: new AbortController(), detecting: true, metadata };
      this.floorOwner = owner; this.floorPreparing = undefined;
      const task = Promise.resolve().then(() => this.detectFloor(owner)); owner.task = task;
      this.floorTasks.add(task); void task.finally(() => this.floorTasks.delete(task)).catch(() => undefined);
      this.releaseSelectionBarrier(); barrier = false;
      const stillOwned = () => this.floorOwner === owner && !owner.cancel.signal.aborted && client === this.client && generation === this.generation;
      if (!stillOwned()) return await task;
      this.camera!.clearInput();
      if (!stillOwned()) return await task;
      setApp({ alignmentTool: 'floor', alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null,
        alignmentNormal: null, alignmentFlip: false, alignmentTargetDistance: null, alignmentPicking: false,
        alignmentFloor: { phase: 'detecting', progress: 0, message: null, candidate: null },
        tool: null, fly: false, autoOrbit: false, busy: true, stage: 'Detecting floor', error: null });
      return await task;
    } catch (error) { if (currentPreparation()) this.error(error); return false; }
    finally {
      if (this.floorPreparing === preparing) this.floorPreparing = undefined;
      if (barrier) this.releaseSelectionBarrier();
    }
  }
  private async detectFloor(owner: FloorToolOwner): Promise<boolean> {
    const client = owner.client, coverage = this.nativeCoverage.get(client), previousProgress = client.onProgress;
    let work: ResourceLease | undefined, covered = false, keep = false;
    const progress = (stage: string, fraction: number) => {
      if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return;
      previousProgress?.(stage, fraction);
      if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return;
      setApp({ alignmentFloor: { phase: 'detecting', progress: Math.max(0, Math.min(1, fraction)), message: null, candidate: null } });
    };
    try {
      await this.joinAutomaticTransformPivot();
      if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return false;
      work = this.ledger.reserve('work', estimateFloorWorkBytes(owner.baseline.count));
      client.updateNativeCoverage([{ lease: work, nextLeaseBytes: work.bytes, nativeBytes: 0 }]); covered = true;
      if (coverage) coverage.work = work;
      client.setNativeWork(work); client.onProgress = progress;
      const result = await client.command({ command: 'detectFloor', camera: this.camera!.state }, owner.cancel.signal);
      const emitted = validateFloorSummary(result.floor, { loadedCount: result.count, pending: result.pending });
      if (emitted) owner.nativeId = emitted.id;
      const candidate = this.validateFloorObservation(owner, result);
      if (!candidate || candidate.status === 'pending') throw new Error('The scene worker did not finish floor detection.');
      owner.nativeId = candidate.id;
      if (!this.floorCurrent(owner) || owner.cancel.signal.aborted || !sameRevision(owner.revision, client.revision)) return false;
      owner.candidate = candidate; owner.detecting = false; keep = true;
      setApp({ summary: result, alignmentFloor: { phase: candidate.status === 'ready' ? 'candidate' : 'failed', progress: 1,
        candidate, message: candidate.status === 'none' ? 'No stable plane found. Clear the selection, or select a wider floor region and retry.' : null } });
      this.invalidate(); return true;
    } catch (error) {
      if (this.floorCurrent(owner) && !owner.cancel.signal.aborted) {
        try {
          const settled = await client.command({ command: 'summary' });
          const floor = this.validateFloorObservation(owner, settled);
          if (floor) owner.nativeId = floor.id;
          if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return false;
          if (floor?.status === 'ready') await this.retireFloorNative(owner);
          if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return false;
          owner.candidate = undefined;
          if (floor?.status !== 'ready') setApp({ summary: settled });
        } catch (cleanupError) {
          if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return false;
          this.editingFailed = true; this.error(cleanupError);
        }
        if (!this.floorCurrent(owner) || owner.cancel.signal.aborted) return false;
        owner.detecting = false; keep = true;
        setApp({ alignmentFloor: { phase: 'failed', progress: 0, candidate: null,
          message: error instanceof Error ? error.message : 'Floor detection failed.' } });
      }
      return false;
    } finally {
      try {
        if (!keep) await this.retireFloorNative(owner);
      } catch (error) {
        if (owner.client === this.client && owner.generation === this.generation && !this.destroyed &&
            !this.recovery && !this.closing && !this.closeRequest) { this.editingFailed = true; this.error(error); }
      }
      finally {
        if (client.onProgress === progress) client.onProgress = previousProgress;
        if (!coverage || coverage.work === work) { client.setNativeWork(undefined); if (coverage) coverage.work = undefined; }
        if (work) { if (covered) client.releaseNativeCoverage(work); else work(); }
        if (!keep) {
          owner.metadata();
          if (this.floorOwner === owner) {
            this.floorOwner = undefined;
            setApp({ alignmentTool: null, alignmentFloor: null, alignmentFlip: false });
          }
        }
        if (owner.client === this.client && owner.generation === this.generation && !this.destroyed && !this.recovery && !this.editOperation &&
            !this.closing && !this.closeRequest && !this.candidate)
          setApp({ busy: false, stage: '' });
      }
    }
  }
  private alignmentCurrent(owner: AlignmentToolOwner): boolean {
    return this.alignmentOwner === owner && owner.client === this.client && owner.scene === this.scene &&
      owner.renderer === this.renderer && !owner.renderer.lost && owner.generation === this.generation &&
      !this.destroyed && !this.closing && !this.closeRequest && !this.recovery && !this.editingFailed;
  }
  async startCenterAlignment(): Promise<boolean> {
    return this.startPointAlignment('center');
  }
  async startScaleAlignment(): Promise<boolean> {
    return this.startPointAlignment('scale');
  }
  async startPlaneAlignment(): Promise<boolean> {
    return this.startPointAlignment('align');
  }
  private async startPointAlignment(tool: 'center' | 'scale' | 'align'): Promise<boolean> {
    if ((this.transformOwner || this.opacityOwner || this.opacityEntryTask) && !await this.prepareTransformToolBoundary()) return false;
    if (!this.alignmentReady() || tool === 'align' && !this.alignmentPlaneControlsEnabled) return false;
    const client = this.client, generation = this.generation;
    this.cancelAlignment(); this.selectionBarriers++;
    try {
      await this.floorCleanup;
      await this.closeToleranceSelection();
      if (!await this.cancelSelectionGesture() || !await this.settleColorSession()) return false;
      if (client !== this.client || generation !== this.generation || !this.alignmentReady(true) ||
          useApp.getState().pendingSelectionCount > 0) return false;
      this.camera!.clearInput();
      this.alignmentOwner = { client: this.client!, renderer: this.renderer!, scene: this.scene as GaussianScene,
        generation, revision: { ...this.client!.revision }, tool, flip: false };
      setApp({ alignmentTool: tool, alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null,
        alignmentNormal: null, alignmentFlip: false, alignmentTargetDistance: null, alignmentPicking: false,
        tool: null, fly: false, autoOrbit: false, error: null });
      this.invalidate(); return true;
    } catch (error) { this.error(error); return false; }
    finally { this.releaseSelectionBarrier(); }
  }
  async pickAlignmentPoint(x: number, y: number): Promise<boolean> {
    const owner = this.alignmentOwner, camera = this.camera;
    if (!owner || !camera || !this.alignmentReady() || !this.alignmentCurrent(owner) ||
        !sameRevision(owner.revision, owner.client.revision) || !Number.isFinite(x) || !Number.isFinite(y) ||
        useApp.getState().alignmentTool !== owner.tool) return false;
    const token = {}, cameraRevision = camera.revision, epoch = owner.renderer.deviceEpoch,
      width = owner.renderer.canvas.width, height = owner.renderer.canvas.height;
    this.alignmentPick = token;
    const current = () => this.alignmentPick === token && this.alignmentCurrent(owner) && this.camera === camera &&
      camera.revision === cameraRevision && owner.renderer.deviceEpoch === epoch &&
      owner.renderer.canvas.width === width && owner.renderer.canvas.height === height &&
      sameRevision(owner.revision, owner.client.revision) && !useApp.getState().busy &&
      useApp.getState().alignmentTool === owner.tool && !this.selectionCleanupOwner;
    setApp({ alignmentPicking: true });
    try {
      owner.client.assertNativeAdmission();
      const pendingRender = owner.renderer.render(owner.scene, camera, useApp.getState().grade, true, IDENTITY_MATRIX, this.colorScope);
      if (pendingRender) await pendingRender;
      const radius = 8 * width / Math.max(1, owner.renderer.canvas.getBoundingClientRect().width);
      const hit = await owner.renderer.pick(owner.scene, x, y, radius);
      if (!current() || hit.deviceEpoch !== epoch || hit.index === null) return false;
      const result = await owner.client.command({ command: 'point', index: hit.index });
      if (!current() || !Array.isArray(result.point) || result.point.length !== 3 ||
          result.point.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value)))) return false;
      const point = Object.freeze(result.point.map(Math.fround)) as readonly [number, number, number];
      if (owner.tool === 'scale' || owner.tool === 'align') {
        const last = owner.thirdPoint ?? owner.secondPoint ?? owner.point;
        if (last && this.alignmentDistance(last, point) <= 0) {
          if (owner.thirdPoint) owner.thirdPoint = undefined;
          else if (owner.secondPoint) owner.secondPoint = undefined;
          else owner.point = undefined;
          owner.normal = undefined;
          this.publishAlignmentPoints(owner);
          this.error(new Error('Pick a different point.')); this.invalidate(); return false;
        }
        // Desktop ignores distinct extra picks once the required count exists.
        if (owner.tool === 'scale' ? owner.secondPoint : owner.thirdPoint) return false;
        if (!owner.point) owner.point = point;
        else if (!owner.secondPoint) {
          owner.secondPoint = point;
          if (owner.tool === 'scale' && !owner.targetDistance) owner.targetDistance = this.alignmentDistance(owner.point, point);
        } else {
          // Native validates only three points here. The full scene changes on
          // explicit confirmation; Flip/navigation reuse this retained normal.
          const candidate = await owner.client.command({ command: 'planeNormal',
            points: [[...owner.point], [...owner.secondPoint], [...point]] });
          if (!current()) return false;
          if (!Array.isArray(candidate.point) || candidate.point.length !== 3 ||
              candidate.point.some(value => typeof value !== 'number' || !Number.isFinite(Math.fround(value))))
            throw new Error('The picked plane has no valid normal.');
          owner.thirdPoint = point;
          owner.normal = Object.freeze(candidate.point.map(Math.fround)) as readonly [number, number, number];
        }
      } else owner.point = point;
      this.publishAlignmentPoints(owner);
      this.invalidate(); return true;
    } catch (error) {
      if (!(error instanceof StaleRenderQueryError) && current()) this.error(error);
      return false;
    } finally {
      if (this.alignmentPick === token) {
        this.alignmentPick = undefined; setApp({ alignmentPicking: false });
      }
    }
  }
  clearAlignmentPoint() {
    if (this.alignmentConfirming) return;
    this.alignmentPick = undefined;
    const owner = this.alignmentOwner;
    if (owner) {
      if (owner.thirdPoint) owner.thirdPoint = undefined;
      else if (owner.secondPoint) owner.secondPoint = undefined;
      else owner.point = undefined;
      owner.normal = undefined;
      this.publishAlignmentPoints(owner);
    } else setApp({ alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null, alignmentNormal: null });
    setApp({ alignmentPicking: false }); this.invalidate();
  }
  clearAlignmentPoints() {
    if (this.alignmentConfirming) return;
    this.alignmentPick = undefined;
    const owner = this.alignmentOwner;
    if (owner) { owner.point = undefined; owner.secondPoint = undefined; owner.thirdPoint = undefined;
      owner.normal = undefined; owner.targetDistance = undefined; }
    setApp({ alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null,
      alignmentNormal: null, alignmentTargetDistance: null, alignmentPicking: false });
    this.invalidate();
  }
  setAlignmentTargetDistance(value: number | null) {
    const owner = this.alignmentOwner;
    if (!owner || owner.tool !== 'scale' || this.alignmentConfirming || !this.alignmentCurrent(owner) ||
        !this.alignmentReady() || !sameRevision(owner.revision, owner.client.revision)) return;
    owner.targetDistance = value !== null && Number.isFinite(value) && Number.isFinite(Math.fround(value)) ? Math.fround(value) : undefined;
    // A numeric target changes only the confirmation controls. It does not
    // schedule a scene draw, camera transform or native geometry preview.
    this.publishAlignmentPoints(owner);
  }
  setAlignmentFlip(value: boolean) {
    if (this.floorOwner) {
      if (!this.floorCandidateReady) return;
      setApp({ alignmentFlip: value }); this.invalidate(); return;
    }
    const owner = this.alignmentOwner;
    if (!owner || owner.tool !== 'align' || this.alignmentConfirming || !this.alignmentCurrent(owner) ||
        !this.alignmentReady() || !sameRevision(owner.revision, owner.client.revision)) return;
    owner.flip = value;
    this.publishAlignmentPoints(owner);
  }
  private alignmentDistance(a: readonly number[], b: readonly number[]) {
    const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return Math.fround(Math.sqrt(x * x + y * y + z * z));
  }
  private publishAlignmentPoints(owner: AlignmentToolOwner) {
    const state = useApp.getState();
    const displayPoint = (retained: [number, number, number] | null, point?: readonly [number, number, number]) =>
      point ? retained && retained.every((value, axis) => value === point[axis]) ? retained : [...point] as [number, number, number] : null;
    setApp({ alignmentPoint: displayPoint(state.alignmentPoint, owner.point),
      alignmentSecondPoint: displayPoint(state.alignmentSecondPoint, owner.secondPoint),
      alignmentThirdPoint: displayPoint(state.alignmentThirdPoint, owner.thirdPoint),
      alignmentNormal: displayPoint(state.alignmentNormal, owner.normal), alignmentFlip: owner.flip,
      alignmentTargetDistance: owner.targetDistance ?? null });
  }
  cancelAlignment() {
    if (this.alignmentConfirming && this.editOperation?.committing) return;
    if (this.alignmentConfirming) this.cancelEdit();
    this.floorPreparing = undefined;
    const floor = this.floorOwner;
    if (floor) {
      this.floorOwner = undefined; floor.cancel.abort();
      const cancelling = floor.detecting;
      if (cancelling) setApp({ alignmentFloor: { phase: 'cancelling', progress: 0, message: null, candidate: null } });
      else setApp({ alignmentTool: null, alignmentFloor: null, alignmentFlip: false });
      const prior = this.floorCleanup;
      // A canceled confirmation can recreate this candidate during rollback.
      // Retire it only after that transaction's acknowledged restoration joins.
      const edit = this.alignmentConfirming ? this.editOperation?.finished : undefined;
      const cleanup = Promise.all([prior, floor.task?.catch(() => false), edit]).then(async () => {
        try { await this.retireFloorNative(floor); }
        catch (error) {
          if (floor.client === this.client && floor.generation === this.generation && !this.destroyed &&
              !this.recovery && !this.closing && !this.closeRequest) { this.editingFailed = true; this.error(error); }
        }
        finally {
          floor.metadata();
          if (this.floorCleanup === cleanup && !this.floorOwner && useApp.getState().alignmentFloor?.phase === 'cancelling')
            setApp({ alignmentTool: null, alignmentFloor: null, alignmentFlip: false });
        }
      });
      this.floorCleanup = cleanup;
    }
    this.alignmentOwner = undefined; this.alignmentPick = undefined;
    if (!floor && (useApp.getState().alignmentTool || useApp.getState().alignmentPoint || useApp.getState().alignmentSecondPoint ||
        useApp.getState().alignmentThirdPoint || useApp.getState().alignmentNormal || useApp.getState().alignmentFlip ||
        useApp.getState().alignmentTargetDistance !== null || useApp.getState().alignmentPicking))
      setApp({ alignmentTool: null, alignmentPoint: null, alignmentSecondPoint: null, alignmentThirdPoint: null,
        alignmentNormal: null, alignmentFlip: false, alignmentTargetDistance: null, alignmentPicking: false, alignmentFloor: null });
  }
  private currentAlignmentFrame() {
    return validateAlignmentSummary(useApp.getState().summary?.alignment)?.frame ?? IDENTITY_ALIGNMENT_FRAME;
  }
  private clearAlignmentViews() {
    this.alignmentViewsLease?.(); this.alignmentViewsLease = undefined;
    this.alignmentViews = new Map();
  }
  private prepareAlignmentDefaultView(state: readonly number[]) {
    if (!this.alignmentViews.size) return { checkpoints: this.alignmentViews, release: undefined };
    const release = this.alignmentViews.size ? this.ledger.reserve('work', ALIGNMENT_VIEW_BOOKKEEPING_BYTES) : undefined;
    try {
      const rolls = prepareDefaultRolls(state, this.currentAlignmentFrame(), [...this.alignmentViews.values()].map(entry => entry.frame),
        (values, matrix, policy) => this.camera!.transformState(values, matrix, policy),
        (before, after) => this.camera!.orientationFrameChange(before, after));
      return { checkpoints: replaceAlignmentDefaultRolls(this.alignmentViews, rolls), release };
    } catch (error) { release?.(); throw error; }
  }
  private defaultAlignmentCamera(): number[] {
    const canvas = this.renderer?.canvas ?? this.canvas;
    if (!this.camera || !canvas || !useApp.getState().summary) throw new Error('Open a scene first.');
    const aspect = canvas.width / canvas.height;
    if (this.alignmentDefaultCamera) {
      const values = [...this.alignmentDefaultCamera];
      values[6] = useApp.getState().summary!.radius; values[10] = aspect; return values;
    }
    const view = this.savedViewRecord?.view;
    const values = view ? cameraStateFromOriginal(savedViewCameraState(view, aspect), this.currentAlignmentFrame(),
      (state, frame) => this.camera!.transformState(state, frame), (before, after) => this.camera!.frameChange(before, after)) :
      [...useApp.getState().summary!.camera];
    values[6] = useApp.getState().summary!.radius; values[10] = aspect; return values;
  }
  async confirmAlignment(): Promise<boolean> {
    if (this.floorOwner) return this.confirmFloor(this.floorOwner);
    const owner = this.alignmentOwner;
    if (this.colorPending || useApp.getState().colorSession?.active) return false;
    if (!owner?.point || !this.alignmentReady() || !this.alignmentCurrent(owner) ||
        !sameRevision(owner.revision, owner.client.revision) || useApp.getState().alignmentTool !== owner.tool || useApp.getState().alignmentPicking) return false;
    if (owner.tool === 'scale' && (!owner.secondPoint || !owner.targetDistance || owner.targetDistance <= 0)) return false;
    if (owner.tool === 'align' && (!owner.secondPoint || !owner.thirdPoint || !owner.normal || !this.alignmentPlaneControlsEnabled)) return false;
    const point = [...owner.point], command: SceneCommand = owner.tool === 'scale' ?
      { command: 'alignScale', points: [point, [...owner.secondPoint!]], target: owner.targetDistance } : owner.tool === 'align' ?
        { command: 'alignPlane', points: [point, [...owner.secondPoint!], [...owner.thirdPoint!]], flip: owner.flip } : { command: 'alignCenter', point };
    this.alignmentConfirming = true;
    this.camera!.clearInput(); setApp({ autoOrbit: false });
    try {
      const accepted = await this.executeCommand({ ...command, camera: this.camera!.state,
        defaultCamera: this.defaultAlignmentCamera() }, () => this.alignmentCurrent(owner));
      if (accepted) { this.alignmentConfirming = false; this.cancelAlignment(); }
      else if (this.alignmentOwner === owner && owner.client === this.client) {
        // A joined rollback advances transport revision while preserving the picked world point.
        owner.revision = { ...owner.client.revision };
      }
      return accepted;
    } catch (error) { this.error(error); return false; }
    finally { this.alignmentConfirming = false; }
  }
  private async confirmFloor(owner: FloorToolOwner): Promise<boolean> {
    if (!this.floorCandidateReady || owner.candidate?.status !== 'ready' || this.colorPending || useApp.getState().colorSession?.active) return false;
    const id = owner.candidate.id, flip = useApp.getState().alignmentFlip;
    this.alignmentConfirming = true;
    this.camera!.clearInput(); setApp({ autoOrbit: false });
    try {
      const accepted = await this.executeCommand({ command: 'alignFloor', id, flip,
        camera: this.camera!.state, defaultCamera: this.defaultAlignmentCamera() }, () => this.floorCurrent(owner));
      if (accepted) { this.alignmentConfirming = false; this.cancelAlignment(); }
      else if (this.floorCurrent(owner)) {
        const summary = useApp.getState().summary!;
        const candidate = validateFloorSummary(summary.floor, { loadedCount: summary.count, pending: summary.pending });
        if (candidate?.status !== 'ready' || candidate.id !== id) {
          this.alignmentConfirming = false; this.cancelAlignment(); return false;
        }
        owner.revision = { ...owner.client.revision }; owner.baseline = summary; owner.candidate = candidate;
        setApp({ alignmentFloor: { phase: 'candidate', progress: 1, message: null, candidate }, alignmentFlip: flip });
      }
      return accepted;
    } catch (error) { if (this.floorCurrent(owner)) this.error(error); return false; }
    finally {
      this.alignmentConfirming = false;
      if (this.floorOwner === owner && !this.floorCurrent(owner)) this.cancelAlignment();
    }
  }
  async resetAlignment(): Promise<boolean> {
    if (this.colorPending) return false;
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.prepareTransformToolBoundary()) return false;
    if (!this.alignmentReady() || !useApp.getState().summary?.alignment?.canReset) return false;
    this.cancelAlignment(); this.selectionBarriers++;
    try {
      await this.floorCleanup;
      await this.closeToleranceSelection();
      if (!await this.cancelSelectionGesture() || !await this.settleColorSession() || !this.alignmentReady(true) ||
          !useApp.getState().summary?.alignment?.canReset) return false;
      this.camera!.clearInput(); setApp({ autoOrbit: false });
      return await this.executeCommand({ command: 'resetAlignment', camera: this.camera!.state,
        defaultCamera: this.defaultAlignmentCamera() });
    } catch (error) { this.error(error); return false; }
    finally { this.releaseSelectionBarrier(); }
  }
  resetCamera() {
    // The keyboard path shares this guard with the toolbar. An irreversible
    // commit acknowledgement must publish its prepared pose/roll map together.
    if (!this.cameraNavigationEnabled) return;
    if (!this.floorOwner) this.cancelAlignment();
    this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer();
    this.endToleranceSelection();
    const state = useApp.getState(); this.camera?.clearInput(); setApp({ fly: false, autoOrbit: false, tool: null });
    if (state.summary) {
      let release: ResourceLease | undefined;
      try {
        const view = this.savedViewRecord?.view, aspect = this.renderer!.canvas.width / this.renderer!.canvas.height;
        const nextCamera = this.defaultAlignmentCamera();
        release = this.alignmentViews.size ? this.ledger.reserve('work', ALIGNMENT_VIEW_BOOKKEEPING_BYTES) : undefined;
        const checkpoints = resetAlignmentActiveRolls(this.alignmentViews);
        this.camera?.set(nextCamera); this.camera?.aspect(aspect);
        this.alignmentViews = checkpoints;
        if (this.camera) this.camera.background = view?.background ?? 'black';
        setApp({ background: view?.background ?? 'black' }); this.invalidate();
      } catch (error) { this.error(error); }
      finally { release?.(); }
    }
  }
  cycleBackground() {
    if (!this.camera || !this.scene || !this.renderer || this.renderer.lost || this.recovery || this.destroyed) return;
    setApp({ background: this.camera.cycleBackground() }); this.invalidate();
  }
  async focusPixel(x: number, y: number): Promise<void> {
    if (this.filterOwner || this.transformOwner || this.opacityOwner || this.opacityEntryTask || !this.scene || this.scene.kind !== 'gaussian' || !this.renderer || !this.camera || !this.client || useApp.getState().busy ||
      useApp.getState().tool || this.renderer.lost || this.recovery || this.selectionCleanupOwner) return;
    if (!await this.cancelSelectionGesture()) return;
    const scene = this.scene, renderer = this.renderer, camera = this.camera, client = this.client;
    const content = { ...client.revision }, revision = camera.revision, autoOrbit = useApp.getState().autoOrbit;
    camera.clearInput(); setApp({ autoOrbit: false });
    const current = () => renderer === this.renderer && !renderer.lost && scene === this.scene && camera === this.camera &&
      client === this.client && camera.revision === revision && sameRevision(content, client.revision) &&
      !useApp.getState().tool && !useApp.getState().busy && !this.recovery && !this.destroyed && !this.selectionCleanupOwner;
    let focused = false;
    try {
      if (!current()) return;
      client.assertNativeAdmission();
      const pendingRender = renderer.render(scene, camera, useApp.getState().grade, true, IDENTITY_MATRIX, this.colorScope);
      if (pendingRender) await pendingRender;
      const radius = 8 * renderer.canvas.width / Math.max(1, renderer.canvas.getBoundingClientRect().width);
      const hit = await renderer.pick(scene, x, y, radius);
      if (!current() || hit.deviceEpoch !== renderer.deviceEpoch || hit.index === null) return;
      const result = await client.command({ command: 'point', index: hit.index });
      if (!current() || !result.point) return;
      camera.focus(result.point); setApp({ fly: false, autoOrbit: false, tool: null }); focused = true; this.invalidate();
    } catch (error) { if (!(error instanceof StaleRenderQueryError) && current()) this.error(error); }
    finally { if (!focused && autoOrbit && current()) { setApp({ autoOrbit: true }); this.invalidate(); } }
  }
  async selectPixel(x: number, y: number, operation: number, deferredPointer?: DeferredColorPointerToken) {
    if (deferredPointer && !this.deferredColorPointersCurrent(deferredPointer)) return;
    if (this.filterOwner || this.transformOwner || this.opacityOwner || this.opacityEntryTask || !this.scene || this.scene.kind !== 'gaussian' || !this.renderer || !this.camera || !this.client || useApp.getState().busy ||
      this.editingFailed || this.destroyed || this.selectionBarriers || this.exporting || this.selectionCleanupOwner) return;
    const capturedClient = this.client, capturedCamera = this.camera, capturedRevision = this.camera.revision, capturedTool = useApp.getState().tool;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (this.needsColorSettlement && !await this.settleColorSession()) return;
    if (deferredPointer && !this.deferredColorPointersCurrent(deferredPointer)) return;
    if (this.client !== capturedClient || this.camera !== capturedCamera || this.camera.revision !== capturedRevision ||
      useApp.getState().tool !== capturedTool || !this.scene || !this.renderer || this.renderer.lost || this.destroyed) return;
    const scene = this.scene, renderer = this.renderer, revision = this.camera.revision, content = { ...this.client.revision }, tool = useApp.getState().tool;
    try {
      this.client.assertNativeAdmission();
      const state = useApp.getState();
      const hit = await this.selectionPixelPick('ordinary-single',renderer,scene,this.camera,x,y,state.grade,this.colorScope);
      if (deferredPointer && !this.deferredColorPointersCurrent(deferredPointer)) return;
      if (renderer !== this.renderer || hit.deviceEpoch !== this.renderer.deviceEpoch || scene !== this.scene ||
        this.camera.revision !== revision || !this.client || !sameRevision(content, this.client.revision) || tool !== useApp.getState().tool) return;
      await this.command(this.scopedCommand({ command: 'single', index: hit.index, operation }, this.captureSelectionView()), deferredPointer);
    } catch (error) { if (!(error instanceof StaleRenderQueryError) && renderer === this.renderer && !renderer.lost &&
      (!deferredPointer || this.deferredColorPointersCurrent(deferredPointer))) this.error(error); }
  }
  get isToleranceUpdating() { return !!this.tolerance?.active && this.tolerance.applying; }
  get isReleasedSelectionBusy() { return !!this.tolerance?.applying && (!this.editOperation || this.editOperation.tolerance); }
  private toleranceCurrent(owner: ToleranceSelection, revisions = !owner.applying) {
    const state = useApp.getState();
    return !this.selectionCleanupOwner && this.tolerance === owner && owner.client === this.client && owner.renderer === this.renderer &&
      owner.scene === this.scene && owner.scene.sourceRevision === owner.sourceRevision &&
      owner.camera === this.camera && owner.cameraRevision === owner.camera.revision &&
      owner.width === owner.renderer.canvas.width && owner.height === owner.renderer.canvas.height &&
      !owner.renderer.lost && !this.recovery && !this.destroyed && state.tool === owner.tool &&
      (!owner.deferredPointer || this.deferredColorPointersCurrent(owner.deferredPointer)) &&
      (owner.deferredPointer !== undefined || state.selectionOptionsRevision === owner.optionsRevision) &&
      (!revisions || (sameRevision(owner.revision, owner.client.revision) &&
        (!owner.active || state.summary?.toleranceSessionId === owner.id)));
  }
  setSelectionTolerance(value: number) {
    if (this.selectionAction || this.filterOwner || this.selectionCleanupOwner || !Number.isFinite(value) || useApp.getState().selectionDragging || this.exporting) return;
    const state = useApp.getState(), tolerance = Math.max(0, Math.min(1, value));
    if (state.tool === 'fill') setApp({ fillTolerance: tolerance, tolerance });
    else setApp({ colorTolerance: tolerance, tolerance });
    this.queueToleranceUpdate('tolerance');
  }
  setConnectedColor(connected: boolean) {
    if (this.selectionAction || this.filterOwner || this.selectionCleanupOwner || useApp.getState().selectionDragging || this.exporting || useApp.getState().connectedColor === connected) return;
    setApp({ connectedColor: connected });
    if (useApp.getState().tool === 'color') this.queueToleranceUpdate('connected');
  }
  private queueToleranceUpdate(field: 'tolerance' | 'connected' | 'range') {
    const state = useApp.getState(), sequence = ++this.toleranceUpdateSequence;
    const changed = (tool: 'color' | 'fill') => field === 'range' ? this.selectionRangeFields(tool) :
      field === 'connected' ? { connected: state.connectedColor, tolerance: state.colorTolerance } :
      { tolerance: tool === 'fill' ? state.fillTolerance : state.colorTolerance };
    const tail = this.releasedSelections.at(-1);
    if (tail && !tail.cancel.signal.aborted) {
      // Native setters target only the last released stroke, never search
      // backward or transfer a missed/empty tail's values to an older owner.
      if (tail.tool === state.tool) {
        const patch = changed(tail.tool);
        if (!patch) return;
        tail.request = { ...tail.request, sequence, ...patch };
        if (tail.owner?.active && this.tolerance === tail.owner) this.updateToleranceOwner(tail.owner, tail.request);
      }
      return;
    }
    const owner = this.tolerance;
    if (owner && this.toleranceCurrent(owner)) {
      const patch = changed(owner.tool);
      if (!patch) return;
      const request = { ...owner.request, sequence, ...patch };
      // Canceled queue bookkeeping is not a live native stroke. A surviving
      // completed owner receives new setters; an initial candidate must first
      // resolve commit/rollback to identify that surviving owner.
      if (!owner.active && this.releasedSelections.some(record => record.owner === owner && record.cancel.signal.aborted))
        owner.cancelledRequest = { ...owner.cancelledRequest, ...patch, sequence };
      else this.updateToleranceOwner(owner, request);
    }
    else if (owner) this.endToleranceSelection();
  }
  private updateToleranceOwner(owner: ToleranceSelection, request: ToleranceRequest) {
    owner.request = request;
    const connected = request.connected;
    // Waiting is the latest requested mode, not the lifetime of an older
    // readback. Turning Connected off clears it immediately; turning back
    // on before the aborted query settles makes the owner waiting again.
    owner.waitingMap = connected && owner.mapId === undefined && !owner.mapReady;
    if (!connected && owner.mapQuery) {
      const query = owner.mapQuery; owner.mapQuery = undefined; query.abort();
    }
    owner.session.update(request);
  }
  endToleranceSelection(): void { void this.closeToleranceSelection(); }
  private closeToleranceSelection(): Promise<void> {
    const drain = this.cancelReleasedSelections();
    const owner = this.tolerance;
    if (!owner) return Promise.all([drain, this.toleranceCleanup]).then(() => undefined);
    this.tolerance = undefined;
    owner.mapQuery?.abort();
    if (owner.applying) this.cancelEdit();
    const sessions: Promise<void>[] = [this.toleranceCleanup, owner.session.end()];
    if (owner.previous) sessions.push(owner.previous.session.end());
    this.toleranceCleanup = Promise.all(sessions).then(() => undefined);
    // The stored owner cleanup must exclude the drain: each head awaits it.
    // External callers join both lifetimes without making a head await itself.
    return Promise.all([drain, this.toleranceCleanup]).then(() => undefined);
  }
  private async releaseTolerance(owner: ToleranceSelection) {
    let before: Revision | undefined, terminalRevision: Revision | undefined;
    try {
      if (this.editOperation) await this.editOperation.finished;
      if (this.destroyed || owner.client !== this.client) return;
      before = { ...owner.client.revision };
      const summary = await owner.client.command({ command: 'endTolerance', sessionId: owner.id });
      terminalRevision = { ...owner.client.revision };
      if (owner.client === this.client && !this.destroyed) {
        this.shrinkNativeHistory(owner.client, summary);
        setApp({ summary, dirty: summary.contentRevision !== this.savedContent });
      }
    } catch (error) { if (owner.client === this.client && !this.destroyed) this.error(error); }
    finally { if (before && terminalRevision) this.advanceReleasedRevision(owner.client, before, terminalRevision); }
  }
  private async amendTolerance(owner: ToleranceSelection, request: ToleranceRequest) {
    if (!this.toleranceCurrent(owner)) return false;
    // A final range change can follow pointerup with a slightly different raw
    // double but the same native operands. Deduplicate only acknowledged work:
    // a refused/canceled request must remain retryable with identical values.
    const accepted = owner.acceptedRequest, acknowledged = useApp.getState().summary;
    if (accepted && accepted.tolerance === request.tolerance && accepted.connected === request.connected &&
      accepted.rangeEnabled === request.rangeEnabled && accepted.rangeRadius === request.rangeRadius &&
      acknowledged?.toleranceRange?.enabled === request.rangeEnabled && acknowledged.toleranceRange.radius === request.rangeRadius &&
      (owner.tool === 'fill' || acknowledged.toleranceConnected === request.connected)) return true;
    owner.applying = true;
    let map: CachedSelectionMap | undefined, cancel: AbortController | undefined;
    try {
      // The native completed-click owner retains its immutable map even if a
      // compatible cache upgrade retires the browser CPU owner. View/source
      // guards above and native checkpoint guards still apply to amendments.
      if (owner.tool === 'color' && request.connected && owner.mapId === undefined) {
        const revision = { ...owner.client.revision };
        owner.waitingMap = true;
        cancel = new AbortController(); owner.mapQuery = cancel;
        map = await this.selectionMap({ colors: true, visible: true }, cancel.signal);
        if (!this.toleranceCurrent(owner, false) || !sameRevision(revision, owner.client.revision) || cancel.signal.aborted) return false;
        map.assertCurrent();
        // The desktop waiting flag ends once the map is available. Ordinary
        // focus cancellation then preserves this completed adjustment owner.
        owner.mapReady = true;
        owner.waitingMap = false;
        if (owner.mapQuery === cancel) owner.mapQuery = undefined;
      }
      const current = () => {
        if (!this.toleranceCurrent(owner, false) || cancel?.signal.aborted) return false;
        try { map?.assertCurrent(); return true; } catch { return false; }
      };
      const published = await this.executeCommand({ command: owner.tool === 'fill' ? 'fillTolerance' : 'colorTolerance', sessionId: owner.id,
        tolerance: request.tolerance * request.tolerance,
        rangeEnabled: request.rangeEnabled, rangeRadius: request.rangeRadius,
        ...(owner.tool === 'color' ? { connected: request.connected, ...(map ? { mapId: map.mapId } : {}) } : {}),
      }, current, true);
      owner.revision = { ...owner.client.revision };
      const summary = useApp.getState().summary;
      if (published && summary?.toleranceSessionId !== owner.id) this.endToleranceSelection();
      const accepted = published && summary?.toleranceSessionId === owner.id &&
        summary.toleranceRange?.enabled === request.rangeEnabled && summary.toleranceRange.radius === request.rangeRadius &&
        (owner.tool !== 'color' || summary.toleranceConnected === request.connected);
      if (accepted) owner.acceptedRequest = { ...request };
      return accepted;
    } catch (error) {
      if (!(error instanceof StaleRenderQueryError) && !(error instanceof DOMException && error.name === 'AbortError') &&
          this.tolerance === owner) this.error(error);
      return false;
    }
    finally {
      owner.revision = { ...owner.client.revision };
      const summary = useApp.getState().summary;
      if (this.tolerance === owner && summary?.toleranceSessionId === owner.id) {
        owner.mapId = summary.toleranceMapId ?? undefined;
        owner.mapReady = owner.mapId !== undefined;
        if (request.sequence === owner.request.sequence && typeof summary.toleranceConnected === 'boolean')
          owner.request = { ...owner.request, connected: summary.toleranceConnected };
        // A refused enable can preserve the native ordinary owner. Do
        // not overwrite a newer absolute request already waiting to apply.
        if (owner.tool === 'color' && request.sequence === this.toleranceUpdateSequence &&
            request.connected === useApp.getState().connectedColor && typeof summary.toleranceConnected === 'boolean') {
          owner.waitingMap = false;
          // Empty/missing queued clicks can leave a remembered preference
          // different from the surviving stroke. Tolerance alone preserves it.
          setApp({ connectedColor: summary.toleranceConnected });
        }
      }
      if (owner.mapQuery === cancel) owner.mapQuery = undefined;
      owner.applying = false;
      this.queueTransformPivotSynchronization();
    }
  }
  async selectColorPixel(x: number, y: number, operation: number, options?: DeferredSelectionOptions,
    deferredPointer?: DeferredColorPointerToken): Promise<boolean> {
    return this.selectTolerancePixel('color', x, y, operation, options, deferredPointer);
  }
  async fillPixel(x: number, y: number, operation: number, options?: DeferredSelectionOptions,
    deferredPointer?: DeferredColorPointerToken): Promise<boolean> {
    return this.selectTolerancePixel('fill', x, y, operation, options, deferredPointer);
  }
  private releasedCurrent(record: ReleasedSelection, revisions = true) {
    const state = useApp.getState();
    return !this.selectionCleanupOwner && !record.cancel.signal.aborted && !this.destroyed && !this.recovery && !this.editingFailed &&
      record.client === this.client && record.renderer === this.renderer && !record.renderer.lost &&
      record.scene === this.scene && record.sourceRevision === record.scene.sourceRevision &&
      record.camera === this.camera && record.cameraRevision === record.camera.revision &&
      record.width === record.renderer.canvas.width && record.height === record.renderer.canvas.height &&
      (!record.deferredPointer || this.deferredColorPointersCurrent(record.deferredPointer)) &&
      (record.deferredPointer !== undefined || record.optionsRevision === state.selectionOptionsRevision) && record.tool === state.tool &&
      (record.tool === 'fill' || record.grade.join(',') === state.grade.join(',')) &&
      (!revisions || this.editOperation?.tolerance || sameRevision(record.revision, record.client.revision));
  }
  private validateReleasedSelections() {
    if (this.releasedSelections.some(record => !record.cancel.signal.aborted && !this.releasedCurrent(record)))
      void this.cancelReleasedSelections();
  }
  private advanceReleasedRevision(client: CoreClient, before: Revision, terminal: Revision, operation?: EditOperation) {
    if (client !== this.client || this.destroyed) return;
    for (const record of this.releasedSelections) {
      if (record.client !== client) continue;
      // Only this explicitly owned native operation can advance an expected
      // revision. New input admitted while its candidate was in flight carries
      // the token, including when an older canceled head must roll back.
      if ((operation && record.pendingEdit === operation) || sameRevision(record.revision, before)) {
        record.revision = { ...terminal };
        record.pendingEdit = undefined;
      }
    }
  }
  private cancelReleasedSelections(): Promise<void> {
    const records = [...this.releasedSelections];
    for (const record of records) record.cancel.abort();
    if (this.editOperation?.tolerance && records.some(record => record.owner === this.tolerance)) this.cancelEdit();
    // An older cancellation joins only the records captured at entry. A later
    // release may share the runner while retaining independent ownership.
    return Promise.all(records.map(record => record.settled)).then(() => undefined);
  }
  private startReleasedDrain() {
    if (this.releasedDrain) return;
    const task = Promise.resolve().then(async () => {
      while (this.releasedSelections.length) {
        const record = this.releasedSelections[0];
        let accepted = false;
        try { if (!record.cancel.signal.aborted) accepted = await this.applyReleasedSelection(record); }
        catch (error) {
          if (!record.cancel.signal.aborted && !(error instanceof StaleRenderQueryError)) this.error(error);
        }
        finally {
          this.releasedSelections.shift();
          record.lease(); this.pendingTolerancePicks.delete(record.settled);
          if (!this.destroyed) setApp({ pendingSelectionCount: this.releasedSelections.length });
          record.complete(accepted); record.settle();
        }
      }
    }).finally(() => {
      if (this.releasedDrain === task) this.releasedDrain = undefined;
      if (this.releasedSelections.length) this.startReleasedDrain();
      this.queueTransformPivotSynchronization();
    });
    this.releasedDrain = task;
  }
  private async selectTolerancePixel(tool: 'color' | 'fill', x: number, y: number, operation: number, options?: DeferredSelectionOptions,
    deferredPointer?: DeferredColorPointerToken): Promise<boolean> {
    if (deferredPointer && !this.deferredColorPointersCurrent(deferredPointer)) return false;
    if (this.filterOwner || this.transformOwner || this.opacityOwner || this.opacityEntryTask || !Number.isFinite(x) || !Number.isFinite(y) || useApp.getState().tool !== tool || this.selectionCleanupOwner ||
      this.destroyed || this.closing || this.closeRequest || this.selectionBarriers || this.exporting) return false;
    const capturedClient = this.client, capturedCamera = this.camera, capturedRevision = this.camera?.revision;
    const capturedOptions = useApp.getState().selectionOptionsRevision;
    // Capture press preferences before any grade/statistic/map await. Deferred
    // input may belong to a profile/tool preference no longer shown by the UI.
    const atPress = useApp.getState();
    let rangePreference: SelectionRangePreference;
    try { rangePreference = validateSelectionRangePreference(tool === 'fill' ? options?.fillRange ?? atPress.fillRange : options?.colorRange ?? atPress.colorRange); }
    catch (error) { this.error(error); return false; }
    if (rangePreference.enabled && !this.selectionRangeFields(tool, rangePreference) && !await this.queryMorphologyRange(false)) return false;
    if (this.needsColorSettlement && !await this.settleColorSession()) return false;
    if (deferredPointer && !this.deferredColorPointersCurrent(deferredPointer)) return false;
    if (this.client !== capturedClient || this.camera !== capturedCamera || this.camera?.revision !== capturedRevision ||
      (!deferredPointer && useApp.getState().selectionOptionsRevision !== capturedOptions) || useApp.getState().tool !== tool) return false;
    const renderer = this.renderer, scene = this.scene, camera = this.camera, client = this.client;
    const state = useApp.getState();
    if (!renderer || !scene || scene.kind !== 'gaussian' || !camera || !client || renderer.lost || this.recovery || this.selection || this.cancellingSelection || this.selectionCleanupOwner ||
      this.destroyed || this.editingFailed || this.selectionBarriers || state.busy && !this.isReleasedSelectionBusy ||
      state.tool !== tool || this.exporting || !Number.isFinite(x) || !Number.isFinite(y)) return Promise.resolve(false);
    const seed: [number, number] = [Math.floor(x), Math.floor(y)];
    if (seed[0] < 0 || seed[1] < 0 || seed[0] >= renderer.canvas.width || seed[1] >= renderer.canvas.height) return Promise.resolve(false);
    const range = this.selectionRangeFields(tool, rangePreference);
    if (!range) return false;
    const cssWidth = renderer.canvas.clientWidth || renderer.canvas.width;
    const sampleRadiusPixels = Math.fround(options?.sampleRadiusPixels ?? atPress.brushSize * renderer.canvas.width / cssWidth / 2);
    if (!Number.isFinite(sampleRadiusPixels) || sampleRadiusPixels <= 0) return false;
    this.validateReleasedSelections();
    let lease: ResourceLease;
    try {
      if (this.releasedSelections.length >= maxReleasedSelections) throw new Error('Too many pending selection clicks. Wait for them to finish.');
      client.assertNativeAdmission();
      lease = this.ledger.reserve('work', releasedSelectionBytes);
    } catch (error) { this.error(error); return Promise.resolve(false); }
    let complete!: (accepted: boolean) => void, settle!: () => void;
    const result = new Promise<boolean>(resolve => { complete = resolve; });
    const settled = new Promise<void>(resolve => { settle = resolve; });
    const record: ReleasedSelection = { tool, seed, operation, renderer, scene, camera, client,
      cameraRevision: camera.revision, sourceRevision: scene.sourceRevision,
      width: renderer.canvas.width, height: renderer.canvas.height, optionsRevision: state.selectionOptionsRevision,
      cameraState: [...camera.state], grade: [...state.grade], visibleOnly: options?.visibleOnly ?? state.visibleOnly, overlap: options?.overlap ?? state.overlap,
      sampleRadiusPixels,
      selectionView: this.captureSelectionView(options?.currentViewOnly ?? state.currentViewOnly),
      releaseRevision: { ...client.revision }, revision: { ...client.revision },
      pendingEdit: this.editOperation?.tolerance ? this.editOperation : undefined,
      request: { ...range, tolerance: tool === 'fill' ? options?.fillTolerance ?? state.fillTolerance : options?.colorTolerance ?? state.colorTolerance,
        connected: tool === 'color' && (options?.connectedColor ?? state.connectedColor), sequence: ++this.toleranceUpdateSequence },
      cancel: new AbortController(), deferredPointer, lease, complete, settled, settle };
    this.releasedSelections.push(record); this.pendingTolerancePicks.add(settled);
    setApp({ pendingSelectionCount: this.releasedSelections.length });
    this.startReleasedDrain();
    return result;
  }
  private async applyReleasedSelection(record: ReleasedSelection): Promise<boolean> {
    const { tool, seed, renderer, scene, camera, client, width, height, optionsRevision, operation, cancel } = record;
    const current = () => this.releasedCurrent(record);
    try {
      await this.toleranceCleanup;
      if (!current()) return false;
      // A completed owner's amendment can publish a new mask/revision. Join it
      // before querying the successor, so it cannot expire that readback.
      const previous = this.tolerance;
      await previous?.session.flush();
      if (!current()) return false;
      let index: number | undefined, map: CachedSelectionMap | undefined;
      if (tool === 'fill') {
        map = await this.selectionMap({ visible: record.visibleOnly }, cancel.signal);
        if (!current()) return false;
        map.assertCurrent();
        const mx = Math.floor(seed[0] * map.map.width / width), my = Math.floor(seed[1] * map.map.height / height);
        const opacity = map.map.opacities[my * map.map.width + mx];
        if (!Number.isFinite(opacity) || opacity < 1 / 255) return false;
      } else {
        const hit = await this.selectionPixelPick('ordinary-color',renderer,scene,camera,seed[0],seed[1],record.grade,(useApp.getState().summary?.selected ?? 0) > 0);
        if (!current() || hit.deviceEpoch !== renderer.deviceEpoch || hit.index === null) return false;
        index = hit.index;
      }
      if (tool === 'color' && record.request.connected) {
        map = await this.selectionMap({ colors: true, visible: true }, cancel.signal);
        if (!current()) return false;
        map.assertCurrent();
      }
      let ready!: (accepted: boolean) => void;
      const initial = new Promise<boolean>(resolve => { ready = resolve; });
      const request = { ...record.request }, connected = tool === 'color' && request.connected;
      const owner = { id: ++this.toleranceSequence, client, renderer, scene, camera, cameraRevision: record.cameraRevision,
        width, height, seed, optionsRevision, deferredPointer: record.deferredPointer, tool, sourceRevision: record.sourceRevision,
        revision: { ...client.revision }, request, active: false, applying: true, waitingMap: false, mapReady: false, previous } as ToleranceSelection;
      owner.session = new ToleranceSession<ToleranceRequest>(initial, value => this.amendTolerance(owner, value), () => this.releaseTolerance(owner));
      this.tolerance = owner; record.owner = owner;
      let accepted = false;
      try {
        const command: SceneCommand = tool === 'fill'
          ? { command: 'fillPick', sessionId: owner.id, mapId: map!.mapId, camera: record.cameraState, width, height,
            seed, operation, tolerance: request.tolerance * request.tolerance, overlap: record.overlap, visibleOnly: record.visibleOnly,
            sampleRadiusPixels: record.sampleRadiusPixels, rangeEnabled: request.rangeEnabled, rangeRadius: request.rangeRadius }
          : { command: 'colorPick', sessionId: owner.id, index, camera: record.cameraState, operation, tolerance: request.tolerance * request.tolerance,
            width, height, seed, connected, rangeEnabled: request.rangeEnabled, rangeRadius: request.rangeRadius,
            ...(connected ? { mapId: map!.mapId } : {}) };
        accepted = await this.executeCommand(this.scopedCommand(command, record.selectionView), () => {
          if (!this.releasedCurrent(record, false) || !this.toleranceCurrent(owner, false)) return false;
          try { map?.assertCurrent(); return true; } catch { return false; }
        }, true);
      } catch (error) { this.error(error); }
      finally {
        const summary = useApp.getState().summary;
        accepted = accepted && summary?.toleranceSessionId === owner.id && summary.toleranceTool === tool &&
          summary.toleranceRange?.enabled === request.rangeEnabled && summary.toleranceRange.radius === request.rangeRadius &&
          (tool !== 'color' || summary.toleranceConnected === connected);
        if (accepted) {
          owner.acceptedRequest = { ...request };
          owner.mapId = summary!.toleranceMapId ?? undefined;
          owner.mapReady = owner.mapId !== undefined;
        }
        owner.revision = { ...client.revision }; owner.active = accepted;
        if (accepted) previous?.session.retire();
        else if (this.tolerance === owner) {
          owner.session.retire(); this.tolerance = previous;
          if (previous) {
            previous.revision = { ...client.revision };
            if (!this.toleranceCurrent(previous)) this.endToleranceSelection();
          }
        }
        owner.applying = false; ready(accepted); owner.previous = undefined;
        this.queueTransformPivotSynchronization();
      }
      if (accepted && !cancel.signal.aborted && this.tolerance === owner) {
        // A tail may change after its initial native command was dispatched.
        // Apply those absolute values to this owner before the next baseline.
        if (record.request.sequence !== request.sequence) this.updateToleranceOwner(owner, record.request);
        await owner.session.flush();
      }
      const deferred = owner.cancelledRequest, survivor = this.tolerance;
      if (deferred && survivor?.active && (survivor === owner || survivor === previous) && this.toleranceCurrent(survivor)) {
        owner.cancelledRequest = undefined;
        this.updateToleranceOwner(survivor, { ...survivor.request, ...deferred });
        await survivor.session.flush();
      }
      return accepted;
    } catch (error) {
      if (!(error instanceof StaleRenderQueryError) && !(error instanceof DOMException && error.name === 'AbortError') && current()) this.error(error);
      return false;
    }
  }
  async exportScene(format: number = this.acceptedExportFormat, scope = 0, onAccepted?: (format: SceneExportFormat) => void) {
    const feedback = this.beginToolbarAttempt('save');
    if (this.operationRecoveryBlocked) return;
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return;
    if (this.transformOwner && !await this.endTransformSession()) return;
    if (this.filterOwner || this.exporting || this.selectionBarriers || this.closing || this.closeRequest || !this.client || this.scene?.kind !== 'gaussian' || this.destroyed) return;
    const descriptor = sceneExportDescriptor(format);
    if (!descriptor || !Number.isInteger(scope) || scope < 0 || scope > 2) { this.error(new Error('Unsupported export format or scope.')); return; }
    this.exporting = true;
    let finished!: () => void;
    const operation: ExportOperation = { cancel: new AbortController(), finished: new Promise(resolve => { finished = resolve; }) };
    this.exportOperation = operation;
    this.cancelAlignment();
    const client = this.client;
    const generation = this.generation;
    let settledScene: GaussianScene | undefined;
    const check = () => {
      operation.cancel.signal.throwIfAborted();
      if (this.exportOperation !== operation || client !== this.client || generation !== this.generation ||
          (settledScene && settledScene !== this.scene) || this.destroyed || this.closing || this.closeRequest || this.recovery)
        throw new DOMException('Export cancelled', 'AbortError');
    };
    let started = false;
    let output: OwnedExportBytes | undefined;
    try {
      check(); await this.floorCleanup; check();
      // A released Color/Fill click owns pending work before its GPU readback.
      // Resolve that work before capturing Selected/Remainder output scope;
      // block newer picks/tolerance edits until this snapshot has completed.
      await Promise.all(this.pendingTolerancePicks); check();
      await this.tolerance?.session.flush(); check();
      if (!await this.cancelSelectionGesture()) return; check();
      if (!await this.settleColorSession()) return; check();
      if (this.scene?.kind !== 'gaussian' || useApp.getState().busy || this.editingFailed || this.recovery || this.destroyed || this.selectionCleanupOwner) return;
      // Committing the preview can bake a replacement GPU scene. Pin that
      // settled scene for planning, encoding and the browser Download handoff.
      settledScene = this.scene;
      client.assertNativeAdmission();
      const settled = useApp.getState().summary;
      if (settled && (scope === 0 ? settled.visible : scope === 1 ? settled.selected : settled.visible - settled.selected) <= 0)
        throw new Error('No visible splats in the export scope.');
      const revision = useApp.getState().summary?.contentRevision;
      const selectionRevision = useApp.getState().summary?.revision;
      const current = () => {
        check();
        if (revision !== useApp.getState().summary?.contentRevision || selectionRevision !== useApp.getState().summary?.revision)
          throw new DOMException('The scene changed during export', 'AbortError');
      };
      const accepted = () => { current(); this.acceptedExportFormat = descriptor.format; onAccepted?.(descriptor.format); };
      const plan = await client.sceneExportPlan(descriptor.format, scope, operation.cancel.signal);
      current();
      setApp({ busy: true, stage: 'Exporting scene', error: null }); started = true;
      const filename = useApp.getState().sourceName.replace(/\.[^.]+$/, '') + '-edited.' + descriptor.extension;
      output = await client.exportOwned(descriptor.format, scope, plan, { signal: operation.cancel.signal, current,
        admitNative: bytes => this.ledger.reserve('work', bytes), admitOutput: bytes => this.ledger.reserve('image', bytes), onAccepted: accepted });
      current();
      // Leave the ArrayBuffer reference inside this construction scope. The
      // owner retains the Blob after the browser Download handoff succeeds.
      const blob = new Blob([output.bytes], { type: 'application/octet-stream' });
      const retained = output; let settle: (() => void) | undefined, completed = false;
      retained.retainBlob();
      settle = downloadBlob(blob, filename, () => { completed = true; retained.dispose(); if (settle) this.exportDownloads.delete(settle); }, current);
      if (!completed) this.exportDownloads.add(settle); output = undefined;
      if (client === this.client && revision === useApp.getState().summary?.contentRevision) {
        this.outputReceipt = { documentId: client.revision.documentId, contentRevision: revision!, scope };
        setApp({ outputPending: true, exportOpen: false });
        this.confirmToolbarAttempt(feedback, 'Download prepared');
      }
    } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) this.error(error); }
    finally {
      try { output?.dispose(); } catch (error) { this.error(error); }
      finally {
        this.exporting = false;
        if (this.exportOperation === operation) this.exportOperation = undefined;
        if (started && !this.recovery && !this.destroyed && !this.closing) setApp({ busy: false, stage: '' });
        finished();
      }
    }
  }
  async selectionMap(channels: SurfaceChannels = {}, signal?: AbortSignal) {
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) throw new Error('Apply or cancel opacity before selecting a surface.');
    if (this.transformOwner && !await this.endTransformSession()) throw new Error('Apply or cancel the transform before selecting a surface.');
    signal?.throwIfAborted();
    if (this.filterOwner) throw new Error('Confirm or cancel the filter before selecting a surface.');
    if (this.selectionCleanupOwner) throw new Error('Restore the selection before selecting a surface.');
    if (this.needsColorSettlement && !await this.settleColorSession()) throw new Error('The color preview could not be settled before querying its surface.');
    const client = this.client, renderer = this.renderer, scene = this.scene, camera = this.camera;
    if (!client || !renderer || !scene || scene.kind !== 'gaussian' || !camera || renderer.lost || this.recovery || this.destroyed || useApp.getState().busy || this.selectionCleanupOwner)
      throw new Error('Wait for the current operation before selecting a surface.');
    client.assertNativeAdmission();
    const opacity = useApp.getState().opacityPreview, opacityRevision = useApp.getState().opacityPreviewRevision;
    const context:SelectionMapContext={ client, renderer, scene, camera, ledger: this.ledger,
      grade: useApp.getState().grade, geometrySelectedOnly: false, opacityScale: opacity?.scale ?? 1, opacitySelectedOnly: opacity?.selectedOnly ?? false, opacityPreviewRevision: opacityRevision,
      current: () => {
        const currentOpacity = useApp.getState().opacityPreview;
        if (client !== this.client || renderer !== this.renderer || scene !== this.scene || camera !== this.camera || this.recovery || this.destroyed || this.selectionCleanupOwner ||
          useApp.getState().opacityPreviewRevision !== opacityRevision || currentOpacity?.id !== opacity?.id || currentOpacity?.baseId !== opacity?.baseId || currentOpacity?.epoch !== opacity?.epoch)
          throw new StaleRenderQueryError('The document or graphics owner changed.');
      },
    };
    const observation=this.benchmarkObservation;
    if(observation?.active)context.observe=event=>{try{observation.recordSurface({...event,atMs:performance.now(),owner:this.benchmarkQueryOwner(observation)});}
      catch{/* Surface diagnostics cannot change the ordinary cache request. */}};
    return this.selectionMaps.request(context, channels, signal);
  }
  acknowledgeOutput() {
    const receipt = this.outputReceipt; this.outputReceipt = undefined;
    const current = useApp.getState().summary?.contentRevision;
    if (receipt && receipt.documentId === this.client?.revision.documentId && receipt.contentRevision === current && receipt.scope === 0) {
      this.savedContent = receipt.contentRevision; setApp({ dirty: false, outputPending: false }); void this.discardAndContinue();
    } else setApp({ outputPending: false });
  }
  private cancelImageCaptures() {
    for (const cancel of this.imageAborts) cancel.abort();
    for (const settle of this.imageDownloads) settle();
  }
  private beginImageCapture(type: string) {
    if (type !== 'image/png' && type !== 'image/jpeg') throw new Error('Capture supports PNG and JPEG images.');
    if (this.operationRecoveryBlocked) throw new Error('Recover the edit result before capturing the view.');
    if (this.filterOwner) throw new Error('Confirm or cancel the filter before capturing the view.');
    if (this.closing || this.closeRequest) throw new Error('Wait for scene closing to finish before capturing the view.');
    if (this.selectionCleanupOwner) throw new Error('Restore the selection before capturing the view.');
    if (useApp.getState().busy) throw new Error('Wait for the current operation before capturing the view.');
    if (!this.scene || !this.renderer || !this.camera) throw new Error('Open a scene first.');
    this.client?.assertNativeAdmission();
    const state = useApp.getState();
    if (this.transformGizmoGesture) throw new Error('Finish the transform gesture before capturing the view.');
    const client = this.client, scene = this.scene, renderer = this.renderer, camera = this.camera, generation = this.generation;
    const cancel = new AbortController(); this.imageAborts.add(cancel);
    const relevant = () => !this.destroyed && !this.closing && !this.closeRequest && !this.recovery &&
      client === this.client && scene === this.scene && renderer === this.renderer && camera === this.camera && generation === this.generation;
    const current = () => {
      cancel.signal.throwIfAborted();
      if (!relevant() || renderer.lost) throw new DOMException('Image capture cancelled', 'AbortError');
    };
    const operation: ImageOperation = { signal: cancel.signal, current, admit: bytes => this.ledger.reserve('image', bytes) };
    // Register before calling GPU/browser APIs: synchronous allocation hooks
    // may initiate Close while capture is still constructing its consumer.
    let complete!: () => void;
    const joined = new Promise<void>(resolve => { complete = resolve; }); this.imageTasks.add(joined);
    let retained: OwnedImageOutput | undefined;
    const output = (async () => {
      let raw: OwnedRgbaImage | undefined;
      try {
        current();
        raw = await renderer.captureRgba(scene, camera, operation, state.grade, state.transformPreview?.matrix ?? IDENTITY_MATRIX,
          this.colorScope, state.transformPreview?.selectedOnly ?? false, state.opacityPreview?.scale ?? 1, state.opacityPreview?.selectedOnly ?? false);
        current(); retained = await encodeRgba(raw, type, operation); current(); return retained;
      } finally { raw?.dispose(); this.invalidate(); }
    })();
    // The consumer is started by the caller before any await. Clipboard.write
    // therefore retains the original gesture while PNG encoding is pending.
    const finish = <T>(consumer: Promise<T>): Promise<T> => {
      const task = (async () => {
        const [image, consumed] = await Promise.allSettled([output, consumer]);
        if (consumed.status === 'rejected') throw consumed.reason;
        if (image.status === 'rejected') throw image.reason;
        return consumed.value;
      })().finally(() => {
        try { retained?.dispose(); }
        finally { this.imageAborts.delete(cancel); this.imageTasks.delete(joined); complete(); }
      });
      return task;
    };
    return { output, current, finish, abort: () => cancel.abort(), transfer: () => { retained = undefined; },
      report: (error: unknown) => {
        if (relevant() && !(error instanceof DOMException && error.name === 'AbortError')) this.error(error);
      } };
  }
  /** The caller owns the encoded image until dispose(), including browser transfer. */
  async captureOwned(type = 'image/jpeg'): Promise<OwnedImageOutput> {
    const capture = this.beginImageCapture(type);
    return capture.finish(capture.output.then(output => { capture.current(); capture.transfer(); return output; }));
  }
  /** Immediate Blob handoff for programmatic callers; UI transfers use retained owners. */
  async capture(type = 'image/jpeg'): Promise<Blob> {
    const capture = this.beginImageCapture(type);
    return capture.finish(capture.output.then(output => { capture.current(); return output.blob; }));
  }
  async snapshot() {
    const feedback = this.beginToolbarAttempt('capture');
    let capture: ReturnType<AppController['beginImageCapture']> | undefined;
    try {
      capture = this.beginImageCapture('image/jpeg');
      const owner = capture;
      await owner.finish((async () => {
        const output = await owner.output; owner.current();
        let settle: (() => void) | undefined, completed = false;
        settle = downloadBlob(output.blob, 'SplatView.jpg', () => { completed = true; output.dispose(); if (settle) this.imageDownloads.delete(settle); }, owner.current);
        try { owner.current(); } catch (error) { settle(); throw error; }
        if (!completed) this.imageDownloads.add(settle); owner.transfer();
      })());
      this.confirmToolbarAttempt(feedback, 'Download prepared');
    } catch (error) {
      if (capture) capture.report(error); else if (!this.destroyed && !this.closing) this.error(error);
    }
  }
  copyImage(): Promise<boolean> {
    let capture: ReturnType<AppController['beginImageCapture']> | undefined;
    try {
      if (!navigator.clipboard?.write || !globalThis.ClipboardItem) throw new Error('Image copy is unavailable here. Use Capture to save the image.');
      capture = this.beginImageCapture('image/png');
      const owner = capture;
      const image = owner.output.then(output => { owner.current(); return output.blob; });
      void image.catch(() => undefined);
      let writing: Promise<void>;
      try { writing = navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); }
      catch (error) { owner.abort(); writing = Promise.reject(error); }
      const observedWrite = writing.catch(error => { owner.abort(); throw error; });
      const consumer = Promise.allSettled([image, observedWrite]).then(([encoded, written]) => {
        if (written.status === 'rejected') throw written.reason;
        if (encoded.status === 'rejected') throw encoded.reason;
      });
      return owner.finish(consumer).then(() => { owner.current(); return true; }).catch(error => { owner.report(error); return false; });
    } catch (error) {
      if (capture) capture.report(error); else if (!this.destroyed && !this.closing) this.error(error);
      return Promise.resolve(false);
    }
  }
  async chooseSavedView(recordId: string): Promise<boolean> {
    this.cancelDeferredColorPointers();
    if ((this.opacityOwner || this.opacityEntryTask) && !await this.endOpacitySession()) return false;
    if (this.transformOwner && !await this.endTransformSession()) return false;
    if (this.filterOwner) return false;
    const source = this.fingerprint, scene = this.scene, client = this.client, camera = this.camera, state = useApp.getState();
    if (!source || !scene || !client || !camera || !this.renderer || this.renderer.lost || state.rendererState !== 'ready' ||
        state.busy || state.navigationPrompt || this.destroyed || this.closing || this.closeRequest || this.recovery) return false;
    const record = state.savedViewChoices.find(value => value.recordId === recordId);
    if (!record || !savedViewMatches(record, source, scene.kind === 'gaussian' ? 'gaussian' : scene.descriptor.kind === 1 ? 'points' : 'mesh')) return false;
    if (!await this.cancelSelectionGesture() || client !== this.client || camera !== this.camera || scene !== this.scene || source !== this.fingerprint ||
        this.destroyed || this.closing || this.closeRequest || this.recovery || !this.renderer || this.renderer.lost ||
        useApp.getState().rendererState !== 'ready' || useApp.getState().busy || useApp.getState().navigationPrompt ||
        !useApp.getState().savedViewChoices.includes(record)) return false;
    let owner: ResourceLease, nextCamera: number[], preparedDefault: ReturnType<AppController['prepareAlignmentDefaultView']> | undefined;
    try {
      nextCamera = cameraStateFromOriginal(savedViewCameraState(record.view, this.renderer!.canvas.width / this.renderer!.canvas.height),
        this.currentAlignmentFrame(), (state, frame) => camera.transformState(state, frame), (before, after) => camera.frameChange(before, after));
      nextCamera[6] = useApp.getState().summary!.radius;
      preparedDefault = this.prepareAlignmentDefaultView(nextCamera);
      owner = this.ledger.reserve('image', SAVED_VIEW_RETENTION_BYTES);
    }
    catch (error) { preparedDefault?.release?.(); setApp({ viewStatus: `Could not restore the saved view. ${error instanceof Error ? error.message : 'Memory is unavailable.'}` }); return false; }
    this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer();
    this.cancelAlignment();
    this.endToleranceSelection(); camera.clearInput();
    this.savedViewRecord = record; camera.background = record.view.background;
    this.releaseSavedViews?.(); this.releaseSavedViews = owner;
    camera.set(nextCamera);
    this.alignmentDefaultCamera = camera.state;
    this.alignmentViews = preparedDefault.checkpoints; preparedDefault.release?.();
    setApp({ savedViewChoices: [], savedViewAvailable: true, background: record.view.background, viewStatus: 'Saved view restored.', autoOrbit: false, fly: false, tool: null });
    this.invalidate(); return true;
  }
  dismissSavedViews() {
    setApp({ savedViewChoices: [] });
    if (!this.savedViewRecord) { this.releaseSavedViews?.(); this.releaseSavedViews = undefined; }
  }
  updateThumbnail(): Promise<boolean> {
    const feedback = this.beginToolbarAttempt('thumbnail');
    return this.updateThumbnailUnobserved().then(accepted => {
      if (accepted) this.confirmToolbarAttempt(feedback, 'Thumbnail and default view saved in this browser.');
      return accepted;
    });
  }
  private updateThumbnailUnobserved(): Promise<boolean> {
    this.cancelDeferredColorPointers();
    if (this.opacityOwner || this.opacityEntryTask) return this.endOpacitySession().then(ended => ended ? this.updateThumbnailUnobserved() : false);
    if (this.transformOwner) return this.endTransformSession().then(ended => ended ? this.updateThumbnailUnobserved() : false);
    const state = useApp.getState(), source = this.fingerprint, client = this.client, scene = this.scene, renderer = this.renderer, camera = this.camera;
    if (!source || !client || !scene || !renderer || !camera || !state.summary || renderer.lost || state.rendererState !== 'ready' ||
        state.busy || state.navigationPrompt || state.savedViewChoices.length > 0 || this.selectionCleanupOwner || this.filterOwner ||
        this.closing || this.closeRequest || this.destroyed || this.recovery) return Promise.resolve(false);
    this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer();
    const cancel = new AbortController(); this.thumbnailAbort = cancel;
    const contentRevision = state.summary!.contentRevision;
    const gradeRevision = state.gradeRevision, selectedOnly = this.colorScope;
    const previous = this.savedViewRecord;
    const current = () => {
      cancel.signal.throwIfAborted();
      if (this.destroyed || this.closing || this.closeRequest || this.client !== client || this.scene !== scene || this.renderer !== renderer ||
          this.fingerprint !== source || useApp.getState().summary?.contentRevision !== contentRevision || useApp.getState().gradeRevision !== gradeRevision)
        throw new DOMException('Thumbnail update cancelled', 'AbortError');
    };
    const operation = { signal: cancel.signal, current, admit: (bytes: number) => this.ledger.reserve('image', bytes) };
    setApp({ thumbnailPending: true, viewStatus: null });
    // Abort an active IDB transaction before an edit/open/close can publish.
    // An oncomplete liveness check alone is too late to undo durable writes.
    const unwatch = useApp.subscribe(next => {
      if (next.busy || next.navigationPrompt || next.rendererState !== 'ready' || next.summary?.contentRevision !== contentRevision || next.gradeRevision !== gradeRevision) cancel.abort();
    });
    const task = (async () => {
      let raw: OwnedRgbaImage | undefined, thumbnail: Awaited<ReturnType<typeof createSavedThumbnail>> | undefined, viewOwner: ResourceLease | undefined;
      let preparedDefault: ReturnType<AppController['prepareAlignmentDefaultView']> | undefined;
      try {
        client.assertNativeAdmission(); current();
        const capturedCamera = camera.state;
        preparedDefault = this.prepareAlignmentDefaultView(capturedCamera);
        const view = savedViewFromCamera(cameraStateToOriginal(capturedCamera, this.currentAlignmentFrame(),
          (state, frame) => camera.transformState(state, frame), (before, after) => camera.frameChange(before, after)), camera.background);
        const createdAt = previous?.createdAt ?? Date.now(), updatedAt = Math.max(Date.now(), (previous?.updatedAt ?? createdAt) + 1);
        const recordId = previous?.recordId ?? crypto.randomUUID();
        raw = await renderer.captureRgba(scene, camera, operation, [...state.grade], IDENTITY_MATRIX, selectedOnly); current();
        thumbnail = await createSavedThumbnail(raw, operation); current();
        raw.dispose(); raw = undefined;
        viewOwner = this.ledger.reserve('image', SAVED_VIEW_RETENTION_BYTES);
        const record = validateSavedViewRecord({ kind: 'splatview-saved-view', schemaVersion: 1, recordId, appVersion: '0.1.0', createdAt, updatedAt,
          source, sourceKind: scene.kind === 'gaussian' ? 'gaussian' : scene.descriptor.kind === 1 ? 'points' : 'mesh',
          view, thumbnail: thumbnail.thumbnail, displayName: state.sourceName });
        await this.viewStorage.put(record, thumbnail.image, operation); current();
        this.savedViewRecord = record;
        this.alignmentDefaultCamera = capturedCamera;
        this.alignmentViews = preparedDefault.checkpoints;
        this.releaseSavedViews?.(); this.releaseSavedViews = viewOwner; viewOwner = undefined;
        setApp({ viewStatus: 'Thumbnail and default view saved in this browser.', savedViewAvailable: true, savedViewChoices: [] }); return true;
      } catch (error) {
        if (!cancel.signal.aborted && this.client === client && !this.destroyed && !(error instanceof DOMException && error.name === 'AbortError'))
          setApp({ viewStatus: `Could not save the thumbnail and view. ${error instanceof Error ? error.message : 'Browser storage is unavailable.'}` });
        return false;
      } finally {
        unwatch();
        raw?.dispose(); thumbnail?.dispose(); viewOwner?.(); preparedDefault?.release?.(); this.invalidate();
        if (this.thumbnailAbort === cancel) { this.thumbnailAbort = undefined; if (!this.destroyed) setApp({ thumbnailPending: false }); }
      }
    })();
    this.thumbnailTasks.add(task); void task.finally(() => this.thumbnailTasks.delete(task)); return task;
  }
  cancelSavedViewTransfer() { this.viewTransferAbort?.abort(); }
  private transferSavedView(action: 'import' | 'export', run: (context: SavedViewTransfer) => Promise<boolean>): Promise<boolean> {
    this.cancelDeferredColorPointers();
    if (this.opacityOwner || this.opacityEntryTask) return this.endOpacitySession().then(ended => ended ? this.transferSavedView(action, run) : false);
    if (this.transformOwner) return this.endTransformSession().then(ended => ended ? this.transferSavedView(action, run) : false);
    const state = useApp.getState(), source = this.fingerprint, client = this.client, scene = this.scene, renderer = this.renderer, camera = this.camera;
    if (!source || !client || !scene || !renderer || !camera || !state.summary || renderer.lost || state.rendererState !== 'ready' ||
        state.busy || state.navigationPrompt || state.outputPending || state.exportOpen || state.savedViewChoices.length ||
        state.selectionRecovery !== 'idle' || state.memoryOverageBytes > 0 || this.selectionCleanupOwner || this.filterOwner || this.exporting || this.selectionBarriers ||
        this.closing || this.closeRequest || this.destroyed || this.recovery) return Promise.resolve(false);
    this.cancelSavedViewTransfer(); this.thumbnailAbort?.abort();
    const cancel = new AbortController(); this.viewTransferAbort = cancel;
    const contentRevision = state.summary.contentRevision, record = action === 'export' ? this.savedViewRecord : undefined;
    const current = () => {
      cancel.signal.throwIfAborted();
      if (this.destroyed || this.closing || this.closeRequest || this.recovery || this.client !== client || this.scene !== scene ||
          this.renderer !== renderer || renderer.lost || this.camera !== camera || this.fingerprint !== source ||
          useApp.getState().summary?.contentRevision !== contentRevision || useApp.getState().rendererState !== 'ready')
        throw new DOMException('Saved-view transfer cancelled', 'AbortError');
    };
    const operation = { signal: cancel.signal, current, admit: (bytes: number) => this.ledger.reserve('image', bytes) };
    setApp({ viewTransferPending: true, viewStatus: null });
    const task = (async () => {
      let unwatch: (() => void) | undefined, recordOwner: ResourceLease | undefined;
      try {
        // A newer view may replace the controller owner while this export's
        // real read/decode is still settling. Retain its comparison snapshot.
        if (record) recordOwner = this.ledger.reserve('image', SAVED_VIEW_RETENTION_BYTES);
        if (!await this.cancelSelectionGesture()) return false;
        current(); client.assertNativeAdmission();
        if (useApp.getState().busy || useApp.getState().navigationPrompt) return false;
        // Abort real pending transactions before a competing edit/navigation can commit.
        unwatch = useApp.subscribe(next => {
          if (next.busy || next.navigationPrompt || next.exportOpen || next.outputPending || next.selectionRecovery !== 'idle' ||
              next.rendererState !== 'ready' || next.memoryOverageBytes > 0 ||
              next.summary?.contentRevision !== contentRevision) cancel.abort();
        });
        return await run({ source, client, scene, renderer, camera, record, operation, current });
      } catch (error) {
        if (!cancel.signal.aborted && this.viewTransferAbort === cancel && !this.destroyed &&
            !(error instanceof Error && error.name === 'AbortError'))
          setApp({ viewStatus: `Could not ${action} the saved view. ${error instanceof Error ? error.message : 'The transfer failed.'}` });
        return false;
      } finally {
        unwatch?.(); recordOwner?.();
        if (this.viewTransferAbort === cancel) { this.viewTransferAbort = undefined; if (!this.destroyed) setApp({ viewTransferPending: false }); }
      }
    })();
    this.viewTransferTasks.add(task); void task.finally(() => this.viewTransferTasks.delete(task)); return task;
  }
  importSavedView(blob: Blob): Promise<boolean> {
    return this.transferSavedView('import', async ({ source, scene, renderer, camera, operation, current }) => {
      const pair = await readPortableSavedView(blob, operation);
      let owner: ResourceLease | undefined;
      let preparedDefault: ReturnType<AppController['prepareAlignmentDefaultView']> | undefined;
      try {
        current();
        const kind = scene.kind === 'gaussian' ? 'gaussian' : scene.descriptor.kind === 1 ? 'points' : 'mesh';
        if (!savedViewMatches(pair.record, source, kind)) throw new Error('This saved view belongs to different scene content.');
        owner = this.ledger.reserve('image', SAVED_VIEW_RETENTION_BYTES);
        const now = Date.now();
        const record = validateSavedViewRecord({ ...pair.record, recordId: crypto.randomUUID(), appVersion: '0.1.0', createdAt: now, updatedAt: now });
        const nextCamera = cameraStateFromOriginal(savedViewCameraState(record.view, renderer.canvas.width / renderer.canvas.height),
          this.currentAlignmentFrame(), (state, frame) => camera.transformState(state, frame), (before, after) => camera.frameChange(before, after));
        nextCamera[6] = useApp.getState().summary!.radius;
        preparedDefault = this.prepareAlignmentDefaultView(nextCamera);
        await this.viewStorage.put(record, pair.image, operation); current();
        this.cancelAlignment();
        this.endToleranceSelection(); camera.clearInput();
        camera.set(nextCamera); camera.background = record.view.background;
        this.alignmentDefaultCamera = camera.state;
        this.alignmentViews = preparedDefault.checkpoints;
        this.savedViewRecord = record;
        this.releaseSavedViews?.(); this.releaseSavedViews = owner; owner = undefined;
        setApp({ savedViewChoices: [], savedViewAvailable: true, background: record.view.background,
          viewStatus: 'Saved view imported and restored. Scene edits are unchanged.', autoOrbit: false, fly: false, tool: null });
        this.invalidate(); return true;
      } finally { owner?.(); preparedDefault?.release?.(); pair.dispose(); }
    });
  }
  exportSavedView(): Promise<boolean> {
    return this.transferSavedView('export', async ({ source, scene, record, operation, current }) => {
      if (!record) throw new Error('Use Update Thumbnail to save a default view first.');
      const pair = await this.viewStorage.get(record.recordId, operation);
      let output: Awaited<ReturnType<typeof writePortableSavedView>> | undefined;
      try {
        current();
        const kind = scene.kind === 'gaussian' ? 'gaussian' : scene.descriptor.kind === 1 ? 'points' : 'mesh';
        if (!savedViewMatches(pair.record, source, kind) || JSON.stringify(pair.record) !== JSON.stringify(record))
          throw new Error('The saved view changed. Reopen this scene before exporting its view.');
        output = await writePortableSavedView(pair.record, pair.image, operation); current();
        const retained = output;
        let settle: (() => void) | undefined, completed = false;
        const base = useApp.getState().sourceName.replace(/\.[^.]*$/, '').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').slice(0, 180) || 'SplatView';
        settle = downloadBlob(output.blob, `${base}-view.splatview-view.zip`, () => {
          completed = true; retained.dispose(); if (settle) this.viewDownloads.delete(settle);
        }, current);
        if (!completed) this.viewDownloads.add(settle); output = undefined;
        setApp({ viewStatus: 'Saved-view download prepared. Keep the file; it contains a view and thumbnail.' });
        return true;
      } finally { output?.dispose(); pair.dispose(); }
    });
  }
  async fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (error) { this.error(error); } }
  dispose() {
    this.transformPivotUnsubscribe?.(); this.transformPivotUnsubscribe = undefined;
    this.resetTransformPivotSynchronization();
    this.clearToolbarFeedback();
    this.benchmarkObservation?.disable('Controller disposed; pending frame/operation observations were cancelled.');
    this.cancelDeferredColorPointers(); this.onDeferredPointerCancel = undefined;
    this.clearOpacityPreview(); this.opacityEntryRequest = undefined;
    this.cancelTransformGizmoGesture(undefined, true);
    this.cancelFilterGizmoGesture(undefined, true);
    this.cancelAlignment();
    this.alignmentDefaultCamera = undefined;
    this.clearAlignmentViews();
    if (this.destroyed) return;
    this.destroyed = true;
    this.viewportListeners.clear();
    this.exportOperation?.cancel.abort();
    this.renderer?.setHistogramEnabled(false); this.renderer?.resetHistogram();
    setApp({ histogram: null });
    this.thumbnailAbort?.abort(); this.cancelSavedViewTransfer(); this.cancelImageCaptures(); this.savedViewRecord = undefined;
    setApp({ savedViewChoices: [], thumbnailPending: false, viewTransferPending: false, savedViewAvailable: false, viewStatus: null });
    const collection = this.collection; this.collection = undefined;
    this.cancelIntake(); this.files = Object.freeze([]); this.currentFile = 0; this.pendingNavigation = undefined;
    setApp({ collectionCount: 0, collectionIndex: 0, collectionPath: '', collectionPrevious: false, collectionNext: false });
    this.fingerprint = undefined;
    this.selection?.cancel.abort();
    const releasedCleanup = this.cancelReleasedSelections();
    this.tolerance?.mapQuery?.abort();
    const mapCleanup = this.selectionMaps.invalidate();
    this.tolerance?.session.retire(); this.tolerance = undefined;
    this.recoveryCancel?.abort(); this.cancelLoad(); cancelAnimationFrame(this.frame); this.resize?.disconnect();
    this.documentRecovery?.release(); this.documentRecovery = undefined; this.workerFailure = undefined;
    const renderer = this.renderer, camera = this.camera;
    const bootstrap = this.bootstrapClient, bootstrapMemory = this.bootstrapMemory;
    this.bootstrapClient = undefined; this.bootstrapMemory = undefined; bootstrap?.dispose();
    if (bootstrap) void bootstrap.retireNativeMemory().catch(() => undefined); else bootstrapMemory?.retire();
    const client = this.client; client?.dispose(); this.client = undefined;
    this.committedGraphicsRecovery = undefined;
    const scene = this.scene, releaseScene = this.releaseScene, releaseHistory = this.releaseHistory, memory = this.sourceMemory;
    const viewsOwner = this.releaseSavedViews; this.releaseSavedViews = undefined;
    const edit = this.editOperation?.finished, exporting = this.exportOperation?.finished, recovery = this.recovery;
    this.transformPivotQuery?.cancel.abort();
    const morphologyRange = this.morphologyRangeOwner?.finished; this.morphologyRangeOwner?.cancel.abort();
    const filterTasks = [...this.filterTasks]; this.filterOwner = undefined;
    const transformTasks = [...this.transformTasks]; this.transformOwner = undefined; this.transformGradeRequest = undefined;
    const opacityTasks = [...this.opacityTasks]; this.opacityOwner = undefined;
    this.scene = undefined; this.releaseScene = undefined; this.releaseHistory = undefined; this.sourceMemory = undefined;
    this.colorDisplay = undefined;
    this.renderer = undefined; this.camera = undefined; this.selection = undefined;
    this.selectionCleanupOwner = undefined; this.outputReceipt = undefined; this.savedContent = 0;
    this.onOpenPicker = undefined; this.onViewportResize = undefined; this.onSelectionOperationChanged = undefined;
    setApp({ summary: null, sourceName: '', dirty: false, ready: false, rendererState: 'unavailable', busy: false, stage: '', progress: 0, memoryOverageBytes: 0,
      settingsOpen: false, exportOpen: false, tool: null, filter: null, filterCenterPicking: false, filterCenterPending: false,
      transform: null, transformPreview: null, transformParameters: transformDefaults(), transformGizmoMode: null, transformGizmoDragging: false,
      transformPivotMode: 'scene', transformPivotChosen: false, transformPivotPending: false,
      opacity: null, opacityScale: 1, opacityPreview: null,
      autoOrbit: false, fly: false, selectionRecovery: 'idle', operationRecovery: 'idle', operationRecoveryCommitted: false,
      selectionOperation: null, selectionDragging: false, pendingSelectionCount: 0, pendingMode: null,
      grade: [...NEUTRAL_COLOR], appliedGrade: [...NEUTRAL_COLOR], colorSession: null, colorSelectedOnly: false, error: null });
    // Termination rejects operations promptly, but their borrowed GPU/read
    // owners must settle before the module remainder can leave the ledger.
    void (async () => {
      await Promise.allSettled([releasedCleanup, mapCleanup, ...(morphologyRange ? [morphologyRange] : []), this.selectionCleanup, this.toleranceCleanup, ...filterTasks, ...transformTasks, ...opacityTasks, ...(this.opacityEntryTask ? [this.opacityEntryTask] : []),
        this.floorCleanup, ...this.floorTasks,
        ...this.sourceLoads, ...this.collectionCleanup, ...this.thumbnailTasks, ...this.viewTransferTasks, ...this.imageTasks, ...(scene ? [scene.dispose()] : []), ...(edit ? [edit] : []), ...(exporting ? [exporting] : []), ...(recovery ? [recovery] : [])]);
      // Confirmation may have scheduled this cleanup after the captured edit
      // finished. Join it before returning native/source credit to the ledger.
      this.cancelAlignment(); await this.floorCleanup;
      await this.drainCollectionCleanup();
      await collection?.dispose();
      for (const settle of this.viewDownloads) settle();
      for (const settle of this.exportDownloads) settle();
      renderer?.dispose();
      this.releaseRetainedGraphics(scene);
      if (client) await client.retireNativeMemory(); else memory?.retire();
      releaseScene?.(); releaseHistory?.(); viewsOwner?.();
    })().catch(() => undefined);
    camera?.dispose();
  }
}
export type AppControllerBenchmarkSnapshot = ReturnType<AppController['benchmarkSnapshot']>;
