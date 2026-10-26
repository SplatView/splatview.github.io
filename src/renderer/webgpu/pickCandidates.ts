import frameSource from './frame.wgsl?raw';
import source from './pickCandidates.wgsl?raw';
import type { GaussianRenderer, GpuScene } from './renderer';

const entries = ['countCandidates', 'candidateOffsets', 'scatterCandidates', 'pickCandidates'] as const;
type Pipelines = Record<typeof entries[number], GPUComputePipeline>;
const preparations = new WeakMap<GaussianRenderer, Promise<Pipelines>>();

export async function preparePickCandidates(renderer: GaussianRenderer): Promise<Pipelines> {
  let pending = preparations.get(renderer);
  if (!pending) {
    pending = renderer.checkedAllocation(() => {
      const module = renderer.device.createShaderModule({ label: 'Exact compact pick', code: frameSource + source });
      const task = Promise.all(entries.map(async entryPoint => [entryPoint,
        await renderer.device.createComputePipelineAsync({ label: `Pick ${entryPoint}`, layout: 'auto', compute: { module, entryPoint } })] as const));
      void task.catch(() => undefined); return { task };
    }, async value => { await value.task.catch(() => undefined); }).then(async value => Object.fromEntries(await value.task) as Pipelines);
    preparations.set(renderer, pending);
  }
  try { const value = await pending; renderer.requireScene(); return value; }
  catch (error) { if (preparations.get(renderer) === pending) preparations.delete(renderer); throw error; }
}

export async function allocatePickCandidates(renderer: GaussianRenderer, scene: GpuScene) {
  // Small sources keep the cheaper single-pass baseline. Admission/pipeline
  // refusal preserves that exact path and adds no rendering requirement.
  if (scene.count < 2048 || !renderer.admitWork) return undefined;
  let release: (() => void) | undefined;
  const groups = Math.ceil(scene.count / 256), buffers: GPUBuffer[] = [];
  try {
    release = renderer.admitWork(scene.count * 8 + (groups + 1) * 4);
    const pipelines = await preparePickCandidates(renderer);
    const value = await renderer.checkedAllocation(() => {
      for (const size of [scene.count * 4, (groups + 1) * 4, scene.count * 4])
        buffers.push(renderer.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE }));
      const [ranks, counts, candidates] = buffers;
      const bindings: Record<typeof entries[number], [number, GPUBuffer][]> = {
        countCandidates: [[0, renderer.frame], [1, scene.buffers.projected], [2, scene.ordered], [3, renderer.query], [5, ranks], [6, counts]],
        candidateOffsets: [[0, renderer.frame], [6, counts]],
        scatterCandidates: [[0, renderer.frame], [2, scene.ordered], [5, ranks], [6, counts], [7, candidates]],
        pickCandidates: [[0, renderer.frame], [1, scene.buffers.projected], [3, renderer.query], [4, renderer.queryOutput], [6, counts], [7, candidates]],
      };
      return entries.map(name => ({ name, pipeline: pipelines[name], group: renderer.bind(pipelines[name], bindings[name]) }));
    }, () => { for (const buffer of buffers) buffer.destroy(); });
    let disposed = false;
    return {
      encode(encoder: GPUCommandEncoder) {
        for (const stage of value) { const pass = encoder.beginComputePass({ label: `Pick ${stage.name}` });
          pass.setPipeline(stage.pipeline); pass.setBindGroup(0, stage.group);
          pass.dispatchWorkgroups(stage.name === 'candidateOffsets' || stage.name === 'pickCandidates' ? 1 : groups); pass.end(); }
      },
      dispose() { if (disposed) return; disposed = true; for (const buffer of buffers) buffer.destroy(); release?.(); },
    };
  } catch { for (const buffer of buffers) buffer.destroy(); release?.(); return undefined; }
}
