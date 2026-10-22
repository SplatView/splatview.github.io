import { expect, test } from '@playwright/test';
import type {} from './surface-harness';

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/surface-harness.html');
  await page.waitForFunction(() => Boolean(window.surfaceHarness || window.surfaceHarnessError));
  expect(await page.evaluate(() => window.surfaceHarnessError)).toBeUndefined();
});

for (const channel of ['colorBase', 'transformBase', 'opacityBase'] as const) for (const downsampled of [false, true]) {
  test(`frozen ${channel} targets match an independent selection oracle with downsampled=${downsampled}`, async ({ page }) => {
    const result = await page.evaluate(({ channel, downsampled }) => window.surfaceHarness.frozenPreviewTargets(channel, downsampled), { channel, downsampled });
    expect(result.errors).toEqual([]); expect(result.frames).toHaveLength(2);
    for (const frame of result.frames) {
      expect(frame.projectionError).toBe(0); expect(frame.orderError).toBe(0);
      expect(frame.surfaceError).toBe(0); expect(frame.visibleError).toBe(0); expect(frame.imageError).toBe(0);
      expect(frame.controlImageDifference).toBeGreaterThan(0); expect(frame.packedStates).toEqual([1, 1, 0, 2]);
      expect(frame.pick).toEqual(frame.oraclePick);
    }
    expect(result.clearImageError).toBe(0); expect(result.after).toBe(result.before);
    expect(result.retirementBytes).toBe(16); expect(result.retiredBuffers).toBe(1);
    expect(result.usage.bytes).toBe(0); expect(result.usage.allocations).toBe(0);
  });
}

test('FP32 surface uses composited depth and opacity, keeps empty pixels and releases retained ownership', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ layers: [{ z: 1, opacity: .8 }, { z: 0, opacity: .5 }], samples: [[32, 24], [0, 0], [64, 48]] }));
  expect(result.errors).toEqual([]); expect(result.features).not.toContain('float32-blendable');
  expect(result.samples[0].opacity).toBeCloseTo(.9, 6);
  expect(result.samples[0].depth).toBeCloseTo((3 * .5 + 4 * .4) / .9, 5);
  for (const sample of result.samples.slice(1)) expect(sample).toMatchObject({ depth: 0, opacity: 0 });
  expect(result.allFinite).toBe(true); expect(result.disposedRejected).toBe(true);
  expect(result.retained.bytes).toBe(result.width * result.height * 8); expect(result.retained.allocations).toBe(1);
  expect(result.released.bytes).toBe(0); expect(result.released.allocations).toBe(0);
});

test('surface excludes deleted, clipped and sub-cutoff splats including partial edge tiles', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ layers: [{ z: 0, opacity: .8 }, { z: -4, opacity: 1 },
    { z: -2.99999, opacity: 1 }, { z: 2000, opacity: 1 }, { z: 0, opacity: .0038 }], masks: [2, 0, 0, 0, 0], samples: [[32, 24], [64, 48]] }));
  expect(result.errors).toEqual([]); expect(result.nonempty).toBe(0); expect(result.allFinite).toBe(true);
  for (const sample of result.samples) expect(sample).toMatchObject({ depth: 0, opacity: 0 });
});

test('native surface integrates faint rear contributions after transmission drops below 1e-5', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ radius: 1000, layers: [
    { z: 0, opacity: .99 }, { z: 0, opacity: .99 }, { z: 0, opacity: .99 }, { z: 9997, opacity: .99 }] }));
  let transmission = 1, opacity = 0, depth = 0;
  for (const z of [3, 3, 3, 10000]) { const weight = transmission * .99; depth += z * weight; opacity += weight; transmission *= .01; }
  expect(result.errors).toEqual([]); expect(result.samples[0].depth).toBeCloseTo(depth / opacity, 4);
  expect(result.samples[0].depth).toBeGreaterThan(3.009); expect(result.samples[0].opacity).toBeCloseTo(1, 6);
});

