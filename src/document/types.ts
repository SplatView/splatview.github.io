import type { SelectionMapDescriptor } from './selectionMap';
import type { GeometryChannel, GeometryDescriptor } from '../renderer/geometryLayout';
import type { SingleSourceDescriptor, SourceRange } from './source';
import type { GroupSourceDescriptor } from './sourceGroup';
import type { SourceFingerprint } from '../io/fingerprint';
import type { NativeHeapSnapshot } from './nativeMemory';
import type { NativeAllocationCensus } from './allocationCensus';
import { BUILD_DESCRIPTOR } from '../generated/buildIdentity';
import type { ColorBaseIdentity, ColorSessionSummary } from './colorProtocol';
import type { AlignmentSummary } from './alignmentProtocol';
import type { FloorSummary } from './floorProtocol';
import type { SceneExportPlan, Spz4ExportPlan } from './spz4Export';
import type { AdmittedSceneExportFormat } from './exportFormats';
import type { SelectionFilterSummary } from './filterProtocol';
import type { TransformBaseIdentity, TransformSessionSummary } from './transformProtocol';
import type { OpacityBaseIdentity, OpacitySessionSummary } from './opacityProtocol';
import type { OperationAction, OperationOwner, OperationReceipt } from './operationProtocol';
import type { RecoveryStart, RecoveryControl, RecoveryIntermediate, RecoveryTerminal } from './recoveryProtocol';
import type { MaskChannel } from './selectionView';
import type { MorphologyRange } from '../input/selectionMorphology';
import type { DuplicateRange } from './duplicateProtocol';
import type { ToleranceRange } from './selectionRange';
export const PROTOCOL_VERSION = BUILD_DESCRIPTOR.protocolVersion;
export const BUILD_ID = BUILD_DESCRIPTOR.appInputId;
export type Revision = {
  documentId: string;
  sourceGeneration: number;
  contentRevision: number;
  selectionRevision: number;
  draftRevision: number;
};
export type ViewRevision = { cameraRevision: number; viewportRevision: number; deviceEpoch: number };
export type Envelope = { protocolVersion: number; buildId: string; requestId: number; base: Revision; assetBase?: string; operationOwner?: OperationOwner };
export type NativeSummary = {
  ok: boolean; error?: string; loaded: boolean; count: number; sourceCount: number;
  duplicateRange: DuplicateRange;
  shDegree: number; format: string; kind: number; selected: number; visible: number;
  canUndo: boolean; canRedo: boolean; revision: number; contentRevision: number;
  /** Worker-lifetime committed selection event; not a durable checkpoint ID.
   * Optional only for isolated legacy controller doubles. Runtime cap2 requires it. */
  selectionCommitRevision?: number;
  /** Required with selectionActions2. Runtime-only top selection Undo stamp;
   * zero also represents restored historical or nonselection Undo entries. */
  undoSelectionRevision?: number;
  transaction: boolean; selectionDraft: boolean; sceneChanged: boolean;
  pending: boolean; progress: number; center: [number, number, number]; radius: number;
  yUp: boolean; camera: number[]; memoryBytes: number;
  exportBytes?: number; exportOutputBytes?: number;
  point?: [number, number, number] | null;
  toleranceSessionId?: number | null;
  toleranceTool?: 'color' | 'fill' | null;
  toleranceConnected?: boolean | null;
  /** Required own nullable metadata with colorFillRange:1. Optional only for
   * isolated legacy controller doubles that do not cross a runtime boundary. */
  toleranceRange?: ToleranceRange | null;
  /** Required with selectionActions1: exact originating checkpoint Undo bit,
   * null iff no completed tolerance owner. Never infer from revision/count. */
  toleranceRecorded?: boolean | null;
  toleranceMapId?: number | null;
  selectionMapId: number | null;
  pendingSelectionMapId: number | null;
  selectionMapBytes: number;
  selectionMapRetainedIds: number[];
  geometry?: GeometryDescriptor | null;
  sourceFaces?: number;
  sampledGeometry?: boolean;
  colorSession?: ColorSessionSummary | null;
  alignment?: AlignmentSummary | null;
  floor: FloorSummary | null;
  filter: SelectionFilterSummary | null;
  transformSession: TransformSessionSummary | null;
  opacitySession: OpacitySessionSummary | null;
  morphologyRange?: MorphologyRange | null;
};
export type SceneCommand = { command: string; [key: string]: unknown };
export type LivePreviewOutcome =
  | { kind: 'published'; version: 1; summary: NativeSummary }
  | { kind: 'computation-failed'; version: 1 };
