import { expect, test, type Page } from '@playwright/test';
import { fixtureCenters } from './sceneCoordinates';
import { connectedPly, connectedPositions, mixedPly, mixedPositions } from './connected-fixture';
import { chooseSelectionTool } from './selectTool';
import type {} from './connected-harness';
import type { SelectionMapContext } from '../src/app/selectionMaps';

type WorkObservation = ReturnType<typeof import('./admitted-export').exportWorkObservation>;
function expectWorkOwnership(value: WorkObservation) {
  expect(value.retainedExport.allocations).toBeGreaterThanOrEqual(0); expect(value.retainedExport.allocations).toBeLessThanOrEqual(1);
  expect(value.retainedExport.bytes).toBeGreaterThanOrEqual(0);
  expect(value.total).toEqual({ allocations: value.transient.allocations + value.retainedExport.allocations,
    bytes: value.transient.bytes + value.retainedExport.bytes });
}

const bytes = connectedPly();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const toggle = (page: Page) => page.getByRole('button', { name: 'Connected colors', exact: true });
const slider = (page: Page) => page.getByRole('slider', { name: 'Selection tolerance', exact: true });
async function ready(page: Page) { await expect(page.locator('.status.panel')).toHaveCount(0); }
async function selected(page: Page, count: number) {
  await expect(panel(page).locator('.model-stats')).toHaveText(new RegExp(`^${count.toLocaleString('en-US')}/[\\d,]+ splats \\| SH[0-3]$`)); await ready(page);
}
async function tolerance(page: Page, percent: number, settle = true) {
  await slider(page).click({ button: 'right' }); const exact = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
  await exact.fill(String(percent)); await exact.press('Enter'); if (settle) await ready(page);
}
async function open(page: Page, data = bytes) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'connected-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(data) });
  await expect(page).toHaveTitle('connected-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, 'Color picker'); await page.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(toggle(page)).toBeEnabled(); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
}
async function exportSelection(page: Page, points = connectedPositions) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  await page.getByLabel('Export format', { exact: true }).selectOption('5'); await page.getByLabel('Export scope', { exact: true }).selectOption('1');
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download', exact: true }).click();
  const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const rows = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => row.split(',').slice(0, 3).map(Number));
  const ids = rows.map(row => points.findIndex(point => point.every((value, i) => Math.abs(value - row[i]) < 1e-5))).sort((a, b) => a - b);
  expect(ids).not.toContain(-1); await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); return ids;
}
async function countPicks(page: Page) {
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/renderer/webgpu/renderer.ts')!.name;
    const { GaussianRenderer } = await import(/* @vite-ignore */ url), original = GaussianRenderer.prototype.pick;
    const counts = { picks: 0 }; (window as unknown as { connectedCounts: typeof counts }).connectedCounts = counts;
    GaussianRenderer.prototype.pick = function(...args: unknown[]) { counts.picks++; return original.apply(this, args); };
  });
}
async function picks(page: Page) { return page.evaluate(() => (window as unknown as { connectedCounts: { picks: number } }).connectedCounts.picks); }
async function holdNextMap(page: Page, phase: 'delivery' | 'readback' = 'delivery') {
  await page.evaluate(async phase => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/selectionMaps.ts')!.name;
    const { DocumentSelectionMaps } = await import(/* @vite-ignore */ url), original = DocumentSelectionMaps.prototype.request;
    const { exportWorkObservation } = await import(/* @vite-ignore */ new URL('/e2e/admitted-export.ts', location.origin).href);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const control = { entered: false, release, requests: 0, signal: undefined as AbortSignal | undefined,
      join: async () => {}, workBefore: 0, workNow: () => 0,
      ownershipBefore: undefined as WorkObservation | undefined, ownershipNow: undefined as (() => WorkObservation) | undefined };
    (window as unknown as { connectedGate: typeof control }).connectedGate = control;
    DocumentSelectionMaps.prototype.request = async function(...args: unknown[]) {
      DocumentSelectionMaps.prototype.request = original; control.requests++;
      control.signal = args[2] as AbortSignal;
      const context = args[0] as SelectionMapContext;
      const ownership = () => exportWorkObservation(context.client, context.ledger) as WorkObservation;
      const workBytes = () => ownership().transient.bytes;
      control.ownershipBefore = ownership(); control.ownershipNow = ownership;
      control.workBefore = workBytes(); control.workNow = workBytes;
      control.join = async () => { await this.cancelPending(); };
      if (phase === 'delivery') {
        const result = await original.apply(this, args); control.entered = true; await gate; return result;
      }
      // Hold completion of a real GPU map, before the cache can adopt it. A
      // cancelled waiter must discard this result and release its real leases.
      const mapAsync = GPUBuffer.prototype.mapAsync;
      GPUBuffer.prototype.mapAsync = async function(...mappingArgs: Parameters<GPUBuffer['mapAsync']>) {
        // Histogram mapping can race this query. Keep waiting for the surface's
        // first readback, before capacity inspection or native map adoption.
        if (this.label !== 'Surface capacity readback') return mapAsync.apply(this, mappingArgs);
        GPUBuffer.prototype.mapAsync = mapAsync;
        const mapping = mapAsync.apply(this, mappingArgs); control.entered = true; await gate; return mapping;
      };
      return original.apply(this, args);
    };
  }, phase);
}
async function appState(page: Page) {
  return page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    const { useApp } = await import(/* @vite-ignore */ url);
    const { summary, mode, pendingMode, operation, visibleOnly, overlap, live, selectionOptionsRevision, connectedColor } = useApp.getState();
    return { summary, mode, pendingMode, operation, visibleOnly, overlap, live, selectionOptionsRevision, connectedColor };
  });
}
async function ownerId(page: Page) { return (await appState(page)).summary?.toleranceSessionId; }

