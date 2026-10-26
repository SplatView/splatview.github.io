import { framebuffer,requireGlAllocation,texture2d } from './gl';
import type { GlFrame,GlRenderer } from './renderer';

const MAX_WIDTH=256,MAX_HEIGHT=144,PIXEL_BYTES=MAX_WIDTH*MAX_HEIGHT*4,ALLOCATION_BYTES=PIXEL_BYTES*3+3*256*4*2;
type Resources={texture:WebGLTexture;target:WebGLFramebuffer;readback:WebGLBuffer;release?:()=>void};

/** Copies the displayed framebuffer in the submitting task, then reads bounded pixels. */
export class GlHistogramSampler {
  private enabled=false;
  private disposed=false;
  private failed=false;
  private generation=0;
  private resources?:Resources;
  private pending?:Promise<void>;
  private desired?:object;
  private sampled?:object;
  private lastStarted=-Infinity;
  private timer?:ReturnType<typeof setTimeout>;
  constructor(private readonly renderer:GlRenderer) {}
  setEnabled(value:boolean) { if(this.enabled===value || this.disposed) return; this.enabled=value; if(!value) this.reset(); else if(this.failed) this.renderer.onHistogramUnavailable?.(); }
  reset() {
    this.generation++; this.desired=undefined; this.sampled=undefined; this.cancelTimer();
    if(this.resources) { const old=this.resources; this.resources=undefined; this.retire(old); }
  }
  private cancelTimer() { if(this.timer!==undefined) clearTimeout(this.timer); this.timer=undefined; }
  private requestFrame() {
    if(this.disposed || !this.enabled || this.failed || this.pending || !this.desired || this.desired===this.sampled) return;
    const delay=Math.max(0,this.lastStarted+200-performance.now());
    if(!delay) { this.cancelTimer(); this.renderer.onFrameNeeded?.(); return; }
    if(this.timer===undefined) this.timer=setTimeout(()=>{this.timer=undefined;this.requestFrame();},delay);
  }
  private retire(resources:Resources) {
    this.renderer.trackRetirement((async()=>{
      await this.pending; await this.renderer.fence().catch(()=>undefined);
      const {gl}=this.renderer; gl.deleteFramebuffer(resources.target); gl.deleteTexture(resources.texture); gl.deleteBuffer(resources.readback); resources.release?.();
    })());
  }
  private allocate():Resources {
    const {gl}=this.renderer,release=this.renderer.admitHistogram?.(ALLOCATION_BYTES);
    let texture:WebGLTexture|undefined,target:WebGLFramebuffer|undefined,readback:WebGLBuffer|undefined;
    try {
      texture=texture2d(gl,MAX_WIDTH,MAX_HEIGHT,gl.RGBA8); target=framebuffer(gl,[texture]);
      readback=gl.createBuffer()??undefined; if(!readback) throw new Error('The histogram readback could not be allocated.');
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER,readback); gl.bufferData(gl.PIXEL_PACK_BUFFER,PIXEL_BYTES,gl.STREAM_READ); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
      requireGlAllocation(gl,'The display histogram'); return {texture,target,readback,release};
    } catch(error) {
      if(target) gl.deleteFramebuffer(target); if(texture) gl.deleteTexture(texture); if(readback) gl.deleteBuffer(readback);
      if(release) this.renderer.retireAfterFence(release); throw error;
    }
  }
  observe(frame:GlFrame,identity:object,sequence:number) {
    if(this.disposed || !this.enabled || this.failed) return;
    this.desired=identity;
    if(this.sampled===identity) { this.cancelTimer(); return; }
    if(this.pending) return;
    if(performance.now()-this.lastStarted<200) { this.requestFrame(); return; }
    this.cancelTimer(); const generation=this.generation,{gl}=this.renderer;
    const width=Math.min(frame.width,MAX_WIDTH),height=Math.min(frame.height,MAX_HEIGHT);
    let resources:Resources;
    try {
      resources=this.resources??=this.allocate();
      gl.disable(gl.SCISSOR_TEST); gl.bindFramebuffer(gl.READ_FRAMEBUFFER,null); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,resources.target);
      gl.blitFramebuffer(0,0,frame.width,frame.height,0,0,width,height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,resources.target); gl.readBuffer(gl.COLOR_ATTACHMENT0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,resources.readback);
      gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,0); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null); gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      requireGlAllocation(gl,'The display histogram sampling');
    } catch { this.fail(); return; }
    this.sampled=identity; this.lastStarted=performance.now();
    const task=(async()=>{
      try {
        await this.renderer.fence();
        if(this.disposed || !this.enabled || generation!==this.generation || this.desired!==identity || frame.scene.retired) return;
        const pixels=new Uint8Array(width*height*4),bins=new Uint32Array(3*256);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER,resources.readback); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER,0,pixels); gl.bindBuffer(gl.PIXEL_PACK_BUFFER,null);
        requireGlAllocation(gl,'The display histogram readback');
        for(let i=0;i<pixels.length;i+=4) { bins[pixels[i]]++; bins[256+pixels[i+1]]++; bins[512+pixels[i+2]]++; }
        this.renderer.onHistogram?.({bins,width,height,frame:sequence,deviceEpoch:this.renderer.deviceEpoch},frame.scene);
      } catch { if(generation===this.generation) this.fail(); }
    })().finally(()=>{if(this.pending===task) this.pending=undefined; this.requestFrame();});
    this.pending=task;
  }
  private fail() { this.failed=true; this.cancelTimer(); if(this.resources) { const old=this.resources; this.resources=undefined; this.retire(old); } if(this.enabled && !this.disposed) this.renderer.onHistogramUnavailable?.(); }
  dispose() { if(this.disposed) return; this.disposed=true; this.enabled=false; this.reset(); }
}
