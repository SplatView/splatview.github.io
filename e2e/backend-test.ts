import { test as base } from '@playwright/test';
export { expect } from '@playwright/test';
export type { Page, TestInfo, Locator } from '@playwright/test';

/** Run the same public App journeys with a real session backend selection. */
export const test=base.extend({
  page:async({page},use)=>{
    const backend=process.env.SPLATVIEW_TEST_BACKEND;
    if(backend && backend!=='webgpu' && backend!=='webgl2') throw new Error('Invalid browser-test backend.');
    if(backend) await page.addInitScript(value=>{
      const url=new URL(location.href);
      if(url.protocol==='http:' || url.protocol==='https:') { url.searchParams.set('graphics',value); history.replaceState(null,'',url); }
    },backend);
    await use(page);
  },
});
