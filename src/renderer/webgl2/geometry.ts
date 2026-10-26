import { checkedBytes, MiB } from '../../document/resources';
import { validateGeometryDescriptor, type GeometryDescriptor } from '../geometryLayout';
import type { GeometryScene } from '../contracts';
import { requireGlAllocation } from './gl';
import type { GlRenderer } from './renderer';

export class GlGeometryScene implements GeometryScene {
  readonly kind='geometry' as const;
  readonly descriptor:GeometryDescriptor;
  readonly vertices:WebGLBuffer;
  readonly indices?:WebGLBuffer;
  readonly count:number; readonly revision:number; readonly contentRevision:number;
  retired=false;
  private uploadBytes=0; private retirement?:Promise<void>;
  get deviceEpoch() { return this.renderer.deviceEpoch; }
  get allocationBytes() { return this.descriptor.vertexBytes+this.descriptor.indexBytes; }
  constructor(readonly renderer:GlRenderer,descriptor:GeometryDescriptor) {
    this.descriptor=Object.freeze(validateGeometryDescriptor(descriptor));
    this.count=descriptor.vertexCount; this.revision=descriptor.revision; this.contentRevision=descriptor.contentRevision;
    if(this.count>10_000_000 || descriptor.triangleCount>10_000_000) throw new Error('This PLY geometry exceeds the native preview budget.');
    const {gl}=renderer; const allocated:WebGLBuffer[]=[];
    const buffer=(target:number,bytes:number) => {
      const value=gl.createBuffer(); if(!value) throw new Error('The graphics geometry could not be allocated.');
      allocated.push(value); gl.bindBuffer(target,value); gl.bufferData(target,bytes,gl.STATIC_DRAW); requireGlAllocation(gl,'The graphics geometry'); return value;
    };
    try {
      this.vertices=buffer(gl.ARRAY_BUFFER,descriptor.vertexBytes);
      if(descriptor.kind===2) this.indices=buffer(gl.ELEMENT_ARRAY_BUFFER,descriptor.indexBytes);
    } catch(error) { for(const value of allocated) gl.deleteBuffer(value); throw error; }
  }
  private async upload(buffer:WebGLBuffer|undefined,target:number,first:number,count:number,stride:number,total:number,bytes:ArrayBuffer) {
    this.renderer.requireScene(this);
    if(!buffer || ![first,count].every(Number.isSafeInteger) || first<0 || count<1 || first+count>total || bytes.byteLength>MiB || bytes.byteLength!==checkedBytes(count,stride))
      throw new Error('Invalid readonly PLY geometry upload.');
    const {gl}=this.renderer; gl.bindBuffer(target,buffer); gl.bufferSubData(target,first*stride,new Uint8Array(bytes)); requireGlAllocation(gl,'The geometry upload');
    this.uploadBytes+=bytes.byteLength;
    if(this.uploadBytes>=16*MiB) { await this.renderer.fence(); this.uploadBytes=0; this.renderer.requireScene(this); }
  }
  uploadVertices(first:number,count:number,bytes:ArrayBuffer) { return this.upload(this.vertices,this.renderer.gl.ARRAY_BUFFER,first,count,16,this.count,bytes); }
  uploadIndices(first:number,count:number,bytes:ArrayBuffer) {
    if(bytes.byteLength%4 || new Uint32Array(bytes).some(index=>index>=this.count)) return Promise.reject(new Error('Invalid readonly PLY triangle index.'));
    return this.upload(this.indices,this.renderer.gl.ELEMENT_ARRAY_BUFFER,first,count,4,this.descriptor.triangleCount*3,bytes);
  }
  dispose():Promise<void> {
    if(this.retirement) return this.retirement; this.retired=true;
    return this.retirement=(async () => { try { await this.renderer.finish(); } catch { /* Context lost. */ }
      this.renderer.gl.deleteBuffer(this.vertices); if(this.indices) this.renderer.gl.deleteBuffer(this.indices);
      await this.renderer.releaseGeometryScene(this);
    })();
  }
}
