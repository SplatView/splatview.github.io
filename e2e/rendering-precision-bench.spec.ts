import { expect, test } from '@playwright/test';
import type {} from './backend-bench-harness';

for(const backend of ['webgpu','webgl2'] as const) for(const multiplier of [1,2] as const) for(let repetition=0;repetition<3;repetition++) {
  test(`${backend} ${multiplier}x 24-bit display repetition ${repetition+1}`,async({page},info)=>{
    test.setTimeout(240000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`); await page.waitForFunction(()=>window.backendBench?.ready());
    await page.getByRole('button',{name:'Open example',exact:true}).click(); await expect(page).toHaveTitle('Bench example.sog — SplatView');
    const value=await page.evaluate(({multiplier,repetition})=>window.backendBench.measure(multiplier,1,
      {frames:120,width:320,height:200,degree:3,sortPrecision:24,quality:repetition===0}),{multiplier,repetition});
    await info.attach('precision-profile.json',{body:JSON.stringify({repetition,...value}),contentType:'application/json'});
    expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
    for(const mode of value.modes) {expect(mode.frameCompletionMs.samples).toHaveLength(120);expect(mode.afterQueries).toEqual(mode.beforeQueries);}
    if(repetition===0) {
      expect(value.displayQuality).toHaveLength(8);
      for(const quality of value.displayQuality) {expect(quality.actualBits).toBe(24);expect(quality.psnr).toBeGreaterThanOrEqual(40);expect(quality.meanAbsoluteRgb).toBeLessThanOrEqual(.002);}
    }
  });
}
