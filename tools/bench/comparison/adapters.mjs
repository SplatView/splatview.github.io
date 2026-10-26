import {SH_C0} from './fixtures.mjs';
import {createSplatRenderSession} from 'frozen-colmapview';

function nativePacked(scene){
  const bytes=new ArrayBuffer(scene.count*48),floats=new Float32Array(bytes),words=new DataView(bytes);
  if(typeof words.setFloat16!=='function')throw new Error('This benchmark packer requires DataView.setFloat16.');
  for(let i=0;i<scene.count;i++){
    const p=scene.positions.subarray(i*3,i*3+3),s=scene.scales.subarray(i*3,i*3+3);
    floats.set([...p,scene.opacity[i],s[0]**2,0,0,s[1]**2,0,s[2]**2],i*12);
    for(let c=0;c<3;c++)words.setFloat16(i*48+40+c*2,(scene.colors[i*3+c]-.5)/SH_C0,true);
  }
  return bytes;
}
export async function createAdapter(variant,canvas,scene){
  if(variant.startsWith('splatview'))return createSplatView(variant,canvas,scene);
  if(variant.startsWith('playcanvas'))return createPlayCanvas(variant,canvas,scene);
  if(variant==='colmapview-webgpu-16')return createColmapView(canvas,scene);
  throw new Error('Unknown benchmark adapter.');
}
async function createSplatView(variant,canvas,data){
  const url='/engine/splatview-renderer.js',sdk=await import(/* @vite-ignore */url),backend=variant.includes('webgl2')?'webgl2':'webgpu',precision=Number(variant.split('-').at(-1));
  const renderer=await sdk.createRenderer(canvas,{preference:backend,allowFallback:false,sortPrecision:precision});
  const ledger=new sdk.ResourceLedger(1024*1024**2),credit=ledger.reserve('render',sdk.estimateSceneBytes(data.count,0));
  renderer.admitWork=bytes=>ledger.reserve('work',bytes);renderer.admitSortScratch=bytes=>ledger.reserve('render',bytes);
  const scene=await renderer.allocateScene(data.count,0);await scene.upload(0,data.count,nativePacked(data));
  const device=backend==='webgpu'?renderer.device:null,gl=backend==='webgl2'?renderer.gl:null,worker=[];
  if(gl){const request=renderer.compute.request.bind(renderer.compute);renderer.compute.request=(...args)=>{
    const start=performance.now(),pending=request(...args);if(args[0].action==='sort')return pending.finally(()=>worker.push({roundTripMs:performance.now()-start}));return pending;
  };}
  if(device)canvas.getContext('webgpu').configure({device,format:renderer.format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  return{device,gl,format:renderer.format,info:{engine:'SplatView standalone',backend,sortPrecision:precision,sourceLayout:'covariance float32 + binary16 SH0',workerSortScope:'round trip including queue/transport'},
    draw(frame){return renderer.render(scene,frame);},async finish(){if(gl)gl.finish();else await renderer.displayCompletion().done;},
    worker,async dispose(){await scene.dispose();await renderer.close();credit();if(ledger.usage.bytes)throw new Error('SplatView comparison retained admission.');return{logicalRetainedBytes:ledger.usage.bytes};}};
}
async function createColmapView(canvas,data){
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});if(!adapter)throw new Error('No WebGPU adapter.');
  const device=await adapter.requestDevice({requiredFeatures:adapter.features.has('timestamp-query')?['timestamp-query']:[]}),format=navigator.gpu.getPreferredCanvasFormat();
  const context=canvas.getContext('webgpu');context.configure({device,format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
  const bytes=new Float32Array(data.count*16);
  for(let i=0;i<data.count;i++){bytes.set([...data.positions.subarray(i*3,i*3+3),data.opacity[i],...data.scales.subarray(i*3,i*3+3),0,1,0,0,0,
    ...data.colors.subarray(i*3,i*3+3).map(c=>(c-.5)/SH_C0),0],i*16);}
  const gaussianBuffer=device.createBuffer({size:bytes.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),shBuffer=device.createBuffer({size:16,usage:GPUBufferUsage.STORAGE});
  device.queue.writeBuffer(gaussianBuffer,0,bytes);
  const session=createSplatRenderSession({device,format,canvasContext:context,width:canvas.width,height:canvas.height,sortAlgorithm:'radix-16bit',outputAlgorithm:'composite',
    scene:{count:data.count,shDegree:0,bounds:data.bounds,gaussianBuffer,shBuffer,release(){}},debugValidation:false});
  return{device,gl:null,format,worker:[],info:{engine:'COLMAPView frozen renderer session',backend:'webgpu',sortPrecision:16,sortAlgorithm:'radix-16bit',rasterAlgorithm:'billboard-ftb',outputAlgorithm:'composite',sourceLayout:'scale/quaternion float32 SH0, 64 bytes/source'},
    draw(frame){session.setCamera({viewport:{pixelWidth:canvas.width,pixelHeight:canvas.height,cssWidth:canvas.width,cssHeight:canvas.height,dpr:1},camera:{kind:'perspective',
      viewMatrix:frame.view,projectionMatrix:frame.glProjection,position:[0,0,0],near:frame.near,far:frame.far}});return session.renderToCanvas({completion:'submitted'});},
    async finish(){await device.queue.onSubmittedWorkDone();},async dispose(){await device.queue.onSubmittedWorkDone();session.dispose();gaussianBuffer.destroy();shBuffer.destroy();device.destroy();context.unconfigure();return{retired:true};}};
}
async function createPlayCanvas(variant,canvas,data){
  const pc=window.pc,backend=variant.endsWith('webgl2')?'webgl2':'webgpu';if(!pc)throw new Error('Pinned PlayCanvas bundle was not loaded.');
  const graphics=await pc.createGraphicsDevice(canvas,{deviceTypes:[backend],antialias:false,powerPreference:'high-performance'});
  const app=new pc.Application(canvas,{graphicsDevice:graphics});app.autoRender=false;app.setCanvasResolution(pc.RESOLUTION_FIXED,canvas.width,canvas.height);
  const camera=new pc.Entity('comparison-camera');camera.addComponent('camera',{clearColor:new pc.Color(0,0,0,1),fov:2*Math.atan(1/1.6)*180/Math.PI,
    nearClip:.1,farClip:100,aspectRatioMode:pc.ASPECT_MANUAL,aspectRatio:canvas.width/canvas.height,gammaCorrection:pc.GAMMA_SRGB,toneMapping:pc.TONEMAP_NONE});app.root.addChild(camera);
  const names=['x','y','z','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3','f_dc_0','f_dc_1','f_dc_2'];
  const values=names.map(()=>new Float32Array(data.count));
  for(let i=0;i<data.count;i++){
    for(let c=0;c<3;c++){values[c][i]=data.positions[i*3+c];values[4+c][i]=data.scales[i*3+c];values[11+c][i]=(data.colors[i*3+c]-.5)/SH_C0;}
    values[3][i]=data.opacity[i];values[7][i]=1;
  }
  const splats=new pc.GSplatData([{name:'vertex',count:data.count,properties:names.map((name,i)=>({name,type:'float',byteSize:4,storage:values[i]}))}]);splats.activated=true;
  const resource=new pc.GSplatResource(graphics,splats),asset=new pc.Asset('comparison-fixture','gsplat');asset.resource=resource;asset.loaded=true;app.assets.add(asset);
  const entity=new pc.Entity('comparison-scene');entity.addComponent('gsplat',{asset,unified:true});app.root.addChild(entity);
  const worker=[];app.scene.on('gsplat:sorted',computeMs=>worker.push({computeMs,receivedMs:performance.now()}));
  // No app animation loop: each benchmark rAF explicitly enters the ordinary
  // Application frame lifecycle, including its unified gsplat manager.
  const device=backend==='webgpu'?graphics.wgpu:null,gl=backend==='webgl2'?graphics.gl:null;
  return{device,gl,format:device?navigator.gpu.getPreferredCanvasFormat():'rgba8unorm',worker,
    info:{engine:'PlayCanvas Engine 2.24.0-beta.10',backend,sortPrecision:'upstream-default',currentRenderer:app.scene.gsplat.currentRenderer,
      sourceLayout:'activated scale/quaternion float32 SH0; upstream texture packing',minPixelSize:app.scene.gsplat.minPixelSize,gammaCorrection:'GAMMA_SRGB',toneMapping:'TONEMAP_NONE',workerSortScope:'upstream worker-reported compute time; async results applied by engine'},
    draw(frame){camera.setLocalEulerAngles(0,-frame.angle*180/Math.PI,0);app.update(1/60);app.render();},
    async finish(){if(gl)gl.finish();else await device.queue.onSubmittedWorkDone();},
    async dispose(){if(device)await device.queue.onSubmittedWorkDone();else gl.finish();app.destroy();return{retired:true};}};
}
