import type { CoreClient } from '../document/coreClient';
import { IDENTITY_MATRIX } from '../renderer/defaults';
import type { CameraController } from '../input/camera';
import { StaleRenderQueryError, type SceneRenderer, type GaussianScene } from '../renderer/contracts';

/** View/source dependencies only. Admission, observation and execution belong to the adapter. */
export type SelectionMapDependencyContext = {
  client: CoreClient;
  renderer: SceneRenderer;
  scene: GaussianScene;
  camera: CameraController;
  current(): void;
  geometry?: number[];
  selectedOnly?: boolean;
  geometrySelectedOnly?: boolean;
  opacityScale?: number;
  opacitySelectedOnly?: boolean;
  opacityPreviewRevision?: number;
};

const identities = new WeakMap<object, number>();
let sequence = 0;
function identity(value: object) {
  let result = identities.get(value);
  if (result === undefined) { result = ++sequence; identities.set(value, result); }
  return result;
}

/** Capture the cache key and render inputs together, without acquiring any resource.
 * Display grading and ordinary selection do not change the raw surface. Canonical
 * selection/preview targets matter only when geometry or opacity uses that scope.
 * Geometry is copied here; its live owner is checked by context.current().
 */
export function captureSelectionMapDependencies(context: SelectionMapDependencyContext) {
  const { client, scene, renderer, camera } = context;
  const revision = { ...client.revision }, contentRevision = client.nativeContentRevision;
  const sourceRevision = scene.sourceRevision, selectedRevision = scene.selectedRevision;
  const cameraRevision = camera.revision, width = renderer.canvas.width, height = renderer.canvas.height;
  const geometry = Object.freeze([...(context.geometry ?? IDENTITY_MATRIX)]), selectedOnly = !!context.selectedOnly;
  const geometrySelectedOnly = context.geometrySelectedOnly ?? selectedOnly;
  const selectedGeometry = geometrySelectedOnly && geometry.some((value, i) => value !== IDENTITY_MATRIX[i]);
  const opacityInput = context.opacityScale ?? 1;
  if (!Number.isFinite(opacityInput) || opacityInput < 0 || opacityInput > 5)
    throw new RangeError('Opacity scale must be between 0 and 5.');
  const opacityScale = Math.fround(opacityInput), selectedOpacity = opacityScale !== 1 && !!context.opacitySelectedOnly;
  const transformTarget = selectedGeometry ? scene.previewMaskRevision?.('transformBase') ?? 0 : 0;
  const opacityTarget = selectedOpacity ? scene.previewMaskRevision?.('opacityBase') ?? 0 : 0;
  const opacityRevision = context.opacityPreviewRevision ?? 0;

  const assertCurrent = () => {
    context.current();
    const currentOpacity = Math.fround(context.opacityScale ?? 1);
    const currentOpacityScope = currentOpacity !== 1 && !!context.opacitySelectedOnly;
    if (renderer.lost || scene.retired || scene.renderer !== renderer || scene.sourceRevision !== sourceRevision ||
      ((selectedGeometry || selectedOpacity) && scene.selectedRevision !== selectedRevision) || camera.revision !== cameraRevision ||
      (selectedGeometry && (scene.previewMaskRevision?.('transformBase') ?? 0) !== transformTarget) ||
      (selectedOpacity && (scene.previewMaskRevision?.('opacityBase') ?? 0) !== opacityTarget) ||
      (context.opacityPreviewRevision ?? 0) !== opacityRevision ||
      currentOpacity !== opacityScale || currentOpacityScope !== selectedOpacity ||
      renderer.canvas.width !== width || renderer.canvas.height !== height ||
      client.revision.documentId !== revision.documentId || client.revision.sourceGeneration !== revision.sourceGeneration ||
      client.nativeContentRevision !== contentRevision)
      throw new StaleRenderQueryError('The selection surface no longer matches this document and view.');
  };
  const key = [identity(client), revision.documentId, revision.sourceGeneration, contentRevision,
    identity(renderer), renderer.deviceEpoch, identity(scene), sourceRevision, identity(camera), cameraRevision,
    width, height, geometry.join(','), selectedGeometry || selectedOpacity ? selectedRevision : '', selectedGeometry,
    opacityScale, selectedOpacity, opacityRevision, transformTarget, opacityTarget].join(':');

  return Object.freeze({ key, assertCurrent, geometry, selectedOnly, geometrySelectedOnly, opacityScale, selectedOpacity });
}
