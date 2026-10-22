import frameSource from './frame.wgsl?raw';
import surfaceSource from './surface.wgsl?raw';
import type { GaussianRenderer } from './renderer';

const baseEntries = ['bin', 'scatter', 'sortTile', 'composite', 'prepareAuxiliary'] as const;
type BaseEntry = typeof baseEntries[number];
export type SurfacePipelines = Record<BaseEntry, GPUComputePipeline> & { markVisible?: GPUComputePipeline };
type Preparation = { module: GPUShaderModule; base: Promise<Record<BaseEntry, GPUComputePipeline>>;
  visibility?: Promise<GPUComputePipeline> };
const preparations = new WeakMap<GaussianRenderer, Promise<Preparation>>();

/** Launch asynchronous compilation under synchronously balanced error scopes.
 * Neither optional warming nor a query leaves a device scope open across a yield.
 * Visibility is independent: ordinary depth/color queries never compile it.
 */
export async function prepareSurfacePipelines(renderer: GaussianRenderer,
  options: { visible?: boolean } = {}): Promise<SurfacePipelines> {
  renderer.requireScene();
  let preparation = preparations.get(renderer);
  if (!preparation) {
    preparation = renderer.checkedAllocation(() => {
      const module = renderer.device.createShaderModule({ label: 'Native composited surface map', code: frameSource + surfaceSource });
      const base = Promise.all(baseEntries.map(async entryPoint => [entryPoint,
        await renderer.device.createComputePipelineAsync({ label: `Surface ${entryPoint}`, layout: 'auto',
          compute: { module, entryPoint } })] as const)).then(entries => Object.fromEntries(entries) as Record<BaseEntry, GPUComputePipeline>);
      // A pipeline can reject before asynchronous error-scope reports settle.
      void base.catch(() => undefined);
      return { module, base };
    }, async value => { await value.base.catch(() => undefined); });
    preparations.set(renderer, preparation);
  }
  try {
    const state = await preparation;
    if (options.visible && !state.visibility) {
      state.visibility = renderer.checkedAllocation(() => {
        const pipeline = renderer.device.createComputePipelineAsync({ label: 'Surface markVisible', layout: 'auto',
          compute: { module: state.module, entryPoint: 'markVisible' } });
        void pipeline.catch(() => undefined);
        return { pipeline };
      }, async value => { await value.pipeline.catch(() => undefined); }).then(value => value.pipeline);
      void state.visibility.catch(() => undefined);
    }
    const [base, markVisible] = await Promise.all([state.base, options.visible ? state.visibility : undefined]);
    renderer.requireScene();
    return markVisible ? { ...base, markVisible } : base;
  } catch (error) {
    if (preparations.get(renderer) === preparation) preparations.delete(renderer);
    throw error;
  }
}

export function forgetSurfacePipelines(renderer: GaussianRenderer): void {
  preparations.delete(renderer);
}

