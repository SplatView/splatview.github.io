import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import { fixtureCenters } from './sceneCoordinates';
import { gesturePly, gesturePositions } from './gesture-fixture';
import type {} from './gesture-harness';

const oracle = [[1, 2], [0, 1, 2], [0], [2]];
const masks = (ids: readonly number[]) => gesturePositions.map((_, id) => Number(ids.includes(id)));
function exact(value: { gpu: number[]; ids: number[]; nativeIds: number[]; nativeMasks: number[]; exportedIds: number[] | null;
  summary: { selected: number } }, ids: number[]) {
  expect(value.nativeMasks).toEqual(masks(ids)); expect(value.nativeIds).toEqual(ids);
  expect(value.gpu).toEqual(masks(ids)); expect(value.ids).toEqual(ids); expect(value.summary.selected).toBe(ids.length);
  if (value.exportedIds !== null) expect(value.exportedIds).toEqual(ids);
}
test.describe('Captured manual selection and explicit Combine through real native/GPU', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/e2e/gesture-harness.html'); await page.waitForFunction(() => Boolean(window.gestureHarness || window.gestureHarnessError));
    expect(await page.evaluate(() => window.gestureHarnessError)).toBeUndefined();
  });
  for (const held of [false, true]) for (const operation of [0, 1, 2, 3])
    test(`${held ? 'held publication' : 'completed preview'} Combine ${operation} replays the original baseline and keeps one Undo`, async ({ page }) => {
      const result = await page.evaluate(args => window.gestureHarness.operation(args.operation, args.held), { operation, held });
      exact(result.before, [0, 2]); expect(result.before.exportedIds).toEqual([0, 2]); expect(result.before.summary.canRedo).toBe(true);
      expect(result.gpuBeforeAssignment).toEqual(masks(held ? [0, 2] : [0, 1, 2]));
      expect(result.persistent).toBe(operation); exact(result.preview, oracle[operation]); expect(result.active).toBe(true);
      expect(result.preview.summary.selectionDraft).toBe(true); expect(result.preview.exportedIds).toBeNull(); expect(result.accepted).toBe(true);
      exact(result.after, oracle[operation]); expect(result.after.exportedIds).toEqual(oracle[operation]);
      expect(result.after.summary.selectionDraft).toBe(false); expect(result.after.summary.canRedo).toBe(false);
      exact(result.undone, [0, 2]); exact(result.redone, oracle[operation]);
      expect(result.traffic.filter(command => command.command === 'beginSelection')).toHaveLength(1);
      expect(result.traffic.filter(command => command.command === 'confirmSelection')).toHaveLength(1);
      expect(result.traffic.filter(command => command.command === 'cancelSelection')).toHaveLength(0);
      if (held && operation !== 1) expect(result.traffic.some(command => command.command === 'rollbackTransaction')).toBe(true);
      expect(result.work).toBe(0); expect(result.error).toBeNull();
    });
  test('assigning already persistent Replace overrides the modifier-captured Add and reuses the baseline', async ({ page }) => {
    const result = await page.evaluate(() => window.gestureHarness.sameValue());
    exact(result.before, [0, 2]); exact(result.added, [0, 1, 2]); exact(result.replaced, [1, 2]); exact(result.after, [1, 2]); exact(result.undone, [0, 2]);
    expect(result.accepted).toBe(true); expect(result.persistent).toBe(0); expect(result.work).toBe(0); expect(result.error).toBeNull();
  });
  test('cancelling during superseded publication restores the original baseline and its Redo branch', async ({ page }) => {
    const result = await page.evaluate(() => window.gestureHarness.cancelRestart());
    exact(result.before, [0, 2]); exact(result.after, [0, 2]); expect(result.after.summary.canRedo).toBe(true);
    exact(result.redone, [0, 2, 3]); expect(result.active).toBe(false); expect(result.after.summary.selectionDraft).toBe(false);
    expect(result.work).toBe(0); expect(result.error).toBeNull();
  });
});

type AppSnapshot = { summary: { selected: number; selectionDraft: boolean; canUndo: boolean; canRedo: boolean; toleranceSessionId?: number | null; revision: number; contentRevision: number };
  gpu: number[]; ids: number[]; nativeIds: number[]; nativeMasks: number[]; exportedIds: number[] | null;
  tool: string | null; operation: number; dragging: boolean; captured: number | null;
  overlap: boolean; visibleOnly: boolean; live: boolean; brushSize: number; fly: boolean; mode: string; error: string | null };
type AppPointer = { type: 'pointerdown' | 'pointerup'; x: number; y: number; onCanvas: boolean; target: string; label: string | null };
type AppProbe = { snapshot(): Promise<AppSnapshot>; baseline(): Promise<void>; flush(): Promise<void>; holds: boolean; release(): void;
  hold(): void; failNextSinglePublication(): void; commands: Record<string, unknown>[]; options(patch: Record<string, unknown>): void;
  picks: { x: number; y: number; index: number | null }[]; pointers: AppPointer[]; gpu(): Promise<number[]>; redoBranch(): Promise<void> };
