import { expect, test, type Page } from '@playwright/test';
import { NEUTRAL_COLOR } from '../src/document/types';
import { chooseSelectionTool } from './selectTool';
import type {} from './auto-color-harness';

type Menu = 'color' | 'selection';
type Activation = { type: string; button: number; detail: number; pointerId: number | null; trusted: boolean; prevented: boolean };
type PressProbe = { events: Activation[]; targetEvents: string[]; stop(): void };
declare global { interface Window { menuPressProbe?: PressProbe } }

const tools = (page: Page) => page.getByRole('complementary', { name: 'Tools', exact: true });
const tolerance = (page: Page) => tools(page).getByRole('slider', { name: 'Selection tolerance', exact: true });
const entry = (page: Page) => tools(page).getByRole('spinbutton', { name: 'Tolerance percent', exact: true });
const trigger = (page: Page, kind: Menu) => tools(page).getByRole('button', { name: kind === 'color' ? 'Auto color' : 'Selection tool', exact: true });
const menu = (page: Page, kind: Menu) => page.getByRole('menu', { name: kind === 'color' ? 'Auto color actions' : 'Selection tools', exact: true });
const snapshot = (page: Page) => page.evaluate(() => window.autoColorHarness.snapshot());
async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => window.autoColorHarness.state())).toMatchObject({ busy: false, controlsEnabled: true });
}
async function boot(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('splatview.tools-mode.v1', 'pro'));
  await page.goto('/e2e/auto-color-harness.html');
  await expect.poll(() => page.evaluate(() => window.autoColorHarness?.ready() ?? false)).toBe(true);
  await page.evaluate(() => window.autoColorHarness.load()); await settled(page);
  await chooseSelectionTool(page, 'Color picker'); await expect(tolerance(page)).toBeVisible();
  const values = [...NEUTRAL_COLOR]; values[0] = 1.2;
  await page.evaluate(values => window.autoColorHarness.preview(values), values);
  await tools(page).getByRole('button', { name: 'Apply color', exact: true }).click(); await settled(page);
  const applied = await snapshot(page);
  // Apply retains the GPU color base and grades it in the shader. EndColor
  // materializes native color bytes before history replay. Normalize through
  // actual UI Undo/Redo so the final hash compares the same representation.
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const baked = await snapshot(page);
  expect(baked.exported).toBe(applied.exported); expect(baked.records).toEqual(applied.records);
  expect(baked.colorSession).toBeNull(); expect(baked.grade).toEqual(NEUTRAL_COLOR); expect(baked.appliedGrade).toEqual(NEUTRAL_COLOR);
  await tools(page).getByRole('button', { name: 'Undo', exact: true }).click(); await settled(page);
  await tolerance(page).scrollIntoViewIfNeeded(); await expect(tolerance(page)).toBeVisible();
  const before = await snapshot(page), gpu = await page.evaluate(() => window.geometryViewer.keyboardStart());
  expect(before.summary.canRedo).toBe(true);
  return { applied, baked, before, gpu, tolerance: await tolerance(page).inputValue() };
}
async function open(page: Page, kind: Menu) {
  await trigger(page, kind).click(); await expect(menu(page, kind)).toBeVisible();
  // No scroll during dismissal: it would itself retire a menu before the
  // outside press, hiding the regression under an unrelated close path.
  const box = (await tolerance(page).boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(1000);
}
async function observe(page: Page) {
  await tolerance(page).evaluate(element => {
    window.menuPressProbe?.stop();
    const events: Activation[] = [], targetEvents: string[] = [];
    const capture = (event: MouseEvent) => {
      const entry = { type: event.type, button: event.button, detail: event.detail,
        pointerId: 'pointerId' in event ? Number(event.pointerId) : null, trusted: event.isTrusted,
        get prevented() { return event.defaultPrevented; } };
      // Read the original event after dispatch; a capture-phase microtask can
      // run before the document owner on some browser callback boundaries.
      events.push(entry);
    };
    const target = (event: Event) => { targetEvents.push(event.type); };
    for (const type of ['contextmenu', 'auxclick']) window.addEventListener(type, capture as EventListener, true);
    for (const type of ['pointerdown', 'mousedown', 'contextmenu', 'auxclick']) element.addEventListener(type, target);
    window.menuPressProbe = { events, targetEvents, stop() {
      for (const type of ['contextmenu', 'auxclick']) window.removeEventListener(type, capture as EventListener, true);
      for (const type of ['pointerdown', 'mousedown', 'contextmenu', 'auxclick']) element.removeEventListener(type, target);
    } };
  });
}
const events = (page: Page) => page.evaluate(() => ({ events: window.menuPressProbe!.events, targetEvents: window.menuPressProbe!.targetEvents }));
function retained(after: Awaited<ReturnType<typeof snapshot>>, before: Awaited<ReturnType<typeof snapshot>>) {
  for (const key of ['exported', 'records', 'grade', 'appliedGrade', 'colorSession', 'colorSelectedOnly', 'colorPending',
    'sourceFingerprint', 'camera', 'background', 'dirty'] as const) expect(after[key], key).toEqual(before[key]);
  expect(after.summary).toEqual(before.summary); expect(after.capture.hash).toBe(before.capture.hash); expect(after.workBytes).toBe(0);
}
async function finish(page: Page, baseline: Awaited<ReturnType<typeof boot>>) {
  await page.evaluate(() => window.menuPressProbe?.stop());
  const observed = await page.evaluate(() => window.geometryViewer.keyboardFinish());
  expect(observed.calls.filter(command => command !== 'summary')).toEqual([]);
  expect(observed.after.gpuMasks).toEqual(baseline.gpu.gpuMasks);
  expect(observed.after.exported).toBe(baseline.gpu.exported); expect(observed.after.deviceEpoch).toBe(baseline.gpu.deviceEpoch);
  retained(await snapshot(page), baseline.before); await expect(tolerance(page)).toHaveValue(baseline.tolerance);
  await tools(page).getByRole('button', { name: 'Redo', exact: true }).click(); await settled(page);
  const replayed = await snapshot(page);
  expect(replayed.exported).toBe(baseline.baked.exported); expect(replayed.records).toEqual(baseline.baked.records);
  expect(replayed.capture.hash).toBe(baseline.baked.capture.hash);
  await expect(page.getByRole('alert')).toHaveCount(0);
  return { observed, replayed };
}

test.afterEach(async ({ page }) => { await page.evaluate(() => window.menuPressProbe?.stop()); });

for (const kind of ['color', 'selection'] as const) for (const button of ['right', 'middle'] as const)
  test(`${kind} popup owns the real outside ${button} press without opening Tolerance or altering native history`, async ({ page }, info) => {
    const baseline = await boot(page); await open(page, kind); await observe(page);
    const box = (await tolerance(page).boundingBox())!;
    // Real mouse input exercises the browser's own contextmenu/auxclick order.
    // On browsers emitting both for right click, neither may reach the control.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
    await expect(menu(page, kind)).toHaveCount(0); await expect(entry(page)).toHaveCount(0);
    await expect(tolerance(page)).toHaveValue(baseline.tolerance);
    const consumed = await events(page), expected = button === 'right' ? 'contextmenu' : 'auxclick';
    expect(consumed.events.some(event => event.type === expected)).toBe(true);
    expect(consumed.events.every(event => event.trusted && event.prevented)).toBe(true); expect(consumed.targetEvents).toEqual([]);
    // A new physical press has its own ownership, even on the same pointer,
    // button and target. Right click can immediately open the actual editor.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button });
    if (button === 'right') {
      await expect(entry(page)).toBeFocused(); await entry(page).press('Escape'); await expect(entry(page)).toHaveCount(0);
    } else {
      const fresh = await events(page);
      // Native middle-button behavior on a range can consume the release
      // without emitting another auxclick. Prove the fresh press reaches the
      // real target; any emitted activation must reach it too. The dismissed
      // popup's document capture stops propagation when it owns an event.
      expect(fresh.targetEvents).toContain('pointerdown'); expect(fresh.targetEvents).toContain('mousedown');
      for (const activation of fresh.events.slice(consumed.events.length)) {
        expect(activation).toMatchObject({ type: 'auxclick', button: 1, trusted: true });
        expect(fresh.targetEvents).toContain(activation.type);
      }
      await expect(entry(page)).toHaveCount(0);
      // Retire any native autoscroll, then use the range's actual keyboard action.
      await page.keyboard.press('Escape');
      await tolerance(page).focus(); await page.keyboard.press('Enter'); await expect(entry(page)).toBeFocused();
      await entry(page).press('Escape'); await expect(entry(page)).toHaveCount(0);
    }
    const result = await finish(page, baseline);
    await info.attach('outside-non-primary-press-native-gpu-redo', { contentType: 'application/json', body: JSON.stringify({ button, kind, consumed, baseline, ...result }) });
  });

for (const kind of ['color', 'selection'] as const)
  test(`${kind} popup retires physical ownership before real Shift+F10 and ContextMenu keyboard requests`, async ({ page }, info) => {
    const baseline = await boot(page), observations = [];
    for (const key of ['Shift+F10', 'ContextMenu']) {
      await open(page, kind); await observe(page);
      const box = (await tolerance(page).boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down({ button: 'right' });
      try {
        await expect(menu(page, kind)).toHaveCount(0); await expect(entry(page)).toHaveCount(0);
        // Keep the physical button held, so its later auxclick is still pending.
        // Focus the surviving range for the independent keyboard request.
        await tolerance(page).focus(); await page.keyboard.press(key);
        await expect(entry(page)).toBeFocused();
        const observed = await events(page);
        expect(observed.events.some(event => event.type === 'contextmenu' && event.trusted)).toBe(true);
        expect(observed.targetEvents).toContain('contextmenu'); observations.push({ key, ...observed });
      } finally { await page.mouse.up({ button: 'right' }); }
      await entry(page).press('Escape'); await expect(entry(page)).toHaveCount(0);
      await expect(tolerance(page)).toHaveValue(baseline.tolerance);
    }
    const result = await finish(page, baseline);
    await info.attach('physical-and-keyboard-contextmenu-ownership', { contentType: 'application/json', body: JSON.stringify({ kind, observations, baseline, ...result }) });
  });
