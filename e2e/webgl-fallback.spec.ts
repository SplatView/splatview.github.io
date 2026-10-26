import { expect,test } from '@playwright/test';
import type {} from './webgl-harness';
test.beforeEach(async({page})=>{
  await page.goto('/e2e/webgl-harness.html');await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
});
for(const stage of ['adapter','presentation','float','mrt'] as const) test(`backend refusal and fallback preserve actual canvas ownership after ${stage} failure`,async({page})=>{
  const result=await page.evaluate(stage=>window.webglHarness.factoryFailure(stage),stage);
  expect(result.backend).toBe('webgl2');expect(result.sortedWhilePreparing).toBe(true);expect(result.foreground).toBe(true);expect(result.replacements).toBe(stage==='presentation'?1:0);
  if(stage==='adapter'||stage==='presentation') {expect(result.fallback).toBeTruthy();expect(result.status.status).toBe('steady');}
  else {expect(result.fallback).toBeUndefined();expect(result.status.status).toBe('unavailable');expect(result.status.allocationBytes).toBe(0);}
});
