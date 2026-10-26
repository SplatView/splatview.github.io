import gaussianSource from './gaussian.glsl?raw';
import splatVertex from './splat.vert.glsl?raw';
import uniformSource from './steadyUniform.glsl?raw';
import sampleSource from './steadySample.frag.glsl?raw';
import densitySource from './steadyDensity.glsl?raw';
import historySource from './steadyHistory.frag.glsl?raw';
import resolveSource from './steadyResolve.frag.glsl?raw';
import compositeSource from './steadyComposite.frag.glsl?raw';
import { spatiotemporalBlueNoiseData } from '../steadyNoise';
import { DEFAULT_STEADY_SETTINGS,validateSteadySettings,type SteadySettings,type SteadyStatus } from '../steadySettings';
import { invertMatrix,multiplyMatrices,SteadyFrameState } from '../steadyState';
import { preparePrograms } from './programPreparation';
import { uniformLocation,uniformBlock,samplerUniform,depth32,framebuffer,FULLSCREEN_VERTEX,requireGlAllocation,texture2d } from './gl';
import { GL_STEADY_UNIFORM_BYTES,planGlSteady } from './steadyLayout';
import type { GlRenderer,GlFrame } from './renderer';

type Programs=Record<'sample'|'history'|'resolve'|'composite',WebGLProgram>;
type Resources={width:number;height:number;noise:WebGLTexture;params:WebGLBuffer;raw:WebGLTexture;samples:WebGLTexture;axes:WebGLTexture;opacity:WebGLTexture;
  sampleTarget:WebGLFramebuffer;histories:[WebGLTexture[],WebGLTexture[]];historyTargets:WebGLFramebuffer[];
  colors:WebGLTexture[];averages:WebGLTexture[];resolveTargets:WebGLFramebuffer[];textures:WebGLTexture[];targets:WebGLFramebuffer[];depth:WebGLRenderbuffer;
  release():void;retirement?:Promise<void>};

