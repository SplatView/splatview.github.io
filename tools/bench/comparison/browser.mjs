import {fixture,generateScene,cameraFrame,motionAngle,imageError} from './fixtures.mjs';
import {createAdapter} from './adapters.mjs';
import {installGpuClock} from './gpu-clock.mjs';
import {snapshot} from './snapshots.mjs';

// Constructor/upload timing starts after all engine modules have loaded.
const engineUrl='/engine/splatview-renderer.js';await import(/* @vite-ignore */engineUrl);

const raf=()=>new Promise(requestAnimationFrame);
async function measure({variant,fixtureId,probe=false,frames=60,quality=false}){
  const options=probe?{id:'probe',count:4,width:320,height:200,scale:.12,probe:true}:fixture(fixtureId);
  const data=generateScene(options),canvas=document.createElement('canvas');canvas.width=options.width;canvas.height=options.height;document.body.replaceChildren(canvas);
  const errors=[],lost=[],gpu=navigator.gpu,requestAdapter=gpu?.requestAdapter.bind(gpu);
  // Enable only the measurement capability on each engine's own device. The
  // engine still selects its ordinary sort/render features and owns submission.
  if(gpu)gpu.requestAdapter=async descriptor=>{
    const adapter=await requestAdapter(descriptor);if(!adapter)return null;const request=adapter.requestDevice.bind(adapter);
    adapter.requestDevice=d=>request({...d,requiredFeatures:[...new Set([...(d?.requiredFeatures??[]),...(adapter.features.has('timestamp-query')?['timestamp-query']:[])])]});return adapter;
  };
  let adapter,clock;const start=performance.now(),samples=[],images=[];
  try{
    try{adapter=await createAdapter(variant,canvas,data);}finally{if(gpu)gpu.requestAdapter=requestAdapter;}
    const startupMs=performance.now()-start;
    if(adapter.device){adapter.device.addEventListener('uncapturederror',event=>errors.push(event.error.message));void adapter.device.lost.then(info=>{if(info.reason!=='destroyed')lost.push(info.message);});clock=installGpuClock(adapter.device);}
    const draw=async(angle,phase,index,capture=false)=>{
      await raf();const frame=cameraFrame(canvas.width,canvas.height,angle);frame.revision=index;
      clock?.setFrame({phase,index});const t=performance.now(),pending=adapter.draw(frame);if(pending)await pending;const submitted=performance.now();
      // Read the current display texture before awaiting its fence; presentation
      // can replace the canvas texture after the browser resumes another task.
      const pixels=capture?snapshot(canvas,adapter.device,adapter.format):null;
      await adapter.finish();const completed=performance.now();
      if(pixels)images.push({phase,index,angle,...await pixels});
      return{phase,index,angle,startedMs:t,submissionMs:submitted-t,completionMs:completed-t};
    };
    for(let i=0;i<12;i++)await draw(0,'warm',i);
    if(probe){await draw(0,'probe',0,true);}
    else{
      for(let i=0;i<frames;i++)samples.push(await draw(motionAngle(i),'motion',i));
      for(let i=0;i<frames;i++)samples.push(await draw(.15,'fixed',i));
      if(quality)for(const [index,angle] of [-.2,0,.2].entries()){
        await draw(angle,'motion-image',index,true);
        for(let warm=0;warm<4;warm++)await draw(angle,'settle-image',warm);
        await draw(angle,'fixed-image',index,true);
      }
    }
    const gpuTime=clock?await clock.finish():{available:false,reason:'No common whole-pipeline GPU timestamp API for WebGL2.'};
    const environment={userAgent:navigator.userAgent,secureContext:isSecureContext,crossOriginIsolated,devicePixelRatio,
      adapter:adapter.device?[...adapter.device.features]:null,gl:adapter.gl?{vendor:adapter.gl.getParameter(adapter.gl.VENDOR),renderer:adapter.gl.getParameter(adapter.gl.RENDERER)}:null};
    const worker=[...adapter.worker],info=adapter.info;clock?.dispose();clock=null;
    const retirement=await adapter.dispose();adapter=null;
    return{schemaVersion:1,variant,fixture:options,startupMs,samples,images,gpuTime,worker,info,environment,retirement,errors,lost,
      scope:'Explicit render-core camera trace at rAF opportunities; CPU submission and actual queue completion. GL uses gl.finish consistently for both engines. Physical presentation FPS unavailable. PlayCanvas GL retains its asynchronous default sorting.'};
  }finally{if(gpu)gpu.requestAdapter=requestAdapter;clock?.dispose();await adapter?.dispose();canvas.remove();}
}
function compare(actual,reference){
  const bytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0));return imageError(bytes(actual),bytes(reference));
}
window.rendererComparison={measure,compare};
