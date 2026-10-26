import type { ImageOperation } from '../io/image';
import type { RenderCamera } from './frame';
import type { SortPrecision } from './sortPrecision';
import type { GeometryDescriptor } from './geometryLayout';
import type { DuplicateRange } from '../document/duplicateProtocol';
import type { OwnedRgbaImage } from '../io/image';

import type { RenderedHistogram } from './histogram';
import type { GraphicsBackend } from './backend';
import type { SteadySettings, SteadyStatus } from './steadySettings';
import type { RendererNegotiationSnapshot } from './webgpu/diagnostics';
import type { SurfaceMap, SurfaceOptions } from './webgpu/surfaceQuery';

/** Only the resource owner creates these; callers retire them after finish(). */
export interface RetiredRenderResource { destroy(): void }
export type PreviewMaskChannel = 'colorBase' | 'transformBase' | 'opacityBase';
export type PreviewMasks = Partial<Record<PreviewMaskChannel, ArrayBuffer | null>>;
export type MaskUpdate = { allocationBytes: number; retirementBytes?: number;
  retirementBuffers?: readonly RetiredRenderResource[]; publish(): RetiredRenderResource; dispose(): void | Promise<void> };
export type PreviewMaskUpdate = { allocationBytes: number; retirementBytes: number;
  retirementBuffers: readonly RetiredRenderResource[]; publish(): RetiredRenderResource | undefined; dispose(): void | Promise<void> };
export type RenderPick = { index: number | null; depth: number; opacity: number; contribution: number; deviceEpoch: number };
export class StaleRenderQueryError extends Error {}
type SceneIdentity = { readonly renderer: SceneRenderer; readonly count: number; readonly deviceEpoch: number;
  readonly revision: number; readonly allocationBytes: number; retired: boolean; dispose(): Promise<void> };
export interface GaussianScene extends SceneIdentity {
  readonly kind: 'gaussian'; readonly degree: number; readonly stride: number;
  readonly sourceRevision: number; readonly selectedRevision: number; readonly duplicateSelectionGuarded: boolean;
  upload(first: number, count: number, bytes: ArrayBuffer): Promise<void>;
  masks(bytes: ArrayBuffer): void;
  stageMasks(bytes: ArrayBuffer, targets?: PreviewMasks): Promise<MaskUpdate>;
  stagePreviewMasks(bytes: ArrayBuffer | null, channel: PreviewMaskChannel): Promise<PreviewMaskUpdate>;
  previewMaskRevision(channel: PreviewMaskChannel): number;
  hasPreviewMask(channel: PreviewMaskChannel): boolean;
  setDuplicateRange(value: DuplicateRange): void;
}
export interface GeometryScene extends SceneIdentity {
  readonly kind: 'geometry'; readonly descriptor: GeometryDescriptor; readonly contentRevision: number;
  uploadVertices(first: number, count: number, bytes: ArrayBuffer): Promise<void>;
  uploadIndices(first: number, count: number, bytes: ArrayBuffer): Promise<void>;
}
export type RenderScene = GaussianScene | GeometryScene;
export type SteadySnapshot = Readonly<{ status: SteadyStatus; reason: string | null; allocationBytes: number;
  frame: number; restFrames: number; valid: boolean }>;

/** Shared controller boundary; GPU/GL handles and execution stay in their backend. */
export type DisplayCompletion=Readonly<{deviceEpoch:number;submissionSequence:number;done:Promise<void>}>;

export interface SceneRenderer {
  readonly backend: GraphicsBackend; readonly deviceEpoch: number; readonly canvas: HTMLCanvasElement;
  readonly frameSubmissionSequence: number; readonly negotiationSnapshot: RendererNegotiationSnapshot;
  readonly steadySnapshot: SteadySnapshot; lost: boolean;
  /** Interactive sorted display only; queries and clean capture remain exact. */
  displaySortPrecision: SortPrecision;
  admitGeometryDepth?: (bytes: number) => () => void;
  /** Persistent worker sort scratch; separate from active-job work credits. */
  admitSortScratch?: (bytes:number)=>()=>void;
  admitWork?: (bytes: number) => () => void;
  admitHistogram?: (bytes: number) => () => void;
  admitSteady?: (bytes: number) => () => void;
  onHistogram?: (result: RenderedHistogram, scene: RenderScene) => void;
  onHistogramUnavailable?: () => void;
  onRenderStatus?: (status: SteadyStatus) => void;
  onFrameNeeded?: () => void;
  onLost?: (message: string) => void;
  onDeviceLost?: (message: string) => void;
  allocateScene(count: number, degree: number): Promise<GaussianScene>;
  allocateGeometry(descriptor: GeometryDescriptor): Promise<GeometryScene>;
  requireScene(scene?: RenderScene): void;
  render(scene: RenderScene | undefined, camera: RenderCamera, grade?: number[], highlight?: boolean,
    geometry?: number[], selectedOnly?: boolean, geometrySelectedOnly?: boolean, opacityScale?: number,
    opacitySelectedOnly?: boolean): void | Promise<void>;
  pick(scene: GaussianScene, x: number, y: number, centerRadius?: number): Promise<RenderPick>;
  surface(scene: GaussianScene, options: SurfaceOptions): Promise<SurfaceMap>;
  prepareSurfaceResources(): Promise<void>;
  /** Completion of the last actual display submission; excludes unrelated queries/retirement. */
  displayCompletion?(): DisplayCompletion | undefined;
  finish(): Promise<void>;
  captureRgba(scene: RenderScene, camera: RenderCamera, operation: ImageOperation, grade?: number[],
    geometry?: number[], selectedOnly?: boolean, geometrySelectedOnly?: boolean, opacityScale?: number,
    opacitySelectedOnly?: boolean): Promise<OwnedRgbaImage>;
  capture(scene: RenderScene, camera: RenderCamera, type?: string, grade?: number[], geometry?: number[],
    selectedOnly?: boolean, geometrySelectedOnly?: boolean, opacityScale?: number, opacitySelectedOnly?: boolean): Promise<Blob>;
  setOpacityPreview(scale: number, selectedOnly: boolean): void;
  setRenderSettings(settings: SteadySettings): void;
  resetRenderHistory(): void;
  setHistogramEnabled(enabled: boolean): void;
  resetHistogram(): void;
  trimSurfaceResources(owner?: object): void;
  /** Stop this renderer and join its optional preparation/resource retirement.
   * The host must first retire scenes and join outstanding borrowed outputs. */
  close(): Promise<void>;
  dispose(): void;
}
