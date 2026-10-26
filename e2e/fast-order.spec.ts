import { expect, test } from '@playwright/test';
import type {} from './fast-order-harness';

for (const degree of [0, 1, 2, 3]) for (const precision of [16, 24, 32] as const) test(`SH${degree} compact ${precision}-bit order keeps IDs and exact query/capture contracts`, async ({ page }, info) => {
  await page.goto('/e2e/fast-order-harness.html'); await page.waitForFunction(() => !!window.fastOrder);
  const value = await page.evaluate(({ degree, precision }) => window.fastOrder.measure(degree, precision), { degree, precision });
  await info.attach('fast-order.json', { body: JSON.stringify(value), contentType: 'application/json' });
  expect(value.fast).toBe(true); expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
  expect(value.actualOrder).toEqual(value.expectedOrder); expect(value.indirectCount).toBe(value.projectedVisible);
  if (precision === 32) expect(value.quality.maxRgb).toBe(0);
  expect(value.pickA.index).toBe(value.pickB.index); expect(value.pickA.depth).toBe(value.pickB.depth);
  expect(value.captureEqual).toBe(true); expect(value.mapEqual).toBe(true); expect(value.visibleEqual).toBe(true); expect(value.colorSorts).toBe(0);
  expect(value.interleaved).toBe(true);
});
for (const visibility of [0, 1]) test(`compact order handles visible fraction ${visibility}`, async ({ page }) => {
  await page.goto('/e2e/fast-order-harness.html'); await page.waitForFunction(() => !!window.fastOrder);
  const value = await page.evaluate(visibility => window.fastOrder.measure(0, 32, visibility), visibility);
  expect(value.fast).toBe(true); expect(value.actualOrder).toEqual(value.expectedOrder); expect(value.quality.maxRgb).toBe(0);
  expect(value.indirectCount).toBe(value.projectedVisible); expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
  if(visibility===1){expect(value.projectedVisible).toBe(262145);expect(value.baseMirrorBytesEqual).toBe(true);}
});
test('refused optional order resources retain exact baseline rendering', async ({ page }) => {
  await page.goto('/e2e/fast-order-harness.html'); await page.waitForFunction(() => !!window.fastOrder);
  const value = await page.evaluate(() => window.fastOrder.measure(0, 32, .25, true));
  expect(value.fast).toBe(false); expect(value.actualOrder).toEqual(value.expectedOrder); expect(value.quality.maxRgb).toBe(0);
  expect(value.captureEqual).toBe(true); expect(value.mapEqual).toBe(true); expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0);
});
for(const precision of [16,24] as const) test(`GL ${precision}-bit display restores exact clean output and retains reusable worker arrays`,async({page})=>{
  await page.goto('/e2e/fast-order-harness.html');await page.waitForFunction(()=>!!window.fastOrder);
  const value=await page.evaluate(precision=>window.fastOrder.workerQuality(precision),precision);
  expect(value.before).toBe(precision);expect(value.after).toBe(32);expect(value.captureEqual).toBe(true);expect(value.mapEqual).toBe(true);
  expect(value.picks[0].index).toBe(value.picks[1].index);expect(value.picks[0].depth).toBe(value.picks[1].depth);
  expect(value.scratch.bytes).toBeGreaterThan(0);expect(value.memory.bytes).toBe(0);
});
for(const precision of [24,32] as const) test(`compact ${precision}-bit order follows atomically replaced canonical and divergent preview masks`,async({page})=>{
  await page.goto('/e2e/fast-order-harness.html');await page.waitForFunction(()=>!!window.fastOrder);
  const value=await page.evaluate(precision=>window.fastOrder.measure(3,precision,.25,false,true),precision);
  expect(value.fast).toBe(true);expect(value.actualOrder).toEqual(value.expectedOrder);expect(value.errors).toEqual([]);
  if(precision===32)expect(value.quality.maxRgb).toBe(0);
  expect(value.captureEqual).toBe(true);expect(value.mapEqual).toBe(true);expect(value.memory.bytes).toBe(0);
});