/** Framebuffer resource owner; the renderer owns all display submissions. */
export class GlSteadySplats {
  private settings=DEFAULT_STEADY_SETTINGS;
  private readonly state=new SteadyFrameState();
  private resources?:Resources;
  private programs?:Programs;
  private programPreparation?:Promise<void>;
  private desired?:{width:number;height:number};
  private generation=0;
  private failed=false;
  private disposed=false;
  private preparation?:Promise<void>;
  private previousViewProjection?:Float32Array;
  private writeIndex=0;
  private status:SteadyStatus='sorted';
  private reason:string|null=null;
  private allocatedBytes=0;
  constructor(private readonly renderer:GlRenderer) {}
  get snapshot() { return {status:this.status,reason:this.reason,allocationBytes:this.allocatedBytes,frame:this.state.frame,restFrames:this.state.restFrames,valid:this.state.valid}; }
  configure(settings:SteadySettings) {
    const next=validateSteadySettings(settings);
    if(Object.keys(next).every(key=>next[key as keyof SteadySettings]===this.settings[key as keyof SteadySettings])) return;
    this.settings=next; this.failed=false; this.resetHistory();
    if(next.mode==='sorted') this.suspend(); else { this.generation++; this.report(this.resources?'steady':'preparing'); }
  }
  resetHistory() { this.state.reset(); this.previousViewProjection=undefined; this.writeIndex=0; }
  private report(status:SteadyStatus,reason:string|null=null) { this.reason=reason; if(status===this.status) return; this.status=status; if(!this.disposed) this.renderer.onRenderStatus?.(status); }
  suspend(reason?:string) {
    if(this.desired || this.resources) {
      this.generation++; this.desired=undefined; this.failed=false; this.resetHistory();
      if(this.resources) { const old=this.resources; this.resources=undefined; void this.retire(old); }
    }
    this.report(reason && this.settings.mode==='steady'?'unavailable':'sorted',reason??null);
  }
  ready(width:number,height:number) {
    if(this.disposed || this.settings.mode!=='steady') return false;
    if(this.resources?.width===width && this.resources.height===height) return true;
    if(this.desired?.width!==width || this.desired.height!==height) {
      this.desired={width,height}; this.generation++; this.failed=false; this.resetHistory();
      if(this.resources) { const old=this.resources; this.resources=undefined; void this.retire(old); }
    }
    this.prepare(); return false;
  }
  private prepare() {
    if(this.preparation || this.disposed || this.failed || !this.desired || this.settings.mode!=='steady') return;
    const generation=this.generation,{width,height}=this.desired; this.report('preparing');
    const task=this.createResources(width,height,generation).then(async resources => {
      if(this.disposed || generation!==this.generation || this.settings.mode!=='steady') { await this.retire(resources); return; }
      this.resources=resources; this.resetHistory(); this.report('steady');
    }).catch(error => {
      if(!this.disposed && generation===this.generation) { this.failed=true; this.report('unavailable',error instanceof Error?error.message:String(error)); }
    }).finally(() => { if(this.preparation===task) this.preparation=undefined; if(!this.disposed) this.renderer.onFrameNeeded?.(); });
    this.preparation=task; this.renderer.trackRetirement(task);
  }
  private async createResources(width:number,height:number,generation:number):Promise<Resources> {
    const plan=planGlSteady(width,height,this.renderer.capabilities);
    await this.preparePrograms();
    if(this.disposed || generation!==this.generation) throw new DOMException('Steady preparation was retired.','AbortError');
    await this.renderer.compute.trimSortScratch();
    if(this.disposed || generation!==this.generation) throw new DOMException('Steady preparation was retired.','AbortError');
    const {gl}=this.renderer,credit=this.renderer.admitSteady?.(plan.bytes);
    this.allocatedBytes+=plan.bytes; let released=false;
    const release=() => { if(released) return; released=true; this.allocatedBytes-=plan.bytes; credit?.(); };
    const textures:WebGLTexture[]=[],targets:WebGLFramebuffer[]=[];
    let depth:WebGLRenderbuffer|undefined,params:WebGLBuffer|undefined;
    try {
      const texture=(format:number) => { const value=texture2d(gl,width,height,format); textures.push(value); return value; };
      const target=(colors:WebGLTexture[],depth?:WebGLRenderbuffer) => { const value=framebuffer(gl,colors,depth); targets.push(value); return value; };
      const raw=texture(gl.RGBA16F),samples=texture(gl.RGBA32UI),axes=texture(gl.RGBA32F),opacity=texture(gl.R32F);
      depth=depth32(gl,width,height); const sampleTarget=target([raw,samples,axes,opacity],depth);
      const histories:[WebGLTexture[],WebGLTexture[]]=[[],[]];
      for(const set of histories) for(let i=0;i<4;i++) set.push(texture(gl.RGBA32UI));
      const historyTargets=histories.map(set=>target(set)),colors=[texture(gl.RGBA16F),texture(gl.RGBA16F)],averages=[texture(gl.RGBA32F),texture(gl.RGBA32F)];
      const resolveTargets=colors.map((color,i)=>target([color,averages[i]]));
      const noise=gl.createTexture(); if(!noise) throw new Error('The sample noise could not be allocated.'); textures.push(noise);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_3D,noise); gl.texStorage3D(gl.TEXTURE_3D,1,gl.R8,32,32,64);
      gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MIN_FILTER,gl.NEAREST); gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_3D,gl.TEXTURE_WRAP_R,gl.CLAMP_TO_EDGE);
      gl.texSubImage3D(gl.TEXTURE_3D,0,0,0,0,32,32,64,gl.RED,gl.UNSIGNED_BYTE,spatiotemporalBlueNoiseData());
      params=gl.createBuffer()??undefined; if(!params) throw new Error('The sample parameters could not be allocated.');
      gl.bindBuffer(gl.UNIFORM_BUFFER,params); gl.bufferData(gl.UNIFORM_BUFFER,GL_STEADY_UNIFORM_BYTES,gl.DYNAMIC_DRAW);
      requireGlAllocation(gl,'The SteadySplats frame resources'); await this.renderer.fence();
      return {width,height,noise,params,raw,samples,axes,opacity,sampleTarget,histories,historyTargets,colors,averages,resolveTargets,textures,targets,depth,release};
    } catch(error) {
      await this.renderer.fence().catch(()=>undefined);
      for(const value of textures) gl.deleteTexture(value); for(const value of targets) gl.deleteFramebuffer(value);
      if(depth) gl.deleteRenderbuffer(depth); if(params) gl.deleteBuffer(params);
      release(); throw error;
    } finally { gl.bindFramebuffer(gl.FRAMEBUFFER,null); }
  }
  preparePrograms():Promise<void> {
    if(this.disposed) return Promise.reject(new DOMException('Steady preparation was retired.','AbortError'));
    if(!this.renderer.capabilities.steady) return Promise.reject(new Error(this.renderer.capabilities.steadyReason??'SteadySplats render targets are unavailable.'));
    if(this.programs) return Promise.resolve();
    if(this.programPreparation) return this.programPreparation;
    const {gl}=this.renderer;
    const task=preparePrograms(gl,[
      {vertex:'#version 300 es\n'+gaussianSource+splatVertex,fragment:'#version 300 es\n'+uniformSource+sampleSource},
      {vertex:FULLSCREEN_VERTEX,fragment:'#version 300 es\n'+uniformSource+densitySource+historySource},
      {vertex:FULLSCREEN_VERTEX,fragment:'#version 300 es\n'+uniformSource+densitySource+resolveSource},
      {vertex:FULLSCREEN_VERTEX,fragment:'#version 300 es\n'+compositeSource}],()=>!this.disposed && !this.renderer.lost)
      .then(prepared=>{
        if(this.disposed || this.renderer.lost) {
          for(const program of prepared) gl.deleteProgram(program);
          throw new DOMException('Steady preparation was retired.','AbortError');
        }
        this.programs={sample:prepared[0],history:prepared[1],resolve:prepared[2],composite:prepared[3]};
      })
      .finally(()=>{ if(this.programPreparation===task) this.programPreparation=undefined; });
    this.programPreparation=task;
    return this.renderer.trackRetirement(task);
  }
  private retire(resources:Resources):Promise<void> {
    return resources.retirement??=this.renderer.trackRetirement((async () => {
      try { await this.renderer.fence(); } catch { /* Context loss establishes retirement. */ }
      finally { const {gl}=this.renderer; for(const value of resources.targets) gl.deleteFramebuffer(value); for(const value of resources.textures) gl.deleteTexture(value);
        gl.deleteRenderbuffer(resources.depth); gl.deleteBuffer(resources.params); resources.release(); }
    })());
  }
  private bind(program:WebGLProgram,resources:Resources,textures:readonly (readonly [string,WebGLTexture])[]) {
    const {gl}=this.renderer; gl.useProgram(program); this.renderer.bindFullscreen();
    const block=uniformBlock(gl,program,'SteadyParameters',1);
    if(block!==gl.INVALID_INDEX) { gl.bindBufferBase(gl.UNIFORM_BUFFER,1,resources.params); }
    textures.forEach(([name,texture],i)=>{gl.activeTexture(gl.TEXTURE0+i); gl.bindTexture(gl.TEXTURE_2D,texture); samplerUniform(gl,program,name,i);});
  }
  encode(frame:GlFrame) {
    const resources=this.resources!,programs=this.programs!,{gl}=this.renderer;
    const state=this.state.observe({scene:frame.scene,revision:frame.revision,uniform:frame.words!,shade:frame.shade},this.settings);
    const view=frame.values!.subarray(0,16),projection=frame.values!.subarray(16,32),viewProjection=multiplyMatrices(projection,view);
    if(state.reconstruct) {
      const values=new Float32Array(GL_STEADY_UNIFORM_BYTES/4),words=new Uint32Array(values.buffer);
      values.set(invertMatrix(projection)); values.set(invertMatrix(view),16); values.set(this.previousViewProjection??viewProjection,32);
      words.set([state.sampleFrame,Number(state.valid),Number(state.still),state.restFrames],48); values.set([resources.width,resources.height,this.settings.historyWeight,frame.shade],52);
      words.set([0,resources.height,Math.imul(Math.floor(state.sampleFrame/64),0x9e3779b9)>>>0,0],56);
      gl.bindBuffer(gl.UNIFORM_BUFFER,resources.params); gl.bufferSubData(gl.UNIFORM_BUFFER,0,values); gl.bindBufferBase(gl.UNIFORM_BUFFER,1,resources.params);
      gl.bindFramebuffer(gl.FRAMEBUFFER,resources.sampleTarget); gl.viewport(0,0,resources.width,resources.height);
      gl.disable(gl.BLEND); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.CULL_FACE); gl.colorMask(true,true,true,true);
      const clear=new Float32Array(4); gl.clearBufferfv(gl.COLOR,0,clear); gl.clearBufferuiv(gl.COLOR,1,new Uint32Array(4)); gl.clearBufferfv(gl.COLOR,2,clear); gl.clearBufferfv(gl.COLOR,3,clear);
      gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.depthFunc(gl.LEQUAL); gl.clearBufferfv(gl.DEPTH,0,new Float32Array([1]));
      this.renderer.bindSplat(programs.sample,frame,false);
      uniformBlock(gl,programs.sample,'SteadyParameters',1);
      gl.uniform1i(uniformLocation(gl,programs.sample,'stochasticDepth'),1); gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_3D,resources.noise); samplerUniform(gl,programs.sample,'noiseTexture',3);
      gl.drawElementsInstanced(gl.TRIANGLES,6,gl.UNSIGNED_SHORT,0,frame.scene.count); gl.disable(gl.DEPTH_TEST);
      const previous=1-this.writeIndex,oldFifo=resources.histories[previous];
      const density:readonly (readonly [string,WebGLTexture])[]=[['sampleTexture',resources.samples],['axesTexture',resources.axes],['opacityTexture',resources.opacity],...oldFifo.map((texture,i)=>[`fifo${i}`,texture] as const)];
      gl.bindFramebuffer(gl.FRAMEBUFFER,resources.historyTargets[this.writeIndex]); this.bind(programs.history,resources,density); gl.drawArrays(gl.TRIANGLES,0,3);
      gl.bindFramebuffer(gl.FRAMEBUFFER,resources.resolveTargets[this.writeIndex]);
      this.bind(programs.resolve,resources,[...density,['rawTexture',resources.raw],['previousColor',resources.colors[previous]],['previousAverage',resources.averages[previous]]]); gl.drawArrays(gl.TRIANGLES,0,3);
      requireGlAllocation(gl,'The SteadySplats reconstruction'); this.previousViewProjection=viewProjection; this.writeIndex=previous;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,null); gl.viewport(0,0,resources.width,resources.height); gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST);
    this.bind(programs.composite,resources,[['reconstructedColor',resources.colors[1-this.writeIndex]]]); gl.uniform1f(uniformLocation(gl,programs.composite,'backgroundShade'),frame.shade); gl.drawArrays(gl.TRIANGLES,0,3);
    return state.needsMore;
  }
  dispose() {
    if(this.disposed) return; this.disposed=true; this.suspend(); this.generation++;
    if(this.programs) { const programs=this.programs; this.programs=undefined; this.renderer.retireAfterFence(()=>{for(const value of Object.values(programs)) this.renderer.gl.deleteProgram(value);}); }
  }
}
