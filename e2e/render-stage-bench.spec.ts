import { expect, test } from '@playwright/test';
import type {} from './backend-bench-harness';

for(const backend of ['webgpu','webgl2'] as const) for(let repetition=0;repetition<3;repetition++) {
  test(`${backend} stage attribution repetition ${repetition+1}`,async({page},info)=>{
    test.setTimeout(240000);
    await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
    await page.waitForFunction(()=>window.backendBench?.ready());
    await page.getByRole('button',{name:'Open example',exact:true}).click();
    await expect(page).toHaveTitle('Bench example.sog — SplatView');
    const value=await page.evaluate(()=>window.backendBench.measure(1,1,{frames:120,width:320,height:200,stages:true}));
    await info.attach('renderer-stage-attribution.json',{body:JSON.stringify({repetition,...value}),contentType:'application/json'});
    expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
    for(const mode of value.modes) {
      expect(mode.frameCompletionMs.samples).toHaveLength(120);expect(mode.fixedFrameCompletionMs?.samples).toHaveLength(120);
      expect(mode.motionProfile?.pendingTimers).toBe(0);expect(mode.fixedProfile?.pendingTimers).toBe(0);
      if(backend==='webgl2') {
        const events=mode.queryProfile?.work as {action:string;stages?:{name:string;wallMs:number}[]}[];
        const pick=events.find(event=>event.action==='pick')!,map=events.find(event=>event.action==='surface')!;
        expect(pick.stages?.map(stage=>stage.name)).toContain('pick-projection');
        expect(pick.stages?.map(stage=>stage.name)).toContain('pick-composite');
        expect(map.stages?.map(stage=>stage.name)).toEqual(['map-projection','map-full-frame-projection','map-count-candidates','map-plan','map-admission','map-scatter-candidates','map-sort-tiles','map-composite','map-visibility']);
        if(mode.mode==='steady' && mode.motionProfile?.timerStatus.startsWith('available')) {
          for(const name of ['sample','history','resolve','composite']) expect(mode.motionProfile.stageGpuMs[name]?.length).toBe(120);
        }
        expect(mode.motionProfile?.stageCpuMs['fence-wall']?.length).toBeGreaterThanOrEqual(120);
      } else {
        expect(mode.motionProfile?.stageCpuMs['Project Gaussians']?.length).toBe(120);
        expect(mode.motionProfile?.timerStatus).toContain('unavailable');
      }
    }
  });
}