test('bounded map uses native floored focal dimensions and scalar support scale with partial tiles', async ({ page }) => {
  const fullWidth = 1025, fullHeight = 769, scale = Math.sqrt(262144 / (fullWidth * fullHeight));
  const width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale), sample: [number, number] = [Math.floor(width / 2) + 3, Math.floor(height / 2) + 2];
  const result = await page.evaluate(({ sample }) => window.surfaceHarness.sample({ width: 1025, height: 769,
    layers: [{ z: 0, opacity: .8, covariance: [.04, .012, 0, .01, 0, .01] }], samples: [sample, [0, 0], [589, 442]] }), { sample });
  const focal = fullHeight / 2 / Math.tan(Math.PI / 8), fx = focal * width / fullWidth, fy = focal * height / fullHeight;
  const a = .04 * (fx / 3) ** 2 + .3 * scale ** 2, b = .012 * fx * fy / 9, c = .01 * (fy / 3) ** 2 + .3 * scale ** 2;
  const x = sample[0] + .5 - width / 2, y = sample[1] + .5 - height / 2;
  const radius = (c * x * x - 2 * b * x * y + a * y * y) / (a * c - b * b);
  expect(result.errors).toEqual([]); expect(result.width).toBe(width); expect(result.height).toBe(height);
  expect(width * height).toBeLessThanOrEqual(262144); expect(result.allFinite).toBe(true);
  expect(result.samples[0].opacity).toBeCloseTo(.8 * Math.exp(-.5 * radius), 5); expect(result.samples[0].depth).toBeCloseTo(3, 5);
  for (const value of result.samples.slice(1)) expect(value).toMatchObject({ opacity: 0, depth: 0 });
  const pixels = width * height, tiles = Math.ceil(width / 16) * Math.ceil(height / 16);
  // One-source depth-only map: no minimum padding in occupied tile spans.
  // Count/layout CPU views, uploads and GPU buffers are explicitly admitted,
  // alongside map/readback, dummy channels and the bounded native projection.
  expect(result.capacity).toBe(1); expect(result.candidateEntries).toBe(result.occupiedTiles);
  expect(result.candidateAllocations).toEqual([result.candidateBytes]);
  expect(result.candidateBytes).toBe(result.occupiedTiles * 4);
  expect(result.retained.peakBytes).toBe(pixels * 8 + result.candidateBytes + tiles * 36 + pixels * 16 + 16 + 48 + 16 + 144);
});

test('native bounded projection includes off-axis anisotropic covariance and raw optional channels', async ({ page }) => {
  const fullWidth = 1025, fullHeight = 769, scale = Math.sqrt(262144 / (fullWidth * fullHeight));
  const width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale), focal = fullHeight / 2 / Math.tan(Math.PI / 8);
  const fx = focal * width / fullWidth, fy = focal * height / fullHeight, worldX = .4, worldY = -.3;
  const center = [width / 2 + worldX * fx / 3, height / 2 + worldY * fy / 3];
  const sample: [number, number] = [Math.floor(center[0]) + 3, Math.floor(center[1]) + 2];
  const result = await page.evaluate(({ sample }) => window.surfaceHarness.sample({ width: 1025, height: 769, colors: true, visible: true,
    layers: [{ x: .4, y: -.3, z: 0, opacity: .8, covariance: [.003, .0008, .0004, .002, -.0003, .004], coefficients: [1, -1, 0] }], samples: [sample] }), { sample });
  const covariance = [[.003, .0008, .0004], [.0008, .002, -.0003], [.0004, -.0003, .004]];
  const jx = [fx / 3, 0, -worldX * fx / 9], jy = [0, fy / 3, -worldY * fy / 9];
  const product = (u: number[], v: number[]) => u.reduce((sum, value, i) => sum + value * covariance[i].reduce((total, c, j) => total + c * v[j], 0), 0);
  const a = product(jx, jx) + .3 * scale ** 2, b = product(jx, jy), c = product(jy, jy) + .3 * scale ** 2;
  const x = sample[0] + .5 - center[0], y = sample[1] + .5 - center[1], radius = (c * x * x - 2 * b * x * y + a * y * y) / (a * c - b * b);
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeCloseTo(.8 * Math.exp(-.5 * radius), 5);
  expect(result.samples[0].depth).toBeCloseTo(3, 5); expect(result.visible).toEqual([1]);
  const expected = [.5 + .2820947918, .5 - .2820947918, .5];
  for (let c = 0; c < 3; c++) expect(result.samples[0].color![c]).toBeCloseTo(expected[c], 5);
  expect(result.retained.bytes).toBe(width * height * 20 + 4);
});

