import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import { fixtureCenters } from './sceneCoordinates';
import { queuePly, queuePositions } from './queue-fixture';
import type {} from './queue-harness';

type Tool = 'color' | 'fill';
const masks = (ids: readonly number[]) => queuePositions.map((_, i) => Number(ids.includes(i)));
const headIds = (tool: Tool) => tool === 'color' ? [0, 3] : [0];
const tailIds = (tool: Tool) => tool === 'color' ? [4] : [3];
function exact(snapshot: { gpu: number[]; ids: number[]; summary: { selected: number }; exportError?: string }, ids: number[]) {
  expect(snapshot.gpu).toEqual(masks(ids)); expect(snapshot.ids).toEqual(ids); expect(snapshot.summary.selected).toBe(ids.length);
  if (!ids.length) expect(snapshot.exportError).toMatch(/There are no visible Gaussians to save/); else expect(snapshot.exportError).toBeUndefined();
}
function retired(result: { released: { summary: { selectionMapRetainedIds: number[]; selectionMapBytes: number }; work: number }; pendingAfter: number; busy: boolean }) {
  expect(result.pendingAfter).toBe(0); expect(result.busy).toBe(false); expect(result.released.work).toBe(0);
  expect(result.released.summary.selectionMapRetainedIds).toEqual([]); expect(result.released.summary.selectionMapBytes).toBe(0);
}
function fenced(value: { singleGesture: boolean; geometric: boolean; active: boolean; pendingBefore: number; pendingAfter: number;
  picks: number; queries: number; exportCalls: number; exportSettled: boolean }, refused: { color: boolean; fill: boolean }) {
  expect(value.singleGesture).toBe(false); expect(value.geometric).toBe(false); expect(value.active).toBe(false);
  expect(value.pendingBefore).toBe(1); expect(value.pendingAfter).toBe(1);
  expect(value.picks).toBe(0); expect(value.queries).toBe(0); expect(value.exportCalls).toBe(0); expect(value.exportSettled).toBe(true);
  expect(refused).toEqual({ color: false, fill: false });
}
test.describe('Released selection FIFO through real native/GPU', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/queue-harness.html'); await page.waitForFunction(() => Boolean(window.queueHarness || window.queueHarnessError));
    expect(await page.evaluate(() => window.queueHarnessError)).toBeUndefined();
  });
  for (const tool of ['color', 'fill'] as const) {
    test(`${tool} actual 1024-record saturation refuses only overflow, recovers capacity after cancellation and drains the refilled FIFO`, async ({ page }) => {
      test.setTimeout(180_000);
      const result = await page.evaluate(tool => window.queueHarness.saturation(tool), tool);
      exact(result.previous, [4]);
      for (const phase of [result.first, result.second]) {
        expect(phase.pending).toBe(1024); expect(phase.refused).toBe(false); expect(phase.error).toMatch(/Too many pending selection clicks/);
        expect(phase.work.bytes - result.baselineWork.bytes).toBe(1024 * 1024);
        expect(phase.work.allocations - result.baselineWork.allocations).toBe(1024);
        expect(phase.work.entries.filter(bytes => bytes === 1024).length - result.baselineWork.entries.filter(bytes => bytes === 1024).length).toBe(1024);
      }
      expect(result.cancelled).toHaveLength(1024); expect(result.cancelled.every(value => !value)).toBe(true);
      exact(result.afterCancellation, [4]); expect(result.afterCancellation.summary.toleranceSessionId).toBe(result.previous.summary.toleranceSessionId);
      expect(result.afterCancellation.summary.revision).toBe(result.previous.summary.revision); expect(result.cancellationWork).toEqual(result.baselineWork);
      expect(result.accepted).toHaveLength(1024); expect(result.accepted.every(Boolean)).toBe(true);
      expect(result.captured).toHaveLength(1025); expect(result.after.summary.toleranceSessionId).toBe(result.captured.at(-1)!.sessionId);
      exact(result.after, [...headIds(tool), 4]); expect(result.drainedWork).toEqual(result.baselineWork);
      exact(result.undone, [4]); exact(result.original, []); expect(result.original.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    for (const connected of (tool === 'color' ? [false, true] : [false])) for (const boundary of ['successor', 'export'] as const)
      test(`${tool} ${connected ? 'Connected and tolerance' : 'tolerance'} changes reach the same executing tail before ${boundary}`, async ({ page }) => {
        const result = await page.evaluate(args => window.queueHarness.executingTail(args.tool, args.connected, args.boundary), { tool, connected, boundary });
        expect(result.pendingBeforeUpdate).toBe(1); expect(result.pendingAfterUpdate).toBe(1);
        expect(result.dispatched.tolerance).toBeCloseTo(.0001, 8); expect(result.gpuWhileHeld).toEqual(masks([]));
        if (tool === 'color') expect(result.dispatched.connected).toBe(false);
        expect(result.pendingAfterBoundary).toBe(boundary === 'successor' ? 2 : 1); expect(result.callsWhileHeld).toBe(0);
        expect(result.accepted).toEqual(boundary === 'successor' ? [true, true] : [true]);
        const amended = tool === 'color' && !connected ? [0, 1, 2, 3] : [0, 1, 2];
        const final = boundary === 'successor' ? [...amended, ...tailIds(tool)] : amended;
        exact(result.after, final); expect(result.pickMasks[0]).toEqual(masks(headIds(tool))); expect(result.pickMasks[1]).toEqual(masks(amended));
        const operations = result.traffic.filter(command => ['colorPick', 'fillPick', 'colorTolerance', 'fillTolerance'].includes(command.command));
        expect(operations.map(command => command.command)).toEqual([`${tool}Pick`, `${tool}Tolerance`, ...(boundary === 'successor' ? [`${tool}Pick`] : [])]);
        expect(operations[1].sessionId).toBe(operations[0].sessionId); expect(operations[1].tolerance).toBeCloseTo(tool === 'color' ? .1225 : 1, 8);
        if (tool === 'color') expect(operations[1].connected).toBe(connected);
        if (boundary === 'export') { expect(result.exportCalls).toBe(1); expect(result.exported).toEqual(amended); exact(result.undone, []); }
        else exact(result.undone, amended);
        exact(result.original, []); expect(result.original.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
      });
    test(`${tool} an external command fences Single, geometric, Color, Fill and export while canceled query cleanup waits`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.externalFence(tool), tool);
      fenced(result.held, result.refused); expect(result.accepted).toBe(false); expect(result.changed).toBe(true);
      exact(result.previous, [4]); exact(result.beforeRelease, [4]); exact(result.after, [4]); expect(result.after.summary.toleranceSessionId).toBeNull();
      exact(result.undone, []); expect(result.undone.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    test(`${tool} immediate clean replacement fences Single, geometric, Color, Fill and export until canceled query cleanup settles`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.immediateReplacement(tool), tool);
      exact(result.previous, [4]); exact(result.beforeRelease, [4]); fenced(result.held, result.refused);
      expect(result.waiting).toEqual({ replaced: false, sameDocument: true, prompt: false, dirty: false, source: 'queue-sh0.ply' });
      expect(result.accepted).toBe(false);
      expect(result.state).toEqual({ replaced: true, newDocument: true, source: 'queue-immediate.ply', dirty: false, prompt: false, outputPending: false });
      exact(result.after, []); expect(result.after.summary.canUndo).toBe(false); expect(result.after.summary.canRedo).toBe(false);
      expect(result.after.summary.toleranceSessionId).toBeNull(); retired(result); expect(result.error).toBeNull();
    });
    for (const choice of ['discard', 'save'] as const) test(`${tool} dirty deferred ${choice} fences new admissions and retires the old document only after its owned work`, async ({ page }) => {
      const result = await page.evaluate(args => window.queueHarness.dirtyNavigation(args.tool, args.choice), { tool, choice });
      exact(result.original, [4]); expect(result.prompt).toEqual({ shown: true, dirty: true, sameDocument: true });
      fenced(result.held, result.refused); expect(result.callsWhileHeld).toBe(0); expect(result.accepted).toBe(choice === 'save');
      if (choice === 'save') {
        expect(result.exportCalls).toBe(1); expect(result.exported).toEqual([0, 1, 2, 3, 4]);
        expect(result.receipt).toMatchObject({ outputPending: true, prompt: true, dirty: true, sameDocument: true });
        exact(result.receipt!.snapshot, [...headIds(tool), 4]);
        fenced(result.acknowledgement!.held, result.acknowledgement!.refused); expect(result.acknowledgement!.accepted).toBe(false);
        expect(result.acknowledgement!.resumeCallsWhileHeld).toBe(0); expect(result.acknowledgement!.resumeCalls).toBe(1);
      } else { expect(result.exportCalls).toBe(0); expect(result.receipt).toBeUndefined(); }
      expect(result.state).toEqual({ source: 'queue-replacement.ply', dirty: false, prompt: false, outputPending: false, newDocument: true });
      exact(result.after, []); expect(result.after.summary.canUndo).toBe(false); expect(result.after.summary.toleranceSessionId).toBeNull(); retired(result); expect(result.error).toBeNull();
    });
    for (const scenario of ['add', 'remove', 'tolerance', 'empty'] as const) test(`${tool} ${scenario} preserves ordered execution-time baselines and captured tail values`, async ({ page }) => {
      const result = await page.evaluate(({ tool, scenario }) => window.queueHarness.ordered(tool, scenario), { tool, scenario });
      expect(result.pending).toBe(2); exact(result.beforeRelease, []);
      expect(result.accepted).toEqual(scenario === 'empty' ? [true, false] : [true, true]);
      expect(result.pickMasks[0]).toEqual(masks(headIds(tool)));
      expect(result.after.summary.toleranceSessionId).toBe(result.captured.at(-1)!.sessionId);
      expect(result.captured[0].operation).toBe(1); expect(result.captured[0].tolerance).toBeCloseTo(.0001, 8);
      if (tool === 'color') expect(result.captured[0].connected).toBe(false);
      if (scenario === 'add') {
        exact(result.after, [...headIds(tool), ...tailIds(tool)]); exact(result.undone, headIds(tool));
      } else if (scenario === 'remove') {
        exact(result.after, []); expect(result.captured[1].operation).toBe(2); exact(result.undone, headIds(tool));
      } else if (scenario === 'tolerance') {
        exact(result.after, tool === 'color' ? [0, 1, 2, 3] : [0, 1, 2]); exact(result.undone, headIds(tool));
        expect(result.captured[1].tolerance).toBeCloseTo(tool === 'color' ? .1225 : 1, 8);
      } else {
        exact(result.after, headIds(tool)); expect(result.after.summary.toleranceSessionId).toBe(result.captured[0].sessionId);
        if (tool === 'color') expect(result.after.summary.toleranceConnected).toBe(false);
        // The tail's pending 100% value must not leak to the surviving head.
        // A fresh explicit update after drain can still amend that owner.
        // Frozen setSelectionTolerance updates only the old stroke's
        // tolerance. The missed tail's remembered Connected flag stays a
        // preference until an actual Connected assignment changes it.
        exact(result.amended!, tool === 'color' ? [0, 1, 2, 3, 4] : [0, 1, 2]);
        if (tool === 'color') {
          expect(result.amended!.summary.toleranceConnected).toBe(false);
          exact(result.sameConnected!, [0, 1, 2, 3, 4]);
          expect(result.sameConnected!.summary.revision).toBe(result.amended!.summary.revision);
          expect(result.sameConnected!.summary.toleranceConnected).toBe(false);
          exact(result.offConnected!, [0, 1, 2, 3, 4]); exact(result.onConnected!, [0, 1, 2]);
          expect(result.onConnected!.summary.toleranceConnected).toBe(true);
          expect(result.onConnected!.summary.toleranceSessionId).toBe(result.after.summary.toleranceSessionId);
        }
        exact(result.undone, []);
      }
      exact(result.original, []); expect(result.original.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    for (const boundary of ['query', 'publication'] as const) for (const at of [1, 2]) test(`${tool} ${boundary} refusal at record ${at} drains its compatible successor`, async ({ page }) => {
      const result = await page.evaluate(args => window.queueHarness.refusal(args.tool, args.boundary, args.at), { tool, boundary, at });
      expect(result.accepted).toEqual(at === 1 ? [false, true] : [true, false]);
      exact(result.after, at === 1 ? tailIds(tool) : headIds(tool)); expect(result.after.summary.canUndo).toBe(true);
      expect(result.after.summary.toleranceSessionId).toBe(result.captured[at === 1 ? result.captured.length - 1 : 0].sessionId);
      exact(result.undone, []); expect(result.undone.summary.canUndo).toBe(false); retired(result);
    });
    for (const boundary of ['cancel', 'view', 'tool', 'history', 'options', 'resize'] as const) test(`${tool} ${boundary} invalidation discards all unaccepted records and retires their ownership`, async ({ page }) => {
      const result = await page.evaluate(args => window.queueHarness.invalidate(args.tool, args.boundary), { tool, boundary });
      expect(result.accepted).toEqual([false, false]); exact(result.before, [4]); exact(result.after, boundary === 'history' ? [] : [4]);
      if (boundary !== 'history') { expect(result.after.summary.revision).toBe(result.before.summary.revision); expect(result.after.summary.canRedo).toBe(true); }
      expect(result.after.summary.toleranceSessionId).toBe(boundary === 'cancel' ? result.before.summary.toleranceSessionId : null);
      retired(result); expect(result.error).toBeNull();
    });
    test(`${tool} export waits for every released record and blocks new picks and preference edits`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.exporting(tool), tool);
      expect(result.pending).toBe(2); expect(result.blocked).toBe(true); expect(result.rejected).toBe(false); expect(result.remembered).toBe(.01);
      expect(result.accepted).toEqual([true, true]); expect(result.calls).toBe(1);
      const ids = [...headIds(tool), ...tailIds(tool)]; expect(result.exported).toEqual(ids); exact(result.after, ids);
      exact(result.undone, headIds(tool)); exact(result.original, []); expect(result.original.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    test(`${tool} admits a successor and routes tail tolerance while the head owns publication`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.publicationAdmission(tool), tool);
      expect(result.ownedBusy).toBe(true); expect(result.pending).toBe(2); expect(result.gpuWhileHeld).toEqual(masks([]));
      expect(result.accepted).toEqual([true, true]); expect(result.pickMasks[0]).toEqual(masks(headIds(tool)));
      expect(result.captured[0].tolerance).toBeCloseTo(.0001, 8); expect(result.captured[1].tolerance).toBeCloseTo(tool === 'color' ? .1225 : 1, 8);
      exact(result.after, tool === 'color' ? [0, 1, 2, 3] : [0, 1, 2]); exact(result.undone, headIds(tool)); exact(result.original, []); retired(result);
      expect(result.error).toBeNull();
    });
    test(`${tool} waits for a preceding completed-owner amendment before capturing the new head baseline`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.previousAmendment(tool), tool);
      exact(result.previous, headIds(tool)); expect(result.pending).toBe(1); expect(result.gpuWhileHeld).toEqual(masks(headIds(tool))); expect(result.accepted).toBe(true);
      exact(result.after, tool === 'color' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3]); exact(result.undone, tool === 'color' ? [0, 1, 2, 3] : [0, 1, 2]);
      exact(result.original, []); expect(result.original.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    test(`${tool} record admission refusal preserves the existing queue and permits a later compatible release`, async ({ page }) => {
      const result = await page.evaluate(tool => window.queueHarness.admissionRefusal(tool), tool);
      expect(result.rejected).toBe(false); expect(result.afterRefusal).toBe(1); expect(result.admissionError).toMatch(/Injected released record admission refusal/);
      expect(result.afterRetry).toBe(2); expect(result.accepted).toEqual([true, true]); exact(result.after, [...headIds(tool), ...tailIds(tool)]);
      exact(result.undone, headIds(tool)); exact(result.original, []); retired(result); expect(result.error).toBeNull();
    });
    for (const boundary of ['query', 'publication'] as const) test(`${tool} new admission survives older ${boundary} cancellation cleanup`, async ({ page }) => {
      const result = await page.evaluate(args => window.queueHarness.cancellationGeneration(args.tool, args.boundary), { tool, boundary });
      expect(result.pendingAtAdmission).toBe(2); expect(result.pendingAfterOldCleanup).toBe(1);
      expect(result.oldAccepted).toBe(false); exact(result.afterOldCleanup, []); expect(result.afterOldCleanup.summary.canUndo).toBe(false);
      expect(result.newAccepted).toBe(true); exact(result.after, tailIds(tool));
      expect(result.after.summary.toleranceSessionId).toBe(result.captured.at(-1)!.sessionId);
      exact(result.undone, []); expect(result.undone.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
    for (const boundary of ['query', 'publication'] as const) for (const connected of (tool === 'color' && boundary === 'query' ? [false, true] : [false])) test(`${tool} ${connected ? 'Connected and tolerance' : 'tolerance'} updates reach the surviving owner while canceled ${boundary} cleanup waits`, async ({ page }) => {
      const result = await page.evaluate(args => window.queueHarness.cancelledOwner(args.tool, args.connected, args.boundary), { tool, connected, boundary });
      exact(result.previous, headIds(tool)); expect(result.pendingWhileAmended).toBe(1); expect(result.accepted).toBe(false);
      const ids = tool === 'color' && !connected ? [0, 1, 2, 3] : [0, 1, 2];
      if (boundary === 'query') {
        exact(result.amendedWhileHeld!, ids);
        expect(result.amendedWhileHeld!.summary.toleranceSessionId).toBe(result.previous.summary.toleranceSessionId);
      }
      expect(result.gpuWhileHeld).toEqual(masks(boundary === 'query' ? ids : headIds(tool))); exact(result.after, ids);
      expect(result.after.summary.toleranceSessionId).toBe(result.previous.summary.toleranceSessionId);
      if (tool === 'color') expect(result.after.summary.toleranceConnected).toBe(connected);
      exact(result.undone, []); expect(result.undone.summary.canUndo).toBe(false); retired(result); expect(result.error).toBeNull();
    });
  }
  test('Connected preference and tolerance target only the queued Color tail', async ({ page }) => {
    const result = await page.evaluate(() => window.queueHarness.ordered('color', 'connected'));
    expect(result.pending).toBe(2); expect(result.accepted).toEqual([true, true]);
    expect(result.pickMasks[0]).toEqual(masks([0, 3])); expect(result.captured[0].connected).toBe(false); expect(result.captured[0].tolerance).toBeCloseTo(.0001, 8);
    expect(result.captured[1].connected).toBe(true); expect(result.captured[1].tolerance).toBeCloseTo(.1225, 8);
    exact(result.after, [0, 1, 2, 3]); exact(result.undone, [0, 3]); exact(result.original, []); retired(result); expect(result.error).toBeNull();
  });
});

const bytes = queuePly();
const panel = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
async function idle(page: Page) { await expect(page.locator('.status.panel')).toHaveCount(0); }
async function selected(page: Page, n: number) { await expect(panel(page).locator('.model-stats')).toHaveText(new RegExp(`^${n.toLocaleString('en-US')}/[\\d,]+ splats \\| SH[0-3]$`)); await idle(page); }
async function state(page: Page) {
  return page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    const { useApp } = await import(/* @vite-ignore */ url), value = useApp.getState();
    return { mode: value.mode, pendingMode: value.pendingMode, pending: value.pendingSelectionCount, dragging: value.selectionDragging, operation: value.operation,
      visibleOnly: value.visibleOnly, overlap: value.overlap, live: value.live, summary: value.summary, optionsRevision: value.selectionOptionsRevision,
      dirty: value.dirty, source: value.sourceName, prompt: value.navigationPrompt, outputPending: value.outputPending };
  });
}
async function tolerance(page: Page, percent: number) {
  await page.getByRole('slider', { name: 'Selection tolerance', exact: true }).click({ button: 'right' });
  const input = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true }); await input.fill(String(percent)); await input.press('Enter'); await idle(page);
}
// web-lite has one Tools profile (processing.advanced excludes Pro). The two
// presets reproduce the former Basic and Pro preference sets as explicit options.
async function open(page: Page, tool: Tool, preset: 'add' | 'subtract' = 'add') {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'queue-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('queue-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await chooseSelectionTool(page, tool === 'color' ? 'Color picker' : 'Fill');
  await page.evaluate(async subtract => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    const { setSelectionPreferences } = await import(/* @vite-ignore */ url);
    setSelectionPreferences({ operation: subtract ? 2 : 1, visibleOnly: subtract, overlap: false, live: subtract });
  }, preset === 'subtract');
  if (tool === 'fill') await tolerance(page, 10);
}
async function hold(page: Page, tool: Tool, refuse = false, publication = false, rollbackRefusal = false) {
  await page.evaluate(async ({ tool, refuse, publication, rollbackRefusal }) => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const { useApp } = await import(/* @vite-ignore */ resource('/src/app/store.ts'));
    const { CoreClient } = await import(/* @vite-ignore */ resource('/src/document/coreClient.ts'));
    const command = CoreClient.prototype.command, rollback = CoreClient.prototype.rollbackOperation;
    const captured: { request: Record<string, unknown>; mode: string; pending: number }[] = [];
    let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
    const control = { entered: false, release, captured, rollbackCalls: 0,
      native: undefined as undefined | (() => Promise<{ selected: number }>), gpu: undefined as undefined | (() => Promise<number[]>) };
    (window as unknown as { queueApp: typeof control }).queueApp = control;
    CoreClient.prototype.command = function(request: Record<string, unknown>) {
      if (request.command === 'colorPick' || request.command === 'fillPick') {
        captured.push({ request: { ...request }, mode: useApp.getState().mode, pending: useApp.getState().pendingSelectionCount });
        control.native = () => command.call(this, { command: 'summary' });
      }
      return command.call(this, request);
    };
    CoreClient.prototype.rollbackOperation = function(owner: Record<string, unknown>) {
      if (rollbackRefusal) {
        control.rollbackCalls++; return Promise.reject(new Error('Injected authoritative rollback refusal.'));
      }
      return rollback.call(this, owner);
    };
    if (publication) {
      const { GpuScene } = await import(/* @vite-ignore */ resource('/src/renderer/webgpu/renderer.ts')), real = GpuScene.prototype.stageMasks;
      GpuScene.prototype.stageMasks = async function(...args: unknown[]) {
        const scene = this;
        control.gpu = async () => {
          const device = scene.renderer.device, size = scene.count * 4;
          const read = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          try {
            const encoder = device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, size);
            device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
            const bytes = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return bytes;
          } finally { read.destroy(); }
        };
        GpuScene.prototype.stageMasks = real; control.entered = true; await waiting;
        if (refuse) throw new Error('Injected App queue refusal.'); return real.apply(this, args);
      };
    } else if (tool === 'color') {
      const { GaussianRenderer } = await import(/* @vite-ignore */ resource('/src/renderer/webgpu/renderer.ts')), real = GaussianRenderer.prototype.pick;
      GaussianRenderer.prototype.pick = async function(...args: unknown[]) {
        const result = await real.apply(this, args); GaussianRenderer.prototype.pick = real; control.entered = true; await waiting;
        if (refuse) throw new Error('Injected App queue refusal.'); return result;
      };
    } else {
      const { DocumentSelectionMaps } = await import(/* @vite-ignore */ resource('/src/app/selectionMaps.ts')), real = DocumentSelectionMaps.prototype.request;
      DocumentSelectionMaps.prototype.request = async function(...args: unknown[]) {
        const result = await real.apply(this, args); DocumentSelectionMaps.prototype.request = real; control.entered = true; await waiting;
        if (refuse) throw new Error('Injected App queue refusal.'); return result;
      };
    }
  }, { tool, refuse, publication, rollbackRefusal });
}
async function entered(page: Page) { await page.waitForFunction(() => (window as unknown as { queueApp: { entered: boolean } }).queueApp.entered); }
async function release(page: Page) { await page.evaluate(() => (window as unknown as { queueApp: { release(): void } }).queueApp.release()); }
async function exported(page: Page) {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click(); await page.getByLabel('Export format', { exact: true }).selectOption('5');
  await page.getByLabel('Export scope', { exact: true }).selectOption('1'); const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click(); const stream = await (await downloading).createReadStream(), chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const ids = Buffer.concat(chunks).toString('utf8').trim().split(/\r?\n/).slice(1).map(row => {
    const point = row.split(',').slice(0, 3).map(Number); return queuePositions.findIndex(source => source.every((value, i) => Math.abs(value - point[i]) < 1e-5));
  }).sort((a, b) => a - b);
  await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); return ids;
}
async function observeSave(page: Page) {
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/document/coreClient.ts')!.name;
    // Save uses the owned export path; observe it rather than the legacy export().
    const { CoreClient } = await import(/* @vite-ignore */ url), exporting = CoreClient.prototype.exportOwned;
    const calls: { format: number; scope: number; selected: number }[] = [];
    (window as unknown as { queueSave: typeof calls }).queueSave = calls;
    CoreClient.prototype.exportOwned = async function(format: number, scope: number, ...rest: unknown[]) {
      const summary = await this.command({ command: 'summary' });
      calls.push({ format, scope, selected: summary.selected });
      return exporting.call(this, format, scope, ...rest);
    };
  });
}
async function saveCalls(page: Page) {
  return page.evaluate(() => (window as unknown as { queueSave: { format: number; scope: number; selected: number }[] }).queueSave);
}
async function observeGrade(page: Page) {
  await page.evaluate(async () => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const [{ AppController }, { useApp }] = await Promise.all([
      import(/* @vite-ignore */ resource('/src/app/controller.ts')), import(/* @vite-ignore */ resource('/src/app/store.ts')),
    ]);
    const real = AppController.prototype.commitGrade;
    const control = { done: false, values: [] as number[], before: -1, after: -1, dirty: false };
    (window as unknown as { queueGrade: typeof control }).queueGrade = control;
    AppController.prototype.commitGrade = async function() {
      AppController.prototype.commitGrade = real;
      control.values = [...useApp.getState().grade]; control.before = useApp.getState().summary!.contentRevision;
      await real.call(this);
      control.after = (await this.client.command({ command: 'summary' })).contentRevision;
      control.dirty = useApp.getState().dirty; control.done = true;
    };
  });
}
test.describe('App released queue and selection presets', () => {
  for (const tool of ['color', 'fill'] as const) {
    for (const preset of ['add', 'subtract'] as const) test(`${tool} ${preset} keyboard Save and toolbar preserve the same held FIFO and selected export scope`, async ({ page }) => {
      const outputs: { ids: number[]; csv: string; calls: Awaited<ReturnType<typeof saveCalls>> }[] = [];
      for (const entry of ['keyboard', 'toolbar'] as const) {
        await open(page, tool, preset);
        if (preset === 'subtract') { await page.getByRole('button', { name: 'Select all', exact: true }).click(); await selected(page, 5); }
        const centers = await fixtureCenters(page, bytes, queuePositions.map(([x, y, z]) => [x, -y, -z]));
        await hold(page, tool); await observeSave(page);
        await page.mouse.click(...centers[0] as [number, number]); await entered(page);
        await page.mouse.click(...centers[tool === 'color' ? 4 : 3] as [number, number]); expect((await state(page)).pending).toBe(2);
        if (entry === 'keyboard') {
          await page.getByLabel('SplatView scene').focus();
          const primary = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
          await page.keyboard.press(`${primary}+s`);
        } else await page.getByRole('button', { name: 'Save scene', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Save scene', exact: true }); await expect(dialog).toBeVisible();
        expect((await state(page)).pending).toBe(2); expect((await state(page)).summary!.selected).toBe(preset === 'add' ? 0 : 5);
        await dialog.getByLabel('Export format', { exact: true }).selectOption('5');
        await dialog.getByLabel('Export scope', { exact: true }).selectOption('1');
        const downloading = page.waitForEvent('download'); await dialog.getByRole('button', { name: 'Download', exact: true }).click();
        await expect(dialog).toBeVisible(); expect((await state(page)).pending).toBe(2); expect(await saveCalls(page)).toEqual([]);
        await release(page);
        const download = await downloading, stream = await download.createReadStream(), chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        const csv = Buffer.concat(chunks).toString('utf8'), ids = csv.trim().split(/\r?\n/).slice(1).map(row => {
          const point = row.split(',').slice(0, 3).map(Number);
          return queuePositions.findIndex(source => source.every((value, i) => Math.abs(value - point[i]) < 1e-5));
        }).sort((a, b) => a - b);
        const expected = preset === 'add' ? [...headIds(tool), ...tailIds(tool)] : tool === 'color' ? [1, 2] : [1, 2, 4];
        expect(download.suggestedFilename()).toBe('queue-sh0-edited.csv'); expect(ids).toEqual(expected);
        expect(await saveCalls(page)).toEqual([{ format: 5, scope: 1, selected: expected.length }]);
        expect((await state(page)).pending).toBe(0); expect((await state(page)).outputPending).toBe(true);
        const captured = await page.evaluate(() => (window as unknown as { queueApp: { captured: { request: Record<string, unknown> }[] } }).queueApp.captured);
        expect(captured).toHaveLength(2); expect(captured.map(value => value.request.operation)).toEqual(preset === 'add' ? [1, 1] : [2, 2]);
        outputs.push({ ids, csv, calls: await saveCalls(page) });
        await page.getByRole('button', { name: 'I have kept the file', exact: true }).click(); await selected(page, expected.length);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, preset === 'add' ? headIds(tool).length : 5 - headIds(tool).length);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, preset === 'add' ? 0 : 5);
        if (preset === 'subtract') { await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0); }
        await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
      }
      expect(outputs[0]).toEqual(outputs[1]);
    });
    for (const choice of ['stay', 'discard', 'save'] as const) test(`${tool} real dirty navigation ${choice} preserves or replaces the document at the user's chosen boundary`, async ({ page }) => {
      await open(page, tool); const centers = await fixtureCenters(page, bytes, queuePositions.map(([x, y, z]) => [x, -y, -z]));
      await page.mouse.click(...centers[4] as [number, number]); await selected(page, 1);
      await observeGrade(page);
      await page.getByRole('slider', { name: 'Brightness', exact: true }).fill('1.1');
      await page.getByRole('button', { name: 'Apply color', exact: true }).click();
      await page.waitForFunction(() => (window as unknown as { queueGrade: { done: boolean } }).queueGrade.done);
      const grade = await page.evaluate(() => (window as unknown as { queueGrade: { values: number[]; before: number; after: number; dirty: boolean } }).queueGrade);
      expect(grade.values[0]).toBeCloseTo(1.1, 5); expect(grade.after).toBeGreaterThan(grade.before); expect(grade.dirty).toBe(true);
      await idle(page); expect((await state(page)).dirty).toBe(true);
      await page.getByLabel('Open scene files').setInputFiles({ name: 'queue-replacement.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
      const prompt = page.getByRole('dialog', { name: 'Unsaved changes', exact: true }); await expect(prompt).toBeVisible();
      expect((await state(page)).source).toBe('queue-sh0.ply'); expect((await state(page)).summary!.selected).toBe(1);
      if (choice === 'save') {
        const downloading = page.waitForEvent('download'); await prompt.getByRole('button', { name: 'Save', exact: true }).click();
        const download = await downloading, stream = await download.createReadStream(), chunks: Buffer[] = [];
        for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
        expect(download.suggestedFilename()).toBe('queue-sh0-edited.ply');
        expect(Buffer.concat(chunks).subarray(0, 2048).toString('utf8')).toMatch(/element vertex 5\r?\n/);
        const receipt = await state(page); expect(receipt.source).toBe('queue-sh0.ply'); expect(receipt.outputPending).toBe(true); expect(receipt.dirty).toBe(true);
        await expect(prompt).toHaveCount(0); await page.getByRole('button', { name: 'I have kept the file', exact: true }).click();
      } else await prompt.getByRole('button', { name: choice === 'stay' ? 'Stay' : 'Discard', exact: true }).click();
      await expect(prompt).toHaveCount(0);
      if (choice === 'stay') {
        const retained = await state(page); expect(retained.source).toBe('queue-sh0.ply'); expect(retained.dirty).toBe(true); expect(retained.prompt).toBe(false);
        await page.mouse.click(...centers[0] as [number, number]); await selected(page, headIds(tool).length + 1);
        expect(await exported(page)).toEqual([...headIds(tool), 4]);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 1);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 1); expect((await state(page)).dirty).toBe(false);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
      } else {
        await expect.poll(async () => (await state(page)).source).toBe('queue-replacement.ply'); await selected(page, 0);
        const replacement = await state(page); expect(replacement.dirty).toBe(false); expect(replacement.prompt).toBe(false); expect(replacement.outputPending).toBe(false);
      }
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });
    test(`${tool} resize cancels an unreleased press before it can enter the queue`, async ({ page }) => {
      await open(page, tool); const [center] = await fixtureCenters(page, bytes, queuePositions.map(([x, y, z]) => [x, -y, -z]));
      await hold(page, tool); const canvas = page.getByLabel('SplatView scene'), width = await canvas.evaluate(element => (element as HTMLCanvasElement).width);
      await page.mouse.move(...center as [number, number]); await page.mouse.down(); expect((await state(page)).dragging).toBe(true);
      await page.setViewportSize({ width: 1360, height: 840 });
      await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).not.toBe(width);
      await expect.poll(async () => (await state(page)).dragging).toBe(false);
      await page.mouse.up(); await release(page); await selected(page, 0);
      expect((await state(page)).pending).toBe(0);
      const observation = await page.evaluate(() => {
        const value = (window as unknown as { queueApp: { entered: boolean; captured: unknown[] } }).queueApp;
        return { entered: value.entered, captured: value.captured };
      });
      expect(observation).toEqual({ entered: false, captured: [] });
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });
    test(`${tool} failed authoritative rollback disables further edits`, async ({ page }) => {
      await open(page, tool); const [center] = await fixtureCenters(page, bytes, queuePositions.map(([x, y, z]) => [x, -y, -z]));
      await hold(page, tool, true, true, true); await page.mouse.click(...center as [number, number]); await entered(page);
      await release(page); await expect.poll(async () => (await state(page)).pending).toBe(0); await idle(page);
      expect((await state(page)).mode).toBe('basic');
      await expect(page.getByRole('alert')).toContainText('The edit result is unknown. Editing, opening and saving are paused until recovery completes.');
      await expect(page.getByRole('slider', { name: 'Selection tolerance', exact: true })).toBeDisabled();
      const evidence = await page.evaluate(async () => {
        const value = (window as unknown as { queueApp: { rollbackCalls: number; captured: unknown[]; native(): Promise<{ selected: number }>; gpu(): Promise<number[]> } }).queueApp;
        return { rollbacks: value.rollbackCalls, commands: value.captured.length, native: await value.native(), gpu: await value.gpu() };
      });
      // Publication never occurred. The refused rollback leaves native
      // authority unresolved.
      expect(evidence.rollbacks).toBe(1); expect(evidence.commands).toBe(1); expect(evidence.native.selected).toBe(headIds(tool).length); expect(evidence.gpu).toEqual(masks([]));
      await page.mouse.click(...center as [number, number]); expect((await state(page)).pending).toBe(0);
      expect(await page.evaluate(() => (window as unknown as { queueApp: { captured: unknown[] } }).queueApp.captured.length)).toBe(1);
    });
    test(`${tool} normal next press and expected release capture loss preserve two pending Add clicks`, async ({ page }) => {
      await open(page, tool); const centers = await fixtureCenters(page, bytes, queuePositions.map(([x, y, z]) => [x, -y, -z]));
      await hold(page, tool); await page.mouse.click(...centers[0] as [number, number]); await entered(page);
      await page.getByLabel('SplatView scene').dispatchEvent('lostpointercapture', { pointerId: 1 });
      await page.mouse.click(...centers[tool === 'color' ? 4 : 3] as [number, number]); expect((await state(page)).pending).toBe(2);
      await release(page); const ids = [...headIds(tool), ...tailIds(tool)]; await selected(page, ids.length); expect(await exported(page)).toEqual(ids);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, headIds(tool).length);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); await selected(page, 0);
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled(); await expect(page.getByRole('alert')).toHaveCount(0);
    });
    // Deferred and remembered Basic/Pro mode toggles are excluded: web-lite has no Pro profile (processing.advanced).
  }
});
