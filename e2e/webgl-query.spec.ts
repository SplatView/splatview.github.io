import { expect,test } from '@playwright/test';
import type {} from './webgl-harness';
test.beforeEach(async ({page})=>{
  await page.goto('/e2e/webgl-harness.html'); await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
});
for(const degree of [0,1,2,3]) for(const scoped of [false,true]) test(`exact GL queries match native GPU kernels degree=${degree}, scoped=${scoped}`,async ({page},info)=>{
  const result=await page.evaluate(({degree,scoped})=>window.webglHarness.queryParity(degree,false,scoped),{degree,scoped});
  await info.attach('query-evidence',{body:JSON.stringify(result),contentType:'application/json'});
  expect(result.errors).toEqual([]); expect(result.glError).toBe(0); expect(result.depths.max).toBeLessThan(1e-4); expect(result.depths.different).toBe(0);
  expect(result.opacities.max).toBeLessThan(2e-5); expect(result.colors.max).toBeLessThan(3e-5); expect(result.visible).toEqual(result.referenceVisible);
  for(const pick of result.picks) { expect(pick.gl.index).toBe(pick.gpu.index); expect(pick.gl.depth).toBeCloseTo(pick.gpu.depth,4); expect(pick.gl.opacity).toBeCloseTo(pick.gpu.opacity,5); expect(pick.gl.contribution).toBeCloseTo(pick.gpu.contribution,5); }
});
test('downsampled map projection preserves separate full-frame source visibility',async ({page})=>{
  const result=await page.evaluate(()=>window.webglHarness.queryParity(3,true,true)); expect(result.errors).toEqual([]);
  expect(result.dimensions[0]*result.dimensions[1]).toBeLessThanOrEqual(262144); expect(result.depths.max).toBeLessThan(1e-4); expect(result.depths.different).toBe(0);
  expect(result.opacities.max).toBeLessThan(2e-5); expect(result.colors.max).toBeLessThan(3e-5); expect(result.visible).toEqual(result.referenceVisible);
});
test('raw map dependencies, admission and cancellation retain the same owners',async ({page})=>{
  const result=await page.evaluate(()=>window.webglHarness.queryOwnership()); expect(result).toMatchObject({gradeRetained:true,selectionRetained:true,sourceRejected:true,cancelled:true,refused:true,credits:0,errors:[]});
});