test('native scalar low-pass keeps an alpha-cutoff boundary that scaled full-frame axes incorrectly discard', async ({ page }) => {
  const fullWidth = 1025, fullHeight = 769, scale = Math.sqrt(262144 / (fullWidth * fullHeight));
  const width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale), focal = fullHeight / 2 / Math.tan(Math.PI / 8);
  const fx = focal * width / fullWidth, fy = focal * height / fullHeight;
  const radius = .5 / (.3 * scale ** 2), opacity = Math.exp(.5 * radius) / 255 * 1.0005;
  const result = await page.evaluate(({ x, y, opacity }) => window.surfaceHarness.sample({ width: 1025, height: 769,
    layers: [{ x, y, z: 0, opacity, covariance: [1e-12, 0, 0, 1e-12, 0, 1e-12] }], samples: [[295, 221]] }), { x: -.5 * 3 / fx, y: -.5 * 3 / fy, opacity });
  const wrongRadius = .25 / (.3 * (width / fullWidth) ** 2) + .25 / (.3 * (height / fullHeight) ** 2);
  expect(opacity * Math.exp(-.5 * wrongRadius)).toBeLessThan(1 / 255);
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeGreaterThanOrEqual(1 / 255);
  expect(result.samples[0].opacity).toBeCloseTo(1.0005 / 255, 6); expect(result.samples[0].depth).toBeCloseTo(3, 5);
});

test('native downsampled eigenvalue floor and scalar axis cap survive extreme anisotropy', async ({ page }) => {
  const fullWidth = 1025, fullHeight = 769, scale = Math.sqrt(262144 / (fullWidth * fullHeight));
  const width = Math.floor(fullWidth * scale), height = Math.floor(fullHeight * scale), focal = fullHeight / 2 / Math.tan(Math.PI / 8);
  const fy = focal * height / fullHeight, localY = 2.5, offset = .1 * scale * localY;
  const result = await page.evaluate(y => window.surfaceHarness.sample({ width: 1025, height: 769,
    layers: [{ x: 0, y, z: 0, opacity: .99, covariance: [1e8, 0, 0, 1e-12, 0, 1e-12] }], samples: [[295, 221]] }), -offset * 3 / fy);
  const expected = .99 * Math.exp(-.5 * localY ** 2), wrong = .99 * Math.exp(-.5 * (localY * scale / (height / fullHeight)) ** 2);
  expect(Math.abs(expected - wrong)).toBeGreaterThan(.0002);
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeCloseTo(expected, 4); expect(result.samples[0].depth).toBeCloseTo(3, 5);
  expect(result.retained.bytes).toBe(width * height * 8); expect(result.released.bytes).toBe(0);
});

test('count planning admits one compact candidate list and preserves every contributor', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ initial: 1, maximum: 32,
    layers: Array.from({ length: 17 }, (_, i) => ({ z: i * .01, opacity: .1 })) }));
  let transmission = 1, depth = 0, opacity = 0;
  for (let i = 0; i < 17; i++) { const weight = transmission * .1; depth += (3 + i * .01) * weight; opacity += weight; transmission *= .9; }
  expect(result.errors).toEqual([]); expect(result.attempts).toBe(1); expect(result.capacity).toBe(32);
  expect(result.candidateAllocations).toEqual([result.candidateBytes]);
  expect(result.samples[0].opacity).toBeCloseTo(opacity, 5); expect(result.samples[0].depth).toBeCloseTo(depth / opacity, 5);
  expect(result.released.bytes).toBe(0);
});