export type WorkerRequest = Envelope & (
  | RecoveryStart | RecoveryControl
  | { type: 'operation'; action: OperationAction; operationOwner: OperationOwner }
  | { type: 'source-load'; source: SingleSourceDescriptor; format: number; maxSplats: number; budgetBytes: number; sourceBudgetBytes: number }
  | { type: 'source-group-load'; source: GroupSourceDescriptor; maxSplats: number; budgetBytes: number; sourceBudgetBytes: number; nativeWorkBytes: number }
  | ({ type: 'source-range'; bytes: ArrayBuffer } & SourceRange)
  | { type: 'command'; command: SceneCommand }
  | { type: 'live-preview'; command: SceneCommand }
  | { type: 'stream'; channel?: MaskChannel; colorBase?: ColorBaseIdentity; transformBase?: TransformBaseIdentity; opacityBase?: OpacityBaseIdentity }
  | { type: 'geometry-stream'; descriptor: GeometryDescriptor }
  | { type: 'masks'; channel?: MaskChannel; colorBase?: ColorBaseIdentity; transformBase?: TransformBaseIdentity; opacityBase?: OpacityBaseIdentity }
  | { type: 'export'; command: SceneCommand }
  | { type: 'export-plan' }
  | { type: 'scene-export-plan'; format: AdmittedSceneExportFormat; scope: number }
  | { type: 'ack'; chunkId: number }
  | { type: 'cancel' }
  | { type: 'selection-map'; descriptor: SelectionMapDescriptor }
  | { type: 'map-chunk'; mapId: number; offset: number; bytes: ArrayBuffer }
  | { type: 'map-commit'; mapId: number }
);
export type NativeAllocationSnapshot = Readonly<{
  loaded: boolean; kind: number; count: number; memoryBytes: number;
  selectionMapBytes: number; selectionMapRetainedIds: readonly number[];
  exportBytes?: number; exportOutputBytes?: number;
}>;
export type InitializedWorkerTelemetry = {
  initializationId: string; heap: NativeHeapSnapshot; census: NativeAllocationCensus; allocation: NativeAllocationSnapshot;
};
/** Native recovery holds an immutable graph/import owner that refuses summary
 * commands. Its intermediate telemetry therefore reports only real heap and
 * census observations; no stale scene allocation can supply native coverage. */
export type RecoveryWorkerTelemetry = Omit<InitializedWorkerTelemetry, 'allocation'> & { allocation: null };
export type WorkerResponse = Envelope & ((InitializedWorkerTelemetry & (
  | RecoveryTerminal
  | ({ type: 'source-range-request' } & SourceRange)
  | ({ type: 'source-range-consumed' } & SourceRange)
  | { type: 'source-load-result'; operationId: string; resourceId: string; consumedBytes: number; summary: NativeSummary; fingerprint: SourceFingerprint }
  | { type: 'result'; summary: NativeSummary }
  | { type: 'operation-result'; receipt: OperationReceipt; summary: NativeSummary }
  | { type: 'operation-retired'; operationOwner: OperationOwner }
  | { type: 'live-preview'; outcome: LivePreviewOutcome }
  | { type: 'progress'; stage: string; fraction: number }
  | { type: 'chunk'; chunkId: number; first: number; count: number; bytes: ArrayBuffer }
  | { type: 'geometry-chunk'; descriptor: GeometryDescriptor; channel: GeometryChannel; chunkId: number; first: number; count: number; bytes: ArrayBuffer }
  | { type: 'masks'; bytes: ArrayBuffer }
  | { type: 'output'; bytes: ArrayBuffer; summary: NativeSummary }
  | { type: 'export-plan'; plan: Spz4ExportPlan; summary: NativeSummary }
  | { type: 'scene-export-plan'; plan: SceneExportPlan; summary: NativeSummary }
  | { type: 'map-chunk-request'; mapId: number; offset: number; length: number }
  | { type: 'map-ready'; mapId: number }
  | { type: 'error'; error: string; cancelled?: boolean; summary?: NativeSummary; cleanupFailed?: boolean }
)) | (RecoveryWorkerTelemetry & RecoveryIntermediate) | { type: 'error'; initializationId: null; heap: null; census: null; allocation: null; error: string;
  cancelled?: never; summary?: never; cleanupFailed?: never });
export function sameRevision(a: Revision, b: Revision): boolean {
  return a.documentId === b.documentId && a.sourceGeneration === b.sourceGeneration &&
    a.contentRevision === b.contentRevision && a.selectionRevision === b.selectionRevision &&
    a.draftRevision === b.draftRevision;
}
export function acceptsResult(envelope: Envelope, current: Revision): boolean {
  return envelope.protocolVersion === PROTOCOL_VERSION && envelope.buildId === BUILD_ID &&
    sameRevision(envelope.base, current);
}
