import { expect,test } from '@playwright/test';
import type {} from './webgl-harness';
import { halfFloat } from '../src/renderer/webgl2/queryProjection';

test.beforeEach(async ({page})=>{
  await page.goto('/e2e/webgl-harness.html'); await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
});
for(const white of [false,true]) for(const reverse of [false,true]) test(`GL SteadySplats converges with white=${white}, reverse=${reverse}`,async ({page},info)=>{
  const result=await page.evaluate(({white,reverse})=>window.webglHarness.steadyQuality(white,reverse),{white,reverse});
  await info.attach('webgl-steady-evidence',{body:JSON.stringify({result,environment:await page.evaluate(()=>window.webglHarness.environment)}),contentType:'application/json'});
  expect(result.errors).toEqual([]); expect(result.glError).toBe(0); expect(result.sorts).toBe(0);
  expect(result.refinedError).toBeLessThan(result.firstError*.2); expect(result.refinedError).toBeLessThan(12);
  expect(result.settled).toMatchObject({status:'steady',frame:257,restFrames:256,valid:true});
  expect(result.cachedState).toEqual(result.settled); expect(result.afterCapture).toEqual(result.settled);
  expect(result.cachedError).toBe(0); expect(result.captureError).toBe(0); expect(result.noIdleRequests).toBe(true); expect(result.credits).toBe(0);
});
test('GL frame state keeps WebGPU default sample counts, invalidation and idle controls',async ({page})=>{
  const result=await page.evaluate(()=>window.webglHarness.steadyState()); expect(result.errors).toEqual([]); expect(result.glError).toBe(0);
  expect(result.settled).toMatchObject({frame:17,restFrames:16,valid:true}); expect(result.motion).toMatchObject({frame:18,restFrames:0,valid:true});
  expect(result.stopped.restFrames).toBe(1); expect(result.masks).toMatchObject({frame:20,restFrames:0});
  for(const control of result.controls) { expect(control.state).toMatchObject({frame:2,restFrames:0}); expect(control.requests).toBe(0); }
  expect(result.credits).toBe(0);
});
test('GL optional targets resize, suspend, restore and refuse admission only once',async ({page})=>{
  const result=await page.evaluate(()=>window.webglHarness.steadyLifecycle()); expect(result.errors).toEqual([]); expect(result.glError).toBe(0);
  expect(result.initial.allocationBytes).toBe(65*49*224+65536+240); expect(result.resized.allocationBytes).toBe(81*63*224+65536+240);
  expect(result.unsupported.status).toBe('unavailable'); expect(result.restored.status).toBe('steady'); expect(result.failed).toMatchObject({status:'unavailable',allocationBytes:0});
  expect(result.attempts).toBe(1); expect(result.fallbackError).toBe(0); expect(result.credits).toBe(0);
});
test('scripted GL FIFO preserves full source IDs, duplicate/empty samples and previous-generation ratios',async({page})=>{
  const result=await page.evaluate(()=>window.webglHarness.scriptedFifo());expect(result.error).toBe(0);
  const ids=result.trace.map(row=>row.entries.map(entry=>entry[0]));
  expect(ids).toEqual([[16777217,0,0,0],[8,16777217,0,0],[8,16777217,0,0],[8,16777217,0,0],[9,8,16777217,0],[10,9,8,16777217],[11,10,9,8]]);
  expect(result.trace[2].entries).toEqual(result.trace[1].entries);expect(result.trace[3].entries).toEqual(result.trace[2].entries);
  // At canonical (0,0), alpha=.5 and each adjacent alpha=.5*exp(-.5).
  // Check actual backend packing before using that separately decoded half
  // in the analytic four-occluder expectation.
  expect(result.trace[0].entries[0][2]).toBe(result.gpuPacked);
  const ratio=halfFloat(result.gpuPacked&65535),expected=Math.exp(-.5)*ratio**4;
  for(const value of result.weights) expect(value).toBeCloseTo(expected,5);
});
