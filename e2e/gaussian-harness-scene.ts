import type { GpuScene, RenderableScene } from '../src/renderer/webgpu/renderer';

/** Existing mask/query oracles require their actual Gaussian GPU authority. */
export function requireGaussianScene(scene: RenderableScene | undefined): GpuScene {
  if (!scene || scene.kind !== 'gaussian') throw new Error('The Gaussian test fixture did not publish a Gaussian scene.');
  return scene;
}
