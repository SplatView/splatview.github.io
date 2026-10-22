import { expect, test } from '@playwright/test';
import type {} from './geometry-render-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/geometry-render-harness.html');
  await page.waitForFunction(() => Boolean(window.geometryRender || window.geometryRenderError));
  expect(await page.evaluate(() => window.geometryRenderError)).toBeUndefined();
});

for (const nearFirst of [false, true]) {
  test(`point depth keeps the nearer opaque RGB vertex when it is drawn ${nearFirst ? 'first' : 'last'}`, async ({ page }) => {
    const result = await page.evaluate(nearFirst => window.geometryRender.depth('points', nearFirst, false), nearFirst);
    expect(result.center).toEqual([255, 0, 0, 255]); expect(result.background).toEqual([0, 0, 0, 255]);
    expect(result.display.center).toEqual(result.center); expect(result.errors).toEqual([]);
    expect(result.allocationBytes).toBe(32); expect(result.noGaussianBuffers).toBe(true);
    expect(result.depthBytes).toBe(321 * 321 * 4); expect(result.leaseBytes).toBe(result.depthBytes);
  });
  for (const reverseWinding of [false, true]) test(`mesh depth keeps its nearer face ${nearFirst ? 'first' : 'last'} with ${reverseWinding ? 'reverse' : 'forward'} winding`, async ({ page }) => {
    const result = await page.evaluate(({ nearFirst, reverseWinding }) => window.geometryRender.depth('mesh', nearFirst, reverseWinding), { nearFirst, reverseWinding });
    // World-space normal is Z. Frozen native light = .35 + .65*.5/sqrt(.9).
    expect(Math.abs(result.center[0] - 255 * (.35 + .65 * .5 / Math.sqrt(.9)))).toBeLessThanOrEqual(1);
    expect(result.center.slice(1)).toEqual([0, 0, 255]); expect(result.display.center).toEqual(result.center);
    expect(result.allocationBytes).toBe(6 * 16 + 6 * 4); expect(result.noGaussianBuffers).toBe(true);
    expect(result.errors).toEqual([]);
  });
}

for (const axis of ['x', 'y', 'z'] as const) test(`mesh lighting uses the world ${axis} normal across camera rotation`, async ({ page }) => {
  const result = await page.evaluate(axis => window.geometryRender.meshOrientation(axis), axis);
  const component = axis === 'x' ? .4 : axis === 'y' ? .7 : .5;
  const expected = 255 * (.35 + .65 * component / Math.sqrt(.9));
  for (const channel of result.center.slice(0, 3)) expect(Math.abs(channel - expected)).toBeLessThanOrEqual(1);
  expect(result.center[3]).toBe(255); expect(result.display.center).toEqual(result.center); expect(result.errors).toEqual([]);
});

for (const deviceScaleFactor of [1, 2]) test.describe(`geometry framebuffer pixels at DPR ${deviceScaleFactor}`, () => {
  test.use({ deviceScaleFactor });
  for (const size of [161, 321, 961]) test(`circular unlit points retain native radius on a ${size}px framebuffer`, async ({ page }) => {
    const result = await page.evaluate(size => window.geometryRender.pointSize(size, 'black'), size);
    const color = [37, 129, 211, 255], background = [0, 0, 0, 255];
    expect(result.width).toBe(size); expect(result.height).toBe(size); expect(result.center).toEqual(color);
    expect(result.offsets[1]).toEqual(color); // One pixel from the center is inside every native radius.
    expect(result.offsets[2]).toEqual(size === 161 ? background : color);
    expect(result.offsets[3]).toEqual(size === 161 ? background : color);
    expect(result.offsets[4]).toEqual(size === 961 ? color : background);
    expect(result.offsets[5]).toEqual(size === 961 ? color : background);
    expect(result.offsets[6]).toEqual(background); expect(result.offsets[7]).toEqual(background);
    expect(result.display).toEqual({ width: result.width, height: result.height, center: result.center,
      background: result.background, offsets: result.offsets });
    expect(result.errors).toEqual([]);
  });
});

for (const background of ['black', 'gray', 'white'] as const) test(`viewport and clean geometry capture share the ${background} background and raw RGB`, async ({ page }) => {
  const result = await page.evaluate(background => window.geometryRender.pointSize(321, background), background);
  const shade = background === 'black' ? 0 : background === 'gray' ? 127.5 : 255;
  for (const channel of result.background.slice(0, 3)) expect(Math.abs(channel - shade)).toBeLessThanOrEqual(1);
  expect(result.background[3]).toBe(255); expect(result.center).toEqual([37, 129, 211, 255]);
  expect(result.display).toEqual({ width: result.width, height: result.height, center: result.center,
    background: result.background, offsets: result.offsets });
  expect(result.errors).toEqual([]);
});

test('geometry upload/query guards and resized depth leases survive until the actual retirement fence', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryRender.allocationAndRetirement());
  expect(result.failures).toHaveLength(9);
  expect(result.failures.slice(0, 6).every(failure => /Invalid readonly PLY/.test(failure))).toBe(true);
  expect(result.failures.slice(6).every(failure => /Gaussian splats only/.test(failure))).toBe(true);
  expect(result.duringResize).toBe((161 * 161 + 321 * 321) * 4); expect(result.duringDispose).toBe(result.duringResize);
  expect(result.after).toBe(0); expect(result.depthAfter).toBe(0); expect(result.retired).toBe(true);
  expect(result.retiredUpload).toMatch(/obsolete graphics device or allocation/); expect(result.errors).toEqual([]);
});

test('refused geometry target admission retains the preceding usable target and releases its final lease', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryRender.refusedDepth());
  expect(result.refusal).toMatch(/Injected target admission refusal/); expect(result.before).toBe(161 * 161 * 4);
  expect(result.retained.depthBytes).toBe(result.before); expect(result.retained.leaseBytes).toBe(result.before);
  expect(result.retained.center).toEqual([100, 150, 200, 255]); expect(result.after).toBe(0); expect(result.errors).toEqual([]);
});

test('render resize rejects an invalid GPU target before publication and retains its preceding usable depth', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryRender.rejectedResize());
  expect(result.failure).toMatch(/usage/i); expect(result.reported).toHaveLength(1); expect(result.reported[0]).toMatch(/usage/i);
  expect(result.allocations).toBe(1); expect(result.requestedFrames).toBe(1);
  expect(result.failedBytes).toBe(result.before); expect(result.failedDepthBytes).toBe(result.before);
  expect(result.retained.depthBytes).toBe(161 * 161 * 4); expect(result.retained.center).toEqual([100, 150, 200, 255]);
  expect(result.recovered.depthBytes).toBe(321 * 321 * 4); expect(result.recovered.center).toEqual([100, 150, 200, 255]);
  expect(result.resized.depthBytes).toBe(481 * 481 * 4); expect(result.resized.center).toEqual([100, 150, 200, 255]);
  expect(result.after).toBe(0); expect(result.depthAfter).toBe(0); expect(result.errors).toEqual([]);
});

test('rapid A to B to A resize retires the obsolete preparation without replacing the usable target', async ({ page }) => {
  const result = await page.evaluate(() => window.geometryRender.supersededResize());
  expect(result.during).toBe((161 * 161 + 321 * 321) * 4); expect(result.requestedFrames).toBe(0);
  expect(result.retained.depthBytes).toBe(161 * 161 * 4); expect(result.retained.leaseBytes).toBe(result.retained.depthBytes);
  expect(result.retained.center).toEqual([100, 150, 200, 255]);
  expect(result.after).toBe(0); expect(result.depthAfter).toBe(0); expect(result.errors).toEqual([]);
});