test('tile rank sorting crosses workgroup lanes and padded candidate capacity', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ initial: 1, maximum: 1024,
    layers: Array.from({ length: 513 }, (_, i) => ({ z: (512 - i) * .001, opacity: .01 })) }));
  let transmission = 1, depth = 0, opacity = 0;
  for (let i = 0; i < 513; i++) { const weight = transmission * .01; depth += (3 + i * .001) * weight; opacity += weight; transmission *= .99; }
  expect(result.errors).toEqual([]); expect(result.attempts).toBe(1); expect(result.capacity).toBe(1024);
  expect(result.candidateAllocations).toEqual([result.candidateBytes]);
  expect(result.samples[0].opacity).toBeCloseTo(opacity, 5); expect(result.samples[0].depth).toBeCloseTo(depth / opacity, 4);
  expect(result.released.bytes).toBe(0);
});

test('rotated offscreen footprints reach a nonempty one-pixel partial tile at the viewport edge', async ({ page }) => {
  const focal = 49 / 2 / Math.tan(Math.PI / 8);
  const worldX = (70 - 32.5) * 3 / focal, worldY = 24 * 3 / focal;
  const result = await page.evaluate(({ x, y }) => window.surfaceHarness.sample({ layers: [{ z: 0, opacity: .8, x, y,
    covariance: [.16, .12, 0, .16, 0, .01] }], visible: true, samples: [[64, 48], [0, 0]] }), { x: worldX, y: worldY });
  // Off-center perspective also projects Z variance into the screen axes.
  const factor = (focal / 3) ** 2;
  const a = (.16 + .01 * (worldX / 3) ** 2) * factor + .3;
  const c = (.16 + .01 * (worldY / 3) ** 2) * factor + .3;
  const b = (.12 + .01 * worldX * worldY / 9) * factor;
  const radius = c * 5.5 ** 2 / (a * c - b * b);
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeCloseTo(.8 * Math.exp(-.5 * radius), 5);
  expect(result.samples[0].depth).toBeCloseTo(3, 5); expect(result.samples[1]).toMatchObject({ depth: 0, opacity: 0 });
  expect(result.visible).toEqual([1]);
});

test('raw RGB uses the same layered composition, normalized opacity and empty background', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ colors: true, layers: [
    { z: 1, opacity: .8, coefficients: [-1, -1, 1] }, { z: 0, opacity: .5, coefficients: [1, -1, -1] }], samples: [[32, 24], [0, 0]] }));
  const high = .5 + .2820947918, low = .5 - .2820947918;
  const expected = [(high * .5 + low * .4) / .9, low, (low * .5 + high * .4) / .9];
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeCloseTo(.9, 6);
  for (let c = 0; c < 3; c++) expect(result.samples[0].color![c]).toBeCloseTo(expected[c], 5);
  expect(result.samples[1].color).toEqual([0, 0, 0]); expect(result.allFinite).toBe(true);
  expect(result.retained.bytes).toBe(result.width * result.height * 20); expect(result.released.bytes).toBe(0);
});

test('disconnected color islands retain raw HDR normalization and channel clamping', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.sample({ colors: true, layers: [
    { x: -1, z: 0, opacity: .8, covariance: [.0025, 0, 0, .0025, 0, .0025], coefficients: [4, -4, 0] },
    { x: 1, z: 0, opacity: .8, covariance: [.0025, 0, 0, .0025, 0, .0025], coefficients: [-1, -1, 1] }], samples: [[13, 24], [32, 24], [52, 24]] }));
  expect(result.errors).toEqual([]); expect(result.samples[0].color).toEqual([1, 0, .5]);
  expect(result.samples[1].color).toEqual([0, 0, 0]); expect(result.samples[1].opacity).toBe(0);
  const expected = [.5 - .2820947918, .5 - .2820947918, .5 + .2820947918];
  for (let c = 0; c < 3; c++) expect(result.samples[2].color![c]).toBeCloseTo(expected[c], 5);
});

test('raw color maps stay independent of display grading and selected highlights', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const fixture = { colors: true, masks: [1], layers: [{ z: 0, opacity: .8, coefficients: [1, -1, .5] }] };
    const plain = await window.surfaceHarness.sample(fixture);
    const graded = await window.surfaceHarness.sample({ ...fixture, selectedOnly: true,
      grade: [4, 1.5, .75, 1.5, 1.2, .4, -.3, .2, -.2, .1, 45, .2, -30, .15, 120] });
    return { plain, graded };
  });
  expect(result.plain.errors).toEqual([]); expect(result.graded.errors).toEqual([]);
  expect(result.graded.samples).toEqual(result.plain.samples);
});

