import { expect,test } from '@playwright/test';
import type {} from './webgl-harness';

test.beforeEach(async ({page}) => {
  await page.goto('/e2e/webgl-harness.html');
  await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
});
for(const degree of [0,1,2,3]) for(const reverse of [false,true]) test(`sorted native Gaussian parity degree=${degree}, reverse=${reverse}`,async ({page},info) => {
  const result=await page.evaluate(({degree,reverse})=>window.webglHarness.baseline(degree,reverse),{degree,reverse});
  await info.attach('webgl-render-evidence',{body:JSON.stringify({result,environment:await page.evaluate(()=>window.webglHarness.environment)}),contentType:'application/json'});
  expect(result.errors).toEqual([]); expect(result.glError).toBe(0);
  // Quantized framebuffer blending may differ by a byte per layer.
  expect(result.sorted.max).toBeLessThanOrEqual(3); expect(result.sorted.mse).toBeLessThan(1);
  expect(result.graded.max).toBeLessThanOrEqual(3); expect(result.graded.mse).toBeLessThan(1);
  expect(result.captureStable.max).toBe(0); expect(result.sequence).toBeGreaterThan(0); expect(result.afterCapture).toBe(result.sequence);
  expect(result.top).not.toEqual(result.bottom);
});
test('WebGL2 startup and capture do not require navigator.gpu',async ({page}) => {
  await page.addInitScript(()=>Object.defineProperty(Navigator.prototype,'gpu',{get:()=>undefined,configurable:true}));
  await page.reload(); await page.waitForFunction(()=>window.webglHarness || window.webglHarnessError);
  expect(await page.evaluate(()=>window.webglHarnessError)).toBeUndefined();
  const result=await page.evaluate(()=>window.webglHarness.contextOnly());
  expect(result.backend).toBe('webgl2'); expect(result.nonzero).toBe(true); expect(result.errors).toEqual([]); expect(result.credits).toBe(0);
});
test('continuous camera input submits coherent frames without worker starvation',async ({page}) => {
  const result=await page.evaluate(()=>window.webglHarness.navigation()); expect(result.errors).toEqual([]); expect(result.sequence).toBeGreaterThan(2); expect(result.credits).toBe(0);
});
for(const kind of [1,2] as const) test(`readonly PLY rendering and capture preserve native geometry kind=${kind}`,async({page})=>{
  const result=await page.evaluate(kind=>window.webglHarness.geometry(kind),kind);expect(result).toMatchObject({displayError:0,foreground:true,errors:[],glError:0,credits:0});expect(result.max).toBeLessThanOrEqual(1);
});