test.describe('Connected Color App', () => {
  test.beforeEach(async ({ page }) => { await open(page); });
  for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect'] as const)
    test(`${operation} toggles and tolerance changes use the original click and one Undo`, async ({ page }) => {
      const [center] = await fixtureCenters(page, bytes, connectedPositions); await countPicks(page);
      if (operation !== 'Add') { await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 4); }
      await page.getByRole('button', { name: operation, exact: true }).click();
      await page.mouse.click(...center as [number, number]); await selected(page, 2);
      await toggle(page).click(); await selected(page, operation === 'Subtract' ? 3 : 1);
      expect(await exportSelection(page)).toEqual(operation === 'Subtract' ? [1, 2, 3] : [0]);
      await tolerance(page, 35); await selected(page, operation === 'Subtract' ? 1 : 3);
      expect(await exportSelection(page)).toEqual(operation === 'Subtract' ? [3] : [0, 1, 2]);
      await toggle(page).click(); await selected(page, operation === 'Subtract' ? 0 : 4);
      await tolerance(page, 1); await selected(page, 2); await toggle(page).click(); await selected(page, operation === 'Subtract' ? 3 : 1);
      expect(await picks(page)).toBe(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, operation === 'Add' ? 0 : 4);
      if (operation !== 'Add') { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); }
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });

  test('initial Connected clicks resolve on release, ignore drags and keep the owner after empty clicks', async ({ page }) => {
    const centers = await fixtureCenters(page, bytes, connectedPositions); await toggle(page).click();
    await page.mouse.move(...centers[0] as [number, number]); await page.mouse.down(); await selected(page, 0); await expect(toggle(page)).toBeDisabled();
    await page.mouse.up(); await selected(page, 1); await expect(toggle(page)).toBeEnabled();
    await page.mouse.move(...centers[3] as [number, number]); await page.mouse.down(); await page.mouse.move(centers[3][0] + 6, centers[3][1]); await page.mouse.up(); await selected(page, 1);
    for (const operation of ['Replace', 'Add', 'Subtract', 'Intersect']) {
      await page.getByRole('button', { name: operation, exact: true }).click(); await page.mouse.click(1100, 100); await selected(page, 1);
    }
    await tolerance(page, 35); await selected(page, 3); expect(await exportSelection(page)).toEqual([0, 1, 2]);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('Connected preference survives tool changes and Fill retains its independent tolerance', async ({ page }) => {
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%'); await toggle(page).click(); await tolerance(page, 35);
    await chooseSelectionTool(page, 'Fill'); await expect(toggle(page)).toHaveCount(0);
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '1%'); await tolerance(page, 60);
    await chooseSelectionTool(page, 'Color picker'); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(slider(page)).toHaveAttribute('aria-valuetext', '35%');
    await chooseSelectionTool(page, 'Fill'); await expect(slider(page)).toHaveAttribute('aria-valuetext', '60%');
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('a refused RGB map upgrade restores the checkbox and leaves the old ordinary selection adjustable', async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, connectedPositions); await page.mouse.click(...center as [number, number]); await selected(page, 2);
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/document/resources.ts')!.name;
      const { ResourceLedger, AdmissionError } = await import(/* @vite-ignore */ url), original = ResourceLedger.prototype.reserve;
      // Map admission retries after trimming pooled scratch, so refuse every
      // work reservation until the refused upgrade has been reported.
      (window as unknown as { restoreConnectedAdmission(): void }).restoreConnectedAdmission = () => { ResourceLedger.prototype.reserve = original; };
      ResourceLedger.prototype.reserve = function(kind: string, size: number) {
        if (kind === 'work') throw new AdmissionError('Injected Connected map admission refusal.');
        return original.call(this, kind, size);
      };
    });
    await toggle(page).click(); await expect(page.getByRole('alert')).toContainText('Injected Connected');
    await page.evaluate(() => (window as unknown as { restoreConnectedAdmission(): void }).restoreConnectedAdmission());
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false'); await selected(page, 2);
    await toggle(page).click(); await selected(page, 1); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await tolerance(page, 35); await selected(page, 3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('pending Connected upgrade accepts real control edits and export waits for the latest mode and tolerance', async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, connectedPositions); await countPicks(page);
    await page.mouse.click(...center as [number, number]); await selected(page, 2);
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/selectionMaps.ts')!.name;
      const { DocumentSelectionMaps } = await import(/* @vite-ignore */ url), original = DocumentSelectionMaps.prototype.request;
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const control = { entered: false, release }; (window as unknown as { connectedGate: typeof control }).connectedGate = control;
      DocumentSelectionMaps.prototype.request = async function(...args: unknown[]) {
        const result = await original.apply(this, args); DocumentSelectionMaps.prototype.request = original;
        control.entered = true; await gate; return result;
      };
    });
    await toggle(page).click(); await page.waitForFunction(() => (window as unknown as { connectedGate: { entered: boolean } }).connectedGate.entered);
    await expect(toggle(page)).toBeEnabled(); await expect(slider(page)).toBeEnabled(); await tolerance(page, 35); await selected(page, 2);
    await toggle(page).click(); await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Save scene', exact: true }).click();
    await page.getByLabel('Export format', { exact: true }).selectOption('5'); await page.getByLabel('Export scope', { exact: true }).selectOption('1');
    let downloaded = false; page.on('download', () => { downloaded = true; }); const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click(); await page.waitForTimeout(30); expect(downloaded).toBe(false);
    await page.evaluate(() => (window as unknown as { connectedGate: { release(): void } }).connectedGate.release());
    const stream = await (await downloading).createReadStream(), chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    const xs = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => Number(row.split(',')[0])).sort((a, b) => a - b);
    expect(xs).toEqual(expect.arrayContaining(connectedPositions.slice(0, 3).map(point => expect.closeTo(point[0], 5)))); expect(xs).toHaveLength(3);
    await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); await selected(page, 3); expect(await picks(page)).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  for (const cancel of ['blur', 'escape'] as const) test(`${cancel} ends a waiting first RGB owner, keeps requested Connected and preserves committed history`, async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, connectedPositions); await countPicks(page);
    await page.mouse.click(...center as [number, number]); await selected(page, 2); const before = (await appState(page)).summary!;
    expect(before.toleranceSessionId).toEqual(expect.any(Number));
    await holdNextMap(page, 'readback'); await toggle(page).click();
    await page.waitForFunction(() => (window as unknown as { connectedGate: { entered: boolean } }).connectedGate.entered);
    await tolerance(page, 35); await toggle(page).click(); await toggle(page).click();
    if (cancel === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else { await page.getByLabel('SplatView scene').focus(); await page.keyboard.press('Escape'); }
    await page.waitForFunction(() => (window as unknown as { connectedGate: { signal: AbortSignal } }).connectedGate.signal.aborted);
    await page.evaluate(async () => {
      const gate = (window as unknown as { connectedGate: { release(): void; join(): Promise<void> } }).connectedGate;
      gate.release(); await gate.join();
    });
    await selected(page, 2); expect(await exportSelection(page)).toEqual([0, 3]);
    await expect.poll(() => ownerId(page)).toBeNull();
    const after = await appState(page);
    expect(after.connectedColor).toBe(true); expect(after.summary!.revision).toBe(before.revision);
    expect(after.summary!.canUndo).toBe(before.canUndo); expect(after.summary!.canRedo).toBe(before.canRedo);
    expect(after.summary!.selectionMapRetainedIds).toEqual([]); expect(after.summary!.selectionMapBytes).toBe(0);
    const workBefore = await page.evaluate(() => (window as unknown as { connectedGate: { workBefore: number } }).connectedGate.workBefore);
    // Query cleanup and a queued off amendment have independent retirement
    // barriers. Check the real current ledger after both become idle.
    await expect.poll(() => page.evaluate(() => (window as unknown as { connectedGate: { workNow(): number } }).connectedGate.workNow())).toBe(workBefore);
    const ownership = await page.evaluate(() => {
      const gate = (window as unknown as { connectedGate: { ownershipBefore: WorkObservation; ownershipNow(): WorkObservation } }).connectedGate;
      return { before: gate.ownershipBefore, after: gate.ownershipNow() };
    });
    expectWorkOwnership(ownership.before); expectWorkOwnership(ownership.after);
    expect(ownership.after.transient).toEqual(ownership.before.transient);
    expect(ownership.after.retainedExport.allocations).toBe(1); expect(ownership.after.retainedExport.bytes).toBeGreaterThan(0);
    if (cancel === 'escape') { await expect(toggle(page)).toHaveCount(0); await chooseSelectionTool(page, 'Color picker'); }
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await tolerance(page, 100); await selected(page, 2); expect(await exportSelection(page)).toEqual([0, 3]);
    await expect.poll(() => ownerId(page)).toBeNull();
    expect(await picks(page)).toBe(1); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('turning Connected off before blur clears waiting and preserves the ordinary adjustable owner', async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, connectedPositions); await countPicks(page);
    await page.mouse.click(...center as [number, number]); await selected(page, 2); const originalOwner = await ownerId(page);
    await holdNextMap(page, 'readback'); await toggle(page).click();
    await page.waitForFunction(() => (window as unknown as { connectedGate: { entered: boolean } }).connectedGate.entered);
    const waiting = (await appState(page)).summary!;
    expect(waiting).toMatchObject({ selected: 2, toleranceSessionId: originalOwner, toleranceConnected: false, toleranceMapId: null });
    expect(waiting.selectionMapRetainedIds).toEqual([]);
    await toggle(page).click(); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await page.waitForFunction(() => (window as unknown as { connectedGate: { signal: AbortSignal } }).connectedGate.signal.aborted);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(async () => {
      const gate = (window as unknown as { connectedGate: { release(): void; join(): Promise<void> } }).connectedGate;
      gate.release(); await gate.join();
    });
    await selected(page, 2); expect(await ownerId(page)).toBe(originalOwner); expect(await exportSelection(page)).toEqual([0, 3]);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
    await tolerance(page, 35); await selected(page, 4); expect(await exportSelection(page)).toEqual([0, 1, 2, 3]);
    expect(await ownerId(page)).toBe(originalOwner); expect(await picks(page)).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });

  // Switching Tools profiles mid-amendment is excluded: web-lite has no Pro profile (processing.advanced).

  for (const newerTolerance of [false, true]) test(`blur after RGB acquisition preserves the nonwaiting owner${newerTolerance ? ' with newer tolerance queued' : ''}`, async ({ page }) => {
    const [center] = await fixtureCenters(page, bytes, connectedPositions); await countPicks(page);
    await page.mouse.click(...center as [number, number]); await selected(page, 2); const originalOwner = await ownerId(page);
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/renderer/webgpu/renderer.ts')!.name;
      const { GpuScene } = await import(/* @vite-ignore */ url), original = GpuScene.prototype.stageMasks;
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      const control = { entered: false, release }; (window as unknown as { connectedPublication: typeof control }).connectedPublication = control;
      GpuScene.prototype.stageMasks = async function(...args: unknown[]) {
        GpuScene.prototype.stageMasks = original; control.entered = true; await held; return original.apply(this, args);
      };
    });
    await toggle(page).click(); await page.waitForFunction(() => (window as unknown as { connectedPublication: { entered: boolean } }).connectedPublication.entered);
    if (newerTolerance) await tolerance(page, 35, false);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.evaluate(() => (window as unknown as { connectedPublication: { release(): void } }).connectedPublication.release());
    await selected(page, newerTolerance ? 3 : 1); expect(await ownerId(page)).toBe(originalOwner); await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
    await tolerance(page, 35); await selected(page, 3); expect(await exportSelection(page)).toEqual([0, 1, 2]); expect(await picks(page)).toBe(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test('Connected uses the source contributor color even when substantial rear color makes the seed purple', async ({ page }) => {
  const data = mixedPly(); await open(page, data);
  const centers = await fixtureCenters(page, data, mixedPositions.map(([x, y, z]) => [x, -y, -z]));
  await page.mouse.click(...centers[0] as [number, number]); await selected(page, 2); expect(await exportSelection(page, mixedPositions)).toEqual([0, 2]);
  await toggle(page).click(); await selected(page, 1); expect(await exportSelection(page, mixedPositions)).toEqual([0]);
  await toggle(page).click(); await selected(page, 2); await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test.describe('Retina Connected Color', () => {
  test.use({ deviceScaleFactor: 2 });
  test('uses original framebuffer seed and retains disconnected exclusion through mode changes', async ({ page }) => {
    await open(page); const [center] = await fixtureCenters(page, bytes, connectedPositions);
    await toggle(page).click(); await page.mouse.click(...center as [number, number]); await selected(page, 1);
    await tolerance(page, 35); await selected(page, 3); expect(await exportSelection(page)).toEqual([0, 1, 2]);
    await toggle(page).click(); await selected(page, 4); await toggle(page).click(); await selected(page, 3);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  });
});

test.describe('Connected Color controller boundaries', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/connected-harness.html'); await page.waitForFunction(() => Boolean(window.connectedHarness || window.connectedHarnessError));
    expect(await page.evaluate(() => window.connectedHarnessError)).toBeUndefined();
  });
  for (const kind of ['map', 'publication'] as const) test(`refused ${kind} upgrade preserves exact masks, Redo and authoritative mode`, async ({ page }) => {
    const result = await page.evaluate(kind => window.connectedHarness.refusal(kind), kind);
    expect(result.before.selected).toBe(2); expect(result.after.selected).toBe(2); expect(result.after.canRedo).toBe(true);
    expect(result.after.revision).toBe(result.before.revision); expect(result.sameOutput).toBe(true); expect(result.sameGpuMasks).toBe(true);
    expect(result.modeAfter).toBe(false); expect(result.error).toMatch(/Injected Connected/); expect(result.busy).toBe(false);
    expect(result.connected).toBe(1); expect(result.expanded).toBe(3); expect(result.ordinary).toBe(4); expect(result.picks).toBe(1);
  });
  for (const [operation, ordinaryMask] of [[0, [1, 0, 0, 1]], [1, [1, 1, 0, 1]], [2, [0, 1, 0, 0]], [3, [0, 0, 0, 1]]] as const)
    test(`an admitted empty first enable restores the original baseline for Combine ${operation} and retains adjustment`, async ({ page }) => {
      const result = await page.evaluate(operation => window.connectedHarness.nativeEmpty(operation), operation);
      expect(result.baselineMasks).toEqual([0, 1, 0, 1]); expect(result.originalOrdinaryMasks).toEqual(ordinaryMask);
      expect(result.before.canRedo).toBe(false); expect(result.after.canRedo).toBe(false);
      expect(result.afterMasks).toEqual(result.baselineMasks); expect(result.baselineOutput).toBe(true); expect(result.after.selected).toBe(2);
      expect(result.after.toleranceSessionId).toBe(result.before.toleranceSessionId); expect(result.after.toleranceConnected).toBe(true);
      expect(result.after.toleranceMapId).toBe(result.emptyMapId); expect(result.after.revision).toBeGreaterThan(result.before.revision);
      expect(result.mode).toBe(true); expect(result.error).toBeNull();
      expect(result.repeatedMasks).toEqual(result.baselineMasks); expect(result.repeated.revision).toBe(result.after.revision);
      expect(result.ordinaryMasks).toEqual(ordinaryMask); expect(result.ordinaryOutput).toBe(true); expect(result.ordinary.toleranceConnected).toBe(false);
      expect(result.ordinary.toleranceSessionId).toBe(result.before.toleranceSessionId); expect(result.emptyAgain.selected).toBe(2);
      expect(result.retained.selectionMapRetainedIds).toEqual([result.emptyMapId]); expect(result.retained.selectionMapBytes).toBe(result.emptyMapBytes);
      expect(result.undoneMasks).toEqual([0, 1, 0, 0]); expect(result.undone.selected).toBe(1);
      expect(result.released.selectionMapRetainedIds).toEqual([]); expect(result.released.selectionMapBytes).toBe(0);
      expect(result.workAfter).toBe(result.workBefore); expectWorkOwnership(result.workOwnershipBefore); expectWorkOwnership(result.workOwnershipAfter);
      expect(result.workOwnershipAfter.transient).toEqual(result.workOwnershipBefore.transient);
      expect(result.workOwnershipAfter.retainedExport).toEqual(result.workOwnershipBefore.retainedExport);
      expect(result.mapRequests).toBe(1); expect(result.picks).toBe(1); expect(result.busy).toBe(false);
    });

  test('empty first enable on a no-op ordinary baseline preserves Redo while retaining true Connected and its map', async ({ page }) => {
    const result = await page.evaluate(() => window.connectedHarness.nativeEmpty(0, true));
    expect(result.baselineMasks).toEqual([1, 0, 0, 1]); expect(result.originalOrdinaryMasks).toEqual(result.baselineMasks);
    expect(result.before.canRedo).toBe(true); expect(result.after.canRedo).toBe(true); expect(result.after.revision).toBe(result.before.revision);
    expect(result.afterMasks).toEqual(result.baselineMasks); expect(result.baselineOutput).toBe(true);
    expect(result.after.toleranceSessionId).toBe(result.before.toleranceSessionId); expect(result.after.toleranceConnected).toBe(true);
    expect(result.after.toleranceMapId).toBe(result.emptyMapId); expect(result.mode).toBe(true); expect(result.error).toBeNull();
    expect(result.repeatedMasks).toEqual(result.baselineMasks); expect(result.repeated.canRedo).toBe(true);
    expect(result.ordinaryMasks).toEqual(result.baselineMasks); expect(result.ordinaryOutput).toBe(true); expect(result.ordinary.canRedo).toBe(true);
    expect(result.retained.selectionMapRetainedIds).toEqual([result.emptyMapId]); expect(result.retained.selectionMapBytes).toBe(result.emptyMapBytes);
    expect(result.undoneMasks).toEqual([1, 0, 0, 0]); expect(result.released.selectionMapRetainedIds).toEqual([]); expect(result.released.selectionMapBytes).toBe(0);
    expect(result.workAfter).toBe(result.workBefore); expectWorkOwnership(result.workOwnershipBefore); expectWorkOwnership(result.workOwnershipAfter);
    expect(result.workOwnershipAfter.transient).toEqual(result.workOwnershipBefore.transient);
    expect(result.workOwnershipAfter.retainedExport).toEqual(result.workOwnershipBefore.retainedExport);
    expect(result.mapRequests).toBe(1); expect(result.picks).toBe(1); expect(result.busy).toBe(false);
  });
  test('an initial Connected pick with a valid contributor and admitted empty map replaces the prior owner with its own no-op checkpoint', async ({ page }) => {
    const result = await page.evaluate(() => window.connectedHarness.initialEmptyReplacement());
    expect(result.accepted).toBe(true); expect(result.beforeMasks).toEqual([1, 0, 0, 1]); expect(result.afterMasks).toEqual(result.beforeMasks);
    expect(result.sameOutput).toBe(true); expect(result.after.revision).toBe(result.before.revision);
    expect(result.after.canUndo).toBe(result.before.canUndo); expect(result.after.canRedo).toBe(result.before.canRedo);
    expect(result.after.toleranceSessionId).toEqual(expect.any(Number)); expect(result.after.toleranceSessionId).not.toBe(result.before.toleranceSessionId);
    expect(result.after.toleranceConnected).toBe(true); expect(result.after.toleranceMapId).toBe(result.emptyMapId);
    expect(result.ordinaryMasks).toEqual([0, 0, 0, 0]); expect(result.ordinary.selected).toBe(0);
    expect(result.ordinary.toleranceSessionId).toBe(result.after.toleranceSessionId); expect(result.emptyAgain.selected).toBe(2);
    expect(result.retained.selectionMapRetainedIds).toEqual([result.emptyMapId]); expect(result.retained.selectionMapBytes).toBe(result.emptyMapBytes);
    expect(result.undone.selected).toBe(0); expect(result.undone.canUndo).toBe(false); expect(result.undone.selectionMapRetainedIds).toEqual([]);
    expect(result.mode).toBe(true); expect(result.mapRequests).toBe(1); expect(result.picks).toBe(2); expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
  for (const kind of ['initial', 'toggle', 'amendment'] as const) test(`export resolves held ${kind} with coalesced absolute mode and tolerance`, async ({ page }) => {
    const result = await page.evaluate(kind => window.connectedHarness.exportBarrier(kind), kind);
    expect(result.blocked).toBe(true); expect(result.exportCalls).toBe(1); expect(result.rows).toBe(3); expect(result.after.selected).toBe(3);
    expect(result.after.toleranceConnected).toBe(true); expect(result.mode).toBe(true); expect(result.picks).toBe(1);
    expect(result.undone.selected).toBe(0); expect(result.undone.canUndo).toBe(false); expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
  for (const kind of ['view', 'tool', 'history'] as const) test(`${kind} change discards a held Connected upgrade without late publication`, async ({ page }) => {
    const result = await page.evaluate(kind => window.connectedHarness.cancelUpgrade(kind), kind);
    expect(result.after.selected).toBe(kind === 'history' ? 0 : 2); expect(result.after.toleranceSessionId).toBeNull();
    expect(result.busy).toBe(false); expect(result.error).toBeNull(); expect(result.picks).toBe(1); expect(result.late.selected).toBe(result.after.selected);
  });
  test('a cancelled old RGB cleanup cannot capture and cancel a newer Brush gesture', async ({ page }) => {
    const result = await page.evaluate(() => window.connectedHarness.cancelBeforeNewGesture());
    expect(result.began).toBe(true); expect(result.activeBefore).toBe(true); expect(result.activeAfter).toBe(true); expect(result.accepted).toBe(true);
    expect(result.after.selected).toBe(1); expect(result.masks).toEqual([1, 0, 0, 0]);
    expect(result.undone.selected).toBe(2); expect(result.original.selected).toBe(0); expect(result.original.canUndo).toBe(false);
    expect(result.requested).toBe(true); expect(result.busy).toBe(false); expect(result.error).toBeNull();
  });
});