declare global { interface Window { gestureApp: AppProbe } }
const bytes = gesturePly();
async function open(page: Page, mode: 'basic', tool = 'Box select', live = true) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Open scene', exact: true })).toBeEnabled();
  await page.getByLabel('Open scene files').setInputFiles({ name: 'gesture-sh0.ply', mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await expect(page).toHaveTitle('gesture-sh0.ply — SplatView');
  await page.mouse.move(640, 400); await expect(page.locator('main')).not.toHaveClass(/chrome-hidden/);
  await page.getByRole('button', { name: 'Tools', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/app/store.ts')!.name;
    return (await import(/* @vite-ignore */ url)).useApp.getState().mode;
  })).toBe(mode);
  await chooseSelectionTool(page, tool);
  await page.evaluate(async live => {
    const resource = (path: string) => performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)!.name;
    const { useApp, setSelectionPreferences } = await import(/* @vite-ignore */ resource('/src/app/store.ts'));
    const { AppController } = await import(/* @vite-ignore */ resource('/src/app/controller.ts'));
    const { admittedExport } = await import(/* @vite-ignore */ new URL('/e2e/admitted-export.ts', location.origin).href);
    setSelectionPreferences({ operation: 0, live, visibleOnly: false, overlap: false });
    const original = AppController.prototype.setSelectionOperation;
    AppController.prototype.setSelectionOperation = function(operation: number) {
      AppController.prototype.setSelectionOperation = original;
      const controller = this, commands: Record<string, unknown>[] = [], client = controller.client, scene = controller.scene;
      const command = client.command.bind(client), stage = scene.stageMasks.bind(scene); let holding = false; let release: () => void = () => undefined;
      client.command = async (request: Record<string, unknown>) => { commands.push({ ...request }); return command(request); };
      const picks: { x: number; y: number; index: number | null }[] = [], pick = controller.renderer.pick.bind(controller.renderer);
      controller.renderer.pick = async (...args: unknown[]) => {
        const result = await pick(...args); picks.push({ x: Number(args[1]), y: Number(args[2]), index: result.index }); return result;
      };
      const pointers: AppPointer[] = [], canvas = controller.renderer.canvas;
      for (const type of ['pointerdown', 'pointerup'] as const) window.addEventListener(type, event => {
        const bounds = canvas.getBoundingClientRect(), target = event.target instanceof Element ? event.target : null;
        pointers.push({ type, x: (event.clientX - bounds.left) * canvas.width / bounds.width,
          y: (event.clientY - bounds.top) * canvas.height / bounds.height, onCanvas: event.target === canvas,
          target: target?.tagName ?? '', label: target?.closest('[aria-label]')?.getAttribute('aria-label') ?? null });
      }, true);
      const flush = async () => {
        // Draining a preview can start final confirmation, and cancellation
        // cleanup can start another owned publication. Discover those actual
        // terminal promises after each join rather than observing a draft or
        // an Undo/Redo candidate before its GPU publication has completed.
        const joined = new Set<Promise<unknown>>();
        for (;;) {
          const session = controller.selection?.session;
          const pending = [session?.draining, session?.finishing, controller.editOperation?.finished,
            controller.selectionCleanup, controller.toleranceCleanup, controller.releasedDrain]
            .filter((promise): promise is Promise<unknown> => Boolean(promise) && !joined.has(promise));
          if (!pending.length) break;
          for (const promise of pending) joined.add(promise);
          await Promise.all(pending);
        }
        if (controller.tolerance?.session) await controller.tolerance.session.flush();
      };
      const gpu = async () => {
        const renderer = controller.renderer, size = scene.count * 4;
        const read = renderer.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        try {
          const encoder = renderer.device.createCommandEncoder(); encoder.copyBufferToBuffer(scene.buffers.states, 0, read, 0, size);
          renderer.device.queue.submit([encoder.finish()]); await read.mapAsync(GPUMapMode.READ);
          const result = Array.from(new Uint32Array(read.getMappedRange().slice(0))); read.unmap(); return result;
        } finally { read.destroy(); }
      };
      window.gestureApp = {
        commands, picks, pointers, gpu, holds: false, release: () => release(), flush, options: patch => setSelectionPreferences(patch),
        hold() {
          holding = true; const waiting = new Promise<void>(resolve => { release = resolve; });
          scene.stageMasks = async (data: ArrayBuffer) => {
            if (holding && ['single', 'rectangle', 'brush', 'polygon'].includes(String(commands.at(-1)?.command))) {
              holding = false; window.gestureApp.holds = true; await waiting; window.gestureApp.holds = false;
            }
            return stage(data);
          };
        },
        failNextSinglePublication() {
          let failed = false;
          scene.stageMasks = async (data: ArrayBuffer) => {
            if (!failed && commands.at(-1)?.command === 'single') {
              failed = true; throw new Error('Injected Single mask publication failure');
            }
            return stage(data);
          };
        },
        async baseline() {
          await controller.command({ command: 'single', index: 0, operation: 0 });
          await controller.command({ command: 'single', index: 2, operation: 1 });
        },
        async redoBranch() {
          await controller.command({ command: 'single', index: 3, operation: 1 });
          await controller.command({ command: 'undo' });
        },
        async snapshot() {
          await flush(); const value = useApp.getState(), source = await client.command({ command: 'summary' });
          const points = [[-.65, -.65, 0], [.65, .25, 0], [.05, .25, 0], [-.65, .65, 0]], positions: number[][] = [];
          let nativeMasks: number[] = [];
          await client.stream(async (first: number, count: number, bytes: ArrayBuffer) => {
            if (bytes.byteLength !== count * scene.stride) throw new Error('The actual gesture stream changed its record stride.');
            const view = new DataView(bytes);
            for (let index = 0; index < count; index++)
              positions[first + index] = [0, 4, 8].map((axis, component) =>
                view.getFloat32(index * scene.stride + axis, true) * (component === 0 ? 1 : -1));
          }, (bytes: ArrayBuffer) => { nativeMasks = Array.from(new Uint8Array(bytes)); });
          if (positions.length !== points.length || nativeMasks.length !== positions.length)
            throw new Error('The actual gesture stream changed its fixture membership.');
          const nativeIds = positions.flatMap((point, index) => {
            const id = points.findIndex(source => source.every((v, axis) => Math.abs(v - point[axis]) < 1e-5));
            if (id !== index) throw new Error('The actual gesture stream changed its literal fixture position.');
            return (nativeMasks[index] & 3) === 1 ? [id] : [];
          }).sort((a, b) => a - b);
          // Keep an actual unfinished selection owner intact while observing
          // its native records and masks; admitted exports remain settled oracles.
          const held = source.selectionDraft || source.transaction || Boolean(client.operationOwner);
          let exportedIds: number[] | null = null;
          if (!held && source.selected) {
            exportedIds = new TextDecoder().decode(await admittedExport(client, 5, 1)).trim().split(/\r?\n/).slice(1).map((row: string) => {
              const p = row.split(',').slice(0, 3).map(Number); return points.findIndex(source => source.every((v, i) => Math.abs(v - p[i]) < 1e-5));
            }).sort((a: number, b: number) => a - b);
          }
          const summary = await client.command({ command: 'summary' });
          return { summary, gpu: await gpu(), ids: exportedIds ?? nativeIds, nativeIds, nativeMasks, exportedIds,
            tool: value.tool, operation: value.operation, dragging: value.selectionDragging,
            captured: value.selectionOperation, overlap: value.overlap, visibleOnly: value.visibleOnly, live: value.live,
            brushSize: value.brushSize, fly: value.fly, mode: value.mode, error: value.error };
        },
      };
      return original.call(controller, operation);
    };
  }, live);
  await page.getByRole('button', { name: 'Replace', exact: true }).click();
  return fixtureCenters(page, bytes, gesturePositions.map(([x, y, z]) => [x, -y, -z]));
}
async function snapshot(page: Page) { return page.evaluate(() => window.gestureApp.snapshot()); }
async function baseline(page: Page) { await page.evaluate(() => window.gestureApp.baseline()); }
async function rectangle(page: Page, centers: number[][]) {
  const start: [number, number] = [centers[2][0] - 8, centers[2][1] - 8], end: [number, number] = [centers[1][0] + 8, centers[1][1] + 8];
  await page.mouse.move(...start); await page.mouse.down(); await page.mouse.move(...end); return end;
}
async function rearm(page: Page, tool: string) { await chooseSelectionTool(page, tool); }
async function historyBaseline(page: Page) {
  await baseline(page); await page.evaluate(() => window.gestureApp.redoBranch());
  const before = await snapshot(page); exact(before, [0, 2]); expect(before.summary.canRedo).toBe(true);
  await page.evaluate(() => { window.gestureApp.commands.length = 0; window.gestureApp.picks.length = 0; window.gestureApp.pointers.length = 0; });
  return before;
}
async function framebufferPoint(page: Page, point: [number, number]) {
  return page.locator('canvas').evaluate((element, position) => {
    const canvas = element as HTMLCanvasElement, bounds = canvas.getBoundingClientRect();
    return [(position[0] - bounds.x) * canvas.width / bounds.width, (position[1] - bounds.y) * canvas.height / bounds.height];
  }, point);
}
async function onePressPick(page: Page, press: [number, number], index: number | null) {
  const expected = await observedFramebufferPoint(page, 'pointerdown', press), picks = await page.evaluate(() => window.gestureApp.picks);
  expect(picks).toHaveLength(1); expect(picks[0].index).toBe(index);
  expect(picks[0].x).toBe(expected[0]); expect(picks[0].y).toBe(expected[1]);
  expect([Math.floor(picks[0].x), Math.floor(picks[0].y)]).toEqual(expected.map(Math.floor));
}
async function observedFramebufferPoint(page: Page, type: AppPointer['type'], requested: [number, number]) {
  const expected = await framebufferPoint(page, requested), actual = await page.evaluate(type => window.gestureApp.pointers.filter(pointer => pointer.type === type).at(-1), type);
  expect(actual).toBeDefined(); expect(actual!.onCanvas).toBe(true); expect(actual!.target).toBe('CANVAS'); expect(actual!.label).toBe('SplatView scene');
  // Chromium delivers pointer coordinates at float32 precision. Bound that
  // delivery drift independently, then require the GPU query to use the exact
  // observed event coordinates and retain the exact containing-pixel oracle.
  expect(Math.abs(actual!.x - expected[0])).toBeLessThan(1 / 1024);
  expect(Math.abs(actual!.y - expected[1])).toBeLessThan(1 / 1024);
  expect([Math.floor(actual!.x), Math.floor(actual!.y)]).toEqual(expected.map(Math.floor));
  return [actual!.x, actual!.y];
}
async function selectionTraffic(page: Page) {
  return page.evaluate(() => window.gestureApp.commands.filter(command =>
    ['beginSelection', 'single', 'rectangle', 'brush', 'volume', 'polygon', 'confirmSelection', 'cancelSelection'].includes(String(command.command))));
}
async function primaryKey(page: Page) { return page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control'); }

// web-lite has one Tools profile (processing.advanced excludes Pro).
test.describe('App manual input contracts', () => {
  for (const mode of ['basic'] as const) {
    for (const operation of [0, 1, 2, 3]) test(`${mode} explicit Combine ${operation} overrides captured Shift Add and ignores later modifier changes`, async ({ page }) => {
      const centers = await open(page, mode); await baseline(page);
      await page.keyboard.down('Shift'); await rectangle(page, centers); await page.keyboard.up('Shift');
      exact(await snapshot(page), [0, 1, 2]);
      await page.keyboard.press(String(operation + 1)); exact(await snapshot(page), oracle[operation]);
      await page.keyboard.down('Shift'); expect((await snapshot(page)).captured).toBe(operation);
      await expect(page.getByRole('button', { name: ['Replace', 'Add', 'Subtract', 'Intersect'][operation], exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.up(); await page.keyboard.up('Shift'); exact(await snapshot(page), oracle[operation]);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
      expect((await snapshot(page)).error).toBeNull();
    });
    test(`${mode} idle modifier highlighting does not mutate preferences or captured rectangle Combine`, async ({ page }) => {
      const centers = await open(page, mode, 'Box select', false); await baseline(page);
      await page.getByLabel('SplatView scene', { exact: true }).focus();
      await expect(page.getByLabel('SplatView scene', { exact: true })).toBeFocused();
      await page.keyboard.down('Shift'); await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveAttribute('aria-pressed', 'true');
      expect((await snapshot(page)).operation).toBe(0); await rectangle(page, centers); await page.keyboard.up('Shift');
      await page.keyboard.down('Control'); expect((await snapshot(page)).captured).toBe(1);
      await expect(page.getByRole('button', { name: 'Add', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.up(); await page.keyboard.up('Control'); exact(await snapshot(page), [0, 1, 2]);
      expect((await snapshot(page)).operation).toBe(0);
    });
    for (const tool of ['Color picker', 'Fill']) test(`${mode} held ${tool} captures explicit Combine before release and preserves completed owner on active toolbar button`, async ({ page }) => {
      const centers = await open(page, mode, tool, false); await baseline(page);
      await page.keyboard.down('Shift'); await page.mouse.move(...centers[1] as [number, number]); await page.mouse.down(); await page.keyboard.up('Shift');
      await page.keyboard.press('1'); expect((await snapshot(page)).captured).toBe(0); await page.mouse.up();
      const before = await snapshot(page); exact(before, [1]); expect(before.summary.toleranceSessionId).not.toBeNull();
      await rearm(page, tool); const after = await snapshot(page); exact(after, [1]);
      expect(after.tool).toBe(tool === 'Fill' ? 'fill' : 'color'); expect(after.summary.toleranceSessionId).toBe(before.summary.toleranceSessionId);
      expect(after.summary.revision).toBe(before.summary.revision);
      await expect(page.getByLabel('SplatView scene', { exact: true })).not.toBeFocused();
      await page.keyboard.press('Control+e'); const denied = await snapshot(page); exact(denied, [1]);
      expect(denied.tool).toBe(after.tool); expect(denied.summary.toleranceSessionId).toBe(after.summary.toleranceSessionId);
      expect(denied.summary.revision).toBe(after.summary.revision);
      await page.getByLabel('SplatView scene', { exact: true }).focus();
      await expect(page.getByLabel('SplatView scene', { exact: true })).toBeFocused();
      await page.keyboard.press('Control+e'); const keyboard = await snapshot(page); exact(keyboard, [1]); expect(keyboard.summary.toleranceSessionId).toBeNull();
      expect(keyboard.tool).toBe('color'); expect(keyboard.error).toBeNull();
    });
    test(`${mode} active Box button keeps its live draft while X explicitly cancels and rearms it`, async ({ page }) => {
      const centers = await open(page, mode); await baseline(page); await rectangle(page, centers); exact(await snapshot(page), [1, 2]);
      await chooseSelectionTool(page, 'Box select', { dispatch: true });
      const same = await snapshot(page); exact(same, [1, 2]); expect(same.dragging).toBe(true); expect(same.summary.selectionDraft).toBe(true);
      // The Pro menu returns focus to its selector. Deliver the explicit X
      // shortcut to the same scene scope used by this captured pointer test.
      await page.getByLabel('SplatView scene').focus();
      await page.keyboard.press('x'); const keyboard = await snapshot(page); exact(keyboard, [0, 2]);
      expect(keyboard.tool).toBe('rectangle'); expect(keyboard.dragging).toBe(false); expect(keyboard.summary.selectionDraft).toBe(false);
      await page.mouse.up(); exact(await snapshot(page), [0, 2]);
      await page.keyboard.press('v'); expect((await snapshot(page)).fly).toBe(true);
      await chooseSelectionTool(page, 'Navigate'); expect((await snapshot(page)).fly).toBe(false); expect((await snapshot(page)).tool).toBeNull();
    });
    test(`${mode} captured brush ignores size inputs and option changes cancel its original baseline`, async ({ page }) => {
      const centers = await open(page, mode, 'Brush'); await baseline(page);
      const initial = await snapshot(page); await page.mouse.move(...centers[1] as [number, number]); await page.mouse.down(); exact(await snapshot(page), [1]);
      await expect(page.getByRole('slider', { name: 'Brush size', exact: true })).toBeDisabled();
      await page.keyboard.press('BracketRight'); await page.keyboard.down('Alt'); await page.mouse.wheel(0, -100); await page.keyboard.up('Alt');
      expect((await snapshot(page)).brushSize).toBe(initial.brushSize);
      await page.keyboard.press('n'); const cancelled = await snapshot(page); exact(cancelled, [0, 2]); expect(cancelled.visibleOnly).toBe(true);
      expect(cancelled.dragging).toBe(false); expect(cancelled.summary.selectionDraft).toBe(false); await page.mouse.up();
      await page.keyboard.press('BracketRight'); expect((await snapshot(page)).brushSize).toBeGreaterThan(initial.brushSize);
      await page.keyboard.press('m'); expect((await snapshot(page)).overlap).toBe(true); expect((await snapshot(page)).error).toBeNull();
    });
    test(`${mode} assigning the same live option ends a captured draft and restores its baseline`, async ({ page }) => {
      const centers = await open(page, mode); await baseline(page); await rectangle(page, centers); exact(await snapshot(page), [1, 2]);
      await page.evaluate(() => window.gestureApp.options({ live: true }));
      const after = await snapshot(page); exact(after, [0, 2]); expect(after.dragging).toBe(false); expect(after.summary.selectionDraft).toBe(false);
      await page.mouse.up(); exact(await snapshot(page), [0, 2]); expect(after.error).toBeNull();
    });
    for (const held of [false, true]) test(`${mode} stationary Single ${held ? 'joins held press publication' : 'confirms its completed press'} without a release pick`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); await historyBaseline(page);
      const press: [number, number] = [Math.floor(centers[1][0]) + .2, Math.floor(centers[1][1]) + .2];
      if (held) await page.evaluate(() => window.gestureApp.hold());
      await page.mouse.move(...press); await page.mouse.down();
      if (held) {
        await page.waitForFunction(() => window.gestureApp.holds);
        expect(await page.evaluate(() => window.gestureApp.gpu())).toEqual(masks([0, 2]));
        // Native pointer coordinates identify a containing framebuffer pixel.
        // A subpixel CSS movement inside that same pixel is stationary there.
        const release: [number, number] = [press[0] + .1, press[1]];
        expect((await framebufferPoint(page, release)).map(Math.floor)).toEqual((await framebufferPoint(page, press)).map(Math.floor));
        await page.mouse.move(...release); await page.mouse.up();
        expect(await page.evaluate(() => window.gestureApp.holds)).toBe(true);
        await page.evaluate(() => window.gestureApp.release());
      } else {
        const preview = await snapshot(page); exact(preview, [1]); expect(preview.summary.selectionDraft).toBe(true);
        await page.mouse.up();
      }
      const after = await snapshot(page); exact(after, [1]); expect(after.summary.selectionDraft).toBe(false);
      expect(after.dragging).toBe(false); expect(after.summary.canRedo).toBe(false); expect(after.error).toBeNull();
      await onePressPick(page, press, 1);
      const traffic = await selectionTraffic(page);
      expect(traffic.filter(command => command.command === 'single')).toHaveLength(1);
      expect(traffic.filter(command => command.command === 'confirmSelection')).toHaveLength(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [1]);
    });
    for (const operation of [0, 1]) test(`${mode} stationary missed Single ${operation ? 'Add preserves history' : 'Replace clears with one Undo'} without a release pick`, async ({ page }) => {
      await open(page, mode, 'Single splat'); const before = await historyBaseline(page);
      await page.getByRole('button', { name: operation ? 'Add' : 'Replace', exact: true }).click();
      const bounds = await page.locator('canvas').boundingBox();
      const press: [number, number] = [bounds!.x + 24.2, bounds!.y + 80.2];
      expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y) === document.querySelector('canvas'), press)).toBe(true);
      await page.mouse.move(...press); await page.mouse.down();
      const ids = operation ? [0, 2] : [], preview = await snapshot(page); exact(preview, ids);
      expect(preview.summary.selectionDraft).toBe(true); await onePressPick(page, press, null);
      await page.mouse.up(); const after = await snapshot(page); exact(after, ids);
      expect(after.summary.selectionDraft).toBe(false); expect(after.dragging).toBe(false); expect(after.error).toBeNull();
      await onePressPick(page, press, null);
      const traffic = await selectionTraffic(page);
      expect(traffic.filter(command => command.command === 'single')).toHaveLength(1);
      expect(traffic.filter(command => command.command === 'confirmSelection')).toHaveLength(1);
      if (operation) {
        expect(after.summary.canRedo).toBe(true); expect(after.summary.contentRevision).toBe(before.summary.contentRevision);
        await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
      } else {
        expect(after.summary.canRedo).toBe(false);
        await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
        await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), []);
      }
    });
    test(`${mode} canceled Single exact-origin reentry uses a fresh release pick and commits once`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); await historyBaseline(page);
      const press: [number, number] = [Math.floor(centers[1][0]), Math.floor(centers[1][1])];
      await page.mouse.move(...press); await page.mouse.down(); exact(await snapshot(page), [1]);
      await page.mouse.move(press[0] + 6, press[1]); const cancelled = await snapshot(page); exact(cancelled, [0, 2]);
      expect(cancelled.summary.selectionDraft).toBe(false); expect(cancelled.summary.canRedo).toBe(true);
      await page.mouse.move(...press); const reentry = await snapshot(page); exact(reentry, [0, 2]);
      expect(reentry.summary.selectionDraft).toBe(false); await onePressPick(page, press, 1);
      await page.mouse.up(); const after = await snapshot(page); exact(after, [1]); expect(after.summary.selectionDraft).toBe(false);
      expect(after.summary.canRedo).toBe(false); expect(after.dragging).toBe(false); expect(after.error).toBeNull();
      const picks = await page.evaluate(() => window.gestureApp.picks); expect(picks).toHaveLength(2); expect(picks[1]).toEqual(picks[0]);
      expect((await selectionTraffic(page)).filter(command => command.command === 'confirmSelection')).toHaveLength(1);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [1]);
    });
    test(`${mode} failed initial Single publication preserves baseline, Redo and actionable error on stationary release`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); const before = await historyBaseline(page);
      await page.evaluate(() => window.gestureApp.failNextSinglePublication());
      const press: [number, number] = [Math.floor(centers[1][0]), Math.floor(centers[1][1])];
      await page.mouse.move(...press); await page.mouse.down(); const failed = await snapshot(page); exact(failed, [0, 2]);
      expect(failed.error).toContain('Injected Single mask publication failure'); await onePressPick(page, press, 1);
      await page.mouse.up(); const after = await snapshot(page); exact(after, [0, 2]);
      expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(true); expect(after.dragging).toBe(false);
      expect(after.summary.contentRevision).toBe(before.summary.contentRevision);
      expect(after.error).toContain('Injected Single mask publication failure'); await onePressPick(page, press, 1);
      expect((await selectionTraffic(page)).filter(command => command.command === 'single')).toHaveLength(1);
      expect((await selectionTraffic(page)).filter(command => command.command === 'confirmSelection')).toHaveLength(0);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
    });
    for (const operation of [2, 3]) test(`${mode} primary ${operation === 2 ? 'Remove' : 'Intersect'} is captured at rectangle press`, async ({ page }) => {
      const centers = await open(page, mode); await historyBaseline(page); const primary = await primaryKey(page);
      await page.keyboard.down(primary); if (operation === 3) await page.keyboard.down('Shift');
      await rectangle(page, centers); const preview = await snapshot(page); exact(preview, oracle[operation]);
      expect(preview.captured).toBe(operation); expect(preview.operation).toBe(0);
      if (operation === 3) await page.keyboard.up('Shift'); await page.keyboard.up(primary);
      await page.keyboard.down('Shift'); expect((await snapshot(page)).captured).toBe(operation);
      await page.mouse.up(); await page.keyboard.up('Shift'); const after = await snapshot(page); exact(after, oracle[operation]);
      expect(after.operation).toBe(0); expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(false); expect(after.error).toBeNull();
      expect((await selectionTraffic(page)).filter(command => command.command === 'rectangle').every(command => command.operation === operation)).toBe(true);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), oracle[operation]);
    });
    test(`${mode} B, Shift+B and P fresh presses rearm while physical autorepeat preserves their captured gestures`, async ({ page }) => {
      const centers = await open(page, mode); await historyBaseline(page);
      await page.getByLabel('SplatView scene', { exact: true }).focus();
      await expect(page.getByLabel('SplatView scene', { exact: true })).toBeFocused();
      for (const shortcut of [{ key: 'b', shift: false, tool: 'brush' }, { key: 'b', shift: true, tool: 'volume' }, { key: 'p', shift: false, tool: 'polygon' }]) {
        if (shortcut.shift) await page.keyboard.down('Shift'); await page.keyboard.down(shortcut.key);
        if (shortcut.shift) await page.keyboard.up('Shift'); expect((await snapshot(page)).tool).toBe(shortcut.tool);
        await page.mouse.move(...centers[1] as [number, number]); await page.mouse.down();
        if (shortcut.tool === 'polygon') await page.mouse.up();
        const active = await snapshot(page); expect(active.dragging).toBe(true);
        if (shortcut.tool !== 'polygon') { exact(active, [1]); expect(active.summary.selectionDraft).toBe(true); }
        const traffic = await selectionTraffic(page), points = shortcut.tool === 'polygon' ? await page.locator('.gesture-overlay polyline').getAttribute('points') : null;
        await page.keyboard.down(shortcut.key); // The same held physical key emits repeat=true.
        const repeated = await snapshot(page); expect(repeated.tool).toBe(shortcut.tool); expect(repeated.dragging).toBe(true);
        exact(repeated, active.ids); expect(repeated.summary.revision).toBe(active.summary.revision);
        expect(await selectionTraffic(page)).toEqual(traffic);
        if (shortcut.tool === 'polygon') await expect(page.locator('.gesture-overlay polyline')).toHaveAttribute('points', points!);
        await page.keyboard.up(shortcut.key);
        if (shortcut.shift) await page.keyboard.down('Shift'); await page.keyboard.down(shortcut.key);
        if (shortcut.shift) await page.keyboard.up('Shift'); await page.keyboard.up(shortcut.key);
        const rearmed = await snapshot(page); exact(rearmed, [0, 2]); expect(rearmed.tool).toBe(shortcut.tool);
        expect(rearmed.dragging).toBe(false); expect(rearmed.summary.selectionDraft).toBe(false); expect(rearmed.summary.canRedo).toBe(true); expect(rearmed.error).toBeNull();
        await expect(page.locator('.gesture-overlay polyline')).toHaveCount(0);
        if (shortcut.tool !== 'polygon') await page.mouse.up();
      }
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]);
    });
    test(`${mode} an actual numeric text input takes priority over tool, Combine, select-all and delete shortcuts`, async ({ page }) => {
      await open(page, mode, 'Color picker', false); const before = await historyBaseline(page);
      await page.getByRole('slider', { name: 'Selection tolerance', exact: true }).click({ button: 'right' });
      const input = page.getByRole('spinbutton', { name: 'Tolerance percent', exact: true }); await expect(input).toBeFocused();
      await input.fill('25'); await page.keyboard.press('b'); await page.keyboard.press('p'); await page.keyboard.press('1');
      const primary = await primaryKey(page); await page.keyboard.press(`${primary}+a`); await page.keyboard.press('Delete');
      await expect(input).toBeFocused(); await expect(input).toHaveValue('');
      const after = await snapshot(page); exact(after, [0, 2]); expect(after.tool).toBe('color'); expect(after.operation).toBe(0);
      expect(after.summary.revision).toBe(before.summary.revision); expect(after.summary.canRedo).toBe(true); expect(after.error).toBeNull();
      expect(await selectionTraffic(page)).toEqual([]);
      await page.locator('canvas').focus(); await page.keyboard.press('b'); expect((await snapshot(page)).tool).toBe('brush');
      exact(await snapshot(page), [0, 2]);
    });
    test(`${mode} live Single Combine supersedes held publication and re-queries the original press before the release endpoint`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); await baseline(page); await page.evaluate(() => window.gestureApp.redoBranch());
      const before = await snapshot(page); exact(before, [0, 2]); expect(before.summary.canRedo).toBe(true);
      await page.evaluate(() => window.gestureApp.hold());
      const press: [number, number] = [Math.floor(centers[1][0]), Math.floor(centers[1][1])];
      await page.keyboard.down('Shift'); await page.mouse.move(...press); await page.mouse.down(); await page.keyboard.up('Shift');
      await page.waitForFunction(() => window.gestureApp.holds); expect(await page.evaluate(() => window.gestureApp.gpu())).toEqual(masks([0, 2]));
      await page.mouse.move(press[0] + 3, press[1]); await page.keyboard.press('1');
      await page.evaluate(() => window.gestureApp.release());
      const restarted = await snapshot(page); exact(restarted, [1]); expect(restarted.captured).toBe(0); expect(restarted.summary.selectionDraft).toBe(true);
      const replay = await page.evaluate(() => window.gestureApp.picks);
      expect(replay).toHaveLength(2); expect(replay.map(pick => pick.index)).toEqual([1, 1]);
      expect(replay[1].x).toBe(replay[0].x); expect(replay[1].y).toBe(replay[0].y);
      await page.mouse.up(); const after = await snapshot(page); exact(after, [1]); expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(false);
      const finalPicks = await page.evaluate(() => window.gestureApp.picks), sx = await page.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width / canvas.getBoundingClientRect().width);
      expect(finalPicks).toHaveLength(3); expect(finalPicks[2].x).toBeCloseTo(finalPicks[0].x + 3 * sx, 5); expect(finalPicks[2].y).toBe(finalPicks[0].y);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [1]); expect(after.error).toBeNull();
    });
    test(`${mode} live Single five CSS pixel boundary, outside Combine restart and reentry retain the original press and history`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); await baseline(page); await page.evaluate(() => window.gestureApp.redoBranch());
      const press: [number, number] = [Math.floor(centers[1][0]), Math.floor(centers[1][1])];
      await page.mouse.move(...press); await page.mouse.down(); exact(await snapshot(page), [1]);
      await page.mouse.move(press[0] + 5, press[1]); const boundary = await snapshot(page); exact(boundary, [1]); expect(boundary.summary.selectionDraft).toBe(true);
      await page.mouse.move(press[0] + 6, press[1]); const cancelled = await snapshot(page); exact(cancelled, [0, 2]);
      expect(cancelled.summary.selectionDraft).toBe(false); expect(cancelled.summary.canRedo).toBe(true); expect(cancelled.dragging).toBe(true);
      await page.keyboard.press('2'); const outside = await snapshot(page); exact(outside, [0, 2]); expect(outside.summary.selectionDraft).toBe(false); expect(outside.summary.canRedo).toBe(true);
      const queriesOutside = await page.evaluate(() => window.gestureApp.picks); expect(queriesOutside).toHaveLength(2);
      expect(queriesOutside[1]).toEqual(queriesOutside[0]);
      await page.mouse.move(press[0] + 3, press[1]); const reentry = await snapshot(page); exact(reentry, [0, 2]); expect(reentry.summary.selectionDraft).toBe(false);
      expect(await page.evaluate(() => window.gestureApp.picks.length)).toBe(2);
      await page.keyboard.press('1'); const restarted = await snapshot(page); exact(restarted, [1]); expect(restarted.summary.selectionDraft).toBe(true);
      const replay = await page.evaluate(() => window.gestureApp.picks); expect(replay).toHaveLength(3); expect(replay[2]).toEqual(replay[0]);
      await page.mouse.up(); const after = await snapshot(page); exact(after, [1]); expect(after.summary.canRedo).toBe(false);
      await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]); expect(after.error).toBeNull();
    });
    test(`${mode} live Single release beyond five CSS pixels preserves the original baseline and Redo without a new endpoint pick`, async ({ page }) => {
      const centers = await open(page, mode, 'Single splat'); await baseline(page); await page.evaluate(() => window.gestureApp.redoBranch());
      const press: [number, number] = [Math.floor(centers[1][0]), Math.floor(centers[1][1])];
      await page.mouse.move(...press); await page.mouse.down(); exact(await snapshot(page), [1]);
      await page.mouse.move(press[0] + 6, press[1]); exact(await snapshot(page), [0, 2]); await page.mouse.up();
      const after = await snapshot(page); exact(after, [0, 2]); expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(true); expect(after.dragging).toBe(false);
      expect(await page.evaluate(() => window.gestureApp.picks.length)).toBe(1);
      await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [0, 2, 3]); expect(after.error).toBeNull();
    });
  }
});

