import {expect,test} from '@playwright/test';
import type {} from './geometry-viewer-harness';

for(const backend of ['webgpu','webgl2'] as const)test(`${backend} App uses 24-bit motion, refines to exact 32-bit rest, and sleeps`,async({page},info)=>{
  await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
  await page.waitForFunction(()=>window.geometryViewer?.ready());
  await page.getByRole('button',{name:'Open example',exact:true}).click();
  await expect(page).toHaveTitle('Bench example.sog — SplatView');
  await page.waitForTimeout(500);
  await page.evaluate(()=>{
    const app=window.geometryViewer.controllerForRendererNavigation(),r=app.renderer!,render=r.render.bind(r);
    const rows:{precision:number;revision:number;sequence:number}[]=[];
    (window as unknown as {displayPolicyRows:typeof rows}).displayPolicyRows=rows;
    r.render=(...args)=>{
      const precision=r.displaySortPrecision,revision=args[1].revision,record=()=>rows.push({precision,revision,sequence:r.frameSubmissionSequence});
      const pending=render(...args);if(pending)return pending.then(()=>{record();});record();
    };
  });
  const box=await page.locator('canvas').first().boundingBox();if(!box)throw new Error('The App canvas is unavailable.');
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  for(let i=0;i<12;i++)await page.mouse.wheel(0,i%2?-2:2);
  await expect.poll(()=>page.evaluate(()=>window.geometryViewer.controllerForRendererNavigation().renderer!.displaySortPrecision)).toBe(32);
  await page.waitForTimeout(600);
  const value=await page.evaluate(()=>{
    const app=window.geometryViewer.controllerForRendererNavigation();
    return{rows:(window as unknown as {displayPolicyRows:{precision:number;revision:number;sequence:number}[]}).displayPolicyRows,
      sequence:app.renderer!.frameSubmissionSequence,precision:app.renderer!.displaySortPrecision};
  });
  expect(value.rows.some(row=>row.precision===24)).toBe(true);expect(value.rows.at(-1)?.precision).toBe(32);
  await page.waitForTimeout(350);
  expect(await page.evaluate(()=>window.geometryViewer.controllerForRendererNavigation().renderer!.frameSubmissionSequence)).toBe(value.sequence);
  await info.attach('app-display-policy.json',{body:JSON.stringify({backend,...value}),contentType:'application/json'});
});
