import { GaussianRenderer, type GpuScene } from '../src/renderer/webgpu/renderer';
import { ResourceLedger, packedStride, estimateSceneBytes } from '../src/document/resources';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { RenderCamera } from '../src/renderer/frame';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import { initializeRuntime } from '../src/build/runtime';
import type { GlScene } from '../src/renderer/webgl2/scene';

async function measure(degree = 0, precision: 16 | 24 | 32 = 32, visibility = .25, refuse = false, staged = false) {
  const ledger = new ResourceLedger(256 * 1024 ** 2), errors: string[] = [];
  const create = async (fast: boolean) => {
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 96; document.body.append(canvas);
    const r = await GaussianRenderer.create(canvas);
    r.onLost = error => errors.push(error); r.admitWork = bytes => ledger.reserve('work', bytes);
    if (fast) r.admitSortScratch = bytes => { if (refuse) throw new Error('Refused optional fast order.'); return ledger.reserve('render', bytes); };
    canvas.getContext('webgpu')!.configure({ device: r.device, format: r.format, alphaMode: 'opaque',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    return r;
  };
  const baseline = await create(false), fast = await create(true), count = 262145;
  const credits = [ledger.reserve('render', estimateSceneBytes(count, degree)), ledger.reserve('render', estimateSceneBytes(count, degree))];
  let a: GpuScene | undefined, b: GpuScene | undefined;
  const camera: RenderCamera = { view: new Float32Array(IDENTITY_MATRIX), eye: new Float32Array(3), revision: 0, background: 'black',
    projection: new Float32Array([.75,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]) };
  const geometry=staged?[...IDENTITY_MATRIX]:undefined;if(geometry)geometry[14]=-.15;
  const read = async (r: GaussianRenderer, source: GPUBuffer, bytes: number) => {
    const credit = ledger.reserve('work', bytes), target = r.device.createBuffer({ size: bytes, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try { const encoder = r.device.createCommandEncoder(); encoder.copyBufferToBuffer(source, 0, target, 0, bytes); r.device.queue.submit([encoder.finish()]);
      await target.mapAsync(GPUMapMode.READ); return target.getMappedRange().slice(0);
    } finally { target.unmap(); target.destroy(); credit(); }
  };
  const display = async (r: GaussianRenderer, scene: GpuScene, grade = NEUTRAL_COLOR, highlight = true) => {
    r.render(scene, camera, grade, highlight,geometry,false,true,staged?.5:1,staged);
    const credit = ledger.reserve('image', 128 * 96 * 4), output = r.device.createBuffer({ size: 128 * 96 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try { const encoder = r.device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: r.canvas.getContext('webgpu')!.getCurrentTexture() }, { buffer: output, bytesPerRow: 512 }, [128, 96]);
      r.device.queue.submit([encoder.finish()]); await output.mapAsync(GPUMapMode.READ); return new Uint8Array(output.getMappedRange().slice(0));
    } finally { output.unmap(); output.destroy(); credit(); }
  };
  try {
    a = await baseline.allocateScene(count, degree); b = await fast.allocateScene(count, degree);
    const stride = packedStride(degree), bytes = new ArrayBuffer(count * stride), f = new Float32Array(bytes), half = new DataView(bytes), masks = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const offscreen = i / count >= visibility;
      f.set([offscreen ? 100 : ((i % 32) - 16) * .04, ((Math.floor(i / 32) % 32) - 16) * .04, -2 - (i % 7) * .00003, .25, .0009, 0, 0, .0009, 0, .0009], i * stride / 4);
      for (let j = 0; j < 3 * (degree + 1) ** 2; j++) half.setUint16(i * stride + 40 + j * 2, j < 3 ? (j === i % 3 ? 0x3c00 : 0) : ((i + j) % 2 ? 0x2800 : 0xa800), true);
      masks[i] = visibility!==1&&i%17===0 ? 2 : i%11===0 ? 1 : 0;
    }
    await a.upload(0, count, bytes.slice(0)); await b.upload(0, count, bytes); a.masks(masks.slice().buffer); b.masks(masks.buffer);
    if(staged) {
      for(const [r,s] of [[baseline,a],[fast,b]] as const) {
        // Reserve both candidate and retirement storage before staging. The
        // scene owns published buffers; the fixture destroys retired sources.
        credits.push(ledger.reserve('render',count*32));
        const states=Uint8Array.from({length:count},(_,i)=>i%19===0?2:i%3===0?1:0);
        const transform=Uint8Array.from({length:count},(_,i)=>i%5===0?1:0),opacity=Uint8Array.from({length:count},(_,i)=>i%7===0?1:0);
        const updates=[await s.stageMasks(states.buffer,{transformBase:transform.buffer,opacityBase:opacity.buffer})];
        for(const update of updates){update.publish();await r.finish();for(const buffer of update.retirementBuffers??[])buffer.destroy();}
        // Clear and rebind a preview independently of canonical selection.
        for(const payload of [null,transform.buffer]) {
          const update=await s.stagePreviewMasks(payload,'transformBase');update.publish();await r.finish();
          for(const buffer of update.retirementBuffers)buffer.destroy();
        }
      }
    }
    fast.displaySortPrecision = precision;
    const expectedPixels = await display(baseline, a), pixels = await display(fast, b);
    const projected = new Float32Array(await read(fast, b.buffers.projected, count * 48));
    const visible = (id: number) => projected[id * 12 + 3] !== 0;
    const full = new Uint32Array(await read(baseline, a.ordered, count * 8));
    const compactBuffer = (b.fastOrder as unknown as { buffers: GPUBuffer[] } | undefined)?.buffers.find(buffer => buffer.label === 'Fast depth compactA');
    const actual = new Uint32Array(await read(fast, compactBuffer ?? b.ordered, count * 8));
    const entries = Array.from({ length: count }, (_, i) => ({ key: full[i * 2], id: full[i * 2 + 1] & 0xffffff })).filter(entry => visible(entry.id));
    const expectedOrder = precision < 32 && b.fastOrder ? entries.sort((x, y) => (x.key >>> (32-precision)) - (y.key >>> (32-precision)) || x.id - y.id) : entries;
    const args = b.fastOrder ? new Uint32Array(await read(fast, b.fastOrder.indirect, 20)) : undefined;
    const actualIds = Array.from({ length: b.fastOrder ? args![1] : count }, (_, i) => actual[i * 2 + 1] & 0xffffff).filter(visible);
    let square = 0, absolute = 0, max = 0, samples = 0;
    for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) { const error = Math.abs(pixels[i] - expectedPixels[i]) / 255; square += error * error; absolute += error; max = Math.max(max, error); samples++; }
    const quality = { psnr: square === 0 ? 999 : -10 * Math.log10(square / samples), meanAbsoluteRgb: absolute / samples, maxRgb: max };
    const pickA = await baseline.pick(a, 64, 48), pickB = await fast.pick(b, 64, 48);
    const captureA = await baseline.captureRgba(a, camera, { admit: bytes => ledger.reserve('image', bytes) },NEUTRAL_COLOR,geometry,false,true,staged?.5:1,staged);
    const captureB = await fast.captureRgba(b, camera, { admit: bytes => ledger.reserve('image', bytes) },NEUTRAL_COLOR,geometry,false,true,staged?.5:1,staged);
    const captureEqual = captureA.pixels.every((value, i) => value === captureB.pixels[i]); captureA.dispose(); captureB.dispose();
    let interleaved=false;
    const maps = await Promise.all([[baseline, a], [fast, b]].map(async ([r, s],index) => (r as GaussianRenderer).surface(s as GpuScene, { colors: true, visible: true, admit: bytes => {
      const lease=ledger.reserve('work',bytes),resize=lease.resize.bind(lease);
      lease.resize=next=>{
        const growing=next>lease.bytes;resize(next);
        if(index===1&&growing&&!interleaved&&b!.fastOrder) {
          interleaved=true;b!.residentCompactOrder=undefined;fast.displaySortPrecision=16;
          fast.render(b,camera,NEUTRAL_COLOR,true,geometry,false,true,staged?.5:1,staged);
        }
      };
      return lease;
    } })));
    const mapEqual = maps[0].depths.every((value, i) => value === maps[1].depths[i]) && maps[0].opacities.every((value, i) => value === maps[1].opacities[i]) && maps[0].colors!.every((value,i)=>value===maps[1].colors![i]);
    const visibleEqual = maps[0].visible!.every((value, i) => value === maps[1].visible![i]); for (const map of maps) map.dispose();
    // Grade/tint cannot change visibility/order. The projection cache may still refresh color.
    let sorts = 0; const encode = b.fastOrder?.encode.bind(b.fastOrder);
    if (encode) b.fastOrder!.encode = (...args: Parameters<typeof encode>) => { sorts++; return encode(...args); };
    await display(fast, b, [...NEUTRAL_COLOR]); const before = sorts;
    const grade = [...NEUTRAL_COLOR]; grade[0] = 1.2; await display(fast, b, grade, false); const colorSorts = sorts - before;
    const result = { degree, precision, visibility, fast: !!b.fastOrder, indirectCount: args?.[1], projectedVisible: entries.length,
      baseMirrorBytesEqual:a.allocationBytes===b.allocationBytes,
      expectedOrder: expectedOrder.map(entry => entry.id), actualOrder: actualIds, quality, pickA, pickB, captureEqual, mapEqual, visibleEqual, interleaved, colorSorts, errors };
    await a.dispose(); a = undefined; await b.dispose(); b = undefined; credits.forEach(release => release());
    await baseline.close(); await fast.close(); return { ...result, memory: ledger.usage };
  } finally {
    await a?.dispose(); await b?.dispose(); await baseline.close(); await fast.close(); credits.forEach(release => release()); baseline.canvas.remove(); fast.canvas.remove();
  }
}
async function workerQuality(precision:16|24=24) {
  await initializeRuntime(import.meta.url);
  const ledger=new ResourceLedger(64*1024**2), count=4096, canvases=[document.createElement('canvas'),document.createElement('canvas')];
  for(const canvas of canvases) {canvas.width=64;canvas.height=48;document.body.append(canvas);}
  const renderers=await Promise.all(canvases.map(canvas=>GlRenderer.create(canvas,createVerifiedRenderCompute)));
  const credits=renderers.map(()=>ledger.reserve('render',4*1024**2)),scenes:GlScene[]=[];
  const camera:RenderCamera={view:new Float32Array(IDENTITY_MATRIX),eye:new Float32Array(3),revision:0,background:'black',
    projection:new Float32Array([.75,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0])};
  try {
    for(const r of renderers) {
      r.admitWork=bytes=>ledger.reserve('work',bytes);r.admitSortScratch=bytes=>ledger.reserve('render',bytes);
      const scene=await r.allocateScene(count,0),bytes=new ArrayBuffer(count*48),f=new Float32Array(bytes),half=new DataView(bytes);
      for(let i=0;i<count;i++) {f.set([((i%32)-16)*.04,((Math.floor(i/32)%32)-16)*.04,-2-(i%7)*.00003,.25,.0009,0,0,.0009,0,.0009],i*12);half.setUint16(i*48+40+(i%3)*2,0x3c00,true);}
      await scene.upload(0,count,bytes); scenes.push(scene);
    }
    renderers[1].displaySortPrecision=precision;
    for(let i=0;i<2;i++) await renderers[i].render(scenes[i],camera);
    const before=scenes[1].residentSortPrecision;
    const picks=await Promise.all(renderers.map((r,i)=>r.pick(scenes[i],32,24)));
    const images=await Promise.all(renderers.map((r,i)=>r.captureRgba(scenes[i],camera,{admit:bytes=>ledger.reserve('image',bytes)})));
    const captureEqual=images[0].pixels.every((value,i)=>value===images[1].pixels[i]);images.forEach(image=>image.dispose());
    const after=scenes[1].residentSortPrecision;
    const maps=await Promise.all(renderers.map((r,i)=>r.surface(scenes[i],{colors:true,visible:true,admit:bytes=>ledger.reserve('work',bytes)})));
    const mapEqual=maps[0].depths.every((value,i)=>value===maps[1].depths[i])&&maps[0].opacities.every((value,i)=>value===maps[1].opacities[i]);maps.forEach(map=>map.dispose());
    // Repeated odd-pass sorts must not detach either retained radix array.
    for(let i=0;i<4;i++) {camera.view[14]=Math.fround(.001*(i+1));await renderers[1].render(scenes[1],camera);}
    const scratch=renderers[1].compute.sortScratchSnapshot;
    for(const scene of scenes) await scene.dispose(); credits.forEach(release=>release());
    await Promise.all(renderers.map(r=>r.close()));
    return{precision,before,after,picks,captureEqual,mapEqual,scratch,memory:ledger.usage};
  } finally {for(const scene of scenes) await scene.dispose();await Promise.all(renderers.map(r=>r.close()));credits.forEach(release=>release());canvases.forEach(canvas=>canvas.remove());}
}
const harness = { measure, workerQuality };
declare global { interface Window { fastOrder: typeof harness } }
window.fastOrder = harness;