test.describe('Single containing framebuffer pixel at Retina density', () => {
  test.use({ deviceScaleFactor: 2 });
  for (const adjacent of [false, true]) test(`${adjacent ? 'adjacent framebuffer pixel repicks' : 'same framebuffer pixel confirms'} within the CSS click tolerance`, async ({ page }) => {
    const centers = await open(page, 'basic', 'Single splat'); await historyBaseline(page);
    const press: [number, number] = [Math.floor(centers[1][0]) + .1, Math.floor(centers[1][1]) + .1];
    const release: [number, number] = [press[0] + (adjacent ? .6 : .2), press[1]];
    const sx = await page.locator('canvas').evaluate(element => (element as HTMLCanvasElement).width / element.getBoundingClientRect().width);
    expect(sx).toBe(2);
    const initialPixel = (await framebufferPoint(page, press)).map(Math.floor), releasePoint = await framebufferPoint(page, release);
    expect(releasePoint.map(Math.floor)).toEqual([initialPixel[0] + Number(adjacent), initialPixel[1]]);
    await page.mouse.move(...press); await page.mouse.down(); const preview = await snapshot(page); exact(preview, [1]);
    expect(preview.summary.selectionDraft).toBe(true); await onePressPick(page, press, 1);
    await page.mouse.move(...release); await page.mouse.up(); const after = await snapshot(page); exact(after, [1]);
    expect(after.summary.selectionDraft).toBe(false); expect(after.summary.canRedo).toBe(false); expect(after.dragging).toBe(false); expect(after.error).toBeNull();
    const picks = await page.evaluate(() => window.gestureApp.picks), count = adjacent ? 2 : 1;
    expect(picks).toHaveLength(count); expect(picks.map(pick => pick.index)).toEqual(Array(count).fill(1));
    if (adjacent) {
      const observed = await observedFramebufferPoint(page, 'pointerup', release);
      expect(picks[1].x).toBe(observed[0]); expect(picks[1].y).toBe(observed[1]);
    } else await onePressPick(page, press, 1);
    const traffic = await selectionTraffic(page);
    expect(traffic.filter(command => command.command === 'single')).toHaveLength(count);
    expect(traffic.filter(command => command.command === 'confirmSelection')).toHaveLength(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click(); exact(await snapshot(page), [0, 2]);
    await page.getByRole('button', { name: 'Redo', exact: true }).click(); exact(await snapshot(page), [1]);
  });
});