test('raw degree-three SH follows the selected geometry preview and transformed view direction', async ({ page }) => {
  const result = await page.evaluate(() => {
    const coefficients = new Array<number>(48).fill(0); coefficients[9] = 1; coefficients[47] = .5;
    return window.surfaceHarness.sample({ colors: true, degree: 3, masks: [1], selectedOnly: true,
      geometry: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, .5, 0, 0, 1], layers: [{ z: 0, opacity: .8, coefficients }], samples: [[42, 24]] });
  });
  const x = .5 / Math.hypot(.5, 3), expected = [.5 - .4886025119 * x, .5, .5 - .5900435899 * x ** 3 * .5];
  expect(result.errors).toEqual([]); expect(result.samples[0].opacity).toBeGreaterThan(0);
  for (let c = 0; c < 3; c++) expect(result.samples[0].color![c]).toBeCloseTo(expected[c], 5);
});

test('visibility retains the contributing layer, rejects fully hidden depth and transforms covariance margins', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const front = { z: 0, opacity: .99, covariance: [.25, 0, 0, .25, 0, .000001] as [number, number, number, number, number, number] };
    const back = { z: 1, opacity: .8, covariance: [.0025, 0, 0, .0025, 0, .01] as [number, number, number, number, number, number] };
    const hidden = await window.surfaceHarness.sample({ visible: true, layers: [front, back] });
    const contributing = await window.surfaceHarness.sample({ visible: true, layers: [front, { ...back, z: .2 }] });
    const transformed = await window.surfaceHarness.sample({ visible: true, layers: [front, back], masks: [0, 1], selectedOnly: true,
      geometry: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 0, 0, -3, 1] });
    return { hidden, contributing, transformed };
  });
  expect(result.hidden.errors).toEqual([]); expect(result.contributing.errors).toEqual([]); expect(result.transformed.errors).toEqual([]);
  expect(result.hidden.visible).toEqual([1]); expect(result.contributing.visible).toEqual([3]); expect(result.transformed.visible).toEqual([3]);
});

test('full framebuffer visibility keeps a thin DPR-two splat absent from every bounded surface sample', async ({ page }) => {
  const focal = 512 / Math.tan(Math.PI / 8), position = (100.5 - 512) * 3 / focal;
  const result = await page.evaluate(position => window.surfaceHarness.sample({ visible: true, width: 1024, height: 1024, cssWidth: 512, cssHeight: 512,
    layers: [{ x: position, y: position, z: 0, opacity: .004, covariance: [1e-12, 0, 0, 1e-12, 0, 1e-12] }], samples: [[50, 50]] }), position);
  expect(result.errors).toEqual([]); expect(result.width).toBe(512); expect(result.height).toBe(512);
  expect(result.nonempty).toBe(0); expect(result.samples[0].opacity).toBe(0); expect(result.visible).toEqual([1]);
  expect(result.retained.bytes).toBe(512 * 512 * 8 + 4); expect(result.released.bytes).toBe(0);
});

test('visibility source bits cross word boundaries, preserve sparse IDs and zero deleted/tail bits', async ({ page }) => {
  const result = await page.evaluate(() => {
    const active = new Set([0, 31, 32, 63, 64]);
    return window.surfaceHarness.sample({ visible: true, masks: Array.from({ length: 65 }, (_, i) => i === 32 ? 2 : 0),
      layers: Array.from({ length: 65 }, (_, i) => ({ z: 0, opacity: active.has(i) ? .8 : 0 })) });
  });
  expect(result.errors).toEqual([]); expect(result.visible).toEqual([0x80000001, 0x80000000, 1]);
});

test('full-frame visibility observes exact native top-left quad edge equality', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.visibilityEdges());
  expect(result.errors).toEqual([]); expect(result.results).toEqual({ left: 1, right: 0, top: 1, bottom: 0, inside: 1 });
});

