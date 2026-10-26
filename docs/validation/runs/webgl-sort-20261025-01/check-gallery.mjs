import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
const root=resolve('docs/validation/runs/webgl-sort-20261025-01');
const images=JSON.parse(await readFile(resolve(root,'images.json'),'utf8'));
const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(pathToFileURL(resolve(root,'comparison.html')).href);
  for(const image of images) {
    await page.selectOption('#scene',image.fixture);
    await page.selectOption('#bits',image.variant.split('-').at(-1));
    await page.selectOption('#phase',image.phase);
    await page.selectOption('#pose',String(image.index));
    await page.waitForFunction(path=>{
      const image=document.querySelector('#image');
      return image.getAttribute('src')===path && image.complete && image.naturalWidth===640 && image.naturalHeight===400;
    },image.sharedPng);
    assert((await page.locator('#sha').textContent()).includes(image.sha256));
    assert((await page.locator('#metric').textContent()).includes('lower'));
  }
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve('.build/webgl-sort-20261025-01/gallery.png'),fullPage:true});
  const report={passed:true,browser:browser.version(),scheme:'file:',combinations:images.length,errors};
  await writeFile('.build/webgl-sort-20261025-01/gallery-check.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {await browser.close();}
