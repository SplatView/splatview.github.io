import { expect, test, type Page } from '@playwright/test';
import type {} from './histogram-harness';
import type {} from './geometry-viewer-harness';
import type { RenderedHistogram } from '../src/renderer/histogram';
import { queuePly } from './queue-fixture';

type Sample = Awaited<ReturnType<Window['histogramHarness']['solids']>>[number];
function expectFramebuffer(sample: Omit<Sample, 'background'>, width: number, height: number) {
  expect(sample.width).toBe(Math.min(width, 256)); expect(sample.height).toBe(Math.min(height, 144));
  expect(sample.bins).toHaveLength(768); expect(sample.bins).toEqual(sample.oracle);
  for (let channel = 0; channel < 3; channel++) expect(sample.bins.slice(channel * 256, (channel + 1) * 256).reduce((a, b) => a + b, 0)).toBe(sample.width * sample.height);
}
async function app(page: Page, bytes?: Uint8Array) {
  await page.goto('/e2e/geometry-viewer-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.geometryViewer?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  if (bytes) {
    await page.getByLabel('Open scene files').setInputFiles({ name: 'histogram-history.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
    await expect.poll(() => page.evaluate(() => {
      const state = window.geometryViewer.histogramState(), controller = window.geometryViewer.controllerForSourceNavigation();
      return { sourceName: state.sourceName, busy: state.busy, loaded: !!controller.client && !!controller.scene };
    })).toEqual({ sourceName: 'histogram-history.ply', busy: false, loaded: true });
  }
  else await page.evaluate(() => window.geometryViewer.load('gaussian'));
}
const chart = (page: Page) => page.getByRole('img', { name: 'Rendered RGB (log scale)', exact: true });
async function histogram(page: Page) {
  let observed: (Omit<RenderedHistogram, 'bins'> & { bins: number[] }) | null = null;
  await expect.poll(async () => {
    observed = await page.evaluate(() => {
      const state = window.geometryViewer.histogramState(), renderer = window.geometryViewer.controllerForSourceNavigation().renderer;
      return state.histogram && state.histogram.deviceEpoch === renderer?.deviceEpoch ? state.histogram : null;
    });
    return observed !== null;
  }).toBe(true);
  const result = observed!;
  // React may briefly retain an earlier frame attribute while a reset is already authoritative in the store.
  await expect(chart(page)).toHaveAttribute('data-frame', String(result.frame));
  return result;
}
async function content(page: Page) {
  return page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation(), client = controller.client!, snapshot = await window.geometryViewer.snapshot();
    const nativeRecords: number[][] = []; let nativeMasks: number[] = [];
    await client.stream(async (_first, _count, bytes) => { nativeRecords.push(Array.from(new Uint8Array(bytes))); }, bytes => { nativeMasks = Array.from(new Uint8Array(bytes)); });
    // Histogram GPU allocations are allowed to differ. Every scene datum and executable history endpoint is observed independently.
    return { nativeRecords, nativeMasks, gpuMasks: snapshot.gpuMasks, exported: snapshot.exported, capture: snapshot.capture,
      camera: snapshot.camera, background: snapshot.background, dirty: snapshot.dirty, sourceFingerprint: snapshot.sourceFingerprint,
      summary: { count: snapshot.summary.count, visible: snapshot.summary.visible, selected: snapshot.summary.selected,
        canUndo: snapshot.summary.canUndo, canRedo: snapshot.summary.canRedo, contentRevision: snapshot.summary.contentRevision } };
  });
}

