import { expect, test } from '@playwright/test';

test('opacity-aware tile footprints preserve every FP32 surface fragment against the full-quad oracle', async ({ page }, info) => {
  await page.goto('/e2e/surface-harness.html');
  await page.waitForFunction(() => !!(window as any).surfaceHarness);
  const result = await page.evaluate(async () => {
    const frameUrl = '/src/renderer/webgpu/frame.wgsl?raw', surfaceUrl = '/src/renderer/webgpu/surface.wgsl?raw';
    const [{ default: frame }, { default: surface }] = await Promise.all([import(/* @vite-ignore */ frameUrl), import(/* @vite-ignore */ surfaceUrl)]);
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No WebGPU adapter for the direct surface-bound fixture.');
    const device = await adapter.requestDevice(), errors: string[] = [];
    device.addEventListener('uncapturederror', event => errors.push(event.error.message));
    // Retain the previous full native-quad AABB as an independent candidate
    // oracle. Fragment alpha, top-left coverage and all composition arithmetic
    // remain the actual production shader in both paths.
    const start = surface.indexOf('fn tileFootprint(');
    if (start < 0) throw new Error('Production tile-footprint entry point is missing.');
    let end = surface.indexOf('{', start), depth = 1;
    for (end++; depth !== 0 && end < surface.length; end++) {
      if (surface[end] === '{') depth++; else if (surface[end] === '}') depth--;
    }
    const oracle = surface.slice(0, start) + `fn tileFootprint(rank: u32) -> TileFootprint {
      let empty=TileFootprint(vec2(0u),vec2(0u),0u);
      let gaussian=projected[order[rank].y&0xffffffu];
      if(gaussian.center.w==0.0) { return empty; }
      let center=vec2((gaussian.center.x+1.0)*.5,(1.0-gaussian.center.y)*.5)*vec2<f32>(params.size);
      let extent=abs(gaussian.axes.xy)+abs(gaussian.axes.zw);
      let low=center-extent; let high=center+extent;
      if(any(high<vec2(.5)) || any(low>vec2<f32>(params.size)-vec2(.5))) { return empty; }
      let first=vec2<u32>(max(vec2(0.0),floor(low)))/16u;
      let last=vec2<u32>(min(vec2<f32>(params.size)-vec2(1.0),max(vec2(0.0),floor(high))))/16u;
      return TileFootprint(first,last,1u);
    }` + surface.slice(end);
    const compile = async (source: string) => {
      const module = device.createShaderModule({ code: frame + source });
      return Promise.all(['bin', 'scatter', 'sortTile', 'composite'].map(entryPoint =>
        device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } })));
    };
    const [optimizedPipelines, oraclePipelines] = await Promise.all([compile(surface), compile(oracle)]);
    type Layer = { center: [number, number]; axes: [number, number, number, number]; opacity: number; depth?: number };
    type Fixture = { name: string; width: number; height: number; scale?: number; layers: Layer[]; edges?: boolean; reduction?: boolean };
    const layer = (opacity: number, axes: Layer['axes'] = [28, 28, -28, 28], center: Layer['center'] = [64.5, 48.5]): Layer => ({ center, axes, opacity });
    const adjacent = (value: number, direction: number) => {
      const f = new Float32Array([value]), u = new Uint32Array(f.buffer); u[0] += direction; return f[0];
    };
    const fullWidth = 1025, fullHeight = 769, scale = Math.sqrt(262144 / (fullWidth * fullHeight));
    const width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale);
    const fixtures: Fixture[] = [
      { name: 'rotated opaque ellipse', width: 129, height: 97, layers: [layer(.99)], reduction: true },
      { name: 'faint broad ellipse', width: 129, height: 97, layers: [layer(.0041, [64, 64, -64, 64])], reduction: true },
      { name: 'rotated unequal axes', width: 129, height: 97, layers: [layer(.1, [56, 28, -7, 14])], reduction: true },
      { name: 'offscreen one-pixel partial edge', width: 65, height: 49, layers: [layer(.8, [21, 21, -7, 7], [70, 48.5])] },
      { name: 'exact top-left quad edges', width: 65, height: 49, layers: [layer(1, [3, 0, 0, 3], [32.5, 24.5])], edges: true },
      { name: 'tiny projected axes', width: 65, height: 49, layers: [layer(.9, [.003, 0, 0, .003], [32.5, 24.5])] },
      { name: 'FP32 orthogonality residue', width: 129, height: 97, layers: [layer(.08, [79.13156, 34.98327, -.03498327, .07913156])] },
      { name: 'bounded scalar eigenvalue floor', width, height, scale, layers: [layer(.99, [1536 * scale, 0, 0, .3 * scale], [295.5, 221.5 + .25 * scale])] },
      { name: 'fully offscreen support', width: 65, height: 49, layers: [layer(.0041, [12, 0, 0, 12], [-5, 24.5])], reduction: true },
      { name: 'all rear fragment contributions', width: 65, height: 49, layers: [
        { ...layer(.99, [24, 0, 0, 24], [32.5, 24.5]), depth: 3 },
        { ...layer(.99, [24, 0, 0, 24], [32.5, 24.5]), depth: 3 },
        { ...layer(.99, [24, 0, 0, 24], [32.5, 24.5]), depth: 3 },
        { ...layer(.99, [24, 0, 0, 24], [32.5, 24.5]), depth: 10000 },
      ] },
    ];
    for (const opacity of [1 / 255, .006465509, .0106598221, .0175750755, .0289764008, .0477740084, .0787660238, .1298632188, .2141082512]) {
      for (const direction of [-1, 0, 1]) fixtures.push({ name: `opacity ${opacity} nextafter ${direction}`, width: 129, height: 97,
        layers: [layer(direction === 0 ? Math.fround(opacity) : adjacent(opacity, direction), [42, 14, -7, 21])] });
    }
    const run = async (fixture: Fixture, pipelines: GPUComputePipeline[]) => {
      const { width, height, layers } = fixture, tilesX = Math.ceil(width / 16), tilesY = Math.ceil(height / 16), tiles = tilesX * tilesY;
      const buffers: GPUBuffer[] = [];
      const create = (size: number, usage: GPUBufferUsageFlags, bytes?: Float32Array | Uint32Array) => {
        const buffer = device.createBuffer({ size: Math.max(size, 4), usage }); buffers.push(buffer);
        if (bytes) device.queue.writeBuffer(buffer, 0, bytes); return buffer;
      };
      const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
      const paramsWords = new Uint32Array([width, height, width, height, tilesX, tilesY, 0, layers.length, 1, 1, 0, 0]);
      new Float32Array(paramsWords.buffer)[10] = fixture.scale ?? 1;
      const params = create(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, paramsWords);
      const projected = new Float32Array(layers.length * 12), order = new Uint32Array(layers.length * 2), auxiliary = new Float32Array(layers.length * 4);
      layers.forEach((layer, i) => {
        projected.set([layer.center[0] / width * 2 - 1, 1 - layer.center[1] / height * 2, layer.depth ?? 3, 1,
          ...layer.axes, .5, .5, .5, layer.opacity], i * 12);
        // Reverse ranks mirror the production stable near-to-far traversal.
        order[i * 2 + 1] = layers.length - 1 - i;
        auxiliary.set([.125 + i * .125, .75 - i * .125, .5, 0], i * 4);
      });
      const projectedBuffer = create(projected.byteLength, storage, projected), orderBuffer = create(order.byteLength, storage, order);
      const countBuffer = create(tiles * 4, storage), auxiliaryBuffer = create(auxiliary.byteLength, storage, auxiliary);
      const output = create(width * height * 8, storage), colorOutput = create(width * height * 16, storage);
      const bind = (pipeline: GPUComputePipeline, entries: [number, GPUBuffer][]) => device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
        entries: entries.map(([binding, buffer]) => ({ binding, resource: { buffer } })) });
      const read = async (source: GPUBuffer) => {
        const staging = create(source.size, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
        const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, staging, 0, source.size); device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ); const bytes = staging.getMappedRange().slice(0); staging.unmap(); return bytes;
      };
      try {
        const [bin, scatter, sort, composite] = pipelines;
        const encoder = device.createCommandEncoder(), pass = encoder.beginComputePass();
        pass.setPipeline(bin); pass.setBindGroup(0, bind(bin, [[0, params], [1, projectedBuffer], [2, orderBuffer], [3, countBuffer]]));
        pass.dispatchWorkgroups(Math.ceil(layers.length / 256)); pass.end(); device.queue.submit([encoder.finish()]);
        const counts = new Uint32Array(await read(countBuffer)), spans = new Uint32Array(tiles * 2);
        let entries = 0, maximum = 0;
        counts.forEach((count, i) => {
          const capacity = count === 0 ? 0 : 2 ** Math.ceil(Math.log2(count));
          spans[i * 2] = entries; spans[i * 2 + 1] = capacity; entries += capacity; maximum = Math.max(maximum, count);
        });
        const candidates = create(entries * 4, storage), spanBuffer = create(spans.byteLength, storage, spans);
        device.queue.writeBuffer(countBuffer, 0, new Uint32Array(tiles));
        const work = device.createCommandEncoder(), compute = work.beginComputePass();
        compute.setPipeline(scatter); compute.setBindGroup(0, bind(scatter, [[0, params], [1, projectedBuffer], [2, orderBuffer], [3, countBuffer], [4, candidates], [5, spanBuffer]]));
        compute.dispatchWorkgroups(Math.ceil(layers.length / 256));
        compute.setPipeline(sort); compute.setBindGroup(0, bind(sort, [[0, params], [4, candidates], [5, spanBuffer]])); compute.dispatchWorkgroups(tilesX, tilesY);
        compute.setPipeline(composite); compute.setBindGroup(0, bind(composite, [[0, params], [1, projectedBuffer], [2, orderBuffer], [3, countBuffer],
          [4, candidates], [5, spanBuffer], [6, output], [10, auxiliaryBuffer], [12, colorOutput]])); compute.dispatchWorkgroups(tilesX, tilesY);
        compute.end(); device.queue.submit([work.finish()]);
        const [values, colors] = await Promise.all([read(output), read(colorOutput)]);
        return { entries, maximum, values: new Float32Array(values), colors: new Float32Array(colors) };
      } finally { await device.queue.onSubmittedWorkDone(); for (const buffer of buffers) buffer.destroy(); }
    };
    try {
      const results = [];
      for (const fixture of fixtures) {
        const a = await run(fixture, optimizedPipelines), b = await run(fixture, oraclePipelines);
        let depthOpacityError = 0, colorError = 0;
        a.values.forEach((value, i) => { depthOpacityError = Math.max(depthOpacityError, Math.abs(value - b.values[i])); });
        a.colors.forEach((value, i) => { colorError = Math.max(colorError, Math.abs(value - b.colors[i])); });
        const edgeOpacity = fixture.edges ? [[29, 24], [35, 24], [32, 21], [32, 27]].map(([x, y]) => a.values[(y * fixture.width + x) * 2 + 1]) : undefined;
        results.push({ name: fixture.name, optimizedEntries: a.entries, quadEntries: b.entries, depthOpacityError, colorError, edgeOpacity,
          reduction: fixture.reduction, finite: [...a.values, ...a.colors].every(Number.isFinite), nonempty: a.values.filter((value, i) => i % 2 === 1 && value > 0).length });
      }
      return { results, errors };
    } finally { device.destroy(); }
  });
  await info.attach('surface-bound-production-shader-oracle', { body: JSON.stringify(result), contentType: 'application/json' });
  expect(result.errors).toEqual([]);
  for (const item of result.results) {
    expect(item.depthOpacityError, item.name).toBe(0); expect(item.colorError, item.name).toBe(0); expect(item.finite, item.name).toBe(true);
    expect(item.optimizedEntries, item.name).toBeLessThanOrEqual(item.quadEntries);
    if (item.reduction) expect(item.optimizedEntries, item.name).toBeLessThan(item.quadEntries);
    if (item.edgeOpacity) {
      expect(item.edgeOpacity[0]).toBeGreaterThan(0); expect(item.edgeOpacity[1]).toBe(0);
      expect(item.edgeOpacity[2]).toBeGreaterThan(0); expect(item.edgeOpacity[3]).toBe(0);
    }
  }
  expect(result.results.find(item => item.name === 'offscreen one-pixel partial edge')!.nonempty).toBeGreaterThan(0);
});
