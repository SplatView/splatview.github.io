import { expect, test, type Page } from '@playwright/test';
import { chooseSelectionTool } from './selectTool';
import type {} from './opacity-harness';

const scene = (page: Page) => page.getByLabel('SplatView scene', { exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.opacityHarness.snapshot());
type Snapshot = Awaited<ReturnType<Window['opacityHarness']['snapshot']>>;
declare global { interface Window { wheelHistoryObserver?: { task?: Promise<boolean>; calls: number; restore(): void } } }

async function historyKey(page: Page, key: string, command: 'undo' | 'redo') {
  // The shortcut handler deliberately does not await its edit. Observe and
  // join that exact command before attempting terminal native stream reads.
  await page.evaluate(command => {
    const app = window.geometryViewer.controllerForSourceNavigation(), original = app.command;
    const observation: NonNullable<Window['wheelHistoryObserver']> = { calls: 0,
      restore() { if (app.command === observed) app.command = original; } };
    const observed: typeof app.command = function(...args) {
      const task = original.apply(app, args);
      if (args[0].command === command) { observation.calls++; observation.task = task; }
      return task;
    };
    app.command = observed; window.wheelHistoryObserver = observation;
  }, command);
  try {
    await page.keyboard.press(key);
    await page.waitForFunction(() => !!window.wheelHistoryObserver?.task);
    const result = await page.evaluate(async () => {
      const observation = window.wheelHistoryObserver!;
      return { accepted: await observation.task!, calls: observation.calls };
    });
    expect(result).toEqual({ accepted: true, calls: 1 });
  } finally {
    await page.evaluate(() => { window.wheelHistoryObserver?.restore(); delete window.wheelHistoryObserver; });
  }
}

async function wheelState(page: Page) {
  return page.evaluate(async () => {
    const url = new URL('../src/app/store.ts', location.href).href;
    const { useApp } = await import(/* @vite-ignore */ url) as typeof import('../src/app/store');
    const value = useApp.getState();
    return { brushSize: value.brushSize, dirty: value.dirty, outputPending: value.outputPending,
      cameraActive: window.geometryViewer.controllerForSourceNavigation().camera!.active };
  });
}
function retained(actual: Snapshot, before: Snapshot, camera = true) {
  expect(actual.records).toEqual(before.records); expect(actual.gpuRecords).toEqual(before.gpuRecords);
  expect(actual.masks).toEqual(before.masks); expect(actual.gpuMasks).toEqual(before.gpuMasks);
  expect(actual.document).toEqual(before.document); expect(actual.sourceFingerprint).toEqual(before.sourceFingerprint);
  for (const key of ['revision', 'contentRevision', 'canUndo', 'canRedo'] as const) expect(actual.summary[key]).toEqual(before.summary[key]);
  expect(actual.grade).toEqual(before.grade); expect(actual.appliedGrade).toEqual(before.appliedGrade);
  if (camera) expect(actual.camera).toEqual(before.camera);
}
async function frames(page: Page) {
  await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
}
// These events test cancellable DOM admission precisely. Actual eased mouse
// wheel and UI scrolling are exercised separately below and in camera.spec.
async function dispatchWheel(page: Page, options: Pick<WheelEventInit, 'deltaY' | 'deltaMode' | 'ctrlKey' | 'metaKey' | 'altKey'> = {}, alreadyHandled = false) {
  return scene(page).evaluate((canvas, { options, alreadyHandled }) => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100, ...options });
    if (alreadyHandled) event.preventDefault();
    canvas.dispatchEvent(event); return event.defaultPrevented;
  }, { options, alreadyHandled });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/opacity-harness.html');
  await page.waitForFunction(() => window.geometryViewerError || window.opacityHarness?.ready());
  expect(await page.evaluate(() => window.geometryViewerError)).toBeUndefined();
  await page.evaluate(() => window.opacityHarness.load('wheel-scope-literals.ply'));
  if (!(await page.evaluate(() => window.opacityHarness.state())).toolsOpen)
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
  for (const command of [{ command: 'single', index: 2, operation: 0 }, { command: 'delete' }, { command: 'undo' }] as const)
    expect(await page.evaluate(command => window.opacityHarness.command(command), command)).toBe(true);
  await chooseSelectionTool(page, 'Brush');
  // The selected menu intentionally suppresses same-selector hover until the
  // pointer leaves. Start every scenario from a genuine canvas pointer owner.
  await page.mouse.move(800, 400); await scene(page).focus();
  expect((await snapshot(page)).summary.canRedo).toBe(true);
  await page.evaluate(() => window.opacityHarness.observe());
});
test.afterEach(async ({ page }) => { await page.evaluate(() => window.opacityHarness?.stop()); });

for (const modifier of ['ctrlKey', 'metaKey'] as const) test(`${modifier} wheel keeps browser zoom default and does not resize or navigate`, async ({ page }) => {
  const before = await snapshot(page), state = await wheelState(page);
  expect(await dispatchWheel(page, { [modifier]: true, altKey: true })).toBe(false);
  await frames(page); retained(await snapshot(page), before);
  expect(await wheelState(page)).toEqual(state);
  expect((await page.evaluate(() => window.opacityHarness.commands())).filter(command => command !== 'summary')).toEqual([]);
});

test('previously handled and empty wheel events cannot queue camera motion or resize a brush', async ({ page }) => {
  const before = await snapshot(page), state = await wheelState(page);
  expect(await dispatchWheel(page, { altKey: true }, true)).toBe(true);
  expect(await dispatchWheel(page, { deltaY: 0 })).toBe(false);
  await frames(page); retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
});

