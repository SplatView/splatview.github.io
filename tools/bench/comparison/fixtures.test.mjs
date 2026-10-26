import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateScene,cameraFrame,imageError} from './fixtures.mjs';
test('scene generation is deterministic and sparse placement retains the same source values',()=>{
  const dense=generateScene({count:16}),repeat=generateScene({count:16}),sparse=generateScene({count:16,visibleFraction:.25});
  assert.deepEqual(dense,repeat);assert.deepEqual(dense.colors,sparse.colors);assert.deepEqual(dense.scales,sparse.scales);
  for(let i=0;i<16;i++){assert.equal(sparse.positions[i*3],Math.fround(dense.positions[i*3]+(i<4?0:100)));assert.equal(sparse.positions[i*3+2],dense.positions[i*3+2]);}
  assert.throws(()=>generateScene({count:1_000_001}));
});
test('four-record calibration has three known visible RGB points and a zero-opacity pad',()=>{
  const scene=generateScene({count:4,probe:true});assert.equal(scene.opacity[3],0);
  assert.deepEqual([...scene.positions.subarray(0,3)],[Math.fround(-.8),Math.fround(-.15),-4]);
  for(let i=0;i<3;i++)assert(scene.colors[i*3+i]>.8);
});
test('camera poses retain matched focal scales across GL and WebGPU depth conventions',()=>{
  const frame=cameraFrame(640,400,.3);assert.equal(frame.projection[0],1);assert.equal(frame.projection[5],Math.fround(1.6));
  for(const i of [0,5,11,15])assert.equal(frame.projection[i],frame.glProjection[i]);
  const x=frame.view[0],z=frame.view[2];assert(Math.abs(x*x+z*z-1)<1e-6);assert.notEqual(frame.projection[14],frame.glProjection[14]);
});
test('image error reports RGB and foreground separately without treating alpha as color',()=>{
  const reference=new Uint8Array([255,0,0,255,0,0,0,255]),actual=new Uint8Array([0,0,0,0,0,0,0,0]);
  const value=imageError(actual,reference);assert.equal(value.foregroundSamples,3);assert.equal(value.meanAbsoluteRgb,1/6);
  assert.equal(value.maxAbsoluteRgb,1);assert(value.foregroundPsnrDb<value.psnrDb);assert.equal(imageError(reference,reference).psnrDb,999);
  assert.throws(()=>imageError(new Uint8Array(4),reference));
});
