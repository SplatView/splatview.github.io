import { GaussianRenderer, type GpuScene } from '../src/renderer/webgpu/renderer';
import { DEFAULT_STEADY_SETTINGS, type SteadySettings } from '../src/renderer/steadySettings';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { CameraController } from '../src/input/camera';
import { ResourceLedger } from '../src/document/resources';
import { compositedSurface } from '../src/renderer/webgpu/surface';

async function pixels(source: HTMLCanvasElement | Blob) {
  const bitmap=await createImageBitmap(source);
  try {
    const canvas=new OffscreenCanvas(bitmap.width,bitmap.height), context=canvas.getContext('2d')!;
    context.drawImage(bitmap,0,0); return Array.from(context.getImageData(0,0,bitmap.width,bitmap.height).data);
  } finally { bitmap.close(); }
}
const mse=(a: number[],b: number[]) => a.reduce((sum,v,i) => sum+(i%4===3?0:(v-b[i])**2),0)/(a.length/4*3);
async function createHarness() {
  const canvas=document.querySelector<HTMLCanvasElement>('#scene')!, renderer=await GaussianRenderer.create(canvas);
  const context=canvas.getContext('webgpu')!;
  context.configure({device:renderer.device,format:renderer.format,alphaMode:'opaque',
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
  const errors: string[]=[]; renderer.onLost=message => errors.push(message);
  const ledger=new ResourceLedger(256*1024**2);
  renderer.admitSteady=bytes => ledger.reserve('render',bytes);
  let requested=0; renderer.onFrameNeeded=() => requested++;
  const camera={ view: new Float32Array(IDENTITY_MATRIX),
    projection: new Float32Array([49/65,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]),
    eye: new Float32Array(3),revision: 0,background: 'black' } as unknown as CameraController;
  let scene: GpuScene;
  let lastPixels: number[]=[];
  const draw=async (highlight=false,grade=NEUTRAL_COLOR,geometry=IDENTITY_MATRIX,opacity=1,snapshot=false) => {
    renderer.render(scene,camera,grade,highlight,geometry,false,false,opacity,false);
    if(snapshot) {
      // Copy in the submitting task: a presented WebGPU canvas may be cleared
      // before createImageBitmap(canvas) runs after an asynchronous queue fence.
      const stride=Math.ceil(canvas.width*4/256)*256;
      const readback=renderer.device.createBuffer({size:stride*canvas.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try {
        const encoder=renderer.device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture:context.getCurrentTexture()},{buffer:readback,bytesPerRow:stride},[canvas.width,canvas.height]);
        renderer.device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
        const data=new Uint8Array(readback.getMappedRange()); lastPixels=[];
        for(let y=0;y<canvas.height;y++) for(let x=0;x<canvas.width;x++) {
          const i=y*stride+x*4;
          lastPixels.push(...(renderer.format==='bgra8unorm'?[data[i+2],data[i+1],data[i],data[i+3]]:data.subarray(i,i+4)));
        }
        readback.unmap();
      } finally { readback.destroy(); }
    }
    await renderer.device.queue.onSubmittedWorkDone();
  };
  const until=async (predicate: () => boolean) => {
    const deadline=performance.now()+10000;
    while (!predicate()) {
      if (performance.now()>deadline) throw new Error(`SteadySplats did not settle: ${JSON.stringify(renderer.steadySnapshot)}`);
      await new Promise(requestAnimationFrame);
    }
  };
  async function fixture(reverse=false,transparent=false) {
    const records=[[-2,.5,0x3c00,0xbc00],[-3,.65,0xbc00,0x3c00]];
    if (reverse) records.reverse();
    const data=new ArrayBuffer(records.length*48), floats=new Float32Array(data), view=new DataView(data);
    records.forEach(([z,alpha,red,blue],i) => {
      floats.set([0,0,z,transparent?0:alpha,.16,0,0,.16,0,.16],i*12);
      view.setUint16(i*48+40,red,true); view.setUint16(i*48+44,blue,true);
    });
    scene=await renderer.allocateScene(records.length,0); await scene.upload(0,records.length,data);
    scene.masks(new Uint8Array(records.length).buffer); await draw();
  }
  async function enable(patch: Partial<SteadySettings>={}) {
    renderer.setRenderSettings({ ...DEFAULT_STEADY_SETTINGS,mode:'steady',...patch }); await draw();
    await until(() => renderer.steadySnapshot.status!=='preparing');
    if (renderer.steadySnapshot.status!=='steady') throw new Error(renderer.steadySnapshot.reason ?? 'SteadySplats unavailable.');
  }
  return {
    environment: { secureContext: isSecureContext,crossOriginIsolated,userAgent: navigator.userAgent,negotiation: renderer.negotiationSnapshot },
    async quality(reverse: boolean,white: boolean) {
      await fixture(reverse); camera.background=white?'white':'black'; await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true);
      const sorted=lastPixels, pick=await renderer.pick(scene,32,24);
      await enable({ convergenceFrames: 256 });
      scene.sortDirty=true; await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true);
      const skipsSort=scene.sortDirty, first=lastPixels;
      for (let i=0;i<256;i++) await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,i===255);
      const refined=lastPixels, converged=renderer.steadySnapshot;
      const frameRequests=requested; await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true);
      const retained=lastPixels, noMoreRequests=requested===frameRequests;
      const lazyPick=await renderer.pick(scene,32,24), lazySort=!scene.sortDirty;
      const captured=await pixels(await renderer.capture(scene,camera)); await draw();
      return { firstError:mse(first,sorted),refinedError:mse(refined,sorted),retainedError:mse(retained,refined),captureError:mse(captured,sorted),
        skipsSort,lazySort,pick,lazyPick,converged,afterCapture:renderer.steadySnapshot,noMoreRequests,errors };
    },
    async dependencies() {
      await fixture(); await enable(); await draw(); for(let i=0;i<16;i++) await draw();
      const changes: {kind:string;restFrames:number}[]=[];
      const record=async (kind: string,highlight=false,grade=NEUTRAL_COLOR,geometry=IDENTITY_MATRIX,opacity=1) => {
        await draw(highlight,grade,geometry,opacity); changes.push({kind,restFrames:renderer.steadySnapshot.restFrames}); await draw(highlight,grade,geometry,opacity);
      };
      camera.view[12]=.01; camera.eye[0]=-.01; camera.revision++; await record('motion');
      camera.background='white'; await record('background');
      const grade=[...NEUTRAL_COLOR]; grade[0]=1.2; await record('grade',false,grade);
      scene.masks(new Uint8Array([1,0]).buffer); await record('mask',true,grade);
      const geometry=[...IDENTITY_MATRIX]; geometry[12]=.1; await record('transform',true,grade,geometry);
      await record('opacity',true,grade,geometry,.5);
      const surface=await compositedSurface(renderer,scene,{ colors:true,visible:true,admit:bytes=>ledger.reserve('work',bytes) });
      const surfaceFinite=Array.from(surface.depths).every(Number.isFinite); surface.dispose();
      return {changes,surfaceFinite,errors};
    },
    async lifecycle() {
      await fixture(); await enable(); await draw();
      const initial=renderer.steadySnapshot.allocationBytes;
      canvas.width=81; canvas.height=63; await draw();
      await until(() => renderer.steadySnapshot.status==='steady'); await draw();
      await until(() => renderer.steadySnapshot.allocationBytes===81*63*136+65536+240);
      const resized=renderer.steadySnapshot.allocationBytes;
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await draw(); await until(() => ledger.usage.bytes===0);
      let attempts=0; renderer.admitSteady=() => { attempts++; throw new Error('Injected admission refusal'); };
      renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady'}); await draw();
      await until(() => renderer.steadySnapshot.status==='unavailable');
      for(let i=0;i<3;i++) await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,i===2);
      const refused=renderer.steadySnapshot, fallback=lastPixels, captured=await pixels(await renderer.capture(scene,camera));
      renderer.admitSteady=bytes => ledger.reserve('render',bytes);
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await enable(); await draw();
      const restored=renderer.steadySnapshot.status;
      renderer.dispose(); await until(() => ledger.usage.bytes===0);
      return {initial,resized,attempts,refused,fallbackError:mse(fallback,captured),restored,released:ledger.usage,errors};
    },
    async unsupportedAndEmpty() {
      await fixture(false,true); camera.background='white'; await enable(); await draw();
      for(let i=0;i<16;i++) await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,i===15);
      const empty=lastPixels;
      camera.projection[2]=.1; await draw(); const unsupported=renderer.steadySnapshot;
      await until(() => ledger.usage.bytes===0);
      camera.projection[2]=0; await draw(); await until(() => renderer.steadySnapshot.status==='steady'); await draw();
      return {emptyWhite:empty.every(v=>v===255),unsupported,restored:renderer.steadySnapshot.status,errors};
    },
    async pendingPublication(dispose: boolean) {
      await fixture();
      const pop=renderer.device.popErrorScope.bind(renderer.device);
      let release!: () => void,held=false;
      const wait=new Promise<void>(resolve => { release=resolve; });
      renderer.device.popErrorScope=() => {
        const result=pop();
        if(held) return result;
        held=true; return wait.then(() => result);
      };
      renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady'}); await draw();
      const preparing=renderer.steadySnapshot.status,admitted=ledger.usage.bytes;
      if(dispose) renderer.dispose(); else renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS);
      const heldUntilRetirement=ledger.usage.bytes===admitted;
      renderer.device.popErrorScope=pop; release(); await until(() => ledger.usage.bytes===0);
      return {preparing,admitted,heldUntilRetirement,final:renderer.steadySnapshot,errors};
    },
    async spatialControls() {
      await fixture(); await enable({historyWeight:0}); const before=requested;
      await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true); const first=lastPixels;
      await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true); const animatedError=mse(first,lastPixels);
      const zeroWeight={...renderer.steadySnapshot,requests:requested-before};
      renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady',animate:false});
      await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true); const fixed=lastPixels;
      await draw(false,NEUTRAL_COLOR,IDENTITY_MATRIX,1,true);
      return {animatedError,fixedError:mse(fixed,lastPixels),zeroWeight,fixed:renderer.steadySnapshot,errors};
    },
    async loss() {
      await fixture(); await enable(); await draw(); let losses=0;
      renderer.onDeviceLost=() => losses++;
      const admitted=ledger.usage.bytes; renderer.device.destroy();
      await until(() => renderer.lost && ledger.usage.bytes===0);
      return {admitted,losses,released:renderer.steadySnapshot.allocationBytes,errors};
    },
  };
}
declare global { interface Window { steadyHarness: Awaited<ReturnType<typeof createHarness>>; steadyHarnessError?: string } }
void createHarness().then(value => {window.steadyHarness=value;}).catch(error => {window.steadyHarnessError=String(error);});
