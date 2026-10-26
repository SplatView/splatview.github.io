import { expect,test } from '@playwright/test';
import type {} from './webgl-harness';
test('GL histogram samples the actual displayed image and tracks SteadySplats progress',async({page})=>{
  await page.goto('/e2e/webgl-harness.html');await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
  const result=await page.evaluate(()=>window.webglHarness.histogram());
  expect(result).toMatchObject({exact:true,unavailable:0,credits:0,errors:[],glError:0});expect(result.steadyFrame).toBeGreaterThan(1);expect(result.after.frame).toBeGreaterThan(0);
});
