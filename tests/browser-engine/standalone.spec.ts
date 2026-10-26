import { test, expect } from '@playwright/test';

const example = '/nested/renderer/example/';
test('WebGPU close joins scene allocation held in optional compilation',async({page})=>{
  await page.goto(`${example}?backend=webgpu`);await expect(page.locator('#status')).toHaveText('webgpu / sorted / SH0');
  const value=await page.evaluate(async path=>{
    const ex=await(await import(path+'example.js')).ready,r=ex.renderer,device=r.device;
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(yes=>{enter=yes;}),held=new Promise<void>(yes=>{release=yes;});
    const original=device.createComputePipelineAsync.bind(device);
    device.createComputePipelineAsync=(descriptor:GPUComputePipelineDescriptor)=>{
      if(descriptor.label==='Visible order countVisible'){enter();return held.then(()=>original(descriptor));}return original(descriptor);
    };
    const {estimateSceneBytes}=await import(path+'../splatview-renderer.js'),credit=ex.ledger.reserve('render',estimateSceneBytes(262144,0));
    let rejected=false,closed=false;
    const allocation=r.allocateScene(262144,0).then(async(scene: {dispose():Promise<void>})=>{await scene.dispose();},()=>{rejected=true;}).finally(()=>credit());
    await entered;const closing=ex.dispose().then(()=>{closed=true;});
    await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const closedBeforeRelease=closed;
    release();await Promise.all([allocation,closing]);device.createComputePipelineAsync=original;
    return{closedBeforeRelease,rejected,bytes:ex.ledger.usage.bytes};
  },example);
  expect(value).toEqual({closedBeforeRelease:false,rejected:true,bytes:0});
});
for (const backend of ['webgpu', 'webgl2'] as const) for (const degree of [0, 1, 2, 3]) {
  test(`${backend} SH${degree}: independent sorted, Steady, exact queries, capture and retirement`, async ({ page }) => {
    const requests: string[] = [], errors: string[] = [];
    page.on('request', request => requests.push(request.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${example}?backend=${backend}&degree=${degree}`);
    await expect(page.locator('#status')).toHaveText(`${backend} / sorted / SH${degree}`);
    const first = await page.evaluate(async path => {
      const { ready } = await import(path + 'example.js'), ex = await ready;
      const { renderer: r, scene, camera, ledger } = ex;
      const pick = await r.pick(scene, 64, 48), map = await r.surface(scene, { colors: true, visible: true, admit: (bytes: number) => ledger.reserve('work', bytes) });
      const at = 48 * 128 + 64, result = { backend: r.backend, index: pick.index, depth: map.depths[at], opacity: map.opacities[at],
        visible: map.visible[0], color: [...map.colors.subarray(at * 3, at * 3 + 3)] };
      map.dispose();
      const image = await r.captureRgba(scene, camera, { admit: (bytes: number) => ledger.reserve('image', bytes) });
      const capture = [...image.pixels.subarray(at * 4, at * 4 + 4)]; image.dispose();
      await ex.setSteady(true);
      return { ...result, capture, secure: isSecureContext, isolated: crossOriginIsolated };
    }, example);
    expect(first.backend).toBe(backend); expect(first.index).toBe(1);
    expect(first.depth).toBeCloseTo(2, 4); expect(first.opacity).toBeGreaterThan(.7);
    expect(first.visible & 7).toBe(7); expect(first.color[1]).toBeGreaterThan(first.color[0]);
    expect(first.capture[1]).toBeGreaterThan(first.capture[0]); expect(first.capture[3]).toBe(255);
    expect(first.secure).toBe(true); expect(first.isolated).toBe(false);
    await expect.poll(() => page.evaluate(async path => {
      const ex = await (await import(path + 'example.js')).ready; return ex.renderer.steadySnapshot.restFrames;
    }, example)).toBe(16);
    const last = await page.evaluate(async path => {
      const ex = await (await import(path + 'example.js')).ready, { renderer: r, scene, camera, ledger } = ex;
      const pick = await r.pick(scene, 64, 48), image = await r.captureRgba(scene, camera, { admit: (bytes: number) => ledger.reserve('image', bytes) });
      const at = (48 * 128 + 64) * 4, capture = [...image.pixels.subarray(at, at + 4)]; image.dispose();
      const environment = r.negotiationSnapshot;
      await ex.dispose(); await ex.dispose();
      let rejected = false; try { await r.render(scene, camera); } catch { rejected = true; }
      return { index: pick.index, capture, bytes: ledger.usage.bytes, retired: scene.retired, rejected, environment };
    }, example);
    expect(last.index).toBe(first.index); expect(last.capture).toEqual(first.capture);
    expect(last.bytes).toBe(0); expect(last.retired).toBe(true); expect(last.rejected).toBe(true);
    expect(errors).toEqual([]);
    expect(requests.some(url => /compute\.worker-.*\.js$/.test(url))).toBe(backend === 'webgl2');
    expect(requests.every(url => new URL(url).pathname.startsWith('/nested/renderer/'))).toBe(true);
    expect(requests.some(url => /\.wasm|document\.worker|build-provenance|\/src\/|react/i.test(url))).toBe(false);
    await test.info().attach('environment', { body: JSON.stringify({ degree, ...first, ...last, requests }), contentType: 'application/json' });
  });
}

test('automatic WebGPU absence falls back to the standalone WebGL2 executor', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { value: undefined }); });
  await page.goto(example);
  await expect(page.locator('#status')).toHaveText('webgl2 / sorted / SH0');
  expect(await page.evaluate(async path => { const ex = await (await import(path + 'example.js')).ready; await ex.dispose(); return ex.ledger.usage.bytes; }, example)).toBe(0);
});

test('automatic late WebGPU failure replaces its claimed canvas before WebGL2', async ({ page }) => {
  await page.addInitScript(() => {
    GPUCanvasContext.prototype.configure = function () {
      Object.defineProperty(window, '__failedCanvas', { value: this.canvas });
      throw new Error('held presentation failure');
    };
  });
  await page.goto(example);
  await expect(page.locator('#status')).toHaveText('webgl2 / sorted / SH0');
  expect(await page.evaluate(async path => { const ex = await (await import(path + 'example.js')).ready;
    const replaced = ex.renderer.canvas !== (window as unknown as { __failedCanvas: HTMLCanvasElement }).__failedCanvas;
    await ex.dispose(); return replaced; }, example)).toBe(true);
});

test('forced WebGPU rejects unavailable hardware without starting a GL executor', async ({ page }) => {
  const requests: string[] = []; page.on('request', request => requests.push(request.url()));
  await page.addInitScript(() => { Object.defineProperty(navigator, 'gpu', { value: undefined }); });
  await page.goto(`${example}?backend=webgpu`);
  await expect(page.locator('#status')).toContainText('WebGPU');
  expect(requests.some(url => /compute\.worker-/.test(url))).toBe(false);
});

for (const backend of ['webgpu', 'webgl2']) test(`${backend}: host retains frame requests while completion is delayed`, async ({ page }) => {
  await page.goto(`${example}?backend=${backend}`);
  await expect(page.locator('#status')).toHaveText(`${backend} / sorted / SH0`);
  await page.evaluate(async path => {
    const ex = await (await import(path + 'example.js')).ready, original = ex.renderer.displayCompletion.bind(ex.renderer);
    ex.renderer.displayCompletion = () => {
      const checkpoint = original(); return checkpoint && { ...checkpoint,
        done: checkpoint.done.then(() => new Promise(resolve => setTimeout(resolve, 50))) };
    };
    await ex.setSteady(true);
  }, example);
  await expect.poll(() => page.evaluate(async path => {
    const ex = await (await import(path + 'example.js')).ready; return ex.renderer.steadySnapshot.restFrames;
  }, example)).toBe(16);
  expect(await page.evaluate(async path => { const ex = await (await import(path + 'example.js')).ready;
    await ex.dispose(); return ex.ledger.usage.bytes; }, example)).toBe(0);
});
