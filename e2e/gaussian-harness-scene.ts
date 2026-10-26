import { GaussianRenderer, GpuScene, GpuGeometryScene, type RenderableScene } from '../src/renderer/webgpu/renderer';
import type { RenderScene, SceneRenderer } from '../src/renderer/contracts';
import type { AppController } from '../src/app/controller';

/** Existing mask/query oracles require their actual Gaussian GPU authority. */
export function requireGaussianScene(scene: RenderScene | undefined): GpuScene {
  if (!(scene instanceof GpuScene)) throw new Error('The Gaussian GPU oracle requires an actual WebGPU Gaussian scene.');
  return scene;
}
/** GPU-only fault/readback oracles must fail explicitly if another backend is selected. */
export function requireWebGpuRenderer(renderer: SceneRenderer | undefined): GaussianRenderer {
  if (!(renderer instanceof GaussianRenderer)) throw new Error('This GPU oracle requires the WebGPU backend.');
  return renderer;
}
export function requireWebGpuController(controller: AppController): AppController & { renderer: GaussianRenderer; scene?: RenderableScene } {
  requireWebGpuRenderer(controller.renderer);
  if (controller.scene && !(controller.scene instanceof GpuScene) && !(controller.scene instanceof GpuGeometryScene))
    throw new Error('The GPU oracle scene belongs to another backend.');
  return controller as AppController & { renderer: GaussianRenderer; scene?: RenderableScene };
}
