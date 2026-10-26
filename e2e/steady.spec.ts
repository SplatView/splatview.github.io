import { expect,test } from '@playwright/test';
import type {} from './steady-harness';

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/steady-harness.html');
  await page.waitForFunction(() => window.steadyHarness || window.steadyHarnessError);
  expect(await page.evaluate(() => window.steadyHarnessError)).toBeUndefined();
});
for(const reverse of [false,true]) for(const white of [false,true]) test(`resampling converges with reverse=${reverse}, white=${white}, preserving exact queries/capture`,async ({page},info) => {
  const result=await page.evaluate(({reverse,white}) => window.steadyHarness.quality(reverse,white),{reverse,white});
  await info.attach('rendering-evidence',{body:JSON.stringify({result,environment:await page.evaluate(() => window.steadyHarness.environment)}),contentType:'application/json'});
  expect(result.errors).toEqual([]); expect(result.skipsSort).toBe(true); expect(result.lazySort).toBe(true);
  expect(result.refinedError).toBeLessThan(result.firstError*.2); expect(result.refinedError).toBeLessThan(12);
  expect(result.retainedError).toBe(0); expect(result.captureError).toBe(0); expect(result.noMoreRequests).toBe(true);
  expect(result.pick).toEqual(result.lazyPick); expect(result.converged.restFrames).toBe(256);
  expect(result.afterCapture.frame).toBe(result.converged.frame);
});
test('motion and every display dependency restart convergence while exact surface maps remain usable',async ({page}) => {
  const result=await page.evaluate(() => window.steadyHarness.dependencies());
  expect(result.errors).toEqual([]); expect(result.surfaceFinite).toBe(true);
  for(const change of result.changes) expect(change.restFrames,change.kind).toBe(0);
});
test('resize retires memory, admission refusal falls back once and selecting again restores SteadySplats',async ({page}) => {
  const result=await page.evaluate(() => window.steadyHarness.lifecycle());
  expect(result.errors).toEqual([]); expect(result.initial).toBe(65*49*136+65536+240);
  expect(result.resized).toBe(81*63*136+65536+240); expect(result.attempts).toBe(1);
  expect(result.refused).toMatchObject({status:'unavailable',allocationBytes:0}); expect(result.fallbackError).toBe(0);
  expect(result.restored).toBe('steady'); expect(result.released.bytes).toBe(0); expect(result.released.allocations).toBe(0);
});
test('empty samples preserve background and unsupported projection releases resources with automatic restoration',async ({page}) => {
  const result=await page.evaluate(() => window.steadyHarness.unsupportedAndEmpty());
  expect(result.errors).toEqual([]); expect(result.emptyWhite).toBe(true);
  expect(result.unsupported.status).toBe('unavailable'); expect(result.restored).toBe('steady');
});
for(const dispose of [false,true]) test(`pending initialization retains credits and refuses stale publication after dispose=${dispose}`,async ({page}) => {
  const result=await page.evaluate(dispose => window.steadyHarness.pendingPublication(dispose),dispose);
  expect(result.errors).toEqual([]); expect(result.preparing).toBe('preparing'); expect(result.admitted).toBeGreaterThan(0);
  expect(result.heldUntilRetirement).toBe(true); expect(result.final).toMatchObject({status:'sorted',allocationBytes:0,valid:false});
});
test('zero history weight preserves spatial sampling and fixed samples stop refinement',async ({page}) => {
  const result=await page.evaluate(() => window.steadyHarness.spatialControls());
  expect(result.errors).toEqual([]); expect(result.animatedError).toBeGreaterThan(0); expect(result.fixedError).toBeLessThan(.1);
  expect(result.zeroWeight).toMatchObject({restFrames:0,requests:0}); expect(result.fixed.restFrames).toBe(0);
});
test('actual device loss retires all optional memory',async ({page}) => {
  const result=await page.evaluate(() => window.steadyHarness.loss());
  expect(result.errors).toEqual([]); expect(result.admitted).toBeGreaterThan(0); expect(result.losses).toBe(1); expect(result.released).toBe(0);
});
