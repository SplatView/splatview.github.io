import type { DepthOrderKey } from '../orderKey';
import { checkedBytes, MiB } from '../../document/resources';
import { sameDuplicateRange, validateDuplicateRange, type DuplicateRange } from '../../document/duplicateProtocol';
import { StaleRenderQueryError, type GaussianScene, type MaskUpdate, type PreviewMaskChannel, type PreviewMasks,
  type PreviewMaskUpdate, type RetiredRenderResource } from '../contracts';
import { texture2d, requireGlAllocation } from './gl';
import { planGlScene, textureUploadSpans } from './sceneLayout';
import type { GlRenderer } from './renderer';

const channels:readonly PreviewMaskChannel[]=['colorBase','transformBase','opacityBase'];
let nextScene=0;
export type GlMaskSnapshot=Readonly<{canonical:Uint8Array<ArrayBuffer>;color:Uint8Array<ArrayBuffer>;
  transform:Uint8Array<ArrayBuffer>;opacity:Uint8Array<ArrayBuffer>;texture:WebGLTexture}>;

/** Packed source storage, immutable mask generations and worker mirror lifetime. */
export class GlScene implements GaussianScene {
  readonly kind='gaussian' as const;
  readonly id=++nextScene;
  readonly layout:ReturnType<typeof planGlScene>;
  readonly words:WebGLTexture;
  readonly order:WebGLTexture;
  residentOrder?:DepthOrderKey;
  residentSortPrecision:16|24|32=32;
  readonly stride:number;
  retired=false;
  revision=0; sourceRevision=0; selectedRevision=0;
  private canonical:Uint8Array<ArrayBuffer>;
  private previews:Partial<Record<PreviewMaskChannel,Uint8Array<ArrayBuffer>>>={};
  private previewRevisions:Record<PreviewMaskChannel,number>={colorBase:0,transformBase:0,opacityBase:0};
  private stateTexture:WebGLTexture;
  private bindingRevision=0;
  private duplicateRange:DuplicateRange=null;
  private duplicateSelected=false;
  private uploadBytes=0;
  private retirement?:Promise<void>;
  get deviceEpoch() { return this.renderer.deviceEpoch; }
  get duplicateSelectionGuarded() { return this.duplicateSelected; }
  get allocationBytes() { return this.layout.bytes+Object.values(this.previews).reduce((sum,value)=>sum+value.byteLength,0); }
  private constructor(readonly renderer:GlRenderer,readonly count:number,readonly degree:number) {
    this.layout=planGlScene(count,degree,renderer.capabilities.maxTextureSize); this.stride=this.layout.stride;
    this.canonical=new Uint8Array(count);
    const {gl}=renderer, allocated:WebGLTexture[]=[];
    try {
      this.words=texture2d(gl,this.layout.words.width,this.layout.words.height,gl.R32UI); allocated.push(this.words);
      this.order=texture2d(gl,this.layout.order.width,this.layout.order.height,gl.R32UI); allocated.push(this.order);
      this.stateTexture=texture2d(gl,this.layout.states.width,this.layout.states.height,gl.RGBA32UI); allocated.push(this.stateTexture);
    } catch(error) { for(const texture of allocated) gl.deleteTexture(texture); throw error; }
  }
  static async create(renderer:GlRenderer,count:number,degree:number) {
    renderer.requireScene(); let scene:GlScene|undefined;
    try { scene=new GlScene(renderer,count,degree); await renderer.compute.request({action:'create',scene:scene.id,count,stride:scene.stride}); renderer.requireScene(); return scene; }
    catch(error) { if(scene) await scene.dispose(); else await renderer.fence().catch(()=>undefined); throw error; }
  }
  snapshotMasks():GlMaskSnapshot {
    return {canonical:this.canonical,color:this.previews.colorBase??this.canonical,transform:this.previews.transformBase??this.canonical,
      opacity:this.previews.opacityBase??this.canonical,texture:this.stateTexture};
  }
  async upload(first:number,count:number,bytes:ArrayBuffer) {
    this.renderer.requireScene(this);
    if(![first,count].every(Number.isSafeInteger) || first<0 || count<1 || first+count>this.count || bytes.byteLength!==checkedBytes(count,this.stride))
      throw new Error('Invalid scene upload.');
    const {gl}=this.renderer, data=new Uint32Array(bytes); gl.bindTexture(gl.TEXTURE_2D,this.words);
    for(const span of textureUploadSpans(first*this.stride/4,count*this.stride/4,this.layout.words))
      gl.texSubImage2D(gl.TEXTURE_2D,0,span.x,span.y,span.width,span.height,gl.RED_INTEGER,gl.UNSIGNED_INT,data.subarray(span.offset,span.offset+span.entries));
    requireGlAllocation(gl,'The packed source upload'); this.revision++; this.sourceRevision++;
    // Transfer the loader's owned chunk only after the synchronous GL upload.
    await this.renderer.compute.request({action:'upload',scene:this.id,first,count,bytes},[bytes]);
    this.renderer.requireScene(this); this.uploadBytes+=count*this.stride;
    if(this.uploadBytes>=16*MiB) { await this.renderer.fence(); this.uploadBytes=0; this.renderer.requireScene(this); }
  }
  private validateMask(bytes:ArrayBuffer) {
    if(bytes.byteLength!==this.count) throw new Error('Invalid scene state mask.');
    const source=new Uint8Array(bytes); if(source.some(value=>value>3)) throw new Error('Invalid scene state mask.');
    return source;
  }
  private publishCanonical(source:Uint8Array<ArrayBuffer>) {
    let membership=false,selected=false;
    for(let i=0;i<this.count;i++) { const change=source[i]^this.canonical[i]; membership ||= !!(change&2); selected ||= !!(change&1); }
    if(membership) this.sourceRevision++; if(selected) this.selectedRevision++;
    this.canonical=source; this.updateDuplicate();
  }
  private updateDuplicate() {
    let selected=0,copies=0; const range=this.duplicateRange;
    if(range) for(let i=0;i<this.count;i++) if(this.canonical[i]===1) { selected++; if(i>=range.first) copies++; }
    this.duplicateSelected=!!range && selected===range.count && copies===range.count;
  }
  setDuplicateRange(value:DuplicateRange) {
    const range=validateDuplicateRange(value,this.count); if(sameDuplicateRange(range,this.duplicateRange)) return;
    this.duplicateRange=range; this.updateDuplicate();
  }
  hasPreviewMask(channel:PreviewMaskChannel) { return this.previews[channel]!==undefined; }
  previewMaskRevision(channel:PreviewMaskChannel) { return this.previewRevisions[channel]; }
  private uploadStates(texture:WebGLTexture,canonical:Uint8Array,previews:Partial<Record<PreviewMaskChannel,Uint8Array>>) {
    const {gl}=this.renderer, expanded=new Uint32Array(this.count*4);
    for(let i=0;i<this.count;i++) {
      expanded.set([canonical[i],(previews.colorBase??canonical)[i],(previews.transformBase??canonical)[i],(previews.opacityBase??canonical)[i]],i*4);
    }
    gl.bindTexture(gl.TEXTURE_2D,texture);
    for(const span of textureUploadSpans(0,this.count,this.layout.states))
      gl.texSubImage2D(gl.TEXTURE_2D,0,span.x,span.y,span.width,span.height,gl.RGBA_INTEGER,gl.UNSIGNED_INT,expanded.subarray(span.offset*4,(span.offset+span.entries)*4));
    requireGlAllocation(gl,'The scene state upload');
  }
  masks(bytes:ArrayBuffer) {
    this.renderer.requireScene(this); const borrowed=this.validateMask(bytes);
    const credit=this.renderer.admitWork?.(this.count*17);
    try {
      const source=borrowed.slice(); this.uploadStates(this.stateTexture,source,this.previews);
      this.publishCanonical(source); this.bindingRevision++; this.revision++;
    } finally { if(credit) this.renderer.retireAfterFence(credit); }
  }
  stageMasks(bytes:ArrayBuffer,targets:PreviewMasks={}):Promise<MaskUpdate> {
    return this.stage(bytes,targets) as Promise<MaskUpdate>;
  }
  stagePreviewMasks(bytes:ArrayBuffer|null,channel:PreviewMaskChannel):Promise<PreviewMaskUpdate> {
    return this.stage(undefined,{[channel]:bytes});
  }
  private async stage(bytes:ArrayBuffer|undefined,targets:PreviewMasks):Promise<PreviewMaskUpdate> {
    this.renderer.requireScene(this);
    const changed=Object.keys(targets) as PreviewMaskChannel[];
    if(changed.some(channel=>!channels.includes(channel) || targets[channel]===undefined)) throw new Error('Invalid preview mask channel.');
    if(bytes) this.validateMask(bytes);
    for(const channel of changed) if(targets[channel]!==null) this.validateMask(targets[channel]!);
    const newMaskBytes=(Number(bytes!==undefined)+changed.filter(channel=>targets[channel]!==null).length)*this.count;
    let credit=this.renderer.admitWork?.(this.layout.states.bytes+newMaskBytes+this.count*16);
    const source=bytes===undefined?this.canonical:new Uint8Array(bytes).slice(), next={...this.previews};
    const replaced:Uint8Array<ArrayBuffer>[]=[];
    if(bytes!==undefined) replaced.push(this.canonical);
    for(const channel of changed) {
      if(next[channel]) replaced.push(next[channel]!);
      if(targets[channel]===null) delete next[channel]; else next[channel]=new Uint8Array(targets[channel]!).slice();
    }
    const stamp=this.bindingRevision, oldTexture=this.stateTexture, {gl}=this.renderer;
    let texture:WebGLTexture|undefined,published=false,disposed=false;
    const retire:RetiredRenderResource={destroy:() => { gl.deleteTexture(oldTexture); for(const mask of replaced) if(mask.byteLength) structuredClone(mask.buffer,{transfer:[mask.buffer]}); }};
    try {
      texture=texture2d(gl,this.layout.states.width,this.layout.states.height,gl.RGBA32UI); this.uploadStates(texture,source,next);
      return {
        allocationBytes:this.layout.states.bytes+newMaskBytes,
        retirementBytes:this.layout.states.bytes+replaced.reduce((sum,mask)=>sum+mask.byteLength,0),retirementBuffers:[retire],
        publish:() => {
          this.renderer.requireScene(this);
          if(published || disposed || stamp!==this.bindingRevision) throw new StaleRenderQueryError('The scene masks changed before publication.');
          if(bytes!==undefined) this.publishCanonical(source);
          this.stateTexture=texture!; this.previews=next; this.bindingRevision++; this.revision++;
          for(const channel of changed) this.previewRevisions[channel]++;
          published=true; return retire;
        },
        dispose:async () => {
          if(disposed) return; disposed=true;
          try { if(!published) { await this.renderer.fence(); gl.deleteTexture(texture!); } }
          finally { credit?.(); credit=undefined; }
        },
      };
    } catch(error) { await this.renderer.fence().catch(()=>undefined); if(texture) gl.deleteTexture(texture); credit?.(); throw error; }
  }
  uploadOrder(order:Uint32Array) {
    this.residentOrder=undefined;
    const {gl}=this.renderer; gl.bindTexture(gl.TEXTURE_2D,this.order);
    for(const span of textureUploadSpans(0,this.count,this.layout.order))
      gl.texSubImage2D(gl.TEXTURE_2D,0,span.x,span.y,span.width,span.height,gl.RED_INTEGER,gl.UNSIGNED_INT,order.subarray(span.offset,span.offset+span.entries));
    requireGlAllocation(gl,'The sorted source order upload');
  }
  dispose():Promise<void> {
    if(this.retirement) return this.retirement; this.retired=true;
    return this.retirement=(async () => {
      try { await this.renderer.finish(); } catch { /* Context loss retires GL work. */ }
      await this.renderer.compute.request({action:'drop',scene:this.id}).catch(()=>undefined);
      const {gl}=this.renderer; gl.deleteTexture(this.words); gl.deleteTexture(this.order); gl.deleteTexture(this.stateTexture);
      for(const mask of [this.canonical,...Object.values(this.previews)]) if(mask.byteLength) structuredClone(mask.buffer,{transfer:[mask.buffer]});
      this.previews={};
    })();
  }
}