test('hovered canvas accepts wheel with UI keyboard focus, while Alt wheel only resizes the brush', async ({ page }) => {
  const button = page.getByRole('button', { name: 'Tools', exact: true });
  await button.focus(); await expect(button).toBeFocused();
  const before = await snapshot(page), state = await wheelState(page);
  await page.mouse.move(800, 400); await page.mouse.wheel(0, -25);
  await expect.poll(async () => (await snapshot(page)).camera).not.toEqual(before.camera);
  await expect.poll(async () => (await wheelState(page)).cameraActive).toBe(false);
  await expect(button).toBeFocused(); const zoomed = await snapshot(page); retained(zoomed, before, false);
  await page.keyboard.down('Alt'); await page.mouse.wheel(0, -100); await page.keyboard.up('Alt');
  await expect.poll(async () => (await wheelState(page)).brushSize).toBeCloseTo(state.brushSize * 1.15, 5);
  retained(await snapshot(page), zoomed); await expect(button).toBeFocused();
});

test('a hover-open menu owns wheel even while canvas keeps keyboard focus', async ({ page }) => {
  const before = await snapshot(page), state = await wheelState(page);
  await page.getByRole('button', { name: 'Selection tool', exact: true }).hover();
  const menu = page.getByRole('menu', { name: 'Selection tools', exact: true });
  await expect(menu).toBeVisible(); await expect(scene(page)).toBeFocused();
  expect(await dispatchWheel(page, { altKey: true })).toBe(true);
  expect(await dispatchWheel(page)).toBe(true);
  await frames(page); retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
});

test('Selection menu dismissal consumes only its outside press and permits the next toolbar activation', async ({ page }) => {
  const before = await snapshot(page), state = await wheelState(page);
  const toggle = page.getByRole('button', { name: 'Tools', exact: true });
  const panel = page.getByRole('complementary', { name: 'Tools', exact: true });
  await page.getByRole('button', { name: 'Selection tool', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Selection tools', exact: true }); await expect(menu).toBeVisible();
  await toggle.click(); await expect(menu).toHaveCount(0); await expect(panel).toBeVisible();
  retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
  await toggle.click(); await expect(panel).toHaveCount(0);
  await toggle.click(); await expect(panel).toBeVisible();
  retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
});

test('real output acknowledgement blocks Alt wheel through its transparent backdrop and retains executable Redo', async ({ page }) => {
  await page.getByRole('button', { name: 'Save scene', exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('dialog', { name: 'Save scene', exact: true }).getByRole('button', { name: 'Download', exact: true }).click();
  expect((await download).suggestedFilename()).toMatch(/\.ply$/);
  const output = page.getByRole('dialog', { name: 'Download prepared. Keep the file before continuing.', exact: true });
  await expect(output).toBeVisible(); const before = await snapshot(page), state = await wheelState(page);
  expect(state.outputPending).toBe(true);
  await page.mouse.move(800, 400);
  expect(await page.evaluate(() => document.elementFromPoint(800, 400)?.tagName)).toBe('CANVAS');
  await page.keyboard.down('Alt'); await page.mouse.wheel(0, -100); await page.keyboard.up('Alt');
  await frames(page); retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
  await page.keyboard.press('Escape'); await expect(output).toHaveCount(0);
  // Basic keeps a selection tool armed; leave it so the shortcut reaches scene history.
  await scene(page).focus(); await page.keyboard.press('Escape'); await expect.poll(() => page.evaluate(() => window.opacityHarness.state().tool)).toBeNull();
  await historyKey(page, 'ControlOrMeta+Shift+z', 'redo');
  await expect.poll(async () => (await snapshot(page)).masks).toEqual([0, 0, 2, 0, 0, 0]);
  const redone = await snapshot(page); expect(redone.gpuMasks).toEqual(redone.masks);
  await historyKey(page, 'ControlOrMeta+z', 'undo');
  await expect.poll(async () => (await snapshot(page)).masks).toEqual(before.masks);
  expect((await snapshot(page)).records).toEqual(before.records);
});

test('Tools scrolling at both edges and mid-range stays local and never changes the native scene or camera', async ({ page }) => {
  // Short-window reflow deliberately moves scrolling from the body to the
  // whole panel. Exercise both real owners, including the 480px breakpoint.
  for (const [height, selector] of [[600, '.tools-body'], [480, '.tools-panel']] as const) {
    await page.setViewportSize({ width: 900, height }); await frames(page);
    const owner = page.locator(selector);
    expect(await owner.evaluate(element => getComputedStyle(element).overscrollBehaviorY)).toBe('contain');
    expect(await owner.evaluate(element => getComputedStyle(element).overflowY)).toBe('auto');
    await expect.poll(() => owner.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(50);
    const before = await snapshot(page), state = await wheelState(page);
    for (const [fraction, delta] of [[0, -160], [.5, 80], [1, 160]]) {
      await owner.evaluate((element, fraction) => { element.scrollTop = fraction * (element.scrollHeight - element.clientHeight); }, fraction);
      const start = await owner.evaluate(element => element.scrollTop);
      const box = (await owner.boundingBox())!;
      await page.mouse.move(box.x + box.width - 12, box.y + box.height / 2); await page.mouse.wheel(0, delta); await frames(page);
      if (fraction === .5) await expect.poll(() => owner.evaluate(element => element.scrollTop)).toBeGreaterThan(start);
      else expect(await owner.evaluate(element => element.scrollTop)).toBe(start);
      expect(await page.evaluate(() => [scrollX, scrollY, document.documentElement.scrollTop, document.body.scrollTop])).toEqual([0, 0, 0, 0]);
      retained(await snapshot(page), before); expect(await wheelState(page)).toEqual(state);
    }
  }
  expect((await page.evaluate(() => window.opacityHarness.commands())).filter(command => command !== 'summary')).toEqual([]);
});
