import { expect, test, type Page } from '@playwright/test';
import { polygonBaselineIds, polygonCenterIds, polygonPly, polygonPositions, polygonTouchedIds } from './polygon-fixture';
import { chooseSelectionTool } from './selectTool';
import type {} from './polygon-harness';

const bytes = polygonPly(), masks = (ids: readonly number[]) => polygonPositions.map((_, id) => Number(ids.includes(id)));
type Snapshot = Awaited<ReturnType<Window['polygonApp']['snapshot']>>;
function exact(value: Snapshot, ids: number[]) {
  expect(value.gpu).toEqual(masks(ids)); expect(value.ids).toEqual(ids); expect(value.summary.selected).toBe(ids.length);
  expect(value.nativeMasks.map(mask => mask & 1)).toEqual(masks(ids));
}
async function snapshot(page: Page) { return page.evaluate(() => window.polygonApp.snapshot()); }
async function evidence(page: Page) {
  return page.evaluate(() => ({ traffic: window.polygonApp.traffic, candidates: window.polygonApp.candidates,
    state: window.polygonApp.controller.polygonSelectionState }));
}
async function open(page: Page, mode: 'basic' | 'pro' = 'basic', live = false, overlap = false, other?: { live: boolean; overlap: boolean }) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'polygon-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('polygon-sh0.ply — SplatView');
  // A programmatic file chooser does not produce the pointer activity that a
  // user supplies before opening chrome that may have faded during loading.
  await page.mouse.move(640, 400);
  await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Polygon');
  await page.evaluate(async () => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const { AppController } = await import(/* @vite-ignore */ resource('/src/app/controller.ts'));
    const { useApp, setSelectionPreferences, switchToolsMode } = await import(/* @vite-ignore */ resource('/src/app/store.ts'));
    const harnessUrl = '/e2e/polygon-harness.ts', { installPolygonProbe } = await import(/* @vite-ignore */ harnessUrl);
    const original = AppController.prototype.setSelectionOperation;
    AppController.prototype.setSelectionOperation = function(operation: number) {
      AppController.prototype.setSelectionOperation = original;
      window.polygonApp = installPolygonProbe(this, { get: useApp.getState, preferences: setSelectionPreferences, mode: switchToolsMode });
      return original.call(this, operation);
    };
  });
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await page.evaluate(({ mode, live, overlap, other }) => { window.polygonApp.profiles(mode, live, overlap, other?.live, other?.overlap); }, { mode, live, overlap, other });
  await page.evaluate(() => window.polygonApp.baseline());
  const value = await snapshot(page); exact(value, polygonBaselineIds); expect(value.summary.canRedo).toBe(true);
  return page.evaluate(() => window.polygonApp.outline());
}
async function vertices(page: Page) {
  return page.locator('.gesture-overlay polyline').evaluateAll(elements => elements.length ? elements[0].getAttribute('points')!.trim().split(/\s+/).map(point => point.split(',').map(Number)) : []);
}
async function down(page: Page, point: number[]) { await page.mouse.move(point[0], point[1]); await page.mouse.down(); }
async function click(page: Page, point: number[]) { await down(page, point); await page.mouse.up(); }
async function outline(page: Page, points: number[][], start = 0) { for (const point of points.slice(start)) await click(page, point); }
async function history(page: Page, ids: number[]) {
  const after = await snapshot(page); exact(after, ids); expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(false);
  expect(after.work).toBe(0); expect(after.summary.selectionMapBytes).toBe(0); expect(after.error).toBeNull();
  await page.getByRole('button', { name: 'Undo', exact: true }).click(); const undone = await snapshot(page); exact(undone, polygonBaselineIds);
  await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), ids);
  return after;
}

