import type { ImageOperation } from '../../io/image';
import { captureDepthOrderKey,depthOrderMatches } from '../orderKey';
import { validateSortPrecision, type SortPrecision } from '../sortPrecision';
import gaussianSource from './gaussian.glsl?raw';
import splatVertex from './splat.vert.glsl?raw';
import sortedFragment from './sorted.frag.glsl?raw';
import geometryVertex from './geometry.vert.glsl?raw';
import geometryFragment from './geometry.frag.glsl?raw';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../defaults';
import { checkedBytes } from '../../document/resources';
import type { GeometryDescriptor } from '../geometryLayout';
import { backgroundShade } from '../../input/background';
import { encodeRgba, ownRgbaImage, rgbaImageBytes, type OwnedRgbaImage } from '../../io/image';

import { nextRendererEpoch,recordCanvasBackend } from '../backend';
import { StaleRenderQueryError, type GaussianScene, type RenderScene, type SceneRenderer } from '../contracts';
import { encodeGaussianFrame, type RenderCamera } from '../frame';
import type { RenderedHistogram } from '../histogram';
import type { SteadySettings, SteadyStatus } from '../steadySettings';
import { supportsSteadyProjection } from '../steadyState';
import { encodeSurfaceParameters,resolveSurfaceRegion,surfaceChannelFlags,surfaceDimensions,type SurfaceMap,type SurfaceOptions } from '../webgpu/surfaceQuery';
import type { RendererNegotiationObserver, RendererNegotiationSnapshot } from '../webgpu/diagnostics';
import { observeWebglCapabilities, WEBGL_CONTEXT_ATTRIBUTES, type WebglCapabilities } from './capabilities';
import type { RenderComputeClient } from './computeClient';
import { glNegotiation } from './diagnostics';
import { preparePrograms } from './programPreparation';
import { uniformLocation,uniformBlock,samplerUniform, depth32, finishGl, framebuffer, requireGlAllocation, texture2d } from './gl';
import { GlGeometryScene } from './geometry';
import { GlScene, type GlMaskSnapshot } from './scene';
import { GlSteadySplats } from './steady';
import { GlHistogramSampler } from './histogram';

type GlRenderScene=GlScene|GlGeometryScene;
export type GlFrame=Readonly<{scene:GlRenderScene;revision:number;camera:RenderCamera;values?:Float32Array<ArrayBuffer>;
  words?:Uint32Array<ArrayBuffer>;masks?:GlMaskSnapshot;width:number;height:number;shade:number}>;
type DepthTarget={width:number;height:number;color:WebGLTexture;depth?:WebGLRenderbuffer;target:WebGLFramebuffer;release?:()=>void};

/** One submission/query owner. Async preparation always publishes a captured frame. */
export class GlRenderer implements SceneRenderer {
  readonly backend='webgl2' as const;
  readonly deviceEpoch=nextRendererEpoch();
  readonly compute:RenderComputeClient;
  readonly negotiationSnapshot:RendererNegotiationSnapshot;
  private readonly sorted:WebGLProgram;
  private readonly geometry:WebGLProgram;
  private readonly frameBuffer:WebGLBuffer;
  private readonly emptyVao:WebGLVertexArrayObject;
  private readonly geometryVao:WebGLVertexArrayObject;
  private readonly quadIndices:WebGLBuffer;
  private displayCheckpoint?:import('../contracts').DisplayCompletion;
  private readonly queries=new Set<Promise<unknown>>();
  private readonly queryCancellations=new Map<AbortController,(next:GlFrame|undefined)=>boolean>();
  private tail:Promise<unknown>=Promise.resolve();
  private readonly retiring=new Set<Promise<void>>();
  private displayRequest=0;
  private submission=0;
  private disposed=false;
  private prepared?:GlFrame;
  private queryRevision=0;
  private opacityRevision=0;
  private preparedOpacityRevision=-1;
  private depthTarget?:DepthTarget;
  private readonly steady:GlSteadySplats;
  private readonly histogram:GlHistogramSampler;
  private histogramDisplay?:{frame:GlFrame;steadyFrame:number;identity:object};
  private opacityScale=1;
  private opacitySelectedOnly=false;
  lost=false;
  /** Persistent worker sort scratch; separate from active-job work credits. */
  admitSortScratch?: (bytes:number)=>()=>void;
  admitWork?: (bytes:number)=>()=>void;
  admitGeometryDepth?: (bytes:number)=>()=>void;
  admitHistogram?: (bytes:number)=>()=>void;
  admitSteady?: (bytes:number)=>()=>void;
  onHistogram?: (result:RenderedHistogram,scene:RenderScene)=>void;
  onHistogramUnavailable?: ()=>void;
  onRenderStatus?: (status:SteadyStatus)=>void;
  onFrameNeeded?: ()=>void;
  onLost?: (message:string)=>void;
  onDeviceLost?: (message:string)=>void;
  private readonly contextLost=(event:Event) => {
    event.preventDefault(); if(this.disposed || this.lost) return; this.lost=true;
    this.compute.close('The graphics context was lost.');
    this.onDeviceLost?.('The WebGL2 context was lost. Your edits are retained.');
  };