for (const kind of ['overflow', 'admission', 'retry-admission', 'camera', 'viewport', 'mask', 'loss', 'cancel', 'allocation'] as const) {
  test(`surface ${kind === 'retry-admission' ? 'compact-candidate admission' : kind} refusal retires scratch and releases its reservation`, async ({ page }) => {
    const result = await page.evaluate(kind => window.surfaceHarness.failure(kind), kind);
    expect(result.accepted).toBe(false); expect(result.after.bytes).toBe(0); expect(result.after.allocations).toBe(0);
    if (kind === 'overflow') { expect(result.overflow).toBe(true); expect(result.required).toBe(17); expect(result.admittedCapacity).toBe(8); }
    if (kind === 'admission') expect(result.allocations).toBe(0);
    if (kind === 'retry-admission') expect(result.resizeDenied).toBe(true);
    if (['camera', 'viewport', 'mask', 'loss'].includes(kind)) expect(result.stale).toBe(true);
    if (kind === 'cancel') expect(result.aborted).toBe(true);
    if (['camera', 'viewport', 'mask', 'loss', 'cancel'].includes(kind)) expect(result.peakAtGate).toBeGreaterThan(0);
    expect(result.destroyed).toBe(result.allocations);
    if (kind === 'allocation') expect(result.message).toMatch(/usage|buffer/i);
    if (kind !== 'loss') expect(result.errors).toEqual([]);
  });
}

test('retained maps reject changed source deletion and keep their lease until disposed', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.retainedStale());
  expect(result.errors).toEqual([]); expect(result.rejected).toBe(true); expect(result.retained.bytes).toBeGreaterThan(0);
  expect(result.released.bytes).toBe(0); expect(result.released.allocations).toBe(0);
});

for (const kind of ['overflow', 'admission', 'retry-admission', 'camera', 'viewport', 'mask', 'loss', 'cancel', 'allocation', 'color-readback', 'visibility-readback'] as const) {
  test(`optional color and visibility ${kind === 'retry-admission' ? 'compact-candidate admission' : kind} failure retires every channel allocation`, async ({ page }) => {
    const result = await page.evaluate(kind => window.surfaceHarness.failure(kind, true), kind);
    expect(result.accepted).toBe(false); expect(result.after.bytes).toBe(0); expect(result.after.allocations).toBe(0);
    expect(result.destroyed).toBe(result.allocations);
    if (kind === 'overflow') expect(result.overflow).toBe(true);
    if (kind === 'admission') expect(result.allocations).toBe(0);
    if (kind === 'retry-admission') expect(result.resizeDenied).toBe(true);
    if (['camera', 'viewport', 'mask', 'loss', 'color-readback', 'visibility-readback'].includes(kind)) expect(result.stale).toBe(true);
    if (kind === 'cancel') expect(result.aborted).toBe(true);
    if (kind !== 'loss') expect(result.errors).toEqual([]);
  });
}

test('retained RGB and visibility leases match their CPU channels and release together', async ({ page }) => {
  const result = await page.evaluate(() => window.surfaceHarness.retainedStale(true));
  expect(result.errors).toEqual([]); expect(result.rejected).toBe(true); expect(result.retained.bytes).toBe(result.expected);
  expect(result.released.bytes).toBe(0); expect(result.released.allocations).toBe(0);
});

for (const channels of [false, true]) for (const selectedGeometry of [false, true]) {
  test(`surface ${channels ? 'RGB/visibility' : 'depth/opacity'} ${selectedGeometry ? 'rejects selected geometry changes' : 'reuses ordinary selection and display-only changes'} during readback`, async ({ page }) => {
    const result = await page.evaluate(({ channels, selectedGeometry }) => window.surfaceHarness.selectedReuse(channels, selectedGeometry), { channels, selectedGeometry });
    expect(result.accepted).toBe(!selectedGeometry); expect(result.retainedValid).toBe(!selectedGeometry);
    expect(result.stale).toBe(selectedGeometry); expect(result.errors).toEqual([]);
    if (!selectedGeometry) expect(result.retained.bytes).toBeGreaterThan(0);
    expect(result.released.bytes).toBe(0); expect(result.released.allocations).toBe(0);
  });
}