test.describe('Independent Polygon center and footprint geometry', () => {
  for (const overlap of [false, true]) test(`${overlap ? 'touched' : 'center'} final polygon has independently distinct source membership`, async ({ page }) => {
    await page.goto('/e2e/polygon-harness.html'); await page.waitForFunction(() => Boolean(window.polygonHarness || window.polygonHarnessError));
    expect(await page.evaluate(() => window.polygonHarnessError)).toBeUndefined();
    const result = await page.evaluate(overlap => window.polygonHarness.geometry(overlap), overlap);
    exact(result.before, polygonBaselineIds); exact(result.after, overlap ? polygonTouchedIds : polygonCenterIds); exact(result.undone, polygonBaselineIds); expect(result.work).toBe(0);
  });
  for (const mode of ['basic', 'pro'] as const) test(`${mode} published two-point outline cannot confirm a different valid final polygon and falls back to current options`, async ({ page }) => {
    await page.goto('/e2e/polygon-harness.html'); await page.waitForFunction(() => Boolean(window.polygonHarness || window.polygonHarnessError));
    const result = await page.evaluate(mode => window.polygonHarness.unusable(mode), mode);
    exact(result.before, polygonBaselineIds); expect(result.requested?.liveRequested).toBe(true); exact(result.publishedBeforeFinal, polygonBaselineIds);
    expect(result.callsBeforeFinal).toBe(1); expect(result.accepted).toBe(true); exact(result.after, polygonTouchedIds);
    exact(result.undone, polygonBaselineIds); exact(result.redone, polygonTouchedIds); expect(result.work).toBe(0);
    const final = result.traffic.filter(command => command.command === 'polygon'); expect(final).toHaveLength(2);
    expect(final[0].overlap).toBe(false); expect(final[1].overlap).toBe(true); expect(final[1].operation).toBe(0);
  });
});
for (const dpr of [1, 2]) test.describe(`Polygon pointer-down vertices and ${dpr} DPR boundaries`, () => {
  test.use({ deviceScaleFactor: dpr });
  test('down admits the vertex, release adds none, and lost capture preserves the unfinished polygon', async ({ page }) => {
    const points = await open(page); await down(page, points[0]);
    await expect.poll(() => vertices(page)).toHaveLength(1);
    const first = await vertices(page);
    await page.mouse.move(points[0][0] + 12, points[0][1] + 7); await page.mouse.up();
    const released = await vertices(page); expect(released[0]).toEqual(first[0]);
    await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture');
    await click(page, points[1]); await click(page, points[2]); await click(page, points[3]);
    await page.keyboard.press('Enter'); await history(page, polygonCenterIds);
    const commands = (await evidence(page)).traffic.filter(command => command.command === 'polygon');
    expect(commands.at(-1)!.points).toHaveLength(4);
  });
  for (const distance of [8, 9]) test(`closing distance ${distance} CSS pixels ${distance === 8 ? 'closes inclusively on down' : 'adds a vertex without closing'}`, async ({ page }) => {
    const points = await open(page); await outline(page, points);
    await down(page, [points[0][0] + distance, points[0][1]]);
    if (distance === 8) {
      const after = await snapshot(page); exact(after, polygonCenterIds); expect(after.summary.selectionDraft).toBe(false); expect(await vertices(page)).toHaveLength(0);
      const beforeUp = (await evidence(page)).traffic.filter(command => command.command === 'polygon').length; await page.mouse.up();
      expect((await evidence(page)).traffic.filter(command => command.command === 'polygon')).toHaveLength(beforeUp); await history(page, polygonCenterIds);
    } else {
      const added = await vertices(page); expect(added).toHaveLength(5); exact(await snapshot(page), polygonBaselineIds);
      await page.mouse.up(); await page.keyboard.press('Escape'); const after = await snapshot(page); exact(after, polygonBaselineIds); expect(after.summary.canRedo).toBe(true);
    }
  });
  test('nearby-offset double click finishes four committed down vertices without appending its second press', async ({ page }) => {
    const points = await open(page); await outline(page, points.slice(0, 3));
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!, events: { type: string; detail: number; x: number; y: number }[] = [];
      (window as unknown as { polygonClickEvents: typeof events }).polygonClickEvents = events;
      for (const type of ['pointerdown', 'mousedown', 'dblclick']) canvas.addEventListener(type, event => {
        const mouse = event as MouseEvent; events.push({ type, detail: mouse.detail, x: mouse.clientX, y: mouse.clientY });
      });
    });
    await page.mouse.click(points[3][0], points[3][1], { clickCount: 1 });
    await page.mouse.move(points[3][0] + 2, points[3][1] + 1);
    await page.mouse.down({ clickCount: 2 }); await page.mouse.up({ clickCount: 2 });
    const events = await page.evaluate(() => (window as unknown as { polygonClickEvents: { type: string; detail: number }[] }).polygonClickEvents);
    expect(events.filter(event => event.type === 'mousedown').map(event => event.detail)).toEqual([1, 2]);
    await history(page, polygonCenterIds);
    const commands = (await evidence(page)).traffic.filter(command => command.command === 'polygon');
    const physical = await page.locator('canvas').evaluate((canvas, points) => {
      const element = canvas as HTMLCanvasElement, bounds = canvas.getBoundingClientRect();
      return points.map(point => [Math.round((point[0] - bounds.x) * element.width / bounds.width), Math.round((point[1] - bounds.y) * element.height / bounds.height)]);
    }, points);
    expect(commands.at(-1)!.points).toEqual(physical);
    expect(commands.at(-1)!.points).toHaveLength(4);
  });
});
test('deferred Polygon excludes duplicate vertices and retains the real 4096-point cap without GPU work per vertex', async ({ page }) => {
  await open(page);
  const value = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!, bounds = canvas.getBoundingClientRect();
    const press = (x: number, y: number) => {
      const options = { bubbles: true, pointerId: 17, pointerType: 'mouse', button: 0, clientX: bounds.x + x, clientY: bounds.y + y };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...options, buttons: 1 }));
      canvas.dispatchEvent(new MouseEvent('mousedown', { ...options, detail: 1, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...options, buttons: 0 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { ...options, detail: 1, buttons: 0 }));
    };
    press(180, 420); press(180, 420);
    for (let i = 0; i < 4095; i++) press(280 + i % 64, 200 + Math.floor(i / 64));
    press(430, 280); press(431, 281);
    await Promise.resolve();
    return { polygonCalls: window.polygonApp.traffic.filter(command => command.command === 'polygon').length };
  });
  expect(await vertices(page)).toHaveLength(4096); expect(value.polygonCalls).toBe(0);
  await page.keyboard.press('Escape'); const after = await snapshot(page); exact(after, polygonBaselineIds); expect(after.summary.canRedo).toBe(true); expect(after.work).toBe(0);
});

// Switching the Tools profile while a polygon is open is excluded: web-lite has
// no Pro profile (processing.advanced) and hides the mode control.
test.describe('Polygon option changes during an unfinished outline', () => {
  test('same-value explicit options cancel the whole unfinished polygon and restore original Redo', async ({ page }) => {
    const points = await open(page, 'basic', true, false); await outline(page, points); exact(await snapshot(page), polygonCenterIds);
    await page.evaluate(() => window.polygonApp.options({ live: true })); const after = await snapshot(page); exact(after, polygonBaselineIds);
    expect(await vertices(page)).toHaveLength(0); expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(true); expect(after.work).toBe(0);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
  });
  test('Backspace to zero cancels a live polygon and preserves baseline history', async ({ page }) => {
    const points = await open(page, 'basic', true, false); await outline(page, points); exact(await snapshot(page), polygonCenterIds);
    for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
    const after = await snapshot(page); exact(after, polygonBaselineIds); expect(await vertices(page)).toHaveLength(0); expect(after.summary.canRedo).toBe(true); expect(after.work).toBe(0);
  });
});