  private constructor(readonly canvas:HTMLCanvasElement,readonly gl:WebGL2RenderingContext,readonly capabilities:WebglCapabilities,
    startedAt:number,compute:RenderComputeClient,readyPrograms:WebGLProgram[]) {
    const programs:WebGLProgram[]=[],buffers:WebGLBuffer[]=[],vaos:WebGLVertexArrayObject[]=[];
    try {
      this.sorted=readyPrograms[0]; programs.push(this.sorted);
      this.geometry=readyPrograms[1]; programs.push(this.geometry);
      const frame=gl.createBuffer(); if(!frame) throw new Error('The graphics frame could not be allocated.'); buffers.push(frame); this.frameBuffer=frame;
      gl.bindBuffer(gl.UNIFORM_BUFFER,frame); gl.bufferData(gl.UNIFORM_BUFFER,320,gl.DYNAMIC_DRAW);
      uniformBlock(gl,this.sorted,'GaussianFrame',0);
      const vao=() => { const value=gl.createVertexArray(); if(!value) throw new Error('The graphics vertex state could not be allocated.'); vaos.push(value); return value; };
      this.emptyVao=vao(); this.geometryVao=vao();
      const indices=gl.createBuffer(); if(!indices) throw new Error('The quad indices could not be allocated.'); buffers.push(indices); this.quadIndices=indices;
      gl.bindVertexArray(this.emptyVao); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array([0,1,2,2,1,3]),gl.STATIC_DRAW);
      requireGlAllocation(gl,'The graphics programs');
      this.compute=compute;
    } catch(error) { for(const value of programs) gl.deleteProgram(value); for(const value of buffers) gl.deleteBuffer(value); for(const value of vaos) gl.deleteVertexArray(value); throw error; }
    this.negotiationSnapshot=glNegotiation(startedAt,capabilities);
    this.steady=new GlSteadySplats(this);
    this.histogram=new GlHistogramSampler(this);
    this.compute.onFailure=message => { if(!this.disposed && !this.lost) { this.lost=true; this.onLost?.(message); } };
    canvas.addEventListener('webglcontextlost',this.contextLost);
  }
  static async create(canvas:HTMLCanvasElement,createCompute:()=>Promise<RenderComputeClient>,observer?:RendererNegotiationObserver) {
    const started=performance.now(), gl=canvas.getContext('webgl2',WEBGL_CONTEXT_ATTRIBUTES);
    if(!gl) throw new Error('WebGL2 is unavailable on this canvas.');
    recordCanvasBackend(canvas,'webgl2');
    const capabilities=observeWebglCapabilities(gl),compute=await createCompute();
    let renderer:GlRenderer;
    try {
      const programs=await preparePrograms(gl,[
        {vertex:'#version 300 es\n'+gaussianSource+splatVertex,fragment:'#version 300 es\n'+sortedFragment},
        {vertex:'#version 300 es\n'+geometryVertex,fragment:'#version 300 es\n'+geometryFragment}]);
      renderer=new GlRenderer(canvas,gl,capabilities,started,compute,programs);
    } catch(error) { compute.close(); throw error; }
    try { await renderer.compute.barrier(); renderer.requireScene(); observer?.(renderer.negotiationSnapshot); return renderer; }
    catch(error) { renderer.dispose(); throw error; }
  }
  get frameSubmissionSequence() { return this.submission; }
  get steadySnapshot() { return this.steady.snapshot; }
  requireScene(scene?:RenderScene):asserts scene is GlRenderScene|undefined {
    if(this.disposed || this.lost || this.gl.isContextLost()) throw new StaleRenderQueryError('The graphics device is unavailable. Your edits are retained.');
    if(scene && (scene.renderer!==this || scene.deviceEpoch!==this.deviceEpoch || scene.retired || !(scene instanceof GlScene || scene instanceof GlGeometryScene)))
      throw new StaleRenderQueryError('The scene belongs to a retired graphics owner.');
  }
  run<T>(action:()=>Promise<T>|T):Promise<T> {
    const task=this.tail.then(action); this.tail=task.catch(()=>undefined); return task;
  }
  fence() { return finishGl(this.gl); }
  retireAfterFence(release:()=>void) {
    const task=this.fence().catch(()=>undefined).finally(() => { release(); this.retiring.delete(task); }); this.retiring.add(task); return task;
  }
  trackRetirement(task:Promise<void>) {
    this.retiring.add(task); void task.finally(()=>this.retiring.delete(task)).catch(()=>undefined); return task;
  }
  displayCompletion() { return this.displayCheckpoint; }
  private runQuery<T>(action:()=>Promise<T>):Promise<T> {
    const task=action(); this.queries.add(task); void task.finally(()=>this.queries.delete(task)).catch(()=>undefined); return task;
  }
  async finish() {
    await this.tail; await Promise.allSettled([...this.queries]);
    if(!this.disposed && !this.lost) await this.compute.barrier();
    await this.fence(); await Promise.allSettled([...this.retiring]);
  }
  allocateScene(count:number,degree:number) { return GlScene.create(this,count,Math.min(degree,3)); }
  async allocateGeometry(descriptor:GeometryDescriptor) {
    this.requireScene(); try { return new GlGeometryScene(this,descriptor); }
    catch(error) { await this.fence().catch(()=>undefined); throw error; }
  }
  prepareSurfaceResources() { return this.compute.barrier(); }
  trimSurfaceResources() { void this.compute.trimSortScratch().catch(()=>undefined); }
  setOpacityPreview(scale:number,selectedOnly:boolean) {
    if(!Number.isFinite(scale) || scale<0 || scale>5) throw new RangeError('Opacity scale must be between 0 and 5.');
    scale=Math.fround(scale); selectedOnly=scale!==1 && selectedOnly;
    if(scale!==this.opacityScale || selectedOnly!==this.opacitySelectedOnly) { this.opacityScale=scale; this.opacitySelectedOnly=selectedOnly; this.opacityRevision++; }
  }
  setRenderSettings(settings:SteadySettings) { this.steady.configure(settings); }
  resetRenderHistory() { this.steady.resetHistory(); this.onFrameNeeded?.(); }
  setHistogramEnabled(enabled:boolean) { this.histogram.setEnabled(enabled); }
  resetHistogram() { this.histogramDisplay=undefined; this.histogram.reset(); }
  private dimensions(width:number,height:number) {
    rgbaImageBytes(width,height);
    if(width>this.capabilities.maxTextureSize || height>this.capabilities.maxTextureSize || width>this.capabilities.maxViewport[0] || height>this.capabilities.maxViewport[1])
      throw new RangeError('The viewport exceeds the graphics device limit.');
    if(this.gl.drawingBufferWidth!==width || this.gl.drawingBufferHeight!==height) throw new Error('The graphics drawing buffer did not preserve the requested viewport.');
  }
  private frame(scene:GlRenderScene,camera:RenderCamera,grade:number[],highlight:boolean,geometry:number[],selectedOnly:boolean,
    geometrySelectedOnly:boolean,opacityScale:number,opacitySelectedOnly:boolean):GlFrame {
    const width=this.canvas.width,height=this.canvas.height; this.dimensions(width,height);
    const captured:RenderCamera={view:new Float32Array(camera.view),projection:new Float32Array(camera.projection),eye:new Float32Array(camera.eye),revision:camera.revision,background:camera.background};
    const encoded=scene.kind==='gaussian'?encodeGaussianFrame(scene,captured,grade,highlight,geometry,selectedOnly,width,height,geometrySelectedOnly,opacityScale,opacitySelectedOnly):undefined;
    return Object.freeze({scene,revision:scene.revision,camera:captured,width,height,shade:backgroundShade(captured.background),
      values:encoded?.values,words:encoded?.words,masks:scene.kind==='gaussian'?scene.snapshotMasks():undefined});
  }
  private current(frame:GlFrame,viewport=false) {
    this.requireScene(frame.scene);
    if(frame.scene.revision!==frame.revision || viewport && (this.canvas.width!==frame.width || this.canvas.height!==frame.height))
      throw new StaleRenderQueryError('The captured scene or viewport changed.');
  }
  private sortPrecision:SortPrecision=32;
  get displaySortPrecision() { return this.sortPrecision??32; }
  set displaySortPrecision(value:SortPrecision) {const next=validateSortPrecision(value);if(this.displaySortPrecision!==next){this.sortPrecision=next;this.onFrameNeeded?.();}}
  async sortedOrder(frame:GlFrame,signal?:AbortSignal,precision:SortPrecision=this.displaySortPrecision) {
    const scene=frame.scene; if(scene.kind!=='gaussian') return;
    if(scene.count<2048) precision=32;
    this.current(frame);
    if((scene.residentSortPrecision??32)>=precision && depthOrderMatches(scene.residentOrder,frame.words!,scene.sourceRevision,frame.masks!.transform)) return;
    const key=captureDepthOrderKey(frame.words!,scene.sourceRevision,frame.masks!.transform);
    let pin=await this.compute.acquireSortScratch(scene.count,this.admitSortScratch??this.admitWork);
    let release:(()=>void)|undefined;
    try {
      this.current(frame);
      try { release=this.admitWork?.(checkedBytes(scene.count,pin?5:17)+320+(pin?0:1024)); }
      catch(error) {
        if(!pin) throw error;
        pin(); pin=undefined; await this.compute.trimSortScratch(); this.current(frame);
        release=this.admitWork?.(checkedBytes(scene.count,17)+320+1024);
      }
      const words=frame.values!.slice().buffer, targets=frame.masks!.transform.slice().buffer;
      const response=await this.compute.request({action:'sort',scene:scene.id,frame:words,transformTargets:targets,precision},[words,targets],signal);
      this.current(frame); scene.uploadOrder(new Uint32Array(response.order!)); scene.residentOrder=key; scene.residentSortPrecision=precision;
    } finally { pin?.(); if(release) this.retireAfterFence(release); }
  }
  bindSplat(program:WebGLProgram,frame:GlFrame,ordered:boolean) {
    const scene=frame.scene; if(scene.kind!=='gaussian') throw new Error('Expected Gaussian frame.');
    const {gl}=this; gl.useProgram(program); gl.bindVertexArray(this.emptyVao);
    gl.bindBuffer(gl.UNIFORM_BUFFER,this.frameBuffer); gl.bufferSubData(gl.UNIFORM_BUFFER,0,frame.values!); gl.bindBufferBase(gl.UNIFORM_BUFFER,0,this.frameBuffer);
    uniformBlock(gl,program,'GaussianFrame',0);
    [[scene.words,'wordsTexture'],[frame.masks!.texture,'statesTexture'],[scene.order,'orderTexture']].forEach(([texture,name],i) => {
      gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D,texture as WebGLTexture); samplerUniform(gl,program,name as string,i);
    });
    gl.uniform1i(uniformLocation(gl,program,'useOrder'),Number(ordered)); gl.uniform1i(uniformLocation(gl,program,'stochasticDepth'),0);
  }
  bindFullscreen() { this.gl.bindVertexArray(this.emptyVao); }
  private drawSorted(frame:GlFrame,target:WebGLFramebuffer|null) {
    const {gl}=this; gl.bindFramebuffer(gl.FRAMEBUFFER,target); gl.viewport(0,0,frame.width,frame.height);
    gl.disable(gl.SCISSOR_TEST); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.colorMask(true,true,true,true); gl.clearColor(frame.shade,frame.shade,frame.shade,1); gl.clear(gl.COLOR_BUFFER_BIT);
    this.bindSplat(this.sorted,frame,true); gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElementsInstanced(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0,frame.scene.count); gl.disable(gl.BLEND); requireGlAllocation(gl,'The sorted display submission');
  }
  private drawGeometry(frame:GlFrame,target:WebGLFramebuffer) {
    const scene=frame.scene; if(scene.kind!=='geometry') throw new Error('Expected geometry frame.');
    const {gl}=this,program=this.geometry,mesh=scene.descriptor.kind===2;
    gl.bindFramebuffer(gl.FRAMEBUFFER,target); gl.viewport(0,0,frame.width,frame.height); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.BLEND); gl.disable(gl.CULL_FACE);
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LESS); gl.depthMask(true); gl.clearColor(frame.shade,frame.shade,frame.shade,1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program); gl.bindVertexArray(this.geometryVao); gl.bindBuffer(gl.ARRAY_BUFFER,scene.vertices);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,16,0); gl.vertexAttribDivisor(0,mesh?0:1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,4,gl.UNSIGNED_BYTE,true,16,12); gl.vertexAttribDivisor(1,mesh?0:1);
    gl.uniformMatrix4fv(uniformLocation(gl,program,'geometryView'),false,frame.camera.view); gl.uniformMatrix4fv(uniformLocation(gl,program,'geometryProjection'),false,frame.camera.projection);
    gl.uniform3f(uniformLocation(gl,program,'geometryViewport'),frame.width,frame.height,Math.max(1.3,Math.min(3,Math.min(frame.width,frame.height)/160)));
    gl.uniform1i(uniformLocation(gl,program,'mesh'),Number(mesh));
    if(mesh) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,scene.indices!); gl.drawElements(gl.TRIANGLES,scene.descriptor.triangleCount*3,gl.UNSIGNED_INT,0); }
    else gl.drawArraysInstanced(gl.TRIANGLES,0,6,scene.count);
    gl.bindVertexArray(this.emptyVao); gl.disable(gl.DEPTH_TEST); requireGlAllocation(gl,'The PLY display submission');
  }
  private createTarget(width:number,height:number,release?:()=>void,needsDepth=true):DepthTarget {
    const {gl}=this; let color:WebGLTexture|undefined,depth:WebGLRenderbuffer|undefined,target:WebGLFramebuffer|undefined;
    try { color=texture2d(gl,width,height,gl.RGBA8); if(needsDepth) depth=depth32(gl,width,height); target=framebuffer(gl,[color],depth); return {width,height,color,depth,target,release}; }
    catch(error) { if(target) gl.deleteFramebuffer(target); if(depth) gl.deleteRenderbuffer(depth); if(color) gl.deleteTexture(color); if(release) this.retireAfterFence(release); throw error; }
  }
  private retireTarget(target:DepthTarget) {
    return this.retireAfterFence(() => { this.gl.deleteFramebuffer(target.target); this.gl.deleteTexture(target.color); if(target.depth) this.gl.deleteRenderbuffer(target.depth); target.release?.(); });
  }
  releaseGeometryScene(scene:GlGeometryScene) {
    if(this.prepared?.scene===scene) this.prepared=undefined;
    if(this.prepared?.scene.kind!=='geometry' && this.depthTarget) {
      const old=this.depthTarget; this.depthTarget=undefined; return this.retireTarget(old);
    }
    return Promise.resolve();
  }
  render(scene:RenderScene|undefined,camera:RenderCamera,grade=NEUTRAL_COLOR,highlight=true,geometry=IDENTITY_MATRIX,
    selectedOnly=false,geometrySelectedOnly=selectedOnly,opacityScale=1,opacitySelectedOnly=false):Promise<void> {
    this.requireScene(scene); const request=++this.displayRequest;
    const frame=scene?this.frame(scene,camera,grade,highlight,geometry,selectedOnly,geometrySelectedOnly,opacityScale,opacitySelectedOnly):undefined;
    const width=this.canvas.width,height=this.canvas.height,shade=backgroundShade(camera.background);
    for(const [cancel,current] of this.queryCancellations) if(!current(frame)) cancel.abort();
    return this.run(async () => {
      if(request!==this.displayRequest || this.disposed || this.lost) return;
      this.requireScene();
      if(frame) {
        try { this.current(frame,true); } catch(error) { if(error instanceof StaleRenderQueryError) return; throw error; }
        if(frame.scene.kind==='gaussian') {
          if(this.depthTarget) { const old=this.depthTarget; this.depthTarget=undefined; this.retireTarget(old); }
          const supported=supportsSteadyProjection(frame.camera.projection);
          if(!supported) this.steady.suspend('SteadySplats requires a supported perspective projection.');
          const steady=supported && this.steady.ready(width,height);
          if(steady) {
            this.setOpacityPreview(opacityScale,opacitySelectedOnly);
            if(this.steady.encode(frame)) this.onFrameNeeded?.();
          } else {
            try { await this.sortedOrder(frame); } catch(error) { if(error instanceof StaleRenderQueryError) return; throw error; }
            try { this.current(frame,true); } catch(error) { if(error instanceof StaleRenderQueryError) return; throw error; }
            this.setOpacityPreview(opacityScale,opacitySelectedOnly); this.drawSorted(frame,null);
          }
        } else {
          this.steady.suspend('SteadySplats requires a Gaussian scene.');
          if(!this.depthTarget || this.depthTarget.width!==width || this.depthTarget.height!==height) {
            const next=this.createTarget(width,height,this.admitGeometryDepth?.(checkedBytes(width*height,8))),old=this.depthTarget;
            this.depthTarget=next; if(old) this.retireTarget(old);
          }
          this.drawGeometry(frame,this.depthTarget.target);
          const {gl}=this; gl.bindFramebuffer(gl.READ_FRAMEBUFFER,this.depthTarget.target); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);
          gl.blitFramebuffer(0,0,width,height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
        }
        if(!this.prepared || this.prepared.scene!==frame.scene || this.prepared.revision!==frame.revision || !frame.words ||
          frame.words.some((value,i)=>value!==this.prepared?.words?.[i])) this.queryRevision++;
        this.prepared=frame; this.preparedOpacityRevision=this.opacityRevision;
      } else {
        if(this.depthTarget) { const old=this.depthTarget; this.depthTarget=undefined; this.retireTarget(old); }
        this.steady.suspend('SteadySplats requires a Gaussian scene.');
        const {gl}=this; gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,width,height); gl.clearColor(shade,shade,shade,1); gl.clear(gl.COLOR_BUFFER_BIT); this.prepared=undefined;
      }
      requireGlAllocation(this.gl,'The graphics display submission'); this.gl.flush(); const done=this.fence(); void done.catch(()=>undefined);
      this.displayCheckpoint={deviceEpoch:this.deviceEpoch,submissionSequence:this.submission+1,done};
      this.submission++;
      this.canvas.dataset.frames=String(this.submission);
      if(frame?.scene.kind==='gaussian') {
        const previous=this.histogramDisplay,steadyFrame=this.steady.snapshot.frame;
        if(!previous || previous.frame.scene!==frame.scene || previous.frame.revision!==frame.revision || previous.frame.camera.revision!==frame.camera.revision ||
          previous.frame.width!==frame.width || previous.frame.height!==frame.height || previous.frame.shade!==frame.shade || previous.steadyFrame!==steadyFrame ||
          frame.words!.some((value,i)=>value!==previous.frame.words?.[i])) this.histogramDisplay={frame,steadyFrame,identity:{}};
        this.histogram.observe(frame,this.histogramDisplay!.identity,this.submission);
      } else if(this.histogramDisplay) this.resetHistogram();
    });
  }
  private queryFrame(scene:GaussianScene) {
    this.requireScene(scene); const frame=this.prepared;
    if(!frame || frame.scene!==scene || frame.revision!==scene.revision || !frame.words || this.preparedOpacityRevision!==this.opacityRevision)
      throw new StaleRenderQueryError('Prepare the current scene before querying it.');
    this.current(frame,true); return frame;
  }
  private surfaceSnapshot(scene:GaussianScene) {
    const frame=this.queryFrame(scene),sourceRevision=scene.sourceRevision,selectedRevision=scene.selectedRevision,opacityRevision=this.opacityRevision;
    const words=(value:Uint32Array)=>[...value.subarray(0,42),value[59],...value.subarray(60,77),value[76]?value[77]:0,value[79]];
    const signature=words(frame.words!),selectedGeometry=frame.words![76]!==0 && frame.words![77]!==0,selectedOpacity=(frame.words![79]&3)===3;
    const geometryTargets=scene.previewMaskRevision('transformBase'),opacityTargets=scene.previewMaskRevision('opacityBase');
    const check=()=>{
      this.requireScene(scene); const current=this.prepared,currentSignature=current?.words?words(current.words):[];
      if(current?.scene!==scene || scene.sourceRevision!==sourceRevision || this.opacityRevision!==opacityRevision || this.preparedOpacityRevision!==opacityRevision ||
        ((selectedGeometry || selectedOpacity) && scene.selectedRevision!==selectedRevision) || selectedGeometry && scene.previewMaskRevision('transformBase')!==geometryTargets ||
        selectedOpacity && scene.previewMaskRevision('opacityBase')!==opacityTargets || this.canvas.width!==frame.width || this.canvas.height!==frame.height || signature.some((value,i)=>value!==currentSignature[i]))
        throw new StaleRenderQueryError('The surface geometry, view, viewport or source membership changed.');
    };
    check(); return {frame,check};
  }
  private queryCancellation(frame:GlFrame,signal?:AbortSignal) {
    const scene=frame.scene as GlScene,source=scene.sourceRevision,selected=scene.selectedRevision,transform=scene.previewMaskRevision('transformBase'),opacity=scene.previewMaskRevision('opacityBase');
    const words=frame.words!,scopedGeometry=!!words[76] && !!words[77],scopedOpacity=(words[79]&3)===3;
    const cancel=new AbortController(),abort=()=>cancel.abort(signal?.reason);
    if(signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
    this.queryCancellations.set(cancel,next=>{
      if(next?.scene!==scene || next.width!==frame.width || next.height!==frame.height || scene.sourceRevision!==source ||
        ((scopedGeometry || scopedOpacity) && scene.selectedRevision!==selected) ||
        scopedGeometry && scene.previewMaskRevision('transformBase')!==transform || scopedOpacity && scene.previewMaskRevision('opacityBase')!==opacity) return false;
      const value=next.words!;
      for(let i=0;i<42;i++) if(words[i]!==value[i]) return false;
      if(words[59]!==value[59] || words[79]!==value[79]) return false;
      for(let i=60;i<78;i++) if(words[i]!==value[i]) return false;
      return true;
    });
    return {signal:cancel.signal,dispose:()=>{signal?.removeEventListener('abort',abort);this.queryCancellations.delete(cancel);}};
  }
  private queryInputs(frame:GlFrame) {
    return {frame:frame.values!.slice().buffer,canonical:frame.masks!.canonical.slice().buffer,transform:frame.masks!.transform.slice().buffer,opacity:frame.masks!.opacity.slice().buffer};
  }
  async pick(scene:GaussianScene,x:number,y:number,centerRadius=0):Promise<import('../contracts').RenderPick> {
    const frame=this.queryFrame(scene),revision=this.queryRevision,opacityRevision=this.opacityRevision;
    if(![x,y,centerRadius].every(Number.isFinite) || centerRadius<0 || x<0 || y<0 || x>=frame.width || y>=frame.height)
      return {index:null,depth:0,opacity:0,contribution:0,deviceEpoch:this.deviceEpoch};
    x=Math.fround(Math.floor(x)+.5); y=Math.fround(Math.floor(y)+.5); centerRadius=Math.fround(centerRadius);
    const check=()=>{this.current(frame,true); if(this.queryRevision!==revision || this.prepared?.scene!==scene || opacityRevision!==this.opacityRevision || this.preparedOpacityRevision!==opacityRevision)
      throw new StaleRenderQueryError('The rendered view, viewport or scene changed before the query completed.');};
    return this.runQuery(async()=>{
      check(); const release=this.admitWork?.(checkedBytes(scene.count,67)+320+65536),cancellation=this.queryCancellation(frame);
      try {
        const input=this.queryInputs(frame),response=await this.compute.request({action:'pick',scene:(scene as GlScene).id,...input,x,y,radius:centerRadius},Object.values(input),cancellation.signal);
        check(); return {...response.pick!,deviceEpoch:this.deviceEpoch};
      } finally { cancellation.dispose(); release?.(); }
    });
  }
  async surface(scene:GaussianScene,options:SurfaceOptions):Promise<SurfaceMap> {
    const {frame,check:snapshot}=this.surfaceSnapshot(scene),check=()=>{options.signal?.throwIfAborted(); snapshot();};
    const {width,height,scale}=surfaceDimensions(frame.width,frame.height),region=resolveSurfaceRegion(options,width,height),pixels=width*height,downsampled=width!==frame.width || height!==frame.height;
    const capacity=(value:number) => { if(!Number.isInteger(value) || value<1 || value>65536 || (value&(value-1))) throw new RangeError('Surface tile capacity must be a power of two between 1 and 65536.'); return value; };
    const initial=options.initialTileCapacity===undefined?undefined:capacity(options.initialTileCapacity),maximum=options.maxTileCapacity===undefined?undefined:capacity(options.maxTileCapacity);
    if(initial!==undefined && maximum!==undefined && initial>maximum) throw new RangeError('Initial surface tile capacity exceeds its explicit query limit.');
    const retained=checkedBytes(pixels,options.colors?20:8)+(options.visible?Math.ceil(scene.count/32)*4:0);
    const tiles=Math.ceil(width/16)*Math.ceil(height/16),scratch=checkedBytes(scene.count,51+(options.visible?4:0)+(options.visible && downsampled?48:0))+checkedBytes(tiles,12)+320+48+65536;
    check(); const lease=options.admit(retained+scratch); let published=false;
    return this.runQuery(async()=>{
      const cancellation=this.queryCancellation(frame,options.signal);
      try {
        check(); const input=this.queryInputs(frame),parameters=encodeSurfaceParameters({fullWidth:frame.width,fullHeight:frame.height,width,height,sourceCount:scene.count,
          channelFlags:surfaceChannelFlags(options,downsampled),dispatchWidth:1,scale,region}).buffer;
        const response=await this.compute.request({action:'surface',scene:(scene as GlScene).id,...input,parameters,maximum},[...Object.values(input),parameters],cancellation.signal,bytes=>{check(); lease.resize(retained+scratch+checkedBytes(bytes,1));});
        check(); const result=response.surface!,depths=new Float32Array(result.depths),opacities=new Float32Array(result.opacities),colors=result.colors?new Float32Array(result.colors):undefined,visible=result.visible?new Uint32Array(result.visible):undefined;
        lease.resize(retained); let disposed=false;
        const map:SurfaceMap=Object.freeze({width,height,fullWidth:frame.width,fullHeight:frame.height,depths,opacities,colors,visible,region,deviceEpoch:this.deviceEpoch,
          attempts:1,allocationBytes:retained+scratch+result.candidateBytes+result.sortScratchBytes,candidateBytes:result.candidateBytes,candidateEntries:result.candidateEntries,tileCapacity:result.tileCapacity,
          tileCount:result.tileCount,occupiedTiles:result.occupiedTiles,sortComparisons:result.sortComparisons,
          assertCurrent:()=>{if(disposed) throw new StaleRenderQueryError('The surface map was disposed.'); snapshot();},
          dispose:()=>{if(disposed) return; disposed=true; for(const value of [depths,opacities,colors,visible]) if(value?.byteLength) structuredClone(value.buffer,{transfer:[value.buffer]}); lease();}});
        published=true; return map;
      } finally { cancellation.dispose(); if(!published) lease(); }
    });
  }
  captureRgba(scene:RenderScene,camera:RenderCamera,operation:ImageOperation,grade=NEUTRAL_COLOR,geometry=IDENTITY_MATRIX,
    selectedOnly=false,geometrySelectedOnly=selectedOnly,opacityScale=1,opacitySelectedOnly=false):Promise<OwnedRgbaImage> {
    this.requireScene(scene);
    const frame=this.frame(scene,camera,[...grade],false,[...geometry],selectedOnly,geometrySelectedOnly,opacityScale,opacitySelectedOnly);
    const check=() => { operation.signal?.throwIfAborted(); operation.current?.(); this.current(frame); };
    check(); const bytes=rgbaImageBytes(frame.width,frame.height); let retained:(()=>void)|undefined=operation.admit(bytes);
    return this.run(async () => {
      let scratch:(()=>void)|undefined,target:DepthTarget|undefined,readback:WebGLBuffer|undefined,pixels:Uint8ClampedArray<ArrayBuffer>|undefined,touched=false,completed=false;
      const {gl}=this;
      try {
        check(); scratch=operation.admit(checkedBytes(bytes,scene.kind==='geometry'?4:3));
        touched=true;
        target=this.createTarget(frame.width,frame.height,undefined,scene.kind==='geometry'); readback=gl.createBuffer()??undefined; if(!readback) throw new Error('The image readback could not be allocated.');
        if(scene.kind==='gaussian') { await this.sortedOrder(frame,operation.signal,32); check(); this.drawSorted(frame,target.target); }
        else this.drawGeometry(frame,target.target);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER,target.target); gl.readBuffer(gl.COLOR_ATTACHMENT0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER,readback); gl.bufferData(gl.PIXEL_PACK_BUFFER,bytes,gl.STREAM_READ); gl.readPixels(0,0,frame.width,frame.height,gl.RGBA,gl.UNSIGNED_BYTE,0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null); requireGlAllocation(gl,'The image readback');
        await this.fence(); completed=true; check();
        const source=new Uint8Array(bytes); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,readback); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,source); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
        pixels=new Uint8ClampedArray(bytes);
        for(let y=0;y<frame.height;y++) pixels.set(source.subarray((frame.height-1-y)*frame.width*4,(frame.height-y)*frame.width*4),y*frame.width*4);
        check(); const image=ownRgbaImage(frame.width,frame.height,pixels,retained!); retained=undefined; return image;
      } finally {
        if(touched && !completed) await this.fence().catch(()=>undefined);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null); if(readback) gl.deleteBuffer(readback);
        if(target) { gl.deleteFramebuffer(target.target); gl.deleteTexture(target.color); if(target.depth) gl.deleteRenderbuffer(target.depth); }
        scratch?.(); retained?.(); retained=undefined;
      }
    });
  }
  async capture(scene:RenderScene,camera:RenderCamera,type='image/png',grade=NEUTRAL_COLOR,geometry=IDENTITY_MATRIX,
    selectedOnly=false,geometrySelectedOnly=selectedOnly,opacityScale=1,opacitySelectedOnly=false):Promise<Blob> {
    if(type!=='image/png' && type!=='image/jpeg') throw new Error('Unsupported capture image type.');
    const operation:ImageOperation={admit:()=>()=>undefined};
    const raw=await this.captureRgba(scene,camera,operation,grade,geometry,selectedOnly,geometrySelectedOnly,opacityScale,opacitySelectedOnly);
    try { const output=await encodeRgba(raw,type,operation); try { return output.blob; } finally { output.dispose(); } } finally { raw.dispose(); }
  }
  async close() {
    this.dispose();
    await Promise.allSettled([this.tail, ...this.queries]);
    // A retiring preparation may enqueue its resource cleanup after a yield.
    while (this.retiring.size) await Promise.allSettled([...this.retiring]);
  }
  dispose() {
    if(this.disposed) return; this.disposed=true; this.displayRequest++;
    for(const cancel of this.queryCancellations.keys()) cancel.abort();
    this.steady.dispose();
    this.histogram.dispose();
    this.canvas.removeEventListener('webglcontextlost',this.contextLost); this.compute.close();
    if(this.depthTarget) { this.retireTarget(this.depthTarget); this.depthTarget=undefined; }
    this.retireAfterFence(() => { this.gl.deleteProgram(this.sorted); this.gl.deleteProgram(this.geometry); this.gl.deleteBuffer(this.frameBuffer); this.gl.deleteBuffer(this.quadIndices);
      this.gl.deleteVertexArray(this.emptyVao); this.gl.deleteVertexArray(this.geometryVao); });
  }
}
