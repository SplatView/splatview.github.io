import { createSceneRenderer } from '../renderer/factory';
import { RenderComputeClient } from '../renderer/webgl2/computeClient';
import ComputeWorker from './compute.worker.ts?worker';
import type { SceneRenderer } from '../renderer/contracts';
import type { GraphicsBackend, GraphicsBackendPreference } from '../renderer/backend';
import type { RendererNegotiationObserver } from '../renderer/webgpu/diagnostics';
import type { SortPrecision } from '../renderer/sortPrecision';
import { IDENTITY_MATRIX as frameIdentity, NEUTRAL_COLOR as frameNeutral } from '../renderer/defaults';

export type RendererOptions = {
  preference?: GraphicsBackendPreference;
  /** Explicit restoration keeps the backend selected before device loss. */
  recoveryBackend?: GraphicsBackend;
  allowFallback?: boolean;
  /** Display depth keys; exact queries and clean capture always retain 32 bits. */
  sortPrecision?: SortPrecision;
  /** Required when a failed backend has already claimed the canvas. */
  replaceCanvas?: (previous: HTMLCanvasElement) => Promise<HTMLCanvasElement>;
  observe?: RendererNegotiationObserver;
  fallback?: (reason: string) => void;
};

/** Create a browser renderer without application, native or camera bootstrap.
 * The host owns scenes, result disposal, admission and frame scheduling. */
export function createRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): Promise<SceneRenderer> {
  return createSceneRenderer(canvas, {
    ...options, preference: options.preference ?? 'auto', allowFallback: options.allowFallback ?? true,
    createCompute: () => RenderComputeClient.connect(new ComputeWorker({ name: 'splatview-standalone-compute' }),
      { kind: 'standalone', protocolVersion: 1, sourceId: __SPLATVIEW_ENGINE_SOURCE_ID__ }),
  });
}

// This is the public SDK boundary, not an internal compatibility import path.
export type { SceneRenderer, RenderScene, GaussianScene, GeometryScene, RenderPick, SteadySnapshot,
  PreviewMasks, PreviewMaskChannel, MaskUpdate, PreviewMaskUpdate, DisplayCompletion } from '../renderer/contracts';
export { StaleRenderQueryError } from '../renderer/contracts';
export type { RenderCamera } from '../renderer/frame';
export type { GraphicsBackend, GraphicsBackendPreference } from '../renderer/backend';
export type { GeometryDescriptor } from '../renderer/geometryLayout';
export type { SurfaceOptions, SurfaceMap, SurfaceRegion, SurfaceChannels } from '../renderer/webgpu/surfaceQuery';
export { SurfaceCapacityError } from '../renderer/webgpu/surfaceQuery';
export type { ImageOperation, OwnedRgbaImage, OwnedImageOutput } from '../io/image';
export { encodeRgba, withRgbaImage } from '../io/image';
export { ResourceLedger, AdmissionError, packedStride, estimateSceneBytes } from '../document/resources';
export type { ResourceLease } from '../document/resources';
/** Public convenience values never expose the renderer's shared default arrays. */
export const IDENTITY_MATRIX = [...frameIdentity], NEUTRAL_COLOR = [...frameNeutral];
export { DEFAULT_STEADY_SETTINGS, validateSteadySettings } from '../renderer/steadySettings';
export type { SteadySettings, SteadyStatus, GaussianRenderMode } from '../renderer/steadySettings';
export type { RendererNegotiationObserver, RendererNegotiationSnapshot } from '../renderer/webgpu/diagnostics';
export { DisplayFrameAdmission } from '../renderer/displayFrameAdmission';
export type { DisplayFrameIdentity } from '../renderer/displayFrameAdmission';
export { validateSortPrecision } from '../renderer/sortPrecision';
export type { SortPrecision } from '../renderer/sortPrecision';
export { interactiveDisplayPrecision } from '../renderer/displayPrecision';
export type { DisplayPoseIdentity } from '../renderer/displayPrecision';
