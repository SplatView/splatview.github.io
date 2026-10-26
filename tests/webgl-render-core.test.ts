import { describe,expect,it } from 'vitest';
import { linearTextureLayout,planGlScene,textureUploadSpans } from '../src/renderer/webgl2/sceneLayout';
import { floatDepthKey,stableDepthOrder } from '../src/renderer/webgl2/radix';
import { encodeGaussianFrame } from '../src/renderer/frame';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import type { RenderCamera } from '../src/renderer/frame';

describe('GL data layout admission',() => {
  it('charges padded physical textures and the retained worker mirror',() => {
    const plan=planGlScene(3000,3,16384); expect(plan.stride).toBe(136);
    expect(plan.bytes).toBe(plan.words.width*plan.words.height*4+plan.states.width*plan.states.height*16+plan.order.width*plan.order.height*4+3000*137);
    expect(()=>planGlScene(3_000_000,3,1024)).toThrow(/texture limit/);
  });
  it('splits a partial SH3 record and full rows without rewriting neighbors',() => {
    const layout=linearTextureLayout(100,4,16,16),spans=textureUploadSpans(13,56,layout);
    expect(spans).toEqual([{x:13,y:0,width:3,height:1,offset:0,entries:3},{x:0,y:1,width:16,height:3,offset:3,entries:48},{x:0,y:4,width:5,height:1,offset:51,entries:5}]);
    expect(()=>textureUploadSpans(90,11,layout)).toThrow();
  });
});
describe('canonical frame and native sort',() => {
  const camera:RenderCamera={view:new Float32Array(IDENTITY_MATRIX),projection:new Float32Array(IDENTITY_MATRIX),eye:new Float32Array([1,2,3]),revision:0,background:'black'};
  const scene={count:5,stride:136,degree:3,duplicateSelectionGuarded:true};
  it('encodes native flags and half-independent previews in the unchanged 320-byte block',() => {
    const frame=encodeGaussianFrame(scene,camera,NEUTRAL_COLOR,true,IDENTITY_MATRIX,true,640,480,true,.6,true);
    expect(frame.values.byteLength).toBe(320); expect(Array.from(frame.words.slice(40,44))).toEqual([5,34,0,1]);
    expect(Array.from(frame.words.slice(76))).toEqual([0,0,2,3]); expect(frame.values[59]).toBe(Math.fround(.6)); expect(frame.geometryKey.endsWith(':false')).toBe(true);
    expect(Array.from(frame.values.slice(36,40))).toEqual([640,480,320,240]);
  });
  it('uses monotonically ordered signed float keys',() => {
    const values=[-100,-3,-2,-.1,-0,0,.1,100];
    expect(values.map(floatDepthKey)).toEqual(values.map(floatDepthKey).toSorted((a,b)=>a-b));
  });
  it('keeps source tie order and sorts captured scoped geometry at f32 precision',async () => {
    const packed=new Float32Array(5*34); [-2,-4,-2,-1,-4].forEach((depth,i)=>packed.set([i,0,depth],i*34));
    const frame=encodeGaussianFrame(scene,camera,NEUTRAL_COLOR,false,IDENTITY_MATRIX,false,10,10).values;
    const checkpoint=async()=>{};
    expect(Array.from(await stableDepthOrder(packed,5,34,frame,new Uint8Array(5),checkpoint))).toEqual([1,4,0,2,3]);
    const geometry=[...IDENTITY_MATRIX]; geometry[14]=-4;
    const scoped=encodeGaussianFrame(scene,camera,NEUTRAL_COLOR,false,geometry,false,10,10,true).values;
    expect(Array.from(await stableDepthOrder(packed,5,34,scoped,new Uint8Array([0,0,1,0,0]),checkpoint))).toEqual([2,1,4,0,3]);
  });
  it('joins cancellation at a worker checkpoint',async () => {
    const frame=encodeGaussianFrame(scene,camera,NEUTRAL_COLOR,false,IDENTITY_MATRIX,false,10,10).values;
    await expect(stableDepthOrder(new Float32Array(5*34),5,34,frame,new Uint8Array(5),async()=>{throw new Error('cancel');})).rejects.toThrow('cancel');
  });
});