test.describe('Desktop rendered RGB histogram through real WebGPU', () => {
  test.beforeEach(async ({ page }) => { await page.goto('/e2e/histogram-harness.html'); await page.waitForFunction(() => !!window.histogramHarness); });
  for (const [width, height] of [[1, 1], [7, 3], [321, 241], [513, 289]]) test(`solid backgrounds use exact desktop center sampling at ${width}×${height}`, async ({ page }) => {
    const samples = await page.evaluate(([w, h]) => window.histogramHarness.solids(w, h), [width, height]);
    for (const sample of samples) {
      expectFramebuffer(sample, width, height);
      if (sample.background === 'gray') {
        sample.center.forEach(channel => expect(Math.abs(channel - 127.5)).toBeLessThanOrEqual(1));
        expect(sample.center).toEqual(Array(3).fill(sample.center[0]));
      } else expect(sample.center).toEqual(Array(3).fill(sample.background === 'black' ? 0 : 255));
      // Clear-value UNORM midpoint conversion can select 127 or 128. The independent
      // displayed pixel establishes that bucket; all 768 bins must still match the CPU oracle exactly.
      for (let channel = 0; channel < 3; channel++) expect(sample.bins.slice(channel * 256, (channel + 1) * 256))
        .toEqual(Array.from({ length: 256 }, (_, index) => index === sample.center[channel] ? Math.min(width, 256) * Math.min(height, 144) : 0));
    }
  });
  for (const [width, height] of [[17, 13], [321, 241]]) test(`composited pixels, selection highlight, live grade and deletion drive bins at ${width}×${height}`, async ({ page }) => {
    const result = await page.evaluate(([w, h]) => window.histogramHarness.composition(w, h), [width, height]);
    for (const sample of [result.plain, result.selected, result.graded, result.deleted]) expectFramebuffer(sample, width, height);
    // At the exact middle of an odd target both coincident layers have no Gaussian falloff.
    const center = [.1 * .6 + .8 * .4 * .4, .4 * .6 + .2 * .4 * .4, .8 * .6 + .1 * .4 * .4].map(value => (value + .5 * .6 * .4) * 255);
    result.plain.center.forEach((value, index) => expect(Math.abs(value - center[index])).toBeLessThanOrEqual(2));
    expect(result.selected.bins).not.toEqual(result.plain.bins); expect(result.graded.bins).not.toEqual(result.selected.bins);
    expect(result.deleted.bins).not.toEqual(result.graded.bins); expect(result.capturePreserved).toBe(true); expect(result.error).toBeNull();
  });
  test('rapid changed views sample at most 5 Hz, publish the final dirty view and stop when idle', async ({ page }) => {
    const result = await page.evaluate(() => window.histogramHarness.throttle());
    expect(result.starts.length).toBeGreaterThanOrEqual(2);
    // Observe actual optional compute-encoder creation, excluding GPU queue/map latency.
    for (let i = 1; i < result.starts.length; i++) expect(result.starts[i] - result.starts[i - 1]).toBeGreaterThanOrEqual(195);
    expect(result.maximum).toBe(1); expect(result.active).toBe(0); expect(result.finalBins).toEqual(result.oracleBins);
    expect(result.framesAfterIdle).toBe(result.frames);
  });
});

test('native selected/visible stats and the 54 px histogram stay pinned in Basic', async ({ page }) => {
  // Below 481px app.css deliberately scrolls the whole panel instead of pinning
  // the summary; the pinned contract applies to the next shortest viewports.
  await page.setViewportSize({ width: 640, height: 500 }); await app(page);
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await histogram(page);
  const tools = page.getByRole('complementary', { name: 'Tools', exact: true }), stats = tools.locator('.model-stats'), body = tools.locator('.tools-body');
  await expect(stats).toHaveText('0/3 splats | SH0');
  await page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation();
    await controller.command({ command: 'single', index: 0 }); await controller.command({ command: 'delete' });
    await controller.command({ command: 'single', index: 1 });
  });
  await expect(stats).toHaveText('1/2 splats | SH0');
  // web-lite has no Pro mode.
  {
    const bounds = (await chart(page).boundingBox())!; expect(bounds.height).toBe(54);
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    const before = { chart: await chart(page).boundingBox(), stats: await stats.boundingBox(), header: await tools.locator('.panel-heading').boundingBox() };
    await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await body.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    expect({ chart: await chart(page).boundingBox(), stats: await stats.boundingBox(), header: await tools.locator('.panel-heading').boundingBox() }).toEqual(before);
    await expect(chart(page)).toBeInViewport(); await expect(stats).toHaveText('1/2 splats | SH0');
    await body.evaluate(element => { element.scrollTop = 0; });
  }
});

