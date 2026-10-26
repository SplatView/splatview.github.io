import { expect, test } from '@playwright/test';
import type {} from './backend-bench-harness';

// Every repetition creates a fresh browser context, App, worker and renderer.
const cases = [
  { name: 'base', multiplier: 1, dpr: 1, width: 320, height: 200, degree: 3 },
  { name: 'count', multiplier: 2, dpr: 1, width: 320, height: 200, degree: 3 },
  { name: 'SH0', multiplier: 1, dpr: 1, width: 320, height: 200, degree: 0 },
  { name: 'resolution', multiplier: 1, dpr: 1, width: 640, height: 400, degree: 3 },
  { name: 'DPR2', multiplier: 1, dpr: 2, width: 320, height: 200, degree: 3 },
] as const;
for (const backend of ['webgpu', 'webgl2'] as const) for (const fixture of cases) for (let repetition = 0; repetition < 3; repetition++) {
  test.describe(`${backend} ${fixture.name} repetition ${repetition + 1}`, () => {
    test.use({ deviceScaleFactor: fixture.dpr });
    test('records 120 motion and 120 fixed frames per mode', async ({ page }, info) => {
      test.setTimeout(240000);
      await page.goto(`/e2e/backend-bench-harness.html?graphics=${backend}`);
      await page.waitForFunction(() => window.backendBench?.ready());
      await page.getByRole('button', { name: 'Open example', exact: true }).click();
      await expect(page).toHaveTitle('Bench example.sog — SplatView');
      const value = await page.evaluate(fixture => window.backendBench.measure(fixture.multiplier, fixture.dpr,
        { frames: 120, width: fixture.width, height: fixture.height, degree: fixture.degree }), fixture);
      await info.attach('rendering-profile.json', { body: JSON.stringify({ repetition, fixture: fixture.name, ...value }), contentType: 'application/json' });
      expect(value.errors).toEqual([]); expect(value.memory.bytes).toBe(0); expect(value.memory.allocations).toBe(0);
      for (const mode of value.modes) {
        expect(mode.frameCompletionMs.samples).toHaveLength(120);
        expect(mode.fixedFrameCompletionMs?.samples).toHaveLength(120);
        expect(mode.afterQueries).toEqual(mode.beforeQueries);
        expect(mode.afterQueryDisplaySequence).toBe(mode.displaySequence);
        expect(mode.motionProfile?.pendingTimers).toBe(0);
        expect(mode.fixedProfile?.pendingTimers).toBe(0);
        if(backend==='webgpu') expect(mode.queryProfile?.counts['Pick countCandidates']).toBe(1);
        if(backend==='webgl2') {
          expect(mode.queryProfile?.counts.renderbufferStorage??0).toBe(0);
          expect(mode.fixedProfile?.work.filter(event=>(event as {action:string}).action==='sort')).toHaveLength(0);
          expect(mode.fixedProfile?.counts.texSubImage2D??0).toBe(0);
        } else {
          expect(mode.fixedProfile?.counts['Stable depth sort']??0).toBe(0);
          expect(mode.fixedProfile?.counts['Project Gaussians']??0).toBe(0);
        }
      }
    });
  });
}
