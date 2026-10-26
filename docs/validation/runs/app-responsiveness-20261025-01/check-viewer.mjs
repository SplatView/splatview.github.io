import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
const root=resolve('docs/validation/runs/app-responsiveness-20261025-01');
const data=JSON.parse(await readFile(resolve(root,'summary.json'),'utf8'));
const browser=await chromium.launch({channel:'chromium',headless:true}),page=await browser.newPage(),errors=[];
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(pathToFileURL(resolve(root,'comparison.html')).href);
  for(const row of data.series) {
    await page.selectOption('#backend',row.backend);await page.selectOption('#gesture',row.gesture);await page.selectOption('#pattern',row.pattern);
    assert((await page.locator('#latency').textContent()).includes(row.inputToCompletion.medianMs.toFixed(2)));
    assert((await page.locator('#latency').textContent()).includes(row.inputToCompletion.p95Ms.toFixed(2)));
    assert((await page.locator('#fenceLabel').textContent()).includes(row.responseFenceWait.medianMs.toFixed(2)));
    assert((await page.locator('#detail').textContent()).includes(String(row.inputs)));
  }
  await page.selectOption('#backend','webgl2');await page.selectOption('#gesture','orbit');await page.selectOption('#pattern','stream');
  assert.deepEqual(errors,[]);
  await page.screenshot({path:resolve('.build/app-responsiveness-20261025-01/viewer.png'),fullPage:true});
  const report={passed:true,browser:browser.version(),scheme:'file:',combinations:data.series.length,errors};
  await writeFile('.build/app-responsiveness-20261025-01/viewer-check.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {await browser.close();}
