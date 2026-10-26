import { describe,expect,it } from 'vitest';
import { encodeGaussianFrame,type RenderCamera } from '../src/renderer/frame';
import { IDENTITY_MATRIX, NEUTRAL_COLOR } from '../src/renderer/defaults';
import { halfFloat,queryFragmentAlpha,queryRawColor } from '../src/renderer/webgl2/queryProjection';
import { computePick,computeSurface } from '../src/renderer/webgl2/queryCompute';
import { encodeSurfaceParameters } from '../src/renderer/webgpu/surfaceQuery';

describe('independent native query expectations',()=>{
  const camera:RenderCamera={view:new Float32Array(IDENTITY_MATRIX),projection:new Float32Array([1,0,0,0,0,1,0,0,0,0,-100/99.9,-1,0,0,-10/99.9,0]),eye:new Float32Array(3),revision:0,background:'black'};
  const checkpoint=async()=>{};
  function fixture() {
    const packed=new Float32Array(24);packed.set([0,0,-4,.5,.16,0,0,.16,0,.16],0);packed.set([0,0,-2,.5,.16,0,0,.16,0,.16],12);
    const frame=encodeGaussianFrame({count:2,stride:48,degree:0,duplicateSelectionGuarded:false},camera,NEUTRAL_COLOR,false,IDENTITY_MATRIX,false,3,3).values;
    return {source:{count:2,stride:48,packed},input:{frame,canonical:new Uint8Array(2),transform:new Uint8Array(2),opacity:new Uint8Array(2)}};
  }
  it('preserves half SH values without a normalized Gaussian alpha profile',()=>{
    expect(halfFloat(0x3c00)).toBe(1);expect(halfFloat(0xbc00)).toBe(-1);expect(halfFloat(0x0001)).toBe(2**-24);
    const words=new Uint32Array(12);words[10]=0x3c00;words[11]=0xbc00;
    const rgb=queryRawColor(words,0,[0,0,-2,1],new Float32Array(80));
    expect(rgb).toEqual([Math.fround(.5+Math.fround(.2820947918)),.5,Math.fround(.5-Math.fround(.2820947918))]);
  });
  it('retains the top-left surface quad rule separately from contributor picking',()=>{
    const g=new Float32Array([0,0,2,1,1,0,0,1,.5,.5,.5,.9]);
    expect(queryFragmentAlpha(g,0,0,1,2,2)).toBeGreaterThan(0);expect(queryFragmentAlpha(g,0,1,0,2,2)).toBeGreaterThan(0);
    expect(queryFragmentAlpha(g,0,2,1,2,2)).toBe(0);expect(queryFragmentAlpha(g,0,1,2,2,2)).toBe(0);
    expect(queryFragmentAlpha(g,0,2,1,2,2,false)).toBeGreaterThan(0);
  });
  it('computes analytic center transmission, normalized depth, raw gray and full visibility',async()=>{
    const {source,input}=fixture(),parameters=encodeSurfaceParameters({fullWidth:3,fullHeight:3,width:3,height:3,sourceCount:2,channelFlags:3,dispatchWidth:1,scale:1});
    const map=await computeSurface(source,input,parameters,undefined,async()=>{},checkpoint),depths=new Float32Array(map.depths),opacities=new Float32Array(map.opacities),colors=new Float32Array(map.colors!);
    expect(opacities[4]).toBe(.75);expect(depths[4]).toBe(Math.fround(2/.75));expect(Array.from(colors.slice(12,15))).toEqual([.5,.5,.5]);expect(new Uint32Array(map.visible!)[0]).toBe(3);
    const pick=await computePick(source,input,1.5,1.5,0,checkpoint);expect(pick).toEqual({index:1,depth:Math.fround(2/.75),opacity:.75,contribution:.5});
  });
  it('refuses candidate admission and cancellation before publishing partial arrays',async()=>{
    const {source,input}=fixture(),parameters=encodeSurfaceParameters({fullWidth:3,fullHeight:3,width:3,height:3,sourceCount:2,channelFlags:0,dispatchWidth:1,scale:1});
    await expect(computeSurface(source,input,parameters,1,async()=>{},checkpoint)).rejects.toThrow(/exceeding/);
    await expect(computeSurface(source,input,parameters,undefined,async()=>{throw new Error('refused');},checkpoint)).rejects.toThrow('refused');
    await expect(computeSurface(source,input,parameters,undefined,async()=>{},async()=>{throw new Error('cancelled');})).rejects.toThrow('cancelled');
  });
  it('observes query stages without changing the independent analytic result or returned map bytes',async()=>{
    const {source,input}=fixture(),parameters=encodeSurfaceParameters({fullWidth:3,fullHeight:3,width:3,height:3,sourceCount:2,channelFlags:3,dispatchWidth:1,scale:1});
    const names:string[]=[],plain=await computeSurface(source,input,parameters,undefined,async()=>{},checkpoint);
    const measured=await computeSurface(source,input,parameters,undefined,async()=>{},checkpoint,name=>names.push(name));
    expect(measured).toEqual(plain);
    expect(names).toEqual(['map-projection','map-full-frame-projection','map-count-candidates','map-plan','map-admission','map-scatter-candidates','map-sort-tiles','map-composite','map-visibility']);
    names.length=0;
    expect(await computePick(source,input,1.5,1.5,0,checkpoint,name=>names.push(name))).toEqual({index:1,depth:Math.fround(2/.75),opacity:.75,contribution:.5});
    expect(names).toEqual(['pick-projection','pick-candidates','depth-key-generation','radix-pass-16','pick-composite']);
  });
});
