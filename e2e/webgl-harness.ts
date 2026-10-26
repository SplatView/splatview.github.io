import { createVerifiedRenderCompute } from '../src/app/renderCompute';
import { GlRenderer } from '../src/renderer/webgl2/renderer';
import { GaussianRenderer } from '../src/renderer/webgpu/renderer';
import type { CameraController } from '../src/input/camera';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { packedStride, ResourceLedger } from '../src/document/resources';
import type { SceneRenderer, GaussianScene,RenderScene } from '../src/renderer/contracts';
import { DEFAULT_STEADY_SETTINGS,type SteadySettings } from '../src/renderer/steadySettings';
import { scriptedFifo,gpuFifoPacking } from './webgl-fifo';
import { createSceneRenderer } from '../src/renderer/factory';

function camera():CameraController { return {view:new Float32Array(IDENTITY_MATRIX),
  projection:new Float32Array([49/65,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]),
  eye:new Float32Array(3),revision:0,background:'black'} as unknown as CameraController; }
function source(degree:number,reverse=false) {
  const stride=packedStride(degree),buffer=new ArrayBuffer(stride*3),floats=new Float32Array(buffer),view=new DataView(buffer);
  const rows=[[-.28,.24,-2,.5,0x3c00,0xbc00],[.1,-.1,-3,.65,0xbc00,0x3c00],[.5,.2,-2.5,.4,0x3800,0xb800]];
  if(reverse) rows.reverse();
  rows.forEach(([x,y,z,alpha,red,blue],i) => {
    floats.set([x,y,z,alpha,.11,.025,0,.16,0,.12],i*stride/4);
    view.setUint16(i*stride+40,red,true); view.setUint16(i*stride+44,blue,true);
    for(let j=3;j<3*(degree+1)**2;j++) view.setUint16(i*stride+40+j*2,j%2?0x3000:0xb000,true);
  }); return buffer;
}
async function fixture(renderer:SceneRenderer,degree=0,reverse=false) {
  const scene=await renderer.allocateScene(3,degree); await scene.upload(0,3,source(degree,reverse)); scene.masks(new Uint8Array([1,0,0]).buffer); return scene;
}
async function raw(renderer:SceneRenderer,scene:RenderScene,view:CameraController,grade=NEUTRAL_COLOR,geometry=IDENTITY_MATRIX,opacity=1) {
  const image=await renderer.captureRgba(scene,view,{admit:()=>()=>undefined},grade,geometry,false,false,opacity);
  try { return Array.from(image.pixels); } finally { image.dispose(); }
}
async function createHarness() {
  const canvas=document.querySelector<HTMLCanvasElement>('#scene')!,renderer=await GlRenderer.create(canvas, createVerifiedRenderCompute),ledger=new ResourceLedger(256*1024**2),errors:string[]=[];
  renderer.admitWork=bytes=>ledger.reserve('work',bytes); renderer.admitGeometryDepth=bytes=>ledger.reserve('render',bytes); renderer.onLost=message=>errors.push(message);
  renderer.admitSteady=bytes=>ledger.reserve('render',bytes);
  let frameRequests=0,sortRequests=0; renderer.onFrameNeeded=()=>frameRequests++;
  const request=renderer.compute.request.bind(renderer.compute);
  renderer.compute.request=(...args:Parameters<typeof request>) => { if(args[0].action==='sort') sortRequests++; return request(...args); };
  const until=async(predicate:()=>boolean) => {
    const deadline=performance.now()+10000;
    while(!predicate()) { if(performance.now()>deadline) throw new Error(`WebGL2 did not settle: ${JSON.stringify(renderer.steadySnapshot)}`); await new Promise(requestAnimationFrame); }
  };
  const displayPixels=() => {
    const {gl}=renderer,data=new Uint8Array(canvas.width*canvas.height*4); gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,data);
    const result:number[]=[]; for(let y=canvas.height-1;y>=0;y--) result.push(...data.subarray(y*canvas.width*4,(y+1)*canvas.width*4)); return result;
  };
  const mse=(a:number[],b:number[])=>a.reduce((sum,value,i)=>sum+(i%4===3?0:(value-b[i])**2),0)/(a.length/4*3);
  const enable=async(scene:GaussianScene,view:CameraController,patch:Partial<SteadySettings>={}) => {
    renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady',...patch}); await renderer.render(scene,view);
    await until(()=>renderer.steadySnapshot.status!=='preparing');
    if(renderer.steadySnapshot.status!=='steady') throw new Error(renderer.steadySnapshot.reason??'SteadySplats unavailable.');
  };
  return {
    environment:{secureContext:isSecureContext,crossOriginIsolated,userAgent:navigator.userAgent,capabilities:renderer.capabilities,negotiation:renderer.negotiationSnapshot},
    scriptedFifo:async()=>({...scriptedFifo(renderer.gl),gpuPacked:await gpuFifoPacking()}),
    async baseline(degree:number,reverse:boolean) {
      const view=camera(),scene=await fixture(renderer,degree,reverse);
      const gpuCanvas=document.createElement('canvas'); gpuCanvas.width=65; gpuCanvas.height=49;
      const gpu=await GaussianRenderer.create(gpuCanvas),gpuScene=await fixture(gpu,degree,reverse);
      try {
        const sorted=await raw(renderer,scene,view),reference=await raw(gpu,gpuScene,view);
        const grade=[...NEUTRAL_COLOR]; grade[0]=1.25; grade[2]=.85; grade[14]=17;
        const geometry=[...IDENTITY_MATRIX]; geometry[12]=.12; geometry[5]=.9;
        const graded=await raw(renderer,scene,view,grade,geometry,.6),gradedReference=await raw(gpu,gpuScene,view,grade,geometry,.6);
        await renderer.render(scene,view); const sequence=renderer.frameSubmissionSequence;
        const captured=await raw(renderer,scene,view); await renderer.finish();
        const metric=(a:number[],b:number[]) => ({max:Math.max(...a.map((v,i)=>Math.abs(v-b[i]))),mse:a.reduce((sum,v,i)=>sum+(v-b[i])**2,0)/a.length});
        return {sorted:metric(sorted,reference),graded:metric(graded,gradedReference),captureStable:metric(captured,sorted),sequence,afterCapture:renderer.frameSubmissionSequence,
          top:sorted.slice((15*65+27)*4,(15*65+27)*4+4),bottom:sorted.slice((34*65+27)*4,(34*65+27)*4+4),errors,glError:renderer.gl.getError()};
      } finally { await scene.dispose(); await gpuScene.dispose(); gpu.dispose(); }
    },
    async contextOnly() {
      const scene=await fixture(renderer),view=camera(); await renderer.render(scene,view); const image=await raw(renderer,scene,view); await scene.dispose(); await renderer.finish();
      return {backend:renderer.backend,nonzero:image.some((v,i)=>i%4!==3 && v>0),sequence:renderer.frameSubmissionSequence,errors,credits:ledger.usage.bytes};
    },
    async geometry(kind:1|2) {
      const view=camera();view.projection.set(IDENTITY_MATRIX);
      const gpuCanvas=document.createElement('canvas');gpuCanvas.width=65;gpuCanvas.height=49;const gpu=await GaussianRenderer.create(gpuCanvas);
      const descriptor={layoutVersion:1 as const,kind,vertexCount:3,triangleCount:kind===2?1:0,vertexStride:16 as const,indexStride:4 as const,vertexBytes:48,indexBytes:kind===2?12:0,revision:1,contentRevision:1};
      const records=[[-.6,-.5,.4,255,0,0],[.65,-.4,.5,0,255,0],[.1,.6,.6,0,0,255]],bytes=new ArrayBuffer(48),data=new DataView(bytes);
      records.forEach((record,i)=>{for(let j=0;j<3;j++) data.setFloat32(i*16+j*4,record[j],true);for(let j=0;j<3;j++) data.setUint8(i*16+12+j,record[j+3]);data.setUint8(i*16+15,255);});
      const scene=await renderer.allocateGeometry(descriptor),reference=await gpu.allocateGeometry(descriptor);
      try {
        await scene.uploadVertices(0,3,bytes.slice(0));await reference.uploadVertices(0,3,bytes.slice(0));
        if(kind===2) {await scene.uploadIndices(0,3,new Uint32Array([0,1,2]).buffer);await reference.uploadIndices(0,3,new Uint32Array([0,1,2]).buffer);}
        const captured=await raw(renderer,scene,view),expected=await raw(gpu,reference,view);
        let max=0;for(let i=0;i<captured.length;i++) max=Math.max(max,Math.abs(captured[i]-expected[i]));
        await renderer.render(scene,view);const shown=displayPixels();await scene.dispose();await renderer.finish();
        return {max,displayError:mse(shown,captured),foreground:captured.some((value,i)=>i%4!==3 && value>0),errors,glError:renderer.gl.getError(),credits:ledger.usage.bytes};
      } finally {await scene.dispose();await reference.dispose();gpu.dispose();}
    },
    async navigation() {
      const scene=await fixture(renderer),view=camera(),pending:Promise<void>[]=[];
      for(let i=0;i<20;i++) { view.view[12]=i*.001; view.revision++; pending.push(renderer.render(scene,view)); await new Promise(requestAnimationFrame); }
      await Promise.all(pending); const sequence=renderer.frameSubmissionSequence; await scene.dispose(); await renderer.finish(); return {sequence,errors,credits:ledger.usage.bytes};
    },
    async steadyQuality(white:boolean,reverse:boolean) {
      const scene=await fixture(renderer,0,reverse),view=camera(); view.background=white?'white':'black';
      const sorted=await raw(renderer,scene,view); await enable(scene,view,{convergenceFrames:256});
      const beforeSort=sortRequests; await renderer.render(scene,view,NEUTRAL_COLOR,false); const first=displayPixels();
      for(let i=0;i<256;i++) await renderer.render(scene,view,NEUTRAL_COLOR,false);
      const refined=displayPixels(),settled=renderer.steadySnapshot,requests=frameRequests;
      await renderer.render(scene,view,NEUTRAL_COLOR,false); const cached=displayPixels(),cachedState=renderer.steadySnapshot;
      const noIdleRequests=requests===frameRequests,sorts=sortRequests-beforeSort;
      const capture=await raw(renderer,scene,view),afterCapture=renderer.steadySnapshot;
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await renderer.finish(); await scene.dispose();
      return {firstError:mse(first,sorted),refinedError:mse(refined,sorted),cachedError:mse(cached,refined),captureError:mse(capture,sorted),settled,cachedState,afterCapture,
        noIdleRequests,sorts,glError:renderer.gl.getError(),errors,credits:ledger.usage.bytes};
    },
    async steadyState() {
      const scene=await fixture(renderer),view=camera(); await enable(scene,view); const trace=[];
      for(let i=0;i<19;i++) { await renderer.render(scene,view); trace.push({...renderer.steadySnapshot,requests:frameRequests,sequence:renderer.frameSubmissionSequence}); }
      const settled=renderer.steadySnapshot;
      view.view[12]=.03; view.eye[0]=-.03; view.revision++; await renderer.render(scene,view); const motion=renderer.steadySnapshot;
      await renderer.render(scene,view); const stopped=renderer.steadySnapshot;
      scene.masks(new Uint8Array([0,1,0]).buffer); await renderer.render(scene,view); const masks=renderer.steadySnapshot;
      const controls=[];
      for(const patch of [{historyWeight:0},{animate:false},{convergence:false}]) {
        renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady',...patch}); const requests=frameRequests;
        await renderer.render(scene,view); await renderer.render(scene,view); controls.push({patch,state:renderer.steadySnapshot,requests:frameRequests-requests});
      }
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await renderer.finish(); await scene.dispose();
      return {trace,settled,motion,stopped,masks,controls,glError:renderer.gl.getError(),errors,credits:ledger.usage.bytes};
    },
    async steadyLifecycle() {
      const scene=await fixture(renderer),view=camera(); await enable(scene,view); await renderer.render(scene,view); const initial=renderer.steadySnapshot;
      canvas.width=81; canvas.height=63; await renderer.render(scene,view); await until(()=>renderer.steadySnapshot.status==='steady'); await renderer.render(scene,view); const resized=renderer.steadySnapshot;
      view.projection[2]=.1; await renderer.render(scene,view); const unsupported=renderer.steadySnapshot; await renderer.finish();
      view.projection[2]=0; await enable(scene,view); await renderer.render(scene,view); const restored=renderer.steadySnapshot;
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await renderer.finish(); let attempts=0; renderer.admitSteady=()=>{attempts++;throw new Error('Injected admission refusal');};
      renderer.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady'}); await renderer.render(scene,view); await until(()=>renderer.steadySnapshot.status==='unavailable');
      for(let i=0;i<3;i++) await renderer.render(scene,view,NEUTRAL_COLOR,false); const failed=renderer.steadySnapshot,display=displayPixels(),captured=await raw(renderer,scene,view);
      renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS); await renderer.finish(); await scene.dispose();
      return {initial,resized,unsupported,restored,failed,attempts,fallbackError:mse(display,captured),glError:renderer.gl.getError(),errors,credits:ledger.usage.bytes};
    },
    async queryParity(degree:number,downsampled:boolean,scoped:boolean) {
      canvas.width=downsampled?769:65; canvas.height=downsampled?513:49;
      const view=camera(); view.projection[0]=canvas.height/canvas.width;
      const scene=await fixture(renderer,degree),gpuCanvas=document.createElement('canvas'); gpuCanvas.width=canvas.width; gpuCanvas.height=canvas.height;
      const gpu=await GaussianRenderer.create(gpuCanvas),gpuScene=await fixture(gpu,degree);
      const geometry=[...IDENTITY_MATRIX]; geometry[12]=scoped?.08:0; geometry[4]=scoped?.12:0;
      if(scoped) {
        for(const value of [scene,gpuScene]) {
          const masks=await value.stageMasks(new Uint8Array([0,1,0]).buffer,{transformBase:new Uint8Array([1,0,0]).buffer,opacityBase:new Uint8Array([0,1,0]).buffer});
          await value.renderer.finish(); masks.publish(); await value.renderer.finish(); for(const old of masks.retirementBuffers??[]) old.destroy(); await masks.dispose();
        }
      }
      const options={colors:true,visible:true,admit:(bytes:number)=>ledger.reserve('work',bytes)};
      try {
        await renderer.render(scene,view,NEUTRAL_COLOR,false,geometry,false,scoped,scoped?.6:1,scoped);
        gpu.render(gpuScene,view,NEUTRAL_COLOR,false,geometry,false,scoped,scoped?.6:1,scoped);
        const map=await renderer.surface(scene,options),reference=await gpu.surface(gpuScene,options);
        const difference=(a:Float32Array,b:Float32Array)=>{let max=0,different=0;for(let i=0;i<a.length;i++){max=Math.max(max,Math.abs(a[i]-b[i]));if((a[i]===0)!==(b[i]===0))different++;}return {max,different};};
        const picks=[];
        if(!scoped) for(const radius of [0,8]) for(const [x,y] of [[canvas.width*.5,canvas.height*.5],[canvas.width*.46,canvas.height*.4],[1,1]]) {
          picks.push({gl:await renderer.pick(scene,x,y,radius),gpu:await gpu.pick(gpuScene,x,y,radius)});
        }
        const result={depths:difference(map.depths,reference.depths),opacities:difference(map.opacities,reference.opacities),colors:difference(map.colors!,reference.colors!),
          visible:Array.from(map.visible!),referenceVisible:Array.from(reference.visible!),dimensions:[map.width,map.height],picks,errors,glError:renderer.gl.getError()};
        map.dispose(); reference.dispose(); return result;
      } finally { await scene.dispose(); await gpuScene.dispose(); gpu.dispose(); }
    },
    async queryOwnership() {
      const scene=await fixture(renderer),view=camera(); await renderer.render(scene,view);
      const map=await renderer.surface(scene,{colors:true,visible:true,admit:bytes=>ledger.reserve('work',bytes)});
      const grade=[...NEUTRAL_COLOR]; grade[0]=1.2; await renderer.render(scene,view,grade,false); map.assertCurrent();
      const gradeRetained=true; scene.masks(new Uint8Array([0,1,0]).buffer); await renderer.render(scene,view,grade,false); map.assertCurrent();
      const selectionRetained=true;
      const abort=new AbortController(),pending=renderer.surface(scene,{colors:true,signal:abort.signal,admit:bytes=>ledger.reserve('work',bytes)}); abort.abort();
      const cancelled=await pending.then(()=>false,error=>error.name==='AbortError');
      scene.masks(new Uint8Array([2,1,0]).buffer); await renderer.render(scene,view); const sourceRejected=(()=>{try{map.assertCurrent();return false;}catch{return true;}})(); map.dispose();
      const refused=await renderer.surface(scene,{admit:()=>{throw new Error('Injected refusal');}}).then(()=>false,()=>true).catch(()=>true);
      await scene.dispose(); await renderer.finish(); return {gradeRetained,selectionRetained,sourceRejected,cancelled,refused,credits:ledger.usage.bytes,errors};
    },
    async histogram() {
      const scene=await fixture(renderer),view=camera(); let latest:import('../src/renderer/histogram').RenderedHistogram|undefined,unavailable=0;
      renderer.onHistogram=value=>{latest=value;}; renderer.onHistogramUnavailable=()=>unavailable++;
      renderer.setHistogramEnabled(true); await renderer.render(scene,view); const displayed=displayPixels(),expected=new Uint32Array(768);
      for(let i=0;i<displayed.length;i+=4) { expected[displayed[i]]++;expected[256+displayed[i+1]]++;expected[512+displayed[i+2]]++; }
      await until(()=>!!latest);const exact=Array.from(latest!.bins).every((value,i)=>value===expected[i]);
      await enable(scene,view);await renderer.render(scene,view); const first=latest?.frame;
      await new Promise(resolve=>setTimeout(resolve,210));await renderer.render(scene,view);await until(()=>latest?.frame!==first);
      const steadyFrame=latest!.frame,after=renderer.steadySnapshot;
      renderer.setHistogramEnabled(false);renderer.setRenderSettings(DEFAULT_STEADY_SETTINGS);await renderer.finish();await scene.dispose();
      return {exact,unavailable,steadyFrame,after,credits:ledger.usage.bytes,errors,glError:renderer.gl.getError()};
    },
    async factoryFailure(stage:'adapter'|'presentation'|'float'|'mrt') {
      const initial=document.createElement('canvas');initial.width=65;initial.height=49;document.body.append(initial);
      const gpu=navigator.gpu,adapterRequest=gpu.requestAdapter.bind(gpu),configure=GPUCanvasContext.prototype.configure;
      const extension=WebGL2RenderingContext.prototype.getExtension,parameter=WebGL2RenderingContext.prototype.getParameter;
      const claimed=stage==='presentation'?initial.getContext('webgpu'):undefined;
      let replacements=0,fallback:string|undefined,created:SceneRenderer|undefined;
      try {
        if(stage==='adapter') gpu.requestAdapter=async()=>null;
        if(stage==='presentation') GPUCanvasContext.prototype.configure=function(descriptor:GPUCanvasConfiguration){if(this===claimed)throw new Error('Injected presentation failure');return configure.call(this,descriptor);};
        if(stage==='float') WebGL2RenderingContext.prototype.getExtension=function(name:string){return name==='EXT_color_buffer_float'?null:Reflect.apply(extension,this,[name]);};
        if(stage==='mrt') WebGL2RenderingContext.prototype.getParameter=function(name:number){return name===this.MAX_DRAW_BUFFERS?3:parameter.call(this,name);};
        created=await createSceneRenderer(initial,{createCompute:createVerifiedRenderCompute,preference:stage==='float'||stage==='mrt'?'webgl2':'auto',allowFallback:true,
          fallback:reason=>{fallback=reason;},replaceCanvas:async previous=>{replacements++;const next=document.createElement('canvas');next.width=previous.width;next.height=previous.height;previous.replaceWith(next);return next;}});
        const scene=await fixture(created),view=camera();created.setRenderSettings({...DEFAULT_STEADY_SETTINGS,mode:'steady'});
        await created.render(scene,view);
        const sortedWhilePreparing=created.frameSubmissionSequence>0,deadline=performance.now()+10000;
        while(created.steadySnapshot.status==='preparing') {
          if(performance.now()>deadline) throw new Error('Optional Steady preparation did not settle.');
          await new Promise(requestAnimationFrame);
        }
        await created.render(scene,view);
        const captured=await raw(created,scene,view);const result={backend:created.backend,replacements,fallback,sortedWhilePreparing,status:created.steadySnapshot,foreground:captured.some((value,i)=>i%4!==3&&value>0)};
        await scene.dispose();return result;
      } finally {
        gpu.requestAdapter=adapterRequest;GPUCanvasContext.prototype.configure=configure;WebGL2RenderingContext.prototype.getExtension=extension;WebGL2RenderingContext.prototype.getParameter=parameter;
        const used=created?.canvas;created?.dispose();used?.remove();initial.remove();
      }
    },
  };
}
declare global { interface Window {webglHarness:Awaited<ReturnType<typeof createHarness>>;webglHarnessError?:string} }
createHarness().then(value=>{window.webglHarness=value;},error=>{window.webglHarnessError=error instanceof Error?error.message:String(error);});