test('histogram observation and offscreen capture preserve packed records, masks, view and executable Redo', async ({ page }) => {
  await app(page, queuePly());
  await page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation();
    const { useApp } = await import(/* @vite-ignore */ performance.getEntriesByType('resource').map(entry => entry.name)
      .find(name => new URL(name).pathname === '/src/app/store.ts') ?? new URL('../src/app/store.ts', location.href).href) as typeof import('../src/app/store');
    for (const command of [{ command: 'single', index: 1 }, { command: 'delete' }, { command: 'single', index: 2 },
      { command: 'grade', values: [1.2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
      { command: 'grade', values: [1.5, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }, { command: 'undo' }]) {
      // A selection change queues a short automatic pivot query that owns busy;
      // require the editor to stay idle across a pause before the next edit.
      const ready = () => !useApp.getState().busy && !useApp.getState().transformPivotPending;
      const started = performance.now();
      while ((!ready() || (await new Promise(resolve => setTimeout(resolve, 50)), !ready())) && performance.now() - started < 10_000)
        await new Promise(resolve => setTimeout(resolve, 20));
      if (!await controller.command(command)) throw new Error(`Histogram history fixture refused ${command.command}.`);
    }
    controller.camera!.orbit(11, -7); controller.cycleBackground(); controller.invalidate();
  });
  const before = await content(page); expect(before.summary).toMatchObject({ visible: 4, selected: 1, canUndo: true, canRedo: true }); expect(before.dirty).toBe(true);
  expect(await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().command({ command: 'redo' }))).toBe(true);
  const redo = await content(page);
  expect(await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().command({ command: 'undo' }))).toBe(true);
  // Undo advances contentRevision while restoring content; capture the resulting actual endpoint.
  const endpoint = await content(page); const { contentRevision: _revision, ...beforeSummary } = before.summary;
  const { contentRevision: _endpointRevision, ...endpointSummary } = endpoint.summary; expect(endpointSummary).toEqual(beforeSummary);
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await histogram(page);
  expect(await content(page)).toEqual(endpoint);
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await expect(chart(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Tools', exact: true }).click(); await histogram(page);
  expect(await content(page)).toEqual(endpoint);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  const redone = await content(page); const { contentRevision: _redoRevision, ...redoSummary } = redo.summary;
  const { contentRevision: _redoneRevision, ...redoneSummary } = redone.summary;
  expect(redoneSummary).toEqual(redoSummary); expect({ ...redone, summary: null }).toEqual({ ...redo, summary: null });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const action of ['hide', 'close', 'replace', 'recover'] as const) test(`pending histogram mapping cannot publish after ${action} and observation does not create an idle loop`, async ({ page }) => {
  await app(page);
  await page.evaluate(async () => {
    const path = '/e2e/histogram-harness.ts', module = await import(path), controller = window.geometryViewer.controllerForSourceNavigation();
    window.histogramGate = module.holdNextHistogram(controller.renderer!, controller.scene);
  });
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await page.evaluate(() => window.histogramGate!.entered);
  const oldEpoch = await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().renderer!.deviceEpoch);
  // Additional displayed frames cannot create another in-flight histogram map.
  await page.evaluate(() => { const controller = window.geometryViewer.controllerForSourceNavigation(); for (let i = 0; i < 5; i++) controller.invalidate(); });
  if (action === 'hide') await page.getByRole('button', { name: 'Tools', exact: true }).click();
  else if (action === 'close') await page.evaluate(() => window.geometryViewer.controllerForSourceNavigation().closeScene());
  else if (action === 'replace') await page.evaluate(() => window.geometryViewer.load('gaussian'));
  else {
    await page.evaluate(async () => { const controller = window.geometryViewer.controllerForSourceNavigation(); controller.renderer!.device.destroy(); await controller.renderer!.device.lost; });
    await page.evaluate(() => { void window.geometryViewer.controllerForSourceNavigation().retryRenderer(); });
  }
  const afterAction = await page.evaluate(() => window.geometryViewer.histogramState().histogram);
  if (action === 'recover') expect(afterAction?.deviceEpoch).not.toBe(oldEpoch);
  else expect(afterAction).toBeNull();
  const pending = await page.evaluate(() => window.histogramGate!.counts()); expect(pending.maximum).toBe(1); expect(pending.maps).toBe(1);
  await page.evaluate(() => window.histogramGate!.release());
  if (action === 'hide' || action === 'close') {
    await expect.poll(() => page.evaluate(() => window.histogramGate!.counts().active)).toBe(0);
    expect(await page.evaluate(() => window.geometryViewer.histogramState().histogram)).toBeNull();
    await expect(chart(page)).toHaveCount(action === 'hide' ? 0 : 1);
  } else {
    const current = await histogram(page); expect(current).not.toBeNull();
    if (action === 'recover') { expect(current!.deviceEpoch).not.toBe(oldEpoch); await expect(page.getByRole('alert')).toHaveCount(0); }
  }
  expect(await page.evaluate(() => window.histogramGate!.counts().stalePublications)).toBe(0);
  await page.evaluate(() => window.histogramGate!.restore());
  // Let only the requested dirty-frame/throttle tail settle, then count real display submissions.
  await expect.poll(() => page.evaluate(() => window.histogramGate!.counts().active)).toBe(0);
  const settled = await page.evaluate(async () => {
    const controller = window.geometryViewer.controllerForSourceNavigation();
    await new Promise(resolve => setTimeout(resolve, 350)); const frames = controller.renderer!.frames;
    await new Promise(resolve => setTimeout(resolve, 450)); return { frames, after: controller.renderer!.frames };
  });
  expect(settled.after).toBe(settled.frames);
});
